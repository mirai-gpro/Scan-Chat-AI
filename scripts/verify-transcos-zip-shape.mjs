#!/usr/bin/env node
/**
 * トランスコスモス10名 緊急専用 v2.0 — **entry 番号の約束を実物の ZIP で確かめる**。
 *
 * 【なぜ要るか】`manifest.ts` の entry 番号は **1 始まり・ディレクトリ込み**で、
 * `archive.readByIndex()` は **0 始まり**。ここを取り違えると
 * **黙って別人のファイルを読む** — 例外も出ないし、JSON も一見それらしく出来る。
 * 前の検査 (`verify-transcos-manifest.mjs`) は `rawEntries` を合成して渡すので、
 * **本物の ZIP を zip.js が並べた順**とずれていたら気づけない。
 *
 * そこで **manifest と同じ骨格の ZIP を実際に作り**、本物の `openArchive()` に
 * 読ませて Preflight を通す。中身は 0 埋め (先頭のマジックだけ本物) なので:
 *   PASS になるべき … 検査 3/4/6/7/8/9/10/15/16 (**並び・パス・バイト数・役割**)
 *   FAIL になるべき … 検査 1/2/5/11 (**中身が原本ではないから**)
 * この 2 つが同時に成り立つことが、「骨格は正しく読めていて、
 * 中身の同一性はちゃんと別で見ている」ことの証明になる。
 *
 * **ネットワークへ出ない。LLM を呼ばない。S3 へ書かない。**
 * 実 ZIP そのものの検証は `verify-transcos-real-zip.mjs`。
 *
 * 実行: node scripts/verify-transcos-zip-shape.mjs
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { openAsBlob } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import ts from 'typescript';

let pass = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
const tmp = mkdtempSync(join(repoRoot, '.verify-zs-'));
const work = mkdtempSync(join(tmpdir(), 'transcos-zip-'));

const rel = (src) => src
  .replace(`from './manifest'`, `from './manifest.js'`)
  .replace(`from '../ad-hoc-diagnosis/archive'`, `from './archive.js'`)
  .replace(`from '../s3'`, `from './s3.js'`);
const writeTs = (relPath, outName) => {
  writeFileSync(join(tmp, outName), ts.transpileModule(rel(read(relPath)), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
};
writeFileSync(join(tmp, 's3.js'),
  'export const getS3Config = () => null;\nexport const makeS3Client = () => { throw new Error("S3 は使わない"); };\n');
writeTs('src/lib/ad-hoc-diagnosis/archive.ts', 'archive.js');
writeTs('src/lib/transcos-emergency/manifest.ts', 'manifest.js');
writeTs('src/lib/transcos-emergency/preflight.ts', 'preflight.js');

const M = await import(pathToFileURL(join(tmp, 'manifest.js')).href);
const P = await import(pathToFileURL(join(tmp, 'preflight.js')).href);
const A = await import(pathToFileURL(join(tmp, 'archive.js')).href);
const { ZipWriter, BlobReader, Uint8ArrayReader, BlobWriter } = await import('@zip.js/zip.js');

// ── manifest と同じ骨格の ZIP を作る ───────────────────────────────────────
const PDF_HEAD = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]; // %PDF-1.4
const ZIP_HEAD = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00];
const OFFICE_TEMP = [0x00, 0x01, 0x02, 0x03];

const zipWriter = new ZipWriter(new BlobWriter('application/zip'));
const maxEntry = Math.max(...M.TRANSCOS_MANIFEST.map((m) => m.entry));
const plannedDirs = [];
for (let i = 1; i <= maxEntry; i++) {
  const m = M.manifestEntry(i);
  if (m) {
    const buf = new Uint8Array(m.bytes); // 0 埋め (deflate でほぼ消える)
    const head = m.role === 'IGNORE_OFFICE_TEMP' ? OFFICE_TEMP
      : m.path.endsWith('.pdf') ? PDF_HEAD : ZIP_HEAD;
    buf.set(head.slice(0, Math.min(head.length, buf.length)), 0);
    // **ディレクトリを自動で足させない** — 足されると並びが崩れて index がずれる。
    await zipWriter.add(m.path, new Uint8ArrayReader(buf), { directory: false });
  } else {
    // ディレクトリ行。次に来るファイルのフォルダ名から作る。
    const next = M.TRANSCOS_MANIFEST.find((x) => x.entry > i && x.path.includes('/'));
    const name = `${next.path.slice(0, next.path.indexOf('/'))}/`;
    plannedDirs.push(name);
    await zipWriter.add(name, null, { directory: true });
  }
}
const blob = await zipWriter.close();
const zipFile = join(work, 'shape.zip');
writeFileSync(zipFile, Buffer.from(await blob.arrayBuffer()));

// ── 本物の openArchive で読む ──────────────────────────────────────────────
const archive = await A.openArchive(new BlobReader(await openAsBlob(zipFile)));
const rawEntries = archive.listing.entries.map((e) => ({
  path: e.path,
  directory: e.rejected === 'directory',
  declaredSize: e.declaredSize,
  encrypted: e.rejected === 'password_protected_file',
}));

ok('Central Directory の件数', rawEntries.length === maxEntry,
  `実 ${rawEntries.length} / 期待 ${maxEntry}`);
ok('ディレクトリは 10 件', rawEntries.filter((e) => e.directory).length === 10);
ok('ファイルは 38 件', rawEntries.filter((e) => !e.directory).length === 38);

/*
 * **本題**: manifest の entry 番号が、本物の ZIP の並びの何番目かと一致するか。
 * `zeroBasedIndex()` を通した位置に、その manifest 行の path/bytes が在ること。
 */
