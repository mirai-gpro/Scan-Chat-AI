/**
 * プリベント（がんリスク検査 / ALA-PDS）向け **問診CSV の組み立て**（純関数・I/O なし）。
 *
 * 正本:
 *   - `docs/lab/lab_data_pipeline_master_spec.md` §4-5.3（E2E の往復キー）
 *   - `docs/lab/questionnaire_to_lab_csv_spec.md` §4.2（項目リスト）／§5（生成ルール）
 *   - `docs/lab/kit_receipt_external_id_capture_spec.md` §7.1（CSV を止めるゲート）
 *
 * 【このファイルが引き受けること】
 *   ① 列の定義（**ここ 1 か所だけ**。先方様式が確定したらここを直す）
 *   ② バーコードNo. から **CSV の 行3 / ファイル名** を派生させる
 *   ③ 問診の回答・対象者属性を列へ流し込む
 *
 * 【プリベントへ渡す番号は `external_barcode` ＝ バーコードNo. ＝ ユーザーID】
 * 先方要望（2026-10）により、**Wellfort 独自の整理番号は使わない**。
 * 画面の一覧・CSV の中身・ファイル名の 3 者は **同じ 1 つの確定値から派生させる**
 * （別々に文字列を作ると、一度ずれたら誰も気づけない。LAiF で実際に起きた
 * 「画面は `WF-2026-000123` / 中身は `W026000123`」の再発防止）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【この様式は確定していない。本番配布に使ってはいけない】
 * ══════════════════════════════════════════════════════════════════════
 * 先方（プリベント）から**項目をまとめた Excel**
 * （「ウェルフォート様_問診・アンケートデータ_例_問診1回.xlsx」）が提供されているが、
 * **両リポジトリに入っていない**（実測: `*.xlsx` を全検索しても無く、
 * ファイル名・「アンケートデータ」の文字列ヒットも 0 件）。
 * したがって**その Excel の構造（ヘッダが 3 行か 1 行か・列順・選択肢コード・
 * 文字コード・改行）を忠実に再現できない。**
 *
 * **ここに在るのは Wellfort が組んだ暫定の 1 行ヘッダ × 27 列**で、
 * 先方様式ではない。`PREVENT_CSV_FORMAT_STATUS` が `'unconfirmed'` の間は、
 * **プリベント本番ポータルから配布してはいけない**（配布の口は
 * app_config `labid.prevent_csv_release` が既定 off で閉じている）。
 * 用途は**当社内部の様式確認（テスト用 preview）だけ**。
 *
 * 【それでも列名を発明していない】
 * 基本情報の 5 列は仕様 §4.2 の表記、問診由来の列は **production の設問文を逐語**。
 * §4.2 の 行13-23 は **11 行に対して概念名が 8 個**しか書かれておらず 1:1 の列名が
 * 起こせないため、**当社で列名を作らない**という方針でこうしてある。
 * `rows` は仕様 §4.2 の行番号への対応を辿るためのメタデータで、**CSV には出さない**。
 *
 * **Excel を受領したら、この配列と `PREVENT_CSV_FORMAT_STATUS` を差し替える。**
 *
 * 【★ の供給元は「設問が無い」ではなく「別ソースが未実装」】
 * ALAカプセル摂取日時・採尿日時・排尿回数・採尿前日の薬／飲酒・冷凍保存
 * （§4.2 の ★ 行8-12 / 25 / 26 / 35）は、**AI問診から意図的に外されたもの**。
 * `src/scripts/chat/interview-script.ts:538-541` に削除の記録があり
 * （旧 `EX-URINE-DT` / `EX-URINE-ALC` / `EX-URINE-MED` / `EX-URINE-MED-NAME` /
 * `EX-ALA-DT` / `EX-URINATE` / `EX-URINATE-CNT` / `EX-FROZEN`）、理由は
 * 「採取条件・結果は検査機関(PREVENT)側で取得し admin バッチ処理するため」。
 *
 * **だから「AI問診に設問が無いので空」と書くのは誤り。** 正しくは:
 *   - **ALAカプセル摂取日時 / 採尿日時** … **検査キットの進捗管理で取得する**
 *     （2026-09-03 の業務合意）。**入力・保存の実装は無い**
 *     （`api/kit/[id]/self-report.ts` は `user_received_at` / `user_returned_at`
 *     しか書かない。`kit_progress_management.md` にも入力欄が無い。
 *     `src/` と `supabase/migrations/` を grep して該当列 0 件）。
 *   - **排尿回数 / 冷凍保存 / 採尿前日の薬 / 採尿前日の飲酒** … **供給元が未確定**
 *     （AI問診から削除済み・進捗管理にも入力欄が無い・先方取得かどうかも未確認）。
 *
 * **どちらも値を作らない**（§5-5「捏造しない」）。列は出して空にし、
 * `source` に**どこから来るはずか**を書いておく（「設問が無い」で止めると、
 * 別ソースが在るのに空のまま放置される）。
 */

