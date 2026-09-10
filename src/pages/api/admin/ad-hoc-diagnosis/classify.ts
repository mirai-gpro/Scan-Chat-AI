// POST /api/admin/ad-hoc-diagnosis/classify
// ZIP を開いて 人物分離 → 自動分類 → DB へ。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §5.2.1 / §6 / §7
//
// **冒頭で必ず HeadObject を通す** (申告値でなく実サイズで判定する)。
import type { APIRoute } from 'astro';
import { classifyBatch } from '../../../../lib/ad-hoc-diagnosis/service';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { actorFrom, authorized, fail, json, readJson, str } from './_shared';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);
  const batchId = str(body?.batchId);
  if (!batchId || !isUuid(batchId)) return json({ ok: false, error: 'invalid_batch_id' }, 400);

  try {
    const r = await classifyBatch(batchId, actorFrom(request));
    if (!r.ok) return json(r, r.status);
    return json(r);
  } catch (err) {
    return fail(err, 'classify');
  }
};
