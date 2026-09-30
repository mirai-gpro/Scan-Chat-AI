#!/usr/bin/env node
/**
 * `npm run verify:share-access` — **External Share（セキュア共有閲覧）の回帰チェック。**
 *
 * 正本: `docs/specs/secure_shared_access_and_admin_impersonation_spec_20260930.md`
 *       §14〜§21 / §24〜§27 / §34.1（S 系・C 系・W 系）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【なぜ機械で見張るか】ここは**静かに壊れる**。
 * ══════════════════════════════════════════════════════════════════════
 * 共有の事故は「画面は正常に見えるのに、保存先が別人」という形で出る。
 *   ・`viewer.selfUid` に戻す        → 共有相手の問診・スキャンが **1 行も残らない**（401）
 *   ・`body.diagnosticUserId` を信じる → **他人の納品領域へ書ける**
 *   ・link 側を見ずセッションだけ見る  → **revoke / pause が効かない**（画面は普通に動く）
 *   ・pending を昇格させる            → session fixation
 *   ・帯を消す                        → 黙って別人のデータを見ている状態が作れる
 * どれも人の目では気づけないので、**実物を動かして固定する**。
 *
 * 【方式】`verify-admin-handoff.mjs` と同型。
 *   ① 実装の TS をそのまま bundle し、**`./supabase` だけ**を差し替える。
 *     スタブは **PostgreSQL 側の条件付き UPDATE の意味論を忠実に再現**する
 *     （`consented_at is null` / `revoked_at is null` / 期限 / link の status・starts_at）。
 *     「そう書いてあるか」の grep では、条件を 1 つ落とした退行を拾えない。
 *   ② 紙の上でしか守れない約束（body の uid を使わない・帯を出す・raw を保存しない）は
 *     ソースの構造検査で固定する。
 *
 * 【DB も鍵も要らない】CI の A 層（静的）に置ける。
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { webcrypto } from 'node:crypto';
import { pathToFileURL } from 'node:url';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const ROOT = resolve(import.meta.dirname, '..');
const CACHE = 'node_modules/.cache';
mkdirSync(resolve(ROOT, CACHE), { recursive: true });
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
/** コメント行を落とす（経緯の説明に旧コードが載っているので、そこを拾わない）。 */
const code = (p) => read(p).split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');

