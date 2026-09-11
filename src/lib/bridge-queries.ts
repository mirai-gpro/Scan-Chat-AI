/**
 * app_bridge (HP/EC #1) から顧客バンドル (顧客/プラン/キット) を取得し、
 * 既存の DashboardData の形 (CustomerProfile / Subscription / KitShipment) に適合させる。
 *
 * 統合仕様書 §5 のブリッジ 3 テーブルを参照する。UI コンポーネントを無改修に保つため、
 * 旧 customer スキーマ由来の型へアダプトする (欠落カラムは null)。
 *   - 検査結果系 (lab_received_at / lab_completed_at 等) は #1 に存在しない → null。
 *     「検査完了」表示は #2 (test_artifacts) 側で別途扱う。
 */

import { getBridgeSupabase, getStagingBridgeEndpoint, type BridgeOrigin } from './supabase';
import type { CustomerProfile, KitShipment, Subscription } from '../types/supabase';
import type { BridgeCustomerAccount, BridgeKitShipment, BridgeSubscription } from '../types/supabase-bridge';

export interface CustomerBundle {
  customer: CustomerProfile | null;
  shipments: (KitShipment & { lab_name: string | null })[];
  subscription: (Subscription & { plan_name: string | null }) | null;
}

/** customer_account → CustomerProfile 形 (表示に必要な最小項目のみ。PII は載らない)。 */
function adaptCustomer(a: BridgeCustomerAccount): CustomerProfile {
  return {
    user_id: a.hp_customer_id,
    family_name: a.display_name ?? '',
    given_name: '',
    family_name_kana: null,
    given_name_kana: null,
    sex: a.sex,
    date_of_birth: a.birth_year != null ? `${a.birth_year}-01-01` : null,
    email: null,
    phone: null,
    postal_code: null,
    prefecture: null,
    city: null,
    address_line: null,
    building: null,
    diagnostic_user_id: a.diagnostic_user_id,
    diagnostic_linked_at: null,
    google_sub: null,
    created_at: a.source_updated_at ?? a.synced_at ?? new Date().toISOString(),
    updated_at: a.source_updated_at ?? a.synced_at ?? new Date().toISOString(),
  };
}

/** subscription (bridge) → Subscription 形 + plan_name。 */
function adaptSubscription(
  s: BridgeSubscription,
  hpCustomerId: string,
): Subscription & { plan_name: string | null } {
  return {
    id: s.diagnostic_user_id,
    customer_id: hpCustomerId,
    plan_id: s.plan_code ?? '',
    started_at: s.started_at ?? s.synced_at ?? new Date().toISOString(),
    next_test_at: s.next_test_at,
    last_test_at: s.last_test_at,
    current_cycle_year: null,
    current_cycle_seq: null,
    status: s.status,
    paused_at: null,
    cancelled_at: null,
    created_at: s.synced_at ?? new Date().toISOString(),
    updated_at: s.synced_at ?? new Date().toISOString(),
    plan_name: s.plan_name,
  };
}

/** kit_shipment (bridge, orders 由来) → KitShipment 形 + lab_name。欠落カラムは null。 */
function adaptShipment(s: BridgeKitShipment): KitShipment & { lab_name: string | null } {
  return {
    id: s.id,
    order_id: s.order_id ?? '',
    customer_id: s.diagnostic_user_id,
    lab_company_id: '',
    test_type: s.test_type,
    subscription_id: null,
    subscription_year: null,
    subscription_seq: null,
    warehouse: null,
    shipped_at: s.shipped_at,
    tracking_no: s.tracking_no,
    carrier: null,
    carrier_tracking_url: null,
    expected_arrival_date: null,
    requested_arrival_date: null,
    requested_time_window: null,
    requested_at: null,
    requested_lock_at: null,
    user_received_at: s.user_received_at,
    user_returned_at: s.user_returned_at,
    lab_received_at: null,
    lab_completed_at: null,
    notes: null,
    created_at: s.synced_at ?? new Date().toISOString(),
    // bridge 由来は検査会社名を持たない (HP 非保持)
    lab_name: null,
  };
}

/**
 * app_bridge から顧客バンドルを取得。bridge 未構成時に呼ばれた場合は error を返す。
 */
/** `get-bridge-bundle` の応答 (staging)。中身は app_bridge の生の行。 */
interface StagingBundleResponse {
  success: boolean;
  data?: {
    customer: BridgeCustomerAccount | null;
    subscription: BridgeSubscription | null;
    shipments: BridgeKitShipment[] | null;
  } | null;
  error?: string;
}

