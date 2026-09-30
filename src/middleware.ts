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
import { publicOrigin } from './lib/public-url';
import {
  SHARE_COOKIE, resolveShareSession, touchShareSession, logShareEvent, classifyShareFailure, shareEnabled,
} from './lib/share-access';

/* ══════════════════════════════════════════════════════════════════════
 * ① origin 検査（Astro 標準の置き換え・2026-09-30）
 * ════════════════════════════════════════════════════════════════════ */

/** Astro と同じ集合（`node_modules/astro/dist/core/app/middlewares.js`）。 */
const FORM_CONTENT_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

function isFormLike(contentType: string | null): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return FORM_CONTENT_TYPES.some((t) => ct.includes(t));
}

/**
 * **クロスサイトの form POST を止める。**
 *
 * `astro.config.mjs` で `security.checkOrigin: false` にしたぶんをここで補う。
 * **判定の中身は Astro と同じ**で、比べる相手だけを変えてある:
 *
 *   Astro : request.headers.origin === url.origin        ← プロキシ内側 = https://localhost
 *   ここ  : request.headers.origin === publicOrigin(req) ← 転送ヘッダを見た公開 origin
 *
 * 【なぜ必要だったか】本番では `url.origin` が常に `https://localhost` なので
 * **isSameOrigin が常に false**、つまり検査が「常に拒否」に化けていた。
 * 実測で `POST /api/admin/lab-results/upload` (multipart) が 403 になっており、
 * **admin の原本アップロードが動いていなかった**。
 *
 * **緩めていない** — 公開 origin と一致しない form POST は今までどおり 403。
 * JSON (`application/json`) は form-like ではないので対象外。これも Astro と同じで、
 * クロスオリジンの JSON POST はブラウザの preflight が止める（こちらは CORS を返さない）。
 */
