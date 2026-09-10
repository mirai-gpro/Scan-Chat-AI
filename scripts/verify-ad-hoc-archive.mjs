#!/usr/bin/env node
// scripts/verify-ad-hoc-archive.mjs
// 臨時診断バッチ: ZIP 基盤 (archive.ts) と S3 キー (keys.ts) の回帰チェック。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §5.1 / §5.3.7.1 / §24.2 / §24.3
//
// **サーバも S3 も要らない。** 実際に ZIP を組んで読み直すので、
// 「Range が両端を含む閉区間」であることを**本物の ZIP パーサで**確かめられる。
//
//   node scripts/verify-ad-hoc-archive.mjs
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

let pass = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), `期待 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);
}

// --- archive.ts / keys.ts を transpile して読み込む (DB も S3 も使わない) ---
// **リポジトリの中**に置く。/tmp に置くと `node_modules` を解決できない (実測)。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(repoRoot, '.verify-adhoc-'));
function loadTs(relPath, outName, rewrite = (s) => s) {
  const src = readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8');
  const js = ts.transpileModule(rewrite(src), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const out = join(tmp, outName);
  writeFileSync(out, js);
  return import(pathToFileURL(out).href);
}

// archive.ts は s3.ts を import する (env に依存)。**S3 を触らない検査**なので、
// import 先だけを差し替えて読み込む (ロジックは 1 文字も変えない)。
const stubS3 = join(tmp, 's3-stub.js');
writeFileSync(stubS3, `
export function getS3Config() { return null; }
export function makeS3Client() { throw new Error('この検査では S3 を呼ばない'); }
`);

const archive = await loadTs('src/lib/ad-hoc-diagnosis/archive.ts', 'archive.js', (s) =>
  s.replace(`from '../s3'`, `from ${JSON.stringify(pathToFileURL(stubS3).href)}`),
);
const keys = await loadTs('src/lib/ad-hoc-diagnosis/keys.ts', 'keys.js', (s) =>
  s.replace(/import type \{ S3Config \} from '\.\.\/s3';?/, ''),
);

const zipjs = await import('@zip.js/zip.js');
zipjs.configure({ useWebWorkers: false });

// ===========================================================================
// ① S3 キーの検証 (§24.2) — **完全一致であること**
// ===========================================================================
const CFG = { bucket: 'wellfort-ai-input', region: 'ap-northeast-1', prefix: 'scan-accuracy-test/' };
// **英字を含む UUID にする** — 数字だけだと `toUpperCase()` が no-op になり
// 「大文字を弾く」検査が素通りする (実測でそうなっていた)。
const UID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const GOOD = `scan-accuracy-test/ad-hoc-uploads/${UID}/source.zip`;

eq('key: 採番が仕様どおりの形', keys.adHocZipKey(CFG, UID), GOOD);
ok('key: 正規のキーを通す', keys.isAdHocZipKey(GOOD, CFG));
eq('key: batchId を取り出せる', keys.batchIdFromZipKey(GOOD, CFG), UID);

const badKeys = [
  ['Elith 納品 JSON', 'scan-accuracy-test/user/abc/date/2026_01_01/HealthCheckupData_x.json'],
  ['prefix 内の別領域', `scan-accuracy-test/scan-uploads/2026/01/01/${UID}.pdf`],
  ['prefix が違う', `other-prefix/ad-hoc-uploads/${UID}/source.zip`],
  ['相対パス', `scan-accuracy-test/ad-hoc-uploads/${UID}/../../../secret.zip`],
  ['二重スラッシュ', `scan-accuracy-test/ad-hoc-uploads//${UID}/source.zip`],
  ['batchId が UUID でない', 'scan-accuracy-test/ad-hoc-uploads/not-a-uuid/source.zip'],
  ['ファイル名が違う', `scan-accuracy-test/ad-hoc-uploads/${UID}/source.json`],
  ['.json を付け足す', `${GOOD}.json`],
  ['階層が深い', `scan-accuracy-test/ad-hoc-uploads/${UID}/sub/source.zip`],
  ['階層が浅い', 'scan-accuracy-test/ad-hoc-uploads/source.zip'],
  ['prefix そのもの', 'scan-accuracy-test/ad-hoc-uploads/'],
  ['空', ''],
  ['数値', 12345],
  ['null', null],
  ['大文字 UUID', `scan-accuracy-test/ad-hoc-uploads/${UID.toUpperCase()}/source.zip`],
];
for (const [label, k] of badKeys) {
  ok(`key: 弾く (${label})`, keys.isAdHocZipKey(k, CFG) === false, `通ってしまった: ${k}`);
}

