/**
 * 外部検査ID の**登録**（撮影台帳への記録 ＋ `customer.lab_tests` への紐付け）。
 *
 * 正本: `docs/lab/kit_receipt_external_id_capture_spec.md` §6.3 / §8。
 * 紐付け方式は **案A（登録時に `lab_tests` 行を作る）** ＝ 発注者裁定 2026-10-11。
 *
 * 【案A を選んだ前提と、そこから出てくる制約】
 * `customer.lab_tests` は**行を作るコードがどこにも無かった**（SELECT は
 * `src/lib/chat-context.ts:79-80` の 1 か所だけ・実測 grep）。だから「登録時に作る」。
 * ただし本番の形がそのまま使えないので、材料は**その場で引き直す**:
 *
 *   - `lab_company_id` (NOT NULL FK) … 本番の shipment は **`lab_company_id: ''`**
 *     （`bridge-queries.ts:75` — app_bridge は検査会社を持たない）。
 *     → `customer.lab_companies.test_types` に当該 `test_type` を含む行から引く。
 *   - `customer_id` (NOT NULL FK → customer_profiles) … 本番の shipment の
 *     `customer_id` は実は **`diagnostic_user_id`**（`bridge-queries.ts:74`）。
 *     → `customer.customer_profiles` を `diagnostic_user_id` で引き直す。
 *   - `shipment_id` (FK → customer.kit_shipments) … 本番の受取 ID は
 *     **`orders.id`** で `customer.kit_shipments` に**存在しない**。
 *     → **その ID で実在を確かめた時だけ入れる。無ければ NULL**（列は nullable）。
 *       ここを埋めに行くと本番で必ず FK 違反になる。
 *
 * 【材料が揃わなくても撮影を落とさない】
 * `customer_profiles` / `lab_companies` の行が無い環境では `lab_tests` を作れない。
 * そのとき**登録ごと失敗させない** — 台帳には必ず記録し、
 * `lab_test_link_status='deferred'` と理由を残す。「サイレント脱落ゼロ」の方を採る。
 * 黙って成功を装うのではなく、**どこまでできたかを返す**。
 *
 * 【重複は自動で上書きしない】
 * 同じ値が別の検査に既に在れば `conflict` にして `lab_tests` は触らない（仕様 §8.2）。
 * ユーザーには一般化したエラーを返す（他人の検査の存在を漏らさない）。
 *
 * 【既存の `lab_tests` 行を使い回すのは「同じ回の撮り直し」だけ（発注者指示 2026-10-11）】
 * **`(diagnostic_user_id, test_type)` で引いた既存行を「今回の検査」とみなしてはいけない。**
 * プリベントは年 1 回 → 2 年目の撮影で前年の行が 1 件だけヒットし、
 * **前年の `external_barcode` を今年の値で上書きする**（前年の結果PDF が辿れなくなる）。
 * 使い回すのは**同じ `(diagnostic_user_id, shipment_ref, provider)` の台帳行が
 * 既に持っている `lab_test_id`** だけ。それが無ければ**今回用の行を新しく作る**。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types/supabase';
import {
  PROVIDER_ID_COLUMN, PROVIDER_ID_KIND, PROVIDER_TEST_TYPE,
  maskExternalId, type CaptureMethod, type CaptureStatus, type DecodeMethod,
  type ExternalIdProvider, type LabTestLinkStatus, type ReviewReason,
} from './external-test-id';

/** 1 行ぶんの台帳レコード（返す形）。**外部IDの全文は入れない。** */
export interface CaptureRecord {
  id: string;
  provider: ExternalIdProvider;
  status: CaptureStatus;
  masked: string;
  reviewReasons: ReviewReason[];
  labTestId: string | null;
  labTestLinkStatus: LabTestLinkStatus;
  labTestLinkDetail: string | null;
}

export type PersistResult =
  | { ok: true; record: CaptureRecord; duplicate: false }
  | { ok: false; status: number; error: string; detail: string };

