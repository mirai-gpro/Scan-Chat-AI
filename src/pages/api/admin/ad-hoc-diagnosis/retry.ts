// POST /api/admin/ad-hoc-diagnosis/retry
// 失敗したページ・ファイルを作り直す対象を返し、状態を pending へ戻す。
import type { APIRoute } from 'astro';
import { retryBatch } from '../../../../lib/ad-hoc-diagnosis/service';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { actorFrom, authorized, fail, json, readJson, str } from './_shared';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);
  const batchId = str(body?.batchId);
  if (!batchId || !isUuid(batchId)) return json({ ok: false, error: 'invalid_batch_id' }, 400);
  try {
    const r = await retryBatch(batchId, actorFrom(request));
    if (!r.ok) return json(r, r.status);
    return json(r);
  } catch (err) {
    return fail(err, 'retry');
  }
};
