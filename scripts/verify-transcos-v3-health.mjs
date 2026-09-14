#!/usr/bin/env node
/**
 * トランスコスモス10名 v3.0 — Health 照合 (§10.4 / §10.5 / §10.6) の回帰チェック。
 *
 * 【何を守っているか】
 * 照合は**黙って空になる方向**に壊れる。名前が解決できなければ比較は 0 件で終わり、
 * 失敗も 0 件なので**緑に見える**。仕様 §10.5 が
 * 「名前解決できなかったので比較しない、は PASS ではない」とわざわざ書いているのは、
 * これが起きると**誰も気づかないまま 5 名ぶんの健診が無検査で納品される**から。
 *
 * だからここで固定するのは「一致したときに緑になる」ことではなく、
 * **一致していないときに必ず赤くなる**ことのほう:
 *   - production 側に項目が無い → `unresolved` で FAIL (0 件比較の PASS を作らない)
 *   - 同じ canonical が 2 件 → `duplicate` で FAIL (1 件目を採らない)
 *   - source が空 / production が空 → FAIL
 *   - 39列XLSX を持たない人物に空の cross-check を作らない (16/16 に見えてしまう)
 *
 * **合成データだけ**を使う (実在役員の値は 1 件も置かない)。
 * ただし §10.4 の Golden anchors は**仕様が明記した実 ZIP 由来の値**なので、
 * manifest に在るものを**参照するだけ**で、ここに書き写さない。
 *
 * 実行: node scripts/verify-transcos-v3-health.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

let pass = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `期待 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (r) => readFileSync(join(repoRoot, r), 'utf8');
const tmp = mkdtempSync(join(repoRoot, '.verify-v3h-'));
const FLAT = new Map([['./manifest', 'manifest.js'], ['../standard-master', 'standard-master.js']]);
const rel = (src) => {
  let out = src;
  for (const [k, v] of FLAT) out = out.split(`from '${k}'`).join(`from './${v}'`);
  return out;
};
const writeTs = (p, out) => writeFileSync(join(tmp, out), ts.transpileModule(rel(read(p)), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);
writeTs('src/lib/standard-master.ts', 'standard-master.js');
writeTs('src/lib/transcos-v3/manifest.ts', 'manifest.js');
writeTs('src/lib/transcos-v3/health-validate.ts', 'health-validate.js');
const M = await import(pathToFileURL(join(tmp, 'manifest.js')).href);
const SM = await import(pathToFileURL(join(tmp, 'standard-master.js')).href);
const H = await import(pathToFileURL(join(tmp, 'health-validate.js')).href);

// ===========================================================================
// ① §10.5 step2 — required canonical が production master に exact 1 件あるか
// ===========================================================================
{
  eq('必須 cross-check は 15 項目', M.HEALTH_CROSS_CHECK.length, 15);
  for (const p of M.HEALTH_CROSS_CHECK) {
    const n = SM.STANDARD_MASTER.filter((i) => i.canonical_name === p.canonical).length;
    ok(`step2: ${p.canonical} が master に exact 1 件`, n === 1, `実際 ${n} 件`);
  }
  // header と canonical が**別物として**保たれていること (片方へ寄せると照合の意味が消える)
  const differ = M.HEALTH_CROSS_CHECK.filter((p) => p.header !== p.canonical);
  ok('header と canonical が違う組が在る (表が恒等写像に潰れていない)', differ.length >= 5,
    `実際 ${differ.length} 組`);
}

// ===========================================================================
// ② 値の比較 — 書式差だけ許し、近似は許さない
// ===========================================================================
{
  ok('170 と 170.0 は同値', H.numericEqual('170', '170.0'));
  ok('170 と 170.00 は同値', H.numericEqual(170, '170.00'));
  ok('170 と 170.1 は別値', !H.numericEqual('170', '170.1'));
  ok('170 と 169.9 は別値 (丸めない)', !H.numericEqual(170, 169.9));
  ok('空は一致しない', !H.numericEqual('', ''));
  ok('単位つきは数値化しない', H.toNumber('170cm') === null);
  ok('カンマ入りも数値化しない', H.toNumber('1,700') === null);
  /*
   * **`Number()` に素で渡さない**。実測: `Number('0x10')` → 16 /
   * `Number('1e3')` → 1000 と、**検査値の書式ではない文字列が黙って数になる**。
   * `170cm` は NaN で落ちるので、素通しの実装でも気づけない (ここが唯一の番人)。
   */
  ok('16進に見える文字列を数値化しない', H.toNumber('0x10') === null, `実際 ${H.toNumber('0x10')}`);
  ok('指数表記を数値化しない', H.toNumber('1e3') === null, `実際 ${H.toNumber('1e3')}`);
  ok('前後の空白だけなら数値化する', H.toNumber(' 170 ') === 170);
  ok('定性は NFKC + trim の完全一致', H.qualitativeEqual(' －　', '－'));
  ok('定性の部分一致は不可', !H.qualitativeEqual('陰性', '陰'));
  ok('定性の空は一致しない', !H.qualitativeEqual('', ''));
}

