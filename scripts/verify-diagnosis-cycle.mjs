#!/usr/bin/env node
/**
 * Diagnosis Cycle の解決・自動 link の検査 — 最終実装指示 §19「cycle」。
 *
 *   npm run verify:diagnosis-cycle
 *
 * 固定すること:
 *   open 0 件 → link されない (no_open_diagnosis_cycle)
 *   open 1 件 → その回へ link
 *   open 2 件 → link されない (multiple_open_diagnosis_cycles)
 *   **date で勝手に選ばない** (2 件のうち新しい方/近い方を選ばないことを実測で固定)
 *   bridge が無い → bridge_unavailable
 *   link が失敗しても **例外を投げない** (取込を止めない)
 *
 * Supabase は `scripts/fixtures/supabase-stub.ts` へ差し替える (esbuild プラグイン)。
 */
import { build } from 'esbuild';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const stubPlugin = {
  name: 'supabase-stub',
  setup(b) {
    b.onResolve({ filter: /(^|\/)supabase$/ }, (args) =>
      args.importer.includes('diagnosis-cycle')
        ? { path: resolve(ROOT, 'scripts/fixtures/supabase-stub.ts') }
        : null);
  },
};

const entry = `
import { findOpenDiagnosisCycle, autoLinkOpenCycle } from '${resolve(ROOT, 'src/lib/diagnosis-cycle.ts')}';
import { __setCycles, __setBridgeAvailable, __setLinkFails, __inserted, __reset }
  from '${resolve(ROOT, 'scripts/fixtures/supabase-stub.ts')}';

const UID = '11111111-1111-4111-8111-111111111111';
const cyc = (seq, extra = {}) => ({
  subscription_id: 'eeeeeeee-0000-4000-8000-000000000001',
  cycle_year: 1, diagnosis_cycle_seq: seq, cycle_kind: 'intermediate',
  status: 'open', planned_format_ids: [], ...extra,
});
const out = {};

// open 0 件
__reset(); __setCycles([]);
out.zero = await autoLinkOpenCycle({ diagnosticUserId: UID, formatId: 'HealthCheckupData' });
out.zeroInserted = __inserted().length;

// open 1 件
__reset(); __setCycles([cyc(2)]);
out.one = await autoLinkOpenCycle({ diagnosticUserId: UID, formatId: 'HealthCheckupData' });
out.oneInserted = __inserted();

// open 2 件 (**日付が違う** — 新しい方を選んでしまわないことを見る)
__reset(); __setCycles([cyc(2, { scheduled_date: '2026-01-01' }), cyc(3, { scheduled_date: '2026-09-01' })]);
out.two = await autoLinkOpenCycle({ diagnosticUserId: UID, formatId: 'HealthCheckupData' });
out.twoInserted = __inserted().length;

// bridge 無し
__reset(); __setBridgeAvailable(false);
out.noBridge = await findOpenDiagnosisCycle(UID);

// link が失敗しても投げない
__reset(); __setCycles([cyc(2)]); __setLinkFails(true);
try { out.linkFail = await autoLinkOpenCycle({ diagnosticUserId: UID, formatId: 'HealthCheckupData' }); }
catch (e) { out.linkThrew = String(e); }

process.stdout.write(JSON.stringify(out, null, 2));
`;

const built = await build({
  stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false,
  logLevel: 'error', define: { 'import.meta.env': '{}' }, plugins: [stubPlugin],
});
const { execFileSync } = await import('node:child_process');
const r = JSON.parse(execFileSync(process.execPath,
  ['--input-type=module', '-e', built.outputFiles[0].text], { encoding: 'utf8' }));

let pass = 0; const fails = [];
const check = (n, ok, d = '') => { if (ok) pass++; else fails.push(`${n}${d ? ` — ${d}` : ''}`); };

check('open 0 → link されない', r.zero.linked === false);
check('open 0 → no_open_diagnosis_cycle', r.zero.reason === 'no_open_diagnosis_cycle', r.zero.reason);
check('open 0 → DB へ書かない', r.zeroInserted === 0, String(r.zeroInserted));

check('open 1 → link される', r.one.linked === true, r.one.reason ?? '');
check('open 1 → その回へ link', r.one.cycle?.diagnosisCycleSeq === 2, String(r.one.cycle?.diagnosisCycleSeq));
check('open 1 → cycle_links に 1 行', r.oneInserted.length === 1, String(r.oneInserted.length));
check('open 1 → linked_by=auto_open_cycle', r.oneInserted[0]?.linked_by === 'auto_open_cycle', r.oneInserted[0]?.linked_by);

check('open 2 → link されない', r.two.linked === false);
check('open 2 → multiple_open_diagnosis_cycles', r.two.reason === 'multiple_open_diagnosis_cycles', r.two.reason);
check('open 2 → **日付で選ばない** (DB へ 1 行も書かない)', r.twoInserted === 0, String(r.twoInserted));

check('bridge 無し → bridge_unavailable', r.noBridge.reason === 'bridge_unavailable', r.noBridge.reason);
check('bridge 無し → cycle は null', r.noBridge.cycle === null);

check('link 失敗でも例外を投げない', r.linkThrew === undefined, r.linkThrew ?? '');
check('link 失敗 → linked=false', r.linkFail?.linked === false);
check('link 失敗 → reason=link_failed', r.linkFail?.reason === 'link_failed', r.linkFail?.reason);

console.log(`\n${fails.length ? '✗' : '✓'} ${pass} / ${pass + fails.length} 件`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exit(fails.length ? 1 : 0);
