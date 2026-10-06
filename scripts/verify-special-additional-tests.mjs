#!/usr/bin/env node
/**
 * `npm run verify:special-additional-tests`
 *   — **スペシャルアカウント 追加検査登録・Elith 納品** の回帰チェック。
 *
 * 正本: `docs/specs/special_account_additional_tests_spec_20260930.md` §44。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【この機能で静かに壊れるところ】
 * ══════════════════════════════════════════════════════════════════════
 *   ① **artifact の重複** — `test_artifacts` の UNIQUE は `source` を含み、
 *      `external_test_id` が NULL だと **PostgreSQL が NULL 同士を別物として扱う**ので
 *      効かない。**DB は止めてくれない**ので、検索条件から `source` が落ちた瞬間に
 *      本田さんの重複事故が再発する。画面上は「登録できた」ように見える。
 *   ② **受診日の today fallback** — 複数年が同じ日付に畳まれ、S3 キー衝突で片方が消える。
 *   ③ **納品 JSON に版面情報が混ざる** — `raw_markdown` / `bbox` は目視では気づけない。
 *   ④ **既存 `/admin/lab-results/register` の契約が変わる** — 共通化のついでに
 *      `file_exists` が別名になると、wellfort-site の文言分岐が黙って死ぬ。
 *
 * だから**実物の TS を transpile して動かす**。DB と S3 だけスタブに差し替える。
 * 鍵もサーバも要らない = **CI の A 層**。
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ROOT, CACHE, read, code, body, fails, ok, eq,
  UID_A, UID_B, stubUrl, M, PDF, PDF2, shaHex, shaB64, putOriginal,
  bloodPart, itemsPart, resetAll, call, BASE, finalizeBlood,
} from './lib/sat-harness.mjs';

/* ══════════════════════════════════════════════════════════════════════
 * A. 対象者 (§6 / §44 A)
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nA. 対象者\n');
{
  resetAll();
  // 1 非 admin 拒否 (認可は api-auth スタブで切り替える)
  const auth = await import(`${stubUrl('sat-api-auth-stub.mjs')}`);
  auth.AUTH.ok = false;
  const r1 = await call(M.finalize, { ...BASE, testType: 'blood', testDate: '2025-08-04', originalKey: 'x', parts: [bloodPart()] });
  auth.AUTH.ok = true;
  eq('A1 非 admin は 401', [r1.status, r1.json.error], [401, 'unauthorized']);

  // 2 スペシャルアカウント以外拒否 (**本物の isSpecialAccount を動かしている**)
  const r2 = await call(M.finalize, { ...BASE, diagnosticUserId: UID_B, testType: 'blood', testDate: '2025-08-04', originalKey: 'x', parts: [bloodPart()] });
  eq('A2 スペシャルアカウント以外は 403', [r2.status, r2.json.error], [403, 'not_special_account']);

  // 3 UID 未確定 (メール登録だけでサインイン前) は通さない
  const r3 = M.sat.checkAdditionalTarget(null);
  eq('A3 UID 未確定は拒否', [r3.ok, r3.error], [false, 'invalid_diagnostic_user_id']);
  eq('A3-2 UUID でない文字列も拒否', M.sat.checkAdditionalTarget('honda').ok, false);

  // 4 取り違え: 別ユーザーの artifact へは入れない (persistIntoExistingArtifact の関所)
  M.db.TABLES.test_artifacts = [{
    id: '11111111-1111-4111-8111-000000000001', diagnostic_user_id: UID_B,
    test_type: 'blood', test_date: '2025-08-04', status: 'active', source: 'wellfort_lab', display_mode: 'single',
  }];
  const found = await M.sat.resolveAdditionalArtifact({ uid: UID_A, testType: 'blood', testDate: '2025-08-04' });
  eq('A4 別ユーザーの行は拾わない', found.kind, 'none');
  ok('A4-2 判定に admin が混ざっていない',
    !/isAdmin|viewerIsAdmin|admin_users/.test(code('src/lib/special-additional-tests.ts')),
    'admin であることは資格にならない (デモ枠で踏んだ誤り)');
}

/* ══════════════════════════════════════════════════════════════════════
 * B. PDF (§9 / §10 / §15 / §16)
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nB. PDF\n');
{
  resetAll();
  const part = read('src/pages/api/admin/special-additional-tests/scan-part.ts');
  // 5 PDF を 1 度しか選択しない = STEP 1 で原本を置かない (置くのは STEP 2 の署名 PUT だけ)
  ok('B5 scan-part は原本 S3 へ置かない',
    !/putFiles|createAdditionalOriginalTicket|readUploadedOriginal|signOriginalPut/.test(body('src/pages/api/admin/special-additional-tests/scan-part.ts')),
    '解析に失敗した PDF を 10 年保管の原本バケットへ残さない (§9)');
  ok('B5-2 scan-part は DB へも書かない',
    !/persist|test_artifacts|measurement_values/.test(body('src/pages/api/admin/special-additional-tests/scan-part.ts')));

  // 6/7 全ページ処理・黙って捨てない
  const r = await finalizeBlood({ parts: [bloodPart(1), bloodPart(2), bloodPart(3)] });
  eq('B6 3 ページを全部処理する', r.json.page_count, 3);
  ok('B7 途中ページを黙って捨てない',
    /page 1\/3/.test(String(M.db.TABLES.test_artifacts[0].scan_md))
    && /page 2\/3/.test(String(M.db.TABLES.test_artifacts[0].scan_md))
    && /page 3\/3/.test(String(M.db.TABLES.test_artifacts[0].scan_md)),
    'scan_md に全ページの生出力が入る');
  ok('B7-2 既定のページ範囲を狭めていない',
    !/\b10\s*,\s*35\b/.test(part), '現行テスト画面の 10〜35 ページ既定を本番機能へ持ち込まない (§13.1)');

  // 8 20MB 超拒否
  const big = await M.addOrig.createAdditionalOriginalTicket({
    uid: UID_A, testType: 'blood', testDate: '2025-08-04',
    bytes: 20 * 1024 * 1024 + 1, sha256Base64: shaB64(PDF),
  });
  eq('B8 20MB 超は署名しない', [big.ok, big.error], [false, 'too_large']);
  ok('B8-2 上限は既存の定数のまま (20MB)',
    /MAX_ORIGINAL_BYTES = 20 \* 1024 \* 1024/.test(read('src/lib/originals-upload-ticket.ts')));
  ok('B8-3 上限を再定義せず import している',
    /import \{[^}]*MAX_ORIGINAL_BYTES/s.test(read('src/lib/additional-originals.ts'))
    && !/MAX_ORIGINAL_BYTES\s*=/.test(code('src/lib/additional-originals.ts').replace(/export \{[^}]*\}/g, '')));

  // 9 raw filename が S3 キーに入らない
  const t = await M.addOrig.createAdditionalOriginalTicket({
    uid: UID_A, testType: 'cancer_urine', testDate: '2025-08-04', bytes: PDF.byteLength, sha256Base64: shaB64(PDF),
  });
  eq('B9 キーは uid/種別/日付/sha256 だけ', t.key,
    `additional_results/${UID_A}/cancer_urine/2025_08_04/${shaHex(PDF)}.pdf`);
  ok('B9-2 チケットは元ファイル名を受け取らない',
    !/fileName|file_name|sourceFileName|originalName/.test(code('src/lib/additional-originals.ts')),
    '実ファイル名が氏名を含む (250804ALAPDS結果本田大作.pdf)');
  ok('B9-3 PDF 本体を関数 body で受けない',
    !/\bbody\.(pdf|file|image)\b/.test(code('src/pages/api/admin/special-additional-tests/original-ticket.ts')));

  // 検証器: 完全一致で見る (部分一致にしない)
  const bad = [
    'additional_results/../etc/passwd',
    `additional_results/${UID_A}/blood/2025_08_04/${shaHex(PDF)}.json`,
    `/additional_results/${UID_A}/blood/2025_08_04/${shaHex(PDF)}.pdf`,
    `additional_results/${UID_A}//blood/2025_08_04/${shaHex(PDF)}.pdf`,
    `additional_results/${UID_A}/blood/2025_13_04/${shaHex(PDF)}.pdf`,
    // **2026-10-01 以降 `health_checkup` は正当**（P7 で Admin 登録を足した）ので、
    // ここは「知らない検査種別」で見る。allow-list が閉じた集合であることが要点。
    `additional_results/${UID_A}/nanika/2025_08_04/${shaHex(PDF)}.pdf`,
    'lab_results/prevent/2025/08/x.pdf',
    `additional_results/${UID_A}/blood/2025_08_04/notasha.pdf`,
  ];
  eq('B10 不正キーを 8 件とも弾く', bad.filter((k) => M.addOrig.isAdditionalOriginalKey(k)).length, 0);
  eq('B10-2 正しいキーは通る', M.addOrig.isAdditionalOriginalKey(t.key), true);
  eq('B10-3 検診・人間ドックのキーも通る (P7 で対象に足した)',
    M.addOrig.isAdditionalOriginalKey(`additional_results/${UID_A}/health_checkup/2025_02_17/${shaHex(PDF)}.pdf`), true);
}

/* ══════════════════════════════════════════════════════════════════════
 * C. 日付 (§8 / §0.3 P-3)
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nC. 日付\n');
{
  resetAll();
  // 10 test_date 必須
  const r10 = await call(M.finalize, { ...BASE, testType: 'blood', originalKey: 'x', parts: [bloodPart()] });
  eq('C10 受診日が無ければ 400', [r10.status, r10.json.error], [400, 'invalid_test_date']);

  // 11 **today fallback 禁止** — 実行日が保存されていないことを実測する
  const today = new Date().toISOString().slice(0, 10);
  const r11 = await call(M.finalize, { ...BASE, testType: 'blood', testDate: '', originalKey: 'x', parts: [bloodPart()] });
  eq('C11 空の受診日を実行日で代用しない', r11.status, 400);
  eq('C11-2 DB に行が 1 件も作られていない', (M.db.TABLES.test_artifacts ?? []).length, 0);
  const r11b = await M.sat.saveAdditionalArtifact({
    uid: UID_A, testType: 'blood', testDate: 'not-a-date', markdownClean: 'x', measurements: [],
  });
  eq('C11-3 ライブラリ側でも弾く', [r11b.ok, r11b.error], [false, 'invalid_test_date']);
  eq('C11-4 today が紛れ込んでいない', (M.db.TABLES.test_artifacts ?? []).some((a) => a.test_date === today), false);

  // 12 ALA の受付日を明示指定できる
  resetAll();
  const key12 = M.addOrig.buildAdditionalOriginalKey({ uid: UID_A, testType: 'cancer_urine', testDate: '2025-08-04', sha256Hex: shaHex(PDF) });
  putOriginal(key12, PDF);
  const r12 = await call(M.finalize, {
    ...BASE, testType: 'cancer_urine', testDate: '2025-08-04', originalKey: key12,
    parts: [{ page: 1, measurements: [{ name: 'インデックス値', value: '1.2' }], raw_markdown: 'ala' }],
  });
  eq('C12 指定した受付日がそのまま入る', M.db.TABLES.test_artifacts[0].test_date, '2025-08-04');
  eq('C12-2 応答も同じ日付', r12.json.test_date, '2025-08-04');

  // 13 年度ごとに別 artifact
  resetAll();
  for (const d of ['2023-06-01', '2024-06-01', '2025-06-01', '2026-06-01']) {
    const k = M.addOrig.buildAdditionalOriginalKey({ uid: UID_A, testType: 'blood', testDate: d, sha256Hex: shaHex(PDF) });
    putOriginal(k, PDF);
    await call(M.finalize, { ...BASE, testType: 'blood', testDate: d, originalKey: k, parts: [bloodPart()] });
  }
  eq('C13 4 年分 → 4 artifact', M.db.TABLES.test_artifacts.length, 4);
  eq('C13-2 受診日が 4 通り', new Set(M.db.TABLES.test_artifacts.map((a) => a.test_date)).size, 4);
}

/* ══════════════════════════════════════════════════════════════════════
 * D. artifact (§18 / §0.3 P-1 / P-2) — **本機能の核心**
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nD. artifact\n');
{
  // 14 既存 0 件 → 新規
  resetAll();
  const r14 = await finalizeBlood();
  eq('D14 既存 0 件 → 新規作成', [r14.json.artifact_created, M.db.TABLES.test_artifacts.length], [true, 1]);
  eq('D14-2 source=admin_batch で作る', M.db.TABLES.test_artifacts[0].source, 'admin_batch');

  // 15 既存 1 件 → 更新 (増やさない)
  const r15 = await finalizeBlood();
  eq('D15 2 回目は既存を更新', [r15.json.artifact_created, M.db.TABLES.test_artifacts.length], [false, 1]);

  // 17 **wellfort_lab の既存行を複製しない**（本田さんの重複事故）
  resetAll();
  M.db.TABLES.test_artifacts = [{
    id: '22222222-2222-4222-8222-000000000001', diagnostic_user_id: UID_A,
    test_type: 'blood', test_date: '2025-08-04', status: 'active',
    source: 'wellfort_lab', display_mode: 'three_mode', external_test_id: 'EXT-777',
    lab_name: 'リージャー', scan_md: null, measurements: null,
  }];
  const r17 = await finalizeBlood();
  eq('D17 wellfort_lab の行を複製しない (1 件のまま)', M.db.TABLES.test_artifacts.length, 1);
  eq('D17-2 その既存行へ入れた', r17.json.test_artifact_id, '22222222-2222-4222-8222-000000000001');
  const a = M.db.TABLES.test_artifacts[0];
  eq('D18 display_mode を変更しない', a.display_mode, 'three_mode');
  eq('D19 external_test_id を変更しない', a.external_test_id, 'EXT-777');
  eq('D20 source を変更しない', a.source, 'wellfort_lab');
  eq('D20-2 lab_name も test_date も触らない', [a.lab_name, a.test_date], ['リージャー', '2025-08-04']);
  ok('D20-3 更新したのは scan_md と measurements だけ',
    M.db.WRITES.filter((w) => w.table === 'test_artifacts' && w.op === 'update')
      .every((w) => w.cols.every((c) => c === 'scan_md' || c === 'measurements')),
    `実際に書いた列: ${JSON.stringify(M.db.WRITES.filter((w) => w.table === 'test_artifacts' && w.op === 'update').map((w) => w.cols))}`);

  // 16 既存 2 件以上 → 409 artifact_ambiguous
  resetAll();
  M.db.TABLES.test_artifacts = [
    { id: '33333333-3333-4333-8333-000000000001', diagnostic_user_id: UID_A, test_type: 'blood', test_date: '2025-08-04', status: 'active', source: 'wellfort_lab', display_mode: 'single' },
    { id: '33333333-3333-4333-8333-000000000002', diagnostic_user_id: UID_A, test_type: 'blood', test_date: '2025-08-04', status: 'active', source: 'admin_batch', display_mode: 'single' },
  ];
  const r16 = await finalizeBlood();
  eq('D16 2 件以上は 409 artifact_ambiguous', [r16.status, r16.json.error], [409, 'artifact_ambiguous']);
  eq('D16-2 候補を返す', r16.json.candidates.length, 2);
  eq('D16-3 勝手に消さない・作らない', M.db.TABLES.test_artifacts.length, 2);

  // **検索条件に source が入っていない**（P-1 / P-2 の要）
  ok('D17-3 artifact 検索に source 条件が無い', (() => {
    const src = code('src/lib/special-additional-tests.ts');
    const i = src.indexOf('resolveAdditionalArtifact');
    const body = src.slice(i, src.indexOf('\n}', i));
    return !/\.eq\('source'/.test(body);
  })(), 'UNIQUE は source を含み external_test_id が NULL だと効かない = DB は止めてくれない');
}

/* ══════════════════════════════════════════════════════════════════════
 * E. original (§19 〜 §21 / §0.4.2)
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nE. original\n');
{
  // 21 SHA 同一 → no-op
  resetAll();
  await finalizeBlood();
  const r21 = await finalizeBlood();
  eq('E21 同じ PDF は already_registered', r21.json.original.already_registered, true);
  eq('E24 test_artifact_files は 1 件のまま', M.db.TABLES.test_artifact_files.length, 1);

  // 23 サーバが S3 実体から SHA を再算出する（自己申告を使わない）
  eq('E23 SHA は S3 の実体から', M.db.TABLES.test_artifact_files[0].sha256, shaHex(PDF));
  ok('E23-2 ブラウザ申告の sha256 を DB へ入れていない',
    !/body\.sha256|input\.sha256Base64/.test(code('src/lib/special-additional-tests.ts')));

  // 22 SHA 違い → original_conflict（**黙って差し替えない**）
  const key2 = M.addOrig.buildAdditionalOriginalKey({ uid: UID_A, testType: 'blood', testDate: '2025-08-04', sha256Hex: shaHex(PDF2) });
  putOriginal(key2, PDF2);
  const r22 = await call(M.finalize, {
    ...BASE, testType: 'blood', testDate: '2025-08-04', originalKey: key2, parts: [bloodPart()],
  });
  eq('E22 別の原本は 409 original_conflict', [r22.status, r22.json.error], [409, 'original_conflict']);
  eq('E22-2 原本を差し替えていない', M.db.TABLES.test_artifact_files.map((f) => f.sha256), [shaHex(PDF)]);
  ok('E22-3 register の replace 経路を呼んでいない',
    !/replace/.test(code('src/lib/special-additional-tests.ts')));

  /* ────────────────────────────────────────────────────────────────
   * **P0-B: 原本キーが この uid / 検査種別 / 受診日 のものか (binding)**
   *
   * `isAdditionalOriginalKey()` は**形**しか見ないので、
   * **別の人・別の検査・別の受診日の原本キー**を body に添えて送れた。
   * 通ると UID-A の PDF が UID-B の artifact へ `raw_pdf` として紐付く
   * (原本は 10 年保管・削除不可)。
   *
   * サーバが採番した形
   *   `additional_results/{uid}/{test_type}/{YYYY_MM_DD}/{sha256}.pdf`
   * を **S3 から読み戻した実 SHA で組み直して完全一致**を見る。
   * **DB mutation より前**で止まること (4 つとも unchanged) も併せて固定する。
   * ──────────────────────────────────────────────────────────────── */
  {
    const UID_OTHER = 'cccccccc-3333-4333-8333-333333333333';
    const mkKey = (uid, tt, d) => `additional_results/${uid}/${tt}/${d.replace(/-/g, '_')}/${shaHex(PDF)}.pdf`;
    const cases = [
      ['別 UID の原本キー', mkKey(UID_OTHER, 'blood', '2025-08-04')],
      ['別 検査種別 の原本キー', mkKey(UID_A, 'genetics', '2025-08-04')],
      ['別 受診日 の原本キー', mkKey(UID_A, 'blood', '2024-01-15')],
    ];
    for (const [label, key] of cases) {
      resetAll();
      putOriginal(key, PDF);                       // S3 には実在させる (形も SHA も正しい)
      const r = await call(M.finalize, {
        ...BASE, testType: 'blood', testDate: '2025-08-04', originalKey: key, parts: [bloodPart()],
      });
      eq(`P0-B ${label} は 409 invalid_original_binding`, [r.status, r.json.error], [409, 'invalid_original_binding']);
      eq(`P0-B ${label} — test_artifacts を作っていない`, (M.db.TABLES.test_artifacts ?? []).length, 0);
      eq(`P0-B ${label} — measurement_values を書いていない`, (M.db.TABLES.measurement_values ?? []).length, 0);
      eq(`P0-B ${label} — test_artifact_files を書いていない`, (M.db.TABLES.test_artifact_files ?? []).length, 0);
      eq(`P0-B ${label} — Elith へ 1 ファイルも出していない`, M.s3.S3.size, 0);
    }

    // 正しい binding は通る (弾きすぎていないこと)。
    resetAll();
    const okRes = await finalizeBlood();
    eq('P0-B 正しい原本キーは通る', [okRes.status, okRes.json.ok], [200, true]);
    eq('P0-B このとき原本は 1 件紐付く', (M.db.TABLES.test_artifact_files ?? []).length, 1);

    // SHA が実体と違うキー (= 中身を差し替えたのに名前は元のまま) も通さない。
    resetAll();
    const wrongSha = `additional_results/${UID_A}/blood/2025_08_04/${shaHex(PDF2)}.pdf`;
    putOriginal(wrongSha, PDF);                    // キーは PDF2 の SHA / 中身は PDF
    const rSha = await call(M.finalize, {
      ...BASE, testType: 'blood', testDate: '2025-08-04', originalKey: wrongSha, parts: [bloodPart()],
    });
    eq('P0-B キーの SHA と S3 の実体が食い違えば 409',
      [rSha.status, rSha.json.error], [409, 'invalid_original_binding']);
    eq('P0-B このときも DB は変わっていない', (M.db.TABLES.test_artifacts ?? []).length, 0);

    // 判定は DB mutation より前・自己申告でなく読み戻した実 SHA で組む。
    {
      const src = code('src/pages/api/admin/special-additional-tests/finalize.ts');
      ok('P0-B binding 確認が saveAdditionalArtifact より前にある',
        src.indexOf('invalid_original_binding') < src.indexOf('saveAdditionalArtifact({'));
      ok('P0-B **読み戻した実 SHA で組み直す** (body の申告を使わない)',
        /buildAdditionalOriginalKey\(\{[\s\S]{0,120}original\.sha256/.test(src),
        'original.sha256 = readAdditionalOriginal が S3 の実体から取った値');
    }
  }

  /* ────────────────────────────────────────────────────────────────
   * **P0-3: 競合で止めたとき DB が 1 つも変わっていないこと**
   *
   * 以前は `saveAdditionalArtifact()`（= `scan_md` / `measurements` /
   * `measurement_values` を更新する）を**通してから** `linkAdditionalOriginal()` で
   * 409 を返していた。409 で止めても **DB は戻らない**ので、
   * **原本は A のまま・ダッシュボードの値だけ B** という不整合が起こり得た。
   *
   * **E22-2 は原本しか見ていない**ので、これだけでは検出できない（実際に素通りした）。
   * 4 つ全部を見る。
   * ──────────────────────────────────────────────────────────────── */
  resetAll();
  await finalizeBlood();                                    // ① PDF A で登録
  const snapBefore = {
    artifacts: JSON.stringify(M.db.TABLES.test_artifacts ?? []),
    files: JSON.stringify(M.db.TABLES.test_artifact_files ?? []),
    values: JSON.stringify(M.db.TABLES.measurement_values ?? []),
  };
  const artBefore = (M.db.TABLES.test_artifacts ?? [])[0] ?? {};
  const keyB = M.addOrig.buildAdditionalOriginalKey({ uid: UID_A, testType: 'blood', testDate: '2025-08-04', sha256Hex: shaHex(PDF2) });
  putOriginal(keyB, PDF2);
  // ② **違う PDF B ＋ 違う検査値**で同じ回へ。競合で止まるべき。
  const rB = await call(M.finalize, {
    ...BASE, testType: 'blood', testDate: '2025-08-04', originalKey: keyB,
    parts: [{
      page: 1,
      measurements: [{ name: 'AST(GOT)', value: '999', unit: 'U/L', ref_low: '13', ref_high: '30' }],
      notes: [], raw_markdown: '| 検査項目 | 今回 |\n|---|---|\n| AST | 999 |',
    }],
  });
  eq('P0-3 違う原本は 409 original_conflict', [rB.status, rB.json.error], [409, 'original_conflict']);
  const artAfter = (M.db.TABLES.test_artifacts ?? [])[0] ?? {};
  eq('P0-3 **scan_md が変わっていない**', artAfter.scan_md, artBefore.scan_md);
  ok('P0-3 **scan_md に新しい値 (999) が入っていない**',
    !/999/.test(String(artAfter.scan_md ?? '')), String(artAfter.scan_md ?? '').slice(0, 120));
  eq('P0-3 **measurements が変わっていない**',
    JSON.stringify(artAfter.measurements ?? null), JSON.stringify(artBefore.measurements ?? null));
  eq('P0-3 **test_artifacts が丸ごと unchanged**', JSON.stringify(M.db.TABLES.test_artifacts ?? []), snapBefore.artifacts);
  eq('P0-3 **measurement_values が unchanged**', JSON.stringify(M.db.TABLES.measurement_values ?? []), snapBefore.values);
  eq('P0-3 **test_artifact_files が unchanged**', JSON.stringify(M.db.TABLES.test_artifact_files ?? []), snapBefore.files);
  ok('P0-3 **「保存済み」と言わない**（DB を変えていないので）',
    !/保存済み/.test(String(rB.json.note ?? '')), String(rB.json.note ?? ''));
  ok('P0-3 判定が DB mutation より前に置かれている',
    code('src/pages/api/admin/special-additional-tests/finalize.ts')
      .indexOf('preflightAdditionalOriginal') <
    code('src/pages/api/admin/special-additional-tests/finalize.ts')
      .indexOf('saveAdditionalArtifact({'),
    'preflight が saveAdditionalArtifact より後ろにある');
  ok('P0-3 preflight は read しかしない（insert / update / upsert を持たない）', (() => {
    const src = code('src/lib/special-additional-tests.ts');
    const i = src.indexOf('export async function preflightAdditionalOriginal');
    const j = src.indexOf('export async function linkAdditionalOriginal');
    const body = src.slice(i, j);
    return i > 0 && j > i && !/\.(insert|update|upsert|delete)\(/.test(body);
  })());

  /* ────────────────────────────────────────────────────────────────
   * **P0-4: 存在しない列で order しない**
   * `diagnosis.test_artifacts` に `created_at` は無い（`20260601000010:203` は
   * `imported_at`）。0 / 1 / 2 件以上の判定に順序は要らない。
   * ──────────────────────────────────────────────────────────────── */
  {
    const src = code('src/lib/special-additional-tests.ts');
    const i = src.indexOf('export async function resolveAdditionalArtifact');
    const j = src.indexOf('export type SaveResult');
    const body = src.slice(i, j);
    ok('P0-4 **resolveAdditionalArtifact が created_at で order しない**',
      i > 0 && j > i && !/\.order\(/.test(body), body.match(/\.order\([^)]*\)/)?.[0] ?? '');
    const ddl = read('supabase/migrations/20260601000010_schemas_and_tables.sql');
    const t = ddl.slice(ddl.indexOf('create table diagnosis.test_artifacts'), ddl.indexOf('create table diagnosis.test_artifact_files'));
    ok('P0-4 schema に created_at は無い（imported_at が正）',
      !/\bcreated_at\b/.test(t) && /\bimported_at\b/.test(t));
  }

  /* ────────────────────────────────────────────────────────────────
   * **H-2: 実在しない暦日で原本だけ S3 へ上げさせない**
   * 原本バケットは 10 年保管・削除不可。署名の段が形式だけを見ていると
   * `2026-02-31` の PDF が上がったあとに DB 保存が 400 で落ち、
   * **誰からも参照されない孤児ファイル**が残る。
   * ──────────────────────────────────────────────────────────────── */
  for (const bad of ['2026-02-31', '2025-13-45', '2025-00-10', '2023-02-29']) {
    const t = await M.addOrig.createAdditionalOriginalTicket({
      uid: UID_A, testType: 'blood', testDate: bad, bytes: 1234,
      sha256Base64: shaB64(PDF),
    });
    eq(`H-2 署名の段で実在しない暦日を弾く: ${bad}`, [t.ok, t.error], [false, 'invalid_test_date']);
    eq(`H-2 キーも組ませない: ${bad}`,
      M.addOrig.buildAdditionalOriginalKey({ uid: UID_A, testType: 'blood', testDate: bad, sha256Hex: shaHex(PDF) }), null);
  }
  eq('H-2 実在する閏日は通る (2024-02-29)',
    typeof M.addOrig.buildAdditionalOriginalKey({ uid: UID_A, testType: 'blood', testDate: '2024-02-29', sha256Hex: shaHex(PDF) }), 'string');
  ok('H-2 **日付判定の実装は 1 か所だけ**（段ごとに食い違わせない）', (() => {
    const files = [
      'src/lib/special-additional-tests.ts',
      'src/pages/api/admin/special-additional-tests/finalize.ts',
    ];
    // 複製（自前の暦日判定）を置いていないこと。共通の `isRealDate` を import している。
    return files.every((f) => !/function isRealDate/.test(code(f)) && /isRealDate/.test(code(f)))
      && /export function isRealDate/.test(code('src/lib/additional-originals.ts'));
  })());

  // 原本が S3 に無ければ DB へ 1 行も書かない（§28 の 3 番目）
  resetAll();
  const rNo = await call(M.finalize, {
    ...BASE, testType: 'blood', testDate: '2025-08-04',
    originalKey: `additional_results/${UID_A}/blood/2025_08_04/${shaHex(PDF)}.pdf`, parts: [bloodPart()],
  });
  eq('E-順序 原本が無ければ 404', [rNo.status, rNo.json.error], [404, 'not_found']);
  eq('E-順序2 DB へ 1 行も書いていない', (M.db.TABLES.test_artifacts ?? []).length, 0);

  // ── §0.4.2: 既存 API の契約を壊していないこと ──────────────────
  resetAll();
  const LAB_KEY = 'lab_results/prevent/2025/08/250804ALAPDS.pdf';
  putOriginal(LAB_KEY, PDF);
  M.db.TABLES.test_artifacts = [{
    id: '44444444-4444-4444-8444-000000000001', diagnostic_user_id: UID_A,
    test_type: 'cancer_urine', test_date: '2025-08-04', status: 'active', source: 'wellfort_lab', display_mode: 'three_mode',
  }];
  const reg1 = await call(M.register, { key: LAB_KEY, test_artifact_id: '44444444-4444-4444-8444-000000000001' });
  eq('E-register 初回は登録される', [reg1.status, reg1.json.ok], [200, true]);
  const reg2 = await call(M.register, { key: LAB_KEY, test_artifact_id: '44444444-4444-4444-8444-000000000001' });
  eq('E26 既存 register の 200 は already_registered:true のまま',
    [reg2.status, reg2.json.ok, reg2.json.already_registered], [200, true, true]);
  const LAB_KEY2 = 'lab_results/prevent/2025/08/other.pdf';
  putOriginal(LAB_KEY2, PDF2);
  const reg3 = await call(M.register, { key: LAB_KEY2, test_artifact_id: '44444444-4444-4444-8444-000000000001' });
  eq('E25 既存 register の 409 は error:"file_exists" のまま', [reg3.status, reg3.json.error], [409, 'file_exists']);
  ok('E25-2 `existing` を返す形も変わっていない', Array.isArray(reg3.json.existing) && reg3.json.existing.length === 1);
  eq('E27 追加検査の 409 は original_conflict (file_exists を返さない)', r22.json.error, 'original_conflict');

  // 28 **共通ライブラリに error 文字列と HTTP ステータスが現れない**
  const shared = code('src/lib/additional-originals.ts')
    // 型宣言と再エクスポートは対象外 (判定の戻り値ではない)
    .replace(/export \{[^}]*\}/g, '');
  ok('E28 共通ライブラリが API のエラー名を持たない',
    !/'file_exists'|"file_exists"|'original_conflict'|"original_conflict"/.test(shared),
    '表現を共有すると、片方を直したときにもう片方が黙って変わる (§0.4.2)');
  ok('E28-2 共通ライブラリが HTTP ステータスを決めない',
    !/\b(409|404|422)\b/.test(shared) && !/\bResponse\b/.test(shared));
  ok('E28-3 register も追加検査も同じ判定関数を使う',
    /decideOriginalRegistration/.test(read('src/pages/api/admin/lab-results/register.ts'))
    && /decideOriginalRegistration/.test(read('src/lib/special-additional-tests.ts')),
    '実装を 2 つ持たない');
}

/* ══════════════════════════════════════════════════════════════════════
 * F. 血液 (§11)
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nF. 血液\n');
{
  resetAll();
  const r = await finalizeBlood();
  eq('F25 PDF → BloodTestData', r.json.format_id, 'BloodTestData');
  ok('F26 measurements > 0', r.json.rows > 0, `rows=${r.json.rows}`);
  eq('F27 measurement_values へ保存', M.db.TABLES.measurement_values.length, r.json.rows);
  eq('F27-2 artifact の jsonb にも入る', Array.isArray(M.db.TABLES.test_artifacts[0].measurements), true);
  ok('F27-3 measurement の INSERT は persistMeasurements 経由だけ',
    !/measurement_values/.test(code('src/lib/special-additional-tests.ts'))
    && !/measurement_values/.test(code('src/pages/api/admin/special-additional-tests/finalize.ts')),
    '別の INSERT ロジックを作らない (§22 / §47)');
  ok('F28 CSV 通常経路に変更なし',
    !/elith-blood-csv|demecal/i.test(code('src/lib/special-additional-tests.ts'))
    && !/elith-blood-csv|demecal/i.test(code('src/pages/api/admin/special-additional-tests/finalize.ts')),
    '血液 CSV 処理を PDF 処理へ統合しない (§4.1 / §47)');
  ok('F-整形 既存の整形をこの順で通している', (() => {
    const s = code('src/pages/api/admin/special-additional-tests/finalize.ts');
    const i1 = s.indexOf('sanitizeMeasurementsForDelivery');
    const i2 = s.indexOf('canonicalize(');
    const i3 = s.indexOf('dedupObservations(');
    return i1 > 0 && i2 > i1 && i3 > i2;
  })(), 'sanitize → canonicalize → dedup (§11)');
}

/* ══════════════════════════════════════════════════════════════════════
 * G. ALA (§12)
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nG. ALA\n');
{
  resetAll();
  const key = M.addOrig.buildAdditionalOriginalKey({ uid: UID_A, testType: 'cancer_urine', testDate: '2025-12-26', sha256Hex: shaHex(PDF) });
  putOriginal(key, PDF);
  const r = await call(M.finalize, {
    ...BASE, testType: 'cancer_urine', testDate: '2025-12-26', originalKey: key,
    parts: [{
      page: 1, raw_markdown: 'ALA-PDS',
      measurements: [
        { name: '尿中のポルフィリン量', value: '0.8/8.0', unit: 'μg/gCr' },
        { name: 'インデックス値', value: '1.2' },
        // 目安表の閾値 (捏造の元)。normalizeCancerRisk が落とす。
        { name: 'インデックス値', value: '2.0未満' },
      ],
    }],
  });
  eq('G29 format は CancerRiskAssessmentData', r.json.format_id, 'CancerRiskAssessmentData');
  ok('G29-2 既存の normalizeCancerRisk を使う (再実装しない)',
    /normalizeCancerRisk/.test(read('src/pages/api/admin/special-additional-tests/finalize.ts'))
    && !/ポルフィリン|インデックス値/.test(code('src/pages/api/admin/special-additional-tests/finalize.ts')),
    'ALA-PDS の正規化を書き写さない (§12 / §47)');
  ok('G30 ALA 値が Dashboard 層に入る',
    M.db.TABLES.measurement_values.some((m) => m.item_name === '尿中のポルフィリン量'),
    JSON.stringify(M.db.TABLES.measurement_values.map((m) => m.item_name)));
  ok('G31 目安表の閾値が納品に残っていない',
    !JSON.stringify(M.db.TABLES.test_artifacts[0].measurements).includes('2.0未満'));
}

/* ══════════════════════════════════════════════════════════════════════
 * H. 遺伝子 / AI 疾病 (§13 / §14)
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nH. 遺伝子 / AI 疾病\n');
{
  resetAll();
  const key = M.addOrig.buildAdditionalOriginalKey({ uid: UID_A, testType: 'genetics', testDate: '2025-03-10', sha256Hex: shaHex(PDF) });
  putOriginal(key, PDF);
  const r = await call(M.finalize, {
    ...BASE, testType: 'genetics', testDate: '2025-03-10', originalKey: key,
    parts: [itemsPart(1), itemsPart(2)],
  });
  eq('H32 items 形式で納品 JSON を作る', r.json.item_count, 2);
  const src = JSON.parse(M.s3.S3.get(r.json.source_key));
  eq('H32-2 data.items[] を持つ', Array.isArray(src.data.items), true);
  eq('H33 rows=0 を成功扱いにする', [r.json.ok, r.json.rows], [true, 0]);
  eq('H33-2 measurement_values は 0 件で正常', (M.db.TABLES.measurement_values ?? []).length, 0);
  ok('H34 scan_md を保存する', String(M.db.TABLES.test_artifacts[0].scan_md).includes('page 1 raw'));
  eq('H35 原本が紐付く', M.db.TABLES.test_artifact_files.length, 1);

  // AI 疾病発症予測 = format_id Other
  resetAll();
  const k2 = M.addOrig.buildAdditionalOriginalKey({ uid: UID_A, testType: 'ai_prediction', testDate: '2025-08-18', sha256Hex: shaHex(PDF) });
  putOriginal(k2, PDF);
  const r2 = await call(M.finalize, { ...BASE, testType: 'ai_prediction', testDate: '2025-08-18', originalKey: k2, parts: [itemsPart(1)] });
  eq('H-LAiF format_id は Other', r2.json.format_id, 'Other');
  eq('H-LAiF test_type は ai_prediction', M.db.TABLES.test_artifacts[0].test_type, 'ai_prediction');
  eq('H-LAiF lab_name を JSON に入れる', JSON.parse(M.s3.S3.get(r2.json.source_key)).source.lab_name, 'LAiF');
}

/* ══════════════════════════════════════════════════════════════════════
 * I. Elith (§23 〜 §33)
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nI. Elith\n');
{
  // 36 local 保存完了前に production へ出ない
  resetAll();
  M.db.FAIL.insert = 'test_artifacts';
  const r36 = await finalizeBlood();
  eq('I36 artifact 保存に失敗したら 5xx', r36.status >= 400, true);
  eq('I36-2 本番 user/ へ 1 件も書いていない', [...M.s3.S3.keys()].filter((k) => k.startsWith('user/')).length, 0);
  M.db.FAIL.insert = null;

  // 37/38 raw_markdown / bbox が production JSON に無い
  resetAll();
  const r = await finalizeBlood();
  eq('I-納品 verified', r.json.delivery.verified, true);
  const destKey = r.json.delivery.destination_key;
  eq('I-納品先 キーを組み替えない (prefix を外すだけ)', destKey, r.json.source_key.replace('scan-accuracy-test/', ''));
  const dest = JSON.parse(M.s3.S3.get(destKey));
  eq('I37 raw_markdown が無い', 'raw_markdown' in dest, false);
  eq('I37-2 assembled_from も無い', 'assembled_from' in dest, false);
  eq('I38 data.regions が無い', 'regions' in dest.data, false);
  ok('I38-2 bbox / region が 1 つも無い', !/"bbox"|"region"/.test(JSON.stringify(dest)));

  // source 側に版面情報を混ぜても納品側で落ちること (サニタイズを通している証拠)
  resetAll();
  const dirtyKey = `scan-accuracy-test/user/${UID_A}/date/2025_08_04/BloodTestData_date_2025_08_04_user_${UID_A}.json`;
  M.s3.S3.set(dirtyKey, JSON.stringify({
    format_id: 'BloodTestData', client_id: 'OLD-ID', test_date: '2025-08-04',
    raw_markdown: '| 表 |', assembled_from: ['x'],
    data: { regions: [{ bbox: [1, 2, 3, 4] }], measurements: [{ name: 'AST(GOT)', value: '22', region: 'r1', bbox: [1, 2] }] },
  }));
  const d = await M.deliv.deliverAdditionalJson({ sourceKey: dirtyKey, uid: UID_A, subject: null });
  const clean = JSON.parse(M.s3.S3.get(d.destinationKey));
  eq('I37-3 版面情報を持つ source でも納品側は綺麗', [
    'raw_markdown' in clean, 'assembled_from' in clean, 'regions' in clean.data,
    JSON.stringify(clean.data.measurements).includes('bbox'),
  ], [false, false, false, false]);
  eq('I37-4 client_id を書き換える', clean.client_id, UID_A);
  ok('I37-5 サニタイズを共用している (別実装を作っていない)',
    /rewriteClientId/.test(read('src/lib/elith-delivery-json.ts'))
    && /export function sanitizeDelivery/.test(read('src/lib/elith-assemble.ts')));

  // 39/40 対象 format 以外・非 JSON をコピーしない
  resetAll();
  M.s3.S3.set(`scan-accuracy-test/user/${UID_A}/date/2025_08_04/HealthCheckupData_date_2025_08_04_user_${UID_A}.json`, '{"format_id":"HealthCheckupData"}');
  M.s3.S3.set(`scan-accuracy-test/user/${UID_A}/date/2025_08_04/HealthCheckupData_date_2025_08_04_user_${UID_A}_01.jpg`, 'JPEGDATA');
  const r39 = await finalizeBlood();
  const delivered = [...M.s3.S3.keys()].filter((k) => k.startsWith('user/'));
  eq('I39 納品したのは今回の 1 ファイルだけ', delivered, [r39.json.delivery.destination_key]);
  ok('I40 非 JSON をコピーしていない', !delivered.some((k) => !k.toLowerCase().endsWith('.json')));
  ok('I39-2 elith-delivery-promote を呼んでいない',
    !/delivery-promote|promoteKey/.test(code('src/lib/elith-delivery-json.ts'))
    && !/delivery-promote|promoteKey/.test(code('src/pages/api/admin/special-additional-tests/finalize.ts')),
    'あの API は uid 配下を全部コピーする (§24 / §47)');
  eq('I40-2 toDestinationKey は .json 以外を返さない',
    M.deliv.toDestinationKey(`scan-accuracy-test/user/${UID_A}/date/2025_08_04/x_01.jpg`, 'scan-accuracy-test/'), null);
  eq('I40-3 prefix 配下でないキーも null',
    M.deliv.toDestinationKey(`user/${UID_A}/date/2025_08_04/x.json`, 'scan-accuracy-test/'), null);

  // 41 readback SHA 一致
  const item = M.db.TABLES.elith_delivery_items[0];
  eq('I41 source と destination の SHA が一致', item.source_sha256 === item.destination_sha256, true);
  eq('I41-2 status=delivered', item.status, 'delivered');
  eq('I41-3 読み戻した SHA が本物',
    item.destination_sha256, shaHex(new TextEncoder().encode(M.s3.S3.get(r39.json.delivery.destination_key))));
  // 読み戻しは **共通 helper `putVerified`** が持つ (D-1・2026-10-01 に一本化)。
  // 本体の納品経路にも同じ性質が要るので、片方だけ直る形をやめた。
  ok('I41-4 PutObject の成功だけで delivered にしていない',
    /getObjectText\(f\.key\)/.test(read('src/lib/s3-verified-put.ts'))
    && /putVerified\(/.test(code('src/lib/elith-delivery-json.ts')));

  // 42 再実行で delivery item 増殖なし
  await finalizeBlood();
  await finalizeBlood();
  eq('I42 何度実行しても delivery item は 1 行', M.db.TABLES.elith_delivery_items.length, 1);
  ok('I42-2 attempt_count が進む', M.db.TABLES.elith_delivery_items[0].attempt_count >= 3,
    `attempt_count=${M.db.TABLES.elith_delivery_items[0].attempt_count}`);
  eq('I42-3 artifact も原本も増えない',
    [M.db.TABLES.test_artifacts.length, M.db.TABLES.test_artifact_files.length], [1, 1]);
  eq('I42-4 本番 S3 のキーも増えない', [...M.s3.S3.keys()].filter((k) => k.startsWith('user/')).length, 1);

  // 43 elith_deliveries を書き換えない
  eq('I43 elith_deliveries へ 1 度も書いていない',
    M.db.WRITES.filter((w) => w.table === 'elith_deliveries').length, 0);
  ok('I43-2 コードからも触っていない',
    !/elith_deliveries/.test(code('src/lib/elith-delivery-json.ts'))
    && !/elith_deliveries/.test(code('src/pages/api/admin/special-additional-tests/finalize.ts')));

  // 44 manifest を作らない
  ok('I44 manifest.json を 1 つも作らない', ![...M.s3.S3.keys()].some((k) => k.endsWith('manifest.json')));
  ok('I44-2 コードに manifest が出てこない',
    !/manifest/i.test(code('src/lib/elith-delivery-json.ts'))
    && !/manifest/i.test(code('src/pages/api/admin/special-additional-tests/finalize.ts')));

  // §32 Elith 本番だけ失敗 → Dashboard の登録は残す
  resetAll();
  const keyF = M.addOrig.buildAdditionalOriginalKey({ uid: UID_A, testType: 'blood', testDate: '2025-08-04', sha256Hex: shaHex(PDF) });
  putOriginal(keyF, PDF);
  // 納品まで行かせずに止めたとき、**Dashboard 側の登録は残る**こと。
  const rFail = await call(M.finalize, {
    ...BASE, testType: 'blood', testDate: '2025-08-04', originalKey: keyF, parts: [bloodPart()], deliver: false,
  });
  eq('I-32 deliver:false でも DB の登録は残る',
    [rFail.json.ok, M.db.TABLES.test_artifacts.length, M.db.TABLES.test_artifact_files.length], [true, 1, 1]);
  eq('I-32-2 本番へは出していない', [...M.s3.S3.keys()].filter((k) => k.startsWith('user/')).length, 0);
  ok('I-32-3 失敗時は status=failed で残す (再実行できる)',
    /status: d\.verified \? 'delivered' : 'failed'/.test(read('src/pages/api/admin/special-additional-tests/finalize.ts')));
}

/* ══════════════════════════════════════════════════════════════════════
 * J. 複数年 (§34)
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nJ. 複数年\n');
{
  resetAll();
  for (const d of ['2023-05-10', '2024-05-10', '2025-05-10', '2026-05-10']) {
    const k = M.addOrig.buildAdditionalOriginalKey({ uid: UID_A, testType: 'blood', testDate: d, sha256Hex: shaHex(PDF) });
    putOriginal(k, PDF);
    await call(M.finalize, { ...BASE, testType: 'blood', testDate: d, originalKey: k, parts: [bloodPart()] });
  }
  eq('J45 血液 4 年 → 4 artifact', M.db.TABLES.test_artifacts.length, 4);
  eq('J45-2 納品先も 4 フォルダ', new Set([...M.s3.S3.keys()].filter((k) => k.startsWith('user/')).map((k) => k.split('/')[3])).size, 4);

  resetAll();
  for (const d of ['2024-12-26', '2025-12-26']) {
    const k = M.addOrig.buildAdditionalOriginalKey({ uid: UID_A, testType: 'cancer_urine', testDate: d, sha256Hex: shaHex(PDF) });
    putOriginal(k, PDF);
    await call(M.finalize, { ...BASE, testType: 'cancer_urine', testDate: d, originalKey: k, parts: [{ page: 1, raw_markdown: 'ala', measurements: [{ name: 'インデックス値', value: '1.2' }] }] });
  }
  eq('J46 がん複数年 → 各日付独立', M.db.TABLES.test_artifacts.length, 2);

  resetAll();
  for (const d of ['2024-08-18', '2025-08-18']) {
    const k = M.addOrig.buildAdditionalOriginalKey({ uid: UID_A, testType: 'ai_prediction', testDate: d, sha256Hex: shaHex(PDF) });
    putOriginal(k, PDF);
    await call(M.finalize, { ...BASE, testType: 'ai_prediction', testDate: d, originalKey: k, parts: [itemsPart(1)] });
  }
  eq('J47 AI 疾病複数年 → 各日付独立', M.db.TABLES.test_artifacts.length, 2);

  // 48 1 件失敗しても他年度を処理できる（**全件を 1 トランザクションにしない**）
  resetAll();
  const years = ['2023-05-10', '2024-05-10', '2025-05-10', '2026-05-10'];
  const results = [];
  for (const d of years) {
    if (d === '2025-05-10') {
      // この年だけ原本を置かない = 失敗させる
      results.push(await call(M.finalize, { ...BASE, testType: 'blood', testDate: d, parts: [bloodPart()], originalKey: `additional_results/${UID_A}/blood/${d.replace(/-/g, '_')}/${shaHex(PDF)}.pdf` }));
      continue;
    }
    const k = M.addOrig.buildAdditionalOriginalKey({ uid: UID_A, testType: 'blood', testDate: d, sha256Hex: shaHex(PDF) });
    putOriginal(k, PDF);
    results.push(await call(M.finalize, { ...BASE, testType: 'blood', testDate: d, originalKey: k, parts: [bloodPart()] }));
  }
  eq('J48 1 件失敗しても残り 3 年は登録できる', results.map((r) => r.json.ok), [true, true, false, true]);
  eq('J48-2 成功した 3 年ぶんが残る', M.db.TABLES.test_artifacts.length, 3);
}

/* ══════════════════════════════════════════════════════════════════════
 * M. 0 件になった場所を切り分けられるか (P0 2026-10-06)
 *
 * 「検査値を 1 件も読み取れません」が **どこで起きたのか**を画面で判別できるように、
 * `scan-part` が内訳を返す。実際の原因は A (pdf.js が CMap 未設定で日本語を
 * 描けず、枠だけの画像を送っていた) だったが、**それを確かめる手段が無かった**。
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nM. 0 件の切り分け\n');
{
  const part = code('src/pages/api/admin/special-additional-tests/scan-part.ts');
  ok('M1 regions / table / rows の件数を返す',
    /parse_diag:\s*\{/.test(part) && /regions: s\.regions\.length/.test(part)
    && /table_regions:/.test(part) && /table_rows:/.test(part));
  ok('M2 **列見出し**も返す (列名が合わずに落ちる C を目で見るため)',
    /table_columns:/.test(part));
  ok('M3 検査値そのものを増やして返していない (measurements / raw_markdown のまま)',
    !/parse_diag[\s\S]{0,400}(values|rows: r\.rows\b)/.test(part));
  ok('M4 items 形式 (遺伝子 / AI疾病) の応答は変えていない',
    /kind: 'items'/.test(part) && !/parse_diag[\s\S]{0,200}kind: 'items'/.test(part));
}

/* ══════════════════════════════════════════════════════════════════════
 * L. cold instance の app_config (P0 2026-10-06)
 *
 * `isSpecialAccount()` は同期関数で `cfg('special.account_uids')` を読むだけなので、
 * **呼ぶ側が先に `refreshConfig()` 済みであること**が前提 (`app-config.ts`)。
 * Vercel の cold instance は cache が null で入るため、これを忘れると
 * **DB に登録済みの uid まで `not_special_account`** になる
 * (実測: トランスコスモス 10 名が original-ticket で 10/10 全員 403)。
 * `report-finalize.ts` は元から `await refreshConfig(true)` を踏んでいた。
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nL. cold instance の app_config\n');
{
  resetAll();
  // **env `SPECIAL_ALLOWED_UIDS` には無く、DB (app_config) にだけ在る uid** を使う。
  // UID_A は bundle 時の define で特別扱いされるので、ここでは使えない。
  const UID_COLD = 'cccccccc-3333-4333-8333-333333333333';
  const UID_NONE = 'dddddddd-4444-4444-8444-444444444444';
  M.db.TABLES.app_config = [{ key: 'special.account_uids', value: UID_COLD }];

  const t = { testType: 'ai_prediction', testDate: '2026-09-28', bytes: PDF.byteLength, sha256Base64: shaB64(PDF) };

  // 1 cache 未ロード (cold) でも、DB に在れば通る
  const r1 = await call(M.ticket, { diagnosticUserId: UID_COLD, ...t });
  eq('L1 app_config にしか無い uid でも署名が出る', [r1.status, r1.json.ok], [200, true]);
  eq('L1-2 キーはサーバが採番する (氏名も元ファイル名も入らない)',
    r1.json.key, `additional_results/${UID_COLD}/ai_prediction/2026_09_28/${shaHex(PDF)}.pdf`);

  // 2 登録の無い uid は従来どおり弾く (ゲートを緩めていない)
  const r2 = await call(M.ticket, { diagnosticUserId: UID_NONE, ...t });
  eq('L2 登録の無い uid は 403 のまま', [r2.status, r2.json.error], [403, 'not_special_account']);

  // 3 順序を固定する — 後ろへ動かすと cold instance で同じ事故が再発する
  const src = code('src/pages/api/admin/special-additional-tests/original-ticket.ts');
  const iRefresh = src.indexOf('refreshConfig(');
  const iTarget = src.indexOf('checkAdditionalTarget(');
  ok('L3 refreshConfig が checkAdditionalTarget より前にある',
    iRefresh >= 0 && iTarget >= 0 && iRefresh < iTarget,
    '同期の isSpecialAccount を呼ぶ前に app_config を読み直す');
  ok('L3-2 force=true で読み直す', /refreshConfig\(\s*true\s*\)/.test(src),
    '管理者が明示的に実行する操作なので TTL 45 秒の古い資格情報を使わない');
}

/* ══════════════════════════════════════════════════════════════════════
 * その他: PII / 禁止事項 (§38 / §39 / §43 / §47)
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nX. PII / 禁止事項\n');
{
  const newFiles = [
    'src/lib/additional-originals.ts',
    'src/lib/elith-delivery-json.ts',
    'src/lib/special-additional-tests.ts',
    'src/pages/api/admin/special-additional-tests/scan-part.ts',
    'src/pages/api/admin/special-additional-tests/original-ticket.ts',
    'src/pages/api/admin/special-additional-tests/finalize.ts',
  ];
  for (const f of newFiles) {
    ok(`X-PII ${f} が生メール / 氏名 / 生年月日を扱わない`,
      !/\bemail\b|date_of_birth|\bdob\b|full_name|customer_profiles/i.test(code(f)),
      '対象の識別は diagnostic_user_id だけ (§39)');
  }
  ok('X-鍵 新規ファイルに鍵が現れない',
    !newFiles.some((f) => /ADMIN_API_KEY\s*[:=]|SCAN_CHAT_AI_API_KEY|AWS_SECRET|service_role/.test(code(f))),
    'ブラウザへ鍵を出さない (§38)');
  ok('X-納品JSON に元ファイル名を載せない',
    !/source_image|source_file|fileName/.test(code('src/lib/elith-delivery-json.ts')),
    '実ファイル名が氏名を含む (§39)');

  // 納品 JSON を実際に見る
  resetAll();
  const r = await finalizeBlood();
  const src = JSON.parse(M.s3.S3.get(r.json.source_key));
  eq('X-納品 subject に生年月日が無い', Object.keys(src.subject).sort(), ['age', 'sex']);
  ok('X-納品 キーに氏名が無い', !/[ぁ-んァ-ン一-龥]/.test(r.json.source_key + r.json.original.key));

  // §43 今回実装しないもの
  ok('X-対象外 ユーザー自身のアップロード口を作っていない',
    !/pages\/api\/scan/.test(code('src/lib/special-additional-tests.ts')));
  ok('X-対象外 ウェルネス年齢の自動再計算をしていない',
    !/computeWellnessAge|writeHealthAgeFor/.test(code('src/pages/api/admin/special-additional-tests/finalize.ts')),
    '血液 PDF からウェルネス年齢を自動再計算しない (§43)');

  // §42 絶対に変更しない機能 — 触っていないことを機械で見る
  ok('X-不変 通常スキャンの保存口 (saveScanResult) を変えていない',
    /export async function saveScanResult/.test(read('src/lib/scan-persist.ts')));
  ok('X-不変 elith-assemble は export を足しただけ',
    /\*\*2026-09-30: `export` を足しただけ。中身は 1 行も変えていない/.test(read('src/lib/elith-assemble.ts')));
  ok('X-不変 elith-delivery も export を足しただけ',
    /\*\*2026-09-30: `export` を足しただけ。中身は 1 行も変えていない/.test(read('src/lib/elith-delivery.ts')));

  // migration の規律
  const mig = read('supabase/migrations/20260930000060_elith_delivery_items.sql');
  ok('X-DDL RLS を有効化している', /enable row level security/.test(mig));
  ok('X-DDL ポリシーを作っていない', !/create policy/i.test(mig));
  ok('X-DDL anon / authenticated から revoke', /revoke all on diagnosis\.elith_delivery_items from anon, authenticated/.test(mig));
  ok('X-DDL 一意キーは (artifact, format, destination)',
    /unique \(test_artifact_id, format_id, destination_key\)/.test(mig));
}

/* ══════════════════════════════════════════════════════════════════════
 * K. 退行注入 — 「検査が本当に落ちるか」(§44 K)
 * ════════════════════════════════════════════════════════════════════ */
console.log('\nK. 退行注入 (**壊して落ちることを確かめる**)\n');

const ORIGINALS_OF = {};
for (const p of [
  'src/lib/special-additional-tests.ts',
  'src/lib/additional-originals.ts',
  'src/lib/elith-delivery-json.ts',
  'src/pages/api/admin/special-additional-tests/finalize.ts',
]) ORIGINALS_OF[p] = read(p);
const restore = () => { for (const [p, s] of Object.entries(ORIGINALS_OF)) writeFileSync(resolve(ROOT, p), s); };

/** ファイルを壊して bundle し直し、`probe` が false（= 検査が落ちる）ことを確かめる。 */
async function inject(label, edits, probe, why) {
  try {
    for (const [p, from, to] of edits) {
      const cur = read(p);
      if (!cur.includes(from)) { fails.push(`${label} — 注入箇所が見つからない: ${from.slice(0, 60)}`); console.log(`  ✗ ${label}`); return; }
      writeFileSync(resolve(ROOT, p), cur.replace(from, to));
    }
    const mod = await bundle();
    const survived = await probe(mod);
    ok(`${label} → ${why}`, survived === false, '**壊しても検査が通ってしまった** (検査が効いていない)');
  } catch (e) {
    ok(`${label} → ${why}`, true, String(e));
  } finally {
    restore();
  }
}

// K-1: artifact 検索に source 条件を足す → 17 が落ちる
await inject('K-1 検索に source を足す', [[
  'src/lib/special-additional-tests.ts',
  ".eq('status', 'active')",
  ".eq('status', 'active')\n    .eq('source', 'admin_batch')",
]], async (mod) => {
  mod.db.reset(); mod.s3.reset(); mod.orig.reset();
  mod.db.TABLES.test_artifacts = [{
    id: '22222222-2222-4222-8222-000000000001', diagnostic_user_id: UID_A,
    test_type: 'blood', test_date: '2025-08-04', status: 'active', source: 'wellfort_lab', display_mode: 'three_mode',
  }];
  const k = mod.addOrig.buildAdditionalOriginalKey({ uid: UID_A, testType: 'blood', testDate: '2025-08-04', sha256Hex: shaHex(PDF) });
  mod.orig.ORIGINALS.set(k, PDF);
  await mod.finalize.POST({ request: req({ diagnosticUserId: UID_A, testType: 'blood', testDate: '2025-08-04', originalKey: k, parts: [bloodPart()] }) });
  return mod.db.TABLES.test_artifacts.length === 1; // 増えていなければ「検査が落ちない」= 問題
}, 'D17 wellfort_lab の行を複製しない が落ちる');

// K-2: persistAdminBatchArtifact を無条件に呼ぶ → 14/15/17 が落ちる
await inject('K-2 常に新規作成する', [[
  'src/lib/special-additional-tests.ts',
  "  if (found.kind === 'one') {",
  "  if (false && found.kind === 'one') {",
]], async (mod) => {
  mod.db.reset(); mod.s3.reset(); mod.orig.reset();
  const k = mod.addOrig.buildAdditionalOriginalKey({ uid: UID_A, testType: 'blood', testDate: '2025-08-04', sha256Hex: shaHex(PDF) });
  mod.orig.ORIGINALS.set(k, PDF);
  const body = { diagnosticUserId: UID_A, testType: 'blood', testDate: '2025-08-04', originalKey: k, parts: [bloodPart()] };
  await mod.finalize.POST({ request: req(body) });
  await mod.finalize.POST({ request: req(body) });
  return mod.db.TABLES.test_artifacts.length === 1;
}, 'D15 2 回目は既存を更新 が落ちる');

// K-3: test_date を today へ fallback させる → 11 が落ちる
await inject('K-3 受診日を today へ落とす', [[
  'src/lib/special-additional-tests.ts',
  "  if (!isRealDate(input.testDate)) {\n    return { ok: false, error: 'invalid_test_date', detail: '受診日 (実在する YYYY-MM-DD) が要ります。実行日で代用しません。' };\n  }",
  "  if (!isRealDate(input.testDate)) {\n    input = { ...input, testDate: new Date().toISOString().slice(0, 10) };\n  }",
]], async (mod) => {
  mod.db.reset();
  const r = await mod.sat.saveAdditionalArtifact({ uid: UID_A, testType: 'blood', testDate: 'not-a-date', markdownClean: 'x', measurements: [] });
  return r.ok === false && r.error === 'invalid_test_date';
}, 'C11-3 ライブラリ側でも弾く が落ちる');

// K-4: sanitizeDelivery を通さず納品する → 37/38 が落ちる
await inject('K-4 サニタイズを通さない', [[
  'src/lib/elith-delivery-json.ts',
  '  const { text: deliveryText } = rewriteClientId(sourceText, input.uid, input.sourceKey, input.subject ?? null);',
  '  const deliveryText = sourceText;',
]], async (mod) => {
  mod.s3.reset();
  const key = `scan-accuracy-test/user/${UID_A}/date/2025_08_04/BloodTestData_date_2025_08_04_user_${UID_A}.json`;
  mod.s3.S3.set(key, JSON.stringify({ format_id: 'BloodTestData', client_id: 'OLD', raw_markdown: '| 表 |', data: { regions: [{ bbox: [1] }], measurements: [] } }));
  const d = await mod.deliv.deliverAdditionalJson({ sourceKey: key, uid: UID_A, subject: null });
  const dest = JSON.parse(mod.s3.S3.get(d.destinationKey));
  return !('raw_markdown' in dest) && !('regions' in dest.data);
}, 'I37/I38 raw_markdown・bbox が無い が落ちる');

// K-5: elith-delivery-promote の全件コピーを呼ぶ → 39 が落ちる
await inject('K-5 uid 配下を全件コピーする', [[
  'src/lib/elith-delivery-json.ts',
  '  const [r] = await putVerified([{',
  `  {
    const { listObjects: __ls, copyObjects: __cp } = await import('./s3');
    const all = await __ls(\`\${normPrefix(cfg.prefix)}user/\${input.uid}/\`);
    await __cp(all.map((o) => ({ from: o.key, to: o.key.slice(normPrefix(cfg.prefix).length) })));
  }
  const [r] = await putVerified([{`,
]], async (mod) => {
  mod.db.reset(); mod.s3.reset(); mod.orig.reset();
  mod.s3.S3.set(`scan-accuracy-test/user/${UID_A}/date/2025_08_04/HealthCheckupData_date_2025_08_04_user_${UID_A}.json`, '{"format_id":"HealthCheckupData"}');
  const k = mod.addOrig.buildAdditionalOriginalKey({ uid: UID_A, testType: 'blood', testDate: '2025-08-04', sha256Hex: shaHex(PDF) });
  mod.orig.ORIGINALS.set(k, PDF);
  const res = await mod.finalize.POST({ request: req({ diagnosticUserId: UID_A, testType: 'blood', testDate: '2025-08-04', originalKey: k, parts: [bloodPart()] }) });
  const j = await res.json();
  const delivered = [...mod.s3.S3.keys()].filter((x) => x.startsWith('user/'));
  return JSON.stringify(delivered) === JSON.stringify([j.delivery?.destination_key]);
}, 'I39 納品したのは今回の 1 ファイルだけ が落ちる');

// K-6: 生ファイル名で S3 キーを組む → 9 が落ちる
await inject('K-6 生ファイル名でキーを組む', [[
  'src/lib/additional-originals.ts',
  '  return `additional_results/${input.uid.toLowerCase()}/${input.testType}/${dateFolder(input.testDate)}/${input.sha256Hex}.pdf`;',
  '  return `additional_results/${input.uid.toLowerCase()}/${input.testType}/${dateFolder(input.testDate)}/250804ALAPDS結果本田大作.pdf`;',
]], async (mod) => {
  const t = await mod.addOrig.createAdditionalOriginalTicket({
    uid: UID_A, testType: 'cancer_urine', testDate: '2025-08-04', bytes: PDF.byteLength, sha256Base64: shaB64(PDF),
  });
  return t.ok === true && t.key === `additional_results/${UID_A}/cancer_urine/2025_08_04/${shaHex(PDF)}.pdf`;
}, 'B9 キーは uid/種別/日付/sha256 だけ が落ちる');

// K-7: 共通ライブラリが API のエラー名を返すようにする
//   → **この実装では E28 が落ちる**。仕様書 §44 K の表は「25 が落ちる」としているが、
//     `register.ts` は判定をそのまま転送していない（§0.4.2 の分離ができている）ので
//     25 は通る。**通ってしまう検査を「落ちる」と書かない**ためここは E28 で見る。
await inject('K-7 共通ライブラリが API のエラー名を返す', [[
  'src/lib/additional-originals.ts',
  "  return { decision: 'different_sha', existing: prior };",
  "  return { decision: 'original_conflict', existing: prior };",
], [
  'src/lib/additional-originals.ts',
  "export type OriginalDecision = 'none' | 'same_sha' | 'different_sha';",
  "export type OriginalDecision = 'none' | 'same_sha' | 'original_conflict';",
], [
  'src/lib/special-additional-tests.ts',
  "  if (decision === 'different_sha') {",
  "  if (decision === 'original_conflict') {",
]], async () => {
  const shared = code('src/lib/additional-originals.ts').replace(/export \{[^}]*\}/g, '');
  return !/'file_exists'|"file_exists"|'original_conflict'|"original_conflict"/.test(shared);
}, 'E28 共通ライブラリが API のエラー名を持たない が落ちる');

/* ══════════════════════════════════════════════════════════════════════ */
console.log(`\n${fails.length === 0 ? '✅ ALL PASS' : `❌ ${fails.length} FAIL`}`);
for (const f of fails) console.log(`   - ${f}`);
process.exit(fails.length === 0 ? 0 : 1);

