/**
 * GET /api/admin/scan-jobs — **失敗と滞留を数える。**
 *
 * 正本: `docs/scan/スキャン非同期処理_仕様書.md` §4.5。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【なぜ第一級要件か】発注者判断 2026-09-10 で**失敗はユーザーに一切出さない**
 * (「問題があれば、それはこちら側のトラブル対応」)。
 * → **admin が見なければ本当に誰も気づかない。**「あれば良い」ではない。
 * ══════════════════════════════════════════════════════════════════════
 *
 * 出すのは 2 つだけ:
 *   ①失敗したジョブ ②滞留しているジョブ (queued/running のまま一定時間超え)
 * 滞留は**画像がライフサイクルで消える前の警告**でもある (消えると復旧不能)。
 *
 * **uid も S3 キーも返さない** (§3.3)。監視に要るのは件数と理由だけ。
 *
 * 認可: Bearer ADMIN_API_KEY (`api-auth.ts`・キー未設定の本番は拒否)。
 * UI は wellfort-site 側。**このリポジトリに admin 画面は作らない。**
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../lib/api-auth';
import { scanJobHealth } from '../../../lib/scan-jobs';

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
  const stale = Number(url.searchParams.get('stale_minutes') ?? '30');
  const h = await scanJobHealth(Number.isFinite(stale) && stale > 0 ? stale : 30);
  /*
   * **「引けなかった」を 0 件と混同しない。** 未設定・障害を 0 件として返すと、
   * 見張り (GitHub Actions) が緑のままになり、**壊れていることに誰も気づかない**。
   */
  if (!h.ok) {
    return h.configured === false
      ? json({ ok: false, error: 'supabase_not_configured' }, 503)
      : json({ ok: false, error: 'query_failed' }, 500);
  }

  /*
   * **`problems` が 0 か非 0 か**だけを見張りが使う (GitHub Actions)。
   * 通知基盤は作らず、CI が赤くなることを通知の代わりにする
   * (CLAUDE.md「通知基盤を作らず GitHub Actions の日次ワークフローを見張りにする」)。
   */
  return json({ ok: true, problems: h.failed + h.stale, failed: h.failed, stale: h.stale, rows: h.rows });
};
