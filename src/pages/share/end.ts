/**
 * **共有の終了。POST だけ。**
 * 正本: `docs/specs/secure_shared_access_and_admin_impersonation_spec_20260930.md` §17.5 / §25 / §31 T-14-4。
 *
 *   POST /share/end → 200 { ok:true, next:'/dashboard' }
 *                     - Delete: welltect_share_v / welltect_share_pending
 *
 * 【**`welltect_v` と `welltect_admin_v` には 1 バイトも触らない**】これが本命（§17.5）。
 * 共有相手が使っている端末は**その人自身の端末**かもしれないし、**本人や admin の端末**かも
 * しれない。共有を終わるために本人のサインインを壊すと、
 *   ① 端末の持ち主が黙ってサインアウトさせられる
 *   ② 共有相手の操作で admin セッションを落とせてしまう（§31 T-14-4）
 * ので、**消すのは共有用の Cookie だけ**にする。終了後は通常の自分の画面（未サインインなら
 * サインイン画面）へ落ちる（§24.1 順序 4）。
 *
 * 【DB 側も落とす】Cookie を消すだけだと**同じ値を持つ人がまだ入れる**。
 * `endShareSession` が `revoked_at` を立てるので、以後 `resolveShareSession` が通さない。
 */
import type { APIRoute } from 'astro';
import {
  SHARE_COOKIE, SHARE_PENDING_COOKIE,
  endShareSession, logShareEvent, resolveShareSession,
} from '../../lib/share-access';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies }) => {
  const raw = cookies.get(SHARE_COOKIE)?.value ?? '';

  if (raw) {
    // ログに残す link を先に引く（revoke すると引けなくなる）。
    const resolved = await resolveShareSession(raw);
    await endShareSession(raw);
    await logShareEvent({
      event: 'share_end',
      request,
      linkId: resolved?.linkId ?? null,
      sessionId: resolved?.sessionId ?? null,
      viewerId: resolved?.viewerId ?? null,
      path: '/share/end',
    });
  }

  // ★ ここで消すのは共有用の 2 つだけ。`welltect_v` / `welltect_admin_v` は残す。
  cookies.delete(SHARE_COOKIE, { path: '/' });
  cookies.delete(SHARE_PENDING_COOKIE, { path: '/' });

  return new Response(JSON.stringify({ ok: true, next: '/dashboard' }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
};
