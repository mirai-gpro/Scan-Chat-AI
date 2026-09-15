/**
 * **スキャンのジョブ台帳** (`diagnosis.scan_jobs`) への読み書き。
 *
 * 正本: `docs/scan/スキャン非同期処理_仕様書.md` §4.2〜§4.5。
 * マイグレーション: `supabase/migrations/20260910000010_scan_jobs.sql`。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【この表の存在理由】送信を押したら**ユーザーを待たせない**。
 * ══════════════════════════════════════════════════════════════════════
 * 読み取りは 1 枚 30〜50 秒かかり、6 枚なら 3〜5 分。前景でやると画面を開いたまま
 * 待たせるうえ、**タブを閉じると全ページ失われて最初から**になる。
 * → 画像を S3 に置き、ここへジョブを積んで、ワーカーが後から読む。
 *
 * 【持たないもの】氏名・生年月日などの PII は持たない (§3.3)。
 * 持つのは `diagnostic_user_id` と S3 キーだけ。**キーはログにも出さない。**
 *
 * 【service_role でしか触れない】この表は RLS を有効化したうえで**ポリシーを 1 つも置かない**
 * (検査票画像への参照を持つため)。`getServerSupabase()` は SERVICE_ROLE_KEY を使うので
 * bypass できるが、**そこが崩れると 0 行しか見えないのにエラーも出ない** (§4.2)。
 */

import { getServerSupabase } from './supabase';

export type ScanJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface ScanJob {
  id: string;
  diagnostic_user_id: string;
  status: ScanJobStatus;
  image_keys: string[];
  page_count: number;
  done_count: number;
  failed_pages: number;
  hint: string | null;
  result_markdown: string | null;
  artifact_id: string | null;
  error: string | null;
  attempts: number;
  locked_until: string | null;
  created_at?: string;
  updated_at?: string;
}

/** 自動再試行の上限 (§4.5)。超えたら `failed` で止めて**黙って消さない**。 */
export const MAX_ATTEMPTS = 3;

/** 1 回の占有時間。ワーカーが落ちても、これを過ぎれば他のワーカーが拾い直せる。 */
const LOCK_SEC = 15 * 60;

/** 型のついていない新テーブルを触るための最小ラッパ (生成済み型にはまだ無い)。 */
function table() {
  const sb = getServerSupabase();
  if (!sb) return null;
  return (sb.schema('diagnosis') as unknown as {
    from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  }).from('scan_jobs');
}

/**
 * **ジョブを積む。**
 *
 * @param uid **Cookie から解決した本人の uid**。リクエスト本文の申告は使わない
 *   (他人のスキャンを作れてしまうため。`/api/scan/save` と同じ規律)。
 * @param keys S3 のキー。**順番が紙の順番**なのでそのまま配列で持つ。
 */
export async function enqueueScanJob(
  uid: string,
  keys: string[],
  hint: string | null,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const t = table();
  if (!t) return { ok: false, error: 'supabase_not_configured' };
  const { data, error } = await t
    .insert({
      diagnostic_user_id: uid,
      image_keys: keys,
      page_count: keys.length,
      hint: hint || null,
    })
    .select('id')
    .single();
  if (error) {
    // **キーはログに出さない** (§3.3)。出すのは理由だけ。
    console.error('[scan-jobs] 登録に失敗:', error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, id: String((data as { id: string }).id) };
}

/**
 * **次に処理するジョブを 1 件だけ取って占有する。**
 *
 * `select … for update skip locked` は PostgREST から使えないので、
 * **「取ってから、取れたことを更新の条件で確かめる」**形にする
 * (更新が 0 行なら他のワーカーが先に取った = 何もしない)。
 */
export async function claimNextJob(): Promise<ScanJob | null> {
  const t = table();
  if (!t) return null;
  const nowIso = new Date().toISOString();

  const { data: rows, error } = await t
    .select('*')
    .in('status', ['queued', 'running'])
    .lt('attempts', MAX_ATTEMPTS)
    .or(`locked_until.is.null,locked_until.lt.${nowIso}`)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) {
    console.error('[scan-jobs] 取得に失敗:', error.message);
    return null;
  }
  const job = (rows as ScanJob[] | null)?.[0];
  if (!job) return null;

  const lockUntil = new Date(Date.now() + LOCK_SEC * 1000).toISOString();
  const { data: claimed, error: upErr } = await table()!
    .update({ status: 'running', locked_until: lockUntil, attempts: job.attempts + 1 })
    .eq('id', job.id)
    // **ここが二重起動よけ。** 取った時点の値と食い違えば 0 行になる。
    .eq('attempts', job.attempts)
    .or(`locked_until.is.null,locked_until.lt.${nowIso}`)
    .select('*');
  if (upErr) {
    console.error('[scan-jobs] 占有に失敗:', upErr.message);
    return null;
  }
  const got = (claimed as ScanJob[] | null)?.[0];
  return got ?? null;
}

