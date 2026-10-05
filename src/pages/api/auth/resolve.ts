import type { APIRoute } from 'astro';
import { getServerSupabase } from '../../../lib/supabase';
import {
  isHpEdgeConfigured,
  isHpEdgeStagingConfigured,
  resolveCustomerWithAdmin,
  resolveStagingCustomerByEmail,
} from '../../../lib/hp-edge';
import { VIEWER_COOKIE, signViewer, viewerCookieOptions, resolveViewer } from '../../../lib/viewer';
import { denyForShare } from '../../../lib/write-guard';
import { isAdminEmailAsync } from '../../../lib/admin-auth';
import { issueAdminCred } from '../../../lib/admin-identity';
import { linkDemoEmail, resolveDemoUidByEmail } from '../../../lib/demo-accounts';
import { linkSpecialEmail, resolveSpecialUidByEmail, specialPreassignedUidByEmail } from '../../../lib/special-accounts';

export const prerender = false;

/**
 * サインイン後の本人解決 (サーバー側)。**Google / メール＋パスワード の共通合流点**。
 *
 * 認証方式が増えても**この口は 1 つだけ**。メール認証専用の本人解決 API は作らない
 * (2026-10-05 発注者指示 §7)。クライアントは Supabase のアクセストークンを渡すだけで、
 * email / sub は**サーバがトークンから検証**する (クライアント申告を使わない)。
 *
 * クライアントから Supabase アクセストークンを受け取り、本人を検証したうえで:
 *   1. email → diagnostic_user_id を解決
 *        - 本番: HP の resolve-customer Edge Function (email はブリッジに載せない)
 *        - dev : モック customer.customer_profiles を email で解決
 *   2. #2 diagnosis.app_users に本人連携 (google_sub ↔ diagnostic_user_id) を永続化
 *   3. { linked, diagnosticUserId } を返す
 *
 * 旧 GoogleOneTap.astro の DEMO_EMAIL_TO_UID ハードコードを置き換える。
 */
