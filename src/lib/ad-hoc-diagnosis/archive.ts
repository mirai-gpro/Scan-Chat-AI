// src/lib/ad-hoc-diagnosis/archive.ts
// 臨時診断バッチ の ZIP 読み取り層。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §5.1 / §5.3 / §5.3.7.1 / §24.3
//
// **ZIP を触るコードはこのファイルの中だけに置く** (spec §5.3.7-5)。
// ライブラリ (`@zip.js/zip.js`) を差し替えることになっても、外へ漏れないようにするため。
//
// 設計上の要:
//  1. **ZIP 全体をメモリに載せない。** サーバは S3 の Range GET で
//     ①末尾 (EOCD → Central Directory) ②必要なエントリの範囲だけ を読む。
//  2. **presigned GET は使わない** (spec §5.3.7.1・発注者指示)。
//     custom `Reader` の `readUint8Array()` から AWS SDK を直接呼ぶ。
//  3. **ライブラリが守ってくれることを前提にしない。** §24.3 の検査は自分でも行う。
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Reader, ZipReader, Uint8ArrayWriter, configure, type FileEntry } from '@zip.js/zip.js';
import { getS3Config, makeS3Client, type S3Config } from '../s3';

// Web Worker を使わせない。Vercel の Node ランタイムには居ないので、
// 使おうとすると環境差で落ちる (メインスレッドで展開する)。
configure({ useWebWorkers: false });

// ---------------------------------------------------------------------------
// 上限 (spec §5.1)。**マジックナンバーをコード内に散らさない。**
// ---------------------------------------------------------------------------
export const MAX_ZIP_BYTES = 512 * 1024 * 1024; // 512 MB
export const MAX_TOTAL_UNCOMPRESSED = 1_536 * 1024 * 1024; // 1.5 GB
export const MAX_ENTRIES = 2_000;
export const MAX_ENTRY_BYTES = 80 * 1024 * 1024; // 80 MB
export const MAX_DEPTH = 8;

/** 解析対象の拡張子 (spec §5.1)。`.xls` は OLE2 で ZIP/XML でないため含めない。 */
export const ALLOWED_EXTENSIONS = ['.pdf', '.xlsx', '.docx', '.csv'] as const;
export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

/** 弾いた理由。**黙って捨てず、必ずこの理由とともに一覧へ出す** (spec §5.5)。 */
export type RejectReason =
  | 'zip_slip'
  | 'absolute_path'
  | 'symlink'
  | 'password_protected_file'
  | 'unsupported_file'
  | 'too_deep'
  | 'entry_too_large'
  | 'empty_file'
  | 'directory';

export interface ArchiveEntry {
  /** 正規化後のパス (ZIP 内)。**DB には保存しない** — 氏名を含み得るため (spec §6.1 / §8.1)。 */
  path: string;
  /** 拡張子 (小文字・ドット付き)。 */
  ext: string;
  /** Central Directory が申告する展開後サイズ。**実バイト数とは別物** (詐称され得る)。 */
  declaredSize: number;
  /** ディレクトリ階層の深さ (`a/b/c.pdf` = 3)。 */
  depth: number;
  /** 採用しなかった理由。null なら採用。 */
  rejected: RejectReason | null;
}

export interface ArchiveListing {
  entries: ArchiveEntry[];
  /** 採用したエントリだけの合計 (申告値)。 */
  declaredTotal: number;
  /** Central Directory 上の総エントリ数 (ディレクトリ含む)。 */
  rawCount: number;
}

// ---------------------------------------------------------------------------
// S3 Range Reader (spec §5.3.7.1)
// ---------------------------------------------------------------------------

/**
 * `@zip.js/zip.js` の `Reader` を S3 の Range GET へ繋ぐ。
 *
 * **presigned GET は使わない。** 署名付き URL という新しい秘密を増やさず、
 * 既存の資格情報 (`AWS_ACCESS_KEY_ID` ほか) で完結する経路に留める。
 *
 * **ブラウザ側は同じ `ZipReader` に `BlobReader` を渡す。**
 * 差し替わるのはこのクラスだけなので、ZIP の解釈と §24.3 の検査は 1 か所で済む。
 */
