/**
 * 外部検査ID の**登録**（撮影台帳への記録 ＋ `customer.lab_tests` への紐付け）。
 *
 * 正本: `docs/lab/kit_receipt_external_id_capture_spec.md` §6.3 / §8。
 * 紐付け方式は **案A（登録時に `lab_tests` 行を作る）** ＝ 発注者裁定 2026-10-11。
 *
 * 【案A を選んだ前提と、そこから出てくる制約】
 * `customer.lab_tests` は**行を作るコードがどこにも無かった**（SELECT は
 * `src/lib/chat-context.ts:79-80` の 1 か所だけ・実測 grep）。だから「登録時に作る」。
 * ただし本番の形がそのまま使えないので、材料は**その場で引き直す**:
 *
 *   - `lab_company_id` (NOT NULL FK) … 本番の shipment は **`lab_company_id: ''`**
 *     （`bridge-queries.ts:75` — app_bridge は検査会社を持たない）。
 *     → `customer.lab_companies.test_types` に当該 `test_type` を含む行から引く。
 *   - `customer_id` (NOT NULL FK → customer_profiles) … 本番の shipment の
 *     `customer_id` は実は **`diagnostic_user_id`**（`bridge-queries.ts:74`）。
 *     → `customer.customer_profiles` を `diagnostic_user_id` で引き直す。
 *   - `shipment_id` (FK → customer.kit_shipments) … 本番の受取 ID は
 *     **`orders.id`** で `customer.kit_shipments` に**存在しない**。
 *     → **その ID で実在を確かめた時だけ入れる。無ければ NULL**（列は nullable）。
 *       ここを埋めに行くと本番で必ず FK 違反になる。
 *
 * 【材料が揃わなくても撮影を落とさない】
 * `customer_profiles` / `lab_companies` の行が無い環境では `lab_tests` を作れない。
 * そのとき**登録ごと失敗させない** — 台帳には必ず記録し、
 * `lab_test_link_status='deferred'` と理由を残す。「サイレント脱落ゼロ」の方を採る。
 * 黙って成功を装うのではなく、**どこまでできたかを返す**。
 *
 * 【重複は自動で上書きしない】
 * 同じ値が別の検査に既に在れば `conflict` にして `lab_tests` は触らない（仕様 §8.2）。
 * ユーザーには一般化したエラーを返す（他人の検査の存在を漏らさない）。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types/supabase';
import {
  PROVIDER_ID_COLUMN, PROVIDER_ID_KIND, PROVIDER_TEST_TYPE,
  maskExternalId, type CaptureMethod, type CaptureStatus, type DecodeMethod,
  type ExternalIdProvider, type ReviewReason,
} from './external-test-id';

/** 1 行ぶんの台帳レコード（返す形）。**外部IDの全文は入れない。** */
export interface CaptureRecord {
  id: string;
  provider: ExternalIdProvider;
  status: CaptureStatus;
  masked: string;
  reviewReasons: ReviewReason[];
  labTestId: string | null;
  labTestLinkStatus: 'linked' | 'deferred' | 'conflict';
  labTestLinkDetail: string | null;
}

export type PersistResult =
  | { ok: true; record: CaptureRecord; duplicate: false }
  | { ok: false; status: number; error: string; detail: string };

export interface PersistInput {
  sb: SupabaseClient<Database>;
  diagnosticUserId: string;
  /** 受取確認の対象 ID（dev=`kit_shipments.id` / 本番=`orders.id`）。 */
  shipmentRef: string;
  provider: ExternalIdProvider;
  testType: string;
  value: string;
  status: CaptureStatus;
  captureMethod: CaptureMethod;
  decodeMethod: DecodeMethod;
  reviewReasons: ReviewReason[];
  evidenceKey: string | null;
  /** 既存の登録を**上書きする**ときの監査情報（通常のユーザー操作では使わない）。 */
  correction?: { by: string; reason: string } | null;
}

type Row = Record<string, unknown>;

const TABLE = 'lab_test_id_captures';

