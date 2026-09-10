// src/lib/ad-hoc-diagnosis/keys.ts
// 臨時診断バッチ の S3 キー採番と検証。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §5.2 / §24.2
//
// **キーはサーバが採番する。クライアントから key を受け取らない。**
// 検証は「完全一致」で行う (部分一致にしない)。
//   → 部分一致に緩めると、同じバケットに在る **Elith 納品 JSON (全利用者ぶん)** を
//     読み出させることができてしまう。`/api/scan` で同型の設計をしている
//     (`scan-upload-ticket.ts` の `isScanUploadKey`) ので、そちらと同じ規律で書く。
import type { S3Config } from '../s3';

/** ZIP の置き場所。`{prefix}ad-hoc-uploads/{batchId}/source.zip` に完全一致。 */
export const AD_HOC_DIR = 'ad-hoc-uploads/';

/** ZIP の固定ファイル名。batchId ごとに 1 本しか置かない。 */
export const SOURCE_ZIP_NAME = 'source.zip';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** UUID v4 相当の文字列か (小文字 16 進のみ。大文字は通さない=採番はサーバなので揺れない)。 */
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/**
 * batchId から ZIP のキーを導出する。**これが唯一の採番口**。
 * クライアントの申告値からキーを組み立てない。
 */
export function adHocZipKey(cfg: S3Config, batchId: string): string {
  if (!isUuid(batchId)) throw new Error('adHocZipKey: batchId must be a uuid');
  return `${cfg.prefix}${AD_HOC_DIR}${batchId}/${SOURCE_ZIP_NAME}`;
}

/**
 * ZIP キーの検証。**完全一致**。
 *
 * 通すのは `{prefix}ad-hoc-uploads/{uuid}/source.zip` だけ:
 *  - prefix が違う           → 別領域を読ませない
 *  - `..` や `/` の重なり     → 相対パスで外へ出させない
 *  - batchId が UUID でない   → 推測可能なキーを作らせない
 *  - ファイル名が source.zip 以外 → `.json` (Elith 納品) を読ませない
 */
export function isAdHocZipKey(key: unknown, cfg: S3Config): boolean {
  if (typeof key !== 'string' || key.length === 0) return false;
  if (key.includes('..') || key.includes('//')) return false;
  const head = `${cfg.prefix}${AD_HOC_DIR}`;
  if (!key.startsWith(head)) return false;
  const rest = key.slice(head.length);
  const parts = rest.split('/');
  if (parts.length !== 2) return false;
  const [batchId, name] = parts;
  if (!isUuid(batchId)) return false;
  return name === SOURCE_ZIP_NAME;
}

/**
 * batchId を ZIP キーから取り出す。**検証を通ったキーにしか使わない。**
 * 取り出せなければ null (呼び出し側で弾く)。
 */
export function batchIdFromZipKey(key: string, cfg: S3Config): string | null {
  if (!isAdHocZipKey(key, cfg)) return null;
  const head = `${cfg.prefix}${AD_HOC_DIR}`;
  return key.slice(head.length).split('/')[0] ?? null;
}
