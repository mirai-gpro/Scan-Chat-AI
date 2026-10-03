/**
 * 人間ドック・健康診断の既存スキャン結果から「血液検査 15 項目」を抽出する。
 *
 * 正本: `docs/specs/healthcheckup_blood_extraction_spec_20261001.md`
 * 業務仕様: Wellfort「人間ドック・健康診断由来 血液検査データ連携仕様書 v1.1 (2026-10-01)」
 *
 * ══════════════════════════════════════════════════════════════════
 * **このファイルは I/O を持たない純関数だけで構成する。**
 * ══════════════════════════════════════════════════════════════════
 * DB にも S3 にも触らない。Gemini も呼ばない。**再解析は一切しない** —
 * 入力は `saveScanResult` が既に作り終えた lean measurement
 * (`sanitizeMeasurementsForDelivery()` の出力) そのままで、
 * 同じ PDF をもう一度読むことは構造的に起こり得ない (v1.1 §3)。
 *
 * 【捏造ゼロ】
 *   - 無い項目は **行を作らない**。`null` の行も `0` の行も作らない (v1.1 §6 / §12)。
 *   - eGFR をクレアチニンから計算しない。総コレステロールを他の脂質から計算しない。
 *   - `血糖` / `随時血糖` を `空腹時血糖` へ**推測マッピングしない** (v1.1 §5)。
 *   - 一意に確定できない項目は**その項目だけ除外**し、理由を返す (裁定 Q-12)。
 *     推測で片方を選ばない。他の項目は通常どおり出す。
 *
 * 【15 項目が揃うことを条件にしない】(v1.1 §11 C3 / 裁定 Q-6)
 *   件数の閾値を書かない。領域 (肝/脂質/糖/腎) の数も数えない。
 *   **1 件でも取れればその項目だけで作る。0 件のときだけ何も作らない。**
 */

import { findByAlias } from './standard-master';
import type { LeanMeasurement } from './measurement-persist';

/**
 * 派生 blood であることの印。**`test_artifacts.imported_by` に入れる値**(裁定 D-2)。
 *
 * この 1 つの marker を 4 か所が見る:
 *   ① 冪等キー (`replaceSameDateArtifacts` の importedBy)
 *   ② Elith readiness の除外 (`elith-entitlement.ts`)
 *   ③ 同一日の優先 / supersede (`scan-persist.ts`)
 *   ④ グラフの「人間ドックから抽出」(`measurement-queries.ts`)
 *
 * **`source='user_upload'` を識別子にしない** (裁定 Q-4)。将来「利用者が血液検査の紙を
 * スキャンする」経路ができたとき、それまで巻き込んで readiness から外してしまう。
 * 判定は常に**この文字列の完全一致 1 本**で行う (前方一致・部分一致にしない)。
 */
export const DERIVED_HC_BLOOD_IMPORTED_BY = 'derived_healthcheck_blood';

/** 利用者画面に出す由来の文言。**変更しない** (v1.1 §11 C1 / 裁定 Q-7)。 */
export const DERIVED_HC_BLOOD_LABEL = '人間ドックから抽出';

/* ════════════════════════════════════════════════════════════════════
 * 【最上位ルール】派生 blood は **Dashboard 表示専用**。Elith の入力ではない。
 * ════════════════════════════════════════════════════════════════════
 * 発注者指示 2026-10-03 (§0 / §15 / §16)。
 *
 * **なぜ禁止か**: 人間ドック・健康診断の血液部分は、既に `HealthCheckupData` として
 * Elith の診断に使われている。それを `BloodTestData` として**もう一度**送ると
 * **同一検査情報の二重納品**になる。
 *
 *   通常の血液検査 (デメカル等) … Dashboard ＋ **Elith**
 *   人間ドック由来 派生 blood   … Dashboard **のみ**。Elith は**禁止**
 *
 * 「readiness に数えない」だけでは足りない。**JSON 生成・S3 配置・自動納品・cron 納品・
 * 手動納品・再納品・delivery assemble・manual mapping の全経路**から外す。
 *
 * 判定は**この関数 1 本**で行う (`imported_by` の完全一致。前方一致・部分一致にしない)。
 * 各経路がそれぞれ文字列比較を書くと、片方だけ直して静かに食い違う。
 */
export function isDerivedHealthcheckBlood(
  row: { test_type?: string | null; imported_by?: string | null } | null | undefined,
): boolean {
  if (!row) return false;
  // **blood 以外は対象外。** 他の検査種別の判定を 1 文字も変えないため。
  if (String(row.test_type ?? '') !== 'blood') return false;
  return String(row.imported_by ?? '') === DERIVED_HC_BLOOD_IMPORTED_BY;
}

