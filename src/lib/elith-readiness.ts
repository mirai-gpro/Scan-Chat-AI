/**
 * Diagnosis Cycle の **readiness 判定** — P0-2 最終実装指示 §5。
 *
 * 【`ship_rule` を使わない】`ship_rule` は**物理発送の規則**であって Elith readiness ではない。
 * 実測で `ai_prediction`(data/`Other`) も `ai_prevention`(app/format_id=NULL) も
 * `ship_rule='none'` であり、「none なら required から外す」という一般規則は成り立たない。
 * 何が必要かは**回の種別と、その回に予定された物理検査**から決める。
 *
 * 【規則】(指示 §5 をそのまま実装)
 *   全 Diagnosis Cycle   : LifestyleQuestionnaireData 必須
 *   cycle_kind=healthcheck: HealthCheckupData 必須
 *   shipment_cycle_seq あり: その Shipment Cycle で予定された物理検査から required を導出
 *                            cancer → CancerRiskAssessmentData
 *                            blood  → BloodTestData
 *                            genetics → GeneticTestResultData (初回 Shipment Cycle に
 *                                       含まれる場合のみ。過去の結果を自動再同梱しない)
 *   Other / ai_prediction : **blocker にしない**。同じ回へ明示 link があるときだけ同梱
 *   HealthAgeData         : **non-blocking**。算出済みがあれば同梱
 *
 * 【cycle_kind が未指定なら判定しない】`diagnosis_cycle_undefined` で fail-closed (指示 §3)。
 * ライト系の 1 回をどちらにするか等は**コードで決めない**。
 */

import type { DiagnosisCycleInfo } from './diagnosis-cycle';

/** readiness の blocker になり得る format。 */
export const BLOCKING_FORMATS = [
  'LifestyleQuestionnaireData',
  'HealthCheckupData',
  'BloodTestData',
  'CancerRiskAssessmentData',
  'GeneticTestResultData',
] as const;
export type BlockingFormat = (typeof BLOCKING_FORMATS)[number];

/** 物理検査で readiness に効く format (Shipment Cycle の予定から拾う)。 */
const PHYSICAL_BLOCKERS = new Set<string>([
  'BloodTestData',
  'CancerRiskAssessmentData',
  'GeneticTestResultData',
]);

/** 同梱はするが readiness を止めない format。 */
export const NON_BLOCKING_FORMATS = ['Other', 'HealthAgeData'] as const;

export interface ReadinessInput {
  cycle: DiagnosisCycleInfo;
  /** その回に link 済みの format (`cycle_links` 由来)。 */
  linkedFormats: Set<string>;
}

export interface ReadinessResult {
  ready: boolean;
  /** 揃うべき format (blocker のみ)。 */
  required: BlockingFormat[];
  /** 未着の format。 */
  missing: BlockingFormat[];
  /** 同梱対象 (blocker ＋ 明示 link のある non-blocking)。納品 mapping の元になる。 */
  deliverFormats: string[];
  /** 判定できなかった理由。ready=false かつ required が空のときに入る。 */
  reason: 'diagnosis_cycle_undefined' | null;
}

/**
 * その回の required を決め、link 済みと突き合わせる。
 *
 * **DB に触れない純粋関数**。ここが唯一の判断なので、検査で固定する
 * (`npm run verify:elith-readiness`)。
 */
export function evaluateReadiness(input: ReadinessInput): ReadinessResult {
  const { cycle, linkedFormats } = input;

  // cycle_kind 未指定は判定しない (指示 §3・fail-closed)。
  if (cycle.cycleKind !== 'healthcheck' && cycle.cycleKind !== 'intermediate') {
    return { ready: false, required: [], missing: [], deliverFormats: [], reason: 'diagnosis_cycle_undefined' };
  }

  const required: BlockingFormat[] = [];

  // ① 全 Diagnosis Cycle で問診は必須
  required.push('LifestyleQuestionnaireData');

  // ② 人間ドック回だけ HealthCheckupData が必須
  if (cycle.cycleKind === 'healthcheck') required.push('HealthCheckupData');

  /*
   * ③ その回に予定された物理検査から required を導出する。
   *    `plannedFormatIds` は対応 Shipment Cycle の test_kits.format_id
   *    (shipment_cycle_seq が NULL の回は空配列 = 物理検査 required を持たない)。
   *    **遺伝子は「初回 Shipment Cycle に含まれるとき」だけここに現れる**
   *    (ship_rule=first_only のため 2 回目以降の schedule には積まれない)。
   *    過去回の遺伝子結果を後から足すことは**しない** (再同梱は別仕様)。
   */
  for (const f of cycle.plannedFormatIds) {
    if (PHYSICAL_BLOCKERS.has(f) && !required.includes(f as BlockingFormat)) {
      required.push(f as BlockingFormat);
    }
  }

  const missing = required.filter((f) => !linkedFormats.has(f));

  /*
   * 同梱対象 = required (揃っている分) ＋ 明示 link のある non-blocking。
   * **ready 判定に使った format は必ず納品へ載せる** (指示 §16 の「判定だけして納品しない」を潰す)。
   * HealthAgeData は算出物で cycle_links に載らないため、ここには現れない
   * (納品側が算出済みスコアの有無で判断する)。
   */
  const deliverFormats = [
    ...required.filter((f) => linkedFormats.has(f)),
    ...(linkedFormats.has('Other') ? ['Other'] : []),
  ];

  return { ready: missing.length === 0, required, missing, deliverFormats, reason: null };
}
