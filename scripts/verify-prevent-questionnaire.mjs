#!/usr/bin/env node
/**
 * `npm run verify:prevent-questionnaire` — **プリベント向け問診CSV と Partner Portal** の回帰チェック。
 *
 * 正本: `docs/lab/lab_data_pipeline_master_spec.md` §4-5.3 ／
 *       `docs/lab/kit_receipt_external_id_capture_spec.md` §7.1 / §7.1.1 ／
 *       `docs/lab/questionnaire_to_lab_csv_spec.md` §4.2。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【ここは静かに壊れる】
 * ══════════════════════════════════════════════════════════════════════
 *   - **前年のバーコードNo. で今年の CSV が出る**（画面も CSV も正常に見える）
 *   - **Portal 表示 / CSV の中身 / ファイル名のどれかだけ**がずれる
 *     （LAiF で実際に起きた「画面 `WF-2026-000123` / 中身 `W026000123`」）
 *   - `review_required` / `deferred` / `conflict` が**通ってしまう**
 *   - ゲートが**一覧側と DL 側で別物**になり、片方だけ古くなる
 *   - 中継（wellfort-site）が**ゲートを写して二重実装**になる
 *   - **内部 ID（`lab_tests.id` / `diagnostic_user_id` / `orders.id`）が Portal に出る**
 *
 * **「そう書いてあるか」で済ませず、実物を transpile して動かす。**
 */

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
/** コメント行を落とす（経緯の説明に旧コードが書いてあるので、そこを拾わない）。 */
const stripComments = (src) => src.split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');
const code = (p) => stripComments(read(p));

const fails = [];
let pass = 0;
const ts = (await import('typescript')).default;
mkdirSync(resolve(ROOT, 'node_modules/.cache'), { recursive: true });
const toJs = (src) => ts.transpileModule(src, { compilerOptions: { target: 'ES2022', module: 'ESNext' } }).outputText;
const load = async (relPath, subs = []) => {
  let src = read(relPath);
  for (const [re, to] of subs) src = src.replace(re, to ?? '');
  const b64 = Buffer.from(toJs(src), 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${b64}`);
};

const ok = (label, cond, why) => {
  if (cond) pass++; else fails.push(`${label}${why ? ` — ${why}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);

// ══════════════════════════════════════════════════════════════════════
// ① 純関数 — 3 値が 1 つの確定値から派生していること ＋ 様式の状態
// ══════════════════════════════════════════════════════════════════════
console.log('\n① CSV の組み立て (prevent-questionnaire-csv.ts)\n');
const csvmod = await load('src/lib/prevent-questionnaire-csv.ts');
const FIXTURE = 'scripts/prevent-csv-fixtures/expected_704000111.csv';
{
  const BARCODE = '704000111';
  const built = csvmod.buildPreventQuestionnaireCsv({
    barcodeNo: BARCODE,
    subject: { dateOfBirth: '1975-04-15', sex: 'male' },
    answers: [
      { id: 'B-HEIGHT', answer_label: '171.2' },
      { id: 'B-WEIGHT', answer_label: '68.4' },
      { id: 'S-STATUS', answer_label: '吸わない' },
      { id: 'D-FREQ', answer_label: '週2〜3日飲む' },
    ],
  });
  const lines = built.csv.replace(/^﻿/, '').trim().split('\r\n');
  const header = lines[0].split(',');
  const row = lines[1].split(',');

  eq('ファイル名はバーコードNo. そのもの', built.filename, '704000111.csv');
  eq('ファイル名に prefix/suffix を付けない', /^[0-9]+\.csv$/.test(built.filename), true);
  eq('1 列目の見出しは 会員ID/ユーザーID', header[0], '会員ID/ユーザーID');
  eq('1 列目の値はバーコードNo.', row[0], BARCODE);
  eq('生年月日が入る', row[1], '1975-04-15');
  eq('性別が入る', row[2], '男');
  eq('身長が入る', row[3], '171.2');
  eq('体重が入る', row[4], '68.4');

  // ★ は空（別ソースが未実装。捏造しない）
  const idx = (h) => header.indexOf(h);
  for (const h of ['ALAカプセル摂取日時', '採尿日時', '排尿回数', '採尿前日の薬', '採尿前日の飲酒', '採尿検体の冷凍保存']) {
    ok(`★ ${h} は空のまま（別ソースが未実装）`, idx(h) >= 0 && row[idx(h)] === '',
      `idx=${idx(h)} value=${JSON.stringify(row[idx(h)])}`);
  }

  // **★ の供給元を「AI問診に設問なし」で済ませていない**
  const pend = csvmod.PREVENT_CSV_PENDING_COLUMNS;
  eq('pending 列は 6 件', pend.length, 6);
  eq('ALA摂取日時の供給元は kit_progress',
    pend.find((c) => c.header === 'ALAカプセル摂取日時')?.from, 'kit_progress');
  eq('採尿日時の供給元は kit_progress',
    pend.find((c) => c.header === '採尿日時')?.from, 'kit_progress');
  ok('残り 4 件は供給元未確定 (undecided)',
    pend.filter((c) => c.from === 'undecided').length === 4,
    JSON.stringify(pend.map((c) => c.from)));
  ok('「AI問診に設問なし」という説明が残っていない',
    !/AI問診に設問なし/.test(read('src/lib/prevent-questionnaire-csv.ts')));

  // **3 値が同じ 1 つの引数から出ていること**
  ok('Portal 表示値 / CSV の行3 / ファイル名 が完全一致',
    row[0] === BARCODE && built.filename === `${BARCODE}.csv` && csvmod.preventCsvFilename(BARCODE) === built.filename);

  const other = csvmod.buildPreventQuestionnaireCsv({
    barcodeNo: '704000222', subject: { dateOfBirth: null, sex: null }, answers: [],
  });
  const orow = other.csv.replace(/^﻿/, '').trim().split('\r\n')[1].split(',');
  ok('バーコードNo. を変えると 3 つとも変わる',
    orow[0] === '704000222' && other.filename === '704000222.csv');
  eq('属性が取れない回は空欄（捏造しない）', [orow[1], orow[2]], ['', '']);

  const src = read('src/lib/prevent-questionnaire-csv.ts');
  ok('`WF-CANCER` が CSV 生成に無い', !/WF-CANCER/.test(src));
  ok('`整理番号` を値に使っていない', !/整理番号['"`]|整理番号 *[:=]/.test(stripComments(src)));
  eq('`barcode_no` の供給元はちょうど 1 列',
    csvmod.PREVENT_CSV_COLUMNS.filter((c) => c.source.kind === 'barcode_no').length, 1);
  eq('subject 由来は 生年月日・性別 の 2 列だけ',
    csvmod.PREVENT_CSV_COLUMNS.filter((c) => c.source.kind === 'subject').map((c) => c.source.field),
    ['date_of_birth', 'sex']);
  ok('列定義は 1 か所（PREVENT_CSV_COLUMNS）',
    (code('src/lib/prevent-questionnaire-csv.ts').match(/PREVENT_CSV_COLUMNS: readonly/g) || []).length === 1);
  eq('列数と項目数が一致', csvmod.PREVENT_CSV_COLUMN_COUNT, csvmod.PREVENT_CSV_COLUMNS.length);
  eq('ヘッダ行の列数 = 定義の列数', header.length, csvmod.PREVENT_CSV_COLUMN_COUNT);
  ok('BOM つき（Excel の文字化けよけ）', built.csv.startsWith('﻿'));

  // ── 様式が未確定であることを機械で保つ ──
  eq('様式の状態は unconfirmed（先方 Excel に合わせるまで）',
    csvmod.PREVENT_CSV_FORMAT_STATUS, 'unconfirmed');
  ok('先方提供 Excel がリポジトリに無いことを明記している',
    /ウェルフォート様_問診・アンケートデータ_例_問診1回\.xlsx/.test(src)
    && /両リポジトリに入っていない/.test(src));
  ok('「本番配布に使ってはいけない」と書いてある',
    /本番配布に使ってはいけない|本番配布不可/.test(src));

  // ── CSV fixture 比較（**様式が動いたら差分に出る**）──
  const want = (() => { try { return read(FIXTURE); } catch { return null; } })();
  if (want === null) {
    ok(`fixture が無い（${FIXTURE} を作ってください）`, false);
  } else {
    ok('CSV が fixture と 1 バイトも違わない', built.csv === want,
      `len got=${built.csv.length} want=${want.length}`);
  }
}

