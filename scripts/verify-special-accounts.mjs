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
  /*
   * **`uid` が在ること = 本人サインイン済み、ではない** (2026-10-05 の仕様変更)。
   * 旧コメントは `linked = その人がもうサインインしたか` と書いていたが、
   * 新仕様では登録のその場で uid が付くので**虚偽になる**。
   * 本人の認証状況を知りたいなら `diagnosis.app_users.auth_user_id` を根拠にする。
   */
  ok('uid の有無を「本人がサインインしたか」と定義していない',
    !/`?linked`? *= *その人が\*\*もうサインインしたか/.test(sa)
    && !/linked.*=.*本人.*サインイン済/.test(sa),
    'uid はメール登録時に発行されるので、uid の有無は認証状況を表さない');
  ok('`uidAllocated` という名前で意味を明示している', /uidAllocated/.test(sa));
  ok('純粋関数はデモ枠から import している (再実装しない)',
    /from '\.\/demo-accounts'/.test(sa) && !/SHA-256/.test(sa),
    'hashEmail 等を書き写すと片方だけ直って黙ってすれ違う');
  for (const k of ['special.account_emails', 'special.account_uids', 'special.account_denied_uids', 'special.account_dob']) {
    ok(`app-config.ts に ${k} がある`, read('src/lib/app-config.ts').includes(`key: '${k}'`),
      'setConfig が未知キーとして弾く');
  }
  /*
   * **admin 画面の説明文も現在仕様に合わせる。**
   * `app-config.ts` の `CONFIG_SPECS[].description` は admin のカタログにそのまま出る。
   * 旧文言「uid はサインイン時に自動で埋まる」は**嘘**になった (登録時に発行される) し、
   * 「Google アカウントで登録」もメール＋パスワード認証を足した今は片方しか指していない。
   * **説明が実装と食い違っていると、操作する人が「本人が来るまで待つもの」と誤解する** —
   * 事前にデータを入れるためにこの仕様へ変えたので、ここが古いと目的が伝わらない。
   */
  {
    const spec = read('src/lib/app-config.ts');
    const i = spec.indexOf("key: 'special.account_emails'");
    const block = i >= 0 ? spec.slice(i, spec.indexOf("key: 'special.account_uids'", i)) : '';
    ok('special.account_emails の説明に旧文言「サインイン時に自動で埋まる」が残っていない',
      i >= 0 && !/サインイン時に自動で埋まる/.test(block), block);
    ok('  入口が「メールアドレス」になっている (Google 限定の書き方をしていない)',
      /メールアドレスで登録/.test(block) && !/Google アカウントで登録/.test(block), block);
    ok('  **登録時に即時発行される**ことが書いてある',
      /即時発行/.test(block), block);
    ok('  本人の Sign up / Sign in では既存 uid へ紐付くことが書いてある',
      /既存 uid へ本人認証が紐付く/.test(block), block);
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
  // 2026-09-30: 未連携の応答に `admin` を足した (uid を持たない admin を handoff で通すため)。
  // **場所は同じ**なので、前方一致で拾う。
  const iBail = r.indexOf('return json({ linked: false');
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
// 照会の失敗を**実際に起こす**ための口 (null 以外を入れると refreshConfig が投げる)。
export const __state = { throws: null };
export const cfg = (k) => __store[k] ?? '';
export const refreshConfig = async (force) => {
  if (__state.throws) throw __state.throws;
  if (force) __forced.push(1);
};
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

/*
 * ⑤ は **`special.account_emails` を直接組んで** `linkSpecialEmail` を動かす。
 * つまり**新仕様より前に登録された uid 空の行** (legacy) の形。
 * 新仕様の「登録のその場で uid を発行する」経路は ⑨ が API ごと動かして見る。
 * **`uid` が在ることは「本人がサインインした」ことを意味しない** (2026-10-05)。
 */
console.log('\n⑤ メール登録 (現物を保存しない・uid は 1 度決めたら変わらない)\n');
{
  const MAIL = 'invited@example.com';
  const UID = 'cccccccc-1111-2222-3333-444444444444';
  reset();

  const h = await M.demo.hashEmail('  Invited@Example.com ');
  eq('大文字/空白の違いを吸収して同じ人と分かる', h, await M.demo.hashEmail(MAIL));
  eq('マスクから現物は復元できない', M.demo.maskEmail(MAIL), 'i******@example.com');

  STORE['special.account_emails'] = M.demo.serializeEmailEntries([{ hash: h, masked: M.demo.maskEmail(MAIL), uid: '', label: '招待 A' }]);
  eq('legacy 行 (uid 空) は uid 未発行として出る',
    M.listSpecialAccounts().emails.map((e) => e.uidAllocated), [false]);
  eq('  → まだ資格は無い', M.isSpecialAccount(UID), false);

  eq('登録の無い人は素通り', await M.linkSpecialEmail('stranger@example.com', UID), false);
  eq('  → 書き込みに行かない (サインインは全員が通る経路)', WRITES.length, 0);
  eq('  → DB 往復を強制しない', FORCED.length, 0);

  eq('登録済みの人がサインイン → 突き合わせ成立', await M.linkSpecialEmail(MAIL, UID), true);
  eq('  → その場で資格が立つ', M.isSpecialAccount(UID), true);
  eq('  → メール行に uid が記録される',
    M.listSpecialAccounts().emails.map((e) => e.uid), [UID]);
  eq('  → uid 発行済みとして出る (**「サインイン済み」の意味ではない**)',
    M.listSpecialAccounts().emails.map((e) => e.uidAllocated), [true]);
  eq('  → 旧名 linked は uidAllocated の別名として同じ値を返す',
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
  eq('ラベルを書き換えても状態を誤らない', M.listSpecialAccounts().emails[0]?.uidAllocated, true);
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
  eq('① 事前発行済みの照会も同じ uid を返す (競合ガードの根拠)',
    await M.specialPreassignedUidByEmail(MAIL), { ok: true, uid: minted });
  eq('  → 登録の無い人には uid: null (ガードを誤発火させない)',
    await M.specialPreassignedUidByEmail('stranger@example.com'), { ok: true, uid: null });
  /*
   * **「引けなかった」を「事前発行なし」と同一視しない。**
   * null 1 本で返していたときは、app_config の取得が落ちた回が
   * 「登録されていない人」と見分けが付かず、**競合ガードが素通り**していた
   * (= 事前投入済みの UID-A が黙って UID-B へ張り替わる)。
   */
  eq('  → メールが無いのは失敗ではない (ok: true)',
    await M.specialPreassignedUidByEmail(null), { ok: true, uid: null });
  {
    M.store.__state.throws = new Error('app_config unreachable');
    const got = await M.specialPreassignedUidByEmail(MAIL);
    M.store.__state.throws = null;
    eq('  → **照会に失敗したら ok: false** (「事前発行なし」と同一視しない)', got.ok, false);
    ok('  → 失敗の戻り値に uid を載せない (呼び出し側が誤って使えない形)',
      !('uid' in got), JSON.stringify(got));
  }
  eq('  → 別の既存 uid を渡されても記録済みが勝つ',
    await M.resolveSpecialUidByEmail(MAIL, EXIST), minted);
  eq('  → 現物のアドレスは保存物のどこにも無い',
    /invited@example\.com/.test(JSON.stringify(STORE)), false);
}

console.log('\n⑦ 生年月日・性別 (ウェルネス年齢用・PII 隔離・ブラインド表示)\n');
{
  // ── ラウンドトリップと壊れた行の排除 ──
  const H = 'a'.repeat(64);
  const rt = M.serializeDobEntries(M.parseDobEntries(`${H} 1970-05-15 male`));
  eq('保存 → 解析 → 保存が一致する', rt, `${H} 1970-05-15 male`);
  eq('性別だけでも持てる', M.parseDobEntries(`${H} - female`).map((e) => [e.dob, e.sex]), [['', 'female']]);
  eq('壊れた日付は捨てる', M.parseDobEntries(`${H} 1970-13-40 male`).map((e) => e.dob), ['']);
  eq('hash でない行は捨てる', M.parseDobEntries('notahash 1970-05-15 male').length, 0);
  eq('中身が空の行は持たない', M.parseDobEntries(`${H} - -`).length, 0);
  eq('性別トークンを吸収 (男/M/female)',
    [M.normSexToken('男'), M.normSexToken('M'), M.normSexToken('female'), M.normSexToken('x')],
    ['male', 'male', 'female', '']);

  // ── uid → 生年月日・性別 の突き合わせ (email 行の uid↔hash を辿る) ──
  reset();
  const MAIL = 'dobuser@example.com';
  const UID = 'eeeeeeee-1111-2222-3333-444444444444';
  const h = await M.demo.hashEmail(MAIL);
  STORE['special.account_emails'] = M.demo.serializeEmailEntries([{ hash: h, masked: M.demo.maskEmail(MAIL), uid: UID, label: '招待' }]);
  STORE['special.account_dob'] = `${h} 1970-05-15 male`;
  eq('サインイン済みの uid から生年月日・性別を引ける',
    M.specialSubjectByUid(UID), { dateOfBirth: '1970-05-15', sex: 'male' });
  eq('登録の無い uid は null (捏造しない)',
    M.specialSubjectByUid('ffffffff-1111-2222-3333-444444444444'), null);

  // サインイン前 (uid 未確定) の DOB 行は uid から引けない (email 行に uid が無い)。
  STORE['special.account_emails'] = M.demo.serializeEmailEntries([{ hash: h, masked: M.demo.maskEmail(MAIL), uid: '', label: '招待' }]);
  eq('サインイン待ちの間は uid から引けない', M.specialSubjectByUid(UID), null);
}

// ══════════════════════════════════════════════════════════════════════
// ⑧ 生年月日はブラウザへ生で返さない (API のブラインド化・静的ガード)
// ══════════════════════════════════════════════════════════════════════
//
// present() を経ずに生スナップショットを返すと、dobRaw (生の日付) が画面に載る。
// **退行を注入するとここで落ちる** (発注者指示「生年月日の表示はブラインドに」)。
console.log('\n⑧ API がブラインド化してから返す\n');
{
  const api = read('src/pages/api/admin/special-accounts.ts');
  ok('present() で整形してから返す (GET/POST とも)',
    (api.match(/present\(/g) || []).length >= 2, 'present を通さないと生年月日が生で返る');
  ok('生スナップショットをそのまま返していない',
    !/\.\.\.\(await snapshot\(\)\)/.test(api) && !/\.\.\.snap[,\s}]/.test(api),
    'dobRaw ごとブラウザへ流れる');
  ok('present は dobRaw を落とす',
    /const \{ dobRaw:[^}]*\} = snap/.test(api), 'dobRaw を返却に混ぜてはいけない');
  ok('マスク文字列を添える (dob_masked)', /dob_masked/.test(api), '登録済みかだけ分かればよい');
  ok('生年月日の生値をレスポンスに入れない',
    !/dob:\s*d\.dob/.test(api), '生の日付を JSON に載せない');
}

/* ══════════════════════════════════════════════════════════════════════
   ⑨ **メール登録のその場で uid を発行する** (2026-10-05 発注者指示)
   ══════════════════════════════════════════════════════════════════════

   【なぜ変えたか】以前は uid が空のまま登録され、本人の初回サインインで
   `linkSpecialEmail` が埋めていた。それだと **本人が来るまで検査データを
   入れられない** (admin 画面の［追加検査データ］が uid 無しでは押せない)。
   実際の用途 (トランスコスモス 10 名) は「本人のログイン前に健診・遺伝子・
   報告書を準備する」ことなので、登録の時点で uid が確定していないと成立しない。

   【ここは静かに壊れる】
     - uid を発行し忘れても **登録は成功して見える**。詰まるのは数日後、
       データを入れようとした人が「ボタンが押せない」と気づいたときだけ。
     - 逆に**再登録で uid を作り直してしまっても画面は正常に見える**。
       壊れるのは「前に入れた検査データが誰のものでもなくなる」ことで、
       それは一覧の数字が 0 に戻るまで誰も気づかない。
     - メール行にだけ書いて `special.account_uids` に足し忘れても、
       uid は画面に出るので**発行できたように見える**。実際は資格が立たない。

   だから**実物の API ハンドラをそのまま動かす**。app_config だけスタブ。
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n⑨ メール登録でその場で uid を発行する (API を実際に動かす)\n');
const API = await (async () => {
  writeFileSync(resolve(CACHE, 'sa-api-auth.mjs'), 'export const isAdminAuthorized = () => true;\n');
  writeFileSync(resolve(CACHE, 'sa-progress.mjs'), 'export const getAccountProgress = async () => ({});\n');
  let src = read('src/pages/api/admin/special-accounts.ts')
    .replace(/^import type .*?;$/gm, '')
    .replace(/from '\.\.\/\.\.\/\.\.\/lib\/app-config'/g, "from './sa-app-config.mjs'")
    .replace(/from '\.\.\/\.\.\/\.\.\/lib\/demo-accounts'/g, "from './sa-demo-accounts.mjs'")
    .replace(/from '\.\.\/\.\.\/\.\.\/lib\/special-accounts'/g, "from './sa-special-accounts.mjs'")
    .replace(/from '\.\.\/\.\.\/\.\.\/lib\/api-auth'/g, "from './sa-api-auth.mjs'")
    .replace(/from '\.\.\/\.\.\/\.\.\/lib\/account-progress'/g, "from './sa-progress.mjs'");
  // 差し替え漏れを**黙って通さない** (import の形が変わったら気づけるように)。
  if (/\.\.\/\.\.\/\.\.\/lib\//.test(src)) fails.push('verify: API の import 差し替えに失敗');
  const out = resolve(CACHE, 'sa-api.mjs');
  writeFileSync(out, js(src));
  return import(out);
})();

/** admin API の POST を 1 回叩く。**実物のハンドラ**を呼ぶ。 */
const callApi = async (body) => {
  const res = await API.POST({
    request: new Request('http://x/api/admin/special-accounts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const uidOf = (r, mask) => (r.body.emails ?? []).find((e) => e.masked === mask)?.uid ?? '';
/** 保存された資格一覧 (未保存なら空文字)。**undefined で crash させない**。 */
const uidsRaw = () => String(STORE['special.account_uids'] ?? '');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

{
  const MAIL = 'pre1@example.com';
  const MASK = 'p***@example.com';
  reset();

  // ── 1. 登録したレスポンスの時点で有効な UUID が在る ──
  const r1 = await callApi({ add_email: [{ email: MAIL, label: 'トランスコスモス 2026-10' }] });
  const uid1 = uidOf(r1, MASK);
  eq('1. 登録は成功する', r1.status, 200);
  ok('1. **レスポンスの時点で有効な UUID が在る** (本人のログインを待たない)',
    UUID_RE.test(uid1), `uid=${JSON.stringify(uid1)}`);

  // ── 4. 同じリクエスト内で special.account_uids にも入る ──
  ok('4. **`special.account_uids` にも同じ uid が入る** (メール行だけに書かない)',
    !!uid1 && uidsRaw().includes(uid1), `uids=${JSON.stringify(uidsRaw())}`);
  eq('4. その場で資格が立つ (本人のログイン前から)', M.isSpecialAccount(uid1), true);
  eq('4. 一覧の uidAllocated が true', (r1.body.emails ?? []).map((e) => e.uidAllocated), [true]);
  ok('4. 保存は 1 回の setConfig にまとめている (片方だけ書かれる形を作らない)',
    WRITES.length === 1 && 'special.account_uids' in (WRITES[0] ?? {}) && 'special.account_emails' in (WRITES[0] ?? {}),
    JSON.stringify(WRITES));

  // ── 作るのは uid だけ。Auth は 1 つも作らない ──
  ok('   **Auth ユーザー / password / google_sub を作っていない**',
    !/auth_user_id|google_sub|password/.test(JSON.stringify(STORE)), JSON.stringify(STORE));
  eq('   現物のアドレスは保存物のどこにも無い', /pre1@example\.com/.test(JSON.stringify(STORE)), false);

  // ── 2. 同じメールを再登録しても uid が変わらない ──
  const r2 = await callApi({ add_email: [{ email: MAIL, label: 'メモを書き換えた' }] });
  eq('2. **再登録で uid が変わらない**', uidOf(r2, MASK), uid1);
  // ── 6. label 変更で uid が変わらない (同上の呼び出しで確認) ──
  eq('6. label を変えても uid が変わらない', uidOf(r2, MASK), uid1);
  eq('6.   label は更新されている', (r2.body.emails ?? []).map((e) => e.label), ['メモを書き換えた']);

  // ── 7. DOB / sex を更新しても uid が変わらない ──
  const r3 = await callApi({ add_email: [{ email: MAIL, dob: '1970-05-15', sex: 'male' }] });
  eq('7. **DOB / sex を更新しても uid が変わらない**', uidOf(r3, MASK), uid1);
  eq('7.   DOB は登録されている (生値は返さない)',
    (r3.body.emails ?? []).map((e) => [e.has_dob, e.dob_masked, e.sex]), [[true, '****-**-**', 'male']]);
  eq('7.   ログイン前でもウェルネス年齢の年齢ソースとして引ける',
    M.specialSubjectByUid(uid1), { dateOfBirth: '1970-05-15', sex: 'male' });

  // ── 8. メール Delete で資格も外れる (検査データは消さない) ──
  const r4 = await callApi({ remove_email: [(r3.body.emails ?? [])[0].hash] });
  eq('8. **メールを外すと uid の資格も外れる**', M.isSpecialAccount(uid1), false);
  eq('8.   メール行も消えている', (r4.body.emails ?? []).length, 0);
  ok('8.   `special.account_uids` からも消えている',
    !!uid1 && !uidsRaw().includes(uid1), `uids=${JSON.stringify(uidsRaw())}`);
}

{
  // ── 3. legacy の uid='' 行を再登録すると 1 度だけ発行される ──
  const MAIL = 'legacy@example.com';
  const MASK = 'l*****@example.com';
  reset();
  const h = await M.demo.hashEmail(MAIL);
  // 旧仕様で登録された行 = uid 空。**GET しただけでは書き換えない** (一括 migration はしない)。
  STORE['special.account_emails'] = M.demo.serializeEmailEntries(
    [{ hash: h, masked: M.demo.maskEmail(MAIL), uid: '', label: '旧仕様の行' }]);
  const before = WRITES.length;
  const g = await API.GET({ request: new Request('http://x/api/admin/special-accounts') });
  await g.json().catch(() => ({}));
  eq('3. GET しただけでは書き換えない (一括 migration はしない)', WRITES.length, before);
  eq('3.   旧行は uid 空のまま', M.specialEmailEntries?.().map((e) => e.uid) ?? ['?'], ['']);

  const r = await callApi({ add_email: [{ email: MAIL, label: '旧仕様の行' }] });
  const uid = uidOf(r, MASK);
  ok('3. **再登録すると uid が 1 度だけ発行される**', UUID_RE.test(uid), `uid=${JSON.stringify(uid)}`);
  eq('3.   資格も立つ', M.isSpecialAccount(uid), true);
  const again = await callApi({ add_email: [{ email: MAIL }] });
  eq('3.   もう一度登録しても作り直さない', uidOf(again, MASK), uid);
}

{
  // ── 5. 同一リクエストに複数メールがあっても、それぞれ固有 uid になる ──
  reset();
  const r = await callApi({
    add_email: [
      { email: 'm1@example.com', label: 'トランスコスモス 2026-10' },
      { email: 'm2@example.com', label: 'トランスコスモス 2026-10' },
      { email: 'm3@example.com', label: 'トランスコスモス 2026-10' },
    ],
  });
  const uids = (r.body.emails ?? []).map((e) => e.uid);
  eq('5. 3 件とも uid が付く', uids.filter((u) => UUID_RE.test(u)).length, 3);
  eq('5. **それぞれ固有の uid** (使い回さない)', new Set(uids).size, 3);
  eq('5.   3 件とも資格が立つ', uids.map((u) => M.isSpecialAccount(u)), [true, true, true]);
  eq('5.   `special.account_uids` にも 3 件', M.demo.parseEntries(uidsRaw()).length, 3);
}

{
  // ── 5'. 既存 uid と衝突する uid を採らない (mintSpecialUid を直接動かす) ──
  const taken = ['11111111-1111-4111-8111-111111111111'];
  const minted = Array.from({ length: 20 }, () => M.mintSpecialUid(taken));
  ok("5'. 既存 uid を採らない", minted.every((u) => u !== taken[0]));
  ok("5'. 大文字・空白の既存 uid も衝突として扱う",
    M.mintSpecialUid([` ${taken[0].toUpperCase()} `]) !== taken[0]);
  ok("5'. 毎回 UUID 形式", minted.every((u) => UUID_RE.test(u)));
  /*
   * **API が既存 uid を渡していること**は静的に見る。
   * 衝突 (2^122) は実挙動では再現できないので、「渡し忘れ」は動かしても捕まらない。
   */
  const api = read('src/pages/api/admin/special-accounts.ts');
  ok("5'. API は既存 uid の集合を渡している (上書きを作らない)",
    /mintSpecialUid\(takenUids\)/.test(api) && !/mintSpecialUid\(\[\]\)/.test(api),
    '空を渡すと既存 uid と衝突したときに上書きしてしまう');
  ok("5'.   集合に 3 つの供給元すべてを入れている",
    /const takenUids = new Set<string>\(\[[\s\S]{0,400}?cur\.rows[\s\S]{0,200}?entries[\s\S]{0,200}?emails/.test(api),
    '組み込み / env / config / メール行 のどれかが漏れると衝突を見逃す');
  ok("5'.   発行したらその場で集合へ足している (同一リクエスト内の重複よけ)",
    /takenUids\.add\(/.test(api));
}

/* ══════════════════════════════════════════════════════════════════════
   5''. **採番に失敗したら衝突 uid を返さない (fail-closed)**
   ══════════════════════════════════════════════════════════════════════

   以前は `MINT_ATTEMPTS` 回ぜんぶ外したときに**最後の候補 (= 既存 uid と
   衝突している値) をそのまま返して**いた。確率は現実には 0 だが、返した瞬間に
   「既存 uid と衝突しない」という契約が破れ、**別人の uid へ相乗りした行**を作る。
   uid には実データが紐づくので、ここは何もしないで止めるのが正しい。

   衝突は 2^122 なので自然には再現できない。**`crypto.randomUUID` を差し替えて
   8 回とも既存 uid を返させる**ことで、実際にその経路を通す。 */
console.log("\n⑨' 採番に失敗したら何も保存しない (randomUUID を差し替えて実走)\n");
{
  const COLLIDE = 'cccccccc-1111-4111-8111-111111111111';
  const realUuid = globalThis.crypto.randomUUID.bind(globalThis.crypto);
  const stubUuid = (fn) => Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: fn, configurable: true, writable: true,
  });

  // ── 関数そのもの: 全部衝突したら null (最後の候補を返さない) ──
  stubUuid(() => COLLIDE);
  eq("5''. 8 回とも衝突 → **null** (衝突 uid を返さない)", M.mintSpecialUid([COLLIDE]), null);
  eq("5''.   1 回でも空いていれば採れる", M.mintSpecialUid([]), COLLIDE);
  stubUuid(realUuid);

  // ── API: 新規行。**503 で止まり、保存は 0 件** ──
  reset();
  STORE['special.account_uids'] = COLLIDE;
  const before = WRITES.length;
  const emailsBefore = String(STORE['special.account_emails'] ?? '');
  const uidsBefore = uidsRaw();
  stubUuid(() => COLLIDE);
  const r = await callApi({ add_email: [{ email: 'mintfail@example.com', label: 'トランスコスモス 2026-10' }] });
  stubUuid(realUuid);
  eq("5''. 新規登録は **503** で止まる", r.status, 503);
  eq("5''.   error は uid_generation_failed", r.body.error, 'uid_generation_failed');
  eq("5''.   **保存 0 件** (setConfig を呼んでいない)", WRITES.length - before, 0);
  eq("5''.   `special.account_emails` は 1 文字も変わらない",
    String(STORE['special.account_emails'] ?? ''), emailsBefore);
  eq("5''.   `special.account_uids` も 1 文字も変わらない", uidsRaw(), uidsBefore);
  ok("5''.   行が作られていない (資格も立たない)",
    !uidsRaw().includes('mintfail') && M.specialEmailEntries().length === 0,
    JSON.stringify(STORE));

  // ── API: legacy の uid='' 行を再登録する経路も同じ ──
  reset();
  const h = await M.demo.hashEmail('legacyfail@example.com');
  STORE['special.account_uids'] = COLLIDE;
  STORE['special.account_emails'] = M.demo.serializeEmailEntries(
    [{ hash: h, masked: M.demo.maskEmail('legacyfail@example.com'), uid: '', label: '旧仕様の行' }]);
  const before2 = WRITES.length;
  const emailsBefore2 = String(STORE['special.account_emails'] ?? '');
  stubUuid(() => COLLIDE);
  const r2 = await callApi({ add_email: [{ email: 'legacyfail@example.com' }] });
  stubUuid(realUuid);
  eq("5''. legacy 行の救済でも **503**", [r2.status, r2.body.error], [503, 'uid_generation_failed']);
  eq("5''.   **保存 0 件**", WRITES.length - before2, 0);
  eq("5''.   旧行は uid 空のまま (壊さない)",
    String(STORE['special.account_emails'] ?? ''), emailsBefore2);

  // ── 差し替えを戻せているか (以降の検査を汚染しない) ──
  ok("5''. randomUUID を元に戻してある", UUID_RE.test(M.mintSpecialUid([])));
}

/* ══════════════════════════════════════════════════════════════════════
   ⑩ 事前発行 uid を黙って張り替えないこと (resolve.ts の静的ガード)
   ══════════════════════════════════════════════════════════════════════

   実挙動は `verify:email-auth` ⑫ が `POST` を動かして見る。ここでは
   **ガードの位置**を固定する — 書き込みより後ろへ動かされたら意味が無い。 */
console.log('\n⑩ 事前発行 uid の競合ガード (位置を固定)\n');
{
  const r = read('src/pages/api/auth/resolve.ts');
  const iGuard = r.indexOf('const preassigned = await specialPreassignedUidByEmail(email);');
  const iCred = r.indexOf('await issueAdminCred(');
  const iRebind = r.indexOf('diagnosticUserId = linkedUid;');
  const iDetach = r.indexOf(".update({ auth_user_id: null, google_sub: null");
  const iUpsert = r.indexOf('.upsert(row');
  const iLinkDemo = r.indexOf('await linkDemoEmail(');
  const iLinkSp = r.indexOf('await linkSpecialEmail(');
  const iCookie = r.indexOf('cookies.set(VIEWER_COOKIE');
  // ガード 1 ブロックだけを切り出す (後続のコードを巻き込んで判定しない)。
  const block = iGuard >= 0 ? r.slice(r.lastIndexOf("if (linkedUid &&", iGuard), r.indexOf('const adminForCred', iGuard)) : '';

  ok('競合ガードが在る', iGuard >= 0,
    '事前投入した検査データが別人格へ黙って紐付く');
  /*
   * **`issueAdminCred` より前**であることが 2026-10-05 hardening の本体。
   * 以前はガードが張り替え分岐の中 (= `issueAdminCred` の後ろ) にあり、
   * 本線の書き込みには届いていなかったが **admin credential だけは発行済み**で
   * 「何も書かない」が成立していなかった。
   */
  ok('**admin credential の発行 (`issueAdminCred`) より前**にある',
    iGuard >= 0 && iCred >= 0 && iGuard < iCred,
    '後ろだと 409 を返す前に admin credential を set / delete してしまう');
  ok('**張り替えより前**にある', iGuard >= 0 && iRebind >= 0 && iGuard < iRebind,
    '後ろだと張り替えが先に起きるので意味が無い');
  ok('detach より前', iGuard >= 0 && iDetach >= 0 && iGuard < iDetach);
  ok('app_users の upsert より前', iGuard >= 0 && iUpsert >= 0 && iGuard < iUpsert);
  ok('linkDemoEmail / linkSpecialEmail より前',
    iGuard >= 0 && iLinkDemo >= 0 && iLinkSp >= 0 && iGuard < iLinkDemo && iGuard < iLinkSp);
  ok('viewer Cookie の発行より前', iGuard >= 0 && iCookie >= 0 && iGuard < iCookie);
  ok('**事前発行済みかを直接引いている** (戻り値から逆算しない)',
    /specialPreassignedUidByEmail\(email\)/.test(r),
    'resolveSpecialUidByEmail の優先順位を 1 行変えた瞬間に静かに効かなくなる');
  ok('409 で止める', /\}, 409\)/.test(block), block.slice(0, 200));
  /*
   * **照会の失敗を「事前発行なし」と同一視しない。** 同一視すると app_config の
   * 取得が落ちた回にガードが素通りし、ちょうど守りたかった張り替えが起きる。
   */
  ok('**照会に失敗したら fail-closed で止める** (事前発行なしと同一視しない)',
    /if \(!preassigned\.ok\)/.test(block) && /\}, 503\)/.test(block),
    '引けなかった回を通すと、守りたかった張り替えがちょうど起きる');
  ok('  判定は `preassigned.uid` を見ている (戻り値を素で真偽判定しない)',
    /preassigned\.uid && preassigned\.uid === diagnosticUserId/.test(block), block.slice(0, 400));
  ok('生の DB エラー・内部情報を利用者へ返していない',
    !/detail|\.message/.test(block));
  ok('デモ枠は従来どおり (special だけを止めている)',
    /resolvedFrom === 'special'/.test(block) && !/resolvedFrom === 'demo'/.test(r),
    'デモはダミーなので張り替えても実害が無い。順序も変えない');
}

// ══════════════════════════════════════════════════════════════════════
console.log('');
if (fails.length) {
  console.log(`✗ ${fails.length} 件`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✓ スペシャル枠は本人の実データ。ダミーは 1 件も出ない。');
console.log('  登録=メールアドレス (uid はその場で発行) / 判定=uid / 緊急停止=除外リスト (全停止スイッチは無い)。');