export const POST: APIRoute = async (apiCtx) => {
  const { request, cookies } = apiCtx;
  /*
   * **共有閲覧からは一切叩かせない**（2026-09-30・仕様書 §17.5 / §31 T-14-4）。
   * 端末の持ち主（共有相手とは**別人かもしれない**）の本人セッションを、
   * 共有相手の操作で**作らせない・壊させない**。共有を終えるのは `/share/end` の役目で、
   * あれは `welltect_share_v` だけを消す。
   */
  const shared = denyForShare(await resolveViewer(apiCtx));
  if (shared) return shared;

  const body = (await request.json().catch(() => null)) as { accessToken?: unknown } | null;
  const accessToken = typeof body?.accessToken === 'string' ? body.accessToken : null;
  if (!accessToken) return json({ error: 'missing accessToken' }, 400);

  const sb = getServerSupabase();
  if (!sb) return json({ error: 'supabase not configured' }, 503);

  // アクセストークンから本人を検証 (email/sub をクライアント申告に頼らない)
  const { data: userData, error: userErr } = await sb.auth.getUser(accessToken);
  if (userErr || !userData?.user) return json({ error: 'invalid session' }, 401);
  const user = userData.user;
  const email = (user.email ?? '').trim().toLowerCase();
  const authId = user.id;
  if (!email) return json({ error: 'no email in account' }, 400);

  /*
   * ── **「持っている Identity」と「今回使った認証方式」を分ける** ──────────────
   * (2026-10-05 発注者指示 §2。混同すると §8 の退行 L が起きる)
   *
   *   hasGoogleIdentity … **その人が Google Identity を持っているか**。
   *                       `app_metadata` / `identities` (getUser が返すサーバ検証済み情報)。
   *   currentAuthMethod … **今回のセッションが何で認証されたか**。
   *                       アクセストークンの `amr` (Authentication Method References)。
   *
   * `app_metadata.providers` に `google` が在ることは、**今回 Google で入った証拠にならない**
   * (Google Identity を持つ人が password でも入れるため)。
   */
  const hasGoogleIdentity = detectGoogleIdentity(user);
  const currentAuthMethod = await detectCurrentAuthMethod(sb, accessToken, user);

  /*
   * **`google_sub` は「今回 Google で認証した」ときだけ書く。**
   *
   * ・password と**確定した**セッションでは書かない (メール認証で Google 由来でない値を
   *   入れない・テスト K)。
   * ・`amr` が取れなかった回 (`unknown`) は **従来どおりの挙動**に倒す
   *   = Google Identity があれば書く。これで既存 Google ユーザーの動作が変わらない
   *   (テスト J)。**書く値そのものは従来と同じ式**で、ここでは変えていない。
   *
   * ⚠️ `user_metadata.sub` が利用者書き換え可能である既存の課題は**別件**
   *   (2026-10-05 発注者指示 §9)。ここでは**悪化させないだけ**で、意味も移行も変えない。
   */
  const sub = hasGoogleIdentity && currentAuthMethod !== 'password'
    ? ((user.user_metadata as Record<string, string> | undefined)?.sub ?? null)
    : null;

  // 1) email → diagnostic_user_id + 表示名(姓)
  let diagnosticUserId: string | null = null;
  let bareName: string | null = null;
  /** 管理者リスト (Wellfort 側 `admin_users`) に載っているか。解決と同じ応答で受け取る。 */
  let isAdmin = false;
  /**
   * **どの経路で uid が決まったか。** 応答とログに残す。
   *
   * 総合テストで staging の顧客を通す段を足したので (下記)、**本番の顧客と
   * テストの顧客が同じ `app_users` に並ぶ**。後から棚卸しできるように、
   * 「どこ由来か」を必ず残す。**PII は含まない**。
   */
  let resolvedFrom: 'production' | 'staging' | 'local' | 'special' | 'demo' | null = null;

  /** ローカルの `customer_profiles` で解決する (HP Edge 未構成 / 呼び出し失敗時の受け皿)。 */
  const resolveLocally = async (): Promise<{ error: Response } | null> => {
    const { data: profile, error: profErr } = await sb
      .schema('customer')
      .from('customer_profiles')
      .select('diagnostic_user_id, family_name')
      .ilike('email', email)
      .maybeSingle();
    if (profErr) return { error: json({ error: `profile lookup: ${profErr.message}` }, 500) };
    if (profile?.diagnostic_user_id) {
      diagnosticUserId = profile.diagnostic_user_id;
      bareName = profile.family_name;
      resolvedFrom = 'local';
    }
    return null;
  };

  if (isHpEdgeConfigured()) {
    /*
     * **HP Edge の失敗でサインインを壊さない (2026-08-30)。**
     *
     * ここは以前 throw していたので、Edge が 401/500 を返すと
     * **この API ごと 500 になり誰もサインインできなくなる**。
     * `HP_EDGE_BASE_URL` を入れた瞬間に全滅する形で、切替のリスクが高すぎる。
     * → 失敗したらログに残してローカル解決へ落ちる。**admin は付けない**
     *   (管理者リストを確認できていないので昇格させない = fail-closed)。
     */
    let outcome: Awaited<ReturnType<typeof resolveCustomerWithAdmin>> | null = null;
    try {
      outcome = await resolveCustomerWithAdmin(email);
    } catch (e) {
      console.error('[auth/resolve] resolve-customer 失敗。ローカル解決へ切替:', e instanceof Error ? e.message : e);
    }
    /*
     * **admin 判定は顧客の有無と独立** (管理者 ≠ EC の顧客)。
     * Edge が答えられたときだけ採用する (失敗時は false のまま = fail-closed)。
     */
    isAdmin = outcome?.isAdmin === true;

    if (outcome?.customer) {
      diagnosticUserId = outcome.customer.diagnostic_user_id;
      bareName = outcome.customer.display_name;
      resolvedFrom = 'production';
    } else {
      /*
       * **Wellfort 側に顧客レコードが無くてもサインインを止めない (2026-08-30)。**
       * 管理者やテスト用のアカウントは EC の顧客として登録されていないことがあり、
       * ここで打ち切ると `linked:false` になって**サインインできなくなる**。
       * ローカルの `customer_profiles` で解決を試み、それも無ければ従来どおり未連携。
       */
      const failed = await resolveLocally();
      if (failed) return failed.error;
    }
  } else {
    const failed = await resolveLocally();
    if (failed) return failed.error;
  }

  /*
   * **この Google アカウントに既に割り当てられている uid を先に引く (2026-08-31)。**
   *
   * `app_users` は `diagnostic_user_id` が主キーで、**`auth_user_id` と `google_sub` は UNIQUE**
   * (`20260601000010_schemas_and_tables.sql:173-175`)。下の upsert は
   * `onConflict: 'diagnostic_user_id'` なので、**同じ Google アカウントが別の uid に
   * 束縛されていると UNIQUE 違反で 500 になりサインインが完全に止まる**
   * (本番で実測: `duplicate key ... "app_users_auth_user_id_key"`)。
   */
  const linkedUid = await findLinkedUid(sb, authId, sub);

  /*
   * **デモ用アカウントは EC の顧客ではない (2026-08-31)。**
   *
   * 記者やパートナーに見せるためのアカウントなので `resolve-customer` では引けず、
   * ここまでで uid が決まらない。そのまま下の未連携へ落ちると
   * 「お客様情報が見つかりませんでした」で止まり、**デモ登録しても入口で弾かれる**。
   * → デモ用として登録されている人にだけ、デモ専用の uid を与えて中へ通す。
   *   **登録の無い人はここを素通りする** (従来どおり未連携)。
   *
   * `linkedUid` を渡すのが要点。**渡さないと毎回新しい uid を作って UNIQUE 違反になる**
   * (しかも保存は下の `linkDemoEmail` なので、500 で止まると永久に保存されず毎回壊れる)。
   */
  /*
   * **ステージングの顧客を通す (総合テスト専用・env 2 本が揃ったときだけ)。**
   *
   * 総合テストは **staging の EC で購入 → 本番の Web アプリでサインイン** という
   * 環境を跨いだ構成で行う。顧客レコード (`public.customer_profiles`) は購入した
   * 環境にしか出来ず、上の 1 段目は `HP_EDGE_BASE_URL` が指す **1 プロジェクトしか
   * 見ない** (コードに環境切替は無い) ので、本番を指している限り staging の顧客には
   * 構造的に届かない。2 段目の `resolveLocally()` も、アプリ自身の
   * `customer.customer_profiles` に**書く実装が存在しない** (seed 3 本のみ) ため
   * seed 以外は必ず空振りする。→ ここで staging を引く。
   *
   * **デモ発行より前**に置く。後ろだと staging の顧客がデモ用 uid を掴んでしまう。
   * また `uidIsAuthoritative` の判定より前に置くことで、staging 由来も
   * **顧客DB由来 (authoritative)** として扱われ、下の束縛の張り替えで
   * 「顧客DBが正」の分岐に乗る (デモ発行 uid と混同しない)。
   *
   * 【運ばないもの】**管理者判定は一切運ばない** (`resolveStagingCustomerByEmail` は
   * `is_admin` を読まない)。staging はアカウントを自由に作れるので、権限を運ぶと
   * **staging に行を作るだけで本番アプリの管理者になれてしまう**。
   *
   * 【失敗しても止めない】1 段目と同じく握って先へ進む (サインインを壊さない)。
   */
  if (!diagnosticUserId && isHpEdgeStagingConfigured()) {
    try {
      const staging = await resolveStagingCustomerByEmail(email);
      if (staging) {
        diagnosticUserId = staging.diagnostic_user_id;
        bareName = staging.display_name;
        resolvedFrom = 'staging';
        console.warn(
          `[auth/resolve] ステージングの顧客として解決しました (uid=${diagnosticUserId})。` +
          ' 総合テスト用の経路です。テスト終了後に HP_EDGE_STAGING_BASE_URL を外してください。',
        );
      }
    } catch (e) {
      console.error('[auth/resolve] staging resolve-customer 失敗:', e instanceof Error ? e.message : e);
    }
  }

  const uidIsAuthoritative = diagnosticUserId !== null; // 顧客DB由来か (= デモ発行でないか)
  /*
   * **スペシャルアカウント (EC 購入を伴わない招待) を通す。**
   * 正本 `docs/operations/スペシャルアカウント_仕様書.md` §6。
   *
   * デモ枠と同じく `resolve-customer` では引けないが、**目的は逆で本人の実データを扱う**。
   * **デモ枠より先に置く** — 誤って両方に登録されていたときに、
   * 実データ側を優先してダミーを掴ませないため。
   *
   * `linkedUid` を渡すのが要点 (渡さないと毎回新しい uid を作って UNIQUE 違反になる)。
   */
  if (!diagnosticUserId) {
    diagnosticUserId = await resolveSpecialUidByEmail(email, linkedUid);
    if (diagnosticUserId) resolvedFrom = 'special';
  }
  if (!diagnosticUserId) {
    diagnosticUserId = await resolveDemoUidByEmail(email, linkedUid);
    if (diagnosticUserId) resolvedFrom = 'demo';
  }

  /*
   * ══════════════════════════════════════════════════════════════════════
   * **Google 認証済み → 後からメール＋パスワード認証 を拒否する** (発注者指示 §3)
   * ══════════════════════════════════════════════════════════════════════
   *
   * 禁じているのは**この一方向だけ**。逆 (メール認証 → 後から Google) は禁じない。
   *
   * 【拒否する条件は 2 つだけ】(2026-10-05 実コードレビューで是正)
   *   ① `diagnosticUserId` が決まっている
   *   ② 今回の方式が `password` と**確定**している (`amr` 由来・`unknown` では止めない)
   *   かつ ③ その uid の `app_users.google_sub` が**存在する** (= Google 利用済み)
   *
   * **`auth_user_id` が今回と同じか違うかは拒否条件にしない。** 禁じているのは
   * 「**Google 利用済みの人がメール＋パスワード認証を使うこと自体**」であって、
   * 「認証 ID が張り替わること」ではない。両者を混同すると取り逃す:
   *   - 本番 `diagnosis.app_users` 実測 (2026-10-05): `google_sub` あり **24 件** のうち
   *     **`auth_user_id` が NULL のものが 13 件**。`auth_user_id` を条件に入れると
   *     **この 13 件は password 認証を拒否できない**。
   *   - 同じ auth user に後からパスワードを付けた回も `auth_user_id` が一致するので
   *     素通りしてしまう。
   *
   * 【なぜ書き込みの前で止めるか】`findLinkedUid` は `auth_user_id` / `google_sub` でしか
   * 引けないので、**別の auth user で入ってきた password セッションは `linkedUid` に
   * 当たらない**。すると下の張り替え分岐を素通りし、`upsert` が
   * **既存行の `auth_user_id` / `google_sub` を無言で書き換える** (調査 §9)。
   *
   * 【止める位置】`issueAdminCred` より前。Cookie を 1 枚も発行しない。
   * detach / upsert / `linkSpecialEmail` のいずれにも到達しない。
   *
   * 【引けなかったら通さない (fail-closed)】照会が落ちたら「Google 済かどうか不明」なので
   * **何も書かずに 503**。この照会は **password セッションのときだけ**走るので、
   * 既存の Google ログインには 1 回も影響しない。
   */
  if (diagnosticUserId && currentAuthMethod === 'password') {
    const { data: existing, error: exErr } = await sb
      .schema('diagnosis')
      .from('app_users')
      .select('auth_user_id, google_sub')
      .eq('diagnostic_user_id', diagnosticUserId)
      .maybeSingle();
    if (exErr) {
      console.error('[auth/resolve] 既存束縛の照会に失敗 (何も書かずに中止):', exErr.message);
      return json({ error: 'ただいま混み合っています。時間をおいて再度お試しください。' }, 503);
    }
    const row = existing as { auth_user_id?: string | null; google_sub?: string | null } | null;
    // **`auth_user_id` は見ない。** Google 利用済み (`google_sub` あり) なら それだけで拒否する。
    if (row?.google_sub) {
      console.warn(
        `[auth/resolve] Google 利用済みの uid に password セッションが来たので拒否しました`
        + ` (uid=${diagnosticUserId}, method=${currentAuthMethod})。何も書いていません。`,
      );
      return json({
        error: 'このメールアドレスは別のログイン方法でご利用中です。'
             + '最初にご利用になった方法でサインインしてください。',
      }, 409);
    }
  }

  /*
   * ══════════════════════════════════════════════════════════════════════
   * **事前発行したスペシャル uid は、黙って張り替えない** (2026-10-05 発注者指示)
   * ══════════════════════════════════════════════════════════════════════
   *
   * スペシャル枠は**メール登録のその場で uid を発行し、本人のログイン前に
   * 健診・遺伝子・報告書を投入する**。したがって
   *
   *     special 登録時 UID-A → UID-A に実データ投入 → 本人サインイン
   *     → 既存 linkedUid = UID-B → 黙って UID-B に切り替える
   *
   * は**絶対に禁止**。やると **UID-A に入れた本人の健康データと本人の認証が
   * 分離する** (本人は自分のデータを見られず、UID-A のデータは誰にも結び付かない)。
   * 下の張り替え分岐の `if (!uidIsAuthoritative)` が**まさにこれをする**
   * (スペシャルもデモも「顧客DB由来でない」= `uidIsAuthoritative === false`)。
   * デモ枠はダミーなので従来どおりで構わないが、スペシャル枠は実データなので止める。
   *
   * 【止める位置 = `issueAdminCred` より前】(2026-10-05 hardening)
   * 以前はこのガードが張り替え分岐の中、つまり `issueAdminCred` の**後ろ**にあった。
   * 本線の書き込み (detach / upsert / `linkDemoEmail` / `linkSpecialEmail` /
   * viewer Cookie) には届いていなかったが、**admin credential だけは発行済み**で
   * 「何も書かない」が成立していなかった。ここへ移して
   * **set / delete とも 1 回も呼ばない**ようにする。
   *
   * 【判定を推論しない】「`resolvedFrom === 'special'` なら記録済み uid のはず」と
   * 逆算すると、`resolveSpecialUidByEmail` の優先順位を 1 行変えた瞬間に
   * **静かに効かなくなる**。**事前発行済みかを直接引いて**突き合わせる。
   *
   * 【照会が落ちたら通さない (fail-closed)】**引けなかったことを「事前発行なし」と
   * 同一視しない。** 同一視すると app_config の取得が落ちた回にガードが素通りし、
   * ちょうど守りたかった張り替えが起きる。引けなければ**何も書かずに 503**。
   *
   * 【legacy は従来どおり】新仕様より前に登録した `uid=''` の行は記録が無いので
   * `uid: null` が返り、ここは素通りして下の救済 (既存 uid へ寄せる) に入る。
   *
   * 【通常は起きない】起きるのは「事前発行した uid とは別の uid に、同じ
   * Auth アカウントが既に束縛されている」ときだけ。自動移行はしない —
   * **どちらのデータが本物かを機械が決めてよい場面ではない**ので、人が判断する。
   */
  if (linkedUid && diagnosticUserId && linkedUid !== diagnosticUserId && resolvedFrom === 'special') {
    const preassigned = await specialPreassignedUidByEmail(email);
    if (!preassigned.ok) {
      console.error(
        '[auth/resolve] スペシャル枠の事前発行 uid を照会できませんでした。'
        + ' 「事前発行なし」とは扱わず、何も書かずに中止します'
        + ` (linked=${linkedUid})。`,
      );
      return json({ error: 'ただいま混み合っています。時間をおいて再度お試しください。' }, 503);
    }
    if (preassigned.uid && preassigned.uid === diagnosticUserId) {
      console.error(
        '[auth/resolve] スペシャル枠の事前発行 uid と既存の束縛が競合しています。'
        + ` 何も書かずに中止しました (preassigned=${diagnosticUserId}, linked=${linkedUid})。`
        + ' 事前投入した検査データを別の人格へ紐付けないため、自動移行はしません。',
      );
      return json({
        error: 'アカウント連携情報が既存のIDと競合しています。事務局へご連絡ください。',
      }, 409);
    }
  }

  /*
   * **admin 専用 credential (`welltect_admin_v`) は、uid が決まる前に発行する**
   * (2026-09-30・仕様書 §12.4.1)。
   *
   * 【なぜ早期 return より前か】**`admin_users` に居るが Scan-Chat-AI 側の
   * `diagnostic_user_id` を持たない admin が居る**。その人はこの直後の
   * `{ linked:false }` で返ってしまうので、ここより後ろに置くと
   * **代理表示を一生使えない**。admin 本人確認の本質は「**どの admin か**」であって、
   * その admin 自身の健康診断 uid ではない (だから `welltect_admin_v` の payload に
   * uid を入れていない)。
   *
   * **非 admin なら削除**する (この呼び出しの中で判定している・`issueAdminCred`)。
   * **本線は変えない** — 足すのはこの Cookie の発行だけ (§12.7 約束 7)。
   */
  const adminForCred = isAdmin || await isAdminEmailAsync(email);
  await issueAdminCred({ cookies }, email, adminForCred);

  /*
   * 未連携 (適格性なし)。**admin かどうかは返す** —
   * `GoogleOneTap` が「お客様情報が見つかりませんでした」で止めるべきか、
   * それとも admin として handoff の続きへ進ませるかを判断できるようにするため。
   */
  if (!diagnosticUserId) return json({ linked: false, admin: adminForCred }, 200);

  /*
   * **束縛の張り替え。** ここまで来て `linkedUid` と食い違う場合:
   *   ・デモ発行の uid   → **既存の uid を採る**(勝手に新しい人格を作らない)
   *   ・顧客DB由来の uid → **顧客DBが正**。古い行から認証の束縛だけ外して張り直す
   *                        (**行は消さない**。検査データはその uid のまま残る)
   *
   * ⚠️ **スペシャル枠の事前発行 uid の競合ガードはここには無い。**
   * `issueAdminCred` より前へ移した (上の「事前発行したスペシャル uid」ブロック)。
   * ここへ戻すと **admin credential を発行してから 409 を返す**ことになり、
   * 「何も書かない」が成立しない。`verify:email-auth` ⑫ と
   * `verify:special-accounts` ⑩ が位置を見張っている。
   */
  if (linkedUid && linkedUid !== diagnosticUserId) {
    if (!uidIsAuthoritative) {
      diagnosticUserId = linkedUid;
    } else {
      console.warn(
        `[auth/resolve] Google アカウントの束縛を張り替えます: ${linkedUid} → ${diagnosticUserId}` +
        ' (顧客DBが正。旧行は残し auth_user_id / google_sub のみ解除)',
      );
      const { error: detachErr } = await sb
        .schema('diagnosis')
        .from('app_users')
        .update({ auth_user_id: null, google_sub: null, updated_at: new Date().toISOString() })
        .eq('diagnostic_user_id', linkedUid);
      if (detachErr) {
        console.error('[auth/resolve] 旧束縛の解除に失敗:', detachErr.message);
        return json({ error: 'この Google アカウントの連携情報が競合しています。事務局へご連絡ください。' }, 500);
      }
    }
  }

  // 2) #2 app_users に本人連携を永続化 (display_name_cache は「姓+様」規約)
  const nowIso = new Date().toISOString();
  const row = {
    diagnostic_user_id: diagnosticUserId,
    auth_user_id: authId,
    google_sub: sub,
    eligibility_checked_at: nowIso,
    updated_at: nowIso,
    ...(bareName ? { display_name_cache: `${bareName}様` } : {}),
  };
  const { error: upErr } = await sb
    .schema('diagnosis')
    .from('app_users')
    .upsert(row, { onConflict: 'diagnostic_user_id' });
  if (upErr) {
    /*
     * **生の Postgres メッセージを画面に出さない (2026-08-31)。**
     * 実際に `duplicate key value violates unique constraint "app_users_auth_user_id_key"` が
     * サインイン画面へそのまま出た。利用者には意味が無く、内部構造を晒すだけ。
     * 詳細はサーバログへ。切り分けに要る uid はログ側に出す。
     */
    console.error(`[auth/resolve] app_users upsert 失敗 (uid=${diagnosticUserId}, linked=${linkedUid}):`, upErr.message);
    return json({ error: 'アカウント連携の保存に失敗しました。時間をおいて再度お試しください。' }, 500);
  }

  /*
   * 本人確認済みの uid を **HttpOnly Cookie** に載せる（2026-08-30）。
   * これ以降、画面側は `?u=` ではなくこの Cookie で本人を判定する
   * （`src/lib/viewer.ts`）。`?u=` は admin の代理表示のときだけ効く。
   * 署名鍵が無い環境では null が返るので Cookie を発行しない（fail-closed）。
   */
  /*
   * admin かどうかは**ここで email から決める** (2026-08-30)。
   * `email` は `sb.auth.getUser(accessToken)` で**サーバが検証した値**で、
   * クライアントの申告ではない。判定結果は署名付き Cookie に載るので改竄できない。
   *
   * **判定の正は `admin_users` テーブル** — wellfort-site の admin 画面が管理者を
   * 出し入れしている実体で、同じ Supabase に在る。**そこに管理者が増えたら自動で追随する**
   * 判定の実体は wellfort-site の管理者リスト (`public.admin_users`)。ベタ書きの一覧は撤去した。
   * 実測 2026-08-30: 手写しの uid/email に依存していたため本番で admin にならず、
   * 報告書が空のままだった (spec §4.6)。
   */
  /*
   * **デモ用アカウントの引き当て (2026-08-30)。**
   *
   * admin が登録するのは**相手の Google アカウント**で、uid ではない
   * (記者やパートナーに UUID を聞くことはできない)。ここは
   * **サーバ検証済みの email と解決済みの uid が両方そろう唯一の場所**なので、
   * ここで突き合わせて uid 側の一覧へ写す。以後は毎リクエスト uid だけで判定できる。
   *
   * **失敗してもサインインは止めない** (`linkDemoEmail` は例外を投げない)。
   */
  await linkDemoEmail(email, diagnosticUserId);
  /*
   * **スペシャルアカウントも同じ場所で uid を写す** (仕様書 §6)。
   * admin が登録するのは相手の Google アカウントで、uid ではない。
   * `linkSpecialEmail` は登録の無い人には何も書かず、例外も投げない。
   */
  await linkSpecialEmail(email, diagnosticUserId);

  /*
   * **解決元の環境を Cookie に載せる。** キット進捗が読む `app_bridge` は
   * production と staging で別プロジェクトなので、以後のページ表示で
   * 「この人はどちらを見るか」を決める根拠が要る。**staging のときだけ印が付く**
   * (印の無い Cookie は production 扱い＝既定を staging にしない)。
   */
  const token = await signViewer(
    diagnosticUserId,
    adminForCred,   // ★ 上で 1 度だけ判定済み (`welltect_admin_v` と必ず同じ結論になる)
    Date.now(),
    resolvedFrom === 'staging' ? 'staging' : 'production',
  );
  if (token) cookies.set(VIEWER_COOKIE, token, viewerCookieOptions());

  // `resolvedBy` は切り分け用 (PII 非含有)。**staging 由来かどうかがここで分かる**。
  return json({ linked: true, diagnosticUserId, resolvedBy: resolvedFrom }, 200);
};

