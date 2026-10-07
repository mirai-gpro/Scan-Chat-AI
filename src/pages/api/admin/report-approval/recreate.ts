/**
 * admin: AI疾病予防報告書を **1 件だけ、最新版生成処理で再作成する**。
 *
 *   POST /api/admin/report-approval/recreate   (Bearer ADMIN_API_KEY)
 *     body: { resultId }
 *
 * 正本: `docs/elith/AI疾病予防報告書_承認と再作成_仕様書.md` §6.3 / §6.4。
 *
 * 【一括 API は作らない】**1 リクエスト = 1 件**。複数選択は管理画面が
 * この口を 1 件ずつ順番に叩く (キュー・ジョブ・一括トランザクションを作らない)。
 *
 * 【クライアントから元データを指定させない】受け取るのは `resultId` だけ。
 * S3 キー・受領 JSON 本文・生成パラメータは**受け取らない**。
 * 材料はサーバが既存の関連付け (`source_key` → S3 / DB の控え) から解決する。
 *
 * 【失敗しても既存の報告書と承認状態を変えない】判断と順序は
 * `report-approval.ts` の `recreateReport()` に集約してある。
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { getServerSupabase } from '../../../../lib/supabase';
import { recreateReport, isResultId } from '../../../../lib/report-approval';

export const prerender = false;
/** S3 を読み直して生成まで通すので、既定の 60s では足りないことがある。 */
export const config = { maxDuration: 300 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 失敗の種類 → HTTP。**「対象 0 件」と「設定の不備」を混同させない。** */
const STATUS: Record<string, number> = {
  invalid_result_id: 400,
  not_found: 404,
  not_recreatable: 409,
  changed_during_recreate: 409,
  migration_required: 503,
  s3_not_configured: 503,
  supabase_not_configured: 503,
  source_not_found: 422,
  source_incomplete: 422,
  source_read_failed: 502,
  generate_failed: 422,
  generated_empty: 422,
  save_failed: 500,
  db_failed: 500,
};

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const resultId = typeof body.resultId === 'string' ? body.resultId.trim() : '';
  if (!isResultId(resultId)) return json({ ok: false, error: 'invalid_result_id' }, 400);

  const sb = getServerSupabase();
  if (!sb) return json({ ok: false, error: 'supabase_not_configured', id: resultId }, 503);

  const r = await recreateReport(sb as never, { resultId });
  if (!r.ok) return json(r, STATUS[r.error ?? ''] ?? 500);
  return json(r);
};
