// src/lib/transcos-emergency/seed.ts
// トランスコスモス10名 緊急専用 v2.0 — **manifest から run を起こす** (指示書 §4 / §14)。
//
// 【汎用 classifier を呼ばない】
// 役割・人物・検査日の割り当ては**全部 manifest が決めている**。
// ここがやるのは「manifest の表を DB の行にする」ことだけで、
// PDF 語彙ヒットもファイル名の意味推測も first match も fuzzy 一致も使わない (§4 / §26)。
//
// 【既存テーブルは storage としてだけ借りる】(§14)
// `ad_hoc_diagnosis_{batches,subjects,files,pages,outputs,events}` に書くが、
// **generic な required_formats を business truth にしない** — 納品してよいかは
// `deliver.ts` の専用ゲートが決める。DB migration は足さない。

import { randomUUID } from 'node:crypto';
import * as store from '../ad-hoc-diagnosis/store';
import { buildEntryPayload } from '../ad-hoc-diagnosis/normalized-payload';
import { readWorkbookSheets, pickHealthCheckupSheet } from '../ad-hoc-diagnosis/health-checkup-xlsx';
import { normalizeExternalFormSheet } from '../ad-hoc-diagnosis/questionnaire';
import type { OpenedArchive } from '../ad-hoc-diagnosis/archive';
import type { S3Config } from '../s3';
import {
  TRANSCOS_MANIFEST, TRANSCOS_SUBJECTS, TRANSCOS_ZIP, TRANSCOS_RUN_KIND,
  subjectOfEntry, zeroBasedIndex,
  type ManifestEntry,
} from './manifest';

/** role → 納品 format。**参照資料と一時ファイルは format を持たない。** */
function formatOf(m: ManifestEntry): 'HealthCheckupData' | 'GeneticTestResultData' | 'LifestyleQuestionnaireData' | null {
  switch (m.role) {
    case 'HEALTH_PDF': return 'HealthCheckupData';
    case 'GENOPLAN_PDF': return 'GeneticTestResultData';
    case 'QUESTIONNAIRE_XLSX':
    case 'QUESTIONNAIRE_PDF_MANUAL': return 'LifestyleQuestionnaireData';
    // **補助 XLSX は納品 format を持たない** — 生成元ではなく照合専用 (§10)
    default: return null;
  }
}

/** 納品に使うファイルか (参照資料・一時ファイル・補助 XLSX は `batch_reference`)。 */
function sourceKindOf(m: ManifestEntry): 'person_file' | 'batch_reference' {
  return formatOf(m) === null ? 'batch_reference' : 'person_file';
}

