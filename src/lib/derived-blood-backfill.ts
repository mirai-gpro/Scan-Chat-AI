/**
 * **保存済みの人間ドック／健康診断 1 件を、派生 blood へ backfill する処理本体。**
 *
 * 正本: `docs/specs/healthcheckup_blood_extraction_spec_20261001.md` §10.6（発注者裁定 Q-11）。
 *
 * 【ここに新しいロジックは無い】呼ぶのは**既存の実装済み関数だけ**:
 *   - 抽出 … `extractBloodSubset()`（`blood-subset.ts`）
 *   - 同一日の通常 blood 判定 … `hasNormalBloodOnDate()`（同）
 *   - 生成 … `persistDerivedBloodArtifact()`（`scan-persist.ts`）
 *     = `/api/scan/save` → `saveScanResult()` が通るのと**同一の関数**
 *   - 揃い判定 … `checkFormatsReady()`（`elith-entitlement.ts`）
 *   - 推移 … `getMeasurementTrend()`（`measurement-queries.ts`）
 *
 * 【なぜ lib に置くか】**admin API（server-to-server）と admin 画面（人の操作）の
 * 2 つから同じ処理を呼ぶため。** どちらかに実装を置いて他方から HTTP で叩くと
 * 二重管理になるか Cookie の持ち回しが要る。`sanitizeMeasurementsForDelivery` と
 * 同じ流儀で「処理は 1 か所」に寄せる。
 *
 * 【安全装置】
 *   - **`apply` の既定は false。** dry-run は DB を 1 行も変更しない。
 *   - **対象は `ALLOWED` で固定。** 他の uid / 受診日は呼び出し側で弾く
 *     （`isAllowedTarget()`）。引数の申告だけで別の人を触れない。
 *   - **active な派生が既に在れば作らない。** `allowReplace` を明示したときだけ作り直す。
 *   - **通常 blood が在る受診日では作らない**（裁定 Q-10）。
 *   - **元 health_checkup は触らない。** `measurements` の sha256 を前後比較して返す。
 *   - **Service Role Key は返さない。** 接続先は host / project ref だけ。
 */
import { createHash } from 'node:crypto';
import { getServerSupabase } from './supabase';
import {
  extractBloodSubset,
  hasNormalBloodOnDate,
  DERIVED_HC_BLOOD_IMPORTED_BY,
  DERIVED_HC_BLOOD_SOURCE,
  BLOOD_SUBSET_ITEMS,
  type LeanRow,
  type BloodSubsetExclusion,
} from './blood-subset';
import { persistDerivedBloodArtifact } from './scan-persist';
import { checkFormatsReady, type ElithFormat } from './elith-entitlement';
import { getMeasurementTrend } from './measurement-queries';
import { demoFallbackEnabled } from './demo-data';

/**
 * **許可リスト（発注者指示 2026-10-02）。**
 * ここに無い組み合わせは呼び出し側が 403 で弾く。今回のテストが他へ波及しないようにする。
 * 口を広げるときは**このリストを明示的に増やす**（引数から受け取れるようにしない）。
 */
export const ALLOWED: ReadonlyArray<{ uid: string; testDate: string }> = [
  { uid: '7d49b0b2-1f33-4d4b-ae74-fc033cc81dd8', testDate: '2026-09-24' },
];

/** 今回の画面が扱う 1 件（画面に入力欄を作らないための固定値）。 */
export const FIXED_TARGET = ALLOWED[0]!;

export function isAllowedTarget(uid: string, testDate: string): boolean {
  return ALLOWED.some((a) => a.uid === uid && a.testDate === testDate);
}

/** 期待値（判定にだけ使う。**データを作るために使わない**）。 */
export const EXPECTED_ITEMS: ReadonlyArray<readonly [string, number]> = [
  ['GOT(AST)', 19], ['GPT(ALT)', 20], ['γ-GTP', 26],
  ['LDLコレステロール', 116], ['HDLコレステロール', 83.2], ['総コレステロール', 196],
  ['中性脂肪', 54], ['空腹時血糖', 104], ['クレアチニン', 1.03], ['eGFR', 56.9], ['尿酸', 7.8],
];
/** 今回の検体に無い想定の 4 項目。**行を作らない**ことを見る。 */
export const EXPECTED_ABSENT = ['総蛋白', 'アルブミン', 'HbA1c(NGSP)', '尿素窒素'] as const;
/** 元 measurements の想定件数（発注者提示）。 */
export const EXPECTED_SOURCE_COUNT = 40;