/**
 * 台帳へ記録し、可能なら `lab_tests` へ紐付ける。
 *
 * 処理順（**失敗したら前の段を巻き戻さず、どこまで進んだかを残す**）:
 *   1. 同じ値が**別の検査**に在るか見る → 在れば `conflict` で確定し `lab_tests` は触らない
 *   2. 既に有効な撮影行があるか見る（二重 submit / 撮り直し）
 *   3. `lab_tests` の行を確定（案A・引けなければ `deferred`）
 *   4. 台帳へ upsert（旧行は `superseded` に落とす）
 */
export async function persistExternalIdCapture(input: PersistInput): Promise<PersistResult> {
  const {
    sb, diagnosticUserId, shipmentRef, provider, testType, value,
    captureMethod, decodeMethod, evidenceKey,
  } = input;

  const cust = sb.schema('customer');
  const reasons = [...input.reviewReasons];
  let status: CaptureStatus = input.status;

  // ── 1) 同じ値が別の検査に在るか ───────────────────────────────────
  // **一意制約に頼らない**（prevent は `external_barcode` に unique が無い）。
  const dup = await cust
    .from(TABLE)
    .select('id, diagnostic_user_id, shipment_ref')
    .eq('provider', provider)
    .eq('normalized_value', value)
    .neq('status', 'superseded');
  if (dup.error) {
    return { ok: false, status: 503, error: 'ledger_unavailable', detail: dup.error.message };
  }
  const foreign = (dup.data ?? []).filter(
    (r) => (r as Row).diagnostic_user_id !== diagnosticUserId || (r as Row).shipment_ref !== shipmentRef,
  );

  let linkStatus: 'linked' | 'deferred' | 'conflict' = 'deferred';
  let linkDetail: string | null = null;
  let labTestId: string | null = null;

  if (foreign.length > 0) {
    // **自動上書き禁止。** `lab_tests` は 1 バイトも触らない。
    linkStatus = 'conflict';
    linkDetail = `同じ外部IDが他の検査に ${foreign.length} 件登録されています (自動では紐付けません)`;
    status = 'review_required';
    if (!reasons.includes('pattern_mismatch')) { /* 理由コードは増やさない */ }
  } else {
    // ── 3) lab_tests の行を確定（案A） ──────────────────────────────
    const link = await linkLabTest({ sb, diagnosticUserId, shipmentRef, provider, testType, value });
    linkStatus = link.linkStatus;
    linkDetail = link.detail;
    labTestId = link.labTestId;
    if (link.linkStatus !== 'linked') status = 'review_required';
  }

  // ── 2/4) 旧行を superseded に落として入れ直す ────────────────────
  const prior = await cust
    .from(TABLE)
    .select('id, normalized_value')
    .eq('diagnostic_user_id', diagnosticUserId)
    .eq('shipment_ref', shipmentRef)
    .eq('provider', provider)
    .neq('status', 'superseded')
    .maybeSingle();
  if (prior.error) {
    return { ok: false, status: 503, error: 'ledger_unavailable', detail: prior.error.message };
  }

  const priorRow = prior.data as Row | null;
  if (priorRow) {
    const priorValue = String(priorRow.normalized_value ?? '');
    // **同じ値の再送はそのまま成功扱い**（二重 submit で行が増えない・仕様 §6.3）。
    if (priorValue === value && !input.correction) {
      const upd = await cust
        .from(TABLE)
        .update({
          status, review_reasons: reasons,
          lab_test_id: labTestId, lab_test_link_status: linkStatus, lab_test_link_detail: linkDetail,
          confirmed_at: new Date().toISOString(),
        })
        .eq('id', priorRow.id as string)
        .select('id')
        .maybeSingle();
      if (upd.error) {
        return { ok: false, status: 503, error: 'ledger_write_failed', detail: upd.error.message };
      }
      return {
        ok: true, duplicate: false,
        record: toRecord(String(priorRow.id), provider, status, value, reasons, labTestId, linkStatus, linkDetail),
      };
    }
    // 値が変わる = 撮り直し / 訂正。旧行は消さずに superseded へ。
    const sup = await cust
      .from(TABLE)
      .update({ status: 'superseded' })
      .eq('id', priorRow.id as string);
    if (sup.error) {
      return { ok: false, status: 503, error: 'ledger_write_failed', detail: sup.error.message };
    }
  }

  const now = new Date().toISOString();
  const ins = await cust
    .from(TABLE)
    .insert({
      diagnostic_user_id: diagnosticUserId,
      shipment_ref: shipmentRef,
      provider,
      test_type: testType,
      id_kind: PROVIDER_ID_KIND[provider],
      normalized_value: value,
      capture_method: captureMethod,
      decode_method: decodeMethod,
      review_reasons: reasons,
      evidence_key: evidenceKey,
      status,
      lab_test_id: labTestId,
      lab_test_link_status: linkStatus,
      lab_test_link_detail: linkDetail,
      captured_at: now,
      confirmed_at: now,
      previous_value: priorRow ? String(priorRow.normalized_value ?? '') : null,
      corrected_at: input.correction ? now : null,
      corrected_by: input.correction?.by ?? null,
      correction_reason: input.correction?.reason ?? null,
    })
    .select('id')
    .maybeSingle();
  if (ins.error || !ins.data) {
    return {
      ok: false, status: 503, error: 'ledger_write_failed',
      detail: ins.error?.message ?? '台帳へ書けませんでした',
    };
  }

  return {
    ok: true, duplicate: false,
    record: toRecord(String((ins.data as Row).id), provider, status, value, reasons, labTestId, linkStatus, linkDetail),
  };
}

