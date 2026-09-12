// GET /api/admin/ad-hoc-diagnosis/file?batchId=...&fileId=...
// ZIP の中の 1 ファイルの**生バイト列**を返す。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §11.5 ・ Phase B2.1
//
// **なぜ要るか**: 遺伝子 PDF はページ画像にしてから LLM へ渡すが、
// **PDF → 画像はブラウザ (pdf.js) が担う**。ZIP は S3 に在ってブラウザは中身を持たないので、
// サーバが ZIP から**その 1 エントリだけ**を読んで返す。
//
// **base64 にしない。** JSON へ載せると 4/3 に膨らむので、`application/pdf` のまま返す
// (レスポンスは Vercel の 4.5MB 制限=リクエストボディ の対象外)。
//
// **ZIP 全体をメモリに載せない** — `S3RangeReader` が必要な範囲だけを読む。
//
// **【Phase B2.1 で作り直し】以前は `analyzeOpened` を呼んで sha256 で引き当てていた。**
// あれは **ZIP の全エントリを展開してハッシュを取る**ので、遺伝子 PDF を 1 枚取り出すたびに
// 159MB を読み直していた (この口だけでタイムアウトし得た)。
// いまは行が持つ `archive_entry_index` で**直接その 1 エントリへ行く**。
import type { APIRoute } from 'astro';
import { getS3Config } from '../../../../lib/s3';
import { openArchiveFromS3 } from '../../../../lib/ad-hoc-diagnosis/archive';
import { headAdHocZip } from '../../../../lib/ad-hoc-diagnosis/ticket';
import { getBatch, getFile } from '../../../../lib/ad-hoc-diagnosis/store';
import { sha256Hex } from '../../../../lib/ad-hoc-diagnosis/fingerprint';
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

    /*
     * **序数を持たない行は取り出せない** (分割分類より前に作られた行)。
     * 推測で探しに行かない — 分類し直せば序数が入る。
     */
    if (typeof file.archive_entry_index !== 'number') {
      return json({ ok: false, error: 'archive_entry_index_missing' }, 409);
    }

    const head = await headAdHocZip(batch.source_key, cfg);
    if (!head.ok) return json({ ok: false, error: head.error, detail: head.detail }, head.status);

    const archive = await openArchiveFromS3({ key: batch.source_key, knownSize: head.size, cfg });
    try {
      const bytes = await archive.readByIndex(file.archive_entry_index);

      /*
       * **中身が行と一致することを必ず確かめる。**
       * 序数は ZIP に固有なので、**別の ZIP に差し替えられていたら別のファイルが返る**
       * (バッチの ZIP は同じ key なので、上げ直されると中身だけ変わり得る)。
       * 遺伝子 PDF はこのあとページ画像にして LLM へ渡すため、
       * ここで取り違えると**別人の検査結果がその人物の納品物に入る**。
       */
      if (sha256Hex(bytes) !== file.sha256) {
        return json({ ok: false, error: 'archive_entry_hash_mismatch' }, 409);
      }

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
