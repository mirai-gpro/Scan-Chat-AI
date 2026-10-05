/**
 * トランスコスモス 10 名の **完成済み AI疾病予防報告書 PDF** の一括登録。
 *
 * 正本の説明は `src/lib/transcosmos-reports.ts` の冒頭。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【PDF 本体はこの関数を通さない】
 * ══════════════════════════════════════════════════════════════════════
 *
 * 最大 15MB 超の PDF が 10 本あり、Vercel Functions の**リクエスト本文は 4.5MB**
 * (出典: vercel.com/docs/functions/limitations)。ブラウザ → 関数 → Storage と
 * 中継すると**関数に届く前に 413 で落ちる**ので、
 *
 *     ブラウザ → (この API) 署名つき upload URL を貰う
 *             → ブラウザ → Supabase Storage へ直接 PUT
 *             → (この API) finalize で DB へ記録
 *
 * の形にする。この関数が受けるのは `slot` / `sizeBytes` / `sha256` という
 * 数百バイトの JSON だけ。**スキャンの S3 直アップロードと同じ考え方。**
 *
 * 【認可は今ログインしている管理者の session】`ADMIN_API_KEY` は使わない
 * (発注者指示)。`resolveViewer` → `viewer.isAdmin` は Cookie の本人で判定するので、
 * `?u=` を admin uid にしただけでは通らない (`admin/index.astro` と同じ)。
 */

import type { APIRoute } from 'astro';
import { resolveViewer } from '../../../lib/viewer';
import { getServerSupabase } from '../../../lib/supabase';
import {
  TRANSCOSMOS_BUCKET,
  TRANSCOSMOS_SCHEMA_VERSION,
  TRANSCOSMOS_SLOTS,
  isTranscosmosStoragePath,
  transcosmosSourceKey,
  transcosmosStoragePath,
  transcosmosUidForSlot,
  validateTranscosmosPlan,
} from '../../../lib/transcosmos-reports';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' },
  });
}

