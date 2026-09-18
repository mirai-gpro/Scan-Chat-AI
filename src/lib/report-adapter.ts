/**
 * AI疾病予防報告書 — **受領 JSON → 表示モデル** の変換規則。
 *
 * 正本: docs/elith/AI疾病予防報告書_仕様書.md  ※ § 番号は旧版 docs/旧版・ボツ/ai_prevention_report_generation_spec.md §5
 *
 * 【このモジュールが唯一の変換本体】抽出・整形の規則をここに集約し、`.astro` に
 *   正規表現を散らさない (spec §1.3.4)。本リポジトリには同じ規律の前例がある —
 *   納品整形は `elith-export.ts` の `sanitizeMeasurementsForDelivery()` に集約し、
 *   CLAUDE.md に「二重管理しない」と明記されている。
 *
 * 【絶対の制約 — 紙面に出る文はすべて逐語】(spec §1.0.0)
 *   可読化は **「選択」で行い「圧縮」で行わない**。どの文を出すかを決めるのは当社の仕事だが、
 *   出すと決めた文は 1 文字も変えない。要約・言い換え・語順の入れ替えをしない。
 *   **原文の誤字も直さない** (実データの「基準範囲を上上回っており」はそのまま出す・spec §7.3)。
 *
 * 【アプリは値を評価しない】判定は Elith が書いた文をそのまま運ぶ。
 *   値と基準値を比べて良し悪しを決めない (ミッション④)。
 *
 * 【LLM を使わない】(spec §5.5) 決定論のみ。スキャン側で LLM を後段に置いて
 *   繰り返し捏造を踏んだ実績 (多数決撤回・inventoryReread の幻覚 5 件・VQA の捏造 4 件) が
 *   そのままここにも効く。
 */

import type { ElithSection } from './elith-parser';
import type {
  ChapterVM, CoverVM, DigestBlock, DigestCardVM, DigestItem,
  LifestylePair, MeasurementRow, ReportAudit, ReportVM, TopicVM,
} from './report-model';
import { CHAPTER_REGISTRY, REPORT_AXES, anchorFor, chapterAnchor, resolveChapters } from './report-sections';
import { paragraphizeJa } from './report-view';

/** 紙面テンプレートの版 (spec §1.3.9)。紙面を変えたら上げ、紙面に印字する。 */
export const SHEET_VERSION = 'v1.0';

/** 検査サイクルの総数 (年 4 回・spec §1.0.1)。 */
export const CYCLE_TOTAL = 4;

/*
 * 【パイロット暫定文は削除した・発注者指示 2026-09-17】
 *
 * タイプ 2 の主軸 A「今回の所見」には、Elith へ依頼中の文型そのものを当社の文として
 * 出していた (旧 `PILOT_CANCER_FINDING_TEXT`)。トランスコスモス社 10 名の実データで
 * **Elith 本文が遺伝的がんリスクに言及している回に「気になる点は見当たりませんでした」と
 * 併記され、紙面の中で矛盾した** (Wellfort 指摘 2026-09-16)。
 *
 * → **当社が書いた文は紙面に一切出さない** (spec §1.0.0) へ戻す。A の材料は
 *   ① Elith の `cancer_screening.text` ② `ui.cancer_screening_not_included`
 *   (admin から入力・既定は空) の 2 つだけで、**どちらも無ければカードごと非表示**。
 *   「記載が無いこと ≠ 所見が無いこと」なので、欠落は紙面でなく抽出監査に出す。
 */

// ── 受領 JSON の取り込み (spec §5.1) ──────────────────────────

/** 新形式 (dict) の 1 セクション。 */
interface RawSection { section_name?: unknown; actual_chars?: unknown; text?: unknown }

export interface ParsedReportText {
  sections: ElithSection[];
  /** セクション key (`medical_visit` 等) → セクション。章レジストリの `sourceKey` で引く。 */
  byKey: Map<string, ElithSection>;
  /** Elith 出力のウェルネス年齢。無ければ null。 */
  wellnessAge: number | null;
  /** Elith が返した場合のがん所見 (spec §4.0.1 の依頼形)。未受領なら null。 */
  cancerText: string | null;
  /** Elith が `cancer_screening` に付けた見出し。無ければ null (当社が付けない)。 */
  cancerName: string | null;
  /** 本文の末尾に紛れていた生成メタ行 (章名 → その行)。**黙って消さず監査に出す。** */
  metaLines: { section: string; line: string }[];
}

/**
 * 【本文に紛れる生成メタ行を紙面に出さない・発注者判断 2026-09-17】
 *
 * 受領本文の**末尾**に `全体文字数：3012文字` という Elith 側の生成メタが付いて届くことがある
 * (トランスコスモス社 10 名のうち 4 名の `lifestyle` 章・実測。しかも **4 名とも同じ 3012**
 * なので、その人の本文の実際の字数ですらない)。**報告書の中身ではない**ので紙面に出さない。
 *
 * - **落とすのは「章の末尾にある、この 1 行だけ」**。行ごと落とすので、残りは受領本文の
 *   部分文字列のまま = 逐語ルール (spec §4.1) を壊さない。**文の途中は 1 文字も触らない。**
 * - **黙って消さない。** 落とした行は `metaLines` で監査に出す (先方の不具合が見えなくなる方が困る)。
 * - **恒久策は Elith 側で出さないこと。** ここは受け側の保険で、表記が変われば効かない
 *   (だから監査で「落とした / 落としていない」を見えるようにしておく)。
 */
const GENERATION_META_LINE = /\n\s*全体文字数[：:]\s*[0-9０-９]+\s*文字\s*$/;

/**
 * `report_text.json` を取り込む。
 *
 * **新旧どちらの形式も読む。** 新形式 = dict (`{ health_age, <key>: {section_name, text} }`)、
 * 旧形式 = `ElithSection[]` (`schema_version='elith-v1.0'` の既存行)。
 * DB に旧形式の行が残っているあいだ、片方しか読めないと黙って空になる。
 */
