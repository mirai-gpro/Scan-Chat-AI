#!/usr/bin/env node
/**
 * Elith 下りの自動取り込みの検査。
 *
 * **「そう書いてある」では済ませず、実物を transpile して動かす** (verify-special-accounts と同じ流儀)。
 * S3 と Supabase だけスタブに差し替えるので、DB も鍵も要らない。
 *
 * ここが静かに壊れると、**取り込まれていないのに誰も気づかない**
 * (画面は前の版を出し続けるので「空」にもならない)。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const fails = [];
const ok = (label, cond, why) => {
  if (!cond) fails.push(`${label}${why ? ` — ${why}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
};
const read = (p) => readFileSync(resolve(p), 'utf8');
const CACHE = resolve('.verify-cache');
rmSync(CACHE, { recursive: true, force: true });
mkdirSync(CACHE, { recursive: true });

const ts = (await import('typescript')).default;
const js = (src) => ts.transpileModule(src, { compilerOptions: { target: 'ES2022', module: 'ESNext' } }).outputText;

// ── 実物を読み込む (S3 / 取り込み本体だけスタブ) ──────────────────────
const M = await (async () => {
  writeFileSync(resolve(CACHE, 'ei-s3.mjs'), `
export let __objects = [];
export let __texts = {};
export let __configured = true;
export const __reads = [];
export const setFixture = (objs, texts) => { __objects = objs; __texts = texts; };
export const setConfigured = (v) => { __configured = v; };
export const isS3Configured = () => __configured;
export const listObjects = async (prefix) => __objects.filter(k => k.startsWith(prefix)).map(k => ({ key: k, size: 1 }));
export const getObjectText = async (key) => { __reads.push(key); if (!(key in __texts)) throw new Error('no such key ' + key); return __texts[key]; };
`);
  writeFileSync(resolve(CACHE, 'ei-ingest.mjs'), `
export const __calls = [];
export let __fail = false;
export const setFail = (v) => { __fail = v; };
export const ingestElithReport = async (sb, input) => {
  __calls.push(input);
  if (__fail) return { ok: false, id: null, error: 'db_failed', detail: 'stub' };
  return { ok: true, id: 'row-' + __calls.length };
};
`);
  writeFileSync(resolve(CACHE, 'ei-adapter.mjs'), 'export const buildReportVM = () => ({});\n');
  const body = js(read('src/lib/elith-intake.ts')
    .replace(/from '\.\/s3'/g, "from './ei-s3.mjs'")
    .replace(/from '\.\/elith-report-ingest'/g, "from './ei-ingest.mjs'")
    .replace(/from '\.\/report-adapter'/g, "from './ei-adapter.mjs'"));
  if (!/ei-s3/.test(body) || !/ei-ingest/.test(body)) {
    fails.push('verify: import の差し替えに失敗 (import 文の形が変わった)');
  }
  const out = resolve(CACHE, 'ei-intake.mjs');
  writeFileSync(out, body);
  return { ...(await import(out)), s3: await import(resolve(CACHE, 'ei-s3.mjs')), ing: await import(resolve(CACHE, 'ei-ingest.mjs')) };
})();

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const F = (u, d, n) => `output/user/${u}/date/${d}/${n}`;

/** source_key を持つ行を返すだけの Supabase スタブ。 */
const sbStub = (ingested = []) => ({
  schema: () => ({
    from: () => ({
      select: () => ({ not: async () => ({ data: ingested.map((k) => ({ source_key: k })), error: null }) }),
    }),
  }),
});

