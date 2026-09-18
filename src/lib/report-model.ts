/**
 * AI疾病予防報告書の **表示モデル (ViewModel)**。
 *
 * 正本: docs/elith/AI疾病予防報告書_仕様書.md  ※ § 番号は旧版 docs/旧版・ボツ/ai_prevention_report_generation_spec.md
 *
 * 【この層の役割】受領 JSON の形式と、画面の描き方を切り離す (spec §1.3.3)。
 *   `受領JSON → アダプタ(report-adapter.ts) → 表示モデル(この型) → レンダラ(report.astro)`
 *   **画面はこの型しか知らない。** Elith の形式が変わってもアダプタ 1 枚で吸収する
 *   (Stage2→Stage3 で `判定区分` と `[pN]` が実際に消えた実績がある)。
 *
 * 【この型が持たないもの】
 *   - 当社が書いた散文。**紙面に出る文はすべて受領データからの逐語** (spec §1.0.0)。
 *     この型の文字列フィールドに入れてよいのは Elith の原文だけで、
 *     見出し・ラベルなどの「枠」はレジストリ (report-sections.ts) が持つ。
 *   - 良否の判定。判定は Elith が書いた文をそのまま運ぶ (ミッション④)。
 */

/** 2 本柱 (spec §1.0)。**章ではなく報告書の骨格**なので常設・並べ替えも非表示もしない。 */
export type AxisKey = 'a' | 'b';

export interface AxisVM {
  key: AxisKey;
  /** 見出しのみ。**リードを持たせない** (ポリシーの説明文は紙面に載せない・spec §4.-1)。 */
  title: string;
}

// ── ダイジェスト (紙面の要点) ────────────────────────────────
//
// 可読化の実体はここ (spec §1.1)。受領本文 20,046 字をそのまま流すのではなく、
// **出す文を選んで構造に置く**。選ぶのは当社の仕事だが、出す文は 1 文字も変えない。

/** 見出し＋本文。Elith の `###` / `【】` 見出しをそのまま使う。 */
export interface DigestItem {
  /** Elith の見出し (無ければ空)。当社が言い換えた見出しを作らない。 */
  heading: string;
  /** Elith の原文 (逐語)。複数文になることがある。 */
  text: string;
}

/** 検査値テーブルの 1 行。 */
/**
 * 検査値の 1 行。**受領した検査値ファイルが持っているものだけ** (発注者指示 2026-09-18)。
 *
 * 【`reference` / `judgement` / `tone` / `source` / `variants` を削除した】
 * 受領ファイル (`health_checkup.json` ほか) の各エントリが持つフィールドは
 * **`date` と `value` の 2 つだけ**で、基準値も判定も存在しない (実測)。
 * それらを当社が欄として作り、空欄に「—」を置いて
 * **"欄はあるが該当なし" のように見せていた**。欄ごと廃止する。
 *   - 基準値は Elith が**散文**に書いているので、**本文のまま**章に出る。
 *   - 判定は Elith 自身が「結果票の判定をご確認ください」と本文で言っている
 *     = **Elith は判定を出さない**。当社が欄を作らない。
 *   - 同名別値・本文にしかない値は**監査**に出す (紙面に当社の注記を置かない)。
 */
export interface MeasurementRow {
  /** 受領ファイルのキーから取った項目名。 */
  name: string;
  /** 値＋単位。受領データの表記のまま。 */
  value: string;
}

/** 生活習慣の 1 項目 = 【現状評価】と【行動提案】のペア (spec §4.2.2)。 */
export interface LifestylePair {
  /** Elith の節見出し (例: 飲酒習慣)。 */
  heading: string;
  /** 【現状評価】の冒頭文 (逐語)。 */
  current: string;
  /** 【行動提案】の冒頭文 (逐語)。 */
  action: string;
}

export type DigestBlock =
  | { kind: 'paragraphs'; items: string[] }
  | { kind: 'steps'; items: DigestItem[] }
  | { kind: 'table'; rows: MeasurementRow[] }
  | { kind: 'pairs'; items: LifestylePair[] }
  | { kind: 'weeks'; items: DigestItem[] };

