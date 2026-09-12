#!/usr/bin/env node
/**
 * Executive Diagnosis (Phase B1) の回帰チェック — Scan 側。
 *
 * 【なぜ要るか】ここで壊れるものは**画面上は正常に見える**:
 *   - 再分類で Executive の紐付けが消えても「未割当」に戻るだけでエラーにならない
 *   - 遺伝子の日付に健診日が入っても、S3 には**それらしい key** が普通に出来上がる
 *   - `diagnosis` スキーマへ氏名が 1 列混ざっても動作は変わらない (設計だけが壊れる)
 *
 * **外部 DB / AWS / ネットワークを使わない。** ソース検査と、実物を transpile した
 * ロジックの実行だけ。
 *
 * 実行: node scripts/verify-executive-diagnosis.mjs
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const fails = [];
const ok = (label) => console.log(`  ✓ ${label}`);
const bad = (label, detail) => {
  fails.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
};
const eq = (label, got, want) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? ok(label)
    : bad(label, `got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);

/** コメントを外した「実際に動くコード」だけを見る (説明文に語が出るため)。 */
function stripComments(src) {
  let out = ''; let i = 0; let mode = 'code';
  while (i < src.length) {
    const c = src[i]; const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
      if (c === "'") mode = 'sq'; else if (c === '"') mode = 'dq'; else if (c === '`') mode = 'tpl';
      out += c; i++; continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c; } i++; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i += 2; continue; } if (c === '\n') out += c; i++; continue; }
    if (c === '\\') { out += c + (n ?? ''); i += 2; continue; }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) mode = 'code';
    out += c; i++;
  }
  return out;
}

const MIG_AD_HOC = 'supabase/migrations/20260910000020_ad_hoc_diagnosis.sql';
const MIG_B1 = 'supabase/migrations/20260911000010_executive_subject_link.sql';
const SERVICE = 'src/lib/ad-hoc-diagnosis/service.ts';
const STORE = 'src/lib/ad-hoc-diagnosis/store.ts';

console.log('\n=== A. diagnosis 側に PII 列が無い ===');
{
  const sqls = [read(MIG_AD_HOC), read(MIG_B1)].join('\n');
  /*
   * **`diagnosis` スキーマは PII を持たない**が全体の設計前提。
   * 氏名・メール・会社名・役職を表す列名が現れたら落とす。
   * (`display_name` は**ファイル名**の表示用で人物名ではないため対象外。
   *  その代わり `subject` 側に現れないことを別に見る。)
   */
  const banned = [
    /\bfull_name\b/i, /\bexecutive_name\b/i, /\bperson_name\b/i,
    /\bemail\b/i, /\bcompany\b/i, /\borganization_name\b/i, /\bjob_title\b/i,
  ];
  for (const re of banned) {
    eq(`migration に ${re.source} が無い`, re.test(sqls), false);
  }
  // subjects 表の列だけを取り出して氏名系が無いことを見る。
  const m = /create table if not exists diagnosis\.ad_hoc_diagnosis_subjects\s*\(([\s\S]*?)\n\);/.exec(read(MIG_AD_HOC));
  eq('subjects 表の定義が見つかる', m !== null, true);
  const cols = stripComments(m?.[1] ?? '');
  eq('subjects に display_name 列が無い', /\bdisplay_name\b/.test(cols), false);

  // store の型にも混ざっていないこと。
  const rowType = /export interface SubjectRow \{([\s\S]*?)\n\}/.exec(read(STORE));
  eq('SubjectRow の定義が見つかる', rowType !== null, true);
  const rt = stripComments(rowType?.[1] ?? '');
  for (const k of ['display_name', 'email', 'organization', 'job_title', 'name']) {
    eq(`SubjectRow に ${k} が無い`, new RegExp(`\\b${k}\\b`).test(rt), false);
  }
}

console.log('\n=== B. subjects に足したのは executive_subject_id (UUID) だけ ===');
{
  const sql = read(MIG_B1);
  const adds = [...sql.matchAll(/add column if not exists\s+(\w+)\s+(\w+)/gi)].map((x) => [x[1], x[2]]);
  /*
   * 追加列は 2 本ちょうど: **人物の紐付け (UUID)** と **バッチが Executive 案件か**。
   * ここが増えたら PII が診断側へ滲み出していないか必ず確かめる。
   */
  eq('追加列は 2 本 (紐付け + 案件フラグ)', adds.map(([n]) => n).sort(),
    ['executive_subject_id', 'require_executive_link']);
  const col = Object.fromEntries(adds);
  eq('紐付けの型は uuid', col.executive_subject_id, 'uuid');
  eq('案件フラグの型は boolean', col.require_executive_link, 'boolean');
  eq('外部キーを張っていない', /references\s+\w*executive/i.test(sql), false);
  eq('index がある', /create index[\s\S]*executive_subject_id/i.test(sql), true);
  eq('同一 batch の二重割当を防ぐ一意制約がある',
    /create unique index[\s\S]*\(batch_id, executive_subject_id\)[\s\S]*where executive_subject_id is not null/i.test(sql), true);

  // API が受け取るのも UUID だけ。
  const api = stripComments(read('src/pages/api/admin/ad-hoc-diagnosis/subject-link.ts'));
  eq('API は executiveSubjectId を UUID 検証する', /isUuid\(v\)/.test(api), true);
  for (const k of ['displayName', 'name', 'email', 'organization', 'jobTitle']) {
    eq(`API が ${k} を読まない`, new RegExp(`body\\.${k}\\b`).test(api), false);
  }
}

