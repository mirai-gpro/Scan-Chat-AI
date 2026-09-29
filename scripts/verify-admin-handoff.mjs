#!/usr/bin/env node
/**
 * `npm run verify:admin-handoff` — **Admin 代理表示（UID-less）の回帰チェック。**
 *
 * 正本: `docs/specs/secure_shared_access_and_admin_impersonation_spec_20260930.md`
 *       §12（handoff）/ §13（context）/ §34（テスト）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【なぜ機械で見張るか】ここは**静かに壊れる**。
 * ══════════════════════════════════════════════════════════════════════
 * 代理表示の事故は「画面は正常に見えるのに中身が別人」という形で出る。
 * しかも URL から uid を消したので、**人の目では気づけない**。
 *   ・GET で claim してしまう     → プリフェッチに券を焼かれる（admin は「もう使われています」しか見ない）
 *   ・`read → +1 → write`        → 並行リクエストで試行回数が数え落ちる
 *   ・identity の照合を落とす     → **別の admin が URL を拾っただけで開ける**
 *   ・`?u=` が復活               → 消したはずの uid が URL に戻る
 * どれも「動いているように見える」ので、**実物を動かして固定する**。
 *
 * 【方式】① 実装の TS をそのまま bundle し、`./supabase` だけを差し替える。
 *   スタブは **PostgreSQL 側の条件付き UPDATE の意味論を忠実に再現**する
 *   （`pending_digest is null` / `consumed_at is null` / 期限 / UNIQUE）。
 *   「そう書いてあるか」の grep では、SQL の条件を 1 つ落とした退行を拾えない。
 *   ② 紙の上でしか守れない約束（GET で claim しない・cred を早期 return より前で出す等）は
 *   ソースの構造検査で固定する。
 *
 * 【DB は要らない】スタブなので CI の A 層（静的）に置ける。
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { webcrypto } from 'node:crypto';
import { execSync } from 'node:child_process';

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
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);

process.env.APP_SESSION_SECRET = 'test-secret-do-not-use-in-production';

/* ══════════════════════════════════════════════════════════════════════
 * スタブ: PostgreSQL の条件付き UPDATE を**そのまま**再現する
 * ════════════════════════════════════════════════════════════════════ */
