/**
 * 問診回答 + 検査結果を統合した「今日の気付き」生成 API。
 *
 * 入力: { chatMessages: ChatMessage[] }  ← uid は Cookie/共有セッションから解決する
 * 出力: { insight: string, generatedAt: string } | { error: string }
 *
 * クライアント側: ダッシュボードの HealthInsightCard が呼び出す。
 */

import type { APIRoute } from 'astro';
import { MODELS, callGemini, extractText } from '../../lib/gemini';
import { buildUserContextForChat } from '../../lib/chat-context';
import { resolveViewer } from '../../lib/viewer';
import { denyAnonymous } from '../../lib/write-guard';

export const prerender = false;

interface ChatMessageInput {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

/**
 * 【2026-09-30・§19.4 / §21.4】**body の `diagnosticUserId` は読まない。**
 *   - `buildUserContextForChat` は**その人の検査結果**を読む。クライアント申告の uid で
 *     引けると**他人の検査サマリーを誰でも取り出せる**（§11-#3）。対象は resolver が決める。
 *   - **未認証を 401 で止める**（Gemini の課金が乗るため・§21.4）。
 */
export const POST: APIRoute = async (ctx) => {
  const { request } = ctx;
  const viewer = await resolveViewer(ctx);
  const unauth = denyAnonymous(viewer);
  if (unauth) return unauth;

  const apiKey = import.meta.env.GEMINI_API_KEY;
  if (!apiKey) return json({ error: 'GEMINI_API_KEY is not configured' }, 500);

  const body = await request.json().catch(() => null) as {
    chatMessages?: unknown;
  } | null;

  const diagnosticUserId = viewer.uid;   // ★ サーバが決める
  const chatMessages = Array.isArray(body?.chatMessages)
    ? (body.chatMessages as ChatMessageInput[]).filter(
        (m) => m && typeof m.text === 'string' && (m.role === 'user' || m.role === 'assistant'),
      )
    : [];

  if (chatMessages.length === 0) {
    return json({ error: '問診回答が空です。問診を完了してからお試しください。' }, 400);
  }

  // 検査結果サマリーを取得 (chat-context と同じロジック)
  const userContext = await buildUserContextForChat(diagnosticUserId).catch(() => null);

  // 問診の流れを要約しやすい形に整形 (Q: ... / A: ... のペアにする)
  const transcript = chatMessages
    .slice(-40) // 直近 40 件まで (token 節約)
    .map((m) => `${m.role === 'assistant' ? 'Q' : 'A'}: ${m.text.replace(/\s+/g, ' ').trim()}`)
    .join('\n');

  const systemPrompt = `あなたは予防医療に詳しい温かみのある健康コーチです。
ユーザーの「直近の検査結果」と「今日の問診回答」を踏まえて、本人向けに「今日の気付き」を 200〜350字 で書きます。

【出力ルール】
- 構成: ①優しい労いの一言 → ②検査と問診の両方を踏まえた具体的な気付き 2〜3 点 → ③明日から試せる小さな提案 1 つ
- 箇条書き可、Markdown は使わない (絵文字は適度に OK)
- 専門用語は最低限。優しい口調 (「〜ですね」「〜してみましょう」)
- 診断・処方は絶対にしない (「医師にご相談を」程度は OK)
- 検査結果が無い場合は問診回答だけで簡潔に
- ユーザーの氏名は呼ばない (匿名)`;

  const userPrompt = [
    userContext ? `【直近の検査結果】\n${userContext}` : '【直近の検査結果】 (なし)',
    `【今日の問診回答】\n${transcript}`,
    '【今日の気付き】を 200〜350字で:',
  ].join('\n\n');

  try {
    const res = await callGemini(
      apiKey,
      {
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 600,
          thinkingConfig: { thinkingBudget: 0 },
        },
      },
      MODELS.scan,
    );
    const insight = extractText(res).trim();
    if (!insight) {
      return json({ error: 'AI から返答がありませんでした。少し時間を置いて再度お試しください。' }, 502);
    }
    return json({ insight, generatedAt: new Date().toISOString() });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return json({ error: `insight generation failed: ${detail}` }, 500);
  }
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
