#!/usr/bin/env node
/**
 * `npm run verify:experience-admin` — **1 人 1 行の統合一覧 (PR-E) の回帰チェック**。
 *
 * 正本 `docs/specs/special_demo_integration_spec_20261022.md` §4.5 (＋裁定 7)。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【守るもの】**同じ人が 2 行に割れないこと／uid の食い違いを隠さないこと**
 * ══════════════════════════════════════════════════════════════════════
 *
 * PR-B で Dual が正常な状態になったので、admin は**1 人を 1 行で**見る必要がある。
 * **ここは静かに壊れる**:
 *   - 束ね方を間違えると**同じ人が 2 行**に出て、片方だけ外して「外した」と思える
 *   - 競合 (uid 食い違い) を自動でどちらかに寄せると、**人が判断する機会が消える**
 *   - 畳めなかった uid 行を捨てると、**資格を持っている人が一覧から消える**
 *   - PII (メールの現物・生年月日の実値) が混ざっても**画面は正常に見える**
 *
 * だから**実物を動かして**束ね方・資格・PII を見る。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
/** コメント行を落とす (経緯の説明に旧コードの名前が書いてあるため)。 */
const code = (p) => read(p).split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');

const fails = [];
let pass = 0;
const ts = (await import('typescript')).default;
const CACHE = resolve(ROOT, 'node_modules/.cache');
mkdirSync(CACHE, { recursive: true });
const js = (src) => ts.transpileModule(src, { compilerOptions: { target: 'ES2022', module: 'ESNext' } }).outputText;

