#!/usr/bin/env node
/**
 * 報告書の紙面に出る**当社の文言**を全部数え、許可リストに無ければ落とす。
 *
 * 【なぜ要るか・2026-09-18 の実障害】
 *   CLAUDE.md には「紙面に出る全文が受領 JSON の部分文字列であることを機械で確認する」と
 *   書いてあったが、`verify:sheet-contract` が見ていたのは **本文の文だけ**で、
 *   **列見出し・カードのラベル・プレースホルダを 1 つも見ていなかった**。
 *   そのため、受領 JSON に無い「基準値」「判定」という列と空欄の「—」、
 *   受領 JSON に 0 件の「今回の所見」というカード見出しが、**検査が緑のまま**紙面に出ていた。
 *   = 診断報告書に当社が文言を足していた (捏造)。
 *
 * 【この検査の考え方】
 *   紙面を作るファイル (`report.astro` の template / `report-sections.ts`) から
 *   **日本語を含む文字列リテラルを機械で全部抜き出し**、
 *     ① 受領 JSON (fixture) の部分文字列である  … 逐語なので OK
 *     ② `ALLOW` に理由つきで載っている            … 器・操作の文言として明示的に許した
 *   のどちらでもなければ落とす。**新しく足した文言は、理由を書くまで通らない。**
 *
 * 【`ALLOW` に載せてよいもの】
 *   画面の操作・ナビゲーションの語だけ (「全編」「詳しい説明を読む」等)。
 *   **診断の中身を名乗る語を載せてはいけない** — 「判定」「所見」「基準値」「要注意」等。
 *   迷ったら載せない (載せない = 紙面に出せない)。
 */
import { readFileSync } from 'node:fs';

const JP = /[ぁ-んァ-ヶ一-龥]/;

/* ── 受領 JSON (fixture) = 逐語の照合先 ───────────────────────────── */
const CORPUS = [
  'src/data/elith/report_text_20260826.json',
  'src/data/elith/health_checkup_20260826.json',
  'src/data/elith/type1_20260824/report_text.json',
  'src/data/elith/type1_20260824/health_checkup.json',
  'src/data/elith/type1_20260824/blood_test.json',
  'src/data/elith/type1_20260824/cancer_risk.json',
].map((f) => readFileSync(f, 'utf8')).join('\n');

/**
 * 紙面に出てよい当社の文言。**理由を必ず書く。**
 * 診断の中身を名乗る語 (判定 / 所見 / 基準値 / 要注意 …) をここに足さないこと。
 */
const ALLOW = new Map([
  ['項目名', '表の列見出し。受領ファイルのキー (`項目名 [単位]`) の呼び名そのもの'],
  ['値', '表の列見出し。受領ファイルのフィールド名 `value` の呼び名そのもの'],
  ['実年齢', '表紙の数直線のラベル。当社が算出して持っている値の名前'],
  ['全編', '畳んである本文を開くための操作の語'],
  ['詳しい説明を読む', 'ダイジェストから全編へ送る導線の操作の語'],
  ['がんリスク検査の結果を見る →', '別画面への導線の操作の語'],
  ['手元に残す', '保存手順の見出し (操作)'],
  ['PDF にして保存する', '保存ボタンの操作の語'],
  ['印刷用の紙面をひらく', '保存ボタンの操作の語'],
  ['別の端末', '保存手順の切替 (操作)'],
  ['サンプル表示（受取仕様の確定前）', 'デモ用アカウントにだけ出る表示。実データではないことの明示'],
  ['AI 診断による疾病予防アドバイス', '報告書そのものの名前 (章扉の帯)'],

  /*
   * ── 表紙の台帳 (当社のデータに付ける名前) ────────────────────────
   * どれも **Elith の出力ではなく当社が持っている事実**の名前で、
   * 診断の中身を名乗るものではない。**値そのものは当社のデータ**
   * (作成日 = 受領日 / 版 / 検査日 / 第 N 回)。
   */
  ['作成日', '表紙の台帳。受領日 (当社が記録している事実) の名前'],
  ['紙面', '表紙の台帳。紙面の版 (控えが古いかを読む人が判別するため・spec §4.4)'],
  ['検査', '表紙の台帳。検査日 (当社が記録している事実) の名前'],
  ['第 回 / 全 回', '表紙の台帳。検査サイクルの回数 (当社が持つ事実)'],
  ['端末や OS の版によって、メニューの名前が変わることがあります。 保存した紙面は、この画面を開かなくても読めます。',
    '保存手順の注記。報告書の中身ではなく端末操作の説明'],
]);

/** template だけを取り出し、コメントを落とす。 */
function templateOf(path) {
  const src = readFileSync(path, 'utf8');
  const m = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(src);
  const tpl = m ? m[1] : src;
  return tpl
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '');
}

/**
 * 紙面に出る「値ではない文字」= プレースホルダ。
 *
 * 【2026-09-18 の実障害そのもの】空欄に `—` を置いて
 * **"欄はあるが該当なし" のように見せていた**。日本語を含まないので、
 * 日本語リテラルだけを見る検査では**素通りする** (退行注入で実証済み)。
 */
const PLACEHOLDERS = ['—', '–', '―', '‐', 'N/A', 'なし', '未設定', '-'];