// ══════════════════════════════════════════════════════════════════════
// ② 一覧と DL — 3 つのゲートを実際に通す（Supabase / S3 / 相関はスタブ）
// ══════════════════════════════════════════════════════════════════════
console.log('\n② 一覧と DL (prevent-questionnaire.ts)\n');

const mkRow = (o) => ({
  diagnostic_user_id: o.uid ?? 'u-1',
  shipment_ref: o.shipmentRef ?? 's-1',
  provider: 'prevent',
  normalized_value: o.value,
  status: o.status ?? 'confirmed',
  lab_test_id: o.labTestId === undefined ? 'lt-1' : o.labTestId,
  lab_test_link_status: o.link ?? 'linked',
  captured_at: o.capturedAt ?? '2026-10-13T00:00:00Z',
});

const persistSubs = [
  [/^import type \{ SupabaseClient \}[\s\S]*?from '@supabase\/supabase-js';$/m, ''],
  [/^import type \{ Database \}[\s\S]*?from '\.\.\/types\/supabase';$/m, ''],
  [/^import \{\n[\s\S]*?\} from '\.\/external-test-id';$/m,
    `const PROVIDER_ID_COLUMN={prevent:'external_barcode',demecal:'external_test_id'};
     const PROVIDER_ID_KIND={prevent:'barcode_no',demecal:'inquiry_no'};
     const PROVIDER_TEST_TYPE={prevent:'cancer_urine',demecal:'blood'};
     const maskExternalId=(v,k=4)=>{const s=(v??'').trim();return !s?'':(s.length<=k?'*'.repeat(s.length):'*'.repeat(s.length-k)+s.slice(-k));};`],
];
const b64 = (src) => Buffer.from(toJs(src), 'utf8').toString('base64');
const persistSrc = (() => {
  let x = read('src/lib/external-id-persist.ts');
  for (const [re, to] of persistSubs) x = x.replace(re, to);
  return x;
})();

