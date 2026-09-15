#!/usr/bin/env node
/**
 * `npm run verify:special-accounts` — **スペシャルアカウント枠**の回帰チェック。
 *
 * 正本: `docs/operations/スペシャルアカウント_仕様書.md` §10。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【この枠の要】デモ用アカウントとは**目的が逆**。混ぜると実害が出る。
 * ══════════════════════════════════════════════════════════════════════
 *
 *   デモ枠         … ダミーを見せる。相手は記者・パートナー (社外)
 *   スペシャル枠   … **本人の実データ**を扱う。相手は本人
 *
 * 両方に登録される事故は起き得る。そのとき**実データの利用者に他人名義の
 * ダミー検査結果が出る**のが最悪の形なので、`demoFallbackEnabled` の 1 行で止めてある。
 * **ここは静かに壊れる** (画面は正常に見えるのに中身が他人のもの) ので、目視では守れない。
 *
 * 検査は「そう書いてあるか」で済ませず、**実物を transpile して動かす**
 * (`demo-accounts.ts` / `special-accounts.ts` / `demoFallbackEnabled` の本体)。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
/** コメント行を落とす (経緯の説明に旧コードが書いてあるため、そこを拾わない)。 */
const code = (p) => read(p).split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');

const fails = [];
const ts = (await import('typescript')).default;
const CACHE = resolve(ROOT, 'node_modules/.cache');
mkdirSync(CACHE, { recursive: true });
const js = (src) => ts.transpileModule(src, { compilerOptions: { target: 'ES2022', module: 'ESNext' } }).outputText;

