/**
 * デモ / テストフェーズ用のダミーデータ。
 *
 * 目的: **表示機能とデザインの確認・お披露目**。デモ用アカウントに対して、
 *   材料が要る機能 (推移グラフ = 2 回目の検査から / 過去データの切替) まで含めて
 *   **全部の表示機能を通す**。正本 `docs/operations/デモ用アカウント_仕様書.md` §1。
 *
 * 切替条件: **表示中の uid がデモ用アカウントか。それだけ** (`demoFallbackEnabled`)。
 *   仕様書 §2 の表 —「デモ用アカウント … ダミー=出す / 実データ=—」。
 *   **実データの有無は条件ではない。**
 * 無効化: env `PUBLIC_DEMO_FALLBACK=false` で完全に切る。
 *
 * 【2026-09-05 修正】ここには以前「実データが空のときだけダミーへ落とす」と書いてあり、
 *   `dashboard-queries` / `notice-queries` / `measurement-queries` がそれに沿って
 *   **DB に 1 行でもあればダミーを引っ込める**実装になっていた (仕様書 2026-08-30 より前の
 *   記述が残っていた)。結果、デモ用アカウントには借り物の歯抜けデータ
 *   (scan_md 無し・測定値が 1 日ぶんだけ) が出て、**読み取り結果もグラフも空**になっていた。
 *   仕様が正なのでこちらを直した。
 *
 * ※ これは表示用フォールバックであり DB には書き込まない。
 */

import { demoDisabledGlobally, isDemoAccount } from './demo-accounts';
import { isSpecialAccount } from './special-accounts';
import type { ElithSection } from './elith-parser';
import type { DashboardData, MetricTrendSeries } from './dashboard-queries';
import type { NoticesData } from './notice-queries';
import type {
  Announcement,
  DiagnosisResult,
  KitShipment,
  Subscription,
  TestArtifact,
  UserNotice,
} from '../types/supabase';

/**
 * ダミーフォールバックが有効か。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【判定】**表示中の uid がデモ用アカウントか。それだけ。**
 * ══════════════════════════════════════════════════════════════════════
 *
 * 資格の判定そのものは `demo-accounts.ts` が持つ (`isDemoAccount`)。
 * ここはダミーデータ側の入口で、**資格の規則をここに書かない**。
 *
 * **admin かどうかは見ない。** デモ用アカウントと管理者アカウントは別物で、
 * **PR 用のアカウントは社外に渡る**ので同じ枠に置けない。
 * admin がダミーを見たいなら、その uid をデモ用アカウントに登録する
 * (`docs/operations/デモ用アカウント_仕様書.md` §5・admin から即時・再デプロイ不要)。
 *
 * 【admin を混ぜてはいけない理由 — 実際に踏んだ失敗】
 *   `viewerIsAdmin` は **Cookie の署名 → HP Edge の `resolve-customer` →
 *   Wellfort 側 `admin_users`** という 3 段の外部依存で決まる。どこか 1 つが落ちても
 *   結果は同じ `false` で、**画面は黙って空になる** (2026-08-30 に本番で
 *   `edge.is_admin: false` を実測。原因の切り分けに何往復も費やした)。
 *   さらに、混ぜると**管理者を 1 人増やすたびにダミーの閲覧者が増える**。
 *
 * **uid を渡さない呼び出しは false** (＝ダミーを出さない)。fail-safe をこちらへ倒す。
 *
 * **代理表示 (`?u=`) 中は渡る uid が相手のもの**になるので、相手が
 * デモ用アカウントでなければ自動的にデモは出ない (相手の実データが見える)。
 * 呼び出し側で場合分けする必要は無い。
 *
 * @param uid 表示中の diagnostic_user_id。
 */
export function demoFallbackEnabled(uid?: string | null): boolean {
  if (demoDisabledGlobally()) return false;
  /*
   * **スペシャルアカウントにダミーは出さない** (`docs/operations/スペシャルアカウント_仕様書.md` §7)。
   *
   * あちらは**本人の実データ**を扱う枠で、目的がデモと逆。両方に登録される事故は起き得るので、
   * そのとき**実データの利用者に他人名義のダミー検査結果が出る**のを 1 行で確実に止める。
   * `verify:special-accounts` がこの 1 行を固定している。
   */
  if (isSpecialAccount(uid)) return false;
  return isDemoAccount(uid);
}

