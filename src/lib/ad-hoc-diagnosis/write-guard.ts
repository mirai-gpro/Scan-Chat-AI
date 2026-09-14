/**
 * 臨時診断バッチ **専用**の Elith S3 実書き込みゲート (Phase A・2026-09-11)。
 *
 * 【なぜ要るか】`assembleBatch(dryRun:false)` は、これまで UI のチェックボックスひとつで
 * `putFiles()` → Production の Elith 納品領域へ **PutObject** まで通っていた。
 * 画面の操作ミス・API の直叩き・取り違えた env のどれでも実データが書ける状態だった。
 * **UI だけに安全性を依存させない**ため、サーバ側に必ず通る関門を置く。
 *
 * 【この module の守備範囲】
 *   - **臨時診断バッチの実 export だけ**。共通 `src/lib/s3.ts` の `putFiles()` の挙動は
 *     1 バイトも変えない (他機能の書き込み経路は従来どおり)。
 *   - 読み取り専用で `getS3Config()` / `makeS3Client()` を借りるだけ。
 *
 * 【Phase A の方針】
 *   - **既定は必ず無効**。env が 2 本とも正しく揃ったときだけ実書き込みを許す。
 *   - **上書きは一切許さない** (overwrite の escape hatch を実装しない)。
 *   - **部分納品しない** (1 人でも ready でなければ全体を止める)。
 */

import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getS3Config, makeS3Client, type S3Config } from '../s3';
import type { DeliveryFile } from './pipeline';

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

/**
 * **既定値を持たせない。** 未設定は「無効」であって「既定で有効」ではない。
 * `s3.ts` と同じ理由で `import.meta.env` → `process.env` の両読み
 * (Vite が未定義の `import.meta.env.X` を畳み込んで `undefined` を焼き付けるため)。
 */
function env(name: string): string {
  const fromMeta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (fromMeta != null && fromMeta !== '') return fromMeta;
  const fromProc = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return fromProc != null && fromProc !== '' ? fromProc : '';
}

/** 実書き込みの主スイッチ。**`on` ちょうどだけ**が有効。 */
export const WRITE_ENABLED_ENV = 'AD_HOC_ELITH_WRITE_ENABLED';
/** 書き込み先の明示宣言 `s3://<bucket>/<prefix>`。 */
export const WRITE_TARGET_ENV = 'AD_HOC_ELITH_WRITE_TARGET';

// ---------------------------------------------------------------------------
// 書き込み先の突き合わせ
// ---------------------------------------------------------------------------

/**
 * **正規化ルール (これ以外のことはしない)。**
 *
 *   1. 前後の空白を落とす
 *   2. prefix 部分の先頭の `/` を落とす
 *   3. prefix 部分が空でなければ末尾の `/` を **ちょうど 1 個**にそろえる
 *
 * 大文字小文字は**変えない** (S3 のバケット名・キーは大小を区別する)。
 * 部分一致・前方一致は**しない**。正規化した文字列どうしを `===` で比べる。
 * 「宣言と実際が惜しい」ときに通してしまうと、取り違えた領域へ書くのを許すことになる。
 */
