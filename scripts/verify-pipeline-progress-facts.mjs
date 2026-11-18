/**
 * `npm run verify:pipeline-progress-facts`
 *
 * 検査パイプライン進捗管理の**事実 API** (`POST /api/admin/pipeline-progress`) を
 * 実際に動かして固定する。実物の TS を esbuild でバンドルし、**DB と認可だけ**を
 * スタブ (`scripts/lib/sat-harness.mjs` のもの) に差し替える。鍵もサーバも要らない = CI の A 層。
 *
 * 見ていること:
 *   ① 認可 / 入力検証 (401・400・上限 200・UUID 以外は弾く)
 *   ② 応答に PII・検査値・外部IDの値・報告書本文・未加工の長いエラーが載らない
 *   ③ **引けなかった表は null (= 不明)**。空配列や 0 件にしない
 *   ④ Elith の揃い判定は既存 `decideReady` と一致・派生 blood は数えない・
 *      対応表の無い plan は required_formats=null
 *   ⑤ 本番 prefix 以外の納品を「済」と読まない
 *   ⑥ 報告書は superseded を除いた最新 1 件・公開判定はゲートに委ねる
 *   ⑦ 書き込みを 1 回もしない (read-only)
 *   ⑧ N+1 にしない (uid 数に依らず問い合わせ本数が一定)
 *   ⑨ デモ / スペシャルの判定が本物の関数で付く
 *   ⑩ 応答ヘッダ `private, no-store`
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { ROOT, CACHE, stubUrl, ok, eq, fails, code } from './lib/sat-harness.mjs';

const UID_A = 'aaaaaaaa-1111-4111-8111-111111111111'; // デモ
const UID_B = 'bbbbbbbb-2222-4222-8222-222222222222'; // スペシャル
const UID_C = 'cccccccc-3333-4333-8333-333333333333'; // 一般 (契約者)
const UID_D = 'dddddddd-4444-4444-8444-444444444444'; // データ無し

const OUT = `${CACHE}/ppf`;
await build({
  entryPoints: ['src/pages/api/admin/pipeline-progress.ts', 'src/lib/pipeline-progress-facts.ts'],
  bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
  define: { 'import.meta.env': JSON.stringify({ DEV: false, DEMO_ALLOWED_UIDS: UID_A, SPECIAL_ALLOWED_UIDS: UID_B }) },
  outdir: OUT, outbase: 'src', outExtension: { '.js': '.mjs' },
  plugins: [{
    name: 'stub',
    setup(b) {
      b.onResolve({ filter: /(^|\/)supabase$/ }, () => ({ path: stubUrl('sat-supabase-stub.mjs'), external: true }));
      b.onResolve({ filter: /(^|\/)api-auth$/ }, () => ({ path: stubUrl('sat-api-auth-stub.mjs'), external: true }));
      b.onResolve({ filter: /(^|\/)s3$/ }, () => ({ path: stubUrl('sat-s3-stub.mjs'), external: true }));
    },
  }],
});
const built = (rel) => `${pathToFileURL(resolve(ROOT, OUT, rel)).href}?t=${Date.now()}`;
const api = await import(built('pages/api/admin/pipeline-progress.mjs'));
const db = await import(stubUrl('sat-supabase-stub.mjs'));
const auth = await import(stubUrl('sat-api-auth-stub.mjs'));

const PLAN_C = 'plan-c-uuid';
function seed() {
  db.reset();
  auth.AUTH.ok = true;
  db.TABLES.app_config = [{ key: 'elith.plan_formats', value: `${PLAN_C}=HealthCheckupData|BloodTestData|LifestyleQuestionnaireData|HealthAgeData` }];
  db.TABLES.interview_completions = [
    { diagnostic_user_id: UID_C, completed_at: '2026-10-01T00:00:00Z', answered_count: 40 },
    { diagnostic_user_id: UID_C, completed_at: '2026-11-01T00:00:00Z', answered_count: 40 },
  ];
  db.TABLES.test_artifacts = [
    { id: 'art-hc', diagnostic_user_id: UID_C, test_type: 'health_checkup', test_date: '2026-09-01', imported_at: '2026-09-02T00:00:00Z', imported_by: 'user', source: 'user_upload', status: 'active', scan_md: '| 氏名 | 山田太郎 |', measurements: [{ name: 'AST', value: '22' }] },
    // 派生 blood は Elith の揃い判定に数えない (BloodTestData は missing のまま)
    { id: 'art-dv', diagnostic_user_id: UID_C, test_type: 'blood', test_date: '2026-09-01', imported_at: '2026-09-02T00:00:00Z', imported_by: 'derived_healthcheck_blood', source: 'user_upload', status: 'active' },
    { id: 'art-old', diagnostic_user_id: UID_C, test_type: 'genetics', test_date: '2025-01-01', imported_at: null, imported_by: null, source: 'admin_batch', status: 'superseded' },
  ];
  db.TABLES.lab_test_id_captures = [
    { diagnostic_user_id: UID_C, shipment_ref: 'sched-1', provider: 'prevent', test_type: 'cancer_urine', status: 'confirmed', lab_test_id: 'lab-1', lab_test_link_status: 'linked', captured_at: '2026-10-05T00:00:00Z', confirmed_at: '2026-10-05T00:00:00Z', normalized_value: '704000123', barcode_value: '704000123' },
    { diagnostic_user_id: UID_C, shipment_ref: 'sched-0', provider: 'prevent', test_type: 'cancer_urine', status: 'superseded', lab_test_id: 'lab-0', lab_test_link_status: 'linked', normalized_value: '704000999' },
  ];
  db.TABLES.lab_tests = [
    { id: 'lab-1', diagnostic_user_id: UID_C, status: 'in_lab', reported_at: null, external_barcode: '704000123' },
    { id: 'lab-other', diagnostic_user_id: UID_C, status: 'imported', reported_at: '2026-01-01' },
  ];
  db.TABLES.elith_deliveries = [
    { diagnostic_user_id: UID_C, delivered_at: '2026-10-10T14:00:00Z', delivery_prefix: '', status: 'delivered' },
    { diagnostic_user_id: UID_C, delivered_at: '2026-11-10T14:00:00Z', delivery_prefix: 'verify/', status: 'delivered' },
  ];
  db.TABLES.elith_delivery_items = [
    { diagnostic_user_id: UID_C, format_id: 'BloodTestData', test_date: '2026-09-01', status: 'failed', last_error: 'x'.repeat(500), attempt_count: 2, updated_at: '2026-11-01T00:00:00Z' },
  ];
  db.TABLES.diagnosis_results = [
    { id: 'rp-old', diagnostic_user_id: UID_C, status: 'superseded', publish_status: 'approved', received_at: '2026-12-01T00:00:00Z', report_pdf_url: null },
    { id: 'rp-new', diagnostic_user_id: UID_C, status: 'received', publish_status: 'pending', received_at: '2026-11-01T00:00:00Z', report_pdf_url: 's3://x/y.pdf', report: { abstract: '本文' } },
    { id: 'rp-b', diagnostic_user_id: UID_B, status: 'received', publish_status: 'approved', approved_at: '2026-11-02T00:00:00Z', received_at: '2026-11-01T00:00:00Z', report_pdf_url: null, approved_report_hash: null },
  ];
}

const post = async (body, headers = {}) => {
  const res = await api.POST({ request: new Request('https://x/api/admin/pipeline-progress', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  }) });
  return { status: res.status, headers: res.headers, json: await res.json() };
};
const SUBJ = [
  { diagnostic_user_id: UID_A, plan_code: PLAN_C },
  { diagnostic_user_id: UID_B, plan_code: null },
  { diagnostic_user_id: UID_C.toUpperCase(), plan_code: PLAN_C },
  { diagnostic_user_id: UID_D, plan_code: 'unknown-plan' },
];

console.log('① 認可・入力検証');
seed(); auth.AUTH.ok = false;
ok('鍵が無ければ 401', (await post({ subjects: SUBJ })).status === 401);
seed();
ok('subjects が無ければ 400', (await post({})).status === 400);
ok('UUID でなければ 400', (await post({ subjects: [{ diagnostic_user_id: 'x' }] })).status === 400);
const many = Array.from({ length: 201 }, (_, i) => ({ diagnostic_user_id: `aaaaaaaa-1111-4111-8111-${String(i).padStart(12, '0')}` }));
ok('201 件は切り捨てずに 400', (await post({ subjects: many })).status === 400);
ok('200 件は通る', (await post({ subjects: many.slice(0, 200) })).status === 200);

console.log('⑩ ヘッダ');
seed();
const r = await post({ subjects: SUBJ });
eq('200', r.status, 200);
ok('cache-control: private, no-store', /private/.test(r.headers.get('cache-control') ?? '') && /no-store/.test(r.headers.get('cache-control') ?? ''));
const F = r.json.facts;

console.log('② PII・検査値を返さない');
const text = JSON.stringify(r.json);
for (const bad of ['山田太郎', '704000123', '704000999', 'AST', 'scan_md', 'measurements', 'normalized_value', 'barcode_value', 'external_barcode', 'abstract', '本文', 's3://x/y.pdf', 'x'.repeat(161)]) {
  ok(`応答に「${bad.length > 20 ? bad.slice(0, 10) + '…' : bad}」が出ない`, !text.includes(bad));
}
ok('last_error は先頭 160 字まで', F[UID_C].elith.failed_items[0].last_error.length === 160);

console.log('⑨ デモ・スペシャル');
eq('uid は小文字で返る', Object.keys(F).sort(), [UID_A, UID_B, UID_C, UID_D].sort());
ok('デモは is_demo', F[UID_A].is_demo === true && F[UID_A].is_special === false);
ok('スペシャルは is_special', F[UID_B].is_special === true && F[UID_B].is_demo === false);
ok('一般は両方 false', F[UID_C].is_demo === false && F[UID_C].is_special === false);

console.log('問診・検査・台帳');
eq('問診 2 件・最新日', F[UID_C].interview, { completed_count: 2, latest_completed_at: '2026-11-01T00:00:00Z' });
eq('問診なしは 0 件 (表は引けている)', F[UID_D].interview, { completed_count: 0, latest_completed_at: null });
eq('active の artifact だけ', F[UID_C].artifacts.map((a) => a.id).sort(), ['art-dv', 'art-hc']);
ok('派生 blood に derived=true', F[UID_C].artifacts.find((a) => a.id === 'art-dv').derived === true);
eq('台帳は superseded を除く', F[UID_C].captures.map((c) => c.shipment_ref), ['sched-1']);
eq('紐付いた lab_tests の状態だけ', [F[UID_C].captures[0].lab_test_status, F[UID_C].captures[0].lab_test_id], ['in_lab', 'lab-1']);

console.log('④ Elith の揃い判定');
eq('派生 blood を数えず BloodTestData が missing', F[UID_C].elith.missing, ['BloodTestData']);
ok('ready=false', F[UID_C].elith.ready === false);
ok('HealthAgeData は判定に入れない', !F[UID_C].elith.checked.includes('HealthAgeData'));
ok('対応表に無い plan は required_formats=null・ready=null', F[UID_D].elith.required_formats === null && F[UID_D].elith.ready === null);
ok('plan 無しも required_formats=null', F[UID_B].elith.required_formats === null);

console.log('⑤ 本番 prefix だけを納品済みと読む');
eq('本番 1 件', [F[UID_C].elith.delivered_count, F[UID_C].elith.latest_delivered_at], [1, '2026-10-10T14:00:00Z']);
eq('失敗 1 件', F[UID_C].elith.failed_items.length, 1);

console.log('⑥ 報告書');
eq('superseded を除いた最新 1 件', F[UID_C].report.id, 'rp-new');
ok('pending は visible=false', F[UID_C].report.visible === false && F[UID_C].report.has_pdf === true);
ok('指紋なしの approved は visible=true', F[UID_B].report.visible === true);
ok('受領なしは report=null', F[UID_D].report === null);

console.log('⑦ 書き込まない');
eq('書き込み 0 回', db.WRITES.length, 0);

console.log('③ 引けなかった表は不明 (null)');
for (const [tbl, check] of [
  ['interview_completions', (f) => f.interview === null && f.elith.ready === null],
  ['test_artifacts', (f) => f.artifacts === null && f.elith.ready === null],
  ['lab_test_id_captures', (f) => f.captures === null],
  ['elith_deliveries', (f) => f.elith.delivered_count === null && f.elith.latest_delivered_at === null],
  ['elith_delivery_items', (f) => f.elith.failed_items === null && f.elith.delivered_count === null],
]) {
  seed(); db.FAIL.select = tbl;
  const x = await post({ subjects: SUBJ });
  ok(`${tbl} が引けない → 不明 (null)・sources に error`, x.status === 200 && check(x.json.facts[UID_C]) && x.json.sources[tbl] === 'error');
}
seed(); db.FAIL.select = 'diagnosis_results';
const xr = await post({ subjects: SUBJ });
ok('diagnosis_results が引けない → sources に error (report=null を「無い」と読ませない)', xr.json.sources.diagnosis_results === 'error');
seed(); db.FAIL.noServer = true;
ok('DB 未設定は 503', (await post({ subjects: SUBJ })).status === 503);

console.log('⑧ N+1 にしない (構造)');
const lib = code('src/lib/pipeline-progress-facts.ts');
ok('ループの中で from( を呼ばない', !/for \([^)]*\) \{[^}]*\.from\(/.test(lib));
const fromCount = (lib.match(/\.from\('/g) ?? []).length;
ok(`問い合わせは固定本数 (${fromCount} 本)`, fromCount <= 10);
ok('書き込み系メソッドを呼ばない', !/\.(insert|upsert|update|delete)\(/.test(lib));
ok('揃い判定は既存の decideReady を使う (複製しない)', /decideReady\(/.test(lib) && !/FORMAT_SOURCE/.test(lib));
ok('公開判定は既存の isPubliclyVisibleRow を使う', /isPubliclyVisibleRow\(/.test(lib));

if (fails.length) {
  console.error(`\nFAIL ${fails.length} 件`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nOK verify:pipeline-progress-facts');
