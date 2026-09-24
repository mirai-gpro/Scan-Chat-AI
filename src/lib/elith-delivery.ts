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

import { putFiles, type S3PutFile } from './s3';
import {
  assembleElithDeliverySet,
  inventoryElithSource,
  type HealthAgeRecord,
  type SubjectInfo,
} from './elith-assemble';
import { measurementsFromMarkdown, ELITH_HANDOFF_SCHEMA_VERSION } from './elith-export';
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
  /** うちウェルネス年齢(HealthAgeData)を同梱できた件数。算出不能はここに数えない。 */
  wellness_delivered: number;
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

/**
 * DB の最新 health_checkup を取り、確定 Markdown (scan_md) から Elith HealthCheckupData を
 * **画像なしで**生成して S3 (sourcePrefix) へ書き出す。
 *
 * 【なぜ要るか】ユーザースキャンの S3 書き出しは `scan-export-v0` 形式 (フォルダ
 * `{prefix}{diagnosticId}/`) で、Elith 納品形式 `user/{uid}/date/…/HealthCheckupData_…json`
 * ではないため、assemble の inventory が拾えない。`test_artifacts.scan_md`
 * (ユーザースキャン経路だけが書く確定 Markdown) から Elith 形式を起こして揃える。
 * `buildElithScanBundle` は画像を Gemini で再スキャンする設計で原本画像が要るため使えない
 * (ユーザースキャンは原本画像を保存しない)。measurementsFromMarkdown で決定論生成する。
 *
 * 返り値: 生成した HC の {hcKey, measurements, testDate}。scan_md 無し等は null。
 */
async function materializeHealthCheckup(
  uid: string,
  sourcePrefix: string,
): Promise<{
  hcKey: string;
  measurements: Record<string, unknown>[];
  testDate: string;
  ageAtTest: number | null;
  sex: 'male' | 'female' | null;
} | null> {
  const sb = getServerSupabase();
  if (!sb) return null;
  let row: { scan_md?: string | null; test_date?: string | null; age_at_test?: number | null; sex?: string | null } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (sb.schema('diagnosis') as any)
      .from('test_artifacts')
      .select('scan_md, test_date, age_at_test, sex')
      .eq('diagnostic_user_id', uid)
      .eq('test_type', 'health_checkup')
      .eq('status', 'active')
      .order('test_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    row = data ?? null;
  } catch {
    return null;
  }
  const scanMd = typeof row?.scan_md === 'string' ? row.scan_md : '';
  if (!scanMd.trim()) return null; // 確定 Markdown が無い = 生成不能 (捏造しない)

  const measurements = measurementsFromMarkdown(scanMd).kept;
  if (measurements.length === 0) return null;

  const testDate =
    typeof row?.test_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.test_date)
      ? row.test_date
      : new Date().toISOString().slice(0, 10);
  const dateFolder = testDate.replace(/-/g, '_');

  // Elith HealthCheckupData JSON (buildElithScanBundle と同じ shape・source_image/画像は無し)。
  const json = {
    format_id: 'HealthCheckupData',
    schema_version: ELITH_HANDOFF_SCHEMA_VERSION,
    kind: 'scan',
    client_id: uid,
    diagnostic_id: uid,
    source_image: null,
    test_date: testDate,
    date_source: 'test_artifacts',
    exported_at: new Date().toISOString(),
    subject: { sex: null, age: null },
    source: {
      origin: 'scan-chat-ai',
      app: 'scan-chat-ai',
      note: 'special-account deliver: test_artifacts.scan_md から生成 (画像なし・決定論)',
      lab_name: null,
    },
    data: { measurements, notes: [] as unknown[] },
    raw_markdown: scanMd,
  };
  const prefix = sourcePrefix ? sourcePrefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  const hcKey = `${prefix}user/${uid}/date/${dateFolder}/HealthCheckupData_date_${dateFolder}_user_${uid}.json`;
  const body = JSON.stringify(json, null, 2);
  try {
    await putFiles([{ key: hcKey, contentType: 'application/json; charset=utf-8', body, bytes: Buffer.byteLength(body, 'utf8') }]);
  } catch {
    return null; // 書き出せなければ納品対象から外す (assemble が拾えないため)
  }
  const ageAtTest = typeof row?.age_at_test === 'number' && Number.isFinite(row.age_at_test) ? row.age_at_test : null;
  const sex = row?.sex === 'male' || row?.sex === 'female' ? row.sex : null;
  return { hcKey, measurements, testDate, ageAtTest, sex };
}