export interface DryRunInfo {
  health_checkup_artifact_id: string;
  health_checkup_count: number;
  health_checkup_status: string | null;
  source_measurements: number;
  source_measurements_sha256: string;
  kept: number;
  excluded: BloodSubsetExclusion[];
  items: { name: string | null | undefined; value: string | null | undefined; value_num: number | null | undefined; unit: string | null }[];
  normal_blood_exists: boolean;
  derived_active: number;
  derived_superseded: number;
  absent_items: string[];
}

export interface AppliedInfo {
  derived_artifact_id: string;
  artifact: Record<string, unknown> | null;
  measurement_values_count: number;
  measurement_values: { name: string; value: string | null; value_num: number | null }[];
  measurement_values_zero_rows: number;
  absent_items_present_in_mv: string[];
  health_checkup_unchanged: boolean;
  health_checkup_sha256_before: string;
  health_checkup_sha256_after: string;
  readiness_blood_ready: boolean | null;
  readiness_missing: string[];
  trend: { hit: number; derived: number; series: number; detail: { name: string; value: number; source: string | null }[] };
  demo_fallback: boolean;
}

export type BackfillOutcome =
  | { ok: true; mode: 'dry_run'; status: 200; supabase: SupabaseIdentity; dryRun: DryRunInfo }
  | { ok: true; mode: 'applied'; status: 200; supabase: SupabaseIdentity; dryRun: DryRunInfo; applied: AppliedInfo }
  | { ok: false; status: number; error: string; detail?: string; supabase: SupabaseIdentity; dryRun?: DryRunInfo; result?: unknown };

export interface SupabaseIdentity { host: string; project_ref: string }

/** 接続先の素性。**key は返さない。** */
export function supabaseIdentity(): SupabaseIdentity {
  const raw = import.meta.env.PUBLIC_SUPABASE_URL as string | undefined;
  if (!raw) return { host: '(未設定)', project_ref: '(不明)' };
  try {
    const host = new URL(raw).host;
    return { host, project_ref: host.split('.')[0] ?? '(不明)' };
  } catch {
    return { host: '(解析不能)', project_ref: '(不明)' };
  }
}

type HcRow = { id: string; test_date: string | null; source: string | null; imported_by: string | null; status: string | null; measurements: unknown };
type ArtRow = { id: string; status: string | null };

const hashOf = (v: unknown): string => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex');

/**
 * 受診日の派生 blood を status 別に引く。
 *
 * **status ごとに分けて引く** — `verify:measurement-status` ③ が「人単位の
 * `test_artifacts` select は `.eq('status', …)` を持つこと」を要求する（同じ受診日が
 * 2 つ並ぶ実障害の再発防止）。監査のため superseded も見たいので、
 * 絞りを外すのではなく 2 本に分ける。
 */
async function derivedRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any, uid: string, testDate: string,
): Promise<{ active: ArtRow[]; superseded: ArtRow[] }> {
  const out: { active: ArtRow[]; superseded: ArtRow[] } = { active: [], superseded: [] };
  for (const st of ['active', 'superseded'] as const) {
    const { data } = await sb.schema('diagnosis')
      .from('test_artifacts')
      .select('id, status')
      .eq('diagnostic_user_id', uid)
      .eq('test_type', 'blood')
      .eq('test_date', testDate)
      .eq('imported_by', DERIVED_HC_BLOOD_IMPORTED_BY)
      .eq('status', st);
    out[st] = (data ?? []) as ArtRow[];
  }
  return out;
}

