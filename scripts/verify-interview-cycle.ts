/**
 * 回窓連動 (interview-cycle.ts) の純ロジック検証。CI の A 層 (ブラウザ/DB 不要)。
 *
 * 実行: npm run verify:interview-cycle
 *   (esbuild で bundle → node 実行。verify:scan-upload-key と同じ方式)
 *
 * ここが静かに壊れると「前の回の問診で完了扱い」or「毎回催促」になるので、
 * **退行を注入して名指しで落ちること**まで確認する。
 */
import {
  interviewCycleStatus,
  isInterviewDoneThisCycle,
  currentCycleStart,
} from '../src/lib/interview-cycle';

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

const CYCLE = '2026-07-01T00:00:00Z'; // その回の窓の開始

// ── interviewCycleStatus ────────────────────────────────────────────
ok('未完了 = never', interviewCycleStatus({ completedAt: null, cycleStart: CYCLE }) === 'never');
ok('空文字 = never', interviewCycleStatus({ completedAt: '', cycleStart: CYCLE }) === 'never');
ok('不正日時 = never', interviewCycleStatus({ completedAt: 'not-a-date', cycleStart: CYCLE }) === 'never');

ok(
  '回窓より前の完了 = stale (取り直しが要る)',
  interviewCycleStatus({ completedAt: '2026-06-30T23:59:59Z', cycleStart: CYCLE }) === 'stale',
);
ok(
  '回窓ちょうどの完了 = done_this_cycle (境界は含む)',
  interviewCycleStatus({ completedAt: CYCLE, cycleStart: CYCLE }) === 'done_this_cycle',
);
ok(
  '回窓より後の完了 = done_this_cycle',
  interviewCycleStatus({ completedAt: '2026-07-02T09:00:00Z', cycleStart: CYCLE }) === 'done_this_cycle',
);

// fail-safe: 回窓が不明なら誤催促しない (完了が在れば済み扱い)
ok(
  '回窓 null + 完了あり = done_this_cycle (誤催促しない)',
  interviewCycleStatus({ completedAt: '2026-01-01T00:00:00Z', cycleStart: null }) === 'done_this_cycle',
);
ok(
  '回窓 不正 + 完了あり = done_this_cycle',
  interviewCycleStatus({ completedAt: '2026-01-01T00:00:00Z', cycleStart: 'bad' }) === 'done_this_cycle',
);
ok(
  '回窓 null + 未完了 = never',
  interviewCycleStatus({ completedAt: null, cycleStart: null }) === 'never',
);

// ── isInterviewDoneThisCycle ────────────────────────────────────────
ok(
  'done_this_cycle のときだけ true (前の回は false)',
  isInterviewDoneThisCycle({ completedAt: '2026-06-01T00:00:00Z', cycleStart: CYCLE }) === false &&
    isInterviewDoneThisCycle({ completedAt: '2026-07-05T00:00:00Z', cycleStart: CYCLE }) === true,
);

// ── currentCycleStart (暫定アンカー: last_test_at → started_at) ──────
ok(
  'last_test_at を優先',
  currentCycleStart({ last_test_at: '2026-07-01T00:00:00Z', started_at: '2026-01-01T00:00:00Z' }) ===
    '2026-07-01T00:00:00Z',
);
ok(
  'last_test_at が無ければ started_at',
  currentCycleStart({ last_test_at: null, started_at: '2026-01-01T00:00:00Z' }) === '2026-01-01T00:00:00Z',
);
ok('どちらも無ければ null', currentCycleStart({ last_test_at: null, started_at: null }) === null);
ok('sub 自体が null なら null', currentCycleStart(null) === null);

// ── 結合: 前回検査後に取り直していない人は stale ─────────────────────
{
  const sub = { last_test_at: '2026-07-01T00:00:00Z', started_at: '2026-01-01T00:00:00Z' };
  const start = currentCycleStart(sub);
  ok(
    '契約時に1度やっただけ = この回は stale (再問診が要る)',
    interviewCycleStatus({ completedAt: '2026-01-02T00:00:00Z', cycleStart: start }) === 'stale',
  );
  ok(
    '今の回に入ってから完了 = done_this_cycle',
    interviewCycleStatus({ completedAt: '2026-07-03T00:00:00Z', cycleStart: start }) === 'done_this_cycle',
  );
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
