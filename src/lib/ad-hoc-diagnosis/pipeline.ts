// src/lib/ad-hoc-diagnosis/pipeline.ts
// 臨時診断バッチ: ZIP 解析 → 人物分離 → 分類 → 解析 → ウェルネス年齢 → Elith JSON。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md
//
// **既存の変換・生成関数を再利用する。新しい納品 JSON 生成を作らない。**
//   健診   … `sanitizeMeasurementsForDelivery` (elith-export.ts)
//   遺伝子 … `scanGeneticPage` (elith-genetic.ts) + part/finalize と同じ集約
//   問診   … `buildElithInterviewJson` (interview-export.ts)
//   年齢   … `computeWellnessAge` (wellness-age.ts)
//
// **HTTP API 同士を内部から呼ばない** (§22)。処理はこの lib に集約し、API は薄く保つ。

import { randomUUID } from 'node:crypto';
import {
  openArchiveFromS3, magicMatchesExtension, type ArchiveEntry, type OpenedArchive,
} from './archive';
import {
  classifyFile, commonRootPrefix, displayNameFor, personFolderOf, subjectIsAutoReady,
  type Classification, type FormatId,
} from './classify';
import { sha256Hex, subjectFingerprint } from './fingerprint';
import {
  isBlankCell, pickHealthCheckupSheet, readWorkbookSheets,
  type CellValue, type HealthCheckupSheet,
} from './health-checkup-xlsx';
import {
  normalizeExternalFormSheet, normalizeQuestionnairePdf, questionnaireIsUsable,
  type QuestionnaireNormalized,
} from './questionnaire';
import { normalizeMarkers, type HealthAgeMarkers, type RawItem } from '../health-age';
import { computeWellnessAge, type WellnessAgeResult } from '../wellness-age';
import { sanitizeMeasurementsForDelivery } from '../elith-export';
import { buildElithInterviewJson } from '../interview-export';
import { ELITH_HANDOFF_SCHEMA_VERSION } from '../elith-export';
import type { AnswerValue } from '../../scripts/chat/interview-script';

// ---------------------------------------------------------------------------
// 案件別の必須 / 任意 format (§15.2)
// **既存 5 種 `GATING_FORMAT_IDS` を変更しない。** 臨時バッチ専用の集合を持つ。
// ---------------------------------------------------------------------------

export const AD_HOC_REQUIRED_FORMATS: FormatId[] = [
  'HealthCheckupData',
  'GeneticTestResultData',
  'LifestyleQuestionnaireData',
];
export const AD_HOC_OPTIONAL_FORMATS: string[] = ['HealthAgeData'];

// ---------------------------------------------------------------------------
// ZIP 解析 → 人物分離 → 分類
// ---------------------------------------------------------------------------

export interface AnalyzedFile {
  path: string;
  ext: string;
  sha256: string;
  sizeBytes: number;
  personFolder: string | null;
  classification: Classification;
  displayName: string;
  /** 健診 XLSX を読めたときだけ入る。 */
  healthCheckup?: HealthCheckupSheet;
  /** 問診を読めたときだけ入る。 */
  questionnaire?: QuestionnaireNormalized;
  /** PDF のページ数 (分かったときだけ)。 */
  pageCount?: number | null;
  testDate: string | null;
  error?: string | null;
}

export interface AnalyzedSubject {
  subjectNo: number;
  personFolder: string;
  fingerprint: string | null;
  files: AnalyzedFile[];
}

export interface AnalyzeResult {
  subjects: AnalyzedSubject[];
  /** 人物フォルダの外にあったファイル (バッチ共通の資料)。 */
  batchReference: AnalyzedFile[];
  /** 採用しなかったエントリ。**黙って捨てず一覧に出す** (§5.5)。 */
  rejected: { path: string; reason: string }[];
  notes: string[];
}

/** PDF のページ数を数える。**テキストを読まずバイト列だけ**で数える (簡易・失敗したら null)。 */
export function countPdfPages(bytes: Uint8Array): number | null {
  try {
    // `/Type /Page` の出現数を数える (`/Pages` は除く)。PDF の一般的な構造で十分に効く。
    const text = new TextDecoder('latin1').decode(bytes);
    const m = text.match(/\/Type\s*\/Page[^s]/g);
    if (m && m.length > 0) return m.length;
    const c = text.match(/\/Count\s+(\d+)/);
    if (c) return Number(c[1]);
    return null;
  } catch {
    return null;
  }
}

