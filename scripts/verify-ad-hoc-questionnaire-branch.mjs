#!/usr/bin/env node
// scripts/verify-ad-hoc-questionnaire-branch.mjs
// 臨時診断バッチ: 問診の **Phase B (production 分岐の適用) と納品ゲート**を固定する。
// 正本: 最終指示書 §3.2 / §4 / §5 / §12
//
// **サーバも DB も要らない。**
//
// ここで固定するのは 3 つ。
//   ① production で質問されない設問が**最終 answers に残らない** (§3.2)
//   ② 非該当なのに実質的な値が入っていたら**黙って捨てず needs_review** (§3.2)
//   ③ **要確認が 1 件でも残れば納品しない** (§4)。手入力の確定で解消する (§5.2)
//
// **合成データだけを使う。** 実在役員の問診回答・氏名は repo に入れない。
//
//   node scripts/verify-ad-hoc-questionnaire-branch.mjs
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
const tmp = mkdtempSync(join(repoRoot, '.verify-qb-'));

// ===========================================================================
// ⓪ production の分岐を**共用**している (独自 when をコピーしていない・§3.2)
// ===========================================================================
const branchRaw = read('src/lib/ad-hoc-diagnosis/questionnaire-branch.ts');
const branchSrc = strip(branchRaw);
ok('production の resolvePath を import している',
  /import \{[\s\S]*?resolvePath[\s\S]*?\} from '\.\.\/\.\.\/scripts\/chat\/interview-script'/.test(branchSrc));
