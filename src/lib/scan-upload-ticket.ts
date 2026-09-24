/**
 * AI スキャンの大きいファイルを **ブラウザ → S3 直接** で受け取るための presigned PUT。
 *
 * 【なぜ要るのか】
 * `/api/scan` は data URL を JSON body で受けるが、**Vercel Functions の
 * リクエストボディ上限は 4.5 MB** で、base64 の 4/3 倍を差し引くと実ファイルは
 * 約 3.2 MB が天井になる (出典: vercel.com/docs/functions/limitations
 * 「Request body size」・超過は 413 `FUNCTION_PAYLOAD_TOO_LARGE`)。
 * これは **Vercel の関数を通るデータにだけ**かかる制限なので、
 * ファイル本体を関数に通さず S3 へ直接置けば上限は外れる。
 * 同じ方式を LAiF ポータルが既に使っている (`laif-portal.ts`・50MB)。
 *
 * 【安全性の考え方】
 * `/api/scan` は受け取ったキーの中身を読んで Gemini に渡すので、
 * **キーを自由に指定できると同じバケットの他のオブジェクト
 * (Elith 納品 JSON など) を読み出せてしまう**。そこで:
 *   1. キーは**サーバが採番**する。クライアントは PUT 先を選べない。
 *   2. `scan-uploads/` 配下・`YYYY/MM/DD/<UUID>.<ext>` の形に**完全一致**するものだけ読む
 *      (`isScanUploadKey`)。Elith 納品は `user/{client_id}/date/...` なので形が違い、通らない。
 *   3. UUID は推測不能 (`laif-portal.ts` と同じ考え方)。
 *   4. Content-Type と ContentLength を**署名に固定**する = 別形式・サイズ超過へのすり替えを
 *      S3 自身が拒否する。
 *   5. 期限は短く (`PRESIGN_EXPIRES_SEC`)。
 *
 * 【運用の前提 (未対応・要オペレーション)】
 *   - **バケットに CORS 設定が要る** (アプリのオリジンからの PUT を許可)。
 *     無いとブラウザの PUT がブロックされる。→ その場合もクライアントは
 *     画像なら圧縮経路へフォールバックする (`scan-upload.ts`)。
 *   - `scan-uploads/` は一時領域なので、**ライフサイクルで自動失効**させること
 *     (原本の保管は `originals-storage.ts` の役目でこことは別)。
 */

import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getS3Config, makeS3Client, type S3Config } from './s3';
import { SCAN_UPLOAD_MAX_BYTES } from './scan-upload-limits';

/**
 * 受け付ける上限。**クライアント (`scan-upload.ts`) と同じ定数**を使う。
 * 以前は別リテラル (10 MB) で、クライアントを 40 MB へ上げたとき上げ忘れて
 * 10 MB 超が S3 直アップロードに乗れず 3 MB 圧縮へ落ちる回帰を招いた
 * (`scan-upload-limits.ts` に集約して再発を止めた)。
 */
export const MAX_SCAN_UPLOAD_BYTES = SCAN_UPLOAD_MAX_BYTES;

/** presigned URL の有効期限 (秒)。PUT を開始できる猶予であって転送時間ではない。 */
export const PRESIGN_EXPIRES_SEC = 900;

/** 一時領域。`AWS_S3_PREFIX` の下に置く。 */
const SCAN_UPLOAD_SEGMENT = 'scan-uploads/';

/** 受け入れる MIME → 拡張子。`scan.astro` の accept と揃える。 */
const ACCEPTED: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export type TicketResult =
  | { ok: true; url: string; key: string; expiresIn: number; headers: Record<string, string> }
  | { ok: false; status: number; error: string; detail: string };

function scanPrefix(cfg: S3Config): string {
  return `${cfg.prefix}${SCAN_UPLOAD_SEGMENT}`;
}

/**
 * 読み出してよいキーか。**サーバが採番した形と完全一致するものだけ**通す。
 * ここが緩むとバケット内の他データを読み出せてしまうので、部分一致にしない。
 */
