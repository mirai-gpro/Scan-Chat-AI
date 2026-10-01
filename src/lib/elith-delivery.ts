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
import { putVerified, unverified } from './s3-verified-put';
import {
  assembleElithDeliverySet,
  inventoryElithSource,
  buildHealthAgeJson,
  type HealthAgeRecord,
  type SubjectInfo,
} from './elith-assemble';
import { measurementsFromMarkdown, ELITH_HANDOFF_SCHEMA_VERSION } from './elith-export';
import { extractAgeSex as parseAgeSexFromMarkdown } from './scan-age';
import { normalizeMarkers, type HealthAgeMarkers, type RawItem } from './health-age';
import { computeWellnessAge } from './wellness-age';
import { getServerSupabase } from './supabase';
import { listSpecialAccounts, specialSubjectByUid } from './special-accounts';
import { DERIVED_HC_BLOOD_IMPORTED_BY } from './blood-subset';
import { refreshConfig } from './app-config';
import { buildDeliveryPopulation, checkFormatsReady, listEntitledSubscribers } from './elith-entitlement';

export interface DeliverResult {
  uid: string;
  status: 'delivered' | 'skipped' | 'error';
  reason?: string;
  wellness_age_method?: string | null;
  /** ウェルネス年齢を載せられなかった理由 (載せられた回は付かない)。 */
  wellness_reason?: string;
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
  /**
   * **スペシャルアカウントとして母集団から外した件数** (§17)。
   * 0 件納品でも「対象が居なかった」と「スペシャルだから外した」を混同しないために出す。
   * uid は載せない (結果を admin のログへ流すため)。
   */
  excluded_special: number;
}

/** customer.sex 表記を 'male'|'female'|null に (elith-assemble.ts と同じ規則)。 */
function normSexStrict(v: unknown): 'male' | 'female' | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'm' || s === 'male' || s === '男' || s === '男性') return 'male';
  if (s === 'f' || s === 'female' || s === '女' || s === '女性') return 'female';
  return null;
}

/**
 * clientId(=uid) → 被験者情報 (customer_profiles)。elith-assemble.ts の resolveSubject と同旨。
 * **2026-09-30: `export` を足しただけ。中身は 1 行も変えていない。**
 * 追加検査 (`special-additional-tests.ts`) が**同じ解決順** (customer → スペシャル登録DOB)
 * を使うために要る。写すと片方だけ直る。
 */
