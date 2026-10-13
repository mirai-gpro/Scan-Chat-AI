/**
 * プリベント向け **問診CSV の一覧と生成**（台帳 ＋ S3 の I/O）。
 *
 * 正本:
 *   - `docs/lab/lab_data_pipeline_master_spec.md` §4-5.3
 *   - `docs/lab/kit_receipt_external_id_capture_spec.md` §7.1 / §7.1.1 / §7.1.2
 *   - `docs/lab/questionnaire_to_lab_csv_spec.md` §4.2
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【3 つのゲートを順に通す。どれも fail-closed】
 * ══════════════════════════════════════════════════════════════════════
 *   ① **配布の有効化** … app_config `labid.prevent_csv_release`（既定 off）。
 *      off のあいだ Partner Portal には**一覧も CSV も出さない**。
 *      **`labid.prevent_capture` とは独立**にしてある — 撮影 UI が off でも
 *      台帳に過去／デモの `confirmed` 行が残っていれば一覧に出得るので、
 *      「撮影が off だから CSV は必ず 0 件」と仮定してはいけない。
 *   ② **外部IDの確定** … `loadCapturedExternalId()` → `checkPreventQuestionnaireGate()`
 *      （`status='confirmed'` ∧ `lab_test_link_status='linked'` ∧ `lab_test_id != null`）。
 *      **この 2 つ以外の判定を書かない。**
 *   ③ **問診の相関** … `findInterviewLink()`。**この回の検査に対応する問診**が
 *      機械的に特定できなければ**CSV を出さない**（`prevent-interview-link.ts`）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【「その人の最新問診」を採ってはいけない（初版の誤り）】
 * ══════════════════════════════════════════════════════════════════════
 * 初版は `(diagnostic_user_id)` だけで S3 の最新 `LifestyleQuestionnaireData` を
 * 採っていた。これは**前年の検査に今年の問診を載せられる**。
 * 「問診日を Portal に出すから分かる」は誤配布の防止にならない。
 * → **相関レコードが指す `diagnostic_id` の完全一致でしか読まない。**
 *
 * 【問診の回答は S3 にしか無い】
 * `diagnosis.interview_completions` は**完了日時と設問数と `diagnostic_id` だけ**で、
 * 回答本文を持たない（`interview-completion.ts:11-17`）。実体は
 * `{prefix}user/{uid}/date/{YYYY_MM_DD}/LifestyleQuestionnaireData_date_..._user_{uid}.json`。
 * **鍵がある Scan-Chat-AI 側でしか読めない**ので、CSV 生成はここに置く。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types/supabase';
import { getServerSupabase } from './supabase';
import { getS3Config, getObjectText, listObjects } from './s3';
import { refreshConfig, cfgBool } from './app-config';
import { resolveTargetSubject } from './target-subject';
import { loadCapturedExternalId } from './external-id-persist';
import {
  checkPreventQuestionnaireGate, maskExternalId,
  normalizeExternalId, type PreventGateReason,
} from './external-test-id';
import {
  findInterviewLink, pickInterviewByLink,
  type InterviewObject, type InterviewLink,
} from './prevent-interview-link';
import {
  buildPreventQuestionnaireCsv, preventCsvFilename,
  PREVENT_CSV_COLUMN_COUNT, PREVENT_CSV_FORMAT_STATUS,
} from './prevent-questionnaire-csv';

const PROVIDER = 'prevent' as const;
const TABLE = 'lab_test_id_captures';

/**
 * 先方様式が確定しているか。**判定をここ 1 か所に持つ**
 * （`isPreventCsvReleased` と `holdReason` が別々に判定すると、
 * 片方だけ直したときに「配れないのに理由が違う」状態になる）。
 */
function formatConfirmed(): boolean {
  return PREVENT_CSV_FORMAT_STATUS === 'confirmed';
}

/** 配布が有効か（① のゲート）。**app_config を読む前に `refreshConfig()`**。 */
export async function isPreventCsvReleased(): Promise<boolean> {
  await refreshConfig().catch(() => undefined);
  // **様式が未確定のあいだは、flag が on でも配布しない**（二重の歯止め）。
  if (!formatConfirmed()) return false;
  return cfgBool('labid.prevent_csv_release');
}

