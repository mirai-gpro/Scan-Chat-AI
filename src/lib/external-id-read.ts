/**
 * 撮影画像から**外部検査ID を読む**（サーバ側 Gemini・発注者裁定 2026-10-11「サーバ側 Gemini」）。
 *
 * 正本: `docs/lab/kit_receipt_external_id_capture_spec.md` §5 / §6.4。
 *
 * 【なぜクライアントのバーコード API を本線にしないか】
 * `BarcodeDetector` は **iOS Safari に無い**。主要利用者は 50〜65 代でスマホ中心なので、
 * iPhone で落ちる方式は機能として成立しない。`@zxing/library` 等を同梱する案は
 * bundle が数百KB 増え `CLAUDE.md` の「追加依存なし方針」に逆行する。
 * → **撮影画像を S3 へ置き、サーバで Gemini に読ませる**。`/scan` が既に本番で
 * 使っている経路と同じ形なので、端末差が出ず追加依存もゼロ。
 *
 * 【この関数は値を確定しない】
 * 返すのは**候補**だけ。採否は `external-test-id.ts` の `evaluateExternalId()` が決め、
 * 確定はユーザーの確認操作を経てから（仕様 §1-7）。ここでは
 *   - **1次元バーコード**のデコード結果
 *   - **印字された ID** の読み取り結果
 * を別々に返し、**一致確認を後段に残す**。混ぜて 1 つにしてしまうと
 * 「不一致は自動確定しない」が成立しない。
 *
 * 【QR コードは読まない・返さない】
 * プリベントの同梱書面には QR も印字されているが、**要るのは 1次元バーコードと印字ID**。
 * QR の値を候補に混ぜると、**別の番号を本番の相関キーにしてしまう**（仕様 §2.1・§5.1）。
 * プロンプトで明示的に除外し、スキーマにも QR のフィールドを作らない。
 */

import { callGemini, GeminiError, MODELS, type GeminiRequest } from './gemini';
import { refreshConfig } from './app-config';
import {
  EXTERNAL_ID_PROVIDERS, type ExternalIdProvider,
} from './external-test-id';

/** 読み取りの生結果（**正規化も採否判定もしない**）。 */
export interface ExternalIdReadResult {
  ok: boolean;
  /** 1次元バーコードのデコード結果（読めなければ null）。 */
  barcode: string | null;
  /** 印字された ID の読み取り結果（読めなければ null）。 */
  printed: string | null;
  /** モデルが「対象の書面に見えない」と言った場合の理由（画面の案内に使う）。 */
  note: string | null;
  error?: 'gemini_unavailable' | 'gemini_failed' | 'unparsable';
  detail?: string;
  /**
   * Gemini の呼び出しにかかった時間（ms）。**計測のためだけに返す**。
   * 撮影から表示まで 30 秒という実測（発注者 2026-10-22）の切り分けに使う:
   * S3 の往復・関数の起動・推論のどれが効いているのかは、**推測ではなく
   * 区間ごとの実測**で分ける（CLAUDE.md R1/R4）。`callGemini` は 503/429 を
   * 黙って再試行する（`gemini.ts` の指数バックオフ 1,2,4,8s）ので、
   * **この値が大きいときは推論が遅いのか再試行が挟まったのかを次に見る**。
   */
  geminiMs?: number;
}

/** 返させる形。**QR のフィールドを作らない**のが仕様上の要点。 */
const READ_SCHEMA = {
  type: 'object',
  properties: {
    barcode_value: { type: 'string', nullable: true },
    printed_id_value: { type: 'string', nullable: true },
    note: { type: 'string', nullable: true },
  },
  required: ['barcode_value', 'printed_id_value'],
} as const;

