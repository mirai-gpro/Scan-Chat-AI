#!/usr/bin/env node
/**
 * `npm run verify:demo-gate` — **誰にダミーデータが出るか**を固定する回帰チェック。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【2026-08-30 確定】**デモ用アカウントと管理者アカウントは別物。混ぜない。**
 * ══════════════════════════════════════════════════════════════════════
 *
 * デモの目的は **UI デザイン確認 / 機能確認 / ビジネスパートナーへのお披露目・PR**。
 * **PR 用のアカウントは社外に渡る**ので、管理者と同じ枠に置くことはできない。
 *
 *   デモの資格 = uid が一覧にあるか (`demo-accounts.ts` `isDemoAccount`)。**それだけ。**
 *   管理者権限 = Wellfort 側 `admin_users` (`admin-auth.ts`)。**まったく別系統。**
 *
 * 【admin を混ぜてはいけない理由 — 実際に踏んだ失敗】
 *   旧実装は `viewerIsAdmin` を条件に持っていた。その値は
 *   **Cookie の署名 → HP Edge の resolve-customer → Wellfort 側 admin_users**
 *   という 3 段の外部依存で決まり、どこか 1 つが落ちても結果は同じ `false` で、
 *   **画面は黙って空になる** (本番で `edge.is_admin:false` を実測)。
 *   さらに**管理者を 1 人増やすたびにダミーの閲覧者が増える**。
 *
 * 判定の実体は `src/lib/view-mode.ts` の `shouldUseDemoData(uid, mode)` (PR-C)。
 * ここでは同じ規則を**独立に**書き下して突き合わせる (実装をそのまま読むと
 * 「実装が実装どおり」を確認するだけになる)。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
/** コメント行を落とす (経緯の説明に旧コードが書いてあるため、そこを拾わない)。 */
const code = (p) => read(p).split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');

const src = read('src/lib/demo-data.ts');
/** 資格の実体はこちら。「誰に見せるか」は demo-accounts.ts が単独で持つ。 */
const acct = read('src/lib/demo-accounts.ts');
const fails = [];

/** 実装から組み込みの uid を読む (中身は運用で変わるので、そこは固定しない)。 */
const BUILTIN = (() => {
  const block = acct.slice(acct.indexOf('BUILTIN_DEMO_UIDS: readonly string[]'));
  return [...block.slice(0, block.indexOf('];')).matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]);
})();
if (BUILTIN.length === 0) fails.push('demo-accounts.ts: 組み込みのデモ用 uid が読めない');

// ══════════════════════════════════════════════════════════════════════
// 1. 判定の規則 (実装とは独立にここへ書き下す)
// ══════════════════════════════════════════════════════════════════════

/**
 * @param uid      表示中の diagnostic_user_id
 * @param envFalse env PUBLIC_DEMO_FALLBACK === 'false'
 * @param extra    env DEMO_ALLOWED_UIDS ∪ app_config demo.account_uids
 */
function expected(uid, envFalse, extra = []) {
  if (envFalse) return false;                            // ① 全停止スイッチ
  return !!uid && [...BUILTIN, ...extra].includes(uid);  // ② デモ用アカウントか。それだけ
}

const DEMO = BUILTIN[0];
const PARTNER = 'bbbbbbbb-1111-2222-3333-444444444444';   // お披露目用に admin から登録した uid
const CUSTOMER = 'aaaaaaaa-1111-2222-3333-444444444444'; // 実顧客

// [ラベル, uid, env=false か, 追加登録, 期待]
const cases = [
  ['デモ用アカウント(組み込み)     / env 未設定', DEMO,     false, [],        true],
  ['デモ用アカウント(組み込み)     / env=false ', DEMO,     true,  [],        false],
  ['PR/お披露目用(admin から登録)  / env 未設定', PARTNER,  false, [PARTNER], true],
  ['PR/お披露目用(未登録)          / env 未設定', PARTNER,  false, [],        false],
  ['一般顧客                       / env 未設定', CUSTOMER, false, [],        false],
  ['一般顧客                       / env=false ', CUSTOMER, true,  [],        false],
  ['一般顧客(他所で PR 登録あり)   / env 未設定', CUSTOMER, false, [PARTNER], false],
  ['未サインイン                   / env 未設定', null,     false, [],        false],
  /*
   * **admin であることはデモの資格にならない。**
   * 管理者を増やしてもダミーの閲覧者は増えない = 2 つの資格が分かれている証拠。
   * admin がダミーを見たいなら、その uid を登録する (それが唯一の道)。
   */
  ['admin だが uid 未登録          / env 未設定', CUSTOMER, false, [],        false],
  /*
   * **admin 判定が壊れていてもデモ用アカウントは見られる。**
   * お披露目が外部システム (Cookie / HP Edge / admin_users) の状態に左右されない。
   */
  ['デモ用アカウント / admin 判定が壊れている',  DEMO,     false, [],        true],
  /*
   * **代理表示 (`?u=`) は「表示中の uid」で判定される。**
   * 実測 2026-08-30: `?u=` 付きで紙面が emptyVM になり、原因の特定に往復した。
   */
  ['代理表示 (?u=) の相手がデモ用アカウント',    DEMO,     false, [],        true],
  ['代理表示 (?u=) の相手が一般顧客',            CUSTOMER, false, [],        false],
  /*
   * **メール登録は「予約」であって、資格そのものではない。**
   * 本人がサインインするまで uid が分からないので出ない (これは正常)。
   * サインインすると `linkDemoEmail` が uid を一覧へ写し、次の行の状態になる。
   */
  ['メール登録済み / 本人がまだサインインしていない', PARTNER, false, [],        false],
  ['メール登録済み / サインインして uid が入った',    PARTNER, false, [PARTNER], true],
];

