/**
 * **スペシャルアカウント 追加検査・Elith 納品まわりの共有テストハーネス。**
 *
 * `verify:special-additional-tests` と `verify:special-account-management` の
 * 両方がここを使う。**実装を 2 つ持たない** (`public/admin/pdf-pages.js` と同じ流儀)。
 *
 * やっていること: 実物の TS を esbuild でバンドルし、**DB / S3 / 原本 / 認可だけ**を
 * スタブへ差し替えて**実際に動かす**。鍵もサーバも要らない = CI の A 層。
 * **実装側は 1 行も差し替えない。**
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const CACHE = 'node_modules/.cache';
mkdirSync(resolve(ROOT, CACHE), { recursive: true });
export const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
/** コメント行を落とす (経緯の説明に旧コードが載っているので、そこを拾わない)。 */
export const code = (p) => read(p).split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');
/** コメントに加えて **import 行も**落とす。モジュール名との偶然の一致を拾わないため。 */
export const body = (p) => code(p).split('\n').filter((ln) => !/^\s*import\b/.test(ln)).join('\n');

export const fails = [];
export const ok = (label, cond, why) => {
  if (!cond) fails.push(`${label}${why ? ` — ${why}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
};
export const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);

export const UID_A = 'aaaaaaaa-1111-4111-8111-111111111111'; // スペシャルアカウント
export const UID_B = 'bbbbbbbb-2222-4222-8222-222222222222'; // 一般顧客 (対象外)

/* ══════════════════════════════════════════════════════════════════════
 * スタブ (DB / S3 / 原本 / 認可) — **実装の方は 1 行も差し替えない**
 * ════════════════════════════════════════════════════════════════════ */

const SUPABASE_STUB = `
import { randomUUID } from 'node:crypto';
export const TABLES = {};
export const WRITES = [];
export const FAIL = { insert: null, update: null, select: null, noServer: false };
export function reset() { for (const k of Object.keys(TABLES)) delete TABLES[k]; WRITES.length = 0; FAIL.insert = null; FAIL.update = null; FAIL.select = null; FAIL.noServer = false; }
const rows = (t) => (TABLES[t] ??= []);
const match = (r, fs) => fs.every(([op, c, v]) => op === 'in' ? v.includes(r[c] ?? null) : (r[c] ?? null) === v);

function q(name, filters, action, payload, opts) {
  const run = async () => {
    if (action === 'select') {
      // **1 本だけ引けない**状況を作る (表が未作成・権限が無い 等)。
      if (FAIL.select === name) return { data: null, error: { message: 'stub select failure' } };
      return { data: rows(name).filter((r) => match(r, filters)), error: null };
    }
    if (action === 'insert' || action === 'upsert') {
      if (FAIL.insert === name) return { data: null, error: { message: 'stub insert failure' } };
      const list = Array.isArray(payload) ? payload : [payload];
      const out = [];
      for (const v of list) {
        if (action === 'upsert' && opts?.onConflict) {
          const cols = String(opts.onConflict).split(',').map((s) => s.trim());
          const hit = rows(name).find((r) => cols.every((c) => (r[c] ?? null) === (v[c] ?? null)));
          if (hit) { Object.assign(hit, v); WRITES.push({ table: name, op: 'upsert-update' }); out.push(hit); continue; }
        }
        const row = { id: randomUUID(), created_at: new Date().toISOString(), ...v };
        rows(name).push(row);
        WRITES.push({ table: name, op: action });
        out.push(row);
      }
      return { data: out, error: null };
    }
    if (action === 'update') {
      if (FAIL.update === name) return { data: null, error: { message: 'stub update failure' } };
      const hit = rows(name).filter((r) => match(r, filters));
      hit.forEach((r) => Object.assign(r, payload));
      WRITES.push({ table: name, op: 'update', cols: Object.keys(payload) });
      return { data: hit, error: null };
    }
    if (action === 'delete') {
      const keep = rows(name).filter((r) => !match(r, filters));
      const removed = rows(name).length - keep.length;
      TABLES[name] = keep;
      WRITES.push({ table: name, op: 'delete', removed });
      return { data: null, error: null };
    }
    return { data: null, error: { message: 'unknown action' } };
  };
  const api = {
    eq: (c, v) => q(name, [...filters, ['eq', c, v]], action, payload, opts),
    in: (c, v) => q(name, [...filters, ['in', c, v]], action, payload, opts),
    order: () => q(name, filters, action, payload, opts),
    limit: () => q(name, filters, action, payload, opts),
    select: () => q(name, filters, action, payload, opts),
    maybeSingle: async () => { const r = await run(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }; },
    single: async () => { const r = await run(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }; },
    then: (res, rej) => run().then(res, rej),
  };
  return api;
}

const table = (name) => ({
  select: () => q(name, [], 'select', null, null),
  insert: (v) => q(name, [], 'insert', v, null),
  upsert: (v, o) => q(name, [], 'upsert', v, o),
  update: (v) => q(name, [], 'update', v, null),
  delete: () => q(name, [], 'delete', null, null),
});

export function getServerSupabase() { return FAIL.noServer ? null : { schema: () => ({ from: table }) }; }
export function getBridgeSupabase() { return null; }
export function isBridgeConfigured() { return false; }
export function getBrowserSupabase() { return null; }
export function getStagingBridgeEndpoint() { return null; }
`;

