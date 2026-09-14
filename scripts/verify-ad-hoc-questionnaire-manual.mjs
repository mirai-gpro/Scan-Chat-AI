#!/usr/bin/env node
// scripts/verify-ad-hoc-questionnaire-manual.mjs
// 臨時診断バッチ: 問診 PDF の手動確認入力を固定する。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §7.3 / §7.4 / §18 / §20-Q1
//
// **サーバも DB も要らない。**
//
// ここで固定するのは 3 つ。
//   ① PDF の自動 text parser が**本経路から外れている**
//   ② 手入力が**既存 QUESTIONS に照らして厳密に検証**される (寄せない・切り捨てない)
//   ③ **二重確認が済むまで納品に使われない**
//
// **合成データだけを使う。** 実在役員の問診回答・氏名は repo に入れない (§7.4)。
//
//   node scripts/verify-ad-hoc-questionnaire-manual.mjs
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

/*
 * **理由の文字列は安全に取る。** `r.item.detail` を直に読むと、寄せる実装に退行したとき
 * 「値が通ってしまった」ではなく **TypeError** で落ちる。それだと
 * 「何かが throw した」までしか分からず、何が壊れたか読めない。
 */
const detailOf = (r) => (r && r.status === 'rejected' && r.item ? String(r.item.detail ?? '') : '');

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const tmp = mkdtempSync(join(repoRoot, '.verify-mq-'));


// ===========================================================================
// ① 自動 parser が本経路から外れている (§7.4)
// ===========================================================================
const pipelineSrc = strip(read('src/lib/ad-hoc-diagnosis/pipeline.ts'));
ok('pipeline が normalizeQuestionnairePdf を呼ばない', !pipelineSrc.includes('normalizeQuestionnairePdf('));
ok('pipeline が normalizePdfText を呼ばない', !pipelineSrc.includes('normalizePdfText('));
ok('pipeline は空の入れ物だけ作る', pipelineSrc.includes('manualEntryPlaceholder('));
const serviceSrc = strip(read('src/lib/ad-hoc-diagnosis/service.ts'));
ok('service も自動 parser を呼ばない',
  !serviceSrc.includes('normalizeQuestionnairePdf(') && !serviceSrc.includes('normalizePdfText('));
ok('service は手入力を先に見る', serviceSrc.includes('resolveManualQuestionnaire('));
// **LLM に選択状態を推測させない** (§18)。問診まわりに Gemini 呼び出しが無いこと。
const qSrc = strip(read('src/lib/ad-hoc-diagnosis/questionnaire.ts'));
const mSrc = strip(read('src/lib/ad-hoc-diagnosis/questionnaire-manual.ts'));
for (const [name, src] of [['questionnaire.ts', qSrc], ['questionnaire-manual.ts', mSrc]]) {
  ok(`${name} が LLM を呼ばない`, !/callGemini|scanImageToParsed|MODELS\./.test(src));
}

/*
 * **依存を先に書き出してから import する。** ESM は import した時点で解決するので、
 * 依存より先に importer を読み込むと ERR_MODULE_NOT_FOUND になる (実際になった)。
 */
const rel = (src) => src
  .replace(`from './questionnaire-map'`, `from './questionnaire-map.js'`)
  .replace(`from './health-checkup-xlsx'`, `from './health-checkup-xlsx.js'`)
  .replace(`from './questionnaire'`, `from './questionnaire.js'`)
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
writeTs('src/lib/ad-hoc-diagnosis/questionnaire-manual.ts', 'questionnaire-manual.js');

const q = await import(pathToFileURL(join(tmp, 'questionnaire.js')).href);
const mq = await import(pathToFileURL(join(tmp, 'questionnaire-manual.js')).href);

// 空の入れ物には回答が 1 件も入らない = 空の JSON が作られない。
const ph = q.manualEntryPlaceholder('welltect_common_v1');
eq('入れ物の回答は 0 件', Object.keys(ph.answers).length, 0);
eq('入れ物は納品対象にならない', q.questionnaireIsUsable(ph), false);
ok('入れ物に needs_manual_entry が付く', ph.notes.includes('needs_manual_entry'));

