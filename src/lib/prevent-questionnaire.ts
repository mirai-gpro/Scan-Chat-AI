/**
 * プリベント向け **問診CSV の一覧と生成**（台帳 ＋ S3 の I/O）。
 *
 * 正本:
 *   - `docs/lab/lab_data_pipeline_master_spec.md` §4-5.3
 *   - `docs/lab/kit_receipt_external_id_capture_spec.md` §7.1（ゲート）
 *   - `docs/lab/questionnaire_to_lab_csv_spec.md` §4.2（項目）
 *
 * 【ゲートはここで作らない】判定は**既存の 2 つだけ**を使う:
 *   - `loadCapturedExternalId()` … **この回の**台帳レコードを引く
 *   - `checkPreventQuestionnaireGate()` … 通すかどうかを決める（純関数）
 * 独自の `status === 'confirmed'` 判定を書かない。**一覧と DL が同じ関数を通る**ので、
 * 画面を変えても API を直叩きされてもゲートは同じ（§7.1 の「どの経路からでも止まる」）。
 *
 * 【「その人の最新」を引かない（発注者指示 2026-10-11）】
 * 一覧の 1 行 = 台帳の 1 行 = **1 回・1 検査**（`lab_test_id` を持つ）。
 * DL は **バーコードNo. で台帳行を引き、その行の `lab_test_id` で
 * `loadCapturedExternalId()` を呼び直す**。`(diagnostic_user_id, provider)` だけで
 * 最新 1 件を取る経路は 1 つも無い。前年の行は前年の `lab_test_id` に紐づいたままで、
 * 今年の回のものとして出ることはない。
 *
 * 【問診の回答は S3 にしか無い】
 * `diagnosis.interview_completions` は**完了日時と設問数だけ**で、回答本文を持たない
 * （`interview-completion.ts:11-17`「回答の中身は保存しない」）。実体は
 * `{prefix}user/{uid}/date/{YYYY_MM_DD}/LifestyleQuestionnaireData_date_..._user_{uid}.json`
 * （`interview-export.ts:274-293`）。**鍵がある Scan-Chat-AI 側でしか読めない**ので、
 * CSV 生成はここに置く（wellfort-site からは server-to-server で呼ぶ）。
 *
 * 【問診が無い回は一覧に出さない】
 * 出すと「取得」を押しても渡せるものが無い。**押せるものだけを並べる。**
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types/supabase';
import { getServerSupabase } from './supabase';
import { getS3Config, getObjectText, listObjects } from './s3';
import { resolveTargetSubject } from './target-subject';
import { loadCapturedExternalId } from './external-id-persist';
import {
  checkPreventQuestionnaireGate, maskExternalId,
  normalizeExternalId, type PreventGateReason,
} from './external-test-id';
import {
  buildPreventQuestionnaireCsv, preventCsvFilename,
  PREVENT_CSV_COLUMN_COUNT, type PreventAnswerRow,
} from './prevent-questionnaire-csv';

const PROVIDER = 'prevent' as const;
const TABLE = 'lab_test_id_captures';

/** 一覧の 1 行。**内部 ID は 1 つも入れない**（§10・プリベントへ出すのはバーコードNo. だけ）。 */
export interface PreventQuestionnaireEntry {
  /** 外部表示キー。`704000123`。 */
  barcode_no: string;
  /** 問診データの日付（`LifestyleQuestionnaireData.test_date`）。 */
  created_on: string;
  /** CSV の列数（実測）。 */
  item_count: number;
  /** ファイル名。**同じ `barcode_no` から派生**。 */
  filename: string;
}

/** 一覧に出さなかった行の理由（**admin の切り分け用**。プリベントへは返さない）。 */
export interface PreventQuestionnaireSkip {
  masked: string;
  reason: PreventGateReason | 'questionnaire_missing' | 'ledger_row_ambiguous';
}

export interface PreventQuestionnaireListResult {
  entries: PreventQuestionnaireEntry[];
  skipped: PreventQuestionnaireSkip[];
}

type Row = Record<string, unknown>;

/** S3 に置いた問診 JSON（必要なところだけ）。 */
interface InterviewJson {
  test_date?: unknown;
  data?: { answers?: unknown } | null;
}