function mimeOf(path: string): string {
  if (path.endsWith('.pdf')) return 'application/pdf';
  if (path.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (path.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return 'application/octet-stream';
}

/**
 * 表示名。**ZIP 内のパスも氏名も DB へ書かない** (§22 / 既存 §8.1)。
 * 役割と entry 番号だけで人が追えるようにする。
 */
function displayNameOf(m: ManifestEntry): string {
  return `${m.role}_entry${String(m.entry).padStart(2, '0')}${m.path.slice(m.path.lastIndexOf('.'))}`;
}

export interface SeedResult {
  batchId: string;
  subjects: number;
  files: number;
  /** 問診 XLSX のうち、完了時刻から test_date を確定できた件数。 */
  questionnaireDated: number;
  /** 人物ごとの要確認 (この時点で分かるものだけ)。 */
  review: { subjectNo: number; reason: string }[];
}

/**
 * run を起こす。**Preflight が PASS したあとにだけ呼ぶこと。**
 *
 * 冪等: 既に同じ batchId の行があれば `upsertFileByEntryIndex` が上書きするので、
 * 通信断のあとに呼び直しても人物・ページ・Executive の紐付けは消えない。
 */
export async function seedRun(input: {
  batchId: string;
  archive: OpenedArchive;
  cfg: S3Config;
  actor: { userId: string | null; masked: string | null };
}): Promise<SeedResult> {
  const { batchId, archive, cfg } = input;

  // ── 人物 10 名。**subject_no は manifest 固定** (ファイル名の番号は使わない) ──
  await store.ensureSubjectPlaceholders(
    batchId,
    TRANSCOS_SUBJECTS.map((s) => s.subjectNo),
    () => ({
      client_id: randomUUID(),
      diagnostic_id: randomUUID(),
      // 身元は manifest が決めている。**推測していないので `confirmed`。**
      identity_status: 'confirmed' as const,
      identity_reason: TRANSCOS_RUN_KIND,
    }),
  );
  const subjects = await store.listSubjects(batchId);
  const subjectIdOf = new Map(subjects.map((s) => [s.subject_no, s.id]));
  for (const s of subjects) {
    // 身元は manifest が決めている。**推測していないので `confirmed`。**
    if (s.identity_status !== 'confirmed') {
      await store.updateSubject(s.id, {
        identity_status: 'confirmed',
        identity_reason: TRANSCOS_RUN_KIND,
      });
    }
  }

  const review: { subjectNo: number; reason: string }[] = [];
  let questionnaireDated = 0;
  let files = 0;

  for (const m of TRANSCOS_MANIFEST) {
    const sub = subjectOfEntry(m.entry);
    const subjectId = sub ? subjectIdOf.get(sub.subjectNo) ?? null : null;

    let testDate: string | null = null;
    let payload: unknown = null;
    let parseStatus: store.ParseStatus = 'pending';
    let errorDetail: string | null = null;

    if (m.role === 'QUESTIONNAIRE_XLSX') {
      // **既存の専用 contract を通す。** generic fuzzy mapper を使わない (§11)。
      const bytes = await archive.readByIndex(zeroBasedIndex(m.entry));
      const sheets = await readWorkbookSheets(bytes);
      const rows = sheets[0]?.data ?? [];
      const sheet = normalizeExternalFormSheet(rows as never);
      /*
       * **回答行がちょうど 1 行でなければ採らない。**
       * このファイルが 1 人ぶんなのか 8 人ぶんなのかを**推測で決めない** —
       * 複数行から 1 行選ぶ規則は指示書に無いので、first match を使えば
       * それは人物取り違えそのもの (§26-5)。その人物だけ要確認で止める。
       */
      if (sheet.people.length !== 1) {
        parseStatus = 'failed';
        errorDetail = `questionnaire_rows:${sheet.people.length}`;
        if (sub) review.push({ subjectNo: sub.subjectNo, reason: errorDetail });
      } else {
        const q = sheet.people[0];
        payload = buildEntryPayload({ questionnaire: q });
        // **完了時刻から。today fallback は使わない** (§11)。
        testDate = q.completedAt.status === 'resolved' ? (q.completedAt.date ?? null) : null;
        if (testDate) questionnaireDated += 1;
        else if (sub) review.push({ subjectNo: sub.subjectNo, reason: 'questionnaire_completed_at_unresolved' });
        parseStatus = 'done';
        if (sub && q.schema && !q.schema.ok) {
          review.push({ subjectNo: sub.subjectNo, reason: 'questionnaire_schema_mismatch' });
          errorDetail = 'schema_mismatch';
        }
      }
    } else if (m.role === 'HEALTH_SUPPORT_XLSX') {
      /*
       * **照合専用**。ここで読んだ値から HealthCheckupData を作らない (§10 / §26-11)。
       * `normalized_payload` に置くのは cross-check がもう一度 ZIP を開かないため。
       */
      const bytes = await archive.readByIndex(zeroBasedIndex(m.entry));
      const sheets = await readWorkbookSheets(bytes);
      const sheet = pickHealthCheckupSheet(sheets);
      // 形は既存の payload と同じ (**PII ゲートを同じ口で通す**)。
      // この行は `classified_format_id = null` なので、
      // **本番の組み立て (`processBatch`) から見えない** = JSON の生成元にならない。
      payload = buildEntryPayload({ healthCheckup: sheet });
      parseStatus = 'done';
    } else if (m.role === 'GENOPLAN_PDF') {
      // **§7 の固定メタデータ。p2 を Gemini へ送らない。**
      testDate = sub?.genoplanTestDate ?? null;
    } else if (m.role === 'QUESTIONNAIRE_PDF_MANUAL') {
      // **自動で読まない。** 人が原本を見て入れるまで未確定 (§12)。
      parseStatus = 'skipped';
      errorDetail = 'manual_entry_required';
    }
    // HEALTH_PDF は seed では何もしない — **ページ画像を本番 scan へ通してから**決まる (§10)。

    await store.upsertFileByEntryIndex(batchId, zeroBasedIndex(m.entry), {
      subject_id: subjectId,
      storage_key: `${cfg.prefix}ad-hoc-uploads/${batchId}/files/${m.sha256}${m.path.slice(m.path.lastIndexOf('.'))}`,
      display_name: displayNameOf(m),
      sha256: m.sha256,
      size_bytes: m.bytes,
      mime_type: mimeOf(m.path),
      source_kind: sourceKindOf(m),
      classified_format_id: formatOf(m),
      // **推測していない**ので confirmed。manifest が決めた値をそのまま書いている。
      classification_confidence: 'confirmed',
      test_date: testDate,
      parse_status: parseStatus,
      page_count: m.pages ?? null,
      error_detail: errorDetail,
      archive_entry_index: zeroBasedIndex(m.entry),
      normalized_payload: payload,
    });
    files += 1;
  }

  await store.logEvent({
    batch_id: batchId,
    event: 'classified',
    detail: {
      run_kind: TRANSCOS_RUN_KIND,
      zip_sha256: TRANSCOS_ZIP.sha256,
      files,
      subjects: TRANSCOS_SUBJECTS.length,
      questionnaire_dated: questionnaireDated,
      review_count: review.length,
    },
  });

  return {
    batchId,
    subjects: TRANSCOS_SUBJECTS.length,
    files,
    questionnaireDated,
    review,
  };
}

/** 新しい run を作る (ZIP は既存のアップロードを使い回す・§21)。 */
export async function createRun(input: {
  sourceKey: string;
  actor: { userId: string | null; masked: string | null };
}): Promise<store.BatchRow> {
  const id = randomUUID();
  return store.createBatch({
    id,
    /*
     * **タイトルに日付を入れない。** この run の時刻は `created_at` が持っている。
     * ここで `new Date()` を使うと、「今日」を混ぜる癖がコードに残る (§26-7)。
     */
    title: TRANSCOS_RUN_KIND,
    sourceSha256: TRANSCOS_ZIP.sha256,
    declaredSourceSize: TRANSCOS_ZIP.bytes,
    sourceKey: input.sourceKey,
    // **generic の required_formats を business truth にしない** (§14)。
    // 納品してよいかは `deliver.ts` の専用ゲートが決める。ここは表示のための写し。
    requiredFormats: ['HealthCheckupData', 'LifestyleQuestionnaireData', 'GeneticTestResultData'],
    optionalFormats: [],
    requireExecutiveLink: true,
    retainOriginals: false,
    createdByUserId: input.actor.userId,
    createdByMasked: input.actor.masked,
  });
}
