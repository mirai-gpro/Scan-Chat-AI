/**
 * 受取時・外部検査ID の撮影導線を**実ブラウザで通す**検査（仕様 §4.4.9）。
 *
 * **なぜ静的検査と別に要るか。** 2026-10-22 の実機報告
 * 「ダッシュボードの『撮影して登録する』から即カメラが起動しない」の真因は、
 * **ダッシュボードが `external-id-capture.ts` を読み込んでいなかった**こと
 * （`initExternalIdCapture()` は `/kit` だけ）。合図を書く click ハンドラが動かないので、
 * 着いた先の `resumeStart()` は何も受け取れず、帯は**ただのリンク**になっていた。
 * スクリプトの中身はどれも正しかったので、**ファイル単位の検査では 1 件も落ちない**。
 * ここでは**ページが実際にそのスクリプトを読んでいるか**を、押して・移動して・
 * カメラが開くところまでで確かめる。
 *
 * 実物をそのまま使う:
 *   - 画面の処理 = `src/scripts/external-id-start.ts` / `external-id-capture.ts` を
 *     **esbuild で束ねて**読み込む（写した実装を検査しない）。
 *   - **どのページがどちらを読むかは、実際の `.astro` から決める**
 *     （`dashboard.astro` が import を失えばこの検査が落ちる）。
 *   - 差し替えるのは**カメラの口だけ**（`camera-scan` をスタブにして `start()` を数える）。
 *     端末のカメラは CI で開けないため。
 *
 * 実行: `npm run verify:extid-flow`（dev サーバは要らない）。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { chromium, devices } from 'playwright';

const ROOT = process.cwd();
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'extid-flow-'));
const PORT = 4399;

let fails = 0;
let total = 0;
const ok = (label, cond, extra = '') => {
  total++;
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) fails++;
};
/**
 * **コメント行を落としてから見る。** 落とさないと `// initExternalIdCapture();` のように
 * **コメントアウトしただけ**の退行が素通りする（実測・退行注入 3）。
 */
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
  .split('\n')
  .filter((l) => !/^\s*(?:\/\/|\/\*|\*)/.test(l))
  .join('\n');

/* ── ページが読むスクリプトを**実物から**決める ───────────────── */
const dashUi = read('src/pages/dashboard.astro');
const kitUi = read('src/pages/kit.astro');
const dashLoadsStart = /from '\.\.\/scripts\/external-id-start'/.test(dashUi)
  && /initExternalIdStartLinks\(\)/.test(dashUi);
const kitLoadsCapture = /from '\.\.\/scripts\/external-id-capture'/.test(kitUi)
  && /initExternalIdCapture\(\)/.test(kitUi);

/* ── 実物を束ねる（カメラの口だけスタブ）──────────────────────── */
const stub = {
  name: 'stub-native',
  setup(b) {
    // 端末のカメラは CI で開けないので、**開いたかどうかを数えるだけ**に差し替える。
    b.onResolve({ filter: /camera-scan$/ }, () => ({ path: 'camera', namespace: 'extid-stub' }));
    // wasm は esbuild が束ねられない（画面では Vite が `?url` で配る）。
    b.onResolve({ filter: /\.wasm(\?url)?$/ }, () => ({ path: 'wasm', namespace: 'extid-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'extid-stub' }, (args) => ({
      loader: 'js',
      contents: args.path === 'camera'
        ? `export function initCameraScan(refs){ window.__refs = !!(refs.video && refs.canvas);
             return { start: async () => { window.__started = (window.__started || 0) + 1; },
                      stop(){}, close(){} }; }`
        : 'export default "about:blank";',
    }));
  },
};
for (const [entry, name, globalName, init] of [
  ['src/scripts/external-id-start.ts', 'start.js', '__mStart', 'initExternalIdStartLinks'],
  ['src/scripts/external-id-capture.ts', 'capture.js', '__mCap', 'initExternalIdCapture'],
]) {
  await esbuild.build({
    entryPoints: [entry], outfile: path.join(OUT, name), bundle: true,
    format: 'iife', globalName, plugins: [stub], logLevel: 'error',
    footer: { js: `window.__init_${init} = ${globalName}.${init};` },
  });
}

