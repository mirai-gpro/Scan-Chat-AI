import type { APIRoute } from 'astro';
import { GoogleGenAI } from '@google/genai';
import { MODELS } from '../../lib/gemini';
import { refreshConfig } from '../../lib/app-config';
import { buildUserContextForChat, getCustomerProfile, getAppliedExamLabels } from '../../lib/chat-context';
import { resolveViewer } from '../../lib/viewer';
import { denyAnonymous, denyUnlessShareScope } from '../../lib/write-guard';
import { logShareApiEvent } from '../../lib/share-access';

export const prerender = false;

/**
 * Live API 用 ephemeral token 発行。
 * 30 分の session 有効期間 / 60 秒以内に新規セッション開始 / 1 回限り使用。
 *
 * 【2026-09-30・§19.4 / §21.4】**body の `diagnosticUserId` は読まない。**
 *   - 対象は `resolveViewer` が決める（self なら本人、share なら共有リンクの対象）。
 *     ここで返す `userContext` / `userProfile` は **`customer` スキーマ（PII）を含む**ので、
 *     クライアント申告の uid で引くと**他人の PII を誰でも取り出せる**（実測・§11-#2）。
 *   - **未認証を 401 で止める。** 実機で認証なしに 76 文字の Live token が返っていた
 *     （30 分・Gemini Live の課金が乗る）。
 */
export const POST: APIRoute = async (ctx) => {
  const viewer = await resolveViewer(ctx);
  const unauth = denyAnonymous(viewer);
  if (unauth) return unauth;
  /*
   * **共有は scope に `interview` があるときだけ**（§17.2・2026-09-30 追加）。
   *
   * この口は **Gemini Live の ephemeral token（30 分・課金）** に加えて
   * `userContext` / `userProfile`（**`customer` スキーマ = PII**）/ `examTypes` を返す。
   * scope 検査が無いと、**「AI 問診の利用を許可」を外した共有リンクでも
   * `/api/live-token` を直接叩けば問診が始められ、PII まで取れる**
   * （`interview/export` だけを閉じても、開始側が開いていれば設定が意味を失う）。
   */
  const scoped = denyUnlessShareScope(viewer, 'interview');
  if (scoped) return scoped;

  /*
   * **「AI 問診を利用した」の記録はここ**（§26.1 の `chat_use`）。
   * `/chat` を開いただけでは記録しない — **利用と閲覧は意味が違う**。
   * 紐付けは `locals.share`（middleware しか書かない）から取るので、
   * **クライアントから ID を受け取らない**。share 以外では何もしない。
   */
  await logShareApiEvent(ctx, 'chat_use', '/api/live-token');

  await refreshConfig(); // 運用パラメータ(app_config)を最新化してから処理
  const apiKey = import.meta.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: 'GEMINI_API_KEY is not configured' }, 500);
  }

  // ★ 表示対象はサーバが決める。body は読まない（読む必要が無い）。
  const diagnosticUserId = viewer.uid;

  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
    const now = Date.now();
    const [token, userContext, userProfile, examTypes] = await Promise.all([
      ai.authTokens.create({
        config: {
          uses: 1,
          expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
          newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
          httpOptions: { apiVersion: 'v1alpha' },
        },
      }),
      buildUserContextForChat(diagnosticUserId).catch(() => null),
      getCustomerProfile(diagnosticUserId).catch(() => null),
      getAppliedExamLabels(diagnosticUserId).catch(() => [] as string[]),
    ]);
    return json({ token: token.name, model: MODELS.liveChat, userContext, userProfile, examTypes });
  } catch (err) {
    return json({ error: 'token mint failed', detail: String(err) }, 500);
  }
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
