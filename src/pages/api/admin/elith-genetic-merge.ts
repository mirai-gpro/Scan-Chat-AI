/**
 * admin: 遺伝子検査 (GeneticTestResultData) の複数ページを 1 検査へ集約。
 *
 * 構造化は **Gemini(LLM) に全面委任** (elith-genetic.ts)。プログラムはパースしない。
 * CLAUDE.md「1 画像 = 1 リクエスト(60s)」を守り、クライアントがページ順に呼ぶ:
 *   - action=part     : 1 ページ画像を LLM 構造化 → items を返す (S3 書き込みなし)
 *   - action=finalize : 全 part の items を集約 → 1 つの GeneticTestResultData JSON を S3 保存
 * キー(GEMINI_API_KEY / AWS_*)はサーバ環境変数のみ (Vercel 一元管理)。
 *
 * 認可: wellfort-site から Bearer ADMIN_API_KEY。env 未設定(dev)のみ省略。
 */

import type { APIRoute } from 'astro';
import { scanGeneticPage, scanAiPredictionPage } from '../../../lib/elith-genetic';
import { consolidateAiPredictionItems, type ConsolidateAudit } from '../../../lib/ai-prediction-consolidate';
import { ELITH_HANDOFF_SCHEMA_VERSION, jstTodayIso } from '../../../lib/elith-export';
import { refreshConfig, cfgBool } from '../../../lib/app-config';
import { persistAdminBatchArtifact, TEST_TYPE_BY_FORMAT } from '../../../lib/scan-persist';
import { MODELS } from '../../../lib/gemini';
import { getS3Config, isS3Configured, putFiles } from '../../../lib/s3';
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
function folderOf(prefix: string, clientId: string, testDate: string, formatId: string): { folder: string; stem: string } {
  const dateFolder = testDate.replace(/-/g, '_');
  const cleanPrefix = prefix ? prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  return {
    folder: `${cleanPrefix}user/${clientId}/date/${dateFolder}/`,
    stem: `${formatId}_date_${dateFolder}_user_${clientId}`,
  };
}
/** このエンドポイントが扱う多ページ自由構造レポート。既定=遺伝子。Other=LAiF AI疾病発症予測。 */
function resolveFormat(v: unknown): { formatId: 'GeneticTestResultData' | 'Other'; kind: string } {
  return v === 'Other'
    ? { formatId: 'Other', kind: 'ai_prediction' }
    : { formatId: 'GeneticTestResultData', kind: 'genetic_scan_merged' };
}