/** PDF から素のテキストを取り出す。**取れなければ null** (取れないこと自体は失敗でない)。 */
export function extractPdfText(bytes: Uint8Array): string | null {
  try {
    const raw = new TextDecoder('latin1').decode(bytes);
    // 非圧縮のテキストオブジェクトだけを拾う (圧縮ストリームは対象外)。
    const chunks: string[] = [];
    const re = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) chunks.push(m[1].replace(/\\([()\\])/g, '$1'));
    const out = chunks.join('');
    return out.trim() === '' ? null : out;
  } catch {
    return null;
  }
}

/** ZIP を開いて中身を解析する。**1 エントリずつ読み、読み終えたら参照を捨てる。** */
export async function analyzeArchive(input: {
  key: string;
  knownSize?: number;
}): Promise<AnalyzeResult> {
  const archive: OpenedArchive = await openArchiveFromS3({ key: input.key, knownSize: input.knownSize });
  try {
    return await analyzeOpened(archive);
  } finally {
    await archive.close();
  }
}

/** 開いた ZIP を解析する (テストからも呼べるように分けてある)。 */
export async function analyzeOpened(archive: OpenedArchive): Promise<AnalyzeResult> {
  const notes: string[] = [];
  const rejected: { path: string; reason: string }[] = [];
  const adopted: ArchiveEntry[] = [];

  for (const e of archive.listing.entries) {
    if (e.rejected === null) adopted.push(e);
    else if (e.rejected !== 'directory') rejected.push({ path: e.path, reason: e.rejected });
  }

  const root = commonRootPrefix(adopted.map((e) => e.path));
  if (root) notes.push(`root_prefix=${root}`);

  // 人物ごとに束ねる
  const byPerson = new Map<string, AnalyzedFile[]>();
  const batchReference: AnalyzedFile[] = [];
  const seqByPerson = new Map<string, number>();

  for (const e of adopted) {
    const personFolder = personFolderOf(e.path, root);
    let bytes: Uint8Array;
    try {
      bytes = await archive.read(e.path);
    } catch (err) {
      rejected.push({ path: e.path, reason: `read_failed:${String(err).slice(0, 80)}` });
      continue;
    }

    // **拡張子だけで信じない** (§24.3)
    if (!magicMatchesExtension(e.ext, bytes.subarray(0, 8))) {
      rejected.push({ path: e.path, reason: 'magic_mismatch' });
      continue;
    }

    const sha = sha256Hex(bytes);
    const file: AnalyzedFile = {
      path: e.path,
      ext: e.ext,
      sha256: sha,
      sizeBytes: bytes.length,
      personFolder,
      classification: { sourceKind: 'person_file', formatId: null, confidence: 'needs_review', reason: 'pending' },
      displayName: '',
      testDate: null,
    };

    // 中身を読む (分類の材料)
    let sheetRows: CellValue[][] | null = null;
    let pdfText: string | null = null;

    if (e.ext === '.xlsx') {
      // **ワークブックを 1 回だけ読み、健診と問診の両方をそこから起こす。**
      // 2 回読むと、片方の失敗がもう片方を道連れにする (実測でそうなった)。
      try {
        const sheets = await readWorkbookSheets(bytes);

        // 健診として
        const sheet = pickHealthCheckupSheet(sheets);
        file.healthCheckup = sheet;

        // 問診として (**いちばん行数の多いシート**を見る。表紙シートを掴まない)
        let widest: CellValue[][] = [];
        for (const sh of sheets) if ((sh.data?.length ?? 0) > widest.length) widest = sh.data ?? [];
        const q = normalizeExternalFormSheet(widest);

        if (q.people.length > 0) {
          file.questionnaire = q.people[0];
          // 分類の材料は問診の見出し (問診の目印が入る)
          sheetRows = [q.header as unknown as CellValue[]];
        } else if (sheet.headers.length) {
          sheetRows = [sheet.headers as unknown as CellValue[]];
        } else if (widest.length) {
          sheetRows = widest.slice(0, 12);
        }
      } catch (err) {
        file.error = `xlsx_read_failed:${String(err).slice(0, 120)}`;
      }
    } else if (e.ext === '.pdf') {
      pdfText = extractPdfText(bytes);
      file.pageCount = countPdfPages(bytes);
    }

    file.classification = classifyFile({
      path: e.path,
      ext: e.ext,
      inPersonFolder: personFolder !== null,
      // 分類は見出しの文字だけを見るので、セル値は文字列へ落として渡す
      // (`null` は空文字。**値を作らない** — 見出しの一致数を数えるだけ)。
      sheetRows: sheetRows ? sheetRows.map((r) => r.map((c) => (c == null ? '' : String(c)))) : null,
      pdfText,
    });

    // 問診 PDF なら正規化する
    if (file.classification.formatId === 'LifestyleQuestionnaireData' && e.ext === '.pdf' && pdfText) {
      file.questionnaire = normalizeQuestionnairePdf(pdfText);
    }

    // 検査日
    if (file.classification.formatId === 'HealthCheckupData' && file.healthCheckup?.testDate.status === 'resolved') {
      file.testDate = file.healthCheckup.testDate.date;
    } else if (file.classification.formatId === 'LifestyleQuestionnaireData' && file.questionnaire?.completedAt.status === 'resolved') {
      file.testDate = file.questionnaire.completedAt.date;
    }

    if (file.classification.sourceKind === 'ignored') continue;

    if (file.classification.sourceKind === 'batch_reference' || personFolder === null) {
      file.displayName = displayNameFor(null, batchReference.length + 1, e.ext);
      batchReference.push(file);
      continue;
    }

    const seq = (seqByPerson.get(personFolder) ?? 0) + 1;
    seqByPerson.set(personFolder, seq);
    file.displayName = displayNameFor(file.classification.formatId, seq, e.ext);

    const list = byPerson.get(personFolder) ?? [];
    list.push(file);
    byPerson.set(personFolder, list);
  }

  // **Central Directory の出現順**で採番する (§6.2.2)。同じ ZIP なら同じ番号になる。
  const order: string[] = [];
  for (const e of adopted) {
    const p = personFolderOf(e.path, root);
    if (p && byPerson.has(p) && !order.includes(p)) order.push(p);
  }

  const subjects: AnalyzedSubject[] = order.map((folder, i) => {
    const files = byPerson.get(folder) ?? [];
    return {
      subjectNo: i + 1,
      personFolder: folder,
      fingerprint: subjectFingerprint(files.map((f) => f.sha256)),
      files,
    };
  });

  return { subjects, batchReference, rejected, notes };
}

