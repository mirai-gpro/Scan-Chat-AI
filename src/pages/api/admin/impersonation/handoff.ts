/**
 * admin: **代理表示の受け渡し券（handoff）を発行する。**
 *
 * 正本: `docs/specs/secure_shared_access_and_admin_impersonation_spec_20260930.md` §12.2 ③〜⑥。
 *
 *   POST { target_uid, admin_email, target_origin? }
 *     → { ok:true, url: "https://…/admin/handoff/<raw>", expires_at }
 *
 * 【認可】wellfort-site の中継から **Bearer `ADMIN_API_KEY`**（`api-auth.ts`・
 * キー未設定の本番は拒否）。**ブラウザから直接叩かせない。**
 *
 * 【`admin_email` の扱い】wellfort-site の `verifyAdmin()` が Supabase の
 * `/auth/v1/user` で**検証した値だけ**を中継する。**クライアント申告ではない。**
 * ここで受けた生 email は **`adminIdentity()` で即 digest へ落とし、以後は触らない**
 * （保存もログもしない・§12.4.1）。
 *
 * 【raw token を返すのは 1 度だけ】DB には `sha256(raw)` しか入らないので復元できない。
 * **ログに出さない。**
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { adminIdentity } from '../../../../lib/admin-identity';
import { createHandoff } from '../../../../lib/admin-impersonation';

export const prerender = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 応答に入れる絶対 URL の基点。**推測でホスト名をベタ書きしない** — 受けたリクエストから採る。 */
function baseUrl(request: Request): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const configured = env?.PUBLIC_APP_BASE_URL ?? process.env?.PUBLIC_APP_BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return new URL(request.url).origin;
}

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ error: 'unauthorized' }, 401);

  const body = (await request.json().catch(() => null)) as {
    target_uid?: unknown; admin_email?: unknown; target_origin?: unknown;
  } | null;

  const targetUid = typeof body?.target_uid === 'string' ? body.target_uid.trim().toLowerCase() : '';
  const adminEmail = typeof body?.admin_email === 'string' ? body.admin_email : '';
  const targetOrigin = body?.target_origin === 'staging' ? 'staging' : 'production';

  if (!UUID_RE.test(targetUid)) return json({ error: 'invalid target_uid' }, 400);
  if (!adminEmail) return json({ error: 'missing admin_email' }, 400);

  // ★ 受けた直後に digest へ落とす。以後 adminEmail は使わない。
  const identity = await adminIdentity(adminEmail);
  if (!identity) return json({ error: 'server_misconfig' }, 503);

  const issued = await createHandoff({ targetUid, adminIdentity: identity, targetOrigin });
  if (!issued) return json({ error: 'target_not_found' }, 404);

  return json({
    ok: true,
    url: `${baseUrl(request)}/admin/handoff/${issued.token}`,
    expires_at: issued.expiresAt,
  });
};