/**
 * `prevent-questionnaire.ts` を**実物のまま**動かす。
 * 差し替えるのは I/O（Supabase / S3 / app_config / 対象者属性）と
 * **相関の供給元（`findInterviewLink`）だけ**。
 * ゲート・`loadCapturedExternalId`・`pickInterviewByLink`・CSV 組み立ては本物。
 */
async function loadModule() {
  return load('src/lib/prevent-questionnaire.ts', [
    [/^import type \{ SupabaseClient \}[\s\S]*?from '@supabase\/supabase-js';$/m, ''],
    [/^import type \{ Database \}[\s\S]*?from '\.\.\/types\/supabase';$/m, ''],
    [/^import \{ getServerSupabase \} from '\.\/supabase';$/m, 'const getServerSupabase = () => globalThis.__SB;'],
    [/^import \{ getS3Config, getObjectText, listObjects \} from '\.\/s3';$/m,
      `const getS3Config = () => ({ prefix: 'p/', bucket: 'b', region: 'r' });
       const listObjects = async (prefix) => globalThis.__S3_LIST(prefix);
       const getObjectText = async (key) => globalThis.__S3_GET(key);`],
    [/^import \{ refreshConfig, cfgBool \} from '\.\/app-config';$/m,
      `const refreshConfig = async () => undefined;
       const cfgBool = (k) => globalThis.__FLAGS?.[k] === 'on';`],
    [/^import \{ resolveTargetSubject \} from '\.\/target-subject';$/m,
      'const resolveTargetSubject = async () => globalThis.__SUBJECT;'],
    [/^import \{ loadCapturedExternalId \} from '\.\/external-id-persist';$/m,
      `import { loadCapturedExternalId } from 'data:text/javascript;base64,${b64(persistSrc)}';`],
    [/^import \{\n  checkPreventQuestionnaireGate[\s\S]*?\} from '\.\/external-test-id';$/m,
      `import { checkPreventQuestionnaireGate, maskExternalId, normalizeExternalId } from 'data:text/javascript;base64,${b64(read('src/lib/external-test-id.ts'))}';`],
    [/^import \{\n  findInterviewLink, pickInterviewByLink,[\s\S]*?\} from '\.\/prevent-interview-link';$/m,
      `import { pickInterviewByLink } from 'data:text/javascript;base64,${b64(read('src/lib/prevent-interview-link.ts'))}';
       const findInterviewLink = async (a) => globalThis.__LINK(a);`],
    [/^import \{\n  buildPreventQuestionnaireCsv[\s\S]*?\} from '\.\/prevent-questionnaire-csv';$/m,
      `import { buildPreventQuestionnaireCsv, preventCsvFilename, PREVENT_CSV_COLUMN_COUNT, PREVENT_CSV_FORMAT_STATUS } from 'data:text/javascript;base64,${b64(read('src/lib/prevent-questionnaire-csv.ts'))}';`],
    // **様式の確定フラグだけ外から差し替える**（配布ゲートの試験のため）。
    // **様式の確定判定は `formatConfirmed()` 1 か所**なので、ここだけ差し替えれば
    // `isPreventCsvReleased` と `holdReason` の両方に効く。
    [/^  return PREVENT_CSV_FORMAT_STATUS === 'confirmed';$/m,
      "  return (globalThis.__FORMAT ?? PREVENT_CSV_FORMAT_STATUS) === 'confirmed';"],
  ]);
}

function makeSb(rows) {
  return {
    schema: () => ({
      from: () => {
        const filt = {};
        const q = {
          select() { return q; },
          eq(k, v) { filt[k] = v; return q; },
          neq(k, v) { filt['!' + k] = v; return q; },
          order() { return q; },
          async limit(n) {
            const out = rows.filter((r) =>
              Object.entries(filt).every(([k, v]) =>
                k.startsWith('!') ? r[k.slice(1)] !== v : r[k] === v));
            return { data: out.slice(0, n), error: null };
          },
        };
        return q;
      },
    }),
  };
}

/** S3 に問診 JSON を並べる。`diagnostic_id` を**明示**して置く。 */
function setupS3(byUid) {
  globalThis.__S3_LIST = async (prefix) => {
    const uid = /user\/([^/]+)\/date\//.exec(prefix)?.[1] ?? '';
    return (byUid[uid] ?? []).map((iv) => ({
      key: `p/user/${uid}/date/${iv.date.replace(/-/g, '_')}/LifestyleQuestionnaireData_date_${iv.date.replace(/-/g, '_')}_user_${uid}.json`,
      size: 10,
    }));
  };
  globalThis.__S3_GET = async (key) => {
    const uid = /user_([^/]+)\.json$/.exec(key)?.[1] ?? '';
    const d = /date_(\d{4})_(\d{2})_(\d{2})_user_/.exec(key);
    const date = `${d[1]}-${d[2]}-${d[3]}`;
    const iv = (byUid[uid] ?? []).find((x) => x.date === date);
    return JSON.stringify({
      diagnostic_id: iv?.diagnosticId ?? '',
      test_date: date,
      data: { answers: iv?.answers ?? [] },
    });
  };
}

