// src/lib/ad-hoc-diagnosis/classify.ts
// 臨時診断バッチ: ファイル分類の決定論部。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §7
//
// **ファイル名だけに依存しない。** 拡張子・中身のヘッダー・PDF 内テキストを組み合わせる。
// **XLSX は LLM へ送らない**（決定論 parser で読む・指示書 §7）。
//
// **この層は「どの format_id か」を決めるだけ。** 値の抽出はしない。
// 抽出は format ごとのパーサ（`health-checkup-xlsx.ts` ほか）が受け持つ。

/** Elith の format_id（既存 5 種 + Other）。**この機能のために増やさない。** */
export type FormatId =
  | 'HealthCheckupData'
  | 'CancerRiskAssessmentData'
  | 'GeneticTestResultData'
  | 'BloodTestData'
  | 'LifestyleQuestionnaireData'
  | 'Other';

/** 受け付ける format_id の集合。**この機能のために増やさない** (§15.2)。 */
export const ELITH_ALLOWED_FORMATS: FormatId[] = [
  'HealthCheckupData',
  'CancerRiskAssessmentData',
  'GeneticTestResultData',
  'BloodTestData',
  'LifestyleQuestionnaireData',
  'Other',
];

/** 分類の確からしさ。3 値（spec §7.1）。 */
export type Confidence = 'confirmed' | 'probable' | 'needs_review';

/** ファイルの位置づけ。 */
export type SourceKind = 'person_file' | 'batch_reference' | 'ignored';

export interface Classification {
  sourceKind: SourceKind;
  /** `ignored` / `batch_reference` / 判定不能なら null。 */
  formatId: FormatId | null;
  confidence: Confidence;
  /** なぜそう判定したか（監査・画面表示用）。**中身の値は入れない。** */
  reason: string;
}

// ---------------------------------------------------------------------------
// 判定 1: 無視するもの（spec §7.1-1）
// ---------------------------------------------------------------------------

/**
 * OS やアプリが勝手に作るファイル。**検査データではない**ので分類対象から外す。
 * `~$` = Office の一時ファイル / `__MACOSX`・`.DS_Store` = macOS が ZIP に混ぜるもの。
 */
export function isNoiseEntry(path: string): boolean {
  const segments = path.split('/');
  const base = segments[segments.length - 1] ?? '';
  if (base.startsWith('~$')) return true;
  if (base === '.DS_Store' || base === 'Thumbs.db') return true;
  if (segments.includes('__MACOSX')) return true;
  if (base.startsWith('._')) return true; // macOS の AppleDouble
  return false;
}

// ---------------------------------------------------------------------------
// 判定 2: 人物フォルダの中か外か（spec §7.1-2）
// ---------------------------------------------------------------------------

/**
 * 人物のまとまりを決める。**ZIP の中の「人物フォルダ」= ルート直下の階層**。
 *
 * **フォルダ名は保存しない**（氏名を含み得る・§8.1）が、
 * **どのファイルが同じ人物か**を決めるためにその場では使う。
 *
 * @param path 正規化済みパス
 * @param rootPrefix 全エントリの共通の先頭ディレクトリ（`10名の検査データ/` など）。無ければ ''
 * @returns 人物フォルダのパス。人物フォルダの外にあるファイルは null
 */
export function personFolderOf(path: string, rootPrefix: string): string | null {
  const rel = rootPrefix && path.startsWith(rootPrefix) ? path.slice(rootPrefix.length) : path;
  const parts = rel.split('/').filter((s) => s !== '');
  // `人物A/健診.pdf` → 人物フォルダ = `人物A`
  // `10名の情報.xlsx`（直下）→ 人物フォルダ無し = バッチ共通の資料
  if (parts.length < 2) return null;
  return (rootPrefix ?? '') + parts[0];
}

/**
 * 全エントリに共通する先頭ディレクトリを求める。
 * ZIP が `Foo/` 1 枚に包まれている形と、直に人物フォルダが並ぶ形の**両方を同じに扱う**ため。
 * **共通の先頭が無ければ ''**（推測で剥がさない）。
 */
export function commonRootPrefix(paths: readonly string[]): string {
  const dirs = paths
    .filter((p) => p.includes('/'))
    .map((p) => p.split('/')[0]);
  if (dirs.length === 0 || dirs.length !== paths.length) return '';
  const first = dirs[0];
  return dirs.every((d) => d === first) ? `${first}/` : '';
}

// ---------------------------------------------------------------------------
// 判定 3・4: XLSX のヘッダー一致（spec §7.2 / §7.3）
// ---------------------------------------------------------------------------

/** 健診 XLSX の目印。**6 件中 4 件以上**で健診とみなす（spec §7.2）。 */
export const HEALTH_CHECKUP_HEADERS = [
  '健診日',
  '身長',
  '体重',
  'BMI',
  '収縮期血圧',
  '拡張期血圧',
] as const;
export const HEALTH_CHECKUP_MIN_HITS = 4;