export interface PersistInput {
  sb: SupabaseClient<Database>;
  diagnosticUserId: string;
  /** 受取確認の対象 ID（dev=`kit_shipments.id` / 本番=`orders.id`）。 */
  shipmentRef: string;
  provider: ExternalIdProvider;
  testType: string;
  value: string;
  status: CaptureStatus;
  captureMethod: CaptureMethod;
  decodeMethod: DecodeMethod;
  reviewReasons: ReviewReason[];
  evidenceKey: string | null;
  /** 既存の登録を**上書きする**ときの監査情報（通常のユーザー操作では使わない）。 */
  correction?: { by: string; reason: string } | null;
}

type Row = Record<string, unknown>;

const TABLE = 'lab_test_id_captures';

/**
 * 台帳へ記録し、可能なら `lab_tests` へ紐付ける。
 *
 * 処理順（**失敗したら前の段を巻き戻さず、どこまで進んだかを残す**）:
 *   1. 同じ値が**別の検査**に在るか見る → 在れば `conflict` で確定し `lab_tests` は触らない
 *   2. 既に有効な撮影行があるか見る（二重 submit / 撮り直し）。
 *      **ここで引いた `lab_test_id` が、行を使い回してよい唯一の根拠。**
 *   3. `lab_tests` の行を確定（2 の `lab_test_id` があれば更新・無ければ新規作成）
 *   4. 台帳へ upsert（旧行は `superseded` に落とす）
 */
