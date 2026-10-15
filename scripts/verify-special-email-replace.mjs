#!/usr/bin/env node
/**
 * `npm run verify:special-email-replace` — **登録メールの差し替え (uid 固定)** の回帰チェック。
 *
 * 正本: `docs/operations/スペシャルアカウント_仕様書.md`。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【何を守るか】**`diagnostic_user_id` が変わらないこと。**
 * ══════════════════════════════════════════════════════════════════════
 * `remove_email` → `add_email` の 2 段でメールを直すと、remove が uid を資格一覧から
 * 外し、add が「新規」と判定して `mintSpecialUid()` で**別 uid を採番する**。
 * uid が変わると `test_artifacts` / `diagnosis_results` / 報告書 PDF の紐付けが全部外れる。
 * **画面は正常に見えるのに中身が別人になる**ので目視では守れない。
 *
 * 検査は「そう書いてあるか」で済ませず、**実物 (`special-email-replace.ts`) を
 * transpile して動かす**。API 側は構造 (保存キー・保存回数・ガードの順序) を見る。
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

const ok = (label, cond, detail = '') => {
  if (!cond) fails.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want),
  JSON.stringify(got) === JSON.stringify(want) ? '' : `got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);

const H = (n) => String(n).repeat(64).slice(0, 64);
const OLD_A = H('a'), NEW_A = H('b'), OTHER = H('c'), NEW_B = H('d');
const UID_A = 'dfad9edd-2828-4227-ad54-63cbffc3bcf8';
const UID_B = '4e7d49d9-9487-4205-8556-324ec507e515';

// ── 実物を読み込む (純ロジックなので DB も鍵も要らない) ──────────────
const P = await (async () => {
  const out = resolve(CACHE, 'ser-plan.mjs');
  writeFileSync(out, js(read('src/lib/special-email-replace.ts')));
  return import(out);
})();

const base = () => ({
  emails: [
    { hash: OLD_A, masked: 'h*******i@transcosmos.com', uid: UID_A, label: 'トランスコスモス 2026-10' },
    { hash: OTHER, masked: 'y*****u@transcosmos.com', uid: UID_B, label: 'TC 別の人' },
  ],
  dob: [],
  demoEmailHashes: new Set(),
  specialUids: new Set([UID_A, UID_B]),
});

console.log('\n① uid を変えずに hash / masked だけ差し替える');
{
  const r = P.planEmailReplace({
    ...base(),
    items: [{ oldHash: OLD_A, newHash: NEW_A, expectedUid: UID_A, newMasked: 'h************i@transcosmos.com' }],
  });
  eq('T-1 エラー 0 件', r.errors, []);
  eq('T-2 **uid は変わらない**', r.emails.map((e) => e.uid), [UID_A, UID_B]);
  eq('T-3 旧 hash は消える', r.emails.some((e) => e.hash === OLD_A), false);
  eq('T-4 新 hash へ同じ uid が移る', r.emails.find((e) => e.hash === NEW_A)?.uid, UID_A);
  eq('T-5 label は維持される', r.emails.find((e) => e.hash === NEW_A)?.label, 'トランスコスモス 2026-10');
  eq('T-6 masked は新しいものになる', r.emails.find((e) => e.hash === NEW_A)?.masked, 'h************i@transcosmos.com');
  eq('T-7 他の行は 1 文字も動かない', r.emails.find((e) => e.hash === OTHER), base().emails[1]);
  eq('T-8 行数は増減しない', r.emails.length, 2);
  eq('T-9 報告行は uid と新旧マスクを持つ', r.rows, [{
    uid: UID_A, label: 'トランスコスモス 2026-10',
    old_masked: 'h*******i@transcosmos.com', new_masked: 'h************i@transcosmos.com',
    dob_moved: false,
  }]);
}

console.log('\n② 生年月日は hash だけ移す (値は変えない)');
{
  const b = base();
  b.dob = [{ hash: OLD_A, dob: '1970-01-02', sex: 'male' }];
  const r = P.planEmailReplace({
    ...b, items: [{ oldHash: OLD_A, newHash: NEW_A, expectedUid: UID_A, newMasked: 'x***@y.com' }],
  });
  eq('T-10 エラー 0 件', r.errors, []);
  eq('T-11 DOB は新 hash へ移る', r.dob, [{ hash: NEW_A, dob: '1970-01-02', sex: 'male' }]);
  eq('T-12 dob / sex の値は変わらない', [r.dob[0].dob, r.dob[0].sex], ['1970-01-02', 'male']);
  eq('T-13 dob_moved が立つ', r.rows[0].dob_moved, true);
}
{
  const b = base();
  b.dob = [{ hash: OLD_A, dob: '1970-01-02', sex: 'male' }, { hash: NEW_A, dob: '1980-05-05', sex: 'female' }];
  const r = P.planEmailReplace({
    ...b, items: [{ oldHash: OLD_A, newHash: NEW_A, expectedUid: UID_A, newMasked: 'x***@y.com' }],
  });
  eq('T-14 新 hash に既存 DOB があれば 409 で止まる', r.errors.map((e) => [e.code, e.status]), [['dob_conflict', 409]]);
  eq('T-15 そのとき DOB を上書きしない', r.dob.find((d) => d.hash === NEW_A)?.dob, '1980-05-05');
}

console.log('\n③ 条件を満たさなければ何も変えない (fail-closed)');
{
  const mk = (items, extra = {}) => P.planEmailReplace({ ...base(), ...extra, items });
  const codes = (r) => r.errors.map((e) => [e.code, e.status]);

  eq('T-16 新 hash が既に登録済み → 409',
    codes(mk([{ oldHash: OLD_A, newHash: OTHER, expectedUid: UID_A, newMasked: 'x***@y.com' }])),
    [['new_email_already_registered', 409]]);
  eq('T-17 expected_uid 不一致 → 409',
    codes(mk([{ oldHash: OLD_A, newHash: NEW_A, expectedUid: UID_B, newMasked: 'x***@y.com' }])),
    [['uid_mismatch', 409]]);
  eq('T-18 旧 hash が無い → 404',
    codes(mk([{ oldHash: H('e'), newHash: NEW_A, expectedUid: UID_A, newMasked: 'x***@y.com' }])),
    [['old_email_not_registered', 404]]);
  eq('T-19 正規化すると同じ → 409',
    codes(mk([{ oldHash: OLD_A, newHash: OLD_A, expectedUid: UID_A, newMasked: 'x***@y.com' }])),
    [['same_email', 409]]);
  eq('T-20 uid が資格一覧に無い → 409',
    codes(mk([{ oldHash: OLD_A, newHash: NEW_A, expectedUid: UID_A, newMasked: 'x***@y.com' }],
      { specialUids: new Set([UID_B]) })),
    [['uid_not_entitled', 409]]);
  eq('T-21 デモ枠にも在るアドレス → 409',
    codes(mk([{ oldHash: OLD_A, newHash: NEW_A, expectedUid: UID_A, newMasked: 'x***@y.com' }],
      { demoEmailHashes: new Set([NEW_A]) })),
    [['demo_email_conflict', 409]]);
  // 1 件目は通るので、落ちるのは 2 件目だけ (エラーは 1 件)。
  eq('T-22 同じリクエストで二重に扱う → 409',
    codes(mk([
      { oldHash: OLD_A, newHash: NEW_A, expectedUid: UID_A, newMasked: 'x***@y.com' },
      { oldHash: OLD_A, newHash: NEW_B, expectedUid: UID_A, newMasked: 'z***@y.com' },
    ])),
    [['duplicate_in_request', 409]]);
  eq('T-23 hash / uid の形が違う → 400',
    codes(mk([{ oldHash: 'zzz', newHash: NEW_A, expectedUid: UID_A, newMasked: 'x***@y.com' }])),
    [['invalid_input', 400]]);

  // **部分適用しない。** 2 件のうち 1 件が落ちたら、通る方も適用しない。
  const mixed = mk([
    { oldHash: OLD_A, newHash: NEW_A, expectedUid: UID_A, newMasked: 'x***@y.com' },
    { oldHash: OTHER, newHash: NEW_B, expectedUid: UID_A, newMasked: 'z***@y.com' },  // uid 不一致
  ]);
  ok('T-24 **1 件でも落ちたら誰も変えない**', mixed.errors.length > 0
    && JSON.stringify(mixed.emails) === JSON.stringify(base().emails) && mixed.rows.length === 0);
  // マスクはドメインを含む (そういう仕様)。見るのは **全 hash を返していないこと** と
  // **伏字になっていること**。
  eq('T-25 エラーにはマスクだけ載る (hash 全体を返さない)',
    mixed.errors.every((e) => !e.old_masked.includes(OLD_A) && e.old_masked.includes('*')), true);
}

console.log('\n④ 2 名まとめて差し替えられる (今回の実務形)');
{
  const r = P.planEmailReplace({
    ...base(),
    items: [
      { oldHash: OLD_A, newHash: NEW_A, expectedUid: UID_A, newMasked: 'h***@transcosmos.com' },
      { oldHash: OTHER, newHash: NEW_B, expectedUid: UID_B, newMasked: 'y***@gmail.com' },
    ],
  });
  eq('T-26 エラー 0 件', r.errors, []);
  eq('T-27 2 名とも uid が維持される', r.emails.map((e) => e.uid), [UID_A, UID_B]);
  eq('T-28 新 hash が 2 件そろう', r.emails.map((e) => e.hash), [NEW_A, NEW_B]);
}

console.log('\n⑤ API 側の構造 (ここが静かに壊れる)');
{
  const api = code('src/pages/api/admin/special-accounts.ts');
  /* **切り出しは replace ブロックだけ。** 終端を間延びさせると add / remove の
   * ループまで含んでしまい、「内部で使っていない」の検査が意味を失う。 */
  const block = api.slice(api.indexOf('if (replaceEmail.length > 0)'), api.indexOf('for (const raw of add)'));
  ok('S-0 切り出した範囲が replace ブロックだけ (add ループを含まない)',
    block.includes('planEmailReplace(') && !block.includes('for (const raw of add)')
    && !block.includes('for (const key of removeEmail)'));
  ok('S-1 replace_email のブロックが在る', block.length > 500);
  ok('S-2 **資格一覧 (KEY) を書かない**', !/willWrite\[KEY\]/.test(block) && !new RegExp('\\[\\s*KEY\\s*\\]').test(block));
  ok('S-3 保存は EMAIL_KEY と DOB_KEY だけ',
    /willWrite\[EMAIL_KEY\]/.test(block) && /willWrite\[DOB_KEY\]/.test(block));
  ok('S-4 **setConfig は 1 回だけ**', (block.match(/setConfig\(/g) || []).length === 1);
  ok('S-5 **remove_email / add_email を内部で使わない**',
    !/mintSpecialUid/.test(block) && !/entries\.splice/.test(block) && !/entries\.push/.test(block)
    && !/ensureUidEntry/.test(block));
  ok('S-6 ハッシュ化は既存 hashEmail を使う (独自実装を増やさない)',
    /hashEmail\(oldAddr\)/.test(block) && /hashEmail\(newAddr\)/.test(block)
    && !/createHash|subtle\.digest/.test(block));
  ok('S-7 マスクは既存 maskEmail を使う', /maskEmail\(newAddr\)/.test(block));
  // Auth 紐付けの確認が **保存より前**に在ること (後ろだと意味が無い)。
  const iAuth = block.indexOf("auth_already_linked");
  const iSave = block.indexOf('setConfig(');
  ok('S-8 Auth 紐付けの停止判定が setConfig より前', iAuth > 0 && iSave > 0 && iAuth < iSave,
    `auth@${iAuth} / save@${iSave}`);
  ok('S-9 app_users の実値で判定する (auth_user_id / google_sub)',
    /auth_user_id/.test(block) && /google_sub/.test(block) && /from\('app_users'\)/.test(block));
  ok('S-10 dry_run は既定でない (明示したときだけ保存しない)',
    /body\.dry_run === true/.test(block));
  const iDry = block.indexOf('body.dry_run === true');
  ok('S-11 dry_run の分岐が setConfig より前', iDry > 0 && iDry < iSave);
  ok('S-12 他の操作と混ぜられない', /mixed_operations/.test(api));
  ok('S-13 応答に生アドレスを載せない (new_email / old_email を返していない)',
    !/(old_email|new_email)\s*:/.test(block));
  ok('S-14 読み戻して uid を示す', /readback_uid/.test(block) && /uid_still_entitled/.test(block));
  ok('S-15 非退行の件数を前後で返す', /counts_before/.test(block) && /counts_after/.test(block));
  ok('S-16 実データのテーブルへ書き込まない',
    !/\.insert\(|\.update\(|\.delete\(|\.upsert\(/.test(block));
  ok('S-17 UUID を新規採番しない', !/randomUUID/.test(block));
}

console.log('\n⑥ 新メールで resolve すると既存 uid を返す');
{
  // app_config だけスタブに差し替える (DB は要らない)。実物の lib を動かす。
  writeFileSync(resolve(CACHE, 'ser-app-config.mjs'), `
export const __store = {};
export const cfg = (k) => __store[k] ?? '';
export const refreshConfig = async () => {};
export const setConfig = async (u) => { Object.assign(__store, u); return { ok: true }; };
`);
  const swap = (s) => js(s
    .replace(/from '\.\/app-config'/g, "from './ser-app-config.mjs'")
    .replace(/from '\.\/demo-accounts'/g, "from './ser-demo-accounts.mjs'")
    .replace(/import\.meta\.env\.(\w+)/g, 'globalThis.__serEnv.$1'));
  writeFileSync(resolve(CACHE, 'ser-demo-accounts.mjs'), swap(read('src/lib/demo-accounts.ts')));
  const spOut = resolve(CACHE, 'ser-special-accounts.mjs');
  const body = swap(read('src/lib/special-accounts.ts'));
  if (!/ser-app-config/.test(body)) fails.push('verify: import 差し替えに失敗 (import 文の形が変わった)');
  writeFileSync(spOut, body);
  globalThis.__serEnv = {};
  const SP = await import(spOut);
  const DA = await import(resolve(CACHE, 'ser-demo-accounts.mjs'));
  const store = (await import(resolve(CACHE, 'ser-app-config.mjs'))).__store;

  const OLD_MAIL = 'hisashi.horiishi@example.test';
  const NEW_MAIL = 'Hisao.Horiishi@example.test';   // 大文字混じり = 正規化の確認も兼ねる
  const oldH = await DA.hashEmail(OLD_MAIL);
  const newH = await DA.hashEmail(NEW_MAIL);
  ok('T-29 正規化は trim + lowercase (大文字でも同じ hash)',
    newH === await DA.hashEmail('  hisao.horiishi@example.test  '));

  // 差し替え**後**の状態を store に置く (uid は維持されたまま)。
  store['special.account_emails'] = `${newH} ${DA.maskEmail(NEW_MAIL)} ${UID_A}  # トランスコスモス 2026-10`;
  store['special.account_uids'] = `${UID_A}  # トランスコスモス 2026-10`;

  eq('T-30 **新メールで既存 uid が返る**', await SP.resolveSpecialUidByEmail(NEW_MAIL), UID_A);
  eq('T-31 旧メールでは返らない (新 uid を作らない)', await SP.resolveSpecialUidByEmail(OLD_MAIL), null);
  eq('T-32 資格はそのまま立っている', SP.isSpecialAccount(UID_A), true);
}

console.log('\n' + '─'.repeat(70));
if (fails.length) {
  console.error(`\n❌ verify:special-email-replace — 不合格 ${fails.length} 件\n`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✅ verify:special-email-replace — ALL PASS\n');