/** 列の値の供給元。**`barcode_no` は 1 つだけ**（行3）。 */
export type PreventCsvSource =
  /** 受取時に確定した `customer.lab_tests.external_barcode`。 */
  | { kind: 'barcode_no' }
  /** 対象者属性（`resolveTargetSubject`）。 */
  | { kind: 'subject'; field: 'date_of_birth' | 'sex' }
  /** AI問診の回答（設問 id）。 */
  | { kind: 'answer'; questionId: string }
  /**
   * **値を持てない項目。常に空。**
   * `from` は**どこから来るはずか**（供給元が実装されたらここを差し替える）。
   *   - `kit_progress` … 検査キットの進捗管理で取得する（2026-09-03 業務合意・**未実装**）
   *   - `undecided`    … 供給元そのものが未確定
   */
  | { kind: 'pending'; from: 'kit_progress' | 'undecided'; note: string };

export interface PreventCsvColumn {
  /** CSV のヘッダ。**当社で言い換えない**（仕様 §4.2 の表記 or 設問文の逐語）。 */
  header: string;
  /** 仕様 §4.2 の行番号への対応（**メタデータ。CSV には出さない**）。 */
  rows: string;
  source: PreventCsvSource;
}

/**
 * 列の定義。**先方様式が確定したらこの配列だけを直す。**
 *
 * 並びは仕様 §4.2 の行番号順（§6「各社シートの並びが基準」）。
 */