const S3_STUB = `
export const S3 = new Map();
export const STATE = { prefix: 'scan-accuracy-test/', configured: true, putFail: false, corruptPut: false };
/** **GET / PUT の実回数**。putVerified の「1 ファイルあたり最大 2 回」を実測するため (V-1)。 */
export const COUNTS = { get: 0, put: 0 };
export function reset() { S3.clear(); STATE.prefix = 'scan-accuracy-test/'; STATE.configured = true; STATE.putFail = false; STATE.corruptPut = false; COUNTS.get = 0; COUNTS.put = 0; }
export function getS3Config() { return STATE.configured ? { bucket: 'stub-bucket', region: 'ap-northeast-1', prefix: STATE.prefix } : null; }
export function isS3Configured() { return STATE.configured; }
export function makeS3Client() { throw new Error('not in stub'); }
export async function listObjects(prefix) {
  return [...S3.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: S3.get(key).length }));
}
export async function getObjectText(key) {
  COUNTS.get += 1;
  if (!S3.has(key)) throw new Error('NoSuchKey: ' + key);
  return S3.get(key);
}
export async function putFiles(files) {
  COUNTS.put += files.length;
  if (STATE.putFail) throw new Error('stub put failure');
  // **書けたのに中身が違う**状況 (S3 側で壊れた・別プロセスが上書きした) を作る。
  // 読み戻し検証が本当に効いているかは、これでしか測れない。
  for (const f of files) S3.set(f.key, STATE.corruptPut ? String(f.body) + ' /*corrupt*/' : String(f.body));
  return files.map((f) => ({ key: f.key, bytes: f.bytes, uri: 's3://stub-bucket/' + f.key }));
}
export async function copyObjects(pairs) { for (const p of pairs) S3.set(p.to, S3.get(p.from)); return pairs.length; }
export async function deleteObjects(keys) { let n = 0; for (const k of keys) { if (S3.delete(k)) n += 1; } return n; }
`;

/**
 * **原本まわりのスタブ。** `@aws-sdk` の署名器を回さずに、
 * 「S3 の実体から SHA256 を取る」という**振る舞いだけ**を再現する。
 * 定数と `isSha256Base64` は本物と同じ値にしてあり、
 * 「本物が変わっていないこと」は下の構造チェック (B-8) で別に見る。
 */
const ORIGINALS_STUB = `
import { createHash } from 'node:crypto';
export const ORIGINALS = new Map();   // key -> Uint8Array
export const SIGNED = [];             // 署名を出したキー
export function reset() { ORIGINALS.clear(); SIGNED.length = 0; }
export const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;
export const PRESIGN_EXPIRES_SEC = 900;
export const ORIGINAL_COMPANIES = ['rieger', 'prevent', 'genoplan', 'laif'];
const SHA256_B64_RE = /^[A-Za-z0-9+/]{43}=$/;
export function isSha256Base64(v) { return typeof v === 'string' && SHA256_B64_RE.test(v); }
export function contentTypeOf(name) { return /\\.pdf$/i.test(name) ? 'application/pdf' : /\\.csv$/i.test(name) ? 'text/csv' : null; }
export function safeBaseName(v) { return typeof v === 'string' ? v.split(/[/\\\\]/).pop() : null; }
export function buildOriginalKey(company, fileName) { return 'lab_results/' + company + '/2026/09/' + fileName; }
export function isOriginalUploadKey(key) { return typeof key === 'string' && /^lab_results\\/[a-z]+\\/\\d{4}\\/\\d{2}\\/[^/]+$/.test(key); }
export async function signOriginalPut({ key, contentType, bytes, sha256Base64 }) {
  SIGNED.push(key);
  return { ok: true, url: 'https://stub/' + key, key, storageUrl: 's3://stub-originals/' + key,
    expiresIn: PRESIGN_EXPIRES_SEC, headers: { 'content-type': contentType, 'x-amz-checksum-sha256': sha256Base64 },
    signedHeaders: 'content-type;x-amz-checksum-sha256', bytes };
}
export async function createOriginalUploadTicket() { return { ok: false, error: 'not_in_stub' }; }
export async function readUploadedOriginal(key) {
  const b = ORIGINALS.get(key);
  if (!b) return { ok: false, error: 'not_found', detail: key };
  return { ok: true, bytes: b, sha256: createHash('sha256').update(b).digest('hex'),
    sizeBytes: b.byteLength, contentType: 'application/pdf', storageUrl: 's3://stub-originals/' + key };
}
`;