export function parseReportText(raw: unknown): ParsedReportText {
  const sections: ElithSection[] = [];
  const byKey = new Map<string, ElithSection>();
  let wellnessAge: number | null = null;
  let cancerText: string | null = null;
  let cancerName: string | null = null;
  const metaLines: { section: string; line: string }[] = [];

  const push = (key: string, s: ElithSection) => {
    const m = GENERATION_META_LINE.exec(s.text);
    if (m) {
      metaLines.push({ section: s.section_name, line: m[0].trim() });
      s.text = s.text.slice(0, m.index);
    }
    sections.push(s);
    byKey.set(key, s);
  };

  if (Array.isArray(raw)) {
    // 旧形式: section_name しか無いので、レジストリの sourceKey とは section_name で突き合わせる。
    for (const v of raw as ElithSection[]) {
      if (!v || typeof v.section_name !== 'string') continue;
      const s: ElithSection = {
        section_name: v.section_name,
        char_count: Number(v.char_count ?? 0),
        text: String(v.text ?? ''),
      };
      push(legacyKeyOf(v.section_name), s);
    }
    return { sections, byKey, wellnessAge, cancerText, cancerName, metaLines };
  }

  if (!raw || typeof raw !== 'object') return { sections, byKey, wellnessAge, cancerText, cancerName, metaLines };

  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'health_age') {
      // **`null` を 0 にしない。** `Number(null)` は 0 で `Number.isFinite` を通るため、
      // 以前は `health_age: null` の検体 (2026-08-24 受領のタイプ1) で
      // **紙面に「ウェルネス年齢 0」が出て、数直線も 0 歳の位置に点を打っていた** (実測)。
      // 値が無いことと 0 歳であることは別。ここでは null のままにし、
      // **当社が算出した元の値での補完は `buildReportVM` が行う** (下記)。
      if (v != null && v !== '') {
        const n = Number(v);
        if (Number.isFinite(n)) wellnessAge = n;
      }
      continue;
    }
    // Elith へ依頼中の独立フィールド (spec §4.0.1)。未受領のあいだは通らない。
    if (key === 'cancer_screening' && v && typeof v === 'object') {
      const t = (v as { text?: unknown }).text;
      if (typeof t === 'string' && t.trim()) cancerText = t.trim();
      // **見出しも Elith が付けたものだけを使う** (当社が「今回の所見」と名付けない)。
      const nm = (v as { section_name?: unknown }).section_name;
      if (typeof nm === 'string' && nm.trim()) cancerName = nm.trim();
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    const r = v as RawSection;
    if (typeof r.text !== 'string') continue;
    push(key, {
      section_name: typeof r.section_name === 'string' ? r.section_name : key,
      char_count: Number(r.actual_chars ?? String(r.text).length),
      text: r.text,
    });
  }
  return { sections, byKey, wellnessAge, cancerText, cancerName, metaLines };
}

/** 旧形式 (配列) の `section_name` を新形式のキーへ寄せる。 */
const LEGACY_KEY_BY_NAME: Record<string, string> = {
  'アブストラクト': 'abstract',
  '総評': 'summary',
  '検査値フィードバック': 'blood_analysis',
  '食事アドバイス': 'diet',
  '運動アドバイス': 'exercise',
  '睡眠・ストレス管理': 'sleep',
  'ライフスタイル総合': 'lifestyle',
  '医療受診の目安': 'medical_visit',
  '必要とする栄養素/サプリ情報': 'nutrients',
  'リファレンス': 'references',
};
function legacyKeyOf(name: string): string {
  return LEGACY_KEY_BY_NAME[name] ?? name;
}

// ── 文の切り出し ────────────────────────────────────────

/**
 * 冒頭 n 文を**逐語で**返す。文字を足さない・削らない。
 *
 * 「。」で割って先頭から n 個を戻すだけ。原文に「。」が無ければ全体を返す。
 */
export function leadSentences(text: string, n = 1): string {
  const body = text.trim();
  if (!body) return '';
  // 区切り「。」ごと取り出す。**`split('。')` して後から `。` を付け直さないこと** —
  // 原文に「。」が無い断片にまで句点が生えて**原文改変**になる (回帰テストで検出した)。
  const parts = body.match(/[^。]+。|[^。]+$/g);
  if (!parts) return body;
  return parts.slice(0, n).join('').trim();
}

/** `### N. 見出し` / `【見出し】` でブロックに割る。見出しと本文を逐語で返す。 */
interface Block { heading: string; body: string }

function splitByHash(text: string): Block[] {
  const out: Block[] = [];
  const parts = text.split(/^###\s*/m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf('\n');
    const headRaw = (nl < 0 ? p : p.slice(0, nl)).trim();
    const body = (nl < 0 ? '' : p.slice(nl + 1)).trim();
    // 「1. 飲酒習慣」→「飲酒習慣」。番号は Elith の採番であって内容ではない。
    out.push({ heading: headRaw.replace(/^\d+\.\s*/, ''), body });
  }
  return out;
}

function splitByBracket(text: string): Block[] {
  const out: Block[] = [];
  const parts = text.split(/【([^】]+)】/);
  for (let i = 1; i < parts.length; i += 2) {
    out.push({ heading: parts[i].trim(), body: (parts[i + 1] ?? '').trim() });
  }
  return out;
}

/** 章を「トピック」に割る。`###` があればそれだけを使う (無いときだけ `【】`)。 */
export function splitTopics(text: string): Block[] {
  const hash = splitByHash(text);
  if (hash.length) return hash;
  const bracket = splitByBracket(text);
  if (bracket.length) return bracket;
  return [];
}