// ===========================================================================
// ② エントリ検査 (§24.3)
// ===========================================================================
const baseEntry = { directory: false, uncompressedSize: 1000, encrypted: false, externalFileAttributes: 0 };
const inspect = (over) => archive.inspectEntry({ ...baseEntry, ...over });

eq('entry: 通常の PDF を採用', inspect({ filename: '10名/佐藤/健診.pdf' }).rejected, null);
eq('entry: XLSX を採用', inspect({ filename: 'a/b.xlsx' }).rejected, null);
eq('entry: Zip Slip', inspect({ filename: '../../etc/passwd.pdf' }).rejected, 'zip_slip');
eq('entry: 途中の ..', inspect({ filename: 'a/../../b.pdf' }).rejected, 'zip_slip');
eq('entry: 絶対パス (Unix)', inspect({ filename: '/etc/x.pdf' }).rejected, 'absolute_path');
eq('entry: 絶対パス (Windows)', inspect({ filename: 'C:/x.pdf' }).rejected, 'absolute_path');
eq('entry: 絶対パス (UNC)', inspect({ filename: '//server/share/x.pdf' }).rejected, 'absolute_path');
eq('entry: バックスラッシュ区切りの ..', inspect({ filename: '..\\x.pdf' }).rejected, 'zip_slip');
// symlink: Unix モード 0o120777 << 16
eq('entry: symlink', inspect({ filename: 'a.pdf', externalFileAttributes: 0o120777 << 16 }).rejected, 'symlink');
eq('entry: 通常ファイル (0o100644) は symlink でない',
  inspect({ filename: 'a.pdf', externalFileAttributes: 0o100644 << 16 }).rejected, null);
eq('entry: ディレクトリ', inspect({ filename: 'a/', directory: true }).rejected, 'directory');
eq('entry: パスワード保護', inspect({ filename: 'a.pdf', encrypted: true }).rejected, 'password_protected_file');
eq('entry: .xls は受入対象外', inspect({ filename: 'a.xls' }).rejected, 'unsupported_file');
eq('entry: .exe は受入対象外', inspect({ filename: 'a.exe' }).rejected, 'unsupported_file');
eq('entry: 拡張子なし', inspect({ filename: 'README' }).rejected, 'unsupported_file');
eq('entry: 深すぎる', inspect({ filename: 'a/b/c/d/e/f/g/h/i.pdf' }).rejected, 'too_deep');
eq('entry: 深さちょうど 8 は通す', inspect({ filename: 'a/b/c/d/e/f/g/h.pdf' }).rejected, null);
eq('entry: 1 ファイル上限超え',
  inspect({ filename: 'a.pdf', uncompressedSize: archive.MAX_ENTRY_BYTES + 1 }).rejected, 'entry_too_large');
eq('entry: 空ファイル', inspect({ filename: 'a.pdf', uncompressedSize: 0 }).rejected, 'empty_file');
eq('entry: 拡張子は大文字でも通る', inspect({ filename: 'a.PDF' }).rejected, null);
eq('entry: 拡張子は小文字で返る', inspect({ filename: 'a.PDF' }).ext, '.pdf');

// **危険なものが先に落ちる**こと (順序の固定)。symlink かつ .exe なら symlink が先。
eq('entry: 判定順 (symlink が拡張子より先)',
  inspect({ filename: 'a.exe', externalFileAttributes: 0o120777 << 16 }).rejected, 'symlink');
eq('entry: 判定順 (絶対パスが最優先)',
  inspect({ filename: '/a.exe', encrypted: true }).rejected, 'absolute_path');

// ===========================================================================
// ③ マジックバイト (§24.3)
// ===========================================================================
const pdfHead = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const zipHead = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const junk = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
ok('magic: PDF が通る', archive.magicMatchesExtension('.pdf', pdfHead));
ok('magic: PDF を名乗る非 PDF を弾く', archive.magicMatchesExtension('.pdf', zipHead) === false);
ok('magic: XLSX が通る', archive.magicMatchesExtension('.xlsx', zipHead));
ok('magic: XLSX を名乗る非 ZIP を弾く', archive.magicMatchesExtension('.xlsx', pdfHead) === false);
ok('magic: DOCX が通る', archive.magicMatchesExtension('.docx', zipHead));
ok('magic: CSV は常に通す', archive.magicMatchesExtension('.csv', junk));
ok('magic: 未知の拡張子は弾く', archive.magicMatchesExtension('.exe', junk) === false);
ok('magic: 短すぎるバッファを弾く', archive.magicMatchesExtension('.pdf', new Uint8Array([0x25])) === false);

