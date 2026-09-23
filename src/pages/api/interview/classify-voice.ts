/**
 * POST /api/interview/classify-voice
 *
 * 音声の発話を、その設問の選択肢のどれかに当てる (発注者指示 2026-09-18)。
 * 決定論の照合 (`voice-answer.ts`) で当たらなかったときだけ、画面から呼ばれる。
 *
 * 入力  { question: string, options: string[], transcript: string }
 * 出力  { index: number | null, confidence: number }
 *
 * **番号しか返さない。** 選択肢の外は構造的に採用できない (`parseChoice` が範囲検査)。
 * **キーはサーバ側にしか無い**ので、判定もここで行う (CLAUDE.md の運用どおり)。
 *
 * PII: 送るのは**この 1 問の文言・選択肢・発話**だけ。氏名も uid も含めない
 * (発話そのものは Live API で既に Gemini へ渡っているので、新しい露出は増えない)。
 */
import type { APIRoute } from 'astro';
import { classifyVoiceChoice } from '../../../lib/voice-choice-llm';

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 上限。長文を投げ込まれても素通ししない。 */
const MAX_TRANSCRIPT = 200;
const MAX_OPTIONS = 40;

export const POST: APIRoute = async ({ request }) => {
  let body: { question?: unknown; options?: unknown; transcript?: unknown };
  try { body = await request.json(); } catch { return json({ index: null, confidence: 0 }, 400); }

  const question = typeof body.question === 'string' ? body.question.slice(0, 200) : '';
  const transcript = typeof body.transcript === 'string' ? body.transcript.slice(0, MAX_TRANSCRIPT) : '';
  const options = Array.isArray(body.options)
    ? body.options.filter((o): o is string => typeof o === 'string').slice(0, MAX_OPTIONS)
    : [];
  if (!transcript.trim() || options.length === 0) return json({ index: null, confidence: 0 });

  const apiKey = import.meta.env.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) return json({ index: null, confidence: 0, reason: 'empty' });

  try {
    const r = await classifyVoiceChoice(apiKey, options, transcript, question);
    return json(r);
  } catch {
    // **落ちても回答を作らない。** 呼び出し側が「もう一度お答えください」に倒す。
    return json({ index: null, confidence: 0, reason: 'empty' });
  }
};