/** **検査が実物を見られるように export する** (`verify:external-id-capture` ⑨)。 */
export const SYSTEM_BY_PROVIDER: Record<ExternalIdProvider, string> = {
  prevent: [
    'あなたは検査キット同梱書面の読み取り役です。画像から次の 2 つだけを読み取ります。',
    '',
    '1. `barcode_value` — 書面に印刷された **1次元バーコード**（横線のバーコード）が表す数字列。',
    '2. `printed_id_value` — その近傍に**文字として印字されている「ユーザーID」**の数字列。',
    '',
    '厳守:',
    '- **QR コード（正方形の二次元コード）は読まない。** 画像に QR があっても値を返さない。',
    '  QR の内容を `barcode_value` や `printed_id_value` に入れてはいけない。',
    '- 読み取れないものは **null**。推測で数字を作らない。桁を補わない。',
    '- バーコードの下に数字が印字されている場合、それは `barcode_value` として読んでよい。',
    '  **英字で挟まれていることがある**（例: `A` + 数字 + `A`）。その場合は**見えたとおり**に返す。',
    '  英字を落として整えなくてよい（こちらで処理する）。',
    '- **パスワードと URL は読まない。** 書面にはログイン用のパスワード（英字と数字が混ざったもの）と',
    '  URL が印字されているが、どちらも値として返してはいけない。',
    '- 2 つは**別々に報告する**。一方だけ読めたら他方は null にする。',
    '  値が同じでも、それぞれの場所から読んだ結果をそのまま入れる。',
    '- 対象の書面に見えない（別の紙・封筒・空白など）ときは両方 null にし、`note` に理由を 1 文で書く。',
  ].join('\n'),
  demecal: [
    'あなたは検査キット同梱の「検査申し込み用紙」の読み取り役です。画像から次だけを読み取ります。',
    '',
    '1. `printed_id_value` — 用紙に印字された **「問合せ番号」** の数字列。',
    '2. `barcode_value` — 用紙に **1次元バーコード**があればその数字列。無ければ null。',
    '',
    '厳守:',
    '- **QR コードは読まない。**',
    '- 読み取れないものは **null**。推測で数字を作らない。桁を補わない。',
    '- 「問合せ番号」以外の番号（お客様番号・商品コード・電話番号・郵便番号）を入れない。',
    '  ラベルが「問合せ番号」と読めない場合は null にし、`note` に何が見えたかを 1 文で書く。',
  ].join('\n'),
};

/** 同上。 */
export const USER_BY_PROVIDER: Record<ExternalIdProvider, string> = {
  prevent: 'この書面から 1次元バーコードの数字列と、印字された「ユーザーID」の数字列を読み取ってください。QR コードは無視してください。',
  demecal: 'この用紙から「問合せ番号」の数字列を読み取ってください。QR コードは無視してください。',
};

/**
 * 画像 1 枚を読む。**例外を投げない** — 失敗は `ok:false` で返し、
 * 呼び出し側は手入力へ落とす（読めないことは行き止まりにしない・仕様 §5.1 の 3）。
 */
