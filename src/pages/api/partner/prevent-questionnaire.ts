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
 *   'preview'  … **当社内部の様式確認専用**。配布の有効化ゲートを飛ばす代わりに、
 *                **中継（wellfort-site）の mode allow-list が `list`/`download` だけ**なので
 *                Partner Portal からは到達できない。応答に `format_status` を必ず載せる。
 *
 * 【配布は既定で閉じている】`list` / `download` は app_config
 * `labid.prevent_csv_release`（既定 off）＋ `PREVENT_CSV_FORMAT_STATUS`
 * （先方提供 Excel に合わせるまで `'unconfirmed'`）の**両方**が揃うまで何も返さない。
 * **`labid.prevent_capture` とは独立**にしてある — 撮影 UI が off でも台帳に過去／デモの
 * `confirmed` 行が残っていれば一覧に出得るので、「撮影が off だから CSV は 0 件」と
 * 仮定してはいけない。
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
  listPreventQuestionnaires, buildPreventQuestionnaireFile, isPreventCsvReleased,
} from '../../../lib/prevent-questionnaire';
import {
  PREVENT_CSV_FORMAT_STATUS, PREVENT_CSV_PENDING_COLUMNS,
} from '../../../lib/prevent-questionnaire-csv';

export const prerender = false;

/** `preview` は**当社内部用**。中継は allow-list でこれを通さない。 */
const ALLOWED_MODES = new Set(['list', 'download', 'preview']);

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
      // **配布が無効なら必ず空**。画面は `released` を見て案内を出す。
      released: r.released,
      hold_reason: r.holdReason ?? null,
      format_status: PREVENT_CSV_FORMAT_STATUS,
      entries: r.entries,
      // **プリベントへは返さない情報**。中継が落とす（件数だけ admin の切り分けに使う）。
      skipped_count: r.skipped.length,
      skipped: r.skipped,
    });
  }

  if (mode === 'preview') {
    /*
     * **当社内部の様式確認専用。** 配布ゲートを飛ばすのはここだけで、
     * Partner Portal からは中継の allow-list に阻まれて到達しない。
     * 「これは未確定様式である」ことを応答に必ず載せる（取り違えて外へ出さないため）。
     */
    const r = await buildPreventQuestionnaireFile(body.barcodeNo, { skipReleaseGate: true });
    if (!r.ok) return json({ ok: false, mode, error: r.error, detail: r.detail }, r.status);
    return json({
      ok: true, mode, partner,
      format_status: r.formatStatus,
      released: await isPreventCsvReleased(),
      pending_columns: PREVENT_CSV_PENDING_COLUMNS,
      barcode_no: r.barcodeNo,
      filename: r.filename,
      content_type: 'text/csv; charset=utf-8',
      csv_base64: Buffer.from(r.csv, 'utf8').toString('base64'),
      column_count: r.columnCount,
      filled_count: r.filledCount,
    });
  }

  const r = await buildPreventQuestionnaireFile(body.barcodeNo);
  if (!r.ok) return json({ ok: false, error: r.error, detail: r.detail }, r.status);
  return json({
    ok: true, mode, partner,
    format_status: r.formatStatus,
    barcode_no: r.barcodeNo,
    filename: r.filename,
    content_type: 'text/csv; charset=utf-8',
    /** 本体は base64。CSV は数 KB なので中継して問題にならない（PDF と違う）。 */
    csv_base64: Buffer.from(r.csv, 'utf8').toString('base64'),
    column_count: r.columnCount,
    filled_count: r.filledCount,
  });
};
