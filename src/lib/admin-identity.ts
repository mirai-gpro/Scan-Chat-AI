/**
 * **admin 本人であることを持ち回るための専用 credential**（`welltect_admin_v`）。
 *
 * 【なぜ `viewer.ts` に足さないか】`welltect_v` は**全利用者が通る唯一の認証経路**で、
 * `verifyViewer` は `parts.length > 5` を null で弾く（`viewer.ts:150`）。
 * admin 専用の都合でそこを触らない。**`welltect_v` の形式は 1 バイトも変えない。**
 *
 * 【なぜ uid を payload に入れないか（2026-09-30 確定）】
 * **`admin_users` に居るが Scan-Chat-AI 側の `diagnostic_user_id` を持たない admin が居る。**
 * `api/auth/resolve.ts:200` は uid が決まらないと `{ linked:false }` で返すので、
 * uid を必須にすると**その admin は代理表示を一生使えない**。
 * admin handoff の本人確認の本質は「**どの admin か**」であって、
 * その admin 自身の健康診断 uid ではない。だから payload は
 *
 *     `<admin_identity>.<exp>.<HMAC-SHA256(payload)>`
 *
 * とし、**uid に依存しない**。
 *
 * 【Cookie を移植されても別 admin にはなれない】`admin_identity` は payload に含まれ
 * HMAC で封じてあるので、**中身を書き換えると署名が合わない**。
 * 「自分の Cookie を別の端末へ写す」ことは `welltect_v` と同じく可能だが、
 * それは**同じ本人**であって別 admin にはならない。
 *
 * 【生 email を持たない】保存も送信もするのは HMAC の digest だけ。
 */

import type { APIContext, AstroGlobal } from 'astro';

/** Cookie 名。**admin にしか発行しない**（一般利用者はこの Cookie を持たない）。 */
export const ADMIN_COOKIE = 'welltect_admin_v';

/**
 * 有効期間（秒）。**`welltect_v` と同じ 30 日**。
 *
 * 別々に切れると「admin なのに handoff だけ通らない」という分かりにくい状態を作る。
 * **admin 権限の剥奪が 30 日効かない訳ではない** — `GoogleOneTap` がタブごとに
 * `POST /api/auth/refresh-admin` を叩き（`GoogleOneTap.astro:51,95`）、
 * そこで非 admin なら**この Cookie を削除する**。
 */
const MAX_AGE_SEC = 30 * 24 * 60 * 60;

function env(name: string): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return p != null && p !== '' ? p : undefined;
}

/**
 * 署名鍵。**`viewer.ts` の `secret()` と同じ**（`viewer.ts:52-54`）。**env を足さない。**
 * どちらも無ければ null = **発行も検証もしない**（fail-closed）。
 */
function secret(): string | null {
  return env('APP_SESSION_SECRET') ?? env('SUPABASE_SERVICE_ROLE_KEY') ?? null;
}

function b64url(bytes: ArrayBuffer): string {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(payload: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(payload)));
}

/** タイミング差で署名を推測されないように定数時間で比較する（`viewer.ts:68-73` と同形）。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * **用途を分離した domain separation prefix。**
 *
 * 同じ鍵を別の用途（IP の HMAC 等）でも使うので、**対象文字列に用途を焼き込む**。
 * これが無いと、別用途で作った digest をここへ持ち込める余地が残る。
 */
const ADMIN_IDENTITY_DOMAIN = 'admin_identity:v1:';

/** email を正規化する。**ここ以外で正規化しない**（照合がずれる）。 */
export function canonicalEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

/**
 * **admin の識別子**。`base64url(HMAC-SHA256(secret, "admin_identity:v1:" + canonical_email))`。
 *
 * - **素の `sha256(email)` にしない。** メールアドレスは列挙可能なので辞書で戻せる。
 * - **生 email は返り値に含まれない。** DB にもログにも digest しか出さない。
 * - 鍵が無ければ null（fail-closed）。
 */
export async function adminIdentity(email: string | null | undefined): Promise<string | null> {
  const key = secret();
  const e = canonicalEmail(email);
  if (!key || !e) return null;
  return hmac(`${ADMIN_IDENTITY_DOMAIN}${e}`, key);
}

/** Cookie に載せる署名付きトークン。`<admin_identity>.<exp>.<sig>`。 */
export async function signAdminCred(identity: string, now = Date.now()): Promise<string | null> {
  const key = secret();
  if (!key || !identity) return null;
  const exp = Math.floor(now / 1000) + MAX_AGE_SEC;
  const payload = `${identity}.${exp}`;
  return `${payload}.${await hmac(payload, key)}`;
}

export interface VerifiedAdminCred {
  /** `adminIdentity()` の値。**これが「どの admin か」**。 */
  identity: string;
}

/** 署名付きトークンを検証する。不正・期限切れは null。 */
export async function verifyAdminCred(
  token: string | undefined | null,
  now = Date.now(),
): Promise<VerifiedAdminCred | null> {
  const key = secret();
  if (!key || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [identity, expRaw, sig] = parts;
  // base64url の文字種だけ許す (制御文字や区切りの混入を弾く)。
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(identity)) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp * 1000 < now) return null;
  const expected = await hmac(`${identity}.${expRaw}`, key);
  if (!timingSafeEqual(sig, expected)) return null;
  return { identity };
}

/** `Set-Cookie` に載せる属性（`viewer.ts:179-190` と同じ流儀）。 */
export function adminCookieOptions(): {
  httpOnly: true; secure: boolean; sameSite: 'lax'; path: string; maxAge: number;
} {
  return {
    httpOnly: true,
    // dev サーバは http なので Secure を付けると Cookie が保存されない。
    secure: import.meta.env.DEV !== true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SEC,
  };
}

/**
 * **サーバ検証済み email から admin credential を発行 / 削除する。**
 *
 * `api/auth/resolve.ts` と `api/auth/refresh-admin.ts` の**両方から呼ぶ**。
 * **admin でなければ削除する** — 管理者リストから外れた人の Cookie を残さない。
 *
 * **投げない。** 認証の本線をこの追加機能で壊さないため（失敗しても false を返すだけ）。
 */
export async function issueAdminCred(
  ctx: { cookies: { set: (k: string, v: string, o: Record<string, unknown>) => void; delete: (k: string, o?: Record<string, unknown>) => void } },
  email: string | null | undefined,
  isAdmin: boolean,
): Promise<boolean> {
  try {
    if (!isAdmin) {
      ctx.cookies.delete(ADMIN_COOKIE, { path: '/' });
      return false;
    }
    const identity = await adminIdentity(email);
    if (!identity) return false;
    const token = await signAdminCred(identity);
    if (!token) return false;
    ctx.cookies.set(ADMIN_COOKIE, token, adminCookieOptions());
    return true;
  } catch {
    return false;
  }
}

/** リクエストから admin credential を読む。無い / 不正なら null。 */
export async function readAdminCred(ctx: AstroGlobal | APIContext): Promise<VerifiedAdminCred | null> {
  return verifyAdminCred(ctx.cookies.get(ADMIN_COOKIE)?.value);
}