const ORIGINALS_STORAGE_STUB = `
import { createHash } from 'node:crypto';
export function getOriginalsS3Config() { return { bucket: 'stub-originals', region: 'ap-northeast-1', prefix: '' }; }
export function sha256Hex(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export async function putOriginal() { throw new Error('not in stub'); }
`;

const API_AUTH_STUB = `
export const AUTH = { ok: true };
export function isAdminAuthorized() { return AUTH.ok; }
export function isLabIntakeAuthorized() { return AUTH.ok; }
`;

const files = {
  'sat-supabase-stub.mjs': SUPABASE_STUB,
  'sat-s3-stub.mjs': S3_STUB,
  'sat-originals-stub.mjs': ORIGINALS_STUB,
  'sat-originals-storage-stub.mjs': ORIGINALS_STORAGE_STUB,
  'sat-api-auth-stub.mjs': API_AUTH_STUB,
};
for (const [name, body] of Object.entries(files)) writeFileSync(resolve(ROOT, CACHE, name), body);
export const stubUrl = (n) => pathToFileURL(resolve(ROOT, CACHE, n)).href;
/**
 * バンドル結果の import URL。**相対パスで書かない** — このファイルが
 * `scripts/lib/` へ移った時点で `../node_modules/...` が指す先がずれて
 * `ERR_MODULE_NOT_FOUND` になった (実測)。ROOT からの絶対 URL にする。
 */
const built = (rel) => `${pathToFileURL(resolve(ROOT, CACHE, 'sat', rel)).href}?t=${Date.now()}`;

async function bundle() {
  await build({
    entryPoints: [
      'src/lib/additional-originals.ts',
      'src/lib/elith-delivery-json.ts',
      'src/lib/special-additional-tests.ts',
      'src/lib/account-progress.ts',
      'src/lib/s3-verified-put.ts',
      'src/lib/elith-manual-delivery.ts',
      'src/lib/elith-delivery-runs.ts',
      'src/pages/api/admin/special-accounts/deliver-one.ts',
      'src/pages/api/admin/lab-results/register.ts',
      'src/pages/api/admin/special-additional-tests/finalize.ts',
      'src/pages/api/admin/special-additional-tests/original-ticket.ts',
    ],
    bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
    // `SPECIAL_ALLOWED_UIDS` を渡して **本物の `isSpecialAccount()`** を動かす
    // (「そう書いてあるか」でなく実際の判定を見る)。
    define: { 'import.meta.env': JSON.stringify({ DEV: false, SPECIAL_ALLOWED_UIDS: UID_A }) },
    outdir: `${CACHE}/sat`, outbase: 'src', outExtension: { '.js': '.mjs' },
    plugins: [{
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /(^|\/)supabase$/ }, () => ({ path: stubUrl('sat-supabase-stub.mjs'), external: true }));
        b.onResolve({ filter: /(^|\/)s3$/ }, () => ({ path: stubUrl('sat-s3-stub.mjs'), external: true }));
        b.onResolve({ filter: /(^|\/)originals-upload-ticket$/ }, () => ({ path: stubUrl('sat-originals-stub.mjs'), external: true }));
        b.onResolve({ filter: /(^|\/)originals-storage$/ }, () => ({ path: stubUrl('sat-originals-storage-stub.mjs'), external: true }));
        b.onResolve({ filter: /(^|\/)api-auth$/ }, () => ({ path: stubUrl('sat-api-auth-stub.mjs'), external: true }));
      },
    }],
  });
  return {
    addOrig: await import(built('lib/additional-originals.mjs')),
    deliv: await import(built('lib/elith-delivery-json.mjs')),
    sat: await import(built('lib/special-additional-tests.mjs')),
    progress: await import(built('lib/account-progress.mjs')),
    vput: await import(built('lib/s3-verified-put.mjs')),
    manual: await import(built('lib/elith-manual-delivery.mjs')),
    runs: await import(built('lib/elith-delivery-runs.mjs')),
    deliverOne: await import(built('pages/api/admin/special-accounts/deliver-one.mjs')),
    register: await import(built('pages/api/admin/lab-results/register.mjs')),
    finalize: await import(built('pages/api/admin/special-additional-tests/finalize.mjs')),
    /*
     * **原本チケットの口も実際に動かす。** `isSpecialAccount()` は同期なので
     * 呼ぶ前に `refreshConfig()` が要る — それが抜けていて本番で 10/10 全員が
     * `not_special_account` になった (2026-10-06)。静的検査では捕まらないので、
     * **cold cache から app_config を引き直せるか**を実行で見る。
     */
    ticket: await import(built('pages/api/admin/special-additional-tests/original-ticket.mjs')),
    /*
     * **スタブはキャッシュを割らずに import する。** `?t=` を付けると
     * Node が別のモジュール実体を作り、バンドル側が見ている Map と
     * **別物**になる (原本を置いたのに `not_found` になる)。
     * スタブの中身は変わらないので割る必要が無い。
     */
    db: await import(stubUrl('sat-supabase-stub.mjs')),
    s3: await import(stubUrl('sat-s3-stub.mjs')),
    orig: await import(stubUrl('sat-originals-stub.mjs')),
  };
}

