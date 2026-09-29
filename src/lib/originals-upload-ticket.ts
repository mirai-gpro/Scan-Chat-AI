/**
 * 検査結果 **原本** をブラウザから S3 へ直接アップロードするための署名付き URL。
 *
 * 【なぜ要るか】`/api/admin/lab-results/upload` は multipart のファイル本体を
 *   Vercel Function に通すので、**Vercel のリクエストボディ上限 4.5 MB**
 *   (vercel.com/docs/functions/limitations) を超えると
 *   **関数に届く前に 413 で落ちる**。画面は「最大 20 MB」と名乗っていたが実際は
 *   ~4.5 MB までで、8.3 MB の遺伝子 PDF が通らなかった。
 *   → **ファイル本体を関数に通さず、ブラウザから S3 へ直接置く**。
 *   スキャンの S3 直アップロード (`scan-upload-ticket.ts`) と同じ形。
 *
 * 【踏襲するもの】保存先・保存キーの規則・ハッシュは既存のまま:
 *   - 保存先 = `getOriginalsS3Config()` (`AWS_S3_ORIGINALS_BUCKET` + `AWS_S3_ORIGINALS_PREFIX`)。
 *     **Elith 連携用の `AWS_S3_BUCKET` とは別**。
 *   - 保存キー = `lab_results/<company>/YYYY/MM/<filename>` (`upload.ts` と同じ)。
 *   - `storage_url` = `s3://<bucket>/<prefix><key>` (`putOriginal()` と同じ形)。
 *   - `sha256` = `sha256Hex()` で算出 (§6.1 の改竄検知)。
 *
 * 【安全性】署名付き URL は**それ自体が書き込み権限**なので、緩いと原本バケットへ
 *   任意のキーを書ける口になる。スキャン側で決めた守りをそのまま当てる:
 *   1. キーは**サーバが組む**。ブラウザから来るのはファイル名だけで、
 *      ディレクトリ区切り・`..`・制御文字は落とす (パス脱出を作らせない)。
 *   2. 組んだキーを `isOriginalUploadKey()` で**完全一致で再検査**してから署名する。
 *   3. **Content-Type と ContentLength を署名に固定**する
 *      = 別形式・サイズ超過へのすり替えを S3 が拒否する。
 *   4. 期限は 15 分。
 *   5. `requestChecksumCalculation: 'WHEN_REQUIRED'` が**必須**。既定だと SDK が
 *      署名時に空ボディの CRC32 を URL に載せ、実ファイルを PUT した瞬間に S3 が拒否する
 *      (`laif-portal.ts` / `scan-upload-ticket.ts` で踏んだ罠)。
 */
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getOriginalsS3Config, sha256Hex, type OriginalsS3Config } from './originals-storage';

/** `upload.ts` の LAB_COMPANY_TO_TEST_TYPE と同じ 4 社。キーの階層に入る。 */
export const ORIGINAL_COMPANIES = ['rieger', 'prevent', 'genoplan', 'laif'] as const;
export type OriginalCompany = (typeof ORIGINAL_COMPANIES)[number];

/** 原本 1 件の上限。既存 UI の名乗り (20 MB) に合わせる。直アップロードなので実際に通る。 */
export const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;
/** 署名の寿命。長くしても得が無い (押してすぐ上げる操作なので)。 */
export const PRESIGN_EXPIRES_SEC = 900;

const EXT_CONTENT_TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  csv: 'text/csv',
};

function client(cfg: OriginalsS3Config, extra: Record<string, unknown> = {}): S3Client {
  return new S3Client({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
    ...(cfg.accessKeyId && cfg.secretAccessKey
      ? { credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } }
      : {}),
    ...extra,
  });
}

/**
 * ブラウザ由来のファイル名を**キーに入れてよい形**へ落とす。
 * ディレクトリを剥がし、区切り・制御文字・先頭のドットを潰す。
 * 日本語のファイル名はそのまま通す (S3 のキーは UTF-8 で持てる)。
 */
export function safeBaseName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // 区切りで割って最後だけ採る = ディレクトリ指定を無効化する
  const base = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned || cleaned.length > 150) return null;
  if (cleaned.includes('..')) return null;
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(cleaned);
  if (!m) return null;
  if (!EXT_CONTENT_TYPE[m[1].toLowerCase()]) return null;
  return cleaned;
}

/** 拡張子から Content-Type。許可外は null (= 署名しない)。 */
export function contentTypeOf(name: string): string | null {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? (EXT_CONTENT_TYPE[m[1].toLowerCase()] ?? null) : null;
}

/** 保存キーを組む。`upload.ts` の規則と同じ `lab_results/<company>/YYYY/MM/<filename>`。 */
export function buildOriginalKey(company: OriginalCompany, fileName: string, now = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return `lab_results/${company}/${yyyy}/${mm}/${fileName}`;
}

/**
 * 署名・読み出しを許すキーか。**完全一致で見る** (部分一致にしない)。
 * 原本バケットには納品物や他用途のファイルも入り得るので、
 * ここを緩めると admin キー 1 本でバケットへ任意に書ける口になる。
 */
