// POST /api/admin/transcos-emergency/preflight-entry
// **1 エントリだけ**読んで SHA-256 / マジック / ページ数 / 見出しを観測する。
// 159MB を 1 リクエストで読まないための分割単位。LLM を呼ばない。
import type { APIRoute } from 'astro';
import { preflightEntry } from '../../../../lib/transcos-emergency/run';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { actorFrom, authorized, fail, json, num, readJson, str } from './_shared';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);
  const runId = str(body?.runId);
  const entry = num(body?.entry);
  if (!runId || !isUuid(runId)) return json({ ok: false, error: 'invalid_run_id' }, 400);
  if (entry == null || !Number.isInteger(entry)) return json({ ok: false, error: 'invalid_entry' }, 400);
  try {
    const r = await preflightEntry({ runId, entry, actor: actorFrom(request) });
    if (!r.ok) return json(r, r.status);
    return json({ ok: true, probe: r.probe });
  } catch (err) {
    return fail(err, 'transcos/preflight-entry');
  }
};
