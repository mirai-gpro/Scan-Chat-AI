/**
 * AI疾病予防報告書の **章レジストリ** と 2 本柱の枠。
 *
 * 正本: docs/elith/AI疾病予防報告書_仕様書.md  ※ § 番号は旧版 docs/旧版・ボツ/ai_prevention_report_generation_spec.md §1.3.2 / §4.-1 / §4.1
 *
 * 【なぜレジストリか】この報告書は本アプリの肝で、改善要望が絶えず出る前提で作る (spec §1.3)。
 *   章の順序・表示可否・見出し・既定の開閉を `.astro` に直書きすると、要望のたびに
 *   コード変更 → レビュー → デプロイが要る。**`app_config` に出せば admin から即時**になる。
 *
 * 【枠と中身を分ける】`REPORT_AXES` (2 本柱) は**章ではない**。報告書の骨格なので
 *   レジストリに入れず、並べ替えも非表示もしない。材料が無い回でも帯は立つ
 *   (spec §4.-1「§0.3 材料が無い章は出さない、より上位」)。
 *   ここを混同して A に材料が無いタイプ 2 で報告書が B から始まった事故がある。
 */

import { cfg } from './app-config';

// ── 2 本柱 (常設・章ではない) ────────────────────────────────

import type { AxisKey, AxisVM } from './report-model';

/**
 * サービスの 2 本柱 (spec §1.0)。
 *
 * **`title` だけを持たせる。リード文を持たせない。**
 * ポリシーが求めるのは「2 本柱が構造として最初に見えること」であって、
 * ポリシーの説明文を紙面に載せることではない (spec §4.-1)。
 * リードを足すとそれは当社が書いた散文になり §1.0.0 に反する。
 */
/*
 * 【主軸 A「初期がんの早期発見」は廃止・発注者指示 2026-09-17】
 *
 * **受領 JSON に対応するものが無い**枠だった (2 本柱は当社側の整理)。材料が無いので
 * A の帯だけが常設で立ち、カードが 0 枚のまま残る状態になっていた。
 * → **帯ごと廃止。残る 1 本の「B」バッジも外す** (1 本しかないものに記号を振らない)。
 *
 * これに伴い `cancer_finding` は残る軸へ移す。**Elith が
 * `cancer_screening.text` を書いた回に、その所見を紙面から落とさないため**
 * (A の廃止は枠の廃止であって、受領内容を捨てる決定ではない)。
 */
export const REPORT_AXES: readonly AxisVM[] = [
  /*
   * 【「診断」を外した・Wellfort レビュー⑦・2026-09-25】
   * 旧: 'AI 診断による疾病予防アドバイス'。本アプリは医療診断を行わない
   * (ミッション④「独自に分析・解釈しない」) のに柱の見出しが「診断」を名乗っていた。
   * 製品名は既に 2026-08 に「AI 診断結果」→「AI疾病予防報告書」へ改称して
   * 「診断」を外している (display-names.ts:18,21)。柱の見出しもその表記に揃える。
   */
  { key: 'b', title: 'AI 疾病予防アドバイス' },
] as const;

// ── 章レジストリ ────────────────────────────────────────

export interface ChapterSpec {
  key: string;
  /**
   * 見出しの既定値。**空なら受領 JSON の `section_name` を使う。**
   * 当社が言い換えた見出しを作らないため、原則は空にしておく (spec §1.0.0)。
   */
  label: string;
  /** 受領 `report_text.json` のキー。ダイジェスト専用カードは null。 */
  sourceKey: string | null;
  axis: AxisKey;
  /**
   * 全編での既定の開閉。**既定は全章 `true` (畳む)。**
   * 読む面はダイジェストで、全編はそこで選ばれなかった文の置き場だから
   * (spec §1.1 可読化)。開いておくとダイジェストと同じ内容が二重に流れて、
   * 「削減率 1%」でリバートされた旧実装と同じ画面になる。
   * **印刷ビュー (`?print=1`) では無視して全展開する** (spec §3.2 / §4.3)。
   */
  collapsed: boolean;
  /**
   * ダイジェストのカードから「詳しい説明」として送る先の章 (先に在るものを 1 つ選ぶ)。
   *
   * **省略時は自分自身の `key`。** ダイジェスト専用のカード
   * (`sourceKey: null` = 章を持たない) だけ、中身を引いてきた章を明示する。
   * 順に見て**最初に紙面へ出ている章**を採るので、`report.sections.hidden` で
   * 章を隠しても導線が死なない。1 つも無ければ導線を出さない (押しても何も
   * 起きないリンクを置かない・spec §1.3.10 の④)。
   */
  detailKeys?: readonly string[];
}

/**
 * コード既定のレジストリ (spec §4.1 の表)。**固定ではない** — `app_config` で上書きできる。
 *
 * 並びの意図: `medical_visit` を先頭に置くのが今回いちばん効く変更 (spec §4.1)。
 * 受領 PDF ではこれが 6 章目に埋もれ、「最優先の所見」が最後まで読まないと出てこない。
 */
