/**
 * Elith 自動納品の **権利 (entitlement) と「揃った」判定** を所有する唯一のモジュール。
 *
 * 正本: `docs/subscription/kit_lifecycle_and_handoff_management_spec.md` §4.3.1
 *
 * 【なぜ切り出すか】夜間 cron (`/api/cron/elith-deliver`) は従来
 *   ①母集団 = スペシャルアカウントのみ ②条件 = 問診済 ∧ スキャン済 の**固定2条件**だった。
 *   契約者 (コースプラン) を拾わず、血液・がんリスク・遺伝子・AI疾病予測も条件に入っていない。
 *   ここを「プランごとの `required_formats` を総当たり」へ一般化する。規則を
 *   `elith-delivery.ts` に散らすと二重管理になるので、**判定はこのファイルだけ**が持つ。
 *
 * 【マスタの所在 — 新しい表を作らない】
 *   権利と必要 format の正本は **Wellfort 側**にある:
 *     - 単品      : `public.single_product_spec` (`entitled_elith` / `required_formats`)
 *     - サブスク  : `public.plan_compositions` (`per_year`/`interval_months`) + `test_kits.format_id`
 *   Scan-Chat-AI に `elith_delivery_spec` を作ると**二重管理**になるため作らない。
 *   ただし現状 `app_bridge` が公開しているのは `customer_account` / `subscription` /
 *   `kit_shipment` の 3 つだけで、**上のマスタは Web から読めない**。
 *   → 橋渡しが通るまでの間は `app_config` の `elith.plan_formats` で plan_code → format を持つ
 *     (運用パラメータなので app_config が置き場所・CLAUDE.md「設定値の置き場所」)。
 *     **app_bridge にマスタの view が生えたら、この resolver の供給元だけ差し替える。**
 *
 * 【fail-closed】plan_code が未知 / 対応が引けないときは **納品しない**。
 *   「分からないから出す」は誤納品 (他人の検査が混ざる・未決済者へ出る) に直結する。
 *   ただし**黙って落とさない** — 理由を必ず結果に載せて admin と cron 応答から見えるようにする。
 */

import { cfg } from './app-config';
import { getBridgeSupabase } from './supabase';

/** Elith の format_id。納品セットの単位 (`elith_s3_data_handoff_spec §2`)。 */
export type ElithFormat =
  | 'HealthCheckupData'
  | 'LifestyleQuestionnaireData'
  | 'BloodTestData'
  | 'CancerRiskAssessmentData'
  | 'GeneticTestResultData'
  | 'Other'
  | 'HealthAgeData';

/**
 * format_id → 「揃った」をどこで確かめるか。
 *
 * - `testType` … `diagnosis.test_artifacts` に status=active の行があるか
 * - `interview` … `diagnosis.interview_completions` に行があるか
 * - `nonBlocking` … **揃い判定に含めない**。HealthAgeData は当社が算出して同梱するもので、
 *   検査の到着を待つ性質のものではない (§4.3.1「HealthAge は非ブロッカー」)。
 */
const FORMAT_SOURCE: Record<ElithFormat, { testType?: string; interview?: true; nonBlocking?: true }> = {
  HealthCheckupData:          { testType: 'health_checkup' },
  BloodTestData:              { testType: 'blood' },
  CancerRiskAssessmentData:   { testType: 'cancer_urine' },
  GeneticTestResultData:      { testType: 'genetics' },
  Other:                      { testType: 'ai_prediction' },
  LifestyleQuestionnaireData: { interview: true },
  HealthAgeData:              { nonBlocking: true },
};

const ALL_FORMATS = Object.keys(FORMAT_SOURCE) as ElithFormat[];

/** 文字列を既知の format_id に正規化する。未知は null (捏造しない)。 */
export function toFormat(raw: string): ElithFormat | null {
  const t = raw.trim();
  return (ALL_FORMATS as string[]).includes(t) ? (t as ElithFormat) : null;
}

/**
 * plan_code → 必要 format の対応表を `app_config` から読む。
 *
 * 書式 (1 行 1 プラン・カンマ区切り):
 *   `plan_code=HealthCheckupData|LifestyleQuestionnaireData, other_plan=...`
 *
 * **解釈できない要素は黙って捨てず無視し、その plan は「未知」として扱う** (fail-closed)。
 */
export function planFormatMap(read: (k: string) => string = cfg): Map<string, ElithFormat[]> {
  const out = new Map<string, ElithFormat[]>();
  const raw = (read('elith.plan_formats') ?? '').trim();
  if (!raw) return out;
  for (const entry of raw.split(',')) {
    const [codeRaw, formatsRaw] = entry.split('=');
    const code = (codeRaw ?? '').trim();
    if (!code || !formatsRaw) continue;
    const formats = formatsRaw
      .split('|')
      .map((f) => toFormat(f))
      .filter((f): f is ElithFormat => f !== null);
    if (formats.length) out.set(code, formats);
  }
  return out;
}

/** 納品対象の候補 1 件。 */
export interface EntitledUser {
  uid: string;
  /** 'subscription' = 契約者 / 'single' = 単品・スペシャル。 */
  kind: 'subscription' | 'single';
  planCode: string | null;
  /** 揃うべき format。null = 対応を引けなかった (fail-closed で納品しない)。 */
  requiredFormats: ElithFormat[] | null;
}

