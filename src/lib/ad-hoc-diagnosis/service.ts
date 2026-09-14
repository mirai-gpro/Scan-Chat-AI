// src/lib/ad-hoc-diagnosis/service.ts
// 臨時診断バッチ: API から呼ぶ「動詞」。DB (store) と解析 (pipeline) を繋ぐ。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §17 / §22
//
// **API ルートはここを呼ぶだけにする。** ルートに手続きを書かない
// (同じ処理を 2 つの口から呼べるようにするため。§22「API 同士を HTTP で呼ばない」)。

import { getS3Config } from '../s3';
import { checkWriteGate, preflightNoExistingObjects, putDeliveryFilesCreateOnly } from './write-guard';
import { refreshConfig } from '../app-config';
import {
  GENOPLAN_V1_REQUIRED_PAGES, isGenoplanV1RequiredPage, missingGenoplanV1Pages,
  scanGeneticPage,
} from '../elith-genetic';
import * as store from './store';
import { adHocZipKey } from './keys';
import { headAdHocZip, deleteAdHocZip, createAdHocUploadTicket } from './ticket';
import { openArchiveFromS3 } from './archive';
import { matchByFingerprint, shortFingerprint, subjectFingerprint } from './fingerprint';
import { questionnaireSummary, questionnaireIsUsable } from './questionnaire';
// **`restoreHealthCheckupSheet` はもう使わない** — 健診 XLSX は HealthCheckupData の
// 生成元から外れた (spec §6.2・v1.1)。関数自体は分類時の保存と照合の補助に残っている。
import { buildEntryPayload, restoreQuestionnaire } from './normalized-payload';
// **本番の健診処理をそのまま使う** (spec §6.2/§6.5)。ad-hoc に整形を書き直さない。
import { scanImageToParsed } from '../elith-export';
import { finalizeHealthCheckup, isTrendMarkdown } from '../elith-hc-finalize';
import {
  isManualQuestionnaireRecord, manualQuestionnaire, manualRecordIsConfirmed,
  type ManualEntry, type ManualQuestionnaireRecord,
} from './questionnaire-manual';
import type { QuestionnaireNormalized } from './questionnaire';

/**
 * 問診の手入力を置くページ番号。
 *
 * **既存の `ad_hoc_diagnosis_pages` を使い回す** — 新しいテーブルも列も足さない
 * (spec §2.4)。問診ファイルは 1 人 1 件なので 1 行で足りる。
 */
const MANUAL_QUESTIONNAIRE_PAGE_NO = 1;
import { normalizeMarkers } from '../health-age';
import {
  AD_HOC_OPTIONAL_FORMATS, AD_HOC_REQUIRED_FORMATS, analyzeEntry, analyzeOpened, buildGeneticJson,
  buildQuestionnaireJson, computeSubjectWellnessAge, evaluateReadiness,
  newClientId, newDiagnosticId, planArchive, toDeliveryFile,
  type AnalyzedFile, type DeliveryFile, type GeneticPagePart,
} from './pipeline';
import type { FormatId } from './classify';

export interface Actor {
  /** wellfort-site が `/auth/v1/user` で検証した user.id。**ブラウザ申告値は入れない** (§21)。 */
  userId: string | null;
  masked: string | null;
  sha256: string | null;
}

export const NO_ACTOR: Actor = { userId: null, masked: null, sha256: null };

// ---------------------------------------------------------------------------
// ① upload-ticket : バッチを作り presigned PUT を返す
// ---------------------------------------------------------------------------

export async function createBatchWithTicket(input: {
  title: string;
  sourceSha256: string;
  declaredSize: number;
  contentType?: string;
  requiredFormats?: string[];
  optionalFormats?: string[];
  /** Executive Diagnosis の案件か。**明示されたときだけ true**。既定は従来どおり false。 */
  requireExecutiveLink?: boolean;
  retainOriginals?: boolean;
  actor: Actor;
}) {
  const cfg = getS3Config();
  if (!cfg) return { ok: false as const, status: 503, error: 's3_not_configured' };
  if (!store.isStoreAvailable()) {
    return { ok: false as const, status: 503, error: 'supabase_not_configured' };
  }

  const batchId = crypto.randomUUID();
  const ticket = await createAdHocUploadTicket({
    batchId,
    declaredSize: input.declaredSize,
    contentType: input.contentType,
  });
  if (!ticket.ok) return { ok: false as const, status: ticket.status, error: ticket.error, detail: ticket.detail };

  const batch = await store.createBatch({
    id: batchId,
    title: input.title,
    sourceSha256: input.sourceSha256,
    declaredSourceSize: input.declaredSize,
    sourceKey: adHocZipKey(cfg, batchId),
    requiredFormats: input.requiredFormats ?? AD_HOC_REQUIRED_FORMATS,
    optionalFormats: input.optionalFormats ?? AD_HOC_OPTIONAL_FORMATS,
    requireExecutiveLink: input.requireExecutiveLink === true,
    retainOriginals: input.retainOriginals,
    createdByUserId: input.actor.userId,
    createdByMasked: input.actor.masked,
  });

  // 同じ ZIP の再投入を**検知して警告するだけ** (§19.1)。拒否も自動続行もしない。
  const duplicates = await store.findBatchesBySha(input.sourceSha256, batchId);

  await store.logEvent({
    batch_id: batchId,
    event: 'created',
    actor_user_id: input.actor.userId,
    actor_masked: input.actor.masked,
    actor_sha256: input.actor.sha256,
    detail: { declared_size: input.declaredSize, duplicate_batches: duplicates.length },
  });

  return {
    ok: true as const,
    batch,
    upload: {
      url: ticket.url,
      headers: ticket.headers,
      expiresIn: ticket.expiresIn,
    },
    duplicates: duplicates.map((d) => ({ id: d.id, title: d.title, created_at: d.created_at })),
  };
}

// ---------------------------------------------------------------------------
// ② classify : HeadObject → ZIP 解析 → 人物分離 → 分類 → DB へ
// ---------------------------------------------------------------------------

export async function classifyBatch(batchId: string, actor: Actor) {
  const cfg = getS3Config();
  if (!cfg) return { ok: false as const, status: 503, error: 's3_not_configured' };
  const batch = await store.getBatch(batchId);
  if (!batch) return { ok: false as const, status: 404, error: 'batch_not_found' };

  // ②アップロード後の実サイズ検証 (§5.2.1・本命)
  const head = await headAdHocZip(batch.source_key, cfg);
  if (!head.ok) {
    if (head.status === 413) {
      await deleteAdHocZip(batch.source_key, cfg); // 上限超過は一時 ZIP を消す
      await store.updateBatch(batchId, { status: 'failed', last_error: head.detail ?? head.error });
    }
    return { ok: false as const, status: head.status, error: head.error, detail: head.detail };
  }
  await store.updateBatch(batchId, { status: 'uploaded', source_size: head.size });

  const archive = await openArchiveFromS3({ key: batch.source_key, knownSize: head.size, cfg });
  let analysis;
  try {
    analysis = await analyzeOpened(archive);
  } finally {
    await archive.close();
  }

  // 既存 subject と fingerprint で結び直す (§6.2.3)
  const subjectRows = await Promise.all(
    analysis.subjects.map(async (s) => {
      let identity: store.SubjectIdentityStatus = 'confirmed';
      let reason: string | null = null;
      let clientId = newClientId();
      /*
       * **再分類で Executive の紐付けを消さない** (§7)。
       * `replaceSubjects` は行を作り直すので、引き継がないと管理者が結んだ人物が
       * 黙って外れる (しかも画面は「未割当」に見えるだけでエラーにならない)。
       * 引き継ぐのは **fingerprint が一意に一致したときだけ**。
       */
      let executiveSubjectId: string | null = null;

      if (s.fingerprint) {
        const hits = await store.findSubjectsByFingerprint(batchId, s.fingerprint);
        const m = matchByFingerprint(hits.map((h) => ({ id: h.id, client_id: h.client_id })));
        if (m.kind === 'match' && m.clientId) {
          clientId = m.clientId;
          identity = 'confirmed';
          reason = 'fp_match';
          // 一意一致なので候補は 1 件。**client_id と同じ行から取る。**
          executiveSubjectId = hits[0]?.executive_subject_id ?? null;
        } else if (m.kind === 'fp_collision') {
          identity = 'needs_review';
          reason = 'fp_collision';
          /*
           * **衝突時は引き継がない。** 候補が複数あるのに 1 つ選ぶと、
           * 別人の検査データを Executive 本人のものとして納品しかねない。
           * 管理者が画面で結び直す (needs_review のまま出す)。
           */
        }
      } else {
        identity = 'needs_review';
        reason = 'no_fingerprint';
        // fingerprint が無い = 照合材料が無い。**推測して引き継がない。**
      }

      return {
        subject_no: s.subjectNo,
        subject_fp: s.fingerprint,
        client_id: clientId,
        diagnostic_id: newDiagnosticId(),
        identity_status: identity,
        identity_reason: reason,
        executive_subject_id: executiveSubjectId,
      };
    }),
  );

  const savedSubjects = await store.replaceSubjects(batchId, subjectRows);
  const byNo = new Map(savedSubjects.map((s) => [s.subject_no, s]));

  // ファイル行を作る。**元ファイル名は保存しない** (§8.1) — `display_name` だけ。
  const fileRows: Parameters<typeof store.replaceFiles>[1] = [];
  for (const s of analysis.subjects) {
    const subj = byNo.get(s.subjectNo);
    for (const f of s.files) {
      fileRows.push(fileRowOf(f, subj?.id ?? null, cfg.prefix, batchId));
    }
  }
  for (const f of analysis.batchReference) {
    fileRows.push(fileRowOf(f, null, cfg.prefix, batchId));
  }
  const savedFiles = await store.replaceFiles(batchId, fileRows);

  // 人物の性別・年齢を問診から拾う (拾えなければ unknown / null のまま)
  for (const s of analysis.subjects) {
    const subj = byNo.get(s.subjectNo);
    if (!subj) continue;
    const q = s.files.find((f) => f.questionnaire)?.questionnaire;
    if (q) {
      await store.updateSubject(subj.id, {
        sex: q.subject.sex ?? 'unknown',
        age: q.subject.age,
      });
    }
  }

  const needsReview =
    savedFiles.some((f) => f.source_kind === 'person_file' && f.classification_confidence !== 'confirmed') ||
    savedSubjects.some((s) => s.identity_status !== 'confirmed');

  await store.updateBatch(batchId, {
    status: needsReview ? 'needs_review' : 'classified',
    subject_count: savedSubjects.length,
    file_count: savedFiles.length,
  });

  await store.logEvent({
    batch_id: batchId,
    event: 'classified',
    actor_user_id: actor.userId,
    actor_masked: actor.masked,
    actor_sha256: actor.sha256,
    detail: {
      subjects: savedSubjects.length,
      files: savedFiles.length,
      rejected: analysis.rejected.length,
      needs_review: needsReview,
    },
  });

  return {
    ok: true as const,
    subjects: savedSubjects.length,
    files: savedFiles.length,
    rejected: analysis.rejected,
    notes: analysis.notes,
    needsReview,
  };
}