/** 一覧の 1 行。**内部 ID は 1 つも入れない**（プリベントへ出すのはバーコードNo. だけ）。 */
export interface PreventQuestionnaireEntry {
  /** 外部表示キー。`704000123`。 */
  barcode_no: string;
  /** 問診データの日付（相関レコードが指す回の `test_date`）。 */
  created_on: string;
  /** CSV の列数（実測）。 */
  item_count: number;
  /** ファイル名。**同じ `barcode_no` から派生**。 */
  filename: string;
}

/** 一覧に出さなかった行の理由（**admin の切り分け用**。プリベントへは返さない）。 */
export interface PreventQuestionnaireSkip {
  masked: string;
  reason: PreventGateReason | 'interview_not_correlated' | 'questionnaire_missing';
}

export interface PreventQuestionnaireListResult {
  /** 配布が有効か。false のときは `entries` が必ず空。 */
  released: boolean;
  /** 配布が無効な理由（`released: false` のときだけ）。 */
  holdReason?: 'format_unconfirmed' | 'release_disabled';
  entries: PreventQuestionnaireEntry[];
  skipped: PreventQuestionnaireSkip[];
}

type Row = Record<string, unknown>;

interface InterviewJson {
  diagnostic_id?: unknown;
  test_date?: unknown;
  data?: { answers?: unknown } | null;
}

/**
 * その人の問診 JSON を**全部**読み出す（選別はしない）。
 *
 * **ここで「最新」を採らない。** 選ぶのは `pickInterviewByLink()` で、
 * 相関レコードが指す `diagnostic_id` の完全一致だけ。
 */
async function listInterviewObjects(uid: string): Promise<InterviewObject[]> {
  const cfg = getS3Config();
  if (!cfg) return [];
  const prefix = cfg.prefix ? cfg.prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  let objs;
  try {
    objs = await listObjects(`${prefix}user/${uid}/date/`);
  } catch {
    return [];
  }
  const keys = objs
    .map((o) => o.key)
    .filter((k) => /\/LifestyleQuestionnaireData_date_\d{4}_\d{2}_\d{2}_user_[^/]+\.json$/.test(k));

  const out: InterviewObject[] = [];
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
    const diagnosticId = typeof json.diagnostic_id === 'string' ? json.diagnostic_id.trim() : '';
    const testDate = typeof json.test_date === 'string' ? json.test_date.slice(0, 10) : '';
    // **`diagnostic_id` が無い書き出しは相関に使えない**（黙って日付で代用しない）。
    if (!diagnosticId || !/^\d{4}-\d{2}-\d{2}$/.test(testDate)) continue;
    const answers: InterviewObject['answers'] = [];
    for (const a of raw) {
      const o = a as Row;
      if (o && typeof o.id === 'string' && o.id) {
        answers.push({ id: o.id, answer_label: typeof o.answer_label === 'string' ? o.answer_label : null });
      }
    }
    out.push({ key, diagnosticId, testDate, answers });
  }
  return out;
}