function originGuard(request: Request): Response | null {
  if (SAFE_METHODS.includes(request.method)) return null;
  const origin = request.headers.get('origin');
  const sameOrigin = origin !== null && origin === publicOrigin(request);
  const ct = request.headers.get('content-type');
  // content-type が無い POST も Astro は同じ扱い（同一 origin を要求する）。
  if (!ct || isFormLike(ct)) {
    if (!sameOrigin) {
      /*
       * **Astro 標準と同じ文言にしない**（2026-09-30）。
       * 同じ文言だと、実機でこれが出たときに **Astro が出したのか / こちらが出したのか
       * 区別できない**（実際それで切り分けに手間取った）。末尾に出所を入れる。
       */
      return new Response(`Cross-site ${request.method} form submissions are forbidden [welltect-origin-guard]`, {
        status: 403,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
  }
  return null;
}

/**
 * **共有セッション中に「見た」を記録するページ**（§26.1 の**閲覧系だけ**）。
 * `/result/<artifact_id>` だけは動的なので下で prefix 判定する。
 *
 * 【`/chat` と `/scan` を入れない】§26.1 では
 *   `chat_use` = `/api/live-token` または `/api/interview/export`
 *   `scan_use` = `/api/scan/save` または `/api/scan/jobs`
 * = **実際に使ったこと**を指す。ページを開いただけで `*_use` にすると
 * 「問診を利用した」「スキャンを利用した」の意味が変わり、
 * **admin が記録を読み違える**（開いて閉じただけの回が「利用」に見える）。
 * → 利用の記録は**各 API が `logShareApiEvent()` で**残す。
 */
const SHARE_VIEW_EVENTS: Record<string, import('./lib/share-access').ShareEvent> = {
  '/dashboard': 'dashboard_view',
  '/report': 'report_view',
  '/trend': 'trend_view',
  '/kit': 'kit_view',
  '/notices': 'notices_view',
};

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
  // ① まず origin 検査（Astro 標準の置き換え。**全リクエストが対象**）。
  const blocked = originGuard(context.request);
  if (blocked) return blocked;

  /*
   * ② **外部共有の解決**（§18.2 / §27.1）。
   *
   * Cookie が無ければ**何もしない**ので、一般利用者・admin の挙動は不変。
   * **毎リクエストで link 側の status / starts_at / expires_at まで見る**
   * （`resolveShareSession` の中）。セッションだけ見ると **revoke が効かない**。
   *
   * **失効していたら `locals.share` を置かないだけ**で 403 にはしない —
   * 各ページは未サインイン扱いになり、共有相手には通常のサインイン画面が出る。
   * 代理表示（URL が対象を名指ししている）と違い、**共有は Cookie なので
   * 「名指ししたものが出せない」状態にならない**。
   */
  /*
   * ②-0 **緊急停止**（§37）。`SHARE_ENABLED=off` のときだけ通る枝。
   *
   * **入口を塞ぐだけでは足りない。** Cookie を持っている人が `/dashboard` を
   * 開いたときに `locals.share` を置いてしまうと、**止めたのに対象者の健康情報が出る**。
   * → **共有セッションの解決ごと止める**（下の `if` に入らない）。
   * 本人（`welltect_v`）と Admin 代理表示は**素通り**なので影響しない。
   */
  const shareOff = !shareEnabled();
  if (shareOff) {
    const p0 = new URL(context.request.url).pathname;
    if (p0 === '/share' || p0.startsWith('/share/') || p0.startsWith('/api/share/')) {
      return new Response('503 Service Unavailable', {
        status: 503,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store, max-age=0',
          'referrer-policy': 'no-referrer',
          // 一時停止であることを機械にも伝える（恒久的な削除ではない）。
          'retry-after': '3600',
        },
      });
    }
  }

  const shareRaw = shareOff ? undefined : context.cookies.get(SHARE_COOKIE)?.value;
  if (shareRaw) {
    const sh = await resolveShareSession(shareRaw);
    if (sh) {
      /*
       * **admin / cron / ops / debug は共有セッションから触らせない**（§21.2 / §25）。
       *
       * B（admin API）と C（cron）は Bearer キーが要るので Cookie では通らないが、
       * **「通らないはず」を根拠にしない** — 将来 Cookie で入れる admin 画面が増えたときに
       * 静かに開く。`/api/debug/viewer` は **viewer をそのまま露出する**ので、
       * 共有相手に対象者の uid を渡してしまう（§26.2 と正面から衝突する）。
       * → **入口で 403 にする。**
       *
       * **「`locals.share` を置かずに素通しする」ではなく 403 にする**理由:
       * 素通しすると、端末の持ち主が admin だった場合に**共有相手の操作で
       * admin 画面が開ける**（§24.5「共有中は admin 権限を使えない」に反する）。
       */
      const p = new URL(context.request.url).pathname;
      if (
        p.startsWith('/admin/') || p === '/admin'
        || p.startsWith('/api/admin/') || p.startsWith('/api/cron/')
        || p.startsWith('/api/ops/') || p.startsWith('/api/debug/')
      ) {
        await logShareEvent({
          event: 'blocked_admin_access', request: context.request,
          linkId: sh.linkId, sessionId: sh.sessionId, viewerId: sh.viewerId, path: p,
        });
        return forbidden();
      }

      context.locals.share = sh;
      void touchShareSession(sh.sessionId);

      /*
       * **アクセス記録は 1 か所で取る**（§26.1）。9 枚のページへ散らすと必ず 1 枚漏れ、
       * **漏れたページは「見られた記録が残らない」**。PDF の「アクセス記録確認」は
       * 「誰がいつ何を見たか」を出す機能なので、抜けがあると意味を失う。
       * **path に UID を入れない**（`/result/<artifact_id>` は artifact_id までに留める）。
       */
      const ev = SHARE_VIEW_EVENTS[p] ?? (p.startsWith('/result/') ? 'result_view' : null);
      if (ev) {
        void logShareEvent({
          event: ev, request: context.request,
          linkId: sh.linkId, sessionId: sh.sessionId, viewerId: sh.viewerId, path: p,
        });
      }
    } else {
      /*
       * **失効の理由はログにだけ残す**（§26.1）。画面は理由を区別しない（§16.3）。
       * ここを取らないと「なぜ入れなくなったか」を後から誰も説明できない。
       */
      const why = await classifyShareFailure(shareRaw);
      if (why) void logShareEvent({ event: why, request: context.request, path: new URL(context.request.url).pathname });
    }
  }

  // ③ ここから先は代理表示だけ。
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
