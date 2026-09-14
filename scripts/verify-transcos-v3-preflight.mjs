#!/usr/bin/env node
/**
 * トランスコスモス10名 v3.0 — **固定 manifest と REAL ZIP Preflight** の回帰チェック。
 *
 * 【なぜ要るか】この専用パイプラインは「推測しない」ことだけが安全の根拠なので、
 * 壊れ方が**全部静かで取り返しがつかない**:
 *   - 1 バイト違う ZIP を通すと、以後の全 JSON が別の原本から作られる
 *   - root 名がずれたまま読むと**別の受領物**を今回の納品として出す
 *   - Golden 列が 1 列ずれたまま読むと**値が別の設問へ入り**全部「未知値」に見える
 *   - Executive が 0 件 / 2 件のまま進むと**人物取り違えのまま S3 へ出る**
 *   - **raw digest を trim してしまうと、実 XLSX では二度と一致しない**
 * どれも例外にならない。**機械で止める以外に方法がない。**
 *
 * ここは**合成データだけ**を使う (実在役員の氏名・回答・健康情報は 1 件も置かない)。
 * 実 ZIP の検証は `verify-transcos-v3-real-zip.mjs`。
 * **合成 fixture が通っただけで REAL ZIP E2E PASS とは呼ばない** (§21 / Appendix F-17)。
 *
 * 実行: node scripts/verify-transcos-v3-preflight.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';

let pass = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `期待 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const tmp = mkdtempSync(join(repoRoot, '.verify-v3-'));

const rel = (src) => src
  .replace(`from './manifest'`, `from './manifest.js'`)
  .replace(`from './preflight'`, `from './preflight.js'`);
const writeTs = (relPath, outName) => {
  writeFileSync(join(tmp, outName), ts.transpileModule(rel(read(relPath)), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
};
writeTs('src/lib/transcos-v3/manifest.ts', 'manifest.js');
writeTs('src/lib/transcos-v3/preflight.ts', 'preflight.js');
const M = await import(pathToFileURL(join(tmp, 'manifest.js')).href);
const P = await import(pathToFileURL(join(tmp, 'preflight.js')).href);

const SEP = M.DIGEST_SEPARATOR;
const dg = (arr) => createHash('sha256').update(arr.join(SEP), 'utf8').digest('hex');

// ===========================================================================
// ① manifest の整合 (§3 / §4 / §8.2 / §9 / §10.4 / §11.4 / §13.2)
// ===========================================================================
{
  eq('ZIP bytes', M.TRANSCOS_ZIP.bytes, 159308299);
  eq('ZIP sha256', M.TRANSCOS_ZIP.sha256,
    '5ad086678047b17a4a0380e2c3c1c7e02332e45e8cfe32a9687fb6243093daf6');
  eq('raw entries', M.TRANSCOS_ZIP.rawEntries, 49);
  eq('directory entries', M.TRANSCOS_ZIP.directoryEntries, 11);
  eq('file entries', M.TRANSCOS_ZIP.fileEntries, 38);
  // 49 = 38 file + 11 directory、11 = 人物 10 + root 1。**内訳が噛み合うこと。**
  eq('49 = 38 + 11', M.TRANSCOS_ZIP.fileEntries + M.TRANSCOS_ZIP.directoryEntries, M.TRANSCOS_ZIP.rawEntries);
  eq('11 = 人物 10 + root 1', M.TRANSCOS_ZIP.personFolders + 1, M.TRANSCOS_ZIP.directoryEntries);

  eq('manifest 38 件', M.TRANSCOS_FILES.length, 38);
  eq('人物 10 名', M.TRANSCOS_SUBJECTS.length, 10);
  eq('Golden 10 名', M.HEALTH_GOLDEN.length, 10);

  const n = (r) => M.TRANSCOS_FILES.filter((f) => f.role === r).length;
  eq('健診 PDF 10', n('HEALTH_PDF'), 10);
  eq('Genoplan 10', n('GENOPLAN_PDF'), 10);
  eq('問診 XLSX 8', n('QUESTIONNAIRE_XLSX'), 8);
  eq('問診 PDF 2', n('QUESTIONNAIRE_PDF_MANUAL'), 2);
  eq('健診補助 5', n('HEALTH_SUPPORT_XLSX'), 5);

  eq('sha256 が 38 件とも相異なる', new Set(M.TRANSCOS_FILES.map((f) => f.sha256)).size, 38);
  eq('relPath が 38 件とも相異なる', new Set(M.TRANSCOS_FILES.map((f) => f.relPath)).size, 38);
  ok('sha256 は 64 桁小文字 hex', M.TRANSCOS_FILES.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
  // **identity に index を持たない** (v2 の設計ミスを構造で封じる)
  ok('manifest 行に entryIndex が無い',
    M.TRANSCOS_FILES.every((f) => !('entry' in f) && !('entryIndex' in f)));
  ok('manifest のソースに entryIndex が出てこない',
    !/entryIndex|zeroBasedIndex/.test(strip(read('src/lib/transcos-v3/manifest.ts'))));

  // 人物 × role
  for (const s of M.TRANSCOS_SUBJECTS) {
    ok(`${s.displayName} 健診 1 件`, M.fileOf(s.displayName, 'HEALTH_PDF') != null);
    ok(`${s.displayName} Genoplan 1 件`, M.fileOf(s.displayName, 'GENOPLAN_PDF') != null);
    const q = s.questionnaire === 'xlsx' ? 'QUESTIONNAIRE_XLSX' : 'QUESTIONNAIRE_PDF_MANUAL';
    ok(`${s.displayName} 問診 1 件 (${s.questionnaire})`, M.fileOf(s.displayName, q) != null);
    eq(`${s.displayName} 補助`, M.fileOf(s.displayName, 'HEALTH_SUPPORT_XLSX') != null, s.hasHealthSupport);
    ok(`${s.displayName} Golden がある`, M.goldenOf(s.displayName) != null);
    ok(`${s.displayName} 遺伝子日付`, /^\d{4}-\d{2}-\d{2}$/.test(s.geneticDate));
    // **レポート作成日 2026-08-25 を test_date に使わない** (§13.2)
    ok(`${s.displayName} は作成日を使わない`, s.geneticDate !== '2026-08-25');
    // 問診 PDF の 2 名だけ日付が null (§12.4)
    eq(`${s.displayName} 問診日`, s.questionnaireDate == null, s.questionnaire === 'pdf_manual');
    // 全ファイルが人物フォルダ配下
    ok(`${s.displayName} のファイルは folder 配下`,
      M.TRANSCOS_FILES.filter((f) => f.subject === s.displayName)
        .every((f) => f.relPath.startsWith(`${s.folder}/`)));
  }
  eq('参照資料は 3 件', M.TRANSCOS_FILES.filter((f) => f.subject === null).length, 3);

  /*
   * **§4 の Health date 列と §10.4 の Golden date が一致すること。**
   * 仕様書では 2 か所に出てくるので、ここで写して突き合わせる
   * (コード側は Golden 1 か所にしか置いていない)。
   */
  const SPEC_S4_HEALTH_DATES = {
    '井上 博文': '2025-10-22', '神谷 健志': '2025-11-13', '名倉 英紀': '2025-11-14',
    '坂田 幸彦': '2025-09-25', '岩波 潤': '2025-09-18', '中村 彩香': '2025-10-30',
    '古原 広行': '2025-07-11', '辻 陽子': '2025-08-04', '堀石 尚男': '2025-09-04',
    '吉光 陽平': '2026-01-14',
  };
  for (const [name, date] of Object.entries(SPEC_S4_HEALTH_DATES)) {
    eq(`§4 と §10.4 の健診日が一致 (${name})`, M.goldenOf(name)?.date, date);
  }
  const SPEC_S11_Q_DATES = {
    '井上 博文': '2026-07-10', '名倉 英紀': '2026-08-06', '坂田 幸彦': '2026-07-12',
    '岩波 潤': '2026-08-06', '中村 彩香': '2026-07-13', '辻 陽子': '2026-07-03',
    '堀石 尚男': '2026-07-05', '吉光 陽平': '2026-08-04',
  };
  for (const [name, date] of Object.entries(SPEC_S11_Q_DATES)) {
    eq(`§11.4 の問診日 (${name})`, M.subjectByName(name)?.questionnaireDate, date);
  }

  // digest の自己証明 (転記が 1 文字でも違えば落ちる)
  eq('39 列 Golden の件数', M.HEALTH_SUPPORT_HEADERS.length, 39);
  eq('39 列 digest', dg(M.HEALTH_SUPPORT_HEADERS), M.HEADER_DIGEST.healthSupport39);
  eq('digest の区切りが U+001F', SEP.charCodeAt(0), 0x1f);

  // cross-check 写像 (§10.5)
  eq('cross-check 15 行', M.HEALTH_CROSS_CHECK.length, 15);
  ok('cross-check の header は全部 39 列に在る',
    M.HEALTH_CROSS_CHECK.every((c) => M.HEALTH_SUPPORT_HEADERS.includes(c.header)));
  ok('健診日は cross-check 表に入れない',
    !M.HEALTH_CROSS_CHECK.some((c) => c.header === M.HEALTH_SUPPORT_DATE_HEADER));

  // Executive 照合は exact のみ (§9.1)
  ok('NFKC と空白は通す', M.executiveNameMatches('井上　博文', '井上 博文'));
  ok('前後の空白は通す', M.executiveNameMatches('  井上 博文 ', '井上 博文'));
  ok('姓だけは一致しない', !M.executiveNameMatches('井上', '井上 博文'));
  ok('部分一致しない', !M.executiveNameMatches('井上 博文子', '井上 博文'));
  ok('別人は一致しない', !M.executiveNameMatches('井上 博史', '井上 博文'));
}

