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

// ══════════════════════════════════════════════════════════════════════
// I. 一覧の集計 (§6.2 / §6.4)
// ══════════════════════════════════════════════════════════════════════
//
// **ここは静かに壊れる。** 血液・遺伝子・がんリスク・AI疾病予測が 0 件で出ても
// 「まだ検査が来ていない人」にしか見えないし、納品済みの回が「未納品」に見えても
// 画面は正常に動く。→ 5 種とも数えること・納品を 2 表の和で見ることを固定する。
console.log('\nI. 一覧の集計 (getAccountProgress を実際に動かす)\n');
{
  const H = await import('./lib/sat-harness.mjs');
  const { M } = H;
  const U = 'aaaaaaaa-1111-4111-8111-111111111111';
  const V = 'bbbbbbbb-2222-4222-8222-222222222222';

  const seed = () => {
    M.db.reset();
    M.db.TABLES.interview_completions = [{ diagnostic_user_id: U, completed_at: '2026-09-08T01:00:00Z' }];
    M.db.TABLES.test_artifacts = [
      { diagnostic_user_id: U, test_type: 'health_checkup', test_date: '2025-02-17', status: 'active' },
      { diagnostic_user_id: U, test_type: 'health_checkup', test_date: '2026-03-29', status: 'active' },
      { diagnostic_user_id: U, test_type: 'blood', test_date: '2026-05-10', status: 'active' },
      { diagnostic_user_id: U, test_type: 'genetics', test_date: '2024-11-01', status: 'active' },
      { diagnostic_user_id: U, test_type: 'cancer_urine', test_date: '2026-06-02', status: 'active' },
      { diagnostic_user_id: U, test_type: 'ai_prediction', test_date: '2025-08-18', status: 'active' },
      // 取り消した回は数えない
      { diagnostic_user_id: U, test_type: 'blood', test_date: '2026-07-07', status: 'superseded' },
      // 知らない種別を混ぜても捏造しない
      { diagnostic_user_id: U, test_type: 'nanika', test_date: '2026-09-09', status: 'active' },
      // 他人の行を混ぜない
      { diagnostic_user_id: V, test_type: 'blood', test_date: '2026-09-30', status: 'active' },
    ];
  };

  // I-33 — 5 種すべての件数と最新日が返る
  seed();
  let p = (await M.progress.getAccountProgress([U, V]))[U];
  eq('I-33 検診・人間ドック 2 件 / 最新 2026-03-29',
    [p.byTestType.health_checkup.count, p.byTestType.health_checkup.latest], [2, '2026-03-29']);
  eq('I-33 血液 1 件 (superseded は数えない)',
    [p.byTestType.blood.count, p.byTestType.blood.latest], [1, '2026-05-10']);
  eq('I-33 遺伝子 / がんリスク / AI疾病予測 もそれぞれ数える',
    [p.byTestType.genetics.count, p.byTestType.cancer_urine.count, p.byTestType.ai_prediction.count], [1, 1, 1]);
  eq('I-33 5 種が揃っている', Object.keys(p.byTestType).sort(),
    ['ai_prediction', 'blood', 'cancer_urine', 'genetics', 'health_checkup']);
  ok('I-33 知らない test_type を勝手に足さない', !('nanika' in p.byTestType));
  eq('I-33 他人の行を数えない', (await M.progress.getAccountProgress([U, V]))[V].byTestType.blood.count, 1);
  eq('I-33 既存の scan キーを消していない (health_checkup と同じ)',
    [p.scan.count, p.scan.latest], [p.byTestType.health_checkup.count, p.byTestType.health_checkup.latest]);
  eq('I-33 最終更新は問診と検査 5 種の最大', p.latestActivity, '2026-09-08T01:00:00Z');

  // I-34 — 納品は 2 表の和
  seed();
  M.db.TABLES.elith_deliveries = [{ diagnostic_user_id: U, delivered_at: '2026-08-15T14:00:00Z', status: 'delivered' }];
  p = (await M.progress.getAccountProgress([U]))[U];
  eq('I-34 elith_deliveries だけでも納品済みになる', [p.delivered.done, p.delivered.count], [true, 1]);

  seed();
  M.db.TABLES.elith_delivery_items = [
    { diagnostic_user_id: U, delivered_at: '2026-09-20T14:00:00Z', status: 'delivered' },
    { diagnostic_user_id: U, delivered_at: null, status: 'failed' },
  ];
  p = (await M.progress.getAccountProgress([U]))[U];
  eq('I-34 **追加検査だけの納品も「納品済み」として見える** (P-2 の修正)',
    [p.delivered.done, p.delivered.count, p.delivered.latest], [true, 1, '2026-09-20T14:00:00Z']);
  ok('I-34 failed は納品済みに数えない', p.delivered.count === 1);

  seed();
  M.db.TABLES.elith_deliveries = [{ diagnostic_user_id: U, delivered_at: '2026-08-15T14:00:00Z', status: 'delivered' }];
  M.db.TABLES.elith_delivery_items = [{ diagnostic_user_id: U, delivered_at: '2026-09-20T14:00:00Z', status: 'delivered' }];
  p = (await M.progress.getAccountProgress([U]))[U];
  eq('I-34 両方あるときは和をとり、前回納品は新しい方', [p.delivered.count, p.delivered.latest],
    [2, '2026-09-20T14:00:00Z']);

  // I-35 — 引けないときに「済み」と偽らない
  seed();
  M.db.FAIL.noServer = true;
  p = (await M.progress.getAccountProgress([U]))[U];
  M.db.FAIL.noServer = false;
  eq('I-35 DB 未設定なら全部「未完了」で返す (画面は壊さない)',
    [p.interview.done, p.byTestType.blood.done, p.delivered.done, p.latestActivity], [false, false, false, null]);

  seed();
  M.db.FAIL.select = 'elith_delivery_items';
  p = (await M.progress.getAccountProgress([U]))[U];
  M.db.FAIL.select = null;
  eq('I-35 **1 本引けなくても他を道連れにしない** (migration 未適用で全部 0 件にしない)',
    [p.interview.done, p.byTestType.blood.count, p.byTestType.health_checkup.count], [true, 1, 2]);

  // I-36 — PII を載せない
  seed();
  const all = await M.progress.getAccountProgress([U, V]);
  const text = JSON.stringify(all);
  ok('I-36 応答に測定値・回答本文・氏名・生年月日が出てこない',
    !/(value|measurement|answer|birth|dob|name|email)/i.test(text), text.slice(0, 200));
  ok('I-36 読むのは件数と日時だけ (select に余計な列を足していない)',
    !/select\('[^']*\b(value|item_name|answers|raw|markdown)\b/.test(code('src/lib/account-progress.ts')));
}