// ===========================================================================
// ② 手入力の検証 (§7.3 / §7.4)
// ===========================================================================
const catalog = mq.questionCatalog();
ok('カタログが既存 QUESTIONS を全部返す', catalog.length > 20, `${catalog.length} 件`);
ok('カタログに id / question / kind がある',
  catalog.every((c) => c.id && c.question && ['text', 'number', 'single', 'multiple'].includes(c.kind)));

const single = catalog.find((c) => c.kind === 'single' && c.options.length > 1);
const multiple = catalog.find((c) => c.kind === 'multiple' && c.options.length > 1);
const text = catalog.find((c) => c.kind === 'text');
ok('検証に使う設問が見つかる', !!single && !!multiple && !!text);

// -- 正しい入力は通る --
const okRes = mq.validateManualEntry({ questionId: single.id, value: single.options[1] });
eq('選択肢どおりなら通る', okRes.status, 'ok');
eq('値はラベルそのもの', okRes.value, single.options[1]);

// -- 知らない設問 / 知らない値は**弾く** (寄せない) --
eq('知らない question_id は弾く',
  mq.validateManualEntry({ questionId: 'NO-SUCH-Q', value: 'x' }).status, 'rejected');
const near = mq.validateManualEntry({ questionId: single.id, value: `${single.options[1]}くらい` });
eq('選択肢に無い値は弾く', near.status, 'rejected');
ok('弾いた理由に値が出る', detailOf(near).includes('選択肢に無い値'), `実際: ${detailOf(near) || '(弾いていない)'}`);
eq('空欄は弾く (未回答を埋めない)',
  mq.validateManualEntry({ questionId: single.id, value: '' }).status, 'rejected');

// -- 複数回答を「最初の 1 件」に落とさない (§7.4 の明示禁止) --
const both = mq.validateManualEntry({ questionId: multiple.id, value: [multiple.options[0], multiple.options[1]] });
eq('複数回答は通る', both.status, 'ok');
deepEq('複数回答が両方残る', both.value, [multiple.options[0], multiple.options[1]]);
const partial = mq.validateManualEntry({ questionId: multiple.id, value: [multiple.options[0], 'ありえない値'] });
eq('1 つでも読めなければ設問ごと弾く', partial.status, 'rejected');
ok('「一部だけ通す」をしない', detailOf(partial).includes('選択肢に無い値'), `実際: ${detailOf(partial) || '(弾いていない)'}`);
// 単一選択に配列が来たら先頭を採らない。
eq('単一選択に配列は弾く',
  mq.validateManualEntry({ questionId: single.id, value: [single.options[0]] }).status, 'rejected');

// -- text / number --
eq('text は通る', mq.validateManualEntry({ questionId: text.id, value: ' 170 ' }).status, 'ok');
eq('text の空欄は弾く', mq.validateManualEntry({ questionId: text.id, value: '   ' }).status, 'rejected');
const numeric = catalog.find((c) => c.kind === 'number');
if (numeric) {
  eq('範囲内の数値は通る',
    mq.validateManualEntry({ questionId: numeric.id, value: numeric.min }).status, 'ok');
  const over = mq.validateManualEntry({ questionId: numeric.id, value: numeric.max + 1 });
  eq('範囲外は弾く (丸めない)', over.status, 'rejected');
  ok('範囲外の理由が出る', detailOf(over).includes('範囲外'), `実際: ${detailOf(over) || '(弾いていない)'}`);
  eq('数値でないものは弾く',
    mq.validateManualEntry({ questionId: numeric.id, value: 'ふつう' }).status, 'rejected');
}

