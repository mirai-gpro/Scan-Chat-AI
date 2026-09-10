// GET /api/admin/ad-hoc-diagnosis/status?batchId=...
// 画面が見る状態 (バッチ / 人物 / ファイル / 出力 / 監査)。
// batchId 無しなら一覧を返す。
import type { APIRoute } from 'astro';
import { batchStatus, listBatches } from '../../../../lib/ad-hoc-diagnosis/service';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { authorized, fail, json } from './_shared';

export const prerender = false;

export const GET: APIRoute = async ({ request, url }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const batchId = url.searchParams.get('batchId');
  try {
    if (!batchId) {
      const rows = await listBatches();
      return json({ ok: true, batches: rows });
    }
    if (!isUuid(batchId)) return json({ ok: false, error: 'invalid_batch_id' }, 400);
    const r = await batchStatus(batchId);
    if (!r.ok) return json(r, r.status);
    return json(r);
  } catch (err) {
    return fail(err, 'status');
  }
};
