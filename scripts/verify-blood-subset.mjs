#!/usr/bin/env node
/**
 * **人間ドック・健康診断由来 血液検査データ（派生 blood）の回帰チェック。** サーバも鍵も要らない。
 *
 * 正本: `docs/specs/healthcheckup_blood_extraction_spec_20261001.md` v2.0（発注者裁定 Q-1〜Q-14）。
 * ケース ID は spec §12.1 / §12.2 の表と 1:1。
 *
 * 【ここで守る約束（静かに壊れるものばかり）】
 *   A〜F  … 15 項目の抽出・欠損は行ごと出さない・計算で埋めない
 *   G/L   … 冪等（imported_by まで見る）・派生の印
 *   H/N   … 時系列の混在・**混在系列では基準線を出さない**
 *   K     … **Elith の揃い判定に数えない**（数えると血液検査の到着前に納品が走る）
 *   M     … **中性脂肪の統合は派生の中だけ**（HealthCheckupData / STANDARD_MASTER を壊さない）
 *   O/P/Q … 同一日は通常 blood 優先 / 0 件なら何も作らない / 競合項目だけ除外
 *   R/S   … backfill は dry-run 既定 / admin バッチは対象外
 */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

const CACHE = 'node_modules/.cache';
mkdirSync(CACHE, { recursive: true });

