#!/usr/bin/env node
/**
 * 原本の S3 直アップロード (`originals-upload-ticket.ts`) の検査。
 *
 * **ここは静かに壊れる。** 署名付き URL はそれ自体が原本バケットへの書き込み権限なので、
 * キーの検査が緩んでも画面は正常に見える。目視では守れないので機械で固定する。
 *
 * 鍵は不要 (純粋関数と fail-closed の確認だけ)。S3 へは接続しない。
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const out = 'node_modules/.cache/verify-originals-upload.mjs';
execSync(
  // `--packages=external`: AWS SDK は node にそのまま解決させる。
  // 束ねると SDK 内部の `require('buffer')` が ESM 出力で動かない。
  `npx esbuild src/lib/originals-upload-ticket.ts --bundle --packages=external --platform=node --format=esm --log-level=error "--define:import.meta.env={}" --outfile=${out}`,
  { stdio: 'inherit' },
);
const m = await import(`../${out}`);

/** 空バイト列の SHA-256 (base64)。値は何でもよいので固定値を使う。 */
const SHA_B64 = '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';

let pass = 0;
const fails = [];
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  — ' + extra : ''}`); }
  else { fails.push(label); console.log(`FAIL  ${label}${extra ? '  — ' + extra : ''}`); }
};

// ── ① ファイル名の無害化 ─────────────────────────────────────────
console.log('\n① ブラウザ由来のファイル名');
ok(m.safeBaseName('遺伝子結果.pdf') === '遺伝子結果.pdf', '通す: 日本語の PDF');
ok(m.safeBaseName('a.csv') === 'a.csv', '通す: CSV');
ok(m.safeBaseName('dir/sub/x.pdf') === 'x.pdf', 'ディレクトリを剥がす');
ok(m.safeBaseName('C:\\tmp\\x.pdf') === 'x.pdf', 'Windows の区切りも剥がす');
ok(m.safeBaseName('../../etc/passwd.pdf') === 'passwd.pdf', '相対パスで外へ出させない');
ok(m.safeBaseName('..pdf') === null, '弾く: 先頭ドットだけ残る形');
ok(m.safeBaseName('a..b.pdf') === null, '弾く: 途中の ..');
ok(m.safeBaseName('x.exe') === null, '弾く: 許可外の拡張子');
ok(m.safeBaseName('x.PDF') === 'x.PDF', '大文字拡張子は通す');
ok(m.safeBaseName('noext') === null, '弾く: 拡張子なし');
ok(m.safeBaseName('a\u0000b.pdf') === 'ab.pdf', '制御文字を落とす');
ok(m.safeBaseName('x'.repeat(200) + '.pdf') === null, '弾く: 長すぎる名前');
ok(m.safeBaseName(12345) === null, '弾く: 文字列でない');

// ── ② キーの検査 ────────────────────────────────────────────────
console.log('\n② 署名してよいキーか');
const good = 'lab_results/genoplan/2026/09/本田.pdf';
ok(m.isOriginalUploadKey(good), '通す: 規則どおり', good);
ok(m.isOriginalUploadKey('lab_results/rieger/2024/01/a.csv'), '通す: CSV');
ok(!m.isOriginalUploadKey('lab_results/unknown/2026/09/a.pdf'), '弾く: 知らない検査会社');
ok(!m.isOriginalUploadKey('lab_results/genoplan/2026/13/a.pdf'), '弾く: 月が 13');
ok(!m.isOriginalUploadKey('lab_results/genoplan/2026/00/a.pdf'), '弾く: 月が 00');
ok(!m.isOriginalUploadKey('lab_results/genoplan/2026/9/a.pdf'), '弾く: 月がゼロ埋めなし');
ok(!m.isOriginalUploadKey('/lab_results/genoplan/2026/09/a.pdf'), '弾く: 先頭スラッシュ');
ok(!m.isOriginalUploadKey('lab_results/genoplan/2026/09//a.pdf'), '弾く: 二重スラッシュ');
ok(!m.isOriginalUploadKey('lab_results/genoplan/../../a.pdf'), '弾く: 相対パス');
ok(!m.isOriginalUploadKey('lab_results/genoplan/2026/09/a/b.pdf'), '弾く: 階層が深い');
ok(!m.isOriginalUploadKey('other/genoplan/2026/09/a.pdf'), '弾く: 別のルート');
ok(!m.isOriginalUploadKey('lab_results/genoplan/2026/09/a.json'), '弾く: JSON を書かせない');
ok(!m.isOriginalUploadKey(''), '弾く: 空');
ok(!m.isOriginalUploadKey(null), '弾く: null');

