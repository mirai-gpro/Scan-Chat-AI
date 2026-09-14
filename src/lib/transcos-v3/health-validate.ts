// src/lib/transcos-v3/health-validate.ts
// トランスコスモス10名 v3.0 — Health の照合 (§10.4 Golden anchors / §10.5 必須 cross-check)。
//
// **ここは判定だけ。I/O も生成もしない** (`preflight.ts` と同じ立て付け)。
// production scan → `finalizeHealthCheckup()` が出した measurements を**読むだけ**で、
// 1 件も足さず・直さず・埋めない。
//
// 【この層の存在理由 = 「比較できなかった」を PASS にしないこと (§10.5)】
// 照合は黙って空になる方向に壊れる。名前が解決できなければ比較は 0 件で終わり、
// **失敗が 0 件なので緑に見える**。だから
//   ①必須項目を**固定した表**から引き ②1 件でも `unresolved` / `not_compared` が
//   残れば **FAIL** ③何が解決しなかったのかを**名指しで返す**。
// 「一致 0 件・不一致 0 件だから OK」という結末を作らない。
//
// 【production の standard master へ synonym を足さない (§10.5 末尾)】
// `HDL-コレステロール` のような印字ゆれを production 側へ足せば通るが、
// **本案件ではやらないと明記されている**。この表は validation 専用で、
// **Health JSON の生成・補完には使わない**。

import { findByAlias, STANDARD_MASTER } from '../standard-master';
import {
  HEALTH_CROSS_CHECK, goldenOf, subjectByName,
  type HealthGolden,
} from './manifest';

// ---------------------------------------------------------------------------
// 値の比較 (§10.4 / §10.5-6)
// ---------------------------------------------------------------------------

/**
 * 数値として exact 比較。**許すのは書式差だけ** (`170` と `170.0`)。
 * 丸め・近似・許容誤差を入れない (入れた瞬間に「だいたい合っている」が通る)。
 */
export function numericEqual(a: unknown, b: unknown): boolean {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na === null || nb === null) return false;
  return na === nb;
}

/** 数値化。**単位つき文字列から数字を掘り出さない** (それは解釈であって読取ではない)。 */
export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '' || !/^[+-]?\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 定性の比較。NFKC + trim 後の**完全一致**のみ (§10.5-6)。 */
export function qualitativeEqual(a: unknown, b: unknown): boolean {
  const n = (v: unknown) => String(v ?? '').normalize('NFKC').trim();
  const x = n(a);
  return x !== '' && x === n(b);
}

// ---------------------------------------------------------------------------
// production 側の measurement を canonical で引く (§10.5-3/4)
// ---------------------------------------------------------------------------

/** `finalizeHealthCheckup()` が返す lean measurement のうち、ここで読む分だけ。 */
export interface LeanMeasurement {
  item_name?: unknown;
  value?: unknown;
  value_num?: unknown;
  unit?: unknown;
}

export type ResolveOutcome =
  | { kind: 'one'; measurement: LeanMeasurement }
  | { kind: 'none' }
  | { kind: 'duplicate'; count: number };

/**
 * production 出力から canonical 1 件を引く。**`findByAlias()` だけを使う** (§10.5-3)。
 * 0 件も 2 件以上も FAIL — **「1 件目を採る」をしない** (どちらが本物か決められないため)。
 */
export function resolveByCanonical(
  measurements: readonly LeanMeasurement[],
  canonical: string,
): ResolveOutcome {
  const hit = measurements.filter((m) => {
    const name = typeof m.item_name === 'string' ? m.item_name : '';
    if (name === '') return false;
    if (name === canonical) return true;
    return findByAlias(name)?.canonical_name === canonical;
  });
  if (hit.length === 1) return { kind: 'one', measurement: hit[0] };
  if (hit.length === 0) return { kind: 'none' };
  return { kind: 'duplicate', count: hit.length };
}

/**
 * **解決しなかった理由を読めるようにする**ための材料 (§20 に operator action が無いので、
 * せめて「何が印字されていて、なぜ届かなかったか」は出す)。
 * production 出力にあるが canonical へ解決しない名前を返す。**直しはしない。**
 */
