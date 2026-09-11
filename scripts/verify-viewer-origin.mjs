#!/usr/bin/env node
/**
 * **Cookie の `origin` が再署名で失われないこと**の回帰チェック (2026-09-11)。
 *
 * 【なぜ要るか = 実障害】`POST /api/auth/refresh-admin` が
 * `signViewer(uid, isAdmin)` と呼んでいた。`origin` の既定は `'production'` なので、
 * **staging 由来の 5 分割 Cookie が production の 4 分割へ黙って書き換わっていた**。
 * `GoogleOneTap.astro` はサインイン済みならタブごとにこの口を叩くので**必ず踏む**。
 *
 *   Google 認証直後   … staging Cookie → dashboard にキット 2 件
 *   refresh-admin 後 … production Cookie へ再署名
 *   次の /kit        … production bridge → 0 件
 *   dashboard へ戻る … production bridge → 0 件
 *
 * **画面にはエラーが出ない**ので目視では守れない。だから機械で固定する。
 * サーバも DB も鍵も要らない — 実物を transpile し、Supabase と admin 判定だけ
 * スタブへ差し替えて `POST` ハンドラを直接呼ぶ。
 *
 * 固定するのは 4 つだけ:
 *   ① staging 5 分割 → refresh-admin → **staging 5 分割のまま**
 *   ② production 4 分割 → refresh-admin → **production 4 分割のまま**
 *   ③ uid 不変 / origin 不変
 *   ④ admin フラグ**だけ**は更新される (この口の本来の仕事)
 *
 * 実行: node scripts/verify-viewer-origin.mjs
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const fails = [];
const ok = (label) => console.log(`  ✓ ${label}`);
const bad = (label, detail) => {
  fails.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (label, got, want) =>
  got === want ? ok(label) : bad(label, `got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);

// --- 秘密の実値は使わない。テスト専用のダミー。 ---------------------------------
const SECRET = 'test-only-session-secret-do-not-use';
const UID = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER_UID = 'bbbbbbbb-9999-8888-7777-666666666666';
const ADMIN_EMAIL = 'admin@example.test';
const PLAIN_EMAIL = 'user@example.test';

process.env.APP_SESSION_SECRET = SECRET;

// --- 実物を transpile ------------------------------------------------------------
const ts = (await import('typescript')).default;
const CACHE = resolve(ROOT, 'node_modules/.cache');
mkdirSync(CACHE, { recursive: true });

const emit = (name, src) => {
  const out = resolve(CACHE, name);
  writeFileSync(
    out,
    ts.transpileModule(src, { compilerOptions: { target: 'ES2022', module: 'ESNext' } }).outputText,
  );
  return out;
};

// viewer.ts は **そのまま**使う (署名・検証の本物を通す)。
// `import.meta.env` だけ Node で読めないので env 袋へ寄せる。
let viewerSrc = read('src/lib/viewer.ts')
  .replace(/\(import\.meta as unknown as \{ env\?: Record<string, string \| undefined> \}\)\.env/g, 'globalThis.__env')
  .replace(/import\.meta\.env\.(\w+)/g, 'globalThis.__env.$1');
if (viewerSrc.includes('import.meta')) {
  bad('verify 自体: viewer.ts の import.meta を差し替えられなかった');
}
const viewerPath = emit('verify-viewer-origin-viewer.mjs', viewerSrc);

// Supabase と admin 判定はスタブ。**この口は「admin フラグだけ更新」なので、
// 差し替えても検査したい挙動 (origin の引き継ぎ) は 1 ミリも変わらない。**
const stubPath = emit(
  'verify-viewer-origin-stubs.mjs',
  `
export const __state = { email: ${JSON.stringify(PLAIN_EMAIL)}, admins: [${JSON.stringify(ADMIN_EMAIL)}] };
export function getServerSupabase() {
  return { auth: { getUser: async () => ({ data: { user: { email: __state.email } }, error: null }) } };
}
export async function isAdminEmailAsync(email) {
  return __state.admins.includes(String(email).trim().toLowerCase());
}
`,
);

let apiSrc = read('src/pages/api/auth/refresh-admin.ts')
  .replace(/import \{ getServerSupabase \} from '[^']*';/, `import { getServerSupabase } from ${JSON.stringify(stubPath)};`)
  .replace(/import \{ isAdminEmailAsync \} from '[^']*';/, `import { isAdminEmailAsync } from ${JSON.stringify(stubPath)};`)
  .replace(/from '\.\.\/\.\.\/\.\.\/lib\/viewer'/, `from ${JSON.stringify(viewerPath)}`);
for (const [label, needle] of [
  ['getServerSupabase', stubPath],
  ['viewer', viewerPath],
]) {
  if (!apiSrc.includes(needle)) bad(`verify 自体: refresh-admin.ts の import (${label}) を差し替えられなかった`);
}
const apiPath = emit('verify-viewer-origin-api.mjs', apiSrc);

globalThis.__env = { APP_SESSION_SECRET: SECRET };

const VIEWER = await import(`${viewerPath}?t=${Date.now()}`);
const API = await import(`${apiPath}?t=${Date.now()}`);
/*
 * **クエリを付けない** — `?t=…` を付けると別インスタンスになり、
 * ここで `__state` を書き換えても API 側が見ている袋は変わらない
 * (一度これで「admin が切り替わらない」を自作した)。
 * API モジュールが import したのと同じ URL で取り直す。
 */
