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

console.log(`\n${fails.length === 0 ? '✅' : '❌'} verify:measurement-status — 合格 ${pass} / 不合格 ${fails.length}`);
if (fails.length) {
  console.log('\n落ちた項目:');
  for (const m of fails) console.log(`  - ${m}`);
  process.exit(1);
}
