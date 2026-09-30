import type { APIRoute } from 'astro';
import { getServerSupabase } from '../../../lib/supabase';
import { isAdminEmailAsync } from '../../../lib/admin-auth';
import { ADMIN_COOKIE, issueAdminCred, verifyAdminCred } from '../../../lib/admin-identity';
import { VIEWER_COOKIE, signViewer, verifyViewer, viewerCookieOptions, resolveViewer } from '../../../lib/viewer';
import { denyForShare } from '../../../lib/write-guard';

export const prerender = false;

/**
 * **admin フラグだけを Cookie に入れ直す軽い口**（2026-08-30）。
 *
 * 【なぜ要るか】admin かどうかは **email でしか判定できない**
 * （`admin_users` のキーは email。本番の顧客データは HP 側にあるので
 *  サーバは uid から email を引けない）。だから判定結果は Cookie に持つしかない。
 * ところが **Cookie はサインイン時にしか発行されず、有効期間は 30 日**。
 * → **判定を直しても、既にサインイン済みの人には最大 30 日届かない。**
 * 実測 2026-08-30: PR #190・#191 を本番へ入れても報告書が空のままだった。
 * **本番にコードが在るのに効かない**という最悪の形で、2 時間これに費やした。
 *
 * 【なぜ `/api/auth/resolve` を呼び直さないか】あちらは HP Edge の顧客解決と
 * `app_users` の upsert まで行う「サインインの処理」。admin フラグを直すためだけに
 * 毎セッション走らせるのは重いし、書き込みまで起きる。ここは
 * **本人検証 → admin 判定 → Cookie 再署名** だけをする。
 *
 * 【安全性】uid は**既存の署名付き Cookie から取る**（クライアントの申告を使わない）。
 * email は `sb.auth.getUser(accessToken)` で**サーバが検証した値**。
 * つまりこの口では **admin フラグしか変わらない**（別人にはなれない）。
 */
export const POST: APIRoute = async (apiCtx) => {
  const { request, cookies } = apiCtx;
  /*
   * **共有閲覧からは一切叩かせない**（2026-09-30・仕様書 §17.5 / §31 T-14-4）。
   * 端末の持ち主（共有相手とは**別人かもしれない**）の本人セッションを、
   * 共有相手の操作で**作らせない・壊させない**。共有を終えるのは `/share/end` の役目で、
   * あれは `welltect_share_v` だけを消す。
   */
  const shared = denyForShare(await resolveViewer(apiCtx));
  if (shared) return shared;

  const body = (await request.json().catch(() => null)) as { accessToken?: unknown } | null;
  const accessToken = typeof body?.accessToken === 'string' ? body.accessToken : null;
  if (!accessToken) return json({ error: 'missing accessToken' }, 400);

  /*
   * 本人は Cookie が正。ここで uid をクライアントから受け取らない。
   *
   * **`welltect_v` が無くても 401 にしない（2026-09-30 修正）。**
   * `admin_users` に居るが `diagnostic_user_id` を持たない admin は
   * **`welltect_v` を一生持てない**（`auth/resolve` が `{ linked:false }` で返るため）。
   * ここで弾くと、その admin の **`welltect_admin_v` を削除する手段が無くなり、
   * 管理者から外しても最大 30 日そのまま**になる（＝権限剥奪が効かない）。
   * → **`welltect_v` の再署名は在るときだけ**行い、
   *   **admin credential の発行 / 削除は常に行う。**
   */
  const current = await verifyViewer(cookies.get(VIEWER_COOKIE)?.value);

  const sb = getServerSupabase();
  if (!sb) return json({ error: 'supabase not configured' }, 503);

  const { data, error } = await sb.auth.getUser(accessToken);
  if (error || !data?.user) return json({ error: 'invalid session' }, 401);
  const email = (data.user.email ?? '').trim().toLowerCase();
  if (!email) return json({ error: 'no email' }, 400);

  const isAdmin = await isAdminEmailAsync(email);
  /*
   * **`origin` を絶対に変えない (2026-09-11・実障害)。**
   *
   * ここは **admin フラグだけ**を入れ直す口。`signViewer` の `origin` 既定は
   * `'production'` なので、**渡し忘れると staging 由来の 5 分割 Cookie が
   * production の 4 分割へ黙って書き換わる**。
   * `GoogleOneTap.astro:51` の `needsCookieRefresh` は **`selfUid` があれば真**
   * = サインイン済みなら誰でもこの口を叩く (同 `:95` `refreshViewerCookie`・
   * タブごと・ビルドごとに 1 回) ので、**必ず踏む**経路。実測ではサインイン直後に
   * 出ていたキット 2 件が、この再署名の直後から 0 件になった
   * (dashboard → 進捗の詳細 → dashboard の全部)。
   * → **uid と origin は `current`(検証済み Cookie) のものをそのまま引き継ぐ。**
   * 固定は `npm run verify:viewer-origin`。
   */
  if (current) {
    const token = await signViewer(current.uid, isAdmin, Date.now(), current.origin);
    if (!token) return json({ error: 'cannot sign' }, 503);
    cookies.set(VIEWER_COOKIE, token, viewerCookieOptions());
  }

  /*
   * **admin 専用 credential (`welltect_admin_v`) をここでも発行 / 削除する**
   * (2026-09-30・仕様書 §12.4.1)。
   *
   * 【なぜこの口が要るか】改修前からサインインしている admin は
   * この Cookie を持たない。**この口はサインイン済みなら誰でも 1 回叩く**
   * (`GoogleOneTap.astro:51` の `needsCookieRefresh` は `selfUid` があれば真) ので、
   * **次にアプリを開いた時点で自動的に付く**。admin フラグの自己修復に相乗りする。
   *
   * 【剥奪】`isAdmin === false` なら**削除する**。管理者リストから外れた人の
   * credential を残さない (最大で次のタブを開くまで、は受容・§12.4.1)。
   */
  const hadCred = !!(await verifyAdminCred(cookies.get(ADMIN_COOKIE)?.value));
  const nowHasCred = await issueAdminCred({ cookies }, email, isAdmin);

  // 変わったかどうかを返す (呼び出し側は変わったときだけ再読込する)。
  return json({
    ok: true,
    isAdmin,
    /** `welltect_v` を持たない admin は `linked:false` のまま。切り分け用。 */
    linked: !!current,
    changed: (current ? isAdmin !== current.admin || current.legacy : false) || hadCred !== nowHasCred,
  });
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
