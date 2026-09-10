#!/usr/bin/env node
// scripts/verify-ad-hoc-parse.mjs
// 臨時診断バッチ: 分類 (classify.ts) / fingerprint (fingerprint.ts) / 健診 XLSX
// (health-checkup-xlsx.ts) の回帰チェック。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §5.3.8.1 / §6.2 / §7 / §14
//
// **サーバも DB も S3 も要らない。**
//
//   node scripts/verify-ad-hoc-parse.mjs
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const tmp = mkdtempSync(join(repoRoot, '.verify-adhoc-'));
async function loadTs(relPath, outName, rewrite = (s) => s) {
  const src = readFileSync(join(repoRoot, relPath), 'utf8');
  const js = ts.transpileModule(rewrite(src), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const out = join(tmp, outName);
  writeFileSync(out, js);
  return import(pathToFileURL(out).href);
}

const classify = await loadTs('src/lib/ad-hoc-diagnosis/classify.ts', 'classify.js');
const fp = await loadTs('src/lib/ad-hoc-diagnosis/fingerprint.ts', 'fingerprint.js');
const hc = await loadTs('src/lib/ad-hoc-diagnosis/health-checkup-xlsx.ts', 'hc.js', (s) =>
  s.replace(`from './classify'`, `from './classify.js'`),
);

// ===========================================================================
// ① ノイズと人物フォルダ (§7.1-1 / §7.1-2)
// ===========================================================================
ok('noise: Office 一時ファイル', classify.isNoiseEntry('a/~$健診.xlsx'));
ok('noise: __MACOSX', classify.isNoiseEntry('__MACOSX/a/._x.pdf'));
ok('noise: .DS_Store', classify.isNoiseEntry('a/.DS_Store'));
ok('noise: AppleDouble', classify.isNoiseEntry('a/._健診.pdf'));
ok('noise: Thumbs.db', classify.isNoiseEntry('a/Thumbs.db'));
ok('noise: 通常ファイルは noise でない', classify.isNoiseEntry('a/健診.pdf') === false);

eq('root: 共通の先頭を剥がす',
  classify.commonRootPrefix(['X/a/1.pdf', 'X/b/2.pdf', 'X/c.xlsx']), 'X/');
eq('root: 共通でなければ剥がさない',
  classify.commonRootPrefix(['X/a/1.pdf', 'Y/b/2.pdf']), '');
eq('root: 直下にファイルがあれば剥がさない',
  classify.commonRootPrefix(['X/a/1.pdf', 'top.xlsx']), '');

eq('person: 人物フォルダを取れる', classify.personFolderOf('X/人物A/健診.pdf', 'X/'), 'X/人物A');
eq('person: 直下のファイルは人物フォルダ無し', classify.personFolderOf('X/10名の情報.xlsx', 'X/'), null);
eq('person: 深い階層でも人物は第1階層', classify.personFolderOf('X/人物A/検査/健診.pdf', 'X/'), 'X/人物A');

// ===========================================================================
// ② ヘッダー一致 (§7.2 / §7.3)
// ===========================================================================
const hcHeaderRow = ['氏名', '健診日', '身長(cm)', '体重(kg)', 'BMI', '収縮期血圧', '拡張期血圧'];
eq('header: 健診の目印が 6 件当たる',
  classify.countHeaderHits(hcHeaderRow, classify.HEALTH_CHECKUP_HEADERS), 6);
eq('header: 単位つきでも当たる',
  classify.countHeaderHits(['身長 (cm)'], ['身長']), 1);
eq('header: 全角空白を無視する',
  classify.countHeaderHits(['収縮期　血圧'], ['収縮期血圧']), 1);
eq('header: 無関係な行は 0', classify.countHeaderHits(['あ', 'い'], classify.HEALTH_CHECKUP_HEADERS), 0);

const sheetWithTitle = [
  ['株式会社サンプル 健康診断結果', '', ''],
  ['', '', ''],
  hcHeaderRow,
  ['-', '2026-03-29', 170, 65, 22.5, 128, 82],
];
const scan = classify.findHeaderRow(sheetWithTitle, classify.HEALTH_CHECKUP_HEADERS);
eq('header: 1 行目固定にしない (3 行目を掴む)', scan.rowIndex, 2);
eq('header: 一致数', scan.hits, 6);

// ===========================================================================
// ③ 分類 (§7.1)
// ===========================================================================
const cls = (over) => classify.classifyFile({
  path: 'X/人物A/f.pdf', ext: '.pdf', inPersonFolder: true, sheetRows: null, pdfText: null, ...over,
});

eq('classify: ノイズ', cls({ path: 'X/人物A/~$a.xlsx' }).sourceKind, 'ignored');
eq('classify: 人物フォルダ外', cls({ inPersonFolder: false }).sourceKind, 'batch_reference');

eq('classify: 健診 XLSX',
  cls({ ext: '.xlsx', sheetRows: sheetWithTitle }).formatId, 'HealthCheckupData');
eq('classify: 健診 XLSX は confirmed',
  cls({ ext: '.xlsx', sheetRows: sheetWithTitle }).confidence, 'confirmed');

const qSheet = [['既往歴', '喫煙', '飲酒', '運動', '睡眠']];
eq('classify: 問診 XLSX',
  cls({ ext: '.xlsx', sheetRows: qSheet }).formatId, 'LifestyleQuestionnaireData');

// **両方の閾値を満たしたら決めない**
const bothSheet = [[...hcHeaderRow, '既往歴', '喫煙', '飲酒']];
eq('classify: 健診とも問診とも取れる XLSX は決めない',
  cls({ ext: '.xlsx', sheetRows: bothSheet }).confidence, 'needs_review');
eq('classify: 同上 format を付けない',
  cls({ ext: '.xlsx', sheetRows: bothSheet }).formatId, null);

eq('classify: 閾値未満の XLSX', cls({ ext: '.xlsx', sheetRows: [['あ', 'い']] }).confidence, 'needs_review');
eq('classify: 読めない XLSX を拡張子だけで健診にしない',
  cls({ ext: '.xlsx', sheetRows: null }).formatId, null);

// Genoplan
ok('genoplan: 検査キー形式のファイル名', classify.looksLikeGenoplanFilename('X/人物A/AB12-CD34-EF56.pdf'));
ok('genoplan: 形式が違えば false', classify.looksLikeGenoplanFilename('X/人物A/健診結果.pdf') === false);
ok('genoplan: テキストの目印', classify.hasGenoplanMarker('Genoplan Japan Inc.'));
ok('genoplan: 和名の目印', classify.hasGenoplanMarker('ジェノプラン遺伝子検査'));

const gBoth = cls({ path: 'X/人物A/AB12-CD34-EF56.pdf', pdfText: 'Genoplan 検査結果' });
eq('classify: 名前とテキスト両方で confirmed', gBoth.confidence, 'confirmed');
eq('classify: 同上 遺伝子', gBoth.formatId, 'GeneticTestResultData');
eq('classify: 名前だけなら probable',
  cls({ path: 'X/人物A/AB12-CD34-EF56.pdf', pdfText: '無関係' }).confidence, 'probable');
eq('classify: テキストだけなら probable',
  cls({ path: 'X/人物A/report.pdf', pdfText: 'Genoplan' }).confidence, 'probable');

// PDF の語彙
eq('classify: 健診 PDF は probable 止まり',
  cls({ pdfText: '健康診断 身長 体重 血圧 血糖' }).confidence, 'probable');
eq('classify: 同上 format',
  cls({ pdfText: '健康診断 身長 体重 血圧 血糖' }).formatId, 'HealthCheckupData');
eq('classify: 語彙が足りない PDF は needs_review',
  cls({ pdfText: '表紙' }).confidence, 'needs_review');
eq('classify: テキストが取れない PDF は needs_review', cls({ pdfText: null }).confidence, 'needs_review');
eq('classify: 未知の拡張子', cls({ ext: '.csv' }).confidence, 'needs_review');

// ready 判定
ok('ready: 全部 confirmed なら ready',
  classify.subjectIsAutoReady([
    { sourceKind: 'person_file', confidence: 'confirmed' },
    { sourceKind: 'person_file', confidence: 'confirmed' },
  ]));
ok('ready: probable が 1 件でもあれば ready にしない',
  classify.subjectIsAutoReady([
    { sourceKind: 'person_file', confidence: 'confirmed' },
    { sourceKind: 'person_file', confidence: 'probable' },
  ]) === false);
ok('ready: needs_review があれば ready にしない',
  classify.subjectIsAutoReady([{ sourceKind: 'person_file', confidence: 'needs_review' }]) === false);

// 表示名 (§8.1) — **元のファイル名を残さない**
eq('display: 分類つき', classify.displayNameFor('HealthCheckupData', 1, '.xlsx'), '健診_01.xlsx');
eq('display: 未分類', classify.displayNameFor(null, 12, '.pdf'), '未分類_12.pdf');
ok('display: 元の名前を含まない',
  classify.displayNameFor('GeneticTestResultData', 3, '.pdf').includes('AB12') === false);

// ===========================================================================
// ④ fingerprint (§6.2)
// ===========================================================================
const h = (n) => String(n).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'a');
const H1 = 'a'.repeat(64), H2 = 'b'.repeat(64), H3 = 'c'.repeat(64);

