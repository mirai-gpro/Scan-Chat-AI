#!/usr/bin/env node
// scripts/verify-ad-hoc-e2e.mjs
// 臨時診断バッチ: **ZIP → 分類 → 解析 → Elith 納品 (dry-run)** を通しで確かめる。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md
//
// **S3 も DB も Gemini も要らない。** 実物の ZIP をその場で組み、
// `analyzeOpened()` 以降の**アプリケーションコードをそのまま**通す。
// (S3 は `openArchive` に Reader を直接渡すことで迂回する = adapter 境界。)
//
//   node scripts/verify-ad-hoc-e2e.mjs
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';

let pass = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name, a, b) => ok(name, Object.is(a, b), `期待 ${JSON.stringify(b)} / 実際 ${JSON.stringify(a)}`);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(repoRoot, '.verify-adhoc-'));

// --- TS を transpile して読む -------------------------------------------
// **依存を再帰的に辿って本物を読む。** 外部環境が要るものだけ stub にする:
//   s3 / supabase / gemini … 検査では触らない (adapter 境界)
// それ以外はアプリケーションコードをそのまま通す。
import { existsSync } from 'node:fs';

const repoRootAbs = repoRoot;
const outFor = (rel) => join(tmp, rel.replace(/[\/]/g, '__').replace(/\.ts$/, '.js'));

const STUBS = {
  'src/lib/s3.ts': `
export function getS3Config(){ return { bucket:'test-bucket', region:'ap-northeast-1', prefix:'scan-accuracy-test/' }; }
export function makeS3Client(){ throw new Error('この検査では S3 を呼ばない'); }
export function isS3Configured(){ return true; }
export async function putFiles(){ throw new Error('この検査では S3 へ書かない'); }
export async function listObjects(){ return []; }
export async function getObjectText(){ return ''; }
export async function deleteObjects(){ return 0; }
`,
  'src/lib/supabase.ts': `
export function getServerSupabase(){ return null; }
export function getBrowserSupabase(){ return null; }
export function getBridgeSupabase(){ return null; }
`,
  // **実際の export 名にそろえる** (名前が足りないと ESM が静的に落ちる)。
  'src/lib/gemini.ts': `
export const MODELS = { get scan(){ return 'test'; }, get liveChat(){ return 'test'; } };
export function isGemini3Model(){ return false; }
export function normalizeGenerationConfigForModel(c){ return c; }
export async function callGemini(){ throw new Error('この検査では Gemini を呼ばない'); }
export function extractText(){ return ''; }
export function stripJsonCodeFence(t){ return t; }
`,
};

const emitted = new Set();
function emit(rel) {
  if (emitted.has(rel)) return outFor(rel);
  emitted.add(rel);
  const out = outFor(rel);

  if (STUBS[rel]) { writeFileSync(out, STUBS[rel]); return out; }

  const abs = join(repoRootAbs, rel);
  if (!existsSync(abs)) { writeFileSync(out, 'export default {};\n'); return out; }

  let src = readFileSync(abs, 'utf8');
  const dir = dirname(rel);
  // 相対 import / export ... from を辿る
  src = src.replace(/(from\s+|import\s*\()\s*'(\.[^']+)'/g, (m, head, spec) => {
    let target = join(dir, spec).replace(/\\/g, '/');
    if (!/\.[a-z]+$/.test(target)) target += '.ts';
    const dep = emit(target);
    return `${head}${JSON.stringify(pathToFileURL(dep).href)}`;
  });

  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  writeFileSync(out, js);
  return out;
}

async function load(rel) {
  const out = emit(rel);
  return import(pathToFileURL(out).href);
}

const loadedMods = {
  archive: await load('src/lib/ad-hoc-diagnosis/archive.ts'),
  pipeline: await load('src/lib/ad-hoc-diagnosis/pipeline.ts'),
  questionnaire: await load('src/lib/ad-hoc-diagnosis/questionnaire.ts'),
  qmap: await load('src/lib/ad-hoc-diagnosis/questionnaire-map.ts'),
};