const STUB = `
export const HANDOFFS = [];
export const SESSIONS = [];
export const USERS = new Set();
export let NOW = Date.parse('2026-09-30T12:00:00Z');
export function setNow(t) { NOW = t; }
export function reset() { HANDOFFS.length = 0; SESSIONS.length = 0; }

const nowIso = () => new Date(NOW).toISOString();
const live = (iso) => !!iso && Date.parse(iso) > NOW;

function rpc(fn, a) {
  if (fn === 'claim_admin_handoff') {
    // update … where token_hash = ? and consumed_at is null and pending_digest is null and expires_at > now()
    const h = HANDOFFS.find((r) =>
      r.token_hash === a.p_token_hash && r.consumed_at == null && r.pending_digest == null && live(r.expires_at));
    if (!h) return { data: [], error: null };
    h.pending_digest = a.p_pending_digest;
    h.pending_expires_at = new Date(NOW + a.p_pending_ttl_sec * 1000).toISOString();
    h.pending_attempts = 0;
    return { data: [{ handoff_id: h.id, admin_identity: h.admin_identity }], error: null };
  }
  if (fn === 'fail_admin_handoff_attempt') {
    const h = HANDOFFS.find((r) =>
      r.pending_digest === a.p_pending_digest && r.consumed_at == null && live(r.pending_expires_at));
    if (!h) return { data: [{ attempts: 0, exhausted: true }], error: null };
    h.pending_attempts += 1;                                  // ★ 原子的な +1
    if (h.pending_attempts >= a.p_max_attempts) h.pending_expires_at = nowIso();
    return { data: [{ attempts: h.pending_attempts, exhausted: h.pending_attempts >= a.p_max_attempts }], error: null };
  }
  if (fn === 'consume_admin_handoff') {
    const h = HANDOFFS.find((r) =>
      r.pending_digest === a.p_pending_digest && r.consumed_at == null
      && live(r.pending_expires_at) && r.admin_identity === a.p_admin_identity);
    if (!h) return { data: [], error: null };
    // ★ handoff_id は UNIQUE。2 本目は INSERT で落ち、consume ごと ROLLBACK される。
    if (SESSIONS.some((s) => s.handoff_id === h.id)) return { data: [], error: { message: 'unique_violation' } };
    h.consumed_at = nowIso();
    const expires = new Date(NOW + a.p_session_ttl_sec * 1000).toISOString();
    SESSIONS.push({
      id: 's' + SESSIONS.length, handoff_id: h.id, session_digest: a.p_session_digest,
      admin_identity: h.admin_identity, target_uid: h.target_uid, target_origin: h.target_origin,
      expires_at: expires, revoked_at: null,
    });
    return { data: [{ target_uid: h.target_uid, target_origin: h.target_origin, expires_at: expires }], error: null };
  }
  throw new Error('unknown rpc ' + fn);
}

function table(name) {
  const rows = () => (name === 'admin_impersonation_handoffs' ? HANDOFFS
    : name === 'admin_impersonation_sessions' ? SESSIONS
    : [...USERS].map((u) => ({ diagnostic_user_id: u })));
  const q = (filters, patch) => ({
    eq: (c, v) => q([...filters, [c, v]], patch),
    is: (c, v) => q([...filters, [c, v]], patch),
    select: async () => {
      const hit = rows().filter((r) => filters.every(([c, v]) => (r[c] ?? null) === v));
      if (patch) hit.forEach((r) => Object.assign(r, patch));
      return { data: hit, error: null };
    },
    maybeSingle: async () => {
      const hit = rows().filter((r) => filters.every(([c, v]) => (r[c] ?? null) === v));
      if (patch) hit.forEach((r) => Object.assign(r, patch));
      return { data: hit[0] ?? null, error: null };
    },
  });
  return {
    select: () => q([], null),
    update: (patch) => q([], patch),
    insert: async (v) => {
      HANDOFFS.push({ id: 'h' + HANDOFFS.length, pending_digest: null, pending_expires_at: null,
        pending_attempts: 0, consumed_at: null, ...v });
      return { error: null };
    },
  };
}

export function getServerSupabase() { return { schema: () => ({ from: table, rpc: async (f, a) => rpc(f, a) }) }; }
export function getBridgeSupabase() { return null; }
export function isBridgeConfigured() { return false; }
`;
writeFileSync(resolve(ROOT, CACHE, 'imp-supabase-stub.mjs'), STUB);

await build({
  entryPoints: ['src/lib/admin-impersonation.ts', 'src/lib/admin-identity.ts', 'src/lib/viewer.ts'],
  bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
  define: { 'import.meta.env': '{"DEV":false}' },
  outdir: `${CACHE}/imp`, outExtension: { '.js': '.mjs' },
  plugins: [{
    name: 'stub',
    setup(b) {
      b.onResolve({ filter: /(^|\/)supabase$/ }, () => ({ path: '../imp-supabase-stub.mjs', external: true }));
    },
  }],
});
const imp = await import(`../${CACHE}/imp/admin-impersonation.mjs`);
const ident = await import(`../${CACHE}/imp/admin-identity.mjs`);
const viewerMod = await import(`../${CACHE}/imp/viewer.mjs`);
const db = await import(`../${CACHE}/imp-supabase-stub.mjs`);

const UID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const UID_B = 'bbbbbbbb-2222-4222-8222-222222222222';
db.USERS.add(UID_A); db.USERS.add(UID_B);

const ADMIN1 = await ident.adminIdentity('Admin.One@Example.com');
const ADMIN2 = await ident.adminIdentity('admin.two@example.com');

/** 1 件発行して raw token を返す（テストの下ごしらえ）。 */
async function issue(uid = UID_A, who = ADMIN1) {
  const r = await imp.createHandoff({ targetUid: uid, adminIdentity: who, targetOrigin: 'production', now: db.NOW });
  return r?.token ?? null;
}

