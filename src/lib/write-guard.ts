/**
 * **永続データを書き換える API の入口に置く番人。**
 *
 * 正本: `docs/specs/secure_shared_access_and_admin_impersonation_spec_20260930.md`
 *       §12.5（代理表示は read-only）/ §38-U27。
 *
 * 【なぜ要るか（2026-09-30 の実測）】「代理表示は read-only」と仕様に書き、
 * `viewer.writeTargetUid` を `null` にしたが、**書き込み API は誰もそれを見ていなかった**。
 *   - `api/scan/save.ts:36` / `api/scan/jobs.ts:39` は `viewer.selfUid` を使う
 *     → 代理表示中に押すと **admin 本人の検査結果として保存される**
 *   - `api/kit/[id]/self-report.ts` / `api/notices/[id]/read.ts` は
 *     **body の `diagnosticUserId` をそのまま信じる** → 対象顧客の配送状態・既読状態が変わる
 * どちらも「read-only」ではない。**型と仕様だけでは守れない**ので、
 * **書く直前に 1 行入れる**形で機械的に閉じる。
 *
 * 【何を禁じるか】**永続データの変更だけ。** POST だから一律禁止にはしない
 * （AI へ問い合わせるだけの POST・トークン発行のような読み取り相当の POST は通す）。
 *
 * 【使い方】
 * ```ts
 * const viewer = await resolveViewer({ request, cookies } as APIContext);
 * const denied = denyReadOnlyWrite(viewer);
 * if (denied) return denied;
 * ```
 *
 * 【将来】外部共有（§14〜§20）も同じ番人を通す。`writeTargetUid` が null かどうか
 * だけを見ているので、share を足すときにここは変えなくてよい。
 */

import type { Viewer } from './viewer';

/** 代理表示・共有など「読めるが書けない」主体か。 */
export function isReadOnlyViewer(v: Pick<Viewer, 'kind' | 'writeTargetUid'>): boolean {
  // **2 つとも見る。** 片方だけだと、新しい kind を足したときに静かに抜ける。
  return v.kind === 'admin_impersonation' || v.writeTargetUid === null;
}

/**
 * 書けない主体なら **403 の Response**、書けるなら `null`。
 *
 * **理由は返すが対象は返さない**（誰の画面を見ているかを応答に載せない）。
 */
export function denyReadOnlyWrite(v: Pick<Viewer, 'kind' | 'writeTargetUid'>): Response | null {
  if (!isReadOnlyViewer(v)) return null;
  return new Response(
    JSON.stringify({
      error: 'read_only',
      message: '代理表示中は保存できません。',
    }),
    { status: 403, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
  );
}
