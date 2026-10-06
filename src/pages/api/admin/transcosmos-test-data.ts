/**
 * トランスコスモス 10 名の **検査データ一括反映** — Genoplan (遺伝子) 専用の口。
 *
 * 正本は `src/lib/transcosmos-test-data.ts` の冒頭。
 *
 *   POST { action: 'genetics-plan',     files: [{ slot, sizeBytes, sha256, pageCount }] }
 *        → 署名つき upload URL を 10 本返す (**PDF 本体はこの関数を通らない**)
 *   POST { action: 'genetics-finalize', files: [{ slot, path, sizeBytes, sha256, pageCount }] }
 *        → Storage の実体を確かめてから artifact と原本行を作る
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【健康診断はこの口を通らない】
 * ══════════════════════════════════════════════════════════════════════
 * 検診・人間ドックは**既存の本番経路** (`special-additional-tests` の
 * `scan-part` → `original-ticket` → `finalize`) をそのまま使う。専用 parser を作らない。
 * 血液も**別途登録しない** — `finalize` が `persistDerivedBloodArtifact()` で
 * 健康診断の測定値から派生 blood を自動生成する (§9)。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【遺伝子は原本 PDF の登録だけ】(§15)
 * ══════════════════════════════════════════════════════════════════════
 * 208〜210 ページを LLM に解析させない (時間・費用が目的に合わない)。
 * **測定値を作らない・AI に項目を捏造させない。**
 *
 * 認可 = Bearer `ADMIN_API_KEY` (UI は wellfort-site・サーバ間通信)。
 * **`refreshConfig(true)` を先に通す** — `isSpecialAccount()` は同期関数で
 * `app_config` の cache を読むだけなので、cold instance では空に見える
 * (2026-10-06 の P0 と同じ罠)。
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../lib/api-auth';
import { refreshConfig } from '../../../lib/app-config';
import { getServerSupabase } from '../../../lib/supabase';
import { decideOriginalRegistration } from '../../../lib/additional-originals';
import { checkAdditionalTarget, resolveAdditionalArtifact } from '../../../lib/special-additional-tests';
import {
  TRANSCOS_GENETICS_BUCKET, TRANSCOS_GENETICS_LAB, TRANSCOS_GENETICS_NOTE,
  TRANSCOS_IMPORTED_BY, TRANSCOS_SLOT_IDS,
  checkGeneticsInput, geneticsStoragePath, isGeneticsStoragePath, uidFromGeneticsPath,
} from '../../../lib/transcosmos-test-data';

export const prerender = false;
/** 10 件ぶんの存在確認と DB 書き込みを 1 リクエストで回す。既定の 60s では足りないことがある。 */
export const config = { maxDuration: 300 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' },
  });
}

