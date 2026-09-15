/**
 * **AI 問診を完了した「事実」だけを読み書きする。**
 *
 * マイグレーション `supabase/migrations/20260915000010_interview_completions.sql`。
 *
 * 【なぜ要るか — 実測 2026-09-15】完了はどこにもサーバ側の記録が無かった。
 *   ・`/api/interview/export` は S3 へ書くだけで Supabase への書き込みが 0 件
 *   ・完了記録は端末の localStorage のみ (`session-store.ts` の `InterviewResult`)
 *   → **スマホで問診 → PC で開くと「未回答」に見える**。
 *     「AI疾病予防報告書 単品購入」の進捗 (① AI問診) を出す根拠が存在しなかった。
 *
 * 【保存するのは完了日時と設問数だけ】回答本文は保存しない。
 *   answers には設問 `M-NAME` (服薬名) など医療情報が入るので、
 *   **中身の置き場所は S3 の納品 JSON 1 か所のまま**にする (保管場所を増やさない)。
 *
 * 【書き込みは例外を投げない】問診の書き出し経路から呼ばれるので、
 *   記録に失敗したせいで Elith への書き出しが 500 になる方が害が大きい。
 */

import { getServerSupabase } from './supabase';

/** 1 回分の完了記録 (画面が使うのは `completedAt` だけ)。 */
export interface InterviewCompletion {
  completedAt: string;
  answeredCount: number;
}

/** 妥当な完了日時か。**未来や桁違いの値をそのまま入れない** (クライアント申告のため)。 */
function toIso(completedAt?: number | null): string {
  const now = Date.now();
  if (typeof completedAt !== 'number' || !Number.isFinite(completedAt)) return new Date(now).toISOString();
  // 2020-01-01 より前 / 1 日以上未来 は申告を捨てて受信時刻にする (捏造でなく「受け取った時刻」)。
  if (completedAt < 1_577_836_800_000 || completedAt > now + 86_400_000) return new Date(now).toISOString();
  return new Date(completedAt).toISOString();
}

/**
 * **完了を記録する。** 呼ぶのは問診の書き出し経路 1 か所だけ。
 *
 * @param uid **Cookie から解決した本人の uid**。リクエスト本文の申告は使わない
 *   (他人の完了を作れてしまうため。`/api/scan/save` と同じ規律)。
 * @returns 記録できたら true。失敗しても**投げない**。
 */
export async function recordInterviewCompletion(
  uid: string | null | undefined,
  opts: { completedAt?: number | null; answeredCount?: number; diagnosticId?: string | null } = {},
): Promise<boolean> {
  try {
    if (!uid) return false;
    const sb = getServerSupabase();
    if (!sb) return false;
    const row = {
      diagnostic_user_id: uid,
      completed_at: toIso(opts.completedAt),
      answered_count: Math.max(0, Math.trunc(opts.answeredCount ?? 0)),
      diagnostic_id: opts.diagnosticId ?? null,
    };
    const { error } = await (sb.schema('diagnosis') as unknown as {
      from: (t: string) => { insert: (v: unknown) => Promise<{ error: { message: string } | null }> };
    }).from('interview_completions').insert(row);
    if (error) {
      console.error('[interview-completion] 記録に失敗 (書き出しは継続):', error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[interview-completion] 記録で例外 (書き出しは継続):', e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * **最新の完了を 1 件だけ引く。** ダッシュボードの hot path なので 1 行で済ませる。
 *
 * **見つからない = 未回答**。テーブルがまだ無い環境 (migration 未適用) でも
 * null を返して画面を壊さない — ただし**「完了した」と誤って言わない**方へ倒す。
 */
export async function getLatestInterviewCompletion(
  uid: string | null | undefined,
): Promise<InterviewCompletion | null> {
  try {
    if (!uid) return null;
    const sb = getServerSupabase();
    if (!sb) return null;
    const { data, error } = await (sb.schema('diagnosis') as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (c: string, v: string) => {
            order: (c: string, o: { ascending: boolean }) => {
              limit: (n: number) => Promise<{ data: Array<Record<string, unknown>> | null; error: { message: string } | null }>;
            };
          };
        };
      };
    })
      .from('interview_completions')
      .select('completed_at,answered_count')
      .eq('diagnostic_user_id', uid)
      .order('completed_at', { ascending: false })
      .limit(1);
    if (error) {
      console.error('[interview-completion] 照会に失敗:', error.message);
      return null;
    }
    const row = data?.[0];
    if (!row) return null;
    return {
      completedAt: String(row.completed_at ?? ''),
      answeredCount: Number(row.answered_count ?? 0),
    };
  } catch (e) {
    console.error('[interview-completion] 照会で例外:', e instanceof Error ? e.message : e);
    return null;
  }
}
