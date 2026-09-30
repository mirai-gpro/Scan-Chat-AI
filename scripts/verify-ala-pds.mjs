#!/usr/bin/env node
/**
 * **がんリスク検査 ALA-PDS**（方式の切り替わり・推移グラフ・検査結果の数値表示）の検査。
 *
 * 【なぜ要るか（2026-09-30・発注者指示）】本田大作さんの `cancer_urine` は
 * **途中で方式が Noah4 → ALA-PDS に変わっている**。
 *
 *   2023-08-03 / 2024-06-10 / 2024-09-02 … Noah4（BMI・塩分・尿糖 …）
 *   2025-01-06 / 2025-08-04 / 2026-06-04 … ALA-PDS（尿中のポルフィリン量・インデックス値・リスクランク）
 *
 * 現行は `test_type='cancer_urine'` でしか絞らないので **方式をまたいで 1 本の線に混ざる**。
 * しかも `/result/[id]` は `scan_md`（アプリ内スキャンだけが書く）と原本 PDF しか出さず、
 * **admin 取込のがんリスク検査は値が画面のどこにも出ていなかった**。
 *
 * **どちらも静かに壊れる種類**（線は 1 本描かれる／画面はエラーを出さない）なので、
 * 実物のモジュールを動かして**点の数・値・並び**と**実際の HTML**を数える。
 *
 * 見るもの:
 *   ① ALA 判定は**日付でなく項目名**（完全一致・substring 禁止）
 *   ② インデックス値の `"0.9 / 8.0"` → `value_num = 0.9`（原本表記は書き換えない）
 *   ③ 推移グラフは **ALA の最新 2 件だけ** = 2 点（2025-01-06 は履歴に在るがグラフ外）
 *   ④ Noah4 の項目は候補にも系列にも出ない
 *   ⑤ ALA が無い利用者は絞らない（黙って空にしない）／他の検査種別に影響しない
 *   ⑥ **実際の SSR HTML**（stub Supabase を立てて dev サーバへ）で
 *      ダッシュボード 6 件・`/result/[id]` の数値・過去データ切替を見る
 */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const CACHE = 'node_modules/.cache';
mkdirSync(CACHE, { recursive: true });

const UID = '5d11742f-f196-450c-800b-d9ffa89ba64b';

/* ── 本田さんの実データ構成（発注者指示 2026-09-30）────────────────── */
const A = {
  n1: '11111111-1111-4111-8111-111111111111', // 2023-08-03 Noah4
  n2: '22222222-2222-4222-8222-222222222222', // 2024-06-10 Noah4
  n3: '33333333-3333-4333-8333-333333333333', // 2024-09-02 Noah4
  a1: '44444444-4444-4444-8444-444444444444', // 2025-01-06 ALA-PDS
  a2: '55555555-5555-4555-8555-555555555555', // 2025-08-04 ALA-PDS ← 今回追加
  a3: '66666666-6666-4666-8666-666666666666', // 2026-06-04 ALA-PDS ← 最新
};
const ARTIFACTS = [
  { id: A.a3, test_date: '2026-06-04', ext: 'K0442' },
  { id: A.a2, test_date: '2025-08-04', ext: 'K0326' },
  { id: A.a1, test_date: '2025-01-06', ext: 'K0198' },
  { id: A.n3, test_date: '2024-09-02', ext: null },
  { id: A.n2, test_date: '2024-06-10', ext: null },
  { id: A.n1, test_date: '2023-08-03', ext: null },
];

/** Noah4 の測定項目（ALA グラフへ絶対に混ぜてはいけないもの）。 */
const NOAH = [
  { a: A.n1, d: '2023-08-03', items: [['BMI', 22.1, ''], ['塩分摂取量', 8.7, 'g'], ['尿糖', null, ''], ['尿蛋白', null, '']] },
  { a: A.n2, d: '2024-06-10', items: [['BMI', 22.4, ''], ['1日の塩分摂取量', 8.4, 'g'], ['尿潜血', null, '']] },
  { a: A.n3, d: '2024-09-02', items: [['BMI', 22.0, ''], ['1日の食塩摂取量', 8.7, 'g']] },
];
/** ALA-PDS 3 回分。**インデックス値は原本どおり分数表記**で入れる。 */
const ALA = [
  { a: A.a1, d: '2025-01-06', porph: 1210, idx: '1.1 / 8.0', idxNum: 1.1, rank: 'A' },
  { a: A.a2, d: '2025-08-04', porph: 1134, idx: '0.9 / 8.0', idxNum: 0.9, rank: 'A' },
  { a: A.a3, d: '2026-06-04', porph: 965,  idx: '0.8 / 8.0', idxNum: 0.8, rank: 'A' },
];
const PORPH_UNIT = 'nmol/g・CRE';

