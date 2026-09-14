#!/usr/bin/env node
/**
 * 臨時診断バッチ: **`normalized_payload` の PII ゲートが 1 本であること**の回帰チェック。
 *
 * 【なぜ要るか】実データ E2E で `classify-entry` が落ちた (2026-09-14):
 *
 *   normalized_payload に禁止キー: upsertFileByEntryIndex[0] [M-NAME]
 *
 * 原因は**判定を 2 か所で実装していたこと**。組み立て側 (`normalized-payload.ts`) は
 * production の設問 id を完全一致で除外していたのに、**書き込みの扉 (`store.ts`)** が
 * `assertNoPiiKeys()` を**除外なしで**もう一度呼んでいたため、`M-NAME` が `name` の
 * 部分一致で再び拒否された。**規則が 2 つあると片方だけ直って同じ事故が再発する。**
 *
 * ここで固定するのは 3 つ。
 *   ① 判定の入口は `assertNormalizedPayloadSafe()` **1 本だけ**
 *      (store 側に設問 id の一覧を複製していない)
 *   ② `M-NAME` を含む実物の `EntryPayload` が **DB 直前まで通る**
 *   ③ 本物の PII キー (`display_name` 等) と、**production に無い** `UNKNOWN-NAME` は
 *      同じ経路で**止まる** (= 安全性は 1 ミリも緩んでいない)
 *
 * **外部 DB を使わない。** `store.ts` を transpile し Supabase クライアントをスタブへ
 * 差し替えて、`upsertFileByEntryIndex` / `replaceFiles` / `updateFile` を実際に呼ぶ。
 * **合成データだけを使う** (実在役員の回答は 1 件も入れない)。
 *
 * 実行: node scripts/verify-ad-hoc-payload-gate.mjs
 */
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
const tmp = mkdtempSync(join(repoRoot, '.verify-pg-'));

