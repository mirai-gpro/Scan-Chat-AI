/**
 * 検査会社宛の「ご確認のお願い」1 通を、提案書ハウススタイルの送付用 PDF に組む。
 *
 *   node scripts/build-partner-letter-pdf.mjs prevent
 *   node scripts/build-partner-letter-pdf.mjs prevent --date 2026-10-14
 *
 * 入力: docs/lab/partner_demo_confirmation_request_<slug>.md の
 *         「## 送付情報」（表）と「## 本文」だけ
 * 出力: scratchpad/pdf/partner_demo_confirmation_request_<slug>_<YYYYMMDD>.pdf
 *
 * 【体裁の正本 = 実際に送った PDF】
 *   `プリベント社 デモ画面ご確認のお願い`（2026-08-25 送付・発注者提供）を**実測**して写した:
 *     ヘッダー帯 #0C828C ／ 見出しバー・ソリッドSTEP #0E756E ／ 濃いテキスト #0E4F4B
 *     注意枠 背景 #FFFAEB・枠 #EDD59F ／ バッジ #E4BF6D（文字 #4A3A12）
 *     表ヘッダ・URL枠 #F0FDFA ／ 淡い枠・STEP #F7FAFB
 *   目分量ではなく、PNG に描画して画素の最頻色を取っている。
 *
 * 【社内メモを送らないために 送付情報/本文 だけを抜く】md には「送信前チェックリスト」や
 *   社内向けの注意（整理番号を使わない等）が入っている。**全体を PDF にしてはいけない。**
 *   見出しの構造が変わったら、黙って空の PDF を出さずに例外で止める。
 *
 * 【出力をコミットしない】差出人名・連絡先を入れた送付版が履歴に残らないよう、
 *   出力先は `scratchpad/`（.gitignore 済み）。
 *
 * 【個人名を入れない】宛先・発行とも法人名＋「ご担当者様」（発注者指示 2026-08-25）。
 *   md をそのまま組むだけなので、名前の有無は md 側が正。
 *
 * 【本文で使える独自ブロック】marked だけでは出せない要素を `::` で囲う。
 *   ::notice  … 冒頭の注意枠（1 行目を見出しとして太字で出す）
 *   ::url     … URL を 1 行だけ入れる枠
 *   ::steps   … 操作の流れ。1 行 1 STEP（`見出し | 本文 | 補足`・先頭 `*` で濃い塗り）
 *               `::caption …` を最後に置くと図の下に注記を出す
 *   ::note    … 淡い囲みの補足
 *   それ以外（見出し `### 1. …`・表・段落・箇条書き）は通常の Markdown。
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

/** 差出日は日本時間で作る（実行環境が UTC のコンテナでも 1 日ずれない）。 */
function todayJa(iso) {
  const d = iso ? new Date(`${iso}T00:00:00+09:00`) : new Date();
  if (Number.isNaN(d.getTime())) throw new Error(`--date が不正: ${iso}`);
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const g = (t) => parts.find((x) => x.type === t).value;
  return { ja: `${g('year')}年${Number(g('month'))}月${Number(g('day'))}日`, stamp: `${g('year')}${g('month')}${g('day')}` };
}

/**
 * 和文の `**強調**` を先に <strong> へ変換する。
 * CommonMark の right-flanking 規則では閉じ `**` の直前が約物のとき閉じ記号にならないため、
 * 「**…（ダミー記入版）**を」のような和文では `**` がそのまま PDF に出る（実測 2026-08-25）。
 * 相手に送る文書なので機械的に潰す。1 行内で閉じている非入れ子のものだけを対象にする。
 */
const boldJa = (text) => text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** 行内の `**強調**` と `` `code` `` だけを活かす（独自ブロックの中で使う）。 */
const inline = (s) => esc(s)
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/`([^`]+)`/g, '<code>$1</code>');

const SOURCE = resolve(ROOT, `docs/lab/partner_demo_confirmation_request_${slug}.md`);
const md = readFileSync(SOURCE, 'utf8');

/** 「## 送付情報」の表を {キー: 値} に。 */
function meta() {
  const m = md.match(/\n## 送付情報\s*\n([\s\S]*?)\n## /);
  if (!m) throw new Error(`「## 送付情報」を取り出せない: ${SOURCE}`);
  const out = {};
  for (const line of m[1].split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    // | キー | 値 | の 4 要素（前後の空セル込み）だけを拾う
    if (cells.length < 4 || /^-+$/.test(cells[1]) || cells[1] === 'キー') continue;
    if (cells[1]) out[cells[1]] = cells.slice(2, -1).join(' | ').trim();
  }
  for (const k of ['eyebrow', 'title', 'badge', 'subtitle', 'meta', 'footer']) {
    if (!out[k]) throw new Error(`送付情報に「${k}」が無い`);
  }
  return out;
}