/** dry-run の結果が期待どおりか（判定のみ・データは作らない）。 */
export function evaluateDryRun(d: DryRunInfo): { pass: boolean; checks: { label: string; ok: boolean; detail: string }[] } {
  const names = d.items.map((i) => String(i.name ?? ''));
  const itemsMatch = d.items.length === EXPECTED_ITEMS.length
    && EXPECTED_ITEMS.every(([n, v], i) => d.items[i]?.name === n && Number(d.items[i]?.value_num) === v);
  const checks = [
    { label: 'active な health_checkup がちょうど 1 件', ok: d.health_checkup_count === 1, detail: `${d.health_checkup_count} 件` },
    { label: `元 measurements が ${EXPECTED_SOURCE_COUNT} 件`, ok: d.source_measurements === EXPECTED_SOURCE_COUNT, detail: `${d.source_measurements} 件` },
    { label: 'kept = 11 件', ok: d.kept === 11, detail: `${d.kept} 件` },
    { label: 'excluded = 0 件', ok: d.excluded.length === 0, detail: d.excluded.length ? JSON.stringify(d.excluded) : '0 件' },
    { label: '11 項目の name / value が期待値と完全一致', ok: itemsMatch, detail: itemsMatch ? '一致' : '不一致' },
    { label: '欠損 4 項目の行が無い（0 を入れない）', ok: EXPECTED_ABSENT.every((n) => !names.includes(n)), detail: EXPECTED_ABSENT.filter((n) => names.includes(n)).join(', ') || 'なし' },
    { label: '中性脂肪 に統合されている', ok: names.includes('中性脂肪') && !names.includes('空腹時中性脂肪') && !names.includes('随時中性脂肪'), detail: '' },
    { label: '同じ受診日に通常 blood が無い', ok: d.normal_blood_exists === false, detail: d.normal_blood_exists ? 'YES' : 'NO' },
    { label: 'active な派生 blood が無い', ok: d.derived_active === 0, detail: `${d.derived_active} 件` },
  ];
  return { pass: checks.every((c) => c.ok), checks };
}

/**
 * **本体。** `apply: false`（既定）なら DB を変更しない。
 * `apply: true` のときだけ `persistDerivedBloodArtifact()` を **1 回**呼ぶ。
 */
