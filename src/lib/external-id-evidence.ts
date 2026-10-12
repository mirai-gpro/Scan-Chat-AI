/**
 * 受取時の撮影画像 (**証跡**) を ブラウザ → S3 直接 で受け取る presigned PUT と、
 * サーバからの読み出し。
 *
 * 正本: `docs/lab/kit_receipt_external_id_capture_spec.md` §6.2。
 *
 * 【`scan-upload-ticket.ts` の形をそのまま流用している】理由も同じ:
 *   1. **キーはサーバが採番する。** クライアントは PUT 先を選べない。
 *   2. `isEvidenceKey` が**完全一致**で検証した形だけ読む
 *      → 同じバケットの **Elith 納品 JSON (全利用者ぶん) を読み出せない**。
 *      部分一致にしないのが要点 (`scan-upload-ticket.ts:14-31` と同じ理屈)。
 *   3. UUID は推測不能。
 *   4. Content-Type と ContentLength を**署名に固定** → 差し替えを S3 自身が拒否する。
 *   5. 期限は短く 15 分。
 *
 * 【`putOriginal()` (`originals-storage.ts:103`) は使わない】
 * あちらは **Object Lock ＋ 10 年保管の「検査原本」**用で、**削除も上書きもできない**。
 * 受取時の撮影は**撮り直しが常態**なので、入れると消せないゴミが積み上がる。
 * これは検査原本ではなく**読み取りの証跡**なので、別のプレフィックスに置く。
 *
 * 【`.pdf` と `.json` を許可拡張子に入れない】
 * 撮影対象は書面の**写真**で、PDF は要らない。`.json` を入れないのは
 * `scan-upload-ticket.ts` と同じ理由 = **納品 JSON を読ませないため**。
 *
 * 【運用の前提】
 *   - バケットに **CORS 設定が要る** (`docs/operations/スキャンS3直アップロード_バケット設定手順書.md`)。
 *     無いとブラウザの PUT が黙って失敗するので、呼び出し側は**手入力へ落とせる**ようにする。
 *     **S3 の CORS はバケット単位で、prefix 単位では絞れない** — 許可するのは
 *     Origin / `PUT` / 必要な header で、**`kit-id-captures/` への限定は CORS ではなく
 *     下の `isEvidenceKey` （署名を出す前のサーバ側検証）が持つ**。
 *     CORS が広いこと自体は書き込み権限にならない（署名が無いと S3 に通らない）。
 *   - 保存期間は**まだ決まっていない** (仕様 §9 の D-3)。既存の医療関連画像・検査証跡の
 *     ポリシーに合わせる判断待ちなので、**ここでライフサイクルを前提にしない**。
 */

import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getS3Config, makeS3Client, type S3Config } from './s3';

/** 証跡画像の上限。書面 1 枚の写真なので大きくしない。 */
export const MAX_EVIDENCE_BYTES = 12 * 1024 * 1024;

/** presigned URL の有効期限 (秒)。PUT を開始できる猶予であって転送時間ではない。 */
export const PRESIGN_EXPIRES_SEC = 900;

/** 一時領域。`AWS_S3_PREFIX` の下に置く。 */
const EVIDENCE_SEGMENT = 'kit-id-captures/';

/** 受け入れる MIME → 拡張子。**画像だけ** (PDF / JSON は入れない)。 */
const ACCEPTED: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export function evidencePrefix(cfg: S3Config): string {
  return `${cfg.prefix}${EVIDENCE_SEGMENT}`;
}

/**
 * 読み出してよいキーか。**サーバが採番した形と完全一致するものだけ**通す。
 * ここが緩むとバケット内の他データを読み出せてしまうので、部分一致にしない。
 */
export function isEvidenceKey(key: unknown, cfg: S3Config): key is string {
  if (typeof key !== 'string') return false;
  const prefix = evidencePrefix(cfg);
  if (!key.startsWith(prefix)) return false;
  const rest = key.slice(prefix.length);
  return /^\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|heic|heif)$/.test(
    rest,
  );
}

