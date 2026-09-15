import type { APIRoute } from 'astro';
import { readScanPage } from '../../lib/scan-read-page';
import { fetchScanUpload } from '../../lib/scan-upload-ticket';

export const prerender = false;

interface ScanRequestBody {
  /** data: URL もしくは生 base64 */
  image?: string;
  /**
   * 大きいファイル用。ブラウザが presigned PUT で S3 へ置いたキー。
   * `image` の代わりに使う (両方あれば `imageKey` を優先)。
   *
   * Vercel の 4.5 MB は**関数を通るデータ**にだけかかるので、本体を S3 経由にすると
   * 上限が外れる。サーバ → S3 の取得はこの制限の対象外。
   * キーの検証は `fetchScanUpload` (形が完全一致するものだけ読む)。
   */
  imageKey?: string;
  /** 補足プロンプト（部位・状況など） */
  hint?: string;
}

function parseDataUrl(input: string): { mime: string; data: string } {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(input.trim());
  if (m) return { mime: m[1], data: m[2] };
  return { mime: 'image/jpeg', data: input.trim() };
}

export const POST: APIRoute = async ({ request }) => {
  let body: ScanRequestBody;
  try {
    body = (await request.json()) as ScanRequestBody;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  let mime: string;
  let data: string;
  if (typeof body?.imageKey === 'string' && body.imageKey) {
    const fetched = await fetchScanUpload(body.imageKey);
    if (!fetched.ok) return json({ error: fetched.error }, fetched.status);
    mime = fetched.mime;
    data = fetched.base64;
  } else if (typeof body?.image === 'string' && body.image) {
    ({ mime, data } = parseDataUrl(body.image));
  } else {
    return json({ error: 'image or imageKey is required' }, 400);
  }

  /*
   * **読み取りの本体は `scan-read-page.ts` に一本化してある。**
   * ワーカー (バックグラウンド) も同じ関数を通るので、
   * ここに書き足すと同じ紙から違う結果が出るようになる。
   */
  const r = await readScanPage({ mime, data, hint: body.hint ?? null });
  if (!r.ok) return json({ error: r.error, detail: r.detail }, r.status);
  return json({ markdown: r.markdown, finishReason: r.finishReason });
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