// ===========================================================================
// ③ canonical で 1 件に決まらなければ採らない
// ===========================================================================
{
  const one = [{ item_name: '収縮期血圧', value_num: 110 }];
  eq('別名でも canonical で引ける', H.resolveByCanonical(one, '最高血圧').kind, 'one');
  eq('無ければ none', H.resolveByCanonical([], '最高血圧').kind, 'none');
  const dup = [{ item_name: '収縮期血圧', value_num: 110 }, { item_name: '最高血圧', value_num: 118 }];
  const r = H.resolveByCanonical(dup, '最高血圧');
  eq('2 件なら duplicate', r.kind, 'duplicate');
  ok('duplicate で 1 件目を採らない', r.measurement === undefined);
  eq('解決しない印字名を名指しで返す',
    H.unresolvedNames([{ item_name: 'HDL-コレステロール' }, { item_name: '身長' }]),
    ['HDL-コレステロール']);
}

// ===========================================================================
// ④ §10.4 Golden anchors
// ===========================================================================
const G0 = M.HEALTH_GOLDEN[0];
const goldenMeasurements = (over = {}) => ([
  { item_name: '身長', value_num: over.h ?? G0.heightCm },
  { item_name: '体重', value_num: over.w ?? G0.weightKg },
  { item_name: '最高血圧', value_num: over.s ?? G0.systolic },
  { item_name: '最低血圧', value_num: over.d ?? G0.diastolic },
  { item_name: 'HbA1c(NGSP)', value_num: over.a ?? G0.hba1cNgsp },
]);
{
  const r = H.validateGolden(G0.subject, G0.date, goldenMeasurements());
  ok('Golden 全一致で PASS', r.ok, JSON.stringify(r.anchors.filter((a) => a.status !== 'match')));
  eq('anchor は 5 件', r.anchors.length, 5);

  const bad = H.validateGolden(G0.subject, '2020-01-01', goldenMeasurements());
  ok('日付が違えば FAIL', !bad.ok);
  eq('日付の status', bad.date.status, 'mismatch');

  const noDate = H.validateGolden(G0.subject, null, goldenMeasurements());
  ok('日付が未確定なら FAIL', !noDate.ok);
  eq('未確定は unresolved (mismatch と区別する)', noDate.date.status, 'unresolved');

  // **anchor 欠落も FAIL** — ここが緩むと「読めなかったから比較しない」で緑になる
  const missing = H.validateGolden(G0.subject, G0.date,
    goldenMeasurements().filter((m) => m.item_name !== 'HbA1c(NGSP)'));
  ok('anchor 欠落は FAIL', !missing.ok);
  eq('欠落の status', missing.anchors.find((a) => a.anchor === 'HbA1c(NGSP)').status, 'unresolved');

  // 収縮期/拡張期は**個別に**見る (入れ替わりを取り逃さない)
  const swapped = H.validateGolden(G0.subject, G0.date,
    goldenMeasurements({ s: G0.diastolic, d: G0.systolic }));
  ok('血圧が入れ替わっていたら FAIL', !swapped.ok);

  // 書式差だけは通す
  const fmt = H.validateGolden(G0.subject, G0.date, [
    { item_name: '身長', value: String(G0.heightCm.toFixed(2)) },
    { item_name: '体重', value: String(G0.weightKg) },
    { item_name: '最高血圧', value: `${G0.systolic}.0` },
    { item_name: '最低血圧', value: `${G0.diastolic}` },
    { item_name: 'HbA1c(NGSP)', value: `${G0.hba1cNgsp}` },
  ]);
  ok('書式差 (170 / 170.00) は通る', fmt.ok, JSON.stringify(fmt.anchors.filter((a) => a.status !== 'match')));

  ok('Golden の無い人物は FAIL', !H.validateGolden('存在しない 人', '2025-01-01', goldenMeasurements()).ok);
}