function mimeOf(ext: string): string | null {
  return ext === '.pdf' ? 'application/pdf'
    : ext === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : ext === '.csv' ? 'text/csv'
    : null;
}

function fileRowOf(
  f: AnalyzedFile,
  subjectId: string | null,
  prefix: string,
  batchId: string,
): store.FileWrite {
  return {
    subject_id: subjectId,
    // **S3 key に元ファイル名を入れない** (§8.1)。ZIP 内の位置は sha256 で追える。
    storage_key: `${prefix}ad-hoc-uploads/${batchId}/files/${f.sha256}${f.ext}`,
    display_name: f.displayName,
    sha256: f.sha256,
    size_bytes: f.sizeBytes,
    mime_type: mimeOf(f.ext),
    source_kind: f.classification.sourceKind,
    classified_format_id: f.classification.formatId,
    classification_confidence: f.classification.confidence,
    test_date: f.testDate,
    parse_status: f.error ? 'failed' : 'pending',
    page_count: f.pageCount ?? null,
    error_detail: f.error ?? f.classification.reason,
    /*
     * **一括分類でも正規化結果を保存する** (Phase B2.1)。
     * 後工程 (process / ウェルネス年齢 / 納品) が ZIP を読み直さなくなったので、
     * ここで保存しないと**一括分類したバッチだけ材料が無い**ことになる。
     * 中身の検査 (PII) は `buildEntryPayload` と `store` の両方で行う。
     */
    normalized_payload: buildEntryPayload({
      healthCheckup: f.healthCheckup,
      questionnaire: f.questionnaire,
    }),
  };
}

// ---------------------------------------------------------------------------
// ②′ 分割分類 (Phase B2.1) — plan → entry × N → finalize
//
// **なぜ 3 つに割るか**: 159MB / 38 ファイル (21MB の PDF × 10) を 1 リクエストで
// 展開すると `maxDuration=800` でも足りない。**タイムアウトを伸ばさず、
// 1 リクエスト = ZIP 内 1 ファイル**にする。
//
// **どれも ZIP を開き直す**が、開くのは Central Directory (数 KB) だけで、
// 中身を読むのは `classify-entry` が指定された 1 エントリを取りに行くときだけ。
// ---------------------------------------------------------------------------

/** plan / entry が共通で使う「開いて計画を立てる」。**中身は読まない。** */
async function openAndPlan(batch: store.BatchRow) {
  const cfg = getS3Config();
  if (!cfg) return { ok: false as const, status: 503, error: 's3_not_configured' };
  const head = await headAdHocZip(batch.source_key, cfg);
  if (!head.ok) return { ok: false as const, status: head.status, error: head.error, detail: head.detail };
  const archive = await openArchiveFromS3({ key: batch.source_key, knownSize: head.size, cfg });
  return { ok: true as const, cfg, size: head.size, archive, plan: planArchive(archive) };
}

/**
 * **① 作業計画を返す。** ZIP の中身は 1 バイトも読まない。
 *
 * 人物行は**足りないぶんだけ作る** (`ensureSubjectPlaceholders`) —
 * 作り直すと Executive の紐付けも遺伝子のページも消え、**再開できなくなる**。
 */
export async function classifyPlan(batchId: string, actor: Actor) {
  const batch = await store.getBatch(batchId);
  if (!batch) return { ok: false as const, status: 404, error: 'batch_not_found' };

  const opened = await openAndPlan(batch);
  if (!opened.ok) {
    if (opened.status === 413) {
      const cfg = getS3Config();
      if (cfg) await deleteAdHocZip(batch.source_key, cfg);
      await store.updateBatch(batchId, { status: 'failed', last_error: opened.detail ?? opened.error });
    }
    return opened;
  }
  const { plan } = opened;
  await opened.archive.close();

  await store.updateBatch(batchId, { status: 'processing', source_size: opened.size });

  const subjectNos = [...new Set(plan.workItems.map((w) => w.subjectNo!).filter((n) => n != null))];
  await store.ensureSubjectPlaceholders(batchId, subjectNos, () => ({
    client_id: newClientId(),
    diagnostic_id: newDiagnosticId(),
    // **分類が終わるまで確定させない。** 誰の分か決まっていないので needs_review。
    identity_status: 'needs_review',
    identity_reason: 'pending_classification',
  }));

  // **既に読んだエントリ**を返す = 途中から再開できる (同じ ZIP を上げ直させない)。
  const existing = await store.listFiles(batchId);
  const done = existing
    .map((f) => f.archive_entry_index)
    .filter((i): i is number => typeof i === 'number');

  await store.logEvent({
    batch_id: batchId, event: 'classified',
    actor_user_id: actor.userId, actor_masked: actor.masked, actor_sha256: actor.sha256,
    detail: {
      kind: 'plan',
      subjects: plan.subjectCount,
      work_items: plan.workItems.length + plan.batchReferenceItems.length,
      already_done: done.length,
      rejected: plan.rejected.length,
    },
  });

  return {
    ok: true as const,
    subjectCount: plan.subjectCount,
    // **path も人物フォルダ名も返さない** (§8.1)。返すのは序数と拡張子とサイズだけ。
    items: [...plan.workItems, ...plan.batchReferenceItems].map((w) => ({
      entryIndex: w.entryIndex,
      subjectNo: w.subjectNo,
      ext: w.ext,
      declaredSize: w.declaredSize,
    })),
    done,
    rejected: plan.rejected,
    notes: plan.notes,
  };
}

/**
 * **② 指定された 1 エントリだけを読んで分類し、1 行だけ書く。**
 *
 * `entryIndex` 以外はサーバが決める。**クライアントの申告 (人物番号・format) は使わない**
 * — 改竄されると別人のデータに混ざる。人物番号は毎回 `planArchive` から引き直す。
 */
export async function classifyEntry(input: { batchId: string; entryIndex: number; actor: Actor }) {
  const batch = await store.getBatch(input.batchId);
  if (!batch) return { ok: false as const, status: 404, error: 'batch_not_found' };
  if (!Number.isInteger(input.entryIndex) || input.entryIndex < 0) {
    return { ok: false as const, status: 400, error: 'invalid_entry_index' };
  }

  const opened = await openAndPlan(batch);
  if (!opened.ok) return opened;

  let analyzed;
  try {
    analyzed = await analyzeEntry(opened.archive, input.entryIndex, opened.plan);
  } catch (err) {
    await opened.archive.close();
    // **path をエラーに含めない** (`archive.readByIndex` も `index=N` しか出さない)。
    return {
      ok: false as const, status: 502, error: 'entry_read_failed',
      detail: `index=${input.entryIndex}: ${String(err).slice(0, 160)}`,
    };
  } finally {
    await opened.archive.close().catch(() => {});
  }

  if (analyzed.rejectedReason === 'not_in_plan') {
    // 計画に無い序数 = 採用していないエントリ。**行を作らない。**
    return { ok: false as const, status: 404, error: 'entry_not_in_plan' };
  }

  const subjects = await store.listSubjects(input.batchId);
  const subjectId = analyzed.subjectNo == null
    ? null
    : subjects.find((s) => s.subject_no === analyzed.subjectNo)?.id ?? null;

  /*
   * **採用しなかったエントリも 1 行残す** (magic 不一致など)。
   *
   * 一括分類では `rejected` の配列に入れて応答で返していたが、分割では応答が
   * エントリごとに散るので**どこにも残らない**。そのうえ finalize が
   * 「まだ読んでいない」と区別できず、**永久に完了しない**。
   * `source_kind='ignored'` の行として残せば、一覧にも出て (§5.5 黙って捨てない)、
   * 進捗も数えられる。**納品には入らない** (`person_file` でないため)。
   */
  const write: store.FileWrite = analyzed.rejectedReason
    ? {
        subject_id: subjectId,
        storage_key: `${opened.cfg.prefix}ad-hoc-uploads/${input.batchId}/files/${analyzed.sha256 || `idx${input.entryIndex}`}${analyzed.ext}`,
        display_name: `未採用_${String(input.entryIndex).padStart(3, '0')}${analyzed.ext}`,
        sha256: analyzed.sha256,
        size_bytes: analyzed.sizeBytes,
        mime_type: mimeOf(analyzed.ext),
        source_kind: 'ignored',
        classified_format_id: null,
        classification_confidence: analyzed.classification.confidence,
        test_date: null,
        parse_status: 'skipped',
        page_count: null,
        error_detail: analyzed.rejectedReason,
        archive_entry_index: input.entryIndex,
        normalized_payload: null,
      }
    : {
        subject_id: subjectId,
        storage_key: `${opened.cfg.prefix}ad-hoc-uploads/${input.batchId}/files/${analyzed.sha256}${analyzed.ext}`,
        display_name: analyzed.displayName,
        sha256: analyzed.sha256,
        size_bytes: analyzed.sizeBytes,
        mime_type: mimeOf(analyzed.ext),
        source_kind: analyzed.classification.sourceKind,
        classified_format_id: analyzed.classification.formatId,
        classification_confidence: analyzed.classification.confidence,
        test_date: analyzed.testDate,
        parse_status: analyzed.error ? 'failed' : 'pending',
        page_count: analyzed.pageCount ?? null,
        error_detail: analyzed.error ?? analyzed.classification.reason,
        archive_entry_index: input.entryIndex,
        // **遺伝子 PDF は null** (ページは `ad_hoc_diagnosis_pages` が持つ)。
        normalized_payload: buildEntryPayload({
          healthCheckup: analyzed.healthCheckup,
          questionnaire: analyzed.questionnaire,
        }),
      };

  const row = await store.upsertFileByEntryIndex(input.batchId, input.entryIndex, write);

  // 性別・年齢は問診から拾う (拾えなければ触らない = unknown / null のまま)
  if (subjectId && analyzed.questionnaire) {
    const q = analyzed.questionnaire;
    if (q.subject.sex || q.subject.age != null) {
      await store.updateSubject(subjectId, {
        sex: q.subject.sex ?? 'unknown',
        age: q.subject.age,
      });
    }
  }

  return {
    ok: true as const,
    entryIndex: input.entryIndex,
    fileId: row.id,
    subjectNo: analyzed.subjectNo,
    displayName: row.display_name,
    formatId: row.classified_format_id,
    confidence: row.classification_confidence,
    testDate: row.test_date,
    sourceKind: row.source_kind,
    skipped: analyzed.rejectedReason ?? null,
  };
}

