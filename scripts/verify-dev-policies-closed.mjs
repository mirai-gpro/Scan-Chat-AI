/**
 * 開発用の全開放ポリシーが閉じたままであることを、migration とコードだけで機械的に確かめる。
 * サーバーも鍵も要らない (CI の A 層)。
 *
 * 【なぜ要るか — 2026-11-19 に本番で実測】
 *   20260601000020 が開発初期に入れた
 *     dev_read_all    (to public / select using(true)) と
 *     dev_authn_write (to authenticated / all using(true))
 *   が本番の 17 表に残っていた。ページに出ている公開用キー (anon) だけで
 *   検査値・報告書・ウェルネス年齢などの全行が読める状態だった。
 *   原因は「表を作るたびに前の表の書き方を写した」こと。9 表は個別に閉じたが、
 *   7 表は開発用の書き方を写して作られ、初期の 10 表は一度も処理されなかった。
 *   → 20261119000010_close_dev_policies.sql で一括で閉じた。
 *   **同じ写し間違いは表を足すたびに起き得る**ので、ここで見張る。
 *
 * 【何を見るか】
 *   ① 閉じる migration が在り、4 つの処理 (dev_ ポリシー削除 / RLS 有効化 /
 *      anon・authenticated からの revoke / default privileges の revoke) を両スキーマに持つ
 *   ② それより後の migration が、customer / diagnosis へ
 *      - dev_ で始まるポリシーを作らない
 *      - anon / authenticated / public へ表の権限を grant しない
 *      - using (true) のポリシーを public / anon / authenticated に作らない
 *   ③ それより後に作る表は、明示的に `revoke all on <表> from anon, authenticated` を持つ
 *      (default privileges でも防いでいるが、写し元になる書き方を正しくしておく)
 *   ④ ブラウザで公開用キーのクライアントを作るファイルは、表を読み書きしない
 *      (`sb.auth.*` と `storage.from()` だけ)。閉じても壊れない根拠を固定する。
 *
 * 【見ないもの】本番 DB の実状態。それは `npm run verify:anon-db-access` が
 *   公開用キーで実際に読みに行って確かめる。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const MIG = join(ROOT, 'supabase', 'migrations');
const SRC = join(ROOT, 'src');
const CLOSER = '20261119000010_close_dev_policies.sql';
const SCHEMAS = ['customer', 'diagnosis'];

let pass = 0;
let fail = 0;
const ok = (msg) => { pass++; console.log(`  PASS  ${msg}`); };
const ng = (msg) => { fail++; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : ng(msg));

/** SQL コメント (`-- …` と `/* … *\/`) を落とす。説明文の中の語に当たらないように。 */
function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

const files = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();

// ── ① 閉じる migration ───────────────────────────────────────────────
console.log('① 閉じる migration');
const closerIdx = files.indexOf(CLOSER);
check(closerIdx >= 0, `${CLOSER} が在る`);
if (closerIdx < 0) {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}
const closer = stripSqlComments(readFileSync(join(MIG, CLOSER), 'utf8')).toLowerCase();