// ---------------------------------------------------------------------------
// 健診 XLSX → measurements → Elith HealthCheckupData
// ---------------------------------------------------------------------------

/** 健診シートの 1 行を「項目名 / 値」の並びへ。**値は原本のまま。整形はしない。** */
export function sheetRowToMeasurements(sheet: HealthCheckupSheet, rowIndex = 0): RawItem[] {
  const row = sheet.rows[rowIndex];
  if (!row) return [];
  const out: RawItem[] = [];
  for (const cell of row) {
    // **空欄 (未実施) は落とす。0 は残す** (§5.3.8.1-4)
    if (isBlankCell(cell.value)) continue;
    // 検査日など日付の列は測定値でないので除く
    if (cell.value instanceof Date) continue;
    out.push({ name: cell.header, value: cell.value as string | number });
  }
  return out;
}

export interface HealthCheckupBuild {
  json: Record<string, unknown>;
  testDate: string | null;
  itemCount: number;
  markers: Partial<HealthAgeMarkers>;
  /** 落とした行の記録。**納品 JSON には混ぜず、監査・画面に出す。** */
  anomalies: unknown[];
}

/**
 * 健診 XLSX → `HealthCheckupData` の JSON。
 * **整形は `sanitizeMeasurementsForDelivery` に通す** (§ 納品整形は決定論プログラムに集約)。
 */
