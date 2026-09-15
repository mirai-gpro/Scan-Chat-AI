#!/usr/bin/env node
/**
 * トランスコスモス10名 v3.0 — Genetic (§13) の回帰チェック。
 *
 * 【2 つのことを守っている】
 * ① **production parity** (§13.3)。finalize の組み立てを共通 core へ出したので、
 *    **抽出の前後で納品 JSON が 1 バイトも変わっていない**ことを機械で示す。
 *    ここがずれると、**通常運用の遺伝子納品が静かに別物になる** —
 *    しかも S3 へ出たあとでしか気づけない。
 *    参照実装 (抽出前のコード) をこのファイルに写して突き合わせる。
 * ② **v3 の完了判定と semantic audit** (§13.4 / §13.5 / §16)。
 *    `25/26` を完了にしない・行が無いページを完了に数えない・
 *    対象外ページを読んでいたら黙って捨てない。
 *
 * **合成データだけ**を使う。
 * 実行: node scripts/verify-transcos-v3-genetic.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

let pass = 0;
const failures = [];
const ok = (n, c, d = '') => { if (c) { pass += 1; return; } failures.push(`${n}${d ? ` — ${d}` : ''}`); };
const eq = (n, a, e) => ok(n, JSON.stringify(a) === JSON.stringify(e), `期待 ${JSON.stringify(e)} / 実際 ${JSON.stringify(a)}`);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (r) => readFileSync(join(repoRoot, r), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const tmp = mkdtempSync(join(repoRoot, '.verify-v3g-'));

// Gemini / app-config / S3 を触らせずに core を動かすためのスタブ。
writeFileSync(join(tmp, 'gemini.js'), 'export const MODELS = { scan: "stub-model" };\n');
writeFileSync(join(tmp, 'elith-export.js'), 'export const ELITH_HANDOFF_SCHEMA_VERSION = "elith-v1.0";\n');
writeFileSync(join(tmp, 'ai-prediction-consolidate.js'),
  'export function consolidateAiPredictionItems(items){return {items, audit:{stub:true}};}\n');
const FLAT = new Map([
  ['./elith-export', 'elith-export.js'], ['./ai-prediction-consolidate', 'ai-prediction-consolidate.js'],
  ['./gemini', 'gemini.js'], ['../elith-genetic', 'elith-genetic.js'], ['./manifest', 'manifest.js'],
]);
const rel = (src) => { let o = src; for (const [k, v] of FLAT) o = o.split(`from '${k}'`).join(`from './${v}'`); return o; };
const writeTs = (p, out) => writeFileSync(join(tmp, out), ts.transpileModule(rel(read(p)), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);
writeTs('src/lib/elith-genetic-finalize.ts', 'elith-genetic-finalize.js');
writeTs('src/lib/transcos-v3/manifest.ts', 'manifest.js');
// `elith-genetic.ts` は Gemini を掴むので、**ページ規則の部分だけ**を切り出して使う。
{
  const src = read('src/lib/elith-genetic.ts');
  const from = src.indexOf('export const GENOPLAN_V1_PAGE_RANGE');
  const to = src.indexOf('export function scanGeneticPage');
  writeFileSync(join(tmp, 'elith-genetic.js'), ts.transpileModule(src.slice(from, to), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
}
writeTs('src/lib/transcos-v3/genetic-validate.ts', 'genetic-validate.js');
const F = await import(pathToFileURL(join(tmp, 'elith-genetic-finalize.js')).href);
const G = await import(pathToFileURL(join(tmp, 'genetic-validate.js')).href);
const EG = await import(pathToFileURL(join(tmp, 'elith-genetic.js')).href);
const M = await import(pathToFileURL(join(tmp, 'manifest.js')).href);

// ===========================================================================
// ① production parity — **抽出前のコードを参照実装として写す**
// ===========================================================================
/**
 * `elith-genetic-merge.ts` の finalize が **抽出前に**組み立てていた JSON。
 * ここを書き換えて通すのは禁止 — これが「前と同じ」の定義。
 */
