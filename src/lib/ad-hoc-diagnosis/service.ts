// src/lib/ad-hoc-diagnosis/service.ts
// 臨時診断バッチ: API から呼ぶ「動詞」。DB (store) と解析 (pipeline) を繋ぐ。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §17 / §22
//
// **API ルートはここを呼ぶだけにする。** ルートに手続きを書かない
// (同じ処理を 2 つの口から呼べるようにするため。§22「API 同士を HTTP で呼ばない」)。

import { getS3Config } from '../s3';
import { checkWriteGate, preflightNoExistingObjects, putDeliveryFilesCreateOnly } from './write-guard';
import { refreshConfig } from '../app-config';
import { scanGeneticPage } from '../elith-genetic';
import * as store from './store';
import { adHocZipKey } from './keys';
import { headAdHocZip, deleteAdHocZip, createAdHocUploadTicket } from './ticket';
import { openArchiveFromS3 } from './archive';
import { matchByFingerprint, shortFingerprint } from './fingerprint';
import { questionnaireSummary, questionnaireIsUsable } from './questionnaire';
import {
  AD_HOC_OPTIONAL_FORMATS, AD_HOC_REQUIRED_FORMATS, analyzeOpened, buildGeneticJson,
  buildHealthCheckupJson, buildQuestionnaireJson, computeSubjectWellnessAge, evaluateReadiness,
  newClientId, newDiagnosticId, toDeliveryFile,
  type AnalyzedFile, type AnalyzedSubject, type DeliveryFile, type GeneticPagePart,
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

function fileRowOf(
  f: AnalyzedFile,
  subjectId: string | null,
  prefix: string,
  batchId: string,
): Parameters<typeof store.replaceFiles>[1][number] {
  const mime =
    f.ext === '.pdf' ? 'application/pdf'
    : f.ext === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : f.ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : f.ext === '.csv' ? 'text/csv'
    : null;
  return {
    subject_id: subjectId,
    // **S3 key に元ファイル名を入れない** (§8.1)。ZIP 内の位置は sha256 で追える。
    storage_key: `${prefix}ad-hoc-uploads/${batchId}/files/${f.sha256}${f.ext}`,
    display_name: f.displayName,
    sha256: f.sha256,
    size_bytes: f.sizeBytes,
    mime_type: mime,
    source_kind: f.classification.sourceKind,
    classified_format_id: f.classification.formatId,
    classification_confidence: f.classification.confidence,
    test_date: f.testDate,
    parse_status: f.error ? 'failed' : 'pending',
    page_count: f.pageCount ?? null,
    error_detail: f.error ?? f.classification.reason,
  };
}

// ---------------------------------------------------------------------------
// ③ status : 画面が見る状態
// ---------------------------------------------------------------------------

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
    subjects: subjects.map((s) => {
      const own = files.filter((f) => f.subject_id === s.id);
      const produced = (outputsBySubject.get(s.id) ?? []).map((o) => o.format_id);
      const readiness = evaluateReadiness({
        producedFormats: produced,
        requiredFormats: batch.required_formats,
        optionalFormats: batch.optional_formats,
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

  const updated = await store.updateSubject(input.subjectId, {
    executive_subject_id: input.executiveSubjectId,
  });
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

  // 人物の識別も confirmed へ寄せる (管理者が画面で見たあと)
  const subjects = await store.listSubjects(input.batchId);
  for (const s of subjects) {
    if (s.identity_status === 'needs_review') {
      await store.updateSubject(s.id, { identity_status: 'confirmed', identity_reason: 'admin_confirmed' });
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
  /** 失敗したページだけを対象にする。 */
  retryFailedOnly?: boolean;
}

export async function processBatch(batchId: string, actor: Actor, options: ProcessOptions = {}) {
  await refreshConfig();
  const cfg = getS3Config();
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

  // ZIP を開き直して健診・問診を解析する (中身は DB に持たないので毎回読む)
  const head = await headAdHocZip(batch.source_key, cfg);
  const analysisByFingerprint = new Map<string, AnalyzedSubject>();
  if (head.ok && cfg) {
    const archive = await openArchiveFromS3({ key: batch.source_key, knownSize: head.size, cfg });
    try {
      const a = await analyzeOpened(archive);
      for (const s of a.subjects) if (s.fingerprint) analysisByFingerprint.set(s.fingerprint, s);
    } finally {
      await archive.close();
    }
  }

  const subjects = await store.listSubjects(batchId);
  const files = await store.listFiles(batchId);
  const produced: { subjectId: string; formats: string[] }[] = [];

  for (const s of subjects) {
    const analyzed = s.subject_fp ? analysisByFingerprint.get(s.subject_fp) : undefined;
    const own = files.filter((f) => f.subject_id === s.id);
    const formats: string[] = [];
    let markers: Record<string, number> = {};
    let hcTestDate: string | null = null;

    // ── 健診 ──
    const hcFile = own.find((f) => f.classified_format_id === 'HealthCheckupData');
    const hcAnalyzed = analyzed?.files.find((f) => f.sha256 === hcFile?.sha256);
    if (hcFile && hcAnalyzed?.healthCheckup) {
      const built = buildHealthCheckupJson({ clientId: s.client_id, sheet: hcAnalyzed.healthCheckup });
      hcTestDate = built.testDate;
      markers = built.markers as Record<string, number>;
      if (built.testDate) {
        await store.upsertOutput({
          subject_id: s.id, format_id: 'HealthCheckupData',
          output_status: 'generated', validation_status: built.itemCount > 0 ? 'ok' : 'warn',
          item_count: built.itemCount, test_date: built.testDate,
          generated_at: new Date().toISOString(),
        });
        formats.push('HealthCheckupData');
      } else {
        // **test_date が確定しない人物は納品しない** (§5.3.8.1)
        await store.upsertOutput({
          subject_id: s.id, format_id: 'HealthCheckupData',
          output_status: 'failed', validation_status: 'error',
          item_count: built.itemCount, error_detail: 'test_date_unresolved',
        });
      }
      await store.updateFile(hcFile.id, { parse_status: built.testDate ? 'done' : 'failed', test_date: built.testDate });
    }

    // ── 問診 ──
    const qFile = own.find((f) => f.classified_format_id === 'LifestyleQuestionnaireData');
    const qAnalyzed = analyzed?.files.find((f) => f.sha256 === qFile?.sha256);
    if (qFile && qAnalyzed?.questionnaire) {
      const q = qAnalyzed.questionnaire;
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
          validation_status: q.unmapped.length > 0 ? 'warn' : 'ok',
          item_count: built.answerCount, test_date: built.testDate,
          generated_at: new Date().toISOString(),
          error_detail: q.unmapped.length ? `unmapped:${q.unmapped.length}` : null,
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
        .filter((p) => p.status === 'done')
        .map((p) => {
          const parsed = (p.parsed ?? {}) as { section?: string | null; items?: unknown[] };
          return { page: p.page_no, section: parsed.section ?? null, items: parsed.items ?? [] };
        });
      const failed = pages.filter((p) => p.status === 'failed').length;
      /*
       * **読み切れていないページが 1 枚でもあるか** (failed / pending / processing)。
       * `failed` だけを見ると、途中で止まった (pending のまま) PDF が
       * 「失敗 0 件」として通ってしまう。
       *
       * **`page_count` は使わない** — あれは `countPdfPages` の正規表現による概算で、
       * 外すと**操作で直せない状態で納品が永久に止まる**。ここで見るのは実在の行だけ。
       */
      const incomplete = pages.filter((p) => p.status !== 'done').length;
      /*
       * **遺伝子の日付は遺伝子ファイル自身のもの** (§10・Phase B1 で是正)。
       * 以前は健診の `hcTestDate` を流用していたが、健診日と採取日は別物で、
       * **納品 key の日付フォルダとファイル名がそのまま間違う** (Elith 側では
       * 「その日に遺伝子検査をした」ようにしか見えない)。
       * 取れないなら **null のまま**。今日でも健診日でも bundle_date でも埋めない。
       */
      const gTestDate = gFile.test_date ?? null;
      if (doneParts.length > 0) {
        const built = buildGeneticJson({
          clientId: s.client_id, parts: doneParts, testDate: gTestDate,
        });
        await store.upsertOutput({
          subject_id: s.id, format_id: 'GeneticTestResultData',
          output_status: 'generated',
          // **失敗ページが残っていれば warn。** 黙って完成扱いにしない。
          // 日付が取れていなければ納品できないので error として可視化する。
          validation_status: !gTestDate ? 'error' : failed > 0 ? 'warn' : 'ok',
          item_count: built.itemCount, test_date: gTestDate,
          generated_at: new Date().toISOString(),
          error_detail: !gTestDate
            ? 'test_date_unresolved'
            : failed > 0 ? `failed_pages:${failed}` : null,
        });
        /*
         * **納品物として数えるのは「日付があり・失敗ページが 0」のときだけ** (§16-G)。
         *
         * 以前は成功ページが 1 枚でもあれば数えていたが、それだと
         * **読めなかったページを落としたまま「遺伝子検査の結果」として納品**される。
         * 失敗が残る間は `optional_present_but_not_ready:GeneticTestResultData` で
         * ready が止まり、retry で全ページ成功して初めて納品対象になる。
         * (`upsertOutput` は上で済ませてあるので、warn/error の記録は消えない。)
         */
        if (gTestDate && incomplete === 0) formats.push('GeneticTestResultData');
      }
      await store.updateFile(gFile.id, {
        parse_status: doneParts.length > 0 && failed === 0 ? 'done' : doneParts.length > 0 ? 'processing' : 'pending',
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
  const cfg = getS3Config();
  const batch = await store.getBatch(batchId);
  if (!batch) return { ok: false as const, status: 404, error: 'batch_not_found' };

  const head = await headAdHocZip(batch.source_key, cfg);
  if (!head.ok || !cfg) return { ok: false as const, status: head.ok ? 503 : head.status, error: 'zip_unavailable' };

  const archive = await openArchiveFromS3({ key: batch.source_key, knownSize: head.size, cfg });
  let byFp = new Map<string, AnalyzedSubject>();
  try {
    const a = await analyzeOpened(archive);
    byFp = new Map(a.subjects.filter((s) => s.fingerprint).map((s) => [s.fingerprint!, s]));
  } finally {
    await archive.close();
  }

  const subjects = await store.listSubjects(batchId);
  const rows = subjects.map((s) => {
    const analyzed = s.subject_fp ? byFp.get(s.subject_fp) : undefined;
    const hc = analyzed?.files.find((f) => f.healthCheckup)?.healthCheckup;
    const markers = hc ? buildHealthCheckupJson({ clientId: s.client_id, sheet: hc }).markers : {};
    const testDate = hc?.testDate.status === 'resolved' ? hc.testDate.date : null;
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
  });
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

  const head = await headAdHocZip(batch.source_key, cfg);
  if (!head.ok) return { ok: false, status: head.status, error: head.error, detail: head.detail };

  const archive = await openArchiveFromS3({ key: batch.source_key, knownSize: head.size, cfg });
  let byFp = new Map<string, AnalyzedSubject>();
  try {
    const a = await analyzeOpened(archive);
    byFp = new Map(a.subjects.filter((s) => s.fingerprint).map((s) => [s.fingerprint!, s]));
  } finally {
    await archive.close();
  }

  const subjects = await store.listSubjects(input.batchId);
  const files = await store.listFiles(input.batchId);
  const delivery: DeliveryFile[] = [];
  const meta: { key: string; subjectNo: number }[] = [];
  const skipped: { subjectNo: number; reason: string }[] = [];

  for (const s of subjects) {
    const analyzed = s.subject_fp ? byFp.get(s.subject_fp) : undefined;
    const own = files.filter((f) => f.subject_id === s.id);
    const formats: string[] = [];
    const built: DeliveryFile[] = [];
    let hcTestDate: string | null = null;
    let markers: Record<string, number> = {};

    // 健診
    const hc = analyzed?.files.find((f) => f.healthCheckup)?.healthCheckup;
    if (hc) {
      const b = buildHealthCheckupJson({ clientId: s.client_id, sheet: hc });
      hcTestDate = b.testDate;
      markers = b.markers as Record<string, number>;
      if (b.testDate) {
        built.push(toDeliveryFile(cfg.prefix, s.client_id, 'HealthCheckupData', b.testDate, b.json));
        formats.push('HealthCheckupData');
      }
    }

    // 問診
    const q = analyzed?.files.find((f) => f.questionnaire)?.questionnaire;
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
        .filter((p) => p.status === 'done')
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
       * **読み切れていないページがあれば組まない** (process 経路と同じ規則)。
       * 成功ページだけで JSON を作ると、**落ちたページの中身が無いまま
       * 「遺伝子検査の結果」として納品される** (受け取った側は欠けに気づけない)。
       * ここで組まなければ readiness が
       * `optional_present_but_not_ready:GeneticTestResultData` で止まり、
       * retry で全ページ成功してから納品される。
       */
      const gIncomplete = pages.filter((p) => p.status !== 'done').length;
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
    const failed = pages.filter((p) => p.status === 'failed').map((p) => p.page_no);
    if (failed.length) targets.push({ fileId: f.id, pages: failed });
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
