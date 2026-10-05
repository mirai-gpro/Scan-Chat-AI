/**
 * diagnosis schema 型 (手書きスタブ — 本番は `supabase gen types` で再生成)。
 * 再生成:
 *   supabase gen types typescript --local --schema diagnosis | Out-File -Encoding utf8 src/types/supabase-diagnosis.ts
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  diagnosis: {
    Tables: {
      app_users: {
        Row: {
          diagnostic_user_id: string;
          auth_user_id: string | null;
          google_sub: string | null;
          hp_customer_user_id: string | null;
          display_name_cache: string | null;
          eligibility_checked_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          diagnostic_user_id?: string;
          auth_user_id?: string | null;
          google_sub?: string | null;
          hp_customer_user_id?: string | null;
          display_name_cache?: string | null;
          eligibility_checked_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['diagnosis']['Tables']['app_users']['Insert']>;
        Relationships: [];
      };
      test_artifacts: {
        Row: {
          id: string;
          diagnostic_user_id: string;
          source: string;
          test_type: string;
          test_date: string | null;
          external_test_id: string | null;
          lab_name: string | null;
          schema_version: string;
          age_at_test: number | null;
          sex: string | null;
          display_mode: string;
          page_count: number | null;
          imported_at: string;
          imported_by: string;
          status: string;
          notes: string | null;
          /** ユーザー検証後の確定 Markdown。アプリ内スキャン経路だけが書く (20260904000010)。 */
          scan_md: string | null;
          /**
           * 原本忠実の測定値 (jsonb・20260820000010)。`persistMeasurements()` が唯一の書き込み口。
           * 中身は lean measurement の配列だが、**DB は形を保証しない**ので
           * `unknown` のまま受け、読む側で検証する (`result-queries.ts` の `toResultMeasurements`)。
           */
          measurements: unknown;
        };
        Insert: {
          id?: string;
          diagnostic_user_id: string;
          source: string;
          test_type: string;
          test_date?: string | null;
          external_test_id?: string | null;
          lab_name?: string | null;
          schema_version?: string;
          age_at_test?: number | null;
          sex?: string | null;
          display_mode?: string;
          page_count?: number | null;
          imported_at?: string;
          imported_by: string;
          status?: string;
          notes?: string | null;
        };
        Update: Partial<Database['diagnosis']['Tables']['test_artifacts']['Insert']>;
        Relationships: [];
      };
      test_artifact_files: {
        Row: {
          id: string;
          test_artifact_id: string;
          file_kind: string;
          storage_url: string;
          sha256: string;
          size_bytes: number;
          llm_model: string | null;
          llm_generated_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          test_artifact_id: string;
          file_kind: string;
          storage_url: string;
          sha256: string;
          size_bytes: number;
          llm_model?: string | null;
          llm_generated_at?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['diagnosis']['Tables']['test_artifact_files']['Insert']>;
        Relationships: [];
      };
      diagnosis_results: {
        Row: {
          id: string;
          diagnostic_user_id: string;
          diagnostic_id: string;
          report: Json;
          schema_version: string;
          elith_job_id: string | null;
          elith_model_version: string | null;
          received_at: string;
          summary_text: string | null;
          highlights_text: string | null;
          extracted_at: string | null;
          extracted_by_model: string | null;
          status: string;
          /*
           * 以下 5 列は migration で後から足したもの。**生成し直しの取りこぼし**で
           * ここに無く、`report-route.ts` / `report-finalize.ts` が
           * `astro check` で 6 件のエラーになっていた (production で実測・2026-10-05)。
           *   report_pdf_*  … 20260820000040_diagnosis_report_pdf.sql
           *   source_key    … 20260917000010_diagnosis_results_source.sql
           *                   (`source_key is not null` の部分 UNIQUE 索引つき)
           * 型だけを実 DDL に合わせる。**DB 側は 1 文字も変えない** (migration を足さない)。
           */
          report_pdf_url: string | null;
          report_pdf_sha256: string | null;
          report_pdf_pages: number | null;
          report_pdf_received_at: string | null;
          source_key: string | null;
        };
        Insert: {
          id?: string;
          diagnostic_user_id: string;
          diagnostic_id: string;
          report: Json;
          schema_version?: string;
          elith_job_id?: string | null;
          elith_model_version?: string | null;
          received_at?: string;
          summary_text?: string | null;
          highlights_text?: string | null;
          extracted_at?: string | null;
          extracted_by_model?: string | null;
          status?: string;
          report_pdf_url?: string | null;
          report_pdf_sha256?: string | null;
          report_pdf_pages?: number | null;
          report_pdf_received_at?: string | null;
          source_key?: string | null;
        };
        Update: Partial<Database['diagnosis']['Tables']['diagnosis_results']['Insert']>;
        Relationships: [];
      };
      user_notices: {
        Row: {
          id: string;
          diagnostic_user_id: string;
          title: string;
          body: string;
          link_url: string | null;
          published_at: string;
          read_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          diagnostic_user_id: string;
          title: string;
          body: string;
          link_url?: string | null;
          published_at?: string;
          read_at?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['diagnosis']['Tables']['user_notices']['Insert']>;
        Relationships: [];
      };
      announcements: {
        Row: {
          id: string;
          category: string;
          title: string;
          body: string;
          link_url: string | null;
          published_at: string;
          created_at: string;
          // news 同期 / 掲載面トグル (20260621000010, 20260621000020)
          source_news_id: string | null;
          image_url: string | null;
          link_text: string | null;
          visible_on_hp: boolean;
          visible_on_web: boolean;
          published_until: string | null;
          updated_at: string;
        };
        Insert: {
          id?: string;
          category: string;
          title: string;
          body: string;
          link_url?: string | null;
          published_at?: string;
          created_at?: string;
          source_news_id?: string | null;
          image_url?: string | null;
          link_text?: string | null;
          visible_on_hp?: boolean;
          visible_on_web?: boolean;
          published_until?: string | null;
          updated_at?: string;
        };
        Update: Partial<Database['diagnosis']['Tables']['announcements']['Insert']>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
