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
// ① 純関数 — 3 値が 1 つの確定値から派生していること
// ══════════════════════════════════════════════════════════════════════
console.log('\n① CSV の組み立て (prevent-questionnaire-csv.ts)\n');
const csvmod = await load('src/lib/prevent-questionnaire-csv.ts');
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

  // ★ は空（捏造しない）
  const idx = (h) => header.indexOf(h);
  for (const h of ['ALAカプセル摂取日時', '採尿日時', '排尿回数', '採尿前日の薬', '採尿前日の飲酒', '採尿検体の冷凍保存']) {
    ok(`★ ${h} は空のまま（AI問診に設問が無い）`, idx(h) >= 0 && row[idx(h)] === '',
      `idx=${idx(h)} value=${JSON.stringify(row[idx(h)])}`);
  }

  // **3 値が同じ 1 つの引数から出ていること**
  ok('Portal 表示値 / CSV の行3 / ファイル名 が完全一致',
    row[0] === BARCODE && built.filename === `${BARCODE}.csv` && csvmod.preventCsvFilename(BARCODE) === built.filename);

  // 値を変えたら 3 つとも追随する（別経路で作っていないことの裏取り）
  const other = csvmod.buildPreventQuestionnaireCsv({
    barcodeNo: '704000222', subject: { dateOfBirth: null, sex: null }, answers: [],
  });
  const orow = other.csv.replace(/^﻿/, '').trim().split('\r\n')[1].split(',');
  ok('バーコードNo. を変えると 3 つとも変わる',
    orow[0] === '704000222' && other.filename === '704000222.csv');
  eq('属性が取れない回は空欄（捏造しない）', [orow[1], orow[2]], ['', '']);

  // 当社採番 ID が混ざっていないこと
  const src = read('src/lib/prevent-questionnaire-csv.ts');
  ok('`WF-CANCER` が CSV 生成に無い', !/WF-CANCER/.test(src));
  ok('`整理番号` を値に使っていない', !/整理番号['"`]|整理番号 *[:=]/.test(stripComments(src)));
  // **型定義にも同じリテラルが出る**ので、素のソースを数えない。実体の配列を数える。
  eq('`barcode_no` の供給元はちょうど 1 列',
    csvmod.PREVENT_CSV_COLUMNS.filter((c) => c.source.kind === 'barcode_no').length, 1);
  eq('subject 由来は 生年月日・性別 の 2 列だけ',
    csvmod.PREVENT_CSV_COLUMNS.filter((c) => c.source.kind === 'subject').map((c) => c.source.field),
    ['date_of_birth', 'sex']);
  ok('`unavailable` の列は値を持たない定義になっている',
    csvmod.PREVENT_CSV_COLUMNS.filter((c) => c.source.kind === 'unavailable').length === 6);
  ok('列定義は 1 か所（PREVENT_CSV_COLUMNS）',
    (code('src/lib/prevent-questionnaire-csv.ts').match(/PREVENT_CSV_COLUMNS: readonly/g) || []).length === 1);
  eq('列数と項目数が一致', csvmod.PREVENT_CSV_COLUMN_COUNT, csvmod.PREVENT_CSV_COLUMNS.length);
  eq('ヘッダ行の列数 = 定義の列数', header.length, csvmod.PREVENT_CSV_COLUMN_COUNT);
  ok('BOM つき（Excel の文字化けよけ）', built.csv.startsWith('﻿'));
}

// ══════════════════════════════════════════════════════════════════════
// ② 一覧と DL — ゲートを実際に通す（Supabase / S3 はスタブ）
// ══════════════════════════════════════════════════════════════════════
console.log('\n② 一覧と DL (prevent-questionnaire.ts)\n');

/** 台帳 1 行ぶんの素材。 */
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

/**
 * `prevent-questionnaire.ts` を**実物のまま**動かす。
 * 差し替えるのは I/O の import だけ（ゲートと `loadCapturedExternalId` は本物）。
 */
async function loadModule({ rows, interviews, subject }) {
  const persist = await load('src/lib/external-id-persist.ts', [
    [/^import type \{ SupabaseClient \}[\s\S]*?from '@supabase\/supabase-js';$/m, ''],
    [/^import type \{ Database \}[\s\S]*?from '\.\.\/types\/supabase';$/m, ''],
    [/^import \{\n[\s\S]*?\} from '\.\/external-test-id';$/m,
      `const PROVIDER_ID_COLUMN={prevent:'external_barcode',demecal:'external_test_id'};
       const PROVIDER_ID_KIND={prevent:'barcode_no',demecal:'inquiry_no'};
       const PROVIDER_TEST_TYPE={prevent:'cancer_urine',demecal:'blood'};
       const maskExternalId=(v,k=4)=>{const s=(v??'').trim();return !s?'':(s.length<=k?'*'.repeat(s.length):'*'.repeat(s.length-k)+s.slice(-k));};`],
  ]);
  const coreSrc = read('src/lib/external-test-id.ts');
  const coreB64 = Buffer.from(toJs(coreSrc), 'utf8').toString('base64');

  const mod = await load('src/lib/prevent-questionnaire.ts', [
    [/^import type \{ SupabaseClient \}[\s\S]*?from '@supabase\/supabase-js';$/m, ''],
    [/^import type \{ Database \}[\s\S]*?from '\.\.\/types\/supabase';$/m, ''],
    [/^import \{ getServerSupabase \} from '\.\/supabase';$/m, `const getServerSupabase = () => __SB;`],
    [/^import \{ getS3Config, getObjectText, listObjects \} from '\.\/s3';$/m,
      `const getS3Config = () => ({ prefix: 'p/', bucket: 'b', region: 'r' });
       const listObjects = async (prefix) => (globalThis.__S3_LIST(prefix));
       const getObjectText = async (key) => (globalThis.__S3_GET(key));`],
    [/^import \{ resolveTargetSubject \} from '\.\/target-subject';$/m,
      `const resolveTargetSubject = async () => globalThis.__SUBJECT;`],
    [/^import \{ loadCapturedExternalId \} from '\.\/external-id-persist';$/m, ''],
    [/^import \{\n[\s\S]*?\} from '\.\/external-test-id';$/m, ''],
    [/^import \{\n[\s\S]*?\} from '\.\/prevent-questionnaire-csv';$/m, ''],
    // 本物を import し直す（ゲートと CSV 組み立ては差し替えない）
    [/^const PROVIDER = 'prevent' as const;$/m,
      `import { loadCapturedExternalId } from 'data:text/javascript;base64,${Buffer.from(toJs(
        (() => {
          let s = read('src/lib/external-id-persist.ts');
          s = s.replace(/^import type \{ SupabaseClient \}[\s\S]*?from '@supabase\/supabase-js';$/m, '');
          s = s.replace(/^import type \{ Database \}[\s\S]*?from '\.\.\/types\/supabase';$/m, '');
          s = s.replace(/^import \{\n[\s\S]*?\} from '\.\/external-test-id';$/m,
            `const PROVIDER_ID_COLUMN={prevent:'external_barcode',demecal:'external_test_id'};
             const PROVIDER_ID_KIND={prevent:'barcode_no',demecal:'inquiry_no'};
             const PROVIDER_TEST_TYPE={prevent:'cancer_urine',demecal:'blood'};
             const maskExternalId=(v,k=4)=>{const s=(v??'').trim();return !s?'':(s.length<=k?'*'.repeat(s.length):'*'.repeat(s.length-k)+s.slice(-k));};`);
          return s;
        })(), 'utf8'), 'utf8').toString('base64')}';
       import { checkPreventQuestionnaireGate, maskExternalId, normalizeExternalId } from 'data:text/javascript;base64,${coreB64}';
       import { buildPreventQuestionnaireCsv, preventCsvFilename, PREVENT_CSV_COLUMN_COUNT } from 'data:text/javascript;base64,${Buffer.from(toJs(read('src/lib/prevent-questionnaire-csv.ts')), 'utf8').toString('base64')}';
       const PROVIDER = 'prevent';`],
  ]);
  void persist;

  globalThis.__SUBJECT = subject ?? { dateOfBirth: '1975-04-15', sex: 'male' };
  globalThis.__S3_LIST = async (prefix) => {
    const uid = /user\/([^/]+)\/date\//.exec(prefix)?.[1] ?? '';
    const dates = interviews?.[uid] ?? [];
    return dates.map((d) => ({
      key: `p/user/${uid}/date/${d.replace(/-/g, '_')}/LifestyleQuestionnaireData_date_${d.replace(/-/g, '_')}_user_${uid}.json`,
      size: 10,
    }));
  };
  globalThis.__S3_GET = async (key) => {
    const d = /date_(\d{4})_(\d{2})_(\d{2})_user_/.exec(key);
    return JSON.stringify({
      test_date: `${d[1]}-${d[2]}-${d[3]}`,
      data: { answers: [{ id: 'B-HEIGHT', answer_label: '171.2' }, { id: 'B-WEIGHT', answer_label: '68.4' }] },
    });
  };
  return mod;
}

/** Supabase の最小スタブ（`.schema().from().select().eq().neq().order().limit()`）。 */
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
            let out = rows.filter((r) =>
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

{
  // ── テスト 1: 今回の検査が揃っている ───────────────────────────────
  const rows = [mkRow({ value: '704000111' })];
  globalThis.__SB = makeSb(rows);
  const m = await loadModule({ rows, interviews: { 'u-1': ['2026-10-01'] } });
  const list = await m.listPreventQuestionnaires();
  eq('[1] 一覧に 704000111 が 1 件', list.entries.map((e) => e.barcode_no), ['704000111']);
  eq('[1] 一覧のファイル名', list.entries[0]?.filename, '704000111.csv');
  eq('[1] 一覧の作成日 = 問診データの日付', list.entries[0]?.created_on, '2026-10-01');

  const dl = await m.buildPreventQuestionnaireFile('704000111');
  ok('[1] CSV が生成できる', dl.ok, JSON.stringify(dl));
  eq('[1] CSV のファイル名', dl.filename, '704000111.csv');
  const row0 = dl.ok ? dl.csv.replace(/^﻿/, '').trim().split('\r\n')[1].split(',')[0] : null;
  eq('[1] CSV 内 ID', row0, '704000111');
  ok('[1] Portal 表示 / CSV 内 ID / ファイル名 の 3 つが完全一致',
    list.entries[0]?.barcode_no === '704000111' && row0 === '704000111' && dl.filename === '704000111.csv');

  // 内部 ID が一覧へ出ていないこと
  const json = JSON.stringify(list.entries);
  ok('[9] 一覧に内部 ID が出ない（lab_test_id / uid / shipment_ref）',
    !json.includes('lt-1') && !json.includes('u-1') && !json.includes('s-1'), json);
}

for (const [label, patch, reason] of [
  ['[2] capture なし', null, 'capture_missing'],
  ['[3] review_required', { status: 'review_required' }, 'capture_not_confirmed'],
  ['[4] deferred', { link: 'deferred' }, 'lab_test_not_linked'],
  ['[5] conflict', { link: 'conflict' }, 'lab_test_not_linked'],
  ['[6] lab_test_id null', { labTestId: null }, 'capture_missing'],
]) {
  const rows = patch === null ? [] : [mkRow({ value: '704000111', ...patch })];
  globalThis.__SB = makeSb(rows);
  const m = await loadModule({ rows, interviews: { 'u-1': ['2026-10-01'] } });
  const list = await m.listPreventQuestionnaires();
  eq(`${label} → 一覧に出ない`, list.entries.length, 0);
  const dl = await m.buildPreventQuestionnaireFile('704000111');
  ok(`${label} → CSV も出ない`, dl.ok === false, JSON.stringify(dl));
  if (patch !== null) {
    ok(`${label} → 理由が ${reason}`, String(dl.error).includes(reason), String(dl.error));
    eq(`${label} → 台帳の内情を外へ出さない`, /confirmed|deferred|conflict|linked/.test(dl.detail), false);
  }
}

{
  // ── テスト 7: 前年だけ確定・今年は未撮影 ──────────────────────────
  // 台帳には 2025 の行しか無い。**2026 の回として 704000111 を出してはいけない。**
  const rows = [mkRow({ value: '704000111', labTestId: 'lt-2025', shipmentRef: 's-2025' })];
  globalThis.__SB = makeSb(rows);
  const m = await loadModule({ rows, interviews: { 'u-1': ['2026-10-01'] } });
  // 「2026 の回」= 今年の lab_test_id / shipment_ref で引いたとき
  const persist = await load('src/lib/external-id-persist.ts', [
    [/^import type \{ SupabaseClient \}[\s\S]*?from '@supabase\/supabase-js';$/m, ''],
    [/^import type \{ Database \}[\s\S]*?from '\.\.\/types\/supabase';$/m, ''],
    [/^import \{\n[\s\S]*?\} from '\.\/external-test-id';$/m,
      `const PROVIDER_ID_COLUMN={};const PROVIDER_ID_KIND={};const PROVIDER_TEST_TYPE={};const maskExternalId=()=>'';`],
  ]);
  const got2026 = await persist.loadCapturedExternalId({
    sb: makeSb(rows), diagnosticUserId: 'u-1', provider: 'prevent', labTestId: 'lt-2026',
  });
  eq('[7] 今年の lab_test_id で引くと前年の行は返らない', got2026, null);
  const core = await load('src/lib/external-test-id.ts');
  eq('[7] ゲートもブロックする', core.checkPreventQuestionnaireGate({ capture: got2026 }).allowed, false);
  // 「その人の最新」を引く経路がコードに無いこと
  const io = code('src/lib/prevent-questionnaire.ts');
  ok('[7] 一覧・DL のどちらにも「人だけで最新 1 件」の問い合わせが無い',
    !/order\([^)]*captured_at[^)]*\)[\s\S]{0,80}limit\(1\)/.test(io), 'latest-per-person クエリの疑い');
  ok('[7] DL は labTestId 経由で loadCapturedExternalId を呼ぶ',
    /loadCapturedExternalId\(\{ sb, diagnosticUserId: uid, provider: PROVIDER, labTestId \}\)/.test(io));
  void m;
}

