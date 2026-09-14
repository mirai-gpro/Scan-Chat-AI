#!/usr/bin/env node
/**
 * トランスコスモス10名 緊急専用 v2.0 — **専用 API の境界**の回帰チェック。
 *
 * 【なぜ要るか】ここの緩みは全部「動いてしまう」形で現れる:
 *   - 認可が 1 本抜けても、**正常系は何も変わらない**
 *   - p9 や p36 を弾き損ねても LLM は答えを返すので、**208 ページ全部叩いても成功に見える**
 *   - 汎用 classify を呼んでしまっても、**JSON は出来る** (中身が推測なだけ)
 *   - `pagesOnly` を外すと**遅くなるだけ**なので、60 分 SLA の中でしか気づけない
 *
 * ソース検査 (A 層)。**ネットワークへ出ない・LLM を呼ばない・S3 へ書かない。**
 *
 * 実行: node scripts/verify-transcos-api.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `期待 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const API_DIR = 'src/pages/api/admin/transcos-emergency';
const routes = readdirSync(join(repoRoot, API_DIR)).filter((f) => f.endsWith('.ts') && !f.startsWith('_'));

// ===========================================================================
// ① 全ルートが admin 認可を通る
// ===========================================================================
eq('専用ルートの数', routes.sort(), [
  'build.ts', 'deliver.ts', 'page.ts', 'preflight-entry.ts',
  'preflight-finish.ts', 'preflight-plan.ts', 'status.ts', 'subjects.ts',
]);
for (const f of routes) {
  const src = strip(read(join(API_DIR, f)));
  ok(`${f}: 認可を通す`, /if \(!authorized\(request\)\) return json\(\{ ok: false, error: 'unauthorized' \}, 401\);/.test(src));
  ok(`${f}: 認可判定を自前で書かない`, !/ADMIN_API_KEY|Bearer /.test(src));
  ok(`${f}: prerender を切る`, /export const prerender = false;/.test(src));
}
{
  const sh = strip(read(join(API_DIR, '_shared.ts')));
  ok('共通部は既存の認可を re-export するだけ',
    /export \{[^}]*authorized[^}]*\} from '\.\.\/ad-hoc-diagnosis\/_shared';/.test(sh));
  ok('共通部に独自の判定を書かない', !/function authorized/.test(sh));
}

// ===========================================================================
// ② 汎用経路へ逃がさない (§8 / §26-1)
// ===========================================================================
for (const f of routes) {
  const src = strip(read(join(API_DIR, f)));
  ok(`${f}: 汎用 classify を呼ばない`,
    !/classifyBatch|classifyPlan|classifyEntry|classifyFinalize/.test(src));
  ok(`${f}: 汎用の一括納品を呼ばない`, !/assembleBatch\(/.test(src));
}

// ===========================================================================
// ③ Genoplan のページ範囲 (§13 / §26-9 / §26-10)
// ===========================================================================
{
  const src = strip(read(join(API_DIR, 'page.ts')));
  ok('遺伝子は対象集合の外を断る', /!GENETIC_PAGES\.includes\(page\)/.test(src));
  ok('断り方は 4xx (silent skip にしない)', /error: 'page_out_of_range'.*400|page_out_of_range'[\s\S]{0,40}400/.test(src));
  ok('断るのは scan を呼ぶ前', src.indexOf('page_out_of_range') < src.indexOf('processBatch('));
  ok('健診もページ範囲を見る', /page > \(m\.pages \?\? 1\)/.test(src));
  ok('scan できる役割だけ通す', /entry_not_scannable/.test(src));
  ok('組み立てを毎回やり直さない', /pagesOnly: true/.test(src));
  ok('専用 prompt を作っていない', !/systemInstruction|prompt/i.test(src));

  // **10 / 35 を専用コードにベタ書きしない** — 正本は production の定数
  const run = strip(read('src/lib/transcos-emergency/run.ts'));
  ok('対象ページは production の正本から取る',
    /import \{ GENOPLAN_V1_REQUIRED_PAGES \} from '\.\.\/elith-genetic'/.test(run));
  ok('run に 10 / 35 のベタ書きが無い', !/\b(10|35)\s*,\s*(11|36)\b/.test(run));
  const subjectsApi = strip(read(join(API_DIR, 'subjects.ts')));
  ok('対象ページは画面へ配る (画面が持たない)', /geneticPages: \[\.\.\.GENETIC_PAGES\]/.test(subjectsApi));
}

// ===========================================================================
// ④ Preflight が先 (§8)
// ===========================================================================
{
  const run = strip(read('src/lib/transcos-emergency/run.ts'));
  ok('FAIL なら seed しない', /if \(!report\.ok\) \{[\s\S]{0,200}seeded: null/.test(run));
  ok('seed は PASS の後だけ', run.indexOf('if (!report.ok)') < run.indexOf('await seedRun('));
  ok('Executive は exact 1 件のときだけ結ぶ', /e\.candidates !== 1 \|\| !e\.executiveSubjectId/.test(run));
  ok('run の識別は ZIP SHA と run kind', /source_sha256 === TRANSCOS_ZIP\.sha256/.test(run));
  ok('専用 API は汎用バッチを操作しない', /isTranscosRun/.test(run));
  ok('ZIP は SHA 完全一致でだけ探す', /findBatchesBySha\(TRANSCOS_ZIP\.sha256\)/.test(run));
  // **観測として残すのは同一性だけ。** path も本文も持たない形を固定する。
  ok('preflight の観測は kind と probe だけ',
    /detail: \{ kind: PREFLIGHT_DETAIL, probe \}/.test(run));
  const pf = strip(read('src/lib/transcos-emergency/preflight.ts'));
  const probeType = /export interface EntryProbe \{([\s\S]*?)\n\}/.exec(pf)?.[1] ?? '';
  ok('EntryProbe に path を持たない', !/\bpath\b/.test(probeType), probeType.slice(0, 120));
  ok('EntryProbe に本文を持たない', !/\braw\b|markdown|text/.test(probeType));
}
for (const f of ['page.ts', 'build.ts', 'deliver.ts']) {
  const src = strip(read(join(API_DIR, f)));
  ok(`${f}: 専用 run でなければ断る`, /not_transcos_run/.test(src));
}

// ===========================================================================
// ⑤ PII (§22)
// ===========================================================================
{
  const finish = strip(read(join(API_DIR, 'preflight-finish.ts')));
  ok('画面から氏名を受け取らない', !/displayName|name/.test(finish.replace(/subjectNo/g, '')));
  ok('受け取るのは番号・件数・UUID だけ', /subjectNo[\s\S]{0,300}candidates[\s\S]{0,300}executiveSubjectId/.test(finish));
  ok('UUID の形を確かめる', /isUuid\(id\)/.test(finish));
}
{
  const src = strip(read(join(API_DIR, 'page.ts')));
  ok('画像はデータ URL の形を確かめる', /\^data:\(image/.test(src));
  ok('画像を保存しない', !/putOriginal|store\.upsertFile|writeFile/.test(src));
}

// ===========================================================================
// ⑥ 既存 production への差分が最小であること (§20)
// ===========================================================================
{
  const svc = strip(read('src/lib/ad-hoc-diagnosis/service.ts'));
  ok('pagesOnly は任意で既定 false', /pagesOnly\?: boolean;/.test(svc));
  ok('pagesOnly は明示したときだけ効く', /options\.pagesOnly === true/.test(svc));
  ok('buildSubjectDelivery が export されている', /export async function buildSubjectDelivery\(/.test(svc));
  // 通常納品の規則は変えていない
  const wg = strip(read('src/lib/ad-hoc-diagnosis/write-guard.ts'));
  ok('部分納品禁止が残っている', /partial_export_blocked/.test(wg));
  ok('create-only のままである', /IfNoneMatch: '\*'/.test(wg));
}

console.log('');
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 件 失敗 (${pass} 件 通過)\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
  process.exit(1);
}
console.log(`✓ ${pass} 件 通過 — 専用 API は認可を通し、汎用へ逃げず、対象ページの外を断る\n`);
