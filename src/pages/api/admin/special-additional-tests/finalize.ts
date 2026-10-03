/**
 * **STEP 2 ［② 登録・Elith 納品］— 1 検査分をまとめて確定する。**
 * 正本: `docs/specs/special_account_additional_tests_spec_20260930.md` §9 / §18 〜 §34。
 *
 *   POST (json) {
 *     diagnosticUserId, testType, testDate, originalKey,
 *     parts: [ scan-part の応答 ... ],
 *     pageCount?, deliver?   // **deliver:true を明示したときだけ** Elith 本番へ出す
 *   }
 *
 * ══════════════════════════════════════════════════════════════════════
 * **順序が仕様**（§28）— この 7 つが揃うまで本番 `user/` へ書かない
 * ══════════════════════════════════════════════════════════════════════
 *   1 解析成功 → 2 有効データあり → 3 **原本 S3 の存在確認** → 4 artifact 保存
 *   → 5 measurement 保存 → 6 原本の紐付け → 7 source JSON 生成 → （ここで初めて）納品
 *
 * 途中で落ちたときの扱いは §32 のとおり:
 *   - 原本が無い / DB が失敗 → **Elith へ出さない**
 *   - **Elith 本番の書き込みだけ失敗** → **Dashboard 側の登録は残す**。
 *     `elith_delivery_items.status='failed'` として**再実行できる**ようにする。
 *
 * ══════════════════════════════════════════════════════════════════════
 * **やらないこと**
 * ══════════════════════════════════════════════════════════════════════
 *   - 受診日の today fallback（§8 / §47）… 必須入力。読めない回は 400 で止める。
 *   - `elith-delivery-promote` を呼ぶ（§24）… uid 配下を全部コピーしてしまう。
 *   - `manifest.json` を書く（§27）
 *   - `elith_deliveries`（バンドル単位）を上書きする（§31）
 *   - 同日の既存 artifact を無条件 delete（§18 / §47）… 2 件以上は `artifact_ambiguous` で停止。
 *
 * 認可 = Bearer `ADMIN_API_KEY`。
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { refreshConfig, cfgBool } from '../../../../lib/app-config';
import {
  sanitizeMeasurementsForDelivery, canonicalizeEnabled, obsDedupEnabled,
} from '../../../../lib/elith-export';
import { canonicalize } from '../../../../lib/canonicalize';
import { dedupObservations } from '../../../../lib/observation-dedup';
import { normalizeCancerRisk } from '../../../../lib/cancer-risk-fix';
import { consolidateAiPredictionItems } from '../../../../lib/ai-prediction-consolidate';
import { getS3Config, isS3Configured, putFiles } from '../../../../lib/s3';
import { getServerSupabase } from '../../../../lib/supabase';
import { makeSubjectResolver } from '../../../../lib/elith-delivery';
import { persistDerivedBloodArtifact, supersedeDerivedBloodOnSameDate, toDerivedBloodGroups } from '../../../../lib/scan-persist';
import { isDerivedHealthcheckBlood, DERIVED_HC_BLOOD_ELITH_BLOCK } from '../../../../lib/blood-subset';
import {
  isAdditionalTestType, isRealDate, buildAdditionalOriginalKey,
  type AdditionalTestType,
} from '../../../../lib/additional-originals';
import {
  checkAdditionalTarget, isItemsFormat, FORMAT_BY_TEST_TYPE,
  saveAdditionalArtifact, readAdditionalOriginal, linkAdditionalOriginal,
  preflightAdditionalOriginal,
  type AdditionalPageLike,
} from '../../../../lib/special-additional-tests';
import {
  buildAdditionalSourceJson, buildAdditionalSourceKey,
  deliverAdditionalJson, recordDeliveryItem, type AdditionalPageRef,
} from '../../../../lib/elith-delivery-json';

export const prerender = false;
/** S3 の原本を読み直してハッシュを取る + 納品と読戻し。既定の 60s では足りないことがある。 */
export const config = { maxDuration: 300 };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** LAiF だけ検査機関名が決まっている（`elith-genetic-merge.ts` と同じ）。 */
function labNameOf(testType: AdditionalTestType): string | null {
  return testType === 'ai_prediction' ? 'LAiF' : null;
}


