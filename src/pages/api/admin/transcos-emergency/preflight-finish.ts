// POST /api/admin/transcos-emergency/preflight-finish
// 16 検査を締める。**PASS したときだけ** manifest から run を起こす (seed)。
// FAIL なら LLM を 1 回も呼ばず、S3 へ 1 件も書かず、汎用処理へも逃がさない (§8)。
import type { APIRoute } from 'astro';
import { finishPreflight } from '../../../../lib/transcos-emergency/run';
import { formatPreflight } from '../../../../lib/transcos-emergency/preflight';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { actorFrom, authorized, fail, json, readJson, str } from './_shared';

export const prerender = false;

/** 画面から来るのは**人物番号・候補件数・UUID の 3 つだけ**。氏名は受け取らない (§22)。 */
function execs(raw: unknown): { subjectNo: number; candidates: number; executiveSubjectId: string | null }[] {
  if (!Array.isArray(raw)) return [];
  const out: { subjectNo: number; candidates: number; executiveSubjectId: string | null }[] = [];
  for (const r of raw) {
    const o = r as Record<string, unknown>;
    const subjectNo = Number(o.subjectNo);
    const candidates = Number(o.candidates);
    const id = typeof o.executiveSubjectId === 'string' ? o.executiveSubjectId : null;
    if (!Number.isInteger(subjectNo) || !Number.isInteger(candidates)) continue;
    out.push({ subjectNo, candidates, executiveSubjectId: id && isUuid(id) ? id : null });
  }
  return out;
}

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);
  const runId = str(body?.runId);
  if (!runId || !isUuid(runId)) return json({ ok: false, error: 'invalid_run_id' }, 400);
  try {
    const r = await finishPreflight({
      runId,
      zipSha256: str(body?.zipSha256),
      executives: execs(body?.executives),
      actor: actorFrom(request),
    });
    if (!r.ok) return json(r, r.status);
    return json({ ok: true, report: r.report, text: formatPreflight(r.report), seeded: r.seeded });
  } catch (err) {
    return fail(err, 'transcos/preflight-finish');
  }
};
