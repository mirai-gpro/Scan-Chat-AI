/**
 * admin: 受取時・外部検査ID の**撮影台帳の一覧**（§12.1 の確認・訂正経路）。
 *
 *   GET /api/admin/external-id-captures/list?bucket=review|confirmed|all&limit=200
 *     (Bearer ADMIN_API_KEY)
 *
 * 正本: `docs/lab/kit_receipt_external_id_capture_spec.md` §12.1。
 * UI は wellfort-site（責務分界: admin UI=wellfort-site / 処理=Scan-Chat-AI）。
 *
 * **外部IDの全文は返さない**（マスクだけ・仕様 §6.1）。全文と証跡画像は
 * `detail`（1 行を意図して開いたとき）だけが返す。
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { getServerSupabase } from '../../../../lib/supabase';
import { refreshConfig } from '../../../../lib/app-config';
import { listAdminCaptures, type AdminBucket } from '../../../../lib/external-id-admin';
import { adminConfigFromAppConfig } from '../../../../lib/external-id-admin-config';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const GET: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  const sb = getServerSupabase();
  if (!sb) return json({ ok: false, error: 'supabase_not_configured' }, 503);

  // 判定に `labid.*` を使うので、**処理の前に**読む（CLAUDE.md）。
  await refreshConfig().catch(() => undefined);

  const url = new URL(request.url);
  const raw = (url.searchParams.get('bucket') || '').trim();
  const bucket: AdminBucket = raw === 'confirmed' || raw === 'all' ? raw : 'review';
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : undefined;

  const res = await listAdminCaptures({ sb, bucket, limit, cfg: adminConfigFromAppConfig() });
  if (!res.ok) return json({ ok: false, error: res.error, detail: res.detail }, res.status);

  return json({
    ok: true, bucket,
    rows: res.rows, count: res.count,
    // **「引けなかった」を 0 件と混同しない**（画面に警告を出すため）。
    migrationApplied: res.migrationApplied,
  });
};
