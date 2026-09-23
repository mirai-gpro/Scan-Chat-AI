/**
 * AI問診 — 音声の発話を選択肢へ当てる「推論」層 (発注者指示 2026-09-18)。
 *
 * 【なぜ要るか】決定論の照合 (`voice-answer.ts`) は**言い方が一致したときしか当たらない**。
 * 実際の発話は「ない」「なし」「特にない」「多分ない」「ないと思う」「ない、けど」…と揺れる。
 * **LLM を使っているのだから、選択肢の中から推論させればよい** (発注者指示)。
 *
 * 【どこでやるか — Live セッションには入れない】
 * ①ツール呼び出しは廃止済で、Live に戻すと「音声のターン/発話は LLM 任せ」の設計が崩れる
 * ②Live から構造化出力を安定して取れない
 * → **サーバ側の 1 回きりの REST 呼び出し**にする。Live 側の仕事は従来どおり
 *   「渡された文を読み上げる」だけ。キーがサーバ側にしか無い運用にも合う。
 *
 * 【絶対に守ること】
 * - **選択肢の外を答えさせない。** 返すのは**番号**だけ (自由文を受け取らない)。
 *   番号は呼び出し側で範囲検査する。名前を作られても採用しようがない形にしてある。
 * - **迷ったら選ばせない。** 確度が低い/該当なしは `null` を返し、
 *   呼び出し側が「選択肢を確認して、もう一度お答えいただくか、タップしてください」と案内する。
 *   **医療問診なので、採らないより誤って採る方が悪い。**
 * - 例示は**否定の言い換え**に絞る (発注者が挙げたもの)。ここで多義語の解釈規則を作らない。
 */
import { callGemini, extractText, stripJsonCodeFence, MODELS } from './gemini';

/** 何番を選んだか。`index` が null なら「決められなかった」。 */
export interface VoiceChoiceResult {
  index: number | null;
  /** 0〜1。低いほど自信が無い。閾値未満は呼び出し側で null 扱い。 */
  confidence: number;
  /**
   * **なぜその結果になったか** (切り分け用・2026-09-23)。
   * `index: null` だけだと「モデルが決められなかった」と
   * 「本文が空で返った (予算切れ・通信失敗)」が**区別できず**、
   * 画面にはどちらも「聞き取れませんでした」としか出ない。
   * 選択肢の文言も発話も入れない (PII を増やさない)。
   */
  reason?: 'ok' | 'empty' | 'unparsable' | 'out_of_range' | 'low_confidence';
}

/** これ未満は採らない。**医療問診なので高めに置く** (誤採用より聞き直し)。 */
export const CONFIDENCE_FLOOR = 0.75;

const SYSTEM = `あなたは健康問診の回答を、決められた選択肢のどれか 1 つに割り当てる係です。

【やること】
利用者の発話が、選択肢のどれを指しているかを判断し、その **番号** を返す。

【判断の目安】
- 言い方が違っても意味が同じなら同じ選択肢とみなす。
  例: 「ない」「なし」「特にない」「多分ない」「ないと思う」「ない、けど」「大丈夫です」は、
      「なし」「ない」「該当するものはない」等の**否定の選択肢**を指す。
- 数量・頻度は、選択肢の区分に収まるものを選ぶ (例:「週に 3 回くらい」→「週3〜4日」)。

【決められないとき】
- どれを指すか分からない / 選択肢のどれにも当てはまらない / 発話が途中で切れている /
  複数を同時に指している ときは、**index を null** にする。
- **無理に近いものを選ばない。** 迷ったら null。利用者に聞き直すほうが安全です。

【禁止】
- 選択肢に無いものを作らない。返すのは番号だけ。
- 診断・助言をしない。`;

const SCHEMA = {
  type: 'object',
  properties: {
    index: { type: 'integer', nullable: true },
    confidence: { type: 'number' },
  },
  required: ['index', 'confidence'],
} as const;

/**
 * 発話を選択肢へ当てる。**当てられなければ `index: null`**。
 *
 * @param labels 選択肢の label (表示どおり・順番どおり)
 * @param transcript 利用者の発話 (音声認識の結果)
 */
export async function classifyVoiceChoice(
  apiKey: string,
  labels: string[],
  transcript: string,
  question: string,
): Promise<VoiceChoiceResult> {
  if (labels.length === 0 || !transcript.trim()) return { index: null, confidence: 0 };

  const list = labels.map((l, i) => `${i}. ${l}`).join('\n');
  const user = `質問: ${question}

選択肢:
${list}

利用者の発話: 「${transcript}」

どの番号か。決められなければ index を null に。`;

  const res = await callGemini(apiKey, {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
      /*
       * **思考トークンも maxOutputTokens に含まれる** (実障害 2026-09-23)。
       *
       * 公式 (ai.google.dev/gemini-api/docs/thinking):
       *   "max_output_tokens ... sets the maximum number of tokens a response can
       *    generate, **including thought tokens**"
       *   "If the model hits this limit while reasoning, it stops generating ...
       *    and returns truncated or **empty output**"
       *
       * ここは `thinkingBudget: 0` (2.x で思考オフ) を渡しているが、3.x では
       * `gemini.ts` の `thinkingBudgetToLevel` が **0 を `thinkingLevel: 'low'` に
       * 変換する = 思考はオンのまま**。そこへ 64 しか与えていなかったので、
       * 思考で予算を使い切り**本文が空で返り**、JSON.parse に失敗 →
       * `index: null` → 「聞き取れませんでした」。
       * **選択肢の音声回答が通らない**症状の正体がこれ。
       *
       * 返す JSON は 30 トークン程度なので、思考ぶんの余裕を持たせる。
       * (`thinkingBudgetToLevel` 自体はスキャン経路と共用なので**ここでは触らない**)
       */
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 },
    },
  }, MODELS.scan);

  return parseChoice(stripJsonCodeFence(extractText(res)), labels.length);
}

/**
 * 応答を安全に読む。**範囲外・壊れた JSON・確度不足は全部 null** に倒す。
 * (モデルが何を返しても、選択肢の外は採用できない形にしておく)
 */
export function parseChoice(text: string, optionCount: number): VoiceChoiceResult {
  // **空は「決められなかった」ではない。** 予算切れ・通信失敗の疑いとして分けて返す。
  if (!text.trim()) return { index: null, confidence: 0, reason: 'empty' };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { index: null, confidence: 0, reason: 'unparsable' }; }
  if (!raw || typeof raw !== 'object') return { index: null, confidence: 0, reason: 'unparsable' };
  const o = raw as { index?: unknown; confidence?: unknown };
  const conf = typeof o.confidence === 'number' && Number.isFinite(o.confidence)
    ? Math.max(0, Math.min(1, o.confidence))
    : 0;
  if (typeof o.index !== 'number' || !Number.isInteger(o.index)) return { index: null, confidence: conf, reason: 'ok' };
  if (o.index < 0 || o.index >= optionCount) return { index: null, confidence: conf, reason: 'out_of_range' };
  if (conf < CONFIDENCE_FLOOR) return { index: null, confidence: conf, reason: 'low_confidence' };
  return { index: o.index, confidence: conf, reason: 'ok' };
}