// ══════════════════════════════════════════════════════════════════════
// E / F / K. 1 uid 手動納品 — 複数年・7 種・plan と putVerified
// ══════════════════════════════════════════════════════════════════════
//
// **静かに壊れるところ**
//   ① 複数年が**最新 1 件へ縮退**する — 画面は「納品できた」としか言わない
//   ② 血液・がん・遺伝子・AI疾病予測が **manualMapping に載らない** (P-1)
//   ③ **確認モーダルを開いただけで S3 が変わる** — 取り返しがつかない
//   ④ 確認した内容と**違う内容を書く** — 確認が確認になっていない
//   ⑤ PutObject の成否だけで「納品完了」と言う
console.log('\nE / F / K. 1 uid 手動納品 (plan → putVerified を実際に動かす)\n');
{
  const H = await import('./lib/sat-harness.mjs');
  const { M, UID_A, UID_B } = H;
  const P = 'scan-accuracy-test/';
  const prod = () => [...M.s3.S3.keys()].filter((k) => k.startsWith('user/'));

  const srcKey = (fmt, d) => `${P}user/${UID_A}/date/${d}/${fmt}_date_${d}_user_${UID_A}.json`;
  const putSrc = (fmt, d, data) => M.s3.S3.set(srcKey(fmt, d), JSON.stringify({
    format_id: fmt, client_id: UID_A, test_date: d.replace(/_/g, '-'),
    data: data ?? { measurements: [{ item_name: 'AST', value: '22' }] },
  }));
  const hcMd = (alb) => [
    '## 検査結果', '',
    '| 検査項目 | 読み取った値 | 単位 | 基準値下限 | 基準値上限 |',
    '|---|---|---|---|---|',
    `| アルブミン | ${alb} | g/dL | 3.9 | 5.1 |`,
    '| クレアチニン | 0.85 | mg/dL | 0.6 | 1.1 |',
    '| HbA1c | 5.4 | % | 4.6 | 6.2 |',
    '',
  ].join('\n');
  const hcRow = (date, age, md) => ({
    diagnostic_user_id: UID_A, test_type: 'health_checkup', status: 'active',
    test_date: date, age_at_test: age, sex: 'male', scan_md: md,
  });
  const reset = () => { M.db.reset(); M.s3.reset(); };

  // ── E-20 血液 3 年分が 3 つの date フォルダになる ────────────────────
  reset();
  for (const d of ['2023_05_10', '2024_05_10', '2025_05_10']) putSrc('BloodTestData', d);
  let plan = await M.manual.buildDeliveryPlan({ uid: UID_A, sourcePrefix: P, deliveryPrefix: '' });
  eq('E-20 血液 3 年分が 3 つの date フォルダになる (最新 1 件へ縮退しない)',
    [...new Set(plan.files.map((f) => f.deliveredDate))].sort(), ['2023_05_10', '2024_05_10', '2025_05_10']);
  eq('E-20 代表 1 件の指定で 3 ファイル', plan.countByFormat.BloodTestData, 3);

  // ── K-46 / V-4 plan を作っても S3 を変えない ───────────────────────
  eq('K-46 **確認モーダルを開いただけでは本番へ 1 バイトも書かない** (V-4)', prod().length, 0);

  // ── E-21 検診 5 年分 ＋ E-22 ウェルネス年齢は年ごと ─────────────────
  reset();
  M.db.TABLES.test_artifacts = [
    hcRow('2026-03-29', 54, hcMd('4.4')),
    hcRow('2025-02-17', 53, hcMd('4.2')),
    hcRow('2024-02-10', 52, hcMd('4.3')),
    hcRow('2023-02-11', 51, hcMd('4.1')),
    hcRow('2022-02-12', 50, hcMd('4.0')),
    // **読み取り 0 項目の回は作らない**（捏造しない）
    hcRow('2021-02-13', 49, '## 空\n'),
  ];
  plan = await M.manual.buildDeliveryPlan({ uid: UID_A, sourcePrefix: P, deliveryPrefix: '' });
  eq('E-21 検診 5 年分が 5 つの date フォルダになる', plan.countByFormat.HealthCheckupData, 5);
  eq('E-22 ウェルネス年齢も**年ごと**に載る', plan.countByFormat.HealthAgeData, 5);
  ok('E-22 読み取り 0 項目の回は作らない (捏造しない)',
    !plan.files.some((f) => f.deliveredDate === '2021_02_13'));

  // 算出不能な年は HealthAgeData を載せない
  reset();
  M.db.TABLES.test_artifacts = [
    hcRow('2026-03-29', 54, hcMd('4.4')),
    // アルブミン・クレアチニンが無い = ウェルネス年齢は算出不能。**検診は納品し、年齢だけ載せない。**
    hcRow('2025-02-17', 53, ['## 検査結果', '', '| 検査項目 | 読み取った値 | 単位 |', '|---|---|---|', '| 身長 | 170 | cm |', ''].join('\n')),
  ];
  plan = await M.manual.buildDeliveryPlan({ uid: UID_A, sourcePrefix: P, deliveryPrefix: '' });
  eq('E-22 算出不能な年は HealthAgeData を載せない (検診は納品する)',
    [plan.countByFormat.HealthCheckupData, plan.countByFormat.HealthAgeData], [2, 1]);

  // ── F-24 / F-25 7 種すべてが載り得る / 無い format は載せない ────────
  reset();
  M.db.TABLES.test_artifacts = [hcRow('2026-03-29', 54, hcMd('4.4'))];
  putSrc('BloodTestData', '2026_05_10');
  putSrc('CancerRiskAssessmentData', '2026_06_02');
  putSrc('GeneticTestResultData', '2024_11_01');
  putSrc('Other', '2025_08_18');
  putSrc('LifestyleQuestionnaireData', '2026_09_08', { answers: [] });
  plan = await M.manual.buildDeliveryPlan({ uid: UID_A, sourcePrefix: P, deliveryPrefix: '' });
  eq('F-24 **7 種すべてが載る** (P-1 の修正)', Object.keys(plan.countByFormat).sort(), [
    'BloodTestData', 'CancerRiskAssessmentData', 'GeneticTestResultData',
    'HealthAgeData', 'HealthCheckupData', 'LifestyleQuestionnaireData', 'Other',
  ]);

  reset();
  M.db.TABLES.test_artifacts = [hcRow('2026-03-29', 54, hcMd('4.4'))];
  plan = await M.manual.buildDeliveryPlan({ uid: UID_A, sourcePrefix: P, deliveryPrefix: '' });
  ok('F-25 存在しない format は載せない (空のファイルを作らない)',
    !('BloodTestData' in plan.countByFormat) && !('GeneticTestResultData' in plan.countByFormat),
    JSON.stringify(plan.countByFormat));

  // ── B-6〜B-9 最低条件 (§10.2) ──────────────────────────────────────
  reset();
  plan = await M.manual.buildDeliveryPlan({ uid: '', sourcePrefix: P, deliveryPrefix: '' });
  ok('B-6 uid 未確定は納品できない', !plan.ok && !!plan.reason);
  plan = await M.manual.buildDeliveryPlan({ uid: UID_B, sourcePrefix: P, deliveryPrefix: '' });
  ok('C-12 スペシャルアカウント以外の uid は拒否する', !plan.ok && /スペシャル/.test(plan.reason ?? ''));
  plan = await M.manual.buildDeliveryPlan({ uid: UID_A, sourcePrefix: P, deliveryPrefix: '' });
  ok('B-9 渡せるデータが 0 種類なら納品できない', !plan.ok && /1 件もありません/.test(plan.reason ?? ''));

  reset();
  putSrc('BloodTestData', '2026_05_10');
  plan = await M.manual.buildDeliveryPlan({ uid: UID_A, sourcePrefix: P, deliveryPrefix: '' });
  ok('B-7 **AI問診が無くても**納品できる', plan.ok && !('LifestyleQuestionnaireData' in plan.countByFormat));
  ok('B-8 **検診が無くても**（血液だけでも）納品できる', plan.ok && !('HealthCheckupData' in plan.countByFormat));

  // ── K-48 確認した plan をそのまま書く ──────────────────────────────
  reset();
  M.db.TABLES.test_artifacts = [hcRow('2026-03-29', 54, hcMd('4.4')), hcRow('2025-02-17', 53, hcMd('4.2'))];
  plan = await M.manual.buildDeliveryPlan({ uid: UID_A, sourcePrefix: P, deliveryPrefix: '' });
  const fp = M.manual.planFingerprint(plan);
  const exec = await M.manual.executeDeliveryPlan(plan, { deliveryPrefix: '' });
  eq('K-48 plan のファイルがそのまま書かれる',
    [exec.fileCount, exec.verifiedCount, prod().length], [plan.files.length, plan.files.length, plan.files.length]);
  eq('K-48 plan の指紋は書いても変わらない (同じ内容を書いた)', M.manual.planFingerprint(plan), fp);
  eq('H-30 同じ内容で 2 回納品しても S3 のオブジェクト数が増えない',
    (await M.manual.executeDeliveryPlan(plan, { deliveryPrefix: '' }), prod().length), plan.files.length);
  ok('H-30 2 回目は PUT しない (事前比較で止まる)',
    (await M.manual.executeDeliveryPlan(plan, { deliveryPrefix: '' })).results.every((r) => r.skipped));

  // ── K-51 / V-1 追加 GET は **新規 2 回・既存同一 1 回**（実回数で測る）─────
  //
  // 「1 ファイルにつき GET が 1 回増える」で見積もると**最悪ケースを 2 倍外す**。
  // V-1（cron が maxDuration 800s に収まるか）はここの実測を根拠にする。
  {
    reset();
    M.s3.S3.set('user/x/a.json', 'same');
    M.s3.COUNTS.get = 0; M.s3.COUNTS.put = 0;
    const res1 = await M.vput.putVerified([{ key: 'user/x/a.json', contentType: 'application/json', body: 'same', bytes: 4 }]);
    eq('K-51 既存と同一なら **GET 1 回・PUT 0 回**', [M.s3.COUNTS.get, M.s3.COUNTS.put], [1, 0]);
    eq('K-51 それでも verified (skipped として返る)', [res1[0].verified, res1[0].skipped], [true, true]);

    M.s3.COUNTS.get = 0; M.s3.COUNTS.put = 0;
    const res2 = await M.vput.putVerified([{ key: 'user/x/b.json', contentType: 'application/json', body: 'new', bytes: 3 }]);
    eq('K-51 新規は **GET 2 回（事前比較 + 読み戻し）・PUT 1 回**', [M.s3.COUNTS.get, M.s3.COUNTS.put], [2, 1]);
    eq('K-51 新規も verified (skipped ではない)', [res2[0].verified, res2[0].skipped], [true, false]);

    M.s3.COUNTS.get = 0; M.s3.COUNTS.put = 0;
    await M.vput.putVerified([{ key: 'user/x/b.json', contentType: 'application/json', body: 'changed', bytes: 7 }]);
    eq('K-51 **内容が変わった回も GET 2 回・PUT 1 回**（最悪ケース = 全ファイルがこれ）',
      [M.s3.COUNTS.get, M.s3.COUNTS.put], [2, 1]);

    // 10 ファイルぶんの最悪ケースを実測しておく（V-1 の見積りの根拠）
    reset();
    const many = Array.from({ length: 10 }, (_, i) => ({ key: `user/x/m${i}.json`, contentType: 'application/json', body: `v${i}`, bytes: 2 }));
    M.s3.COUNTS.get = 0; M.s3.COUNTS.put = 0;
    await M.vput.putVerified(many);
    eq('K-51 最悪ケース 10 ファイル = GET 20 回 / PUT 10 回', [M.s3.COUNTS.get, M.s3.COUNTS.put], [20, 10]);
  }

  // ── K-37 / K-39 / K-40 putVerified の性質 ─────────────────────────
  reset();
  M.s3.STATE.putFail = true;
  const bad = await M.vput.putVerified([{ key: 'user/x/c.json', contentType: 'application/json', body: 'x', bytes: 1 }]);
  M.s3.STATE.putFail = false;
  eq('K-40 **投げない**。失敗は戻り値で返る', [bad[0].verified, bad[0].error], [false, 'put_failed']);
  eq('K-37 PUT に失敗した回は destinationSha256 を持たない', bad[0].destinationSha256, null);

  // **書けたのに中身が違う**回。PutObject の成否だけを見ていると、ここが通ってしまう。
  reset();
  M.s3.STATE.corruptPut = true;
  const corrupt = await M.vput.putVerified([{ key: 'user/x/d.json', contentType: 'application/json', body: 'hello', bytes: 5 }]);
  M.s3.STATE.corruptPut = false;
  eq('K-37 **読み戻して一致しなければ verified にしない**',
    [corrupt[0].verified, corrupt[0].error], [false, 'readback_mismatch']);
  ok('K-37 突合に使ったハッシュを両方返す (何が起きたか分かる)',
    !!corrupt[0].sourceSha256 && !!corrupt[0].destinationSha256 && corrupt[0].sourceSha256 !== corrupt[0].destinationSha256);

  reset();
  M.db.TABLES.test_artifacts = [hcRow('2026-03-29', 54, hcMd('4.4'))];
  plan = await M.manual.buildDeliveryPlan({ uid: UID_A, sourcePrefix: P, deliveryPrefix: '' });
  M.s3.STATE.putFail = true;
  const execFail = await M.manual.executeDeliveryPlan(plan, { deliveryPrefix: '' });
  M.s3.STATE.putFail = false;
  eq('K-39 **1 件でも読み戻せない年は delivered として記録しない**',
    [execFail.ok, execFail.recordedDates.length, execFail.skippedDates.length > 0], [false, 0, true]);
  eq('K-39 elith_deliveries へも書いていない', (M.db.TABLES.elith_deliveries ?? []).length, 0);
  ok('K-39 なぜ記録しなかったかを返す (黙って落とさない)',
    /読み戻し検証/.test(execFail.skippedDates[0]?.reason ?? ''), JSON.stringify(execFail.skippedDates));

  // ── API の 2 段 (preview → confirm) ────────────────────────────────
  const callApi = async (body) => {
    const res = await M.deliverOne.POST({ request: new Request('http://x/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: res.status, json: JSON.parse(await res.text()) };
  };
  reset();
  M.db.TABLES.test_artifacts = [hcRow('2026-03-29', 54, hcMd('4.4'))];
  const prev = await callApi({ diagnosticUserId: UID_A, sourcePrefix: P, deliveryPrefix: '' });
  eq('K-46 preview は mode=preview で返る', prev.json.mode, 'preview');
  eq('K-46 **preview では S3 を 1 バイトも変えない**', prod().length, 0);
  ok('K-47 preview に 1 ファイルごとの明細がある (format_id / delivered_date / destination_key / sha256)',
    prev.json.plan.files.every((f) => f.format_id && f.delivered_date && f.destination_key && f.sha256));
  ok('K-46 本番へ書くことを文言で言う', /本番/.test(prev.json.note ?? ''));

  const noFp = await callApi({ diagnosticUserId: UID_A, sourcePrefix: P, deliveryPrefix: '', confirm: true });
  eq('K-48 指紋を送らない確定は受け付けない', [noFp.status, noFp.json.error], [400, 'fingerprint_required']);
  eq('K-48 受け付けなかったので S3 も変わっていない', prod().length, 0);

  const stale = await callApi({ diagnosticUserId: UID_A, sourcePrefix: P, deliveryPrefix: '', confirm: true, fingerprint: 'deadbeef' });
  eq('K-48 **確認したときと内容が違えば書かない**', [stale.status, stale.json.error], [409, 'plan_changed']);
  eq('K-48 書いていない', prod().length, 0);

  const okRes = await callApi({ diagnosticUserId: UID_A, sourcePrefix: P, deliveryPrefix: '', confirm: true, fingerprint: prev.json.plan.fingerprint });
  eq('K-48 指紋が一致したときだけ書く', [okRes.status, okRes.json.ok], [200, true]);
  eq('K-48 plan の件数と書いた件数が一致', okRes.json.verified_count, prev.json.plan.file_count);

  // ── 指紋そのものの性質（**ここが緩むと確認が形だけになる**）───────────
  reset();
  M.db.TABLES.test_artifacts = [hcRow('2026-03-29', 54, hcMd('4.4'))];
  const f1 = M.manual.planFingerprint(await M.manual.buildDeliveryPlan({ uid: UID_A, sourcePrefix: P, deliveryPrefix: '' }));
  const f2 = M.manual.planFingerprint(await M.manual.buildDeliveryPlan({ uid: UID_A, sourcePrefix: P, deliveryPrefix: '' }));
  eq('K-48 **何も変わっていなければ指紋は同じ** (生成時刻・採番で毎回変わらない)', f1, f2);
  {
    const sb = JSON.parse(M.manual.stableBody(JSON.stringify({
      exported_at: '2026-10-01T00:00:00Z', diagnostic_id: 'x',
      format_id: 'HealthCheckupData', client_id: 'u', test_date: '2026-03-29',
      data: { measurements: [{ item_name: 'AST', value: '22' }] },
    })));
    eq('K-48 生成メタ (exported_at / diagnostic_id) だけを外す',
      Object.keys(sb).sort(), ['client_id', 'data', 'format_id', 'test_date']);
    eq('K-48 **データは 1 つも外さない**', sb.data.measurements[0].value, '22');
  }

  M.db.TABLES.test_artifacts = [hcRow('2026-03-29', 54, hcMd('4.9'))];   // 値が変わった
  const f3 = M.manual.planFingerprint(await M.manual.buildDeliveryPlan({ uid: UID_A, sourcePrefix: P, deliveryPrefix: '' }));
  ok('K-48 **中身が変われば指紋も変わる** (同じ日・同じ件数でも検知する)', f3 !== f1, `${f1} / ${f3}`);

  M.db.TABLES.test_artifacts = [hcRow('2026-03-29', 54, hcMd('4.9')), hcRow('2025-02-17', 53, hcMd('4.2'))];
  const f4 = M.manual.planFingerprint(await M.manual.buildDeliveryPlan({ uid: UID_A, sourcePrefix: P, deliveryPrefix: '' }));
  ok('K-48 年が増えても指紋が変わる', f4 !== f3);

  const other = await callApi({ diagnosticUserId: UID_B, sourcePrefix: P, deliveryPrefix: '' });
  eq('C-12 スペシャル以外は API でも拒否', other.status, 409);

  // PII を admin 応答に載せない
  ok('I-36 応答に測定値・氏名・生年月日が出てこない',
    !/(measurement|item_name|birth|dob|氏名)/i.test(JSON.stringify(prev.json)),
    JSON.stringify(prev.json).slice(0, 200));
}

// ══════════════════════════════════════════════════════════════════════
// G. 検診・人間ドックの Admin 登録 (§11)
// ══════════════════════════════════════════════════════════════════════
//
// **DB は守ってくれない。** `test_artifacts` の UNIQUE は `source` を含み、
// `external_test_id` が NULL のとき PostgreSQL は NULL 同士を別物として扱うので効かない。
// 本人がアプリで入れた回に admin が同じ日付で入れると **active が 2 行**になり、
// 画面上は「登録できた」ようにしか見えない（本田さんの重複事故と同型）。
console.log('\nG. 検診・人間ドックの Admin 登録 (saveAdditionalArtifact を実際に動かす)\n');
{
  const H = await import('./lib/sat-harness.mjs');
  const { M, UID_A } = H;
  const arts = () => M.db.TABLES.test_artifacts ?? [];
  const hcMd2 = '## 検査結果\n\n| 検査項目 | 読み取った値 | 単位 |\n|---|---|---|\n| AST(GOT) | 22 | U/L |\n';

  ok('G-26 health_checkup が Admin 登録の対象に入っている',
    M.addOrig.isAdditionalTestType('health_checkup'), 'ここが false だと画面に出てこない');
  eq('G-26 format_id は HealthCheckupData', M.sat.FORMAT_BY_TEST_TYPE.health_checkup, 'HealthCheckupData');
  ok('G-26 measurement 型として扱う (items 型ではない)', !M.sat.isItemsFormat('health_checkup'));

  // G-26 / G-27: 本人 user_upload の回がある日に Admin 登録 → **その行を更新する**
  M.db.reset();
  M.db.TABLES.test_artifacts = [{
    id: 'art-user-1', diagnostic_user_id: UID_A, test_type: 'health_checkup',
    test_date: '2025-02-17', status: 'active', source: 'user_upload',
    display_mode: 'scan_md', scan_md: '（本人のスキャン）', created_at: '2025-02-17T00:00:00Z',
  }];
  let r = await M.sat.saveAdditionalArtifact({
    uid: UID_A, testType: 'health_checkup', testDate: '2025-02-17',
    markdownClean: hcMd2, measurements: [{ item_name: 'AST(GOT)', value: '22' }],
  });
  eq('G-26 **2 行目を作らない**（本人の行を更新する）',
    [r.ok, r.created, arts().length], [true, false, 1]);
  eq('G-26 更新したのは本人の行', r.artifactId, 'art-user-1');
  eq('G-27 source / test_date / status を変えない',
    [arts()[0].source, arts()[0].test_date, arts()[0].status], ['user_upload', '2025-02-17', 'active']);
  ok('G-27 scan_md は新しい内容に差し替わる', String(arts()[0].scan_md).includes('AST(GOT)'));
  ok('G-27 display_mode も触らない', arts()[0].display_mode === 'scan_md');

  // G-28: 同日 active が 2 件 → 自動で選ばず止まる
  M.db.reset();
  M.db.TABLES.test_artifacts = [
    { id: 'a1', diagnostic_user_id: UID_A, test_type: 'health_checkup', test_date: '2025-02-17', status: 'active', source: 'user_upload', display_mode: 'scan_md', created_at: '2025-02-17T00:00:00Z' },
    { id: 'a2', diagnostic_user_id: UID_A, test_type: 'health_checkup', test_date: '2025-02-17', status: 'active', source: 'admin_batch', display_mode: 'scan_md', created_at: '2025-03-01T00:00:00Z' },
  ];
  r = await M.sat.saveAdditionalArtifact({
    uid: UID_A, testType: 'health_checkup', testDate: '2025-02-17',
    markdownClean: hcMd2, measurements: [{ item_name: 'AST(GOT)', value: '22' }],
  });
  eq('G-28 同日 active が 2 件なら **自動で選ばず止まる**', [r.ok, r.error], [false, 'artifact_ambiguous']);
  eq('G-28 候補を返して人に決めさせる', (r.candidates ?? []).length, 2);
  eq('G-28 止めたので行は増えていない', arts().length, 2);

  // G-29: 受診日が読めない回は保存しない（today へ落とさない）
  M.db.reset();
  for (const bad of ['', '2025/02/17', 'today', '2025-13-45']) {
    const rb = await M.sat.saveAdditionalArtifact({
      uid: UID_A, testType: 'health_checkup', testDate: bad,
      markdownClean: hcMd2, measurements: [{ item_name: 'AST(GOT)', value: '22' }],
    });
    eq(`G-29 受診日 ${JSON.stringify(bad)} は保存しない`, [rb.ok, rb.error], [false, 'invalid_test_date']);
  }
  eq('G-29 **today へ落として行を作っていない**', arts().length, 0);

  // 既存が無い回は新規作成（admin_batch）
  M.db.reset();
  r = await M.sat.saveAdditionalArtifact({
    uid: UID_A, testType: 'health_checkup', testDate: '2024-02-10',
    markdownClean: hcMd2, measurements: [{ item_name: 'AST(GOT)', value: '22' }],
  });
  eq('G-26 既存が無ければ新規作成する', [r.ok, r.created, arts().length], [true, true, 1]);
  eq('G-26 新規は source=admin_batch', arts()[0].source, 'admin_batch');

  // §11.5 複数年を壊さない — 年ごとに別の行になる
  for (const d of ['2025-02-17', '2026-03-29']) {
    await M.sat.saveAdditionalArtifact({
      uid: UID_A, testType: 'health_checkup', testDate: d,
      markdownClean: hcMd2, measurements: [{ item_name: 'AST(GOT)', value: '22' }],
    });
  }
  eq('G-26 複数年は年ごとに 1 行（同じ日付へ畳まれない）',
    arts().map((a) => a.test_date).sort(), ['2024-02-10', '2025-02-17', '2026-03-29']);

  // **persistAdminBatchArtifact を直接呼んでいない**（あれは admin_batch の行しか片付けない）
  ok('G-26 saveAdditionalArtifact 以外から persistAdminBatchArtifact を呼んでいない',
    !/persistAdminBatchArtifact/.test(code('src/pages/api/admin/special-additional-tests/finalize.ts')),
    'API から直接呼ぶと本人の行の隣に 2 行目ができる');
}

console.log(`\n${fails.length ? '✗' : '✓'} ${fails.length ? `${fails.length} 件 失敗` : '全件 OK'}`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exit(fails.length ? 1 : 0);
