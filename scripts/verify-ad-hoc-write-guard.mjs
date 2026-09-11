#!/usr/bin/env node
/**
 * 臨時診断バッチの **Elith S3 実書き込みゲート** の回帰チェック (Phase A・2026-09-11)。
 *
 * 【なぜ要るか】この経路は **静かに壊れる**。
 *   - ゲートが外れても画面は今までどおり動く (むしろ「書けた」ように見える)。
 *   - 書いてしまってから気づいても、Elith 納品領域の実データは戻せない。
 *   - 上書きは「成功」として返るので、消えたことに誰も気づけない。
 * 目視では守れないので機械で固定する。
 *
 * **外部 AWS / DB / Vercel を一切使わない。** 実物 (`write-guard.ts`) を transpile し、
 * `@aws-sdk/client-s3` と `../s3` をスタブへ差し替えて動かす。
 * S3 への PUT は 1 回も発生しない (スタブが呼び出しを数えるだけ)。
 *
 * 実行: node scripts/verify-ad-hoc-write-guard.mjs
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
  JSON.stringify(got) === JSON.stringify(want)
    ? ok(label)
    : bad(label, `got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);

// --- テスト専用の値 (実バケット・実 prefix は使わない) -----------------------------
const BUCKET = 'verify-only-bucket';
const PREFIX = 'verify-only-prefix/';
const TARGET = `s3://${BUCKET}/${PREFIX}`;
const CID = 'aaaaaaaa-1111-2222-3333-444444444444';
const CID2 = 'bbbbbbbb-5555-6666-7777-888888888888';

// --- 実物を transpile --------------------------------------------------------------
const ts = (await import('typescript')).default;
const CACHE = resolve(ROOT, 'node_modules/.cache');
mkdirSync(CACHE, { recursive: true });
const emit = (name, src) => {
  const out = resolve(CACHE, name);
  writeFileSync(out, ts.transpileModule(src, { compilerOptions: { target: 'ES2022', module: 'ESNext' } }).outputText);
  return out;
};

// `../s3` と `@aws-sdk/client-s3` のスタブ。**呼び出しを記録するだけで何も送らない。**
const stubPath = emit('verify-write-guard-stubs.mjs', `
export const __state = {
  cfg: { bucket: ${JSON.stringify(BUCKET)}, region: 'test-region', prefix: ${JSON.stringify(PREFIX)} },
  existing: new Set(),       // HeadObject が「在る」と答える key
  headThrows: null,          // 存在確認そのものを失敗させる
  puts: [],                  // PutObject の入力を全部ためる
  heads: [],
};
export function getS3Config() { return __state.cfg; }
export function makeS3Client() {
  return {
    async send(cmd) {
      if (cmd.__kind === 'head') {
        __state.heads.push(cmd.input.Key);
        if (__state.headThrows) throw __state.headThrows;
        if (__state.existing.has(cmd.input.Key)) return {};
        const e = new Error('NotFound'); e.name = 'NotFound'; e.$metadata = { httpStatusCode: 404 };
        throw e;
      }
      __state.puts.push(cmd.input);
      return {};
    },
  };
}
export class HeadObjectCommand { constructor(input) { this.input = input; this.__kind = 'head'; } }
export class PutObjectCommand  { constructor(input) { this.input = input; this.__kind = 'put'; } }
`);

let src = read('src/lib/ad-hoc-diagnosis/write-guard.ts')
  .replace(/import \{ HeadObjectCommand, PutObjectCommand \} from '@aws-sdk\/client-s3';/,
    `import { HeadObjectCommand, PutObjectCommand } from ${JSON.stringify(stubPath)};`)
  .replace(/import \{ getS3Config, makeS3Client, type S3Config \} from '\.\.\/s3';/,
    `import { getS3Config, makeS3Client } from ${JSON.stringify(stubPath)};`)
  .replace(/import type \{ DeliveryFile \} from '\.\/pipeline';\n/, '')
  .replace(/import\.meta as unknown as \{ env\?: Record<string, string \| undefined> \}\)\.env/g,
    'globalThis.__env)');
for (const [label, needle] of [['aws sdk', 'HeadObjectCommand'], ['../s3', 'getS3Config']]) {
  if (!src.includes(stubPath)) bad(`verify 自体: ${label} の import を差し替えられなかった`);
}
if (src.includes("from '../s3'") || src.includes("from '@aws-sdk/client-s3'")) {
  bad('verify 自体: 実物の import が残っている (差し替え漏れ)');
}
const guardPath = emit('verify-write-guard.mjs', src);

globalThis.__env = {};
const STUBS = await import(stubPath);
const G = await import(`${guardPath}?t=${Date.now()}`);

// --- テスト用の納品ファイル --------------------------------------------------------
const key = (cid, fmt, d) => `${PREFIX}user/${cid}/date/${d}/${fmt}_date_${d}_user_${cid}.json`;
const file = (cid, fmt, iso) => ({
  key: key(cid, fmt, iso.replace(/-/g, '_')),
  formatId: fmt,
  testDate: iso,
  body: '{}',
  bytes: 2,
});
const DELIVERY = [
  file(CID, 'HealthCheckupData', '2026-03-29'),
  file(CID, 'LifestyleQuestionnaireData', '2026-03-29'),
  file(CID2, 'HealthCheckupData', '2026-04-01'),
];

function reset() {
  globalThis.__env = {};
  STUBS.__state.existing = new Set();
  STUBS.__state.headThrows = null;
  STUBS.__state.puts = [];
  STUBS.__state.heads = [];
}
const enable = (target = TARGET) => {
  globalThis.__env.AD_HOC_ELITH_WRITE_ENABLED = 'on';
  globalThis.__env.AD_HOC_ELITH_WRITE_TARGET = target;
};
const gate = (delivery = DELIVERY, skipped = []) => G.checkWriteGate({ delivery, skipped });

console.log('\n=== A. dryRun 相当 — ゲートを呼ばなければ書き込み系は 0 回 ===');
{
  reset();
  // dry-run は service.ts が `checkWriteGate` より前で return する形。
  // ここでは「ゲートを通さない限り PUT も Head も起きない」ことを固定する。
  eq('PutObject 0 回', STUBS.__state.puts.length, 0);
  eq('HeadObject 0 回', STUBS.__state.heads.length, 0);
  const srcSvc = read('src/lib/ad-hoc-diagnosis/service.ts');
  const iDry = srcSvc.indexOf('if (input.dryRun)');
  const iGate = srcSvc.indexOf('checkWriteGate(');
  eq('dry-run の return が ゲートより前にある', iDry >= 0 && iGate > iDry, true);
}

console.log('\n=== B. WRITE_ENABLED 未設定 → 拒否・PUT 0 ===');
{
  reset();
  globalThis.__env.AD_HOC_ELITH_WRITE_TARGET = TARGET;
  const r = gate();
  eq('ok:false', r.ok, false);
  eq('error', r.error, 'write_disabled');
  eq('403', r.status, 403);
  eq('PutObject 0 回', STUBS.__state.puts.length, 0);
}

console.log('\n=== C. WRITE_ENABLED=off → 拒否 ===');
{
  reset();
  globalThis.__env.AD_HOC_ELITH_WRITE_ENABLED = 'off';
  globalThis.__env.AD_HOC_ELITH_WRITE_TARGET = TARGET;
  const r = gate();
  eq('ok:false', r.ok, false);
  eq('error', r.error, 'write_disabled');
  // 「on 以外は全部無効」を、紛らわしい値でも固定する。
  for (const v of ['ON', 'true', '1', 'yes', 'on ']) {
    reset();
    globalThis.__env.AD_HOC_ELITH_WRITE_ENABLED = v;
    globalThis.__env.AD_HOC_ELITH_WRITE_TARGET = TARGET;
    const rr = gate();
    // 'on ' は trim して 'on' になるので有効。それ以外は無効。
    const want = v.trim() === 'on';
    eq(`"${v}" → ${want ? '有効' : '無効'}`, rr.ok === true, want);
  }
}

console.log('\n=== D. WRITE_TARGET 未設定 → 拒否 ===');
{
  reset();
  globalThis.__env.AD_HOC_ELITH_WRITE_ENABLED = 'on';
  const r = gate();
  eq('ok:false', r.ok, false);
  eq('error', r.error, 'write_target_unset');
  eq('PutObject 0 回', STUBS.__state.puts.length, 0);
}

console.log('\n=== E. WRITE_TARGET が実際の解決先と違う → 拒否 ===');
{
  const mismatches = [
    `s3://other-bucket/${PREFIX}`,
    `s3://${BUCKET}/other-prefix/`,
    `s3://${BUCKET}/`,                      // prefix 無し
    `s3://${BUCKET}/verify-only-prefix`,    // ← 末尾スラッシュ差だけ (正規化して一致する)
    `s3://${BUCKET}/verify-only-prefix/sub/`,
    `S3://${BUCKET}/${PREFIX}`,             // scheme の大小
    `s3://${BUCKET.toUpperCase()}/${PREFIX}`, // バケット名の大小
  ];
  for (const m of mismatches) {
    reset();
    enable(m);
    const r = gate();
    // 末尾スラッシュだけの差は正規化規則どおり一致させる (それ以外は不一致)。
    const want = m === `s3://${BUCKET}/verify-only-prefix`;
    if (want) eq(`"${m}" → 一致 (末尾スラッシュの正規化)`, r.ok, true);
    else eq(`"${m}" → 不一致で拒否`, r.ok === false && r.error === 'write_target_mismatch', true);
  }
  reset();
  enable(`s3://${BUCKET}/other-prefix/`);
  gate();
  eq('不一致時の PutObject 0 回', STUBS.__state.puts.length, 0);
}

console.log('\n=== F. 両 env 一致 + 正当 key + skipped 0 + 既存 0 → 書ける ===');
{
  reset();
  enable();
  const r = gate();
  eq('gate ok', r.ok, true);
  eq('target', r.target, TARGET);
  const pre = await G.preflightNoExistingObjects(DELIVERY.map((f) => f.key), r.cfg);
  eq('preflight ok', pre.ok, true);
  eq('HeadObject が全 key ぶん', STUBS.__state.heads.length, DELIVERY.length);
  const up = await G.putDeliveryFilesCreateOnly(
    DELIVERY.map((f) => ({ key: f.key, body: f.body, bytes: f.bytes })), r.cfg,
  );
  eq('PutObject が 3 回', STUBS.__state.puts.length, 3);
  eq('戻り値が 3 件', up.length, 3);
  eq('uri が s3://bucket/key', up[0].uri, `s3://${BUCKET}/${DELIVERY[0].key}`);
}

console.log('\n=== G. prefix の外の key → 拒否 ===');
{
  const outside = [
    `other-prefix/user/${CID}/date/2026_03_29/HealthCheckupData_date_2026_03_29_user_${CID}.json`,
    `user/${CID}/date/2026_03_29/HealthCheckupData_date_2026_03_29_user_${CID}.json`, // prefix 無し
    `${PREFIX}scan-uploads/2026/03/29/${CID}.json`,                                    // 別領域
    `${PREFIX}input/user/${CID}/date/2026_03_29/HealthCheckupData_date_2026_03_29_user_${CID}.json`,
    `${PREFIX}user/${CID}/date/2026_03_29/HealthCheckupData_date_2026_03_29_user_${CID}.txt`, // json 以外
    `${PREFIX}user/${CID}/date/2026_03_29/UnknownFormat_date_2026_03_29_user_${CID}.json`,    // 想定外 format
    `${PREFIX}user/not-a-uuid/date/2026_03_29/HealthCheckupData_date_2026_03_29_user_not-a-uuid.json`,
    `${PREFIX}user/${CID}/date/2026_03_29/HealthCheckupData_date_2026_04_01_user_${CID}.json`, // 日付不一致
    `${PREFIX}user/${CID}/date/2026_03_29/HealthCheckupData_date_2026_03_29_user_${CID2}.json`, // cid 不一致
  ];
  for (const k of outside) {
    reset();
    enable();
    const r = gate([{ key: k, formatId: 'HealthCheckupData', testDate: '2026-03-29', body: '{}', bytes: 2 }]);
    eq(`拒否: ${k.slice(0, 60)}…`, r.ok === false && r.error === 'invalid_delivery_key', true);
    eq('  PutObject 0 回', STUBS.__state.puts.length, 0);
  }
}

console.log('\n=== H. `..` / `//` / 先頭スラッシュ を含む key → 拒否 ===');
{
  const nasty = [
    `${PREFIX}user/${CID}/../../etc/HealthCheckupData_date_2026_03_29_user_${CID}.json`,
    `${PREFIX}..//user/${CID}/date/2026_03_29/HealthCheckupData_date_2026_03_29_user_${CID}.json`,
    `${PREFIX}user//${CID}/date/2026_03_29/HealthCheckupData_date_2026_03_29_user_${CID}.json`,
    `/${PREFIX}user/${CID}/date/2026_03_29/HealthCheckupData_date_2026_03_29_user_${CID}.json`,
  ];
  for (const k of nasty) {
    reset();
    enable();
    const r = gate([{ key: k, formatId: 'HealthCheckupData', testDate: '2026-03-29', body: '{}', bytes: 2 }]);
    eq(`拒否: ${k.slice(0, 50)}…`, r.ok === false && r.error === 'invalid_delivery_key', true);
    eq('  PutObject 0 回', STUBS.__state.puts.length, 0);
  }
}

console.log('\n=== I. skipped > 0 → 全体を止める (部分納品しない) ===');
{
  reset();
  enable();
  const r = gate(DELIVERY, [{ subjectNo: 2, reason: 'not_ready' }]);
  eq('ok:false', r.ok, false);
  eq('error', r.error, 'partial_export_blocked');
  eq('409', r.status, 409);
  eq('PutObject 0 回', STUBS.__state.puts.length, 0);
  eq('HeadObject 0 回 (PUT 前に止まる)', STUBS.__state.heads.length, 0);
}

console.log('\n=== J. delivery 0 件 → 拒否 ===');
{
  reset();
  enable();
  const r = gate([]);
  eq('ok:false', r.ok, false);
  eq('error', r.error, 'nothing_to_export');
  eq('PutObject 0 回', STUBS.__state.puts.length, 0);
}

console.log('\n=== K. 既存オブジェクトが 1 件でもあれば PUT を始めない ===');
{
  reset();
  enable();
  STUBS.__state.existing.add(DELIVERY[2].key); // 3 件目だけ既存
  const r = gate();
  eq('gate 自体は ok', r.ok, true);
  const pre = await G.preflightNoExistingObjects(DELIVERY.map((f) => f.key), r.cfg);
  eq('preflight ok:false', pre.ok, false);
  eq('error', pre.error, 'destination_exists');
  eq('409', pre.status, 409);
  eq('PutObject 0 回', STUBS.__state.puts.length, 0);

  // 存在確認そのものが失敗したときも「無いはず」で進めない。
  reset();
  enable();
  const boom = new Error('AccessDenied'); boom.name = 'AccessDenied';
  boom.$metadata = { httpStatusCode: 403 };
  STUBS.__state.headThrows = boom;
  const pre2 = await G.preflightNoExistingObjects([DELIVERY[0].key], G.actualTargetUri
    ? STUBS.__state.cfg : STUBS.__state.cfg);
  eq('確認できなければ中止', pre2.ok === false && pre2.error === 'preflight_failed', true);
  eq('PutObject 0 回', STUBS.__state.puts.length, 0);
}

console.log('\n=== L. PutObject に IfNoneMatch:"*" が必ず付く ===');
{
  reset();
  enable();
  const r = gate();
  await G.putDeliveryFilesCreateOnly(
    DELIVERY.map((f) => ({ key: f.key, body: f.body, bytes: f.bytes })), r.cfg,
  );
  eq('PutObject 3 回', STUBS.__state.puts.length, 3);
  eq('全件に IfNoneMatch:"*"', STUBS.__state.puts.every((p) => p.IfNoneMatch === '*'), true);
  eq('Bucket が cfg のもの', STUBS.__state.puts.every((p) => p.Bucket === BUCKET), true);
  eq('ContentType が JSON', STUBS.__state.puts.every((p) => String(p.ContentType).startsWith('application/json')), true);
}

console.log('\n=== M. ゲートで弾かれたら status を exporting / completed にしない ===');
{
  const s = read('src/lib/ad-hoc-diagnosis/service.ts');
  const iGate = s.indexOf('checkWriteGate(');
  const iPre = s.indexOf('preflightNoExistingObjects(');
  const iExporting = s.indexOf("status: 'exporting'");
  const iCompleted = s.indexOf("status: 'completed'");
  eq('checkWriteGate が exporting より前', iGate >= 0 && iGate < iExporting, true);
  eq('preflight が exporting より前', iPre >= 0 && iPre < iExporting, true);
  eq('exporting が completed より前', iExporting < iCompleted, true);

  // gate / preflight の失敗は **return** で抜けること (そのまま流れて書かない)。
  const between = s.slice(iGate, iExporting);
  eq('gate 失敗で return している', /if \(!gate\.ok\)[\s\S]{0,200}?return \{ ok: false/.test(between), true);
  eq('preflight 失敗で return している', /if \(!pre\.ok\)[\s\S]{0,200}?return \{ ok: false/.test(between), true);

  // PUT が失敗したら completed にせず failed にすること。
  const tail = s.slice(iExporting);
  eq('PUT の失敗を catch している', /catch \(e\)[\s\S]{0,400}?status: 'failed'/.test(tail), true);
}

console.log('\n=== N. ad-hoc の実 export 経路に generic putFiles() が残っていない ===');
{
  const s = read('src/lib/ad-hoc-diagnosis/service.ts');
  eq('service.ts に putFiles の呼び出しが 0 件', /\bputFiles\s*\(/.test(s), false);
  eq('service.ts が putFiles を import していない', /import[^;]*\bputFiles\b[^;]*from/.test(s), false);
  eq('write-guard 経由で書いている', s.includes('putDeliveryFilesCreateOnly('), true);

  // **共通 s3.ts は 1 バイトも変えない** (他機能の書き込み経路)。
  const s3 = read('src/lib/s3.ts');
  eq('s3.ts の putFiles は IfNoneMatch を付けていない (挙動不変)',
    /export async function putFiles[\s\S]*?IfNoneMatch/.test(s3), false);
  eq('s3.ts に ad-hoc 固有の分岐が無い', /ad[-_]?hoc/i.test(s3), false);
}

// --- 集計 ---------------------------------------------------------------------------
console.log('');
if (fails.length) {
  console.log(`✗ ${fails.length} 件 失敗`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✓ すべて通過 — 実書き込みは二重 env ゲート + key allowlist + create-only でしか通らない');
