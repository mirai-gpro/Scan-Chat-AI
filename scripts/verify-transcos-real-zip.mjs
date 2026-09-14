#!/usr/bin/env node
/**
 * トランスコスモス10名 緊急専用 v2.0 — **実 ZIP の Preflight 検証** (指示書 §18-B)。
 *
 * 合成 fixture は回帰検出用で、**実 ZIP を通していない完了報告は禁止** (§26-20)。
 * これはその「実 ZIP を通す」ための口で、**ネットワークへ出ない・LLM を 1 回も呼ばない・
 * S3 へ 1 件も書かない**。原本を手元に置いたまま、38 件の同一性だけを機械で確かめる。
 *
 * 使い方:
 *   node scripts/verify-transcos-real-zip.mjs <ZIP へのパス>
 *   TRANSCOS_ZIP_PATH=... node scripts/verify-transcos-real-zip.mjs
 *
 * ZIP が手元に無いときは **SKIP** で終わる (CI を赤くしない)。
 * ただし **SKIP を PASS と呼ばない** — 最後に必ずその旨を出す。
 *
 * Executive 照合 (検査14) は Wellfort 側 DB を見るのでここでは行わない。
 * この CLI の結論は「**Executive を除いて PASS**」までで、
 * 10/10 の確定は管理画面の Preflight が行う。
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync, statSync, existsSync, createReadStream } from 'node:fs';
import { openAsBlob } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

const zipPath = process.argv[2] ?? process.env.TRANSCOS_ZIP_PATH ?? '';
if (!zipPath || !existsSync(zipPath)) {
  console.log('');
  console.log('SKIP — 実 ZIP が手元にありません。');
  console.log('  node scripts/verify-transcos-real-zip.mjs <ZIP へのパス>');
  console.log('  (SKIP は PASS ではありません。実 ZIP を通すまで REAL ZIP E2E PASS と呼べません)');
  console.log('');
  process.exit(0);
}

// ── 実物を transpile (S3 だけスタブ。ZIP の解釈は本物を使う) ─────────────────
const tmp = mkdtempSync(join(repoRoot, '.verify-rz-'));
const rel = (src) => src
  .replace(`from './manifest'`, `from './manifest.js'`)
  .replace(`from '../ad-hoc-diagnosis/archive'`, `from './archive.js'`)
  .replace(`from '../s3'`, `from './s3.js'`)
  .replace(`from '../ad-hoc-diagnosis/health-checkup-xlsx'`, `from './health-checkup-xlsx.js'`)
  .replace(`from '../ad-hoc-diagnosis/external-form-contract'`, `from './external-form-contract.js'`);
const writeTs = (relPath, outName) => {
  writeFileSync(join(tmp, outName), ts.transpileModule(rel(read(relPath)), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
};
writeFileSync(join(tmp, 's3.js'),
  'export const getS3Config = () => null;\nexport const makeS3Client = () => { throw new Error("S3 は使わない"); };\n');
writeTs('src/lib/ad-hoc-diagnosis/archive.ts', 'archive.js');
writeTs('src/lib/ad-hoc-diagnosis/health-checkup-xlsx.ts', 'health-checkup-xlsx.js');
writeTs('src/lib/ad-hoc-diagnosis/external-form-contract.ts', 'external-form-contract.js');
writeTs('src/lib/transcos-emergency/manifest.ts', 'manifest.js');
writeTs('src/lib/transcos-emergency/preflight.ts', 'preflight.js');
writeTs('src/lib/transcos-emergency/probes.ts', 'probes.js');

const M = await import(pathToFileURL(join(tmp, 'manifest.js')).href);
const P = await import(pathToFileURL(join(tmp, 'preflight.js')).href);
const PR = await import(pathToFileURL(join(tmp, 'probes.js')).href);
const A = await import(pathToFileURL(join(tmp, 'archive.js')).href);

// ── ZIP 全体の SHA-256 (ストリームで数える。159MB を一度に載せない) ──────────
const zipBytes = statSync(zipPath).size;
const zipSha256 = await new Promise((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(zipPath)
    .on('data', (c) => h.update(c))
    .on('end', () => resolve(h.digest('hex')))
    .on('error', reject);
});

console.log('');
console.log(`入力: ${zipPath}`);
console.log(`bytes: ${zipBytes}`);
console.log(`sha256: ${zipSha256}`);

// ── Central Directory (本物の openArchive を通す) ──────────────────────────
const blob = await openAsBlob(zipPath);
const { BlobReader } = await import('@zip.js/zip.js');
const archive = await A.openArchive(new BlobReader(blob));

const rawEntries = archive.listing.entries.map((e) => ({
  path: e.path,
  directory: e.rejected === 'directory',
  declaredSize: e.declaredSize,
  encrypted: e.rejected === 'password_protected_file',
}));

const report = await P.runPreflight({
  source: { zipBytes, zipSha256, rawEntries },
  read: (i0) => archive.readByIndex(i0),
  probes: PR.nodeProbes,
  // **Executive はここでは照合しない。** 1 件と申告して通したりしない —
  // 下で「この CLI では未照合」と明記し、結論から外す。
  executives: M.TRANSCOS_SUBJECTS.map((s) => ({ subjectNo: s.subjectNo, candidates: 1 })),
  golden: PR.goldenChecks,
});
await archive.close();
rmSync(tmp, { recursive: true, force: true });

// ── 出力 ──────────────────────────────────────────────────────────────────
const withoutExec = report.checks.filter((c) => c.id !== 14);
const okExceptExec = withoutExec.every((c) => c.ok);

console.log('');
for (const c of report.checks) {
  if (c.id === 14) { console.log(`  - 検査14 ${c.title}: この CLI では未照合 (管理画面で確認)`); continue; }
  console.log(`  ${c.ok ? '✓' : '✗'} 検査${String(c.id).padStart(2)} ${c.title}`);
  for (const it of c.items.slice(0, 12)) console.log(`      ✗ ${it.label}${it.detail ? ` — ${it.detail}` : ''}`);
  if (c.items.length > 12) console.log(`      … 他 ${c.items.length - 12} 件`);
}

console.log('');
console.log(P.formatPreflight({ ...report, ok: okExceptExec }));
console.log('');
if (!okExceptExec) {
  console.error('✗ 実 ZIP Preflight FAIL — 上の ✗ を 1 項目ずつ解消してください\n');
  process.exit(1);
}
console.log('✓ 実 ZIP Preflight PASS (Executive 照合を除く)');
console.log('  Executive 10/10 は管理画面の Preflight で確定します。\n');
