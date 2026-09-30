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
import { publicOrigin } from '../../../../lib/public-url';

export const prerender = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * 応答に入れる絶対 URL の基点。
 *
 * 【2026-09-30・実機で発覚】初版は `new URL(request.url).origin` を使っており、
 * 本番で **`https://localhost/admin/handoff/<token>`** が返っていた。
 * **Vercel の SSR では `request.url` がプロキシ内側の URL になる** ためで、
 * 2026-09-04 に QR で踏んだのと同じ罠（`src/lib/public-url.ts` の冒頭に経緯）。
 * → **既存の `publicOrigin()`（転送ヘッダを見る）を使う。**
 *
 * 【それでもこれを頼りにしない】`publicOrigin()` はヘッダ由来なので、
 * **受け渡し券の飛び先をヘッダで決めたくない**（詐称されると token が別ホストへ飛ぶ）。
 * そこで応答には **`path` も返し、中継（wellfort-site）は自分の
 * `SCAN_CHAT_AI_BASE_URL` と組み合わせる**。`url` は互換のために残す。
 */
function baseUrl(request: Request): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const configured = env?.PUBLIC_APP_BASE_URL ?? process.env?.PUBLIC_APP_BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return publicOrigin(request);
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

  const path = `/admin/handoff/${issued.token}`;
  return json({
    ok: true,
    /** **中継はこちらを使う。** 自分が知っている base と組み合わせれば、ヘッダに依存しない。 */
    path,
    /** 互換用の絶対 URL（転送ヘッダ由来）。 */
    url: `${baseUrl(request)}${path}`,
    expires_at: issued.expiresAt,
  });
};