export async function persistExternalIdCapture(input: PersistInput): Promise<PersistResult> {
  const {
    sb, diagnosticUserId, shipmentRef, provider, testType, value,
    captureMethod, decodeMethod, evidenceKey,
  } = input;

  const cust = sb.schema('customer');
  const reasons = [...input.reviewReasons];
  let status: CaptureStatus = input.status;

  // ── 1) 同じ値が別の検査に在るか ───────────────────────────────────
  // **一意制約に頼らない**（prevent は `external_barcode` に unique が無い）。
  const dup = await cust
    .from(TABLE)
    .select('id, diagnostic_user_id, shipment_ref')
    .eq('provider', provider)
    .eq('normalized_value', value)
    .neq('status', 'superseded');
  if (dup.error) {
    return { ok: false, status: 503, error: 'ledger_unavailable', detail: dup.error.message };
  }
  const foreign = (dup.data ?? []).filter(
    (r) => (r as Row).diagnostic_user_id !== diagnosticUserId || (r as Row).shipment_ref !== shipmentRef,
  );

  let linkStatus: LabTestLinkStatus = 'deferred';
  let linkDetail: string | null = null;
  let labTestId: string | null = null;

  // ── 2) 同じ回（この人・この受取・この provider）の有効な撮影行 ──────
  // **`lab_tests` の行を使い回してよいかは、ここで引いた `lab_test_id` だけが決める。**
  // `(diagnostic_user_id, test_type)` で既存行を探してはいけない
  // （年 1 回の検査では前年の行が 1 件ヒットし、前年の外部IDを上書きする）。
  const prior = await cust
    .from(TABLE)
    .select('id, normalized_value, lab_test_id')
    .eq('diagnostic_user_id', diagnosticUserId)
    .eq('shipment_ref', shipmentRef)
    .eq('provider', provider)
    .neq('status', 'superseded')
    .maybeSingle();
  if (prior.error) {
    return { ok: false, status: 503, error: 'ledger_unavailable', detail: prior.error.message };
  }

  const priorRow = prior.data as Row | null;
  const priorLabTestIdRaw = priorRow?.lab_test_id;
  const priorLabTestId = typeof priorLabTestIdRaw === 'string' && priorLabTestIdRaw
    ? priorLabTestIdRaw
    : null;

  if (foreign.length > 0) {
    // **自動上書き禁止。** `lab_tests` は 1 バイトも触らない。
    linkStatus = 'conflict';
    linkDetail = `同じ外部IDが他の検査に ${foreign.length} 件登録されています (自動では紐付けません)`;
    status = 'review_required';
    // **既に紐づいていた `lab_test_id` は消さない**（admin が追う手がかりを失わない）。
    // ゲートは `lab_test_link_status === 'linked'` を要求するので、
    // `lab_test_id` が残っていても **`conflict` の回は通らない**（§7.1）。
    labTestId = priorLabTestId;
    if (!reasons.includes('pattern_mismatch')) { /* 理由コードは増やさない */ }
  } else {
    // ── 3) lab_tests の行を確定（案A） ──────────────────────────────
    const link = await linkLabTest({
      sb, diagnosticUserId, shipmentRef, provider, testType, value,
      existingLabTestId: priorLabTestId,
    });
    linkStatus = link.linkStatus;
    linkDetail = link.detail;
    labTestId = link.labTestId;
    if (link.linkStatus !== 'linked') status = 'review_required';
  }

  // ── 4) 旧行を superseded に落として入れ直す ──────────────────────
  if (priorRow) {
    const priorValue = String(priorRow.normalized_value ?? '');
    // **同じ値の再送はそのまま成功扱い**（二重 submit で行が増えない・仕様 §6.3）。
    if (priorValue === value && !input.correction) {
      const upd = await cust
        .from(TABLE)
        .update({
          status, review_reasons: reasons,
          lab_test_id: labTestId, lab_test_link_status: linkStatus, lab_test_link_detail: linkDetail,
          confirmed_at: new Date().toISOString(),
        })
        .eq('id', priorRow.id as string)
        .select('id')
        .maybeSingle();
      if (upd.error) {
        return { ok: false, status: 503, error: 'ledger_write_failed', detail: upd.error.message };
      }
      return {
        ok: true, duplicate: false,
        record: toRecord(String(priorRow.id), provider, status, value, reasons, labTestId, linkStatus, linkDetail),
      };
    }
    // 値が変わる = 撮り直し / 訂正。旧行は消さずに superseded へ。
    const sup = await cust
      .from(TABLE)
      .update({ status: 'superseded' })
      .eq('id', priorRow.id as string);
    if (sup.error) {
      return { ok: false, status: 503, error: 'ledger_write_failed', detail: sup.error.message };
    }
  }

  const now = new Date().toISOString();
  const ins = await cust
    .from(TABLE)
    .insert({
      diagnostic_user_id: diagnosticUserId,
      shipment_ref: shipmentRef,
      provider,
      test_type: testType,
      id_kind: PROVIDER_ID_KIND[provider],
      normalized_value: value,
      capture_method: captureMethod,
      decode_method: decodeMethod,
      review_reasons: reasons,
      evidence_key: evidenceKey,
      status,
      lab_test_id: labTestId,
      lab_test_link_status: linkStatus,
      lab_test_link_detail: linkDetail,
      captured_at: now,
      confirmed_at: now,
      previous_value: priorRow ? String(priorRow.normalized_value ?? '') : null,
      corrected_at: input.correction ? now : null,
      corrected_by: input.correction?.by ?? null,
      correction_reason: input.correction?.reason ?? null,
    })
    .select('id')
    .maybeSingle();
  if (ins.error || !ins.data) {
    return {
      ok: false, status: 503, error: 'ledger_write_failed',
      detail: ins.error?.message ?? '台帳へ書けませんでした',
    };
  }

  return {
    ok: true, duplicate: false,
    record: toRecord(String((ins.data as Row).id), provider, status, value, reasons, labTestId, linkStatus, linkDetail),
  };
}

function toRecord(
  id: string, provider: ExternalIdProvider, status: CaptureStatus, value: string,
  reasons: ReviewReason[], labTestId: string | null,
  linkStatus: LabTestLinkStatus, linkDetail: string | null,
): CaptureRecord {
  return {
    id, provider, status,
    masked: maskExternalId(value),
    reviewReasons: reasons,
    labTestId,
    labTestLinkStatus: linkStatus,
    labTestLinkDetail: linkDetail,
  };
}

