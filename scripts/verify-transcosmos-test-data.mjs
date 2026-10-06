#!/usr/bin/env node
/**
 * `npm run verify:transcosmos-test-data`
 *   — トランスコスモス 10 名の **検査データ一括反映** の回帰チェック。
 *
 * 正本: `src/lib/transcosmos-test-data.ts` の冒頭。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【この機能で静かに壊れるところ】
 * ══════════════════════════════════════════════════════════════════════
 *   ① **番号 → uid の取り違え** — 画面は「10 / 10 完了」なのに
 *      A さんの PDF が B さんのダッシュボードへ出る。**完成済み報告書
 *      (`transcosmos-reports.ts`) とは番号の対応が別**なので、流用すると必ずずれる。
 *   ② **保存キーの uid すり替え** — 形だけ見て通すと、別人のキーを添えて送れる。
 *   ③ **cold instance の app_config** — `isSpecialAccount()` は同期なので
 *      `refreshConfig()` を忘れると**登録済みの uid まで弾かれる** (2026-10-06 の P0)。
 *   ④ **汎用の 20MiB 上限を引き上げてしまう** — 通常の追加検査の仕様まで変わる。
 *   ⑤ **artifact / 原本行の増殖** — 再実行で 2 件目ができると、どれが最新か分からなくなる。
 *
 * だから**実物の TS を transpile して動かす**。DB / Storage だけスタブに差し替える。
 * 鍵もサーバも要らない = **CI の A 層**。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, read, code, fails, ok, eq, M, resetAll } from './lib/sat-harness.mjs';

const LIB = M.tlib;
const API = M.ttd;
const SLOTS = LIB.TRANSCOS_SLOT_IDS;

/**
 * **例外も「結果」として受ける。** 投げたまま素通りさせると、退行を注入したときに
 * スクリプトごと落ちて**どの検査が落ちたのか名前が出ない** (実測: 存在確認を外すと
 * `hit.metadata` で TypeError になり、1 件も ✗ が出なかった)。
 */
