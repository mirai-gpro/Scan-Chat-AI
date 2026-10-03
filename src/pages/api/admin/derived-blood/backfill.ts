/**
 * **保存済みの人間ドック・健康診断から 派生 blood を作る (backfill)。**
 *
 *   POST /api/admin/derived-blood/backfill      (Bearer ADMIN_API_KEY)
 *     body: { diagnosticUserId, mode: 'one' | 'pending', testDate?, confirm?: boolean }
 *
 * ── 対象の選び方は **mode で明示する**（発注者指示 2026-10-03 §12 / §13）─────
 *   `mode:'one'`     … `testDate` で指定した 1 回だけ。**testDate は必須**
 *   `mode:'pending'` … その uid の**未処理**の検診・人間ドックすべて
 *                      (= 同じ受診日に派生 blood が未だ無い回だけ)
 *
 * **「受診日を空欄にすると全件」という暗黙の操作は廃止した。** 空欄は 400 で弾く。
 * 誤操作で意図しない複数の回を書き換えないため。
 * **全ユーザー一括は実装しない**（§12 C は将来の余地として残すだけ）。
 *
 * 正本: `docs/specs/healthcheckup_blood_extraction_spec_20261001.md` §10.6 (裁定 Q-11)
 *
 * ══════════════════════════════════════════════════════════════════
 * **派生のロジックはここに無い。** `persistDerivedBloodArtifact()` を呼ぶだけ。
 * ══════════════════════════════════════════════════════════════════
 * 新規スキャン (`saveScanResult` の後段) と**完全に同じ関数**を通す (発注者指示 §11)。
 * 抽出ロジックを backfill 用にもう 1 本作らない。
 *
 * **再解析しない。** 材料は `test_artifacts.measurements` (jsonb) =
 * スキャン時に `sanitizeMeasurementsForDelivery()` を通した結果そのもの。
 * Gemini も PDF も S3 も触らない (v1.1 §3)。
 *
 * ── 2 回叩く ─────────────────────────────────────────────────────
 *   `confirm` 無し … **preview。DB に 1 行も書かない** (読み取りだけ)。
 *                    作る予定の項目と、作らないならその理由を返す。
 *   `confirm:true` … 同じ材料で `persistDerivedBloodArtifact()` を実行し、
 *                    **そのあと読み戻して**「Dashboard が何を見るか」を返す。
 *
 * ── 冪等 ─────────────────────────────────────────────────────────
 *   `replaceSameDateArtifacts` に `imported_by` を足した 5 条件で差し替えるので、
 *   **何度叩いても artifact は増えない**。`measurement_values` も総入れ替え。
 *
 * ── 触らないもの ─────────────────────────────────────────────────
 *   元の health_checkup artifact の `id` / `status` / `measurements` /
 *   `scan_md` / `measurement_values`。**通常 blood の行。** Elith への納品
 *   (この API は S3 に 1 バイトも書かない)。
 */

import type { APIRoute } from 'astro';
import { checkAdminAuth } from '../../../../lib/api-auth';
import { getServerSupabase } from '../../../../lib/supabase';
import { refreshConfig } from '../../../../lib/app-config';
import {
  persistDerivedBloodArtifact,
  toDerivedBloodGroups,
  type DerivedBloodOutcome,
  type DerivedBloodSourceGroup,
} from '../../../../lib/scan-persist';
import { buildBloodEpisodes, type BloodEpisode } from '../../../../lib/blood-subset';
import {
  extractBloodSubset,
  derivedBloodEpisodeIndex,
  derivedBloodParentId,
  DERIVED_HC_BLOOD_IMPORTED_BY,
  BLOOD_SUBSET_ITEMS,
} from '../../../../lib/blood-subset';
import type { LeanMeasurement } from '../../../../lib/measurement-persist';
import { getMeasurementTrend, getTrendCandidates } from '../../../../lib/measurement-queries';
import { checkFormatsReady } from '../../../../lib/elith-entitlement';
import { loadDashboard } from '../../../../lib/dashboard-queries';