/** measurements からウェルネス年齢を算出し health_age_scores へ保存。載せられるなら HealthAgeRecord を返す。 */
async function computeWellnessFromMeasurements(
  uid: string,
  measurements: Record<string, unknown>[],
  hcTestDate: string,
  hcKey: string,
  fallbackAge: number | null,
  fallbackSex: 'male' | 'female' | null,
  resolveSubject: (u: string) => Promise<SubjectInfo | null>,
): Promise<HealthAgeRecord | null> {
  if (!Array.isArray(measurements) || measurements.length === 0) return null;

  const subj = await resolveSubject(uid);
  const testDate = hcTestDate;
  // 年齢: ①顧客DBの生年月日×検査日 → ②スキャンが記録した age_at_test (スペシャルアカウントは
  // EC顧客でなく生年月日が無いことがあるため必須のフォールバック)。性別も同様に補完。
  const age = ageAt(subj?.dateOfBirth ?? null, testDate) ?? fallbackAge;
  const sex = subj?.sex ?? fallbackSex;

  const normalized = normalizeMarkers(measurements as RawItem[]);
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
    return { results, put_count: 0, delivery_prefix: opts.deliveryPrefix, ready: 0, delivered: 0, wellness_delivered: 0 };
  }

  const resolveSubject = makeSubjectResolver();
  const healthAgeByRef: Record<string, HealthAgeRecord> = {};
  const manualMapping: Record<string, Partial<Record<'HealthCheckupData' | 'LifestyleQuestionnaireData', string>>> = {};
  const methodByUid = new Map<string, string | null>();
  const hcKeyByUid = new Map<string, string>();

  // ① 各 uid の HealthCheckupData を DB(scan_md) から Elith 形式で生成し S3(source) へ置く。
  //    ウェルネス年齢も同じ measurements から算出 (S3 再読み不要)。
  for (const uid of ready) {
    const mat = await materializeHealthCheckup(uid, opts.sourcePrefix);
    if (!mat) {
      results.push({ uid, status: 'skipped', reason: '確定スキャン(scan_md)が無く HealthCheckupData を生成できない' });
      continue;
    }
    hcKeyByUid.set(uid, mat.hcKey);
    const rec = await computeWellnessFromMeasurements(uid, mat.measurements, mat.testDate, mat.hcKey, mat.ageAtTest, mat.sex, resolveSubject);
    if (rec) {
      healthAgeByRef[mat.hcKey] = rec;
      methodByUid.set(uid, rec.model_version);
    } else {
      methodByUid.set(uid, null); // 算出不能 → HealthAge 非同梱 (捏造しない)
    }
  }

  if (hcKeyByUid.size === 0) {
    return { results, put_count: 0, delivery_prefix: opts.deliveryPrefix, ready: ready.length, delivered: 0, wellness_delivered: 0 };
  }

  // ② HC を置いた後で inventory (HealthCheckupData + Lifestyle を拾える)。
  const inv = await inventoryElithSource(opts.sourcePrefix);
  const latestByClient = (fmt: 'HealthCheckupData' | 'LifestyleQuestionnaireData', uid: string) => {
    const items = (inv.byFormat[fmt] ?? []).filter((c) => c.clientId === uid);
    if (items.length === 0) return null;
    items.sort((a, b) => (a.date === b.date ? b.key.localeCompare(a.key) : b.date.localeCompare(a.date)));
    return items[0];
  };

  for (const uid of hcKeyByUid.keys()) {
    const hcKey = hcKeyByUid.get(uid)!;
    const lq = latestByClient('LifestyleQuestionnaireData', uid);
    manualMapping[uid] = {
      HealthCheckupData: hcKey,
      ...(lq ? { LifestyleQuestionnaireData: lq.key } : {}),
    };
  }

  if (Object.keys(manualMapping).length === 0) {
    return { results, put_count: 0, delivery_prefix: opts.deliveryPrefix, ready: ready.length, delivered: 0, wellness_delivered: 0 };
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

  const wellnessDelivered = assembled.users.filter((u) => methodByUid.get(u.userId)).length;

  return {
    results,
    put_count: uploaded.length,
    delivery_prefix: assembled.deliveryPrefix,
    ready: ready.length,
    delivered: assembled.users.length,
    wellness_delivered: wellnessDelivered,
  };
}