function mv(artifact_id, test_date, seq, item_name, value, value_num, unit) {
  return {
    artifact_id, diagnostic_user_id: UID, test_type: 'cancer_urine', test_date, seq,
    item_name, canonical_name: null, value, value_num, unit,
    ref_low: null, ref_high: null, ref_low_num: null, ref_high_num: null,
    flag: null, assessment: null, source_file_kind: 'raw_pdf',
  };
}
const ROWS = [
  ...NOAH.flatMap((g) => g.items.map(([n, v, u], i) => mv(g.a, g.d, i, n, v == null ? null : String(v), v, u))),
  // **原本表記のゆれを再現**: 2025-01-06 だけ「の」無し。ALA 判定も系列も揺れてはいけない。
  ...ALA.flatMap((g, gi) => [
    mv(g.a, g.d, 0, gi === 0 ? '尿中ポルフィリン量' : '尿中のポルフィリン量', String(g.porph), g.porph, PORPH_UNIT),
    mv(g.a, g.d, 1, 'インデックス値', g.idx, g.idxNum, null),
    mv(g.a, g.d, 2, 'リスクランク', g.rank, null, null),
  ]),
];

let pass = 0;
const fails = [];
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? '  — ' + extra : ''}`); }
  else { fails.push(label); console.log(`  ✗ ${label}${extra ? '  — ' + extra : ''}`); }
};

/* ══════════════════════════════════════════════════════════════════
 * A 層: 決定論ロジック（サーバ不要）
 * ══════════════════════════════════════════════════════════════ */
await build({
  entryPoints: ['src/lib/ala-pds.ts'],
  bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
  define: { 'import.meta.env': '{}' },
  outfile: `${CACHE}/verify-ala-core.mjs`,
});
const ala = await import(`../${CACHE}/verify-ala-core.mjs`);

console.log('\n① ALA 判定は日付でなく項目名 (完全一致)');
{
  ok(ala.isAlaArtifact(['尿中のポルフィリン量', 'インデックス値', 'リスクランク']), '両方そろえば ALA');
  ok(ala.isAlaArtifact(['尿中ポルフィリン量', 'インデックス値']), '「の」無しの原本表記でも ALA');
  ok(!ala.isAlaArtifact(['尿中のポルフィリン量']), 'ポルフィリンだけでは ALA にしない');
  ok(!ala.isAlaArtifact(['インデックス値']), 'インデックス値だけでは ALA にしない');
  ok(!ala.isAlaArtifact(['BMI', '塩分摂取量', '尿糖', '尿蛋白', '尿潜血']), 'Noah4 は ALA でない');
  // **substring で拾わない** — ここが緩むと別項目まで ALA と誤認する
  ok(!ala.isAlaArtifact(['尿中のポルフィリン量の目安', 'インデックス値の目安']),
    '「〜の目安」を substring で拾わない');
  ok(!ala.isAlaArtifact(['尿中ポルフィリン', 'インデックス']), '前方一致でも拾わない');
  const order = ala.alaArtifactIdsNewestFirst(ROWS);
  ok(order.length === 3, 'ALA の回は 3 件', `n=${order.length}`);
  ok(order[0] === A.a3 && order[1] === A.a2 && order[2] === A.a1,
    'test_date 降順 (2026-06-04 → 2025-08-04 → 2025-01-06)');
}

console.log('\n② インデックス値の value_num (原本表記は書き換えない)');
{
  ok(ala.alaIndexValueNum('0.9 / 8.0') === 0.9, '"0.9 / 8.0" → 0.9');
  ok(ala.alaIndexValueNum('0.8 / 8.0') === 0.8, '"0.8 / 8.0" → 0.8');
  ok(ala.alaIndexValueNum('0.9／8.0') === 0.9, '全角スラッシュでも 0.9');
  ok(ala.alaIndexValueNum('0.9') === 0.9, '素の数値も受ける');
  ok(ala.alaIndexValueNum('2.0未満') === null, 'レンジ表現は数値化しない (目安表の閾値)');
  ok(ala.alaIndexValueNum('A') === null, '文字は null');
  ok(ala.alaIndexValueNum(null) === null, 'null は null');
  ok(ala.alaIndexValueNum('0.9 / 10.0') === null, '分母が 8 以外は受けない (別スケールを混ぜない)');
}

/* ══════════════════════════════════════════════════════════════════
 * B 層: 推移グラフ（実物の measurement-queries を動かす）
 * ══════════════════════════════════════════════════════════════ */
writeFileSync(`${CACHE}/ala-supabase-stub.mjs`, `export let _stub = null;
export function __setStub(s) { _stub = s; }
export function getServerSupabase() { return _stub; }
export function getBrowserSupabase() { return null; }
`);
writeFileSync(`${CACHE}/ala-demo-stub.mjs`, `export function demoFallbackEnabled() { return false; }
export function demoMetricTrend() { return []; }
export function demoArtifacts() { return []; }
`);
await build({
  entryPoints: ['src/lib/measurement-queries.ts'],
  bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
  define: { 'import.meta.env': '{}' },
  outfile: `${CACHE}/verify-ala-queries.mjs`,
  plugins: [{
    name: 'stub',
    setup(b) {
      b.onResolve({ filter: /(^|\/)supabase$/ }, () => ({ path: './ala-supabase-stub.mjs', external: true }));
      b.onResolve({ filter: /(^|\/)demo-data$/ }, () => ({ path: './ala-demo-stub.mjs', external: true }));
    },
  }],
});
const q = await import(`../${CACHE}/verify-ala-queries.mjs`);
const sbStub = await import(`../${CACHE}/ala-supabase-stub.mjs`);

function makeStub(rows, artifacts) {
  const table = (name) => {
    // **PostgREST と同じように絞る。** `.not('value_num','is',null)` を無視すると
    // 「リスクランク (value_num なし) が候補に出ない」を検査できない。
    let notNull = null;
    const eqs = {};
    const api = {
      select() { return api; },
      eq(col, val) { eqs[col] = val; return api; },
      in() { return api; },
      not(col, op, val) { if (op === 'is' && val === null) notNull = col; return api; },
      order() { return api; }, limit() { return api; },
      then(res) {
        let data = name === 'test_artifacts' ? artifacts.map((a) => ({ id: a.id })) : rows;
        if (name !== 'test_artifacts') {
          if (eqs.test_type) data = data.filter((r) => r.test_type === eqs.test_type);
          if (notNull) data = data.filter((r) => r[notNull] != null);
        }
        return Promise.resolve({ data, error: null }).then(res);
      },
    };
    return api;
  };
  return { schema: () => ({ from: table }), from: table };
}
sbStub.__setStub(makeStub(ROWS, ARTIFACTS));

console.log('\n③ 推移グラフは ALA の最新 2 件だけ');
{
  const s = await q.getMeasurementTrend(UID, ['尿中のポルフィリン量', 'インデックス値'], 12, 'cancer_urine');
  ok(s.length === 2, '系列は 2 本 (ポルフィリン / インデックス値)', `len=${s.length}`);
  const p = s.find((x) => x.label === '尿中のポルフィリン量');
  const i = s.find((x) => x.label === 'インデックス値');
  ok(p != null, 'ポルフィリンの系列がある');
  ok(i != null, 'インデックス値の系列がある');
  ok((p?.points.length ?? 0) === 2, 'ポルフィリンは **2 点**', `n=${p?.points.length}`);
  ok(p?.points.map((x) => x.value).join(' → ') === '1134 → 965',
    '1134 → 965', p?.points.map((x) => x.value).join(' → '));
  ok(p?.points.map((x) => x.date).join(',') === '2025-08-04,2026-06-04',
    '2025-08-04 → 2026-06-04', p?.points.map((x) => x.date).join(','));
  ok(p?.unit === PORPH_UNIT, `単位は ${PORPH_UNIT}`, String(p?.unit));
  ok((i?.points.length ?? 0) === 2, 'インデックス値も **2 点**', `n=${i?.points.length}`);
  ok(i?.points.map((x) => x.value).join(' → ') === '0.9 → 0.8',
    '0.9 → 0.8', i?.points.map((x) => x.value).join(' → '));
  ok(i?.points.every((x) => /\/ 8\.0$/.test(x.raw)), '**原本表記 "X / 8.0" は raw に残っている** (書き換えていない)',
    JSON.stringify(i?.points.map((x) => x.raw)));
  ok(i?.unit === '', 'インデックス値に単位を付けない', JSON.stringify(i?.unit));
  // 2025-01-06 は ALA だがグラフ外
  ok(!p?.points.some((x) => x.date === '2025-01-06'), '**2025-01-06 はグラフの点に含まれない**');
}

console.log('\n④ Noah4 を混ぜない');
{
  const c = await q.getTrendCandidates(UID, 'cancer_urine');
  ok(c.includes('尿中のポルフィリン量'), '候補に 尿中のポルフィリン量');
  ok(c.includes('インデックス値'), '候補に インデックス値');
  for (const n of ['BMI', '1日の塩分摂取量', '塩分摂取量', '1日の食塩摂取量', '尿糖', '尿蛋白', '尿潜血']) {
    ok(!c.includes(n), `候補に Noah4 の「${n}」が出ない`);
  }
  ok(!c.includes('リスクランク'), 'リスクランクは候補に出ない (value_num が無い = グラフ化しない)');
  ok(c.length === 2, '候補はちょうど 2 件', JSON.stringify(c));
  const noah = await q.getMeasurementTrend(UID, ['BMI', '1日の塩分摂取量'], 12, 'cancer_urine');
  ok(noah.length === 0, 'Noah4 の項目を名指しで引いても系列が出ない', `len=${noah.length}`);
}

console.log('\n⑤ 巻き込み防止 (ALA が無い人・他の検査種別)');
{
  // ALA が 1 件も無い人 → 絞らない (従来どおり Noah4 の推移が出る)
  sbStub.__setStub(makeStub(ROWS.filter((r) => ![A.a1, A.a2, A.a3].includes(r.artifact_id)),
    ARTIFACTS.filter((a) => ![A.a1, A.a2, A.a3].includes(a.id))));
  const only = await q.getMeasurementTrend(UID, ['BMI'], 12, 'cancer_urine');
  ok(only.length === 1 && only[0].points.length === 3,
    'ALA が 1 件も無い人は絞らない (BMI 3 点)', `n=${only[0]?.points.length}`);

  // test_type を指定しない呼び出しは絞らない (横断集計の挙動を変えない)
  sbStub.__setStub(makeStub(ROWS, ARTIFACTS));
  const all = await q.getMeasurementTrend(UID, ['BMI'], 12);
  ok(all.length === 1 && all[0].points.length === 3,
    'testType 未指定では絞らない (BMI 3 点のまま)', `n=${all[0]?.points.length}`);

  // 別種別のデータは ALA 判定の影響を受けない
  const blood = ROWS.map((r) => ({ ...r, test_type: 'blood' }));
  sbStub.__setStub(makeStub(blood, ARTIFACTS));
  const b = await q.getMeasurementTrend(UID, ['BMI'], 12, 'blood');
  ok(b.length === 1 && b[0].points.length === 3, '血液の推移は絞られない', `n=${b[0]?.points.length}`);
  sbStub.__setStub(makeStub(ROWS, ARTIFACTS));
}

/* ══════════════════════════════════════════════════════════════════
 * C 層: 保存側の value_num（実物の measurement-persist を動かす）
 * ══════════════════════════════════════════════════════════════ */
console.log('\n⑥ 保存: インデックス値に value_num が付く');
await build({
  entryPoints: ['src/lib/measurement-persist.ts'],
  bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
  define: { 'import.meta.env': '{}' },
  outfile: `${CACHE}/verify-ala-persist.mjs`,
});
{
  const persist = await import(`../${CACHE}/verify-ala-persist.mjs`);
  let inserted = [];
  let updated = null;
  const sb = {
    schema: () => ({
      from: (t) => ({
        update: (v) => ({ eq: () => { if (t === 'test_artifacts') updated = v; return Promise.resolve({ error: null }); } }),
        delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
        insert: (rows) => { inserted = rows; return Promise.resolve({ error: null }); },
      }),
    }),
  };
  await persist.persistMeasurements(sb, {
    artifactId: A.a2, diagnosticUserId: UID, testType: 'cancer_urine', testDate: '2025-08-04',
    measurements: [
      { name: '尿中のポルフィリン量', value: '1134', value_num: 1134, unit: PORPH_UNIT },
      { name: 'インデックス値', value: '0.9 / 8.0', value_num: null, unit: null },
      { name: 'リスクランク', value: 'A', value_num: null, unit: null },
    ],
    sourceFileKind: 'raw_pdf',
  });
  const idx = inserted.find((r) => r.item_name === 'インデックス値');
  ok(idx?.value_num === 0.9, 'インデックス値の value_num = 0.9', String(idx?.value_num));
  ok(idx?.value === '0.9 / 8.0', '**value は原本表記のまま**', String(idx?.value));
  ok(inserted.find((r) => r.item_name === 'リスクランク')?.value_num === null,
    'リスクランクは value_num を作らない (捏造ゼロ)');
  ok(inserted.find((r) => r.item_name === '尿中のポルフィリン量')?.value_num === 1134,
    'ポルフィリンは 1134');
  const jsonb = updated?.measurements;
  ok(Array.isArray(jsonb) && jsonb.length === 3, 'jsonb (test_artifacts.measurements) 側も 3 件',
    `n=${jsonb?.length}`);
  ok(jsonb?.find((m) => m.name === 'インデックス値')?.value === '0.9 / 8.0',
    'jsonb 側も原本表記のまま');

  // 他の検査種別では効かせない (同名の項目が偶然あっても触らない)
  inserted = [];
  await persist.persistMeasurements(sb, {
    artifactId: A.a2, diagnosticUserId: UID, testType: 'blood', testDate: '2025-08-04',
    measurements: [{ name: 'インデックス値', value: '0.9 / 8.0', value_num: null, unit: null }],
  });
  ok(inserted[0]?.value_num === null, 'cancer_urine 以外では value_num を作らない');
}

/* ══════════════════════════════════════════════════════════════════
 * D 層: 実際の SSR HTML（stub Supabase + dev サーバ）
 * ══════════════════════════════════════════════════════════════ */
console.log('\n⑦ 実際の SSR HTML');

const PORT_DB = 54329;
const PORT_APP = 4329;
const SECRET = 'verify-ala-pds-secret';

/** `measurements` を jsonb として持つ test_artifacts の行。 */
function artifactRow(a) {
  const rows = ROWS.filter((r) => r.artifact_id === a.id).sort((x, y) => x.seq - y.seq);
  return {
    id: a.id, diagnostic_user_id: UID, source: 'admin_batch', test_type: 'cancer_urine',
    test_date: a.test_date, external_test_id: a.ext, lab_name: 'プリベントメディカル',
    schema_version: '1.0', age_at_test: null, sex: null, display_mode: 'single',
    page_count: 1, imported_at: '2026-09-30T00:00:00Z', imported_by: 'wellfort_batch',
    status: 'active', notes: null, scan_md: null,
    measurements: rows.map((r) => ({
      name: r.item_name, value: r.value, value_num: r.value_num, unit: r.unit,
      ref_low: r.ref_low, ref_high: r.ref_high, flag: r.flag, assessment: r.assessment,
    })),
  };
}
const ART_ROWS = ARTIFACTS.map(artifactRow);

/** PostgREST の**このアプリが使う部分だけ**を返す stub。 */
const db = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const table = u.pathname.replace(/^\/rest\/v1\//, '');
  const eq = (k) => {
    const v = u.searchParams.get(k);
    return v == null ? null : v.replace(/^eq\./, '');
  };
  let data = [];
  if (table === 'test_artifacts') {
    data = ART_ROWS.filter((r) => {
      if (eq('id') && r.id !== eq('id')) return false;
      if (eq('diagnostic_user_id') && r.diagnostic_user_id !== eq('diagnostic_user_id')) return false;
      if (eq('status') && r.status !== eq('status')) return false;
      if (eq('test_type') && r.test_type !== eq('test_type')) return false;
      return true;
    });
    const ord = u.searchParams.get('order') ?? '';
    if (ord.startsWith('test_date')) {
      data = [...data].sort((a, b) => String(b.test_date).localeCompare(String(a.test_date)));
      if (ord.includes('.asc')) data.reverse();
    }
  } else if (table === 'measurement_values') {
    data = ROWS;
  }
  const single = (req.headers.accept ?? '').includes('vnd.pgrst.object');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(single ? (data[0] ?? null) : data));
});
await new Promise((r) => db.listen(PORT_DB, r));

const env = {
  ...process.env,
  PUBLIC_SUPABASE_URL: `http://127.0.0.1:${PORT_DB}`,
  PUBLIC_SUPABASE_ANON_KEY: 'anon-stub',
  SUPABASE_SERVICE_ROLE_KEY: 'service-stub',
  APP_SESSION_SECRET: SECRET,
  PUBLIC_DEMO_FALLBACK: 'false',   // デモ層を通さない (実データ経路を見る)
  ALLOW_UID_ENTRY: '',
};
const app = spawn('npx', ['astro', 'dev', '--port', String(PORT_APP), '--host', '127.0.0.1'],
  { env, stdio: ['ignore', 'pipe', 'pipe'] });
