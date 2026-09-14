#!/usr/bin/env node
/**
 * トランスコスモス10名 v3.0 — **実 ZIP の Preflight (Stage A) を CLI で通す**。
 *
 * 【この道具の立場】
 * `verify-transcos-v3-preflight.mjs` は**合成 fixture** で判定ロジックを固定する。
 * こちらは**実際に受領した 159MB の ZIP そのもの**を開いて §8 を通す。
 * **合成 fixture が通っただけで REAL E2E PASS とは呼ばない** (§21 / Appendix F-17) ので、
 * 実データに触れる口がどうしても 1 本要る。
 *
 * 【ここで出す言葉は "Stage A" まで】
 * §21 の `REAL ZIP E2E PASS` は Stage A〜D (処理・JSON・S3 まで) が全部揃った時だけの呼び名。
 * このスクリプトは **Stage A (REAL Preflight) しか見ない**ので、
 * 何がどう緑でも `REAL ZIP E2E PASS` とは表示しない。**そう書けるのはアプリの実行結果だけ。**
 *
 * 【Executive (§9.1) はここでは判定できない】
 * 人物マスタは DB にあるので、CLI からは照合できない。
 * `--executives <file.json>` を渡さない限り **「未照合」と表示し、緑扱いにしない**
 * (「CLI で緑だったから人物は大丈夫」という読み替えを構造的に作らない)。
 *
 * 【PII (§24)】
 * 検査値も問診の回答も**1 文字も出さない**。出すのは検査 id・件数・相対パス・
 * ページ数・digest の一致可否だけ。`--quiet-paths` で相対パスも伏せられる。
 *
 * 【CI には入れない】実 ZIP (159MB) も資格情報もランナーに無い。
 * 入れると**実ロジックでなく環境差で赤くなる** (`verify:print` を入れなかったのと同じ理由)。
 * CI で走るのは合成 fixture 側 `verify:transcos-v3-preflight` だけ。
 *
 * 実行:
 *   npm run verify:transcos-v3-real-zip -- --zip <path|s3://bucket/key>
 *                                          [--executives <file.json>] [--quiet-paths]
 *
 * `--quiet-paths` … 相対パスと人物名を伏せる。伏せる対象は **manifest の実値**から作るので
 *                   「それらしい文字列か」を推測しない (件数・sha は残るので読める)。
 * `--executives`  … `[{ "subject": "<displayName>", "candidates": <n> }]`。
 *                   渡さなければ §9.1 は「未照合」で、緑扱いにしない。
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync, createReadStream } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import ts from 'typescript';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

// --- 引数 -------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const zipArg = arg('--zip');
const execArg = arg('--executives');
const quietPaths = argv.includes('--quiet-paths');
if (!zipArg) {
  console.error('使い方: node scripts/verify-transcos-v3-real-zip.mjs --zip <path|s3://bucket/key>');
  console.error('        [--executives <file.json>] [--quiet-paths]');
  process.exit(2);
}

// --- TS をその場で JS へ (実物を読む。写しを作らない) ------------------------
const tmp = mkdtempSync(join(repoRoot, '.verify-v3-real-'));
const FLAT = new Map([
  ['./manifest', 'manifest.js'], ['./preflight', 'preflight.js'],
  ['./xlsx-raw-header', 'xlsx-raw-header.js'], ['./probes', 'probes.js'],
  ['../s3', 's3.js'], ['./classify', 'classify.js'],
  ['../ad-hoc-diagnosis/archive', 'archive.js'],
  ['../ad-hoc-diagnosis/health-checkup-xlsx', 'health-checkup-xlsx.js'],
]);
const rel = (src) => {
  let out = src;
  for (const [spec, flat] of FLAT) {
    out = out.split(`from '${spec}'`).join(`from './${flat}'`);
  }
  return out;
};
const writeTs = (relPath, outName) => {
  writeFileSync(join(tmp, outName), ts.transpileModule(rel(read(relPath)), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
};
writeTs('src/lib/s3.ts', 's3.js');
writeTs('src/lib/ad-hoc-diagnosis/classify.ts', 'classify.js');
writeTs('src/lib/ad-hoc-diagnosis/archive.ts', 'archive.js');
writeTs('src/lib/ad-hoc-diagnosis/health-checkup-xlsx.ts', 'health-checkup-xlsx.js');
writeTs('src/lib/transcos-v3/manifest.ts', 'manifest.js');
writeTs('src/lib/transcos-v3/preflight.ts', 'preflight.js');
writeTs('src/lib/transcos-v3/xlsx-raw-header.ts', 'xlsx-raw-header.js');
writeTs('src/lib/transcos-v3/probes.ts', 'probes.js');

let exitCode = 1;
try {
  const M = await import(pathToFileURL(join(tmp, 'manifest.js')).href);
  const P = await import(pathToFileURL(join(tmp, 'preflight.js')).href);
  const PR = await import(pathToFileURL(join(tmp, 'probes.js')).href);
  const { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } = await import('@zip.js/zip.js');

  // --- ZIP を手元に置く。**SHA は streaming で自分で取る** (申告を信じない・§8.1) ---
  let localPath = zipArg;
  let downloaded = null;
  if (zipArg.startsWith('s3://')) {
    const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(zipArg);
    if (!m) throw new Error(`s3 URI の形が違います: ${zipArg}`);
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region: process.env.AWS_REGION ?? 'ap-northeast-1' });
    const res = await client.send(new GetObjectCommand({ Bucket: m[1], Key: m[2] }));
    downloaded = join(mkdtempSync(join(tmpdir(), 'transcos-zip-')), basename(m[2]));
    const { createWriteStream } = await import('node:fs');
    await pipeline(res.Body, createWriteStream(downloaded));
    localPath = downloaded;
    console.log(`S3 から取得: ${zipArg} → (一時ファイル)`);
  }

  const sizeOnDisk = statSync(localPath).size;
  const h = createHash('sha256');
  await pipeline(createReadStream(localPath), async function* (s) { for await (const c of s) { h.update(c); yield c; } });
  const zipSha256 = h.digest('hex');
  console.log(`ZIP: ${sizeOnDisk.toLocaleString()} bytes / sha256 ${zipSha256}`);
  console.log(`期待: ${M.TRANSCOS_ZIP.bytes.toLocaleString()} bytes / sha256 ${M.TRANSCOS_ZIP.sha256}`);

  // --- Central Directory (まだ中身は 1 バイトも読まない) ---
  const bytes = new Uint8Array(readFileSync(localPath));
  let entries = [];
  let opened = false;
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    entries = await reader.getEntries();
    opened = true;
  } catch (err) {
    console.error(`ZIP を開けません: ${err instanceof Error ? err.message : String(err)}`);
  }

  const source = {
    zipBytes: sizeOnDisk,
    zipSha256,
    opened,
    rawEntries: entries.map((e) => ({
      // **`path` であって `filename` ではない** (`RawEntry`)。ここを取り違えると
      // 判定が始まる前に TypeError で落ちる = 検査 id が 1 つも出ない (実測 2026-09-14)。
      path: e.filename,
      directory: Boolean(e.directory),
      declaredSize: Number(e.uncompressedSize ?? 0),
      encrypted: Boolean(e.encrypted),
      // zip-slip / 絶対パス / 親への遡り。**採用してはいけないものを名指しで落とす。**
      unsafe: /^([a-zA-Z]:)?[/\\]/.test(e.filename) ? '絶対パス'
        : e.filename.split(/[/\\]/).includes('..') ? '親ディレクトリへの遡り'
          : null,
    })),
  };

  // **判定へ渡す形を先に確かめる。** .mjs なので型が守ってくれない —
  // 1 語違うだけで「検査 id が 1 つも出ないまま TypeError」になり、
  // **落ちた理由が Preflight の判定なのか道具の不備なのか分からなくなる**。
  for (const e of source.rawEntries) {
    if (typeof e.path !== 'string' || typeof e.directory !== 'boolean') {
      throw new Error('RawEntry の形が違います (path: string / directory: boolean が要ります)');
    }
  }

  /*
   * 失敗 1 件の表示。
   *
   * 【`--quiet-paths` を当て推量でやらない】
   * 最初は「`/` を含むなら伏せる」にしていたが、**Executive の失敗は
   * `吉光 陽平 — 照合していない` のように氏名そのものが label** なので素通りした (実測)。
   * 「それらしい文字列か」を見分けようとすると必ず漏れる。
   * → **伏せる対象を manifest から機械的に作る**。相対パス・人物名・root は
   *   全部あそこが出どころなので、**その実値が出てきたら置き換える**だけで足りる。
   *   件数・sha・`未読` のような統計はそこに無いので残る (読めなくならない)。
   */
  const secrets = [
    ...M.TRANSCOS_FILES.map((f) => f.relPath),
    ...M.TRANSCOS_FILES.map((f) => f.subject).filter(Boolean),
    ...M.TRANSCOS_SUBJECTS.map((x) => x.displayName),
    ...M.TRANSCOS_SUBJECTS.map((x) => x.folder),
    M.EXPECTED_ROOT,
  ].filter((x) => typeof x === 'string' && x.length > 0)
    // 長いものから消す (人物名がパスの一部でもあるため、先に短い方を消すと残骸が出る)。
    .sort((a, b) => b.length - a.length);
  const redact = (text) => {
    if (!quietPaths || !text) return text;
    let out = text;
    for (const v of secrets) out = out.split(v).join('(伏字)');
    return out;
  };
  const line = (i) => `      - ${redact(i.label)}${i.detail ? ` — ${redact(i.detail)}` : ''}`;
  const show = (c, limit) => {
    console.log(`${c.ok ? '✓' : '✗'} ${c.id}  ${c.title}`);
    for (const i of c.items.slice(0, limit)) console.log(line(i));
    if (c.items.length > limit) console.log(`      … 他 ${c.items.length - limit} 件`);
  };

  const structure = P.preflightStructure(source);
  for (const c of structure.checks) show(c, 8);

  // --- 計画にある分だけ読む。**構造 NG なら plan は空 = 1 バイトも読まない** ---
  console.log(`\n読む計画: ${structure.plan.length} 件`);
  const probed = [];
  let n = 0;
  for (const item of structure.plan) {
    n += 1;
    process.stdout.write(`\r  ${n}/${structure.plan.length} 読取中…   `);
    probed.push(await P.probeFile(item, async (idx) => {
      const e = entries[idx];
      if (!e || e.directory) throw new Error('locator が file を指していません');
      return await e.getData(new Uint8ArrayWriter());
    }, PR.nodeProbes));
  }
  if (structure.plan.length > 0) process.stdout.write('\r' + ' '.repeat(40) + '\r');

  // --- Executive (§9.1) は DB 依存。渡されなければ「未照合」 ---
  let executives = [];
  let execSupplied = false;
  if (execArg) {
    executives = JSON.parse(readFileSync(execArg, 'utf8'));
    execSupplied = true;
  }

  const report = P.preflightFinish(structure, probed, executives);
  console.log('');
  for (const c of report.checks.slice(structure.checks.length)) show(c, 12);

  // --- Stage A の判定。**Executive は含めない** (§21 Stage A の一覧どおり) ---
  const stageA = report.checks.filter((c) => c.id !== '9.1-executive');
  const stageAOk = stageA.every((c) => c.ok);
  const s = report.summary;
  console.log([
    '',
    `Stage A (REAL Preflight): ${stageAOk ? 'PASS' : 'FAIL'}`,
    `  ファイル: ${s.files} / 人物: ${s.subjects}`,
    `  健診PDF: ${s.health} / 問診XLSX: ${s.questionnaireXlsx} / 問診PDF: ${s.questionnairePdf}`,
    `  Genoplan: ${s.genoplan} / 健診補助XLSX: ${s.healthSupport}`,
    `  Executive: ${execSupplied ? s.executives : '未照合 (DB が要る・この CLI では判定しない)'}`,
  ].join('\n'));

  console.log([
    '',
    '※ これは Stage A だけです。§21 の `REAL ZIP E2E PASS` は',
    '   Stage B (実処理) / C (実 JSON) / D (実 S3 readback) まで揃って初めて名乗れます。',
    execSupplied ? '' : '※ Executive 照合 (§9.1) は未実施です。緑でも人物確定の根拠にはなりません。',
  ].filter(Boolean).join('\n'));

  exitCode = stageAOk && (!execSupplied || report.ok) ? 0 : 1;
  if (downloaded) rmSync(dirname(downloaded), { recursive: true, force: true });
} catch (err) {
  console.error(`\n落ちました: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(exitCode);