interface LinkResult {
  labTestId: string | null;
  linkStatus: 'linked' | 'deferred';
  detail: string | null;
}

/**
 * **案A の本体** — `customer.lab_tests` の行を確定して外部IDを入れる。
 *
 * 【行を使い回す条件は 1 つだけ】
 * `existingLabTestId`（= 同じ `(diagnostic_user_id, shipment_ref, provider)` の台帳行が
 * 既に持っている `lab_test_id`）が在るときだけ、その行を更新する
 * ＝ **同じ回の撮り直し／二重 submit**。それ以外は**今回用の行を新しく作る**。
 *
 * **`(diagnostic_user_id, test_type)` で既存行を探す実装に戻してはいけない**
 * （発注者指示 2026-10-11）。プリベントは年 1 回なので、2 年目の撮影で
 * 前年の行が 1 件だけヒットし、**前年の `external_barcode` を今年の値で上書きする**。
 * 前年の結果PDF を辿るキーが消え、しかも画面も台帳も `linked` と表示するので**黙って壊れる**。
 * 「1 件だからこれだろう」は推測であって、今回の検査である根拠ではない。
 *
 * 【材料が揃わなければ作らず `deferred`】撮影は台帳に残るので失わない。
 *
 * 【申し送り】③-1（出荷時に `lab_tests` 行を作る）が実装されたら、
 * 初回撮影でも**出荷側が作った行**を使うべきで、ここで常に新規作成すると二重になる。
 * その突き合わせ方（`shipment_id` か別のキーか）は**仕様に無いので作らない**
 * （仕様 §12 の確認事項）。今は「新規作成」で一貫させ、重複は admin が見る。
 */
