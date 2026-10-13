/**
 * Partner Portal 上り（Wellfort → プリベント）**問診CSV** API。
 *
 * 正本: `docs/lab/lab_data_pipeline_master_spec.md` §4-5.3 ／
 *       `docs/lab/kit_receipt_external_id_capture_spec.md` §7.1。
 *
 * 役割分担どおり **UI は wellfort-site、鍵と処理は Scan-Chat-AI**。
 * したがって本 API は **wellfort-site のサーバからのみ**呼ばれる（Bearer `ADMIN_API_KEY`）。
 * ブラウザから直接叩かせない（鍵がブラウザに出る）。既存の
 * `api/partner/laif-upload.ts` と同じ形にそろえてある（中継の実装を 2 種類にしない）。
 *
 * mode:
 *   'list'     … 取得できる問診CSV の一覧（**バーコードNo. だけ**を外へ出す）
 *   'download' … 1 件ぶんの CSV 本体（base64）
 *
 * 【partner を body から信用しない…のは中継側の仕事】
 * ここへ来る `partner` は **wellfort-site がパスキー session から取り出した値**
 * （`api/partner/upload.ts:51-58` と同じ規律）。本 API は念のため
 * **`prevent` 以外を拒否する** — 将来 LAiF 用の口を同じファイルに足されても、
 * プリベントの CSV が別パートナーへ出ない。
 *
 * 【ゲートは迂回できない】一覧も DL も `src/lib/prevent-questionnaire.ts` を通り、
 * そこが `loadCapturedExternalId()` → `checkPreventQuestionnaireGate()` を呼ぶ。
 * 本 API に `status` を見るコードは 1 行も無い（＝条件が 2 か所に分かれない）。
 */

import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../lib/api-auth';
import {
  listPreventQuestionnaires, buildPreventQuestionnaireFile,
} from '../../../lib/prevent-questionnaire';

export const prerender = false;

const ALLOWED_MODES = new Set(['list', 'download']);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const mode = typeof body.mode === 'string' ? body.mode : '';
  if (!ALLOWED_MODES.has(mode)) return json({ ok: false, error: `unknown mode: ${mode}` }, 400);

  // **プリベント以外は受けない。** 中継が session から入れた値のはず。
  const partner = typeof body.partner === 'string' ? body.partner.trim().toLowerCase() : '';
  if (partner !== 'prevent') {
    return json({ ok: false, error: 'partner_mismatch', detail: 'この口はプリベント専用です。' }, 403);
  }

  if (mode === 'list') {
    const r = await listPreventQuestionnaires();
    return json({
      ok: true, mode, partner,
      entries: r.entries,
      // **プリベントへは返さない情報**。中継が落とす（件数だけ admin の切り分けに使う）。
      skipped_count: r.skipped.length,
      skipped: r.skipped,
    });
  }

  const r = await buildPreventQuestionnaireFile(body.barcodeNo);
  if (!r.ok) return json({ ok: false, error: r.error, detail: r.detail }, r.status);
  return json({
    ok: true, mode, partner,
    barcode_no: r.barcodeNo,
    filename: r.filename,
    content_type: 'text/csv; charset=utf-8',
    /** 本体は base64。CSV は数 KB なので中継して問題にならない（PDF と違う）。 */
    csv_base64: Buffer.from(r.csv, 'utf8').toString('base64'),
    column_count: r.columnCount,
    filled_count: r.filledCount,
  });
};