export function normalizeS3Uri(raw: string): string {
  const s = raw.trim();
  if (!s.startsWith('s3://')) return s; // 形が違うものは正規化せずそのまま返す (後段で不一致になる)
  const rest = s.slice('s3://'.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return `s3://${rest}/`; // bucket だけ = prefix 空
  const bucket = rest.slice(0, slash);
  const prefix = rest.slice(slash + 1).replace(/^\/+/, '').replace(/\/+$/, '');
  return prefix ? `s3://${bucket}/${prefix}/` : `s3://${bucket}/`;
}

/** `getS3Config()` が解決した実際の書き込み先を、同じ規則で正規化して返す。 */
export function actualTargetUri(cfg: S3Config): string {
  return normalizeS3Uri(`s3://${cfg.bucket}/${cfg.prefix}`);
}

// ---------------------------------------------------------------------------
// key の allowlist
// ---------------------------------------------------------------------------

/**
 * **この機能が実際に生成しうる format_id だけ。**
 * 出どころは `service.ts` の `toDeliveryFile(cfg.prefix, …)` 4 か所
 * (HealthCheckupData / LifestyleQuestionnaireData / GeneticTestResultData / HealthAgeData)。
 * **想定外の format は実書き込みを止める** — ここを緩めるのは Phase B の判断。
 */
export const AD_HOC_DELIVERY_FORMAT_IDS = [
  'HealthCheckupData',
  'LifestyleQuestionnaireData',
  'GeneticTestResultData',
  'HealthAgeData',
] as const;

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const DATE_FOLDER = '\\d{4}_\\d{2}_\\d{2}';

/**
 * Elith 納品の論理形だけを通す:
 *
 *   {prefix}user/{client_id}/date/{YYYY_MM_DD}/{format_id}_date_{YYYY_MM_DD}_user_{client_id}.json
 *
 * **`input/` や `result/` のような新しい階層は Phase A では作らない**ので、
 * この形から 1 文字でも外れたら実書き込みを止める。
 *
 * key は `toDeliveryFile()` がサーバ側で組むものだが、**申告されたものとして扱わない** —
 * 受け取った key を実際に解析し、`formatId` / `testDate` と食い違えば弾く。
 */
export function validateDeliveryKey(
  file: Pick<DeliveryFile, 'key' | 'formatId' | 'testDate'>,
  cfg: S3Config,
): { ok: true } | { ok: false; reason: string } {
  const key = file.key;
  if (!key) return { ok: false, reason: 'key が空' };
  // 明示的に弾く (下の正規表現でも通らないが、理由を具体的に返すため先に見る)。
  if (key.includes('..')) return { ok: false, reason: '`..` を含む' };
  if (key.includes('//')) return { ok: false, reason: '`//` を含む' };
  if (key.startsWith('/')) return { ok: false, reason: '先頭が `/`' };
  if (!key.endsWith('.json')) return { ok: false, reason: '.json 以外' };

  const prefix = normalizeS3Uri(`s3://_/${cfg.prefix}`).slice('s3://_/'.length);
  if (prefix && !key.startsWith(prefix)) {
    return { ok: false, reason: `prefix (${prefix}) の外` };
  }

  const fmts = AD_HOC_DELIVERY_FORMAT_IDS.join('|');
  const re = new RegExp(
    `^${escapeRe(prefix)}user/(${UUID})/date/(${DATE_FOLDER})/(${fmts})_date_(${DATE_FOLDER})_user_(${UUID})\\.json$`,
  );
  const m = re.exec(key);
  if (!m) return { ok: false, reason: 'Elith のパス規則に一致しない' };

  const [, cid, dFolder, fmt, dFile, cid2] = m;
  if (cid !== cid2) return { ok: false, reason: 'client_id がフォルダとファイル名で食い違う' };
  if (dFolder !== dFile) return { ok: false, reason: '日付がフォルダとファイル名で食い違う' };
  if (fmt !== file.formatId) return { ok: false, reason: 'key の format_id が申告と食い違う' };
  if (dFolder !== file.testDate.replace(/-/g, '_')) {
    return { ok: false, reason: 'key の日付が test_date と食い違う' };
  }
  return { ok: true };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// ゲート本体
// ---------------------------------------------------------------------------

export interface WriteGateInput {
  delivery: Pick<DeliveryFile, 'key' | 'formatId' | 'testDate'>[];
  skipped: { subjectNo: number; reason: string }[];
}

export type WriteGateResult =
  | { ok: true; cfg: S3Config; target: string }
  | { ok: false; status: number; error: string; detail: string };

/**
 * **実書き込みの可否だけを決める。ここでは 1 バイトも書かない。**
 *
 * 順序に意味がある — 「安全検査で弾かれただけなのに exporting にしてしまう」ことを
 * 避けるため、**呼び出し側はこれが ok を返してから status を進める**。
 */
/**
 * **書き込み先そのものの検査だけ** (env 2 本 + 実際の解決先との完全一致)。
 *
 * `checkWriteGate()` (通常納品) と `checkSingleFileWriteGate()` (E2E の 1 件書き出し) が
 * **同じこれを通る**。env の読み方・正規化・一致判定を 2 か所に書くと、片方だけ緩んでも
 * 気づけない。**ここを緩めると両方が緩む**ので、変更は必ず両方の検査で落ちる。
 */
export function checkWriteTarget(
  /**
   * 読む env の名前。**既定は臨時診断バッチのもの**なので、引数なしの呼び出しは
   * 従来と 1 文字も変わらない。
   *
   * トランスコスモス v3 は **env を共用しない** (spec v3 §18.2) ので自分の 2 本を渡す。
   * ここを引数にしたのは、**判定そのものを写さない**ため — 正規化と完全一致の規則を
   * 2 か所に書くと、片方だけ緩んだときに誰も気づけない。
   * 「どの env を読むか」だけが違い、「どう判定するか」は 1 つ。
   */
  envNames: { enabled: string; target: string } = { enabled: WRITE_ENABLED_ENV, target: WRITE_TARGET_ENV },
): { ok: true; cfg: S3Config; target: string }
  | { ok: false; status: number; error: string; detail: string } {
  // ① 主スイッチ。未設定・`on` 以外はすべて無効 (fail-closed)。
  const enabled = env(envNames.enabled).trim();
  if (enabled !== 'on') {
    return {
      ok: false, status: 403, error: 'write_disabled',
      detail: enabled
        ? `${envNames.enabled} が "on" ではありません。実書き込みは無効です。`
        : `${envNames.enabled} が未設定です。実書き込みは無効です。`,
    };
  }

  // ② 書き込み先の明示宣言。既定値を持たせない。
  const declared = env(envNames.target).trim();
  if (!declared) {
    return {
      ok: false, status: 403, error: 'write_target_unset',
      detail: `${envNames.target} が未設定です。書き込み先を明示しない限り実書き込みしません。`,
    };
  }

  // ③ 実際の解決先と完全一致すること。
  const cfg = getS3Config();
  if (!cfg) {
    return { ok: false, status: 503, error: 's3_not_configured', detail: 'S3 が未設定です。' };
  }
  const actual = actualTargetUri(cfg);
  const want = normalizeS3Uri(declared);
  if (actual !== want) {
    return {
      ok: false, status: 403, error: 'write_target_mismatch',
      detail: `${envNames.target} と実際の書き込み先が一致しません (宣言=${want} / 実際=${actual})。`,
    };
  }

  return { ok: true, cfg, target: actual };
}

/**
 * 通常納品のゲート。**部分納品を禁止する**のはここだけ (E2E の 1 件書き出しは別関数)。
 */
export function checkWriteGate(input: WriteGateInput): WriteGateResult {
  const t = checkWriteTarget();
  if (!t.ok) return t;
  const { cfg, target: actual } = t;

  // ④ 部分納品の禁止。1 人でも ready でなければ全体を止める。
  if (input.skipped.length > 0) {
    return {
      ok: false, status: 409, error: 'partial_export_blocked',
      detail: `納品対象外の人物が ${input.skipped.length} 件あります。全員が揃うまで実書き込みしません。`,
    };
  }

  // ⑤ 0 件で「成功」にしない。
  if (input.delivery.length === 0) {
    return {
      ok: false, status: 409, error: 'nothing_to_export',
      detail: '納品ファイルが 0 件です。',
    };
  }

  // ⑥ 全 key が Elith の論理形の配下であること。
  for (const f of input.delivery) {
    const v = validateDeliveryKey(f, cfg);
    if (!v.ok) {
      return {
        ok: false, status: 400, error: 'invalid_delivery_key',
        detail: `納品先 key が想定外です (${v.reason})。`,
      };
    }
  }

  return { ok: true, cfg, target: actual };
}

// ---------------------------------------------------------------------------
// 既存オブジェクトの事前確認
// ---------------------------------------------------------------------------

/**
 * **1 件でも既に在れば PUT を 1 回も始めない。**
 *
 * 確認できなかった場合 (権限不足・通信断など) も**書かない** — 「無いはず」で進めると
 * 上書きに化ける。存在確認が成立したものだけを「無い」と判断する。
 */
export async function preflightNoExistingObjects(
  keys: string[],
  cfg: S3Config,
): Promise<{ ok: true } | { ok: false; status: number; error: string; detail: string }> {
  const client = makeS3Client(cfg);
  const existing: string[] = [];
  for (const key of keys) {
    try {
      await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
      existing.push(key);
    } catch (e) {
      if (isNotFound(e)) continue;
      return {
        ok: false, status: 502, error: 'preflight_failed',
        detail: `既存オブジェクトの確認に失敗したため中止しました (${describe(e)})。`,
      };
    }
  }
  if (existing.length > 0) {
    return {
      ok: false, status: 409, error: 'destination_exists',
      detail: `書き込み先に既存オブジェクトが ${existing.length} 件あります。Phase A では上書きしません。`,
    };
  }
  return { ok: true };
}

function isNotFound(e: unknown): boolean {
  const meta = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata;
  if (meta?.httpStatusCode === 404) return true;
  const name = (e as { name?: string })?.name ?? '';
  return name === 'NotFound' || name === 'NoSuchKey';
}

function describe(e: unknown): string {
  const name = (e as { name?: string })?.name;
  const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return [name, status ? `HTTP ${status}` : null].filter(Boolean).join(' / ') || 'unknown';
}

// ---------------------------------------------------------------------------
// 実書き込み (create-only)
// ---------------------------------------------------------------------------

export interface AdHocUploaded { key: string; bytes: number; uri: string }

/**
 * **新規作成のみ**で PUT する。
 *
 * `IfNoneMatch: '*'` は「その key が存在しないときだけ書く」という S3 の条件付き書き込み。
 * preflight を通った後に他の実行が同じ key を作る競合 (race) が残るので、
 * **サーバ側の最後の砦としてここでも条件を付ける**。
 * 条件に反した場合 S3 は 412 を返し、**既存オブジェクトは変更されない**。
 *
 * 共通の `putFiles()` を使わないのは、あちらの挙動を変えないため (他機能が使っている)。
 */
export async function putDeliveryFilesCreateOnly(
  files: { key: string; body: string; bytes: number }[],
  cfg: S3Config,
): Promise<AdHocUploaded[]> {
  const client = makeS3Client(cfg);
  const uploaded: AdHocUploaded[] = [];
  for (const f of files) {
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: f.key,
        Body: f.body,
        ContentType: 'application/json; charset=utf-8',
        // **上書き禁止。Phase A では escape hatch を作らない。**
        IfNoneMatch: '*',
      }),
    );
    uploaded.push({ key: f.key, bytes: f.bytes, uri: `s3://${cfg.bucket}/${f.key}` });
  }
  return uploaded;
}