export function makeSubjectResolver(): (uid: string) => Promise<SubjectInfo | null> {
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
    /*
     * **スペシャルアカウントの登録値でフォールバック** (発注者指示 2026-09-24)。
     * EC 購入が無い枠は customer_profiles に生年月日を持たないため、登録時に控えた
     * 生年月日・性別 (`special.account_dob`) を年齢ソースにする。customer 側に値が
     * あればそちらを優先し、欠けている項目だけ補う (customer が正)。
     */
    if (!info || !info.dateOfBirth || !info.sex) {
      try {
        const sp = specialSubjectByUid(uid);
        if (sp) {
          info = {
            sex: info?.sex ?? sp.sex,
            dateOfBirth: info?.dateOfBirth ?? sp.dateOfBirth,
          };
        }
      } catch {
        /* 登録が無ければ従来どおり (フォールバックしないだけ) */
      }
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

/** materialize した 1 年分の HealthCheckupData。 */
interface MaterializedHc {
  hcKey: string;
  measurements: Record<string, unknown>[];
  testDate: string;   // YYYY-MM-DD
  dateFolder: string; // YYYY_MM_DD
  fallbackAge: number | null;
  fallbackSex: 'male' | 'female' | null;
}

/**
 * DB の health_checkup を **全件 (複数年・最大5年)** 取り、確定 Markdown (scan_md) から
 * Elith HealthCheckupData を**画像なしで年ごとに** S3 (sourcePrefix) へ書き出す。
 *
 * 【なぜ全年か】複数年スキャン仕様 (`docs/lab/スペシャルアカウント_複数年スキャン_仕様書.md`
 * §4.1/§6.2)= 1 送信 = 1 件の test_artifacts で、最大 5 年分が積まれる。**年ごとに
 * `user/{uid}/date/{YYYY_MM_DD}/HealthCheckupData_…json` を作る**のが仕様。
 * assemble は HealthCheckupData を「時系列 format」として date フォルダごとに納品するので
 * (`elith-assemble.ts` の SERIES_FORMATS)、ここで全年を source に置けば年ごとに 1 つずつ出る。
 *
 * 【なぜ scan_md から起こすか】ユーザースキャンの S3 書き出しは `scan-export-v0` 形式で
 * Elith 納品形式ではなく、原本画像も保存しないため `buildElithScanBundle` (画像再スキャン) は
 * 使えない。`test_artifacts.scan_md` (ユーザースキャンだけが書く確定 Markdown) から決定論生成する。
 *
 * 納品ゲート (仕様 §6.2): scan_md 無し / 読み取り 0 項目の回は作らない (捏造しない)。
 * 返り値: 年ごとの MaterializedHc[] (test_date desc)。無ければ空配列。
 */
export async function materializeHealthCheckups(
  uid: string,
  sourcePrefix: string,
): Promise<MaterializedHc[]> {
  const sb = getServerSupabase();
  if (!sb) return [];
  let rows: Array<{ scan_md?: string | null; test_date?: string | null; age_at_test?: number | null; sex?: string | null }> = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (sb.schema('diagnosis') as any)
      .from('test_artifacts')
      .select('scan_md, test_date, age_at_test, sex')
      .eq('diagnostic_user_id', uid)
      .eq('test_type', 'health_checkup')
      .eq('status', 'active')
      .order('test_date', { ascending: false })
      .limit(20); // 複数年 (仕様上限 5 年に十分な安全枠)
    rows = Array.isArray(data) ? data : [];
  } catch {
    return [];
  }

  const prefix = sourcePrefix ? sourcePrefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  const out: MaterializedHc[] = [];
  const seen = new Set<string>(); // 同一検査日はキー衝突するので 1 つに畳む (先頭=最新キー)

  for (const row of rows) {
    const scanMd = typeof row?.scan_md === 'string' ? row.scan_md : '';
    if (!scanMd.trim()) continue; // 確定 Markdown 無し = 生成不能 (捏造しない)

    const measurements = measurementsFromMarkdown(scanMd).kept;
    if (measurements.length === 0) continue; // 読み取り 0 項目は納品しない (仕様 §6.2)

    const testDate =
      typeof row?.test_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.test_date)
        ? row.test_date
        : new Date().toISOString().slice(0, 10);
    const dateFolder = testDate.replace(/-/g, '_');
    if (seen.has(dateFolder)) continue;
    seen.add(dateFolder);

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
    const hcKey = `${prefix}user/${uid}/date/${dateFolder}/HealthCheckupData_date_${dateFolder}_user_${uid}.json`;
    const body = JSON.stringify(json, null, 2);
    try {
      await putFiles([{ key: hcKey, contentType: 'application/json; charset=utf-8', body, bytes: Buffer.byteLength(body, 'utf8') }]);
    } catch {
      continue; // この年は書けなければ飛ばす (他の年は続行)
    }
    // 年齢・性別のフォールバック: ①test_artifacts.age_at_test/sex → ②scan_md から抽出。
    const fromMd = parseAgeSexFromMarkdown(scanMd);
    const ageAtTest = typeof row?.age_at_test === 'number' && Number.isFinite(row.age_at_test) ? row.age_at_test : null;
    const dbSex = row?.sex === 'male' || row?.sex === 'female' ? row.sex : null;
    out.push({
      hcKey,
      measurements,
      testDate,
      dateFolder,
      fallbackAge: ageAtTest ?? fromMd.age,
      fallbackSex: dbSex ?? fromMd.sex,
    });
  }
  return out;
}

