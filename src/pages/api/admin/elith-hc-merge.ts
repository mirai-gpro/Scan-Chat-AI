/**
 * admin: 検診・人間ドック (HealthCheckupData) の複数画像を 1 検査へマージ。
 *
 * 1 回の複数選択 = 1 人分の 1 検査。複数シート(画像)を 1 つの JSON にマージし、
 * 元画像は全て連番で書き出す (docs/elith/elith_batch_centralization_design.md / CLAUDE.md)。
 * CLAUDE.md 原則「1 画像 = 1 リクエスト(60s制約)」を守り、クライアントが順に呼ぶ:
 *   - action=part     : 1 画像をスキャン → 元画像を連番で S3 保存 → 解析結果を返す(JSONは書かない)
 *   - action=finalize : 全 part の測定値をマージ → 1 つの HealthCheckupData JSON を S3 保存
 * キー(GEMINI_API_KEY / AWS_*)はサーバ環境変数のみ (Vercel 一元管理)。
 *
 * 認可: wellfort-site から Bearer ADMIN_API_KEY。env 未設定(dev)のみ省略。
 */

import type { APIRoute } from 'astro';
import {
  scanImageToParsed,
  extFromMime,
  type ParsedScan,
} from '../../../lib/elith-export';
// **finalize の中身はここに書かない。** 臨時診断バッチと同じ core を呼ぶ (spec §6.5)。
// 計算は core・書き込みはこの API、という分け方にしてある。
import { finalizeHealthCheckup, healthCheckupFolder } from '../../../lib/elith-hc-finalize';
import { MODELS } from '../../../lib/gemini';
import { refreshConfig } from '../../../lib/app-config';
import { getS3Config, isS3Configured, putFiles, type S3PutFile } from '../../../lib/s3';
import { isAdminAuthorized } from '../../../lib/api-auth';

export const prerender = false;

