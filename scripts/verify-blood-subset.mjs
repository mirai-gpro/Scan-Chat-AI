#!/usr/bin/env node
/**
 * **人間ドック・健康診断由来 派生 blood の検査。** サーバも鍵もブラウザも要らない。
 *
 * 正本: `docs/specs/healthcheckup_blood_extraction_spec_20261001.md` §12
 *
 * 【なぜ要るか】この機能は**静かに壊れる**種類のものばかりでできている。
 *   - 0 補完が 1 つ混ざっても画面はエラーを出さない (点が増えるだけ)
 *   - `血糖` を `空腹時血糖` に当ててしまっても値は出る (= 捏造が成功して見える)
 *   - readiness の除外が外れると、デメカル到着前に Elith 納品が発火し、
 *     `elith_deliveries` の unique で**同じ回は二度と再送されない**
 *   - 同日の優先が外れると通常 blood が派生で上書きされる
 *   どれも目視では守れないので、**実物の関数を動かして**数と値を数える。
 *
 * 【どう動かすか】Supabase は**インメモリの偽物**に差し替える (DB は要らない)。
 * `demo-data` は通さない (実データ経路を検査する)。
 *
 * 【本番の実データを fixture にしてある】②-2 は
 * `docs/scan/golden/scan_golden_healthcheckup_20250123.md` の実測値 =
 * 2026-09-24 の対象検体と同じ中身で、**15 項目のうち 11 項目だけが在る**。
 * 期待値 (11 件・4 項目は行ごと無し) をここで固定する。
 */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';

const CACHE = 'node_modules/.cache';
mkdirSync(CACHE, { recursive: true });

let pass = 0;
const fails = [];
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  — ' + extra : ''}`); }
  else { fails.push(label); console.log(`FAIL  ${label}${extra ? '  — ' + extra : ''}`); }
};

/* ── インメモリの偽 Supabase ──────────────────────────────────────── */
function makeDb(seed = {}) {
  const tables = {
    test_artifacts: [...(seed.test_artifacts ?? [])],
    measurement_values: [...(seed.measurement_values ?? [])],
    test_artifact_files: [...(seed.test_artifact_files ?? [])],
    interview_completions: [...(seed.interview_completions ?? [])],
  };
  let gen = 0;
  function from(name) {
    const st = { op: 'select', filters: [], values: null, insertRows: null };
    const match = (r) => st.filters.every(([k, c, v]) =>
      k === 'eq' ? r[c] === v
      : k === 'neq' ? r[c] !== v
      : k === 'in' ? Array.isArray(v) && v.includes(r[c])
      : k === 'notnull' ? r[c] != null
      : true);
    const run = () => {
      const rows = () => tables[name] ?? (tables[name] = []);
      if (st.op === 'insert') {
        const added = st.insertRows.map((r) => ({ ...r, id: r.id ?? `gen-${name}-${++gen}` }));
        tables[name] = rows().concat(added);
        return { data: added.map((r) => ({ ...r })), error: null };
      }
      if (st.op === 'update') {
        let n = 0;
        for (const r of rows()) if (match(r)) { Object.assign(r, st.values); n += 1; }
        return { data: null, error: null, count: n };
      }
      if (st.op === 'delete') {
        const gone = rows().filter(match).map((r) => r.id);
        tables[name] = rows().filter((r) => !match(r));
        /*
         * **`on delete cascade` を再現する。** 実スキーマは
         * `measurement_values.artifact_id` (20260820000010_measurement_values.sql:33) と
         * `test_artifact_files.test_artifact_id` (20260601000010_schemas_and_tables.sql:215) が
         * どちらも `references diagnosis.test_artifacts(id) on delete cascade`。
         * ここを再現しないと冪等の検査が**実環境より厳しく**落ちる (偽陽性)。
         */
        if (name === 'test_artifacts' && gone.length > 0) {
          tables.measurement_values = (tables.measurement_values ?? []).filter((r) => !gone.includes(r.artifact_id));
          tables.test_artifact_files = (tables.test_artifact_files ?? []).filter((r) => !gone.includes(r.test_artifact_id));
        }
        return { data: null, error: null };
      }
      return { data: rows().filter(match).map((r) => ({ ...r })), error: null };
    };
    const api = {
      select() { return api; },
      insert(r) { st.op = 'insert'; st.insertRows = Array.isArray(r) ? r : [r]; return api; },
      update(v) { st.op = 'update'; st.values = v; return api; },
      delete() { st.op = 'delete'; return api; },
      eq(c, v) { st.filters.push(['eq', c, v]); return api; },
      neq(c, v) { st.filters.push(['neq', c, v]); return api; },
      in(c, v) { st.filters.push(['in', c, v]); return api; },
      not(c) { st.filters.push(['notnull', c]); return api; },
      order() { return api; },
      limit() { return api; },
      single() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }
  return { tables, schema: () => ({ from }), from };
}

/* ── スタブ & バンドル ───────────────────────────────────────────── */
writeFileSync(`${CACHE}/bs-supabase-stub.mjs`, `export let _stub = null;
export function __setStub(s) { _stub = s; }
export function getServerSupabase() { return _stub; }
export function getBrowserSupabase() { return null; }
export function getBridgeSupabase() { return null; }
export function isBridgeConfigured() { return false; }
export function getStagingBridgeEndpoint() { return null; }
`);
writeFileSync(`${CACHE}/bs-demo-stub.mjs`, `export function demoFallbackEnabled() { return false; }
export function demoMetricTrend() { return []; }
export function demoLatest() { return null; }
export function demoArtifacts() { return []; }
export function demoReport() { return null; }
export const DEFAULT_USER = '00000000-0000-0000-0000-000000000001';
`);

const stubPlugin = {
  name: 'stub',
  setup(b) {
    b.onResolve({ filter: /(^|\/)supabase$/ }, () => ({ path: './bs-supabase-stub.mjs', external: true }));
    b.onResolve({ filter: /(^|\/)demo-data$/ }, () => ({ path: './bs-demo-stub.mjs', external: true }));
  },
};
async function bundle(entry, out) {
  await build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
    define: { 'import.meta.env': '{}' }, outfile: `${CACHE}/${out}`, plugins: [stubPlugin],
  });
  return import(`../${CACHE}/${out}`);
}