const now = () => new Date();
const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();

/*
 * 人間ドックの受診日は**ここだけ**に置く。artifacts (test_date) と推移グラフの
 * 点の日付が同じ定数から出るようにするため (別々に書くとズレる)。
 *
 * **ちょうど 365 日差にしない** — 1 年ちょうどだと軸のラベルが両方 "3/29" になり、
 * 2 点が同じ日に見える (実測)。人間ドックは毎年ぴったり同じ日には受けない。
 */
const HC_DAYS_PREV = 505;
const HC_DAYS_LATEST = 160;
const daysAhead = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();

/** メトリクス抽出 (検査値フィードバック) が効くサンプル Elith レポート。 */
const DEMO_REPORT: ElithSection[] = [
  {
    section_name: 'アブストラクト',
    char_count: 180,
    text: '総合的に大きな問題はありませんが、尿酸値と空腹時血糖がやや高めです。'
      + '生活習慣の見直し（水分摂取・食事・運動）で改善が見込めます。',
  },
  {
    section_name: '検査値フィードバック',
    char_count: 220,
    text:
      '今回の検査結果について。尿酸は7.8 mg/dL（基準値: 7.0 以下）とやや高めでした。'
      + '最高血圧は128 mmHg、最低血圧は82 mmHg と良好な範囲です。'
      + '空腹時血糖が108 mg/dL（基準値: 99 以下）とやや高めです。'
      + 'プリン体を控え、水分を1日2リットル以上摂取しましょう。',
  },
];

/*
 * デモの「人間ドック / 健康診断」の読み取り結果 (test_artifacts.scan_md)。
 *
 * **合成データ**。docs/scan/golden/ の人間ドック golden は**実名と患者 ID を含む**ので
 * 使えない (デモ用アカウントは記者・パートナーへ渡る = 社外に出る)。
 * `health_checkup_20260826.json` (合成検体) も基準値を持たず単位大小で 2 検査が混ざるため、
 * 読み取り結果の表には起こせない。→ ここで作る。
 *
 * 形式は**本番のスキャンが書くものと同じ** (`markdownClean` = 推論値列を落とした 9 列)。
 * デモだけ別形式にすると、表示の確認にならない。
 *
 * 値は既存の DEMO_REPORT と**突き合わせてある** (尿酸 7.8 / 最高血圧 128 / 最低血圧 82 /
 * 空腹時血糖 108)。ここが食い違うと、AI 報告書が画面のどこにも無い値を語ることになる。
 * 基準値を外れるのも報告書が名指ししている 2 項目 (尿酸・空腹時血糖) だけにしてある。
 */
