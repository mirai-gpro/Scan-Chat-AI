#!/usr/bin/env node
/**
 * 取り消し（論理削除）のキー検証。**サーバ・AWS 不要。**
 *
 * ここを緩めると、同じバケットに同居している **Elith 納品 JSON や他社の提出ぶん**まで
 * 動かせてしまう。しかも**緩くても普通に動いてしまう**ので、目視では守れない
 * (スキャンの直アップロードで同じ轍を踏んでいる = `isScanUploadKey` の完全一致)。
 *
 * 使い方: npm run verify:laif-revoke-key
 */
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];
const ok = (c, m) => { if (c) { pass++; console.log(`  PASS  ${m}`); } else { fails.push(m); console.log(`  FAIL  ${m}`); } };

// **本物のソースを読み込む**（写経すると写経が正しいことしか検査できない）。
const SRC = readFileSync(join(ROOT, 'src/lib/laif-portal.ts'), 'utf-8');
const tmp = mkdtempSync(join(tmpdir(), 'laif-revoke-'));
writeFileSync(join(tmp, 'laif-portal.ts'), SRC
  .replace(/^import \{[\s\S]*?\} from '@aws-sdk\/client-s3';$/m, 'const PutObjectCommand=0,ListObjectsV2Command=0,GetObjectCommand=0,HeadObjectCommand=0,CopyObjectCommand=0,DeleteObjectCommand=0;')
  .replace(/^import \{ getSignedUrl \}.*$/m, 'const getSignedUrl = null;')
  .replace(/^import \{ getS3Config[\s\S]*?from '\.\/s3';$/m,
    'const getS3Config = () => null; const makeS3Client = () => null;')
  .replace(/type S3Config,?\s*/g, '')
  .replace(/ extends S3Config/g, ''));
try {
  execFileSync('npx', ['--no-install', 'tsc', join(tmp, 'laif-portal.ts'), '--target', 'es2022',
    '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck', '--outDir', tmp],
    { stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  if (!existsSync(join(tmp, 'laif-portal.js'))) {
    console.error('transpile に失敗しました:\n' + (e.stdout || e.message));
    process.exit(1);
  }
}
writeFileSync(join(tmp, 'laif-portal.mjs'), readFileSync(join(tmp, 'laif-portal.js'), 'utf-8'));
const L = await import(`file://${join(tmp, 'laif-portal.mjs')}`);

const P = 'quarantine/';
const U = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

console.log('\n1. 通すべきもの');
ok(L.isQuarantineKey(P, 'laif', `quarantine/laif/2026/09/09/${U}.pdf`), '自社の提出ぶんは通る');
ok(L.isQuarantineKey(P, 'prevent', `quarantine/prevent/2026/01/31/${U}.pdf`), 'プリベントも通る');
ok(L.isQuarantineKey('q/', 'laif', `q/laif/2026/09/09/${U}.pdf`), 'プレフィックスが違っても形が合えば通る');

console.log('\n2. 通してはいけないもの（ここが本丸）');
ok(!L.isQuarantineKey(P, 'laif', 'user/abc/date/2026_09_09/HealthCheckupData_x.json'),
  '**Elith 納品 JSON を弾く**');
ok(!L.isQuarantineKey(P, 'laif', `quarantine/prevent/2026/09/09/${U}.pdf`),
  '**他社の提出ぶんを弾く**（partner が違う）');
ok(!L.isQuarantineKey(P, 'laif', `quarantine/laif/2026/09/09/${U}.json`), '.json を弾く');
ok(!L.isQuarantineKey(P, 'laif', `quarantine/laif/2026/09/09/${U}.pdf.json`), '二重拡張子を弾く');
ok(!L.isQuarantineKey(P, 'laif', `quarantine/laif/2026/09/09/${U}.pdf/../../x.pdf`), '相対パスを弾く');
ok(!L.isQuarantineKey(P, 'laif', 'quarantine/laif/2026/09/09/result.pdf'), '非 UUID を弾く');
ok(!L.isQuarantineKey(P, 'laif', `quarantine/laif/${U}.pdf`), '日付階層が無いものを弾く');
ok(!L.isQuarantineKey(P, 'laif', `quarantine/laif/2026/09/09/x/${U}.pdf`), '階層が深すぎるものを弾く');
ok(!L.isQuarantineKey(P, 'laif', `revoked/laif/2026/09/09/${U}.pdf`), '退避済み（revoked/）を弾く＝二重取り消し不可');
ok(!L.isQuarantineKey(P, 'laif', `xquarantine/laif/2026/09/09/${U}.pdf`), '前方に別文字が付いたものを弾く');
ok(!L.isQuarantineKey(P, 'laif', ` quarantine/laif/2026/09/09/${U}.pdf`), '先頭の空白を弾く');
ok(!L.isQuarantineKey(P, 'laif', `quarantine/laif/2026/09/09/${U}.PDF`), '大文字拡張子を弾く（S3 のキーは大小を区別する）');
ok(!L.isQuarantineKey(P, 'laif', `quarantine/laif/2026/9/9/${U}.pdf`), '桁の足りない日付を弾く');
ok(!L.isQuarantineKey(P, 'laif', ''), '空文字を弾く');
ok(!L.isQuarantineKey(P, 'laif', 'x'.repeat(400)), '異常に長いキーを弾く');
ok(!L.isQuarantineKey(P, 'laif', null), 'null を弾く（例外にしない）');

console.log('\n3. 正規表現メタ文字をプレフィックスに含んでも壊れない');
ok(L.isQuarantineKey('a.b/', 'laif', `a.b/laif/2026/09/09/${U}.pdf`), 'ドット入りプレフィックスが通る');
ok(!L.isQuarantineKey('a.b/', 'laif', `axb/laif/2026/09/09/${U}.pdf`), 'ドットが任意 1 文字として効いていない');

console.log('\n4. ソース側の約束');
{
  const api = readFileSync(join(ROOT, 'src/pages/api/partner/laif-upload.ts'), 'utf-8');
  ok(/MetadataDirective: 'COPY'/.test(SRC), '元ファイル名を保つ（REPLACE にしない）');
  ok(SRC.indexOf('CopyObjectCommand') < SRC.indexOf('DeleteObjectCommand'),
    '**コピーが先・削除が後**（逆だと失敗時に原本が消える）');
  ok(/revokedPrefix/.test(SRC) && !/DeleteObjectCommand\({ Bucket: cfg\.bucket, Key: revokedKey/.test(SRC),
    '退避先そのものを消していない');
  ok(/const DEFAULT_REVOKED_PREFIX = 'revoked\/'/.test(SRC), '退避先は quarantine とは別プレフィックス');
  ok(/if \(!isPortalUploadEnabled\(\)\) return json\(\{ ok: false, error: 'portal_upload_disabled' \}, 503\);/.test(api),
    '上り受付が off のときは取り消しも動かない');
}

console.log('');
console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
