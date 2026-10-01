#!/usr/bin/env node
/**
 * `npm run verify:special-account-management`
 * — **スペシャルアカウント管理画面と Elith 納品の起動**の回帰チェック。
 *
 * 正本: `docs/specs/special_account_management_spec_20261001.md` §23。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【この検査の第一級要件】**cron が人の確認を通らずに本番へ書かないこと**
 * ══════════════════════════════════════════════════════════════════════
 *
 * スペシャルアカウントの Elith 本番納品は、`/admin/special-accounts` の
 * ［Elith納品］を人が押したときだけ起きる (§9.1)。23:00 JST の cron
 * (`GET /api/cron/elith-deliver`) の母集団からは 1 件も入らない。
 *
 * **ここは静かに壊れる。** 契約者が納品されなくなっても画面は正常に見えるし、
 * スペシャルが cron に戻っても「納品できている」ようにしか見えない。
 * → 両方向 (スペシャルが消える / 契約者が残る) を機械で固定する (§17.3)。
 *
 * 検査は「そう書いてあるか」で済ませず、**実物を transpile して動かす**
 * (`verify:special-accounts` と同型)。鍵もサーバも要らないので CI の A 層。
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
/** コメント行を落とす (経緯の説明に旧コードが書いてあるため、そこを拾わない)。 */
const code = (p) => read(p).split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');

const ts = (await import('typescript')).default;
mkdirSync(resolve(ROOT, 'node_modules/.cache'), { recursive: true });
const js = (src) => ts.transpileModule(src, { compilerOptions: { target: 'ES2022', module: 'ESNext' } }).outputText;

