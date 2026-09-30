/**
 * サインアウト。本人 Cookie を消すだけ（Supabase 側のセッション破棄はクライアントが行う）。
 *
 * テスト時にアカウントを切り替えるために要る。
 * `viewer.ts` の Cookie は HttpOnly なので、JS からは消せずサーバ経由が必須。
 */
import type { APIRoute } from 'astro';
import { VIEWER_COOKIE, resolveViewer } from '../../../lib/viewer';
import { denyForShare } from '../../../lib/write-guard';

export const prerender = false;

export const POST: APIRoute = async (apiCtx) => {
  const { cookies, redirect, request } = apiCtx;
  /*
   * **共有閲覧からは一切叩かせない**（2026-09-30・仕様書 §17.5 / §31 T-14-4）。
   * 端末の持ち主（共有相手とは**別人かもしれない**）の本人セッションを、
   * 共有相手の操作で**作らせない・壊させない**。共有を終えるのは `/share/end` の役目で、
   * あれは `welltect_share_v` だけを消す。
   */
  const shared = denyForShare(await resolveViewer(apiCtx));
  if (shared) return shared;

  cookies.delete(VIEWER_COOKIE, { path: '/' });
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  if (wantsJson) {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  return redirect('/dashboard', 303);
};

/** ブラウザのアドレスバーから叩けるように GET も受ける（テスト用）。 */
export const GET: APIRoute = async (apiCtx) => {
  const { cookies, redirect } = apiCtx;
  // GET も同じ（アドレスバーから叩ける口を開けたままにしない）。
  const shared = denyForShare(await resolveViewer(apiCtx));
  if (shared) return shared;

  cookies.delete(VIEWER_COOKIE, { path: '/' });
  return redirect('/dashboard', 303);
};