export async function runDerivedBloodBackfillOne(input: {
  diagnosticUserId: string;
  testDate: string;
  apply?: boolean;
  allowReplace?: boolean;
}): Promise<BackfillOutcome> {
  const uid = input.diagnosticUserId.trim().toLowerCase();
  const testDate = input.testDate.trim();
  const apply = input.apply === true;
  const allowReplace = input.allowReplace === true;
  const supabase = supabaseIdentity();

  if (!uid || !testDate) return { ok: false, status: 400, error: 'diagnostic_user_id_and_test_date_required', supabase };
  if (!isAllowedTarget(uid, testDate)) {
    return { ok: false, status: 403, error: 'target_not_allowed', detail: 'この口は許可した 1 ユーザー・1 受診日だけを対象にする。', supabase };
  }

  const sb = getServerSupabase();
  if (!sb) return { ok: false, status: 503, error: 'supabase_not_configured', supabase };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dg = (sb as any).schema('diagnosis');

  // ── ① 対象 health_checkup。**自動でどれかを選ばない。** ちょうど 1 件であること ──
  const { data: hcData, error: hcErr } = await dg
    .from('test_artifacts')
    .select('id, test_date, source, imported_by, status, measurements')
    .eq('diagnostic_user_id', uid)
    .eq('test_type', 'health_checkup')
    .eq('test_date', testDate)
    .eq('status', 'active');
  if (hcErr) return { ok: false, status: 500, error: 'db_error', detail: hcErr.message, supabase };
  const hcRows = (hcData ?? []) as HcRow[];
  if (hcRows.length !== 1) {
    return {
      ok: false, status: 409, error: 'health_checkup_not_unique',
      detail: `active な health_checkup が ${hcRows.length} 件。何も変更しない。`, supabase,
    };
  }
  const hc = hcRows[0]!;
  const source: LeanRow[] = Array.isArray(hc.measurements) ? (hc.measurements as LeanRow[]) : [];
  const hcHashBefore = hashOf(hc.measurements);

  // ── ② 実装済みの抽出関数そのもの ──────────────────────────────
  const { kept, excluded } = extractBloodSubset(source);

  // ── ③ 同じ受診日の通常 blood / 既存派生（どちらも read only）──────
  const normalBlood = await hasNormalBloodOnDate(sb as never, uid, testDate);
  const derived = await derivedRows(sb, uid, testDate);

  const dryRun: DryRunInfo = {
    health_checkup_artifact_id: hc.id,
    health_checkup_count: hcRows.length,
    health_checkup_status: hc.status,
    source_measurements: source.length,
    source_measurements_sha256: hcHashBefore,
    kept: kept.length,
    excluded,
    items: kept.map((k) => ({ name: k.name, value: k.value, value_num: k.value_num, unit: k.unit ?? null })),
    normal_blood_exists: normalBlood,
    derived_active: derived.active.length,
    derived_superseded: derived.superseded.length,
    absent_items: BLOOD_SUBSET_ITEMS.filter((n) => !kept.some((k) => k.name === n)),
  };

  if (!apply) return { ok: true, mode: 'dry_run', status: 200, supabase, dryRun };

  // ── APPLY ────────────────────────────────────────────────────
  if (kept.length === 0) return { ok: false, status: 409, error: 'no_target_items', supabase, dryRun };
  if (normalBlood) return { ok: false, status: 409, error: 'normal_blood_exists', supabase, dryRun };
  // **1 回だけ。** 既に active な派生が在れば作らない（取り違えで artifact が入れ替わるのを防ぐ）。
  if (derived.active.length > 0 && !allowReplace) {
    return {
      ok: false, status: 409, error: 'already_exists',
      detail: 'active な派生 blood が既に在る。勝手に作り直さない。', supabase, dryRun,
    };
  }

  // **実装済みの生成関数そのもの**。別 INSERT を書かない。
  const result = await persistDerivedBloodArtifact(sb as never, {
    diagnosticUserId: uid, testDate, measurements: source,
  });
  if (result.status !== 'created' || !result.artifactId) {
    return { ok: false, status: 500, error: 'persist_failed', result, supabase, dryRun };
  }
  const artifactId = result.artifactId;

  // ── APPLY 後の read-only 確認 ─────────────────────────────────
  const { data: artData } = await dg
    .from('test_artifacts')
    .select('id, diagnostic_user_id, test_type, test_date, source, imported_by, status, scan_md')
    .eq('id', artifactId);
  const art = ((artData ?? [])[0] ?? null) as Record<string, unknown> | null;

  /* `measurement_values` は status を持たないので **artifact id で絞る**
   * （`verify:measurement-status` ① の要求形）。対象は今作った 1 件だけ。 */
  const { data: mvData } = await dg
    .from('measurement_values')
    .select('item_name, canonical_name, value, value_num, unit, test_type, source_file_kind, seq')
    .in('artifact_id', [artifactId])
    .order('seq');
  const mv = (mvData ?? []) as { item_name: string; canonical_name: string | null; value: string | null; value_num: number | null }[];

  const { data: hcAfterData } = await dg
    .from('test_artifacts')
    .select('id, status, measurements')
    .eq('id', hc.id);
  const hcAfter = ((hcAfterData ?? [])[0] ?? null) as { id: string; status: string | null; measurements: unknown } | null;
  const hcHashAfter = hcAfter ? hashOf(hcAfter.measurements) : '';
  const hcUnchanged = !!hcAfter
    && hcAfter.id === hc.id
    && hcAfter.status === 'active'
    && hcHashAfter === hcHashBefore
    && (Array.isArray(hcAfter.measurements) ? (hcAfter.measurements as unknown[]).length : -1) === source.length;

  let readyBlood: boolean | null = null;
  let readyMissing: string[] = [];
  try {
    const req = new Map<string, ElithFormat[] | null>([[uid, ['BloodTestData'] as ElithFormat[]]]);
    const rc = await checkFormatsReady([uid], req);
    readyBlood = rc[uid]?.ready ?? null;
    readyMissing = rc[uid]?.missing ?? [];
  } catch { readyBlood = null; }

  const trend: AppliedInfo['trend'] = { hit: 0, derived: 0, series: 0, detail: [] };
  try {
    const series = await getMeasurementTrend(uid, kept.map((k) => String(k.name)), 12, 'blood');
    trend.series = series.length;
    for (const s of series) {
      const p = s.points.find((x) => x.date === testDate);
      if (p) {
        trend.hit += 1;
        if (p.source === DERIVED_HC_BLOOD_SOURCE) trend.derived += 1;
        trend.detail.push({ name: s.label, value: p.value, source: p.source ?? null });
      }
    }
  } catch { /* 取れなければ 0 のまま返す */ }

  return {
    ok: true, mode: 'applied', status: 200, supabase, dryRun,
    applied: {
      derived_artifact_id: artifactId,
      artifact: art,
      measurement_values_count: mv.length,
      measurement_values: mv.map((r) => ({ name: r.canonical_name ?? r.item_name, value: r.value, value_num: r.value_num })),
      measurement_values_zero_rows: mv.filter((r) => r.value_num === 0).length,
      absent_items_present_in_mv: dryRun.absent_items.filter((n) => mv.some((r) => (r.canonical_name ?? r.item_name) === n)),
      health_checkup_unchanged: hcUnchanged,
      health_checkup_sha256_before: hcHashBefore,
      health_checkup_sha256_after: hcHashAfter,
      readiness_blood_ready: readyBlood,
      readiness_missing: readyMissing,
      trend,
      demo_fallback: demoFallbackEnabled(uid),
    },
  };
}
