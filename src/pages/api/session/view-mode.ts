/**
 * **表示モードの切り替え** (`real` ⇄ `demo`)。
 *
 * 正本 `docs/specs/special_demo_integration_spec_20261022.md` §4.2 (PR-C)。
 *
 * 【Cookie を書く口をここ 1 つに閉じる】Cookie は **HttpOnly** なので JS から書けない。
 * サーバが毎回資格を確かめてから書くので、**Cookie 自体が権限の根拠にならない**
 * (`resolveViewMode()` は読むときにも資格を引き直す = 二重の確認)。
 *
 * 【403 にする相手 (§4.2)】**代理表示・共有・未サインイン・Demo 資格なし**。
 * 判定は `resolveViewMode().switchable` 1 本で、**この API に条件を書き写さない**
 * (書き写すと表示側と食い違い、「切り替えたのに変わらない」が静かに起きる)。
 */
import type { APIRoute } from 'astro';
import { resolveViewer } from '../../../lib/viewer';
import { MODE_COOKIE, modeCookieOptions, parseMode, resolveViewMode } from '../../../lib/view-mode';

export const prerender = false;

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' },
});

export const POST: APIRoute = async (apiCtx) => {
  const { cookies, request } = apiCtx;
  const viewer = await resolveViewer(apiCtx);
  const state = resolveViewMode(viewer, parseMode(cookies.get(MODE_COOKIE)?.value));

  /*
   * **資格が無い相手には何も書かない。** 理由は返すが**どちらの条件で落ちたかは
   * 細かく割らない** (代理表示中か / 資格が無いか は切り分けに要るので state で返す)。
   */
  if (!state.switchable) {
    return json({
      ok: false,
      error: 'mode_switch_not_allowed',
      message: '表示モードの切り替えはご利用いただけません。',
      effective_mode: state.effectiveMode,
      can_demo: state.canDemo,
    }, 403);
  }

  let body: unknown = null;
  try { body = await request.json(); } catch { body = null; }
  const want = parseMode((body as { mode?: unknown } | null)?.mode as string | undefined);
  // **知らない値では何も書かない** (壊れた要求で既定を動かさない)。
  if (!want) return json({ ok: false, error: 'invalid_mode' }, 400);

  if (want === 'demo') cookies.set(MODE_COOKIE, 'demo', modeCookieOptions());
  // **`real` は Cookie を消す** (既定が real なので、値を書くより消すほうが素直)。
  else cookies.delete(MODE_COOKIE, { path: '/' });

  // 書いたあとの状態を**もう一度資格から組み直して**返す (申告をそのまま返さない)。
  const after = resolveViewMode(viewer, want === 'demo' ? 'demo' : null);
  return json({
    ok: true,
    effective_mode: after.effectiveMode,
    can_demo: after.canDemo,
    can_real: after.canReal,
    dual: after.dual,
  });
};