// ===========================================================================
// ② Preflight — 合成 ZIP 構造で判定を動かす
// ===========================================================================
const PDF_HEAD = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const ZIP_HEAD = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

/** manifest どおりの世界を組む。**index は意図的にシャッフルできる** (identity でない証明)。 */
function buildWorld(mutate = () => {}, shuffle = false) {
  const entries = [];
  // root directory entry + 人物フォルダ 10 = 11
  entries.push({ path: `${M.EXPECTED_ROOT}/`, directory: true, declaredSize: 0, encrypted: false, unsafe: null });
  for (const s of M.TRANSCOS_SUBJECTS) {
    entries.push({ path: `${M.EXPECTED_ROOT}/${s.folder}/`, directory: true, declaredSize: 0, encrypted: false, unsafe: null });
  }
  const files = M.TRANSCOS_FILES.map((f) => ({
    path: `${M.EXPECTED_ROOT}/${f.relPath}`,
    directory: false, declaredSize: f.bytes, encrypted: false, unsafe: null,
  }));
  if (shuffle) files.reverse();
  entries.push(...files);

  const bytesOf = new Map();
  for (const f of M.TRANSCOS_FILES) {
    const head = f.role === 'IGNORE_OFFICE_TEMP'
      ? new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0])
      : f.relPath.endsWith('.pdf') ? PDF_HEAD : ZIP_HEAD;
    const buf = new Uint8Array(Math.max(f.bytes, 8));
    buf.set(head, 0);
    bytesOf.set(f.relPath, buf.subarray(0, f.bytes));
  }
  const w = {
    source: { zipBytes: M.TRANSCOS_ZIP.bytes, zipSha256: M.TRANSCOS_ZIP.sha256, opened: true, rawEntries: entries },
    shaOf: new Map(M.TRANSCOS_FILES.map((f) => [f.relPath, f.sha256])),
    pagesOf: new Map(M.TRANSCOS_FILES.filter((f) => f.pages != null).map((f) => [f.relPath, f.pages])),
    xlsxOf: new Map(M.TRANSCOS_FILES.filter((f) => f.cols != null && f.role !== 'IGNORE_OFFICE_TEMP').map((f) => [f.relPath, {
      rawHeaders: Array.from({ length: f.cols }, (_, i) => `c${i}`),
      rawDigest: f.cols === 62 ? M.HEADER_DIGEST.questionnaire62 : M.HEADER_DIGEST.healthSupport39,
      meaningfulRows: 1,
      completedAt: f.role === 'QUESTIONNAIRE_XLSX' ? 'resolved' : null,
    }])),
    bytesOf,
  };
  mutate(w);
  return w;
}

