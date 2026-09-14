#!/usr/bin/env node
/**
 * トランスコスモス10名 v3.0 — 納品ゲート (§15〜§17) と S3 同一性 (§18) の回帰チェック。
 *
 * 【何を守っているか】
 * ここは**取り返しがつかない側**。間違えると他人のデータを上書きするか、
 * 中身が違うものを「納品済み」と記録する。どちらも後から直せない。
 *
 *  - **ETag を同一性の根拠にしない** (§18.4 / Appendix F-12)。
 *    マルチパートや SSE-KMS だと ETag は本文の SHA-256 と一致しない。
 *    → 「ETag は合っているが本文が違う」世界で **mismatch と言えること**を固定する。
 *  - **Head だけで成功にしない** (§18.3)。「在る」と「中身が合っている」は別。
 *  - **既存が違うときは BLOCK**。上書きも削除再実行もしない (Appendix F-14)。
 *  - **`HealthAgeData` が在るだけで 3 形式を止めない** (§15)。
 *    v2 ではここを「未知の format」と数えて **10 名全員が止まった**。
 *  - **1 人の BLOCK が他 9 人を巻き込まない** (§17 末尾)。
 *
 * **合成データだけ**を使う。
 * 実行: node scripts/verify-transcos-v3-delivery.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';

let pass = 0;
const failures = [];
const ok = (n, c, d = '') => { if (c) { pass += 1; return; } failures.push(`${n}${d ? ` — ${d}` : ''}`); };
const eq = (n, a, e) => ok(n, JSON.stringify(a) === JSON.stringify(e), `期待 ${JSON.stringify(e)} / 実際 ${JSON.stringify(a)}`);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(repoRoot, '.verify-v3d-'));
writeFileSync(join(tmp, 'delivery.js'), ts.transpileModule(
  readFileSync(join(repoRoot, 'src/lib/transcos-v3/delivery.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const D = await import(pathToFileURL(join(tmp, 'delivery.js')).href);
// `checkWriteTarget()` を**実際に呼ぶ**ため write-guard も落としてくる (`../s3` だけ差し替え)。
writeFileSync(join(tmp, 's3.js'), 'export function getS3Config(){return null;}\nexport function makeS3Client(){return null;}\n');
writeFileSync(join(tmp, 'write-guard.js'), ts.transpileModule(
  readFileSync(join(repoRoot, 'src/lib/ad-hoc-diagnosis/write-guard.ts'), 'utf8')
    .split("from '../s3'").join("from './s3.js'"),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);

const CID = '11111111-2222-3333-4444-555555555555';
const DATE = '2025-09-25';
const SV = 'elith-v1.0';
const expect = (over = {}) => ({ clientId: CID, formatId: 'HealthCheckupData', testDate: DATE, schemaVersion: SV, ...over });
const keyMeta = (over = {}) => ({ clientId: CID, testDate: DATE, formatId: 'HealthCheckupData', ...over });
const bodyOf = (over = {}) => Buffer.from(JSON.stringify({
  client_id: CID, format_id: 'HealthCheckupData', test_date: DATE, schema_version: SV,
  data: { items: [{ item_name: '身長', value_num: 170 }] }, ...over,
}), 'utf8');

// ===========================================================================
// ① §18.2 env を既存 ad-hoc と共用しない
// ===========================================================================
{
  eq('v3 の enable env', D.V3_WRITE_ENV.enabled, 'TRANSCOS_V3_ELITH_WRITE_ENABLED');
  eq('v3 の target env', D.V3_WRITE_ENV.target, 'TRANSCOS_V3_ELITH_WRITE_TARGET');
  ok('既存 ad-hoc の env 名と一致しない',
    !D.V3_WRITE_ENV.enabled.startsWith('AD_HOC_') && !D.V3_WRITE_ENV.target.startsWith('AD_HOC_'));
  /*
   * **判定そのものは写さない** — `checkWriteTarget()` を env 名だけ差し替えて使う。
   * ここは**実際に呼んで**確かめる。ソースの正規表現で見ていたときは、
   * 引数を消しても本体に `envNames` の語が残るので**退行を注入しても通った** (実測)。
   */
  const W = await import(pathToFileURL(join(tmp, 'write-guard.js')).href);
  const saved = { ...process.env };
  try {
    delete process.env.AD_HOC_ELITH_WRITE_ENABLED;
    delete process.env.TRANSCOS_V3_ELITH_WRITE_ENABLED;
    process.env.AD_HOC_ELITH_WRITE_ENABLED = 'on';
    // v3 の env は未設定 → **ad-hoc が on でも v3 は止まる** (§18.2)
    const call = (arg) => {
      // **throw を名前つきの失敗へ変換する** (throw は退行として読めない)。
      try { return arg === undefined ? W.checkWriteTarget() : W.checkWriteTarget(arg); }
      catch (err) { return { ok: null, detail: `checkWriteTarget が throw: ${err instanceof Error ? err.message : String(err)}` }; }
    };
    const r = call(D.V3_WRITE_ENV);
    ok('ad-hoc が on でも v3 は止まる', r.ok === false, JSON.stringify(r));
    ok('止まった理由が v3 の env 名を指す',
      String(r.detail ?? '').includes(D.V3_WRITE_ENV.enabled), JSON.stringify(r));
    // 逆: v3 だけ on にしても、ad-hoc 既定の呼び出しは止まったまま
    delete process.env.AD_HOC_ELITH_WRITE_ENABLED;
    process.env.TRANSCOS_V3_ELITH_WRITE_ENABLED = 'on';
    const r2 = call(undefined);
    ok('v3 が on でも ad-hoc は止まる', r2.ok === false, JSON.stringify(r2));
    ok('その理由は ad-hoc の env 名を指す',
      String(r2.detail ?? '').includes('AD_HOC_ELITH_WRITE_ENABLED'), JSON.stringify(r2));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  const dv = readFileSync(join(repoRoot, 'src/lib/transcos-v3/delivery.ts'), 'utf8');
  ok('v3 側が正規化規則を写していない',
    !dv.includes('normalizeS3Uri') && !dv.includes('actualTargetUri'));
}