let pass = 0;
const fails = [];
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  — ' + extra : ''}`); }
  else { fails.push(label); console.log(`FAIL  ${label}${extra ? '  — ' + extra : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

// ── ビルド ──────────────────────────────────────────────────────
async function bundle(entry, outfile, plugins = []) {
  await build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'esm',
    logLevel: 'error', define: { 'import.meta.env': '{}' },
    outfile: `${CACHE}/${outfile}`, plugins,
  });
  return import(`../${CACHE}/${outfile}`);
}

const SUB = await bundle('src/lib/blood-subset.ts', 'vbs-blood-subset.mjs');
const SM = await bundle('src/lib/standard-master.ts', 'vbs-standard-master.mjs');
const ENT = await bundle('src/lib/elith-entitlement.ts', 'vbs-entitlement.mjs');

const lean = (name, value, extra = {}) => ({
  name, value: String(value), value_num: Number.isFinite(Number(value)) ? Number(value) : null,
  unit: null, ref_low: null, ref_high: null, flag: null, ...extra,
});

/** 15 項目すべてが印字された人間ドックの読み取り結果（原本の表記ゆれを混ぜてある）。 */
const FULL = [
  lean('AST(GOT)', 28), lean('ALT(GPT)', 49, { flag: 'H' }), lean('γ-GTP', 35),
  lean('総蛋白', 7.3), lean('アルブミン', 4.4),
  lean('LDL', 156), lean('HDL', 58), lean('総コレステロール', 251), lean('随時中性脂肪', 221),
  lean('空腹時血糖', 104), lean('HbA1c', 5.0),
  lean('クレアチニン', 0.96), lean('e-GFR', 64.6), lean('尿酸', 5.9), lean('尿素窒素', 18.1),
  // 15 項目に入らないもの（混ぜても拾われてはいけない）
  lean('ALP', 76), lean('白血球数', 52), lean('随時血糖', 79), lean('尿蛋白', '(-)'),
  lean('LDLコレステロール(F式)', 102), lean('non-HDLコレステロール', 112),
];

// ════════════════════════════════════════════════════════════════
section('A: 15 項目すべて存在');
{
  const { kept, excluded } = SUB.extractBloodSubset(FULL);
  ok(kept.length === 15, '15 項目ちょうど', `n=${kept.length}`);
  ok(excluded.length === 0, '除外なし', JSON.stringify(excluded));
  const names = kept.map((m) => m.name);
  ok(JSON.stringify(names) === JSON.stringify([...SUB.BLOOD_SUBSET_ITEMS]),
    '並びが BLOOD_SUBSET_ITEMS 固定（読み取り順に依存しない＝冪等）', names.join(','));
  ok(!names.includes('ALP') && !names.includes('白血球数') && !names.includes('随時血糖'),
    '**15 項目以外を拾わない**（ALP / 白血球数 / 随時血糖）', names.join(','));
  ok(!names.includes('LDLコレステロール(F式)') && !names.includes('non-HDLコレステロール'),
    'LDL(F式) / non-HDL は別項目として拾わない', '');
  ok(kept.every((m) => Object.keys(m).length === 7),
    '**フィールドは 7 つちょうど**（裁定 Q-9・独自構造を作らない）',
    JSON.stringify(Object.keys(kept[0])));
  const alt = kept.find((m) => m.name === 'GPT(ALT)');
  ok(alt?.flag === 'H', '原本の H/L をそのまま運ぶ（アプリは判定しない）', String(alt?.flag));
  // 表記ゆれの吸収（裁定 Q-2 の追加分を含む）
  ok(!!kept.find((m) => m.name === 'アルブミン'), 'アルブミンを拾う（★マスタ追加）');
  ok(!!kept.find((m) => m.name === '尿素窒素'), '尿素窒素を拾う（★マスタ追加）');
  ok(kept.find((m) => m.name === 'eGFR')?.value === '64.6', '`e-GFR` 表記を eGFR として拾う（★alias 追加）');
  ok(kept.find((m) => m.name === '中性脂肪')?.value === '221', '随時中性脂肪 → 中性脂肪');
  ok(SUB.BLOOD_SUBSET_ITEMS.length === 15,
    'A **対象マスタはちょうど 15 件**（v1.1 §12「添付基準にない項目を足さない」）',
    String(SUB.BLOOD_SUBSET_ITEMS.length));
  /*
   * E-8: 曖昧な血糖表記を空腹時血糖へ寄せない（v1.1 §5）。
   * **1 件ずつ**見る — 2 件まとめて入れると「競合で除外」でも 0 件になってしまい、
   * 推測マッピングが入り込んでも検知できない（実際に 1 度そうなった）。
   */
  for (const bad of ['随時血糖', '血糖']) {
    const amb = SUB.extractBloodSubset([lean(bad, 79)]);
    ok(amb.kept.length === 0,
      `E-8 **「${bad}」を空腹時血糖へ推測マッピングしない**`, JSON.stringify(amb.kept.map((m) => m.name)));
  }
}

section('B/C/D/E: 欠損は「行ごと出さない」（0 にしない・計算しない）');
{
  const drop = (names) => FULL.filter((m) => !names.includes(m.name));
  const b = SUB.extractBloodSubset(drop(['総コレステロール']));
  ok(b.kept.length === 14 && !b.kept.some((m) => m.name === '総コレステロール'),
    'B 総コレステロールなし → 14 項目・その行は存在しない', `n=${b.kept.length}`);
  ok(!b.kept.some((m) => m.value === '0' || m.value_num === 0), 'B 0 で埋めていない');

  const c = SUB.extractBloodSubset(drop(['尿素窒素']));
  ok(c.kept.length === 14 && !c.kept.some((m) => m.name === '尿素窒素'), 'C 尿素窒素なし → 14 項目');

  const d = SUB.extractBloodSubset(drop(['γ-GTP']));
  ok(d.kept.length === 14 && !d.kept.some((m) => m.name === 'γ-GTP'),
    'D 13 項目側の欠損でも**受診日ごと無効にしない**');

  const e = SUB.extractBloodSubset(drop(['総コレステロール', '尿素窒素', 'γ-GTP', 'ALT(GPT)']));
  ok(e.kept.length === 11, 'E 4 項目欠損 → 11 項目', `n=${e.kept.length}`);
}

section('F: eGFR を計算で補わない');
{
  const f = SUB.extractBloodSubset(FULL.filter((m) => m.name !== 'e-GFR'));
  ok(!f.kept.some((m) => m.name === 'eGFR'), 'eGFR の行が無い（クレアチニンから作らない）');
  ok(!!f.kept.find((m) => m.name === 'クレアチニン'), 'クレアチニンは在る');
}

section('M: 中性脂肪の統合は派生の中だけ（裁定 Q-3）');
{
  for (const [src, label] of [['空腹時中性脂肪', '空腹時'], ['随時中性脂肪', '随時'], ['中性脂肪(TG)', '無修飾(TG)'], ['TG', 'TG']]) {
    const r = SUB.extractBloodSubset([lean(src, 129)]);
    ok(r.kept.length === 1 && r.kept[0].name === '中性脂肪', `M ${label} → 中性脂肪`, r.kept[0]?.name ?? '');
  }
  // M-2: STANDARD_MASTER では 3 つが別物のまま
  ok(SM.findByAlias('空腹時中性脂肪')?.canonical_name === '空腹時中性脂肪',
    'M-2 空腹時中性脂肪 は空腹時中性脂肪のまま');
  ok(SM.findByAlias('随時中性脂肪')?.canonical_name === '随時中性脂肪',
    'M-2 随時中性脂肪 は随時中性脂肪のまま');
  ok(SM.findByAlias('中性脂肪')?.canonical_name === '中性脂肪',
    'M-2 無修飾の中性脂肪 は中性脂肪');
  const tgItem = SM.STANDARD_MASTER.find((x) => x.canonical_name === '中性脂肪');
  ok(!!tgItem && !tgItem.synonyms.some((a) => a.includes('空腹時') || a.includes('随時')),
    'M-2 **`中性脂肪` の synonyms に 空腹時/随時 を入れていない**（グローバル alias にしない）',
    JSON.stringify(tgItem?.synonyms));
  // M-3: 同一日に空腹時と随時が両方 → 値が割れるので中性脂肪だけ除外
  const m3 = SUB.extractBloodSubset([lean('空腹時中性脂肪', 54), lean('随時中性脂肪', 221), lean('尿酸', 5.9)]);
  ok(!m3.kept.some((m) => m.name === '中性脂肪'), 'M-3 空腹時/随時 が両方あれば中性脂肪は出さない');
  ok(m3.kept.some((m) => m.name === '尿酸'), 'M-3 他の項目は通常どおり出す');
  ok(m3.excluded.some((e) => e.item === '中性脂肪' && e.reason === 'value_conflict'),
    'M-3 除外理由を記録する（黙って消さない）', JSON.stringify(m3.excluded));
}

section('P: 0 件なら何も作らない（裁定 Q-6）');
{
  const p = SUB.extractBloodSubset([lean('胸部X線', '異常なし'), lean('ALP', 76), lean('白血球数', 52)]);
  ok(p.kept.length === 0, '対象 15 項目が 0 件', `n=${p.kept.length}`);
  ok(p.excluded.length === 0, '除外も 0（そもそも対象外）');
  const empty = SUB.extractBloodSubset([]);
  ok(empty.kept.length === 0, '空配列でも例外にしない');
  const nul = SUB.extractBloodSubset(null);
  ok(nul.kept.length === 0, 'null でも例外にしない');
}

section('Q: 値の競合は「その項目だけ」除外（裁定 Q-12）');
{
  const q = SUB.extractBloodSubset([lean('尿酸', 5.9), lean('UA', 7.2), lean('HbA1c', 5.0)]);
  ok(!q.kept.some((m) => m.name === '尿酸'), 'Q 競合した尿酸は出さない（推測で片方を選ばない）');
  ok(q.kept.some((m) => m.name === 'HbA1c(NGSP)'), 'Q 他の項目は通常どおり');
  ok(q.excluded.some((e) => e.item === '尿酸'), 'Q 除外を記録');
  // 同値なら統合して 1 件
  const same = SUB.extractBloodSubset([lean('尿酸', 5.9), lean('UA', 5.9)]);
  ok(same.kept.length === 1 && same.kept[0].value === '5.9', 'Q 同じ値なら 1 件に統合（競合扱いしない）');
}

section('K: Elith の揃い判定に数えない（裁定 Q-4・最重要）');
{
  const DERIVED = SUB.DERIVED_HC_BLOOD_IMPORTED_BY;
  const rows = [
    { diagnostic_user_id: 'u1', test_type: 'blood', imported_by: DERIVED },
    { diagnostic_user_id: 'u1', test_type: 'health_checkup', imported_by: 'user' },
  ];
  const kept = ENT.readinessCountableRows(rows);
  ok(!kept.some((r) => r.test_type === 'blood'), 'K 派生 blood は数えない');
  ok(kept.some((r) => r.test_type === 'health_checkup'), 'K-2 health_checkup は従来どおり数える');

  // K-2: blood 以外は 1 件も落とさない
  const others = ['health_checkup', 'cancer_urine', 'genetics', 'ai_prediction']
    .map((t) => ({ diagnostic_user_id: 'u1', test_type: t, imported_by: DERIVED }));
  ok(ENT.readinessCountableRows(others).length === 4,
    'K-2 **blood 以外は imported_by が何であっても落とさない**', String(ENT.readinessCountableRows(others).length));

  // K-3: source='user_upload' 全体で切っていない（将来の実血液 user upload を巻き込まない）
  const futureUserBlood = [{ diagnostic_user_id: 'u1', test_type: 'blood', imported_by: 'user' }];
  ok(ENT.readinessCountableRows(futureUserBlood).length === 1,
    'K-3 **imported_by が違う blood は数える**（将来の実血液 user upload 経路を排除しない）');
  const labBlood = [{ diagnostic_user_id: 'u1', test_type: 'blood', imported_by: 'wellfort_admin_upload' }];
  ok(ENT.readinessCountableRows(labBlood).length === 1, 'K-3 通常の検査機関由来 blood は数える');

  // 実クエリが imported_by を引いているか（引いていないと上の判定が常に通ってしまう）
  const src = readFileSync('src/lib/elith-entitlement.ts', 'utf8');
  ok(/\.select\(\s*\n?\s*\/\/[^\n]*\n?\s*'diagnostic_user_id, test_type, imported_by'/.test(src)
     || src.includes("'diagnostic_user_id, test_type, imported_by'"),
    'K select に imported_by が入っている');
  ok(src.includes('readinessCountableRows((data ?? [])'), 'K 取得結果を readinessCountableRows に通している');
}

section('L: 派生の印（裁定 Q-2 / D-2・DB migration なし）');
{
  ok(SUB.DERIVED_HC_BLOOD_IMPORTED_BY === 'derived_healthcheck_blood',
    'L marker は derived_healthcheck_blood', SUB.DERIVED_HC_BLOOD_IMPORTED_BY);
  const mig = readFileSync('supabase/migrations/20260601000010_schemas_and_tables.sql', 'utf8');
  ok(/imported_by\s+text not null,/.test(mig) && !/imported_by[^\n]*check/i.test(mig),
    'L `imported_by` は text not null で **CHECK が無い** = 値を足すのに migration が要らない');
}

section('S: admin バッチは対象外（裁定 Q-13）');
{
  const sp = readFileSync('src/lib/scan-persist.ts', 'utf8');
  const adminFn = sp.slice(sp.indexOf('export async function persistAdminBatchArtifact'),
                           sp.indexOf('export async function persistIntoExistingArtifact'));
  ok(!adminFn.includes('persistDerivedBloodArtifact') && !adminFn.includes('extractBloodSubset'),
    'S persistAdminBatchArtifact から派生を作っていない');
  const scanApi = readFileSync('src/pages/api/admin/elith-scan.ts', 'utf8');
  ok(!scanApi.includes('blood-subset'), 'S /api/admin/elith-scan は blood-subset を呼ばない');
}

section('R: backfill は dry-run 既定・cron に載せない（裁定 Q-11）');
{
  const bf = readFileSync('scripts/backfill-derived-blood.mjs', 'utf8');
  ok(bf.includes("const APPLY = has('--apply')"), 'R 書くのは --apply を明示したときだけ');
  ok(/if \(!APPLY\) \{[\s\S]{0,400}return;/.test(bf), 'R APPLY でなければ書かずに戻る');
  ok(bf.includes('DRY-RUN のため **DB には 1 行も書いていません**'), 'R dry-run の旨を表示する');
  const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
  ok(!JSON.stringify(vercel.crons ?? []).includes('backfill'), 'R **cron に載せていない**');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  ok(!Object.values(pkg.scripts).some((v) => v.includes('backfill-derived-blood')),
    'R npm script にも出していない（うっかり CI で走らせない）');
}

section('J: Elith 納品 JSON の形（裁定 Q-8 / Q-9）');
{
  const ed = readFileSync('src/lib/elith-delivery.ts', 'utf8');
  const fn = ed.slice(ed.indexOf('async function materializeDerivedBloodTests'),
                      ed.indexOf('/** measurements からウェルネス年齢を算出'));
  ok(fn.includes("format_id: 'BloodTestData'"), 'J format_id は BloodTestData');
  ok(fn.includes('人間ドック・健康診断の既存AIスキャン結果から血液検査値を抽出（再解析なし）'),
    'J source.note が確定文言（裁定 Q-8）');
  // コメントで言及するのは可。**キーとして出力していない**ことを見る。
  ok(!/raw_markdown\s*:/.test(fn), 'J **raw_markdown を載せない**（人間ドック全項目の同梱を防ぐ）');
  ok(fn.includes('BloodTestData_date_${dateFolder}_user_${uid}.json'), 'J 既存の命名規約どおり');
  ok(fn.includes('normalBloodDates.has(dateFolder)'), 'J 同一日に通常 blood が在れば書かない（裁定 Q-10）');
  ok(ed.includes('...(bl ? { BloodTestData: bl } : {})'),
    'J manualMapping に BloodTestData を載せる（載せないと納品されない）');
}

section('G / L / O: 派生 artifact の保存（スタブ DB）');
{
  const PERSIST = await bundle('src/lib/scan-persist.ts', 'vbs-scan-persist.mjs');

  /**
   * 最小の Supabase スタブ。**何を保存しようとしたか**を捕まえる。
   * `existingBlood` = 同じ受診日に既に在る blood artifact（imported_by つき）。
   */
  function makeSb(existingBlood = []) {
    const calls = [];
    const filters = [];
    const schema = () => ({
      from: (table) => ({
        select: () => {
          const f = {};
          const chain = {
            eq: (c, v) => { f[c] = v; return chain; },
            in: async () => ({ data: [], error: null }),
            then: (res) => { filters.push({ table, f }); return Promise.resolve({ data: table === 'test_artifacts' ? existingBlood : [], error: null }).then(res); },
          };
          return chain;
        },
        insert: (rows) => { calls.push({ table, op: 'insert', row: rows[0] }); return {
          select: async () => ({ data: [{ id: 'blood-art-1' }], error: null }),
          then: (res) => res({ error: null }),
        }; },
        update: (patch) => ({
          eq: async () => { calls.push({ table, op: 'update', patch }); return { error: null }; },
          in: async () => { calls.push({ table, op: 'update-in', patch }); return { error: null }; },
        }),
        delete: () => ({
          eq: async () => { calls.push({ table, op: 'delete' }); return { error: null }; },
          in: async (c, ids) => { calls.push({ table, op: 'delete-in', ids }); return { error: null }; },
        }),
      }),
    });
    return { sb: { schema }, calls, filters };
  }

  // L: 同じ日に blood が 1 件も無い → 作る
  {
    const { sb, calls, filters } = makeSb([]);
    const r = await PERSIST.persistDerivedBloodArtifact(sb, {
      diagnosticUserId: 'u-1', testDate: '2026-07-15', measurements: FULL,
    });
    ok(r.status === 'created', 'L 派生 artifact を作る', `${r.status} ${r.reason ?? ''}`);
    const ins = calls.find((c) => c.table === 'test_artifacts' && c.op === 'insert')?.row ?? {};
    ok(ins.source === 'user_upload', 'L source = user_upload', String(ins.source));
    ok(ins.test_type === 'blood', 'L test_type = blood', String(ins.test_type));
    ok(ins.imported_by === SUB.DERIVED_HC_BLOOD_IMPORTED_BY,
      'L **imported_by = derived_healthcheck_blood**', String(ins.imported_by));
    ok(ins.scan_md === undefined, 'L scan_md は入れない（原文は health_checkup 側）', String(ins.scan_md));
    ok(ins.test_date === '2026-07-15', 'L 受診日は呼び出し側の確定値', String(ins.test_date));
    const mv = calls.find((c) => c.table === 'measurement_values' && c.op === 'insert')?.row ?? {};
    ok(mv.test_type === 'blood', 'L measurement_values.test_type = blood（グラフが拾う条件）', String(mv.test_type));
    ok(mv.source_file_kind === 'scan_md', 'L source_file_kind = scan_md', String(mv.source_file_kind));
    ok(r.items === 15, 'L 15 項目ぶん書いた', String(r.items));

    // G: 冪等キーに imported_by が入っている
    const dedup = filters.find((x) => x.table === 'test_artifacts' && x.f.source === 'user_upload' && x.f.test_type === 'blood');
    ok(!!dedup && dedup.f.imported_by === SUB.DERIVED_HC_BLOOD_IMPORTED_BY,
      'G **冪等キーに imported_by が入る**（通常 blood / 将来の実血液 user upload を巻き込まない）',
      JSON.stringify(dedup?.f ?? null));
    const delIdx = calls.findIndex((c) => c.op === 'delete-in' || c.op === 'update-in');
    const insIdx = calls.findIndex((c) => c.table === 'test_artifacts' && c.op === 'insert');
    ok(delIdx === -1 || delIdx < insIdx, 'G 片付けは insert より前');
  }

  // O: 同じ日に **通常** blood が在る → 作らない
  {
    const { sb, calls } = makeSb([{ id: 'normal-1', imported_by: 'wellfort_admin_upload' }]);
    const r = await PERSIST.persistDerivedBloodArtifact(sb, {
      diagnosticUserId: 'u-1', testDate: '2026-07-15', measurements: FULL,
    });
    ok(r.status === 'skipped' && r.reason === 'normal_blood_exists',
      'O **同一日に通常 blood が在れば作らない**（通常を優先）', `${r.status}/${r.reason}`);
    ok(!calls.some((c) => c.table === 'test_artifacts' && c.op === 'insert'), 'O insert していない');
    ok(!calls.some((c) => c.op === 'delete-in' || c.op === 'update-in'), 'O **通常 blood に触っていない**');
  }

  // O-b: 同じ日に **派生** blood しか無い → 作り直す（冪等）
  {
    const { sb, calls } = makeSb([{ id: 'derived-old', imported_by: SUB.DERIVED_HC_BLOOD_IMPORTED_BY }]);
    const r = await PERSIST.persistDerivedBloodArtifact(sb, {
      diagnosticUserId: 'u-1', testDate: '2026-07-15', measurements: FULL,
    });
    ok(r.status === 'created', 'O-b 既存が派生だけなら作り直す（冪等）', `${r.status}/${r.reason ?? ''}`);
  }

  // P: 0 件 → artifact を作らない
  {
    const { sb, calls } = makeSb([]);
    const r = await PERSIST.persistDerivedBloodArtifact(sb, {
      diagnosticUserId: 'u-1', testDate: '2026-07-15', measurements: [lean('ALP', 76)],
    });
    ok(r.status === 'skipped' && r.reason === 'no_target_items', 'P 0 件なら skipped', `${r.status}/${r.reason}`);
    ok(!calls.some((c) => c.op === 'insert'), 'P **artifact も measurement_values も作らない**');
  }

  // O-2: 通常 blood が後から届いたら派生を superseded に落とす（削除しない）
  {
    const { sb, calls } = makeSb([{ id: 'derived-old' }]);
    const r = await SUB.supersedeDerivedBloodOnSameDate(sb, 'u-1', '2026-07-15');
    ok(r.superseded === 1, 'O-2 派生 1 件を落とす', String(r.superseded));
    const up = calls.find((c) => c.op === 'update-in');
    ok(up?.patch?.status === 'superseded', 'O-2 **superseded にする（削除ではない）**', JSON.stringify(up?.patch));
    ok(!calls.some((c) => c.op === 'delete-in'), 'O-2 delete していない');
  }
  // O-2b: 自分（通常 blood の行）は落とさない
  {
    const { sb, calls } = makeSb([{ id: 'me' }]);
    const r = await SUB.supersedeDerivedBloodOnSameDate(sb, 'u-1', '2026-07-15', { exceptArtifactId: 'me' });
    ok(r.superseded === 0 && !calls.some((c) => c.op === 'update-in'),
      'O-2b exceptArtifactId は落とさない', String(r.superseded));
  }
}

section('H / N: 推移グラフ（混在系列では基準線を出さない・裁定 Q-5）');
{
  writeFileSync(`${CACHE}/vbs-supabase-stub.mjs`, `export let _stub = null;
export function __setStub(s) { _stub = s; }
export function getServerSupabase() { return _stub; }
export function getBrowserSupabase() { return null; }
`);
  writeFileSync(`${CACHE}/vbs-demo-stub.mjs`, `export function demoFallbackEnabled() { return false; }
export function demoMetricTrend() { return []; }
`);
  const MQ = await bundle('src/lib/measurement-queries.ts', 'vbs-measurement-queries.mjs', [{
    name: 'stub',
    setup(b) {
      b.onResolve({ filter: /(^|\/)supabase$/ }, () => ({ path: './vbs-supabase-stub.mjs', external: true }));
      b.onResolve({ filter: /(^|\/)demo-data$/ }, () => ({ path: './vbs-demo-stub.mjs', external: true }));
    },
  }]);
  const stub = await import(`../${CACHE}/vbs-supabase-stub.mjs`);

  const UID = 'u-1';
  const DERIVED = SUB.DERIVED_HC_BLOOD_IMPORTED_BY;
  const mvRow = (artifact_id, test_date, seq, item_name, canonical_name, value_num, refHigh) => ({
    artifact_id, test_type: 'blood', test_date, seq, item_name, canonical_name,
    value: String(value_num), value_num, unit: 'mg/dL',
    ref_low: null, ref_high: refHigh == null ? null : String(refHigh),
    ref_low_num: null, ref_high_num: refHigh ?? null, flag: null, assessment: null,
  });
  function makeTrendStub(artifacts, rows) {
    const table = (name) => {
      const api = {
        select() { return api; }, eq() { return api; }, in() { return api; },
        not() { return api; }, order() { return api; }, limit() { return api; },
        then(res) {
          const data = name === 'test_artifacts' ? artifacts : rows;
          return Promise.resolve({ data, error: null }).then(res);
        },
      };
      return api;
    };
    return { schema: () => ({ from: table }), from: table };
  }

  // 通常 3 回 + 派生 1 回（人間ドック）
  const ARTS_MIXED = [
    { id: 'n1', imported_by: 'wellfort_admin_upload' },
    { id: 'n2', imported_by: 'wellfort_admin_upload' },
    { id: 'n3', imported_by: 'wellfort_admin_upload' },
    { id: 'd1', imported_by: DERIVED },
  ];
  /*
   * **人間ドック由来の点を「最新」に置く。** 基準値は `sorted` の**最後の行**から取る作りなので、
   * 派生が最新のときだけ基準帯が出る＝そこが抑止したい場面。
   * 途中に置くと「抑止が外れても気づかない」検査になってしまう（実際に 1 度そうなった）。
   */
  const ROWS_MIXED = [
    mvRow('n1', '2026-01-10', 0, 'LDLコレステロール', 'LDLコレステロール', 120, null),
    mvRow('n2', '2026-04-10', 0, 'LDLコレステロール', 'LDLコレステロール', 115, null),
    mvRow('n3', '2026-10-10', 0, 'LDLコレステロール', 'LDLコレステロール', 112, null),
    mvRow('d1', '2026-11-15', 0, 'LDLコレステロール', 'LDLコレステロール', 156, 139),
  ];

  stub.__setStub(makeTrendStub(ARTS_MIXED, ROWS_MIXED));
  const mixed = await MQ.getMeasurementTrend(UID, ['LDLコレステロール'], 12, 'blood');
  ok(mixed.length === 1, 'H 系列は 1 本', `len=${mixed.length}`);
  const pts = mixed[0]?.points ?? [];
  ok(pts.length === 4, 'H **4 点**（通常 3 + 人間ドック 1）', `n=${pts.length}`);
  ok(pts.map((p) => p.date).join(',') === '2026-01-10,2026-04-10,2026-10-10,2026-11-15',
    'H 日付昇順で混ざる', pts.map((p) => p.date).join(','));
  ok(pts.filter((p) => p.source === SUB.DERIVED_HC_BLOOD_SOURCE).length === 1,
    'I 人間ドック由来の点だけに source が付く', JSON.stringify(pts.map((p) => p.source)));
  ok(pts.find((p) => p.date === '2026-11-15')?.source === SUB.DERIVED_HC_BLOOD_SOURCE,
    'I 付くのは 2026-11-15 の点（人間ドック由来）');
  ok(mixed[0].referenceUpper === undefined && mixed[0].referenceLower === undefined,
    'N **混在系列では基準線を出さない**（裁定 Q-5）',
    `upper=${mixed[0].referenceUpper} lower=${mixed[0].referenceLower}`);

  // N-2: 派生だけの系列なら従来どおり基準線を出す
  const ARTS_ONLY = [{ id: 'd1', imported_by: DERIVED }, { id: 'd2', imported_by: DERIVED }];
  const ROWS_ONLY = [
    mvRow('d1', '2025-07-15', 0, 'LDLコレステロール', 'LDLコレステロール', 150, 139),
    mvRow('d2', '2026-07-15', 0, 'LDLコレステロール', 'LDLコレステロール', 156, 139),
  ];
  stub.__setStub(makeTrendStub(ARTS_ONLY, ROWS_ONLY));
  const onlyDerived = await MQ.getMeasurementTrend(UID, ['LDLコレステロール'], 12, 'blood');
  ok(onlyDerived[0]?.referenceUpper === 139, 'N-2 派生だけなら基準線は従来どおり出す',
    String(onlyDerived[0]?.referenceUpper));

  // N-3: 通常だけの系列も従来どおり
  const ARTS_N = [{ id: 'n1', imported_by: 'wellfort_admin_upload' }, { id: 'n2', imported_by: 'wellfort_admin_upload' }];
  const ROWS_N = [
    mvRow('n1', '2026-01-10', 0, 'LDLコレステロール', 'LDLコレステロール', 120, 139),
    mvRow('n2', '2026-04-10', 0, 'LDLコレステロール', 'LDLコレステロール', 115, 139),
  ];
  stub.__setStub(makeTrendStub(ARTS_N, ROWS_N));
  const onlyNormal = await MQ.getMeasurementTrend(UID, ['LDLコレステロール'], 12, 'blood');
  ok(onlyNormal[0]?.referenceUpper === 139, 'N-3 通常だけなら基準線は従来どおり出す',
    String(onlyNormal[0]?.referenceUpper));
  ok((onlyNormal[0]?.points ?? []).every((p) => p.source == null),
    'N-3 通常の点に source は付かない');
}

section('I: 画面の文言（固定・裁定 Q-7）');
{
  ok(SUB.DERIVED_HC_BLOOD_LABEL === '人間ドックから抽出', 'I 文言は「人間ドックから抽出」', SUB.DERIVED_HC_BLOOD_LABEL);
  const chart = readFileSync('src/components/dashboard/MetricTrendChart.astro', 'utf8');
  ok(chart.includes('DERIVED_HC_BLOOD_LABEL'), 'I グラフが文言定数を使う（画面に直書きしない）');
  ok((chart.match(/DERIVED_HC_BLOOD_LABEL\}/g) ?? []).length >= 2,
    'I 測定履歴テーブルとミニカードの 2 か所に出す',
    String((chart.match(/DERIVED_HC_BLOOD_LABEL\}/g) ?? []).length));
  // 列を増やしていないこと（390px で和文が 1 文字ずつ折れるため・spec §7.4）
  const head = chart.slice(chart.indexOf('<thead'), chart.indexOf('</thead>'));
  ok((head.match(/<th /g) ?? []).length === 4,
    'I **測定履歴テーブルの列は 4 列のまま**（検査日 / 値 / 前回比 / 判定）',
    String((head.match(/<th /g) ?? []).length));
}

// ════════════════════════════════════════════════════════════════
console.log('');
console.log('─'.repeat(70));
if (fails.length) {
  console.log(`FAILED ${fails.length} / ${pass + fails.length}`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`ALL PASS (${pass} 件)`);
