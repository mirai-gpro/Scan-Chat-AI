/**
 * admin: 撮影台帳の **確認（値はそのまま）／訂正（値を直す）**（§8.4 / §12.1）。
 *
 *   POST /api/admin/external-id-captures/correct   (Bearer ADMIN_API_KEY)
 *     body: { captureId, value?, reason, triggeredByEmail? }
 *
 * `value` 省略 = 証跡を見て**この値で正しい**と確認する（`review_required` の出口）。
 * `value` あり = 訂正。旧行は `superseded` になり `previous_value` に残る。
 *
 * 【越えてはいけない線（仕様 §12.1）】
 *   - **`status` を直に書き換えない。** 書き込みは `persistExternalIdCapture()` 経由だけ。
 *   - **`lab_test_link_status` を手で `linked` にしない。** 紐付けの成否は関数が決める。
 *   - **ゲートは 1 行も触らない。** 確定しても `gate.allowed=false` のまま返る回がある
 *     （`conflict` / `deferred` / 接頭辞違い）。そのまま画面に出す。
 *
 * 【誰が訂正したか】中継（wellfort-site）が送るのは `triggeredByEmail` =
 * **サーバ検証済みの admin メール**で、**その名前のまま DB へは入らない**。
 * digest を作るのは**ここ**（`adminIdentity()` の鍵は Scan-Chat-AI 側にしかない）。
 * **素の `sha256(email)` にしない**（`CLAUDE.md`・メールは列挙可能）。
 * 生 email は応答にもログにも出さない。
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { getServerSupabase } from '../../../../lib/supabase';
import { adminIdentity } from '../../../../lib/admin-identity';
import { refreshConfig } from '../../../../lib/app-config';
import { correctAdminCapture } from '../../../../lib/external-id-admin';
import { adminConfigFromAppConfig } from '../../../../lib/external-id-admin-config';

export const prerender = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);

  const captureId = typeof body.captureId === 'string' ? body.captureId.trim() : '';
  if (!UUID_RE.test(captureId)) return json({ ok: false, error: 'invalid_id' }, 400);

  const reason = typeof body.reason === 'string' ? body.reason : '';
  const value = typeof body.value === 'string' ? body.value : null;

  const sb = getServerSupabase();
  if (!sb) return json({ ok: false, error: 'supabase_not_configured' }, 503);
  await refreshConfig().catch(() => undefined);

  /*
   * **操作者は必須。** 監査に「誰が」が残らない訂正を通さない
   * （仕様 §8.4 = 変更前 / 変更後 / 理由 / 操作者 / 時刻）。
   */
  const correctedBy = typeof body.triggeredByEmail === 'string'
    ? await adminIdentity(body.triggeredByEmail)
    : null;
  if (!correctedBy) {
    return json({
      ok: false, error: 'operator_required',
      detail: '操作者を特定できませんでした（監査に残せないため中止しました）',
    }, 400);
  }

  const res = await correctAdminCapture({
    sb, captureId, value, reason, correctedBy, cfg: adminConfigFromAppConfig(),
  });
  if (!res.ok) return json({ ok: false, error: res.error, detail: res.detail }, res.status);

  return json({
    ok: true,
    changed: res.changed,
    // **全文は返さない**（マスクだけ）。
    masked: res.record.masked,
    status: res.record.status,
    review_reasons: res.record.reviewReasons,
    linked: res.record.labTestLinkStatus === 'linked',
    link_status: res.record.labTestLinkStatus,
    link_detail: res.record.labTestLinkDetail,
    // 確定しても先へ進めない回があるので、**ゲートの判定をそのまま返す**。
    gate: res.gate,
  });
};
