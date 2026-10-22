/**
 * ════════════════════════════════════════════════════════════════════════════
 * **表示モード (Real / Demo) — 資格とは別物**
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 正本 `docs/specs/special_demo_integration_spec_20261022.md` §4.2 / §4.3 (PR-C)。
 *
 * 【資格と表示モードを分ける理由】PR-B で **1 人 = 1 canonical `diagnostic_user_id`** に
 * なり、**Demo 資格と Real 資格を同時に持てる** (Dual) ようになった。
 * どちらのデータを見せるかは**資格ではなく、いまどちらを表示しているか**で決まる。
 *
 *   `experienceCapabilities(uid)` … その人が**持っている資格** (PR-B・不変)
 *   `resolveViewMode(...)`        … **いまどちらを表示するか** (この層)
 *   `shouldUseDemoData(uid, mode)`… **ダミーを出すかの唯一の判定** (この層)
 *
 * 【越えてはならない線】
 *   ・**Cookie を権限の根拠にしない。** 毎リクエストで資格を引き直す
 *     (Cookie は「どちらを見たいか」という希望でしかない)
 *   ・**Dual のログイン直後は必ず `real`** (Cookie が無ければ Real)
 *   ・**代理表示・共有・未サインインでは切り替えさせない** (`switchable:false`)
 *   ・**ダミーを出す判定をこの 1 か所に閉じる。** 各画面が `isDemoAccount` を
 *     直に見ると、ページごとに Demo / Real が食い違う (§4.3「一部だけ旧判定を残さない」)
 *   ・**モジュール変数に現在のモードを置かない。** SSR は 1 つの isolate で
 *     同時リクエストを捌くので、**他人のモードが漏れる**。常に引数で渡す
 */
import type { APIContext } from 'astro';
import { demoDisabledGlobally, isDemoAccount } from './demo-accounts';
import { isSpecialAccount } from './special-accounts';
import type { Viewer } from './viewer';

/** Cookie 名。**HttpOnly** なので JS から読めない (切り替えはサーバ API 経由)。 */
export const MODE_COOKIE = 'welltect_mode';

/** 表示モード。**`real` が既定**で、`demo` は明示的に切り替えたときだけ。 */
export type ViewMode = 'real' | 'demo';

/** Cookie の値として妥当か。**知らない値は null** (壊れた Cookie で Demo にしない)。 */
export function parseMode(raw: string | null | undefined): ViewMode | null {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'demo' || v === 'real' ? v : null;
}

/** Cookie の属性。`viewerCookieOptions()` と同じ流儀 (dev は http なので Secure を外す)。 */
export function modeCookieOptions(): {
  httpOnly: true; secure: boolean; sameSite: 'lax'; path: string; maxAge: number;
} {
  return {
    httpOnly: true,
    secure: import.meta.env.DEV !== true,
    sameSite: 'lax',
    path: '/',
    // 30 日 = `welltect_v` と同じ。**これ自身は認証ではない**ので期限は緩くてよい。
    maxAge: 60 * 60 * 24 * 30,
  };
}

export interface ViewModeState {
  /** **実際にどちらを表示するか。** 画面とクエリはこれだけを見る。 */
  effectiveMode: ViewMode;
  /** Demo のダミーを見られる資格があるか。 */
  canDemo: boolean;
  /** 本人の実データを扱う資格 (スペシャル枠) があるか。 */
  canReal: boolean;
  /** 両方の資格を持つ = Dual。**正常な状態。** */
  dual: boolean;
  /** 画面に切り替えスイッチを出してよいか (＝ `POST /api/session/view-mode` が通るか)。 */
  switchable: boolean;
  /** Cookie が要求していたモード (監査・切り分け用)。 */
  requested: ViewMode | null;
}

/**
 * **毎リクエストでモードを決める。**
 *
 * 【順序が要点】①切り替えてよい閲覧者か → ②Demo の資格が在るか → ③Cookie の希望。
 * **③ を先に見てはいけない** (Cookie だけで Demo に入れると権限の根拠になる)。
 *
 * 【`real` へ倒す場面】資格を失った / 代理表示 / 共有 / 未サインイン / Cookie 無し。
 * **既定を `demo` にしない** — 実データの利用者に他人名義のダミーを出す方が害が大きい
 * (スペシャル枠で止めていたのと同じ事故。§4.3 でその 1 行を外す代わりに、
 * ここが「明示的に切り替えたときだけ Demo」を担保する)。
 *
 * @param viewer `resolveViewer()` の結果 (`kind` と `uid` だけ見る)。
 * @param requested Cookie から読んだ希望 (`parseMode` を通した値)。
 */
