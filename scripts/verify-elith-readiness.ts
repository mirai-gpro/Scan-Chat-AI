/**
 * Diagnosis Cycle readiness の回帰チェック — 最終実装指示 §19。
 *
 * 実行: npm run verify:elith-readiness
 *
 * 指示 §19 が列挙したケースを全部固定する:
 *   questionnaire なし → fail
 *   healthcheck cycle + HealthCheckup なし → fail
 *   intermediate cycle で HealthCheckup なし → それだけでは fail しない
 *   shipment cycle に blood あり / blood 未着 → fail
 *   shipment cycle に cancer あり / cancer 未着 → fail
 *   genetics 初回未着 → fail
 *   Other なし → blocker にならない
 *   HealthAge なし → blocker にならない
 * ＋ cycle_kind 未指定 → diagnosis_cycle_undefined で fail-closed
 * ＋ ready 判定に使った format が deliverFormats に必ず載る (判定だけして納品しない問題の防止)
 */
import { evaluateReadiness } from '../src/lib/elith-readiness';
import type { DiagnosisCycleInfo } from '../src/lib/diagnosis-cycle';

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) { pass++; return; }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const cycle = (
  kind: DiagnosisCycleInfo['cycleKind'],
  planned: string[] = [],
): DiagnosisCycleInfo => ({
  subscriptionId: 'eeeeeeee-0000-4000-8000-000000000001',
  cycleYear: 1,
  diagnosisCycleSeq: 2,
  cycleKind: kind,
  status: 'open',
  plannedFormatIds: planned,
});
const L = (...f: string[]) => new Set(f);
const LQ = 'LifestyleQuestionnaireData';
const HC = 'HealthCheckupData';
const BL = 'BloodTestData';
const CA = 'CancerRiskAssessmentData';
const GE = 'GeneticTestResultData';

// ── cycle_kind 未指定 → fail-closed ─────────────────────────────────────
{
  const r = evaluateReadiness({ cycle: cycle(null), linkedFormats: L(LQ, HC) });
  check('cycle_kind 未指定 → ready=false', !r.ready);
  check('cycle_kind 未指定 → diagnosis_cycle_undefined', r.reason === 'diagnosis_cycle_undefined', String(r.reason));
  check('cycle_kind 未指定 → required を捏造しない', r.required.length === 0);
}

// ── 問診 ────────────────────────────────────────────────────────────────
{
  const r = evaluateReadiness({ cycle: cycle('intermediate'), linkedFormats: L() });
  check('問診なし → fail', !r.ready);
  check('問診なし → missing に LifestyleQuestionnaireData', r.missing.includes(LQ as never), r.missing.join(','));
}
{
  const r = evaluateReadiness({ cycle: cycle('intermediate'), linkedFormats: L(LQ) });
  check('中間回で問診だけ揃えば ready', r.ready, r.missing.join(','));
}

// ── 人間ドック回 ────────────────────────────────────────────────────────
{
  const r = evaluateReadiness({ cycle: cycle('healthcheck'), linkedFormats: L(LQ) });
  check('healthcheck + HealthCheckup なし → fail', !r.ready);
  check('healthcheck の missing は HealthCheckupData', r.missing.join(',') === HC, r.missing.join(','));
}
{
  const r = evaluateReadiness({ cycle: cycle('healthcheck'), linkedFormats: L(LQ, HC) });
  check('healthcheck + 両方揃えば ready', r.ready, r.missing.join(','));
}
{
  const r = evaluateReadiness({ cycle: cycle('intermediate'), linkedFormats: L(LQ) });
  check('intermediate は HealthCheckup なしでも fail しない', r.ready && !r.required.includes(HC as never));
}

// ── 物理検査 (Shipment Cycle の予定から導出) ────────────────────────────
{
  const r = evaluateReadiness({ cycle: cycle('intermediate', [BL]), linkedFormats: L(LQ) });
  check('shipment に blood あり / blood 未着 → fail', !r.ready);
  check('missing に BloodTestData', r.missing.join(',') === BL, r.missing.join(','));
}
{
  const r = evaluateReadiness({ cycle: cycle('intermediate', [CA]), linkedFormats: L(LQ) });
  check('shipment に cancer あり / cancer 未着 → fail', !r.ready);
  check('missing に CancerRiskAssessmentData', r.missing.join(',') === CA, r.missing.join(','));
}
{
  const r = evaluateReadiness({ cycle: cycle('healthcheck', [GE]), linkedFormats: L(LQ, HC) });
  check('genetics 初回未着 → fail', !r.ready);
  check('missing に GeneticTestResultData', r.missing.join(',') === GE, r.missing.join(','));
}
{
  const r = evaluateReadiness({ cycle: cycle('intermediate', [BL, CA]), linkedFormats: L(LQ, BL, CA) });
  check('予定された物理検査が全部揃えば ready', r.ready, r.missing.join(','));
}
{
  // 2 回目以降: genetics は Shipment の予定に無い → required に入らない (自動再同梱しない)
  const r = evaluateReadiness({ cycle: cycle('intermediate', [BL]), linkedFormats: L(LQ, BL) });
  check('2回目以降は genetics を required にしない', r.ready && !r.required.includes(GE as never));
}
{
  // shipment_cycle_seq が NULL の回 = planned が空 → 物理検査 required なし
  const r = evaluateReadiness({ cycle: cycle('intermediate', []), linkedFormats: L(LQ) });
  check('shipment 対応なしの回は物理検査を required にしない', r.ready);
}

// ── non-blocking ────────────────────────────────────────────────────────
{
  const r = evaluateReadiness({ cycle: cycle('intermediate', [BL]), linkedFormats: L(LQ, BL) });
  check('Other なし → blocker にならない', r.ready && !r.required.includes('Other' as never));
  check('HealthAge なし → blocker にならない', r.ready && !r.required.includes('HealthAgeData' as never));
}
{
  const r = evaluateReadiness({ cycle: cycle('intermediate'), linkedFormats: L(LQ, 'Other') });
  check('Other は link があれば同梱対象に入る', r.deliverFormats.includes('Other'), r.deliverFormats.join(','));
}
{
  const r = evaluateReadiness({ cycle: cycle('intermediate'), linkedFormats: L(LQ) });
  check('Other は link が無ければ同梱しない', !r.deliverFormats.includes('Other'));
}

// ── ready 判定に使った format は必ず納品対象へ ───────────────────────────
{
  const r = evaluateReadiness({ cycle: cycle('healthcheck', [BL, CA]), linkedFormats: L(LQ, HC, BL, CA) });
  check('ready のとき required が全部 deliverFormats に載る',
    r.ready && r.required.every((f) => r.deliverFormats.includes(f)),
    `required=${r.required.join(',')} deliver=${r.deliverFormats.join(',')}`);
  check('deliverFormats に未着は載らない', r.deliverFormats.every((f) => L(LQ, HC, BL, CA).has(f)));
}

console.log(`\n${fails.length ? '✗' : '✓'} ${pass} / ${pass + fails.length} 件`);
for (const f of fails) console.log(`  ✗ ${f}`);
if (fails.length) process.exit(1);
