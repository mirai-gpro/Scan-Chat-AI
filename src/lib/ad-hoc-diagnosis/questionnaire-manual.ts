// src/lib/ad-hoc-diagnosis/questionnaire-manual.ts
// 臨時診断バッチ: 問診 PDF を **管理者が手で確認入力する**経路 (spec v1.1 §7.4 / §20-Q1)。
//
//   PDF (画面で人が読む)
//        ↓  管理者が question_id / AnswerValue を入力
//   ManualEntry[]
//        ↓  ここで **既存 QUESTIONS に照らして厳密検証** (推測も寄せもしない)
//   QuestionnaireNormalized
//        ↓
//   buildElithInterviewJson()   ← **既存関数。新しい JSON 生成を作らない。**
//
// **なぜ自動 parse をやめたのか** (spec §7.4):
// 問診 PDF の回答は radio / checkbox の**視覚的な選択状態**で表されている。
// PDF 本文の text 抽出では**選択された選択肢も、されていない選択肢も同じ文字列として出る**ので、
// 「同じ行か次の行を回答とみなす」方式では正答を保証できない。
// **LLM に選択状態を推測させるのも禁止** (§18)。2 名分だけなので、
// 誤変換のリスクを負って自動化するより Human Review を採る。
//
// ここでやってよいのは **検証と拒否だけ**。値を近い選択肢へ寄せない・未回答を埋めない。

import { QUESTIONS, type AnswerValue, type QuestionDef } from '../../scripts/chat/interview-script';
import { matrixColLabels, normalizeCell, optionLabels } from './questionnaire-map';
import type { QuestionnaireNormalized, UnmappedItem } from './questionnaire';
import { resolveTestDate } from './health-checkup-xlsx';

/** 管理者が 1 設問ぶん入力したもの。 */
export interface ManualEntry {
  questionId: string;
  /** 選択式は**ラベス文字列そのもの**、複数選択は配列、text は文字列、slider は数値。 */
  value: unknown;
}

export interface ManualQuestionnaireInput {
  entries: readonly ManualEntry[];
  /** 問診実施日。**読めなければ未確定のまま** (today を入れない・§6.4)。 */
  completedAt?: string | null;
  sex?: unknown;
  age?: unknown;
}

export interface ManualQuestionnaireResult {
  normalized: QuestionnaireNormalized;
  /** 受け付けなかった入力。**黙って捨てない** — 画面に出して人が直す。 */
  rejected: UnmappedItem[];
}

// **`QUESTIONS` は id をキーにした Record** (配列ではない)。
const BY_ID = new Map<string, QuestionDef>(Object.entries(QUESTIONS));

/** その設問が取り得る選択肢ラベル。**既存の `optionLabels` をそのまま使う。** */
function labelsFor(q: QuestionDef): string[] {
  const base = optionLabels(q.id);
  // matrix は「行 × 列」なので、列 (頻度) のラベルを候補にする。
  return base.length > 0 ? base : matrixColLabels(q.id);
}

/** 複数選択の設問か。 */
function isMulti(q: QuestionDef): boolean {
  return q.answer_kind === 'multi' || (q.answer_kind === 'list' && q.multi === true);
}

/**
 * 1 件を検証する。
 *
 * **通すか弾くかの 2 つだけ。** 近い選択肢へ寄せる・大文字小文字以外の揺れを吸収する、は
 * しない (§7.3 の禁止事項「未知の回答値を近い選択肢へ自動変換」)。
 * 照合は `normalizeCell` による表記ゆれの正規化までで、**一致しなければ拒否**。
 */
