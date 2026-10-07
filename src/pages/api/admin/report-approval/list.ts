/**
 * admin: AI疾病予防報告書の **承認待ち / 承認済 一覧**。
 *
 *   GET /api/admin/report-approval/list?status=pending|approved   (Bearer ADMIN_API_KEY)
 *
 * 正本: `docs/elith/AI疾病予防報告書_承認と再作成_仕様書.md` §5.1。
 *
 * 【責務の分界】UI は wellfort-site 側 (CLAUDE.md「admin UI は wellfort-site に置く」)。
 * **画面は 1 つ**で、`status` を切り替えて同じこの口を叩く (専用の承認済ページは作らない)。
 *
 * 【氏名を返さない】識別は `diagnostic_user_id` と受領日で行う。
 * 紙面の中身を見るのは既存の代理表示 (`/api/admin/impersonation/handoff`) 経由で、
 * **本番の `/report` をそのまま**開く (管理画面に報告書の別実装を作らない・§5.2)。
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { getServerSupabase } from '../../../../lib/supabase';
import { listReportsForApproval, PENDING, APPROVED } from '../../../../lib/report-approval';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const GET: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  const url = new URL(request.url);
  const raw = (url.searchParams.get('status') ?? '').trim();
  // 解釈できない値は「全部」にする (打ち間違いで 0 件に見せない)。
  const status = raw === PENDING ? PENDING : raw === APPROVED ? APPROVED : undefined;
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : undefined;

  const sb = getServerSupabase();
  if (!sb) return json({ ok: false, error: 'supabase_not_configured' }, 503);

  const r = await listReportsForApproval(sb as never, { status, limit });
  if (!r.ok) return json(r, 500);
  return json({ ...r, status: status ?? null, count: r.rows.length });
};
