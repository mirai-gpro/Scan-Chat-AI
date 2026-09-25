/**
 * Elith 自動納品の「権利・揃った判定」の回帰チェック。
 *
 * 正本: docs/subscription/kit_lifecycle_and_handoff_management_spec.md §4.3.1
 * 実行: npm run verify:elith-entitlement
 *
 * 【ここで固定したいこと】
 *   ① 既存挙動を変えていない — 単品/スペシャルは従来どおり「問診 ∧ 人間ドック」で揃う
 *   ② 仕様が引けないときは **納品しない** (fail-closed)。ここが緩むと誤納品になる
 *   ③ HealthAgeData は非ブロッカー (当社が算出して同梱するもの。待つ対象ではない)
 *   ④ plan_code → format の対応を app_config から正しく読む / 壊れた値で黙って通さない
 */
import { decideReady, planFormatMap, toFormat, type ElithFormat } from '../src/lib/elith-entitlement';

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) { pass++; return; }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const S = (...t: string[]) => new Set(t);
const SINGLE: ElithFormat[] = ['LifestyleQuestionnaireData', 'HealthCheckupData'];

// ── ① 既存挙動 (単品/スペシャル = 問診 ∧ 人間ドック) ────────────────────
check('① 問診済 ∧ スキャン済 → 揃う',
  decideReady(SINGLE, S('health_checkup'), true).ready);
check('① スキャンのみ (問診未) → 揃わない',
  !decideReady(SINGLE, S('health_checkup'), false).ready);
check('① 問診のみ (スキャン未) → 揃わない',
  !decideReady(SINGLE, S(), true).ready);
check('① 足りない format を名指しする',
  decideReady(SINGLE, S(), true).missing.join(',') === 'HealthCheckupData',
  decideReady(SINGLE, S(), true).missing.join(','));

// ── ② fail-closed (仕様不明は納品しない) ──────────────────────────────
check('② required=null → 納品しない', !decideReady(null, S('health_checkup'), true).ready);
check('② required=[] → 納品しない',   !decideReady([], S('health_checkup'), true).ready);
check('② 仕様不明は missing を捏造しない', decideReady(null, S(), false).missing.length === 0);

// ── ③ HealthAgeData は非ブロッカー ───────────────────────────────────
check('③ HealthAgeData だけ未着でも揃う',
  decideReady(['HealthCheckupData', 'HealthAgeData'], S('health_checkup'), false).ready);
check('③ HealthAgeData は checked に数えない',
  decideReady(['HealthCheckupData', 'HealthAgeData'], S('health_checkup'), false).checked.length === 1);

// ── コースプラン (全部入り) ───────────────────────────────────────────
const COURSE: ElithFormat[] = [
  'HealthCheckupData', 'LifestyleQuestionnaireData', 'BloodTestData',
  'CancerRiskAssessmentData', 'GeneticTestResultData', 'Other', 'HealthAgeData',
];
check('コース: 全部揃えば ready',
  decideReady(COURSE, S('health_checkup', 'blood', 'cancer_urine', 'genetics', 'ai_prediction'), true).ready);
check('コース: 血液だけ未着なら ready にしない',
  !decideReady(COURSE, S('health_checkup', 'cancer_urine', 'genetics', 'ai_prediction'), true).ready);
check('コース: 未着を名指しする',
  decideReady(COURSE, S('health_checkup', 'cancer_urine', 'genetics', 'ai_prediction'), true)
    .missing.join(',') === 'BloodTestData');

// ── ④ app_config の読み取り ──────────────────────────────────────────
const read = (v: string) => (k: string) => (k === 'elith.plan_formats' ? v : '');
const m1 = planFormatMap(read('course_a=HealthCheckupData|BloodTestData, single_b=HealthCheckupData'));
check('④ 2 プランを読む', m1.size === 2, String(m1.size));
check('④ format を配列で持つ', (m1.get('course_a') ?? []).join(',') === 'HealthCheckupData,BloodTestData');
check('④ 未設定なら空 (=全員 fail-closed)', planFormatMap(read('')).size === 0);
check('④ 未知の format は捨てる',
  (planFormatMap(read('p=HealthCheckupData|ナニカ')).get('p') ?? []).join(',') === 'HealthCheckupData');
check('④ format が全部未知なら plan ごと載せない (誤って空配列で通さない)',
  !planFormatMap(read('p=ナニカ|ソレ')).has('p'));
check('④ 壊れた要素は無視して他を壊さない',
  planFormatMap(read('=X, p=HealthCheckupData, q')).get('p')?.length === 1);
check('④ toFormat は未知を null にする', toFormat('HealthCheckupData') === 'HealthCheckupData' && toFormat('Nope') === null);

console.log(`\n${fails.length ? '✗' : '✓'} ${pass} / ${pass + fails.length} 件`);
for (const f of fails) console.log(`  ✗ ${f}`);
if (fails.length) process.exit(1);