export async function readExternalIdFromImage(input: {
  provider: ExternalIdProvider;
  mime: string;
  base64: string;
  apiKey: string | undefined;
}): Promise<ExternalIdReadResult> {
  const empty = { barcode: null, printed: null, note: null };
  if (!(EXTERNAL_ID_PROVIDERS as readonly string[]).includes(input.provider)) {
    return { ok: false, ...empty, error: 'unparsable', detail: 'unknown provider' };
  }
  if (!input.apiKey) {
    return { ok: false, ...empty, error: 'gemini_unavailable', detail: 'GEMINI_API_KEY 未設定' };
  }

  // モデルは app_config の `scan.model` を使う (`MODELS.scan` は getter)。
  await refreshConfig().catch(() => undefined);

  const req: GeminiRequest = {
    systemInstruction: { parts: [{ text: SYSTEM_BY_PROVIDER[input.provider] }] },
    contents: [{
      role: 'user',
      parts: [
        { text: USER_BY_PROVIDER[input.provider] },
        { inline_data: { mime_type: input.mime, data: input.base64 } },
      ],
    }],
    generationConfig: {
      // 2.x 形式で書けば callGemini が 3.x へ自動変換する (gemini.ts:82-95)。
      temperature: 0,
      /*
       * **`thinkingLevel` を明示する**（発注者指摘「30 秒は長すぎない？」・2026-10-22）。
       *
       * ここは元々 `thinkingBudget: 0`（2.x で思考オフ）だけを渡していたが、
       * **3.x では `thinkingBudgetToLevel` が 0 を `'low'` に写すので思考はオンのまま**
       * （`gemini.ts:71-73`。`voice-choice-llm.ts:111-122` が同じ罠で実障害を出している）。
       * 既定モデルは `gemini-3.1-flash-lite` なので、**この経路は毎回 low で考えていた**。
       *
       * 公式 (ai.google.dev/gemini-api/docs/thinking):
       *   - 3.x の flash / flash-lite は `thinking_level` に **`minimal`** を取る
       *     （3.5-flash-lite は既定が "On (minimal)"）。
       *   - 「コストや待ち時間を下げたいときは `thinking_level` を下げる。
       *     `max_output_tokens` で絞るのは**応答が切れる**のでよくない」
       * → 読み取るのは**バーコード 1 本と数字 1 つ**（公式の言う fact retrieval）なので
       *   最小で足りる。**`off` / `none` / `0` は 3.x に無い**（同ページに記載なし）。
       *
       * **`thinkingBudgetToLevel` 自体は触らない** — スキャン本経路と共用で、
       * `voice-choice-llm.ts:119` が「ここでは触らない」と決めている。
       * `normalizeGenerationConfigForModel` は `thinkingLevel` が在れば
       * そちらを優先するので（`gemini.ts:89-90`）、**この 1 行で済む**。
       */
      thinkingConfig: { thinkingLevel: 'minimal' },
      responseMimeType: 'application/json',
      responseSchema: READ_SCHEMA,
      /*
       * **思考トークンも `maxOutputTokens` に含まれる**（公式・同ページ。
       * `voice-choice-llm.ts:101-121` が 64 で**空応答**を出した実障害）。
       * 返す JSON は 50 トークン程度だが、思考ぶんの余裕を持たせる
       * （`minimal` でも 0 ではない）。**切れると `unparsable` → 撮り直し**になり、
       * 待ち時間が 2 倍になるのが最も悪い。
       */
      maxOutputTokens: 1024,
    },
  };

  let text: string;
  const t0 = Date.now();
  try {
    const res = await callWithMinimalThinking(input.apiKey, req);
    text = (res.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
  } catch (e) {
    return {
      ok: false, ...empty, error: 'gemini_failed',
      detail: e instanceof Error ? e.message : String(e),
      geminiMs: Date.now() - t0,
    };
  }
  const geminiMs = Date.now() - t0;

  const parsed = parseReadJson(text);
  if (!parsed) return { ok: false, ...empty, error: 'unparsable', detail: 'JSON を読めませんでした', geminiMs };
  return { ok: true, ...parsed, geminiMs };
}

/**
 * `thinkingLevel: 'minimal'` で呼び、**モデルがその値を受け付けないときだけ**
 * thinking の指定を外して 1 回だけやり直す。
 *
 * **なぜ保険が要るか**: 公式の対応表に載っているのは `gemini-3.5-flash-lite` /
 * `gemini-3-flash-preview` などで、**既定の `gemini-3.1-flash-lite` はその表に
 * 名前が無い**（2026-10-22 時点）。`minimal` を受けないモデルだと 400 になり、
 * `callGemini` は 4xx を再試行しないので**読み取りが丸ごと落ちる**。
 * `scan.model` は admin から変えられる（app_config）ので、**将来どのモデルを
 * 指されても読めること**を優先する。
 *
 * **指定を外すと `thinkingLevel` 無しになる = モデルの既定で考える**（遅いが読める）。
 * 遅さより「読めない」が重いので、こちらへ倒す。
 */
async function callWithMinimalThinking(apiKey: string, req: GeminiRequest) {
  try {
    return await callGemini(apiKey, req, MODELS.scan);
  } catch (e) {
    const rejected = e instanceof GeminiError && e.status === 400
      && /thinking/i.test(`${e.body ?? ''}${e.message}`);
    if (!rejected) throw e;
    const { thinkingConfig: _unsupported, ...rest } = req.generationConfig ?? {};
    return await callGemini(apiKey, { ...req, generationConfig: rest }, MODELS.scan);
  }
}

/**
 * 応答 JSON を読む。**失敗しても投げない。**
 * 値は文字列化するだけで**正規化しない** — 正規化は `normalizeExternalId()` の役目で、
 * 2 か所に置くと規則が食い違う。
 */
export function parseReadJson(text: string): { barcode: string | null; printed: string | null; note: string | null } | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  // ```json フェンスが付く回があるので外す
  const body = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let obj: unknown;
  try {
    obj = JSON.parse(body);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const str = (v: unknown): string | null => {
    if (typeof v === 'string') { const s = v.trim(); return s && s.toLowerCase() !== 'null' ? s : null; }
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return null;
  };
  return {
    barcode: str(o.barcode_value),
    printed: str(o.printed_id_value),
    note: str(o.note),
  };
}