const DEMO_SCAN_MD_LATEST = `## 身体計測・血圧

| No | 検査項目 | 検査項目詳細 | 読み取った値 | 単位 | 下限値 | 上限値 | 判定 | 備考 |
|----|----------|--------------|--------------|------|--------|--------|------|------|
| 1 | 身長 | 身長 | 172.4 | cm | - | - | - | - |
| 2 | 体重 | 体重 | 71.2 | kg | - | - | - | - |
| 3 | BMI | BMI | 24.0 | - | 18.5 | 25.0 | - | - |
| 4 | 腹囲 | 腹囲 | 86.5 | cm | - | 85.0 | - | - |
| 5 | 血圧 | 最高血圧 | 128 | mmHg | - | 129 | - | - |
| 6 | 血圧 | 最低血圧 | 82 | mmHg | - | 84 | - | - |

## 尿検査

| No | 検査項目 | 検査項目詳細 | 読み取った値 | 単位 | 下限値 | 上限値 | 判定 | 備考 |
|----|----------|--------------|--------------|------|--------|--------|------|------|
| 7 | 尿蛋白 | 尿蛋白 | (-) | - | - | - | - | - |
| 8 | 尿潜血 | 尿潜血 | (-) | - | - | - | - | - |
| 9 | 尿糖 | 尿糖 | (-) | - | - | - | - | - |

## 血液検査

| No | 検査項目 | 検査項目詳細 | 読み取った値 | 単位 | 下限値 | 上限値 | 判定 | 備考 |
|----|----------|--------------|--------------|------|--------|--------|------|------|
| 10 | 白血球数 | 白血球数 | 6.2 | 10^3/μL | 3.3 | 8.6 | - | - |
| 11 | 赤血球数 | 赤血球数 | 482 | 10^4/μL | 435 | 555 | - | - |
| 12 | ヘモグロビン | 血色素量 | 15.1 | g/dL | 13.7 | 16.8 | - | - |
| 13 | ヘマトクリット | ヘマトクリット値 | 45.2 | % | 40.7 | 50.1 | - | - |
| 14 | 血小板数 | 血小板数 | 24.5 | 10^4/μL | 15.8 | 34.8 | - | - |
| 15 | AST | AST(GOT) | 24 | U/L | 13 | 30 | - | - |
| 16 | ALT | ALT(GPT) | 31 | U/L | 10 | 42 | - | - |
| 17 | γ-GT | γ-GTP | 62 | U/L | 13 | 64 | - | - |
| 18 | ALP | ALP | 78 | U/L | 38 | 113 | - | - |
| 19 | 総ビリルビン | 総ビリルビン | 0.8 | mg/dL | 0.4 | 1.5 | - | - |
| 20 | 総蛋白 | 総蛋白 | 7.3 | g/dL | 6.6 | 8.1 | - | - |
| 21 | アルブミン | アルブミン | 4.4 | g/dL | 4.1 | 5.1 | - | - |
| 22 | 総コレステロール | 総コレステロール | 214 | mg/dL | 142 | 219 | - | - |
| 23 | HDLコレステロール | HDLコレステロール | 52 | mg/dL | 40 | - | - | - |
| 24 | LDLコレステロール | LDLコレステロール | 138 | mg/dL | 65 | 139 | - | - |
| 25 | 中性脂肪 | 中性脂肪 | 142 | mg/dL | 30 | 149 | - | - |
| 26 | 空腹時血糖 | 空腹時血糖 | 108 | mg/dL | 73 | 99 | H | - |
| 27 | HbA1c | HbA1c(NGSP) | 5.8 | % | 4.9 | 6.0 | - | - |
| 28 | 尿素窒素 | 尿素窒素 | 15.2 | mg/dL | 8.0 | 20.0 | - | - |
| 29 | クレアチニン | クレアチニン | 0.96 | mg/dL | 0.65 | 1.07 | - | - |
| 30 | eGFR | eGFR | 64.6 | mL/min/1.73m2 | 60.0 | - | - | - |
| 31 | 尿酸 | 尿酸 | 7.8 | mg/dL | 3.7 | 7.0 | H | - |
`;

/**
 * 前回分。**同じ項目で値だけ動かす** — 「過去データ」の切替と推移が読めるように。
 * 体重は減り (73.0→71.2)、尿酸と血糖は上がっている (7.2→7.8 / 101→108)。
 */
const DEMO_SCAN_MD_PREV = DEMO_SCAN_MD_LATEST
  .replace('| 2 | 体重 | 体重 | 71.2 |', '| 2 | 体重 | 体重 | 73.0 |')
  .replace('| 3 | BMI | BMI | 24.0 |', '| 3 | BMI | BMI | 24.6 |')
  .replace('| 4 | 腹囲 | 腹囲 | 86.5 |', '| 4 | 腹囲 | 腹囲 | 88.0 |')
  .replace('| 5 | 血圧 | 最高血圧 | 128 |', '| 5 | 血圧 | 最高血圧 | 132 |')
  .replace('| 6 | 血圧 | 最低血圧 | 82 |', '| 6 | 血圧 | 最低血圧 | 86 |')
  .replace('| 26 | 空腹時血糖 | 空腹時血糖 | 108 |', '| 26 | 空腹時血糖 | 空腹時血糖 | 101 |')
  .replace('| 27 | HbA1c | HbA1c(NGSP) | 5.8 |', '| 27 | HbA1c | HbA1c(NGSP) | 5.6 |')
  .replace('| 31 | 尿酸 | 尿酸 | 7.8 |', '| 31 | 尿酸 | 尿酸 | 7.2 |')
  /*
   * 既定でグラフに出る 6 項目 (`DEFAULT_TREND_ITEMS`) は**全部動かす**。
   * 前回と同値だと横一直線 +「前回比 0」になり、推移を見せるデモにならない (実測)。
   * どれも基準内→基準内の動きなので、md の「判定」列 (=`-`) と矛盾しない。
   */
  .replace('| 17 | γ-GT | γ-GTP | 62 |', '| 17 | γ-GT | γ-GTP | 48 |')
  .replace('| 24 | LDLコレステロール | LDLコレステロール | 138 |', '| 24 | LDLコレステロール | LDLコレステロール | 126 |')
  .replace('| 30 | eGFR | eGFR | 64.6 |', '| 30 | eGFR | eGFR | 68.2 |');