async function linkLabTest(args: {
  sb: SupabaseClient<Database>;
  diagnosticUserId: string;
  shipmentRef: string;
  provider: ExternalIdProvider;
  testType: string;
  value: string;
  /** 同じ回の台帳行が既に持っている `lab_tests.id`（無ければ null）。 */
  existingLabTestId: string | null;
}): Promise<LinkResult> {
  const cust = args.sb.schema('customer');
  /**
   * どの列へ入れるか。**計算キー `{ [column]: value }` にしない** —
   * Supabase の型が index signature を弾くだけでなく、**列名を取り違えても型で気づけない**。
   * `external_barcode`(物理キットID) と `external_test_id`(外部照会ID) は別物なので、
   * ここは明示的に分ける (仕様 §6.2)。
   */
  const idPatch = (v: string): { external_barcode: string } | { external_test_id: string } =>
    PROVIDER_ID_COLUMN[args.provider] === 'external_barcode'
      ? { external_barcode: v }
      : { external_test_id: v };

  // ── 同じ回の撮り直し = 既に紐づいている行を更新する ─────────────────
  if (args.existingLabTestId) {
    // **実在を確かめてから更新する。** 行が消えていたら（`on delete set null` は
    // 台帳側にしか効かない）更新が 0 行で静かに成功したように見えるため。
    const cur = await cust
      .from('lab_tests')
      .select('id')
      .eq('id', args.existingLabTestId)
      .maybeSingle();
    if (cur.error) {
      return { labTestId: null, linkStatus: 'deferred', detail: `lab_tests 照会に失敗: ${cur.error.message}` };
    }
    if (cur.data) {
      const upd = await cust
        .from('lab_tests')
        .update(idPatch(args.value))
        .eq('id', args.existingLabTestId);
      if (upd.error) {
        return { labTestId: null, linkStatus: 'deferred', detail: `lab_tests 更新に失敗: ${upd.error.message}` };
      }
      return { labTestId: args.existingLabTestId, linkStatus: 'linked', detail: null };
    }
    // 行が無くなっている → 下で作り直す（黙って `linked` を装わない）。
  }

  // ── 新規作成。NOT NULL の材料を引き直す ──────────────────────────
  const prof = await cust
    .from('customer_profiles')
    .select('user_id')
    .eq('diagnostic_user_id', args.diagnosticUserId)
    .maybeSingle();
  if (prof.error) {
    return { labTestId: null, linkStatus: 'deferred', detail: `customer_profiles 照会に失敗: ${prof.error.message}` };
  }
  const customerIdRaw = (prof.data as Row | null)?.user_id;
  const customerId = typeof customerIdRaw === 'string' ? customerIdRaw : '';
  if (!customerId) {
    // **本番でここに来る可能性がある。** 撮影は台帳に残っているので失わない。
    return {
      labTestId: null, linkStatus: 'deferred',
      detail: 'customer_profiles に該当行が無いため lab_tests を作れません (撮影は台帳に記録済み)',
    };
  }

  const company = await cust
    .from('lab_companies')
    .select('id')
    .contains('test_types', [args.testType]);
  if (company.error) {
    return { labTestId: null, linkStatus: 'deferred', detail: `lab_companies 照会に失敗: ${company.error.message}` };
  }
  const companies = company.data ?? [];
  if (companies.length !== 1) {
    return {
      labTestId: null, linkStatus: 'deferred',
      detail: `test_type=${args.testType} に対応する lab_companies が ${companies.length} 件 (1 件でないので決められません)`,
    };
  }

  // `shipment_id` は **customer.kit_shipments に実在するときだけ**入れる。
  // 本番の受取 ID は orders.id なので普通は実在しない → NULL のままにする。
  const ship = await cust.from('kit_shipments').select('id').eq('id', args.shipmentRef).maybeSingle();
  const shipmentId = !ship.error && ship.data ? String((ship.data as Row).id) : null;

  const ins = await cust
    .from('lab_tests')
    .insert({
      shipment_id: shipmentId,
      customer_id: customerId,
      diagnostic_user_id: args.diagnosticUserId,
      lab_company_id: String((companies[0] as Row).id),
      test_type: args.testType,
      ...idPatch(args.value),
      status: 'pending',
      assigned_at: new Date().toISOString(),
      // 'auto_id' = 外部検査IDの一致で割り当てた、の意（DDL のコメント `:157`）。
      assigned_by: 'auto_id',
      notes: '受取時の外部ID撮影で作成 (kit_receipt_external_id_capture_spec)',
    })
    .select('id')
    .maybeSingle();
  if (ins.error || !ins.data) {
    return {
      labTestId: null, linkStatus: 'deferred',
      detail: `lab_tests 作成に失敗: ${ins.error?.message ?? '不明'}`,
    };
  }
  return { labTestId: String((ins.data as Row).id), linkStatus: 'linked', detail: null };
}

/**
 * プリベントの問診CSV 生成が参照する「**この回の**外部ID」を台帳から引く。
 * **ゲートの判定そのものは `checkPreventQuestionnaireGate()`**（純関数）で行う。
 *
 * 【「その人の最新」を返してはいけない（発注者指示 2026-10-11）】
 * 以前は `(diagnostic_user_id, provider)` を `captured_at desc limit 1` で引いていた。
 * これだと**前年の confirmed なレコード**が今年の回の問診CSV を通してしまう
 * （＝今年は未撮影なのに、前年の番号でプリベントへ出る）。
 * → **`shipmentRef` か `labTestId` のどちらかを必ず渡す**。どちらも無い呼び出しは
 * 型で弾き、実行時にも null を返す（fail-closed）。
 *
 * 返すのは**ゲートが必要とする 4 つ**。値だけを返すと、呼び側が
 * `status` / `lab_test_link_status` を見ずに通してしまえる（それが元の穴）。
 */
export interface CapturedExternalId {
  normalizedValue: string;
  status: CaptureStatus | string;
  labTestLinkStatus: LabTestLinkStatus | string;
  labTestId: string | null;
}

