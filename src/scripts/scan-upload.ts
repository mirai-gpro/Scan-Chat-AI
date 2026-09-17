/**
 * アップロードされた検査票ファイルを /api/scan へ載せられる形 (data URL) に整える。
 *
 * 【なぜ「受け付ける上限」と「送れる上限」が別なのか】
 * /api/scan へは data URL を JSON の body に入れて POST する
 * (`camera-scan.ts` の `analyzeDataUrl`)。ファイルは base64 になって 4/3 倍に膨らむ。
 * 一方 **Vercel Functions のリクエストボディ上限は 4.5 MB** で、超えると
 * 関数に届く前に 413 `FUNCTION_PAYLOAD_TOO_LARGE` で弾かれる
 * (出典: vercel.com/docs/functions/limitations「Request body size」・2026-08-24 版)。
 * → 4 MB のファイルは base64 で約 5.3 MB になり、**そのままでは既に上限超え**だった。
 *
 * そこで
 *   - 受け付ける上限 = `MAX_INPUT_BYTES` (40 MB・発注者指示 2026-09-17)
 *   - 実際に送れる元データ = `WIRE_BUDGET_BYTES` (4.5 MB から逆算)
 * と分け、超えた画像はブラウザ側で再エンコード / 縮小して予算内へ収める。
 *
 * PDF はブラウザで縮小できないので、予算を超えたら送らずにその旨を伝える
 * (黙って 413 にしない)。HEIC はデコーダを持つブラウザ (Safari) でだけ縮小できる。
 */

/**
 * 受け付けるファイルの上限 (発注者指示: 4 MB → 10 MB → **40 MB** 2026-09-17)。
 *
 * **10 MB だった根拠はもう無い。** あれは Vercel のリクエストボディ 4.5 MB 制限が
 * 前提で、その中に収まるよう縮小して送っていたため。いまは**ブラウザ → S3 直 PUT**
 * があり、**ファイル本体は関数を通らない**ので上限に縛られない
 * (`prepareScanUpload` の経路②)。複数年の人間ドックは 10 MB では詰まる。
 *
 * **S3 が使えない回はここまで通らない** — 画像は `WIRE_BUDGET_BYTES` まで縮小し、
 * **PDF は縮小できないので理由を出して止める** (黙って 413 にしない)。
 * つまり 40 MB は「S3 が効いているときに通る上限」で、経路③ の保険は変わらない。
 */
export const MAX_INPUT_BYTES = 40 * 1024 * 1024;

/** Vercel Functions のリクエストボディ上限。10 進の 4.5 MB として保守側に取る。 */
const VERCEL_BODY_LIMIT = 4_500_000;

/** JSON の外枠 (`{"image":"…","hint":"…"}`) と hint 本文の余裕 (UTF-8)。 */
const BODY_OVERHEAD = 16_000;

/** data URL の長さの上限。base64 と接頭辞は ASCII なので 1 文字 = 1 バイト。 */
const MAX_DATA_URL_CHARS = VERCEL_BODY_LIMIT - BODY_OVERHEAD;

/**
 * 無変換で送れる「元ファイル」のバイト数。
 * base64 は `ceil(n/3)*4` に膨らむので、そこから逆算する (64 は data URL の接頭辞)。
 * 実測値ではなく上の 2 定数からの導出なので、上限が変わればここも追従する。
 */
export const WIRE_BUDGET_BYTES = Math.floor((MAX_DATA_URL_CHARS - 64) / 4) * 3;

/**
 * 縮小の段階。1 段目で収まればそこで止める (無駄に画質を落とさない)。
 * 2 段目の 2400 / 0.92 は**カメラ撮影と同じ条件** (`camera-scan.ts` の
 * `grabFrameDataUrl({ maxEdge: 2400, quality: 0.92 })`) なので、
 * アップロード経路がカメラ経路より粗くなることはない。
 *
 * 1 段目を無制限にしないのは、iOS Safari の canvas に面積上限があり、
 * 巨大な画像だと `toDataURL` が空 (`data:,`) を返すため。4096 なら 4:3 で
 * 約 12.6 メガピクセルに収まる。
 */
const LADDER: readonly { maxEdge: number; quality: number }[] = [
  { maxEdge: 4096, quality: 0.92 },
  { maxEdge: 2400, quality: 0.92 },
  { maxEdge: 2400, quality: 0.85 },
  { maxEdge: 2000, quality: 0.85 },
  { maxEdge: 1600, quality: 0.8 },
];

export interface PreparedUpload {
  /** Gemini へ渡す元データ。S3 経由のときは undefined。 */
  dataUrl?: string;
  /** S3 へ直接置いたときのキー。`/api/scan` にはこちらを渡す。 */
  imageKey?: string;
  /** 画面プレビュー専用 (S3 経由のときだけ)。**解析には使わない**。 */
  previewDataUrl?: string;
  /** PDF はプレビューを作れないので、表示側が分岐できるようにする。 */
  kind: 'pdf' | 'image';
  /** 縮小・再エンコードしたときだけ入る。無変換なら undefined。 */
  note?: string;
}