/** ダミーの検査履歴。 */
export function demoArtifacts(uid: string): TestArtifact[] {
  const base = {
    diagnostic_user_id: uid,
    schema_version: '1.0',
    age_at_test: 55,
    sex: 'male',
    imported_by: 'demo',
    notes: null,
    external_test_id: null,
    // 読み取り結果を持つのはアプリ内スキャン経路 (人間ドック / 健康診断) だけ。
    scan_md: null as string | null,
  };
  return [
    {
      ...base, id: 'demo-art-0001', source: 'wellfort_lab', test_type: 'blood',
      test_date: daysAgo(20), lab_name: 'リージャー', display_mode: 'three_mode',
      page_count: 2, imported_at: daysAgo(18), status: 'imported',
    },
    {
      ...base, id: 'demo-art-0002', source: 'wellfort_lab', test_type: 'cancer_urine',
      test_date: daysAgo(48), lab_name: 'PREVENT', display_mode: 'standard',
      page_count: 1, imported_at: daysAgo(46), status: 'imported',
    },
    {
      ...base, id: 'demo-art-0003', source: 'wellfort_lab', test_type: 'genetics',
      test_date: daysAgo(120), lab_name: 'ジェノプラン', display_mode: 'standard',
      page_count: 3, imported_at: daysAgo(118), status: 'imported',
    },
    {
      ...base, id: 'demo-art-0004', source: 'user_upload', test_type: 'health_checkup',
      test_date: daysAgo(HC_DAYS_LATEST), lab_name: null, display_mode: 'standard',
      page_count: 4, imported_at: daysAgo(HC_DAYS_LATEST - 2), status: 'imported',
      scan_md: DEMO_SCAN_MD_LATEST,
    },
    {
      ...base, id: 'demo-art-0005', source: 'wellfort_lab', test_type: 'ai_prediction',
      test_date: daysAgo(75), lab_name: 'LAiF', display_mode: 'standard',
      page_count: 6, imported_at: daysAgo(73), status: 'imported',
    },
    /*
     * 前回分。検査 5 種それぞれに 2 回目を置くのは、テストフェーズで
     * 「グラフ」(推移は 2 回目から) と「過去データ」(切替先が要る) を
     * クライアントに見てもらうため。実データが入れば demo 層は出なくなる。
     */
    {
      ...base, id: 'demo-art-0011', source: 'wellfort_lab', test_type: 'blood',
      test_date: daysAgo(205), lab_name: 'リージャー', display_mode: 'three_mode',
      page_count: 2, imported_at: daysAgo(203), status: 'imported',
    },
    {
      ...base, id: 'demo-art-0012', source: 'wellfort_lab', test_type: 'cancer_urine',
      test_date: daysAgo(230), lab_name: 'PREVENT', display_mode: 'standard',
      page_count: 1, imported_at: daysAgo(228), status: 'imported',
    },
    {
      ...base, id: 'demo-art-0014', source: 'user_upload', test_type: 'health_checkup',
      test_date: daysAgo(HC_DAYS_PREV), lab_name: null, display_mode: 'standard',
      page_count: 4, imported_at: daysAgo(HC_DAYS_PREV - 2), status: 'imported',
      scan_md: DEMO_SCAN_MD_PREV,
    },
    {
      ...base, id: 'demo-art-0015', source: 'wellfort_lab', test_type: 'ai_prediction',
      test_date: daysAgo(440), lab_name: 'LAiF', display_mode: 'standard',
      page_count: 6, imported_at: daysAgo(438), status: 'imported',
    },
  ] as TestArtifact[];
}

