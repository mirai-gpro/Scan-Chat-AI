/**
 * app_bridge (HP/EC #1) から顧客バンドル (顧客/プラン/キット) を取得し、
 * 既存の DashboardData の形 (CustomerProfile / Subscription / KitShipment) に適合させる。
 *
 * 統合仕様書 §5 のブリッジ 3 テーブルを参照する。UI コンポーネントを無改修に保つため、
 * 旧 customer スキーマ由来の型へアダプトする (欠落カラムは null)。
 *   - 検査結果系 (lab_received_at / lab_completed_at 等) は #1 に存在しない → null。
 *     「検査完了」表示は #2 (test_artifacts) 側で別途扱う。
 */

import { getBridgeSupabase , type BridgeOrigin } from './supabase';
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
export async function loadBridgeBundle(
  uid: string,
  origin: BridgeOrigin = 'production',
): Promise<CustomerBundle | { error: string }> {
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
