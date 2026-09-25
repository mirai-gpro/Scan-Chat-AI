/**
 * P0-2E-0 回帰 fixture のデータセット（決定論・合成）。
 *
 * **実在の検体は使いません**（golden は実名・患者IDを含むため転用禁止・CLAUDE.md）。
 * 既存 admin 手動ラップの挙動のうち、exact-source モード追加で壊れ得る点を全部踏むように組む:
 *
 *   - SERIES_FORMATS (`BloodTestData` / `CancerRiskAssessmentData` / `HealthCheckupData` / `Other`)
 *     を **複数 date** 持たせる → 「全 date 展開」が固定される
 *   - 単発 format (`GeneticTestResultData` / `LifestyleQuestionnaireData`) を 1 件ずつ
 *   - `healthAgeByRef` を 2 date ぶん与える → HealthAgeData の同梱規則が固定される
 *   - 空データ (`data.measurements: []`) を 1 件混ぜる → `dataItems` の記録が固定される
 */

const PREFIX = 'fixture-src/';
const UID_A = '11111111-1111-4111-8111-111111111111';
const UID_B = '22222222-2222-4222-8222-222222222222';

/** `{prefix}user/{client}/date/{YYYY_MM_DD}/{format}_date_{d}_user_{client}.json` */
function key(clientId: string, date: string, formatId: string): string {
  return `${PREFIX}user/${clientId}/date/${date}/${formatId}_date_${date}_user_${clientId}.json`;
}

function body(formatId: string, clientId: string, date: string, items: number): string {
  const measurements = Array.from({ length: items }, (_, i) => ({
    item_name: `項目${i + 1}`,
    value: String(10 + i),
    unit: 'mg/dL',
  }));
  return JSON.stringify(
    {
      format_id: formatId,
      client_id: clientId,
      test_date: date.replace(/_/g, '-'),
      subject: { sex: null, age: null },
      data: { measurements },
    },
    null,
    2,
  );
}

export const FIXTURE_PREFIX = PREFIX;
export const FIXTURE_UID_A = UID_A;
export const FIXTURE_UID_B = UID_B;

/** 回 (date) ごとの代表キー。exact-source の検査で「第2回だけ」を指定するのに使う。 */
export const KEYS = {
  hcA1: key(UID_A, '2024_05_10', 'HealthCheckupData'),
  hcA2: key(UID_A, '2025_05_10', 'HealthCheckupData'),
  hcA3: key(UID_A, '2026_05_10', 'HealthCheckupData'),
  bloodA1: key(UID_A, '2025_05_10', 'BloodTestData'),
  bloodA2: key(UID_A, '2026_05_10', 'BloodTestData'),
  cancerA1: key(UID_A, '2026_05_10', 'CancerRiskAssessmentData'),
  otherA1: key(UID_A, '2026_05_10', 'Other'),
  geneA1: key(UID_A, '2024_05_10', 'GeneticTestResultData'),
  lqA1: key(UID_A, '2026_05_10', 'LifestyleQuestionnaireData'),
  hcB1: key(UID_B, '2026_06_01', 'HealthCheckupData'),
  lqB1: key(UID_B, '2026_06_01', 'LifestyleQuestionnaireData'),
};

export const STORE: Record<string, string> = {
  [KEYS.hcA1]: body('HealthCheckupData', UID_A, '2024_05_10', 3),
  [KEYS.hcA2]: body('HealthCheckupData', UID_A, '2025_05_10', 4),
  [KEYS.hcA3]: body('HealthCheckupData', UID_A, '2026_05_10', 5),
  [KEYS.bloodA1]: body('BloodTestData', UID_A, '2025_05_10', 2),
  [KEYS.bloodA2]: body('BloodTestData', UID_A, '2026_05_10', 6),
  [KEYS.cancerA1]: body('CancerRiskAssessmentData', UID_A, '2026_05_10', 1),
  [KEYS.otherA1]: body('Other', UID_A, '2026_05_10', 2),
  [KEYS.geneA1]: body('GeneticTestResultData', UID_A, '2024_05_10', 1),
  [KEYS.lqA1]: body('LifestyleQuestionnaireData', UID_A, '2026_05_10', 2),
  // 空データ (dataItems=0 の記録を固定する)
  [KEYS.hcB1]: body('HealthCheckupData', UID_B, '2026_06_01', 0),
  [KEYS.lqB1]: body('LifestyleQuestionnaireData', UID_B, '2026_06_01', 1),
};

/** ウェルネス年齢: 人間ドックの 2 date ぶんだけ算出済みとする。 */
export const HEALTH_AGE_BY_REF: Record<string, { biological_age: number | null; [k: string]: unknown }> = {
  [KEYS.hcA2]: { biological_age: 48.2, chronological_age: 55, model_version: 'CABA-v5.4' },
  [KEYS.hcA3]: { biological_age: 47.7, chronological_age: 56, model_version: 'CABA-v5.4' },
};