/**
 * **その人が Google Identity を持っているか** (= `hasGoogleIdentity`)。
 *
 * ⚠️ **「今回 Google で認証した」ではない。** 両者を同一視すると、
 * Google Identity を持つ人の password セッションを Google と誤判定する
 * (発注者指示 §2 / テスト L)。今回の方式は `detectCurrentAuthMethod()` で見る。
 *
 * 根拠は `sb.auth.getUser()` が返した**サーバ検証済みの User**。
 * `app_metadata` は Admin API でしか書けない (利用者は `updateUser` で触れない) ので、
 * `user_metadata` と違って信用できる。
 */
export function detectGoogleIdentity(user: {
  app_metadata?: { provider?: string; providers?: string[] } | null;
  identities?: { provider?: string }[] | null;
} | null | undefined): boolean {
  if (!user) return false;
  const meta = user.app_metadata ?? {};
  if (meta.provider === 'google') return true;
  if (Array.isArray(meta.providers) && meta.providers.includes('google')) return true;
  return (user.identities ?? []).some((i) => i?.provider === 'google');
}

/** 今回のセッションが何で認証されたか。`amr` から決める。 */
export type CurrentAuthMethod = 'oauth' | 'password' | 'other' | 'unknown';

/**
 * **`amr` (Authentication Method References) から「今回の認証方式」を決める。**
 *
 * `amr` はアクセストークンのクレームで、**そのセッションを成立させた方法**が入る。
 * `app_metadata.providers` (持っている Identity の一覧) とは別物。
 *
 * | `amr[].method` | 返す値 |
 * |---|---|
 * | `oauth` / `oauth_provider/...` / `sso/saml` | `'oauth'` |
 * | `password` / `email/signup` | `'password'` |
 * | `magiclink` / `otp` / `totp` / `mfa/*` 等 | `'other'` |
 * | `token_refresh` | **無視** (元の方式を表さないため) |
 * | 取れない / 判別不能 | `'unknown'` |
 *
 * **`'unknown'` では何も止めない**。止めるのは `'password'` と確定したときだけで、
 * 既存の Google ログインを巻き込まないため (発注者指示 §3)。
 */
