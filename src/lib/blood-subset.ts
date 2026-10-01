/**
 * 人間ドック・健康診断由来の **血液検査サブセット（15 項目）** の抽出と、派生データの識別。
 *
 * 正本: `docs/specs/healthcheckup_blood_extraction_spec_20261001.md`（v2.0・発注者裁定 Q-1〜Q-14 反映済み）
 * 業務仕様: Wellfort「人間ドック・健康診断由来 血液検査データ連携仕様書 v1.1」2026-10-01
 *
 * 【このモジュールがやること】
 *   ① `sanitizeMeasurementsForDelivery()` が返した lean measurement から **15 項目だけ**を選ぶ
 *   ② 空腹時/随時 の中性脂肪を **派生データの中だけ**で `中性脂肪` へ寄せる（spec §5.4）
 *   ③ 同一項目に **確定できない複数の値**があれば、**その項目だけ**落とす（裁定 Q-12）
 *
 * 【このモジュールが絶対にやらないこと】
 *   - **AI スキャン／OCR／LLM を呼ばない。** 入力は既に読み取り済みの measurement だけ（v1.1 §3）。
 *   - **値を作らない・計算しない・推定しない。** eGFR をクレアチニンから出す等は禁止（v1.1 §12）。
 *   - **欠損を 0 で埋めない。** 無い項目は**行ごと出さない**（spec §6.1）。
 *   - **元の HealthCheckupData を書き換えない。** 入力配列は読むだけ（spec §5.4）。
 *   - **項目数で成立判定しない。** 1 件でもあればその項目だけで作る（spec §6.2）。
 */

import { findByAlias } from './standard-master';

/**
 * 派生 blood artifact の印。**既存列 `diagnosis.test_artifacts.imported_by` に入れる**
 * （`text not null`・CHECK 無し → **DB migration 不要**。spec §4.3 / §9.2）。
 *
 * **`source='user_upload'` を識別子にしない**（発注者裁定 Q-4）。将来「利用者が血液検査の紙を
 * スキャンする」経路ができたとき、それまで巻き込んで Elith の readiness から外してしまうため。
 * **除外も冪等キーも、この値の完全一致 1 本で行う。**
 */
export const DERIVED_HC_BLOOD_IMPORTED_BY = 'derived_healthcheck_blood';

/** 派生データであることを画面へ運ぶときの値（`MetricTrendPoint.source`）。 */
export const DERIVED_HC_BLOOD_SOURCE = 'health_checkup_scan';

/** 利用者画面に出す由来の文言（発注者裁定 Q-7・v1.1 §11 C1）。**変えない。** */
export const DERIVED_HC_BLOOD_LABEL = '人間ドックから抽出';

/**
 * 対象 15 項目。**`standard-master.ts` の `canonical_name` で突合する。**
 *
 * 業務仕様 v1.1 §4 の 15 項目と 1:1。**ここに項目を足さない**（v1.1 §12 の禁止事項）。
 * 並びは v1.1 §4 の掲載順（肝機能 → 脂質 → 糖 → 腎）。
 * **出力もこの順に固定する** — 読み取りの行順に依存させると、同じ検査票でも run ごとに
 * `seq` が変わって冪等でなくなるため。
 */
export const BLOOD_SUBSET_ITEMS = [
  // 肝機能
  'GOT(AST)',          // 1. AST（GOT）
  'GPT(ALT)',          // 2. ALT（GPT）
  'γ-GTP',             // 3. γ-GTP
  '総蛋白',            // 4. 総蛋白（TP）
  'アルブミン',        // 5. アルブミン（Alb）
  // 脂質代謝
  'LDLコレステロール', // 6. LDLコレステロール
  'HDLコレステロール', // 7. HDLコレステロール
  '総コレステロール',  // 8. 総コレステロール
  '中性脂肪',          // 9. 中性脂肪（TG）
  // 血糖・糖代謝
  '空腹時血糖',        // 10. 空腹時血糖
  'HbA1c(NGSP)',       // 11. HbA1c
  // 腎機能等
  'クレアチニン',      // 12. クレアチニン
  'eGFR',              // 13. eGFR
  '尿酸',              // 14. 尿酸（UA）
  '尿素窒素',          // 15. 尿素窒素（BUN）
] as const;

export type BloodSubsetItem = (typeof BLOOD_SUBSET_ITEMS)[number];

const TARGET_SET: ReadonlySet<string> = new Set<string>(BLOOD_SUBSET_ITEMS);