console.log('\n=== C/D. 再分類での引き継ぎ (一意一致だけ・衝突では引き継がない) ===');
{
  // classifyBatch の該当ロジックを実物から取り出して動かす。
  const svc = read(SERVICE);
  const block = /if \(s\.fingerprint\) \{[\s\S]*?\n      \} else \{[\s\S]*?\n      \}/.exec(svc);
  eq('fingerprint 分岐が見つかる', block !== null, true);

  const ts = (await import('typescript')).default;
  const CACHE = resolve(ROOT, 'node_modules/.cache');
  mkdirSync(CACHE, { recursive: true });
  // 実物の `matchByFingerprint` を使う (判定規則を二重に書かない)。
  const fpSrc = read('src/lib/ad-hoc-diagnosis/fingerprint.ts');
  const fpPath = resolve(CACHE, 'verify-exec-fp.mjs');
  writeFileSync(fpPath, ts.transpileModule(fpSrc, {
    compilerOptions: { target: 'ES2022', module: 'ESNext' },
  }).outputText);
  const FP = await import(`${fpPath}?t=${Date.now()}`);

  // 実物の分岐をそのまま関数化して動かす。
  const body = block[0]
    .replace(/await store\.findSubjectsByFingerprint\(batchId, s\.fingerprint\)/, 'HITS')
    .replace(/matchByFingerprint\(/, 'FP.matchByFingerprint(');
  const run = new Function('s', 'HITS', 'FP', `
    let identity = 'confirmed'; let reason = null; let clientId = 'NEW'; let executiveSubjectId = null;
    ${body}
    return { identity, reason, clientId, executiveSubjectId };
  `);

  const EX = '11111111-2222-3333-4444-555555555555';
  // ① 一意一致 → client_id と executive を引き継ぐ
  const hit = run({ fingerprint: 'fp1' },
    [{ id: 'A', client_id: 'CID-1', executive_subject_id: EX }], FP);
  eq('一意一致: client_id を引き継ぐ', hit.clientId, 'CID-1');
  eq('一意一致: executive_subject_id を引き継ぐ', hit.executiveSubjectId, EX);
  eq('一意一致: confirmed', hit.identity, 'confirmed');

  // ② 衝突 → 引き継がない
  const col = run({ fingerprint: 'fp1' },
    [{ id: 'A', client_id: 'CID-1', executive_subject_id: EX },
     { id: 'B', client_id: 'CID-2', executive_subject_id: EX }], FP);
  eq('衝突: executive を自動で引き継がない', col.executiveSubjectId, null);
  eq('衝突: needs_review', col.identity, 'needs_review');
  eq('衝突: client_id も新規', col.clientId, 'NEW');

  // ③ fingerprint 無し → 引き継がない
  const none = run({ fingerprint: null }, [], FP);
  eq('fp 無し: executive を引き継がない', none.executiveSubjectId, null);
  eq('fp 無し: needs_review', none.identity, 'needs_review');

  // ④ 一致したが相手が未割当 → null のまま (undefined にしない)
  const unl = run({ fingerprint: 'fp1' },
    [{ id: 'A', client_id: 'CID-1', executive_subject_id: null }], FP);
  eq('未割当の引き継ぎは null', unl.executiveSubjectId, null);

  // replaceSubjects へ実際に渡していること。
  const code = stripComments(svc);
  eq('replaceSubjects へ executive_subject_id を渡している',
    /executive_subject_id: executiveSubjectId/.test(code), true);
}

console.log('\n=== E/F. 遺伝子の test_date は遺伝子ファイル自身のもの ===');
{
  const code = stripComments(read(SERVICE));
  // buildGeneticJson / GeneticTestResultData の納品に hcTestDate を渡していないこと。
  const genCalls = [...code.matchAll(/buildGeneticJson\(\{[^}]*\}\)/g)].map((m) => m[0]);
  eq('buildGeneticJson の呼び出しが 2 件', genCalls.length, 2);
  for (const c of genCalls) {
    eq(`hcTestDate を渡していない: ${c.slice(0, 42)}…`, /hcTestDate/.test(c), false);
    eq(`gTestDate を渡している: ${c.slice(0, 42)}…`, /testDate: gTestDate/.test(c), true);
  }
  // 納品 key を組むところも同様。
  const deliv = [...code.matchAll(/toDeliveryFile\([^;]*?'GeneticTestResultData'[^;]*?\)/g)].map((m) => m[0]);
  eq('GeneticTestResultData の toDeliveryFile が 1 件', deliv.length, 1);
  eq('key の日付に hcTestDate を使っていない', /hcTestDate/.test(deliv[0] ?? ''), false);
  eq('key の日付は gTestDate', /gTestDate/.test(deliv[0] ?? ''), true);
  // 出どころが gFile.test_date であること。
  eq('gTestDate は gFile.test_date から取る',
    (code.match(/const gTestDate = gFile\.test_date \?\? null;/g) ?? []).length, 2);
  // **今日 / bundle_date で埋めていない**
  eq('gTestDate を new Date() で埋めていない', /gTestDate\s*=\s*[^;]*new Date\(/.test(code), false);
  eq('gTestDate を bundle_date で埋めていない', /gTestDate\s*=\s*[^;]*bundle_date/.test(code), false);

  // 他 format の日付の出どころ (取り違えていないこと)。
  eq('健診は健診自身の testDate', /hcTestDate = built\.testDate/.test(code), true);
  eq('HealthAge は派生元健診の日付', /'HealthAgeData', hcTestDate/.test(code), true);
}

console.log('\n=== G. 遺伝子の日付が無ければ納品 ready にしない ===');
{
  const code = stripComments(read(SERVICE));
  // process 側: 日付が無ければ formats に push しない
  // (条件は `geneticComplete` に集約したので、その定義が日付を見ていることで担保する)
  eq('完成条件が日付を見ている',
    /const geneticComplete = !!gTestDate && /.test(code), true);
  eq('formats.push は完成条件を通る',
    /if \(geneticComplete\) formats\.push\('GeneticTestResultData'\)/.test(code), true);
  // assemble 側: 日付が無ければ納品ファイルを作らない
  eq('日付が無ければ納品ファイルを作らない',
    /if \(parts\.length > 0 && gTestDate[^)]*\)/.test(code), true);
  // 黙って落とさず error として見せる
  eq('日付未確定を error で可視化する',
    /validation_status: !gTestDate \? 'error'/.test(code), true);
}