const allExecOk = () => M.TRANSCOS_SUBJECTS.map((s) => ({ subject: s.displayName, candidates: 1 }));

async function runWorld(w, executives) {
  const byIndex = w.source.rawEntries;
  const read = async (i) => {
    const e = byIndex[i];
    if (!e || e.directory) throw new Error('file でないエントリ');
    const r = P.stripRoot(e.path);
    const b = r == null ? null : w.bytesOf.get(r);
    if (!b) throw new Error('読めない');
    return b;
  };
  let current = null;
  const probes = {
    sha256: () => w.shaOf.get(current) ?? 'x'.repeat(64),
    magicOk: (relPath, head) => (relPath.endsWith('.pdf') ? head[0] === 0x25 : head[0] === 0x50),
    pdfPageCount: () => w.pagesOf.get(current) ?? null,
    xlsx: () => w.xlsxOf.get(current) ?? null,
  };
  const structure = P.preflightStructure(w.source);
  const probed = [];
  for (const item of structure.plan) {
    current = item.file.relPath;
    probed.push(await P.probeFile(item, read, probes));
  }
  return P.preflightFinish(structure, probed, executives ?? allExecOk());
}
const failedIds = (r) => r.checks.filter((c) => !c.ok).map((c) => c.id);

// --- 正常系 ---------------------------------------------------------------
{
  const r = await runWorld(buildWorld());
  ok('正しい ZIP は PASS', r.ok, `落ちた検査 ${JSON.stringify(failedIds(r))}`);
  eq('ファイル 38/38', r.summary.files, '38/38');
  eq('健診 10/10', r.summary.health, '10/10');
  eq('Genoplan 10/10', r.summary.genoplan, '10/10');
  eq('問診 XLSX 8/8', r.summary.questionnaireXlsx, '8/8');
  eq('問診 PDF 2/2', r.summary.questionnairePdf, '2/2');
  eq('健診補助 5/5', r.summary.healthSupport, '5/5');
  eq('Executive 10/10', r.summary.executives, '10/10');
  eq('人物 10/10', r.summary.subjects, '10/10');
  ok('§8 の表示になる', P.formatPreflight(r).startsWith('実ZIP確認: PASS'));
}
/*
 * **要約は観測でなければならない** (§21 Stage A の `subjects 10/10` は観測の報告)。
 * manifest の定数を出すと **どんな ZIP でも 10/10** になり、要約だけ見ている人には
 * 常に緑に見える。人物フォルダを 1 つに潰した世界で 10/10 のままなら退行。
 */
{
  const w = buildWorld((x) => {
    for (const e of x.source.rawEntries) {
      if (e.directory) continue;
      const rest = e.path.slice(`${M.EXPECTED_ROOT}/`.length);
      if (rest.includes('/')) e.path = `${M.EXPECTED_ROOT}/ひとつだけ/${rest.slice(rest.indexOf('/') + 1)}`;
    }
  });
  const r = await runWorld(w);
  ok('人物フォルダを潰したら要約も 10/10 でなくなる', r.summary.subjects !== '10/10',
    `実際 ${r.summary.subjects}`);
  ok('そのとき 9-folders が落ちる', failedIds(r).includes('9-folders'), JSON.stringify(failedIds(r)));
}
// **index をひっくり返しても PASS する = index は identity でない** (§3.1)
{
  const r = await runWorld(buildWorld(() => {}, true));
  ok('Central Directory の並びが変わっても PASS', r.ok, JSON.stringify(failedIds(r)));
}

