/**
 * 最小構成の S3 アップロードユーティリティ (サーバ専用)。
 *
 * AI スキャン読込結果を Elith 連携用バケットへ書き出すために使う。
 * 接続情報はすべて環境変数 (サーバ専用)。未設定なら isS3Configured()=false を返し、
 * 呼び出し側でドライラン (プレビュー返却) にフォールバックできる。
 *
 * 必須 env:
 *   AWS_S3_BUCKET           書き出し先バケット名
 *   AWS_REGION              リージョン (例 ap-northeast-1)
 * 任意 env:
 *   AWS_S3_PREFIX           バケット内共通プレフィックス (例 scan-accuracy-test/)
 *   AWS_ACCESS_KEY_ID /
 *   AWS_SECRET_ACCESS_KEY   明示キー (未指定なら SDK 既定のクレデンシャルチェーン)
 *   AWS_S3_ENDPOINT         S3 互換エンドポイント (MinIO 等。任意)
 */

import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';

/** S3 へ PUT する 1 ファイル (scan-export / interview-export 共通) */
export interface S3PutFile {
  /** バケット内 key */
  key: string;
  contentType: string;
  /** テキスト (JSON/MD) は string、画像等バイナリは Uint8Array */
  body: string | Uint8Array;
  bytes: number;
}

export interface S3Config {
  bucket: string;
  region: string;
  prefix: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/** Elith 連携バケット (AWS_S3_BUCKET で上書き可) */
const DEFAULT_BUCKET = 'wellfort-ai-input';
/** バケット内共通プレフィックス (AWS_S3_PREFIX で上書き可) */
const DEFAULT_PREFIX = 'scan-accuracy-test/';

function env(name: string): string | undefined {
  // Astro (Vite) は import.meta.env、Node 実行時は process.env を見る
  const fromMeta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (fromMeta != null && fromMeta !== '') return fromMeta;
  const fromProc = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return fromProc != null && fromProc !== '' ? fromProc : undefined;
}

/**
 * S3 設定を返す。バケット/プレフィックスは既定値あり。
 * **AWS_REGION の有無を「書き出し有効化」のスイッチ**とする
 * (未設定なら null = ドライラン。ローカル開発で誤アップロードしないため)。
 */
export function getS3Config(): S3Config | null {
  const region = env('AWS_REGION');
  if (!region) return null;
  return {
    bucket: env('AWS_S3_BUCKET') ?? DEFAULT_BUCKET,
    region,
    prefix: env('AWS_S3_PREFIX') ?? DEFAULT_PREFIX,
    endpoint: env('AWS_S3_ENDPOINT'),
    accessKeyId: env('AWS_ACCESS_KEY_ID'),
    secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
  };
}

export function isS3Configured(): boolean {
  return getS3Config() !== null;
}

export interface UploadedObject {
  key: string;
  bytes: number;
  /** s3://bucket/key */
  uri: string;
}

/** S3Client を生成する。Partner Portal(presigned) からも使うため export する。 */
export function makeS3Client(cfg: S3Config, extra: Record<string, unknown> = {}): S3Client {
  return new S3Client({
    ...extra,
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
    ...(cfg.accessKeyId && cfg.secretAccessKey
      ? { credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } }
      : {}),
  });
}

const makeClient = makeS3Client;

export interface S3ObjectRef {
  key: string;
  size: number;
}

/** prefix 配下のオブジェクトを一覧する (ページング対応)。 */
export async function listObjects(prefix: string): Promise<S3ObjectRef[]> {
  const cfg = getS3Config();
  if (!cfg) throw new Error('S3 is not configured (AWS_S3_BUCKET / AWS_REGION required)');
  const client = makeClient(cfg);
  const out: S3ObjectRef[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of res.Contents ?? []) {
      if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0 });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/**
 * オブジェクトを同じバケット内で複製する (元は消さない)。
 * 検証用プレフィックスへ書き出したものを、納品先へ持っていくために使う。
 * 成功した複製先 key の数を返す。
 */
export async function copyObjects(pairs: { from: string; to: string }[]): Promise<number> {
  const cfg = getS3Config();
  if (!cfg) throw new Error('S3 is not configured (AWS_S3_BUCKET / AWS_REGION required)');
  const client = makeClient(cfg);
  let copied = 0;
  for (const { from, to } of pairs) {
    if (from === to) continue; // 同じ場所へは複製しない
    await client.send(new CopyObjectCommand({
      Bucket: cfg.bucket,
      // CopySource は「バケット名/キー」を URL エンコードして渡す
      CopySource: `${cfg.bucket}/${from}`.split('/').map(encodeURIComponent).join('/'),
      Key: to,
    }));
    copied++;
  }
  return copied;
}

/** 1 オブジェクトを UTF-8 テキストとして取得する。 */
export async function getObjectText(key: string): Promise<string> {
  const cfg = getS3Config();
  if (!cfg) throw new Error('S3 is not configured (AWS_S3_BUCKET / AWS_REGION required)');
  const client = makeClient(cfg);
  const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  const body = res.Body as { transformToString?: (enc?: string) => Promise<string> } | undefined;
  if (body?.transformToString) return body.transformToString('utf-8');
  throw new Error('unexpected S3 body type (no transformToString)');
}

/** key 群を削除する。削除できた key 数を返す (1000 件ずつバッチ)。 */
export async function deleteObjects(keys: string[]): Promise<number> {
  const cfg = getS3Config();
  if (!cfg) throw new Error('S3 is not configured (AWS_S3_BUCKET / AWS_REGION required)');
  if (keys.length === 0) return 0;
  const client = makeClient(cfg);
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    const res = await client.send(
      new DeleteObjectsCommand({
        Bucket: cfg.bucket,
        Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      }),
    );
    deleted += chunk.length - (res.Errors?.length ?? 0);
    if (res.Errors && res.Errors.length > 0) {
      throw new Error(`S3 delete errors: ${res.Errors.slice(0, 3).map((e) => `${e.Key}:${e.Code}`).join(', ')}`);
    }
  }
  return deleted;
}

/** ファイル群をバケットへ PUT する。成功した key のリストを返す。 */
export async function putFiles(files: S3PutFile[]): Promise<UploadedObject[]> {
  const cfg = getS3Config();
  if (!cfg) throw new Error('S3 is not configured (AWS_S3_BUCKET / AWS_REGION required)');

  const client = makeClient(cfg);

  const uploaded: UploadedObject[] = [];
  for (const f of files) {
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: f.key,
        Body: f.body,
        ContentType: f.contentType,
      }),
    );
    uploaded.push({ key: f.key, bytes: f.bytes, uri: `s3://${cfg.bucket}/${f.key}` });
  }
  return uploaded;
}