/** ダミーの最新診断結果。 */
function demoLatestResult(uid: string): DiagnosisResult {
  return {
    id: 'demo-res-0001',
    diagnostic_user_id: uid,
    diagnostic_id: 'demo-diag-0001',
    report: DEMO_REPORT as unknown as DiagnosisResult['report'],
    schema_version: '1.0',
    elith_job_id: null,
    elith_model_version: 'demo',
    received_at: daysAgo(18),
    summary_text: '尿酸値と空腹時血糖がやや高めです。食生活の見直しと適度な運動をおすすめします。',
    highlights_text: null,
    extracted_at: daysAgo(18),
    extracted_by_model: 'demo',
    status: 'published',
  };
}

/** ダミーの検査キット進捗。 */
export function demoShipments(uid: string): (KitShipment & { lab_name: string | null })[] {
  /**
   * 進捗の 6 段階 (SHIPMENT_STAGES) を一通り見せる。
   * DB のダミー (supabase/seed_kit_demo.sql) を入れなくても /kit と
   * ダッシュボードのキットカードで全段階を確認できるようにするため。
   * shipmentLabel() は「どこまで日時が埋まっているか」で段階を決めるので、
   * 各行の日時の埋まり方がそのまま段階になる。
   */
  const base = {
    customer_id: uid, lab_company_id: '', subscription_id: null,
    subscription_year: null, subscription_seq: null, warehouse: null,
    carrier: null, carrier_tracking_url: null, expected_arrival_date: null,
    requested_arrival_date: null, requested_time_window: null,
    requested_at: null, requested_lock_at: null, notes: null,
  };
  const rows: {
    id: string; test_type: string; lab_name: string; tracking_no: string | null;
    shipped: number | null; received: number | null; returned: number | null;
    labRecv: number | null; done: number | null;
  }[] = [
    // step 1 出荷準備 (発送前)
    { id: 'demo-kit-0001', test_type: 'blood',        lab_name: 'リージャー',  tracking_no: null,
      shipped: null, received: null, returned: null, labRecv: null, done: null },
    // step 2 発送済
    { id: 'demo-kit-0002', test_type: 'cancer_urine', lab_name: 'プリベント',  tracking_no: '2345-6789-0123',
      shipped: 2,  received: null, returned: null, labRecv: null, done: null },
    // step 3 受取済
    { id: 'demo-kit-0003', test_type: 'blood',        lab_name: 'リージャー',  tracking_no: '1234-5678-9012',
      shipped: 5,  received: 3,    returned: null, labRecv: null, done: null },
    // step 4 返送済
    { id: 'demo-kit-0004', test_type: 'genetics',     lab_name: 'Genoplan',   tracking_no: '3456-7890-1234',
      shipped: 14, received: 12,   returned: 9,    labRecv: null, done: null },
    // step 5 検査会社受領
    { id: 'demo-kit-0005', test_type: 'blood',        lab_name: 'リージャー',  tracking_no: '4567-8901-2345',
      shipped: 24, received: 22,   returned: 19,   labRecv: 16,   done: null },
    // step 6 検査完了
    { id: 'demo-kit-0006', test_type: 'cancer_urine', lab_name: 'プリベント',  tracking_no: '5678-9012-3456',
      shipped: 60, received: 58,   returned: 55,   labRecv: 52,   done: 46 },
  ];
  const at = (d: number | null) => (d == null ? null : daysAgo(d));
  return rows.map((r) => ({
    ...base,
    id: r.id,
    order_id: `demo-order-${r.id.slice(-4)}`,
    test_type: r.test_type,
    tracking_no: r.tracking_no,
    shipped_at:       at(r.shipped),
    user_received_at: at(r.received),
    user_returned_at: at(r.returned),
    lab_received_at:  at(r.labRecv),
    lab_completed_at: at(r.done),
    created_at: at(r.shipped ?? 1)!,
    lab_name: r.lab_name,
  }) as KitShipment & { lab_name: string | null });
}

