/**
 * admin: **保存済みの人間ドック／健康診断 1 件を、派生 blood へ backfill する。**
 *
 * 正本: `docs/specs/healthcheckup_blood_extraction_spec_20261001.md` §10.6（発注者裁定 Q-11）。
 * 責務は `scripts/backfill-derived-blood.mjs` と同じで、**対象が 1 ユーザー・1 受診日に限られる**
 * サーバ側の口。CLI は鍵を読める場所でしか動かせない（CLAUDE.md「鍵は Vercel 環境変数が正」）ので、
 * **Vercel Runtime の既存 env で同じ処理を動かす**ためにこの口を置く。
 *
 * 【抽出も INSERT も書かない】
 *   - 抽出 = `extractBloodSubset()`（`src/lib/blood-subset.ts`）
 *   - 生成 = `persistDerivedBloodArtifact()`（`src/lib/scan-persist.ts`）
 *     = `/api/scan/save` → `saveScanResult()` が通るのと**同一の関数**
 *   - 揃い判定 = `checkFormatsReady()` / 推移 = `getMeasurementTrend()`
 *   どれも**この口のための再実装をしない**（二重管理しない）。
 *
 * 【安全装置】
 *   - **`apply` の既定は false。** dry-run では DB を 1 行も変更しない。
 *   - **対象をサーバ側でも固定**（`ALLOWED`）。他の uid / 受診日は 403 で拒否する。
 *     body の申告だけで別の人を触れない（事故防止・発注者指示 2026-10-02）。
 *   - **既に active な派生が在れば作らない**（`already_exists`）。`allowReplace: true` を
 *     明示したときだけ作り直す（`persistDerivedBloodArtifact` 自体は冪等）。
 *   - **通常 blood が在る受診日では作らない**（裁定 Q-10。判定は既存関数が持つ）。
 *   - **元 health_checkup は触らない。** 不変であることを sha256 で前後比較して返す。
 *
 * 認可 = 既存の admin API と同じ Bearer `ADMIN_API_KEY`（`isAdminAuthorized`）。
 * **新しい認証方式は作らない。** 鍵はブラウザへ出さない。
 */
import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { getServerSupabase } from '../../../../lib/supabase';
import {
  extractBloodSubset,
  hasNormalBloodOnDate,
  DERIVED_HC_BLOOD_IMPORTED_BY,
  DERIVED_HC_BLOOD_SOURCE,
  BLOOD_SUBSET_ITEMS,
  type LeanRow,
} from '../../../../lib/blood-subset';
import { persistDerivedBloodArtifact } from '../../../../lib/scan-persist';
import { checkFormatsReady, type ElithFormat } from '../../../../lib/elith-entitlement';
import { getMeasurementTrend } from '../../../../lib/measurement-queries';
import { demoFallbackEnabled } from '../../../../lib/demo-data';

export const prerender = false;
/** 抽出 → insert → 読み直し → readiness → trend を 1 リクエストで通すので既定の 60s では足りないことがある。 */
export const config = { maxDuration: 300 };

/**
 * **サーバ側の許可リスト（発注者指示 2026-10-02）。**
 * ここに無い組み合わせは 403。今回のテストが他へ波及しないようにする。
 * 口を広げるときは**このリストを明示的に増やす**（body から受け取れるようにしない）。
 */
