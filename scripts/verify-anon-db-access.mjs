/**
 * 公開用キー (anon) で customer / diagnosis の表が本当に読めないかを、
 * 本番の API に**読み取りだけ**で問い合わせて確かめる。
 *
 * 【使い方】20261119000010_close_dev_policies.sql を本番へ適用した後に 1 回流す。
 *   PUBLIC_SUPABASE_URL=https://<project>.supabase.co \
 *   PUBLIC_SUPABASE_ANON_KEY=<公開用キー> \
 *   npm run verify:anon-db-access
 *
 *   ログイン利用者として読めないかも見るときは、任意の一般利用者でサインインした
 *   アクセストークンを USER_ACCESS_TOKEN に渡す (無ければ anon だけ見る)。
 *
 *   使う鍵は**ページの HTML に出ている公開用キーだけ**。service_role は使わない・要らない。
 *
 * 【安全のための約束】
 *   - GET だけ。書き込み・削除は 1 回もしない。
 *   - 1 表につき最大 1 行しか要求せず、**返ってきた中身は 1 文字も表示しない**
 *     (開いていた場合でも、出すのは「何行返ったか」だけ)。
 *   - 対象の表は migration から読む (customer / diagnosis で create table されたもの全部)。
 *     手で名簿を持たないので、表が増えても取りこぼさない。
 *
 * 【判定】
 *   PASS = 401 / 403、または PostgREST のエラーコード 42501 (permission denied) /
 *          PGRST106 (スキーマが公開されていない)
 *   FAIL = 200。**0 行でも FAIL** — 権限が残っていて、たまたま RLS で 0 行に
 *          なっているだけなので、ポリシーを 1 本足せば開く。
 *   不明 = それ以外 (404 = 表が本番に無い等)。理由を出して終了コード 2。
 *
 * 終了コード: 0 = 全部 PASS / 1 = FAIL あり / 2 = 判定できない表あり / 3 = 設定不足
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const MIG = join(ROOT, 'supabase', 'migrations');

const url = (process.env.PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
const anon = process.env.PUBLIC_SUPABASE_ANON_KEY ?? '';
const userToken = process.env.USER_ACCESS_TOKEN ?? '';

if (!url || !anon) {
  console.error('PUBLIC_SUPABASE_URL と PUBLIC_SUPABASE_ANON_KEY を指定してください (公開用キーです)。');
  process.exit(3);
}
if (/service_role/.test(Buffer.from(anon.split('.')[1] ?? '', 'base64url').toString())) {
  console.error('渡された鍵は service_role です。この検査は公開用キー (anon) で行います。');
  process.exit(3);
}

/** migration から customer / diagnosis の表を全部拾う。 */
function tablesFromMigrations() {
  const set = new Set();
  for (const f of readdirSync(MIG).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIG, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\n]*/g, '')
      .toLowerCase();
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(customer|diagnosis)\.([a-z_0-9]+)/g)) {
      set.add(`${m[1]}.${m[2]}`);
    }
  }
  return [...set].sort();
}

async function probe(schema, table, bearer) {
  const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
    method: 'GET',
    headers: {
      apikey: anon,
      Authorization: `Bearer ${bearer}`,
      'Accept-Profile': schema,
      Accept: 'application/json',
    },
  });
  let body = null;
  try { body = await res.json(); } catch { /* 本文が JSON でない */ }

  if (res.status === 200) {
    const rows = Array.isArray(body) ? body.length : '?';
    return { verdict: 'FAIL', note: `200 で応答 (${rows} 行)。権限が残っている` };
  }
  const code = body && typeof body === 'object' && !Array.isArray(body) ? String(body.code ?? '') : '';
  if (code === '42501') return { verdict: 'PASS', note: `${res.status} permission denied` };
  if (code === 'PGRST106') return { verdict: 'PASS', note: `${res.status} スキーマが公開されていない` };
  if (res.status === 401 || res.status === 403) return { verdict: 'PASS', note: `${res.status}` };
  return { verdict: 'UNKNOWN', note: `${res.status}${code ? ` ${code}` : ''}` };
}

const tables = tablesFromMigrations();
const roles = [['anon (未ログイン)', anon]];
if (userToken) roles.push(['authenticated (一般利用者)', userToken]);

let failN = 0;
let unknownN = 0;
for (const [label, bearer] of roles) {
  console.log(`\n== ${label} / ${tables.length} 表`);
  for (const t of tables) {
    const [schema, table] = t.split('.');
    let r;
    try {
      r = await probe(schema, table, bearer);
    } catch (e) {
      r = { verdict: 'UNKNOWN', note: `通信エラー: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (r.verdict === 'FAIL') failN++;
    if (r.verdict === 'UNKNOWN') unknownN++;
    console.log(`  ${r.verdict.padEnd(7)} ${t.padEnd(42)} ${r.note}`);
  }
}

console.log(`\nFAIL ${failN} / 判定不能 ${unknownN}`);
if (!userToken) console.log('(USER_ACCESS_TOKEN が無いので、ログイン利用者としての確認は省略した)');
process.exit(failN > 0 ? 1 : unknownN > 0 ? 2 : 0);
