// vite の「クライアント依存の最適化」を、検査の前に実ブラウザで 1 度だけ起こす。
//
// **curl では起きない。** dev サーバは SSR の HTML を返すだけで、クライアント側の
// モジュールグラフを辿らないので、`@supabase/supabase-js` のような**クライアント依存**は
// 最適化されない。最適化は**最初の実ブラウザ遷移**で走り、終わると vite が
// `optimized dependencies changed. reloading` を出して**ページをリロードさせる**。
// これが検査の遷移に重なると `page.goto: net::ERR_ABORTED` /
// `page.evaluate: Execution context was destroyed` で落ちる。
//
// 実測 (2026-10-12・`node_modules/.vite` を消した状態):
//   curl で 6 URL を温めたあと          → `optimized dependencies changed` **0 件**
//   そのあとブラウザで 1 遷移しただけで → `new dependencies optimized: @supabase/supabase-js`
//
// → **CI の curl 温めだけでは構造的に防げない**ので、ここで実ブラウザを 1 度通す。
//
// 手元でも**リロードが検査の実行中に重なること自体は再現する** (dev サーバのログの時刻:
// 検査の開始 10:24:43 → リロード 10:24:44)。ただし**落ちるかは巡り合わせ**で、手元では
// 操作の合間に入って素通りした。CI の runner では `page.evaluate` の最中に入って
// `Execution context was destroyed` になる。**この子はその窓そのものを無くす。**
// **検査そのものには触らない** (この子は何も assert しない・失敗しても非 0 を返さない)。
import { chromium } from 'playwright';

const BASE = process.env.VERIFY_URL ?? 'http://localhost:4321';
// verify-screen.mjs と同じ起動の形 (既定パスで試して、駄目なら Playwright の既定へ)。
const EXEC = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const PAGES = ['/report?preview=1', '/report?preview=1&print=1', '/dashboard'];

let browser;
try {
  try {
    browser = await chromium.launch({ executablePath: EXEC });
  } catch {
    browser = await chromium.launch();
  }
  const page = await browser.newPage();
  for (const u of PAGES) {
    try {
      await page.goto(BASE + u, { waitUntil: 'networkidle', timeout: 60_000 });
      console.log(`warm ${u} ok`);
    } catch (e) {
      // ここで落ちても検査は走らせる (温めは最適化を誘発するのが目的で、合否を決めない)。
      console.log(`warm ${u} → ${String(e?.message ?? e).split('\n')[0]} (無視して進む)`);
    }
  }
} catch (e) {
  console.log(`warm-up を実行できなかった: ${String(e?.message ?? e).split('\n')[0]} (無視して進む)`);
} finally {
  await browser?.close().catch(() => {});
}
console.log('browser warm-up done');
