#!/usr/bin/env node
/**
 * 臨時診断バッチ: **E2E 確認用「1 JSON だけ S3 へ書く」経路**の回帰チェック。
 * 正本: 最終指示書「1 JSONのみS3書き出し」§1〜§12。
 *
 * 【なぜ要るか】この口は**通常納品の安全装置を迂回する形に見える**ので、
 * 一度でも緩むと「1 件だけのつもりが全部書けた」「上書きした」「納品済みになった」が起きる。
 * しかもどれも**画面上は成功に見える**。目視では守れないので機械で固定する。
 *
 * ここで固定するのは 4 つ。
 *   ① 通常納品 (`assembleBatch` / `checkWriteGate`) の規則が**1 文字も緩んでいない**
 *   ② 1 件書き出しでも **env 2 本・書き込み先一致・key の形・create-only** を全部通る
 *   ③ **ちょうど 1 件**でなければ書かない / 既存があれば書かない
 *   ④ 書いても **batch を completed にしない・exported イベントを出さない**
 *
 * **外部 AWS / DB / Vercel を一切使わない。** `write-guard.ts` は実物を transpile し、
 * `@aws-sdk/client-s3` と `../s3` をスタブへ差し替えて動かす。
 *
 * 実行: node scripts/verify-ad-hoc-single-write.mjs
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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
const has = (label, cond, detail = '') => (cond ? ok(label) : bad(label, detail));

const BUCKET = 'verify-only-bucket';
const PREFIX = 'verify-only-prefix/';
const TARGET = `s3://${BUCKET}/${PREFIX}`;
const CID = 'aaaaaaaa-1111-2222-3333-444444444444';

// ---------------------------------------------------------------------------
// 実物 (write-guard.ts) を動かす
// ---------------------------------------------------------------------------
const ts = (await import('typescript')).default;
const CACHE = resolve(ROOT, 'node_modules/.cache');
mkdirSync(CACHE, { recursive: true });
const emit = (name, src) => {
  const out = resolve(CACHE, name);
  writeFileSync(out, ts.transpileModule(src, { compilerOptions: { target: 'ES2022', module: 'ESNext' } }).outputText);
  return out;
};

const stubPath = emit('verify-single-write-stubs.mjs', `
export const __state = {
  cfg: { bucket: ${JSON.stringify(BUCKET)}, region: 'test-region', prefix: ${JSON.stringify(PREFIX)} },
  existing: new Map(),  // key -> { ContentLength, ETag }
  headThrows: null,
  puts: [],
  heads: [],
};
export function getS3Config() { return __state.cfg; }
export function makeS3Client() {
  return {
    async send(cmd) {
      if (cmd.__kind === 'head') {
        __state.heads.push(cmd.input.Key);
        if (__state.headThrows) throw __state.headThrows;
        const hit = __state.existing.get(cmd.input.Key);
        if (hit) return hit;
        const e = new Error('NotFound'); e.name = 'NotFound'; e.$metadata = { httpStatusCode: 404 };
        throw e;
      }
      __state.puts.push(cmd.input);
      // PUT が成功したら在ることにする (読み戻しの検証に使う)。
      __state.existing.set(cmd.input.Key, { ContentLength: String(cmd.input.Body).length, ETag: '"deadbeef"' });
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
if (src.includes("from '../s3'") || src.includes("from '@aws-sdk/client-s3'")) {
  bad('verify 自体: 実物の import が残っている (差し替え漏れ)');
}
const guardPath = emit('verify-single-write-guard.mjs', src);

globalThis.__env = {};
const STUBS = await import(stubPath);
const G = await import(`${guardPath}?t=${Date.now()}`);

const keyOf = (cid, fmt, d) => `${PREFIX}user/${cid}/date/${d}/${fmt}_date_${d}_user_${cid}.json`;
const fileOf = (fmt, iso, cid = CID) => ({
  key: keyOf(cid, fmt, iso.replace(/-/g, '_')),
  formatId: fmt, testDate: iso,
  body: JSON.stringify({ format_id: fmt, client_id: cid, test_date: iso }),
  bytes: 40,
});
const HC = fileOf('HealthCheckupData', '2025-09-25');

function reset() {
  globalThis.__env = {};
  STUBS.__state.existing = new Map();
  STUBS.__state.headThrows = null;
  STUBS.__state.puts = [];
  STUBS.__state.heads = [];
}
const enable = (target = TARGET) => {
  globalThis.__env.AD_HOC_ELITH_WRITE_ENABLED = 'on';
  globalThis.__env.AD_HOC_ELITH_WRITE_TARGET = target;
};

// ===========================================================================
console.log('\n=== A. 1 件書き出しでも env 2 本のゲートを通る ===');
// ===========================================================================
{
  reset();
  const r = G.checkSingleFileWriteGate(HC);
  eq('未設定なら拒否', r.ok, false);
  eq('error', r.error, 'write_disabled');
  eq('PutObject 0 回', STUBS.__state.puts.length, 0);
}
{
  reset();
  globalThis.__env.AD_HOC_ELITH_WRITE_ENABLED = 'on';
  const r = G.checkSingleFileWriteGate(HC);
  eq('書き込み先が未宣言なら拒否', r.error, 'write_target_unset');
}
{
  reset();
  enable('s3://other-bucket/verify-only-prefix/');
  const r = G.checkSingleFileWriteGate(HC);
  eq('宣言と実際が違えば拒否', r.error, 'write_target_mismatch');
}
{
  reset();
  enable();
  const r = G.checkSingleFileWriteGate(HC);
  eq('2 本揃って一致すれば通る', r.ok, true);
  eq('bucket', r.cfg.bucket, BUCKET);
}

// ===========================================================================
console.log('\n=== B. 1 件書き出しでも key の形を検査する ===');
// ===========================================================================
{
  reset(); enable();
  const cases = [
    ['prefix の外', { ...HC, key: `other/user/${CID}/date/2025_09_25/HealthCheckupData_date_2025_09_25_user_${CID}.json` }],
    ['.json 以外', { ...HC, key: `${HC.key}.bak` }],
    ['`..` を含む', { ...HC, key: `${PREFIX}../user/${CID}/date/2025_09_25/HealthCheckupData_date_2025_09_25_user_${CID}.json` }],
    ['format が key と食い違う', { ...HC, formatId: 'LifestyleQuestionnaireData' }],
    ['日付が key と食い違う', { ...HC, testDate: '2025-09-26' }],
    ['allowlist 外の format', fileOf('SomethingElse', '2025-09-25')],
  ];
  for (const [label, f] of cases) {
    const r = G.checkSingleFileWriteGate(f);
    eq(`${label} → 拒否`, r.ok, false);
  }
  eq('検査だけでは PutObject 0 回', STUBS.__state.puts.length, 0);
}

// ===========================================================================
console.log('\n=== C. 既存があれば書かない / 確認できなければ書かない ===');
// ===========================================================================
{
  reset(); enable();
  STUBS.__state.existing.set(HC.key, { ContentLength: 1, ETag: '"x"' });
  const pre = await G.preflightNoExistingObjects([HC.key], STUBS.__state.cfg);
  eq('既存あり → 拒否', pre.error, 'destination_exists');
  eq('PutObject 0 回', STUBS.__state.puts.length, 0);
}
{
  reset(); enable();
  STUBS.__state.headThrows = Object.assign(new Error('AccessDenied'), {
    name: 'AccessDenied', $metadata: { httpStatusCode: 403 },
  });
  const pre = await G.preflightNoExistingObjects([HC.key], STUBS.__state.cfg);
  eq('確認できない → 拒否 (無いはずで進めない)', pre.error, 'preflight_failed');
  eq('PutObject 0 回', STUBS.__state.puts.length, 0);
}

// ===========================================================================
console.log('\n=== D. PUT は create-only / 読み戻しができる ===');
// ===========================================================================
{
  reset(); enable();
  await G.putDeliveryFilesCreateOnly([{ key: HC.key, body: HC.body, bytes: HC.bytes }], STUBS.__state.cfg);
  eq('PutObject 1 回だけ', STUBS.__state.puts.length, 1);
  eq('IfNoneMatch で上書きを禁じている', STUBS.__state.puts[0].IfNoneMatch, '*');
  eq('本文をそのまま置いている', STUBS.__state.puts[0].Body, HC.body);
  const after = await G.headDeliveryObject(HC.key, STUBS.__state.cfg);
  eq('読み戻して存在を確認できる', after.exists, true);
  eq('ETag の引用符を外して返す', after.etag, 'deadbeef');
}
{
  reset(); enable();
  const after = await G.headDeliveryObject(HC.key, STUBS.__state.cfg);
  eq('無ければ exists:false', after.exists, false);
}
{
  reset(); enable();
  STUBS.__state.headThrows = Object.assign(new Error('AccessDenied'), {
    name: 'AccessDenied', $metadata: { httpStatusCode: 403 },
  });
  let threw = false;
  try { await G.headDeliveryObject(HC.key, STUBS.__state.cfg); } catch { threw = true; }
  /*
   * **「確認できなかった」を「無い」にしない。** 403 を false に丸めると
   * 「書けたのに確認できていない」を「書けていない」と報告することになる。
   */
  eq('確認できないときは投げる (false に丸めない)', threw, true);
}

