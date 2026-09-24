/**
 * 複数 uid の「AI問診 / スキャン(health_checkup) の完了状況」をまとめて取る。
 *
 * 用途: admin のスペシャルアカウント登録リストに完了ステータスを出す
 *       (UI=wellfort-site / データ=Scan-Chat-AI API。責務分界どおり)。
 *
 * - interview: `diagnosis.interview_completions` の有無 + 最新 completed_at + 件数
 * - scan     : `diagnosis.test_artifacts` の health_checkup(status=active) の有無 + 最新 test_date + 件数
 *
 * 【PII を admin レスポンスに載せない】回答本文・測定値は読まない。件数と日時だけ。
 * 【fail-safe】空配列・DB 未設定・クエリ失敗時は、全 uid を「未完了(空)」で返す
 *   (admin 画面を壊さない。存在しない情報を「完了」と偽らない)。
 */

import { getServerSupabase } from './supabase';

export interface CompletionStat {
  done: boolean;
  /** 最新の完了日時 (問診=completed_at / スキャン=test_date)。ISO 文字列。 */
  latest: string | null;
  count: number;
}
export interface AccountProgress {
  interview: CompletionStat;
  scan: CompletionStat;
}

function emptyProgress(): AccountProgress {
  return {
    interview: { done: false, latest: null, count: 0 },
    scan: { done: false, latest: null, count: 0 },
  };
}

export async function getAccountProgress(
  uids: readonly string[],
): Promise<Record<string, AccountProgress>> {
  const out: Record<string, AccountProgress> = {};
  const clean = Array.from(
    new Set((uids ?? []).filter((u): u is string => typeof u === 'string' && u.length > 0)),
  );
  for (const u of clean) out[u] = emptyProgress();
  if (clean.length === 0) return out;

  const sb = getServerSupabase();
  if (!sb) return out;

  try {
    type Row = { diagnostic_user_id: string; completed_at?: string | null; test_date?: string | null };
    const diagnosis = sb.schema('diagnosis') as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          in: (col: string, v: string[]) => Promise<{ data: Row[] | null }>;
          eq: (col: string, v: string) => {
            eq: (col: string, v: string) => {
              in: (col: string, v: string[]) => Promise<{ data: Row[] | null }>;
            };
          };
        };
      };
    };

    const [iv, sc] = await Promise.all([
      diagnosis.from('interview_completions').select('diagnostic_user_id, completed_at').in('diagnostic_user_id', clean),
      diagnosis
        .from('test_artifacts')
        .select('diagnostic_user_id, test_date')
        .eq('test_type', 'health_checkup')
        .eq('status', 'active')
        .in('diagnostic_user_id', clean),
    ]);

    for (const r of iv.data ?? []) {
      const p = out[r.diagnostic_user_id];
      if (!p) continue;
      p.interview.count += 1;
      p.interview.done = true;
      const t = r.completed_at ? String(r.completed_at) : null;
      if (t && (!p.interview.latest || t > p.interview.latest)) p.interview.latest = t;
    }
    for (const r of sc.data ?? []) {
      const p = out[r.diagnostic_user_id];
      if (!p) continue;
      p.scan.count += 1;
      p.scan.done = true;
      const d = r.test_date ? String(r.test_date) : null;
      if (d && (!p.scan.latest || d > p.scan.latest)) p.scan.latest = d;
    }
  } catch {
    // 失敗時は空 (未完了) のまま返す。画面は成立させる。
  }

  return out;
}
