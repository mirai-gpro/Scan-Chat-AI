/**
 * AI疾病予防報告書の **承認ゲートと 1 件再作成** (唯一の本体)。
 *
 * 正本: `docs/elith/AI疾病予防報告書_承認と再作成_仕様書.md`
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【この機能の前提 — 紙面は保存されていない】
 * ══════════════════════════════════════════════════════════════════════
 * `diagnosis.diagnosis_results` に入っているのは **Elith 受領 JSON** で、
 * 紙面は表示のたびに `report-adapter.ts` の `buildReportVM()` が組む
 * (`elith-report-queries.ts` → `report.astro`)。つまり
 *
 *   - 生成ロジックを直してデプロイした時点で、**過去分の紙面も自動的に新しくなる**
 *   - 保存されている「成果物」は受領 JSON だけ
 *
 * したがって **「最新版生成処理で再作成」の実体は 3 つ**:
 *   ① その報告書に対応する**現在の**受領 JSON を取り直す (S3 → 無ければ DB の控え)
 *   ② **本番と同じ `buildReportVM()`** に通して、最後まで生成できることを確かめる
 *   ③ 成功したときだけ上書きし、`pending` へ戻して**再承認を要求する**
 *
 * **再作成専用の生成ロジックは作らない。** ②は表示・取込・監査が共用している
 * 唯一の生成本体をそのまま呼ぶ。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【失敗したら 1 バイトも変えない】(仕様書 §6.5・受入条件 6)
 * ══════════════════════════════════════════════════════════════════════
 * 承認済みの報告書を再作成している途中で失敗したとき、**いま見えている紙面を
 * 消してはいけない**。だから順序を
 *
 *   材料取得 → 生成 → 生成成功を確認 → **1 回の update で**上書き + pending
 *
 * とし、どこで落ちても DB を触っていない状態にする。上書きと `pending` 化は
 * **同じ 1 本の update** なので「紙面だけ入れ替わって承認済のまま」も起こらない。
 */

import { buildReportVM, type LabFiles } from './report-adapter';
import type { ReportVM } from './report-model';
import {
  OUTPUT_ROOT, REPORT_FILE, MIN_FILES_COMPLETE, groupByFolder, readFolderMaterial,
} from './elith-intake';
import { isS3Configured, listObjects } from './s3';
import {
  FINGERPRINT_CONTEXT, hashState, reportFingerprint,
  type FingerprintRow, type HashState,
} from './report-fingerprint';
import { PENDING, APPROVED } from './report-gate';

/*
 * 公開状態と**ユーザー向けの判定は `report-gate.ts` (leaf) が持つ**。
 * このモジュールは再作成のため `elith-intake` → `s3` → AWS SDK を静的に引くので、
 * ユーザー取得経路がここを import すると**ダッシュボードの SSR グラフに
 * AWS SDK が入る** (実測で入った)。判定を 2 つ持たないよう、ここは再 export だけ。
 */
export { PENDING, APPROVED, isApprovedRow, isPubliclyVisibleRow } from './report-gate';

/** 一覧に出す 1 行。**氏名は含めない** — 識別は uid と受領日で行う。 */
export interface ReportApprovalRow {
  /** `diagnosis_results.id`。**画面がサーバへ渡す唯一の識別子**。 */
  id: string;
  diagnosticUserId: string;
  /** 1 セッションの識別子 (`unique (diagnostic_user_id, diagnostic_id)`)。 */
  diagnosticId: string;
  receivedAt: string;
  publishStatus: string;
  approvedAt: string | null;
  publishRev: number;
  schemaVersion: string;
  /** 取り込み元 (S3 フォルダ / `manual:transcosmos:…` / 手動は null)。 */
  sourceKey: string | null;
  hasPdf: boolean;
  /**
   * **承認した紙面の指紋の状態** (仕様書 §3.3)。
   *   `match`    … 承認した紙面と同じ = 公開中
   *   `mismatch` … 生成ロジック / app_config が変わって紙面が変わった = **非公開**
   *   `none`     … 指紋なし (移行した既存行・列未適用) = 従来どおり公開
   * **これを一覧に出さないと「承認済なのに利用者に出ない」理由を admin が辿れない。**
   */
  hashState: HashState;
  /** 再作成できる行か。false の行にはボタンを出さない (押しても必ず失敗する)。 */
  recreatable: boolean;
  /** 再作成できない理由。`recreatable` が true なら null。 */
  notRecreatableReason: string | null;
}