// ===========================================================================
// ② §16 body validation
// ===========================================================================
{
  ok('正しい body は通る', D.validateFormatBody(bodyOf(), expect(), keyMeta()).ok);
  const zero = D.validateFormatBody(Buffer.alloc(0), expect(), keyMeta());
  ok('0 バイトは不可', !zero.ok);
  // **理由まで固定する** — JSON parse の失敗でも不可にはなるが、
  // 「本文が 0 バイト」と言えないと運用で原因が読めない (明示チェックを外すと落ちる)。
  ok('0 バイトだと分かる理由が出る', (zero.reasons ?? []).some((s) => s.includes('0 バイト')),
    JSON.stringify(zero));
  ok('JSON でなければ不可', !D.validateFormatBody(Buffer.from('not json'), expect(), keyMeta()).ok);
  ok('配列は不可', !D.validateFormatBody(Buffer.from('[]'), expect(), keyMeta()).ok);
  for (const [label, over] of [
    ['client_id', { client_id: 'other' }], ['format_id', { format_id: 'GeneticTestResultData' }],
    ['test_date', { test_date: '2025-01-01' }], ['schema_version', { schema_version: 'x' }],
  ]) {
    const r = D.validateFormatBody(bodyOf(over), expect(), keyMeta());
    ok(`body の ${label} 違いは不可`, !r.ok);
    ok(`${label} の理由が出る`, (r.reasons ?? []).some((x) => x.includes(label)), JSON.stringify(r));
  }
  // key と body の食い違い
  ok('key の日付が違えば不可', !D.validateFormatBody(bodyOf(), expect(), keyMeta({ testDate: '2025-01-01' })).ok);
  ok('key を解析できていなければ不可', !D.validateFormatBody(bodyOf(), expect(), null).ok);
}

