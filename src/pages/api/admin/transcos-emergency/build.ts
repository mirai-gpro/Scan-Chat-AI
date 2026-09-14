// POST /api/admin/transcos-emergency/build
// 取り込んだ材料から 3 形式を組み立てる。**LLM を呼ばない** (DB の材料だけ)。
// 組み立ては本番の `processBatch` / `finalizeHealthCheckup` / `buildElithInterviewJson` /
// 既存 aggregation。**専用 builder は作らない** (§10 / §11 / §13 / §19)。
import type { APIRoute } from 'astro';
import { processBatch } from '../../../../lib/ad-hoc-diagnosis/service';
import * as store from '../../../../lib/ad-hoc-diagnosis/store';
import { isTranscosRun, crossCheckSubject } from '../../../../lib/transcos-emergency/run';
import { TRANSCOS_SUBJECTS } from '../../../../lib/transcos-emergency/manifest';
import { buildSubjectDelivery } from '../../../../lib/ad-hoc-diagnosis/service';
import { getS3Config } from '../../../../lib/s3';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { actorFrom, authorized, fail, json, readJson, str } from './_shared';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);
  const runId = str(body?.runId);
  if (!runId || !isUuid(runId)) return json({ ok: false, error: 'invalid_run_id' }, 400);
  try {
    const batch = await store.getBatch(runId);
    if (!batch) return json({ ok: false, error: 'run_not_found' }, 404);
    if (!isTranscosRun(batch)) return json({ ok: false, error: 'not_transcos_run' }, 409);

    const r = await processBatch(runId, actorFrom(request));
    if (!r.ok) return json(r, r.status);

    /*
     * 補助 XLSX との決定論照合 (§10)。**値は 1 つも作らない。**
     * 不一致が 1 件でもあればその人物を要確認にする (他の人物は続ける)。
     */
    const cfg = getS3Config();
    const subjects = await store.listSubjects(runId);
    const files = await store.listFiles(runId);
    const cross: { subjectNo: number; mismatches: number; matched: number; items: unknown[] }[] = [];
    if (cfg) {
      for (const m of TRANSCOS_SUBJECTS) {
        if (m.healthSupport == null) continue;
        const s = subjects.find((x) => x.subject_no === m.subjectNo);
        if (!s) continue;
        const build = await buildSubjectDelivery(s, files.filter((f) => f.subject_id === s.id), cfg);
        const hc = build.built.find((b) => b.formatId === 'HealthCheckupData');
        if (!hc) continue;
        const parsed = JSON.parse(hc.body) as { data?: { measurements?: Record<string, unknown>[] } };
        const cc = await crossCheckSubject({
          runId, subjectNo: m.subjectNo,
          measurements: parsed.data?.measurements ?? [],
          pdfTestDate: hc.testDate,
        });
        if (cc) {
          cross.push({ subjectNo: m.subjectNo, mismatches: cc.mismatches.length, matched: cc.matched, items: cc.mismatches });
          if (cc.mismatches.length > 0) {
            await store.logEvent({
              batch_id: runId, subject_id: s.id, event: 'parsed',
              detail: { kind: 'transcos_crosscheck', subject_no: m.subjectNo, mismatches: cc.mismatches },
            });
          }
        }
      }
    }
    return json({ ok: true, subjects: r.subjects, ready: r.ready, crossCheck: cross });
  } catch (err) {
    return fail(err, 'transcos/build');
  }
};