/**
 * **③ 全エントリが済んでいることを確かめて締める。**
 *
 * 1 件でも残っていれば **409 `classification_incomplete`** を返して締めない
 * (「途中まで分類しただけのバッチ」を `classified` と名乗らせない)。
 * **返すのは件数だけ** — どのファイルが残っているかを path で示さない (§8.1)。
 */
export async function classifyFinalize(batchId: string, actor: Actor) {
  const batch = await store.getBatch(batchId);
  if (!batch) return { ok: false as const, status: 404, error: 'batch_not_found' };

  const opened = await openAndPlan(batch);
  if (!opened.ok) return opened;
  const { plan } = opened;
  await opened.archive.close();

  const files = await store.listFiles(batchId);
  const seen = new Set(
    files.map((f) => f.archive_entry_index).filter((i): i is number => typeof i === 'number'),
  );
  const planned = [...plan.workItems, ...plan.batchReferenceItems].map((w) => w.entryIndex);
  const remaining = planned.filter((i) => !seen.has(i));
  if (remaining.length > 0) {
    return {
      ok: false as const, status: 409, error: 'classification_incomplete',
      // **序数も出さない。件数だけ。** 続きは classify-plan の `done` から求める。
      detail: `未処理 ${remaining.length} 件 / 全 ${planned.length} 件`,
      remaining: remaining.length,
      total: planned.length,
    };
  }

  /*
   * **fingerprint はここで初めて決まる** (材料 = その人物のファイルの sha256)。
   * 1 件ずつ読む都合上、plan の時点では人物のファイルが全部読めていない。
   */
  const subjects = await store.listSubjects(batchId);
  for (const s of subjects) {
    const own = files.filter((f) => f.subject_id === s.id && f.source_kind === 'person_file');
    const fp = subjectFingerprint(own.map((f) => f.sha256));
    if (fp !== s.subject_fp) await store.updateSubject(s.id, { subject_fp: fp, subject_fp_source: 'auto' });
  }

  const needsReview =
    files.some((f) => f.source_kind === 'person_file' && f.classification_confidence !== 'confirmed') ||
    subjects.some((s) => s.identity_status !== 'confirmed');

  await store.updateBatch(batchId, {
    status: needsReview ? 'needs_review' : 'classified',
    subject_count: subjects.length,
    file_count: files.length,
  });
  await store.logEvent({
    batch_id: batchId, event: 'classified',
    actor_user_id: actor.userId, actor_masked: actor.masked, actor_sha256: actor.sha256,
    detail: {
      kind: 'finalize',
      subjects: subjects.length,
      files: files.length,
      rejected: plan.rejected.length,
      needs_review: needsReview,
    },
  });

  return {
    ok: true as const,
    subjects: subjects.length,
    files: files.length,
    rejected: plan.rejected,
    notes: plan.notes,
    needsReview,
  };
}

// ---------------------------------------------------------------------------
// ③ status : 画面が見る状態
// ---------------------------------------------------------------------------

/**
 * **その output は実際に納品できるか。**
 *
 * `generated` / `exported` で、かつ `error` でないものだけ。
 * `warn` は納品してよい (例: 問診の `unmapped` — 写像できない設問があっても
 * 人物ごと落とさない、が既存の約束)。
 * **`failed` は数えない** — 未完成の遺伝子はここで確実に外れる。
 */
function isDeliverableOutput(o: store.OutputRow): boolean {
  return (o.output_status === 'generated' || o.output_status === 'exported')
    && o.validation_status !== 'error';
}

export async function batchStatus(batchId: string) {
  const batch = await store.getBatch(batchId);
  if (!batch) return { ok: false as const, status: 404, error: 'batch_not_found' };
  const subjects = await store.listSubjects(batchId);
  const files = await store.listFiles(batchId);
  const outputs = await store.listOutputs(subjects.map((s) => s.id));
  const events = await store.listEvents(batchId, 50);

  const outputsBySubject = new Map<string, store.OutputRow[]>();
  for (const o of outputs) {
    const list = outputsBySubject.get(o.subject_id) ?? [];
    list.push(o);
    outputsBySubject.set(o.subject_id, list);
  }

  return {
    ok: true as const,
    batch: {
      ...batch,
      // **fingerprint は先頭 8 文字だけ** (§6.2.1)
      source_sha256_short: batch.source_sha256.slice(0, 8),
    },
    /*
     * **Genoplan の対象ページを API から配る** (spec §8.5・v1.1)。
     *
     * wellfort-site に `10` / `35` を独立した正本として持たせない。UI は
     * この配列に在るページだけを画像化して送る。正本は
     * `elith-genetic.ts` の `GENOPLAN_V1_REQUIRED_PAGES` ひとつ。
     */
    geneticRequiredPages: GENOPLAN_V1_REQUIRED_PAGES,
    subjects: subjects.map((s) => {
      const own = files.filter((f) => f.subject_id === s.id);
      /*
       * **納品できる output だけを「揃っている」と数える。**
       * 行が在ることと納品できることは別物で、以前は `failed` / `error` の行まで
       * 数えていたため、**未完成の遺伝子を抱えたまま「納品可」と表示**されていた
       * (そして納品時に黙って 1 ファイル減る)。判定は組み立て側と同じ規則。
       */
      const produced = (outputsBySubject.get(s.id) ?? [])
        .filter(isDeliverableOutput)
        .map((o) => o.format_id);
      const readiness = evaluateReadiness({
        producedFormats: produced,
        requiredFormats: batch.required_formats,
        optionalFormats: batch.optional_formats,
        requireExecutiveLink: batch.require_executive_link,
        executiveSubjectId: s.executive_subject_id,
        classifications: own.map((f) => ({
          sourceKind: f.source_kind,
          formatId: f.classified_format_id,
          confidence: f.classification_confidence,
          reason: '',
        })),
      });
      return {
        id: s.id,
        subject_no: s.subject_no,
        fingerprint_short: shortFingerprint(s.subject_fp),
        client_id: s.client_id,
        diagnostic_id: s.diagnostic_id,
        identity_status: s.identity_status,
        identity_reason: s.identity_reason,
        /**
         * **UUID だけ返す。** 誰なのかは Wellfort 側でしか引けない
         * (画面は自分の Supabase から氏名を出し、こちらは照合用の ID を返すだけ)。
         */
        executive_subject_id: s.executive_subject_id,
        sex: s.sex,
        age: s.age,
        status: s.status,
        files: own.map(publicFile),
        outputs: (outputsBySubject.get(s.id) ?? []).map((o) => ({
          format_id: o.format_id,
          output_status: o.output_status,
          validation_status: o.validation_status,
          item_count: o.item_count,
          test_date: o.test_date,
          json_storage_key: o.json_storage_key,
          error_detail: o.error_detail,
        })),
        readiness,
      };
    }),
    batchReference: files.filter((f) => f.subject_id === null).map(publicFile),
    events: events.map((e) => ({
      event: e.event,
      actor: e.actor_masked,
      detail: e.detail,
      created_at: e.created_at,
    })),
  };
}

function publicFile(f: store.FileRow) {
  return {
    id: f.id,
    display_name: f.display_name,
    sha256_short: f.sha256.slice(0, 8),
    size_bytes: f.size_bytes,
    source_kind: f.source_kind,
    format_id: f.classified_format_id,
    confidence: f.classification_confidence,
    test_date: f.test_date,
    parse_status: f.parse_status,
    page_count: f.page_count,
    error_detail: f.error_detail,
  };
}

// ---------------------------------------------------------------------------
// ④ classification/confirm : 管理者による分類の修正
// ---------------------------------------------------------------------------

/**
 * 人物 ↔ Executive 人物マスタ の紐付け (Phase B1・§6)。
 *
 * **受け取るのは UUID だけ。** 氏名・メール・会社名・役職は引数にも DB にも入れない
 * (`diagnosis` スキーマは PII を持たない)。`executiveSubjectId` が何者かは
 * こちらでは一切解釈せず、**不透明な識別子として保存するだけ**。
 *
 * `executiveSubjectId: null` で解除。
 */