// ===========================================================================
// ① 判定の入口が 1 本であること (規則を 2 か所に持たない)
// ===========================================================================
{
  const storeSrc = strip(read('src/lib/ad-hoc-diagnosis/store.ts'));
  ok('store は正本の関数だけを import する',
    /import \{ assertNormalizedPayloadSafe \} from '\.\/normalized-payload'/.test(storeSrc));
  ok('store が assertNoPiiKeys を直接呼ばない',
    !/assertNoPiiKeys\(/.test(storeSrc),
    '除外なしの検査が残っている (M-NAME が扉で落ちる)');
  ok('store に設問 id の一覧を複製していない',
    !/QUESTION_ID_KEYS|QUESTIONS/.test(storeSrc));
  // 扉は 2 つ: `guardPayload()` (replaceFiles / upsertFileByEntryIndex) と `updateFile`。
  eq('書き込みの扉が全部 正本を通る',
    (storeSrc.match(/assertNormalizedPayloadSafe\(/g) ?? []).length, 2);

  const npSrc = strip(read('src/lib/ad-hoc-diagnosis/normalized-payload.ts'));
  ok('正本の関数が公開されている',
    /export function assertNormalizedPayloadSafe\(payload: unknown, where: string\): void \{/.test(npSrc));
  ok('正本は設問 id を完全一致で除外する',
    /assertNoPiiKeys\(payload, where, QUESTION_ID_KEYS\);/.test(npSrc));
  ok('除外は Set の完全一致 (部分一致にしない)',
    /if \(allowKeys\.has\(k\)\) continue;/.test(npSrc));
  ok('組み立て側も正本を通る',
    (npSrc.match(/assertNormalizedPayloadSafe\(/g) ?? []).length >= 4);
}

// ===========================================================================
// 実物を動かす (Supabase はスタブ)
// ===========================================================================
const rel = (src) => src
  .replace(`from '../supabase'`, `from './supabase.js'`)
  .replace(`from './classify'`, `from './classify.js'`)
  .replace(`from './archive'`, `from './archive.js'`)
  .replace(`from './normalized-payload'`, `from './normalized-payload.js'`)
  .replace(`from './health-checkup-xlsx'`, `from './health-checkup-xlsx.js'`)
  .replace(`from './questionnaire'`, `from './questionnaire.js'`)
  .replace(`from './questionnaire-manual'`, `from './questionnaire-manual.js'`)
  .replace(`from './questionnaire-branch'`, `from './questionnaire-branch.js'`)
  .replace(`from './external-form-contract'`, `from './external-form-contract.js'`)
  .replace(`from './questionnaire-map'`, `from './questionnaire-map.js'`)
  .replace(`from '../../scripts/chat/interview-script'`, `from './interview-script.js'`);

const writeTs = (relPath, outName) => {
  const js = ts.transpileModule(rel(read(relPath)), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  writeFileSync(join(tmp, outName), js);
};

/*
 * **Supabase のスタブ。** DB へは 1 バイトも送らない。
 * `insert` / `update` が呼ばれたことだけを記録して「扉を通った」と判定する。
 */
writeFileSync(join(tmp, 'supabase.js'), `
export const __db = { inserts: [], updates: [], selects: [] };
function builder(table) {
  const self = {
    __table: table,
    select() { return self; },
    eq() { return self; },
    order() { return self; },
    limit() { return self; },
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: { id: 'stub-row' }, error: null }),
    insert(rows) { __db.inserts.push({ table, rows }); return self; },
    update(patch) { __db.updates.push({ table, patch }); return self; },
    delete() { return self; },
    then(res) { return Promise.resolve({ data: [], error: null }).then(res); },
  };
  return self;
}
export function getServerSupabase() {
  const client = { from: (t) => builder(t) };
  return { ...client, schema: () => client };
}
`);

writeTs('src/scripts/chat/interview-script.ts', 'interview-script.js');
writeTs('src/lib/ad-hoc-diagnosis/classify.ts', 'classify.js');
writeTs('src/lib/ad-hoc-diagnosis/archive.ts', 'archive.js');
writeTs('src/lib/ad-hoc-diagnosis/health-checkup-xlsx.ts', 'health-checkup-xlsx.js');
writeTs('src/lib/ad-hoc-diagnosis/questionnaire-map.ts', 'questionnaire-map.js');
writeTs('src/lib/ad-hoc-diagnosis/external-form-contract.ts', 'external-form-contract.js');
writeTs('src/lib/ad-hoc-diagnosis/questionnaire.ts', 'questionnaire.js');
writeTs('src/lib/ad-hoc-diagnosis/questionnaire-manual.ts', 'questionnaire-manual.js');
writeTs('src/lib/ad-hoc-diagnosis/questionnaire-branch.ts', 'questionnaire-branch.js');
writeTs('src/lib/ad-hoc-diagnosis/normalized-payload.ts', 'normalized-payload.js');
writeTs('src/lib/ad-hoc-diagnosis/store.ts', 'store.js');

const np = await import(pathToFileURL(join(tmp, 'normalized-payload.js')).href);
const store = await import(pathToFileURL(join(tmp, 'store.js')).href);
const sb = await import(pathToFileURL(join(tmp, 'supabase.js')).href);
const q = await import(pathToFileURL(join(tmp, 'questionnaire.js')).href);
const br = await import(pathToFileURL(join(tmp, 'questionnaire-branch.js')).href);
const contract = await import(pathToFileURL(join(tmp, 'external-form-contract.js')).href);

// ---------------------------------------------------------------------------
// 合成データ: 「服薬あり」で M-NAME を含む実物の EntryPayload を作る
// ---------------------------------------------------------------------------
const HEADERS = contract.EXTERNAL_FORM_V1_COLUMNS.map((c) => c.header);
const DONE_AT = new Date(Date.UTC(2026, 6, 12, 7, 5, 45)); // read-excel-file は Date を返す
function row(overrides) {
  const r = new Array(HEADERS.length).fill('');
  const put = (i, v) => { r[i - 1] = v; };
  put(3, DONE_AT); put(8, '19700101'); put(9, '男性');
  put(10, '172'); put(11, '65');
  put(18, '吸ったことはない'); put(22, '元々まったく飲まない');
  put(41, 'ほとんどしない');
  // **服薬あり** → M-NAME / M-PERIOD / M-FREQ が production でも質問される = answers に入る
  put(46, 'ある'); put(47, 'ロキソニン（頭痛）'); put(48, '1年以上'); put(49, '毎日');
  put(50, '6〜7時間'); put(51, '普通'); put(52, '5');
  for (const [i, v] of Object.entries(overrides ?? {})) put(Number(i), v);
  return r;
}
const normalized = br.finalizeQuestionnaire(q.normalizeExternalFormRow(HEADERS, row()), null);
eq('合成データに M-NAME が入っている', normalized.answers['M-NAME'], 'ロキソニン（頭痛）');

/*
 * **組み立てで throw したら、そこで名前を付けて落とす。**
 * 例外をそのまま投げると「何かが throw した」までしか分からず、
 * 「組み立て側の除外が外れた」のか「別の不具合」なのか読めない。
 */
let entry = null;
let buildErr = null;
try { entry = np.buildEntryPayload({ questionnaire: normalized }); }
catch (e) { buildErr = String(e && e.message ? e.message : e); }
ok('EntryPayload が組める (組み立て側で落ちない)', entry != null, buildErr ?? '(null が返った)');
if (entry == null) {
  rmSync(tmp, { recursive: true, force: true });
  console.error(`\n✗ verify:ad-hoc-payload-gate  ${pass}/${pass + failures.length}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
ok('payload のキーに M-NAME が実在する',
  JSON.stringify(entry).includes('"M-NAME"'));

const fileWrite = (payload) => ({
  batch_id: '00000000-0000-4000-8000-000000000001',
  display_name: 'x',
  sha256: 'a'.repeat(64),
  size_bytes: 1,
  source_kind: 'person_file',
  normalized_payload: payload,
});
const reset = () => { sb.__db.inserts = []; sb.__db.updates = []; };
const callOf = async (fn) => {
  try { await fn(); return null; } catch (e) { return String(e && e.message ? e.message : e); }
};

// ===========================================================================
// ② M-NAME を含む payload が DB 直前まで通る (E2E で落ちた経路そのもの)
// ===========================================================================
{
  reset();
  const err = await callOf(() =>
    store.upsertFileByEntryIndex('00000000-0000-4000-8000-000000000001', 0, fileWrite(entry)));
  /*
   * **スタブは select→insert を通るので例外は出ない。**
   * ゲートで落ちていれば `normalized_payload に禁止キー` が返る。
   */
  ok('upsertFileByEntryIndex が M-NAME で落ちない', err === null, err ?? '');
  ok('DB への書き込みまで到達した', sb.__db.inserts.length > 0 || sb.__db.updates.length > 0);
}
{
  reset();
  const err = await callOf(() => store.replaceFiles('00000000-0000-4000-8000-000000000001', [fileWrite(entry)]));
  ok('replaceFiles も M-NAME で落ちない', err === null, err ?? '');
}
{
  reset();
  const err = await callOf(() => store.updateFile('00000000-0000-4000-8000-000000000002', { normalized_payload: entry }));
  ok('updateFile も M-NAME で落ちない', err === null, err ?? '');
  ok('update まで到達した', sb.__db.updates.length > 0);
}

// ===========================================================================
// ③ 安全性は緩んでいない — 同じ経路で本物の PII と未知キーは止まる
// ===========================================================================
const blocked = async (label, payload, expectKey) => {
  reset();
  const err = await callOf(() =>
    store.upsertFileByEntryIndex('00000000-0000-4000-8000-000000000001', 0, fileWrite(payload)));
  ok(`${label} は store の扉で止まる`, err !== null && /禁止キー/.test(err), err ?? '(通ってしまった)');
  if (expectKey) ok(`${label} の理由にキー名が出る`, (err ?? '').includes(expectKey), err ?? '');
  eq(`${label} は DB へ書かれない`, sb.__db.inserts.length + sb.__db.updates.length, 0);
};

await blocked('display_name', { ...entry, extra: { display_name: 'x' } }, 'display_name');
await blocked('full_name', { ...entry, extra: { full_name: 'x' } }, 'full_name');
await blocked('file_name', { ...entry, extra: { file_name: 'x' } }, 'file_name');
await blocked('name', { ...entry, extra: { name: 'x' } }, 'name');
await blocked('email', { ...entry, extra: { email: 'x' } }, 'email');
await blocked('date_of_birth', { ...entry, extra: { date_of_birth: 'x' } }, 'date_of_birth');
await blocked('company', { ...entry, extra: { company: 'x' } }, 'company');
/*
 * **production に無い id は通さない。** 「`-NAME` で終われば設問 id」のような
 * 緩い判定へ退行すると、ここが通ってしまう。
 */
await blocked('UNKNOWN-NAME (production に無い)',
  { ...entry, questionnaire: { ...entry.questionnaire, answers: { 'UNKNOWN-NAME': 'x' } } },
  'UNKNOWN-NAME');

// 関数を直に呼んでも同じ判定であること (扉と組み立てで規則が食い違わない)。
{
  let threw = null;
  try { np.assertNormalizedPayloadSafe({ 'M-NAME': 'x' }, 'direct'); } catch (e) { threw = String(e); }
  eq('正本を直に呼んでも M-NAME は通る', threw, null);
  let threw2 = null;
  try { np.assertNormalizedPayloadSafe({ display_name: 'x' }, 'direct'); } catch { threw2 = true; }
  eq('正本を直に呼んでも display_name は止まる', threw2, true);
  let threw3 = null;
  try { np.assertNormalizedPayloadSafe({ 'UNKNOWN-NAME': 'x' }, 'direct'); } catch { threw3 = true; }
  eq('正本を直に呼んでも未知の id は止まる', threw3, true);
}

// 除外している id が **実在の設問 id だけ**であること (数も含めて固定しない = 問診票を直せる)。
{
  const ids = Object.keys((await import(pathToFileURL(join(tmp, 'interview-script.js')).href)).QUESTIONS);
  ok('設問 id の出どころは production の QUESTIONS', ids.includes('M-NAME') && ids.length > 20,
    `${ids.length} 件`);
  deepEq('M-NAME 以外に name を含む設問 id が増えていないか (増えたら要確認)',
    ids.filter((i) => /name/i.test(i)).sort(), ['M-NAME']);
}

// ---------------------------------------------------------------------------
rmSync(tmp, { recursive: true, force: true });
const total = pass + failures.length;
if (failures.length) {
  console.error(`\n✗ verify:ad-hoc-payload-gate  ${pass}/${total}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ verify:ad-hoc-payload-gate  ${pass}/${total}`);