/**
 * **Elith へ出す前の最後の関門** (発注者指示 2026-10-03 ①)。
 *
 * ══════════════════════════════════════════════════════════════════
 * **`test_type='blood'` のときは fail-closed。**
 * ══════════════════════════════════════════════════════════════════
 * 「取得できて、かつ `imported_by != derived_healthcheck_blood` と**確認できた**とき」だけ
 * 通す。Supabase が無い / query が失敗 / 行が無い / 例外 — **確認できない場合は通さない**。
 *
 * 【なぜ fail-open では駄目か】最上位仕様は「派生 blood は Elith へ**絶対に**送らない」。
 * 「確認できなかったから通した」は、その絶対を条件付きに変えてしまう。
 * DB が一時的に引けないだけなら**管理者がやり直せば通る**ので、止める側の損失は小さい。
 *
 * **blood 以外にはこの fail-closed を適用しない** — 検診・がん・遺伝子・AI疾病予測は
 * そもそも派生 blood になり得ないので、ここで止めると**無関係な登録が DB の瞬断で落ちる**。
 */
type BloodGuard =
  | { ok: true }
  | { ok: false; kind: 'derived'; detail: string }
  | { ok: false; kind: 'unverifiable'; detail: string };

/*
 * **検査のために export してある。** 候補除外 (`resolveAdditionalArtifact`) と
 * 書き込み禁止 (`persistIntoExistingArtifact`) が効いているので、
 * **`derived` の枝は API 経由では構造上到達しない** = 多重防御が働いている証拠だが、
 * それだと「規則の本体」が一度も動かないまま緑になる。だから直接呼べるようにしている。
 * Astro は HTTP メソッド名と `prerender` / `config` 以外の export を route として扱わない。
 */