const SUB = await bundle('src/lib/blood-subset.ts', 'bs-subset.mjs');
const SM = await bundle('src/lib/standard-master.ts', 'bs-master.mjs');
const PERSIST = await bundle('src/lib/scan-persist.ts', 'bs-persist.mjs');
const QUERIES = await bundle('src/lib/measurement-queries.ts', 'bs-queries.mjs');
const ENT = await bundle('src/lib/elith-entitlement.ts', 'bs-entitlement.mjs');
const sbStub = await import(`../${CACHE}/bs-supabase-stub.mjs`);

const DERIVED = SUB.DERIVED_HC_BLOOD_IMPORTED_BY;
const UID = '7d49b0b2-1f33-4d4b-ae74-fc033cc81dd8';
const DATE = '2026-09-24';
const m = (name, value, unit = null, flag = null, ref_low = null, ref_high = null) => ({
  name, value: String(value),
  value_num: Number.isFinite(Number(value)) ? Number(value) : null,
  unit, ref_low, ref_high, flag,
});

/**
 * 本番の対象検体 (2026-09-24) と同じ中身。
 * 出典 `docs/scan/golden/scan_golden_healthcheckup_20250123.md`。
 * **総蛋白 / アルブミン / HbA1c / 尿素窒素 は今回=空なので行が無い。**
 */
const GOLDEN_11 = [
  m('白血球数', 45.2, '10^2/μL'), m('赤血球数', 471, '10^4/μL'), m('血色素量', 14.5, 'g/dL'),
  m('ヘマトクリット', 44.0, '%'), m('血小板数', 23.6, '10^4/μL'),
  m('AST(GOT)', 19, 'U/L', null, '13', '30'),
  m('ALT(GPT)', 20, 'U/L', null, '10', '42'),
  m('γ-GTP', 26, 'U/L', null, '13', '64'),
  m('ALP', 58, 'IU/L'),
  m('LDLコレステロール', 116, 'mg/dL', null, '70', '139'),
  m('LDLコレステロール(F式)', 102, 'mg/dL'),
  m('non-HDLコレステロール', 112, 'mg/dL'),
  m('HDLコレステロール', 83.2, 'mg/dL', null, '40', '96'),
  m('総コレステロール', 196, 'mg/dL', null, '142', '219'),
  m('空腹時中性脂肪', 54, 'mg/dL', null, '30', '149'),
  m('空腹時血糖', 104, 'mg/dL', 'H', '73', '99'),
  m('クレアチニン', 1.03, 'mg/dL', 'H', '0.65', '1.07'),
  m('eGFR', 56.9, 'mL/min', 'L', '60', null),
  m('尿酸', 7.8, 'mg/dL', 'H', '3.7', '7.0'),
  m('尿蛋白', '(-)'), m('尿潜血', '(-)'), m('尿糖', '(-)'),
  m('身長', 172.4, 'cm'), m('体重', 71.2, 'kg'), m('BMI', 24.0),
  m('最高血圧', 128, 'mmHg'), m('最低血圧', 82, 'mmHg'),
];
const EXPECTED_11 = {
  'GOT(AST)': 19, 'GPT(ALT)': 20, 'γ-GTP': 26,
  LDLコレステロール: 116, HDLコレステロール: 83.2, 総コレステロール: 196,
  中性脂肪: 54, 空腹時血糖: 104, クレアチニン: 1.03, eGFR: 56.9, 尿酸: 7.8,
};
const MISSING_4 = ['総蛋白', 'アルブミン', 'HbA1c(NGSP)', '尿素窒素'];

/* ══════════════════════════════════════════════════════════════════
   ① 標準マスタ — 統合で意味を壊していないこと
   ══════════════════════════════════════════════════════════════════ */
console.log('\n① 標準マスタ (裁定 Q-2 / M-2)');
{
  const c = (n) => SM.findByAlias(n)?.canonical_name ?? null;
  ok(c('空腹時中性脂肪') === '空腹時中性脂肪', '空腹時中性脂肪 は自分のまま', String(c('空腹時中性脂肪')));
  ok(c('随時中性脂肪') === '随時中性脂肪', '随時中性脂肪 は自分のまま', String(c('随時中性脂肪')));
  ok(c('中性脂肪') === '中性脂肪', '中性脂肪 は別項目として在る', String(c('中性脂肪')));
  ok(c('空腹時中性脂肪') !== c('中性脂肪') && c('随時中性脂肪') !== c('中性脂肪'),
    '**3 つが別々** (マスタで alias にしていない = HealthCheckupData 側を壊さない)');
  ok(c('アルブミン') === 'アルブミン' && c('Alb') === 'アルブミン', 'アルブミン / Alb が引ける');
  ok(c('尿素窒素') === '尿素窒素' && c('BUN') === '尿素窒素', '尿素窒素 / BUN が引ける');
  ok(c('e-GFR') === 'eGFR', 'e-GFR が eGFR に当たる');
  const unmapped = SUB.BLOOD_SUBSET_ITEMS.filter((n) => c(n) !== n);
  ok(unmapped.length === 0, '15 項目すべてが canonical_name として実在する', JSON.stringify(unmapped));
  ok(c('血糖') === null && c('随時血糖') === null,
    '**血糖 / 随時血糖 はマスタに無い** (空腹時血糖へ推測マッピングできない)');
  ok(c('総蛋白') === '総蛋白' && c('尿蛋白') === '尿蛋白' && c('総蛋白') !== c('尿蛋白'),
    '総蛋白 と 尿蛋白 は別物 (部分一致していない)');
}