function referenceJson(inp) {
  const items = [];
  const pages = [];
  for (const p of inp.parts) {
    const pageItems = Array.isArray(p.items) ? p.items : [];
    items.push(...pageItems);
    pages.push({
      page: typeof p.page === 'number' ? p.page : pages.length + 1,
      section: typeof p.section === 'string' ? p.section : null,
      count: pageItems.length,
    });
  }
  let deliverItems = items;
  if (inp.formatId === 'Other' && inp.consolidateAiPrediction) deliverItems = items; // スタブは素通し
  const dateFolder = inp.testDate.replace(/-/g, '_');
  const cleanPrefix = inp.prefix ? inp.prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  const folder = `${cleanPrefix}user/${inp.clientId}/date/${dateFolder}/`;
  const stem = `${inp.formatId}_date_${dateFolder}_user_${inp.clientId}`;
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    key: `${folder}${stem}.json`,
    json: {
      format_id: inp.formatId,
      schema_version: 'elith-v1.0',
      kind: inp.kind,
      client_id: inp.clientId,
      diagnostic_id: inp.diagnosticId,
      source_file: str(inp.sourceFile),
      source_pages: str(inp.sourcePages),
      page_count: inp.parts.length,
      test_date: inp.testDate,
      date_source: inp.dateSource,
      exported_at: inp.exportedAt.toISOString(),
      subject: { sex: null, age: null },
      source: {
        origin: 'scan-chat-ai', app: 'scan-chat-ai', model: inp.scanModel,
        note: inp.formatId === 'Other'
          ? 'admin バッチ (LAiF AI疾病発症予測・AIスキャン・構造化はLLM全面委任)。項目構造はLLM判定。'
          : 'admin バッチ (遺伝子・AIスキャン・構造化はLLM全面委任)。項目構造はLLM判定。',
        lab_name: inp.formatId === 'Other' ? 'LAiF' : null,
      },
      data: { item_count: deliverItems.length, items: deliverItems, pages },
    },
  };
}

const FIXED = {
  diagnosticId: '00000000-1111-2222-3333-444444444444',
  exportedAt: new Date('2026-09-15T01:02:03.000Z'),
  scanModel: 'stub-model',
};
const parts26 = EG.GENOPLAN_V1_REQUIRED_PAGES.map((p, i) => ({
  page: p, section: `セクション${i}`,
  items: [{ 項目名: `疾患${i}`, 発症リスク倍率: 1 + i / 10 }],
}));
const baseInput = (over = {}) => ({
  formatId: 'GeneticTestResultData', kind: 'genetic_scan_merged',
  clientId: '11111111-2222-3333-4444-555555555555',
  testDate: '2026-08-12', dateSource: 'provided',
  parts: parts26, prefix: 'scan-accuracy-test/',
  sourceFile: 'genoplan.pdf', sourcePages: '10-35',
  consolidateAiPrediction: false, ...FIXED, ...over,
});
{
  for (const over of [
    {}, { formatId: 'Other', kind: 'ai_prediction' },
    { prefix: '' }, { prefix: '/lead/and/trail/' },
    { sourceFile: null, sourcePages: null }, { sourceFile: '  ', sourcePages: '  ' },
    { dateSource: 'today' }, { parts: [] },
    { parts: [{ items: [{ 項目名: 'a' }] }, { page: 'x', section: 5, items: 'not-array' }] },
  ]) {
    const inp = baseInput(over);
    const got = F.finalizeGeneticDelivery(inp);
    const want = referenceJson(inp);
    eq(`parity: key (${JSON.stringify(over).slice(0, 44)})`, got.jsonKey, want.key);
    eq(`parity: json (${JSON.stringify(over).slice(0, 44)})`, got.json, want.json);
    eq(`parity: 本文がバイト単位で一致 (${JSON.stringify(over).slice(0, 44)})`,
      got.jsonBody, JSON.stringify(want.json, null, 2));
  }
  // **core は S3 を触らない** (副作用なし・§13.3)
  const src = strip(read('src/lib/elith-genetic-finalize.ts'));
  for (const banned of ['putFiles', 'getS3Config', 'isS3Configured', 'S3Client', 'fetch(']) {
    ok(`core が ${banned} を持たない`, !src.includes(banned));
  }
  /*
   * **core は today を埋めない** (§13.3)。
   * ソースに `jstTodayIso` が無いことだけでは足りない — `new Date()` から
   * 日付を作る実装に変えられても素通りする。**空の testDate を渡して、
   * core が勝手に今日を入れないこと**を実際に確かめる。
   */
  ok('core が jstTodayIso を呼ばない', !src.includes('jstTodayIso'));
  {
    const blank = F.finalizeGeneticDelivery(baseInput({ testDate: '' }));
    eq('空の testDate を今日で埋めない', blank.json.test_date, '');
    const today = new Date().toISOString().slice(0, 10);
    ok('key にも今日が入らない', !blank.jsonKey.includes(today.replace(/-/g, '_')), blank.jsonKey);
  }
  ok('core が app_config を読まない', !src.includes('cfgBool') && !src.includes('refreshConfig'));

  // **endpoint は自分で JSON を組み立てない** (組み立ては core 1 か所)
  const ep = strip(read('src/pages/api/admin/elith-genetic-merge.ts'));
  ok('endpoint が core を呼ぶ', ep.includes('finalizeGeneticDelivery('));
  /*
   * **endpoint に `schema_version` の語が 1 つも無いこと。**
   * 定数名 (`ELITH_HANDOFF_SCHEMA_VERSION`) だけを見ていると、
   * リテラルで `schema_version: 'elith-v1.0'` と書き直した退行が素通りする (実測)。
   */
  ok('endpoint が schema_version を自分で書かない', !ep.includes('schema_version'));
  ok('endpoint が ELITH_HANDOFF_SCHEMA_VERSION を import しない', !ep.includes('ELITH_HANDOFF_SCHEMA_VERSION'));
  ok('endpoint が folder 規則を持たない', !ep.includes('user/${clientId}/date/'));
  ok('endpoint が diagnostic_id を自分で作らない', !ep.includes('randomUuid'));
  // **today フォールバックは endpoint 側に残っている** (通常運用の互換・§13.3)
  ok('endpoint に today フォールバックが残っている', ep.includes('jstTodayIso()'));
  // S3 書き込みは endpoint 側 (core でない)
  ok('endpoint が S3 へ書く', ep.includes('putFiles('));
}