// --- §22 の必須 FAIL ケース ------------------------------------------------
const cases = [
  ['ZIP が 1 バイト違う', (w) => { w.source.zipBytes -= 1; }, '8.1-bytes'],
  ['ZIP の SHA が違う', (w) => { w.source.zipSha256 = 'f'.repeat(64); }, '8.1-sha'],
  ['ZIP の SHA が未算出', (w) => { w.source.zipSha256 = null; }, '8.1-sha'],
  ['ZIP が開けない', (w) => { w.source.opened = false; }, '8.1-open'],
  ['file が 1 件足りない', (w) => {
    const i = w.source.rawEntries.findIndex((e) => !e.directory);
    w.source.rawEntries.splice(i, 1);
  }, '8.1-count'],
  ['余分な file がある', (w) => {
    w.source.rawEntries.push({ path: `${M.EXPECTED_ROOT}/おまけ.pdf`, directory: false, declaredSize: 10, encrypted: false, unsafe: null });
  }, '8.2-extra'],
  ['bytes が 1 違う', (w) => {
    const e = w.source.rawEntries.find((x) => !x.directory);
    e.declaredSize += 1;
  }, '8.2-path'],
  ['中身の SHA が違う', (w) => { w.shaOf.set(M.TRANSCOS_FILES[5].relPath, '0'.repeat(64)); }, '8.2-sha'],
  ['common root の名前が違う', (w) => {
    for (const e of w.source.rawEntries) e.path = e.path.replace(M.EXPECTED_ROOT, '別の受領物');
  }, '8.2-root'],
  ['common root が二重', (w) => {
    for (const e of w.source.rawEntries) e.path = `${M.EXPECTED_ROOT}/${e.path}`;
  }, '8.2-root'],
  ['ページ数が違う', (w) => { w.pagesOf.set(M.TRANSCOS_FILES[3].relPath, 207); }, '8.3-pages'],
  ['ページ数を数えられない', (w) => { w.pagesOf.delete(M.TRANSCOS_FILES[3].relPath); }, '8.3-pages'],
  ['62 列の digest が違う', (w) => {
    const p = M.filesOfRole('QUESTIONNAIRE_XLSX')[0].relPath;
    w.xlsxOf.set(p, { ...w.xlsxOf.get(p), rawDigest: 'a'.repeat(64) });
  }, '8.4-q62'],
  ['62 列が 61 列', (w) => {
    const p = M.filesOfRole('QUESTIONNAIRE_XLSX')[1].relPath;
    w.xlsxOf.set(p, { ...w.xlsxOf.get(p), rawHeaders: Array.from({ length: 61 }, (_, i) => `c${i}`) });
  }, '8.4-q62'],
  ['回答行が 2 件', (w) => {
    const p = M.filesOfRole('QUESTIONNAIRE_XLSX')[2].relPath;
    w.xlsxOf.set(p, { ...w.xlsxOf.get(p), meaningfulRows: 2 });
  }, '8.4-q62'],
  ['回答行が 0 件', (w) => {
    const p = M.filesOfRole('QUESTIONNAIRE_XLSX')[3].relPath;
    w.xlsxOf.set(p, { ...w.xlsxOf.get(p), meaningfulRows: 0 });
  }, '8.4-q62'],
  ['完了時刻が解決できない', (w) => {
    const p = M.filesOfRole('QUESTIONNAIRE_XLSX')[4].relPath;
    w.xlsxOf.set(p, { ...w.xlsxOf.get(p), completedAt: 'unresolved' });
  }, '8.4-q62'],
  ['39 列の digest が違う', (w) => {
    const p = M.filesOfRole('HEALTH_SUPPORT_XLSX')[0].relPath;
    w.xlsxOf.set(p, { ...w.xlsxOf.get(p), rawDigest: 'b'.repeat(64) });
  }, '8.4-s39'],
  ['暗号化されている', (w) => { w.source.rawEntries.find((e) => !e.directory).encrypted = true; }, '8.1-safe'],
  ['zip-slip がある', (w) => { w.source.rawEntries.find((e) => !e.directory).unsafe = 'zip_slip'; }, '8.1-safe'],
];
for (const [label, mutate, wantId] of cases) {
  const r = await runWorld(buildWorld(mutate));
  ok(`FAIL: ${label}`, !r.ok, '通ってしまった');
  ok(`FAIL 理由が ${wantId}: ${label}`, failedIds(r).includes(wantId),
    `落ちた検査 ${JSON.stringify(failedIds(r))}`);
}

