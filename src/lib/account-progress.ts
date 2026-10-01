/**
 * 複数 uid の「AI問診 / 検査 5 種 / Elith 納品」の状況をまとめて取る。
 *
 * 用途: admin のスペシャルアカウント一覧に件数と最新日を出す
 *       (UI=wellfort-site / データ=Scan-Chat-AI API。責務分界どおり)。
 *
 * - interview : `diagnosis.interview_completions` の有無 + 最新 completed_at + 件数
 * - byTestType: `diagnosis.test_artifacts` (status=active) を **5 種とも**集計
 *               (health_checkup / blood / genetics / cancer_urine / ai_prediction)
 * - delivered : `diagnosis.elith_deliveries` (バンドル単位) **∪**
 *               `diagnosis.elith_delivery_items` (検査単位) の delivered
 *
 * 【2026-10-01・P3 で広げた】正本
 * `docs/specs/special_account_management_spec_20261001.md` §6.2 / §6.4。
 * 以前は `test_type='health_checkup'` 固定 (P-3) で、しかも納品済みの判定が
 * `elith_deliveries` だけを見ていた (P-2) ため、**追加検査で納品した回が
 * 一覧では「未納品」に見えていた**。どちらも画面は正常に見えるので気づけない。
 *
 * 【PII を admin レスポンスに載せない】回答本文・測定値・原本のファイル名は読まない。
 *   **件数と日時だけ。**
 * 【fail-safe】空配列・DB 未設定・クエリ失敗時は、全 uid を「未完了(空)」で返す
 *   (admin 画面を壊さない。**存在しない完了を「済み」と偽らない**)。
 *
 * 【これは一覧の数字であって納品されるファイル数ではない】§7.3.1。
 *   受診日が読めない回・同じ date フォルダに畳まれる回があるので、
 *   **確認モーダルの件数をここから作ってはいけない**。あちらは実際の assemble 結果が正。
 */

import { getServerSupabase } from './supabase';
import type { ArtifactTestType } from './scan-persist';

/** 一覧に出す検査 5 種。`test_artifacts.test_type` の CHECK と同じ集合。 */
export const PROGRESS_TEST_TYPES: readonly ArtifactTestType[] = [
  'health_checkup', 'blood', 'genetics', 'cancer_urine', 'ai_prediction',
];

export interface CompletionStat {
  done: boolean;
  /** 最新の完了日時 (問診=completed_at / 検査=test_date / 納品=delivered_at)。 */
  latest: string | null;
  count: number;
}
export interface AccountProgress {
  interview: CompletionStat;
  /**
   * 検診・人間ドックの状況。**`byTestType.health_checkup` と同じもの。**
   * 既存の呼び出し元 (wellfort-site の一覧) を壊さないために残す (§6.4)。
   */
  scan: CompletionStat;
  /** 検査種別ごとの件数と最新日。 */
  byTestType: Record<ArtifactTestType, CompletionStat>;
  /** Elith 納品済みか。バンドル単位と検査単位の**両方**を見る。 */
  delivered: CompletionStat;
  /** 問診・検査 5 種を通した最新日 (一覧の「最終更新」)。 */
  latestActivity: string | null;
}

const stat = (): CompletionStat => ({ done: false, latest: null, count: 0 });

function emptyProgress(): AccountProgress {
  const byTestType = {} as Record<ArtifactTestType, CompletionStat>;
  for (const t of PROGRESS_TEST_TYPES) byTestType[t] = stat();
  return {
    interview: stat(),
    scan: byTestType.health_checkup,   // 同じ実体を指す (二重に数えない)
    byTestType,
    delivered: stat(),
    latestActivity: null,
  };
}

/** 件数を 1 つ足し、最新日を更新する。日付が無い行も**件数には数える** (黙って落とさない)。 */
function bump(s: CompletionStat, when: unknown): void {
  s.count += 1;
  s.done = true;
  const t = when ? String(when) : null;
  if (t && (!s.latest || t > s.latest)) s.latest = t;
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
    type Row = {
      diagnostic_user_id: string;
      completed_at?: string | null;
      test_date?: string | null;
      test_type?: string | null;
      delivered_at?: string | null;
      status?: string | null;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diagnosis = (sb as any).schema('diagnosis');

    /**
     * **1 本が引けなくても他を道連れにしない。**
     * `elith_delivery_items` は migration の適用が発注者の操作なので、
     * 未適用の環境では必ず失敗する。そこで Promise.all ごと倒れると
     * **問診も検査も 0 件になり「何も無い人」に見える**。
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const safe = (p: Promise<any>) => p.then((r: any) => r ?? { data: null }).catch(() => ({ data: null }));

    const [iv, sc, dl, di] = await Promise.all([
      safe(diagnosis.from('interview_completions')
        .select('diagnostic_user_id, completed_at')
        .in('diagnostic_user_id', clean)),
      // **5 種とも取る。** 以前は health_checkup 固定だったので、血液・遺伝子・
      // がんリスク・AI疾病予測は一覧に 1 件も出なかった (P-3)。
      safe(diagnosis.from('test_artifacts')
        .select('diagnostic_user_id, test_date, test_type')
        .eq('status', 'active')
        .in('test_type', PROGRESS_TEST_TYPES as string[])
        .in('diagnostic_user_id', clean)),
      safe(diagnosis.from('elith_deliveries')
        .select('diagnostic_user_id, delivered_at')
        .eq('status', 'delivered')
        .in('diagnostic_user_id', clean)),
      // **第 4 の問い合わせ (P-2)。** 追加検査の納品はこちらにしか残らない。
      safe(diagnosis.from('elith_delivery_items')
        .select('diagnostic_user_id, delivered_at')
        .eq('status', 'delivered')
        .in('diagnostic_user_id', clean)),
    ]);

    for (const r of (iv.data ?? []) as Row[]) {
      const p = out[r.diagnostic_user_id];
      if (p) bump(p.interview, r.completed_at);
    }
    for (const r of (sc.data ?? []) as Row[]) {
      const p = out[r.diagnostic_user_id];
      const t = (r.test_type ?? '') as ArtifactTestType;
      // **知らない test_type は数えない** (捏造しない)。
      if (p && p.byTestType[t]) bump(p.byTestType[t], r.test_date);
    }
    for (const r of [...((dl.data ?? []) as Row[]), ...((di.data ?? []) as Row[])]) {
      const p = out[r.diagnostic_user_id];
      if (p) bump(p.delivered, r.delivered_at);
    }

    for (const p of Object.values(out)) {
      const all = [p.interview.latest, ...PROGRESS_TEST_TYPES.map((t) => p.byTestType[t].latest)];
      p.latestActivity = all.filter((v): v is string => !!v).sort().at(-1) ?? null;
    }
  } catch {
    // 失敗時は空 (未完了) のまま返す。画面は成立させるが、**済みとは言わない**。
    return out;
  }

  return out;
}
