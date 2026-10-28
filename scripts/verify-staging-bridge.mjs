#!/usr/bin/env node
/**
 * staging bridge 接続 (Edge Function `get-bridge-bundle`) の回帰チェック。
 *
 * **なぜ要るか**: この経路は静かに壊れる。
 *   - staging なのに production の `app_bridge` を読みに行っても、画面は
 *     「キット進捗 0 件」に見えるだけで**エラーにならない**。
 *   - 失敗時に production へフォールバックすると、**別環境の他人のデータ**が出かねない。
 *   - シークレットを URL やログへ載せても、画面は正常に見える。
 * 目視では守れないので固定する。**サーバもキーも要らない** (実物を transpile し
 * `createClient` と Edge Function をスタブに差し替えて動かす)。
 *
 * 実行: node scripts/verify-staging-bridge.mjs
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const fails = [];
const ok = (label) => console.log(`  ✓ ${label}`);
const bad = (label, detail) => { fails.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); };
const eq = (label, got, want) => {
  JSON.stringify(got) === JSON.stringify(want)
    ? ok(label)
    : bad(label, `got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

// --- 秘密の実値は使わない。テスト専用のダミー。 ---------------------------------
const SECRET = 'test-only-shared-secret-do-not-use';
const UID = 'aaaaaaaa-1111-2222-3333-444444444444';

// --- 実物を transpile ------------------------------------------------------------
const ts = (await import('typescript')).default;
const CACHE = resolve(ROOT, 'node_modules/.cache');
mkdirSync(CACHE, { recursive: true });

const emit = (name, src) => {
  const out = resolve(CACHE, name);
  writeFileSync(out, ts.transpileModule(src, { compilerOptions: { target: 'ES2022', module: 'ESNext' } }).outputText);
  return out;
};

// supabase.ts: createClient をスタブへ。**env は import.meta.env でなく差し替え可能な袋から読ませる**
// (Vite の定数畳み込みで `return false` が焼き付く事故があったため、両読みの形も別途検査する)。
let supaSrc = read('src/lib/supabase.ts')
  .replace(/import \{ createClient[^}]*\} from '@supabase\/supabase-js';/, `
/*
 * **記録先は globalThis。** この verify は supabase.ts をキャッシュ破り付きで
 * import する一方、bridge-queries.ts からの import は素のパスなので、
 * **モジュールの実体が 2 つ**できる。モジュール変数に記録すると
 * bridge-queries 経由の呼び出しが別の配列へ入り、
 * clientCalls.length === 0 のような検査が**空振りで通る**（実際に
 * kit_schedule の問い合わせを数えようとして気づいた）。
 * （この注釈はテンプレートリテラルの中なのでバッククォートを書けない。）
 */
globalThis.__rec = globalThis.__rec || { clientCalls: [], queries: [], orders: [] };
export const __clientCalls = globalThis.__rec.clientCalls;
export const __queries = globalThis.__rec.queries;
export const __orders = globalThis.__rec.orders;
/**
 * production 経路の Supabase クライアントのスタブ。
 * **throw しない** — staging から流れ込んだ場合も検査を最後まで走らせ、
 * 「クライアントを作った / 表を引いた」という事実を記録して assert させる
 * (throw すると 1 件目で落ちて残りの退行が見えなくなる)。
 */
/**
 * 表ごとの応答は globalThis.__tableData[table] から採る。
 * **既定は従来どおり data: null / error: null** なので、
 * 差し替えない既存の検査（⑦ など）の挙動は 1 つも変わらない。
 * order() の引数も控える（どちらの供給元をどう並べたかを測るため）。
 * （この注釈はテンプレートリテラルの中なのでバッククォートを書けない。）
 */
