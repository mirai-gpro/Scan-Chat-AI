#!/usr/bin/env node
/**
 * 分割分類 (Phase B2.1) の回帰チェック — Scan 側。
 *
 * 【なぜ要るか】ここで壊れるものは**画面上は正常に見える**:
 *   - `normalized_payload` に氏名が 1 つ混ざっても動作は何も変わらない
 *     (診断側の DB に PII が入る = 設計だけが静かに壊れる)
 *   - `Date` セルを落とし忘れても JSON は通り、**日付が測定値として納品**される
 *   - 後工程に `analyzeOpened` が 1 か所でも残っていれば、分割した意味が消えて
 *     **また同じタイムアウト**になる (しかも小さい ZIP では再現しない)
 *   - 冪等でない upsert は、通信が切れて同じ序数をやり直したときだけ行が 2 つになる
 *
 * **外部 DB / AWS / ネットワークを使わない。** ソース検査と、実物を transpile した
 * ロジックの実行だけ。
 *
 * 実行: node scripts/verify-ad-hoc-chunked.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

/** コメントを外した「実際に動くコード」だけを見る (説明文に語が出るため)。 */
function stripComments(src) {
  let out = ''; let i = 0; let mode = 'code';
  while (i < src.length) {
    const c = src[i]; const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
      if (c === "'") mode = 'sq'; else if (c === '"') mode = 'dq'; else if (c === '`') mode = 'tpl';
      out += c; i++; continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c; } i++; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i += 2; continue; } if (c === '\n') out += c; i++; continue; }
    if (c === '\\') { out += c + (n ?? ''); i += 2; continue; }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) mode = 'code';
    out += c; i++;
  }
  return out;
}

/**
 * `export function name(` から**括弧と波括弧を数えて**本体の終わりまで取り出す。
 *
 * 正規表現で `\n}` まで取ると、**引数のオブジェクト型の閉じ括弧で止まる**
 * (Phase B1 で実際にそうなり、抽出した関数が呼べないのに検査は通っていた)。
 */
