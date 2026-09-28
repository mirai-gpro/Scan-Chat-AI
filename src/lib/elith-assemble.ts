/**
 * Elith 納品セット アセンブリ (サーバ専用)。
 *
 * S3 に種別ごと・別 client_id で散在している検査データ (a〜e) を、
 * 「1 人 = 1 ユーザーID フォルダに 5 種を束ねた」納品セットへ組み直す。
 *   - 各種別から 1 件ずつ選び (自動=ラウンドロビン / 手動=source key 指定)、
 *     JSON の client_id・パス・ファイル名を統一 ID へ書き換えてコピーする。
 *   - 合成テストデータ (実在の同一人物ではない) 用途。検証・チューニング向け。
 *   - PII は元 JSON が既に非含有 (subject は性別+年齢のみ)。原本画像/CSV は含めない。
 *
 * キー(AWS_*)は Vercel 環境変数のみ (CLAUDE.md) → 必ずサーバ側で実行。
 */

import {
  isElithFormatId,
  ELITH_HANDOFF_SCHEMA_VERSION,
  sanitizeMeasurementsForDelivery,
  canonicalizeEnabled,
  obsDedupEnabled,
  type ElithFormatId,
  type MeasurementAnomaly,
} from './elith-export';
import { canonicalize } from './canonicalize';
import { dedupObservations } from './observation-dedup';
import { listObjects, getObjectText, type S3PutFile } from './s3';

/** 納品対象の 5 種別 (順序は納品時の見せ方に使用) */
// 完全性(この回に揃うべき)判定に使う必須 format。Other(AI疾病予測)は任意なので含めない。
export const GATING_FORMAT_IDS: ElithFormatId[] = [
  'HealthCheckupData',
  'BloodTestData',
  'GeneticTestResultData',
  'CancerRiskAssessmentData',
  'LifestyleQuestionnaireData',
];
// 納品対象 format。GATING に加え Other(AI疾病予測) も納品する（完全性はゲートしない）。
export const DELIVERY_FORMAT_IDS: ElithFormatId[] = [...GATING_FORMAT_IDS, 'Other'];

export interface CatalogItem {
  key: string;
  formatId: ElithFormatId;
  date: string; // YYYY_MM_DD (フォルダ表記)
  clientId: string;
  size?: number; // S3 上のバイトサイズ (空データ判定の目安)
}

/** JSON キー `…/{format_id}_date_{YYYY_MM_DD}_user_{client_id}.json` を分解 */
export function parseElithKey(key: string): CatalogItem | null {
  const file = key.split('/').pop() ?? '';
  const m = /^([A-Za-z]+)_date_(\d{4}_\d{2}_\d{2})_user_(.+)\.json$/.exec(file);
  if (!m) return null;
  const [, formatId, date, clientId] = m;
  if (!isElithFormatId(formatId)) return null;
  return { key, formatId, date, clientId };
}

/**
 * Elith ハンドオフ JSON の「実データ件数」を数える (空データ判定用)。
 * `data` 配下 (measurements / items / rows 等) の配列要素数を再帰的に合計する。
 * `data` が無ければトップレベルを走査。パース不能は -1。
 */
export function countDataItems(jsonText: string): number {
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return -1;
  }
  const root =
    obj && typeof obj === 'object' && 'data' in (obj as Record<string, unknown>)
      ? (obj as Record<string, unknown>).data
      : obj;
  let n = 0;
  const seen = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      n += v.length;
      for (const e of v) if (e && typeof e === 'object') walk(e);
    } else if (v && typeof v === 'object') {
      if (seen.has(v)) return;
      seen.add(v);
      for (const val of Object.values(v as Record<string, unknown>)) walk(val);
    }
  };
  walk(root);
  return n;
}

function normPrefix(p: string): string {
  return p ? p.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
}
function utf8Bytes(s: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : Buffer.byteLength(s, 'utf-8');
}

// ── 棚卸し ──────────────────────────────────────────────────────
export interface Inventory {
  sourcePrefix: string;
  byFormat: Record<string, CatalogItem[]>;
  counts: Record<string, number>;
  missing: ElithFormatId[];
  /** 5 種すべてが 1 件以上揃う人数の上限 (= 最少種別の件数) */
  maxCompleteUsers: number;
}

