// src/lib/ad-hoc-diagnosis/ticket.ts
// 臨時診断バッチ: ZIP を **Vercel の関数を通さずに** S3 へ置くための presigned PUT。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §5.2 / §5.2.1
//
// **キーはサーバが採番する。クライアントは PUT 先を選べない** (`keys.ts`)。
// サイズは**署名だけに頼らず多層で守る** (§5.2.1):
//   ① ticket 発行時 … 申告値が上限以下か (これは信用しない)
//   ② アップロード後 … `HeadObject` の実サイズ (**本命**)
//   ③ ZIP 解析時    … 宣言値の合計と展開中の実バイト数

import { PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getS3Config, makeS3Client, type S3Config } from '../s3';
import { adHocZipKey, isAdHocZipKey } from './keys';
import { MAX_ZIP_BYTES } from './archive';

export const PRESIGN_EXPIRES_SEC = 15 * 60;
export const ZIP_CONTENT_TYPE = 'application/zip';

/** ZIP として受け付ける Content-Type。ブラウザ・OS で名乗りが揺れるので複数許す。 */
const ACCEPTED_ZIP_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
  'multipart/x-zip',
]);

export type TicketResult =
  | {
      ok: true;
      batchId: string;
      key: string;
      url: string;
      expiresIn: number;
      headers: Record<string, string>;
    }
  | { ok: false; status: number; error: string; detail?: string };

/**
 * presigned PUT を発行する。**ブラウザへ返すのは url / headers / expiresIn / batchId だけ**
 * (§5.2-4)。`ADMIN_API_KEY` は当然出さない。
 */
export async function createAdHocUploadTicket(input: {
  batchId: string;
  declaredSize: number;
  contentType?: string;
}): Promise<TicketResult> {
  const cfg = getS3Config();
  if (!cfg) return { ok: false, status: 503, error: 's3_not_configured' };

  const bytes = Number(input.declaredSize);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { ok: false, status: 400, error: 'invalid_size', detail: 'ファイルサイズが不正です' };
  }
  // ① ticket 発行時の一次判定。**申告値なので信用しない** (② が本命)。
  if (bytes > MAX_ZIP_BYTES) {
    return {
      ok: false,
      status: 413,
      error: 'file_too_large',
      detail: `ZIP の上限は ${Math.floor(MAX_ZIP_BYTES / 1024 / 1024)}MB です (申告: ${(bytes / 1024 / 1024).toFixed(1)}MB)`,
    };
  }

  const contentType = ACCEPTED_ZIP_TYPES.has(String(input.contentType ?? '').toLowerCase())
    ? String(input.contentType)
    : ZIP_CONTENT_TYPE;

  const key = adHocZipKey(cfg, input.batchId);

  // `requestChecksumCalculation: 'WHEN_REQUIRED'` は必須。
  // 既定だと SDK が署名時に空ボディの CRC32 を URL へ載せ、実ファイルを PUT した瞬間に
  // S3 が拒否する (`laif-portal.ts` / `scan-upload-ticket.ts` で踏んだ罠)。
  const client = makeS3Client(cfg, { requestChecksumCalculation: 'WHEN_REQUIRED' });
  const url = await getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: bytes,
    }),
    { expiresIn: PRESIGN_EXPIRES_SEC, signableHeaders: new Set(['content-type']) },
  );

  return {
    ok: true,
    batchId: input.batchId,
    key,
    url,
    expiresIn: PRESIGN_EXPIRES_SEC,
    headers: { 'content-type': contentType },
  };
}

export type HeadResult =
  | { ok: true; size: number }
  | { ok: false; status: number; error: string; detail?: string };

/**
 * ② **アップロード後の実サイズ検証** (§5.2.1・本命)。
 * `classify` の冒頭で必ず通す。上限超過なら失敗にし、**一時 ZIP を削除する。**
 */
export async function headAdHocZip(key: string, cfg?: S3Config | null): Promise<HeadResult> {
  const c = cfg ?? getS3Config();
  if (!c) return { ok: false, status: 503, error: 's3_not_configured' };
  if (!isAdHocZipKey(key, c)) return { ok: false, status: 400, error: 'invalid_key' };

  const client = makeS3Client(c);
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: c.bucket, Key: key }));
    const size = head.ContentLength;
    if (typeof size !== 'number' || size <= 0) {
      return { ok: false, status: 404, error: 'zip_not_found' };
    }
    if (size > MAX_ZIP_BYTES) {
      return {
        ok: false,
        status: 413,
        error: 'file_too_large',
        detail: `実サイズ ${(size / 1024 / 1024).toFixed(1)}MB が上限 ${Math.floor(MAX_ZIP_BYTES / 1024 / 1024)}MB を超えています`,
      };
    }
    return { ok: true, size };
  } catch (err) {
    const name = (err as { name?: string })?.name ?? '';
    if (name === 'NotFound' || name === 'NoSuchKey') {
      return { ok: false, status: 404, error: 'zip_not_found' };
    }
    return { ok: false, status: 502, error: 'head_failed', detail: String(err).slice(0, 200) };
  }
}

/**
 * 一時 ZIP を消す。**上限超過・失敗時に呼ぶ** (§5.2.1 ②)。
 * 消せなくても本処理を止めない (バケットのライフサイクルが最後は失効させる・§24.4)。
 */
export async function deleteAdHocZip(key: string, cfg?: S3Config | null): Promise<boolean> {
  const c = cfg ?? getS3Config();
  if (!c) return false;
  if (!isAdHocZipKey(key, c)) return false;
  try {
    await makeS3Client(c).send(new DeleteObjectCommand({ Bucket: c.bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}
