/**
 * AI ヘルスコーチ Q&A API。
 *
 * リクエスト: { message, history? }  ← uid は Cookie/共有セッションから解決する
 * レスポンス: { answer, generatedAt }
 *
 * 3 種類の回答パターンを system prompt で制御:
 *  ① AI疾病予防報告書から答えられる → 結果を引用
 *  ② 一般的な健康・栄養知識 → 「一般的に言われていますが」と但し書き
 *  ③ 医療アドバイス相当 → 拒否文言で回答
 */

import type { APIRoute } from 'astro';
import { MODELS, callGemini, extractText, type GeminiContent } from '../../../lib/gemini';
import { buildCoachContext } from '../../../lib/coach-context';
import { resolveViewer } from '../../../lib/viewer';
import { denyAnonymous } from '../../../lib/write-guard';

export const prerender = false;

const SYSTEM_PROMPT_TEMPLATE = (userContext: string) => `あなたはウェルフォートの AI ヘルスコーチです。
以下のユーザーの AI疾病予防報告書と検査データに基づいて、健康に関する質問に丁寧に答えます。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【回答ルール — 厳守】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ユーザーからの質問は、以下の 3 種類に分類して回答してください。

━━━ ① ユーザーの AI疾病予防報告書や検査データから答えられる質問 ━━━
   → 必ず**結果を引用して具体的に回答**してください。
   → 引用箇所には「あなたの最新の検査結果によると」「AI 診断のサマリーでは」
      「検査値フィードバックでは」のような前置きを必ず添えてください。
   → 数値・基準値を明示し、なぜそうした方が良いかを根拠とともに説明します。
   例: 「あなたの尿酸値は 8.4 mg/dL で基準値 (〜7.0) を超えていますので、
        プリン体の少ない食材を選ぶことをお勧めします。」

━━━ ② 一般的な健康・栄養・運動・睡眠の知識として答えられる質問 ━━━
   (個別の AI疾病予防報告書に依存しないもの。例: 朝食の重要性、推奨睡眠時間、
    一般的な運動量等)
   → 必ず冒頭に「**一般的に言われていますが**」を添えて回答してください。
   → 個別のあなたへのアドバイスではないことを明示してください。
   → 文末に「あなたの場合の詳細は、検査結果も合わせてご検討ください」を添えても良い。
   例: 「一般的に言われていますが、朝食を毎日摂ることは血糖値の安定と
        エネルギー代謝に有益とされています。」

━━━ ③ 医療アドバイスに相当する質問 ━━━
   (例: 病気の診断、治療方針、薬の使用判断、症状の原因特定、
    医療行為の可否、手術や処置の妥当性、服用中の薬の変更等)
   → **必ず以下の固定文言** をベースに回答してください (前後に余計な
      情報を付けない):

   「これに関しては、医療アドバイスに相当する可能性があるので、
    私からはお答えできません。詳しくは、専門医や主治医にお尋ね下さい。」

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【その他の指針】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- 文体: 温かく、丁寧な敬語 (「〜です」「〜ですね」「〜しましょう」)
- 長さ: 1 回の回答は 200〜400 字程度。長文は避けて要点を絞る
- 絵文字は使わない (アプリ側でアイコンを描画するため。本文に絵文字を混ぜない)
- Markdown: 太字や箇条書きは見やすさのため使って良い
- 過去の対話を踏まえて文脈を維持する

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${userContext}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

interface HistoryItem {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * 【2026-09-30・§19.4 / §21.4】**body の `diagnosticUserId` は読まない。**
 *   - `buildCoachContext` は**その人の AI 疾病予防報告書**を読む。クライアント申告の uid で
 *     引けると**他人の報告書を誰でも読める**（§11-#4）。対象は resolver が決める。
 *   - **未認証を 401 で止める**（Gemini の課金が乗るため・§21.4）。
 */
export const POST: APIRoute = async (apiCtx) => {
  const { request } = apiCtx;
  const viewer = await resolveViewer(apiCtx);
  const unauth = denyAnonymous(viewer);
  if (unauth) return unauth;

  const apiKey = import.meta.env.GEMINI_API_KEY;
  if (!apiKey) return json({ error: 'GEMINI_API_KEY is not configured' }, 500);

  const body = await request.json().catch(() => null) as {
    message?: unknown;
    history?: unknown;
  } | null;

  const diagnosticUserId = viewer.uid;   // ★ サーバが決める
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  const history: HistoryItem[] = Array.isArray(body?.history)
    ? (body.history as HistoryItem[]).filter(
        (m) => m && typeof m.text === 'string' && (m.role === 'user' || m.role === 'assistant'),
      ).slice(-10) // 直近 10 件まで
    : [];

  if (!message) return json({ error: 'message is required' }, 400);
  if (!diagnosticUserId) return json({ error: 'サインインが必要です。' }, 401);

  const ctx = await buildCoachContext(diagnosticUserId).catch(() => null);
  if (!ctx) {
    return json({
      error: 'AI疾病予防報告書が見つかりません。ダッシュボードで検査結果が表示されるかご確認ください。',
    }, 404);
  }

  const systemPrompt = SYSTEM_PROMPT_TEMPLATE(ctx.promptText);

  // 過去の対話 + 今回の質問を Gemini contents に変換
  const contents: GeminiContent[] = [];
  for (const h of history) {
    contents.push({
      role: h.role === 'user' ? 'user' : 'model',
      parts: [{ text: h.text }],
    });
  }
  contents.push({ role: 'user', parts: [{ text: message }] });

  try {
    const res = await callGemini(
      apiKey,
      {
        contents,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 800,
          thinkingConfig: { thinkingBudget: 0 },
        },
      },
      MODELS.scan,
    );
    const answer = extractText(res).trim();
    if (!answer) {
      return json({ error: 'AI から返答がありませんでした。少し時間を置いて再度お試しください。' }, 502);
    }
    return json({ answer, generatedAt: new Date().toISOString() });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return json({ error: `coach response failed: ${detail}` }, 500);
  }
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