/**
 * 監査の棚卸しで見る status。**無絞りにせず明示列挙する**。
 * `test_artifacts.status` の CHECK は `('active','superseded','withdrawn')`
 * (`supabase/migrations/20260601000010_schemas_and_tables.sql:206`)。
 *
 * ここは**利用者に見せる一覧ではなく監査**なので active 以外も要る
 * (「派生が superseded に落ちた」「元の health_checkup が無傷」を目で確かめるため)。
 * ただし `verify:measurement-status` が守っている規律 — 人単位の一覧を
 * status で絞らずに引かない — は崩さない。列挙は CHECK と一致させる。
 */
const AUDIT_STATUSES = ['active', 'superseded', 'withdrawn'] as const;

export const prerender = false;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface HcRow {
  id: string;
  test_date: string | null;
  status: string | null;
  measurements: unknown;
  /** **入力グループ (「N枚目」) の境界はここに在る** (§13)。無い回は 1 グループ扱い。 */
  scan_md: string | null;
}

/** `test_artifacts.measurements` (jsonb・形は DB が保証しない) を lean の配列として検証する。 */
function toLean(raw: unknown): LeanMeasurement[] {
  if (!Array.isArray(raw)) return [];
  const out: LeanMeasurement[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const m = r as Record<string, unknown>;
    if (typeof m.name !== 'string' || m.name.trim() === '') continue;
    out.push({
      name: m.name,
      value: typeof m.value === 'string' ? m.value : m.value == null ? null : String(m.value),
      value_num: typeof m.value_num === 'number' && Number.isFinite(m.value_num) ? m.value_num : null,
      unit: typeof m.unit === 'string' ? m.unit : null,
      ref_low: typeof m.ref_low === 'string' ? m.ref_low : m.ref_low == null ? null : String(m.ref_low),
      ref_high: typeof m.ref_high === 'string' ? m.ref_high : m.ref_high == null ? null : String(m.ref_high),
      flag: typeof m.flag === 'string' ? m.flag : null,
    });
  }
  return out;
}

