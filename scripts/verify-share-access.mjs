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
  entryPoints: ['src/lib/share-access.ts', 'src/lib/viewer.ts', 'src/lib/write-guard.ts',
    'src/lib/admin-identity.ts', 'src/middleware.ts'],
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
const ident = await import(`../${CACHE}/share/lib/admin-identity.mjs`);
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
    createdBy: opts.createdBy ?? null,
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
 * ⑥-2 scope.interview の実効性（§17.2・2026-09-30 のレビュー）
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n⑥-2 scope.interview が本当に効くか（§17.2）\n');
{
  /*
   * **「AI 問診の利用を許可」を外した共有リンクで、問診が始められないこと。**
   * `interview/export`（終わり側）だけ閉じても、**`/api/live-token`（始め側）が
   * 開いていれば設定が意味を失う** — しかもあの口は Gemini Live token（課金）と
   * `userProfile`（PII）まで返す。
   */
  const OFF = { kind: 'share', writeTargetUid: UID_A, shareScope: { view: true, interview: false, scan: true } };
  const ON  = { kind: 'share', writeTargetUid: UID_A, shareScope: { view: true, interview: true,  scan: false } };
  const SELF = { kind: 'self', writeTargetUid: UID_B, shareScope: null };
  const ADMIN_SELF = { kind: 'admin_self', writeTargetUid: UID_B, shareScope: null };

  ok('IV-1 interview=false は 403（番人の判定）', guard.denyUnlessShareScope(OFF, 'interview')?.status === 403);
  ok('IV-2 interview=true は通る', guard.denyUnlessShareScope(ON, 'interview') === null);
  ok('IV-3 self には影響しない', guard.denyUnlessShareScope(SELF, 'interview') === null);
  ok('IV-4 admin 自己利用にも影響しない', guard.denyUnlessShareScope(ADMIN_SELF, 'interview') === null);

  // ★ 3 本すべてが interview scope を通していること（1 本でも漏れると設定が破れる）
  for (const f of ['src/pages/api/live-token.ts',
                   'src/pages/api/interview/classify-voice.ts',
                   'src/pages/api/interview/export.ts']) {
    ok(`IV-5 ${f} が denyUnlessShareScope(…, 'interview') を通している`,
      /denyUnlessShareScope\(\s*viewer,\s*'interview'\s*\)/.test(code(f)));
  }
  // ★ scan 側の scope と取り違えていないこと
  ok("IV-6 live-token が 'scan' ではなく 'interview' を見ている",
    !/denyUnlessShareScope\(\s*viewer,\s*'scan'\s*\)/.test(code('src/pages/api/live-token.ts')));

  // ★ UI も閉じている（押せるのに 403、にしない）
  const chat = code('src/pages/chat.astro');
  ok('IV-7 chat.astro が scope.interview を見る',
    /viewer\.shareScope\?\.interview\s*===\s*true/.test(chat));
  ok('IV-8 chat.astro は share 以外を常に許可する（self / admin は挙動不変）',
    /viewer\.kind\s*!==\s*'share'\s*\|\|/.test(chat));
  ok('IV-9 許可されない回は問診を起動しない',
    /dataset\.interviewAllowed === '0'/.test(chat) && /return;/.test(chat));
  ok('IV-10 許可されない回は理由を画面に出す（行き止まりにしない）',
    /この共有リンクでは AI 問診をご利用いただけません/.test(read('src/pages/chat.astro')));
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥-3 revoke は不可逆（§27.2・2026-09-30 のレビュー）
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n⑥-3 revoke は不可逆（§27.2）\n');
{
  db.reset();
  const iss = await issue();
  const s = await enter(iss.token);
  ok('RV-1 revoke 前は使える', (await sa.resolveShareSession(s, db.NOW)) !== null);

  ok('RV-2 revoke は成功する', (await sa.setShareLinkStatus(iss.id, 'revoked')) === true);
  ok('RV-3 revoke 後は元 token が使えない', (await sa.startShareFromToken(iss.token, db.NOW)) === null);

  // ★ ここが本命: admin API へ直接 resume を投げても戻らない
  ok('RV-4 revoked → resume は拒否される（false）', (await sa.setShareLinkStatus(iss.id, 'active')) === false);
  ok('RV-5 拒否のあとも status は revoked のまま',
    db.LINKS.find((l) => l.id === iss.id)?.status === 'revoked');
  ok('RV-6 拒否のあとも元 token は使えない', (await sa.startShareFromToken(iss.token, db.NOW)) === null);
  ok('RV-7 revoked → pause も拒否される', (await sa.setShareLinkStatus(iss.id, 'paused')) === false);
  ok('RV-8 revoked → revoke（2 度目）も成功にしない', (await sa.setShareLinkStatus(iss.id, 'revoked')) === false);

  // ★ regenerate も戻せない
  ok('RV-9 revoked → regenerate は拒否される（null）', (await sa.regenerateShareLink(iss.id)) === null);
  const row = db.LINKS.find((l) => l.id === iss.id);
  ok('RV-10 拒否のあとも revoked_at が消えていない', !!row?.revoked_at);
  ok('RV-11 拒否のあとも status は revoked のまま', row?.status === 'revoked');

  // ★ hide / unhide / ログは revoked でも可（アクセス可否の話ではない）
  ok('RV-12 revoked でも一覧から隠せる', (await sa.setShareLinkHidden(iss.id, true)) === true);
  ok('RV-13 revoked でも一覧へ戻せる', (await sa.setShareLinkHidden(iss.id, false)) === true);

  // ★ 許される遷移は通る
  db.reset();
  const a = await issue();
  ok('RV-14 active → pause は通る', (await sa.setShareLinkStatus(a.id, 'paused')) === true);
  ok('RV-15 paused → pause（2 度目）は成功にしない', (await sa.setShareLinkStatus(a.id, 'paused')) === false);
  ok('RV-16 paused → resume は通る', (await sa.setShareLinkStatus(a.id, 'active')) === true);
  ok('RV-17 active → resume（2 度目）は成功にしない', (await sa.setShareLinkStatus(a.id, 'active')) === false);
  ok('RV-18 paused → regenerate は通る',
    (await sa.setShareLinkStatus(a.id, 'paused')) === true && !!(await sa.regenerateShareLink(a.id)));

  // ★ 存在しない id を成功として返さない
  const GHOST = 'cccccccc-3333-4333-8333-333333333333';
  ok('RV-19 存在しない id の pause は false', (await sa.setShareLinkStatus(GHOST, 'paused')) === false);
  ok('RV-20 存在しない id の resume は false', (await sa.setShareLinkStatus(GHOST, 'active')) === false);
  ok('RV-21 存在しない id の revoke は false', (await sa.setShareLinkStatus(GHOST, 'revoked')) === false);
  ok('RV-22 存在しない id の regenerate は null', (await sa.regenerateShareLink(GHOST)) === null);
  ok('RV-23 存在しない id の hide は false', (await sa.setShareLinkHidden(GHOST, true)) === false);

  // ★ 構造: 遷移表と「1 行だけ更新された」の確認がコードに在ること
  const src = code('src/lib/share-access.ts');
  ok('RV-24 遷移を WHERE 条件で固定している（status の in 絞り）',
    /\.in\('status',\s*STATUS_TRANSITIONS\[status\]\)/.test(src));
  ok('RV-25 regenerate も生きている状態だけを通す',
    /\.in\('status',\s*\['active',\s*'paused'\]\)/.test(src));
  ok('RV-26 error == null だけで成功扱いしない（1 行を確認）',
    (src.match(/data\.length !== 1/g) ?? []).length >= 2);
  ok('RV-27 regenerate が revoked_at を null に戻さない', !/revoked_at:\s*null/.test(src));
  ok('RV-28 linkUsable が revoked_at も見る', /if \(row\.revoked_at\) return false;/.test(src));
  const rpc2 = read('supabase/migrations/20260930000050_share_consent_rpc_revoked.sql');
  ok('RV-29 同意の 1 文でも revoked_at を見る', /l\.revoked_at\s+is null/.test(rpc2));
  const api = code('src/pages/api/admin/share-links.ts');
  ok('RV-30 admin API は失敗を 409 で返す（200 で黙らない）', /not_allowed/.test(api) && /409\)/.test(api));
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥-4 created_by に生 email を入れない（§38-U9・2026-09-30 のレビュー）
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n⑥-4 created_by は HMAC digest（§38-U9）\n');
{
  db.reset();
  const EMAIL = 'Admin.One@Example.com';
  const digest = await ident.adminIdentity(EMAIL);
  const iss = await issue({ createdBy: digest });
  const row = db.LINKS.find((l) => l.id === iss.id);

  ok('CB-1 created_by に @ が含まれない', !String(row?.created_by ?? '').includes('@'));
  ok('CB-2 created_by が raw email と一致しない', row?.created_by !== EMAIL
    && row?.created_by !== EMAIL.toLowerCase());
  ok('CB-3 created_by が adminIdentity(email) と一致する', row?.created_by === digest);

  // ★ 生 email を渡されても**保存しない**（最後の関所）
  const iss2 = await issue({ createdBy: EMAIL });
  const row2 = db.LINKS.find((l) => l.id === iss2.id);
  ok('CB-4 生 email を渡されたら null にする（切り詰めない）', row2?.created_by === null);

  // ★ 行のどこにも生 email が無い
  ok('CB-5 link の行全体に @ を含む値が無い',
    db.LINKS.every((l) => !Object.values(l).some((v) => typeof v === 'string' && v.includes('@'))));

  // ★ 構造: admin API が HMAC に通してから渡す / 中継は created_by を送らない
  const api = code('src/pages/api/admin/share-links.ts');
  ok('CB-6 admin API が adminIdentity() を通してから渡す',
    /createdBy:\s*await adminIdentity\(/.test(api));
  ok('CB-7 admin API が body の created_by をそのまま使わない', !/c\.created_by\b(?!_email)/.test(api));
  const lib = code('src/lib/share-access.ts');
  ok('CB-8 createShareLink が @ を含む値を捨てる', /!args\.createdBy\.includes\('@'\)/.test(lib));
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥-5 アクセス記録（§26.1・2026-09-30 のレビュー）
 *
 * **`*_use` は「実際に使った」こと。ページを開いただけでは記録しない。**
 * **API の記録は link / session / viewer に紐付ける** — 紐付かないと
 * admin のアクセス記録（`share_link_id` で絞る）に 1 件も出てこない。
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n⑥-5 アクセス記録（§26.1）\n');
{
  db.reset();
  const A = await issue({ label: 'link A' });
  const B = await issue({ label: 'link B' });
  const sessA = await enter(A.token);
  const shA = await sa.resolveShareSession(sessA, db.NOW);

  /** middleware を 1 リクエストぶん通す。 */
  const visit = async (path) => {
    const locals = {};
    await mw.onRequest({
      request: new Request(`https://app.example.com${path}`),
      cookies: { get: (n) => (n === 'welltect_share_v' ? { value: sessA } : undefined) },
      locals,
    }, async () => new Response('ok'));
    return locals;
  };
  const count = (ev, linkId) =>
    db.LOGS.filter((l) => l.event_type === ev && (linkId === undefined || l.share_link_id === linkId)).length;

  // ★ ページを開いただけでは「利用」にしない
  await visit('/chat');
  ok('LG-1 /chat を開いただけでは chat_use が 0', count('chat_use') === 0);
  await visit('/scan');
  ok('LG-2 /scan を開いただけでは scan_use が 0', count('scan_use') === 0);

  // ★ 閲覧は閲覧として残る
  await visit('/dashboard');
  ok('LG-3 /dashboard は dashboard_view として残る', count('dashboard_view') === 1);
  await visit('/report');
  ok('LG-4 /report は report_view として残る', count('report_view') === 1);

  /** API の記録（`locals.share` から紐付ける）。 */
  const apiCtx = (path) => ({
    request: new Request(`https://app.example.com${path}`),
    locals: { share: shA },
  });

  await sa.logShareApiEvent(apiCtx('/api/live-token'), 'chat_use', '/api/live-token');
  ok('LG-5 live-token を呼ぶと link A の chat_use が 1', count('chat_use', A.id) === 1);
  ok('LG-6 その記録に session_id が入っている',
    db.LOGS.some((l) => l.event_type === 'chat_use' && l.session_id === shA.sessionId));
  ok('LG-7 その記録に viewer_id が入っている',
    db.LOGS.some((l) => l.event_type === 'chat_use' && l.viewer_id === shA.viewerId));

  await sa.logShareApiEvent(apiCtx('/api/scan/save'), 'scan_use', '/api/scan/save');
  ok('LG-8 scan/save を呼ぶと link A の scan_use が 1', count('scan_use', A.id) === 1);

  await sa.logShareApiEvent(apiCtx('/api/interview/export'), 'target_tamper_attempt', '/api/interview/export');
  ok('LG-9 target_tamper_attempt が link A の記録に出る', count('target_tamper_attempt', A.id) === 1);
  ok('LG-10 link B の記録には出ない', count('target_tamper_attempt', B.id) === 0);

  // ★ admin の一覧が実際にその記録を引けること（null 紐付けだと 0 件になる）
  const logsA = await sa.listShareLogs(A.id);
  const logsB = await sa.listShareLogs(B.id);
  ok('LG-11 admin の記録一覧（link A）に利用ログが出る',
    logsA.some((l) => l.event_type === 'chat_use') && logsA.some((l) => l.event_type === 'scan_use'));
  ok('LG-12 admin の記録一覧（link B）には出ない', logsB.length === 0);
  ok('LG-13 link_id が null の行を作っていない',
    db.LOGS.filter((l) => l.event_type.endsWith('_use')).every((l) => !!l.share_link_id));

  // ★ share でなければ何も書かない（本人・admin の操作を混ぜない）
  const before = db.LOGS.length;
  await sa.logShareApiEvent({ request: new Request('https://app.example.com/api/scan/save'), locals: {} },
    'scan_use', '/api/scan/save');
  ok('LG-14 share でなければ 1 行も書かない', db.LOGS.length === before);

  // ★ 構造: middleware が `*_use` を持たない / API 側が helper を使っている
  const mwSrc = code('src/middleware.ts');
  ok('LG-15 middleware の閲覧表に chat_use / scan_use が無い',
    !/'\/chat':\s*'chat_use'/.test(mwSrc) && !/'\/scan':\s*'scan_use'/.test(mwSrc));
  for (const [f, ev] of [
    ['src/pages/api/live-token.ts', 'chat_use'],
    ['src/pages/api/interview/export.ts', 'chat_use'],
    ['src/pages/api/scan/save.ts', 'scan_use'],
    ['src/pages/api/scan/jobs.ts', 'scan_use'],
  ]) {
    ok(`LG-16 ${f} が logShareApiEvent(…, '${ev}', …) で記録する`,
      new RegExp(`logShareApiEvent\\([^)]*'${ev}'`).test(code(f)));
  }
  ok('LG-17 scan/export は scan_use を二重に記録しない',
    !/logShareApiEvent\([^)]*'scan_use'/.test(code('src/pages/api/scan/export.ts')));
  // ★ ID をクライアントから受け取っていない
  ok('LG-18 helper は locals.share からだけ紐付ける（body を見ない）',
    /ctx\.locals\?\.share/.test(code('src/lib/share-access.ts'))
    && !/logShareApiEvent[\s\S]{0,400}?body\./.test(code('src/lib/share-access.ts')));
  ok('LG-19 consent の記録に session_id を入れている',
    /sessionId:\s*resolved\?\.sessionId/.test(code('src/pages/api/share/consent.ts')));
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥-6 緊急停止 SHARE_ENABLED=off（§37）
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n⑥-6 緊急停止 SHARE_ENABLED=off（§37）\n');
{
  db.reset();
  const iss = await issue();
  const session = await enter(iss.token);

  /** middleware を 1 リクエストぶん通す（Cookie は引数で差し替える）。 */
  const hit = async (path, cookies = {}) => {
    const locals = {};
    let passed = false;
    const res = await mw.onRequest({
      request: new Request(`https://app.example.com${path}`),
      cookies: { get: (n) => (cookies[n] ? { value: cookies[n] } : undefined) },
      locals,
    }, async () => { passed = true; return new Response('ok'); });
    return { status: res?.status ?? 200, passed, locals };
  };

  const selfCookie = await viewerMod.signViewer(UID_B, false);

  // ── 既定（未設定）は通常動作 ──
  delete process.env.SHARE_ENABLED;
  ok('KS-1 未設定なら shareEnabled() は true', sa.shareEnabled() === true);
  ok('KS-2 未設定なら /share/<token> は素通り', (await hit('/share/abc')).passed === true);
  ok('KS-3 未設定なら共有セッションが解決される',
    (await hit('/dashboard', { welltect_share_v: session })).locals.share?.targetUid === UID_A);

  process.env.SHARE_ENABLED = 'on';
  ok('KS-4 on でも通常動作', sa.shareEnabled() === true
    && (await hit('/dashboard', { welltect_share_v: session })).locals.share?.targetUid === UID_A);

  // ── off ──
  process.env.SHARE_ENABLED = 'off';
  ok('KS-5 off なら shareEnabled() は false', sa.shareEnabled() === false);

  for (const p of ['/share/abc', '/share/consent', '/share/unavailable', '/share/end',
                   '/api/share/consent', '/api/share/end']) {
    const r = await hit(p);
    ok(`KS-6 off なら ${p} は 503`, r.status === 503 && !r.passed);
  }

  // ★ ここが本命: Cookie を持ったまま通常ページを開いても share にならない
  const d = await hit('/dashboard', { welltect_share_v: session });
  ok('KS-7 off なら既存 share セッションでも locals.share を置かない',
    d.passed === true && !d.locals.share);
  const v = await viewerMod.resolveViewer({
    request: new Request('https://app.example.com/dashboard'),
    cookies: { get: () => undefined },
    locals: d.locals,
  });
  ok('KS-8 off なら viewer が share にならない（対象者のデータを出さない）', v.kind !== 'share');

  // ★ 本人と admin 代理表示は止めない
  const selfHit = await hit('/dashboard', { welltect_v: selfCookie });
  ok('KS-9 off でも本人の通常ページは素通り', selfHit.passed === true);
  const vSelf = await viewerMod.resolveViewer({
    request: new Request('https://app.example.com/dashboard'),
    cookies: { get: (n) => (n === 'welltect_v' ? { value: selfCookie } : undefined) },
    locals: {},
  });
  ok('KS-10 off でも本人は self のまま', vSelf.kind === 'self' && vSelf.uid === UID_B);
  const vImp = await viewerMod.resolveViewer({
    request: new Request('https://app.example.com/dashboard'),
    cookies: { get: () => undefined },
    locals: { adminView: { ctx: 'c1', targetUid: UID_A, targetOrigin: 'production',
      adminIdentity: 'i', adminSelfUid: UID_B, expiresAt: inHours(1) } },
  });
  ok('KS-11 off でも Admin 代理表示は動く', vImp.kind === 'admin_impersonation');

  // ★ off でも通常の画面・API は 503 にしない（外部共有だけを止める）
  ok('KS-12 off でも /dashboard や /api/scan/save は素通り',
    (await hit('/api/scan/save')).passed === true && (await hit('/report')).passed === true);

  // ★ 綴り違いで黙って全停止しない
  process.env.SHARE_ENABLED = 'Off';
  ok('KS-13 大文字小文字を問わず off を認識する', sa.shareEnabled() === false);
  process.env.SHARE_ENABLED = 'disabled';
  ok('KS-14 off 以外の値では止めない（綴り違いで全停止しない）', sa.shareEnabled() === true);

  delete process.env.SHARE_ENABLED;   // ★ 後続の検査に影響させない

  // ★ 構造: admin API は新規発行だけ止め、一覧・停止・失効は残す
  const api = code('src/pages/api/admin/share-links.ts');
  ok('KS-15 admin API は発行だけ停止する（503 share_disabled）',
    /share_disabled/.test(api) && /if \(!shareEnabled\(\)\)/.test(api));
  ok('KS-16 pause / revoke / 一覧は停止中でも残す',
    !/shareEnabled\(\)[\s\S]{0,200}?setShareLinkStatus/.test(api));
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
    // ── 2026-09-30 のレビューで足した 3 種 ──
    ['⑨ live-token の interview scope を外す（IV-5）', 'src/pages/api/live-token.ts',
      "const scoped = denyUnlessShareScope(viewer, 'interview');", 'const scoped = null;',
      () => !/denyUnlessShareScope\(\s*viewer,\s*'interview'\s*\)/.test(code('src/pages/api/live-token.ts'))],
    ['⑩ revoked → active を許す（RV-24）', 'src/lib/share-access.ts',
      ".in('status', STATUS_TRANSITIONS[status])", ".in('status', ['active', 'paused', 'revoked'])",
      () => !/\.in\('status',\s*STATUS_TRANSITIONS\[status\]\)/.test(code('src/lib/share-access.ts'))],
    ['⑪ created_by に raw email を保存する（CB-8）', 'src/lib/share-access.ts',
      "!args.createdBy.includes('@')", 'true',
      () => !/!args\.createdBy\.includes\('@'\)/.test(code('src/lib/share-access.ts'))],
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

/* ══════════════════════════════════════════════════════════════════════
 * ⑦-2 退行注入（**実際に動かして**落ちることを見る）
 *
 * テキスト検査だけだと「探し方を変えただけで通る」退行を拾えない。
 * `share-access.ts` を書き換えて **再 bundle し、同じシナリオを走らせる**。
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n⑦-2 退行注入（再 bundle して実挙動で見る）\n');
{
  let round = 0;
  /** 注入した `share-access.ts` を別名で bundle して import する。 */
  const rebuild = async (mutate) => {
    const srcPath = resolve(ROOT, 'src/lib/share-access.ts');
    const orig = readFileSync(srcPath, 'utf8');
    const next = mutate(orig);
    if (next === orig) return null;         // 注入点が見つからない
    const out = `${CACHE}/share-inj-${++round}`;
    try {
      writeFileSync(srcPath, next);
      await build({
        entryPoints: ['src/lib/share-access.ts'],
        bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
        define: { 'import.meta.env': '{"DEV":false}' },
        outdir: out, outbase: 'src', outExtension: { '.js': '.mjs' },
        plugins: [{
          name: 'stub',
          setup(b) {
            b.onResolve({ filter: /(^|\/)supabase$/ }, () => ({
              path: pathToFileURL(resolve(ROOT, CACHE, 'share-supabase-stub.mjs')).href, external: true }));
          },
        }],
      });
      return await import(`../${out}/lib/share-access.mjs`);
    } finally {
      writeFileSync(srcPath, orig);         // ★ 必ず戻す
    }
  };

  /*
   * 【実測で分かったこと】**不可逆性は 2 つの錠で閉じている。**
   *   錠 1 = 遷移表（`STATUS_TRANSITIONS`）… `status` を書き戻させない
   *   錠 2 = `linkUsable()` の `revoked_at`  … 書き戻されても token を通さない
   * 片方を外しただけでは token は復活しない（**それが狙いどおり**）。
   * だから **錠ごとに 1 つずつ**、外したときに何が変わるかを見る。
   */

  // ⑩ 錠 1 を外す → `status` の書き戻しが**通ってしまう**（錠 2 が最後に止める）
  {
    const bad = await rebuild((t) =>
      t.replace(".in('status', STATUS_TRANSITIONS[status])", ".in('status', ['active', 'paused', 'revoked'])"));
    db.reset();
    const iss = await bad.createShareLink({ targetUid: UID_A, expiresAt: inHours(24) });
    await bad.setShareLinkStatus(iss.id, 'revoked');
    const resumed = await bad.setShareLinkStatus(iss.id, 'active');
    ok('注入 ⑩ 錠 1（遷移表）を外すと revoked → active が通ってしまう（= 今の実装が止めている）',
      resumed === true);
    ok('注入 ⑩-2 それでも錠 2（revoked_at）が元 token を止める（二重に閉じている）',
      (await bad.startShareFromToken(iss.token, db.NOW)) === null);
  }

  // ⑬ 錠 1 と錠 2 の**両方**を外す → **元 token が本当に復活する**
  //    （= どちらの錠も飾りではないことの証明）
  {
    const bad = await rebuild((t) => t
      .replace(".in('status', STATUS_TRANSITIONS[status])", ".in('status', ['active', 'paused', 'revoked'])")
      .replace('if (row.revoked_at) return false;', ''));
    db.reset();
    const iss = await bad.createShareLink({ targetUid: UID_A, expiresAt: inHours(24) });
    await bad.setShareLinkStatus(iss.id, 'revoked');
    await bad.setShareLinkStatus(iss.id, 'active');
    ok('注入 ⑬ 錠を両方外すと失効した URL が本当に復活する（= 2 つとも効いている）',
      (await bad.startShareFromToken(iss.token, db.NOW)) !== null);
  }

  // ⑪ `@` の関所を外す → **生 email が DB に入ってしまう**ことを実挙動で確認
  {
    const bad = await rebuild((t) => t.replace("!args.createdBy.includes('@')", 'true'));
    db.reset();
    const iss = await bad.createShareLink({
      targetUid: UID_A, expiresAt: inHours(24), createdBy: 'admin.one@example.com' });
    const row = db.LINKS.find((l) => l.id === iss.id);
    ok('注入 ⑪ 関所を外すと created_by に生 email が入る（= 今の実装が捨てている）',
      row?.created_by === 'admin.one@example.com');
  }

  // ⑫ regenerate の絞りを外す → **失効したリンクに新 URL が発行できてしまう**
  //    （ここも錠 2 があるので新 URL は開かないが、「再発行できた」こと自体が仕様違反）
  {
    const bad = await rebuild((t) =>
      t.replace(".in('status', ['active', 'paused'])   // ★ revoked からは再発行できない", ''));
    db.reset();
    const iss = await bad.createShareLink({ targetUid: UID_A, expiresAt: inHours(24) });
    await bad.setShareLinkStatus(iss.id, 'revoked');
    ok('注入 ⑫ 絞りを外すと revoked から再発行できてしまう（= 今の実装が null を返す）',
      (await bad.regenerateShareLink(iss.id)) !== null);
  }

  // ⑭ API 利用ログから link の紐付けを外す → **admin の記録一覧に出なくなる**
  {
    // **「紐付けを外す」= 以前の書き方（event / request / path だけ）へ戻すこと。**
    const bad = await rebuild((t) => t.replace(
      `    linkId: sh.linkId,
    sessionId: sh.sessionId,
    viewerId: sh.viewerId,
`, ''));
    db.reset();
    const iss = await bad.createShareLink({ targetUid: UID_A, expiresAt: inHours(24) });
    const st = await bad.startShareFromToken(iss.token, db.NOW);
    const c = await bad.consumeSharePending(st.pending, 'v1');
    const shr = await bad.resolveShareSession(c.session, db.NOW);
    await bad.logShareApiEvent(
      { request: new Request('https://app.example.com/api/live-token'), locals: { share: shr } },
      'chat_use', '/api/live-token');
    const logs = await bad.listShareLogs(iss.id);
    ok('注入 ⑭ 紐付けを外すと利用ログが link の記録一覧から消える（= 今の実装が紐付けている）',
      logs.every((l) => l.event_type !== 'chat_use'));
  }

  // ⑯ SHARE_ENABLED=off の判定を外す → **止めたのに共有が生き続ける**
  {
    const bad = await rebuild((t) => t.replace(
      "return (env('SHARE_ENABLED') ?? 'on').trim().toLowerCase() !== 'off';", 'return true;'));
    process.env.SHARE_ENABLED = 'off';
    ok('注入 ⑯ 判定を外すと off でも有効のまま（= 今の実装が止めている）', bad.shareEnabled() === true);
    delete process.env.SHARE_ENABLED;
  }

  // ★ 注入したファイルが元に戻っていること（戻し忘れでリポジトリを汚さない）
  ok('注入後に share-access.ts が元へ戻っている',
    /\.in\('status',\s*STATUS_TRANSITIONS\[status\]\)/.test(code('src/lib/share-access.ts'))
    && /!args\.createdBy\.includes\('@'\)/.test(code('src/lib/share-access.ts'))
    && /ctx\.locals\?\.share/.test(code('src/lib/share-access.ts'))
    && /!== 'off'/.test(code('src/lib/share-access.ts')));
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑦-3 退行注入（middleware を再 bundle して実挙動で見る）
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n⑦-3 退行注入（middleware・実挙動）\n');
{
  const mwPath = resolve(ROOT, 'src/middleware.ts');
  const orig = readFileSync(mwPath, 'utf8');
  const rebuildMw = async (next, tag) => {
    const out = `${CACHE}/share-mwinj-${tag}`;
    try {
      writeFileSync(mwPath, next);
      await build({
        entryPoints: ['src/middleware.ts'],
        bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
        define: { 'import.meta.env': '{"DEV":false}' },
        outdir: out, outbase: 'src', outExtension: { '.js': '.mjs' },
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
      return await import(`../${out}/middleware.mjs`);
    } finally {
      writeFileSync(mwPath, orig);
    }
  };

  // ⑮ /chat のページ表示を chat_use へ戻す → **開いただけで「利用」になる**
  {
    const bad = await rebuildMw(
      orig.replace("  '/notices': 'notices_view',", "  '/notices': 'notices_view',\n  '/chat': 'chat_use',"), 'chat');
    db.reset();
    const iss = await issue();
    const session = await enter(iss.token);
    await bad.onRequest({
      request: new Request('https://app.example.com/chat'),
      cookies: { get: (n) => (n === 'welltect_share_v' ? { value: session } : undefined) },
      locals: {},
    }, async () => new Response('ok'));
    ok('注入 ⑮ /chat を閲覧表へ戻すと開いただけで chat_use が付く（= 今の実装は付けない）',
      db.LOGS.filter((l) => l.event_type === 'chat_use').length === 1);
  }

  // ⑯-2 middleware の 503 を外す → **off でも /share/** が通ってしまう**
  {
    const bad = await rebuildMw(orig.replace('  const shareOff = !shareEnabled();', '  const shareOff = false;'), 'ks');
    process.env.SHARE_ENABLED = 'off';
    let passed = false;
    const res = await bad.onRequest({
      request: new Request('https://app.example.com/share/abc'),
      cookies: { get: () => undefined }, locals: {},
    }, async () => { passed = true; return new Response('ok'); });
    ok('注入 ⑯-2 middleware の停止判定を外すと off でも /share/** が通る（= 今の実装が 503）',
      passed === true && (res?.status ?? 200) !== 503);
    delete process.env.SHARE_ENABLED;
  }

  ok('注入後に middleware.ts が元へ戻っている',
    readFileSync(mwPath, 'utf8') === orig);
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log(`\n${fails.length === 0 ? '✅ すべて PASS' : `❌ ${fails.length} 件 FAIL`}\n`);
for (const f of fails) console.log(`  - ${f}`);
process.exit(fails.length === 0 ? 0 : 1);
