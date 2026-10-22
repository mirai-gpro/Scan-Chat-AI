import type { APIRoute } from 'astro';
import { resolveViewer } from '../../../../lib/viewer';
import { denyReadOnlyWrite, denyForShare, denyAnonymous } from '../../../../lib/write-guard';
import { getServerSupabase } from '../../../../lib/supabase';
import { isDemoNoticeId } from '../../../../lib/demo-data';
import { viewModeFromRequest } from '../../../../lib/view-mode';
import { refreshConfig } from '../../../../lib/app-config';

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

  /*
   * ── デモのお知らせは、どこにも書かずに「記録されない」と返す（PR-D・§4.4）──
   *
   * デモのお知らせは `demo-data.ts` の**作り物**で、本番の `user_notices` に行が無い。
   * そのまま下へ流すと **404 `notice not found`** になり、画面には
   * 「更新に失敗しました: notice not found」が出る。デモは記者やパートナーにも
   * 見せる枠なので、**押すとエラーになるボタン**を残さない
   * （`api/kit/[id]/self-report.ts` のデモ分岐と同じ形）。
   *
   * **条件は 2 つとも見る。** 片方だけだと
   *   - モードだけ → デモ用アカウントが**本物のお知らせ**を既読にできなくなる
   *   - ID だけ   → 本物の利用者がデモの ID を送れば**偽の成功**を受け取れる
   *
   * **DB の呼び出しより前**に置く（後ろだと 404 のあとに届いて意味がない）。
   * 成功とは言わず `demo: true` を返し、**画面側が「記録されません」と出す**
   * （黙って成功を装わない）。既読は作り物なので、**再読込もしない**
   * （読み直してもダミーは未読のままで、押しても変わらないように見える）。
   *
   * `refreshConfig()` を先に呼ぶのは `isDemoAccount()` が app_config を読むため
   * （冷えた isolate で未取得だと資格が無いと見え、ゲートが開く）。
   */
  await refreshConfig().catch(() => undefined);
  const viewMode = viewModeFromRequest(ctx, viewer);
  if (viewMode.effectiveMode === 'demo' && isDemoNoticeId(id)) {
    return json({ ok: true, read: markRead, demo: true });
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