export function buildHealthCheckupJson(input: {
  clientId: string;
  sheet: HealthCheckupSheet;
  rowIndex?: number;
  exportedAt?: Date;
}): HealthCheckupBuild {
  const raw = sheetRowToMeasurements(input.sheet, input.rowIndex ?? 0);
  // **戻り値は `{ kept, anomalies }`**（配列ではない）。納品に載せるのは `kept` だけ。
  // `anomalies` は「なぜ落としたか」の記録なので、監査に返して納品 JSON には混ぜない。
  const sanitized = sanitizeMeasurementsForDelivery(
    raw.map((r) => ({ name: r.name ?? '', value: r.value ?? null })) as never,
  );
  const measurements = sanitized.kept;
  const testDate = input.sheet.testDate.status === 'resolved' ? input.sheet.testDate.date : null;
  const exportedAt = input.exportedAt ?? new Date();

  const json: Record<string, unknown> = {
    format_id: 'HealthCheckupData',
    schema_version: ELITH_HANDOFF_SCHEMA_VERSION,
    kind: 'health_checkup',
    client_id: input.clientId,
    test_date: testDate,
    exported_at: exportedAt.toISOString(),
    source: {
      origin: 'scan-chat-ai',
      app: 'scan-chat-ai',
      model: null,
      note: '臨時診断バッチ (健診 XLSX の決定論 parser)。LLM は使っていない。',
      lab_name: null,
    },
    data: { item_count: measurements.length, measurements },
  };
  return {
    json, testDate, itemCount: measurements.length,
    markers: normalizeMarkers(raw), anomalies: sanitized.anomalies,
  };
}

// ---------------------------------------------------------------------------
// 問診 → Elith LifestyleQuestionnaireData
// ---------------------------------------------------------------------------

export function buildQuestionnaireJson(input: {
  clientId: string;
  diagnosticId: string;
  normalized: QuestionnaireNormalized;
  exportedAt?: Date;
}): { json: Record<string, unknown>; testDate: string; answerCount: number } {
  const n = input.normalized;
  const completedAt =
    n.completedAt.status === 'resolved' ? new Date(`${n.completedAt.date}T00:00:00Z`).getTime() : undefined;

  const json = buildElithInterviewJson({
    diagnosticId: input.diagnosticId,
    clientId: input.clientId,
    // **氏名・生年月日は渡さない** (§8)。sex / age だけ。
    userName: null,
    dateOfBirth: null,
    sex: n.subject.sex,
    answers: n.answers as Record<string, AnswerValue>,
    completedAt,
    exportedAt: input.exportedAt,
  });
  // age は既存関数が dateOfBirth から出すが、こちらは DOB を渡さないので自分で入れる
  (json.subject as { age: number | null }).age = n.subject.age;

  return {
    json: json as unknown as Record<string, unknown>,
    testDate: json.test_date,
    answerCount: json.data.answer_count,
  };
}

// ---------------------------------------------------------------------------
// 遺伝子 (Genoplan) → Elith GeneticTestResultData
// ---------------------------------------------------------------------------

export interface GeneticPagePart {
  page: number;
  section: string | null;
  items: unknown[];
}

/**
 * ページごとの結果を 1 つの `GeneticTestResultData` へ集約する。
 * **`elith-genetic-merge.ts` の finalize と同じ形**を作る (新しい形式を作らない)。
 */
export function buildGeneticJson(input: {
  clientId: string;
  parts: readonly GeneticPagePart[];
  testDate: string | null;
  exportedAt?: Date;
}): { json: Record<string, unknown>; itemCount: number } {
  const items: unknown[] = [];
  const pages: { page: number; section: string | null; count: number }[] = [];
  for (const p of [...input.parts].sort((a, b) => a.page - b.page)) {
    const list = Array.isArray(p.items) ? p.items : [];
    for (const it of list) items.push(it);
    pages.push({ page: p.page, section: p.section ?? null, count: list.length });
  }
  const exportedAt = input.exportedAt ?? new Date();
  const json: Record<string, unknown> = {
    format_id: 'GeneticTestResultData',
    schema_version: ELITH_HANDOFF_SCHEMA_VERSION,
    kind: 'genetic_scan_merged',
    client_id: input.clientId,
    test_date: input.testDate,
    exported_at: exportedAt.toISOString(),
    source: {
      origin: 'scan-chat-ai',
      app: 'scan-chat-ai',
      model: null,
      note: '臨時診断バッチ (Genoplan PDF・既存 scanGeneticPage をページ単位で使用)。',
      lab_name: 'Genoplan',
    },
    data: { item_count: items.length, items, pages },
    page_count: pages.length,
  };
  return { json, itemCount: items.length };
}

// ---------------------------------------------------------------------------
// ウェルネス年齢
// ---------------------------------------------------------------------------

export interface WellnessAgeOutcome {
  method: 'full' | 'simple' | 'unavailable';
  result: WellnessAgeResult | null;
  json: Record<string, unknown> | null;
  message: string | null;
}

/**
 * 人物 1 人のウェルネス年齢。
 *
 * **算出できなくても人物全体を failed にしない** (発注者指示)。
 * `unavailable` は値を作らず定型文だけ返す (捏造ゼロ)。
 */