/** 「この回の検査」の問診を特定して読む。**相関が無ければ null**。 */
async function resolveInterviewForLabTest(args: {
  sb: SupabaseClient<Database>;
  diagnosticUserId: string;
  labTestId: string;
}): Promise<{ ok: true; link: InterviewLink; obj: InterviewObject }
  | { ok: false; reason: 'interview_not_correlated' | 'questionnaire_missing' }> {
  const lookup = await findInterviewLink(args);
  // **相関が取れないときは、ここで止まる。**「最新を採る」経路は存在しない。
  if (!lookup.ok) return { ok: false, reason: 'interview_not_correlated' };

  const objects = await listInterviewObjects(args.diagnosticUserId);
  const obj = pickInterviewByLink(objects, lookup.link);
  if (!obj) return { ok: false, reason: 'questionnaire_missing' };
  return { ok: true, link: lookup.link, obj };
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
 * **3 つのゲートを全部通ったものだけ**を返す。通らなかった行は `skipped`
 * （マスク＋理由）に入れる — admin が「なぜ出ていないのか」を辿れるようにするためで、
 * **プリベントには返さない**（中継が落とす）。
 */
export async function listPreventQuestionnaires(): Promise<PreventQuestionnaireListResult> {
  // ① 配布の有効化。**off なら台帳も S3 も見ない**（漏れる経路を作らない）。
  if (!(await isPreventCsvReleased())) {
    return {
      released: false,
      holdReason: !formatConfirmed() ? 'format_unconfirmed' : 'release_disabled',
      entries: [],
      skipped: [],
    };
  }

  const sb = getServerSupabase();
  if (!sb) return { released: true, entries: [], skipped: [] };

  const rows = await listLedgerRows(sb);
  const entries: PreventQuestionnaireEntry[] = [];
  const skipped: PreventQuestionnaireSkip[] = [];

  for (const row of rows) {
    /*
     * ② **この回のレコードを引き直す。** 一覧の SQL で `status` を絞らないのは、
     * ゲートを 2 か所に持たないため。`labTestId` が無い行は引けないので
     * `capture_missing` に落ちる＝**fail-closed**。
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

    // ③ 問診の相関。**取れなければ出さない。**
    const iv = await resolveInterviewForLabTest({
      sb, diagnosticUserId: row.uid, labTestId: capture!.labTestId!,
    });
    if (!iv.ok) {
      skipped.push({ masked: maskExternalId(barcodeNo), reason: iv.reason });
      continue;
    }

    entries.push({
      barcode_no: barcodeNo,
      created_on: iv.obj.testDate,
      item_count: PREVENT_CSV_COLUMN_COUNT,
      filename: preventCsvFilename(barcodeNo),
    });
  }

  entries.sort((a, b) =>
    a.created_on === b.created_on
      ? a.barcode_no.localeCompare(b.barcode_no)
      : (a.created_on < b.created_on ? 1 : -1),
  );
  return { released: true, entries, skipped };
}

export type PreventQuestionnaireFileResult =
  | {
      ok: true; filename: string; csv: string; barcodeNo: string;
      columnCount: number; filledCount: number;
      /** **先方様式が確定しているか。** `'unconfirmed'` は本番配布不可。 */
      formatStatus: typeof PREVENT_CSV_FORMAT_STATUS;
    }
  | { ok: false; status: number; error: string; detail: string };

/**
 * 1 件ぶんの問診CSV を作る。**入口はバーコードNo.**（プリベントが外で見ている値）。
 *
 * @param opts.skipReleaseGate **当社内部の様式確認（テスト用 preview）のときだけ true**。
 *   Partner Portal からは絶対に true にならない — 中継の mode allow-list が
 *   `list` / `download` だけで、`preview` を上流へ通さない。
 *
 * 処理順（**ゲートより前に何も渡さない**）:
 *   0. 配布の有効化（preview のときだけ飛ばす）
 *   1. バーコードNo. を正規化する（画面から来た値をそのまま信じない）
 *   2. 台帳から**その番号の有効行**を引く。0 件・2 件以上は**ここで止める**
 *   3. その行の `lab_test_id` で `loadCapturedExternalId()` を呼び直す
 *   4. `checkPreventQuestionnaireGate()` を通す
 *   5. **その `lab_test_id` に相関した問診**を読む（取れなければ止める）
 *   6. **ゲートが返した値**から CSV と ファイル名を派生させる
 */
export async function buildPreventQuestionnaireFile(
  rawBarcodeNo: unknown,
  opts: { skipReleaseGate?: boolean } = {},
): Promise<PreventQuestionnaireFileResult> {
  if (!opts.skipReleaseGate && !(await isPreventCsvReleased())) {
    return {
      ok: false, status: 409, error: 'csv_release_disabled',
      detail: '問診CSV の配布はまだ有効化されていません（様式の確認中です）。',
    };
  }

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
    return { ok: false, status: 404, error: 'not_found', detail: 'この番号に対応する問診CSV はありません。' };
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

  const iv = await resolveInterviewForLabTest({
    sb, diagnosticUserId: uid, labTestId: capture!.labTestId!,
  });
  if (!iv.ok) {
    return {
      ok: false, status: 409, error: iv.reason,
      detail: iv.reason === 'interview_not_correlated'
        ? 'この検査に対応する問診を特定できないため、CSV を作成しません。'
        : 'この検査に対応する問診の回答が見つかりません。',
    };
  }

  const subject = await resolveTargetSubject(uid);
  const built = buildPreventQuestionnaireCsv({
    // **ゲートを通った値**を使う（引数の生値ではない）。
    barcodeNo: capture!.normalizedValue,
    subject,
    answers: iv.obj.answers,
  });

  return {
    ok: true,
    filename: built.filename,
    csv: built.csv,
    barcodeNo: capture!.normalizedValue,
    columnCount: built.columnCount,
    filledCount: built.filledCount,
    formatStatus: PREVENT_CSV_FORMAT_STATUS,
  };
}
