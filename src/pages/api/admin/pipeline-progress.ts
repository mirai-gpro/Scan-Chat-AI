/**
 * admin: 検査パイプライン進捗管理の**事実**を複数 uid ぶんまとめて返す (read-only)。
 *
 *   POST /api/admin/pipeline-progress   (Bearer ADMIN_API_KEY)
 *   body: { subjects: [{ diagnostic_user_id, plan_code? }, ...] }   // 最大 200 件
 *
 * UI は wellfort-site `/admin/lab-progress` (責務分界: admin UI=wellfort-site / 処理=Scan-Chat-AI)。
 * **状態の判定はしない** — 返すのは事実だけで、判定は wellfort 側の 1 か所が持つ。
 * **1 uid = 1 リクエストにしない** — wellfort 側は 200 件ずつまとめて呼ぶ。
 *
 * 応答に PII・検査値・外部検査ID の値・報告書本文は載らない (`pipeline-progress-facts.ts`)。
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../lib/api-auth';
import { getServerSupabase } from '../../../lib/supabase';
import { refreshConfig } from '../../../lib/app-config';
import { loadPipelineFacts, parseSubjects } from '../../../lib/pipeline-progress-facts';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: { subjects?: unknown } | null = null;
  try { body = await request.json(); } catch { body = null; }
  const parsed = parseSubjects(body?.subjects);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  if (!getServerSupabase()) return json({ ok: false, error: 'supabase_not_configured' }, 503);

  // デモ/スペシャルの判定と `elith.plan_formats` は app_config に依るので**処理の前に**読む。
  await refreshConfig().catch(() => undefined);

  const res = await loadPipelineFacts(parsed.subjects);
  if (!res) return json({ ok: false, error: 'supabase_not_configured' }, 503);
  return json({ ok: true, facts: res.facts, sources: res.sources });
};