const ALLOWED: ReadonlyArray<{ uid: string; testDate: string }> = [
  { uid: '7d49b0b2-1f33-4d4b-ae74-fc033cc81dd8', testDate: '2026-09-24' },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 接続先の素性。**key は返さない。** host / project ref だけ。 */
function supabaseIdentity(): { host: string; project_ref: string } {
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

/** 受診日の派生 blood を status 別に引く。
 *  **status ごとに分けて引く** — `verify:measurement-status` ③ が「人単位の
 *  `test_artifacts` select は `.eq('status', …)` を持つこと」を要求する。
 *  監査のため superseded も見たいので、絞りを外すのではなく 2 本に分ける。 */
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

const hashOf = (v: unknown): string => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex');

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: { diagnosticUserId?: unknown; testDate?: unknown; apply?: unknown; allowReplace?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  const uid = String(body.diagnosticUserId ?? '').trim().toLowerCase();
  const testDate = String(body.testDate ?? '').trim();
  const apply = body.apply === true;            // 既定 false
  const allowReplace = body.allowReplace === true;

  if (!uid || !testDate) return json({ ok: false, error: 'diagnostic_user_id_and_test_date_required' }, 400);
  // **サーバ側の固定**。body の申告だけで別の人・別の日を触れない。
  if (!ALLOWED.some((a) => a.uid === uid && a.testDate === testDate)) {
    return json({ ok: false, error: 'target_not_allowed', detail: 'この口は許可した 1 ユーザー・1 受診日だけを対象にする。' }, 403);
  }

  const sb = getServerSupabase();
  if (!sb) return json({ ok: false, error: 'supabase_not_configured' }, 503);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dg = (sb as any).schema('diagnosis');
  const supabase = supabaseIdentity();

  // ── ① 対象 health_checkup。**自動でどれかを選ばない。** ちょうど 1 件であること ──
  const { data: hcData, error: hcErr } = await dg
    .from('test_artifacts')
    .select('id, test_date, source, imported_by, status, measurements')
    .eq('diagnostic_user_id', uid)
    .eq('test_type', 'health_checkup')
    .eq('test_date', testDate)
    .eq('status', 'active');
  if (hcErr) return json({ ok: false, error: 'db_error', detail: hcErr.message, supabase }, 500);
  const hcRows = (hcData ?? []) as HcRow[];
  if (hcRows.length !== 1) {
    return json({
      ok: false, error: 'health_checkup_not_unique',
      detail: `active な health_checkup が ${hcRows.length} 件。何も変更しない。`,
      supabase, health_checkup_count: hcRows.length,
    }, 409);
  }
  const hc = hcRows[0]!;
  const source: LeanRow[] = Array.isArray(hc.measurements) ? (hc.measurements as LeanRow[]) : [];
  const hcHashBefore = hashOf(hc.measurements);

  // ── ② 実装済みの抽出関数そのもの ──────────────────────────────
  const { kept, excluded } = extractBloodSubset(source);

  // ── ③ 同じ受診日の通常 blood / 既存派生（どちらも read only）──────
  const normalBlood = await hasNormalBloodOnDate(sb as never, uid, testDate);
  const derived = await derivedRows(sb, uid, testDate);

  const dryRun = {
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
    /** 15 項目のうち今回入らなかったもの = **行を作らない**（0 を入れない）。 */
    absent_items: BLOOD_SUBSET_ITEMS.filter((n) => !kept.some((k) => k.name === n)),
  };

  if (!apply) {
    return json({ ok: true, mode: 'dry_run', supabase, diagnostic_user_id: uid, test_date: testDate, dry_run: dryRun });
  }

  // ── APPLY ────────────────────────────────────────────────────
  if (kept.length === 0) {
    return json({ ok: false, error: 'no_target_items', supabase, dry_run: dryRun }, 409);
  }
  if (normalBlood) {
    return json({ ok: false, error: 'normal_blood_exists', supabase, dry_run: dryRun }, 409);
  }
  // **1 回だけ**。既に active な派生が在れば作らない（取り違えで artifact が入れ替わるのを防ぐ）。
  if (derived.active.length > 0 && !allowReplace) {
    return json({
      ok: false, error: 'already_exists',
      detail: 'active な派生 blood が既に在る。作り直すなら allowReplace: true を明示すること。',
      supabase, dry_run: dryRun,
    }, 409);
  }

  // **実装済みの生成関数そのもの**。別 INSERT を書かない。
  const result = await persistDerivedBloodArtifact(sb as never, {
    diagnosticUserId: uid,
    testDate,
    measurements: source,
  });
  if (result.status !== 'created') {
    return json({ ok: false, error: 'persist_failed', result, supabase, dry_run: dryRun }, 500);
  }
  const artifactId = result.artifactId!;

  // ── APPLY 後の read-only 確認 ─────────────────────────────────
  const { data: artData } = await dg
    .from('test_artifacts')
    .select('id, diagnostic_user_id, test_type, test_date, source, imported_by, status, scan_md')
    .eq('id', artifactId);
  const art = ((artData ?? [])[0] ?? null) as Record<string, unknown> | null;

  /** `measurement_values` は status を持たないので **artifact id で絞る**
   *  （`verify:measurement-status` ① の要求形）。対象は今作った 1 件だけ。 */
  const { data: mvData } = await dg
    .from('measurement_values')
    .select('item_name, canonical_name, value, value_num, unit, test_type, source_file_kind, seq')
    .in('artifact_id', [artifactId])
    .order('seq');
  const mv = (mvData ?? []) as { item_name: string; canonical_name: string | null; value: string | null; value_num: number | null }[];

  // 元 health_checkup の不変確認（artifact ID / status / measurements の sha256）
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

  // readiness（実装済み）。BloodTestData だけを要求しても **ready=false** が期待値。
  let readyBlood: boolean | null = null;
  let readyMissing: string[] = [];
  try {
    const req = new Map<string, ElithFormat[] | null>([[uid, ['BloodTestData'] as ElithFormat[]]]);
    const rc = await checkFormatsReady([uid], req);
    readyBlood = rc[uid]?.ready ?? null;
    readyMissing = rc[uid]?.missing ?? [];
  } catch { readyBlood = null; }

  // Dashboard の推移（実装済み）。派生の点に source が付くこと。
  const trendNames = kept.map((k) => String(k.name));
  let trend: { hit: number; derived: number; series: number; detail: { name: string; value: number; source: string | null }[] } =
    { hit: 0, derived: 0, series: 0, detail: [] };
  try {
    const series = await getMeasurementTrend(uid, trendNames, 12, 'blood');
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

  return json({
    ok: true,
    mode: 'applied',
    supabase,
    diagnostic_user_id: uid,
    test_date: testDate,
    dry_run: dryRun,
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
      /** ON だと `getMeasurementTrend()` がダミーを返すので trend は実データの証拠にならない。 */
      demo_fallback: demoFallbackEnabled(uid),
    },
  });
};