/* ══════════════════════════════════════════════════════════════════
   ② 抽出 (純関数)
   ══════════════════════════════════════════════════════════════════ */
console.log('\n② 抽出 — 件数 0 / 1 / 11 / 15');
{
  ok(SUB.extractBloodSubset([]).kept.length === 0, '0 件: 空配列 → kept 0');
  ok(SUB.extractBloodSubset(null).kept.length === 0, '0 件: null でも落ちない');
  const imageOnly = SUB.extractBloodSubset([m('胸部X線', '所見なし'), m('眼圧', 16, 'mmHg'), m('身長', 170, 'cm')]);
  ok(imageOnly.kept.length === 0, '0 件: 15 項目が 1 つも無い紙 → kept 0', `skipped=${imageOnly.skipped}`);

  const one = SUB.extractBloodSubset([m('AST(GOT)', 19, 'U/L'), m('白血球数', 45.2)]);
  ok(one.kept.length === 1 && one.kept[0].name === 'GOT(AST)', '1 件: 1 項目でも作れる (件数の閾値が無い)');

  const g = SUB.extractBloodSubset(GOLDEN_11);
  ok(g.kept.length === 11, '**11 件: 本番 2026-09-24 と同じ検体で ちょうど 11 項目**', `n=${g.kept.length}`);
  const got = Object.fromEntries(g.kept.map((x) => [x.name, x.value_num]));
  for (const [k, v] of Object.entries(EXPECTED_11)) ok(got[k] === v, `   ${k} = ${v}`, `実測 ${got[k]}`);
  for (const miss of MISSING_4) ok(!(miss in got), `   **${miss} の行が無い** (0 補完しない)`);
  ok(g.kept.every((x) => x.value_num !== 0 || x.value === '0'), '0 補完の行が 1 件も無い');
  ok(g.kept.find((x) => x.name === '空腹時血糖')?.flag === 'H', '原本の flag(H) をそのまま運ぶ');
  ok(g.kept.find((x) => x.name === 'eGFR')?.ref_low === '60', '原本の基準値をそのまま運ぶ');
  ok(g.kept.find((x) => x.name === 'HDLコレステロール')?.unit === 'mg/dL', '原本の単位をそのまま運ぶ');
  ok(g.kept.map((x) => x.name).join(',') === SUB.BLOOD_SUBSET_ITEMS.filter((n) => n in EXPECTED_11).join(','),
    '並びは 15 項目マスタの順 (run ごとに揺れない)');
  // 元の配列を書き換えていない
  ok(GOLDEN_11.filter((x) => x.name === '空腹時中性脂肪').length === 1
     && !GOLDEN_11.some((x) => x.name === '中性脂肪'),
    '**入力の measurements を書き換えていない** (health_checkup 側は不変)',
    JSON.stringify(GOLDEN_11.map((x) => x.name).filter((n) => String(n).includes('中性脂肪'))));

  const all15 = SUB.BLOOD_SUBSET_ITEMS.map((n, i) => m(n, i + 1));
  const f = SUB.extractBloodSubset(all15);
  ok(f.kept.length === 15, '15 件: 全部そろった紙 → 15 項目', `n=${f.kept.length}`);
}

console.log('\n②-2 中性脂肪の統合 (裁定 Q-3)');
{
  for (const src of ['空腹時中性脂肪', '随時中性脂肪', '中性脂肪', '中性脂肪(TG)', 'TG', 'トリグリセライド']) {
    const r = SUB.extractBloodSubset([m(src, 221, 'mg/dL')]);
    ok(r.kept.length === 1 && r.kept[0].name === '中性脂肪' && r.kept[0].value_num === 221,
      `${src} → 中性脂肪 221`, r.kept[0]?.name ?? 'なし');
  }
  // 同日に空腹時と随時の**別値**が両方ある = 一意に確定できない → 中性脂肪だけ除外
  const both = SUB.extractBloodSubset([
    m('空腹時中性脂肪', 54, 'mg/dL'), m('随時中性脂肪', 221, 'mg/dL'), m('尿酸', 7.8, 'mg/dL'),
  ]);
  ok(!both.kept.some((x) => x.name === '中性脂肪'), '空腹時 54 と 随時 221 が両方 → **中性脂肪を作らない**');
  ok(both.excluded.some((e) => e.name === '中性脂肪' && e.reason === 'value_conflict'),
    '   除外理由が返る (黙って消さない)');
  ok(both.kept.some((x) => x.name === '尿酸'), '   **他の項目は通常どおり出る** (受診日ごと無効にしない)');
  // 同値なら 1 件に畳む
  const same = SUB.extractBloodSubset([m('空腹時中性脂肪', 54), m('中性脂肪(TG)', 54)]);
  ok(same.kept.length === 1 && same.kept[0].value_num === 54, '同値が別名で 2 件 → 1 件に畳む (競合にしない)');
}