// Executive 0 件 / 2 件 → **その人物だけ**止まる (§9.1)
for (const [label, candidates] of [['0 件', 0], ['2 件', 2]]) {
  const execs = allExecOk().map((e) => (e.subject === '名倉 英紀' ? { ...e, candidates } : e));
  const r = await runWorld(buildWorld(), execs);
  const c = r.checks.find((x) => x.id === '9.1-executive');
  ok(`FAIL: Executive が ${label}`, !c.ok);
  eq(`Executive ${label} で止まるのは 1 人だけ`, c.items.length, 1);
  eq(`Executive ${label} の集計`, r.summary.executives, '9/10');
}

// 構造が壊れているうちは 1 バイトも読まない (§8.5)
{
  const w = buildWorld((x) => { x.source.rawEntries.find((e) => !e.directory).declaredSize += 1; });
  eq('構造 NG なら読む計画を作らない', P.preflightStructure(w.source).plan.length, 0);
}
// SHA が違う file の観測は採らない (locator が別物を指していた場合)
{
  const w = buildWorld();
  const target = M.TRANSCOS_FILES.find((f) => f.pages != null);
  w.shaOf.set(target.relPath, '9'.repeat(64));
  const r = await runWorld(w);
  ok('SHA 不一致なら ページ数も未読扱い',
    r.checks.find((c) => c.id === '8.3-pages').items.some((i) => i.label === target.relPath));
}