// ===========================================================================
// ② §13.1 / §13.4 completeness
// ===========================================================================
const rows = (pages, parsed = true) => pages.map((p) => ({ page: p, parsed }));
{
  eq('required は 26 ページ', EG.GENOPLAN_V1_REQUIRED_PAGES.length, 26);
  eq('required の先頭と末尾', [EG.GENOPLAN_V1_REQUIRED_PAGES[0], EG.GENOPLAN_V1_REQUIRED_PAGES[25]], [10, 35]);

  const full = G.geneticCompleteness(rows(EG.GENOPLAN_V1_REQUIRED_PAGES));
  ok('26/26 で完了', full.ok, JSON.stringify(full));
  eq('done は 26', full.done, 26);

  // **25/26 は FAIL** — ここが緩むと 1 ページ欠けたまま納品される
  const short = G.geneticCompleteness(rows(EG.GENOPLAN_V1_REQUIRED_PAGES.slice(0, 25)));
  ok('25/26 は FAIL', !short.ok);
  eq('不足ページが名指しされる', short.missing, [35]);

  // **行が無いページも missing** (通信断で行すら作られなかった場合)
  const noRow = G.geneticCompleteness(rows(EG.GENOPLAN_V1_REQUIRED_PAGES.filter((p) => p !== 20)));
  ok('行が無いページは完了に数えない', !noRow.ok);
  eq('その不足が出る', noRow.missing, [20]);

  // `parsed=false` も missing
  const failed = G.geneticCompleteness([
    ...rows(EG.GENOPLAN_V1_REQUIRED_PAGES.filter((p) => p !== 12)),
    { page: 12, parsed: false },
  ]);
  ok('parsed=false は完了に数えない', !failed.ok);
  eq('その不足が出る', failed.missing, [12]);

  // **対象外ページは completion に数えないが、黙って捨てない** (§13.1)
  const extra = G.geneticCompleteness([...rows(EG.GENOPLAN_V1_REQUIRED_PAGES), { page: 9, parsed: true }]);
  ok('p9 を読んでいたら FAIL', !extra.ok);
  eq('対象外として名指しされる', extra.outOfRange, [9]);
  const after = G.geneticCompleteness([...rows(EG.GENOPLAN_V1_REQUIRED_PAGES), { page: 36, parsed: true }]);
  eq('p36 も対象外', after.outOfRange, [36]);
  // 対象外があっても required は満たしている = 「数えない」ことの確認
  eq('対象外は done に加算されない', extra.done, 26);
  // 210 ページ全部読んだ場合
  const all = G.geneticCompleteness(rows(Array.from({ length: 210 }, (_, i) => i + 1)));
  ok('全ページ走査は FAIL', !all.ok);
  eq('対象外が 184 件', all.outOfRange.length, 184);
}