export function isScanUploadKey(key: string, cfg: S3Config): boolean {
  const prefix = scanPrefix(cfg);
  if (!key.startsWith(prefix)) return false;
  const rest = key.slice(prefix.length);
  return /^\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png|webp|heic|heif)$/.test(
    rest,
  );
}

/** アップロード用の presigned PUT を 1 回分発行する。 */
export async function createScanUploadTicket(input: {
  contentType: unknown;
  bytes: unknown;
}): Promise<TicketResult> {
  const cfg = getS3Config();
  if (!cfg) {
    return { ok: false, status: 503, error: 's3_not_configured', detail: 'AWS_REGION 未設定' };
  }

  const contentType =
    typeof input.contentType === 'string' ? input.contentType.split(';')[0].trim().toLowerCase() : '';
  const ext = ACCEPTED[contentType];
  if (!ext) {
    return {
      ok: false,
      status: 400,
      error: 'unsupported_content_type',
      detail: `対応していない形式です (${contentType || '不明'})`,
    };
  }

  const bytes = typeof input.bytes === 'number' ? input.bytes : Number(input.bytes);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { ok: false, status: 400, error: 'invalid_size', detail: 'ファイルサイズが不正です' };
  }
  if (bytes > MAX_SCAN_UPLOAD_BYTES) {
    return {
      ok: false,
      status: 413,
      error: 'file_too_large',
      detail: `最大 ${Math.floor(MAX_SCAN_UPLOAD_BYTES / 1024 / 1024)}MB です (受信: ${(bytes / 1024 / 1024).toFixed(1)}MB)`,
    };
  }

  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
  // キーはサーバが採番する。クライアントは PUT 先を選べない。
  const key = `${scanPrefix(cfg)}${day}/${crypto.randomUUID()}.${ext}`;

  // requestChecksumCalculation='WHEN_REQUIRED':
  //   既定のままだと SDK が署名時に空ボディの CRC32 を計算して URL に載せてしまい、
  //   実ファイルを PUT した瞬間に S3 がチェックサム不一致で拒否する
  //   (`laif-portal.ts` で踏んだのと同じ罠)。presigned PUT では必ず切る。
  const client = makeS3Client(cfg, { requestChecksumCalculation: 'WHEN_REQUIRED' });
  const url = await getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: bytes, // 署名に固定 → サイズ超過の差し替えを S3 が拒否する
    }),
    { expiresIn: PRESIGN_EXPIRES_SEC, signableHeaders: new Set(['content-type']) },
  );

  return { ok: true, url, key, expiresIn: PRESIGN_EXPIRES_SEC, headers: { 'content-type': contentType } };
}

export type FetchResult =
  | { ok: true; mime: string; base64: string; bytes: number }
  | { ok: false; status: number; error: string };

/**
 * `/api/scan` から呼ぶ。**キーの形を検証してから**読む。
 * サーバ → S3 の取得なので Vercel のボディ上限はかからない (上限は関数の入出力にだけ効く)。
 */
export async function fetchScanUpload(key: unknown): Promise<FetchResult> {
  const cfg = getS3Config();
  if (!cfg) return { ok: false, status: 503, error: 's3_not_configured' };
  if (typeof key !== 'string' || !isScanUploadKey(key, cfg)) {
    return { ok: false, status: 400, error: 'invalid_key' };
  }

  const client = makeS3Client(cfg);
  let res;
  try {
    res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  } catch {
    return { ok: false, status: 404, error: 'upload_not_found' };
  }

  // 署名で ContentLength を固定してあるが、読み出し側でも念のため見る。
  if ((res.ContentLength ?? 0) > MAX_SCAN_UPLOAD_BYTES) {
    return { ok: false, status: 413, error: 'file_too_large' };
  }
  if (!res.Body) return { ok: false, status: 404, error: 'upload_not_found' };

  const bytes = await res.Body.transformToByteArray();
  return {
    ok: true,
    mime: res.ContentType || 'application/octet-stream',
    base64: Buffer.from(bytes).toString('base64'),
    bytes: bytes.byteLength,
  };
}
