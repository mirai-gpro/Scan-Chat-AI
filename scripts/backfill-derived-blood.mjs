#!/usr/bin/env node
/**
 * **既に保存済みの人間ドック／健康診断に、血液検査サブセット（派生 blood）を後から作る。**
 *
 * 正本: `docs/specs/healthcheckup_blood_extraction_spec_20261001.md` §10.6（発注者裁定 Q-11）。
 *
 * 【安全装置（裁定どおり・外さないこと）】
 *   - **初期状態は dry-run。** 引数なしで実行したら **DB に 1 行も書かない。**
 *   - **本番 DB を自動変更しない。** 書くのは `--apply` を明示したときだけ。
 *   - **自動実行 cron にしない。** `vercel.json` にも GitHub Actions にも載せない。
 *   - **対象件数と変更予定内容を表示する。**
 *   - **明示的な実行指示があるまで production では実行しない。**
 *   - **既存行を削除・supersede しない。** 同じ受診日に通常 blood が在る回は**作らない**
 *     （裁定 Q-10 の優先に従う）。
 *
 * 【新規スキャン経路とは分離】通常のスキャン保存は `saveScanResult()` の中で派生を作る。
 * この script は**過去ぶんだけ**を相手にする。同じ抽出ロジック（`blood-subset.ts`）を使うので
 * 結果は一致する。
 *
 * 使い方:
 *   node scripts/backfill-derived-blood.mjs                 # dry-run（既定・何も書かない）
 *   node scripts/backfill-derived-blood.mjs --uid <uuid>    # 1 人だけ見る
 *   node scripts/backfill-derived-blood.mjs --limit 50      # 走査する人間ドックの上限（既定 200）
 *   node scripts/backfill-derived-blood.mjs --apply         # **実際に書く**
 *
 * env: `PUBLIC_SUPABASE_URL`（または `SUPABASE_URL`）/ `SUPABASE_SERVICE_ROLE_KEY`
 *   — CLAUDE.md のとおり鍵は Vercel 環境変数が正。ローカルの `.env` に置かない。
 */
import { createClient } from '@supabase/supabase-js';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, dflt) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const APPLY = has('--apply');
const ONLY_UID = val('--uid', null);
const LIMIT = Number(val('--limit', '200')) || 200;

const URL_ = process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function die(msg) { console.error(`\n[backfill] ${msg}\n`); process.exit(1); }

/** `src/lib` の TS をそのまま使う（抽出ロジックを script 側で書き写さない）。 */
async function loadLib() {
  mkdirSync('node_modules/.cache', { recursive: true });
  const out = 'node_modules/.cache/backfill-blood-subset.mjs';
  await build({
    entryPoints: ['src/lib/blood-subset.ts'],
    bundle: true, platform: 'node', format: 'esm', logLevel: 'error', outfile: out,
  });
  return import(pathToFileURL(out).href);
}