const fpA = fp.subjectFingerprint([H1, H2, H3]);
ok('fp: 64 桁 16 進', fp.isSha256Hex(fpA), String(fpA));
eq('fp: 順序に依らない', fp.subjectFingerprint([H3, H1, H2]), fpA);
ok('fp: 集合が違えば別の値', fp.subjectFingerprint([H1, H2]) !== fpA);
eq('fp: 材料が無ければ null', fp.subjectFingerprint([]), null);
eq('fp: 不正な材料しか無ければ null', fp.subjectFingerprint(['xyz', '']), null);
// **重複を畳まない** — 同じ中身が 2 つある人物と 1 つの人物は別物
ok('fp: 重複を畳まない', fp.subjectFingerprint([H1, H1]) !== fp.subjectFingerprint([H1]));

// **氏名やフォルダ名を材料にしていない**ことの機械的な確認。
// ①引数は content ハッシュだけ = 名前を渡す口が無い
eq('fp: 引数は 1 つ (名前を渡す口が無い)', fp.subjectFingerprint.length, 1);
// ②同じファイル集合なら、人物フォルダの名前が何であっても必ず同じ値になる
//   (呼び出し側が名前を混ぜていたら、この 2 つは違う値になる)
eq('fp: 同じ中身 → 同じ fp', fp.subjectFingerprint([H3, H2, H1]), fpA);
// ③材料の 1 つでも違えば別の値 (中身に依存していることの裏返し)
ok('fp: 中身が 1 つ違えば別の値', fp.subjectFingerprint([H1, H2, 'd'.repeat(64)]) !== fpA);

