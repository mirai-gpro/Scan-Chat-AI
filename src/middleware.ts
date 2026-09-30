/**
 * **`/admin-view/<ctx>/…`（Admin 代理表示）だけを扱う middleware。**
 * 正本: `docs/specs/secure_shared_access_and_admin_impersonation_spec_20260930.md` §13.0 案 B / §38-U20。
 *
 * 【なぜ middleware か】§28.3 は「middleware を安易に新設しない」としていたが、
 * 代理表示は**それ以外の方法だと成立しない**:
 *   - ヘッダで ctx を渡す … **クライアントが偽装できる**ので論外。
 *   - 各ページで `Astro.rewrite()` … ページ側は `/admin-view/<ctx>/…` を**知らない**
 *     （rewrite 後は内側のページの URL になる）。10 本のページに同じ解決を複製することになる。
 *   - `[...rest].astro` で全ページを再実装 … **紙面の二重管理**。
 * → **middleware で 1 回だけ解決し、`locals` に載せて内側のページへ rewrite する。**
 *   `locals` は**サーバ側にしか存在しない**ので、ここを通っていない限り代理表示は成立しない。
 *
 * 【`/admin-view/` 以外には 1 バイトも触らない】先頭一致で即 `next()`。
 * **既存の全ページ・全 API の挙動は不変。**
 *
 * 【毎リクエストで本人結合する】§12.4.1「毎リクエスト」:
 *   ① `welltect_v` が admin      ② `welltect_admin_v` が有効
 *   ③ `sha256(ctx)` の session が在る  ④ **session.admin_identity == ②の identity**
 *   ⑤ 期限内・未 revoke
 * **1 つでも欠ければ 403。`self` / `share` へフォールバックしない**（§24.1 順序 1）。
 * admin が「A さんの画面のつもりで自分の画面を見る」のが最悪の事故なので、
 * **URL が名指ししたものが出せないなら、何も出さない。**
 */

import { defineMiddleware } from 'astro:middleware';
import { VIEWER_COOKIE, verifyViewer } from './lib/viewer';
import { ADMIN_COOKIE, verifyAdminCred } from './lib/admin-identity';
import { parseAdminViewPath, resolveImpersonationContext } from './lib/admin-impersonation';

/** 理由を出し分けない（切り分けはサーバログ側）。本文も最小にする。 */
function forbidden(): Response {
  return new Response('403 Forbidden', {
    status: 403,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'referrer-policy': 'no-referrer',
    },
  });
}

export const onRequest = defineMiddleware(async (context, next) => {
  const parsed = parseAdminViewPath(new URL(context.request.url).pathname);
  if (!parsed) return next();   // ★ 既存の経路はここで終わり（挙動不変）

  /*
   * **認可の根拠は `welltect_admin_v` 一本**（2026-09-30 修正）。
   *
   * 【なぜ `welltect_v` を条件にしないか】**`admin_users` に居るが Scan-Chat-AI 側の
   * `diagnostic_user_id` を持たない admin が居る**。その人は `api/auth/resolve.ts` の
   * `{ linked:false }` で返るので **`welltect_v` を一生持てない**。
   * ここで `welltect_v` を要求すると、v1.4 で payload から uid を外した意味が消え、
   * **その admin は必ず 403** になる（実際そうなっていた）。
   *
   * `welltect_admin_v` は
   *   ・サーバ検証済みの Google/Supabase identity からしか発行されない
   *   ・`admin_users` の在籍確認を通った人にしか出ない
   *   ・HMAC で封じてあるので中身を書き換えられない
   *   ・admin から外れたら `refresh-admin` が削除する
   * ので、**これ単体で「どの admin か」の証明として十分**。
   */
  const cred = await verifyAdminCred(context.cookies.get(ADMIN_COOKIE)?.value);
  if (!cred) return forbidden();

  const session = await resolveImpersonationContext(parsed.ctx, cred.identity);
  if (!session) return forbidden();

  /*
   * `welltect_v` は**認可には使わない**。在れば admin 本人の uid を拾うだけ
   * （画面の切り分け表示用）。**無くても代理表示は成立する。**
   */
  const viewer = await verifyViewer(context.cookies.get(VIEWER_COOKIE)?.value);

  context.locals.adminView = {
    ctx: session.ctx,
    targetUid: session.targetUid,
    targetOrigin: session.targetOrigin,
    adminIdentity: cred.identity,
    adminSelfUid: viewer?.admin ? viewer.uid : null,
    expiresAt: session.expiresAt,
  };

  /*
   * 内側のページへ rewrite する。**リダイレクトではない** — URL は
   * `/admin-view/<ctx>/…` のままにしておかないと、タブごとの分離（§13.0）が消える。
   * クエリ文字列はそのまま引き継ぐ（`/trend?type=…` 等）。
   */
  const url = new URL(context.request.url);
  return next(`${parsed.rest}${url.search}`);
});
