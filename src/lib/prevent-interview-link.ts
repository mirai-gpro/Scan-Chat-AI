/**
 * 「**この回の検査**に対応する問診」を特定する（**推定しない・fail-closed**）。
 *
 * 正本: `docs/lab/lab_data_pipeline_master_spec.md` §4-5.3 ／
 *       `docs/lab/kit_receipt_external_id_capture_spec.md` §7.1.2。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【なぜこのモジュールが要るか — 最初の実装は間違っていた】
 * ══════════════════════════════════════════════════════════════════════
 * 初版は `(diagnostic_user_id)` だけで **S3 の最新 `LifestyleQuestionnaireData`** を
 * 採っていた。これは**前年の検査に今年の問診を載せられる**（逆もできる）。
 * 「問診日を Portal に出すから分かる」は**誤配布の防止にならない**
 * （先方は番号で検体と突き合わせるので、中身が別の回でも気づけない）。
 *
 * → **「最新だからこれだろう」は禁止。** 相関が機械的に取れないなら**CSV を出さない。**
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【実コードで確認した結論: 今日の DB には相関キーが無い】
 * ══════════════════════════════════════════════════════════════════════
 * | 調べたもの | 結果 |
 * |---|---|
 * | `diagnosis.interview_completions` | `diagnostic_id`（S3 の書き出し識別子）と `completed_at` は持つが、**`lab_test_id` / `shipment_ref` への参照は無い**（`20260915000010_interview_completions.sql`） |
 * | `customer.lab_tests` | 問診への参照 **0 件**（`20260601000010_schemas_and_tables.sql`） |
 * | `customer.lab_test_id_captures` | 問診への参照 **0 件**（`20261011000010_lab_test_id_captures.sql`） |
 * | 回（サイクル）の窓 | `bridge-queries.ts:59,78,79` が `current_cycle_seq` / `subscription_year` / `subscription_seq` を **全部 null** で返す → 窓で切ることもできない |
 * | S3 のキー | `user/{uid}/date/{YYYY_MM_DD}/LifestyleQuestionnaireData_...json` ＝ **人と日付だけ**。検査への参照は無い |
 *
 * **時間の窓で当てる（受取日の前後 N 日の問診を採る等）は推定なので採らない。**
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【このモジュールの作り】
 * ══════════════════════════════════════════════════════════════════════
 * 「**明示的な相関レコード**（`InterviewLink`）を探す」ことだけを行い、
 * 無ければ `null` を返す（＝呼び出し側が fail-closed でブロックする）。
 * **相関の供給元が実装されたら `findInterviewLink()` の中だけを差し替える。**
 * 選別そのもの（どの JSON を読むか）は純関数に分けてあるので、供給元が付いた日に
 * 作り直さずに済む。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types/supabase';

/**
 * 「この回の検査」と「その回の問診」を結ぶ**明示的な**レコード。
 *
 * `diagnosticId` は問診の書き出し識別子で、S3 の
 * `LifestyleQuestionnaireData_*.json` の `diagnostic_id` と同じ値
 * （`interview-export.ts` の `buildElithInterviewJson`）。
 */
export interface InterviewLink {
  labTestId: string;
  diagnosticId: string;
}

export type InterviewLinkLookup =
  | { ok: true; link: InterviewLink }
  /** 相関が無い／取れない。**CSV を出してはいけない。** */
  | { ok: false; reason: 'not_correlated' | 'lookup_failed' };

/**
 * 相関レコードを探す。
 *
 * **現在は常に `not_correlated` を返す。** 上の表のとおり、
 * `lab_tests` ↔ 問診を結ぶ列・表が**どこにも無い**ため。
 * ここで「その人の最新」へ落としてはいけない（それが直した不具合そのもの）。
 *
 * 【相関の供給元は裁定済み（2026-10-13・発注者）— 実装は別タスク（③-1）】
 * **(a) と (b) は二者択一ではない。**
 * (a) = 何を正本キーにするか ／ (b) = そのキーをいつ問診へ結び付けるか。**両方を採る。**
 *
 *   1. **③-1 で `test_instance_ref` を cross-system の正本キーにする**
 *      （`test_instance_ref → lab_tests.id → 出荷 → 受取撮影 → 問診 → 結果`）。
 *   2. **問診完了時に、その問診の `diagnostic_id` と対象 `test_instance_ref` の
 *      明示リンクを保存する。** `interview_completions` へ `lab_test_id` を直接足すのでなく
 *      **link table 型**（`diagnosis.interview_test_links`:
 *      `diagnostic_id` / `test_instance_ref` / `linked_at` / `link_source`）にする —
 *      将来**同じ AI問診を複数の検査が利用する**ことがあり得るため。
 *   3. **日時推定は禁止。**
 *
 * **③-1 が入ったら、この関数の中だけを `interview_test_links` の照会へ差し替える。**
 * migration を伴うので、このモジュールでは作らない。正本 = 仕様 §7.1.2。
 */
export async function findInterviewLink(args: {
  sb: SupabaseClient<Database>;
  diagnosticUserId: string;
  labTestId: string;
}): Promise<InterviewLinkLookup> {
  void args;
  /*
   * **ここに「最新を採る」実装を書かないこと。**
   * 相関の供給元が実装されるまでは `not_correlated` が正しい答えで、
   * 呼び出し側（`prevent-questionnaire.ts`）がそれを受けて CSV を出さない。
   */
  return { ok: false, reason: 'not_correlated' };
}

/** S3 に並んだ問診 JSON の 1 件（キーと、読めた中身の一部）。 */
export interface InterviewObject {
  key: string;
  diagnosticId: string;
  testDate: string;
  answers: Array<{ id: string; answer_label?: string | null }>;
}

/**
 * 相関レコードが指す 1 件を**選ぶだけ**の純関数。
 *
 * **`diagnostic_id` の完全一致でしか選ばない。** 日付が近いもの・最新のものへ
 * 落とさない（落とすと相関の意味が消える）。
 */
export function pickInterviewByLink(
  objects: readonly InterviewObject[],
  link: InterviewLink,
): InterviewObject | null {
  const want = link.diagnosticId.trim();
  if (!want) return null;
  const hits = objects.filter((o) => o.diagnosticId === want);
  // **2 件以上なら選ばない**（同じ識別子が複数あるのは異常。黙って片方を採らない）。
  return hits.length === 1 ? hits[0] : null;
}