/**
 * ソースから「紙面に出る文字」を抜く。
 *
 * **式 `{...}` を先に落としてから見る。** 落とさないと
 * `<span>{r.variants} 通り</span>` のような**式と地の文が混ざったセル**を
 * 取りこぼす (退行注入で実証済み: 「N 通り」バッジを戻しても通ってしまった)。
 */
function literalsOf(text) {
  const out = new Set();
  const consider = (raw) => {
    const t = raw.trim();
    if (!t) return;
    if (JP.test(t) || PLACEHOLDERS.includes(t)) out.add(t);
  };
  // テキストノード: 中の式を落としてから地の文だけを見る
  for (const m of text.matchAll(/>([^<>]*?)</g)) {
    consider(m[1].replace(/\{[^{}]*\}/g, ' ').replace(/\s+/g, ' '));
  }
  // 文字列リテラル
  for (const m of text.matchAll(/['"]([^'"\n]*?)['"]/g)) consider(m[1]);
  return out;
}

const found = new Map();
for (const [path, text] of [
  ['src/pages/report.astro', templateOf('src/pages/report.astro')],
  ['src/lib/report-sections.ts', readFileSync('src/lib/report-sections.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '')],
]) for (const lit of literalsOf(text)) if (!found.has(lit)) found.set(lit, path);

/*
 * 【短い語に部分文字列一致を使わない・2026-09-18 に実証】
 *
 * 最初この検査は「受領 JSON の部分文字列なら OK」だけで書いた。
 * ところが**退行注入 (「基準値」「判定」の列を戻す) が通ってしまった** —
 * どちらも Elith の散文の中に語として出てくるので、部分文字列としては当たる。
 *
 * **語が本文のどこかに在ることと、その語を当社が見出しに使ってよいことは別。**
 * → **`MIN_VERBATIM` 文字未満の短いリテラルは部分文字列一致を認めない**。
 *   短い文字列は何にでも当たるので、照合として意味を持たない。
 *   短い語を紙面に出したければ `ALLOW` に理由を書く (= 人が判断したことを残す)。
 */
const MIN_VERBATIM = 12;

const bad = [];
const okVerbatim = [];
const okAllowed = [];
/**
 * Elith 自身が本文に付けた見出しマーカー (`【現状評価】` `【行動提案】` `### 4. …`) は、
 * **短くても Elith の語**なので逐語として認める。
 * 「本文のどこかに語が在る」ではなく「**Elith が見出しとして書いている**」ことを見る。
 */
const isElithMarker = (lit) => CORPUS.includes(`【${lit}】`) || CORPUS.includes(`### ${lit}`);

const placeholders = [];
for (const [lit, path] of found) {
  if (PLACEHOLDERS.includes(lit)) { placeholders.push(`${path}: ${JSON.stringify(lit)}`); continue; }
  if (ALLOW.has(lit)) okAllowed.push(lit);
  else if (isElithMarker(lit)) okVerbatim.push(`${lit} (Elith の見出しマーカー)`);
  else if (lit.length >= MIN_VERBATIM && CORPUS.includes(lit)) okVerbatim.push(lit);
  else bad.push(`${path}: ${JSON.stringify(lit)}`
    + (CORPUS.includes(lit) ? `  (本文に語としては在るが ${MIN_VERBATIM} 字未満なので逐語とみなさない)` : ''));
}

/*
 * ── 禁じた語は CORPUS を問わず落とす ──────────────────────────────
 * **`CORPUS.includes` で例外にしない。** これを条件にすると、上と同じ理由で
 * 「基準値」「判定」が素通りする (Elith の散文に語として在るため)。
 * これらは**診断の中身を名乗る語**なので、紙面のラベルとして出してはならない。
 */
const BANNED = ['判定', '所見', '基準値', '要注意', 'すぐ受診', '通り'];
const bannedHit = BANNED.filter((w) => [...found.keys()].some((l) => l.includes(w) && !ALLOW.has(l)));

console.log(`受領 JSON の逐語 : ${okVerbatim.length} 件`);
console.log(`許可リスト       : ${okAllowed.length} 件`);
for (const l of okAllowed) console.log(`  - ${l}  … ${ALLOW.get(l)}`);

let failed = 0;
if (bad.length) {
  failed += bad.length;
  console.log(`\n✗ 受領 JSON にも許可リストにも無い文言が ${bad.length} 件あります:`);
  for (const b of bad) console.log(`  ✗ ${b}`);
  console.log('\n  → 診断報告書に当社の文言を足すことになります。');
  console.log('    器・操作の語なら ALLOW に理由つきで足す。');
  console.log('    診断の中身を名乗る語 (判定 / 所見 / 基準値 …) は足さずに撤去すること。');
}
if (bannedHit.length) {
  failed += bannedHit.length;
  console.log(`\n✗ 禁じた語が紙面に出ています: ${bannedHit.join(' / ')}`);
}
if (placeholders.length) {
  failed += placeholders.length;
  console.log(`\n✗ 空欄のプレースホルダが ${placeholders.length} 件あります:`);
  for (const q of placeholders) console.log(`  ✗ ${q}`);
  console.log('  → 受領 JSON に無い欄を "欄はあるが該当なし" のように見せることになります。');
  console.log('    欄ごと作らないこと (ALLOW では許可できません)。');
}
if (!failed) console.log('\n✓ 紙面の文言はすべて受領 JSON の逐語か、理由つきで許可したものです');
process.exit(failed ? 1 : 0);