/**
 * 見出しが 1 つも無い章を **章まるごと 1 ブロック**として返す。
 *
 * 【なぜ要るか】受領形式は世代で変わる。実測 (2026-08-29・本番 DB の 真鍋検体) では
 *   `医療受診の目安` / `ライフスタイル総合` / `必要とする栄養素/サプリ情報` に
 *   `###` も `【】` も無く、`splitTopics` が 0 件を返して**ダイジェストのカードが
 *   全部消えた** (主軸 B が帯だけの白紙になる)。全編の章側は既にこの受け皿を持っていた
 *   (「見出しの無い章は章まるごと 1 トピック」) が、ダイジェスト側に無かった。
 *
 * **中身は足さない。** 見出しが無いことを「見出し = 章名」として扱うだけで、
 * 本文は 1 文字も変えない (spec §1.0.0)。
 */
function topicsOrWhole(section: ElithSection): Block[] {
  const blocks = splitTopics(section.text);
  if (blocks.length) return blocks;
  const body = section.text.trim();
  return body ? [{ heading: '', body }] : [];
}

// ── 検査値 (spec §5.3 / §7.1 / §7.2) ─────────────────────────

/*
 * 【「判定」「基準値」を表の欄として作らない・発注者指示 2026-09-18】
 *
 * ここには `JUDGEMENT_RE` / `toneOf` があり、Elith の散文から判定句を拾って
 * **表の「判定」欄**に入れていた。**これは捏造だった。**
 *
 * 実測 (2026-09-18):
 *   - タイプ1 (2026-08-24 受領) の `blood_analysis` に「判定」は **0 件**。
 *     他章の 3 件は**すべて遺伝子検査の判定**の話で、検査値の判定ではない。
 *   - タイプ2 (2026-08-26 受領) の `blood_analysis` の「判定」4 件は
 *     **4 件とも「結果票の判定をご確認ください」**という原票への誘導。
 *     → **Elith 自身が「検査値の判定は出さない」と本文で明言している。**
 *
 * それを当社が「判定」という欄にし、書いていない行に「—」を置いて
 * **"判定欄はあるが該当なし" のように見せていた**。欄ごと廃止する。
 * 「基準値」も同じ — 受領ファイルに基準値のフィールドは無く、散文にあるだけなので、
 * **散文のまま本文に出す**(全編の章)。表には持ち込まない。
 *
 * **表は受領した検査値ファイルの写しに徹する** = 項目名と値だけ。
 */

/**
 * `名前は 値（基準値：〜）` を拾う。
 *
 * **「基準値」の後ろの区切り文字を問わない。** 受領世代ごとに揺れており、
 * 全角コロンだけを見ていたため本番 DB の検体 (半角 `（基準値: 〜129 mmHg）` が 12 箇所) で
 * **1 件も拾えず、検査値の表が空になった** (実測 2026-08-29)。
 * さらに 2026-08-24 受領のタイプ1 は **コロンが無く `（基準値 0.40〜1.50 mg/dl）`** で、
 * ここでも **0 件 = 表が空**になっていた (実測 2026-09-01)。
 * → 区切りは `：` / `:` / 空白のいずれでもよいものとし、括弧も全角・半角の両方を受ける。
 * **構造 (`名前は 値（基準値 …）`) は 3 世代とも同じ**なので、そこだけに依存する。
 * 実測: この形にしてもタイプ2 の抽出結果は 8 件で**現行と完全一致** (回帰なし)、
 * タイプ1 は 0 → **7 件**。
 */
