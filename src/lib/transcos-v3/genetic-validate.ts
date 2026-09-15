// src/lib/transcos-v3/genetic-validate.ts
// トランスコスモス10名 v3.0 — Genetic の完了判定 (§13.4) / semantic audit (§13.5) / §16 検証。
//
// **判定だけ。I/O も生成もしない** (`preflight.ts` / `health-validate.ts` と同じ)。
// 納品 JSON は production 共通 core (`elith-genetic-finalize.ts`) が作ったものを**読むだけ**で、
// **validator の都合で本文を 1 文字も書き換えない** (§13.5 末尾)。

import { GENOPLAN_V1_REQUIRED_PAGES, isGenoplanV1RequiredPage } from '../elith-genetic';
import { subjectByName } from './manifest';

// ---------------------------------------------------------------------------
// §13.4 completeness
// ---------------------------------------------------------------------------

/** この run で読んだページ 1 行ぶん。**行が無いページは「未読」であって「完了」ではない。** */
export interface GeneticPageRow {
  page: number;
  parsed: boolean;
}

export interface GeneticCompleteness {
  ok: boolean;
  required: number;
  /** required set のうち `parsed=true` の行が在るページ数。 */
  done: number;
  /** 行が無い / `parsed=false` の required ページ。 */
  missing: number[];
  /**
   * required set の外なのに読まれていたページ (§13.1 違反)。
   * **completion には数えない**が、**黙って捨てない** — p1〜9 や p36 以降を
   * 読んでいたら、それ自体が止めるべき事実 (LLM 呼び出しが仕様外に出ている)。
   */
  outOfRange: number[];
}

/**
 * §13.4。**required set の 26 ページすべてが `parsed=true`** のときだけ完了。
 * 25/26 は FAIL。**行そのものが無いページも missing。**
 */
export function geneticCompleteness(rows: readonly GeneticPageRow[]): GeneticCompleteness {
  const parsed = new Set<number>();
  const outOfRange: number[] = [];
  for (const r of rows) {
    if (!isGenoplanV1RequiredPage(r.page)) {
      if (Number.isInteger(r.page)) outOfRange.push(r.page);
      continue;
    }
    if (r.parsed) parsed.add(r.page);
  }
  const missing = GENOPLAN_V1_REQUIRED_PAGES.filter((p) => !parsed.has(p));
  return {
    ok: missing.length === 0 && outOfRange.length === 0,
    required: GENOPLAN_V1_REQUIRED_PAGES.length,
    done: parsed.size,
    missing,
    outOfRange: [...new Set(outOfRange)].sort((a, b) => a - b),
  };
}

// ---------------------------------------------------------------------------
// §13.5 semantic audit — **検証用 view だけ。本文は変えない。**
// ---------------------------------------------------------------------------

export interface GeneticAudit {
  ok: boolean;
  /** `項目名` を持つ item の数 (重複込み)。 */
  items: number;
  /** `項目名` で重複を畳んだあとの概念数 (**view だけ。納品 data は畳まない**)。 */
  distinctItems: number;
  /** 同じ `項目名` が複数回出た数。ranking と detail の両方に出るのは想定内。 */
  duplicated: number;
  /** `項目名` を持たない item の数。 */
  unnamed: number;
  reasons: string[];
}

/** 納品 JSON の本文から `data.items` を読む。**無ければ null** (作らない)。 */
function itemsOf(json: Readonly<Record<string, unknown>>): unknown[] | null {
  const data = json['data'];
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return null;
  const items = (data as Record<string, unknown>)['items'];
  return Array.isArray(items) ? items : null;
}

function itemName(v: unknown): string | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const n = (v as Record<string, unknown>)['項目名'];
  return typeof n === 'string' && n.trim() !== '' ? n.trim() : null;
}

/**
 * §13.5。**明らかな空配列 / 極端な欠落 / required key 欠落を BLOCK** する。
 *
 * `minDistinctItems` は「production Golden GenePlanet v1 の risk-item coverage」
 * (§13.5) を呼び出し側から渡す。**ここで勝手な閾値を作らない** —
 * 数字を発明すると「なんとなく少ない」で本物を止めたり、逆に通したりする。
 */
