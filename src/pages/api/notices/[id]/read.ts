import type { APIRoute } from 'astro';
import { resolveViewer } from '../../../../lib/viewer';
import { denyReadOnlyWrite, denyForShare, denyAnonymous } from '../../../../lib/write-guard';
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
  const viewer = await resolveViewer(ctx);
  const denied = denyReadOnlyWrite(viewer);
  if (denied) return denied;
  /*
   * **共有閲覧からは一切叩かせない**（2026-09-30・仕様書 §17.2 / §25）。
   * **本人の既読状態**を外部の共有相手に変えられると、
   * **本人が重要な通知を見落とす**。**UI から消すだけでは足りない**ので API で 403。
   */
  const shared = denyForShare(viewer);
  if (shared) return shared;
  const unauth = denyAnonymous(viewer);
  if (unauth) return unauth;

  const id = params.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return json({ error: 'invalid notice id' }, 400);
  }

  const body = (await request.json().catch(() => null)) as
    | { diagnosticUserId?: unknown; read?: unknown }
    | null;
  /*
   * 【2026-09-30・§21.1】**body の `diagnosticUserId` を認可根拠にしない。**
   * 以前はこの値で所有確認していたので、**他人の uid を書けばその人のお知らせを
   * 既読にできた**。対象は resolver が決める。
   */
  const diagnosticUserId = viewer.writeTargetUid;
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
