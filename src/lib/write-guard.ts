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

import { shouldUseDemoData, type ViewMode } from './view-mode';
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
 * **未認証を止める**（§21.4 Phase 0）。
 *
 * 【なぜ要るか（2026-09-30 実測）】`/api/scan`・`/api/scan/upload-ticket`・
 * `/api/interview/classify-voice`・`/api/live-token`・`/api/insight`・`/api/coach/ask` の
 * 6 本は `resolveViewer` も `checkAdminAuth` も `cookies` も**一切参照していなかった** =
 * **完全に未認証で叩けた**。実機で `POST /api/live-token` が 76 文字の Gemini Live token を
 * 返すことを確認済み。**課金とストレージを他人に使わせる経路**なので、
 * 外部共有を公開する前に閉じる。
 *
 * 許可 = `self` / `admin_self` / `admin_impersonation` / `admin_impersonation_legacy` /
 *        `share` / `uid_entry`。**`anonymous` だけを 401 にする。**
 *
 * **target lock とは別の話**。`/api/scan` は target を持たない（読むだけ）が、
 * 「正規の主体であること」は要求する。
 */
export function denyAnonymous(v: Pick<Viewer, 'kind'>): Response | null {
  if (v.kind !== 'anonymous') return null;
  return new Response(JSON.stringify({ error: 'unauthenticated', message: 'サインインが必要です。' }), {
    status: 401,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
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

/* ══════════════════════════════════════════════════════════════════════
 * デモ表示中の書き込み（PR-D・§4.4）
 * ════════════════════════════════════════════════════════════════════ */

/**
 * **デモを表示している間は本番のデータへ書かせない**（正本
 * `docs/specs/special_demo_integration_spec_20261022.md` §4.4 / 裁定 4）。
 *
 * 【なぜ要るか（PR-D の棚卸しで実測）】`viewer.writeTargetUid` を使う書き込みは
 * **7 本**あるが、PR-A / PR-C で塞いだのは `kit/[id]/external-id` と
 * `kit/[id]/self-report` の 2 本だけだった。残りはデモを表示している最中でも
 * そのまま本番へ届く:
 *   - `scan/save`       … `test_artifacts` / `measurements` / `measurement_values`
 *   - `scan/jobs`       … `scan_jobs`（cron ワーカーが後から本番として読む）
 *   - `scan/export`     … Elith の source JSON を S3 へ
 *   - `interview/export`… Elith 納品 ＋ `interview_completions`
 * デモの画面は `shouldUseDemoData()` が**ダミーを出す**ので、書いた行は本人にも
 * 見えない = **誰にも見えない本物の行だけが増える**。
 *
 * 【擬似成功を足さない（裁定 4）】ここは `ok: true` を返さない。
 * 「AI問診・AIスキャンは今回 Demo 書込み対応しない」が裁定なので、
 * **403 で止めて理由を返す**。実データで試す必要がある人には
 * Real（スペシャル）資格を付けて Real 表示で使ってもらう。
 *
 * 【2 つとも見る】`viewer.uid`（いま表示している相手）と `writeTargetUid`
 * （これから書く相手）の両方を `shouldUseDemoData()` に通す。現行の `kind` では
 * 必ず一致するが、片方だけを見ると**将来 kind を足したときに静かに抜ける**
 * （`isReadOnlyViewer` が 2 つとも見るのと同じ理由）。
 *
 * 【呼ぶ位置】**最初の書き込み・課金・ログより前**。そして `mode` を作る前に
 * `await refreshConfig()` を済ませること — `isDemoAccount()` は app_config を
 * 読むので、**冷えた isolate で未取得のまま判定すると資格が無いと見えて
 * ゲートが開く**（fail-open）。`verify:write-audit` がこの順序を見張る。
 */
export function denyDemoWrite(
  v: Pick<Viewer, 'uid' | 'writeTargetUid'>,
  mode: ViewMode,
): Response | null {
  const demo = shouldUseDemoData(v.uid, mode) || shouldUseDemoData(v.writeTargetUid, mode);
  if (!demo) return null;
  return new Response(
    JSON.stringify({
      ok: false,
      error: 'demo_mode_write_blocked',
      // **文言はここ 1 か所**。変えるときはこの行だけを直す。
      message: 'デモ表示中は本番のデータに保存しません。実データとして記録するには、表示を「実データ」へ切り替えてください。',
    }),
    { status: 403, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
  );
}