console.log('\n=== H. 管理者の test_date 手入力は YYYY-MM-DD のみ ===');
{
  const src = read('src/pages/api/admin/ad-hoc-diagnosis/confirm.ts');
  const code = stripComments(src);
  eq('ISO 形の正規表現がある', /\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/.test(code), true);
  eq('不正な日付は 400', /invalid_test_date/.test(code), true);
  eq('null で解除できる', /c\.testDate === null/.test(code), true);

  // 実際に検証関数を取り出して動かす。
  const fn = /const ISO_DATE = [\s\S]*?\n  \}/.exec(src);
  eq('検証関数が見つかる', fn !== null, true);
  // **TypeScript のまま `new Function` へ渡さない** (型注釈で構文エラーになる)。
  const ts2 = (await import('typescript')).default;
  const js = ts2.transpileModule(`${fn[0]}\nreturn validTestDate;`, {
    compilerOptions: { target: 'ES2022', module: 'ESNext' },
  }).outputText;
  const validate = new Function(js)();
  for (const v of ['2026-03-29', '2024-02-29']) eq(`"${v}" は通る`, validate(v), true);
  for (const v of ['2026-3-29', '2026/03/29', '20260329', '2026-02-30', '2026-13-01', '', 'today', '2026-03-29T00:00:00Z']) {
    eq(`"${v}" は弾く`, validate(v), false);
  }
}

console.log('\n=== I. Executive の required / optional (Wellfort が明示して渡す) ===');
{
  /*
   * **Scan 側の汎用既定 (`GATING_FORMAT_IDS`) を変えていないこと**が本題。
   * Executive の既定は Wellfort が `upload-ticket` で明示的に渡す。
   */
  const assemble = read('src/lib/elith-assemble.ts');
  const g = /export const GATING_FORMAT_IDS[\s\S]*?\];/.exec(assemble);
  eq('GATING_FORMAT_IDS が見つかる', g !== null, true);
  eq('GATING_FORMAT_IDS に Executive 専用の分岐が無い', /executive/i.test(g?.[0] ?? ''), false);

  const ticket = stripComments(read('src/pages/api/admin/ad-hoc-diagnosis/upload-ticket.ts'));
  eq('upload-ticket が requiredFormats を受ける', /body\.requiredFormats/.test(ticket), true);
  eq('upload-ticket が optionalFormats を受ける', /body\.optionalFormats/.test(ticket), true);
  eq('Scan 側に Executive 既定を焼き込んでいない', /HealthCheckupData'.*LifestyleQuestionnaireData/.test(ticket), false);
}

