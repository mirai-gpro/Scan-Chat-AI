/**
 * AI 問診結果を Elith 連携仕様 (LifestyleQuestionnaireData) で S3 へ書き出すエンドポイント。
 *
 * 出力仕様: docs/elith/elith_s3_data_handoff_spec.md §7.3 / §3。
 *   パス   : {prefix}user/{client_id}/date/{YYYY_MM_DD}/
 *   ファイル: LifestyleQuestionnaireData_date_{YYYY_MM_DD}_user_{client_id}.json
 *   PII    : 氏名/生年月日は載せず subject:{sex, age} のみ (生年月日→年齢に変換)。
 *
 * 入力 (POST JSON):
 *   {
 *     diagnosticId?: string,        // 端末発番の UUID。無ければサーバで生成
 *     diagnosticUserId?: string|null,
 *     clientId?: string|null,       // 未指定なら diagnosticUserId → diagnosticId
 *     dateOfBirth?: string|null,    // 年齢算出にのみ使用 (保存しない)
 *     sex?: string|null,
 *     answers: Record<string, string|string[]|number>,
 *     completedAt?: number          // epoch ms (任意, 問診完了日=test_date に使用)
 *   }
 *
 * 出力:
 *   - S3 設定あり: { ok:true, configured:true, bucket, folder, uploaded:[...], json }
 *   - S3 未設定 : { ok:false, configured:false, folder, files:[...], json }  ← ドライラン
 */

import type { APIRoute } from 'astro';
import { buildElithInterviewBundle } from '../../../lib/interview-export';
import { recordInterviewCompletion } from '../../../lib/interview-completion';
import { resolveViewer } from '../../../lib/viewer';
import type { AnswerValue } from '../../../scripts/chat/interview-script';
import { getS3Config, isS3Configured, putFiles } from '../../../lib/s3';

export const prerender = false;

interface ExportBody {
  diagnosticId?: unknown;
  diagnosticUserId?: unknown;
  clientId?: unknown;
  dateOfBirth?: unknown;
  sex?: unknown;
  answers?: unknown;
  completedAt?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** answers を string | string[] | number のみに正規化 */
function sanitizeAnswers(raw: unknown): Record<string, AnswerValue> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, AnswerValue> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number') {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.filter((x): x is string => typeof x === 'string');
    }
  }
  return out;
}

export const POST: APIRoute = async (ctx) => {
  let body: ExportBody;
  try {
    body = (await ctx.request.json()) as ExportBody;
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const answers = sanitizeAnswers(body.answers);
  if (Object.keys(answers).length === 0) {
    return json({ ok: false, error: 'answers is required' }, 400);
  }

  const diagnosticId = str(body.diagnosticId) ?? crypto.randomUUID();
  const completedAt = typeof body.completedAt === 'number' ? body.completedAt : undefined;

  /*
   * **完了した事実だけをサーバに残す** (`docs/operations/スペシャルアカウント_仕様書.md` §14)。
   *
   * ここまでは S3 へ書くだけで DB に 1 行も残らず、完了記録は端末の localStorage のみだった
   * (`session-store.ts` の `InterviewResult`)。そのため**スマホで問診 → PC で開くと
   * 「未回答」に見え**、ダッシュボードの進捗を出す根拠が無かった (実測 2026-09-15)。
   *
   * - **保存先は Cookie から解決した本人の uid だけ。** `body.diagnosticUserId` は
   *   クライアント申告なので使わない (他人の完了を作れてしまう。`/api/scan/save` と同じ規律)
   * - **回答の中身は保存しない。** 設問数だけ (answers には `M-NAME` 等の医療情報が入る)
   * - **S3 の成否とは独立。** 本人が問診を終えた事実は書き出しが失敗しても変わらない
   * - **失敗しても投げない。** 記録の失敗で書き出しを 500 にしない
   */
  const viewer = await resolveViewer(ctx);
  await recordInterviewCompletion(viewer.selfUid, {
    completedAt,
    answeredCount: Object.keys(answers).length,
    diagnosticId,
  });

  const cfg = getS3Config();
  const prefix = cfg?.prefix ?? '';

  const bundle = buildElithInterviewBundle(
    {
      diagnosticId,
      diagnosticUserId: str(body.diagnosticUserId),
      clientId: str(body.clientId),
      dateOfBirth: str(body.dateOfBirth), // 年齢算出のみ (保存しない)
      sex: str(body.sex),
      answers,
      completedAt,
      exportedAt: new Date(),
    },
    prefix,
  );

  if (!isS3Configured() || !cfg) {
    return json({
      ok: false,
      configured: false,
      reason: 's3_not_configured',
      message: 'AWS_REGION 未設定のため S3 へは書き出していません。生成物のプレビューを返します。',
      diagnostic_id: diagnosticId,
      folder: bundle.folder,
      files: bundle.files.map((f) => ({ key: f.key, bytes: f.bytes, contentType: f.contentType })),
      json: bundle.json,
    });
  }

  try {
    const uploaded = await putFiles(bundle.files);
    return json({
      ok: true,
      configured: true,
      bucket: cfg.bucket,
      region: cfg.region,
      diagnostic_id: diagnosticId,
      folder: bundle.folder,
      uploaded,
      json: bundle.json,
    });
  } catch (err) {
    return json(
      { ok: false, configured: true, error: 'S3 upload failed', detail: String(err), folder: bundle.folder },
      502,
    );
  }
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
