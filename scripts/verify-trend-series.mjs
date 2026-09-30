#!/usr/bin/env node
/**
 * **推移グラフの系列グルーピング** (`measurement-queries.ts` の `seriesKey`) の検査。
 *
 * 【なぜ要るか (2026-09-29・Production DB 実測)】がんリスク検査の塩分は 4 回とも
 * 値が在るのに、`item_name` が回ごとに 3 通りに割れていて (`塩分摂取量` /
 * `1日の塩分摂取量` / `1日の食塩摂取量`)、しかも `canonical_name` が全て null
 * のため **推移グラフが 2 点しか描かなかった**。BMI は canonical_name が付くので
 * 4 点出ていた。→ 読み出し時だけ 3 表記を完全一致で 1 系列にまとめた。
 *
 * **これは静かに壊れる種類の不具合**。線が 1 本描かれてしまうので画面はエラーを
 * 出さないし、点が足りないことに気づけない。だから実際に関数を動かして
 * **点の数と値の並び**を数える。
 *
 * 見るもの:
 *   ① 塩分 3 表記 → 1 系列 4 点 (8.7 → 8.4 → 8.7 → 7.6・単位 g)
 *   ② 「表示項目の設定」の候補にも 1 件だけ出る (3 件に割れない)
 *   ③ **他の項目を巻き込まない** (BMI・尿中のポルフィリン量・インデックス値 は不変)
 *   ④ **部分一致で拾わない** (「尿中塩分」「塩分摂取量の目安」等は別系列のまま)
 *   ⑤ canonical_name が在る行はそちらが勝つ (従来どおり)
 */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';

const CACHE = 'node_modules/.cache';
mkdirSync(CACHE, { recursive: true });

const UID = '5d11742f-f196-450c-800b-d9ffa89ba64b';
const ART = ['a1', 'a2', 'a3', 'a4'];

/** Production の実測どおりの 4 回分 (表記が 3 通りに割れている)。 */
const SALT = [
  { d: '2023-08-03', a: 'a1', name: '塩分摂取量', v: 8.7 },
  { d: '2024-06-10', a: 'a2', name: '1日の塩分摂取量', v: 8.4 },
  { d: '2024-09-02', a: 'a3', name: '1日の食塩摂取量', v: 8.7 },
  { d: '2025-01-06', a: 'a4', name: '1日の塩分摂取量', v: 7.6 },
];
/** 巻き込み検知用。**部分一致なら 1 本に潰れてしまう名前**をわざと混ぜてある。 */
const OTHERS = [
  { d: '2023-08-03', a: 'a1', name: 'BMI', canon: 'BMI', v: 22.1, unit: '' },
  { d: '2024-06-10', a: 'a2', name: 'BMI', canon: 'BMI', v: 22.4, unit: '' },
  { d: '2023-08-03', a: 'a1', name: '尿中ポルフィリン量', v: 12.3, unit: 'μg/gCr' },
  { d: '2024-06-10', a: 'a2', name: '尿中ポルフィリン量', v: 13.1, unit: 'μg/gCr' },
  { d: '2023-08-03', a: 'a1', name: '尿中塩分', v: 3.1, unit: 'g' },
  { d: '2024-06-10', a: 'a2', name: '尿中塩分', v: 3.4, unit: 'g' },
  { d: '2023-08-03', a: 'a1', name: '1日の塩分摂取量の目安', v: 7.5, unit: 'g' },
  { d: '2024-06-10', a: 'a2', name: '1日の塩分摂取量の目安', v: 7.5, unit: 'g' },
];

const ROWS = [
  ...SALT.map((s, i) => row(s.a, s.d, i, s.name, null, s.v, 'g')),
  ...OTHERS.map((o, i) => row(o.a, o.d, 100 + i, o.name, o.canon ?? null, o.v, o.unit)),
];
function row(artifact_id, test_date, seq, item_name, canonical_name, value_num, unit) {
  return {
    artifact_id, test_type: 'cancer_urine', test_date, seq, item_name, canonical_name,
    value: String(value_num), value_num, unit,
    ref_low: null, ref_high: null, ref_low_num: null, ref_high_num: null,
    flag: null, assessment: null,
  };
}

