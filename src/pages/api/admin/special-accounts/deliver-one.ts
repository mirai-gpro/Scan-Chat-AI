/**
 * **スペシャルアカウント 1 人ぶんの Elith 本番納品**（人がボタンを押したときだけ走る）。
 *
 *   POST /api/admin/special-accounts/deliver-one   (Bearer ADMIN_API_KEY)
 *     body: { diagnosticUserId, confirm?: boolean, deliveryPrefix?, sourcePrefix? }
 *
 * 正本: `docs/specs/special_account_management_spec_20261001.md` §9 / §7.3 / §7.3.1 / §10.2。
 *
 * ══════════════════════════════════════════════════════════════════════
 * **2 回叩く。1 回目は Elith 本番受取領域（`deliveryPrefix`）へ書かない。**
 * ══════════════════════════════════════════════════════════════════════
 *   `confirm` 無し … **delivery preview**（書く予定のファイル一覧 = `plan`）を返すだけ。
 *                     確認モーダルの件数は**これ**であって、一覧の DB 件数ではない（§7.3.1）。
 *   `confirm:true` … 同じ条件で plan を作り直し、**そのまま** `putVerified` で書く。
 *
 * **「何も書かない」ではない**（P0-1）。preview は確認用データを組み立てるために
 * 既存パイプラインを通すので、その副作用として
 *   - **中間 source**（`sourcePrefix` 配下の HealthCheckupData）… `elith-delivery.ts:231`
 *   - **ウェルネス年齢**（`diagnosis.health_age_scores`）… `elith-delivery.ts:288`
 * が更新される場合がある。**書かないのは本番受取領域だけ。**
 * 大規模な in-memory 化はしない（§7.3.1）。
 *
 * **なぜ DB 件数をそのまま出さないか**: 受診日が読めない回は保存されない /
 * `materializeHealthCheckups` は date フォルダで dedup する / ウェルネス年齢は
 * 算出不能な年を載せない。**「5件」と書いて 3 ファイルしか出ない**ことが起こる。
 *
 * ══════════════════════════════════════════════════════════════════════
 * **cron とは別の条件で動く**（§9.5 / §10.2）
 * ══════════════════════════════════════════════════════════════════════
 *   cron … 契約者・単品。plan ごとの `required_formats` の総当たり（fail-closed）
 *   ここ … スペシャル 1 人。条件は **uid 確定 ∧ 渡せるデータが 1 種類以上**の 2 つだけ。
 *          **AI問診が無くても納品できる。** `decideReady()` は通さない。
 *
 * 【渡された uid を信用しない】`isSpecialAccount(uid)` を**毎回**確かめる（§19.1）。
 * 画面で選択済みであることは認可の根拠にしない。
 */

import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { getS3Config } from '../../../../lib/s3';
import { buildDeliveryPlan, executeDeliveryPlan, planFingerprint } from '../../../../lib/elith-manual-delivery';
import { diffAgainst, loadLatestRun } from '../../../../lib/elith-delivery-runs';

