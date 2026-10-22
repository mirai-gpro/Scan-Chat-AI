/**
 * admin: 撮影台帳の **1 行の詳細**（§12.1 の確認・訂正経路）。
 *
 *   GET /api/admin/external-id-captures/detail?id=<capture uuid>
 *     (Bearer ADMIN_API_KEY)
 *
 * **ここだけが外部IDの全文と証跡画像を返す。** 一覧はマスクだけ（仕様 §6.1）。
 * 証跡画像は**短時間（5 分）の署名 URL** で、画像の本体は関数を通らない
 * （migration `20261011000010:93-94`「表示が必要なら短時間の署名 URL を都度発行する」）。
 *
 * **`conflict` の相手も返す**（同じ値を持つ他の有効な行）。これが無いと
 * 「同じ番号が別の検査に在る」回に admin が相手を辿れず、出口が無い。
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { getServerSupabase } from '../../../../lib/supabase';
import { refreshConfig } from '../../../../lib/app-config';
import { adminCaptureDetail } from '../../../../lib/external-id-admin';
import { adminConfigFromAppConfig } from '../../../../lib/external-id-admin-config';

export const prerender = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const GET: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  const id = (new URL(request.url).searchParams.get('id') || '').trim();
  if (!UUID_RE.test(id)) return json({ ok: false, error: 'invalid_id' }, 400);

  const sb = getServerSupabase();
  if (!sb) return json({ ok: false, error: 'supabase_not_configured' }, 503);
  await refreshConfig().catch(() => undefined);

  const res = await adminCaptureDetail({ sb, captureId: id, cfg: adminConfigFromAppConfig() });
  if (!res.ok) return json({ ok: false, error: res.error, detail: res.detail }, res.status);
  return json({ ok: true, detail: res.detail });
};
