// GET /api/admin/ad-hoc-diagnosis/file?batchId=...&fileId=...
// ZIP の中の 1 ファイルの**生バイト列**を返す。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §11.5
//
// **なぜ要るか**: 遺伝子 PDF はページ画像にしてから LLM へ渡すが、
// **PDF → 画像はブラウザ (pdf.js) が担う**。ZIP は S3 に在ってブラウザは中身を持たないので、
// サーバが ZIP から**その 1 エントリだけ**を読んで返す。
//
// **base64 にしない。** JSON へ載せると 4/3 に膨らむので、`application/pdf` のまま返す
// (レスポンスは Vercel の 4.5MB 制限=リクエストボディ の対象外)。
//
// **ZIP 全体をメモリに載せない** — `S3RangeReader` が必要な範囲だけを読む。
import type { APIRoute } from 'astro';
import { getS3Config } from '../../../../lib/s3';
import { openArchiveFromS3 } from '../../../../lib/ad-hoc-diagnosis/archive';
import { analyzeOpened } from '../../../../lib/ad-hoc-diagnosis/pipeline';
import { headAdHocZip } from '../../../../lib/ad-hoc-diagnosis/ticket';
import { getBatch, getFile } from '../../../../lib/ad-hoc-diagnosis/store';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { authorized, fail, json } from './_shared';

export const prerender = false;

export const GET: APIRoute = async ({ request, url }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const batchId = url.searchParams.get('batchId');
  const fileId = url.searchParams.get('fileId');
  if (!batchId || !isUuid(batchId)) return json({ ok: false, error: 'invalid_batch_id' }, 400);
  if (!fileId || !isUuid(fileId)) return json({ ok: false, error: 'invalid_file_id' }, 400);

  try {
    const cfg = getS3Config();
    if (!cfg) return json({ ok: false, error: 's3_not_configured' }, 503);

    const batch = await getBatch(batchId);
    if (!batch) return json({ ok: false, error: 'batch_not_found' }, 404);
    const file = await getFile(fileId);
    if (!file || file.batch_id !== batchId) return json({ ok: false, error: 'file_not_found' }, 404);

    const head = await headAdHocZip(batch.source_key, cfg);
    if (!head.ok) return json({ ok: false, error: head.error, detail: head.detail }, head.status);

    const archive = await openArchiveFromS3({ key: batch.source_key, knownSize: head.size, cfg });
    try {
      // **`sha256` で引き当てる。** 元ファイル名は DB に無い (§8.1) ので、
      // ZIP を解析し直して同じ中身のエントリを探す。
      const analysis = await analyzeOpened(archive);
      const all = [...analysis.subjects.flatMap((s) => s.files), ...analysis.batchReference];
      const hit = all.find((f) => f.sha256 === file.sha256);
      if (!hit) return json({ ok: false, error: 'entry_not_found_in_zip' }, 404);

      const bytes = await archive.read(hit.path);
      return new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          'content-type': file.mime_type ?? 'application/octet-stream',
          'content-length': String(bytes.length),
          // **キャッシュさせない** (検査データなので中間で保持させない)
          'cache-control': 'no-store',
        },
      });
    } finally {
      await archive.close();
    }
  } catch (err) {
    return fail(err, 'file');
  }
};