const VALUE_RE = /([^\s、。（(]+?)(?:は|が)((?:[0-9][^（(、。]*?))[（(]基準値[：:]?\s*([^）)]*)[）)]/g;
/* ↑ **表には使わない** (上のコメント)。本文に基準値が書かれているかを**監査に出すため**だけに残す。 */

/** `health_checkup.json` のキー `項目名 [単位]` を分解する。 */
function splitCheckupKey(key: string): { name: string; unit: string } {
  const m = /^(.*?)\s*\[(.*)\]\s*$/.exec(key);
  return m ? { name: m[1].trim(), unit: m[2].trim() } : { name: key.trim(), unit: '' };
}

/**
 * `585 10^4/ul` → `10^4/ul`。先頭の数値トークンだけを落として残りを単位とみなす。
 *
 * **文字クラスに空白を入れて貪欲に消さないこと。** `[\d.,\s]+` にすると
 * `585 10^4/ul` の単位側の `10` まで食って `^4/ul` になり、単位が一致せず
 * 本文の基準値が結べなくなる (実測)。
 */
function unitOfValue(value: string): string {
  return value.replace(/^[\d.,]+\s*/, '').trim();
}

/**
 * 本文と `health_checkup.json` を突き合わせるキー。
 *
 * **単位の大文字・小文字を潰さないこと。** 2026-08-26 受領分は合成検体で、
 * **単位の小文字 `l` = 人間ドック / 大文字 `L` = 血液検査**という規則で 2 つの検査が
 * 混ざっている (spec §7.0)。`toLowerCase()` すると別検査の値が同一視され、
 * Elith が判定していない行に判定が付く。空白だけ落として大小はそのまま比べる。
 */
function textKey(name: string, unit: string): string {
  return `${name}|${unit.replace(/\s+/g, '')}`;
}

export interface MeasurementResult {
  /**
   * 受領した全行。**受領ファイルのキー順のまま** (原票と並びが揃う)。全編の章の表に出す。
   *
   * 【`digestRows` を廃止した・発注者指示 2026-09-18】
   * 以前は「Elith が本文で取り上げた項目」を選び、本文での言及順に並べ替えて
   * **ダイジェストにも表を出していた**。選び方の根拠 (基準値が本文にあるか) が
   * 紙面のどこにも書けないので、読む人には「なぜこの 7 項目なのか」が分からない。
   * **当社が選んで見せている**ことになるため、ダイジェストの表ごと廃止した。
   */
  rows: MeasurementRow[];
  anomalies: string[];
}

/**
 * 検査値ファイル（複数）を 1 つの辞書へまとめ、**問診の設問を落とす**。
 *
 * 【なぜ要るか】2026-08-24 受領のタイプ1 から検査値ファイルが 3 つになった
 * (`health_checkup` 37 / `blood_test` 42 / `cancer_risk` 2)。しかも **`blood_test` には
 * 問診が 24 件混ざっている** — これは Elith が混ぜたのではなく、デメカルの血液検査 CSV が
 * 問診結果を持ち (`elith-blood-csv.ts` の `項目区分` 2=問診結果)、当社の上りが
 * それを納品しているため。検査値の表にそのまま出すと
 * 「20歳の頃と比べて、今は１０Kg以上増加している = 2」が検査値として並ぶ。
 *
 * 【切り分けの規則・暫定】Elith の JSON には `項目区分` が無いので、**キーの形**で分ける。
 *   設問文 = ひらがな 2 文字以上 ／ 全角括弧 ／ 読点 のいずれかを含む。
 *   実測 (2026-09-01): タイプ1 の 3 ファイル ＋ タイプ2 の `health_checkup` の
 *   計 121 キーで**誤判定 0** (検査値 18/18 を残し、問診 24/24 を外した)。
 *   ※ 文字数で切る規則は破綻する (「夜食や間食が多い」は 8 字)。標準マスタ照合も使えない
 *     (starter は 41 項目で、アルブミン・中性脂肪・血清鉄など本物の検査値が 17 件落ちる)。
 *   **恒久策は Elith に `項目区分` かラベルを残してもらうこと** (§6.4 の確認事項)。
 *
 * 【黙って落とさない】外した設問は件数を監査に出す。
 */
const QUESTIONNAIRE_KEY = /[ぁ-ゖ].*[ぁ-ゖ]|（|、/;

export interface LabFiles {
  health_checkup?: Record<string, { date?: string; value?: unknown }[]> | null;
  blood_test?: Record<string, { date?: string; value?: unknown }[]> | null;
  cancer_risk?: Record<string, { date?: string; value?: unknown }[]> | null;
}

/** `checkup_values` は旧行が素の `health_checkup` 辞書、新行がファイル別の入れ子。両方読む。 */
export function flattenLabFiles(
  raw: Record<string, { date?: string; value?: unknown }[]> | LabFiles | null,
): { checkup: Record<string, { date?: string; value?: unknown }[]> | null; dropped: string[]; cancerItems: string[] } {
  if (!raw) return { checkup: null, dropped: [], cancerItems: [] };
  const grouped = raw as LabFiles;
  const isGrouped = ['health_checkup', 'blood_test', 'cancer_risk'].some(
    (k) => (grouped as Record<string, unknown>)[k] != null,
  );
  const files = isGrouped
    ? [grouped.health_checkup, grouped.blood_test, grouped.cancer_risk]
    : [raw as Record<string, { date?: string; value?: unknown }[]>];

  const out: Record<string, { date?: string; value?: unknown }[]> = {};
  const dropped: string[] = [];
  for (const f of files) {
    if (!f) continue;
    for (const [key, arr] of Object.entries(f)) {
      const name = key.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
      if (QUESTIONNAIRE_KEY.test(name)) { dropped.push(key); continue; }
      if (!(key in out)) out[key] = arr;   // 先勝ち: health_checkup → blood_test → cancer_risk
    }
  }
  /*
   * がんリスク検査の**項目名**。主軸 A で「本文がこの検査に触れた文」を選ぶのに使う。
   * 名前は受領ファイルのキーそのもので、当社が決めた語ではない。
   */
  const cancerItems = Object.keys(grouped.cancer_risk ?? {})
    .map((k) => k.replace(/\s*\[[^\]]*\]\s*$/, '').trim())
    .filter(Boolean);
  return { checkup: Object.keys(out).length ? out : null, dropped, cancerItems };
}

/**
 * 検査値の表を組む。**受領した検査値ファイルの写しに徹する** (発注者指示 2026-09-18)。
 *
 * - 出すのは **項目名と値だけ**。受領ファイルが持つのはこの 2 つ (と日付) だけで、
 *   **基準値・判定のフィールドは存在しない**。無い欄を当社が作らない。
 * - 並びは**受領ファイルのキー順のまま**。並べ替えない。
 * - **同名別値は自動採用しない** (spec §7.1)。両方を行として残し、**監査で報せる**
 *   (紙面に当社の注記「N 通り」を出すのはやめた)。
 * - 本文にしかない値は**本文のまま**章に出る。表へ移さない
 *   (移すと「検査値ファイルに入っていた」ことになるため)。
 */
export function buildMeasurements(
  checkup: Record<string, { date?: string; value?: unknown }[]> | null,
  bloodAnalysis: ElithSection | null,
): MeasurementResult {
  const anomalies: string[] = [];

  /*
   * 【表は受領した検査値ファイルの写しに徹する・発注者指示 2026-09-18】
   *
   * 以前はここで Elith の散文から「基準値」「判定」を拾い、表の欄に入れていた。
   * **受領ファイルに基準値・判定のフィールドは無く、当社が欄を作っていた** = 捏造。
   * 撤去した (上の JUDGEMENT_RE のコメントに実測の根拠)。
   *
   * いま作るのは **項目名と値だけ**。順序も受領ファイルのキー順のまま
   * (「Elith が本文で言及した順」に並べ替えるのも当社の解釈なので行わない)。
   */
  const rows: MeasurementRow[] = [];
  const seenNames = new Map<string, number>();
  const entries = Object.entries(checkup ?? {});

  for (const [key] of entries) {
    const { name } = splitCheckupKey(key);
    seenNames.set(name, (seenNames.get(name) ?? 0) + 1);
  }

  for (const [key, arr] of entries) {
    const { name, unit } = splitCheckupKey(key);
    const first = Array.isArray(arr) ? arr[0] : undefined;
    if (!first || first.value === undefined || first.value === null) continue;
    rows.push({ name, value: unit ? `${first.value} ${unit}` : String(first.value) });
  }

  /*
   * **同名別値は自動採用しない** (spec §7.1)。ただし紙面にバッジ (「N 通り」) を
   * 出すのはやめた — **当社の注記だから**。両方の行をそのまま載せ、監査で報せる。
   */
  for (const [name, count] of seenNames) {
    if (count > 1) anomalies.push(`同名別値: ${name} が ${count} 通り届いています (自動採用しません)`);
  }

  /*
   * **本文に基準値が書かれているかは監査にだけ出す。**
   * 紙面では Elith の散文がそのまま章に出るので、読む人はそこで基準値を読める。
   * 表へ移すと「基準値という欄が届いている」ことになるので持ち込まない。
   */
  if (bloodAnalysis) {
    let inProse = 0;
    for (const block of topicsOrWhole(bloodAnalysis)) {
      VALUE_RE.lastIndex = 0;
      while (VALUE_RE.exec(block.body)) inProse += 1;
    }
    anomalies.push(inProse
      ? `本文 (検査値フィードバック) に基準値の記載が ${inProse} 件あります (紙面では本文のまま出します)`
      : '本文 (検査値フィードバック) に基準値の記載がありません');
  }

  return { rows, anomalies };
}

