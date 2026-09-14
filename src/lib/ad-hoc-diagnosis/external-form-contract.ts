// src/lib/ad-hoc-diagnosis/external-form-contract.ts
// 臨時診断バッチ: 共通問診 62 列 XLSX (`external_form_xlsx_v1`) の **入力契約**。
//
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §7.4
//       + 発注者提示の写像契約 (transcos_questionnaire_62col_mapping_contract_20260914)
//
// **実物 8 件を発注者が確認し、8 件とも 列数 62・列順・ヘッダ文字列が同一**と確定した。
// だからここでは 62 列を**固定 schema** として扱い、1 列でも違えば schema mismatch にする。
//
// **旧 `COLUMN_TO_QUESTION` の短縮キー (`身長` / `喫煙習慣` …) を正本にしない。**
// 実物の見出しは「身長を教えてください。（172cmの場合の入力例：172）」のような
// **完全な設問文**で、短縮キーでは正規化後の完全一致でも当たらない (v1.1 §7.4)。
//
// ここでやってよいのは **写像と拒否だけ**:
//   - fuzzy / 部分一致 / 類似度 / LLM 推測 … **禁止**
//   - 未知値を「その他」へ寄せる … **禁止**
//   - 複数回答から先頭 1 件だけ採る … **禁止**
//   - 範囲外を clamp / 丸める … **禁止**
//   - 未回答を推測で埋める … **禁止**
// 判断できないものは全部 `needs_review` にして人へ渡す。

import { QUESTIONS, type AnswerValue } from '../../scripts/chat/interview-script';

// ---------------------------------------------------------------------------
// 正規化 (互換文字だけ。語は変えない)
// ---------------------------------------------------------------------------

/**
 * ヘッダ・値の正規化。
 *
 * **互換文字の吸収だけ**を行う (契約「全体正規化」1〜4):
 *   ① NFKC (全角英数・全角記号などの互換文字)
 *   ② 波ダッシュ `～` (U+FF5E) / チルダ `~` → production 表記の `〜` (U+301C)
 *   ③ 空白の除去
 *
 * **語の意味は変えない。** 部分一致も類似度も使わない。
 */
export function normalizeForm(s: unknown): string {
  return String(s ?? '')
    .normalize('NFKC')
    // NFKC は `～`(U+FF5E) を `~`(U+007E) にする。production は `〜`(U+301C) なので寄せる。
    .replace(/[~～〜]/g, '〜')
    .replace(/[\s　]/g, '')
    .trim();
}

/** 複数回答の区切り。契約「`;` / `；` / 改行」。**読点やスラッシュでは割らない** (値に含まれ得る)。 */
const MULTI_SPLIT = /[;；\n\r]+/;

