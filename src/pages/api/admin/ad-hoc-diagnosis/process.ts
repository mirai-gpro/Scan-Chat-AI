// POST /api/admin/ad-hoc-diagnosis/process
// 解析して Elith JSON を作る (S3 へは書かない)。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §11 / §19.3
//
// 遺伝子 PDF は **1 ページ = 1 リクエスト** (Vercel の実行モデル)。
// ブラウザ (pdf.js) が作ったページ画像を `geneticPages` に載せて順に呼ぶ。
// **既存 `scanGeneticPage` を使う。新しいプロンプトを作らない。**
import type { APIRoute } from 'astro';
import { processBatch } from '../../../../lib/ad-hoc-diagnosis/service';
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
  for (const p of pagesRaw) {
    const fileId = str(p.fileId);
    const page = Number(p.page);
    const img = splitImage(p.image ?? p.imageBase64, str(p.mimeType) ?? 'image/jpeg');
    if (!fileId || !isUuid(fileId) || !Number.isInteger(page) || page < 1 || !img) continue;
    geneticPages.push({ fileId, page, imageBase64: img.base64, mimeType: img.mimeType });
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