// ══════════════════════════════════════════════════════════════════════
// 2. デモの資格に admin が混ざっていないこと (**この再設計の要**)
// ══════════════════════════════════════════════════════════════════════
{
  /*
   * **2026-10-22 (PR-C)**: 判定の実体は `view-mode.ts` の
   * `shouldUseDemoData(uid, mode)` へ移った (`demoFallbackEnabled` は撤去)。
   * **この節の要件は同じ** — 資格は `isDemoAccount` だけで決まり、全停止スイッチが効き、
   * **admin はどこにも現れない**。
   */
  const vm = read('src/lib/view-mode.ts');
  const fn = vm.slice(vm.indexOf('export function shouldUseDemoData'));
  const body = fn.slice(fn.indexOf('{') + 1, fn.indexOf('\n}'));

  if (!/isDemoAccount/.test(body)) fails.push('shouldUseDemoData が isDemoAccount を使っていない');
  if (!/demoDisabledGlobally/.test(body)) fails.push('shouldUseDemoData に全停止スイッチが無い');

  /*
   * **引数は uid と mode の 2 つ。どちらも省略できない。**
   * `mode` を任意にすると**渡し忘れたページだけ挙動が違う**ので型で落ちなくなる
   * (§4.3「一部だけ旧判定を残さない」)。admin を受け取る形にも戻さない。
   */
  if (!/export function shouldUseDemoData\(uid: string \| null \| undefined, mode: ViewMode\): boolean/.test(vm)) {
    fails.push('shouldUseDemoData の引数が (uid, mode) ではない'
      + ' — mode を任意にすると渡し忘れが型で落ちず、admin を受け取る形に戻すと'
      + 'デモの資格が権限の仕組みに再び結合する');
  }
  // **撤去した名前が live コードへ戻っていないこと** (旧い暗黙判定の再導入を落とす・§4.3)。
  for (const f of ['src/lib/demo-data.ts', 'src/lib/dashboard-queries.ts', 'src/lib/notice-queries.ts',
                   'src/lib/measurement-queries.ts', 'src/lib/result-queries.ts',
                   'src/lib/elith-report-queries.ts', 'src/pages/dashboard.astro']) {
    if (/demoFallbackEnabled\s*\(/.test(code(f))) {
      fails.push(`${f}: 撤去した demoFallbackEnabled() が戻っている`
        + ' — ダミーを出すかの判定は shouldUseDemoData(uid, mode) だけ');
    }
  }

  /*
   * **デモの経路のどこにも admin が現れないこと。**
   * ここが緩むと「管理者を増やすとダミーの閲覧者が増える」形に戻り、
   * PR 用アカウントを社外に渡す前提と両立しなくなる。
   */
  for (const f of ['src/lib/demo-accounts.ts', 'src/lib/demo-data.ts',
                   'src/lib/dashboard-queries.ts', 'src/lib/measurement-queries.ts',
                   'src/lib/notice-queries.ts', 'src/lib/elith-report-queries.ts',
                   'src/lib/result-queries.ts']) {
    if (/viewerIsAdmin|isAdmin/.test(code(f))) {
      fails.push(`${f}: デモの経路に admin 判定が混ざっている`
        + ' — デモ用アカウントと管理者アカウントは別物。混ぜない');
    }
  }
  // ページ側も同様 (demoOk のような橋渡しを作らない)
  for (const f of ['src/pages/dashboard.astro', 'src/pages/report.astro',
                   'src/pages/trend.astro', 'src/pages/notices.astro', 'src/pages/kit.astro']) {
    if (/demoOk/.test(read(f))) {
      fails.push(`${f}: demoOk が復活している — デモの資格を画面から引き回さない (uid で決まる)`);
    }
  }

  /*
   * ════════════════════════════════════════════════════════════════════
   * **実データがあってもデモが勝つこと** (仕様書 §2 の表「実データ = —」)。
   * ════════════════════════════════════════════════════════════════════
   * 2026-09-05 の実障害: 入口が `demoFallbackEnabled(uid) && 行が 0 件` という
   * **件数との AND** になっていて、DB に 1 行でもあるとデモが引っ込んでいた。
   * 借り物の実データは歯抜けなので、デモの目的「全部の表示機能を見せる」
   * (§1 = お披露目・機能確認) を構造的に満たせない。
   *
   * 見るのは **`demoFallbackEnabled(...)` と同じ if の中に件数の条件が並んでいないか**
   * だけ。エラー時の救済 (`if (appUserErr || ...)`) や `!sb` は件数ではないので通る。
   */
  for (const f of ['src/lib/dashboard-queries.ts', 'src/lib/notice-queries.ts',
                   'src/lib/measurement-queries.ts']) {
    const body = code(f);
    /*
     * `if (…)` の条件を**括弧を数えて**取り出す。素朴な `[^)]*` だと
     * `(importantRaw?.length ?? 0) === 0` のような入れ子で途中で切れ、
     * **退行を注入しても検査が黙って通る** (実際に一度そうなった)。
     */
    for (const m of body.matchAll(/\bif\s*\(/g)) {
      let depth = 1;
      let i = m.index + m[0].length;
      for (; i < body.length && depth > 0; i++) {
        if (body[i] === '(') depth++;
        else if (body[i] === ')') depth--;
      }
      const cond = body.slice(m.index + m[0].length, i - 1);
      if (!cond.includes('shouldUseDemoData')) continue;
      if (/\.length|\bcount\b|rows\b/.test(cond)) {
        fails.push(`${f}: デモの判定に件数が AND されている → if (${cond.trim()})`
          + ' — 実データの有無は条件ではない (仕様書 §2)。'
          + 'これを許すと DB に 1 行あるだけでデモが歯抜けになる');
      }
    }
    // 三項でも同じこと (`rows.length === 0 ? demo... : ...` の形)
    if (/length === 0\s*\?[^\n]*demo(MetricTrend|Latest|Notices|Dashboard)/.test(body)) {
      fails.push(`${f}: 件数で三項分岐してデモを出している — 上と同じ (仕様書 §2)`);
    }
  }

  /*
   * **資格は `demo-accounts.ts` が単独で持つこと。**
   * `demo-data.ts` は「何を見せるか」で、「誰に見せるか」を書く場所ではない。
   */
  if (!/BUILTIN_DEMO_UIDS/.test(code('src/lib/demo-accounts.ts'))) {
    fails.push('demo-accounts.ts に uid 一覧が無い');
  }
  if (/BUILTIN_DEMO_UIDS|DEMO_ALLOWED_UIDS/.test(code('src/lib/demo-data.ts'))) {
    fails.push('demo-data.ts が uid 一覧を持っている — 資格は demo-accounts.ts に一本化する');
  }

  /*
   * **PR 用アカウントは代理表示できないこと。**
   * `?u=` は admin だけの機能。デモ用アカウントは admin ではないので他人を覗けない。
   * 社外に渡すアカウントなので、ここが緩むと実顧客のデータに到達しうる。
   */
  if (!/isAdmin && requested && requested !== selfUid/.test(code('src/lib/viewer.ts'))) {
    fails.push('viewer.ts: `?u=` の代理表示が admin 限定でなくなっている'
      + ' — 社外に渡すデモ用アカウントが他人のデータを覗けてしまう');
  }
}

// ══════════════════════════════════════════════════════════════════════
// 3. 供給元が 3 つとも生きていること (和であって上書きでない)
// ══════════════════════════════════════════════════════════════════════
{
  const fn = acct.slice(acct.indexOf('function demoAccountUids('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  for (const [needle, why] of [
    ['BUILTIN_DEMO_UIDS', '組み込み (消えない下限)'],
    ['DEMO_ALLOWED_UIDS', 'env (DB 障害に影響されない)'],
    ["cfg('demo.account_uids')", 'app_config (admin から即時に増減)'],
  ]) {
    if (!body.includes(needle)) fails.push(`demoAccountUids() が ${why} を見ていない: ${needle}`);
  }
  // 和であること = キャッシュして固定しないこと (admin の登録が 45 秒で届くように)
  if (/cached|memo/i.test(body)) {
    fails.push('demoAccountUids() が結果をキャッシュしている'
      + ' — app_config は TTL 45 秒で入れ替わるので、固定すると admin の登録が反映されない');
  }

  // app_config にキーが登録されていること (無いと admin 画面に出ない)
  if (!read('src/lib/app-config.ts').includes("key: 'demo.account_uids'")) {
    fails.push('app-config.ts に demo.account_uids が無い — admin の設定画面に出ない');
  }

  // **データ取得より前に refreshConfig() を呼んでいること。**
  // 後ろだと初回リクエストで admin 画面からの登録が効かず、コード既定に落ちる。
  for (const f of ['src/pages/dashboard.astro', 'src/pages/report.astro',
                   'src/pages/trend.astro', 'src/pages/notices.astro', 'src/pages/kit.astro']) {
    const t = read(f);
    const iCfg = t.indexOf('await refreshConfig()');
    const iLoad = Math.min(...['await loadDashboard(', 'await loadNotices(']
      .map((n) => t.indexOf(n)).filter((i) => i >= 0).concat([Number.MAX_SAFE_INTEGER]));
    if (iCfg < 0) fails.push(`${f}: refreshConfig() を呼んでいない — app_config のデモ登録が効かない`);
    else if (iLoad !== Number.MAX_SAFE_INTEGER && iCfg > iLoad) {
      fails.push(`${f}: refreshConfig() がデータ取得より後ろ — 初回リクエストで登録が効かない`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// 4. admin 判定に名簿を持ち込まないこと (デモとは別件だが、同じ轍なので見張る)
// ══════════════════════════════════════════════════════════════════════
{
  const adminSrc = code('src/lib/admin-auth.ts');
  for (const name of ['ADMIN_MEMBERS', 'ADMIN_EMAILS', 'ADMIN_UIDS', 'isAdminUid']) {
    if (adminSrc.includes(`const ${name}`) || adminSrc.includes(`function ${name}`)) {
      fails.push(`admin-auth.ts: ベタ書きの管理者判定 ${name} が復活している`
        + ' — admin の正は wellfort-site の管理者リスト (admin_users) だけ');
    }
  }
  if (/isAdminUid\s*\(/.test(code('src/lib/viewer.ts'))) {
    fails.push('viewer.ts: uid の一覧で admin を判定している — URL に uid を書くだけで admin になれる');
  }
  if (/PUBLIC_SUPABASE_URL[\s\S]{0,400}admin_users/.test(adminSrc)) {
    fails.push('admin-auth.ts: 自前の Supabase から admin_users を直引きしている'
      + ' — 別プロジェクトなので必ず 404 になり、管理者が誰も admin にならない');
  }
  if (!/resolveCustomerWithAdmin/.test(adminSrc)) {
    fails.push('admin-auth.ts: HP Edge の resolveCustomerWithAdmin を使っていない'
      + ' — 顧客DB と管理者リストは Wellfort 側にしか無く、この経路が正');
  }
  if (!/payload\.is_admin/.test(code('src/lib/hp-edge.ts'))) {
    fails.push('hp-edge.ts: 応答の top-level is_admin を見ていない'
      + ' — 顧客レコードの無い管理者 (data: null) が admin になれない');
  }
}

// ══════════════════════════════════════════════════════════════════════
// 5. 旧形式 seed 行の回避が、必ずデモの内側にあること
// ══════════════════════════════════════════════════════════════════════
if (!/Array\.isArray\(row\.report\)\s*&&\s*shouldUseDemoData\(/.test(read('src/lib/elith-report-queries.ts'))) {
  fails.push('elith-report-queries.ts: 旧形式 seed 行の回避が無い、または'
    + ' shouldUseDemoData の外に出ている — 実顧客の実データを隠す危険');
}

// ══════════════════════════════════════════════════════════════════════
// 6. Google アカウント (メール) で登録する経路
// ══════════════════════════════════════════════════════════════════════
//
// 人が扱えるのはメールアドレスだけ。記者やパートナーに UUID は聞けない。
// ただし**毎リクエストの判定は uid のまま**にする (同期・外部依存ゼロを崩さない)。
{
  const resolveSrc = read('src/pages/api/auth/resolve.ts');
  const apiSrc = read('src/pages/api/admin/demo-accounts.ts');

  for (const name of ['hashEmail', 'linkDemoEmail', 'parseEmailEntries', 'serializeEmailEntries']) {
    if (!acct.includes(`export function ${name}`) && !acct.includes(`export async function ${name}`)) {
      fails.push(`demo-accounts.ts: ${name} が無い — メールで登録する経路が消えている`);
    }
  }

  /*
   * **突き合わせはサインインの経路でしかできない。**
   * サーバで検証済みの email と解決済みの uid が同時に存在するのはここだけ。
   * クライアントの申告した email で登録できてしまうと、誰でもデモを有効化できる。
   */
  if (!/linkDemoEmail\(/.test(resolveSrc)) {
    fails.push('api/auth/resolve.ts: linkDemoEmail を呼んでいない'
      + ' — メールで登録しても uid が埋まらず、本人がサインインしてもデモが出ない');
  }
  /*
   * **EC の顧客でない人に uid を与える処理が、未連携の早期 return より前にあること。**
   * 後ろにあると記者・パートナーは「お客様情報が見つかりませんでした」で入口で弾かれ、
   * デモ登録が何の役にも立たない (実測 2026-08-31)。
   */
  {
    /*
     * **2026-10-22 (PR-B)**: ここは `resolveDemoUidByEmail` の直呼びから
     * **canonical uid 層 (`resolveCanonicalUidByEmail`)** に変わった。
     * Demo と Real の名簿を**同時に**引くようになっただけで、**この節の要件は
     * 1 つも変わっていない** — ①記者・パートナーが入口で弾かれない
     * ②未連携の early return より前 ③`linkedUid` を渡す ④`findLinkedUid` が先。
     * デモ側の実挙動 (登録済みなら uid が出る) は `npm run verify:experience-accounts` ③
     * が実物を動かして見ている。
     */
    const iDemo = resolveSrc.indexOf('resolveCanonicalUidByEmail(email');
    const iBail = resolveSrc.indexOf('return json({ linked: false }');
    if (iDemo < 0) {
      fails.push('api/auth/resolve.ts: canonical uid 層 (resolveCanonicalUidByEmail) を呼んでいない'
        + ' — EC の顧客でないデモ用アカウント (記者・パートナー) が入口で弾かれる');
    } else if (iBail >= 0 && iDemo > iBail) {
      fails.push('api/auth/resolve.ts: canonical uid 層が未連携の early return より後ろ'
        + ' — そこまで到達しないので、デモ登録しても記者は入れない');
    }
    /*
     * **デモ枠が canonical 層から外れていないこと。**
     * Real 側だけを見る実装に変わると、デモ登録だけの記者が通らなくなる
     * (「どちらの名簿にも無い」と判定されて未連携へ落ちる)。
     */
    if (!/look\.demo\.registered/.test(read('src/lib/experience-accounts.ts'))
      || !/demoEmailEntries/.test(code('src/lib/experience-accounts.ts'))) {
      fails.push('experience-accounts.ts: canonical 層がデモの名簿を見ていない'
        + ' — デモ登録だけの記者が未連携へ落ちる');
    }
    /*
     * **既存の割り当てを渡すこと。** 渡さないと毎回新しい uid を作り、
     * `app_users.auth_user_id` の UNIQUE 制約に衝突してサインインが 500 で止まる。
     * しかも保存は後段の `linkDemoEmail` なので、**500 で止まると永久に直らない**
     * (2026-08-31 に本番で実測)。
     */
    if (!/resolveCanonicalUidByEmail\(email,\s*linkedUid\)/.test(resolveSrc)) {
      fails.push('api/auth/resolve.ts: canonical uid 層に既存の割り当て (linkedUid) を渡していない'
        + ' — 毎回新しい uid を作って app_users の UNIQUE 制約に衝突し、サインインが壊れる');
    }
    const iLinked = resolveSrc.indexOf('const linkedUid = await findLinkedUid(');
    if (iLinked < 0) {
      fails.push('api/auth/resolve.ts: findLinkedUid で既存の連携を引いていない');
    } else if (iDemo >= 0 && iLinked > iDemo) {
      fails.push('api/auth/resolve.ts: findLinkedUid が canonical uid 層より後ろ — 渡せていない');
    }
    // **生の Postgres メッセージを画面に出さない** (実際にサインイン画面へ出た)
    if (/app_users upsert: \$\{upErr\.message\}/.test(resolveSrc)) {
      fails.push('api/auth/resolve.ts: DB の生エラーを利用者に返している — ログへ回すこと');
    }
  }
  if (!/getUser|auth\/v1\/user/.test(resolveSrc)) {
    fails.push('api/auth/resolve.ts: email をサーバで検証していない'
      + ' — 申告された email で突き合わせると、誰でもデモを有効化できる');
  }

  /*
   * **毎リクエストの判定に email を持ち込まない。**
   * ハッシュ計算は async なので、ここに混ぜると判定が同期でなくなり
   * (~30 箇所の呼び出し側が全部 await になる)、TTL 内のキャッシュだけで
   * 済んでいた判定が DB 依存になる。
   */
  {
    const fn = acct.slice(acct.indexOf('export function isDemoAccount'));
    const body = fn.slice(fn.indexOf('{') + 1, fn.indexOf('\n}'));
    if (/email|hash/i.test(body)) {
      fails.push('isDemoAccount が email を見ている'
        + ' — 毎リクエストの判定は uid のまま (同期・外部依存ゼロ) にする');
    }
  }

  /*
   * **メールアドレスの現物を保存しないこと。**
   * PII は Wellfort 側にしか置かない取り決めがあり、`diagnosis` スキーマには置けない。
   * 保存するのは ①sha256 ②表示用マスク ③uid ④用途のメモ の 4 つだけ。
   */
  if (!/SHA-256/.test(acct)) fails.push('demo-accounts.ts: hashEmail が SHA-256 を使っていない');
  /*
   * **2026-10-22 (PR-B)**: 新規行の uid は `''` 固定ではなくなった
   * (Real 側に uid が在ればそれを**写す**)。**約束は同じ** — 保存してよいのは
   * hash / masked / uid / label の 4 つだけ。**フィールドの集合で見る**
   * (リテラルで固定すると、仕様が動いたときに意味のない FAIL になる)。
   */
  {
    const m = apiSrc.match(/emails\.push\(\{([^}]*)\}\)/);
    const fields = m ? m[1].split(',').map((x) => x.split(':')[0].trim()).filter(Boolean).sort() : [];
    if (JSON.stringify(fields) !== JSON.stringify(['hash', 'label', 'masked', 'uid'])) {
      fails.push(`api/admin/demo-accounts.ts: メール登録の保存内容が変わっている (${fields.join('/')})`
        + ' — 保存してよいのは hash / masked / uid / label だけ (現物のアドレスを残さない)');
    }
    // 値の側にも現物を入れていないこと (`masked` は `maskEmail(addr)` 経由のみ)。
    if (!/masked: maskEmail\(addr\)/.test(apiSrc)) {
      fails.push('api/admin/demo-accounts.ts: masked が maskEmail(addr) 経由でない'
        + ' — 現物のアドレスが保存形式に入り得る');
    }
  }
  /*
   * **デモ側で uid を新規発行しないこと** (PR-B)。
   * デモ枠の uid はサインイン時に決まる約束で、admin の登録時に発行すると
   * **UID を増やす側に倒れる** (1 人 1 uid が崩れる)。
   */
  if (/crypto\.randomUUID|mintSpecialUid/.test(code('src/pages/api/admin/demo-accounts.ts'))) {
    fails.push('api/admin/demo-accounts.ts: デモの登録で uid を採番している'
      + ' — デモの uid はサインイン時に決まる (採番の口は canonical 層だけ)');
  }
  if (/`\$\{[a-zA-Z]*[eE]mail\}`|email: (addr|email)\b/.test(code('src/lib/demo-accounts.ts'))) {
    fails.push('demo-accounts.ts: メールアドレスの現物を保存形式に入れている');
  }

  /*
   * **サインイン済みの状態は「記録」であって「推測」ではない。**
   * 以前はラベルの一致で推測しており、ラベルを書き換えると黙って誤判定した。
   */
  if (!/linked: !!e\.uid && known\.has\(e\.uid\)/.test(acct)) {
    fails.push('listDemoAccounts: linked をラベル等から推測している'
      + ' — 突き合わせた uid そのものを見ること');
  }

  /*
   * **メール登録から来た uid は uid 側だけで外せないこと。**
   * 外しても次のサインインで `linkDemoEmail` が書き直すため、
   * 外したつもりが数分後に復活する = 黙って効かない操作になる。
   */
  if (!/メール登録 \(\$\{src\.masked\}\) から来ている/.test(apiSrc)) {
    fails.push('api/admin/demo-accounts.ts: メール登録由来の uid を uid 側から外せてしまう'
      + ' — 次のサインインで復活するので、メール行の側で外させる');
  }

  for (const k of ['demo.account_emails', 'demo.account_denied_uids', 'demo.seeded_from_admins']) {
    if (!read('src/lib/app-config.ts').includes(`key: '${k}'`)) {
      fails.push(`app-config.ts に ${k} が無い — setConfig が未知キーとして弾く`);
    }
  }

  /*
   * **管理者リストからの登録は「初回だけ」であること。**
   * 毎回走らせると、画面から外した人が次のアクセスで黙って戻り、「外す」が効かなくなる。
   * 目印は `demo.seeded_from_admins`。**一度入ったら上書きしない。**
   */
  if (!/markSeeded && !cur\.seededFromAdmins/.test(apiSrc)) {
    fails.push('api/admin/demo-accounts.ts: 初回登録の目印を上書きしている'
      + ' — 管理者リストからの自動登録が繰り返され、外した人が黙って戻る');
  }
  /*
   * 画面は **2026-10-22 (PR-E) で `/admin/experience-accounts` へ統合した**
   * (デモ／スペシャルを 1 枚・1 人 1 行。旧 2 URL は redirect)。
   * **読む先を直さないと、空のリダイレクトを検査して落ちる。**
   * 「管理者リストからの初回登録はデモ枠だけ」という約束は変わっていない。
   */
  const page = '../wellfort-site/src/pages/admin/experience-accounts.astro';
  try {
    const pg = readFileSync(resolve(ROOT, page), 'utf8');
    // 統合画面は一覧を 2 本引くので、目印は統合一覧 (`ex`) から読む。
    if (!/![a-z]+\.seededFromAdmins/.test(pg)) {
      fails.push(`${page}: 自動登録が目印を見ていない — 毎回走ると「外す」が効かなくなる`);
    }
    /*
     * **管理者名簿は Wellfort 側にしかない。** この画面が `admin_users` を引いて
     * メールとして送る。Scan-Chat-AI 側に名簿を持たせない (PII 境界)。
     */
    if (!/admin_users\?is_active=eq\.true/.test(pg)) {
      fails.push(`${page}: 有効な管理者だけを引いていない (is_active=eq.true)`);
    }
    // **氏名を送らない。** ラベルは PII を含めない固定文言にする。
    if (/label: *a\.name|name: *a\.name/.test(pg)) {
      fails.push(`${page}: 管理者の氏名をデモ登録のメモに入れている — PII は載せない`);
    }
  } catch {
    // wellfort-site を並べて clone していない環境ではスキップ (CI の片側実行を壊さない)
    console.log('  (wellfort-site が隣に無いので admin 画面のチェックはスキップ)');
  }
}

// ══════════════════════════════════════════════════════════════════════
// 7. メール登録を**実際に動かして**確かめる
// ══════════════════════════════════════════════════════════════════════
//
// 上の 1〜6 は「そう書いてあるか」を見るだけで、**動かしていない**。
// ここは `demo-accounts.ts` の実物を transpile して呼ぶ。
// app_config だけ差し替えるので DB は要らない (値の出入りを完全に握れる)。
//
// **とくに見たいのは「現物のアドレスが保存物のどこにも出てこないこと」。**
// これは目視では抜けるし、抜けても画面は正常に見える。
await (async () => {
  const ts = (await import('typescript')).default;
  const { writeFileSync, mkdirSync } = await import('node:fs');

  let s = read('src/lib/demo-accounts.ts')
    .replace(/import \{[^}]*\} from '\.\/app-config';/, `
export const __store = { 'demo.account_uids': '', 'demo.account_emails': '' };
export const __writes = [];
export const __forced = [];   // refreshConfig(true) = DB 往復を強制した回数
const cfg = (k) => __store[k] ?? '';
const refreshConfig = async (force) => { if (force) __forced.push(1); };
const setConfig = async (u) => { __writes.push(u); Object.assign(__store, u); return { ok: true }; };
`)
    .replace(/import\.meta\.env\.(\w+)/g, 'globalThis.__demoEnv.$1');
  if (!s.includes('__store')) { fails.push('verify: app-config の差し替えに失敗 (import 文の形が変わった)'); return; }

  globalThis.__demoEnv = {};
  const out = resolve(ROOT, 'node_modules/.cache/verify-demo-accounts.mjs');
  mkdirSync(resolve(ROOT, 'node_modules/.cache'), { recursive: true });
  writeFileSync(out, ts.transpileModule(s, { compilerOptions: { target: 'ES2022', module: 'ESNext' } }).outputText);
  const M = await import(`${out}?t=${Date.now()}`);

  const eq = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fails.push(`${label} — got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  };

  const MAIL = 'reporter@example.com';
  const UID = 'bbbbbbbb-1111-2222-3333-444444444444';

  console.log('\nメール登録の実挙動\n');
  const h = await M.hashEmail('  Reporter@Example.com ');
  eq('大文字/空白の違いを吸収して同じ人と分かる', h, await M.hashEmail(MAIL));
  eq('別アドレスは別ハッシュ', h === (await M.hashEmail('other@example.com')), false);
  eq('マスクから現物は復元できない', M.maskEmail(MAIL), 'r*******@example.com');

  const pending = [{ hash: h, masked: M.maskEmail(MAIL), uid: '', label: '○○新聞 取材' }];
  const ser = M.serializeEmailEntries(pending);
  eq('uid 未確定でも列がずれない', ser.split(/\s+/)[2], '-');
  eq('保存形式の往復 (サインイン前)', M.parseEmailEntries(ser), pending);
  eq('壊れた行があっても一覧が全滅しない', M.parseEmailEntries('ゴミ\n\n' + ser).length, 1);

  M.__store['demo.account_emails'] = ser;
  M.__store['demo.account_uids'] = '';
  M.__writes.length = 0;

  M.__forced.length = 0;
  eq('登録の無い人は素通り', await M.linkDemoEmail('nobody@example.com', UID), false);
  eq('  → 書き込みに行かない (全ユーザーが通る経路なので)', M.__writes.length, 0);
  /*
   * **登録の無い人＝ほぼ全員。** ここで `refreshConfig(true)` を呼ぶと
   * サインインのたびに DB 往復が 1 回増える。TTL 尊重の `refreshConfig()` で足りる
   * (登録直後の反映が最大 45 秒遅れるだけ = 他の app_config と同じ約束)。
   */
  eq('  → DB 往復を強制しない (サインインは全員が通る)', M.__forced.length, 0);

  eq('登録済みの人がサインイン → 突き合わせ成立', await M.linkDemoEmail(MAIL, UID), true);
  eq('  → その場でデモ対象になる', M.isDemoAccount(UID), true);
  eq('  → uid 側の一覧に写る', M.parseEntries(M.__store['demo.account_uids']).map((e) => e.uid), [UID]);
  // **落ちずに報告する。** ここで例外を投げると後続のチェックが走らず、
  // 「1 件壊れている」のか「全部壊れている」のかが分からなくなる。
  eq('  → メール行に uid が記録される', M.parseEmailEntries(M.__store['demo.account_emails'])[0]?.uid, UID);
  // **これが一番大事。** 保存物のどこにも現物が無いこと。
  eq('  → 現物のアドレスは保存物のどこにも無い', /reporter@example\.com/.test(JSON.stringify(M.__store)), false);

  const n = M.__writes.length;
  eq('2 回目以降のサインインは何も書かない', await M.linkDemoEmail(MAIL, UID), true);
  eq('  → 書き込み回数が増えない', M.__writes.length, n);

  const list = M.listDemoAccounts();
  eq('admin 画面: 「サインイン済み」が立つ', list.emails.map((e) => e.linked), [true]);
  eq('admin 画面: uid 行にメール由来の印が付く',
    list.rows.filter((r) => r.uid === UID).map((r) => r.viaEmail), [true]);
  eq('admin 画面: 組み込みの行には印が付かない',
    list.rows.filter((r) => r.source === 'builtin').every((r) => !r.viaEmail), true);

  // ラベルは admin が書き換えられる。**推測でなく記録**を見ていることの確認。
  M.__store['demo.account_uids'] = `${UID}  # 別のメモに書き換えた`;
  eq('ラベルを書き換えても状態を誤らない', M.listDemoAccounts().emails[0]?.linked, true);
  M.__store['demo.account_uids'] = '';
  eq('uid を外せば「サインイン待ち」に戻る', M.listDemoAccounts().emails[0]?.linked, false);

  globalThis.__demoEnv.PUBLIC_DEMO_FALLBACK = 'false';
  eq('全停止スイッチが効く', M.demoDisabledGlobally(), true);
  globalThis.__demoEnv.PUBLIC_DEMO_FALLBACK = undefined;

  /*
   * ── 除外リスト ──────────────────────────────────────────────
   *
   * 発注者指示 2026-08-30「削除のできるようにして」。
   * 組み込み / env は供給元を書き換えられないので、**引き算で止める**。
   * 供給元は残るので「戻す」で元どおりになる。
   */
  console.log('\n除外リスト（どの行も外せること）\n');
  const BUILT = BUILTIN[0];
  M.__store['demo.account_uids'] = '';
  M.__store['demo.account_emails'] = '';
  M.__store['demo.account_denied_uids'] = '';

  eq('組み込みは既定で出る', M.isDemoAccount(BUILT), true);
  M.__store['demo.account_denied_uids'] = BUILT;
  eq('**組み込みでも除外できる**（画面から外せる）', M.isDemoAccount(BUILT), false);
  eq('  → 一覧には残り「除外中」と分かる',
    M.listDemoAccounts().rows.filter((r) => r.uid === BUILT).map((r) => r.denied), [true]);
  M.__store['demo.account_denied_uids'] = '';
  eq('  → 戻せば元どおり（供給元を消していない）', M.isDemoAccount(BUILT), true);

  // メール登録で入った uid も止められること
  M.__store['demo.account_uids'] = UID;
  M.__store['demo.account_denied_uids'] = `${UID}  # PR 終了`;
  eq('メール登録から来た uid も止められる', M.isDemoAccount(UID), false);
  eq('注釈つきでも除外が効く（`#` を uid と読まない）', M.isDemoAccount(UID), false);
  M.__store['demo.account_denied_uids'] = '';

  // 除外は**和のあと**。順序を逆にすると config で足し直せてしまう。
  M.__store['demo.account_uids'] = BUILT;
  M.__store['demo.account_denied_uids'] = BUILT;
  eq('除外は和のあと（config で足し直しても復活しない）', M.isDemoAccount(BUILT), false);

  /*
   * ── EC の顧客でない人（記者・パートナー）─────────────────────
   *
   * `resolve-customer` では引けないので uid が決まらず、そのままだと
   * 「お客様情報が見つかりませんでした」で入口で弾かれる（実測 2026-08-31）。
   * デモ登録されている人にだけ uid を与えて通す。
   */
  console.log('\nEC の顧客でないデモ用アカウント（記者・パートナー）\n');
  M.__store['demo.account_uids'] = '';
  M.__store['demo.account_denied_uids'] = '';
  M.__store['demo.account_emails'] = '';

  eq('登録の無い人には uid を与えない（従来どおり未連携）',
    await M.resolveDemoUidByEmail('stranger@example.com'), null);

  M.__store['demo.account_emails'] =
    M.serializeEmailEntries([{ hash: h, masked: M.maskEmail(MAIL), uid: '', label: '○○新聞 取材' }]);
  const minted = await M.resolveDemoUidByEmail(MAIL);
  eq('登録済みの人には uid を与える', /^[0-9a-f-]{36}$/.test(String(minted)), true);

  /*
   * **既にこの Google アカウントに uid が割り当てられていたら、それを使う。**
   * ここで新しい uid を作ると `app_users.auth_user_id` の UNIQUE 制約に衝突し、
   * サインインが 500 で止まる (2026-08-31 に本番で実測。しかも保存は後段なので
   * 毎回新しい uid が作られて永久に直らなかった)。
   */
  const EXIST = 'cccccccc-1111-2222-3333-444444444444';
  eq('既存の uid があればそれを使う (新しく作らない)',
    await M.resolveDemoUidByEmail(MAIL, EXIST), EXIST);
  eq('  → 登録の無い人には既存 uid があっても与えない',
    await M.resolveDemoUidByEmail('stranger@example.com', EXIST), null);

  // 与えた uid を linkDemoEmail が保存する（書き込み口を 2 つに増やさない）
  await M.linkDemoEmail(MAIL, minted);
  eq('  → その uid でデモが出る', M.isDemoAccount(minted), true);
  /*
   * **2 回目のサインインで uid が変わらないこと。** 変わると `app_users` に
   * 行が増え続け、前回まで見えていたものと繋がらなくなる。
   */
  eq('  → 次のサインインでも同じ uid', await M.resolveDemoUidByEmail(MAIL), minted);
  eq('  → 現物のアドレスは保存物のどこにも無い',
    /reporter@example\.com/.test(JSON.stringify(M.__store)), false);
})();

// ══════════════════════════════════════════════════════════════════════
console.log('\nダミーデータを出すか (◯=出す / ✗=出さない)\n');
for (const [label, uid, envFalse, extra, want] of cases) {
  const got = expected(uid, envFalse, extra);
  const ok = got === want;
  if (!ok) fails.push(`${label}: 期待 ${want} / 規則 ${got}`);
  console.log(`  ${ok ? '✓' : '✗'} ${label}  → ${got ? '◯' : '✗'}`);
}

console.log(`\n組み込みのデモ用アカウント: ${BUILTIN.length} 件`);
console.log('  追加は wellfort-site admin →「デモ用アカウント」で相手の Google アカウントを登録 (再デプロイ不要)');
console.log('  uid は本人のサインイン時に自動で埋まる。env DEMO_ALLOWED_UIDS でも足せる');
console.log('  全停止は env PUBLIC_DEMO_FALLBACK=false');

if (fails.length) {
  console.log(`\n✗ ${fails.length} 件`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\n✓ デモ用アカウントだけがダミーを見る。admin であることは資格にならない。');
console.log('  デモ用アカウントと管理者アカウントは別物 — PR 用は社外に渡るので混ぜない。');
