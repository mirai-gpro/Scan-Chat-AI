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
 * 【**既存の artifact に足す。勝手に作らない**】(発注者指示 2026-09-29)
 *   この口の用途は「原本 PDF の差し替え・紐付け」であって検査の新規登録ではない。
 *   本田さんの遺伝子 / AI疾病予測は既に artifact があり、**`display_mode='three_mode'`
 *   などの既存の状態を壊してはならない**。そこで:
 *     - `test_artifact_id` を渡せばその行に足す
 *     - 渡さなければ `diagnostic_user_id` + 検査種別 (+ 受診日) で
 *       **active な既存行を一意に解決**する
 *     - 見つからない / 複数ある → **エラーで止める**。`allow_create: true` を
 *       明示したときだけ新規作成する (fail-closed)
 *   **`test_artifacts` は一切 UPDATE しない** = 既存の display_mode / test_date を触らない。
 *
 * 【二重登録しない】同じ artifact に同じ `file_kind` の行が既にあれば
 *   `file_exists` で止める。`replace: true` を明示したときだけ、
 *   その種別の既存行を消してから入れ直す (S3 側は versioning が履歴を持つ)。
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
import { decideOriginalRegistration, type ExistingOriginalRow } from '../../../../lib/additional-originals';
import { supersedeDerivedBloodOnSameDate } from '../../../../lib/scan-persist';

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

/** 顧客未割当 (`upload.ts:30` と同じ値)。**新規作成を明示したときだけ使う。** */
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

// supabase-js の型を引き回さずに使うための最小形。
type Db = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const db = (sb: NonNullable<ReturnType<typeof getServerSupabase>>): Db =>
  sb.schema('diagnosis') as unknown as Db;

