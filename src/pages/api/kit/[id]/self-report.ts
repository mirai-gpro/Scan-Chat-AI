import type { APIRoute } from 'astro';
import { resolveViewer } from '../../../../lib/viewer';
import { denyReadOnlyWrite, denyForShare, denyAnonymous } from '../../../../lib/write-guard';
import { getServerSupabase } from '../../../../lib/supabase';
import { isHpEdgeConfigured, submitKitSelfReport } from '../../../../lib/hp-edge';
import { isDemoShipmentId } from '../../../../lib/demo-data';
import { viewModeFromRequest } from '../../../../lib/view-mode';
import { refreshConfig } from '../../../../lib/app-config';

export const prerender = false;

/**
 * 検査キットの自己申告 (ユーザー受取 / 返送)。
 *
 * dev profile では認証未連携のため、`?u=<diagnostic_user_id>` でユーザーを識別する代替として、
 * リクエスト body に `diagnosticUserId` を渡し、shipment.customer_id が当該ユーザーの
 * customer_profiles.user_id と一致するかをチェックする。
 *
 * 本番では Supabase Auth の session から diagnostic_user_id を解決する。
 */
export const POST: APIRoute = async (ctx) => {
  const { params, request } = ctx;
  /*
   * **代理表示中は書かせない**（2026-09-30・仕様書 §12.5 / §38-U27）。
   * この口は **body の `diagnosticUserId` をそのまま信じる**ので、
   * 代理表示の画面から押されると**対象顧客の配送状態が実際に変わる**。
   * 所有者チェックは「その uid のものか」しか見ておらず、**誰が押したかは見ていない**。
   */
  const viewer = await resolveViewer(ctx);
  const denied = denyReadOnlyWrite(viewer);
  if (denied) return denied;
  /*
   * **共有閲覧からは一切叩かせない**（2026-09-30・仕様書 §17.2 / §25）。
   * 発注者が共有相手へ許可した更新は **AI 問診と AI スキャンの 2 つだけ**。
   * **本人の配送状態**を外部の共有相手が変えると、実態と食い違って
   * **以後の出荷・検査の段取りが狂う**。**UI から消すだけでは足りない**
   * （API 直叩きを防げない）ので、ここで 403 にする。
   */
  const shared = denyForShare(viewer);
  if (shared) return shared;
  // **未認証も止める**（§21.1 クラス A）。
  const unauth = denyAnonymous(viewer);
  if (unauth) return unauth;

  const id = params.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return json({ error: 'invalid shipment id' }, 400);
  }

  const body = await request.json().catch(() => null) as { action?: unknown; diagnosticUserId?: unknown } | null;
  const action = body?.action;
  /*
   * 【2026-09-30・§21.1】**body の `diagnosticUserId` を認可根拠にしない。**
   * 以前はこの値をそのまま信じて所有確認していたので、**他人の uid を書けば
   * その人の配送状態を変えられた**。対象は resolver が決める。
   */
  /*
   * **デモの判定は「資格」ではなく「いま Demo を表示中か」で決める** (PR-C・§4.3)。
   * PR-A は `demoFallbackEnabled(uid)` (= 資格) を見ていたので、**Dual の人が
   * Real を表示していても読取テスト扱いになり本物の登録ができなかった**。
   *
   * 【**app_config を読んでから判定する**（PR-D・§4.4）】`isDemoAccount()` は
   * `demo.account_uids` を読むので、**冷えた isolate で未取得のまま判定すると
   * 資格が無いと見えて Demo 判定が立たない** = デモの出荷をそのまま HP の
   * Edge Function へ渡し、画面に `Order not found` が出る（PR-A が直した形が
   * fail-open で戻る）。組み込みの 4 件は config 無しでも当たるので、
   * **app_config で登録したデモ用アカウントだけが黙って落ちる**。
   */
  await refreshConfig().catch(() => undefined);
  const viewMode = viewModeFromRequest(ctx, viewer);
  const diagnosticUserId = viewer.writeTargetUid;

  if (action !== 'received' && action !== 'returned') {
    return json({ error: 'invalid action (expected received|returned)' }, 400);
  }
  if (!diagnosticUserId || !/^[0-9a-f-]{36}$/i.test(diagnosticUserId)) {
    return json({ error: 'missing or invalid diagnosticUserId' }, 400);
  }

  /*
   * ── デモ用アカウントの出荷は、どこにも書かずに「記録されない」と返す ──────────
   *
   * デモの出荷は `demo-data.ts` の**作り物**で、本番の `orders` に行が無い。
   * そのまま下の Edge Function へ渡すと **`Order not found` (404)** が返り、
   * 画面には「申告に失敗しました: Order not found」と出る（実測 2026-10-13）。
   * デモは記者やパートナーにも見せる枠なので、**押すとエラーになるボタン**を残さない。
   *
   * **条件は 2 つとも見る。** 片方だけだと
   *   - uid だけ → デモ用アカウントが**本物の出荷**を申告できなくなる
   *   - ID だけ → 本物の利用者がデモの ID を送れば**偽の成功**を受け取れる
   *
   * **Edge と DB の呼び出しより前**に置く（後ろだと 404 のあとに届いて意味がない）。
   * 成功とは言わず `demo: true` を返し、**画面側が「記録されません」と出す**
   * （黙って成功を装わない）。
   */
  if (viewMode.effectiveMode === 'demo' && isDemoShipmentId(id)) {
    return json({ ok: true, action, demo: true });
  }

  // 本番: HP の kit-self-report Edge Function に委譲 (正本 = orders)。
  // kit_shipment.id = orders.id = 本ルートの :id を order_id として渡す。
  if (isHpEdgeConfigured()) {
    try {
      const result = await submitKitSelfReport({
        orderId: id,
        diagnosticUserId,
        event: action,
      });
      return json({ ok: true, action, shipment: result });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  // dev フォールバック: モック customer スキーマを直接更新
  const sb = getServerSupabase();
  if (!sb) return json({ error: 'supabase not configured' }, 503);

  // 所有確認: diagnostic_user_id → customer_profiles.user_id → kit_shipments.customer_id
  const { data: profile, error: profileErr } = await sb
    .schema('customer')
    .from('customer_profiles')
    .select('user_id')
    .eq('diagnostic_user_id', diagnosticUserId)
    .maybeSingle();
  if (profileErr) return json({ error: `profile lookup: ${profileErr.message}` }, 500);
  if (!profile)   return json({ error: 'customer not found for diagnostic_user_id' }, 404);

  const { data: shipment, error: shipErr } = await sb
    .schema('customer')
    .from('kit_shipments')
    .select('id, customer_id, shipped_at, user_received_at, user_returned_at')
    .eq('id', id)
    .maybeSingle();
  if (shipErr)   return json({ error: `shipment lookup: ${shipErr.message}` }, 500);
  if (!shipment) return json({ error: 'shipment not found' }, 404);
  if (shipment.customer_id !== profile.user_id) {
    return json({ error: 'forbidden (shipment does not belong to user)' }, 403);
  }

  // ステート遷移の整合性チェック
  if (action === 'received' && !shipment.shipped_at) {
    return json({ error: '未発送のキットは受取申告できません' }, 409);
  }
  if (action === 'returned' && !shipment.user_received_at) {
    return json({ error: '受取申告前に返送申告はできません' }, 409);
  }

  const now = new Date().toISOString();
  const patch = action === 'received'
    ? { user_received_at: now }
    : { user_returned_at: now };

  const { data: updated, error: updErr } = await sb
    .schema('customer')
    .from('kit_shipments')
    .update(patch)
    .eq('id', id)
    .select('id, user_received_at, user_returned_at')
    .single();
  if (updErr) return json({ error: `update: ${updErr.message}` }, 500);

  return json({ ok: true, action, shipment: updated });
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