/* ══════════════════════════════════════════════════════════════════════
 * ① admin_identity — 何であって、何でないか
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n① admin_identity（§12.4.1）\n');
{
  ok('A-1 大文字・前後空白を正規化する（同じ人は同じ digest）',
    ADMIN1 === await ident.adminIdentity('  admin.one@example.com  '));
  ok('A-2 別の admin は別の digest', ADMIN1 !== ADMIN2);
  ok('A-3 生 email を含まない', !ADMIN1.includes('admin') && !ADMIN1.includes('@'));
  // **素の sha256 にしない**（メールは列挙可能なので辞書で戻せる・§12.4.1）
  const plain = Buffer.from(
    await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('admin.one@example.com')),
  ).toString('base64url');
  ok('A-4 素の sha256(email) と一致しない（鍵つき HMAC である）', ADMIN1 !== plain);
  // **用途を分離している**（同じ鍵の別用途 digest を持ち込めない）
  const noDomain = Buffer.from(
    await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('admin_identity:v1:admin.one@example.com')),
  ).toString('base64url');
  ok('A-5 domain separation prefix 抜きの値とも一致しない', ADMIN1 !== noDomain);
  ok('A-6 空 email では発行しない', await ident.adminIdentity('') === null);

  const tok = await ident.signAdminCred(ADMIN1);
  const v = await ident.verifyAdminCred(tok);
  ok('A-7 発行した credential は検証できる', v?.identity === ADMIN1);
  // **UID-less**: payload は `<identity>.<exp>.<sig>` の 3 分割で uid を含まない
  eq('A-8 payload は 3 分割（uid を含まない＝uid の無い admin も使える）', tok.split('.').length, 3);
  ok('A-9 identity を書き換えると署名が合わない',
    await ident.verifyAdminCred(`${ADMIN2}.${tok.split('.')[1]}.${tok.split('.')[2]}`) === null);
  ok('A-10 exp を伸ばすと署名が合わない',
    await ident.verifyAdminCred(`${ADMIN1}.99999999999.${tok.split('.')[2]}`) === null);
  ok('A-11 期限切れは通さない', await ident.verifyAdminCred(tok, Date.now() + 31 * 24 * 3600 * 1000) === null);
  ok('A-12 空・でたらめは通さない',
    await ident.verifyAdminCred('') === null && await ident.verifyAdminCred('a.b.c') === null);
}

/* ══════════════════════════════════════════════════════════════════════
 * ② handoff の状態遷移（§12.8）
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n② handoff → pending → context（§12.8）\n');
{
  db.reset();
  const raw = await issue();
  ok('H-1 発行した raw token は base64url 256bit', imp.OPAQUE_RE.test(raw) && raw.length >= 42);
  ok('H-2 DB に raw token は保存されない（sha256 だけ）',
    db.HANDOFFS.every((h) => h.token_hash !== raw) && db.HANDOFFS.length === 1);
  ok('H-3 DB に生 email は保存されない',
    !JSON.stringify(db.HANDOFFS).includes('@'));

  const pending = await imp.claimHandoff(raw);
  ok('H-4 claim すると pending が返る', !!pending && imp.OPAQUE_RE.test(pending));
  ok('H-5 pending の raw は DB に無い（sha256 だけ）',
    db.HANDOFFS[0].pending_digest !== pending);

  ok('H-6 **同じ raw token で 2 度目の claim は通らない**（single-use）',
    await imp.claimHandoff(raw) === null);

  const ctx = await imp.consumeHandoff(pending, ADMIN1);
  ok('H-7 発行した admin 本人なら consume できる', ctx?.targetUid === UID_A);
  ok('H-8 context の raw は DB に無い（sha256 だけ）',
    db.SESSIONS[0].session_digest !== ctx.ctx);
  ok('H-9 **同じ pending で 2 度目の consume は通らない**',
    await imp.consumeHandoff(pending, ADMIN1) === null);
  eq('H-10 **1 handoff = 1 context**', db.SESSIONS.length, 1);
}
{
  db.reset();
  const raw = await issue();
  const pending = await imp.claimHandoff(raw);
  ok('H-11 **別の admin では consume できない**（403 相当）',
    await imp.consumeHandoff(pending, ADMIN2) === null);
  ok('H-12 失敗しても handoff は焼けていない（正しい人なら続けられる）',
    db.HANDOFFS[0].consumed_at == null);
  const ctx = await imp.consumeHandoff(pending, ADMIN1);
  ok('H-13 正しい admin でやり直せる', ctx?.targetUid === UID_A);
}
{
  db.reset();
  const raw = await issue();
  db.setNow(db.NOW + 61 * 1000);                        // 60 秒経過
  ok('H-14 raw token は 60 秒で失効する', await imp.claimHandoff(raw) === null);
  db.setNow(db.NOW - 61 * 1000);
}
{
  db.reset();
  const raw = await issue();
  const pending = await imp.claimHandoff(raw);
  db.setNow(db.NOW + 5 * 60 * 1000);                    // 5 分（Google 認証に手間取った）
  ok('H-15 **交換後は 60 秒でなく pending の 10 分が効く**（v1.2 の矛盾点）',
    (await imp.consumeHandoff(pending, ADMIN1))?.targetUid === UID_A);
  db.setNow(db.NOW - 5 * 60 * 1000);
}
{
  db.reset();
  const raw = await issue();
  const pending = await imp.claimHandoff(raw);
  db.setNow(db.NOW + 11 * 60 * 1000);                   // 10 分超
  ok('H-16 pending は 10 分で失効する', await imp.consumeHandoff(pending, ADMIN1) === null);
  db.setNow(db.NOW - 11 * 60 * 1000);
}
{
  db.reset();
  ok('H-17 実在しない uid では券を出さない',
    await imp.createHandoff({ targetUid: '99999999-9999-4999-8999-999999999999', adminIdentity: ADMIN1, targetOrigin: 'production' }) === null);
  ok('H-18 uid の字面が違えば券を出さない',
    await imp.createHandoff({ targetUid: 'not-a-uuid', adminIdentity: ADMIN1, targetOrigin: 'production' }) === null);
  ok('H-19 でたらめな token では claim できない', await imp.claimHandoff('x'.repeat(43)) === null);
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 試行回数は **原子的に** 数える（§12.8・U25 = 5 回で確定）
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n③ pending_attempts（5 回で失効・原子的 +1）\n');
{
  db.reset();
  const raw = await issue();
  const pending = await imp.claimHandoff(raw);
  eq('P-1 上限は 5', imp.MAX_PENDING_ATTEMPTS, 5);
  const seen = [];
  for (let i = 0; i < 4; i++) {
    ok(`P-2.${i + 1} ${i + 1} 回目の別 admin は弾く`, await imp.consumeHandoff(pending, ADMIN2) === null);
    seen.push((await imp.failPendingAttempt(pending)).attempts);
  }
  eq('P-3 **1 ずつ増える（read→+1→write なら並行で数え落ちる）**', seen, [1, 2, 3, 4]);
  ok('P-4 4 回目まではまだ本人ならやり直せる', db.HANDOFFS[0].consumed_at == null
    && Date.parse(db.HANDOFFS[0].pending_expires_at) > db.NOW);
  const last = await imp.failPendingAttempt(pending);
  eq('P-5 5 回目で exhausted', [last.attempts, last.exhausted], [5, true]);
  ok('P-6 **5 回で pending が失効する**（正しい admin でももう通らない）',
    await imp.consumeHandoff(pending, ADMIN1) === null);
  // 並行で 2 本走っても両方が 1 を返す（= 数え落ち）ことが無い
  db.reset();
  const raw2 = await issue();
  const p2 = await imp.claimHandoff(raw2);
  const par = await Promise.all([imp.failPendingAttempt(p2), imp.failPendingAttempt(p2)]);
  eq('P-7 同時に 2 回失敗しても 1 と 2 になる（数え落ちしない）',
    par.map((r) => r.attempts).sort(), [1, 2]);
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ context の毎リクエスト解決（§12.4.1「毎リクエスト」）
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n④ context の解決（本人結合）\n');
{
  db.reset();
  const pending = await imp.claimHandoff(await issue());
  const { ctx } = await imp.consumeHandoff(pending, ADMIN1);

  ok('C-1 発行した admin 本人なら解決できる',
    (await imp.resolveImpersonationContext(ctx, ADMIN1))?.targetUid === UID_A);
  ok('C-2 **別の admin では解決できない（URL を拾っただけでは開けない）**',
    await imp.resolveImpersonationContext(ctx, ADMIN2) === null);
  ok('C-3 **admin credential が無ければ解決できない**（context 単体は権限を生まない）',
    await imp.resolveImpersonationContext(ctx, null) === null);
  ok('C-4 存在しない context は解決できない',
    await imp.resolveImpersonationContext('z'.repeat(43), ADMIN1) === null);
  ok('C-5 字面が不正な context は DB を引く前に落とす',
    await imp.resolveImpersonationContext('../../etc/passwd', ADMIN1) === null);
  ok('C-6 期限切れ（60 分）は解決できない',
    await imp.resolveImpersonationContext(ctx, ADMIN1, db.NOW + 61 * 60 * 1000) === null);

  eq('C-7 「この代理表示を終了」で 1 件だけ落ちる',
    await imp.revokeImpersonation({ adminIdentity: ADMIN1, ctx }), 1);
  ok('C-8 終了後は解決できない', await imp.resolveImpersonationContext(ctx, ADMIN1) === null);
}
{
  // **複数タブ**（§13.0 の本体）: A 顧客と B 顧客が同時に生きる
  db.reset();
  const cA = await imp.consumeHandoff(await imp.claimHandoff(await issue(UID_A)), ADMIN1);
  const cB = await imp.consumeHandoff(await imp.claimHandoff(await issue(UID_B)), ADMIN1);
  ok('C-9 **A タブと B タブが同時に成立する（Cookie 1 本方式の退行を作らない）**',
    (await imp.resolveImpersonationContext(cA.ctx, ADMIN1))?.targetUid === UID_A
    && (await imp.resolveImpersonationContext(cB.ctx, ADMIN1))?.targetUid === UID_B);
  await imp.revokeImpersonation({ adminIdentity: ADMIN1, ctx: cA.ctx });
  ok('C-10 A を終了しても B は生き続ける',
    await imp.resolveImpersonationContext(cA.ctx, ADMIN1) === null
    && (await imp.resolveImpersonationContext(cB.ctx, ADMIN1))?.targetUid === UID_B);

  const cC = await imp.consumeHandoff(await imp.claimHandoff(await issue(UID_A, ADMIN2)), ADMIN2);
  eq('C-11 「すべて終了」は**自分の分だけ**落とす', await imp.revokeImpersonation({ adminIdentity: ADMIN1, all: true }), 1);
  ok('C-12 別 admin の代理表示は落ちていない',
    (await imp.resolveImpersonationContext(cC.ctx, ADMIN2))?.targetUid === UID_A);
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ path の分解と、リンクの組み立て
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n⑤ /admin-view の path と link prefix\n');
{
  const CTX = 'A'.repeat(43);
  eq('L-1 /admin-view/<ctx>/report を分解できる',
    imp.parseAdminViewPath(`/admin-view/${CTX}/report`), { ctx: CTX, rest: '/report' });
  eq('L-2 ctx だけなら /dashboard へ',
    imp.parseAdminViewPath(`/admin-view/${CTX}`), { ctx: CTX, rest: '/dashboard' });
  eq('L-3 入れ子の path も保つ',
    imp.parseAdminViewPath(`/admin-view/${CTX}/result/abc`), { ctx: CTX, rest: '/result/abc' });
  ok('L-4 **`..` を含む rest は受けない**', imp.parseAdminViewPath(`/admin-view/${CTX}/../admin`) === null);
  ok('L-5 base64url 以外の ctx は受けない', imp.parseAdminViewPath('/admin-view/短い/report') === null);
  ok('L-6 /admin-view 以外は対象外', imp.parseAdminViewPath('/dashboard') === null);

  eq('L-7 代理表示のリンクは prefix が付く',
    viewerMod.viewerPathPrefix({ viewCtx: CTX }), `/admin-view/${CTX}`);
  eq('L-8 一般利用者は prefix が付かない', viewerMod.viewerPathPrefix({ viewCtx: null }), '');
  // **ここが緩むと、URL から消したはずの uid が戻る**
  eq('L-9 **代理表示では `?u=` を出さない**',
    viewerMod.viewerLinkQuery({ uid: UID_A, impersonating: true, uidEntry: false, viewCtx: CTX }), '');
  eq('L-10 一般利用者も `?u=` を出さない（既存の約束）',
    viewerMod.viewerLinkQuery({ uid: UID_A, impersonating: false, uidEntry: false }), '');
  eq('L-11 旧方式（移行期間）はこれまでどおり `?u=`',
    viewerMod.viewerLinkQuery({ uid: UID_A, impersonating: true, uidEntry: false }), `?u=${UID_A}`);
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ resolveViewer — 代理表示は **read-only**
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n⑥ resolveViewer（書き込み先の分離）\n');
{
  const CTX = 'B'.repeat(43);
  const cookie = await viewerMod.signViewer(UID_B, true);      // admin 本人（自分は UID_B）
  const mk = (locals) => ({
    request: new Request('https://x.test/admin-view/' + CTX + '/dashboard'),
    cookies: { get: (n) => (n === viewerMod.VIEWER_COOKIE ? { value: cookie } : undefined) },
    locals,
  });
  const v = await viewerMod.resolveViewer(mk({
    adminView: { ctx: CTX, targetUid: UID_A, targetOrigin: 'production', adminIdentity: ADMIN1, adminSelfUid: UID_B, expiresAt: '' },
  }));
  eq('V-1 表示対象は代理表示の対象', v.uid, UID_A);
  eq('V-2 本人は admin 自身のまま', v.selfUid, UID_B);
  eq('V-3 kind は admin_impersonation', v.kind, 'admin_impersonation');
  eq('V-4 **書き込み先は null（代理表示は read-only）**', v.writeTargetUid, null);
  eq('V-5 対象は固定（クライアント申告を受けない）', v.targetLocked, true);

  const self = await viewerMod.resolveViewer(mk(undefined));
  eq('V-6 locals が無ければ従来どおり本人', self.uid, UID_B);
  eq('V-7 本人の kind は admin_self', self.kind, 'admin_self');
  eq('V-8 本人は自分に書ける', self.writeTargetUid, UID_B);
  // **middleware を通っていないのに locals だけ在る**ことは起こり得ないが、
  // 「admin でない Cookie + locals」で成立しないことは固定しておく。
  const nonAdminCookie = await viewerMod.signViewer(UID_B, false);
  const v2 = await viewerMod.resolveViewer({
    request: new Request('https://x.test/admin-view/' + CTX + '/dashboard'),
    cookies: { get: () => ({ value: nonAdminCookie }) },
    locals: { adminView: { ctx: CTX, targetUid: UID_A, targetOrigin: 'production', adminIdentity: ADMIN1, adminSelfUid: UID_B, expiresAt: '' } },
  });
  eq('V-9 **非 admin の Cookie では代理表示にならない**', v2.uid, UID_B);
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 紙の上でしか守れない約束（ソースの構造検査）
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n⑦ 構造（GET で claim しない・cred の発行位置・middleware の範囲）\n');
{
  // **GET のページが状態を変えない**。ここが緩むとプリフェッチに券を焼かれる。
  const landing = code('src/pages/admin/handoff/[token].astro');
  ok('S-1 **GET のページは claim / consume を呼ばない**',
    !/claimHandoff|consumeHandoff|failPendingAttempt/.test(landing));
  ok('S-2 GET のページは Cookie を書かない', !/cookies\.set/.test(landing));
  ok('S-3 GET のページは DB を引かない', !/getServerSupabase|supabase/.test(landing));
  ok('S-4 claim は POST のフォームから行く', /method="POST"/.test(landing) && /handoff\/claim/.test(landing));
  ok('S-5 token を URL 外へ出さない（no-referrer / noindex）',
    /referrer-policy/i.test(landing) && /noindex/.test(landing));

  const claim = code('src/pages/api/admin/handoff/claim.ts');
  ok('S-6 claim の口は POST だけ（GET を生やさない）',
    /export const POST/.test(claim) && !/export const GET/.test(claim));
  ok('S-7 claim のあとは 303 で raw token を URL から落とす', /303/.test(claim));

  // **cred は uid が決まる前に出す**（uid を持たない admin を締め出さない）。
  const resolveSrc = read('src/pages/api/auth/resolve.ts');
  const iIssue = resolveSrc.indexOf('issueAdminCred(');
  const iLinked = resolveSrc.indexOf("return json({ linked: false");
  ok('S-8 **`welltect_admin_v` は `linked:false` の早期 return より前で発行する**',
    iIssue > 0 && iLinked > 0 && iIssue < iLinked, `issue@${iIssue} linked@${iLinked}`);
  ok('S-9 refresh-admin でも発行 / 削除する', /issueAdminCred\(/.test(read('src/pages/api/auth/refresh-admin.ts')));
  ok('S-10 非 admin には発行せず削除する', /cookies\.delete\(ADMIN_COOKIE/.test(code('src/lib/admin-identity.ts')));
  ok('S-11 `welltect_v` の形式を変えていない（署名 payload は uid.exp.admin[.s] のまま）',
    /\$\{uid\.toLowerCase\(\)\}\.\$\{exp\}\.\$\{isAdmin \? '1' : '0'\}/.test(read('src/lib/viewer.ts')));

  // **middleware は /admin-view 以外に触らない**。
  const mw = code('src/middleware.ts');
  ok('S-12 middleware は /admin-view 以外で即 next()（既存経路に触れない）',
    /parseAdminViewPath/.test(mw) && /if \(!parsed\) return next\(\);/.test(mw));
  ok('S-13 middleware が毎リクエスト本人結合する（admin フラグ + cred + context）',
    /verifyViewer/.test(mw) && /verifyAdminCred/.test(mw) && /resolveImpersonationContext/.test(mw));
  ok('S-14 **失敗したら 403。self / share へ落とさない**',
    /return forbidden\(\);/.test(mw) && !/redirect|\/dashboard/.test(mw));
  ok('S-15 locals へ載せてから rewrite する', /locals\.adminView/.test(mw) && /next\(`/.test(mw));

  // **DB は service_role だけ**（緩い dev RLS に載せない）。
  const sql = read('supabase/migrations/20260930000010_admin_impersonation.sql');
  ok('S-16 2 表とも RLS 有効', (sql.match(/enable row level security/g) ?? []).length === 2);
  ok('S-17 **anon / authenticated に権限を出さない**',
    /revoke all on diagnosis\.admin_impersonation_handoffs from anon, authenticated/.test(sql)
    && /revoke all on diagnosis\.admin_impersonation_sessions from anon, authenticated/.test(sql));
  ok('S-18 dev の緩いポリシーを足していない',
    !/create policy[\s\S]*using \(true\)/.test(sql));
  ok('S-19 RPC は security definer + search_path 固定',
    (sql.match(/security definer/g) ?? []).length === 3
    && (sql.match(/set search_path = ''/g) ?? []).length === 3);
  ok('S-20 **1 handoff = 1 context を UNIQUE で担保**', /handoff_id\s+uuid not null unique/.test(sql));
  ok('S-21 claim の排他条件が 3 つそろっている',
    /and h\.consumed_at\s+is null/.test(sql) && /and h\.pending_digest is null/.test(sql)
    && /and h\.expires_at\s+> now\(\)/.test(sql));
  ok('S-22 attempts は SQL 側で +1（read→+1→write でない）',
    /pending_attempts\s+= h\.pending_attempts \+ 1/.test(sql));
  ok('S-23 consume は admin_identity の一致を SQL で要求する',
    /and h\.admin_identity\s+= p_admin_identity/.test(sql));
  // **列だけ**を見る（コメントには「生 email は保存しない」等の説明が出てくる）。
  const ddl = sql.split('\n').filter((ln) => !/^\s*--/.test(ln)).join('\n')
    .replace(/comment on [\s\S]*?;/g, '');
  ok('S-24 raw token / raw context / 生 email を保存する列が無い',
    !/\braw_token\b|\braw_context\b|^\s*email\s/m.test(ddl), ddl.match(/\braw_token\b|\braw_context\b|^\s*email\s/m)?.[0]);

  // **代理表示は書けない**（既存の規律を壊していないこと）。
  ok('S-25 Viewer に writeTargetUid が在る（読み `uid` / 書き `selfUid` の穴を塞ぐ）',
    /writeTargetUid/.test(code('src/lib/viewer.ts')));
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑧ 発注者が名指しした残りの受入条件（§34）
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n⑧ 受入条件の残り\n');
{
  // **同時 consume でも context は 1 件**（②の条件付き UPDATE と UNIQUE の二重の歯止め）
  db.reset();
  const pending = await imp.claimHandoff(await issue());
  const both = await Promise.all([imp.consumeHandoff(pending, ADMIN1), imp.consumeHandoff(pending, ADMIN1)]);
  eq('X-1 **同時に consume しても context は 1 件**', db.SESSIONS.length, 1);
  eq('X-2 成功するのは 1 本だけ', both.filter(Boolean).length, 1);

  // **context の INSERT が落ちたら consumed_at も戻る**（consumed だけ進んで context 無しを作らない）
  db.reset();
  const raw2 = await issue();
  const p2 = await imp.claimHandoff(raw2);
  db.SESSIONS.push({ id: 'pre', handoff_id: db.HANDOFFS[0].id, session_digest: 'dup',
    admin_identity: ADMIN1, target_uid: UID_A, target_origin: 'production',
    expires_at: new Date(db.NOW + 3600e3).toISOString(), revoked_at: null });   // 先に 1 本在る状態
  ok('X-3 context INSERT が落ちたら consume も成立しない', await imp.consumeHandoff(p2, ADMIN1) === null);
  ok('X-4 **ROLLBACK されて consumed_at は null のまま**', db.HANDOFFS[0].consumed_at == null);

  // **uid を 1 つも持たない admin** でも最後まで通る
  db.reset();
  const cred = await ident.signAdminCred(ADMIN2);
  const v = await ident.verifyAdminCred(cred);
  const c3 = await imp.consumeHandoff(await imp.claimHandoff(await issue(UID_A, ADMIN2)), v.identity);
  ok('X-5 **uid を持たない admin でも handoff を使い切れる**', c3?.targetUid === UID_A);
  ok('X-6 その context も本人結合で解決できる',
    (await imp.resolveImpersonationContext(c3.ctx, v.identity))?.targetUid === UID_A);
  // **admin 剥奪**: credential を削除された後は identity が手に入らない → 解決できない
  const jar = new Map([[ident.ADMIN_COOKIE, cred]]);
  const ctxObj = { cookies: { set: (k, val) => jar.set(k, val), delete: (k) => jar.delete(k) } };
  await ident.issueAdminCred(ctxObj, 'admin.two@example.com', false);
  ok('X-7 **admin から外れたら credential は削除される**', !jar.has(ident.ADMIN_COOKIE));
  ok('X-8 credential が無ければ代理表示は解決できない（剥奪が効く）',
    await imp.resolveImpersonationContext(c3.ctx, null) === null);

  // **遷移先に uid が出ない**
  const dest = `/admin-view/${c3.ctx}/dashboard`;
  ok('X-9 **遷移先の URL に target UID が出ない**', !dest.includes(UID_A) && !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(dest));

  // **reload では attempts が増えない**（数えるのは「本人照合に失敗したとき」だけ）
  const cont = code('src/pages/admin/handoff/continue.astro');
  const failIdx = cont.indexOf('failPendingAttempt(');
  const noCred = cont.indexOf('if (!cred)');
  const consumeIdx = cont.indexOf('consumeHandoff(');
  ok('X-10 **attempts は consume が失敗したときだけ +1**（表示・reload・未認証では数えない）',
    failIdx > consumeIdx && consumeIdx > noCred, `noCred@${noCred} consume@${consumeIdx} fail@${failIdx}`);
  ok('X-11 未認証のときは failPendingAttempt を通らない（サインイン画面を出すだけ）',
    /signInView = true;/.test(cont));

  // **welltect_imp_v は 1 か所も発行しない**（§13.0 案 B を採ったので存在しない）
  // 検査自身のこの行が引っかかるので、名前を組み立てて渡す。
  const IMP_COOKIE = ['welltect', 'imp', 'v'].join('_');
  const allSrc = execSync(`grep -rn ${IMP_COOKIE} src/ || true`, { cwd: ROOT }).toString();
  ok('X-12 **代理表示の対象を持つ Cookie を発行するコードが 1 行も無い**（§13.0 案 B）',
    allSrc.trim() === '', allSrc.slice(0, 200));

  // **生 email をログへ出さない**
  const logSrc = [
    'src/lib/admin-identity.ts', 'src/lib/admin-impersonation.ts',
    'src/pages/api/admin/impersonation/handoff.ts', 'src/pages/api/admin/handoff/claim.ts',
  ].map((f) => code(f)).join('\n');
  const logLines = logSrc.split('\n').filter((ln) => /console\.(log|warn|error|info)/.test(ln));
  ok('X-13 **生 email / raw token をログへ出す行が無い**',
    !logLines.some((ln) => /email|adminEmail|rawToken|\btoken\b|pending\b|ctx\b/.test(ln)),
    logLines.filter((ln) => /email|token|pending|ctx/.test(ln)).join(' | ').slice(0, 200));

  // **Cookie の顔ぶれ**（仕様書 §23 と一致していること）
  eq('X-14 admin credential の Cookie 名', ident.ADMIN_COOKIE, 'welltect_admin_v');
  eq('X-15 pending の Cookie 名', imp.HANDOFF_PENDING_COOKIE, 'welltect_handoff_pending');
  eq('X-16 本人の Cookie 名（既存・変えない）', viewerMod.VIEWER_COOKIE, 'welltect_v');
}

console.log('');
if (fails.length) {
  console.error(`✗ ${fails.length} 件 失敗\n` + fails.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log('✓ すべて PASS');
