// POST /api/admin/ad-hoc-diagnosis/export
// Elith 納品セットを組む。**既定は dry-run。**
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §15 / §24.5
//
// **本番の Elith 納品領域へ実際に書くのは `dryRun:false` のときだけ**で、
// 呼び出し側 (管理画面) が明示したときに限る。既定を実書き込みにしない。
import type { APIRoute } from 'astro';
import { assembleBatch } from '../../../../lib/ad-hoc-diagnosis/service';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { actorFrom, authorized, fail, json, readJson, str } from './_shared';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);
  const batchId = str(body?.batchId);
  if (!batchId || !isUuid(batchId)) return json({ ok: false, error: 'invalid_batch_id' }, 400);

  // **既定 true。** `dryRun` を明示的に false にしたときだけ実書き込み。
  const dryRun = body?.dryRun !== false;

  try {
    const r = await assembleBatch({ batchId, dryRun, actor: actorFrom(request) });
    if (!r.ok) return json(r, r.status);
    return json(r);
  } catch (err) {
    return fail(err, 'export');
  }
};