/**
 * **人間ドック・健康診断由来の派生 blood（`BloodTestData`）を S3(source) へ年ごとに書き出す。**
 *
 * 正本: `docs/specs/healthcheckup_blood_extraction_spec_20261001.md` §8.2 / §8.3 / §8.6。
 *
 * 【`materializeHealthCheckups` と同型】同じ段・同じ命名規約・同じ fail-safe（書けない年は飛ばす）。
 * **下流（`assembleElithDeliverySet`）は 1 行も変えない** — `BloodTestData` は既に
 * 時系列 format（`elith-assemble.ts` の `SERIES_FORMATS`）なので、規約どおりのキーで置けば拾われる。
 *
 * 【材料】派生 artifact の `measurements`(jsonb)。**再解析しない**し、
 * `scan_md` からの再抽出もしない（保存時に `blood-subset.ts` が決めた結果をそのまま使う）。
 *
 * 【同一日は通常 blood を優先（裁定 Q-10）】納品キーは 1 日 1 format 1 ファイルなので、
 * 同じ date に通常由来の `BloodTestData` が既に在る年は **書かない**（上書きしない）。
 *
 * 【`raw_markdown` を載せない】人間ドックの全項目（血球・腫瘍マーカー等）が
 * `BloodTestData` に同梱されてしまい、v1.1 §9「血球系・CRP・腫瘍マーカー等は含めない」に反するため。
 */
async function materializeDerivedBloodTests(
  uid: string,
  sourcePrefix: string,
  /** source prefix に既に在る「通常由来」`BloodTestData` の date フォルダ（`YYYY_MM_DD`）。 */
  normalBloodDates: ReadonlySet<string>,
): Promise<{ keys: string[]; skippedDates: string[] }> {
  const out: { keys: string[]; skippedDates: string[] } = { keys: [], skippedDates: [] };
  const sb = getServerSupabase();
  if (!sb) return out;
  let rows: Array<{ measurements?: unknown; test_date?: string | null }> = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (sb.schema('diagnosis') as any)
      .from('test_artifacts')
      .select('measurements, test_date')
      .eq('diagnostic_user_id', uid)
      .eq('test_type', 'blood')
      .eq('status', 'active')
      .eq('imported_by', DERIVED_HC_BLOOD_IMPORTED_BY)
      .order('test_date', { ascending: false })
      .limit(20); // 複数年 (仕様上限 5 年に十分な安全枠)
    rows = Array.isArray(data) ? data : [];
  } catch {
    return out;
  }

  const prefix = sourcePrefix ? sourcePrefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  const seen = new Set<string>();
  for (const row of rows) {
    const measurements = Array.isArray(row?.measurements) ? (row.measurements as Record<string, unknown>[]) : [];
    if (measurements.length === 0) continue; // 0 項目は納品しない (裁定 Q-6 と同じ規律)
    const testDate =
      typeof row?.test_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.test_date) ? row.test_date : null;
    if (!testDate) continue; // 受診日が無い回は date フォルダを決められない
    const dateFolder = testDate.replace(/-/g, '_');
    if (seen.has(dateFolder)) continue;
    seen.add(dateFolder);
    // **同一日は通常 blood を優先** — 書くと同名キーで上書きしてしまう (裁定 Q-10)。
    if (normalBloodDates.has(dateFolder)) { out.skippedDates.push(dateFolder); continue; }

    const json = {
      format_id: 'BloodTestData',
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
        // **固定文言**（発注者裁定 Q-8）。変えない。
        note: '人間ドック・健康診断の既存AIスキャン結果から血液検査値を抽出（再解析なし）',
        lab_name: null,
      },
      // measurements は保存時に確定した 7 フィールドのまま（裁定 Q-9・独自構造を作らない）。
      data: { measurements, notes: [] as unknown[] },
      // raw_markdown は載せない（上のコメント）。
    };
    const key = `${prefix}user/${uid}/date/${dateFolder}/BloodTestData_date_${dateFolder}_user_${uid}.json`;
    const body = JSON.stringify(json, null, 2);
    try {
      await putFiles([{ key, contentType: 'application/json; charset=utf-8', body, bytes: Buffer.byteLength(body, 'utf8') }]);
      out.keys.push(key);
    } catch {
      continue; // この年は書けなければ飛ばす (他の年は続行)
    }
  }
  return out;
}