export async function linkExecutiveSubject(input: {
  batchId: string;
  subjectId: string;
  executiveSubjectId: string | null;
  actor: Actor;
}) {
  const batch = await store.getBatch(input.batchId);
  if (!batch) return { ok: false as const, status: 404, error: 'batch_not_found' };

  // **その人物が本当にこのバッチのものか**をサーバ側で確かめる
  // (クライアントの申告どおりに書くと、別バッチの人物を書き換えられる)。
  const subject = await store.getSubject(input.subjectId);
  if (!subject || subject.batch_id !== input.batchId) {
    return { ok: false as const, status: 404, error: 'subject_not_found' };
  }

  if (input.executiveSubjectId) {
    // **同じバッチで同じ Executive を 2 人に割り当てない。**
    // DB にも部分一意インデックスがあるが、409 を返すためここでも見る。
    const siblings = await store.listSubjects(input.batchId);
    const taken = siblings.find(
      (s) => s.id !== input.subjectId && s.executive_subject_id === input.executiveSubjectId,
    );
    if (taken) {
      return {
        ok: false as const, status: 409, error: 'executive_already_linked',
        detail: `このバッチの人物 No.${taken.subject_no} に既に紐付いています。`,
      };
    }
  }

  /*
   * **紐付け = 人物を確定させる操作。** Executive 案件では分類確定が identity を
   * 触らないので、ここが唯一の確定経路になる。
   *
   * ただし **既に confirmed の人物の理由を書き換えない** — fingerprint 一致
   * (`fp_match`) 等で独立に確定していた人物を、あとで unlink したときに
   * needs_review へ落としてしまう (紐付けと関係なく成立していた確定を壊す)。
   * 戻すのは「紐付けたから確定した」人物だけ。
   */
  const patch: Parameters<typeof store.updateSubject>[1] = {
    executive_subject_id: input.executiveSubjectId,
  };
  if (input.executiveSubjectId) {
    if (subject.identity_status !== 'confirmed') {
      patch.identity_status = 'confirmed';
      patch.identity_reason = 'executive_linked';
    }
  } else if (subject.identity_reason === 'executive_linked') {
    patch.identity_status = 'needs_review';
    patch.identity_reason = 'executive_unlinked';
  }

  const updated = await store.updateSubject(input.subjectId, patch);
  await store.logEvent({
    batch_id: input.batchId,
    event: 'override',
    subject_id: input.subjectId,
    actor_user_id: input.actor.userId,
    actor_masked: input.actor.masked,
    actor_sha256: input.actor.sha256,
    // **UUID の有無だけ**を残す (誰かは Wellfort 側にしか無い)。
    detail: { kind: 'executive_link', linked: input.executiveSubjectId !== null },
  });
  return {
    ok: true as const,
    subjectId: updated.id,
    executiveSubjectId: updated.executive_subject_id,
  };
}

export async function confirmClassification(input: {
  batchId: string;
  changes: {
    fileId: string;
    formatId: FormatId | null;
    subjectId?: string | null;
    /** `YYYY-MM-DD` のみ。`null` で解除。未指定なら触らない。 */
    testDate?: string | null;
  }[];
  actor: Actor;
}) {
  const batch = await store.getBatch(input.batchId);
  if (!batch) return { ok: false as const, status: 404, error: 'batch_not_found' };

  for (const c of input.changes) {
    const before = await store.getFile(c.fileId);
    if (!before || before.batch_id !== input.batchId) continue;
    await store.updateFile(c.fileId, {
      classified_format_id: c.formatId,
      // **管理者が直したものは confirmed** (人が見たという事実を残す)
      classification_confidence: 'confirmed',
      ...(c.subjectId !== undefined ? { subject_id: c.subjectId } : {}),
      ...(c.testDate !== undefined ? { test_date: c.testDate } : {}),
    });
    await store.logEvent({
      batch_id: input.batchId,
      event: 'reclassified',
      file_id: c.fileId,
      actor_user_id: input.actor.userId,
      actor_masked: input.actor.masked,
      actor_sha256: input.actor.sha256,
      // **値そのものでなく種類**を残す (§21)
      detail: { from: before.classified_format_id, to: c.formatId },
    });
    /*
     * **日付を人が直した事実だけ**を別に残す (§10)。
     * `error_detail` に埋め込むと「解析が失敗した」と区別できなくなるので、
     * 既存の `override` イベントを使う (**audit の schema は広げない**)。
     * 値そのものは残さず、**設定したか解除したか**だけ。
     */
    if (c.testDate !== undefined && c.testDate !== before.test_date) {
      await store.logEvent({
        batch_id: input.batchId,
        event: 'override',
        file_id: c.fileId,
        actor_user_id: input.actor.userId,
        actor_masked: input.actor.masked,
        actor_sha256: input.actor.sha256,
        detail: { kind: 'manual_test_date', cleared: c.testDate === null },
      });
    }
  }

  /*
   * 人物の識別も confirmed へ寄せる (管理者が画面で見たあと)。
   *
   * **Executive 案件ではこれをやらない。** あちらは「分類が正しいか」と
   * 「誰の検査か」が別の作業で、分類確定のボタン 1 つで人物まで確定させると
   * **人物マスタへ紐付けないまま identity だけ confirmed になる**
   * (誰の分か決まっていないのに「確認済み」と表示される)。
   * Executive 案件で人物を確定させるのは `linkExecutiveSubject` だけ。
   */
  if (!batch.require_executive_link) {
    const subjects = await store.listSubjects(input.batchId);
    for (const s of subjects) {
      if (s.identity_status === 'needs_review') {
        await store.updateSubject(s.id, { identity_status: 'confirmed', identity_reason: 'admin_confirmed' });
      }
    }
  }

  await store.updateBatch(input.batchId, { status: 'classified', confirmed_at: new Date().toISOString() });
  await store.logEvent({
    batch_id: input.batchId,
    event: 'confirmed',
    actor_user_id: input.actor.userId,
    actor_masked: input.actor.masked,
    actor_sha256: input.actor.sha256,
    detail: { changes: input.changes.length },
  });
  return { ok: true as const, changed: input.changes.length };
}

// ---------------------------------------------------------------------------
// ⑤ process : 解析して Elith JSON を作る (S3 へは書かない)
// ---------------------------------------------------------------------------

export interface ProcessOptions {
  /** 遺伝子 PDF の 1 ページを画像化したもの。ブラウザ (pdf.js) が作って送る。 */
  geneticPages?: { fileId: string; page: number; imageBase64: string; mimeType: string }[];
  /**
   * 健診 PDF の 1 ページを画像化したもの (spec §6.5)。
   *
   * **遺伝子と違って対象ページの絞り込みは無い** — 健診票は数ページで、
   * どのページにも検査値が印字され得るため全ページが対象。
   * `pageCount` はブラウザの pdf.js が数えた総ページ数で、**完了判定の母数**になる
   * (サーバ側の `countPdfPages` は正規表現による概算なので母数に使わない)。
   */
  healthPages?: {
    fileId: string; page: number; pageCount: number;
    imageBase64: string; mimeType: string;
  }[];
  /** 失敗したページだけを対象にする。 */
  retryFailedOnly?: boolean;
}

/**
 * 健診 PDF 1 ページぶんの、**DB に保存してよい形**。
 *
 * **生 Markdown (`scan.markdown`) は入れない** — 実在の人の検査票の生テキストは
 * 氏名・患者 ID を含み得る (ゴールデンの見出しが実際にそうなっている)。
 * spec §2.4「実在役員の raw PDF text を診断 DB へ新規保存しない」。
 * 推移グラフページかどうかだけ**読んだ直後に判定して真偽値で残す**ので、
 * finalize core は生 Markdown 無しで従来と同じ結果を出せる。
 */
interface HealthPageParsed {
  measurements: unknown[];
  notes: string[];
  isTrendPage: boolean;
  /** `scanImageToParsed` が読めた検査日。**`today` 由来は保存しない** (§6.4)。 */
  testDate: string | null;
  dateSource: string;
}

function restoreHealthPage(parsed: unknown): HealthPageParsed | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (!Array.isArray(o.measurements)) return null;
  return {
    measurements: o.measurements,
    notes: Array.isArray(o.notes) ? (o.notes as string[]) : [],
    isTrendPage: o.isTrendPage === true,
    testDate: typeof o.testDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.testDate) ? o.testDate : null,
    dateSource: typeof o.dateSource === 'string' ? o.dateSource : 'unknown',
  };
}

/**
 * 問診の手入力 (PDF 用) を読み出す。**二重確認が済んでいるものだけ返す** (spec §7.4)。
 *
 * 保存先は既存の `ad_hoc_diagnosis_pages` (page_no=1)。**新しいテーブルを作らない**
 * (§2.4「新 migration は原則不要。既存で成立するか先に検証する」)。
 */
async function resolveManualQuestionnaire(fileId: string): Promise<QuestionnaireNormalized | null> {
  const pages = await store.listPages(fileId);
  const row = pages.find((p) => p.page_no === MANUAL_QUESTIONNAIRE_PAGE_NO);
  if (!row || !isManualQuestionnaireRecord(row.parsed)) return null;
  const rec = row.parsed;
  // **入力しただけでは使わない。** 別の目で見るところまでが仕様。
  if (!manualRecordIsConfirmed(rec)) return null;
  return manualQuestionnaire({
    entries: rec.entries, completedAt: rec.completedAt, sex: rec.sex, age: rec.age,
  }).normalized;
}

/** 手入力を待っている状態か (入力が無い / 確認がまだ)。画面に理由を出すため。 */
async function manualEntryPending(file: store.FileRow | undefined): Promise<boolean> {
  if (!file) return false;
  // 手入力が要るのは **PDF の問診だけ**。XLSX は分類時に読めている。
  if (!/\.pdf$/i.test(file.display_name ?? '')) return false;
  const pages = await store.listPages(file.id);
  const row = pages.find((p) => p.page_no === MANUAL_QUESTIONNAIRE_PAGE_NO);
  if (!row || !isManualQuestionnaireRecord(row.parsed)) return true;
  return !manualRecordIsConfirmed(row.parsed);
}

/**
 * 保存済みの手入力を読み出す (画面の再表示用)。
 *
 * **確認済みかどうかに関わらず返す** — 画面は「入力済みだが未確認」を出す必要がある。
 * 納品に使ってよいかを決めるのは `resolveManualQuestionnaire` の側。
 */
export async function readManualQuestionnaire(batchId: string, fileId: string) {
  const batch = await store.getBatch(batchId);
  if (!batch) return { ok: false as const, status: 404, error: 'batch_not_found' };
  const file = await store.getFile(fileId);
  if (!file || file.batch_id !== batchId) return { ok: false as const, status: 404, error: 'file_not_found' };
  const pages = await store.listPages(file.id);
  const row = pages.find((p) => p.page_no === MANUAL_QUESTIONNAIRE_PAGE_NO);
  const rec = row && isManualQuestionnaireRecord(row.parsed) ? row.parsed : null;
  return {
    ok: true as const,
    record: rec
      ? { ...rec, confirmed: manualRecordIsConfirmed(rec), same_actor: !!rec.confirmedBy && rec.confirmedBy === rec.enteredBy }
      : null,
  };
}

/**
 * 問診の手入力を保存する (spec §7.4)。
 *
 * `confirm: true` で**二重確認**。入力した人と確認した人が同じでも保存はするが、
 * **誰が入力し誰が確認したかを必ず残す** (画面に出して人が判断できるようにする)。
 */