export const POST: APIRoute = async (ctx) => {
  /*
   * **管理者 session で認可する。** ここを API キーにすると、鍵を持つ誰か
   * (= 専用 PC やスクリプト) が 10 名の枠へ書けることになる。
   */
  const viewer = await resolveViewer(ctx);
  if (!viewer.isAdmin) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try { body = await ctx.request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const action = String(body.action ?? '');
  if (action !== 'plan' && action !== 'finalize') {
    return json({ ok: false, error: 'unknown_action' }, 400);
  }

  const sb = getServerSupabase();
  if (!sb) return json({ ok: false, error: 'supabase_not_configured' }, 503);
  const storage = sb.storage.from(TRANSCOSMOS_BUCKET);

  /*
   * **10 件の形を先に全部見る。** 1 件でも駄目なら署名も発行しないし DB も触らない
   * (半分だけ入った状態を作らない)。`slot → uid` はここで引き直すので、
   * クライアントが送った uid は一切使わない。
   */
  const check = validateTranscosmosPlan(body.files);
  if (!check.ok) return json({ ok: false, error: check.error, detail: check.detail ?? null }, 400);
  const items = check.items;

  // ── plan: 署名つき upload URL を 10 本発行する ─────────────────────
  if (action === 'plan') {
    const planned: {
      slot: string; uid: string; path: string; token: string; signedUrl: string;
      sizeBytes: number; sha256: string;
    }[] = [];
    for (const it of items) {
      // **保存キーはサーバが採番する** (氏名・元ファイル名を入れない・毎回新しい乱数)。
      const path = transcosmosStoragePath(it.uid, crypto.randomUUID());
      const { data, error } = await storage.createSignedUploadUrl(path);
      if (error || !data) {
        return json({ ok: false, error: 'sign_failed', detail: error?.message ?? null, slot: it.slot }, 503);
      }
      planned.push({
        slot: it.slot, uid: it.uid, path: data.path, token: data.token,
        signedUrl: data.signedUrl, sizeBytes: it.sizeBytes, sha256: it.sha256,
      });
    }
    return json({ ok: true, bucket: TRANSCOSMOS_BUCKET, files: planned });
  }

  // ── finalize: Storage に在ることを確かめてから DB へ ───────────────
  const paths = new Map<string, string>();
  for (const raw of (Array.isArray(body.files) ? body.files : [])) {
    const e = (raw ?? {}) as { slot?: unknown; path?: unknown };
    const slot = String(e.slot ?? '');
    const path = String(e.path ?? '');
    /*
     * **キーの形と「その slot の uid 配下か」を両方見る。**
     * 形だけだと、別人の uid のキーを添えて送れてしまう
     * (通ると A さんの PDF が B さんの行に紐付く)。
     */
    if (!isTranscosmosStoragePath(path)) return json({ ok: false, error: 'invalid_path', detail: slot }, 400);
    const uid = transcosmosUidForSlot(slot);
    if (!uid) return json({ ok: false, error: 'unknown_slot', detail: slot }, 400);
    if (!path.includes(`/${uid}/`)) return json({ ok: false, error: 'path_uid_mismatch', detail: slot }, 400);
    paths.set(slot, path);
  }
  if (paths.size !== TRANSCOSMOS_SLOTS.length) {
    return json({ ok: false, error: 'path_count_mismatch', detail: `${paths.size} 件` }, 400);
  }

  /*
   * **保存実体が在ることを確かめる。** 応答を信じるだけだと、upload が
   * 失敗した回に DB だけ出来上がり、**ダッシュボードのボタンは押せるのに
   * 開くと 503** になる (利用者から見ていちばん悪い形)。
   * PDF 本体を関数へ落とす必要は無く、**object の存在と size > 0** で足りる。
   */
  const verified: { slot: string; uid: string; path: string; sizeBytes: number; sha256: string }[] = [];
  for (const it of items) {
    const path = paths.get(it.slot)!;
    const dir = path.slice(0, path.lastIndexOf('/'));
    const base = path.slice(path.lastIndexOf('/') + 1);
    const { data, error } = await storage.list(dir, { limit: 100, search: base });
    if (error) return json({ ok: false, error: 'storage_list_failed', detail: error.message, slot: it.slot }, 503);
    const hit = (data ?? []).find((f) => f.name === base);
    if (!hit) return json({ ok: false, error: 'object_missing', detail: it.slot }, 409);
    const size = hit.metadata?.size ?? 0;
    if (!(size > 0)) return json({ ok: false, error: 'object_empty', detail: it.slot }, 409);
    verified.push({ slot: it.slot, uid: it.uid, path, sizeBytes: size, sha256: it.sha256 });
  }

  const dsb = sb.schema('diagnosis');

  /*
   * **`app_users` の placeholder を作る。**
   * `diagnosis_results.diagnostic_user_id` は `app_users` への FOREIGN KEY
   * (`20260601000010:231`) で、10 名は**まだ誰もログインしていない**ので行が無い。
   *
   * 入れるのは `diagnostic_user_id` 1 列だけ。
   * **`auth_user_id` / `google_sub` / `hp_customer_user_id` / `display_name_cache`
   * は 1 つも書かない** (全部 NULL のまま)。Supabase Auth user も password も作らない。
   *
   * `ignoreDuplicates: true` なので**既存行があれば何も上書きしない** — 本人が
   * 先にログインしていた回の `auth_user_id` を壊さない。後から本人が Sign up /
   * Sign in すると `/api/auth/resolve` がこの**同じ行**へ認証を紐付ける
   * (別 uid を発行しない)。
   */
  const { error: userErr } = await dsb.from('app_users').upsert(
    verified.map((v) => ({ diagnostic_user_id: v.uid })),
    { onConflict: 'diagnostic_user_id', ignoreDuplicates: true },
  );
  if (userErr) return json({ ok: false, error: 'app_user_failed', detail: userErr.message }, 500);

  /*
   * **既存行を先に全部引いてから update / insert を分ける。**
   * `source_key` には部分 UNIQUE 索引がある (`20260917000010`) が、それに頼らず
   * `diagnostic_user_id + source_key` で引く (行が増えないことを自分で保証する)。
   */
  const sourceKeys = verified.map((v) => transcosmosSourceKey(v.uid));
  const { data: existingRows, error: findErr } = await dsb
    .from('diagnosis_results')
    .select('id, diagnostic_user_id, source_key')
    .in('source_key', sourceKeys);
  if (findErr) return json({ ok: false, error: 'result_lookup_failed', detail: findErr.message }, 500);

  const existingByUid = new Map<string, string>();
  for (const r of existingRows ?? []) {
    if (r.source_key === transcosmosSourceKey(r.diagnostic_user_id)) {
      existingByUid.set(r.diagnostic_user_id, r.id);
    }
  }

  const now = new Date().toISOString();
  const results: { slot: string; uid: string; resultId: string; mode: 'insert' | 'update' }[] = [];
  for (const v of verified) {
    const row = {
      diagnostic_user_id: v.uid,
      report: [],
      schema_version: TRANSCOSMOS_SCHEMA_VERSION,
      status: 'received',
      // 相対キーなので `getOriginalSignedUrl` が lab-results の署名 URL を作る。
      report_pdf_url: v.path,
      report_pdf_sha256: v.sha256,
      report_pdf_received_at: now,
      received_at: now,
      source_key: transcosmosSourceKey(v.uid),
    };
    const existingId = existingByUid.get(v.uid);
    if (existingId) {
      // **`diagnostic_id` は維持**し、行は増やさない (冪等)。
      const { error } = await dsb.from('diagnosis_results').update(row).eq('id', existingId);
      if (error) return json({ ok: false, error: 'result_update_failed', detail: error.message, slot: v.slot }, 500);
      results.push({ slot: v.slot, uid: v.uid, resultId: existingId, mode: 'update' });
    } else {
      const { data, error } = await dsb
        .from('diagnosis_results')
        .insert({ ...row, diagnostic_id: crypto.randomUUID() })
        .select('id')
        .single();
      if (error || !data) {
        return json({ ok: false, error: 'result_insert_failed', detail: error?.message ?? null, slot: v.slot }, 500);
      }
      results.push({ slot: v.slot, uid: v.uid, resultId: data.id, mode: 'insert' });
    }
  }

  return json({ ok: true, count: results.length, results });
};