/** ソース prefix を走査し、5 種別ごとに JSON を棚卸しする。 */
export async function inventoryElithSource(sourcePrefix: string): Promise<Inventory> {
  const prefix = normPrefix(sourcePrefix);
  const objs = await listObjects(prefix);
  const byFormat: Record<string, CatalogItem[]> = {};
  for (const f of DELIVERY_FORMAT_IDS) byFormat[f] = [];
  for (const o of objs) {
    if (!o.key.endsWith('.json')) continue;
    const item = parseElithKey(o.key);
    if (!item) continue;
    if (!DELIVERY_FORMAT_IDS.includes(item.formatId)) continue;
    item.size = o.size;
    byFormat[item.formatId].push(item);
  }
  // 安定した順序 (date→key) にソート
  for (const f of DELIVERY_FORMAT_IDS) {
    byFormat[f].sort((a, b) => (a.date === b.date ? a.key.localeCompare(b.key) : a.date.localeCompare(b.date)));
  }
  const counts: Record<string, number> = {};
  const missing: ElithFormatId[] = [];
  let maxComplete = Infinity;
  for (const f of DELIVERY_FORMAT_IDS) counts[f] = byFormat[f].length; // 情報用 (Other 含む)
  // 完全性(欠落/最大人数)は必須 format のみで判定。Other(任意)は 0 件でもゲートしない。
  for (const f of GATING_FORMAT_IDS) {
    const n = byFormat[f].length;
    if (n === 0) missing.push(f);
    maxComplete = Math.min(maxComplete, n);
  }
  return {
    sourcePrefix: prefix,
    byFormat,
    counts,
    missing,
    maxCompleteUsers: Number.isFinite(maxComplete) ? maxComplete : 0,
  };
}

// ── アセンブリ ──────────────────────────────────────────────────
/** ウェルネス年齢 (CABA) の算出済みスコア。health_age_scores を source_ref で突合して納品に載せる。 */
export interface HealthAgeRecord {
  biological_age: number | null;   // ウェルネス年齢
  chronological_age: number | null; // 実年齢
  sex: 'male' | 'female' | null;   // 性別 (inputs.markers.sex 由来。subject.sex に載せる)
  test_date: string | null;        // 元データ取得日
  computed_at: string | null;      // 算出日時
  delta: number | null;            // biological - chronological
  model_version: string | null;
}

/** 妥当性ガードで納品から除外した項目の型は elith-export に集約 (後方互換で再エクスポート)。 */
export type { MeasurementAnomaly } from './elith-export';
export interface AssembledUserSource {
  formatId: string; // ElithFormatId または 'HealthAgeData' (生成)
  sourceKey: string;
  /** コピー元の取得日 (YYYY_MM_DD) */
  sourceDate: string;
  /** 納品フォルダ/ファイル名に使う統一日付 (YYYY_MM_DD) */
  deliveredDate: string;
  newKey: string;
  /** コピー元 JSON の実データ件数 (0 = 空データ。-1 = パース不能)。 */
  dataItems: number;
  /** 妥当性ガードで除外した項目 (あれば)。納品物には出さず結果でのみ可視化。 */
  anomalies?: MeasurementAnomaly[];
}
export interface AssembledUser {
  userId: string;
  sources: AssembledUserSource[];
  files: S3PutFile[]; // 書き換え済み JSON 群 + manifest.json
}
export interface AssembleResult {
  deliveryPrefix: string;
  users: AssembledUser[];
  inventory: Inventory;
}

export interface AssembleOptions {
  sourcePrefix: string;
  deliveryPrefix: string;
  /** 自動生成する人数 (在庫が許す範囲に丸める)。手動指定時は無視。 */
  count?: number;
  idPrefix?: string; // 既定 'elith-test'
  /** 手動指定: userId → { formatId: sourceKey }。指定時はこちらを優先。 */
  manualMapping?: Record<string, Partial<Record<ElithFormatId, string>>>;
  exportedAt?: Date;
  /**
   * 納品フォルダ/ファイル名に使う統一日付 (YYYY_MM_DD)。
   * 仕様 §3.3「1回分の入力一式を 1 つの date フォルダに」に合わせ、
   * 1 人分の 5 種を単一の date/ にまとめる。未指定なら組み立て日 (本日)。
   */
  bundleDate?: string;
  /**
   * ウェルネス年齢スコア: source_ref(元S3キー) → 算出済みスコア。
   * 採用元(人間ドック優先→血液)に対応するスコアがあれば HealthAgeData を納品に追加する。
   * age は PII 除去済み元データから再計算できないため、算出済み(health_age_scores)を突合して載せる。
   */
  healthAgeByRef?: Record<string, HealthAgeRecord>;
  /**
   * 被験者情報リゾルバ (案B): clientId(=diagnostic_user_id) → {sex, dateOfBirth}。
   * 指定時、全納品ファイルの subject.sex/age を顧客DB由来で充填する (年齢=生年月日×各ファイルの test_date)。
   * DOB自体は出力しない (PII非送付)。未指定/該当顧客なしの場合は subject を変更しない。
   */
  resolveSubject?: SubjectResolver;
}

