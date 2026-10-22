/**
 * **画面の中で**1 次元バーコードをデコードする (LLM もサーバも使わない)。
 *
 * 正本: `docs/lab/kit_receipt_external_id_capture_spec.md` §12.4 の **案 A**
 * (発注者指示 2026-10-22)。
 *
 * 【これは表示のためだけ】**登録される値はサーバが読んだものだけ**
 * (仕様 §12.2 = 発注者判断 案 (c))。ここで読めた値は
 *   - 画面に**すぐ**出す (撮ってから 1 秒以内に番号が見える)
 *   - 登録時に `confirmedValue` として送り、**サーバの値と食い違えば 409** になる
 * の 2 つにしか使わない。**画面の自己申告を値の出どころにしない。**
 *
 * 【2 段構え】
 *   ① `BarcodeDetector` (ブラウザ内蔵・**ダウンロード 0 バイト**)
 *      → Android Chrome / Samsung で使える。**iOS Safari は 17.0〜27.2 まで
 *        "Disabled by default"** (caniuse) なので**これだけでは成立しない**。
 *   ② `@undecaf/zbar-wasm` (gzip 176KB の wasm を**この画面を開いたときだけ**取る)
 *      → iPhone もこちらで読める。
 * **①が使えるかは `getSupportedFormats()` で確かめる** — Codabar を持たない
 * 実装で空振りさせると②へ落ちるまで無駄に時間がかかる。
 *
 * 【QR は読まない・返さない】サーバ側 (`src/lib/barcode-decode.ts`) と同じ規則。
 * QR の値を候補に混ぜると**別の番号を本番の相関キーにしてしまう** (仕様 §2.1)。
 * **ライブラリが別で名前も別**なので、**両方の allow-list を検査で見張る**。
 *
 * 【例外を投げない】読めなければ `value: null`。**画面は従来どおりサーバの応答を待つ**
 * だけで、何も壊れない。
 */

// Vite が wasm を資産として出し、ハッシュ付き URL をくれる (キャッシュも効く)。
import zbarWasmUrl from '@undecaf/zbar-wasm/dist/zbar.wasm?url';

/**
 * `BarcodeDetector` の format 名のうち**採ってよい 1 次元**だけ。**2 次元は入れない。**
 * **検査が実物を見られるように export する** (`verify:external-id-capture` ⑲)。
 */
export const NATIVE_1D = [
  'codabar', 'code_39', 'code_93', 'code_128', 'itf', 'ean_8', 'ean_13', 'upc_a', 'upc_e',
] as const;

/**
 * zbar の `typeName` 側。`src/lib/barcode-decode.ts` の `ALLOWED_1D` と**同じ集合**。
 * **ライブラリが別なので共有できない** — だから**両方が同じであることを検査で見張る**。
 */
export const ZBAR_1D = new Set([
  'ZBAR_CODABAR', 'ZBAR_CODE39', 'ZBAR_CODE93', 'ZBAR_CODE128',
  'ZBAR_I25', 'ZBAR_EAN8', 'ZBAR_EAN13', 'ZBAR_UPCA', 'ZBAR_UPCE',
]);

export interface BrowserDecodeResult {
  /** 生値 (start/stop 文字を含む)。**正規化は呼び出し側** (`normalizeExternalId`)。 */
  value: string | null;
  /** 読めた symbology。監査・切り分け用。 */
  format: string | null;
  /** どちらで読めたか。 */
  source: 'native' | 'wasm' | null;
  ms: number;
  error?: 'no_symbol' | 'multiple' | 'unavailable' | 'failed';
}

interface Detected { value: string; format: string }

/** 複数の 1 次元が食い違ったら**選ばない** (サーバ側と同じ判断・捏造ゼロ)。 */
function pick(found: Detected[]): { value: string | null; format: string | null; error?: 'no_symbol' | 'multiple' } {
  if (found.length === 0) return { value: null, format: null, error: 'no_symbol' };
  const distinct = new Set(found.map((f) => f.value));
  if (distinct.size > 1) return { value: null, format: null, error: 'multiple' };
  return { value: found[0].value, format: found[0].format };
}

/** 撮った 1 枚を canvas に載せる (①②とも同じ 1 枚を見る)。 */
async function toCanvas(blob: Blob): Promise<HTMLCanvasElement | null> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('image load failed'));
      el.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return canvas;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

type DetectorCtor = new (opts?: { formats?: string[] }) => { detect: (src: CanvasImageSource) => Promise<Array<{ rawValue?: string; format?: string }>> };

/** ① ブラウザ内蔵。**Codabar を持たない実装では使わない**。 */
async function nativeDetect(canvas: HTMLCanvasElement): Promise<Detected[] | null> {
  const g = window as unknown as {
    BarcodeDetector?: DetectorCtor & { getSupportedFormats?: () => Promise<string[]> };
  };
  const Ctor = g.BarcodeDetector;
  if (!Ctor || typeof Ctor.getSupportedFormats !== 'function') return null;
  let supported: string[];
  try {
    supported = await Ctor.getSupportedFormats();
  } catch {
    return null;
  }
  if (!supported.includes('codabar')) return null;
  const formats = NATIVE_1D.filter((f) => supported.includes(f));
  if (formats.length === 0) return null;
  try {
    const det = new Ctor({ formats: [...formats] });
    const list = await det.detect(canvas);
    const out: Detected[] = [];
    for (const b of list) {
      const fmt = String(b.format ?? '');
      // **2 次元は 1 件も通さない** (formats で絞ってはいるが二重に止める)
      if (!(NATIVE_1D as readonly string[]).includes(fmt)) continue;
      const v = String(b.rawValue ?? '').trim();
      if (v) out.push({ value: v, format: fmt });
    }
    return out;
  } catch {
    return null;
  }
}

/** ② wasm。**この画面を開いたときだけ**読み込む (遅延 import)。 */
async function wasmDecode(canvas: HTMLCanvasElement): Promise<Detected[] | null> {
  try {
    const zbar = await import('@undecaf/zbar-wasm');
    /*
     * **wasm の在処を明示する。** bundler が glue を別の場所へ束ねるので、
     * 既定の「glue の隣」では見つからない。`?url` で出した資産を指す。
     */
    zbar.setModuleArgs({ locateFile: () => zbarWasmUrl });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const symbols = await zbar.scanImageData(data);
    const out: Detected[] = [];
    for (const s of symbols) {
      const name = String(s.typeName ?? '');
      if (!ZBAR_1D.has(name)) continue;
      let text = '';
      try {
        text = s.decode();
      } catch {
        continue;
      }
      const t = text.trim();
      if (t) out.push({ value: t, format: name });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 撮った 1 枚をその場で読む。**投げない。**
 *
 * ① で 1 件でも読めたらそれを返す。① が使えない / 何も読めなかったら ② を試す
 * (「使えない」と「読めなかった」を区別しないのは、**どちらでも②が正解**だから)。
 */
export async function decodeBarcodeInBrowser(blob: Blob): Promise<BrowserDecodeResult> {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  const canvas = await toCanvas(blob);
  if (!canvas) return { value: null, format: null, source: null, ms: ms(), error: 'unavailable' };

  const native = await nativeDetect(canvas);
  if (native && native.length > 0) {
    const r = pick(native);
    return { ...r, source: 'native', ms: ms() };
  }
  const wasm = await wasmDecode(canvas);
  if (wasm) {
    const r = pick(wasm);
    return { ...r, source: 'wasm', ms: ms() };
  }
  return { value: null, format: null, source: null, ms: ms(), error: 'unavailable' };
}
