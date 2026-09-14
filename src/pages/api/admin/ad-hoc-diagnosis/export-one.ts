// POST /api/admin/ad-hoc-diagnosis/export-one
// **E2E 確認用に、1 人 × 1 format の納品 JSON だけを実際の Elith S3 へ書く。**
// 正本: 最終指示書「臨時診断バッチ — E2E確認用『1 JSONのみS3書き出し』指示」§1〜§12
//
// **これは正式なバッチ納品ではない。**
//   - 通常の `export` (`assembleBatch`) の挙動は 1 文字も変えていない。
//   - 通常納品の「1 人でも未完成なら部分納品禁止」も緩めていない。
//   - この口で書いても `batch.status` は `completed` にならない。
//
// **安全側の検査は 1 つも外していない**: env 2 本のゲート / 書き込み先の完全一致 /
// key の形 / 既存オブジェクトの事前確認 / create-only PUT (`IfNoneMatch: '*'`)。
import type { APIRoute } from 'astro';
import { exportSingleDeliveryFile } from '../../../../lib/ad-hoc-diagnosis/service';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { AD_HOC_DELIVERY_FORMAT_IDS } from '../../../../lib/ad-hoc-diagnosis/write-guard';
import { actorFrom, authorized, fail, json, readJson, str } from './_shared';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);

  const batchId = str(body?.batchId);
  if (!batchId || !isUuid(batchId)) return json({ ok: false, error: 'invalid_batch_id' }, 400);
  const subjectId = str(body?.subjectId);
  if (!subjectId || !isUuid(subjectId)) return json({ ok: false, error: 'invalid_subject_id' }, 400);

  /*
   * **format は allowlist から選ばせる。** 自由文字列を通すと、key の検査を抜ける形の
   * 名前を渡そうとする試みをここで止められない。
   */
  const formatId = str(body?.formatId);
  if (!formatId || !(AD_HOC_DELIVERY_FORMAT_IDS as readonly string[]).includes(formatId)) {
    return json({ ok: false, error: 'invalid_format_id' }, 400);
  }

  /*
   * **検査日は呼び出し側が明示する。** 原資料に印字された日付を操作者が入れ、
   * 生成された `test_date` と一致しなければ書かない (today 混入の番人・§5)。
   * 省略は許さない — 省略できると「何日でもよい」になってしまう。
   */
  const expectTestDate = str(body?.expectTestDate);
  if (!expectTestDate || !/^\d{4}-\d{2}-\d{2}$/.test(expectTestDate)) {
    return json({ ok: false, error: 'invalid_expect_test_date' }, 400);
  }

  try {
    const r = await exportSingleDeliveryFile({
      batchId, subjectId, formatId, expectTestDate, actor: actorFrom(request),
    });
    if (!r.ok) return json(r, r.status);
    return json(r);
  } catch (err) {
    return fail(err, 'export-one');
  }
};