export async function saveManualQuestionnaire(input: {
  batchId: string;
  fileId: string;
  entries: ManualEntry[];
  completedAt?: string | null;
  sex?: string | null;
  age?: number | null;
  confirm?: boolean;
  actor: Actor;
}) {
  const batch = await store.getBatch(input.batchId);
  if (!batch) return { ok: false as const, status: 404, error: 'batch_not_found' };
  const file = await store.getFile(input.fileId);
  if (!file || file.batch_id !== input.batchId) return { ok: false as const, status: 404, error: 'file_not_found' };
  if (file.classified_format_id !== 'LifestyleQuestionnaireData') {
    return { ok: false as const, status: 400, error: 'not_a_questionnaire' };
  }

  const pages = await store.listPages(file.id);
  const prevRow = pages.find((p) => p.page_no === MANUAL_QUESTIONNAIRE_PAGE_NO);
  const prev = prevRow && isManualQuestionnaireRecord(prevRow.parsed) ? prevRow.parsed : null;

  /*
   * **確認は「今ある入力」に対してしか出せない。**
   * 入力を差し替えたら確認はやり直し — でないと「A を確認したつもりが B が納品される」。
   */
  const entries = Array.isArray(input.entries) ? input.entries : [];
  const isConfirmOnly = input.confirm === true && entries.length === 0 && prev !== null;
  const nextEntries = isConfirmOnly ? prev.entries : entries;

  // **保存する前に検証する。** 弾かれた入力は保存もしない (画面へ返す)。
  const result = manualQuestionnaire({
    entries: nextEntries,
    completedAt: isConfirmOnly ? prev.completedAt : (input.completedAt ?? null),
    sex: isConfirmOnly ? prev.sex : input.sex,
    age: isConfirmOnly ? prev.age : input.age,
  });

  // `Actor.masked` は wellfort-site の中継が検証済み user.id から作ったもの。
  // **ブラウザ申告の氏名は入らない** (§21)。
  const actorMask = input.actor.masked;
  const now = new Date().toISOString();
  const rec: ManualQuestionnaireRecord = {
    kind: 'manual_questionnaire',
    entries: nextEntries,
    completedAt: isConfirmOnly ? prev.completedAt : (input.completedAt ?? null),
    sex: isConfirmOnly ? prev.sex : (input.sex ?? null),
    age: isConfirmOnly ? prev.age : (input.age ?? null),
    enteredBy: isConfirmOnly ? prev.enteredBy : actorMask,
    enteredAt: isConfirmOnly ? prev.enteredAt : now,
    // **入力を差し替えたら確認は外れる。**
    confirmedBy: input.confirm === true ? actorMask : null,
    confirmedAt: input.confirm === true ? now : null,
  };

  await store.upsertPage({
    file_id: file.id, file_sha256: file.sha256, page_no: MANUAL_QUESTIONNAIRE_PAGE_NO,
    status: 'done', parsed: rec, raw: null,
  });
  await store.logEvent({
    batch_id: input.batchId,
    /*
     * **既存の event 名を使う** — `event` には DB 側の CHECK 制約があり
     * (`20260910000020_ad_hoc_diagnosis.sql:396`)、名前を増やすと DDL が要る。
     * 本案件は migration を足さない方針 (§13) なので、
     * 入力=`parsed` / 確認=`confirmed` に寄せ、区別は `detail.kind` で付ける。
     */
    event: input.confirm === true ? 'confirmed' : 'parsed',
    file_id: file.id,
    // **件数だけ。回答の中身はログに出さない** (§16)。
    detail: {
      kind: 'manual_questionnaire',
      accepted: result.normalized.mappedCount,
      rejected: result.rejected.length,
    },
  });

  return {
    ok: true as const,
    accepted: result.normalized.mappedCount,
    rejected: result.rejected,
    confirmed: manualRecordIsConfirmed(rec),
    entered_by: rec.enteredBy,
    confirmed_by: rec.confirmedBy,
    // **入力者と確認者が同じなら画面で分かるようにする** (§7.4 は「別の管理者または同等の二重確認」)。
    same_actor: !!rec.confirmedBy && rec.confirmedBy === rec.enteredBy,
    completed_at: result.normalized.completedAt,
  };
}