console.log('\n=== J. Phase A の安全装置を弱めていない ===');
{
  const wg = read('src/lib/ad-hoc-diagnosis/write-guard.ts');
  const code = stripComments(wg);
  eq("WRITE_ENABLED が 'on' ちょうど", /enabled !== 'on'/.test(code), true);
  eq('target の完全一致検査がある', /actual !== want/.test(code), true);
  eq('skipped > 0 で止める', /input\.skipped\.length > 0/.test(code), true);
  eq('delivery 0 件で止める', /input\.delivery\.length === 0/.test(code), true);
  eq("IfNoneMatch: '*' がある", /IfNoneMatch: '\*'/.test(code), true);
  eq('既存オブジェクトの事前確認がある', /HeadObjectCommand/.test(code), true);
  eq('overwrite の escape hatch が無い', /overwrite/i.test(code), false);
  // key allowlist が Elith の論理形のまま (test_date 変更で緩めていない)
  eq('key allowlist が user/.../date/... のまま',
    /user\/\(\$\{UUID\}\)\/date\//.test(code), true);
}

console.log('\n=== K. 任意 format の「不存在」と「在るが不完全」を分ける ===');
{
  /*
   * **実物の `evaluateReadiness` をそのまま動かす。** 判定規則を検査側に写すと、
   * 実装が変わっても検査だけ通る (=何も守れない) ので、
   * pipeline.ts と classify.ts から関数の本体を取り出して実行する。
   */
  const ts3 = (await import('typescript')).default;
  const pipe = read('src/lib/ad-hoc-diagnosis/pipeline.ts');
  const cls = read('src/lib/ad-hoc-diagnosis/classify.ts');

  /*
   * 関数 1 本を丸ごと取り出す。**正規表現で終わりを探さない** —
   * `evaluateReadiness` は引数がオブジェクト型で `\n}` を途中に含むため、
   * 非貪欲マッチだと**シグネチャだけ**を掴んで黙って空の関数になる (実際そうなった)。
   * 括弧の対応を数えて本体の終わりを決める。
   */
  const extractFn = (src, name) => {
    const head = src.indexOf(`export function ${name}(`);
    if (head < 0) return null;
    let i = src.indexOf('(', head), depth = 0;
    for (; i < src.length; i++) {           // 引数リストの `)` まで
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) break;
    }
    const bodyStart = src.indexOf('{', i);  // 本体の `{`
    if (bodyStart < 0) return null;
    depth = 0;
    for (let j = bodyStart; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(head, j + 1);
    }
    return null;
  };

  const evalFn = extractFn(pipe, 'evaluateReadiness');
  const autoFn = extractFn(cls, 'subjectIsAutoReady');
  eq('evaluateReadiness が見つかる', evalFn !== null, true);
  eq('subjectIsAutoReady が見つかる', autoFn !== null, true);
  // シグネチャだけを掴んでいないこと (本体が入っている)
  eq('evaluateReadiness の本体まで取れている', /missingRequired/.test(evalFn ?? ''), true);

  const src = `${autoFn}\n${evalFn}\nexport { evaluateReadiness };`
    .replace(/export function/g, 'function');
  const CACHE2 = resolve(ROOT, 'node_modules/.cache');
  mkdirSync(CACHE2, { recursive: true });
  const p = resolve(CACHE2, 'verify-exec-readiness.mjs');
  writeFileSync(p, ts3.transpileModule(src, {
    compilerOptions: { target: 'ES2022', module: 'ESNext' },
  }).outputText);
  const { evaluateReadiness } = await import(`${p}?t=${Date.now()}`);

  const REQ = ['HealthCheckupData', 'LifestyleQuestionnaireData'];
  const OPT = ['GeneticTestResultData', 'HealthAgeData'];
  const cf = (formatId) => ({ sourceKind: 'person_file', formatId, confidence: 'confirmed', reason: '' });
  const HC_Q = [cf('HealthCheckupData'), cf('LifestyleQuestionnaireData')];
  const run = (produced, classifications) => evaluateReadiness({
    producedFormats: produced, requiredFormats: REQ, optionalFormats: OPT, classifications,
  });

  // ① 遺伝子ファイルが無い → 必須が揃えば ready (任意なので妨げない)
  const a = run(['HealthCheckupData', 'LifestyleQuestionnaireData'], HC_Q);
  eq('遺伝子ファイル無し: ready', a.ready, true);
  eq('遺伝子ファイル無し: 不完全の指摘は無い', a.presentOptionalSourceButNotProduced, []);

  // ② 遺伝子ファイルが在るのに納品物になっていない → not ready
  //    (test_date 未確定 / 解析失敗 / 未処理 は、どれもこの形になる)
  const b = run(['HealthCheckupData', 'LifestyleQuestionnaireData'],
    [...HC_Q, cf('GeneticTestResultData')]);
  eq('遺伝子ファイル在り・未完成: not ready', b.ready, false);
  eq('遺伝子ファイル在り・未完成: 理由が出る',
    b.reasons.includes('optional_present_but_not_ready:GeneticTestResultData'), true);
  eq('遺伝子ファイル在り・未完成: 必須不足とは別建て', b.missingRequired, []);

  // ③ 遺伝子が仕上がった → ready
  const c = run(['HealthCheckupData', 'LifestyleQuestionnaireData', 'GeneticTestResultData'],
    [...HC_Q, cf('GeneticTestResultData')]);
  eq('遺伝子が仕上がった: ready', c.ready, true);
  eq('遺伝子が仕上がった: presentOptional に出る',
    c.presentOptional.includes('GeneticTestResultData'), true);

  // ④ **HealthAgeData は派生データ**。算出できなくても ready を妨げない
  //    (元ファイルの分類が存在しないので、この検査に現れようが無い)。
  eq('HealthAgeData は不完全の対象外', a.presentOptionalSourceButNotProduced.includes('HealthAgeData'), false);
  eq('HealthAgeData は不完全の対象外 (遺伝子在りでも)',
    b.presentOptionalSourceButNotProduced.includes('HealthAgeData'), false);

  // ⑤ 必須不足と同時に起きたら両方出る (片方で黙らない)
  const d = run([], [cf('GeneticTestResultData')]);
  eq('必須不足も同時に出る', d.reasons.some((r) => r.startsWith('missing_required:')), true);
  eq('任意の不完全も同時に出る',
    d.reasons.includes('optional_present_but_not_ready:GeneticTestResultData'), true);
}

