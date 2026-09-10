// POST /api/admin/ad-hoc-diagnosis/health-age
// 人物ごとのウェルネス年齢。**既存 `computeWellnessAge()` を呼ぶだけ。**
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §16
//
// **全員算出できると仮定しない。** `unavailable` でも人物を failed にしない。
import type { APIRoute } from 'astro';
import { healthAgeCheck } from '../../../../lib/ad-hoc-diagnosis/service';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { authorized, fail, json, readJson, str } from './_shared';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);
  const batchId = str(body?.batchId);
  if (!batchId || !isUuid(batchId)) return json({ ok: false, error: 'invalid_batch_id' }, 400);
  try {
    const r = await healthAgeCheck(batchId);
    if (!r.ok) return json(r, r.status);
    return json(r);
  } catch (err) {
    return fail(err, 'health-age');
  }
};
