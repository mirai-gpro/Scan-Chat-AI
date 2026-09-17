/**
 * **毎日 9:00 JST に Elith の下りを取り込む。**
 *
 * Elith 側は毎日 0:00 JST に `wellfort-ai-input` を見て、新規があれば自動でバッチを回す
 * (1 件 ≒ 20 分・発注者確認 2026-09-17)。こちらは朝に見に行って取り込む。
 *
 * 【Vercel Cron は UTC】9:00 JST = **0:00 UTC** なので `vercel.json` は `0 0 * * *`。
 *
 * 【「昨日ぶん」を取りに行かない】1 件 20 分なので、件数が増えた日は 0:00 起動でも
 * 9:00 を追い越す。日付で絞ると追い越したぶんが二度と拾われないので、
 * **「まだ取り込んでいないもの」**を対象にする (詳細は `elith-intake.ts` の冒頭)。
 * だから**走らない日があっても取り漏れにならない**。
 *
 * 本体は随時バッチ (`/api/admin/elith-intake`) と**同じ関数**。
 */
import type { APIRoute } from 'astro';
import { getServerSupabase } from '../../../lib/supabase';
import { runElithIntake } from '../../../lib/elith-intake';

export const prerender = false;
/** 件数ぶん回すので長めに取る。**`/api/scan` の 60s は触らない** (前景経路を巻き込まない)。 */
export const config = { maxDuration: 300 };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * **誰でも叩けてはいけない。** Vercel Cron は `Authorization: Bearer <CRON_SECRET>` を付ける
 * (vercel.com/docs/cron-jobs/manage-cron-jobs「Securing cron jobs」)。
 * 手で叩いて確かめられるよう `ADMIN_API_KEY` も受け付ける。
 * **鍵が 1 つも設定されていない本番は拒否する** (`scan-worker.ts` と同じ fail-closed)。
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
  try {
    const r = await runElithIntake(getServerSupabase() as never, {});
    if (!r.ok) console.error('[elith-intake] 実行できませんでした:', r.error);
    else if (r.counts.failed || r.counts.needs_review) {
      // **黙って落とさない。** 人が見る必要があるものはログに残す (件数だけ・PII は出さない)。
      console.error(`[elith-intake] 要確認 ${r.counts.needs_review} 件 / 失敗 ${r.counts.failed} 件`);
    }
    return json(r, r.ok ? 200 : 503);
  } catch (e) {
    console.error('[elith-intake] 例外:', e instanceof Error ? e.message : e);
    return json({ ok: false, error: 'intake_failed', detail: e instanceof Error ? e.message : String(e) }, 502);
  }
};