// ── Supabase / demo-data の差し替え ──────────────────────────────
function makeStub(rows) {
  const table = (name) => {
    const api = {
      select() { return api; },
      eq() { return api; },
      in() { return api; },
      not() { return api; },
      order() { return api; },
      limit() { return api; },
      then(res) {
        const data = name === 'test_artifacts' ? ART.map((id) => ({ id })) : rows;
        return Promise.resolve({ data, error: null }).then(res);
      },
    };
    return api;
  };
  return { schema: () => ({ from: table }), from: table };
}

writeFileSync(`${CACHE}/trend-supabase-stub.mjs`, `export let _stub = null;
export function __setStub(s) { _stub = s; }
export function getServerSupabase() { return _stub; }
export function getBrowserSupabase() { return null; }
`);
// デモ層は通さない (実データ経路を検査する)。
writeFileSync(`${CACHE}/trend-demo-stub.mjs`, `export function demoFallbackEnabled() { return false; }
export function demoMetricTrend() { return []; }
`);

await build({
  entryPoints: ['src/lib/measurement-queries.ts'],
  bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
  define: { 'import.meta.env': '{}' },
  outfile: `${CACHE}/verify-trend-series.mjs`,
  plugins: [{
    name: 'stub',
    setup(b) {
      // external にする。束ねると別インスタンスになり __setStub が届かない。
      b.onResolve({ filter: /(^|\/)supabase$/ }, () => ({ path: './trend-supabase-stub.mjs', external: true }));
      b.onResolve({ filter: /(^|\/)demo-data$/ }, () => ({ path: './trend-demo-stub.mjs', external: true }));
    },
  }],
});
const mod = await import(`../${CACHE}/verify-trend-series.mjs`);
const stub = await import(`../${CACHE}/trend-supabase-stub.mjs`);
stub.__setStub(makeStub(ROWS));

let pass = 0;
const fails = [];
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  — ' + extra : ''}`); }
  else { fails.push(label); console.log(`FAIL  ${label}${extra ? '  — ' + extra : ''}`); }
};

// ── ① 3 表記が 1 系列 4 点になる ─────────────────────────────────
console.log('\n① 塩分 3 表記 → 1 系列 4 点');
{
  const s = await mod.getMeasurementTrend(UID, ['1日の塩分摂取量'], 12, 'cancer_urine');
  ok(s.length === 1, '系列は 1 本', `len=${s.length}`);
  const pts = s[0]?.points ?? [];
  ok(pts.length === 4, '**点が 4 つ** (修正前は 2 点だった)', `n=${pts.length}`);
  ok(pts.map((p) => p.value).join(' → ') === '8.7 → 8.4 → 8.7 → 7.6',
    '値が 8.7 → 8.4 → 8.7 → 7.6 の順', pts.map((p) => p.value).join(' → '));
  ok(pts.map((p) => p.date).join(',') === '2023-08-03,2024-06-10,2024-09-02,2025-01-06',
    '受診日が 4 回ぶん昇順', pts.map((p) => p.date).join(','));
  ok(s[0]?.unit === 'g', '単位は g のまま (換算しない)', String(s[0]?.unit));
  ok(s[0]?.label === '1日の塩分摂取量', 'ラベルは 1日の塩分摂取量', String(s[0]?.label));
}

// ── ② 候補一覧に 1 件だけ出る ────────────────────────────────────
console.log('\n② 「表示項目の設定」の候補');
{
  const c = await mod.getTrendCandidates(UID, 'cancer_urine');
  const salty = c.filter((n) => n.includes('塩'));
  ok(c.filter((n) => n === '1日の塩分摂取量').length === 1, '候補に 1日の塩分摂取量 が 1 件', JSON.stringify(salty));
  ok(!c.includes('塩分摂取量') && !c.includes('1日の食塩摂取量'),
    '旧 2 表記は候補に出ない (3 件に割れない)', JSON.stringify(salty));
  // 候補は「日付が 2 つ以上」で絞るので、上の 2 件はエイリアスを外しても
  // (1 回ずつしか無いので) 候補に出ない = **上の 2 行だけでは退行を捕まえられない**。
  // 旧表記で引いて空になることまで見て初めて「畳まれた」と言える。
  for (const old of ['塩分摂取量', '1日の食塩摂取量']) {
    const s = await mod.getMeasurementTrend(UID, [old], 12, 'cancer_urine');
    ok(s.length === 0, `旧表記「${old}」では系列が引けない (畳まれている)`, `len=${s.length}`);
  }
}