console.log('\n=== L. 遺伝子の部分納品を禁止 (失敗/未処理ページが残る間は納品しない) ===');
{
  const code = stripComments(read(SERVICE));

  // 「done でないページ」を数えていること (failed だけ見ていない = pending を見逃さない)
  eq('process 側は done 以外を数える',
    /const incomplete = pages\.filter\(\(p\) => p\.status !== 'done'\)\.length;/.test(code), true);
  eq('assemble 側は done 以外を数える',
    /const gIncomplete = pages\.filter\(\(p\) => p\.status !== 'done'\)\.length;/.test(code), true);
  /*
   * **page_count (countPdfPages の概算) を納品の条件にしていない** —
   * 概算が実際とずれると**操作で直せないまま納品が永久に止まる**。
   * 見るのは「未完了の数え方」と「納品のガード」だけ (`parse_status` の行には
   * `page_count:` の代入が続くので、行全体を見ると必ず当たってしまう)。
   */
  const countDefs = [...code.matchAll(/const g?[Ii]ncomplete = [^;]+;/g)].map((m) => m[0]);
  eq('未完了の数え方が 2 か所ある', countDefs.length, 2);
  eq('数え方に page_count を使っていない',
    countDefs.some((d) => d.includes('page_count')), false);
  const completeDef = /const geneticComplete = [^;]+;/.exec(code);
  eq('完成条件に page_count を使っていない',
    (completeDef?.[0] ?? '').includes('page_count'), false);

  /*
   * **実物のガード式をそのまま動かす。**
   * 条件を検査側に書き写すと、実装を緩めても検査が通ってしまう。
   */
  /*
   * **条件の中身を決め打ちで探さない。** `if (…)` の中をそのまま取り出して動かす。
   * 「期待する形の式が見つからない」で落とすと、ガードを緩めたときに
   * *どう* 壊れたのかが分からないし、書き方を変えただけでも落ちる。
   * ここで見たいのは形でなく**振る舞い**。
   */
  const pg = /if \(([^)]*)\) formats\.push\('GeneticTestResultData'\)/.exec(code);
  const ag = /if \((parts\.length > 0[^)]*)\)/.exec(code);
  eq('process 側のガード式が見つかる', pg !== null, true);
  eq('assemble 側のガード式が見つかる', ag !== null, true);

  /*
   * process 側のガードは `geneticComplete` を経由するので、**その定義も一緒に
   * 持ち込んで**評価する (定義を書き写すと、条件を緩めても検査が通る)。
   */
  const runP = new Function('gTestDate', 'incomplete', `
    const doneParts = [{ page: 1 }];
    ${completeDef?.[0] ?? 'const geneticComplete = true;'}
    return !!(${pg?.[1] ?? 'true'});
  `);
  const runA = new Function('parts', 'gTestDate', 'gIncomplete', `return !!(${ag?.[1] ?? 'true'});`);
  const PARTS = [{ page: 1 }];

  // ① 日付あり・全ページ成功 → 納品する
  eq('process: 日付あり + 全ページ成功 → produced', runP('2026-03-29', 0), true);
  eq('assemble: 日付あり + 全ページ成功 → 納品', runA(PARTS, '2026-03-29', 0), true);

  // ② 日付が無い → 納品しない
  eq('process: 日付なし → produced にしない', runP(null, 0), false);
  eq('assemble: 日付なし → 納品しない', runA(PARTS, null, 0), false);

  // ③ **失敗/未処理ページが残る → 成功ページだけで納品しない**
  eq('process: 未完了ページあり → produced にしない', runP('2026-03-29', 1), false);
  eq('assemble: 未完了ページあり → 納品しない', runA(PARTS, '2026-03-29', 1), false);
  eq('process: 未完了が複数でも同じ', runP('2026-03-29', 3), false);

  // ④ 成功ページが 1 枚も無ければ当然作らない
  eq('assemble: 成功ページ 0 → 納品しない', runA([], '2026-03-29', 0), false);

  // 失敗の事実は warn/error として残り続ける (黙って消さない)
  eq('未完了を warn で残す', /incomplete > 0 \? 'warn'/.test(code), true);
  eq('失敗ページ数を error_detail に残す', /failed_pages:\$\{failed\}/.test(code), true);
}