export const POST: APIRoute = async ({ request }) => {
  /*
   * **「鍵が違う」と「鍵が設定されていない」を混ぜない。** `isAdminAuthorized()` は
   * どちらも false にするので、本番で env の入れ忘れがあったときに
   * 画面には「管理者として認証できませんでした」と出て**原因を追えない**。
   * `checkAdminAuth()` は理由を返すので、そのまま出す (api-auth.ts の設計どおり)。
   */
  const auth = checkAdminAuth(request);
  if (!auth.ok) {
    return json(
      auth.reason === 'server_misconfig'
        ? { ok: false, error: 'server_misconfig', detail: 'Scan-Chat-AI の ADMIN_API_KEY が未設定です (Vercel の環境変数を確認してください)' }
        : { ok: false, error: 'unauthorized' },
      auth.reason === 'server_misconfig' ? 503 : 401,
    );
  }

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* 空でよい */ }

  const uid = String(body.diagnosticUserId ?? '').trim().toLowerCase();
  if (!UUID_RE.test(uid)) return json({ ok: false, error: 'invalid_diagnostic_user_id' }, 400);

  /*
   * **mode は必須。** 既定値を置かない — 「指定し忘れたら全件」が最も危ない。
   * 未知の値も弾く (allow-list)。
   */
  const mode = String(body.mode ?? '');
  if (mode !== 'one' && mode !== 'pending') {
    return json({
      ok: false, error: 'invalid_mode',
      detail: "mode は 'one' (受診日を 1 つ指定) か 'pending' (このUIDの未処理すべて) を明示してください",
    }, 400);
  }

  const testDateRaw = body.testDate == null ? '' : String(body.testDate).trim();
  if (mode === 'one') {
    if (testDateRaw === '') {
      return json({ ok: false, error: 'test_date_required', detail: "mode='one' では受診日 (YYYY-MM-DD) が必須です" }, 400);
    }
    if (!DATE_RE.test(testDateRaw)) {
      return json({ ok: false, error: 'invalid_test_date', detail: 'YYYY-MM-DD で指定してください' }, 400);
    }
  } else if (testDateRaw !== '') {
    // **黙って無視しない。** 「全部処理」を選んだのに日付が入っていたら、どちらの
    // つもりだったのか分からない。止めて選び直させる。
    return json({
      ok: false, error: 'test_date_not_allowed',
      detail: "mode='pending' では受診日を指定できません (このUIDの未処理すべてを対象にします)",
    }, 400);
  }
  const testDate = mode === 'one' ? testDateRaw : null;
  const confirm = body.confirm === true;

  const sb = getServerSupabase();
  if (!sb) return json({ ok: false, error: 'server_misconfig', detail: 'SUPABASE_SERVICE_ROLE_KEY が無い' }, 503);
  await refreshConfig();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dsb = (sb as any).schema('diagnosis');

  // ── ① 材料 = 保存済みの health_checkup (active)。**再解析しない** ──────────
  let q = dsb
    .from('test_artifacts')
    // `scan_md` も引く — 入力グループの境界 (「N枚目」) がここに在る (§13)。
    .select('id, test_date, status, measurements, scan_md')
    .eq('diagnostic_user_id', uid)
    .eq('test_type', 'health_checkup')
    .eq('status', 'active')
    .order('test_date', { ascending: true });
  if (testDate) q = q.eq('test_date', testDate);
  const { data: hcRaw, error: hcErr } = await q;
  if (hcErr) return json({ ok: false, error: 'db_error', detail: String(hcErr.message ?? hcErr) }, 500);
  let hc = (hcRaw ?? []) as HcRow[];

  /*
   * ── 処理済み判定は **グループ単位** (発注者指示 2026-10-03 §12) ──────────────
   *
   * **「その日付に派生が 1 件あれば処理済み」では誤判定する** — 1 件の health_checkup に
   * 入力グループ (「N枚目」) が 2 つあるのに派生が 1 件しか無い回は**まだ未完了**。
   * → `external_test_id` (`derived_hc:<親>:g<N>`) で**親 artifact ごとに
   *   「どのグループが済んでいるか」**を持つ。
   *
   * **fail-closed** (②)。引けなかったら 500 で終わり、
   * `persistDerivedBloodArtifact()` を **1 回も呼ばない**。
   * 「DB エラーを未処理 0 件として扱う」と、**既に在る派生を作り直してしまう**。
   */
  const { data: derivedRaw, error: derivedErr } = await dsb
    .from('test_artifacts')
    .select('test_date, external_test_id')
    .eq('diagnostic_user_id', uid)
    .eq('test_type', 'blood')
    .eq('status', 'active')
    .eq('imported_by', DERIVED_HC_BLOOD_IMPORTED_BY);
  if (derivedErr) {
    return json({
      ok: false, error: 'db_error',
      detail: `既存の派生 blood を照会できませんでした: ${String(derivedErr.message ?? derivedErr)}`,
      note: '処理済みの回を判定できないため、何も書いていません (作り直しを避けるため)。',
      diagnostic_user_id: uid, test_date: testDate,
    }, 500);
  }
  const derivedRows = (derivedRaw ?? []) as { test_date: string | null; external_test_id: string | null }[];
  /** 親 artifact id → 済んでいるグループ番号。 */
  const doneByParent = new Map<string, Set<number>>();
  /** 受診日 → その日に active な派生が 1 件以上在る (表示用。`already_done_dates`)。 */
  const doneDates = new Set<string>();
  /**
   * **受診日 → その日に「旧ロジック由来の派生」が在る** (発注者レビュー 2026-10-03 ①)。
   *
   * ここに入れるのは **`external_test_id` が NULL か、`derived_hc:<親>:g<N>` として
   * 解析できない** active な派生が在る日付**だけ**。
   *
   * 【なぜ分けたか】以前は `doneDates`(= その日に派生が 1 件でも在る) を legacy の根拠に
   * していたので、**同じ受診日に別の親の新方式 sibling が在るだけで**、まだ派生が無い
   * health_checkup まで「旧ロジックの行が在る日」と誤認して `already_processed` にしていた。
   * 新方式の sibling はグループ番号が分かるので、legacy の根拠にしてはいけない。
   */
  const legacyDates = new Set<string>();
  for (const r of derivedRows) {
    const d = String(r.test_date ?? '').slice(0, 10);
    if (d) doneDates.add(d);
    const parent = derivedBloodParentId(r.external_test_id);
    const gi = derivedBloodEpisodeIndex(r.external_test_id);
    if (parent && gi != null) {
      const set = doneByParent.get(parent) ?? new Set<number>();
      set.add(gi);
      doneByParent.set(parent, set);
    } else if (d) {
      // 解析できない = グループ番号が分からない行。この日付だけを legacy とする。
      legacyDates.add(d);
    }
  }
  const alreadyDone = [...doneDates].sort();

  /*
   * 各 health_checkup について「どの **blood episode** が未処理か」を出す。
   *
   * ⚠️ **`N枚目` の数ではなく episode の数で見る** (発注者の訂正 2026-10-03)。
   * 同じ人間ドックの続きページは 1 件に統合されるので、`buildBloodEpisodes()` を
   * 通した結果が「作るべき件数」になる。
   *
   * ⚠️ **`external_test_id` を持たない / 解析できない派生 (= 旧ロジックで作られた行)** は
   * episode 番号が分からないので、**その受診日は「処理済み」として扱い自動では触らない**
   * (本番の `2026-09-17` 2 項目 / `2026-09-24` 11 項目がこれ)。
   * **置き換えは発注者の指示を受けてから**なので、ここで勝手に作り直さない (§11)。
   *
   * 根拠は **`legacyDates`** (旧ロジック由来が在る日付) **だけ**。`doneDates` を使うと
   * 同日・別の親の新方式 sibling まで legacy の根拠にしてしまう (レビュー ①)。
   */
  const planOf = (row: HcRow): {
    groups: DerivedBloodSourceGroup[]; episodes: BloodEpisode[]; missing: number[]; legacy: boolean;
  } => {
    const groups = toDerivedBloodGroups({ scanMd: row.scan_md, measurements: toLean(row.measurements) });
    const episodes = buildBloodEpisodes(groups);
    const date = String(row.test_date ?? '').slice(0, 10);
    const doneEpisodes = doneByParent.get(row.id) ?? new Set<number>();
    // この受診日に**旧ロジック由来**が在り、かつこの親の sibling が 1 つも無い。
    const legacy = legacyDates.has(date) && doneEpisodes.size === 0;
    const missing = episodes.filter((e) => !doneEpisodes.has(e.index)).map((e) => e.index);
    return { groups, episodes, missing, legacy };
  };

  /*
   * ── ③ **`mode:'one'` でも処理済みなら作り直さない** ──────────────────────
   * **全 episode が済んでいる / 旧ロジック由来の行が在る** なら何も書かない。
   * 一部の episode だけ欠けているときは**欠けている分だけ**作る (§12)。
   */
  if (mode === 'one' && testDate) {
    const row = hc[0];
    if (row) {
      const { episodes, missing, legacy } = planOf(row);
      if (legacy || (episodes.length > 0 && missing.length === 0)) {
        return json({
          ok: true, mode: 'preview', selection: 'one', already_processed: true,
          note: legacy
            ? `${testDate} には既に派生 blood が在ります (episode 識別子を持たない旧ロジック由来)。置き換えは指示を受けてから行うので、ここでは何も書いていません。`
            : `${testDate} の blood episode ${episodes.length} 件はすべて派生 blood が作られています。作り直しはしないので何も書いていません。`,
          diagnostic_user_id: uid, test_date: testDate,
          episode_count: episodes.length, missing_episodes: missing, legacy_derived: legacy,
          already_done_dates: alreadyDone,
          targets: [], verification: await readBack(dsb, uid),
        });
      }
    }
  }

  if (mode === 'pending') {
    // **未処理の episode が 1 つ以上ある回だけ**を対象にする (旧ロジック由来は触らない)。
    hc = hc.filter((r) => {
      const { episodes, missing, legacy } = planOf(r);
      return !legacy && episodes.length > 0 && missing.length > 0;
    });
    if (hc.length === 0) {
      return json({
        ok: true, mode: confirm ? 'applied' : 'preview', selection: 'pending',
        note: '未処理の blood episode はありません (すべて派生 blood が作られているか、旧ロジック由来のため触りません)。何も書いていません。',
        diagnostic_user_id: uid, test_date: null,
        already_done_dates: alreadyDone,
        targets: [], verification: await readBack(dsb, uid),
      });
    }
  }

  if (hc.length === 0) {
    return json({
      ok: false, error: 'health_checkup_not_found',
      detail: testDate
        ? `active な health_checkup (${testDate}) が見つかりません`
        : 'active な health_checkup が 1 件も見つかりません',
      diagnostic_user_id: uid, test_date: testDate,
    }, 404);
  }

  // ── ② preview / apply ────────────────────────────────────────────────
  const targets: {
    health_checkup_artifact_id: string;
    test_date: string | null;
    source_measurements: number;
    /** 原本から見つけた入力グループ (「N枚目」) の数。**件数ではない**。 */
    group_count?: number;
    /** **blood episode の数** = 作る派生 blood の件数。 */
    episode_count?: number;
    /** まだ派生が無い episode 番号。 */
    missing_episodes?: number[];
    /** `external_test_id` を持たない旧ロジック由来の派生が同日に在る。 */
    legacy_derived?: boolean;
    would_create?: {
      items: string[]; count: number;
      episodes?: {
        episode: number; groups: number[]; label: string | null;
        items: string[]; count: number; excluded?: unknown; skipped?: number;
      }[];
    };
    outcome?: DerivedBloodOutcome;
    excluded?: unknown;
    skipped?: number;
  }[] = [];

  for (const row of hc) {
    const lean = toLean(row.measurements);
    const date = row.test_date;
    if (!date || !DATE_RE.test(date)) {
      targets.push({
        health_checkup_artifact_id: row.id, test_date: date, source_measurements: lean.length,
        outcome: { created: false, reason: 'error', detail: '受診日が無い回は対象にしない (日付を推測しない)' },
      });
      continue;
    }
    const { groups, episodes, missing, legacy } = planOf(row);
    const todo = episodes.filter((e) => missing.includes(e.index));
    if (!confirm) {
      // **preview は読み取りだけ。** `buildBloodEpisodes` / `extractBloodSubset` は純関数。
      targets.push({
        health_checkup_artifact_id: row.id, test_date: date, source_measurements: lean.length,
        group_count: groups.length, episode_count: episodes.length,
        missing_episodes: missing, legacy_derived: legacy,
        would_create: {
          // **episode ごとの内訳**を出す (1 件なら従来と同じ見え方)。
          episodes: todo.map((e) => {
            const { kept, excluded, skipped } = extractBloodSubset(e.measurements);
            return {
              episode: e.index, groups: e.groupIndexes, label: e.label ?? null,
              items: kept.map((m) => String(m.name)), count: kept.length, excluded, skipped,
            };
          }),
          items: todo.flatMap((e) => extractBloodSubset(e.measurements).kept.map((m) => String(m.name))),
          count: todo.reduce((a, e) => a + extractBloodSubset(e.measurements).kept.length, 0),
        },
      });
      continue;
    }
    const outcome = await persistDerivedBloodArtifact(sb as never, {
      diagnosticUserId: uid, testDate: date,
      parentArtifactId: row.id,
      sourceGroups: groups,
      // **欠けている episode だけ**作る (冪等・§12)。
      onlyEpisodes: missing,
    });
    targets.push({
      health_checkup_artifact_id: row.id, test_date: date, source_measurements: lean.length,
      group_count: groups.length, episode_count: episodes.length,
      missing_episodes: missing, legacy_derived: legacy, outcome,
    });
  }

  // ── ③ 読み戻し。**Dashboard が実際に見るものを、同じ関数で引いて返す** ─────
  const verification = await readBack(dsb, uid);

  return json({
    ok: true,
    mode: confirm ? 'applied' : 'preview',
    selection: mode,
    already_done_dates: alreadyDone,
    note: confirm
      ? '派生 blood を作成しました。元の health_checkup には触っていません。Elith への納品 (S3) はこの API では行いません。'
      : 'preview です。DB にも S3 にも 1 行も書いていません。実行するには confirm:true を付けてください。',
    diagnostic_user_id: uid,
    test_date: testDate,
    subset_items_master: BLOOD_SUBSET_ITEMS,
    targets,
    verification,
  });
};