/**
 * **派生 BloodTestData の中だけ**で `中性脂肪` へ寄せる元の canonical_name（発注者裁定 Q-3）。
 *
 * - `STANDARD_MASTER` では `空腹時中性脂肪` / `随時中性脂肪` / `中性脂肪` は**別項目のまま**。
 *   グローバルな alias にすると `HealthCheckupData` 側の名寄せまで変わってしまう。
 * - ここは「デメカル血液検査と同じ 1 本の時系列に並べるための派生表示」の写像であって、
 *   元データの意味を書き換える処理ではない（発注者判断）。
 * - **`空腹時血糖` には同じことをしない。** `血糖` / `随時血糖` は 15 項目の対象外のまま
 *   （v1.1 §5「『血糖』とだけ記載され空腹時と確認できない値を推測マッピングしない」）。
 */
const TG_MERGE_SOURCES: ReadonlySet<string> = new Set(['空腹時中性脂肪', '随時中性脂肪']);

/** `sanitizeMeasurementsForDelivery()` の出力 1 件分（`elith-export.ts` の `leanMeasurement`）。 */
export interface LeanRow {
  name?: string | null;
  value?: string | null;
  value_num?: number | null;
  unit?: string | null;
  ref_low?: string | null;
  ref_high?: string | null;
  flag?: string | null;
}

/** 落とした項目の記録。**黙って消さない**ための監査（spec §11 E-9）。 */
export interface BloodSubsetExclusion {
  /** 対象 15 項目側の名前。 */
  item: string;
  reason: 'value_conflict';
  /** 競合した値（原本表記）。**どちらも採らない。** */
  values: string[];
}

export interface BloodSubsetResult {
  /** 派生 `BloodTestData` / `measurement_values` に入れる行。`name` は 15 項目側の名前。 */
  kept: LeanRow[];
  /** 確定できずに落とした項目（裁定 Q-12）。 */
  excluded: BloodSubsetExclusion[];
}

/** 値の同一性。`value_num` があればそれで、無ければ原本表記の trim 一致で見る。 */
function sameValue(a: LeanRow, b: LeanRow): boolean {
  const an = typeof a.value_num === 'number' && Number.isFinite(a.value_num) ? a.value_num : null;
  const bn = typeof b.value_num === 'number' && Number.isFinite(b.value_num) ? b.value_num : null;
  if (an !== null || bn !== null) return an === bn;
  return String(a.value ?? '').trim() === String(b.value ?? '').trim();
}

/**
 * 対象 15 項目へ寄せたときの名前を返す。対象外なら null。
 *
 * **完全一致のみ**（`findByAlias` の規律）。部分一致・前方一致はしない＝誤マップ（捏造）の防止。
 */
export function bloodSubsetNameOf(rawName: string | null | undefined): BloodSubsetItem | null {
  const hit = findByAlias(rawName);
  if (!hit) return null;
  const canonical = hit.canonical_name;
  // 空腹時/随時 の中性脂肪は、**この派生データの中だけ**で `中性脂肪` に寄せる（裁定 Q-3）。
  const mapped = TG_MERGE_SOURCES.has(canonical) ? '中性脂肪' : canonical;
  return TARGET_SET.has(mapped) ? (mapped as BloodSubsetItem) : null;
}

/**
 * lean measurements から **対象 15 項目だけ**を取り出す。
 *
 * - **値を変えない。** 書き換えるのは `name` だけ（15 項目側の名前へ）。
 *   `value` / `value_num` / `unit` / `ref_low` / `ref_high` / `flag` は原本のまま運ぶ
 *   （基準値・H/L は検査票由来。アプリは判定しない＝ミッション④ / v1.1 §9）。
 * - **フィールドを増やさない。** 出力は `leanMeasurement` と同じ 7 つだけ（裁定 Q-9）。
 * - 同じ項目に**値が割れている**ときは、その項目だけ落として `excluded` に記録する（裁定 Q-12）。
 *   **推測で片方を選ばない。他の項目は通常どおり出す。**
 * - 0 件でも例外にしない。呼び出し側が「何も作らない」を選ぶ（spec §6.2・裁定 Q-6）。
 */