export type LoadCapturedArgs = {
  sb: SupabaseClient<Database>;
  diagnosticUserId: string;
  provider: ExternalIdProvider;
} & (
  /** 受取確認の対象 ID（dev=`kit_shipments.id` / 本番=`orders.id`）。 */
  | { shipmentRef: string; labTestId?: string | null }
  /** 既に確定している `customer.lab_tests.id`。 */
  | { labTestId: string; shipmentRef?: string | null }
);

export async function loadCapturedExternalId(
  args: LoadCapturedArgs,
): Promise<CapturedExternalId | null> {
  const shipmentRef = typeof args.shipmentRef === 'string' ? args.shipmentRef.trim() : '';
  const labTestId = typeof args.labTestId === 'string' ? args.labTestId.trim() : '';
  // **どちらも無ければ引かない。** 「人だけ」で引くと前年のレコードが混ざる。
  if (!shipmentRef && !labTestId) return null;

  let q = args.sb
    .schema('customer')
    .from(TABLE)
    .select('normalized_value, status, lab_test_id, lab_test_link_status')
    .eq('diagnostic_user_id', args.diagnosticUserId)
    .eq('provider', args.provider)
    .neq('status', 'superseded');
  // 両方あれば両方で絞る（取り違えを機械で防ぐ）。
  if (shipmentRef) q = q.eq('shipment_ref', shipmentRef);
  if (labTestId) q = q.eq('lab_test_id', labTestId);

  const r = await q.limit(2);
  if (r.error) return null;
  const rows = r.data ?? [];
  // 有効行は部分 unique 制約で 1 件のはずだが、**2 件見えたら選ばない**。
  if (rows.length !== 1) return null;

  const row = rows[0] as Row;
  const v = row.normalized_value;
  if (typeof v !== 'string' || !v) return null;
  const linkedId = row.lab_test_id;
  return {
    normalizedValue: v,
    status: String(row.status ?? ''),
    labTestLinkStatus: String(row.lab_test_link_status ?? ''),
    labTestId: typeof linkedId === 'string' && linkedId ? linkedId : null,
  };
}

/** provider に対応する `test_type`（API の整合検証で使う）。 */
export function expectedTestType(provider: ExternalIdProvider): string {
  return PROVIDER_TEST_TYPE[provider];
}

/**
 * **その人の「登録済み」の受取 ID を全部引く**（画面の表示だけに使う）。
 *
 * 用途は 2 つで、どちらも**出す / 出さないを決めるためだけ**:
 *   - 受取確認の撮影ブロックを「登録済み」の表示にするか（`/kit`）
 *   - **7 日ワーニングを出すか**（`barcodeReminders` の `registered`・仕様 §7.1）
 *
 * **`checkPreventQuestionnaireGate` の代わりにしない。** あちらは
 * 「この番号がこの検査のものだと確定したか」を見る fail-closed のゲートで、
 * **`status='confirmed'` ∧ `linked` を要求する**。ここは `superseded` でない行が
 * 在るかどうかだけを見る（**撮影が済んでいる人を急かさない**ため）。
 * 混ぜると「確定していない番号で先方へ出す」か「撮った人を催促し続ける」の
 * どちらかになる。
 */
export async function loadRegisteredCaptures(
  sb: SupabaseClient<Database>,
  diagnosticUserId: string,
): Promise<Map<string, { mask: string; needsReview: boolean }>> {
  const out = new Map<string, { mask: string; needsReview: boolean }>();
  const r = await sb
    .schema('customer')
    .from(TABLE)
    .select('shipment_ref, normalized_value, status')
    .eq('diagnostic_user_id', diagnosticUserId)
    .neq('status', 'superseded');
  if (r.error) return out;              // 引けなければ「未登録」と同じ扱い（催促が出るだけ）
  for (const row of r.data ?? []) {
    const ref = String((row as Row).shipment_ref ?? '');
    if (!ref) continue;
    out.set(ref, {
      // **全文は画面に出さない**（末尾 4 桁のマスクだけ）。
      mask: maskExternalId(String((row as Row).normalized_value ?? '')),
      needsReview: (row as Row).status !== 'confirmed',
    });
  }
  return out;
}