console.log('\n②-3 推測しない (v1.1 §5 / 裁定 Q-12)');
{
  for (const bad of ['血糖', '随時血糖']) {
    const r = SUB.extractBloodSubset([m(bad, 79, 'mg/dL')]);
    ok(r.kept.length === 0, `**${bad} 79 → 空腹時血糖にしない**`, JSON.stringify(r.kept.map((x) => x.name)));
  }
  const cr = SUB.extractBloodSubset([m('クレアチニン', 1.03, 'mg/dL')]);
  ok(cr.kept.length === 1 && !cr.kept.some((x) => x.name === 'eGFR'),
    '**クレアチニンだけ → eGFR を計算しない**');
  const tc = SUB.extractBloodSubset([m('LDLコレステロール', 116), m('HDLコレステロール', 83.2), m('空腹時中性脂肪', 54)]);
  ok(!tc.kept.some((x) => x.name === '総コレステロール'),
    '**LDL/HDL/TG だけ → 総コレステロールを計算しない**');
  const conflict = SUB.extractBloodSubset([m('尿酸', 5.9), m('UA', 7.2), m('AST(GOT)', 19)]);
  ok(!conflict.kept.some((x) => x.name === '尿酸'), '尿酸 5.9 と UA 7.2 の競合 → 尿酸だけ除外');
  ok(conflict.kept.length === 1 && conflict.kept[0].name === 'GOT(AST)', '   他の 1 項目は出る');
  const blank = SUB.extractBloodSubset([
    { name: '総蛋白', value: null, value_num: null }, { name: 'アルブミン', value: '', value_num: null },
    { name: '', value: '7.0' }, m('尿酸', 7.8),
  ]);
  ok(blank.kept.length === 1 && blank.kept[0].name === '尿酸', '値の無い行・名前の無い行は対象にしない');
  ok(!SUB.BLOOD_SUBSET_ITEMS.includes('随時血糖') && !SUB.BLOOD_SUBSET_ITEMS.includes('血糖'),
    '**15 項目マスタに 随時血糖 / 血糖 を足していない**');
  ok(SUB.BLOOD_SUBSET_ITEMS.length === 15, '15 項目マスタはちょうど 15 件', String(SUB.BLOOD_SUBSET_ITEMS.length));
}

/* ══════════════════════════════════════════════════════════════════
   ③ 保存 (persistDerivedBloodArtifact)
   ══════════════════════════════════════════════════════════════════ */
console.log('\n③ 保存 — 列 / 冪等 / health_checkup 不変');
const HC_ROW = {
  id: 'hc-1', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: DATE,
  source: 'user_upload', status: 'active', imported_by: 'user', scan_md: '## 原文',
  measurements: GOLDEN_11,
};
{
  const db = makeDb({ test_artifacts: [{ ...HC_ROW }] });
  sbStub.__setStub(db);
  const r = await PERSIST.persistDerivedBloodArtifact(db, {
    diagnosticUserId: UID, testDate: DATE, sourceMeasurements: GOLDEN_11,
  });
  ok(r.created === true, '派生 artifact を作った', JSON.stringify(r.reason ?? ''));
  ok(r.rows === 11, 'measurement_values が 11 件', String(r.rows));
  const art = db.tables.test_artifacts.filter((a) => a.test_type === 'blood');
  ok(art.length === 1, 'blood artifact は 1 件', String(art.length));
  ok(art[0].source === 'user_upload', "source = 'user_upload'", String(art[0].source));
  ok(art[0].test_type === 'blood', "test_type = 'blood'");
  ok(art[0].imported_by === DERIVED, `imported_by = '${DERIVED}'`, String(art[0].imported_by));
  ok(art[0].status === 'active', "status = 'active'");
  ok(art[0].test_date === DATE, `test_date = ${DATE}`);
  ok(art[0].scan_md == null, 'scan_md は入れない (原文を二重に持たない)');
  ok(art[0].lab_name == null, 'lab_name は null (検査機関ではない)');

  const mv = db.tables.measurement_values;
  ok(mv.length === 11, 'measurement_values = 11 行', String(mv.length));
  ok(mv.every((x) => x.test_type === 'blood'), "全行 test_type='blood'");
  ok(mv.every((x) => x.source_file_kind === 'scan_md'), "全行 source_file_kind='scan_md'");
  ok(mv.every((x) => x.canonical_name === x.item_name), '全行 canonical_name が付く (= デメカルと同じ系列に乗る)',
    JSON.stringify(mv.filter((x) => !x.canonical_name).map((x) => x.item_name)));
  ok(mv.filter((x) => x.value_num === 0).length === 0, '**value_num=0 の補完行が 0 件**');
  for (const miss of MISSING_4) ok(!mv.some((x) => x.item_name === miss), `   ${miss} の行が 0 件`);

  const hc = db.tables.test_artifacts.find((a) => a.id === 'hc-1');
  ok(hc && hc.status === 'active' && hc.scan_md === '## 原文' && hc.measurements === GOLDEN_11,
    '**元の health_checkup は id / status / scan_md / measurements とも不変**');
  ok(hc.measurements.some((x) => x.name === '空腹時中性脂肪'),
    '   health_checkup 側の 空腹時中性脂肪 は名前のまま (中性脂肪 に書き換えない)');

  // 冪等: 2 回流しても増えない
  await PERSIST.persistDerivedBloodArtifact(db, { diagnosticUserId: UID, testDate: DATE, sourceMeasurements: GOLDEN_11 });
  await PERSIST.persistDerivedBloodArtifact(db, { diagnosticUserId: UID, testDate: DATE, sourceMeasurements: GOLDEN_11 });
  ok(db.tables.test_artifacts.filter((a) => a.test_type === 'blood').length === 1,
    '**3 回流しても blood artifact は 1 件** (冪等)',
    String(db.tables.test_artifacts.filter((a) => a.test_type === 'blood').length));
  ok(db.tables.measurement_values.length === 11, '   measurement_values も 11 件のまま', String(db.tables.measurement_values.length));
}

