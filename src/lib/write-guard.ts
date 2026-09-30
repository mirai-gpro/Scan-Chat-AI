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

/* ══════════════════════════════════════════════════════════════════════
 * 外部共有（§17.2 / §17.4 / §17.5）
 * ════════════════════════════════════════════════════════════════════ */

/** 403 を JSON で返す（理由は返すが対象は返さない）。 */
function deny(error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status: 403,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * **共有セッションからは一切叩かせない口**（§17.4 / §17.5）。
 *
 * 発注者が明示的に許可した更新は **AI 問診と AI スキャンの 2 つだけ**で、
 * それ以外の更新は scope に含まれない（§17.2）。具体的には
 *
 *   - `POST /api/kit/[id]/self-report` … **本人の配送状態**を外部共有者が変えてはいけない。
 *     実態と食い違うと**以後の出荷・検査の段取りが狂う**。
 *   - `POST /api/notices/[id]/read`     … **本人の既読状態**。勝手に既読になると
 *     **重要な通知を見落とす**。
 *   - `POST /api/auth/*`                … **端末の持ち主（別人かもしれない）の
 *     本人セッションを共有相手の操作で壊させない**（§17.5）。
 *
 * **UI から消すだけでは足りない**（API 直叩きを防げない）ので、サーバ側で 403 にする。
 */
export function denyForShare(v: Pick<Viewer, 'kind'>): Response | null {
  if (v.kind !== 'share') return null;
  return deny('share_not_allowed', 'この操作は共有閲覧ではご利用いただけません。');
}

/**
 * **scope に無い機能を止める**（§17.2）。
 *
 * 共有リンクは用途ごとに `{ interview, scan }` を切り替えて発行できる
 * （PDF の「用途別に管理できる」）。**scope に無い更新は既定 BLOCK。**
 */
export function denyUnlessShareScope(
  v: Pick<Viewer, 'kind' | 'shareScope'>,
  need: 'interview' | 'scan',
): Response | null {
  if (v.kind !== 'share') return null;
  if (v.shareScope?.[need] === true) return null;
  return deny('share_scope', 'この共有リンクではこの機能をご利用いただけません。');
}
