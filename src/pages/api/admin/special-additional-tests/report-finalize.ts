import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { refreshConfig } from '../../../../lib/app-config';
import { isSpecialAccount } from '../../../../lib/special-accounts';
import { getServerSupabase } from '../../../../lib/supabase';
import { getOriginalsS3Config } from '../../../../lib/originals-storage';
import { isAdditionalOriginalKey } from '../../../../lib/additional-originals';

export const prerender = false;

const ALLOWED_UIDS = new Set([
  '5c54a5aa-d6a9-416c-8e2d-8e12f50f6f49',
  'fc3c6cd5-0264-4b5a-9f70-4010c316966c',
  'fc2e785c-8a80-49bf-b694-93eb7f65e146',
  'd81e6bc1-df02-4cae-8079-698898b69eda',
  'b2447c25-5771-4ad5-9db0-05577cba3743',
  '2d40c6b1-03f4-4058-934f-16b32dd57cc6',
  'ff5a9960-d1dd-4eca-b8bb-06c29d4f5e0f',
  'fc0fd56b-0ab4-43a8-a25a-099e0060a16f',
  'dfad9edd-2828-4227-ad54-63cbffc3bcf8',
  '4e7d49d9-9487-4205-8556-324ec507e515',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{64}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const uid = String(body.diagnosticUserId ?? '').toLowerCase();
  const originalKey = String(body.originalKey ?? '');
  const sha256 = String(body.sha256 ?? '').toLowerCase();
  const bytes = Number(body.bytes ?? 0);
  const pages = Number(body.pages ?? 26);

  if (!UUID_RE.test(uid) || !ALLOWED_UIDS.has(uid)) return json({ ok: false, error: 'target_not_allowed' }, 403);
  if (!SHA_RE.test(sha256)) return json({ ok: false, error: 'invalid_sha256' }, 400);
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > 20 * 1024 * 1024) return json({ ok: false, error: 'invalid_size' }, 400);
  if (!Number.isInteger(pages) || pages <= 0 || pages > 100) return json({ ok: false, error: 'invalid_pages' }, 400);
  if (!isAdditionalOriginalKey(originalKey)) return json({ ok: false, error: 'invalid_original_key' }, 400);

  const expectedPrefix = `additional_results/${uid}/ai_prediction/2026_09_28/`;
  if (!originalKey.startsWith(expectedPrefix) || !originalKey.endsWith(`/${sha256}.pdf`)) {
    return json({ ok: false, error: 'original_key_mismatch' }, 400);
  }

  await refreshConfig(true);
  if (!isSpecialAccount(uid)) return json({ ok: false, error: 'not_special_account' }, 403);

  const cfg = getOriginalsS3Config();
  if (!cfg) return json({ ok: false, error: 'originals_s3_not_configured' }, 503);
  const fullKey = `${cfg.prefix}${originalKey}`.replace(/\/{2,}/g, '/');
  const storageUrl = `s3://${cfg.bucket}/${fullKey}`;

  const sb = getServerSupabase();
  if (!sb) return json({ ok: false, error: 'supabase_not_configured' }, 503);
  const dsb = sb.schema('diagnosis');

  const { error: userErr } = await dsb.from('app_users').upsert(
    { diagnostic_user_id: uid },
    { onConflict: 'diagnostic_user_id', ignoreDuplicates: true },
  );
  if (userErr) return json({ ok: false, error: 'app_user_failed', detail: userErr.message }, 500);

  const sourceKey = `manual:transcosmos:20260928:${uid}`;
  const { data: existing, error: findErr } = await dsb
    .from('diagnosis_results')
    .select('id')
    .eq('diagnostic_user_id', uid)
    .eq('source_key', sourceKey)
    .limit(1)
    .maybeSingle();
  if (findErr) return json({ ok: false, error: 'result_lookup_failed', detail: findErr.message }, 500);

  const now = new Date().toISOString();
  const row = {
    diagnostic_user_id: uid,
    report: [],
    schema_version: 'manual-pdf-v1',
    received_at: '2026-09-28T00:00:00+09:00',
    status: 'received',
    report_pdf_url: storageUrl,
    report_pdf_sha256: sha256,
    report_pdf_pages: pages,
    report_pdf_received_at: now,
    source_key: sourceKey,
  };

  let resultId = existing?.id ?? '';
  if (existing?.id) {
    const { error } = await dsb.from('diagnosis_results').update(row).eq('id', existing.id);
    if (error) return json({ ok: false, error: 'result_update_failed', detail: error.message }, 500);
  } else {
    const { data, error } = await dsb.from('diagnosis_results').insert({
      ...row,
      diagnostic_id: crypto.randomUUID(),
    }).select('id').single();
    if (error) return json({ ok: false, error: 'result_insert_failed', detail: error.message }, 500);
    resultId = data.id;
  }

  return json({ ok: true, diagnostic_user_id: uid, result_id: resultId, pages, bytes, sha256 });
};
