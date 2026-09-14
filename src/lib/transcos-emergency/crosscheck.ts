// src/lib/transcos-emergency/crosscheck.ts
// トランスコスモス10名 緊急専用 v2.0 — **健診補助 XLSX との決定論 cross-check** (§10)。
//
// 【この層の役割】
// 補助 XLSX (entry 23/28/33/38/43 の 5 名) は **HealthCheckupData の生成元ではない**。
// 独立した照合源として、健診 PDF のスキャン結果と**重複する項目だけ**を突き合わせる。
// **明確な不一致が 1 件でもあれば、その人物を要確認で止める** (他の人物は続ける)。
//
// 【推測しない】(§10 / §26)
//   - 名称対応を推測しない … 両側とも **production の `findByAlias`** (完全一致・
//     危険同義語を弾く標準マスタ) を通して**同じ canonical_name に落ちたときだけ**比べる。
//     ここで独自の別名表を作らない。
//   - 単位が違うものを比べない … **同一単位のときだけ**比較する。
//     換算は標準マスタが持つ係数がある場合だけ (それも無ければ「比較しない」)。
//   - **XLSX にしかない値を HealthCheckupData へ補完しない** (§10 / §26-11)。
//     この層は 1 つも値を作らない。出すのは「合っている / 合っていない / 比べていない」だけ。

import { findByAlias } from '../standard-master';
import type { HealthCheckupSheet } from '../ad-hoc-diagnosis/health-checkup-xlsx';

/** 比較のうち 1 件ぶん。 */
export interface CrossCheckItem {
  /** 標準マスタの canonical_name (落ちなかったものは元の見出し)。 */
  name: string;
  pdf: string | null;
  xlsx: string | null;
  unit: string | null;
  status: 'match' | 'mismatch' | 'not_compared';
  /** `not_compared` の理由。**黙って飛ばさない。** */
  reason?: string;
}

export interface CrossCheckResult {
  /** 明確な不一致。**1 件でもあればその人物を止める。** */
  mismatches: CrossCheckItem[];
  matched: number;
  notCompared: number;
  items: CrossCheckItem[];
}