export function authMethodFromAmr(amr: unknown): CurrentAuthMethod {
  const names: string[] = [];
  if (Array.isArray(amr)) {
    for (const e of amr) {
      if (typeof e === 'string') names.push(e);
      else if (e && typeof e === 'object' && typeof (e as { method?: unknown }).method === 'string') {
        names.push((e as { method: string }).method);
      }
    }
  }
  // `token_refresh` は「更新した」という記録で、元の方式を表さない。
  const m = names.map((n) => n.toLowerCase()).filter((n) => n !== 'token_refresh');
  if (m.length === 0) return 'unknown';
  const oauth = m.some((n) => n === 'oauth' || n.startsWith('oauth_provider/') || n.startsWith('sso/'));
  const password = m.some((n) => n === 'password' || n === 'email/signup');
  if (oauth && password) return 'unknown';   // 同時に立つことは無い想定。判らないものは止めない
  if (oauth) return 'oauth';
  if (password) return 'password';
  return 'other';
}

/**
 * アクセストークンの `amr` を取って「今回の認証方式」を返す。
 *
 * 1. **`getClaims(accessToken)` を優先**する (@supabase/auth-js に在る。JWT を検証して
 *    クレームを返す)。
 * 2. 無い / 失敗した環境では、**`getUser()` の検証が通った後に限り**同じトークンの
 *    payload を自前で復号して `amr` だけを読む。**未検証の JWT は信用しない** —
 *    `sub` と `email` が `getUser()` の結果と一致することを確かめてから使う
 *    (発注者指示 §1)。
 * 3. どちらも駄目なら `'unknown'` (何も止めない・従来どおりの挙動)。
 *
 * **新しい依存は足していない。**
 */