export function computeSubjectWellnessAge(input: {
  clientId: string;
  markers: Partial<HealthAgeMarkers>;
  age: number | null;
  sex: 'male' | 'female' | null;
  testDate: string | null;
  exportedAt?: Date;
}): WellnessAgeOutcome {
  if (input.age == null) {
    return { method: 'unavailable', result: null, json: null, message: '年齢が確定していないため算出できません。' };
  }
  const markers: HealthAgeMarkers = { ...input.markers, age: input.age, sex: input.sex };
  const result = computeWellnessAge(markers);
  if (result.method === 'unavailable') {
    return { method: 'unavailable', result, json: null, message: result.message };
  }
  const exportedAt = input.exportedAt ?? new Date();
  const json: Record<string, unknown> = {
    format_id: 'HealthAgeData',
    schema_version: ELITH_HANDOFF_SCHEMA_VERSION,
    kind: 'health_age',
    client_id: input.clientId,
    test_date: input.testDate,
    exported_at: exportedAt.toISOString(),
    source: {
      origin: 'scan-chat-ai',
      app: 'scan-chat-ai',
      model: result.model_version,
      note: 'ウェルネス年齢 (旧称: 健康年齢 / CABA)。臨時診断バッチ。',
      lab_name: null,
    },
    data: {
      method: result.method,
      model_version: result.model_version,
      chronological_age: result.chronological_age,
      health_age: result.biological_age,
      delta: result.delta,
      glucose_source: result.glucose_source,
      used_markers: result.used_markers,
      imputed_markers: result.imputed_markers,
    },
  };
  return { method: result.method, result, json, message: null };
}

// ---------------------------------------------------------------------------
// Elith 納品セット (key と JSON)
// ---------------------------------------------------------------------------

export interface DeliveryFile {
  key: string;
  formatId: string;
  body: string;
  bytes: number;
  testDate: string;
}

/** Elith のパス規則 (§15 / CLAUDE.md)。`{prefix}user/{client_id}/date/{YYYY_MM_DD}/`。 */
export function deliveryKey(prefix: string, clientId: string, formatId: string, testDate: string): string {
  const dateFolder = testDate.replace(/-/g, '_');
  const clean = prefix ? prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  const stem = `${formatId}_date_${dateFolder}_user_${clientId}`;
  return `${clean}user/${clientId}/date/${dateFolder}/${stem}.json`;
}

export function toDeliveryFile(
  prefix: string,
  clientId: string,
  formatId: string,
  testDate: string,
  json: unknown,
): DeliveryFile {
  const body = JSON.stringify(json, null, 2);
  return {
    key: deliveryKey(prefix, clientId, formatId, testDate),
    formatId,
    body,
    bytes: Buffer.byteLength(body, 'utf8'),
    testDate,
  };
}

// ---------------------------------------------------------------------------
// ready 判定 (臨時バッチ専用)
// ---------------------------------------------------------------------------

export interface ReadinessReport {
  ready: boolean;
  present: string[];
  missingRequired: string[];
  presentOptional: string[];
  reasons: string[];
}

/**
 * 人物 1 人が納品してよい状態か。
 *
 * **既存 `GATING_FORMAT_IDS` (通常プランの 5 種) は触らない** (§15.2)。
 * ここは案件別の `required_formats` だけを見る。
 */
export function evaluateReadiness(input: {
  producedFormats: readonly string[];
  requiredFormats: readonly string[];
  optionalFormats: readonly string[];
  classifications: readonly Classification[];
}): ReadinessReport {
  const present = [...new Set(input.producedFormats)];
  const missingRequired = input.requiredFormats.filter((f) => !present.includes(f));
  const presentOptional = input.optionalFormats.filter((f) => present.includes(f));
  const reasons: string[] = [];
  if (missingRequired.length) reasons.push(`missing_required:${missingRequired.join(',')}`);
  const autoReady = subjectIsAutoReady(input.classifications);
  if (!autoReady) reasons.push('classification_needs_review');
  return {
    ready: missingRequired.length === 0 && autoReady,
    present,
    missingRequired,
    presentOptional,
    reasons,
  };
}

/** バッチ内で使う新しい識別子。**EC 顧客の ID と別空間** (§13.1)。 */
export function newClientId(): string {
  return randomUUID();
}
export function newDiagnosticId(): string {
  return randomUUID();
}
