/**
 * 検査値を読むクエリが **active な artifact に絞っているか** を機械で見る。サーバも鍵も要らない。
 *
 * 【なぜ要るか — 2026-09-27 に判明】
 *   `diagnosis.measurement_values` は artifact を FK で参照するだけで **status を持たない**。
 *   status (active / superseded / withdrawn) は `test_artifacts` 側にしか無い。
 *   `measurement-queries.ts` の 3 クエリは `diagnostic_user_id` だけで引いていたので、
 *   **差し替えたはずの古い回・取り下げた回の値が「読み取り結果」と推移グラフに混ざる**
 *   状態だった。同じ受診日の壊れた回と直した回が両方残ったとき、どちらが出るかは
 *   並び順まかせ = **画面にはエラーも出ないまま間違った値が出る**。
 *
 * 【何を見るか】
 *   `.from('measurement_values')` のチェーンのうち **`.select(` を含むもの** は、
 *   同じチェーン内に `.in('artifact_id', …)` を持たなければならない。
 *   持たないものは ALLOW に**理由つきで**登録する (黙って素通りさせない)。
 *
 * 【見ないもの】insert / delete のチェーン (取込側。artifact_id 直指定で status は無関係)。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SRC = join(ROOT, 'src');

/**
 * 絞り込まなくてよいチェーン。**理由を必ず書く**。
 * key = `<src からの相対パス>` に含まれる文字列 + '::' + チェーンの特徴文字列。
 */
const ALLOW = [
  {
    file: 'pages/api/debug/viewer.ts',
    must: "count: 'exact'",
    why: '切り分け用の件数カウント。status を含めた総数を見たいので絞らない (画面には出ない)。',
  },
];

let pass = 0;
const fails = [];
function ok(m) { pass++; console.log(`  ✓ ${m}`); }
function fail(m) { fails.push(m); console.log(`  ✗ ${m}`); }

function stripTsComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function chainSlice(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') { depth--; if (depth < 0) return text.slice(start, i); }
    else if (ch === ';' && depth === 0) return text.slice(start, i);
    else if (depth === 0 && text.startsWith('.from(', i) && i > start) return text.slice(start, i);
  }
  return text.slice(start);
}
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|astro)$/.test(n)) out.push(p);
  }
  return out;
}