interface Body {
  action?: unknown;
  formatId?: unknown;   // 'GeneticTestResultData'(既定) | 'Other'(LAiF AI疾病発症予測)
  image?: unknown;
  mimeType?: unknown;
  clientId?: unknown;
  page?: unknown;
  hint?: unknown;
  testDate?: unknown;
  parts?: unknown;
  sourceFile?: unknown;
  sourcePages?: unknown;
}

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) {
    return json({ ok: false, error: 'unauthorized', detail: 'Invalid API key' }, 401);
  }
  await refreshConfig(); // 運用パラメータ(app_config)を最新化してから処理
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const action = str(body.action) ?? 'part';
  const { formatId, kind } = resolveFormat(str(body.formatId));
  const clientId = str(body.clientId);
  if (!clientId) return json({ ok: false, error: 'clientId is required' }, 400);

  const cfg = getS3Config();
  const prefix = cfg?.prefix ?? '';

  // ── action = part: 1 ページを LLM 構造化 ──
  if (action === 'part') {
    const image = typeof body.image === 'string' ? body.image : '';
    if (!image.trim()) return json({ ok: false, error: 'image is required (data URL or base64)' }, 400);
    const page = typeof body.page === 'number' && body.page > 0 ? Math.floor(body.page) : 1;
    const parsedImg = parseImage(image);
    const mimeType = parsedImg.mime || str(body.mimeType) || 'image/jpeg';

    try {
      const scanPage = formatId === 'Other' ? scanAiPredictionPage : scanGeneticPage;
      const r = await scanPage({ imageBase64: parsedImg.data, mimeType, hint: str(body.hint) });
      return json({
        ok: true,
        action: 'part',
        page,
        section: r.section,
        items: r.items,
        item_count: r.items.length,
        parsed: r.parsed,
        finish_reason: r.finishReason,
        // 生出力を常に返す (読取段階の監査用=健診の raw_markdown と同等・admin でページ単位に確認/DL)。
        // LAiF/遺伝子は Markdown 中間を持たず LLM が直接 JSON 構造化するため、この per-page 生出力が
        // 「モデルがそのページで何をどう読んだか」を見る唯一の一次証跡。密テーブルの行ズレ切り分けに使う。
        raw: r.raw,
      });
    } catch (err) {
      return json({ ok: false, error: 'scan failed', detail: String(err instanceof Error ? err.message : err) }, 502);
    }
  }

  // ── action = finalize: 全 part の items を集約 → 1 JSON ──
  if (action === 'finalize') {
    const parts = Array.isArray(body.parts) ? (body.parts as Array<Record<string, unknown>>) : [];
    if (parts.length === 0) return json({ ok: false, error: 'parts is required for finalize' }, 400);

    const providedDate = str(body.testDate);
    const testDate = providedDate && /^\d{4}-\d{2}-\d{2}$/.test(providedDate) ? providedDate : jstTodayIso();

    const items: unknown[] = [];
    const pages: { page: number; section: string | null; count: number }[] = [];
    for (const p of parts) {
      const pageItems = Array.isArray(p.items) ? (p.items as unknown[]) : [];
      items.push(...pageItems);
      pages.push({
        page: typeof p.page === 'number' ? p.page : pages.length + 1,
        section: typeof p.section === 'string' ? p.section : null,
        count: pageItems.length,
      });
    }

    // LAiF(Other) のみ: 同一疾患の重複(発症予測/アドバイス/用語解説/ネスト)を疾患単位に統合 (§5.3)。
    //   app_config `scan.ai_prediction_dedup=on` のときだけ発火・既定 off=挙動不変(🎯後に on 化)。
    //   疾患名は印字どおり維持(完全一致統合のみ)・捏造ゼロ・漏れゼロ。監査は応答で返し納品 data には含めない。
    let deliverItems: unknown[] = items;
    let consolidation: ConsolidateAudit | null = null;
    if (formatId === 'Other' && cfgBool('scan.ai_prediction_dedup')) {
      const c = consolidateAiPredictionItems(items);
      deliverItems = c.items;
      consolidation = c.audit;
    }

    const { folder, stem } = folderOf(prefix, clientId, testDate, formatId);
    const json_key = `${folder}${stem}.json`;
    const jsonObj = {
      format_id: formatId,
      schema_version: ELITH_HANDOFF_SCHEMA_VERSION,
      kind,
      client_id: clientId,
      diagnostic_id: randomUuid(),
      source_file: str(body.sourceFile),
      source_pages: str(body.sourcePages),
      page_count: parts.length,
      test_date: testDate,
      date_source: providedDate ? 'provided' : 'today',
      exported_at: new Date().toISOString(),
      subject: { sex: null, age: null },
      source: {
        origin: 'scan-chat-ai',
        app: 'scan-chat-ai',
        model: MODELS.scan,
        note: formatId === 'Other'
          ? 'admin バッチ (LAiF AI疾病発症予測・AIスキャン・構造化はLLM全面委任)。項目構造はLLM判定。'
          : 'admin バッチ (遺伝子・AIスキャン・構造化はLLM全面委任)。項目構造はLLM判定。',
        lab_name: formatId === 'Other' ? 'LAiF' : null,
      },
      data: { item_count: deliverItems.length, items: deliverItems, pages },
    };
    const jsonBody = JSON.stringify(jsonObj, null, 2);

    if (!isS3Configured() || !cfg) {
      return json({ ok: false, configured: false, reason: 's3_not_configured', json_key, item_count: deliverItems.length, format_id: formatId, consolidation, preview: jsonObj });
    }
    try {
      const uploaded = await putFiles([
        { key: json_key, contentType: 'application/json; charset=utf-8', body: jsonBody, bytes: utf8Bytes(jsonBody) },
      ]);
      /*
       * 本人ダッシュボード表示用に Supabase (`test_artifacts`) へも保存 (2026-09-28 追加)。
       *
       * **この経路は これまで S3 にしか書いていなかった**ので、admin バッチで読んだ
       * 遺伝子 / AI疾病発症予測 は Elith には渡るのに本人の画面では 0 件だった。
       *
       * **測定値は無い** (この形式は `data.items[]` で `measurements` を持たない) ので
       * `measurements: []` で呼び、artifact 行だけを作る。`scan_md` にはページ単位の
       * 生出力を連結して入れる = 「データ」で中身が読める。**rows=0 は失敗ではない。**
       */
      let dashboard: { artifactId: string | null; rows: number; reason?: string } | null = null;
      const testType = TEST_TYPE_BY_FORMAT[formatId];
      if (testType) {
        try {
          const md = parts
            .map((p, i) => `<!-- ===== page ${i + 1}/${parts.length} ===== -->\n${str(p.raw) || '(なし)'}`)
            .join('\n\n');
          dashboard = await persistAdminBatchArtifact({
            diagnosticUserId: clientId,
            testType,
            markdownClean: md,
            measurements: [],
            testDate,
            pageCount: parts.length,
          });
        } catch (e) {
          dashboard = { artifactId: null, rows: 0, reason: String(e instanceof Error ? e.message : e) };
        }
      }
      return json({
        ok: true, action: 'finalize', configured: true, bucket: cfg.bucket,
        client_id: clientId, format_id: formatId, test_date: testDate,
        page_count: parts.length, item_count: deliverItems.length, json_key,
        uri: uploaded[0]?.uri ?? null,
        dashboard, // 本人ダッシュボード保存結果 (artifactId/rows)。rows=0 は正常 (測定値を持たない形式)
        date_source: providedDate ? 'provided' : 'today', // 'today' = 受診日を指定せず実行日になった
        consolidation, // LAiF 統合監査 (件数/統合/競合)。null=未実施 (env off or 非Other)。納品 data には含めない。
        preview: jsonObj, // 🎯 照合用: 納品JSON(data.items)を返す(S3未設定分岐と同様)。
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