const chain = (table) => {
  const res = () => (globalThis.__tableData && globalThis.__tableData[table])
    || { data: null, error: null };
  const c = { then: (r) => r(res()) };
  for (const m of ['select', 'eq', 'limit']) c[m] = () => c;
  c.order = (col, opts) => { globalThis.__rec.orders.push({ table, col, opts }); return c; };
  c.maybeSingle = async () => res();
  globalThis.__rec.queries.push(table);
  return c;
};
const createClient = (url, key, opts) => { globalThis.__rec.clientCalls.push({ url, key, opts }); return { from: chain }; };
`)
  .replace(/import type \{ Database \}[^\n]*\n/, '')
  .replace(/import type \{ BridgeDatabase \}[^\n]*\n/, '')
  .replace(/import\.meta\.env as Record<string, string \| undefined>/g, 'globalThis.__env')
  .replace(/import\.meta\.env\.(\w+)/g, 'globalThis.__env.$1');
if (!supaSrc.includes('__clientCalls')) bad('verify 自体: supabase.ts の import 形が変わり createClient を差し替えられない');
const supaPath = emit('verify-staging-supabase.mjs', supaSrc);

let bqSrc = read('src/lib/bridge-queries.ts')
  .replace(/from '\.\/supabase'/, `from ${JSON.stringify(supaPath)}`)
  .replace(/import type \{[^}]*\} from '\.\.\/types\/[^']*';\n/g, '');
const bqPath = emit('verify-staging-bridge-queries.mjs', bqSrc);

globalThis.__env = {};
const SUPA = await import(`${supaPath}?t=${Date.now()}`);
const BQ = await import(`${bqPath}?t=${Date.now()}`);

// --- Edge Function のスタブ --------------------------------------------------------
/** 次の 1 回の応答を決める。`{ status, body, delayMs }`。 */
let next = null;
/** 受け取った要求の記録 (ヘッダ・body)。 */
const seen = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    seen.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: raw });
    const plan = next ?? { status: 200, body: { success: true, data: null } };
    if (plan.delayMs) await new Promise((r) => setTimeout(r, plan.delayMs));
    res.writeHead(plan.status, { 'content-type': 'application/json' });
    res.end(typeof plan.body === 'string' ? plan.body : JSON.stringify(plan.body));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const FN_URL = `http://127.0.0.1:${server.address().port}/functions/v1/get-bridge-bundle`;

const setEnv = (o) => { globalThis.__env = o; };
const stagingEnv = () => setEnv({ HP_BRIDGE_STAGING_FUNCTION_URL: FN_URL, HP_BRIDGE_STAGING_SHARED_SECRET: SECRET });

// console.error を捕まえる (シークレットが漏れていないかを見る)
const logs = [];
const realErr = console.error;
console.error = (...a) => { logs.push(a.map(String).join(' ')); };

const ACCOUNT = { diagnostic_user_id: UID, hp_customer_id: 'HP-1', display_name: 'テスト', sex: 'male', birth_year: 1970, synced_at: '2026-09-11T00:00:00Z', source_updated_at: null };
const SUB = { diagnostic_user_id: UID, plan_code: 'plan-a', plan_name: '検査パッケージ', status: 'active', started_at: '2026-09-01T00:00:00Z', next_test_at: null, last_test_at: null, synced_at: '2026-09-11T00:00:00Z' };
const SHIPS = [
  { id: 's1', order_id: 'WF-1', diagnostic_user_id: UID, test_type: '検査パッケージ', shipped_at: null, tracking_no: null, user_received_at: null, user_returned_at: null, synced_at: '2026-09-11T00:00:00Z' },
  { id: 's2', order_id: 'WF-2', diagnostic_user_id: UID, test_type: '検査パッケージ', shipped_at: null, tracking_no: null, user_received_at: null, user_returned_at: null, synced_at: '2026-09-11T00:00:00Z' },
];

console.log('\nstaging bridge (Edge Function 経路)\n');