export async function elithBloodGuard(artifactId: string, testType: AdditionalTestType): Promise<BloodGuard> {
  // blood 以外は従来どおり (fail-closed にしない)。
  if (testType !== 'blood') return { ok: true };
  const unverifiable = (why: string): BloodGuard => ({
    ok: false, kind: 'unverifiable',
    detail: `派生 blood でないことを確認できませんでした (${why})。`
      + ' Elith へは出していません。時間をおいてやり直してください。',
  });
  let data: unknown;
  try {
    const sb = getServerSupabase();
    if (!sb) return unverifiable('Supabase に接続できない');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (sb.schema('diagnosis') as any)
      .from('test_artifacts')
      .select('test_type, imported_by')
      .eq('id', artifactId)
      .maybeSingle();
    if (r?.error) return unverifiable(`照会に失敗: ${String(r.error.message ?? r.error)}`);
    data = r?.data;
  } catch (e) {
    return unverifiable(`例外: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!data) return unverifiable('artifact を取得できない');
  if (isDerivedHealthcheckBlood(data as { test_type?: string; imported_by?: string })) {
    return { ok: false, kind: 'derived', detail: DERIVED_HC_BLOOD_ELITH_BLOCK };
  }
  return { ok: true };
}

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  await refreshConfig();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  // ── 入力の検査 ────────────────────────────────────────────────────
  const target = checkAdditionalTarget(str(body.diagnosticUserId));
  if (!target.ok) return json({ ok: false, error: target.error, detail: target.detail }, 403);
  const uid = target.uid;

  const testType = str(body.testType);
  if (!isAdditionalTestType(testType)) {
    return json({ ok: false, error: 'invalid_test_type' }, 400);
  }
  const formatId = FORMAT_BY_TEST_TYPE[testType];

  // **受診日は必須。実行日で代用しない**（§8 / §47）。
  const testDate = str(body.testDate);
  // **実在する暦日かまで見る**（Hardening 2）。判定は `additional-originals.ts` の 1 か所。
  if (!isRealDate(testDate)) {
    return json({
      ok: false, error: 'invalid_test_date',
      detail: '受診日 (実在する YYYY-MM-DD) が要ります。実行日で代用しません（複数年が同じ日付に畳まれると片方が消えます）。',
    }, 400);
  }

  const originalKey = str(body.originalKey);
  if (!originalKey) return json({ ok: false, error: 'original_key_required' }, 400);

  const parts = Array.isArray(body.parts) ? (body.parts as AdditionalPageLike[]) : [];
  if (parts.length === 0) return json({ ok: false, error: 'parts_required', detail: '① 解析・確認 の結果が要ります' }, 400);

  // ── 1〜2: 解析結果のマージ（**新しい整形を作らない**・§11 / §12 / §14）────
  const items: unknown[] = [];
  const rawMeasurements: unknown[] = [];
  const notes: string[] = [];
  const markdowns: string[] = [];
  const pages: AdditionalPageRef[] = [];

  parts.forEach((p, i) => {
    const page = typeof p.page === 'number' && p.page > 0 ? Math.floor(p.page) : i + 1;
    if (Array.isArray(p.items)) items.push(...p.items);
    if (Array.isArray(p.measurements)) rawMeasurements.push(...p.measurements);
    if (Array.isArray(p.notes)) notes.push(...(p.notes as string[]).filter((n) => typeof n === 'string'));
    const md = typeof p.raw_markdown === 'string' && p.raw_markdown.trim()
      ? p.raw_markdown
      : (typeof p.raw === 'string' ? p.raw : '');
    markdowns.push(`<!-- ===== page ${page}/${parts.length} ===== -->\n${md || '(なし)'}`);
    pages.push({
      page,
      section: typeof p.section === 'string' ? p.section : null,
      count: Array.isArray(p.items) ? p.items.length : Array.isArray(p.measurements) ? p.measurements.length : 0,
    });
  });

  let measurements: Record<string, unknown>[] = [];
  let deliverItems: unknown[] = [];

  if (isItemsFormat(testType)) {
    // 遺伝子 / AI疾病発症予測 = `data.items[]`。**`measurement_values` には保存しない**（§13）。
    deliverItems = items;
    if (testType === 'ai_prediction' && cfgBool('scan.ai_prediction_dedup')) {
      deliverItems = consolidateAiPredictionItems(items).items;
    }
  } else {
    // 血液 / がんリスク。**既存の整形をそのままこの順で通す**（`buildElithScanBundle` と同じ）。
    const kept = sanitizeMeasurementsForDelivery(rawMeasurements).kept;
    const canon = canonicalizeEnabled() ? canonicalize(kept).delivery : kept;
    const dedup = obsDedupEnabled() ? dedupObservations(canon).delivery : canon;
    // ALA-PDS 固有の正規化は**再実装しない**（§12）。
    measurements = (testType === 'cancer_urine' ? normalizeCancerRisk(dedup).delivery : dedup) as Record<string, unknown>[];
  }

  // **2: 有効データあり**（§28）。空のまま先へ進めない（空の artifact を作らない）。
  const hasData = isItemsFormat(testType) ? deliverItems.length > 0 : measurements.length > 0;
  if (!hasData) {
    return json({
      ok: false, error: 'no_data',
      detail: '解析結果が空です。原本 S3 にも DB にも何も書いていません。',
    }, 422);
  }

  // ── 3: 原本が本当に S3 に在るか。**ここで落ちたら DB へ 1 行も書かない** ──
  const original = await readAdditionalOriginal(originalKey);
  if (!original.ok) {
    const status = original.error === 'originals_s3_not_configured' ? 503 : original.error === 'not_found' ? 404 : 400;
    return json({ ok: false, error: original.error, detail: original.detail, key: originalKey }, status);
  }

  /* ── 3.2: **原本キーが この uid / 検査種別 / 受診日 のものか**（binding 確認）───
   *
   * `isAdditionalOriginalKey()` は**形**しか見ないので、
   * **別の人・別の検査・別の受診日の原本キーをこの body に添えて送れた**。
   * 通ると `linkAdditionalOriginal()` が **UID-A の PDF を UID-B の artifact へ**
   * `raw_pdf` として紐付ける（原本は 10 年保管・削除不可）。
   *
   * キーはサーバが
   *   `additional_results/{uid}/{test_type}/{YYYY_MM_DD}/{sha256}.pdf`
   * という形で採番している（`original-ticket` の `createAdditionalOriginalTicket`）ので、
   * **S3 から読み戻した実 SHA で組み直して完全一致を見れば binding が確かめられる**。
   * 自己申告の SHA は使わない（`original.sha256` は S3 の実体から取った値）。
   *
   * **DB mutation より前**に置く（P0-3 と同じ理由 — 409 で止めても DB は戻らない）。
   */
  const expectedKey = buildAdditionalOriginalKey({
    uid, testType, testDate, sha256Hex: original.sha256,
  });
  if (!expectedKey || expectedKey !== originalKey) {
    return json({
      ok: false, error: 'invalid_original_binding',
      detail: '原本キーが この対象者 / 検査種別 / 受診日 のものではありません。DB は 1 行も変えていません。',
      key: originalKey,
    }, 409);
  }

  // ── 3.5: 原本の衝突を **DB を変える前に** 見る（P0-3）──────────────────
  // 以前は 4〜5（`saveAdditionalArtifact`）を通してから 6 で `original_conflict` を
  // 返していたため、**別の PDF を上げると原本は旧いまま scan_md / measurements /
  // measurement_values だけ新しくなる**不整合が起こり得た。ここは read しかしない。
  const pre = await preflightAdditionalOriginal({
    uid, testType, testDate, sha256: original.sha256,
  });
  if (pre.kind === 'error') {
    return json({ ok: false, error: pre.error, detail: pre.detail }, pre.error === 'supabase_not_configured' ? 503 : 500);
  }
  if (pre.kind === 'conflict') {
    return json({
      ok: false, error: 'original_conflict', detail: pre.detail,
      test_artifact_id: pre.artifactId,
      existing: pre.existing.map((e) => ({ id: e.id, sha256: e.sha256, size_bytes: e.size_bytes, created_at: e.created_at })),
      note: 'DB は 1 行も変えていません。原本の差し替えは管理者が明示的に行ってください。',
    }, 409);
  }

  // ── 4〜5: artifact と測定値。**2 件以上あれば止める**（§18）─────────────
  const markdownClean = markdowns.join('\n\n');
  const saved = await saveAdditionalArtifact({
    uid, testType, testDate, markdownClean,
    measurements, // items 形式は [] = `rows:0` が正常（§13）
    pageCount: parts.length,
  });
  if (!saved.ok) {
    if (saved.error === 'artifact_ambiguous') {
      return json({
        ok: false, error: 'artifact_ambiguous',
        detail: `同じ受診日の active な ${testType} が ${saved.candidates.length} 件あります。どれへ入れるかは自動で決めません。`,
        candidates: saved.candidates,
      }, 409);
    }
    const status = saved.error === 'invalid_test_date' ? 400 : saved.error === 'artifact_mismatch' ? 409 : 500;
    return json({ ok: false, error: saved.error, detail: saved.detail }, status);
  }

  /*
   * ── 5b: 人間ドック由来 派生 blood の後処理 ─────────────────────────────
   * 正本 `docs/specs/healthcheckup_blood_extraction_spec_20261001.md` §9 / §11。
   *
   * ① **検診・人間ドックを登録したとき**は、ここで派生 blood を作る
   *    (発注者指示 2026-10-03 §11)。この経路は `saveScanResult()` を通らないので、
   *    利用者のアプリ内スキャンと違って**自動では作られない**。
   *    **呼ぶのは共通関数 1 本だけ**。スペシャル専用の血液抽出ロジックは作らない。
   *    材料は**いま保存した measurements そのまま** = 再解析ゼロ。
   *
   * ② **血液検査を登録したとき**は、同じ受診日の派生 blood を降ろす
   *    (通常 blood 優先・§8)。`resolveAdditionalArtifact()` が派生を候補から
   *    外しているので、ここは**同日に 2 件並べない**ための後始末。
   *
   * **どちらも失敗しても登録は成功のまま返す** (既存の fail-safe の流儀)。
   */
  let derivedBlood: unknown = null;
  let supersededDerivedBlood = 0;
  if (testType === 'health_checkup') {
    const sbForDerived = getServerSupabase();
    if (sbForDerived) {
      derivedBlood = await persistDerivedBloodArtifact(sbForDerived as never, {
        diagnosticUserId: uid,
        testDate,
        parentArtifactId: saved.artifactId,
        // 入力単位 (「N枚目」) ごとに分ける (§13)。1 枚なら 1 グループ = 従来どおり。
        sourceGroups: toDerivedBloodGroups({ scanMd: markdownClean, measurements: measurements as never }),
      });
    }
  } else if (testType === 'blood') {
    const sbForSupersede = getServerSupabase();
    if (sbForSupersede) {
      const r = await supersedeDerivedBloodOnSameDate(sbForSupersede as never, uid, testDate);
      supersededDerivedBlood = r.superseded;
    }
  }

  // ── 6: 原本の紐付け。**違う中身が既に在れば止める**（§21）──────────────
  const linked = await linkAdditionalOriginal({ artifactId: saved.artifactId, original });
  if (!linked.ok) {
    // `error: string` の分岐と区別が付かないので、**`existing` を持つかで narrowing する**。
    if (linked.error === 'original_conflict' && 'existing' in linked) {
      return json({
        ok: false, error: 'original_conflict', detail: linked.detail,
        test_artifact_id: saved.artifactId,
        existing: linked.existing.map((e) => ({ id: e.id, sha256: e.sha256, size_bytes: e.size_bytes, created_at: e.created_at })),
        note: '事前検査の後に別の原本が登録されたため、DB の検査値は保存済みです。原本の差し替えは管理者が明示的に行ってください。',
      }, 409);
    }
    return json({
      ok: false, error: linked.error, detail: linked.detail,
      test_artifact_id: saved.artifactId,
      note: '原本を紐付けられなかったので Elith へは出していません。',
    }, 500);
  }

  const base = {
    test_artifact_id: saved.artifactId,
    artifact_created: saved.created,
    diagnostic_user_id: uid,
    test_type: testType,
    format_id: formatId,
    test_date: testDate,
    page_count: parts.length,
    rows: saved.rows, // items 形式の 0 は正常
    item_count: deliverItems.length,
    /*
     * 人間ドック由来 派生 blood の後処理の結果 (§9 / §11 / §8)。**黙らせない** —
     * 「検診を登録したのに Dashboard の血液が増えない」が静かに起きないように、
     * 作ったか / 作らなかった理由を応答に出す。
     * `derived_blood` は検診を登録したときだけ非 null。
     * `superseded_derived_blood` は血液を登録したときに降ろした派生の件数。
     */
    derived_blood: derivedBlood,
    superseded_derived_blood: supersededDerivedBlood,
    original: {
      key: originalKey,
      already_registered: linked.alreadyRegistered,
      storage_url: linked.storageUrl,
      sha256: linked.sha256,
      size_bytes: linked.sizeBytes,
      content_type: linked.contentType,
    },
  };

  /*
   * ── 6b: **Elith へ出す前の関門**（発注者指示 2026-10-03 ①）─────────────
   *
   * ★ **source JSON を書く前に置く。** ここが要点 —
   * 中間 source prefix に置いた `BloodTestData_*.json` は
   * `inventoryElithSource()` → `assembleElithDeliverySet()` が**キー名で拾う**ので、
   * **source へ書いた時点で「将来の納品対象」になってしまう**。
   * 「`deliverAdditionalJson()` の直前」では遅い (`deliver:false` でも source は書くため)。
   *
   * **blood だけ fail-closed** (上の `elithBloodGuard`)。確認できなければ
   * **S3 に 1 バイトも書かずに** 503 で返す。
   */
  const guard = await elithBloodGuard(saved.artifactId, testType);
  if (!guard.ok) {
    return json(
      guard.kind === 'derived'
        ? { ...base, ok: false, error: 'derived_blood_not_deliverable', detail: guard.detail, delivered: false,
            note: 'S3 には 1 バイトも書いていません。' }
        : { ...base, ok: false, error: 'elith_guard_unverifiable', detail: guard.detail, delivered: false,
            note: 'S3 には 1 バイトも書いていません。DB の登録は済んでいます。' },
      guard.kind === 'derived' ? 409 : 503,
    );
  }

  // ── 7: source JSON（中間・監査層）────────────────────────────────────
  const cfg = getS3Config();
  const sourceKey = buildAdditionalSourceKey({ prefix: cfg?.prefix ?? '', uid, testDate, formatId });
  const sourceJson = buildAdditionalSourceJson({
    formatId, uid, testDate,
    ...(isItemsFormat(testType)
      ? { items: deliverItems, pages }
      : { measurements, notes }),
    pageCount: parts.length,
    labName: labNameOf(testType),
  });

  if (!isS3Configured() || !cfg || !sourceKey) {
    // S3 が無い環境（ローカル）。**DB の登録は済んでいる**ので、そこまでを返す。
    return json({
      ...base, ok: true, configured: false,
      reason: sourceKey ? 's3_not_configured' : 'invalid_source_key',
      delivery: null, preview: sourceJson,
    });
  }

  const sourceText = JSON.stringify(sourceJson, null, 2);
  try {
    await putFiles([{ key: sourceKey, contentType: 'application/json; charset=utf-8', body: sourceText, bytes: utf8Bytes(sourceText) }]);
  } catch (err) {
    return json({
      ...base, ok: false, error: 'source_json_failed',
      detail: String(err instanceof Error ? err.message : err),
      source_key: sourceKey,
      note: 'source JSON を書けなかったので Elith 本番へは出していません（§28）。',
    }, 502);
  }

  /*
   * ══════════════════════════════════════════════════════════════════
   * **既定は納品しない** (D-3・確定 2026-10-01)
   * ══════════════════════════════════════════════════════════════════
   * 正本 `docs/specs/special_account_management_spec_20261001.md` §12.2。
   *
   * 以前はここが `if (body.deliver === false)` = **明示的に false のときだけ止まる**形
   * だったので、**`deliver` を送り忘れた呼び出しがそのまま本番へ出た**。
   * 「送り忘れ = 誤納品」は危険側のフェイルセーフなので、**危険な側を明示的な値に寄せる**。
   *
   * この画面の役割は **登録まで** (§12.1)。Elith 本番納品は
   * `/admin/special-accounts` の［Elith納品］が起動する (§9.1)。
   * Dashboard 反映 ≠ Elith 納品 (§12.3)。
   */
  if (body.deliver !== true) {
    return json({
      ...base, ok: true, configured: true, source_key: sourceKey, delivery: null, delivered: false,
      note: 'Elith 本番へは出していません。納品は「スペシャルアカウント」画面の［Elith納品］から実行してください。',
    });
  }

  const subject = await makeSubjectResolver()(uid).catch(() => null);
  const d = await deliverAdditionalJson({ sourceKey, uid, subject });

  // **納品履歴は成否にかかわらず残す**（§30 / §32。失敗を黙って消さない）。
  let recorded: { ok: boolean; reason?: string } = { ok: false, reason: 'not_attempted' };
  if (d.destinationKey) {
    recorded = await recordDeliveryItem({
      testArtifactId: saved.artifactId,
      diagnosticUserId: uid,
      formatId, testDate,
      sourceKey,
      destinationKey: d.destinationKey,
      sourceSha256: d.sourceSha256,
      destinationSha256: d.destinationSha256,
      status: d.verified ? 'delivered' : 'failed',
      lastError: d.verified ? null : `${d.error ?? 'unknown'}${d.detail ? `: ${d.detail}` : ''}`,
    });
  }

  const delivery = {
    destination_key: d.destinationKey,
    source_sha256: d.sourceSha256,
    destination_sha256: d.destinationSha256,
    verified: d.verified, // **読み戻して一致したか**。PutObject の成否ではない（§29）
    error: d.error ?? null,
    detail: d.detail ?? null,
    history_recorded: recorded.ok,
    history_reason: recorded.ok ? null : (recorded.reason ?? null),
  };

  if (!d.verified) {
    // **Dashboard 側の登録は残す。** 再実行できる（§32）。
    return json({
      ...base, ok: false, configured: true, error: 'delivery_failed',
      source_key: sourceKey, delivery, delivered: false,
      note: '検査値と原本の登録は完了しています。Elith 納品だけ失敗したので、同じ操作で再実行できます。',
    }, 502);
  }

  return json({ ...base, ok: true, configured: true, source_key: sourceKey, delivery, delivered: true });
};
