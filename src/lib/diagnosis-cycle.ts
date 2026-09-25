/**
 * Diagnosis Cycle の解決と相関 (`diagnosis.cycle_links`) — P0-2 §5 / §10 / §11。
 *
 * 正本: P0-2_修正設計案_rev3.md / 最終実装指示 §9〜§11
 *
 * 【このモジュールの約束】
 *   1. **date から cycle を推測しない。** 回の正本は Wellfort (`public.diagnosis_cycle`)。
 *      Scan 側は bridge view を読むか、取込時に明示的に渡された値を使うかのどちらかだけ。
 *   2. **取込を壊さない。** link に失敗しても例外を投げない (理由を返す)。
 *      検査データの保存そのものは link の成否と独立している。
 *   3. **open が 1 件のときだけ自動 link。** 0 件・2 件以上は **link しない** (fail-closed)。
 *      「最新日付」「最も近い scheduled_date」等で選ばない (指示 §10)。
 */

import { getBridgeSupabase, getServerSupabase } from './supabase';

/** Elith の format_id のうち、cycle_links に載るもの (HealthAgeData は算出物なので載せない)。 */
export type LinkableFormat =
  | 'HealthCheckupData'
  | 'LifestyleQuestionnaireData'
  | 'BloodTestData'
  | 'CancerRiskAssessmentData'
  | 'GeneticTestResultData'
  | 'Other';

/** fail-closed の理由 (指示 §16)。**黙って skip しない。** */
export type CycleReason =
  | 'bridge_unavailable'
  | 'bridge_query_failed'
  | 'no_open_diagnosis_cycle'
  | 'multiple_open_diagnosis_cycles'
  | 'diagnosis_cycle_undefined'
  | 'db_unavailable'
  | 'link_failed';

export interface DiagnosisCycleRef {
  subscriptionId: string;
  cycleYear: number;
  diagnosisCycleSeq: number;
}

export interface DiagnosisCycleInfo extends DiagnosisCycleRef {
  /** 'healthcheck' | 'intermediate'。**null = 未指定** → readiness を進めない。 */
  cycleKind: 'healthcheck' | 'intermediate' | null;
  status: string;
  /** 対応 Shipment Cycle に予定されている format (明示指定が無ければ空配列)。 */
  plannedFormatIds: string[];
}

interface CycleRow {
  subscription_id?: string;
  cycle_year?: number;
  diagnosis_cycle_seq?: number;
  cycle_kind?: string | null;
  status?: string;
  planned_format_ids?: string[] | null;
}

function toInfo(r: CycleRow): DiagnosisCycleInfo {
  const kind = r.cycle_kind === 'healthcheck' || r.cycle_kind === 'intermediate' ? r.cycle_kind : null;
  return {
    subscriptionId: String(r.subscription_id ?? ''),
    cycleYear: Number(r.cycle_year ?? 0),
    diagnosisCycleSeq: Number(r.diagnosis_cycle_seq ?? 0),
    cycleKind: kind,
    status: String(r.status ?? ''),
    plannedFormatIds: Array.isArray(r.planned_format_ids) ? r.planned_format_ids.filter(Boolean) : [],
  };
}

/**
 * **この uid で「いま open な Diagnosis Cycle」を 1 件だけ返す** (指示 §10)。
 *
 * - 0 件 → `no_open_diagnosis_cycle`
 * - 2 件以上 → `multiple_open_diagnosis_cycles` (**運用異常**。どれかを選ばない)
 * - bridge が引けない → `bridge_unavailable` / `bridge_query_failed`
 */
export async function findOpenDiagnosisCycle(
  uid: string,
): Promise<{ cycle: DiagnosisCycleInfo | null; reason: CycleReason | null }> {
  const sb = getBridgeSupabase();
  if (!sb) return { cycle: null, reason: 'bridge_unavailable' };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (sb as any)
      .from('diagnosis_cycle_status')
      .select('subscription_id, cycle_year, diagnosis_cycle_seq, cycle_kind, status, planned_format_ids')
      .eq('diagnostic_user_id', uid.trim().toLowerCase())
      .eq('status', 'open');
    if (error) return { cycle: null, reason: 'bridge_query_failed' };
    const rows = (data ?? []) as CycleRow[];
    if (rows.length === 0) return { cycle: null, reason: 'no_open_diagnosis_cycle' };
    if (rows.length > 1) {
      // **運用異常**: 同時に複数の回が open。自動では選ばない。
      console.error(
        `[diagnosis-cycle] open な Diagnosis Cycle が ${rows.length} 件あります (uid=${uid})。`
        + ' 自動 link を見送りました。Wellfort 側で 1 件だけ open にしてください。',
      );
      return { cycle: null, reason: 'multiple_open_diagnosis_cycles' };
    }
    return { cycle: toInfo(rows[0]), reason: null };
  } catch {
    return { cycle: null, reason: 'bridge_query_failed' };
  }
}

/** 指定の回を 1 件引く (admin/batch 経路が明示 ID で渡してきたときの検証用)。 */
export async function getDiagnosisCycle(
  ref: DiagnosisCycleRef,
): Promise<{ cycle: DiagnosisCycleInfo | null; reason: CycleReason | null }> {
  const sb = getBridgeSupabase();
  if (!sb) return { cycle: null, reason: 'bridge_unavailable' };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (sb as any)
      .from('diagnosis_cycle_status')
      .select('subscription_id, cycle_year, diagnosis_cycle_seq, cycle_kind, status, planned_format_ids')
      .eq('subscription_id', ref.subscriptionId)
      .eq('cycle_year', ref.cycleYear)
      .eq('diagnosis_cycle_seq', ref.diagnosisCycleSeq)
      .limit(1);
    if (error) return { cycle: null, reason: 'bridge_query_failed' };
    const rows = (data ?? []) as CycleRow[];
    if (!rows.length) return { cycle: null, reason: 'diagnosis_cycle_undefined' };
    return { cycle: toInfo(rows[0]), reason: null };
  } catch {
    return { cycle: null, reason: 'bridge_query_failed' };
  }
}