console.log('\n③-1b 冪等キーが派生以外を巻き込まない (裁定 Q-4 と同じ理由)');
{
  /*
   * **`source='user_upload'` は他の経路と共有する。**
   * 将来「利用者が血液検査の紙をスキャンする」経路ができたとき、その回が同じ受診日に
   * 在るのに `imported_by` で絞らないと、派生の差し替えが**その行ごと消す**
   * (`measurement_values` は on delete cascade なので測定値も道連れになる)。
   *
   * active な行なら `findNormalBloodOnDate` が先に止めるが、**差し替え前・取り下げ後の行
   * (superseded / withdrawn) はそこを通らない**ので、冪等キー側で守るしかない。
   */
  const db = makeDb({
    test_artifacts: [
      { ...HC_ROW },
      { id: 'u-sup', diagnostic_user_id: UID, test_type: 'blood', test_date: DATE, source: 'user_upload', status: 'superseded', imported_by: 'user' },
      { id: 'u-wd', diagnostic_user_id: UID, test_type: 'blood', test_date: DATE, source: 'user_upload', status: 'withdrawn', imported_by: 'user' },
      { id: 'lab-sup', diagnostic_user_id: UID, test_type: 'blood', test_date: DATE, source: 'wellfort_lab', status: 'superseded', imported_by: 'wellfort_admin_upload' },
    ],
    measurement_values: [
      { artifact_id: 'u-sup', diagnostic_user_id: UID, test_type: 'blood', test_date: DATE, seq: 0, item_name: '尿酸', canonical_name: '尿酸', value: '6.0', value_num: 6.0 },
      { artifact_id: 'u-wd', diagnostic_user_id: UID, test_type: 'blood', test_date: DATE, seq: 0, item_name: '尿酸', canonical_name: '尿酸', value: '6.1', value_num: 6.1 },
    ],
  });
  sbStub.__setStub(db);
  const r = await PERSIST.persistDerivedBloodArtifact(db, {
    diagnosticUserId: UID, testDate: DATE, sourceMeasurements: GOLDEN_11,
  });
  ok(r.created === true, 'active な通常 blood が無いので派生は作られる', JSON.stringify(r.reason ?? ''));
  ok(db.tables.test_artifacts.some((a) => a.id === 'u-sup'),
    "**superseded の user_upload blood (imported_by='user') を消していない**");
  ok(db.tables.test_artifacts.some((a) => a.id === 'u-wd'),
    "**withdrawn の user_upload blood を消していない**");
  ok(db.tables.test_artifacts.some((a) => a.id === 'lab-sup'), 'superseded の検査機関 blood も消していない');
  ok(db.tables.measurement_values.some((x) => x.artifact_id === 'u-sup'),
    '   その回の測定値も cascade で消えていない');
  ok(db.tables.measurement_values.some((x) => x.artifact_id === 'u-wd'),
    '   withdrawn 側の測定値も残っている');
}

console.log('\n③-2 0 件なら何も作らない (裁定 Q-6)');
{
  const db = makeDb({ test_artifacts: [{ ...HC_ROW, measurements: [m('胸部X線', '所見なし')] }] });
  sbStub.__setStub(db);
  const r = await PERSIST.persistDerivedBloodArtifact(db, {
    diagnosticUserId: UID, testDate: DATE, sourceMeasurements: [m('胸部X線', '所見なし')],
  });
  ok(r.created === false && r.reason === 'no_items', "created:false / reason:'no_items'", JSON.stringify(r.reason));
  ok(db.tables.test_artifacts.filter((a) => a.test_type === 'blood').length === 0, '**blood artifact を 1 件も作らない**');
  ok(db.tables.measurement_values.length === 0, 'measurement_values も 0 件');
  ok(db.tables.test_artifacts.find((a) => a.id === 'hc-1').status === 'active', 'health_checkup は通常どおり残る');
}

console.log('\n③-3 同日に通常 blood が在れば作らない (裁定 Q-10 / D-5)');
{
  const normal = {
    id: 'blood-normal', diagnostic_user_id: UID, test_type: 'blood', test_date: DATE,
    source: 'wellfort_lab', status: 'active', imported_by: 'wellfort_admin_upload',
  };
  const db = makeDb({ test_artifacts: [{ ...HC_ROW }, normal] });
  sbStub.__setStub(db);
  const r = await PERSIST.persistDerivedBloodArtifact(db, {
    diagnosticUserId: UID, testDate: DATE, sourceMeasurements: GOLDEN_11,
  });
  ok(r.created === false && r.reason === 'normal_blood_exists',
    "created:false / reason:'normal_blood_exists'", JSON.stringify(r.reason));
  ok(typeof r.detail === 'string' && r.detail.length > 0, '理由が呼び出し元へ返る (黙らせない)');
  ok(db.tables.test_artifacts.filter((a) => a.test_type === 'blood').length === 1, 'blood artifact は通常の 1 件だけ');
  ok(db.tables.test_artifacts.find((a) => a.id === 'blood-normal').status === 'active',
    '**通常 blood は無傷** (status も触っていない)');
  ok(db.tables.measurement_values.length === 0, '派生の測定値は書かれていない');

  // 別の日なら作る (同日優先は「その日だけ」)
  const db2 = makeDb({ test_artifacts: [{ ...HC_ROW }, { ...normal, test_date: '2026-01-10' }] });
  sbStub.__setStub(db2);
  const r2 = await PERSIST.persistDerivedBloodArtifact(db2, { diagnosticUserId: UID, testDate: DATE, sourceMeasurements: GOLDEN_11 });
  ok(r2.created === true, '別の日の通常 blood は邪魔しない');
}

