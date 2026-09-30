/**
 * AI スキャン読込結果を Elith 連携用に S3 へ書き出すエンドポイント (暫定テスト用)。
 *
 * 入力 (POST JSON):
 *   {
 *     markdownClean: string,        // 確定 Markdown (必須)
 *     diagnosticId?: string,        // 端末発番の UUID。無ければサーバで生成
 *     (diagnosticUserId は受け取っても使わない。対象は Cookie / 共有セッションから解決する)
 *     model?: string|null,
 *     hint?: string|null,
 *     capturedAt?: string           // ISO8601 (任意)
 *   }
 *
 * 出力:
 *   - S3 設定あり: { ok:true, configured:true, bucket, folder, uploaded:[{key,bytes,uri}], json }
 *   - S3 未設定 : { ok:false, configured:false, folder, files:[{name,bytes}], json }  ← ドライラン
 *
 * 命名/フォーマットは暫定 (scan-export-v0)。詳細は docs/scan/scan_s3_export.md / lib/scan-export.ts。
 */

import type { APIRoute } from 'astro';
import { putScanExport } from '../../../lib/scan-export-put';
import { resolveViewer } from '../../../lib/viewer';
import { denyReadOnlyWrite, denyUnlessShareScope, denyAnonymous } from '../../../lib/write-guard';
import { logShareApiEvent } from '../../../lib/share-access';

export const prerender = false;

interface ExportBody {
  markdownClean?: unknown;
  diagnosticId?: unknown;
  diagnosticUserId?: unknown;
  model?: unknown;
  hint?: unknown;
  sourceFileName?: unknown;
  capturedAt?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export const POST: APIRoute = async (ctx) => {
  const { request } = ctx;
  /*
   * **代理表示中は書かせない**（2026-09-30・仕様書 §12.5 / §38-U27）。
   * この口は S3 へ書く＝永続書き込み。**認証そのものはこれまでどおり課していない**
   * （§21.4 の Phase 0 で別途塞ぐ）が、**代理表示からの書き込みだけはここで止める**。
   */
  const viewer = await resolveViewer(ctx);
  const denied = denyReadOnlyWrite(viewer);
  if (denied) return denied;
  // **共有は scope に `scan` があるときだけ**（§17.2）。
  const scoped = denyUnlessShareScope(viewer, 'scan');
  if (scoped) return scoped;
  /*
   * 【2026-09-30・§20.3】**未認証を止める。** この口は S3 へ書くので、
   * 誰でも叩ける状態は納品領域を他人に使わせることになる。
   */
  const unauth = denyAnonymous(viewer);
  if (unauth) return unauth;

  let body: ExportBody;
  try {
    body = (await request.json()) as ExportBody;
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const markdownClean = typeof body.markdownClean === 'string' ? body.markdownClean : '';
  if (!markdownClean.trim()) {
    return json({ ok: false, error: 'markdownClean is required' }, 400);
  }

  const diagnosticId = str(body.diagnosticId) ?? crypto.randomUUID();
  /*
   * 【2026-09-30・§20.3】**body の `diagnosticUserId` を使わない。**
   * この値は S3 の納品フォルダ (`{prefix}user/{client_id}/…`) と JSON の中身に効くので、
   * クライアントが名乗れると **他人の納品領域へ書ける**。対象は resolver が決める。
   */
  const diagnosticUserId = viewer.writeTargetUid;
  const claimed = str(body.diagnosticUserId);
  if (claimed && diagnosticUserId && claimed !== diagnosticUserId) {
    // **止めない。記録するのは「食い違った」事実だけ**（申告値はログに書かない・§26.2）。
    await logShareApiEvent(ctx, 'target_tamper_attempt', '/api/scan/export');
  }
  /*
   * **ここで `scan_use` を記録しない**（§26.1・2026-09-30 のレビュー）。
   * `scan_use` = `/api/scan/save` または `/api/scan/jobs` と決まっており、
   * 画面は 1 回の送信で `save` と `export` の**両方**を呼ぶので、
   * ここでも記録すると**同じ操作が 2 件**になる。
   */
  const capturedRaw = str(body.capturedAt);
  const capturedAt = capturedRaw && !Number.isNaN(Date.parse(capturedRaw)) ? new Date(capturedRaw) : undefined;
  const exportedAt = new Date();

  /*
   * **書き出しは `scan-export-put.ts` に集約**。cron ワーカー (背景経路) も
   * 同じ関数を呼ぶので、**前景で送っても背景で読まれても同じ納品物**が出る。
   * ここで直接 buildScanExportBundle + putFiles を書かないこと。
   */
  const r = await putScanExport(markdownClean, {
    diagnosticId,
    diagnosticUserId,
    model: str(body.model),
    hint: str(body.hint),
    sourceFileName: str(body.sourceFileName),
    capturedAt,
    exportedAt,
  });

  if (!r.configured) {
    // ドライラン: 生成物のプレビューを返す (S3 未設定でも変換結果を確認できる)
    return json({
      ok: false,
      configured: false,
      reason: 's3_not_configured',
      message: 'AWS_S3_BUCKET / AWS_REGION 未設定のため S3 へは書き出していません。生成物のプレビューを返します。',
      diagnostic_id: diagnosticId,
      folder: r.folder,
      files: r.files,
      json: r.json,
    });
  }

  if (!r.ok) {
    return json(
      { ok: false, configured: true, error: 'S3 upload failed', detail: r.error, folder: r.folder },
      502,
    );
  }

  return json({
    ok: true,
    configured: true,
    bucket: r.bucket,
    region: r.region,
    diagnostic_id: diagnosticId,
    folder: r.folder,
    uploaded: r.uploaded,
    json: r.json,
  });
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
