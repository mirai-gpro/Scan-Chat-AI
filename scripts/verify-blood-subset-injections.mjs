#!/usr/bin/env node
/**
 * **退行注入**: `verify:blood-subset` が本当に落ちることを機械で確かめる。
 *
 * 正本: `docs/specs/healthcheckup_blood_extraction_spec_20261001.md` §12.4（R-1〜R-19）。
 *
 * ここで守りたいのは「検査が緑なのは、壊れていないからであって、何も見ていないからではない」
 * という一点。**退行を 1 つずつ入れて、名指しで落ちること**を確認する。
 *
 *   node scripts/verify-blood-subset-injections.mjs
 *
 * ファイルは必ず元に戻す（成功しても失敗しても）。途中で止めても戻るよう、
 * 各注入ごとにバックアップ → 実行 → 復元 を 1 サイクルで閉じる。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const INJECTIONS = [
  { id: 'R-1',  file: 'src/lib/blood-subset.ts',
    why: '欠損項目を 0 で埋める',
    from: '    if (!list || list.length === 0) continue;   // 無い項目は行ごと出さない（0 にしない）',
    to:   "    if (!list || list.length === 0) { kept.push({ name: item, value: '0', value_num: 0, unit: null, ref_low: null, ref_high: null, flag: null }); continue; }",
    expect: ['B 総コレステロールなし', '0 で埋めていない'] },

  { id: 'R-3',  file: 'src/lib/blood-subset.ts',
    why: 'findByAlias を部分一致に緩める（15 項目以外を拾う）',
    from: '  const hit = findByAlias(rawName);\n  if (!hit) return null;',
    to:   "  const hit = findByAlias(rawName) ?? findByAlias(String(rawName ?? '').replace(/^(随時|空腹時)/, ''));\n  if (!hit) return String(rawName ?? '').includes('血糖') ? '空腹時血糖' : null;",
    expect: ['E-8 **「随時血糖」を空腹時血糖へ推測マッピングしない**'] },

  { id: 'R-4',  file: 'src/lib/scan-persist.ts',
    why: '冪等キーから imported_by を外す',
    from: '      importedBy: DERIVED_HC_BLOOD_IMPORTED_BY,\n    });',
    to:   '    });',
    expect: ['冪等キーに imported_by が入る'] },

  { id: 'R-5',  file: 'src/lib/scan-persist.ts',
    why: "派生 artifact の source を 'wellfort_lab' にする",
    from: "          source: 'user_upload',\n          test_type: 'blood',",
    to:   "          source: 'wellfort_lab',\n          test_type: 'blood',",
    expect: ['L source = user_upload'] },

  { id: 'R-6',  file: 'src/lib/elith-delivery.ts',
    why: '派生 BloodTestData に raw_markdown を載せる',
    from: "      data: { measurements, notes: [] as unknown[] },\n      // raw_markdown は載せない（上のコメント）。",
    to:   "      data: { measurements, notes: [] as unknown[] },\n      raw_markdown: 'x',",
    expect: ['raw_markdown を載せない'] },

  { id: 'R-7',  file: 'src/lib/blood-subset.ts',
    why: '15 項目のマスタに 随時血糖 を足す',
    from: "  '空腹時血糖',        // 10. 空腹時血糖",
    to:   "  '空腹時血糖',        // 10. 空腹時血糖\n  '随時血糖',",
    expect: ['A **対象マスタはちょうど 15 件**'] },

  { id: 'R-10', file: 'src/lib/elith-entitlement.ts',
    why: 'readiness の除外を消す（派生を数えてしまう）',
    from: '  return rows.filter((r) => !isDerivedHealthCheckBlood(r));',
    to:   '  return [...rows];',
    expect: ['K 派生 blood は数えない'] },

  { id: 'R-11', file: 'src/lib/elith-entitlement.ts',
    why: "readiness の除外を source='user_upload' ベースにする",
    from: "  return r.test_type === 'blood' && r.imported_by === DERIVED_HC_BLOOD_IMPORTED_BY;",
    to:   "  return r.test_type === 'blood' && r.imported_by !== 'wellfort_admin_upload';",
    expect: ['K-3 **imported_by が違う blood は数える**'] },

  { id: 'R-12', file: 'src/lib/standard-master.ts',
    why: 'STANDARD_MASTER に 空腹時中性脂肪 → 中性脂肪 の alias を足す',
    from: "  { canonical_name: '中性脂肪', synonyms: ['TG', '中性脂肪(TG)', 'トリグリセライド']",
    to:   "  { canonical_name: '中性脂肪', synonyms: ['TG', '中性脂肪(TG)', 'トリグリセライド', '空腹時中性脂肪', '随時中性脂肪']",
    expect: ['M-2 **`中性脂肪` の synonyms に 空腹時/随時 を入れていない**'] },

  { id: 'R-14', file: 'src/lib/measurement-queries.ts',
    why: '混在系列でも基準線を付ける',
    from: '        referenceUpper: mixedOrigin ? undefined : num(last.ref_high_num) ?? undefined,',
    to:   '        referenceUpper: num(last.ref_high_num) ?? undefined,',
    expect: ['N **混在系列では基準線を出さない**'] },

  { id: 'R-15', file: 'src/lib/scan-persist.ts',
    why: '同一日の優先を外す（通常 blood が在っても派生を作る）',
    from: '    if (await hasNormalBloodOnDate(sb, input.diagnosticUserId, input.testDate)) {',
    to:   '    if (false) {',
    expect: ['O **同一日に通常 blood が在れば作らない**'] },

  { id: 'R-16', file: 'src/lib/scan-persist.ts',
    why: '0 件でも artifact を作る',
    from: '    if (kept.length === 0) {\n      return { status: \'skipped\', reason: \'no_target_items\', items: 0, excluded };\n    }',
    to:   '    // injected',
    expect: ['P **artifact も measurement_values も作らない**'] },

  { id: 'R-17', file: 'src/lib/blood-subset.ts',
    why: '競合項目を「先に出てきた方」で確定する',
    from: '    if (conflict) {',
    to:   '    if (false) {',
    expect: ['Q 競合した尿酸は出さない'] },

  { id: 'R-18', file: 'scripts/backfill-derived-blood.mjs',
    why: 'backfill の既定を --apply にする',
    from: "const APPLY = has('--apply');",
    to:   "const APPLY = !has('--dry-run');",
    expect: ['R 書くのは --apply を明示したときだけ'] },

  { id: 'R-19', file: 'src/lib/scan-persist.ts',
    why: 'admin バッチからも派生を作る',
    from: '  // 測定値を持たない形式 (遺伝子 / AI疾病発症予測 = data.items[]) は artifact 行だけで終わる。',
    to:   '  await persistDerivedBloodArtifact(sb, { diagnosticUserId: input.diagnosticUserId, testDate, measurements: input.measurements as never });\n  // 測定値を持たない形式 (遺伝子 / AI疾病発症予測 = data.items[]) は artifact 行だけで終わる。',
    expect: ['S persistAdminBatchArtifact から派生を作っていない'] },

  { id: 'R-20', file: 'src/lib/measurement-queries.ts',
    why: '点に source を載せない（画面の「人間ドックから抽出」が出なくなる）',
    from: '          source: isDerived(r.artifact_id) ? DERIVED_HC_BLOOD_SOURCE : null,',
    to:   '          source: null,',
    expect: ['I 人間ドック由来の点だけに source が付く'] },

  { id: 'R-21', file: 'src/lib/elith-delivery.ts',
    why: '同一日に通常 BloodTestData が在っても派生を書く（納品ファイルを上書き）',
    from: '    if (normalBloodDates.has(dateFolder)) { out.skippedDates.push(dateFolder); continue; }',
    to:   '    // injected',
    expect: ['J 同一日に通常 blood が在れば書かない'] },

  { id: 'R-22', file: 'src/components/dashboard/MetricTrendChart.astro',
    why: '測定履歴テーブルに列を 1 本足す（390px で和文が 1 文字ずつ折れる）',
    from: '<th scope="col" class="px-3 py-2.5 text-right font-semibold text-slate-700">判定</th>',
    to:   '<th scope="col" class="px-3 py-2.5 text-right font-semibold text-slate-700">判定</th>\n                <th scope="col" class="px-3 py-2.5 text-right font-semibold text-slate-700">出所</th>',
    expect: ['I **測定履歴テーブルの列は 4 列のまま**'] },
];

function runVerify() {
  try {
    const out = execFileSync('node', ['scripts/verify-blood-subset.mjs'], { encoding: 'utf8' });
    return { failed: false, out };
  } catch (e) {
    return { failed: true, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

// ベースラインが緑であること（赤いまま注入しても意味が無い）
console.log('\nベースライン確認 …');
const base = runVerify();
if (base.failed) {
  console.error('ベースラインが既に FAIL しています。注入の前に直してください。');
  console.error(base.out.split('\n').slice(-20).join('\n'));
  process.exit(1);
}
console.log('  OK（注入前は緑）\n');

let good = 0;
const bad = [];
for (const inj of INJECTIONS) {
  const orig = readFileSync(inj.file, 'utf8');
  if (!orig.includes(inj.from)) {
    bad.push(`${inj.id}: 注入点が見つからない（${inj.file}）`);
    console.log(`SKIP  ${inj.id}  注入点なし — ${inj.file}`);
    continue;
  }
  writeFileSync(inj.file, orig.replace(inj.from, inj.to));
  const r = runVerify();
  writeFileSync(inj.file, orig); // **必ず戻す**
  const named = inj.expect.every((e) => r.out.includes('FAIL') && r.out.split('\n').some((l) => l.startsWith('FAIL') && l.includes(e)));
  if (r.failed && named) { good++; console.log(`PASS  ${inj.id}  ${inj.why} → 名指しで落ちた`); }
  else {
    bad.push(`${inj.id}: ${r.failed ? '落ちたが名指しでない' : '落ちなかった'} — ${inj.why}`);
    console.log(`FAIL  ${inj.id}  ${inj.why} → ${r.failed ? '落ちたが名指しでない' : '**落ちなかった**'}`);
    if (r.failed) console.log('      ' + r.out.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 4).join('\n      '));
  }
}

console.log('');
console.log('─'.repeat(70));
if (bad.length) {
  console.log(`退行注入 FAILED ${bad.length} / ${INJECTIONS.length}`);
  for (const b of bad) console.log(`  - ${b}`);
  process.exit(1);
}
console.log(`退行注入 ALL PASS (${good} 種とも名指しで落ちた)`);
