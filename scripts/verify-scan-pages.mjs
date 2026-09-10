/**
 * 複数ページスキャンの回帰チェック (実ブラウザ)。
 *
 * 守りたい約束:
 *   ① 1 枚ごとに確認画面が出る (撮影・アップロードとも)
 *   ② **「全てを送信」を押すまで /api/scan を 1 回も呼ばない** — ここが唯一の確定点
 *   ③ 撮り直しは「いまの 1 枚」だけを捨てる (前のページへ戻らない)
 *   ④ 送信すると枚数ぶん順に呼ばれる (1 画像 = 1 リクエスト・Vercel 60 秒制限)
 *   ⑤ 最初からやり直すと全部捨てる
 *   ⑥ **複数ファイルを 1 回のダイアログでまとめて選べる** (2026-09-10 発注者報告)
 *   ⑦ **アップロードで入れた 1 枚から「次の用紙」「選び直す」でカメラを起動しない**
 *      (同報告。PC はカメラ非対応なので必ず失敗し、スマホでは実際にカメラが開いていた)
 *   ⑧ 撮影で入れた 1 枚からは従来どおりカメラで続ける (⑦の直しで撮影経路を壊さない)
 *
 * 前提: `npm run dev` が起動していること。URL は `VERIFY_URL` で差し替えられる。
 */
import { chromium, devices } from 'playwright';

const BASE = process.env.VERIFY_URL ?? 'http://localhost:4321';
const EXEC = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
// ⑧ で「カメラが実際に開くこと」を見るために偽カメラを積む。
// ⑦ は getUserMedia の呼び出し回数で見るので、カメラの有無に関係なく成立する。
const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

let browser;
try {
  browser = await chromium.launch({ executablePath: EXEC, args: ARGS });
} catch {
  browser = await chromium.launch({ args: ARGS });
}
const page = await browser.newPage();

let scanCalls = 0;
await page.route('**/api/scan', async (route) => {
  scanCalls += 1;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      markdown: `## 検査結果\n\n| 項目 | 値 |\n|---|---|\n| AST | 22 |`,
      finishReason: 'STOP',
    }),
  });
});
// チケットは使わせない (小さい画像なので inline 経路に乗る)
await page.route('**/api/scan/upload-ticket', (r) =>
  r.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }),
);

await page.goto(`${BASE}/scan`, { waitUntil: 'networkidle' });

const visible = (id) => page.evaluate((i) => {
  const el = document.getElementById(i);
  return !!el && !el.hidden;
}, id);
const text = (id) => page.evaluate((i) => document.getElementById(i)?.textContent?.trim() ?? '', id);

/** 小さな画像を 1 枚 #scan-file へ流し込む。 */
async function upload(name) {
  await page.evaluate(async (n) => {
    const c = document.createElement('canvas');
    c.width = 120; c.height = 90;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 120, 90);
    ctx.fillStyle = '#000'; ctx.fillText(n, 10, 40);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], n, { type: 'image/png' }));
    const input = document.getElementById('scan-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, name);
  await page.waitForTimeout(700);
}

// ── ① 1 枚目 → 確認画面 ──
await upload('p1.png');
ok('1 枚目で確認画面が出る', await visible('panel-confirm'), '');
ok('  枚数の表示が 1 枚目', (await text('confirm-page-label')) === '1 枚目', await text('confirm-page-label'));
ok('  プレビュー画像が出ている', await visible('confirm-image'), '');
ok('② この時点で /api/scan を呼んでいない', scanCalls === 0, `calls=${scanCalls}`);

// ── ③ 撮り直し = いまの 1 枚だけ捨てる ──
await page.click('#confirm-retake');
await page.waitForTimeout(300);
await upload('p1b.png');
ok('③ 撮り直し後も 1 枚目のまま (増えていない)', (await text('confirm-page-label')) === '1 枚目', await text('confirm-page-label'));

// ── 2 枚目 ──
await page.click('#confirm-next');
await page.waitForTimeout(300);
await upload('p2.png');
ok('2 枚目で「2 枚目」と出る', (await text('confirm-page-label')) === '2 枚目', await text('confirm-page-label'));
ok('② まだ /api/scan を呼んでいない', scanCalls === 0, `calls=${scanCalls}`);