const fails = [];
const ok = (label, cond, why) => {
  if (!cond) fails.push(`${label}${why ? ` — ${why}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
};
const eq = (label, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (!good) fails.push(`${label} — got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
  console.log(`  ${good ? '✓' : '✗'} ${label}`);
};

/**
 * ファイルから 1 つの top-level 関数を**本体ごと**切り出し、
 * 依存を引数で差し替えて実行できる形で返す。
 * 「そう書いてある」ではなく**実際に動かす**ための足場。
 */
function lift(file, decl, deps = []) {
  const src = read(file);
  const i = src.indexOf(decl);
  if (i < 0) throw new Error(`${file}: \`${decl}\` が見つからない`);
  const name = decl.match(/function\s+(\w+)/)[1];
  const body = js(src.slice(i, endOfBlock(src, i)).replace(/^export /, ''));
  // eslint-disable-next-line no-new-func
  return new Function(...deps, `${body}\nreturn ${name};`);
}

/**
 * `from` から始まる関数の**終わりの位置**を括弧の対応で求める。
 *
 * **引数の型を数えないのが要点。** 行頭の `}` を探す素朴なやり方だと
 * `function f(x: {\n …\n}): R {` で `}): R {` に当たって切れるし、
 * 波括弧を数えるだけでも**引数の型の `{…}` で深さが 0 に戻って**同じ所で切れる
 * (どちらも実測で壊れた)。→ **丸括弧が閉じたあとの最初の `{`** を本体の始まりとする。
 * 文字列・テンプレート・コメントの中の括弧は数えない。
 */
function endOfBlock(src, from) {
  let paren = 0, closedParams = false, depth = 0, inBody = false;
  let q = null, line = false, block = false;
  for (let i = from; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
    if (q) {
      if (c === '\\') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (!closedParams) {
      if (c === '(') paren++;
      else if (c === ')') { paren--; if (paren === 0) closedParams = true; }
      continue;   // 引数の中の波括弧は数えない
    }
    if (c === '{') { depth++; inBody = true; continue; }
    if (c === '}') { depth--; if (inBody && depth === 0) return i + 1; }
  }
  throw new Error('関数の終わりを見つけられない');
}

// ══════════════════════════════════════════════════════════════════════
// A. 母集団と cron の分離 (**最重要**・§17 / §18.2 / §9.5)
// ══════════════════════════════════════════════════════════════════════
console.log('\nA. 母集団と cron の分離 (buildDeliveryPopulation を実際に動かす)\n');

const SPECIAL = '11111111-1111-1111-1111-111111111111';
const DENIED_SPECIAL = '22222222-2222-2222-2222-222222222222';
const SUBSCRIBER = '33333333-3333-3333-3333-333333333333';
const SINGLE = '44444444-4444-4444-4444-444444444444';

{
  const build = lift('src/lib/elith-entitlement.ts', 'export function buildDeliveryPopulation(')();

  const sub = (uid, kind, planCode, requiredFormats) => ({ uid, kind, planCode, requiredFormats });
  const pop = build({
    // 登録簿は denied も含めて渡す (本物の呼び出し元と同じ形)
    specialUids: [SPECIAL, DENIED_SPECIAL],
    subscribers: [
      sub(SUBSCRIBER, 'subscription', 'course_a', ['HealthCheckupData', 'BloodTestData']),
      sub(SINGLE, 'single', 'single_b', ['HealthCheckupData']),
    ],
  });

  // A-1
  ok('A-1 cron の母集団にスペシャルが 1 件も入らない',
    !pop.uids.includes(SPECIAL),
    `uids=${JSON.stringify(pop.uids)}`);
  ok('A-1 除外リストに入っているスペシャル (緊急停止済) も入らない',
    !pop.uids.includes(DENIED_SPECIAL),
    '停止した人の自動納品だけ生き残るのは逆');
  ok('A-1 外したことを黙らせない (excludedSpecial に出る)',
    pop.excludedSpecial.includes(SPECIAL) && pop.excludedSpecial.includes(DENIED_SPECIAL));

  // A-2 / A-3
  ok('A-2 契約者 (status=active) は母集団に入る', pop.uids.includes(SUBSCRIBER));
  ok('A-3 単品 (非スペシャル) は母集団に入る', pop.uids.includes(SINGLE));
  eq('A-2/A-3 必要 format が契約から引けている',
    pop.requiredByUid.get(SUBSCRIBER), ['HealthCheckupData', 'BloodTestData']);

  // 両方に登録された事故 — 本番へ出る側へ倒さない
  const both = build({ specialUids: [SUBSCRIBER], subscribers: [sub(SUBSCRIBER, 'subscription', 'course_a', ['HealthCheckupData'])] });
  ok('A-1 スペシャルと契約者の両方に登録されていても cron では出さない',
    both.uids.length === 0 && both.excludedSpecial.includes(SUBSCRIBER));

  // **緊急停止 (除外リスト) した人が契約者としても引けるとき**が漏れの本番。
  // 「除外を和の前に置く」退行はここでしか現れない (登録簿にしか居ない uid は
  //  そもそも母集団へ入らないので、素の形だと退行を見逃す・実測)。
  const stopped = build({
    specialUids: [DENIED_SPECIAL],
    subscribers: [sub(DENIED_SPECIAL, 'subscription', 'course_a', ['HealthCheckupData'])],
  });
  ok('A-1 緊急停止したスペシャルが契約者として引けても cron では出さない',
    stopped.uids.length === 0 && stopped.excludedSpecial.includes(DENIED_SPECIAL),
    `uids=${JSON.stringify(stopped.uids)}`);

  // fail-closed がそのまま乗ること
  const unknown = build({ specialUids: [], subscribers: [sub(SUBSCRIBER, 'subscription', 'nope', null)] });
  eq('A-2 仕様を引けない契約者は required=null のまま渡る (fail-closed)',
    unknown.requiredByUid.get(SUBSCRIBER), null);

  // 大小・空白のゆれで漏れない
  const messy = build({ specialUids: [` ${SPECIAL.toUpperCase()} `], subscribers: [sub(SPECIAL, 'single', 'p', ['HealthCheckupData'])] });
  ok('A-1 大文字・空白のゆれでスペシャルを取りこぼさない', messy.uids.length === 0);
}

// A-4 — pending の契約者を権利と読まない (listEntitledSubscribers を動かす)
{
  const calls = [];
  const sb = {
    from(table) {
      const q = {
        select() { return q; },
        eq(k, v) { calls.push({ table, k, v }); return Promise.resolve({ data: ROWS.filter((r) => r.status === v), error: null }); },
      };
      return q;
    },
  };
  const ROWS = [
    { diagnostic_user_id: SUBSCRIBER, plan_code: 'course_a', status: 'active' },
    { diagnostic_user_id: SINGLE, plan_code: 'single_b', status: 'pending' },
  ];
  const listFn = lift('src/lib/elith-entitlement.ts', 'export async function listEntitledSubscribers(',
    ['getBridgeSupabase', 'planFormatMap', 'cfg'])(
    () => sb,
    () => new Map([['course_a', ['HealthCheckupData']], ['single_b', ['HealthCheckupData']]]),
    () => '',
  );
  const got = await listFn();
  eq('A-4 status=pending の契約者は母集団に入らない', got.map((g) => g.uid), [SUBSCRIBER]);
  ok('A-4 絞り込みが status=active であること',
    calls.some((c) => c.k === 'status' && c.v === 'active'), JSON.stringify(calls));
}

// A-5 — 一括ボタンと cron が同じ母集団を通ること (口が 1 つであること)
{
  const d = code('src/lib/elith-delivery.ts');
  ok('A-5 母集団の構築は buildDeliveryPopulation 1 か所だけ',
    (d.match(/buildDeliveryPopulation\(/g) ?? []).length === 1,
    '2 か所で組むと cron と一括ボタンで母集団がずれる (§9.5)');
  ok('A-5 listSpecialAccounts の uid を母集団へ足し直していない',
    !/\.\.\.snap\.rows[\s\S]{0,200}new Set\(\[[\s\S]{0,200}subscribers/.test(d) &&
    !/const\s+singleUids\s*=/.test(d),
    '旧 singleUids の union が残っているとスペシャルが cron に戻る');
  const cron = code('src/pages/api/cron/elith-deliver.ts');
  ok('A-5 cron 側に母集団の条件を書いていない',
    !/isSpecialAccount|listSpecialAccounts/.test(cron),
    'cron 側に条件を足すと一括ボタンと二重管理になる (§9.5)');
  ok('A-5 一括ボタン経路も deliverReadySpecialAccounts を通る',
    /deliverReadySpecialAccounts/.test(cron));
}

// ══════════════════════════════════════════════════════════════════════
// D. 登録と納品の分離 (§12 / D-3)
// ══════════════════════════════════════════════════════════════════════
//
// **「送り忘れ = 誤納品」を構造的に消す。** 以前は `finalize` が
// `if (body.deliver === false)` = 明示的に false のときだけ止まる形だったので、
// UI の 1 行を忘れたらそのまま Elith 本番へ出た。
// 既定を反転したので、**UI が何も送らなければ出ない**。
//
// ハーネス (DB / S3 / 原本 / 認可のスタブ) は `verify:special-additional-tests` と
// **同じものを共有する** — 実装も検査台も 2 つ持たない。
console.log('\nD. 登録と納品の分離 (finalize を実際に動かす)\n');
{
  const H = await import('./lib/sat-harness.mjs');
  const { M, UID_A, PDF, shaHex, putOriginal, bloodPart, resetAll, call, finalizeBlood } = H;
  const prodKeys = () => [...M.s3.S3.keys()].filter((k) => k.startsWith('user/'));
  const makeOriginal = (testDate = '2025-08-04') => {
    const key = M.addOrig.buildAdditionalOriginalKey({ uid: UID_A, testType: 'blood', testDate, sha256Hex: shaHex(PDF) });
    putOriginal(key, PDF);
    return key;
  };
  const noDeliverArgs = (key) => ({
    diagnosticUserId: UID_A, testType: 'blood', testDate: '2025-08-04',
    originalKey: key, parts: [bloodPart(1), bloodPart(2)],
    // **deliver を送らない** = UI が送り忘れた状態そのもの
  });

  // D-16 — 既定で本番へ書かない
  resetAll();
  const r16 = await call(M.finalize, noDeliverArgs(makeOriginal()));
  ok('D-16 deliver を送らない呼び出しが成功する (登録は通る)', r16.json.ok === true, JSON.stringify(r16.json).slice(0, 200));
  eq('D-16 **既定では本番 user/ へ 1 件も書かない**', prodKeys().length, 0);
  eq('D-16 応答が「納品していない」と言い切る', [r16.json.delivered, r16.json.delivery], [false, null]);
  ok('D-16 次にどうすればよいかを出す (黙らせない)',
    typeof r16.json.note === 'string' && r16.json.note.includes('スペシャルアカウント'), String(r16.json.note));
  eq('D-16 納品履歴の行も作らない', (M.db.TABLES.elith_delivery_items ?? []).length, 0);

  // deliver:false も同じ (旧い呼び出し元が残っていても壊れない)
  resetAll();
  const rFalse = await call(M.finalize, { ...noDeliverArgs(makeOriginal()), deliver: false });
  eq('D-16 deliver:false も従来どおり納品しない', [rFalse.json.ok, prodKeys().length], [true, 0]);

  // 真偽を取り違えやすい値で**納品側へ倒れない**こと
  for (const v of ['true', 1, {}, null]) {
    resetAll();
    const r = await call(M.finalize, { ...noDeliverArgs(makeOriginal()), deliver: v });
    eq(`D-16 deliver=${JSON.stringify(v)} (true ではない) で納品しない`, prodKeys().length, 0);
    ok(`D-16 deliver=${JSON.stringify(v)} でも登録は通る`, r.json.ok === true);
  }

  // D-17 — 明示したときだけ書く
  resetAll();
  const r17 = await finalizeBlood();   // ハーネスの BASE が deliver:true を明示している
  eq('D-17 deliver:true のときだけ本番へ書く', prodKeys().length, 1);
  eq('D-17 読み戻し検証まで通っている', r17.json.delivery.verified, true);

  // D-18 — 納品しなくても登録側は全部書かれる
  resetAll();
  const r18 = await call(M.finalize, noDeliverArgs(makeOriginal()));
  eq('D-18 test_artifacts は書かれる', M.db.TABLES.test_artifacts.length, 1);
  ok('D-18 measurement_values は書かれる', (M.db.TABLES.measurement_values ?? []).length > 0,
    `rows=${(M.db.TABLES.measurement_values ?? []).length}`);
  eq('D-18 原本の紐付けは書かれる', M.db.TABLES.test_artifact_files.length, 1);
  ok('D-18 Elith 中間 source は書かれる (監査層は残す)',
    !!r18.json.source_key && M.s3.S3.has(r18.json.source_key), String(r18.json.source_key));
  ok('D-18 中間 source は本番 prefix ではない',
    !String(r18.json.source_key).startsWith('user/'), String(r18.json.source_key));

  // D-19 — 本番 PUT だけ失敗しても DB は残す
  ok('D-19 失敗した納品は status=failed で残す (再実行できる)',
    /status: d\.verified \? 'delivered' : 'failed'/.test(read('src/pages/api/admin/special-additional-tests/finalize.ts')));
  ok('D-19 納品が失敗しても Dashboard の登録は消さない',
    /Dashboard 側の登録は残す/.test(read('src/pages/api/admin/special-additional-tests/finalize.ts')));

  // 退行注入 4 の的 — 既定が「納品する」側へ戻ったら落ちる
  ok('D-16 ゲートが「true を明示したときだけ」になっている',
    /body\.deliver !== true/.test(code('src/pages/api/admin/special-additional-tests/finalize.ts')),
    '`deliver === false` 型に戻すと、送り忘れがそのまま本番へ出る');
}

console.log(`\n${fails.length ? '✗' : '✓'} ${fails.length ? `${fails.length} 件 失敗` : '全件 OK'}`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exit(fails.length ? 1 : 0);