/**
 * その人の問診 JSON のうち**最新のもの**を S3 から読む。
 *
 * **ここで「最新」を採るのはバーコードNo. ではなく問診データ**。問診の回と検査の回の
 * 相関は現時点でどこにも実装が無い（`interview-cycle.ts` は催促用の判定で、
 * 回窓が取れないときは静穏側へ倒す）。→ **採った問診の日付を一覧に出す**ので、
 * どの時点のデータかはプリベント側で分かる。相関の実装は別タスク。
 */
async function loadLatestInterview(uid: string): Promise<{ testDate: string; answers: PreventAnswerRow[] } | null> {
  const cfg = getS3Config();
  if (!cfg) return null;
  const prefix = cfg.prefix ? cfg.prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  let objs;
  try {
    objs = await listObjects(`${prefix}user/${uid}/date/`);
  } catch {
    return null;
  }
  const keys = objs
    .map((o) => o.key)
    .filter((k) => /\/LifestyleQuestionnaireData_date_\d{4}_\d{2}_\d{2}_user_[^/]+\.json$/.test(k))
    // キーに `date/YYYY_MM_DD/` が入っているので**文字列の降順＝日付の降順**。
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  for (const key of keys) {
    let text: string;
    try {
      text = await getObjectText(key);
    } catch {
      continue;
    }
    let json: InterviewJson;
    try {
      json = JSON.parse(text) as InterviewJson;
    } catch {
      continue;
    }
    const raw = json.data?.answers;
    if (!Array.isArray(raw)) continue;
    const answers: PreventAnswerRow[] = [];
    for (const a of raw) {
      const o = a as Row;
      if (o && typeof o.id === 'string' && o.id) {
        answers.push({
          id: o.id,
          answer_label: typeof o.answer_label === 'string' ? o.answer_label : null,
        });
      }
    }
    const testDate = typeof json.test_date === 'string' ? json.test_date.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(testDate)) continue;
    return { testDate, answers };
  }
  return null;
}

/** 台帳の有効行（provider=prevent）を列挙する。**ゲート判定はここでしない**。 */
async function listLedgerRows(
  sb: SupabaseClient<Database>,
): Promise<Array<{ uid: string; labTestId: string | null; value: string }>> {
  const r = await sb
    .schema('customer')
    .from(TABLE)
    .select('diagnostic_user_id, lab_test_id, normalized_value, captured_at')
    .eq('provider', PROVIDER)
    .neq('status', 'superseded')
    .order('captured_at', { ascending: false })
    .limit(500);
  if (r.error) return [];
  const out: Array<{ uid: string; labTestId: string | null; value: string }> = [];
  for (const row of (r.data ?? []) as Row[]) {
    const uid = typeof row.diagnostic_user_id === 'string' ? row.diagnostic_user_id : '';
    const value = typeof row.normalized_value === 'string' ? row.normalized_value : '';
    if (!uid || !value) continue;
    out.push({
      uid,
      labTestId: typeof row.lab_test_id === 'string' && row.lab_test_id ? row.lab_test_id : null,
      value,
    });
  }
  return out;
}

/**
 * プリベントへ出せる問診CSV の一覧。
 *
 * **ゲートを通ったものだけ**を返す。通らなかった行は `skipped`（マスク＋理由）に入れる
 * — admin が「なぜ出ていないのか」を辿れるようにするためで、**プリベントには返さない**。
 */
export async function listPreventQuestionnaires(): Promise<PreventQuestionnaireListResult> {
  const sb = getServerSupabase();
  if (!sb) return { entries: [], skipped: [] };

  const rows = await listLedgerRows(sb);
  const entries: PreventQuestionnaireEntry[] = [];
  const skipped: PreventQuestionnaireSkip[] = [];

  for (const row of rows) {
    /*
     * **この回のレコードを引き直す。** 一覧の SQL で `status` を絞らないのは、
     * ゲートを 2 か所に持たないため（SQL 側で絞ると、ゲートの条件が変わったときに
     * 片方だけ古くなる）。`labTestId` が無い行は `shipmentRef` でも引けないので
     * 下の capture_missing に落ちる＝**fail-closed**。
     */
    const capture = row.labTestId
      ? await loadCapturedExternalId({
          sb, diagnosticUserId: row.uid, provider: PROVIDER, labTestId: row.labTestId,
        })
      : null;
    const gate = checkPreventQuestionnaireGate({ capture });
    if (!gate.allowed) {
      skipped.push({ masked: maskExternalId(row.value), reason: gate.reason });
      continue;
    }
    const barcodeNo = capture!.normalizedValue;

    const interview = await loadLatestInterview(row.uid);
    if (!interview) {
      skipped.push({ masked: maskExternalId(barcodeNo), reason: 'questionnaire_missing' });
      continue;
    }

    entries.push({
      barcode_no: barcodeNo,
      created_on: interview.testDate,
      item_count: PREVENT_CSV_COLUMN_COUNT,
      filename: preventCsvFilename(barcodeNo),
    });
  }

  // 新しい問診が上。同日は バーコードNo. で安定させる（毎回並びが変わらない）。
  entries.sort((a, b) =>
    a.created_on === b.created_on
      ? a.barcode_no.localeCompare(b.barcode_no)
      : (a.created_on < b.created_on ? 1 : -1),
  );
  return { entries, skipped };
}