export const prerender = false;
/** 複数年 × 複数 format を組んで読み戻すので、既定の 60s では足りない。 */
export const config = { maxDuration: 300 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** 画面へ返す plan。**`internal`（S3PutFile の実体）は返さない。** */
function publicPlan(plan: Awaited<ReturnType<typeof buildDeliveryPlan>>) {
  return {
    uid: plan.uid,
    /**
     * **この plan の指紋**（destination_key + 中身の sha256 を並べて取った 1 本）。
     *
     * 確認モーダルは「見せた内容」と「書く内容」が同じでなければ意味が無い（§7.3.1）。
     * HTTP は 2 往復になるので plan をサーバに持ち越せない。
     * かといって**クライアントから plan の中身を送り返させるのは論外**（中身を信用することになる）。
     * → **2 回目も同じ条件で組み直し、指紋が一致したときだけ書く。**
     *   一致しなければ 409 で新しい plan を返す（勝手に新しい方を書かない）。
     */
    fingerprint: planFingerprint(plan),
    ok: plan.ok,
    ...(plan.reason ? { reason: plan.reason } : {}),
    file_count: plan.files.length,
    count_by_format: plan.countByFormat,
    wellness_years: plan.wellnessYears,
    ...(plan.wellnessReason ? { wellness_reason: plan.wellnessReason } : {}),
    // 1 ファイルごとの明細。**中身は返さない**（sha256 は指紋であって中身ではない）。
    files: plan.files.map((f) => ({
      format_id: f.formatId,
      delivered_date: f.deliveredDate,
      destination_key: f.destinationKey,
      // 差分の判定に使うのはこちら（生成メタを除いた指紋・P0-2）。
      content_sha256: f.contentSha256,
      // 実際に書く body の指紋。**監査用**で、差分判定には使わない。
      delivery_sha256: f.deliverySha256,
    })),
    // 年（date フォルダ）ごとの内訳。**「5年分」が何を指すか**を画面で言えるように。
    dates: Array.from(new Set(plan.files.map((f) => f.deliveredDate))).sort(),
  };
}

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  const cfg = getS3Config();
  if (!cfg) return json({ ok: false, error: 's3_not_configured', detail: 'AWS_REGION 未設定' }, 400);

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const uid = str(body.diagnosticUserId);
  if (!uid) return json({ ok: false, error: 'uid_required' }, 400);

  // 納品先: 既定 '' = バケット直下 = **本番 Elith 受け取り位置**。
  const deliveryPrefix = typeof body.deliveryPrefix === 'string' ? body.deliveryPrefix : '';
  const sourcePrefix = str(body.sourcePrefix) ?? cfg.prefix ?? 'scan-accuracy-test/';

  let plan;
  try {
    plan = await buildDeliveryPlan({ uid, sourcePrefix, deliveryPrefix });
  } catch (e) {
    return json({ ok: false, error: 'plan_failed', detail: String((e as { message?: string })?.message ?? e) }, 502);
  }

  // ── 1 回目: 確認用の preview を返すだけ。**本番受取領域へは書かない。** ───
  if (body.confirm !== true) {
    /*
     * 前回の**手動**納品 run の控えと比べる（D-7・§14.3）。
     *
     * **3 つの状態を混同しない**（§6.5 F-5）:
     *   found       … 控えがある → 追加 / 更新を出せる
     *   none        … まだ手動納品していない → 「前回納品：なし」
     *   unavailable … 引けなかった（migration 未適用 等）→ **差分の副文言を出さない**
     *                 0 件と偽らない。
     */
    const prev = await loadLatestRun(plan.uid);
    const diff = prev.state === 'found' ? diffAgainst(prev.snapshot, plan.files) : null;
    return json({
      ok: plan.ok,
      mode: 'preview',
      delivery_prefix: deliveryPrefix,
      plan: publicPlan(plan),
      previous_run: {
        state: prev.state,
        delivered_at: prev.state === 'found' ? prev.deliveredAt : null,
        ...(prev.state === 'unavailable' ? { reason: prev.reason } : {}),
      },
      ...(diff ? {
        diff: {
          added: diff.added.length,
          updated: diff.updated.length,
          count_by_format: diff.countByFormat,
        },
      } : {}),
      note: 'この確認では Elith 本番受取領域には書き込みません。確認用データを組み立てるため、中間 source とウェルネス年齢の算出結果は更新される場合があります。',
    }, plan.ok ? 200 : 409);
  }

  // ── 2 回目: 確認した plan を**そのまま**書く。 ─────────────────────
  if (!plan.ok) return json({ ok: false, mode: 'deliver', error: 'not_deliverable', plan: publicPlan(plan) }, 409);

  /*
   * **確認したのと違う内容を書かない**（§7.3.1）。
   * 確認から確定までの間に追加検査が増える / 受診日が直る ことは普通に起こる。
   * そのとき**黙って新しい方を書くと、確認モーダルが確認になっていない**。
   * → 指紋が違えば書かずに 409 と新しい plan を返し、もう一度確認してもらう。
   */
  const confirmed = str(body.fingerprint);
  const current = planFingerprint(plan);
  if (!confirmed) return json({ ok: false, mode: 'deliver', error: 'fingerprint_required', plan: publicPlan(plan) }, 400);
  if (confirmed !== current) {
    return json({
      ok: false, mode: 'deliver', error: 'plan_changed',
      detail: '確認した内容から変わりました。もう一度確認してください。',
      plan: publicPlan(plan),
    }, 409);
  }

  try {
    // **生 email は受け取らない。** 中継側が digest にして送る（§14.3.1）。
    const exec = await executeDeliveryPlan(plan, { deliveryPrefix, triggeredBy: str(body.triggeredBy) });
    return json({
      ok: exec.ok,
      mode: 'deliver',
      delivery_prefix: deliveryPrefix,
      plan: publicPlan(plan),
      file_count: exec.fileCount,
      verified_count: exec.verifiedCount,
      recorded_dates: exec.recordedDates,
      skipped_dates: exec.skippedDates,
      // 控えを残せたか。**残せなくても納品は成立している**（黙って成功と言わない）。
      run_recorded: exec.runRecorded === true,
      ...(exec.runReason ? { run_reason: exec.runReason } : {}),
      // **黙って落とさない**（§9.6.2 c）。落ちたファイルは理由つきで返す。
      failed: exec.results.filter((r) => !r.verified).map((r) => ({
        destination_key: r.key, error: r.error ?? 'unknown', detail: r.detail ?? null,
      })),
    }, exec.ok ? 200 : 502);
  } catch (e) {
    return json({ ok: false, mode: 'deliver', error: 'deliver_failed', detail: String((e as { message?: string })?.message ?? e) }, 502);
  }
};
