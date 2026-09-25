#!/usr/bin/env node
/**
 * exact-source モードの検査 — 最終実装指示 §19「exact-source」。
 *
 *   npm run verify:assemble-exact-source
 *
 * 固定すること:
 *   ① **第 2 回を指定したとき、第 1 回・第 3 回の SERIES_FORMATS が混入しない**
 *   ② HealthAgeData も当該 source のぶんだけ（過去回のウェルネス年齢が混ざらない）
 *   ③ 従来モードでは従来どおり全 date が出る（既定を壊していないことの再確認）
 */
import { build } from 'esbuild';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const s3StubPlugin = {
  name: 's3-stub',
  setup(b) {
    b.onResolve({ filter: /(^|\/)s3$/ }, (args) =>
      args.importer.includes('elith-assemble')
        ? { path: resolve(ROOT, 'scripts/fixtures/assemble-s3-stub.ts') }
        : null);
  },
};

const entry = `
import { assembleElithDeliverySet } from '${resolve(ROOT, 'src/lib/elith-assemble.ts')}';
import { __setStore } from '${resolve(ROOT, 'scripts/fixtures/assemble-s3-stub.ts')}';
import { STORE, HEALTH_AGE_BY_REF, FIXTURE_PREFIX, FIXTURE_UID_A, KEYS }
  from '${resolve(ROOT, 'scripts/fixtures/assemble-dataset.ts')}';
__setStore(STORE);

const common = {
  sourcePrefix: FIXTURE_PREFIX, deliveryPrefix: 'fx-out/',
  bundleDate: '2026_09_25', exportedAt: new Date('2026-09-25T00:00:00Z'),
  healthAgeByRef: HEALTH_AGE_BY_REF,
};
// 「第2回 = 2025_05_10 の検診と血液」だけを指定する (第1回 2024 / 第3回 2026 は混入してはいけない)
const mapping = { [FIXTURE_UID_A]: { HealthCheckupData: KEYS.hcA2, BloodTestData: KEYS.bloodA1 } };

const exact  = await assembleElithDeliverySet({ ...common, manualMapping: mapping, exactSource: true });
const legacy = await assembleElithDeliverySet({ ...common, manualMapping: mapping });

const pick = (r) => r.users[0].sources.map((s) => ({ f: s.formatId, d: s.sourceDate, k: s.sourceKey, nk: s.newKey }));
process.stdout.write(JSON.stringify({ exact: pick(exact), legacy: pick(legacy) }, null, 2));
`;

const out = await build({
  stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false,
  logLevel: 'error', define: { 'import.meta.env': '{}' }, plugins: [s3StubPlugin],
});
const { execFileSync } = await import('node:child_process');
const { exact, legacy } = JSON.parse(execFileSync(process.execPath,
  ['--input-type=module', '-e', out.outputFiles[0].text], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

let pass = 0; const fails = [];
const check = (n, ok, d = '') => { if (ok) pass++; else fails.push(`${n}${d ? ` — ${d}` : ''}`); };

// ① 過去回・将来回が混入しない
const exactHc = exact.filter((s) => s.f === 'HealthCheckupData');
const exactBl = exact.filter((s) => s.f === 'BloodTestData');
check('① 検診は指定した 1 件だけ', exactHc.length === 1, `${exactHc.length} 件: ${exactHc.map((s) => s.d).join(',')}`);
check('① 検診は第2回(2025_05_10)', exactHc[0]?.d === '2025_05_10', exactHc[0]?.d);
check('① 第1回(2024_05_10)が混入しない', !exact.some((s) => s.d === '2024_05_10'), exact.filter((s) => s.d === '2024_05_10').map((s) => s.f).join(','));
check('① 第3回(2026_05_10)が混入しない', !exact.some((s) => s.d === '2026_05_10'), exact.filter((s) => s.d === '2026_05_10').map((s) => s.f).join(','));
check('① 血液は指定した 1 件だけ', exactBl.length === 1, `${exactBl.length} 件`);

// ② HealthAgeData も当該 source のぶんだけ
const exactHa = exact.filter((s) => s.f === 'HealthAgeData');
check('② HealthAgeData は 1 件以下', exactHa.length <= 1, `${exactHa.length} 件`);
check('② HealthAgeData に第3回(47.7)の回が混ざらない',
  !exactHa.some((s) => s.k === 'fixture-src/user/11111111-1111-4111-8111-111111111111/date/2026_05_10/HealthCheckupData_date_2026_05_10_user_11111111-1111-4111-8111-111111111111.json'),
  exactHa.map((s) => s.k).join(','));

// ③ 従来モードは全 date 展開のまま
const legacyHc = legacy.filter((s) => s.f === 'HealthCheckupData');
check('③ 従来モードは検診 3 date のまま', legacyHc.length === 3, `${legacyHc.length} 件`);
check('③ 従来モードは第1回も含む', legacy.some((s) => s.d === '2024_05_10'));

// 1 回分 = 1 date フォルダ (Elith 仕様 §3.3)
const folders = new Set(exact.map((s) => (s.nk.match(/\/date\/([0-9_]+)\//) ?? [])[1]));
check('exact-source は 1 date フォルダに納まる', folders.size === 1, [...folders].join(','));

console.log(`\n${fails.length ? '✗' : '✓'} ${pass} / ${pass + fails.length} 件`);
for (const f of fails) console.log(`  ✗ ${f}`);
console.log(`  exact:  ${exact.map((s) => `${s.f}@${s.d}`).join(' / ')}`);
console.log(`  legacy: ${legacy.map((s) => `${s.f}@${s.d}`).join(' / ')}`);
process.exit(fails.length ? 1 : 0);
