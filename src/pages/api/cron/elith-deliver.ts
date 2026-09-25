/**
 * 夜間の Elith 納品ラップ cron。
 *
 *   GET /api/cron/elith-deliver   (Bearer CRON_SECRET / 手動確認は ADMIN_API_KEY)
 *
 * 【なぜ 23:00 か】Elith 側が毎日深夜バッチで取り込むため、こちらは**毎日 23:00 (JST)** に
 * 「条件が揃ったもの」を納品ラップして S3 (本番 Elith 受け取り位置=バケット直下) へ書き出す
 * (発注者指示 2026-09-24)。スケジュールは `vercel.json` の `crons` (`0 14 * * *` = 14:00 UTC = 23:00 JST)。
 *
 * 【今できる範囲】権利=契約 (plan_composition) からの自動判定は**契約テーブルが実在 0 件**のため
 * まだ機械判定できない (`docs/subscription/kit_lifecycle_and_handoff_management_spec.md §4.3.1 D`)。
 * → 現時点で自動対象にできるのは、条件を機械判定できる**単品/スペシャルアカウント**
 * (問診済 ∧ スキャン済) のみ。処理本体は admin ボタンと同じ `deliverReadySpecialAccounts`。
 * **`skipDelivered:true`** で、既に納品済みの回は Elith へ再送しない (毎晩の重複取り込みを防ぐ)。
 * 契約テーブル埋め込み後に、この cron の対象をコースプランへ広げる。
 *
 * 【冪等】同一 (uid, bundle_date, delivery_prefix) は `elith_deliveries` で既納品と判定しスキップ。
 */
import type { APIRoute } from 'astro';
import { getS3Config } from '../../../lib/s3';
import { deliverReadySpecialAccounts } from '../../../lib/elith-delivery';
import { deliverReadyDiagnosisCycles } from '../../../lib/elith-deliver-cycles';

export const prerender = false;

/** 揃った人数によっては時間がかかるので余裕を持たせる (scan-worker と同方針)。 */
export const config = { maxDuration: 800 };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * **誰でも叩けてはいけない。** Vercel Cron は `Authorization: Bearer <CRON_SECRET>` で呼ぶ。
 * 手で叩いて確かめられるよう `ADMIN_API_KEY` も受け付ける。鍵が 1 つも無い本番は拒否 (fail-closed)。
 * (`scan-worker.ts` の authorized と同一。)
 */
function authorized(request: Request): boolean {
  const cron = import.meta.env.CRON_SECRET;
  const admin = import.meta.env.ADMIN_API_KEY;
  const m = /^Bearer\s+(.+)$/i.exec((request.headers.get('authorization') || '').trim());
  const token = m?.[1];
  if (!cron && !admin) return import.meta.env.DEV === true;
  return !!token && (token === cron || token === admin);
}

export const GET: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  const cfg = getS3Config();
  if (!cfg) return json({ ok: false, error: 's3_not_configured', detail: 'AWS_REGION 未設定' }, 400);

  // 納品先は本番 (バケット直下)。元ファイルは AWS_S3_PREFIX。
  const deliveryPrefix = '';
  const sourcePrefix = cfg.prefix ?? 'scan-accuracy-test/';

  const started = Date.now();
  try {
    // ① 単品/スペシャル経路 (従来どおり・**挙動を変えない**)。
    const summary = await deliverReadySpecialAccounts({ deliveryPrefix, sourcePrefix, skipDelivered: true });

    /*
     * ② 契約者経路 (Diagnosis Cycle 単位・P0-2)。**単品経路とは完全に分離**する。
     *   どの段でも「分からない」なら納品せず reason を返す (fail-closed)。
     *   bridge view / diagnosis_cycle が未適用の環境では候補 0 件になるだけで、
     *   ①の結果には影響しない。
     */
    let cycles: Awaited<ReturnType<typeof deliverReadyDiagnosisCycles>> | { error: string };
    try {
      cycles = await deliverReadyDiagnosisCycles({ deliveryPrefix, sourcePrefix, skipDelivered: true });
    } catch (e) {
      cycles = { error: String((e as { message?: string })?.message ?? e) };
    }

    return json({ ok: true, elapsed_ms: Date.now() - started, ...summary, diagnosis_cycles: cycles });
  } catch (e) {
    return json(
      { ok: false, error: 'deliver_failed', detail: String((e as { message?: string })?.message ?? e) },
      502,
    );
  }
};
