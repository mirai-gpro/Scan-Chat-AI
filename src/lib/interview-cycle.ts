/**
 * AI問診の「この回の分が済んでいるか」= **回窓連動**の判定 (発注者確定 2026-09-24)。
 *
 * 【なぜ回単位か】
 * がんリスク(プリベント)・AI疾病予測(LAiF)・AI疾病予防(Elith報告書) は
 * **その回の最新問診**を入力に使う。がんリスクと報告書は年複数回あるので、
 * 問診は**回(サイクル)ごとに取り直す**必要がある。一度完了したら永久に「完了」
 * では、次の回で取り直しを促せない。
 *
 * 【判定 = 回窓連動】
 * その回の窓の開始 (`cycleStart`) 以降に完了した問診だけを「この回の分」とみなす。
 *   - never            … 一度も完了していない
 *   - stale            … 完了はあるが cycleStart より前 (= 前の回の問診・取り直しが要る)
 *   - done_this_cycle  … cycleStart 以降に完了 (この回は済み)
 *
 * 【fail-safe】回の窓が不明なとき (cycleStart が無い/壊れている) は、完了が
 * 在れば `done_this_cycle` に倒す。**誤って催促しない**方へ倒す (過剰催促を避ける)。
 * これは「回窓が取れないなら取り直しを求めない」= 取りこぼし側でなく静穏側の安全側。
 *
 * 【アンカーの出所 (暫定)】
 * 厳密な回の窓 (`kit_shipment_schedule` / `current_cycle_seq`) はまだ app_bridge で
 * Scan-Chat-AI へ渡っていない (`bridge-queries.adaptSubscription` が
 * `current_cycle_seq=null`)。そこで到達可能な `last_test_at`(前回検査日) を回の開始と
 * みなし、無ければ `started_at`(契約開始) を使う (`currentCycleStart`)。
 * **ブリッジが回窓/current_cycle_seq を出したら `currentCycleStart` の中だけ差し替える**
 * (呼び出し側とロジックは不変)。
 */

export type InterviewCycleStatus = 'never' | 'stale' | 'done_this_cycle';

/** 回窓連動の中核判定。純関数 (I/O なし・テスト対象)。 */
export function interviewCycleStatus(input: {
  completedAt: string | null | undefined;
  cycleStart: string | null | undefined;
}): InterviewCycleStatus {
  const done = parseTime(input.completedAt);
  if (done === null) return 'never';

  const start = parseTime(input.cycleStart);
  // 回窓が不明 (取れない/壊れている) → 完了が在れば済み扱い (誤催促しない)
  if (start === null) return 'done_this_cycle';

  return done >= start ? 'done_this_cycle' : 'stale';
}

/** その回の問診が済んでいるか (`done_this_cycle` のときだけ true)。 */
export function isInterviewDoneThisCycle(input: {
  completedAt: string | null | undefined;
  cycleStart: string | null | undefined;
}): boolean {
  return interviewCycleStatus(input) === 'done_this_cycle';
}

/**
 * サブスクから「今の回の窓の開始」を導く (暫定アンカー)。
 * 優先: `last_test_at` (前回検査 = 新しい回の起点) → `started_at` (契約開始・初回)。
 * どちらも無ければ null (= 回窓不明 → 上の fail-safe に委ねる)。
 *
 * **単品購入 (スペシャルアカウント) はサブスクが無い = 1 回分**なので、ここは呼ばない
 * (問診は 1 度で足り、回ごとの取り直しは発生しない)。
 */
export function currentCycleStart(
  sub: { last_test_at?: string | null; started_at?: string | null } | null | undefined,
): string | null {
  if (!sub) return null;
  return sub.last_test_at ?? sub.started_at ?? null;
}

/** ISO 文字列を epoch(ms) に。空/不正は null。 */
function parseTime(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
