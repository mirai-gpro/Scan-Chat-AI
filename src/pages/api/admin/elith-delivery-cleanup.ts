/**
 * admin: Elith 納品先 (`{prefix}user/`) の **余分な client_id フォルダだけ** を消す。
 *
 * **なぜ専用の口が要るか** (2026-09-15):
 *   既存の `elith-delete` は target='delivery' で `listObjects('user/')` を素で見るが、
 *   実際のキーは `{AWS_S3_PREFIX}user/...` (既定 `scan-accuracy-test/user/...`) なので
 *   **1 件も一致しない**。さらに delete は対象を全部消すので、残したい納品ぶんも巻き込む。
 *   臨時案件でやり直すと、採番し直された古い client_id のフォルダが残り、
 *   Elith からは**人数が増えて見える**。これを安全に掃除するための口。
 *
 * **安全策 (全消しを構造的に禁じる)**:
 *   - `keep` (残す client_id) が **空なら必ず拒否**。1 件でも UUID 以外が混ざれば拒否。
 *   - 削除対象は「keep に無い client_id のフォルダ」だけ。keep のキーには触れない。
 *   - `mode='list'` が既定。delete は明示したときだけ。
 *   - 納品先 (`user/`) 以外は一切見ない (原本・作業ファイルには触れない)。
 *
 * 認可: Bearer ADMIN_API_KEY (env 未設定 dev のみ省略)。キーはサーバ環境変数のみ。
 */
import type { APIRoute } from 'astro';
import { getS3Config, isS3Configured, listObjects, deleteObjects } from '../../../lib/s3';
import { isAdminAuthorized } from '../../../lib/api-auth';

export const prerender = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Body {
  mode?: unknown;
  keep?: unknown;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** `{prefix}user/{client_id}/...` から client_id を取り出す。取れなければ null。 */
export function clientIdOf(key: string, deliveryPrefix: string): string | null {
  if (!key.startsWith(deliveryPrefix)) return null;
  const rest = key.slice(deliveryPrefix.length);
  const id = rest.split('/')[0];
  return id && UUID_RE.test(id) ? id : null;
}

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) {
    return json({ ok: false, error: 'unauthorized', detail: 'Invalid API key' }, 401);
  }
  if (!isS3Configured()) {
    return json({ ok: false, error: 's3_not_configured', detail: 'AWS_REGION 未設定' }, 400);
  }
  let body: Body;
  try { body = (await request.json()) as Body; }
  catch { return json({ ok: false, error: 'Invalid JSON body' }, 400); }

  const mode = typeof body.mode === 'string' ? body.mode : 'list';
  const keepRaw = Array.isArray(body.keep) ? body.keep : [];
  // **全消しを構造的に禁じる**: 残す一覧が無い/不正なら、何も見ずに断る。
  if (keepRaw.length === 0) {
    return json({ ok: false, error: 'keep_required', detail: '残す client_id を 1 件以上指定してください' }, 400);
  }
  const bad = keepRaw.filter((v) => typeof v !== 'string' || !UUID_RE.test(v as string));
  if (bad.length > 0) {
    return json({ ok: false, error: 'keep_invalid', detail: 'client_id は UUID で指定してください' }, 400);
  }
  const keep = new Set((keepRaw as string[]).map((v) => v.toLowerCase()));

  const cfg = getS3Config()!;
  const deliveryPrefix = `${cfg.prefix}user/`;

  let objs;
  try { objs = await listObjects(deliveryPrefix); }
  catch (err) { return json({ ok: false, error: 'list_failed', detail: String(err instanceof Error ? err.message : err) }, 502); }

  const kept = new Map<string, number>();
  const extra = new Map<string, string[]>();
  let unknown = 0;
  const unknownSample: string[] = [];
  for (const o of objs) {
    const id = clientIdOf(o.key, deliveryPrefix);
    if (!id) {
      // 形が違うものは**触らない**。ただし黙って数から消えると合計が合わなくなるので、
      // 件数と実例を返す (実測 2026-09-15: 216 のうち 184 がこれで、正体不明のままだった)。
      unknown++;
      if (unknownSample.length < 5) unknownSample.push(o.key.slice(deliveryPrefix.length));
      continue;
    }
    if (keep.has(id.toLowerCase())) {
      kept.set(id, (kept.get(id) ?? 0) + 1);
      continue;
    }
    const list = extra.get(id);
    if (list) list.push(o.key);
    else extra.set(id, [o.key]);
  }

  /*
   * 残す側の内訳。**件数だけだと「想定と違う」に気づけない** (実測 2026-09-15: 30 のはずが 216)。
   * 日付フォルダ別・拡張子別に数える。1 人 1 回なら date は 1 つ、json は 3 つになる。
   */
  const detail = new Map<string, Map<string, { json: number; other: number; otherSample: string[] }>>();
  for (const o of objs) {
    const id = clientIdOf(o.key, deliveryPrefix);
    if (!id || !keep.has(id.toLowerCase())) continue;
    const seg = o.key.slice(deliveryPrefix.length).split('/');
    const date = seg[2] ?? '(直下)'; // {id}/date/{YYYY_MM_DD}/...
    const byDate = detail.get(id) ?? new Map();
    detail.set(id, byDate);
    const cell = byDate.get(date) ?? { json: 0, other: 0, otherSample: [] };
    if (o.key.toLowerCase().endsWith('.json')) {
      cell.json++;
    } else {
      cell.other++;
      // **名前を見ないと何のファイルか分からない**ので、先頭 3 件だけ持ち帰る。
      if (cell.otherSample.length < 3) cell.otherSample.push(o.key.split('/').pop() ?? '');
    }
    byDate.set(date, cell);
  }

  const summary = {
    ok: true,
    prefix: deliveryPrefix,
    total_objects: objs.length,
    kept: [...kept].map(([clientId, files]) => ({ clientId, files })),
    kept_detail: [...detail].map(([clientId, byDate]) => ({
      clientId,
      dates: [...byDate].map(([date, c]) => ({ date, json: c.json, other: c.other, otherSample: c.otherSample })),
    })),
    kept_json: objs.filter((o) => {
      const id = clientIdOf(o.key, deliveryPrefix);
      return id && keep.has(id.toLowerCase()) && o.key.toLowerCase().endsWith('.json');
    }).length,
    extra: [...extra].map(([clientId, keys]) => ({ clientId, files: keys.length, sample: keys[0] })),
    extra_objects: [...extra.values()].reduce((n, k) => n + k.length, 0),
    untouched_other_shape: unknown,
    untouched_sample: unknownSample,
  };

  if (mode === 'list') return json({ ...summary, mode: 'list' });
  if (mode !== 'delete') return json({ ok: false, error: `unknown mode: ${mode}` }, 400);

  const keys = [...extra.values()].flat();
  if (keys.length === 0) return json({ ...summary, mode: 'delete', deleted: 0, note: '余分なフォルダはありません' });
  try {
    const deleted = await deleteObjects(keys);
    return json({ ...summary, mode: 'delete', deleted, requested: keys.length });
  } catch (err) {
    return json({ ok: false, error: 'delete_failed', detail: String(err instanceof Error ? err.message : err) }, 502);
  }
};