console.log('\n③-4 通常 blood が後から届いたら派生を降ろす (裁定 Q-10 / O-2)');
{
  const db = makeDb({
    test_artifacts: [
      { ...HC_ROW },
      { id: 'd1', diagnostic_user_id: UID, test_type: 'blood', test_date: DATE, source: 'user_upload', status: 'active', imported_by: DERIVED },
      { id: 'n1', diagnostic_user_id: UID, test_type: 'blood', test_date: DATE, source: 'wellfort_lab', status: 'active', imported_by: 'wellfort_admin_upload' },
      { id: 'd-other', diagnostic_user_id: UID, test_type: 'blood', test_date: '2026-03-01', source: 'user_upload', status: 'active', imported_by: DERIVED },
    ],
  });
  sbStub.__setStub(db);
  const r = await PERSIST.supersedeDerivedBloodOnSameDate(db, UID, DATE);
  ok(r.superseded === 1, '同日の派生 1 件を降ろした', String(r.superseded));
  ok(db.tables.test_artifacts.find((a) => a.id === 'd1').status === 'superseded', "派生が 'superseded' (削除ではない)");
  ok(db.tables.test_artifacts.some((a) => a.id === 'd1'), '**行は残っている** (監査のため消さない)');
  ok(db.tables.test_artifacts.find((a) => a.id === 'n1').status === 'active', '**通常 blood には触っていない**');
  ok(db.tables.test_artifacts.find((a) => a.id === 'd-other').status === 'active', '別の日の派生には触っていない');
  ok(db.tables.test_artifacts.find((a) => a.id === 'hc-1').status === 'active', 'health_checkup には触っていない');
}

/* ══════════════════════════════════════════════════════════════════
   ④ 新規スキャン保存から自動で作られる (発注者指示 §11)
   ══════════════════════════════════════════════════════════════════ */
console.log('\n④ saveScanResult の後段で自動生成される');
const MD = `## 血液検査

| No | 検査項目 | 検査項目詳細 | 読み取った値 | 単位 | 下限値 | 上限値 | 判定 | 備考 |
|----|----------|--------------|--------------|------|--------|--------|------|------|
| 1 | AST | AST(GOT) | 19 | U/L | 13 | 30 | - | - |
| 2 | ALT | ALT(GPT) | 20 | U/L | 10 | 42 | - | - |
| 3 | γ-GTP | γ-GTP | 26 | U/L | 13 | 64 | - | - |
| 4 | 中性脂肪 | 空腹時中性脂肪 | 54 | mg/dL | 30 | 149 | - | - |
| 5 | 血糖 | 空腹時血糖 | 104 | mg/dL | 73 | 99 | H | - |
| 6 | 白血球数 | 白血球数 | 45.2 | 10^2/μL | 33 | 86 | - | - |
`;
{
  const db = makeDb();
  sbStub.__setStub(db);
  const r = await PERSIST.saveScanResult(db, { diagnosticUserId: UID, markdownClean: MD, examDate: DATE });
  ok(r.artifactId != null, 'health_checkup が保存された');
  ok(r.derivedBlood?.created === true, '**派生 blood が自動で作られた**', JSON.stringify(r.derivedBlood?.reason ?? ''));
  const names = (r.derivedBlood?.items ?? []).join(',');
  ok(names === 'GOT(AST),GPT(ALT),γ-GTP,中性脂肪,空腹時血糖', '抽出は 5 項目・TG は統合済み', names);
  const blood = db.tables.test_artifacts.filter((a) => a.test_type === 'blood');
  ok(blood.length === 1 && blood[0].imported_by === DERIVED, 'blood artifact が 1 件・marker 付き');
  ok(db.tables.measurement_values.filter((x) => x.test_type === 'blood').length === 5, "blood の測定値 5 行");
  ok(db.tables.measurement_values.filter((x) => x.test_type === 'health_checkup').length === 6,
    'health_checkup の測定値 6 行は**そのまま**',
    String(db.tables.measurement_values.filter((x) => x.test_type === 'health_checkup').length));
  ok(db.tables.measurement_values.some((x) => x.test_type === 'health_checkup' && x.item_name === '空腹時中性脂肪'),
    '**health_checkup 側は 空腹時中性脂肪 のまま** (派生だけが 中性脂肪)');
  ok(db.tables.measurement_values.some((x) => x.test_type === 'blood' && x.item_name === '中性脂肪'), '派生側は 中性脂肪');

  // 同じ回を再送 → 増えない
  await PERSIST.saveScanResult(db, { diagnosticUserId: UID, markdownClean: MD, examDate: DATE });
  ok(db.tables.test_artifacts.filter((a) => a.test_type === 'blood').length === 1,
    '再送しても blood artifact は 1 件', String(db.tables.test_artifacts.filter((a) => a.test_type === 'blood').length));
  ok(db.tables.test_artifacts.filter((a) => a.test_type === 'health_checkup').length === 1,
    '再送しても health_checkup も 1 件');
}

console.log('\n④-2 admin バッチは派生を作らない (裁定 Q-13)');
{
  const db = makeDb();
  sbStub.__setStub(db);
  const r = await PERSIST.persistAdminBatchArtifact({
    diagnosticUserId: UID, testType: 'health_checkup', markdownClean: MD,
    measurements: GOLDEN_11, testDate: DATE,
  });
  ok(r.artifactId != null, 'admin バッチの health_checkup は保存される');
  ok(db.tables.test_artifacts.filter((a) => a.test_type === 'blood').length === 0,
    '**admin バッチからは派生 blood が作られない** (今回の対象外)',
    String(db.tables.test_artifacts.filter((a) => a.test_type === 'blood').length));
}

/* ══════════════════════════════════════════════════════════════════
   ⑤ Elith readiness (裁定 Q-4 / D-1)
   ══════════════════════════════════════════════════════════════════ */
