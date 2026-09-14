// POST /api/admin/transcos-emergency/preflight-plan
// Preflight の入口。**Central Directory しか読まない** (中身はまだ 1 バイトも読まない)。
// LLM を呼ばない。S3 へ書かない。
import type { APIRoute } from 'astro';
import { startPreflight } from '../../../../lib/transcos-emergency/run';
import { actorFrom, authorized, fail, json, readJson, str } from './_shared';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);
  try {
    const r = await startPreflight({
      // ブラウザが原本を読んで出した ZIP の SHA-256。**中身の証明は 38 件の SHA 一致が行う。**
      zipSha256: str(body?.zipSha256),
      actor: actorFrom(request),
    });
    if (!r.ok) return json(r, r.status);
    return json({ ok: true, ...r.result });
  } catch (err) {
    return fail(err, 'transcos/preflight-plan');
  }
};