// ===========================================================================
console.log('\n=== E. 通常納品の規則を 1 つも緩めていない ===');
// ===========================================================================
{
  reset(); enable();
  const r = G.checkWriteGate({ delivery: [HC], skipped: [{ subjectNo: 2, reason: 'not_ready' }] });
  eq('通常納品は部分納品を今までどおり止める', r.error, 'partial_export_blocked');
  const r0 = G.checkWriteGate({ delivery: [], skipped: [] });
  eq('0 件を成功にしない', r0.error, 'nothing_to_export');
}
{
  const g = strip(read('src/lib/ad-hoc-diagnosis/write-guard.ts'));
  has('部分納品の禁止は通常ゲートにだけ在る',
    (g.match(/partial_export_blocked/g) ?? []).length === 1,
    '1 件書き出し側にも複製されている可能性');
  has('1 件書き出しは別関数になっている', /export function checkSingleFileWriteGate\(/.test(g));
  has('env と書き込み先の検査を共有している',
    /export function checkWriteTarget\(/.test(g)
    && /const t = checkWriteTarget\(\);/.test(g));
  has('上書きの抜け道を作っていない',
    !/overwrite|force|allowOverwrite/i.test(g));
  has('1 件書き出しも key の形を検査する',
    /checkSingleFileWriteGate[\s\S]*?validateDeliveryKey\(/.test(g));
}

// ===========================================================================
console.log('\n=== F. service.ts の結線 ===');
// ===========================================================================
{
  const svc = strip(read('src/lib/ad-hoc-diagnosis/service.ts'));
  const i = svc.indexOf('export async function exportSingleDeliveryFile');
  has('1 件書き出しの入口が在る', i > 0);
  /*
   * **関数の終わりで切る。** 末尾まで見ると次の関数 (`retryBatch` は
   * `updateBatch` を呼ぶ) を拾って「status を触っている」と誤判定する。
   */
  const iNext = svc.indexOf('export async function', i + 10);
  const one = svc.slice(i, iNext > i ? iNext : undefined);
  has('検査範囲が 1 関数に収まっている', iNext > i);

  // ① 納品 JSON の作り方が通常納品と同じであること (§3)。
  has('E2E 専用の builder を作っていない',
    !/function build[A-Za-z]*HealthCheckup|toDeliveryFile\(/.test(one),
    'E2E 側で納品ファイルを組み直している');
  has('通常納品と同じ組み立てを呼ぶ', /buildSubjectDelivery\(s, own, cfg\)/.test(one));
  eq('組み立ては 1 か所からしか呼ばれない',
    (svc.match(/buildSubjectDelivery\(/g) ?? []).length, 3); // 定義 1 + 呼び出し 2
  eq('納品ファイルの生成点は 1 つ',
    (svc.match(/toDeliveryFile\(cfg\.prefix/g) ?? []).length, 4); // HC/問診/遺伝子/年齢

  // ② ちょうど 1 件 (§4)。
  has('ちょうど 1 件でなければ書かない',
    /hits\.length !== 1/.test(one) && /not_exactly_one_file/.test(one));

  // ③ 事前検査 (§5)。
  has('Executive 未リンクなら書かない', /executive_not_linked/.test(one));
  has('検査日が指定と違えば書かない', /test_date_mismatch/.test(one));
  has('本文の client_id / format_id / test_date を見る',
    /parsed\.client_id !== s\.client_id/.test(one)
    && /parsed\.format_id !== input\.formatId/.test(one)
    && /parsed\.test_date !== input\.expectTestDate/.test(one));
  has('today で日付を作らない', !/new Date\(\)\.toISOString\(\)\.slice/.test(one));

  // ④ 安全装置 (§6)。
  const iGate = one.indexOf('checkSingleFileWriteGate(');
  const iPre = one.indexOf('preflightNoExistingObjects(');
  const iPut = one.indexOf('putDeliveryFilesCreateOnly(');
  has('ゲート → 既存確認 → PUT の順', iGate > 0 && iPre > iGate && iPut > iPre);
  has('create-only の PUT を使う', iPut > 0);
  has('PUT のあとに読み戻す', one.indexOf('headDeliveryObject(') > iPut);

  // ⑤ 正式な納品にしない (§8)。
  has('batch を completed にしない', !/updateBatch\([\s\S]{0,200}completed/.test(one));
  has('batch の status を触らない', !/updateBatch\(/.test(one));
  has('output を exported にしない', !/upsertOutput\(/.test(one));
  has('通常 export の完了イベントを出さない', !/event: 'exported'/.test(one));
  has('監査だけは残す', /event: 'override'/.test(one) && /e2e_single_write/.test(one));
  has('回答値や本文をログに出さない', !/detail: \{[\s\S]{0,200}body/.test(one));

  // ⑥ 通常経路は無傷 (§2)。
  const iAssemble = svc.indexOf('export async function assembleBatch');
  const assemble = svc.slice(iAssemble, i > iAssemble ? i : undefined);
  has('通常納品は今までどおり checkWriteGate を通る', /checkWriteGate\(\{ delivery, skipped \}\)/.test(assemble));
  has('通常納品は completed にする', /status: 'completed'/.test(assemble));
  has('通常納品は exported イベントを出す', /event: 'exported'/.test(assemble));

  // ⑦ DB を触らない (§11)。
  has('新しい migration を足していない', !/create table|alter table/i.test(svc));
  has('新しい event 名を足していない',
    !/event: '(e2e|single|verify)[a-z_]*'/.test(svc));
}

// ===========================================================================
console.log('\n=== G. API の入口 ===');
// ===========================================================================
{
  const api = strip(read('src/pages/api/admin/ad-hoc-diagnosis/export-one.ts'));
  has('admin 認可を通す', /if \(!authorized\(request\)\) return json/.test(api));
  has('batchId を UUID 検査する', /isUuid\(batchId\)/.test(api));
  has('subjectId を UUID 検査する', /isUuid\(subjectId\)/.test(api));
  has('format は allowlist から選ばせる',
    /AD_HOC_DELIVERY_FORMAT_IDS[\s\S]{0,60}includes\(formatId\)/.test(api));
  has('検査日は必須 (省略できない)',
    /if \(!expectTestDate \|\| !\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(expectTestDate\)\)/.test(api));
  has('prerender=false', /export const prerender = false;/.test(api));
  has('actor を自己申告させない', /actorFrom\(request\)/.test(api) && !/body\?\.actor/.test(api));
}
{
  // 中継 (wellfort-site) 側の allowlist に載っていること。
  const relayPath = resolve(ROOT, '../wellfort-site/src/pages/api/admin/ad-hoc-diagnosis/[...path].ts');
  let relay = null;
  try { relay = readFileSync(relayPath, 'utf8'); } catch { /* 単独 repo では読めない */ }
  if (relay === null) {
    console.log('  - wellfort-site が無いので中継の検査はスキップ');
  } else {
    has('中継の allowlist に export-one が在る', /'export-one',/.test(relay));
    has('中継は完全一致の allowlist のまま', /if \(!ALLOWED\.has\(path\)\)/.test(relay));
  }
}

// ---------------------------------------------------------------------------
console.log('');
if (fails.length) {
  console.log(`✗ ${fails.length} 件 失敗`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✓ すべて通過 — 1 件書き出しは通常納品の規則を緩めず、create-only でしか通らない');