function extractFn(src, name) {
  const start = src.indexOf(`export function ${name}(`);
  if (start < 0) return null;
  let i = src.indexOf('(', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  const brace = src.indexOf('{', i);
  if (brace < 0) return null;
  depth = 0;
  for (let j = brace; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return null;
}

async function transpileToModule(source, fileName) {
  const ts = (await import('typescript')).default;
  const CACHE = resolve(ROOT, 'node_modules/.cache');
  mkdirSync(CACHE, { recursive: true });
  const p = resolve(CACHE, fileName);
  writeFileSync(p, ts.transpileModule(source, {
    compilerOptions: { target: 'ES2022', module: 'ESNext' },
  }).outputText);
  return import(`${p}?t=${Date.now()}`);
}

const MIG_AD_HOC = 'supabase/migrations/20260910000020_ad_hoc_diagnosis.sql';
const MIG_B1 = 'supabase/migrations/20260911000010_executive_subject_link.sql';
const MIG_B21 = 'supabase/migrations/20260912000010_ad_hoc_chunked_classify.sql';
const PAYLOAD = 'src/lib/ad-hoc-diagnosis/normalized-payload.ts';
const PIPELINE = 'src/lib/ad-hoc-diagnosis/pipeline.ts';
const ARCHIVE = 'src/lib/ad-hoc-diagnosis/archive.ts';
const SERVICE = 'src/lib/ad-hoc-diagnosis/service.ts';
const STORE = 'src/lib/ad-hoc-diagnosis/store.ts';

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== A. 新しい前進 migration である (既存を編集していない) ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  eq('B2.1 の migration が在る', existsSync(resolve(ROOT, MIG_B21)), true);
  const sql = read(MIG_B21);

  /*
   * **適用済みの migration を編集して当て直さない** (CLAUDE.md の確定事項)。
   * `db push` は未適用ぶんしか流さないので、編集すると
   * **同じファイル名で中身の違う DB が並ぶ**。
   */
  const b1 = read(MIG_B1);
  eq('20260910000020 に分割分類の列を足していない', /archive_entry_index|normalized_payload/.test(read(MIG_AD_HOC)), false);
  eq('20260911000010 に分割分類の列を足していない', /archive_entry_index|normalized_payload/.test(b1), false);

  // **後方互換**: どちらも nullable・既定なし = 既存行は NULL で始まる。
  eq('archive_entry_index を add column if not exists で足す', /add column if not exists archive_entry_index integer/.test(sql), true);
  eq('normalized_payload を add column if not exists で足す', /add column if not exists normalized_payload jsonb/.test(sql), true);
  eq('not null を付けていない', /archive_entry_index integer[^;]*not null/i.test(sql), false);
  eq('default を付けていない', /(archive_entry_index|normalized_payload)[^;]*\bdefault\b/i.test(sql), false);

  // 負の序数を入れさせない。
  eq('archive_entry_index >= 0 の check が在る', /check \(archive_entry_index is null or archive_entry_index >= 0\)/.test(sql), true);

  /*
   * **同じエントリから 2 行作らない**土台。
   * `where archive_entry_index is not null` の部分インデックスなので、
   * **旧バッチの NULL 行は何行あってもよい** (共存できる)。
   */
  eq('(batch_id, archive_entry_index) の一意インデックスが在る',
    /create unique index if not exists \S+\s+on diagnosis\.ad_hoc_diagnosis_files \(batch_id, archive_entry_index\)/.test(sql), true);
  eq('部分インデックス (NULL は除外) である', /where archive_entry_index is not null/.test(sql), true);

  // migration 自体に PII の列を作っていないこと。
  for (const re of [/\bfull_name\b/i, /\bemail\b/i, /\bcompany\b/i, /\bjob_title\b/i, /\bfile_name\b/i, /\bzip_path\b/i]) {
    eq(`migration に ${re.source} が無い`, re.test(sql), false);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== B. deny-list が実際に throw する (PII を DB へ通さない) ===');
// ═══════════════════════════════════════════════════════════════════════════
let PL = null;
{
  /*
   * **実物を動かす。** 「禁止語の配列に入っている」ことを目視するだけでは、
   * 判定が部分一致でなくなった / 再帰していない、といった壊れ方を検出できない。
   */
  const src = read(PAYLOAD)
    .replace(/^import .*$/gm, '')                       // 型だけの import を落とす
    .replace(/: HealthCheckupSheet/g, ': any')
    .replace(/HealthCheckupSheet\['[a-zA-Z]+'\]/g, 'any')
    .replace(/QuestionnaireNormalized\['[a-zA-Z]+'\]/g, 'any')
    .replace(/: QuestionnaireNormalized/g, ': any')
    .replace(/QuestionnaireNormalized \| null/g, 'any')
    .replace(/HealthCheckupSheet \| null/g, 'any')
    .replace(/: CellValue/g, ': any')
    .replace(/isBlankCell\(/g, 'BLANK(');
  PL = await transpileToModule(
    `const BLANK = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');\n${src}`,
    'verify-b21-payload.mjs',
  );

  const throws = (payload) => {
    try { PL.assertNoPiiKeys(payload, 'test'); return false; } catch { return true; }
  };

  eq('display_name で throw する', throws({ display_name: 'x' }), true);
  eq('fullName で throw する', throws({ fullName: 'x' }), true);
  eq('email で throw する', throws({ email: 'x' }), true);
  eq('company_name で throw する', throws({ company_name: 'x' }), true);
  eq('job_title で throw する', throws({ job_title: 'x' }), true);
  eq('zip_path で throw する', throws({ zip_path: 'a/b' }), true);
  eq('folder で throw する', throws({ folder: 'x' }), true);
  eq('date_of_birth で throw する', throws({ date_of_birth: 'x' }), true);
  // **入れ子・配列の中も見る** (rows[][] の中に潜り込む形が実際にあり得る)。
  eq('入れ子の中の name も見つける', throws({ a: { b: [{ c: { person_name: 'x' } }] } }), true);
  // 通ってよいもの
  eq('h / v は通る', throws({ rows: [[{ h: '身長', v: 170 }]] }), false);
  eq('test_date は通る', throws({ test_date: { status: 'resolved', date: '2026-01-01' } }), false);

  /*
   * **例外に値を出さない。** 例外メッセージはログへ流れるので、
   * キー名だけを出し**値 (=氏名そのもの) は絶対に出さない**。
   */
  let msg = '';
  try { PL.assertNoPiiKeys({ display_name: '山田太郎' }, 'test'); } catch (e) { msg = String(e.message); }
  eq('例外にキー名が出る', msg.includes('display_name'), true);
  eq('例外に値が出ない', msg.includes('山田太郎'), false);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== C. 健診 payload — PII 列を落とし、Date を落とし、notes を持たない ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const sheet = {
    headerRowIndex: 0, headerHits: 6, headers: ['氏名', '身長', '検査日'],
    rows: [[
      { header: '氏名', value: '山田 太郎' },
      { header: 'フリガナ', value: 'ヤマダ タロウ' },
      { header: 'メールアドレス', value: 'a@example.com' },
      { header: '身長', value: 170.5 },
      { header: '空欄の項目', value: '' },
      { header: '受診日', value: new Date('2026-01-05T00:00:00Z') },
      { header: '所属', value: '株式会社ウェルフォート' },
      { header: '尿蛋白', value: '(-)' },
    ]],
    testDate: { status: 'resolved', date: '2026-01-05' },
    // **シート名が人物の氏名であることがある** (`health-checkup-xlsx.ts` が入れる)。
    notes: ['sheet=山田太郎'],
  };
  const p = PL.buildHealthCheckupPayload(sheet);
  const flat = JSON.stringify(p);

  eq('氏名が payload に出ない', flat.includes('山田'), false);
  eq('カナが payload に出ない', flat.includes('ヤマダ'), false);
  eq('メールが payload に出ない', flat.includes('example.com'), false);
  eq('会社名が payload に出ない', flat.includes('ウェルフォート'), false);
  eq('notes を持たない (シート名=氏名の恐れ)', 'notes' in p, false);
  eq('落とした列の件数だけ残る', p.dropped_pii_columns, 4);

  const kept = p.rows[0].map((c) => c.h);
  eq('数値は残る', kept.includes('身長'), true);
  eq('定性値は残る', kept.includes('尿蛋白'), true);
  eq('空欄 (未実施) は落ちる', kept.includes('空欄の項目'), false);
  /*
   * **Date を落とす。** JSON 化すると文字列になり、復元後に
   * `sheetRowToMeasurements` の `value instanceof Date` が効かなくなって
   * **受診日が測定値として納品される**。
   */
  eq('Date セルは落ちる', kept.includes('受診日'), false);
  eq('test_date は別に残る', p.test_date.date, '2026-01-05');

  // 往復して同じ形に戻ること (納品 JSON の材料として使えること)。
  const back = PL.restoreHealthCheckupSheet(JSON.parse(JSON.stringify(p)));
  eq('復元できる', back !== null, true);
  eq('復元後も氏名の列が無い', JSON.stringify(back).includes('氏名'), false);
  eq('復元後に身長が残る', back.rows[0].some((c) => c.header === '身長' && c.value === 170.5), true);
  eq('復元後の notes は空', JSON.stringify(back.notes), '[]');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== D. 問診 payload — unmapped の見出しと notes を保存しない ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const q = {
    profile: 'external_form',
    answers: { 'Q-SMOKE': 'no', 'Q-SLEEP': 6 },
    subject: { sex: 'male', age: 54 },
    completedAt: { status: 'resolved', date: '2026-01-05' },
    // `UnmappedItem.header` は元の見出し = **DB へは保存しない**と型定義にも書いてある。
    unmapped: [{ header: '氏名（カナ）', value: 'ヤマダ タロウ' }],
    mappedCount: 2,
    notes: ['sheet=山田太郎'],
  };
  const p = PL.buildQuestionnairePayload(q);
  const flat = JSON.stringify(p);
  eq('unmapped の中身が出ない', flat.includes('ヤマダ'), false);
  eq('unmapped の見出しが出ない', flat.includes('氏名'), false);
  eq('notes を持たない', 'notes' in p, false);
  eq('件数だけ残る', p.unmapped_count, 1);
  eq('設問 ID の answers は残る', p.answers['Q-SMOKE'], 'no');
  eq('性別・年齢は残る', [p.sex, p.age], ['male', 54]);

  const back = PL.restoreQuestionnaire(JSON.parse(JSON.stringify(p)));
  eq('復元できる', back !== null, true);
  eq('復元後の unmapped は空', JSON.stringify(back.unmapped), '[]');
  eq('復元後も回答は残る', back.answers['Q-SLEEP'], 6);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== E. 入れ物 (EntryPayload) — 健診と問診の両方を持てる ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  /*
   * **なぜ両方持つか**: `.xlsx` は健診としても問診としても読む。分類は後から
   * 管理者に直されることがあるので、読んだときの分類だけを保存すると
   * **直したあとに材料が無く黙って納品から落ちる**。
   */
  const both = PL.buildEntryPayload({
    healthCheckup: {
      headerRowIndex: 0, headerHits: 4, headers: [],
      rows: [[{ header: 'HbA1c', value: 5.4 }]],
      testDate: { status: 'resolved', date: '2026-01-05' }, notes: [],
    },
    questionnaire: {
      profile: 'external_form', answers: { 'Q-A': 1 }, subject: { sex: null, age: null },
      completedAt: { status: 'absent' }, unmapped: [], mappedCount: 1, notes: [],
    },
  });
  eq('両方入る', [!!both.health_checkup, !!both.questionnaire], [true, true]);
  eq('健診として復元できる', PL.restoreHealthCheckupSheet(both) !== null, true);
  eq('問診として復元できる', PL.restoreQuestionnaire(both) !== null, true);
  eq('どちらも無ければ null (空の入れ物を作らない)', PL.buildEntryPayload({}), null);
  // 遺伝子はここを通らない = null のまま。
  eq('遺伝子は payload を持たない', PL.buildEntryPayload({ }), null);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== F. 書き込みの扉 (store) が必ず検査を通す ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const src = stripComments(read(STORE));
  eq('store が assertNoPiiKeys を import している', /import \{ assertNoPiiKeys \} from '\.\/normalized-payload'/.test(read(STORE)), true);
  eq('replaceFiles が検査を通す', /guardPayload\(files, 'replaceFiles'\)/.test(src), true);
  eq('upsertFileByEntryIndex が検査を通す', /guardPayload\(\[file\], 'upsertFileByEntryIndex'\)/.test(src), true);
  eq('updateFile が検査を通す', /assertNoPiiKeys\(patch\.normalized_payload, 'updateFile'\)/.test(src), true);

  // **検査が insert / update より前に在る**こと (後ろだと書いてから落ちる)。
  const fn = src.slice(src.indexOf('export async function upsertFileByEntryIndex'));
  const guardAt = fn.indexOf('guardPayload');
  const insertAt = fn.indexOf(".from('ad_hoc_diagnosis_files')");
  eq('検査が DB 呼び出しより前', guardAt >= 0 && insertAt > guardAt, true);

  // 序数の型もサーバ側で見る (ブラウザから来る数字なので)。
  eq('entryIndex が整数か検査している', /Number\.isInteger\(entryIndex\)[\s\S]{0,40}entryIndex < 0/.test(fn), true);

  /*
   * **`upsert(onConflict)` を使わない。** 一意インデックスが部分インデックスなので
   * PostgREST からは推論できず、**黙って重複 insert になる**。
   */
  eq('onConflict を使っていない', /onConflict/.test(fn), false);
  eq('select → update / insert で冪等にしている', /maybeSingle\(\)[\s\S]*prev[\s\S]*update\([\s\S]*insert\(/.test(fn), true);

  // FileRow の型に列が在る (画面と後工程が読む)。
  eq('FileRow に archive_entry_index が在る', /archive_entry_index: number \| null;/.test(src), true);
  eq('FileRow に normalized_payload が在る', /normalized_payload: unknown;/.test(src), true);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== G. 人物行を作り直さない (再開できる) ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const src = stripComments(read(STORE));
  const fn = src.slice(
    src.indexOf('export async function ensureSubjectPlaceholders'),
    src.indexOf('export async function listSubjects'),
  );
  eq('ensureSubjectPlaceholders が在る', fn.length > 0, true);
  eq('delete を呼ばない', /\.delete\(\)/.test(fn), false);
  eq('既に在る subject_no は触らない', /have\.has\(n\)/.test(fn), true);

  /*
   * **plan が subjects を作り直したら Executive の紐付けも遺伝子のページも消える**
   * (cascade)。再開できることが分割の目的なので、ここは致命的。
   */
  const svc = stripComments(read(SERVICE));
  const plan = svc.slice(svc.indexOf('export async function classifyPlan'), svc.indexOf('export async function classifyEntry'));
  eq('classifyPlan が replaceSubjects を呼ばない', /replaceSubjects/.test(plan), false);
  eq('classifyPlan が ensureSubjectPlaceholders を使う', /ensureSubjectPlaceholders/.test(plan), true);
  eq('classifyPlan が replaceFiles を呼ばない', /replaceFiles/.test(plan), false);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== H. planArchive は中身を 1 バイトも読まない ===');
// ═══════════════════════════════════════════════════════════════════════════
let PLAN = null;
{
  const pipe = read(PIPELINE);
  const cls = read('src/lib/ad-hoc-diagnosis/classify.ts');
  const body = extractFn(pipe, 'planArchive');
  eq('planArchive を取り出せる', body !== null && body.includes('subjectNoByFolder'), true);

  const src = [
    extractFn(cls, 'isNoiseEntry'),
    extractFn(cls, 'personFolderOf'),
    extractFn(cls, 'commonRootPrefix'),
    body.replace(/: OpenedArchive/, ': any').replace(/: ArchivePlan/, ': any')
      .replace(/const adopted: \{ index: number; entry: ArchiveEntry \}\[\]/, 'const adopted')
      .replace(/const rejected: \{ entryIndex: number; reason: string \}\[\]/, 'const rejected')
      .replace(/const workItems: PlanWorkItem\[\]/, 'const workItems')
      .replace(/const batchReferenceItems: PlanWorkItem\[\]/, 'const batchReferenceItems')
      .replace(/const notes: string\[\]/, 'const notes'),
    'export { planArchive, isNoiseEntry, personFolderOf, commonRootPrefix };',
  ].join('\n');
  PLAN = await transpileToModule(src, 'verify-b21-plan.mjs');

  const mk = (path, ext, size, rejected = null) => ({ path, ext, declaredSize: size, rejected });
  /** 中身を読もうとしたら落とす見張り。 */
  let reads = 0;
  const archive = {
    listing: {
      entries: [
        mk('案件/', '', 0, 'directory'),
        mk('案件/山田 太郎/健診.xlsx', '.xlsx', 1000),
        mk('案件/山田 太郎/遺伝子.pdf', '.pdf', 21_000_000),
        mk('案件/山田 太郎/.DS_Store', '', 6148),          // ノイズ
        mk('案件/佐藤 花子/健診.xlsx', '.xlsx', 1200),
        mk('案件/名簿.xlsx', '.xlsx', 500),                  // 人物フォルダの外
        mk('案件/暗号化.zip', '.zip', 10, 'ext_not_allowed'),
      ],
    },
    read: () => { reads++; throw new Error('read してはいけない'); },
    readByIndex: () => { reads++; throw new Error('readByIndex してはいけない'); },
  };

  const plan = PLAN.planArchive(archive);
  eq('中身を 1 度も読まない', reads, 0);
  eq('人物は 2 名', plan.subjectCount, 2);
  eq('人物ファイルは 3 件 (ノイズを除く)', plan.workItems.length, 3);
  eq('バッチ共通資料は 1 件', plan.batchReferenceItems.length, 1);
  eq('採用しなかったのは 1 件 (ディレクトリは数えない)', plan.rejected.length, 1);
  eq('rejected は序数と理由だけ', Object.keys(plan.rejected[0]).sort(), ['entryIndex', 'reason']);

  // **序数は Central Directory の並びそのもの** = 同じ ZIP なら同じ番号。
  eq('序数が元の並びと一致', plan.workItems.map((w) => w.entryIndex), [1, 2, 4]);
  eq('人物番号は出現順', plan.workItems.map((w) => w.subjectNo), [1, 1, 2]);
  eq('人物内の連番', plan.workItems.map((w) => w.seq), [1, 2, 1]);

  /*
   * **応答に path も人物フォルダ名も出さない** (§8.1)。
   * `subjectNoByFolder` はメモリの中だけで、API はこれを返さない (別途 I で見る)。
   */
  const wireShape = [...plan.workItems, ...plan.batchReferenceItems];
  eq('work item に path が無い', wireShape.every((w) => !('path' in w)), true);
  eq('work item に personFolder が無い', wireShape.every((w) => !('personFolder' in w)), true);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== I. classify-plan / entry / finalize が path を漏らさない ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const svc = read(SERVICE);
  const cut = (from, to) => svc.slice(svc.indexOf(from), to ? svc.indexOf(to) : undefined);
  const plan = stripComments(cut('export async function classifyPlan', 'export async function classifyEntry'));
  const entry = stripComments(cut('export async function classifyEntry', 'export async function classifyFinalize'));
  const fin = stripComments(cut('export async function classifyFinalize', 'function publicFile'));

  eq('plan が subjectNoByFolder を返さない', /subjectNoByFolder/.test(plan), false);
  eq('plan が personFolder を返さない', /personFolder/.test(plan), false);
  eq('plan が entry.path を返さない', /\.path\b/.test(plan), false);
  /*
   * **返す形をまるごと固定する** (4 つの前方一致では足りない) —
   * 後ろに 1 行足すだけで path も人物フォルダ名も混ぜられてしまうため、
   * オブジェクト literal の閉じ括弧まで含めて一致を見る。
   */
  eq('plan が返すのは序数・人物番号・拡張子・サイズの 4 つだけ',
    /\{\s*entryIndex: w\.entryIndex,\s*subjectNo: w\.subjectNo,\s*ext: w\.ext,\s*declaredSize: w\.declaredSize,\s*\}\)\)/.test(plan), true);

  eq('entry が path を応答に入れない', /path:/.test(entry), false);
  eq('entry のエラーが index= を使う', /index=\$\{input\.entryIndex\}/.test(entry), true);

  /*
   * **finalize は残りの序数も出さない。** 件数だけ (どのファイルが残っているかは
   * ZIP の中の話で、画面に出す必要が無い)。続きは plan の `done` から求まる。
   */
  eq('finalize は 409 を返す', /status: 409, error: 'classification_incomplete'/.test(fin), true);
  eq('finalize は件数だけ返す', /remaining: remaining\.length/.test(fin), true);
  eq('finalize が序数の配列を返さない', /remaining: remaining,|remaining\.map/.test(fin), false);

  // 送信元がファイル名を推測できる `display_name` は**こちらで作った表示名**だけ。
  eq('display_name は displayNameFor か固定文字列から作る',
    /displayName|未採用_/.test(entry), true);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== J. クライアントの申告を信用しない ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const svc = read(SERVICE);
  const entry = stripComments(svc.slice(
    svc.indexOf('export async function classifyEntry'),
    svc.indexOf('export async function classifyFinalize'),
  ));
  /*
   * **人物番号も format もサーバが決め直す。** 申告どおりに書くと、
   * 改竄した番号で**別人の検査データがその人物の納品物に入る**。
   */
  eq('入力は batchId と entryIndex だけ',
    /input: \{ batchId: string; entryIndex: number; actor: Actor \}/.test(svc), true);
  /*
   * **`subjectNo` の出どころを 1 つに固定する。**
   * `input.subjectNo` を禁じるだけでは足りない — `(input as any).subjectNo` のような
   * 書き方をすり抜ける (実際に注入して通ってしまった)。
   * 出現箇所を全部数え、**`analyzed.` から来るか、こちらが組む応答のキー**
   * のどちらかであることを確かめる。
   */
  {
    const spots = [];
    for (let i = entry.indexOf('subjectNo'); i >= 0; i = entry.indexOf('subjectNo', i + 1)) {
      const before = entry.slice(Math.max(0, i - 12), i);
      const after = entry.slice(i + 'subjectNo'.length, i + 'subjectNo'.length + 1);
      const fromAnalyzed = /analyzed\.$/.test(before);
      const isKey = after === ':';            // 応答に載せるキー名
      const isCompare = /\bs\.subject_no === /.test(entry.slice(Math.max(0, i - 60), i));
      if (!fromAnalyzed && !isKey && !isCompare) spots.push(entry.slice(Math.max(0, i - 40), i + 20));
    }
    eq('subjectNo は analyzed (= plan の再計算) からしか来ない', spots, []);
  }
  /*
   * **format も同じ**。出どころは `classifyFile` の結果 (`analyzed.classification`)
   * か、書いた行をそのまま返すところだけ。
   */
  {
    const rest = entry
      .replace(/analyzed\.classification\.formatId/g, '')
      .replace(/formatId: row\.classified_format_id/g, '');
    eq('formatId は分類結果か書いた行からしか来ない', /formatId/.test(rest), false);
  }
  eq('人物番号は planArchive の結果から引く', /analyzed\.subjectNo/.test(entry), true);
  eq('毎回 plan を立て直す', /openAndPlan\(batch\)/.test(entry), true);

  // API 側でも整数であることを見る (負値・小数・文字列を通さない)。
  const route = stripComments(read('src/pages/api/admin/ad-hoc-diagnosis/classify-entry.ts'));
  eq('API が entryIndex を検査する',
    /Number\.isInteger\(entryIndex\)[\s\S]{0,40}entryIndex < 0/.test(route), true);
  eq('API が subjectNo を読まない', /subjectNo/.test(route), false);
  eq('API が formatId を読まない', /formatId/.test(route), false);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== K. readByIndex が範囲・種別を自分で検査し、path を出さない ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const src = stripComments(read(ARCHIVE));
  const fn = src.slice(src.indexOf('async readByIndex('), src.indexOf('async close()'));
  eq('readByIndex が在る', fn.length > 0, true);
  eq('範囲外を弾く', /!Number\.isInteger\(index\) \|\| index < 0 \|\| index >= raw\.length/.test(fn), true);
  eq('採用しなかったエントリを弾く', /insp\.rejected !== null/.test(fn), true);
  eq('ディレクトリを弾く', /e\.directory/.test(fn), true);
  // **例外メッセージはログへ流れる**ので path を出さない (§8.1)。
  eq('ラベルが index=N (path でない)', /readEntry\(e, `index=\$\{index\}`\)/.test(fn), true);
  eq('例外に filename を出さない', /\$\{e\.filename\}|\$\{insp\.path\}/.test(fn), false);
  eq('entryCount を公開している', /entryCount: number;/.test(read(ARCHIVE)), true);

  /*
   * **サイズ検査を read と共通にする** — 片方だけに置くと、分割経路だけが
   * 上限をすり抜ける (`readByIndex` は新しい入口なので忘れやすい)。
   */
  eq('read と readByIndex が同じ readEntry を通る',
    /async read\(path: string\)[\s\S]{0,200}readEntry\(e, path\)/.test(src) && /readEntry\(e, `index=/.test(src), true);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== L. 後工程が ZIP を開き直さない (分割した意味を消さない) ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const svc = read(SERVICE);
  const region = (from, to) => stripComments(svc.slice(svc.indexOf(from), svc.indexOf(to)));

  const proc = region('export async function processBatch', 'export async function healthAgeCheck');
  const ha = region('export async function healthAgeCheck', 'export interface AssemblyResult');
  const asm = region('export async function assembleBatch', 'export async function retryBatch');

  for (const [name, code] of [['processBatch', proc], ['healthAgeCheck', ha], ['assembleBatch', asm]]) {
    eq(`${name} が analyzeOpened を呼ばない`, /analyzeOpened\(/.test(code), false);
    eq(`${name} が openArchiveFromS3 を呼ばない`, /openArchiveFromS3\(/.test(code), false);
    eq(`${name} が normalized_payload から復元する`,
      /restoreHealthCheckupSheet\(|restoreQuestionnaire\(/.test(code), true);
  }

  /*
   * **materials が無いときに黙って空にしない。** 分類前の古い行は payload を持たない
   * ので、そのまま素通りさせると**納品物が 1 件減るだけ**で誰も気づけない。
   */
  eq('材料が無ければ理由を残す', (proc.match(/normalized_payload_missing/g) ?? []).length >= 2, true);

  // 一括分類 (`classifyBatch`) でも payload を保存する = 経路で挙動が変わらない。
  eq('fileRowOf が payload を作る', /normalized_payload: buildEntryPayload\(/.test(stripComments(svc)), true);

  // 1 ファイルを取り出す口も ZIP 全体を再解析しない。
  const fileRoute = stripComments(read('src/pages/api/admin/ad-hoc-diagnosis/file.ts'));
  eq('file API が analyzeOpened を呼ばない', /analyzeOpened/.test(fileRoute), false);
  eq('file API が archive_entry_index を使う', /readByIndex\(file\.archive_entry_index\)/.test(fileRoute), true);
  /*
   * **取り出した中身が行と一致することを確かめる。** 同じ key に別の ZIP が
   * 上げ直されると序数の指す先が変わり、**別人の PDF がその人物の納品物に入る**。
   */
  eq('file API が sha256 を突き合わせる', /sha256Hex\(bytes\) !== file\.sha256/.test(fileRoute), true);
  eq('不一致は 409', /archive_entry_hash_mismatch'?\s*\}, 409\)/.test(fileRoute), true);
  eq('序数が無い行は 409', /archive_entry_index_missing'?\s*\}, 409\)/.test(fileRoute), true);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== M. 済んだページで LLM を再実行しない (キャッシュは不変) ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const svc = stripComments(read(SERVICE));
  const proc = svc.slice(svc.indexOf('export async function processBatch'), svc.indexOf('export async function healthAgeCheck'));
  eq('findCachedPage を先に見る', proc.indexOf('findCachedPage') < proc.indexOf('scanGeneticPage'), true);
  eq('キャッシュがあれば scanGeneticPage を飛ばす', /if \(cached && !options\.retryFailedOnly\)[\s\S]{0,400}continue;/.test(proc), true);
  const store = stripComments(read(STORE));
  eq("キャッシュは status='done' だけ", /findCachedPage[\s\S]{0,400}\.eq\('status', 'done'\)/.test(store), true);

  /*
   * **行が無いページを推測して作らない** (retry の既存の約束)。
   * 分割分類はページ表に触らないので、ここが変わっていないことを固定する。
   */
  const retry = svc.slice(svc.indexOf('export async function retryBatch'));
  eq('retry は実在の行だけを対象にする', /pages\.filter\(\(p\) => p\.status !== 'done'\)\.map\(\(p\) => p\.page_no\)/.test(retry), true);
  eq('retry が page_count からページを作らない', /page_count/.test(retry), false);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== N. 採用しなかったエントリも残す (黙って落とさない・数えられる) ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const svc = read(SERVICE);
  const entry = stripComments(svc.slice(
    svc.indexOf('export async function classifyEntry'),
    svc.indexOf('export async function classifyFinalize'),
  ));
  eq("採用外は source_kind='ignored' で残す", /source_kind: 'ignored'/.test(entry), true);
  eq("採用外は parse_status='skipped'", /parse_status: 'skipped'/.test(entry), true);
  eq('採用外に payload を付けない', /rejectedReason[\s\S]{0,900}normalized_payload: null/.test(entry), true);
  eq('計画に無い序数は行を作らない', /entry_not_in_plan/.test(entry), true);

  /*
   * **採用外で早期 return しない。**
   * 「読んだが採用外」で return してしまうと行が残らず、finalize が
   * 「まだ読んでいない」と区別できなくなって**永久に完了しない**
   * (しかも画面には何も出ないので、止まっている理由が分からない)。
   * → `entry_not_in_plan` の return より後、行を書くまでの間に return が無いこと。
   */
  {
    const afterPlanGuard = entry.slice(entry.indexOf('entry_not_in_plan'));
    const upsertAt = afterPlanGuard.indexOf('upsertFileByEntryIndex');
    const between = afterPlanGuard.slice(afterPlanGuard.indexOf('\n'), upsertAt);
    eq('採用外でも必ず行を書く (途中に return が無い)',
      upsertAt > 0 && !/\breturn\b/.test(between), true);
  }

  /*
   * **finalize が「まだ読んでいない」と「読んだが採用外」を区別できること**が
   * 行を残す理由。区別できないと**永久に完了しない**。
   */
  const fin = stripComments(svc.slice(svc.indexOf('export async function classifyFinalize')));
  eq('finalize は序数の有無で数える', /f\.archive_entry_index[\s\S]{0,120}typeof i === 'number'/.test(fin), true);
  eq('finalize は plan の全件と突き合わせる', /plan\.workItems, \.\.\.plan\.batchReferenceItems/.test(fin), true);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== O. fingerprint は finalize で決まる (材料は保存済みの sha256) ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const svc = stripComments(read(SERVICE));
  const fin = svc.slice(svc.indexOf('export async function classifyFinalize'));
  eq('finalize が subjectFingerprint を呼ぶ', /subjectFingerprint\(own\.map\(\(f\) => f\.sha256\)\)/.test(fin), true);
  eq("材料は person_file だけ", /f\.source_kind === 'person_file'/.test(fin), true);
  eq('値が変わったときだけ書く', /if \(fp !== s\.subject_fp\)/.test(fin), true);

  // 実物で「並びが変わっても同じ値」を確認 (1 件ずつ読む順は保証されない)。
  const FP = await transpileToModule(read('src/lib/ad-hoc-diagnosis/fingerprint.ts'), 'verify-b21-fp.mjs');
  const a = 'a'.repeat(64); const b = 'b'.repeat(64); const c = 'c'.repeat(64);
  eq('読む順が変わっても同じ fingerprint',
    FP.subjectFingerprint([a, b, c]) === FP.subjectFingerprint([c, a, b]), true);
  eq('材料 0 件なら null (推測で作らない)', FP.subjectFingerprint([]), null);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== P. Executive 専用の hack になっていない ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const svc = stripComments(read(SERVICE));
  // **分割分類の 3 本だけ**を見る (この後ろの `batchStatus` は Executive を扱うので含めない)。
  const chunk = svc.slice(svc.indexOf('async function openAndPlan'), svc.indexOf('export async function batchStatus'));
  /*
   * **分割分類は汎用の臨時診断バッチでもそのまま使える。**
   * `require_executive_link` で経路を分けたら、汎用側だけ古い (落ちる) 経路に残る。
   */
  eq('分割分類が require_executive_link で分岐しない', /require_executive_link/.test(chunk), false);
  eq('分割分類が executive_subject_id を触らない', /executive_subject_id/.test(chunk), false);

  // required / optional の規則は変えない (§15.2 / 既存 5 種は不変)。
  const pipe = stripComments(read(PIPELINE));
  eq('AD_HOC_REQUIRED_FORMATS が 3 種のまま',
    /AD_HOC_REQUIRED_FORMATS: FormatId\[\] = \[\s*'HealthCheckupData',\s*'GeneticTestResultData',\s*'LifestyleQuestionnaireData',\s*\]/.test(pipe), true);
  eq('AD_HOC_OPTIONAL_FORMATS が HealthAgeData のまま',
    /AD_HOC_OPTIONAL_FORMATS: string\[\] = \['HealthAgeData'\]/.test(pipe), true);
  eq('既存 GATING_FORMAT_IDS を触っていない',
    /GATING_FORMAT_IDS/.test(pipe) === false, true);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== Q. Phase A の安全装置と納品判定が不変 ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  const svc = stripComments(read(SERVICE));
  const guard = stripComments(read('src/lib/ad-hoc-diagnosis/write-guard.ts'));

  eq('env 2 本のゲートが在る', /AD_HOC_ELITH_WRITE_ENABLED/.test(guard) && /AD_HOC_ELITH_WRITE_TARGET/.test(guard), true);
  eq('key の allowlist が在る', /export function validateDeliveryKey\(/.test(guard), true);
  eq('allowlist が納品 key の形を完全一致で見る (前方一致で済ませない)',
    /`\^\$\{escapeRe\(prefix\)\}user\/\(\$\{UUID\}\)\/date\/[\s\S]{0,160}\\\\\.json\$`/.test(guard), true);
  eq('IfNoneMatch:"*" が在る', /IfNoneMatch: '\*'/.test(guard), true);
  eq('skipped>0 で実書き込みを止める', /skipped/.test(guard), true);

  const asm = svc.slice(svc.indexOf('export async function assembleBatch'), svc.indexOf('export async function retryBatch'));
  eq('checkWriteGate が exporting より前', asm.indexOf('checkWriteGate') < asm.indexOf("status: 'exporting'"), true);
  eq('preflight が exporting より前', asm.indexOf('preflightNoExistingObjects') < asm.indexOf("status: 'exporting'"), true);
  eq('dryRun が既定の分岐として残る', /if \(input\.dryRun\)/.test(asm), true);

  // 納品できる output の判定 (Phase B1.2) を変えていない。
  eq('isDeliverableOutput が生成済み & error でない を見る',
    /output_status === 'generated' \|\| o\.output_status === 'exported'[\s\S]{0,80}validation_status !== 'error'/.test(svc), true);
  // 遺伝子は「読み切れていないページが 0」でだけ完成。
  eq('遺伝子の完成条件が不変',
    /const geneticComplete = !!gTestDate && doneParts\.length > 0 && incomplete === 0;/.test(svc), true);
  eq('page_count を納品条件に使っていない',
    /page_count[^\n]*geneticComplete|geneticComplete[^\n]*page_count/.test(svc), false);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== R. API が 3 本とも在り、認可を通す ===');
// ═══════════════════════════════════════════════════════════════════════════
{
  for (const name of ['classify-plan', 'classify-entry', 'classify-finalize']) {
    const p = `src/pages/api/admin/ad-hoc-diagnosis/${name}.ts`;
    eq(`${name} が在る`, existsSync(resolve(ROOT, p)), true);
    const src = stripComments(read(p));
    eq(`${name} が authorized を通す`, /if \(!authorized\(request\)\) return json\(\{ ok: false, error: 'unauthorized' \}, 401\)/.test(src), true);
    eq(`${name} が batchId を UUID 検査する`, /isUuid\(batchId\)/.test(src), true);
    eq(`${name} が actorFrom を使う`, /actorFrom\(request\)/.test(src), true);
    eq(`${name} が prerender=false`, /export const prerender = false;/.test(src), true);
  }
}

// ───────────────────────────────────────────────────────────────────────────
console.log('');
if (fails.length > 0) {
  console.error(`✗ ${fails.length} 件 失敗\n${fails.map((f) => `  - ${f}`).join('\n')}\n`);
  process.exit(1);
}
console.log('✓ すべて通過 — 1 リクエスト = ZIP 内 1 ファイル / 保存するのは序数だけ / PII は扉で止まる\n');
