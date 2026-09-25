/**
 * `elith-assemble.ts` が使う S3 層の差し替え（fixture 専用）。
 *
 * 【なぜ要るか】P0-2E-0: `elith-assemble.ts` の共通 delivery ループへ手を入れる前に、
 * **既存 admin 手動ラップの出力が 1 バイトも変わらないこと**を固定する必要がある。
 * 本物の S3 を叩かずに assemble を回すため、`listObjects` / `getObjectText` だけを
 * 決定論のインメモリ実装へ置き換える（esbuild プラグインで `./s3` をこのモジュールへ解決する）。
 *
 * **本番コードからは参照されない。** fixture ランナー専用。
 */

export interface S3PutFile {
  key: string;
  contentType?: string;
  body: string;
  bytes?: number;
}

export interface S3ObjectRef {
  key: string;
  size?: number;
}

/** キー → JSON 本文。ランナーが差し込む。 */
let STORE: Record<string, string> = {};

export function __setStore(store: Record<string, string>): void {
  STORE = store;
}

export async function listObjects(prefix: string): Promise<S3ObjectRef[]> {
  return Object.keys(STORE)
    .filter((k) => k.startsWith(prefix))
    .sort()
    .map((k) => ({ key: k, size: Buffer.byteLength(STORE[k], 'utf8') }));
}

export async function getObjectText(key: string): Promise<string> {
  const v = STORE[key];
  if (v === undefined) throw new Error(`stub: no such key ${key}`);
  return v;
}

/* assemble は使わないが、同一モジュールから import され得るものを型だけ揃えておく。 */
export async function putFiles(): Promise<never[]> { return []; }
export async function copyObjects(): Promise<number> { return 0; }
export async function deleteObjects(): Promise<number> { return 0; }
export function getS3Config(): null { return null; }
export function isS3Configured(): boolean { return false; }
