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
import { writeFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
      maybeSingle() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
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
/*
 * 追加検査経路 (`special-additional-tests.ts`) と backfill の API を**実際に動かす**ための
 * スタブ。どちらも AWS SDK を間接に引くので、原本まわりの 2 モジュールは差し替える。
 * **認可は通す** — 検査したいのは認可ではなく mode の扱い (認可は `verify:intake-scope` 等が見る)。
 */
writeFileSync(`${CACHE}/bs-orig-stub.mjs`, `export function readUploadedOriginal() { return Promise.resolve({ ok: false, error: 'stub' }); }
export const MAX_ORIGINAL_BYTES = 50 * 1024 * 1024;
export const PRESIGN_EXPIRES_SEC = 900;
export function isSha256Base64() { return true; }
export function signOriginalPut() { return Promise.resolve(null); }
`);
writeFileSync(`${CACHE}/bs-ost-stub.mjs`, `import { createHash } from 'node:crypto';
export function getOriginalsS3Config() { return null; }
export function putOriginal() { return Promise.resolve(null); }
export function signedOriginalUrl() { return Promise.resolve(null); }
export function getOriginalSignedUrl() { return Promise.resolve(null); }
// **本物と同じ計算**にする (指紋の比較を伴う経路を通すため)。
export function sha256Hex(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
`);
writeFileSync(`${CACHE}/bs-special-stub.mjs`, `export let _special = true;
export function __setSpecial(v) { _special = v; }
export function isSpecialAccount() { return _special; }
export function listSpecialAccounts() { return { rows: [], emails: [], configRaw: '', emailsRaw: '', deniedRaw: '', dobRaw: '' }; }
export function specialSubjectByUid() { return null; }
export function linkSpecialEmail() { return null; }
`);
writeFileSync(`${CACHE}/bs-auth-stub.mjs`, `export function checkAdminAuth() { return { ok: true }; }
export function isAdminAuthorized() { return true; }
export function adminApiKey() { return 'stub'; }
`);

/*
 * S3 のスタブ。**AWS SDK は ESM へバンドルできない** (`Dynamic require of "buffer"`) ので、
 * `elith-delivery.ts` を動かすには差し替えが要る。
 * 書こうとしたキーを記録するだけ — **検査では「何を書こうとしたか」こそが見たいもの**。
 */
writeFileSync(`${CACHE}/bs-s3-stub.mjs`, `
/*
 * **インメモリの S3。** put したものが list / get で読めるので、
 * materialize → inventory → assemble の**通し**がこの中だけで回る。
 * (最初は put を記録するだけのスタブにしていたが、それでは
 *  \`buildDeliveryPlan\` が body を読めずに落ち、**検査が空振り**していた。)
 */
export const _written = [];
export const _store = new Map();
export function __reset() { _written.length = 0; _store.clear(); }
export function __seed(key, body) { _store.set(key, body); }
function keep(files) {
  for (const f of files ?? []) {
    _written.push(f.key);
    const b = f.body;
    _store.set(f.key, typeof b === 'string' ? b : new TextDecoder().decode(b));
  }
}
export function putFiles(files) { keep(files); return Promise.resolve((files ?? []).map((f) => ({ key: f.key, ok: true }))); }
export function putVerified(files) { keep(files); return Promise.resolve((files ?? []).map((f) => ({ key: f.key, verified: true }))); }
export function unverified(rs) { return (rs ?? []).filter((r) => !r.verified); }
export function getS3Config() { return { bucket: 'stub', prefix: '', region: 'ap-northeast-1' }; }
export function isS3Configured() { return true; }
export function listObjects(prefix) {
  const out = [];
  for (const k of _store.keys()) if (!prefix || k.startsWith(prefix)) out.push({ key: k, size: 100 });
  return Promise.resolve(out);
}
export function getObjectText(key) { return Promise.resolve(_store.has(key) ? _store.get(key) : null); }
export function makeS3Client() { return null; }
`);
writeFileSync(`${CACHE}/bs-demo-stub.mjs`, `export function demoFallbackEnabled() { return false; }
export function demoMetricTrend() { return []; }
export function demoLatest() { return null; }
export function demoArtifacts() { return []; }
export function demoReport() { return null; }
export function buildDemoDashboard() { return null; }
export function buildDemoNotices() { return []; }
export function demoUnreadImportant() { return 0; }
export const DEFAULT_USER = '00000000-0000-0000-0000-000000000001';
`);

const stubPlugin = {
  name: 'stub',
  setup(b) {
    /*
     * **差し替えるのは自分のコード (`src/`) からの import だけ。**
     * node_modules の中にも `./s3` のような相対 import が在り、巻き込むと
     * 別物のスタブが当たって壊れる (実際に `DOT_PATTERN` で踏んだ)。
     */
    const ours = (a) => a.importer.includes('/src/');
    const rel = (n) => new RegExp('^\\.{1,2}/(?:.*/)?' + n + '$');
    const sub = (n, to) => b.onResolve({ filter: rel(n) }, (a) => (ours(a) ? { path: to, external: true } : undefined));
    sub('supabase', './bs-supabase-stub.mjs');
    sub('demo-data', './bs-demo-stub.mjs');
    sub('s3', './bs-s3-stub.mjs');
    sub('s3-verified-put', './bs-s3-stub.mjs');
    sub('originals-upload-ticket', './bs-orig-stub.mjs');
    sub('originals-storage', './bs-ost-stub.mjs');
    sub('api-auth', './bs-auth-stub.mjs');
    sub('special-accounts', './bs-special-stub.mjs');
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
const DELIVERY = await bundle('src/lib/elith-delivery.ts', 'bs-delivery.mjs');
const SAT = await bundle('src/lib/special-additional-tests.ts', 'bs-sat.mjs');
const BACKFILL = await bundle('src/pages/api/admin/derived-blood/backfill.ts', 'bs-backfill.mjs');
const DASH = await bundle('src/lib/dashboard-queries.ts', 'bs-dash.mjs');
const MANUAL = await bundle('src/lib/elith-manual-delivery.ts', 'bs-manual.mjs');
const ASSEMBLE = await bundle('src/lib/elith-assemble.ts', 'bs-assemble.mjs');
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
  const at = (id) => db.tables.test_artifacts.find((a) => a.id === id);
  ok(db.tables.test_artifacts.some((a) => a.id === 'd1'),
    '**行は残っている** (監査のため消さない)', at('d1') ? 'あり' : '**消えている**');
  ok(at('d1')?.status === 'superseded', "派生が 'superseded' (削除ではない)", String(at('d1')?.status));
  ok(at('n1')?.status === 'active', '**通常 blood には触っていない**', String(at('n1')?.status));
  ok(at('d-other')?.status === 'active', '別の日の派生には触っていない', String(at('d-other')?.status));
  ok(at('hc-1')?.status === 'active', 'health_checkup には触っていない', String(at('hc-1')?.status));
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

/* ══════════════════════════════════════════════════════════════════
   ⑧ 【最上位ルール】派生 blood は Elith の入力にならない
      発注者指示 2026-10-03 §0 / §15 / §16 / §18(9〜15)
   ══════════════════════════════════════════════════════════════════ */
console.log('\n⑧-1 判定そのもの (isDerivedHealthcheckBlood)');
{
  const D = SUB.isDerivedHealthcheckBlood;
  ok(D({ test_type: 'blood', imported_by: DERIVED }) === true, '派生 blood = true');
  ok(D({ test_type: 'blood', imported_by: 'wellfort_admin_upload' }) === false, 'デメカル由来 = false');
  ok(D({ test_type: 'blood', imported_by: 'user' }) === false, '**将来の実血液 user upload = false** (source で見ていない)');
  ok(D({ test_type: 'blood', imported_by: 'admin' }) === false, 'admin バッチ = false');
  ok(D({ test_type: 'blood', imported_by: null }) === false, 'imported_by 無し = false');
  ok(D({ test_type: 'blood', imported_by: `${DERIVED}_x` }) === false, '前方一致では true にしない');
  ok(D({ test_type: 'blood', imported_by: ` ${DERIVED}` }) === false, '前後に空白が付いたら true にしない (完全一致)');
  for (const t of ['health_checkup', 'cancer_urine', 'genetics', 'ai_prediction']) {
    ok(D({ test_type: t, imported_by: DERIVED }) === false, `**${t} では常に false** (他種別の判定を変えない)`);
  }
  ok(D(null) === false && D(undefined) === false, 'null / undefined で落ちない');
  ok(typeof SUB.DERIVED_HC_BLOOD_ELITH_BLOCK === 'string' && SUB.DERIVED_HC_BLOOD_ELITH_BLOCK.length > 20,
    '禁止理由の文言が 1 か所に在る');
}

console.log('\n⑧-2 §18-15 readiness: 派生は required BloodTestData を満たさない');
{
  // ⑤ で網羅済みなので、ここでは「同じ 1 つの判定関数に委ねている」ことを見る。
  const ent = ENT.countsTowardReadiness;
  ok(ent({ test_type: 'blood', imported_by: DERIVED }) === false
     && SUB.isDerivedHealthcheckBlood({ test_type: 'blood', imported_by: DERIVED }) === true,
    'readiness の除外が isDerivedHealthcheckBlood と一致する');
  ok(ENT.decideReady(['BloodTestData'], new Set([]), false).ready === false, '派生だけでは ready:false');
}

console.log('\n⑧-3 §18-9/11 既存 artifact への書き込みを派生で乗っ取らせない');
{
  /*
   * **最大の穴だった箇所。** `persistIntoExistingArtifact()` は uid / test_type /
   * test_date しか照合していなかったので、同じ受診日に派生 blood が在ると
   * **検査機関の本物の血液検査がその行へ上書きされ**、`imported_by` が派生のまま残って
   * ① 本物が Elith から黙って外れ ② 画面に「人間ドックから抽出」が付く。
   */
  const db = makeDb({
    test_artifacts: [
      { id: 'd1', diagnostic_user_id: UID, test_type: 'blood', test_date: DATE, source: 'user_upload', status: 'active', imported_by: DERIVED },
      { id: 'n1', diagnostic_user_id: UID, test_type: 'blood', test_date: '2026-01-10', source: 'wellfort_lab', status: 'active', imported_by: 'wellfort_admin_upload' },
      { id: 'h1', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: DATE, source: 'user_upload', status: 'active', imported_by: 'user' },
    ],
  });
  sbStub.__setStub(db);
  const blocked = await PERSIST.persistIntoExistingArtifact({
    artifactId: 'd1', diagnosticUserId: UID, testType: 'blood',
    markdownClean: '## 検査機関の本物の血液検査', measurements: [m('尿酸', 9.9)], testDate: DATE,
  });
  ok(blocked.mismatch != null, '**派生 blood への書き込みは mismatch で止まる**', String(blocked.mismatch).slice(0, 40));
  ok(blocked.artifactId === null && blocked.rows === 0, '   artifactId も rows も返さない');
  ok(db.tables.measurement_values.length === 0, '   **測定値を 1 行も書いていない**');
  ok(db.tables.test_artifacts.find((a) => a.id === 'd1').scan_md == null, '   scan_md も書き換えていない');

  // 通常 blood へは従来どおり書ける (§16)
  const okWrite = await PERSIST.persistIntoExistingArtifact({
    artifactId: 'n1', diagnosticUserId: UID, testType: 'blood',
    markdownClean: '## 本物', measurements: [m('尿酸', 6.1)], testDate: '2026-01-10',
  });
  ok(okWrite.artifactId === 'n1' && okWrite.rows === 1,
    '**通常 blood への書き込みは従来どおり通る** (§16)', JSON.stringify(okWrite.mismatch ?? ''));
  // health_checkup へも従来どおり
  const okHc = await PERSIST.persistIntoExistingArtifact({
    artifactId: 'h1', diagnosticUserId: UID, testType: 'health_checkup',
    markdownClean: '## 検診', measurements: [m('尿酸', 7.8)], testDate: DATE,
  });
  ok(okHc.artifactId === 'h1', 'health_checkup への書き込みも従来どおり通る');
}

console.log('\n⑧-4 §18-10 Elith の検診 materialize に派生 blood が混ざらない');
{
  /*
   * cron 納品 (`deliverReadySpecialAccounts`) と手動納品 (`buildDeliveryPlan`) は
   * どちらも `materializeHealthCheckups()` + **S3 inventory** だけを材料にする。
   * ここで派生 blood が混ざらないこと = DB 側からは何も漏れないことを実測する。
   */
  const db = makeDb({
    test_artifacts: [
      { id: 'h1', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: DATE, status: 'active', source: 'user_upload', imported_by: 'user', scan_md: MD, measurements: GOLDEN_11 },
      { id: 'd1', diagnostic_user_id: UID, test_type: 'blood', test_date: DATE, status: 'active', source: 'user_upload', imported_by: DERIVED, scan_md: null, measurements: [] },
    ],
  });
  sbStub.__setStub(db);
  const s3 = await import(`../${CACHE}/bs-s3-stub.mjs`);
  s3.__reset();
  const mats = await DELIVERY.materializeHealthCheckups(UID, 'src/');
  ok(mats.length === 1, '検診 1 件だけが materialize される', `n=${mats.length}`);
  const keys = [...s3._written, ...mats.map((x) => String(x.hcKey ?? ''))];
  ok(keys.length > 0, 'S3 へ書こうとしたキーを捕まえられている', JSON.stringify(keys));
  ok(keys.every((k) => k.includes('HealthCheckupData')),
    '書こうとしたキーは HealthCheckupData だけ', JSON.stringify(keys));
  ok(!keys.some((k) => k.includes('BloodTestData')),
    '**BloodTestData のキーが 1 本も作られない** (§18-9)', JSON.stringify(keys));
}

console.log('\n⑧-5 §18-9/12/13/14 「派生 → Elith」の経路が増えたら落ちる番人');
{
  /*
   * ここは**構造の検査**。§0 は「派生 blood そのものが Elith 向け JSON 生成・納品対象に
   * 絶対にならないことをコード上で保証する」ことを求めている。
   *
   * ⚠️ **「違反が 0 件」を数える形にしてはいけない。** 最初そう書いたら、
   * **該当モジュールが 1 本も無くて常に緑**になった (= 関門を全部外しても通る)。
   * そこで**名簿を固定する形**にした: `blood` の artifact を触るモジュールの一覧が
   * 変わったら落ちる。新しい経路が足されたら、**人がここへ来て分類するしかない。**
   *
   * 保証の形はこの 3 つの組み合わせ:
   *   ① 納品の材料は `materializeHealthCheckups()` (検診のみ・⑧-4 で実測) と
   *      **S3 の inventory** だけ = DB の blood は納品の材料に**なっていない**
   *   ② DB の blood artifact を触る経路は下の名簿で固定 = 増えたら落ちる
   *   ③ 名簿のうち Elith へ繋がる 3 本には関門が在る (下で 1 本ずつ確かめる)
   */
  const SRC = 'src';
  const files = [];
  (function walk(dir) {
    for (const n of readdirSync(dir)) {
      const fp = join(dir, n);
      if (statSync(fp).isDirectory()) walk(fp);
      else if (/\.(ts|astro)$/.test(n)) files.push(fp.split('\\').join('/'));
    }
  })(SRC);
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const text = new Map(files.map((f) => [f, strip(readFileSync(f, 'utf8'))]));

  /**
   * **`blood` を名指しして `test_artifacts` を触るモジュールの名簿**。
   * 右側は「Elith へ繋がるか」= 関門が要るか。
   */
  const ROSTER = {
    'src/lib/account-progress.ts': 'dashboard',                       // 進捗の件数カウント
    'src/lib/dashboard-queries.ts': 'dashboard',                      // ダッシュボードの検査カード
    'src/lib/measurement-queries.ts': 'dashboard',                    // 推移グラフ
    'src/pages/api/debug/viewer.ts': 'dashboard',                     // 切り分け用の自己診断
    'src/pages/api/admin/lab-results/upload.ts': 'dashboard',         // UNASSIGNED_UID で作るだけ
    'src/pages/api/admin/derived-blood/backfill.ts': 'dashboard',     // 派生を作る口 (S3 へ書かない)
    'src/pages/api/admin/lab-results/register.ts': 'supersede',       // 通常到着 → 派生を降ろす
    'src/lib/elith-entitlement.ts': 'elith',                          // 揃い判定
    'src/lib/scan-persist.ts': 'elith',                               // 既存 artifact への書き込み
    'src/pages/api/admin/special-additional-tests/finalize.ts': 'elith', // 追加検査の納品
  };
  const found = files.filter((f) => {
    const t = text.get(f) ?? '';
    return /from\(\s*['"`]test_artifacts['"`]\s*\)/.test(t) && /['"`]blood['"`]/.test(t);
  }).sort();
  const expected = Object.keys(ROSTER).sort();
  const added = found.filter((f) => !expected.includes(f));
  const gone = expected.filter((f) => !found.includes(f));
  ok(added.length === 0,
    '**blood の artifact を触るモジュールが増えていない** (増えたら Elith へ繋がるか分類すること)',
    JSON.stringify(added));
  ok(gone.length === 0, '名簿のモジュールが消えていない (検出器の腐り防止)', JSON.stringify(gone));
  ok(found.length === expected.length && found.length === 10,
    `名簿は 10 本 (実測 ${found.length} 本)`, String(found.length));

  /*
   * ③ Elith へ繋がる 3 本に関門が在ること。**1 本ずつ名前を出して確かめる**
   * (まとめて数えると、どれが外れたのか分からない)。
   */
  const sp = text.get('src/lib/scan-persist.ts') ?? '';
  ok(/isDerivedHealthcheckBlood\(a\)/.test(sp) && /mismatch: DERIVED_HC_BLOOD_ELITH_BLOCK/.test(sp),
    'scan-persist: 既存 artifact への書き込みで派生を弾いている');
  const sat = text.get('src/lib/special-additional-tests.ts') ?? '';
  ok(/isDerivedHealthcheckBlood/.test(sat) && /derivedSkipped/.test(sat),
    'special-additional-tests: artifact 候補から派生を外している');
  const ent = text.get('src/lib/elith-entitlement.ts') ?? '';
  ok(/isDerivedHealthcheckBlood\(r\)/.test(ent), 'elith-entitlement: 揃い判定から派生を外している');

  /*
   * **関門は納品の「前」に在ること。** 後ろにあると、書いてから止めることになる。
   * 位置を見るのが要点 — 存在だけなら下へ移しても緑のままになる。
   */
  const fin = text.get('src/pages/api/admin/special-additional-tests/finalize.ts') ?? '';
  const iGuard = fin.indexOf('assertNotDerivedBlood(saved.artifactId)');
  const iDeliver = fin.indexOf('deliverAdditionalJson(');
  ok(iGuard > 0 && iDeliver > 0 && iGuard < iDeliver,
    '**finalize: 関門は deliverAdditionalJson より前に在る**', `guard=${iGuard} deliver=${iDeliver}`);
  ok(/derived_blood_not_deliverable/.test(fin), 'finalize: 止めたときの理由を返している');
  ok(/isDerivedHealthcheckBlood/.test(fin), 'finalize: 判定は共通関数に委ねている');

  /*
   * **§11 の配線**: スペシャルの検診 Admin 登録から派生を作っていること。
   * `finalize.ts` は原本の S3 読み出しを伴うので POST を丸ごと動かせない
   * (スタブでは step 3 で返る)。**位置関係だけは機械で固定する** —
   * 「検診を登録したのに Dashboard の血液が増えない」「保存前に派生を作る」の両方を捕まえる。
   */
  const iSave = fin.indexOf('await saveAdditionalArtifact(');
  const iDerive = fin.indexOf('persistDerivedBloodArtifact(');
  const iSup = fin.indexOf('supersedeDerivedBloodOnSameDate(');
  ok(iDerive > 0, '**finalize: 検診登録から派生を作っている** (§11)', `idx=${iDerive}`);
  ok(iSave > 0 && iDerive > iSave,
    '**派生を作るのは health_checkup を保存し終えた後** (§10.3)', `save=${iSave} derive=${iDerive}`);
  ok(/testType === 'health_checkup'[\s\S]{0,400}?persistDerivedBloodArtifact\(/.test(fin),
    "   検診のときだけ呼んでいる (testType === 'health_checkup' の内側)");
  ok(iSup > 0 && iSup > iSave, 'finalize: 血液登録で同日の派生を降ろしている (§8)', `sup=${iSup}`);
  ok(/testType === 'blood'[\s\S]{0,300}?supersedeDerivedBloodOnSameDate\(/.test(fin),
    "   血液のときだけ降ろしている (testType === 'blood' の内側)");
  ok(/derived_blood:/.test(fin) && /superseded_derived_blood:/.test(fin),
    '   結果を応答に出している (黙らせない)');

  /** ① 派生 blood から BloodTestData JSON を作る関数が**存在しない**こと。 */
  const anyWriter = files.filter((f) => /materializeDerivedBlood|derivedBloodTestData|buildDerivedBloodJson/i.test(text.get(f) ?? ''));
  ok(anyWriter.length === 0,
    '**派生 blood から BloodTestData JSON を作る関数が 1 つも無い** (§0)', JSON.stringify(anyWriter));
}

console.log('\n⑧-5b 追加検査の候補から派生が外れていること (実際に動かす)');
{
  /*
   * ⑧-5 の名簿検査は**文字列を見るだけ**なので、`isDerivedHealthcheckBlood` を
   * import したまま filter を外す退行を捕まえられなかった (実測)。
   * → `resolveAdditionalArtifact()` を**実際に動かして**候補を数える。
   */
  const base = (id, imported_by, test_type = 'blood') => ({
    id, diagnostic_user_id: UID, test_type, test_date: DATE,
    source: imported_by === DERIVED ? 'user_upload' : 'wellfort_lab',
    status: 'active', imported_by, display_mode: 'single',
  });

  // ① 派生だけ在る → 候補 0 件 (= 新しい artifact を作る側へ進む)
  sbStub.__setStub(makeDb({ test_artifacts: [base('d1', DERIVED)] }));
  const r1 = await SAT.resolveAdditionalArtifact({ uid: UID, testType: 'blood', testDate: DATE });
  ok(r1.kind === 'none', '**派生だけ → 候補なし** (本物の血液検査の入れ先にしない)', JSON.stringify(r1.kind));
  ok(r1.derivedSkipped === 1, '   外した件数を返す (黙って消さない)', String(r1.derivedSkipped));

  // ② 通常だけ在る → 従来どおり 1 件 (§16)
  sbStub.__setStub(makeDb({ test_artifacts: [base('n1', 'wellfort_admin_upload')] }));
  const r2 = await SAT.resolveAdditionalArtifact({ uid: UID, testType: 'blood', testDate: DATE });
  ok(r2.kind === 'one' && r2.artifactId === 'n1',
    '**通常 blood は従来どおり候補になる** (§16)', JSON.stringify(r2.kind));

  // ③ 通常 + 派生 → 通常だけが候補 (ambiguous にしない)
  sbStub.__setStub(makeDb({ test_artifacts: [base('n1', 'wellfort_admin_upload'), base('d1', DERIVED)] }));
  const r3 = await SAT.resolveAdditionalArtifact({ uid: UID, testType: 'blood', testDate: DATE });
  ok(r3.kind === 'one' && r3.artifactId === 'n1',
    '**通常 + 派生 → 通常だけが候補** (曖昧扱いにしない)', JSON.stringify(r3.kind));

  // ④ health_checkup では 1 行も挙動が変わらない (marker が付いていても候補に出る)
  sbStub.__setStub(makeDb({ test_artifacts: [base('h1', DERIVED, 'health_checkup')] }));
  const r4 = await SAT.resolveAdditionalArtifact({ uid: UID, testType: 'health_checkup', testDate: DATE });
  ok(r4.kind === 'one' && r4.artifactId === 'h1',
    '**health_checkup の候補は 1 行も変わらない** (blood 以外は不変)', JSON.stringify(r4.kind));
}

console.log('\n⑧-5c backfill は範囲を明示しないと動かない (§12 / §13)');
{
  /*
   * **「受診日を空欄にすると全件」という暗黙の操作を廃止した**ことを実際に叩いて見る。
   * ここが緩むと、1 件だけ直すつもりの操作で**その人の全ての回**が書き換わる。
   */
  const call = async (body) => {
    const res = await BACKFILL.POST({ request: new Request('http://x/api/admin/derived-blood/backfill', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) });
    return { status: res.status, json: await res.json() };
  };
  sbStub.__setStub(makeDb({ test_artifacts: [{ ...HC_ROW }] }));

  const noMode = await call({ diagnosticUserId: UID });
  ok(noMode.status === 400 && noMode.json.error === 'invalid_mode',
    '**mode 未指定は 400** (既定で全件にしない)', `${noMode.status} ${noMode.json.error}`);

  const badMode = await call({ diagnosticUserId: UID, mode: 'all' });
  ok(badMode.status === 400 && badMode.json.error === 'invalid_mode',
    "未知の mode ('all') も 400 (allow-list)", `${badMode.status} ${badMode.json.error}`);

  const oneNoDate = await call({ diagnosticUserId: UID, mode: 'one' });
  ok(oneNoDate.status === 400 && oneNoDate.json.error === 'test_date_required',
    "**mode='one' で受診日が空なら 400** (空欄=全件にしない)", `${oneNoDate.status} ${oneNoDate.json.error}`);

  const pendingWithDate = await call({ diagnosticUserId: UID, mode: 'pending', testDate: DATE });
  ok(pendingWithDate.status === 400 && pendingWithDate.json.error === 'test_date_not_allowed',
    "mode='pending' に受診日を付けたら 400 (どちらのつもりか聞き返す)", `${pendingWithDate.status} ${pendingWithDate.json.error}`);

  const badUid = await call({ diagnosticUserId: 'not-a-uuid', mode: 'one', testDate: DATE });
  ok(badUid.status === 400 && badUid.json.error === 'invalid_diagnostic_user_id', 'UUID でない uid は 400');

  // preview は書かない
  const db = makeDb({ test_artifacts: [{ ...HC_ROW }] });
  sbStub.__setStub(db);
  const prev = await call({ diagnosticUserId: UID, mode: 'one', testDate: DATE });
  ok(prev.status === 200 && prev.json.mode === 'preview', 'confirm 無しは preview', JSON.stringify(prev.json.mode));
  ok(db.tables.test_artifacts.filter((a) => a.test_type === 'blood').length === 0,
    '**preview は blood artifact を 1 件も作らない**');
  ok(db.tables.measurement_values.length === 0, '   measurement_values も 0 件');
  ok(prev.json.targets?.[0]?.would_create?.count === 11, '   作る予定は 11 項目', String(prev.json.targets?.[0]?.would_create?.count));

  // apply で 1 件作る
  const applied = await call({ diagnosticUserId: UID, mode: 'one', testDate: DATE, confirm: true });
  ok(applied.status === 200 && applied.json.mode === 'applied', 'confirm:true で applied');
  ok(db.tables.test_artifacts.filter((a) => a.test_type === 'blood' && a.imported_by === DERIVED).length === 1,
    '派生 blood が 1 件できた');
  ok(db.tables.measurement_values.filter((x) => x.test_type === 'blood').length === 11, '測定値 11 件');

  // mode='pending' は処理済みの回を触らない
  const pend = await call({ diagnosticUserId: UID, mode: 'pending', confirm: true });
  ok(pend.status === 200 && (pend.json.targets ?? []).length === 0,
    "**mode='pending' は処理済みの回を対象にしない**", JSON.stringify((pend.json.targets ?? []).length));
  ok((pend.json.already_done_dates ?? []).includes(DATE), '   処理済みの受診日を返す', JSON.stringify(pend.json.already_done_dates));
  ok(db.tables.test_artifacts.filter((a) => a.test_type === 'blood').length === 1, '   blood artifact は 1 件のまま');
}

console.log('\n⑧-6 §18-11 同日に通常と派生が在るとき、Elith へ行くのは通常だけ');
{
  const db = makeDb({
    test_artifacts: [
      { id: 'n1', diagnostic_user_id: UID, test_type: 'blood', test_date: DATE, source: 'wellfort_lab', status: 'active', imported_by: 'wellfort_admin_upload' },
      { id: 'd1', diagnostic_user_id: UID, test_type: 'blood', test_date: DATE, source: 'user_upload', status: 'active', imported_by: DERIVED },
    ],
  });
  sbStub.__setStub(db);
  // readiness は通常 blood で満たされる (= 通常は従来どおり Elith の対象)。
  const rows = db.tables.test_artifacts.map((a) => ({ test_type: a.test_type, imported_by: a.imported_by }));
  const countable = rows.filter((r) => ENT.countsTowardReadiness(r));
  ok(countable.length === 1 && countable[0].imported_by === 'wellfort_admin_upload',
    '数えられるのは通常 blood の 1 件だけ', JSON.stringify(countable));
  // 通常が届いたら派生は降りる (同日に 2 件並べない)。
  const r = await PERSIST.supersedeDerivedBloodOnSameDate(db, UID, DATE);
  ok(r.superseded === 1 && db.tables.test_artifacts.find((a) => a.id === 'n1').status === 'active',
    '派生だけが降り、通常は active のまま');
}

/* ══════════════════════════════════════════════════════════════════
   ⑨ **Production に既に在る派生 artifact** が、将来どの Elith 経路からも流れない
      発注者指示 2026-10-03。**「新しく作らない」だけでは不十分。**

   本番の実データ (発注者確認済み・**削除も作り直しもしない**):
     2026-09-17  derived_healthcheck_blood   2 項目
     2026-09-24  derived_healthcheck_blood  11 項目
                 artifact id = 98bb8668-c794-452a-9529-594fbc540a44
   以下の検査はこの 2 件を**既存行として seed** して走らせる (新規作成はしない)。
   ══════════════════════════════════════════════════════════════════ */
const PROD_ART_0924 = '98bb8668-c794-452a-9529-594fbc540a44';
const PROD_DATE_0917 = '2026-09-17';

/** 本番に在るのと同じ形の「既存の派生 artifact」2 件 + 元の検診 2 件。 */
function seedProduction(extra = []) {
  const mv = (artifact_id, test_date, seq, item_name, value_num) => ({
    artifact_id, diagnostic_user_id: UID, test_type: 'blood', test_date, seq,
    item_name, canonical_name: item_name, value: String(value_num), value_num,
    unit: 'mg/dL', ref_low: null, ref_high: null, ref_low_num: null, ref_high_num: null,
    flag: null, assessment: null, source_file_kind: 'scan_md',
  });
  return makeDb({
    test_artifacts: [
      // 元の検診 (**不変であることも確かめる**)
      { id: 'hc-0917', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: PROD_DATE_0917, source: 'user_upload', status: 'active', imported_by: 'user', scan_md: MD, measurements: GOLDEN_11 },
      { id: 'hc-0924', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: DATE, source: 'user_upload', status: 'active', imported_by: 'user', scan_md: MD, measurements: GOLDEN_11 },
      // **既に本番に在る派生 blood 2 件**
      { id: 'derived-0917', diagnostic_user_id: UID, test_type: 'blood', test_date: PROD_DATE_0917, source: 'user_upload', status: 'active', imported_by: DERIVED, scan_md: null, measurements: [] },
      { id: PROD_ART_0924, diagnostic_user_id: UID, test_type: 'blood', test_date: DATE, source: 'user_upload', status: 'active', imported_by: DERIVED, scan_md: null, measurements: [] },
      ...extra,
    ],
    measurement_values: [
      mv('derived-0917', PROD_DATE_0917, 0, '尿酸', 7.2),
      mv('derived-0917', PROD_DATE_0917, 1, 'eGFR', 58.1),
      ...Object.entries(EXPECTED_11).map(([n, v], i) => mv(PROD_ART_0924, DATE, i, n, v)),
    ],
  });
}

console.log('\n⑨-1 既存の派生は **Dashboard では従来どおり取得される**');
{
  const db = seedProduction();
  sbStub.__setStub(db);
  const d = await DASH.loadDashboard(UID);
  ok(!('error' in d), 'loadDashboard がエラーを返さない', JSON.stringify(d.error ?? ''));
  const blood = (d.artifacts ?? []).filter((a) => a.test_type === 'blood');
  ok(blood.length === 2, '**血液検査の artifact が 2 件とも取得される**', String(blood.length));
  ok(blood.some((a) => a.id === PROD_ART_0924), `   2026-09-24 の ${PROD_ART_0924} が入っている`);
  ok(blood.some((a) => a.test_date === PROD_DATE_0917), '   2026-09-17 も入っている');
  // 検査カードの「グラフ」ボタン (TestResultsSection の canGraph = 件数 >= 2)
  ok(blood.length >= 2, '   グラフのボタンが出る件数 (>=2) を満たす');

  const cand = await QUERIES.getTrendCandidates(UID, 'blood');
  ok(cand.length > 0, '**推移グラフの候補に出る**', JSON.stringify(cand.slice(0, 4)));
  const series = await QUERIES.getMeasurementTrend(UID, ['尿酸', 'eGFR'], 12, 'blood');
  ok(series.length === 2, '尿酸 / eGFR の 2 系列が返る', String(series.length));
  const pts = series.flatMap((x) => x.points);
  ok(pts.length === 4, '   点は 4 つ (2 回 × 2 項目)', String(pts.length));
  ok(pts.every((pt) => pt.source === 'health_checkup_scan'),
    '**全ての点に「人間ドックから抽出」の印が付く**', JSON.stringify(pts.map((pt) => pt.source)));
  ok(series.every((x) => x.referenceUpper === undefined),
    '   派生だけの系列なので基準線は原本どおり (ここでは ref 無しなので undefined)');
}

console.log('\n⑨-2 既存の派生は **Elith readiness に数えられない**');
{
  const db = seedProduction();
  sbStub.__setStub(db);
  const r = await ENT.checkFormatsReady([UID], new Map([[UID, ['BloodTestData']]]));
  const me = r[UID];
  ok(me != null && me.ready === false,
    '**既存の派生 2 件が在っても ready:false**', JSON.stringify(me?.ready));
  ok((me?.missing ?? []).includes('BloodTestData'),
    '   missing に BloodTestData が入る', JSON.stringify(me?.missing));

  // 通常 blood を 1 件足すと ready:true (= §16 通常は従来どおり)
  const db2 = seedProduction([
    { id: 'n1', diagnostic_user_id: UID, test_type: 'blood', test_date: '2026-01-10', source: 'wellfort_lab', status: 'active', imported_by: 'wellfort_admin_upload' },
  ]);
  sbStub.__setStub(db2);
  const r2 = await ENT.checkFormatsReady([UID], new Map([[UID, ['BloodTestData']]]));
  ok(r2[UID]?.ready === true,
    '**通常 blood が 1 件在れば ready:true** (§16 を壊していない)', JSON.stringify(r2[UID]?.ready));
}

console.log('\n⑨-3 既存の派生は **BloodTestData JSON の生成対象にならない**');
{
  const db = seedProduction();
  sbStub.__setStub(db);
  const s3 = await import(`../${CACHE}/bs-s3-stub.mjs`);
  s3.__reset();
  const mats = await DELIVERY.materializeHealthCheckups(UID, 'src/');
  ok(mats.length === 2, '検診 2 年ぶんが materialize される', String(mats.length));
  ok(s3._written.length > 0, 'S3 へ書こうとしたキーを捕まえられている', String(s3._written.length));
  ok(!s3._written.some((k) => k.includes('BloodTestData')),
    '**BloodTestData のキーが 1 本も書かれない**', JSON.stringify(s3._written.filter((k) => k.includes('Blood'))));
  ok(s3._written.every((k) => k.includes('HealthCheckupData')),
    '   書かれるのは HealthCheckupData だけ');
  // **元の検診は不変**
  ok(db.tables.test_artifacts.find((a) => a.id === 'hc-0924')?.measurements === GOLDEN_11,
    '   元の検診 artifact は不変');
  ok(db.tables.test_artifacts.find((a) => a.id === PROD_ART_0924)?.status === 'active',
    '   **既存の派生 artifact を触っていない** (status も measurements も)',
    String(db.tables.test_artifacts.find((a) => a.id === PROD_ART_0924)?.status));
  ok(db.tables.measurement_values.filter((x) => x.artifact_id === PROD_ART_0924).length === 11,
    '   既存の派生の測定値 11 件もそのまま');
}

console.log('\n⑨-4 既存の派生は **manual delivery の対象にならない**');
{
  const db = seedProduction();
  sbStub.__setStub(db);
  const s3 = await import(`../${CACHE}/bs-s3-stub.mjs`);
  s3.__reset();
  const plan = await MANUAL.buildDeliveryPlan({
    uid: UID, sourcePrefix: 'src/', deliveryPrefix: 'dst/',
  });
  const formats = (plan.files ?? []).map((f) => String(f.formatId));
  ok(!formats.includes('BloodTestData'),
    '**納品予定に BloodTestData が 1 件も入らない**', JSON.stringify(formats));
  ok(!(plan.files ?? []).some((f) => String(f.key ?? '').includes('BloodTestData')),
    '   納品キーにも BloodTestData が出ない');
  ok(!s3._written.some((k) => k.includes('BloodTestData')),
    '   確認 (preview) の副作用でも BloodTestData を書かない');
  ok(db.tables.test_artifacts.find((a) => a.id === PROD_ART_0924)?.status === 'active',
    '   既存の派生 artifact は無傷');
}

console.log('\n⑨-5 / ⑨-6 **cron / 自動納品・再納品の対象にならない**');
{
  /*
   * **cron (`deliverReadySpecialAccounts`) の入口は、このスタブでは母集団が空になる**
   * (スペシャルは設計どおり cron から外され、契約者は `app_bridge` の subscription と
   *  `elith.plan_formats` が要る)。入口を叩いて「何も書かれなかった」と言っても
   * **空振りを緑と見間違える**ので、cron の**合成の仕組みそのもの**を検査する。
   *
   * cron は materialize → inventory → `manualMapping{HealthCheckupData, Lifestyle}` →
   * `assembleElithDeliverySet` という順で納品物を決める。したがって保証は 2 つ:
   *   (a) **manualMapping に BloodTestData が無い** (構造)
   *   (b) **その manualMapping では、source に BloodTestData が在っても納品されない** (挙動)
   * (b) は「mapping に載せれば納品される」ことも同時に確かめ、**空振りでないこと**を示す。
   */
  const s3 = await import(`../${CACHE}/bs-s3-stub.mjs`);

  // (a) cron が組む manualMapping — **コメントを外してから**見る
  const srcRaw = readFileSync('src/lib/elith-delivery.ts', 'utf8');
  const src = srcRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const mm = /manualMapping\[uid\]\s*=\s*\{([\s\S]*?)\};/.exec(src);
  ok(mm != null, 'cron の manualMapping を取り出せている (コメント除去後)');
  ok(mm != null && mm[1].trim().length > 0, '   中身が空でない (コメントだけを掴んでいない)',
    String(mm?.[1] ?? '').replace(/\s+/g, ' ').slice(0, 70));
  ok(mm != null && !/BloodTestData/.test(mm[1]),
    '**cron の manualMapping に BloodTestData が無い**', String(mm?.[1] ?? '').replace(/\s+/g, ' ').slice(0, 70));
  ok(mm != null && /HealthCheckupData/.test(mm[1]) && /LifestyleQuestionnaireData/.test(mm[1]),
    '   入っているのは検診と問診だけ (従来どおり)');

  /*
   * (b) **デメカル由来の BloodTestData が source に在る**状態で assemble を回す。
   * これは実在する状況 — `elith-blood-csv.ts` が admin の CSV 取り込みで書く。
   */
  const hcKey = `src/user/${UID}/date/2026_09_24/HealthCheckupData_date_2026_09_24_user_${UID}.json`;
  const btKey = `src/user/${UID}/date/2026_01_10/BloodTestData_date_2026_01_10_user_${UID}.json`;
  const body = (formatId, date) => JSON.stringify({
    format_id: formatId, schema_version: '1.0', client_id: UID, diagnostic_id: UID,
    test_date: date, data: { measurements: [{ name: '尿酸', value: '6.1', value_num: 6.1 }] },
  });
  const seedSource = () => {
    s3.__reset();
    s3.__seed(hcKey, body('HealthCheckupData', '2026-09-24'));
    s3.__seed(btKey, body('BloodTestData', '2026-01-10'));
  };
  const deliveredFormats = async (mapping) => {
    const r = await ASSEMBLE.assembleElithDeliverySet({
      sourcePrefix: 'src/', deliveryPrefix: 'dst/', bundleDate: '2026_09_24',
      manualMapping: { [UID]: mapping },
    });
    return (r.users ?? []).flatMap((u) => (u.files ?? []).map((f) => String(f.key)));
  };

  seedSource();
  const cronShape = await deliveredFormats({ HealthCheckupData: hcKey });
  ok(cronShape.length > 0, '納品ファイルが作られている (空振りでない)', String(cronShape.length));
  ok(cronShape.some((k) => k.includes('HealthCheckupData')), '   検診は納品される');
  ok(!cronShape.some((k) => k.includes('BloodTestData')),
    '**cron の mapping では source の BloodTestData が納品されない**',
    JSON.stringify(cronShape.filter((k) => k.includes('Blood'))));

  seedSource();
  const withBlood = await deliveredFormats({ HealthCheckupData: hcKey, BloodTestData: btKey });
  ok(withBlood.some((k) => k.includes('BloodTestData')),
    '**mapping に載せれば BloodTestData は納品される** (= 上の検査は空振りでない / §16 も成立)',
    JSON.stringify(withBlood.filter((k) => k.includes('Blood'))));

  /*
   * ⑨-6 **再納品 (retry / re-delivery)**。同じ source をもう一度 assemble しても、
   * 納品物は同じ = 派生が後から混ざることはない。
   */
  seedSource();
  const again = await deliveredFormats({ HealthCheckupData: hcKey });
  ok(again.join('|') === cronShape.join('|'),
    '**2 回目 (再納品) も納品物が同じ** — 派生は何度やっても混ざらない',
    `1st=${cronShape.length} 2nd=${again.length}`);

  /*
   * **DB に既存の派生が在っても、納品物は 1 バイトも変わらない**ことを差分で見る。
   * これが #3〜#6 の核心 — 「派生が在る / 無い」で結果が動かない。
   */
  const dbWith = seedProduction();
  sbStub.__setStub(dbWith);
  seedSource();
  const planWith = await deliveredFormats({ HealthCheckupData: hcKey });
  const dbWithout = makeDb({
    test_artifacts: [{ id: 'hc-0924', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: DATE, source: 'user_upload', status: 'active', imported_by: 'user', scan_md: MD, measurements: GOLDEN_11 }],
  });
  sbStub.__setStub(dbWithout);
  seedSource();
  const planWithout = await deliveredFormats({ HealthCheckupData: hcKey });
  ok(planWith.join('|') === planWithout.join('|'),
    '**既存の派生が在っても納品物は同一** (派生は納品に 1 件も寄与しない)',
    `with=${planWith.length} without=${planWithout.length}`);
  ok(dbWith.tables.test_artifacts.find((a) => a.id === PROD_ART_0924)?.status === 'active',
    '   既存の派生 artifact は無傷');
}

console.log('\n⑨-7 同日に派生が在っても **通常 blood の登録は成功する** (発注者の期待動作)');
{
  /*
   * 期待動作:
   *   同日 derived あり + 後から通常 blood 到着
   *     → 通常 blood は**正常に新規/正規 artifact として保存**
   *     → derived は superseded
   *     → 通常 blood は Elith 対象
   *
   * **「派生への書き込みを拒否した結果、通常 blood の登録そのものが失敗する」ことがない**
   * ことを確かめるのがここの主眼。finalize.ts と同じ順序で 2 つを呼ぶ。
   */
  const db = seedProduction();
  sbStub.__setStub(db);
  const before = db.tables.test_artifacts.length;

  // ① finalize と同じ: 候補解決 → 保存
  const res = await SAT.resolveAdditionalArtifact({ uid: UID, testType: 'blood', testDate: DATE });
  ok(res.kind === 'none' && res.derivedSkipped === 1,
    '候補は 0 件 (既存の派生は入れ先にしない)', JSON.stringify(res.kind));
  const saved = await SAT.saveAdditionalArtifact({
    uid: UID, testType: 'blood', testDate: DATE,
    markdownClean: '## 検査機関の血液検査', measurements: [m('尿酸', 6.4, 'mg/dL'), m('GOT(AST)', 22, 'U/L')],
  });
  ok(saved.ok === true, '**通常 blood の登録が成功する** (拒否で失敗しない)', JSON.stringify(saved.error ?? ''));
  ok(saved.created === true, '   **新しい artifact として作られる** (派生を使い回さない)', String(saved.created));
  ok(saved.artifactId !== PROD_ART_0924, '   既存の派生とは別の id', String(saved.artifactId));
  ok(saved.rows === 2, '   測定値 2 件が入る', String(saved.rows));
  ok(saved.ok !== false, '   (上が落ちたら以降は参考値)', String(saved.ok));
  ok(db.tables.test_artifacts.length === before + 1, '   artifact は 1 件だけ増えた');

  // ② finalize と同じ: 同日の派生を降ろす
  const sup = await PERSIST.supersedeDerivedBloodOnSameDate(db, UID, DATE);
  ok(sup.superseded === 1, '**同日の派生が superseded になる**', String(sup.superseded));
  const derivedRow = db.tables.test_artifacts.find((a) => a.id === PROD_ART_0924);
  ok(derivedRow != null, '   **削除ではない** (行は残る = 監査できる)', derivedRow ? 'あり' : '**消えている**');
  ok(derivedRow?.status === 'superseded', '   status が superseded', String(derivedRow?.status));
  const normal = db.tables.test_artifacts.find((a) => a.id === saved.artifactId);
  ok(normal != null, '   通常 blood の行が在る', normal ? 'あり' : 'なし');
  ok(normal?.status === 'active' && normal?.imported_by !== DERIVED,
    '   通常 blood は active・派生の marker は付かない', String(normal?.imported_by));
  // 別の日 (2026-09-17) の派生には触っていない
  ok(db.tables.test_artifacts.find((a) => a.id === 'derived-0917')?.status === 'active',
    '   **2026-09-17 の派生には触っていない**',
    String(db.tables.test_artifacts.find((a) => a.id === 'derived-0917')?.status));

  // ③ 通常 blood は Elith 対象になる
  const r = await ENT.checkFormatsReady([UID], new Map([[UID, ['BloodTestData']]]));
  ok(r[UID]?.ready === true,
    '**通常 blood が入ったので ready:true** (= Elith 対象)', JSON.stringify(r[UID]?.ready));

  // ④ グラフは通常の値に差し替わる (派生は superseded なので点にならない)
  const series = await QUERIES.getMeasurementTrend(UID, ['尿酸'], 12, 'blood');
  const onDate = (series[0]?.points ?? []).filter((pt) => pt.date === DATE);
  ok(onDate.length === 1 && onDate[0].value === 6.4,
    `   ${DATE} の点は通常 blood の値 (6.4)`, JSON.stringify(onDate));
  ok(onDate[0]?.source == null, '   その点に「人間ドックから抽出」は付かない');
}

/* ── 結果 ────────────────────────────────────────────────────────── */
console.log(`\n${'='.repeat(60)}\nPASS ${pass} / FAIL ${fails.length}`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
console.log('すべて通りました。');