export interface ListResult {
  ok: boolean;
  rows: ReportApprovalRow[];
  /** `publish_status` 列がまだ無い環境。画面に「migration 未適用」と出すため。 */
  migrationApplied: boolean;
  error?: string;
  detail?: string;
}

type Db = { from: (t: string) => any };
type Sb = { schema: (s: string) => unknown };
const db = (sb: Sb): Db => sb.schema('diagnosis') as unknown as Db;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `diagnosis_results.id` として受け付ける形。**それ以外は DB へ渡さない。** */
export function isResultId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

/**
 * **トランスコスモス 10 名の行**か (組版済み PDF だけを持ち、受領 JSON を持たない)。
 * 正本: `transcosmos-reports.ts`。**ここで再作成を走らせると、公開中の PDF が
 * pending になって 10 名のダッシュボードから消える。**
 */
function isManualPdfRow(row: { schema_version?: unknown; source_key?: unknown }): boolean {
  return String(row.schema_version ?? '') === 'manual-pdf-v1'
    || String(row.source_key ?? '').startsWith('manual:transcosmos:');
}

/** Elith 下りの 1 フォルダ (`output/user/<uuid>/date/<YYYY_MM_DD>/`) か。 */
export function isElithOutputFolder(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = new RegExp(`^${OUTPUT_ROOT}([0-9a-f-]{36})/date/(\\d{4}_\\d{2}_\\d{2})/$`, 'i').exec(v);
  return !!m && UUID_RE.test(m[1]);
}

/** 行から「再作成できるか」を決める。**一覧とサーバ処理で同じ判断を使う。** */
export function recreatability(
  row: { report?: unknown; schema_version?: unknown; source_key?: unknown },
): { recreatable: boolean; reason: string | null } {
  if (isManualPdfRow(row)) {
    return { recreatable: false, reason: '組版済み PDF の行（受領 JSON を持たないため再作成できません）' };
  }
  if (isElithOutputFolder(row.source_key)) return { recreatable: true, reason: null };
  // 手動アップロード等。DB に受領 JSON がそのまま入っているので、それを材料にできる。
  const rep = row.report;
  const hasReport = !!rep && typeof rep === 'object' && (Array.isArray(rep) ? rep.length > 0 : Object.keys(rep).length > 0);
  if (hasReport) return { recreatable: true, reason: null };
  return { recreatable: false, reason: '元になる受領 JSON が見つかりません' };
}

/** `checkup_values` と `approved_report_hash` は**指紋の算出に要る**ので一緒に引く。 */
const LIST_COLS =
  'id, diagnostic_user_id, diagnostic_id, received_at, status, schema_version, source_key,'
  + ' report, checkup_values, report_pdf_url, publish_status, approved_at, publish_rev,'
  + ' approved_report_hash';
/** `publish_status` 等が無い環境でもう一度引くための列。 */
const LIST_COLS_LEGACY =
  'id, diagnostic_user_id, diagnostic_id, received_at, status, schema_version, source_key,'
  + ' report, report_pdf_url';

/**
 * 管理一覧。**最新の世代だけ** (`status != 'superseded'`) を新しい順に返す。
 *
 * 差し替えで superseded になった行は「過去版」であって承認の対象ではない
 * (仕様書 §2.2「常に 1 つの最新報告書だけを保持」)。
 */
