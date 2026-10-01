/**
 * **スペシャルアカウント 1 人ぶんの Elith 本番納品**（人がボタンを押したときだけ走る）。
 *
 * 正本: `docs/specs/special_account_management_spec_20261001.md`
 *       §9（オーケストレーション）/ §7.3・§7.3.1（確認モーダル）/ §10.2（最低条件）/
 *       §14.3（run snapshot）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【なぜ cron と別の口か】起動条件がまったく違う
 * ══════════════════════════════════════════════════════════════════════
 *   cron (`deliverReadySpecialAccounts`) … 母集団 = 契約者・単品。
 *     揃い判定は plan ごとの `required_formats` の総当たり（fail-closed）。
 *   ここ                                   … 対象 = **スペシャル 1 人**。
 *     条件は §10.2 の 2 つだけ（uid 確定 ∧ 渡せるデータが 1 種類以上）。
 *
 * **`decideReady()` は通さない。** あの fail-closed は契約者の誤納品を防ぐ正しい規律だが、
 * スペシャル案件は案件ごとに必要条件が違うので、ここに当てると**永久に納品できない**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【2 段構え】`plan` を見せてから書く（§7.3.1）
 * ══════════════════════════════════════════════════════════════════════
 *   `buildDeliveryPlan(uid)`   … **Elith 本番受取領域（`deliveryPrefix`）へは書かない。**
 *                                 書く予定のファイル一覧を返す
 *   `executeDeliveryPlan(...)` … その plan を **そのまま** `putVerified` へ渡す
 *
 * **確定後に assemble を作り直さない。** 作り直すと「確認した内容」と「書いた内容」が
 * ずれ、確認モーダルが確認になっていない。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【7 種すべてを載せる】P-1
 * ══════════════════════════════════════════════════════════════════════
 * cron 経路の `manualMapping` は `HealthCheckupData` と `LifestyleQuestionnaireData` の
 * 2 つしか入れていなかったので、**血液・がん・遺伝子・AI疾病予測は納品されなかった**。
 * ここでは inventory で実在が確認できた **各 format の代表キー**を入れる。
 * **存在しない format は載せない**（空のファイルを作らない）。
 *
 * **複数年を縮退させない。** `SERIES_FORMATS`（血液 / がん / 検診 / Other）は
 * 代表キーを 1 つ渡せば assemble が **その client の全 date フォルダ**へ展開する。
 * 年ごとに `manualMapping` を作り直す必要はないし、**最新 1 件へ縮退させてはいけない**。
 */

import {
  assembleElithDeliverySet,
  inventoryElithSource,
  DELIVERY_FORMAT_IDS,
  type HealthAgeRecord,
} from './elith-assemble';
import type { ElithFormatId } from './elith-export';
import {
  makeSubjectResolver,
  materializeHealthCheckups,
  computeWellnessFromMeasurements,
  recordDelivery,
} from './elith-delivery';
import { isSpecialAccount } from './special-accounts';
import { refreshConfig } from './app-config';
import { putVerified, type VerifiedPutResult } from './s3-verified-put';
import { recordDeliveryRun } from './elith-delivery-runs';
import { sha256Hex } from './originals-storage';
import type { S3PutFile } from './s3';

/** 書く予定の 1 ファイル。**確認モーダルの件数はこれを数えた数**（§7.3.1）。 */
export interface PlannedFile {
  formatId: ElithFormatId | 'HealthAgeData';
  /** 納品先の date フォルダ（YYYY_MM_DD）。 */
  deliveredDate: string;
  destinationKey: string;
  /**
   * **中身の指紋**（生成メタ `exported_at` / `diagnostic_id` を除いた本文の sha256）。
   * **preview→confirm の照合と run の差分はこちらを使う**（P0-2）。
   * 納品 JSON は呼ばれるたび作り直され、この 2 つだけ毎回変わるので、
   * 実 body の sha では「中身が同じでも毎回 updated」になる。
   * 指紋であって中身ではないので PII を持たない（§14.3.1.1）。
   */
  contentSha256: string;
  /**
   * **実際に S3 へ書く body そのものの sha256**。
   * `putVerified` の読戻し検証はこちらを使う（監査用に snapshot にも残す）。
   */
  deliverySha256: string;
}

