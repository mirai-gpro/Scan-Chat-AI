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
  PII_COLUMNS,
  SUBJECT_COLUMNS,
  mapCell,
  matchLabel,
  normalizeCell,
  normalizeSex,
  optionLabels,
} from './questionnaire-map';
import { resolveTestDate, type CellValue, type DateResolution } from './health-checkup-xlsx';
// **62 列の写像はここが正本。** 短縮キーの表を使わない (spec §7.4)。
import {
  EXTERNAL_FORM_V1_COLUMNS, EXTERNAL_FORM_V1_EXAM_TYPE,
  checkExternalFormSchema, convertCell, normalizeForm,
  type SchemaCheck,
} from './external-form-contract';

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
  /**
   * **仕様として捨てた列**の数 (§7.4 の `ignored_by_spec`)。
   * 「未対応」ではない — 現 production の AI 問診に存在しない設問なので入れない。
   * `unmapped` (= `needs_review`) と**混ぜて数えない**。
   */
  ignoredBySpec: number;
  /**
   * `needs_review` の件数。
   *
   * **`unmapped` の長さと別に持つ**のは、DB へ保存できるのが件数だけだから —
   * `unmapped[].detail` には回答値そのもの (= 健康情報) が入るので永続化しない (§16)。
   * 復元した問診では `unmapped` は空でこの数だけが残る。
   */
  needsReviewCount: number;
  /** 62 列 schema の検査結果 (外部フォームのときだけ)。 */
  schema?: SchemaCheck;
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
    ignoredBySpec: 0,
    needsReviewCount: 0,
    notes,
  };
}

// ---------------------------------------------------------------------------
// adapter ①: 外部フォーム書き出しの XLSX (62 列)
// ---------------------------------------------------------------------------

/** 先頭の定型 6 列。ここが揃っていれば外部フォームの書き出しとみなす (**分類のヒント用**)。 */
export const EXTERNAL_FORM_LEAD_COLUMNS = [
  'ID',
  '開始時刻',
  '完了時刻',
  'メール',
  '名前',
  '最終変更時刻',
] as const;

/**
 * 見出し行がこの様式か。**先頭 6 列のうち 4 件以上**で成立とする。
 *
 * **これは分類 (どのファイルが問診か) の判定**であって、写像してよいかの判定ではない。
 * 写像の可否は `checkExternalFormSchema()` が 62 列すべてを見て決める。
 */
export function isExternalFormHeader(headers: readonly string[]): boolean {
  const set = new Set(headers.map(normalizeCell));
  const hits = EXTERNAL_FORM_LEAD_COLUMNS.filter((c) => set.has(normalizeCell(c))).length;
  return hits >= 4;
}

/**
 * 62 列 XLSX の 1 行 (= 1 人) を写像する。
 *
 * **写像表は `external-form-contract.ts` の `EXTERNAL_FORM_V1_COLUMNS` だけ** (spec §7.4)。
 * 旧 `COLUMN_TO_QUESTION` の短縮キーは使わない — 実物の見出しは完全な設問文なので
 * 短縮キーでは正規化後の完全一致でも当たらない。
 *
 * **列の位置で引く。** 8 件とも列順が同一と確認済みなので、見出しの表記ゆれで
 * 取りこぼすより位置で引く方が確実 (ずれていれば schema check が先に落とす)。
 *
 * `完了時刻` を問診実施日時として扱い、既存仕様どおり `test_date` を作る。
 */