export async function listReportsForApproval(
  sb: Sb | null,
  opts: { status?: 'pending' | 'approved'; limit?: number } = {},
): Promise<ListResult> {
  if (!sb) return { ok: false, rows: [], migrationApplied: false, error: 'supabase_not_configured' };
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);

  const fetch = async (cols: string, filterStatus: boolean) => {
    let q = db(sb).from('diagnosis_results').select(cols).neq('status', 'superseded');
    if (filterStatus && opts.status) q = q.eq('publish_status', opts.status);
    const { data, error } = await q.order('received_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []) as Record<string, unknown>[];
  };

  let raw: Record<string, unknown>[];
  let migrationApplied = true;
  try {
    raw = await fetch(LIST_COLS, true);
  } catch (e) {
    // 列がまだ無い環境。**0 件と混同しない** — 画面に「未適用」と出す。
    try {
      raw = await fetch(LIST_COLS_LEGACY, false);
      migrationApplied = false;
    } catch (e2) {
      return {
        ok: false, rows: [], migrationApplied: false, error: 'db_failed',
        detail: (e2 as { message?: string })?.message ?? String(e ?? e2),
      };
    }
  }

  const rows: ReportApprovalRow[] = [];
  for (const r of raw) {
    const rec = recreatability(r);
    /*
     * **指紋の照合は承認済の行だけ**。`pending` の行は照合する相手がいないし、
     * 指紋が無い行 (移行した既存行) は `hashState()` が 'none' を即返すので
     * `buildReportVM` は走らない = 既存行ばかりの環境ではコスト 0。
     */
    const hs = r.publish_status === APPROVED ? await hashState(r as FingerprintRow) : 'none';
    rows.push({
      id: String(r.id),
      diagnosticUserId: String(r.diagnostic_user_id),
      diagnosticId: String(r.diagnostic_id ?? ''),
      receivedAt: String(r.received_at ?? ''),
      // 列が無い環境は「承認済相当」(isApprovedRow と同じ扱い)。
      publishStatus: typeof r.publish_status === 'string' ? r.publish_status : APPROVED,
      approvedAt: typeof r.approved_at === 'string' ? r.approved_at : null,
      publishRev: Number.isFinite(Number(r.publish_rev)) ? Number(r.publish_rev) : 0,
      schemaVersion: String(r.schema_version ?? ''),
      sourceKey: typeof r.source_key === 'string' ? r.source_key : null,
      hasPdf: !!r.report_pdf_url,
      hashState: hs,
      recreatable: rec.recreatable,
      notRecreatableReason: rec.reason,
    });
  }

  // 列が無い環境では SQL で絞れないので、ここで絞る (全部 approved 相当)。
  const filtered = migrationApplied || !opts.status
    ? rows
    : rows.filter((r) => r.publishStatus === opts.status);

  return { ok: true, rows: filtered, migrationApplied };
}

export interface ApproveResult {
  ok: boolean;
  id: string;
  publishStatus?: string;
  approvedAt?: string;
  /** 控えた紙面の指紋。**秘密ではない** (監査で突き合わせられるように返す)。 */
  approvedReportHash?: string;
  /** 承認した紙面の中身 (表示と同じアダプタで数えたもの)。 */
  approved?: { sections: number; measurements: number; topics: number; digestCards: string[] };
  error?: string;
  detail?: string;
}

/**
 * **承認する。** `pending` かつ**画面が見たときと同じ内容**のときだけ通す。
 *
 * 【なぜ `expectedRev` が要るか】(仕様書 §9・受入条件 14)
 * 管理者 A が承認しようとしている最中に、管理者 B が同じ行を再作成すると、
 * **A が確認していない新しい紙面が承認される**。`publish_rev` は再作成のたびに
 * +1 されるので、A が見たときの値と違えば**承認せずに 409** を返し、
 * もう一度確認してもらう。**履歴管理ではない。**
 */
