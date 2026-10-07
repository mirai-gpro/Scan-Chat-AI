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
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { webcrypto } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const ROOT = resolve(import.meta.dirname, '..');
const CACHE = 'node_modules/.cache';
mkdirSync(resolve(ROOT, CACHE), { recursive: true });
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
/** コメント行を落とす（経緯の説明に旧コードが載っているので、そこを拾わない）。 */
const code = (p) => read(p).split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');

/** コメント行を落とす（文字列版）。`code()` はパス版なので、読み込み済みの文字列用に分けてある。 */
const stripComments = (t) => t.split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');
const fails = [];
const ok = (label, cond, why) => {
  if (!cond) fails.push(`${label}${why ? ` — ${why}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);

/**
 * **テスト開始時刻**。スタブの時計はこれに錨を打つ（ⓠ のガードが見る値）。
 * 固定の過去日時を書かないための基準点。
 */
const T0_RUNTIME = Date.now();

process.env.APP_SESSION_SECRET = 'test-secret-do-not-use-in-production';

/* ══════════════════════════════════════════════════════════════════════
 * スタブ: PostgreSQL の条件付き UPDATE を**そのまま**再現する
 * ════════════════════════════════════════════════════════════════════ */
const STUB = `
export const HANDOFFS = [];
export const SESSIONS = [];
export const USERS = new Set();
/*
 * **スタブの時計は「テスト開始時の runtime clock」を基準にする。固定の過去日時を書かない。**
 *
 * 【なぜ（2026-10-02 の CI 修復）】ここは \`Date.parse('2026-09-30T12:00:00Z')\` で
 * 固定されていた。ところが **\`src/middleware.ts\` と
 * \`resolveImpersonationContext()\` / \`resolveShareSession()\` の既定引数は実時計**を使う。
 * session の期限は「この NOW + 60 分」で作られるので、
 * **実時刻が 2026-09-30 13:00Z を過ぎた瞬間から、正常系が恒久的に FAIL** していた
 * （C-1 / C-9 / C-10 / C-12 / M-1〜M-7 / M-17 / M-18 / X-6 の 14 件）。
 *
 * **直し方を間違えないこと**: 「別の固定日時に差し替える」のでも
 * 「product code に時計を注入する」のでもない。**テスト開始時刻を基準にする**ことで、
 * 相対的な時間旅行（\`setNow(NOW ± n)\`）はそのまま使えて、実時計とも必ず噛み合う。
 * 固定過去日時を再導入したら下の T0 ガードが落ちる。
 */
export let NOW = Date.now();
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

// `astro:middleware` は Astro 実行時にしか無い。`defineMiddleware` は素通しなので同じ形で置く。
writeFileSync(resolve(ROOT, CACHE, 'imp-astro-middleware-stub.mjs'),
  'export const defineMiddleware = (fn) => fn;\n');

await build({
  entryPoints: [
    'src/lib/admin-impersonation.ts', 'src/lib/admin-identity.ts', 'src/lib/viewer.ts',
    'src/lib/write-guard.ts', 'src/middleware.ts',
  ],
  bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
  define: { 'import.meta.env': '{"DEV":false}' },
  outdir: `${CACHE}/imp`, outbase: 'src', outExtension: { '.js': '.mjs' },
  plugins: [{
    name: 'stub',
    setup(b) {
      // **絶対パスで外に出す。** 相対だと出力の階層 (lib/ 配下か直下か) で解決先がずれる。
      b.onResolve({ filter: /(^|\/)supabase$/ }, () => ({
        path: pathToFileURL(resolve(ROOT, CACHE, 'imp-supabase-stub.mjs')).href, external: true }));
      b.onResolve({ filter: /^astro:middleware$/ }, () => ({
        path: pathToFileURL(resolve(ROOT, CACHE, 'imp-astro-middleware-stub.mjs')).href, external: true }));
    },
  }],
});
const imp = await import(`../${CACHE}/imp/lib/admin-impersonation.mjs`);
const ident = await import(`../${CACHE}/imp/lib/admin-identity.mjs`);
const viewerMod = await import(`../${CACHE}/imp/lib/viewer.mjs`);
const guard = await import(`../${CACHE}/imp/lib/write-guard.mjs`);
const mw = await import(`../${CACHE}/imp/middleware.mjs`);
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
/* ══════════════════════════════════════════════════════════════════════
 * ⓪ 時計の健全性（**再腐敗ガード**・2026-10-02）
 *
 * スタブの時計が runtime clock に錨を打っていることを**最初に**確かめる。
 * ここが落ちるのは「固定の過去日時が再導入された」ときだけ。
 * **現在時刻との差を固定値で成立させない** — 基準は常にテスト開始時刻。
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nⓠ 時計の健全性（固定過去日時の再導入ガード）\n');
{
  const drift = Math.abs(db.NOW - T0_RUNTIME);
  ok('T0-1 **スタブの NOW がテスト開始時刻に錨を打っている**（固定過去日時を書いていない）',
    drift <= 5 * 60 * 1000, `drift=${Math.round(drift / 1000)}s`);
  // **コメントは見ない**（上の経緯説明に旧コードが載っているので、そこを拾わない）。
  ok('T0-2 スタブの**コード**に固定日時リテラルが無い',
    !/Date\.parse\('\d{4}-\d{2}-\d{2}/.test(stripComments(STUB)), '');
}

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
    (await imp.resolveImpersonationContext(ctx, ADMIN1, db.NOW))?.targetUid === UID_A);
  /*
   * **C-1b: `now` を渡さない経路を名前つきで固定する**（2026-10-02 追加）。
   *
   * `src/middleware.ts` は `resolveImpersonationContext(parsed.ctx, cred.identity)` と
   * **第 3 引数なし**で呼ぶ＝既定の `Date.now()`（実時計）を使う。
   * ここが腐っても C-1 のように `now` を渡す検査だけ緑だと**気づけない**
   * （実際それで 14 件が静かに落ちていた）。**実時計経路を 1 件、明示的に持つ。**
   */
  ok('C-1b **`now` 引数なしでも解決できる（middleware と同じ実時計経路）**',
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
  /*
   * **`welltect_v` を持たない admin**（2026-09-30 修正の本体）。
   * 以前はここで `verified?.admin` を要求していたため、**uid を持たない admin は
   * middleware を通っているのに本人扱いされ 403 相当**になっていた。
   */
  const noViewer = await viewerMod.resolveViewer({
    request: new Request('https://x.test/admin-view/' + CTX + '/dashboard'),
    cookies: { get: () => undefined },                     // ★ welltect_v が 1 つも無い
    locals: { adminView: { ctx: CTX, targetUid: UID_A, targetOrigin: 'production', adminIdentity: ADMIN1, adminSelfUid: null, expiresAt: '' } },
  });
  eq('V-9 **welltect_v が無くても代理表示が成立する**', noViewer.kind, 'admin_impersonation');
  eq('V-10 表示対象は対象顧客', noViewer.uid, UID_A);
  eq('V-11 **selfUid は null**（uid を持たない admin）', noViewer.selfUid, null);
  eq('V-12 それでも書き込みは不可', noViewer.writeTargetUid, null);
  eq('V-13 isAdmin は true（画面の admin 表示は出す）', noViewer.isAdmin, true);
  eq('V-14 根拠は admin-cookie', noViewer.adminBy, 'admin-cookie');
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥-2 middleware — **認可はここ 1 か所**（cookie を入れて 403 / 通過を見る）
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n⑥-2 middleware（/admin-view の認可）\n');
{
  db.reset();
  const ctxObj = await imp.consumeHandoff(await imp.claimHandoff(await issue(UID_A, ADMIN1)), ADMIN1);
  const CRED1 = await ident.signAdminCred(ADMIN1);
  const CRED2 = await ident.signAdminCred(ADMIN2);

  /** cookie の顔ぶれを与えて middleware を 1 回通す。 */
  async function run(cookies, path = `/admin-view/${ctxObj.ctx}/dashboard`) {
    const locals = {};
    let rewroteTo = null;
    const res = await mw.onRequest(
      {
        request: new Request(`https://x.test${path}`),
        cookies: { get: (n) => (cookies[n] ? { value: cookies[n] } : undefined) },
        locals,
      },
      (to) => { rewroteTo = to ?? '(next)'; return new Response('ok', { status: 200 }); },
    );
    return { status: res.status, locals, rewroteTo };
  }

  const okRun = await run({ [ident.ADMIN_COOKIE]: CRED1 });
  eq('M-1 **welltect_v 無し + 有効な welltect_admin_v → 通る**', okRun.status, 200);
  eq('M-2 locals に代理表示が載る', okRun.locals.adminView?.targetUid, UID_A);
  eq('M-3 selfUid は null（uid を持たない admin）', okRun.locals.adminView?.adminSelfUid, null);
  eq('M-4 内側のページへ rewrite する', okRun.rewroteTo, '/dashboard');

  const withViewer = await run({
    [ident.ADMIN_COOKIE]: CRED1,
    [viewerMod.VIEWER_COOKIE]: await viewerMod.signViewer(UID_B, true),
  });
  eq('M-5 welltect_v が在れば selfUid を拾う', withViewer.locals.adminView?.adminSelfUid, UID_B);

  const nonAdminViewer = await run({
    [ident.ADMIN_COOKIE]: CRED1,
    [viewerMod.VIEWER_COOKIE]: await viewerMod.signViewer(UID_B, false),   // admin フラグ無し
  });
  eq('M-6 **welltect_v が非 admin でも credential が正なら通る**（認可根拠にしない）', nonAdminViewer.status, 200);
  eq('M-7 そのとき selfUid は載せない', nonAdminViewer.locals.adminView?.adminSelfUid, null);

  eq('M-8 **credential が無ければ 403**', (await run({})).status, 403);
  eq('M-9 **別 admin の credential では 403**', (await run({ [ident.ADMIN_COOKIE]: CRED2 })).status, 403);
  eq('M-10 **welltect_v だけでは 403**',
    (await run({ [viewerMod.VIEWER_COOKIE]: await viewerMod.signViewer(UID_B, true) })).status, 403);
  eq('M-11 壊れた credential は 403', (await run({ [ident.ADMIN_COOKIE]: 'a.b.c' })).status, 403);
  eq('M-12 存在しない context は 403',
    (await run({ [ident.ADMIN_COOKIE]: CRED1 }, `/admin-view/${'z'.repeat(43)}/dashboard`)).status, 403);
  eq('M-13 403 のとき locals を汚さない', (await run({})).locals.adminView, undefined);

  // **/admin-view 以外には触れない**（既存の全経路が挙動不変であることの本体）
  const plain = await run({}, '/dashboard');
  eq('M-14 **/admin-view 以外は素通し**', plain.rewroteTo, '(next)');
  eq('M-15 素通しのとき locals を触らない', plain.locals.adminView, undefined);

  // **剥奪**: credential を削除された admin は同じ context に入れない
  const jar2 = new Map([[ident.ADMIN_COOKIE, CRED1]]);
  await ident.issueAdminCred(
    { cookies: { set: (k, v) => jar2.set(k, v), delete: (k) => jar2.delete(k) } },
    'admin.one@example.com', false);
  eq('M-16 **admin から外れたら既存の context にも入れない**',
    (await run(Object.fromEntries(jar2))).status, 403);

  // **API も同じ経路を通る**（U27 の載せ替え先）
  const apiRun = await run({ [ident.ADMIN_COOKIE]: CRED1 }, `/admin-view/${ctxObj.ctx}/api/scan/save`);
  eq('M-17 **/admin-view/<ctx>/api/… も通り、内側の API へ rewrite される**', apiRun.rewroteTo, '/api/scan/save');
  eq('M-18 そのとき locals も載る（＝API 側で代理表示と分かる）', apiRun.locals.adminView?.targetUid, UID_A);
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥-3 read-only — **代理表示からは誰にも書けない**（U27）
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n⑥-3 read-only の保証（U27）\n');
{
  const imperson = { kind: 'admin_impersonation', writeTargetUid: null };
  const self = { kind: 'self', writeTargetUid: UID_B };
  const adminSelf = { kind: 'admin_self', writeTargetUid: UID_B };

  ok('W-1 代理表示は書けない', guard.isReadOnlyViewer(imperson));
  ok('W-2 一般利用者は書ける', !guard.isReadOnlyViewer(self));
  ok('W-3 admin 本人（代理でない）は書ける', !guard.isReadOnlyViewer(adminSelf));
  eq('W-4 代理表示には 403 を返す', guard.denyReadOnlyWrite(imperson)?.status, 403);
  eq('W-5 一般利用者には null（素通し）', guard.denyReadOnlyWrite(self), null);
  // **kind だけ / writeTargetUid だけ、のどちらでも止まる**（片方を消した退行を拾う）
  ok('W-6 writeTargetUid が null なら kind に関わらず止める',
    guard.isReadOnlyViewer({ kind: 'self', writeTargetUid: null }));
  ok('W-7 kind が代理表示なら uid が入っていても止める',
    guard.isReadOnlyViewer({ kind: 'admin_impersonation', writeTargetUid: UID_A }));

  /*
   * **書き込み API が実際に番人を通しているか。**
   * ここを落とすと「read-only と仕様に書いてあるのに書ける」状態に戻る
   * （2026-09-30 の実測: `scan/save` は `selfUid` を使っており **admin 本人へ書いていた**）。
   */
  const WRITERS = [
    ['src/pages/api/scan/save.ts',            'スキャン結果の保存'],
    ['src/pages/api/scan/jobs.ts',            'スキャンの非同期ジョブ'],
    ['src/pages/api/scan/export.ts',          'スキャンの S3 書き出し'],
    ['src/pages/api/interview/export.ts',     'AI 問診の書き出し＋完了記録'],
    ['src/pages/api/kit/[id]/self-report.ts', 'キットの自己申告'],
    ['src/pages/api/notices/[id]/read.ts',    'お知らせの既読化'],
  ];
  for (const [f, label] of WRITERS) {
    const src = code(f);
    ok(`W-8 ${label} が番人を通す`, /denyReadOnlyWrite\(/.test(src), f);
  }
  // **番人は「書く前」に居ること**（後ろだと書いてから 403 を返す）
  for (const [f, label] of WRITERS) {
    const src = code(f);
    const iGuard = src.indexOf('denyReadOnlyWrite(');
    /*
     * **書き込みの目印。** ここに漏れがあると「番人を後ろへ動かす」退行を拾えない
     * （実際 `scan/jobs.ts` は `.insert(` を直接書かず `enqueueScanJob()` を呼ぶだけで、
     *  最初の版では目印 0 件 → 常に PASS になっていた）。
     */
    const WRITE_MARKS = [
      '.insert(', '.update(', '.upsert(', 'putScanExport(', 'saveScanResult(',
      'recordInterviewCompletion(', 'enqueueScanJob(', 'putOriginal(',
    ];
    const hits = WRITE_MARKS.map((w) => src.indexOf(w)).filter((n) => n > 0);
    ok(`W-9a ${label} の書き込み箇所を検出できている`, hits.length > 0,
      '目印が 0 件だとこの検査が素通しになる');
    const iWrite = Math.min(...hits.concat([Number.MAX_SAFE_INTEGER]));
    ok(`W-9 ${label} は書く前に止める`, iGuard > 0 && iGuard < iWrite, `guard@${iGuard} write@${iWrite}`);
  }

  // **client fetch の載せ替えが中央 1 か所に在り、通常の画面では動かないこと**
  const layout = read('src/layouts/BaseLayout.astro');
  ok('W-10 fetch の載せ替えが BaseLayout に 1 か所ある', /window\.fetch = /.test(layout));
  ok('W-11 **/admin-view のときだけ動く**（通常の画面では挙動不変）',
    /if \(!m\) return;/.test(layout) && /admin-view/.test(layout));
  ok('W-12 **同一オリジンの /api/ だけ**載せ替える（外部 API に触れない）',
    /u\.origin === location\.origin/.test(layout) && /startsWith\('\/api\/'\)/.test(layout));
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 紙の上でしか守れない約束（ソースの構造検査）
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n⑦ 構造（GET で claim しない・cred の発行位置・middleware の範囲）\n');
{
  // **GET のページが状態を変えない**。ここが緩むとプリフェッチに券を焼かれる。
  const landing = code('src/pages/admin/handoff/[token].astro');
  const claimSrcEarly = code('src/pages/api/admin/handoff/claim.ts');
  ok('S-1 **GET のページは claim / consume を呼ばない**',
    !/claimHandoff|consumeHandoff|failPendingAttempt/.test(landing));
  ok('S-2 GET のページは Cookie を書かない', !/cookies\.set/.test(landing));
  ok('S-3 GET のページは DB を引かない', !/getServerSupabase|supabase/.test(landing));
  /*
   * **JSON の fetch で叩く**（2026-09-30 に form から変更）。
   * form (`x-www-form-urlencoded`) は origin 検査の対象で、実機で
   * `Cross-site POST form submissions are forbidden` に当たり続けた。
   * JSON は対象外（クロスオリジンは preflight が止まる）。
   * **`<noscript>` の form は残す**（JS 無効時の逃げ道）。
   */
  ok('S-4 claim は POST で叩く', /handoff\/claim/.test(landing));
  ok('S-4a **JSON で叩く**（form-like を避ける）',
    /'Content-Type': 'application\/json'/.test(landing) && /JSON\.stringify\(\{ token/.test(landing));
  ok('S-4b noscript の form も残してある', /<noscript>/.test(landing) && /method="POST"/.test(landing));
  ok('S-4c claim は JSON で来たら JSON を返す（遷移先を自分で持つ）',
    /application\/json/.test(claimSrcEarly) && /next: NEXT|next: '\/admin\/handoff\/continue'/.test(claimSrcEarly));
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
  const mwSrc = code('src/middleware.ts');
  ok('S-12 middleware は /admin-view 以外で即 next()（既存経路に触れない）',
    /parseAdminViewPath/.test(mw) && /if \(!parsed\) return next\(\);/.test(mw));
  ok('S-13 middleware が毎リクエスト本人結合する（admin フラグ + cred + context）',
    /verifyViewer/.test(mw) && /verifyAdminCred/.test(mw) && /resolveImpersonationContext/.test(mw));
  /*
   * **見るのは /admin-view の分岐だけ**（2026-09-30 更新）。
   * middleware には外部共有の解決も入ったので、ファイル全体に `/dashboard` の語が
   * 出る（share のアクセス記録の対象ページ表）。**S-14 が守りたいのは
   * 「代理表示が失敗したときに self / share へ落ちないこと」**なので、
   * `parseAdminViewPath` 以降に絞る。**緩めていない** — 対象を正確にしただけ。
   */
  const mwAdminView = mw.slice(mw.indexOf('const parsed = parseAdminViewPath('));
  ok('S-14 **失敗したら 403。self / share へ落とさない**',
    /return forbidden\(\);/.test(mwAdminView) && !/redirect|\/dashboard/.test(mwAdminView));
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

  /*
   * **`/admin-view/…` の受け皿ルートが在ること**（2026-09-30・本番で実測した障害）。
   *
   * middleware だけでは **Vercel のルートが生成されない**。Astro のページが
   * 1 つも無いと `.vercel/output/config.json` の `admin-view` が **0 件**になり、
   * **CDN が 404 を返して SSR 関数に届かない** = middleware が動かず
   * **代理表示が丸ごと死ぬ**（本番で `GET /admin-view/<ctx>/dashboard` が 404 だった）。
   *
   * **この検査は middleware を直接呼んでいたので、そこへ到達するかを見ていなかった。**
   */
  const FALLBACK = 'src/pages/admin-view/[ctx]/[...rest].astro';
  let fbSrc = '';
  try { fbSrc = read(FALLBACK); } catch { /* 無い */ }
  ok('S-26 **/admin-view/<ctx>/… の受け皿ページが在る**（無いと CDN が 404 で middleware に届かない）',
    fbSrc !== '', FALLBACK);
  ok('S-27 受け皿は fail-closed（middleware を通らずに来たら 403・中身を描かない）',
    /status:\s*403/.test(fbSrc) && !/Astro\.params\.ctx/.test(stripComments(fbSrc)), '');

  /*
   * **受け渡し券の飛び先を `request.url` から組まないこと**（2026-09-30・実機で発覚）。
   *
   * 本番で **`https://localhost/admin/handoff/<token>`** が返っていた。
   * **Vercel の SSR では `request.url` がプロキシ内側の URL になる**
   * （2026-09-04 に QR で踏んだのと同じ罠・`src/lib/public-url.ts` 冒頭）。
   * ここが壊れると**押しても何も開かない**ので、実機でしか気づけない。
   */
  const issuer = code('src/pages/api/admin/impersonation/handoff.ts');
  ok('S-28 **`new URL(request.url).origin` を絶対 URL の基点にしない**',
    !/new URL\(request\.url\)\.origin/.test(issuer));
  ok('S-29 転送ヘッダを見る `publicOrigin()` を使う', /publicOrigin\(request\)/.test(issuer));
  ok('S-30 **`path` も返す**（中継が自分の base と組めるように）',
    /path,/.test(issuer) && /\/admin\/handoff\/\$\{issued\.token\}/.test(issuer));

  /*
   * **origin 検査を Astro から引き取ったこと**（2026-09-30・実機で発覚）。
   * Astro は `url.origin`（本番ではプロキシ内側の `https://localhost`）と比べるので
   * **isSameOrigin が常に false = 検査が「常に拒否」に化けていた**。
   */
  ok('S-31 Astro 標準の origin 検査を切ってある', /checkOrigin:\s*false/.test(read('astro.config.mjs')));
  ok('S-32 **代わりに middleware が publicOrigin で同じ検査をする**',
    /originGuard/.test(mwSrc) && /publicOrigin\(request\)/.test(mwSrc));
  ok('S-33 検査は全リクエストに掛かる（代理表示の判定より前）',
    mwSrc.indexOf('originGuard(context.request)') < mwSrc.indexOf('parseAdminViewPath(new URL'));
  ok('S-35 **拒否の文言に出所が入る**（Astro が出したのか自前かを実機で区別できる）',
    /welltect-origin-guard/.test(mwSrc));
  ok('S-34 Astro と同じ集合を使う（緩めていない）',
    /application\/x-www-form-urlencoded/.test(mwSrc) && /multipart\/form-data/.test(mwSrc)
    && /text\/plain/.test(mwSrc) && /'GET', 'HEAD', 'OPTIONS'/.test(mwSrc));
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

/* ══════════════════════════════════════════════════════════════════════
 * ⑬ 画面のリンクが prefix を落としていないか（**ここは静かに壊れる**）
 *
 * 【なぜ要るか】L-7 / L-8 は `viewerPathPrefix()` という**関数の戻り値**しか
 * 見ていなかった。「各ページが実際にそれを使っているか」を見る検査が 1 本も
 * 無く、**実際に 11 か所で付け忘れていた**（2026-10-07 の実障害）。
 *
 * 実害の形: 承認メニューの「確認」→ 代理表示で A さんの紙面を開き、その同じ
 * タブで「PDF にして保存する」を押すと、飛び先が素の `/report?print=1` なので
 * `middleware.ts`（`/admin-view/` 以外には触らない）を通らず、
 * **admin 本人の、しかも未承認の報告書が PDF になっていた**。
 * 仕様書 §13.0 が「admin が『A さんの画面のつもりで自分の画面を見る』のが
 * 最悪の事故」と名指ししている形そのもの。
 *
 * 【見かた】コメントを落としたうえで、**文字列リテラルの先頭が内部ルートで
 * 始まるもの**を拾う。prefix が付いていれば直前が `}`（`${linkPrefix}/report`）
 * になるので、引用符の直後に `/report` が来るものだけが「素のパス」。
 * 短い語の部分一致に頼らない = 言い換えでごまかせない。
 *
 * 【ALLOW には理由を書く】理由を書けないものは通さない。しかも ALLOW した行が
 * 安全であり続けることを**別の検査で裏打ちする**（描いていないはずの
 * コンポーネントが復活していないか / 既定値を上書きする呼び出しが在るか）。
 * ════════════════════════════════════════════════════════════════════ */
console.log('\n⑬ 画面のリンクが代理表示の prefix を落としていないか\n');
{
  /** 利用者向けの内部ルート。`/admin-view/<ctx>` を前に付けないと代理表示から抜ける。 */
  const ROUTES = ['dashboard', 'report', 'result', 'trend', 'kit', 'scan', 'chat', 'coach', 'notices'];
  const BARE = new RegExp(`(["'\`])(/(?:${ROUTES.join('|')}))(?![A-Za-z0-9_-])`, 'g');

  /**
   * **理由つきの ALLOW。** `file` と `needle`（その行に必ず含まれる文字列）で狙い撃つ。
   * 行番号は使わない（1 行ずれるだけで検査が無言で緩むため）。
   */
  const ALLOW = [
    // AppNav の「いま居るページ」マーカー。リンクではない（`href` に入らない）。
    { file: '*', needle: 'current="/', why: 'AppNav の現在ページ判定。href ではない' },
    // サインイン前・代理表示を抜ける導線。**ここは本物の `/dashboard` へ行くのが正しい。**
    { file: 'src/pages/index.astro', needle: 'const target =', why: '素の `/` を `/dashboard` へ 302 する入口そのもの。viewer はまだ無い' },
    { file: 'src/components/EmailPasswordAuth.astro', needle: 'SIGNUP_REDIRECT', why: 'サインアップ後の戻り先。認証前なので代理表示は存在しない' },
    { file: 'src/components/EmailPasswordAuth.astro', needle: "url.pathname === '/'", why: '同上（サインイン後の遷移先の既定）' },
    { file: 'src/components/GoogleOneTap.astro', needle: "url.pathname === '/'", why: '同上（Google サインイン後の遷移先の既定）' },
    { file: 'src/components/ImpersonationBanner.astro', needle: 'window.location.replace', why: '「代理表示をやめる」。**抜けるのが目的**なので prefix を付けない' },
    { file: 'src/components/ShareBanner.astro', needle: 'window.location.replace', why: '共有セッションを抜ける導線。同上' },
    // 管理者だけに出るデバッグ欄。素の `?u=` で検体を切り替えるための切り分け導線。
    { file: 'src/pages/dashboard.astro', needle: 'class="chip"', why: 'admin 専用デバッグ欄の検体切替。意図して素のパス' },
    // dashboard.astro が必ず上書きする Props の既定値（下の L-15 が裏打ち）。
    { file: 'src/components/dashboard/ProgressSection.astro', needle: 'detailHref =', why: 'Props の既定値。dashboard.astro が prefix 付きで必ず渡す（L-15）' },
    { file: 'src/components/dashboard/KitProgressCard.astro', needle: 'detailHref =', why: 'Props の既定値。同上（L-15）' },
    // 画面に描いていないコンポーネント（下の L-16 / L-17 が裏打ち）。
    { file: 'src/components/dashboard/HealthInsightCard.astro', needle: '/chat', why: 'dashboard.astro で描いていない（L-16）' },
    { file: 'src/components/dashboard/HealthCoachPreview.astro', needle: '/coach', why: 'どこからも import されていない（L-17）' },
    { file: 'src/components/dashboard/TestHistoryList.astro', needle: '/result/', why: 'どこからも import されていない（L-17）' },
  ];

  /** 利用者向けのファイルだけを見る（`src/pages/admin/**` と API は対象外）。 */
  const lsAstro = (dir) => {
    let out = [];
    for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.astro')) out.push(`${dir}/${e.name}`);
    }
    return out;
  };
  const FILES = [
    ...lsAstro('src/pages'),
    ...lsAstro('src/pages/result'),
    ...lsAstro('src/components'),
    ...lsAstro('src/components/dashboard'),
    'src/scripts/chat/live-controller.ts',
  ];

  /** 行コメント・ブロックコメント・JSX コメントを落とす（文章中の `/report` を拾わない）。 */
  const stripForLinkScan = (src) => src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((ln) => (/^\s*(\*|\/\/)/.test(ln) ? '' : ln.replace(/\/\/.*$/, '')))
    .join('\n');

  const hits = [];
  for (const f of FILES) {
    const lines = stripForLinkScan(read(f)).split('\n');
    lines.forEach((ln, i) => {
      if (!BARE.test(ln)) return;
      BARE.lastIndex = 0;
      const allowed = ALLOW.some((a) => (a.file === '*' || a.file === f) && ln.includes(a.needle));
      if (!allowed) hits.push(`${f}:${i + 1} ${ln.trim().slice(0, 100)}`);
    });
  }
  ok('L-12 **素の内部パスが 1 本も無い**（prefix を落としたリンクはそのタブだけ代理表示から抜ける）',
    hits.length === 0, hits.join('\n    '));

  // 検査そのものが空振りしていないこと（ALLOW を全部外せば必ず当たる = 走っている証拠）。
  const sanity = [];
  for (const f of FILES) {
    const lines = stripForLinkScan(read(f)).split('\n');
    for (const ln of lines) { if (BARE.test(ln)) sanity.push(f); BARE.lastIndex = 0; }
  }
  ok('L-13 検査が実際に走っている（ALLOW 抜きなら検出がある）', sanity.length > 0);

  // **prefix を使うべきページが全部使っていること。** import 漏れを拾う。
  const needPrefix = [
    'src/pages/dashboard.astro', 'src/pages/report.astro', 'src/pages/kit.astro',
    'src/pages/trend.astro', 'src/pages/scan.astro', 'src/pages/chat.astro',
    'src/pages/coach.astro', 'src/pages/notices.astro', 'src/pages/result/[id].astro',
  ];
  const noPrefix = needPrefix.filter((f) => !/viewerPathPrefix\(/.test(read(f)));
  ok('L-14 利用者向けページは全部 `viewerPathPrefix()` を引いている', noPrefix.length === 0, noPrefix.join(', '));

  // ALLOW の裏打ち ①: Props の既定値は呼び出し側が prefix 付きで上書きする。
  const dash = code('src/pages/dashboard.astro');
  ok('L-15 `detailHref` を prefix 付きで渡している（既定値 `/kit` に落ちない）',
    /detailHref=\{`\$\{linkPrefix\}\/kit/.test(dash), 'dashboard.astro が detailHref を渡していない');

  // ALLOW の裏打ち ②: 描いていないコンポーネントが復活していないか。
  // **コメントアウトを外したら落ちる** = そのとき prefix を足す判断を強制する。
  for (const c of ['HealthInsightCard', 'SituationalCards']) {
    ok(`L-16 ${c} は画面に描かれていない（復活させたら prefix を足す）`,
      !new RegExp(`^(?!\\s*(\\*|//|\\{/\\*)).*<${c}[\\s/>]`, 'm').test(stripForLinkScan(read('src/pages/dashboard.astro'))),
      `${c} が描かれている。リンクの prefix を足してから ALLOW を外すこと`);
  }
  // ALLOW の裏打ち ③: 未参照のコンポーネントが import されていないか。
  for (const c of ['HealthCoachPreview', 'TestHistoryList', 'MetricCard']) {
    const refs = execSync(`grep -rl "${c}" src/pages src/components || true`, { cwd: ROOT })
      .toString().trim().split('\n').filter((x) => x && !x.endsWith(`${c}.astro`));
    ok(`L-17 ${c} はどこからも import されていない（使うなら prefix を足す）`,
      refs.length === 0, refs.join(', '));
  }

  // 問診完了画面のリンクは**サーバから prefix を受け取る**（uid から組み立てない）。
  ok('L-18 `live-controller` は `dashboardLinkPrefix` を使う',
    /dashboardLinkPrefix/.test(read('src/scripts/chat/live-controller.ts')));
  ok('L-19 `chat.astro` が `dashboardLinkPrefix` を渡している',
    /data-dashboard-link-prefix=\{linkPrefix\}/.test(read('src/pages/chat.astro'))
    && /dashboardLinkPrefix,/.test(read('src/pages/chat.astro')));

  // 報告書の「PDF にして保存する」= 実害が出た導線。**ここだけは名指しで固定する。**
  const rep = code('src/pages/report.astro');
  ok('L-20 **報告書の `q()` が prefix を前に付ける**（PDF ボタンの飛び先。2026-10-07 の実障害）',
    /return s \? `\$\{linkPrefix\}\/report\?\$\{s\}` : `\$\{linkPrefix\}\/report`/.test(rep),
    'q() が素の /report を返している');
  ok('L-21 PDF ボタンの href 書き換えが素のパスへ落ちない（取れなければ何もしない）',
    !/getAttribute\('href'\) \?\? '\/report'/.test(rep));
}

console.log('');
if (fails.length) {
  console.error(`✗ ${fails.length} 件 失敗\n` + fails.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log('✓ すべて PASS');
