/**
 * GET /api/cron/scan-worker — **溜まったスキャンを後ろで読む。**
 *
 * 正本: `docs/scan/スキャン非同期処理_仕様書.md` §4.3〜§4.4。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【これが在る理由】送信を押した人を**一切待たせない**。
 * ══════════════════════════════════════════════════════════════════════
 * 読み取りは 1 枚 30〜50 秒。前景でやると 6 枚で 3〜5 分待たせ、
 * しかも**タブを閉じると全ページ失われて最初から**だった。
 *
 * 【1 起動で回せるだけ回す】関数の持ち時間から安全余白を引いた deadline まで、
 * 1 枚ずつ進める。**時間切れになっても `done_count` まで進んでいるので、
 * 次の起動が続きから拾う**（デメカルの `last_to` 単調前進と同じ考え方）。
 *
 * 【失敗はユーザーに出さない】発注者判断 2026-09-10「問題があればこちら側の対応」。
 * → **`scan_jobs` に残らないと誰も気づけない**ので、握りつぶさず必ず記録する (§4.5)。
 */
import type { APIRoute } from 'astro';
import { getServerSupabase } from '../../../lib/supabase';
import { fetchScanUpload } from '../../../lib/scan-upload-ticket';
import { readScanPage } from '../../../lib/scan-read-page';
import { stripColumnFromTables, joinPageMarkdown } from '../../../lib/scan-markdown';
import { saveScanResult } from '../../../lib/scan-persist';
import { isSpecialAccount } from '../../../lib/special-accounts';
import { refreshConfig } from '../../../lib/app-config';
import { putScanExport } from '../../../lib/scan-export-put';
import { deleteObjects } from '../../../lib/s3';
import {
  claimNextJob, advanceJob, extendLock, finishJob, failJob, MAX_ATTEMPTS,
  type ScanJob,
} from '../../../lib/scan-jobs';

export const prerender = false;

/**
 * 1 起動の持ち時間。Vercel Pro は最大 800s まで伸ばせるが、
 * **`/api/scan` 側の 60s は触らない**（前景経路を巻き込まない）。
 */
export const config = { maxDuration: 800 };

/** 安全余白。ここを割ったら次の 1 枚に入らず、次の起動へ譲る。 */
const SAFETY_MS = 90_000;
/** 1 枚ぶんの見積り（実測 30〜50 秒の上側）。 */
const PER_PAGE_MS = 60_000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * **誰でも叩けてはいけない。** Vercel Cron は `Authorization: Bearer <CRON_SECRET>`
 * を付けて呼ぶ (vercel.com/docs/cron-jobs/manage-cron-jobs「Securing cron jobs」)。
 * 手で叩いて確かめられるよう `ADMIN_API_KEY` も受け付ける。
 *
 * **鍵が 1 つも設定されていない本番は拒否する** (`api-auth.ts` と同じ fail-closed)。
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

  const started = Date.now();
  const deadline = started + (config.maxDuration * 1000 - SAFETY_MS);
  const processed: { job: string; pages: number; failed: number; status: string }[] = [];

  // 1 起動で**複数のジョブ**も拾う (1 人 1 枚のジョブが溜まっていることがある)。
  while (Date.now() < deadline - PER_PAGE_MS) {
    const job = await claimNextJob();
    if (!job) break;
    const r = await runJob(job, deadline);
    processed.push({ job: job.id, pages: r.done, failed: r.failed, status: r.status });
    if (r.status === 'paused') break; // 時間切れ。次の起動が続きから拾う
  }

  return json({ ok: true, elapsed_ms: Date.now() - started, jobs: processed });
};

