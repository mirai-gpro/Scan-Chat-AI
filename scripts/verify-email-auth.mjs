#!/usr/bin/env node
/**
 * `npm run verify:email-auth` — **メール＋パスワード認証を足しても、
 * 既存の本人解決が 1 ミリも変わらない**ことの回帰チェック。
 *
 * 正本: `docs/operations/スペシャルアカウント_仕様書.md` §6.1（2026-10-05 追記）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【ここは静かに壊れる】
 * ══════════════════════════════════════════════════════════════════════
 *
 *   - 「Google Identity を持っている」と「今回 Google で認証した」を取り違えても、
 *     **Google ユーザーの画面は何も変わらない**。壊れるのは password セッションだけで、
 *     しかも**成功して見える**（`auth_user_id` が黙って張り替わるだけ）。
 *   - `google_sub` に Google 由来でない値が入っても、**エラーは出ない**。
 *     次に本物の Google で入ったときに UNIQUE で 500 になって初めて分かる。
 *   - signUp の文言が 1 つ変わるだけで **User Enumeration** になる。画面は正常に見える。
 *
 * だから目視では守れない。**実物を transpile して動かす**（`resolve.ts` の `POST` と
 * 判定ヘルパ）＋ **ソースを機械で読む**（禁止している実装が無いこと）。
 *
 * DB も dev サーバも鍵も要らない — Supabase は条件を記録するスタブに差し替える。
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
/** コメント行を落とす（経緯の説明に旧コードが書いてあるので、そこを拾わない）。 */
const code = (p) => read(p).split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');

const ts = (await import('typescript')).default;
mkdirSync(resolve(ROOT, 'node_modules/.cache'), { recursive: true });
const js = (src) => ts.transpileModule(src, { compilerOptions: { target: 'ES2022', module: 'ESNext' } }).outputText;
const load = async (src) => import('data:text/javascript;base64,' + Buffer.from(js(src), 'utf8').toString('base64'));