const { archive, pipeline, questionnaire, qmap } = loadedMods;

const zipjs = await import('@zip.js/zip.js');
zipjs.configure({ useWebWorkers: false });
const { buildXlsx, serial1900 } = await import('./lib/make-test-xlsx.mjs');

// ===========================================================================
// テスト用 ZIP を組む。**実在の氏名・PII は 1 文字も入れない。**
// ===========================================================================
const T = (v) => ({ v, kind: 'text' });
const N = (v) => ({ v, kind: 'number' });
const D = (v) => ({ v, kind: 'date' });

// ── 健診 XLSX (39 列型を模した縮小版。marker の名前は実物と同じ) ──
async function healthCheckupXlsx(dateY, dateM, dateD, over = {}) {
  const headers = [
    '氏名', '健診日', '身長(cm)', '体重(kg)', 'BMI', '収縮期血圧', '拡張期血圧',
    'アルブミン', 'クレアチニン', '空腹時血糖', 'HbA1c', '尿酸', 'AST', 'ALT', 'γ-GTP',
    'LDLコレステロール', '中性脂肪', '白血球数', 'リンパ球', 'MCV', 'ALP', '腹囲',
  ];
  const row = [
    T('-'), D(serial1900(dateY, dateM, dateD)),
    N(over.height ?? 170), N(over.weight ?? 65), N(22.5), N(128), N(82),
    N(4.3), N(0.85), N(98), N(5.6), N(6.2), N(24), N(22), N(38),
    N(126), N(110), N(5.8), N(31), N(90), N(62), N(84),
  ];
  return buildXlsx({ headers, rows: [row], withCoverSheet: true });
}

// ── 問診 XLSX (外部フォームの 62 列型を模した縮小版・先頭 6 列は定型) ──
async function questionnaireXlsx(y, m, d) {
  const headers = [
    'ID', '開始時刻', '完了時刻', 'メール', '名前', '最終変更時刻',
    '生物学的性別', '生年月日', '身長', '体重', '体重変化',
    '自覚症状', '現在罹患している疾患', '過去に罹患した疾患',
    '喫煙習慣', '1日の喫煙本数', '喫煙年数',
    '飲酒習慣', '1回あたり飲酒量',
    '野菜', 'フルーツ', '魚', '赤身肉・加工肉', '揚げ物', '塩分', '間食', 'カフェイン', 'ご飯',
    '運動頻度', '運動時間', '歩行速度', '座位時間', '運動種類',
    '薬・サプリ', '睡眠時間', '睡眠の質', 'ストレス',
  ];
  const row = [
    T('R1'), D(serial1900(y, m, d)), D(serial1900(y, m, d)),
    T('***@example.com'), T('-'), D(serial1900(y, m, d)),
    T('男性'), T('1975-04-01'), T('170'), T('65'), T('該当するものはない'),
    T('肩こり, 腰痛'), T('高血圧'), T('なし'),
    T('過去に吸っていたが現在は吸わない'), T('11〜20本'), T('10〜20年'),
    T('週2〜3日飲む'), T('1〜2合'),
    T('週2〜3回'), T('週1回以下'), T('週2〜3回'), T('週4〜5回'), T('週1回以下'),
    T('ほぼ毎日'), T('週2〜3回'), T('1日1〜2杯'), T('茶碗1杯（約150g）'),
    T('週3〜4日'), T('30〜60分'), T('速い'), T('6〜9時間'), T('ウォーキング, 筋力トレーニング'),
    T('ある'), T('6〜7時間'), T('普通'), T('6'),
  ];
  return buildXlsx({ headers, rows: [row], sheetName: '問診回答' });
}

