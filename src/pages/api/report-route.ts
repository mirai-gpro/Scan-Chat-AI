import type { APIRoute } from 'astro';
import { resolveViewer } from '../../lib/viewer';
import { getServerSupabase } from '../../lib/supabase';
import { getOriginalSignedUrl } from '../../lib/originals-storage';
import { noStore } from '../../lib/http-cache';

export const prerender = false;

function text(message: string, status = 400): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const GET: APIRoute = async (ctx) => {
  noStore(ctx.response);
  const url = new URL(ctx.request.url);
  const dest = url.searchParams.get('dest') || '/report';
  if (!dest.startsWith('/') || dest.startsWith('//')) return text('invalid destination', 400);

  const viewer = await resolveViewer(ctx);
  let uid = viewer.uid;

  // admin の従来 ?u= 代理表示でも PDF を確認できるよう、元の report URL の uid を引き継ぐ。
  try {
    const destUrl = new URL(dest, url.origin);
    const requestedUid = destUrl.searchParams.get('u');
    if (viewer.isAdmin && requestedUid && /^[0-9a-f-]{36}$/i.test(requestedUid)) uid = requestedUid;
  } catch {
    return text('invalid destination', 400);
  }

  if (!uid) return Response.redirect(dest, 302);

  const sb = getServerSupabase();
  if (!sb) return Response.redirect(dest, 302);

  const { data, error } = await sb
    .schema('diagnosis')
    .from('diagnosis_results')
    .select('report_pdf_url, source_key')
    .eq('diagnostic_user_id', uid)
    .like('source_key', 'manual:transcosmos:%')
    .not('report_pdf_url', 'is', null)
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data?.report_pdf_url) return Response.redirect(dest, 302);

  const signed = await getOriginalSignedUrl(data.report_pdf_url, 300);
  if (!signed) return text('報告書を開けませんでした。管理者へご連絡ください。', 503);
  return Response.redirect(signed, 302);
};