console.log('\n⑤ Elith readiness から派生を外す');
{
  const C = ENT.countsTowardReadiness;
  ok(C({ test_type: 'blood', imported_by: DERIVED }) === false, '**派生 blood は数えない**');
  ok(C({ test_type: 'blood', imported_by: 'wellfort_admin_upload' }) === true, 'デメカル由来の blood は数える');
  ok(C({ test_type: 'blood', imported_by: 'user' }) === true,
    '**source=user_upload の「将来の実血液 user upload」は数える** (source で除外していない)');
  ok(C({ test_type: 'blood', imported_by: 'admin' }) === true, 'admin バッチの blood は数える');
  ok(C({ test_type: 'blood', imported_by: null }) === true, 'imported_by が無い blood は数える');
  ok(C({ test_type: 'blood', imported_by: `${DERIVED}_x` }) === true, '前方一致では外さない (完全一致 1 本)');
  ok(C({ test_type: 'blood', imported_by: `x_${DERIVED}` }) === true, '部分一致では外さない');
  for (const t of ['health_checkup', 'cancer_urine', 'genetics', 'ai_prediction']) {
    ok(C({ test_type: t, imported_by: DERIVED }) === true, `**${t} の判定は 1 文字も変わらない**`);
  }
  ok(ENT.decideReady(['BloodTestData'], new Set([]), false).ready === false,
    'blood が無ければ ready:false');
  ok(ENT.decideReady(['BloodTestData'], new Set(['blood']), false).ready === true,
    '通常 blood が在れば ready:true (納品側は壊していない)');
  const missing = ENT.decideReady(['BloodTestData'], new Set([]), false).missing;
  ok(Array.isArray(missing) && missing.includes('BloodTestData'), 'missing に BloodTestData が入る', JSON.stringify(missing));
}

/* ══════════════════════════════════════════════════════════════════
   ⑥ 推移グラフ (発注者指示 §9 / 裁定 Q-5・D-4)
   ══════════════════════════════════════════════════════════════════ */
console.log('\n⑥ 推移グラフ — 由来表示 / 混在系列の基準線');
const mvRow = (artifact_id, test_date, seq, item_name, value_num, ref_high_num = null, ref_low_num = null) => ({
  artifact_id, diagnostic_user_id: UID, test_type: 'blood', test_date, seq,
  item_name, canonical_name: item_name, value: String(value_num), value_num,
  unit: 'mg/dL', ref_low: null, ref_high: null, ref_low_num, ref_high_num, flag: null,
  assessment: null, source_file_kind: 'raw_csv',
});
{
  /** デメカル 3 回 (ref 無し) + 派生 1 件を**最新**に置く。
   *  ⚠ 派生を途中の日付に置くと、基準値は系列の最後の行から取るので
   *     抑止を外しても検査が緑のまま通る。だから最新に置く。 */
  const db = makeDb({
    test_artifacts: [
      { id: 'n1', diagnostic_user_id: UID, test_type: 'blood', test_date: '2026-01-10', status: 'active', imported_by: 'wellfort_admin_upload' },
      { id: 'n2', diagnostic_user_id: UID, test_type: 'blood', test_date: '2026-04-10', status: 'active', imported_by: 'wellfort_admin_upload' },
      { id: 'n3', diagnostic_user_id: UID, test_type: 'blood', test_date: '2026-07-10', status: 'active', imported_by: 'wellfort_admin_upload' },
      { id: 'd1', diagnostic_user_id: UID, test_type: 'blood', test_date: DATE, status: 'active', imported_by: DERIVED },
    ],
    measurement_values: [
      mvRow('n1', '2026-01-10', 0, '尿酸', 6.1), mvRow('n2', '2026-04-10', 0, '尿酸', 6.5),
      mvRow('n3', '2026-07-10', 0, '尿酸', 7.0), mvRow('d1', DATE, 0, '尿酸', 7.8, 7.0, 3.7),
    ],
  });
  sbStub.__setStub(db);
  const cand = await QUERIES.getTrendCandidates(UID, 'blood');
  ok(cand.includes('尿酸'), '候補に 尿酸 が出る (4 回ぶん = 線が引ける)', JSON.stringify(cand));
  const s = await QUERIES.getMeasurementTrend(UID, ['尿酸'], 12, 'blood');
  ok(s.length === 1 && s[0].points.length === 4, '1 系列 4 点', `len=${s.length} pts=${s[0]?.points.length}`);
  ok(s[0].points.map((p) => p.value).join(',') === '6.1,6.5,7,7.8', '値が日付昇順', s[0].points.map((p) => p.value).join(','));
  const derivedPts = s[0].points.filter((p) => p.source === 'health_checkup_scan');
  ok(derivedPts.length === 1 && derivedPts[0].date === DATE,
    `**${DATE} の点にだけ source='health_checkup_scan' が付く**`, JSON.stringify(s[0].points.map((p) => p.source ?? '-')));
  ok(s[0].points.filter((p) => p.source == null).length === 3, '通常 3 点には付かない');
  ok(s[0].referenceUpper === undefined && s[0].referenceLower === undefined,
    '**混在系列では基準線を出さない** (裁定 D-4)', `up=${s[0].referenceUpper} lo=${s[0].referenceLower}`);

  // 派生だけの系列 → 従来どおり基準値を出す
  const db2 = makeDb({
    test_artifacts: [
      { id: 'd1', diagnostic_user_id: UID, test_type: 'blood', test_date: '2025-09-24', status: 'active', imported_by: DERIVED },
      { id: 'd2', diagnostic_user_id: UID, test_type: 'blood', test_date: DATE, status: 'active', imported_by: DERIVED },
    ],
    measurement_values: [mvRow('d1', '2025-09-24', 0, '尿酸', 7.2, 7.0, 3.7), mvRow('d2', DATE, 0, '尿酸', 7.8, 7.0, 3.7)],
  });
  sbStub.__setStub(db2);
  const s2 = await QUERIES.getMeasurementTrend(UID, ['尿酸'], 12, 'blood');
  ok(s2[0]?.referenceUpper === 7.0, '派生だけの系列は基準線を出す (従来どおり)', String(s2[0]?.referenceUpper));
  ok(s2[0]?.points.every((p) => p.source === 'health_checkup_scan'), '2 点とも派生の印が付く');

  // superseded は点にならない
  const db3 = makeDb({
    test_artifacts: [
      { id: 'n1', diagnostic_user_id: UID, test_type: 'blood', test_date: '2026-01-10', status: 'active', imported_by: 'wellfort_admin_upload' },
      { id: 'd1', diagnostic_user_id: UID, test_type: 'blood', test_date: DATE, status: 'superseded', imported_by: DERIVED },
    ],
    measurement_values: [mvRow('n1', '2026-01-10', 0, '尿酸', 6.1), mvRow('d1', DATE, 0, '尿酸', 7.8, 7.0)],
  });
  sbStub.__setStub(db3);
  const s3 = await QUERIES.getMeasurementTrend(UID, ['尿酸'], 12, 'blood');
  ok((s3[0]?.points.length ?? 0) === 1, 'superseded の派生は点にならない', String(s3[0]?.points.length));

  // health_checkup 側のグラフは派生に汚染されない
  const db4 = makeDb({
    test_artifacts: [
      { id: 'hc1', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: '2025-09-24', status: 'active', imported_by: 'user' },
      { id: 'hc2', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: DATE, status: 'active', imported_by: 'user' },
      { id: 'd1', diagnostic_user_id: UID, test_type: 'blood', test_date: DATE, status: 'active', imported_by: DERIVED },
    ],
    measurement_values: [
      { ...mvRow('hc1', '2025-09-24', 0, '空腹時中性脂肪', 60), test_type: 'health_checkup' },
      { ...mvRow('hc2', DATE, 0, '空腹時中性脂肪', 54), test_type: 'health_checkup' },
      mvRow('d1', DATE, 0, '中性脂肪', 54),
    ],
  });
  sbStub.__setStub(db4);
  const hcS = await QUERIES.getMeasurementTrend(UID, ['空腹時中性脂肪', '中性脂肪'], 12, 'health_checkup');
  ok(hcS.length === 1 && hcS[0].label === '空腹時中性脂肪' && hcS[0].points.length === 2,
    '**health_checkup のグラフは 空腹時中性脂肪 のまま 2 点** (派生が混ざらない)',
    JSON.stringify(hcS.map((x) => [x.label, x.points.length])));
  ok(hcS[0].points.every((p) => p.source == null), 'health_checkup の点に派生の印は付かない');
}