eq('fp: 短縮表示は 8 文字', fp.shortFingerprint(fpA).length, 8);
eq('fp: null は —', fp.shortFingerprint(null), '—');
ok('fp: 短縮に全体を出さない', fp.shortFingerprint(fpA) !== fpA);

// ヒット件数での判定 (§6.2.3)
eq('match: 0 件', fp.matchByFingerprint([]).kind, 'unmatched');
eq('match: 1 件', fp.matchByFingerprint([{ id: 's1', client_id: 'c1' }]).kind, 'match');
eq('match: 1 件は client_id を返す',
  fp.matchByFingerprint([{ id: 's1', client_id: 'c1' }]).clientId, 'c1');
const coll = fp.matchByFingerprint([{ id: 's1', client_id: 'c1' }, { id: 's2', client_id: 'c2' }]);
eq('match: 2 件以上は fp_collision', coll.kind, 'fp_collision');
eq('match: 衝突時は client_id を選ばない', coll.clientId, null);
eq('match: 衝突した subject を全件返す', coll.collided.join(','), 's1,s2');

// ===========================================================================
// ⑤ 健診 XLSX と日付 (§5.3.8.1)
// ===========================================================================
const sheet = hc.buildHealthCheckupSheet([
  ['サンプル健診結果', '', '', '', '', '', ''],
  hcHeaderRow,
  ['-', new Date(Date.UTC(2026, 2, 29)), 170, 65, 22.5, 128, 82],
]);
eq('xlsx: ヘッダー行を見つける', sheet.headerRowIndex, 1);
eq('xlsx: データ行 1 件', sheet.rows.length, 1);
eq('xlsx: 検査日が確定', sheet.testDate.status, 'resolved');
eq('xlsx: 検査日の値', sheet.testDate.date, '2026-03-29');

// **数値のまま来た日付を勝手に日付化しない** (発注者指示)
const serial = hc.buildHealthCheckupSheet([
  hcHeaderRow,
  ['-', 46110, 170, 65, 22.5, 128, 82], // カスタム書式で Date にならなかった想定
]);
eq('xlsx: シリアル値は unresolved', serial.testDate.status, 'unresolved');
eq('xlsx: 理由を残す', serial.testDate.reason, 'excel_serial_number_needs_confirmation');
ok('xlsx: 日付を作っていない', serial.testDate.date === undefined);