/* ════════════════════════════════════════════════════════════════════
 * 派生 sibling の識別子 (2026-10-03 §8)
 * ════════════════════════════════════════════════════════════════════
 * 1 件の health_checkup に独立した入力グループ (「N枚目」) が複数あるとき、
 * **グループごとに派生 blood を 1 件**作る。その 2 件を区別する識別子。
 *
 * **既存列 `test_artifacts.external_test_id` に入れる。migration は要らない。**
 *   - `unique (diagnostic_user_id, source, test_type, test_date, external_test_id)`
 *     は **`external_test_id` が NULL だと効かない**ので、値を入れて初めて
 *     「同じ sibling を二重に作らない」が DB 側でも効く。
 *   - **親 artifact id ＋ グループ番号から決まる**ので、backfill を何度流しても
 *     同じ sibling を特定できる (= 増えない)。
 *   - 通常 blood (`lab-results` 系) は `external_test_id` が NULL なので衝突しない。
 *
 * ⚠️ **Elith の除外判定にこれを使わない。** 除外は `imported_by` の完全一致 1 本
 * (最上位ルール・§0)。sibling が 1 件でも 5 件でも Dashboard 専用。
 */
export const DERIVED_HC_BLOOD_EXTERNAL_PREFIX = 'derived_hc:';

/** `derived_hc:<親 artifact id>:g<グループ番号>`。 */
export function derivedBloodExternalTestId(parentArtifactId: string, groupIndex: number): string {
  return `${DERIVED_HC_BLOOD_EXTERNAL_PREFIX}${String(parentArtifactId).trim()}:g${groupIndex}`;
}