export async function approveReport(
  sb: Sb | null,
  input: { resultId: string; expectedRev: number; approvedBy: string | null },
): Promise<ApproveResult> {
  if (!sb) return { ok: false, id: input.resultId, error: 'supabase_not_configured' };
  if (!isResultId(input.resultId)) return { ok: false, id: input.resultId, error: 'invalid_result_id' };
  if (!Number.isInteger(input.expectedRev) || input.expectedRev < 0) {
    return { ok: false, id: input.resultId, error: 'invalid_expected_rev' };
  }

  /*
   * ── ① 承認する紙面を**いまの生成ロジックで組み、指紋を取る** (仕様書 §3.3) ──
   *
   * 紙面は保存されていないので、「承認した紙面」は**この指紋だけ**が表す。
   * 表示経路と同じ `buildReportVM()` を通すので、別の生成ロジックは作らない。
   * **app_config (`report.sections.*`) も紙面を決める**ので、呼び出し側 (API) が
   * `refreshConfig()` を済ませてからここへ来る。
   */
  const { data: row, error: selErr } = await db(sb)
    .from('diagnosis_results')
    .select('id, received_at, report, checkup_values, publish_status, publish_rev')
    .eq('id', input.resultId)
    .maybeSingle();
  if (selErr) return { ok: false, id: input.resultId, error: 'db_failed', detail: selErr.message };
  if (!row) return { ok: false, id: input.resultId, error: 'not_found' };

  /*
   * **列が無い環境では承認しない。** 指紋を書けないので、承認しても
   * 「生成ロジックが変わっても公開され続ける」状態になる (ゲートが効かない)。
   * 黙って進めずに止め、migration を当ててもらう。
   */
  if ((row as { publish_status?: unknown }).publish_status == null) {
    return {
      ok: false, id: input.resultId, error: 'migration_required',
      detail: '20261007000010 / 20261007000020 を適用してください',
    };
  }

  let built: { vm: ReportVM; hash: string } | null = null;
  let failure = '';
  try {
    const vm = buildReportVM({
      ...FINGERPRINT_CONTEXT,
      reportText: row.report ?? null,
      checkup: (row.checkup_values ?? null) as LabFiles | null,
      issuedOn: String(row.received_at ?? '').slice(0, 10),
    });
    built = { vm, hash: await reportFingerprint(vm) };
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  // 紙面が組めないものは承認できない (何を承認したのか言えない)。
  if (!built) {
    return { ok: false, id: input.resultId, error: 'fingerprint_failed', detail: failure };
  }

  // ── ② 承認と指紋を**同じ 1 本の update** で書く ────────────────
  const approvedAt = new Date().toISOString();
  const { data, error } = await db(sb)
    .from('diagnosis_results')
    .update({
      publish_status: APPROVED,
      approved_at: approvedAt,
      /** **生のメールアドレスは入れない。** `adminIdentity()` の HMAC digest だけ。 */
      approved_by: safeApprovedBy(input.approvedBy),
      approved_report_hash: built.hash,
    })
    .eq('id', input.resultId)
    .eq('publish_status', PENDING)
    .eq('publish_rev', input.expectedRev)
    .select('id, publish_status, approved_at, approved_report_hash');

  if (error) return { ok: false, id: input.resultId, error: 'db_failed', detail: error.message };
  const saved = (data ?? [])[0] as
    { publish_status?: string; approved_at?: string; approved_report_hash?: string } | undefined;
  if (!saved) {
    /*
     * 0 行 = ①既に承認済 ②その間に再作成が入って rev が進んだ ③id が無い。
     * **どれでも「承認しなかった」**ので、画面は一覧を引き直してもう一度確認する。
     */
    return { ok: false, id: input.resultId, error: 'not_pending_or_changed' };
  }
  return {
    ok: true,
    id: input.resultId,
    publishStatus: saved.publish_status,
    approvedAt: saved.approved_at,
    approvedReportHash: saved.approved_report_hash ?? built.hash,
    approved: {
      sections: built.vm.audit.sections.length,
      measurements: built.vm.audit.measurementCount,
      topics: built.vm.audit.topicCount,
      digestCards: built.vm.audit.digestCards,
    },
  };
}

/**
 * `approved_by` に入れてよい形。**`adminIdentity()` の base64url 43 文字だけ**。
 * `elith-delivery-runs.ts` の `safeTriggeredBy()` と同じ考え方 (allow-list)。
 * 「`@` を含まない」では氏名や社員番号が素通りする。
 */
export function safeApprovedBy(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v) ? v : null;
}