eq('date: Date はそのまま', hc.resolveTestDate(new Date(Date.UTC(2025, 0, 23))).date, '2025-01-23');
eq('date: ISO 文字列', hc.resolveTestDate('2026-03-29').date, '2026-03-29');
eq('date: スラッシュ区切り', hc.resolveTestDate('2026/3/29').date, '2026-03-29');
eq('date: 和文表記', hc.resolveTestDate('2026年3月29日').date, '2026-03-29');
eq('date: 空は absent', hc.resolveTestDate(null).status, 'absent');
eq('date: 空文字も absent', hc.resolveTestDate('').status, 'absent');
eq('date: 数値は unresolved', hc.resolveTestDate(45000).status, 'unresolved');
eq('date: 実在しない日は unresolved', hc.resolveTestDate('2026-02-30').status, 'unresolved');
eq('date: 読めない文字列は unresolved', hc.resolveTestDate('先月').status, 'unresolved');
eq('date: 不正な Date は unresolved', hc.resolveTestDate(new Date('x')).status, 'unresolved');
// **タイムゾーンで日がずれない**
eq('date: UTC で読む (日がずれない)', hc.toIsoDate(new Date(Date.UTC(2026, 0, 1, 0, 0, 0))), '2026-01-01');
eq('date: UTC で読む (23時でもずれない)', hc.toIsoDate(new Date(Date.UTC(2026, 0, 1, 23, 59, 59))), '2026-01-01');

// **空欄と 0 を区別する** (未実施に 0 を入れない)
ok('blank: null は空欄', hc.isBlankCell(null));
ok('blank: 空文字は空欄', hc.isBlankCell(''));
ok('blank: 空白だけは空欄', hc.isBlankCell('   '));
ok('blank: 0 は空欄でない', hc.isBlankCell(0) === false);
ok('blank: false は空欄でない', hc.isBlankCell(false) === false);

// 0 だけの行を捨てない
const zeroRow = hc.buildHealthCheckupSheet([hcHeaderRow, ['-', '2026-03-29', 0, 0, 0, 0, 0]]);
eq('xlsx: 0 だけの行を捨てない', zeroRow.rows.length, 1);
// 全部空の行は捨てる
const blankRow = hc.buildHealthCheckupSheet([hcHeaderRow, ['', '', '', '', '', '', ''], ['-', '2026-03-29', 1, 2, 3, 4, 5]]);
eq('xlsx: 全部空の行は捨てる', blankRow.rows.length, 1);

// 検査日の列が無い
const noDate = hc.buildHealthCheckupSheet([['身長', '体重', 'BMI', '収縮期血圧', '拡張期血圧'], [170, 65, 22.5, 128, 82]]);
eq('xlsx: 検査日の列が無い', noDate.testDate.status, 'absent');
ok('xlsx: その旨を記録', noDate.notes.includes('test_date_column_not_found'));

// ヘッダーが見つからない
const noHeader = hc.buildHealthCheckupSheet([['あ', 'い'], ['1', '2']]);
eq('xlsx: ヘッダー無し', noHeader.headerRowIndex, -1);
ok('xlsx: その旨を記録', noHeader.notes.includes('header_row_not_found'));