const ok = (label, cond, why) => {
  if (cond) pass++; else fails.push(`${label}${why ? ` — ${why}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
function summary() {
  console.log(`\n${fails.length === 0 ? '✅' : '❌'} verify:experience-admin — ${pass} / ${pass + fails.length}`);
  if (fails.length) {
    console.log('\n落ちた検査:');
    for (const f of fails) console.log(`  - ${f}`);
    process.exit(1);
  }
}

// ══════════════════════════════════════════════════════════════════════
// 実物を動かす器 (app_config だけスタブ・判定も束ね方も実物)
// ══════════════════════════════════════════════════════════════════════
const M = await (async () => {
  writeFileSync(resolve(CACHE, 'ea-app-config.mjs'), `
export const __store = {};
export const cfg = (k) => __store[k] ?? '';
export const refreshConfig = async () => {};
export const setConfig = async (u) => { Object.assign(__store, u); return { ok: true }; };
`);
  const swap = (s) => js(s
    .replace(/from '\.\/app-config'/g, "from './ea-app-config.mjs'")
    .replace(/from '\.\/demo-accounts'/g, "from './ea-demo-accounts.mjs'")
    .replace(/from '\.\/special-accounts'/g, "from './ea-special-accounts.mjs'")
    .replace(/from '\.\/experience-accounts'/g, "from './ea-experience-accounts.mjs'")
    .replace(/import\.meta\.env\.(\w+)/g, 'globalThis.__eaEnv.$1')
    .replace(/import\.meta\.env/g, 'globalThis.__eaEnv'));
  const files = {
    'ea-demo-accounts.mjs': 'src/lib/demo-accounts.ts',
    'ea-special-accounts.mjs': 'src/lib/special-accounts.ts',
    'ea-experience-accounts.mjs': 'src/lib/experience-accounts.ts',
    'ea-experience-admin.mjs': 'src/lib/experience-admin.ts',
  };
  for (const [out, src] of Object.entries(files)) {
    const body = swap(read(src));
    /*
     * **差し替え漏れを名指しで落とす。** 残っていると Node が
     * `ERR_MODULE_NOT_FOUND` でスクリプトごと落ち、どの検査が落ちたか分からなくなる
     * (PR-D の verify で実際に踏んだ形)。
     */
    const leftover = [...body.matchAll(/from ["'](\.\/[^"']*)["']/g)]
      .map((m) => m[1]).filter((s) => !s.endsWith('.mjs'));
    if (leftover.length) {
      ok(`${src} の相対 import は全て差し替え済み`, false,
        `残り: ${leftover.join(', ')} — import の形が変わった`);
      summary();
    }
    writeFileSync(resolve(CACHE, out), body);
  }
  globalThis.__eaEnv = {};
  return {
    ...(await import(resolve(CACHE, 'ea-experience-admin.mjs'))),
    store: await import(resolve(CACHE, 'ea-app-config.mjs')),
  };
})();

/**
 * **組み込みのデモ uid は常に一覧へ出る** (`BUILTIN_DEMO_UIDS` = 消えない下限)。
 * 件数の期待値はここから出す — ベタ書きにすると、下限が増えた日に
 * **検査が落ちるだけで何も守らない**。
 */
const BUILTIN = (() => {
  const m = /BUILTIN_DEMO_UIDS\s*:\s*readonly string\[\]\s*=\s*\[([\s\S]*?)\]/.exec(read('src/lib/demo-accounts.ts'));
  const got = [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
  if (got.length === 0) {
    // **0 件で先へ進めない。** 期待値が黙って緩み、件数の検査が無意味になる。
    ok('verify: BUILTIN_DEMO_UIDS を読めた', false, '宣言の形が変わった');
    summary();
  }
  return got;
})();

const H = (n) => String(n).repeat(64).slice(0, 64);
const HASH_A = H('a');
const HASH_B = H('b');
const HASH_C = H('c');
const UID_X = 'aaaaaaaa-1111-4111-8111-111111111111';
const UID_Y = 'bbbbbbbb-2222-4222-8222-222222222222';
const UID_Z = 'cccccccc-3333-4333-8333-333333333333';

/** app_config をまるごと差し替えてから一覧を組む。 */
const listWith = (cfg) => {
  for (const k of Object.keys(M.store.__store)) delete M.store.__store[k];
  Object.assign(M.store.__store, cfg);
  return M.listExperienceAccounts();
};
const rowOf = (list, key) => list.rows.find((r) => r.key === key);

// ══════════════════════════════════════════════════════════════════════
// ① 1 人 1 行 — 同じメールが両方の名簿に在れば 1 行
// ══════════════════════════════════════════════════════════════════════
console.log('\n① 1 人 1 行 (メールの sha256 で束ねる)\n');
{
  const list = listWith({
    'special.account_emails': `${HASH_A} a***@example.com ${UID_X} # 招待 A`,
    'demo.account_emails': `${HASH_A} a***@example.com ${UID_X} # お披露目 A`,
    'special.account_uids': `${UID_X} 招待 A`,
    'demo.account_uids': `${UID_X} お披露目 A`,
  });
  eq('メール 1 人は 1 行 (2 行に割れない)', list.rows.filter((r) => r.kind === 'email').length, 1);
  eq('  行の総数は 1 人 + 組み込みのデモ uid', list.rows.length, 1 + BUILTIN.length);
  const r = rowOf(list, HASH_A);
  eq('  canonical uid', r?.uid, UID_X);
  eq('  Real も Demo も登録済み', [r?.special.registered, r?.demo.registered], [true, true]);
  eq('  **資格は両方 = Dual (正常な状態)**', [r?.canReal, r?.canDemo, r?.dual], [true, true, true]);
  eq('  競合ではない (同じ uid)', r?.conflict, null);
  eq('  メモは Real 側を優先', r?.label, '招待 A');
  eq('  件数', [list.counts.total, list.counts.dual, list.counts.conflicts],
    [1 + BUILTIN.length, 1, 0]);
}

// ══════════════════════════════════════════════════════════════════════
// ② uid の食い違いを隠さない (自動でどちらかに寄せない)
// ══════════════════════════════════════════════════════════════════════
console.log('\n② 競合 (uid 食い違い)\n');
{
  const list = listWith({
    'special.account_emails': `${HASH_A} a***@example.com ${UID_X} # 招待 A`,
    'demo.account_emails': `${HASH_A} a***@example.com ${UID_Y} # お披露目 A`,
    'special.account_uids': `${UID_X} 招待 A`,
    'demo.account_uids': `${UID_Y} お披露目 A`,
    // 競合の下に普通の行を置いて、並び順も見る。
    'demo.account_emails\u0000x': '',
  });
  const r = rowOf(list, HASH_A);
  ok('競合が出る', !!r?.conflict);
  eq('  どちらの uid も隠さない', [r?.conflict?.specialUid, r?.conflict?.demoUid], [UID_X, UID_Y]);
  eq('  件数に出る', list.counts.conflicts, 1);
  /*
   * **「正しい uid」を機械が決めない** (裁定 6 / 絶対条件 10)。表示用の
   * `uid` は Real 側を採るが、**競合の事実は必ず残る**ので画面が黙らない。
   */
  eq('  表示 uid は Real 側 (resolveCanonicalUidByEmail と同じ順序)', r?.uid, UID_X);
  ok('自動統合しない (uid を書き換える口がこの層に無い)',
    !/setConfig\s*\(/.test(code('src/lib/experience-admin.ts')),
    'この層は読むだけ。書くと裁定 7 の「UID 分裂の経路」が増える');
}
{
  /*
   * 競合の行は一覧の先頭 (人が見るべき行を埋めない)。
   *
   * **競合の行の鍵を、普通の行より「後ろ」にする。** 同順位の並びは鍵順なので、
   * 競合の行の鍵を先にすると**並び替えを外しても偶然先頭に来て検査が通る**
   * (退行注入で実際に素通りした)。
   */
  const list = listWith({
    'special.account_emails': [
      `${HASH_A} a***@example.com ${UID_Z} # 普通の人`,
      `${HASH_B} b***@example.com ${UID_X} # 競合の人`,
    ].join('\n'),
    'demo.account_emails': `${HASH_B} b***@example.com ${UID_Y} # 競合の人`,
    'special.account_uids': [`${UID_Z} 普通`, `${UID_X} 競合`].join('\n'),
    'demo.account_uids': `${UID_Y} 競合`,
  });
  ok('verify: 競合の鍵は普通の行より後ろ (偶然で通らないように)', HASH_B > HASH_A);
  eq('競合の行が先頭に来る', list.rows[0]?.key, HASH_B);
}

// ══════════════════════════════════════════════════════════════════════
// ③ uid 行の扱い — 畳める／畳めなければ独立した行 (黙って捨てない)
// ══════════════════════════════════════════════════════════════════════
console.log('\n③ uid 行\n');
{
  const list = listWith({
    'special.account_emails': `${HASH_A} a***@example.com ${UID_X} # 招待 A`,
    'special.account_uids': [`${UID_X} 招待 A`, `${UID_Z} uid だけ足した人`].join('\n'),
  });
  eq('行は メール行 1 + uid だけ 1 (+ 組み込み)', list.rows.length, 2 + BUILTIN.length);
  const folded = rowOf(list, HASH_A);
  eq('  メール行の uid 行は畳まれる (2 行に割れない)', folded?.special.source, 'config');
  const only = rowOf(list, UID_Z);
  ok('  **畳めない uid 行は捨てずに出す**', !!only, '捨てると資格を持つ人が一覧から消える');
  eq('  その行は uid 由来だと分かる', [only?.kind, only?.uid, only?.hash], ['uid', UID_Z, '']);
  eq('  資格は立っている', [only?.canReal, only?.canDemo], [true, false]);
}

// ══════════════════════════════════════════════════════════════════════
// ④ 資格は「登録済み」ではなく資格の関数が決める
// ══════════════════════════════════════════════════════════════════════
console.log('\n④ 資格 (registered と canXxx は別)\n');
{
  // メール登録だけで uid 未発行 → 資格は立たない (「ID が未発行」)。
  const list = listWith({ 'special.account_emails': `${HASH_A} a***@example.com - # uid 未発行` });
  const r = rowOf(list, HASH_A);
  eq('登録済みでも uid が無ければ資格は立たない', [r?.special.registered, r?.canReal], [true, false]);
  eq('  uid は空', r?.uid, '');
}
{
  // 除外リストに入っている人は資格が止まる。
  const list = listWith({
    'special.account_emails': `${HASH_A} a***@example.com ${UID_X} # 招待 A`,
    'special.account_uids': `${UID_X} 招待 A`,
    'special.account_denied_uids': UID_X,
  });
  const r = rowOf(list, HASH_A);
  eq('除外中は資格が止まる', r?.canReal, false);
  eq('  除外中であることを画面に出せる', r?.special.denied, true);
  eq('  登録自体は残っている (戻せる)', r?.special.registered, true);
}
{
  /*
   * **全停止 (`PUBLIC_DEMO_FALLBACK=false`) は「資格」を消さない。**
   * `experienceCapabilities` は名簿に在るかだけを見る (= 資格) 設計で、
   * 「いま実際にダミーが出るか」は `shouldUseDemoData` が
   * `demoDisabledGlobally()` と AND して決める (PR-C)。
   * **一覧はその 2 つを別々に出す** — 混ぜると admin が
   * 「デモ可なのに出ない」の理由を追えない。
   */
  globalThis.__eaEnv = { PUBLIC_DEMO_FALLBACK: 'false' };
  const list = listWith({
    'demo.account_emails': `${HASH_A} a***@example.com ${UID_X} # 記者`,
    'demo.account_uids': `${UID_X} 記者`,
    'special.account_emails': `${HASH_B} b***@example.com ${UID_Z} # 招待`,
    'special.account_uids': `${UID_Z} 招待`,
  });
  eq('全停止中でも「資格」は立ったまま', rowOf(list, HASH_A)?.canDemo, true);
  eq('  **全停止は別のフラグで分かる**', list.demoDisabledGlobally, true);
  eq('  Real は影響を受けない', rowOf(list, HASH_B)?.canReal, true);
  globalThis.__eaEnv = {};
  eq('  スイッチを戻せば false', listWith({}).demoDisabledGlobally, false);
}
{
  const list = listWith({
    'demo.account_emails': `${HASH_A} a***@example.com ${UID_X} #`,
    'demo.account_uids': `${UID_X} 記者`,
    'special.account_emails': `${HASH_B} b***@example.com ${UID_Z} #`,
    'special.account_uids': `${UID_Z} 招待`,
    'special.account_emails\u0000': '',
  });
  eq('件数の内訳 (デモだけ = 1 人 + 組み込み)',
    [list.counts.demoOnly, list.counts.realOnly, list.counts.dual],
    [1 + BUILTIN.length, 1, 0]);
}

// ══════════════════════════════════════════════════════════════════════
// ⑤ PII — 現物を 1 文字も返さない
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑤ PII (現物を返さない)\n');
{
  const list = listWith({
    'special.account_emails': `${HASH_A} a***@example.com ${UID_X} # 招待 A`,
    'special.account_uids': `${UID_X} 招待 A`,
    'special.account_dob': `${HASH_A} 1970-03-04 male`,
  });
  const r = rowOf(list, HASH_A);
  const dumped = JSON.stringify(list);
  eq('生年月日は「登録済み」とマスクだけ', [r?.hasDob, r?.dobMasked, r?.sex], [true, '****-**-**', 'male']);
  ok('**生年月日の実値が応答に無い**', !dumped.includes('1970-03-04'), dumped.slice(0, 200));
  ok('生テキスト (emailsRaw / dobRaw / configRaw) を返さない',
    !/emailsRaw|dobRaw|configRaw|deniedRaw/.test(dumped));
  ok('マスクは返る (誰の行か分かる)', r?.masked === 'a***@example.com');
  // 現物のアドレスを混ぜる経路が無いこと (ハッシュ化の前の値を持たない)。
  ok('この層は `hashEmail` を呼ばない (現物を受け取らない)',
    !/hashEmail/.test(code('src/lib/experience-admin.ts')),
    '現物を受け取るのは登録の口だけ');
}

// ══════════════════════════════════════════════════════════════════════
// ⑥ 読むだけの口 — 書き込みと採番をここに作らない (裁定 7)
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑥ 読むだけ (裁定 7)\n');
{
  const api = 'src/pages/api/admin/experience-accounts.ts';
  /*
   * **import 行を落としてから位置を見る。** 落とさないと `isAdminAuthorized` が
   * 冒頭の import 行に当たり、**認可を後ろへ動かしても index 比較が通る**
   * (退行注入で実際に素通りした。`verify:external-id-capture` が踏んだのと同じ穴)。
   */
  const src = code(api).split('\n').filter((ln) => !/^\s*import\b/.test(ln)).join('\n');
  ok('GET だけを公開している', /export const GET/.test(src));
  ok('**POST を作っていない**', !/export const (POST|PUT|PATCH|DELETE)/.test(src),
    '書き込みを足すと uid を決める口が 2 つになる');
  ok('認可は他の admin API と同じ `isAdminAuthorized`', /isAdminAuthorized\(request\)/.test(src));
  ok('  認可は一覧の取得より前', src.indexOf('isAdminAuthorized') < src.indexOf('listExperienceAccounts'));
  ok('最新を取りに行ってから返す (`refreshConfig(true)`)', /refreshConfig\(true\)/.test(src));
  ok('  それは一覧を組む前', src.indexOf('refreshConfig(true)') < src.indexOf('listExperienceAccounts('));
  for (const f of ['src/lib/experience-admin.ts', api]) {
    ok(`${f.split('/').pop()} が uid を採番しない`,
      !/mintSpecialUid|randomUUID/.test(code(f)),
      '採番の口は canonical 層 1 つだけ (裁定 7)');
    ok(`  ${f.split('/').pop()} が app_config を書かない`, !/setConfig\s*\(/.test(code(f)));
  }
  /*
   * **旧 API は canonical 層を通り続けること** (裁定 7「旧 API 経由で
   * UID 分裂を再発させない」)。PR-B で入れた形が外れていないかを見る。
   */
  for (const f of ['src/pages/api/admin/demo-accounts.ts', 'src/pages/api/admin/special-accounts.ts']) {
    ok(`旧 API ${f.split('/').pop()} が canonical 層を通る`,
      /canonicalUidForRegistration\(/.test(code(f)));
    ok(`  ${f.split('/').pop()} が採番を直に呼ばない`,
      !/mintSpecialUid\(/.test(code(f)));
  }
}

// ══════════════════════════════════════════════════════════════════════
// ⑦ 判定を 2 つ持たない (資格・競合は既存の層に委ねる)
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑦ 判定の置き場所\n');
{
  const src = code('src/lib/experience-admin.ts');
  ok('資格は `experienceCapabilities` を通す', /experienceCapabilities\(/.test(src));
  ok('  資格の関数を直に呼んでいない', !/\bisDemoAccount\s*\(|\bisSpecialAccount\s*\(/.test(src),
    '判定を 2 つ持つと画面と本番で食い違う');
  ok('競合は `detectConflict` を通す', /detectConflict\(/.test(src));
  ok('  競合の定義をここに書き直していない', !/!==\s*specialUid|demoUid\s*!==/.test(src));
  ok('名簿は既存の一覧関数から読む',
    /listDemoAccounts\(\)/.test(src) && /listSpecialAccounts\(\)/.test(src));
  ok('`parseEmailEntries` を自前で呼び直していない', !/parseEmailEntries\(/.test(src),
    '名簿の読み方を 2 つ持たない');
}

summary();
