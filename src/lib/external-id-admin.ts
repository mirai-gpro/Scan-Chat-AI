/**
 * 受取時・外部検査ID の **admin 確認・訂正経路**（仕様 §8.4 / §12.1）。
 *
 * 正本: `docs/lab/kit_receipt_external_id_capture_spec.md` §12.1
 *       「ON の必須条件 = 『`review_required` の出口』」。
 *
 * 【なぜ要るか】問診CSV のゲートは fail-closed（`confirmed` ∧ `linked` ∧
 * `lab_test_id` 非 null）なので、**例外系の回は撮影が済んでいても先へ進めない**:
 * `barcode_ocr_mismatch` / `pattern_mismatch` / `pattern_unknown` / `manual_entry` /
 * `deferred`（紐付けの材料欠落）/ `conflict`（同じ番号が別の検査に在る）。
 * **この経路が無いと出口が無い** ので、`labid.prevent_capture` を on にする前提条件。
 *
 * 【越えてはいけない線（仕様 §12.1 の 4 点）】
 *   1. **`status` を直に `confirmed` へ書き換える口を作らない。**
 *      訂正も確認も `persistExternalIdCapture()` を通す（重複判定・紐付け・
 *      旧行の `superseded` 化を二重に持たない＝`sanitizeMeasurementsForDelivery` と同じ規律）。
 *   2. **`lab_test_link_status` を手で `linked` にしない。** 紐付けできたかは関数の
 *      戻り値が決める。**画面の表示だけ `linked` にすると黙って壊れる。**
 *   3. **ゲートを緩めて回避しない。** ここは台帳を直すだけで、ゲートには 1 行も触らない。
 *   4. **理由・操作者・時刻を必ず残す**（`correction: { by, reason }` → `previous_value` /
 *      `corrected_at` / `corrected_by` / `correction_reason`）。
 *      **操作者は素の email を保存しない**（`adminIdentity()` の digest を API 側で作る）。
 *
 * 【`confirmed` を admin が与えてよい理由】
 * 画面の利用者には与えない（§12.2 で「画面から値を持ち込む口」を閉じた）。admin は
 * **証跡画像を見てから**決めるので、`manual_entry` を理由コードに残したうえで
 * `confirmed` を与える。**ハードな不変条件（数字の形・発行元の接頭辞 `704`）は
 * ゲートが独立に再判定する**ので、ここで `confirmed` にしても素通りはしない
 * （`checkPreventQuestionnaireGate`・`external-test-id.ts`）。
 *
 * 【0 件 / 複数件を自動確定しない】
 * 対象は**画面で開いた 1 行**（`captureId`）だけ。一括の口は作らない。
 * 見ていた行が既に `superseded` なら **409** で止める（別の admin か利用者の
 * 撮り直しが入った回に、古い画面の判断で上書きしない）。
 *
 * 【外部IDの全文を撒かない】
 * 一覧はマスクだけ。全文は**1 行を意図して開いたとき**（`captureDetail`）だけ返す。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types/supabase';
import {
  checkPreventQuestionnaireGate, evaluateExternalId, isExternalIdProvider,
  maskExternalId, normalizeExternalId, passesStructuralGuard,
  type CaptureStatus, type ExternalIdProvider, type LabTestLinkStatus,
  type PreventGateResult, type ReviewReason,
} from './external-test-id';
import { persistExternalIdCapture, type CaptureRecord } from './external-id-persist';
import { createEvidenceViewUrl } from './external-id-evidence';

const TABLE = 'lab_test_id_captures';

/** 理由の文字数上限。**監査に残るので空は認めない**。 */
export const REASON_MAX = 500;

type Row = Record<string, unknown>;

/** 一覧の絞り込み。既定は `review` = **出口を要する行だけ**。 */
export type AdminBucket = 'review' | 'confirmed' | 'all';