// ===========================================================================
// ⑥ 実物の .xlsx を組んで `read-excel-file` に通す (§5.3.8.1 の 5 点)
// ===========================================================================
// **バイナリは commit しない** — その場で組む (scripts/lib/make-test-xlsx.mjs)。
// 個人情報は 1 文字も入れない (氏名欄は '-' 固定)。
{
  const { buildXlsx, serial1900, serial1904 } = await import('./lib/make-test-xlsx.mjs');
  const HDR = ['氏名', '健診日', '身長(cm)', '体重(kg)', 'BMI', '収縮期血圧', '拡張期血圧', '整理番号', '空欄テスト'];
  const T = (v) => ({ v, kind: 'text' });
  const N = (v) => ({ v, kind: 'number' });
  const D = (v) => ({ v, kind: 'date' });

  // --- (1) Excel の日付 / (4) 空欄と 0 / (5) 日本語ヘッダー / シート決め打ちしない ---
  const bytes1900 = await buildXlsx({
    withCoverSheet: true, // 1 枚目は表紙 = **シート番号を決め打ちしていたら落ちる**
    headers: HDR,
    rows: [
      [T('-'), D(serial1900(2026, 3, 29)), N(170), N(65), N(22.5), N(128), N(82), N(46110), null],
      [T('-'), D(serial1900(2026, 3, 30)), N(0), N(0), N(0), N(0), N(0), N(1), null],
    ],
  });
  const r1 = await hc.readHealthCheckupXlsx(bytes1900);
  eq('xlsx実物: 検査日が確定した', r1.testDate.status, 'resolved');
  eq('xlsx実物: (1) 日付書式つきセルが Date として返る', r1.testDate.date, '2026-03-29');
  eq('xlsx実物: 表紙でなくデータのシートを選ぶ', r1.notes.some((n) => n === 'sheet=健診結果'), true);
  eq('xlsx実物: (5) 日本語ヘッダーが化けない', r1.headers[1], '健診日');
  eq('xlsx実物: 単位つきヘッダーもそのまま', r1.headers[2], '身長(cm)');
  eq('xlsx実物: データ行 2 件', r1.rows.length, 2);
  // (4) 空欄と 0 の区別
  const row2 = r1.rows[1];
  const height2 = row2.find((c) => c.header === '身長(cm)');
  const blank2 = row2.find((c) => c.header === '空欄テスト');
  eq('xlsx実物: (4) 0 は 0 として返る', height2.value, 0);
  ok('xlsx実物: (4) 0 を空欄扱いしない', hc.isBlankCell(height2.value) === false);
  ok('xlsx実物: (4) 空欄は空欄として返る', hc.isBlankCell(blank2 ? blank2.value : null));
  ok('xlsx実物: 0 だけの行を落としていない', r1.rows.length === 2);
  // **書式の無い数値を日付にしない**
  const seq = r1.rows[0].find((c) => c.header === '整理番号');
  eq('xlsx実物: 書式なしの数値は数値のまま', typeof seq.value, 'number');
  eq('xlsx実物: 同上 日付化していない', hc.resolveTestDate(seq.value).status, 'unresolved');

  // --- (2) カスタム日付書式 ---
  const bytesCustom = await buildXlsx({
    customDateFormat: true, // yyyy"年"m"月"d"日" (numFmtId 176)
    headers: HDR,
    rows: [[T('-'), D(serial1900(2026, 3, 29)), N(170), N(65), N(22.5), N(128), N(82), N(1), null]],
  });
  const rC = await hc.readHealthCheckupXlsx(bytesCustom);
  eq('xlsx実物: (2) ユーザー定義の日付書式も Date として返る', rC.testDate.status, 'resolved');
  eq('xlsx実物: (2) 値が合っている', rC.testDate.date, '2026-03-29');

  // --- (3) 1904 date system ---
  // **同じ日付を 1904 方式のシリアル値で入れる。** ライブラリが date1904 を見ていれば同じ日付になる。
  const bytes1904 = await buildXlsx({
    date1904: true,
    headers: HDR,
    rows: [[T('-'), D(serial1904(2026, 3, 29)), N(170), N(65), N(22.5), N(128), N(82), N(1), null]],
  });
  const r04 = await hc.readHealthCheckupXlsx(bytes1904);
  eq('xlsx実物: (3) 1904 方式でも同じ日付になる', r04.testDate.date, '2026-03-29');

  // **1900 と 1904 でシリアル値が 1462 違う** = 決め打ち変換なら 4 年ずれる、という根拠
  eq('xlsx実物: (3) 1900 と 1904 のシリアル差は 1462',
    serial1900(2026, 3, 29) - serial1904(2026, 3, 29), 1462);
  // 同じシリアル値を両方式で読ませると **4 年ずれる**ことを実測で示す
  const sameSerial = serial1900(2026, 3, 29);
  const bytesDrift = await buildXlsx({
    date1904: true, headers: HDR,
    rows: [[T('-'), D(sameSerial), N(1), N(1), N(1), N(1), N(1), N(1), null]],
  });
  const rDrift = await hc.readHealthCheckupXlsx(bytesDrift);
  ok('xlsx実物: (3) 同じシリアル値を 1904 で読むと約 4 年ずれる',
    rDrift.testDate.status === 'resolved' && rDrift.testDate.date.startsWith('2030'),
    `1904 で ${JSON.stringify(rDrift.testDate)} = **勝手に変換したらこうなる**`);

  // --- 分類も実物で通す (§7.2) ---
  const c1 = classify.classifyFile({
    path: 'X/人物A/健診.xlsx', ext: '.xlsx', inPersonFolder: true,
    sheetRows: [r1.headers], pdfText: null,
  });
  eq('xlsx実物: 分類が健診になる', c1.formatId, 'HealthCheckupData');
  eq('xlsx実物: confirmed', c1.confidence, 'confirmed');
}

// ===========================================================================
rmSync(tmp, { recursive: true, force: true });
const total = pass + failures.length;
if (failures.length) {
  console.error(`\n✗ verify:ad-hoc-parse  ${pass}/${total}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ verify:ad-hoc-parse  ${pass}/${total}`);