/** 「## 本文」から、次の水平線までを取り出す（以降は社内用）。 */
function body() {
  const m = md.match(/\n## 本文\s*\n([\s\S]*)$/);
  if (!m) throw new Error(`「## 本文」を取り出せない: ${SOURCE}`);
  const text = m[1].split(/\n-{3,}\s*\n/)[0].trim();
  if (!text) throw new Error('本文が空');
  return text;
}

/** `::名前 … ::` の独自ブロックを HTML へ。中身は行単位で素直に扱う。 */
function renderBlocks(src) {
  const out = [];
  const lines = src.split('\n');
  let buf = [];
  const flush = () => {
    const chunk = buf.join('\n').trim();
    buf = [];
    if (chunk) out.push(marked.parse(boldJa(chunk)));
  };
  for (let i = 0; i < lines.length; i++) {
    const open = /^::(notice|url|steps|note)\s*$/.exec(lines[i]);
    if (!open) { buf.push(lines[i]); continue; }
    flush();
    const kind = open[1];
    const inner = [];
    i++;
    while (i < lines.length && lines[i].trim() !== '::') { inner.push(lines[i]); i++; }
    if (i >= lines.length) throw new Error(`::${kind} が閉じていない`);
    out.push(blockHtml(kind, inner));
  }
  flush();
  return out.join('\n');
}

function blockHtml(kind, lines) {
  const body = lines.filter((l) => l.trim() !== '');
  if (kind === 'url') {
    if (body.length !== 1) throw new Error('::url は 1 行だけ');
    return `<div class="urlbox">${inline(body[0].trim())}</div>`;
  }
  if (kind === 'notice') {
    const [head, ...rest] = body;
    return `<div class="notice"><p class="notice-h">${inline(head.trim())}</p>`
      + rest.map((l) => `<p>${inline(l.trim())}</p>`).join('') + '</div>';
  }
  if (kind === 'note') {
    return `<div class="note">${body.map((l) => `<p>${inline(l.trim())}</p>`).join('')}</div>`;
  }
  // steps
  const caption = body.find((l) => l.trim().startsWith('::caption'));
  const steps = body.filter((l) => !l.trim().startsWith('::caption')).map((l) => {
    const raw = l.trim();
    const solid = raw.startsWith('*');
    const cells = (solid ? raw.slice(1) : raw).split('|').map((c) => c.trim());
    if (cells.length < 2) throw new Error(`::steps の行は「見出し | 本文」が要る: ${raw}`);
    return { solid, head: cells[0], main: cells[1], sub: cells[2] || '' };
  });
  if (!steps.length) throw new Error('::steps が空');
  const cells = steps.map((s, i) =>
    (i ? '<div class="arrow">▶</div>' : '')
    + `<div class="step${s.solid ? ' solid' : ''}">`
    + `<div class="step-h">${inline(s.head)}</div>`
    + `<div class="step-m">${inline(s.main)}</div>`
    + (s.sub ? `<div class="step-s">${inline(s.sub)}</div>` : '')
    + '</div>').join('');
  return `<div class="flow"><div class="steps">${cells}</div>`
    + (caption ? `<p class="flow-cap">${inline(caption.replace('::caption', '').trim())}</p>` : '')
    + '</div>';
}

// 実測した色（上のコメント参照）
const CSS = `
  @page { size: A4; margin: 14mm 13mm 14mm 13mm; }
  html { font-size: 9.6pt; }
  body {
    margin: 0; color: #1f2937; background: #fff;
    /* 和文はコンテナに入っている IPAGothic を明示。実機(Mac/Win)では前の 2 つが当たる */
    font-family: "Hiragino Sans","Yu Gothic","Noto Sans JP","IPAGothic",sans-serif;
    line-height: 1.75;
  }
  /* ── ヘッダー帯 ───────────────────────────── */
  .hero { background: #0C828C; color: #fff; border-radius: 10px; padding: 18px 22px 16px; margin: 0 0 16px; }
  .hero .eyebrow { font-size: 8.4pt; letter-spacing: .22em; color: #CFE9EA; margin: 0 0 6px; }
  .hero h1 { font-size: 17pt; font-weight: 700; margin: 0 0 8px; line-height: 1.45; }
  .hero .badge {
    display: inline-block; vertical-align: 4px; margin-left: 10px;
    background: #E4BF6D; color: #4A3A12; font-size: 8.6pt; font-weight: 700;
    border-radius: 999px; padding: 3px 12px; letter-spacing: .04em;
  }
  .hero .sub { font-size: 10pt; color: #DCEFF0; margin: 0 0 8px; }
  .hero .meta { font-size: 8.6pt; color: #AED6D8; margin: 0; }
  /* ── 注意枠 ─────────────────────────────── */
  .notice { background: #FFFAEB; border: 1px solid #EDD59F; border-radius: 8px; padding: 12px 16px; margin: 0 0 16px; }
  .notice p { margin: 0 0 6px; }
  .notice p:last-child { margin-bottom: 0; }
  .notice-h { font-weight: 700; color: #7A5A12; }
  /* ── 見出し ─────────────────────────────── */
  h2 { font-size: 11.6pt; font-weight: 700; color: #0E4F4B; margin: 18px 0 9px; padding-left: 10px;
       border-left: 4px solid #0E756E; line-height: 1.5; break-after: avoid; }
  h3 { font-size: 10.4pt; font-weight: 700; color: #0E4F4B; margin: 12px 0 6px; break-after: avoid; }
  p { margin: 0 0 8px; orphans: 2; widows: 2; }
  ol, ul { margin: 4px 0 10px 20px; padding: 0; }
  li { margin: 0 0 3px; }
  strong { font-weight: 700; }
  a { color: #0E756E; text-decoration: none; word-break: break-all; }
  code { font-family: "SF Mono","Consolas","Menlo",monospace; background: #F0FDFA;
         padding: 1px 4px; border-radius: 3px; font-size: 0.93em; }
  /* ── URL 枠 ─────────────────────────────── */
  .urlbox {
    background: #F0FDFA; border: 1px solid #CDE9E5; border-radius: 8px;
    padding: 14px 12px; margin: 0 0 12px; text-align: center;
    font-family: "SF Mono","Consolas","Menlo",monospace; font-size: 10.6pt;
    font-weight: 700; color: #0E4F4B; word-break: break-all; break-inside: avoid;
  }
  .urlbox code { background: none; padding: 0; font-size: 1em; }
  /* ── 操作の流れ ──────────────────────────── */
  .flow { border: 1px solid #E3EAEA; border-radius: 8px; padding: 14px 14px 10px; margin: 0 0 12px; break-inside: avoid; }
  .steps { display: flex; align-items: stretch; gap: 6px; }
  .step { flex: 1; background: #F7FAFB; border: 1px solid #E3EAEA; border-radius: 6px;
          padding: 9px 6px; text-align: center; color: #0E4F4B; }
  .step.solid { background: #0E756E; border-color: #0E756E; color: #fff; }
  .step-h { font-size: 8.4pt; letter-spacing: .06em; margin-bottom: 3px; opacity: .92; }
  .step-m { font-size: 10pt; font-weight: 700; line-height: 1.4; }
  .step-s { font-size: 8.6pt; margin-top: 2px; opacity: .92; }
  .arrow { align-self: center; color: #0E756E; font-size: 9pt; }
  .flow-cap { text-align: center; font-size: 8.8pt; color: #4b5563; margin: 9px 0 0; }
  /* ── 淡い囲み ───────────────────────────── */
  .note { background: #F7FAFB; border: 1px solid #E3EAEA; border-radius: 8px;
          padding: 10px 14px; margin: 0 0 14px; break-inside: avoid; }
  .note p { margin: 0 0 5px; }
  .note p:last-child { margin-bottom: 0; }
  /* ── 表 ────────────────────────────────── */
  table { width: 100%; border-collapse: collapse; margin: 0 0 14px; font-size: 9.4pt; }
  thead th { background: #F0FDFA; color: #0E4F4B; font-weight: 700; text-align: left;
             border-top: 1px solid #DCEAE8; border-bottom: 1px solid #DCEAE8; padding: 7px 10px; }
  tbody td { border-bottom: 1px solid #EDF1F1; padding: 7px 10px; vertical-align: top; }
  tbody tr td:first-child { color: #0E756E; font-weight: 700; white-space: nowrap; }
  tr { break-inside: avoid; }
  /* ── フッター ───────────────────────────── */
  .foot { border-top: 1px solid #E3EAEA; margin-top: 18px; padding-top: 8px;
          font-size: 8.4pt; color: #6b7280; line-height: 1.7; }
`;

marked.setOptions({ gfm: true, breaks: false });

const M = meta();
// 差出日は紙面に別途は刷らない（v1.0 の紙面に合わせ、版と年月は送付情報の meta / footer が持つ）。
// ここで使うのは出力ファイル名の日付だけ。
const { stamp } = todayJa(argDate);
const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${esc(M.title)}</title>
<style>${CSS}</style></head>
<body>
<div class="hero">
  <p class="eyebrow">${esc(M.eyebrow)}</p>
  <h1>${esc(M.title)}<span class="badge">${esc(M.badge)}</span></h1>
  <p class="sub">${esc(M.subtitle)}</p>
  <p class="meta">${esc(M.meta)}</p>
</div>
${renderBlocks(body())}
<p class="foot">${inline(M.footer)}</p>
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
    margin: { top: '14mm', bottom: '14mm', left: '13mm', right: '13mm' },
  });
  await page.close();
  console.log(`✓ ${out} (${(statSync(out).size / 1024).toFixed(1)} KB)`);
} finally {
  await browser.close();
}
