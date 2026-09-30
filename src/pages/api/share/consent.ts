/**
 * **同意 → 共有セッション発行。POST だけ。**
 * 正本: `docs/specs/secure_shared_access_and_admin_impersonation_spec_20260930.md` §17.1 / §18.3。
 *
 *   POST (json) {} → 200 { ok:true, next:'/dashboard' }
 *                    + Set-Cookie: welltect_share_v（link の期限を超えない）
 *                    + Set-Cookie: welltect_share_viewer（匿名の相関 ID）
 *                    - Delete  : welltect_share_pending
 *
 * 【pending と session は別の値】§31 T-5（session fixation）。
 * pending をそのまま昇格させると、**同意前に配った URL の持ち主が同意後のセッションを
 * 使い回せる**。`consume_share_pending` RPC が同意の瞬間に digest を差し替える。
 *
 * 【二重 POST で 2 つ発行しない】§7。判定は**アプリではなく DB の 1 文**（`consented_at is null`
 * を条件にした UPDATE）。2 本目は 0 行 = 403。
 *
 * 【`welltect_v` に触らない】§17.5。端末の持ち主（別人かもしれない）の本人セッションは
 * 共有の同意で壊さない。**共有用の Cookie だけを足す。**
 */
import type { APIRoute } from 'astro';
import {
  SHARE_PENDING_COOKIE, SHARE_COOKIE, SHARE_VIEWER_COOKIE,
  SHARE_OPAQUE_RE, randomShareToken, consumeSharePending, logShareEvent,
} from '../../../lib/share-access';

export const prerender = false;

function deny(): Response {
  return new Response(JSON.stringify({ error: 'share_unavailable' }), {
    status: 403,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const pending = cookies.get(SHARE_PENDING_COOKIE)?.value ?? '';
  if (!SHARE_OPAQUE_RE.test(pending)) return deny();

  /*
   * **匿名 viewer の相関 ID**（§31.1）。同じブラウザからの再入場を束ねるためだけのもので、
   * **本人確認には使わない**（誰でも作れる値なので）。無ければここで発行する。
   */
  const prior = cookies.get(SHARE_VIEWER_COOKIE)?.value ?? '';
  const viewerId = SHARE_OPAQUE_RE.test(prior) ? prior : randomShareToken();

  const issued = await consumeSharePending(pending, viewerId);

  /*
   * **pending は成否にかかわらず消す。** 失敗した札を残すと、次に別の共有 URL を
   * 開いたときに古い pending が邪魔をする。
   */
  cookies.delete(SHARE_PENDING_COOKIE, { path: '/' });

  // 不存在 / 同意済 / 失効 / link 停止 を**区別しない**（§16.3）。
  if (!issued) return deny();

  const secure = import.meta.env.DEV !== true;
  /*
   * **Cookie の寿命は DB が決めた期限に合わせる**（link の期限を超えない）。
   * ブラウザ側で先に消えるぶんには安全側。サーバは毎リクエストで
   * `resolveShareSession` が link の status / 期限まで見るので、**Cookie が残っていても
   * revoke は即座に効く**（§27.1）。
   */
  const maxAge = Math.max(
    60,
    Math.floor((Date.parse(issued.expiresAt) - Date.now()) / 1000),
  );

  cookies.set(SHARE_COOKIE, issued.session, {
    httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge,
  });
  /*
   * viewer の相関 ID は**セッションより長く持つ**（同じ人の再入場を束ねるため）が、
   * **link の期限の 2 倍までに留める**（無期限に残さない）。
   */
  cookies.set(SHARE_VIEWER_COOKIE, viewerId, {
    httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: maxAge * 2,
  });

  await logShareEvent({
    event: 'consent', request, linkId: issued.linkId, viewerId, path: '/api/share/consent',
  });

  return new Response(JSON.stringify({ ok: true, next: '/dashboard' }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
};
