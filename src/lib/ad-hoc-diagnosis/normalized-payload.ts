// 分割分類で保存する「正規化済み解析結果」の組み立てと **PII ゲート**。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §8.1 (PII) / Phase B2.1 §7
//
// **ここが `diagnosis` スキーマへ PII を入れない最後の関門。**
//
// 分割分類では、健診 XLSX と問診を「読んだそのとき」に正規化して DB へ置く。
// そうしないと後工程 (process / ウェルネス年齢 / dry-run) が毎回 ZIP を開き直し、
// **分割した意味が無くなる** (結局 800 秒を超える)。
// ただし置くものを間違えると、**氏名がそのまま診断側の DB に残る**。
// だから「何を入れるか」を allow-list で組み立て、**書き込み前にもう一度 deny-list で検査**する。
import { isBlankCell, type CellValue, type HealthCheckupSheet } from './health-checkup-xlsx';
import type { QuestionnaireNormalized } from './questionnaire';

// ---------------------------------------------------------------------------
// deny-list
// ---------------------------------------------------------------------------

/**
 * **payload のキーに現れてはならない語。**
 *
 * 部分一致で見る (`display_name` も `name` で当たる)。ここに挙げたものが 1 つでも
 * 見つかったら **DB へ書かずに throw** する。「気づかず保存されていた」を作らない。
 */
export const FORBIDDEN_PAYLOAD_KEYS = [
  'name',        // name / full_name / display_name / file_name / filename
  'email',
  'mail',
  'company',
  'organization',
  'job_title',
  'jobtitle',
  'title',
  'path',
  'folder',
  'address',
  'phone',
  'tel',
  'birth',       // date_of_birth / birthday
  'dob',
] as const;

/**
 * **列見出しが個人情報のもの。** こちらは deny-list に当たっても throw しない —
 * 見出しは検査票が持ってくる**データ**であって、こちらのコードの設計ではないため。
 * 該当列は **値ごと落とす**。落とした事実は件数だけ残す (見出し文字列は残さない)。
 */
const PII_HEADER = /(氏\s*名|名\s*前|フリガナ|ふりがな|カナ|ｶﾅ|メール|mail|e-?mail|住所|電話|TEL|会社|所属|部署|役職|生年月日|birth)/i;

/** オブジェクトのキーを再帰的に集める (配列の添字は数えない)。 */
function collectKeys(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 12 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out.add(k);
    collectKeys(v, out, depth + 1);
  }
}

/**
 * **禁止キーが 1 つでもあれば throw する。**
 *
 * 「保存してから消す」ではなく「保存させない」。診断側の DB に一度でも氏名が入ると、
 * バックアップにも監査ログにも残り、後から取り消せない。
 */
export function assertNoPiiKeys(payload: unknown, where: string): void {
  const keys = new Set<string>();
  collectKeys(payload, keys);
  const hits: string[] = [];
  for (const k of keys) {
    const lower = k.toLowerCase();
    for (const bad of FORBIDDEN_PAYLOAD_KEYS) {
      if (lower.includes(bad)) { hits.push(k); break; }
    }
  }
  if (hits.length > 0) {
    // **見つかったキー名だけを出す。値は絶対に出さない** (例外はログへ流れる)。
    throw new Error(`normalized_payload に禁止キー: ${where} [${[...new Set(hits)].sort().join(', ')}]`);
  }
}

// ---------------------------------------------------------------------------
// 健診 XLSX
// ---------------------------------------------------------------------------

/**
 * `buildHealthCheckupJson()` を後から再実行するのに要る最小限。
 *
 * **キー名を短くしてあるのは deny-list を避けるためではない** — `h`/`v` は
 * 見出しと値という構造そのもので、`header`/`value` でも deny-list には当たらない。
 * 行数 × 列数だけ並ぶので短い方が jsonb が小さくなる、という理由。
 */
export interface HealthCheckupPayload {
  kind: 'health_checkup';
  v: 1;
  /** `HealthCheckupSheet.testDate` (DateResolution) をそのまま。 */
  test_date: unknown;
  /** 1 行 = 1 検査。`{ h: 見出し, v: 値 }` の並び。 */
  rows: { h: string; v: string | number | boolean }[][];
  /** 個人情報の列として落とした列数 (**見出しの文字列は残さない**)。 */
  dropped_pii_columns: number;
}

/**
 * 健診シート → 保存する形。
 *
 * **落とすもの 3 つ**:
 *  1. 個人情報の見出しを持つ列 (氏名・カナ・メール・住所…) — 値ごと。
 *  2. `Date` のセル — `sheetRowToMeasurements` が元々除外している (検査日は
 *     `test_date` が別に持つ)。**JSON 化すると `Date` が文字列になり、
 *     復元後に「日付が測定値として混ざる」**ので、ここで確実に落とす。
 *  3. 空欄 (未実施) — これも元々除外される。
 *
 * **`notes` は保存しない。** `health-checkup-xlsx.ts` が `sheet=<シート名>` を
 * 入れており、**シート名が人物の氏名であることがある** (実際にそう作られた ZIP を想定)。
 * 画面表示用の記録であって JSON の再生成には要らない。
 */
export function buildHealthCheckupPayload(sheet: HealthCheckupSheet): HealthCheckupPayload {
  let dropped = 0;
  const seenPiiHeader = new Set<string>();

  const rows = sheet.rows.map((row) => {
    const out: { h: string; v: string | number | boolean }[] = [];
    for (const cell of row) {
      const header = String(cell.header ?? '');
      if (PII_HEADER.test(header)) {
        if (!seenPiiHeader.has(header)) { seenPiiHeader.add(header); dropped++; }
        continue;
      }
      const value = cell.value as CellValue;
      if (isBlankCell(value)) continue;
      if (value instanceof Date) continue;
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
      out.push({ h: header, v: value });
    }
    return out;
  });

  const payload: HealthCheckupPayload = {
    kind: 'health_checkup',
    v: 1,
    test_date: sheet.testDate,
    rows,
    dropped_pii_columns: dropped,
  };
  assertNoPiiKeys(payload, 'health_checkup');
  return payload;
}

