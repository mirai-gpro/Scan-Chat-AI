#!/usr/bin/env node
/**
 * 受領 JSON → **AI疾病予防報告書の紙面のまま PDF**。
 *
 * 【新しく組まない】紙面は `/report?print=1` のレンダラが正
 * (デザイン見本のトレース・改ページ・余白・ページ番号・走りフッターまで入っている)。
 * ここは**そのページを印刷するだけ**。別に組むと紙面が 2 系統になる。
 *
 * 【Vercel には足さない】「取込時にサーバで PDF を生成して S3 へ」は
 * **決裁台帳 S-3 が未裁定**なので、ローカル実行に留める (Chromium を本番に載せない)。
 *
 * ■ 使い方 (要 `npm run dev`)
 *   REPORT_RENDER_DIR=/path/to/input node scripts/render-report-pdf.mjs --out ./pdf
 *
 *   入力は  <REPORT_RENDER_DIR>/<id>/report_text.json
 *           <REPORT_RENDER_DIR>/<id>/health_checkup.json   (任意)
 *           <REPORT_RENDER_DIR>/<id>/meta.json             (任意・氏名/実年齢/作成日/第N回)
 *
 * ■ PII
 *   入力ディレクトリは**リポジトリの外**にすること。既定値は持たない。
 *   出力 PDF も repo に置かない。
 */
import { readdirSync, existsSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:4321';
const DIR = process.env.REPORT_RENDER_DIR;
if (!DIR) { console.error('REPORT_RENDER_DIR が要ります (リポジトリの外を指すこと)。'); process.exit(2); }

const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const OUT = resolve(outArg >= 0 ? args[outArg + 1] : './pdf');
const only = args.indexOf('--only') >= 0 ? args[args.indexOf('--only') + 1] : null;

/** **repo の中へ書かない・repo の中から読まない** (実在の方の情報を残さないため)。 */
const REPO = resolve('.');
for (const [label, p] of [['入力', resolve(DIR)], ['出力', OUT]]) {
  if (p === REPO || p.startsWith(REPO + '/')) {
    console.error(`${label}がリポジトリの中を指しています: ${p}`);
    console.error('個人情報を含むので repo の外にしてください。');
    process.exit(2);
  }
}
mkdirSync(OUT, { recursive: true });

const ids = (only ? [only] : readdirSync(DIR))
  .filter((d) => { try { return statSync(join(DIR, d)).isDirectory(); } catch { return false; } })
  .filter((d) => existsSync(join(DIR, d, 'report_text.json')))
  .sort();

if (!ids.length) { console.error(`${DIR} に report_text.json を持つフォルダがありません。`); process.exit(1); }
console.log(`${ids.length} 件を PDF にします → ${OUT}\n`);

// verify-screen.mjs と同じ流儀: 環境の Chromium を先に試し、無ければ Playwright 同梱へ。
const EXEC = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
let browser;
try { browser = await chromium.launch({ executablePath: EXEC }); }
catch { browser = await chromium.launch(); }

const rows = [];
for (const id of ids) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
  const url = `${BASE}/report?render=${encodeURIComponent(id)}&print=1`;
  await page.goto(url, { waitUntil: 'networkidle' });

  /*
   * **中身が入ったかを描画側で確かめる。** 材料を渡せていないと
   * 「帯だけの紙面」が静かに出る (emptyVM)。PDF を作る前に落とす。
   */
  const seen = await page.evaluate(() => ({
    // **印刷ビューには `data-card` が出ない** (紙面契約は画面側の印)。
    // 見出しの数と本文の量で「中身が入ったか」を見る。
    cards: document.querySelectorAll('.rp-card').length,
    h3: document.querySelectorAll('.rp-h3').length,
    text: [...document.querySelectorAll('.rp-sheet')]
      .map((e) => e.textContent ?? '').join('').replace(/\s+/g, '').length,
  }));

  const file = join(OUT, `${id}.pdf`);
  // **背景のグラフィックを必ず出す** — 無いと帯・バッジ・表の teal ヘッダが白く抜ける。
  await page.pdf({ path: file, printBackground: true, preferCSSPageSize: true });
  await page.close();

  let pages = null;
  try { pages = +execSync(`pdfinfo "${file}" 2>/dev/null | awk '/^Pages/{print $2}'`).toString().trim() || null; } catch { /* poppler 無しでも続ける */ }
  rows.push({ id, ...seen, pages, bytes: statSync(file).size });
  console.log(`  ✓ ${id}  カード${String(seen.cards).padStart(3)} / 見出し${String(seen.h3).padStart(3)} / ${String(seen.text).padStart(6)}字 / ${pages ?? '?'}ページ`);
}
await browser.close();

const thin = rows.filter((r) => r.text < 2000 || r.cards === 0);
if (thin.length) {
  console.log(`\n✗ 中身が薄い紙面が ${thin.length} 件: ${thin.map((r) => r.id).join(', ')}`);
  console.log('  材料を渡せていない可能性があります (report_text.json の形を確認)。');
  process.exit(1);
}
console.log(`\n✓ ${rows.length} 件を出力しました。`);