/** 本日 (UTC) を YYYY_MM_DD で返す。 */
function todayYmd(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '_');
}
function randomUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

/** 被験者情報 (顧客DB由来)。PII非送付=性別と生年月日のみ受領し、出力は年齢に変換 (DOBは載せない)。 */
export interface SubjectInfo {
  sex: 'male' | 'female' | null;
  dateOfBirth: string | null; // YYYY-MM-DD (customer.customer_profiles.date_of_birth)
}
/** clientId(=diagnostic_user_id) → 被験者情報 を解決する非同期リゾルバ (API層が customer schema を照会)。 */
export type SubjectResolver = (diagnosticUserId: string) => Promise<SubjectInfo | null>;

/** 生年月日(YYYY-MM-DD)と基準日(YYYY-MM-DD)から満年齢。算出不可は null。DOB自体は出力しない。 */
function ageAt(dobIso: string | null, refIso: string | null): number | null {
  if (!dobIso || !refIso) return null;
  const b = dobIso.split('-').map(Number);
  const r = refIso.split('-').map(Number);
  if (b.length !== 3 || r.length !== 3 || b.some((n) => Number.isNaN(n)) || r.some((n) => Number.isNaN(n))) return null;
  let age = r[0] - b[0];
  if (r[1] < b[1] || (r[1] === b[1] && r[2] < b[2])) age--;
  return age >= 0 && age < 150 ? age : null;
}

/**
 * 納品JSONの subject に性別・年齢を充填 (顧客DB由来・案B)。
 * 年齢 = 生年月日 × そのファイルの test_date で算出。顧客情報/検査日が無い項目は既存値を保持 (捏造しない)。
 */
function applySubject(obj: Record<string, unknown>, subj: SubjectInfo | null): void {
  if (!subj) return;
  const existing = obj.subject && typeof obj.subject === 'object' ? (obj.subject as Record<string, unknown>) : {};
  const existingAge = typeof existing.age === 'number' ? existing.age : null;
  const existingSex = existing.sex === 'male' || existing.sex === 'female' ? existing.sex : null;
  const testDate = typeof obj.test_date === 'string' ? obj.test_date : null;
  obj.subject = { sex: subj.sex ?? existingSex, age: ageAt(subj.dateOfBirth, testDate) ?? existingAge };
}

/** 検査を client_id 単位にグループ化 (各リストは検査日 desc)。複数日付 = 時系列。 */
function groupByClient(items: CatalogItem[]): Map<string, CatalogItem[]> {
  const m = new Map<string, CatalogItem[]>();
  for (const it of items) {
    const cid = it.clientId ?? '(unknown)';
    const arr = m.get(cid);
    if (arr) arr.push(it);
    else m.set(cid, [it]);
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => (a.date === b.date ? b.key.localeCompare(a.key) : b.date.localeCompare(a.date)));
  }
  return m;
}

