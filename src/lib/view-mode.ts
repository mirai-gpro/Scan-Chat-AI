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
 * 【2026-10-22・発注者指示でモードの決め方を変えた】**利用者には切り替えさせない。**
 * 「ユーザーに切り替えさせる、なんてありえない」「SP アカウントやデモを使う人間は、
 * マスコミや有力な大口クライアントなんだぞ」。
 *
 *   **旧**: Cookie `welltect_mode` (本人がダッシュボードのスイッチで切り替える)
 *   **新**: **アカウントの属性** — app_config `demo.display_uids` に admin が入れる
 *
 * これで**切り替える口がどこにも無くなる**ので、
 *   ・報道関係者・大口クライアントの画面に切替 UI が出ない (ネガティブな印象を与えない)
 *   ・相手が自分で切り替えて**空の画面や意図しない側に着く**ことが起きない
 *   ・**本人・admin 代理表示・共有のどこから見ても同じ画面**になる
 *     (モードが閲覧者ではなくアカウントに付くので、旧 `switchable` の
 *      「代理表示では切り替えさせない」という条件自体が要らなくなった)
 *
 * 【越えてはならない線】
 *   ・**資格 → 表示 の順。** `demo.display_uids` に書いただけでは Demo は出ない
 *     (`canDemo` が先。資格の無い uid を名簿に書いても効かない)
 *   ・**Dual の既定は `real`** (admin が指定しなければ実データ)
 *   ・**Cookie を読まない・書かない。** 利用者の要求でモードを動かす経路を作らない
 *   ・**ダミーを出す判定をこの 1 か所に閉じる。** 各画面が `isDemoAccount` を
 *     直に見ると、ページごとに Demo / Real が食い違う (§4.3「一部だけ旧判定を残さない」)
 *   ・**モジュール変数に現在のモードを置かない。** SSR は 1 つの isolate で
 *     同時リクエストを捌くので、**他人のモードが漏れる**。常に引数で渡す
 */
import type { APIContext } from 'astro';
import { demoDisabledGlobally, isDemoAccount, isForcedDemoDisplay } from './demo-accounts';
import { isSpecialAccount } from './special-accounts';
import type { Viewer } from './viewer';

/**
 * 表示モード。
 *
 * **`real` が既定**で、`demo` になるのは **admin が `demo.display_uids` に
 * 入れたアカウントだけ**。利用者が選ぶ経路は無い (Cookie も撤去した)。
 */
export type ViewMode = 'real' | 'demo';

export interface ViewModeState {
  /** **実際にどちらを表示するか。** 画面とクエリはこれだけを見る。 */
  effectiveMode: ViewMode;
  /** Demo のダミーを見られる資格があるか。 */
  canDemo: boolean;
  /** 本人の実データを扱う資格 (スペシャル枠) があるか。 */
  canReal: boolean;
  /** 両方の資格を持つ = Dual。**正常な状態。** */
  dual: boolean;
  /**
   * **admin が `demo.display_uids` でデモ表示に指定しているか** (監査・切り分け用)。
   *
   * `false` かつ `effectiveMode === 'demo'` なら、それは**既定**で demo
   * (デモの資格だけを持つ枠 / 未サインイン) ということ。
   */
  forcedDemo: boolean;
}

/**
 * **毎リクエストでモードを決める。**
 *
 * 【順序が要点】**①資格 → ②admin の指定**。
 * **② を先に見てはいけない** — 名簿に書いただけで Demo に入れると、
 * `demo.display_uids` が「資格」の二重管理になり、
 * `demo.account_denied_uids` で止めた人にダミーが出る。
 *
 * 【`real` へ倒す場面】資格を失った / 未サインインでない一般顧客 / admin の指定なし。
 * **既定を `demo` にしない** — 実データの利用者に他人名義のダミーを出す方が害が大きい。
 *
 * @param viewer `resolveViewer()` の結果 (`kind` と `uid` だけ見る)。
 */
export function resolveViewMode(viewer: Pick<Viewer, 'kind' | 'uid'>): ViewModeState {
  const uid = viewer.uid;
  const canDemo = !demoDisabledGlobally() && isDemoAccount(uid);
  const canReal = isSpecialAccount(uid);
  /*
   * **admin がデモ表示に指定しているか。**
   * `canDemo` で囲っているのが要点 — **資格が無い uid を名簿に書いても効かない**。
   */
  const forcedDemo = canDemo && isForcedDemoDisplay(uid);
  /*
   * ════════════════════════════════════════════════════════════════════
   * **admin の指定が無いときの既定。** PR-C から 1 文字も変えていない。
   * ════════════════════════════════════════════════════════════════════
   *
   *   ① Real の資格あり (**Dual を含む**) → **`real`**
   *      発注者の絶対条件「Dual のログイン直後は必ず Real」。実データを持つ人に
   *      ダミーを先に見せない。
   *   ② Demo の資格だけ (記者・パートナー) → **`demo`**
   *      **実データを 1 件も持たない枠**なので、既定を Real にすると
   *      **URL を開いた人が空の画面に着く** = お披露目の導線が壊れる。
   *   ③ 未サインイン → **`demo`**
   *      セッションが無いので資格も引けない。**ダミーを出すかは
   *      `shouldUseDemoData()` が「表示する uid」で判定する**ので、
   *      ここを `demo` にしても一般顧客にダミーは出ない。
   *   ④ どちらの資格も無い (一般顧客) → **`real`**
   *
   * **代理表示・共有も同じ既定・同じ指定に従う** — モードが閲覧者ではなく
   * アカウントに付くので、**admin が A さんを代理表示したとき、A さん本人が
   * 見るのと同じ画面になる** (旧 `switchable` の分岐が要らなくなった理由)。
   */
  const fallback: ViewMode = viewer.kind === 'anonymous' ? 'demo'
    : canReal ? 'real'
      : canDemo ? 'demo'
        : 'real';
  const effectiveMode: ViewMode = forcedDemo ? 'demo' : fallback;
  return { effectiveMode, canDemo, canReal, dual: canDemo && canReal, forcedDemo };
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
 * **画面 / API が呼ぶ入口。** 30 か所から呼ばれる。
 *
 * 【`_ctx` を残してあるのは意図】2026-10-22 に Cookie を読むのをやめたので
 * **リクエストからは何も読まない**。それでも引数を外さないのは、
 * 呼び出し側 30 か所を書き換えないため — そして**ここが唯一の入口である**
 * という形を崩さないため (各ページが `resolveViewMode` を直に呼び始めると、
 * PR-D で揃えた「`refreshConfig()` → モード」の順序が崩れる)。
 *
 * **ここで Cookie やクエリを読む実装を足さないこと。** 足した瞬間に
 * 「利用者の要求でモードが動く」= 発注者が禁じた形に戻る。
 */
export function viewModeFromRequest(
  _ctx: Pick<APIContext, 'cookies'>,
  viewer: Pick<Viewer, 'kind' | 'uid'>,
): ViewModeState {
  return resolveViewMode(viewer);
}
