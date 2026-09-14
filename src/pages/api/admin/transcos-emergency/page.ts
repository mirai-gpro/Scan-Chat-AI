// POST /api/admin/transcos-emergency/page
// PDF 1 ページぶんの画像を受け取り、**本番の scan 経路へ渡す**。
//
// 健診 = `scanImageToParsed()` / 遺伝子 = `scanGeneticPage()`。
// **専用の prompt も parser も作らない** (§10 / §13 / §19)。
// **取り込みだけで返す** (`pagesOnly`) — 組み立ては `build` が最後に 1 回行う。
import type { APIRoute } from 'astro';
import { processBatch } from '../../../../lib/ad-hoc-diagnosis/service';
import * as store from '../../../../lib/ad-hoc-diagnosis/store';
import { isTranscosRun, GENETIC_PAGES } from '../../../../lib/transcos-emergency/run';
import { manifestEntry, zeroBasedIndex } from '../../../../lib/transcos-emergency/manifest';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { actorFrom, authorized, fail, json, num, readJson, str } from './_shared';

export const prerender = false;

const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);
  const runId = str(body?.runId);
  const entry = num(body?.entry);
  const page = num(body?.page);
  const image = str(body?.image);
  if (!runId || !isUuid(runId)) return json({ ok: false, error: 'invalid_run_id' }, 400);
  if (entry == null || page == null || !image) return json({ ok: false, error: 'invalid_input' }, 400);

  const m = manifestEntry(entry);
  if (!m) return json({ ok: false, error: 'entry_not_in_manifest' }, 400);
  if (m.role !== 'HEALTH_PDF' && m.role !== 'GENOPLAN_PDF') {
    return json({ ok: false, error: 'entry_not_scannable', detail: m.role }, 400);
  }
  /*
   * **遺伝子は p10〜35 だけ。** 範囲外は `scanGeneticPage()` を呼ぶ前にここで断る
   * (silent skip にしない・§13 / v1.1 §8.4)。
   */
  if (m.role === 'GENOPLAN_PDF' && !GENETIC_PAGES.includes(page)) {
    return json({ ok: false, error: 'page_out_of_range', detail: `page=${page}` }, 400);
  }
  if (m.role === 'HEALTH_PDF' && (page < 1 || page > (m.pages ?? 1))) {
    return json({ ok: false, error: 'page_out_of_range', detail: `page=${page}` }, 400);
  }
  const mm = DATA_URL.exec(image);
  if (!mm) return json({ ok: false, error: 'invalid_image' }, 400);

  try {
    const batch = await store.getBatch(runId);
    if (!batch) return json({ ok: false, error: 'run_not_found' }, 404);
    if (!isTranscosRun(batch)) return json({ ok: false, error: 'not_transcos_run' }, 409);

    const files = await store.listFiles(runId);
    const file = files.find((f) => f.archive_entry_index === zeroBasedIndex(entry));
    if (!file) return json({ ok: false, error: 'file_not_seeded' }, 409);

    const actor = actorFrom(request);
    const r = await processBatch(runId, actor, {
      pagesOnly: true,
      ...(m.role === 'GENOPLAN_PDF'
        ? { geneticPages: [{ fileId: file.id, page, imageBase64: mm[2], mimeType: mm[1] }] }
        : { healthPages: [{ fileId: file.id, page, pageCount: m.pages ?? 1, imageBase64: mm[2], mimeType: mm[1] }] }),
    });
    if (!r.ok) return json(r, r.status);
    return json({ ok: true, entry, page, pages: r.pages });
  } catch (err) {
    return fail(err, 'transcos/page');
  }
};