/**
 * **「DB に入った」で終わらせないための読み戻し。**
 *
 * ここで引くのは全部 **Dashboard / 推移グラフ / Elith readiness が本番で使う同じ関数**。
 * 独自のクエリで「入っているはず」を作らない。
 */
async function readBack(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dsb: any,
  uid: string,
): Promise<unknown> {
  const out: Record<string, unknown> = {};

  // (a) blood artifact の棚卸し (active / superseded とも)
  try {
    const { data } = await dsb
      .from('test_artifacts')
      .select('id, test_date, status, source, imported_by, lab_name, scan_md')
      .eq('diagnostic_user_id', uid)
      .eq('test_type', 'blood')
      .in('status', AUDIT_STATUSES)
      .order('test_date', { ascending: true });
    const rows = (data ?? []) as { id: string; test_date: string | null; status: string | null; source: string | null; imported_by: string | null; scan_md: string | null }[];
    out.blood_artifacts = rows.map((r) => ({
      id: r.id, test_date: r.test_date, status: r.status, source: r.source,
      imported_by: r.imported_by,
      derived: r.imported_by === DERIVED_HC_BLOOD_IMPORTED_BY,
      has_scan_md: r.scan_md != null,
    }));
    const active = rows.filter((r) => r.status === 'active');
    out.blood_artifacts_active = active.length;
    // TestResultsSection.astro の canGraph と同じ式 (推移は 2 回目から)。
    out.dashboard_blood_can_graph = active.length >= 2;
  } catch (e) { out.blood_artifacts_error = e instanceof Error ? e.message : String(e); }

  // (b) 派生 artifact の measurement_values (= 「データ」画面とグラフの材料)
  try {
    const { data: arts } = await dsb
      .from('test_artifacts')
      .select('id, test_date')
      .eq('diagnostic_user_id', uid)
      .eq('test_type', 'blood')
      .eq('status', 'active')
      .eq('imported_by', DERIVED_HC_BLOOD_IMPORTED_BY);
    const derivedArts = ((arts ?? []) as { id: string; test_date: string | null }[]);
    const detail: unknown[] = [];
    if (derivedArts.length > 0) {
      // **active な派生 artifact の id で絞る** (`.in('artifact_id', …)`)。
      const { data: mv } = await dsb
        .from('measurement_values')
        .select('artifact_id, seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, flag, test_type, test_date, source_file_kind')
        .in('artifact_id', derivedArts.map((a) => a.id))
        .order('seq', { ascending: true });
      const all = (mv ?? []) as { artifact_id: string; item_name: string; value_num: number | null; value: string | null; unit: string | null; flag: string | null; canonical_name: string | null; test_type: string; source_file_kind: string | null }[];
      for (const a of derivedArts) {
        const rows = all.filter((r) => r.artifact_id === a.id);
        detail.push({
          artifact_id: a.id, test_date: a.test_date, rows: rows.length,
          // 0 補完が混ざっていないことを**数で**示す (期待は 0)。
          zero_value_rows: rows.filter((r) => r.value_num === 0).length,
          canonical_null_rows: rows.filter((r) => !r.canonical_name).length,
          wrong_test_type_rows: rows.filter((r) => r.test_type !== 'blood').length,
          values: rows.map((r) => ({ name: r.item_name, value: r.value, value_num: r.value_num, unit: r.unit, flag: r.flag })),
        });
      }
    }
    out.derived_measurement_values = detail;
  } catch (e) { out.derived_measurement_values_error = e instanceof Error ? e.message : String(e); }

  // (c) 元の health_checkup が無傷か (id / status / measurements の件数)
  try {
    const { data } = await dsb
      .from('test_artifacts')
      .select('id, test_date, status, measurements')
      .eq('diagnostic_user_id', uid)
      .eq('test_type', 'health_checkup')
      .in('status', AUDIT_STATUSES)
      .order('test_date', { ascending: true });
    out.health_checkups = ((data ?? []) as HcRow[]).map((r) => ({
      id: r.id, test_date: r.test_date, status: r.status,
      measurements: Array.isArray(r.measurements) ? r.measurements.length : null,
    }));
  } catch (e) { out.health_checkups_error = e instanceof Error ? e.message : String(e); }

  // (d) **Dashboard が実際に取得する artifacts** (loadDashboard を本番と同じに通す)
  try {
    const d = await loadDashboard(uid);
    if ('error' in d) out.dashboard = { error: d.error };
    else {
      const blood = d.artifacts.filter((a) => a.test_type === 'blood');
      out.dashboard = {
        using_demo_data: d.usingDemoData,
        result_uid: d.resultUid,
        blood_cards: blood.map((a) => ({
          id: a.id, test_date: a.test_date, status: a.status,
          imported_by: (a as { imported_by?: string }).imported_by ?? null,
        })),
        blood_newest_test_date: blood[0]?.test_date ?? null,
      };
    }
  } catch (e) { out.dashboard_error = e instanceof Error ? e.message : String(e); }

  // (e) **推移グラフ** — /trend?type=blood が呼ぶ 2 関数そのまま
  try {
    const candidates = await getTrendCandidates(uid, 'blood');
    const series = await getMeasurementTrend(uid, candidates, 12, 'blood');
    out.trend = {
      candidates,
      series: series.map((s) => ({
        label: s.label, unit: s.unit,
        referenceUpper: s.referenceUpper ?? null,
        referenceLower: s.referenceLower ?? null,
        points: s.points.map((p) => ({ date: p.date, value: p.value, flag: p.flag ?? null, source: p.source ?? null })),
        derived_points: s.points.filter((p) => p.source === 'health_checkup_scan').length,
      })),
    };
  } catch (e) { out.trend_error = e instanceof Error ? e.message : String(e); }

  // (f) **Elith readiness** — 派生が BloodTestData を「揃った」にしていないこと
  try {
    const r = await checkFormatsReady([uid], new Map([[uid, ['BloodTestData'] as never]]));
    const me = r[uid];
    out.elith_readiness_blood = {
      ready: me?.ready ?? null,
      missing: me?.missing ?? null,
      checked: me?.checked ?? null,
      expected: 'ready:false / missing に BloodTestData が入る (派生は数えない)',
    };
  } catch (e) { out.elith_readiness_error = e instanceof Error ? e.message : String(e); }

  return out;
}