export interface LinkInput extends DiagnosisCycleRef {
  diagnosticUserId: string;
  formatId: LinkableFormat;
  artifactId?: string | null;
  sourceRef?: string | null;
  linkedBy: string;
}

/**
 * `cycle_links` に 1 行作る。
 *
 * - **既に同じ (cycle, format) がある場合は上書きしない** (`on conflict do nothing`)。
 *   正式採用 source は 1 つという構造 (UNIQUE) を尊重し、先勝ちにする。
 * - **例外を投げない。** 取込処理を止めないため、失敗は理由で返す。
 */
export async function linkCycle(input: LinkInput): Promise<{ linked: boolean; reason: CycleReason | null }> {
  const sb = getServerSupabase();
  if (!sb) return { linked: false, reason: 'db_unavailable' };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (sb.schema('diagnosis') as any)
      .from('cycle_links')
      .upsert(
        {
          diagnostic_user_id: input.diagnosticUserId,
          subscription_id: input.subscriptionId,
          cycle_year: input.cycleYear,
          diagnosis_cycle_seq: input.diagnosisCycleSeq,
          format_id: input.formatId,
          ...(input.artifactId ? { artifact_id: input.artifactId } : {}),
          ...(input.sourceRef ? { source_ref: input.sourceRef } : {}),
          linked_by: input.linkedBy,
        },
        { onConflict: 'subscription_id,cycle_year,diagnosis_cycle_seq,format_id', ignoreDuplicates: true },
      );
    if (error) {
      console.error('[diagnosis-cycle] cycle_links への記録に失敗:', error.message);
      return { linked: false, reason: 'link_failed' };
    }
    return { linked: true, reason: null };
  } catch (e) {
    console.error('[diagnosis-cycle] cycle_links で例外:', e instanceof Error ? e.message : e);
    return { linked: false, reason: 'link_failed' };
  }
}

/**
 * **ブラウザ発 3 経路 (AI問診 / ユーザースキャン / scan-worker) の自動 link** (指示 §10・方式 a)。
 *
 * 保存の直後に呼ぶ。open な回が**ちょうど 1 件のときだけ** link し、
 * 0 件・複数件は **link しない**（fail-closed）。**日付で選ばない。**
 *
 * **絶対に例外を投げない。** 取込は link の成否と独立して成立させる。
 */
export async function autoLinkOpenCycle(args: {
  diagnosticUserId: string;
  formatId: LinkableFormat;
  artifactId?: string | null;
  sourceRef?: string | null;
}): Promise<{ linked: boolean; reason: CycleReason | null; cycle: DiagnosisCycleRef | null }> {
  try {
    const { cycle, reason } = await findOpenDiagnosisCycle(args.diagnosticUserId);
    if (!cycle) return { linked: false, reason, cycle: null };
    const r = await linkCycle({
      diagnosticUserId: args.diagnosticUserId,
      subscriptionId: cycle.subscriptionId,
      cycleYear: cycle.cycleYear,
      diagnosisCycleSeq: cycle.diagnosisCycleSeq,
      formatId: args.formatId,
      artifactId: args.artifactId ?? null,
      sourceRef: args.sourceRef ?? null,
      linkedBy: 'auto_open_cycle',
    });
    return {
      linked: r.linked,
      reason: r.reason,
      cycle: {
        subscriptionId: cycle.subscriptionId,
        cycleYear: cycle.cycleYear,
        diagnosisCycleSeq: cycle.diagnosisCycleSeq,
      },
    };
  } catch (e) {
    // ここへ来ても取込は成功扱いにする (link だけが欠ける)。
    console.error('[diagnosis-cycle] 自動 link で例外:', e instanceof Error ? e.message : e);
    return { linked: false, reason: 'link_failed', cycle: null };
  }
}

/** ある回にひも付いた link を全部引く (readiness と納品の source 選択に使う)。 */
export async function loadCycleLinks(
  ref: DiagnosisCycleRef,
): Promise<{ links: Record<string, { sourceRef: string | null; artifactId: string | null }>; reason: CycleReason | null }> {
  const sb = getServerSupabase();
  if (!sb) return { links: {}, reason: 'db_unavailable' };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (sb.schema('diagnosis') as any)
      .from('cycle_links')
      .select('format_id, source_ref, artifact_id')
      .eq('subscription_id', ref.subscriptionId)
      .eq('cycle_year', ref.cycleYear)
      .eq('diagnosis_cycle_seq', ref.diagnosisCycleSeq);
    if (error) return { links: {}, reason: 'db_unavailable' };
    const out: Record<string, { sourceRef: string | null; artifactId: string | null }> = {};
    for (const r of (data ?? []) as { format_id: string; source_ref: string | null; artifact_id: string | null }[]) {
      out[r.format_id] = { sourceRef: r.source_ref ?? null, artifactId: r.artifact_id ?? null };
    }
    return { links: out, reason: null };
  } catch {
    return { links: {}, reason: 'db_unavailable' };
  }
}