/** ウェルネス年齢の納品ファイル (エンベロープは他の検査ファイルに準拠)。 */
export function buildHealthAgeJson(userId: string, bundleDate: string, rec: HealthAgeRecord, sourceRef: string, subj: SubjectInfo | null): string {
  const testDate = rec.test_date && /^\d{4}-\d{2}-\d{2}$/.test(rec.test_date) ? rec.test_date : bundleDate.replace(/_/g, '-');
  const computedDate = rec.computed_at ? rec.computed_at.slice(0, 10) : null;
  // subject: 案B=顧客DB由来で充填 (年齢=生年月日×test_date)。無ければ算出時の値にフォールバック。
  const subjectSex = subj?.sex ?? rec.sex ?? null;
  const subjectAge = ageAt(subj?.dateOfBirth ?? null, testDate) ?? rec.chronological_age;
  const obj = {
    format_id: 'HealthAgeData',
    schema_version: ELITH_HANDOFF_SCHEMA_VERSION,
    kind: 'health_age',
    client_id: userId,
    diagnostic_id: randomUuid(),
    test_date: testDate,
    exported_at: new Date().toISOString(),
    subject: { sex: subjectSex, age: subjectAge }, // 案B: 顧客DB由来(年齢=生年月日×test_date)。無ければ算出時の性別/実年齢
    source: {
      origin: 'scan-chat-ai',
      app: 'scan-chat-ai',
      model: rec.model_version ?? 'CABA-v4d',
      note: 'ウェルネス年齢 (旧称: 健康年齢 / CABA)。実年齢との差 delta を含む。JSON のキー名 health_age / format_id HealthAgeData は互換のため据え置き。',
      lab_name: null,
    },
    data: {
      health_age: rec.biological_age, // ウェルネス年齢
      actual_age: rec.chronological_age, // 実年齢
      computed_date: computedDate, // 算出計算日付
      delta: rec.delta,
      model_version: rec.model_version ?? 'CABA-v4d',
    },
    // Elith 要望(2026-07): 納品物に監査メタ(assembled_from)を載せない。トレースは sources[] に保持。
  };
  void sourceRef;
  return JSON.stringify(obj, null, 2);
}

// category(区分/region見出し) を納品しない format。検診/がん(版面見出し)・血液(項目区分)とも Elith 要望で除去。
// 遺伝子は items のキー構成を LLM 全面委任のため対象外 (意味のある category を消さない)。
const CATEGORY_STRIP_FORMATS = new Set(['HealthCheckupData', 'CancerRiskAssessmentData', 'BloodTestData']);

/**
 * 納品物のサニタイズ (Elith 要望)。元データが旧形式でも納品物からは版面情報を除く。
 *  - `data.regions`(bboxの器) を削除。
 *  - measurements/items の各要素から `region`/`bbox` を削除 (スキャン由来は `category` も)。
 *  - `raw_markdown` から `<!-- bbox: … -->` コメントを除去。
 * ※ 値(value/value_num)は書き換えない。旧元データの値の乱れは元ファイルの再生成で対応する。
 */
/**
 * 納品用サニタイズ + 妥当性ガード。除外した測定値(anomalies)を返す（納品物には含めない）。
 * 正規化本体は elith-export.sanitizeMeasurementsForDelivery に集約 (全書き出し経路共通)。
 */
function sanitizeDelivery(obj: Record<string, unknown>): MeasurementAnomaly[] {
  const fmt = typeof obj.format_id === 'string' ? obj.format_id : '';
  const anomalies: MeasurementAnomaly[] = [];
  const data = obj.data;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    delete d.regions;
    // measurement系: lean 化 → 未測定除外 → 総合判定欄除外 → 妥当性ガードで壊れた値を除外。
    if (Array.isArray(d.measurements)) {
      const { kept, anomalies: anos } = sanitizeMeasurementsForDelivery(d.measurements);
      anomalies.push(...anos);
      // ②正準化 (S1〜S3)。SCAN_CANONICALIZE=on のときだけ。off の間は挙動不変。
      const canonKept = canonicalizeEnabled() ? canonicalize(kept).delivery : kept;
      // 後段 dedup (課題C/B・SCAN_OBS_DEDUP=on のときだけ)。別名重複を統合・同名別値は競合として保持。
      d.measurements = obsDedupEnabled() ? dedupObservations(canonKept).delivery : canonKept;
    }
    // 遺伝子等 items: 版面情報のみ除去 (lean はしない=構造が別)。
    if (Array.isArray(d.items)) {
      for (const el of d.items) {
        if (el && typeof el === 'object') {
          const e = el as Record<string, unknown>;
          delete e.region;
          delete e.bbox;
          if (CATEGORY_STRIP_FORMATS.has(fmt)) delete e.category;
        }
      }
    }
  }
  // Elith 要望(2026-07): 納品物から raw_markdown と監査メタ(assembled_from) を除去。
  //   Elith は未使用。監査/トレース情報は我々側(元ソースS3 + assemble の sources[] マニフェスト)に残す。
  delete obj.raw_markdown;
  delete obj.assembled_from;
  return anomalies;
}

