/**
 * 検査値の永続化 (案A-3 の書き込み口)。
 *
 * 【この関数が唯一の書き込み経路】
 *   ① test_artifacts.measurements (jsonb) … 原本忠実の全記録
 *   ② diagnosis.measurement_values        … 時系列グラフ用の正規化層
 *   の両方を、同じ入力から一度に書く。片方だけ書ける口を作らない。
 *
 * 【入力の前提】
 *   渡す measurements は **sanitizeMeasurementsForDelivery() を通した後**の
 *   lean measurement (name / value / value_num / unit / ref_low / ref_high / flag)。
 *   CLAUDE.md「納品整形は決定論プログラムに集約」に従い、ここで整形はしない。
 *
 * 【再取込】artifact 単位で delete → insert する (総入れ替え)。
 *   seq を採番し直すため、部分更新はしない。
 *
 * 【顧客割当】measurement_values.diagnostic_user_id は artifact の値を複製する。
 *   Workflow 1 (顧客自動紐付け) で artifact の割当を変えるときは、
 *   本表の diagnostic_user_id も併せて更新すること。
 */

import { findByAlias } from './standard-master';
import { alaIndexValueNum, isAlaIndexName } from './ala-pds';

/**
 * 受け取る Supabase クライアント。
 * このアプリのクライアントは customer / diagnosis スキーマ付きで型付けされており、
 * 既定の SupabaseClient<any,'public'> とは互換にならない。書き込み対象は
 * diagnosis スキーマの 2 表だけなので、必要な最小の形だけを要求する。
 */
export interface SchemaClient {
  schema(name: string): {
    from(table: string): {
      update(values: Record<string, unknown>): { eq(col: string, val: string): PromiseLike<{ error: { message: string } | null }> };
      delete(): { eq(col: string, val: string): PromiseLike<{ error: { message: string } | null }> };
      insert(rows: Record<string, unknown>[]): PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

/** sanitizeMeasurementsForDelivery() の出力 1 件分。 */
export interface LeanMeasurement {
  name?: string | null;
  value?: string | null;
  value_num?: number | null;
  unit?: string | null;
  ref_low?: string | null;
  ref_high?: string | null;
  flag?: string | null;
  assessment?: string | null;
}

export interface PersistInput {
  artifactId: string;
  diagnosticUserId: string;
  testType: string;
  testDate: string | null;
  measurements: LeanMeasurement[];
  /** 由来 (raw_csv / scan_md 等)。監査用。 */
  sourceFileKind?: string | null;
}

export interface PersistResult {
  rows: number;
  /** 標準マスタに載っていて canonical_name を付けられた件数。 */
  mapped: number;
}

/** "7.0" / "7.0 以下" → 7.0 (数値化できなければ null)。基準線の描画にだけ使う。 */
export function refToNum(v: string | null | undefined): number | null {
  if (v == null) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(String(v).replace(/,/g, ''));
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

const FLAG = (v: unknown): 'H' | 'L' | null => (v === 'H' || v === 'L' ? v : null);

/**
 * **数値化できた値だけを返す。** 基本は `m.value_num` をそのまま使う。
 *
 * 例外は がんリスク検査 ALA-PDS の **「インデックス値」** だけ。検査票は 0〜8 の
 * スケールを **`"0.9 / 8.0"` の分数**で印字するため、`toValueNum()`
 * (`elith-export.ts:190`・スラッシュ混じりは null) を通ると `value_num` が付かず、
 * **推移グラフに点が 1 つも乗らない**。分子は印字された実測値そのものなので、
 * ここで補うのは捏造ではない。**`value`（原本表記）は書き換えない。**
 *
 * - 完全一致の項目名 (`isAlaIndexName`) ＋ `test_type='cancer_urine'` のときだけ。
 * - 既に `value_num` が付いていればそちらが勝つ（上書きしない）。
 * - **Elith 納品の出力は変わらない** — `normalizeCancerRisk()`
 *   (`cancer-risk-fix.ts:44-50`) が同じ分数を既に 0.9 へ正規化しているため。
 */
function valueNumOf(m: LeanMeasurement, testType: string): number | null {
  if (typeof m.value_num === 'number' && Number.isFinite(m.value_num)) return m.value_num;
  if (testType === 'cancer_urine' && isAlaIndexName(m.name)) return alaIndexValueNum(m.value);
  return null;
}

export async function persistMeasurements(
  sb: SchemaClient,
  input: PersistInput,
): Promise<PersistResult> {
  const lean = input.measurements.filter((m) => typeof m.name === 'string' && m.name.trim() !== '');

  // ① 原本忠実の全記録
  const { error: upErr } = await sb
    .schema('diagnosis')
    .from('test_artifacts')
    .update({ measurements: lean })
    .eq('id', input.artifactId);
  if (upErr) throw new Error(`measurements(jsonb) の保存に失敗: ${upErr.message}`);

  // ② 正規化層 — artifact 単位で総入れ替え
  const { error: delErr } = await sb
    .schema('diagnosis')
    .from('measurement_values')
    .delete()
    .eq('artifact_id', input.artifactId);
  if (delErr) throw new Error(`measurement_values の削除に失敗: ${delErr.message}`);

  let mapped = 0;
  const rows = lean.map((m, seq) => {
    const name = String(m.name);
    // 標準マスタに完全一致したときだけ概念 ID を付ける。
    // 非ヒットは null のまま (当て推量で埋めない = 捏造ゼロ)。
    const hit = findByAlias(name);
    if (hit) mapped += 1;
    return {
      artifact_id: input.artifactId,
      diagnostic_user_id: input.diagnosticUserId,
      test_type: input.testType,
      test_date: input.testDate,
      seq,
      item_name: name,
      canonical_name: hit?.canonical_name ?? null,
      value: m.value ?? null,
      value_num: valueNumOf(m, input.testType),
      unit: m.unit ?? null,
      ref_low: m.ref_low ?? null,
      ref_high: m.ref_high ?? null,
      ref_low_num: refToNum(m.ref_low),
      ref_high_num: refToNum(m.ref_high),
      flag: FLAG(m.flag),
      assessment: m.assessment ?? null,
      source_file_kind: input.sourceFileKind ?? null,
    };
  });

  if (rows.length > 0) {
    const { error: insErr } = await sb
      .schema('diagnosis')
      .from('measurement_values')
      .insert(rows);
    if (insErr) throw new Error(`measurement_values の保存に失敗: ${insErr.message}`);
  }

  return { rows: rows.length, mapped };
}
