/**
 * スペシャルアカウントの Elith 納品を「揃った人だけ・本人の uid のまま」まとめて作る。
 *
 * 用途: admin の「Elith納品データ作成（一括）」ボタン
 *   (`POST /api/admin/special-accounts/deliver`)。問診+スキャン済みのスペシャル
 *   アカウントを対象に、ウェルネス年齢を算出 → Elith 納品セットをラップ → S3 へ書き出し
 *   → `elith_deliveries` に記録する。
 *
 * 【なぜ assemble を無改造で使えるか】
 *   `assembleElithDeliverySet` は client_id を `manualMapping` のキーへ書き換える。
 *   **キーに本人の uid を渡せば remap は恒等**（uid→uid）＝本人の client_id を保ったまま
 *   `deliveryPrefix + user/{uid}/date/…` へ納品できる（合成IDにしない）。
 *
 * 【捏造ゼロ】ウェルネス年齢は `computeWellnessAge`（正規版 CABA-v5.4 / 簡易版
 *   CABA-SIMPLE-v7.0・実証済み）で算出。**算出不能な回は HealthAgeData を載せない**
 *   （HC+Lifestyle だけ納品し `wellness_age_method=null`）。値を作らない。
 */

import { getObjectText, putFiles, type S3PutFile } from './s3';
import {
  assembleElithDeliverySet,
  inventoryElithSource,
  type HealthAgeRecord,
  type SubjectInfo,
} from './elith-assemble';
import { normalizeMarkers, type HealthAgeMarkers, type RawItem } from './health-age';
import { computeWellnessAge } from './wellness-age';
import { getServerSupabase } from './supabase';
import { listSpecialAccounts } from './special-accounts';
import { getAccountProgress } from './account-progress';
import { refreshConfig } from './app-config';

export interface DeliverResult {
  uid: string;
  status: 'delivered' | 'skipped' | 'error';
  reason?: string;
  wellness_age_method?: string | null;
  format_ids?: string[];
  file_count?: number;
  bundle_date?: string;
}
export interface DeliverSummary {
  results: DeliverResult[];
  put_count: number;
  delivery_prefix: string;
  ready: number;
  delivered: number;
}

/** customer.sex 表記を 'male'|'female'|null に (elith-assemble.ts と同じ規則)。 */
function normSexStrict(v: unknown): 'male' | 'female' | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'm' || s === 'male' || s === '男' || s === '男性') return 'male';
  if (s === 'f' || s === 'female' || s === '女' || s === '女性') return 'female';
  return null;
}

/** clientId(=uid) → 被験者情報 (customer_profiles)。elith-assemble.ts の resolveSubject と同旨。 */
function makeSubjectResolver(): (uid: string) => Promise<SubjectInfo | null> {
  const cache = new Map<string, SubjectInfo | null>();
  return async (uid: string) => {
    if (!uid) return null;
    if (cache.has(uid)) return cache.get(uid) ?? null;
    let info: SubjectInfo | null = null;
    try {
      const sb = getServerSupabase();
      if (sb) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data } = await (sb.schema('customer') as any)
          .from('customer_profiles')
          .select('date_of_birth, sex')
          .eq('diagnostic_user_id', uid)
          .maybeSingle();
        if (data) {
          const dob = typeof data.date_of_birth === 'string' ? data.date_of_birth.slice(0, 10) : null;
          info = { sex: normSexStrict(data.sex), dateOfBirth: /^\d{4}-\d{2}-\d{2}$/.test(dob ?? '') ? dob : null };
        }
      }
    } catch {
      /* customer 未設定/権限無しは非充填で継続 */
    }
    cache.set(uid, info);
    return info;
  };
}