console.log('\n=== M. 遺伝子の状態が output / parse_status / produced で一貫している ===');
{
  /*
   * **実物の判定式をそのまま動かす。** 3 か所 (output_status / validation_status /
   * error_detail / parse_status / producedFormats) が別々の条件を見ていたのが
   * B1.2 で直した不具合そのものなので、**同じ入力を全部へ通して食い違いを見る**。
   */
  const code = stripComments(read(SERVICE));

  const completeExpr = /const geneticComplete = ([^;]+);/.exec(code);
  eq('geneticComplete の定義がある', completeExpr !== null, true);

  // 遺伝子の upsertOutput をそのまま取り出す
  const outCall = [...code.matchAll(/await store\.upsertOutput\(\{([\s\S]*?)\n\s*\}\);/g)]
    .map((m) => m[1]).find((b) => b.includes("'GeneticTestResultData'"));
  eq('遺伝子の upsertOutput が見つかる', outCall !== undefined, true);

  const parseExpr = /parse_status: (doneParts\.length[\s\S]*?),\n\s+page_count:/.exec(code);
  eq('遺伝子の parse_status 式が見つかる', parseExpr !== null, true);

  const pushExpr = /if \(([^)]*)\) formats\.push\('GeneticTestResultData'\)/.exec(code);
  eq('producedFormats のガードが見つかる', pushExpr !== null, true);

  const run = new Function('gTestDate', 'doneCount', 'incomplete', 'failed', `
    const s = { id: 'S1', client_id: 'C1' };
    const built = { itemCount: 42 };
    const doneParts = Array.from({ length: doneCount }, (_, i) => ({ page: i + 1 }));
    const geneticComplete = ${completeExpr?.[1] ?? 'false'};
    const output = doneParts.length > 0 ? ({${outCall ?? ''}}) : null;
    const parse_status = ${parseExpr?.[1] ?? "'?'"};
    const produced = !!(${pushExpr?.[1] ?? 'true'});
    return { output, parse_status, produced, geneticComplete };
  `);

  // A. done + pending が混在 (failed は 0) → 完成扱いにしない
  const a = run('2026-03-29', 3, 2, 0);
  eq('A: output_status = failed', a.output.output_status, 'failed');
  eq('A: validation_status = warn', a.output.validation_status, 'warn');
  eq('A: error_detail に incomplete_pages',
    /^incomplete_pages:2$/.test(a.output.error_detail ?? ''), true);
  eq('A: parse_status = processing', a.parse_status, 'processing');
  eq('A: produced に入らない', a.produced, false);

  // A'. failed も混じるときは内訳が分かる (retry で直るものと未送信は対処が違う)
  const a2 = run('2026-03-29', 3, 2, 1);
  eq("A': error_detail に failed_pages も出る",
    /incomplete_pages:2 failed_pages:1/.test(a2.output.error_detail ?? ''), true);

  // B. 全ページ done + 日付あり → 完成
  const b = run('2026-03-29', 5, 0, 0);
  eq('B: output_status = generated', b.output.output_status, 'generated');
  eq('B: validation_status = ok', b.output.validation_status, 'ok');
  eq('B: error_detail は空', b.output.error_detail, null);
  eq('B: parse_status = done', b.parse_status, 'done');
  eq('B: produced に入る', b.produced, true);

  // B'. 日付が無ければ完成しない (ページが全部 done でも)
  const b2 = run(null, 5, 0, 0);
  eq("B': output_status = failed", b2.output.output_status, 'failed');
  eq("B': validation_status = error", b2.output.validation_status, 'error');
  eq("B': error_detail = test_date_unresolved", b2.output.error_detail, 'test_date_unresolved');
  eq("B': produced に入らない", b2.produced, false);

  // 成功ページ 0 → output を作らない・parse_status は pending
  const z = run('2026-03-29', 0, 4, 0);
  eq('done 0 件: output を作らない', z.output, null);
  eq('done 0 件: parse_status = pending', z.parse_status, 'pending');

  // **3 者が同じ条件を見ている** (どれか 1 つだけ緩むのを防ぐ)
  for (const [label, r] of [['A', a], ["B'", b2], ['B', b]]) {
    eq(`${label}: produced と geneticComplete が一致`, r.produced, r.geneticComplete);
    if (r.output) {
      eq(`${label}: output_status と geneticComplete が一致`,
        r.output.output_status === 'generated', r.geneticComplete);
    }
  }
}

console.log('\n=== N. batchStatus は納品できる output だけを produced に数える ===');
{
  const code = stripComments(read(SERVICE));
  const fn = /function isDeliverableOutput\([\s\S]*?\n\}/.exec(code);
  eq('isDeliverableOutput がある', fn !== null, true);
  // **TS の型注釈が付いているので `new Function` へ直接は渡せない** (実際に落ちた)。
  // 実物を transpile してから動かす。
  const tsN = (await import('typescript')).default;
  const jsFn = tsN.transpileModule(`${fn?.[0] ?? ''}\nexport { isDeliverableOutput };`, {
    compilerOptions: { target: 'ES2022', module: 'ESNext' },
  }).outputText;
  const CACHE_N = resolve(ROOT, 'node_modules/.cache');
  mkdirSync(CACHE_N, { recursive: true });
  const pN = resolve(CACHE_N, 'verify-exec-deliverable.mjs');
  writeFileSync(pN, jsFn);
  const { isDeliverableOutput: isDeliverable } = await import(`${pN}?t=${Date.now()}`);

  const O = (output_status, validation_status) => ({ output_status, validation_status });
  // C. failed / error は数えない
  eq('C: failed は数えない', isDeliverable(O('failed', 'warn')), false);
  eq('C: failed + error も数えない', isDeliverable(O('failed', 'error')), false);
  eq('C: generated + error は数えない', isDeliverable(O('generated', 'error')), false);
  eq('C: pending は数えない', isDeliverable(O('pending', 'pending')), false);
  // D. 問診の unmapped 由来 warn は数える (人物ごと落とさない、が既存の約束)
  eq('D: generated + warn は数える', isDeliverable(O('generated', 'warn')), true);
  eq('D: generated + ok は数える', isDeliverable(O('generated', 'ok')), true);
  eq('D: exported + ok は数える', isDeliverable(O('exported', 'ok')), true);

  // batchStatus が実際にこの関数を通していること
  eq('batchStatus が filter で使っている',
    /\.filter\(isDeliverableOutput\)\s*\n?\s*\.map\(\(o\) => o\.format_id\)/.test(code), true);
  eq('素の map(format_id) が残っていない',
    /outputsBySubject\.get\(s\.id\) \?\? \[\]\)\.map\(\(o\) => o\.format_id\)/.test(code), false);
}