async function runJob(
  job: ScanJob,
  deadline: number,
): Promise<{ status: 'done' | 'failed' | 'paused'; done: number; failed: number }> {
  const sb = getServerSupabase();
  if (!sb) {
    await failJob(job.id, job.attempts, 'supabase_not_configured');
    return { status: 'failed', done: job.done_count, failed: job.failed_pages };
  }

  let done = job.done_count;
  let failed = job.failed_pages;
  /*
   * **これまでの読み取りを引き継ぐ。** 時間切れで中断しても、
   * 次の起動が `result_markdown` の続きから書き足す。
   */
  const parts: string[] = job.result_markdown ? job.result_markdown.split(PAGE_SEP) : [];

  try {
    while (done < job.page_count) {
      if (Date.now() >= deadline - PER_PAGE_MS) {
        // **まだ終わっていないが、今回はここまで。** 進捗は書いてあるので続きから再開できる。
        await advanceJob(job.id, { doneCount: done, failedPages: failed, markdown: parts.join(PAGE_SEP) });
        return { status: 'paused', done, failed };
      }

      const key = job.image_keys[done];
      const page = await readOne(key, job.hint);
      if (page === null) {
        /*
         * **1 枚落ちても残りは続ける** (前景処理と同じ思想)。
         * 落ちた枚数は `failed_pages` に残る = admin から見える。
         */
        failed += 1;
      } else {
        parts.push(page);
      }
      done += 1;
      await advanceJob(job.id, { doneCount: done, failedPages: failed, markdown: parts.join(PAGE_SEP) });
      await extendLock(job.id);
    }

    if (parts.length === 0) {
      // 1 枚も読めなかった。**保存する中身が無い**ので失敗として残す。
      await failJob(job.id, job.attempts, `全 ${job.page_count} 枚が読み取れませんでした`);
      return { status: job.attempts >= MAX_ATTEMPTS ? 'failed' : 'paused', done, failed };
    }

    /*
     * ── 完了 (§4.4) ───────────────────────────────────────────────
     * 束ね方も推論値列の落とし方も**前景と同じ関数**を通す
     * (`scan-markdown.ts`)。ここで別の書き方をすると、同じ紙から違う結果が出る。
     */
    const markdownClean = joinPageMarkdown(parts.map((p) => stripColumnFromTables(p, ['推論値', '推定値'])));
    /*
     * **スペシャルアカウント (複数年) は受診日を読めない回を保存しない (§4.3-1)。**
     * 本来こういう回は前景の検証経路 (scan.astro sendAll) を通すので背景には来ないが、
     * 万一来たときに today で保存すると別の年と同じ date フォルダへ畳まれて Elith 納品が
     * 1 年に潰れる。ここでは黙って潰さず、ジョブを失敗にして admin の監視へ出す。
     */
    await refreshConfig();
    const requireReadableDate = isSpecialAccount(job.diagnostic_user_id);
    const saved = await saveScanResult(sb as never, {
      diagnosticUserId: job.diagnostic_user_id,
      markdownClean,
      pageCount: parts.length,
      requireReadableDate,
    });
    if (saved.blocked) {
      await failJob(job.id, job.attempts, 'exam_date_unreadable');
      return { status: 'failed', done, failed };
    }
    await advanceJob(job.id, { doneCount: done, failedPages: failed, markdown: parts.join(PAGE_SEP) });
    /*
     * **`artifact_id` を必ず書く。** 後から読み取り結果を確認・修正する入口
     * (発注者判断 2026-09-10「確認は任意にする」= 案B)。ここを書き忘れると辿れない。
     */
    await finishJob(job.id, saved.artifactId);

    /*
     * ── Elith 納品 JSON を S3 へ ─────────────────────────────────
     * **前景経路 (`exportScanToS3`) が DB 保存と一緒にやっていたこと。**
     * 背景で読んだ回だけ納品が出ない、という食い違いを作らないため、
     * ワーカーからも**同じ関数** (`scan-export-put.ts`) を呼ぶ。
     *
     * **落ちても検査結果の保存は取り消さない。** 読み取り自体は成功していて
     * `test_artifacts` に残っており、画面にも出る。納品だけをやり直せばよい
     * (再納品の口は §8 の宿題)。ここで投げるとジョブが失敗扱いになり、
     * **同じ紙をもう一度読む** = 検査が二重に作られる。
     */
    try {
      const ex = await putScanExport(markdownClean, {
        diagnosticId: job.diagnostic_id ?? crypto.randomUUID(),
        diagnosticUserId: job.diagnostic_user_id,
        hint: job.hint,
        sourceFileName: job.source_file_name,
      });
      if (!ex.ok) {
        // **黙って落とさない。** admin の監視 (`/api/admin/scan-jobs`) は
        // ジョブの状態しか見ないので、ここはログに残す。
        console.error(
          `[scan-worker] Elith 納品の書き出しに失敗 (job=${job.id}): ${ex.configured ? ex.error : 's3_not_configured'}`,
        );
      }
    } catch (e) {
      console.error('[scan-worker] Elith 納品の書き出しで例外:', e instanceof Error ? e.message : e);
    }

    /*
     * **読み終わったら画像を消す** (§4.4-5)。失敗しても投げない —
     * バケットのライフサイクルが 1 日で必ず消すので、ここは早く消すための保険。
     */
    try {
      await deleteObjects(job.image_keys);
    } catch (e) {
      console.error('[scan-worker] 画像の削除に失敗 (ライフサイクルで消える):', e instanceof Error ? e.message : e);
    }
    return { status: 'done', done, failed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // **黙って消さない。** ユーザーには出さないので、ここに残らないと誰も気づけない。
    console.error('[scan-worker] ジョブが失敗:', msg);
    await failJob(job.id, job.attempts, msg);
    return { status: job.attempts >= MAX_ATTEMPTS ? 'failed' : 'paused', done, failed };
  }
}

/** ページの区切り。`result_markdown` を次の起動で読み戻すために使う内部マーカー。 */
const PAGE_SEP = '\n<!--scan-page-boundary-->\n';

/** 1 枚読む。読めなければ null (呼び出し側が「落ちた 1 枚」として数える)。 */
async function readOne(key: string | undefined, hint: string | null): Promise<string | null> {
  if (!key) return null;
  // キーの検査は `fetchScanUpload` が持つ (形が完全一致するものだけ読む)。
  const got = await fetchScanUpload(key);
  if (!got.ok) {
    console.error(`[scan-worker] 画像を取得できませんでした (${got.status})`);
    return null;
  }
  const r = await readScanPage({ mime: got.mime, data: got.base64, hint });
  if (!r.ok) {
    console.error('[scan-worker] 読み取りに失敗:', r.error);
    return null;
  }
  const md = String(r.markdown ?? '').trim();
  return md || null;
}
