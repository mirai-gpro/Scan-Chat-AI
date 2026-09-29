/**
 * admin: 検査結果 **原本** をブラウザから S3 へ直接置くための署名付き PUT を発行する。
 *
 * 【なぜ要るか】`upload.ts` はファイル本体を Vercel Function に通すので
 * **リクエストボディ 4.5 MB** を超えると関数に届く前に 413 になる
 * (8.3 MB の遺伝子 PDF が実際に落ちた)。この口は**数百バイトの JSON しか通らない**。
 *
 * 【流れ】① この口で URL を貰う → ② ブラウザから S3 へ PUT →
 *        ③ `POST /api/admin/lab-results/register` で `test_artifact_files` へ登録
 *
 * 認可 = Bearer `ADMIN_API_KEY` (`api-auth.ts`)。
 * 署名付き URL はそれ自体が書き込み権限なので、**鍵の無い相手には出さない**。
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import {
  createOriginalUploadTicket,
  MAX_ORIGINAL_BYTES,
  ORIGINAL_COMPANIES,
} from '../../../../lib/originals-upload-ticket';

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: { lab_company?: unknown; file_name?: unknown; bytes?: unknown; sha256_base64?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const t = await createOriginalUploadTicket({
    company: body.lab_company,
    fileName: body.file_name,
    bytes: body.bytes,
    // Object Lock バケットは checksum 無しの PUT を 400 で拒否する。
    sha256Base64: body.sha256_base64,
  });
  if (!t.ok) {
    // 設定漏れ (503) と入力の誤り (400) を混ぜない。
    const status = t.error === 'originals_s3_not_configured' ? 503 : t.error === 'too_large' ? 413 : 400;
    return json(
      { ok: false, error: t.error, detail: t.detail ?? null, max_bytes: MAX_ORIGINAL_BYTES, companies: ORIGINAL_COMPANIES },
      status,
    );
  }

  return json({
    ok: true,
    url: t.url,
    key: t.key,
    storage_url: t.storageUrl,
    expires_in: t.expiresIn,
    // PUT のときこのヘッダを**そのまま**付ける。署名に固定してあるので変えると S3 が拒否する。
    headers: t.headers,
    // 切り分け用: 実際に署名へ入ったヘッダ名。
    signed_headers: t.signedHeaders,
    max_bytes: MAX_ORIGINAL_BYTES,
  });
};