export interface AdminCaptureRow {
  id: string;
  diagnosticUserId: string;
  shipmentRef: string;
  provider: string;
  testType: string;
  status: string;
  /** **マスクだけ**（末尾 4 桁）。全文は detail でしか返さない。 */
  masked: string;
  reviewReasons: string[];
  captureMethod: string;
  decodeMethod: string;
  labTestId: string | null;
  labTestLinkStatus: string;
  labTestLinkDetail: string | null;
  /** 証跡画像が在るか（キーは返さない＝画面に S3 のパスを出さない）。 */
  hasEvidence: boolean;
  capturedAt: string | null;
  confirmedAt: string | null;
  /** 訂正の履歴（**値そのものは出さない**）。 */
  correctedAt: string | null;
  correctionReason: string | null;
  hasPrevious: boolean;
  /**
   * **問診CSV のゲートを実関数で判定した結果。**
   * 画面に「なぜ先へ進めないのか」を出すため。**画面側で条件を書き直さない。**
   */
  gate: PreventGateResult;
}

export type AdminListResult =
  | { ok: true; rows: AdminCaptureRow[]; count: number; migrationApplied: boolean }
  | { ok: false; status: number; error: string; detail: string };

export interface AdminConfig {
  /** `labid.prevent_pattern` 等（provider ごと）。 */
  patternFor: (provider: ExternalIdProvider) => string;
  /** `labid.prevent_org_prefix`（provider ごと・デメカルは空＝判定しない）。 */
  orgPrefixFor: (provider: ExternalIdProvider) => string;
}

/** 台帳が未適用（テーブルが無い）ことを**0 件と混同しない**ための判定。 */
function looksMissingTable(message: string): boolean {
  return /does not exist|relation .* does not exist|schema cache|42P01/i.test(message);
}

/*
 * **1 本のリテラルで書く。** 配列の `join()` も文字列の `+` 連結も、supabase-js は
 * 列名を型として読めず（`GenericStringError`）戻り値の型が崩れる（実測）。
 * 長い 1 行になるが、型が効く形はこれだけ。
 */
const SELECT_COLS = 'id, diagnostic_user_id, shipment_ref, provider, test_type, status, normalized_value, review_reasons, capture_method, decode_method, evidence_key, lab_test_id, lab_test_link_status, lab_test_link_detail, captured_at, confirmed_at, previous_value, corrected_at, correction_reason' as const;

function gateOf(row: Row, cfg: AdminConfig): PreventGateResult {
  const provider = String(row.provider ?? '');
  const p = isExternalIdProvider(provider) ? provider : 'prevent';
  return checkPreventQuestionnaireGate({
    capture: {
      normalizedValue: String(row.normalized_value ?? ''),
      status: row.status as CaptureStatus,
      labTestLinkStatus: row.lab_test_link_status as LabTestLinkStatus,
      labTestId: (row.lab_test_id as string | null) ?? null,
    },
    expectedPattern: cfg.patternFor(p),
    orgPrefix: cfg.orgPrefixFor(p),
  });
}

function toAdminRow(row: Row, cfg: AdminConfig): AdminCaptureRow {
  const value = String(row.normalized_value ?? '');
  return {
    id: String(row.id ?? ''),
    diagnosticUserId: String(row.diagnostic_user_id ?? ''),
    shipmentRef: String(row.shipment_ref ?? ''),
    provider: String(row.provider ?? ''),
    testType: String(row.test_type ?? ''),
    status: String(row.status ?? ''),
    masked: maskExternalId(value),
    reviewReasons: Array.isArray(row.review_reasons) ? (row.review_reasons as string[]) : [],
    captureMethod: String(row.capture_method ?? ''),
    decodeMethod: String(row.decode_method ?? ''),
    labTestId: (row.lab_test_id as string | null) ?? null,
    labTestLinkStatus: String(row.lab_test_link_status ?? ''),
    labTestLinkDetail: (row.lab_test_link_detail as string | null) ?? null,
    hasEvidence: typeof row.evidence_key === 'string' && row.evidence_key !== '',
    capturedAt: (row.captured_at as string | null) ?? null,
    confirmedAt: (row.confirmed_at as string | null) ?? null,
    correctedAt: (row.corrected_at as string | null) ?? null,
    correctionReason: (row.correction_reason as string | null) ?? null,
    hasPrevious: typeof row.previous_value === 'string' && row.previous_value !== '',
    gate: gateOf(row, cfg),
  };
}

/**
 * 台帳の一覧。**`superseded` は出さない**（旧行は監査用に残っているだけ）。
 *
 * `bucket='review'` は **「ゲートを通らない行」** を出す。`status` だけで絞らないのは、
 * `confirmed` でも `deferred` / `conflict` で止まっている回があるから
 * （`status` と `lab_test_link_status` は別軸・ゲートは両方を見る）。
 */