const fails = [];
const ok = (label, cond, why) => {
  if (!cond) fails.push(`${label}${why ? ` — ${why}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
};

process.env.APP_SESSION_SECRET = 'test-secret-do-not-use-in-production';

/* ══════════════════════════════════════════════════════════════════════
 * スタブ: PostgreSQL の条件付き UPDATE を**そのまま**再現する
 * ════════════════════════════════════════════════════════════════════ */
const STUB = `
export const LINKS = [];
export const SESSIONS = [];
export const LOGS = [];
export const USERS = new Set();
export let NOW = Date.parse('2026-09-30T12:00:00Z');
export function setNow(t) { NOW = t; }
export function reset() { LINKS.length = 0; SESSIONS.length = 0; LOGS.length = 0; }

const nowIso = () => new Date(NOW).toISOString();
const live = (iso) => !!iso && Date.parse(iso) > NOW;

/** migration 20260930000030 の consume_share_pending を 1 文の意味論で再現する。 */
function rpc(fn, a) {
  if (fn !== 'consume_share_pending') throw new Error('unknown rpc ' + fn);
  const s = SESSIONS.find((r) =>
    r.session_digest === a.p_pending_digest
    && r.consented_at == null           // ★ 二重 POST の 2 本目を落とす
    && r.revoked_at == null
    && live(r.expires_at));
  if (!s) return { data: [], error: null };
  const l = LINKS.find((r) => r.id === s.share_link_id);
  if (!l) return { data: [], error: null };
  if (l.status !== 'active') return { data: [], error: null };
  if (l.starts_at && Date.parse(l.starts_at) > NOW) return { data: [], error: null };
  if (!live(l.expires_at)) return { data: [], error: null };

  const cap = Math.min(NOW + a.p_session_ttl_sec * 1000, Date.parse(l.expires_at));
  s.session_digest = a.p_session_digest;   // ★ pending を昇格させない
  s.consented_at = nowIso();
  s.viewer_id = a.p_viewer_id ?? s.viewer_id ?? null;
  s.expires_at = new Date(cap).toISOString();
  return { data: [{ link_id: l.id, target_uid: l.target_uid, expires_at: s.expires_at }], error: null };
}

function rowsOf(name) {
  if (name === 'shared_access_links') return LINKS;
  if (name === 'shared_access_sessions') return SESSIONS;
  if (name === 'shared_access_logs') return LOGS;
  return [...USERS].map((u) => ({ diagnostic_user_id: u }));
}

function table(name) {
  const q = (filters, ins, patch) => ({
    eq: (c, v) => q([...filters, ['eq', c, v]], ins, patch),
    is: (c, v) => q([...filters, ['eq', c, v]], ins, patch),
    in: (c, v) => q([...filters, ['in', c, v]], ins, patch),
    order: () => q(filters, ins, patch),
    limit: () => q(filters, ins, patch),
    select: async () => {
      const hit = rowsOf(name).filter((r) => filters.every(([op, c, v]) =>
        op === 'in' ? v.includes(r[c] ?? null) : (r[c] ?? null) === v));
      if (patch) hit.forEach((r) => Object.assign(r, patch));
      return { data: hit, error: null };
    },
    maybeSingle: async () => {
      const hit = rowsOf(name).filter((r) => filters.every(([op, c, v]) =>
        op === 'in' ? v.includes(r[c] ?? null) : (r[c] ?? null) === v));
      if (patch) hit.forEach((r) => Object.assign(r, patch));
      return { data: hit[0] ?? null, error: null };
    },
  });
  return {
    select: () => q([], null, null),
    update: (patch) => q([], null, patch),
    insert: (v) => ({
      select: async () => {
        const rows = rowsOf(name);
        // ★ id は **本物の UUID**。実装側が UUID_RE で弾くので、それらしい文字列では通らない。
        const row = { id: crypto.randomUUID(), created_at: nowIso(), ...v };
        if (name === 'shared_access_links') {
          if (LINKS.some((r) => r.token_hash === v.token_hash)) return { data: null, error: { message: 'unique' } };
          row.status = v.status ?? 'active';
          row.revoked_at = v.revoked_at ?? null;
          row.hidden_at = null;
        }
        if (name === 'shared_access_sessions') {
          row.consented_at = v.consented_at ?? null;
          row.revoked_at = null;
          row.viewer_id = v.viewer_id ?? null;
        }
        rows.push(row);
        return { data: [row], error: null };
      },
    }),
  };
}

export function getServerSupabase() { return { schema: () => ({ from: table, rpc: async (f, a) => rpc(f, a) }) }; }
export function getBridgeSupabase() { return null; }
export function isBridgeConfigured() { return false; }
`;
writeFileSync(resolve(ROOT, CACHE, 'share-supabase-stub.mjs'), STUB);
writeFileSync(resolve(ROOT, CACHE, 'share-astro-middleware-stub.mjs'),
  'export const defineMiddleware = (fn) => fn;\n');

await build({
  entryPoints: ['src/lib/share-access.ts', 'src/lib/viewer.ts', 'src/lib/write-guard.ts', 'src/middleware.ts'],
  bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
  define: { 'import.meta.env': '{"DEV":false}' },
  outdir: `${CACHE}/share`, outbase: 'src', outExtension: { '.js': '.mjs' },
  plugins: [{
    name: 'stub',
    setup(b) {
      b.onResolve({ filter: /(^|\/)supabase$/ }, () => ({
        path: pathToFileURL(resolve(ROOT, CACHE, 'share-supabase-stub.mjs')).href, external: true }));
      b.onResolve({ filter: /^astro:middleware$/ }, () => ({
        path: pathToFileURL(resolve(ROOT, CACHE, 'share-astro-middleware-stub.mjs')).href, external: true }));
    },
  }],
});

const sa = await import(`../${CACHE}/share/lib/share-access.mjs`);
const viewerMod = await import(`../${CACHE}/share/lib/viewer.mjs`);
const guard = await import(`../${CACHE}/share/lib/write-guard.mjs`);
const mw = await import(`../${CACHE}/share/middleware.mjs`);
const db = await import(`../${CACHE}/share-supabase-stub.mjs`);

const UID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const UID_B = 'bbbbbbbb-2222-4222-8222-222222222222';
db.USERS.add(UID_A); db.USERS.add(UID_B);

const HOUR = 3600_000;
const inHours = (h) => new Date(db.NOW + h * HOUR).toISOString();

/** 1 本発行して raw token を返す（下ごしらえ）。 */
async function issue(opts = {}) {
  return sa.createShareLink({
    targetUid: opts.targetUid ?? UID_A,
    expiresAt: opts.expiresAt ?? inHours(24 * 7),
    startsAt: opts.startsAt ?? null,
    label: opts.label ?? '助成金事務局 確認用',
    scope: opts.scope ?? { interview: true, scan: true },
  });
}

/** token → pending → 同意 まで一気に通して session raw を返す。 */
async function enter(token) {
  const started = await sa.startShareFromToken(token, db.NOW);
  if (!started) return null;
  const c = await sa.consumeSharePending(started.pending, 'viewer-1');
  return c ? c.session : null;
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 入場（token → pending → 同意 → session）
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n① 入場（§16 / §18）\n');
let SESSION_A = null;
{
  const iss = await issue();
  ok('S01 有効な共有 URL から pending を作れる', !!iss && !!(await sa.startShareFromToken(iss.token, db.NOW)));

  // ★ raw token は DB に無い（§15.1）
  ok('S24 raw token が DB に 1 列も無い（sha256 だけ）',
    db.LINKS.every((l) => !Object.values(l).includes(iss.token)));
  const tokHash = await sa.sha256hex(iss.token);
  ok('S24b token_hash は sha256(token) である',
    db.LINKS.some((l) => l.token_hash === tokHash));

  const st = await sa.startShareFromToken(iss.token, db.NOW);
  // ★ 同意前は consented_at が null（＝pending）
  const pend = db.SESSIONS.find((s) => s.consented_at == null);
  ok('S02 同意前のセッションは pending（consented_at is null）', !!pend);
  ok('S02b pending では resolveShareSession が通らない（健康情報を出せない）',
    (await sa.resolveShareSession(st.pending, db.NOW)) === null);

  const c1 = await sa.consumeSharePending(st.pending, 'viewer-1');
  ok('S03 同意で共有セッションが発行される', !!c1 && !!c1.session);
  ok('S03b pending をそのまま昇格させない（session fixation・§31 T-5）', c1.session !== st.pending);
  ok('S03c 同意後は pending の値では入れない',
    (await sa.resolveShareSession(st.pending, db.NOW)) === null);

  // ★ 二重 POST（§7）
  const c2 = await sa.consumeSharePending(st.pending, 'viewer-1');
  ok('S03d 同じ pending で 2 回同意しても 2 本目は失敗（原子的な consume）', c2 === null);

  const r = await sa.resolveShareSession(c1.session, db.NOW);
  ok('S04 解決結果が target を持つ（Cookie にも URL にも uid は入らない）', r?.targetUid === UID_A);
  ok('S04b ラベルが取れる（帯に出す・氏名ではない）', r?.label === '助成金事務局 確認用');
  SESSION_A = c1.session;
}

{
  // 期限は link を超えない（§18.1）
  db.reset();
  const iss = await issue({ expiresAt: inHours(1) });
  const s = await enter(iss.token);
  const r = await sa.resolveShareSession(s, db.NOW);
  ok('S05 セッションの期限が link の期限を超えない',
    Date.parse(r.expiresAt) <= Date.parse(iss.expiresAt));
}

{
  db.reset();
  const iss = await issue({ startsAt: inHours(24) });
  ok('S06 starts_at 前の link では入場できない',
    (await sa.startShareFromToken(iss.token, db.NOW)) === null);
}

{
  db.reset();
  ok('S07 存在しない token では入場できない',
    (await sa.startShareFromToken('a'.repeat(43), db.NOW)) === null);
  ok('S07b 字面が不正な token は DB を引く前に落とす',
    (await sa.startShareFromToken('short', db.NOW)) === null);
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 停止・失効・再発行（§27）— **毎リクエストで link 側を見る**
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n② 停止・失効・再発行（§27）\n');
{
  db.reset();
  const iss = await issue();
  const s = await enter(iss.token);
  ok('S19 有効なあいだは解決できる', (await sa.resolveShareSession(s, db.NOW)) !== null);

  await sa.setShareLinkStatus(iss.id, 'paused');
  ok('S20 paused にすると既存セッションが即座に使えない',
    (await sa.resolveShareSession(s, db.NOW)) === null);
  ok('S20b paused では新規入場もできない',
    (await sa.startShareFromToken(iss.token, db.NOW)) === null);

  await sa.setShareLinkStatus(iss.id, 'active');
  const s2 = await enter(iss.token);
  ok('S20c resume すると入場できる', (await sa.resolveShareSession(s2, db.NOW)) !== null);

  await sa.setShareLinkStatus(iss.id, 'revoked');
  ok('S21 revoked にすると使えない', (await sa.startShareFromToken(iss.token, db.NOW)) === null);
  ok('S22 revoke 後は既存セッションも次のリクエストから使えない',
    (await sa.resolveShareSession(s2, db.NOW)) === null);
}

{
  db.reset();
  const iss = await issue();
  const s = await enter(iss.token);
  const re = await sa.regenerateShareLink(iss.id);
  ok('S23 再発行すると旧 token が使えない',
    !!re && (await sa.startShareFromToken(iss.token, db.NOW)) === null);
  ok('S23b 再発行すると旧セッションも切れる', (await sa.resolveShareSession(s, db.NOW)) === null);
  ok('S23c 新 token では入場できる', !!(await sa.startShareFromToken(re.token, db.NOW)));
  ok('S23d 新 token は旧 token と別物', re.token !== iss.token);
}

{
  db.reset();
  const iss = await issue({ expiresAt: inHours(1) });
  const s = await enter(iss.token);
  ok('S19b 期限内は解決できる', (await sa.resolveShareSession(s, db.NOW)) !== null);
  ok('S19c 期限を過ぎたら解決できない',
    (await sa.resolveShareSession(s, db.NOW + 2 * HOUR)) === null);
}

{
  db.reset();
  const iss = await issue();
  const s = await enter(iss.token);
  await sa.endShareSession(s);
  ok('S31b /share/end 相当でセッションが失効する',
    (await sa.resolveShareSession(s, db.NOW)) === null);
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ viewer の優先順位と書き込み先（§24 / §17）
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n③ viewer の優先順位と書き込み先（§24 / §17）\n');

/** `resolveViewer` を Cookie 無し + locals で呼ぶための最小 ctx。 */
function ctxWith(locals, cookieMap = {}, url = 'https://app.example.com/dashboard') {
  return {
    request: new Request(url),
    cookies: { get: (n) => (cookieMap[n] ? { value: cookieMap[n] } : undefined) },
    locals,
  };
}
const SHARE_LOCAL = {
  share: {
    linkId: 'l1', sessionId: 's1', targetUid: UID_A, targetOrigin: 'production',
    scope: { view: true, interview: true, scan: true }, label: 'X', expiresAt: inHours(8), viewerId: 'v1',
  },
};

{
  const v = await viewerMod.resolveViewer(ctxWith(SHARE_LOCAL));
  ok('W3 share では writeTargetUid が target', v.kind === 'share' && v.writeTargetUid === UID_A);
  ok('S/C2 share は isAdmin=false 固定', v.isAdmin === false);
  ok('C4 share では selfUid が null（共有相手は本人ではない）', v.selfUid === null);
  ok('S32b 帯に出すラベルを viewer が持つ', v.shareLabel === 'X');
  ok('G targetLocked が立つ', v.targetLocked === true);
}

{
  // ★ `?u=<別UID>` で target が変わらない（§25 / S14）
  const v = await viewerMod.resolveViewer(
    ctxWith(SHARE_LOCAL, {}, `https://app.example.com/dashboard?u=${UID_B}`));
  ok('S14 share 中に ?u=<別UID> を付けても target が変わらない', v.uid === UID_A);
}

{
  // ★ 本人 Cookie があっても share が勝つ（§24.2 / C1）
  const signed = await viewerMod.signViewer(UID_B, false);
  const v = await viewerMod.resolveViewer(ctxWith(SHARE_LOCAL, { welltect_v: signed }));
  ok('C1 welltect_v があっても share が勝つ', v.kind === 'share' && v.uid === UID_A);

  const signedAdmin = await viewerMod.signViewer(UID_B, true);
  const v2 = await viewerMod.resolveViewer(ctxWith(SHARE_LOCAL, { welltect_v: signedAdmin }));
  ok('C2 admin の welltect_v があっても share が勝ち isAdmin=false',
    v2.kind === 'share' && v2.isAdmin === false);

  // ★ 共有が終われば本人へ戻る
  const v3 = await viewerMod.resolveViewer(ctxWith({}, { welltect_v: signed }));
  ok('C3/C4b share が無ければ本人（self）へ戻る', v3.kind === 'self' && v3.uid === UID_B);
}

{
  // ★ 通常利用者の挙動が変わらない（W1）
  const signed = await viewerMod.signViewer(UID_B, false);
  const v = await viewerMod.resolveViewer(ctxWith({}, { welltect_v: signed }));
  ok('W1 self では writeTargetUid === selfUid', v.writeTargetUid === v.selfUid && v.selfUid === UID_B);
  ok('W1b self では shareScope が null', v.shareScope === null);
  ok('S26 未サインインは anonymous のまま',
    (await viewerMod.resolveViewer(ctxWith({}))).kind === 'anonymous');
}

{
  // ★ 代理表示は書けない（W2）
  const v = await viewerMod.resolveViewer(ctxWith({
    adminView: { ctx: 'c1', targetUid: UID_A, targetOrigin: 'production',
      adminIdentity: 'i', adminSelfUid: UID_B, expiresAt: inHours(1) },
  }));
  ok('W2 代理表示では writeTargetUid が null', v.writeTargetUid === null);
  ok('W2b 代理表示は write-guard が 403', guard.denyReadOnlyWrite(v)?.status === 403);
  ok('W2c 代理表示は順序 1（share より先）', v.kind === 'admin_impersonation');
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ write-guard（§17.2 / §17.5 / §21.4）
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n④ write-guard（§17.2 / §17.5 / §21.4）\n');
{
  const share = { kind: 'share', writeTargetUid: UID_A, shareScope: { view: true, interview: true, scan: true } };
  const shareRO = { kind: 'share', writeTargetUid: UID_A, shareScope: { view: true, interview: false, scan: false } };
  const self = { kind: 'self', writeTargetUid: UID_B, shareScope: null };
  const anon = { kind: 'anonymous', writeTargetUid: null, shareScope: null };

  ok('S29/S30/S31 denyForShare は share を 403 にする', guard.denyForShare(share)?.status === 403);
  ok('S29b denyForShare は self を通す', guard.denyForShare(self) === null);
  ok('S29c denyForShare は anonymous を通す（別の番人の仕事）', guard.denyForShare(anon) === null);

  ok('F scope に interview があれば通す', guard.denyUnlessShareScope(share, 'interview') === null);
  ok('F-2 scope に無ければ 403', guard.denyUnlessShareScope(shareRO, 'interview')?.status === 403);
  ok('F-3 scope に無ければ scan も 403', guard.denyUnlessShareScope(shareRO, 'scan')?.status === 403);
  ok('F-4 share 以外では scope 検査は何もしない', guard.denyUnlessShareScope(self, 'scan') === null);

  ok('W8 anonymous は 401', guard.denyAnonymous(anon)?.status === 401);
  ok('W8b share は通す（共有相手はスキャン・問診を使う）', guard.denyAnonymous(share) === null);
  ok('W8c self は通す', guard.denyAnonymous(self) === null);

  ok('B11 share は read-only ではない（書ける主体）', guard.isReadOnlyViewer(share) === false);
  ok('B11b 代理表示は read-only',
    guard.isReadOnlyViewer({ kind: 'admin_impersonation', writeTargetUid: null }) === true);
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ middleware（admin 系の遮断・§21.2 / §25）
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n⑤ middleware（§21.2 / §25）\n');
{
  db.reset();
  const iss = await issue();
  const session = await enter(iss.token);

  const run = async (path) => {
    const locals = {};
    const ctx = {
      request: new Request(`https://app.example.com${path}`),
      cookies: { get: (n) => (n === 'welltect_share_v' ? { value: session } : undefined) },
      locals,
    };
    let passed = false;
    const res = await mw.onRequest(ctx, async () => { passed = true; return new Response('ok'); });
    return { status: res?.status ?? 200, passed, locals };
  };

  for (const p of ['/admin/customers', '/api/admin/share-links', '/api/cron/scan-worker',
                   '/api/ops/probe-bat', '/api/debug/viewer']) {
    const r = await run(p);
    ok(`S18 share から ${p} は 403`, r.status === 403 && !r.passed);
  }

  const d = await run('/dashboard');
  ok('S18b share でも通常ページは通る', d.passed && d.locals.share?.targetUid === UID_A);

  const logged = db.LOGS.filter((l) => l.event_type === 'blocked_admin_access').length;
  ok('S18c 遮断はアクセス記録に残る（blocked_admin_access）', logged >= 5);
  ok('S/§26 閲覧も記録される（dashboard_view）',
    db.LOGS.some((l) => l.event_type === 'dashboard_view'));
  ok('S24c ログに raw token も raw IP も入っていない',
    db.LOGS.every((l) => !JSON.stringify(l).includes(iss.token)));
  ok('S24d ログの path に UID が入っていない',
    db.LOGS.every((l) => !String(l.path ?? '').includes(UID_A)));
}

{
  // ★ share Cookie が無ければ 1 バイトも触らない（既存の挙動が不変）
  const locals = {};
  let passed = false;
  await mw.onRequest({
    request: new Request('https://app.example.com/api/admin/share-links'),
    cookies: { get: () => undefined }, locals,
  }, async () => { passed = true; return new Response('ok'); });
  ok('L share Cookie が無ければ admin API は素通し（挙動不変）', passed && !locals.share);
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ ソース検査（紙の上でしか守れない約束）
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n⑥ ソース検査（§19 / §20 / §21 / §24.4）\n');

const WRITE_APIS = [
  'src/pages/api/scan/save.ts',
  'src/pages/api/scan/jobs.ts',
  'src/pages/api/scan/export.ts',
  'src/pages/api/interview/export.ts',
  'src/pages/api/kit/[id]/self-report.ts',
  'src/pages/api/notices/[id]/read.ts',
];
for (const f of WRITE_APIS) {
  const src = code(f);
  ok(`W4 ${f} が viewer.selfUid を保存先に使っていない`, !/viewer\.selfUid/.test(src),
    'share では selfUid が null なので 1 行も保存されない');
  ok(`W7 ${f} が resolveViewer を通っている`, /resolveViewer\s*\(/.test(src));
}

// ★ body の uid を保存先／認可根拠にしていない（§11 の 7 件が消えたこと）
for (const f of WRITE_APIS) {
  const src = code(f);
  /*
   * **「body の uid が書き込み先の変数へ入る」形**を見る。
   * `str(body.diagnosticUserId)` のように関数で包まれても拾えるようにする
   * （最初これを拾えず、退行注入 ② が素通りした）。
   */
  const badBody =
    /(?:const|let|var)\s+(?:diagnosticUserId|uid|clientId|targetUid|userId)\s*=[^;]*\bbody\b[^;]*(?:diagnosticUserId|clientId)/
      .test(src);
  ok(`W5 ${f} が body.diagnosticUserId を採用していない`, !badBody);
}

{
  const src = code('src/pages/api/interview/export.ts');
  ok('W6 interview/export が body の dateOfBirth / sex を採用していない',
    !/dateOfBirth:\s*str\(body/.test(src) && !/sex:\s*str\(body/.test(src));
  ok('S33 profile はサーバ側 resolver から取る', /resolveTargetSubject\s*\(/.test(src));
  ok('S11 完了記録の保存先が writeTargetUid',
    /recordInterviewCompletion\(\s*targetUid/.test(src));
  ok('S11b S3 の client_id も writeTargetUid',
    /clientId:\s*targetUid/.test(src) && /diagnosticUserId:\s*targetUid/.test(src));
}

{
  const src = code('src/pages/api/scan/export.ts');
  ok('S13/S17 scan/export の書き出し先が writeTargetUid',
    /const\s+diagnosticUserId\s*=\s*viewer\.writeTargetUid/.test(src));
  ok('P0-7 食い違いを target_tamper_attempt として記録', /target_tamper_attempt/.test(src));
}

// ★ §21.4 の 6 本が未認証を塞いでいる
const UNAUTH_APIS = [
  'src/pages/api/scan.ts',
  'src/pages/api/scan/upload-ticket.ts',
  'src/pages/api/interview/classify-voice.ts',
  'src/pages/api/live-token.ts',
  'src/pages/api/insight.ts',
  'src/pages/api/coach/ask.ts',
];
for (const f of UNAUTH_APIS) {
  const src = code(f);
  ok(`W8/§21.4 ${f} が denyAnonymous を通している`, /denyAnonymous\s*\(/.test(src));
}

{
  const src = code('src/pages/api/live-token.ts');
  ok('§19.4 live-token が body の diagnosticUserId を読まない',
    !/body[.?[]/.test(src) || !/diagnosticUserId/.test(src.split('viewer.uid')[0] ?? ''));
  ok('§19.4b live-token の対象は viewer.uid', /const\s+diagnosticUserId\s*=\s*viewer\.uid/.test(src));
}

// ★ share で BLOCK する 5 本
for (const f of ['src/pages/api/kit/[id]/self-report.ts', 'src/pages/api/notices/[id]/read.ts',
                 'src/pages/api/auth/resolve.ts', 'src/pages/api/auth/signout.ts',
                 'src/pages/api/auth/refresh-admin.ts']) {
  ok(`S29〜S31 ${f} が denyForShare を通している`, /denyForShare\s*\(/.test(code(f)));
}

{
  // ★ /share/end は共有 Cookie だけを消す（§17.5）
  const src = code('src/pages/share/end.ts');
  ok('S31c /share/end が welltect_v を消さない', !/VIEWER_COOKIE|welltect_v['"]/.test(src));
  ok('S31d /share/end が welltect_admin_v を消さない', !/ADMIN_COOKIE|welltect_admin_v/.test(src));
  ok('S31e /share/end が共有 Cookie を消す',
    /cookies\.delete\(SHARE_COOKIE/.test(src) && /cookies\.delete\(SHARE_PENDING_COOKIE/.test(src));
}

{
  // ★ 帯（§24.4 / S32）
  ok('S32 ShareBanner が存在する', existsSync(resolve(ROOT, 'src/components/ShareBanner.astro')));
  const layout = read('src/layouts/BaseLayout.astro');
  ok('S32b BaseLayout が帯を出す（全ページに 1 回だけ）',
    /<ShareBanner\b/.test(layout) && /Astro\.locals\.share/.test(layout));
  const banner = read('src/components/ShareBanner.astro');
  ok('S32c 帯に終了ボタンがある', /\/share\/end/.test(banner));
  ok('S32d 帯に対象者の uid を出さない', !/targetUid/.test(banner));
}

{
  // ★ 同意前に健康情報を出さない（§16.1 / S2）
  const entry = read('src/pages/share/[token].astro');
  ok('S02c /share/<token> はダッシュボードを描かず 302 する',
    /Astro\.redirect\('\/share\/consent'/.test(entry) && !/loadDashboard|BaseLayout/.test(entry));
  const consent = read('src/pages/share/consent.astro');
  ok('S02d 同意画面が検査データを読まない',
    !/loadDashboard|buildReportVM|getResultData|measurement/.test(consent));
  ok('S02e 同意画面が対象者の氏名を出さない', !/displayName|customer_profiles/.test(consent));
}

{
  /*
   * ★ 失敗の理由を出し分けない（§16.3）。
   * **コメントは除いて**本文だけを見る（設計意図の説明に理由名が出るのは当然なので）。
   * 見るのは ①理由ごとの文言が無いこと ②理由を受け取る口が無いこと の 2 つ。
   */
  const un = code('src/pages/share/unavailable.astro');
  for (const w of ['停止中', '一時停止', '失効', 'revoked', 'paused', '見つかりません']) {
    ok(`S07c /share/unavailable が「${w}」を表示しない`, !un.includes(w));
  }
  ok('S07d /share/unavailable が理由を受け取らない（クエリ・props を見ない）',
    !/searchParams|Astro\.props|reason/.test(un));
  ok('S07e /share/unavailable が DB を引かない（存在確認の口にしない）',
    !/getServerSupabase|resolveShareSession|classifyShareFailure/.test(un));
}

{
  // ★ 全ページ no-store（§S25）
  for (const f of ['src/pages/share/[token].astro', 'src/pages/share/consent.astro',
                   'src/pages/share/unavailable.astro']) {
    ok(`S25 ${f} が no-store`, /no-store|noStore\(/.test(read(f)));
  }
  ok('S25b consent API が no-store', /no-store/.test(read('src/pages/api/share/consent.ts')));
}

{
  // ★ raw を保存しない（§15 / §22）— DDL の構造検査
  const ddl = read('supabase/migrations/20260930000020_shared_access.sql');
  ok('S24e links に raw token 列が無い', !/\btoken\s+text/.test(ddl) && /token_hash\s+text not null unique/.test(ddl));
  ok('S24f sessions に raw session 列が無い',
    !/\bsession\s+text/.test(ddl) && /session_digest\s+text not null unique/.test(ddl));
  ok('S24g logs は ip_hmac で raw IP を持たない', /ip_hmac/.test(ddl) && !/\bip_address\b/.test(ddl));
  ok('§22.6 3 表とも RLS 有効', (ddl.match(/enable row level security/g) ?? []).length === 3);
  ok('§22.6b anon / authenticated に権限を出さない',
    (ddl.match(/revoke all on diagnosis\.shared_access_\w+\s+from anon, authenticated/g) ?? []).length === 3);
  ok('§22.6c ポリシーを 1 つも作らない', !/create policy/i.test(ddl));

  const rpcSql = read('supabase/migrations/20260930000030_share_consent_rpc.sql');
  ok('§7 consume の条件に consented_at is null がある', /s\.consented_at\s+is null/.test(rpcSql));
  ok('§7b consume が link の status を見る', /l\.status\s*=\s*'active'/.test(rpcSql));
  ok('§7c consume が link の期限で clamp する', /least\(/.test(rpcSql));
  ok('§7d RPC は service_role にしか出さない',
    /revoke all on function diagnosis\.consume_share_pending/.test(rpcSql));
}

{
  // ★ 順序（§24.1）— share は self より前、代理表示より後
  const v = code('src/lib/viewer.ts');
  const iAdminView = v.indexOf('locals?.adminView');
  const iShare = v.indexOf("kind: 'share'");
  const iSelf = v.indexOf('if (!verified)');
  const iLegacy = v.indexOf("kind: 'admin_impersonation_legacy'");
  ok('§24.1 順序 1: 代理表示が share より前', iAdminView > 0 && iAdminView < iShare);
  ok('§24.1 順序 2: share が self より前', iShare > 0 && iShare < iSelf);
  ok('§24.1 順序 3: share が legacy ?u= より前', iShare < iLegacy);
}

{
  // ★ 代理表示を Cookie 方式へ戻していない（W9）
  const all = ['src/lib/viewer.ts', 'src/middleware.ts', 'src/lib/admin-impersonation.ts']
    .map((f) => code(f)).join('\n');
  ok('W9 welltect_imp_v を発行・参照するコードが 0 件', !/welltect_imp_v/.test(all));
}

{
  // ★ scan.astro が ?u= を読まない（§20.3）
  ok('S14b scan.astro が location.search の u を読まない',
    !/search\)\.get\('u'\)/.test(code('src/pages/scan.astro')));
  ok('§19.4c chat.astro が uid を DOM へ埋めない',
    !/data-diagnostic-user-id=/.test(code('src/pages/chat.astro')));
  ok('§19.4d live-controller が uid を送らない',
    !/diagnosticUserId:\s*(?:refs\.|opts\.)/.test(code('src/scripts/chat/live-controller.ts')));
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 退行注入（検査が本当に落ちるか）
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n⑦ 退行注入（§34.2）\n');
{
  /** 実ファイルを一時的に書き換えて、上と同じ検査が落ちることを見る。 */
  const inject = (file, from, to, probe) => {
    const p = resolve(ROOT, file);
    const orig = readFileSync(p, 'utf8');
    if (!orig.includes(from)) return { hit: false, caught: false };
    try {
      writeFileSync(p, orig.replace(from, to));
      return { hit: true, caught: probe() };
    } finally {
      writeFileSync(p, orig);
    }
  };

  const cases = [
    ['① viewer.selfUid へ戻す（S17/W4）', 'src/pages/api/scan/save.ts',
      'const uid = viewer.writeTargetUid;', 'const uid = viewer.selfUid;',
      () => /viewer\.selfUid/.test(code('src/pages/api/scan/save.ts'))],
    ['② body.diagnosticUserId を採用する（W5）', 'src/pages/api/scan/export.ts',
      'const diagnosticUserId = viewer.writeTargetUid;',
      'const diagnosticUserId = str(body.diagnosticUserId);',
      () => /(?:const|let|var)\s+(?:diagnosticUserId|uid|clientId|targetUid|userId)\s*=[^;]*\bbody\b[^;]*(?:diagnosticUserId|clientId)/
        .test(code('src/pages/api/scan/export.ts'))],
    ['③ denyForShare を外す（S29）', 'src/pages/api/kit/[id]/self-report.ts',
      'const shared = denyForShare(viewer);', 'const shared = null;',
      () => !/denyForShare\s*\(/.test(code('src/pages/api/kit/[id]/self-report.ts'))],
    ['④ scope 検査を外す（F-2）', 'src/pages/api/scan/jobs.ts',
      "const scoped = denyUnlessShareScope(viewer, 'scan');", 'const scoped = null;',
      () => !/denyUnlessShareScope\s*\(/.test(code('src/pages/api/scan/jobs.ts'))],
    ['⑤ denyAnonymous を外す（W8）', 'src/pages/api/live-token.ts',
      'const unauth = denyAnonymous(viewer);', 'const unauth = null;',
      () => !/denyAnonymous\s*\(/.test(code('src/pages/api/live-token.ts'))],
    ['⑥ 帯を消す（S32）', 'src/layouts/BaseLayout.astro',
      '<ShareBanner active={share !== null}', '<span data-removed={share !== null}',
      () => !/<ShareBanner\b/.test(read('src/layouts/BaseLayout.astro'))],
    ['⑦ consent API を消す（P0-1）', 'src/pages/api/share/consent.ts',
      'export const POST', 'const REMOVED_POST',
      () => !/export const POST/.test(read('src/pages/api/share/consent.ts'))],
  ];
  for (const [label, file, from, to, probe] of cases) {
    const r = inject(file, from, to, probe);
    ok(`退行注入 ${label} で検査が落ちる`, r.hit && r.caught,
      r.hit ? '注入しても検査が通ってしまった' : `注入点が見つからない (${file})`);
  }

  // ★ SQL 側の退行（link の status を見ないようにする）は実物を動かして見る。
  db.reset();
  const iss = await issue();
  const s = await enter(iss.token);
  await sa.setShareLinkStatus(iss.id, 'paused');
  ok('退行注入 ⑧ link 側を見ずセッションだけ見ると paused が効かない（今は効いている）',
    (await sa.resolveShareSession(s, db.NOW)) === null);
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log(`\n${fails.length === 0 ? '✅ すべて PASS' : `❌ ${fails.length} 件 FAIL`}\n`);
for (const f of fails) console.log(`  - ${f}`);
process.exit(fails.length === 0 ? 0 : 1);
