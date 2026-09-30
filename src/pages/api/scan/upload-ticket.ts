/**
 * POST /api/scan/upload-ticket
 *
 * 大きいファイルを **ブラウザから S3 へ直接** 置くための presigned PUT を 1 回分発行する。
 * ここを通るのは数百バイトの JSON だけなので、Vercel の 4.5 MB 制限にかからない。
 * 設計と安全性の根拠は `src/lib/scan-upload-ticket.ts` の冒頭を参照。
 *
 * 入力  { contentType: string, bytes: number }
 * 出力  { ok: true, upload_url, key, headers, expires_in, max_bytes }
 *       S3 未設定なら 503 `s3_not_configured` (クライアントは圧縮経路へ落ちる)。
 */
import type { APIRoute } from 'astro';
import { createScanUploadTicket, MAX_SCAN_UPLOAD_BYTES } from '../../../lib/scan-upload-ticket';
import { resolveViewer } from '../../../lib/viewer';
import { denyAnonymous, denyUnlessShareScope } from '../../../lib/write-guard';

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * 【2026-09-30・§21.4】**未認証を 401 で止める。** キーはサーバ採番なので target lock は
 * 不要だが、**S3 への presigned PUT を無制限に発行できる**状態だった（1 件 10MB・15 分）。
 */
export const POST: APIRoute = async (apiCtx) => {
  const { request } = apiCtx;
  const viewer = await resolveViewer(apiCtx);
  const unauth = denyAnonymous(viewer);
  if (unauth) return unauth;
  const scoped = denyUnlessShareScope(viewer, 'scan');
  if (scoped) return scoped;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const r = await createScanUploadTicket({ contentType: body.contentType, bytes: body.bytes });
  if (!r.ok) return json({ ok: false, error: r.error, detail: r.detail }, r.status);

  return json({
    ok: true,
    upload_url: r.url,
    key: r.key,
    headers: r.headers,
    expires_in: r.expiresIn,
    max_bytes: MAX_SCAN_UPLOAD_BYTES,
  });
};
