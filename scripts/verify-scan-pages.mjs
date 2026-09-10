/**
 * 複数ページスキャンの回帰チェック (実ブラウザ)。
 *
 * 守りたい約束:
 *   ① **アップロードは選んだ全部が 1 つの一覧に出る** (ファイル名つき・1 枚ごとの確認を挟まない
 *      = 発注者指示 2026-09-10)。撮影は 1 枚ごとの確認を残す (⑧)
 *   ② **「全てを送信」を押すまで /api/scan を 1 回も呼ばない** — ここが唯一の確定点
 *   ③ 撮り直しは「いまの 1 枚」だけを捨てる (前のページへ戻らない)
 *   ④ 送信すると枚数ぶん順に呼ばれる (1 画像 = 1 リクエスト・Vercel 60 秒制限)
 *   ⑤ 選び直し = **新しいファイルが届いてから**入れ替える (閉じただけでは消えない)
 *   ⑥ **複数ファイルを 1 回のダイアログでまとめて選べる** (2026-09-10 発注者報告)
 *   ⑦ **アップロード経路のボタンでカメラを起動しない**
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

/**
 * dev サーバの astro-dev-toolbar が画面下端に重なり、一覧の最後のボタンへの
 * クリックを横取りする (実測)。**本番には無い要素**なので隠して測る。
 */
const hideDevToolbar = (pg) => pg.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' }).catch(() => {});

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
await hideDevToolbar(page);

const visible = (id) => page.evaluate((i) => {
  const el = document.getElementById(i);
  return !!el && !el.hidden;
}, id);
const text = (id) => page.evaluate((i) => document.getElementById(i)?.textContent?.trim() ?? '', id);

/**
 * 小さな画像を #scan-file へ流し込む (ダイアログで選んだのと同じ)。
 * **複数渡せる** — 発注者指示 2026-09-10 で複数選択が本流になったため。
 */
