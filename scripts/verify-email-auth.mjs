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

import { readFileSync, mkdirSync, readdirSync } from 'node:fs';
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
const specialPreassignedUidByEmail = async (e) => globalThis.__preassigned?.(e) ?? null;
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
          /*
           * `update()` は **`.eq()` を繋げてから await される** (detach 経路)。
           * 直接 await される形も在り得るので、**記録はここで 1 回だけ**行い、
           * `.eq()` はフィルタを足して解決するだけにする (二重記録を作らない)。
           */
          update(values) {
            const rec = { table, op: 'update', values, filters: { ...st.filters } };
            writes.push(rec);
            const done = Promise.resolve({ data: null, error: null });
            return {
              eq(k, v) { rec.filters[k] = v; return done; },
              then(...a) { return done.then(...a); },
            };
          },
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
  globalThis.__preassigned = opts.preassigned ? () => opts.preassigned : () => null;
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

console.log('\n⑥ B — Google 利用済み uid への password セッション（auth_user_id は条件にしない）');
{
  /*
   * **拒否条件は `google_sub` の有無だけ**（2026-10-05 実コードレビューで是正）。
   * 禁じているのは「Google 利用済みの人がメール＋パスワード認証を使うこと自体」であって、
   * 「認証 ID が張り替わること」ではない。`auth_user_id` を条件に混ぜると取り逃す:
   *   - 本番 `diagnosis.app_users` 実測: `google_sub` あり 24 件のうち
   *     **`auth_user_id` NULL が 13 件** → 拒否できない
   *   - 同じ auth user に後からパスワードを付けた回も一致するので素通りする
   */

  // B-01〜03: 別 auth user で来た password セッション
  const r = await post({ user: emailUser, claims: AMR_PASSWORD, row: rowGoogle, specialUid: UID_SPECIAL });
  eq('B-01', '**409 で拒否**（別 auth user）', r.status, 409);
  eq('B-02', '  **書き込み 0 件**（auth_user_id / google_sub を張り替えない）', r.writes.length, 0);
  eq('B-03', '  Cookie 発行 0', [r.cookieSets, r.signed], [0, 0]);

  /*
   * B-04 **`auth_user_id` が今回と同じでも 409**。
   * 旧版はここを 200 で通していたが、それは仕様違反だった
   * （同じ auth user にパスワードを足した人が素通りする）。
   */
  const same = await post({
    user: { ...emailUser, id: AUTH_GOOGLE }, claims: AMR_PASSWORD,
    row: rowGoogle, specialUid: UID_SPECIAL, linkedHit: true,
  });
  eq('B-04', '  **auth_user_id が同じでも 409**（張り替えの有無を条件にしない）', same.status, 409);
  eq('B-04w', '    書き込み 0 件', same.writes.length, 0);
  eq('B-04c', '    Cookie 発行 0', [same.cookieSets, same.signed], [0, 0]);
  eq('B-04a', '    admin credential も発行しない', same.adminCred, 0);
  eq('B-04l', '    linkSpecialEmail / linkDemoEmail も呼ばない', [same.linkSpecial, same.linkDemo], [0, 0]);

  /*
   * B-05 **`auth_user_id` が NULL でも 409**。
   * 本番に 13 件実在する形（`google_sub` あり / `auth_user_id` NULL）。
   * ここを取り逃すと「Google 利用済みなのに password で入れる」人が 13 件残る。
   */
  const nullAuth = await post({
    user: emailUser, claims: AMR_PASSWORD,
    row: { diagnostic_user_id: UID_SPECIAL, auth_user_id: null, google_sub: GOOGLE_SUB },
    specialUid: UID_SPECIAL,
  });
  eq('B-05', '  **auth_user_id が NULL でも 409**（本番 13 件の形）', nullAuth.status, 409);
  eq('B-05w', '    書き込み 0 件', nullAuth.writes.length, 0);
  eq('B-05c', '    Cookie 発行 0', [nullAuth.cookieSets, nullAuth.signed], [0, 0]);
  eq('B-05a', '    admin credential も発行しない', nullAuth.adminCred, 0);
  eq('B-05l', '    linkSpecialEmail / linkDemoEmail も呼ばない', [nullAuth.linkSpecial, nullAuth.linkDemo], [0, 0]);

  // B-06: google_sub が無い（メール認証だけで使ってきた）uid には password で入れる＝逆方向は禁じない。
  const noGoogle = await post({
    user: emailUser, claims: AMR_PASSWORD,
    row: { diagnostic_user_id: UID_SPECIAL, auth_user_id: 'cccccccc-3333-4333-8333-cccccccccccc', google_sub: null },
    specialUid: UID_SPECIAL,
  });
  eq('B-06', '  **google_sub が無ければ拒否しない**（メール → 後から Google は禁じない）', noGoogle.status, 200);
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

/* ══════════════════════════════════════════════════════════════════
   ⑪ HP マイページからの初回導線 (`?entry=wellfort-mypage`)
   ══════════════════════════════════════════════════════════════════

   【ここは静かに壊れる】
     - `entry` を取り落としても画面は正常に出る。従来どおり「サインイン」が
       先に出るだけで、**初回利用者が HP のメール＋パスワードを入れて
       `Invalid login credentials` になる**ところしか壊れない。それは
       こちらのログに何も残らない (実測 2026-10-05)。
     - 逆に `entry` を本人確認に使ってしまっても、**正常に見える**。
       誰でも付けられるクエリなので、`resolve` を省略したら認証が無くなる。
     - 「このメールは登録済みか」を事前に聞く口を足しても画面は親切になるだけ。
       **User Enumeration** は目に見えない。
   ══════════════════════════════════════════════════════════════════ */
console.log('\n⑪ B / C / D / E / F — HP マイページからの初回導線');
{
  const panelRaw = read('src/components/SignInPanel.astro');
  const panelCode = code('src/components/SignInPanel.astro');
  /** frontmatter (--- … ---) と markup を分ける。 */
  const strip = (t) => t.split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');
  /** frontmatter と markup を分け、**どちらもコメントを落として**から見る
      (経緯の説明に「やらないこと」を書いてあるので、そこを拾わない)。 */
  const fm = strip(panelRaw.slice(panelRaw.indexOf('---') + 3, panelRaw.indexOf('\n---', 3)));
  const markup = strip(panelRaw.slice(panelRaw.indexOf('\n---', 3) + 4)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ''));

  /* ── B. HP マイページ経由 ─────────────────────────────────────── */

  /*
   * **判定は完全一致**。前方一致や「entry が在れば」にすると、想定外の値で
   * 画面が変わる (= 誰が何を見ているのか追えなくなる)。
   */
  ok('M-01', '`entry` の判定は **`=== \'wellfort-mypage\'` の完全一致**',
    /searchParams\.get\(\s*['"]entry['"]\s*\)\s*===\s*['"]wellfort-mypage['"]/.test(fm),
    'startsWith / includes / 真偽だけ などになっている');
  ok('M-02', '  `entry` を読むのは `Astro.url` から 1 か所だけ',
    (panelCode.match(/searchParams\.get\(\s*['"]entry['"]\s*\)/g) ?? []).length === 1);

  /*
   * **初期表示はサーバ側で決める** (`hidden` 属性)。JS で切り替えると、
   * JS が落ちた環境で「サインイン」が先に出たままになる。
   */
  const loginSec  = markup.match(/<section id="signin-email-login"[^>]*>/)?.[0] ?? '';
  const signupSec = markup.match(/<section id="signin-email-signup"[^>]*>/)?.[0] ?? '';
  ok('M-03', '**signup が初期表示** (`hidden={!fromMypage}`)',
    /hidden=\{\s*!\s*fromMypage\s*\}/.test(signupSec), signupSec);
  ok('M-04', '**login は初期非表示** (`hidden={fromMypage}`)',
    /hidden=\{\s*fromMypage\s*\}/.test(loginSec), loginSec);
  ok('M-05', '  2 つの `hidden` が取り違えられていない (同じ式でない)',
    /hidden=\{\s*fromMypage\s*\}/.test(loginSec) && !/hidden=\{\s*fromMypage\s*\}/.test(signupSec));

  /*
   * **ログインへ戻る出口が必ず残る。** 片道にすると、登録済みの人が
   * もう一度 signUp して「確認メールを送信しました」で止まる。
   */
  ok('M-06', '**ログインへ戻る導線が signup の中に在る** (片道にしない)',
    markup.indexOf('id="signin-show-login"') > markup.indexOf('id="signin-email-signup"')
    && markup.includes('id="signin-show-login"'));
  ok('M-07', '  signup へ行く導線も残っている (login 側)',
    markup.includes('id="signin-show-signup"'));
  ok('M-08', '  切替は `hidden` の付け外しだけ (要素を消さない)',
    /loginSec\.hidden\s*=/.test(panelCode) && /signupSec\.hidden\s*=/.test(panelCode));

  /*
   * **「新規サインイン」という語を作らない** (発注者指示 2026-10-05)。
   * 初回=新規登録 / 登録済み=ログイン の 2 語で通す。
   */
  ok('M-09', '**「新規サインイン」という概念を作っていない**', !/新規サインイン/.test(fm + markup));
  ok('M-10', '  entry のときの見出しが「サインイン」から変わる',
    /fromMypage\s*\?\s*'[^']+'\s*:\s*'サインイン'/.test(fm));
  ok('M-11', '  entry のときに「初回のみ」登録が要ることを言っている',
    /初回/.test(fm) && /登録/.test(fm));

  /* **Google は entry でも消えない。** 入口を 1 つに減らさない。 */
  ok('M-12', '**Google の器 (`#gsi-button`) は entry の条件に入っていない**',
    markup.includes('id="gsi-button"')
    && !/fromMypage[\s\S]{0,200}?id="gsi-button"/.test(markup));
  ok('M-13', '  Google の 3 状態 (loading / ready / error) も条件に入っていない',
    ['signin-loading', 'signin-ready', 'signin-error'].every((id) =>
      new RegExp(`id="${id}"[^>]*>`).test(markup)
      && !new RegExp(`id="${id}"[^>]*fromMypage`).test(markup)));

  /* ── C. 通常アクセス (entry 無し) ─────────────────────────────── */

  /*
   * `?entry=` が無いときは**従来どおり**。`hidden={fromMypage}` /
   * `hidden={!fromMypage}` の 2 行で機械的に決まるので、ここは
   * **既定値が false 側に倒れること**を式から読む。
   */
  /*
   * **実物の式を取り出して動かす。** 自分で書き写した式を試すと、
   * 実装が `startsWith` に変わっても検査だけが通る (= 無意味になる)。
   */
  const expr = fm.match(/const fromMypage\s*=\s*([^;]+);/)?.[1] ?? '';
  ok('M-14a', '  `fromMypage` の式を実物から取り出せた', !!expr.trim(), JSON.stringify(expr));
  const evalExpr = new Function('search',
    `const Astro = { url: new URL('https://example.test/dashboard' + search) };
     return !!(${expr || 'undefined'});`);
  /** 式が throw したら**落ちたことを名指しで出す** (スクリプトごと死なせない)。 */
  const fromMypageOf = (search) => {
    try { return evalExpr(search); } catch (e) { return `THREW: ${e.message}`; }
  };
  eq('M-14', '通常アクセス (クエリ無し) → fromMypage = false', fromMypageOf(''), false);
  eq('M-15', '別の値 (?entry=other) → false (想定外の値で画面が変わらない)',
    fromMypageOf('?entry=other'), false);
  eq('M-16', '前方一致でも false (?entry=wellfort-mypage-x)',
    fromMypageOf('?entry=wellfort-mypage-x'), false);
  eq('M-17', 'admin 代理表示 (?u=…) だけでは false', fromMypageOf('?u=' + UID_CUST), false);
  eq('M-18', 'HP マイページ経由 → true', fromMypageOf('?entry=wellfort-mypage'), true);
  eq('M-19', '他のクエリと併記でも true', fromMypageOf('?entry=wellfort-mypage&x=1'), true);

  /*
   * **`/` は `url.search` を保ったまま `/dashboard` へ 302 する。**
   * ここが落ちると `https://…/?entry=wellfort-mypage` でクエリが消え、
   * **リンクは普通に開くのに onboarding だけが効かない**。
   */
  const idx = code('src/pages/index.astro');
  ok('M-20', '**`/` の 302 がクエリを保っている** (`url.search`)',
    /\/dashboard\$\{url\.search\}/.test(idx) || /'\/dashboard'\s*\+\s*url\.search/.test(idx), idx);

  /* ── D. 認証処理は 1 行も変えていない ───────────────────────── */
  const epa = code('src/components/EmailPasswordAuth.astro');
  ok('M-21', '新規登録は `sb.auth.signUp(` のまま', /sb\.auth\.signUp\(/.test(epa));
  ok('M-22', 'ログインは `sb.auth.signInWithPassword(` のまま', /sb\.auth\.signInWithPassword\(/.test(epa));
  ok('M-23', '**`updateUser(` を足していない**', !/updateUser\s*\(/.test(epa));
  ok('M-24', '**認証部品は `entry` を見ていない** (表示の話を認証へ持ち込まない)',
    !/entry/.test(epa));

  /* ── E. 認証後は従来どおり `/api/auth/resolve` を通る ─────────── */
  ok('M-25', '**認証成功後は `POST /api/auth/resolve`** (省略していない)',
    epa.includes("'/api/auth/resolve'") && /method:\s*'POST'/.test(epa));
  const rs2 = code('src/pages/api/auth/resolve.ts');
  ok('M-26', '**`resolve` は `entry` を一切見ない** (本人確認に使わない)', !/entry/.test(rs2));
  ok('M-27', '  `resolve` は `getUser()` でサーバ検証を続けている', /getUser\(/.test(rs2));
  ok('M-28', '  `entry` をサーバへ送っていない (body / header に載せない)',
    !/entry/.test(epa) && !/entry/.test(code('src/components/GoogleOneTap.astro')));

  /* ── F. メール存在の事前照会 API を作っていない ───────────────── */
  const apiDir = resolve(ROOT, 'src/pages/api');
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(resolve(d, e.name)) : [resolve(d, e.name)]);
  const apis = walk(apiDir);
  const suspicious = apis.filter((f) => /(check|exists|lookup|probe|has)[-_]?(email|user|account)|email[-_]?(check|exists|lookup)/i.test(f));
  eq('M-29', '**メール存在を照会する API ファイルが無い**', suspicious.map((f) => f.slice(ROOT.length + 1)), []);
  ok('M-30', '  画面からそういう口を叩いていない',
    !/fetch\([^)]*(check-email|email-exists|user-exists|account-exists)/.test(panelCode + epa));
  ok('M-31', '  画面に「登録済み / 未登録」を言い分ける分岐が無い',
    !/(既に登録|すでに登録|未登録|登録されていません|not registered|already registered)/.test(fm + markup));
  ok('M-32', '  **初回かどうかは利用者に選ばせている** (2 つの入口が在る)',
    markup.includes('id="signin-email-login"') && markup.includes('id="signin-email-signup"'));
}

/* ══════════════════════════════════════════════════════════════════
   ⑫ 事前発行した special uid を黙って張り替えない (2026-10-05 仕様変更)
   ══════════════════════════════════════════════════════════════════

   スペシャル枠は**メール登録のその場で uid を発行し、本人のログイン前に
   健診・遺伝子・報告書を投入する**ようになった。したがって

       special 登録時 UID-A → UID-A に実データ投入 → 本人サインイン
       → 既存 linkedUid = UID-B → 黙って UID-B に切り替える

   は**絶対に禁止**。やると **UID-A の健康データと本人の認証が分離する**
   (本人は自分のデータを見られず、UID-A のデータは誰にも結び付かない)。

   【ここは静かに壊れる】張り替えは**成功して見える** — サインインは通り、
   ダッシュボードが開き、ただ中身が空になるだけ。利用者は「データがまだ来ていない」と
   思うだけで、こちらのログにも異常は出ない。だから目視では守れない。
   ══════════════════════════════════════════════════════════════════ */
console.log('\n⑫ 事前発行 special uid の保護 (9〜13)');
{
  const PRE = '33333333-3333-4333-8333-333333333333';   // 事前発行 (UID-A)
  const OTHER = '44444444-4444-4444-8444-444444444444'; // 既存の束縛 (UID-B)

  /* ── 9 / 10. linkedUid が無い初回 → 事前発行 uid をそのまま使う ── */
  {
    const r = await post({
      user: emailUser, claims: AMR_PASSWORD,
      specialUid: PRE, preassigned: PRE, row: null, linkedHit: false,
    });
    eq('P-09', '初回 Auth resolve で事前発行 uid をそのまま使う',
      [r.status, r.body.linked, r.body.diagnosticUserId], [200, true, PRE]);
    eq('P-10', '  linkedUid=null でも別 uid を作らない',
      r.writes.find((w) => w.op === 'upsert')?.values?.diagnostic_user_id, PRE);
    eq('P-09b', '  Cookie を発行して通す', r.cookieSets >= 1, true);
  }

  /* ── 11. linkedUid === 事前発行 uid → 正常 ── */
  {
    const r = await post({
      user: emailUser, claims: AMR_PASSWORD,
      specialUid: PRE, preassigned: PRE,
      row: { diagnostic_user_id: PRE, auth_user_id: AUTH_EMAIL, google_sub: null },
      linkedHit: true,
    });
    eq('P-11', 'linkedUid が事前発行 uid と同じ → そのまま通る',
      [r.status, r.body.diagnosticUserId], [200, PRE]);
    eq('P-11b', '  張り替え (detach) をしていない',
      r.writes.filter((w) => w.op === 'update').length, 0);
  }

  /* ── 12 / 13. linkedUid !== 事前発行 uid → 何も書かずに 409 ── */
  {
    const r = await post({
      user: emailUser, claims: AMR_PASSWORD,
      specialUid: PRE, preassigned: PRE,
      row: { diagnostic_user_id: OTHER, auth_user_id: AUTH_EMAIL, google_sub: null },
      linkedHit: true,
    });
    eq('P-12', '**競合は 409 で止める** (A→B / B→A のどちらにも張り替えない)', r.status, 409);
    ok('P-12b', '  利用者向けの文言で返す (生の DB エラー・内部情報を出さない)',
      typeof r.body.error === 'string' && !/duplicate|constraint|column|relation/i.test(r.body.error),
      JSON.stringify(r.body));
    eq('P-13', '  **app_users を 1 行も書き換えない** (upsert / detach とも 0)',
      r.writes.length, 0);
    eq('P-13b', '  special の名簿にも触らない (linkSpecialEmail を呼ばない)', r.linkSpecial, 0);
    eq('P-13c', '  デモの名簿にも触らない', r.linkDemo, 0);
    eq('P-13d', '  viewer Cookie を 1 枚も発行しない', r.cookieSets, 0);
    ok('P-13e', '  応答に別 uid を載せない (張り替え先を漏らさない)',
      r.body.diagnosticUserId === undefined, JSON.stringify(r.body));
  }

  /* ── 12'. Google セッションでも同じ (方式に依存しない) ── */
  {
    const r = await post({
      user: googleUser, claims: AMR_OAUTH,
      specialUid: PRE, preassigned: PRE,
      row: { diagnostic_user_id: OTHER, auth_user_id: AUTH_GOOGLE, google_sub: GOOGLE_SUB },
      linkedHit: true,
    });
    eq('P-12g', "Google セッションでも競合は 409 (認証方式に依存しない)", r.status, 409);
    eq('P-13g', '  こちらでも書き込み 0 件', r.writes.length, 0);
  }

  /* ── 14. デモ枠は従来どおり (special を優先する既存順序を壊していない) ── */
  {
    const r = await post({
      user: emailUser, claims: AMR_PASSWORD,
      demoUid: PRE, preassigned: null, // demo 由来 = 事前発行ではない
      row: { diagnostic_user_id: OTHER, auth_user_id: AUTH_EMAIL, google_sub: null },
      linkedHit: true,
    });
    eq('P-14', 'デモ由来の uid は従来どおり既存 uid へ寄せる (409 にしない)',
      [r.status, r.body.diagnosticUserId], [200, OTHER]);
  }

  /* ── 14'. 事前発行でない special (legacy uid 空 → linkedUid へ落ちた回) も従来どおり ── */
  {
    const r = await post({
      user: emailUser, claims: AMR_PASSWORD,
      specialUid: OTHER, preassigned: null, // 記録が無い = legacy 行
      row: { diagnostic_user_id: OTHER, auth_user_id: AUTH_EMAIL, google_sub: null },
      linkedHit: true,
    });
    eq("P-14b", 'legacy 行 (事前発行なし) は従来どおり通る',
      [r.status, r.body.diagnosticUserId], [200, OTHER]);
  }

  /* ── 15. 通常顧客は退行なし (顧客DB由来は従来どおり張り替える) ── */
  {
    const r = await post({
      user: googleUser, claims: AMR_OAUTH,
      customer: { customer: { diagnostic_user_id: UID_CUST, display_name: '顧客' }, isAdmin: false },
      preassigned: PRE, // special の記録が在っても顧客DBが勝つ (ガードを誤発火させない)
      row: { diagnostic_user_id: OTHER, auth_user_id: AUTH_GOOGLE, google_sub: GOOGLE_SUB },
      linkedHit: true,
    });
    eq('P-15', '通常顧客は従来どおり顧客DBの uid が勝つ (409 にしない)',
      [r.status, r.body.diagnosticUserId], [200, UID_CUST]);
    ok('P-15b', '  旧束縛の detach も従来どおり走る',
      r.writes.some((w) => w.op === 'update' && w.values?.auth_user_id === null));
  }

  /* ── 16. メールの現物をログ・応答へ出していない ── */
  {
    const r = read('src/lib/special-accounts.ts') + read('src/pages/api/admin/special-accounts.ts');
    ok('P-16', 'メールの現物をログへ出していない',
      !/console\.(log|warn|error)\([^)]*\b(addr|email)\b[^)]*\)/.test(r),
      'app_config に残すのは hash + mask だけ、という既存方針を守る');
  }
}

/* ── 結果 ──────────────────────────────────────────────────────── */
console.log(`\n${'='.repeat(60)}`);
if (fails.length) {
  console.log(`✗ ${fails.length} 件 FAIL`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✓ すべて PASS — メール認証を足しても既存の本人解決は変わっていません。');
