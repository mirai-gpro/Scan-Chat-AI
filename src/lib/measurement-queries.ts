/**
 * 検査値 (diagnosis.measurement_values) の取得。
 *
 * 【原則 — このモジュールの存在理由】
 *   アプリの使命は「各診断結果を整理して伝える」ことであり、**独自に分析・解釈しない**。
 *   したがってここでは:
 *     - 判定レベルを計算しない (基準値と実測値から H/L を導出しない)
 *     - 助言文・コメントを生成しない
 *     - 検査機関が付けた flag ('H'/'L') と assessment (判定コード) を**そのまま**渡す
 *   並べ替えだけは行う。flag が付いた行を先に出すのは「検査機関が既に印を付けたものを
 *   先に見せる」であって、アプリによる判定ではない。
 *
 * データの出所は STEP 1 のマイグレーション (20260820000010_measurement_values.sql)。
 * 原本忠実の全記録は test_artifacts.measurements (jsonb) 側にあり、本表はグラフ用の正規化層。
 */

import { getServerSupabase } from './supabase';
import { demoFallbackEnabled, demoMetricTrend } from './demo-data';
import type { MetricTrendPoint, MetricTrendSeries } from './dashboard-queries';

/** 1 項目の検査値。値・単位・基準値・判定はすべて検査票由来をそのまま持つ。 */
export interface MeasurementItem {
  /** 原本の表記 */
  name: string;
  /** 標準マスタ照合でヒットした概念 ID。非ヒットは null (当て推量で埋めない) */
  canonicalName: string | null;
  value: string | null;
  valueNum: number | null;
  unit: string | null;
  refLow: string | null;
  refHigh: string | null;
  refLowNum: number | null;
  refHighNum: number | null;
  /** 検査機関が付けた基準外マーカー。アプリは算出しない */
  flag: 'H' | 'L' | null;
  /** 検査機関由来の判定コード (血液CSV の F2/A3 等)。デコードしない */
  assessment: string | null;
}

/** 直近 1 回分の検査値。 */
export interface LatestMeasurements {
  artifactId: string;
  testType: string;
  testDate: string | null;
  items: MeasurementItem[];
  /** flag が付いている件数 (検査機関が印を付けた数)。 */
  flaggedCount: number;
}

interface Row {
  artifact_id: string;
  test_type: string;
  test_date: string | null;
  seq: number;
  item_name: string;
  canonical_name: string | null;
  value: string | null;
  value_num: number | string | null;
  unit: string | null;
  ref_low: string | null;
  ref_high: string | null;
  ref_low_num: number | string | null;
  ref_high_num: number | string | null;
  flag: string | null;
  assessment: string | null;
}

