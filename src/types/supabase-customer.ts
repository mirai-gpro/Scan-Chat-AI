/**
 * customer schema 型 (手書きスタブ — 本番は `supabase gen types` で再生成)。
 * 再生成:
 *   supabase gen types typescript --local --schema customer | Out-File -Encoding utf8 src/types/supabase-customer.ts
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  customer: {
    Tables: {
      customer_profiles: {
        Row: {
          user_id: string;
          family_name: string;
          given_name: string;
          family_name_kana: string | null;
          given_name_kana: string | null;
          sex: string | null;
          date_of_birth: string | null;
          email: string | null;
          phone: string | null;
          postal_code: string | null;
          prefecture: string | null;
          city: string | null;
          address_line: string | null;
          building: string | null;
          diagnostic_user_id: string | null;
          diagnostic_linked_at: string | null;
          google_sub: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id?: string;
          family_name: string;
          given_name: string;
          family_name_kana?: string | null;
          given_name_kana?: string | null;
          sex?: string | null;
          date_of_birth?: string | null;
          email?: string | null;
          phone?: string | null;
          postal_code?: string | null;
          prefecture?: string | null;
          city?: string | null;
          address_line?: string | null;
          building?: string | null;
          diagnostic_user_id?: string | null;
          diagnostic_linked_at?: string | null;
          google_sub?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['customer']['Tables']['customer_profiles']['Insert']>;
        Relationships: [];
      };
      lab_companies: {
        Row: {
          id: string;
          name: string;
          test_types: string[];
          delivery_format: string;
          external_id_label: string | null;
          external_id_pattern: string | null;
          notification_method: string | null;
          contact_email: string | null;
          workflow_default: number;
          notes: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          test_types: string[];
          delivery_format: string;
          external_id_label?: string | null;
          external_id_pattern?: string | null;
          notification_method?: string | null;
          contact_email?: string | null;
          workflow_default?: number;
          notes?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['customer']['Tables']['lab_companies']['Insert']>;
        Relationships: [];
      };
      subscription_plans: {
        Row: {
          id: string;
          name: string;
          cycle_months: number;
          tests_per_cycle: string[];
          genetics_once: boolean;
          price_yen: number | null;
          description: string | null;
          is_active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          cycle_months: number;
          tests_per_cycle: string[];
          genetics_once?: boolean;
          price_yen?: number | null;
          description?: string | null;
          is_active?: boolean;
          created_at?: string;
        };
        Update: Partial<Database['customer']['Tables']['subscription_plans']['Insert']>;
        Relationships: [];
      };
      subscriptions: {
        Row: {
          id: string;
          customer_id: string;
          plan_id: string;
          started_at: string;
          next_test_at: string | null;
          last_test_at: string | null;
          current_cycle_year: number | null;
          current_cycle_seq: number | null;
          status: string;
          paused_at: string | null;
          cancelled_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          customer_id: string;
          plan_id: string;
          started_at: string;
          next_test_at?: string | null;
          last_test_at?: string | null;
          current_cycle_year?: number | null;
          current_cycle_seq?: number | null;
          status?: string;
          paused_at?: string | null;
          cancelled_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['customer']['Tables']['subscriptions']['Insert']>;
        Relationships: [];
      };
      kit_shipments: {
        Row: {
          id: string;
          order_id: string;
          customer_id: string;
          lab_company_id: string;
          test_type: string;
          subscription_id: string | null;
          subscription_year: number | null;
          subscription_seq: number | null;
          warehouse: string | null;
          shipped_at: string | null;
          tracking_no: string | null;
          carrier: string | null;
          carrier_tracking_url: string | null;
          expected_arrival_date: string | null;
          requested_arrival_date: string | null;
          requested_time_window: string | null;
          requested_at: string | null;
          requested_lock_at: string | null;
          user_received_at: string | null;
          user_returned_at: string | null;
          lab_received_at: string | null;
          lab_completed_at: string | null;
          notes: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          order_id: string;
          customer_id: string;
          lab_company_id: string;
          test_type: string;
          subscription_id?: string | null;
          subscription_year?: number | null;
          subscription_seq?: number | null;
          warehouse?: string | null;
          shipped_at?: string | null;
          tracking_no?: string | null;
          carrier?: string | null;
          carrier_tracking_url?: string | null;
          expected_arrival_date?: string | null;
          requested_arrival_date?: string | null;
          requested_time_window?: string | null;
          requested_at?: string | null;
          requested_lock_at?: string | null;
          user_received_at?: string | null;
          user_returned_at?: string | null;
          lab_received_at?: string | null;
          lab_completed_at?: string | null;
          notes?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['customer']['Tables']['kit_shipments']['Insert']>;
        Relationships: [];
      };
      lab_tests: {
        Row: {
          id: string;
          shipment_id: string | null;
          customer_id: string;
          diagnostic_user_id: string;
          lab_company_id: string;
          test_type: string;
          external_test_id: string | null;
          external_barcode: string | null;
          sampled_at: string | null;
          reported_at: string | null;
          status: string;
          workflow_used: number | null;
          assigned_at: string | null;
          assigned_by: string | null;
          notes: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          shipment_id?: string | null;
          customer_id: string;
          diagnostic_user_id: string;
          lab_company_id: string;
          test_type: string;
          external_test_id?: string | null;
          external_barcode?: string | null;
          sampled_at?: string | null;
          reported_at?: string | null;
          status?: string;
          workflow_used?: number | null;
          assigned_at?: string | null;
          assigned_by?: string | null;
          notes?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['customer']['Tables']['lab_tests']['Insert']>;
        Relationships: [];
      };
      /**
       * 受取時に撮影した外部検査ID の台帳
       * (`supabase/migrations/20261011000010_lab_test_id_captures.sql`)。
       * 正本 `docs/lab/kit_receipt_external_id_capture_spec.md`。
       */
      lab_test_id_captures: {
        Row: {
          id: string;
          diagnostic_user_id: string;
          /** dev=`kit_shipments.id` / 本番=`orders.id`。**FK は張っていない**(migration 冒頭の理由)。 */
          shipment_ref: string;
          provider: string;
          test_type: string;
          id_kind: string;
          normalized_value: string;
          capture_method: string;
          decode_method: string;
          review_reasons: string[];
          evidence_key: string | null;
          status: string;
          lab_test_id: string | null;
          lab_test_link_status: string;
          lab_test_link_detail: string | null;
          captured_at: string;
          confirmed_at: string | null;
          previous_value: string | null;
          corrected_at: string | null;
          corrected_by: string | null;
          correction_reason: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          diagnostic_user_id: string;
          shipment_ref: string;
          provider: string;
          test_type: string;
          id_kind: string;
          normalized_value: string;
          capture_method: string;
          decode_method: string;
          review_reasons?: string[];
          evidence_key?: string | null;
          status?: string;
          lab_test_id?: string | null;
          lab_test_link_status?: string;
          lab_test_link_detail?: string | null;
          captured_at?: string;
          confirmed_at?: string | null;
          previous_value?: string | null;
          corrected_at?: string | null;
          corrected_by?: string | null;
          correction_reason?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['customer']['Tables']['lab_test_id_captures']['Insert']>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
