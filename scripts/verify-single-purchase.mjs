#!/usr/bin/env node
/**
 * `npm run verify:single-purchase` — **「AI疾病予防報告書 単品購入」の画面**の回帰チェック。
 *
 * 正本: `docs/operations/スペシャルアカウント_仕様書.md` §14。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【この画面の要】入口が違えば進捗も違う。**埋まらない枠を並べない。**
 * ══════════════════════════════════════════════════════════════════════
 *
 * スペシャルアカウントは EC で購入していないので、サブスク契約も検査キットも
 * 構造的に存在しない。材料は**自分でスキャンした検診・人間ドック ＋ AI問診**だけ。
 * コースプラン用の枠 (キット進捗 / 検査 5 種) をそのまま出すと、
 * **永久に埋まらない枠が 5 つ居座る**。
 *
 * **ここは静かに壊れる** — 判定に件数を足す・順番を入れ替える・問診の記録元を
 * クライアント申告に戻す、のどれも画面は一見正常に見えるので、目視では守れない。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
/** コメント行を落とす (経緯の説明に旧コードが書いてあるため、そこを拾わない)。 */
/*
 * コメントを落とす。**ブロックごと消す。**
 *
 * Astro の波括弧つきブロックコメントは中の行が `*` で始まらないので、
 * 行頭だけを見る素朴な版では**本文として残る**。この検査を書いた日に実際に踏んだ:
 * 「もうすぐできます」とは書かない、と説明したコメント自身が禁止語の検査に引っかかった。
 * (この説明文に実例を書くと、この JSDoc 自体が途中で閉じてしまうので書かない。)
 */
