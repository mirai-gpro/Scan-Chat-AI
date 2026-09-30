/**
 * **handoff を pending へ交換する（claim）。POST だけ。**
 *
 * 正本: `docs/specs/secure_shared_access_and_admin_impersonation_spec_20260930.md` §12.8 ①。
 *
 *   POST (form or json) { token } → 303 /admin/handoff/continue
 *                                    + Set-Cookie: welltect_handoff_pending（10 分）
 *
 * 【ここで raw token は死ぬ】DB 側の条件付き UPDATE が `pending_digest is null` を
 * 要求するので、**同じ handoff から pending は 1 つしか作れない**。
 * 2 度目は 0 行 = 403。
 *
 * 【認証はまだ要らない】pending は**権限ではなく札**。権限は
 * `/admin/handoff/continue` の `admin_identity` 一致で初めて成立する（§12.7 約束 4）。
 * ここで admin を要求しないのは、**未サインインの admin を Google 認証へ通す**ため
 * （旧 `?u=` 経路と同じ使い勝手を保つ・§12.7）。
 *
 * 【Cookie に何を入れないか】`target_uid` も raw handoff token も入れない。
 * 入るのは**この交換のためだけの opaque な札**で、DB 側は `sha256(札)` で引く。
 */
import type { APIRoute } from 'astro';
import {
  HANDOFF_PENDING_COOKIE, PENDING_TTL_SEC, claimHandoff, OPAQUE_RE,
} from '../../../../lib/admin-impersonation';

export const prerender = false;

function deny(): Response {
  return new Response('403 Forbidden', {
    status: 403,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

async function readToken(request: Request): Promise<string> {
  const ct = request.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const b = (await request.json().catch(() => null)) as { token?: unknown } | null;
    return typeof b?.token === 'string' ? b.token : '';
  }
  const form = await request.formData().catch(() => null);
  const v = form?.get('token');
  return typeof v === 'string' ? v : '';
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const token = await readToken(request);
  if (!OPAQUE_RE.test(token)) return deny();

  const pending = await claimHandoff(token);
  // 不存在 / 既に claim 済 / consumed / 60 秒切れ を**区別しない**（§12.7 約束 6）。
  if (!pending) return deny();

  cookies.set(HANDOFF_PENDING_COOKIE, pending, {
    httpOnly: true,
    secure: import.meta.env.DEV !== true,
    sameSite: 'lax',
    path: '/',
    maxAge: PENDING_TTL_SEC,
  });

  const NEXT = '/admin/handoff/continue';

  /*
   * **JSON で来たら JSON で返す**（2026-09-30）。
   *
   * 着地ページは **form ではなく `fetch` + JSON** で叩く。form (`x-www-form-urlencoded`) は
   * **origin 検査の対象**で、実機で `Cross-site POST form submissions are forbidden` に
   * 当たり続けた。JSON は form-like ではないので**この検査の対象外**であり、
   * **クロスオリジンからの JSON POST はブラウザの preflight が止める**
   * （こちらは CORS を返さない）ので、**守りは弱くならない**。
   *
   * 呼び出し側は `next` へ自分で遷移する（リダイレクト追跡に依存しない）。
   */
  if ((request.headers.get('content-type') ?? '').includes('application/json')) {
    return new Response(JSON.stringify({ ok: true, next: NEXT }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  /*
   * **303** で GET へ落とす。ここで raw token が URL から消える。
   * ブラウザの履歴に残るのは `/admin/handoff/continue` だけになる。
   * （JS が無い環境の form 送信用。通常は上の JSON 経路を通る。）
   */
  return new Response(null, {
    status: 303,
    headers: {
      location: NEXT,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
};