ok('resolvePath を実際に呼んでいる', /resolvePath\(/.test(branchSrc.replace(/resolvePath,/g, '')));
/*
 * **独自 when ロジックを書いていない。** production の条件式 (`a['S-STATUS'] === …` 等) を
 * ここへ書き写すと、問診票を直したときに 2 か所へ反映することになり必ず片方が腐る。
 */
ok('分岐条件を書き写していない',
  !/\['S-STATUS'\]|\['D-FREQ'\]|\['E-FREQ'\]|\['M-HAS'\]|\['H-CURRENT'\]/.test(branchSrc),
  '設問 id を直接見て分岐している箇所がある');
ok('LLM を呼ばない', !/callGemini|scanImageToParsed|MODELS\./.test(branchSrc));

// 依存を浅い順に書き出してから import する (ESM は import 時点で解決する)。
const rel = (src) => src
  .replace(`from './questionnaire-map'`, `from './questionnaire-map.js'`)
  .replace(`from './health-checkup-xlsx'`, `from './health-checkup-xlsx.js'`)
  .replace(`from './questionnaire'`, `from './questionnaire.js'`)
  .replace(`from './questionnaire-manual'`, `from './questionnaire-manual.js'`)
  .replace(`from './external-form-contract'`, `from './external-form-contract.js'`)
  .replace(`from './classify'`, `from './classify.js'`)
  .replace(`from '../../scripts/chat/interview-script'`, `from './interview-script.js'`);

const writeTs = (relPath, outName) => {
  const js = ts.transpileModule(rel(read(relPath)), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  writeFileSync(join(tmp, outName), js);
};
writeTs('src/scripts/chat/interview-script.ts', 'interview-script.js');
writeTs('src/lib/ad-hoc-diagnosis/classify.ts', 'classify.js');
writeTs('src/lib/ad-hoc-diagnosis/health-checkup-xlsx.ts', 'health-checkup-xlsx.js');
writeTs('src/lib/ad-hoc-diagnosis/questionnaire-map.ts', 'questionnaire-map.js');
writeTs('src/lib/ad-hoc-diagnosis/external-form-contract.ts', 'external-form-contract.js');
writeTs('src/lib/ad-hoc-diagnosis/questionnaire.ts', 'questionnaire.js');
writeTs('src/lib/ad-hoc-diagnosis/questionnaire-manual.ts', 'questionnaire-manual.js');
writeTs('src/lib/ad-hoc-diagnosis/questionnaire-branch.ts', 'questionnaire-branch.js');
writeTs('src/lib/ad-hoc-diagnosis/normalized-payload.ts', 'normalized-payload.js');

const q = await import(pathToFileURL(join(tmp, 'questionnaire.js')).href);
const br = await import(pathToFileURL(join(tmp, 'questionnaire-branch.js')).href);
const np = await import(pathToFileURL(join(tmp, 'normalized-payload.js')).href);

const apply = (answers, pending = []) => br.applyProductionBranches(answers, pending);

// ===========================================================================
// ① 分岐で落ちる (§12 branch)
// ===========================================================================

// -- 運動: E-FREQ=ほとんどしない なら E-TIME / E-TYPE は production では質問しない --
{
  const r = apply({ 'E-FREQ': 'ほとんどしない', 'E-TIME': '30〜60分', 'E-TYPE': 'ウォーキング' });
  ok('E-TIME が最終 answers に無い', r.answers['E-TIME'] === undefined);
  ok('E-TYPE が最終 answers に無い', r.answers['E-TYPE'] === undefined);
  eq('E-FREQ 自身は残る', r.answers['E-FREQ'], 'ほとんどしない');
  deepEq('運動は値があっても branch ignore', r.ignoredByBranch.sort(), ['E-TIME', 'E-TYPE']);
  eq('運動は矛盾にしない (§3.2 の明示例)', r.contradictions.length, 0);
}
{
  // 運動している人では残る (分岐を一律に落としていない)。
  const r = apply({ 'E-FREQ': '週3〜4日', 'E-TIME': '30〜60分', 'E-TYPE': 'ウォーキング' });
  eq('運動している人の E-TIME は残る', r.answers['E-TIME'], '30〜60分');
  eq('運動している人の E-TYPE は残る', r.answers['E-TYPE'], 'ウォーキング');
  eq('落とすものが無い', r.ignoredByBranch.length, 0);
}

// -- 服薬: 「ない」+「なし」は branch ignore / 「ない」+ 実薬名は矛盾 --
{
  const r = apply({ 'M-HAS': 'ない', 'M-NAME': 'なし' });
  ok('M-NAME は最終 answers に無い', r.answers['M-NAME'] === undefined);
  deepEq('「なし」は通常の branch ignore', r.ignoredByBranch, ['M-NAME']);
  eq('「なし」は矛盾にしない', r.contradictions.length, 0);
}
{
  const r = apply({ 'M-HAS': 'ない', 'M-NAME': '摂取していない' });
  deepEq('「摂取していない」も branch ignore', r.ignoredByBranch, ['M-NAME']);
  eq('「摂取していない」は矛盾にしない', r.contradictions.length, 0);
}
{
  const r = apply({ 'M-HAS': 'ない', 'M-NAME': 'ロキソニン（頭痛）', 'M-PERIOD': '1年以上' });
  ok('薬情報は answers へ入れない', r.answers['M-NAME'] === undefined);
  deepEq('薬情報は黙って捨てず矛盾にする', r.contradictions.sort(), ['M-NAME', 'M-PERIOD']);
  eq('矛盾は branch ignore に数えない', r.ignoredByBranch.length, 0);
}
{
  // 服薬ありなら普通に残る。
  const r = apply({ 'M-HAS': 'ある', 'M-NAME': 'ロキソニン（頭痛）', 'M-FREQ': '毎日' });
  eq('服薬ありなら薬名が残る', r.answers['M-NAME'], 'ロキソニン（頭痛）');
  eq('服薬ありなら頻度が残る', r.answers['M-FREQ'], '毎日');
}

// -- 喫煙: 非喫煙 + 0/空 は branch ignore / 非喫煙 + 本数は矛盾 --
{
  const r = apply({ 'S-STATUS': '吸ったことはない', 'S-COUNT': '0', 'S-YEARS': '' });
  eq('非喫煙の 0 は矛盾にしない', r.contradictions.length, 0);
  ok('S-COUNT は answers に無い', r.answers['S-COUNT'] === undefined);
}
{
  const r = apply({ 'S-STATUS': '吸ったことはない', 'S-COUNT': '11〜20本' });
  deepEq('非喫煙なのに本数があれば矛盾', r.contradictions, ['S-COUNT']);
  ok('本数は answers に入らない', r.answers['S-COUNT'] === undefined);
}
{
  const r = apply({ 'S-STATUS': '現在吸っている', 'S-COUNT': '11〜20本', 'S-YEARS': '20〜30年' });
  eq('喫煙者の本数は残る', r.answers['S-COUNT'], '11〜20本');
  eq('喫煙者の年数は残る', r.answers['S-YEARS'], '20〜30年');
  // 禁煙していない人に「止めた年齢」は聞かない。
  const r2 = apply({ 'S-STATUS': '現在吸っている', 'S-QUIT-AGE': '40〜49歳' });
  deepEq('現喫煙者の「止めた年齢」は矛盾', r2.contradictions, ['S-QUIT-AGE']);
}

// -- 飲酒 --
{
  const r = apply({ 'D-FREQ': '元々まったく飲まない', 'D-AMOUNT': '1〜2合', 'D-YEARS': 'なし' });
  deepEq('非飲酒なのに飲酒量があれば矛盾', r.contradictions, ['D-AMOUNT']);
  deepEq('「なし」は branch ignore', r.ignoredByBranch, ['D-YEARS']);
}
{
  const r = apply({ 'D-FREQ': '毎日飲む', 'D-AMOUNT': '1〜2合', 'D-YEARS': '20〜30年' });
  eq('飲酒者の量は残る', r.answers['D-AMOUNT'], '1〜2合');
  eq('飲酒者の年数は残る', r.answers['D-YEARS'], '20〜30年');
}

// -- 既往・現病歴 --
{
  const r = apply({ 'H-CURRENT': ['なし'], 'H-TREAT-STATUS': '治療中' });
  deepEq('現病歴なしなのに治療中は矛盾', r.contradictions, ['H-TREAT-STATUS']);
}
{
  const r = apply({ 'H-CURRENT': ['高血圧'], 'H-TREAT-STATUS': '治療中' });
  eq('現病歴があれば治療状況は残る', r.answers['H-TREAT-STATUS'], '治療中');
}

// -- Phase A の要確認も分岐で絞る --
{
  const r = apply({ 'E-FREQ': 'ほとんどしない' }, ['E-TYPE']);
  eq('質問されない設問の要確認は人へ渡さない', r.reviewQuestionIds.length, 0);
  deepEq('落としたことは監査に残る', r.ignoredByBranch, ['E-TYPE']);
}
{
  const r = apply({ 'E-FREQ': '週1〜2日' }, ['E-TYPE']);
  deepEq('質問される設問の要確認は残る', r.reviewQuestionIds, ['E-TYPE']);
}
{
  const r = apply({ 'M-HAS': 'ない' }, ['M-NAME']);
  deepEq('服薬なしでも読めない薬情報は人へ渡す', r.reviewQuestionIds, ['M-NAME']);
}

// -- 「非該当」の判定そのもの --
eq('空文字は非該当', br.isBenignInactiveValue(''), true);
eq('0 は非該当', br.isBenignInactiveValue(0), true);
eq('「なし」は非該当', br.isBenignInactiveValue('なし'), true);
eq('空配列は非該当', br.isBenignInactiveValue([]), true);
eq('実質的な値は非該当でない', br.isBenignInactiveValue('ロキソニン'), false);
eq('数値の 5 は非該当でない', br.isBenignInactiveValue(5), false);

// ===========================================================================
// ② 62 列の実経路で分岐が効く (Phase A → Phase B)
// ===========================================================================
const contract = await import(pathToFileURL(join(tmp, 'external-form-contract.js')).href);
const HEADERS = contract.EXTERNAL_FORM_V1_COLUMNS.map((c) => c.header);
/** 合成データ。**実在役員の回答は 1 件も入っていない。** */
const blankRow = () => new Array(HEADERS.length).fill('');
const put = (row, index, value) => { row[index - 1] = value; return row; };

const DONE_AT = new Date(Date.UTC(2026, 6, 12, 7, 5, 45)); // read-excel-file は Date を返す

function buildRow(overrides) {
  const row = blankRow();
  put(row, 3, DONE_AT);
  put(row, 8, '19700101');
  put(row, 9, '男性');
  put(row, 10, '172');
  put(row, 11, '65');
  put(row, 18, '吸ったことはない');
  put(row, 22, '元々まったく飲まない');
  put(row, 41, 'ほとんどしない');
  put(row, 46, 'ない');
  put(row, 50, '6〜7時間');
  put(row, 51, '普通');
  put(row, 52, '5');
  for (const [idx, v] of Object.entries(overrides ?? {})) put(row, Number(idx), v);
  return row;
}

{
  const base = q.normalizeExternalFormRow(HEADERS, buildRow());
  eq('62 列 schema は一致する', base.schema.ok, true);
  eq('完了時刻が解決する', base.completedAt.status, 'resolved');
  eq('完了日は 2026-07-12', base.completedAt.date, '2026-07-12');
  const fin = br.finalizeQuestionnaire(base, null);
  eq('要確認 0 件', fin.needsReviewCount, 0);
  eq('納品できる', q.questionnaireIsUsable(fin), true);
  deepEq('EXAM-TYPE はバッチ文脈から seed する', fin.answers['EXAM-TYPE'],
    [...contract.EXTERNAL_FORM_V1_EXAM_TYPE]);
  ok('Genoplan があってもタイプ1 の札を立てない',
    !JSON.stringify(fin.answers['EXAM-TYPE']).includes('ウェルテクト'));
}
{
  // 運動しないのに運動時間・種類が入っている合成行 → 納品 answers に残らない。
  const base = q.normalizeExternalFormRow(HEADERS, buildRow({ 42: '30〜60分', 45: 'ウォーキング' }));
  const fin = br.finalizeQuestionnaire(base, null);
  ok('E-TIME は納品されない', fin.answers['E-TIME'] === undefined);
  ok('E-TYPE は納品されない', fin.answers['E-TYPE'] === undefined);
  eq('人物は止めない', q.questionnaireIsUsable(fin), true);
  eq('分岐で落とした数が残る', fin.ignoredByBranch, 2);
}
{
  // 服薬なしなのに薬名 → 納品しない (人が確認する)。
  const base = q.normalizeExternalFormRow(HEADERS, buildRow({ 47: 'ロキソニン（頭痛）' }));
  const fin = br.finalizeQuestionnaire(base, null);
  deepEq('薬名の矛盾が要確認に出る', fin.reviewQuestionIds, ['M-NAME']);
  eq('要確認があれば納品しない', q.questionnaireIsUsable(fin), false);
}
{
  // E-TYPE に複数回答 (production は単一選択) → Phase A で要確認。運動していれば残る。
  const base = q.normalizeExternalFormRow(HEADERS, buildRow({ 41: '週3〜4日', 45: 'ウォーキング;ジョギング' }));
  deepEq('複数回答は先頭を採らず要確認', base.reviewQuestionIds, ['E-TYPE']);
  const fin = br.finalizeQuestionnaire(base, null);
  eq('要確認が残るので納品しない', q.questionnaireIsUsable(fin), false);
}
{
  // SL-STRESS の範囲外は clamp せず要確認。
  const base = q.normalizeExternalFormRow(HEADERS, buildRow({ 52: '11' }));
  deepEq('範囲外は clamp せず要確認', base.reviewQuestionIds, ['SL-STRESS']);
  ok('10 へ丸めていない', base.answers['SL-STRESS'] === undefined);
}

// ===========================================================================
// ③ 納品ゲート (§4) と手入力による解消 (§5.2)
// ===========================================================================
const confirmedRec = (entries, extra = {}) => ({
  kind: 'manual_questionnaire', entries,
  completedAt: null, sex: null, age: null,
  enteredBy: 'a***', enteredAt: '2026-09-14T00:00:00Z',
  confirmedBy: 'b***', confirmedAt: '2026-09-14T00:10:00Z',
  ...extra,
});

{
  const base = q.normalizeExternalFormRow(HEADERS, buildRow({ 41: '週3〜4日', 45: 'ウォーキング;ジョギング' }));
  // 未確認の手入力は効かない。
  const pending = br.finalizeQuestionnaire(base, confirmedRec(
    [{ questionId: 'E-TYPE', value: 'ウォーキング' }], { confirmedBy: null, confirmedAt: null },
  ));
  eq('未確認の手入力は納品に使わない', q.questionnaireIsUsable(pending), false);
  deepEq('要確認は残ったまま', pending.reviewQuestionIds, ['E-TYPE']);

  // 確認済みなら解消して納品できる。
  const fixed = br.finalizeQuestionnaire(base, confirmedRec([{ questionId: 'E-TYPE', value: 'ウォーキング' }]));
  eq('確認済みの手入力で解消する', fixed.reviewQuestionIds.length, 0);
  eq('解消したら納品できる', q.questionnaireIsUsable(fixed), true);
  eq('手入力した値が入る', fixed.answers['E-TYPE'], 'ウォーキング');
  eq('自動で写像できた設問は消えない', fixed.answers['B-HEIGHT'], '172');
}
{
  // 手入力が選択肢に無い値なら通さない (寄せない)。
  const base = q.normalizeExternalFormRow(HEADERS, buildRow({ 41: '週3〜4日', 45: 'ウォーキング;ジョギング' }));
  const bad = br.finalizeQuestionnaire(base, confirmedRec([{ questionId: 'E-TYPE', value: 'たまに歩く' }]));
  eq('選択肢に無い手入力では解消しない', q.questionnaireIsUsable(bad), false);
}
{
  // 日付が確定しなければ納品しない (today で埋めない)。
  const row = buildRow();
  row[2] = '2026-07-12 16:05:45'; // 文字列で来た場合 = 推測しない
  const base = q.normalizeExternalFormRow(HEADERS, row);
  ok('日時文字列は推測しない', base.completedAt.status !== 'resolved');
  deepEq('被験者側の要確認として出る', base.subjectReview, ['completed_at']);
  const fin = br.finalizeQuestionnaire(base, null);
  eq('日付が無ければ納品しない', q.questionnaireIsUsable(fin), false);
  // 管理者が原本を見て日付を入れれば解消する。
  const fixed = br.finalizeQuestionnaire(base, confirmedRec(
    [{ questionId: 'SL-QUALITY', value: '普通' }], { completedAt: '2026-07-12' },
  ));
  eq('手入力の日付で解消する', fixed.completedAt.status, 'resolved');
  eq('日付が入れば納品できる', q.questionnaireIsUsable(fixed), true);
}
{
  // schema が違えば 1 列も読まない・納品しない。
  const bad = [...HEADERS];
  bad[9] = '身長（cm）';
  const base = q.normalizeExternalFormRow(bad, buildRow());
  eq('schema が違えば写像 0 件', base.mappedCount, 0);
  eq('schema が違えば納品しない', q.questionnaireIsUsable(base), false);
}
{
  // 材料が 1 つも無ければ null (空の JSON を作らない)。
  eq('材料が無ければ null', br.finalizeQuestionnaire(null, null), null);
  const onlyManual = br.finalizeQuestionnaire(null, confirmedRec(
    [{ questionId: 'SL-QUALITY', value: '普通' }], { completedAt: '2026-07-12' },
  ));
  eq('手入力だけでも組める (PDF の経路)', onlyManual.answers['SL-QUALITY'], '普通');
  eq('手入力だけでも納品できる', q.questionnaireIsUsable(onlyManual), true);
}

// ===========================================================================
// ④ 保存物に生の回答値を残さない (§5.1)
// ===========================================================================
{
  /*
   * **設問 id は PII deny-list の対象外** — `M-NAME` は `name` に部分一致するので、
   * 除外しないと**服薬ありと答えた人物の保存が丸ごと throw する** (実測 2026-09-14)。
   * 逆に `display_name` のような本物の PII キーは今までどおり止まること。
   */
  const withMeds = br.finalizeQuestionnaire(
    q.normalizeExternalFormRow(HEADERS, buildRow({ 46: 'ある', 47: 'ロキソニン（頭痛）', 48: '1年以上', 49: '毎日' })),
    null,
  );
  eq('服薬ありの薬名が answers に入る', withMeds.answers['M-NAME'], 'ロキソニン（頭痛）');
  let threw = null;
  try { np.buildQuestionnairePayload(withMeds); } catch (e) { threw = String(e); }
  ok('設問 id で PII ゲートが誤爆しない', threw === null, threw ?? '');
  let stillGuards = false;
  try { np.assertNoPiiKeys({ display_name: 'x' }, 'test', new Set(['M-NAME'])); }
  catch { stillGuards = true; }
  ok('本物の PII キーは今までどおり止める', stillGuards);

  const base = q.normalizeExternalFormRow(HEADERS, buildRow({ 47: 'ロキソニン（頭痛）' }));
  const fin = br.finalizeQuestionnaire(base, null);
  const payload = np.buildQuestionnairePayload(fin);
  const json = JSON.stringify(payload);
  ok('要確認の設問 id は残る', (payload.review_question_ids ?? []).includes('M-NAME'));
  /*
   * **保存する形を固定する。** 新しいキーを足して生の回答値を持ち出すのを防ぐ
   * (件数だけ / id だけ、という約束が破れても JSON を眺めただけでは気づけない)。
   */
  deepEq('保存するキーは決まった集合だけ', Object.keys(payload).sort(), [
    'age', 'answers', 'completed_at', 'ignored_by_spec_count', 'kind', 'mapped_count',
    'profile', 'review_question_ids', 'sex', 'subject_review', 'unmapped_count', 'v',
  ]);
  // 読めなかった値そのものが payload に出ないこと (要確認の detail には値が入る)。
  const unknown = br.finalizeQuestionnaire(
    q.normalizeExternalFormRow(HEADERS, buildRow({ 41: '週3〜4日', 45: 'たまに歩くくらい' })), null,
  );
  ok('要確認の理由に値が入っている (元)', unknown.unmapped.some((u) => String(u.detail).includes('たまに歩く')));
  ok('保存物には読めなかった値を出さない',
    !JSON.stringify(np.buildQuestionnairePayload(unknown)).includes('たまに歩く'));
  /*
   * **未知の生回答値を永続化しない。** id だけを残す約束 (§5.1)。
   * ここが漏れると「捨てた薬名が DB に残る」= 画面では見えないまま蓄積する。
   */
  ok('未知の回答値そのものは保存しない', !json.includes('ロキソニン'), json.slice(0, 200));
  ok('unmapped の detail を保存しない', !json.includes('選択肢に無い値'));

  const restored = np.restoreQuestionnaire(payload);
  deepEq('復元しても要確認 id は残る', restored.reviewQuestionIds, ['M-NAME']);
  eq('復元しても納品しない', q.questionnaireIsUsable(restored), false);
  // 復元 → 手入力で解消 → 納品できる (実際の運用と同じ順序)。
  const fixed = br.finalizeQuestionnaire(restored, confirmedRec([{ questionId: 'M-NAME', value: 'ロキソニン' }]));
  // **M-HAS=ない のままなので矛盾は解けない** — 薬名だけ入れ直しても production では
  // その設問自体が出ないため、納品 answers には入れられない。
  eq('薬名だけ直しても矛盾は解けない', q.questionnaireIsUsable(fixed), false);
  const fixed2 = br.finalizeQuestionnaire(restored, confirmedRec([
    { questionId: 'M-HAS', value: 'ある' },
    { questionId: 'M-NAME', value: 'ロキソニン' },
  ]));
  eq('服薬ありへ直せば矛盾が解ける', q.questionnaireIsUsable(fixed2), true);
  eq('直したあとは薬名が納品に入る', fixed2.answers['M-NAME'], 'ロキソニン');
}

// ===========================================================================
// ⑤ service 側の結線 (plan と deliver が同じ経路を通る)
// ===========================================================================
const svc = read('src/lib/ad-hoc-diagnosis/service.ts');
const svcStripped = strip(svc);
ok('納品用の問診は 1 か所で組む',
  /async function resolveQuestionnaireForDelivery\(/.test(svcStripped));
eq('plan と deliver の両方が通る',
  (svcStripped.match(/resolveQuestionnaireForDelivery\(qFile\)/g) ?? []).length, 2);
ok('deliver が素の payload を直接使わない',
  !/const q = qFile \? restoreQuestionnaire\(qFile\.normalized_payload\) : null;/.test(svcStripped));
ok('分岐の適用を service が自前で書いていない', !/resolvePath\(/.test(svcStripped));
ok('確認済みの手入力だけ混ぜる', /if \(!manualRecordIsConfirmed\(rec\)\) return null;/.test(svcStripped));
ok('要確認の設問 id を画面へ配る', /review_question_ids:/.test(svcStripped));
ok('新しい DB マイグレーションを足していない', !/create table|alter table/i.test(svcStripped));

// 納品ゲートの本体が緩んでいないこと。
const gate = strip(read('src/lib/ad-hoc-diagnosis/questionnaire.ts'));
ok('schema 違いは納品しない', /if \(n\.schema && !n\.schema\.ok\) return false;/.test(gate));
ok('日付未確定は納品しない', /if \(n\.completedAt\.status !== 'resolved'\) return false;/.test(gate));
ok('要確認が残れば納品しない', /reviewQuestionIds\?\.length[\s\S]{0,120}return false;/.test(gate));
ok('「mappedCount > 0 だけ」に戻っていない',
  !/^\s*return n\.mappedCount > 0;\s*$/m.test(gate));

// ===========================================================================
rmSync(tmp, { recursive: true, force: true });
const total = pass + failures.length;
if (failures.length) {
  console.error(`\n✗ verify:ad-hoc-questionnaire-branch  ${pass}/${total}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ verify:ad-hoc-questionnaire-branch  ${pass}/${total}`);