console.log('\n=== O. Executive 未割当は納品しない / generic は従来どおり ===');
{
  const ts4 = (await import('typescript')).default;
  const pipe = read('src/lib/ad-hoc-diagnosis/pipeline.ts');
  const cls = read('src/lib/ad-hoc-diagnosis/classify.ts');
  const extractFn = (src, name) => {
    const head = src.indexOf(`export function ${name}(`);
    if (head < 0) return null;
    let i = src.indexOf('(', head), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) break;
    }
    const b = src.indexOf('{', i);
    depth = 0;
    for (let j = b; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(head, j + 1);
    }
    return null;
  };
  const src = `${extractFn(cls, 'subjectIsAutoReady')}\n${extractFn(pipe, 'evaluateReadiness')}\n`
    .replace(/export function/g, 'function')
    .replace(/EXECUTIVE_UNLINKED_REASON/g, "'executive_subject_unlinked'")
    + 'export { evaluateReadiness };';
  const CACHE3 = resolve(ROOT, 'node_modules/.cache');
  mkdirSync(CACHE3, { recursive: true });
  const p3 = resolve(CACHE3, 'verify-exec-readiness2.mjs');
  writeFileSync(p3, ts4.transpileModule(src, {
    compilerOptions: { target: 'ES2022', module: 'ESNext' },
  }).outputText);
  const { evaluateReadiness } = await import(`${p3}?t=${Date.now()}`);

  const cf = (formatId) => ({ sourceKind: 'person_file', formatId, confidence: 'confirmed', reason: '' });
  const base = {
    producedFormats: ['HealthCheckupData', 'LifestyleQuestionnaireData'],
    requiredFormats: ['HealthCheckupData', 'LifestyleQuestionnaireData'],
    optionalFormats: ['GeneticTestResultData', 'HealthAgeData'],
    classifications: [cf('HealthCheckupData'), cf('LifestyleQuestionnaireData')],
  };

  // E. Executive 案件 + 未割当 → not ready・理由が出る
  const e1 = evaluateReadiness({ ...base, requireExecutiveLink: true, executiveSubjectId: null });
  eq('E: 未割当は not ready', e1.ready, false);
  eq('E: 理由 executive_subject_unlinked',
    e1.reasons.includes('executive_subject_unlinked'), true);
  eq('E: 必須不足とは別建て', e1.missingRequired, []);

  // I. 紐付ければ ready
  const e2 = evaluateReadiness({
    ...base, requireExecutiveLink: true, executiveSubjectId: '11111111-2222-3333-4444-555555555555',
  });
  eq('I: 紐付け済みは ready', e2.ready, true);
  eq('I: 理由は空', e2.reasons, []);

  // G. generic ad-hoc (既定 false) は未割当でも従来どおり ready
  const g1 = evaluateReadiness({ ...base, executiveSubjectId: null });
  eq('G: generic は未割当でも ready', g1.ready, true);
  eq('G: generic に executive の理由は出ない',
    g1.reasons.some((r) => r.includes('executive')), false);
  const g2 = evaluateReadiness({ ...base, requireExecutiveLink: false, executiveSubjectId: null });
  eq('G: false を明示しても同じ', g2.ready, true);

  // F. 未割当が 1 人でもいれば assemble が skipped に入れ、write-guard が全体を止める
  const code = stripComments(read(SERVICE));
  eq('F: assemble は not ready を skipped へ入れる',
    /skipped\.push\(\{ subjectNo: s\.subject_no, reason: readiness\.reasons\.join\(','\)/.test(code), true);
  eq('F: assemble が requireExecutiveLink を渡している',
    (code.match(/requireExecutiveLink: batch\.require_executive_link/g) ?? []).length >= 3, true);
  eq('F: write-guard へ skipped をそのまま渡す',
    /checkWriteGate\(\{ delivery, skipped \}\)/.test(code), true);
}

console.log('\n=== P. 分類確定と人物確定を Executive 案件では分ける ===');
{
  const code = stripComments(read(SERVICE));

  /*
   * H. Executive 案件では分類確定で identity を一括 confirmed にしない。
   *
   * **「無条件の一括 confirmed が無いこと」を正規表現の不在で見ない** —
   * ガードの中にある同じコードにも当たってしまい、退行を注入しても通る (実際に通った)。
   * **1 つしかない `admin_confirmed` が、ガードの内側の位置にあるか**を見る。
   */
  const marks = [...code.matchAll(/identity_reason: 'admin_confirmed'/g)].map((m) => m.index);
  eq('H: 一括 confirmed は 1 か所だけ', marks.length, 1);
  const guardAt = code.indexOf('if (!batch.require_executive_link) {');
  eq('H: ガードが存在する', guardAt >= 0, true);
  // ガードの開き括弧から対応する閉じ括弧までの範囲を求める
  let depth = 0, guardEnd = -1;
  for (let i = code.indexOf('{', guardAt); i < code.length && guardAt >= 0; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) { guardEnd = i; break; }
  }
  eq('H: 一括 confirmed はガードの内側にある',
    marks[0] > guardAt && marks[0] < guardEnd, true);

  /*
   * I/J. link / unlink の状態遷移を実物の分岐で動かす。
   * **`patch` の宣言から `updateSubject` の呼び出し直前まで**を丸ごと取り出す
   * (オブジェクトリテラルだけを取ると if 分岐が落ち、遷移を何も検査しないまま通る)。
   */
  const from = code.indexOf('const patch: Parameters<typeof store.updateSubject>[1] = {');
  const to = code.indexOf('const updated = await store.updateSubject(input.subjectId, patch);');
  eq('link の patch 組み立てが見つかる', from >= 0 && to > from, true);
  const body = code.slice(from, to)
    .replace('const patch: Parameters<typeof store.updateSubject>[1] =', 'const patch =');
  eq('patch の分岐まで取れている', /identity_status/.test(body), true);
  const run = new Function('subject', 'input', `${body}\nreturn patch;`);

  const EX = '11111111-2222-3333-4444-555555555555';
  // I. 未確定の人物を紐付け → confirmed / executive_linked
  const i1 = run({ identity_status: 'needs_review', identity_reason: 'fp_collision' },
    { executiveSubjectId: EX });
  eq('I: 紐付けで confirmed', i1.identity_status, 'confirmed');
  eq('I: 理由は executive_linked', i1.identity_reason, 'executive_linked');
  eq('I: UUID を保存する', i1.executive_subject_id, EX);

  // J-1. 紐付けで確定した人物を外す → needs_review へ戻る
  const j1 = run({ identity_status: 'confirmed', identity_reason: 'executive_linked' },
    { executiveSubjectId: null });
  eq('J: 紐付け由来の確定は外すと needs_review', j1.identity_status, 'needs_review');
  eq('J: 理由が残る', j1.identity_reason, 'executive_unlinked');
  eq('J: UUID を外す', j1.executive_subject_id, null);

  // J-2. **fingerprint で独立に確定していた人物を壊さない**
  const j2 = run({ identity_status: 'confirmed', identity_reason: 'fp_match' },
    { executiveSubjectId: null });
  eq('J: fp_match の確定は unlink で壊さない', j2.identity_status, undefined);
  eq('J: fp_match の理由も書き換えない', j2.identity_reason, undefined);
  const j3 = run({ identity_status: 'confirmed', identity_reason: 'fp_match' },
    { executiveSubjectId: EX });
  eq('J: 既に確定済みなら理由を上書きしない', j3.identity_reason, undefined);

  // 監査は残る
  eq('紐付けの監査を残す', /kind: 'executive_link', linked:/.test(code), true);
}

