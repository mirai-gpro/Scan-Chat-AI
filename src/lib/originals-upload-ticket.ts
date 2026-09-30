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
 *
 * 【Object Lock バケットは checksum が要る (2026-09-29・実障害)】
 *   原本バケット `wellfort-diagnosis` は **Object Lock + GOVERNANCE 保持**が有効。
 *   保持対象への `PutObject` は **Content-MD5 か checksum ヘッダが必須**で、
 *   どちらも無い PUT は **HTTP 400** になる。
 *
 *   スキャン側 (`scan-upload-ticket.ts`) は Object Lock の無いバケット向けに
 *   `requestChecksumCalculation: 'WHEN_REQUIRED'` で checksum を**外して**いた
 *   (既定だと SDK が**空ボディの** CRC32 を署名に載せ、実ファイルを PUT した瞬間に
 *   S3 が拒否するため)。原本バケットでそれを踏襲したのが 400 の原因。
 *
 *   → **外すのでなく、正しい値を載せる。** ブラウザがファイルの SHA-256 を計算して
 *   base64 で渡し、`ChecksumSHA256` として署名に固定する。
 *   空ボディの CRC32 が載る問題は `WHEN_REQUIRED` のまま回避しつつ、
 *   明示した SHA-256 だけが署名に入る。
 *   **ブラウザは署名された checksum ヘッダをそのまま送る** (1 バイトでも違えば S3 が拒否)。
 */
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getOriginalsS3Config, sha256Hex, type OriginalsS3Config } from './originals-storage';
import { isAdditionalOriginalKey } from './additional-originals';

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

/** SHA-256 を base64 にしたもの (32 バイト → 44 文字・末尾 '=')。 */
const SHA256_B64_RE = /^[A-Za-z0-9+/]{43}=$/;
export function isSha256Base64(v: unknown): v is string {
  return typeof v === 'string' && SHA256_B64_RE.test(v);
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
  | { ok: true; url: string; key: string; storageUrl: string; expiresIn: number; headers: Record<string, string>; signedHeaders: string }
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
  /**
   * ファイル本体の SHA-256 (base64)。**Object Lock バケットでは必須。**
   * ブラウザが `crypto.subtle.digest('SHA-256', file)` で計算して渡す。
   */
  sha256Base64: unknown;
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

  if (!isSha256Base64(input.sha256Base64)) {
    return {
      ok: false,
      error: 'invalid_sha256',
      detail: 'ファイルの SHA-256 (base64・44 文字) が要ります。Object Lock バケットは checksum 無しの PUT を 400 で拒否します。',
    };
  }
  const bytes = typeof input.bytes === 'number' ? Math.trunc(input.bytes) : NaN;
  if (!Number.isFinite(bytes) || bytes <= 0) return { ok: false, error: 'invalid_size' };
  if (bytes > MAX_ORIGINAL_BYTES) {
    return { ok: false, error: 'too_large', detail: `${MAX_ORIGINAL_BYTES / 1024 / 1024} MB 以下にしてください` };
  }

  const key = buildOriginalKey(company as OriginalCompany, name);
  // サーバが組んだキーでも、署名の直前にもう一度検査する (組み立ての誤りを通さない)。
  if (!isOriginalUploadKey(key)) return { ok: false, error: 'invalid_key', detail: key };

  return signOriginalPut({ cfg, key, contentType, bytes, sha256Base64: input.sha256Base64 });
}

/**
 * **署名の本体。キーの組み立て方が違っても、署名だけはここ 1 か所を通す。**
 *
 * 【切り出した理由 (2026-09-30)】追加検査 (`additional-originals.ts`) は
 * **別の形のキー**を使うが、Object Lock バケットの checksum 要件と
 * `unhoistableHeaders` の罠は**まったく同じ**。写すと片方だけ直る事故になるので、
 * キーを引数で受ける形にして共用する (仕様書 §17「独自実装しない」)。
 *
 * **中身は 1 行も変えていない** — 呼び出し側が `key` を決めるようになっただけ。
 */
export async function signOriginalPut(input: {
  cfg: OriginalsS3Config;
  /** バケット prefix を**まだ付けていない**キー。呼び出し側が検証済みであること。 */
  key: string;
  contentType: string;
  bytes: number;
  sha256Base64: string;
}): Promise<TicketResult> {
  const { cfg, key, contentType, bytes } = input;
  const fullKey = `${cfg.prefix}${key}`.replace(/\/{2,}/g, '/');
  /*
   * `WHEN_REQUIRED` のままにするのは、**空ボディの CRC32 を勝手に載せさせない**ため。
   * 実体の SHA-256 は下で明示するので、署名に入る checksum はこれだけになる。
   */
  const url = await getSignedUrl(
    client(cfg, { requestChecksumCalculation: 'WHEN_REQUIRED' }),
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: fullKey,
      ContentType: contentType,
      ContentLength: bytes, // 署名に固定 → サイズ超過の差し替えを S3 が拒否する
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: input.sha256Base64, // Object Lock が要求する完全性チェック
    }),
    {
      expiresIn: PRESIGN_EXPIRES_SEC,
      /*
       * **`unhoistableHeaders` が無いと checksum が署名に入らない (実測)。**
       * presigner は既定で `x-amz-*` をクエリへ hoist しようとし、
       * flexible-checksums の中間層も presign では働かないため、
       * `signableHeaders` だけ指定しても `SignedHeaders` は
       * `content-length;content-type;host` のままになる。
       * → ヘッダのまま残すよう明示してから署名対象に入れる。
       *   実測: `content-length;content-type;host;x-amz-checksum-sha256;x-amz-sdk-checksum-algorithm`
       */
      unhoistableHeaders: new Set(['x-amz-checksum-sha256', 'x-amz-sdk-checksum-algorithm']),
      signableHeaders: new Set(['content-type', 'x-amz-checksum-sha256', 'x-amz-sdk-checksum-algorithm']),
    },
  );

  /*
   * **ブラウザはこの 3 つをそのまま送る。** 署名に含めたヘッダと 1 バイトでも
   * 違えば S3 が拒否するので、画面側で組み立て直さないこと。
   * (`X-Amz-SignedHeaders` に載っているものと一致している必要がある)
   */
  const signed = new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '';
  const headers: Record<string, string> = { 'content-type': contentType };
  if (signed.includes('x-amz-checksum-sha256')) headers['x-amz-checksum-sha256'] = input.sha256Base64;
  if (signed.includes('x-amz-sdk-checksum-algorithm')) headers['x-amz-sdk-checksum-algorithm'] = 'SHA256';

  return {
    ok: true,
    url,
    key,
    storageUrl: `s3://${cfg.bucket}/${fullKey}`,
    expiresIn: PRESIGN_EXPIRES_SEC,
    headers,
    signedHeaders: signed,
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
  /*
   * **読み出しを許すキーの形は 2 つだけ**（2026-09-30 に追加検査ぶんを足した）。
   *   ① `lab_results/<company>/YYYY/MM/<filename>`            … 既存
   *   ② `additional_results/<uid>/<test_type>/<YYYY_MM_DD>/<sha256>.pdf` … 追加検査（§16）
   * **どちらも完全一致**で見る。ここを緩めると admin キー 1 本で原本バケットの
   * 任意のオブジェクト（他人の原本・納品物）を読ませる口になる。
   */
  if (!isOriginalUploadKey(key) && !isAdditionalOriginalKey(key)) {
    return { ok: false, error: 'invalid_key' };
  }

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