/* ── 画面（帯と撮影ブロックの markup の契約だけを写す）──────────── */
const tag = (src, init) => `<script src="/${src}"></script><script>window.__init_${init}();</script>`;
fs.writeFileSync(path.join(OUT, 'dash.html'), `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>dash</title></head><body>
<a id="band" href="/kit.html#extid-S1" data-extid-start="S1">撮影して登録する</a>
${dashLoadsStart ? tag('start.js', 'initExternalIdStartLinks') : '<!-- dashboard.astro は合図を読み込んでいない -->'}
</body></html>`);
fs.writeFileSync(path.join(OUT, 'kit.html'), `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>kit</title></head><body>
<div id="extid-S1" data-extid-capture data-shipment-id="S1" data-provider="prevent" data-id-label="番号">
  <div data-extid-form>
    <button type="button" data-extid-camera-open hidden>撮影して登録する</button>
    <div data-extid-camera hidden>
      <video data-extid-video></video><canvas data-extid-canvas></canvas>
      <p data-extid-camera-status></p>
    </div>
    <div data-extid-confirm hidden><span data-extid-candidate></span><p data-extid-note></p></div>
    <p data-extid-status></p>
  </div>
</div>
${kitLoadsCapture ? tag('capture.js', 'initExternalIdCapture') : '<!-- kit.astro は撮影を読み込んでいない -->'}
</body></html>`);

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' };
const srv = http.createServer((req, res) => {
  const f = path.join(OUT, (req.url || '/').split('?')[0].replace(/^\//, '') || 'dash.html');
  if (!f.startsWith(OUT) || !fs.existsSync(f)) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'text/plain' });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => srv.listen(PORT, r));

console.log('\n受取ID 撮影導線（実ブラウザ・§4.4.9）\n');
ok('ダッシュボードが合図のスクリプトを読み込んでいる', dashLoadsStart);
ok('`/kit` が撮影のスクリプトを読み込んでいる', kitLoadsCapture);

const browser = await chromium
  .launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' })
  .catch(() => chromium.launch());

// ── スマートフォン（`(pointer: coarse)`）──────────────────────
{
  const ctx = await browser.newContext({ ...devices['Pixel 5'] });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/dash.html`);
  await page.click('#band');
  await page.waitForURL('**/kit.html#extid-S1');
  const started = await page.waitForFunction(() => window.__started > 0, null, { timeout: 5000 })
    .then(() => true).catch(() => false);
  ok('**ダッシュボードの帯を 1 回押すと、着いた先でカメラが開く**', started,
    'カメラの start() が呼ばれない（帯がただのリンクに戻っている）');
  ok('カメラに video / canvas を渡している', await page.evaluate(() => window.__refs === true));
  ok('合図は使い切られている（残らない）',
    (await page.evaluate(() => sessionStorage.getItem('welltect.extid.start'))) === null);

  const p2 = await ctx.newPage();
  await p2.goto(`http://localhost:${PORT}/kit.html#extid-S1`);
  await p2.waitForTimeout(600);
  ok('合図が無ければ開かない（`/kit` を直接開いた回・ハッシュでは開かない）',
    await p2.evaluate(() => !window.__started));
  await ctx.close();
}

// ── PC（`(pointer: fine)`）────────────────────────────────────
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/dash.html`);
  await page.click('#band');
  await page.waitForURL('**/kit.html#extid-S1');
  await page.waitForTimeout(600);
  ok('PC では開かない（QR でスマートフォンへ送る）', await page.evaluate(() => !window.__started));
  await ctx.close();
}

await browser.close();
srv.close();
fs.rmSync(OUT, { recursive: true, force: true });
console.log(fails === 0 ? `\n✓ ${total} / ${total} passed` : `\n✗ ${fails} 件 FAIL (${total - fails} passed)`);
process.exit(fails === 0 ? 0 : 1);