export function unresolvedNames(measurements: readonly LeanMeasurement[]): string[] {
  const out = new Set<string>();
  for (const m of measurements) {
    const name = typeof m.item_name === 'string' ? m.item_name.trim() : '';
    if (name !== '' && !findByAlias(name)) out.add(name);
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// §10.4 Golden anchors
// ---------------------------------------------------------------------------

export type AnchorStatus = 'match' | 'mismatch' | 'unresolved' | 'duplicate';

export interface AnchorResult {
  anchor: string;
  status: AnchorStatus;
  expected: string;
  /** 実際に読めた値。読めていなければ null。**推測値を入れない。** */
  actual: string | null;
  detail?: string;
}

const ANCHORS: readonly { key: string; canonical: string; of: (g: HealthGolden) => number }[] = [
  { key: '身長', canonical: '身長', of: (g) => g.heightCm },
  { key: '体重', canonical: '体重', of: (g) => g.weightKg },
  { key: '最高血圧', canonical: '最高血圧', of: (g) => g.systolic },
  { key: '最低血圧', canonical: '最低血圧', of: (g) => g.diastolic },
  { key: 'HbA1c(NGSP)', canonical: 'HbA1c(NGSP)', of: (g) => g.hba1cNgsp },
];

export interface GoldenResult {
  subject: string;
  ok: boolean;
  /** source 由来の検査日が Golden と exact 一致したか。 */
  date: AnchorResult;
  anchors: AnchorResult[];
}

/**
 * §10.4。**anchor 欠落も FAIL** — 「読めなかったので比較しない」を作らない。
 * `testDate` は**呼び出し側が確定させた source 由来の日付**。ここで today を作らない。
 */
export function validateGolden(
  subject: string,
  testDate: string | null,
  measurements: readonly LeanMeasurement[],
): GoldenResult {
  const g = goldenOf(subject);
  if (!g) {
    return {
      subject, ok: false,
      date: { anchor: '健診日', status: 'unresolved', expected: '(Golden なし)', actual: testDate },
      anchors: [],
    };
  }
  const date: AnchorResult = {
    anchor: '健診日',
    status: testDate === g.date ? 'match' : testDate == null ? 'unresolved' : 'mismatch',
    expected: g.date,
    actual: testDate,
  };
  const anchors = ANCHORS.map<AnchorResult>((a) => {
    const want = a.of(g);
    const r = resolveByCanonical(measurements, a.canonical);
    if (r.kind === 'none') {
      return { anchor: a.key, status: 'unresolved', expected: String(want), actual: null,
        detail: `production 出力に ${a.canonical} が 1 件も無い` };
    }
    if (r.kind === 'duplicate') {
      return { anchor: a.key, status: 'duplicate', expected: String(want), actual: null,
        detail: `${a.canonical} が ${r.count} 件あり、どれが今回か決められない` };
    }
    const got = r.measurement.value_num ?? r.measurement.value;
    return {
      anchor: a.key,
      status: numericEqual(got, want) ? 'match' : 'mismatch',
      expected: String(want),
      actual: got == null ? null : String(got),
    };
  });
  return { subject, ok: date.status === 'match' && anchors.every((a) => a.status === 'match'), date, anchors };
}

// ---------------------------------------------------------------------------
// §10.5 必須 cross-check (健診日 1 + 測定値 15 = 16 項目)
// ---------------------------------------------------------------------------

export type CrossStatus = AnchorStatus | 'master_missing' | 'source_empty' | 'production_empty';

export interface CrossResult {
  header: string;
  canonical: string;
  status: CrossStatus;
  source: string | null;
  production: string | null;
  detail?: string;
}

export interface CrossCheckResult {
  subject: string;
  ok: boolean;
  /** 比較できた件数 / 必須件数。**16 未満なら必ず ok=false**。 */
  compared: number;
  required: number;
  items: CrossResult[];
  /** production 側で canonical へ解決しなかった印字名 (原因を読むためだけ)。 */
  unresolvedProductionNames: string[];
}

/**
 * §10.5。`supportRow` は **Appendix C の exact header をキーにした生の値**。
 * fuzzy / substring で引かない (呼び出し側が exact header で取り出して渡す)。
 *
 * **「名前解決できなかったので比較しない」は PASS ではない** —
 * 必須 16 項目のうち 1 件でも確定できなければ ok=false。
 */
export function validateCrossCheck(
  subject: string,
  sourceDate: string | null,
  supportRow: Readonly<Record<string, unknown>>,
  measurements: readonly LeanMeasurement[],
): CrossCheckResult {
  const items: CrossResult[] = [];

  // ① 健診日。**測定値ではないので `findByAlias()` へ渡さない** (§10.5)。
  const g = goldenOf(subject);
  const srcDate = normalizeDate(supportRow['健診日']);
  items.push({
    header: '健診日', canonical: '—',
    status: srcDate == null ? 'source_empty'
      : sourceDate == null ? 'production_empty'
        : srcDate === sourceDate && (g == null || srcDate === g.date) ? 'match' : 'mismatch',
    source: srcDate, production: sourceDate,
    detail: g != null && srcDate != null && srcDate !== g.date ? `§10.4 の ${g.date} とも違う` : undefined,
  });

  // ② 測定値 15 項目
  for (const pair of HEALTH_CROSS_CHECK) {
    // step2: required canonical が production master に exact 1 件あるか
    const master = STANDARD_MASTER.filter((i) => i.canonical_name === pair.canonical);
    if (master.length !== 1) {
      items.push({
        header: pair.header, canonical: pair.canonical, status: 'master_missing',
        source: null, production: null,
        detail: `STANDARD_MASTER に ${master.length} 件 (exact 1 件でなければ FAIL)`,
      });
      continue;
    }
    const rawSource = supportRow[pair.header];
    const source = rawSource == null || String(rawSource).trim() === '' ? null : String(rawSource).trim();
    const r = resolveByCanonical(measurements, pair.canonical);
    const production = r.kind === 'one'
      ? stringify(r.measurement.value_num ?? r.measurement.value)
      : null;

    let status: CrossStatus;
    let detail: string | undefined;
    if (source == null) {
      status = 'source_empty';
      detail = `39列XLSX の ${pair.header} が空`;
    } else if (r.kind === 'none') {
      status = 'unresolved';
      detail = `production 出力に ${pair.canonical} が 1 件も無い`;
    } else if (r.kind === 'duplicate') {
      status = 'duplicate';
      detail = `${pair.canonical} が ${r.count} 件`;
    } else if (production == null) {
      status = 'production_empty';
    } else {
      const bothNumeric = toNumber(source) !== null && toNumber(production) !== null;
      status = bothNumeric
        ? (numericEqual(source, production) ? 'match' : 'mismatch')
        : (qualitativeEqual(source, production) ? 'match' : 'mismatch');
    }
    items.push({ header: pair.header, canonical: pair.canonical, status, source, production, detail });
  }

  const compared = items.filter((i) => i.status === 'match').length;
  return {
    subject,
    // **`match` 以外が 1 件でもあれば FAIL** (§10.5-7)。`not_compared` で逃がさない。
    ok: items.every((i) => i.status === 'match'),
    compared,
    required: items.length,
    items,
    unresolvedProductionNames: unresolvedNames(measurements),
  };
}

function stringify(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** `YYYY-MM-DD` へ。**解釈しない** — Date 型か既にその形の文字列だけ受ける。 */
export function normalizeDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// §10.6 人物 1 人ぶんの Health PASS 判定
// ---------------------------------------------------------------------------

export interface HealthPassInput {
  subject: string;
  scanOk: boolean;
  pagesDone: number;
  pagesRequired: number;
  finalizeOk: boolean;
  schemaOk: boolean;
  itemCount: number;
  /** source 由来の検査日。**`today` 由来はここへ来る前に捨てる** (§10.3)。 */
  testDate: string | null;
  measurements: readonly LeanMeasurement[];
  /** 39列XLSX を持つ 5 名のみ。持たない人物は null。 */
  supportRow: Readonly<Record<string, unknown>> | null;
  bodyClientIdOk: boolean;
  bodyFormatIdOk: boolean;
  bodyTestDateOk: boolean;
}

export interface HealthPassResult {
  subject: string;
  ok: boolean;
  golden: GoldenResult;
  cross: CrossCheckResult | null;
  /** 落ちた理由を人が読める形で。空なら PASS。 */
  reasons: string[];
}

export function evaluateHealth(input: HealthPassInput): HealthPassResult {
  const reasons: string[] = [];
  if (!input.scanOk) reasons.push('production scan が成功していない');
  if (input.pagesDone !== input.pagesRequired) {
    reasons.push(`ページが ${input.pagesDone}/${input.pagesRequired}`);
  }
  if (!input.finalizeOk) reasons.push('finalizeHealthCheckup が成功していない');
  if (!input.schemaOk) reasons.push('schema が不正');
  if (!(input.itemCount > 0)) reasons.push('item_count が 0');
  if (input.testDate == null) reasons.push('source 由来の検査日が確定していない');
  if (!input.bodyClientIdOk) reasons.push('body の client_id が一致しない');
  if (!input.bodyFormatIdOk) reasons.push('body の format_id が一致しない');
  if (!input.bodyTestDateOk) reasons.push('body の test_date が一致しない');

  const golden = validateGolden(input.subject, input.testDate, input.measurements);
  for (const a of [golden.date, ...golden.anchors]) {
    if (a.status !== 'match') {
      reasons.push(`Golden ${a.anchor}: ${a.status} (期待 ${a.expected} / 実際 ${a.actual ?? '—'})`);
    }
  }

  // **`supportRow` を持つ人物だけ §10.5 が要る。**
  // 持たない人物へ空の cross-check を作らない (16/16 compared に見えてしまう)。
  let cross: CrossCheckResult | null = null;
  if (input.supportRow != null) {
    cross = validateCrossCheck(input.subject, input.testDate, input.supportRow, input.measurements);
    for (const i of cross.items) {
      if (i.status !== 'match') {
        reasons.push(`cross-check ${i.header}: ${i.status}${i.detail ? ` (${i.detail})` : ''}`);
      }
    }
  }

  return { subject: input.subject, ok: reasons.length === 0, golden, cross, reasons };
}

/** 人物名からこの人が §10.5 の対象かを引く (`hasHealthSupport`)。 */
export function needsCrossCheck(subject: string): boolean {
  return subjectByName(subject)?.hasHealthSupport === true;
}
