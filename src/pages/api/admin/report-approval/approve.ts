/**
 * admin: AI疾病予防報告書を **承認してダッシュボードへ反映する**。
 *
 *   POST /api/admin/report-approval/approve   (Bearer ADMIN_API_KEY)
 *     body: { resultId, expectedRev, triggeredByEmail? }
 *
 * 正本: `docs/elith/AI疾病予防報告書_承認と再作成_仕様書.md` §5.2 / §9。
 *
 * 【`expectedRev`】画面が一覧で見たときの `publish_rev`。その間に再作成が入った回は
 * **承認せずに 409** を返す (確認していない紙面を承認しないため・受入条件 14)。
 *
 * 【承認した紙面の指紋を控える】紙面は保存されていないので、**承認した時点の
 * `ReportVM` の指紋 (SHA-256)** を `approved_report_hash` へ同じ update で書く。
 * 表示時に一致しなければ公開しない = 生成ロジックを直してデプロイした回は
 * 自動的に未承認相当へ戻る (仕様書 §3.3)。
 *
 * 【誰が承認したか】中継 (wellfort-site) が送るのは `triggeredByEmail` =
 * **サーバ検証済みの admin メール**で、**その名前のまま DB へは入らない**。
 * digest を作るのは**ここ** (`adminIdentity()` は鍵を持つ Scan-Chat-AI 側にしかない)。
 * 生 email は応答にもログにも出さない。
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { getServerSupabase } from '../../../../lib/supabase';
import { adminIdentity } from '../../../../lib/admin-identity';
import { approveReport, isResultId } from '../../../../lib/report-approval';
import { refreshConfig } from '../../../../lib/app-config';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const resultId = typeof body.resultId === 'string' ? body.resultId.trim() : '';
  if (!isResultId(resultId)) return json({ ok: false, error: 'invalid_result_id' }, 400);

  const expectedRev = Number(body.expectedRev);
  if (!Number.isInteger(expectedRev) || expectedRev < 0) {
    return json({ ok: false, error: 'invalid_expected_rev' }, 400);
  }

  const sb = getServerSupabase();
  if (!sb) return json({ ok: false, error: 'supabase_not_configured' }, 503);

  /*
   * **app_config を先に読む。** `report.sections.*` が章の順序・表示可否・見出し・
   * 開閉を決める = **紙面を決める**ので、指紋を取る前に表示経路と同じ値にそろえる
   * (`report.astro` もデータ取得より前に `refreshConfig()` を呼んでいる)。
   */
  await refreshConfig();

  // ★ 受けた生 email は digest へ落として以後触らない。鍵が無ければ null で記録する。
  const approvedBy = typeof body.triggeredByEmail === 'string'
    ? await adminIdentity(body.triggeredByEmail)
    : null;

  const r = await approveReport(sb as never, { resultId, expectedRev, approvedBy });
  if (!r.ok) {
    const status = r.error === 'not_pending_or_changed' ? 409
      : r.error === 'not_found' ? 404
      : r.error === 'fingerprint_failed' ? 422
      : r.error === 'migration_required' || r.error === 'supabase_not_configured' ? 503 : 500;
    return json(r, status);
  }
  return json(r);
};
