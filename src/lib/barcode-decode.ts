/**
 * 撮影画像から **1 次元バーコードを決定論でデコードする** (LLM を使わない)。
 *
 * 正本: `docs/lab/kit_receipt_external_id_capture_spec.md` §12.4
 * (発注者指示 2026-10-22「LLM 使わない案」= 案 A ＋ 案 C)。
 *
 * 【なぜ足したか】`§12.3` で思考を最小にして 30 秒 → 15 秒になったが、**まだ長い**。
 * 読み取るのは**バーコード 1 本と数字 1 つ**で、バーコードの方は
 * **symbology のデコード = 決定論**で読める。実測 (この環境・合成画像):
 *   - `@undecaf/zbar-wasm` が Codabar `A704000123A` を **30〜233ms** で返す
 *     (初回は wasm の初期化を含む)。転送量は wasm 238KB / gzip 176KB。
 *   - 比較した `zxing-wasm` は同じ結果で gzip 401KB。**小さい方を採った。**
 * **実写 (ブレ・反射・斜め) での読み取り率は未確認** — だから
 * **読めなかったら黙って Gemini へ譲る** (この関数は何も壊さない)。
 *
 * 【QR は読まない・返さない】
 * プリベントの同梱書面には QR も印字されているが、要るのは**1 次元バーコードと印字ID**。
 * QR の値を候補に混ぜると**別の番号を本番の相関キーにしてしまう** (仕様 §2.1 / §5.1)。
 * zbar は QR も読むので、**1 次元の allow-list で絞り、2 次元は 1 件も通さない**。
 * 画面側の実装 (`src/scripts/external-id-barcode.ts`) にも同じ規則が要る
 * (ライブラリが別なので名前が違う。**両方を検査で見張る**)。
 *
 * 【例外を投げない】
 * sharp も wasm も**遅延 import ＋ 全 try/catch** (`elith-export.ts` の
 * `rowCropLeakRescue` と同じ流儀)。**Vercel で wasm を読めなかった回も
 * 今日までと同じ挙動 (= Gemini だけ) に戻るだけ**で、読み取りは止まらない。
 */

/** `elith-export.ts:1036` と同じ遅延 import (型もそこに揃える)。 */
const loadSharp = async () => (await import('sharp')).default;

/**
 * zbar が返す `typeName` のうち**採ってよい 1 次元**だけ。**2 次元 (QR/PDF417/SQ) は入れない。**
 * **検査が実物を見られるように export する** (`verify:external-id-capture` ⑲)。
 */
export const ALLOWED_1D = new Set([
  'ZBAR_CODABAR', 'ZBAR_CODE39', 'ZBAR_CODE93', 'ZBAR_CODE128',
  'ZBAR_I25', 'ZBAR_EAN8', 'ZBAR_EAN13', 'ZBAR_UPCA', 'ZBAR_UPCE',
]);

export interface BarcodeDecodeResult {
  /** デコードできた文字列 (start/stop 文字を含む生値。**正規化しない**)。 */
  value: string | null;
  /** 読めた symbology (`ZBAR_CODABAR` 等)。監査用。 */
  format: string | null;
  /** かかった時間 (ms)。切り分け用。 */
  ms: number;
  /**
   * 読めなかった理由。
   *   `no_symbol`    … 1 次元バーコードが見つからない (**ふつうに起こる**)
   *   `multiple`     … 1 次元が複数あり値が食い違う → **選ばない** (捏造ゼロ)
   *   `unavailable`  … sharp か wasm を読めない (Vercel で未配備・環境差)
   *   `failed`       … それ以外の例外
   */
  error?: 'no_symbol' | 'multiple' | 'unavailable' | 'failed';
  detail?: string;
}

/**
 * 画像 1 枚をデコードする。**投げない。**
 *
 * **`value` は生値**で返す — `A` で挟まれた Codabar の start/stop を剥がすのは
 * `normalizeExternalId()` の役目で、**規則を 2 か所に置かない** (`external-test-id.ts:162-177`)。
 */
export async function decodeBarcode(bytes: Uint8Array): Promise<BarcodeDecodeResult> {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  let sharpMod: Awaited<ReturnType<typeof loadSharp>>;
  let zbar: typeof import('@undecaf/zbar-wasm');
  try {
    sharpMod = await loadSharp();
    zbar = await import('@undecaf/zbar-wasm');
  } catch (e) {
    return { value: null, format: null, ms: ms(), error: 'unavailable', detail: String(e) };
  }
  try {
    /*
     * **グレースケールで渡す。** zbar の 1 次元デコードは輝度しか見ないので、
     * RGBA の 1/4 のバイト数で済む (`scanGrayBuffer`)。
     * **縮小はしない** — バーの細さがそのまま読み取りに効くので、
     * ここで小さくすると**読めなくなる側**に倒れる。
     */
    const { data, info } = await sharpMod(bytes)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const symbols = await zbar.scanGrayBuffer(buf, info.width, info.height);

    const found: Array<{ value: string; format: string }> = [];
    for (const s of symbols) {
      const name = String(s.typeName ?? '');
      // **2 次元は 1 件も通さない** (QR を本番の相関キーにしない)
      if (!ALLOWED_1D.has(name)) continue;
      let text = '';
      try {
        text = s.decode();
      } catch {
        continue;
      }
      const t = text.trim();
      if (t) found.push({ value: t, format: name });
    }
    if (found.length === 0) return { value: null, format: null, ms: ms(), error: 'no_symbol' };

    /*
     * **複数の 1 次元が食い違ったら選ばない。** 書面に別のバーコードが
     * 印字されている様式もあり得るので、**こちらで「らしい方」を選ぶと
     * 別の番号を確定させる**。Gemini へ譲り、判定は後段に任せる。
     * (同じ値が複数回読めた回は食い違いではないので通す。)
     */
    const distinct = new Set(found.map((f) => f.value));
    if (distinct.size > 1) {
      return { value: null, format: null, ms: ms(), error: 'multiple', detail: String(distinct.size) };
    }
    return { value: found[0].value, format: found[0].format, ms: ms() };
  } catch (e) {
    return { value: null, format: null, ms: ms(), error: 'failed', detail: String(e) };
  }
}