/** 生年月日 (YYYY-MM-DD) と検査日 (YYYY-MM-DD or YYYY_MM_DD) から満年齢。どちらか無ければ null。 */
function ageAt(dob: string | null, testDate: string | null): number | null {
  if (!dob) return null;
  const t = (testDate ?? '').replace(/_/g, '-');
  const base = /^\d{4}-\d{2}-\d{2}$/.test(t) ? new Date(t) : new Date();
  const b = new Date(dob);
  if (Number.isNaN(b.getTime()) || Number.isNaN(base.getTime())) return null;
  let age = base.getFullYear() - b.getFullYear();
  const m = base.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && base.getDate() < b.getDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/** HC JSON からウェルネス年齢を算出し health_age_scores へ保存。載せられるなら HealthAgeRecord を返す。 */
async function computeWellnessForSource(
  uid: string,
  hcKey: string,
  hcDate: string,
  resolveSubject: (u: string) => Promise<SubjectInfo | null>,
): Promise<HealthAgeRecord | null> {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(await getObjectText(hcKey)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const data = (obj.data ?? {}) as Record<string, unknown>;
  const measurements: RawItem[] = Array.isArray(data.measurements) ? (data.measurements as RawItem[]) : [];
  if (measurements.length === 0) return null;

  const subj = await resolveSubject(uid);
  const testDate = typeof obj.test_date === 'string' ? obj.test_date : hcDate.replace(/_/g, '-');
  const age = ageAt(subj?.dateOfBirth ?? null, testDate);
  const sex = subj?.sex ?? null;

  const normalized = normalizeMarkers(measurements);
  const markers: HealthAgeMarkers = { ...normalized, age, sex } as HealthAgeMarkers;
  const result = computeWellnessAge(markers);
  // 算出不能 (必須マーカー/年齢不足) は載せない・保存しない (捏造ゼロ)。
  if (!result.ok || result.biological_age == null) return null;

  const tDate = /^\d{4}-\d{2}-\d{2}$/.test(testDate) ? testDate : new Date().toISOString().slice(0, 10);
  const computedAt = new Date().toISOString();

  // health_age_scores へ保存 (source_ref=hcKey で assemble が突合できる形)。失敗しても納品は続行。
  try {
    const sb = getServerSupabase();
    if (sb) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (sb.schema('diagnosis') as any).from('health_age_scores').upsert(
        {
          diagnostic_user_id: uid,
          source_kind: 'health_checkup',
          test_date: tDate,
          chronological_age: age,
          biological_age: result.biological_age,
          delta: result.delta,
          model_version: result.model_version,
          source_ref: hcKey,
          inputs: { markers: { ...normalized, age, sex } },
          computed_at: computedAt,
        },
        { onConflict: 'diagnostic_user_id,source_kind,test_date' },
      );
    }
  } catch {
    /* 保存失敗でも in-memory の record で納品には載せる */
  }

  return {
    biological_age: result.biological_age,
    chronological_age: age,
    sex,
    test_date: tDate,
    computed_at: computedAt,
    delta: result.delta ?? null,
    model_version: result.model_version ?? null,
  };
}

/** elith_deliveries に 1 件記録 (冪等: uid×bundle_date×delivery_prefix)。失敗は投げない。 */
async function recordDelivery(row: {
  uid: string;
  bundleDate: string;
  deliveryPrefix: string;
  formatIds: string[];
  fileCount: number;
  wellnessAgeMethod: string | null;
}): Promise<void> {
  try {
    const sb = getServerSupabase();
    if (!sb) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sb.schema('diagnosis') as any).from('elith_deliveries').upsert(
      {
        diagnostic_user_id: row.uid,
        bundle_date: row.bundleDate.replace(/_/g, '-'),
        delivery_prefix: row.deliveryPrefix,
        format_ids: row.formatIds,
        file_count: row.fileCount,
        wellness_age_method: row.wellnessAgeMethod,
        status: 'delivered',
        delivered_at: new Date().toISOString(),
      },
      { onConflict: 'diagnostic_user_id,bundle_date,delivery_prefix' },
    );
  } catch {
    /* 記録失敗でも納品自体は成立している (次回の一覧で✅が出ないだけ) */
  }
}

/**
 * 揃ったスペシャルアカウントの Elith 納品を一括作成する。
 * @param sourcePrefix  元ファイルの prefix (既定 AWS_S3_PREFIX)
 * @param deliveryPrefix 納品先 prefix ('' = バケット直下 = 本番 Elith 受け取り位置)
 */