/**
 * 保存した形 → `buildHealthCheckupJson()` が受け取れる `HealthCheckupSheet` 相当。
 *
 * **落とした列は戻らない** (戻す材料を持っていない = 意図どおり)。
 * `headers` / `headerRowIndex` / `headerHits` / `notes` は JSON 生成に使われないので
 * 空で埋める (**作らない**)。
 */
export function restoreHealthCheckupSheet(payload: unknown): HealthCheckupSheet | null {
  const p = unwrapEntry(payload, 'health_checkup') as HealthCheckupPayload | null;
  if (!p || p.kind !== 'health_checkup' || !Array.isArray(p.rows)) return null;
  return {
    headerRowIndex: 0,
    headerHits: 0,
    headers: [],
    rows: p.rows.map((r) => r.map((c) => ({ header: c.h, value: c.v }))) as HealthCheckupSheet['rows'],
    testDate: (p.test_date ?? { status: 'absent' }) as HealthCheckupSheet['testDate'],
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// 問診
// ---------------------------------------------------------------------------

/**
 * `buildQuestionnaireJson()` に要るのは **`subject.sex` / `subject.age` /
 * `answers` / `completedAt` の 4 つだけ** (同関数を読んで確認)。
 *
 * **`unmapped` は保存しない** — `UnmappedItem.header` は元の見出しで、
 * 型定義にも「DB へは保存しない」と書いてある。件数だけ残す。
 * **`notes` も保存しない** (画面用の記録)。
 */
export interface QuestionnairePayload {
  kind: 'questionnaire';
  v: 1;
  profile: string;
  sex: 'male' | 'female' | null;
  age: number | null;
  completed_at: unknown;
  answers: Record<string, unknown>;
  mapped_count: number;
  unmapped_count: number;
}

export function buildQuestionnairePayload(q: QuestionnaireNormalized): QuestionnairePayload {
  const payload: QuestionnairePayload = {
    kind: 'questionnaire',
    v: 1,
    profile: q.profile,
    sex: q.subject.sex,
    age: q.subject.age,
    completed_at: q.completedAt,
    answers: q.answers as Record<string, unknown>,
    mapped_count: q.mappedCount,
    unmapped_count: q.unmapped.length,
  };
  /*
   * **`answers` のキーは設問 ID** (`Q-SMOKE` 等) なので deny-list には当たらない。
   * 当たったとしたら設問 ID の付け方が変わったということなので、そこで気づけるよう
   * ここでも検査を通す (通してから DB へ渡す)。
   */
  assertNoPiiKeys(payload, 'questionnaire');
  return payload;
}

// ---------------------------------------------------------------------------
// 1 エントリぶんの入れ物
// ---------------------------------------------------------------------------

/**
 * **1 ファイル = 1 行**に載せる正規化結果。
 *
 * **健診と問診の両方を入れられるようにしてある**のがここの要点。
 * `.xlsx` は「健診としても問診としても読んでみる」ので、分類が後から**管理者に
 * 直される**ことがある (`confirmClassification`)。読んだときの分類だけを保存すると、
 * 直したあとに **その形式の材料が無く黙って納品から落ちる**
 * (ZIP を読み直していた頃は両方その場で作れていたので起きなかった)。
 * → 読めたものは両方保存し、**どちらを使うかは `classified_format_id` が決める**。
 */
export interface EntryPayload {
  kind: 'entry';
  v: 1;
  health_checkup?: HealthCheckupPayload;
  questionnaire?: QuestionnairePayload;
}

/**
 * 読めたものだけを詰める。**どちらも無ければ null** (空の入れ物を作らない)。
 * 遺伝子 PDF はここを通らない (ページは `ad_hoc_diagnosis_pages` が持つ)。
 */
export function buildEntryPayload(input: {
  healthCheckup?: HealthCheckupSheet;
  questionnaire?: QuestionnaireNormalized;
}): EntryPayload | null {
  const out: EntryPayload = { kind: 'entry', v: 1 };
  if (input.healthCheckup) out.health_checkup = buildHealthCheckupPayload(input.healthCheckup);
  if (input.questionnaire) out.questionnaire = buildQuestionnairePayload(input.questionnaire);
  if (!out.health_checkup && !out.questionnaire) return null;
  assertNoPiiKeys(out, 'entry');
  return out;
}

/** 入れ物なら中身を、素の payload ならそのまま返す (旧い形も読めるように)。 */
function unwrapEntry(payload: unknown, want: 'health_checkup' | 'questionnaire'): unknown {
  const p = payload as { kind?: string } | null;
  if (p && p.kind === 'entry') return (p as unknown as Record<string, unknown>)[want] ?? null;
  return payload;
}

export function restoreQuestionnaire(payload: unknown): QuestionnaireNormalized | null {
  const p = unwrapEntry(payload, 'questionnaire') as QuestionnairePayload | null;
  if (!p || p.kind !== 'questionnaire') return null;
  return {
    profile: p.profile as QuestionnaireNormalized['profile'],
    answers: (p.answers ?? {}) as QuestionnaireNormalized['answers'],
    subject: { sex: p.sex ?? null, age: p.age ?? null },
    completedAt: (p.completed_at ?? { status: 'absent' }) as QuestionnaireNormalized['completedAt'],
    unmapped: [],
    mappedCount: p.mapped_count ?? 0,
    notes: [],
  };
}