const main = async () => {
  console.log('');
  console.log('人間ドック由来 血液検査データ (派生 blood) の backfill');
  console.log('─'.repeat(78));
  console.log(`モード       : ${APPLY ? '*** APPLY (DB へ書き込みます) ***' : 'DRY-RUN (何も書きません)'}`);
  console.log(`対象 uid     : ${ONLY_UID ?? '(全員)'}`);
  console.log(`走査上限     : ${LIMIT} 件の人間ドック`);
  console.log('─'.repeat(78));

  if (!URL_ || !KEY) die('PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が要ります。');

  const { extractBloodSubset, DERIVED_HC_BLOOD_IMPORTED_BY } = await loadLib();
  const sb = createClient(URL_, KEY, { auth: { persistSession: false } });
  const dg = sb.schema('diagnosis');

  // ① 対象 = active な health_checkup で measurements を持つもの。
  let q = dg.from('test_artifacts')
    .select('id, diagnostic_user_id, test_date, measurements')
    .eq('test_type', 'health_checkup')
    .eq('status', 'active')
    .order('test_date', { ascending: false })
    .limit(LIMIT);
  if (ONLY_UID) q = q.eq('diagnostic_user_id', ONLY_UID);
  const { data: hcs, error } = await q;
  if (error) die(`test_artifacts の取得に失敗: ${error.message}`);

  const rows = hcs ?? [];
  console.log(`走査対象の人間ドック: ${rows.length} 件\n`);

  const plan = [];
  for (const hc of rows) {
    const uid = hc.diagnostic_user_id;
    const testDate = hc.test_date;
    const label = `${uid} / ${testDate ?? '(受診日なし)'}`;
    if (!testDate || !/^\d{4}-\d{2}-\d{2}$/.test(testDate)) {
      plan.push({ label, action: 'skip', why: '受診日が無い（date フォルダを決められない）' });
      continue;
    }
    const measurements = Array.isArray(hc.measurements) ? hc.measurements : [];
    if (measurements.length === 0) {
      plan.push({ label, action: 'skip', why: 'measurements が空（未取込の回）' });
      continue;
    }
    const { kept, excluded } = extractBloodSubset(measurements);
    if (kept.length === 0) {
      plan.push({ label, action: 'skip', why: '対象 15 項目が 0 件（裁定 Q-6 = 何も作らない）' });
      continue;
    }

    // ② 同じ受診日の既存 blood を見る。
    const { data: bloods } = await dg.from('test_artifacts')
      .select('id, imported_by, status')
      .eq('diagnostic_user_id', uid)
      .eq('test_type', 'blood')
      .eq('test_date', testDate)
      .eq('status', 'active');
    const list = bloods ?? [];
    if (list.some((b) => b.imported_by !== DERIVED_HC_BLOOD_IMPORTED_BY)) {
      plan.push({ label, action: 'skip', why: '同じ受診日に通常 blood が在る（裁定 Q-10 = 通常を優先）' });
      continue;
    }
    const already = list.find((b) => b.imported_by === DERIVED_HC_BLOOD_IMPORTED_BY);
    plan.push({
      label, action: already ? 'replace' : 'create',
      why: already ? '既存の派生を作り直す（冪等）' : '新規に作る',
      items: kept.map((m) => `${m.name}=${m.value ?? ''}`),
      excluded: excluded.map((e) => `${e.item}(${e.values.join(' / ')})`),
      uid, testDate, kept, existingId: already?.id ?? null,
    });
  }

  // ③ 表示（**何をするつもりか**を必ず出す）
  const counts = plan.reduce((a, p) => ({ ...a, [p.action]: (a[p.action] ?? 0) + 1 }), {});
  for (const p of plan) {
    const mark = p.action === 'skip' ? '  -' : p.action === 'replace' ? '  ~' : '  +';
    console.log(`${mark} ${p.label}  [${p.action}] ${p.why}`);
    if (p.items?.length) console.log(`      項目 ${p.items.length} 件: ${p.items.join(', ')}`);
    if (p.excluded?.length) console.log(`      値が確定できず除外: ${p.excluded.join(', ')}`);
  }
  console.log('');
  console.log('─'.repeat(78));
  console.log(`作る: ${counts.create ?? 0} / 作り直す: ${counts.replace ?? 0} / 何もしない: ${counts.skip ?? 0}`);
  console.log('─'.repeat(78));

  if (!APPLY) {
    console.log('');
    console.log('DRY-RUN のため **DB には 1 行も書いていません**。');
    console.log('実行するには --apply を付けてください（発注者の明示的な指示があるときだけ）。');
    console.log('');
    return;
  }

  // ④ 書き込み（--apply のときだけ）
  let created = 0, failed = 0;
  for (const p of plan) {
    if (p.action === 'skip') continue;
    try {
      if (p.existingId) {
        // 冪等: 既存の派生行ごと作り直す（measurement_values は cascade で消える）。
        await dg.from('test_artifacts').delete().eq('id', p.existingId);
      }
      const { data, error: insErr } = await dg.from('test_artifacts').insert([{
        diagnostic_user_id: p.uid,
        source: 'user_upload',
        test_type: 'blood',
        test_date: p.testDate,
        lab_name: null,
        schema_version: '1.0',
        display_mode: 'single',
        page_count: 1,
        imported_by: DERIVED_HC_BLOOD_IMPORTED_BY,
        status: 'active',
        notes: '人間ドック・健康診断の既存AIスキャン結果から抽出した血液検査データ（再解析なし・backfill）',
      }]).select('id');
      if (insErr) throw new Error(insErr.message);
      const artifactId = data?.[0]?.id;
      await dg.from('test_artifacts').update({ measurements: p.kept }).eq('id', artifactId);
      await dg.from('measurement_values').delete().eq('artifact_id', artifactId);
      const { findByAlias } = await loadStandardMaster();
      const mv = p.kept.map((m, seq) => ({
        artifact_id: artifactId,
        diagnostic_user_id: p.uid,
        test_type: 'blood',
        test_date: p.testDate,
        seq,
        item_name: m.name,
        canonical_name: findByAlias(m.name)?.canonical_name ?? null,
        value: m.value ?? null,
        value_num: typeof m.value_num === 'number' ? m.value_num : null,
        unit: m.unit ?? null,
        ref_low: m.ref_low ?? null,
        ref_high: m.ref_high ?? null,
        ref_low_num: refNum(m.ref_low),
        ref_high_num: refNum(m.ref_high),
        flag: m.flag === 'H' || m.flag === 'L' ? m.flag : null,
        assessment: null,
        source_file_kind: 'scan_md',
      }));
      if (mv.length) {
        const { error: mvErr } = await dg.from('measurement_values').insert(mv);
        if (mvErr) throw new Error(mvErr.message);
      }
      created++;
      console.log(`  ok  ${p.label} → ${mv.length} 項目`);
    } catch (e) {
      failed++;
      console.error(`  NG  ${p.label}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log('');
  console.log(`書き込み完了: 成功 ${created} / 失敗 ${failed}`);
  console.log('');
};

/** `refToNum` と同じ規則（`src/lib/measurement-persist.ts`）。 */
function refNum(v) {
  if (v == null) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(String(v).replace(/,/g, ''));
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

async function loadStandardMaster() {
  mkdirSync('node_modules/.cache', { recursive: true });
  const out = 'node_modules/.cache/backfill-standard-master.mjs';
  await build({
    entryPoints: ['src/lib/standard-master.ts'],
    bundle: true, platform: 'node', format: 'esm', logLevel: 'error', outfile: out,
  });
  return import(pathToFileURL(out).href);
}

main().catch((e) => die(e instanceof Error ? e.stack ?? e.message : String(e)));