/** 既定: 配布 on ＋ 様式 confirmed（この前提でだけ中身を検査する）。 */
function releaseOn() {
  globalThis.__FLAGS = { 'labid.prevent_csv_release': 'on' };
  globalThis.__FORMAT = 'confirmed';
}
function releaseOff(which) {
  if (which === 'flag') { globalThis.__FLAGS = {}; globalThis.__FORMAT = 'confirmed'; }
  else { globalThis.__FLAGS = { 'labid.prevent_csv_release': 'on' }; globalThis.__FORMAT = 'unconfirmed'; }
}

globalThis.__SUBJECT = { dateOfBirth: '1975-04-15', sex: 'male' };

// ── 相関: 本物の findInterviewLink は常に not_correlated（fail-closed）──
{
  const linkmod = await load('src/lib/prevent-interview-link.ts', [
    [/^import type \{ SupabaseClient \}[\s\S]*?from '@supabase\/supabase-js';$/m, ''],
    [/^import type \{ Database \}[\s\S]*?from '\.\.\/types\/supabase';$/m, ''],
  ]);
  const got = await linkmod.findInterviewLink({ sb: {}, diagnosticUserId: 'u-1', labTestId: 'lt-1' });
  eq('本物の findInterviewLink は相関を返さない（今日の DB に相関キーが無い）',
    got, { ok: false, reason: 'not_correlated' });
  ok('「最新を採る」実装が入っていない',
    !/captured_at|limit\(1\)|sort\(/.test(code('src/lib/prevent-interview-link.ts')),
    '最新を採る疑い');
  // 選別は diagnostic_id の完全一致だけ
  const objs = [
    { key: 'k1', diagnosticId: 'd-2025', testDate: '2025-05-01', answers: [] },
    { key: 'k2', diagnosticId: 'd-2026', testDate: '2026-05-01', answers: [] },
  ];
  eq('相関が指す 1 件だけを選ぶ',
    linkmod.pickInterviewByLink(objs, { labTestId: 'A', diagnosticId: 'd-2025' })?.key, 'k1');
  eq('指していないものは選ばない',
    linkmod.pickInterviewByLink(objs, { labTestId: 'A', diagnosticId: 'd-9999' }), null);
  eq('同じ識別子が 2 件あれば選ばない',
    linkmod.pickInterviewByLink(
      [objs[0], { ...objs[0], key: 'k3' }], { labTestId: 'A', diagnosticId: 'd-2025' }), null);
}

// ── 配布ゲート（①）──
for (const [label, which, hold] of [
  ['flag が off', 'flag', 'release_disabled'],
  ['様式が unconfirmed', 'format', 'format_unconfirmed'],
]) {
  releaseOff(which);
  const rows = [mkRow({ value: '704000111' })];
  globalThis.__SB = makeSb(rows);
  globalThis.__LINK = async () => ({ ok: true, link: { labTestId: 'lt-1', diagnosticId: 'd-1' } });
  setupS3({ 'u-1': [{ date: '2026-10-01', diagnosticId: 'd-1', answers: [] }] });
  const m = await loadModule();
  const list = await m.listPreventQuestionnaires();
  eq(`[配布ゲート] ${label} → released=false`, list.released, false);
  eq(`[配布ゲート] ${label} → 理由は ${hold}`, list.holdReason, hold);
  eq(`[配布ゲート] ${label} → entries は空`, list.entries.length, 0);
  const dl = await m.buildPreventQuestionnaireFile('704000111');
  ok(`[配布ゲート] ${label} → DL も 409 で止まる`,
    dl.ok === false && dl.error === 'csv_release_disabled', JSON.stringify(dl));
  const prev = await m.buildPreventQuestionnaireFile('704000111', { skipReleaseGate: true });
  ok(`[配布ゲート] ${label} → preview だけは通る（当社内部の様式確認）`, prev.ok === true);
}

// ── テスト 1: 今回の検査が揃っている（相関あり）──
releaseOn();
{
  const rows = [mkRow({ value: '704000111' })];
  globalThis.__SB = makeSb(rows);
  globalThis.__LINK = async () => ({ ok: true, link: { labTestId: 'lt-1', diagnosticId: 'd-1' } });
  setupS3({ 'u-1': [{ date: '2026-10-01', diagnosticId: 'd-1', answers: [{ id: 'B-HEIGHT', answer_label: '171.2' }] }] });
  const m = await loadModule();
  const list = await m.listPreventQuestionnaires();
  eq('[1] 一覧に 704000111 が 1 件', list.entries.map((e) => e.barcode_no), ['704000111']);
  eq('[1] 一覧のファイル名', list.entries[0]?.filename, '704000111.csv');
  eq('[1] 一覧の作成日 = 相関した問診の日付', list.entries[0]?.created_on, '2026-10-01');

  const dl = await m.buildPreventQuestionnaireFile('704000111');
  ok('[1] CSV が生成できる', dl.ok, JSON.stringify(dl));
  eq('[1] CSV のファイル名', dl.filename, '704000111.csv');
  const row0 = dl.ok ? dl.csv.replace(/^﻿/, '').trim().split('\r\n')[1].split(',')[0] : null;
  eq('[1] CSV 内 ID', row0, '704000111');
  ok('[1] Portal 表示 / CSV 内 ID / ファイル名 の 3 つが完全一致',
    list.entries[0]?.barcode_no === '704000111' && row0 === '704000111' && dl.filename === '704000111.csv');
  eq('[1] 応答に様式の状態が載る', dl.formatStatus, 'unconfirmed');

  const json = JSON.stringify(list.entries);
  ok('[9] 一覧に内部 ID が出ない（lab_test_id / uid / shipment_ref）',
    !json.includes('lt-1') && !json.includes('u-1') && !json.includes('s-1'), json);
}

// ── テスト 2〜6: ゲート②で落ちる ──
for (const [label, patch, reason] of [
  ['[2] capture なし', null, 'capture_missing'],
  ['[3] review_required', { status: 'review_required' }, 'capture_not_confirmed'],
  ['[4] deferred', { link: 'deferred' }, 'lab_test_not_linked'],
  ['[5] conflict', { link: 'conflict' }, 'lab_test_not_linked'],
  ['[6] lab_test_id null', { labTestId: null }, 'capture_missing'],
]) {
  const rows = patch === null ? [] : [mkRow({ value: '704000111', ...patch })];
  globalThis.__SB = makeSb(rows);
  globalThis.__LINK = async () => ({ ok: true, link: { labTestId: 'lt-1', diagnosticId: 'd-1' } });
  setupS3({ 'u-1': [{ date: '2026-10-01', diagnosticId: 'd-1', answers: [] }] });
  const m = await loadModule();
  const list = await m.listPreventQuestionnaires();
  eq(`${label} → 一覧に出ない`, list.entries.length, 0);
  const dl = await m.buildPreventQuestionnaireFile('704000111');
  ok(`${label} → CSV も出ない`, dl.ok === false, JSON.stringify(dl));
  if (patch !== null) {
    ok(`${label} → 理由が ${reason}`, String(dl.error).includes(reason), String(dl.error));
    eq(`${label} → 台帳の内情を外へ出さない`, /confirmed|deferred|conflict|linked/.test(dl.detail), false);
  }
}

// ── 相関不能 → CSV を出さない（P0-1 の核心）──
{
  const rows = [mkRow({ value: '704000111' })];
  globalThis.__SB = makeSb(rows);
  globalThis.__LINK = async () => ({ ok: false, reason: 'not_correlated' });
  setupS3({ 'u-1': [{ date: '2026-10-01', diagnosticId: 'd-1', answers: [{ id: 'B-HEIGHT', answer_label: '171.2' }] }] });
  const m = await loadModule();
  const list = await m.listPreventQuestionnaires();
  eq('[相関不能] 一覧に出さない', list.entries.length, 0);
  eq('[相関不能] 理由は interview_not_correlated', list.skipped[0]?.reason, 'interview_not_correlated');
  const dl = await m.buildPreventQuestionnaireFile('704000111');
  ok('[相関不能] CSV を出さない（S3 に問診が在っても）',
    dl.ok === false && dl.error === 'interview_not_correlated', JSON.stringify(dl));
  ok('[相関不能] 「最新を採る」へ落ちていない', dl.ok === false);
}

// ── 相関先の問診が S3 に無い ──
{
  const rows = [mkRow({ value: '704000111' })];
  globalThis.__SB = makeSb(rows);
  globalThis.__LINK = async () => ({ ok: true, link: { labTestId: 'lt-1', diagnosticId: 'd-missing' } });
  setupS3({ 'u-1': [{ date: '2026-10-01', diagnosticId: 'd-1', answers: [] }] });
  const m = await loadModule();
  const list = await m.listPreventQuestionnaires();
  eq('[相関先が無い] 一覧に出さない', list.entries.length, 0);
  eq('[相関先が無い] 理由は questionnaire_missing', list.skipped[0]?.reason, 'questionnaire_missing');
  const dl = await m.buildPreventQuestionnaireFile('704000111');
  ok('[相関先が無い] CSV を出さない（別の回で代用しない）',
    dl.ok === false && dl.error === 'questionnaire_missing');
}

// ══════════════════════════════════════════════════════════════════════
// ②' 年跨ぎ — A は 2025 の問診だけ / B は 2026 の問診だけ
// ══════════════════════════════════════════════════════════════════════
console.log('\n②′ 年跨ぎ（2 回ぶん・相関あり）\n');
{
  const rows = [
    mkRow({ value: '704000111', labTestId: 'lt-A', shipmentRef: 's-2025', capturedAt: '2025-10-01T00:00:00Z' }),
    mkRow({ value: '704000222', labTestId: 'lt-B', shipmentRef: 's-2026', capturedAt: '2026-10-01T00:00:00Z' }),
  ];
  globalThis.__SB = makeSb(rows);
  // **相関は検査ごとに別の問診を指す。**
  globalThis.__LINK = async (a) => (
    a.labTestId === 'lt-A' ? { ok: true, link: { labTestId: 'lt-A', diagnosticId: 'd-2025' } }
    : a.labTestId === 'lt-B' ? { ok: true, link: { labTestId: 'lt-B', diagnosticId: 'd-2026' } }
    : { ok: false, reason: 'not_correlated' });
  setupS3({
    'u-1': [
      { date: '2025-05-01', diagnosticId: 'd-2025', answers: [{ id: 'B-WEIGHT', answer_label: '2025WEIGHT' }] },
      { date: '2026-05-01', diagnosticId: 'd-2026', answers: [{ id: 'B-WEIGHT', answer_label: '2026WEIGHT' }] },
    ],
  });
  const m = await loadModule();
  const a = await m.buildPreventQuestionnaireFile('704000111');
  const b = await m.buildPreventQuestionnaireFile('704000222');
  ok('[7/8] A(2025) の CSV は 2025 の問診だけ',
    a.ok && a.csv.includes('2025WEIGHT') && !a.csv.includes('2026WEIGHT'), JSON.stringify(a.ok));
  ok('[7/8] B(2026) の CSV は 2026 の問診だけ',
    b.ok && b.csv.includes('2026WEIGHT') && !b.csv.includes('2025WEIGHT'), JSON.stringify(b.ok));
  eq('[7/8] A の ID は 704000111', a.ok ? a.csv.replace(/^﻿/, '').trim().split('\r\n')[1].split(',')[0] : null, '704000111');
  eq('[7/8] B の ID は 704000222', b.ok ? b.csv.replace(/^﻿/, '').trim().split('\r\n')[1].split(',')[0] : null, '704000222');
  eq('[7/8] A のファイル名', a.filename, '704000111.csv');
  eq('[7/8] B のファイル名', b.filename, '704000222.csv');
  const list = await m.listPreventQuestionnaires();
  eq('[7/8] 一覧は 2 件とも出る', list.entries.map((e) => e.barcode_no).sort(), ['704000111', '704000222']);
  eq('[7/8] 一覧の作成日はそれぞれの問診の日付',
    list.entries.slice().sort((x, y) => x.barcode_no.localeCompare(y.barcode_no)).map((e) => e.created_on),
    ['2025-05-01', '2026-05-01']);

  // **前年だけ確定・今年は未撮影** → 今年の回として前年が出ない
  const only2025 = [rows[0]];
  globalThis.__SB = makeSb(only2025);
  const m2 = await loadModule();
  const forB = await m2.buildPreventQuestionnaireFile('704000222');
  ok('[7] 今年が未撮影なら今年の番号では何も出ない', forB.ok === false && forB.error === 'not_found');
  const l2 = await m2.listPreventQuestionnaires();
  eq('[7] 一覧にも 2025 の 1 件だけ', l2.entries.map((e) => e.barcode_no), ['704000111']);
  ok('[7] その 1 件は 2025 の問診を持つ',
    (await m2.buildPreventQuestionnaireFile('704000111')).csv.includes('2025WEIGHT'));
}

{
  // ── 台帳行が 2 件見えたら選ばない ───────────────────────────────
  const rows = [
    mkRow({ value: '704000111', uid: 'u-1', labTestId: 'lt-a' }),
    mkRow({ value: '704000111', uid: 'u-2', labTestId: 'lt-b' }),
  ];
  globalThis.__SB = makeSb(rows);
  globalThis.__LINK = async () => ({ ok: true, link: { labTestId: 'lt-a', diagnosticId: 'd-1' } });
  setupS3({ 'u-1': [{ date: '2026-10-01', diagnosticId: 'd-1', answers: [] }] });
  const m = await loadModule();
  const dl = await m.buildPreventQuestionnaireFile('704000111');
  ok('同じ番号が 2 件見えたら選ばず 404', dl.ok === false && dl.error === 'not_found');
}

{
  // ── 入力は正規化してから使う ────────────────────────────────────
  const rows = [mkRow({ value: '704000111' })];
  globalThis.__SB = makeSb(rows);
  globalThis.__LINK = async () => ({ ok: true, link: { labTestId: 'lt-1', diagnosticId: 'd-1' } });
  setupS3({ 'u-1': [{ date: '2026-10-01', diagnosticId: 'd-1', answers: [] }] });
  const m = await loadModule();
  const dl = await m.buildPreventQuestionnaireFile('A704000111A');
  ok('バーコードの start/stop 付きでも引ける（正規化してから照合）', dl.ok, JSON.stringify(dl));
  const bad = await m.buildPreventQuestionnaireFile('70400O111');
  ok('数字にならない入力は 400', bad.ok === false && bad.error === 'invalid_barcode_no');
}

// ══════════════════════════════════════════════════════════════════════
// ③ ゲートが 1 つであること（二重実装・迂回の検出）
// ══════════════════════════════════════════════════════════════════════
console.log('\n③ ゲートは 1 つ（二重実装・迂回の検出）\n');
{
  const io = code('src/lib/prevent-questionnaire.ts');
  const api = code('src/pages/api/partner/prevent-questionnaire.ts');
  ok('[15] 一覧も DL も checkPreventQuestionnaireGate を通る',
    (io.match(/checkPreventQuestionnaireGate\(/g) || []).length >= 2);
  ok('[15] loadCapturedExternalId を使う', /loadCapturedExternalId\(/.test(io));
  ok('[15] API 側に status を見るコードが無い',
    !/['"]confirmed['"]/.test(api) && !/lab_test_link_status/.test(api), 'API がゲートを持っている');
  ok('[15] 一覧の SQL が status を絞っていない（ゲートを 2 か所に持たない）',
    !/\.eq\('status', *'confirmed'\)/.test(io));
  ok('独自のゲート判定（confirmed の直比較）を書いていない',
    !/status *[=!]== *['"]confirmed['"]/.test(io), '独自判定の疑い');

  // ── Scan-Chat-AI 側 API の認可（**ここは分割で落としてはいけない**）──
  ok('API は Bearer ADMIN_API_KEY（isAdminAuthorized）', /isAdminAuthorized\(request\)/.test(api));
  ok('API は未認可を 401 で止める', /error: 'unauthorized' \}, 401\)/.test(api));
  ok('API は prevent 以外を 403', /partner *!== *'prevent'/.test(api));
  ok('API の mode は allow-list', /ALLOWED_MODES/.test(api));
  ok('API は intake キーを受けない（isLabIntakeEndpointAuthorized を使わない）',
    !/isLabIntakeEndpointAuthorized|isIntakeAuthorized/.test(api));
  ok('API はキャッシュさせない', /no-store/.test(api));

  // 中継と画面（wellfort-site）は**あちらのリポジトリの検査**が見る。
  // ここで `../wellfort-site` を読むと、Scan-Chat-AI だけを checkout した CI で落ちる。
  // → wellfort-site `npm run verify:prevent-portal`（中継のゲート二重実装・画面の見出し・
  //   ブラウザで CSV を組み立てていないこと・LAiF 側が無変更であること）。
}

// ══════════════════════════════════════════════════════════════════════
// ⑤ 仕様書が実装と一致していること
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑤ 仕様書\n');
{
  const master = read('docs/lab/lab_data_pipeline_master_spec.md');
  const capture = read('docs/lab/kit_receipt_external_id_capture_spec.md');
  const qcsv = read('docs/lab/questionnaire_to_lab_csv_spec.md');

  ok('master §4-5.3 が external_barcode を外部キーと明記', /\*\*`customer\.lab_tests\.external_barcode`\*\*/.test(master));
  ok('master §4-5.3 が「当社の整理番号を使わない」と明記',
    /Wellfort 独自の「整理番号」をプリベントとの往復キーにしない/.test(master));
  ok('master §4-5.3 に完成条件（3 値一致）がある',
    /Portal 一覧の表示 \| `704000123`/.test(master) && /CSV のファイル名 \| `704000123\.csv`/.test(master));
  ok('master が内部 ID を Portal へ出さないと明記',
    /プリベント担当者へ表示しない/.test(master));
  ok('capture spec §2.3 の見出しが「未確認」のままでない',
    !/### 2\.3 `704000xxx` と 15桁番号は\*\*まだ確定仕様ではない\*\*/.test(capture));
  ok('capture spec が総桁数・prefix を確定として書いている',
    /プリベントの \*\*総桁数 \/ prefix\*\* \| \*\*確定（2026-10-13/.test(capture));
  ok('capture spec が規格名を断定していない', /\*\*Codabar だと断定していない\*\*/.test(capture));
  ok('capture spec D-2 が「未確認（先方資料 or 実物 1 枚が要る）」のままでない',
    !/\*\*未確認\*\*（先方資料 or 実物 1 枚が要る）/.test(capture));
  ok('capture spec に「実物の同梱書面を 1 枚も見ていない」が残っていない',
    !/^- \*\*実物の同梱書面を 1 枚も見ていない\*\*/m.test(capture));
  ok('capture spec §7.1.1 が CSV 実装を記載', /#### 7\.1\.1 CSV 生成側は実装した/.test(capture));
  ok('questionnaire spec 行3 の値が external_barcode と明記',
    /行3「会員ID\/ユーザーID」に入れるのは、受取時に確定した/.test(qcsv));
  ok('questionnaire spec が diagnostic_user_id を禁止と明記',
    /\*\*`diagnostic_user_id`\*\*（当社内部の人単位キー）/.test(qcsv));
  ok('questionnaire spec が ★ の空欄を明記', /該当列を出して値は空|列は出して空にし/.test(qcsv));
  // ── P0 の 2 件が仕様書に残っていること ──
  ok('capture spec §7.1.2（問診を最新で採らない）がある',
    /#### 7\.1\.2 【P0・2026-10-13】問診を「その人の最新」で採ってはいけない/.test(capture));
  ok('capture spec が相関キーの不在を file 付きで示している',
    /20260915000010_interview_completions\.sql/.test(capture)
    && /bridge-queries\.ts:59,78,79/.test(capture));
  // **裁定後は「未決」ではない。** `test_instance_ref` ＋ link table ＋ 日時推定禁止が正本。
  ok('capture spec が相関の供給元の裁定（2026-10-13）を書いている',
    /相関の供給元【裁定済み・2026-10-13・発注者】/.test(capture));
  ok('capture spec が test_instance_ref を正本キーと明記',
    /`test_instance_ref` を cross-system の正本キーとして採用する/.test(capture));
  ok('capture spec が link table 型（1 問診 → 複数検査）を明記',
    /diagnosis\.interview_test_links/.test(capture)
    && /同じ AI問診を複数の検査が利用する/.test(capture));
  ok('capture spec が日時推定の禁止を明記',
    /\*\*日時推定は禁止。\*\*/.test(capture));
  ok('capture spec が実装を別タスク（③-1）だと明記',
    /\*\*実装は別タスク（③-1）。\*\*/.test(capture));
  ok('questionnaire spec §8.1.1（様式は先方確定でない）がある',
    /#### 8\.1\.1 【P0・2026-10-13】この様式は先方確定ではない。本番配布しない/.test(qcsv));
  ok('questionnaire spec が先方 Excel の名前と「リポジトリ未取り込み」を明記',
    /ウェルフォート様_問診・アンケートデータ_例_問診1回\.xlsx/.test(qcsv)
    && /両リポジトリで/.test(qcsv));
  // **「Excel が存在しない」と書かない。** メール添付として実在し、再受領は不要。
  ok('questionnaire spec が「Excel は実在・再受領は不要」と書いている',
    /Excel は実在する。再受領は不要/.test(qcsv));
  ok('questionnaire spec が先方メールの確定事項（09-01 / 09-07）を表にしている',
    /2026-09-01（先方）/.test(qcsv) && /2026-09-07（先方回答）/.test(qcsv));
  ok('questionnaire spec が unconfirmed を維持する理由 5 点を書いている',
    /3 段ヘッダをどう表現するか/.test(qcsv) && /選択肢の値/.test(qcsv));
  ok('questionnaire spec が次タスク 2 本と「2 本とも完成まで off」を書いている',
    /次タスク（2 本に分ける・発注者裁定 2026-10-13）/.test(qcsv)
    && /2 本とも完成するまで `labid\.prevent_csv_release` は off のまま/.test(qcsv));
  ok('questionnaire spec が ALA/採尿日時を工程データとして扱うと書いている',
    /「CSV の空欄問題」として扱わない/.test(qcsv));
  ok('questionnaire spec §8.1.2（★ の供給元）がある',
    /#### 8\.1\.2 ★ 項目の供給元/.test(qcsv)
    && /2026-09-03 業務合意/.test(qcsv));
  ok('master spec が配布を閉じていることを書いている',
    /配布は閉じている|labid\.prevent_csv_release/.test(master));
}

// ══════════════════════════════════════════════════════════════════════
// ⑥ feature flag を触っていない
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑥ feature flag\n');
{
  const cfg = read('src/lib/app-config.ts');
  const pick = (key) => {
    const i = cfg.indexOf(`key: '${key}'`);
    return i < 0 ? null : /default: '([^']*)'/.exec(cfg.slice(i, i + 600))?.[1] ?? null;
  };
  eq('labid.prevent_capture の既定は off', pick('labid.prevent_capture'), 'off');
  eq('labid.demecal_capture の既定は off', pick('labid.demecal_capture'), 'off');
  eq('labid.prevent_pattern の既定は実物と一致', pick('labid.prevent_pattern'), '^704000[0-9]{3}$');
  eq('labid.prevent_csv_release の既定は off', pick('labid.prevent_csv_release'), 'off');
  // **撮影の flag と配布の flag は独立**。CSV 生成は配布の flag だけを見る。
  const io2 = code('src/lib/prevent-questionnaire.ts');
  ok('CSV 生成は labid.prevent_csv_release を見る', /labid\.prevent_csv_release/.test(io2));
  ok('CSV 生成は labid.prevent_capture を見ない（撮影 off を配布 off の代わりにしない）',
    !/labid\.prevent_capture/.test(io2));
  ok('様式の確定判定は 1 か所（formatConfirmed）',
    (io2.match(/PREVENT_CSV_FORMAT_STATUS === 'confirmed'/g) || []).length === 1);
}

// ══════════════════════════════════════════════════════════════════════
// ⑦ 触っていないこと（§16 の変更禁止）
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑦ 触っていないこと\n');
{
  ok('laif-upload API は残っている', existsSync(resolve(ROOT, 'src/pages/api/partner/laif-upload.ts')));
  ok('laif-portal.ts に DL 済み管理を足していない（§11 は未決）',
    !/downloaded|one_time|consumed/.test(code('src/lib/laif-portal.ts')));
  ok('結果PDF の bind を推測実装していない',
    !/external_barcode/.test(code('src/lib/laif-portal.ts')));
  const io = code('src/lib/prevent-questionnaire.ts');
  ok('migration を増やしていない（この実装は既存テーブルだけを読む）',
    /from\(TABLE\)/.test(io) && !/create table/i.test(io));
  ok('新しいプリベント ID を採番していない',
    !/randomUUID|採番/.test(io) && !/randomUUID/.test(code('src/lib/prevent-questionnaire-csv.ts')));
}

console.log(`\n${fails.length ? '✗ FAIL' : '✓ PASS'}  ${pass} 件合格` + (fails.length ? ` / ${fails.length} 件失敗` : ''));
if (fails.length) {
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