// ===========================================================================
// ③ raw digest が実 XLSX の往復で保たれるか (**ここが仕様の肝**)
// ===========================================================================
writeTs('src/lib/transcos-v3/xlsx-raw-header.ts', 'xlsx-raw-header.js');
const RH = await import(pathToFileURL(join(tmp, 'xlsx-raw-header.js')).href);

/** 最小の XLSX を組む。`shared` で共有文字列経路も試す。 */
async function buildXlsx(headers, { shared = false } = {}) {
  const { ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } = await import('@zip.js/zip.js');
  const esc = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ref = (c, r) => `${String.fromCharCode(65 + c)}${r}`;
  const cells = headers.map((v, c) => (shared
    ? `<c r="${ref(c, 1)}" t="s"><v>${c}</v></c>`
    : `<c r="${ref(c, 1)}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`)).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${cells}</row>`
    + `<row r="2">${headers.map((_, c) => `<c r="${ref(c, 2)}" t="inlineStr"><is><t>v</t></is></c>`).join('')}</row>`
    + `</sheetData></worksheet>`;
  const parts = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': sheet,
    'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${headers.length}" uniqueCount="${headers.length}">${
      headers.map((v) => `<si><t xml:space="preserve">${esc(v)}</t></si>`).join('')}</sst>`,
  };
  const zw = new ZipWriter(new Uint8ArrayWriter());
  for (const [n, b] of Object.entries(parts)) await zw.add(n, new Uint8ArrayReader(new TextEncoder().encode(b)));
  return zw.close();
}

/** 見出し行に数値セルを置いたブック (値を解釈しないことの確認用)。 */
async function buildXlsxNumericHeader() {
  const { ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } = await import('@zip.js/zip.js');
  const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">`
    + `<c r="A1"><v>45000</v></c><c r="B1" t="inlineStr"><is><t>あ</t></is></c></row></sheetData></worksheet>`;
  const parts = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': sheet,
  };
  const zw = new ZipWriter(new Uint8ArrayWriter());
  for (const [n, b] of Object.entries(parts)) await zw.add(n, new Uint8ArrayReader(new TextEncoder().encode(b)));
  return zw.close();
}