// ---------------------------------------------------------------------------
// E2E 確認用: 1 ファイルだけの書き出し
// ---------------------------------------------------------------------------

/**
 * **1 ファイルだけを実際の Elith 納品先へ書くためのゲート。**
 *
 * 【なぜ別関数なのか】通常納品は「1 人でも未完成なら全部止める」(部分納品禁止) が要件で、
 * それは**緩めない**。一方 E2E 確認は「坂田氏の `HealthCheckupData` 1 件だけを実際に置いて
 * 中身を確かめる」ことが目的なので、**部分納品禁止に引っかかるのが正常**。
 * だから `checkWriteGate()` に例外分岐を足すのではなく、
 * **経路そのものを分けて**「通常納品の規則は 1 文字も変えない」を保つ。
 *
 * 【それでも共有するもの】env 2 本・書き込み先の完全一致 (`checkWriteTarget`) と
 * key の形 (`validateDeliveryKey`)・create-only PUT・既存 key の事前確認。
 * **安全側の検査は 1 つも外さない。**
 */
export function checkSingleFileWriteGate(
  file: Pick<DeliveryFile, 'key' | 'formatId' | 'testDate'>,
): WriteGateResult {
  const t = checkWriteTarget();
  if (!t.ok) return t;
  const v = validateDeliveryKey(file, t.cfg);
  if (!v.ok) {
    return {
      ok: false, status: 400, error: 'invalid_delivery_key',
      detail: `納品先 key が想定外です (${v.reason})。`,
    };
  }
  return t;
}

export interface HeadResult {
  exists: boolean;
  bytes: number | null;
  etag: string | null;
}

/**
 * 1 つの key の存在を確かめる。
 *
 * **「確認できなかった」を「無い」にしない。** 権限不足・通信断は例外として投げ、
 * 呼び出し側が中止する。`exists:false` を返すのは **S3 が 404 を返したときだけ**。
 */
export async function headDeliveryObject(key: string, cfg: S3Config): Promise<HeadResult> {
  const client = makeS3Client(cfg);
  try {
    const r = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
    return {
      exists: true,
      bytes: typeof r.ContentLength === 'number' ? r.ContentLength : null,
      etag: typeof r.ETag === 'string' ? r.ETag.replace(/^"|"$/g, '') : null,
    };
  } catch (e) {
    if (isNotFound(e)) return { exists: false, bytes: null, etag: null };
    throw e;
  }
}