const STUBS = await import(stubPath);

// --- Astro の cookies を最小限で再現 ---------------------------------------------
function makeCookies(initial) {
  const store = new Map(initial ? [[VIEWER.VIEWER_COOKIE, initial]] : []);
  return {
    store,
    get: (name) => (store.has(name) ? { value: store.get(name) } : undefined),
    set: (name, value) => store.set(name, value),
    delete: (name) => store.delete(name),
  };
}

/** refresh-admin を 1 回叩いて、書き戻された Cookie を返す。 */
async function callRefresh(cookieValue) {
  const cookies = makeCookies(cookieValue);
  const request = new Request('https://example.test/api/auth/refresh-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessToken: 'dummy-access-token' }),
  });
  const res = await API.POST({ request, cookies });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, cookie: cookies.store.get(VIEWER.VIEWER_COOKIE) ?? null };
}

const parts = (c) => (c === null ? -1 : c.split('.').length);

console.log('\n=== ① staging の 5 分割 Cookie は staging のまま ===');
{
  STUBS.__state.email = PLAIN_EMAIL;
  const before = await VIEWER.signViewer(UID, false, Date.now(), 'staging');
  eq('前提: staging Cookie は 5 分割', parts(before), 5);
  eq('前提: verifyViewer が staging と読む', (await VIEWER.verifyViewer(before)).origin, 'staging');

  const r = await callRefresh(before);
  eq('HTTP 200', r.status, 200);
  eq('Cookie が書き戻された', r.cookie !== null, true);
  eq('**5 分割のまま**', parts(r.cookie), 5);

  const after = await VIEWER.verifyViewer(r.cookie);
  eq('署名が通る (改竄でない)', after !== null, true);
  eq('**origin 不変 = staging**', after?.origin, 'staging');
  eq('**uid 不変**', after?.uid, UID);
}

console.log('\n=== ② production の 4 分割 Cookie は production のまま ===');
{
  STUBS.__state.email = PLAIN_EMAIL;
  const before = await VIEWER.signViewer(UID, false, Date.now(), 'production');
  eq('前提: production Cookie は 4 分割', parts(before), 4);

  const r = await callRefresh(before);
  eq('HTTP 200', r.status, 200);
  eq('**4 分割のまま**', parts(r.cookie), 4);

  const after = await VIEWER.verifyViewer(r.cookie);
  eq('**origin 不変 = production**', after?.origin, 'production');
  eq('**uid 不変**', after?.uid, UID);
}