export const CHAPTER_REGISTRY: readonly ChapterSpec[] = [
  // 中身は abstract と summary から選んでいる。着地は先に出るほう (アブストラクト)。
  // **軸 A の廃止で `axis: 'b'` へ移した** (上の `REPORT_AXES` のコメント)。
  // **ラベルを空にした (2026-09-18)。** 「今回の所見」は受領 JSON に 0 件の当社の文言。
  // 見出しは Elith が `cancer_screening.section_name` に書いたものだけを使う。
  { key: 'cancer_finding', label: '',             sourceKey: null,             axis: 'b', collapsed: true,
    detailKeys: ['abstract', 'summary'] },
  { key: 'medical_visit',  label: '',             sourceKey: 'medical_visit',  axis: 'b', collapsed: true },
  { key: 'measurements',   label: '',             sourceKey: 'blood_analysis', axis: 'b', collapsed: true },
  { key: 'summary',        label: '',             sourceKey: 'summary',        axis: 'b', collapsed: true },
  { key: 'abstract',       label: '',             sourceKey: 'abstract',       axis: 'b', collapsed: true },
  { key: 'lifestyle',      label: '',             sourceKey: 'lifestyle',      axis: 'b', collapsed: true },
  // 見出しは Elith 本文の `### 4. 1か月の食事改善プラン` をそのまま使う (当社のラベルを持たない)。
  { key: 'diet_plan',      label: '',             sourceKey: null,             axis: 'b', collapsed: true,
    detailKeys: ['diet'] },
  { key: 'diet',           label: '',             sourceKey: 'diet',           axis: 'b', collapsed: true },
  { key: 'exercise',       label: '',             sourceKey: 'exercise',       axis: 'b', collapsed: true },
  { key: 'sleep',          label: '',             sourceKey: 'sleep',          axis: 'b', collapsed: true },
  { key: 'nutrients',      label: '',             sourceKey: 'nutrients',      axis: 'b', collapsed: true },
  { key: 'references',     label: '',             sourceKey: 'references',     axis: 'b', collapsed: true },
] as const;

const KNOWN_KEYS = new Set(CHAPTER_REGISTRY.map((c) => c.key));

export interface ResolvedChapters {
  chapters: ChapterSpec[];
  /** `report.sections.hidden` で落としたキー。監査に出す (spec §1.3.6)。 */
  hidden: string[];
  /** 設定に書かれていたが解釈できなかったキー。打ち間違いの検知用。 */
  unknown: string[];
}

/** `a,b , c` → `['a','b','c']`。空要素は落とす。 */
function splitList(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** `k=v,k2=v2` → Map。`=` を含まない要素は無視する。 */
function parseAssign(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of splitList(raw)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && v) out.set(k, v);
  }
  return out;
}

/**
 * `app_config` を当てて章の並びを決める。
 *
 * 【打ち間違いで報告書を真っ白にしない】「設定あり」の判定を**生の文字列の有無**で
 * 行うと、`' , , '` や未知キーだけを入れたときに章が 0 件になる。
 * → **解釈できた章が 1 つでもあるか**で判定し、駄目なら**コード既定へ落とす**。
 * 全章を明示的に `hidden` にしたときだけ 0 件を許す。
 *
 * @param read 設定リーダ。既定は `app_config`。回帰テストで差し替える。
 */
export function resolveChapters(read: (key: string) => string = cfg): ResolvedChapters {
  const unknown: string[] = [];
  const collect = (raw: string): string[] => {
    const keys = splitList(raw);
    const ok: string[] = [];
    for (const k of keys) (KNOWN_KEYS.has(k) ? ok : unknown).push(k);
    return ok;
  };

  const orderKeys = collect(read('report.sections.order') ?? '');
  const hiddenKeys = collect(read('report.sections.hidden') ?? '');
  const labels = parseAssign(read('report.sections.labels') ?? '');
  const collapsedKeys = new Set(collect(read('report.sections.collapsed') ?? ''));

  // order は「書いた章だけを書いた順で出す」。解釈できた章が 0 ならコード既定。
  const base = orderKeys.length
    ? orderKeys.map((k) => CHAPTER_REGISTRY.find((c) => c.key === k)!).filter(Boolean)
    : [...CHAPTER_REGISTRY];

  const hidden = new Set(hiddenKeys);
  const chapters = base
    .filter((c) => !hidden.has(c.key))
    .map((c) => ({
      ...c,
      label: labels.get(c.key) ?? c.label,
      collapsed: collapsedKeys.size ? collapsedKeys.has(c.key) : c.collapsed,
    }));

  return { chapters, hidden: [...hidden], unknown };
}

// ── アンカー ────────────────────────────────────────────

/**
 * 見出しから決定論的にアンカー ID を作る (FNV-1a)。
 *
 * **連番にしない。** 章を並べ替えたときに保存済みリンクが別の見出しを指してしまう。
 * 見出し文字列から引くので、並べ替えてもリンクは同じ見出しに刺さる (spec §5.4)。
 */
/**
 * 章そのもののアンカー。**ダイジェストのカードから全編の同じ章へ送る**ために使う
 * (発注者裁定 2026-09-01・案 03「カード下端の淡色バー」)。
 *
 * トピックの `anchorFor` と違って**見出しのハッシュを使わない** — 章は
 * `key` で一意なので、見出しが変わってもリンクが外れないほうがよい。
 */
export function chapterAnchor(chapterKey: string): string {
  return `ch-${chapterKey}`;
}

export function anchorFor(chapterKey: string, heading: string): string {
  let h = 0x811c9dc5;
  const s = `${chapterKey} ${heading}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${chapterKey}-${h.toString(16).padStart(8, '0')}`;
}
