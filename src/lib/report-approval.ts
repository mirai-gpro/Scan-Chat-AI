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
import {
  OUTPUT_ROOT, REPORT_FILE, MIN_FILES_COMPLETE, groupByFolder, readFolderMaterial,
} from './elith-intake';
import { isS3Configured, listObjects } from './s3';

/** 公開状態。**この 2 つだけ** (migration の CHECK と一致させる)。 */
export const PENDING = 'pending';
export const APPROVED = 'approved';

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
 * **ユーザーに見せてよい行か。**
 *
 * 【列が無い環境は approved 扱いにする】migration 適用前にアプリが出ても
 * **公開中の報告書を消さない**ため (CLAUDE.md の migration 規約では DB が先だが、
 * 順序が入れ替わったときに利用者の画面が落ちる方が重い)。
 * 列が無ければ `pending` の行も存在しないので、これで未承認が漏れることはない。
 */
export function isApprovedRow(row: { publish_status?: unknown } | null | undefined): boolean {
  if (!row) return false;
  const v = (row as { publish_status?: unknown }).publish_status;
  return v == null || v === APPROVED;
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

const LIST_COLS =
  'id, diagnostic_user_id, diagnostic_id, received_at, status, schema_version, source_key,'
  + ' report, report_pdf_url, publish_status, approved_at, publish_rev';
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

  const rows: ReportApprovalRow[] = raw.map((r) => {
    const rec = recreatability(r);
    return {
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
      recreatable: rec.recreatable,
      notRecreatableReason: rec.reason,
    };
  });

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

  const approvedAt = new Date().toISOString();
  const { data, error } = await db(sb)
    .from('diagnosis_results')
    .update({
      publish_status: APPROVED,
      approved_at: approvedAt,
      /** **生のメールアドレスは入れない。** `adminIdentity()` の HMAC digest だけ。 */
      approved_by: safeApprovedBy(input.approvedBy),
    })
    .eq('id', input.resultId)
    .eq('publish_status', PENDING)
    .eq('publish_rev', input.expectedRev)
    .select('id, publish_status, approved_at');

  if (error) return { ok: false, id: input.resultId, error: 'db_failed', detail: error.message };
  const row = (data ?? [])[0] as { publish_status?: string; approved_at?: string } | undefined;
  if (!row) {
    /*
     * 0 行 = ①既に承認済 ②その間に再作成が入って rev が進んだ ③id が無い。
     * **どれでも「承認しなかった」**ので、画面は一覧を引き直してもう一度確認する。
     */
    return { ok: false, id: input.resultId, error: 'not_pending_or_changed' };
  }
  return { ok: true, id: input.resultId, publishStatus: row.publish_status, approvedAt: row.approved_at };
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