{
  // ── テスト 8: 年跨ぎ（2025 と 2026 の両方が確定している）──────────
  const rows = [
    mkRow({ value: '704000111', labTestId: 'lt-2025', shipmentRef: 's-2025', capturedAt: '2025-10-01T00:00:00Z' }),
    mkRow({ value: '704000222', labTestId: 'lt-2026', shipmentRef: 's-2026', capturedAt: '2026-10-01T00:00:00Z' }),
  ];
  globalThis.__SB = makeSb(rows);
  const m = await loadModule({ rows, interviews: { 'u-1': ['2026-10-01'] } });
  const a = await m.buildPreventQuestionnaireFile('704000222');
  const b = await m.buildPreventQuestionnaireFile('704000111');
  ok('[8] 2026 のバーコードNo. は 2026 の CSV になる',
    a.ok && a.filename === '704000222.csv'
    && a.csv.replace(/^﻿/, '').trim().split('\r\n')[1].split(',')[0] === '704000222');
  ok('[8] 2025 のバーコードNo. は 2025 の行として扱われる（混ざらない）',
    b.ok && b.filename === '704000111.csv'
    && b.csv.replace(/^﻿/, '').trim().split('\r\n')[1].split(',')[0] === '704000111');
  ok('[8] 片方の CSV にもう片方の番号が混ざらない',
    a.ok && !a.csv.includes('704000111') && b.ok && !b.csv.includes('704000222'));
}