export async function listAdminCaptures(input: {
  sb: SupabaseClient<Database>;
  bucket?: AdminBucket;
  limit?: number;
  cfg: AdminConfig;
}): Promise<AdminListResult> {
  const bucket: AdminBucket = input.bucket ?? 'review';
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 200), 1), 500);

  const res = await input.sb
    .schema('customer')
    .from(TABLE)
    .select(SELECT_COLS)
    .neq('status', 'superseded')
    .order('captured_at', { ascending: false })
    .limit(limit);

  if (res.error) {
    if (looksMissingTable(res.error.message)) {
      // **「引けなかった」を 0 件と混同しない。** 画面に警告を出すための明示のフラグ。
      return { ok: true, rows: [], count: 0, migrationApplied: false };
    }
    return { ok: false, status: 503, error: 'ledger_unavailable', detail: res.error.message };
  }

  const all = (res.data ?? []).map((r) => toAdminRow(r as Row, input.cfg));
  const rows = bucket === 'all'
    ? all
    : bucket === 'confirmed'
      ? all.filter((r) => r.gate.allowed)
      : all.filter((r) => !r.gate.allowed);
  return { ok: true, rows, count: rows.length, migrationApplied: true };
}

export interface AdminCaptureDetail extends AdminCaptureRow {
  /** **全文**（1 行を意図して開いたときだけ）。 */
  value: string;
  /** 訂正前の値（在れば）。 */
  previousValue: string | null;
  /** 証跡画像の**短時間**の署名 URL（失敗したら null ＋ `evidenceError`）。 */
  evidenceUrl: string | null;
  evidenceError: string | null;
  /** 同じ値を持つ**他の**有効な行（`conflict` の相手）。admin が辿れるように。 */
  duplicates: Array<{
    id: string; diagnosticUserId: string; shipmentRef: string;
    status: string; labTestId: string | null; labTestLinkStatus: string;
  }>;
}

export type AdminDetailResult =
  | { ok: true; detail: AdminCaptureDetail }
  | { ok: false; status: number; error: string; detail: string };

/** 1 行の詳細。**ここだけが外部IDの全文と証跡画像を返す。** */
export async function adminCaptureDetail(input: {
  sb: SupabaseClient<Database>;
  captureId: string;
  cfg: AdminConfig;
}): Promise<AdminDetailResult> {
  const cust = input.sb.schema('customer');
  const got = await cust.from(TABLE).select(SELECT_COLS).eq('id', input.captureId).maybeSingle();
  if (got.error) {
    if (looksMissingTable(got.error.message)) {
      return { ok: false, status: 503, error: 'migration_required', detail: got.error.message };
    }
    return { ok: false, status: 503, error: 'ledger_unavailable', detail: got.error.message };
  }
  if (!got.data) return { ok: false, status: 404, error: 'not_found', detail: '対象の撮影がありません' };

  const row = got.data as Row;
  const value = String(row.normalized_value ?? '');

  // 同じ値を持つ他の有効な行（`conflict` の相手）。**値で検索する口は外に出さない。**
  const dupRes = await cust
    .from(TABLE)
    .select('id, diagnostic_user_id, shipment_ref, status, lab_test_id, lab_test_link_status')
    .eq('provider', String(row.provider ?? ''))
    .eq('normalized_value', value)
    .neq('status', 'superseded');
  const duplicates = (dupRes.data ?? [])
    .filter((r) => String((r as Row).id) !== input.captureId)
    .map((r) => ({
      id: String((r as Row).id ?? ''),
      diagnosticUserId: String((r as Row).diagnostic_user_id ?? ''),
      shipmentRef: String((r as Row).shipment_ref ?? ''),
      status: String((r as Row).status ?? ''),
      labTestId: ((r as Row).lab_test_id as string | null) ?? null,
      labTestLinkStatus: String((r as Row).lab_test_link_status ?? ''),
    }));

  let evidenceUrl: string | null = null;
  let evidenceError: string | null = null;
  if (typeof row.evidence_key === 'string' && row.evidence_key !== '') {
    const v = await createEvidenceViewUrl(row.evidence_key);
    if (v.ok) evidenceUrl = v.url;
    else evidenceError = v.error; // **黙って空にしない**（見えない理由を画面に出す）
  }

  return {
    ok: true,
    detail: {
      ...toAdminRow(row, input.cfg),
      value,
      previousValue: (row.previous_value as string | null) ?? null,
      evidenceUrl,
      evidenceError,
      duplicates,
    },
  };
}