async function upload(...names) {
  await page.evaluate(async (ns) => {
    const dt = new DataTransfer();
    for (const n of ns) {
      const c = document.createElement('canvas');
      c.width = 120; c.height = 90;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 120, 90);
      ctx.fillStyle = '#000'; ctx.fillText(n, 10, 40);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      dt.items.add(new File([blob], n, { type: 'image/png' }));
    }
    const input = document.getElementById('scan-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, names);
  await page.waitForTimeout(300 + names.length * 500);
}

const thumbTexts = () => page.$$eval('#review-thumbs li', (ls) => ls.map((l) => l.textContent.trim()));

// ── ① アップロードは選んだ全部がそのまま一覧に出る (1 枚ごとの確認を挟まない) ──
await upload('p1.png', 'p2.png');
ok('① アップロードは確認の一覧へ直行する', await visible('panel-review'), '');
ok('  1 枚ごとの確認画面は出ない', !(await visible('panel-confirm')), '');
ok('  送信枚数が 2', (await text('review-count')) === '2', await text('review-count'));
ok('  一覧に 2 件出る', (await page.locator('#review-thumbs li').count()) === 2, '');
{
  const t = await thumbTexts();
  ok('① 一覧にファイル名が出る', t.some((s) => s.includes('p1.png')) && t.some((s) => s.includes('p2.png')), t.join(' | '));
}
ok('② この時点で /api/scan を呼んでいない', scanCalls === 0, `calls=${scanCalls}`);
ok('  「ファイルを選び直す」が出ている (全部ファイル由来)', await visible('review-repick'), '');
ok('  同じことをする「最初からやり直す」は隠れている', !(await visible('review-restart')), '');

// ── 追加 = 足す (既存は消えない) ──
await page.click('#review-add-file');   // ダイアログはリスナ無しで自動的に閉じる
await page.waitForTimeout(300);
await upload('p3.png');
ok('  「ファイルを追加」は足す (2 → 3 枚)', (await text('review-count')) === '3', await text('review-count'));

/*
 * ⑤ 選び直し = **新しいのが届いてから**入れ替える。
 * キャンセルの判定は `review-count` の文字を読むだけでは足りない — 押した時点で
 * 捨てる実装でも**再描画されないので数字は古いまま**で、退行を見逃す (実測)。
 * → キャンセル後に 1 件足して合計を見る (残っていれば 3+1=4 / 捨てていれば 0+1=1)。
 */
await page.click('#review-repick');
await page.waitForTimeout(500);
await page.click('#review-add-file');
await page.waitForTimeout(200);
await upload('p4.png');
ok('⑤ 選び直しをキャンセルしても捨てられていない (3 + 1 = 4 枚)', (await text('review-count')) === '4', await text('review-count'));
await page.click('#review-repick');
await page.waitForTimeout(200);
await upload('r1.png', 'r2.png');
ok('  選び直すと入れ替わる (4 → 2 枚)', (await text('review-count')) === '2', await text('review-count'));
{
  const t = await thumbTexts();
  ok('  古いファイル名は残らない', !t.some((s) => s.includes('p1.png')), t.join(' | '));
}
ok('② 一覧の操作では /api/scan を呼ばない', scanCalls === 0, `calls=${scanCalls}`);

// ── ④ 全てを送信 ──
await page.click('#review-send');
await page.waitForTimeout(3000);
ok('④ 送信で 2 回呼ばれた (1 画像 = 1 リクエスト)', scanCalls === 2, `calls=${scanCalls}`);
ok('  結果画面へ進んだ', await visible('panel-result'), '');
const summary = await text('scan-result-summary');
ok('  複数ページの結果が束ねられている', /2\s*領域|領域/.test(summary), summary);

// ── ⑤ 最初からやり直す (撮影が混じる回はこちらが出る) ──
page.on('dialog', (d) => d.accept());
await page.goto(`${BASE}/scan`, { waitUntil: 'networkidle' });
await hideDevToolbar(page);
scanCalls = 0;
await upload('q1.png', 'q2.png');
await page.click('#review-repick');
await page.waitForTimeout(200);
await upload('q3.png');
ok('⑤ 選び直しの後も一覧のまま', await visible('panel-review'), '');
ok('  枚数は選び直した 1 枚', (await text('review-count')) === '1', await text('review-count'));
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
  await hideDevToolbar(p);

  ok(`⑥ [${label}] input に multiple が付いている`,
    await p.evaluate(() => document.getElementById('scan-file')?.hasAttribute('multiple')), '');

  // 2 件を 1 回の change でまとめて投入 = ダイアログで 2 つ選んだのと同じ
  const send = (names) => p.evaluate(async (ns) => {
    const dt = new DataTransfer();
    for (const n of ns) {
      const c = document.createElement('canvas'); c.width = 100; c.height = 80;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 100, 80);
      g.fillStyle = '#000'; g.fillText(n, 5, 40);
      const b = await new Promise((r) => c.toBlob(r, 'image/png'));
      dt.items.add(new File([b], n, { type: 'image/png' }));
    }
    const input = document.getElementById('scan-file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, names);

  await send(['m1.png', 'm2.png']);
  await p.waitForTimeout(1500);
  const count = await p.evaluate(() => document.getElementById('review-count')?.textContent?.trim());
  ok(`⑥ [${label}] 一度に 2 件選ぶと 2 枚積まれる`, count === '2', count);
  ok(`① [${label}] アップロードは一覧へ直行する`,
    await p.evaluate(() => { const e = document.getElementById('panel-review'); return !!e && !e.hidden; }), '');

  // 「ファイルを追加」「ファイルを選び直す」= カメラを起動せずファイル選択を開く
  for (const btn of ['review-add-file', 'review-repick']) {
    const before = await p.evaluate(() => window.__gum);
    const chooserBefore = chooserCount;
    await p.click(`#${btn}`);
    await p.waitForTimeout(800);
    ok(`⑦ [${label}] #${btn} でカメラを起動しない`,
      (await p.evaluate(() => window.__gum)) === before, `gum ${before} → ${await p.evaluate(() => window.__gum)}`);
    ok(`⑦ [${label}] #${btn} でファイル選択が開く`, chooserCount > chooserBefore, `chooser=${chooserCount}`);
    ok(`⑥ [${label}] #${btn} のダイアログが複数選択を受け付ける`, chooserMultiple === true, String(chooserMultiple));
  }
  ok(`⑦ [${label}] エラー画面へ落ちない`,
    !(await p.evaluate(() => { const e = document.getElementById('panel-error'); return !!e && !e.hidden; })), '');
  ok(`⑦ [${label}] ダイアログを閉じただけでは枚数が変わらない`,
    (await p.evaluate(() => document.getElementById('review-count')?.textContent?.trim())) === '2', '');

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
  await hideDevToolbar(p);
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

  // 撮影が混じる回は「ファイルを選び直す」を出さない (撮った紙まで捨てないため)
  await p.click('#scan-shot');
  await p.waitForTimeout(1200);
  await p.click('#confirm-done');
  await p.waitForTimeout(500);
  ok('⑧ [スマホ] 撮影が混じる一覧に「選び直す」を出さない',
    await p.evaluate(() => document.getElementById('review-repick')?.hidden === true), '');
  ok('⑧ [スマホ] 代わりに「最初からやり直す」が出る',
    await p.evaluate(() => document.getElementById('review-restart')?.hidden === false), '');
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