export function isOriginalUploadKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 300) return false;
  if (key.includes('..') || key.includes('//') || key.startsWith('/')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) return false;
  const m = /^lab_results\/([a-z]+)\/(\d{4})\/(\d{2})\/([^/]+)$/.exec(key);
  if (!m) return false;
  if (!(ORIGINAL_COMPANIES as readonly string[]).includes(m[1])) return false;
  const mo = Number(m[3]);
  if (mo < 1 || mo > 12) return false;
  return contentTypeOf(m[4]) !== null;
}

export type TicketResult =
  | { ok: true; url: string; key: string; storageUrl: string; expiresIn: number; headers: Record<string, string> }
  | { ok: false; error: string; detail?: string };

/**
 * 署名付き PUT を 1 件発行する。**本体はここを通らない。**
 * 返す `storageUrl` は登録時に `test_artifact_files.storage_url` へ入れる値で、
 * `putOriginal()` が返すものと同じ形 (`s3://bucket/prefix+key`)。
 */
export async function createOriginalUploadTicket(input: {
  company: unknown;
  fileName: unknown;
  bytes: unknown;
}): Promise<TicketResult> {
  const cfg = getOriginalsS3Config();
  if (!cfg) {
    return {
      ok: false,
      error: 'originals_s3_not_configured',
      detail: 'AWS_S3_ORIGINALS_BUCKET / AWS_REGION が未設定です (Supabase Storage へは直アップロードできません)',
    };
  }
  const company = input.company;
  if (typeof company !== 'string' || !(ORIGINAL_COMPANIES as readonly string[]).includes(company)) {
    return { ok: false, error: 'invalid_company' };
  }
  const name = safeBaseName(input.fileName);
  if (!name) return { ok: false, error: 'invalid_file_name' };
  const contentType = contentTypeOf(name);
  if (!contentType) return { ok: false, error: 'invalid_file_type' };

  const bytes = typeof input.bytes === 'number' ? Math.trunc(input.bytes) : NaN;
  if (!Number.isFinite(bytes) || bytes <= 0) return { ok: false, error: 'invalid_size' };
  if (bytes > MAX_ORIGINAL_BYTES) {
    return { ok: false, error: 'too_large', detail: `${MAX_ORIGINAL_BYTES / 1024 / 1024} MB 以下にしてください` };
  }

  const key = buildOriginalKey(company as OriginalCompany, name);
  // サーバが組んだキーでも、署名の直前にもう一度検査する (組み立ての誤りを通さない)。
  if (!isOriginalUploadKey(key)) return { ok: false, error: 'invalid_key', detail: key };

  const fullKey = `${cfg.prefix}${key}`.replace(/\/{2,}/g, '/');
  const url = await getSignedUrl(
    client(cfg, { requestChecksumCalculation: 'WHEN_REQUIRED' }),
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: fullKey,
      ContentType: contentType,
      ContentLength: bytes, // 署名に固定 → サイズ超過の差し替えを S3 が拒否する
    }),
    { expiresIn: PRESIGN_EXPIRES_SEC, signableHeaders: new Set(['content-type']) },
  );

  return {
    ok: true,
    url,
    key,
    storageUrl: `s3://${cfg.bucket}/${fullKey}`,
    expiresIn: PRESIGN_EXPIRES_SEC,
    headers: { 'content-type': contentType },
  };
}

export type ReadResult =
  | { ok: true; bytes: Uint8Array; sha256: string; sizeBytes: number; contentType: string; storageUrl: string }
  | { ok: false; error: string; detail?: string };

/**
 * PUT 済みの原本をサーバ側で読み直す。**登録の前に必ず通す。**
 *
 * - 「上がったことにして DB だけ書く」を防ぐ (実在を S3 に聞く)
 * - `sha256` / `size_bytes` は **実体から算出**する。ブラウザの自己申告を信じない
 *   (`test_artifact_files.sha256` は改竄検知の根拠なので §6.1)
 *
 * **サーバ → S3 の読み出しは Vercel のボディ上限の対象外**なので 8 MB でも通る。
 */
export async function readUploadedOriginal(key: unknown): Promise<ReadResult> {
  const cfg = getOriginalsS3Config();
  if (!cfg) return { ok: false, error: 'originals_s3_not_configured' };
  if (!isOriginalUploadKey(key)) return { ok: false, error: 'invalid_key' };

  const fullKey = `${cfg.prefix}${key}`.replace(/\/{2,}/g, '/');
  const c = client(cfg);
  try {
    const head = await c.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: fullKey }));
    const size = head.ContentLength ?? 0;
    if (size <= 0) return { ok: false, error: 'empty_object' };
    // 署名で固定してあるが、読み出し側でも見る (署名を作った経路以外で置かれた場合の保険)。
    if (size > MAX_ORIGINAL_BYTES) return { ok: false, error: 'too_large', detail: `${size} bytes` };

    const res = await c.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: fullKey }));
    const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!body?.transformToByteArray) return { ok: false, error: 'unexpected_body' };
    const bytes = await body.transformToByteArray();
    return {
      ok: true,
      bytes,
      sha256: sha256Hex(bytes),
      sizeBytes: bytes.byteLength,
      contentType: res.ContentType || contentTypeOf(String(key)) || 'application/octet-stream',
      storageUrl: `s3://${cfg.bucket}/${fullKey}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 未 PUT / 期限切れで PUT されなかった場合はここに来る。
    return { ok: false, error: 'not_found', detail: msg };
  }
}
