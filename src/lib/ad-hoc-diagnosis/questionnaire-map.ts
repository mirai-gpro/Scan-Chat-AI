// src/lib/ad-hoc-diagnosis/questionnaire-map.ts
// 臨時診断バッチ: 問診の「外部フォームの列 / PDF の設問」→ 既存 `QUESTIONS` の question_id 写像。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §11.3
//
// **fuzzy な LLM 推測は使わない (発注者指示)。** 完全一致か、ここに明示した写像表だけ。
// 写像に無い列は **`unmapped`** として管理画面に出す。**1 項目未対応で人物全体を失敗にしない。**
//
// **回答値は選択肢の `label` そのもの** (`ChoiceOpt` に value 欄は無く、
// `interview-script.ts` の実装で答えはラベル文字列。実測)。
// だから写像の右辺は**必ず既存ラベルと 1 文字も違わない文字列**にする。

import { QUESTIONS, type AnswerValue } from '../../scripts/chat/interview-script';

/** 外部フォームの列見出し → 既存 question_id。**完全一致 (正規化後) で引く。** */
export const COLUMN_TO_QUESTION: Record<string, string> = {
  // ── 基本情報 ──
  身長: 'B-HEIGHT',
  体重: 'B-WEIGHT',
  体重変化: 'B-WEIGHT-CHANGE',
  // ── 健康状態・既往歴 ──
  自覚症状: 'H-SYMPTOMS',
  現在罹患している疾患: 'H-CURRENT',
  過去に罹患した疾患: 'H-PAST',
  過去に罹患した疾患名: 'H-PAST',
  治療状況: 'H-TREAT-STATUS',
  発症時期・治療法: 'H-TREAT-DETAIL',
  // ── 嗜好品 (喫煙) ──
  喫煙習慣: 'S-STATUS',
  禁煙年齢: 'S-QUIT-AGE',
  '1日の喫煙本数': 'S-COUNT',
  喫煙年数: 'S-YEARS',
  // ── 嗜好品 (飲酒) ──
  飲酒習慣: 'D-FREQ',
  飲酒終了年齢: 'D-UNTIL-AGE',
  飲酒年数: 'D-YEARS',
  '1回あたり飲酒量': 'D-AMOUNT',
  // ── 食生活 ──
  食事: 'F-HABITS',
  カフェイン: 'F-CAFFEINE',
  ご飯: 'F-RICE',
  野菜: 'F-VEG',
  食事制限: 'F-DIET-RESTRICT',
  食事方法: 'F-DIET-METHOD',
  // ── 運動 ──
  運動頻度: 'E-FREQ',
  運動時間: 'E-TIME',
  歩行速度: 'E-SPEED',
  座位時間: 'E-SITTING',
  運動種類: 'E-TYPE',
  // ── 薬・サプリ ──
  '薬・サプリ': 'M-HAS',
  '薬・サプリ名': 'M-NAME',
  摂取期間: 'M-PERIOD',
  摂取頻度: 'M-FREQ',
  // ── 睡眠・心身 ──
  睡眠時間: 'SL-HOURS',
  睡眠の質: 'SL-QUALITY',
  ストレス: 'SL-STRESS',
  // ── 実施検査 ──
  実施検査: 'EXAM-TYPE',
};

/**
 * `F-FREQ` (摂取頻度マトリクス) の行に対応する列見出し。
 * 外部フォームでは 1 行 1 列に展開されているので、**行名へ畳み直す**。
 * 右辺は `QUESTIONS['F-FREQ'].matrix_rows` の文字列と完全一致させる。
 */
export const COLUMN_TO_MATRIX_ROW: Record<string, string> = {
  野菜: '野菜・海藻類',
  海藻: '野菜・海藻類',
  '野菜・海藻類': '野菜・海藻類',
  フルーツ: 'フルーツ',
  果物: 'フルーツ',
  魚: '魚・海産物',
  '魚・海産物': '魚・海産物',
  '赤身肉・加工肉': '赤身肉・加工肉',
  赤身肉: '赤身肉・加工肉',
  加工肉: '赤身肉・加工肉',
  揚げ物: '揚げ物・脂っこい食事',
  '揚げ物・脂っこい食事': '揚げ物・脂っこい食事',
  塩分: '塩分の多い食事',
  '塩分の多い食事': '塩分の多い食事',
  間食: '間食・甘いもの',
  '間食・甘いもの': '間食・甘いもの',
  甘いもの: '間食・甘いもの',
  カフェイン: 'カフェイン（コーヒー、エナジードリンクなど）',
  ご飯: 'ご飯（お米）',
  '': '',
};