{
  // 実 XLSX の列 47 と同じ「末尾に改行を持つ見出し」を含む最小ブック
  const headers = ['A', 'B改行あり\n', 'C 末尾空白 ', ' D先頭空白', 'E&<>"記号'];
  const bytes = await buildXlsx(headers);

  /*
   * ① **既存の `read-excel-file` はセル前後の空白を必ず落とす**。
   *    これが「raw 用の読み手を別に作った」理由そのものなので、
   *    ここで固定しておく (ライブラリが将来直っても気づける)。
   */
  const mod = await import('read-excel-file/node');
  const viaLib = ((await mod.default(Buffer.from(bytes)))[0]?.data?.[0] ?? [])
    .map((c) => (c == null ? '' : String(c)));
  eq('read-excel-file は末尾改行を落とす', viaLib[1], 'B改行あり');
  eq('read-excel-file は末尾空白を落とす', viaLib[2], 'C 末尾空白');
  eq('read-excel-file は先頭空白を落とす', viaLib[3], 'D先頭空白');

  // ② **専用の raw reader は落とさない** (§8.4 の digest が成立する条件)
  const raw = await RH.readRawHeaderRow(bytes);
  eq('raw reader は 5 列', raw?.length, 5);
  eq('raw reader は末尾改行を保つ', raw?.[1], 'B改行あり\n');
  eq('raw reader は末尾空白を保つ', raw?.[2], 'C 末尾空白 ');
  eq('raw reader は先頭空白を保つ', raw?.[3], ' D先頭空白');
  eq('raw reader は実体参照を戻す', raw?.[4], 'E&<>"記号');
  ok('digest は改行の有無で変わる', dg(raw) !== dg(raw.map((x) => x.trim())));
  ok('read-excel-file 経由の digest とは別値になる', dg(raw) !== dg(viaLib));

  // ③ 共有文字列 (`t="s"`) 経路でも同じ結果になる
  const rawShared = await RH.readRawHeaderRow(await buildXlsx(headers, { shared: true }));
  eq('共有文字列でも raw が保たれる', rawShared, raw);

  // ④ 列番号の解釈
  eq('A1 は 0 列目', RH.columnIndexOf('A1'), 0);
  eq('Z1 は 25 列目', RH.columnIndexOf('Z1'), 25);
  eq('AA1 は 26 列目', RH.columnIndexOf('AA1'), 26);
  eq('BJ1 は 61 列目 (62 列目の見出し)', RH.columnIndexOf('BJ1'), 61);

  // ⑤ 読めない入力は null (空配列と区別する)
  eq('XLSX でなければ null', await RH.readRawHeaderRow(new Uint8Array([1, 2, 3, 4])), null);

  /*
   * ⑥ **値を解釈しない。** 日付シリアルらしき数値セルが見出し行に在っても、
   *    raw reader は文字列のまま返す (ここで Date にすると 1900/1904 方式の
   *    決め打ちが入り、**4 年ずれた日付を静かに作る**)。
   */
  const numeric = await buildXlsxNumericHeader();
  const rawNum = await RH.readRawHeaderRow(numeric);
  eq('数値セルは文字列のまま', rawNum, ['45000', 'あ']);
}

// ===========================================================================
// ④ 設計の約束がソースに残っていること
// ===========================================================================
{
  const pf = strip(read('src/lib/transcos-v3/preflight.ts'));
  ok('preflight に PDF 本文抽出が無い', !/extractPdfText|getTextContent/.test(pf));
  ok('読んだ直後に SHA を確かめる', /sha !== m\.sha256/.test(pf));
  ok('root は 1 段だけ外す', /stripRoot/.test(pf));
  const pr = strip(read('src/lib/transcos-v3/probes.ts'));
  ok('ページ数は正規の PDF parser', /pdfjs-dist\/legacy\/build\/pdf\.mjs/.test(pr));
  ok('countPdfPages を根拠にしない', !/countPdfPages/.test(pr));
  ok('見出しは専用の raw reader で読む', /readRawHeaderRow\(bytes\)/.test(pr));
  ok('digest 計算で trim / NFKC しない',
    !/rawHeaders[^;]*\.trim\(\)|rawHeaders[^;]*normalize\(/.test(pr));
  const rh = strip(read('src/lib/transcos-v3/xlsx-raw-header.ts'));
  ok('raw reader は trim しない', !/\.trim\(\)/.test(rh));
  ok('raw reader は NFKC しない', !/normalize\(/.test(rh));
  ok('raw reader は日付へ変換しない', !/Date\b/.test(rh));
}

rmSync(tmp, { recursive: true, force: true });
console.log('');
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 件 失敗 (${pass} 件 通過)\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
  process.exit(1);
}
console.log(`✓ ${pass} 件 通過 — identity は content-addressed で、Preflight は 1 項目単位で止まる\n`);
