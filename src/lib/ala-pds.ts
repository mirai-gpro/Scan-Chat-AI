/**
 * がんリスク検査 **ALA-PDS 方式** の識別と、推移グラフの対象回の決定（決定論・捏造ゼロ）。
 *
 * 【なぜ要るか（2026-09-30・発注者指示）】本田大作さんの `cancer_urine` は
 * **方式が途中で変わっている**。
 *
 * | 受付日 | 方式 |
 * |---|---|
 * | 2023-08-03 / 2024-06-10 / 2024-09-02 | **Noah4**（BMI・塩分・尿糖・尿蛋白・尿潜血 ほか） |
 * | 2025-01-06 / 2025-08-04 / 2026-06-04 | **ALA-PDS**（尿中のポルフィリン量・インデックス値・リスクランク） |
 *
 * Noah4 と ALA-PDS は**測定している物が違う**ので、同じ「がんリスク検査」の推移として
 * 1 本の線に混ぜてはいけない。ところが現行の `getMeasurementTrend` は
 * `test_type = 'cancer_urine'` でしか絞らないため、**方式をまたいで混ざる**。
 *
 * 【方式の判定は日付でしない】「2025-01-06 以降が ALA」と日付で切ると、
 * **別の利用者・別の運用で必ず破綻する**（検査機関が方式を戻す・並行運用する・
 * 遡って取り込む）。**その回が何を測ったか**＝ALA 固有項目を持つか、で判定する。
 *
 * 【完全一致のみ。substring / fuzzy 判定は禁止】
 * `measurement-queries.ts` の `SERIES_NAME_ALIASES` と同じ規律。部分一致にすると
 * 「尿中ポルフィリン量の目安」のような別項目まで ALA と誤認し、**静かに**別物が
 * 線に乗る。
 */

/**
 * ALA-PDS の主結果「尿中のポルフィリン量」の**原本表記ゆれ**（完全一致の集合）。
 *
 * **「の」の有無だけが揺れている**（検査票の版・取り込み経路による）。
 * ここに載っていない表記は ALA と見なさない（当て推量で広げない）。
 */
export const ALA_PORPHYRIN_NAMES: readonly string[] = [
  '尿中のポルフィリン量',
  '尿中ポルフィリン量',
];

/** ALA-PDS の「インデックス値」（完全一致）。 */
export const ALA_INDEX_NAMES: readonly string[] = [
  'インデックス値',
];

/** ALA-PDS の「リスクランク」（完全一致）。**グラフ化しない**（A/B/C/D の順序尺度）。 */
export const ALA_RISK_RANK_NAMES: readonly string[] = [
  'リスクランク',
];

/**
 * **利用者向けの表示名**（発注者指示 2026-09-30）。
 * DB の `item_name` は原本のまま書き換えない。**読み出し時の系列キー / 表示名だけ**を揃える。
 */
export const ALA_PORPHYRIN_LABEL = '尿中のポルフィリン量';
export const ALA_INDEX_LABEL = 'インデックス値';

const PORPHYRIN = new Set(ALA_PORPHYRIN_NAMES);
const INDEX = new Set(ALA_INDEX_NAMES);

/**
 * 推移グラフに乗せる ALA-PDS の回数（発注者指示 2026-09-30）。
 *
 * **「ALA の全履歴」ではなく「最新 2 件」**。2025-01-06 も ALA だが、
 * **グラフの点には含めない**（検査履歴からは消さない）。
 *
 * > **未確定**: なぜ「最新 2 件」なのかの理由は指示に無い。
 * > 全 ALA 履歴を出す運用に変わる可能性があるので、**定数 1 か所**にしてある。
 */
export const ALA_TREND_MAX_ARTIFACTS = 2;

/** 判定に使う最小限の行の形。`measurement_values` の 1 行を想定。 */
export interface AlaRowLike {
  artifact_id: string;
  item_name?: string | null;
  test_date?: string | null;
}

/**
 * **その回（artifact）が ALA-PDS か。**
 *
 * 条件 = **「尿中のポルフィリン量」系の項目と「インデックス値」の両方を持つこと**。
 * 片方だけでは成立させない — 別方式が偶然どちらか 1 つを持つ可能性を排除するため。
 *
 * @param itemNames その artifact の `item_name` の集まり（原本表記のまま）
 */