console.log('\n=== Q. retry がサーバ側で未完了を正しく拾う ===');
{
  const code = stripComments(read(SERVICE));
  eq('failed だけでなく done 以外を対象にする',
    /const unfinished = pages\.filter\(\(p\) => p\.status !== 'done'\)\.map\(\(p\) => p\.page_no\)/.test(code), true);
  eq('failed 限定の旧実装が残っていない',
    /const failed = pages\.filter\(\(p\) => p\.status === 'failed'\)\.map\(\(p\) => p\.page_no\)/.test(code), false);
  // **行が無いページを作らない** (存在しないページ番号を推測しない)
  eq('page_count からページ番号を作っていない',
    /targets\.push\([^)]*page_count/.test(code), false);

  // 成功ページのキャッシュ = 再実行で LLM を呼び直さない仕組み (**変更していない**)
  eq('done ページのキャッシュが残っている',
    /const cached = await store\.findCachedPage\(file\.sha256, p\.page\);/.test(code), true);
  eq('キャッシュ命中で Gemini を呼ばない',
    /if \(cached && !options\.retryFailedOnly\) \{[\s\S]{0,400}?continue;/.test(code), true);
  const st = stripComments(read(STORE));
  eq("キャッシュは status='done' だけを引く",
    /findCachedPage[\s\S]*?\.eq\('status', 'done'\)/.test(st), true);
}

console.log('\n=== R. require_executive_link がバッチに保存される ===');
{
  const st = stripComments(read(STORE));
  const svc = stripComments(read(SERVICE));
  const api = stripComments(read('src/pages/api/admin/ad-hoc-diagnosis/upload-ticket.ts'));
  const mig = read(MIG_B1);

  eq('migration が列を足している',
    /add column if not exists require_executive_link boolean not null default false/i.test(mig), true);
  eq('既定は false (generic は挙動不変)', /default false/i.test(mig), true);
  eq('BatchRow に型がある', /require_executive_link: boolean;/.test(st), true);
  eq('createBatch が保存する',
    /require_executive_link: input\.requireExecutiveLink === true/.test(st), true);
  eq('createBatchWithTicket が渡す',
    /requireExecutiveLink: input\.requireExecutiveLink === true/.test(svc), true);
  eq('upload-ticket API が受ける',
    /requireExecutiveLink: body\.requireExecutiveLink === true/.test(api), true);
  // **既存 migration は編集していない**
  eq('20260910000020 を編集していない',
    /require_executive_link/.test(read(MIG_AD_HOC)), false);
}

console.log('');
if (fails.length) {
  console.log(`✗ ${fails.length} 件 失敗`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✓ すべて通過 — Executive は UUID だけ・日付は各検査自身のもの・Phase A の装置は不変');
