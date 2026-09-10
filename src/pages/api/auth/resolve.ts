import type { APIRoute } from 'astro';
import { getServerSupabase } from '../../../lib/supabase';
import {
  isHpEdgeConfigured,
  isHpEdgeStagingConfigured,
  resolveCustomerWithAdmin,
  resolveStagingCustomerByEmail,
} from '../../../lib/hp-edge';
import { VIEWER_COOKIE, signViewer, viewerCookieOptions } from '../../../lib/viewer';
import { isAdminEmailAsync } from '../../../lib/admin-auth';
import { linkDemoEmail, resolveDemoUidByEmail } from '../../../lib/demo-accounts';

export const prerender = false;

/**
 * Google One Tap サインイン後の本人解決 (サーバー側)。
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
export const POST: APIRoute = async ({ request, cookies }) => {
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
  const sub = (user.user_metadata as Record<string, string> | undefined)?.sub ?? null;
  const authId = user.id;
  if (!email) return json({ error: 'no email in Google account' }, 400);

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
  let resolvedFrom: 'production' | 'staging' | 'local' | 'demo' | null = null;

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
  if (!diagnosticUserId) {
    diagnosticUserId = await resolveDemoUidByEmail(email, linkedUid);
    if (diagnosticUserId) resolvedFrom = 'demo';
  }

  // 未連携 (適格性なし)
  if (!diagnosticUserId) return json({ linked: false }, 200);

  /*
   * **束縛の張り替え。** ここまで来て `linkedUid` と食い違う場合:
   *   ・デモ発行の uid   → **既存の uid を採る**(勝手に新しい人格を作らない)
   *   ・顧客DB由来の uid → **顧客DBが正**。古い行から認証の束縛だけ外して張り直す
   *                        (**行は消さない**。検査データはその uid のまま残る)
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

  const token = await signViewer(diagnosticUserId, isAdmin || await isAdminEmailAsync(email));
  if (token) cookies.set(VIEWER_COOKIE, token, viewerCookieOptions());

  // `resolvedBy` は切り分け用 (PII 非含有)。**staging 由来かどうかがここで分かる**。
  return json({ linked: true, diagnosticUserId, resolvedBy: resolvedFrom }, 200);
};

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
