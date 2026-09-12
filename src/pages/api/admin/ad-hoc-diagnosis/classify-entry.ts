// POST /api/admin/ad-hoc-diagnosis/classify-entry
// 分割分類 ②: ZIP の中の **1 エントリだけ**を読んで分類し、行を 1 つだけ書く。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §7 ・ Phase B2.1
//
// **1 リクエスト = ZIP 内 1 ファイル。** これがタイムアウトを避ける仕組みそのもの
// (タイムアウトを伸ばすのではなく、仕事を割る)。
//
// **受け取るのは `entryIndex` だけ。** 人物番号も format もクライアントからは受けない
// — サーバが `planArchive` で毎回引き直す (申告どおりに書くと別人のデータに混ざる)。
//
// **同じ序数を何度実行しても行は 1 つ** (`(batch_id, archive_entry_index)` で冪等)。
import type { APIRoute } from 'astro';
import { classifyEntry } from '../../../../lib/ad-hoc-diagnosis/service';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { actorFrom, authorized, fail, json, num, readJson, str } from './_shared';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);
  const batchId = str(body?.batchId);
  if (!batchId || !isUuid(batchId)) return json({ ok: false, error: 'invalid_batch_id' }, 400);

  const entryIndex = num(body?.entryIndex);
  if (entryIndex === null || !Number.isInteger(entryIndex) || entryIndex < 0) {
    return json({ ok: false, error: 'invalid_entry_index' }, 400);
  }

  try {
    const r = await classifyEntry({ batchId, entryIndex, actor: actorFrom(request) });
    if (!r.ok) return json(r, r.status);
    return json(r);
  } catch (err) {
    return fail(err, 'classify-entry');
  }
};
