#!/usr/bin/env node
/**
 * `npm run verify:experience-accounts` — **canonical `diagnostic_user_id` の回帰チェック**。
 *
 * 正本: `docs/specs/special_demo_integration_spec_20261022.md` (PR-B)。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【守るもの】**1 人につき `diagnostic_user_id` は 1 つ**
 * ══════════════════════════════════════════════════════════════════════
 *
 * 壊れていた経路 (実測):
 *   R2 … Demo に登録済みの人を Special へ足すと、admin API が **Demo のメール行を
 *        1 度も見ずに** `mintSpecialUid()` で新しい uid を採番していた
 *   R3 … 次のサインインで事前発行 uid ガードが食い違いを検出し **409 (書き込み 0)**
 *        = **本人がログインできなくなる**
 *
 * **ここは静かに壊れる** — 画面上はどちらの名簿も「登録済み」に見え、uid が
 * 分裂していることは本人がログインできなくなって初めて分かる。目視では守れない。
 *
 * だから「そう書いてあるか」で済ませず、**実物を transpile して動かす**
 * (canonical 層・`resolve.ts` が呼ぶ経路・admin API の POST)。
 */

import { readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
/** コメント行を落とす (経緯の説明に旧コードが書いてあるので、そこを拾わない)。 */
const code = (p) => read(p).split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');

const fails = [];
const ts = (await import('typescript')).default;
mkdirSync(resolve(ROOT, 'node_modules/.cache'), { recursive: true });

const eq = (label, got, want) => {
  const okk = JSON.stringify(got) === JSON.stringify(want);
  if (!okk) fails.push(`${label} — got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
  console.log(`  ${okk ? '✓' : '✗'} ${label}`);
};
const ok = (label, cond, why) => {
  if (!cond) fails.push(`${label}${why ? ` — ${why}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
};

/**
 * **実物の TS モジュールを動かす。** CommonJS へ落として `require` を差し替えるので、
 * 「どの依存を本物にして、どれをスタブにするか」を 1 件ずつ選べる。
 * `import.meta.env` は CommonJS では書けないのでテキストで置き換える。
 */
const loaded = new Map();
function load(path, stubs) {
  const key = `${path}`;
  if (loaded.has(key)) return loaded.get(key);
  const src = read(path).replace(/import\.meta\.env/g, 'globalThis.__env');
  const out = ts.transpileModule(src, {
    compilerOptions: { target: 'ES2022', module: 'CommonJS', esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  const req = (spec) => {
    if (spec in stubs) return stubs[spec];
    throw new Error(`${path}: スタブしていない依存 ${spec}`);
  };
  // eslint-disable-next-line no-new-func
  new Function('require', 'exports', 'module', out)(req, mod.exports, mod);
  loaded.set(key, mod.exports);
  return mod.exports;
}

globalThis.__env = { PUBLIC_DEMO_FALLBACK: undefined, DEMO_ALLOWED_UIDS: '', SPECIAL_ALLOWED_UIDS: '' };

/** app_config のスタブ。`setConfig` の呼び出しを**数える** (「何も書かない」を測るため)。 */
const CFG = new Map();
const writes = [];
const appConfig = {
  cfg: (k) => CFG.get(k) ?? '',
  refreshConfig: async () => {},
  setConfig: async (updates, by) => { writes.push({ updates, by }); return { ok: true }; },
};
const setCfg = (obj) => { CFG.clear(); for (const [k, v] of Object.entries(obj)) CFG.set(k, v); };

const DEMO = load('src/lib/demo-accounts.ts', { './app-config': appConfig });
const SPECIAL = load('src/lib/special-accounts.ts', { './app-config': appConfig, './demo-accounts': DEMO });
const EXP = load('src/lib/experience-accounts.ts', {
  './app-config': appConfig, './demo-accounts': DEMO, './special-accounts': SPECIAL,
});

const U = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const UID_D = U(1);
const UID_S = U(2);
const UID_X = U(3);
const MAIL = 'reporter@example.com';
const hash = await DEMO.hashEmail(MAIL);
const row = (h, uid) => `${h} r***@example.com ${uid || '-'}  # テスト`;

// ══════════════════════════════════════════════════════════════════════
// ① 競合の定義 — **同じ uid の Dual は競合ではない** (発注者裁定)
// ══════════════════════════════════════════════════════════════════════
console.log('\n① 競合の定義 (detectConflict を実際に動かす)\n');
eq('両方 空 → 競合ではない', EXP.detectConflict(null, null), null);
eq('Demo だけ uid 在り → 競合ではない (空へ写せばよい)', EXP.detectConflict(UID_D, null), null);
eq('Real だけ uid 在り → 競合ではない', EXP.detectConflict(null, UID_S), null);
eq('**同じ uid が両方に在る → 正常な Dual** (本番に 2 件実在)',
  EXP.detectConflict(UID_D, UID_D), null);
eq('**違う uid が両方に在る → 競合**', EXP.detectConflict(UID_D, UID_S),
  { demoUid: UID_D, specialUid: UID_S });
eq('大文字・空白を吸収して比較する', EXP.detectConflict(` ${UID_D.toUpperCase()} `, UID_D), null);

// ══════════════════════════════════════════════════════════════════════
// ② 登録時の uid 決定 — **UID を増やさない** (R2 の修正そのもの)
// ══════════════════════════════════════════════════════════════════════
console.log('\n② 登録時の uid 決定 (canonicalUidForRegistration)\n');
{
  const r1 = EXP.canonicalUidForRegistration({ side: 'special', ownUid: UID_S, otherUid: null, taken: [] });
  eq('Real: 自分の側に記録済み → そのまま (再採番しない)', [r1.ok, r1.uid], [true, UID_S]);

  // **ここが本命。** 以前は Demo 側を見ずに mintSpecialUid() を呼んでいた。
  const r2 = EXP.canonicalUidForRegistration({ side: 'special', ownUid: null, otherUid: UID_D, taken: [] });
  eq('**Real: Demo 側の uid を写す (新規発行しない)**', [r2.ok, r2.uid, r2.source], [true, UID_D, 'demo']);

  const r3 = EXP.canonicalUidForRegistration({ side: 'special', ownUid: null, otherUid: null, taken: [] });
  ok('Real: どちらにも無ければ発行する', r3.ok && DEMO.isUuid(r3.uid) && r3.source === 'minted');

  const r4 = EXP.canonicalUidForRegistration({ side: 'special', ownUid: UID_S, otherUid: UID_D, taken: [] });
  eq('**Real: 両方に違う uid → uid_conflict (自動統合しない)**',
    [r4.ok, r4.reason, r4.conflict], [false, 'uid_conflict', { demoUid: UID_D, specialUid: UID_S }]);

  const r5 = EXP.canonicalUidForRegistration({ side: 'special', ownUid: UID_S, otherUid: UID_S, taken: [] });
  eq('Real: 両方に同じ uid (Dual) → そのまま通る', [r5.ok, r5.uid], [true, UID_S]);

  const r6 = EXP.canonicalUidForRegistration({ side: 'demo', ownUid: null, otherUid: UID_S, taken: [] });
  eq('**Demo: Real 側の uid を写す**', [r6.ok, r6.uid, r6.source], [true, UID_S, 'special']);

  const r7 = EXP.canonicalUidForRegistration({ side: 'demo', ownUid: null, otherUid: null });
  eq('Demo: どちらにも無ければ**発行しない** (従来どおりサインイン時に決まる)',
    [r7.ok, r7.uid], [true, null]);

  const r8 = EXP.canonicalUidForRegistration({ side: 'demo', ownUid: UID_D, otherUid: UID_S });
  eq('Demo: 両方に違う uid → uid_conflict', [r8.ok, r8.reason], [false, 'uid_conflict']);

  // 採番が 8 回とも衝突 → **衝突 uid を返さない** (`mintSpecialUid` の fail-closed を貫通させる)
  const realRandom = globalThis.crypto.randomUUID;
  globalThis.crypto.randomUUID = () => UID_X;
  const r9 = EXP.canonicalUidForRegistration({ side: 'special', ownUid: null, otherUid: null, taken: [UID_X] });
  globalThis.crypto.randomUUID = realRandom;
  eq('Real: 採番が全部衝突 → mint_failed (衝突 uid を返さない)', [r9.ok, r9.reason], [false, 'mint_failed']);
  ok('randomUUID を元に戻してある', DEMO.isUuid(
    EXP.canonicalUidForRegistration({ side: 'special', ownUid: null, otherUid: null, taken: [] }).uid));
}

// ══════════════════════════════════════════════════════════════════════
// ③ サインイン経路の uid 決定 (`resolve.ts` が呼ぶ本体を実際に動かす)
// ══════════════════════════════════════════════════════════════════════
console.log('\n③ サインイン経路 (resolveCanonicalUidByEmail)\n');
{
  setCfg({ 'special.account_emails': row(hash, UID_S) });
  let r = await EXP.resolveCanonicalUidByEmail(MAIL, null);
  eq('Real だけ登録 → その uid / side=special', [r.ok, r.uid, r.side, r.dual], [true, UID_S, 'special', false]);

  setCfg({ 'demo.account_emails': row(hash, UID_D) });
  r = await EXP.resolveCanonicalUidByEmail(MAIL, null);
  eq('Demo だけ登録 → その uid / side=demo', [r.ok, r.uid, r.side, r.dual], [true, UID_D, 'demo', false]);

  // **正常な Dual** (同じ uid が両方に在る)。
  setCfg({ 'demo.account_emails': row(hash, UID_S), 'special.account_emails': row(hash, UID_S) });
  r = await EXP.resolveCanonicalUidByEmail(MAIL, null);
  eq('**Dual (同じ uid) → 通る・side=special・dual=true**',
    [r.ok, r.uid, r.side, r.dual], [true, UID_S, 'special', true]);

  // **UID 分裂。自動統合しない。**
  setCfg({ 'demo.account_emails': row(hash, UID_D), 'special.account_emails': row(hash, UID_S) });
  r = await EXP.resolveCanonicalUidByEmail(MAIL, null);
  eq('**違う uid → uid_conflict (どちらも勝たせない)**', [r.ok, r.reason], [false, 'uid_conflict']);

  setCfg({});
  r = await EXP.resolveCanonicalUidByEmail(MAIL, UID_X);
  eq('どちらにも無い → uid は決めない (従来どおり未連携へ)', [r.ok, r.uid, r.side], [true, null, null]);

  // legacy (uid 空の行) の救済 = **その Auth アカウントの既存 uid を採る**。
  setCfg({ 'special.account_emails': row(hash, '') });
  r = await EXP.resolveCanonicalUidByEmail(MAIL, UID_X);
  eq('legacy (uid 空) + 既存 uid → **既存 uid を採る** (新規発行しない)',
    [r.ok, r.uid], [true, UID_X]);

  setCfg({ 'special.account_emails': row(hash, '') });
  r = await EXP.resolveCanonicalUidByEmail(MAIL, null);
  ok('legacy + 既存 uid も無い → 最後の手段として発行する', r.ok && DEMO.isUuid(r.uid));

  // **照会が落ちたら「登録なし」と同一視しない** (同一視すると新しい uid を採番する)。
  const realRefresh = appConfig.refreshConfig;
  appConfig.refreshConfig = async () => { throw new Error('app_config 取得失敗'); };
  r = await EXP.resolveCanonicalUidByEmail(MAIL, null);
  appConfig.refreshConfig = realRefresh;
  eq('**照会失敗 → lookup_failed (fail-closed)**', [r.ok, r.reason], [false, 'lookup_failed']);

  eq('メールが無い → 失敗ではない (引くものが無いだけ)',
    await EXP.resolveCanonicalUidByEmail(null, null).then((x) => [x.ok, x.uid]), [true, null]);
}

// ══════════════════════════════════════════════════════════════════════
// ④ 資格 — **両方 true は正常**。表示モードはここで決めない
// ══════════════════════════════════════════════════════════════════════
console.log('\n④ 資格 (experienceCapabilities)\n');
{
  const uidRow = (uid) => `${uid}  # テスト`;
  setCfg({ 'demo.account_uids': uidRow(UID_D), 'special.account_uids': uidRow(UID_D) });
  eq('**同じ uid に両資格 → dual (排他しない)**', EXP.experienceCapabilities(UID_D),
    { canDemo: true, canReal: true, dual: true });
  setCfg({ 'demo.account_uids': uidRow(UID_D) });
  eq('Demo だけ', EXP.experienceCapabilities(UID_D), { canDemo: true, canReal: false, dual: false });
  setCfg({ 'special.account_uids': uidRow(UID_S) });
  eq('Real だけ', EXP.experienceCapabilities(UID_S), { canDemo: false, canReal: true, dual: false });
  setCfg({});
  eq('どちらでもない', EXP.experienceCapabilities(UID_X), { canDemo: false, canReal: false, dual: false });
  ok('資格の判定に admin が混ざっていない',
    !/isAdmin|viewerIsAdmin|admin_users/.test(code('src/lib/experience-accounts.ts')),
    'admin を増やしても体験アカウントの利用者は増えない、が設計');
  ok('表示モードをここで決めていない (`view-mode.ts` の仕事)',
    !/welltect_mode|effectiveMode|shouldUseDemoData/.test(code('src/lib/experience-accounts.ts')),
    '資格と表示モードを混ぜると、どちらの話で分岐しているのか追えなくなる');
}

// ══════════════════════════════════════════════════════════════════════
// ⑤ **採番の口は 1 つだけ** (ここが 2 つに戻ると UID 分裂が再発する)
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑤ 採番の口が 1 つだけであること\n');
{
  const callers = [];
  for (const p of ['src/pages/api/admin/special-accounts.ts', 'src/pages/api/admin/demo-accounts.ts',
    'src/pages/api/auth/resolve.ts', 'src/lib/demo-data.ts', 'src/lib/special-email-replace.ts']) {
    if (/mintSpecialUid/.test(code(p))) callers.push(p);
  }
  eq('`mintSpecialUid` を呼ぶのは canonical 層だけ', callers, []);
  ok('canonical 層が `mintSpecialUid` を持っている',
    /mintSpecialUid/.test(code('src/lib/experience-accounts.ts')));
  for (const p of ['src/pages/api/admin/special-accounts.ts', 'src/pages/api/admin/demo-accounts.ts']) {
    ok(`${p.split('/').pop()} が canonical 層を通している`,
      /canonicalUidForRegistration/.test(code(p)),
      '片方の名簿しか見ずに uid を決めると UID が分裂する');
  }
  // **`crypto.randomUUID()` を admin API で直に呼ばない** (採番の口が増える)。
  for (const p of ['src/pages/api/admin/special-accounts.ts', 'src/pages/api/admin/demo-accounts.ts']) {
    ok(`${p.split('/').pop()} が randomUUID を直に呼んでいない`,
      !/crypto\.randomUUID/.test(code(p)));
  }
}

// ══════════════════════════════════════════════════════════════════════
// ⑥ `resolve.ts` — **既存の fail-closed を 1 つも弱めていない**
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑥ resolve.ts の順序と既存ガード\n');
{
  const r = code('src/pages/api/auth/resolve.ts');
  const at = (re) => r.search(re);
  const iCanon = at(/resolveCanonicalUidByEmail/);
  const iConflict = at(/uid_conflict/);
  const iGoogle409 = at(/google_password_not_allowed|Google/);
  const iPreassign = at(/specialPreassignedUidByEmail/);
  const iCred = at(/issueAdminCred\(/);
  const iEarly = at(/linked: false/);
  const iLinkDemo = at(/linkDemoEmail\(/);
  const iLinkSpecial = at(/linkSpecialEmail\(/);

  ok('canonical 解決を 1 か所だけ呼んでいる',
    (r.match(/resolveCanonicalUidByEmail\(/g) || []).length === 1,
    '呼ぶ場所が増えると、どの順序で uid が決まるのか追えなくなる');
  ok('競合の 409 が `issueAdminCred` より前', iConflict > 0 && iCred > 0 && iConflict < iCred,
    '後ろだと admin credential だけ発行済みになり「何も書かない」が崩れる');
  ok('競合の 409 が未連携の early return より前', iEarly > 0 && iConflict < iEarly);
  ok('競合の 409 が `linkDemoEmail` / `linkSpecialEmail` より前',
    iConflict < iLinkDemo && iConflict < iLinkSpecial, '名簿を書いてから止めても手遅れ');
  ok('事前発行 uid ガード (既存 409) が残っている', iPreassign > 0);
  ok('事前発行 uid ガードも `issueAdminCred` より前のまま', iPreassign < iCred);
  ok('Google × パスワードの 409 が残っている',
    /google_sub/.test(r) && iGoogle409 > 0);
  ok('canonical 解決が実顧客 / staging の後ろにある',
    at(/resolve-customer|resolveCustomer|production/) < iCanon || at(/'staging'/) < iCanon,
    '先に置くと実顧客の uid より体験アカウントが優先される');
  ok('直接の名簿解決 (resolveSpecialUidByEmail / resolveDemoUidByEmail) をもう呼んでいない',
    !/resolveSpecialUidByEmail\(|resolveDemoUidByEmail\(/.test(r),
    '片方ずつ引くと 2 つの名簿の食い違いを見逃す');
  ok('Special を Demo より先に見る優先順を保っている (side の既定)',
    /canon\.side \?\? 'special'/.test(r));
}

// ══════════════════════════════════════════════════════════════════════
// ⑦ admin API を**実際に動かす** — 競合時に `setConfig` が 0 回であること
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑦ admin API の POST を実走 (競合 → 何も保存しない)\n');
{
  const stubs = {
    '../../../lib/api-auth': { isAdminAuthorized: () => true },
    '../../../lib/app-config': appConfig,
    '../../../lib/supabase': { getServerSupabase: () => null },
    '../../../lib/special-email-replace': { planEmailReplace: () => ({ plan: [], rejected: [] }) },
    '../../../lib/account-progress': { getAccountProgress: async () => ({}) },
    '../../../lib/demo-accounts': DEMO,
    '../../../lib/special-accounts': SPECIAL,
    '../../../lib/experience-accounts': EXP,
    astro: {},
  };
  const SAPI = load('src/pages/api/admin/special-accounts.ts', stubs);
  const DAPI = load('src/pages/api/admin/demo-accounts.ts', stubs);
  const post = async (api, body) => {
    writes.length = 0;
    const res = await api.POST({
      request: new Request('https://x/api', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }),
    });
    return { status: res.status, json: await res.json(), writes: writes.length };
  };

  // ── Demo に uid が在る人を Real へ足す = **R2 の経路**。写すこと。
  setCfg({ 'demo.account_emails': row(hash, UID_D) });
  let r = await post(SAPI, { add_email: [{ email: MAIL, label: 'テスト' }] });
  ok('**Real 登録: Demo の uid を写して保存する (新規採番しない)**',
    r.status === 200 && (() => {
      const w = writes[0]?.updates ?? {};
      return String(w['special.account_emails'] ?? '').includes(UID_D)
        && String(w['special.account_uids'] ?? '').includes(UID_D);
    })(),
    `応答=${r.status} / 書込=${JSON.stringify(writes[0]?.updates ?? null)}`);

  // ── Real に uid が在る人を Demo へ足す = 逆向き。写すこと。
  setCfg({ 'special.account_emails': row(hash, UID_S) });
  r = await post(DAPI, { add_email: [{ email: MAIL, label: 'テスト' }] });
  ok('**Demo 登録: Real の uid を写して資格も立てる**',
    r.status === 200 && (() => {
      const w = writes[0]?.updates ?? {};
      return String(w['demo.account_emails'] ?? '').includes(UID_S)
        && String(w['demo.account_uids'] ?? '').includes(UID_S);
    })(), `応答=${r.status} / 書込=${JSON.stringify(writes[0]?.updates ?? null)}`);

  // ── 新規 (どちらにも無い) の Demo 登録は **uid を発行しない**。
  setCfg({});
  r = await post(DAPI, { add_email: [{ email: MAIL, label: 'テスト' }] });
  ok('Demo 登録 (新規): uid は書かない (従来どおりサインイン時)',
    r.status === 200 && !/[0-9a-f]{8}-[0-9a-f]{4}/.test(String(writes[0]?.updates?.['demo.account_uids'] ?? '')),
    `書込=${JSON.stringify(writes[0]?.updates ?? null)}`);

  // ── **競合。何も保存しない。** ここが本命。
  setCfg({ 'demo.account_emails': row(hash, UID_D), 'special.account_emails': row(hash, UID_S) });
  r = await post(SAPI, { add_email: [{ email: MAIL, label: 'テスト' }] });
  eq('**Real 登録 (競合): 409 `uid_conflict`**', [r.status, r.json.error], [409, 'uid_conflict']);
  eq('**Real 登録 (競合): `setConfig` 0 回**', r.writes, 0);

  setCfg({ 'demo.account_emails': row(hash, UID_D), 'special.account_emails': row(hash, UID_S) });
  r = await post(DAPI, { add_email: [{ email: MAIL, label: 'テスト' }] });
  eq('**Demo 登録 (競合): 409 `uid_conflict`**', [r.status, r.json.error], [409, 'uid_conflict']);
  eq('**Demo 登録 (競合): `setConfig` 0 回**', r.writes, 0);

  // ── 正常な Dual (同じ uid) は止めない。
  setCfg({ 'demo.account_emails': row(hash, UID_S), 'special.account_emails': row(hash, UID_S) });
  r = await post(SAPI, { add_email: [{ email: MAIL, label: 'テスト' }] });
  ok('**Dual (同じ uid) は 409 にしない**', r.status === 200, `応答=${r.status}`);

  // ── 既に Real 側に uid が在る再登録で uid を変えない (冪等)。
  setCfg({ 'special.account_emails': row(hash, UID_S) });
  r = await post(SAPI, { add_email: [{ email: MAIL, label: '別ラベル' }] });
  ok('Real 再登録: uid は変えない',
    r.status === 200 && !String(writes[0]?.updates?.['special.account_emails'] ?? row(hash, UID_S)).includes(UID_X),
    `書込=${JSON.stringify(writes[0]?.updates ?? null)}`);
}

// ══════════════════════════════════════════════════════════════════════
// ⑧ 既存の検査・既存の約束を弱めていないこと
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑧ 既存の約束 (資格の層は表示モードを知らない)\n');
{
  /*
   * **2026-10-22 (PR-C で更新)**: Special 排他は `demo-data.ts` から
   * `view-mode.ts` へ**移した** (排他ではなくモードで分ける形へ)。
   * 検査する約束は変わらない — **資格の層 (`experience-accounts.ts`) は
   * 表示モードを知らない**・**`resolve.ts` は Cookie を書かない**。
   */
  ok('`demoFallbackEnabled` は撤去されている (PR-C)',
    !/demoFallbackEnabled/.test(code('src/lib/demo-data.ts')),
    '資格だけでダミーを出すかを決める関数が残ると、モードを渡し忘れた経路で使われる');
  ok('ダミーの判定は `shouldUseDemoData(uid, mode)` 1 本',
    /export function shouldUseDemoData\(uid: string \| null \| undefined, mode: ViewMode\)/
      .test(read('src/lib/view-mode.ts')));
  ok('`welltect_mode` Cookie を資格の層・サインイン経路に持ち込んでいない',
    !/welltect_mode|MODE_COOKIE/.test(code('src/lib/experience-accounts.ts'))
    && !/welltect_mode|MODE_COOKIE/.test(code('src/pages/api/auth/resolve.ts')),
    'サインインで Cookie を書くと「ログイン直後は必ず Real」が崩れる');
  ok('migration を 1 本も足していない',
    !readdirSync(resolve(ROOT, 'supabase/migrations')).some((f) => /2026102[2-9]/.test(f)), 'この領域は app_config だけで足りる (仕様書の絶対条件)');
  ok('app_config のキーを増やしていない',
    !/experience\.|mode\./.test(read('src/lib/app-config.ts')));
  ok('切り分けに資格を出している (can_demo / can_real)',
    /can_demo/.test(read('src/pages/api/debug/viewer.ts'))
    && /can_real/.test(read('src/pages/api/debug/viewer.ts')),
    '「資格は在るのに出ない」を画面から切り分けられないと原因が追えない');
}

console.log(`\n${fails.length === 0 ? '✅ すべて通過' : `❌ ${fails.length} 件 失敗`}`);
for (const f of fails) console.log(`  - ${f}`);
process.exit(fails.length === 0 ? 0 : 1);