/** 問診 XLSX の目印。**3 件以上**で問診とみなす（spec §7.3）。 */
export const QUESTIONNAIRE_HEADERS = [
  '既往歴',
  '喫煙',
  '飲酒',
  '食事',
  '運動',
  '睡眠',
  'ストレス',
] as const;
export const QUESTIONNAIRE_MIN_HITS = 3;

/**
 * 見出しの表記ゆれを吸収する。**全角空白・空白・改行を落として比較する**だけ。
 * **語そのものは変えない**（別名への読み替えをここでやらない＝当て推量を持ち込まない）。
 */
export function normalizeHeader(s: string): string {
  return s.replace(/[\s　]/g, '');
}

/**
 * 1 行のヘッダー候補が、目印のうち何件を含むか。
 * **部分一致で数える** — 実物の見出しは `収縮期血圧(mmHg)` のように単位が付くため。
 */
export function countHeaderHits(row: readonly string[], markers: readonly string[]): number {
  const cells = row.map((c) => normalizeHeader(String(c ?? '')));
  return markers.filter((m) => cells.some((c) => c.includes(normalizeHeader(m)))).length;
}

export interface HeaderScan {
  /** 最も一致数の多かった行の 0 始まり index。見つからなければ -1。 */
  rowIndex: number;
  hits: number;
}

/**
 * ヘッダー行を探す。**1 行目固定にしない**（spec §7.2）。
 * 先頭 `limit` 行を走査し、**最も一致数の多い行**をヘッダーとする。
 * 同点なら**先に出てきた行**（後ろの行を優先すると、集計行を掴む）。
 */
export function findHeaderRow(
  rows: readonly (readonly string[])[],
  markers: readonly string[],
  limit = 10,
): HeaderScan {
  let best: HeaderScan = { rowIndex: -1, hits: 0 };
  const n = Math.min(rows.length, limit);
  for (let i = 0; i < n; i++) {
    const hits = countHeaderHits(rows[i] ?? [], markers);
    if (hits > best.hits) best = { rowIndex: i, hits };
  }
  return best;
}

// ---------------------------------------------------------------------------
// 判定 5: Genoplan PDF（spec §7.4）
// ---------------------------------------------------------------------------

/**
 * Genoplan の検査キー形式のファイル名か。
 * 出典: `wellfort_admin_lab_upload_spec.md` 付録 A-3（`XXXX-XXXX-XXXX`）。
 */
const GENOPLAN_KEY_RE = /(^|[^0-9A-Za-z])[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}([^0-9A-Za-z]|$)/;

export function looksLikeGenoplanFilename(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return GENOPLAN_KEY_RE.test(base.replace(/\.pdf$/i, ''));
}

/** PDF から抽出したテキストに Genoplan の識別要素があるか。 */
export function hasGenoplanMarker(text: string | null | undefined): boolean {
  if (!text) return false;
  return /genoplan|ジェノプラン/i.test(text);
}

// ---------------------------------------------------------------------------
// 判定 6・7: PDF の語彙（spec §7.1-6/7）
// ---------------------------------------------------------------------------

export const HEALTH_CHECKUP_PDF_TERMS = [
  '健康診断', '人間ドック', '健診', '身長', '体重', '血圧', '血糖', '尿検査', '心電図',
] as const;
export const HEALTH_CHECKUP_PDF_MIN_HITS = 3;

export const QUESTIONNAIRE_PDF_TERMS = [
  '問診', '既往歴', '喫煙', '飲酒', '運動習慣', '睡眠', 'ストレス',
] as const;
export const QUESTIONNAIRE_PDF_MIN_HITS = 3;

export function countTermHits(text: string | null | undefined, terms: readonly string[]): number {
  if (!text) return 0;
  const t = normalizeHeader(text);
  return terms.filter((w) => t.includes(normalizeHeader(w))).length;
}

// ---------------------------------------------------------------------------
// 分類の本体
// ---------------------------------------------------------------------------

export interface ClassifyInput {
  /** 正規化済みパス。 */
  path: string;
  /** 小文字・ドット付き拡張子。 */
  ext: string;
  /** 人物フォルダの中か（`personFolderOf` が null でない）。 */
  inPersonFolder: boolean;
  /** XLSX の先頭行（読めたときだけ）。読めなければ null。 */
  sheetRows?: readonly (readonly string[])[] | null;
  /** PDF から抽出したテキスト（取れたときだけ）。取れなければ null。 */
  pdfText?: string | null;
}

/**
 * 決定論の分類（spec §7.1）。**上から順に評価する。**
 *
 * **判定できないものは `needs_review`。** 当て推量で format を付けない
 * （誤った format で納品すると、Elith 側では気づけない）。
 */