/** JSON テキストの client_id を new へ書き換え + 納品用サニタイズ (パース失敗時は素の置換にフォールバック)。 */
function rewriteClientId(jsonText: string, newId: string, sourceKey: string, subj: SubjectInfo | null): { text: string; anomalies: MeasurementAnomaly[] } {
  try {
    const obj = JSON.parse(jsonText) as Record<string, unknown>;
    obj.client_id = newId;
    applySubject(obj, subj); // 案B: subject.sex/age を顧客DB由来で充填 (年齢=生年月日×test_date)
    // Elith 要望(2026-07): 納品物に監査メタ(assembled_from)を載せない。
    // トレース(元 sourceKey → 納品 newKey)は assemble の戻り値 sources[] に保持する。
    void sourceKey;
    const anomalies = sanitizeDelivery(obj); // lean化/監査メタ除去 + 妥当性ガード
    return { text: JSON.stringify(obj, null, 2), anomalies };
  } catch {
    return { text: jsonText, anomalies: [] };
  }
}

/**
 * 納品セットを組み立てる (S3 から JSON を GET し、書き換え済みファイル群を返す)。
 * S3 への PUT は呼び出し側 (s3.putFiles)。
 */
export async function assembleElithDeliverySet(opts: AssembleOptions): Promise<AssembleResult> {
  const deliveryPrefix = normPrefix(opts.deliveryPrefix);
  const idPrefix = opts.idPrefix || 'elith-test';
  // 1 人分の 5 種を単一 date フォルダにまとめる (仕様 §3.3)。既定は本日。
  const bundleDate =
    opts.bundleDate && /^\d{4}_\d{2}_\d{2}$/.test(opts.bundleDate) ? opts.bundleDate : todayYmd();
  const inv = await inventoryElithSource(opts.sourcePrefix);

  // ソース JSON を GET してキャッシュ (空データ判定と本コピーで再利用し二重取得を避ける)
  const textCache = new Map<string, string>();
  const fetchText = async (key: string): Promise<string> => {
    const c = textCache.get(key);
    if (c !== undefined) return c;
    const t = await getObjectText(key);
    textCache.set(key, t);
    return t;
  };

  // 血液を client_id 単位にグループ化 (複数日付 = 時系列)。時系列は丸ごと納品する。
  const bloodByClient = groupByClient(inv.byFormat.BloodTestData);
  // §3.3 時系列納品: 血液に加え がん/検診/AI疾病予測(Other) も client 単位で全 date を束ねて丸ごと納品する。
  const SERIES_FORMATS: ElithFormatId[] = ['BloodTestData', 'CancerRiskAssessmentData', 'HealthCheckupData', 'Other'];
  const seriesByFormat = new Map<ElithFormatId, Map<string, CatalogItem[]>>();
  for (const f of SERIES_FORMATS) seriesByFormat.set(f, groupByClient(inv.byFormat[f] ?? []));

  // userId → (formatId → source CatalogItem) と 血液時系列(bloodSeries) の割当を決める
  const plan: { userId: string; picks: Partial<Record<ElithFormatId, CatalogItem>>; bloodSeries: CatalogItem[] }[] = [];

  if (opts.manualMapping && Object.keys(opts.manualMapping).length > 0) {
    for (const [userId, m] of Object.entries(opts.manualMapping)) {
      const picks: Partial<Record<ElithFormatId, CatalogItem>> = {};
      for (const f of DELIVERY_FORMAT_IDS) {
        const key = m[f];
        if (!key) continue;
        const item = inv.byFormat[f].find((c) => c.key === key) ?? parseElithKey(key);
        if (item) picks[f] = item; // 手動指定は明示尊重 (空でもそのまま)
      }
      // 血液は指定キーの client の時系列を丸ごと納品する。
      const bi = picks.BloodTestData;
      const bloodSeries = bi ? (bi.clientId ? bloodByClient.get(bi.clientId) ?? [bi] : [bi]) : [];
      if (bloodSeries.length) picks.BloodTestData = bloodSeries[0];
      plan.push({ userId, picks, bloodSeries });
    }
  } else {
    // 自動: 種別ごとに新しい日付順で「実データが入っている」ものを優先して選ぶ。
    // (旧仕様は最古を無条件採用 → 初期の空テストを掴んで空データ納品になっていた)
    const want = Math.max(0, Math.min(opts.count ?? inv.maxCompleteUsers, inv.maxCompleteUsers));
    // 単発 format (遺伝子/問診): 日付 desc のカーソルで「実データ入り」を優先採用。
    const cursor: Record<string, number> = {};
    const orderedDesc: Record<string, CatalogItem[]> = {};
    for (const f of DELIVERY_FORMAT_IDS) {
      if (seriesByFormat.has(f)) continue; // 時系列 format は client 単位で別途割当
      cursor[f] = 0;
      orderedDesc[f] = [...(inv.byFormat[f] ?? [])].sort((a, b) =>
        a.date === b.date ? b.key.localeCompare(a.key) : b.date.localeCompare(a.date),
      );
    }
    // 時系列 format (血液/がん/検診/AI疾病予測): client 単位グループを
    // 「時系列(≥2日付)優先 → 代表(最新)が非空 → 最新日付 desc」で並べる。
    const groupsByFormat = new Map<ElithFormatId, { clientId: string; list: CatalogItem[] }[]>();
    for (const f of SERIES_FORMATS) {
      const groups: { clientId: string; list: CatalogItem[]; nonEmpty: boolean }[] = [];
      for (const [clientId, list] of (seriesByFormat.get(f) ?? new Map<string, CatalogItem[]>()).entries()) {
        const nonEmpty = countDataItems(await fetchText(list[0].key)) > 0;
        groups.push({ clientId, list, nonEmpty });
      }
      groups.sort((a, b) => {
        const ats = a.list.length >= 2 ? 1 : 0, bts = b.list.length >= 2 ? 1 : 0;
        if (ats !== bts) return bts - ats;
        if (a.nonEmpty !== b.nonEmpty) return (b.nonEmpty ? 1 : 0) - (a.nonEmpty ? 1 : 0);
        return (b.list[0]?.date ?? '').localeCompare(a.list[0]?.date ?? '');
      });
      groupsByFormat.set(f, groups.map((g) => ({ clientId: g.clientId, list: g.list })));
    }

    for (let i = 0; i < want; i++) {
      const picks: Partial<Record<ElithFormatId, CatalogItem>> = {};
      // 単発 format
      for (const f of DELIVERY_FORMAT_IDS) {
        if (seriesByFormat.has(f)) continue;
        const list = orderedDesc[f];
        let chosen: CatalogItem | undefined;
        while (cursor[f] < list.length) {
          const cand = list[cursor[f]++];
          if (countDataItems(await fetchText(cand.key)) > 0) { chosen = cand; break; }
        }
        picks[f] = chosen ?? list[i] ?? list[0];
      }
      // 時系列 format: client 単位で割当 (人数分に足りなければ巡回)。picks[f]=代表(最新)、
      // 実際の納品は delivery で seriesByFormat から全 date を丸ごと出す。
      for (const f of SERIES_FORMATS) {
        const groups = groupsByFormat.get(f) ?? [];
        const g = groups.length ? groups[i % groups.length] : undefined;
        if (g) picks[f] = g.list[0];
      }
      plan.push({ userId: `${idPrefix}-${String(i + 1).padStart(3, '0')}`, picks, bloodSeries: [] });
    }
  }

  const users: AssembledUser[] = [];
  for (const p of plan) {
    const sources: AssembledUserSource[] = [];
    const files: S3PutFile[] = [];
    // 案B: この被験者の性別・生年月日を顧客DB(customer_profiles)から解決 (代表=picks の元 clientId=diagnostic_user_id)。
    // best-effort: 該当顧客が無ければ null (テストIDや未登録は subject 変更なし)。年齢は各ファイルの test_date で算出。
    const srcClientId = Object.values(p.picks)
      .map((it) => it?.clientId)
      .find((c): c is string => typeof c === 'string' && c.length > 0) ?? null;
    let subj: SubjectInfo | null = null;
    if (srcClientId && opts.resolveSubject) {
      try { subj = await opts.resolveSubject(srcClientId); } catch { subj = null; }
    }
    for (const f of DELIVERY_FORMAT_IDS) {
      const item = p.picks[f];
      if (!item) continue;
      const seriesMap = seriesByFormat.get(f);
      if (seriesMap) {
        // 時系列 format (血液/がん/検診/AI疾病予測): この client の当該 format 全 date を
        // 各 date フォルダへ丸ごと納品 (時系列保持・ファイル名衝突回避)。
        const series = seriesMap.get(item.clientId ?? '(unknown)') ?? [item];
        for (const s of series) {
          const text = await fetchText(s.key);
          const dataItems = countDataItems(text);
          const { text: rewritten, anomalies } = rewriteClientId(text, p.userId, s.key, subj);
          const bd = /^\d{4}_\d{2}_\d{2}$/.test(s.date) ? s.date : bundleDate;
          const newKey = `${deliveryPrefix}user/${p.userId}/date/${bd}/${f}_date_${bd}_user_${p.userId}.json`;
          files.push({ key: newKey, contentType: 'application/json; charset=utf-8', body: rewritten, bytes: utf8Bytes(rewritten) });
          sources.push({ formatId: f, sourceKey: s.key, sourceDate: s.date, deliveredDate: bd, newKey, dataItems, ...(anomalies.length ? { anomalies } : {}) });
        }
      } else {
        // 単発 format (遺伝子/問診): 最新1件を統一日付へ。JSON 内の test_date は原本のまま。
        const text = await fetchText(item.key);
        const dataItems = countDataItems(text);
        const { text: rewritten, anomalies } = rewriteClientId(text, p.userId, item.key, subj);
        const newKey = `${deliveryPrefix}user/${p.userId}/date/${bundleDate}/${f}_date_${bundleDate}_user_${p.userId}.json`;
        files.push({ key: newKey, contentType: 'application/json; charset=utf-8', body: rewritten, bytes: utf8Bytes(rewritten) });
        sources.push({ formatId: f, sourceKey: item.key, sourceDate: item.date, deliveredDate: bundleDate, newKey, dataItems, ...(anomalies.length ? { anomalies } : {}) });
      }
    }

    // ウェルネス年齢: Elith 要望で正式に納品。**検査日毎に**算出済みスコア(source_ref 突合)を載せる
    // (ウェルネス年齢は血液検査毎に最新を算出する運用に一致)。同一 date は 人間ドック(検診)優先→血液。
    // 算出済みスコアが無い回は載せない(age は PII で再計算不可・捏造しない)。
    if (opts.healthAgeByRef) {
      const byDate = new Map<string, string>(); // deliveredDate(YYYY_MM_DD) → 採用元 source_ref
      const collect = (f: ElithFormatId, overwrite: boolean) => {
        const item = p.picks[f];
        if (!item) return;
        const sm = seriesByFormat.get(f);
        const series = sm ? (sm.get(item.clientId ?? '(unknown)') ?? [item]) : [item];
        for (const s of series) {
          const haRec = opts.healthAgeByRef![s.key];
          // その回のスコアが無い、または算出不能(biological_age=null=必須マーカー不足)は載せない。
          // 後者は health_age:null の HealthAgeData を Elith へ渡さないため(捏造ゼロ・"載せない"原則)。
          if (!haRec || haRec.biological_age == null) continue;
          const bd = /^\d{4}_\d{2}_\d{2}$/.test(s.date) ? s.date : bundleDate;
          if (overwrite || !byDate.has(bd)) byDate.set(bd, s.key);
        }
      };
      collect('HealthCheckupData', true); // 人間ドック(検診)優先 (同 date は上書き採用)
      collect('BloodTestData', false);    // 血液は健診の無い date のみ
      for (const [date, sourceKey] of byDate) {
        const rec = opts.healthAgeByRef[sourceKey];
        const stem = `HealthAgeData_date_${date}_user_${p.userId}`;
        const key = `${deliveryPrefix}user/${p.userId}/date/${date}/${stem}.json`;
        const bodyStr = buildHealthAgeJson(p.userId, date, rec, sourceKey, subj);
        files.push({ key, contentType: 'application/json; charset=utf-8', body: bodyStr, bytes: utf8Bytes(bodyStr) });
        sources.push({
          formatId: 'HealthAgeData', sourceKey, sourceDate: rec.test_date ?? date,
          deliveredDate: date, newKey: key, dataItems: rec.biological_age != null ? 1 : 0,
        });
      }
    }
    // 納品フォルダには Elith 規約のファイル ({format_id}_..._user_....json) のみを置く。
    // 出典元トレーサビリティ (source_key) は API 応答の users[].sources で返すため、
    // 規約外の manifest.json は S3 へ書き出さない (Elith「構成が違う」対策)。
    users.push({ userId: p.userId, sources, files });
  }

  return { deliveryPrefix, users, inventory: inv };
}