/** `external_test_id` から派生 sibling のグループ番号を読む。派生でなければ null。 */
export function derivedBloodGroupIndex(externalTestId: string | null | undefined): number | null {
  const m = /^derived_hc:(.+):g(\d+)$/.exec(String(externalTestId ?? ''));
  if (!m) return null;
  const n = Number(m[2]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** `external_test_id` から親 health_checkup の artifact id を読む。派生でなければ null。 */
export function derivedBloodParentId(externalTestId: string | null | undefined): string | null {
  const m = /^derived_hc:(.+):g(\d+)$/.exec(String(externalTestId ?? ''));
  return m ? m[1] : null;
}

/*
 * ── 同日 sibling の**表示用**の名前 (発注者裁定 2026-10-03 ②) ───────────────────
 *
 * 同じ受診日に sibling が 2 件並ぶときの見分け方。**両方残す・平均しない・捨てない・
 * 別系列にも分けない**ので、ここで作るのは**表示上の識別子だけ**。
 * `g1` / `g2` は医学的な別項目ではなく、**同じ検査項目の同じ系列の 2 点**である。
 *
 *   詳細・履歴 … `2026年9月17日（抽出1）`
 *   グラフの狭いラベル … `9/17①`
 *
 * **1 つしか無いときは付けない** — 見分ける相手がいないのに「（抽出1）」と出すと、
 * 利用者には何かが欠けているように見える。付けるかどうかは**呼び出し側が
 * 「同じ日が 2 つ以上あるか」で決める** (この関数は番号を文字にするだけ)。
 */
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

/** 丸番号。`①`〜`⑳`。範囲外は `(21)` のように素の形で返す (作字しない)。 */
export function derivedBloodMark(groupIndex: number): string {
  const n = Number(groupIndex);
  if (!Number.isInteger(n) || n < 1) return '';
  return n <= CIRCLED.length ? CIRCLED[n - 1] : `(${n})`;
}

/** 詳細・履歴に添える接尾辞。`（抽出1）`。 */
export function derivedBloodSuffix(groupIndex: number): string {
  const n = Number(groupIndex);
  if (!Number.isInteger(n) || n < 1) return '';
  return `（抽出${n}）`;
}

/**
 * **同じ受診日に並ぶ派生 blood (sibling) の順序を決定的にする**
 * (発注者レビュー 2026-10-03 ③)。**純関数。** 読み出し側 (`dashboard-queries` /
 * `result-queries`) が取得直後に 1 回通す。**2 か所で並べ替えない。**
 *
 * 【なぜ要るか】取得は `order('test_date', desc)` だけなので、**同じ受診日の 2 件は
 * DB が返した順**になる = 実行ごとに入れ替わり得る。`TestResultsSection` は
 * `mine[0]` を「最新」として扱い「データ」のリンク先にするので、
 * **押すたびに開く回が変わる**ことになる。
 *
 * **並べ替えるのは派生 sibling 同士だけ。** 他の行は**位置も相対順も 1 つも動かさない** —
 * 同じ枠に書き戻すので、受診日が null の行の扱いや他種別の並びは DB のまま。
 */
export function orderDerivedSiblings<T extends {
  id?: string | null; test_type?: string | null; test_date?: string | null;
  imported_by?: string | null; external_test_id?: string | null;
}>(rows: readonly T[]): T[] {
  const out = [...rows];
  // 受診日ごとに「派生 sibling が居る位置」を集める。
  const slots = new Map<string, number[]>();
  out.forEach((r, i) => {
    if (!isDerivedHealthcheckBlood(r)) return;
    const d = String(r.test_date ?? '');
    if (!d) return;
    const list = slots.get(d) ?? [];
    list.push(i);
    slots.set(d, list);
  });
  for (const idx of slots.values()) {
    if (idx.length < 2) continue;              // 1 件なら並べ替える相手がいない
    const picked = idx.map((i) => out[i]).sort((a, b) =>
      (derivedBloodGroupIndex(a.external_test_id) ?? 0) - (derivedBloodGroupIndex(b.external_test_id) ?? 0)
      || String(a.id ?? '').localeCompare(String(b.id ?? '')));
    idx.forEach((i, k) => { out[i] = picked[k]; });
  }
  return out;
}

/** 上の禁止を破ろうとしたときに各経路が返す理由。文言を 1 か所に持つ。 */
export const DERIVED_HC_BLOOD_ELITH_BLOCK =
  '人間ドック由来の派生 blood (imported_by=derived_healthcheck_blood) は Dashboard 表示専用で、'
  + 'Elith 納品用 BloodTestData ではありません (HealthCheckupData として既に納品済みの'
  + '同一検査情報を二重に送らないため)。';

/**
 * 対象 15 項目 (`standard-master.ts` の `canonical_name`)。
 * 業務仕様 v1.1 §4 の 15 項目を、**実際に `findByAlias()` を通して得た canonical_name** で書く。
 *
 * 並びはそのまま出力順になる (= `measurement_values.seq` の順)。run ごとに並びが揺れない。
 *
 * ⚠️ **ここに項目を足さない。** とくに `随時血糖` / `血糖` を足してはいけない
 * (v1.1 §5 の推測マッピング禁止に直接反する)。
 */
export const BLOOD_SUBSET_ITEMS = [
  'GOT(AST)',          // 1. AST（GOT）
  'GPT(ALT)',          // 2. ALT（GPT）
  'γ-GTP',             // 3. γ-GTP
  '総蛋白',             // 4. 総蛋白（TP）
  'アルブミン',          // 5. アルブミン（Alb）
  'LDLコレステロール',    // 6. LDLコレステロール
  'HDLコレステロール',    // 7. HDLコレステロール
  '総コレステロール',      // 8. 総コレステロール
  '中性脂肪',            // 9. 中性脂肪（TG）… 空腹時/随時 はここへ統合する (下)
  '空腹時血糖',          // 10. 空腹時血糖
  'HbA1c(NGSP)',       // 11. HbA1c
  'クレアチニン',         // 12. クレアチニン
  'eGFR',              // 13. eGFR（原本記載値のみ・計算しない）
  '尿酸',               // 14. 尿酸（UA）
  '尿素窒素',            // 15. 尿素窒素（BUN）
] as const;

export type BloodSubsetItem = (typeof BLOOD_SUBSET_ITEMS)[number];

const ITEM_SET: ReadonlySet<string> = new Set(BLOOD_SUBSET_ITEMS);
const ITEM_ORDER = new Map<string, number>(BLOOD_SUBSET_ITEMS.map((n, i) => [n, i]));

/**
 * 中性脂肪の統合 (裁定 Q-3)。**派生 blood の中だけ**で行う写像。
 *
 * 原本は様式ごとに `空腹時中性脂肪` / `随時中性脂肪` / `中性脂肪(TG)` と印字が違う
 * (3 検体で実測。spec §5.3) ので、**デメカル血液検査と同じ 1 本の時系列に並べる**ために
 * 派生側だけ `中性脂肪` へ寄せる。
 *
 * ⚠️ **`STANDARD_MASTER` では alias にしない。** `scan_md` / `test_artifacts.measurements` /
 * `measurement_values(test_type='health_checkup')` / `HealthCheckupData` は
 * **1 文字も変えない**。元データの意味を書き換える処理ではない。
 */
const TG_TARGET = '中性脂肪';
const TG_SOURCES: ReadonlySet<string> = new Set(['空腹時中性脂肪', '随時中性脂肪', '中性脂肪']);

/** 除外した項目と理由 (黙って消さない = 監査に出す)。 */
export interface BloodSubsetExclusion {
  /** 15 項目側の名前 (canonical)。 */
  name: string;
  /** いまのところ理由は 1 つだけ: 同一受診日に別値が複数あって一意に確定できない。 */
  reason: 'value_conflict';
  /** 競合した値 (原本の印字をそのまま)。 */
  values: string[];
  /** 競合の元になった原本の項目名 (`空腹時中性脂肪` 等)。 */
  sourceNames: string[];
}

export interface BloodSubsetResult {
  /** 派生 blood として保存する lean measurement。`name` は 15 項目の canonical 名。 */
  kept: LeanMeasurement[];
  /** 一意に確定できず除外した項目 (裁定 Q-12)。 */
  excluded: BloodSubsetExclusion[];
  /** 15 項目に当たらなかった入力の件数 (監査用。血球・腫瘍マーカー・画像所見など)。 */
  skipped: number;
}

/** 値が「在る」か。**ここが 0 補完を構造的に防いでいる唯一の関門。** */
function hasValue(m: LeanMeasurement): boolean {
  if (typeof m.value_num === 'number' && Number.isFinite(m.value_num)) return true;
  return typeof m.value === 'string' && m.value.trim() !== '';
}

/** 同じ値かどうか。数値があれば数値で、無ければ印字の文字列で見る。 */
function sameValue(a: LeanMeasurement, b: LeanMeasurement): boolean {
  const an = typeof a.value_num === 'number' && Number.isFinite(a.value_num) ? a.value_num : null;
  const bn = typeof b.value_num === 'number' && Number.isFinite(b.value_num) ? b.value_num : null;
  if (an != null && bn != null) return an === bn;
  if (an != null || bn != null) return false;
  return String(a.value ?? '').trim() === String(b.value ?? '').trim();
}

const printed = (m: LeanMeasurement): string =>
  (typeof m.value === 'string' && m.value.trim() !== '' ? m.value.trim() : String(m.value_num ?? ''));

/**
 * 15 項目を抽出する。**入力は書き換えない** (新しい配列を返す)。
 *
 * 名寄せは `findByAlias()`(正規化した完全一致のみ) に委ねる。
 * **独自の同義語ロジックをここに作らない** — 部分一致を入れた瞬間に
 * `総蛋白` が `尿蛋白` に当たる類の誤マップ(=捏造)が起きる。
 * 例外は中性脂肪の 3 → 1 の統合だけで、それは上の `TG_SOURCES` に明示してある。
 */
export function extractBloodSubset(src: readonly LeanMeasurement[] | null | undefined): BloodSubsetResult {
  const groups = new Map<string, { m: LeanMeasurement; sourceName: string }[]>();
  let skipped = 0;

  for (const m of src ?? []) {
    const raw = typeof m?.name === 'string' ? m.name.trim() : '';
    if (!raw) { skipped += 1; continue; }
    // 値が無い行は **はじめから対象にしない** (ブランクは「行を作らない」で表す)。
    if (!hasValue(m)) { skipped += 1; continue; }

    const hit = findByAlias(raw);
    if (!hit) { skipped += 1; continue; }       // 標準マスタに無い = 15 項目でもない
    const canon = hit.canonical_name;
    const target = TG_SOURCES.has(canon) ? TG_TARGET : canon;
    if (!ITEM_SET.has(target)) { skipped += 1; continue; }

    const list = groups.get(target) ?? [];
    list.push({ m, sourceName: raw });
    groups.set(target, list);
  }

  const kept: LeanMeasurement[] = [];
  const excluded: BloodSubsetExclusion[] = [];

  for (const [target, list] of groups) {
    // 同じ値が別名で複数来ただけなら 1 件に畳む (observation-dedup と同じ規律)。
    const first = list[0];
    const conflicting = list.filter((e) => !sameValue(e.m, first.m));
    if (conflicting.length > 0) {
      excluded.push({
        name: target,
        reason: 'value_conflict',
        values: Array.from(new Set(list.map((e) => printed(e.m)))),
        sourceNames: Array.from(new Set(list.map((e) => e.sourceName))),
      });
      continue;
    }
    /*
     * **値・単位・基準値・flag は原本のまま運ぶ。** 変えるのは `name` だけ
     * (15 項目の canonical 名へ寄せる = デメカルと同じ系列に乗せるため)。
     * `flag` は検査票が付けた印で、アプリが基準値と比較して出すものではない。
     */
    kept.push({
      name: target,
      value: first.m.value ?? null,
      value_num: typeof first.m.value_num === 'number' && Number.isFinite(first.m.value_num) ? first.m.value_num : null,
      unit: first.m.unit ?? null,
      ref_low: first.m.ref_low ?? null,
      ref_high: first.m.ref_high ?? null,
      flag: first.m.flag ?? null,
    });
  }

  kept.sort((a, b) => (ITEM_ORDER.get(String(a.name)) ?? 999) - (ITEM_ORDER.get(String(b.name)) ?? 999));
  excluded.sort((a, b) => (ITEM_ORDER.get(a.name) ?? 999) - (ITEM_ORDER.get(b.name) ?? 999));
  return { kept, excluded, skipped };
}
