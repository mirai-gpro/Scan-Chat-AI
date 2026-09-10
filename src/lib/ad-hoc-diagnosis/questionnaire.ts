// src/lib/ad-hoc-diagnosis/questionnaire.ts
// 臨時診断バッチ: 問診 (XLSX / PDF) → 共通の内部形式 → 既存 `buildElithInterviewJson()`。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §11.3
//
//   XLSX / PDF
//        ↓  (profile ごとの adapter)
//   QuestionnaireNormalized
//        ↓  answers: Record<question_id, AnswerValue>
//   buildElithInterviewJson()   ← **既存関数。新しい JSON 生成を作らない。**
//        ↓
//   LifestyleQuestionnaireData
//
// **写像は `questionnaire-map.ts` の明示表だけ** (fuzzy な推測をしない)。
// 未対応の設問は `unmapped` として管理画面に出し、**人物全体は失敗にしない。**

import type { AnswerValue } from '../../scripts/chat/interview-script';
import {
  COLUMN_TO_MATRIX_ROW,
  PII_COLUMNS,
  SUBJECT_COLUMNS,
  mapCell,
  mapMatrixColumns,
  matchLabel,
  normalizeCell,
  normalizeSex,
  optionLabels,
} from './questionnaire-map';
import { resolveTestDate, type CellValue, type DateResolution } from './health-checkup-xlsx';

/** 問診の様式。**判定できたものだけ名前を付ける。** */
export type QuestionnaireProfile =
  | 'external_form_xlsx_v1' // 外部フォーム書き出しの 62 列 XLSX
  | 'welltect_common_v1' // Welltect 共通問診 PDF (約 10 ページ)
  | 'ai_prevention_short_v1' // AI疾病予防報告書 短縮問診 PDF (約 5 ページ)
  | 'unknown';

export interface UnmappedItem {
  /** 元の見出し (画面に出す。**DB へは保存しない**)。 */
  header: string;
  reason: 'unknown_column' | 'unknown_value';
  detail: string;
}

export interface QuestionnaireNormalized {
  profile: QuestionnaireProfile;
  /** 既存 `QUESTIONS` の id → 回答値。**これがそのまま既存経路へ入る。** */
  answers: Record<string, AnswerValue>;
  /** 被験者の属性。**氏名・メール・生年月日は入れない** (age 算出にだけ使い捨てる)。 */
  subject: { sex: 'male' | 'female' | null; age: number | null };
  /** 問診実施日時 (`完了時刻`)。**確定できなければ unresolved。** */
  completedAt: DateResolution;
  /** 写像できなかった項目。**管理画面に出す。人物を失敗にしない。** */
  unmapped: UnmappedItem[];
  /** 写像できた設問数 (画面の目安)。 */
  mappedCount: number;
  notes: string[];
}

// ---------------------------------------------------------------------------
// 共通のユーティリティ
// ---------------------------------------------------------------------------

/** 生年月日と基準日から年齢。**保存も納品もしない値**なのでここで使い切る。 */
export function ageFrom(dob: string | null, ref: Date): number | null {
  if (!dob) return null;
  const m = /^(\d{4})[-/年]?(\d{1,2})[-/月]?(\d{1,2})/.exec(dob.trim());
  if (!m) return null;
  const [, y, mo, d] = m.map(Number) as unknown as [string, number, number, number];
  const birth = new Date(Date.UTC(Number(y), mo - 1, d));
  if (Number.isNaN(birth.getTime())) return null;
  let age = ref.getUTCFullYear() - birth.getUTCFullYear();
  const before =
    ref.getUTCMonth() < birth.getUTCMonth() ||
    (ref.getUTCMonth() === birth.getUTCMonth() && ref.getUTCDate() < birth.getUTCDate());
  if (before) age -= 1;
  return age >= 0 && age <= 150 ? age : null;
}

function emptyNormalized(profile: QuestionnaireProfile, notes: string[]): QuestionnaireNormalized {
  return {
    profile,
    answers: {},
    subject: { sex: null, age: null },
    completedAt: { status: 'absent' },
    unmapped: [],
    mappedCount: 0,
    notes,
  };
}

// ---------------------------------------------------------------------------
// adapter ①: 外部フォーム書き出しの XLSX (62 列)
// ---------------------------------------------------------------------------

/** 先頭の定型 6 列。ここが揃っていれば外部フォームの書き出しとみなす。 */
export const EXTERNAL_FORM_LEAD_COLUMNS = [
  'ID',
  '開始時刻',
  '完了時刻',
  'メール',
  '名前',
  '最終変更時刻',
] as const;