/** 画面にそのまま出してよい日本語メッセージを持つエラー。 */
export class UploadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadTooLargeError';
  }
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export async function prepareScanUpload(file: File): Promise<PreparedUpload> {
  const kind: 'pdf' | 'image' = file.type === 'application/pdf' ? 'pdf' : 'image';

  if (file.size > MAX_INPUT_BYTES) {
    throw new UploadTooLargeError(
      `ファイルサイズが大きすぎます (${mb(file.size)})。${mb(MAX_INPUT_BYTES)} 以下にしてください。`,
    );
  }

  /*
   * ── 予算内 ──────────────────────────────────────────────────────
   * **従来どおり dataUrl も持つ**（表示がこれに乗っているので画面は 1 px も変わらない）。
   * 加えて **S3 にも置く**。バックグラウンド処理は送信後にサーバが読み直すので、
   * **全ページに S3 のキーが要る**（`docs/scan/スキャン非同期処理_仕様書.md` §3.1）。
   *
   * **S3 が落ちても投げない。** キーが無い回は送信時に前景処理へ落ちるだけで、
   * 読み取り自体は今までどおり成立する（待たされるが失敗はしない）。
   */
  if (file.size <= WIRE_BUDGET_BYTES) {
    const dataUrl = await readFileAsDataUrl(file);
    const smallKey = await uploadViaS3(file);
    return { dataUrl, imageKey: smallKey ?? undefined, kind };
  }

  // ── 予算超え。まず S3 直アップロードを試す (無劣化で送れる) ──
  const key = await uploadViaS3(file);
  if (key) {
    // プレビュー (bbox 重ね表示) 用に縮小版だけ作る。解析には使わない。
    const previewDataUrl = kind === 'image' ? await makePreview(file) : undefined;
    return { imageKey: key, previewDataUrl, kind };
  }

  // ── S3 が使えなかった。画像なら縮小して従来経路で送る ──
  if (kind === 'pdf') {
    throw new UploadTooLargeError(
      `PDF は ${mb(WIRE_BUDGET_BYTES)} までしか送信できません (このファイルは ${mb(file.size)})。` +
        `ページを分けて保存し直すか、紙面を写真 (JPEG) で撮ったものをお使いください。`,
    );
  }

  const bitmap = await decodeImage(file);
  if (!bitmap) {
    throw new UploadTooLargeError(
      `このファイルは ${mb(WIRE_BUDGET_BYTES)} を超えており (${mb(file.size)})、` +
        `お使いのブラウザでは縮小できませんでした。JPEG または PNG で保存し直してください。`,
    );
  }

  try {
    for (const step of LADDER) {
      const dataUrl = encodeJpeg(bitmap, step.maxEdge, step.quality);
      if (dataUrl && dataUrl.length <= MAX_DATA_URL_CHARS) {
        return { dataUrl, kind, note: `${mb(file.size)} の画像を送信用に圧縮しました` };
      }
    }
  } finally {
    bitmap.close();
  }

  throw new UploadTooLargeError(
    `画像を縮小しても送信できる大きさ (${mb(WIRE_BUDGET_BYTES)} 相当) に収まりませんでした。` +
      `紙面を分けて撮影してください。`,
  );
}

/**
 * **撮影した 1 枚を S3 へ置く。** カメラ経路は `File` を持たない（canvas の data URL）ので、
 * ここで Blob に直してから**アップロードと同じ presigned PUT に載せる**
 * (`docs/scan/スキャン非同期処理_仕様書.md` §3.1「カメラ撮影も S3 へ」)。
 *
 * **新しい置き場を作らない** — キーの形も検査 (`isScanUploadKey`) も既存のまま。
 * **失敗しても投げない**（null を返す）。キーが無い回は送信時に前景処理へ落ちるだけ。
 */
export async function uploadDataUrlToS3(dataUrl: string): Promise<string | null> {
  try {
    const m = /^data:([^;,]+)[^,]*,/.exec(dataUrl);
    if (!m) return null;
    const blob = await (await fetch(dataUrl)).blob();
    // 署名は Content-Type と ContentLength を固定するので、実体と食い違わせない。
    const file = new File([blob], 'shot.jpg', { type: m[1] || blob.type });
    return await uploadViaS3(file);
  } catch {
    return null;
  }
}

/**
 * presigned PUT でブラウザから S3 へ直接置く。成功でキー、駄目なら null。
 *
 * **失敗しても投げない** — S3 未設定・バケットの CORS 未設定・回線断など、
 * こちらで判別しきれない理由で落ちうる。null を返して呼び出し側の圧縮経路へ譲る
 * (画像は必ず送れる状態を保つ = fail-safe)。
 */
async function uploadViaS3(file: File): Promise<string | null> {
  try {
    const res = await fetch('/api/scan/upload-ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentType: file.type, bytes: file.size }),
    });
    if (!res.ok) return null;
    const t = (await res.json()) as { ok?: boolean; upload_url?: string; key?: string; headers?: Record<string, string> };
    if (!t.ok || !t.upload_url || !t.key) return null;

    // 署名は Content-Type と ContentLength を固定しているので、ここを変えると S3 が拒否する。
    const put = await fetch(t.upload_url, { method: 'PUT', headers: t.headers ?? {}, body: file });
    return put.ok ? t.key : null;
  } catch {
    return null;
  }
}

/** 表示専用の縮小版。解析には使わないので画質より確実さを優先する。 */
async function makePreview(file: File): Promise<string | undefined> {
  const bitmap = await decodeImage(file);
  if (!bitmap) return undefined;
  try {
    return encodeJpeg(bitmap, 2000, 0.85) ?? undefined;
  } finally {
    bitmap.close();
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
    fr.readAsDataURL(file);
  });
}

/** HEIC などデコーダを持たないブラウザでは失敗するので、その場合は null を返す。 */
async function decodeImage(file: File): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file);
  } catch {
    return null;
  }
}

/** 失敗 (canvas 取得不可 / iOS の面積上限で空が返る) は null。 */
function encodeJpeg(bmp: ImageBitmap, maxEdge: number, quality: number): string | null {
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // 透過 PNG をそのまま JPEG にすると透過部が黒くなる。検査票の地は白なので白で埋める。
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return dataUrl.startsWith('data:image/jpeg;base64,') ? dataUrl : null;
}