let idxOk = 0;
for (const m of M.TRANSCOS_MANIFEST) {
  const e = rawEntries[M.zeroBasedIndex(m.entry)];
  if (e && !e.directory && e.path === m.path && e.declaredSize === m.bytes) idxOk++;
}
ok('entry 番号が 0 始まり添字と噛み合う (38/38)', idxOk === 38, `一致 ${idxOk}/38`);

// **読み出しも同じ約束で動く** — entry 7 を読むと 7 番の中身が返る
{
  const m = M.manifestEntry(7);
  // **throw で落とさない。** 「何かが例外を投げた」では原因が読めないので、
  // 名前のついた失敗として出す (添字がずれるとここが directory を掴む)。
  let bytes = null; let err = null;
  try { bytes = await archive.readByIndex(M.zeroBasedIndex(7)); }
  catch (e) { err = e instanceof Error ? e.message : String(e); }
  ok('readByIndex が同じ entry を返す', bytes != null && bytes.length === m.bytes,
    err ?? `実 ${bytes?.length} / 期待 ${m.bytes}`);
  ok('PDF のマジックが先頭に在る', bytes != null && bytes[0] === 0x25 && bytes[1] === 0x50, err ?? '');
}

// ── Preflight を通す ──────────────────────────────────────────────────────
const { createHash } = await import('node:crypto');
const report = await P.runPreflight({
  source: { zipBytes: M.TRANSCOS_ZIP.bytes, zipSha256: M.TRANSCOS_ZIP.sha256, rawEntries },
  read: (i0) => archive.readByIndex(i0),
  probes: {
    sha256: (b) => createHash('sha256').update(b).digest('hex'),
    // 0 埋めなので**本物の PDF ではない**。数えられない = null (推測値を返さない)。
    pdfPageCount: () => null,
    xlsxHeader: () => null,
  },
  executives: M.TRANSCOS_SUBJECTS.map((s) => ({ subjectNo: s.subjectNo, candidates: 1 })),
  golden: { questionnaireHeaderOk: () => ({ ok: false, detail: '先頭行を読めない' }) },
});
await archive.close();

const check = (id) => report.checks.find((c) => c.id === id);
// 骨格は読めている
for (const id of [3, 4, 6, 7, 8, 9, 10, 15, 16]) {
  ok(`検査${id} は PASS (骨格)`, check(id)?.ok === true,
    JSON.stringify(check(id)?.items?.slice(0, 3) ?? null));
}
// 中身は原本ではないので落ちる = **同一性をちゃんと別で見ている証拠**
for (const id of [5, 11, 12, 13]) {
  ok(`検査${id} は FAIL (中身が原本でない)`, check(id)?.ok === false);
}
ok('全体は FAIL', report.ok === false);
ok('落ちた件数を 1 項目単位で返す', (check(5)?.items?.length ?? 0) === 38);

rmSync(tmp, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });
console.log('');
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 件 失敗 (${pass} 件 通過)\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
  process.exit(1);
}
console.log(`✓ ${pass} 件 通過 — entry 番号の約束は本物の ZIP の並びと一致する\n`);