/** Edge Function の応答を待つ上限。SSR を止めないため短く切る。 */
const STAGING_BRIDGE_TIMEOUT_MS = 8000;

/**
 * **staging は Edge Function `get-bridge-bundle` をサーバ間で叩く** (2026-09-11 確定)。
 *
 * staging は新しい API キー方式で、`app_bridge_readonly` ロールを名乗る鍵を用意できない。
 * 代わりに staging 側へ関数を置き、その内側で service_role が
 * `customer_account` / `subscription` / `kit_shipment` の 3 表だけを読む。
 * 認証はサーバ間の共有シークレット (`x-bridge-secret`)。
 *
 * **失敗は握り潰さない。** 原因をサーバログに残したうえで `{ error }` を返す
 * (画面は呼び出し側が空で成立させる)。**シークレット・JWT・PII はログに出さない** —
 * 出すのは HTTP ステータスと関数が返したエラー文字列だけ。
 */
async function loadStagingBundleViaFunction(uid: string): Promise<CustomerBundle | { error: string }> {
  const endpoint = getStagingBridgeEndpoint();
  if (!endpoint) return { error: 'staging bridge が未構成です。' };

  let res: Response;
  try {
    res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bridge-secret': endpoint.secret,
      },
      body: JSON.stringify({ diagnostic_user_id: uid }),
      signal: AbortSignal.timeout(STAGING_BRIDGE_TIMEOUT_MS),
    });
  } catch (e) {
    // timeout / 通信断。**uid は診断側の識別子で PII ではない**が、載せない。
    const reason = e instanceof Error ? e.message : String(e);
    console.error('[bridge] staging get-bridge-bundle 呼び出しに失敗:', reason);
    return { error: `staging bridge 呼び出し失敗: ${reason}` };
  }

  if (!res.ok) {
    console.error(`[bridge] staging get-bridge-bundle HTTP ${res.status}`);
    return { error: `staging bridge HTTP ${res.status}` };
  }

  const payload = (await res.json().catch(() => null)) as StagingBundleResponse | null;
  if (!payload?.success) {
    const reason = payload?.error ?? '応答を解釈できません';
    console.error('[bridge] staging get-bridge-bundle が success:false:', reason);
    return { error: `staging bridge: ${reason}` };
  }

  const account = payload.data?.customer ?? null;
  if (!account) {
    // 未連携 (ブリッジに行が無い)。**エラーではない。**
    return { customer: null, shipments: [], subscription: null };
  }

  const sub = payload.data?.subscription ?? null;
  const ships = payload.data?.shipments ?? [];
  return {
    customer: adaptCustomer(account),
    subscription: sub ? adaptSubscription(sub, account.hp_customer_id) : null,
    shipments: ships.map(adaptShipment),
  };
}

export async function loadBridgeBundle(
  uid: string,
  origin: BridgeOrigin = 'production',
): Promise<CustomerBundle | { error: string }> {
  // **staging だけ経路が違う。** production へ落とさない (混線防止)。
  if (origin === 'staging') return loadStagingBundleViaFunction(uid);

  const bridge = getBridgeSupabase(origin);
  if (!bridge) return { error: 'app_bridge が未構成です。' };

  const { data: account, error: accErr } = await bridge
    .from('customer_account')
    .select('*')
    .eq('diagnostic_user_id', uid)
    .maybeSingle();
  if (accErr) return { error: `customer_account: ${accErr.message}` };

  if (!account) {
    // 未連携 (ブリッジに行が無い)
    return { customer: null, shipments: [], subscription: null };
  }

  const [
    { data: subRaw, error: subErr },
    { data: shipRaw, error: shipErr },
  ] = await Promise.all([
    bridge
      .from('subscription')
      .select('*')
      .eq('diagnostic_user_id', uid)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle(),
    bridge
      .from('kit_shipment')
      .select('*')
      .eq('diagnostic_user_id', uid)
      .order('shipped_at', { ascending: false })
      .limit(10),
  ]);
  if (subErr) return { error: `subscription: ${subErr.message}` };
  if (shipErr) return { error: `kit_shipment: ${shipErr.message}` };

  return {
    customer: adaptCustomer(account),
    subscription: subRaw ? adaptSubscription(subRaw, account.hp_customer_id) : null,
    shipments: (shipRaw ?? []).map(adaptShipment),
  };
}