export interface DeliveryPlan {
  uid: string;
  ok: boolean;
  /** 作れなかった理由。**黙って空を返さない。** */
  reason?: string;
  files: PlannedFile[];
  /** format_id ごとのファイル数（モーダルの表示用）。 */
  countByFormat: Record<string, number>;
  /** ウェルネス年齢を載せられた年数と、載せられなかった理由。 */
  wellnessYears: number;
  wellnessReason?: string;
  /** assemble の結果そのもの。`executeDeliveryPlan` が**作り直さず**使う。 */
  internal?: {
    files: S3PutFile[];
    byDate: { uid: string; date: string; formatIds: string[]; fileCount: number; hasHealthAge: boolean }[];
  };
}

const EMPTY_COUNTS = (): Record<string, number> => ({});

/**
 * **書く予定のファイル一覧を作る。Elith 本番受取領域（`deliveryPrefix`）へは書かない。**
 *
 * ══════════════════════════════════════════════════════════════════════
 * **「何も書かない」ではない**（P0-1）
 * ══════════════════════════════════════════════════════════════════════
 * 確認用データを組み立てるために既存パイプラインを通すので、副作用として
 *
 *   - **中間 source** … `materializeHealthCheckups()` → `elith-delivery.ts:231` の
 *     `putFiles()` が `{sourcePrefix}user/…` へ HealthCheckupData を書く
 *   - **ウェルネス年齢** … `computeWellnessFromMeasurements()` → `elith-delivery.ts:288` の
 *     `health_age_scores` upsert
 *
 * が**更新される場合がある**。中間 source は §16.3 で恒久的に残すと決めた監査層で、
 * ウェルネス年齢は同じ入力から同じ値が出る算出結果なので、どちらも
 * **納品ではない**。**書かないのは本番受取領域だけ**という約束で、
 * 大規模な in-memory 化はしない（§7.3.1）。
 */