// ===========================================================================
// ③ §13.5 semantic audit — **本文を書き換えない**
// ===========================================================================
const deliveryOf = (over = {}) => F.finalizeGeneticDelivery(baseInput(over)).json;
{
  const j = deliveryOf();
  const a = G.geneticSemanticAudit(j, { minDistinctItems: 20 });
  ok('正常な JSON は audit PASS', a.ok, JSON.stringify(a.reasons));
  eq('概念数は 26', a.distinctItems, 26);
  eq('重複は 0', a.duplicated, 0);

  // **audit は本文を変えない** (§13.5 末尾)
  const before = JSON.stringify(j);
  G.geneticSemanticAudit(j, { minDistinctItems: 20 });
  eq('audit を通しても本文が変わらない', JSON.stringify(j), before);

  // 重複は view で数えるだけ (納品 data は畳まない)
  const dupJson = deliveryOf({
    parts: [{ page: 10, items: [{ 項目名: '同じ' }, { 項目名: '同じ' }, { 項目名: '別' }] }],
  });
  const da = G.geneticSemanticAudit(dupJson, { minDistinctItems: 1 });
  eq('重複を数える', da.duplicated, 1);
  eq('概念数は畳んだ数', da.distinctItems, 2);
  eq('納品 data は畳まれていない', dupJson.data.items.length, 3);

  // 空配列は BLOCK
  const empty = G.geneticSemanticAudit(deliveryOf({ parts: [] }), { minDistinctItems: 1 });
  ok('空の items は BLOCK', !empty.ok);
  ok('理由が出る', empty.reasons.some((s) => s.includes('空')), JSON.stringify(empty.reasons));

  // 極端な欠落は BLOCK
  const thin = G.geneticSemanticAudit(deliveryOf({ parts: [{ page: 10, items: [{ 項目名: 'a' }] }] }),
    { minDistinctItems: 20 });
  ok('概念数が Golden coverage に届かなければ BLOCK', !thin.ok);

  // required key 欠落は BLOCK
  for (const k of ['format_id', 'schema_version', 'client_id', 'test_date', 'page_count', 'data']) {
    const broken = { ...deliveryOf() };
    delete broken[k];
    const r = G.geneticSemanticAudit(broken, { minDistinctItems: 1 });
    ok(`${k} 欠落は BLOCK`, !r.ok);
  }
  // 項目名を持たない item だけ
  const unnamed = G.geneticSemanticAudit(deliveryOf({ parts: [{ page: 10, items: [{ x: 1 }, { y: 2 }] }] }),
    { minDistinctItems: 1 });
  ok('項目名が 1 件も無ければ BLOCK', !unnamed.ok);
  eq('unnamed を数える', unnamed.unnamed, 2);
}

// ===========================================================================
// ④ §16 Genetic の format validation
// ===========================================================================
const SUBJ = M.TRANSCOS_SUBJECTS[0];
const passInput = (over = {}) => ({
  subject: SUBJ.displayName,
  pages: rows(EG.GENOPLAN_V1_REQUIRED_PAGES),
  json: deliveryOf({ testDate: SUBJ.geneticDate }),
  expectedTestDate: null, minDistinctItems: 20, ...over,
});
{
  // §13.2 の日付は manifest が正本
  eq('manifest から Genetic 日付を引く', G.geneticDateOf(SUBJ.displayName), SUBJ.geneticDate);
  eq('居ない人物は null', G.geneticDateOf('存在しない 人'), null);

  const r = G.evaluateGenetic(passInput());
  ok('全部揃えば PASS', r.ok, JSON.stringify(r.reasons));

  for (const [label, over, needle] of [
    ['ページ不足', { pages: rows(EG.GENOPLAN_V1_REQUIRED_PAGES.slice(0, 25)) }, '必要ページ'],
    ['対象外を読んだ', { pages: [...rows(EG.GENOPLAN_V1_REQUIRED_PAGES), { page: 1, parsed: true }] }, '対象外'],
    ['JSON 無し', { json: null }, '納品 JSON'],
    ['日付違い', { json: deliveryOf({ testDate: '2020-01-01' }) }, 'test_date'],
    ['item_count 0', { json: deliveryOf({ parts: [] }) }, 'item_count'],
  ]) {
    const x = G.evaluateGenetic(passInput(over));
    ok(`${label} で FAIL`, !x.ok);
    ok(`${label} の理由が出る`, x.reasons.some((s) => s.includes(needle)), JSON.stringify(x.reasons));
  }

  // page_count が 26 でなければ FAIL
  const wrongCount = G.evaluateGenetic(passInput({
    json: deliveryOf({ testDate: SUBJ.geneticDate, parts: parts26.slice(0, 25) }),
    pages: rows(EG.GENOPLAN_V1_REQUIRED_PAGES),
  }));
  ok('page_count が 26 でなければ FAIL', !wrongCount.ok);
  ok('その理由が出る', wrongCount.reasons.some((s) => s.includes('page_count')), JSON.stringify(wrongCount.reasons));

  // **10 名ぶんの期待日付が manifest に在る** (§13.2)
  for (const s of M.TRANSCOS_SUBJECTS) {
    ok(`${s.subjectNo} の Genetic 日付が在る`, /^\d{4}-\d{2}-\d{2}$/.test(String(s.geneticDate)));
    ok(`${s.subjectNo} はレポート作成日 2026-08-25 を使っていない`, s.geneticDate !== '2026-08-25');
  }
}

rmSync(tmp, { recursive: true, force: true });
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 件 失敗 (${pass} 件 通過)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ ${pass} 件 通過 — 納品 JSON は抽出前と同一で、26/26 未満は完了にならない`);
