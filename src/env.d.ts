/// <reference path="../.astro/types.d.ts" />

interface ImportMetaEnv {
  readonly GEMINI_API_KEY: string;
  readonly PUBLIC_SUPABASE_URL: string;
  readonly PUBLIC_SUPABASE_ANON_KEY: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
  readonly PUBLIC_VOICE_BACKEND_URL: string;
  // HP/EC #1 連携 (app_bridge / Edge Functions)。未設定なら dev フォールバック。
  readonly HP_BRIDGE_SUPABASE_URL?: string;
  readonly HP_BRIDGE_READONLY_KEY?: string;
  readonly HP_EDGE_BASE_URL?: string;
  readonly RESOLVE_SHARED_SECRET?: string;
  // テストフェーズのダミー表示フォールバック。'false' で無効化 (既定 ON)。
  readonly PUBLIC_DEMO_FALLBACK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare namespace App {
  interface Locals {
    /**
     * **Admin 代理表示の解決結果**（`/admin-view/<ctx>/…` のときだけ入る）。
     *
     * **middleware しか書かない。** クライアントからは設定できないので、
     * ここに値が在ること自体が「middleware が admin 本人と context を突き合わせて
     * 通した」ことの証明になる（`src/middleware.ts`）。
     */
    adminView?: {
      ctx: string;
      targetUid: string;
      targetOrigin: 'production' | 'staging';
      adminIdentity: string;
      /** admin 本人の uid。**uid を持たない admin が居るので null になり得る。** */
      adminSelfUid: string | null;
      expiresAt: string;
    };
  }
}