export function validateManualEntry(entry: ManualEntry):
  | { status: 'ok'; questionId: string; value: AnswerValue }
  | { status: 'rejected'; item: UnmappedItem } {
  const id = typeof entry.questionId === 'string' ? entry.questionId.trim() : '';
  const q = BY_ID.get(id);
  if (!q) {
    return {
      status: 'rejected',
      item: { header: id || '(空)', reason: 'unknown_column', detail: 'question_id が既存の問診票に無い' },
    };
  }

  // ── 数値 (slider / numeric text) ──
  if (q.answer_kind === 'slider') {
    const n = typeof entry.value === 'number' ? entry.value : Number(entry.value);
    if (!Number.isFinite(n)) {
      return { status: 'rejected', item: { header: id, reason: 'unknown_value', detail: '数値でない' } };
    }
    const lo = q.slider_min ?? 0;
    const hi = q.slider_max ?? 100;
    if (n < lo || n > hi) {
      // **範囲外は丸めない。** 丸めると人が入力を間違えたことが見えなくなる。
      return { status: 'rejected', item: { header: id, reason: 'unknown_value', detail: `範囲外 (${lo}〜${hi})` } };
    }
    return { status: 'ok', questionId: id, value: n };
  }

  // ── 自由入力 ──
  if (q.answer_kind === 'text') {
    const s = typeof entry.value === 'string' ? entry.value.trim() : '';
    if (s === '') {
      // **空は「未回答」。** 入れずに落とす (空文字を答えとして保存しない)。
      return { status: 'rejected', item: { header: id, reason: 'unknown_value', detail: '空欄' } };
    }
    if (q.numeric && !Number.isFinite(Number(s))) {
      return { status: 'rejected', item: { header: id, reason: 'unknown_value', detail: '数値で入力する設問' } };
    }
    return { status: 'ok', questionId: id, value: s };
  }

  // ── 選択式 ──
  const labels = labelsFor(q);
  const pick = (raw: unknown): string | null => {
    const t = normalizeCell(raw);
    if (t === '') return null;
    for (const l of labels) if (normalizeCell(l) === t) return l;
    return null;
  };

  if (isMulti(q)) {
    /*
     * **複数回答を「最初の 1 件」に落とさない** (§7.4 の明示禁止)。
     * 1 つでも読めない値が混ざっていたら、**その設問ごと拒否する**
     * — 一部だけ通すと「答えは 3 つのはずが 2 つ」になり、人が気づけない。
     */
    const arr = Array.isArray(entry.value) ? entry.value : [entry.value];
    const picked: string[] = [];
    for (const v of arr) {
      const l = pick(v);
      if (l === null) {
        return {
          status: 'rejected',
          item: { header: id, reason: 'unknown_value', detail: `選択肢に無い値: ${String(v).slice(0, 40)}` },
        };
      }
      if (!picked.includes(l)) picked.push(l);
    }
    if (picked.length === 0) {
      return { status: 'rejected', item: { header: id, reason: 'unknown_value', detail: '空欄' } };
    }
    return { status: 'ok', questionId: id, value: picked };
  }

  if (Array.isArray(entry.value)) {
    // 単一選択の設問に配列が来た = 入力側の取り違え。**先頭を採らない。**
    return { status: 'rejected', item: { header: id, reason: 'unknown_value', detail: '単一選択の設問に複数の値' } };
  }
  const l = pick(entry.value);
  if (l === null) {
    return {
      status: 'rejected',
      item: { header: id, reason: 'unknown_value', detail: `選択肢に無い値: ${String(entry.value).slice(0, 40)}` },
    };
  }
  return { status: 'ok', questionId: id, value: l };
}

/**
 * 管理者の手入力を `QuestionnaireNormalized` にする。
 *
 * **1 件も通らなければ `answers` は空**。その場合 `questionnaireIsUsable()` が
 * `needs_review` を返すので、空の `LifestyleQuestionnaireData` は作られない。
 */