// -- まとめて --
const built = mq.manualQuestionnaire({
  entries: [
    { questionId: single.id, value: single.options[0] },
    { questionId: multiple.id, value: [multiple.options[0]] },
    { questionId: 'NO-SUCH-Q', value: 'x' },
  ],
  completedAt: '2026-03-29',
  sex: '男性',
  age: 54,
});
eq('通った件数', built.normalized.mappedCount, 2);
eq('弾いた件数', built.rejected.length, 1);
eq('性別は読める', built.normalized.subject.sex, 'male');
eq('年齢は読める', built.normalized.subject.age, 54);
eq('日付は読める', built.normalized.completedAt.date, '2026-03-29');
ok('手入力の目印が付く', built.normalized.notes.includes('manual_entry'));
eq('納品対象になる', q.questionnaireIsUsable(built.normalized), true);

// **同じ設問を 2 回入れたら後勝ちにしない** (どちらが正か決められない)。
const dup = mq.manualQuestionnaire({
  entries: [
    { questionId: single.id, value: single.options[0] },
    { questionId: single.id, value: single.options[1] },
  ],
});
eq('重複入力は 1 件だけ通る', dup.normalized.mappedCount, 1);
eq('重複は採用せず弾く', dup.rejected.length, 1);
eq('先に入れた方が残る', dup.normalized.answers[single.id], single.options[0]);

// **日付を today で埋めない** (§6.4)。
const noDate = mq.manualQuestionnaire({ entries: [{ questionId: single.id, value: single.options[0] }] });
eq('日付を渡さなければ未確定', noDate.normalized.completedAt.status, 'unresolved');
ok('未確定が notes に出る', noDate.normalized.notes.includes('completed_at_unresolved'));
// 1 件も通らなければ空の JSON を作らせない。
const empty = mq.manualQuestionnaire({ entries: [{ questionId: 'NO-SUCH-Q', value: 'x' }] });
eq('0 件なら納品対象にしない', q.questionnaireIsUsable(empty.normalized), false);

// ===========================================================================
// ③ 二重確認 (§7.4)
// ===========================================================================
const base = {
  kind: 'manual_questionnaire', entries: [{ questionId: single.id, value: single.options[0] }],
  completedAt: '2026-03-29', sex: null, age: null,
  enteredBy: 'a***', enteredAt: '2026-03-29T00:00:00Z', confirmedBy: null, confirmedAt: null,
};
eq('record を見分けられる', mq.isManualQuestionnaireRecord(base), true);
eq('別の形は見分けない', mq.isManualQuestionnaireRecord({ kind: 'other' }), false);
eq('入力しただけでは使わない', mq.manualRecordIsConfirmed(base), false);
eq('確認が付けば使う', mq.manualRecordIsConfirmed({ ...base, confirmedBy: 'b***' }), true);
eq('確認済みでも中身が空なら使わない',
  mq.manualRecordIsConfirmed({ ...base, entries: [], confirmedBy: 'b***' }), false);

// service 側: 確認済みでなければ納品材料にしない / 入力を差し替えたら確認が外れる。
const svcRaw = read('src/lib/ad-hoc-diagnosis/service.ts');
ok('確認済みでなければ材料にしない', /if \(!manualRecordIsConfirmed\(rec\)\) return null;/.test(svcRaw));
ok('入力を差し替えたら確認が外れる',
  /confirmedBy: input\.confirm === true \? actorMask : null/.test(svcRaw));
ok('手入力待ちを別の理由で出す', /questionnaire_needs_manual_entry/.test(svcRaw));
ok('保存は既存の pages を使う (新テーブルを作らない)',
  /MANUAL_QUESTIONNAIRE_PAGE_NO/.test(svcRaw) && !/create table/i.test(svcRaw));
ok('回答の中身をログに出さない',
  /detail: \{\s*kind: 'manual_questionnaire',\s*accepted:/.test(svcRaw));
ok('event 名は既存のものを使う (DDL を増やさない)',
  /event: input\.confirm === true \? 'confirmed' : 'parsed'/.test(svcRaw));

// ===========================================================================
rmSync(tmp, { recursive: true, force: true });
const total = pass + failures.length;
if (failures.length) {
  console.error(`\n✗ verify:ad-hoc-questionnaire-manual  ${pass}/${total}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ verify:ad-hoc-questionnaire-manual  ${pass}/${total}`);