// ── ③ キーの組み立てが規則どおりか (upload.ts と同じ形) ──────────
console.log('\n③ 保存キーの規則');
const k = m.buildOriginalKey('genoplan', 'x.pdf', new Date(Date.UTC(2026, 8, 5)));
ok(/^lab_results\/genoplan\/\d{4}\/\d{2}\/x\.pdf$/.test(k), 'lab_results/<company>/YYYY/MM/<filename>', k);
ok(m.isOriginalUploadKey(k), '組んだキーが検査を通る');
ok(m.contentTypeOf('a.pdf') === 'application/pdf', 'PDF の Content-Type');
ok(m.contentTypeOf('a.csv') === 'text/csv', 'CSV の Content-Type');
ok(m.contentTypeOf('a.exe') === null, '許可外は null');

// ── ④ 設定と入力の fail-closed ──────────────────────────────────
// **S3 未設定のままだと入力検査まで到達しない**ので、2 段に分けて見る。
console.log('\n④-1 S3 未設定なら署名しない');
{
  const r = await m.createOriginalUploadTicket({ company: 'genoplan', fileName: 'a.pdf', bytes: 100, sha256Base64: SHA_B64 });
  ok(r.ok === false && r.error === 'originals_s3_not_configured', '設定が無ければ発行しない', r.error ?? '');
}

// 署名は**ローカル計算だけ**で完結する (通信しない) ので、ダミー設定で実際に出させる。
console.log('\n④-2 署名の発行 (ダミー設定)');
process.env.AWS_REGION = 'ap-northeast-1';
process.env.AWS_S3_ORIGINALS_BUCKET = 'wellfort-diagnosis-test';
process.env.AWS_S3_ORIGINALS_PREFIX = 'raw/';
process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

for (const [label, input, expect] of [
  ['弾く: 検査会社が不正', { company: 'nope', fileName: 'a.pdf', bytes: 100, sha256Base64: SHA_B64 }, 'invalid_company'],
  ['弾く: ファイル名がパス', { company: 'genoplan', fileName: '../../x.exe', bytes: 100, sha256Base64: SHA_B64 }, 'invalid_file_name'],
  ['弾く: サイズ 0', { company: 'genoplan', fileName: 'a.pdf', bytes: 0, sha256Base64: SHA_B64 }, 'invalid_size'],
  ['弾く: サイズが文字列', { company: 'genoplan', fileName: 'a.pdf', bytes: '100', sha256Base64: SHA_B64 }, 'invalid_size'],
  ['弾く: checksum が無い (Object Lock が 400 にする)', { company: 'genoplan', fileName: 'a.pdf', bytes: 100 }, 'invalid_sha256'],
  ['弾く: checksum が base64 でない', { company: 'genoplan', fileName: 'a.pdf', bytes: 100, sha256Base64: 'zzz' }, 'invalid_sha256'],
  ['弾く: 上限超え (20MB+1)', { company: 'genoplan', fileName: 'a.pdf', bytes: m.MAX_ORIGINAL_BYTES + 1, sha256Base64: SHA_B64 }, 'too_large'],
]) {
  const r = await m.createOriginalUploadTicket(input);
  ok(r.ok === false && r.error === expect, label, r.error ?? '');
}