export interface RecreateResult {
  ok: boolean;
  id: string;
  /** 材料の取り直し元。`s3` = Elith 下りを読み直した / `stored` = DB の受領 JSON。 */
  source?: 's3' | 'stored';
  /** 生成できた中身 (表示と同じアダプタで数えたもの)。 */
  generated?: { sections: number; measurements: number; topics: number; digestCards: string[] };
  publishStatus?: string;
  publishRev?: number;
  error?: string;
  detail?: string;
}

/**
 * **報告書 1 件を、現在デプロイされている生成処理で作り直す。**
 *
 * 1 リクエスト = 1 件 (仕様書 §6.3)。一括用の API は作らない。
 * **クライアントから渡るのは `resultId` だけ** — S3 キー・受領 JSON 本文・
 * 生成パラメータは受け取らない (仕様書 §6.4)。
 *
 * **UPDATE しかしない**ので、連打しても行は増えない (冪等)。
 */
export async function recreateReport(
  sb: Sb | null,
  input: { resultId: string },
): Promise<RecreateResult> {
  if (!sb) return { ok: false, id: input.resultId, error: 'supabase_not_configured' };
  if (!isResultId(input.resultId)) return { ok: false, id: input.resultId, error: 'invalid_result_id' };

  // ── ① 対象を引く ─────────────────────────────────────────────
  const { data: row, error: selErr } = await db(sb)
    .from('diagnosis_results')
    .select('id, diagnostic_user_id, received_at, schema_version, source_key, report, checkup_values,'
      + ' publish_status, publish_rev')
    .eq('id', input.resultId)
    .maybeSingle();

  if (selErr) return { ok: false, id: input.resultId, error: 'db_failed', detail: selErr.message };
  if (!row) return { ok: false, id: input.resultId, error: 'not_found' };

  /*
   * **列が無い環境では再作成しない。** `publish_status` を書けないので、
   * 上書きだけして「承認済のまま」になりかねない。黙って進めずに止める。
   */
  if ((row as { publish_status?: unknown }).publish_status == null) {
    return {
      ok: false, id: input.resultId, error: 'migration_required',
      detail: '20261007000010_diagnosis_report_approval.sql を適用してください',
    };
  }

  const rec = recreatability(row);
  if (!rec.recreatable) {
    return { ok: false, id: input.resultId, error: 'not_recreatable', detail: rec.reason ?? undefined };
  }

  // ── ② 材料を取り直す (サーバ側で解決する) ────────────────────
  let material: { report: unknown; checkup: LabFiles | null; schemaVersion: string };
  let source: 's3' | 'stored';

  if (isElithOutputFolder(row.source_key)) {
    if (!isS3Configured()) {
      return { ok: false, id: input.resultId, error: 's3_not_configured' };
    }
    const folder = String(row.source_key);
    try {
      const keys = (await listObjects(folder)).map((o) => o.key);
      // **キーの読み方は取り込みと同じ関数**を通す (別の解釈をしない)。
      const { folders } = groupByFolder(keys);
      const entry = folders.get(folder);
      if (!entry) return { ok: false, id: input.resultId, error: 'source_not_found', detail: folder };
      if (entry.files.length < MIN_FILES_COMPLETE) {
        return { ok: false, id: input.resultId, error: 'source_incomplete',
          detail: `ファイルが ${entry.files.length} 件 (${MIN_FILES_COMPLETE} 件以上で完了)` };
      }
      if (!entry.files.includes(REPORT_FILE)) {
        return { ok: false, id: input.resultId, error: 'source_incomplete', detail: `${REPORT_FILE} が無い` };
      }
      material = await readFolderMaterial(folder, entry.files);
      source = 's3';
    } catch (e) {
      return { ok: false, id: input.resultId, error: 'source_read_failed',
        detail: e instanceof Error ? e.message : String(e) };
    }
  } else {
    /*
     * 手動アップロードの行。**受領 JSON は取り込み時に 1 バイトも加工せず入れてある**
     * (`elith-report-ingest.ts` の方針) ので、これが「その報告書に対応する受領 JSON」。
     * 新しい S3 探索ルールを作らない (仕様書 §11-2)。
     */
    material = {
      report: row.report ?? null,
      checkup: (row.checkup_values ?? null) as LabFiles | null,
      schemaVersion: String(row.schema_version ?? 'elith-v1.0'),
    };
    source = 'stored';
  }

  // ── ③ 本番と同じ生成処理に通して、最後まで通ることを確かめる ──
  let vm;
  try {
    vm = buildReportVM({
      reportText: material.report,
      checkup: material.checkup,
      name: '',
      issuedOn: String(row.received_at ?? '').slice(0, 10),
      isSample: false,
      hasCancerRisk: false,
      cycleSeq: null,
      chronologicalAge: null,
    });
  } catch (e) {
    return { ok: false, id: input.resultId, error: 'generate_failed',
      detail: e instanceof Error ? e.message : String(e) };
  }

  /*
   * **生成途中の不完全なデータで既存報告書を上書きしない** (仕様書 §9)。
   * 章も検査値も 0 件なら、紙面は帯だけになる = 利用者から見れば報告書が消えたのと同じ。
   * その状態を「成功」として上書きしない。
   */
  if (vm.audit.sections.length === 0 && vm.audit.measurementCount === 0) {
    return { ok: false, id: input.resultId, error: 'generated_empty',
      detail: '章 0 件 / 検査値 0 件。元データを確認してください（既存の報告書は変更していません）' };
  }

  // ── ④ ここで初めて書く。上書きと pending 化は同じ 1 本の update ──
  const prevRev = Number.isFinite(Number(row.publish_rev)) ? Number(row.publish_rev) : 0;
  const { data: upd, error: updErr } = await db(sb)
    .from('diagnosis_results')
    .update({
      report: material.report,
      checkup_values: material.checkup,
      schema_version: material.schemaVersion,
      publish_status: PENDING,
      approved_at: null,
      approved_by: null,
      /** **承認した紙面の指紋も捨てる** (仕様書 §3.1)。再承認で改めて控える。 */
      approved_report_hash: null,
      publish_rev: prevRev + 1,
    })
    .eq('id', input.resultId)
    .eq('publish_rev', prevRev)
    .select('id, publish_status, publish_rev');

  if (updErr) return { ok: false, id: input.resultId, error: 'save_failed', detail: updErr.message };
  const saved = (upd ?? [])[0] as { publish_status?: string; publish_rev?: number } | undefined;
  if (!saved) {
    // その間に別の再作成が走った。**二重に書かない** (既存は壊れていない)。
    return { ok: false, id: input.resultId, error: 'changed_during_recreate' };
  }

  return {
    ok: true,
    id: input.resultId,
    source,
    generated: {
      sections: vm.audit.sections.length,
      measurements: vm.audit.measurementCount,
      topics: vm.audit.topicCount,
      digestCards: vm.audit.digestCards,
    },
    publishStatus: saved.publish_status,
    publishRev: saved.publish_rev,
  };
}