/** measurements からウェルネス年齢を算出し health_age_scores へ保存。載せられるなら HealthAgeRecord を返す。 */
export async function computeWellnessFromMeasurements(
  uid: string,
  measurements: Record<string, unknown>[],
  hcTestDate: string,
  hcKey: string,
  fallbackAge: number | null,
  fallbackSex: 'male' | 'female' | null,
  resolveSubject: (u: string) => Promise<SubjectInfo | null>,
): Promise<{ rec: HealthAgeRecord | null; reason: string | null }> {
  if (!Array.isArray(measurements) || measurements.length === 0) return { rec: null, reason: '測定値なし' };

  const subj = await resolveSubject(uid);
  const testDate = hcTestDate;
  // 年齢: ①顧客DBの生年月日×検査日 → ②age_at_test → ③scan_md 抽出 (materialize が合成した fallback)。
  const age = ageAt(subj?.dateOfBirth ?? null, testDate) ?? fallbackAge;
  const sex = subj?.sex ?? fallbackSex;

  const normalized = normalizeMarkers(measurements as RawItem[]);
  const markers: HealthAgeMarkers = { ...normalized, age, sex } as HealthAgeMarkers;
  const result = computeWellnessAge(markers);
  // 算出不能 (必須マーカー/年齢不足) は載せない・保存しない (捏造ゼロ)。理由を返して可視化。
  if (!result.ok || result.biological_age == null) {
    const missing = Array.isArray(result.missing_simple) && result.missing_simple.length
      ? result.missing_simple.join('/')
      : (age == null ? '年齢' : '必須項目');
    return { rec: null, reason: `算出不能(不足: ${missing})` };
  }

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
    rec: {
      biological_age: result.biological_age,
      chronological_age: age,
      sex,
      test_date: tDate,
      computed_at: computedAt,
      delta: result.delta ?? null,
      model_version: result.model_version ?? null,
    },
    reason: null,
  };
}

/**
 * **admin バッチ (elith-scan / elith-hc-merge finalize) から使う: HealthCheckupData と同じ
 * date フォルダへ HealthAgeData JSON を書く。**
 *
 * バッチ経路は assemble を通らないので、ここで年齢を解決してウェルネス年齢を算出し、
 * HealthCheckupData と同じ `user/{uid}/date/{YYYY_MM_DD}/` へ HealthAgeData を並べる。
 * これで promote が HC と一緒に HealthAgeData も納品先へ複製できる (複数年=年ごとに 1 つずつ)。
 *
 * 年齢の解決は deliver 経路と同一 (`makeSubjectResolver`): 顧客DB生年月日 → スペシャル
 * アカウント登録DOB (`special.account_dob`) → 呼び出し側の fallback (scan 抽出年齢)。
 * **算出不能 (年齢/必須マーカー不足) は書かない・捏造しない**。理由を返して可視化する。
 * health_age_scores への保存は `computeWellnessFromMeasurements` が行う (source_ref=hcKey)。
 */
