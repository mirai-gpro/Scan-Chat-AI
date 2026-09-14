#!/usr/bin/env node
/**
 * トランスコスモス10名 緊急専用 v2.0 — **固定 manifest と Preflight** の回帰チェック。
 *
 * 【なぜ要るか】この専用パイプラインは「推測しない」ことだけが安全の根拠なので、
 * 壊れ方が**全部静かで、しかも取り返しがつかない**:
 *   - entry 番号の 1 始まり / 0 始まりを取り違えると**別人のファイル**を読む
 *   - 1 バイト違う ZIP を通すと、以後の全 JSON が別の原本から作られる
 *   - Golden 列が 1 列ずれたまま読むと、**値が別の設問へ入り**しかも全部「未知値」に見える
 *   - Executive が 0 件 / 2 件のまま進むと**人物取り違えのまま S3 へ出る**
 * どれも「例外が出る」形では現れない。**機械で止める以外に方法がない。**
 *
 * ここは**合成 fixture だけ**を使う (実在役員の氏名・回答・健康情報は 1 件も置かない)。
 * 実 ZIP の検証は `scripts/verify-transcos-real-zip.mjs` が担当する。
 * **合成 fixture が通っただけで REAL E2E PASS とは呼ばない** (§18 / §26-20)。
 *
 * 実行: node scripts/verify-transcos-manifest.mjs
 */
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
const eq = (name, actual, expected) =>
  ok(name, Object.is(actual, expected), `期待 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
const tmp = mkdtempSync(join(repoRoot, '.verify-tx-'));

// ── 実物を transpile。archive の純関数だけスタブへ差し替える ────────────────
const rel = (src) => src
  .replace(`from './manifest'`, `from './manifest.js'`)
  .replace(`from '../ad-hoc-diagnosis/archive'`, `from './archive.js'`);
const writeTs = (relPath, outName) => {
  const js = ts.transpileModule(rel(read(relPath)), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  writeFileSync(join(tmp, outName), js);
};
writeTs('src/lib/transcos-emergency/manifest.ts', 'manifest.js');
writeTs('src/lib/transcos-emergency/preflight.ts', 'preflight.js');
/*
 * archive.ts は zip.js と S3 を import するので、**純関数 3 つだけ**を写す。
 * 写した実装が本物と一致していることは、下の「archive の実装と一致」で見る
 * (ここが本物とずれたら検査そのものが嘘になる)。
 */
writeFileSync(join(tmp, 'archive.js'), `
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const startsWith = (b, m) => b.length >= m.length && m.every((x, i) => b[i] === x);
export function normalizeZipPath(raw) {
  return raw.replace(/\\\\/g, '/').split('/').filter((s) => s !== '' && s !== '.').join('/');
}
export function extensionOf(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}
export function magicMatchesExtension(ext, head) {
  if (ext === '.pdf') return startsWith(head, PDF_MAGIC);
  if (ext === '.xlsx' || ext === '.docx') return startsWith(head, ZIP_MAGIC);
  if (ext === '.csv') return true;
  return false;
}
`);

const M = await import(pathToFileURL(join(tmp, 'manifest.js')).href);
const P = await import(pathToFileURL(join(tmp, 'preflight.js')).href);

// ===========================================================================
// ① manifest そのものの整合 (指示書 §2 / §5 / §6 / §7 を機械で写し取る)
// ===========================================================================
{
  eq('ZIP bytes', M.TRANSCOS_ZIP.bytes, 159308299);
  eq('ZIP sha256', M.TRANSCOS_ZIP.sha256,
    '5ad086678047b17a4a0380e2c3c1c7e02332e45e8cfe32a9687fb6243093daf6');
  eq('ファイル数', M.TRANSCOS_MANIFEST.length, 38);
  eq('人物数', M.TRANSCOS_SUBJECTS.length, 10);

  // role 別の件数 (§8 の出力例と同じ数)
  const n = (r) => M.TRANSCOS_MANIFEST.filter((m) => m.role === r).length;
  eq('健診 PDF 10 件', n('HEALTH_PDF'), 10);
  eq('Genoplan 10 件', n('GENOPLAN_PDF'), 10);
  eq('問診 XLSX 8 件', n('QUESTIONNAIRE_XLSX'), 8);
  eq('問診 PDF 2 件', n('QUESTIONNAIRE_PDF_MANUAL'), 2);
  eq('健診補助 XLSX 5 件', n('HEALTH_SUPPORT_XLSX'), 5);

  // sha256 は 38 件とも相異なる (コピペで 2 行同じ、を弾く)
  eq('sha256 が重複しない', new Set(M.TRANSCOS_MANIFEST.map((m) => m.sha256)).size, 38);
  eq('entry 番号が重複しない', new Set(M.TRANSCOS_MANIFEST.map((m) => m.entry)).size, 38);
  ok('sha256 は 64 桁小文字 hex',
    M.TRANSCOS_MANIFEST.every((m) => /^[0-9a-f]{64}$/.test(m.sha256)));
  ok('entry は昇順',
    M.TRANSCOS_MANIFEST.every((m, i, a) => i === 0 || a[i - 1].entry < m.entry));

  /*
   * **entry 番号の飛びが人物フォルダ 10 件とちょうど一致すること。**
   * 1..48 のうち manifest に無い番号 = ディレクトリエントリ。
   * これが 10 でなければ「1 始まり・ディレクトリ込み」という前提が壊れている
   * (= `zeroBasedIndex()` が別人のファイルを指す)。
   */
  const maxEntry = Math.max(...M.TRANSCOS_MANIFEST.map((m) => m.entry));
  const have = new Set(M.TRANSCOS_MANIFEST.map((m) => m.entry));
  const gaps = [];
  for (let i = 1; i <= maxEntry; i++) if (!have.has(i)) gaps.push(i);
  eq('entry の最大値', maxEntry, 48);
  eq('entry の飛び = 人物フォルダ数', gaps.length, 10);
  eq('0 始まりへの変換', M.zeroBasedIndex(5), 4);

  // 人物 manifest が manifest の役割と噛み合っている
  for (const s of M.TRANSCOS_SUBJECTS) {
    eq(`人物 ${s.subjectNo} の健診 role`, M.manifestEntry(s.health)?.role, 'HEALTH_PDF');
    eq(`人物 ${s.subjectNo} の Genoplan role`, M.manifestEntry(s.genoplan)?.role, 'GENOPLAN_PDF');
    ok(`人物 ${s.subjectNo} の問診 role`,
      ['QUESTIONNAIRE_XLSX', 'QUESTIONNAIRE_PDF_MANUAL'].includes(M.manifestEntry(s.questionnaire)?.role));
    ok(`人物 ${s.subjectNo} の Genoplan 日付`, /^\d{4}-\d{2}-\d{2}$/.test(s.genoplanTestDate));
    // **`本結果レポート作成日 2026-08-25` を test_date に使わない** (§7)
    ok(`人物 ${s.subjectNo} は作成日を使わない`, s.genoplanTestDate !== '2026-08-25');
  }
  // 全 entry がちょうど 1 人に属するか、root 参照資料である
  const owned = M.TRANSCOS_MANIFEST.filter((m) => M.subjectOfEntry(m.entry) != null);
  eq('人物に属する entry 数', owned.length, 10 * 3 + 5);
  eq('root 参照資料', M.TRANSCOS_MANIFEST.length - owned.length, 3);

  // Executive 照合は exact のみ (§6)
  ok('NFKC と空白正規化は通す', M.executiveNameMatches('井上　博文', '井上 博文'));
  ok('前後の空白は通す', M.executiveNameMatches('  井上 博文 ', '井上 博文'));
  ok('姓だけは一致しない', !M.executiveNameMatches('井上', '井上 博文'));
  ok('部分一致は一致しない', !M.executiveNameMatches('井上 博文子', '井上 博文'));
  ok('別人は一致しない', !M.executiveNameMatches('井上 博史', '井上 博文'));
}

// ===========================================================================
// ② 合成 ZIP を組み立てて Preflight を動かす
// ===========================================================================
const sha = (b) => createHash('sha256').update(b).digest('hex');
const PDF_HEAD = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4
const ZIP_HEAD = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

/**
 * manifest どおりの「正しい ZIP」を合成する。
 * **中身は manifest の sha256 に一致させられない**ので、ここでは
 * 「観測器が返す sha」を manifest の値に差し替えたスタブ probes を使う
 * (= Preflight の**判定**を試すのであって、暗号を破るのではない)。
 */
function buildWorld(mutate = () => {}) {
  const maxEntry = Math.max(...M.TRANSCOS_MANIFEST.map((m) => m.entry));
  const rawEntries = [];
  for (let i = 1; i <= maxEntry; i++) {
    const m = M.manifestEntry(i);
    if (m) {
      rawEntries.push({ path: m.path, directory: false, declaredSize: m.bytes, encrypted: false });
    } else {
      // ディレクトリ行。パスは次に来るファイルのフォルダ名から作る。
      const next = M.TRANSCOS_MANIFEST.find((x) => x.entry > i && x.path.includes('/'));
      rawEntries.push({
        path: `${next.path.slice(0, next.path.indexOf('/'))}/`,
        directory: true, declaredSize: 0, encrypted: false,
      });
    }
  }
  const bytesOf = new Map();
  for (const m of M.TRANSCOS_MANIFEST) {
    const head = m.path.endsWith('.pdf') ? PDF_HEAD : ZIP_HEAD;
    const buf = new Uint8Array(Math.max(m.bytes, 8));
    buf.set(head, 0);
    bytesOf.set(m.entry, buf.subarray(0, m.bytes));
  }
  const world = {
    source: {
      zipBytes: M.TRANSCOS_ZIP.bytes,
      zipSha256: M.TRANSCOS_ZIP.sha256,
      rawEntries,
    },
    shaOf: new Map(M.TRANSCOS_MANIFEST.map((m) => [m.entry, m.sha256])),
    pagesOf: new Map(M.TRANSCOS_MANIFEST.filter((m) => m.pages != null).map((m) => [m.entry, m.pages])),
    headerOk: new Map(M.TRANSCOS_MANIFEST.filter((m) => m.cols != null).map((m) => [m.entry, true])),
    bytesOf,
  };
  mutate(world);
  return world;
}

async function runWorld(world, executives) {
  // 読み出しは 0 始まり。**どの entry を読んだかは world から逆引きする。**
  const entryOfIndex0 = (i0) => i0 + 1;
  const read = async (i0) => {
    const b = world.bytesOf.get(entryOfIndex0(i0));
    if (!b) throw new Error('採用していないエントリ');
    return b;
  };
  let current = null;
  const probes = {
    sha256: (b) => world.shaOf.get(current) ?? sha(b),
    pdfPageCount: () => world.pagesOf.get(current) ?? null,
    xlsxHeader: () => {
      if (!world.headerOk.get(current)) return null;
      const cols = M.manifestEntry(current)?.cols ?? 0;
      return Array.from({ length: cols }, (_, i) => `c${i}`);
    },
  };
  // probeEntry は entry を知っているので、read をフックして current を覚える。
  const structure = P.preflightStructure(world.source);
  const probed = [];
  for (const m of structure.plan) {
    current = m.entry;
    probed.push(await P.probeEntry(m.entry, read, probes));
  }
  const golden = {
    questionnaireHeaderOk: (h) => (h == null
      ? { ok: false, detail: '先頭行を読めない' }
      : { ok: true, detail: '' }),
  };
  // 補助 XLSX の見出しは「5 件が互いに一致」で見るので、同じ配列を返させる。
  return P.preflightFinish(structure, probed, executives ?? allExecOk(), golden);
}
const allExecOk = () => M.TRANSCOS_SUBJECTS.map((s) => ({ subjectNo: s.subjectNo, candidates: 1 }));
const failedIds = (r) => r.checks.filter((c) => !c.ok).map((c) => c.id);

// --- 正常系 --------------------------------------------------------------
{
  const r = await runWorld(buildWorld());
  ok('正しい ZIP は PASS', r.ok, `落ちた検査 ${JSON.stringify(failedIds(r))}`);
  eq('ファイル 38/38', r.summary.files, '38/38');
  eq('人物 10/10', r.summary.subjects, '10/10');
  eq('健診 10/10', r.summary.health, '10/10');
  eq('Genoplan 10/10', r.summary.genoplan, '10/10');
  eq('問診 XLSX 8/8', r.summary.questionnaireXlsx, '8/8');
  eq('問診 PDF 2/2', r.summary.questionnairePdf, '2/2');
  eq('健診補助 5/5', r.summary.healthSupport, '5/5');
  eq('Executive 10/10', r.summary.executives, '10/10');
  ok('§8 の表示になる', P.formatPreflight(r).startsWith('実ZIP確認: PASS'));
}

// --- §18-A の必須ケース ---------------------------------------------------
const cases = [
  ['ZIP が 1 バイト違う', (w) => { w.source.zipBytes -= 1; }, 1],
  ['ZIP の SHA が違う', (w) => { w.source.zipSha256 = 'f'.repeat(64); }, 2],
  ['ZIP の SHA が未提出', (w) => { w.source.zipSha256 = null; }, 2],
  ['ファイルが 1 件足りない', (w) => {
    const i = w.source.rawEntries.findIndex((e) => !e.directory);
    w.source.rawEntries.splice(i, 1);
  }, 3],
  ['余分なファイルがある', (w) => {
    w.source.rawEntries.push({ path: 'おまけ.pdf', directory: false, declaredSize: 10, encrypted: false });
  }, 15],
  ['エントリの bytes が 1 違う', (w) => { w.source.rawEntries[6].declaredSize += 1; }, 4],
  ['エントリの並びがずれた', (w) => {
    const a = w.source.rawEntries;
    [a[4], a[5]] = [a[5], a[4]];
  }, 4],
  ['中身の SHA が違う', (w) => { w.shaOf.set(7, '0'.repeat(64)); }, 5],
  ['ページ数が違う', (w) => { w.pagesOf.set(5, 207); }, 11],
  ['ページ数を数えられない', (w) => { w.pagesOf.delete(5); }, 11],
  ['問診 XLSX の見出しが読めない', (w) => { w.headerOk.set(6, false); }, 12],
  ['暗号化されている', (w) => { w.source.rawEntries[6].encrypted = true; }, 10],
];
for (const [label, mutate, wantId] of cases) {
  const r = await runWorld(buildWorld(mutate));
  ok(`FAIL: ${label}`, !r.ok, '通ってしまった');
  ok(`FAIL 理由が検査 ${wantId}: ${label}`, failedIds(r).includes(wantId),
    `落ちた検査 ${JSON.stringify(failedIds(r))}`);
}

// 39 列: 1 列でも違えば落ちる (Golden 見出しは受領していないので相互一致で見る)
{
  const r = await runWorld(buildWorld(), allExecOk());
  ok('39 列は正常系で PASS', r.checks.find((c) => c.id === 13).ok);
}
{
  // 補助 XLSX の 1 件だけ列数を変える
  const structure = P.preflightStructure(buildWorld().source);
  const support = M.TRANSCOS_MANIFEST.filter((m) => m.role === 'HEALTH_SUPPORT_XLSX');
  const probed = M.TRANSCOS_MANIFEST.map((m) => ({
    entry: m.entry, bytes: m.bytes, sha256: m.sha256, magicOk: true,
    pages: m.pages ?? null,
    header: m.cols == null ? null
      : Array.from({ length: m.entry === support[0].entry ? 38 : (m.cols ?? 0) }, (_, i) => `c${i}`),
    unreadable: null,
  }));
  const r = P.preflightFinish(structure, probed, allExecOk(), {
    questionnaireHeaderOk: () => ({ ok: true, detail: '' }),
  });
  ok('FAIL: 39 列が 1 列足りない', !r.checks.find((c) => c.id === 13).ok);
}
{
  // 列数は 39 のまま、見出しの文字だけ 1 つ違う
  const structure = P.preflightStructure(buildWorld().source);
  const support = M.TRANSCOS_MANIFEST.filter((m) => m.role === 'HEALTH_SUPPORT_XLSX');
  const probed = M.TRANSCOS_MANIFEST.map((m) => ({
    entry: m.entry, bytes: m.bytes, sha256: m.sha256, magicOk: true,
    pages: m.pages ?? null,
    header: m.cols == null ? null
      : Array.from({ length: m.cols }, (_, i) =>
        (m.entry === support[1].entry && i === 7) ? 'ちがう' : `c${i}`),
    unreadable: null,
  }));
  const r = P.preflightFinish(structure, probed, allExecOk(), {
    questionnaireHeaderOk: () => ({ ok: true, detail: '' }),
  });
  ok('FAIL: 39 列の見出しが 1 つ違う', !r.checks.find((c) => c.id === 13).ok);
}

// Executive 0 件 / 2 件はその人物だけ止まる (§6)
for (const [label, candidates] of [['0 件', 0], ['2 件', 2]]) {
  const execs = allExecOk().map((e) => (e.subjectNo === 3 ? { ...e, candidates } : e));
  const r = await runWorld(buildWorld(), execs);
  const c14 = r.checks.find((c) => c.id === 14);
  ok(`FAIL: Executive が ${label}`, !c14.ok);
  eq(`Executive ${label} で止まるのは 1 人だけ`, c14.items.length, 1);
  eq(`Executive ${label} の集計`, r.summary.executives, '9/10');
}

// 構造が壊れているうちは 1 バイトも読まない (別人のファイルを掴まない)
{
  const w = buildWorld((x) => { x.source.rawEntries[6].declaredSize += 1; });
  const structure = P.preflightStructure(w.source);
  eq('構造 NG なら読む計画を作らない', structure.plan.length, 0);
}

// PDF のマジックバイトが合わない
{
  const w = buildWorld();
  const b = new Uint8Array(w.bytesOf.get(7));
  b.set([0x50, 0x4b, 0x03, 0x04], 0); // PDF のはずが ZIP
  w.bytesOf.set(7, b);
  // sha は manifest 通りに見せて、マジックだけ壊れている状況を作る
  const r = await runWorld(w);
  ok('FAIL: PDF のマジックが違う', !r.checks.find((c) => c.id === 9).ok);
}

// Office 一時ファイル (entry 2) はマジック検査の対象外
{
  const w = buildWorld();
  const b = new Uint8Array(w.bytesOf.get(2));
  b.set([0x01, 0x02, 0x03, 0x04], 0); // ZIP でもない生のロックファイル
  w.bytesOf.set(2, b);
  const r = await runWorld(w);
  ok('Office 一時ファイルはマジック対象外', r.checks.find((c) => c.id === 9).ok);
}

// ===========================================================================
// ③ 写したスタブが本物と食い違っていないこと
// ===========================================================================
{
  const arc = read('src/lib/ad-hoc-diagnosis/archive.ts');
  ok('PDF マジックは本物と同じ', /const PDF_MAGIC = \[0x25, 0x50, 0x44, 0x46, 0x2d\]/.test(arc));
  ok('ZIP マジックは本物と同じ', /const ZIP_MAGIC = \[0x50, 0x4b, 0x03, 0x04\]/.test(arc));
  const pf = read('src/lib/transcos-emergency/preflight.ts');
  ok('preflight は archive の純関数を借りる (自前で書かない)',
    /from '\.\.\/ad-hoc-diagnosis\/archive'/.test(pf));
  ok('preflight に PDF 本文抽出が無い', !/extractPdfText|getTextContent/.test(pf));
  const probes = read('src/lib/transcos-emergency/probes.ts');
  // **コメントを外した実コード**で見る (説明文に語が出るため)
  const probesCode = probes.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('ページ数は正規の PDF parser', /pdfjs-dist\/legacy\/build\/pdf\.mjs/.test(probesCode));
  ok('countPdfPages を根拠にしない', !/countPdfPages/.test(probesCode));
  ok('Golden 62 列は既存 contract を借りる', /checkExternalFormSchema/.test(probes));
}

rmSync(tmp, { recursive: true, force: true });
console.log('');
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 件 失敗 (${pass} 件 通過)\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
  process.exit(1);
}
console.log(`✓ ${pass} 件 通過 — 固定 manifest と Preflight の判定は 1 項目単位で止まる\n`);