const fails = [];
const ok = (id, label, cond, why) => {
  if (!cond) fails.push(`${id} ${label}${why ? ` — ${why}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${id} ${label}${why && !cond ? `  → ${why}` : ''}`);
};
const eq = (id, label, got, want) =>
  ok(id, label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);

const UID_SPECIAL = '11111111-1111-4111-8111-111111111111';
const UID_CUST = '22222222-2222-4222-8222-222222222222';
const AUTH_GOOGLE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const AUTH_EMAIL = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const GOOGLE_SUB = '109876543210987654321';
const EMAIL = 'tester@example.com';

/* ══════════════════════════════════════════════════════════════════
   ① 判定ヘルパ（純関数）— 「持っている Identity」と「今回の方式」を分ける
   ══════════════════════════════════════════════════════════════════ */
console.log('\n① detectGoogleIdentity / authMethodFromAmr');

/** `resolve.ts` を相対 import 抜きで読み込む（スタブは globalThis 経由）。 */
async function loadResolve() {
  let src = read('src/pages/api/auth/resolve.ts');
  src = src.replace(/^import .*?;$/gms, (m) => (/from '\.\.\//.test(m) ? '' : m));
  src = `
const getServerSupabase = () => globalThis.__sb;
const isHpEdgeConfigured = () => globalThis.__edge === true;
const isHpEdgeStagingConfigured = () => globalThis.__staging === true;
const resolveCustomerWithAdmin = async (e) => globalThis.__customer?.(e) ?? null;
const resolveStagingCustomerByEmail = async (e) => globalThis.__stagingCustomer?.(e) ?? null;
const VIEWER_COOKIE = 'welltect_v';
const signViewer = async () => { globalThis.__signed = (globalThis.__signed ?? 0) + 1; return 'tok'; };
const viewerCookieOptions = () => ({ path: '/' });
const resolveViewer = async () => ({ uid: null, shared: false });
const denyForShare = () => null;
const isAdminEmailAsync = async () => globalThis.__admin === true;
const issueAdminCred = async () => { globalThis.__adminCred = (globalThis.__adminCred ?? 0) + 1; };
const linkDemoEmail = async () => { globalThis.__linkDemo = (globalThis.__linkDemo ?? 0) + 1; };
const resolveDemoUidByEmail = async (e, u) => globalThis.__demoUid?.(e, u) ?? null;
const linkSpecialEmail = async () => { globalThis.__linkSpecial = (globalThis.__linkSpecial ?? 0) + 1; };
const resolveSpecialUidByEmail = async (e, u) => globalThis.__specialUid?.(e, u) ?? null;
` + src;
  return load(src);
}
const R = await loadResolve();

{
  const G = R.detectGoogleIdentity;
  ok('I-01', 'app_metadata.provider=google → true', G({ app_metadata: { provider: 'google' } }) === true);
  ok('I-02', 'providers に google → true', G({ app_metadata: { providers: ['email', 'google'] } }) === true);
  ok('I-03', 'identities に google → true', G({ identities: [{ provider: 'google' }] }) === true);
  ok('I-04', 'email だけ → false', G({ app_metadata: { provider: 'email', providers: ['email'] }, identities: [{ provider: 'email' }] }) === false);
  ok('I-05', 'null でも落ちない', G(null) === false);

  const A = R.authMethodFromAmr;
  eq('A-01', "amr=[{method:'oauth'}] → oauth", A([{ method: 'oauth', timestamp: 1 }]), 'oauth');
  eq('A-02', "amr=[{method:'password'}] → password", A([{ method: 'password', timestamp: 1 }]), 'password');
  eq('A-03', "amr=[{method:'email/signup'}] → password", A([{ method: 'email/signup', timestamp: 1 }]), 'password');
  eq('A-04', 'RFC-8176 の文字列配列も受ける', A(['password']), 'password');
  eq('A-05', 'token_refresh は無視して元の方式を採る', A([{ method: 'oauth' }, { method: 'token_refresh' }]), 'oauth');
  eq('A-06', 'token_refresh だけ → unknown', A([{ method: 'token_refresh' }]), 'unknown');
  eq('A-07', 'magiclink → other (止めない)', A(['magiclink']), 'other');
  eq('A-08', 'amr 無し → unknown', A(undefined), 'unknown');
  eq('A-09', '空配列 → unknown', A([]), 'unknown');
  eq('A-10', 'oauth_provider/... も oauth', A([{ method: 'oauth_provider/authorization_code' }]), 'oauth');
  eq('A-11', '両方立ったら unknown (判らないものは止めない)', A(['oauth', 'password']), 'unknown');
}

/* ══════════════════════════════════════════════════════════════════
   ② resolve.ts を実際に動かす
   ══════════════════════════════════════════════════════════════════ */

/** `app_users` の 1 行だけを持つ最小スタブ。書き込みを全部記録する。 */
function makeSb(row = null) {
  const writes = [];
  const sb = {
    __writes: writes,
    __row: row,
    auth: {
      getUser: async () => ({ data: { user: globalThis.__user }, error: null }),
      // getClaims は「在る」側を既定にする（本番の auth-js 2.106 には在る）。
      getClaims: async () => (globalThis.__claims === undefined
        ? { data: null, error: new Error('no claims') }
        : { data: { claims: globalThis.__claims }, error: null }),
    },
    schema: () => ({
      from: (table) => {
        const st = { filters: {} };
        const api = {
          select() { return api; },
          eq(k, v) { st.filters[k] = v; return api; },
          // `resolveLocally()` の customer_profiles 引き (この検査では常に空振り)。
          ilike(k, v) { st.filters[k] = v; return api; },
          not() { return api; },
          or() { st.or = true; return api; },
          limit() { return api; },
          async maybeSingle() {
            // **`app_users` の照会だけ**落とす (他表まで落とすと別の 500 が先に出る)。
            if (globalThis.__selectFails && table === 'app_users' && !st.or) {
              return { data: null, error: { message: 'injected db error' } };
            }
            if (table !== 'app_users') return { data: null, error: null };
            const r = sb.__row;
            if (!r) return { data: null, error: null };
            // or() 経由（findLinkedUid）と eq 経由（ガード）の両方を受ける。
            if (st.or) return { data: globalThis.__linkedHit ? { diagnostic_user_id: r.diagnostic_user_id } : null, error: null };
            if (st.filters.diagnostic_user_id && st.filters.diagnostic_user_id !== r.diagnostic_user_id) {
              return { data: null, error: null };
            }
            return { data: { ...r }, error: null };
          },
          async update(values) { writes.push({ table, op: 'update', values, filters: { ...st.filters } }); return { data: null, error: null }; },
          async upsert(values) { writes.push({ table, op: 'upsert', values }); return { data: null, error: null }; },
        };
        return api;
      },
    }),
  };
  return sb;
}

/** `POST` を 1 回叩く。戻りは { status, body, writes, cookies, signed, adminCred }。 */
async function post(opts) {
  const {
    user, claims, row = null, specialUid = null, demoUid = null, customer = null,
    linkedHit = false, selectFails = false, admin = false,
  } = opts;
  globalThis.__user = user;
  globalThis.__claims = claims;            // undefined にすると getClaims が失敗する
  globalThis.__linkedHit = linkedHit;
  globalThis.__selectFails = selectFails;
  globalThis.__admin = admin;
  globalThis.__edge = !!customer;
  globalThis.__staging = false;
  globalThis.__customer = customer ? () => customer : null;
  globalThis.__specialUid = specialUid ? () => specialUid : () => null;
  globalThis.__demoUid = demoUid ? () => demoUid : () => null;
  globalThis.__signed = 0;
  globalThis.__adminCred = 0;
  globalThis.__linkSpecial = 0;
  globalThis.__linkDemo = 0;
  const sb = makeSb(row);
  globalThis.__sb = sb;
  const cookies = { set: () => { cookies.n = (cookies.n ?? 0) + 1; }, get: () => undefined, delete: () => {}, n: 0 };
  const res = await R.POST({
    request: new Request('http://x/api/auth/resolve', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: opts.token ?? 'h.e30.s' }),
    }),
    cookies,
  });
  const body = await res.json().catch(() => ({}));
  return {
    status: res.status, body, writes: sb.__writes, cookieSets: cookies.n,
    signed: globalThis.__signed, adminCred: globalThis.__adminCred,
    linkSpecial: globalThis.__linkSpecial, linkDemo: globalThis.__linkDemo,
  };
}

const googleUser = {
  id: AUTH_GOOGLE, email: EMAIL,
  app_metadata: { provider: 'google', providers: ['google'] },
  identities: [{ provider: 'google' }],
  user_metadata: { sub: GOOGLE_SUB },
};
const emailUser = {
  id: AUTH_EMAIL, email: EMAIL,
  app_metadata: { provider: 'email', providers: ['email'] },
  identities: [{ provider: 'email' }],
  user_metadata: { sub: AUTH_EMAIL },     // ★ email ユーザーの sub は自分の uuid
};
/** Google Identity を持つのに password で入ったセッション（テスト L）。 */
const googleIdentityPasswordUser = {
  id: AUTH_EMAIL, email: EMAIL,
  app_metadata: { provider: 'google', providers: ['google', 'email'] },
  identities: [{ provider: 'google' }, { provider: 'email' }],
  user_metadata: { sub: GOOGLE_SUB },
};
const AMR_OAUTH = { amr: [{ method: 'oauth', timestamp: 1 }] };
const AMR_PASSWORD = { amr: [{ method: 'password', timestamp: 1 }] };
const rowGoogle = { diagnostic_user_id: UID_SPECIAL, auth_user_id: AUTH_GOOGLE, google_sub: GOOGLE_SUB };

console.log('\n② A / C — 既存 Google ユーザーは従来どおり');
{
  const r = await post({ user: googleUser, claims: AMR_OAUTH, row: rowGoogle, specialUid: UID_SPECIAL, linkedHit: true });
  eq('A', 'Google ログインで linked:true / 同じ uid', [r.status, r.body.linked, r.body.diagnosticUserId], [200, true, UID_SPECIAL]);
  const up = r.writes.find((w) => w.op === 'upsert');
  eq('A-sub', '  google_sub は従来どおり書かれる', up?.values?.google_sub, GOOGLE_SUB);
  eq('A-auth', '  auth_user_id も従来どおり', up?.values?.auth_user_id, AUTH_GOOGLE);
  ok('C', '再ログインでも同じ uid（同じ入力なら同じ結果）', r.body.diagnosticUserId === UID_SPECIAL);
  ok('A-cookie', '  Cookie を発行している', r.cookieSets > 0 && r.signed > 0);
}

console.log('\n③ J — Google ユーザーの auth_user_id / google_sub が今回の変更で変わらない');
{
  // amr が取れない回（getClaims 失敗 & payload 復号も不可）でも、Google の挙動は不変。
  const r = await post({ user: googleUser, claims: undefined, row: rowGoogle, specialUid: UID_SPECIAL, linkedHit: true, token: 'not.a.jwt' });
  const up = r.writes.find((w) => w.op === 'upsert');
  eq('J-01', 'amr 不明でも google_sub を書く（従来どおり）', up?.values?.google_sub, GOOGLE_SUB);
  eq('J-02', '  auth_user_id も従来どおり', up?.values?.auth_user_id, AUTH_GOOGLE);
  eq('J-03', '  detach（張り替え）は走らない', r.writes.filter((w) => w.op === 'update').length, 0);
}

console.log('\n④ D / E / K — メール認証（special 登録済み・Google 未使用）');
{
  const r = await post({ user: emailUser, claims: AMR_PASSWORD, row: null, specialUid: UID_SPECIAL });
  eq('D-01', 'linked:true / special の uid', [r.status, r.body.linked, r.body.diagnosticUserId], [200, true, UID_SPECIAL]);
  eq('D-02', '  resolvedBy=special', r.body.resolvedBy, 'special');
  const up = r.writes.find((w) => w.op === 'upsert');
  eq('K-01', '  **google_sub を書かない**（Google 由来でない値を入れない）', up?.values?.google_sub, null);
  eq('K-02', '  auth_user_id はメールの auth user', up?.values?.auth_user_id, AUTH_EMAIL);
  ok('D-03', '  linkSpecialEmail を呼ぶ（uid を名簿へ写す）', r.linkSpecial === 1);
  ok('E', '  2 回目も同じ uid（same in → same out）', (await post({ user: emailUser, claims: AMR_PASSWORD, row: { diagnostic_user_id: UID_SPECIAL, auth_user_id: AUTH_EMAIL, google_sub: null }, specialUid: UID_SPECIAL, linkedHit: true })).body.diagnosticUserId === UID_SPECIAL);
}

console.log('\n⑤ L — Google Identity を持つ password セッションを Google と誤判定しない');
{
  const r = await post({ user: googleIdentityPasswordUser, claims: AMR_PASSWORD, row: rowGoogle, specialUid: UID_SPECIAL });
  eq('L-01', '**409 で拒否する**', r.status, 409);
  ok('L-02', '  文言に認証方式の案内が入る', typeof r.body.error === 'string' && r.body.error.includes('ログイン方法'));
  eq('L-03', '  **app_users への書き込み 0 件**', r.writes.length, 0);
  eq('L-04', '  **Cookie 発行 0**', [r.cookieSets, r.signed], [0, 0]);
  eq('L-05', '  admin credential も発行しない', r.adminCred, 0);
  eq('L-06', '  linkSpecialEmail / linkDemoEmail も呼ばない', [r.linkSpecial, r.linkDemo], [0, 0]);
  // ★ ここが肝: hasGoogleIdentity=true でも currentAuthMethod は password
  ok('L-07', '  hasGoogleIdentity は true（前提の確認）', R.detectGoogleIdentity(googleIdentityPasswordUser) === true);
  eq('L-08', '  currentAuthMethod は password（Identity と混同しない）', R.authMethodFromAmr(AMR_PASSWORD.amr), 'password');
}

console.log('\n⑥ B — Google 利用済み uid への password セッション（別 auth user）');
{
  const r = await post({ user: emailUser, claims: AMR_PASSWORD, row: rowGoogle, specialUid: UID_SPECIAL });
  eq('B-01', '**409 で拒否**', r.status, 409);
  eq('B-02', '  **書き込み 0 件**（auth_user_id / google_sub を張り替えない）', r.writes.length, 0);
  eq('B-03', '  Cookie 発行 0', [r.cookieSets, r.signed], [0, 0]);

  // 同じ auth user（Supabase が identity を link した形）は 3 条件を満たさないので通す。
  const same = await post({
    user: { ...emailUser, id: AUTH_GOOGLE }, claims: AMR_PASSWORD,
    row: rowGoogle, specialUid: UID_SPECIAL, linkedHit: true,
  });
  eq('B-04', '  auth_user_id が同じなら張り替えにならないので通す（指示 3 の 3 条件）', same.status, 200);

  // google_sub が無い（メール認証だけで使ってきた）uid には password で入れる＝逆方向は禁じない。
  const noGoogle = await post({
    user: emailUser, claims: AMR_PASSWORD,
    row: { diagnostic_user_id: UID_SPECIAL, auth_user_id: 'cccccccc-3333-4333-8333-cccccccccccc', google_sub: null },
    specialUid: UID_SPECIAL,
  });
  eq('B-05', '  google_sub が無ければ拒否しない', noGoogle.status, 200);
}

console.log('\n⑦ ガードの fail-closed（照会が落ちたら何も書かない）');
{
  const r = await post({ user: emailUser, claims: AMR_PASSWORD, row: rowGoogle, specialUid: UID_SPECIAL, selectFails: true });
  eq('G-01', '照会に失敗したら 503', r.status, 503);
  eq('G-02', '  書き込み 0 件', r.writes.length, 0);
  eq('G-03', '  Cookie 発行 0', [r.cookieSets, r.signed], [0, 0]);
}

console.log('\n⑧ F / G / I — 回帰（demo / 通常 customer / special が demo へ落ちない）');
{
  const cust = await post({
    user: googleUser, claims: AMR_OAUTH, row: null,
    customer: { customer: { diagnostic_user_id: UID_CUST, display_name: '山田' }, isAdmin: false },
  });
  eq('G-01r', '通常 customer は従来どおり production で解決', [cust.body.linked, cust.body.resolvedBy], [true, 'production']);
  eq('G-02r', '  表示名の規約（姓+様）も不変', cust.writes.find((w) => w.op === 'upsert')?.values?.display_name_cache, '山田様');

  const demo = await post({ user: googleUser, claims: AMR_OAUTH, demoUid: UID_CUST });
  eq('F-01', 'demo は従来どおり解決される', [demo.body.linked, demo.body.resolvedBy], [true, 'demo']);
  ok('F-02', '  linkDemoEmail を呼ぶ', demo.linkDemo === 1);

  const both = await post({ user: googleUser, claims: AMR_OAUTH, specialUid: UID_SPECIAL, demoUid: UID_CUST });
  eq('I-01', '**special が demo より先**（両方登録でも実データ側）', both.body.resolvedBy, 'special');

  const none = await post({ user: googleUser, claims: AMR_OAUTH });
  eq('U-01', 'どれでも無ければ従来どおり linked:false', [none.status, none.body.linked], [200, false]);
}

console.log('\n⑨ H — admin credential は従来どおり（uid が無くても発行）');
{
  const r = await post({ user: googleUser, claims: AMR_OAUTH, admin: true });
  eq('H-01', 'uid が無くても admin:true を返す', [r.body.linked, r.body.admin], [false, true]);
  ok('H-02', '  issueAdminCred を呼んでいる', r.adminCred === 1);
}

/* ══════════════════════════════════════════════════════════════════
   ⑩ ソースの番人（禁止している実装が無いこと）
   ══════════════════════════════════════════════════════════════════ */
console.log('\n⑩ 禁止事項の番人');
{
  const srcAll = ['src/components/EmailPasswordAuth.astro', 'src/components/SignInPanel.astro',
    'src/components/GoogleOneTap.astro', 'src/pages/api/auth/resolve.ts'].map(code).join('\n');
  ok('S-01', '**updateUser( を実装していない**（Google アカウントへの password 追加を作らない）',
    !/updateUser\s*\(/.test(srcAll));
  ok('S-02', '**既存アカウントの存在を示す文言が無い**（User Enumeration）',
    !/(既に登録|すでに登録|already\s*registered|Google で登録|Googleで登録)/.test(code('src/components/EmailPasswordAuth.astro')));
  ok('S-03', 'signUp のエラーで error.message を画面へ出していない',
    !/notify\(\{[^}]*error\.message/.test(code('src/components/EmailPasswordAuth.astro')));
  ok('S-04', 'メール認証専用の本人解決 API を作っていない',
    code('src/components/EmailPasswordAuth.astro').includes("'/api/auth/resolve'"));
  ok('S-05', '新規登録後の文言が合意どおり',
    read('src/components/EmailPasswordAuth.astro').includes(
      '確認メールを送信しました。メールが届かない場合は、以前利用したログイン方法もお試しください。'));

  const rs = code('src/pages/api/auth/resolve.ts');
  const order = ['production', 'staging', 'special', 'demo'].map((k) => rs.indexOf(`resolvedFrom = '${k}'`));
  ok('S-06', '**本人解決の順序を変えていない** (production → staging → special → demo)',
    order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2] && order[2] < order[3],
    JSON.stringify(order));
  for (const fn of ['findLinkedUid', 'resolveSpecialUidByEmail', 'linkSpecialEmail']) {
    ok(`S-07:${fn}`, `  ${fn} をそのまま使っている（再設計していない）`, rs.includes(`${fn}(`));
  }
  ok('S-08', '**ガードは upsert / detach / issueAdminCred より前**',
    rs.indexOf("}, 409)") < rs.indexOf('issueAdminCred(')
    && rs.indexOf("}, 409)") < rs.indexOf('.upsert('),
    `409=${rs.indexOf('}, 409)')} adminCred=${rs.indexOf('issueAdminCred(')} upsert=${rs.indexOf('.upsert(')}`);
  ok('S-09', '**判定に user_metadata を使っていない**（書き換え可能なため）',
    !/user_metadata[^\n]*provider|provider[^\n]*user_metadata/.test(rs));
  ok('S-10', 'getClaims を優先している', rs.includes('getClaims'));
  ok('S-11', '新しい依存を足していない',
    !/from '(?!\.|@supabase\/supabase-js|astro)/.test(code('src/components/EmailPasswordAuth.astro')));
  ok('S-12', 'Google 専用文言を一般化した（no email in Google account が残っていない）',
    !rs.includes('no email in Google account'));

  /*
   * **画面の器 (`SignInPanel.astro`) の契約。**
   * ここは `PUBLIC_GOOGLE_CLIENT_ID` が無い環境ではブラウザで描かれないので、
   * `verify:screen` の ⑥ は飛ばされることがある。**A 層で必ず見る。**
   */
  const panel = read('src/components/SignInPanel.astro');
  for (const id of ['signin-email-login-form', 'signin-email-signup-form',
    'signin-login-email', 'signin-login-password', 'signin-signup-email', 'signin-signup-password',
    'gsi-button']) {
    ok(`S-13:${id}`, `  器 #${id} が在る`, panel.includes(`id="${id}"`));
  }
  ok('S-14', '  パスワード欄は minlength=8 / type=password',
    /id="signin-login-password"[\s\S]{0,300}?minlength="8"/.test(panel)
    && /id="signin-signup-password"[\s\S]{0,300}?minlength="8"/.test(panel));
  ok('S-15', '  autocomplete を付けている (current-password / new-password)',
    panel.includes('autocomplete="current-password"') && panel.includes('autocomplete="new-password"'));
  ok('S-16', '  入力欄は text-base (16px 下限・iOS の自動ズーム対策)',
    (panel.match(/type="(email|password)"[\s\S]{0,400}?text-base/g) ?? []).length >= 4);
  ok('S-17', '  **メールのフォームを `#signin-ready` の中に入れていない** (Google の失敗で消えない)',
    panel.indexOf('id="signin-email-login"') > panel.indexOf('id="signin-error"'));
  ok('S-18', '  説明文から Google 固有の表現を外した',
    !/ご登録の Google アカウント/.test(panel));
}

/* ── 結果 ──────────────────────────────────────────────────────── */
console.log(`\n${'='.repeat(60)}`);
if (fails.length) {
  console.log(`✗ ${fails.length} 件 FAIL`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✓ すべて PASS — メール認証を足しても既存の本人解決は変わっていません。');
