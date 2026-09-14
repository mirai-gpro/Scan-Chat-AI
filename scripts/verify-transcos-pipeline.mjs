#!/usr/bin/env node
/**
 * トランスコスモス10名 緊急専用 v2.0 — **seed / cross-check / 納品ゲート**の回帰チェック。
 *
 * 【なぜ要るか】ここも静かに壊れる:
 *   - 補助 XLSX から値を「補完」してしまうと、**原本に無い値が納品 JSON に入る** (捏造)
 *   - 名称対応を推測すると、**別項目どうしを比べて「一致」と言う**
 *   - 納品ゲートが 1 つ緩むと、**人物取り違え・日付捏造のまま S3 へ出る**
 *   - 既存 key を上書きすると、**先に出した納品が黙って消える**
 *
 * **合成データだけ**を使う (実在役員の氏名・回答・健康情報は 1 件も置かない)。
 * 外部 DB / S3 / LLM へは 1 回も出ない。
 *
 * 実行: node scripts/verify-transcos-pipeline.mjs
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

let pass = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `期待 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const tmp = mkdtempSync(join(repoRoot, '.verify-tp-'));

const rel = (src) => src
  .replace(`from './manifest'`, `from './manifest.js'`)
  .replace(`from '../standard-master'`, `from './standard-master.js'`)
  .replace(`from '../ad-hoc-diagnosis/health-checkup-xlsx'`, `from './health-checkup-xlsx.js'`)
  .replace(`from '../ad-hoc-diagnosis/store'`, `from './store.js'`)
  .replace(`from '../ad-hoc-diagnosis/service'`, `from './service.js'`)
  .replace(`from '../ad-hoc-diagnosis/write-guard'`, `from './write-guard.js'`)
  .replace(`from '../ad-hoc-diagnosis/pipeline'`, `from './pipeline.js'`)
  .replace(`from './classify'`, `from './classify.js'`);
const writeTs = (relPath, outName) => {
  writeFileSync(join(tmp, outName), ts.transpileModule(rel(read(relPath)), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
};
writeTs('src/lib/transcos-emergency/manifest.ts', 'manifest.js');
writeTs('src/lib/standard-master.ts', 'standard-master.js');
writeTs('src/lib/transcos-emergency/crosscheck.ts', 'crosscheck.js');
writeTs('src/lib/transcos-emergency/deliver.ts', 'deliver.js');
writeFileSync(join(tmp, 'health-checkup-xlsx.js'), 'export {};\n');
writeFileSync(join(tmp, 'pipeline.js'), 'export {};\n');

const X = await import(pathToFileURL(join(tmp, 'crosscheck.js')).href);
const M = await import(pathToFileURL(join(tmp, 'manifest.js')).href);

// ===========================================================================
// ① cross-check — **値を作らない。推測で名前を寄せない。**
// ===========================================================================
const sheet = (pairs, testDate) => ({
  headerRowIndex: 0, headerHits: 6, headers: pairs.map(([h]) => h),
  rows: [pairs.map(([header, value]) => ({ header, value }))],
  testDate: testDate ? { status: 'resolved', date: testDate } : { status: 'absent' },
  notes: [],
});
const meas = (list) => list.map(([name, value, unit]) => ({ name, value, unit: unit ?? null }));

{
  const r = X.crossCheckHealth({
    measurements: meas([['身長', '170.0', 'cm'], ['体重', '65', 'kg'], ['尿酸', '7.8', 'mg/dL']]),
    support: sheet([['身長', 170], ['体重', 65], ['尿酸', 7.8]], '2025-09-25'),
    pdfTestDate: '2025-09-25',
  });
  eq('一致は mismatch を出さない', r.mismatches.length, 0);
  ok('検査日も比べる', r.items.some((i) => i.name === '検査日' && i.status === 'match'));
  ok('170 と 170.0 は同じ', r.items.find((i) => i.name === '身長')?.status === 'match');
}
{
  const r = X.crossCheckHealth({
    measurements: meas([['身長', '170', 'cm']]),
    support: sheet([['身長', 171]], '2025-09-25'),
    pdfTestDate: '2025-09-25',
  });
  eq('値が違えば mismatch', r.mismatches.map((m) => m.name), ['身長']);
}
{
  const r = X.crossCheckHealth({
    measurements: meas([['身長', '170', 'cm']]),
    support: sheet([['身長', 170]], '2025-09-26'),
    pdfTestDate: '2025-09-25',
  });
  ok('検査日が違えば mismatch', r.mismatches.some((m) => m.name === '検査日'));
}
{
  // **XLSX にしかない値を補完しない** — 片側にしか無い項目は結果に現れない
  const r = X.crossCheckHealth({
    measurements: meas([['身長', '170', 'cm']]),
    support: sheet([['身長', 170], ['尿酸', 7.8]], '2025-09-25'),
    pdfTestDate: '2025-09-25',
  });
  ok('片側だけの項目は比較にも納品にも出ない', !r.items.some((i) => i.name === '尿酸'));
  eq('mismatch は 0', r.mismatches.length, 0);
}
{
  // **同じ名前が 2 つあるときは比べない** (取り違えを作らない)
  const r = X.crossCheckHealth({
    measurements: meas([['身長', '170', 'cm'], ['身長', '171', 'cm']]),
    support: sheet([['身長', 170]], '2025-09-25'),
    pdfTestDate: '2025-09-25',
  });
  eq('重複名は not_compared', r.items.find((i) => i.name === '身長')?.status, 'not_compared');
  eq('重複名は mismatch にしない', r.mismatches.length, 0);
}
{
  // **標準マスタに落ちない名前は比べない** (当て推量で寄せない)
  const r = X.crossCheckHealth({
    measurements: meas([['よく分からない項目', '1', null]]),
    support: sheet([['よく分からない項目', 1]], '2025-09-25'),
    pdfTestDate: '2025-09-25',
  });
  ok('マスタ外は比較対象にならない', !r.items.some((i) => i.name === 'よく分からない項目'));
}
{
  // 値が空なら比べない (**空を「不一致」と言わない**)
  const r = X.crossCheckHealth({
    measurements: meas([['身長', '', 'cm']]),
    support: sheet([['身長', 170]], '2025-09-25'),
    pdfTestDate: '2025-09-25',
  });
  eq('空は not_compared', r.items.find((i) => i.name === '身長')?.status, 'not_compared');
}
{
  // 補助 XLSX が無い人物 (5 名以外) は何も起きない
  const r = X.crossCheckHealth({ measurements: meas([['身長', '170', 'cm']]), support: null, pdfTestDate: '2025-09-25' });
  eq('補助なしは空', [r.mismatches.length, r.items.length], [0, 0]);
}
{
  // **丸めで一致を作らない**
  const r = X.crossCheckHealth({
    measurements: meas([['体重', '65.4', 'kg']]),
    support: sheet([['体重', 65.5]], '2025-09-25'),
    pdfTestDate: '2025-09-25',
  });
  eq('65.4 と 65.5 は不一致', r.mismatches.map((m) => m.name), ['体重']);
}

// ===========================================================================
// ② seed — **manifest が分類そのもの**であること (source 検査)
// ===========================================================================
{
  const s = strip(read('src/lib/transcos-emergency/seed.ts'));
  ok('汎用 classifier を呼ばない', !/classifyEntry|analyzeEntry|planArchive|classifyBatch/.test(s));
  ok('PDF 本文を読まない', !/extractPdfText|detectPdfProfile|normalizePdfText/.test(s));
  ok('ファイル名から役割を決めていない', !/\.includes\('健診'\)|match\(\/.*フォルダ/.test(s));
  ok('補助 XLSX は format を持たない',
    /case 'HEALTH_SUPPORT_XLSX'|default: return null;/.test(s));
  ok('Genoplan の日付は manifest 固定', /genoplanTestDate/.test(s));
  ok('問診の日付は完了時刻から', /completedAt\.status === 'resolved'/.test(s));
  ok('today fallback が無い', !/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)|Date\.now\(\)/.test(s));
  ok('回答行が 1 行でなければ止める', /sheet\.people\.length !== 1/.test(s));
  ok('問診 PDF は自動で読まない', /manual_entry_required/.test(s));
  ok('ZIP 内の path を DB へ書かない', !/display_name: m\.path|storage_key: .*m\.path[^.]/.test(s));
}

// ===========================================================================
// ③ 納品ゲート — §16 の 9 条件 (実物を動かす。store / service / S3 はスタブ)
// ===========================================================================
writeFileSync(join(tmp, 'store.js'), `
export const __log = [];
export async function logEvent(x) { __log.push(x); }
export async function upsertOutput(x) { __log.push({ output: x }); }
`);
writeFileSync(join(tmp, 'service.js'), `
export let __build = null;
export function __setBuild(b) { __build = b; }
export async function buildSubjectDelivery() { return __build; }
`);
writeFileSync(join(tmp, 'write-guard.js'), `
export let __state = { target: { ok: true, cfg: { prefix: 'p/', bucket: 'b' }, target: 's3://b/p/' },
  heads: new Map(), put: [], keyOk: true };
export function __reset(s) { __state = { ...__state, ...s }; __state.put = []; }
export function checkWriteTarget() { return __state.target; }
export function validateDeliveryKey() { return __state.keyOk ? { ok: true } : { ok: false, reason: 'bad' }; }
export async function headDeliveryObject(key) {
  const h = __state.heads.get(key);
  if (h === 'throw') throw new Error('権限不足');
  return h ?? { exists: false, bytes: null, etag: null };
}
export async function putDeliveryFilesCreateOnly(files) {
  __state.put.push(...files.map((f) => f.key));
  for (const f of files) __state.heads.set(f.key, { exists: true, bytes: f.bytes, etag: 'e' });
  return files.map((f) => ({ key: f.key, bytes: f.bytes, uri: 's3://b/' + f.key }));
}
`);
const D = await import(pathToFileURL(join(tmp, 'deliver.js')).href);
const SV = await import(pathToFileURL(join(tmp, 'service.js')).href);
const WG = await import(pathToFileURL(join(tmp, 'write-guard.js')).href);

const CLIENT = 'cid-0001';
const mkFile = (formatId, testDate = '2025-09-25', over = {}) => {
  const json = { format_id: formatId, client_id: CLIENT, test_date: testDate, data: {}, ...over };
  const body = JSON.stringify(json, null, 2);
  return { key: `p/user/${CLIENT}/date/${testDate.replace(/-/g, '_')}/${formatId}_date_${testDate.replace(/-/g, '_')}_user_${CLIENT}.json`,
    formatId, body, bytes: Buffer.byteLength(body, 'utf8'), testDate };
};
const allThree = () => D.TRANSCOS_DELIVERY_FORMATS.map((f) => mkFile(f));
const subject = (over = {}) => ({
  id: 'sub-1', subject_no: 4, client_id: CLIENT, executive_subject_id: 'exec-1', ...over,
});

const gate = async (built, sub = subject()) => {
  SV.__setBuild({ built, formats: built.map((b) => b.formatId), hcTestDate: null, hcSource: null, markers: {} });
  return D.gateSubject(sub, [], { prefix: 'p/' });
};

{
  const g = await gate(allThree());
  ok('3 形式そろえば通る', g.ok, JSON.stringify(g.blockers));
  eq('書くのは 3 件', g.files.length, 3);
}
{
  const g = await gate(allThree(), subject({ executive_subject_id: null }));
  ok('Executive 未リンクで止まる', !g.ok && g.blockers.includes('executive_not_linked'));
}
{
  const g = await gate(allThree(), subject({ client_id: '' }));
  ok('client_id 無しで止まる', !g.ok && g.blockers.includes('client_id_missing'));
}
{
  const g = await gate(allThree().filter((f) => f.formatId !== 'GeneticTestResultData'));
  ok('遺伝子が無ければ止まる', !g.ok && g.blockers.includes('GeneticTestResultData_count_0'));
}
{
  const g = await gate([...allThree(), mkFile('HealthCheckupData')]);
  ok('健診が 2 件で止まる', !g.ok && g.blockers.includes('HealthCheckupData_count_2'));
}
{
  const g = await gate([...allThree(), mkFile('HealthAgeData')]);
  ok('今回書かない形式が混ざれば止まる',
    !g.ok && g.blockers.some((b) => b.startsWith('unexpected_format')));
}
{
  const bad = allThree();
  bad[0] = { ...bad[0], testDate: '' };
  const g = await gate(bad);
  ok('日付未確定で止まる', !g.ok && g.blockers.some((b) => b.endsWith('_test_date_unresolved')));
}
{
  const bad = allThree();
  bad[1] = mkFile('LifestyleQuestionnaireData', '2026-07-12', { client_id: 'よその人' });
  const g = await gate(bad);
  ok('本文の client_id 違いで止まる', !g.ok && g.blockers.includes('LifestyleQuestionnaireData_body_client_mismatch'));
}
{
  const bad = allThree();
  bad[2] = mkFile('GeneticTestResultData', '2026-08-12', { test_date: '2026-08-25' });
  const g = await gate(bad);
  ok('本文の test_date 違いで止まる', !g.ok && g.blockers.includes('GeneticTestResultData_body_date_mismatch'));
}

// --- 書き込み --------------------------------------------------------------
const deliver = async (built, opts = {}) => {
  SV.__setBuild({ built, formats: built.map((b) => b.formatId), hcTestDate: null, hcSource: null, markers: {} });
  WG.__reset({ heads: opts.heads ?? new Map(), keyOk: opts.keyOk ?? true,
    target: opts.target ?? { ok: true, cfg: { prefix: 'p/', bucket: 'b' }, target: 's3://b/p/' } });
  return D.deliverSubject({ batchId: 'b1', subject: opts.subject ?? subject(), files: [], actor: { userId: null, masked: null } });
};

{
  const r = await deliver(allThree());
  ok('3 件とも create-only で書ける', r.ok, JSON.stringify(r));
  eq('created が 3 件', r.ok && r.files.filter((f) => f.outcome === 'created').length, 3);
  ok('readback を見る', r.ok && r.files.every((f) => f.readback));
  ok('本文を返す (S3 に在っただけで終わらせない)', r.ok && r.files.every((f) => f.body.includes('"format_id"')));
  eq('PUT したのは 3 件', WG.__state.put.length, 3);
}
{
  // 既存が同じ中身 → **上書きしない**。resume で残りだけ作る。
  const built = allThree();
  const heads = new Map([[built[0].key, { exists: true, bytes: built[0].bytes, etag: 'old' }]]);
  const r = await deliver(built, { heads });
  ok('既存があっても通る', r.ok, JSON.stringify(r));
  eq('既存は already', r.ok && r.files.filter((f) => f.outcome === 'already').length, 1);
  eq('PUT するのは残り 2 件', WG.__state.put.length, 2);
  ok('既存 key を PUT していない', !WG.__state.put.includes(built[0].key));
}
{
  // 既存の中身が違う → **上書きも削除もせず止まる**
  const built = allThree();
  const heads = new Map([[built[0].key, { exists: true, bytes: built[0].bytes + 1, etag: 'old' }]]);
  const r = await deliver(built, { heads });
  ok('中身が違う既存で止まる', !r.ok && r.error === 'destination_exists_different');
  eq('1 件も PUT しない', WG.__state.put.length, 0);
}
{
  // Head が例外 → 「無い」と見なさず止める
  const built = allThree();
  const heads = new Map([[built[1].key, 'throw']]);
  const r = await deliver(built, { heads });
  ok('確認できなければ止まる', !r.ok && r.error === 'head_failed');
  eq('PUT しない', WG.__state.put.length, 0);
}
{
  // key の形が違う → 書かない
  const r = await deliver(allThree(), { keyOk: false });
  ok('key の形が違えば書かない', !r.ok && r.error === 'invalid_delivery_key');
  eq('PUT しない', WG.__state.put.length, 0);
}
{
  // 書き込み先 env が一致しない → 書かない
  const r = await deliver(allThree(), {
    target: { ok: false, status: 503, error: 'write_disabled', detail: 'off' },
  });
  ok('env が揃わなければ書かない', !r.ok && r.error === 'write_disabled');
  eq('PUT しない', WG.__state.put.length, 0);
}
{
  // ゲートが通らない人物は 1 件も書かない
  const r = await deliver(allThree().slice(0, 2));
  ok('未完成の人物は書かない', !r.ok && r.error === 'subject_not_ready');
  eq('PUT しない', WG.__state.put.length, 0);
}

// ===========================================================================
// ④ 通常納品の規則を変えていないこと
// ===========================================================================
{
  // 通常納品の「1 人でも未完成なら部分納品しない」は write-guard が持っている。
  const wg = strip(read('src/lib/ad-hoc-diagnosis/write-guard.ts'));
  ok('通常納品の部分納品禁止が残っている', /partial_export_blocked/.test(wg));
  ok('部分納品禁止は skipped 件数で効いたまま', /input\.skipped\.length > 0/.test(wg));
  const d = strip(read('src/lib/transcos-emergency/deliver.ts'));
  ok('専用経路は assembleBatch を呼ばない', !/assembleBatch/.test(d));
  ok('上書きしない', !/IfNoneMatch:\s*undefined|force|overwrite/i.test(d));
  ok('削除して作り直さない', !/DeleteObject|delete_and_retry/i.test(d));
  ok('key を作り直さない (既存の DeliveryFile.key を使う)', !/deliveryKey\(/.test(d));
  ok('専用の JSON builder を作っていない',
    !/buildHealthCheckupJson|buildQuestionnaireJson|buildGeneticJson/.test(d));
  ok('本文は buildSubjectDelivery のものをそのまま使う', /buildSubjectDelivery/.test(d));
}

rmSync(tmp, { recursive: true, force: true });
console.log('');
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 件 失敗 (${pass} 件 通過)\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
  process.exit(1);
}
console.log(`✓ ${pass} 件 通過 — 値を作らず、名前を推測せず、人物ごとに create-only でしか書かない\n`);
