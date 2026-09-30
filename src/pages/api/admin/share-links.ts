/**
 * admin: **セキュア共有リンク**の発行 / 一覧 / 停止 / 再発行 / 失効 / ログ閲覧。
 *
 * 正本: `docs/specs/secure_shared_access_and_admin_impersonation_spec_20260930.md`
 *       §33.4（この口）/ §15（hash-only）/ §27（停止・失効）。
 *
 * 【デモ枠・スペシャル枠とは別の口】3 つとも目的が違う（仕様書 §33.1）:
 *   デモ     … **ダミー**を社外に見せる
 *   スペシャル … **本人**が自分の実データを使う
 *   共有     … **他人**に本人の実データを見せる   ← これ
 * 同じ画面・同じ口に置くと必ず取り違えるので分けてある。
 *
 * 【raw token は発行の瞬間しか返らない】DB は `sha256(token)` しか持たない（§15.1）。
 * 「さっきの URL をもう一度」には応えられない。**それは欠陥ではなく設計**で、
 * 応えるには raw を保存することになる。再配布は `regenerate`（旧 URL は失効する）。
 *
 *   GET  ?target_uid=<uuid>&include_hidden=1   → { ok, rows:[…] }
 *        ?log=<link_id>&limit=<n>              → { ok, logs:[…] }
 *   POST { create: { target_uid, expires_at, starts_at?, label?, purpose?,
 *                    scope?:{interview,scan}, target_origin? } }
 *          → { ok, id, url, expires_at }   ★ url はこの応答にしか出ない
 *        { pause:<id> } / { resume:<id> } / { revoke:<id> }
 *        { regenerate:<id> }               → { ok, url }
 *        { hide:<id> }   / { unhide:<id> }
 *
 * 認可: wellfort-site から Bearer ADMIN_API_KEY（`api-auth.ts`）。
 * UI は wellfort-site 側（`/admin/share-links`）。**このリポジトリに admin 画面は作らない。**
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../lib/api-auth';
import { publicOrigin } from '../../../lib/public-url';
import {
  createShareLink, listShareLinksWithStats, listShareLogs,
  setShareLinkStatus, setShareLinkHidden, regenerateShareLink,
} from '../../../lib/share-access';

export const prerender = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function unauthorized(): Response {
  return json({ ok: false, error: 'unauthorized' }, 401);
}

/** 共有 URL を組み立てる。**`request.url` から作らない**（本番では `https://localhost`）。 */
function shareUrl(request: Request, token: string): string {
  return `${publicOrigin(request)}/share/${token}`;
}

export const GET: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return unauthorized();
  const u = new URL(request.url);

  const logId = u.searchParams.get('log');
  if (logId) {
    if (!UUID_RE.test(logId)) return json({ ok: false, error: 'invalid_link_id' }, 400);
    const limit = Number(u.searchParams.get('limit') ?? '200');
    return json({ ok: true, logs: await listShareLogs(logId, Number.isFinite(limit) ? limit : 200) });
  }

  const target = u.searchParams.get('target_uid');
  const rows = await listShareLinksWithStats({
    targetUid: target && UUID_RE.test(target) ? target : null,
    includeHidden: u.searchParams.get('include_hidden') === '1',
  });
  return json({ ok: true, rows });
};

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  /* ── 発行 ─────────────────────────────────────────── */
  if (body.create && typeof body.create === 'object') {
    const c = body.create as Record<string, unknown>;
    const targetUid = String(c.target_uid ?? '');
    const expiresAt = String(c.expires_at ?? '');
    if (!UUID_RE.test(targetUid)) return json({ ok: false, error: 'invalid_target_uid' }, 400);
    if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) {
      return json({ ok: false, error: 'invalid_expires_at' }, 400);
    }
    /*
     * **期限は必ず未来**。過去の期限で発行すると「発行したのに開けない」URL が配られ、
     * 受け取った側は `/share/unavailable`（理由を出さない画面）に当たって迷う。
     */
    if (Date.parse(expiresAt) <= Date.now()) return json({ ok: false, error: 'expires_at_in_past' }, 400);

    const sc = (c.scope ?? {}) as Record<string, unknown>;
    const issued = await createShareLink({
      targetUid,
      expiresAt,
      startsAt: typeof c.starts_at === 'string' && c.starts_at ? c.starts_at : null,
      label: typeof c.label === 'string' && c.label.trim() ? c.label.trim().slice(0, 120) : null,
      purpose: typeof c.purpose === 'string' && c.purpose.trim() ? c.purpose.trim().slice(0, 300) : null,
      // **既定は「閲覧だけ」にしない** — 共有相手に問診・スキャンを使ってもらうのが本機能の
      // 目的（PDF）なので、明示的に false が来たときだけ落とす。
      scope: { interview: sc.interview !== false, scan: sc.scan !== false },
      targetOrigin: c.target_origin === 'staging' ? 'staging' : 'production',
      createdBy: typeof c.created_by === 'string' ? c.created_by.slice(0, 200) : null,
    });
    // 対象 uid が実在しない / DB 未設定 は区別せず 400（存在確認の口にしない）。
    if (!issued) return json({ ok: false, error: 'create_failed' }, 400);

    return json({
      ok: true,
      id: issued.id,
      // ★ **ここにしか出ない。** 画面はこの応答をコピーさせる（§15.3）。
      url: shareUrl(request, issued.token),
      expires_at: issued.expiresAt,
    });
  }

  /* ── 状態変更 ─────────────────────────────────────── */
  const ops: [keyof typeof body, () => Promise<boolean>][] = [];
  const idOf = (k: string): string => String((body as Record<string, unknown>)[k] ?? '');

  if (body.pause)   ops.push(['pause',   () => setShareLinkStatus(idOf('pause'), 'paused')]);
  if (body.resume)  ops.push(['resume',  () => setShareLinkStatus(idOf('resume'), 'active')]);
  if (body.revoke)  ops.push(['revoke',  () => setShareLinkStatus(idOf('revoke'), 'revoked')]);
  if (body.hide)    ops.push(['hide',    () => setShareLinkHidden(idOf('hide'), true)]);
  if (body.unhide)  ops.push(['unhide',  () => setShareLinkHidden(idOf('unhide'), false)]);

  if (body.regenerate) {
    const id = idOf('regenerate');
    if (!UUID_RE.test(id)) return json({ ok: false, error: 'invalid_link_id' }, 400);
    const r = await regenerateShareLink(id);
    if (!r) return json({ ok: false, error: 'regenerate_failed' }, 400);
    // **旧 URL と旧セッションは失効済み**（`regenerateShareLink` の中）。
    return json({ ok: true, url: shareUrl(request, r.token) });
  }

  if (ops.length === 0) return json({ ok: false, error: 'no_operation' }, 400);
  for (const [k, run] of ops) {
    if (!UUID_RE.test(idOf(String(k)))) return json({ ok: false, error: 'invalid_link_id' }, 400);
    if (!await run()) return json({ ok: false, error: `${String(k)}_failed` }, 400);
  }
  return json({ ok: true, rows: await listShareLinksWithStats({ includeHidden: true }) });
};
