/**
 * Elith 受領分を `diagnosis.diagnosis_results` へ入れる **唯一の本体**。
 *
 * 【なぜ切り出したか】入口が 3 つになったため:
 *   ① 手動アップロード  `POST /api/admin/elith-report/upload` (wellfort-site の admin から)
 *   ② 随時バッチ        `POST /api/admin/elith-intake`
 *   ③ 毎日の自動取り込み `GET  /api/cron/elith-intake` (9:00 JST)
 * 世代管理と「取り込めた中身の数え方」を 3 か所に書くと、直したとき片方が腐る。
 * 健診 finalize (`elith-hc-finalize.ts`) と同じ規律で、**本体は 1 つ**。
 *
 * 【ここでは中身を 1 バイトも加工しない】受領 JSON をそのまま入れる。
 * 形式の世代差はアダプタ (`report-adapter.ts`) が吸収する、が既定の分担。
 */
import { buildReportVM, type LabFiles } from './report-adapter';

export interface ElithIngestInput {
  diagnosticUserId: string;
  /** `report_text.json` の中身。dict なら elith-v2.0 / 配列なら旧 elith-v1.0。 */
  report: unknown | null;
  /** 検査値ファイル。ファイル別の入れ子 (`health_checkup` / `blood_test` / `cancer_risk`)。 */
  checkup: LabFiles | null;
  schemaVersion: string;
  /** 原本 PDF (任意)。保存済みのものを渡す。 */
  pdf?: { storageUrl: string; sha256: string; pages: number | null } | null;
  /**
   * 取り込み元の S3 フォルダ。**自動取り込みでは必ず渡す** —
   * これが二重取り込みの歯止め (部分 unique index)。手動は null。
   */
  sourceKey?: string | null;
  /** 受領時刻。既定は now。 */
  receivedAt?: string;
}

export interface ElithIngestResult {
  ok: boolean;
  id: string | null;
  /** 既に同じ材料から取り込み済みだった (何もしていない)。 */
  duplicate?: boolean;
  error?: string;
  detail?: string;
  ingested?: {
    sections: number;
    section_names: string[];
    wellness_age: unknown;
    measurements: number;
    references: number;
    topics: number;
    digest_cards: string[];
    empty_cards: string[];
  };
  /** アダプタが拾った異常 (黙って空になったときの手がかり)。 */
  warnings?: string[];
}

/** PostgREST の一意制約違反。二重取り込みを**失敗でなく「済み」**として扱うため。 */
const UNIQUE_VIOLATION = '23505';

type Db = { from: (t: string) => any };

export async function ingestElithReport(
  sb: { schema: (s: string) => unknown },
  input: ElithIngestInput,
): Promise<ElithIngestResult> {
  const db = sb.schema('diagnosis') as unknown as Db;
  const receivedAt = input.receivedAt ?? new Date().toISOString();

  /*
   * **同じフォルダを二度取り込まない。** 先に見ておく。
   * (index でも止まるが、止まってから気づくと「既存行を superseded にした後」で、
   *  最新 1 件が消えたように見える。superseded を撃つ前に返す。)
   */
  if (input.sourceKey) {
    const { data: dup } = await db
      .from('diagnosis_results')
      .select('id')
      .eq('source_key', input.sourceKey)
      .maybeSingle();
    if (dup?.id) return { ok: true, id: String(dup.id), duplicate: true };
  }

  // 世代管理 (暫定): 既存の同ユーザー行を superseded に落としてから新しい行を足す。
  const { error: supErr } = await db
    .from('diagnosis_results')
    .update({ status: 'superseded' })
    .eq('diagnostic_user_id', input.diagnosticUserId)
    .neq('status', 'superseded');
  if (supErr) return { ok: false, id: null, error: 'db_failed', detail: supErr.message };

  const { data, error } = await db
    .from('diagnosis_results')
    .insert({
      diagnostic_user_id:     input.diagnosticUserId,
      diagnostic_id:          crypto.randomUUID(),
      report:                 input.report,
      checkup_values:         input.checkup,
      schema_version:         input.schemaVersion,
      status:                 'received',
      received_at:            receivedAt,
      source_key:             input.sourceKey ?? null,
      report_pdf_url:         input.pdf?.storageUrl ?? null,
      report_pdf_sha256:      input.pdf?.sha256 ?? null,
      report_pdf_pages:       input.pdf?.pages ?? null,
      report_pdf_received_at: input.pdf ? receivedAt : null,
    })
    .select('id')
    .single();

  if (error) {
    // 競合して同時に 2 回走った場合。**失敗にしない** (結果として 1 件入っている)。
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      return { ok: true, id: null, duplicate: true };
    }
    return { ok: false, id: null, error: 'db_failed', detail: error.message };
  }

  /*
   * 取り込めた中身を**表示と同じアダプタで数えて**返す。
   * 別の数え方をすると「取り込めたつもりで画面が空」を検知できない (spec §1.3.6)。
   */
  const vm = buildReportVM({
    reportText: input.report, checkup: input.checkup, name: '', issuedOn: receivedAt.slice(0, 10),
    isSample: false, hasCancerRisk: false, cycleSeq: null, chronologicalAge: null,
  });

  return {
    ok: true,
    id: data?.id ? String(data.id) : null,
    ingested: {
      sections: vm.audit.sections.length,
      section_names: vm.audit.sections,
      wellness_age: vm.cover.wellnessAge,
      measurements: vm.audit.measurementCount,
      references: vm.audit.referenceCount,
      topics: vm.audit.topicCount,
      digest_cards: vm.audit.digestCards,
      empty_cards: vm.audit.emptyCards,
    },
    warnings: vm.audit.anomalies,
  };
}
