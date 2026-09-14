#!/usr/bin/env node
// scripts/verify-ad-hoc-external-form.mjs
// 臨時診断バッチ: 共通問診 62 列 XLSX (`external_form_xlsx_v1`) の入力契約を固定する。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §7.4
//       + 発注者提示の写像契約 (transcos_questionnaire_62col_mapping_contract_20260914)
//
// **サーバも DB も XLSX の実物も要らない。**
//
// **fixture は合成データだけ。** 実在役員の回答値・氏名・生年月日は 1 つも置かない。
// repo に入れてよいのは**列 schema・値 domain・写像規則**だけ (契約「テストfixture」)。
//
//   node scripts/verify-ad-hoc-external-form.mjs
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
const deepEq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `期待 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const tmp = mkdtempSync(join(repoRoot, '.verify-extform-'));

const rel = (src) => src
  .replace(`from './questionnaire-map'`, `from './questionnaire-map.js'`)
  .replace(`from './health-checkup-xlsx'`, `from './health-checkup-xlsx.js'`)
  .replace(`from './external-form-contract'`, `from './external-form-contract.js'`)
  .replace(`from './classify'`, `from './classify.js'`)
  .replace(`from '../../scripts/chat/interview-script'`, `from './interview-script.js'`);
const writeTs = (relPath, outName) => {
  const js = ts.transpileModule(rel(read(relPath)), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  writeFileSync(join(tmp, outName), js);
};
// 依存の浅い順に**全部書き出してから** import する。
writeTs('src/scripts/chat/interview-script.ts', 'interview-script.js');
writeTs('src/lib/ad-hoc-diagnosis/classify.ts', 'classify.js');
writeTs('src/lib/ad-hoc-diagnosis/health-checkup-xlsx.ts', 'health-checkup-xlsx.js');
writeTs('src/lib/ad-hoc-diagnosis/questionnaire-map.ts', 'questionnaire-map.js');
writeTs('src/lib/ad-hoc-diagnosis/external-form-contract.ts', 'external-form-contract.js');
writeTs('src/lib/ad-hoc-diagnosis/questionnaire.ts', 'questionnaire.js');

const C = await import(pathToFileURL(join(tmp, 'external-form-contract.js')).href);
const Q = await import(pathToFileURL(join(tmp, 'questionnaire.js')).href);
const IS = await import(pathToFileURL(join(tmp, 'interview-script.js')).href);

const COLS = C.EXTERNAL_FORM_V1_COLUMNS;
const HEADERS = COLS.map((c) => c.header);
const at = (n) => n - 1; // 契約の列番号 (1 始まり) → 配列 index

// ===========================================================================
console.log('=== ① 62 列 schema ===');
// ===========================================================================
eq('列数は 62', COLS.length, 62);
deepEq('列番号が 1..62 で連番', COLS.map((c) => c.index), Array.from({ length: 62 }, (_, i) => i + 1));
ok('見出しに重複が無い', new Set(HEADERS).size === 62);

const schemaOk = C.checkExternalFormSchema(HEADERS);
eq('契約どおりなら ok', schemaOk.ok, true);
eq('mismatch 0', schemaOk.mismatches.length, 0);

// **1 文字変えたら検出する** (契約「テストfixture」)。
const oneOff = [...HEADERS];
oneOff[at(10)] = oneOff[at(10)].replace('172', '173');
const bad = C.checkExternalFormSchema(oneOff);
eq('1 文字違えば mismatch', bad.ok, false);
eq('違った列を名指しする', bad.mismatches[0].index, 10);

// 列が 1 本抜けたら (= 以降が全部ずれる) 検出する。
const missing = HEADERS.filter((_, i) => i !== at(20));
eq('列が抜けたら mismatch', C.checkExternalFormSchema(missing).ok, false);
// 列順が入れ替わったら検出する (**値が別の設問へ入るのを防ぐ**)。
const swapped = [...HEADERS];
[swapped[at(18)], swapped[at(22)]] = [swapped[at(22)], swapped[at(18)]];
eq('列順が入れ替われば mismatch', C.checkExternalFormSchema(swapped).ok, false);
// 余計な列が末尾に付いたら検出する。
eq('列が増えても mismatch', C.checkExternalFormSchema([...HEADERS, 'おまけ']).ok, false);

// 互換文字は吸収する (波ダッシュ・全角英数・空白)。
const compat = [...HEADERS];
compat[at(52)] = compat[at(52)].replace('1～10', '1〜10');
eq('波ダッシュの違いは吸収する', C.checkExternalFormSchema(compat).ok, true);
eq('波ダッシュ正規化: ～ → 〜', C.normalizeForm('週4～5回'), '週4〜5回');
eq('波ダッシュ正規化: ~ → 〜', C.normalizeForm('週4~5回'), '週4〜5回');
eq('NFKC: 全角英数', C.normalizeForm('１５０ｇ'), '150g');

// ===========================================================================
console.log('=== ② 列の分類 (mapped / ignored_by_spec / PII) ===');
// ===========================================================================
const byDisp = (d) => COLS.filter((c) => c.disposition === d);
eq('ignored_by_spec は 10 列', byDisp('IGNORED_BY_SPEC').length, 10);
deepEq('ignored_by_spec は 53〜62', byDisp('IGNORED_BY_SPEC').map((c) => c.index),
  [53, 54, 55, 56, 57, 58, 59, 60, 61, 62]);
deepEq('PII は 4/5/7', byDisp('PII_IGNORE').map((c) => c.index), [4, 5, 7]);
eq('生年月日は一時利用', COLS[at(8)].disposition, 'SUBJECT_TRANSIENT');
eq('完了時刻は metadata', COLS[at(3)].disposition, 'METADATA');
eq('設問へ写像する列は 43', byDisp('ANSWER').length, 43);
// **写像先はすべて実在する production 設問**であること (捏造ゼロ)。
for (const c of byDisp('ANSWER')) {
  ok(`question_id が実在: ${c.questionId}`, !!IS.QUESTIONS[c.questionId], `col${c.index}`);
}
// matrix は 9 行そろっている。
const mrows = byDisp('ANSWER').filter((c) => c.rule.kind === 'matrix').map((c) => c.matrixRow);
deepEq('F-FREQ の 9 行がそろう', mrows, IS.QUESTIONS['F-FREQ'].matrix_rows);

// ===========================================================================
console.log('=== ③ EXAM-TYPE は seed (XLSX から推定しない) ===');
// ===========================================================================
deepEq('seed は 2 件', [...C.EXTERNAL_FORM_V1_EXAM_TYPE], ['AI疾病予防のみ', '遺伝子検査（唾液検査）のみ']);
const examLabels = IS.QUESTIONS['EXAM-TYPE'].list_options.map((o) => o.label);
for (const v of C.EXTERNAL_FORM_V1_EXAM_TYPE) {
  ok(`seed 値が production の選択肢に実在: ${v}`, examLabels.includes(v));
}
ok('パッケージ版へ変えていない',
  !C.EXTERNAL_FORM_V1_EXAM_TYPE.includes('ウェルテクト（下記検査の複数パッケージ）'));

// ===========================================================================
console.log('=== ④ 1 行の写像 (合成データ) ===');
// ===========================================================================
/** 合成の 1 行を作る。**実在の人物とは無関係の値だけ。** */
function makeRow(over = {}) {
  const r = new Array(62).fill('');
  r[at(1)] = 'row-1';
  // **`完了時刻` は `Date`** — `read-excel-file` は日付書式のセルを Date で返す
  // (CLAUDE.md の実測)。文字列で来た場合の挙動は下の ⑥ で別に固定する。
  r[at(3)] = new Date(Date.UTC(2026, 4, 20, 10, 0, 0));
  r[at(4)] = 'nobody@example.invalid';
  r[at(5)] = 'テスト 太郎';
  r[at(7)] = 'テスト 太郎';
  r[at(8)] = '19800130';
  r[at(9)] = '男性';
  r[at(10)] = '172';
  r[at(11)] = '65';
  r[at(12)] = '該当するものはない';
  r[at(13)] = '肩こり;腰痛';
  r[at(14)] = 'なし';
  r[at(15)] = 'なし';
  r[at(18)] = '吸ったことはない';
  r[at(19)] = '0';
  r[at(20)] = '0';
  r[at(21)] = '0';
  r[at(22)] = '週2〜3日飲む';
  r[at(24)] = '15';
  r[at(25)] = '1〜2合';
  r[at(26)] = '何でも食べる';
  for (const i of [27, 28, 29, 30, 31, 32, 33, 34, 35]) r[at(i)] = '週2〜3回';
  r[at(36)] = 'コーヒー約2杯';
  r[at(37)] = '150g';
  r[at(38)] = '普通';
  r[at(39)] = '食事制限していない';
  r[at(41)] = '週1〜2日';
  r[at(42)] = '30〜60分';
  r[at(43)] = '速い';
  r[at(44)] = '8';
  r[at(45)] = 'ウォーキング';
  r[at(46)] = 'ない';
  r[at(50)] = '6〜7時間';
  r[at(51)] = '普通';
  r[at(52)] = '5';
  r[at(53)] = '704000056';
  r[at(62)] = '同意する';
  for (const [k, v] of Object.entries(over)) r[at(Number(k))] = v;
  return r;
}

const base = Q.normalizeExternalFormRow(HEADERS, makeRow());
eq('schema は ok', base.schema.ok, true);
eq('要確認 0 件', base.needsReviewCount, 0, JSON.stringify(base.unmapped));
eq('仕様対象外 10 件', base.ignoredBySpec, 10);
eq('性別', base.subject.sex, 'male');
eq('完了時刻', base.completedAt.date, '2026-05-20');
eq('年齢 (完了時刻 基準)', base.subject.age, 46);
eq('身長', base.answers['B-HEIGHT'], '172');
eq('体重', base.answers['B-WEIGHT'], '65');
deepEq('自覚症状 (;分割・2件とも残る)', base.answers['H-SYMPTOMS'], ['肩こり', '腰痛']);
eq('飲酒頻度', base.answers['D-FREQ'], '週2〜3日飲む');
eq('飲酒年数 15 → 10〜20年', base.answers['D-YEARS'], '10〜20年');
eq('座位 8h → 6〜9時間', base.answers['E-SITTING'], '6〜9時間');
eq('カフェイン 約2杯 → 1日1〜2杯', base.answers['F-CAFFEINE'], '1日1〜2杯');
eq('ご飯 150g → 茶碗1杯', base.answers['F-RICE'], '茶碗1杯（約150g）');
eq('ストレス 5', base.answers['SL-STRESS'], 5);
eq('F-FREQ は 9 行', Object.keys(base.answers['F-FREQ']).length, 9);
deepEq('EXAM-TYPE は seed', base.answers['EXAM-TYPE'], ['AI疾病予防のみ', '遺伝子検査（唾液検査）のみ']);
// **PII が answers に 1 つも入っていない。**
const dump = JSON.stringify(base.answers);
for (const bad of ['テスト', '太郎', 'example.invalid', '19800130', '704000056']) {
  ok(`answers に PII / 対象外が出ない: ${bad}`, !dump.includes(bad));
}
eq('喫煙 0 は設問ごと対象外', base.answers['S-COUNT'], undefined);

// ===========================================================================
console.log('=== ⑤ needs_review (寄せない・落とさない・丸めない) ===');
// ===========================================================================
const rev = (over) => Q.normalizeExternalFormRow(HEADERS, makeRow(over));
const detailOf = (n, qid) => (n.unmapped.find((u) => u.header === qid)?.detail ?? '');

// 未知の症状 → その他へ寄せない
const sym = rev({ 13: '肩こり;五十肩' });
ok('未知の症状は needs_review', detailOf(sym, 'H-SYMPTOMS').includes('選択肢に無い値'));
eq('未知が混ざったら設問ごと落とす', sym.answers['H-SYMPTOMS'], undefined);
ok('「その他」へ寄せていない', JSON.stringify(sym.answers).includes('その他') === false);

// 未知の疾患 → その他へ寄せない
const dis = rev({ 14: '高血圧;逆流性食道炎' });
ok('未知の疾患は needs_review', detailOf(dis, 'H-CURRENT').includes('選択肢に無い値'));
eq('既知の高血圧だけ通す、はしない', dis.answers['H-CURRENT'], undefined);
const past = rev({ 15: '未知の病気' });
ok('過去疾患も同じ', detailOf(past, 'H-PAST').includes('選択肢に無い値'));

// E-TYPE 複数回答 → 先頭を採らない
const et = rev({ 45: 'ウォーキング;水泳' });
ok('E-TYPE 複数は needs_review', detailOf(et, 'E-TYPE').includes('単一選択'));
eq('先頭 1 件を採らない', et.answers['E-TYPE'], undefined);
// production 外の運動も推定しない
const et2 = rev({ 45: 'ゴルフ' });
ok('production 外の運動は needs_review', detailOf(et2, 'E-TYPE').includes('選択肢に無い値'));
ok('スポーツへ寄せていない', et2.answers['E-TYPE'] === undefined);

// SL-STRESS
const st11 = rev({ 52: '11' });
ok('SL-STRESS=11 は needs_review', detailOf(st11, 'SL-STRESS').includes('範囲外'));
eq('10 へ clamp しない', st11.answers['SL-STRESS'], undefined);
eq('SL-STRESS=0 も範囲外', rev({ 52: '0' }).answers['SL-STRESS'], undefined);
eq('SL-STRESS=1 は通る', rev({ 52: '1' }).answers['SL-STRESS'], 1);
eq('SL-STRESS=10 は通る', rev({ 52: '10' }).answers['SL-STRESS'], 10);
ok('SL-STRESS=7.5 は needs_review', detailOf(rev({ 52: '7.5' }), 'SL-STRESS') !== '');

// E-SITTING の範囲表現は推定しない
const sit = rev({ 44: '8時間以上' });
ok('「N時間以上」は needs_review', detailOf(sit, 'E-SITTING').includes('数値にできない'));
eq('範囲表現から区間を作らない', sit.answers['E-SITTING'], undefined);

// F-RICE の曖昧表現
const rice = rev({ 37: '茶碗半杯' });
ok('半杯は needs_review', detailOf(rice, 'F-RICE').includes('対応表に無い表現'));
eq('ほとんど食べない へ寄せない', rice.answers['F-RICE'], undefined);
eq('食べない は明示 alias', rev({ 37: '食べない' }).answers['F-RICE'], 'ほとんど食べない');

// F-DIET-METHOD の未知値
const dm = rev({ 40: '野菜中心;16時間断食' });
ok('未知の食事方法は needs_review', detailOf(dm, 'F-DIET-METHOD').includes('選択肢に無い値'));

// カフェインの曖昧表現
ok('数値の無いカフェイン量は needs_review',
  detailOf(rev({ 36: 'たまに飲む' }), 'F-CAFFEINE').includes('杯数・本数が読めない'));
eq('飲まない は通る', rev({ 36: '飲まない' }).answers['F-CAFFEINE'], 'ほとんど摂らない');

// 未知の性別
ok('未知の性別は needs_review', rev({ 9: '回答しない' }).unmapped.some((u) => u.header === '生物学的性別'));
eq('性別は null のまま', rev({ 9: '回答しない' }).subject.sex, null);

// ===========================================================================
console.log('=== ⑥ today fallback が無い ===');
// ===========================================================================
const noDate = rev({ 3: '' });
eq('完了時刻が解決不能なら age=null', noDate.subject.age, null);
ok('completed_at_unresolved が付く', noDate.notes.includes('completed_at_unresolved'));
ok('理由を needs_review に出す', noDate.unmapped.some((u) => u.header === '完了時刻'));
// **今日を基準にしていない**ことを、実年齢との比較で示す。
const todayAge = new Date().getUTCFullYear() - 1980;
ok('今日基準の年齢が入っていない', noDate.subject.age !== todayAge, `todayAge=${todayAge}`);
// 完了時刻が違えば年齢も違う = 基準日が本当に完了時刻であることの証拠。
eq('2026-01-01 基準なら 45 歳', rev({ 3: new Date(Date.UTC(2026, 0, 1)) }).subject.age, 45);
eq('2026-05-20 基準なら 46 歳', rev({ 3: new Date(Date.UTC(2026, 4, 20)) }).subject.age, 46);
// 日付だけの文字列も既存の解決器が採る。
eq('日付文字列 2026/05/20 も解決する', rev({ 3: '2026/05/20' }).subject.age, 46);
/*
 * **日時の文字列は解決しない = 推測しない** (既存 `resolveTestDate` の仕様)。
 * ここで「先頭の日付部分を切り出す」ような補完を足さない。
 * 解決できなければ age=null + needs_review になるだけで、**today では埋めない**。
 */
const dtStr = rev({ 3: '2026/05/20 10:00:00' });
eq('日時文字列は解決しない', dtStr.completedAt.status, 'unresolved');
eq('解決しなければ age=null', dtStr.subject.age, null);
ok('today で埋めない', dtStr.subject.age !== todayAge);
// Excel のシリアル値も推測しない (1900/1904 で約 4 年ずれるため)。
eq('シリアル値は解決しない', rev({ 3: 46163 }).completedAt.status, 'unresolved');
// コードに today fallback が残っていない。
const qsrc = strip(read('src/lib/ad-hoc-diagnosis/questionnaire.ts'));
ok('normalizeExternalFormRow に new Date() の基準日が無い',
  !/const ref\s*=[\s\S]{0,120}new Date\(\)/.test(qsrc));
ok('ageFrom の呼び出しは completedAt 解決時だけ',
  (qsrc.match(/ageFrom\(dob,/g) ?? []).length === 1
  && /completedAt\.status === 'resolved'[\s\S]{0,200}ageFrom\(dob,/.test(qsrc));

// ===========================================================================
console.log('=== ⑦ schema mismatch なら 1 列も読まない ===');
// ===========================================================================
const mm = Q.normalizeExternalFormRow(oneOff, makeRow());
eq('schema mismatch', mm.schema.ok, false);
ok('schema_mismatch を notes に出す', mm.notes.includes('schema_mismatch'));
deepEq('answers は空', mm.answers, {});
eq('写像 0 件', mm.mappedCount, 0);
ok('EXAM-TYPE も入れない (読んでいないので)', mm.answers['EXAM-TYPE'] === undefined);
/*
 * **schema が違うものは納品しない。**
 * 列がずれていれば値が別の設問へ入っている可能性があるので、
 * 「写像 0 件だから納品されない」に頼らず**明示的に止める**。
 */
eq('schema mismatch は納品対象にしない', Q.questionnaireIsUsable(mm), false);
/*
 * 上の 1 件だけでは**この guard が効いていることの証明にならない** —
 * schema mismatch のときは 1 列も読まないので `mappedCount` が 0 で、
 * どのみち false になる (実際、guard を外しても落ちなかった)。
 * なので**写像があるのに schema が違う**という状態を直接作って、
 * `questionnaireIsUsable` の契約そのものを見る。
 */
eq('写像があっても schema が違えば納品しない',
  Q.questionnaireIsUsable({
    ...base,
    mappedCount: 20,
    schema: { ok: false, columnCount: 61, mismatches: [{ index: 10, expected: 'x', actual: 'y' }] },
  }), false);
eq('同じ状態で schema が正なら納品する',
  Q.questionnaireIsUsable({ ...base, mappedCount: 20, schema: { ok: true, columnCount: 62, mismatches: [] } }), true);
// 日付が確定していなければ納品しない (buildElithInterviewJson の today 既定を踏ませない)。
eq('日付が無ければ納品対象にしない', Q.questionnaireIsUsable(noDate), false);
eq('日付と写像がそろえば納品対象', Q.questionnaireIsUsable(base), true);

// ===========================================================================
console.log('=== ⑧ 既存 buildElithInterviewJson だけを使う ===');
// ===========================================================================
const pipeline = strip(read('src/lib/ad-hoc-diagnosis/pipeline.ts'));
ok('pipeline が buildElithInterviewJson を呼ぶ', /buildElithInterviewJson\(/.test(pipeline));
ok('pipeline が LifestyleQuestionnaireData を手で組んでいない',
  !/format_id:\s*'LifestyleQuestionnaireData'/.test(pipeline)
  || /buildElithInterviewJson\(/.test(pipeline));
const contractSrc = strip(read('src/lib/ad-hoc-diagnosis/external-form-contract.ts'));
ok('contract に JSON 組み立てが無い', !/schema_version|format_id/.test(contractSrc));
ok('contract が LLM を呼ばない', !/callGemini|MODELS\.|scanImageToParsed/.test(contractSrc));
ok('adapter が LLM を呼ばない', !/callGemini|MODELS\.|scanImageToParsed/.test(qsrc));
// fuzzy の痕跡が無いこと (部分一致で選択肢を引いていない)。
ok('contract が部分一致で選択肢を引いていない',
  !/\.includes\(t\)|t\.includes\(/.test(contractSrc));

// ===========================================================================
console.log('=== ⑨ 実在の回答データを repo へ置いていない ===');
// ===========================================================================
ok('contract に回答値の実データが無い (見出しと選択肢だけ)',
  !/@[a-z0-9.-]+\.(com|jp|co\.jp)/i.test(contractSrc));

// ===========================================================================
rmSync(tmp, { recursive: true, force: true });
const total = pass + failures.length;
if (failures.length) {
  console.error(`\n✗ verify:ad-hoc-external-form  ${pass}/${total}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\n✓ verify:ad-hoc-external-form  ${pass}/${total}`);