// ===========================================================================
// ⑤ §10.5 cross-check — **ここが本丸**
// ===========================================================================
const SUB = M.TRANSCOS_SUBJECTS.find((s) => s.hasHealthSupport);
const SRC = { 身長: 170, 体重: 60, BMI: 20.8, 収縮期血圧: 110, 拡張期血圧: 70,
  赤血球数: 450, 血色素量: 14.2, 空腹時血糖: 95, 'HbA1c(NGSP)': 5.4,
  'AST(GOT)': 22, 'ALT(GPT)': 18, 'γ-GTP': 30, 'HDL-コレステロール': 60,
  空腹時中性脂肪: 100, 'LDL-コレステロール': 110 };
const PROD = M.HEALTH_CROSS_CHECK.map((p) => ({ item_name: p.canonical, value_num: SRC[p.header] }));
const DATE = '2025-09-25';
{
  const r = H.validateCrossCheck(SUB.displayName, DATE, { ...SRC, 健診日: DATE }, PROD);
  eq('必須は 16 項目 (健診日 + 15)', r.required, 16);
  ok('全一致で PASS', r.ok, JSON.stringify(r.items.filter((i) => i.status !== 'match')));
  eq('compared は 16', r.compared, 16);

  // (a) production に項目が無い → **0 件比較の PASS を作らない**
  const drop = H.validateCrossCheck(SUB.displayName, DATE, { ...SRC, 健診日: DATE },
    PROD.filter((m) => m.item_name !== 'HDLコレステロール'));
  ok('production に無ければ FAIL', !drop.ok);
  eq('その status は unresolved', drop.items.find((i) => i.header === 'HDL-コレステロール').status, 'unresolved');
  ok('compared が 16 未満になる', drop.compared < 16, `実際 ${drop.compared}`);

  // (b) **印字ゆれ** — production が `HDL-コレステロール` と印字した場合 (実測で未解決)
  const printed = H.validateCrossCheck(SUB.displayName, DATE, { ...SRC, 健診日: DATE },
    PROD.map((m) => m.item_name === 'HDLコレステロール'
      ? { item_name: 'HDL-コレステロール', value_num: m.value_num } : m));
  ok('印字ゆれは黙って通さない', !printed.ok);
  ok('原因の印字名を名指しで返す', printed.unresolvedProductionNames.includes('HDL-コレステロール'),
    JSON.stringify(printed.unresolvedProductionNames));

  // (c) 値違い
  const diff = H.validateCrossCheck(SUB.displayName, DATE, { ...SRC, 健診日: DATE, 体重: 61 }, PROD);
  ok('値が違えば FAIL', !diff.ok);
  eq('その status は mismatch', diff.items.find((i) => i.header === '体重').status, 'mismatch');

  // (d) source 空 / production 空 — どちらも not_compared で逃がさない
  const srcEmpty = H.validateCrossCheck(SUB.displayName, DATE, { ...SRC, 健診日: DATE, 'γ-GTP': '' }, PROD);
  ok('source が空なら FAIL', !srcEmpty.ok);
  eq('source 空の status', srcEmpty.items.find((i) => i.header === 'γ-GTP').status, 'source_empty');
  const prodEmpty = H.validateCrossCheck(SUB.displayName, DATE, { ...SRC, 健診日: DATE },
    PROD.map((m) => m.item_name === 'γ-GTP' ? { item_name: 'γ-GTP', value_num: null } : m));
  ok('production が空なら FAIL', !prodEmpty.ok);
  eq('production 空の status', prodEmpty.items.find((i) => i.header === 'γ-GTP').status, 'production_empty');

  // (e) 重複
  const dup = H.validateCrossCheck(SUB.displayName, DATE, { ...SRC, 健診日: DATE },
    [...PROD, { item_name: 'BMI', value_num: 21.0 }]);
  ok('重複は FAIL', !dup.ok);
  eq('重複の status', dup.items.find((i) => i.header === 'BMI').status, 'duplicate');

  // (f) 健診日: 39列XLSX / production / §10.4 Golden の 3 つが揃わなければ FAIL
  const dateNg = H.validateCrossCheck(SUB.displayName, DATE, { ...SRC, 健診日: '2025-09-26' }, PROD);
  ok('39列XLSX の健診日が違えば FAIL', !dateNg.ok);
  const dateNone = H.validateCrossCheck(SUB.displayName, DATE, { ...SRC }, PROD);
  eq('健診日が空なら source_empty', dateNone.items[0].status, 'source_empty');
  // **健診日を findByAlias へ渡していない** = canonical 欄が測定値でないことを示す
  eq('健診日の canonical は測定値でない', dateNone.items[0].canonical, '—');
}