export type AdminCorrectResult =
  | { ok: true; record: CaptureRecord; gate: PreventGateResult; changed: boolean }
  | { ok: false; status: number; error: string; detail: string };

/**
 * **確認（値はそのまま）／訂正（値を直す）**。どちらも同じ経路。
 *
 * `value` を省略 = **確認だけ**（証跡を見て「この値で正しい」と決めた）。
 * `value` を渡す = **訂正**（旧行は `superseded` になり `previous_value` に残る）。
 *
 * **`confirmed` を与えるのはここだけ。** それでも
 *   - 同じ値が別の検査に在れば `persistExternalIdCapture` が `conflict` へ落とす
 *   - `lab_tests` へ紐付けられなければ `review_required` のまま返る
 * ので、**押せば必ず通る訳ではない**。戻り値の `gate` をそのまま画面に出して、
 * 「確定したのに先へ進めない」を admin が見られるようにする。
 */
export async function correctAdminCapture(input: {
  sb: SupabaseClient<Database>;
  captureId: string;
  /** 新しい値。省略・空なら**現在の値のまま確認する**。 */
  value?: string | null;
  reason: string;
  /** `adminIdentity()` の digest。**素の email を渡さない。** */
  correctedBy: string;
  cfg: AdminConfig;
}): Promise<AdminCorrectResult> {
  const reason = (input.reason ?? '').trim();
  if (!reason) {
    return { ok: false, status: 400, error: 'reason_required', detail: '理由は必須です（監査に残します）' };
  }
  if (reason.length > REASON_MAX) {
    return { ok: false, status: 400, error: 'reason_too_long', detail: `理由は ${REASON_MAX} 文字までです` };
  }

  const cust = input.sb.schema('customer');
  const got = await cust
    .from(TABLE)
    .select('id, diagnostic_user_id, shipment_ref, provider, test_type, status, normalized_value, evidence_key')
    .eq('id', input.captureId)
    .maybeSingle();
  if (got.error) {
    if (looksMissingTable(got.error.message)) {
      return { ok: false, status: 503, error: 'migration_required', detail: got.error.message };
    }
    return { ok: false, status: 503, error: 'ledger_unavailable', detail: got.error.message };
  }
  if (!got.data) return { ok: false, status: 404, error: 'not_found', detail: '対象の撮影がありません' };

  const row = got.data as Row;
  if (String(row.status ?? '') === 'superseded') {
    // 見ていた行が**既に置き換わっている**。古い画面の判断で上書きしない。
    return {
      ok: false, status: 409, error: 'already_superseded',
      detail: 'この撮影は撮り直し／別の訂正で置き換わっています。一覧を読み込み直してください。',
    };
  }

  const provider = String(row.provider ?? '');
  if (!isExternalIdProvider(provider)) {
    return { ok: false, status: 400, error: 'unknown_provider', detail: `provider=${provider}` };
  }

  const current = String(row.normalized_value ?? '');
  const raw = typeof input.value === 'string' ? input.value : '';
  const next = raw.trim() === '' ? current : normalizeExternalId(raw);
  if (!next || !passesStructuralGuard(next)) {
    return {
      ok: false, status: 400, error: 'invalid_value',
      detail: '番号は数字だけの形で入力してください（区切り記号は自動で外します）',
    };
  }

  /*
   * **判定は既存の 1 か所で行う**（`evaluateExternalId`）。admin の入力は `manual` 経路なので
   * 理由コードに `manual_entry` が付き、パターン外・接頭辞違いもそのまま記録される。
   * **status は採らない**（`manual_entry` は自動確定を妨げる理由なので `review_required` に
   * なる）。admin は証跡を見て決めているので、ここでは `confirmed` を与える。
   * **理由コードは消さない** — 何を押して確定したのかが台帳に残る。
   */
  const ev = evaluateExternalId({
    provider,
    manual: next,
    expectedPattern: input.cfg.patternFor(provider),
    orgPrefix: input.cfg.orgPrefixFor(provider),
  });
  const reasons: ReviewReason[] = ev.ok ? [...ev.reasons] : ['manual_entry'];

  const saved = await persistExternalIdCapture({
    sb: input.sb,
    diagnosticUserId: String(row.diagnostic_user_id ?? ''),
    shipmentRef: String(row.shipment_ref ?? ''),
    provider,
    testType: String(row.test_type ?? ''),
    value: next,
    status: 'confirmed',
    // **admin の訂正は `manual`**（DB の check 制約もこの 3 値）。
    captureMethod: 'manual',
    decodeMethod: 'manual',
    reviewReasons: reasons,
    // 証跡は**引き継ぐ**（訂正した行からも元の写真を辿れるようにする）。
    evidenceKey: typeof row.evidence_key === 'string' ? row.evidence_key : null,
    correction: { by: input.correctedBy, reason },
  });
  if (!saved.ok) {
    return { ok: false, status: saved.status, error: saved.error, detail: saved.detail };
  }

  const rec = saved.record;
  return {
    ok: true,
    record: rec,
    changed: next !== current,
    gate: checkPreventQuestionnaireGate({
      capture: {
        normalizedValue: next,
        status: rec.status,
        labTestLinkStatus: rec.labTestLinkStatus,
        labTestId: rec.labTestId,
      },
      expectedPattern: input.cfg.patternFor(provider),
      orgPrefix: input.cfg.orgPrefixFor(provider),
    }),
  };
}