const call = async (body) => {
  try {
    const res = await API.POST({
      request: new Request('https://x/api/admin/transcosmos-test-data', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  } catch (e) {
    return { status: 500, json: { ok: false, error: `threw:${String((e && e.message) || e)}` } };
  }
};

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const uidOf = (slot) => LIB.TRANSCOS_SLOTS[slot].uid;

/** 10 名ぶんを special.account_uids へ入れた状態にする (本番と同じく **DB 由来**)。 */
function seedSpecial() {
  resetAll();
  M.db.TABLES.app_config = [
    { key: 'special.account_uids', value: SLOTS.map(uidOf).join('\n') },
  ];
}

const planFiles = () => SLOTS.map((slot) => ({ slot, sizeBytes: 1024 * 1024, sha256: sha(slot), pageCount: 208 }));

/* ══════════════════════════════════════════════════════════════════════
 * A. 番号 → uid / 日付 (§3 / §4 / §5)
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nA. 番号 → uid / 日付\n');
{
  eq('A1 番号は 01〜10 の 10 件', SLOTS, ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10']);
  ok('A2 uid は 10 件とも別人', new Set(SLOTS.map(uidOf)).size === 10);
  ok('A3 すべて UUID の形', SLOTS.every((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uidOf(s))));

  eq('A4 健康診断の受診日 (実ファイル由来)', SLOTS.map((s) => LIB.TRANSCOS_SLOTS[s].healthDate),
    ['2025-10-22', '2025-11-13', '2025-11-14', '2025-09-25', '2025-09-18',
      '2025-10-30', '2025-07-11', '2025-08-04', '2025-09-04', '2026-01-14']);
  eq('A5 Genoplan の発行日', SLOTS.map((s) => LIB.TRANSCOS_SLOTS[s].geneticsDate),
    ['2026-08-12', '2026-08-12', '2026-08-12', '2026-08-12', '2026-08-12',
      '2026-08-12', '2026-08-12', '2026-07-29', '2026-07-29', '2026-08-12']);

  eq('A6 未知の番号は引けない', [LIB.transcosSlotInfo('11'), LIB.transcosSlotInfo('00'), LIB.transcosSlotInfo('1')], [null, null, null]);
  ok('A7 prototype 汚染で引けない', LIB.transcosSlotInfo('constructor') === null && LIB.transcosSlotInfo('__proto__') === null);

  /*
   * **完成済み AI疾病予防報告書とは番号の対応が別。** 同じ 10 人だが並びが違うので、
   * どちらかの表を流用すると**別人のダッシュボードへ出る**。
   */
  const other = read('src/lib/transcosmos-reports.ts');
  const otherFirst = /'01':\s*'([0-9a-f-]+)'/.exec(other)?.[1] ?? '';
  ok('A8 報告書側の 01 と検査側の 01 は別人 (表を流用していない)',
    otherFirst && otherFirst !== uidOf('01'), `${otherFirst} / ${uidOf('01')}`);

  const src = read('src/lib/transcosmos-test-data.ts');
  ok('A9 氏名・メールアドレスを持たない',
    !/[ぁ-んァ-ヶ一-龥]{2,}\s*(様|さん)|@[a-z0-9.-]+\.(co\.jp|com|jp)/i.test(src.replace(/^\s*\*.*$/gm, '')));
}

/* ══════════════════════════════════════════════════════════════════════
 * B. 入力の検め (§11 / §14)
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nB. 入力の検め\n');
{
  const base = { slot: '01', sizeBytes: 1000, sha256: sha('x'), pageCount: 208 };
  ok('B1 正しい入力は通る', LIB.checkGeneticsInput(base).ok);
  eq('B2 未知の番号は弾く', LIB.checkGeneticsInput({ ...base, slot: '11' }).error, 'unknown_slot');
  eq('B3 **uid の申告は使わない** (uid は番号から引き直す)',
    LIB.checkGeneticsInput({ ...base, diagnosticUserId: uidOf('10') }).info.uid, uidOf('01'));
  eq('B4 SHA が 64 桁 hex でなければ弾く', LIB.checkGeneticsInput({ ...base, sha256: 'zz' }).error, 'invalid_sha256');
  eq('B5 サイズ 0 は弾く', LIB.checkGeneticsInput({ ...base, sizeBytes: 0 }).error, 'invalid_size');
  eq('B6 ページ数 0 は弾く', LIB.checkGeneticsInput({ ...base, pageCount: 0 }).error, 'invalid_page_count');

  // ④ 20MiB 超〜25MiB は通し、25MiB 超は弾く
  const MB = 1024 * 1024;
  ok('B7 **20MiB 超 (21MB) は通る**', LIB.checkGeneticsInput({ ...base, sizeBytes: 21 * MB }).ok);
  ok('B8 ちょうど 25MiB は通る', LIB.checkGeneticsInput({ ...base, sizeBytes: 25 * MB }).ok);
  eq('B9 25MiB 超は弾く', LIB.checkGeneticsInput({ ...base, sizeBytes: 25 * MB + 1 }).error, 'too_large');
  eq('B10 この口だけ 25MiB', LIB.TRANSCOS_GENETICS_MAX_BYTES, 25 * MB);
  ok('B11 **汎用の 20MiB 上限を変えていない**',
    /export const MAX_ORIGINAL_BYTES = 20 \* 1024 \* 1024;/.test(read('src/lib/originals-upload-ticket.ts')),
    '通常の追加検査アップロードの仕様に触らない');
}

/* ══════════════════════════════════════════════════════════════════════
 * C. 保存キー (§12 / §24)
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nC. 保存キー\n');
{
  const uid = uidOf('01');
  const rnd = '11111111-2222-4333-8444-555555555555';
  const path = LIB.geneticsStoragePath(uid, rnd);
  eq('C1 形は manual/transcosmos-tests/genetics/<uid>/<uuid>.pdf', path,
    `manual/transcosmos-tests/genetics/${uid}/${rnd}.pdf`);
  ok('C2 自分で作ったキーは通る', LIB.isGeneticsStoragePath(path));
  eq('C3 キーから uid を取り出せる', LIB.uidFromGeneticsPath(path), uid);
  ok('C4 **納品 JSON や別領域のキーは通さない**',
    !LIB.isGeneticsStoragePath(`user/${uid}/date/2026_09_28/HealthCheckupData.json`)
    && !LIB.isGeneticsStoragePath('manual/transcosmos/20260928/' + uid + '/x.pdf')
    && !LIB.isGeneticsStoragePath('lab_results/genoplan/2026/09/a.pdf'));
  ok('C5 相対パス・二重拡張子・非 UUID を通さない',
    !LIB.isGeneticsStoragePath(`manual/transcosmos-tests/genetics/${uid}/../${rnd}.pdf`)
    && !LIB.isGeneticsStoragePath(`manual/transcosmos-tests/genetics/${uid}/${rnd}.pdf.json`)
    && !LIB.isGeneticsStoragePath(`manual/transcosmos-tests/genetics/not-a-uuid/${rnd}.pdf`));
  ok('C6 キーに氏名も元ファイル名も入らない', !/[ぁ-んァ-ヶ一-龥]/.test(path));
}

/* ══════════════════════════════════════════════════════════════════════
 * D. API — 認可と special 資格 (§3 / §13)
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nD. 認可と special 資格\n');
{
  const auth = await import(`${resolve(ROOT, 'node_modules/.cache', 'sat-api-auth-stub.mjs')}`);
  seedSpecial();
  auth.AUTH.ok = false;
  const r = await call({ action: 'genetics-plan', files: planFiles() });
  auth.AUTH.ok = true;
  eq('D1 非 admin は 401', [r.status, r.json.error], [401, 'unauthorized']);
  eq('D1-2 署名も出さない', M.db.WRITES.length, 0);

  seedSpecial();
  const r2 = await call({ action: 'nope', files: planFiles() });
  eq('D2 知らない action は 400', [r2.status, r2.json.error], [400, 'unknown_action']);

  /*
   * ③ **cold instance の再現。** app_config は DB にだけ在り、
   * モジュールの cache は未ロード。`refreshConfig(true)` を踏まないと
   * `special.account_uids` が空に見えて全員弾かれる。
   */
  seedSpecial();
  const r3 = await call({ action: 'genetics-plan', files: planFiles() });
  eq('D3 **DB にだけ在る special uid でも通る** (cold cache で弾かない)', [r3.status, r3.json.ok], [200, true]);
  eq('D3-2 10 件とも署名が出る', (r3.json.files ?? []).length, 10);

  resetAll();                       // app_config を空にする = 資格なし
  M.db.TABLES.app_config = [];
  const r4 = await call({ action: 'genetics-plan', files: planFiles() });
  eq('D4 special でない uid は 403 のまま', [r4.status, r4.json.error], [403, 'not_special_account']);

  const api = code('src/pages/api/admin/transcosmos-test-data.ts');
  const iRefresh = api.indexOf('refreshConfig(');
  const iCheck = api.indexOf('checkAdditionalTarget(');
  ok('D5 refreshConfig が資格の確認より前にある', iRefresh >= 0 && iCheck > iRefresh);
  ok('D5-2 force=true で読み直す', /refreshConfig\(\s*true\s*\)/.test(api));
}

/* ══════════════════════════════════════════════════════════════════════
 * E. genetics-plan (§14)
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nE. genetics-plan\n');
{
  seedSpecial();
  const r = await call({ action: 'genetics-plan', files: planFiles() });
  const files = r.json.files ?? [];
  ok('E1 保存キーはサーバが採番する (番号ごとに別の uid 配下)',
    files.every((f) => LIB.uidFromGeneticsPath(f.path) === uidOf(f.slot)));
  ok('E2 10 件とも別のキー', new Set(files.map((f) => f.path)).size === 10);
  eq('E3 保存先は lab-results', r.json.bucket, 'lab-results');
  ok('E4 署名と token を返す', files.every((f) => f.signedUrl && f.token));

  seedSpecial();
  const dup = await call({ action: 'genetics-plan', files: [planFiles()[0], planFiles()[0]] });
  eq('E5 同じ番号が 2 つ来たら弾く', [dup.status, dup.json.error], [400, 'duplicate_slot']);

  seedSpecial();
  const bad = await call({ action: 'genetics-plan', files: [{ ...planFiles()[0], slot: '11' }] });
  eq('E6 未知の番号は 400 (1 件でも駄目なら署名を出さない)', [bad.status, bad.json.error], [400, 'unknown_slot']);
  eq('E6-2 署名は 1 件も出ていない', M.db.WRITES.filter((w) => w.op === 'sign').length, 0);

  seedSpecial();
  M.db.STORAGE_FAIL.sign = true;
  const sf = await call({ action: 'genetics-plan', files: planFiles() });
  M.db.STORAGE_FAIL.sign = false;
  eq('E7 署名に失敗したら 503', [sf.status, sf.json.error], [503, 'sign_failed']);
}

/* ══════════════════════════════════════════════════════════════════════
 * E'. 保存先バケットが無いとき (2026-10-06 実測の P0)
 *
 * 本番は原本を S3 (`AWS_S3_ORIGINALS_BUCKET`) に置いているので、
 * フォールバック用の Supabase Storage `lab-results` が**一度も作られていなかった**。
 * そのため実行すると **`sign_failed / The related resource does not exist`** で
 * 全員落ちた。バケット名を言わないエラーなので原因が分かりにくい。
 * ════════════════════════════════════════════════════════════════════ */
console.log("\nE'. 保存先バケットが無いとき\n");
{
  seedSpecial();
  M.db.BUCKETS.delete('lab-results');          // 本番と同じ状態にする
  const r = await call({ action: 'genetics-plan', files: planFiles() });
  eq("E'1 **バケットが無くても通る** (private で作ってから署名する)", [r.status, r.json.ok], [200, true]);
  const made = M.db.WRITES.filter((w) => w.op === 'createBucket');
  eq("E'2 作るのは 1 回だけ", made.length, 1);
  eq("E'3 **public にしない**", [made[0]?.name, made[0]?.public], ['lab-results', false]);
  eq("E'4 10 件とも署名が出る", (r.json.files ?? []).length, 10);

  seedSpecial();
  const r2 = await call({ action: 'genetics-plan', files: planFiles() });
  eq("E'5 既に在れば作らない", M.db.WRITES.filter((w) => w.op === 'createBucket').length, 0);
  eq("E'5-2 それでも署名は出る", [r2.status, (r2.json.files ?? []).length], [200, 10]);

  seedSpecial();
  M.db.BUCKETS.delete('lab-results');
  M.db.BUCKET_FAIL.create = true;
  const r3 = await call({ action: 'genetics-plan', files: planFiles() });
  M.db.BUCKET_FAIL.create = false;
  eq("E'6 作れないときは **名指しで返す** (opaque な sign_failed にしない)",
    [r3.status, r3.json.error], [503, 'bucket_unavailable']);
  ok("E'6-2 どのバケットが要るかを書く", /lab-results/.test(String(r3.json.detail ?? '')), String(r3.json.detail));
}

/* ══════════════════════════════════════════════════════════════════════
 * F. genetics-finalize (§16 〜 §20)
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nF. genetics-finalize\n');

/** plan → Storage へ置いた状態 → finalize の入力を作る。 */
async function planned(over = {}) {
  seedSpecial();
  const p = await call({ action: 'genetics-plan', files: planFiles() });
  const files = (p.json.files ?? []).map((f) => ({
    slot: f.slot, path: f.path, sizeBytes: f.sizeBytes, sha256: f.sha256, pageCount: f.pageCount,
  }));
  if (!over.skipUpload) for (const f of files) M.db.STORAGE.set(f.path, f.sizeBytes);
  return files;
}

{
  const files = await planned();
  const r = await call({ action: 'genetics-finalize', files });
  eq('F1 10 件とも登録される', [r.status, r.json.ok, r.json.count], [200, true, 10]);

  const arts = M.db.TABLES.test_artifacts ?? [];
  eq('F2 artifact は 10 件', arts.length, 10);
  ok('F3 test_type は genetics・status は active', arts.every((a) => a.test_type === 'genetics' && a.status === 'active'));
  ok('F4 受診日は manifest の Genoplan 発行日',
    arts.every((a) => {
      const slot = SLOTS.find((s) => uidOf(s) === a.diagnostic_user_id);
      return a.test_date === LIB.TRANSCOS_SLOTS[slot].geneticsDate;
    }));
  ok('F5 lab_name / imported_by / display_mode / page_count を入れる',
    arts.every((a) => a.lab_name === 'Genoplan' && a.imported_by === 'transcosmos_bulk_202610'
      && a.display_mode === 'single' && a.page_count === 208));
  ok('F6 **測定値は作らない** (AI に項目を捏造させない)',
    arts.every((a) => Array.isArray(a.measurements) && a.measurements.length === 0));
  ok('F7 scan_md は事実だけ (医学的な要約・評価を書かない)',
    arts.every((a) => a.scan_md === LIB.TRANSCOS_GENETICS_NOTE)
    && !/リスク|所見|疑い|可能性があります/.test(LIB.TRANSCOS_GENETICS_NOTE));

  const fileRows = M.db.TABLES.test_artifact_files ?? [];
  eq('F8 原本行も 10 件', fileRows.length, 10);
  ok('F9 file_kind は raw_pdf・storage_url は相対キー',
    fileRows.every((f) => f.file_kind === 'raw_pdf' && LIB.isGeneticsStoragePath(f.storage_url)));
  ok('F10 size は **Storage の実体**から取る', fileRows.every((f) => f.size_bytes === 1024 * 1024));

  const users = M.db.TABLES.app_users ?? [];
  eq('F11 app_users の placeholder は 10 件', users.length, 10);
  ok('F12 **placeholder は diagnostic_user_id 1 列だけ**',
    users.every((u) => Object.keys(u).filter((k) => !['id', 'created_at'].includes(k)).join(',') === 'diagnostic_user_id'),
    'auth_user_id / google_sub / hp_customer_user_id / display_name_cache を書かない');
  ok('F13 Supabase Auth user も password も作らない',
    !/auth\.admin|createUser|password/i.test(code('src/pages/api/admin/transcosmos-test-data.ts')));
}

/* ── ② キーのすり替えを弾く ────────────────────────────────────── */
{
  const files = await planned();
  // 02 の枠に 01 のキーを添えて送る
  const swapped = files.map((f) => (f.slot === '02' ? { ...f, path: files[0].path } : f));
  const r = await call({ action: 'genetics-finalize', files: swapped });
  eq('F14 **別人の uid 配下のキーは 400**', [r.status, r.json.error], [400, 'path_uid_mismatch']);
  eq('F14-2 1 行も書いていない', (M.db.TABLES.test_artifacts ?? []).length, 0);

  const files2 = await planned();
  const bad = files2.map((f) => (f.slot === '03' ? { ...f, path: 'user/x/date/2026_08_12/GeneticTestResultData.json' } : f));
  const r2 = await call({ action: 'genetics-finalize', files: bad });
  eq('F15 形の違うキーも 400', [r2.status, r2.json.error], [400, 'invalid_path']);
}

/* ── 存在確認 (§16) ────────────────────────────────────────────── */
{
  const files = await planned({ skipUpload: true });
  const r = await call({ action: 'genetics-finalize', files });
  eq('F16 **Storage に実体が無ければ 409** (DB だけ作らない)', [r.status, r.json.error], [409, 'object_missing']);
  eq('F16-2 artifact も原本行も作っていない',
    [(M.db.TABLES.test_artifacts ?? []).length, (M.db.TABLES.test_artifact_files ?? []).length], [0, 0]);

  const files2 = await planned({ skipUpload: true });
  for (const f of files2) M.db.STORAGE.set(f.path, 0);   // 0 バイト
  const r2 = await call({ action: 'genetics-finalize', files: files2 });
  eq('F17 0 バイトも 409', [r2.status, r2.json.error], [409, 'object_empty']);

  const files3 = await planned();
  M.db.STORAGE_FAIL.list = true;
  const r3 = await call({ action: 'genetics-finalize', files: files3 });
  M.db.STORAGE_FAIL.list = false;
  eq('F18 存在確認が落ちたら 503 (済みと言わない)', [r3.status, r3.json.error], [503, 'storage_list_failed']);
}

/* ══════════════════════════════════════════════════════════════════════
 * G. 冪等 (§18 / §19 / §31)
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nG. 冪等\n');
{
  const files = await planned();
  await call({ action: 'genetics-finalize', files });
  const firstIds = (M.db.TABLES.test_artifacts ?? []).map((a) => a.id).sort();

  // **同じ ZIP をもう一度**流す (キーは plan のたびに変わるが中身は同じ)
  const p2 = await call({ action: 'genetics-plan', files: planFiles() });
  const files2 = (p2.json.files ?? []).map((f) => ({
    slot: f.slot, path: f.path, sizeBytes: f.sizeBytes, sha256: f.sha256, pageCount: f.pageCount,
  }));
  for (const f of files2) M.db.STORAGE.set(f.path, f.sizeBytes);
  const r2 = await call({ action: 'genetics-finalize', files: files2 });

  eq('G1 2 回目も成功する', [r2.status, r2.json.ok], [200, true]);
  eq('G2 **artifact が増えない**', (M.db.TABLES.test_artifacts ?? []).length, 10);
  eq('G2-2 同じ artifact を使い回す', (M.db.TABLES.test_artifacts ?? []).map((a) => a.id).sort(), firstIds);
  eq('G3 **原本行も増えない** (同じ SHA は no-op)', (M.db.TABLES.test_artifact_files ?? []).length, 10);
  ok('G4 2 回目は「作成」と言わない', (r2.json.results ?? []).every((x) => x.created === false));

  // 違う中身の原本を同じ検査へ → 止める
  const p3 = await call({ action: 'genetics-plan', files: planFiles().map((f) => ({ ...f, sha256: sha('other-' + f.slot) })) });
  const files3 = (p3.json.files ?? []).map((f) => ({
    slot: f.slot, path: f.path, sizeBytes: f.sizeBytes, sha256: f.sha256, pageCount: f.pageCount,
  }));
  for (const f of files3) M.db.STORAGE.set(f.path, f.sizeBytes);
  const r3 = await call({ action: 'genetics-finalize', files: files3 });
  eq('G5 **違う中身の原本は 409** (黙って差し替えない)', [r3.status, r3.json.error], [409, 'original_conflict']);
  eq('G5-2 原本行は増えていない', (M.db.TABLES.test_artifact_files ?? []).length, 10);

  // 同じ受診日に 2 件 → 人に決めさせる
  const files4 = await planned();
  M.db.TABLES.test_artifacts = [
    { id: 'a1', diagnostic_user_id: uidOf('01'), test_type: 'genetics', test_date: LIB.TRANSCOS_SLOTS['01'].geneticsDate, status: 'active', source: 'wellfort_lab', display_mode: 'single' },
    { id: 'a2', diagnostic_user_id: uidOf('01'), test_type: 'genetics', test_date: LIB.TRANSCOS_SLOTS['01'].geneticsDate, status: 'active', source: 'admin_batch', display_mode: 'single' },
  ];
  const r4 = await call({ action: 'genetics-finalize', files: files4 });
  eq('G6 同じ受診日に 2 件あれば 409 (最新 1 件を勝手に選ばない)', [r4.status, r4.json.error], [409, 'artifact_ambiguous']);
}

/* ══════════════════════════════════════════════════════════════════════
 * H. 画面の仕分け (§6 / §7 / §27)
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nH. 画面の仕分け\n');
/*
 * **wellfort-site がこの作業ツリーに在るときだけ見る。**
 * CI では Scan-Chat-AI しか checkout されないので、無ければ飛ばす
 * (画面側の回帰は wellfort-site の `npm run verify:transcos-test-data` が見る)。
 * **「見られなかった」を「合格」と混同しない**ので、飛ばしたことは必ず出す。
 */
const WELLFORT = resolve(ROOT, '..', 'wellfort-site');
if (!existsSync(resolve(WELLFORT, 'src/pages/admin/transcosmos-test-data.astro'))) {
  console.log('  — wellfort-site が無いので画面側は飛ばす (向こうの verify:transcos-test-data が見る)');
} else {
  const PAGE = readFileSync(resolve(WELLFORT, 'src/pages/admin/transcosmos-test-data.astro'), 'utf8');

  // 画面の仕分け関数だけを取り出して動かす (NFKC・問診除外・Genoplan 判定)。
  const pick = (name) => {
    const i = PAGE.indexOf(`function ${name}`);
    const varI = PAGE.indexOf(`var ${name} =`);
    const at = i >= 0 ? i : varI;
    if (at < 0) throw new Error(`見つからない: ${name}`);
    const end = PAGE.indexOf('\n        ', PAGE.indexOf('\n', at) + 1);
    return PAGE.slice(at, PAGE.indexOf('\n', at) + 1) + PAGE.slice(PAGE.indexOf('\n', at) + 1, end);
  };
  const src = ['norm', 'slotOf', 'baseOf', 'isPdf', 'isGenoplan', 'isInterview']
    .map((n) => {
      const at = PAGE.indexOf(PAGE.includes(`function ${n}(`) ? `function ${n}(` : `var ${n} = `);
      const nl = PAGE.indexOf('\n        var ', at + 1);
      const nl2 = PAGE.indexOf('\n        function ', at + 1);
      const end = Math.min(...[nl, nl2].filter((x) => x > 0));
      return PAGE.slice(at, end);
    }).join('\n');
  // eslint-disable-next-line no-new-func
  const api = new Function(`${src}\nreturn { slotOf, isPdf, isGenoplan, isInterview, baseOf };`)();

  const dir = (n, f) => `20260910/${n}/${f}`;
  eq('H1 フォルダ番号を 2 桁へ揃える (1. → 01)', api.slotOf(dir('1. 山田', 'a.pdf')), '01');
  eq('H2 10. も拾う', api.slotOf(dir('10. 山田', 'a.pdf')), '10');
  eq('H3 全角の数字でも拾う (NFKC)', api.slotOf(dir('３．山田', 'a.pdf')), '03');
  eq('H4 番号の無いフォルダは対象外', api.slotOf('20260910/資料/10名の情報.xlsx'), '');
  eq('H5 11 以上は対象外', api.slotOf(dir('11. 誰か', 'a.pdf')), '');

  ok('H6 Genoplan は型番で見分ける',
    api.isGenoplan('CFBB-ABCD-EFGH-1234.pdf') && api.isGenoplan('CGAC-ABCD-EFGH.pdf'));
  ok('H7 健康診断は Genoplan ではない', !api.isGenoplan('2025年度 健康診断結果.pdf'));
  ok('H8 **問診票は取り込まない**',
    api.isInterview('共通問診表.pdf') && api.isInterview('問診 山田.pdf') && !api.isInterview('健康診断.pdf'));
  ok('H9 **Excel / Word は取り込まない**',
    !api.isPdf('共通問診表.xlsx') && !api.isPdf('その他（検査）.xlsx') && !api.isPdf('問診サイト.docx')
    && api.isPdf('健康診断.pdf'));

  ok('H10 画面は氏名をサーバへ送らない',
    !/name:\s*(e|entry|f)\.name|fileName|originalName/.test(PAGE),
    'サーバへ送るのは 番号 / サイズ / SHA / ページ数 / 解析結果 / 保存キー だけ');
  ok('H11 **Elith へ納品しない** (deliver を送らない)', !/deliver\s*:/.test(PAGE));
  ok('H12 **血液を別途登録しない** (健診の finalize が派生 blood を作る)',
    !/testType:\s*'blood'/.test(PAGE));
  ok('H13 ページ数は実測する (208 決め打ちにしない)',
    /pdfPageCount\(/.test(PAGE) && !/pageCount:\s*208/.test(PAGE));
  ok('H14 並列数は 2', /pool\([^)]*,\s*2\s*,/.test(PAGE));
  ok('H15 完了表示は **DB を読み戻して**作る', /readBack\(\)/.test(PAGE) && /byTestType/.test(PAGE));
  // **コメント行を落としてから見る** — 冒頭の説明に鍵の名前が出てくる (自分の注釈で落ちない)。
  const PAGE_CODE = PAGE.split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');
  ok('H16 鍵をブラウザへ出さない',
    !/ADMIN_API_KEY|SCAN_CHAT_AI_API_KEY|service_role|AWS_SECRET/.test(PAGE_CODE));

  const RELAY = readFileSync(resolve(WELLFORT, 'src/pages/api/admin/transcosmos-test-data.ts'), 'utf8');
  ok('H17 中継は admin を確認してから上流へ出す',
    /verifyAdmin\(request\)/.test(RELAY) && /admin_users/.test(RELAY));
  ok('H18 中継は 2 つの action しか通さない',
    /ALLOWED = new Set\(\['genetics-plan', 'genetics-finalize'\]\)/.test(RELAY));
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log(`\n${fails.length === 0 ? '✅ ALL PASS' : `❌ ${fails.length} FAIL`}`);
for (const f of fails) console.log(`   - ${f}`);
process.exit(fails.length === 0 ? 0 : 1);