export async function buildDeliveryPlan(opts: {
  uid: string;
  sourcePrefix: string;
  deliveryPrefix: string;
}): Promise<DeliveryPlan> {
  await refreshConfig(true);
  const uid = String(opts.uid ?? '').trim().toLowerCase();

  // §10.2 最低条件 ①: uid が確定していること。
  if (!uid) return { uid: '', ok: false, reason: 'uid が指定されていません', files: [], countByFormat: EMPTY_COUNTS(), wellnessYears: 0 };
  // §19.1: 渡された uid を信用しない。**この枠の対象だけ**を扱う。
  if (!isSpecialAccount(uid)) {
    return { uid, ok: false, reason: 'スペシャルアカウントとして登録されていません', files: [], countByFormat: EMPTY_COUNTS(), wellnessYears: 0 };
  }

  const resolveSubject = makeSubjectResolver();
  const healthAgeByRef: Record<string, HealthAgeRecord> = {};
  let wellnessYears = 0;
  let wellnessReason: string | undefined;

  // ① 検診・人間ドックを **年ごと**に中間 source へ materialize し、年ごとにウェルネス年齢を算出。
  //    **無くてもよい**（§10.2 — HealthCheckupData は固定必須条件ではない）。
  let repHcKey: string | null = null;
  const mats = await materializeHealthCheckups(uid, opts.sourcePrefix);
  if (mats.length > 0) {
    repHcKey = mats[0].hcKey; // test_date desc = 先頭が最新（代表 1 件で全 date が展開される）
    for (const m of mats) {
      const { rec, reason } = await computeWellnessFromMeasurements(
        uid, m.measurements, m.testDate, m.hcKey, m.fallbackAge, m.fallbackSex, resolveSubject,
      );
      if (rec) { healthAgeByRef[m.hcKey] = rec; wellnessYears++; }
      else wellnessReason = reason ?? '算出不能';
    }
  }

  // ② inventory から **7 種ぶん**の代表キーを拾う（P-1）。存在しない format は載せない。
  const inv = await inventoryElithSource(opts.sourcePrefix);
  const latest = (fmt: ElithFormatId): string | null => {
    const items = (inv.byFormat[fmt] ?? []).filter((c) => c.clientId === uid);
    if (items.length === 0) return null;
    items.sort((a, b) => (a.date === b.date ? b.key.localeCompare(a.key) : b.date.localeCompare(a.date)));
    return items[0].key;
  };

  const mapping: Partial<Record<ElithFormatId, string>> = {};
  for (const f of DELIVERY_FORMAT_IDS) {
    // 検診は materialize した代表キーを優先する（今回作った最新の内容を使う）。
    const key = f === 'HealthCheckupData' ? (repHcKey ?? latest(f)) : latest(f);
    if (key) mapping[f] = key;
  }

  // §10.2 最低条件 ②: Elith へ渡せるデータが 1 種類以上。
  if (Object.keys(mapping).length === 0) {
    return { uid, ok: false, reason: 'Elith へ渡せるデータが 1 件もありません', files: [], countByFormat: EMPTY_COUNTS(), wellnessYears: 0 };
  }

  const assembled = await assembleElithDeliverySet({
    sourcePrefix: opts.sourcePrefix,
    deliveryPrefix: opts.deliveryPrefix,
    healthAgeByRef,
    resolveSubject,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    manualMapping: { [uid]: mapping } as any,
  });

  const files: S3PutFile[] = assembled.users.flatMap((u) => u.files);
  const planned: PlannedFile[] = files.map((f) => {
    const meta = assembled.users
      .flatMap((u) => u.sources)
      .find((s) => s.newKey === f.key);
    return {
      formatId: (meta?.formatId ?? guessFormatFromKey(f.key)) as ElithFormatId | 'HealthAgeData',
      deliveredDate: meta?.deliveredDate ?? dateFromKey(f.key),
      destinationKey: f.key,
      // **2 本に分ける**（P0-2）。content = 生成メタを除いた指紋 / delivery = 実 body。
      contentSha256: sha256Hex(new TextEncoder().encode(stableBody(f.body))),
      deliverySha256: sha256Hex(typeof f.body === 'string' ? new TextEncoder().encode(f.body) : f.body),
    };
  });

  const countByFormat: Record<string, number> = {};
  for (const p of planned) countByFormat[p.formatId] = (countByFormat[p.formatId] ?? 0) + 1;

  // 納品記録の単位（年 = date フォルダ）をここで決めておき、実行側は作り直さない。
  const byDate: DeliveryPlan['internal'] extends infer T ? T extends { byDate: infer B } ? B : never : never =
    [] as unknown as { uid: string; date: string; formatIds: string[]; fileCount: number; hasHealthAge: boolean }[];
  const grouped = new Map<string, PlannedFile[]>();
  for (const p of planned) {
    const arr = grouped.get(p.deliveredDate);
    if (arr) arr.push(p);
    else grouped.set(p.deliveredDate, [p]);
  }
  for (const [date, list] of grouped) {
    const formatIds = Array.from(new Set(list.map((l) => String(l.formatId))));
    byDate.push({ uid, date, formatIds, fileCount: list.length, hasHealthAge: formatIds.includes('HealthAgeData') });
  }

  return {
    uid,
    ok: planned.length > 0,
    ...(planned.length === 0 ? { reason: '納品できるファイルが組み立てられませんでした' } : {}),
    files: planned,
    countByFormat,
    wellnessYears,
    ...(wellnessYears === 0 && wellnessReason ? { wellnessReason } : {}),
    internal: { files, byDate },
  };
}

/**
 * **生成のたびに変わるメタデータ**。指紋から外す対象。
 *
 * 納品 JSON は呼ばれるたびに作り直されるので、`exported_at`（生成時刻）と
 * `diagnostic_id`（納品 1 件ごとの採番）は**毎回違う**。
 * これを含めたまま指紋を取ると、**何も変わっていないのに毎回不一致**になり、
 * 確認モーダルが構造的に通らなくなる（実測で踏んだ）。
 *
 * **データは 1 つも外さない。** 外すのはこの 2 つだけで、測定値・判定・被験者情報・
 * 検査日・format_id・client_id はすべて指紋に入る。
 */
const VOLATILE_META = ['exported_at', 'diagnostic_id'] as const;

/** 指紋用に、生成のたびに変わるメタデータだけを落とした本文を作る。 */
export function stableBody(body: string | Uint8Array): string {
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    for (const k of VOLATILE_META) delete o[k];
    return JSON.stringify(o);
  } catch {
    // JSON で無い（起こらないはずだが）ときは、そのまま使う。**黙って空にしない。**
    return text;
  }
}

/**
 * **plan の指紋。** 「確認した内容」と「書く内容」が同じであることを 1 本の文字列で表す。
 *
 * 納品先キーと**中身（生成メタを除く）の sha256** を並べて取る。
 * キーだけだと、同じキーで中身が差し替わった回を取り逃す。
 * 順序に依存しないよう**ソートしてから**取る。
 * sha256 は指紋であって中身ではないので、これ自体は PII を持たない。
 */