const num = (v: number | string | null): number | null => {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const toItem = (r: Row): MeasurementItem => ({
  name: r.item_name,
  canonicalName: r.canonical_name,
  value: r.value,
  valueNum: num(r.value_num),
  unit: r.unit,
  refLow: r.ref_low,
  refHigh: r.ref_high,
  refLowNum: num(r.ref_low_num),
  refHighNum: num(r.ref_high_num),
  flag: r.flag === 'H' || r.flag === 'L' ? r.flag : null,
  assessment: r.assessment,
});

/**
 * 時系列グラフに出す既定の項目 (canonical_name)。
 * どれをグラフ化するかは表示上の選択であって、値の解釈ではない。
 */
export const DEFAULT_TREND_ITEMS = [
  'HbA1c(NGSP)',
  '空腹時血糖',
  'LDLコレステロール',
  'γ-GTP',
  '尿酸',
  'eGFR',
] as const;

/**
 * テストフェーズ用のフォールバック。
 * demo-data.ts と同じ方針で、**実データが無いときだけ**サンプルを返す
 * (env PUBLIC_DEMO_FALLBACK=false で無効化)。総合テストで env を落とすと消える。
 */
function demoLatest(): LatestMeasurements {
  const series = demoMetricTrend();
  const items: MeasurementItem[] = series.map((s) => {
    const last = s.points[s.points.length - 1];
    const high = s.referenceUpper ?? null;
    return {
      name: s.label,
      canonicalName: s.label,
      value: last.raw,
      valueNum: last.value,
      unit: s.unit,
      refLow: null,
      refHigh: high == null ? null : String(high),
      refLowNum: null,
      refHighNum: high,
      flag: high != null && last.value > high ? 'H' : null,
      assessment: null,
    };
  });
  const flagged = items.filter((i) => i.flag != null);
  return {
    artifactId: 'demo',
    testType: 'blood',
    testDate: series[0]?.points.at(-1)?.date ?? null,
    items: [...flagged, ...items.filter((i) => i.flag == null)],
    flaggedCount: flagged.length,
  };
}

/**
 * この人の **active な** test_artifact の id 一覧を返す。
 *
 * 【なぜ要るか — 2026-09-27 に判明】
 *   `measurement_values` は artifact を FK で参照するだけで **status を持たない**。
 *   一方 `test_artifacts.status` は active / superseded / withdrawn を取り、
 *   再取込で古い回を superseded に落としたり、誤りと分かった回を withdrawn にしたりする。
 *   にもかかわらずこのモジュールの 3 つのクエリは `diagnostic_user_id` だけで引いていたので、
 *   **差し替えたはずの古い値・取り下げた値がグラフと「読み取り結果」に混ざる**状態だった。
 *   実際、同じ受診日について壊れた回と直した回が両方 measurement_values に残り、
 *   どちらが出るかは並び順まかせだった。
 *
 *   後から弾くのではなく**そもそも読まない**ようにする。status は artifact 側にしか無いので、
 *   先に active な id を引いてから `.in('artifact_id', …)` で絞る。
 *   (PostgREST の埋め込みリソース経由のフィルタは FK の解決名に依存して壊れやすいため、
 *    2 クエリに分ける方を採る。1 人分なので件数は数十件。)
 *
 * 失敗したら **throw する**。呼び出し側の catch が「データ無し」を返す
 * = 古い値を出すくらいなら空にする (fail-closed)。
 */
async function activeArtifactIds(
  sb: NonNullable<ReturnType<typeof getServerSupabase>>,
  diagnosticUserId: string,
): Promise<string[]> {
  const { data, error } = await sb
    .schema('diagnosis')
    .from('test_artifacts')
    .select('id')
    .eq('diagnostic_user_id', diagnosticUserId)
    .eq('status', 'active')
    .limit(2000);
  if (error) throw new Error(`test_artifacts(active) の取得に失敗: ${error.message}`);
  return ((data ?? []) as unknown as { id: string }[]).map((r) => String(r.id));
}

/** 直近 1 回分の検査値を取得する。無ければ null (テストフェーズはデモへ)。 */
export async function getLatestMeasurements(
  diagnosticUserId: string,
): Promise<LatestMeasurements | null> {
  // デモ用アカウントは DB を見ない (仕様書 §2 — 実データの有無は条件ではない)。
  if (demoFallbackEnabled(diagnosticUserId)) return demoLatest();
  const sb = getServerSupabase();
  if (!sb) return null;
  try {
    // superseded / withdrawn の回は読まない (差し替え前の値を出さない)。
    const active = await activeArtifactIds(sb, diagnosticUserId);
    if (active.length === 0) return null;
    // 最新の test_date を持つ 1 検査分だけを取る。
    const { data, error } = await sb
      .schema('diagnosis')
      .from('measurement_values')
      .select(
        'artifact_id, test_type, test_date, seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, assessment',
      )
      .eq('diagnostic_user_id', diagnosticUserId)
      .in('artifact_id', active)
      .order('test_date', { ascending: false })
      .order('seq', { ascending: true })
      .limit(400);

    const rows = (data ?? []) as unknown as Row[];
    if (error || rows.length === 0) return null;

    const newest = rows[0];
    const same = rows.filter(
      (r) => r.artifact_id === newest.artifact_id && r.test_date === newest.test_date,
    );
    const items = same.sort((a, b) => a.seq - b.seq).map(toItem);

    // 検査機関が印を付けた行を先頭へ (アプリの判定ではなく、既にある印での並べ替え)。
    const flagged = items.filter((i) => i.flag != null);
    const rest = items.filter((i) => i.flag == null);

    return {
      artifactId: newest.artifact_id,
      testType: newest.test_type,
      testDate: newest.test_date,
      items: [...flagged, ...rest],
      flaggedCount: flagged.length,
    };
  } catch {
    return null;
  }
}

/**
 * 系列のキー。原則は `canonical_name`。
 *
 * **【テストフェーズの暫定措置 2026-08・発注者指示】**
 * canonical_name が無い行は `item_name` をキーに使う。標準マスタ (standard-master.ts) は
 * 健診標準フォーマット(KMAT) の starter なので、がんリスク検査の「尿中ポルフィリン量」
 * 「インデックス値」等は収録されておらず canonical_name が null になり、グラフの候補に
 * 一切乗らなかった。デモ・テストで各検査の推移を見せるために暫定で許容する。
 *
 * **恒久策ではない**。item_name は run ごとに表記が揺れうるので、同じ項目が別系列に
 * 割れることがある (canonical_name はまさにそれを吸収するために在る)。完全マスタを
 * 受領して canonical_name が全項目に付くようになったら、このフォールバックは外す。
 * 外す場合はここ (seriesKey) を `r.canonical_name` だけに戻せばよい。
 */
/**
 * **系列をまとめるためだけの完全一致エイリアス** (2026-09-29・実障害)。
 *
 * がんリスク検査の塩分は 4 回とも値が在るのに、`item_name` が回ごとに 3 通りに
 * 割れていて (`塩分摂取量` / `1日の塩分摂取量` / `1日の食塩摂取量`)、しかも
 * `canonical_name` が全て null のため、**推移グラフが 2 点しか描かなかった**
 * (Production DB 実測: 2023-08-03 8.7 / 2024-06-10 8.4 / 2024-09-02 8.7 /
 *  2025-01-06 7.6 g)。BMI は canonical_name が付くので 4 点出ていた。
 *
 * ここで吸収するのは**系列のキーだけ**。
 *  - **DB の `item_name` / `value` は書き換えない** (原本忠実)。
 *  - **保存経路・PDF 解析は触らない** (読み出し時の見せ方の問題なので)。
 *  - **完全一致のみ**。fuzzy / 部分一致はしない — 部分一致にすると
 *    「尿中塩分」等の別項目まで巻き込み、静かに別物の線が 1 本になる。
 *  - 単位は行の値をそのまま使う (`unit: last.unit`) ので `g` のまま。
 *
 * **恒久策ではない**。完全マスタを受領して canonical_name が全項目に付いたら、
 * この表ごと畳んで `seriesKey` を `r.canonical_name` だけに戻す。
 */
const SERIES_NAME_ALIASES: Readonly<Record<string, string>> = {
  塩分摂取量: '1日の塩分摂取量',
  '1日の塩分摂取量': '1日の塩分摂取量',
  '1日の食塩摂取量': '1日の塩分摂取量',
};

function seriesKey(r: { canonical_name: string | null; item_name?: string | null }): string | null {
  const canonical = r.canonical_name?.trim();
  const raw = r.item_name?.trim();
  const key = canonical || (raw ? raw : null);
  if (key == null) return null;
  // 完全一致のときだけ差し替える (Object.hasOwn で prototype 汚染を拾わない)。
  return Object.hasOwn(SERIES_NAME_ALIASES, key) ? SERIES_NAME_ALIASES[key] : key;
}

/**
 * 「表示項目の設定」で選べる候補を返す。
 *
 * **候補はマスタではなく実データから作る**。この人の measurement_values に実在し、
 * かつ**日付の違う点が 2 つ以上ある** (＝線が引ける) 項目だけを返す。
 * どの項目を既定にするかの選定基準は未確定なので、こちらで 20 項目のマスタを
 * でっち上げない (ミッション④・捏造ゼロ)。
 *
 * 項目の同一性は `seriesKey()` = canonical_name、無ければ item_name で見る
 * (**テストフェーズの暫定措置**。seriesKey のコメント参照)。
 *
 * 並び順は DEFAULT_TREND_ITEMS の順 → 残りを名前順。回ごとに並びが揺れないようにする。
 */
export async function getTrendCandidates(
  diagnosticUserId: string,
  testType?: string,
): Promise<string[]> {
  const sb = getServerSupabase();
  // 実データ層が無いテストフェーズでは、デモの系列名をそのまま候補にする。
  if (demoFallbackEnabled(diagnosticUserId)) return demoMetricTrend(testType).map((x) => x.label);
  if (!sb) return [];
  try {
    // superseded / withdrawn の回は候補に出さない (消したはずの項目が選択肢に残らないように)。
    const active = await activeArtifactIds(sb, diagnosticUserId);
    if (active.length === 0) return [];
    let q = sb
      .schema('diagnosis')
      .from('measurement_values')
      .select('canonical_name, item_name, test_type, test_date, value_num')
      .eq('diagnostic_user_id', diagnosticUserId)
      .in('artifact_id', active)
      .not('value_num', 'is', null)
      .limit(4000);
    if (testType) q = q.eq('test_type', testType);
    const { data, error } = await q;
    const rows = (data ?? []) as unknown as
      { canonical_name: string | null; item_name: string | null; test_date: string | null }[];
    if (error || rows.length === 0) {
      return [];
    }

    const dates = new Map<string, Set<string>>();
    for (const r of rows) {
      const key = seriesKey(r);
      if (!key || !r.test_date) continue;
      const set = dates.get(key) ?? new Set<string>();
      set.add(String(r.test_date));
      dates.set(key, set);
    }
    const drawable = [...dates.entries()].filter(([, d]) => d.size >= 2).map(([name]) => name);

    const head = DEFAULT_TREND_ITEMS.filter((n) => drawable.includes(n)) as string[];
    const rest = drawable.filter((n) => !head.includes(n)).sort((a, b) => a.localeCompare(b, 'ja'));
    return [...head, ...rest];
  } catch {
    return [];
  }
}

/**
 * 指定項目の時系列を取得する。
 * 各系列には検査票由来の基準値をそのまま添える (グラフの基準線に使う)。
 *
 * 項目の指定は `seriesKey()` の基準で突合する — つまり canonical_name、
 * 無ければ item_name (テストフェーズの暫定措置。seriesKey のコメント参照)。
 *
 * `testType` を渡すと、その検査種別 (health_checkup / blood / …) の測定値だけに絞る。
 * 検査結果セクションの「グラフ」は 1 種別ずつ開くので、その絞り込みに使う。
 *
 * 絞り込んだ結果が空のときのデモは **`demoMetricTrend(testType)` に委ねる**。
 * 以前はここで一律 `[]` を返していた — 「別種別のサンプルを『この検査の推移』として
 * 見せない」ためで、理由は正しいが**デモの人間ドックのグラフが常に空**になっていた。
 * デモ側を種別ごとに分けたので、知らない種別は demo 側が `[]` を返す = 約束は同じまま。
 */
export async function getMeasurementTrend(
  diagnosticUserId: string,
  canonicalNames: readonly string[] = DEFAULT_TREND_ITEMS,
  maxPoints = 12,
  testType?: string,
): Promise<MetricTrendSeries[]> {
  const sb = getServerSupabase();
  // 旧 getMetricTrend が持っていたデモフォールバックを踏襲する
  // (テストフェーズでクライアントに推移グラフを見てもらうために必要)。
  if (demoFallbackEnabled(diagnosticUserId)) return demoMetricTrend(testType);
  if (!sb || canonicalNames.length === 0) return [];
  try {
    // superseded / withdrawn の回は点として打たない
    // (差し替え前の値が線に残ると「前回はこうだった」という誤った推移になる)。
    const active = await activeArtifactIds(sb, diagnosticUserId);
    if (active.length === 0) return [];
    const { data, error } = await sb
      .schema('diagnosis')
      .from('measurement_values')
      .select(
        'artifact_id, test_type, test_date, seq, item_name, canonical_name, value, value_num, unit, ref_low, ref_high, ref_low_num, ref_high_num, flag, assessment',
      )
      .eq('diagnostic_user_id', diagnosticUserId)
      .in('artifact_id', active)
      .not('value_num', 'is', null)
      .order('test_date', { ascending: true })
      // 項目の絞り込みは JS 側で行う (下)。canonical_name が null の行も対象にする必要があり、
      // PostgREST の or フィルタは和文の値 (カンマ・括弧を含む) のエスケープが壊れやすいため。
      // 1 人分の測定値なので件数は限定的 (実測: 血液 22 項目 x 12 回 = 264 行)。
      .limit(4000);

    const want = new Set(canonicalNames as string[]);
    const all = (data ?? []) as unknown as Row[];
    const rows = all.filter((r) => {
      if (testType && r.test_type !== testType) return false;
      const key = seriesKey(r);
      return key != null && want.has(key);
    });
    if (error || rows.length === 0) return [];

    const byName = new Map<string, Row[]>();
    for (const r of rows) {
      const key = seriesKey(r);
      if (!key || !r.test_date) continue;
      const list = byName.get(key) ?? [];
      list.push(r);
      byName.set(key, list);
    }

    const out: MetricTrendSeries[] = [];
    // 指定順を保つ (表示順が run ごとに揺れないように)。
    for (const name of canonicalNames) {
      const list = byName.get(name);
      if (!list || list.length === 0) continue;
      const sorted = list
        .slice()
        .sort((a, b) => String(a.test_date).localeCompare(String(b.test_date)))
        .slice(-maxPoints);
      const points: MetricTrendPoint[] = [];
      for (const r of sorted) {
        const v = num(r.value_num);
        if (v == null) continue;
        points.push({
          date: String(r.test_date),
          value: v,
          raw: r.value ?? String(v),
          flag: r.flag === 'H' || r.flag === 'L' ? r.flag : null,
        });
      }
      if (points.length === 0) continue;
      const last = sorted[sorted.length - 1];
      out.push({
        label: name,
        unit: last.unit ?? '',
        referenceUpper: num(last.ref_high_num) ?? undefined,
        referenceLower: num(last.ref_low_num) ?? undefined,
        points,
      });
    }
    return out;
  } catch {
    return [];
  }
}
