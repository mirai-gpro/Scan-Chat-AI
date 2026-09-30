/**
 * **代理表示を終える。**
 *
 * 正本: `docs/specs/secure_shared_access_and_admin_impersonation_spec_20260930.md` §13.3。
 *
 *   POST { ctx }        → そのタブの代理表示だけを失効（他のタブの別顧客は生き続ける）
 *   POST { all: true }  → **その admin の代理表示を全部**失効（席を離れるとき）
 *
 * 【認可は `welltect_admin_v`】`ADMIN_API_KEY` ではない — これは**ブラウザから**
 * 押されるボタンの受け口。`revokeImpersonation` は `admin_identity` で絞るので、
 * **他人の代理表示は落とせない**。
 *
 * 【`welltect_v` は消さない】admin 本人の画面へそのまま戻れるようにする（§24.3）。
 */
import type { APIRoute } from 'astro';
import { ADMIN_COOKIE, verifyAdminCred } from '../../../../lib/admin-identity';
import { revokeImpersonation } from '../../../../lib/admin-impersonation';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const cred = await verifyAdminCred(cookies.get(ADMIN_COOKIE)?.value);
  if (!cred) return json({ error: 'forbidden' }, 403);

  const body = (await request.json().catch(() => null)) as { ctx?: unknown; all?: unknown } | null;
  const all = body?.all === true;
  const ctx = typeof body?.ctx === 'string' ? body.ctx : null;
  if (!all && !ctx) return json({ error: 'missing ctx' }, 400);

  const revoked = await revokeImpersonation({ adminIdentity: cred.identity, ctx, all });
  return json({ ok: true, revoked });
};
