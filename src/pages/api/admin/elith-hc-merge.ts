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
  ELITH_HANDOFF_SCHEMA_VERSION,
  sanitizeMeasurementsForDelivery,
  canonicalizeEnabled,
  obsDedupEnabled,
  scrambleFixEnabled,
  scanEyeResolveEnabled,
  scanLipidFixEnabled,
  type ParsedScan,
} from '../../../lib/elith-export';
import { canonicalize } from '../../../lib/canonicalize';
import { dedupObservations, dedupAudit, semanticKey } from '../../../lib/observation-dedup';
import { detectScramble, reassignScramble } from '../../../lib/scramble-detect';
import { resolveEyeCollapsed } from '../../../lib/collapsed-row';
import { fixLipidSwap } from '../../../lib/lipid-fix';
import { masterItemNames } from '../../../lib/standard-master';
import { MODELS } from '../../../lib/gemini';
import { refreshConfig } from '../../../lib/app-config';
import { getS3Config, isS3Configured, putFiles, type S3PutFile } from '../../../lib/s3';
import { checkNecessity } from '../../../lib/elith-necessity-check';
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
function randomUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}
function utf8Bytes(s: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : Buffer.byteLength(s, 'utf-8');
}
function folderOf(prefix: string, clientId: string, testDate: string): { folder: string; dateFolder: string; stem: string } {
  const dateFolder = testDate.replace(/-/g, '_');
  const cleanPrefix = prefix ? prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  const folder = `${cleanPrefix}user/${clientId}/date/${dateFolder}/`;
  return { folder, dateFolder, stem: `HealthCheckupData_date_${dateFolder}_user_${clientId}` };
}

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

    const rawMeasurements: unknown[] = [];
    const notes: string[] = [];
    const markdowns: string[] = [];
    // 推移グラフページ(⑧-2「検査結果の推移」)由来の行は非納品(前回/トレンド点=詳細表の重複 or 過去値)。
    // 同一概念が詳細ページにも在れば trend 行を落とす(汚染除去=選択でない・ChatGPT案A)。trend にしか無い
    // 概念は残す(漏れ防止=捏造ゼロ/漏れゼロ両立)。part の raw_markdown ヘッダで trend ページを識別する。
    // 推移ページが無い/検出できない検体では発火せず挙動不変(fail-safe)。
    const nameOf = (m: unknown): string | null => {
      const nm = m && typeof m === 'object' ? (m as Record<string, unknown>).name : null;
      return typeof nm === 'string' && nm.trim() ? nm : null;
    };
    const trendMeas: unknown[] = [];
    const detailKeys = new Set<string>();
    for (const p of parts) {
      const md = typeof p.raw_markdown === 'string' ? p.raw_markdown : '';
      const isTrend = /検査結果の推移/.test(md);
      if (Array.isArray(p.measurements)) {
        if (isTrend) {
          trendMeas.push(...p.measurements);
        } else {
          for (const m of p.measurements) {
            rawMeasurements.push(m);
            const nm = nameOf(m);
            if (nm) detailKeys.add(semanticKey(nm));
          }
        }
      }
      if (Array.isArray(p.notes)) notes.push(...(p.notes as string[]));
      if (typeof p.raw_markdown === 'string' && p.raw_markdown.trim()) markdowns.push(p.raw_markdown);
    }
    // trend 行: 詳細に同概念が在れば除外(重複/前回列混入の汚染除去)、無ければ残す(漏れ防止)。
    let trendDropped = 0;
    for (const m of trendMeas) {
      const nm = nameOf(m);
      if (nm && detailKeys.has(semanticKey(nm))) { trendDropped++; continue; }
      rawMeasurements.push(m);
    }
    // 書き出し時点で lean 正規化 (↑↓→flag/value_num・空行/総合判定欄 除外・妥当性ガード)。
    // 監査は raw_markdown + 元画像(S3) に保持。全マージ分をまとめて 1 回で正規化する。
    const kept = sanitizeMeasurementsForDelivery(rawMeasurements).kept;
    // ②正準化 (S1〜S3)。SCAN_CANONICALIZE=on のときだけ。監査(canon)は納品 data に含めず応答へ返す。
    const canon = canonicalizeEnabled() ? canonicalize(kept) : null;
    const canonMeasurements = canon ? canon.delivery : kept;
    // 後段 dedup (課題C 別名重複/課題B 同名別値の競合・SCAN_OBS_DEDUP=on のときだけ)。マージ由来の
    // ページ跨ぎ重複 (体重×2・眼底×2 等) はこのマージ finalize でしか消せない (単画像経路の dedup では届かない)。
    const dedup = obsDedupEnabled() ? dedupObservations(canonMeasurements) : null;
    let measurements = dedup ? dedup.delivery : canonMeasurements;
    const canonAudit = canon
      ? { mapped: canon.mapped, unmapped: canon.unmapped, deficient: canon.deficient }
      : null;
    const dedupAuditOut = dedup ? dedupAudit(dedup) : null;
    // Phase 2-1: 基準レンジ scramble 検知（監査のみ）。**再割当前**の生の scramble を捉える
    // (再割当後に検知すると、修正で空いたスロットを次の行が埋める偽陽性=ALT→γ-GTP 等が出るため)。
    const preScramble = detectScramble(measurements);
    // Phase 2-2: 基準レンジ再割当（scramble 修正・SCAN_SCRAMBLE_FIX=on のときだけ・単一run決定論）。
    // 出力値は実読値の付け替えのみ＝捏造ゼロ。肝酵素等の値-ラベル回転を欠落スロットへ戻す。
    const reassign = scrambleFixEnabled() ? reassignScramble(measurements) : null;
    if (reassign) measurements = reassign.delivery as Record<string, unknown>[];
    // Phase 2-2: 眼科 collapsed-row 付け替え（右眼/左眼→裸眼視力/眼圧/眼底・SCAN_EYE_RESOLVE=on のときだけ）。
    const eye = scanEyeResolveEnabled() ? resolveEyeCollapsed(measurements) : null;
    if (eye) measurements = eye.delivery as Record<string, unknown>[];
    // Phase 2-2: 脂質 LDL↔TG 入替の物理制約修正（LDL+HDL≤TC・SCAN_LIPID_FIX=on のときだけ）。
    const lipid = scanLipidFixEnabled() ? fixLipidSwap(measurements) : null;
    if (lipid && lipid.swapped) measurements = lipid.delivery as Record<string, unknown>[];
    // ⚠ 残差 = 検知した scramble から「自動修正済(reassigned.from)」を除いた未修正分のみ表示。
    const fixedFrom = new Set((reassign?.reassigned ?? []).map((r) => r.from));
    const scramble = { checked: preScramble.checked, suspects: preScramble.suspects.filter((s) => !fixedFrom.has(s.name)) };
    const sourceFiles = Array.isArray(body.sourceFiles) ? (body.sourceFiles as unknown[]).filter((x): x is string => typeof x === 'string') : [];

    const { folder, stem } = folderOf(prefix, clientId, testDate);
    const json_key = `${folder}${stem}.json`;
    const jsonObj = {
      format_id: 'HealthCheckupData',
      schema_version: ELITH_HANDOFF_SCHEMA_VERSION,
      kind: 'scan_merged',
      client_id: clientId,
      diagnostic_id: randomUuid(),
      source_images: sourceFiles,
      part_count: parts.length,
      test_date: testDate,
      date_source: 'merged',
      exported_at: new Date().toISOString(),
      subject: { sex: null, age: null },
      source: {
        origin: 'scan-chat-ai',
        app: 'scan-chat-ai',
        model: MODELS.scan,
        note: 'admin バッチ (AIスキャン・複数画像を1検査へマージ)。書式は暫定。',
        lab_name: null,
      },
      // 納品 data は共通 measurements[] + notes のみ (版面座標 regions/bbox は含めない・§7.1)。
      data: { measurements, notes },
      raw_markdown: markdowns.join('\n\n---\n\n'),
    };
    const jsonBody = JSON.stringify(jsonObj, null, 2);
    // 不要項目チェック(必要要素検証)。canonicalize on のとき starter 標準マスタで
    // surplus/カバレッジも判定(hc-merge はブロックしないため情報提示のみ)。
    const necessity = checkNecessity(jsonObj, {
      requiredItemsMaster: canonicalizeEnabled() ? masterItemNames() : null,
    });

    if (!isS3Configured() || !cfg) {
      return json({ ok: false, configured: false, reason: 's3_not_configured', json_key, rows: measurements.length, measurements, necessity, canon: canonAudit, dedup: dedupAuditOut, trend_dropped: trendDropped, scramble, reassigned: reassign?.reassigned ?? null, eye_resolved: eye?.resolved ?? null, lipid_fix: lipid && lipid.swapped ? lipid.detail : null, scan_model: MODELS.scan, preview: jsonObj });
    }
    try {
      const uploaded = await putFiles([{ key: json_key, contentType: 'application/json; charset=utf-8', body: jsonBody, bytes: utf8Bytes(jsonBody) }]);
      return json({
        ok: true, action: 'finalize', configured: true, bucket: cfg.bucket,
        client_id: clientId, format_id: 'HealthCheckupData', test_date: testDate,
        part_count: parts.length, rows: measurements.length, measurements, json_key, necessity, canon: canonAudit, dedup: dedupAuditOut, trend_dropped: trendDropped, scramble, reassigned: reassign?.reassigned ?? null, eye_resolved: eye?.resolved ?? null, lipid_fix: lipid && lipid.swapped ? lipid.detail : null,
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