function authorized(request: Request): boolean {
  // 認可の実装は src/lib/api-auth.ts に集約 (キー未設定の本番は拒否＝fail-closed)。
  return isAdminAuthorized(request);
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function parseImage(input: string): { mime: string; data: string } {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(input.trim());
  if (m) return { mime: m[1], data: m[2] };
  return { mime: '', data: input.trim() };
}
function utf8Bytes(s: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : Buffer.byteLength(s, 'utf-8');
}
// 納品 key の組み立ては core と共有する (2 か所で別々に組むと納品先が静かにずれる)。
const folderOf = healthCheckupFolder;

interface Body {
  action?: unknown;
  image?: unknown;
  mimeType?: unknown;
  clientId?: unknown;
  seq?: unknown;
  examDate?: unknown;
  hint?: unknown;
  testDate?: unknown;
  parts?: unknown;
  sourceFiles?: unknown;
}

export const POST: APIRoute = async ({ request }) => {
  await refreshConfig(); // 運用パラメータ(app_config)を最新化してから処理
  if (!authorized(request)) {
    return json({ ok: false, error: 'unauthorized', detail: 'Invalid API key' }, 401);
  }
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const action = str(body.action) ?? 'part';
  const clientId = str(body.clientId);
  if (!clientId) return json({ ok: false, error: 'clientId is required' }, 400);

  const cfg = getS3Config();
  const prefix = cfg?.prefix ?? '';

  // ── action = part: 1 画像スキャン + 連番画像を書き出し ──
  if (action === 'part') {
    const image = typeof body.image === 'string' ? body.image : '';
    if (!image.trim()) return json({ ok: false, error: 'image is required (data URL or base64)' }, 400);
    const seq = typeof body.seq === 'number' && body.seq > 0 ? Math.floor(body.seq) : 1;
    const parsedImg = parseImage(image);
    const mimeType = parsedImg.mime || str(body.mimeType) || 'image/jpeg';

    let scan: ParsedScan;
    try {
      scan = await scanImageToParsed({ imageBase64: parsedImg.data, mimeType, examDate: str(body.examDate), hint: str(body.hint) });
    } catch (err) {
      return json({ ok: false, error: 'scan failed', detail: String(err instanceof Error ? err.message : err) }, 502);
    }

    const { folder, stem } = folderOf(prefix, clientId, scan.testDate);
    const imageKey = `${folder}${stem}_${String(seq).padStart(2, '0')}${extFromMime(mimeType)}`;

    let uploadedKey: string | null = null;
    if (isS3Configured() && cfg) {
      const imageBytes = Uint8Array.from(Buffer.from(parsedImg.data, 'base64'));
      const files: S3PutFile[] = [{ key: imageKey, contentType: mimeType, body: imageBytes, bytes: imageBytes.length }];
      try {
        await putFiles(files);
        uploadedKey = imageKey;
      } catch (err) {
        return json({ ok: false, configured: true, error: 'S3 upload failed', detail: String(err) }, 502);
      }
    }

    return json({
      ok: true,
      action: 'part',
      configured: isS3Configured(),
      seq,
      test_date: scan.testDate,
      date_source: scan.dateSource,
      image_key: uploadedKey ?? imageKey,
      rows: scan.measurements.length,
      // finalize でマージするため part の解析結果を返す
      measurements: scan.measurements,
      regions: scan.regions,
      notes: scan.notes,
      raw_markdown: scan.markdown,
      finish_reason: scan.finishReason,
      vqa_audit: scan.vqaAudit, // VQA 再読の監査 (可視化用・Elith 納品 data には含めない)
      scan_model: MODELS.scan, // 実際に使用したスキャンモデル (lite/3.5 判別用)
    });
  }

  // ── action = finalize: 全 part をマージして 1 JSON を書き出し ──
  if (action === 'finalize') {
    const testDate = str(body.testDate);
    if (!testDate || !/^\d{4}-\d{2}-\d{2}$/.test(testDate)) {
      return json({ ok: false, error: 'testDate (YYYY-MM-DD) is required for finalize' }, 400);
    }
    const parts = Array.isArray(body.parts) ? (body.parts as Array<Record<string, unknown>>) : [];
    if (parts.length === 0) return json({ ok: false, error: 'parts is required for finalize' }, 400);

    const sourceFiles = Array.isArray(body.sourceFiles)
      ? (body.sourceFiles as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];

    /*
     * **整形・マージは共通 core が行う** (`src/lib/elith-hc-finalize.ts`)。
     *
     * 臨時診断バッチ (spec §6.5) が同じ core を呼ぶので、
     * **ここに整形規則を足すと向こうにも効き、足さないと向こうだけ別物になる**。
     * この API の役目は「受け取る・core を呼ぶ・S3 へ書く」だけ。
     * 応答の形は従来のまま (呼び出し側の admin UI を変えない)。
     */
    const fin = finalizeHealthCheckup({
      clientId,
      testDate,
      prefix,
      sourceFiles,
      parts: parts.map((p) => ({
        measurements: p.measurements,
        notes: p.notes,
        rawMarkdown: typeof p.raw_markdown === 'string' ? p.raw_markdown : null,
      })),
    });
    const json_key = fin.jsonKey;
    const measurements = fin.measurements;
    const jsonBody = JSON.stringify(fin.json, null, 2);
    const necessity = fin.necessity;
    const canonAudit = fin.canon;
    const dedupAuditOut = fin.dedup;
    const trendDropped = fin.trendDropped;
    const scramble = fin.scramble;
    const reassign = fin.reassigned;
    const eyeResolved = fin.eyeResolved;
    const lipidFix = fin.lipidFix;

    if (!isS3Configured() || !cfg) {
      return json({ ok: false, configured: false, reason: 's3_not_configured', json_key, rows: measurements.length, measurements, necessity, canon: canonAudit, dedup: dedupAuditOut, trend_dropped: trendDropped, scramble, reassigned: reassign, eye_resolved: eyeResolved, lipid_fix: lipidFix, scan_model: MODELS.scan, preview: fin.json });
    }
    try {
      const uploaded = await putFiles([{ key: json_key, contentType: 'application/json; charset=utf-8', body: jsonBody, bytes: utf8Bytes(jsonBody) }]);
      return json({
        ok: true, action: 'finalize', configured: true, bucket: cfg.bucket,
        client_id: clientId, format_id: 'HealthCheckupData', test_date: testDate,
        part_count: parts.length, rows: measurements.length, measurements, json_key, necessity, canon: canonAudit, dedup: dedupAuditOut, trend_dropped: trendDropped, scramble, reassigned: reassign, eye_resolved: eyeResolved, lipid_fix: lipidFix,
        scan_model: MODELS.scan, // 実際に使用したスキャンモデル (lite/3.5 判別用)
        uri: uploaded[0]?.uri ?? null,
      });
    } catch (err) {
      return json({ ok: false, configured: true, error: 'S3 upload failed', detail: String(err) }, 502);
    }
  }

  return json({ ok: false, error: `unknown action: ${action}` }, 400);
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