// ── ③ 他の項目を巻き込まない ────────────────────────────────────
console.log('\n③ 他系列は不変');
{
  /*
   * **2026-09-30: ポルフィリンの系列名が変わった。** ALA-PDS の主結果は原本表記が
   * 「の」の有無で揺れるので、読み出し時に `尿中のポルフィリン量` (利用者向け表示名) へ
   * 寄せた (`ala-pds.ts` の `ALA_PORPHYRIN_LABEL`・発注者指示)。
   * **fixture の item_name は原本どおり `尿中ポルフィリン量` のまま**で、
   * 引くときの名前だけが変わる = 塩分と同じ「読み出し時のエイリアス」。
   */
  const names = ['BMI', '尿中のポルフィリン量'];
  const s = await mod.getMeasurementTrend(UID, names, 12, 'cancer_urine');
  ok(s.length === 2, 'BMI / 尿中のポルフィリン量 は従来どおり 2 系列', `len=${s.length}`);
  for (const x of s) ok(x.points.length === 2, `${x.label} は 2 点`, `n=${x.points.length}`);
  ok((await mod.getMeasurementTrend(UID, ['尿中ポルフィリン量'], 12, 'cancer_urine')).length === 0,
    '旧表記「尿中ポルフィリン量」では引けない (表示名へ畳まれている)');
  ok(s.find((x) => x.label === 'BMI')?.points.map((p) => p.value).join(',') === '22.1,22.4',
    'BMI の値が変わっていない');
}

// ── ④ 部分一致で拾わない ────────────────────────────────────────
console.log('\n④ 完全一致のみ (fuzzy / substring を使わない)');
{
  const s = await mod.getMeasurementTrend(UID, ['尿中塩分', '1日の塩分摂取量の目安'], 12, 'cancer_urine');
  ok(s.length === 2, '「尿中塩分」「1日の塩分摂取量の目安」は別系列のまま', `len=${s.length}`);
  const merged = await mod.getMeasurementTrend(UID, ['1日の塩分摂取量'], 12, 'cancer_urine');
  ok((merged[0]?.points.length ?? 0) === 4,
    '紛らわしい 4 行を混ぜても塩分系列は 4 点のまま (巻き込んでいない)',
    `n=${merged[0]?.points.length}`);
  const cands = await mod.getTrendCandidates(UID, 'cancer_urine');
  ok(cands.includes('尿中塩分') && cands.includes('1日の塩分摂取量の目安'),
    '紛らわしい 2 項目は候補に残る (消していない)');
}

// ── ⑤ canonical_name が在れば従来どおりそちらが勝つ ──────────────
console.log('\n⑤ canonical_name 優先は不変');
{
  stub.__setStub(makeStub([
    row('a1', '2023-08-03', 1, '塩分摂取量', '食塩相当量', 8.7, 'g'),
    row('a2', '2024-06-10', 2, '1日の塩分摂取量', '食塩相当量', 8.4, 'g'),
  ]));
  const s = await mod.getMeasurementTrend(UID, ['食塩相当量'], 12, 'cancer_urine');
  ok(s.length === 1 && s[0].points.length === 2,
    'canonical_name が付いていればその名前で 1 系列', `len=${s.length} n=${s[0]?.points.length}`);
  const s2 = await mod.getMeasurementTrend(UID, ['1日の塩分摂取量'], 12, 'cancer_urine');
  ok(s2.length === 0, 'エイリアスは canonical_name を上書きしない', `len=${s2.length}`);
  stub.__setStub(makeStub(ROWS));
}

console.log(`\n${pass} / ${pass + fails.length} passed`);
if (fails.length) { console.error('\n落ちた検査:\n  - ' + fails.join('\n  - ')); process.exit(1); }