export const PREVENT_CSV_COLUMNS: readonly PreventCsvColumn[] = [
  // ── 基本情報（行3-7）。ヘッダは仕様 §4.2 の表記 ──
  { header: '会員ID/ユーザーID', rows: '3', source: { kind: 'barcode_no' } },
  { header: '生年月日', rows: '4', source: { kind: 'subject', field: 'date_of_birth' } },
  { header: '性別', rows: '5', source: { kind: 'subject', field: 'sex' } },
  { header: '身長', rows: '6', source: { kind: 'answer', questionId: 'B-HEIGHT' } },
  { header: '体重', rows: '7', source: { kind: 'answer', questionId: 'B-WEIGHT' } },

  // ── 検体・検査固有（★）。production の AI問診に設問が無い ──
  { header: 'ALAカプセル摂取日時', rows: '8-9',
    source: { kind: 'pending', from: 'kit_progress', note: '2026-09-03 業務合意: 検査キットの進捗管理で取得（入力・保存とも未実装）' } },
  { header: '採尿日時', rows: '10-11',
    source: { kind: 'pending', from: 'kit_progress', note: '2026-09-03 業務合意: 検査キットの進捗管理で取得（入力・保存とも未実装）' } },
  { header: '排尿回数', rows: '12',
    source: { kind: 'pending', from: 'undecided', note: '旧 EX-URINATE-CNT を削除済み。進捗管理にも入力欄が無い' } },

  // ── 疾患関連（行13-23）。ヘッダは production の設問文の逐語 ──
  { header: '現在罹患している疾患を教えてください。', rows: '13-23', source: { kind: 'answer', questionId: 'H-CURRENT' } },
  { header: '過去に罹患した疾患名を教えてください。', rows: '13-23', source: { kind: 'answer', questionId: 'H-PAST' } },
  { header: '選択いただいた疾患の治療状況を教えてください。', rows: '13-23', source: { kind: 'answer', questionId: 'H-TREAT-STATUS' } },
  { header: '選択いただいた疾患の発症時期・治療法を教えてください。', rows: '13-23', source: { kind: 'answer', questionId: 'H-TREAT-DETAIL' } },

  // ── 日常の薬・サプリ（行24）──
  { header: '現在服用中の薬・定期的に摂取しているサプリメント・健康食品はありますか？', rows: '24', source: { kind: 'answer', questionId: 'M-HAS' } },
  { header: '服用中の薬・サプリメント・健康食品の名前を教えてください。（薬は用途もあれば）', rows: '24', source: { kind: 'answer', questionId: 'M-NAME' } },
  { header: 'その薬・サプリメント・健康食品の摂取期間を教えてください。', rows: '24', source: { kind: 'answer', questionId: 'M-PERIOD' } },
  { header: 'その薬・サプリメント・健康食品の摂取頻度を教えてください。', rows: '24', source: { kind: 'answer', questionId: 'M-FREQ' } },

  // ── 採尿前日（行25-26）。★ ──
  { header: '採尿前日の薬', rows: '25',
    source: { kind: 'pending', from: 'undecided', note: '旧 EX-URINE-MED / EX-URINE-MED-NAME を削除済み' } },
  { header: '採尿前日の飲酒', rows: '26',
    source: { kind: 'pending', from: 'undecided', note: '旧 EX-URINE-ALC を削除済み' } },

  // ── 喫煙（行27-29）──
  { header: '喫煙習慣はありますか？', rows: '27-29', source: { kind: 'answer', questionId: 'S-STATUS' } },
  { header: '1日の喫煙本数を教えてください。（喫煙者は現在、禁煙者は過去の本数）', rows: '27-29', source: { kind: 'answer', questionId: 'S-COUNT' } },
  { header: '喫煙している、又は、していた年数を教えてください。', rows: '27-29', source: { kind: 'answer', questionId: 'S-YEARS' } },
  { header: '喫煙を止めた年齢を教えてください。', rows: '27-29', source: { kind: 'answer', questionId: 'S-QUIT-AGE' } },

  // ── 飲酒（行30-34）──
  { header: '現在の飲酒習慣はありますか？', rows: '30-34', source: { kind: 'answer', questionId: 'D-FREQ' } },
  { header: '飲酒する、又は、していた際の、1回あたりの飲酒量を教えてください。', rows: '30-34', source: { kind: 'answer', questionId: 'D-AMOUNT' } },
  { header: '飲酒している、又は、していた年数を教えてください。', rows: '30-34', source: { kind: 'answer', questionId: 'D-YEARS' } },
  { header: '何歳まで飲酒されていたか教えてください。', rows: '30-34', source: { kind: 'answer', questionId: 'D-UNTIL-AGE' } },

  // ── 採尿検体の冷凍保存（行35）。★ ──
  { header: '採尿検体の冷凍保存', rows: '35',
    source: { kind: 'pending', from: 'undecided', note: '旧 EX-FROZEN を削除済み' } },
];

/** CSV の列数（画面の「項目数」に出す実測値。**「約33項目」と名乗らない**）。 */
export const PREVENT_CSV_COLUMN_COUNT = PREVENT_CSV_COLUMNS.length;

/**
 * **この様式が先方確定かどうか。**
 *
 * `'unconfirmed'` = 先方提供 Excel を再現できていない暫定様式
 * （= **本番配布不可**。`labid.prevent_csv_release` を on にしてはいけない）。
 * Excel を受領して列順・ヘッダ行数・選択肢コード・文字コード・改行を合わせたら
 * `'confirmed'` にする。**この値を変えるのは様式を合わせたときだけ。**
 */
export const PREVENT_CSV_FORMAT_STATUS: 'unconfirmed' | 'confirmed' = 'unconfirmed';