interface ArtifactRow {
  id: string;
  diagnostic_user_id: string;
  test_type: string;
  test_date: string | null;
  status: string;
  display_mode: string;
}

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
  const testType = labCompany ? LAB_COMPANY_TO_TEST_TYPE[labCompany] : null;
  const wantId = str(body.test_artifact_id);
  const uid = str(body.diagnostic_user_id);
  const testDate = str(body.test_date);
  const allowCreate = body.allow_create === true;
  const replace = body.replace === true;

  if (wantId && !UUID_RE.test(wantId)) return json({ ok: false, error: 'invalid_test_artifact_id' }, 400);
  if (uid && !UUID_RE.test(uid)) return json({ ok: false, error: 'invalid_diagnostic_user_id' }, 400);
  if (testDate && !DATE_RE.test(testDate)) return json({ ok: false, error: 'invalid_test_date' }, 400);
  if (!wantId && !uid) {
    return json(
      { ok: false, error: 'target_required', detail: 'test_artifact_id か diagnostic_user_id のどちらかが要ります' },
      400,
    );
  }
  if (!wantId && !testType) {
    return json({ ok: false, error: 'invalid_lab_company', detail: '既存行を探すには検査会社が要ります' }, 400);
  }

  // ── ① 付け先の artifact を決める。**ここで新規作成はしない** ─────────
  let target: ArtifactRow | null = null;

  if (wantId) {
    const { data, error } = await db(sb)
      .from('test_artifacts')
      .select('id, diagnostic_user_id, test_type, test_date, status, display_mode')
      .eq('id', wantId)
      .maybeSingle();
    if (error) return json({ ok: false, error: 'db_error', detail: error.message }, 500);
    if (!data) return json({ ok: false, error: 'artifact_not_found', detail: wantId }, 404);
    target = data as ArtifactRow;
    // 取り違え防止: uid / 種別を渡しているなら一致を要求する。
    if (uid && target.diagnostic_user_id.toLowerCase() !== uid.toLowerCase()) {
      return json(
        { ok: false, error: 'artifact_user_mismatch', detail: `この artifact は別の利用者のものです`, artifact_user: target.diagnostic_user_id },
        409,
      );
    }
    if (testType && target.test_type !== testType) {
      return json(
        { ok: false, error: 'artifact_type_mismatch', detail: `artifact は ${target.test_type}、指定は ${testType}` },
        409,
      );
    }
  } else {
    let q = db(sb)
      .from('test_artifacts')
      .select('id, diagnostic_user_id, test_type, test_date, status, display_mode')
      .eq('diagnostic_user_id', uid)
      .eq('test_type', testType)
      .eq('status', 'active')
      .order('test_date', { ascending: false });
    if (testDate) q = q.eq('test_date', testDate);
    const { data, error } = await q;
    if (error) return json({ ok: false, error: 'db_error', detail: error.message }, 500);
    const rows = (data ?? []) as ArtifactRow[];

    if (rows.length === 1) {
      target = rows[0];
    } else if (rows.length > 1) {
      // **どれに付けるかを機械で決めない。** 候補を返して人に選ばせる。
      return json(
        {
          ok: false,
          error: 'artifact_ambiguous',
          detail: `active な ${testType} が ${rows.length} 件あります。test_artifact_id か test_date で指定してください。`,
          candidates: rows.map((r) => ({ id: r.id, test_date: r.test_date, display_mode: r.display_mode })),
        },
        409,
      );
    } else if (!allowCreate) {
      return json(
        {
          ok: false,
          error: 'artifact_not_found',
          detail: `active な ${testType} が見つかりません。既存に付けるなら test_artifact_id を、新規に作るなら allow_create を指定してください。`,
        },
        404,
      );
    }
  }

  // ── ② 見つからず、かつ明示的に許可されたときだけ新規作成 ────────────
  let created = false;
  if (!target) {
    const { data, error } = await db(sb)
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
      .select('id, diagnostic_user_id, test_type, test_date, status, display_mode')
      .single();
    if (error || !data) return json({ ok: false, error: 'db_error', detail: error?.message ?? 'insert failed' }, 500);
    target = data as ArtifactRow;
    created = true;
  }

  // ── ③ S3 の実体を読む。存在・サイズ・ハッシュはここで決まる ──────────
  const got = await readUploadedOriginal(key);
  if (!got.ok) {
    const status = got.error === 'originals_s3_not_configured' ? 503 : got.error === 'not_found' ? 404 : 400;
    return json({ ok: false, error: got.error, detail: got.detail ?? null, key }, status);
  }

  // ── ④ 同じ種別の原本が既にあるか。**黙って二重に足さない** ───────────
  const fileKind = key.toLowerCase().endsWith('.csv') ? 'raw_csv' : 'raw_pdf';
  const { data: existing, error: exErr } = await db(sb)
    .from('test_artifact_files')
    .select('id, file_kind, storage_url, sha256, size_bytes, created_at')
    .eq('test_artifact_id', target.id)
    .eq('file_kind', fileKind);
  if (exErr) return json({ ok: false, error: 'db_error', detail: exErr.message }, 500);

  /*
   * **判定は共通ライブラリへ寄せた** (2026-09-30・仕様書 §0.4.2)。
   * 追加検査の `finalize` と**同じ判定**を使うが、
   * **返すエラー名とステータスはこの API が決める** — 下の `file_exists` / 409 は
   * 既存の契約なので 1 バイトも変えない (wellfort-site がこの文字列を見ている)。
   */
  const prior = (existing ?? []) as ExistingOriginalRow[];
  const { decision } = decideOriginalRegistration(prior, got.sha256);
  if (decision !== 'none') {
    if (decision === 'same_sha') {
      // 中身が同じ = 既に登録済み。何もしない (再実行しても増えない)。
      return json({
        ok: true,
        already_registered: true,
        test_artifact_id: target.id,
        file_kind: fileKind,
        sha256: got.sha256,
        detail: '同じ内容の原本が既に登録されています。何も変更していません。',
      });
    }
    if (!replace) {
      return json(
        {
          ok: false,
          error: 'file_exists',
          detail: `この検査には ${fileKind} が既に ${prior.length} 件あります。差し替えるなら replace を指定してください。`,
          test_artifact_id: target.id,
          existing: prior.map((p) => ({ id: p.id, storage_url: p.storage_url, sha256: p.sha256, size_bytes: p.size_bytes, created_at: p.created_at })),
        },
        409,
      );
    }
    // 差し替え: 台帳の古い行だけ消す。**S3 のオブジェクトは消さない**
    // (原本は 10 年保管・削除不可。versioning が履歴を持つ)。
    const { error: delErr } = await db(sb)
      .from('test_artifact_files')
      .delete()
      .eq('test_artifact_id', target.id)
      .eq('file_kind', fileKind);
    if (delErr) return json({ ok: false, error: 'db_error', detail: delErr.message }, 500);
  }

  // ── ⑤ 台帳へ登録。**ここが入って初めて /result で原本が出る** ────────
  const { error: fileErr } = await db(sb)
    .from('test_artifact_files')
    .insert({
      test_artifact_id: target.id,
      file_kind: fileKind,
      storage_url: got.storageUrl,
      sha256: got.sha256,
      size_bytes: got.sizeBytes,
    });
  if (fileErr) {
    return json(
      { ok: false, error: 'db_error', detail: fileErr.message, test_artifact_id: target.id, artifact_created: created },
      500,
    );
  }

  /*
   * **通常 blood が実在の利用者に紐づいた回は、同じ受診日の派生 blood を降ろす**
   * (発注者指示 §7 / 裁定 Q-10)。「通常 blood が後から届いた場合も通常が勝つ」。
   *
   * **ここに置く理由**: `lab-results/upload.ts` は artifact を `UNASSIGNED_UID` で作るので
   * (顧客未割当) その時点では誰の血液検査か決まっておらず、呼んでも空振りにしかならない。
   * 通常 blood が**実在の利用者に紐づく**のはこの register 側なので、優先の適用はここ 1 本。
   *
   * **削除ではなく superseded。** 触るのは `imported_by='derived_healthcheck_blood'` の行だけで、
   * 通常 blood の行には 1 行も触らない。**失敗しても取り込みは成功のまま返す。**
   */
  let supersededDerivedBlood = 0;
  if (target.test_type === 'blood'
      && target.diagnostic_user_id
      && target.diagnostic_user_id !== UNASSIGNED_UID) {
    const r = await supersedeDerivedBloodOnSameDate(
      sb as never, target.diagnostic_user_id, target.test_date,
    );
    supersededDerivedBlood = r.superseded;
  }

  return json({
    ok: true,
    test_artifact_id: target.id,
    artifact_created: created,
    /** 同日の人間ドック由来 派生 blood を降ろした件数 (0 なら対象なし)。 */
    superseded_derived_blood: supersededDerivedBlood,
    // **触っていないことを応答で示す** (three_mode が保たれたかを目で確かめられるように)。
    diagnostic_user_id: target.diagnostic_user_id,
    test_type: target.test_type,
    test_date: target.test_date,
    display_mode: target.display_mode,
    replaced: prior.length > 0,
    file_kind: fileKind,
    storage_url: got.storageUrl,
    sha256: got.sha256,
    size_bytes: got.sizeBytes,
    content_type: got.contentType,
  });
};