export async function writeHealthAgeForHc(opts: {
  uid: string;
  measurements: Record<string, unknown>[];
  testDate: string; // YYYY-MM-DD (今回受診日)
  hcKey: string; // HealthCheckupData の S3 キー (source_ref)
  prefix: string; // AWS_S3_PREFIX (例 scan-accuracy-test/)
  fallbackAge?: number | null;
  fallbackSex?: 'male' | 'female' | null;
}): Promise<{ written: boolean; key?: string; reason?: string; biological_age?: number | null; chronological_age?: number | null }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.testDate)) return { written: false, reason: '受診日が不正' };
  const resolveSubject = makeSubjectResolver();
  const { rec, reason } = await computeWellnessFromMeasurements(
    opts.uid,
    opts.measurements,
    opts.testDate,
    opts.hcKey,
    opts.fallbackAge ?? null,
    opts.fallbackSex ?? null,
    resolveSubject,
  );
  if (!rec) return { written: false, reason: reason ?? '算出不能' };

  const subj = await resolveSubject(opts.uid).catch(() => null);
  const dateFolder = opts.testDate.replace(/-/g, '_');
  const cleanPrefix = opts.prefix ? opts.prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  const key = `${cleanPrefix}user/${opts.uid}/date/${dateFolder}/HealthAgeData_date_${dateFolder}_user_${opts.uid}.json`;
  const body = buildHealthAgeJson(opts.uid, dateFolder, rec, opts.hcKey, subj);
  try {
    await putFiles([{ key, contentType: 'application/json; charset=utf-8', body, bytes: Buffer.byteLength(body, 'utf8') }]);
  } catch (err) {
    return { written: false, reason: `S3 書き込み失敗: ${String(err instanceof Error ? err.message : err)}` };
  }
  return { written: true, key, biological_age: rec.biological_age, chronological_age: rec.chronological_age };
}

/**
 * 既に納品済みの `uid|YYYY-MM-DD` を集める (夜間 cron が同じ回を毎晩 Elith へ再送しないため)。
 *
 * **取れなければ空集合を返す (fail-open)** — 取りこぼしよりは、同一内容の再ラップ (無害・
 * 決定論で同じ JSON を同じキーへ上書き) の方がまし。呼び出し側は skipDelivered のときだけ使う。
 */
async function loadDeliveredBundles(uids: string[], deliveryPrefix: string): Promise<Set<string>> {
  const set = new Set<string>();
  if (uids.length === 0) return set;
  try {
    const sb = getServerSupabase();
    if (!sb) return set;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (sb.schema('diagnosis') as any)
      .from('elith_deliveries')
      .select('diagnostic_user_id, bundle_date')
      .in('diagnostic_user_id', uids)
      .eq('delivery_prefix', deliveryPrefix)
      .eq('status', 'delivered');
    for (const r of data ?? []) {
      const uid = String(r.diagnostic_user_id ?? '').toLowerCase();
      const d = typeof r.bundle_date === 'string' ? r.bundle_date.slice(0, 10) : '';
      if (uid && d) set.add(`${uid}|${d}`);
    }
  } catch (e) {
    console.warn('[elith-delivery] loadDeliveredBundles 失敗 (全件処理へ):', e instanceof Error ? e.message : e);
  }
  return set;
}

