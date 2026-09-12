// POST /api/admin/ad-hoc-diagnosis/classify-finalize
// 分割分類 ③: 全エントリが済んでいることを確かめ、人物の fingerprint を決めて締める。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §6.2 / §7 ・ Phase B2.1
//
// **1 件でも残っていれば 409 `classification_incomplete`** を返して締めない
// (途中まで分類しただけのバッチを `classified` と名乗らせない)。
// **返すのは残件数だけ** — どのファイルが残っているかを path で示さない (§8.1)。
import type { APIRoute } from 'astro';
import { classifyFinalize } from '../../../../lib/ad-hoc-diagnosis/service';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { actorFrom, authorized, fail, json, readJson, str } from './_shared';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);
  const batchId = str(body?.batchId);
  if (!batchId || !isUuid(batchId)) return json({ ok: false, error: 'invalid_batch_id' }, 400);

  try {
    const r = await classifyFinalize(batchId, actorFrom(request));
    if (!r.ok) return json(r, r.status);
    return json(r);
  } catch (err) {
    return fail(err, 'classify-finalize');
  }
};
