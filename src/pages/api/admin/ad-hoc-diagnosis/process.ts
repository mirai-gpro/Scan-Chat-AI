// POST /api/admin/ad-hoc-diagnosis/process
// 解析して Elith JSON を作る (S3 へは書かない)。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §11 / §19.3
//
// 遺伝子 PDF は **1 ページ = 1 リクエスト** (Vercel の実行モデル)。
// ブラウザ (pdf.js) が作ったページ画像を `geneticPages` に載せて順に呼ぶ。
// **既存 `scanGeneticPage` を使う。新しいプロンプトを作らない。**
import type { APIRoute } from 'astro';
import { processBatch } from '../../../../lib/ad-hoc-diagnosis/service';
import { GENOPLAN_V1_REQUIRED_PAGES, isGenoplanV1RequiredPage } from '../../../../lib/elith-genetic';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { actorFrom, authorized, fail, json, readJson, str } from './_shared';

export const prerender = false;

/** data: URL でも生 base64 でも受ける (既存 `elith-scan.ts` と同じ受け方)。 */
function splitImage(v: unknown, fallbackMime: string): { base64: string; mimeType: string } | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s === '') return null;
  const m = /^data:([^;,]+);base64,(.+)$/i.exec(s);
  if (m) return { mimeType: m[1], base64: m[2] };
  return { base64: s, mimeType: fallbackMime };
}

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);
  const batchId = str(body?.batchId);
  if (!batchId || !isUuid(batchId)) return json({ ok: false, error: 'invalid_batch_id' }, 400);

  const pagesRaw = Array.isArray(body?.geneticPages) ? (body!.geneticPages as Record<string, unknown>[]) : [];
  const geneticPages: { fileId: string; page: number; imageBase64: string; mimeType: string }[] = [];
  /*
   * **対象外ページは黙って捨てない。** (spec §8.5)
   *
   * ここは Genoplan の 208/210 ページのうち **p10〜35 の 26 ページだけ**を通す関門で、
   * 範囲外が来たということは**呼び出し側が全ページ走査に戻っている**ということ。
   * silent skip にすると UI は「送った」つもりのまま進み、**誰も気づけない**。
   * だから `400 page_out_of_range` で落とし、どのページが弾かれたかを返す。
   *
   * 範囲の正本は `elith-genetic.ts` の `GENOPLAN_V1_REQUIRED_PAGES` (ここに数値を書かない)。
   */
  const rejected: number[] = [];
  for (const p of pagesRaw) {
    const fileId = str(p.fileId);
    const page = Number(p.page);
    const img = splitImage(p.image ?? p.imageBase64, str(p.mimeType) ?? 'image/jpeg');
    if (!fileId || !isUuid(fileId) || !Number.isInteger(page) || page < 1 || !img) continue;
    if (!isGenoplanV1RequiredPage(page)) {
      rejected.push(page);
      continue;
    }
    geneticPages.push({ fileId, page, imageBase64: img.base64, mimeType: img.mimeType });
  }
  if (rejected.length > 0) {
    return json({
      ok: false,
      error: 'page_out_of_range',
      // **健康情報は載せない。** 返すのはページ番号と許可範囲だけ。
      rejected_pages: rejected.slice(0, 50),
      required_pages: GENOPLAN_V1_REQUIRED_PAGES,
    }, 400);
  }

  try {
    const r = await processBatch(batchId, actorFrom(request), {
      geneticPages,
      retryFailedOnly: body?.retryFailedOnly === true,
    });
    if (!r.ok) return json(r, r.status);
    return json(r);
  } catch (err) {
    return fail(err, 'process');
  }
};
