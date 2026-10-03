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
/**
 * `seed.failSelect(table, cols)` が true を返す select だけ **error を返す**。
 * fail-closed の検査に要る — 「引けなかったときに通してしまう」を捕まえるため。
 */
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
      if (st.op === 'select' && seed.failSelect?.(name, st.cols)) {
        return { data: null, error: { message: 'injected db error' } };
      }
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
      select(cols) { st.cols = cols; return api; },
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
writeFileSync(`${CACHE}/bs-orig-stub.mjs`, `let _ok = false;
export function __setOk(v) { _ok = v; }
export function readUploadedOriginal() {
  return Promise.resolve(_ok
    ? { ok: true, sha256: 'a'.repeat(64), sizeBytes: 1234, contentType: 'application/pdf', storageUrl: 's3://stub/k', body: new Uint8Array([1, 2, 3]) }
    : { ok: false, error: 'stub' });
}
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
const FINALIZE = await bundle('src/pages/api/admin/special-additional-tests/finalize.ts', 'bs-finalize.mjs');
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
    diagnosticUserId: UID, testDate: DATE, parentArtifactId: 'hc-1', sourceMeasurements: GOLDEN_11,
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
  await PERSIST.persistDerivedBloodArtifact(db, { diagnosticUserId: UID, testDate: DATE, parentArtifactId: 'hc-1', sourceMeasurements: GOLDEN_11 });
  await PERSIST.persistDerivedBloodArtifact(db, { diagnosticUserId: UID, testDate: DATE, parentArtifactId: 'hc-1', sourceMeasurements: GOLDEN_11 });
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
    diagnosticUserId: UID, testDate: DATE, parentArtifactId: 'hc-1', sourceMeasurements: GOLDEN_11,
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
    diagnosticUserId: UID, testDate: DATE, parentArtifactId: 'hc-1', sourceMeasurements: [m('胸部X線', '所見なし')],
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
    diagnosticUserId: UID, testDate: DATE, parentArtifactId: 'hc-1', sourceMeasurements: GOLDEN_11,
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
  const r2 = await PERSIST.persistDerivedBloodArtifact(db2, { diagnosticUserId: UID, testDate: DATE, parentArtifactId: 'hc-1', sourceMeasurements: GOLDEN_11 });
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
  const iGuard = fin.indexOf('elithBloodGuard(saved.artifactId, testType)');
  const iDeliver = fin.indexOf('deliverAdditionalJson(');
  const iSourcePut = fin.indexOf('putFiles([{ key: sourceKey');
  ok(iGuard > 0 && iDeliver > 0 && iGuard < iDeliver,
    'finalize: 関門は deliverAdditionalJson より前に在る', `guard=${iGuard} deliver=${iDeliver}`);
  /*
   * **source JSON を書く前**であることが本質。中間 source prefix の
   * `BloodTestData_*.json` は inventory がキー名で拾うので、
   * **source へ書いた時点で将来の納品対象**になる (`deliver:false` でも source は書く)。
   */
  ok(iSourcePut > 0 && iGuard < iSourcePut,
    '**finalize: 関門は source JSON の putFiles より前に在る**', `guard=${iGuard} sourcePut=${iSourcePut}`);
  ok(/derived_blood_not_deliverable/.test(fin), 'finalize: 止めたときの理由を返している');
  ok(/elith_guard_unverifiable/.test(fin), '**finalize: 確認不能のときの理由も在る** (fail-closed)');
  ok(/isDerivedHealthcheckBlood/.test(fin), 'finalize: 判定は共通関数に委ねている');
  ok(/testType !== 'blood'\) return \{ ok: true \}/.test(fin),
    '**finalize: fail-closed は blood だけ** (他種別は従来どおり)');

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

/* ══════════════════════════════════════════════════════════════════
   ⑩ **fail-closed** (発注者レビュー 2026-10-03 ①②③)
      「確認できなかったから通した」を潰す。
   ══════════════════════════════════════════════════════════════════ */
console.log('\n⑩-1 ① Elith の最終関門は blood で fail-closed');
{
  /*
   * **blood + artifact 照会が DB error** のとき:
   *   → `deliverAdditionalJson()` が呼ばれない
   *   → **S3 write 0**
   *   → 503 `elith_guard_unverifiable` / `delivered:false`
   *
   * ⚠️ 関門は **source JSON を書く前**に置いてある。中間 source prefix の
   * `BloodTestData_*.json` は `inventoryElithSource()` がキー名で拾うので、
   * **source へ書いた時点で将来の納品対象**になる。
   * 「`deliverAdditionalJson` の直前」では遅い (`deliver:false` でも source は書く)。
   */
  const s3 = await import(`../${CACHE}/bs-s3-stub.mjs`);
  const orig = await import(`../${CACHE}/bs-orig-stub.mjs`);
  const GUARD_COLS = 'test_type, imported_by';   // 関門の select だけを狙い撃つ
  const PARTS = [{ page: 1, raw_markdown: '## 血液', measurements: [{ name: '尿酸', value: '6.4', value_num: 6.4, unit: 'mg/dL' }] }];
  /*
   * **原本キーは `buildAdditionalOriginalKey()` と同じ形にする** — 違うと
   * 手前の `invalid_original_binding` (409) で止まり、**関門に到達しないまま緑**になる
   * (実際にそれで空振りした)。sha256 はスタブが返す 'a'×64。
   */
  const SHA = 'a'.repeat(64);
  const okey = (testType, date) => `additional_results/${UID}/${testType}/${date.replace(/-/g, '_')}/${SHA}.pdf`;

  const callFinalize = async (body) => {
    const res = await FINALIZE.POST({ request: new Request('http://x/api/admin/special-additional-tests/finalize', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) });
    return { status: res.status, json: await res.json() };
  };

  // (a) 関門の照会だけが落ちる → 503・S3 write 0
  orig.__setOk(true);
  const dbErr = makeDb({
    test_artifacts: [{ id: 'hc-x', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: DATE, status: 'active', source: 'user_upload', imported_by: 'user' }],
    failSelect: (t, c) => t === 'test_artifacts' && String(c) === GUARD_COLS,
  });
  sbStub.__setStub(dbErr);
  s3.__reset();
  const r1 = await callFinalize({ diagnosticUserId: UID, testType: 'blood', testDate: DATE, originalKey: okey('blood', DATE), parts: PARTS, deliver: true });
  ok(r1.status === 503, '**503 を返す**', String(r1.status));
  ok(r1.json.error === 'elith_guard_unverifiable', "error = 'elith_guard_unverifiable'", String(r1.json.error));
  ok(r1.json.delivered === false, 'delivered = false', String(r1.json.delivered));
  ok(s3._written.length === 0, '**S3 write が 0** (source JSON も書いていない)', JSON.stringify(s3._written));
  ok(!s3._written.some((k) => k.includes('BloodTestData')), '   BloodTestData のキーも当然 0');

  // (b) Supabase そのものが引けない → 503
  sbStub.__setStub(null);
  s3.__reset();
  const r2 = await callFinalize({ diagnosticUserId: UID, testType: 'blood', testDate: DATE, originalKey: okey('blood', DATE), parts: PARTS, deliver: true });
  ok(r2.status >= 400, 'Supabase 無しでも Elith へ出さない', String(r2.status));
  ok(!s3._written.some((k) => k.includes('BloodTestData')), '   S3 に BloodTestData を書かない', JSON.stringify(s3._written));

  // (c) **派生 artifact と確認できた** → 409 / S3 write 0
  const dbDerived = makeDb({
    test_artifacts: [
      { id: 'hc-y', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: DATE, status: 'active', source: 'user_upload', imported_by: 'user' },
      { id: PROD_ART_0924, diagnostic_user_id: UID, test_type: 'blood', test_date: DATE, status: 'active', source: 'user_upload', imported_by: DERIVED },
    ],
  });
  sbStub.__setStub(dbDerived);
  s3.__reset();
  /*
   * **候補除外と書き込み禁止が効くので、derived の枝は API 経由では到達しない**
   * (= 多重防御が働いている証拠)。それだと規則の本体が一度も動かないので直接呼ぶ。
   */
  const gDerived = await FINALIZE.elithBloodGuard(PROD_ART_0924, 'blood');
  ok(gDerived.ok === false && gDerived.kind === 'derived',
    '**派生と確認できたら derived で止まる** (409 の枝)', JSON.stringify(gDerived));
  const gNormal = await FINALIZE.elithBloodGuard('n-ok', 'blood');
  ok(gNormal.ok === false, '(先に通常 blood の行を置いていないので止まる)', JSON.stringify(gNormal.kind));
  dbDerived.tables.test_artifacts.push({ id: 'n-ok', diagnostic_user_id: UID, test_type: 'blood', test_date: '2026-01-10', status: 'active', source: 'wellfort_lab', imported_by: 'wellfort_admin_upload' });
  const gNormal2 = await FINALIZE.elithBloodGuard('n-ok', 'blood');
  ok(gNormal2.ok === true, '**通常 blood は関門を通る** (§16 を壊していない)', JSON.stringify(gNormal2));
  const gHc = await FINALIZE.elithBloodGuard('missing-id', 'health_checkup');
  ok(gHc.ok === true, '**blood 以外は照会せずに通す** (存在しない id でも通る)', JSON.stringify(gHc));
  const gMissing = await FINALIZE.elithBloodGuard('missing-id', 'blood');
  ok(gMissing.ok === false && gMissing.kind === 'unverifiable',
    '**blood で行が無ければ unverifiable** (fail-closed)', JSON.stringify(gMissing));

  // (d) **blood 以外には fail-closed を適用しない** — 照会が落ちても止めない
  orig.__setOk(true);
  const dbErrHc = makeDb({
    test_artifacts: [{ id: 'hc-z', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: DATE, status: 'active', source: 'user_upload', imported_by: 'user' }],
    failSelect: (t, c) => t === 'test_artifacts' && String(c) === GUARD_COLS,
  });
  sbStub.__setStub(dbErrHc);
  s3.__reset();
  const r4 = await callFinalize({ diagnosticUserId: UID, testType: 'health_checkup', testDate: DATE, originalKey: okey('health_checkup', DATE), parts: PARTS, deliver: true });
  ok(r4.json.error !== 'elith_guard_unverifiable',
    '**health_checkup は fail-closed の対象外** (DB の瞬断で無関係な登録を落とさない)', String(r4.json.error ?? 'なし'));
}

console.log('\n⑩-2 ② backfill: 処理済みの照会が落ちたら何も書かない');
{
  const call = async (body) => {
    const res = await BACKFILL.POST({ request: new Request('http://x/b', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) });
    return { status: res.status, json: await res.json() };
  };
  // 派生一覧の select (`test_date` のみ) だけを落とす
  const DERIVED_COLS = 'test_date, external_test_id';
  for (const mode of ['pending', 'one']) {
    const db = makeDb({
      test_artifacts: [{ ...HC_ROW }],
      failSelect: (t, c) => t === 'test_artifacts' && String(c) === DERIVED_COLS,
    });
    sbStub.__setStub(db);
    const r = await call({ diagnosticUserId: UID, mode, ...(mode === 'one' ? { testDate: DATE } : {}), confirm: true });
    ok(r.status === 500 && r.json.error === 'db_error',
      `**mode='${mode}': 500 db_error で終わる** (未処理 0 件として扱わない)`, `${r.status} ${r.json.error}`);
    ok(db.tables.test_artifacts.filter((a) => a.test_type === 'blood').length === 0,
      '   **persistDerivedBloodArtifact を 1 回も呼んでいない** (blood artifact 0 件)');
    ok(db.tables.measurement_values.length === 0, '   measurement_values も 0 件');
  }
}

console.log('\n⑩-3 ③ mode=one でも既存の active 派生は作り直さない');
{
  const call = async (body) => {
    const res = await BACKFILL.POST({ request: new Request('http://x/b', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) });
    return { status: res.status, json: await res.json() };
  };
  // **本番と同じ 2 件**を seed する
  const db = seedProduction();
  sbStub.__setStub(db);
  const idsBefore = db.tables.test_artifacts.map((a) => a.id).join(',');
  const mvBefore = db.tables.measurement_values.filter((x) => x.artifact_id === PROD_ART_0924).length;

  for (const [date, label] of [[DATE, '2026-09-24'], [PROD_DATE_0917, '2026-09-17']]) {
    const r = await call({ diagnosticUserId: UID, mode: 'one', testDate: date, confirm: true });
    ok(r.status === 200 && r.json.already_processed === true,
      `**${label}: already_processed で何も書かない**`, `${r.status} ${JSON.stringify(r.json.already_processed)}`);
    ok((r.json.targets ?? []).length === 0, '   対象 0 件');
  }
  ok(db.tables.test_artifacts.map((a) => a.id).join(',') === idsBefore,
    '**artifact の id が 1 つも増減していない** (作り直し・置換なし)',
    `before=${idsBefore.split(',').length} after=${db.tables.test_artifacts.length}`);
  ok(db.tables.test_artifacts.find((a) => a.id === PROD_ART_0924)?.status === 'active',
    `   ${PROD_ART_0924} は active のまま`);
  ok(db.tables.measurement_values.filter((x) => x.artifact_id === PROD_ART_0924).length === mvBefore,
    `   その測定値も ${mvBefore} 件のまま (入れ替えていない)`);

  // **superseded の派生は「処理済み」に数えない** = 通常 blood に差し替わった回は再処理できる
  const db2 = seedProduction();
  db2.tables.test_artifacts.find((a) => a.id === PROD_ART_0924).status = 'superseded';
  sbStub.__setStub(db2);
  const r3 = await call({ diagnosticUserId: UID, mode: 'one', testDate: DATE, confirm: false });
  ok(r3.json.already_processed !== true,
    'superseded の派生は処理済みに数えない (再処理できる)', String(r3.json.already_processed));

  // **再生成の口が無い**こと
  const src = readFileSync('src/pages/api/admin/derived-blood/backfill.ts', 'utf8');
  ok(!/\breplace\b/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')),
    '**`replace` のような再生成の口を作っていない**');
}

/* ══════════════════════════════════════════════════════════════════
   ⑪ 入力グループ (「N枚目」) ごとの分割 — 発注者指示 2026-10-03 §3〜§16
   ══════════════════════════════════════════════════════════════════ */

/**
 * **本番の 2026-09-17 と同じ構造の fixture** (§16)。
 * 1 件の health_checkup に**独立した健診結果が 2 通**入っている
 * (`joinPageMarkdown` が付けた `## 1枚目` / `## 2枚目` が境界)。
 *
 * 【ここが壊れていた】2 通をまとめて `extractBloodSubset` に渡すと、
 * LDL 96 と 102 のように**通ごとに違う値**が「同じ項目の別値」に見えて
 * `value_conflict` で両方落ち、**15 項目のうち 2 項目しか残らなかった**。
 *
 * 1枚目の γ は原本どおり **`γ-GT`** と印字してある (様式ゆれ。マスタの同義語に
 * 足したので `γ-GTP` に当たるはず = ここが落ちたら同義語が外れたということ)。
 */
const MD_TWO_SHEETS = `## 1枚目

### 血液検査

| No | 検査項目 | 検査項目詳細 | 読み取った値 | 単位 | 下限値 | 上限値 | 判定 | 備考 |
|----|----------|--------------|--------------|------|--------|--------|------|------|
| 1 | AST | AST(GOT) | 20 | U/L | 13 | 30 | - | - |
| 2 | ALT | ALT(GPT) | 20 | U/L | 10 | 42 | - | - |
| 3 | γ-GT | γ-GT | 21 | U/L | 13 | 64 | - | - |
| 4 | LDL | LDLコレステロール | 96 | mg/dL | 70 | 139 | - | - |
| 5 | HDL | HDLコレステロール | 75.2 | mg/dL | 40 | 96 | - | - |
| 6 | 総コレステロール | 総コレステロール | 159 | mg/dL | 142 | 219 | - | - |
| 7 | 中性脂肪 | 空腹時中性脂肪 | 72 | mg/dL | 30 | 149 | - | - |
| 8 | 血糖 | 空腹時血糖 | 97 | mg/dL | 73 | 99 | - | - |
| 9 | クレアチニン | クレアチニン | 1.06 | mg/dL | 0.65 | 1.07 | - | - |
| 10 | eGFR | eGFR | 55.6 | mL/min | 60 | - | L | - |
| 11 | 尿酸 | 尿酸 | 7.7 | mg/dL | 3.7 | 7.0 | H | - |

### 身体計測

| No | 検査項目 | 検査項目詳細 | 読み取った値 | 単位 | 下限値 | 上限値 | 判定 | 備考 |
|----|----------|--------------|--------------|------|--------|--------|------|------|
| 1 | 身長 | 身長 | 172.4 | cm | - | - | - | - |
| 2 | 尿検査 | 尿蛋白 | (-) | - | - | - | - | - |

## 2枚目

### 血液検査

| No | 検査項目 | 検査項目詳細 | 読み取った値 | 単位 | 下限値 | 上限値 | 判定 | 備考 |
|----|----------|--------------|--------------|------|--------|--------|------|------|
| 1 | AST | AST(GOT) | 19 | U/L | 13 | 30 | - | - |
| 2 | ALT | ALT(GPT) | 20 | U/L | 10 | 42 | - | - |
| 3 | γ-GTP | γ-GTP | 26 | U/L | 13 | 64 | - | - |
| 4 | LDL | LDLコレステロール | 102 | mg/dL | 70 | 139 | - | - |
| 5 | HDL | HDLコレステロール | 83.2 | mg/dL | 40 | 96 | - | - |
| 6 | 総コレステロール | 総コレステロール | 196 | mg/dL | 142 | 219 | - | - |
| 7 | 中性脂肪 | 空腹時中性脂肪 | 54 | mg/dL | 30 | 149 | - | - |
| 8 | 血糖 | 空腹時血糖 | 104 | mg/dL | 73 | 99 | H | - |
| 9 | クレアチニン | クレアチニン | 1.03 | mg/dL | 0.65 | 1.07 | H | - |
| 10 | eGFR | eGFR | 56.9 | mL/min | 60 | - | L | - |
| 11 | 尿酸 | 尿酸 | 7.8 | mg/dL | 3.7 | 7.0 | H | - |
`;

/** 「1枚目 / ページ2」「1枚目 / ページ3」= **同じ 1 枚目** (内部ページで割らない)。 */
const MD_INNER_PAGES = `## 1枚目 / ページ2

| No | 検査項目 | 検査項目詳細 | 読み取った値 | 単位 | 下限値 | 上限値 | 判定 | 備考 |
|----|----------|--------------|--------------|------|--------|--------|------|------|
| 1 | AST | AST(GOT) | 20 | U/L | 13 | 30 | - | - |

## 1枚目 / ページ3

| No | 検査項目 | 検査項目詳細 | 読み取った値 | 単位 | 下限値 | 上限値 | 判定 | 備考 |
|----|----------|--------------|--------------|------|--------|--------|------|------|
| 1 | 尿酸 | 尿酸 | 7.7 | mg/dL | 3.7 | 7.0 | H | - |
`;

const EXPECT_A = {
  'GOT(AST)': 20, 'GPT(ALT)': 20, 'γ-GTP': 21,
  LDLコレステロール: 96, HDLコレステロール: 75.2, 総コレステロール: 159,
  中性脂肪: 72, 空腹時血糖: 97, クレアチニン: 1.06, eGFR: 55.6, 尿酸: 7.7,
};
const EXPECT_B = {
  'GOT(AST)': 19, 'GPT(ALT)': 20, 'γ-GTP': 26,
  LDLコレステロール: 102, HDLコレステロール: 83.2, 総コレステロール: 196,
  中性脂肪: 54, 空腹時血糖: 104, クレアチニン: 1.03, eGFR: 56.9, 尿酸: 7.8,
};
/** 15 項目のうち**この 4 つは原本に無い** → 行ごと作らない (0 補完禁止・推測計算禁止)。 */
const ABSENT_4 = ['総蛋白', 'アルブミン', 'HbA1c(NGSP)', '尿素窒素'];

console.log('\n⑪-A 分割の境界は「N枚目」だけ (値からは割らない)');
{
  const EX = await bundle('src/lib/elith-export.ts', 'bs-export.mjs');
  const g = EX.measurementGroupsFromMarkdown(MD_TWO_SHEETS);
  ok(g.length === 2, '**2 通の原本 → 2 グループ**', `n=${g.length}`);
  ok(g[0]?.index === 1 && g[1]?.index === 2, 'グループ番号は原本の「N枚目」の数字', `${g[0]?.index}/${g[1]?.index}`);
  ok(/1枚目/.test(String(g[0]?.label)) && /2枚目/.test(String(g[1]?.label)), '見出しの文字列を持っている',
    `${g[0]?.label} / ${g[1]?.label}`);
  // 1枚目には身体計測の 2 行が付く = 「見出しの無い region は直前のグループ」
  const n0 = (g[0]?.kept ?? []).map((x) => String(x.name));
  ok(n0.includes('身長'), '**`## 1枚目` 配下の別の表も同じグループに入る**', n0.join(','));
  ok(!(g[1]?.kept ?? []).some((x) => String(x.name) === '身長'), '   2 枚目には混ざらない');

  // 番号の取り方 (全角・内部ページ付き・無関係な見出し)
  ok(EX.sheetGroupNumber('1枚目') === 1, "'1枚目' → 1");
  ok(EX.sheetGroupNumber('２枚目') === 2, "全角 '２枚目' → 2");
  ok(EX.sheetGroupNumber('1枚目 / ページ2') === 1, "'1枚目 / ページ2' → 1");
  ok(EX.sheetGroupNumber('1枚目／ページ2') === 1, '全角スラッシュでも 1');
  ok(EX.sheetGroupNumber('血液検査') === null, "'血液検査' は境界ではない");
  ok(EX.sheetGroupNumber('ページ2') === null, "**'ページ2' は境界ではない** (内部ページで割らない)");
  ok(EX.sheetGroupNumber('3枚目の所見') === null, "'3枚目の所見' は境界にしない (完全な形だけ)");

  // **1 枚しか無い回は 1 グループ** = 従来と同じ
  const one = EX.measurementGroupsFromMarkdown(MD);
  ok(one.length === 1 && one[0]?.index === 1, '**「N枚目」が無い原本 → 1 グループ**', `n=${one.length}`);

  // **`measurementsFromMarkdown` は 1 行も変えていない** = health_checkup 側は不変
  const whole = EX.measurementsFromMarkdown(MD_TWO_SHEETS);
  const sum = g.reduce((a, x) => a + x.kept.length, 0);
  ok(whole.kept.length === sum,
    '**全グループの合計 = まとめて整形した件数** (分割で取りこぼさない)',
    `${whole.kept.length} vs ${sum}`);
}

console.log('\n⑪-B 内部ページ (`ページ2` / `ページ3`) では割らない');
{
  const EX = await bundle('src/lib/elith-export.ts', 'bs-export.mjs');
  const g = EX.measurementGroupsFromMarkdown(MD_INNER_PAGES);
  ok(g.length === 1, '**`1枚目 / ページ2` と `1枚目 / ページ3` は同じ 1 グループ**', `n=${g.length}`);
  const names = (g[0]?.kept ?? []).map((x) => String(x.name));
  ok(names.includes('AST(GOT)') && names.includes('尿酸'), '   両方の表の行が入っている', names.join(','));
}

console.log('\n⑪-C value_conflict は**グループの中だけ**で見る');
{
  const EX = await bundle('src/lib/elith-export.ts', 'bs-export.mjs');
  // まとめて渡すと LDL 96/102 が競合して落ちる (これが本番で起きていた形)
  const whole = SUB.extractBloodSubset(EX.measurementsFromMarkdown(MD_TWO_SHEETS).kept);
  ok(whole.kept.length < 11,
    '**まとめて渡すと競合で落ちる** (壊れていた形を固定しておく)',
    `kept=${whole.kept.length} excluded=${(whole.excluded ?? []).length}`);
  ok((whole.excluded ?? []).some((e) => e.reason === 'value_conflict' && e.name === 'LDLコレステロール'),
    '   LDL が value_conflict で落ちる', JSON.stringify((whole.excluded ?? []).map((e) => e.name)));

  // グループごとに渡せば 11 項目ずつ残る
  const g = EX.measurementGroupsFromMarkdown(MD_TWO_SHEETS);
  const a = SUB.extractBloodSubset(g[0]?.kept ?? []);
  const b = SUB.extractBloodSubset(g[1]?.kept ?? []);
  ok(a.kept.length === 11 && b.kept.length === 11,
    '**グループごとなら 11 項目ずつ** (跨ぎの値は競合にしない)', `${a.kept.length}/${b.kept.length}`);
  ok((a.excluded ?? []).length === 0 && (b.excluded ?? []).length === 0,
    '   どちらのグループにも除外が無い',
    JSON.stringify([...(a.excluded ?? []), ...(b.excluded ?? [])]));

  // **グループの中の競合は従来どおり落とす** (緩めていない)
  const inGroup = SUB.extractBloodSubset([
    m('LDLコレステロール', 96, 'mg/dL'), m('LDLコレステロール', 102, 'mg/dL'), m('尿酸', 7.7, 'mg/dL'),
  ]);
  ok(!inGroup.kept.some((x) => x.name === 'LDLコレステロール'),
    '**同じグループの中で値が割れたら従来どおり除外** (捏造ゼロ)',
    JSON.stringify(inGroup.excluded));
  ok(inGroup.kept.some((x) => x.name === '尿酸'), '   他の項目は残る');
}

console.log('\n⑪-D 本番 2026-09-17 と同じ fixture → 派生 blood が 2 件');
{
  const db = makeDb({
    test_artifacts: [{
      id: 'hc-0917-2', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: PROD_DATE_0917,
      source: 'user_upload', status: 'active', imported_by: 'user', scan_md: MD_TWO_SHEETS, measurements: [],
    }],
  });
  sbStub.__setStub(db);
  const r = await PERSIST.persistDerivedBloodArtifact(db, {
    diagnosticUserId: UID, testDate: PROD_DATE_0917, parentArtifactId: 'hc-0917-2',
    sourceGroups: PERSIST.toDerivedBloodGroups({ scanMd: MD_TWO_SHEETS, measurements: [] }),
  });
  ok(r.created === true, '作られた', JSON.stringify(r.reason ?? ''));
  ok(r.groupCount === 2, '**入力グループは 2 件**', String(r.groupCount));
  ok((r.siblings ?? []).length === 2 && r.siblings.every((s) => s.created),
    '**sibling 2 件とも作られた**', JSON.stringify((r.siblings ?? []).map((s) => [s.groupIndex, s.created])));
  const blood = db.tables.test_artifacts.filter((a) => a.test_type === 'blood');
  ok(blood.length === 2, '**blood artifact が 2 件**', String(blood.length));
  ok(blood.every((a) => a.imported_by === DERIVED && a.status === 'active' && a.test_date === PROD_DATE_0917),
    '   2 件とも marker 付き・active・同じ受診日');
  ok(new Set(blood.map((a) => a.external_test_id)).size === 2,
    '**external_test_id が別** (UNIQUE がこれで効く)', JSON.stringify(blood.map((a) => a.external_test_id)));
  ok(blood.every((a) => SUB.derivedBloodParentId(a.external_test_id) === 'hc-0917-2'),
    '   どちらも親 artifact を指している');
  ok(blood.map((a) => SUB.derivedBloodGroupIndex(a.external_test_id)).sort().join(',') === '1,2',
    '   グループ番号は 1 / 2');

  const vals = (gi) => {
    const art = blood.find((a) => SUB.derivedBloodGroupIndex(a.external_test_id) === gi);
    if (!art) return {};
    return Object.fromEntries(db.tables.measurement_values
      .filter((x) => x.artifact_id === art.id).map((x) => [x.item_name, x.value_num]));
  };
  const A = vals(1), B = vals(2);
  ok(Object.keys(A).length === 11, '**A (1枚目) = 11 項目**', String(Object.keys(A).length));
  ok(Object.keys(B).length === 11, '**B (2枚目) = 11 項目**', String(Object.keys(B).length));
  for (const [k, v] of Object.entries(EXPECT_A)) ok(A[k] === v, `   A ${k} = ${v}`, `実測 ${A[k]}`);
  for (const [k, v] of Object.entries(EXPECT_B)) ok(B[k] === v, `   B ${k} = ${v}`, `実測 ${B[k]}`);
  for (const n of ABSENT_4) {
    ok(!(n in A) && !(n in B), `   **${n} の行が無い** (0 補完・推測計算をしない)`);
  }
  ok(!Object.values(A).includes(0) && !Object.values(B).includes(0), '   value_num=0 の行が 1 件も無い');
  ok(!('身長' in A) && !('尿蛋白' in A), '   15 項目以外 (身長 / 尿蛋白) は入れない');
  ok(db.tables.test_artifacts.find((a) => a.id === 'hc-0917-2')?.scan_md === MD_TWO_SHEETS,
    '**元の health_checkup は不変**');
}

console.log('\n⑪-E sibling は消し合わない / 冪等');
{
  const groups = PERSIST.toDerivedBloodGroups({ scanMd: MD_TWO_SHEETS, measurements: [] });
  const mk = () => makeDb({
    test_artifacts: [{
      id: 'hc-0917-2', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: PROD_DATE_0917,
      source: 'user_upload', status: 'active', imported_by: 'user', scan_md: MD_TWO_SHEETS, measurements: [],
    }],
  });
  const db = mk();
  sbStub.__setStub(db);
  const call = (only) => PERSIST.persistDerivedBloodArtifact(db, {
    diagnosticUserId: UID, testDate: PROD_DATE_0917, parentArtifactId: 'hc-0917-2',
    sourceGroups: groups, ...(only ? { onlyGroups: only } : {}),
  });
  // グループ 1 だけ → 次にグループ 2 だけ (backfill の差分補完と同じ形)
  await call([1]);
  ok(db.tables.test_artifacts.filter((a) => a.test_type === 'blood').length === 1, 'グループ 1 だけ作ると 1 件');
  const idG1 = db.tables.test_artifacts.find((a) => a.test_type === 'blood')?.id;
  await call([2]);
  const blood = db.tables.test_artifacts.filter((a) => a.test_type === 'blood');
  ok(blood.length === 2, '**グループ 2 を足しても 1 は消えない**', String(blood.length));
  ok(blood.some((a) => a.id === idG1), `   ${'グループ 1 の artifact が残っている'}`);
  ok(db.tables.measurement_values.length === 22, '   測定値は 11 + 11 = 22 件', String(db.tables.measurement_values.length));

  // 全グループを 3 回流しても 2 件のまま (冪等)
  const db2 = mk();
  sbStub.__setStub(db2);
  for (let i = 0; i < 3; i++) {
    await PERSIST.persistDerivedBloodArtifact(db2, {
      diagnosticUserId: UID, testDate: PROD_DATE_0917, parentArtifactId: 'hc-0917-2', sourceGroups: groups,
    });
  }
  ok(db2.tables.test_artifacts.filter((a) => a.test_type === 'blood').length === 2,
    '**3 回流しても blood は 2 件** (冪等)',
    String(db2.tables.test_artifacts.filter((a) => a.test_type === 'blood').length));
  ok(db2.tables.measurement_values.length === 22, '   測定値も 22 件のまま', String(db2.tables.measurement_values.length));

  // **親が変わる再送でも増えない** (saveScanResult は id を取り直す)
  const db3 = mk();
  sbStub.__setStub(db3);
  await PERSIST.persistDerivedBloodArtifact(db3, {
    diagnosticUserId: UID, testDate: PROD_DATE_0917, parentArtifactId: 'hc-old', sourceGroups: groups,
  });
  await PERSIST.persistDerivedBloodArtifact(db3, {
    diagnosticUserId: UID, testDate: PROD_DATE_0917, parentArtifactId: 'hc-new', sourceGroups: groups,
  });
  const b3 = db3.tables.test_artifacts.filter((a) => a.test_type === 'blood');
  ok(b3.length === 2, '**親 id が変わる再送でも 2 件** (前の親の派生が残らない)', String(b3.length));
  ok(b3.every((a) => SUB.derivedBloodParentId(a.external_test_id) === 'hc-new'),
    '   新しい親の sibling に入れ替わっている', JSON.stringify(b3.map((a) => a.external_test_id)));
  ok(db3.tables.measurement_values.length === 22, '   測定値も 22 件 (古い分は cascade で消えた)',
    String(db3.tables.measurement_values.length));
}

console.log('\n⑪-F 片方のグループから 0 件なら、そのグループだけ作らない');
{
  const MD_MIXED = `## 1枚目

### 画像所見

| No | 検査項目 | 検査項目詳細 | 読み取った値 | 単位 | 下限値 | 上限値 | 判定 | 備考 |
|----|----------|--------------|--------------|------|--------|--------|------|------|
| 1 | 胸部X線 | 胸部X線 | 所見なし | - | - | - | - | - |

## 2枚目

### 血液検査

| No | 検査項目 | 検査項目詳細 | 読み取った値 | 単位 | 下限値 | 上限値 | 判定 | 備考 |
|----|----------|--------------|--------------|------|--------|--------|------|------|
| 1 | 尿酸 | 尿酸 | 7.8 | mg/dL | 3.7 | 7.0 | H | - |
`;
  const db = makeDb({
    test_artifacts: [{
      id: 'hc-mix', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: DATE,
      source: 'user_upload', status: 'active', imported_by: 'user', scan_md: MD_MIXED, measurements: [],
    }],
  });
  sbStub.__setStub(db);
  const r = await PERSIST.persistDerivedBloodArtifact(db, {
    diagnosticUserId: UID, testDate: DATE, parentArtifactId: 'hc-mix',
    sourceGroups: PERSIST.toDerivedBloodGroups({ scanMd: MD_MIXED, measurements: [] }),
  });
  ok(r.created === true && r.groupCount === 2, '2 グループのうち片方だけ作る', JSON.stringify([r.created, r.groupCount]));
  ok(db.tables.test_artifacts.filter((a) => a.test_type === 'blood').length === 1,
    '**blood artifact は 1 件だけ**', String(db.tables.test_artifacts.filter((a) => a.test_type === 'blood').length));
  const s1 = (r.siblings ?? []).find((s) => s.groupIndex === 1);
  ok(s1 && s1.created === false && s1.reason === 'no_items',
    "   1 枚目は created:false / reason:'no_items' (黙らせない)", JSON.stringify(s1));
  ok(SUB.derivedBloodGroupIndex(
    db.tables.test_artifacts.find((a) => a.test_type === 'blood')?.external_test_id) === 2,
    '   作られたのは 2 枚目ぶん');

  // 両方 0 件なら 1 件も作らない
  const dbz = makeDb({ test_artifacts: [{ id: 'hc-z', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: DATE, source: 'user_upload', status: 'active', imported_by: 'user', scan_md: MD_MIXED.replace('尿酸 | 尿酸 | 7.8', '胸部X線 | 胸部X線 | 所見なし'), measurements: [] }] });
  sbStub.__setStub(dbz);
  const rz = await PERSIST.persistDerivedBloodArtifact(dbz, {
    diagnosticUserId: UID, testDate: DATE, parentArtifactId: 'hc-z',
    sourceGroups: PERSIST.toDerivedBloodGroups({ scanMd: dbz.tables.test_artifacts[0].scan_md, measurements: [] }),
  });
  ok(rz.created === false && rz.reason === 'no_items', "どのグループも 0 件なら reason:'no_items'", JSON.stringify(rz.reason));
  ok(dbz.tables.test_artifacts.filter((a) => a.test_type === 'blood').length === 0, '   blood artifact 0 件');
}

console.log('\n⑪-G 同日に通常 blood が在れば**どのグループも**作らない (裁定 Q-10 は不変)');
{
  const db = makeDb({
    test_artifacts: [
      { id: 'hc-0917-2', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: PROD_DATE_0917, source: 'user_upload', status: 'active', imported_by: 'user', scan_md: MD_TWO_SHEETS, measurements: [] },
      { id: 'n-0917', diagnostic_user_id: UID, test_type: 'blood', test_date: PROD_DATE_0917, source: 'wellfort_lab', status: 'active', imported_by: 'wellfort_admin_upload' },
    ],
  });
  sbStub.__setStub(db);
  const r = await PERSIST.persistDerivedBloodArtifact(db, {
    diagnosticUserId: UID, testDate: PROD_DATE_0917, parentArtifactId: 'hc-0917-2',
    sourceGroups: PERSIST.toDerivedBloodGroups({ scanMd: MD_TWO_SHEETS, measurements: [] }),
  });
  ok(r.created === false && r.reason === 'normal_blood_exists', "reason:'normal_blood_exists'", JSON.stringify(r.reason));
  ok(db.tables.test_artifacts.filter((a) => a.imported_by === DERIVED).length === 0, '**派生は 1 件も作らない**');
  ok(db.tables.test_artifacts.find((a) => a.id === 'n-0917')?.status === 'active', '通常 blood は無傷');
  ok(db.tables.measurement_values.length === 0, '測定値も書いていない');

  // 通常が後から届いたら **sibling 2 件とも** 降りる
  const db2 = makeDb({
    test_artifacts: [
      { id: 'd-g1', diagnostic_user_id: UID, test_type: 'blood', test_date: PROD_DATE_0917, source: 'user_upload', status: 'active', imported_by: DERIVED, external_test_id: SUB.derivedBloodExternalTestId('hc-x', 1) },
      { id: 'd-g2', diagnostic_user_id: UID, test_type: 'blood', test_date: PROD_DATE_0917, source: 'user_upload', status: 'active', imported_by: DERIVED, external_test_id: SUB.derivedBloodExternalTestId('hc-x', 2) },
    ],
  });
  sbStub.__setStub(db2);
  const sup = await PERSIST.supersedeDerivedBloodOnSameDate(db2, UID, PROD_DATE_0917);
  ok(sup.superseded === 2, '**sibling 2 件とも superseded**', String(sup.superseded));
  ok(db2.tables.test_artifacts.every((a) => a.status === 'superseded'), '   行は残っている (消さない)');
}

console.log('\n⑪-H 新規スキャン保存 (saveScanResult) でも 2 件になる');
{
  const db = makeDb();
  sbStub.__setStub(db);
  const r = await PERSIST.saveScanResult(db, {
    diagnosticUserId: UID, markdownClean: MD_TWO_SHEETS, examDate: PROD_DATE_0917,
  });
  ok(r.artifactId != null, 'health_checkup が保存された');
  ok(r.derivedBlood?.created === true && r.derivedBlood?.groupCount === 2,
    '**派生 blood が 2 グループぶん作られた**', JSON.stringify([r.derivedBlood?.created, r.derivedBlood?.groupCount]));
  const blood = db.tables.test_artifacts.filter((a) => a.test_type === 'blood');
  ok(blood.length === 2, '   blood artifact 2 件', String(blood.length));
  ok(blood.every((a) => SUB.derivedBloodParentId(a.external_test_id) === r.artifactId),
    '   親 = 保存した health_checkup の id');
  ok(db.tables.measurement_values.filter((x) => x.test_type === 'blood').length === 22,
    '   blood の測定値 22 行', String(db.tables.measurement_values.filter((x) => x.test_type === 'blood').length));
  // **health_checkup 側はまとめた 1 件のまま** (分割は派生だけの話)
  ok(db.tables.test_artifacts.filter((a) => a.test_type === 'health_checkup').length === 1,
    '**health_checkup は 1 件のまま** (分割しない)');
  const hcVals = db.tables.measurement_values.filter((x) => x.test_type === 'health_checkup');
  ok(hcVals.some((x) => x.item_name === '空腹時中性脂肪'),
    '   health_checkup 側は 空腹時中性脂肪 のまま (書き換えない)');
  ok(hcVals.filter((x) => x.item_name === 'LDLコレステロール').length === 2,
    '**health_checkup 側は LDL 96 / 102 の 2 行がそのまま残る** (競合で落とさない)',
    JSON.stringify(hcVals.filter((x) => x.item_name === 'LDLコレステロール').map((x) => x.value_num)));

  // 再送しても増えない
  await PERSIST.saveScanResult(db, { diagnosticUserId: UID, markdownClean: MD_TWO_SHEETS, examDate: PROD_DATE_0917 });
  ok(db.tables.test_artifacts.filter((a) => a.test_type === 'blood').length === 2,
    '**再送しても blood は 2 件**', String(db.tables.test_artifacts.filter((a) => a.test_type === 'blood').length));
  ok(db.tables.measurement_values.filter((x) => x.test_type === 'blood').length === 22,
    '   測定値も 22 行のまま', String(db.tables.measurement_values.filter((x) => x.test_type === 'blood').length));
}

console.log('\n⑪-I backfill の処理済み判定はグループ単位');
{
  const call = async (body) => {
    const res = await BACKFILL.POST({ request: new Request('http://x/b', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) });
    return { status: res.status, json: await res.json() };
  };
  const HC2 = {
    id: 'hc-0917-2', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: PROD_DATE_0917,
    source: 'user_upload', status: 'active', imported_by: 'user', scan_md: MD_TWO_SHEETS, measurements: GOLDEN_11,
  };

  // ① 2 グループとも未処理 → preview がグループごとの内訳を出す
  {
    const db = makeDb({ test_artifacts: [{ ...HC2 }] });
    sbStub.__setStub(db);
    const p = await call({ diagnosticUserId: UID, mode: 'one', testDate: PROD_DATE_0917 });
    ok(p.json.targets?.[0]?.group_count === 2, '**preview が入力グループ 2 件と答える**', String(p.json.targets?.[0]?.group_count));
    ok(JSON.stringify(p.json.targets?.[0]?.missing_groups) === '[1,2]', '   未処理グループ = [1,2]',
      JSON.stringify(p.json.targets?.[0]?.missing_groups));
    const gs = p.json.targets?.[0]?.would_create?.groups ?? [];
    ok(gs.length === 2 && gs[0].count === 11 && gs[1].count === 11,
      '   作る予定はグループごとに 11 項目', JSON.stringify(gs.map((x) => [x.group, x.count])));
    ok(db.tables.test_artifacts.filter((a) => a.test_type === 'blood').length === 0, '   preview は何も書かない');

    const a = await call({ diagnosticUserId: UID, mode: 'one', testDate: PROD_DATE_0917, confirm: true });
    ok(a.json.mode === 'applied' && db.tables.test_artifacts.filter((x) => x.test_type === 'blood').length === 2,
      '**apply で 2 件できる**', String(db.tables.test_artifacts.filter((x) => x.test_type === 'blood').length));

    // もう一度 → already_processed (作り直さない)
    const again = await call({ diagnosticUserId: UID, mode: 'one', testDate: PROD_DATE_0917, confirm: true });
    ok(again.json.already_processed === true, '**全グループ済みなら already_processed**', String(again.json.already_processed));
    ok(db.tables.test_artifacts.filter((x) => x.test_type === 'blood').length === 2, '   2 件のまま');
  }

  // ② グループ 1 だけ済み → **欠けている 2 だけ**作る
  {
    const db = makeDb({
      test_artifacts: [
        { ...HC2 },
        { id: 'd-g1', diagnostic_user_id: UID, test_type: 'blood', test_date: PROD_DATE_0917, source: 'user_upload', status: 'active', imported_by: DERIVED, external_test_id: SUB.derivedBloodExternalTestId('hc-0917-2', 1) },
      ],
      measurement_values: [
        { artifact_id: 'd-g1', diagnostic_user_id: UID, test_type: 'blood', test_date: PROD_DATE_0917, seq: 0, item_name: '尿酸', canonical_name: '尿酸', value: '7.7', value_num: 7.7 },
      ],
    });
    sbStub.__setStub(db);
    const p = await call({ diagnosticUserId: UID, mode: 'one', testDate: PROD_DATE_0917 });
    ok(p.json.already_processed !== true, '**1 件在っても「処理済み」にしない**', String(p.json.already_processed));
    ok(JSON.stringify(p.json.targets?.[0]?.missing_groups) === '[2]', '   未処理グループ = [2]',
      JSON.stringify(p.json.targets?.[0]?.missing_groups));

    const a = await call({ diagnosticUserId: UID, mode: 'one', testDate: PROD_DATE_0917, confirm: true });
    ok(a.json.mode === 'applied', 'apply できる');
    ok(db.tables.test_artifacts.some((x) => x.id === 'd-g1'), '**既にあったグループ 1 を作り直していない**');
    ok(db.tables.measurement_values.filter((x) => x.artifact_id === 'd-g1').length === 1,
      '   その測定値も入れ替えていない', String(db.tables.measurement_values.filter((x) => x.artifact_id === 'd-g1').length));
    ok(db.tables.test_artifacts.filter((x) => x.test_type === 'blood').length === 2, '   blood は 2 件になった');

    // pending も同じ判断
    const db2 = makeDb({
      test_artifacts: [
        { ...HC2 },
        { id: 'd-g1', diagnostic_user_id: UID, test_type: 'blood', test_date: PROD_DATE_0917, source: 'user_upload', status: 'active', imported_by: DERIVED, external_test_id: SUB.derivedBloodExternalTestId('hc-0917-2', 1) },
      ],
    });
    sbStub.__setStub(db2);
    const pend = await call({ diagnosticUserId: UID, mode: 'pending' });
    ok((pend.json.targets ?? []).length === 1, "**pending も「欠けたグループがある回」を拾う**",
      String((pend.json.targets ?? []).length));
    ok(JSON.stringify(pend.json.targets?.[0]?.missing_groups) === '[2]', '   未処理グループ = [2]',
      JSON.stringify(pend.json.targets?.[0]?.missing_groups));
  }

  // ③ **旧ロジック由来 (`external_test_id` なし) は自動では触らない**
  {
    const db = makeDb({
      test_artifacts: [
        { ...HC2 },
        { id: '9d350c7e-4de7-4cda-b854-5099f9687d06', diagnostic_user_id: UID, test_type: 'blood', test_date: PROD_DATE_0917, source: 'user_upload', status: 'active', imported_by: DERIVED, external_test_id: null },
      ],
    });
    sbStub.__setStub(db);
    const p = await call({ diagnosticUserId: UID, mode: 'one', testDate: PROD_DATE_0917, confirm: true });
    ok(p.json.already_processed === true && p.json.legacy_derived === true,
      '**旧ロジック由来は already_processed / legacy_derived**', JSON.stringify([p.json.already_processed, p.json.legacy_derived]));
    ok(db.tables.test_artifacts.filter((x) => x.test_type === 'blood').length === 1,
      '   **作り直し・追加をしない** (blood は 1 件のまま)', String(db.tables.test_artifacts.filter((x) => x.test_type === 'blood').length));
    ok(db.tables.test_artifacts.find((x) => x.id === '9d350c7e-4de7-4cda-b854-5099f9687d06')?.status === 'active',
      '   既存の行は active のまま (supersede もしない)');

    const pend = await call({ diagnosticUserId: UID, mode: 'pending', confirm: true });
    ok((pend.json.targets ?? []).length === 0, '   pending も対象にしない', String((pend.json.targets ?? []).length));
    ok(db.tables.test_artifacts.filter((x) => x.test_type === 'blood').length === 1, '   blood は 1 件のまま');
  }
}

console.log('\n⑪-J sibling が増えても Elith 全面除外は不変 (PR #296 を緩めていない)');
{
  const sib = (gi, id) => ({
    id, diagnostic_user_id: UID, test_type: 'blood', test_date: PROD_DATE_0917,
    source: 'user_upload', status: 'active', imported_by: DERIVED,
    external_test_id: SUB.derivedBloodExternalTestId('hc-0917-2', gi),
  });
  // ① 判定そのもの
  ok(SUB.isDerivedHealthcheckBlood(sib(1, 'd-g1')) && SUB.isDerivedHealthcheckBlood(sib(2, 'd-g2')),
    '**sibling 2 件とも派生と判定される** (`imported_by` だけで見る)');
  ok(!SUB.isDerivedHealthcheckBlood({ test_type: 'blood', imported_by: 'wellfort_admin_upload', external_test_id: SUB.derivedBloodExternalTestId('hc', 1) }),
    '**`external_test_id` だけが派生の形でも、marker が無ければ派生ではない** (判定は marker 一本)');

  // ② readiness
  const db = makeDb({ test_artifacts: [sib(1, 'd-g1'), sib(2, 'd-g2')] });
  sbStub.__setStub(db);
  const ready = await ENT.checkFormatsReady([UID], new Map([[UID, ['BloodTestData']]]));
  ok(ready[UID]?.ready === false && (ready[UID]?.missing ?? []).includes('BloodTestData'),
    '**sibling が 2 件在っても BloodTestData は ready にならない**', JSON.stringify(ready[UID]));

  // ③ 最終関門 (fail-closed)
  const g1 = await FINALIZE.elithBloodGuard('d-g1', 'blood');
  const g2 = await FINALIZE.elithBloodGuard('d-g2', 'blood');
  ok(g1.ok === false && g1.kind === 'derived', '**sibling 1 は関門で止まる**', JSON.stringify(g1));
  ok(g2.ok === false && g2.kind === 'derived', '**sibling 2 も関門で止まる**', JSON.stringify(g2));

  // ④ 引けなかったら通さない (fail-closed のまま)
  const dbFail = makeDb({
    test_artifacts: [sib(1, 'd-g1')],
    failSelect: (t, c) => t === 'test_artifacts' && String(c).includes('imported_by'),
  });
  sbStub.__setStub(dbFail);
  const gf = await FINALIZE.elithBloodGuard('d-g1', 'blood');
  ok(gf.ok === false && gf.kind === 'unverifiable', '**確認できなければ通さない**', JSON.stringify(gf));
}

/* ══════════════════════════════════════════════════════════════════
   ⑫ 発注者レビュー 2026-10-03 ①②③
   ══════════════════════════════════════════════════════════════════ */
const RESULTS = await bundle('src/lib/result-queries.ts', 'bs-results.mjs');

console.log('\n⑫-① backfill の legacy 判定は「旧ロジック由来が在る日」だけ');
{
  const call = async (body) => {
    const res = await BACKFILL.POST({ request: new Request('http://x/b', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) });
    return { status: res.status, json: await res.json() };
  };
  /*
   * **同じ受診日に health_checkup が 2 件** (source 違いなので両方 active で居られる)。
   *   A … 新方式 sibling g1 / g2 が**全部**在る
   *   B … 派生が 1 件も無い
   * 旧実装は「その日に派生が在る」= legacy と見ていたので、**B まで触らない**扱いになっていた。
   */
  const hc = (id, source) => ({
    id, diagnostic_user_id: UID, test_type: 'health_checkup', test_date: PROD_DATE_0917,
    source, status: 'active', imported_by: 'user', scan_md: MD, measurements: GOLDEN_11,
  });
  const sib = (id, parent, gi) => ({
    id, diagnostic_user_id: UID, test_type: 'blood', test_date: PROD_DATE_0917,
    source: 'user_upload', status: 'active', imported_by: DERIVED,
    external_test_id: SUB.derivedBloodExternalTestId(parent, gi),
  });
  const mk = () => makeDb({
    test_artifacts: [
      hc('hc-A', 'user_upload'), hc('hc-B', 'admin_batch'),
      sib('d-A-g1', 'hc-A', 1), sib('d-A-g2', 'hc-A', 2),
    ],
  });

  const db = mk();
  sbStub.__setStub(db);
  const pend = await call({ diagnosticUserId: UID, mode: 'pending' });
  const tB = (pend.json.targets ?? []).find((t) => t.health_checkup_artifact_id === 'hc-B');
  const tA = (pend.json.targets ?? []).find((t) => t.health_checkup_artifact_id === 'hc-A');
  ok(tB != null, '**B (派生が無い) は pending の対象になる**', JSON.stringify((pend.json.targets ?? []).map((t) => t.health_checkup_artifact_id)));
  ok(tB?.legacy_derived === false, '   **B を legacy 扱いしない**', String(tB?.legacy_derived));
  ok(tA == null, '   A (全グループ済み) は対象外');

  const db2 = mk();
  sbStub.__setStub(db2);
  const applied = await call({ diagnosticUserId: UID, mode: 'pending', confirm: true });
  ok(applied.json.mode === 'applied', 'apply できる', String(applied.json.mode));
  ok(db2.tables.test_artifacts.some((a) => a.id === 'd-A-g1') && db2.tables.test_artifacts.some((a) => a.id === 'd-A-g2'),
    '**A の sibling 2 件は作り直されていない**');
  const bSibs = db2.tables.test_artifacts.filter((a) => SUB.derivedBloodParentId(a.external_test_id) === 'hc-B');
  ok(bSibs.length === 1, '   B の派生が 1 件できた (MD は 1 グループ)', String(bSibs.length));

  // **旧ロジック由来が在る日は従来どおり触らない** (①の修正で緩めていないこと)
  const db3 = makeDb({
    test_artifacts: [
      hc('hc-A', 'user_upload'), hc('hc-B', 'admin_batch'),
      sib('d-A-g1', 'hc-A', 1), sib('d-A-g2', 'hc-A', 2),
      { id: 'd-legacy', diagnostic_user_id: UID, test_type: 'blood', test_date: PROD_DATE_0917,
        source: 'user_upload', status: 'active', imported_by: DERIVED, external_test_id: null },
    ],
  });
  sbStub.__setStub(db3);
  const pend3 = await call({ diagnosticUserId: UID, mode: 'pending', confirm: true });
  ok((pend3.json.targets ?? []).length === 0,
    '**同じ日に旧ロジック由来が在れば、やはり誰も触らない**', String((pend3.json.targets ?? []).length));
  ok(db3.tables.test_artifacts.filter((a) => a.test_type === 'blood').length === 3,
    '   blood は 3 件のまま', String(db3.tables.test_artifacts.filter((a) => a.test_type === 'blood').length));

  // **解析できない external_test_id も legacy 扱い** (NULL だけではない)
  const db4 = makeDb({
    test_artifacts: [
      hc('hc-B', 'admin_batch'),
      { id: 'd-odd', diagnostic_user_id: UID, test_type: 'blood', test_date: PROD_DATE_0917,
        source: 'user_upload', status: 'active', imported_by: DERIVED, external_test_id: 'derived_hc:broken' },
    ],
  });
  sbStub.__setStub(db4);
  const pend4 = await call({ diagnosticUserId: UID, mode: 'pending' });
  ok((pend4.json.targets ?? []).length === 0,
    "**`derived_hc:<親>:g<N>` として解析できない行も legacy**", String((pend4.json.targets ?? []).length));
}

console.log('\n⑫-② 同日 sibling は同じ系列に 2 点。表示名だけで見分ける');
{
  // 表示用の文字 (純関数)
  ok(SUB.derivedBloodMark(1) === '①' && SUB.derivedBloodMark(2) === '②', '丸番号は ① / ②',
    `${SUB.derivedBloodMark(1)}/${SUB.derivedBloodMark(2)}`);
  ok(SUB.derivedBloodSuffix(1) === '（抽出1）' && SUB.derivedBloodSuffix(2) === '（抽出2）',
    '接尾辞は （抽出1） / （抽出2）', `${SUB.derivedBloodSuffix(1)}/${SUB.derivedBloodSuffix(2)}`);
  ok(SUB.derivedBloodMark(21) === '(21)', '⑳ を超えたら素の形 (作字しない)', SUB.derivedBloodMark(21));
  ok(SUB.derivedBloodMark(0) === '' && SUB.derivedBloodSuffix(-1) === '', '0 以下は空');

  /*
   * **9/17① 96 / 9/17② 102 / 9/24 116** が 1 系列 3 点で出ること。
   * 平均しない・捨てない・別系列に分けない。
   */
  const sib = (id, gi) => ({
    id, diagnostic_user_id: UID, test_type: 'blood', test_date: PROD_DATE_0917,
    source: 'user_upload', status: 'active', imported_by: DERIVED,
    external_test_id: SUB.derivedBloodExternalTestId('hc-0917', gi),
  });
  const mv = (artifact_id, test_date, value_num) => ({
    artifact_id, diagnostic_user_id: UID, test_type: 'blood', test_date, seq: 0,
    item_name: 'LDLコレステロール', canonical_name: 'LDLコレステロール',
    value: String(value_num), value_num, unit: 'mg/dL',
    ref_low: null, ref_high: null, ref_low_num: null, ref_high_num: null, flag: null,
    assessment: null, source_file_kind: 'scan_md',
  });
  // **DB が g2 を先に返す**順で seed する (並べ替えが効いているかを見るため)
  const db = makeDb({
    test_artifacts: [
      sib('d-g2', 2), sib('d-g1', 1),
      { id: 'd-0924', diagnostic_user_id: UID, test_type: 'blood', test_date: DATE,
        source: 'user_upload', status: 'active', imported_by: DERIVED,
        external_test_id: SUB.derivedBloodExternalTestId('hc-0924', 1) },
    ],
    measurement_values: [
      mv('d-g2', PROD_DATE_0917, 102), mv('d-g1', PROD_DATE_0917, 96), mv('d-0924', DATE, 116),
    ],
  });
  sbStub.__setStub(db);
  const series = await QUERIES.getMeasurementTrend(UID, ['LDLコレステロール'], 12, 'blood');
  ok(series.length === 1, '**系列は 1 本** (別系列に分けない)', String(series.length));
  const pts = series[0]?.points ?? [];
  ok(pts.length === 3, '**点は 3 つ** (平均しない・捨てない)', JSON.stringify(pts.map((p) => p.value)));
  ok(pts.map((p) => p.value).join(',') === '96,102,116',
    '**並びは 9/17① 96 → 9/17② 102 → 9/24 116**', pts.map((p) => p.value).join(','));
  ok(pts[0]?.groupIndex === 1 && pts[1]?.groupIndex === 2,
    '   点に表示用の groupIndex が付く', JSON.stringify([pts[0]?.groupIndex, pts[1]?.groupIndex]));
  ok(pts.every((p) => p.source === 'health_checkup_scan'), '   3 点とも「人間ドックから抽出」');

  // **DB の返す順が逆でも同じ並び** (決定的であること)
  const dbRev = makeDb({
    test_artifacts: [
      sib('d-g1', 1), sib('d-g2', 2),
      { id: 'd-0924', diagnostic_user_id: UID, test_type: 'blood', test_date: DATE,
        source: 'user_upload', status: 'active', imported_by: DERIVED,
        external_test_id: SUB.derivedBloodExternalTestId('hc-0924', 1) },
    ],
    measurement_values: [
      mv('d-g1', PROD_DATE_0917, 96), mv('d-g2', PROD_DATE_0917, 102), mv('d-0924', DATE, 116),
    ],
  });
  sbStub.__setStub(dbRev);
  const rev = await QUERIES.getMeasurementTrend(UID, ['LDLコレステロール'], 12, 'blood');
  ok((rev[0]?.points ?? []).map((p) => p.value).join(',') === '96,102,116',
    '**seed の順を入れ替えても同じ並び** (決定的)', (rev[0]?.points ?? []).map((p) => p.value).join(','));

  // **1 件しか無い日には groupIndex を出さない表示規則** (= グラフ側の dup 判定)
  const dup = (s) => {
    const n = new Map();
    for (const p of s.points) n.set(p.date, (n.get(p.date) ?? 0) + 1);
    return new Set([...n.entries()].filter(([, c]) => c >= 2).map(([d]) => d));
  };
  const dd = dup(series[0]);
  ok(dd.has(PROD_DATE_0917) && !dd.has(DATE),
    '**見分けを付けるのは 9/17 だけ** (9/24 は 1 件なので付けない)', JSON.stringify([...dd]));

  // 表示側の配線 (壊したら落ちる番人)
  const chart = readFileSync('src/components/dashboard/MetricTrendChart.astro', 'utf8');
  ok(/derivedBloodMark/.test(chart) && /derivedBloodSuffix/.test(chart),
    'グラフが表示名の関数を使っている (文言を写していない)');
  ok(/\{ymd\(p\.date\)\}\{markOf\(p, d\.dup\)\}/.test(chart),
    '**拡大グラフの X 軸ラベルに ①② が付く**');
  ok(/\{jpDate\(r\.date\)\}\{suffixOf\(r, d\.dup\)\}/.test(chart),
    '**履歴テーブルの検査日に （抽出1） が付く**');
  /*
   * **`markOf` と `suffixOf` の両方で dup を見ていること**を別々に固定する。
   * 「どこかに dup の判定がある」だけを見ると、片方を外しても通ってしまう
   * (実際に退行注入 T-8 がすり抜けた)。
   */
  for (const fn of ['markOf', 'suffixOf']) {
    const body = new RegExp(`const ${fn} = [^;]*?dup\\.has\\(p\\.date\\) && p\\.groupIndex != null`, 's');
    ok(body.test(chart), `**${fn} が「同じ日が 2 つ以上」を見ている** (1 件なら付けない)`);
  }
}

console.log('\n⑫-③ Dashboard の同日 sibling 順序が決定的・2 件あることが分かる');
{
  const sib = (id, gi) => ({
    id, diagnostic_user_id: UID, test_type: 'blood', test_date: PROD_DATE_0917,
    source: 'user_upload', status: 'active', imported_by: DERIVED,
    external_test_id: SUB.derivedBloodExternalTestId('hc-0917', gi),
  });

  // orderDerivedSiblings そのもの
  // **純関数なので `blood-subset` が持つ** (読み出し側が取得直後に 1 回通す)。
  const O = SUB.orderDerivedSiblings;
  ok(O([sib('d-g2', 2), sib('d-g1', 1)]).map((a) => a.id).join(',') === 'd-g1,d-g2',
    '**グループ番号の昇順に並べ直す**', O([sib('d-g2', 2), sib('d-g1', 1)]).map((a) => a.id).join(','));
  ok(O([sib('d-g1', 1), sib('d-g2', 2)]).map((a) => a.id).join(',') === 'd-g1,d-g2',
    '   既に昇順なら変わらない');
  // **派生以外の並びは 1 つも動かない**
  const others = [
    { id: 'x1', test_type: 'blood', test_date: PROD_DATE_0917, imported_by: 'wellfort_admin_upload' },
    { id: 'x2', test_type: 'blood', test_date: PROD_DATE_0917, imported_by: 'wellfort_admin_upload' },
    { id: 'hc', test_type: 'health_checkup', test_date: PROD_DATE_0917, imported_by: 'user' },
    { id: 'z', test_type: 'blood', test_date: null, imported_by: 'user' },
  ];
  ok(O(others).map((a) => a.id).join(',') === 'x1,x2,hc,z',
    '**派生でない行は位置も相対順も動かさない**', O(others).map((a) => a.id).join(','));
  const mixedIn = [others[0], sib('d-g2', 2), others[2], sib('d-g1', 1), others[1]];
  ok(O(mixedIn).map((a) => a.id).join(',') === 'x1,d-g1,hc,d-g2,x2',
    '**sibling は「元から派生が居た枠」の中だけで入れ替わる**', O(mixedIn).map((a) => a.id).join(','));
  ok(O([sib('d-g1', 1)]).map((a) => a.id).join(',') === 'd-g1', '1 件だけなら何もしない');

  // loadDashboard 経由 (DB が g2 を先に返す形)
  const db = makeDb({
    test_artifacts: [
      { id: 'hc-0917', diagnostic_user_id: UID, test_type: 'health_checkup', test_date: PROD_DATE_0917,
        source: 'user_upload', status: 'active', imported_by: 'user', scan_md: MD, measurements: GOLDEN_11 },
      sib('d-g2', 2), sib('d-g1', 1),
    ],
  });
  sbStub.__setStub(db);
  const d = await DASH.loadDashboard(UID);
  const blood = (d.artifacts ?? []).filter((a) => a.test_type === 'blood');
  ok(blood.length === 2, 'blood が 2 件', String(blood.length));
  ok(blood[0]?.id === 'd-g1',
    '**「データ」で最初に開くのは g1** (mine[0] が決定的)', String(blood[0]?.id));
  // 画面側 (TestResultsSection) の配線
  const sec = readFileSync('src/components/dashboard/TestResultsSection.astro', 'utf8');
  ok(/sameDayDerived/.test(sec) && /DERIVED_HC_BLOOD_LABEL/.test(sec),
    '検査カードが同日の件数を出している');
  ok(/c\.sameDayDerived >= 2/.test(sec),
    '**同日 2 件以上のときだけ「人間ドックから抽出・N件」を出す**');
  ok(!/\.sort\(/.test(sec), '**画面側で並べ替えていない** (並べるのは 1 か所)');

  /*
   * 詳細画面の sibling 切替。**`loadResult` は artifact_id に UUID を要求する**
   * (他人の結果を id 当てで開けないようにしている・`result-queries.ts:180`) ので、
   * ここだけ実在の形の UUID を使う。
   */
  const G1 = '11111111-1111-4111-8111-111111111111';
  const G2 = '22222222-2222-4222-8222-222222222222';
  const OTHER = '33333333-3333-4333-8333-333333333333';
  const uuidSib = (id, gi) => ({ ...sib(id, gi) });
  sbStub.__setStub(makeDb({
    test_artifacts: [
      uuidSib(G2, 2), uuidSib(G1, 1),
      { id: OTHER, diagnostic_user_id: UID, test_type: 'blood', test_date: DATE,
        source: 'user_upload', status: 'active', imported_by: DERIVED,
        external_test_id: SUB.derivedBloodExternalTestId('hc-0924', 1) },
    ],
  }));
  const r = await RESULTS.loadResult(G1, UID);
  ok(!('error' in r), 'loadResult がエラーを返さない', JSON.stringify(r.error ?? ''));
  const sibs = r?.siblings ?? [];
  ok(sibs.length === 3, '**過去データに 3 件 (同日 2 件 + 別日 1 件)**', String(sibs.length));
  const same = sibs.filter((x) => x.testDate === PROD_DATE_0917);
  ok(same.length === 2 && same.map((x) => x.id).join(',') === `${G1},${G2}`,
    '**同日は g1 → g2 の順** (決定的)', same.map((x) => x.id).join(','));
  ok(same.map((x) => x.groupIndex).join(',') === '1,2',
    '   表示用の groupIndex が付く', same.map((x) => x.groupIndex).join(','));
  ok(sibs.some((x) => x.id === G2), '**g1 の画面から g2 へ辿れる** (切替先に居る)');
  const page = readFileSync('src/pages/result/[id].astro', 'utf8');
  ok(/siblingLabel\(sib\)/.test(page) && /derivedBloodSuffix/.test(page),
    '詳細画面が表示名の関数を使っている');
  ok(/dupSiblingDates\.has/.test(page),
    '**同じ日が 2 つ以上あるときだけ （抽出1） を添える**');
}

/* ── 結果 ────────────────────────────────────────────────────────── */
console.log(`\n${'='.repeat(60)}\nPASS ${pass} / FAIL ${fails.length}`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
console.log('すべて通りました。');
