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
  | 'HP_BRIDGE_STAGING_FUNCTION_URL'
  | 'HP_BRIDGE_STAGING_SHARED_SECRET';

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
 *
 * **取り方が 2 つに分かれる** (2026-09-11 確定):
 *   production … `app_bridge` スキーマへ**直接** Supabase 接続 (従来どおり)
 *   staging    … Edge Function `get-bridge-bundle` を**サーバ間で POST**
 *                (staging は新 API キー方式で、`app_bridge_readonly` ロールを
 *                 名乗る鍵を用意できないため。関数の内側で service_role が
 *                 3 表だけを読む)
 */
export type BridgeOrigin = 'production' | 'staging';

/**
 * `app_bridge` 読み取り専用クライアント (**production 専用**)。
 *
 * **staging では使わない** — staging は Edge Function 経由なので、
 * ここで直接クライアントを作ると新方式の鍵で弾かれる。
 * `origin='staging'` を渡した場合は null を返す (呼び出し側が経路を分ける)。
 */
export function getBridgeSupabase(origin: BridgeOrigin = 'production'): SupabaseClient<BridgeDatabase> | null {
  if (origin !== 'production') return null;
  const url = envOf('HP_BRIDGE_SUPABASE_URL');
  const key = envOf('HP_BRIDGE_READONLY_KEY');
  if (!url || !key) return null;
  return createClient<BridgeDatabase>(url, key, {
    db: { schema: 'app_bridge' },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * staging の `get-bridge-bundle` 呼び出しに要る設定。未構成なら null。
 *
 * **secret はここから外へ出さない** — 返すのは呼び出し直前の 1 か所だけで使う。
 * ログ・応答・画面に載せてはならない。
 */
export function getStagingBridgeEndpoint(): { url: string; secret: string } | null {
  const url = envOf('HP_BRIDGE_STAGING_FUNCTION_URL');
  const secret = envOf('HP_BRIDGE_STAGING_SHARED_SECRET');
  if (!url || !secret) return null;
  return { url, secret };
}

export function isBridgeConfigured(origin: BridgeOrigin = 'production'): boolean {
  if (origin === 'staging') return getStagingBridgeEndpoint() !== null;
  return !!envOf('HP_BRIDGE_SUPABASE_URL') && !!envOf('HP_BRIDGE_READONLY_KEY');
}

