/**
 * `GET /api/admin/experience-accounts`
 *
 * **デモ／スペシャルの名簿を「1 人 1 行」で返す読み取り専用の口 (PR-E)。**
 * 正本 `docs/specs/special_demo_integration_spec_20261022.md` §4.5 (＋裁定 7)。
 *
 * 【**POST は作らない**】登録・削除・除外は既存の
 * `/api/admin/demo-accounts` と `/api/admin/special-accounts` のまま。
 * どちらも PR-B で `canonicalUidForRegistration` を通るので、
 * **uid を決める口はいまも 1 つだけ**。ここに書き込みを足すと
 * 裁定 7 が禁じた「UID 分裂の経路」が 1 本増える。
 *
 * 【PII】メールの現物も生年月日の実値も返さない
 * (`experience-admin.ts` が sha256・マスクだけに落としている)。
 *
 * 認可は他の admin API と同じ Bearer `ADMIN_API_KEY` (`isAdminAuthorized`)。
 * UI は wellfort-site 側 (`/admin/experience-accounts`)。
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../lib/api-auth';
import { refreshConfig } from '../../../lib/app-config';
import { listExperienceAccounts } from '../../../lib/experience-admin';
import { getAccountProgress } from '../../../lib/account-progress';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const GET: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    // 一覧は必ず**最新を取りに行ってから**返す (TTL 45 秒の残りで古い値を見せない)。
    await refreshConfig(true);
    const list = listExperienceAccounts();
    /*
     * AI問診 / スキャンの進捗を uid ごとに添える (既存の special 画面と同じ)。
     * **失敗しても一覧は返す** (status が空になるだけで画面は壊れない)。
     */
    const status = await getAccountProgress(list.rows.map((r) => r.uid).filter(Boolean));
    return json({ ok: true, ...list, status });
  } catch (e) {
    return json({ ok: false, error: 'list_failed', detail: String((e as { message?: string })?.message ?? e) }, 500);
  }
};
