/**
 * **契約者 (Diagnosis Cycle 単位) の Elith 自動納品** — P0-2 §5〜§16。
 *
 * 単品/スペシャル経路 (`deliverReadySpecialAccounts`) とは**完全に分離**する (指示 §8)。
 * あちらは `single_product_spec.required_formats` が正本で Diagnosis Cycle を持たない。
 * **既存動作は 1 行も変更しない。**
 *
 * 【流れ】
 *   app_bridge.subscription_current (status='active')
 *     → app_bridge.diagnosis_cycle_status (その契約の回)
 *       → diagnosis.cycle_links (その回に何が結び付いたか)
 *         → readiness (elith-readiness.ts)
 *           → exact-source assemble (cycle_links.source_ref だけを納品)
 *             → elith_deliveries へ記録 (回単位の冪等キー)
 *
 * 【fail-closed】どの段でも「分からない」なら納品しない。**必ず reason を残す** (指示 §16)。
 */

import { assembleElithDeliverySet } from './elith-assemble';
import { evaluateReadiness } from './elith-readiness';
import { loadCycleLinks, type DiagnosisCycleInfo } from './diagnosis-cycle';
import { getBridgeSupabase, getServerSupabase } from './supabase';
import { putFiles } from './s3';

export type DeliverCycleReason =
  | 'bridge_unavailable' | 'bridge_query_failed' | 'unknown_plan_composition'
  | 'diagnosis_cycle_undefined' | 'no_open_diagnosis_cycle' | 'multiple_open_diagnosis_cycles'
  | 'cycle_unresolved' | 'missing_format' | 'source_not_found' | 'already_delivered';

export interface CycleDeliverResult {
  diagnosticUserId: string;
  subscriptionId: string;
  cycleYear: number;
  diagnosisCycleSeq: number;
  status: 'delivered' | 'skipped';
  reason: DeliverCycleReason | null;
  /** 何を根拠に ready としたか → どの source を採ったか → どこへ出したか (指示 §16 の追跡)。 */
  trace?: { formatId: string; sourceRef: string; newKey: string }[];
  detail?: string;
}

export interface CycleDeliverSummary {
  candidates: number;
  delivered: number;
  results: CycleDeliverResult[];
  /** 母集団を取れなかった場合の理由 (取れたときは null)。 */
  fatal: DeliverCycleReason | null;
}

interface SubRow { diagnostic_user_id?: string; subscription_id?: string; plan_composition_id?: string | null; status?: string }
interface CycleRow {
  diagnostic_user_id?: string; subscription_id?: string; cycle_year?: number; diagnosis_cycle_seq?: number;
  cycle_kind?: string | null; status?: string; planned_format_ids?: string[] | null;
}

/**
 * 契約者の「揃った回」を Elith へ納品する。
 *
 * @param opts.skipDelivered 納品済みの回を再送しない (cron は true)
 */
