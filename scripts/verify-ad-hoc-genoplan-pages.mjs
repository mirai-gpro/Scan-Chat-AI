#!/usr/bin/env node
// scripts/verify-ad-hoc-genoplan-pages.mjs
// 臨時診断バッチ: Genoplan の対象ページ制約 (p10〜35) の回帰チェック。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §8.2 / §8.4 / §8.5 / §8.6 / §14
//
// **サーバも DB も S3 も Gemini も要らない。**
//
// ここで固定するのは 4 つ。どれも**静かに壊れる**ので目視では守れない。
//   ① 正本が 1 つであること           … 数値が両リポジトリへコピーされていない
//   ② 受付が範囲外を弾くこと           … p9 / p36 が LLM へ到達しない
//   ③ 完了判定が必要集合で行われること … 行が無いページを完了に数えない
//   ④ UI が全ページ走査へ戻っていないこと
//
//   node scripts/verify-ad-hoc-genoplan-pages.mjs
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

let pass = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name, actual, expected) =>
  ok(name, Object.is(actual, expected), `期待 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);
const deepEq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `期待 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(repoRoot, '.verify-genoplan-'));
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

/**
 * `elith-genetic.ts` から**ページ方針の部分だけ**を切り出して読み込む。
 *
 * 丸ごと transpile すると `./gemini` / `./elith-export` を辿って API キーを要求するので、
 * import 行を落としてから読む。**方針は純粋関数なので依存を持たない**という前提自体を、
 * ここで暗に固定していることになる (依存が増えたらこの検査が落ちる)。
 */
const geneticSrc = read('src/lib/elith-genetic.ts');
const policySrc = geneticSrc
  .split('\n')
  .filter((l) => !/^import\s/.test(l))
  .join('\n');
const policyJs = ts.transpileModule(policySrc, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const policyPath = join(tmp, 'genetic-policy.js');
writeFileSync(policyPath, policyJs);
const policy = await import(pathToFileURL(policyPath).href);

// ===========================================================================
// ① 正本 (§8.2 / §8.5)
// ===========================================================================
deepEq('範囲は p10〜35', policy.GENOPLAN_V1_PAGE_RANGE, { from: 10, to: 35 });
eq('対象は 26 ページ', policy.GENOPLAN_V1_REQUIRED_PAGES.length, 26);
eq('先頭は 10', policy.GENOPLAN_V1_REQUIRED_PAGES[0], 10);
eq('末尾は 35', policy.GENOPLAN_V1_REQUIRED_PAGES[25], 35);
ok('昇順で連番', policy.GENOPLAN_V1_REQUIRED_PAGES.every((p, i) => p === 10 + i));
ok('凍結されている (呼び出し側が壊せない)', Object.isFrozen(policy.GENOPLAN_V1_REQUIRED_PAGES));

// ゴールデンが同じ範囲を見ていること (§12.3)。ここがずれると照合が無意味になる。
const golden = read('docs/scan/golden/scan_golden_genetic_geneplanet_20240131.md');
ok('ゴールデンが p10〜35 を対象と宣言している', /ページ\s*10\s*〜\s*35|10-35/.test(golden));

// ===========================================================================
// ② 境界 (§8.5) — p9 / p36 は false、p10 / p35 は true
// ===========================================================================
eq('p9 は対象外', policy.isGenoplanV1RequiredPage(9), false);
eq('p10 は対象', policy.isGenoplanV1RequiredPage(10), true);
eq('p35 は対象', policy.isGenoplanV1RequiredPage(35), true);
eq('p36 は対象外', policy.isGenoplanV1RequiredPage(36), false);
eq('p1 は対象外', policy.isGenoplanV1RequiredPage(1), false);
eq('p208 は対象外', policy.isGenoplanV1RequiredPage(208), false);
eq('p210 は対象外', policy.isGenoplanV1RequiredPage(210), false);
eq('0 は対象外', policy.isGenoplanV1RequiredPage(0), false);
eq('負数は対象外', policy.isGenoplanV1RequiredPage(-10), false);
eq('小数は対象外', policy.isGenoplanV1RequiredPage(10.5), false);
eq('NaN は対象外', policy.isGenoplanV1RequiredPage(NaN), false);
eq('Infinity は対象外', policy.isGenoplanV1RequiredPage(Infinity), false);
eq('文字列 "10" は対象外 (型で弾く)', policy.isGenoplanV1RequiredPage('10'), false);
eq('null は対象外', policy.isGenoplanV1RequiredPage(null), false);
eq('undefined は対象外', policy.isGenoplanV1RequiredPage(undefined), false);

// ===========================================================================
// ③ 完了判定 (§8.6)
// ===========================================================================
const all = [...policy.GENOPLAN_V1_REQUIRED_PAGES];
deepEq('全部 done なら missing 0', policy.missingGenoplanV1Pages(all), []);
deepEq('1 枚欠けたら missing に出る', policy.missingGenoplanV1Pages(all.filter((p) => p !== 17)), [17]);
deepEq('複数欠け', policy.missingGenoplanV1Pages(all.filter((p) => p !== 10 && p !== 35)), [10, 35]);
deepEq('1 枚も無ければ 26 件', policy.missingGenoplanV1Pages([]).length === 26 ? [] : ['x'], []);
// **ここが今回の本丸** — 行が作られなかったページを完了に数えない。
deepEq('行が無いページは missing (通信断の穴)', policy.missingGenoplanV1Pages(all.slice(0, 25)), [35]);
// 対象外の行が過去に残っていても母数を汚さない。
deepEq('p1〜9 が done でも母数に入らない',
  policy.missingGenoplanV1Pages([1, 2, 3, 4, 5, 6, 7, 8, 9]).length === 26 ? [] : ['x'], []);
deepEq('p36 以降が done でも完了にならない',
  policy.missingGenoplanV1Pages([...all.filter((p) => p !== 20), 36, 100, 208]), [20]);
deepEq('対象外だけが done でも完了にならない',
  policy.missingGenoplanV1Pages([1, 208, 210]).length === 26 ? [] : ['x'], []);
deepEq('重複 done があっても壊れない', policy.missingGenoplanV1Pages([...all, ...all]), []);

// ===========================================================================
// ④ 呼び出し側が正本を使っていること (テキスト検査)
// ===========================================================================
const processSrc = read('src/pages/api/admin/ad-hoc-diagnosis/process.ts');
ok('process が正本を import している', /from '\.\.\/\.\.\/\.\.\/\.\.\/lib\/elith-genetic'/.test(processSrc));
ok('process が isGenoplanV1RequiredPage で弾く', /isGenoplanV1RequiredPage\(page\)/.test(processSrc));
ok('範囲外は 400 で返す (silent skip にしない)',
  /page_out_of_range/.test(processSrc) && /\}, 400\)/.test(processSrc));