{
  // ── 問診が無い回は出さない ──────────────────────────────────────
  const rows = [mkRow({ value: '704000111' })];
  globalThis.__SB = makeSb(rows);
  const m = await loadModule({ rows, interviews: {} });
  const list = await m.listPreventQuestionnaires();
  eq('問診が無い回は一覧に出さない', list.entries.length, 0);
  eq('理由は questionnaire_missing', list.skipped[0]?.reason, 'questionnaire_missing');
  const dl = await m.buildPreventQuestionnaireFile('704000111');
  ok('問診が無い回は CSV も出ない', dl.ok === false && dl.error === 'questionnaire_missing');
}

{
  // ── 台帳行が 2 件見えたら選ばない ───────────────────────────────
  const rows = [
    mkRow({ value: '704000111', uid: 'u-1', labTestId: 'lt-a' }),
    mkRow({ value: '704000111', uid: 'u-2', labTestId: 'lt-b' }),
  ];
  globalThis.__SB = makeSb(rows);
  const m = await loadModule({ rows, interviews: { 'u-1': ['2026-10-01'], 'u-2': ['2026-10-01'] } });
  const dl = await m.buildPreventQuestionnaireFile('704000111');
  ok('同じ番号が 2 件見えたら選ばず 404', dl.ok === false && dl.error === 'not_found');
}

{
  // ── 入力は正規化してから使う ────────────────────────────────────
  const rows = [mkRow({ value: '704000111' })];
  globalThis.__SB = makeSb(rows);
  const m = await loadModule({ rows, interviews: { 'u-1': ['2026-10-01'] } });
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
  ok('questionnaire spec が ★ の空欄を明記', /該当列を出して値は空/.test(qcsv));
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
  ok('CSV 生成が flag を見ていない（撮影が無ければ台帳に行が無いので fail-closed）',
    !/labid\.prevent_capture/.test(code('src/lib/prevent-questionnaire.ts')));
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