// ① 正常系: 実測どおり customer 1 / subscription 1 / kit_shipment 2
stagingEnv();
SUPA.__clientCalls.length = 0; seen.length = 0;
next = { status: 200, body: { success: true, data: { customer: ACCOUNT, subscription: SUB, shipments: SHIPS } } };
{
  const r = await BQ.loadBridgeBundle(UID, 'staging');
  eq('① 200 でバンドルが組める (customer/subscription/shipments=2)',
    'error' in r ? { error: r.error } : { customer: !!r.customer, subscription: !!r.subscription, shipments: r.shipments.length },
    { customer: true, subscription: true, shipments: 2 });
  eq('① staging で Supabase クライアントを 1 つも作らない', SUPA.__clientCalls.length, 0);
  eq('① POST で 1 回だけ呼ぶ', seen.length, 1);
  eq('① シークレットは x-bridge-secret ヘッダで送る', seen[0]?.headers['x-bridge-secret'], SECRET);
  eq('① URL にシークレットを載せない', String(seen[0]?.url ?? '').includes(SECRET), false);
  eq('① body にシークレットを載せない', String(seen[0]?.body ?? '').includes(SECRET), false);
  eq('① body は diagnostic_user_id だけ', JSON.parse(seen[0]?.body ?? '{}'), { diagnostic_user_id: UID });
  eq('① Authorization ヘッダを付けない (JWT を持ち込まない)', 'authorization' in (seen[0]?.headers ?? {}), false);
}

// ② 非 200 → エラーを返す。**production へ落ちない**
SUPA.__clientCalls.length = 0; seen.length = 0; logs.length = 0;
next = { status: 500, body: { success: false, error: 'boom' } };
{
  const r = await BQ.loadBridgeBundle(UID, 'staging');
  eq('② HTTP 500 は error を返す', 'error' in r && r.error.includes('500'), true);
  eq('② HTTP 500 で production の app_bridge へ落ちない', SUPA.__clientCalls.length, 0);
  eq('② 失敗を握り潰さずログへ残す', logs.length > 0, true);
  eq('② ログにシークレットを出さない', logs.some((l) => l.includes(SECRET)), false);
}

// ③ 200 だが success:false → エラー
SUPA.__clientCalls.length = 0; logs.length = 0;
next = { status: 200, body: { success: false, error: 'Forbidden' } };
{
  const r = await BQ.loadBridgeBundle(UID, 'staging');
  eq('③ success:false は error を返す', 'error' in r && r.error.includes('Forbidden'), true);
  eq('③ success:false で production へ落ちない', SUPA.__clientCalls.length, 0);
  eq('③ 理由をログへ残す', logs.some((l) => l.includes('Forbidden')), true);
}

// ④ 応答が JSON でない → エラー (throw しない)
SUPA.__clientCalls.length = 0;
next = { status: 200, body: '<html>gateway</html>' };
{
  const r = await BQ.loadBridgeBundle(UID, 'staging');
  eq('④ JSON でない応答でも throw せず error', 'error' in r, true);
  eq('④ JSON でない応答で production へ落ちない', SUPA.__clientCalls.length, 0);
}

// ⑤ 200 / success:true / customer なし → **エラーではなく空**
SUPA.__clientCalls.length = 0;
next = { status: 200, body: { success: true, data: null } };
{
  const r = await BQ.loadBridgeBundle(UID, 'staging');
  eq('⑤ 該当顧客なしは error でなく空バンドル',
    'error' in r ? { error: r.error } : { customer: r.customer, shipments: r.shipments.length, subscription: r.subscription },
    { customer: null, shipments: 0, subscription: null });
}

// ⑥ 未構成 (env が無い) → error。**production を代わりに読まない**
setEnv({ HP_BRIDGE_SUPABASE_URL: 'https://prod.example.com', HP_BRIDGE_READONLY_KEY: 'prod-key' });
SUPA.__clientCalls.length = 0; seen.length = 0;
{
  eq('⑥ staging 未構成なら isBridgeConfigured("staging") は false', SUPA.isBridgeConfigured('staging'), false);
  const r = await BQ.loadBridgeBundle(UID, 'staging');
  eq('⑥ staging 未構成は error', 'error' in r, true);
  eq('⑥ staging 未構成でも production の鍵を使わない', SUPA.__clientCalls.length, 0);
  eq('⑥ staging 未構成でも Edge Function を叩かない', seen.length, 0);
}

