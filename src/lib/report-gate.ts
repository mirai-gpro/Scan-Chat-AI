/**
 * AI疾病予防報告書 — **ユーザーに出してよい行かを決める 1 本**。
 *
 * 正本: `docs/elith/AI疾病予防報告書_承認と再作成_仕様書.md` §3 / §8。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【なぜ `report-approval.ts` から切り出したか】
 * ══════════════════════════════════════════════════════════════════════
 * 判定そのものは `report-approval.ts` に置いてあったが、あのモジュールは
 * 再作成のために `elith-intake` → `s3` → `@aws-sdk/client-s3` を**静的に**
 * 引く。ユーザー取得経路 (`elith-report-queries` / `dashboard-queries` /
 * `coach-context` / `chat-context` / `result-queries`) がそれを import した
 * 結果、**ダッシュボードと報告書の SSR グラフに AWS SDK が入った**
 * (実測: 承認機能を入れる前は 3 経路とも aws-sdk へ届かなかった)。
 *
 * 再作成は admin だけの操作なので、**ユーザー側は S3 を知らなくてよい**。
 * だからここは **leaf** に保つ — import してよいのは `report-fingerprint`
 * (= `report-adapter` / `report-model`) までで、**S3・Supabase・取り込みを
 * 引いてはいけない**。`scripts/verify-report-approval.mjs` が
 * 「ユーザー経路から aws-sdk へ静的に届かない」ことを見張る。
 */
import type { ReportVM } from './report-model';
import { hashGateOk, type FingerprintRow } from './report-fingerprint';

/** 公開状態。**この 2 つだけ** (migration の CHECK と一致させる)。 */
export const PENDING = 'pending';
export const APPROVED = 'approved';

/**
 * **ユーザーに見せてよい行か。**
 *
 * 【列が無い環境は approved 扱いにする】migration 適用前にアプリが出ても
 * **公開中の報告書を消さない**ため (CLAUDE.md の migration 規約では DB が先だが、
 * 順序が入れ替わったときに利用者の画面が落ちる方が重い)。
 * 列が無ければ `pending` の行も存在しないので、これで未承認が漏れることはない。
 */
export function isApprovedRow(row: { publish_status?: unknown } | null | undefined): boolean {
  if (!row) return false;
  const v = (row as { publish_status?: unknown }).publish_status;
  return v == null || v === APPROVED;
}

/**
 * **ユーザーへ出してよい行か (唯一の合成ゲート)。**
 *
 * 承認状態 (`publish_status`) と**承認した紙面の指紋**の両方を見る (仕様書 §8)。
 * 指紋だけを別に見る実装を各経路へ散らすと、1 か所で絞り忘れても他が正しければ
 * 画面は正常に見える。**判定はここ 1 本**。
 *
 * @param vm 既に組み上がっている紙面 (表示経路はこれを渡す = 二度組まない)。
 *           指紋は閲覧者の文脈に依存しないので、本人の文脈で組んだ VM を渡してよい。
 */
export async function isPubliclyVisibleRow(
  row: { publish_status?: unknown } & FingerprintRow,
  vm?: ReportVM,
): Promise<boolean> {
  if (!isApprovedRow(row)) return false;
  return hashGateOk(row, vm);
}