export async function processBatch(batchId: string, actor: Actor, options: ProcessOptions = {}) {
  await refreshConfig();
  // **S3 は要らない** (Phase B2.1)。ここは ZIP を開かず DB の材料だけで組む。
  const batch = await store.getBatch(batchId);
  if (!batch) return { ok: false as const, status: 404, error: 'batch_not_found' };

  await store.updateBatch(batchId, { status: 'processing' });

  // 遺伝子ページの取り込み (**既存 `scanGeneticPage` を使う。新 prompt を作らない**)
  const pageResults: { fileId: string; page: number; ok: boolean; cached: boolean; error?: string }[] = [];
  for (const p of options.geneticPages ?? []) {
    const file = await store.getFile(p.fileId);
    if (!file || file.batch_id !== batchId) continue;

    // **キャッシュ (file_sha256, page_no)** — 成功済みページは Gemini を呼ばない (§19.3)
    const cached = await store.findCachedPage(file.sha256, p.page);
    if (cached && !options.retryFailedOnly) {
      await store.upsertPage({
        file_id: file.id, file_sha256: file.sha256, page_no: p.page,
        status: 'done', parsed: cached.parsed, raw: cached.raw,
      });
      pageResults.push({ fileId: file.id, page: p.page, ok: true, cached: true });
      continue;
    }

    try {
      const r = await scanGeneticPage({ imageBase64: p.imageBase64, mimeType: p.mimeType });
      await store.upsertPage({
        file_id: file.id, file_sha256: file.sha256, page_no: p.page,
        status: r.parsed ? 'done' : 'failed',
        parsed: { section: r.section, items: r.items },
        raw: r.raw,
        error_detail: r.parsed ? null : `unparsed:${r.finishReason ?? 'unknown'}`,
      });
      pageResults.push({ fileId: file.id, page: p.page, ok: r.parsed, cached: false });
      await store.logEvent({
        batch_id: batchId, event: r.parsed ? 'page_done' : 'page_failed', file_id: file.id,
        detail: { page: p.page, items: Array.isArray(r.items) ? r.items.length : 0 },
      });
    } catch (err) {
      const msg = String(err).slice(0, 200);
      await store.upsertPage({
        file_id: file.id, file_sha256: file.sha256, page_no: p.page,
        status: 'failed', error_detail: msg,
      });
      pageResults.push({ fileId: file.id, page: p.page, ok: false, cached: false, error: msg });
      await store.logEvent({ batch_id: batchId, event: 'page_failed', file_id: file.id, detail: { page: p.page } });
    }
  }

  /*
   * 健診 PDF のページ取り込み (spec §6.5)。
   *
   * **既存 production の `scanImageToParsed()` をそのまま呼ぶ。** ad-hoc 専用の
   * 読み取りも prompt も作らない (spec §4.3 / §18「独自 HealthCheckup JSON parser」禁止)。
   * ここで S3 へは書かない — `elith-hc-merge` の `action=part` は元画像を S3 へ置くが、
   * **Human Review より前に実書き込みをしてはならない** (§6.5)。だから API ではなく
   * 関数を直接呼び、保存先は診断 DB の `ad_hoc_diagnosis_pages` だけにする。
   */
  for (const p of options.healthPages ?? []) {
    const file = await store.getFile(p.fileId);
    if (!file || file.batch_id !== batchId) continue;

    // 遺伝子と同じキャッシュ規則 — 成功済みページは Gemini を呼ばない。
    const cached = await store.findCachedPage(file.sha256, p.page);
    if (cached && !options.retryFailedOnly) {
      await store.upsertPage({
        file_id: file.id, file_sha256: file.sha256, page_no: p.page,
        status: 'done', parsed: cached.parsed, raw: null,
      });
      continue;
    }

    try {
      const scan = await scanImageToParsed({ imageBase64: p.imageBase64, mimeType: p.mimeType });
      /*
       * **`today` に落ちた日付は保存しない** (spec §6.4 / E2E 受入 11)。
       *
       * `extractExamDate()` は検査票から日付を読めなかったとき `source:'today'` で
       * **その日の日付を返す**。通常の admin バッチはそれで運用しているが、本案件では
       * 「日付を推定・today 補完しない」が受入条件なので、**ここで捨てて未解決にする**。
       * 落とした結果どの人物も日付が取れなければ、その人物は管理者確認へ回る。
       */
      const resolved = scan.dateSource !== 'today' ? scan.testDate : null;
      const payload: HealthPageParsed = {
        measurements: scan.measurements as unknown[],
        notes: Array.isArray(scan.notes) ? scan.notes : [],
        // **生 Markdown はここで使い切る。** 真偽値だけ残して本文は保存しない (§2.4)。
        isTrendPage: isTrendMarkdown(scan.markdown),
        testDate: resolved,
        dateSource: scan.dateSource,
      };
      await store.upsertPage({
        file_id: file.id, file_sha256: file.sha256, page_no: p.page,
        status: 'done', parsed: payload, raw: null,
      });
      await store.logEvent({
        batch_id: batchId, event: 'page_done', file_id: file.id,
        // **件数とページ番号だけ。** 検査値も氏名もログに出さない (§16)。
        detail: { page: p.page, items: payload.measurements.length, kind: 'health_checkup' },
      });
    } catch (err) {
      const msg = String(err).slice(0, 200);
      await store.upsertPage({
        file_id: file.id, file_sha256: file.sha256, page_no: p.page,
        status: 'failed', error_detail: msg,
      });
      await store.logEvent({ batch_id: batchId, event: 'page_failed', file_id: file.id, detail: { page: p.page, kind: 'health_checkup' } });
    }

    /*
     * **総ページ数はブラウザが数えた値を正とする** (pdf.js が実際に開いて数えている)。
     * サーバ側の `countPdfPages` は正規表現の概算なので、完了判定の母数にしない。
     */
    if (Number.isInteger(p.pageCount) && p.pageCount > 0 && file.page_count !== p.pageCount) {
      await store.updateFile(file.id, { page_count: p.pageCount });
    }
  }

  /*
   * **ZIP を開き直さない** (Phase B2.1)。
   *
   * 以前はここで `analyzeOpened` を呼び、159MB の ZIP を毎回まるごと展開していた。
   * 分割分類を入れても、**この 1 か所が残っていれば結局タイムアウトする**。
   * 材料は分類のときに `normalized_payload` として保存済みなので、DB から復元する。
   */
  const subjects = await store.listSubjects(batchId);
  const files = await store.listFiles(batchId);
  const produced: { subjectId: string; formats: string[] }[] = [];

  for (const s of subjects) {
    const own = files.filter((f) => f.subject_id === s.id);
    const formats: string[] = [];
    let markers: Record<string, number> = {};
    let hcTestDate: string | null = null;

    // ── 健診 (spec §6.2 / §6.5) ──
    /*
     * **HealthCheckupData は健診 PDF から作る。**
     *
     * v1.0 はここで `health-checkup-xlsx.ts` の 39 列 XLSX を読んで JSON にしていたが、
     * v1.1 で**本経路から外した** (§6.2 / §19-C)。全 10 名に健診 PDF があり、
     * 標準タイプ2 と同じ「健診スキャン」経路を正とするため。XLSX は照合・
     * Golden 作成の補助資料に降格 (§6.3) — 納品 JSON の生成元にはしない。
     *
     * 整形は**本番と同じ共通 core** (`finalizeHealthCheckup`)。ad-hoc 側に
     * 検査値の抽出も正規化も書かない (§4.3)。
     */
    const hcFile = own.find((f) => f.classified_format_id === 'HealthCheckupData');
    if (hcFile) {
      const hcPages = await store.listPages(hcFile.id);
      const donePages = hcPages.filter((p) => p.status === 'done');
      const expected = hcFile.page_count ?? 0;
      /*
       * **完了は「1..総ページ数が全部 done」**。ページ番号の集合で見るので、
       * 通信断で行すら作られなかったページも未完了として出る (遺伝子と同じ規則・§8.6)。
       */
      const seen = new Set(donePages.map((p) => p.page_no));
      const missingHc = expected > 0
        ? Array.from({ length: expected }, (_, i) => i + 1).filter((n) => !seen.has(n))
        : [];

      const parts = donePages
        .slice()
        .sort((a, b) => a.page_no - b.page_no)
        .map((p) => restoreHealthPage(p.parsed))
        .filter((x): x is HealthPageParsed => x !== null);

      /*
       * **日付は読めたページからだけ採る。** `today` 由来は取り込み時に捨ててある。
       * 読めた日付が食い違うときは**どちらかを選ばず**管理者確認へ回す (§6.4・推定しない)。
       */
      const hcDates = Array.from(new Set(parts.map((p) => p.testDate).filter((d): d is string => !!d)));
      const hcDate = hcDates.length === 1 ? hcDates[0] : null;

      if (parts.length === 0) {
        /*
         * **黙って落とさない。** PDF がまだ読まれていない (解析前) か、
         * 健診が XLSX しか無い人物。どちらも「分類し直す / 解析を実行する」で直るので
         * 理由をそのまま画面へ出す。**XLSX へ勝手に切り替えない** (§6.2)。
         */
        await store.upsertOutput({
          subject_id: s.id, format_id: 'HealthCheckupData',
          output_status: 'failed', validation_status: 'error',
          error_detail: hcFile.source_kind === 'person_file' && expected === 0
            ? 'health_pdf_not_scanned'
            : 'health_pages_missing',
        });
      } else if (missingHc.length > 0) {
        await store.upsertOutput({
          subject_id: s.id, format_id: 'HealthCheckupData',
          output_status: 'failed', validation_status: 'warn',
          error_detail: `missing_pages:${missingHc.join(',')}`,
        });
      } else if (!hcDate) {
        // **today も ZIP 作成日も他検査の日付も入れない** (§6.4)。
        await store.upsertOutput({
          subject_id: s.id, format_id: 'HealthCheckupData',
          output_status: 'failed', validation_status: 'error',
          error_detail: hcDates.length > 1 ? `test_date_conflict:${hcDates.join(',')}` : 'test_date_unresolved',
        });
      } else {
        const fin = finalizeHealthCheckup({
          clientId: s.client_id,
          testDate: hcDate,
          parts,
          note: '臨時診断バッチ (健診PDF・既存 scanImageToParsed + 本番 finalize core)。',
          // **生 Markdown を納品 JSON へ載せない** — 氏名を含み得る (§16)。
          includeRawMarkdown: false,
        });
        hcTestDate = hcDate;
        markers = normalizeMarkers(
          fin.measurements.map((m) => ({
            name: typeof m.name === 'string' ? m.name : '',
            value: m.value == null ? null : String(m.value),
          })) as never,
        ) as Record<string, number>;
        await store.upsertOutput({
          subject_id: s.id, format_id: 'HealthCheckupData',
          output_status: 'generated', validation_status: fin.rows > 0 ? 'ok' : 'warn',
          item_count: fin.rows, test_date: hcDate,
          generated_at: new Date().toISOString(),
        });
        formats.push('HealthCheckupData');
      }
      await store.updateFile(hcFile.id, {
        parse_status: parts.length > 0 && missingHc.length === 0 && hcDate ? 'done'
          : parts.length > 0 ? 'processing' : 'pending',
        test_date: hcDate,
      });
    }

    // ── 問診 (spec §7.3 / §7.4) ──
    /*
     * 材料の出どころは 2 つ。**順番が意味を持つ。**
     *   ① 管理者の手入力 (PDF 用・二重確認済みのものだけ) … `resolveManualQuestionnaire`
     *   ② 分類時に読んだ XLSX の `normalized_payload`
     *
     * **PDF を自動 parse した answers は無い** (v1.1 で本経路から外した・§7.4)。
     * PDF の人物は ① が入るまで `needs_manual_entry` のまま = 納品対象にならない。
     */
    const qFile = own.find((f) => f.classified_format_id === 'LifestyleQuestionnaireData');
    const qManual = qFile ? await resolveManualQuestionnaire(qFile.id) : null;
    const qRestored = qManual ?? (qFile ? restoreQuestionnaire(qFile.normalized_payload) : null);
    if (qFile && !qRestored) {
      await store.upsertOutput({
        subject_id: s.id, format_id: 'LifestyleQuestionnaireData',
        output_status: 'failed', validation_status: 'error',
        // **手入力待ちと材料欠落を区別する** — 対処がまるで違う
        // (前者は人が入力する / 後者は分類し直す)。
        error_detail: await manualEntryPending(qFile)
          ? 'questionnaire_needs_manual_entry'
          : 'normalized_payload_missing',
      });
    }
    if (qFile && qRestored) {
      const q = qRestored;
      if (questionnaireIsUsable(q)) {
        const built = buildQuestionnaireJson({
          clientId: s.client_id,
          diagnosticId: s.diagnostic_id ?? s.client_id,
          normalized: q,
        });
        await store.upsertOutput({
          subject_id: s.id, format_id: 'LifestyleQuestionnaireData',
          output_status: 'generated',
          // **未対応項目があっても人物を失敗にしない。** warn として残す。
          // **要確認だけを warn にする。** 仕様として捨てた列 (53〜62) は正常。
          validation_status: q.needsReviewCount > 0 ? 'warn' : 'ok',
          item_count: built.answerCount, test_date: built.testDate,
          generated_at: new Date().toISOString(),
          // **3 つを分けて残す** (契約)。件数だけ = 回答値は載せない (§16)。
          error_detail: q.needsReviewCount
            ? `needs_review:${q.needsReviewCount} ignored_by_spec:${q.ignoredBySpec}`
            : null,
        });
        formats.push('LifestyleQuestionnaireData');
      } else {
        await store.upsertOutput({
          subject_id: s.id, format_id: 'LifestyleQuestionnaireData',
          output_status: 'failed', validation_status: 'error',
          error_detail: 'no_answers_mapped',
        });
      }
      await store.updateFile(qFile.id, {
        parse_status: questionnaireIsUsable(q) ? 'done' : 'failed',
        error_detail: questionnaireSummary(q),
      });
    }

    // ── 遺伝子 ──
    const gFile = own.find((f) => f.classified_format_id === 'GeneticTestResultData');
    if (gFile) {
      const pages = await store.listPages(gFile.id);
      const doneParts: GeneticPagePart[] = pages
        // **対象外ページの結果は納品へ混ぜない** (spec §8.5/§12.3)。
        // 過去のバッチで p1〜9 / p36 以降の行が残っていても、v1 の納品物には入れない。
        .filter((p) => p.status === 'done' && isGenoplanV1RequiredPage(p.page_no))
        .map((p) => {
          const parsed = (p.parsed ?? {}) as { section?: string | null; items?: unknown[] };
          return { page: p.page_no, section: parsed.section ?? null, items: parsed.items ?? [] };
        });
      const failed = pages.filter((p) => p.status === 'failed' && isGenoplanV1RequiredPage(p.page_no)).length;
      /*
       * **完了判定は「必要な p10〜35 が揃っているか」で見る** (spec §8.6・v1.1)。
       *
       * 以前はここが「登録済みの行が全部 done か」だった。その方式には穴があり、
       * **通信断でそのページの行自体が作られなかった場合に完了扱いになる**
       * (サーバはそのページの存在を知らないので、数えようがない)。
       * 必要な集合の側から引けば、行が無いページも `missing` として出る。
       *
       * **`page_count` は使わない** — あれは `countPdfPages` の正規表現による概算で、
       * 外すと操作で直せない状態で納品が永久に止まる。
       * **p1〜9 / p36 以降の行が過去のバッチで残っていても母数に含めない**
       * (`missingGenoplanV1Pages` が対象外を落とす)。
       */
      const missingPages = missingGenoplanV1Pages(
        pages.filter((p) => p.status === 'done').map((p) => p.page_no),
      );
      const incomplete = missingPages.length;
      /*
       * **遺伝子の日付は遺伝子ファイル自身のもの** (§10・Phase B1 で是正)。
       * 以前は健診の `hcTestDate` を流用していたが、健診日と採取日は別物で、
       * **納品 key の日付フォルダとファイル名がそのまま間違う** (Elith 側では
       * 「その日に遺伝子検査をした」ようにしか見えない)。
       * 取れないなら **null のまま**。今日でも健診日でも bundle_date でも埋めない。
       */
      const gTestDate = gFile.test_date ?? null;

      /*
       * **完成の条件は 1 つに決めて、output / parse_status / producedFormats の
       * 3 つとも同じものを見る。**
       *
       * 以前は producedFormats だけ `incomplete` を見て、`validation_status` と
       * `parse_status` は `failed` の件数しか見ていなかったため、
       * **未処理 (pending) のページが残っていても `ok` / `done` と表示**された
       * (画面は「完成」に見えるのに納品物には入らない、という食い違い)。
       */
      const geneticComplete = !!gTestDate && doneParts.length > 0 && incomplete === 0;

      if (doneParts.length > 0) {
        const built = buildGeneticJson({
          clientId: s.client_id, parts: doneParts, testDate: gTestDate,
        });
        await store.upsertOutput({
          subject_id: s.id, format_id: 'GeneticTestResultData',
          // **完成していないものを `generated` と名乗らない。**
          output_status: geneticComplete ? 'generated' : 'failed',
          // 日付が取れていなければ納品できないので error。
          // 読み切れていないページが残る間は warn (retry で解消する見込みがある)。
          validation_status: !gTestDate ? 'error' : incomplete > 0 ? 'warn' : 'ok',
          item_count: built.itemCount, test_date: gTestDate,
          generated_at: new Date().toISOString(),
          /*
           * **未完了の内訳を残す。** `incomplete` には pending / processing も入るので、
           * 失敗ページがあるときは `failed_pages` も併記して区別できるようにする
           * (「retry で直る失敗」と「まだ送っていないページ」は対処が違う)。
           */
          error_detail: !gTestDate
            ? 'test_date_unresolved'
            : incomplete > 0
              // **どのページが足りないかまで出す** — 「26 枚中 25 枚」だけでは
              // 現場が retry 後も同じページで止まっていることに気づけない。
              // 出すのはページ番号だけ (健康情報を error へ写さない・spec §16)。
              ? `missing_pages:${missingPages.join(',')}${failed > 0 ? ` failed_pages:${failed}` : ''}`
              : null,
        });
        /*
         * **納品物として数えるのは完成したときだけ** (§16-G)。
         *
         * 以前は成功ページが 1 枚でもあれば数えていたが、それだと
         * **読めなかったページを落としたまま「遺伝子検査の結果」として納品**される。
         * 未完了が残る間は `optional_present_but_not_ready:GeneticTestResultData` で
         * ready が止まり、retry で全ページ成功して初めて納品対象になる。
         * (`upsertOutput` は上で済ませてあるので、warn/error の記録は消えない。)
         */
        if (geneticComplete) formats.push('GeneticTestResultData');
      }
      await store.updateFile(gFile.id, {
        parse_status: doneParts.length > 0 && incomplete === 0
          ? 'done'
          : doneParts.length > 0 ? 'processing' : 'pending',
        page_count: gFile.page_count ?? pages.length,
      });
    }

    // ── ウェルネス年齢 (任意・**算出できなくても人物を failed にしない**) ──
    const wa = computeSubjectWellnessAge({
      clientId: s.client_id,
      markers,
      age: s.age,
      sex: s.sex === 'unknown' ? null : s.sex,
      testDate: hcTestDate,
    });
    if (wa.json && hcTestDate) {
      await store.upsertOutput({
        subject_id: s.id, format_id: 'Other' as FormatId, // HealthAgeData は format_id 列の許可集合外
        output_status: 'generated', validation_status: 'ok',
        item_count: 1, test_date: hcTestDate, generated_at: new Date().toISOString(),
        error_detail: `HealthAgeData:${wa.method}`,
      });
      formats.push('HealthAgeData');
    }

    const readiness = evaluateReadiness({
      producedFormats: formats,
      requiredFormats: batch.required_formats,
      optionalFormats: batch.optional_formats,
      // **Executive 案件は人物マスタへ紐付くまで ready にしない** (検査が揃っていても)。
      requireExecutiveLink: batch.require_executive_link,
      executiveSubjectId: s.executive_subject_id,
      classifications: own.map((f) => ({
        sourceKind: f.source_kind, formatId: f.classified_format_id,
        confidence: f.classification_confidence, reason: '',
      })),
    });
    await store.updateSubject(s.id, { status: readiness.ready ? 'ready' : 'needs_review' });
    produced.push({ subjectId: s.id, formats });
  }

  const allReady = produced.length > 0 && (await store.listSubjects(batchId)).every((s) => s.status === 'ready');
  await store.updateBatch(batchId, { status: allReady ? 'ready' : 'needs_review' });
  await store.logEvent({
    batch_id: batchId, event: 'parsed',
    actor_user_id: actor.userId, actor_masked: actor.masked, actor_sha256: actor.sha256,
    detail: { subjects: produced.length, pages: pageResults.length },
  });

  return { ok: true as const, pages: pageResults, subjects: produced, ready: allReady };
}