/** 見出し行がこの様式か。**先頭 6 列のうち 4 件以上**で成立とする。 */
export function isExternalFormHeader(headers: readonly string[]): boolean {
  const set = new Set(headers.map(normalizeCell));
  const hits = EXTERNAL_FORM_LEAD_COLUMNS.filter((c) => set.has(normalizeCell(c))).length;
  return hits >= 4;
}

/**
 * 62 列 XLSX の 1 行 (= 1 人) を写像する。
 *
 * **`完了時刻` を問診実施日時として扱う** (発注者指示)。既存仕様どおり
 * そこから `test_date` を作る (`buildElithInterviewJson` が JST 日付にする)。
 */
export function normalizeExternalFormRow(
  headers: readonly string[],
  row: readonly CellValue[],
): QuestionnaireNormalized {
  const out = emptyNormalized('external_form_xlsx_v1', []);
  const cells = headers.map((h, i) => ({ header: h, value: row[i] ?? null }));

  // 被験者の属性 (PII は age/sex を作るのに使い、値そのものは持ち回らない)
  let dob: string | null = null;
  for (const c of cells) {
    const kind = SUBJECT_COLUMNS[normalizeCell(c.header)];
    if (!kind) continue;
    if (kind === 'sex') out.subject.sex = normalizeSex(c.value);
    if (kind === 'dob') dob = c.value == null ? null : String(c.value);
    if (kind === 'completed_at') out.completedAt = resolveTestDate(c.value as CellValue);
  }

  // matrix (摂取頻度) は列がばらけているので先に畳む
  const matrix = mapMatrixColumns(cells);
  if (Object.keys(matrix.value).length > 0) {
    out.answers['F-FREQ'] = matrix.value as unknown as AnswerValue;
    out.mappedCount++;
  }
  for (const d of matrix.unmapped) {
    out.unmapped.push({ header: d.split('=')[0], reason: 'unknown_value', detail: d });
  }

  // 残りの列
  const matrixHeaders = new Set(Object.keys(COLUMN_TO_MATRIX_ROW).map(normalizeCell));
  for (const c of cells) {
    const h = normalizeCell(c.header);
    if (h === '' || PII_COLUMNS.has(h) || SUBJECT_COLUMNS[h]) continue;
    // matrix へ畳んだ列は、単独の設問としては扱わない。
    // ただし `野菜` / `カフェイン` / `ご飯` は**単独の設問にもある**ので、
    // matrix で拾えなかったときだけ単独として試す。
    const usedByMatrix = matrixHeaders.has(h) && matrix.value[COLUMN_TO_MATRIX_ROW[h]] !== undefined;
    if (usedByMatrix && !['野菜', 'カフェイン', 'ご飯'].includes(h)) continue;

    const r = mapCell(c.header, c.value);
    if (r.status === 'mapped') {
      out.answers[r.questionId] = r.value;
      out.mappedCount++;
    } else if (r.status === 'unmapped') {
      out.unmapped.push({ header: h, reason: r.reason, detail: r.detail });
    }
  }

  // age は完了時刻を基準に出す (無ければ今日)
  const ref =
    out.completedAt.status === 'resolved' ? new Date(`${out.completedAt.date}T00:00:00Z`) : new Date();
  out.subject.age = ageFrom(dob, ref);

  if (out.completedAt.status !== 'resolved') out.notes.push('completed_at_unresolved');
  if (out.mappedCount === 0) out.notes.push('no_answers_mapped');
  return out;
}