/** `files` を 1 件ずつ検める。1 件でも駄目なら**署名も発行しないし DB も触らない**。 */
function checkAll(raw: unknown) {
  const list = Array.isArray(raw) ? raw : [];
  const items: ReturnType<typeof checkGeneticsInput>[] = list.map(checkGeneticsInput);
  const bad = items.find((r) => !r.ok);
  if (bad && !bad.ok) return { ok: false as const, error: bad.error, detail: bad.detail };
  const good = items.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
  const slots = new Set(good.map((g) => g.slot));
  if (slots.size !== good.length) return { ok: false as const, error: 'duplicate_slot', detail: null };
  return { ok: true as const, items: good };
}

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const action = String(body.action ?? '');
  if (action !== 'genetics-plan' && action !== 'genetics-finalize') {
    return json({ ok: false, error: 'unknown_action', detail: action || null }, 400);
  }

  /*
   * **資格を見る前に app_config を読み直す。** `isSpecialAccount()` は同期なので
   * cold instance では `special.account_uids` が空に見え、登録済みの uid まで
   * `not_special_account` になる (2026-10-06 の P0)。
   */
  await refreshConfig(true);

  const checked = checkAll(body.files);
  if (!checked.ok) return json({ ok: false, error: checked.error, detail: checked.detail }, 400);
  const items = checked.items;
  if (items.length === 0) return json({ ok: false, error: 'no_files', detail: null }, 400);

  // **対象はスペシャルアカウントだけ。** 番号から引いた uid で確かめる。
  for (const it of items) {
    const target = checkAdditionalTarget(it.info.uid);
    if (!target.ok) return json({ ok: false, error: target.error, detail: it.slot }, 403);
  }

  const sb = getServerSupabase();
  if (!sb) return json({ ok: false, error: 'supabase_not_configured' }, 503);
  const storage = sb.storage.from(TRANSCOS_GENETICS_BUCKET);

  /*
   * **保存先バケットが無ければ作る** (2026-10-06 実測の P0)。
   *
   * 本番は原本を S3 (`AWS_S3_ORIGINALS_BUCKET`) に置いているので、
   * フォールバック用の Supabase Storage `lab-results` は**一度も作られていなかった**。
   * そのため `createSignedUploadUrl()` が
   * **`sign_failed / The related resource does not exist`** で落ちていた
   * (エラー文がバケット名を言わないので、原因が分かりにくい)。
   *
   * 作るのは **private バケット 1 つだけ** — 公開しない・ポリシーも足さない。
   * 既に在れば何もしない (`already exists` は無視する)。
   * ここで作れなければ**何が足りないかを名指しで返す** (opaque な sign_failed にしない)。
   */
  async function ensureBucket(client: NonNullable<typeof sb>): Promise<{ ok: true } | { ok: false; detail: string }> {
    const got = await client.storage.getBucket(TRANSCOS_GENETICS_BUCKET);
    if (got.data) return { ok: true };
    const made = await client.storage.createBucket(TRANSCOS_GENETICS_BUCKET, { public: false });
    if (made.error && !/already exists/i.test(made.error.message ?? '')) {
      return { ok: false, detail: made.error.message ?? 'createBucket に失敗しました' };
    }
    return { ok: true };
  }

  // ── genetics-plan: 署名つき upload URL を発行する ─────────────────
  if (action === 'genetics-plan') {
    const bucket = await ensureBucket(sb);
    if (!bucket.ok) {
      return json({
        ok: false, error: 'bucket_unavailable',
        detail: `Supabase Storage のバケット "${TRANSCOS_GENETICS_BUCKET}" を用意できませんでした (${bucket.detail})。`,
      }, 503);
    }
    const planned: {
      slot: string; path: string; token: string; signedUrl: string;
      sizeBytes: number; sha256: string; pageCount: number;
    }[] = [];
    for (const it of items) {
      // **保存キーはサーバが採番する** (元ファイル名も氏名も入らない・毎回新しい乱数)。
      const path = geneticsStoragePath(it.info.uid, crypto.randomUUID());
      const { data, error } = await storage.createSignedUploadUrl(path);
      if (error || !data) {
        return json({ ok: false, error: 'sign_failed', detail: error?.message ?? null, slot: it.slot }, 503);
      }
      planned.push({
        slot: it.slot, path: data.path, token: data.token, signedUrl: data.signedUrl,
        sizeBytes: it.sizeBytes, sha256: it.sha256, pageCount: it.pageCount,
      });
    }
    return json({ ok: true, bucket: TRANSCOS_GENETICS_BUCKET, files: planned });
  }

  // ── genetics-finalize: 実体を確かめてから DB へ ───────────────────
  const paths = new Map<string, string>();
  for (const raw of (Array.isArray(body.files) ? body.files : [])) {
    const e = (raw ?? {}) as { slot?: unknown; path?: unknown };
    const slot = String(e.slot ?? '');
    const path = String(e.path ?? '');
    const info = items.find((i) => i.slot === slot)?.info;
    if (!info) return json({ ok: false, error: 'unknown_slot', detail: slot }, 400);
    /*
     * **キーの形と「その番号の uid 配下か」を両方見る。**
     * 形だけだと、別人の uid のキーを添えて送れてしまう
     * (通ると A さんの PDF が B さんの検査に紐付く)。
     */
    if (!isGeneticsStoragePath(path)) return json({ ok: false, error: 'invalid_path', detail: slot }, 400);
    if (uidFromGeneticsPath(path) !== info.uid) return json({ ok: false, error: 'path_uid_mismatch', detail: slot }, 400);
    paths.set(slot, path);
  }
  if (paths.size !== items.length) return json({ ok: false, error: 'path_count_mismatch', detail: `${paths.size} 件` }, 400);

  const dsb = sb.schema('diagnosis');
  const results: {
    slot: string; uid: string; artifactId: string; testDate: string;
    created: boolean; originalAlreadyRegistered: boolean; pageCount: number;
  }[] = [];

  for (const it of items) {
    const path = paths.get(it.slot)!;
    const uid = it.info.uid;
    const testDate = it.info.geneticsDate;

    /*
     * ① **Storage に実体が在るか。** 応答を信じるだけだと、upload が失敗した回に
     * DB だけ出来上がり、**「原本を開く」が押せるのに開かない**状態になる。
     * PDF 本体は関数へ落とさず、**存在と size > 0** だけ見る。
     */
    const dir = path.slice(0, path.lastIndexOf('/'));
    const base = path.slice(path.lastIndexOf('/') + 1);
    const { data: listed, error: listErr } = await storage.list(dir, { limit: 100, search: base });
    if (listErr) return json({ ok: false, error: 'storage_list_failed', detail: listErr.message, slot: it.slot }, 503);
    const hit = (listed ?? []).find((f) => f.name === base);
    if (!hit) return json({ ok: false, error: 'object_missing', detail: it.slot }, 409);
    const size = hit.metadata?.size ?? 0;
    if (!(size > 0)) return json({ ok: false, error: 'object_empty', detail: it.slot }, 409);

    /*
     * ② **`app_users` の placeholder。** `test_artifacts.diagnostic_user_id` は
     * `app_users` への FK で、まだ誰もログインしていない人は行が無い。
     * 入れるのは `diagnostic_user_id` **1 列だけ** — `auth_user_id` /
     * `google_sub` / `hp_customer_user_id` / `display_name_cache` は 1 つも書かない。
     * **Supabase Auth user も password も作らない。** `ignoreDuplicates: true` なので
     * 既存行は 1 列も上書きしない (後の本人サインインを邪魔しない)。
     */
    const { error: userErr } = await dsb.from('app_users').upsert(
      { diagnostic_user_id: uid },
      { onConflict: 'diagnostic_user_id', ignoreDuplicates: true },
    );
    if (userErr) return json({ ok: false, error: 'app_user_failed', detail: userErr.message, slot: it.slot }, 500);

    /*
     * ③ **artifact は 0 / 1 / 2 件以上で分ける** (§18)。判定は既存の
     * `resolveAdditionalArtifact()` と同じもの = **勝手に最新 1 件を選ばない**。
     */
    const found = await resolveAdditionalArtifact({ uid, testType: 'genetics', testDate });
    if (found.kind === 'error') return json({ ok: false, error: 'artifact_lookup_failed', detail: found.detail, slot: it.slot }, 500);
    if (found.kind === 'ambiguous') {
      return json({
        ok: false, error: 'artifact_ambiguous', slot: it.slot,
        detail: `同じ受診日の遺伝子検査が ${found.candidates.length} 件あります。どれに入れるかは人が決めてください。`,
      }, 409);
    }

    let artifactId = found.kind === 'one' ? found.artifactId : '';
    const created = found.kind === 'none';
    if (created) {
      const { data: ins, error: insErr } = await dsb.from('test_artifacts').insert({
        diagnostic_user_id: uid,
        test_type: 'genetics',
        test_date: testDate,
        source: 'admin_batch',
        lab_name: TRANSCOS_GENETICS_LAB,
        schema_version: '1.0',
        display_mode: 'single',
        page_count: it.pageCount,
        imported_by: TRANSCOS_IMPORTED_BY,
        status: 'active',
        // **測定値は作らない** (原本 PDF の登録だけ・§15)。
        measurements: [],
        // 事実だけ。医学的要約・評価は生成しない (§17)。
        scan_md: TRANSCOS_GENETICS_NOTE,
      }).select('id').single();
      if (insErr || !ins) return json({ ok: false, error: 'artifact_insert_failed', detail: insErr?.message ?? null, slot: it.slot }, 500);
      artifactId = String(ins.id);
    }

    /*
     * ④ **原本の紐付け** (§19)。同じ SHA が既にあれば no-op、違う SHA が
     * 既にあれば 409 で停止 — **黙って差し替えない。** 判定は既存の
     * `decideOriginalRegistration()` を共用する (規則を 2 つ持たない)。
     * `redaction` は未実装なので `raw_pdf_redacted` を名乗らない。
     */
    const { data: priorRows, error: priorErr } = await dsb
      .from('test_artifact_files')
      .select('id, file_kind, storage_url, sha256, size_bytes, created_at')
      .eq('test_artifact_id', artifactId)
      .eq('file_kind', 'raw_pdf');
    if (priorErr) return json({ ok: false, error: 'original_lookup_failed', detail: priorErr.message, slot: it.slot }, 500);

    const prior = (priorRows ?? []) as { sha256?: string | null }[];
    const { decision } = decideOriginalRegistration(prior as never, it.sha256);
    if (decision === 'different_sha') {
      return json({
        ok: false, error: 'original_conflict', slot: it.slot, test_artifact_id: artifactId,
        detail: `この検査には別の内容の原本が既に ${prior.length} 件あります。差し替えは管理者が明示的に行ってください。`,
      }, 409);
    }
    if (decision === 'none') {
      const { error: fileErr } = await dsb.from('test_artifact_files').insert({
        test_artifact_id: artifactId,
        file_kind: 'raw_pdf',
        // **相対キー**なので `getOriginalSignedUrl()` が lab-results の署名 URL を作る。
        storage_url: path,
        sha256: it.sha256,
        size_bytes: size,
      });
      if (fileErr) return json({ ok: false, error: 'original_link_failed', detail: fileErr.message, slot: it.slot }, 500);
    }

    results.push({
      slot: it.slot, uid, artifactId, testDate, created,
      originalAlreadyRegistered: decision === 'same_sha', pageCount: it.pageCount,
    });
  }

  return json({ ok: true, count: results.length, expected: TRANSCOS_SLOT_IDS.length, results });
};
