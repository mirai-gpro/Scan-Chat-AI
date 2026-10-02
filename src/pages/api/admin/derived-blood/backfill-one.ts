/**
 * admin: **保存済みの人間ドック／健康診断 1 件を、派生 blood へ backfill する。**
 *
 * 正本: `docs/specs/healthcheckup_blood_extraction_spec_20261001.md` §10.6（発注者裁定 Q-11）。
 * 処理本体は `src/lib/derived-blood-backfill.ts`（**admin 画面と共用。二重管理しない**）。
 * この口は**認可と入出力だけ**を持つ。
 *
 * ```
 * POST { diagnosticUserId, testDate, apply?: false, allowReplace?: false }
 * ```
 *
 * 【認可は 2 系統（発注者指示 2026-10-02）】
 *   ① **管理者セッション Cookie**（`resolveViewer` → `viewer.isAdmin`）
 *      … 人が admin 画面から押す経路。**同一 origin の POST であることも必須**
 *      （Cookie 認証なので CSRF を origin で止める。`Origin` が無い POST は通さない）。
 *   ② **Bearer `ADMIN_API_KEY`**（`isAdminAuthorized`）… server-to-server 用途を残す。
 *      こちらは `Origin` を持たないので same-origin は課さない。
 *
 *   **`ADMIN_API_KEY` をブラウザへ渡さない。** 画面は ① で通す。
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { resolveViewer } from '../../../../lib/viewer';
import { runDerivedBloodBackfillOne } from '../../../../lib/derived-blood-backfill';

export const prerender = false;
/** 抽出 → insert → 読み直し → readiness → trend を 1 リクエストで通すので既定の 60s では足りないことがある。 */
export const config = { maxDuration: 300 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const POST: APIRoute = async (ctx) => {
  const { request } = ctx;

  /*
   * **same-origin は Cookie 経路の必須条件。**
   * `Origin` を持たない POST は Cookie では通さない（`!origin ||` を書かない）。
   * Bearer 経路は server-to-server なので `Origin` を課さない。
   */
  const origin = request.headers.get('origin');
  const here = new URL(request.url).origin;
  const sameOrigin = origin !== null && origin === here;

  const byKey = isAdminAuthorized(request);
  let byCookie = false;
  if (!byKey) {
    try {
      const viewer = await resolveViewer(ctx);
      byCookie = viewer.isAdmin === true && sameOrigin;
    } catch { byCookie = false; }
  }
  if (!byKey && !byCookie) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: { diagnosticUserId?: unknown; testDate?: unknown; apply?: unknown; allowReplace?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const r = await runDerivedBloodBackfillOne({
    diagnosticUserId: String(body.diagnosticUserId ?? ''),
    testDate: String(body.testDate ?? ''),
    apply: body.apply === true,
    allowReplace: body.allowReplace === true,
  });

  if (!r.ok) {
    return json({
      ok: false, error: r.error, detail: r.detail ?? null,
      supabase: r.supabase, dry_run: r.dryRun ?? null, result: r.result ?? null,
    }, r.status);
  }
  return json({
    ok: true, mode: r.mode, supabase: r.supabase,
    diagnostic_user_id: String(body.diagnosticUserId ?? '').trim().toLowerCase(),
    test_date: String(body.testDate ?? '').trim(),
    dry_run: r.dryRun,
    ...(r.mode === 'applied' ? { applied: r.applied } : {}),
  }, r.status);
};