check(
  /from\s+pg_policies[\s\S]*schemaname\s+in\s*\(\s*'customer'\s*,\s*'diagnosis'\s*\)[\s\S]*policyname\s+like\s+'dev\\_%'[\s\S]*drop\s+policy/.test(closer),
  'dev_ で始まるポリシーを customer / diagnosis から名指しせず全部消す',
);
check(
  /from\s+pg_tables[\s\S]*schemaname\s+in\s*\(\s*'customer'\s*,\s*'diagnosis'\s*\)[\s\S]*enable\s+row\s+level\s+security/.test(closer),
  '両スキーマの全表で RLS を有効にする',
);
for (const s of SCHEMAS) {
  for (const kind of ['tables', 'sequences']) {
    check(
      new RegExp(`revoke\\s+all\\s+on\\s+all\\s+${kind}\\s+in\\s+schema\\s+${s}\\s+from\\s+anon\\s*,\\s*authenticated`).test(closer),
      `${s} の全 ${kind} を anon / authenticated から外す`,
    );
    check(
      new RegExp(`alter\\s+default\\s+privileges\\s+in\\s+schema\\s+${s}\\s+revoke\\s+all\\s+on\\s+${kind}\\s+from\\s+anon\\s*,\\s*authenticated`).test(closer),
      `${s} で今後作る ${kind} にも自動付与させない`,
    );
  }
  check(
    new RegExp(`grant\\s+all\\s+on\\s+all\\s+tables\\s+in\\s+schema\\s+${s}\\s+to\\s+service_role`).test(closer),
    `${s} の service_role の権限は残す (アプリはこの鍵で動く)`,
  );
}
check(
  !/grant[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/.test(closer),
  '閉じる migration 自身が anon / authenticated / public へ何も grant しない',
);

// ── ② ③ それより後の migration ──────────────────────────────────────
console.log('② ③ 後続の migration');
const after = files.slice(closerIdx + 1);
if (after.length === 0) ok('後続の migration は無い (検査対象 0 本)');
const SCH = '(?:customer|diagnosis)';
for (const f of after) {
  const sql = stripSqlComments(readFileSync(join(MIG, f), 'utf8')).toLowerCase();
  const stmts = sql.split(';');

  const devPolicy = stmts.find((s) => new RegExp(`create\\s+policy\\s+"?dev_`).test(s));
  check(!devPolicy, `${f}: dev_ で始まるポリシーを作らない`);

  const badGrant = stmts.find(
    (s) =>
      new RegExp(`\\bgrant\\b[\\s\\S]*\\bon\\b[\\s\\S]*\\b${SCH}\\.`).test(s) ||
      new RegExp(`\\bgrant\\b[\\s\\S]*\\bin\\s+schema\\s+${SCH}\\b`).test(s),
  );
  const toOpen = badGrant && /\bto\b[\s\S]*\b(anon|authenticated|public)\b/.test(badGrant)
    && !/\bon\s+function\b/.test(badGrant) && !/\bgrant\s+usage\s+on\s+schema\b/.test(badGrant);
  check(!toOpen, `${f}: customer / diagnosis の表を anon / authenticated / public へ grant しない`);

  const openPolicy = stmts.find(
    (s) =>
      new RegExp(`create\\s+policy[\\s\\S]*\\bon\\s+${SCH}\\.`).test(s) &&
      /using\s*\(\s*true\s*\)/.test(s) &&
      (!/\bto\b/.test(s) || /\bto\s+[^)]*\b(public|anon|authenticated)\b/.test(s)),
  );
  check(!openPolicy, `${f}: using (true) のポリシーを public / anon / authenticated に作らない`);

  const created = [...sql.matchAll(new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(${SCH}\\.[a-z_0-9]+)`, 'g'))].map((m) => m[1]);
  for (const t of created) {
    const esc = t.replace('.', '\\.');
    check(
      new RegExp(`revoke\\s+all\\s+on\\s+(?:table\\s+)?${esc}\\b[^;]*\\bfrom\\b[^;]*\\banon\\b[^;]*\\bauthenticated\\b`).test(sql),
      `${f}: 新しい表 ${t} を anon / authenticated から明示的に外す`,
    );
  }
}

// ── ④ ブラウザ側は表に触らない ────────────────────────────────────────
console.log('④ ブラウザ側で公開用キーを使うファイル');
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(astro|ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
// 公開用キーを直接読むファイルに加え、ブラウザ用クライアントの入口
// `getBrowserSupabase()` を呼ぶファイルも対象にする (キーの文字列を書かずに表へ触れるため)。
const anonUsers = walk(SRC).filter((p) => {
  const s = readFileSync(p, 'utf8');
  return /PUBLIC_SUPABASE_ANON_KEY/.test(s) || /\bgetBrowserSupabase\s*\(/.test(s);
});
check(anonUsers.length > 0, `公開用キーを使うファイルを見つけた (${anonUsers.length} 件)`);
for (const p of anonUsers) {
  const rel = relative(ROOT, p);
  const code = readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, '');
  // `.storage.from(` と `storage = createClient(...).storage.from(` は表ではない。
  const tableFrom = [...code.matchAll(/\.from\(\s*['"`]/g)].filter((m) => {
    const before = code.slice(Math.max(0, m.index - 40), m.index);
    return !/storage\s*$/.test(before) && !/\.storage$/.test(before.trim());
  });
  check(tableFrom.length === 0, `${rel}: 表を .from() で読み書きしない`);
  check(!/\.schema\(\s*['"`](customer|diagnosis)['"`]\s*\)/.test(code), `${rel}: customer / diagnosis スキーマを直接引かない`);
  check(!/\.rpc\(/.test(code), `${rel}: RPC を呼ばない`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