export async function detectCurrentAuthMethod(
  sb: NonNullable<ReturnType<typeof getServerSupabase>>,
  accessToken: string,
  user: { id: string; email?: string | null },
): Promise<CurrentAuthMethod> {
  // ① getClaims (在れば優先)
  try {
    const auth = sb.auth as unknown as {
      getClaims?: (jwt?: string) => Promise<{ data?: { claims?: { amr?: unknown } } | null; error?: unknown }>;
    };
    if (typeof auth.getClaims === 'function') {
      const { data, error } = await auth.getClaims(accessToken);
      if (!error && data?.claims) {
        const got = authMethodFromAmr(data.claims.amr);
        if (got !== 'unknown') return got;
      }
    }
  } catch (e) {
    console.warn('[auth/resolve] getClaims が使えませんでした:', e instanceof Error ? e.message : e);
  }

  // ② getUser 検証後のトークンの payload から amr だけ読む (検証前の JWT は信用しない)
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return 'unknown';
    const json = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as { sub?: unknown; email?: unknown; amr?: unknown };
    /*
     * **同じトークンであることを確かめてから使う。** `getUser()` は Auth サーバに
     * 問い合わせて本人を確定済みなので、その結果と `sub` / `email` が一致すれば、
     * この payload は**検証済みトークンのもの**だと言える。
     */
    if (String(json.sub ?? '') !== user.id) return 'unknown';
    const tokenEmail = String(json.email ?? '').trim().toLowerCase();
    const userEmail = (user.email ?? '').trim().toLowerCase();
    if (tokenEmail && userEmail && tokenEmail !== userEmail) return 'unknown';
    return authMethodFromAmr(json.amr);
  } catch {
    return 'unknown';
  }
}

