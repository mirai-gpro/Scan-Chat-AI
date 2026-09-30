import type { APIRoute } from 'astro';
import { resolveViewer } from '../../../../lib/viewer';
import { denyReadOnlyWrite } from '../../../../lib/write-guard';
import { getServerSupabase } from '../../../../lib/supabase';

export const prerender = false;

/**
 * 重要なお知らせ (user_notices) の既読 / 未読を切り替える。
 *
 * dev profile では認証未連携のため、body の `diagnosticUserId` が当該お知らせの
 * 所有者と一致するかをチェックして所有確認とする。
 * 本番では Supabase Auth の session から diagnostic_user_id を解決する。
 *
 * body: { diagnosticUserId: string, read?: boolean }  // read 省略時は true (既読化)
 */
export const POST: APIRoute = async (ctx) => {
  const { params, request } = ctx;
  /*
   * **代理表示中は書かせない**（2026-09-30・仕様書 §12.5 / §38-U27）。
   * こちらも body の `diagnosticUserId` を信じるので、
   * 代理表示から押すと**対象顧客の既読状態が変わる**。
   */
  const denied = denyReadOnlyWrite(await resolveViewer(ctx));
  if (denied) return denied;

  const id = params.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return json({ error: 'invalid notice id' }, 400);
  }

  const body = (await request.json().catch(() => null)) as
    | { diagnosticUserId?: unknown; read?: unknown }
    | null;
  const diagnosticUserId = typeof body?.diagnosticUserId === 'string' ? body.diagnosticUserId : null;
  const markRead = body?.read === undefined ? true : body?.read === true;

  if (!diagnosticUserId || !/^[0-9a-f-]{36}$/i.test(diagnosticUserId)) {
    return json({ error: 'missing or invalid diagnosticUserId' }, 400);
  }

  const sb = getServerSupabase();
  if (!sb) return json({ error: 'supabase not configured' }, 503);

  const dsb = sb.schema('diagnosis');

  // 所有確認
  const { data: notice, error: noticeErr } = await dsb
    .from('user_notices')
    .select('id, diagnostic_user_id')
    .eq('id', id)
    .maybeSingle();
  if (noticeErr) return json({ error: `notice lookup: ${noticeErr.message}` }, 500);
  if (!notice) return json({ error: 'notice not found' }, 404);
  if (notice.diagnostic_user_id !== diagnosticUserId) {
    return json({ error: 'forbidden (notice does not belong to user)' }, 403);
  }

  const { data: updated, error: updErr } = await dsb
    .from('user_notices')
    .update({ read_at: markRead ? new Date().toISOString() : null })
    .eq('id', id)
    .select('id, read_at')
    .single();
  if (updErr) return json({ error: `update: ${updErr.message}` }, 500);

  return json({ ok: true, notice: updated });
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