export async function deliverReadyDiagnosisCycles(opts: {
  sourcePrefix: string;
  deliveryPrefix: string;
  skipDelivered?: boolean;
  /** true = S3 へ書かずに判定だけ返す (staging の通し確認用)。 */
  dryRun?: boolean;
}): Promise<CycleDeliverSummary> {
  const results: CycleDeliverResult[] = [];
  const bridge = getBridgeSupabase();
  if (!bridge) return { candidates: 0, delivered: 0, results, fatal: 'bridge_unavailable' };

  // ── ① 母集団: active な契約だけ (pending を権利と読まない) ──────────────
  let subs: SubRow[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (bridge as any)
      .from('subscription_current')
      .select('diagnostic_user_id, subscription_id, plan_composition_id, status')
      .eq('status', 'active');
    if (error) return { candidates: 0, delivered: 0, results, fatal: 'bridge_query_failed' };
    subs = (data ?? []) as SubRow[];
  } catch {
    return { candidates: 0, delivered: 0, results, fatal: 'bridge_query_failed' };
  }
  if (subs.length === 0) return { candidates: 0, delivered: 0, results, fatal: null };

  // ── ② その契約の Diagnosis Cycle (open な回) ────────────────────────────
  const subIds = subs.map((s) => String(s.subscription_id)).filter(Boolean);
  let cycles: CycleRow[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (bridge as any)
      .from('diagnosis_cycle_status')
      .select('diagnostic_user_id, subscription_id, cycle_year, diagnosis_cycle_seq, cycle_kind, status, planned_format_ids')
      .in('subscription_id', subIds)
      .eq('status', 'open');
    if (error) return { candidates: 0, delivered: 0, results, fatal: 'bridge_query_failed' };
    cycles = (data ?? []) as CycleRow[];
  } catch {
    return { candidates: 0, delivered: 0, results, fatal: 'bridge_query_failed' };
  }

  const compBySub = new Map(subs.map((s) => [String(s.subscription_id), s.plan_composition_id ?? null]));
  const delivered = opts.skipDelivered ? await loadDeliveredCycles(opts.deliveryPrefix) : new Set<string>();
  let deliveredCount = 0;

  for (const row of cycles) {
    const uid = String(row.diagnostic_user_id ?? '').toLowerCase();
    const subscriptionId = String(row.subscription_id ?? '');
    const cycleYear = Number(row.cycle_year ?? 0);
    const diagnosisCycleSeq = Number(row.diagnosis_cycle_seq ?? 0);
    const base = { diagnosticUserId: uid, subscriptionId, cycleYear, diagnosisCycleSeq };
    const push = (reason: DeliverCycleReason, detail?: string) =>
      results.push({ ...base, status: 'skipped', reason, ...(detail ? { detail } : {}) });

    // 契約版が pin されていない回は納品しない (P0-1 の pin 漏れ = 後から backfill する)
    if (!compBySub.get(subscriptionId)) { push('unknown_plan_composition'); continue; }

    const key = `${uid}|${subscriptionId}|${cycleYear}|${diagnosisCycleSeq}`;
    if (opts.skipDelivered && delivered.has(key)) { push('already_delivered'); continue; }

    const cycle: DiagnosisCycleInfo = {
      subscriptionId, cycleYear, diagnosisCycleSeq,
      cycleKind: row.cycle_kind === 'healthcheck' || row.cycle_kind === 'intermediate' ? row.cycle_kind : null,
      status: String(row.status ?? ''),
      plannedFormatIds: Array.isArray(row.planned_format_ids) ? row.planned_format_ids.filter(Boolean) : [],
    };

    // ── ③ その回に何が結び付いているか ──────────────────────────────────
    const { links, reason: linkReason } = await loadCycleLinks(base);
    if (linkReason) { push('cycle_unresolved', linkReason); continue; }

    // ── ④ readiness ────────────────────────────────────────────────────
    const rd = evaluateReadiness({ cycle, linkedFormats: new Set(Object.keys(links)) });
    if (rd.reason === 'diagnosis_cycle_undefined') { push('diagnosis_cycle_undefined'); continue; }
    if (!rd.ready) { push('missing_format', rd.missing.join(' / ')); continue; }

    // ── ⑤ 採用 source (cycle_links.source_ref) を集める ─────────────────
    const mapping: Record<string, string> = {};
    const missingSource: string[] = [];
    for (const f of rd.deliverFormats) {
      const src = links[f]?.sourceRef;
      if (!src) missingSource.push(f); else mapping[f] = src;
    }
    if (missingSource.length) { push('source_not_found', missingSource.join(' / ')); continue; }

    // ── ⑥ exact-source で組む (過去回を混ぜない) ────────────────────────
    try {
      const asm = await assembleElithDeliverySet({
        sourcePrefix: opts.sourcePrefix,
        deliveryPrefix: opts.deliveryPrefix,
        manualMapping: { [uid]: mapping as never },
        exactSource: true, // ★ SERIES_FORMATS の全 date 展開をしない
      });
      const user = asm.users[0];
      if (!user || user.files.length === 0) { push('source_not_found', 'assemble が 0 件'); continue; }

      const trace = user.sources.map((s) => ({ formatId: s.formatId, sourceRef: s.sourceKey, newKey: s.newKey }));
      if (opts.dryRun) {
        results.push({ ...base, status: 'delivered', reason: null, trace, detail: 'dry-run (S3 未書込)' });
        deliveredCount += 1;
        continue;
      }
      await putFiles(user.files);
      await recordCycleDelivery({ ...base, deliveryPrefix: opts.deliveryPrefix, formats: rd.deliverFormats });
      results.push({ ...base, status: 'delivered', reason: null, trace });
      deliveredCount += 1;
    } catch (e) {
      push('source_not_found', String(e instanceof Error ? e.message : e));
    }
  }

  return { candidates: cycles.length, delivered: deliveredCount, results, fatal: null };
}

/** 納品済みの回 (`uid|sub|year|seq`)。 */
async function loadDeliveredCycles(deliveryPrefix: string): Promise<Set<string>> {
  const out = new Set<string>();
  const sb = getServerSupabase();
  if (!sb) return out;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (sb.schema('diagnosis') as any)
      .from('elith_deliveries')
      .select('diagnostic_user_id, subscription_id, cycle_year, diagnosis_cycle_seq')
      .eq('delivery_prefix', deliveryPrefix)
      .eq('status', 'delivered')
      .not('subscription_id', 'is', null);
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      out.add(`${String(r.diagnostic_user_id).toLowerCase()}|${r.subscription_id}|${r.cycle_year}|${r.diagnosis_cycle_seq}`);
    }
  } catch { /* 引けないときは空 = 再送を許す (二重納品より取りこぼしを避ける) */ }
  return out;
}

async function recordCycleDelivery(a: {
  diagnosticUserId: string; subscriptionId: string; cycleYear: number; diagnosisCycleSeq: number;
  deliveryPrefix: string; formats: string[];
}): Promise<void> {
  const sb = getServerSupabase();
  if (!sb) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sb.schema('diagnosis') as any).from('elith_deliveries').insert({
      diagnostic_user_id: a.diagnosticUserId,
      subscription_id: a.subscriptionId,
      cycle_year: a.cycleYear,
      diagnosis_cycle_seq: a.diagnosisCycleSeq,
      delivery_prefix: a.deliveryPrefix,
      bundle_date: new Date().toISOString().slice(0, 10),
      status: 'delivered',
    });
  } catch (e) {
    // 記録に失敗しても納品自体は成立している (次回 skipDelivered が効かないだけ)。
    console.error('[elith-deliver-cycles] 納品記録に失敗:', e instanceof Error ? e.message : e);
  }
}
