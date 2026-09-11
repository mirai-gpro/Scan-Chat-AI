/**
 * Supabase クライアント (型付き)。
 *
 * - ブラウザ用 (`getBrowserSupabase`): PUBLIC_* で anon (publishable) key を使用。
 * - サーバ用  (`getServerSupabase`):  SERVICE_ROLE_KEY (secret) を使い、RLS bypass で書込可能。
 *
 * 環境変数が未設定の場合は `null` を返し、呼び出し側で no-op を選べる。
 * dev: `.env.local` に Supabase CLI が発行した key を入れる (詳細は supabase/README.md)
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types/supabase';
import type { BridgeDatabase } from '../types/supabase-bridge';

let browserClient: SupabaseClient<Database> | null = null;

/** ブラウザ用クライアント。設定が無ければ null。 */
export function getBrowserSupabase(): SupabaseClient<Database> | null {
  if (typeof window === 'undefined') return null;
  if (browserClient) return browserClient;
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const anon = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  browserClient = createClient<Database>(url, anon, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return browserClient;
}

/** サーバ用クライアント (Astro API ルート / SSR 専用)。 */
export function getServerSupabase(): SupabaseClient<Database> | null {
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const service = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) return null;
  return createClient<Database>(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * HP/EC #1 `app_bridge` 読み取り専用クライアント (SSR 専用)。
 *
 * 統合仕様書に基づき、Web は #1 の app_bridge スキーマのみを参照する。
 * 認証は HP 発行の restricted ロール (`app_bridge_readonly`) JWT。
 * env 未設定なら null を返し、呼び出し側はモック (customer スキーマ) へフォールバックする。
 */
// SSR ランタイムで非PUBLIC変数を確実に読むため、import.meta.env を優先しつつ
// 取れない場合は process.env（Node ランタイム = Vercel SSR）にフォールバックする。
type BridgeEnvName =
  | 'HP_BRIDGE_SUPABASE_URL'
  | 'HP_BRIDGE_READONLY_KEY'
  | 'HP_BRIDGE_STAGING_SUPABASE_URL'
  | 'HP_BRIDGE_STAGING_READONLY_KEY';

function envOf(name: BridgeEnvName): string {
  const v = (import.meta.env as Record<string, string | undefined>)[name];
  if (v) return v;
  if (typeof process !== 'undefined' && process.env) return (process.env as Record<string, string | undefined>)[name] ?? '';
  return '';
}

/**
 * **どちらの HP/EC 環境の `app_bridge` を見るか。**
 *
 * HP/EC 系には **別々の Supabase project が 2 つ**ある
 * (Production `wellfort` / Staging `wellfort-staging`。
 *  `docs/subscription/検査キット_データモデル_仕様書.md` §2)。
 * 総合テストは **staging の EC で購入 → 本番の Web アプリでサインイン**という
 * 環境を跨いだ構成で行うため、**接続先を 1 本の env で決め打ちできない**。
 */
export type BridgeOrigin = 'production' | 'staging';

const BRIDGE_ENV: Record<BridgeOrigin, { url: BridgeEnvName; key: BridgeEnvName }> = {
  production: { url: 'HP_BRIDGE_SUPABASE_URL', key: 'HP_BRIDGE_READONLY_KEY' },
  staging: { url: 'HP_BRIDGE_STAGING_SUPABASE_URL', key: 'HP_BRIDGE_STAGING_READONLY_KEY' },
};

/**
 * `app_bridge` 読み取り専用クライアント。
 *
 * **既定は production**。staging は `origin='staging'` を明示したときだけで、
 * **production が空でも staging へ落ちない** (無条件フォールバックは
 * production 利用者と staging 利用者の混線を招くため禁止)。
 */
export function getBridgeSupabase(origin: BridgeOrigin = 'production'): SupabaseClient<BridgeDatabase> | null {
  const names = BRIDGE_ENV[origin];
  const url = envOf(names.url);
  const key = envOf(names.key);
  if (!url || !key) return null;
  return createClient<BridgeDatabase>(url, key, {
    db: { schema: 'app_bridge' },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * app_bridge への接続が構成済みか (dev フォールバック判定用)。
 *
 * **env の有無しか見ない。接続先の project は見ない** — 従来からの性質で、
 * だからこそ「どちらの環境か」は env の有無でなく `origin` で決める
 * (仕様書 §2 の囲みが指摘している落とし穴)。
 */
export function isBridgeConfigured(origin: BridgeOrigin = 'production'): boolean {
  const names = BRIDGE_ENV[origin];
  return !!envOf(names.url) && !!envOf(names.key);
}