/** 複数回答を分割する。空要素は捨てる。**件数は保つ** (先頭 1 件に落とさない)。 */
export function splitMulti(raw: unknown): string[] {
  return String(raw ?? '')
    .split(MULTI_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

// ---------------------------------------------------------------------------
// 列の分類
// ---------------------------------------------------------------------------

export type Disposition =
  /** Forms の管理列。診断回答へ入れない。 */
  | 'IGNORE_METADATA'
  /** 氏名・メール等。**answers にも診断 DB にも Elith JSON にも入れない。** */
  | 'PII_IGNORE'
  /** `完了時刻`。問診実施日時として使う。 */
  | 'METADATA'
  /** 性別。 */
  | 'SUBJECT'
  /** 生年月日。**年齢の算出にだけ使って捨てる。** */
  | 'SUBJECT_TRANSIENT'
  /** 現 production の AI 問診に存在しない列。**仕様として捨てる** (§7.4)。 */
  | 'IGNORED_BY_SPEC'
  /** 設問へ写像する。 */
  | 'ANSWER';

export interface ColumnSpec {
  /** 1 始まり。契約の表の番号。 */
  index: number;
  /** **実物の完全な見出し** (trim 後)。 */
  header: string;
  disposition: Disposition;
  /** `ANSWER` のときの production `question_id`。 */
  questionId?: string;
  /** `F-FREQ` の matrix 行名。 */
  matrixRow?: string;
  /** 値の変換規則。`ANSWER` のときだけ。 */
  rule?: Rule;
}

export type Rule =
  /** 選択肢へ完全一致 (単一)。 */
  | { kind: 'exact' }
  /** 選択肢へ完全一致 (複数)。**1 件でも未知なら設問ごと review**。 */
  | { kind: 'multi' }
  /** production が単一選択。**複数来たら先頭を採らず review** (§7.4 E-TYPE)。 */
  | { kind: 'single_strict' }
  /** 自由記述。そのまま保持。 */
  | { kind: 'text' }
  /** 数値文字列として保持 (単位は落としてよい)。 */
  | { kind: 'numeric_text' }
  /** 整数 → 区間ラベル。境界は `bins` が持つ。 */
  | { kind: 'bin'; bins: Bin[]; skipWhenZero?: boolean }
  /** 1〜10 の整数のみ。**clamp しない**。 */
  | { kind: 'int_range'; min: number; max: number }
  /** matrix の 1 行。 */
  | { kind: 'matrix' }
  /** 明示 alias のみ。表に無い表現は推定しない。 */
  | { kind: 'alias'; alias: Record<string, string> }
  /** カフェイン量: 明示数値から区間へ。数値が無ければ review。 */
  | { kind: 'caffeine' };

/** 区間。`lo <= n < hi` (hi 省略 = 上限なし)。**下限を含み上限を含まない** (契約 §21)。 */
export interface Bin { lo: number; hi?: number; label: string }

const AGE_BINS: Bin[] = [
  { hi: 30, lo: -Infinity, label: '30歳未満' },
  { lo: 30, hi: 40, label: '30〜39歳' },
  { lo: 40, hi: 50, label: '40〜49歳' },
  { lo: 50, hi: 60, label: '50〜59歳' },
  { lo: 60, label: '60歳以上' },
];
const YEAR_BINS: Bin[] = [
  { hi: 5, lo: -Infinity, label: '5年未満' },
  { lo: 5, hi: 10, label: '5〜10年' },
  { lo: 10, hi: 20, label: '10〜20年' },
  { lo: 20, hi: 30, label: '20〜30年' },
  { lo: 30, label: '30年以上' },
];
const CIGARETTE_BINS: Bin[] = [
  { hi: 5, lo: -Infinity, label: '5本未満' },
  { lo: 5, hi: 11, label: '5〜10本' },
  { lo: 11, hi: 21, label: '11〜20本' },
  { lo: 21, hi: 31, label: '21〜30本' },
  { lo: 31, label: '31本以上' },
];
const SITTING_BINS: Bin[] = [
  { hi: 3, lo: -Infinity, label: '3時間未満' },
  { lo: 3, hi: 6, label: '3〜6時間' },
  { lo: 6, hi: 9, label: '6〜9時間' },
  { lo: 9, hi: 12, label: '9〜12時間' },
  { lo: 12, label: '12時間以上' },
];

const FREQ_ROWS = [
  '野菜・海藻類', 'フルーツ', '魚・海産物', '赤身肉・加工肉', '揚げ物・脂っこい食事',
  '塩分の多い食事', '間食・甘いもの', 'カフェイン（コーヒー、エナジードリンクなど）', 'ご飯（お米）',
] as const;

const a = (index: number, header: string, questionId: string, rule: Rule, matrixRow?: string): ColumnSpec =>
  ({ index, header, disposition: 'ANSWER', questionId, rule, matrixRow });
const drop = (index: number, header: string, disposition: Disposition): ColumnSpec =>
  ({ index, header, disposition });

/**
 * **62 列の契約。順序も含めてここが正本。**
 *
 * ヘッダ文字列は発注者が実物 8 件から起こしたもの。1 文字でも違えば schema mismatch。
 */
export const EXTERNAL_FORM_V1_COLUMNS: readonly ColumnSpec[] = [
  drop(1, 'ID', 'IGNORE_METADATA'),
  drop(2, '開始時刻', 'IGNORE_METADATA'),
  { index: 3, header: '完了時刻', disposition: 'METADATA' },
  drop(4, 'メール', 'PII_IGNORE'),
  drop(5, '名前', 'PII_IGNORE'),
  drop(6, '最終変更時刻', 'IGNORE_METADATA'),
  drop(7, 'お名前を教えてください。（氏名）', 'PII_IGNORE'),
  { index: 8, header: '生年月日を教えてください。（1980年1月30日の場合の入力例：19800130）', disposition: 'SUBJECT_TRANSIENT' },
  { index: 9, header: '生物学的性別を教えてください。', disposition: 'SUBJECT' },
  a(10, '身長を教えてください。（172cmの場合の入力例：172）', 'B-HEIGHT', { kind: 'numeric_text' }),
  a(11, '体重を教えてください。※数字のみ（65kgの場合の入力例：65）', 'B-WEIGHT', { kind: 'numeric_text' }),
  a(12, 'ご自身の体重変化について、該当するものを教えてください。※複数選択可', 'B-WEIGHT-CHANGE', { kind: 'multi' }),
  a(13, '現在気になる自覚症状を教えてください。※複数選択可', 'H-SYMPTOMS', { kind: 'multi' }),
  a(14, '現在罹患している疾患を教えてください。※複数選択可', 'H-CURRENT', { kind: 'multi' }),
  a(15, '過去に罹患した疾患名を教えてください。※複数選択可', 'H-PAST', { kind: 'multi' }),
  a(16, '【がんリスク検査かつ疾患名を選択いただいた方のみご回答ください】選択いただいた疾患の治療状況を教えてください。', 'H-TREAT-STATUS', { kind: 'exact' }),
  a(17, '【がんリスク検査かつ疾患名を選択いただいた方のみご回答ください】選択いただいた疾患の発症時期・治療法を教えてください。（入力例: 2020年3月・外科手術）', 'H-TREAT-DETAIL', { kind: 'text' }),
  a(18, '喫煙習慣はありますか？', 'S-STATUS', { kind: 'exact' }),
  a(19, '喫煙を止めた年齢を教えてください。（30歳の場合の入力例：30、吸ったことがない場合の入力例：0）', 'S-QUIT-AGE', { kind: 'bin', bins: AGE_BINS, skipWhenZero: true }),
  a(20, '1日の喫煙本数（喫煙者は現在、禁煙者は過去の本数）を教えてください。（1日10本の場合の入力例：10、吸ったことがない場合の入力例：0）', 'S-COUNT', { kind: 'bin', bins: CIGARETTE_BINS, skipWhenZero: true }),
  a(21, '喫煙している/していた年数を教えてください。（15年間の場合の入力例：15、吸ったことがない場合の入力例：0）', 'S-YEARS', { kind: 'bin', bins: YEAR_BINS, skipWhenZero: true }),
  a(22, '現在の飲酒習慣はありますか？', 'D-FREQ', { kind: 'exact' }),
  a(23, '何歳まで飲酒されていたか教えてください。（45歳の場合の入力例：45、元々まったく飲まない場合の入力例：0）', 'D-UNTIL-AGE', { kind: 'bin', bins: AGE_BINS, skipWhenZero: true }),
  a(24, '飲酒している/していた年数を教えてください。（15年の場合の入力例：15、元々まったく飲まない場合の入力例：0）', 'D-YEARS', { kind: 'bin', bins: YEAR_BINS, skipWhenZero: true }),
  a(25, '飲酒する/していた際の、1回あたりの飲酒量を教えてください。', 'D-AMOUNT', { kind: 'exact' }),
  a(26, '食事について、以下のうち該当するものを教えてください。', 'F-HABITS', { kind: 'multi' }),
  a(27, '野菜・海藻類', 'F-FREQ', { kind: 'matrix' }, FREQ_ROWS[0]),
  a(28, 'フルーツ', 'F-FREQ', { kind: 'matrix' }, FREQ_ROWS[1]),
  a(29, '魚・海産物', 'F-FREQ', { kind: 'matrix' }, FREQ_ROWS[2]),
  a(30, '赤身肉・加工肉', 'F-FREQ', { kind: 'matrix' }, FREQ_ROWS[3]),
  a(31, '揚げ物・脂っこい食事', 'F-FREQ', { kind: 'matrix' }, FREQ_ROWS[4]),
  a(32, '塩分の多い食事', 'F-FREQ', { kind: 'matrix' }, FREQ_ROWS[5]),
  a(33, '間食・甘いもの', 'F-FREQ', { kind: 'matrix' }, FREQ_ROWS[6]),
  a(34, 'カフェイン（コーヒー、エナジードリンクなど）', 'F-FREQ', { kind: 'matrix' }, FREQ_ROWS[7]),
  a(35, 'ご飯（お米）', 'F-FREQ', { kind: 'matrix' }, FREQ_ROWS[8]),
  a(36, 'カフェインの1日あたりの摂取量について教えてください。（コーヒー約2杯の場合の入力例：コーヒー約2杯、エナジードリンク1本の場合の入力例：エナジードリンク1本、飲まない場合の入力例：飲まない）', 'F-CAFFEINE', { kind: 'caffeine' }),
  a(37, '1回あたりのご飯（お米）の量を教えてください。（約150gの場合の入力例：150g、お茶碗に大盛りの場合の入力例：お茶碗に大盛り、食べない場合の入力例：食べない）', 'F-RICE', {
    kind: 'alias',
    // **明示 alias のみ。** 半杯・1.5 杯などは production の 4 区分へ一意に落ちないので推定しない。
    alias: {
      食べない: 'ほとんど食べない',
      '0': 'ほとんど食べない',
      '150': '茶碗1杯（約150g）',
      '150g': '茶碗1杯（約150g）',
      お茶碗一杯: '茶碗1杯（約150g）',
      茶碗1杯: '茶碗1杯（約150g）',
      お茶碗大盛: '大盛り以上（約250g〜）',
      大盛: '大盛り以上（約250g〜）',
    },
  }),
  a(38, '1回あたりの野菜摂取量に対して、ご自身のお考えを教えてください。', 'F-VEG', { kind: 'exact' }),
  a(39, 'ダイエットのための食事制限について教えてください。', 'F-DIET-RESTRICT', { kind: 'exact' }),
  a(40, '食事方法で意識しているものがあれば教えてください。※複数選択可', 'F-DIET-METHOD', { kind: 'multi' }),
  a(41, '週あたりの運動頻度を教えてください。', 'E-FREQ', { kind: 'exact' }),
  a(42, '1回あたりの運動時間を教えてください。', 'E-TIME', { kind: 'exact' }),
  a(43, '同年代の人と比較した歩く速さを教えてください。', 'E-SPEED', { kind: 'exact' }),
  a(44, '1日のうち座りっぱなしの時間を教えてください。（1日約8時間の場合の入力例：8）', 'E-SITTING', { kind: 'bin', bins: SITTING_BINS }),
  a(45, '主な運動の種類を教えてください。', 'E-TYPE', { kind: 'single_strict' }),
  a(46, '現在服用中の薬・定期的に摂取しているサプリメント・健康食品について教えてください。', 'M-HAS', { kind: 'exact' }),
  a(47, '現在服用中の薬・定期的に摂取しているサプリメント・健康食品の名前を教えてください。服用中の薬は、その用途もあれば教えてください。', 'M-NAME', { kind: 'text' }),
  a(48, '現在服用中の薬・定期的に摂取しているサプリメント・健康食品の摂取期間を教えてください。', 'M-PERIOD', { kind: 'exact' }),
  a(49, '現在服用中の薬・定期的に摂取しているサプリメント・健康食品の摂取頻度を教えてください。', 'M-FREQ', { kind: 'exact' }),
  a(50, '平均的な睡眠時間を教えてください。', 'SL-HOURS', { kind: 'exact' }),
  a(51, '睡眠の質を教えてください。', 'SL-QUALITY', { kind: 'exact' }),
  a(52, '仕事・家庭・環境など含む総合的なストレスについて点数をつけてください。（全くない 1～10 非常に強い）', 'SL-STRESS', { kind: 'int_range', min: 1, max: 10 }),
  drop(53, '【がんリスク検査】がんリスク検査のユーザーIDを入力してください。（例：704000056）', 'IGNORED_BY_SPEC'),
  drop(54, '【がんリスク検査】採尿した日付と時刻を教えてください。（4月1日7:30頃の場合の入力例：4月1日7:30）', 'IGNORED_BY_SPEC'),
  drop(55, '【がんリスク検査】採尿前日の飲酒について教えてください。', 'IGNORED_BY_SPEC'),
  drop(56, '【がんリスク検査】採尿前日の薬・サプリメントについて教えてください。ある場合は、「その他」へ薬・サプリメント名を入力してください。', 'IGNORED_BY_SPEC'),
  drop(57, '【がんリスク検査】ALAカプセルを採取した日付と時刻を教えてください。（3月31日21:00頃の場合の入力例：3月31日21:00頃）', 'IGNORED_BY_SPEC'),
  drop(58, '【がんリスク検査】ALAカプセル採取から採尿までに排尿があったか教えてください。', 'IGNORED_BY_SPEC'),
  drop(59, '【がんリスク検査】排尿回数と時刻を教えてください。（24:00頃に1回の場合の入力例：24:00に1回）', 'IGNORED_BY_SPEC'),
  drop(60, '【がんリスク検査】採尿検体を一時冷凍保存したかを教えてください。', 'IGNORED_BY_SPEC'),
  drop(61, '【AI疾病予測】直近1年の体重変化（〇kg）を教えてください。（5kg増えた場合の入力例：5、3kg減った場合の入力例：-3）', 'IGNORED_BY_SPEC'),
  drop(62, '個人情報の取り扱いについて同意します。', 'IGNORED_BY_SPEC'),
];

/**
 * **この案件の `EXAM-TYPE` は申込・バッチ文脈から seed する。**
 *
 * 62 列に実施検査の列は無い (53〜61 はがんリスク / AI疾病予測**固有の設問**であって
 * 実施検査の申告ではない)。**XLSX から推定しない** (契約「EXAM-TYPE（62列外）」)。
 *
 * **Genoplan が追加されても商品区分はタイプ2 のまま**なので
 * `ウェルテクト（下記検査の複数パッケージ）` へは変えない (spec §1.2)。
 */
export const EXTERNAL_FORM_V1_EXAM_TYPE: readonly string[] = [
  'AI疾病予防のみ',
  '遺伝子検査（唾液検査）のみ',
];

// ---------------------------------------------------------------------------
// schema 検査
// ---------------------------------------------------------------------------

export interface SchemaCheck {
  ok: boolean;
  /** 実際の列数。 */
  columnCount: number;
  /** 食い違った列 (1 始まりの位置と、何が来たか)。**中身の値は出さない**。 */
  mismatches: { index: number; expected: string; actual: string }[];
}

/**
 * 62 列の見出しが契約どおりか。**列数・列順・文字列すべて**を見る。
 *
 * 1 列でもずれたら mismatch にするのは、**ずれたまま読むと値が別の設問へ入る**から。
 * 比較は `normalizeForm` 後 (互換文字と空白だけ吸収)。
 */
export function checkExternalFormSchema(headers: readonly unknown[]): SchemaCheck {
  const actual = headers.map((h) => normalizeForm(h));
  const mismatches: SchemaCheck['mismatches'] = [];
  for (const spec of EXTERNAL_FORM_V1_COLUMNS) {
    const got = actual[spec.index - 1] ?? '';
    if (got !== normalizeForm(spec.header)) {
      mismatches.push({ index: spec.index, expected: spec.header, actual: String(headers[spec.index - 1] ?? '') });
    }
  }
  return {
    ok: mismatches.length === 0 && actual.length === EXTERNAL_FORM_V1_COLUMNS.length,
    columnCount: actual.length,
    mismatches,
  };
}

// ---------------------------------------------------------------------------
// 値の変換
// ---------------------------------------------------------------------------

export type CellOutcome =
  | { status: 'mapped'; value: AnswerValue }
  /** 空欄・その設問が対象外 (条件分岐で出番が無い等)。**review にしない**。 */
  | { status: 'skipped'; reason: string }
  /** 判断できない。**人へ渡す。** */
  | { status: 'needs_review'; detail: string };

function labelsOf(questionId: string): string[] {
  const q = QUESTIONS[questionId];
  if (!q) return [];
  const opts = q.chips ?? q.multi_options ?? q.list_options ?? [];
  if (opts.length > 0) return opts.map((o) => o.label);
  return (q.matrix_cols ?? []).map((o) => o.label);
}

/** 選択肢へ完全一致 (正規化後)。当たらなければ null。**近いものを返さない。** */
function pickLabel(questionId: string, raw: unknown): string | null {
  const t = normalizeForm(raw);
  if (t === '') return null;
  for (const l of labelsOf(questionId)) if (normalizeForm(l) === t) return l;
  return null;
}

/** 先頭の整数を読む。`8時間以上` のような**範囲表現は読まない** (契約 §44)。 */
function strictInt(raw: unknown): number | null {
  const t = normalizeForm(raw);
  // 「以上」「以下」「〜」を含む = 上限/下限が不明 → 推定しない。
  if (/以上|以下|未満|〜/.test(t)) return null;
  const m = /^-?\d+(?:\.\d+)?$/.exec(t.replace(/(歳|本|年|時間|kg|cm|g)$/u, ''));
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function binOf(bins: Bin[], n: number): string | null {
  for (const b of bins) {
    const lo = b.lo ?? -Infinity;
    const hi = b.hi ?? Infinity;
    if (n >= lo && n < hi) return b.label;
  }
  return null;
}

/**
 * 1 セルを変換する。
 *
 * **通すか・飛ばすか・人へ渡すかの 3 つだけ。** 寄せる・丸める・切り捨てるはしない。
 */
export function convertCell(spec: ColumnSpec, raw: unknown): CellOutcome {
  const qid = spec.questionId!;
  const rule = spec.rule!;
  const text = normalizeForm(raw);
  if (text === '') return { status: 'skipped', reason: 'empty' };

  switch (rule.kind) {
    case 'text':
      // 自由記述は原文のまま (正規化した文字列でなく元の値)。
      return { status: 'mapped', value: String(raw).trim() };

    case 'numeric_text': {
      const n = strictInt(raw);
      if (n === null) return { status: 'needs_review', detail: `数値にできない: ${text.slice(0, 40)}` };
      return { status: 'mapped', value: String(n) };
    }

    case 'exact': {
      const l = pickLabel(qid, raw);
      if (l === null) return { status: 'needs_review', detail: `選択肢に無い値: ${text.slice(0, 40)}` };
      return { status: 'mapped', value: l };
    }

    case 'multi': {
      const parts = splitMulti(raw);
      const picked: string[] = [];
      for (const p of parts) {
        const l = pickLabel(qid, p);
        if (l === null) {
          // **1 件でも未知なら設問ごと review。** 一部だけ通すと回答が静かに減る。
          return { status: 'needs_review', detail: `選択肢に無い値: ${p.slice(0, 40)}` };
        }
        if (!picked.includes(l)) picked.push(l);
      }
      if (picked.length === 0) return { status: 'skipped', reason: 'empty' };
      return { status: 'mapped', value: picked };
    }

    case 'single_strict': {
      const parts = splitMulti(raw);
      if (parts.length > 1) {
        // **先頭 1 件を採らない** (契約 §45)。production が単一選択なので人が決める。
        return { status: 'needs_review', detail: `production は単一選択だが ${parts.length} 件の回答` };
      }
      const l = pickLabel(qid, parts[0]);
      if (l === null) return { status: 'needs_review', detail: `選択肢に無い値: ${text.slice(0, 40)}` };
      return { status: 'mapped', value: l };
    }

    case 'matrix': {
      const l = pickLabel(qid, raw);
      if (l === null) return { status: 'needs_review', detail: `頻度の選択肢に無い値: ${text.slice(0, 40)}` };
      return { status: 'mapped', value: l };
    }

    case 'bin': {
      const n = strictInt(raw);
      if (n === null) return { status: 'needs_review', detail: `数値にできない: ${text.slice(0, 40)}` };
      // 0 は「該当なし」の入力例なので設問ごと対象外 (契約 §19/§20/§21/§23/§24)。
      if (rule.skipWhenZero && n === 0) return { status: 'skipped', reason: 'zero_means_not_applicable' };
      const l = binOf(rule.bins, n);
      if (l === null) return { status: 'needs_review', detail: `区間に落ちない: ${n}` };
      return { status: 'mapped', value: l };
    }

    case 'int_range': {
      const n = strictInt(raw);
      if (n === null || !Number.isInteger(n)) {
        return { status: 'needs_review', detail: `整数でない: ${text.slice(0, 40)}` };
      }
      if (n < rule.min || n > rule.max) {
        // **clamp しない** (契約 §52)。10 へ丸めると人の入力ミスが見えなくなる。
        return { status: 'needs_review', detail: `範囲外 (${rule.min}〜${rule.max}): ${n}` };
      }
      return { status: 'mapped', value: n };
    }

    case 'alias': {
      const hit = rule.alias[text];
      if (hit === undefined) {
        return { status: 'needs_review', detail: `対応表に無い表現: ${text.slice(0, 40)}` };
      }
      return { status: 'mapped', value: hit };
    }

    case 'caffeine': {
      if (/飲まない|摂らない|^0$/.test(text)) return { status: 'mapped', value: 'ほとんど摂らない' };
      // **最初の明示数値だけ**を読む。「約」は付いていてよいが、数値が無ければ推定しない。
      const m = /(\d+(?:\.\d+)?)\s*(?:杯|本)/.exec(text);
      if (!m) return { status: 'needs_review', detail: `杯数・本数が読めない: ${text.slice(0, 40)}` };
      const n = Number(m[1]);
      if (!Number.isFinite(n)) return { status: 'needs_review', detail: `数値にできない: ${text.slice(0, 40)}` };
      if (n <= 0) return { status: 'mapped', value: 'ほとんど摂らない' };
      if (n <= 2) return { status: 'mapped', value: '1日1〜2杯' };
      if (n <= 4) return { status: 'mapped', value: '1日3〜4杯' };
      return { status: 'mapped', value: '1日5杯以上' };
    }
  }
}
