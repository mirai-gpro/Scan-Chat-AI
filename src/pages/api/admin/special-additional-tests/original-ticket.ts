/**
 * **原本 PDF の署名付き PUT を発行する**（§15 / §16 / §17）。
 * 正本: `docs/specs/special_account_additional_tests_spec_20260930.md`。
 *
 *   POST (json) { diagnosticUserId, testType, testDate, bytes, sha256Base64 }
 *     → 200 { ok:true, key, url, headers, expiresIn }
 *
 * ══════════════════════════════════════════════════════════════════════
 * **PDF 本体はこの関数を通らない**（§15）
 * ══════════════════════════════════════════════════════════════════════
 * Vercel の body 上限に当たるため、ブラウザ → 署名付き PUT → S3 ORIGINALS。
 * ここを通るのは数百バイトの JSON だけ。**署名は `signOriginalPut()` を共用**する
 * （Object Lock の checksum と `unhoistableHeaders` の罠を再現しない・§17）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * **キーはサーバが採番する。ファイル名を受け取らない**（§16 / §39）
 * ══════════════════════════════════════════════════════════════════════
 * 実ファイル名が `250804ALAPDS結果本田大作.pdf` のように**氏名を含む**ことがあるため、
 * 入力に元ファイル名を持たせていない（渡せないようにしてある）。
 *
 *   additional_results/{uid}/{test_type}/{YYYY_MM_DD}/{sha256}.pdf
 *
 * 認可 = Bearer `ADMIN_API_KEY`。
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { createAdditionalOriginalTicket, MAX_ORIGINAL_BYTES, PRESIGN_EXPIRES_SEC } from '../../../../lib/additional-originals';
import { checkAdditionalTarget } from '../../../../lib/special-additional-tests';

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  // **対象はスペシャルアカウントだけ**（§6）。原本バケットは 10 年保管・削除不可なので、
  // 対象外の人のファイルを置かせない。
  const target = checkAdditionalTarget(str(body.diagnosticUserId));
  if (!target.ok) return json({ ok: false, error: target.error, detail: target.detail }, 403);

  const t = await createAdditionalOriginalTicket({
    uid: target.uid,
    testType: body.testType,
    testDate: body.testDate,
    bytes: body.bytes,
    sha256Base64: body.sha256Base64,
  });
  if (!t.ok) {
    const status = t.error === 'originals_s3_not_configured' ? 503 : t.error === 'too_large' ? 413 : 400;
    return json({ ok: false, error: t.error, detail: t.detail ?? null, max_bytes: MAX_ORIGINAL_BYTES }, status);
  }

  return json({
    ok: true,
    key: t.key,
    url: t.url,
    headers: t.headers,
    expires_in: PRESIGN_EXPIRES_SEC,
    max_bytes: MAX_ORIGINAL_BYTES,
  });
};