export class S3RangeReader extends Reader<string> {
  private cfg: S3Config;
  private key: string;
  /** `init()` で確定させた実サイズ。`HeadObject` の ContentLength。 */
  declare size: number;

  constructor(cfg: S3Config, key: string, knownSize?: number) {
    super(key);
    this.cfg = cfg;
    this.key = key;
    if (typeof knownSize === 'number') this.size = knownSize;
  }

  async init(): Promise<void> {
    if (typeof this.size === 'number' && this.size > 0) return; // 既知なら叩かない
    const client = makeS3Client(this.cfg);
    const head = await client.send(
      new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: this.key }),
    );
    const len = head.ContentLength;
    if (typeof len !== 'number' || len <= 0) {
      throw new Error(`S3RangeReader: ContentLength を取得できない (${this.key})`);
    }
    this.size = len;
  }

  async readUint8Array(offset: number, length: number): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array(0);
    const range = rangeHeaderFor(offset, length);
    const client = makeS3Client(this.cfg);
    const res = await client.send(
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.key, Range: range }),
    );
    if (!res.Body) throw new Error(`S3RangeReader: 本文が空 (${this.key} ${range})`);
    const bytes = await res.Body.transformToByteArray();
    assertExactLength(bytes, length, `${this.key} ${range}`);
    return bytes;
  }
}

/**
 * `readUint8Array(offset, length)` を HTTP の `Range` ヘッダへ変換する。
 *
 * **Range は両端を含む閉区間** — `bytes=0-99` は 100 バイト。
 * 終端に `offset + length` を書くと**要求より 1 バイト多い範囲**を取りに行くことになる。
 *
 * **実測 (2026-09-10)**: 1 バイト多く返しても `@zip.js/zip.js` 側は壊れなかった
 * (要求した長さぶんしか使わないため)。**つまりライブラリは守ってくれない** —
 * 「思っている範囲と実際に取る範囲が静かにずれる」だけになる。
 * だから**ずれを捕まえるのはこちらの責任**で、それが `assertExactLength()`。
 * 純粋関数にしてあるのは、この算術を検証で直接固定するため。
 */
export function rangeHeaderFor(offset: number, length: number): string {
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`不正な offset: ${offset}`);
  if (!Number.isInteger(length) || length <= 0) throw new Error(`不正な length: ${length}`);
  return `bytes=${offset}-${offset + length - 1}`;
}

/**
 * 返ってきたバイト数が要求とちょうど同じか。
 *
 * **短くても長くても投げる。**
 *  - 短い → ZIP パーサが壊れた構造として誤解釈する。
 *  - 長い → 要求と違う範囲を読んでいる証拠 (上の閉区間の取り違えなど)。
 *    ライブラリは黙って受け入れてしまうので、**ここで止めないと誰も気づかない**。
 */
export function assertExactLength(bytes: Uint8Array, expected: number, where: string): void {
  if (bytes.length !== expected) {
    throw new Error(
      `S3RangeReader: 要求 ${expected} バイトに対し ${bytes.length} バイト返った (${where})`,
    );
  }
}

// ---------------------------------------------------------------------------
// ファイル名の文字コード (spec §5.4 / §5.3.9-1)
// ---------------------------------------------------------------------------

/**
 * ZIP のファイル名に UTF-8 フラグが立っていないときに使う文字コードを 1 つ選ぶ。
 *
 * **`'cp932'` は WHATWG Encoding Standard のラベルではない。**
 * `new TextDecoder('cp932')` は **`ERR_ENCODING_NOT_SUPPORTED` を投げる** (実測 Node v22.22.2)。
 * しかも zip.js は `getEntries()` の中で decode するので、
 * **投げた瞬間に ZIP を開くこと自体が失敗する** (文字化けで済まない)。
 *
 * 実測 (同環境・full-icu):
 *   OK   `shift_jis` / `windows-31j` / `ms932` / `sjis` / `x-sjis`  → いずれも `shift_jis` に解決
 *   NG   `cp932` / `cp437`
 *
 * WHATWG の `shift_jis` デコーダは Windows-31J (= CP932) の割り当てを含むので、
 * **`shift_jis` を選べば目的は果たせる**。
 *
 * **候補を順に試し、どれも作れなければ `undefined` を返す** (= ライブラリ既定に委ねる)。
 * こうしておけば、ICU の入っていない実行環境でも**開けなくなることはない**
 * (ファイル名は化けるが、パスは DB に保存しないので納品には影響しない・spec §6.1)。
 */