/** 数値として読めるか。読めなければ null (**丸めない・推測しない**)。 */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (s === '') return null;
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 単位の表記ゆれを潰す (大小・空白・全角のみ。**意味は変えない**)。 */
function unitKey(u: unknown): string {
  return String(u ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/**
 * 有効数字を揃えたうえでの一致判定。
 * **丸めで一致を作らない** — 小数第 1 位まで一致しても、桁が違えば不一致。
 * 片方が整数 (例 `170`)、片方が `170.0` のような書式差だけを吸収する。
 */
function sameNumber(a: number, b: number): boolean {
  const decimals = Math.min(
    (String(a).split('.')[1] ?? '').length,
    (String(b).split('.')[1] ?? '').length,
  );
  const f = 10 ** decimals;
  return Math.round(a * f) === Math.round(b * f);
}

interface Side { name: string; value: string | null; unit: string | null }

/** スキャン結果 (lean measurement) を比較用に均す。 */
function fromMeasurements(measurements: readonly Record<string, unknown>[]): Side[] {
  return measurements.map((m) => ({
    name: String(m.name ?? m.item_name ?? ''),
    value: m.value == null ? null : String(m.value),
    unit: m.unit == null ? null : String(m.unit),
  }));
}

/**
 * 補助 XLSX を比較用に均す。
 * **1 行目 (= その人物の行) だけを見る。** 行が複数あるときは呼び出し側が止める。
 */
function fromSheet(sheet: HealthCheckupSheet): Side[] {
  const row = sheet.rows[0] ?? [];
  return row.map((c) => ({
    name: String(c.header ?? ''),
    value: c.value == null ? null : String(c.value),
    unit: null, // 39 列様式は見出しに単位が混ざる形なので、単位は名寄せ後に標準単位で見る
  }));
}

/** 標準マスタの canonical_name。落ちなければ null (**当て推量で寄せない**)。 */
function canonical(name: string): string | null {
  return findByAlias(name)?.canonical_name ?? null;
}

export function crossCheckHealth(input: {
  measurements: readonly Record<string, unknown>[];
  support: HealthCheckupSheet | null;
  /** スキャンで確定した検査日。 */
  pdfTestDate: string | null;
}): CrossCheckResult {
  const items: CrossCheckItem[] = [];
  if (!input.support) {
    return { mismatches: [], matched: 0, notCompared: 0, items };
  }

  // ── 検査日 ──────────────────────────────────────────────────────────────
  const x = input.support.testDate;
  if (x.status === 'resolved' && input.pdfTestDate) {
    items.push({
      name: '検査日', pdf: input.pdfTestDate, xlsx: x.date, unit: null,
      status: x.date === input.pdfTestDate ? 'match' : 'mismatch',
    });
  } else {
    items.push({
      name: '検査日', pdf: input.pdfTestDate, xlsx: null, unit: null,
      status: 'not_compared',
      reason: x.status === 'resolved' ? 'pdf_test_date_unresolved' : `xlsx_test_date_${x.status}`,
    });
  }

  // ── 項目 ───────────────────────────────────────────────────────────────
  const pdfSides = fromMeasurements(input.measurements);
  const xlsxSides = fromSheet(input.support);

  /** canonical_name → その側の値 (**同じ名前が 2 つ出たら比べない** = 取り違えを作らない)。 */
  const index = (sides: Side[]) => {
    const map = new Map<string, Side[]>();
    for (const s of sides) {
      const c = canonical(s.name);
      if (!c) continue;
      map.set(c, [...(map.get(c) ?? []), s]);
    }
    return map;
  };
  const pdfIdx = index(pdfSides);
  const xlsxIdx = index(xlsxSides);

  for (const [name, xs] of xlsxIdx) {
    const ps = pdfIdx.get(name);
    if (!ps) continue; // 片側にしか無い = 重複項目ではない。**補完もしない。**
    if (ps.length !== 1 || xs.length !== 1) {
      items.push({
        name, pdf: null, xlsx: null, unit: null, status: 'not_compared',
        reason: 'same_name_appears_twice',
      });
      continue;
    }
    const p = ps[0];
    const q = xs[0];
    if (p.value == null || q.value == null || p.value === '' || q.value === '') {
      items.push({
        name, pdf: p.value, xlsx: q.value, unit: p.unit, status: 'not_compared',
        reason: 'value_absent',
      });
      continue;
    }
    const std = findByAlias(name);
    // 単位が両側にあって食い違うときは**比べない** (換算を推測しない)。
    if (p.unit && q.unit && unitKey(p.unit) !== unitKey(q.unit)) {
      items.push({
        name, pdf: p.value, xlsx: q.value, unit: `${p.unit} / ${q.unit}`,
        status: 'not_compared', reason: 'unit_differs',
      });
      continue;
    }
    const pn = num(p.value);
    const qn = num(q.value);
    if (pn == null || qn == null) {
      // 定性項目は文字列の完全一致で見る (正規化は互換文字だけ)。
      const same = String(p.value).normalize('NFKC').trim() === String(q.value).normalize('NFKC').trim();
      items.push({
        name, pdf: p.value, xlsx: q.value, unit: p.unit ?? std?.unit ?? null,
        status: same ? 'match' : 'mismatch',
      });
      continue;
    }
    items.push({
      name, pdf: p.value, xlsx: q.value, unit: p.unit ?? std?.unit ?? null,
      status: sameNumber(pn, qn) ? 'match' : 'mismatch',
    });
  }

  return {
    mismatches: items.filter((i) => i.status === 'mismatch'),
    matched: items.filter((i) => i.status === 'match').length,
    notCompared: items.filter((i) => i.status === 'not_compared').length,
    items,
  };
}