/** elith_deliveries に 1 件記録 (冪等: uid×bundle_date×delivery_prefix)。失敗は投げない。 */
export async function recordDelivery(row: {
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
  /**
   * **既に納品済みの回を再送しない** (夜間 cron 用)。admin ボタンは未指定=false で
   * 従来どおり毎回ラップし直す (手動で「作り直したい」に応えるため)。cron は true。
   */
  skipDelivered?: boolean;
}): Promise<DeliverSummary> {
  await refreshConfig(true);
  /*
   * 母集団 = **契約者・単品 (`app_bridge.subscription` の status='active') だけ**。
   * **スペシャルアカウントは 1 件も入れない。**
   *
   * 【2026-10-01 変更・P1】正本 `docs/specs/special_account_management_spec_20261001.md`
   * §9.1 / §17 / §18.2。スペシャルの Elith 本番納品は
   * **`/admin/special-accounts` の［Elith納品］を人が押したときだけ**になった。
   * 以前はここが `listSpecialAccounts()` の uid を母集団に含めていたため、
   * **人の確認を通らずに 23:00 JST の cron が本番へ書いていた**。
   *
   * 除外は**ここ 1 か所だけ**で行う (`api/cron/elith-deliver.ts` 側に条件を書くと
   * cron と一括ボタンで母集団がずれて二重管理になる・§9.5)。
   * 判定は純粋関数 `buildDeliveryPopulation()` が持つ — **ここは静かに壊れる**
   * (契約者が納品されなくなっても画面は正常に見える) ので
   * `verify:special-account-management` A-1〜A-5 が両方向を見張る。
   *
   * 契約者は status='active' だけを採る (`create-order` は決済前に pending で契約行を
   * 作るので、pending を権利と読むと未決済の人へ納品してしまう)。
   * 必要 format は plan_code から引き、**引けなければ納品しない (fail-closed)**。
   */
  const snap = listSpecialAccounts();
  const subscribers = await listEntitledSubscribers();
  const population = buildDeliveryPopulation({
    // 除外リストに入っている uid も**外す**。緊急停止した人が自動納品だけ生き残るのは逆。
    specialUids: [
      ...snap.rows.map((r) => r.uid),
      ...snap.emails.map((e) => e.uid).filter((u): u is string => !!u),
    ],
    subscribers,
  });
  const uids = population.uids;
  const requiredByUid = population.requiredByUid;

  const results: DeliverResult[] = [];

  const readiness = await checkFormatsReady(uids, requiredByUid);
  const ready = uids.filter((u) => readiness[u]?.ready);

  for (const u of uids) {
    if (readiness[u]?.ready) continue;
    const req = requiredByUid.get(u);
    const planCode = subscribers.find((s) => s.uid === u)?.planCode ?? null;
    results.push({
      uid: u,
      status: 'skipped',
      // **黙って落とさない。** 「何が足りないか」「仕様が引けないのか」を必ず出す。
      reason: !req || req.length === 0
        ? `必要 format の仕様を引けないため納品しません (plan_code=${planCode ?? '不明'})`
        : `未着の検査があります: ${(readiness[u]?.missing ?? []).join(' / ')}`,
    });
  }
  if (ready.length === 0) {
    return { results, put_count: 0, delivery_prefix: opts.deliveryPrefix, ready: 0, delivered: 0, wellness_delivered: 0, excluded_special: population.excludedSpecial.length };
  }

  const resolveSubject = makeSubjectResolver();
  const healthAgeByRef: Record<string, HealthAgeRecord> = {};
  const manualMapping: Record<string, Partial<Record<'HealthCheckupData' | 'LifestyleQuestionnaireData' | 'BloodTestData', string>>> = {};
  const wellnessReasonByUid = new Map<string, string>();
  const wellnessYearsByUid = new Map<string, number>(); // その uid で HealthAge を載せた年数
  const repHcKeyByUid = new Map<string, string>();       // manualMapping 用の代表(最新年)キー

  // 夜間 cron 用: 既に納品済みの回 (uid|test_date) は再送しない (skipDelivered)。
  const deliveredSet = opts.skipDelivered ? await loadDeliveredBundles(ready, opts.deliveryPrefix) : new Set<string>();

  // ① 各 uid の HealthCheckupData を **年ごと(複数年)** に DB(scan_md) から Elith 形式で生成し
  //    S3(source) へ置く。ウェルネス年齢も **年ごと** に算出し、各年の hcKey で healthAgeByRef へ。
  for (const uid of ready) {
    const mats = await materializeHealthCheckups(uid, opts.sourcePrefix);
    if (mats.length === 0) {
      results.push({ uid, status: 'skipped', reason: '確定スキャン(scan_md)が無く HealthCheckupData を生成できない' });
      continue;
    }
    // 冪等: skipDelivered のとき、**全ての年が納品済み**なら uid ごとスキップ。
    // 新しい年が 1 つでもあれば全体を出し直す (assemble は inventory の全 date を出すため。
    // 既納品の年は同一内容・同一キーの上書きで無害)。
    if (opts.skipDelivered && mats.every((m) => deliveredSet.has(`${uid.toLowerCase()}|${m.testDate}`))) {
      results.push({ uid, status: 'skipped', reason: '全ての回が既に納品済み' });
      continue;
    }
    repHcKeyByUid.set(uid, mats[0].hcKey); // mats は test_date desc = 先頭が最新
    let wellnessYears = 0;
    let lastReason: string | null = null;
    for (const m of mats) {
      const { rec, reason } = await computeWellnessFromMeasurements(
        uid, m.measurements, m.testDate, m.hcKey, m.fallbackAge, m.fallbackSex, resolveSubject,
      );
      if (rec) { healthAgeByRef[m.hcKey] = rec; wellnessYears++; }
      else lastReason = reason ?? '算出不能';
    }
    wellnessYearsByUid.set(uid, wellnessYears);
    if (wellnessYears === 0 && lastReason) wellnessReasonByUid.set(uid, lastReason);
  }

  if (repHcKeyByUid.size === 0) {
    return { results, put_count: 0, delivery_prefix: opts.deliveryPrefix, ready: ready.length, delivered: 0, wellness_delivered: 0, excluded_special: population.excludedSpecial.length };
  }

  // ② HC を置いた後で inventory (問診 Lifestyle を拾う。HealthCheckup は assemble が全 date を出す)。
  const inv = await inventoryElithSource(opts.sourcePrefix);
  const latestByClient = (fmt: 'HealthCheckupData' | 'LifestyleQuestionnaireData', uid: string) => {
    const items = (inv.byFormat[fmt] ?? []).filter((c) => c.clientId === uid);
    if (items.length === 0) return null;
    items.sort((a, b) => (a.date === b.date ? b.key.localeCompare(a.key) : b.date.localeCompare(a.date)));
    return items[0];
  };

  /*
   * ②-2 **人間ドック由来の派生 BloodTestData** を source へ置く
   *     (`docs/specs/healthcheckup_blood_extraction_spec_20261001.md` §8.2・裁定 Q-4/Q-10)。
   *
   * - **inventory の後**に走らせる — 同じ date に**通常由来**の BloodTestData が既に在るかを
   *   見てから書く必要があるため (同名キーなので書くと上書きになる・裁定 Q-10)。
   * - **readiness には一切関わらない。** 揃い判定は `checkFormatsReady()` 側で
   *   `imported_by` を見て派生を外してある (`elith-entitlement.ts`)。
   *   ここは「揃った人の納品セットには含める」側の処理。
   */
  const bloodKeyByUid = new Map<string, string>();
  for (const uid of repHcKeyByUid.keys()) {
    const existing = (inv.byFormat.BloodTestData ?? []).filter((c) => c.clientId === uid);
    const normalDates = new Set(existing.map((c) => c.date));
    const derived = await materializeDerivedBloodTests(uid, opts.sourcePrefix, normalDates);
    // 代表キーは「通常が在ればそれ / 無ければ派生」。assemble は代表の client の
    // **全 date** を時系列として展開するので、どちらを渡しても両方が納品される。
    const rep = existing.length > 0
      ? existing.slice().sort((a, b) => (a.date === b.date ? b.key.localeCompare(a.key) : b.date.localeCompare(a.date)))[0].key
      : derived.keys[0];
    if (rep) bloodKeyByUid.set(uid, rep);
  }

  for (const uid of repHcKeyByUid.keys()) {
    const lq = latestByClient('LifestyleQuestionnaireData', uid);
    const bl = bloodKeyByUid.get(uid);
    manualMapping[uid] = {
      // 代表(最新年)のみ渡すが、assemble は HealthCheckupData を時系列 format として
      // この client の**全 date フォルダ**へ展開する (年ごとに 1 つずつ納品される)。
      HealthCheckupData: repHcKeyByUid.get(uid)!,
      ...(lq ? { LifestyleQuestionnaireData: lq.key } : {}),
      // BloodTestData も時系列 format。**mapping に載せないと納品されない**
      // (`elith-assemble.ts` の manualMapping 経路は載っている format だけを picks に入れる)。
      ...(bl ? { BloodTestData: bl } : {}),
    };
  }

  if (Object.keys(manualMapping).length === 0) {
    return { results, put_count: 0, delivery_prefix: opts.deliveryPrefix, ready: ready.length, delivered: 0, wellness_delivered: 0, excluded_special: population.excludedSpecial.length };
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
  /*
   * **読み戻して突合するまで「納品完了」と言わない**（D-1・§9.6）。
   * 以前はここが `putFiles` で、**PutObject の成否だけ**を見ていた。
   * 追加検査経路 (`deliverAdditionalJson`) には読み戻しが在るのに、
   * 本体の納品経路に無いのは逆だった。
   *
   * 追加 GET は **新規 / 内容が変わったファイルで最大 2 回**（事前比較 + readback）、
   * 既存と同一内容なら 1 回で PUT は 0 回。
   */
  const putResults = await putVerified(files);
  const verifiedKeys = new Set(putResults.filter((r) => r.verified).map((r) => r.key));
  const failed = unverified(putResults);

  // 納品記録・集計は **年(date フォルダ)ごと**。elith_deliveries は (uid, bundle_date) 単位なので
  // 各年を 1 行として記録する (冪等の skipDelivered もこの粒度で効く)。
  let wellnessDeliveredYears = 0; // うちウェルネス年齢(HealthAgeData)を載せた年数
  for (const u of assembled.users) {
    const byDate = new Map<string, typeof u.sources>();
    for (const s of u.sources) {
      const arr = byDate.get(s.deliveredDate);
      if (arr) arr.push(s);
      else byDate.set(s.deliveredDate, [s]);
    }
    const uidFormatIds = Array.from(new Set(u.sources.map((s) => s.formatId)));
    for (const [date, srcs] of byDate) {
      const formatIds = Array.from(new Set(srcs.map((s) => s.formatId)));
      const hasHealthAge = formatIds.includes('HealthAgeData');
      /*
       * **一部でも読み戻せていない年は `delivered` として記録しない**（§9.6.2 b）。
       * 「書けたが読み戻せていない」を納品済みと呼ぶと、`skipDelivered` が
       * 次回その年を飛ばして**穴が埋まらないまま固定される**。
       */
      if (srcs.some((s) => !verifiedKeys.has(s.newKey))) continue;
      if (hasHealthAge) wellnessDeliveredYears++;
      await recordDelivery({
        uid: u.userId,
        bundleDate: date,
        deliveryPrefix: opts.deliveryPrefix,
        formatIds,
        fileCount: srcs.length,
        wellnessAgeMethod: hasHealthAge ? 'CABA' : null,
      });
    }
    const years = wellnessYearsByUid.get(u.userId) ?? 0;
    results.push({
      uid: u.userId,
      status: 'delivered',
      wellness_age_method: years > 0 ? 'CABA' : null,
      ...(years > 0 ? {} : { wellness_reason: wellnessReasonByUid.get(u.userId) ?? '算出不能' }),
      format_ids: uidFormatIds,
      file_count: u.sources.length,
      // 複数年は date をまとめて出す (何年分納品したかが分かる)。
      bundle_date: Array.from(byDate.keys()).sort().join(','),
    });
  }

  /*
   * **黙って落とさない**（§9.6.2 c）。読み戻せなかったファイルは件数と理由を結果に載せる。
   * uid ごとにまとめて 1 行出す（ファイル単位で並べると結果が読めなくなる）。
   */
  if (failed.length > 0) {
    const byUid = new Map<string, number>();
    for (const f of failed) {
      const m = f.key.match(/user\/([^/]+)\//);
      const u = m ? m[1] : '(unknown)';
      byUid.set(u, (byUid.get(u) ?? 0) + 1);
    }
    for (const [u, n] of byUid) {
      results.push({
        uid: u,
        status: 'error',
        reason: `${n} 件が読み戻し検証を通りませんでした（${failed.filter((f) => f.key.includes(`user/${u}/`)).map((f) => f.error).join(' / ')}）`,
      });
    }
  }

  return {
    results,
    put_count: putResults.filter((r) => r.verified).length,
    delivery_prefix: assembled.deliveryPrefix,
    ready: ready.length,
    delivered: assembled.users.length,
    // **年単位**の件数 (複数年なら 1 uid で複数)。「うちウェルネス年齢 N 件」= HealthAge を載せた年数。
    wellness_delivered: wellnessDeliveredYears,
    excluded_special: population.excludedSpecial.length,
  };
}