// ---------------------------------------------------------------------------
// ⑥ health-age/check : 人物ごとのウェルネス年齢を返す (保存はしない)
// ---------------------------------------------------------------------------

export async function healthAgeCheck(batchId: string) {
  const batch = await store.getBatch(batchId);
  if (!batch) return { ok: false as const, status: 404, error: 'batch_not_found' };

  // **ZIP を開かない** (Phase B2.1)。材料は分類時に保存済み。
  const subjects = await store.listSubjects(batchId);
  const files = await store.listFiles(batchId);
  const rows = await Promise.all(subjects.map(async (s) => {
    const own = files.filter((f) => f.subject_id === s.id);
    const hcFile = own.find((f) => f.classified_format_id === 'HealthCheckupData');
    /*
     * **ウェルネス年齢の材料も健診 PDF から採る** (spec §6.2)。
     * 納品 JSON を PDF から作るのに年齢だけ XLSX から作ると、
     * **画面の数字と納品物の materials が食い違う**。材料は 1 つに揃える。
     */
    const hcPages = hcFile ? await store.listPages(hcFile.id) : [];
    const hcParts = hcPages
      .filter((p) => p.status === 'done')
      .sort((a, b) => a.page_no - b.page_no)
      .map((p) => restoreHealthPage(p.parsed))
      .filter((x): x is HealthPageParsed => x !== null);
    const hcDates = Array.from(new Set(hcParts.map((p) => p.testDate).filter((d): d is string => !!d)));
    const testDate = hcDates.length === 1 ? hcDates[0] : null;
    const markers = hcParts.length > 0
      ? (normalizeMarkers(
          finalizeHealthCheckup({
            clientId: s.client_id,
            // key を組まないので日付は表示用。**納品には使わない。**
            testDate: testDate ?? '1970-01-01',
            parts: hcParts,
            includeRawMarkdown: false,
          }).measurements.map((m) => ({
            name: typeof m.name === 'string' ? m.name : '',
            value: m.value == null ? null : String(m.value),
          })) as never,
        ) as Record<string, number>)
      : {};
    const wa = computeSubjectWellnessAge({
      clientId: s.client_id,
      markers: markers as Record<string, number>,
      age: s.age,
      sex: s.sex === 'unknown' ? null : s.sex,
      testDate,
    });
    return {
      subject_id: s.id,
      subject_no: s.subject_no,
      method: wa.method,
      health_age: wa.result?.biological_age ?? null,
      chronological_age: wa.result?.chronological_age ?? null,
      delta: wa.result?.delta ?? null,
      missing_required: wa.result?.missing_full ?? [],
      missing_simple: wa.result?.missing_simple ?? [],
      message: wa.message,
    };
  }));
  return { ok: true as const, subjects: rows };
}

// ---------------------------------------------------------------------------
// ⑦⑧ finalize / export : 納品セットを組む → dry-run か 実書き込み
// ---------------------------------------------------------------------------

export interface AssemblyResult {
  ok: true;
  dryRun: boolean;
  files: { key: string; formatId: string; bytes: number; testDate: string; subjectNo: number }[];
  skipped: { subjectNo: number; reason: string }[];
  totalBytes: number;
  written?: { key: string; uri: string }[];
}