/** ダミーのサブスク (プラン名 / 次回検査)。 */
function demoSubscription(uid: string): Subscription & { plan_name: string | null } {
  return {
    id: 'demo-sub-0001', customer_id: uid, plan_id: 'ai', started_at: daysAgo(200),
    next_test_at: daysAhead(35), last_test_at: daysAgo(20),
    current_cycle_year: null, current_cycle_seq: null, status: 'active',
    paused_at: null, cancelled_at: null, created_at: daysAgo(200),
    updated_at: daysAgo(20), plan_name: 'AI予測付パック（年3回）',
  };
}

/** ダッシュボード全体のダミーデータ。実データが空のとき使用。 */
export function buildDemoDashboard(uid: string, displayName: string | null): DashboardData {
  return {
    diagnosticUserId: uid,
    resultUid: uid,
    usingDemoData: true,
    appUser: displayName
      ? ({
          diagnostic_user_id: uid, auth_user_id: null, google_sub: null,
          hp_customer_user_id: null, display_name_cache: displayName,
          eligibility_checked_at: null, created_at: now().toISOString(),
          updated_at: now().toISOString(),
        } as DashboardData['appUser'])
      : null,
    customer: null,
    artifacts: demoArtifacts(uid),
    latestResult: demoLatestResult(uid),
    elithSections: DEMO_REPORT,
    shipments: demoShipments(uid),
    subscription: demoSubscription(uid),
    shipmentSource: 'demo',
  };
}

/** メトリクス推移グラフのダミー系列。 */
/**
 * デモの読み取り結果 (上の md) を系列に起こす。
 *
 * **md を正にして機械で起こす**のが要点。ここで数値を手で書き写すと、
 * 「読み取り結果の表」と「グラフ」が食い違う — AI 報告書で一度踏んだのと同じ罠。
 * 形式は自分で書いた固定の 9 列なので、専用の小さなパーサで足りる
 * (本番の `measurementsFromMarkdown` は canonicalize / app-config を引き込むので使わない)。
 */
function parseDemoScanMd(md: string): Map<string, {
  value: number; unit: string; refLow: number | null; refHigh: number | null;
}> {
  const out = new Map<string, { value: number; unit: string; refLow: number | null; refHigh: number | null }>();
  const numOrNull = (t: string): number | null => {
    const n = Number(t);
    return t === '-' || t === '' || Number.isNaN(n) ? null : n;
  };
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) continue;
    const c = line.split('|').slice(1, -1).map((x) => x.trim());
    // | No | 検査項目 | 検査項目詳細 | 読み取った値 | 単位 | 下限値 | 上限値 | 判定 | 備考 |
    if (c.length < 9 || c[0] === 'No' || /^-+$/.test(c[0])) continue;
    const value = numOrNull(c[3]);
    if (value == null) continue; // 定性 ((-) 等) はグラフにしない
    out.set(c[2], { value, unit: c[4] === '-' ? '' : c[4], refLow: numOrNull(c[5]), refHigh: numOrNull(c[6]) });
  }
  return out;
}

/**
 * 人間ドック / 健康診断のデモ推移。
 *
 * **点は 2 つ** (前回 = demo-art-0014 / 今回 = demo-art-0004)。日付は
 * それぞれの `test_date` と揃えてある — ここがずれると「検査結果」の一覧と
 * グラフで受診日が食い違う。
 *
 * 出すのは**両方の回に数値がある項目だけ** = 実データ経路の
 * `getTrendCandidates` の条件 (日付違いの点が 2 つ以上) と同じ。
 */
function demoHealthCheckupTrend(): MetricTrendSeries[] {
  const prev = parseDemoScanMd(DEMO_SCAN_MD_PREV);
  const latest = parseDemoScanMd(DEMO_SCAN_MD_LATEST);
  const dPrev = daysAgo(HC_DAYS_PREV).slice(0, 10);
  const dLatest = daysAgo(HC_DAYS_LATEST).slice(0, 10);
  const out: MetricTrendSeries[] = [];
  for (const [label, now] of latest) {
    const before = prev.get(label);
    if (!before) continue;
    const point = (date: string, v: number) => ({
      date, value: v, raw: String(v),
      // 判定の印は md の 上限値/下限値 から決める (表の「判定」列と同じ根拠)。
      flag: now.refHigh != null && v > now.refHigh
        ? ('H' as const)
        : now.refLow != null && v < now.refLow
          ? ('L' as const)
          : null,
    });
    out.push({
      label,
      unit: now.unit,
      referenceUpper: now.refHigh ?? undefined,
      referenceLower: now.refLow ?? undefined,
      points: [point(dPrev, before.value), point(dLatest, now.value)],
    });
  }
  return out;
}