/**
 * **PII の列 (Elith へ渡さない)。** 読み取りはするが `answers` に入れない。
 * 氏名・メール・生年月日は §8 の表どおり **DB にも納品 JSON にも入れない**。
 */
export const PII_COLUMNS = new Set([
  'ID',
  '氏名',
  '名前',
  'お名前',
  'メール',
  'メールアドレス',
  '生年月日',
  '最終変更時刻',
  '開始時刻',
]);

/** 被験者の属性として**使ってよい**列 (§8 の表で ○ のもの)。 */
export const SUBJECT_COLUMNS: Record<string, 'sex' | 'dob' | 'completed_at'> = {
  生物学的性別: 'sex',
  性別: 'sex',
  生年月日: 'dob', // age 算出にのみ使い、保存も納品もしない
  完了時刻: 'completed_at',
};

/** 見出し・回答値の正規化。**空白と全角空白だけを落とす。語は変えない。** */
export function normalizeCell(s: unknown): string {
  return String(s ?? '').replace(/[\s　]/g, '').trim();
}

/** 選択肢ラベルの一覧を返す (chip / multi / list)。 */
export function optionLabels(questionId: string): string[] {
  const q = QUESTIONS[questionId];
  if (!q) return [];
  const opts = q.chips ?? q.multi_options ?? q.list_options ?? [];
  return opts.map((o) => o.label);
}

/** matrix の列 (頻度) ラベル。 */
export function matrixColLabels(questionId: string): string[] {
  const q = QUESTIONS[questionId];
  return (q?.matrix_cols ?? []).map((o) => o.label);
}

/** 複数回答を割る区切り。外部フォームは「, 」「、」「/」「;」「改行」のどれかを使う。 */
const MULTI_SPLIT = /[,、;；\/／\n]+/;

export type MapOutcome =
  | { status: 'mapped'; questionId: string; value: AnswerValue }
  | { status: 'skipped'; reason: 'pii' | 'empty' | 'subject_attribute' }
  | { status: 'unmapped'; reason: 'unknown_column' | 'unknown_value'; detail: string };

/**
 * 1 セルを写像する。
 *
 * **値は必ず既存の選択肢ラベルへ落とす。** 落とせない値は `unmapped` にして
 * **管理画面に出す** — 勝手に近い選択肢へ寄せると、回答を書き換えたことになる。
 */
export function mapCell(header: string, raw: unknown): MapOutcome {
  const h = normalizeCell(header);
  if (h === '') return { status: 'skipped', reason: 'empty' };
  if (PII_COLUMNS.has(h)) return { status: 'skipped', reason: 'pii' };
  if (SUBJECT_COLUMNS[h]) return { status: 'skipped', reason: 'subject_attribute' };

  const questionId = COLUMN_TO_QUESTION[h];
  if (!questionId) return { status: 'unmapped', reason: 'unknown_column', detail: h };

  const q = QUESTIONS[questionId];
  if (!q) return { status: 'unmapped', reason: 'unknown_column', detail: h };

  const text = String(raw ?? '').trim();
  if (text === '') return { status: 'skipped', reason: 'empty' };

  switch (q.answer_kind) {
    case 'text':
      return { status: 'mapped', questionId, value: text };

    case 'slider': {
      const n = Number(text.replace(/[^\d.-]/g, ''));
      if (!Number.isFinite(n)) {
        return { status: 'unmapped', reason: 'unknown_value', detail: `${h}=${text}` };
      }
      const min = q.slider_min ?? 1;
      const max = q.slider_max ?? 10;
      const clamped = Math.min(max, Math.max(min, Math.round(n)));
      return { status: 'mapped', questionId, value: clamped };
    }

    case 'chip': {
      const hit = matchLabel(text, optionLabels(questionId));
      if (!hit) return { status: 'unmapped', reason: 'unknown_value', detail: `${h}=${text}` };
      return { status: 'mapped', questionId, value: hit };
    }

    case 'multi':
    case 'list': {
      const parts = text.split(MULTI_SPLIT).map((s) => s.trim()).filter(Boolean);
      const labels = optionLabels(questionId);
      const hits: string[] = [];
      const misses: string[] = [];
      for (const p of parts) {
        const hit = matchLabel(p, labels);
        if (hit) hits.push(hit);
        else misses.push(p);
      }
      if (hits.length === 0) {
        return { status: 'unmapped', reason: 'unknown_value', detail: `${h}=${text}` };
      }
      // **単一選択の設問は文字列で返す。** `list` は既定が単一選択で、
      // `multi: true` のときだけ複数になる (`interview-script.ts` の `QuestionDef.multi`)。
      // ここで常に配列にすると、既存の表示・書き出しが「1 件の配列」を受け取ることになる。
      const isMulti = q.answer_kind === 'multi' || q.multi === true;
      if (!isMulti) return { status: 'mapped', questionId, value: hits[0] };
      // **一部だけ読めた場合も採る。** 読めなかった分は unmapped として別に記録する
      // (この関数は 1 値しか返せないので、呼び出し側が misses を拾う)。
      return { status: 'mapped', questionId, value: hits };
    }

    case 'matrix':
      // 呼び出し側が `mapMatrixColumns()` で畳む。単独セルとしては扱わない。
      return { status: 'unmapped', reason: 'unknown_column', detail: h };

    default:
      return { status: 'unmapped', reason: 'unknown_column', detail: h };
  }
}