export async function assembleBatch(input: {
  batchId: string;
  dryRun: boolean;
  actor: Actor;
}): Promise<AssemblyResult | { ok: false; status: number; error: string; detail?: string }> {
  const cfg = getS3Config();
  if (!cfg) return { ok: false, status: 503, error: 's3_not_configured' };
  const batch = await store.getBatch(input.batchId);
  if (!batch) return { ok: false, status: 404, error: 'batch_not_found' };

  // **ZIP を開かない** (Phase B2.1)。納品 JSON の材料は分類時に保存済み。
  const subjects = await store.listSubjects(input.batchId);
  const files = await store.listFiles(input.batchId);
  const delivery: DeliveryFile[] = [];
  const meta: { key: string; subjectNo: number }[] = [];
  const skipped: { subjectNo: number; reason: string }[] = [];

  for (const s of subjects) {
    const own = files.filter((f) => f.subject_id === s.id);
    const formats: string[] = [];
    const built: DeliveryFile[] = [];
    let hcTestDate: string | null = null;
    let markers: Record<string, number> = {};

    /*
     * 健診 (spec §6.2 / §6.5)。**process 経路と同じ規則**で組む
     * — 納品する JSON と画面で確認した JSON が別物になってはいけない。
     * 材料は健診 PDF のページ解析結果。**XLSX からは作らない** (v1.1 で本経路から外した)。
     */
    const hcFile = own.find((f) => f.classified_format_id === 'HealthCheckupData');
    if (hcFile) {
      const hcPages = await store.listPages(hcFile.id);
      const doneHc = hcPages.filter((p) => p.status === 'done');
      const expectedHc = hcFile.page_count ?? 0;
      const seenHc = new Set(doneHc.map((p) => p.page_no));
      const hcComplete = expectedHc > 0
        && Array.from({ length: expectedHc }, (_, i) => i + 1).every((n) => seenHc.has(n));
      const hcParts = doneHc
        .slice()
        .sort((a, b) => a.page_no - b.page_no)
        .map((p) => restoreHealthPage(p.parsed))
        .filter((x): x is HealthPageParsed => x !== null);
      const hcDates = Array.from(new Set(hcParts.map((p) => p.testDate).filter((d): d is string => !!d)));
      const hcDate = hcDates.length === 1 ? hcDates[0] : null;
      // **欠けたページ・未確定の日付があれば組まない** (欠けたまま納品すると受け取った側は気づけない)。
      if (hcParts.length > 0 && hcComplete && hcDate) {
        const fin = finalizeHealthCheckup({
          clientId: s.client_id,
          testDate: hcDate,
          parts: hcParts,
          note: '臨時診断バッチ (健診PDF・既存 scanImageToParsed + 本番 finalize core)。',
          includeRawMarkdown: false,
        });
        hcTestDate = hcDate;
        markers = normalizeMarkers(
          fin.measurements.map((m) => ({
            name: typeof m.name === 'string' ? m.name : '',
            value: m.value == null ? null : String(m.value),
          })) as never,
        ) as Record<string, number>;
        built.push(toDeliveryFile(cfg.prefix, s.client_id, 'HealthCheckupData', hcDate, fin.json));
        formats.push('HealthCheckupData');
      }
    }

    // 問診
    const qFile = own.find((f) => f.classified_format_id === 'LifestyleQuestionnaireData');
    const q = qFile ? restoreQuestionnaire(qFile.normalized_payload) : null;
    if (q && questionnaireIsUsable(q)) {
      const b = buildQuestionnaireJson({
        clientId: s.client_id, diagnosticId: s.diagnostic_id ?? s.client_id, normalized: q,
      });
      built.push(toDeliveryFile(cfg.prefix, s.client_id, 'LifestyleQuestionnaireData', b.testDate, b.json));
      formats.push('LifestyleQuestionnaireData');
    }

    // 遺伝子
    const gFile = own.find((f) => f.classified_format_id === 'GeneticTestResultData');
    if (gFile) {
      const pages = await store.listPages(gFile.id);
      const parts: GeneticPagePart[] = pages
        // **対象外ページを納品へ混ぜない** (spec §8.5)。process 経路と同じ規則。
        .filter((p) => p.status === 'done' && isGenoplanV1RequiredPage(p.page_no))
        .map((p) => {
          const parsed = (p.parsed ?? {}) as { section?: string | null; items?: unknown[] };
          return { page: p.page_no, section: parsed.section ?? null, items: parsed.items ?? [] };
        });
      /*
       * **遺伝子の日付は遺伝子ファイル自身のもの** (§10)。
       * ここは納品 key を組む場所なので、健診日を流用すると
       * `date/{YYYY_MM_DD}/GeneticTestResultData_date_{YYYY_MM_DD}_...` が
       * まるごと誤った日付で S3 に置かれる。**取れないなら納品しない。**
       */
      const gTestDate = gFile.test_date ?? null;
      /*
       * **必要な p10〜35 が 1 枚でも欠けていれば組まない** (process 経路と同じ規則)。
       * 成功ページだけで JSON を作ると、**落ちたページの中身が無いまま
       * 「遺伝子検査の結果」として納品される** (受け取った側は欠けに気づけない)。
       * ここで組まなければ readiness が
       * `optional_present_but_not_ready:GeneticTestResultData` で止まり、
       * retry で全ページ成功してから納品される。
       */
      const gIncomplete = missingGenoplanV1Pages(
        pages.filter((p) => p.status === 'done').map((p) => p.page_no),
      ).length;
      if (parts.length > 0 && gTestDate && gIncomplete === 0) {
        const b = buildGeneticJson({ clientId: s.client_id, parts, testDate: gTestDate });
        built.push(toDeliveryFile(cfg.prefix, s.client_id, 'GeneticTestResultData', gTestDate, b.json));
        formats.push('GeneticTestResultData');
      }
    }

    // ウェルネス年齢 (任意)
    const wa = computeSubjectWellnessAge({
      clientId: s.client_id, markers, age: s.age,
      sex: s.sex === 'unknown' ? null : s.sex, testDate: hcTestDate,
    });
    if (wa.json && hcTestDate) {
      built.push(toDeliveryFile(cfg.prefix, s.client_id, 'HealthAgeData', hcTestDate, wa.json));
      formats.push('HealthAgeData');
    }

    const readiness = evaluateReadiness({
      producedFormats: formats,
      requiredFormats: batch.required_formats,
      optionalFormats: batch.optional_formats,
      /*
       * **Executive 未割当は必ず skipped。**
       * skipped が 1 件でもあれば Phase A の write-guard がバッチ全体を止めるので、
       * 1 人でも紐付いていなければ S3 への PUT は 0 回になる。
       */
      requireExecutiveLink: batch.require_executive_link,
      executiveSubjectId: s.executive_subject_id,
      classifications: own.map((f) => ({
        sourceKind: f.source_kind, formatId: f.classified_format_id,
        confidence: f.classification_confidence, reason: '',
      })),
    });
    if (!readiness.ready) {
      skipped.push({ subjectNo: s.subject_no, reason: readiness.reasons.join(',') || 'not_ready' });
      continue;
    }
    for (const f of built) {
      delivery.push(f);
      meta.push({ key: f.key, subjectNo: s.subject_no });
    }
  }

  const totalBytes = delivery.reduce((a, f) => a + f.bytes, 0);
  const listed = delivery.map((f) => ({
    key: f.key,
    formatId: f.formatId,
    bytes: f.bytes,
    testDate: f.testDate,
    subjectNo: meta.find((m) => m.key === f.key)?.subjectNo ?? 0,
  }));

  if (input.dryRun) {
    return { ok: true, dryRun: true, files: listed, skipped, totalBytes };
  }

  /*
   * **実書き込み。** Production の Elith 納品領域へは、この呼び出しを
   * 発注者が明示的に許可したときだけ通す (§24.5 / §20)。
   *
   * **UI のチェックボックスだけに安全性を依存させない** (2026-09-11・Phase A)。
   * サーバ側で ①env 2 本のゲート ②key の allowlist ③部分納品の禁止 ④既存 key の
   * 事前確認 を**全て通してからでないと status を進めない** — 安全検査で弾かれただけなのに
   * `exporting` / `completed` になると、書いていないのに「出した」ことになってしまう。
   */
  /*
   * **弾いたことを監査イベントにはしない (Phase A)。** `EventName` は `store.ts` の型で、
   * 新しい名前を足すと DB 表の値域まで触ることになる。Phase A の allowlist の外なので
   * 広げない。呼び出し側には `error` / `detail` を明示して返す。
   */
  const gate = checkWriteGate({ delivery, skipped });
  if (!gate.ok) {
    return { ok: false, status: gate.status, error: gate.error, detail: gate.detail };
  }

  const pre = await preflightNoExistingObjects(delivery.map((f) => f.key), gate.cfg);
  if (!pre.ok) {
    return { ok: false, status: pre.status, error: pre.error, detail: pre.detail };
  }

  // ここから先だけが実書き込み。**create-only** (既存 key は上書きしない)。
  await store.updateBatch(input.batchId, { status: 'exporting' });
  let written: { key: string; bytes: number; uri: string }[];
  try {
    written = await putDeliveryFilesCreateOnly(
      delivery.map((f) => ({ key: f.key, body: f.body, bytes: f.bytes })),
      gate.cfg,
    );
  } catch (e) {
    /*
     * 途中で失敗しても **completed にしない**。Phase A では複雑な巻き戻しを作らず、
     * failed として明示する。再実行しても create-only 制約があるので、
     * 既に書けた分を上書きすることはない。
     */
    const detail = e instanceof Error ? e.message : String(e);
    await store.updateBatch(input.batchId, { status: 'failed', last_error: detail });
    return { ok: false, status: 502, error: 'export_failed', detail };
  }
  for (const s of subjects) {
    const own = listed.filter((l) => l.subjectNo === s.subject_no);
    for (const o of own) {
      await store.upsertOutput({
        subject_id: s.id,
        format_id: (o.formatId === 'HealthAgeData' ? 'Other' : o.formatId) as FormatId,
        output_status: 'exported', validation_status: 'ok',
        json_storage_key: o.key, test_date: o.testDate,
        generated_at: new Date().toISOString(),
      });
    }
  }
  await store.updateBatch(input.batchId, { status: 'completed', exported_at: new Date().toISOString() });
  await store.logEvent({
    batch_id: input.batchId, event: 'exported',
    actor_user_id: input.actor.userId, actor_masked: input.actor.masked, actor_sha256: input.actor.sha256,
    detail: { files: listed.length, skipped: skipped.length, bytes: totalBytes },
  });

  return {
    ok: true, dryRun: false, files: listed, skipped, totalBytes,
    written: written.map((w) => ({ key: w.key, uri: w.uri })),
  };
}

// ---------------------------------------------------------------------------
// ⑨ retry : 失敗したページ・ファイルを作り直す
// ---------------------------------------------------------------------------

export async function retryBatch(batchId: string, actor: Actor) {
  const batch = await store.getBatch(batchId);
  if (!batch) return { ok: false as const, status: 404, error: 'batch_not_found' };
  const files = await store.listFiles(batchId);
  const targets: { fileId: string; pages: number[] }[] = [];
  for (const f of files) {
    if (f.classified_format_id !== 'GeneticTestResultData') continue;
    const pages = await store.listPages(f.id);
    /*
     * **`failed` だけでなく `pending` / `processing` も対象**にする
     * (途中で止まった PDF は失敗 0 件のまま残る)。
     *
     * **行が無いページを推測して作らない。** ここに出せるのは実在の行だけで、
     * 通信が切れて **行すら作られていないページ**は分からない。
     * 実際のページ数はブラウザ側が PDF を開き直して数える (pdf.js) ので、
     * この一覧は「サーバから見た未完了」の目安であって、再実行の範囲ではない。
     */
    const unfinished = pages.filter((p) => p.status !== 'done').map((p) => p.page_no);
    if (unfinished.length) targets.push({ fileId: f.id, pages: unfinished });
  }
  for (const f of files) {
    if (f.parse_status === 'failed' && f.classified_format_id !== 'GeneticTestResultData') {
      await store.updateFile(f.id, { parse_status: 'pending', error_detail: null });
    }
  }
  await store.updateBatch(batchId, { status: 'processing', last_error: null });
  await store.logEvent({
    batch_id: batchId, event: 'retry',
    actor_user_id: actor.userId, actor_masked: actor.masked, actor_sha256: actor.sha256,
    detail: { genetic_files: targets.length, pages: targets.reduce((a, t) => a + t.pages.length, 0) },
  });
  return { ok: true as const, targets };
}

export async function listBatches() {
  return store.listBatches();
}