/**
 * 系列を 1 本作る小道具。`dates` と `vals` は**古い順**で同じ長さ。
 * 判定の印は基準値から決める (実データ経路が検査機関の `flag` を出すのに合わせた見た目)。
 */
function demoSeries(
  dates: readonly string[],
  label: string,
  unit: string,
  ref: { low?: number; high?: number },
  vals: readonly number[],
): MetricTrendSeries {
  return {
    label,
    unit,
    referenceUpper: ref.high,
    referenceLower: ref.low,
    points: vals.map((value, i) => ({
      date: dates[i],
      value,
      raw: String(value),
      flag:
        ref.high != null && value > ref.high
          ? ('H' as const)
          : ref.low != null && value < ref.low
            ? ('L' as const)
            : null,
    })),
  };
}

/*
 * 血液 / がんリスク / AI疾病予測 の推移。
 *
 * **点は 2 つ**で、日付は `demoArtifacts` の 2 回分の `test_date` と揃える
 * (ずれると「検査結果」の一覧とグラフで受診日が食い違う)。
 * 人間ドックだけ md から機械で起こしている (`demoHealthCheckupTrend`) のは、
 * **同じ画面に読み取り結果の表が出て突き合わせられる**ため。表を持たない種別は
 * 食い違う相手がいないのでここに直接書く。
 *
 * **遺伝子検査は作らない** — 判定のみで経時変化する測定値を持たないので、
 * ダッシュボードにもグラフのボタンを置いていない (仕様どおり)。
 */
function demoBloodTrend(): MetricTrendSeries[] {
  const d = [daysAgo(205).slice(0, 10), daysAgo(20).slice(0, 10)]; // demo-art-0011 / -0001
  return [
    demoSeries(d, 'AST(GOT)', 'U/L', { low: 10, high: 40 }, [24, 29]),
    demoSeries(d, 'ALT(GPT)', 'U/L', { low: 5, high: 45 }, [28, 36]),
    demoSeries(d, 'γ-GTP', 'U/L', { low: 10, high: 79 }, [58, 71]),
    demoSeries(d, '中性脂肪', 'mg/dL', { low: 30, high: 149 }, [142, 166]),
    demoSeries(d, 'HDLコレステロール', 'mg/dL', { low: 40, high: 96 }, [54, 51]),
    demoSeries(d, 'LDLコレステロール', 'mg/dL', { low: 70, high: 139 }, [131, 144]),
    demoSeries(d, 'HbA1c(NGSP)', '%', { low: 4.6, high: 6.2 }, [5.7, 5.9]),
  ];
}

function demoCancerTrend(): MetricTrendSeries[] {
  const d = [daysAgo(230).slice(0, 10), daysAgo(48).slice(0, 10)]; // demo-art-0012 / -0002
  return [
    demoSeries(d, '尿中ポルフィリン量', 'μmol/mol・Cre', { high: 60 }, [38.4, 44.1]),
    demoSeries(d, 'インデックス値', '', { high: 1.0 }, [0.72, 0.86]),
  ];
}

function demoAiPredictionTrend(): MetricTrendSeries[] {
  const d = [daysAgo(440).slice(0, 10), daysAgo(75).slice(0, 10)]; // demo-art-0015 / -0005
  return [
    // 発症予測は「基準値」を持たないので基準線を引かない (印も付かない)。
    demoSeries(d, '糖尿病 発症率', '%', {}, [8.4, 9.6]),
    demoSeries(d, '脳卒中 発症率', '%', {}, [4.1, 4.5]),
    demoSeries(d, '心筋梗塞 発症率', '%', {}, [3.2, 3.0]),
  ];
}