export type PreventQuestionnaireFileResult =
  | { ok: true; filename: string; csv: string; barcodeNo: string; columnCount: number; filledCount: number }
  | { ok: false; status: number; error: string; detail: string };

/**
 * 1 件ぶんの問診CSV を作る。**入口はバーコードNo.** （プリベントが外で見ている値）。
 *
 * 処理順（**ゲートより前に何も渡さない**）:
 *   1. バーコードNo. を正規化する（画面から来た値をそのまま信じない）
 *   2. 台帳から**その番号の有効行**を引く。0 件・2 件以上は**ここで止める**
 *   3. その行の `lab_test_id` で `loadCapturedExternalId()` を呼び直す
 *   4. `checkPreventQuestionnaireGate()` を通す
 *   5. 問診 JSON と対象者属性を読む
 *   6. **ゲートが返した値**から CSV と ファイル名を派生させる
 */
export async function buildPreventQuestionnaireFile(
  rawBarcodeNo: unknown,
): Promise<PreventQuestionnaireFileResult> {
  const barcodeNo = normalizeExternalId(rawBarcodeNo);
  if (!barcodeNo) {
    return { ok: false, status: 400, error: 'invalid_barcode_no', detail: 'バーコードNo. の形式が不正です。' };
  }

  const sb = getServerSupabase();
  if (!sb) {
    return { ok: false, status: 503, error: 'supabase_not_configured', detail: 'DB 未設定です。' };
  }

  const r = await sb
    .schema('customer')
    .from(TABLE)
    .select('diagnostic_user_id, lab_test_id')
    .eq('provider', PROVIDER)
    .eq('normalized_value', barcodeNo)
    .neq('status', 'superseded')
    .limit(2);
  if (r.error) {
    return { ok: false, status: 503, error: 'ledger_unavailable', detail: r.error.message };
  }
  const found = (r.data ?? []) as Row[];
  // **2 件見えたら選ばない**（どちらの検査のものか機械では決められない）。
  if (found.length !== 1) {
    return {
      ok: false, status: 404, error: 'not_found',
      detail: 'この番号に対応する問診CSV はありません。',
    };
  }
  const uid = typeof found[0].diagnostic_user_id === 'string' ? found[0].diagnostic_user_id : '';
  const labTestId = typeof found[0].lab_test_id === 'string' && found[0].lab_test_id
    ? found[0].lab_test_id : null;
  if (!uid) {
    return { ok: false, status: 404, error: 'not_found', detail: 'この番号に対応する問診CSV はありません。' };
  }

  const capture = labTestId
    ? await loadCapturedExternalId({ sb, diagnosticUserId: uid, provider: PROVIDER, labTestId })
    : null;
  const gate = checkPreventQuestionnaireGate({ capture });
  if (!gate.allowed) {
    // プリベントには一般化した理由だけ返す（台帳の内情を外へ出さない）。
    return {
      ok: false, status: 409, error: `gate_${gate.reason}`,
      detail: 'この番号の問診CSV はまだ取得できません。Wellfort 側の確認が必要です。',
    };
  }

  const interview = await loadLatestInterview(uid);
  if (!interview) {
    return {
      ok: false, status: 409, error: 'questionnaire_missing',
      detail: 'この番号の問診回答がまだありません。',
    };
  }

  const subject = await resolveTargetSubject(uid);
  const built = buildPreventQuestionnaireCsv({
    // **ゲートを通った値**を使う（引数の生値ではない）。
    barcodeNo: capture!.normalizedValue,
    subject,
    answers: interview.answers,
  });

  return {
    ok: true,
    filename: built.filename,
    csv: built.csv,
    barcodeNo: capture!.normalizedValue,
    columnCount: built.columnCount,
    filledCount: built.filledCount,
  };
}
