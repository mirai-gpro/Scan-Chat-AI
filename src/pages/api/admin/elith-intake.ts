/**
 * admin: **Elith の下りを「いま」取り込む** (随時バッチ)。
 *
 * 毎日の自動取り込み (`/api/cron/elith-intake`) と**同じ本体**を呼ぶ
 * (`elith-intake.ts` の `runElithIntake`)。時刻を待たずに流したいとき・
 * 初回のまとめ取り込み・切り分けに使う。
 *
 * 認可 = Bearer `ADMIN_API_KEY`。UI は wellfort-site 側 (責務分界)。
 *
 *   POST /api/admin/elith-intake?dry_run=1     → **読むだけ**。何が取り込まれるかの一覧
 *   POST /api/admin/elith-intake               → 取り込む
 *   POST /api/admin/elith-intake?client_id=…   → その人だけ
 *
 * **既定を dry-run にしない** — 押した人は「取り込む」つもりで押す。
 * 代わりに応答へ必ず一覧を付けて、何をしたかが分かるようにする。
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../lib/api-auth';
import { getServerSupabase } from '../../../lib/supabase';
import { runElithIntake } from '../../../lib/elith-intake';

export const prerender = false;
/** S3 の読み出し + 取り込みを件数ぶん回すので、既定の 60s では足りないことがある。 */
export const config = { maxDuration: 300 };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dry_run') === '1';
  const onlyClientId = url.searchParams.get('client_id')?.trim() || undefined;
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : undefined;

  try {
    const r = await runElithIntake(getServerSupabase() as never, { dryRun, onlyClientId, limit });
    // 設定漏れ (S3 / Supabase 未設定) は「0 件」と区別する。混ぜると見張りが緑のままになる。
    return json(r, r.ok ? 200 : 503);
  } catch (e) {
    return json({ ok: false, error: 'intake_failed', detail: e instanceof Error ? e.message : String(e) }, 502);
  }
};
