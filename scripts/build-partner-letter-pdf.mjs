/**
 * 検査会社宛の「ご確認のお願い」1 通を送付用 PDF に組む。
 *
 *   node scripts/build-partner-letter-pdf.mjs prevent
 *   node scripts/build-partner-letter-pdf.mjs laif --date 2026-10-14
 *
 * 入力: docs/lab/partner_demo_confirmation_request_<slug>.md の **「## 件名」と「## 本文」だけ**
 * 出力: scratchpad/pdf/partner_demo_confirmation_request_<slug>_<YYYYMMDD>.pdf
 *
 * 【社内メモを送らないために 件名/本文 だけを抜く】md には「送信前チェックリスト」や
 *   社内向けの注意（整理番号を使わない等）が入っている。**全体を PDF にしてはいけない。**
 *   見出しの構造が変わったら、黙って空の PDF を出さずに例外で止める。
 *
 * 【出力をコミットしない】差出人名・連絡先を入れた送付版が履歴に残らないようにするため、
 *   出力先は `scratchpad/`（.gitignore 済み）。
 *
 * 【個人名を入れない】宛名・差出人とも法人名＋「ご担当者様」で統一（発注者指示 2026-08-25）。
 *   このスクリプトは md をそのまま組版するだけなので、名前の有無は md 側が正。
 *
 * 体裁は LAiF 宛 1 通目（`docs/旧版・ボツ/partner_demo_confirm_request_laif.pdf`・2026-08-25）と
 * 同じ CSS。前身の `scripts/build-partner-request-pdf.mjs` は**社別 2 本に分かれる前の
 * 1 枚の md** を組むものなので失効している（経緯として残置）。
 */
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SLUGS = ['laif', 'prevent'];

const slug = (process.argv[2] || '').trim();
if (!SLUGS.includes(slug)) {
  console.error(`使い方: node scripts/build-partner-letter-pdf.mjs <${SLUGS.join('|')}> [--date YYYY-MM-DD]`);
  process.exit(2);
}
const argDate = (() => {
  const i = process.argv.indexOf('--date');
  return i >= 0 ? (process.argv[i + 1] || '') : '';
})();

/** 差出日は日本時間で書く（実行環境が UTC のコンテナでも 1 日ずれない）。 */
function todayJa(iso) {
  const d = iso ? new Date(`${iso}T00:00:00+09:00`) : new Date();
  if (Number.isNaN(d.getTime())) throw new Error(`--date が不正: ${iso}`);
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(d);
  const g = (t) => parts.find((x) => x.type === t).value;
  return { ja: `${g('year')}年${g('month')}月${g('day')}日`, stamp: `${g('year')}${String(g('month')).padStart(2, '0')}${String(g('day')).padStart(2, '0')}` };
}

/**
 * 和文の `**強調**` を先に <strong> へ変換する。
 * CommonMark の right-flanking 規則では、閉じ `**` の直前が約物のとき閉じ記号にならないため、
 * 「**…（ダミー記入版）**を」のような和文では `**` がそのまま PDF に出る（実測 2026-08-25）。
 * 相手に送る文書なので機械的に潰す。1 行内で閉じている非入れ子のものだけを対象にする。
 */
const boldJa = (text) => text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

const SOURCE = resolve(ROOT, `docs/lab/partner_demo_confirmation_request_${slug}.md`);
const md = readFileSync(SOURCE, 'utf8');

/** 「## 件名」と「## 本文」だけを切り出す。構造が変わっていたら例外で止める。 */
function extract() {
  const m = md.match(/\n## 件名\s*\n([\s\S]*?)\n## 本文\s*\n([\s\S]*)$/);
  if (!m) throw new Error(`「## 件名」「## 本文」を取り出せない: ${SOURCE}`);
  const subject = m[1].trim();
  // 本文は、次の水平線（md のセクション区切り）までが文面。以降は社内用。
  const bodyRaw = m[2].split(/\n-{3,}\s*\n/)[0].trim();
  if (!bodyRaw) throw new Error('本文が空');
  // 日本語の書式に合わせ、先頭の宛名ブロック（最初の空行まで）を分けて置く
  const sep = bodyRaw.indexOf('\n\n');
  if (sep < 0) throw new Error('宛名ブロックを分離できない');
  return { subject, addressee: bodyRaw.slice(0, sep).trim(), body: bodyRaw.slice(sep).trim() };
}

const CSS = `
  @page { size: A4; margin: 22mm 20mm 24mm 20mm; }
  html { font-size: 10.5pt; }
  body {
    margin: 0;
    color: #111827;
    background: #fff;
    /* 和文はコンテナに入っている IPAGothic を明示。実機(Mac/Win)では前の 2 つが当たる */
    font-family: "Hiragino Sans","Yu Gothic","Noto Sans JP","IPAGothic",sans-serif;
    line-height: 1.85;
  }
  .date { text-align: right; color: #374151; margin: 0 0 18px; }
  .addressee { font-size: 12pt; font-weight: 600; line-height: 1.7; margin: 0 0 22px; white-space: pre-line; }
  .subject {
    text-align: center;
    font-size: 13pt;
    font-weight: 700;
    margin: 0 0 24px;
    padding: 10px 12px;
    border-top: 2px solid #0f766e;
    border-bottom: 2px solid #0f766e;
  }
  p { margin: 0 0 10px; orphans: 2; widows: 2; }
  ol, ul { margin: 4px 0 12px 22px; padding: 0; }
  li { margin: 0 0 4px; }
  strong { font-weight: 700; }
  a { color: #0f766e; word-break: break-all; }
  code {
    font-family: "SF Mono","Consolas","Menlo",monospace;
    background: #f3f4f6; padding: 1px 4px; border-radius: 3px; font-size: 0.92em;
  }
`;

marked.setOptions({ gfm: true, breaks: true }); // 手紙なので改行はそのまま活かす

const letter = extract();
const { ja: dateJa, stamp } = todayJa(argDate);
const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${letter.subject}</title>
<style>${CSS}</style></head>
<body>
<p class="date">${dateJa}</p>
<div class="addressee">${letter.addressee}</div>
<div class="subject">${letter.subject}</div>
${marked.parse(boldJa(letter.body))}
</body></html>`;

const outDir = resolve(ROOT, 'scratchpad/pdf');
mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, `partner_demo_confirmation_request_${slug}_${stamp}.pdf`);

// Playwright 同梱の Chromium が無い環境向けの逃げ道。
const executablePath = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({
    path: out,
    format: 'A4',
    printBackground: true,
    margin: { top: '22mm', bottom: '24mm', left: '20mm', right: '20mm' },
  });
  await page.close();
  console.log(`✓ ${out} (${(statSync(out).size / 1024).toFixed(1)} KB)`);
} finally {
  await browser.close();
}