export const M = await bundle();

/* ── 共通のお膳立て ─────────────────────────────────────────────── */

export const PDF = new TextEncoder().encode('%PDF-1.7 stub original');
export const PDF2 = new TextEncoder().encode('%PDF-1.7 a different original');
export const shaHex = (b) => createHash('sha256').update(b).digest('hex');
export const shaB64 = (b) => createHash('sha256').update(b).digest('base64');

export function resetAll() {
  M.db.reset();
  M.s3.reset();
  M.orig.reset();
}

/** 原本を「ブラウザが PUT 済み」の状態にする。 */
export function putOriginal(key, bytes) { M.orig.ORIGINALS.set(key, bytes); }

const req = (body) => new Request('https://x/api', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
export const call = async (mod, body) => {
  const res = await mod.POST({ request: req(body) });
  return { status: res.status, json: await res.json() };
};

/** measurement 型 1 ページぶんの part（scan-part の応答と同じ形）。 */
export const bloodPart = (page = 1) => ({
  page,
  measurements: [
    { name: 'AST(GOT)', value: '22', unit: 'U/L', ref_low: '13', ref_high: '30' },
    { name: 'ALT(GPT)', value: '18', unit: 'U/L', ref_low: '10', ref_high: '42' },
  ],
  notes: [],
  raw_markdown: `| 検査項目 | 今回 |\n|---|---|\n| AST | 22 |  (page ${page})`,
});
export const itemsPart = (page = 1) => ({
  page, section: `section ${page}`,
  items: [{ disease: '糖尿病', risk: 'B' }],
  raw: `page ${page} raw`,
});

/*
 * **`deliver: true` を明示している** (2026-10-01・D-3)。
 * `finalize` のサーバ側の既定は「納品しない」へ反転した
 * (`docs/specs/special_account_management_spec_20261001.md` §12.2) ので、
 * 納品経路 (読み戻し検証 / SHA 突合 / 納品履歴) を動かすテストは明示が要る。
 * **既定が納品でないこと自体**は同 spec §23 D-16〜D-18 =
 * `verify:special-account-management` が見張る。
 */
export const BASE = { diagnosticUserId: UID_A, originalKey: null, deliver: true };

export async function finalizeBlood(over = {}) {
  const key = M.addOrig.buildAdditionalOriginalKey({
    uid: UID_A, testType: 'blood', testDate: over.testDate ?? '2025-08-04', sha256Hex: shaHex(PDF),
  });
  putOriginal(key, PDF);
  return call(M.finalize, {
    ...BASE, testType: 'blood', testDate: '2025-08-04', originalKey: key,
    parts: [bloodPart(1), bloodPart(2)], ...over,
  });
}