{
  // 8.3 MB の遺伝子 PDF = 今回 413 で落ちていたサイズ。
  const r = await m.createOriginalUploadTicket({ company: 'genoplan', fileName: '遺伝子結果.pdf', bytes: 8_300_000, sha256Base64: SHA_B64 });
  ok(r.ok === true, '通す: 8.3 MB の PDF (Vercel を通らないので上限に当たらない)');
  if (r.ok) {
    const u = new URL(r.url);
    ok(u.pathname.includes('raw/lab_results/genoplan/'), 'URL のキーに prefix と規則が入る', decodeURIComponent(u.pathname));
    ok(r.storageUrl.startsWith('s3://wellfort-diagnosis-test/raw/lab_results/genoplan/'),
      'storage_url は putOriginal と同じ形', r.storageUrl);
    ok(r.headers['content-type'] === 'application/pdf', 'PUT に付ける Content-Type を返す');
    ok(/content-type/i.test(u.searchParams.get('X-Amz-SignedHeaders') ?? ''),
      'Content-Type を署名に固定している', u.searchParams.get('X-Amz-SignedHeaders') ?? '');
    ok(Number(u.searchParams.get('X-Amz-Expires')) === m.PRESIGN_EXPIRES_SEC, '期限 15 分');
    /*
     * **checksum を URL に載せない。** 既定のままだと SDK が空ボディの CRC32 を
     * 署名に含め、実ファイルを PUT した瞬間に S3 が拒否する
     * (`requestChecksumCalculation: 'WHEN_REQUIRED'` が要る)。
     */
    const chk = [...u.searchParams.keys()].filter((k) => /checksum/i.test(k));
    ok(chk.length === 0, 'checksum を**クエリ**に載せない (空ボディ CRC32 の罠)', chk.join(',') || 'なし');
    /*
     * **Object Lock バケットは checksum が要る。** 保持対象への PutObject は
     * Content-MD5 か checksum ヘッダが必須で、無いと 400 (実障害 2026-09-29)。
     * `unhoistableHeaders` を付けないと SDK が署名から落とすので、実測で固定する。
     */
    const sh = u.searchParams.get('X-Amz-SignedHeaders') ?? '';
    ok(/x-amz-checksum-sha256/.test(sh), 'checksum を**署名**に載せる (Object Lock の必須要件)', sh);
    ok(/x-amz-sdk-checksum-algorithm/.test(sh), 'checksum アルゴリズムも署名に載せる', '');
    ok(r.headers['x-amz-checksum-sha256'] && r.headers['x-amz-sdk-checksum-algorithm'] === 'SHA256',
      'PUT に付けるヘッダとして返す', Object.keys(r.headers).join(', '));
    // **署名した集合と返す集合が一致すること** (ブラウザは完全一致で送る必要がある)。
    const signedSet = sh.split(';').filter((h) => h !== 'host' && h !== 'content-length').sort().join(',');
    ok(Object.keys(r.headers).sort().join(',') === signedSet, '返すヘッダ = 署名したヘッダ (完全一致)', signedSet);
  }
}
ok(m.MAX_ORIGINAL_BYTES === 20 * 1024 * 1024, '上限は 20 MB (UI の名乗りと一致)');

// ── ⑤ 口に認可が付いているか ────────────────────────────────────
// `upload.ts` は認可が無いまま残っているので、**新しい口で同じ穴を開けない**ことを固定する。
console.log('\n⑤ admin 認可');
for (const f of ['src/pages/api/admin/lab-results/upload-ticket.ts', 'src/pages/api/admin/lab-results/register.ts']) {
  const src = readFileSync(f, 'utf8');
  ok(/isAdminAuthorized\(request\)/.test(src) && /401/.test(src), `${f.split('/').pop()} が Bearer を要求する`);
}
// 登録はブラウザ申告の sha256 / size を使わない (実体から算出する)。
const reg = readFileSync('src/pages/api/admin/lab-results/register.ts', 'utf8');
ok(/readUploadedOriginal\(key\)/.test(reg), 'register は S3 の実体を読み直す');
ok(!/body\.sha256|body\.size_bytes/.test(reg), 'register はブラウザ申告の sha256 / size を使わない');
ok(/raw_pdf/.test(reg) && !/raw_pdf_redacted/.test(reg.replace(/^.*redacted.*$/gm, (l) => (l.trim().startsWith('*') || l.trim().startsWith('//') ? '' : l))),
  'PDF は raw_pdf で登録する (redaction 未実装)');