const stripComments = (t) => t
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((ln) => !/^\s*\/\//.test(ln)).join('\n');
const code = (p) => stripComments(read(p));

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

const dash = read('src/pages/dashboard.astro');

// ══════════════════════════════════════════════════════════════════════
// ① どちらの画面にするかの判定
// ══════════════════════════════════════════════════════════════════════
console.log('\n① 単品購入モードの判定\n');
{
  ok('isSpecialAccount 1 本で決めている',
    /const singlePurchase = isSpecialAccount\(data\?\.diagnosticUserId\);/.test(dash),
    '判定はこれだけ。表示中の uid で決まる');

  /*
   * **件数を AND しない。** 「キットが 0 件なら単品購入」にすると、実顧客でも
   * 連携前は 0 件なので**コースプランの人の画面が黙って変わる**。
   * デモ枠で同じ形の実障害を踏んでいる (仕様書 §2 の「実データの有無は条件ではない」)。
   */
  const line = (dash.match(/const singlePurchase = .*/) ?? [''])[0];
  ok('判定に件数を AND していない',
    !/\.length|\bcount\b|shipments|subscription/.test(line),
    `件数で分岐すると実顧客の画面が黙って変わる → ${line.trim()}`);

  ok('判定に admin が混ざっていない',
    !/isAdmin/.test(line),
    'admin かどうかは資格ではない (デモ枠で踏んだ誤り)');
}

// ══════════════════════════════════════════════════════════════════════
// ② 出す枠 / 出さない枠
// ══════════════════════════════════════════════════════════════════════
console.log('\n② 埋まらない枠を並べない\n');
{
  /*
   * **進捗は 1 つのセクションに統合した** (発注者指示 2026-09-15)。
   * コースプランでも最初に AI問診と検診・人間ドックのスキャンが要るので、
   * 「検査キットだけの進捗」では次に何をすればよいか分からない。
   */
  ok('進捗セクションは 1 つ (キット専用の枠を別に置かない)',
    /<ProgressSection/.test(dash) && !/<KitProgressCard/.test(dash),
    'キット専用の枠を残すと、AI問診とスキャンが進捗の外に置き去りになる');

  ok('入口で中身を変える (mode を渡している)',
    /mode=\{singlePurchase \? 'single' : 'course'\}/.test(dash),
    'course は検査キットの行を持ち、single は持たない');

  const sec = read('src/components/dashboard/ProgressSection.astro');
  /*
   * **キットの行そのものが `course` で囲まれていること**を見る。
   * 単に「ファイル内に `{course && (` がある」では**効かない** — ヘッダーの
   * 「進捗の詳細を見る」も同じ条件で囲まれているので、行側のガードを外しても通ってしまう
   * (この検査を書いた日に退行注入で実際に素通りした)。**行から遡って確かめる。**
   */
  ok('単品購入では検査キットの行を出さない',
    /\{course && \(\s*<li[\s\S]{0,400}?<KitProgressRows/.test(sec),
    '単品購入にキットは 1 つも無い');
  ok('キットの行は KitProgressRows に一本化されている',
    !/data-self-report/.test(sec),
    '自己申告ボタンは kit-self-report.ts と組。写して増やすと片方だけ腐る');
  ok('コースプランでも AI問診とスキャンを出す',
    /title: 'AI 問診'/.test(sec) && /title: '検診・人間ドックのスキャン'/.test(sec)
      && !/course \?[^\n]*title: 'AI 問診'/.test(sec),
    'コースプランでも最初にこの 2 つが要る (発注者指示 2026-09-15)');

  /*
   * **進捗は検査結果より上。** この入口の人にとって「次にすること」が本題で、
   * 検査結果はその結果として後から埋まる。逆だと、まだ空のカードを越えた先に本題が来る。
   */
  const iProgress = dash.indexOf('<ProgressSection');
  const iTests = dash.indexOf('<TestResultsSection');
  ok('進捗カードが検査結果より上にある', iProgress >= 0 && iTests >= 0 && iProgress < iTests,
    'まだ空の検査カードを越えた先に本題が来てしまう');

  ok('単品購入では検査を人間ドックの 1 種に絞る',
    /onlyTypes=\{singlePurchase \? \['health_checkup'\] : undefined\}/.test(dash),
    '血液 / がんリスク / AI疾病予測 / 遺伝子 は構造的に来ない = 行き止まりが 4 つ並ぶ');

  ok('単品購入でもプラン名を出す',
    /planName=\{singlePurchase \? singlePurchasePlanName : data\?\.subscription\?\.plan_name\}/.test(dash),
    '発注者指示 2026-09-15。単品は EC 購入が無く契約から引けないので app_config の文言を出す');
  ok('その文言は app_config にある',
    read('src/lib/app-config.ts').includes("key: 'ui.single_purchase_plan_name'"),
    'setConfig が未知キーとして弾く / admin から差し替えられない');

  ok('単品購入では主要導線 (⑥) を出さない',
    /\{!singlePurchase && \(\s*<section aria-label="主要な操作">/.test(dash),
    '進捗カードのボタンと行き先 (/scan・/chat) が同じ。同じ画面に同じ行き先を 2 つ並べない');
}

// ══════════════════════════════════════════════════════════════════════
// ③ コースプランの画面を変えていないこと
// ══════════════════════════════════════════════════════════════════════
console.log('\n③ コースプランの画面は不変\n');
{
  const tests = read('src/components/dashboard/TestResultsSection.astro');
  ok('onlyTypes の既定は 5 種すべて',
    /const visibleTypes = onlyTypes && onlyTypes\.length > 0/.test(tests),
    '既定 (undefined) で絞ると全員の画面が変わる');
  /*
   * **5 枚のときの grid 文字列を 1 文字も変えない。** 列数を枚数から決めるようにしたので、
   * ここが変わるとコースプランの人の並びが黙って変わる。
   */
  ok('5 枚のときの列指定が従来どおり',
    tests.includes("5: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5',"),
    'コースプランの検査カードの並びが変わる');
  ok('クラスを文字列連結で作っていない',
    !/grid-cols-\$\{/.test(stripComments(tests)),
    'Tailwind はソースを文字列として走査するので、組み立てると生成されず崩れる');
}

// ══════════════════════════════════════════════════════════════════════
// ④ AI問診の完了をどう記録するか
// ══════════════════════════════════════════════════════════════════════
console.log('\n④ 問診の完了記録\n');
{
  const ex = read('src/pages/api/interview/export.ts');

  /*
   * **保存先は Cookie から解決した本人の uid だけ。**
   * `body.diagnosticUserId` はクライアント申告なので、使うと**他人の完了を作れてしまう**
   * (`/api/scan/save` と同じ規律)。
   */
  ok('Cookie の uid で記録している',
    /recordInterviewCompletion\(viewer\.selfUid,/.test(ex),
    'body の申告で記録すると他人の完了を作れてしまう');
  ok('body の申告で記録していない',
    !/recordInterviewCompletion\([^)]*body\./.test(ex));

  /*
   * **S3 の成否と独立。** 本人が問診を終えた事実は、書き出しが失敗しても変わらない。
   * 逆に S3 成功の中だけに置くと、S3 未設定の環境で永久に「未回答」になる。
   */
  const iRec = ex.indexOf('recordInterviewCompletion(');
  const iS3 = ex.indexOf('isS3Configured()');
  ok('S3 の成否より前に記録している', iRec >= 0 && iS3 >= 0 && iRec < iS3,
    'S3 未設定の環境で永久に「未回答」になる');

  const lib = read('src/lib/interview-completion.ts');
  /*
   * **回答の中身を保存しない。** answers には設問 `M-NAME` (服薬名) 等の医療情報が入る。
   * 残すのは完了日時と設問数だけ (中身の置き場所は S3 の納品 JSON 1 か所のまま)。
   */
  const insertBlock = lib.slice(lib.indexOf('const row = {'), lib.indexOf('};', lib.indexOf('const row = {')));
  ok('保存するのは 4 列だけ (回答の中身を持たない)',
    /diagnostic_user_id/.test(insertBlock) && /completed_at/.test(insertBlock)
      && /answered_count/.test(insertBlock) && /diagnostic_id/.test(insertBlock)
      && !/answers/.test(insertBlock),
    'answers を入れると医療情報が診断系に増える');
  ok('例外を投げない (問診の書き出しを壊さない)',
    /catch \(e\)[\s\S]{0,200}return false;/.test(lib));

  // migration は**前進で足す** (適用済みを編集しない)
  ok('migration を前進で足している',
    read('supabase/migrations/20260915000010_interview_completions.sql').includes('create table if not exists diagnosis.interview_completions'),
    '適用済みの migration を編集すると db push でスキップされ、環境ごとに中身が食い違う');
  ok('test_artifacts の CHECK を触っていない',
    !/alter table diagnosis\.test_artifacts/.test(read('supabase/migrations/20260915000010_interview_completions.sql')),
    '問診は検査ではない。値を足すと「検査結果 5 種」の一覧にも現れる');
}

// ══════════════════════════════════════════════════════════════════════
// ④-2 報告書が無いときはタイルをグレーアウト (発注者指示 2026-09-15)
// ══════════════════════════════════════════════════════════════════════
console.log('\n④-2 報告書が無いときのタイル\n');
{
  const tile = read('src/components/dashboard/ReportLinkCard.astro');

  /*
   * **押せないものをリンクにしない。** `<a>` のまま色だけ変えると、見た目は灰色なのに
   * 押せてしまい、中身が 1 件も無い紙面 (`emptyVM`) が「報告書」として開く。
   */
  ok('報告書が無いときは <a> にしない',
    /aria-disabled="true"/.test(tile) && /\{available \? \(\s*<a/.test(tile),
    '色だけ変えても押せてしまい、中身の無い紙面が開く');
  ok('無いときは brand 塗りをやめる',
    /available \? 'border-brand-600 bg-brand-600 text-white' :/.test(tile),
    'この画面で唯一の brand 塗り = 主役。中身が無い回に主役として置かない');

  /*
   * **受領日の有無で決めない。** デモ用アカウントは行が無くてもサンプルを開けるので、
   * 受領日だけで判定するとデモの入口が塞がる。
   */
  ok('開けるかは呼び出し側が渡す (受領日から推測しない)',
    /available\?: boolean;/.test(tile) && !/available = !!receivedAt/.test(tile));
  ok('デモはサンプルを開けたまま',
    /const reportAvailable = !!data\?\.latestResult \|\| demoShown;/.test(dash),
    'デモ用アカウントは行が無くても sample() が返るので、塞ぐと入口が消える');
}

// ══════════════════════════════════════════════════════════════════════
// ⑤ 実際に動かす (完了日時の扱い・見つからないときの倒し方)
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑤ interview-completion.ts を実際に動かす\n');
await (async () => {
  const ts = (await import('typescript')).default;
  const CACHE = resolve(ROOT, 'node_modules/.cache');
  mkdirSync(CACHE, { recursive: true });

  writeFileSync(resolve(CACHE, 'sp-supabase.mjs'), `
export const __inserted = [];
export let __rows = [];
export const __setRows = (r) => { __rows = r; };
export let __fail = false;
export const __setFail = (v) => { __fail = v; };
export const getServerSupabase = () => ({
  schema: () => ({
    from: () => ({
      insert: async (row) => { if (__fail) throw new Error('boom'); __inserted.push(row); return { error: null }; },
      select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: __rows, error: null }) }) }) }),
    }),
  }),
});
`);
  const src = read('src/lib/interview-completion.ts').replace(/from '\.\/supabase'/, "from './sp-supabase.mjs'");
  if (!src.includes('sp-supabase')) { fails.push('verify: supabase の差し替えに失敗 (import 文の形が変わった)'); return; }
  const out = resolve(CACHE, 'sp-interview-completion.mjs');
  writeFileSync(out, ts.transpileModule(src, { compilerOptions: { target: 'ES2022', module: 'ESNext' } }).outputText);
  const M = await import(out);
  const S = await import(resolve(CACHE, 'sp-supabase.mjs'));

  const UID = 'aaaaaaaa-1111-2222-3333-444444444444';

  eq('uid が無ければ記録しない', await M.recordInterviewCompletion(null, {}), false);
  eq('  → 書き込みに行かない', S.__inserted.length, 0);

  const t = Date.UTC(2026, 8, 15, 1, 2, 3);
  eq('正しい完了日時はそのまま入る', await M.recordInterviewCompletion(UID, { completedAt: t, answeredCount: 35 }), true);
  eq('  → completed_at', S.__inserted[0].completed_at, new Date(t).toISOString());
  eq('  → answered_count', S.__inserted[0].answered_count, 35);
  eq('  → 回答の中身は入っていない', Object.keys(S.__inserted[0]).sort(),
    ['answered_count', 'completed_at', 'diagnostic_id', 'diagnostic_user_id']);

  /*
   * **クライアント申告をそのまま入れない。** 未来や桁違いは受信時刻へ倒す
   * (捏造ではなく「受け取った時刻」)。ここが素通しだと 2099 年の完了日が紙面に出る。
   */
  S.__inserted.length = 0;
  await M.recordInterviewCompletion(UID, { completedAt: Date.now() + 400 * 86400_000 });
  const far = new Date(S.__inserted[0].completed_at).getTime();
  ok('遠い未来の申告は受信時刻へ倒す', Math.abs(far - Date.now()) < 60_000);
  S.__inserted.length = 0;
  await M.recordInterviewCompletion(UID, { completedAt: 1 });
  ok('桁違いの申告も受信時刻へ倒す', Math.abs(new Date(S.__inserted[0].completed_at).getTime() - Date.now()) < 60_000);

  // 記録に失敗しても投げない (問診の書き出しを 500 にしない)
  S.__setFail(true);
  eq('記録が失敗しても投げず false を返す', await M.recordInterviewCompletion(UID, {}), false);
  S.__setFail(false);

  /*
   * **見つからない = 未回答**に倒す。「たぶん済んでいる」側へ倒すと、
   * 画面が「回答済み」と言い切ってしまう (捏造)。
   */
  S.__setRows([]);
  eq('記録が無ければ null (＝未回答)', await M.getLatestInterviewCompletion(UID), null);
  S.__setRows([{ completed_at: '2026-09-15T01:02:03.000Z', answered_count: 35 }]);
  eq('記録があれば最新を返す', (await M.getLatestInterviewCompletion(UID))?.completedAt, '2026-09-15T01:02:03.000Z');
  eq('uid が無ければ引かない', await M.getLatestInterviewCompletion(null), null);
})();

// ══════════════════════════════════════════════════════════════════════
// ⑥ 進捗カードが状態を捏造しないこと
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑥ 進捗カードの文言\n');
{
  const card = read('src/components/dashboard/ProgressSection.astro');
  /*
   * **「未実行」と「完了済」の 2 語で言い切る** (発注者指示 2026-09-15)。
   * 状態はアイコン + テキスト + 色の 3 点セット (UI 確定事項) — 色だけで表さない。
   */
  ok('未実行 / 完了済 の 2 語で出す',
    /\{s\.done \? '完了済' : '未実行'\}/.test(card));
  ok('状態はアイコン + テキスト + 色の 3 点',
    /status-pill \$\{s\.done \? 'status-ok' : 'status-action'\}/.test(card)
      && /AppIcon name=\{s\.done \? 'ok' : 'action'\}/.test(card),
    '色だけで状態を表さない');
  ok('未実行のときは実行を促す',
    /実行してください/.test(stripComments(card)) && /を実行する/.test(card),
    '「未実行」とだけ出して、何をすればよいかを書かない画面にしない');
  ok('届いていない報告書に予測を書かない',
    !/もうすぐ|まもなく|準備中です|作成中/.test(stripComments(card)),
    '作成の時期を当社は知らない');
  /*
   * **報告書へのリンクを置かない** (導線は上の ReportLinkCard が持っている)。
   * 見るのは**リンク先**であって文言ではない — 本文で「報告書を読む」に言及するのは構わない。
   */
  ok('報告書へのリンクを 2 つ置かない',
    !/href=\{?[`'"]\/report/.test(card),
    '同じ画面に同じ行き先のボタンを 2 つ並べない');
}

// ══════════════════════════════════════════════════════════════════════
console.log('');
if (fails.length) {
  console.log(`✗ ${fails.length} 件`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✓ 単品購入の入口には、単品購入の進捗だけが出る。埋まらない枠を並べない。');
console.log('  問診の完了は Cookie の uid で・完了日時と設問数だけを記録する。');