export function manualQuestionnaire(input: ManualQuestionnaireInput): ManualQuestionnaireResult {
  const answers: Record<string, AnswerValue> = {};
  const rejected: UnmappedItem[] = [];
  let mappedCount = 0;

  for (const e of input.entries ?? []) {
    const r = validateManualEntry(e);
    if (r.status === 'rejected') { rejected.push(r.item); continue; }
    // **同じ設問を 2 回入れたら後勝ちにしない** — どちらが正か決められないので拒否する。
    if (answers[r.questionId] !== undefined) {
      rejected.push({ header: r.questionId, reason: 'unknown_value', detail: '同じ設問が 2 回入力されている' });
      continue;
    }
    answers[r.questionId] = r.value;
    mappedCount++;
  }

  // **性別は既存の正規化を使う。** 読めなければ null のまま (推測しない)。
  let sex: 'male' | 'female' | null = null;
  const rawSex = normalizeCell(input.sex);
  if (rawSex !== '') {
    if (['男', '男性', 'male', 'm'].map(normalizeCell).includes(rawSex)) sex = 'male';
    else if (['女', '女性', 'female', 'f'].map(normalizeCell).includes(rawSex)) sex = 'female';
  }
  const ageNum = typeof input.age === 'number' ? input.age : Number(normalizeCell(input.age));
  const age = Number.isInteger(ageNum) && ageNum > 0 && ageNum < 130 ? ageNum : null;

  // **日付は読めたときだけ。** today も ZIP 作成日も入れない (§6.4)。
  const completedAt = input.completedAt
    ? resolveTestDate(input.completedAt)
    : { status: 'unresolved' as const, reason: 'not_provided' as const };

  const notes: string[] = ['manual_entry'];
  if (mappedCount === 0) notes.push('no_answers_mapped');
  if (completedAt.status !== 'resolved') notes.push('completed_at_unresolved');

  return {
    normalized: {
      // **様式は問わない。** 人が読んで入れたので、PDF の様式判定に依存しない。
      profile: 'unknown',
      answers,
      subject: { sex, age },
      completedAt: completedAt as QuestionnaireNormalized['completedAt'],
      unmapped: rejected,
      mappedCount,
      notes,
    },
    rejected,
  };
}

/**
 * 手入力の保存形 (診断 DB の `ad_hoc_diagnosis_pages.parsed` に入れる)。
 *
 * **PDF の本文は保存しない** (§2.4)。保存するのは
 * 「どの設問にどの選択肢を選んだか」という**既存スキーマの値だけ**。
 */
export interface ManualQuestionnaireRecord {
  kind: 'manual_questionnaire';
  entries: ManualEntry[];
  completedAt: string | null;
  sex: string | null;
  age: number | null;
  /** 入力した操作者 (マスク済み)。 */
  enteredBy: string | null;
  enteredAt: string | null;
  /** **二重確認した操作者** (§7.4)。ここが埋まるまで納品しない。 */
  confirmedBy: string | null;
  confirmedAt: string | null;
}

export function isManualQuestionnaireRecord(v: unknown): v is ManualQuestionnaireRecord {
  return !!v && typeof v === 'object' && (v as Record<string, unknown>).kind === 'manual_questionnaire';
}

/**
 * 保存済みの手入力が**納品してよい状態**か。
 *
 * 条件は 2 つ: ①1 件以上通っている ②**二重確認が済んでいる**。
 * 「入力しただけ」で納品へ進めない — PDF から人が写した値なので、
 * 写し間違いを別の目で見るところまでが仕様 (§7.4)。
 */
export function manualRecordIsConfirmed(rec: ManualQuestionnaireRecord): boolean {
  return !!rec.confirmedBy && rec.entries.length > 0;
}

/** 手入力の画面が使う設問カタログの 1 件。 */
export interface CatalogQuestion {
  id: string;
  section: string;
  question: string;
  kind: 'text' | 'number' | 'single' | 'multiple';
  options: string[];
  /** slider の範囲 (kind='number' のとき)。 */
  min?: number;
  max?: number;
}

/**
 * 入力画面へ渡す設問カタログ。
 *
 * **既存 `QUESTIONS` をそのまま写すだけ。** 臨時バッチ用の設問を作らない・
 * 文言を書き換えない (§7.2「新しい LifestyleQuestionnaireData schema を作ってはならない」)。
 * 表示条件 (`when`) は出し分けに使えないので**全部返す** — 人が PDF を見て
 * 該当する設問にだけ入れる。
 */
export function questionCatalog(): CatalogQuestion[] {
  return Object.values(QUESTIONS).map((q) => {
    const options = labelsFor(q);
    const kind: CatalogQuestion['kind'] =
      q.answer_kind === 'slider' ? 'number'
        : q.answer_kind === 'text' ? 'text'
          : isMulti(q) ? 'multiple' : 'single';
    const out: CatalogQuestion = {
      id: q.id,
      section: q.section_title,
      question: q.question,
      kind,
      options,
    };
    if (q.answer_kind === 'slider') {
      out.min = q.slider_min ?? 0;
      out.max = q.slider_max ?? 100;
    }
    return out;
  });
}
