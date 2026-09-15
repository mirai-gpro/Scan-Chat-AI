/**
 * **紙 1 枚を Gemini に読ませる。** 前景 (`/api/scan`) とワーカー
 * (`/api/cron/scan-worker`) の**両方がここを通る**。
 *
 * 正本: `docs/scan/スキャン非同期処理_仕様書.md` §4.3。
 * **写して 2 か所に置かない** — プロンプトも生成設定も 1 か所に集約する
 * (CLAUDE.md「納品整形は決定論プログラムに集約」と同じ規律)。
 */

import { ANALYZE_SYSTEM } from './scan-prompt';
import { callGemini, MODELS, extractText, GeminiError, type GeminiContent } from './gemini';

export interface ReadPageInput {
  mime: string;
  /** base64 (data URL の本体部分)。 */
  data: string;
  hint?: string | null;
}

export type ReadPageResult =
  | { ok: true; markdown: string; finishReason?: string }
  | { ok: false; status: number; error: string; detail?: unknown };

export async function readScanPage(input: ReadPageInput): Promise<ReadPageResult> {
  const userParts: GeminiContent['parts'] = [
    { inline_data: { mime_type: input.mime, data: input.data } },
    {
      text: input.hint
        ? `補足: ${input.hint}\nこの紙面を Markdown に書き起こしてください。`
        : 'この紙面を Markdown に書き起こしてください。',
    },
  ];

  try {
    const res = await callGemini(
      import.meta.env.GEMINI_API_KEY,
      {
        systemInstruction: { parts: [{ text: ANALYZE_SYSTEM }] },
        contents: [{ role: 'user', parts: userParts }],
        generationConfig: {
          temperature: 0.0,
          maxOutputTokens: 32768,
          thinkingConfig: { thinkingBudget: 2048 },
        },
      },
      MODELS.scan,
    );
    return {
      ok: true,
      markdown: extractText(res),
      finishReason: res.candidates?.[0]?.finishReason,
    };
  } catch (err) {
    if (err instanceof GeminiError) {
      return { ok: false, status: err.status >= 400 ? err.status : 500, error: err.message, detail: err.body };
    }
    return { ok: false, status: 500, error: 'Unexpected error', detail: String(err) };
  }
}
