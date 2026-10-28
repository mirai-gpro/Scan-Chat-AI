/**
 * HP/EC #1 `app_bridge` スキーマの型 (手書き)。
 *
 * Web は #1 の app_bridge のみを read-only で参照する (生 PII テーブルは参照しない)。
 * 列定義は統合仕様書「web連携_統合仕様書.md」§5 に準拠。
 *   - customer_account / subscription / kit_shipment (3 テーブル)
 *   - kit_schedule … **2026-10-28 追加**。契約 × 回 × キットの出荷予定。
 *     `kit_shipment` が **1 注文 = 1 行の注文ミラー** (`test_type` は
 *     `test_products.category` の日本語ラベル) でキットの単位を表せないため、
 *     wellfort-site 側に別表を足した (migration 20261028000040)。
 *     **2 つは別物なので取り違えないこと。**
 * ※ news の取得は app_bridge ビューではなく HP の news-feed Edge Function 経由
 *   (案A v0.9)。`supabase/functions/sync-announcements` を参照。
 */

export type BridgeDatabase = {
  app_bridge: {
    Tables: {
      customer_account: {
        Row: {
          diagnostic_user_id: string;
          hp_customer_id: string;
          display_name: string | null;
          sex: string | null;
          birth_year: number | null;
          status: string;
          synced_at: string | null;
          source_updated_at: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      subscription: {
        Row: {
          diagnostic_user_id: string;
          plan_code: string | null;
          plan_name: string | null;
          status: string;
          started_at: string | null;
          next_test_at: string | null;
          last_test_at: string | null;
          synced_at: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      kit_schedule: {
        Row: {
          id: string;
          diagnostic_user_id: string;
          subscription_id: string | null;
          /**
           * `test_kits.kit_code`。genetics / cancer_urine / blood / ai_prediction で、
           * **`dashboard-queries.ts` の `testTypeLabel` と同じ語彙**。
           * `kit_shipment.test_type` (日本語のカテゴリ名) とは別。
           */
          kit_code: string | null;
          kit_name: string | null;
          lab_company: string | null;
          cycle_year: number | null;
          cycle_seq: number | null;
          scheduled_date: string | null;
          /** planned / instruction_sent / shipped (cancelled・skipped はミラーに載らない)。 */
          status: string | null;
          instruction_sent_at: string | null;
          shipped_at: string | null;
          tracking_no: string | null;
          carrier: string | null;
          user_received_at: string | null;
          user_returned_at: string | null;
          lab_received_at: string | null;
          lab_completed_at: string | null;
          synced_at: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      kit_shipment: {
        Row: {
          id: string;
          diagnostic_user_id: string;
          order_id: string | null;
          test_type: string;
          shipping_status: string | null;
          instruction_sent_at: string | null;
          shipped_at: string | null;
          tracking_no: string | null;
          delivered_at: string | null;
          user_received_at: string | null;
          user_returned_at: string | null;
          synced_at: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

export type BridgeCustomerAccount = BridgeDatabase['app_bridge']['Tables']['customer_account']['Row'];
export type BridgeSubscription    = BridgeDatabase['app_bridge']['Tables']['subscription']['Row'];
export type BridgeKitShipment     = BridgeDatabase['app_bridge']['Tables']['kit_shipment']['Row'];
export type BridgeKitSchedule     = BridgeDatabase['app_bridge']['Tables']['kit_schedule']['Row'];
