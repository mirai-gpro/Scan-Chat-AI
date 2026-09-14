// POST /api/admin/transcos-emergency/deliver
// **1 人ぶん**の 3 JSON を Elith 納品先へ create-only で書く (§16)。
// 通常納品 (`export`) の規則は 1 文字も変えていない — 経路が別。
import type { APIRoute } from 'astro';
import * as store from '../../../../lib/ad-hoc-diagnosis/store';
import { deliverSubject } from '../../../../lib/transcos-emergency/deliver';
import { isTranscosRun } from '../../../../lib/transcos-emergency/run';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { actorFrom, authorized, fail, json, num, readJson, str } from './_shared';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);
  const runId = str(body?.runId);
  const subjectNo = num(body?.subjectNo);
  if (!runId || !isUuid(runId)) return json({ ok: false, error: 'invalid_run_id' }, 400);
  if (subjectNo == null || !Number.isInteger(subjectNo)) return json({ ok: false, error: 'invalid_subject_no' }, 400);
  try {
    const batch = await store.getBatch(runId);
    if (!batch) return json({ ok: false, error: 'run_not_found' }, 404);
    if (!isTranscosRun(batch)) return json({ ok: false, error: 'not_transcos_run' }, 409);
    const subjects = await store.listSubjects(runId);
    const s = subjects.find((x) => x.subject_no === subjectNo);
    if (!s) return json({ ok: false, error: 'subject_not_found' }, 404);
    const files = await store.listFiles(runId);
    const r = await deliverSubject({ batchId: runId, subject: s, files, actor: actorFrom(request) });
    if (!r.ok) return json(r, r.status);
    return json(r);
  } catch (err) {
    return fail(err, 'transcos/deliver');
  }
};