function toRecord(
  id: string, provider: ExternalIdProvider, status: CaptureStatus, value: string,
  reasons: ReviewReason[], labTestId: string | null,
  linkStatus: 'linked' | 'deferred' | 'conflict', linkDetail: string | null,
): CaptureRecord {
  return {
    id, provider, status,
    masked: maskExternalId(value),
    reviewReasons: reasons,
    labTestId,
    labTestLinkStatus: linkStatus,
    labTestLinkDetail: linkDetail,
  };
}

interface LinkResult {
  labTestId: string | null;
  linkStatus: 'linked' | 'deferred';
  detail: string | null;
}

/**
 * **案A の本体** — `customer.lab_tests` の行を確定して外部IDを入れる。
 *
 * - 既存行（同じ人・同じ `test_type`）が 1 件ならそこへ入れる。
 * - **2 件以上なら触らない**（どれが今回かを機械が決めてよい場面ではない）。
 * - 無ければ作る。**材料が揃わなければ作らず `deferred`**。
 */
async function linkLabTest(args: {
  sb: SupabaseClient<Database>;
  diagnosticUserId: string;
  shipmentRef: string;
  provider: ExternalIdProvider;
  testType: string;
  value: string;
}): Promise<LinkResult> {
  const cust = args.sb.schema('customer');
  /**
   * どの列へ入れるか。**計算キー `{ [column]: value }` にしない** —
   * Supabase の型が index signature を弾くだけでなく、**列名を取り違えても型で気づけない**。
   * `external_barcode`(物理キットID) と `external_test_id`(外部照会ID) は別物なので、
   * ここは明示的に分ける (仕様 §6.2)。
   */
  const idPatch = (v: string): { external_barcode: string } | { external_test_id: string } =>
    PROVIDER_ID_COLUMN[args.provider] === 'external_barcode'
      ? { external_barcode: v }
      : { external_test_id: v };

  // 既存の lab_tests（この人・この検査種別）
  const existing = await cust
    .from('lab_tests')
    .select('id')
    .eq('diagnostic_user_id', args.diagnosticUserId)
    .eq('test_type', args.testType);
  if (existing.error) {
    return { labTestId: null, linkStatus: 'deferred', detail: `lab_tests 照会に失敗: ${existing.error.message}` };
  }
  const rows = existing.data ?? [];
  if (rows.length > 1) {
    return {
      labTestId: null, linkStatus: 'deferred',
      detail: `lab_tests が ${rows.length} 件あり、どれが今回かを自動で決められません`,
    };
  }
  if (rows.length === 1) {
    const id = String((rows[0] as Row).id);
    const upd = await cust.from('lab_tests').update(idPatch(args.value)).eq('id', id);
    if (upd.error) {
      return { labTestId: null, linkStatus: 'deferred', detail: `lab_tests 更新に失敗: ${upd.error.message}` };
    }
    return { labTestId: id, linkStatus: 'linked', detail: null };
  }

  // ── 新規作成。NOT NULL の材料を引き直す ──────────────────────────
  const prof = await cust
    .from('customer_profiles')
    .select('user_id')
    .eq('diagnostic_user_id', args.diagnosticUserId)
    .maybeSingle();
  if (prof.error) {
    return { labTestId: null, linkStatus: 'deferred', detail: `customer_profiles 照会に失敗: ${prof.error.message}` };
  }
  const customerIdRaw = (prof.data as Row | null)?.user_id;
  const customerId = typeof customerIdRaw === 'string' ? customerIdRaw : '';
  if (!customerId) {
    // **本番でここに来る可能性がある。** 撮影は台帳に残っているので失わない。
    return {
      labTestId: null, linkStatus: 'deferred',
      detail: 'customer_profiles に該当行が無いため lab_tests を作れません (撮影は台帳に記録済み)',
    };
  }

  const company = await cust
    .from('lab_companies')
    .select('id')
    .contains('test_types', [args.testType]);
  if (company.error) {
    return { labTestId: null, linkStatus: 'deferred', detail: `lab_companies 照会に失敗: ${company.error.message}` };
  }
  const companies = company.data ?? [];
  if (companies.length !== 1) {
    return {
      labTestId: null, linkStatus: 'deferred',
      detail: `test_type=${args.testType} に対応する lab_companies が ${companies.length} 件 (1 件でないので決められません)`,
    };
  }

  // `shipment_id` は **customer.kit_shipments に実在するときだけ**入れる。
  // 本番の受取 ID は orders.id なので普通は実在しない → NULL のままにする。
  const ship = await cust.from('kit_shipments').select('id').eq('id', args.shipmentRef).maybeSingle();
  const shipmentId = !ship.error && ship.data ? String((ship.data as Row).id) : null;

  const ins = await cust
    .from('lab_tests')
    .insert({
      shipment_id: shipmentId,
      customer_id: customerId,
      diagnostic_user_id: args.diagnosticUserId,
      lab_company_id: String((companies[0] as Row).id),
      test_type: args.testType,
      ...idPatch(args.value),
      status: 'pending',
      assigned_at: new Date().toISOString(),
      // 'auto_id' = 外部検査IDの一致で割り当てた、の意（DDL のコメント `:157`）。
      assigned_by: 'auto_id',
      notes: '受取時の外部ID撮影で作成 (kit_receipt_external_id_capture_spec)',
    })
    .select('id')
    .maybeSingle();
  if (ins.error || !ins.data) {
    return {
      labTestId: null, linkStatus: 'deferred',
      detail: `lab_tests 作成に失敗: ${ins.error?.message ?? '不明'}`,
    };
  }
  return { labTestId: String((ins.data as Row).id), linkStatus: 'linked', detail: null };
}

/**
 * プリベントの問診CSV 生成が参照する「この人のこの回のバーコードNo.」を引く。
 * **ゲートの判定そのものは `checkPreventQuestionnaireGate()`**（純関数）で行う。
 */
export async function loadCapturedExternalId(args: {
  sb: SupabaseClient<Database>;
  diagnosticUserId: string;
  provider: ExternalIdProvider;
}): Promise<string | null> {
  const r = await args.sb
    .schema('customer')
    .from(TABLE)
    .select('normalized_value, captured_at')
    .eq('diagnostic_user_id', args.diagnosticUserId)
    .eq('provider', args.provider)
    .neq('status', 'superseded')
    .order('captured_at', { ascending: false })
    .limit(1);
  if (r.error) return null;
  const row = (r.data ?? [])[0] as Row | undefined;
  const v = row?.normalized_value;
  return typeof v === 'string' && v ? v : null;
}

/** provider に対応する `test_type`（API の整合検証で使う）。 */
export function expectedTestType(provider: ExternalIdProvider): string {
  return PROVIDER_TEST_TYPE[provider];
}