// ── 最終確認 ──
await page.click('#confirm-done');
await page.waitForTimeout(300);
ok('「これで全部」で最終確認へ', await visible('panel-review'), '');
ok('  送信枚数が 2', (await text('review-count')) === '2', await text('review-count'));
ok('  一覧に 2 件出る', (await page.locator('#review-thumbs li').count()) === 2, '');
ok('② 最終確認の時点でもまだ呼んでいない', scanCalls === 0, `calls=${scanCalls}`);

// ── ④ 全てを送信 ──
await page.click('#review-send');
await page.waitForTimeout(3000);
ok('④ 送信で 2 回呼ばれた (1 画像 = 1 リクエスト)', scanCalls === 2, `calls=${scanCalls}`);
ok('  結果画面へ進んだ', await visible('panel-result'), '');
const summary = await text('scan-result-summary');
ok('  複数ページの結果が束ねられている', /2\s*領域|領域/.test(summary), summary);

// ── ⑤ 最初からやり直す ──
page.on('dialog', (d) => d.accept());
await page.goto(`${BASE}/scan`, { waitUntil: 'networkidle' });
scanCalls = 0;
await upload('q1.png');
await page.click('#confirm-next');
await page.waitForTimeout(300);
await upload('q2.png');
await page.click('#confirm-restart');
await page.waitForTimeout(500);
ok('⑤ 最初からやり直すと最初の画面へ', await visible('panel-ready'), '');
await upload('r1.png');
ok('  破棄されて 1 枚目から数え直す', (await text('confirm-page-label')) === '1 枚目', await text('confirm-page-label'));
ok('  やり直しても送信していない', scanCalls === 0, `calls=${scanCalls}`);

/* ══════════════════════════════════════════════════════════════════
 * ⑥⑦⑧ ファイル選択とカメラの出し分け (2026-09-10 発注者報告の直し)
 *
 * 実測 (直す前): PC・スマホとも `multiple` 無し = 2 件選んでも 1 枚しか積まれず、
 * 「次の用紙」で `getUserMedia` が 1 回呼ばれていた (PC はカメラが無いのでエラー画面)。
 * ここが静かに戻ると、PC 利用者はアップロードの続きができなくなる。
 * ══════════════════════════════════════════════════════════════════ */