// ── ダイジェストのカード ────────────────────────────────

/*
 * 【救急カードは削除した・発注者指示 2026-09-18】
 *
 * 2026-09-17 に「当面中止」として `EMERGENCY_CARD_ENABLED = false` で死蔵していたが、
 * ラベル「すぐ受診」は**受領 JSON に無い当社の文言**なので、コードごと消す
 * (残しておくとフラグ 1 つで捏造が復活する)。当該の文は「医療受診の目安」の章に
 * **原文のまま**残るので紙面から文が消えるわけではない。
 * 再開するなら Elith 側に**救急かどうかの印**を出してもらうのが先。
 */

/** 章タイトル。レジストリ／`app_config` の上書きが空なら受領 JSON の `section_name`。 */
function titleOf(key: string, label: string, section: ElithSection | null): string {
  if (label) return label;
  return section?.section_name ?? key;
}

function card(
  key: string, title: string, axis: 'a' | 'b', source: string,
  blocks: DigestBlock[],
): DigestCardVM | null {
  const filled = blocks.filter((b) =>
    (b.kind === 'paragraphs' && b.items.length) ||
    (b.kind === 'steps' && b.items.length) ||
    (b.kind === 'table' && b.rows.length) ||
    (b.kind === 'pairs' && b.items.length) ||
    (b.kind === 'weeks' && b.items.length));
  if (!filled.length) return null;
  // `detailAnchor` は章が出揃ってから入れる (下記)。ここでは決められない。
  return { key, title, axis, blocks: filled, source, detailAnchor: null };
}


/**
 * 【本文の身長・体重に出所を添える (spec §4.13・発注者判断 2026-09-17)】
 *
 * Elith の本文は**問診で本人が申告した値**を引くことがあり、検診・人間ドックの実測値と
 * 食い違って見える (実測: 吉光様 本文 175cm/70kg ⇔ 検診 173.5cm/69.9kg。本文の数値は
 * 共通問診表の申告値と**完全一致**)。**どちらも正しい値**なので上書きはしない。
 * 食い違ったときだけ、その数値の直後に「（問診時）」と**出所だけ**を添える。
 *
 * **これは逐語ルールの唯一の例外**。足すのは `SELF_REPORT_MARK` の 5 文字だけで、
 * 受領本文の文字は 1 文字も足さず・引かず・並べ替えない。回帰チェックはこの印を
 * 取り除いてから部分文字列判定を行う (`verify:report-model`)。
 *
 * **付ける条件は 3 つとも満たすときだけ** (推測で出所を書かない):
 *   ① その項目の検診値がある ② 本文の数値が検診値と違う ③ 本文の数値が問診の申告値と一致
 * どれか欠ければ**紙面は触らず、監査にだけ出す**。
 */
const SELF_REPORT_MARK = '（問診時）';

/** 「標準体重」を先に並べて**先に食わせる** (体重として拾わないため)。 */
const BODY_METRIC_RE = /(標準体重|体重|身長)([^。0-9]{0,6})([0-9]+(?:\.[0-9]+)?)\s*(kg|cm|キロ|センチ)/g;

function annotateSelfReported(
  sections: ElithSection[],
  checkup: Record<string, { date?: string; value?: unknown }[]> | null,
  self: { height?: number | null; weight?: number | null } | null | undefined,
  anomalies: string[],
): void {
  const measured = (name: '身長' | '体重'): number | null => {
    for (const [key, arr] of Object.entries(checkup ?? {})) {
      // `身長 [cm]` のように単位が付く。**「標準体重」と混ざらないよう完全一致で見る。**
      if (key.replace(/\s*\[[^\]]*\]\s*$/, '').trim() !== name) continue;
      const v = Number(arr?.[0]?.value);
      if (Number.isFinite(v)) return v;
    }
    return null;
  };
  const ref = { 身長: measured('身長'), 体重: measured('体重') };
  const said = { 身長: self?.height ?? null, 体重: self?.weight ?? null };
  const unitOk = { 身長: ['cm', 'センチ'], 体重: ['kg', 'キロ'] };
  let marked = 0;

  for (const sec of sections) {
    sec.text = sec.text.replace(BODY_METRIC_RE, (whole, label: string, gap: string, num: string, unit: string) => {
      if (label === '標準体重') return whole;             // 別項目。触らない
      const key = label as '身長' | '体重';
      if (!unitOk[key].includes(unit)) return whole;      // 体重…cm 等は別項目の値
      const n = Number(num);
      const r = ref[key];
      if (r == null || n === r) return whole;             // 検診値が無い / 一致 = 食い違いでない
      if (said[key] == null || n !== said[key]) {
        anomalies.push(`本文の${key} ${num}${unit} が検診の実測値 (${r}) と違いますが、`
          + '問診の申告値と一致しないので出所を書きませんでした');
        return whole;
      }
      marked += 1;
      anomalies.push(`本文の${key} ${num}${unit} は問診時の申告値。検診の実測値は ${r} なので出所を添えました`);
      return `${whole}${SELF_REPORT_MARK}`;
    });
  }
  if (marked) anomalies.push(`出所「${SELF_REPORT_MARK}」を ${marked} 箇所に添えました (紙面で唯一の当社の挿入)`);
}

