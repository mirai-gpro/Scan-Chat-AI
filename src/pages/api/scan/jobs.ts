/**
 * POST /api/scan/jobs — **スキャンのジョブを積む。ここでユーザーの用事は終わり。**
 *
 * 正本: `docs/scan/スキャン非同期処理_仕様書.md` §4.1 ②③。
 *
 * 受けるのは **S3 のキーの配列とヒントだけ**（数百バイト）。画像本体は
 * ブラウザが presigned PUT で S3 へ置いてあるので、**関数を通らない**
 * (Vercel のリクエスト本文 4.5MB 制限にかからない)。
 *
 * 入力  { keys: string[], hint?: string }
 * 出力  { ok: true, job_id }
 *
 * **本人の行としてしか作らない。** uid は Cookie から解決したものだけを使い、
 * リクエスト本文からは受け取らない (`/api/scan/save` と同じ規律)。
 */
import type { APIRoute } from 'astro';
import { resolveViewer } from '../../../lib/viewer';
import { getS3Config } from '../../../lib/s3';
import { isScanUploadKey } from '../../../lib/scan-upload-ticket';
import { enqueueScanJob } from '../../../lib/scan-jobs';

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const POST: APIRoute = async (ctx) => {
  /*
   * `?u=` は admin の代理表示専用。**ジョブの作成には使わない** —
   * 代理表示中に積むと、相手の検査結果を勝手に作ることになる。
   */
  const viewer = await resolveViewer(ctx);
  const uid = viewer.selfUid;
  if (!uid) return json({ ok: false, error: 'not_signed_in' }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await ctx.request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const raw = Array.isArray(body.keys) ? body.keys : [];
  const keys = raw.filter((k): k is string => typeof k === 'string' && !!k);
  if (keys.length === 0) return json({ ok: false, error: 'keys is required' }, 400);

  /*
   * **キーは必ず検査する。** ここを緩めると、同じバケットの Elith 納品 JSON
   * (全利用者ぶん) をワーカーに読ませることができてしまう。
   * 検査は既存の `isScanUploadKey` (形の**完全一致**) をそのまま使う。
   */
  const cfg = getS3Config();
  if (!cfg) return json({ ok: false, error: 's3_not_configured' }, 503);
  const bad = keys.filter((k) => !isScanUploadKey(k, cfg));
  if (bad.length > 0) {
    // **キーそのものはログにも応答にも出さない** (§3.3)。件数だけ返す。
    console.error(`[scan/jobs] 形式の違うキーを ${bad.length} 件受け取ったので拒否しました`);
    return json({ ok: false, error: 'invalid_key', count: bad.length }, 400);
  }

  const hint = typeof body.hint === 'string' ? body.hint.slice(0, 500) : null;
  const r = await enqueueScanJob(uid, keys, hint);
  if (!r.ok) return json({ ok: false, error: r.error }, 500);
  return json({ ok: true, job_id: r.id, page_count: keys.length });
};
