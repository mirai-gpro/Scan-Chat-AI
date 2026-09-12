// POST /api/admin/ad-hoc-diagnosis/subject-link
// 人物 ↔ Executive 人物マスタ の紐付け / 解除 (Phase B1)。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §4 / §21
//
// **この口が受け取る人物情報は `executiveSubjectId` (UUID) だけ。**
// 氏名・メール・会社名・役職は受け取らないし、受け取っても保存先が無い
// (`diagnosis` スキーマは PII を持たない、が全体の設計前提)。
// 誰なのかは Wellfort `public.executive_subjects` にしか無い。
import type { APIRoute } from 'astro';
import { linkExecutiveSubject } from '../../../../lib/ad-hoc-diagnosis/service';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { actorFrom, authorized, fail, json, readJson, str } from './_shared';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);

  const batchId = str(body.batchId);
  if (!batchId || !isUuid(batchId)) return json({ ok: false, error: 'invalid_batch_id' }, 400);

  const subjectId = str(body.subjectId);
  if (!subjectId || !isUuid(subjectId)) return json({ ok: false, error: 'invalid_subject_id' }, 400);

  /*
   * **null は「解除」。** 未指定 (undefined) と区別する —
   * 取り違えると「解除したつもりが何も起きない」が黙って通る。
   */
  const rawExec = body.executiveSubjectId;
  let executiveSubjectId: string | null;
  if (rawExec === null) {
    executiveSubjectId = null;
  } else {
    const v = str(rawExec);
    // **UUID 以外は受け付けない。** ここを緩めると氏名やメールを入れられる。
    if (!v || !isUuid(v)) return json({ ok: false, error: 'invalid_executive_subject_id' }, 400);
    executiveSubjectId = v;
  }

  try {
    const r = await linkExecutiveSubject({
      batchId, subjectId, executiveSubjectId, actor: actorFrom(request),
    });
    if (!r.ok) return json(r, r.status);
    return json(r);
  } catch (err) {
    return fail(err, 'subject-link');
  }
};