export function extractBloodSubset(rows: readonly LeanRow[] | null | undefined): BloodSubsetResult {
  const byItem = new Map<string, LeanRow[]>();
  for (const r of rows ?? []) {
    if (!r || typeof r !== 'object') continue;
    const item = bloodSubsetNameOf(r.name);
    if (!item) continue;
    // 値も数値も無い行は measurement ではない（sanitize 済みなら通常は来ない。保険）。
    if ((r.value == null || String(r.value).trim() === '') && r.value_num == null) continue;
    const list = byItem.get(item) ?? [];
    list.push(r);
    byItem.set(item, list);
  }

  const kept: LeanRow[] = [];
  const excluded: BloodSubsetExclusion[] = [];
  // 出力順は BLOOD_SUBSET_ITEMS 固定（読み取りの行順に依存させない＝冪等）。
  for (const item of BLOOD_SUBSET_ITEMS) {
    const list = byItem.get(item);
    if (!list || list.length === 0) continue;   // 無い項目は行ごと出さない（0 にしない）
    const head = list[0];
    const conflict = list.some((r) => !sameValue(head, r));
    if (conflict) {
      excluded.push({
        item,
        reason: 'value_conflict',
        values: list.map((r) => String(r.value ?? (r.value_num ?? ''))),
      });
      continue;                                  // **推測で片方を選ばない**（裁定 Q-12）
    }
    kept.push({
      name: item,
      value: head.value ?? null,
      value_num: typeof head.value_num === 'number' && Number.isFinite(head.value_num) ? head.value_num : null,
      unit: head.unit ?? null,
      ref_low: head.ref_low ?? null,
      ref_high: head.ref_high ?? null,
      flag: head.flag === 'H' || head.flag === 'L' ? head.flag : null,
    });
  }
  return { kept, excluded };
}

/* ────────────────────────────────────────────────────────────────
 * 同一受診日の優先（発注者裁定 Q-10 / D-5）
 *
 *   通常 blood が常に勝つ。「通常 blood」= test_type='blood' かつ
 *   imported_by !== DERIVED_HC_BLOOD_IMPORTED_BY の active 行。
 * ──────────────────────────────────────────────────────────────── */

/**
 * 受け取る Supabase クライアント。**このモジュールは `supabase.ts` を import しない**
 * （純ロジック部分をサーバ無しで検査できるようにするため）。必要な形だけを構造的に要求する。
 */
export interface MinimalDiagnosisClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema(name: 'diagnosis'): any;
}

/** その日に **通常の** blood artifact（派生でない active 行）が在るか。 */
export async function hasNormalBloodOnDate(
  sb: MinimalDiagnosisClient,
  diagnosticUserId: string,
  testDate: string,
): Promise<boolean> {
  try {
    const { data } = await sb
      .schema('diagnosis')
      .from('test_artifacts')
      .select('id, imported_by')
      .eq('diagnostic_user_id', diagnosticUserId)
      .eq('test_type', 'blood')
      .eq('test_date', testDate)
      .eq('status', 'active');
    const rows = (data ?? []) as { id: string; imported_by: string | null }[];
    return rows.some((r) => r.imported_by !== DERIVED_HC_BLOOD_IMPORTED_BY);
  } catch {
    // 引けないときは **作らない方へ倒す**（通常 blood を上書きする事故より、
    // 派生が 1 回出ないほうが軽い。次のスキャン送信・backfill で回復できる）。
    return true;
  }
}

/**
 * **通常 blood が後から届いたとき**に、同じ受診日の派生を `superseded` へ落とす（裁定 Q-10）。
 *
 * - **削除しない**（監査のため残す）。`measurement_values` は artifact の status で
 *   読み分けられる（`measurement-queries.ts` の `activeArtifactIds`）ので、グラフからは消える。
 * - **触るのは `imported_by = DERIVED_HC_BLOOD_IMPORTED_BY` の行だけ。**
 *   通常 blood の行には一切触らない。
 * - **投げない。** 失敗しても通常 blood の取り込みは成功のまま返す（既存の fail-safe の流儀）。
 */
export async function supersedeDerivedBloodOnSameDate(
  sb: MinimalDiagnosisClient,
  diagnosticUserId: string,
  testDate: string | null | undefined,
  /** 除外したい artifact（通常 blood 側の行。自分を落とさないための保険）。 */
  opts?: { exceptArtifactId?: string },
): Promise<{ superseded: number }> {
  if (!testDate || !/^\d{4}-\d{2}-\d{2}$/.test(testDate)) return { superseded: 0 };
  try {
    const { data } = await sb
      .schema('diagnosis')
      .from('test_artifacts')
      .select('id')
      .eq('diagnostic_user_id', diagnosticUserId)
      .eq('test_type', 'blood')
      .eq('test_date', testDate)
      .eq('status', 'active')
      .eq('imported_by', DERIVED_HC_BLOOD_IMPORTED_BY);
    const ids = ((data ?? []) as { id: string }[])
      .map((r) => r.id)
      .filter((id) => id !== opts?.exceptArtifactId);
    if (ids.length === 0) return { superseded: 0 };
    await sb
      .schema('diagnosis')
      .from('test_artifacts')
      .update({ status: 'superseded' })
      .in('id', ids);
    return { superseded: ids.length };
  } catch (e) {
    console.error('[blood-subset] 派生 blood の supersede に失敗 (取り込みは継続):',
      e instanceof Error ? e.message : e);
    return { superseded: 0 };
  }
}