// ===========================================================================
// ⑥ §10.6 — 人物 1 人ぶんの PASS 判定
// ===========================================================================
const basePass = {
  scanOk: true, pagesDone: 1, pagesRequired: 1, finalizeOk: true, schemaOk: true,
  itemCount: 12, bodyClientIdOk: true, bodyFormatIdOk: true, bodyTestDateOk: true,
};
{
  // 39列XLSX を持たない人物 (§10.5 対象外)
  const noSupport = M.TRANSCOS_SUBJECTS.find((s) => !s.hasHealthSupport);
  const g = M.HEALTH_GOLDEN.find((x) => x.subject === noSupport.displayName);
  const ms = [
    { item_name: '身長', value_num: g.heightCm }, { item_name: '体重', value_num: g.weightKg },
    { item_name: '最高血圧', value_num: g.systolic }, { item_name: '最低血圧', value_num: g.diastolic },
    { item_name: 'HbA1c(NGSP)', value_num: g.hba1cNgsp },
  ];
  const r = H.evaluateHealth({ ...basePass, subject: noSupport.displayName, testDate: g.date,
    measurements: ms, supportRow: null });
  ok('補助XLSX が無い人物は Golden だけで PASS', r.ok, JSON.stringify(r.reasons));
  // **空の cross-check を作らない** — 作ると 16/16 compared に見えて誰も気づかない
  eq('cross は null', r.cross, null);
  ok('§10.5 対象かを manifest から引ける', H.needsCrossCheck(noSupport.displayName) === false);
  ok('補助XLSX を持つ人物は対象', H.needsCrossCheck(SUB.displayName) === true);

  // 各前提が 1 つ欠けるだけで FAIL し、**理由が名前で出る**
  for (const [label, over, needle] of [
    ['scan 失敗', { scanOk: false }, 'production scan'],
    ['ページ不足', { pagesDone: 0 }, 'ページが 0/1'],
    ['finalize 失敗', { finalizeOk: false }, 'finalizeHealthCheckup'],
    ['schema 不正', { schemaOk: false }, 'schema'],
    ['item_count 0', { itemCount: 0 }, 'item_count'],
    ['client_id 不一致', { bodyClientIdOk: false }, 'client_id'],
    ['format_id 不一致', { bodyFormatIdOk: false }, 'format_id'],
    ['test_date 不一致', { bodyTestDateOk: false }, 'test_date'],
  ]) {
    const x = H.evaluateHealth({ ...basePass, ...over, subject: noSupport.displayName,
      testDate: g.date, measurements: ms, supportRow: null });
    ok(`${label} で FAIL`, !x.ok);
    ok(`${label} の理由が出る`, x.reasons.some((s) => s.includes(needle)), JSON.stringify(x.reasons));
  }

  // **検査日が未確定なら納品しない** (today fallback の入口を塞ぐ・§10.3)
  const noDate = H.evaluateHealth({ ...basePass, subject: noSupport.displayName,
    testDate: null, measurements: ms, supportRow: null });
  ok('検査日が未確定なら FAIL', !noDate.ok);
  ok('その理由が出る', noDate.reasons.some((s) => s.includes('検査日が確定していない')));

  // 補助XLSX がある人物は §10.5 も通らないと PASS しない
  const gs = M.HEALTH_GOLDEN.find((x) => x.subject === SUB.displayName);
  const withSupport = H.evaluateHealth({
    ...basePass, subject: SUB.displayName, testDate: gs.date,
    measurements: [
      { item_name: '身長', value_num: gs.heightCm }, { item_name: '体重', value_num: gs.weightKg },
      { item_name: '最高血圧', value_num: gs.systolic }, { item_name: '最低血圧', value_num: gs.diastolic },
      { item_name: 'HbA1c(NGSP)', value_num: gs.hba1cNgsp },
    ],
    supportRow: { ...SRC, 健診日: gs.date },
  });
  ok('Golden は通るが cross-check が欠けていれば FAIL', !withSupport.ok);
  ok('cross-check の欠けが理由に出る',
    withSupport.reasons.some((s) => s.startsWith('cross-check')), JSON.stringify(withSupport.reasons));
}

rmSync(tmp, { recursive: true, force: true });
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 件 失敗 (${pass} 件 通過)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ ${pass} 件 通過 — 「比較できなかった」は PASS にならない`);
