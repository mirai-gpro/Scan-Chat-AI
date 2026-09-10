/**
 * /scan のアップロード経路の回帰チェック。
 *
 * 【なぜ機械で見張るのか】
 * この経路の失敗は**アプリのログに出ない**。POST body が Vercel の上限
 * (4.5 MB・vercel.com/docs/functions/limitations「Request body size」) を超えると、
 * 関数に届く前にプラットフォームが 413 `FUNCTION_PAYLOAD_TOO_LARGE` を返すので、
 * `/api/scan` は呼ばれず、こちらのコードには何の痕跡も残らない。
 * 画面に出る上限 (10 MB) と、実際に送れる大きさは別物なので、
 * 「上限の数字を上げただけ」で壊れていないことをここで固定する。
 *
 * 前提: `npm run dev` が起動していること。URL は `VERIFY_URL` で差し替えられる。
 * /api/scan は route で握り潰すので Gemini キーは要らない。
 */
import { chromium } from 'playwright';

const BASE = process.env.VERIFY_URL ?? 'http://localhost:4321';
const EXEC = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

/** Vercel Functions のリクエストボディ上限 (src/scripts/scan-upload.ts と同じ根拠)。 */
const VERCEL_LIMIT = 4_500_000;

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MiB';

let browser;
try {
  browser = await chromium.launch({ executablePath: EXEC });
} catch {
  browser = await chromium.launch();
}
const page = await browser.newPage();

let lastBody = null;
await page.route('**/api/scan', async (route) => {
  lastBody = route.request().postData() ?? '';
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ markdown: '| a |\n|---|\n| 1 |', finishReason: 'STOP' }),
  });
});

await page.goto(`${BASE}/scan`, { waitUntil: 'networkidle' });
// dev サーバの astro-dev-toolbar が画面下端のボタンへのクリックを横取りする (本番には無い)。
await page.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' }).catch(() => {});

/**
 * ブラウザ内でファイルを作って #scan-file に流し込む。
 * 画像は**ノイズ**で描く — 単色だと圧縮が効きすぎて大きさの検証にならない。
 * ノイズは JPEG にとって最悪ケースなので、実際の検査票の写真はこれより小さくなる。
 */
async function upload({ name, type, w, h, bytes, quality = 1.0 }) {
  lastBody = null;
  await page.evaluate(
    async ({ name, type, w, h, bytes, quality }) => {
      let file;
      if (type === 'application/pdf') {
        file = new File([new Uint8Array(bytes)], name, { type });
      } else {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(w, h);
        for (let i = 0; i < img.data.length; i += 4) {
          img.data[i] = Math.random() * 255;
          img.data[i + 1] = Math.random() * 255;
          img.data[i + 2] = Math.random() * 255;
          img.data[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        file = new File([await new Promise((r) => c.toBlob(r, type, quality))], name, { type });
      }
      window.__lastFileSize = file.size;
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('scan-file');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { name, type, w, h, bytes, quality },
  );
  await page.waitForTimeout(4000);
  /*
   * 複数ページ化 (2026-09-04) で、ファイルを選んだだけでは送信されなくなった。
   * 「全てを送信」まで進めて初めて `/api/scan` へ POST する。
   * **この検査が見たいのは「何が線に乗るか」**なので、画面がそこまで来ていたら
   * 押し切る (来ていなければ何もしない = 送らない検査も生きる)。
   * アップロードは**一覧へ直行する**ようになった (発注者指示 2026-09-10) ので
   * `confirm-done` は出ない。**両方試す** — 撮影経路が混じっても通るように。
   */
  const advance = async (id) => {
    const el = await page.$(`#${id}`);
    if (!el) return false;
    const shown = await el.evaluate((n) => n.offsetParent !== null);
    if (!shown) return false;
    await el.click();
    await page.waitForTimeout(1500);
    return true;
  };
  await advance('confirm-done');
  await advance('review-send');
  await page.waitForTimeout(2500);
  return {
    size: await page.evaluate(() => window.__lastFileSize),
    err: await page.evaluate(() => {
      const el = document.getElementById('error-message');
      return el && el.offsetParent !== null ? el.textContent.trim() : '';
    }),
    body: lastBody,
  };
}

// ── ① 画面の表示と実装が食い違っていないか ──
{
  const label = await page.textContent('label[for="scan-file"]');
  ok('ラベルが 10 MB を名乗っている', /最大\s*10\s*MB/.test(label ?? ''), (label ?? '').trim());
}

// ── ② 大きな写真: 受け付けたうえで、上限内に収めて送る ──
{
  const r = await upload({ name: 'big.jpg', type: 'image/jpeg', w: 4032, h: 3024, quality: 0.82 });
  ok('大きな写真 (4032x3024) を受け付ける', !r.err, r.err || `file=${mb(r.size)}`);
  ok('POST が発生する', !!r.body, r.body ? `body=${mb(r.body.length)}` : 'POST なし');
  if (r.body) {
    ok(
      'POST body が Vercel の 4.5 MB 未満',
      r.body.length < VERCEL_LIMIT,
      `${r.body.length} < ${VERCEL_LIMIT} (元 ${mb(r.size)} → ${mb(r.body.length)})`,
    );
    ok('JPEG へ再エンコードされている', r.body.includes('data:image/jpeg;base64,'), '');
  }
}

// ── ③ 小さい画像は無変換 = 画質を落とさない (従来どおり) ──
{
  const r = await upload({ name: 'small.png', type: 'image/png', w: 500, h: 400 });
  ok('小さな画像を受け付ける', !r.err, r.err || `file=${mb(r.size)}`);
  ok(
    '小さな画像は無変換 (PNG のまま送る)',
    !!r.body && r.body.includes('data:image/png;base64,'),
    '',
  );
}

// ── ④ PDF は縮小できない。黙って 413 にせず理由を出す ──
{
  const r = await upload({ name: 'big.pdf', type: 'application/pdf', bytes: 5 * 1024 * 1024 });
  ok('予算超えの PDF は POST しない', !r.body, '');
  ok('予算超えの PDF は理由を表示する', /PDF は .+ までしか送信できません/.test(r.err), r.err);
}

// ── ⑤ 受付上限そのもの ──
{
  const r = await upload({ name: 'huge.pdf', type: 'application/pdf', bytes: 11 * 1024 * 1024 });
  ok('10 MB 超は POST しない', !r.body, '');
  ok('10 MB 超は上限を伝える', /10\.0 MB 以下にしてください/.test(r.err), r.err);
}

// ─────────────────────────────────────────────────────────────
// ⑥ S3 直アップロード経路 (presigned)。
//    ここまでは S3 未設定の前提 = 圧縮フォールバックの検証だった。
//    以降はチケット発行と PUT を差し替えて、S3 が使えるときの挙動を見る。
// ─────────────────────────────────────────────────────────────
const S3_KEY = 'scan-accuracy-test/scan-uploads/2026/09/04/0189d4c1-2b3a-4c5d-8e6f-a1b2c3d4e5f6.pdf';
let putBytes = null;
let putContentType = null;

await page.route('**/api/scan/upload-ticket', async (route) => {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      upload_url: 'https://s3.example.invalid/put-target',
      key: S3_KEY,
      headers: { 'content-type': JSON.parse(route.request().postData() ?? '{}').contentType },
      expires_in: 900,
      max_bytes: 10 * 1024 * 1024,
    }),
  });
});
await page.route('https://s3.example.invalid/**', async (route) => {
  putBytes = (route.request().postDataBuffer() ?? Buffer.alloc(0)).length;
  putContentType = route.request().headers()['content-type'] ?? null;
  await route.fulfill({ status: 200, body: '' });
});

