// GET /api/admin/transcos-emergency/status?runId=...
// 画面が見る進捗。**状態は 4 つだけ** (準備完了 / 処理中 / 要確認 / 完了・§9)。
import type { APIRoute } from 'astro';
import { findRun, runStatus, GENETIC_PAGES, pagePlan } from '../../../../lib/transcos-emergency/run';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { authorized, fail, json } from './_shared';

export const prerender = false;

export const GET: APIRoute = async ({ request, url }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    const q = url.searchParams.get('runId');
    const runId = q && isUuid(q) ? q : (await findRun())?.id ?? null;
    if (!runId) return json({ ok: true, runId: null, subjects: [], done: 0, total: 0 });
    const r = await runStatus(runId);
    if (!r) return json({ ok: false, error: 'not_transcos_run' }, 409);
    return json({ ok: true, ...r, geneticPages: [...GENETIC_PAGES], plan: pagePlan() });
  } catch (err) {
    return fail(err, 'transcos/status');
  }
};