// ══════════════════════════════════════════════════════════════════════
console.log('\n① キーの読み取り (個人ID > 日付 > 固定名)\n');
{
  const { folders, skippedKeys } = M.groupByFolder([
    F(U1, '2026_09_16', 'report_text.json'),
    F(U1, '2026_09_16', 'health_checkup.json'),
    F(U2, '2026_09_16', 'report_text.json'),
    'output/user/not-a-uuid/date/2026_09_16/report_text.json',
    `output/user/${U1}/2026_09_16/report_text.json`,          // date/ が無い
    `output/user/${U1}/date/20260916/report_text.json`,        // 日付の形が違う
    'user/xxx/date/2026_09_16/report_text.json',               // 上り (読んではいけない)
  ]);
  ok('1 件 = 1 フォルダにまとまる', folders.size === 2, `${folders.size} 件`);
  ok('同じフォルダのファイルが揃う', folders.get(`output/user/${U1}/date/2026_09_16/`)?.files.length === 2);
  ok('形の違うキーは黙って捨てず数に出す', skippedKeys.length === 4, `${skippedKeys.length} 件`);
  ok('上りのキーを拾わない', !skippedKeys.some((k) => !k.startsWith('output/')) === false || skippedKeys.includes('user/xxx/date/2026_09_16/report_text.json'));
  ok('固定名だけを見る (推測しない)',
    M.classifyFile('report_text.json') === 'report'
      && M.classifyFile('health_checkup.json') === 'health_checkup'
      && M.classifyFile('report_text (1).json') === null
      && M.classifyFile('report_text_20260916.json') === null);
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n② 揃った判定 = ファイル 2 つ以上 (発注者確定 2026-09-17)\n');
{
  M.s3.setFixture([F(U1, '2026_09_16', 'report_text.json')], {});
  const r = await M.runElithIntake(sbStub(), {});
  ok('1 つだけなら保留 (先方の処理途中)', r.counts.holding === 1 && r.counts.done === 0,
    JSON.stringify(r.counts));
  ok('保留はエラーにしない', r.ok === true);

  M.s3.setFixture(
    [F(U1, '2026_09_16', 'report_text.json'), F(U1, '2026_09_16', 'health_checkup.json')],
    { [F(U1, '2026_09_16', 'report_text.json')]: '{"a":1}',
      [F(U1, '2026_09_16', 'health_checkup.json')]: '{"b":[]}' },
  );
  M.ing.__calls.length = 0;
  const r2 = await M.runElithIntake(sbStub(), {});
  ok('2 つ揃えば取り込む', r2.counts.done === 1, JSON.stringify(r2.counts));
  ok('client_id をそのまま diagnostic_user_id に使う', M.ing.__calls[0]?.diagnosticUserId === U1);
  ok('検査値はファイル別の入れ子で渡す', !!M.ing.__calls[0]?.checkup?.health_checkup);
  ok('dict なら elith-v2.0', M.ing.__calls[0]?.schemaVersion === 'elith-v2.0');
  ok('source_key にフォルダを入れる (二重取り込みの歯止め)',
    M.ing.__calls[0]?.sourceKey === `output/user/${U1}/date/2026_09_16/`);
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n③ 取りこぼしゼロ / 二度取り込まない\n');
{
  const keys = [F(U1, '2026_09_16', 'report_text.json'), F(U1, '2026_09_16', 'health_checkup.json'),
                F(U2, '2026_09_10', 'report_text.json'), F(U2, '2026_09_10', 'blood_test.json')];
  const texts = Object.fromEntries(keys.map((k) => [k, '{"a":1}']));
  M.s3.setFixture(keys, texts);
  M.ing.__calls.length = 0;
  // U2 は取り込み済み。**日付が古くても U1 は拾う** (日付で絞らない)。
  const r = await M.runElithIntake(sbStub([`output/user/${U2}/date/2026_09_10/`]), {});
  ok('取り込み済みは飛ばす', r.counts.ingested === 1, JSON.stringify(r.counts));
  ok('未取込は日付が古くても拾う', r.counts.done === 1 && M.ing.__calls[0]?.diagnosticUserId === U1);
  /*
   * **コメントを外してから見る。** この節の理由をソースにも書いてあるので、
   * 素のテキストで探すと**自分の注意書きに当たって落ちる** (実際に一度落ちた)。
   */
  const intakeCode = read('src/lib/elith-intake.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('日付で絞っていない',
    !/getDate\(\)|yesterday|Date\.now\(\)\s*-|subDays/.test(intakeCode),
    '「昨日ぶん」にすると件数が増えた日に追い越したぶんを永久に落とす');
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n④ 壊れたものを黙って取り込まない\n');
{
  const k1 = F(U1, '2026_09_16', 'report_text.json'), k2 = F(U1, '2026_09_16', 'health_checkup.json');
  M.s3.setFixture([k1, k2], { [k1]: '{ こわれた JSON', [k2]: '{}' });
  M.ing.__calls.length = 0;
  const r = await M.runElithIntake(sbStub(), {});
  ok('壊れた JSON は要確認にして取り込まない', r.counts.needs_review === 1 && M.ing.__calls.length === 0);

  M.s3.setFixture([k2, F(U1, '2026_09_16', 'cancer_risk.json')], { [k2]: '{}', [F(U1, '2026_09_16', 'cancer_risk.json')]: '{}' });
  M.ing.__calls.length = 0;
  const r2 = await M.runElithIntake(sbStub(), {});
  ok('report_text.json が無ければ取り込まない', r2.counts.needs_review === 1 && M.ing.__calls.length === 0,
    '紙面の材料が無い = 空の行を作らない');

  M.s3.setFixture([k1, k2], { [k1]: '{"a":1}', [k2]: '{}' });
  M.ing.setFail(true); M.ing.__calls.length = 0;
  const r3 = await M.runElithIntake(sbStub(), {});
  M.ing.setFail(false);
  ok('取り込みに失敗したら failed として残す', r3.counts.failed === 1, JSON.stringify(r3.counts));

  M.s3.setConfigured(false);
  const r4 = await M.runElithIntake(sbStub(), {});
  M.s3.setConfigured(true);
  ok('S3 未設定を「0 件」と言わない', r4.ok === false && r4.error === 's3_not_configured');
  const r5 = await M.runElithIntake(null, {});
  ok('Supabase 未設定も「0 件」と言わない', r5.ok === false && r5.error === 'supabase_not_configured');
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n⑤ dry-run と入口\n');
{
  const k1 = F(U1, '2026_09_16', 'report_text.json'), k2 = F(U1, '2026_09_16', 'health_checkup.json');
  M.s3.setFixture([k1, k2], { [k1]: '{"a":1}', [k2]: '{}' });
  M.ing.__calls.length = 0;
  const r = await M.runElithIntake(sbStub(), { dryRun: true });
  ok('dry-run は 1 件も書かない', M.ing.__calls.length === 0 && r.counts.ready === 1);

  M.ing.__calls.length = 0;
  const r2 = await M.runElithIntake(sbStub(), { onlyClientId: U2 });
  ok('client_id で絞れる (1 人だけ流せる)', r2.items.length === 0 && M.ing.__calls.length === 0);

  const cron = read('src/pages/api/cron/elith-intake.ts');
  const admin = read('src/pages/api/admin/elith-intake.ts');
  ok('毎日の入口と随時の入口が同じ本体を呼ぶ',
    /runElithIntake\(/.test(cron) && /runElithIntake\(/.test(admin));
  ok('cron は鍵が無い本番を拒否する (fail-closed)',
    /if \(!cron && !admin\) return import\.meta\.env\.DEV === true;/.test(cron));
  ok('随時の入口は ADMIN_API_KEY', /isAdminAuthorized\(request\)/.test(admin));
  const vercel = JSON.parse(read('vercel.json'));
  const job = (vercel.crons ?? []).find((c) => c.path === '/api/cron/elith-intake');
  ok('9:00 JST = 0:00 UTC で登録されている', job?.schedule === '0 0 * * *', job?.schedule,
    'Vercel Cron は UTC');
  ok('スキャンの cron を壊していない',
    (vercel.crons ?? []).some((c) => c.path === '/api/cron/scan-worker' && c.schedule === '* * * * *'));
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n⑥ 書き込み口は 1 つ\n');
{
  const upload = read('src/pages/api/admin/elith-report/upload.ts');
  const core = read('src/lib/elith-report-ingest.ts');
  ok('手動アップロードも同じ本体を通る', /ingestElithReport\(/.test(upload));
  ok('アップロード側に insert を残していない',
    !/\.from\('diagnosis_results'\)[\s\S]{0,200}\.insert\(/.test(upload),
    '2 か所に書くと世代管理が片方だけ腐る');
  ok('世代管理は本体にある', /status: 'superseded'/.test(core));
  /*
   * **「在ること」と「順番」を両方見る。** 前後関係だけだと、チェックごと消したとき
   * `indexOf` が -1 になり **-1 < 正の数 = 通ってしまう** (実際に退行注入で素通りした)。
   */
  const iDup = core.indexOf(".eq('source_key'");
  const iSup = core.indexOf("status: 'superseded'");
  ok('superseded を撃つ前に二重取り込みを見る',
    iDup >= 0 && iSup >= 0 && iDup < iSup,
    '先に落とすと、止まったとき最新 1 件が消えたように見える');
}

console.log(fails.length
  ? `\n✗ ${fails.length} 件\n - ` + fails.join('\n - ')
  : '\n✓ 取り込みは「まだ取り込んでいないもの」を拾う。保留と要確認は黙って消えない。');
rmSync(CACHE, { recursive: true, force: true });
process.exit(fails.length ? 1 : 0);