export function geneticSemanticAudit(
  json: Readonly<Record<string, unknown>>,
  opts: { minDistinctItems: number },
): GeneticAudit {
  const reasons: string[] = [];
  for (const key of ['format_id', 'schema_version', 'client_id', 'test_date', 'page_count', 'data']) {
    if (!(key in json)) reasons.push(`required key ${key} が無い`);
  }
  const items = itemsOf(json);
  if (items == null) {
    return { ok: false, items: 0, distinctItems: 0, duplicated: 0, unnamed: 0,
      reasons: [...reasons, 'data.items が配列でない'] };
  }
  if (items.length === 0) reasons.push('data.items が空');

  const seen = new Map<string, number>();
  let unnamed = 0;
  for (const it of items) {
    const n = itemName(it);
    if (n == null) { unnamed += 1; continue; }
    seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  const duplicated = [...seen.values()].filter((c) => c > 1).length;
  if (seen.size > 0 && seen.size < opts.minDistinctItems) {
    reasons.push(`概念数が ${seen.size} で Golden の coverage (${opts.minDistinctItems}) に届かない`);
  }
  if (seen.size === 0 && items.length > 0) reasons.push('項目名を持つ item が 1 件も無い');

  return { ok: reasons.length === 0, items: items.length, distinctItems: seen.size, duplicated, unnamed, reasons };
}

// ---------------------------------------------------------------------------
// §16 Genetic の format validation
// ---------------------------------------------------------------------------

export interface GeneticPassInput {
  subject: string;
  /** この run で読んだページ行。 */
  pages: readonly GeneticPageRow[];
  /** 納品 JSON 本文 (共通 core の出力)。 */
  json: Readonly<Record<string, unknown>> | null;
  /** §13.2 の期待 test_date。**manifest から引く。呼び出し側で today を作らない。** */
  expectedTestDate: string | null;
  minDistinctItems: number;
}

export interface GeneticPassResult {
  subject: string;
  ok: boolean;
  completeness: GeneticCompleteness;
  audit: GeneticAudit | null;
  reasons: string[];
}

export function evaluateGenetic(input: GeneticPassInput): GeneticPassResult {
  const reasons: string[] = [];
  const completeness = geneticCompleteness(input.pages);
  if (completeness.missing.length > 0) {
    reasons.push(`必要ページが ${completeness.done}/${completeness.required} (不足 ${completeness.missing.join(',')})`);
  }
  if (completeness.outOfRange.length > 0) {
    // §13.1 違反。**読んでしまった事実を黙って捨てない。**
    reasons.push(`対象外ページを読んでいる (${completeness.outOfRange.join(',')})`);
  }

  if (input.json == null) {
    return { subject: input.subject, ok: false, completeness, audit: null,
      reasons: [...reasons, '納品 JSON が無い'] };
  }

  const expected = input.expectedTestDate ?? geneticDateOf(input.subject);
  const actual = typeof input.json['test_date'] === 'string' ? (input.json['test_date'] as string) : null;
  if (expected == null) reasons.push('期待 test_date が manifest から引けない');
  else if (actual !== expected) reasons.push(`test_date が違う (期待 ${expected} / 実際 ${actual ?? '—'})`);

  const pageCount = input.json['page_count'];
  if (pageCount !== GENOPLAN_V1_REQUIRED_PAGES.length) {
    reasons.push(`page_count が ${String(pageCount)} (期待 ${GENOPLAN_V1_REQUIRED_PAGES.length})`);
  }

  const audit = geneticSemanticAudit(input.json, { minDistinctItems: input.minDistinctItems });
  const data = input.json['data'];
  const itemCount = data != null && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)['item_count'] : undefined;
  if (typeof itemCount !== 'number' || itemCount <= 0) reasons.push('item_count が 0 以下');
  for (const r of audit.reasons) reasons.push(`semantic audit: ${r}`);

  return { subject: input.subject, ok: reasons.length === 0, completeness, audit, reasons };
}

/** §13.2 の Genetic test_date。**manifest が正本**で、ここで日付を作らない。 */
export function geneticDateOf(subject: string): string | null {
  return subjectByName(subject)?.geneticDate ?? null;
}