// ── 本体 ────────────────────────────────────────────────

export interface BuildInput {
  reportText: unknown;
  /**
   * 検査値ファイル。**旧行は素の `health_checkup` 辞書、新行はファイル別の入れ子**
   * (`{ health_checkup, blood_test, cancer_risk }`)。`flattenLabFiles` が両方を受ける。
   */
  checkup: Record<string, { date?: string; value?: unknown }[]> | LabFiles | null;
  /**
   * **問診で本人が申告した身長・体重** (spec §4.13・発注者判断 2026-09-17)。
   *
   * 検診の実測値と食い違うのは異常ではない — **AI 診断を回す時点で問診は最新・検診は
   * 半年前ということがあり、団体検診の計測そのものに疑問を持つ受診者も少なくない**。
   * どちらも正しい値なので、**片方で上書きしない**。食い違うときだけ**出所を示す**。
   * 値が無ければ何もしない (推測で「問診時」と書かない)。
   */
  selfReported?: { height?: number | null; weight?: number | null } | null;
  name: string;
  issuedOn: string;
  isSample: boolean;
  /** その回の入力にがんリスク検査があったか。**アプリが判定する** (spec §1.0.3)。 */
  hasCancerRisk: boolean;
  cycleSeq: number | null;
  chronologicalAge: number | null;
  /** 当社 CABA の算出値。Elith 出力との突合に使う (紙面には出さない・spec §1.3.8)。 */
  ourWellnessAge?: number | null;
  /** 章立ての設定リーダ。回帰テストで差し替える。 */
  readConfig?: (key: string) => string;
}

