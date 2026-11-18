/**
 * 検査パイプライン進捗管理 (wellfort-site `/admin/lab-progress`) へ渡す
 * **Scan-Chat-AI 側の「事実」だけ**を、複数 uid ぶんまとめて返す。
 *
 * 正本: wellfort-site `docs/admin/検査パイプライン進捗管理_仕様書.md`
 *       (受領した仕様書 `Wellfort_検査パイプライン進捗管理_仕様書_20261119`)。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【このモジュールがやらないこと】
 * ══════════════════════════════════════════════════════════════════════
 * - **状態 (未着手/進行中/要確認 …) を決めない。** 判定は wellfort 側の 1 か所
 *   (`admin-lab-progress.ts`) が持つ。ここで決めると規則が 2 か所に分かれる。
 * - **回 (cycle) へ紐付けない。** `test_artifacts` は回の列を持たないので、
 *   日付の近さで割り当てるのは推測になる (仕様書「日付近似 bind 禁止」)。
 *   回へ明示的に紐付くのは撮影台帳の `shipment_ref` (= `app_bridge.kit_schedule.id`)
 *   だけで、それは**値のまま**返し、突き合わせは wellfort 側が行う。
 * - **書き込まない。** select しかしない (read-only の管理機能)。
 * - **PII と検査値を返さない。** 氏名・生年月日・外部検査ID の値・測定値・
 *   報告書本文は 1 文字も応答に載せない。報告書本文は「公開できる行か」の
 *   判定 (`isPubliclyVisibleRow`) にだけ使い、応答には真偽値しか出さない。
 *
 * 【引けなかった ≠ 無い】
 *   表ごとに取得の成否を `sources` に返す。失敗した表に依存する欄は **null**
 *   (= 不明) にし、空配列や 0 件 (= 無い) にしない。wellfort 側はこれを
 *   「不明」として表示する (仕様書「NULL を未完了と解釈しない」)。
 */
import { getServerSupabase } from './supabase';
import { isDemoAccount } from './demo-accounts';
import { isSpecialAccount } from './special-accounts';
import {
  planFormatMap,
  decideReady,
  countsTowardReadiness,
  type ElithFormat,
} from './elith-entitlement';
import { isDerivedHealthcheckBlood } from './blood-subset';
import { isPubliclyVisibleRow } from './report-gate';
import { cfg } from './app-config';

/** 1 リクエストで受ける uid の上限。wellfort 側はこれ以下に分けて呼ぶ。 */
export const MAX_SUBJECTS = 200;

/** `last_error` は監査用に先頭だけ返す (中身に検査値や鍵が混ざっても長く漏れないように)。 */
const ERROR_SNIPPET = 160;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type FactSource =
  | 'interview_completions'
  | 'test_artifacts'
  | 'lab_test_id_captures'
  | 'lab_tests'
  | 'elith_deliveries'
  | 'elith_delivery_items'
  | 'diagnosis_results';

export interface SubjectIn {
  diagnostic_user_id: string;
  /** wellfort 側の `subscriptions.product_id` (= `app_bridge.subscription.plan_code`)。 */
  plan_code?: string | null;
}

export interface ArtifactFact {
  id: string;
  test_type: string;
  test_date: string | null;
  imported_at: string | null;
  source: string | null;
  /** 人間ドックから抽出した派生 blood か (Elith の揃い判定に数えない)。 */
  derived: boolean;
}

export interface CaptureFact {
  /** `app_bridge.kit_schedule.id` か `orders.id`。**回へ紐付く唯一の明示キー**。 */
  shipment_ref: string;
  provider: string;
  test_type: string | null;
  status: string;
  link_status: string | null;
  lab_test_id: string | null;
  captured_at: string | null;
  confirmed_at: string | null;
  /** 紐付いた `customer.lab_tests` の状態。紐付きが無い/引けないときは null。 */
  lab_test_status: string | null;
  lab_test_reported_at: string | null;
}

export interface ElithFact {
  plan_code: string | null;
  /** null = この plan_code の対応表が無い (`elith.plan_formats` 未設定) = 自動納品の判定対象外。 */
  required_formats: ElithFormat[] | null;
  /** null = 判定に必要な表を引けなかった。 */
  ready: boolean | null;
  missing: ElithFormat[];
  checked: ElithFormat[];
  /** 本番 prefix ('') への納品のみ。null = 表を引けなかった。 */
  latest_delivered_at: string | null;
  delivered_count: number | null;
  failed_items: Array<{
    format_id: string;
    test_date: string | null;
    last_error: string | null;
    attempt_count: number | null;
    updated_at: string | null;
  }> | null;
}