export type EvidenceTicketResult =
  | { ok: true; url: string; key: string; expiresIn: number; headers: Record<string, string> }
  | { ok: false; status: number; error: string; detail: string };

/** 証跡画像 1 枚ぶんの presigned PUT を発行する。 */
export async function createEvidenceTicket(input: {
  contentType: unknown;
  bytes: unknown;
}): Promise<EvidenceTicketResult> {
  const cfg = getS3Config();
  if (!cfg) {
    return { ok: false, status: 503, error: 's3_not_configured', detail: 'AWS_REGION / AWS_S3_BUCKET 未設定' };
  }

  const contentType =
    typeof input.contentType === 'string' ? input.contentType.split(';')[0].trim().toLowerCase() : '';
  const ext = ACCEPTED[contentType];
  if (!ext) {
    return {
      ok: false, status: 400, error: 'unsupported_content_type',
      detail: `対応していない形式です (${contentType || '不明'})。写真 (JPEG / PNG / WebP / HEIC) を選んでください`,
    };
  }

  const bytes = typeof input.bytes === 'number' ? input.bytes : Number(input.bytes);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { ok: false, status: 400, error: 'invalid_size', detail: 'ファイルサイズが不正です' };
  }
  if (bytes > MAX_EVIDENCE_BYTES) {
    return {
      ok: false, status: 413, error: 'file_too_large',
      detail: `最大 ${Math.floor(MAX_EVIDENCE_BYTES / 1024 / 1024)}MB です (受信: ${(bytes / 1024 / 1024).toFixed(1)}MB)`,
    };
  }

  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
  // キーはサーバが採番する。クライアントは PUT 先を選べない。
  const key = `${evidencePrefix(cfg)}${day}/${crypto.randomUUID()}.${ext}`;

  // requestChecksumCalculation='WHEN_REQUIRED':
  //   既定のままだと SDK が署名時に空ボディの CRC32 を URL に載せ、実ファイルを PUT した
  //   瞬間に S3 が拒否する (`laif-portal.ts` / `scan-upload-ticket.ts` で踏んだ罠)。
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

export type EvidenceFetchResult =
  | { ok: true; mime: string; base64: string; bytes: number }
  | { ok: false; status: number; error: string };

/** 読み取り (Gemini へ渡す) ために S3 から 1 枚取る。**キーの形を検証してから**読む。 */
export async function fetchEvidence(key: unknown): Promise<EvidenceFetchResult> {
  const cfg = getS3Config();
  if (!cfg) return { ok: false, status: 503, error: 's3_not_configured' };
  if (!isEvidenceKey(key, cfg)) return { ok: false, status: 400, error: 'invalid_key' };

  const client = makeS3Client(cfg);
  let res;
  try {
    res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  } catch {
    return { ok: false, status: 404, error: 'evidence_not_found' };
  }
  if ((res.ContentLength ?? 0) > MAX_EVIDENCE_BYTES) {
    return { ok: false, status: 413, error: 'file_too_large' };
  }
  if (!res.Body) return { ok: false, status: 404, error: 'evidence_not_found' };

  const bytes = await res.Body.transformToByteArray();
  const mime = (res.ContentType || '').split(';')[0].trim().toLowerCase();
  // **実体も見る** (Content-Type だけを信じない)。`genoplan-fetch.ts:263-266` が
  // PDF のマジックバイトを見ているのと同じ規律。画像でなければ Gemini へ渡さない。
  if (!ACCEPTED[mime] || !looksLikeImage(bytes)) {
    return { ok: false, status: 400, error: 'not_an_image' };
  }
  return {
    ok: true,
    mime,
    base64: Buffer.from(bytes).toString('base64'),
    bytes: bytes.byteLength,
  };
}

/**
 * 先頭バイトで画像かを見る (JPEG / PNG / WebP / HEIC・HEIF)。
 * **Content-Type の自己申告だけを信じない**ための最小の実体検査。
 */
export function looksLikeImage(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return true;
  const ascii = (i: number, s: string) =>
    [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  // RIFF....WEBP
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return true;
  // ....ftyp<heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1>
  if (ascii(4, 'ftyp')) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand)) return true;
  }
  return false;
}
