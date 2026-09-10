// POST /api/admin/ad-hoc-diagnosis/confirm
// 管理者による分類の修正と、人物識別の確定。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §7.1 / §17 STEP 2 / §21
//
// **修正した事実は必ず監査に残す** (誰が・何から何へ)。
import type { APIRoute } from 'astro';
import { confirmClassification } from '../../../../lib/ad-hoc-diagnosis/service';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { ELITH_ALLOWED_FORMATS } from '../../../../lib/ad-hoc-diagnosis/classify';
import { actorFrom, authorized, fail, json, readJson, str } from './_shared';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);
  const batchId = str(body?.batchId);
  if (!batchId || !isUuid(batchId)) return json({ ok: false, error: 'invalid_batch_id' }, 400);

  const raw = Array.isArray(body?.changes) ? (body!.changes as Record<string, unknown>[]) : [];
  const changes: { fileId: string; formatId: never; subjectId?: string | null }[] = [];
  for (const c of raw) {
    const fileId = str(c.fileId);
    if (!fileId || !isUuid(fileId)) continue;
    const f = str(c.formatId);
    // **知らない format_id は受け付けない** (勝手な format を作らせない)
    if (f !== null && !ELITH_ALLOWED_FORMATS.includes(f as never)) {
      return json({ ok: false, error: 'invalid_format_id', detail: f }, 400);
    }
    const subjectId = c.subjectId === null ? null : str(c.subjectId);
    changes.push({
      fileId,
      formatId: (f as never) ?? null,
      ...(c.subjectId !== undefined ? { subjectId } : {}),
    });
  }

  try {
    const r = await confirmClassification({ batchId, changes: changes as never, actor: actorFrom(request) });
    if (!r.ok) return json(r, r.status);
    return json(r);
  } catch (err) {
    return fail(err, 'confirm');
  }
};