export function normalizeExternalFormRow(
  headers: readonly string[],
  row: readonly CellValue[],
): QuestionnaireNormalized {
  const out = emptyNormalized('external_form_xlsx_v1', []);
  const schema = checkExternalFormSchema(headers);
  out.schema = schema;
  if (!schema.ok) {
    /*
     * **schema が違ったら 1 列も読まない。**
     *
     * 列がずれたまま読むと**値が別の設問へ入る** — しかも全部 production の
     * 選択肢に当たらないので「未知値」に見え、原因が schema のずれだと分からない。
     * だから読む前に止めて、どの列が食い違ったかだけを出す。
     */
    out.notes.push('schema_mismatch');
    for (const m of schema.mismatches.slice(0, 10)) {
      out.unmapped.push({
        header: `col${m.index}`,
        reason: 'unknown_column',
        detail: `列 ${m.index} が契約と違う (期待: ${m.expected.slice(0, 30)}…)`,
      });
    }
    out.needsReviewCount = out.unmapped.length;
    return out;
  }

  const cell = (index: number): CellValue => (row[index - 1] ?? null) as CellValue;
  let dob: string | null = null;
  const matrix: Record<string, string> = {};

  for (const spec of EXTERNAL_FORM_V1_COLUMNS) {
    const raw = cell(spec.index);
    switch (spec.disposition) {
      case 'IGNORE_METADATA':
      case 'PII_IGNORE':
        // **氏名・メール・Forms の管理列は読まない。** answers にも DB にも載せない。
        break;
      case 'IGNORED_BY_SPEC':
        // 現 production の AI 問診に無い列 (53〜62)。**仕様として捨てる** — 未対応ではない。
        out.ignoredBySpec++;
        break;
      case 'METADATA':
        out.completedAt = resolveTestDate(raw);
        break;
      case 'SUBJECT': {
        const sex = normalizeSex(raw);
        if (sex) out.subject.sex = sex;
        else if (normalizeForm(raw) !== '') {
          out.unmapped.push({ header: '生物学的性別', reason: 'unknown_value', detail: `未知の性別値` });
        }
        break;
      }
      case 'SUBJECT_TRANSIENT':
        // **生年月日は年齢を出すのに使って捨てる。** 保存も納品もしない。
        dob = raw == null ? null : String(raw);
        break;
      case 'ANSWER': {
        const r = convertCell(spec, raw);
        if (r.status === 'mapped') {
          if (spec.rule?.kind === 'matrix') {
            matrix[spec.matrixRow!] = r.value as string;
          } else {
            out.answers[spec.questionId!] = r.value;
            out.mappedCount++;
          }
        } else if (r.status === 'needs_review') {
          out.unmapped.push({ header: spec.questionId!, reason: 'unknown_value', detail: r.detail });
        }
        // skipped (空欄・条件分岐で対象外) は何もしない = review にしない。
        break;
      }
    }
  }

  if (Object.keys(matrix).length > 0) {
    out.answers['F-FREQ'] = matrix as unknown as AnswerValue;
    out.mappedCount++;
  }

  /*
   * **`EXAM-TYPE` は XLSX から推定しない** (契約「EXAM-TYPE（62列外）」)。
   * 62 列に実施検査の申告列は無い。この案件の申込・バッチ文脈から seed する。
   * **Genoplan が増えても商品区分はタイプ2 のまま**なので
   * `ウェルテクト（下記検査の複数パッケージ）` へは変えない。
   */
  out.answers['EXAM-TYPE'] = [...EXTERNAL_FORM_V1_EXAM_TYPE] as unknown as AnswerValue;
  out.mappedCount++;

  /*
   * **年齢の基準日は `完了時刻` だけ** (spec §6.4 / 契約「全体正規化」6)。
   *
   * 以前はここが `new Date()` にフォールバックしていた = **今日を基準に年齢を出していた**。
   * 問診が数か月前のものなら 1 歳ずれるし、「日付を推定・today 補完しない」という
   * 受入条件 (E2E 11) に正面から反する。**解決できなければ age は null。**
   */
  if (out.completedAt.status === 'resolved') {
    out.subject.age = ageFrom(dob, new Date(`${out.completedAt.date}T00:00:00Z`));
    if (dob && out.subject.age === null) {
      out.unmapped.push({ header: '生年月日', reason: 'unknown_value', detail: '生年月日を読めない' });
    }
  } else {
    out.subject.age = null;
    out.notes.push('completed_at_unresolved');
    out.unmapped.push({
      header: '完了時刻',
      reason: 'unknown_value',
      detail: '問診実施日が確定しないため年齢を出していない (today で埋めない)',
    });
  }

  if (out.mappedCount === 0) out.notes.push('no_answers_mapped');
  out.needsReviewCount = out.unmapped.length;
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
 * 問診 PDF の入口。
 *
 * **【v1.1 で本経路から外した】** spec §7.4。
 * 回答が radio / checkbox の**視覚的な選択状態**で表されているため、text 抽出では
 * 選択済みの選択肢も未選択の選択肢も同じ文字列として出てくる。`normalizePdfText()` の
 * 「同じ行か次の行を回答とみなす」方式では**正答を保証できない**。
 * **LLM に選択状態を推測させるのも禁止** (§18)。
 * 対象は 2 名だけなので、誤変換のリスクを負って自動化するより Human Review を採る。
 *
 * → 実際の回答は `questionnaire-manual.ts` の手入力経路から入る。
 *
 * **この関数は本経路から呼ばれない。** 残してあるのは履歴と、
 * 「自動 parse がどう間違うか」を検査で示すため。**新しい呼び出しを足さないこと。**
 */
export function normalizeQuestionnairePdf(text: string): QuestionnaireNormalized {
  const profile = detectPdfProfile(text);
  const out = normalizePdfText(text, profile);
  if (profile === 'unknown') out.notes.push('pdf_profile_unknown');
  return out;
}

/**
 * 問診 PDF を見つけたときの**中身が空の入れ物**。
 *
 * 様式だけ記録し、`answers` は**作らない**。管理者が手で入力するまで
 * `questionnaireIsUsable()` が `needs_review` を返すので、
 * **回答が入っていない `LifestyleQuestionnaireData` は絶対に作られない。**
 */
export function manualEntryPlaceholder(profile: QuestionnaireProfile): QuestionnaireNormalized {
  const out = emptyNormalized(profile, []);
  // 画面に「手入力が要る」と出すための目印。
  out.notes.push('needs_manual_entry');
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
  /*
   * **問診実施日が確定していないものは納品しない** (spec §6.4 / E2E 受入 11)。
   *
   * 既存の `buildElithInterviewJson()` は `completedAt` が無いと
   * **`exported_at` (= 実行時刻) を完了日とみなし `test_date` を今日にする**
   * (`interview-export.ts:250`)。通常のアプリの流れ (ユーザーがいま答え終えた) では
   * それが正しいが、**過去に書かれた外部ファイルを取り込む本経路では今日は捏造**になり、
   * 納品 key の日付フォルダとファイル名もまるごと誤る。
   *
   * **production 側の既定は変えない** (他機能が使っている)。
   * 代わりに「日付が無いものはここまで来させない」で閉じる。
   * 確定できない人物は管理者確認へ回る。
   *
   * **schema が契約と違うものも納品しない** — 値が別の設問へ入っている可能性がある。
   */
  if (n.schema && !n.schema.ok) return false;
  if (n.completedAt.status !== 'resolved') return false;
  return n.mappedCount > 0;
}

/** 画面に出す要約。**回答の中身は出さない** (見出しと件数だけ)。 */
export function questionnaireSummary(n: QuestionnaireNormalized): string {
  /*
   * **3 つを別々に出す** (契約「実装上の必須修正」)。
   *   写像        … production の設問へ入った
   *   仕様対象外  … 現 production の AI 問診に無い列 (53〜62 等)。**未対応ではない**
   *   要確認      … 判断できず人へ渡したもの
   * これを 1 つの「未対応」に混ぜると、**正常に捨てた列と人の確認待ちが区別できない**。
   */
  const parts = [`様式=${n.profile}`, `写像=${n.mappedCount}件`];
  if (n.ignoredBySpec) parts.push(`仕様対象外=${n.ignoredBySpec}件`);
  if (n.needsReviewCount) parts.push(`要確認=${n.needsReviewCount}件`);
  if (n.schema && !n.schema.ok) parts.push(`**列が契約と違う (${n.schema.mismatches.length}件)**`);
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