// ⑦ production 経路は無改造 — Edge Function を叩かず、従来どおり Supabase クライアントを作る
seen.length = 0; SUPA.__clientCalls.length = 0;
{
  const c = SUPA.getBridgeSupabase('production');
  eq('⑦ production は従来どおりクライアントを作る', !!c && SUPA.__clientCalls.length === 1, true);
  eq('⑦ production のクライアントは app_bridge スキーマ', SUPA.__clientCalls[0]?.opts?.db?.schema, 'app_bridge');
  eq('⑦ production の URL/キーは production の env', [SUPA.__clientCalls[0]?.url, SUPA.__clientCalls[0]?.key], ['https://prod.example.com', 'prod-key']);
  eq('⑦ production は Edge Function を叩かない', seen.length, 0);
  eq('⑦ isBridgeConfigured("production") は true', SUPA.isBridgeConfigured('production'), true);
}

// ⑧ staging で getBridgeSupabase は必ず null (直接接続の経路が残っていない)
stagingEnv();
SUPA.__clientCalls.length = 0;
{
  eq('⑧ getBridgeSupabase("staging") は null', SUPA.getBridgeSupabase('staging'), null);
  eq('⑧ staging でクライアントを作らない', SUPA.__clientCalls.length, 0);
}

// ⑨ タイムアウト → error (SSR を止めない)。実時間を待たないよう fetch を差し替える
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; };
  SUPA.__clientCalls.length = 0; logs.length = 0;
  const r = await BQ.loadBridgeBundle(UID, 'staging');
  globalThis.fetch = realFetch;
  eq('⑨ タイムアウトは error を返す', 'error' in r, true);
  eq('⑨ タイムアウトで production へ落ちない', SUPA.__clientCalls.length, 0);
  eq('⑨ タイムアウトもログへ残す', logs.length > 0, true);
  eq('⑨ タイムアウトのログにシークレットを出さない', logs.some((l) => l.includes(SECRET)), false);
}

// ── ⑩ 検査キットの行の供給元 (production・2026-10-28) ────────────────────────
// ① `kit_schedule`（契約 × 回 × キット）があれば ① だけ。
// ② `kit_shipment`（1 注文 = 1 行の注文ミラー）は ① が無いときの代替。
// **ここが取り違わると「進行中のキットはありません」のまま誰も気づけない。**
setEnv({ HP_BRIDGE_SUPABASE_URL: 'https://prod.example.com', HP_BRIDGE_READONLY_KEY: 'prod-key' });

const SCHED = [
  { id: 'k2', diagnostic_user_id: UID, subscription_id: 'sub-1', kit_code: 'cancer_urine',
    kit_name: 'がんリスク検査（尿）', lab_company: 'プリベント', cycle_year: 1, cycle_seq: 2,
    scheduled_date: '2026-10-10', status: 'planned', instruction_sent_at: null, shipped_at: null,
    tracking_no: null, carrier: null, user_received_at: null, user_returned_at: null,
    lab_received_at: null, lab_completed_at: null, synced_at: '2026-10-28T00:00:00Z' },
  { id: 'k1', diagnostic_user_id: UID, subscription_id: 'sub-1', kit_code: 'genetics',
    kit_name: '遺伝子検査', lab_company: 'Genoplan', cycle_year: 1, cycle_seq: 1,
    scheduled_date: '2026-04-10', status: 'planned', instruction_sent_at: null, shipped_at: null,
    tracking_no: null, carrier: null, user_received_at: null, user_returned_at: null,
    lab_received_at: null, lab_completed_at: null, synced_at: '2026-10-28T00:00:00Z' },
];
const prodBag = (over) => { globalThis.__tableData = { customer_account: { data: ACCOUNT, error: null }, subscription: { data: SUB, error: null }, kit_shipment: { data: SHIPS, error: null }, kit_schedule: { data: [], error: null }, ...over }; };