export interface ReportFact {
  id: string;
  status: string | null;
  /** 列が無い環境は null (= 承認機能の migration 未適用)。 */
  publish_status: string | null;
  approved_at: string | null;
  received_at: string | null;
  report_pdf_received_at: string | null;
  has_pdf: boolean;
  /** 利用者に今出ているか (承認 + 紙面の指紋)。判定できなかったら null。 */
  visible: boolean | null;
}

export interface PipelineFacts {
  diagnostic_user_id: string;
  is_demo: boolean;
  is_special: boolean;
  /** null = 表を引けなかった。 */
  interview: { completed_count: number; latest_completed_at: string | null } | null;
  artifacts: ArtifactFact[] | null;
  captures: CaptureFact[] | null;
  elith: ElithFact;
  /** null = 受領なし。`sources.diagnosis_results` が error なら「不明」。 */
  report: ReportFact | null;
}

export interface FactsResult {
  facts: Record<string, PipelineFacts>;
  sources: Record<FactSource, 'ok' | 'error'>;
}

/** uid を正規化する。UUID でなければ null (捏造された値で照会しない)。 */
export function normalizeUid(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const u = v.trim().toLowerCase();
  return UUID_RE.test(u) ? u : null;
}

/** 入力を検証して正規化する。**上限超えは切り捨てずに拒否する** (黙って落とさない)。 */
export function parseSubjects(raw: unknown):
  { ok: true; subjects: SubjectIn[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'subjects_required' };
  if (raw.length > MAX_SUBJECTS) return { ok: false, error: 'too_many_subjects' };
  const seen = new Map<string, SubjectIn>();
  for (const s of raw) {
    const uid = normalizeUid((s as SubjectIn | null)?.diagnostic_user_id);
    if (!uid) return { ok: false, error: 'invalid_diagnostic_user_id' };
    const pc = (s as SubjectIn).plan_code;
    const planCode = typeof pc === 'string' && pc.trim() ? pc.trim() : null;
    // 同じ uid が別 plan で 2 回来ることはある (1 人が 2 契約)。最初の非 null を採る。
    const prev = seen.get(uid);
    if (!prev || (!prev.plan_code && planCode)) seen.set(uid, { diagnostic_user_id: uid, plan_code: planCode });
  }
  return { ok: true, subjects: [...seen.values()] };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const lc = (v: unknown): string => String(v ?? '').toLowerCase();

/**
 * **事実の取得本体。** 表ごとに 1 本ずつ (uid 全体を `.in()` でまとめて) 引く。
 * uid ごとに問い合わせない (N+1 にしない)。
 *
 * @param read app_config の読み出し (検査で差し替える)。既定は本物の `cfg`。
 */
export async function loadPipelineFacts(
  subjects: SubjectIn[],
  read: (k: string) => string = cfg,
): Promise<FactsResult | null> {
  const sb = getServerSupabase();
  if (!sb) return null;

  const uids = subjects.map((s) => s.diagnostic_user_id);
  const sources = {
    interview_completions: 'ok', test_artifacts: 'ok', lab_test_id_captures: 'ok', lab_tests: 'ok',
    elith_deliveries: 'ok', elith_delivery_items: 'ok', diagnosis_results: 'ok',
  } as Record<FactSource, 'ok' | 'error'>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const diagnosis = (sb as any).schema('diagnosis');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const customer = (sb as any).schema('customer');

  /**
   * **1 本が落ちても他を道連れにしない** (`account-progress.ts` と同じ流儀)。
   * 落ちた表は `sources` に error と記録し、その表に依存する欄は null (不明) にする。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetchRows = async (name: FactSource, p: Promise<any>): Promise<any[] | null> => {
    try {
      const r = await p;
      if (!r || r.error || !Array.isArray(r.data)) { sources[name] = 'error'; return null; }
      return r.data;
    } catch {
      sources[name] = 'error';
      return null;
    }
  };

  /**
   * 承認機能の列 (`publish_status` ほか) が無い環境 (migration 未適用) では
   * select ごと落ちるので、**列を減らして 1 回だけ取り直す**。
   * 承認列が無い行は `isApprovedRow` の既存の扱い (= approved 相当) に従う。
   */
  const fetchReports = async () => {
    const full = await fetchRows('diagnosis_results', diagnosis.from('diagnosis_results')
      .select('id, diagnostic_user_id, status, publish_status, approved_at, received_at, report_pdf_url, report_pdf_received_at, approved_report_hash')
      .in('diagnostic_user_id', uids));
    if (full !== null) return full;
    sources.diagnosis_results = 'ok';
    return fetchRows('diagnosis_results', diagnosis.from('diagnosis_results')
      .select('id, diagnostic_user_id, status, received_at, report_pdf_url, report_pdf_received_at')
      .in('diagnostic_user_id', uids));
  };

  const empty = uids.length === 0;
  const [iv, art, cap, dl, di, rp] = empty ? [[], [], [], [], [], []] : await Promise.all([
    fetchRows('interview_completions', diagnosis.from('interview_completions')
      .select('diagnostic_user_id, completed_at')
      .in('diagnostic_user_id', uids)),
    fetchRows('test_artifacts', diagnosis.from('test_artifacts')
      .select('id, diagnostic_user_id, test_type, test_date, imported_at, imported_by, source, status')
      .eq('status', 'active')
      .in('diagnostic_user_id', uids)),
    fetchRows('lab_test_id_captures', customer.from('lab_test_id_captures')
      .select('diagnostic_user_id, shipment_ref, provider, test_type, status, lab_test_id, lab_test_link_status, captured_at, confirmed_at')
      .in('diagnostic_user_id', uids)),
    fetchRows('elith_deliveries', diagnosis.from('elith_deliveries')
      .select('diagnostic_user_id, delivered_at, delivery_prefix, status')
      .eq('status', 'delivered')
      .in('diagnostic_user_id', uids)),
    fetchRows('elith_delivery_items', diagnosis.from('elith_delivery_items')
      .select('diagnostic_user_id, format_id, test_date, status, last_error, attempt_count, delivered_at, updated_at')
      .in('diagnostic_user_id', uids)),
    fetchReports(),
  ]);

  // 撮影台帳から紐付いた lab_tests だけを引く (uid で全件は引かない = 回への紐付けが明示のものだけ)。
  const captureRows = (cap ?? []).filter((r) => r?.status !== 'superseded');
  const labIds = [...new Set(captureRows.map((r) => str(r.lab_test_id)).filter((v): v is string => !!v))];
  const labRows = labIds.length === 0 ? [] : await fetchRows('lab_tests', customer.from('lab_tests')
    .select('id, status, reported_at')
    .in('id', labIds));
  const labById = new Map<string, { status: string | null; reported_at: string | null }>();
  for (const r of labRows ?? []) labById.set(String(r.id), { status: str(r.status), reported_at: str(r.reported_at) });

  const formats = planFormatMap(read);
  const facts: Record<string, PipelineFacts> = {};

  for (const s of subjects) {
    const uid = s.diagnostic_user_id;
    const planCode = s.plan_code ?? null;
    const required = planCode ? (formats.get(planCode) ?? null) : null;
    facts[uid] = {
      diagnostic_user_id: uid,
      is_demo: isDemoAccount(uid),
      is_special: isSpecialAccount(uid),
      interview: iv === null ? null : { completed_count: 0, latest_completed_at: null },
      artifacts: art === null ? null : [],
      captures: cap === null ? null : [],
      elith: {
        plan_code: planCode,
        required_formats: required,
        ready: null, missing: [], checked: [],
        latest_delivered_at: null,
        delivered_count: 0,
        failed_items: di === null ? null : [],
      },
      report: null,
    };
  }

  for (const r of iv ?? []) {
    const f = facts[lc(r.diagnostic_user_id)];
    if (!f?.interview) continue;
    f.interview.completed_count += 1;
    const t = str(r.completed_at);
    if (t && (!f.interview.latest_completed_at || t > f.interview.latest_completed_at)) f.interview.latest_completed_at = t;
  }

  for (const r of art ?? []) {
    const f = facts[lc(r.diagnostic_user_id)];
    if (!f?.artifacts) continue;
    f.artifacts.push({
      id: String(r.id),
      test_type: String(r.test_type ?? ''),
      test_date: str(r.test_date),
      imported_at: str(r.imported_at),
      source: str(r.source),
      derived: isDerivedHealthcheckBlood({ test_type: String(r.test_type ?? ''), imported_by: str(r.imported_by) }),
    });
  }

  for (const r of captureRows) {
    const f = facts[lc(r.diagnostic_user_id)];
    if (!f?.captures) continue;
    const labId = str(r.lab_test_id);
    const lab = labId ? labById.get(labId) : undefined;
    f.captures.push({
      shipment_ref: String(r.shipment_ref ?? ''),
      provider: String(r.provider ?? ''),
      test_type: str(r.test_type),
      status: String(r.status ?? ''),
      link_status: str(r.lab_test_link_status),
      lab_test_id: labId,
      captured_at: str(r.captured_at),
      confirmed_at: str(r.confirmed_at),
      lab_test_status: lab?.status ?? null,
      lab_test_reported_at: lab?.reported_at ?? null,
    });
  }

  // Elith: 本番 prefix ('') への納品だけを数える (検証用 prefix を「済」と読まない)。
  for (const r of dl ?? []) {
    if ((r.delivery_prefix ?? '') !== '') continue;
    const f = facts[lc(r.diagnostic_user_id)];
    if (!f) continue;
    f.elith.delivered_count = (f.elith.delivered_count ?? 0) + 1;
    const t = str(r.delivered_at);
    if (t && (!f.elith.latest_delivered_at || t > f.elith.latest_delivered_at)) f.elith.latest_delivered_at = t;
  }
  for (const r of di ?? []) {
    const f = facts[lc(r.diagnostic_user_id)];
    if (!f) continue;
    if (r.status === 'delivered') {
      f.elith.delivered_count = (f.elith.delivered_count ?? 0) + 1;
      const t = str(r.delivered_at);
      if (t && (!f.elith.latest_delivered_at || t > f.elith.latest_delivered_at)) f.elith.latest_delivered_at = t;
    } else if (r.status === 'failed' && f.elith.failed_items) {
      const e = str(r.last_error);
      f.elith.failed_items.push({
        format_id: String(r.format_id ?? ''),
        test_date: str(r.test_date),
        last_error: e ? e.slice(0, ERROR_SNIPPET) : null,
        attempt_count: typeof r.attempt_count === 'number' ? r.attempt_count : null,
        updated_at: str(r.updated_at),
      });
    }
  }

  // 納品の 2 表のどちらかを引けなければ「納品済みか」は不明 (片方だけで「未納品」と言わない)。
  if (dl === null || di === null) {
    for (const f of Object.values(facts)) { f.elith.delivered_count = null; f.elith.latest_delivered_at = null; }
  }

  // 揃い判定は**既存の純粋関数 `decideReady` をそのまま**使う (規則を複製しない)。
  // 必要な表のどちらかを引けなかったら判定しない (null = 不明)。
  for (const f of Object.values(facts)) {
    const req = f.elith.required_formats;
    if (!req) continue;
    if (art === null || iv === null) continue;
    const have = new Set<string>();
    for (const a of art) {
      if (lc(a.diagnostic_user_id) !== f.diagnostic_user_id) continue;
      if (!countsTowardReadiness({ test_type: String(a.test_type ?? ''), imported_by: str(a.imported_by) })) continue;
      have.add(String(a.test_type));
    }
    const d = decideReady(req, have, (f.interview?.completed_count ?? 0) > 0);
    f.elith.ready = d.ready;
    f.elith.missing = d.missing;
    f.elith.checked = d.checked;
  }

  // 報告書: 世代落ち (superseded) を除いた最新 1 件。公開判定は既存のゲート 1 本に委ねる。
  const latestReport = new Map<string, Record<string, unknown>>();
  for (const r of rp ?? []) {
    if (r?.status === 'superseded') continue;
    const uid = lc(r.diagnostic_user_id);
    const prev = latestReport.get(uid);
    const t = String(r.received_at ?? '');
    if (!prev || t > String(prev.received_at ?? '')) latestReport.set(uid, r);
  }
  // 指紋の照合に本文が要る行 (承認済で指紋あり) だけ本文を取りに行く。
  const needBody = [...latestReport.values()]
    .filter((r) => (r.publish_status == null || r.publish_status === 'approved') && typeof r.approved_report_hash === 'string')
    .map((r) => String(r.id));
  const bodies = new Map<string, { report: unknown; checkup_values: unknown }>();
  let bodyFailed = false;
  if (needBody.length) {
    try {
      const r = await diagnosis.from('diagnosis_results')
        .select('id, report, checkup_values')
        .in('id', needBody);
      if (r?.error || !Array.isArray(r?.data)) bodyFailed = true;
      for (const b of r?.data ?? []) bodies.set(String(b.id), { report: b.report, checkup_values: b.checkup_values });
    } catch { bodyFailed = true; }
  }
  for (const [uid, r] of latestReport) {
    const f = facts[uid];
    if (!f) continue;
    const id = String(r.id);
    let visible: boolean | null;
    try {
      const needs = needBody.includes(id);
      if (needs && (bodyFailed || !bodies.has(id))) visible = null;
      else visible = await isPubliclyVisibleRow({ ...r, ...(bodies.get(id) ?? {}) });
    } catch { visible = null; }
    f.report = {
      id,
      status: str(r.status),
      publish_status: str(r.publish_status),
      approved_at: str(r.approved_at),
      received_at: str(r.received_at),
      report_pdf_received_at: str(r.report_pdf_received_at),
      has_pdf: !!str(r.report_pdf_url),
      visible,
    };
  }

  return { facts, sources };
}
