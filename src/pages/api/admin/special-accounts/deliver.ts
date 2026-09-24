/**
 * スペシャルアカウントの Elith 納品を一括作成する admin API。
 *
 *   POST /api/admin/special-accounts/deliver   (Bearer ADMIN_API_KEY)
 *     body: { deliveryPrefix?: string, sourcePrefix?: string, bundleDate?: string }
 *
 * 問診+スキャン済みのスペシャルアカウントを対象に、ウェルネス年齢を算出 →
 * Elith 納品セット (HealthCheckup + Lifestyle + HealthAge) をラップ → S3 へ書き出し →
 * `elith_deliveries` へ記録する。処理本体は `src/lib/elith-delivery.ts`。
 *
 * 【納品先】`deliveryPrefix` 既定 '' = バケット直下 = **本番 Elith 受け取り位置**
 *   (発注者確定 2026-09-24)。テスト時は 'scan-accuracy-test/' 等を明示指定する。
 * 【捏造ゼロ】ウェルネス年齢が算出不能な回は HealthAgeData を載せない (HC+Lifestyle のみ)。
 */

import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { getS3Config } from '../../../../lib/s3';
import { deliverReadySpecialAccounts } from '../../../../lib/elith-delivery';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  const cfg = getS3Config();
  if (!cfg) return json({ ok: false, error: 's3_not_configured', detail: 'AWS_REGION 未設定' }, 400);

  let body: { deliveryPrefix?: unknown; sourcePrefix?: unknown; bundleDate?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // body 無しでも既定で動かす (deliveryPrefix='' = 本番)。
  }

  // 納品先: 既定 '' = バケット直下 = 本番。明示 'scan-accuracy-test/' 等でテスト可。
  const deliveryPrefix = typeof body.deliveryPrefix === 'string' ? body.deliveryPrefix : '';
  const sourcePrefix = str(body.sourcePrefix) ?? cfg.prefix ?? 'scan-accuracy-test/';
  const bundleDate = str(body.bundleDate);

  try {
    const summary = await deliverReadySpecialAccounts({ deliveryPrefix, sourcePrefix, bundleDate });
    return json({ ok: true, ...summary });
  } catch (e) {
    return json(
      { ok: false, error: 'deliver_failed', detail: String((e as { message?: string })?.message ?? e) },
      502,
    );
  }
};
