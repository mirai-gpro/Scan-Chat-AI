// POST /api/admin/ad-hoc-diagnosis/upload-ticket
// バッチを作り、ZIP を S3 へ直接置くための presigned PUT を返す。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §5.2
//
// **ブラウザへ返すのは url / headers / expiresIn / batchId だけ。**
// `ADMIN_API_KEY` は当然出さない (中継のサーバ側だけが持つ)。
import type { APIRoute } from 'astro';
import { createBatchWithTicket } from '../../../../lib/ad-hoc-diagnosis/service';
import { isSha256Hex } from '../../../../lib/ad-hoc-diagnosis/fingerprint';
import { actorFrom, authorized, fail, json, num, readJson, str } from './_shared';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);

  const title = str(body.title) ?? '臨時診断バッチ';
  const sha = str(body.sourceSha256);
  const size = num(body.declaredSize ?? body.contentLength);

  // **SHA-256 はブラウザが逐次計算して送る** (spec §11.6)。形だけは必ず検証する。
  if (!sha || !isSha256Hex(sha)) {
    return json({ ok: false, error: 'invalid_sha256', detail: '64 桁の 16 進小文字が必要です' }, 400);
  }
  if (size == null || size <= 0) return json({ ok: false, error: 'invalid_size' }, 400);

  try {
    const r = await createBatchWithTicket({
      title,
      sourceSha256: sha,
      declaredSize: size,
      contentType: str(body.contentType) ?? undefined,
      requiredFormats: Array.isArray(body.requiredFormats) ? (body.requiredFormats as string[]) : undefined,
      optionalFormats: Array.isArray(body.optionalFormats) ? (body.optionalFormats as string[]) : undefined,
      retainOriginals: body.retainOriginals === true,
      actor: actorFrom(request),
    });
    if (!r.ok) return json(r, r.status);
    return json({
      ok: true,
      batchId: r.batch.id,
      status: r.batch.status,
      upload: r.upload,
      duplicates: r.duplicates,
    });
  } catch (err) {
    return fail(err, 'upload-ticket');
  }
};
