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

import { jstTodayIso } from '../../../lib/elith-export';
import { finalizeGeneticDelivery, resolveGeneticFormat } from '../../../lib/elith-genetic-finalize';
import { refreshConfig, cfgBool } from '../../../lib/app-config';
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
/*
 * **納品 JSON の組み立てと key の規則は `elith-genetic-finalize.ts` が正本。**
 * ここに同じものを置くと、片方だけ直って静かにずれる (spec v3 §13.3)。
 */

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
  const { formatId, kind } = resolveGeneticFormat(str(body.formatId));
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
    /*
     * **today フォールバックは endpoint 境界に残す** (spec v3 §13.3)。
     * 通常運用の既存挙動を変えないためで、**共通 core は today を埋めない** —
     * トランスコスモス v3 は today 由来を捨てるので、あちらは必ず確定日を渡す。
     */
    const testDate = providedDate && /^\d{4}-\d{2}-\d{2}$/.test(providedDate) ? providedDate : jstTodayIso();

    // 組み立ては**共通 core 1 か所**。S3 書き込みだけがこの endpoint の仕事。
    const fin = finalizeGeneticDelivery({
      formatId, kind, clientId, testDate,
      dateSource: providedDate ? 'provided' : 'today',
      parts, prefix,
      sourceFile: str(body.sourceFile),
      sourcePages: str(body.sourcePages),
      // app_config を読むのは呼び出し側 (core は env / DB を見ない)。
      consolidateAiPrediction: cfgBool('scan.ai_prediction_dedup'),
    });
    const { json: jsonObj, jsonKey: json_key, jsonBody, consolidation } = fin;

    if (!isS3Configured() || !cfg) {
      return json({ ok: false, configured: false, reason: 's3_not_configured', json_key, item_count: fin.itemCount, format_id: formatId, consolidation, preview: jsonObj });
    }
    try {
      const uploaded = await putFiles([
        { key: json_key, contentType: 'application/json; charset=utf-8', body: jsonBody, bytes: fin.bytes },
      ]);
      return json({
        ok: true, action: 'finalize', configured: true, bucket: cfg.bucket,
        client_id: clientId, format_id: formatId, test_date: testDate,
        page_count: fin.pageCount, item_count: fin.itemCount, json_key,
        uri: uploaded[0]?.uri ?? null,
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
