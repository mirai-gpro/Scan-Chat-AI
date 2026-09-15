/**
 * admin: 検証用プレフィックスへ書き出した納品セットを、**バケット直下 `user/` へ複製**する。
 *
 * 【2026-09-15】臨時案件は `AWS_S3_PREFIX`（既定 `scan-accuracy-test/`）の下へ書き出される。
 * 本番の納品先は **バケット直下 `user/`**（発注者指示）。
 * env のプレフィックスを空に変えると **他の機能（合成データ・原本・golden 等）も
 * まとめて書き先が変わる**ので、そこは触らず、**この納品ぶんだけを複製**する。
 *
 * **安全策**:
 *   - `keep`（対象 client_id）が空なら拒否。UUID 以外が混ざれば拒否。
 *   - 複製元は `{AWS_S3_PREFIX}user/{keep の client_id}/…` に完全一致するものだけ。
 *   - 複製先は `user/` + 同じ相対パス。**キーの組み替えをしない**（取り違え防止）。
 *   - **元は消さない**（複製のみ）。削除はこのエンドポイントでは一切行わない。
 *   - 既定は `mode='list'`（何が複製されるかを先に見る）。
 *   - `AWS_S3_PREFIX` が空なら何もしない（防御。ただし **env では空にできない** —
 *     `s3.ts` の `env()` が空文字を未設定とみなし既定へ戻すため。実測 2026-09-15）。
 *
 * 認可: Bearer ADMIN_API_KEY（env 未設定 dev のみ省略）。
 */
import type { APIRoute } from 'astro';
import { getS3Config, isS3Configured, listObjects, copyObjects } from '../../../lib/s3';
import { isAdminAuthorized } from '../../../lib/api-auth';

export const prerender = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** `{fromPrefix}user/{id}/...` → `user/{id}/...`。対象外なら null。 */
export function promoteKey(key: string, fromPrefix: string, keep: Set<string>): string | null {
  const src = `${fromPrefix}user/`;
  if (!key.startsWith(src)) return null;
  const rest = key.slice(src.length);
  const id = rest.split('/')[0];
  if (!id || !UUID_RE.test(id) || !keep.has(id.toLowerCase())) return null;
  return `user/${rest}`;
}

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) {
    return json({ ok: false, error: 'unauthorized', detail: 'Invalid API key' }, 401);
  }
  if (!isS3Configured()) {
    return json({ ok: false, error: 's3_not_configured', detail: 'AWS_REGION 未設定' }, 400);
  }
  let body: { mode?: unknown; keep?: unknown };
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Invalid JSON body' }, 400); }

  const mode = typeof body.mode === 'string' ? body.mode : 'list';
  const keepRaw = Array.isArray(body.keep) ? body.keep : [];
  if (keepRaw.length === 0) {
    return json({ ok: false, error: 'keep_required', detail: '対象の client_id を 1 件以上指定してください' }, 400);
  }
  if (keepRaw.some((v) => typeof v !== 'string' || !UUID_RE.test(v as string))) {
    return json({ ok: false, error: 'keep_invalid', detail: 'client_id は UUID で指定してください' }, 400);
  }
  const keep = new Set((keepRaw as string[]).map((v) => v.toLowerCase()));

  const cfg = getS3Config()!;
  const fromPrefix = cfg.prefix ?? '';
  if (fromPrefix === '') {
    return json({ ok: true, mode, from_prefix: '', planned: 0, copied: 0,
      note: '書き出し先が既に user/ なので、複製は不要です' });
  }

  let objs;
  try { objs = await listObjects(`${fromPrefix}user/`); }
  catch (err) { return json({ ok: false, error: 'list_failed', detail: String(err instanceof Error ? err.message : err) }, 502); }

  const pairs: { from: string; to: string }[] = [];
  for (const o of objs) {
    const to = promoteKey(o.key, fromPrefix, keep);
    if (to) pairs.push({ from: o.key, to });
  }
  const jsonCount = pairs.filter((p) => p.to.toLowerCase().endsWith('.json')).length;
  const summary = {
    ok: true, from_prefix: fromPrefix, to_prefix: 'user/',
    planned: pairs.length, planned_json: jsonCount,
    people: new Set(pairs.map((p) => p.to.split('/')[1])).size,
    sample: pairs.slice(0, 3).map((p) => p.to),
  };

  if (mode === 'list') return json({ ...summary, mode: 'list', copied: 0 });
  if (mode !== 'copy') return json({ ok: false, error: `unknown mode: ${mode}` }, 400);

  let copied = 0;
  try { copied = await copyObjects(pairs); }
  catch (err) { return json({ ...summary, ok: false, error: 'copy_failed', copied, detail: String(err instanceof Error ? err.message : err) }, 502); }

  // **複製したと言い切る前に、複製先を読み直して数える。**
  let after = -1;
  try { after = (await listObjects('user/')).filter((o) => {
    const id = o.key.split('/')[1];
    return id && keep.has(id.toLowerCase());
  }).length; } catch { /* 読めなくても複製自体は成功している */ }

  return json({ ...summary, mode: 'copy', copied, verified_at_destination: after });
};