export interface DigestCardVM {
  /** レジストリのキー (report-sections.ts)。 */
  key: string;
  /** カード見出し。Elith の `section_name` か、レジストリ／`app_config` の上書き。 */
  title: string;
  /** どちらの主軸に属すか。 */
  axis: AxisKey;
  /*
   * 【`tone` を削除した・2026-09-18】救急カード (ラベル「すぐ受診」) 専用の値だったが、
   * そのラベルは受領 JSON に無い当社の文言なのでカードごと廃止した。
   */
  blocks: DigestBlock[];
  /** 出典表示 (例: 医療受診の目安 §1〜§4)。どこから引いたかを紙面で辿れるようにする。 */
  source: string;
  /**
   * 全編の同じ章へのアンカー (`#ch-<key>`)。**その章が実際に紙面に在るときだけ入る。**
   * `report.sections.hidden` で章を隠した回に導線を出すと、押しても何も起きない
   * リンクになるため (主軸 A のリンクで一度 404 を出した反省・spec §1.3.10)。
   */
  detailAnchor: string | null;
  /**
   * 冒頭 (ウェルネス年齢の次) に置くカードか。**見本 p1 の並び** = 表紙 → 2 連大数字 →
   * 総括の散文 に合わせるためのもので、いまはアブストラクトだけが立つ
   * (発注者指示 2026-09-03)。主軸の帯より前に出るので、軸ごとの繰り返しからは外す。
   */
  lead?: boolean;
}

// ── 全編 ────────────────────────────────────────────────
//
// ダイジェストの下に置く。**畳んで置く**ので最初の読み出しはダイジェストで終わる。

/** 全編の 1 トピック (`### N.` / `【項目】` 単位)。 */
export interface TopicVM {
  /** 同一 HTML 内のアンカー。見出しのハッシュから決定論的に作る (spec §5.4)。 */
  anchor: string;
  heading: string;
  /** 本文 (Markdown)。組版は report-view.ts が行う。 */
  body: string;
}

export interface ChapterVM {
  key: string;
  /** 章見出し。既定は Elith の `section_name`。 */
  title: string;
  axis: AxisKey;
  /** 既定で畳むか (`report.sections.collapsed`)。**印刷ビューでは無視する**。 */
  collapsed: boolean;
  topics: TopicVM[];
  /**
   * 検査値の全行 (`measurements` 章のみ)。
   * ダイジェストには Elith が判定を書いた項目だけを出し、**受領した全項目はここに出す**。
   * 可読化 = 出す文を選ぶことなので、選から漏れた分を捨てるのではなく後段に置く。
   */
  table?: MeasurementRow[];
}

// ── 表紙 ────────────────────────────────────────────────

export interface CoverVM {
  /** 「〇〇様」。本人への画面表示なので PII 分離の対象外 (spec §4.0.0.1)。 */
  name: string;
  /** 作成日 (受領日)。端末に残した控えの識別に要る (spec §4.4)。 */
  issuedOn: string;
  /** 紙面テンプレートの版 (spec §1.3.9)。 */
  sheetVersion: string;
  /** 検査日。受領 `health_checkup.json` から取れた分。 */
  testedOn: string | null;
  /** 第 N 回 / 全 4 回。`customer.subscriptions` 由来で、タイプ 2 では null。 */
  cycleSeq: number | null;
  cycleTotal: number;
  /**
   * ウェルネス年齢 (Elith 出力の値)。
   * **画面版では描かない。PDF 版 (`?print=1`) の冒頭にだけ置く** (spec §4.0.0.3)。
   */
  wellnessAge: number | null;
  /** 実年齢 (当社 `health_age_scores` 由来)。ウェルネス年齢と並べるときだけ使う。 */
  chronologicalAge: number | null;
}

// ── 監査 (紙面には出さない) ──────────────────────────────

export interface ReportAudit {
  /** 認識できたセクション名。 */
  sections: string[];
  /** ダイジェストに出したカードのキー。 */
  digestCards: string[];
  /** 材料が無くて出さなかったカードのキー。**0 件は異常の兆候** (spec §1.3.6)。 */
  emptyCards: string[];
  /** `report.sections.hidden` で落とした章。 */
  hiddenChapters: string[];
  /** `app_config` に書かれていたが解釈できなかった章キー。 */
  unknownChapterKeys: string[];
  /** 全編のトピック数。 */
  topicCount: number;
  /** 検査値の行数。 */
  measurementCount: number;
  /* 【2026-09-18】表から基準値の欄を廃止したので `referenceCount` は削除した。 */
  /** 受領データの異常。 */
  anomalies: string[];
}

// ── ルート ──────────────────────────────────────────────

export interface ReportVM {
  /** タイプ 2 = 単品購入相当 (がんリスク検査なし)。**アプリが判定する** (spec §1.0.3)。 */
  reportType: 1 | 2;
  /** true = Elith 提供サンプルを表示している (実データ未受領)。 */
  isSample: boolean;
  cover: CoverVM;
  /** 2 本柱。**常設** — 材料の有無で消さない (spec §4.-1)。 */
  axes: AxisVM[];
  /** 紙面の要点。 */
  digest: DigestCardVM[];
  /** 全編。 */
  chapters: ChapterVM[];
  audit: ReportAudit;
}
