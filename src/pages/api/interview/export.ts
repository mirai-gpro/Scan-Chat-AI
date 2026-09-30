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
import { denyReadOnlyWrite, denyUnlessShareScope } from '../../../lib/write-guard';
import { resolveTargetSubject } from '../../../lib/target-subject';
import { logShareEvent } from '../../../lib/share-access';
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
  /*
   * **代理表示中は書かせない**（2026-09-30・仕様書 §12.5 / §38-U27）。
   * この口は S3 の Elith 納品と `interview_completions` へ書く。
   * **body 冒頭で止める** — 読み取りも解析もしない。
   */
  const viewer = await resolveViewer(ctx);
  const denied = denyReadOnlyWrite(viewer);
  if (denied) return denied;

  /*
   * **共有は scope に `interview` があるときだけ**（§17.2）。
   * scope に無い更新は既定 BLOCK。share 以外では何もしない（挙動不変）。
   */
  const scoped = denyUnlessShareScope(viewer, 'interview');
  if (scoped) return scoped;

  /*
   * **書き込み先はここで確定する。以後クライアントの申告を一切見ない**（§19.4）。
   * self なら本人、share なら共有リンクの対象、代理表示は上で 403 済み。
   */
  const targetUid = viewer.writeTargetUid;

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

  /*
   * **クライアントが別の UID を名乗ってきたら記録する**（§26.1 `target_tamper_attempt`）。
   * **止めはしない**（申告は元々捨てているので実害が無く、止めると旧クライアントが壊れる）。
   * **記録するのは「食い違った」事実だけ** — 申告された UID をログに書かない（§26.2）。
   */
  const claimed = str(body.diagnosticUserId) ?? str(body.clientId);
  if (claimed && targetUid && claimed !== targetUid) {
    await logShareEvent({
      event: 'target_tamper_attempt', request: ctx.request, path: '/api/interview/export',
    });
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
   *
   * 【2026-09-30・§19.4】`viewer.selfUid` → **`viewer.writeTargetUid`**。
   * `selfUid` は**共有セッションでは null** なので、そのままだと共有相手が問診を
   * 終えても**完了が 1 行も残らない**（ダッシュボードの進捗も Elith の発火条件も動かない）。
   */
  await recordInterviewCompletion(targetUid, {
    completedAt,
    answeredCount: Object.keys(answers).length,
    diagnosticId,
  });

  const cfg = getS3Config();
  const prefix = cfg?.prefix ?? '';

  /*
   * **対象者の属性はサーバで取り直す**（§19.5）。
   * `body.dateOfBirth` / `body.sex` / `body.userName` は**受け取っても使わない** —
   * 年齢と性別は `LifestyleQuestionnaireData` に載り **Elith の AI 診断の入力**になるので、
   * クライアントが差し替えられると**対象者本人の正式な入力を汚染できる**。
   * 取れなければ null のまま（「不明」として出す・捏造ゼロ）。
   */
  const subject = await resolveTargetSubject(targetUid);

  const bundle = buildElithInterviewBundle(
    {
      diagnosticId,
      // ★ body の申告は捨てる。**S3 の client_id も target で決める**（§19.4）。
      diagnosticUserId: targetUid,
      clientId: targetUid,
      dateOfBirth: subject.dateOfBirth, // 年齢算出のみ (保存しない)
      sex: subject.sex,
      answers,
      completedAt,
      exportedAt: new Date(),
    },
    prefix,
  );

  if (viewer.kind === 'share') {
    await logShareEvent({ event: 'chat_use', request: ctx.request, path: '/api/interview/export' });
  }

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