/**
 * **1 枚ぶん進んだことを記録する。**
 *
 * 時間切れで中断しても**続きから**再開できるよう、`done_count` と
 * これまでの markdown を**毎枚書く** (§4.3)。
 */
export async function advanceJob(
  id: string,
  next: { doneCount: number; failedPages: number; markdown: string },
): Promise<void> {
  const t = table();
  if (!t) return;
  const { error } = await t
    .update({
      done_count: next.doneCount,
      failed_pages: next.failedPages,
      result_markdown: next.markdown,
    })
    .eq('id', id);
  if (error) console.error('[scan-jobs] 進捗の記録に失敗:', error.message);
}

/** 占有を伸ばす (長い 1 枚で lock が切れて二重処理されないように)。 */
export async function extendLock(id: string): Promise<void> {
  const t = table();
  if (!t) return;
  await t.update({ locked_until: new Date(Date.now() + LOCK_SEC * 1000).toISOString() }).eq('id', id);
}

/** 完走。**`artifact_id` を必ず書く** — 後から読み取り結果を確認する入口 (§4.4-4)。 */
export async function finishJob(id: string, artifactId: string | null): Promise<void> {
  const t = table();
  if (!t) return;
  const { error } = await t
    .update({ status: 'done', artifact_id: artifactId, locked_until: null })
    .eq('id', id);
  if (error) console.error('[scan-jobs] 完了の記録に失敗:', error.message);
}

/**
 * **失敗を残す。** ユーザーには出さない (発注者判断) ので、
 * **ここに残らないと誰も気づけない** (§4.5)。
 *
 * `attempts` が上限未満なら `queued` に戻して次の起動で再試行する。
 */
export async function failJob(id: string, attempts: number, message: string): Promise<void> {
  const t = table();
  if (!t) return;
  const retryable = attempts < MAX_ATTEMPTS;
  const { error } = await t
    .update({
      status: retryable ? 'queued' : 'failed',
      error: message.slice(0, 2000),
      locked_until: null,
    })
    .eq('id', id);
  if (error) console.error('[scan-jobs] 失敗の記録に失敗:', error.message);
}

/**
 * **監視用** (§4.5)。①失敗したジョブ ②滞留しているジョブ を数える。
 *
 * 滞留 = `queued`/`running` のまま `staleMinutes` を超えたもの。
 * **画像は 1 日で消える**ので、滞留はそのまま復旧不能に向かう = 早く気づく必要がある。
 */
export async function scanJobHealth(staleMinutes = 30): Promise<{
  ok: boolean;
  /** false = DB を引けなかった (未設定 or 障害)。**0 件と区別する**。 */
  configured?: boolean;
  failed: number;
  stale: number;
  rows: Pick<ScanJob, 'id' | 'status' | 'page_count' | 'done_count' | 'failed_pages' | 'attempts' | 'error' | 'created_at'>[];
}> {
  const t = table();
  if (!t) return { ok: false, configured: false, failed: 0, stale: 0, rows: [] };
  const since = new Date(Date.now() - staleMinutes * 60_000).toISOString();
  const cols = 'id,status,page_count,done_count,failed_pages,attempts,error,created_at';

  const [f, s] = await Promise.all([
    t.select(cols).eq('status', 'failed').order('created_at', { ascending: false }).limit(50),
    table()!.select(cols).in('status', ['queued', 'running']).lt('created_at', since)
      .order('created_at', { ascending: true }).limit(50),
  ]);
  if (f.error || s.error) {
    console.error('[scan-jobs] 監視の照会に失敗:', f.error?.message ?? s.error?.message);
    return { ok: false, configured: true, failed: 0, stale: 0, rows: [] };
  }
  const failed = (f.data ?? []) as ScanJob[];
  const stale = (s.data ?? []) as ScanJob[];
  return {
    ok: true,
    configured: true,
    failed: failed.length,
    stale: stale.length,
    // **uid も S3 キーも返さない。** 監視に要るのは件数と理由だけ。
    rows: [...failed, ...stale] as never,
  };
}