{
  // PDF は縮小できないので、S3 が無いと送れなかったファイル。
  const r = await upload({ name: 'big.pdf', type: 'application/pdf', bytes: 8 * 1024 * 1024 });
  ok('予算超えの PDF が S3 経由で通る (エラーにならない)', !r.err, r.err);
  ok('ファイル本体が S3 へ PUT された', putBytes === 8 * 1024 * 1024, `PUT ${putBytes} bytes`);
  ok('PUT の Content-Type が署名と一致する', putContentType === 'application/pdf', String(putContentType));
  if (r.body) {
    const sent = JSON.parse(r.body);
    ok('/api/scan には本体でなくキーだけを渡す', !sent.image && sent.imageKey === S3_KEY, sent.imageKey ?? '');
    ok(
      'Vercel を通る body が極小 (4.5 MB 制限を回避できている)',
      r.body.length < 10_000,
      `${r.body.length} bytes`,
    );
  } else {
    ok('/api/scan が呼ばれる', false, 'POST なし');
  }
}

{
  // 大きな画像も、S3 が使えるなら**圧縮せず**原本を送る。
  putBytes = null;
  const r = await upload({ name: 'big2.jpg', type: 'image/jpeg', w: 4032, h: 3024, quality: 0.82 });
  ok('大きな画像も S3 経由で原本のまま送る', putBytes === r.size, `PUT ${putBytes} / file ${r.size}`);
  const sent = r.body ? JSON.parse(r.body) : {};
  ok('画像も本体でなくキーを渡す', sent.imageKey === S3_KEY && !sent.image, '');
}

// ── ⑦ S3 が失敗したら圧縮へ落ちる (fail-safe) ──
{
  await page.unroute('**/api/scan/upload-ticket');
  await page.route('**/api/scan/upload-ticket', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }),
  );
  const r = await upload({ name: 'fallback.jpg', type: 'image/jpeg', w: 4032, h: 3024, quality: 0.82 });
  ok('S3 が使えないとき画像は圧縮経路へ落ちる', !r.err && !!r.body, r.err);
  if (r.body) {
    const sent = JSON.parse(r.body);
    ok('落ちた先では本体を inline で送る', !!sent.image && !sent.imageKey, '');
    ok('落ちた先でも 4.5 MB 未満', r.body.length < VERCEL_LIMIT, `${r.body.length}`);
  }
}

await browser.close();

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