export function demoMetricTrend(testType?: string): MetricTrendSeries[] {
  /*
   * **種別を指定されたら、その種別の系列だけを返す。**
   * 「別種別のサンプルを『この検査の推移』として見せない」ためで、
   * **知らない種別 (遺伝子ほか) は空**を返してその約束を守る。
   */
  if (testType === 'health_checkup') return demoHealthCheckupTrend();
  if (testType === 'blood') return demoBloodTrend();
  if (testType === 'cancer_urine') return demoCancerTrend();
  if (testType === 'ai_prediction') return demoAiPredictionTrend();
  if (testType) return [];
  const dates = [daysAgo(160), daysAgo(110), daysAgo(60), daysAgo(18)].map((d) => d.slice(0, 10));
  const series = (
    label: string, unit: string, ref: number, vals: number[],
  ): MetricTrendSeries => ({
    label, unit, referenceUpper: ref,
    // 検査機関が付ける flag を模す。これが無いとカード表示と推移表示で
    // 基準外の印の有無が食い違う (実測 2026-08)。
    points: vals.map((value, i) => ({
      date: dates[i], value, raw: String(value),
      flag: value > ref ? ('H' as const) : null,
    })),
  });
  return [
    series('尿酸', 'mg/dL', 7.0, [7.0, 7.3, 7.6, 7.8]),
    series('最高血圧', 'mmHg', 129, [134, 131, 129, 128]),
    series('空腹時血糖', 'mg/dL', 99, [101, 104, 106, 108]),
  ];
}

/** お知らせページのダミーデータ。 */
export function buildDemoNotices(uid: string, userName: string): NoticesData {
  const important: UserNotice[] = [
    {
      id: 'demo-un-0001', diagnostic_user_id: uid,
      title: '尿酸値が基準を超えました',
      body: '直近の血液検査で尿酸値が 7.8 mg/dL となり基準値 (7.0) を超えました。生活習慣の見直しと、必要に応じて医療機関の受診をご検討ください。',
      link_url: null, published_at: daysAgo(2), read_at: null, created_at: daysAgo(2),
    } as UserNotice,
    {
      id: 'demo-un-0002', diagnostic_user_id: uid,
      title: '次回検査キットの発送予定について',
      body: '次回の検査キットの発送準備を開始しました。お届け先住所に変更がある場合はご確認ください。',
      link_url: null, published_at: daysAgo(6), read_at: null, created_at: daysAgo(6),
    } as UserNotice,
  ];
  const general: Announcement[] = [
    mkAnn('demo-an-g1', 'general', 'マイページをリニューアルしました',
      'より見やすく使いやすいマイページへリニューアルしました。検査結果のトレンドや AI 健康コーチをご活用ください。', daysAgo(8)),
    mkAnn('demo-an-g2', 'general', '夏季休業期間の検査キット発送について',
      '夏季休業期間は検査キットの発送および検査結果の反映を一時停止いたします。ご了承ください。', daysAgo(15)),
  ];
  const news: Announcement[] = [
    mkAnn('demo-an-n1', 'news', '新プラン「AI予測付パック」を提供開始',
      '血液検査・がんリスク検査に加え、AI による疾病発症予測を組み合わせた新プランの提供を開始しました。', daysAgo(10)),
    mkAnn('demo-an-n2', 'news', 'がんリスク尿検査の対象がん種を拡大',
      '検査機関との連携により、がんリスク尿検査で評価できるがん種を拡大しました。', daysAgo(25)),
  ];
  return {
    diagnosticUserId: uid,
    userName,
    important,
    importantUnreadCount: important.filter((n) => !n.read_at).length,
    general,
    news,
  };
}

function mkAnn(id: string, category: 'general' | 'news', title: string, body: string, published_at: string): Announcement {
  return {
    id, category, title, body, link_url: null, published_at,
    created_at: published_at, source_news_id: null, image_url: null, link_text: null,
    visible_on_hp: category === 'news', visible_on_web: true,
    published_until: null, updated_at: published_at,
  } as Announcement;
}

/** デモのお知らせ未読件数 (バッジ用)。 */
export function demoUnreadImportant(): number {
  return 2;
}