export function classifyFile(input: ClassifyInput): Classification {
  // 1. ノイズ
  if (isNoiseEntry(input.path)) {
    return { sourceKind: 'ignored', formatId: null, confidence: 'confirmed', reason: 'noise_entry' };
  }

  // 2. 人物フォルダの外 = バッチ共通の資料
  if (!input.inPersonFolder) {
    return {
      sourceKind: 'batch_reference',
      formatId: null,
      confidence: 'confirmed',
      reason: 'outside_person_folder',
    };
  }

  const person = (formatId: FormatId | null, confidence: Confidence, reason: string): Classification => ({
    sourceKind: 'person_file',
    formatId,
    confidence,
    reason,
  });

  // 3・4. XLSX はヘッダーで決める（LLM へ送らない）
  if (input.ext === '.xlsx') {
    if (input.sheetRows && input.sheetRows.length > 0) {
      const hc = findHeaderRow(input.sheetRows, HEALTH_CHECKUP_HEADERS);
      const q = findHeaderRow(input.sheetRows, QUESTIONNAIRE_HEADERS);
      // **両方の閾値を満たしたら決めない。** どちらとも言えるものを片方に寄せない。
      const hcOk = hc.hits >= HEALTH_CHECKUP_MIN_HITS;
      const qOk = q.hits >= QUESTIONNAIRE_MIN_HITS;
      if (hcOk && qOk) {
        return person(null, 'needs_review', `xlsx_ambiguous(hc=${hc.hits},q=${q.hits})`);
      }
      if (hcOk) return person('HealthCheckupData', 'confirmed', `xlsx_health_headers(${hc.hits})`);
      if (qOk) return person('LifestyleQuestionnaireData', 'confirmed', `xlsx_questionnaire_headers(${q.hits})`);
      return person(null, 'needs_review', `xlsx_headers_below_threshold(hc=${hc.hits},q=${q.hits})`);
    }
    // 読めなかった XLSX を拡張子だけで健診と決めない
    return person(null, 'needs_review', 'xlsx_unreadable');
  }

  // 5. Genoplan PDF
  if (input.ext === '.pdf') {
    const nameHit = looksLikeGenoplanFilename(input.path);
    const textHit = hasGenoplanMarker(input.pdfText);
    if (nameHit && textHit) {
      return person('GeneticTestResultData', 'confirmed', 'genoplan_name_and_text');
    }
    if (nameHit || textHit) {
      // **片方だけでは probable**（spec §7.4）。管理者の確認を通す。
      return person('GeneticTestResultData', 'probable', nameHit ? 'genoplan_name_only' : 'genoplan_text_only');
    }

    // 6・7. 語彙で寄せる（どちらも probable 止まり）
    const hcHits = countTermHits(input.pdfText, HEALTH_CHECKUP_PDF_TERMS);
    const qHits = countTermHits(input.pdfText, QUESTIONNAIRE_PDF_TERMS);
    const hcOk = hcHits >= HEALTH_CHECKUP_PDF_MIN_HITS;
    const qOk = qHits >= QUESTIONNAIRE_PDF_MIN_HITS;
    if (hcOk && qOk) return person(null, 'needs_review', `pdf_ambiguous(hc=${hcHits},q=${qHits})`);
    if (hcOk) return person('HealthCheckupData', 'probable', `pdf_health_terms(${hcHits})`);
    if (qOk) return person('LifestyleQuestionnaireData', 'probable', `pdf_questionnaire_terms(${qHits})`);
    return person(null, 'needs_review', `pdf_terms_below_threshold(hc=${hcHits},q=${qHits})`);
  }

  // 8. それ以外
  return person(null, 'needs_review', `unclassified_ext(${input.ext})`);
}

/**
 * 人物 1 人が `ready` になれるか（spec §7.1 の但し書き）。
 * **`probable` / `needs_review` が 1 件でもあれば false** — 管理者の確認を通す。
 */
export function subjectIsAutoReady(classifications: readonly Classification[]): boolean {
  return classifications
    .filter((c) => c.sourceKind === 'person_file')
    .every((c) => c.confidence === 'confirmed');
}

/** 表示用のファイル名（spec §8.1）。**元の文字列は保存しない。** */
export function displayNameFor(formatId: FormatId | null, seq: number, ext: string): string {
  const label: Record<string, string> = {
    HealthCheckupData: '健診',
    CancerRiskAssessmentData: 'がんリスク',
    GeneticTestResultData: '遺伝子',
    BloodTestData: '血液',
    LifestyleQuestionnaireData: '問診',
    Other: 'その他',
  };
  const head = formatId ? (label[formatId] ?? 'その他') : '未分類';
  return `${head}_${String(seq).padStart(2, '0')}${ext}`;
}
