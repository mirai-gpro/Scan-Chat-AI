#!/usr/bin/env node
/**
 * **既存 artifact への測定値の補完** (`persistIntoExistingArtifact`) の検査。
 *
 * 【なぜ要るか (2026-09-29・実障害)】本田さんのがんリスク 4 件は
 * `source='wellfort_lab'` の artifact が既に active で在るのに
 * `measurement_values` 0 件 / `measurements` NULL / `scan_md` NULL で、
 * ダッシュボードに出なかった。ここで `persistAdminBatchArtifact` を普通に流すと
 * `source='admin_batch'` の別 4 行が増えて **計 8 件**になる。
 *
 * **静かに壊れる種類の不具合なので、実際に関数を動かして書き込み操作を数える。**
 * Supabase を差し替えたスタブに対して走らせ、
 *   - `test_artifacts` に **insert が 1 回も起きない**
 *   - `test_artifacts` の update は **`scan_md` と `measurements` だけ**
 *     (`test_date` / `source` / `display_mode` / `external_test_id` / `lab_name` /
 *      `notes` / `status` を触らない)
 *   - `measurement_values` は **delete → insert** (冪等な総入れ替え)
 *   - uid / 種別 / 受診日が違えば **何も書かない**
 * を確かめる。
 */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';

const CACHE = 'node_modules/.cache';
mkdirSync(CACHE, { recursive: true });

/** 呼ばれた操作を全部記録する Supabase もどき。 */
const ops = [];
let artifactRow = null;
function makeStub() {
  ops.length = 0;
  const table = (name) => {
    const st = { name, filters: {} };
    const api = {
      select() { return api; },
      eq(col, val) { st.filters[col] = val; return api; },
      // **filters は参照で持つ。** `.delete().eq(...)` の順で呼ばれるので、
      // コピーすると eq が反映されず「絞り込み無し」に見えてしまう。
      update(patch) { ops.push({ op: 'update', table: name, patch, filters: st.filters }); return api; },
      insert(rows) { ops.push({ op: 'insert', table: name, rows: Array.isArray(rows) ? rows : [rows] }); return api; },
      delete() { ops.push({ op: 'delete', table: name, filters: st.filters }); return api; },
      async maybeSingle() { return { data: name === 'test_artifacts' ? artifactRow : null, error: null }; },
      async single() { return { data: name === 'test_artifacts' ? artifactRow : null, error: null }; },
      then(res) { return Promise.resolve({ data: [], error: null }).then(res); },
    };
    return api;
  };
  return { schema: () => ({ from: table }), from: table };
}

const stubPath = `${CACHE}/supabase-stub.mjs`;
writeFileSync(stubPath, `export let _stub = null;
export function __setStub(s) { _stub = s; }
export function getServerSupabase() { return _stub; }
export function getBrowserSupabase() { return null; }
`);

// `./supabase` の import をスタブへ差し替えて束ねる。
await build({
  entryPoints: ['src/lib/scan-persist.ts'],
  bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
  define: { 'import.meta.env': '{}' },
  outfile: `${CACHE}/verify-existing-artifact.mjs`,
  plugins: [{
    name: 'stub-supabase',
    setup(b) {
      // **external にする。** 束ねると別インスタンスになり、__setStub が届かない。
      b.onResolve({ filter: /(^|\/)supabase$/ }, () => ({ path: './supabase-stub.mjs', external: true }));
    },
  }],
});
const mod = await import(`../${CACHE}/verify-existing-artifact.mjs`);
const stubMod = await import(`../${stubPath}`);

let pass = 0;
const fails = [];
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  — ' + extra : ''}`); }
  else { fails.push(label); console.log(`FAIL  ${label}${extra ? '  — ' + extra : ''}`); }
};

const UID = '5d11742f-f196-450c-800b-d9ffa89ba64b';
const ART = '9b6bafd0-02d5-4865-92b1-377de1814913'; // 2023-08-03 U1449
const MEAS = [
  { name: '尿中ポルフィリン', value: '12.3', value_num: 12.3, unit: 'μg/gCr', ref_low: null, ref_high: '20', flag: null },
  { name: 'インデックス値', value: '0.8', value_num: 0.8, unit: null, ref_low: null, ref_high: null, flag: null },
];