// ===========================================================================
// ③.5 ファイル名の文字コード (§5.4 / §5.3.9-1)
// ===========================================================================
// **`cp932` は WHATWG のラベルではなく TextDecoder が投げる** (実測 Node v22.22.2)。
// zip.js は getEntries() の中で decode するので、**投げると ZIP を開けなくなる**。
// probe を通していることを固定する。
{
  const label = archive.pickFilenameEncoding();
  ok('encoding: 選んだラベルで TextDecoder を作れる',
    label === undefined || (() => { try { new TextDecoder(label); return true; } catch { return false; } })(),
    `label=${label}`);
  ok('encoding: cp932 を直接使っていない', label !== 'cp932');
  // この環境では shift_jis が使えるはず (使えない環境では undefined = 既定に委ねる)
  ok('encoding: 和文の受け皿を選べている (または安全に諦めている)',
    label === undefined || new TextDecoder(label).encoding === 'shift_jis', `label=${label}`);
  let threw = false;
  try { new TextDecoder('cp932'); } catch { threw = true; }
  ok('encoding: [前提の確認] cp932 は実際に投げる', threw,
    'この環境では cp932 が通る = 前提が変わったので probe の必要性を見直すこと');
}

// ===========================================================================
// ④ 本物の ZIP を組んで読み直す — **Range が両端を含む閉区間**であることの実測
// ===========================================================================
// S3 の代わりに Uint8Array から切り出す Reader を作る。**算術は S3RangeReader と同じ**
// (offset .. offset+length-1 の閉区間)。ここを 1 バイトずらすと ZIP パーサが壊れる。
function makeRangeReader(bytes, { offByOne = false } = {}) {
  const calls = [];
  const r = new zipjs.Reader('mem');
  r.size = bytes.length;
  r.init = async () => {};
  r.readUint8Array = async (offset, length) => {
    if (length <= 0) return new Uint8Array(0);
    const end = offByOne ? offset + length : offset + length - 1; // ← ここが要
    calls.push([offset, end]);
    const slice = bytes.slice(offset, end + 1); // Range は end を含む
    return slice;
  };
  return { reader: r, calls };
}

// テスト用 ZIP を組む (実在の氏名・PII は一切入れない)
async function buildZip(files) {
  const w = new zipjs.ZipWriter(new zipjs.Uint8ArrayWriter());
  for (const [name, content] of files) {
    await w.add(name, new zipjs.Uint8ArrayReader(content));
  }
  return await w.close();
}

// **圧縮の効かない中身にする。** 規則的なバイト列だと ZIP が数百バイトに縮み、
// zip.js が 1 回の読み出しで読み切ってしまう → 「部分読みか」も「Range の +1 で壊れるか」も
// 素通りしてしまう (実測: 823 バイトの ZIP では退行注入が検出できなかった)。
const pdfBody = new Uint8Array(1_500_000);
pdfBody.set(pdfHead, 0);
{
  // 決定論の擬似乱数 (xorshift32)。**毎回同じ ZIP になる**ので検査結果がぶれない。
  let x = 0x9e3779b9;
  for (let i = pdfHead.length; i < pdfBody.length; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    pdfBody[i] = x & 0xff;
  }
}
const csvBody = new TextEncoder().encode('項目,値\n身長,170\n');

const zipBytes = await buildZip([
  ['batch/subject-a/report.pdf', pdfBody],
  ['batch/subject-a/values.csv', csvBody],
  ['batch/notes.txt', new TextEncoder().encode('ignore me')],
]);
ok('zip: テスト ZIP を組めた', zipBytes.length > 0, `${zipBytes.length} バイト`);
// 部分読みと退行注入が意味を持つ大きさか (小さいと 1 回で読み切られ検査が素通りする)
ok('zip: 検査に足る大きさになっている', zipBytes.length > 1_000_000, `${zipBytes.length} バイト`);

const { reader, calls } = makeRangeReader(zipBytes);
const opened = await archive.openArchive(reader);

eq('zip: エントリ総数', opened.listing.rawCount, 3);
const adopted = opened.listing.entries.filter((e) => e.rejected === null).map((e) => e.path).sort();
eq('zip: 採用したのは PDF と CSV だけ', JSON.stringify(adopted),
  JSON.stringify(['batch/subject-a/report.pdf', 'batch/subject-a/values.csv']));
eq('zip: .txt は unsupported_file',
  opened.listing.entries.find((e) => e.path.endsWith('.txt'))?.rejected, 'unsupported_file');

const gotPdf = await opened.read('batch/subject-a/report.pdf');
eq('zip: PDF のバイト数が一致', gotPdf.length, pdfBody.length);
ok('zip: PDF の中身が 1 バイトも違わない', gotPdf.every((b, i) => b === pdfBody[i]));
ok('zip: 読み出した PDF がマジックバイト検査を通る',
  archive.magicMatchesExtension('.pdf', gotPdf.subarray(0, 8)));