/**
 * **契約者 (コースプラン) の母集団**を `app_bridge.subscription` から取る。
 *
 * - **`status='active'` だけ**。`create-order` は決済前に `status:'pending'` で契約行を作るので、
 *   pending を権利ありと読むと**未決済の人へ納品してしまう** (実装上の既知の仕様違反)。
 * - bridge が引けない環境では空を返す (納品しない = fail-closed)。
 */
export async function listEntitledSubscribers(
  read: (k: string) => string = cfg,
): Promise<EntitledUser[]> {
  const sb = getBridgeSupabase();
  if (!sb) return [];
  const map = planFormatMap(read);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (sb as any)
      .from('subscription')
      .select('diagnostic_user_id, plan_code, status')
      .eq('status', 'active');
    if (error || !data) return [];
    const seen = new Set<string>();
    const out: EntitledUser[] = [];
    for (const r of data as { diagnostic_user_id?: string; plan_code?: string | null }[]) {
      const uid = (r.diagnostic_user_id ?? '').trim().toLowerCase();
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      const planCode = (r.plan_code ?? '').trim() || null;
      out.push({
        uid,
        kind: 'subscription',
        planCode,
        requiredFormats: planCode ? (map.get(planCode) ?? null) : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** 揃い状況の内訳 (1 uid ぶん)。紙面ではなく監査・cron 応答に出す。 */
export interface ReadyCheck {
  ready: boolean;
  /** 揃っていない format。 */
  missing: ElithFormat[];
  /** 判定に使った format (nonBlocking を除いたもの)。 */
  checked: ElithFormat[];
}

/**
 * `required_formats` が全部揃っているかを uid ごとに判定する。
 *
 * `test_artifacts` (status=active) と `interview_completions` の**有無**だけを見る。
 * 回 (cycle) の窓で絞る仕組みは契約テーブルが埋まってから (§4.3.1 の cadence)。
 * ここで日付の窓を推測で入れると、**揃っているのに出ない**が黙って起きる。
 */
export async function checkFormatsReady(
  uids: string[],
  requiredByUid: Map<string, ElithFormat[] | null>,
): Promise<Record<string, ReadyCheck>> {
  const out: Record<string, ReadyCheck> = {};
  const clean = Array.from(new Set(uids.map((u) => u.trim().toLowerCase()).filter(Boolean)));
  for (const u of clean) out[u] = { ready: false, missing: [], checked: [] };
  if (clean.length === 0) return out;

  // 必要な test_type を集める (要らない問い合わせをしない)。
  const neededTypes = new Set<string>();
  let needInterview = false;
  for (const u of clean) {
    for (const f of requiredByUid.get(u) ?? []) {
      const src = FORMAT_SOURCE[f];
      if (src.testType) neededTypes.add(src.testType);
      if (src.interview) needInterview = true;
    }
  }

  const have: Record<string, Set<string>> = {};   // uid → 所持 test_type
  const interviewed = new Set<string>();
  for (const u of clean) have[u] = new Set();

  try {
    const { getServerSupabase } = await import('./supabase');
    const srv = getServerSupabase();
    if (!srv) return out; // 引けない = 納品しない (fail-closed)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diagnosis = (srv as any).schema('diagnosis');

    if (neededTypes.size) {
      const { data } = await diagnosis
        .from('test_artifacts')
        .select('diagnostic_user_id, test_type')
        .eq('status', 'active')
        .in('test_type', Array.from(neededTypes))
        .in('diagnostic_user_id', clean);
      for (const r of (data ?? []) as { diagnostic_user_id: string; test_type: string }[]) {
        have[r.diagnostic_user_id?.toLowerCase()]?.add(r.test_type);
      }
    }
    if (needInterview) {
      const { data } = await diagnosis
        .from('interview_completions')
        .select('diagnostic_user_id')
        .in('diagnostic_user_id', clean);
      for (const r of (data ?? []) as { diagnostic_user_id: string }[]) {
        interviewed.add(String(r.diagnostic_user_id).toLowerCase());
      }
    }
  } catch {
    return out; // 判定できない = 納品しない
  }

  for (const u of clean) {
    out[u] = decideReady(requiredByUid.get(u), have[u], interviewed.has(u));
  }
  return out;
}

/**
 * **揃ったかの判定そのもの** (DB に触れない純粋関数)。
 * 問い合わせと分けてあるのは、ここが唯一の判断で、検査で固定したいのがここだから
 * (`npm run verify:elith-entitlement`)。
 *
 * - 仕様不明 (`null` / 空) は **ready=false** (fail-closed)。
 * - `nonBlocking` (HealthAgeData) は判定に数えない。
 */
export function decideReady(
  required: ElithFormat[] | null | undefined,
  haveTypes: Set<string>,
  interviewed: boolean,
): ReadyCheck {
  if (!required || required.length === 0) return { ready: false, missing: [], checked: [] };
  const checked = required.filter((f) => !FORMAT_SOURCE[f].nonBlocking);
  const missing = checked.filter((f) => {
    const src = FORMAT_SOURCE[f];
    if (src.interview) return !interviewed;
    return src.testType ? !haveTypes.has(src.testType) : false;
  });
  return { ready: missing.length === 0, missing, checked };
}