/** XLSX 全体 (シートの行列) から人物ごとの問診を作る。**1 行 = 1 人**。 */
export function normalizeExternalFormSheet(
  rows: readonly (readonly CellValue[])[],
): { header: string[]; people: QuestionnaireNormalized[] } {
  // 見出し行 = 先頭 10 行で `isExternalFormHeader` が成立する最初の行
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const asText = (rows[i] ?? []).map((c) => String(c ?? ''));
    if (isExternalFormHeader(asText)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return { header: [], people: [] };

  const header = (rows[headerIdx] ?? []).map((c) => String(c ?? '').trim());
  const people: QuestionnaireNormalized[] = [];
  for (const r of rows.slice(headerIdx + 1)) {
    // 全部空の行は捨てる
    if ((r ?? []).every((c) => c == null || String(c).trim() === '')) continue;
    people.push(normalizeExternalFormRow(header, r));
  }
  return { header, people };
}

// ---------------------------------------------------------------------------
// adapter ②③: 問診 PDF (2 様式)
// ---------------------------------------------------------------------------

/** PDF の様式を判定する。**両方の目印が出たら決めない** (`unknown`)。 */
export function detectPdfProfile(text: string): QuestionnaireProfile {
  const t = normalizeCell(text);
  const common = ['Welltect', 'ウェルテクト', '嗜好品', '食生活', '心身'].filter((w) =>
    t.includes(normalizeCell(w)),
  ).length;
  const short = ['AI疾病予防', '短縮', '簡易問診'].filter((w) => t.includes(normalizeCell(w))).length;
  if (common >= 2 && short >= 1) return 'unknown';
  if (common >= 2) return 'welltect_common_v1';
  if (short >= 1) return 'ai_prevention_short_v1';
  return 'unknown';
}

/**
 * PDF の本文から「設問: 回答」の対を拾う。
 *
 * **設問文は既存 `QUESTIONS[].question` と完全一致で引く** (fuzzy にしない)。
 * `questionnaire-map.ts` の列見出し表も併用する
 * (PDF が「喫煙習慣」のような短い見出しで印字されている様式があるため)。
 *
 * 拾えなかった行は捨てるだけ (設問でない行が大半なので `unmapped` に積まない)。
 * **写像表に在る見出しなのに値が読めなかったときだけ** `unmapped` にする。
 */
export function normalizePdfText(text: string, profile: QuestionnaireProfile): QuestionnaireNormalized {
  const out = emptyNormalized(profile, []);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // 「見出し」→「値」は同じ行 (`見出し: 値`) か次の行に出る。両方見る。
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^(.{1,40}?)[：:]\s*(.*)$/.exec(line);
    let header: string;
    let value: string;
    if (m) {
      header = m[1];
      value = m[2];
      if (value === '' && i + 1 < lines.length) value = lines[i + 1];
    } else {
      header = line;
      value = i + 1 < lines.length ? lines[i + 1] : '';
    }

    const h = normalizeCell(header);
    if (h === '' || PII_COLUMNS.has(h)) continue;

    const kind = SUBJECT_COLUMNS[h];
    if (kind === 'sex') {
      const sex = normalizeSex(value);
      if (sex) out.subject.sex = sex;
      continue;
    }
    if (kind === 'completed_at') {
      const d = resolveTestDate(value);
      if (d.status === 'resolved') out.completedAt = d;
      continue;
    }

    const r = mapCell(header, value);
    if (r.status === 'mapped') {
      // 同じ設問が複数回出たら**最初の 1 回を採る** (後段の要約欄で上書きされないように)
      if (out.answers[r.questionId] === undefined) {
        out.answers[r.questionId] = r.value;
        out.mappedCount++;
      }
    } else if (r.status === 'unmapped' && r.reason === 'unknown_value') {
      out.unmapped.push({ header: h, reason: r.reason, detail: r.detail });
    }
  }

  if (out.mappedCount === 0) out.notes.push('no_answers_mapped');
  if (out.completedAt.status !== 'resolved') out.notes.push('completed_at_unresolved');
  return out;
}

/**
 * 問診 PDF の入口。profile を判定してから対応する adapter へ。
 *
 * **profile B (短縮) に既存 QUESTIONS へ完全対応しない設問があっても止めない** (発注者指示)。
 * 対応できたものだけ `answers` に入れ、残りは `unmapped` に積む。
 */
export function normalizeQuestionnairePdf(text: string): QuestionnaireNormalized {
  const profile = detectPdfProfile(text);
  const out = normalizePdfText(text, profile);
  if (profile === 'unknown') out.notes.push('pdf_profile_unknown');
  return out;
}

// ---------------------------------------------------------------------------
// 出来上がりの評価
// ---------------------------------------------------------------------------

/**
 * この問診を納品してよいか。
 *
 * - **1 項目でも写像できていれば納品対象にする** (未対応が 1 つあるだけで人物を落とさない)。
 * - **0 件なら `needs_review`** (空の LifestyleQuestionnaireData を作らない)。
 */
export function questionnaireIsUsable(n: QuestionnaireNormalized): boolean {
  return n.mappedCount > 0;
}

/** 画面に出す要約。**回答の中身は出さない** (見出しと件数だけ)。 */
export function questionnaireSummary(n: QuestionnaireNormalized): string {
  const parts = [`様式=${n.profile}`, `写像=${n.mappedCount}件`];
  if (n.unmapped.length) parts.push(`未対応=${n.unmapped.length}件`);
  if (n.completedAt.status === 'resolved') parts.push(`完了=${n.completedAt.date}`);
  else parts.push('完了時刻=未確定');
  return parts.join(' / ');
}

/** 既存の選択肢ラベル一覧を画面へ出すため (管理者が未対応項目を手で寄せるときの候補)。 */
export function candidateLabels(questionId: string): string[] {
  return optionLabels(questionId);
}

/** 管理者が手で値を選び直すときの検証。**既存ラベルでなければ受け付けない。** */
export function validateManualAnswer(questionId: string, value: string): string | null {
  const labels = optionLabels(questionId);
  if (labels.length === 0) return value.trim() === '' ? null : value; // 自由入力
  return matchLabel(value, labels);
}
