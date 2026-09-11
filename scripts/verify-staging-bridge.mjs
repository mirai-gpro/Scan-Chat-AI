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
export const __clientCalls = [];
export const __queries = [];
/**
 * production 経路の Supabase クライアントのスタブ。
 * **throw しない** — staging から流れ込んだ場合も検査を最後まで走らせ、
 * 「クライアントを作った / 表を引いた」という事実を記録して assert させる
 * (throw すると 1 件目で落ちて残りの退行が見えなくなる)。
 */
const chain = (table) => {
  const c = { then: (r) => r({ data: null, error: null }) };
  for (const m of ['select', 'eq', 'order', 'limit']) c[m] = () => c;
  c.maybeSingle = async () => ({ data: null, error: null });
  __queries.push(table);
  return c;
};
const createClient = (url, key, opts) => { __clientCalls.push({ url, key, opts }); return { from: chain }; };
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
}

console.log('');
if (fails.length) {
  console.error(`FAIL (${fails.length})`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('PASS: staging bridge の経路・エラー処理・秘密の扱いは約束どおり');