ok('process にページ番号がベタ書きされていない',
  !/\b(page|p)\s*[<>]=?\s*(10|35)\b/.test(processSrc.replace(/\/\*[\s\S]*?\*\//g, '')));

const serviceSrc = read('src/lib/ad-hoc-diagnosis/service.ts');
ok('service が missingGenoplanV1Pages を使う', /missingGenoplanV1Pages\(/.test(serviceSrc));
ok('service が「登録済み行が全部 done」方式へ戻っていない',
  !/pages\.filter\(\(p\) => p\.status !== 'done'\)\.length/.test(serviceSrc));
ok('納品に対象外ページを混ぜない',
  (serviceSrc.match(/status === 'done' && isGenoplanV1RequiredPage\(p\.page_no\)/g) ?? []).length >= 2);
ok('status API が対象ページを配る', /geneticRequiredPages: GENOPLAN_V1_REQUIRED_PAGES/.test(serviceSrc));

// wellfort-site 側 (在るときだけ見る。CI では同じランナーに両方在る)
const uiPath = join(repoRoot, '..', 'wellfort-site', 'src/pages/admin/ad-hoc-diagnosis.astro');
if (existsSync(uiPath)) {
  const ui = readFileSync(uiPath, 'utf8');
  const uiCode = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /*
   * **見るのは「ループの上限にページ総数を使っていないか」**。
   * `p <= pdf.numPages` という式そのものを禁止すると、
   * **PDF に無いページを飛ばす正当な clamp まで落ちる** (実際に落ちた)。
   * だから `for (...)` / `while (...)` のヘッダに numPages が出るかだけを見る。
   */
  const loopHeaders = uiCode.match(/\b(?:for|while)\s*\([^)]*\)/g) ?? [];
  ok('UI が全ページ走査へ戻っていない',
    !loopHeaders.some((h) => /numPages|pageCount/.test(h)),
    loopHeaders.filter((h) => /numPages|pageCount/.test(h)).join(' / '));
  ok('UI が「1 から総ページ数まで」を回していない',
    !/for\s*\(\s*let\s+p\s*=\s*1;\s*p\s*<=\s*(n|pdf\.numPages|pageCount)\s*;/.test(uiCode));
  ok('UI は対象集合を反復している (for...of)', /for\s*\(\s*const\s+p\s+of\s+targets\s*\)/.test(uiCode));
  ok('UI が API の対象ページを使う', /geneticRequiredPages/.test(uiCode));
  ok('UI に 10 / 35 がベタ書きされていない', !/\b(from|to)\s*[:=]\s*(10|35)\b/.test(uiCode));
  ok('対象が取れないときは推測で送らない', /対象ページを診断側から受け取れませんでした/.test(ui));
} else {
  ok('wellfort-site 未取得のため UI 検査はスキップ', true);
}

// ===========================================================================
rmSync(tmp, { recursive: true, force: true });
const total = pass + failures.length;
if (failures.length) {
  console.error(`\n✗ verify:ad-hoc-genoplan-pages  ${pass}/${total}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ verify:ad-hoc-genoplan-pages  ${pass}/${total}`);