// ── 遺伝子 PDF (Genoplan の目印つき・最小の PDF) ──
function genoplanPdf(pages = 3) {
  const objs = [];
  const kids = [];
  let n = 3;
  const contents = [];
  for (let i = 0; i < pages; i++) {
    const cid = n++;
    const pid = n++;
    contents.push(`${cid} 0 obj\n<< /Length 60 >>\nstream\nBT /F1 12 Tf 40 700 Td (Genoplan Report page ${i + 1}) Tj ET\nendstream\nendobj\n`);
    objs.push(`${pid} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${cid} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>\nendobj\n`);
    kids.push(`${pid} 0 R`);
  }
  const body =
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
    `2 0 obj\n<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>\nendobj\n` +
    contents.join('') + objs.join('');
  const pdf = `%PDF-1.4\n${body}trailer\n<< /Root 1 0 R >>\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

async function buildZip(files) {
  const w = new zipjs.ZipWriter(new zipjs.Uint8ArrayWriter());
  for (const [name, content] of files) await w.add(name, new zipjs.Uint8ArrayReader(content));
  return await w.close();
}

/** S3 の代わりに Uint8Array から読む Reader。**算術は S3RangeReader と同じ**。 */
function memReader(bytes) {
  const r = new zipjs.Reader('mem');
  r.size = bytes.length;
  r.init = async () => {};
  r.readUint8Array = async (offset, length) => {
    const actual = archive.clampReadLength(offset, length, bytes.length);
    if (actual <= 0) return new Uint8Array(0);
    const m = /bytes=(\d+)-(\d+)/.exec(archive.rangeHeaderFor(offset, actual));
    return bytes.slice(Number(m[1]), Number(m[2]) + 1);
  };
  return r;
}

// ===========================================================================
// E2E: ZIP を組んで、分類 → 解析 → 納品 (dry-run) まで通す
// ===========================================================================
const hcA = await healthCheckupXlsx(2026, 3, 29);
const hcB = await healthCheckupXlsx(2026, 4, 5, { height: 162, weight: 55 });
const qA = await questionnaireXlsx(2026, 3, 29);
const qB = await questionnaireXlsx(2026, 4, 5);
const gA = genoplanPdf(3);

const zipBytes = await buildZip([
  ['臨時診断_2026_09/被験者01/健診結果.xlsx', hcA],
  ['臨時診断_2026_09/被験者01/問診回答.xlsx', qA],
  ['臨時診断_2026_09/被験者01/AB12-CD34-EF56.pdf', gA],
  ['臨時診断_2026_09/被験者02/健診結果.xlsx', hcB],
  ['臨時診断_2026_09/被験者02/問診回答.xlsx', qB],
  ['臨時診断_2026_09/一覧.xlsx', hcA],                    // 人物フォルダの外 = batch_reference
  ['臨時診断_2026_09/被験者01/~$一時.xlsx', hcA],          // ノイズ
  ['臨時診断_2026_09/被験者01/メモ.txt', new TextEncoder().encode('x')], // 対象外の拡張子
]);
ok('e2e: ZIP を組めた', zipBytes.length > 0, `${zipBytes.length} バイト`);

const opened = await archive.openArchive(memReader(zipBytes));
const analysis = await pipeline.analyzeOpened(opened);
await opened.close();

// ── 人物分離 ──
eq('e2e: 人物が 2 名', analysis.subjects.length, 2);
eq('e2e: 人物 1 は 3 ファイル', analysis.subjects[0].files.length, 3);
eq('e2e: 人物 2 は 2 ファイル', analysis.subjects[1].files.length, 2);
eq('e2e: 採番は Central Directory 順', analysis.subjects.map((s) => s.subjectNo).join(','), '1,2');
ok('e2e: 人物フォルダ外は batch_reference', analysis.batchReference.length >= 1);
ok('e2e: fingerprint がつく', analysis.subjects.every((s) => /^[0-9a-f]{64}$/.test(s.fingerprint ?? '')));
ok('e2e: 人物ごとに違う fingerprint',
  analysis.subjects[0].fingerprint !== analysis.subjects[1].fingerprint);
ok('e2e: ノイズと対象外は取り込まない',
  analysis.subjects[0].files.every((f) => !f.path.includes('~$') && !f.path.endsWith('.txt')));

// ── 分類 ──
const s1 = analysis.subjects[0];
const fmt = (s) => s.files.map((f) => f.classification.formatId).sort();
eq('e2e: 人物1 の分類', JSON.stringify(fmt(s1)),
  JSON.stringify(['GeneticTestResultData', 'HealthCheckupData', 'LifestyleQuestionnaireData']));
const hcFile = s1.files.find((f) => f.classification.formatId === 'HealthCheckupData');
const qFile = s1.files.find((f) => f.classification.formatId === 'LifestyleQuestionnaireData');
const gFile = s1.files.find((f) => f.classification.formatId === 'GeneticTestResultData');
eq('e2e: 健診は confirmed', hcFile.classification.confidence, 'confirmed');
eq('e2e: 問診は confirmed', qFile.classification.confidence, 'confirmed');
eq('e2e: 遺伝子は名前+テキストで confirmed', gFile.classification.confidence, 'confirmed');
eq('e2e: 遺伝子のページ数を数えられる', gFile.pageCount, 3);
eq('e2e: 表示名に元ファイル名を残さない', hcFile.displayName.includes('健診結果'), false);
ok('e2e: 表示名は {分類}_{連番}{拡張子}', /^(健診|問診|遺伝子)_\d{2}\.(xlsx|pdf)$/.test(hcFile.displayName),
  hcFile.displayName);

// ── 健診 → HealthCheckupData ──
eq('e2e: 健診の検査日', hcFile.testDate, '2026-03-29');
const built = pipeline.buildHealthCheckupJson({ clientId: 'CID-1', sheet: hcFile.healthCheckup });
eq('e2e: HealthCheckupData の format_id', built.json.format_id, 'HealthCheckupData');
eq('e2e: test_date', built.json.test_date, '2026-03-29');
ok('e2e: 測定値が入る', built.itemCount > 5, `${built.itemCount} 項目`);
ok('e2e: marker を拾える (albumin)', built.markers.albumin === 4.3, JSON.stringify(built.markers.albumin));
ok('e2e: marker を拾える (creatinine)', built.markers.creatinine === 0.85);
ok('e2e: 納品 JSON に氏名が入らない', JSON.stringify(built.json).includes('氏名') === false);

// ── 問診 → LifestyleQuestionnaireData ──
const qn = qFile.questionnaire;
ok('e2e: 問診を写像できた', qn && qn.mappedCount > 0, `mapped=${qn?.mappedCount}`);
eq('e2e: 問診の様式', qn.profile, 'external_form_xlsx_v1');
eq('e2e: 完了時刻から日付を取る', qn.completedAt.date, '2026-03-29');
eq('e2e: 性別', qn.subject.sex, 'male');
ok('e2e: 年齢を出せる', typeof qn.subject.age === 'number', String(qn.subject.age));
eq('e2e: 喫煙 (既存ラベルへ落ちる)', qn.answers['S-STATUS'], '過去に吸っていたが現在は吸わない');
eq('e2e: 飲酒', qn.answers['D-FREQ'], '週2〜3日飲む');
eq('e2e: 睡眠', qn.answers['SL-HOURS'], '6〜7時間');
eq('e2e: ストレスは数値', qn.answers['SL-STRESS'], 6);
eq('e2e: 複数選択を配列で', JSON.stringify(qn.answers['H-SYMPTOMS']), JSON.stringify(['肩こり', '腰痛']));
ok('e2e: 摂取頻度マトリクスを畳める',
  qn.answers['F-FREQ'] && qn.answers['F-FREQ']['野菜・海藻類'] === '週2〜3回',
  JSON.stringify(qn.answers['F-FREQ']));

const qBuilt = pipeline.buildQuestionnaireJson({
  clientId: 'CID-1', diagnosticId: 'DID-1', normalized: qn,
});
eq('e2e: LifestyleQuestionnaireData の format_id', qBuilt.json.format_id, 'LifestyleQuestionnaireData');
eq('e2e: 問診の test_date', qBuilt.testDate, '2026-03-29');
ok('e2e: 回答が載る', qBuilt.answerCount > 5, `${qBuilt.answerCount} 件`);
// **PII を納品 JSON へ入れない**
const qStr = JSON.stringify(qBuilt.json);
ok('e2e: 納品 JSON にメールが入らない', qStr.includes('example.com') === false);
ok('e2e: 納品 JSON に生年月日が入らない', qStr.includes('1975-04-01') === false);
eq('e2e: subject.sex は載る', qBuilt.json.subject.sex, 'male');
ok('e2e: subject.age は載る', typeof qBuilt.json.subject.age === 'number');

// ── 遺伝子 → GeneticTestResultData (**LLM は呼ばずページ結果を差し込む**) ──
const gBuilt = pipeline.buildGeneticJson({
  clientId: 'CID-1',
  parts: [
    { page: 1, section: 'がん', items: [{ name: 'A', risk: '低' }] },
    { page: 2, section: '一般疾患', items: [{ name: 'B', risk: '中' }, { name: 'C', risk: '高' }] },
  ],
  testDate: '2026-03-29',
});
eq('e2e: GeneticTestResultData の format_id', gBuilt.json.format_id, 'GeneticTestResultData');
eq('e2e: 項目を集約する', gBuilt.itemCount, 3);
eq('e2e: ページ数', gBuilt.json.page_count, 2);

// ── ウェルネス年齢 ──
const wa = pipeline.computeSubjectWellnessAge({
  clientId: 'CID-1', markers: built.markers, age: qn.subject.age, sex: qn.subject.sex,
  testDate: '2026-03-29',
});
ok('e2e: ウェルネス年齢を算出できる', wa.method === 'full' || wa.method === 'simple', wa.method);
ok('e2e: 値が入る', typeof wa.result?.biological_age === 'number');
eq('e2e: HealthAgeData の format_id', wa.json?.format_id, 'HealthAgeData');
// **算出できなくても人物を落とさない**
const waNo = pipeline.computeSubjectWellnessAge({
  clientId: 'CID-1', markers: {}, age: null, sex: null, testDate: null,
});
eq('e2e: 材料が無ければ unavailable', waNo.method, 'unavailable');
eq('e2e: unavailable では値を作らない', waNo.json, null);
ok('e2e: unavailable でも定型文を返す', typeof waNo.message === 'string' && waNo.message.length > 0);

// ── 納品セット (dry-run 相当) ──
const files = [
  pipeline.toDeliveryFile('scan-accuracy-test/', 'CID-1', 'HealthCheckupData', '2026-03-29', built.json),
  pipeline.toDeliveryFile('scan-accuracy-test/', 'CID-1', 'LifestyleQuestionnaireData', '2026-03-29', qBuilt.json),
  pipeline.toDeliveryFile('scan-accuracy-test/', 'CID-1', 'GeneticTestResultData', '2026-03-29', gBuilt.json),
  pipeline.toDeliveryFile('scan-accuracy-test/', 'CID-1', 'HealthAgeData', '2026-03-29', wa.json),
];
eq('e2e: 納品 key (Elith のパス規則)',
  files[0].key,
  'scan-accuracy-test/user/CID-1/date/2026_03_29/HealthCheckupData_date_2026_03_29_user_CID-1.json');
ok('e2e: 4 format ぶんの key が出る', files.length === 4);
ok('e2e: どの key も同じ日付フォルダ', files.every((f) => f.key.includes('/date/2026_03_29/')));
ok('e2e: JSON として解釈できる', files.every((f) => { try { JSON.parse(f.body); return true; } catch { return false; } }));
ok('e2e: バイト数が入る', files.every((f) => f.bytes > 0));

// ── ready 判定 (臨時バッチ専用・既存 GATING_FORMAT_IDS を触らない) ──
const readyAll = pipeline.evaluateReadiness({
  producedFormats: ['HealthCheckupData', 'LifestyleQuestionnaireData', 'GeneticTestResultData', 'HealthAgeData'],
  requiredFormats: pipeline.AD_HOC_REQUIRED_FORMATS,
  optionalFormats: pipeline.AD_HOC_OPTIONAL_FORMATS,
  classifications: s1.files.map((f) => f.classification),
});
eq('e2e: 3 種そろえば ready', readyAll.ready, true);
eq('e2e: 任意の HealthAgeData を認識', readyAll.presentOptional.join(','), 'HealthAgeData');

const readyMissing = pipeline.evaluateReadiness({
  producedFormats: ['HealthCheckupData'],
  requiredFormats: pipeline.AD_HOC_REQUIRED_FORMATS,
  optionalFormats: pipeline.AD_HOC_OPTIONAL_FORMATS,
  classifications: s1.files.map((f) => f.classification),
});
eq('e2e: 必須が欠けたら ready にしない', readyMissing.ready, false);
eq('e2e: 何が足りないか出す', readyMissing.missingRequired.sort().join(','),
  'GeneticTestResultData,LifestyleQuestionnaireData');

const readyReview = pipeline.evaluateReadiness({
  producedFormats: pipeline.AD_HOC_REQUIRED_FORMATS,
  requiredFormats: pipeline.AD_HOC_REQUIRED_FORMATS,
  optionalFormats: [],
  classifications: [{ sourceKind: 'person_file', formatId: 'HealthCheckupData', confidence: 'probable', reason: '' }],
});
eq('e2e: probable が残っていたら ready にしない', readyReview.ready, false);

// ── 人物 2 も同じ形で通る (1 人だけ通っていないことの確認) ──
const s2 = analysis.subjects[1];
const hc2 = s2.files.find((f) => f.classification.formatId === 'HealthCheckupData');
const q2 = s2.files.find((f) => f.classification.formatId === 'LifestyleQuestionnaireData');
eq('e2e: 人物2 の健診日', hc2.testDate, '2026-04-05');
eq('e2e: 人物2 の問診日', q2.questionnaire.completedAt.date, '2026-04-05');
const built2 = pipeline.buildHealthCheckupJson({ clientId: 'CID-2', sheet: hc2.healthCheckup });
eq('e2e: 人物2 も測定値が入る', built2.itemCount > 5, true);
eq('e2e: 人物2 の client_id で組まれる', built2.json.client_id, 'CID-2');
eq('e2e: 人物2 の test_date', built2.json.test_date, '2026-04-05');
ok('e2e: 人物ごとに別の key になる',
  pipeline.deliveryKey('p/', 'CID-2', 'HealthCheckupData', '2026-04-05') !==
  pipeline.deliveryKey('p/', 'CID-1', 'HealthCheckupData', '2026-03-29'));

// ── 再開: 同じ ZIP を読み直すと同じ fingerprint になる ──
{
  const again = await archive.openArchive(memReader(zipBytes));
  const a2 = await pipeline.analyzeOpened(again);
  await again.close();
  eq('resume: 人物数が同じ', a2.subjects.length, analysis.subjects.length);
  ok('resume: fingerprint が一致する',
    a2.subjects.every((s, i) => s.fingerprint === analysis.subjects[i].fingerprint));
  ok('resume: 採番も一致する',
    a2.subjects.every((s, i) => s.subjectNo === analysis.subjects[i].subjectNo));
}

// ── 1 バイト違う ZIP は別物になる ──
{
  const other = await buildZip([
    ['臨時診断_2026_09/被験者01/健診結果.xlsx', hcB],
    ['臨時診断_2026_09/被験者01/問診回答.xlsx', qA],
  ]);
  const o = await archive.openArchive(memReader(other));
  const a3 = await pipeline.analyzeOpened(o);
  await o.close();
  ok('resume: 中身が違えば fingerprint も違う',
    a3.subjects[0].fingerprint !== analysis.subjects[0].fingerprint);
}

// ── 問診 PDF の 2 様式 ──
{
  const common = questionnaire.normalizeQuestionnairePdf(
    'Welltect 問診票\n嗜好品\n喫煙習慣: 現在吸っている\n飲酒習慣: 毎日飲む\n' +
    '食生活\n睡眠時間: 7〜8時間\n心身\nストレス: 8\n運動頻度: 週1〜2日\n',
  );
  eq('pdf: Welltect 共通問診と判定', common.profile, 'welltect_common_v1');
  eq('pdf: 喫煙を写像', common.answers['S-STATUS'], '現在吸っている');
  eq('pdf: 睡眠を写像', common.answers['SL-HOURS'], '7〜8時間');
  eq('pdf: ストレスを数値で', common.answers['SL-STRESS'], 8);
  ok('pdf: 複数の設問を拾える', common.mappedCount >= 4, `${common.mappedCount} 件`);

  const short = questionnaire.normalizeQuestionnairePdf(
    'AI疾病予防 短縮問診\n喫煙習慣: 吸ったことはない\n運動頻度: ほぼ毎日（週5日以上）\n' +
    '未知の設問: 何か\n',
  );
  eq('pdf: 短縮問診と判定', short.profile, 'ai_prevention_short_v1');
  eq('pdf: 対応する設問は写像', short.answers['S-STATUS'], '吸ったことはない');
  ok('pdf: 未対応があっても止まらない', questionnaire.questionnaireIsUsable(short));
  ok('pdf: 未対応は unmapped に出る', Array.isArray(short.unmapped));
}

// ── 写像できない値を勝手に寄せない ──
{
  const r = qmap.mapCell('喫煙習慣', 'ときどき吸う');
  eq('map: 知らない値は unmapped', r.status, 'unmapped');
  eq('map: 理由を残す', r.reason, 'unknown_value');
  const r2 = qmap.mapCell('宇宙旅行の頻度', '週1');
  eq('map: 知らない列は unmapped', r2.reason, 'unknown_column');
  const r3 = qmap.mapCell('メール', 'x@example.com');
  eq('map: PII 列は skipped', r3.status, 'skipped');
  eq('map: PII と分かる理由', r3.reason, 'pii');
}

// ── S3RangeReader の丸め (zip.js の Reader 契約) ──
{
  eq('clamp: 末尾をまたぐ要求を丸める', archive.clampReadLength(90, 50, 100), 10);
  eq('clamp: 収まる要求はそのまま', archive.clampReadLength(0, 50, 100), 50);
  eq('clamp: offset が size 以上なら 0', archive.clampReadLength(100, 10, 100), 0);
  eq('clamp: offset が size 超なら 0', archive.clampReadLength(200, 10, 100), 0);
  eq('clamp: 負の offset は 0', archive.clampReadLength(-1, 10, 100), 0);
  eq('clamp: length 0 は 0', archive.clampReadLength(0, 0, 100), 0);
  eq('clamp: size 0 は 0', archive.clampReadLength(0, 10, 0), 0);
  eq('clamp: ちょうど末尾', archive.clampReadLength(99, 1, 100), 1);
}

rmSync(tmp, { recursive: true, force: true });
const total = pass + failures.length;
if (failures.length) {
  console.error(`\n✗ verify:ad-hoc-e2e  ${pass}/${total}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ verify:ad-hoc-e2e  ${pass}/${total}`);