const gotCsv = await opened.read('batch/subject-a/values.csv');
eq('zip: CSV の中身が一致', new TextDecoder().decode(gotCsv), new TextDecoder().decode(csvBody));
ok('zip: 弾いたエントリは読めない',
  await opened.read('batch/notes.txt').then(() => false, () => true));
await opened.close();

// **部分読みになっていること** = ZIP 全体を 1 回で読んでいない
ok('zip: 部分読みで開いている (複数回の Range)', calls.length >= 2, `呼び出し ${calls.length} 回`);
const maxRead = Math.max(...calls.map(([s, e]) => e - s + 1));
ok('zip: 1 回の読み出しが ZIP 全体より小さい', maxRead < zipBytes.length,
  `最大 ${maxRead} / 全体 ${zipBytes.length}`);

// **Range の算術は純粋関数で直接固定する** (§5.3.7.1)。
// 実測: 1 バイト多く返しても zip.js は壊れなかった = **ライブラリは守ってくれない**。
// 「思っている範囲と実際の範囲が静かにずれる」だけなので、捕まえるのはこちらの責任。
eq('range: 先頭 100 バイト', archive.rangeHeaderFor(0, 100), 'bytes=0-99');
eq('range: 1 バイト', archive.rangeHeaderFor(0, 1), 'bytes=0-0');
eq('range: 途中から', archive.rangeHeaderFor(1000, 256), 'bytes=1000-1255');
eq('range: 末尾寄り', archive.rangeHeaderFor(zipBytes.length - 22, 22),
  `bytes=${zipBytes.length - 22}-${zipBytes.length - 1}`);
ok('range: length=0 を投げる', (() => { try { archive.rangeHeaderFor(0, 0); return false; } catch { return true; } })());
ok('range: 負の offset を投げる', (() => { try { archive.rangeHeaderFor(-1, 10); return false; } catch { return true; } })());
ok('range: 小数を投げる', (() => { try { archive.rangeHeaderFor(0, 1.5); return false; } catch { return true; } })());

// **長さの検査** — 短くても長くても投げること。長い側を見逃すと
// 閉区間の取り違えが誰にも気づかれないまま残る (zip.js は受け入れてしまうため)。
const okLen = (bytes, expected) => {
  try { archive.assertExactLength(bytes, expected, 'test'); return true; } catch { return false; }
};
ok('length: ちょうどは通る', okLen(new Uint8Array(100), 100));
ok('length: 短いと投げる', okLen(new Uint8Array(99), 100) === false);
ok('length: 長いと投げる', okLen(new Uint8Array(101), 100) === false);

// **退行注入**: 終端を offset+length にすると `assertExactLength` が捕まえること
{
  const badRange = (offset, length) => `bytes=${offset}-${offset + length}`; // ← 退行
  const m = /bytes=(\d+)-(\d+)/.exec(badRange(0, 100));
  const got = Number(m[2]) - Number(m[1]) + 1;
  ok('range: [退行注入] 終端を +1 すると 1 バイト多い範囲になる', got === 101, `${got} バイト`);
  ok('range: [退行注入] その多い分を assertExactLength が捕まえる',
    okLen(new Uint8Array(got), 100) === false);
}

// ===========================================================================
// ⑤ 上限 (§5.1) — 定数が仕様どおりか
// ===========================================================================
eq('limit: ZIP 上限 512MB', archive.MAX_ZIP_BYTES, 512 * 1024 * 1024);
eq('limit: 展開後 1.5GB', archive.MAX_TOTAL_UNCOMPRESSED, 1536 * 1024 * 1024);
eq('limit: エントリ数 2000', archive.MAX_ENTRIES, 2000);
eq('limit: 1 ファイル 80MB', archive.MAX_ENTRY_BYTES, 80 * 1024 * 1024);
eq('limit: 深度 8', archive.MAX_DEPTH, 8);
eq('limit: 許可拡張子は 4 種', archive.ALLOWED_EXTENSIONS.join(','), '.pdf,.xlsx,.docx,.csv');
ok('limit: .xls を許可していない', archive.ALLOWED_EXTENSIONS.includes('.xls') === false);
ok('limit: .json を許可していない', archive.ALLOWED_EXTENSIONS.includes('.json') === false);

// ===========================================================================
rmSync(tmp, { recursive: true, force: true });
const total = pass + failures.length;
if (failures.length) {
  console.error(`\n✗ verify:ad-hoc-archive  ${pass}/${total}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ verify:ad-hoc-archive  ${pass}/${total}`);