/**
 * 値を選択肢ラベルへ落とす。
 *
 * 1. **完全一致** (正規化後)
 * 2. **明示した別表記** (`VALUE_ALIASES`)
 *
 * **部分一致・類似度では寄せない** — 「週2〜3日」と「週2〜3回」のような
 * 紛らわしい対を取り違えるため。
 */
export function matchLabel(raw: string, labels: readonly string[]): string | null {
  const t = normalizeCell(raw);
  if (t === '') return null;
  for (const l of labels) if (normalizeCell(l) === t) return l;
  const alias = VALUE_ALIASES[t];
  if (alias) {
    for (const l of labels) if (normalizeCell(l) === normalizeCell(alias)) return l;
  }
  return null;
}

/**
 * 外部フォームで表記が違うことが分かっている値の**明示的な**読み替え。
 * **ここに書いたものだけ**が読み替わる (推測しない)。
 */
export const VALUE_ALIASES: Record<string, string> = {
  // 喫煙
  吸っている: '現在吸っている',
  現在喫煙: '現在吸っている',
  過去に吸っていた: '過去に吸っていたが現在は吸わない',
  過去喫煙: '過去に吸っていたが現在は吸わない',
  非喫煙: '吸ったことはない',
  吸わない: '吸ったことはない',
  // 飲酒
  毎日: '毎日飲む',
  飲まない: '元々まったく飲まない',
  // はい / いいえ 型
  はい: 'ある',
  いいえ: 'ない',
  有: 'ある',
  無: 'ない',
  あり: 'ある',
  なし: 'ない',
  // 歩行速度
  はやい: '速い',
  おそい: '遅い',
  // 該当なし
  該当なし: '該当するものはない',
  特になし: '該当するものはない',
};

export interface MatrixMapResult {
  /** `F-FREQ` の値。行名 → 頻度ラベル。 */
  value: Record<string, string>;
  unmapped: string[];
}

/**
 * 摂取頻度マトリクス (`F-FREQ`) を、1 行 1 列に展開された外部フォームから畳み直す。
 * **行名も頻度も既存ラベルへ完全一致で落とす。**
 */
export function mapMatrixColumns(cells: readonly { header: string; value: unknown }[]): MatrixMapResult {
  const cols = matrixColLabels('F-FREQ');
  const rows = QUESTIONS['F-FREQ']?.matrix_rows ?? [];
  const value: Record<string, string> = {};
  const unmapped: string[] = [];

  for (const c of cells) {
    const h = normalizeCell(c.header);
    const rowName = COLUMN_TO_MATRIX_ROW[h];
    if (!rowName || !rows.includes(rowName)) continue;
    const text = String(c.value ?? '').trim();
    if (text === '') continue;
    const freq = matchLabel(text, cols);
    if (!freq) {
      unmapped.push(`${h}=${text}`);
      continue;
    }
    value[rowName] = freq;
  }
  return { value, unmapped };
}

/** 性別を既存仕様の値へ。**判定できなければ null** (推測しない)。 */
export function normalizeSex(raw: unknown): 'male' | 'female' | null {
  const t = normalizeCell(raw);
  if (['男', '男性', 'male', 'M', 'm', '男性(生物学的)'].map(normalizeCell).includes(t)) return 'male';
  if (['女', '女性', 'female', 'F', 'f', '女性(生物学的)'].map(normalizeCell).includes(t)) return 'female';
  return null;
}