// ── ⑥ Astro の checkOrigin に当たらないか ──────────────────────────
// astro 5.18.2 `core/app/middlewares.js` の判定:
//   非安全メソッド かつ ①content-type が form 系で別オリジン、
//   または ②**content-type が無い**で別オリジン → 403。
// `application/json` は form 系でないので通る。**新しい口が form を受けないこと**を固定する
// (multipart に戻すと別オリジンからの 403 が再発する)。
console.log('\n⑥ checkOrigin (Astro 5.x)');
const FORM_CT = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];
for (const f of ['src/pages/api/admin/lab-results/upload-ticket.ts', 'src/pages/api/admin/lab-results/register.ts']) {
  const src = readFileSync(f, 'utf8');
  const n = f.split('/').pop();
  ok(/await request\.json\(\)/.test(src), `${n} は JSON で受ける`);
  ok(!/request\.formData\(\)/.test(src), `${n} は formData を受けない`);
  ok(!FORM_CT.some((ct) => src.includes(ct)), `${n} は form 系 content-type を扱わない`);
}
{
  // 実物の middleware を読んで、判定の前提が変わっていないかを見る。
  const mw = 'node_modules/astro/dist/core/app/middlewares.js';
  let src = '';
  try { src = readFileSync(mw, 'utf8'); } catch { /* 依存未取得 */ }
  if (src) {
    ok(FORM_CT.every((ct) => src.includes(ct)), 'form 系 3 種の判定が Astro 側にある');
    ok(!src.includes('application/json'), 'Astro は application/json を form 扱いしない');
  } else {
    console.log('SKIP  astro の middleware を読めませんでした');
  }
}

// ── ⑦ 既存 artifact に足す口であること (発注者指示 2026-09-29) ──────────
// 本田さんの遺伝子 / AI疾病予測は既存行があり、**display_mode='three_mode' を壊せない**。
// 「見つからなければ勝手に作る」に戻ると静かに二重登録が起きるので固定する。
console.log('\n⑦ 既存 artifact への紐付け');
{
  const reg = readFileSync('src/pages/api/admin/lab-results/register.ts', 'utf8');
  ok(/allow_create/.test(reg) && /allowCreate\s*=\s*body\.allow_create === true/.test(reg),
    '新規作成は allow_create を明示したときだけ');
  ok(/error: 'artifact_not_found'/.test(reg), '見つからなければ止める (artifact_not_found)');
  ok(/error: 'artifact_ambiguous'/.test(reg) && /candidates/.test(reg),
    '複数あれば止めて候補を返す (機械で選ばない)');
  ok(/error: 'artifact_user_mismatch'/.test(reg), '別人の artifact には付けない');
  ok(/error: 'artifact_type_mismatch'/.test(reg), '種別違いには付けない');
  ok(/error: 'file_exists'/.test(reg) && /replace/.test(reg), '同種別が既にあれば止める (replace で差し替え)');
  ok(/already_registered/.test(reg), '同じ内容なら何もしない (再実行で増えない)');
  // **test_artifacts を更新しない** = display_mode / test_date を触らない。
  const updatesArtifacts = /from\('test_artifacts'\)[\s\S]{0,200}?\.update\(/.test(reg);
  ok(!updatesArtifacts, 'test_artifacts を UPDATE しない (three_mode を保つ)');
  // 差し替えで消すのは台帳だけ。S3 のオブジェクトは消さない (10 年保管)。
  ok(!/DeleteObjectCommand/.test(reg), 'S3 のオブジェクトは消さない');
  ok(/from\('test_artifact_files'\)[\s\S]{0,120}?\.delete\(\)/.test(reg), '差し替えは台帳の行だけ消す');
}

console.log(`\n${pass} / ${pass + fails.length} passed`);
if (fails.length) { console.error('\n落ちた検査:\n  - ' + fails.join('\n  - ')); process.exit(1); }