export function resolveViewMode(
  viewer: Pick<Viewer, 'kind' | 'uid'>,
  requested: ViewMode | null,
): ViewModeState {
  const uid = viewer.uid;
  const canDemo = !demoDisabledGlobally() && isDemoAccount(uid);
  const canReal = isSpecialAccount(uid);
  /*
   * **切り替えてよいのは本人のセッションだけ。**
   *   `admin_impersonation` / `admin_impersonation_legacy` … admin が他人の画面を見ている。
   *     ここで Demo へ入れると**「A さんの画面のつもりでダミーを見る」**という
   *     §13.0 が名指しした最悪の形になる (承認の確認が無意味になる)
   *   `share`     … URL を開くだけで入る人。表示対象の資格で画面を変えさせない
   *   `anonymous` … uid が無いので資格も無い
   *   `uid_entry` … 緊急入場。admin を与えない経路なので切り替えも与えない
   */
  const selfSession = viewer.kind === 'self' || viewer.kind === 'admin_self';
  const switchable = selfSession && canDemo;
  /*
   * ════════════════════════════════════════════════════════════════════
   * **Cookie が無いときの既定。** 変えるのは Dual だけで、他は PR-C 前と同じ挙動。
   * ════════════════════════════════════════════════════════════════════
   *
   *   ① Real の資格あり (**Dual を含む**) → **`real`**
   *      発注者の絶対条件「Dual のログイン直後は必ず Real」。実データを持つ人に
   *      ダミーを先に見せない。
   *   ② Demo の資格だけ (記者・パートナー) → **`demo`**
   *      **実データを 1 件も持たない枠**なので、既定を Real にすると
   *      **URL を開いた人が空の画面に着く** = お披露目の導線が壊れる
   *      (PR-C 前と同じ挙動に保つ)。
   *   ③ 未サインイン → **`demo`**
   *      セッションが無いので資格も引けない。**ダミーを出すかは
   *      `shouldUseDemoData()` が「表示する uid」で判定する**ので、
   *      ここを `demo` にしても一般顧客にダミーは出ない
   *      (本番は未サインインならサインイン画面で止まる)。
   *   ④ どちらの資格も無い (一般顧客) → **`real`**
   *
   * **代理表示・共有は切り替えられない** (`switchable:false`) が、**既定は
   * 表示対象の資格に従う** — admin が デモ用アカウントを確認するとき、
   * 共有相手がデモの紙面を見るときの挙動を PR-C 前から変えないため。
   */
  const fallback: ViewMode = viewer.kind === 'anonymous' ? 'demo'
    : canReal ? 'real'
      : canDemo ? 'demo'
        : 'real';
  const effectiveMode: ViewMode = switchable && requested !== null ? requested : fallback;
  return { effectiveMode, canDemo, canReal, dual: canDemo && canReal, switchable, requested };
}

/**
 * **ダミーを出すかの唯一の判定。**
 *
 * 旧 `demoFallbackEnabled(uid)` の置き換え。違いは**モードを引数で受ける**ことだけで、
 * 資格の判定 (`demoDisabledGlobally` → `isDemoAccount`) は 1 文字も変えていない。
 *
 * 【スペシャル排他を外した】旧実装は `isSpecialAccount(uid)` なら無条件 false にして
 * いた (両方に登録された事故で実データの利用者にダミーが出るのを止めるため)。
 * **Dual が正常な状態になったので、排他ではなくモードで分ける** —
 * Dual の既定は `real` で、`demo` になるのは**本人が明示的に切り替えたときだけ**。
 * **この排他を別の場所へ移植しない** (§4.3)。
 *
 * @param mode **呼び出し側が持っている `effectiveMode`。省略できない** —
 *   省略を許すと「モードを渡し忘れたページだけ挙動が違う」が静かに生まれる。
 */
export function shouldUseDemoData(uid: string | null | undefined, mode: ViewMode): boolean {
  if (mode !== 'demo') return false;
  if (demoDisabledGlobally()) return false;
  return isDemoAccount(uid);
}

/**
 * **画面 / API が呼ぶ入口。** Cookie を読んで資格と突き合わせ、モードを決める。
 *
 * **各ページで Cookie を直に読まない** — 読み方が散ると「あるページだけ
 * 壊れた Cookie を信じる」が生まれる。`resolveViewer()` の結果と対で使う。
 */
export function viewModeFromRequest(
  ctx: Pick<APIContext, 'cookies'>,
  viewer: Pick<Viewer, 'kind' | 'uid'>,
): ViewModeState {
  return resolveViewMode(viewer, parseMode(ctx.cookies.get(MODE_COOKIE)?.value));
}