/** 1 つの端末形状で ⑥⑦ を測る。`opts` は newContext にそのまま渡す。 */
async function checkPickerRoute(label, opts) {
  const ctx = await browser.newContext(opts);
  // getUserMedia の呼び出し回数を数える (カメラが起動したかの唯一の決定的な指標)。
  await ctx.addInitScript(() => {
    window.__gum = 0;
    const md = navigator.mediaDevices;
    if (md?.getUserMedia) {
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = (...a) => { window.__gum += 1; return orig(...a); };
    }
  });
  const p = await ctx.newPage();
  await p.route('**/api/scan', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"markdown":"x","finishReason":"STOP"}' }));
  await p.route('**/api/scan/upload-ticket', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }));

  // ファイル選択ダイアログが開いたか / 複数選択を受け付けるか
  let chooserCount = 0;
  let chooserMultiple = null;
  p.on('filechooser', (fc) => {
    chooserCount += 1;
    chooserMultiple = fc.isMultiple();
    fc.setFiles([]).catch(() => {});
  });

  await p.goto(`${BASE}/scan`, { waitUntil: 'networkidle' });

  ok(`⑥ [${label}] input に multiple が付いている`,
    await p.evaluate(() => document.getElementById('scan-file')?.hasAttribute('multiple')), '');

  // 2 件を 1 回の change でまとめて投入 = ダイアログで 2 つ選んだのと同じ
  await p.evaluate(async () => {
    const mk = async (n) => {
      const c = document.createElement('canvas'); c.width = 100; c.height = 80;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 100, 80);
      g.fillStyle = '#000'; g.fillText(n, 5, 40);
      const b = await new Promise((r) => c.toBlob(r, 'image/png'));
      return new File([b], n, { type: 'image/png' });
    };
    const dt = new DataTransfer();
    dt.items.add(await mk('m1.png'));
    dt.items.add(await mk('m2.png'));
    const input = document.getElementById('scan-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await p.waitForTimeout(1200);
  const label2 = await p.evaluate(() => document.getElementById('confirm-page-label')?.textContent?.trim());
  ok(`⑥ [${label}] 一度に 2 件選ぶと 2 枚積まれる`, label2 === '2 枚目', label2);

  ok(`⑦ [${label}] アップロードの「撮り直す」が「選び直す」と名乗る`,
    (await p.evaluate(() => document.getElementById('confirm-retake-label')?.textContent?.trim())) === '選び直す',
    await p.evaluate(() => document.getElementById('confirm-retake-label')?.textContent?.trim()));

  // 「次の用紙」= カメラを起動せずファイル選択を開く
  const before = await p.evaluate(() => window.__gum);
  const chooserBefore = chooserCount;
  await p.click('#confirm-next');
  await p.waitForTimeout(800);
  ok(`⑦ [${label}] 「次の用紙」でカメラを起動しない`,
    (await p.evaluate(() => window.__gum)) === before, `gum ${before} → ${await p.evaluate(() => window.__gum)}`);
  ok(`⑦ [${label}] 「次の用紙」でファイル選択が開く`, chooserCount > chooserBefore, `chooser=${chooserCount}`);
  ok(`⑥ [${label}] そのダイアログが複数選択を受け付ける`, chooserMultiple === true, String(chooserMultiple));
  ok(`⑦ [${label}] エラー画面へ落ちない`,
    !(await p.evaluate(() => { const e = document.getElementById('panel-error'); return !!e && !e.hidden; })), '');

  // 「選び直す」= 1 枚戻したうえでファイル選択を開く (キャンセルしても表示と枚数が食い違わない)
  const gum2 = await p.evaluate(() => window.__gum);
  await p.click('#confirm-retake');
  await p.waitForTimeout(800);
  ok(`⑦ [${label}] 「選び直す」でもカメラを起動しない`,
    (await p.evaluate(() => window.__gum)) === gum2, `gum=${await p.evaluate(() => window.__gum)}`);
  const label3 = await p.evaluate(() => document.getElementById('confirm-page-label')?.textContent?.trim());
  ok(`⑦ [${label}] キャンセルしても表示が 1 枚戻った状態と合う`, label3 === '1 枚目', label3);

  await ctx.close();
}

await checkPickerRoute('PC', { viewport: { width: 1280, height: 900 } });
await checkPickerRoute('スマホ', { ...devices['iPhone 13'] });

// ── ⑧ 撮影で入れた 1 枚は従来どおりカメラで続く (スマホのみ) ──
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'], permissions: ['camera'] });
  await ctx.addInitScript(() => {
    window.__gum = 0;
    const md = navigator.mediaDevices;
    if (md?.getUserMedia) {
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = (...a) => { window.__gum += 1; return orig(...a); };
    }
  });
  const p = await ctx.newPage();
  await p.route('**/api/scan', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"markdown":"x","finishReason":"STOP"}' }));
  await p.goto(`${BASE}/scan`, { waitUntil: 'networkidle' });
  await p.click('#scan-start');
  await p.waitForTimeout(2500);
  const started = await p.evaluate(() => window.__gum);
  ok('⑧ [スマホ] 「カメラで撮影」でカメラが開く', started >= 1, `gum=${started}`);
  await p.click('#scan-shot');
  await p.waitForTimeout(1500);
  const onConfirm = await p.evaluate(() => { const e = document.getElementById('panel-confirm'); return !!e && !e.hidden; });
  ok('⑧ [スマホ] 撮影後に確認画面が出る', onConfirm, '');
  ok('⑧ [スマホ] 撮影経路のラベルは「撮り直す」のまま',
    (await p.evaluate(() => document.getElementById('confirm-retake-label')?.textContent?.trim())) === '撮り直す',
    await p.evaluate(() => document.getElementById('confirm-retake-label')?.textContent?.trim()));
  const beforeNext = await p.evaluate(() => window.__gum);
  await p.click('#confirm-next');
  await p.waitForTimeout(1500);
  ok('⑧ [スマホ] 撮影経路の「次の用紙」はカメラを開く',
    (await p.evaluate(() => window.__gum)) > beforeNext, `gum ${beforeNext} → ${await p.evaluate(() => window.__gum)}`);
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