console.log('\n検査キットの行の供給元 (production)\n');

prodBag({ kit_schedule: { data: SCHED, error: null } });
SUPA.__queries.length = 0; SUPA.__orders.length = 0;
{
  const r = await BQ.loadBridgeBundle(UID, 'production');
  const got = 'error' in r ? { error: r.error } : r.shipments.map((x) => x.test_type);
  eq('⑩ kit_schedule があれば ① だけを使う（注文ミラーを混ぜない）', got, ['genetics', 'cancer_urine']);
  eq('⑩ scheduled_date の昇順に並べる（近い回が先）', got, ['genetics', 'cancer_urine']);
  eq('⑩ kit_schedule も問い合わせている', SUPA.__queries.includes('kit_schedule'), true);
  eq('⑩ kit_schedule は scheduled_date の昇順で引く',
    SUPA.__orders.find((o) => o.table === 'kit_schedule'),
    { table: 'kit_schedule', col: 'scheduled_date', opts: { ascending: true } });
  if (!('error' in r)) {
    const g = r.shipments[0];
    eq('⑩ test_type は kit_code（testTypeLabel の語彙）', g.test_type, 'genetics');
    eq('⑩ lab_name に検査会社が入る（注文ミラーは null 固定だった）', g.lab_name, 'Genoplan');
    eq('⑩ 予定だけの行は日時列が 1 つも埋まらない（段階 1「出荷準備」になる）',
      [g.shipped_at, g.user_received_at, g.user_returned_at, g.lab_received_at, g.lab_completed_at],
      [null, null, null, null, null]);
    eq('⑩ 回の情報を落とさない', [g.subscription_year, g.subscription_seq], [1, 1]);
    eq('⑩ 予定日は expected_arrival_date に載せる', g.expected_arrival_date, '2026-04-10');
  }
}

prodBag({ kit_schedule: { data: [], error: null } });
{
  const r = await BQ.loadBridgeBundle(UID, 'production');
  eq('⑩ kit_schedule が 0 件なら従来どおり注文ミラー（単品・がんチェッカー）',
    'error' in r ? { error: r.error } : r.shipments.map((x) => x.id), ['s1', 's2']);
}

// **migration 未適用の環境**: PostgREST は表が無いと 404 / PGRST205 を返す。
// ここで error を返すとダッシュボードが丸ごと落ちる。
prodBag({ kit_schedule: { data: null, error: { message: 'relation "kit_schedule" does not exist', code: 'PGRST205' } } });
logs.length = 0;
console.error = (...a) => { logs.push(a.map(String).join(' ')); };
{
  const r = await BQ.loadBridgeBundle(UID, 'production');
  eq('⑩ kit_schedule が無い環境でもダッシュボードを落とさない', 'error' in r, false);
  eq('⑩ その回は注文ミラーで成立させる',
    'error' in r ? { error: r.error } : r.shipments.map((x) => x.id), ['s1', 's2']);
  eq('⑩ 黙らせない（理由をログへ残す）', logs.some((l) => l.includes('kit_schedule')), true);
  eq('⑩ ログに uid を載せない', logs.some((l) => l.includes(UID)), false);
}

// subscription / kit_shipment の失敗は**従来どおり** error（こちらは握り潰さない）。
prodBag({ kit_shipment: { data: null, error: { message: 'boom' } } });
{
  const r = await BQ.loadBridgeBundle(UID, 'production');
  eq('⑩ kit_shipment の失敗は従来どおり error', 'error' in r && r.error.includes('kit_shipment'), true);
}
prodBag({ subscription: { data: null, error: { message: 'boom' } } });
{
  const r = await BQ.loadBridgeBundle(UID, 'production');
  eq('⑩ subscription の失敗は従来どおり error', 'error' in r && r.error.includes('subscription'), true);
}
globalThis.__tableData = undefined;