export type AdminDiscardResult =
  | { ok: true; id: string }
  | { ok: false; status: number; error: string; detail: string };

/**
 * **無効化（`superseded` へ落とすだけ）**。
 *
 * `conflict` の相手がこちら側の誤登録だったときの出口。これが無いと
 * **`conflict` だけ出口が無い**（同じ値が別の行に在る限り、どちらも確定できない）。
 *
 * 【`persistExternalIdCapture` を通さない唯一の書き込み。なぜ許されるか】
 * 仕様 §12.1 が禁じているのは **`status` を `confirmed` にする口**と
 * **`lab_test_link_status` を手で `linked` にする口**で、理由は
 * 「重複判定と紐付けを二重に持たない」こと。ここは
 *   - **書く値は `superseded` だけ**（`confirmed` も link も 1 バイトも触らない）
 *   - `lab_tests` も触らない
 * ので、その二重化は起きない。`persistExternalIdCapture` が撮り直しのときに
 * やっているのと**同じ 1 行の更新**（`:191-196`）。
 *
 * **行は消さない**（`previous_value` の鎖が切れる）。理由と操作者と時刻を残す。
 */
export async function discardAdminCapture(input: {
  sb: SupabaseClient<Database>;
  captureId: string;
  reason: string;
  correctedBy: string;
}): Promise<AdminDiscardResult> {
  const reason = (input.reason ?? '').trim();
  if (!reason) {
    return { ok: false, status: 400, error: 'reason_required', detail: '理由は必須です（監査に残します）' };
  }
  if (reason.length > REASON_MAX) {
    return { ok: false, status: 400, error: 'reason_too_long', detail: `理由は ${REASON_MAX} 文字までです` };
  }

  const cust = input.sb.schema('customer');
  const upd = await cust
    .from(TABLE)
    .update({
      status: 'superseded',
      corrected_at: new Date().toISOString(),
      corrected_by: input.correctedBy,
      correction_reason: reason,
    })
    // **既に superseded の行は対象にしない**（二重に理由を書き替えない）。
    .eq('id', input.captureId)
    .neq('status', 'superseded')
    .select('id')
    .maybeSingle();
  if (upd.error) {
    if (looksMissingTable(upd.error.message)) {
      return { ok: false, status: 503, error: 'migration_required', detail: upd.error.message };
    }
    return { ok: false, status: 503, error: 'ledger_write_failed', detail: upd.error.message };
  }
  if (!upd.data) {
    return {
      ok: false, status: 409, error: 'already_superseded',
      detail: 'この撮影は既に無効化／置き換えられています。一覧を読み込み直してください。',
    };
  }
  return { ok: true, id: String((upd.data as Row).id ?? input.captureId) };
}