const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails.push(`${label} — got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
};
const ok = (label, cond, why) => {
  if (!cond) fails.push(`${label}${why ? ` — ${why}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
};

// ══════════════════════════════════════════════════════════════════════
// ① スペシャル枠にダミーが 1 件も出ないこと (**この枠の第一級要件**)
// ══════════════════════════════════════════════════════════════════════
//
// `demoFallbackEnabled` の**本体をそのまま切り出して動かす**。
// 「isSpecialAccount と書いてあるか」を見るだけだと、順序を入れ替えたり
// 条件を反転したりした退行を拾えない。
console.log('\n① ダミーの止め (demoFallbackEnabled を実際に動かす)\n');
{
  const src = read('src/lib/demo-data.ts');
  const i = src.indexOf('export function demoFallbackEnabled');
  if (i < 0) {
    fails.push('demo-data.ts: demoFallbackEnabled が見つからない');
  } else {
    const end = src.indexOf('\n}', i) + 2;
    const body = js(src.slice(i, end).replace('export function', 'function'));
    const make = new Function('demoDisabledGlobally', 'isDemoAccount', 'isSpecialAccount',
      `${body}\nreturn demoFallbackEnabled;`);
    const gate = (globalOff, demo, special) =>
      make(() => globalOff, () => demo, () => special)('11111111-1111-1111-1111-111111111111');

    eq('デモ枠だけ → ダミーを出す', gate(false, true, false), true);
    eq('スペシャル枠だけ → ダミーを出さない', gate(false, false, true), false);
    // **両方に登録された事故。ここが本命。**
    eq('**両方に登録されていてもダミーを出さない**', gate(false, true, true), false);
    eq('どちらでもない (一般顧客) → 出さない', gate(false, false, false), false);
    eq('全停止スイッチはデモ側にだけ効く', gate(true, true, false), false);
  }
}

// ══════════════════════════════════════════════════════════════════════
// ② 判定に admin が現れないこと / 引数が uid 1 つであること
// ══════════════════════════════════════════════════════════════════════
console.log('\n② 資格の判定 (admin を混ぜない・uid だけで決まる)\n');
{
  const sa = read('src/lib/special-accounts.ts');
  ok('isSpecialAccount の引数が uid 1 つ',
    /export function isSpecialAccount\(uid\?: string \| null\): boolean/.test(sa),
    'admin を受け取る形にすると、資格が権限の仕組みに結合する (デモ枠で踏んだ誤り)');
  ok('special-accounts.ts に admin 判定が混ざっていない',
    !/viewerIsAdmin|isAdmin/.test(code('src/lib/special-accounts.ts')),
    'admin を増やしてもスペシャル枠の利用者は増えない、が設計 (仕様書 §9.3)');
  ok('毎リクエストの判定に email を持ち込まない', (() => {
    const fn = sa.slice(sa.indexOf('export function isSpecialAccount'));
    return !/email|hash/i.test(fn.slice(fn.indexOf('{') + 1, fn.indexOf('\n}')));
  })(), '判定が async になり ~30 箇所の呼び出し側が全部 await になる');
  ok('管理者リストからの自動登録を実装していない',
    !/seeded|admin_users/i.test(code('src/lib/special-accounts.ts')),
    '実データが紐づく枠で名簿を写して自動登録するのは危険 (仕様書 §9.3)');
  ok('全停止の env スイッチを持たない',
    !/disabledGlobally|PUBLIC_SPECIAL|SPECIAL_FALLBACK/.test(code('src/lib/special-accounts.ts')),
    '止めるとその人がログインできなくなる。緊急停止は除外リスト (仕様書 §7)');
  ok('組み込みを名簿として育てていない',
    /const BUILTIN_SPECIAL_UIDS: readonly string\[\] = \[\];/.test(sa),
    '実データが紐づくのでコードに焼き込まない。通常は app_config で管理 (仕様書 §5)');
  ok('純粋関数はデモ枠から import している (再実装しない)',
    /from '\.\/demo-accounts'/.test(sa) && !/SHA-256/.test(sa),
    'hashEmail 等を書き写すと片方だけ直って黙ってすれ違う');
  for (const k of ['special.account_emails', 'special.account_uids', 'special.account_denied_uids']) {
    ok(`app-config.ts に ${k} がある`, read('src/lib/app-config.ts').includes(`key: '${k}'`),
      'setConfig が未知キーとして弾く');
  }
}

// ══════════════════════════════════════════════════════════════════════
// ③ サインインの橋渡し (未連携の early return より前・デモより先)
// ══════════════════════════════════════════════════════════════════════
console.log('\n③ サインインの橋渡し (api/auth/resolve.ts)\n');
{
  const r = read('src/pages/api/auth/resolve.ts');
  const iSpecial = r.indexOf('resolveSpecialUidByEmail(email');
  const iDemo = r.indexOf('resolveDemoUidByEmail(email');
  const iBail = r.indexOf('return json({ linked: false }');
  const iLinked = r.indexOf('const linkedUid = await findLinkedUid(');

  ok('resolveSpecialUidByEmail を呼んでいる', iSpecial >= 0,
    'EC 顧客でないスペシャルアカウントが入口で弾かれる');
  ok('**未連携の early return より前**にある', iSpecial >= 0 && iBail >= 0 && iSpecial < iBail,
    '後ろだと到達しないので、登録しても本人は入れない');
  ok('**デモ枠より先**に置いている', iSpecial >= 0 && iDemo >= 0 && iSpecial < iDemo,
    '両方に誤って登録されたとき、実データ側を優先してダミーを掴ませないため (仕様書 §6)');
  ok('既存の割り当て (linkedUid) を渡している',
    /resolveSpecialUidByEmail\(email,\s*linkedUid\)/.test(r),
    '毎回新しい uid を作ると app_users の UNIQUE 制約に衝突しサインインが 500 で壊れる');
  ok('findLinkedUid が橋渡しより前', iLinked >= 0 && iSpecial >= 0 && iLinked < iSpecial);
  ok('linkSpecialEmail で uid を写している', /await linkSpecialEmail\(email, diagnosticUserId\)/.test(r),
    '登録しても uid が埋まらず、次回以降も毎回発行しに行く');
  ok('email をサーバで検証している', /getUser|auth\/v1\/user/.test(r),
    'クライアント申告の email で登録できると、誰でも枠に入れる');
}

// ══════════════════════════════════════════════════════════════════════
// ④ 実際に動かす (供給元の和 / 除外 / メール登録 / uid 採番)
// ══════════════════════════════════════════════════════════════════════
//
// app_config だけスタブに差し替えるので DB は要らない (値の出入りを完全に握れる)。
// `demo-accounts.ts` は**実物**を読む (純粋関数を共有していることの確認も兼ねる)。
const M = await (async () => {
  writeFileSync(resolve(CACHE, 'sa-app-config.mjs'), `
export const __store = {};
export const __writes = [];
export const __forced = [];
export const cfg = (k) => __store[k] ?? '';
export const refreshConfig = async (force) => { if (force) __forced.push(1); };
export const setConfig = async (u) => { __writes.push(u); Object.assign(__store, u); return { ok: true }; };
`);
  const swap = (s) => js(s
    .replace(/from '\.\/app-config'/g, "from './sa-app-config.mjs'")
    .replace(/from '\.\/demo-accounts'/g, "from './sa-demo-accounts.mjs'")
    .replace(/import\.meta\.env\.(\w+)/g, 'globalThis.__saEnv.$1'));
  writeFileSync(resolve(CACHE, 'sa-demo-accounts.mjs'), swap(read('src/lib/demo-accounts.ts')));
  const out = resolve(CACHE, 'sa-special-accounts.mjs');
  const body = swap(read('src/lib/special-accounts.ts'));
  if (!/sa-app-config/.test(body) || !/sa-demo-accounts/.test(body)) {
    fails.push('verify: import の差し替えに失敗 (import 文の形が変わった)');
  }
  writeFileSync(out, body);
  globalThis.__saEnv = {};
  /*
   * **クエリ文字列を付けずに import する。** ESM は URL 単位でモジュールを持つので、
   * `?t=` を付けると special-accounts が見ている store と別の実体になり、
   * 値を入れても何も効かない (検査が全部 false になる)。
   */
  return {
    ...(await import(out)),
    store: await import(resolve(CACHE, 'sa-app-config.mjs')),
    demo: await import(resolve(CACHE, 'sa-demo-accounts.mjs')),
  };
})();

// スタブの store は special / demo-accounts の双方から同じ実体を指す。
const STORE = M.store.__store;
const WRITES = M.store.__writes;
const FORCED = M.store.__forced;
const reset = () => {
  for (const k of Object.keys(STORE)) delete STORE[k];
  WRITES.length = 0; FORCED.length = 0;
};

console.log('\n④ 供給元の和と除外リスト (実際に動かす)\n');
{
  const A = 'aaaaaaaa-1111-2222-3333-444444444444';
  const B = 'bbbbbbbb-1111-2222-3333-444444444444';
  reset();
  eq('未登録の uid は資格なし', M.isSpecialAccount(A), false);
  eq('未サインイン (uid なし) も資格なし', M.isSpecialAccount(null), false);

  STORE['special.account_uids'] = `${A}  # 招待 2026-09`;
  eq('app_config に載れば資格あり', M.isSpecialAccount(A), true);
  eq('注釈は uid と読まない', M.isSpecialAccount('招待'), false);
  eq('大文字・空白は吸収する', M.isSpecialAccount(`  ${A.toUpperCase()} `), true);

  globalThis.__saEnv.SPECIAL_ALLOWED_UIDS = B;
  eq('env も和に入る (上書きでない)', [M.isSpecialAccount(A), M.isSpecialAccount(B)], [true, true]);

  STORE['special.account_denied_uids'] = B;
  eq('**除外は和のあと** (env の行も止められる)', M.isSpecialAccount(B), false);
  eq('  → 一覧には残り「除外中」と分かる',
    M.listSpecialAccounts().rows.filter((r) => r.uid === B).map((r) => r.denied), [true]);
  STORE['special.account_denied_uids'] = '';
  eq('  → 戻せば元どおり (供給元を消していない)', M.isSpecialAccount(B), true);

  // 逆順だと config 側で足し直せてしまう
  STORE['special.account_uids'] = B;
  STORE['special.account_denied_uids'] = B;
  eq('除外した uid を config で足し直しても復活しない', M.isSpecialAccount(B), false);
  globalThis.__saEnv.SPECIAL_ALLOWED_UIDS = undefined;
}

console.log('\n⑤ メール登録 (現物を保存しない・uid は 1 度決めたら変わらない)\n');
{
  const MAIL = 'invited@example.com';
  const UID = 'cccccccc-1111-2222-3333-444444444444';
  reset();

  const h = await M.demo.hashEmail('  Invited@Example.com ');
  eq('大文字/空白の違いを吸収して同じ人と分かる', h, await M.demo.hashEmail(MAIL));
  eq('マスクから現物は復元できない', M.demo.maskEmail(MAIL), 'i******@example.com');

  STORE['special.account_emails'] = M.demo.serializeEmailEntries([{ hash: h, masked: M.demo.maskEmail(MAIL), uid: '', label: '招待 A' }]);
  eq('サインイン前は「サインイン待ち」(異常ではない)',
    M.listSpecialAccounts().emails.map((e) => e.linked), [false]);
  eq('  → まだ資格は無い', M.isSpecialAccount(UID), false);

  eq('登録の無い人は素通り', await M.linkSpecialEmail('stranger@example.com', UID), false);
  eq('  → 書き込みに行かない (サインインは全員が通る経路)', WRITES.length, 0);
  eq('  → DB 往復を強制しない', FORCED.length, 0);

  eq('登録済みの人がサインイン → 突き合わせ成立', await M.linkSpecialEmail(MAIL, UID), true);
  eq('  → その場で資格が立つ', M.isSpecialAccount(UID), true);
  eq('  → メール行に uid が記録される',
    M.listSpecialAccounts().emails.map((e) => e.uid), [UID]);
  eq('  → admin 画面で「サインイン済み」になる',
    M.listSpecialAccounts().emails.map((e) => e.linked), [true]);
  eq('  → uid 行にメール由来の印が付く',
    M.listSpecialAccounts().rows.filter((r) => r.uid === UID).map((r) => r.viaEmail), [true]);
  // **これが一番大事。** 保存物のどこにも現物が無いこと。
  eq('  → **現物のアドレスは保存物のどこにも無い**',
    /invited@example\.com/.test(JSON.stringify(STORE)), false);

  const n = WRITES.length;
  eq('2 回目以降のサインインは何も書かない', await M.linkSpecialEmail(MAIL, UID), true);
  eq('  → 書き込み回数が増えない', WRITES.length, n);

  // ラベルは admin が書き換えられる。**推測でなく記録**を見ていることの確認。
  STORE['special.account_uids'] = `${UID}  # 別のメモに書き換えた`;
  eq('ラベルを書き換えても状態を誤らない', M.listSpecialAccounts().emails[0]?.linked, true);
}

console.log('\n⑥ uid の採番 (記録済み → 既存 → 新規発行)\n');
{
  const MAIL = 'invited@example.com';
  const EXIST = 'dddddddd-1111-2222-3333-444444444444';
  reset();

  eq('登録の無い人には uid を与えない (従来どおり未連携)',
    await M.resolveSpecialUidByEmail('stranger@example.com'), null);
  eq('  → 既存 uid があっても与えない',
    await M.resolveSpecialUidByEmail('stranger@example.com', EXIST), null);

  const h = await M.demo.hashEmail(MAIL);
  STORE['special.account_emails'] = M.demo.serializeEmailEntries([{ hash: h, masked: M.demo.maskEmail(MAIL), uid: '', label: '招待 A' }]);

  eq('② 既存の uid があればそれを使う (新しく作らない)',
    await M.resolveSpecialUidByEmail(MAIL, EXIST), EXIST);
  const minted = await M.resolveSpecialUidByEmail(MAIL);
  eq('③ 無ければ新規発行', /^[0-9a-f-]{36}$/.test(String(minted)), true);

  await M.linkSpecialEmail(MAIL, minted);
  eq('① 以後は記録済みの uid が返る (**1 度決めたら変わらない**)',
    await M.resolveSpecialUidByEmail(MAIL), minted);
  eq('  → 別の既存 uid を渡されても記録済みが勝つ',
    await M.resolveSpecialUidByEmail(MAIL, EXIST), minted);
  eq('  → 現物のアドレスは保存物のどこにも無い',
    /invited@example\.com/.test(JSON.stringify(STORE)), false);
}

// ══════════════════════════════════════════════════════════════════════
console.log('');
if (fails.length) {
  console.log(`✗ ${fails.length} 件`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✓ スペシャル枠は本人の実データ。ダミーは 1 件も出ない。');
console.log('  登録=Google アカウント / 判定=uid / 緊急停止=除外リスト (全停止スイッチは無い)。');