// ── ⑪ staging は kit_schedule を返さなくても壊れない ────────────────────────
// `get-bridge-bundle` はこのリポジトリに無く、まだ kit_schedule を返していない。
stagingEnv();
seen.length = 0;
next = { status: 200, body: { success: true, data: { customer: ACCOUNT, subscription: SUB, shipments: SHIPS } } };
{
  const r = await BQ.loadBridgeBundle(UID, 'staging');
  eq('⑪ kit_schedule が応答に無くても従来どおり成立する',
    'error' in r ? { error: r.error } : r.shipments.map((x) => x.id), ['s1', 's2']);
}
next = { status: 200, body: { success: true, data: { customer: ACCOUNT, subscription: SUB, shipments: SHIPS, kit_schedule: SCHED } } };
{
  const r = await BQ.loadBridgeBundle(UID, 'staging');
  eq('⑪ 返るようになったら自動で ① を使う',
    'error' in r ? { error: r.error } : r.shipments.map((x) => x.test_type), ['genetics', 'cancer_urine']);
}

console.error = realErr;
server.close();

// --- ソースの形を固定する検査 (実行では捕まらないもの) -------------------------------
console.log('\nソースの約束\n');
{
  const supa = read('src/lib/supabase.ts');
  const bq = read('src/lib/bridge-queries.ts');

  // Vite が `import.meta.env.X` をビルド時に畳むため、未定義だと `return false` が焼き付く。
  // 既存の両読み (import.meta.env → process.env) が残っていること。
  eq('env は import.meta.env と process.env の両読み', /process\.env/.test(supa) && /import\.meta\.env/.test(supa), true);

  // 廃止した staging 方式の env 名が復活していないこと。
  const dead = ['HP_BRIDGE_STAGING_PUBLISHABLE_KEY', 'HP_BRIDGE_STAGING_READONLY_JWT'];
  eq('廃止した staging env 名が残っていない', dead.filter((d) => supa.includes(d) || bq.includes(d)), []);

  // staging → production の無条件フォールバックが書かれていないこと。
  eq("loadBridgeBundle は staging を即分岐する", /if \(origin === 'staging'\) return loadStagingBundleViaFunction\(uid\);/.test(bq), true);
  eq('staging の失敗経路に production 呼び出しが無い',
    /loadStagingBundleViaFunction[\s\S]*?\n}\n/.exec(bq)?.[0]?.includes('getBridgeSupabase') ?? true, false);

  // 秘密をログへ出さないこと (console に endpoint.secret を渡していない)。
  eq('ログにシークレットを渡す行が無い', /console\.(log|error|warn)\([^)]*secret/i.test(bq), false);

  // 失敗を黙って空にしないこと (呼び出し側がログを残す)。
  const dq = read('src/lib/dashboard-queries.ts');
  eq('dashboard-queries が bridge 失敗をログへ残す', /'error' in bundle[\s\S]{0,200}console\.error/.test(dq), true);

  // 供給元の選択は 1 か所だけ (production と staging で規則が分かれない)。
  eq('供給元の選択は pickShipments 1 か所', (bq.match(/pickShipments\(/g) || []).length, 3);
  eq('① と ② を連結していない', /\[\s*\.\.\.\s*sched[\s\S]{0,40}\.\.\.\s*ship/.test(bq), false);
  eq('kit_schedule の失敗で error を返していない',
    /kit_schedule: \$\{schedErr/.test(bq), false);
}

console.log('');
if (fails.length) {
  console.error(`FAIL (${fails.length})`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('PASS: staging bridge の経路・エラー処理・秘密の扱いは約束どおり');