console.log('\n⑦ マスタ追加で既存系列が割れないこと (塩分と同型の退行)');
{
  /*
   * `canonical_name` は**書き込み時点で確定する**ので、マスタに 中性脂肪 / 尿素窒素 /
   * e-GFR を足しても**既存行には遡って付かない**。古い行 (canonical null・item_name が
   * `中性脂肪(TG)` 等) と新しい行 (canonical が付く) が**別系列に割れる**と、
   * **線は 1 本描かれるので画面はエラーを出さないまま点が減る。**
   */
  const pair = (name, canon, date, v, art) => ({
    artifact_id: art, diagnostic_user_id: UID, test_type: 'health_checkup', test_date: date, seq: 0,
    item_name: name, canonical_name: canon, value: String(v), value_num: v, unit: 'mg/dL',
    ref_low: null, ref_high: null, ref_low_num: null, ref_high_num: null, flag: null,
    assessment: null, source_file_kind: 'scan_md',
  });
  const cases = [
    ['中性脂肪(TG)', '中性脂肪'], ['TG', '中性脂肪'], ['e-GFR', 'eGFR'],
    ['BUN', '尿素窒素'], ['Alb', 'アルブミン'],
  ];
  for (const [oldName, target] of cases) {
    const db = makeDb({
      test_artifacts: [
        { id: 'a-old', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: '2025-09-24', status: 'active', imported_by: 'user' },
        { id: 'a-new', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: DATE, status: 'active', imported_by: 'user' },
      ],
      measurement_values: [
        pair(oldName, null, '2025-09-24', 120, 'a-old'),   // マスタ追加前に書かれた行
        pair(target, target, DATE, 130, 'a-new'),          // 追加後に書かれた行
      ],
    });
    sbStub.__setStub(db);
    const sr = await QUERIES.getMeasurementTrend(UID, [target], 12, 'health_checkup');
    ok(sr.length === 1 && sr[0].points.length === 2,
      `${oldName} (旧) と ${target} (新) が **1 系列 2 点**になる`,
      `系列=${sr.length} 点=${sr[0]?.points.length ?? 0}`);
    const cand = await QUERIES.getTrendCandidates(UID, 'health_checkup');
    ok(cand.length === 1 && cand[0] === target, `   候補も 1 件 (${target})`, JSON.stringify(cand));
  }
  // 空腹時/随時 は寄せない (裁定 Q-3)
  const db2 = makeDb({
    test_artifacts: [
      { id: 'b1', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: '2025-09-24', status: 'active', imported_by: 'user' },
      { id: 'b2', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: DATE, status: 'active', imported_by: 'user' },
    ],
    measurement_values: [
      pair('空腹時中性脂肪', '空腹時中性脂肪', '2025-09-24', 54, 'b1'),
      pair('随時中性脂肪', '随時中性脂肪', DATE, 221, 'b2'),
    ],
  });
  sbStub.__setStub(db2);
  const mixed = await QUERIES.getMeasurementTrend(UID, ['中性脂肪', '空腹時中性脂肪', '随時中性脂肪'], 12, 'health_checkup');
  ok(!mixed.some((x) => x.label === '中性脂肪'),
    '**空腹時/随時 を読み出しで 中性脂肪 に潰していない** (裁定 Q-3)',
    JSON.stringify(mixed.map((x) => x.label)));
  ok(mixed.length === 2, '   空腹時 / 随時 は 2 系列のまま', String(mixed.length));
}

/* ── 結果 ────────────────────────────────────────────────────────── */
console.log(`\n${'='.repeat(60)}\nPASS ${pass} / FAIL ${fails.length}`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
console.log('すべて通りました。');