export async function deliverReadySpecialAccounts(opts: {
  sourcePrefix: string;
  deliveryPrefix: string;
  bundleDate?: string;
}): Promise<DeliverSummary> {
  await refreshConfig(true);
  const snap = listSpecialAccounts();
  const uids = Array.from(
    new Set([
      ...snap.rows.filter((r) => !r.denied).map((r) => r.uid),
      ...snap.emails.map((e) => e.uid).filter((u): u is string => !!u),
    ]),
  );

  const results: DeliverResult[] = [];
  const progress = await getAccountProgress(uids);
  const ready = uids.filter((u) => progress[u]?.interview.done && progress[u]?.scan.done);

  const notReady = uids.filter((u) => !ready.includes(u));
  for (const u of notReady) {
    results.push({ uid: u, status: 'skipped', reason: '問診またはスキャンが未完了' });
  }
  if (ready.length === 0) {
    return { results, put_count: 0, delivery_prefix: opts.deliveryPrefix, ready: 0, delivered: 0 };
  }

  const inv = await inventoryElithSource(opts.sourcePrefix);
  const latestByClient = (fmt: 'HealthCheckupData' | 'LifestyleQuestionnaireData', uid: string) => {
    const items = (inv.byFormat[fmt] ?? []).filter((c) => c.clientId === uid);
    if (items.length === 0) return null;
    // 日付 desc → キー desc の最新 1 件。
    items.sort((a, b) => (a.date === b.date ? b.key.localeCompare(a.key) : b.date.localeCompare(a.date)));
    return items[0];
  };

  const resolveSubject = makeSubjectResolver();
  const healthAgeByRef: Record<string, HealthAgeRecord> = {};
  const manualMapping: Record<string, Partial<Record<'HealthCheckupData' | 'LifestyleQuestionnaireData', string>>> = {};
  const methodByUid = new Map<string, string | null>();

  for (const uid of ready) {
    const hc = latestByClient('HealthCheckupData', uid);
    if (!hc) {
      results.push({ uid, status: 'skipped', reason: 'S3 に HealthCheckupData が見つからない' });
      continue;
    }
    const lq = latestByClient('LifestyleQuestionnaireData', uid);
    manualMapping[uid] = {
      HealthCheckupData: hc.key,
      ...(lq ? { LifestyleQuestionnaireData: lq.key } : {}),
    };

    const rec = await computeWellnessForSource(uid, hc.key, hc.date, resolveSubject);
    if (rec) {
      healthAgeByRef[hc.key] = rec;
      methodByUid.set(uid, rec.model_version);
    } else {
      methodByUid.set(uid, null); // 算出不能 → HealthAge 非同梱
    }
  }

  if (Object.keys(manualMapping).length === 0) {
    return { results, put_count: 0, delivery_prefix: opts.deliveryPrefix, ready: ready.length, delivered: 0 };
  }

  const assembled = await assembleElithDeliverySet({
    sourcePrefix: opts.sourcePrefix,
    deliveryPrefix: opts.deliveryPrefix,
    bundleDate: opts.bundleDate,
    healthAgeByRef,
    resolveSubject,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    manualMapping: manualMapping as any,
  });

  const files: S3PutFile[] = assembled.users.flatMap((u) => u.files);
  const uploaded = await putFiles(files);

  for (const u of assembled.users) {
    const formatIds = Array.from(new Set(u.sources.map((s) => s.formatId)));
    const bundleDate = u.sources[0]?.deliveredDate ?? new Date().toISOString().slice(0, 10).replace(/-/g, '_');
    const method = methodByUid.get(u.userId) ?? null;
    await recordDelivery({
      uid: u.userId,
      bundleDate,
      deliveryPrefix: opts.deliveryPrefix,
      formatIds,
      fileCount: u.sources.length,
      wellnessAgeMethod: method,
    });
    results.push({
      uid: u.userId,
      status: 'delivered',
      wellness_age_method: method,
      format_ids: formatIds,
      file_count: u.sources.length,
      bundle_date: bundleDate,
    });
  }

  return {
    results,
    put_count: uploaded.length,
    delivery_prefix: assembled.deliveryPrefix,
    ready: ready.length,
    delivered: assembled.users.length,
  };
}
