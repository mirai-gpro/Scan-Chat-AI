import type { APIRoute } from 'astro';
import { resolveViewer } from '../../../../lib/viewer';
import { denyReadOnlyWrite } from '../../../../lib/write-guard';
import { getServerSupabase } from '../../../../lib/supabase';
import { isHpEdgeConfigured, submitKitSelfReport } from '../../../../lib/hp-edge';

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
  const denied = denyReadOnlyWrite(await resolveViewer(ctx));
  if (denied) return denied;

  const id = params.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return json({ error: 'invalid shipment id' }, 400);
  }

  const body = await request.json().catch(() => null) as { action?: unknown; diagnosticUserId?: unknown } | null;
  const action = body?.action;
  const diagnosticUserId = typeof body?.diagnosticUserId === 'string' ? body.diagnosticUserId : null;

  if (action !== 'received' && action !== 'returned') {
    return json({ error: 'invalid action (expected received|returned)' }, 400);
  }
  if (!diagnosticUserId || !/^[0-9a-f-]{36}$/i.test(diagnosticUserId)) {
    return json({ error: 'missing or invalid diagnosticUserId' }, 400);
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