/**
 * この Google アカウントに**既に割り当てられている** `diagnostic_user_id`。
 *
 * `auth_user_id` と `google_sub` はどちらも UNIQUE なので、どちらかで引ければそれが本人の識別子。
 * **無ければ null**（初回サインイン）。失敗しても null を返す（サインインを壊さない）。
 */
async function findLinkedUid(
  sb: ReturnType<typeof getServerSupabase>,
  authId: string,
  sub: string | null,
): Promise<string | null> {
  if (!sb) return null;
  // **値を検証してから or フィルタへ入れる**（PostgREST の or は文字列構文なので生値を混ぜない）。
  const uuid = /^[0-9a-f-]{36}$/i.test(authId) ? authId : null;
  const gsub = sub && /^[A-Za-z0-9_-]{1,64}$/.test(sub) ? sub : null;
  const terms = [uuid ? `auth_user_id.eq.${uuid}` : '', gsub ? `google_sub.eq.${gsub}` : '']
    .filter(Boolean)
    .join(',');
  if (!terms) return null;
  try {
    const { data, error } = await sb
      .schema('diagnosis')
      .from('app_users')
      .select('diagnostic_user_id')
      .or(terms)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('[auth/resolve] app_users 既存連携の照会に失敗:', error.message);
      return null;
    }
    return (data as { diagnostic_user_id?: string } | null)?.diagnostic_user_id ?? null;
  } catch (e) {
    console.error('[auth/resolve] app_users 既存連携の照会で例外:', e instanceof Error ? e.message : e);
    return null;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