console.log('\n=== ③ admin フラグ「だけ」は更新される (この口の本来の仕事) ===');
{
  // staging の非 admin → admin へ昇格しても origin は動かない。
  STUBS.__state.email = ADMIN_EMAIL;
  const before = await VIEWER.signViewer(UID, false, Date.now(), 'staging');
  const r = await callRefresh(before);
  const after = await VIEWER.verifyViewer(r.cookie);
  eq('admin が false → true になる', after?.admin, true);
  eq('changed:true を返す', r.body?.changed, true);
  eq('origin は staging のまま', after?.origin, 'staging');
  eq('uid は不変', after?.uid, UID);
  eq('5 分割のまま', parts(r.cookie), 5);

  // production の admin → 非 admin へ降格しても origin は動かない。
  STUBS.__state.email = PLAIN_EMAIL;
  const before2 = await VIEWER.signViewer(UID, true, Date.now(), 'production');
  const r2 = await callRefresh(before2);
  const after2 = await VIEWER.verifyViewer(r2.cookie);
  eq('admin が true → false になる', after2?.admin, false);
  eq('origin は production のまま', after2?.origin, 'production');
  eq('4 分割のまま', parts(r2.cookie), 4);
}

console.log('\n=== ④ uid はクライアント申告でなく Cookie が正 ===');
{
  // body に uid を載せても無視される (この口は accessToken しか受け取らない)。
  STUBS.__state.email = PLAIN_EMAIL;
  const before = await VIEWER.signViewer(UID, false, Date.now(), 'staging');
  const cookies = makeCookies(before);
  const request = new Request('https://example.test/api/auth/refresh-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessToken: 'dummy', uid: OTHER_UID, diagnosticUserId: OTHER_UID, origin: 'production' }),
  });
  const res = await API.POST({ request, cookies });
  eq('HTTP 200', res.status, 200);
  const after = await VIEWER.verifyViewer(cookies.store.get(VIEWER.VIEWER_COOKIE));
  eq('**body の uid は無視される**', after?.uid, UID);
  eq('**body の origin も無視される**', after?.origin, 'staging');
}

console.log('\n=== ⑤ Cookie が無ければ何も発行しない (fail-closed) ===');
{
  const r = await callRefresh(null);
  eq('HTTP 401', r.status, 401);
  eq('Cookie を発行しない', r.cookie, null);
}

console.log('\n=== ⑥ 実装が origin を渡していること (テキスト検査・二重の網) ===');
{
  /*
   * ①〜⑤ は挙動で見ているので本来これで足りるが、**この 1 行が最も落ちやすい**
   * (引数を省くと既定 production に戻り、しかも型エラーにならない)。
   * 「current の origin を渡している」ことを素の文面でも固定する。
   */
  const src = read('src/pages/api/auth/refresh-admin.ts');
  /*
   * **`[^)]*` で引数を取らない** — `Date.now()` の `)` で切れて第 4 引数を見落とす
   * (一度これで、正しい実装なのに「渡していない」と誤判定した)。
   * 括弧の深さを数えて `signViewer(` の対応する `)` までを取る。
   */
  const at = src.indexOf('signViewer(');
  eq('signViewer の呼び出しが 1 つ見つかる', at >= 0, true);
  let depth = 0;
  let end = -1;
  for (let i = at + 'signViewer'.length; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) { end = i; break; }
  }
  eq('呼び出しの括弧が閉じている', end > at, true);
  const args = src.slice(at + 'signViewer('.length, end).replace(/\s+/g, ' ').trim();
  eq('**第 4 引数に current.origin を渡している**', /current\.origin/.test(args), true);
  eq('uid も current から取っている', /current\.uid/.test(args), true);
}

// --- 集計 -------------------------------------------------------------------------
console.log('');
if (fails.length) {
  console.log(`✗ ${fails.length} 件 失敗`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✓ すべて通過 — refresh-admin は admin フラグだけを更新し、uid と origin を保つ');