export function isAlaArtifact(itemNames: Iterable<string | null | undefined>): boolean {
  let hasPorphyrin = false;
  let hasIndex = false;
  for (const raw of itemNames) {
    const n = (raw ?? '').trim();
    if (!n) continue;
    if (PORPHYRIN.has(n)) hasPorphyrin = true;
    else if (INDEX.has(n)) hasIndex = true;
    if (hasPorphyrin && hasIndex) return true;
  }
  return false;
}

/**
 * 行の集まりから **ALA-PDS の artifact_id を test_date 降順**で返す。
 *
 * `test_date` が無い回は順序を決められないので**末尾へ**送る（落とさない）。
 */
export function alaArtifactIdsNewestFirst(rows: readonly AlaRowLike[]): string[] {
  const names = new Map<string, string[]>();
  const dates = new Map<string, string>();
  for (const r of rows) {
    const id = r.artifact_id;
    if (!id) continue;
    const list = names.get(id) ?? [];
    list.push((r.item_name ?? '').trim());
    names.set(id, list);
    const d = (r.test_date ?? '').trim();
    if (d && !dates.has(id)) dates.set(id, d);
  }
  const ala = [...names.entries()].filter(([, list]) => isAlaArtifact(list)).map(([id]) => id);
  return ala.sort((a, b) => {
    const da = dates.get(a) ?? '';
    const db = dates.get(b) ?? '';
    if (da === db) return a.localeCompare(b);
    if (!da) return 1;   // 日付なしは末尾
    if (!db) return -1;
    return db.localeCompare(da); // 降順
  });
}

/**
 * **推移グラフに使う行だけへ絞る。**
 *
 * - ALA-PDS の回が 1 つでもあれば → **最新 `ALA_TREND_MAX_ARTIFACTS` 件の ALA の行だけ**。
 *   Noah4 の回（BMI・塩分など）は artifact ごと落ちるので、**項目名で除外する必要が無い**
 *   （名前で弾くと、新しい Noah4 項目が増えたときに漏れる）。
 * - **ALA の回が 1 つも無ければ、絞らずにそのまま返す。**
 *   ALA を受けていない利用者の推移グラフを**黙って空にしない**ため。
 *
 * @returns `{ rows, alaArtifactIds }` — `alaArtifactIds` は空なら「絞っていない」
 */
export function restrictToLatestAla<T extends AlaRowLike>(
  rows: readonly T[],
  maxArtifacts: number = ALA_TREND_MAX_ARTIFACTS,
): { rows: T[]; alaArtifactIds: string[] } {
  const ordered = alaArtifactIdsNewestFirst(rows);
  if (ordered.length === 0) return { rows: [...rows], alaArtifactIds: [] };
  const keep = new Set(ordered.slice(0, Math.max(1, maxArtifacts)));
  return { rows: rows.filter((r) => keep.has(r.artifact_id)), alaArtifactIds: [...keep] };
}

/**
 * **インデックス値の分数表記から数値を取り出す**（`"0.9 / 8.0"` → `0.9`）。
 *
 * 検査票は 0〜8 のスケールを分数で印字する。`toValueNum()`（`elith-export.ts:190`）は
 * **スラッシュ混じりを null にする**ので、このままだと `value_num` が付かず
 * **推移グラフに点が 1 つも乗らない**。
 *
 * **捏造ではない** — 分子は検査票に印字された実測値そのもので、計算も丸めもしていない。
 * `value`（原本表記）は書き換えず、**`value_num` を補うだけ**。
 * 正規化の形は `cancer-risk-fix.ts:13` の `FRAC_RE` と同一（二重管理しないよう同じ形を使う）。
 *
 * 分数でない純粋な数値（`"0.9"`）も受ける。それ以外は `null`。
 */
const ALA_INDEX_FRACTION = /^(\d+(?:\.\d+)?)\s*[/／]\s*8(?:\.0+)?$/;

export function alaIndexValueNum(value: string | null | undefined): number | null {
  if (value == null) return null;
  const t = String(value).normalize('NFKC').trim();
  if (!t) return null;
  const m = ALA_INDEX_FRACTION.exec(t);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }
  if (/^\d+(?:\.\d+)?$/.test(t)) {
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** その項目名が ALA の「インデックス値」か（完全一致）。 */
export function isAlaIndexName(name: string | null | undefined): boolean {
  return INDEX.has((name ?? '').trim());
}
