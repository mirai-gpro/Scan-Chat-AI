import type { APIRoute } from 'astro';
import { resolveViewer } from '../../lib/viewer';
import { getServerSupabase } from '../../lib/supabase';
import { getOriginalSignedUrl } from '../../lib/originals-storage';
import { isApprovedRow } from '../../lib/report-gate';

export const prerender = false;

function text(message: string, status = 400): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' },
  });
}

/*
 * **`Response.redirect()` は使わない。** 返ってくる Response の headers は immutable で
 * `cache-control` を足せないため、短寿命の署名 URL や本人固有の行き先が
 * 共有キャッシュ (CDN・企業プロキシ) に載り得る。自分で組んで必ず
 * `private, no-store` を付ける (`http-cache.ts` の方針と同じ理由)。
 */
function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, 'cache-control': 'private, no-store' },
  });
}

export const GET: APIRoute = async (ctx) => {
  /*
   * ⚠️ **`noStore(ctx.response)` を呼んではいけない。**
   * `Astro.response` が在るのは `.astro` ページだけで、API route の `APIContext` に
   * `response` は無い。`noStore(undefined)` が `headers` を読んで TypeError になり、
   * **この口は全リクエストで 500** だった (2026-10-05 本番実測 `status=500`)。
   * ダッシュボードの「報告書を読む」が**全利用者で壊れていた**直接の原因。
   * キャッシュ指示は上の `text()` / `redirect()` が各 Response に付ける。
   */
  const url = new URL(ctx.request.url);
  const dest = url.searchParams.get('dest') || '/report';
  if (!dest.startsWith('/') || dest.startsWith('//')) return text('invalid destination', 400);

  /*
   * `dest` の中の `?u=` を読むためだけに URL として解釈する。**基準は任意の
   * ダミー origin** で、ここから行き先を組み立てはしない (下の `fallback` を見よ)。
   */
  let destUrl: URL;
  try {
    destUrl = new URL(dest, 'https://dest.invalid');
  } catch {
    return text('invalid destination', 400);
  }

  /*
   * **フォールバックは相対 URL のまま返す。**
   *
   * `ctx.request.url` の origin を使ってはいけない — Vercel の関数が見る URL は
   * 内部のもので、**本番で `https://localhost/report` へ飛ばしていた**
   * (2026-10-05 実測: `location: https://localhost/report`)。
   * `Location` は相対値が正式に許され、ブラウザは**自分が叩いた URL** を基準に
   * 解決するので、どの環境でも正しい origin になる
   * (`Response.redirect()` は絶対 URL を要求するが、自前の `redirect()` なら不要)。
   */
  const fallback = dest;

  const viewer = await resolveViewer(ctx);
  let uid = viewer.uid;

  // admin の従来 ?u= 代理表示でも PDF を確認できるよう、元の report URL の uid を引き継ぐ。
  const requestedUid = destUrl.searchParams.get('u');
  if (viewer.isAdmin && requestedUid && /^[0-9a-f-]{36}$/i.test(requestedUid)) uid = requestedUid;

  if (!uid) return redirect(fallback);

  const sb = getServerSupabase();
  if (!sb) return redirect(fallback);

  /*
   * `publish_status` は 20261007000010 で足した列。**未適用の環境では select ごと
   * 失敗する**ので、そのときだけ列を外して引き直す (`elith-report-queries.ts` と同じ流儀)。
   * 無いと 10 名の公開中の PDF が「開けない」に化ける — 列が無い環境には
   * `pending` の行も無いので、承認ゲートとしては何も緩まない。
   */
  interface PdfRow { report_pdf_url: string | null; source_key: string | null; publish_status?: unknown }
  const targetUid = uid;
  const fetchRow = async (cols: string): Promise<{ data: PdfRow | null; error: unknown }> => {
    const r = await (sb.schema('diagnosis') as any)
      .from('diagnosis_results')
      .select(cols)
      .eq('diagnostic_user_id', targetUid)
      .like('source_key', 'manual:transcosmos:%')
      .not('report_pdf_url', 'is', null)
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return { data: (r.data ?? null) as PdfRow | null, error: r.error ?? null };
  };

  let { data, error } = await fetchRow('report_pdf_url, source_key, publish_status');
  if (error) ({ data, error } = await fetchRow('report_pdf_url, source_key'));

  if (error || !data?.report_pdf_url) return redirect(fallback);

  /*
   * **未承認 (`pending`) の報告書は、URL を直接叩いても渡さない**
   * (`docs/elith/AI疾病予防報告書_承認と再作成_仕様書.md` §8・受入条件 10)。
   * ここは署名付き URL を発行する口なので、**この手前で止めるのが唯一の境界**。
   * 管理者は代理表示で本番の `/report` を開いて確認する。
   * 列が無い環境は承認済相当 (`isApprovedRow`) = 従来どおり開ける。
   */
  if (!viewer.isAdmin && !isApprovedRow(data as { publish_status?: unknown })) {
    return redirect(fallback);
  }

  const signed = await getOriginalSignedUrl(data.report_pdf_url, 300);
  if (!signed) return text('報告書を開けませんでした。管理者へご連絡ください。', 503);
  return redirect(signed);
};