/** 先方確定待ちの項目（画面・監査に出す。**どこから来るはずか**を添える）。 */
export const PREVENT_CSV_PENDING_COLUMNS = PREVENT_CSV_COLUMNS
  .filter((c) => c.source.kind === 'pending')
  .map((c) => ({ header: c.header, rows: c.rows, from: (c.source as { from: string }).from }));

/**
 * CSV のファイル名。**バーコードNo. そのもの**。
 *
 * 先方要望（2026-10）:「現在整理番号とされているファイル名は、検査セットの
 * バーコードNo. で対応してほしい」。→ `704000123.csv`。
 * **prefix / suffix を付けない** — 付ける根拠がコードにも合意資料にも無い
 * （LAiF の `input_wellfort_laif_{id}.xlsx` は**先方提供フォームの名前**で、
 * プリベントには当てはまらない）。
 */
export function preventCsvFilename(barcodeNo: string): string {
  return `${barcodeNo}.csv`;
}

/** 1 問ぶんの回答（S3 の `LifestyleQuestionnaireData` の `data.answers[]` の形）。 */
export interface PreventAnswerRow {
  id: string;
  /** 表示用ラベル。**選択肢コードへ変換しない**（変換マスタが未確定・§7-3）。 */
  answer_label?: string | null;
}

export interface PreventCsvSubject {
  /** `YYYY-MM-DD`。取れなければ null（空欄にする・捏造しない）。 */
  dateOfBirth: string | null;
  sex: 'male' | 'female' | null;
}

export interface BuildPreventCsvInput {
  /** 受取時に確定した バーコードNo.（正規化済み）。 */
  barcodeNo: string;
  subject: PreventCsvSubject;
  answers: readonly PreventAnswerRow[];
}

export interface BuildPreventCsvResult {
  /** `704000123.csv`。 */
  filename: string;
  /** CSV 本体（BOM つき）。 */
  csv: string;
  /** 列数。 */
  columnCount: number;
  /** 値が入った列の数（監査・画面の目安用）。 */
  filledCount: number;
}

/** 性別の表記。**プリベント様式の選択肢が未確定**なので、和文 1 文字で出す。 */
function sexLabel(sex: 'male' | 'female' | null): string {
  if (sex === 'male') return '男';
  if (sex === 'female') return '女';
  return '';
}

/** RFC4180 のクォート。改行・カンマ・引用符を含む値だけ囲む。 */
export function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * CSV を組み立てる。
 *
 * **行3 とファイル名は同じ `barcodeNo` から派生する**（引数が 1 つなので、
 * ここで食い違うことが構造的に起きない）。
 */
export function buildPreventQuestionnaireCsv(input: BuildPreventCsvInput): BuildPreventCsvResult {
  const byId = new Map<string, PreventAnswerRow>();
  for (const a of input.answers) {
    if (a && typeof a.id === 'string' && a.id) byId.set(a.id, a);
  }

  const values = PREVENT_CSV_COLUMNS.map((col) => {
    const s = col.source;
    if (s.kind === 'barcode_no') return input.barcodeNo;
    if (s.kind === 'subject') {
      return s.field === 'date_of_birth' ? (input.subject.dateOfBirth ?? '') : sexLabel(input.subject.sex);
    }
    if (s.kind === 'answer') {
      const a = byId.get(s.questionId);
      const label = typeof a?.answer_label === 'string' ? a.answer_label.trim() : '';
      return label;
    }
    // pending: **常に空**。別ソースが実装されるまで、ここで何かを入れたら捏造になる。
    return '';
  });

  const header = PREVENT_CSV_COLUMNS.map((c) => csvCell(c.header)).join(',');
  const row = values.map((v) => csvCell(v)).join(',');
  // BOM を付ける（Excel で開いたときに文字化けさせない）。改行は RFC4180 の CRLF。
  const csv = `﻿${header}\r\n${row}\r\n`;

  return {
    filename: preventCsvFilename(input.barcodeNo),
    csv,
    columnCount: PREVENT_CSV_COLUMNS.length,
    filledCount: values.filter((v) => v !== '').length,
  };
}