// ── ① 正常系: 既存行に入る ────────────────────────────────────────
console.log('\n① 既存 artifact への補完');
artifactRow = { id: ART, diagnostic_user_id: UID, test_type: 'cancer_urine', test_date: '2023-08-03', status: 'active', source: 'wellfort_lab', display_mode: 'single' };
stubMod.__setStub(makeStub());
{
  const r = await mod.persistIntoExistingArtifact({
    artifactId: ART, diagnosticUserId: UID, testType: 'cancer_urine',
    markdownClean: '## がんリスク検査 2023-08-03\n\n| 項目 | 値 |\n|---|---|\n', measurements: MEAS, testDate: '2023-08-03',
  });
  ok(r.artifactId === ART && !r.mismatch && !r.reason, '既存の artifact ID をそのまま返す', JSON.stringify(r));
  ok(r.rows === MEAS.length, `measurement_values を ${MEAS.length} 行書く`, `rows=${r.rows}`);

  const inserts = ops.filter((o) => o.op === 'insert' && o.table === 'test_artifacts');
  ok(inserts.length === 0, '**test_artifacts に insert しない** (重複 8 件を作らない)', `insert=${inserts.length}`);

  const updates = ops.filter((o) => o.op === 'update' && o.table === 'test_artifacts');
  const touched = [...new Set(updates.flatMap((u) => Object.keys(u.patch)))].sort();
  ok(touched.join(',') === 'measurements,scan_md', '更新するのは scan_md と measurements だけ', touched.join(',') || 'なし');
  for (const col of ['test_date', 'source', 'lab_name', 'notes', 'display_mode', 'status', 'external_test_id']) {
    ok(!touched.includes(col), `${col} を書き換えない`);
  }
  const mvDel = ops.filter((o) => o.op === 'delete' && o.table === 'measurement_values');
  const mvIns = ops.filter((o) => o.op === 'insert' && o.table === 'measurement_values');
  ok(mvDel.length === 1 && mvIns.length === 1, 'measurement_values は delete → insert の総入れ替え (冪等)', `del=${mvDel.length} ins=${mvIns.length}`);
  ok(mvDel[0]?.filters?.artifact_id === ART, '消すのはこの artifact の行だけ', String(mvDel[0]?.filters?.artifact_id));
  const rows = mvIns[0]?.rows ?? [];
  ok(rows.every((x) => x.artifact_id === ART && x.diagnostic_user_id === UID && x.test_type === 'cancer_urine'),
    '書く行の artifact / uid / 種別が揃っている');
  ok(rows.every((x) => x.test_date === '2023-08-03'), 'test_date は artifact 側の値を使う', rows[0]?.test_date);
}

// ── ② 再実行しても増えない ───────────────────────────────────────
console.log('\n② 再実行 (冪等)');
stubMod.__setStub(makeStub());
{
  await mod.persistIntoExistingArtifact({
    artifactId: ART, diagnosticUserId: UID, testType: 'cancer_urine',
    markdownClean: '## 2 回目', measurements: MEAS, testDate: '2023-08-03',
  });
  ok(ops.filter((o) => o.op === 'insert' && o.table === 'test_artifacts').length === 0, '2 回目も artifact を作らない');
  ok(ops.filter((o) => o.op === 'delete' && o.table === 'measurement_values').length === 1, '2 回目も先に消してから入れる');
}

// ── ③ 取り違えは何も書かない ─────────────────────────────────────
console.log('\n③ 取り違えの停止');
for (const [label, row, call] of [
  ['別人の artifact', { ...artifactRow, diagnostic_user_id: '00000000-0000-0000-0000-000000000001' },
    { artifactId: ART, diagnosticUserId: UID, testType: 'cancer_urine', testDate: '2023-08-03' }],
  ['別の検査種別', { ...artifactRow, test_type: 'health_checkup' },
    { artifactId: ART, diagnosticUserId: UID, testType: 'cancer_urine', testDate: '2023-08-03' }],
  ['別の受診日', { ...artifactRow, test_date: '2024-06-10' },
    { artifactId: ART, diagnosticUserId: UID, testType: 'cancer_urine', testDate: '2023-08-03' }],
  ['artifact が無い', null,
    { artifactId: ART, diagnosticUserId: UID, testType: 'cancer_urine', testDate: '2023-08-03' }],
]) {
  artifactRow = row;
  stubMod.__setStub(makeStub());
  const r = await mod.persistIntoExistingArtifact({ ...call, markdownClean: '## x', measurements: MEAS });
  const writes = ops.filter((o) => o.op !== 'select');
  ok(!!r.mismatch && writes.length === 0, `${label} → 止めて何も書かない`, r.mismatch ?? `writes=${writes.length}`);
}

console.log(`\n${pass} / ${pass + fails.length} passed`);
if (fails.length) { console.error('\n落ちた検査:\n  - ' + fails.join('\n  - ')); process.exit(1); }