console.log('① measurement_values を select しているチェーン');
let found = 0;
for (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  const text = stripTsComments(readFileSync(file, 'utf8'));
  const re = /\.from\(\s*['"`]measurement_values['"`]\s*\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const chain = chainSlice(text, m.index);
    if (!/\.select\(/.test(chain)) continue; // 取込側 (insert/delete) は対象外
    found++;
    const allow = ALLOW.find((a) => rel.endsWith(a.file) && chain.includes(a.must));
    if (/\.in\(\s*['"`]artifact_id['"`]/.test(chain)) {
      ok(`${rel} — active な artifact に絞っている`);
    } else if (allow) {
      ok(`${rel} — 絞らないことを許可 (${allow.why})`);
    } else {
      fail(`${rel} — measurement_values を status で絞らずに select している。`
        + ' superseded / withdrawn の値が画面に混ざる。'
        + " activeArtifactIds() の結果で .in('artifact_id', …) を掛けるか、理由つきで ALLOW へ登録すること。");
    }
  }
}
if (found === 0) fail('measurement_values の select チェーンを 1 つも見つけられなかった (検出器が壊れている)');

// ② 絞り込みの実体が在ること。ALLOW だけで全部通してしまう事故を防ぐ。
console.log('\n② 絞り込みの実体');
const mq = readFileSync(join(SRC, 'lib', 'measurement-queries.ts'), 'utf8');
if (/async function activeArtifactIds\s*\(/.test(mq)) ok('activeArtifactIds() が在る');
else fail('activeArtifactIds() が無い — 絞り込みの実体が消えている');
if (/\.eq\(\s*'status'\s*,\s*'active'\s*\)/.test(mq)) ok("activeArtifactIds() が status='active' で絞っている");
else fail("status='active' の絞り込みが無い — active 以外の artifact も通る");

const uses = (mq.match(/\.in\('artifact_id', active\)/g) || []).length;
if (uses >= 3) ok(`3 つのクエリ (直近 / 候補 / 推移) すべてに掛かっている (実測 ${uses} 箇所)`);
else fail(`絞り込みが ${uses} 箇所しかない — 直近 / 候補 / 推移 の 3 つすべてに要る`);

/*
 * ③ **`test_artifacts` を「その人の回の一覧」として読むチェーンも status で絞ること。**
 *
 * 【なぜ足したか — 2026-09-30 の実障害】本田さんのダッシュボードで
 * 「人間ドックデータが重複して表示される」報告。原因の 1 つが
 * `result-queries.ts` の **siblings（過去データの一覧）に `status` の絞りが無かった**こと。
 * ダッシュボード側 (`dashboard-queries.ts`) は最初から絞ってあり、**ここだけ漏れていた**。
 * ①と**同型の漏れ**で、同じ受診日が 2 つ並ぶ。**エラーは出ない。**
 *
 * 【何を見るか】`.from('test_artifacts')` の select チェーンのうち、
 * **`.eq('diagnostic_user_id', …)` を持つもの**（= 人単位の一覧・複数行が返り得る）は
 * `.eq('status', …)` を持たなければならない。
 * `id` 直指定の 1 件取得は対象外（どの回かは呼び出し側が決めている）。
 */
const ARTIFACT_ALLOW = [
  {
    file: 'pages/api/debug/viewer.ts',
    must: "count: 'exact'",
    why: '切り分け用の件数カウント。status 別の内訳を見たいので絞らない (画面には出ない)。',
  },
  {
    file: 'lib/scan-persist.ts',
    must: 'q.testDate',
    why: '差し替え前の片付け (replaceSameDateArtifacts)。status に関わらず同日の行を全部拾う必要がある。',
  },
];
console.log('\n③ test_artifacts を人単位で select しているチェーン');
let artFound = 0;
for (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  const text = stripTsComments(readFileSync(file, 'utf8'));
  const re = /\.from\(\s*['"`]test_artifacts['"`]\s*\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const chain = chainSlice(text, m.index);
    if (!/\.select\(/.test(chain)) continue;                       // insert / delete は対象外
    if (!/\.eq\(\s*['"`]diagnostic_user_id['"`]/.test(chain)) continue; // 人単位でないものは対象外
    // **id 直指定の 1 件取得は対象外。** どの回かは呼び出し側が決めており、一覧ではない。
    if (/\.eq\(\s*['"`]id['"`]/.test(chain)) continue;
    artFound++;
    const allow = ARTIFACT_ALLOW.find((a) => rel.endsWith(a.file) && chain.includes(a.must));
    if (/\.eq\(\s*['"`]status['"`]/.test(chain) || /\.in\(\s*['"`]status['"`]/.test(chain)) {
      ok(`${rel} — status で絞っている`);
    } else if (allow) {
      ok(`${rel} — 絞らないことを許可 (${allow.why})`);
    } else {
      fail(`${rel} — test_artifacts を人単位で引くのに status で絞っていない。`
        + ' 差し替え前 (superseded) や取り下げ後 (withdrawn) の回が一覧に並び、'
        + " 利用者には**同じ受診日の重複**に見える。.eq('status', 'active') を足すか、理由つきで ARTIFACT_ALLOW へ登録すること。");
    }
  }
}
if (artFound === 0) fail('test_artifacts の select チェーンを 1 つも見つけられなかった (検出器が壊れている)');

console.log(`\n${fails.length === 0 ? '✅' : '❌'} verify:measurement-status — 合格 ${pass} / 不合格 ${fails.length}`);
if (fails.length) {
  console.log('\n落ちた項目:');
  for (const m of fails) console.log(`  - ${m}`);
  process.exit(1);
}