export function planFingerprint(plan: DeliveryPlan): string {
  // `PlannedFile.contentSha256` が既に `stableBody()` 由来なので、ここで取り直さない
  // （2 か所で別々に計算すると、片方だけ直したときに静かに食い違う）。
  const lines = plan.files
    .map((f) => `${f.destinationKey}\t${f.contentSha256}`)
    .sort()
    .join('\n');
  return sha256Hex(new TextEncoder().encode(`${plan.uid}\n${lines}`));
}

/** `HealthAgeData_date_2025_02_17_user_xxx.json` のような納品キーから format を読む（保険）。 */
function guessFormatFromKey(key: string): string {
  const base = key.split('/').pop() ?? '';
  return base.split('_date_')[0] || 'Unknown';
}
function dateFromKey(key: string): string {
  const m = key.match(/\/date\/(\d{4}_\d{2}_\d{2})\//);
  return m ? m[1] : '';
}

export interface DeliveryExecution {
  uid: string;
  ok: boolean;
  /** `putVerified` の結果そのもの。**落ちたファイルも載せる**（黙って落とさない）。 */
  results: VerifiedPutResult[];
  fileCount: number;
  verifiedCount: number;
  /** `elith_deliveries` へ記録した年（date フォルダ）。 */
  recordedDates: string[];
  /** 記録しなかった年と理由（verified でない年は納品済みと呼ばない）。 */
  skippedDates: { date: string; reason: string }[];
  /** run の控え（次回の差分用）を残せたか。**残せなくても納品は成立している。** */
  runRecorded?: boolean;
  runReason?: string;
}

/**
 * 確認した `plan` を**そのまま**書く。
 *
 * - 書き込みは **`putVerified` 1 本**（§9.6）。PutObject の成否では「納品完了」と言わない。
 * - **一部のファイルだけ verified:false の年は `elith_deliveries` へ記録しない**（§9.6.2 b）。
 *   「書けたが読み戻せていない」を納品済みと呼ばない。
 */
export async function executeDeliveryPlan(plan: DeliveryPlan, opts: {
  deliveryPrefix: string;
  /** 実行した admin の**識別子 digest**。`@` を含む値は控えへ入らない（§14.3.1）。 */
  triggeredBy?: unknown;
}): Promise<DeliveryExecution> {
  if (!plan.ok || !plan.internal) {
    return { uid: plan.uid, ok: false, results: [], fileCount: 0, verifiedCount: 0, recordedDates: [], skippedDates: [], runRecorded: false };
  }

  const results = await putVerified(plan.internal.files);
  const verifiedKeys = new Set(results.filter((r) => r.verified).map((r) => r.key));

  const recordedDates: string[] = [];
  const skippedDates: { date: string; reason: string }[] = [];
  for (const d of plan.internal.byDate) {
    const keys = plan.files.filter((f) => f.deliveredDate === d.date).map((f) => f.destinationKey);
    const bad = keys.filter((k) => !verifiedKeys.has(k));
    if (bad.length > 0) {
      skippedDates.push({ date: d.date, reason: `${bad.length} 件が読み戻し検証を通らなかったため、この回を納品済みとして記録しません` });
      continue;
    }
    await recordDelivery({
      uid: d.uid,
      bundleDate: d.date,
      deliveryPrefix: opts.deliveryPrefix,
      formatIds: d.formatIds,
      fileCount: d.fileCount,
      wellnessAgeMethod: d.hasHealthAge ? 'CABA' : null,
    });
    recordedDates.push(d.date);
  }

  const verifiedCount = results.filter((r) => r.verified).length;

  /*
   * **次回の差分のために控えを残す**（D-7・§14.3）。
   * 1 件も verified できなかった run は行を作らない（空振りで「前回納品」を作らない）。
   * **投げない** — 控えが残らなくても納品そのものは成立している。
   */
  const run = await recordDeliveryRun({
    uid: plan.uid,
    deliveryPrefix: opts.deliveryPrefix,
    files: plan.files,
    verifiedKeys,
    fileCount: results.length,
    triggeredBy: opts.triggeredBy,
  });

  return {
    uid: plan.uid,
    runRecorded: run.ok,
    ...(run.ok ? {} : { runReason: run.reason }),
    ok: verifiedCount === results.length && results.length > 0,
    results,
    fileCount: results.length,
    verifiedCount,
    recordedDates,
    skippedDates,
  };
}