export function pickFilenameEncoding(): string | undefined {
  for (const label of ['shift_jis', 'windows-31j', 'ms932']) {
    try {
      new TextDecoder(label);
      return label;
    } catch {
      /* この環境では使えない。次の候補へ */
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// エントリの検査 (spec §24.3)
// ---------------------------------------------------------------------------

/** ZIP のパスを正規化する。区切りを `/` に統一し、`.` を畳む。`..` は畳まない (検出するため)。 */
export function normalizeZipPath(raw: string): string {
  return raw.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.').join('/');
}

/** 絶対パス (Unix の `/` 始まり・Windows のドライブレター・UNC) か。 */
export function isAbsoluteZipPath(raw: string): boolean {
  const p = raw.replace(/\\/g, '/');
  return p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.startsWith('//');
}

/** 拡張子 (小文字・ドット付き)。無ければ空文字。 */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

/** ZIP の外部属性 (Unix モード) が symlink を示すか。上位 16bit の `S_IFLNK` (0o120000)。 */
export function isSymlinkAttributes(externalFileAttributes: number | undefined): boolean {
  if (typeof externalFileAttributes !== 'number') return false;
  const unixMode = (externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0xf000) === 0xa000; // S_IFLNK
}

/** 1 エントリを検査して採否を決める。**判定はここ 1 か所**。 */
export function inspectEntry(input: {
  filename: string;
  directory: boolean;
  uncompressedSize: number;
  encrypted: boolean;
  externalFileAttributes?: number;
}): ArchiveEntry {
  const rawPath = input.filename;
  const path = normalizeZipPath(rawPath);
  const ext = extensionOf(path);
  const depth = path === '' ? 0 : path.split('/').length;
  const base: Omit<ArchiveEntry, 'rejected'> = {
    path,
    ext,
    declaredSize: input.uncompressedSize,
    depth,
  };
  const reject = (r: RejectReason): ArchiveEntry => ({ ...base, rejected: r });

  // 順序に意味がある: **危険なものを先に落とす**。
  if (isAbsoluteZipPath(rawPath)) return reject('absolute_path');
  if (rawPath.replace(/\\/g, '/').split('/').includes('..')) return reject('zip_slip');
  if (isSymlinkAttributes(input.externalFileAttributes)) return reject('symlink');
  if (input.directory) return reject('directory');
  if (input.encrypted) return reject('password_protected_file');
  if (depth > MAX_DEPTH) return reject('too_deep');
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) return reject('unsupported_file');
  if (input.uncompressedSize > MAX_ENTRY_BYTES) return reject('entry_too_large');
  if (input.uncompressedSize === 0) return reject('empty_file');

  return { ...base, rejected: null };
}

// ---------------------------------------------------------------------------
// マジックバイト (spec §24.3「拡張子だけで信じない」)
// ---------------------------------------------------------------------------

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

/**
 * 先頭バイトが拡張子と矛盾しないか。
 * **矛盾したら採用しない** (拡張子を付け替えただけのファイルを通さない)。
 *
 * `.xlsx` / `.docx` は ZIP なので `PK\x03\x04` までしか見ない。
 * 「`[Content_Types].xml` を含むか」は中身を開かないと分からないので、
 * **XLSX を実際に読む側 (`health-checkup-xlsx.ts`) の失敗として扱う**
 * (ここで開くと ZIP の中で ZIP を開くことになりメモリ方針に反する)。
 */
export function magicMatchesExtension(ext: string, head: Uint8Array): boolean {
  switch (ext) {
    case '.pdf':
      return startsWith(head, PDF_MAGIC);
    case '.xlsx':
    case '.docx':
      return startsWith(head, ZIP_MAGIC);
    case '.csv':
      return true; // CSV にマジックバイトは無い (BOM の有無も自由)
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// 一覧の取得と 1 エントリの読み出し
// ---------------------------------------------------------------------------

export interface OpenedArchive {
  listing: ArchiveListing;
  /** 採用したエントリの中身を読む。**1 件ずつ呼び、使い終わったら参照を捨てる。** */
  read(path: string): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * ZIP を開いて Central Directory だけを読む。**中身はまだ読まない。**
 *
 * @param reader `S3RangeReader` (サーバ) か `BlobReader` (ブラウザ)。
 */
export async function openArchive(reader: Reader<unknown>): Promise<OpenedArchive> {
  // ファイル名の文字コード。UTF-8 フラグが立っていないときだけ効く (spec §5.4)。
  // **使えないラベルを渡すと ZIP を開くこと自体が失敗する**ので、必ず probe を通す。
  const filenameEncoding = pickFilenameEncoding();
  const zip = new ZipReader(reader as never, {
    ...(filenameEncoding ? { filenameEncoding } : {}),
  });
  const raw = await zip.getEntries();

  if (raw.length > MAX_ENTRIES) {
    await zip.close();
    throw new Error(`ZIP のエントリ数が上限を超えている (${raw.length} > ${MAX_ENTRIES})`);
  }

  const entries: ArchiveEntry[] = raw.map((e) =>
    inspectEntry({
      filename: e.filename,
      directory: e.directory,
      uncompressedSize: Number(e.uncompressedSize ?? 0),
      encrypted: Boolean(e.encrypted),
      externalFileAttributes: e.externalFileAttributes,
    }),
  );

  // **展開前に、申告値の合計で判定する** (spec §24.3)。
  const declaredTotal = entries
    .filter((e) => e.rejected === null)
    .reduce((sum, e) => sum + e.declaredSize, 0);
  if (declaredTotal > MAX_TOTAL_UNCOMPRESSED) {
    await zip.close();
    throw new Error(
      `展開後の総容量が上限を超えている (${declaredTotal} > ${MAX_TOTAL_UNCOMPRESSED})`,
    );
  }

  // `Entry` は `directory` で判別される union なので、**ファイルだけを地図に入れる**
  // (`getData` は `FileEntry` にしか無い)。`inspectEntry` はディレクトリを既に弾いている。
  const byPath = new Map<string, FileEntry>();
  raw.forEach((e, i) => {
    const insp = entries[i];
    if (insp.rejected === null && !e.directory) byPath.set(insp.path, e);
  });

  return {
    listing: { entries, declaredTotal, rawCount: raw.length },
    async read(path: string): Promise<Uint8Array> {
      const e = byPath.get(path);
      if (!e) throw new Error(`ZIP に該当エントリが無い: ${path}`);
      const bytes = await e.getData(new Uint8ArrayWriter());
      // **展開中も実バイト数で判定する** (申告値の詐称対策・spec §24.3)。
      if (bytes.length > MAX_ENTRY_BYTES) {
        throw new Error(`エントリの実サイズが上限を超えている: ${path} (${bytes.length})`);
      }
      const declared = Number(e.uncompressedSize ?? 0);
      if (bytes.length !== declared) {
        throw new Error(
          `エントリの実サイズが申告値と違う: ${path} (申告 ${declared} / 実 ${bytes.length})`,
        );
      }
      return bytes;
    },
    async close() {
      await zip.close();
    },
  };
}

/** S3 に置かれた ZIP を開く (サーバ側の入口)。 */
export async function openArchiveFromS3(input: {
  key: string;
  knownSize?: number;
  cfg?: S3Config | null;
}): Promise<OpenedArchive> {
  const cfg = input.cfg ?? getS3Config();
  if (!cfg) throw new Error('S3 が未設定 (AWS_REGION)');
  const reader = new S3RangeReader(cfg, input.key, input.knownSize);
  await reader.init();
  if (reader.size > MAX_ZIP_BYTES) {
    throw new Error(`ZIP のサイズが上限を超えている (${reader.size} > ${MAX_ZIP_BYTES})`);
  }
  return openArchive(reader as unknown as Reader<unknown>);
}