export function buildReportVM(input: BuildInput): ReportVM {
  const parsed = parseReportText(input.reportText);
  const { chapters: specs, hidden, unknown } = resolveChapters(input.readConfig);
  const sec = (k: string | null) => (k ? parsed.byKey.get(k) ?? null : null);

  const anomalies: string[] = [];
  const digest: DigestCardVM[] = [];
  const emptyCards: string[] = [];

  for (const m of parsed.metaLines) {
    anomalies.push(`受領本文の末尾に生成メタ行があったので紙面から外しました: ${m.section} 「${m.line}」`);
  }

  const lab = flattenLabFiles(input.checkup);
  /*
   * **ダイジェストと全編を組む前**に出所を添える。ここで 1 回やれば、要点にも全編にも
   * 同じ形で出る (2 か所に同じ規則を書かない)。
   */
  annotateSelfReported(parsed.sections, lab.checkup, input.selfReported, anomalies);
  const measured = buildMeasurements(lab.checkup, sec('blood_analysis'));
  anomalies.push(...measured.anomalies);
  if (lab.dropped.length) {
    // **黙って落とさない。** 何件を設問と判断して表から外したかを監査に出す。
    anomalies.push(`血液検査ファイルの設問 ${lab.dropped.length} 件を検査値の表から外しました`
      + ` (例: ${lab.dropped.slice(0, 3).join(' / ')})`);
  }

  // ウェルネス年齢は当社が算出して Elith へ渡した値がそのまま返る = 本来必ず一致する。
  // 不一致は往復のどこかでデータが壊れた兆候 (spec §1.3.8)。**紙面には出さず監査に出す。**
  if (parsed.wellnessAge != null && input.ourWellnessAge != null
      && Math.abs(parsed.wellnessAge - input.ourWellnessAge) > 0.05) {
    anomalies.push(
      `ウェルネス年齢が当社 CABA と不一致: Elith ${parsed.wellnessAge} / 当社 ${input.ourWellnessAge}`);
  }

  /*
   * ── 冒頭のアブストラクト (見本 p1・発注者指示 2026-09-03) ──────────
   *
   * 見本は **2 連大数字のすぐ下に総括の散文**を置く。それに合わせ、アブストラクトを
   * ウェルネス年齢の次に、**全文そのまま**出す (要点の抜き出しをしない = 「そのまま」)。
   *
   * - **見出しを付けない。** 見本 p1 にも見出しは無い (当社が見出しを作らない = 逐語ルール)。
   * - **段落割りは表示の規則をそのまま使う** (`paragraphizeJa` = 2 文ごと)。
   *   文字は 1 文字も増減しないので、各段落は受領本文の部分文字列のまま。
   * - **全編からは外す** (下の章ループで飛ばす)。同じ文が紙面に 2 度出るのを避ける。
   * - `report.sections.hidden` に `abstract` を入れた回は `specs` から消えるので、
   *   ここも自動的に出なくなる。
   */
  const leadSpec = specs.find((x) => x.key === 'abstract') ?? null;
  const leadSection = leadSpec ? sec(leadSpec.sourceKey) : null;
  if (leadSpec && leadSection?.text.trim()) {
    const paragraphs = paragraphizeJa(leadSection.text.trim())
      .split(/\n{2,}/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (paragraphs.length) {
      digest.push({
        key: leadSpec.key,
        title: '',                 // 見本 p1 に見出しは無い
        axis: leadSpec.axis,
        blocks: [{ kind: 'paragraphs', items: paragraphs }],
        source: leadSection.section_name,
        detailAnchor: null,        // 全編から外したので飛び先が無い
        lead: true,
      });
    }
  }

  for (const spec of specs) {
    if (spec.key === 'abstract') continue;   // 冒頭に出したので二重に置かない
    const section = sec(spec.sourceKey);
    const title = titleOf(spec.key, spec.label, section);
    let built: DigestCardVM | null = null;

    switch (spec.key) {
      /*
       * **軸は `spec.axis` を渡す。** ここに 'a' / 'b' をベタ書きしていたため、
       * 軸 A を廃止して `cancer_finding` を b へ移したとき、**表示モデルは 'a' のまま**で
       * 画面から静かに消えた (2026-09-17・`verify:screen` が検出)。
       * レジストリが軸の正。
       */
      /*
       * 【「今回の所見」を廃止した・発注者指示 2026-09-18】
       *
       * ここは 3 つの経路を持っていた:
       *   ① Elith の `cancer_screening.text` をそのまま
       *   ② タイプ1: **がんリスク検査の項目名に触れた文を当社が選ぶ**
       *   ③ `ui.cancer_screening_not_included` (admin が入力した当社の文)
       *
       * **②③ は捏造だった。** ②は文こそ逐語だが、その文を選んで
       * **「今回の所見」という当社の見出しの下に置く**行為が解釈そのもの
       * (実測: 「今回の所見」は受領 JSON に **0 件**)。③に至っては当社が書いた文。
       *
       * → **① だけ残す。** 見出しも Elith が付けた `section_name` を使い、
       *   無ければ見出しを出さない。Elith が書かなかった回は**カードごと出ない**。
       *   ②で拾っていた文は、もともと abstract / summary の文なので
       *   **冒頭の総括と全編の章にそのまま出る** (紙面から消えるわけではない)。
       */
      case 'cancer_finding': {
        if (!parsed.cancerText) break;
        built = card(spec.key, parsed.cancerName ?? '', spec.axis,
          parsed.cancerName ?? '',
          [{ kind: 'paragraphs', items: [parsed.cancerText] }]);
        break;
      }

      // ── 主軸 B ──────────────────────────────────────
      case 'medical_visit': {
        if (!section) break;
        // 見出しの無い世代でも空にしない (`topicsOrWhole` のコメントを参照)。
        const blocks = topicsOrWhole(section);
        const lead = blocks[0];
        const steps: DigestItem[] = blocks.slice(1).map((b) => ({
          heading: b.heading, text: leadSentences(b.body, 1),
        })).filter((s) => s.heading && s.text);
        built = card(spec.key, title, spec.axis,
          steps.length ? `${section.section_name} §1〜§${blocks.length}`
                       : `${section.section_name} 冒頭 2 文`, [
            ...(lead ? [{ kind: 'paragraphs' as const, items: [leadSentences(lead.body, 2)] }] : []),
            { kind: 'steps' as const, items: steps },
          ]);
        break;
      }

      /*
       * 【ダイジェストの表を廃止した・発注者指示 2026-09-18】
       *
       * 受領 57 行のうち 7 行だけを「Elith が本文で取り上げた項目」として抜き、
       * **基準値・判定の欄をつけて**出していた。欄そのものが受領 JSON に無いうえ、
       * **なぜその 7 行なのかは紙面のどこにも書けない**ので、読む人には
       * 「当社が選んだ重要項目」に見える。表ごとやめる。
       *
       * 代わりに**他の章と同じ扱い** = 本文の冒頭 2 文を逐語で出し、
       * 全編への導線を付ける。**受領した全行の表は全編の章に残る**ので、
       * 値が紙面から消えることはない。
       */
      case 'measurements': {
        if (!section) break;
        const blocks = topicsOrWhole(section);
        const lead = blocks[0];
        if (!lead) break;
        built = card(spec.key, title, spec.axis, `${section.section_name} 冒頭 2 文`,
          [{ kind: 'paragraphs', items: [leadSentences(lead.body, 2)] }]);
        break;
      }

      case 'lifestyle': {
        if (!section) break;
        const pairs = buildLifestylePairs(section.text);
        built = card(spec.key, title, spec.axis,
          `${section.section_name} §1〜§${pairs.length}（各節の【現状評価】【行動提案】冒頭文）`,
          [{ kind: 'pairs', items: pairs }]);
        break;
      }

      case 'diet_plan': {
        const diet = sec('diet');
        if (!diet) break;
        const plan = splitTopics(diet.text).find((b) => /食事改善プラン/.test(b.heading));
        if (!plan) break;
        const weeks = splitWeeks(plan.body);
        // **見出しは Elith が本文に書いたものを使う** (当社のラベルを先に当てない)。
        built = card(spec.key, plan.heading || spec.label, 'b',
          `${diet.section_name} §4`, [
            { kind: 'paragraphs', items: [leadSentences(plan.body.split('【第')[0], 2)] },
            { kind: 'weeks', items: weeks },
          ]);
        break;
      }

      case 'nutrients': {
        if (!section) break;
        const blocks = topicsOrWhole(section);
        const hasHeadings = blocks.some((b) => b.heading);
        // 見出しがある世代は各節の冒頭 1 文。無い世代は章の冒頭 2 文
        // (節が無いのに「§1〜§1」と書かないため、出典表記も分ける)。
        const items = hasHeadings
          ? blocks.map((b) => leadSentences(b.body, 1)).filter(Boolean)
          : [leadSentences(blocks[0]?.body ?? '', 2)].filter(Boolean);
        built = card(spec.key, title, spec.axis,
          hasHeadings ? `${section.section_name} §1〜§${blocks.length}`
                      : `${section.section_name} 冒頭 2 文`,
          [{ kind: 'paragraphs', items }]);
        break;
      }

      // それ以外の章はダイジェストに出さず、全編にだけ出す。
      default: break;
    }

    if (built) digest.push(built);
    else if (isDigestChapter(spec.key)) emptyCards.push(spec.key);
  }

  // ── 全編 ────────────────────────────────────────────
  const chapters: ChapterVM[] = [];
  for (const spec of specs) {
    // アブストラクトは冒頭に全文を出したので全編には置かない (重複回避)。
    if (spec.key === 'abstract' && digest.some((c) => c.key === 'abstract')) continue;
    const section = sec(spec.sourceKey);
    if (!section || !section.text.trim()) continue;
    const blocks = splitTopics(section.text);
    const topics: TopicVM[] = blocks.length
      ? blocks.map((b) => ({ anchor: anchorFor(spec.key, b.heading), heading: b.heading, body: b.body }))
      // 見出しの無い章 (アブストラクト / リファレンス) は章まるごと 1 トピック。
      : [{ anchor: anchorFor(spec.key, section.section_name), heading: '', body: section.text.trim() }];
    chapters.push({
      key: spec.key,
      title: titleOf(spec.key, spec.label, section),
      axis: spec.axis,
      collapsed: spec.collapsed,
      topics,
      ...(spec.key === 'measurements' ? { table: measured.rows } : {}),
    });
  }

  /*
   * ダイジェストのカードから、全編の**同じ章**へ送るアンカーを入れる
   * (発注者裁定 2026-09-01・案 03「カード下端の淡色バー」)。
   *
   * **章が実際に在るカードにだけ入れる。** `report.sections.hidden` で章を隠した回に
   * 導線を出すと、押しても何も起きないリンクになる — 主軸 A のリンクで一度
   * 遷移先の無い 404 を出しているので、同じ轍を踏まない (spec §1.3.10 の④)。
   */
  const chapterKeys = new Set(chapters.map((c) => c.key));
  for (const c of digest) {
    const spec = specs.find((x) => x.key === c.key);
    const target = (spec?.detailKeys ?? [c.key]).find((k) => chapterKeys.has(k));
    if (target) c.detailAnchor = chapterAnchor(target);
  }

  /*
   * ウェルネス年齢は **当社が CABA で算出して `HealthAgeData` として Elith へ渡した値**で、
   * Elith は計算しない。したがって Elith が返さなかった (`health_age: null`) ときに
   * **当社の元の値で埋めるのは、新しい数字を作ることではない** (発注者指示 2026-09-01)。
   * 実測: 2026-08-24 受領のタイプ1 は `health_age: null` で、補完が無いと表紙が空になる。
   * どちらを出したかは監査に残す (紙面には出さない)。
   */
  const wellnessAge = parsed.wellnessAge ?? input.ourWellnessAge ?? null;
  if (parsed.wellnessAge == null && input.ourWellnessAge != null) {
    anomalies.push(`ウェルネス年齢が Elith 出力に無いため当社 CABA の値で補完: ${input.ourWellnessAge}`);
  }

  const cover: CoverVM = {
    name: input.name,
    issuedOn: input.issuedOn,
    sheetVersion: SHEET_VERSION,
    testedOn: firstCheckupDate(lab.checkup),
    cycleSeq: input.cycleSeq,
    cycleTotal: CYCLE_TOTAL,
    wellnessAge,
    chronologicalAge: input.chronologicalAge,
  };

  const audit: ReportAudit = {
    sections: parsed.sections.map((s) => s.section_name),
    digestCards: digest.map((c) => c.key),
    emptyCards,
    hiddenChapters: hidden,
    unknownChapterKeys: unknown,
    topicCount: chapters.reduce((n, c) => n + c.topics.length, 0),
    measurementCount: measured.rows.length,
    // 【2026-09-18】表から基準値の欄を廃止したので、行ごとの基準値は数えられない。
    // 本文に基準値の記載が何件あったかは `anomalies` に出る。
    anomalies,
  };

  return {
    reportType: input.hasCancerRisk ? 1 : 2,
    isSample: input.isSample,
    cover,
    axes: [...REPORT_AXES],
    digest,
    chapters,
    audit,
  };
}

// ── 補助 ────────────────────────────────────────────────

/** ダイジェストに出す想定の章か (出なかったら監査で「0 件」を報せる対象)。 */
function isDigestChapter(key: string): boolean {
  return ['cancer_finding', 'medical_visit', 'measurements', 'lifestyle', 'diet_plan', 'nutrients']
    .includes(key);
}

/*
 * 【削除: がんリスク検査に触れた文の抜き出しと、救急文の抜き出し・2026-09-18】
 *
 * `cancerFindingTexts` / `findingsMentioning` / `EMERGENCY_RE` /
 * `findEmergencySentence` をここから消した。どれも **Elith の本文から当社が文を選び、
 * 当社が付けた見出し (「今回の所見」「すぐ受診」) の下に置く**ものだった。
 * 文自体は逐語でも、**選んで名前を付ければ解釈**になる (ミッション④)。
 *
 * 抜き出していた文は、もともと abstract / summary / medical_visit の文なので、
 * **冒頭の総括と全編の章にそのまま出る**。紙面から文が消えるわけではない。
 */

/** `lifestyle` を【現状評価】/【行動提案】のペアにする (spec §4.2.2)。 */
export function buildLifestylePairs(text: string): LifestylePair[] {
  const out: LifestylePair[] = [];
  for (const b of splitByHash(text)) {
    const cur = b.body.split('【現状評価】')[1]?.split('【行動提案】')[0] ?? '';
    const act = b.body.split('【行動提案】')[1] ?? '';
    const current = leadSentences(cur, 1);
    const action = leadSentences(act, 1);
    if (!current && !action) continue;
    out.push({ heading: b.heading, current, action });
  }
  return out;
}

/** `【第1週】…` を週ごとに割る。 */
function splitWeeks(text: string): DigestItem[] {
  const out: DigestItem[] = [];
  const parts = text.split(/【(第\s*\d+\s*週)】/);
  for (let i = 1; i < parts.length; i += 2) {
    const t = leadSentences(parts[i + 1] ?? '', 1);
    if (t) out.push({ heading: parts[i].replace(/\s+/g, ''), text: t });
  }
  return out;
}

/** 受領 `health_checkup.json` から検査日を 1 つ取る。 */
function firstCheckupDate(
  checkup: Record<string, { date?: string; value?: unknown }[]> | null,
): string | null {
  for (const arr of Object.values(checkup ?? {})) {
    const d = Array.isArray(arr) ? arr[0]?.date : undefined;
    if (typeof d === 'string' && d) return d;
  }
  return null;
}

/** 全編の章のうち、ダイジェストに同じ内容を出したもの (章側では畳んでよい)。 */
export const DIGEST_BACKED_CHAPTERS = new Set(['medical_visit', 'lifestyle', 'nutrients']);

/** レジストリの既定キー一覧 (admin の監査表示で使う)。 */
export const ALL_CHAPTER_KEYS = CHAPTER_REGISTRY.map((c) => c.key);