// ===========================================================================
// ③ §18.1 既存 object の判定 — **ETag を根拠にしない**
// ===========================================================================
{
  const body = bodyOf();
  eq('既存が無ければ missing',
    D.judgeExisting({ exists: false, bodyBytes: null }, body, expect(), keyMeta()).kind, 'missing');
  eq('本文が完全一致なら already_verified',
    D.judgeExisting({ exists: true, bodyBytes: body }, body, expect(), keyMeta()).kind, 'already_verified');

  // **本命**: ETag は一致しているが本文が違う
  const other = bodyOf({ test_date: DATE, data: { items: [{ item_name: '身長', value_num: 171 }] } });
  const sameEtag = { exists: true, bodyBytes: other, etag: '"same-etag"' };
  const v = D.judgeExisting(sameEtag, body, expect(), keyMeta());
  eq('ETag が同じでも本文が違えば mismatch', v.kind, 'mismatch');
  // **`.reasons` を素で触らない** — mismatch でないときは undefined なので、
  // 退行を注入したとき「名前つきの失敗」でなく TypeError になり、原因が読めなくなる。
  ok('理由に SHA-256 が出る', (v.reasons ?? []).some((s) => s.includes('SHA-256')), JSON.stringify(v));
  // **逆も**: ETag が違っても本文が同じなら already_verified (ETag で止めない)
  eq('ETag が違っても本文が同じなら already_verified',
    D.judgeExisting({ exists: true, bodyBytes: body, etag: '"different"' }, body, expect(), keyMeta()).kind,
    'already_verified');
  // ソースに ETag 比較が無いこと
  const src = readFileSync(join(repoRoot, 'src/lib/transcos-v3/delivery.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('コードが etag を比較していない', !/etag\s*[!=]==/i.test(src) && !/===\s*[\w.]*etag/i.test(src));
}

// ===========================================================================
// ④ §18.3 読み戻し — Head だけで成功にしない
// ===========================================================================
{
  const body = bodyOf();
  ok('本文が一致すれば PASS', D.judgeReadback({ exists: true, bodyBytes: body }, body, expect(), keyMeta()).ok);
  const gone = D.judgeReadback({ exists: false, bodyBytes: null }, body, expect(), keyMeta());
  ok('GetObject できなければ FAIL', !gone.ok);
  // **「在るが本文を取れていない」= Head しか見ていない状態**。ここを PASS にしない。
  const headOnly = D.judgeReadback({ exists: true, bodyBytes: null }, body, expect(), keyMeta());
  ok('exists だけで本文が無ければ FAIL', !headOnly.ok, JSON.stringify(headOnly));
  const trunc = D.judgeReadback({ exists: true, bodyBytes: body.subarray(0, body.length - 1) }, body, expect(), keyMeta());
  ok('1 バイト欠けていれば FAIL', !trunc.ok);
  ok('バイト数違いの理由が出る', (trunc.reasons ?? []).some((s) => s.includes('バイト数')), JSON.stringify(trunc));
}

// ===========================================================================
// ⑤ §17 人物ゲート
// ===========================================================================
const built = (over = []) => [
  { formatId: 'HealthCheckupData', testDate: DATE, bodyOk: true },
  { formatId: 'LifestyleQuestionnaireData', testDate: '2026-07-12', bodyOk: true },
  { formatId: 'GeneticTestResultData', testDate: '2026-08-12', bodyOk: true },
  ...over,
];
const gate = (over = {}) => { try { return D.checkSubjectGate({
  subject: 'テスト 太郎', manifestResolved: true, executiveLinked: true, clientId: CID,
  healthPass: true, questionnairePass: true, geneticPass: true,
    built: built(), humanPending: 0, sourceValidationPass: true, ...over,
  });
  } catch (err) {
    // **throw は「名前つきの失敗」にならない**ので、ここで失敗へ変換する。
    return { subject: '(throw)', ok: false, reasons: [`checkSubjectGate が throw: ${err instanceof Error ? err.message : String(err)}`] };
  }
};
{
  ok('全部揃えば PASS', gate().ok, JSON.stringify(gate().reasons));
  for (const [label, over, needle] of [
    ['manifest 未確定', { manifestResolved: false }, 'manifest'],
    ['Executive 未リンク', { executiveLinked: false }, 'Executive'],
    ['client_id 未確定', { clientId: null }, 'client_id'],
    ['Health NG', { healthPass: false }, 'Health'],
    ['Questionnaire NG', { questionnairePass: false }, 'Questionnaire'],
    ['Genetic NG', { geneticPass: false }, 'Genetic'],
    ['人の確認待ち', { humanPending: 1 }, '確認待ち'],
    ['source 照合 NG', { sourceValidationPass: false }, 'source'],
  ]) {
    const r = gate(over);
    ok(`${label} で BLOCK`, !r.ok);
    ok(`${label} の理由が出る`, (r.reasons ?? []).some((x) => x.includes(needle)), JSON.stringify(r));
  }

  // §15: 派生 format は在っても止めない / 未知だけ止める
  const derived = gate({ built: built([{ formatId: 'HealthAgeData', testDate: DATE, bodyOk: true }]) });
  ok('HealthAgeData が在っても BLOCK しない', derived.ok, JSON.stringify(derived.reasons));
  const unknown = gate({ built: built([{ formatId: 'MysteryData', testDate: DATE, bodyOk: true }]) });
  ok('未知の format は BLOCK', !unknown.ok);
  ok('未知の format 名が理由に出る', (unknown.reasons ?? []).some((s) => s.includes('MysteryData')), JSON.stringify(unknown));

  // §17-7: ちょうど 1 件
  const dup = gate({ built: built([{ formatId: 'HealthCheckupData', testDate: DATE, bodyOk: true }]) });
  ok('同じ format が 2 件なら BLOCK', !dup.ok);
  const lack = gate({ built: built().filter((b) => b.formatId !== 'GeneticTestResultData') });
  ok('1 形式欠けたら BLOCK', !lack.ok);
  ok('欠けた形式名が出る', (lack.reasons ?? []).some((s) => s.includes('GeneticTestResultData')), JSON.stringify(lack));
  const noDate = gate({ built: built().map((b) => b.formatId === 'GeneticTestResultData' ? { ...b, testDate: null } : b) });
  ok('test_date 未確定なら BLOCK', !noDate.ok);
  const badBody = gate({ built: built().map((b) => b.formatId === 'HealthCheckupData' ? { ...b, bodyOk: false } : b) });
  ok('body が §16 を満たさなければ BLOCK', !badBody.ok);

  // **1 人の BLOCK が他へ波及しない** = 判定が 1 人ぶんで閉じている
  const blocked = gate({ healthPass: false });
  const fine = gate();
  ok('BLOCK した人物の隣は PASS のまま', !blocked.ok && fine.ok);
  eq('理由に他人の名前が出ない', blocked.subject, 'テスト 太郎');
}

// ===========================================================================
// ⑥ §18.4 status
// ===========================================================================
{
  ok('3 件とも created_verified なら complete',
    D.subjectComplete(['created_verified', 'created_verified', 'created_verified']));
  ok('created と already の混在も complete',
    D.subjectComplete(['created_verified', 'already_verified', 'created_verified']));
  ok('readback FAIL が 1 件でもあれば complete でない',
    !D.subjectComplete(['created_verified', 'readback_failed', 'created_verified']));
  ok('mismatch が 1 件でもあれば complete でない',
    !D.subjectComplete(['created_verified', 'blocked_existing_mismatch', 'created_verified']));
  ok('未着手が混じれば complete でない',
    !D.subjectComplete(['created_verified', 'not_attempted', 'created_verified']));
  // **件数が足りないのに complete にしない** (2 件しか見ていないのに緑にする事故)
  ok('2 件だけなら complete でない', !D.subjectComplete(['created_verified', 'created_verified']));
  ok('0 件なら complete でない', !D.subjectComplete([]));
}

rmSync(tmp, { recursive: true, force: true });
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 件 失敗 (${pass} 件 通過)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ ${pass} 件 通過 — 同一性は本文の SHA-256 だけで決まり、既存が違えば止まる`);
