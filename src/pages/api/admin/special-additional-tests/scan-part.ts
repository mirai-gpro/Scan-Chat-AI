/**
 * **STEP 1 ［① 解析・確認］— 1 ページ = 1 リクエスト。**
 * 正本: `docs/specs/special_account_additional_tests_spec_20260930.md` §9 / §10 / §11 〜 §14。
 *
 *   POST (json) { diagnosticUserId, testType, image, mimeType?, page?, hint? }
 *     → 200 { ok:true, page, ... 解析結果 }
 *
 * ══════════════════════════════════════════════════════════════════════
 * **この口は何も保存しない**（§9）
 * ══════════════════════════════════════════════════════════════════════
 * `test_artifacts` も `measurement_values` も書かない・Elith へも書かない・
 * **原本 S3 へも置かない**。狙いは、解析に失敗した PDF を
 * **Object Lock 付きの原本バケット（10 年保管・削除不可）へ大量に残さない**こと。
 * 保存は管理者が中身を確認したあと `finalize` が行う。
 *
 * ══════════════════════════════════════════════════════════════════════
 * **新しい解析を作らない**（§11 / §12 / §13 / §14 / §47）
 * ══════════════════════════════════════════════════════════════════════
 *   血液・がんリスク … `scanImageToParsed()`（`elith-export.ts`。`elith-hc-merge` と同じもの）
 *   遺伝子           … `scanGeneticPage()`（`elith-genetic.ts`）
 *   AI疾病発症予測   … `scanAiPredictionPage()`（同上・LAiF 様式特化プロンプト）
 * **血液専用 OCR も、遺伝子の固定スキーマ化も作らない。**
 *
 * 認可 = Bearer `ADMIN_API_KEY`（UI は wellfort-site・サーバ間通信・§38）。
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { refreshConfig } from '../../../../lib/app-config';
import { scanImageToParsed } from '../../../../lib/elith-export';
import { scanGeneticPage, scanAiPredictionPage } from '../../../../lib/elith-genetic';
import { MODELS } from '../../../../lib/gemini';
import { isAdditionalTestType } from '../../../../lib/additional-originals';
import { checkAdditionalTarget, isItemsFormat } from '../../../../lib/special-additional-tests';

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** `data:` URL でも生 base64 でも受ける（既存 admin バッチ 3 本と同じ）。 */
function parseImage(input: string): { mime: string; data: string } {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(input.trim());
  if (m) return { mime: m[1], data: m[2] };
  return { mime: '', data: input.trim() };
}

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  await refreshConfig(); // 使用モデル等の運用パラメータ (app_config) を最新化してから解析

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  // **対象はスペシャルアカウントだけ**（§6）。admin かどうかは資格にならない。
  const target = checkAdditionalTarget(str(body.diagnosticUserId));
  if (!target.ok) return json({ ok: false, error: target.error, detail: target.detail }, 403);

  const testType = str(body.testType);
  if (!isAdditionalTestType(testType)) {
    return json({ ok: false, error: 'invalid_test_type', detail: 'blood / cancer_urine / genetics / ai_prediction のいずれか' }, 400);
  }

  const image = typeof body.image === 'string' ? body.image : '';
  if (!image.trim()) return json({ ok: false, error: 'image_required', detail: 'data URL か base64 が要ります' }, 400);
  const page = typeof body.page === 'number' && body.page > 0 ? Math.floor(body.page) : 1;

  const img = parseImage(image);
  const mimeType = img.mime || str(body.mimeType) || 'image/jpeg';
  const hint = str(body.hint);

  try {
    if (isItemsFormat(testType)) {
      // 遺伝子 / AI疾病発症予測 = `data.items[]` 型（構造化は LLM 全面委任）。
      const scan = testType === 'ai_prediction' ? scanAiPredictionPage : scanGeneticPage;
      const r = await scan({ imageBase64: img.data, mimeType, hint });
      return json({
        ok: true, page, test_type: testType, kind: 'items',
        section: r.section, items: r.items, item_count: r.items.length,
        parsed: r.parsed, finish_reason: r.finishReason,
        // ページ単位の生出力 = 「モデルがそのページで何をどう読んだか」の一次証跡。
        raw: r.raw,
        scan_model: MODELS.scan,
      });
    }

    // 血液 / がんリスク = measurement 型。**受診日はここで確定させない**
    // （§8。画面の必須入力を finalize が使う）。返すのは「画像から読めた日付」の参考値だけ。
    const s = await scanImageToParsed({ imageBase64: img.data, mimeType, hint });
    return json({
      ok: true, page, test_type: testType, kind: 'measurements',
      rows: s.measurements.length,
      measurements: s.measurements,
      notes: s.notes,
      raw_markdown: s.markdown,
      finish_reason: s.finishReason,
      // 参考値 (画面の初期値に使ってよい)。**採否は管理者が決める。**
      detected_test_date: s.testDate,
      detected_date_source: s.dateSource,
      vqa_audit: s.vqaAudit, // VQA 再読の監査 (可視化用・Elith 納品 data には含めない)
      scan_model: MODELS.scan,
    });
  } catch (err) {
    // **PDF の base64 も parsed 全文もログへ出さない**（§39）。返すのは例外メッセージだけ。
    return json({ ok: false, error: 'scan_failed', detail: String(err instanceof Error ? err.message : err) }, 502);
  }
};