let appLog = '';
app.stdout.on('data', (d) => { appLog += d; });
app.stderr.on('data', (d) => { appLog += d; });

async function waitUp() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT_APP}/`, { redirect: 'manual' });
      if (r.status) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** `welltect_v` を実物の signViewer で作る。 */
async function cookie() {
  await build({
    entryPoints: ['src/lib/viewer.ts'], bundle: true, platform: 'node', format: 'esm',
    logLevel: 'error', define: { 'import.meta.env': JSON.stringify({ APP_SESSION_SECRET: SECRET }) },
    outfile: `${CACHE}/verify-ala-viewer.mjs`,
  });
  const v = await import(`../${CACHE}/verify-ala-viewer.mjs`);
  return `welltect_v=${await v.signViewer(UID, false)}`;
}

try {
  if (!(await waitUp())) {
    console.log('  ✗ dev サーバが起動しなかった');
    console.log(appLog.slice(-1500));
    fails.push('dev サーバ起動');
  } else {
    const ck = await cookie();
    /*
     * **1 回の失敗で落とさない。** dev サーバは起動直後に依存を解決し直すことがあり、
     * 最初の 1 リクエストが ECONNRESET になる (実測)。**検査の対象ではない揺れ**なので
     * 短く数回だけ待って引き直す。
     */
    const get = async (p) => {
      let last;
      for (let i = 0; i < 5; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${PORT_APP}${p}`, { headers: { cookie: ck } });
          return { status: r.status, html: await r.text() };
        } catch (e) { last = e; await new Promise((z) => setTimeout(z, 800)); }
      }
      throw last;
    };
    // 実ページで 1 回暖機してから測る。
    await get('/dashboard').catch(() => null);

    console.log('\n  ⑦-1 ダッシュボード');
    const dash = await get('/dashboard');
    ok(dash.status === 200, '/dashboard が 200', String(dash.status));
    ok(dash.html.includes('がんリスク検査'), 'がんリスク検査のカードが在る');
    ok(dash.html.includes('2026年6月4日'), '**最新 = 2026-06-04**');
    ok(dash.html.includes(`/result/${A.a3}`), '「データ」が最新 (2026-06-04) の artifact を指す',
      `${A.a3.slice(0, 8)}…`);
    ok(!dash.html.includes(`/result/${A.a2}`) && !dash.html.includes(`/result/${A.a1}`),
      'カードは最新 1 件だけを指す (過去回は /result 側)');
    ok(dash.html.includes(`/trend?type=cancer_urine`), 'グラフのボタンが出ている');
    ok(!dash.html.includes(UID), 'ダッシュボードの HTML に uid が出ない (2026-09-29 の改修を壊していない)');

    console.log('\n  ⑦-2 /result/<2026-06-04>');
    const r3 = await get(`/result/${A.a3}`);
    ok(r3.status === 200, '200', String(r3.status));
    ok(r3.html.includes('検査結果の数値'), '**「検査結果の数値」の節が出る** (以前は何も出なかった)');
    ok(r3.html.includes('尿中のポルフィリン量'), '尿中のポルフィリン量');
    ok(r3.html.includes('965'), '965');
    ok(r3.html.includes('nmol/g・CRE'), 'nmol/g・CRE');
    ok(r3.html.includes('インデックス値'), 'インデックス値');
    ok(r3.html.includes('0.8 / 8.0'), '**0.8 / 8.0**（原本表記のまま）');
    ok(r3.html.includes('リスクランク'), 'リスクランク');
    ok(/リスクランク[\s\S]{0,200}>A</.test(r3.html), 'リスクランク A');
    ok(!r3.html.includes('スキャン処理中'), '「処理中」を出さない');
    /*
     * 列とプレースホルダの検査は**「検査結果の数値」の節の中だけ**を見る。
     * ページ全体で grep すると、無関係な箇所 (レイアウト等) の文字を拾って
     * **退行と関係なく落ちる**。
     */
    const sect = (html) => {
      const i = html.indexOf('検査結果の数値');
      const j = html.indexOf('</section>', i);
      return i < 0 ? '' : html.slice(i, j < 0 ? html.length : j);
    };
    const s3 = sect(r3.html);
    ok(s3.includes('<th') && s3.includes('項目') && s3.includes('値'), '表の見出しは 項目 / 値');
    ok(!s3.includes('基準値'), '基準値の列を作らない (ALA は基準値を持たない)');
    ok(!s3.includes('検査機関の判定'), '判定の列も作らない (ALA は flag も assessment も持たない)');
    ok(!s3.includes('—'), 'プレースホルダ「—」を置かない');

    console.log('\n  ⑦-3 過去データの切替');
    ok(r3.html.includes('過去データ'), '過去データの節が在る');
    for (const a of ARTIFACTS) {
      const label = a.test_date.replace(/^(\d+)-0?(\d+)-0?(\d+)$/, '$1年$2月$3日');
      ok(r3.html.includes(label), `過去データに ${a.test_date} が在る`, label);
    }
    ok(r3.html.includes('全 6 回'), '**全 6 回**と出る');
    for (const a of ARTIFACTS.filter((x) => x.id !== A.a3)) {
      ok(r3.html.includes(`/result/${a.id}`), `${a.test_date} へのリンクが在る`);
    }

    console.log('\n  ⑦-4 /result/<2025-08-04> (今回追加した回)');
    const r2 = await get(`/result/${A.a2}`);
    ok(r2.status === 200, '200', String(r2.status));
    ok(r2.html.includes('1134'), '**1134**');
    ok(r2.html.includes('0.9 / 8.0'), '**0.9 / 8.0**');
    ok(r2.html.includes('nmol/g・CRE'), 'nmol/g・CRE');
    ok(/リスクランク[\s\S]{0,200}>A</.test(r2.html), 'リスクランク A');
    ok(!r2.html.includes('965'), '2026-06-04 の値が混ざっていない');

    console.log('\n  ⑦-5 Noah4 の回は従来どおり開ける');
    const rn = await get(`/result/${A.n1}`);
    ok(rn.status === 200, '200', String(rn.status));
    ok(rn.html.includes('BMI'), 'BMI が出る');
    ok(!rn.html.includes('尿中のポルフィリン量'), 'ALA の項目が混ざらない');

    console.log('\n  ⑦-6 /trend?type=cancer_urine');
    const tr = await get('/trend?type=cancer_urine');
    ok(tr.status === 200, '200', String(tr.status));
    ok(tr.html.includes('尿中のポルフィリン量'), 'ポルフィリンの系列が出る');
    ok(tr.html.includes('インデックス値'), 'インデックス値の系列が出る');
    ok(!tr.html.includes('>BMI<'), '**Noah4 の BMI が出ない**');
    ok(!/塩分/.test(tr.html), '**Noah4 の塩分が出ない**');
    ok(!tr.html.includes('2025年1月6日') && !tr.html.includes('2025-01-06'),
      '**2025-01-06 はグラフに出ない**');
  }
} finally {
  app.kill('SIGTERM');
  db.close();
}

console.log(`\n${fails.length === 0 ? `✓ ${pass} / ${pass} passed` : `✗ ${fails.length} 件 FAIL (${pass} passed)`}`);
if (fails.length) { console.error('\n落ちた検査:\n  - ' + fails.join('\n  - ')); process.exit(1); }
