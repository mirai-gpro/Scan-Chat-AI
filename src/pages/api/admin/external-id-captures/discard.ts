/**
 * admin: 撮影台帳の **無効化**（`superseded` へ落とすだけ・§12.1）。
 *
 *   POST /api/admin/external-id-captures/discard   (Bearer ADMIN_API_KEY)
 *     body: { captureId, reason, triggeredByEmail? }
 *
 * **`conflict` の出口**。同じ番号が別の行に在る限りどちらも確定できないので、
 * 誤登録だった側を無効化する手段が無いと出口が無い（仕様 §8.2 は「自動上書き禁止」
 * なので、どちらを残すかは**人が決める**）。
 *
 * **書く値は `superseded` だけ。** `confirmed` にも `linked` にも 1 バイトも触らず、
 * `lab_tests` も触らない（仕様 §12.1 が禁じているのはそちら）。
 * **行は消さない** — 消すと `previous_value` の鎖が切れて前の番号が辿れなくなる。
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { getServerSupabase } from '../../../../lib/supabase';
import { adminIdentity } from '../../../../lib/admin-identity';
import { discardAdminCapture } from '../../../../lib/external-id-admin';

export const prerender = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);

  const captureId = typeof body.captureId === 'string' ? body.captureId.trim() : '';
  if (!UUID_RE.test(captureId)) return json({ ok: false, error: 'invalid_id' }, 400);
  const reason = typeof body.reason === 'string' ? body.reason : '';

  const sb = getServerSupabase();
  if (!sb) return json({ ok: false, error: 'supabase_not_configured' }, 503);

  const correctedBy = typeof body.triggeredByEmail === 'string'
    ? await adminIdentity(body.triggeredByEmail)
    : null;
  if (!correctedBy) {
    return json({
      ok: false, error: 'operator_required',
      detail: '操作者を特定できませんでした（監査に残せないため中止しました）',
    }, 400);
  }

  const res = await discardAdminCapture({ sb, captureId, reason, correctedBy });
  if (!res.ok) return json({ ok: false, error: res.error, detail: res.detail }, res.status);
  return json({ ok: true, id: res.id });
};
