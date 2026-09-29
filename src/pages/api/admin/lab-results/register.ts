/**
 * admin: S3 へ直接置いた**原本**を `test_artifact_files` へ登録する。
 *
 * 【流れ】`upload-ticket` で署名 → ブラウザから S3 へ PUT → **この口**。
 *   ファイル本体はここも通らない (Vercel の 4.5 MB に当たらない)。
 *   サーバ → S3 の読み出しは上限の対象外なので、8 MB の PDF でも扱える。
 *
 * 【自己申告を信じない】`sha256` と `size_bytes` は**S3 の実体から算出**する
 *   (`readUploadedOriginal`)。改竄検知の根拠なので、ブラウザの申告は使わない。
 *   PUT されていなければ `not_found` で落ちる = 「上げたことにして DB だけ書く」が起きない。
 *
 * 【どの artifact に付けるか】
 *   - `test_artifact_id` … 既存の検査に原本を足す (種別は既存行のまま)
 *   - 省略時 … `test_artifacts` を新規作成する。`diagnostic_user_id` を渡せば
 *     **その人に紐付く**。渡さなければ従来どおり UNASSIGNED (`upload.ts` と同じ)。
 *
 * 【redaction は未実装】PDF は `raw_pdf` で登録する。`raw_pdf_redacted` は
 *   PII 除去を実装した経路でだけ使う (実態と名前を一致させる・CLAUDE.md)。
 *
 * 認可 = Bearer `ADMIN_API_KEY`。
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { getServerSupabase } from '../../../../lib/supabase';
import { readUploadedOriginal } from '../../../../lib/originals-upload-ticket';

export const prerender = false;
/** S3 から 1 件読み直してハッシュを取るので、既定の 60s では足りないことがある。 */
export const config = { maxDuration: 300 };

/** `upload.ts` と同じ対応表。ここで検査種別を決める。 */
const LAB_COMPANY_TO_TEST_TYPE: Record<string, string> = {
  rieger: 'blood',
  prevent: 'cancer_urine',
  genoplan: 'genetics',
  laif: 'ai_prediction',
};

/** 顧客未割当 (`upload.ts:30` と同じ値)。 */
const UNASSIGNED_UID = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const sb = getServerSupabase();
  if (!sb) return json({ ok: false, error: 'supabase_not_configured' }, 503);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const key = str(body.key);
  if (!key) return json({ ok: false, error: 'key_required' }, 400);

  const labCompany = str(body.lab_company);
  const artifactId = str(body.test_artifact_id);
  if (!artifactId) {
    if (!labCompany || !LAB_COMPANY_TO_TEST_TYPE[labCompany]) {
      return json({ ok: false, error: 'invalid_lab_company', detail: 'test_artifact_id を渡さない場合は必須' }, 400);
    }
  }

  const uid = str(body.diagnostic_user_id);
  if (uid && !UUID_RE.test(uid)) return json({ ok: false, error: 'invalid_diagnostic_user_id' }, 400);
  const testDate = str(body.test_date);
  if (testDate && !DATE_RE.test(testDate)) return json({ ok: false, error: 'invalid_test_date' }, 400);

  // ── ① S3 の実体を読む。ここで存在・サイズ・ハッシュが決まる ──────────
  const got = await readUploadedOriginal(key);
  if (!got.ok) {
    const status = got.error === 'originals_s3_not_configured' ? 503 : got.error === 'not_found' ? 404 : 400;
    return json({ ok: false, error: got.error, detail: got.detail ?? null, key }, status);
  }

  // ── ② 付け先の artifact ────────────────────────────────────────
  let targetId = artifactId;
  let created = false;
  if (!targetId) {
    const testType = LAB_COMPANY_TO_TEST_TYPE[labCompany as string];
    const { data, error } = await (sb.schema('diagnosis') as never as {
      from: (t: string) => {
        insert: (v: unknown) => { select: (c: string) => { single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }> } };
      };
    })
      .from('test_artifacts')
      .insert({
        diagnostic_user_id: uid ?? UNASSIGNED_UID,
        source: 'wellfort_lab',
        test_type: testType,
        ...(testDate ? { test_date: testDate } : {}),
        schema_version: '1.0',
        display_mode: 'single',
        imported_by: 'wellfort_admin_upload',
        status: 'active',
        notes: 'uploaded via /admin/lab-results/upload-ticket (S3 direct)',
      })
      .select('id')
      .single();
    if (error || !data) return json({ ok: false, error: 'db_error', detail: error?.message ?? 'insert failed' }, 500);
    targetId = data.id;
    created = true;
  }

  // ── ③ 台帳へ登録。**ここが入って初めて /result で原本が出る** ────────
  const fileKind = key.toLowerCase().endsWith('.csv') ? 'raw_csv' : 'raw_pdf';
  const { error: fileErr } = await (sb.schema('diagnosis') as never as {
    from: (t: string) => { insert: (v: unknown) => Promise<{ error: { message: string } | null }> };
  })
    .from('test_artifact_files')
    .insert({
      test_artifact_id: targetId,
      file_kind: fileKind,
      storage_url: got.storageUrl,
      sha256: got.sha256,
      size_bytes: got.sizeBytes,
    });
  if (fileErr) {
    // artifact だけ作って台帳が空、という半端な状態を黙って残さない。
    return json(
      { ok: false, error: 'db_error', detail: fileErr.message, test_artifact_id: targetId, artifact_created: created },
      500,
    );
  }

  return json({
    ok: true,
    test_artifact_id: targetId,
    artifact_created: created,
    diagnostic_user_id: uid ?? (created ? UNASSIGNED_UID : null),
    file_kind: fileKind,
    storage_url: got.storageUrl,
    sha256: got.sha256,
    size_bytes: got.sizeBytes,
    content_type: got.contentType,
  });
};
