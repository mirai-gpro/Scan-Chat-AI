// src/lib/ad-hoc-diagnosis/health-checkup-xlsx.ts
// 臨時診断バッチ: 健診 XLSX → 測定値。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §5.3.8.1 / §7.2 / §11 / §14
//
// **このファイルは Scan-Chat-AI のサーバ側でだけ動く**（spec §5.3.8.1・発注者指示）。
// ブラウザが触るのは ZIP の部分読み / SHA-256 / pdf.js の 3 つだけ。
//
// **`read-excel-file` の API をここから外へ漏らさない**（v9 で API が変わった実績があるため・
// spec §5.3.8）。外に出すのは下の `HealthCheckupSheet` だけ。
//
// ===========================================================================
// 【最重要】日付を勝手に作らない（発注者指示 2026-09-10・spec §5.3.8.1）
// ===========================================================================
// Excel はセルに日付を**シリアル値（数値）**で持つ。これを日付へ直すには
// ブックが 1900 方式か 1904 方式かを決める必要があり、**決め打ちすると 4 年ずれた日付を
// 静かに作る = 捏造**になる。
//
//   ライブラリが `Date` を返した   → そのまま採る
//   ライブラリが数値のまま返した   → **こちらで日付へ変換しない。**
//                                    数値のまま持ち `needs_review` にして人に確認させる
//
// `test_date` は Elith 納品パス `date/{YYYY_MM_DD}`（§15）と 🎯 照合の両方を決めるので、
// **1 日ずれると納品先が変わる**。**`test_date` が確定しない人物は納品しない。**

import { findHeaderRow, HEALTH_CHECKUP_HEADERS, normalizeHeader } from './classify';

/** セルの生の値。`read-excel-file` が返し得る型に合わせる。 */
export type CellValue = string | number | boolean | Date | null;

export interface HealthCheckupRow {
  /** 見出し（正規化前の原文）。 */
  header: string;
  value: CellValue;
}

/** 日付として確定できたか。**`unresolved` は納品させない。** */
export type DateResolution =
  | { status: 'resolved'; date: string /* YYYY-MM-DD */ }
  | { status: 'absent' }
  | { status: 'unresolved'; raw: number | string; reason: string };

export interface HealthCheckupSheet {
  /** ヘッダー行の 0 始まり index。 */
  headerRowIndex: number;
  /** ヘッダーに一致した目印の件数（§7.2 の閾値判定に使った値）。 */
  headerHits: number;
  /** 見出し（原文）。 */
  headers: string[];
  /** データ行。1 行 = 1 検査（多くの様式では 1 人 1 行）。 */
  rows: HealthCheckupRow[][];
  /** 検査日。**確定できなければ `unresolved`**。 */
  testDate: DateResolution;
  /** 実測の記録（§5.3.8.1 の 5 点）。**画面と監査に出す。** */
  notes: string[];
}

// ---------------------------------------------------------------------------
// 日付
// ---------------------------------------------------------------------------

/** `Date` を `YYYY-MM-DD` にする。**タイムゾーンで日がずれないよう UTC で読む。** */
export function toIsoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** `2026-03-29` / `2026/3/29` / `2026年3月29日` を ISO へ。**それ以外は null。** */
export function parseJapaneseDateString(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/.exec(t);
  if (!m) return null;
  const [, y, mo, d] = m;
  const yi = Number(y), mi = Number(mo), di = Number(d);
  if (mi < 1 || mi > 12 || di < 1 || di > 31) return null;
  // 実在する日か（2026-02-30 を通さない）
  const dt = new Date(Date.UTC(yi, mi - 1, di));
  if (dt.getUTCFullYear() !== yi || dt.getUTCMonth() !== mi - 1 || dt.getUTCDate() !== di) return null;
  return `${yi}-${String(mi).padStart(2, '0')}-${String(di).padStart(2, '0')}`;
}

/**
 * セルの値から検査日を決める。**推測しない。**
 *
 * - `Date`   → 採る（ライブラリが日付と判定できている）
 * - 文字列   → 明示的な日付表記のときだけ採る（**文字列の中に日付は作らない**）
 * - **数値** → **採らない。`unresolved`。**
 *   シリアル値を日付へ直すには 1900/1904 のどちらかを決める必要があり、
 *   決め打ちは **4 年ずれた日付を静かに作る**（spec §5.3.8.1）。
 * - 空       → `absent`
 */
export function resolveTestDate(value: CellValue): DateResolution {
  if (value == null || value === '') return { status: 'absent' };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return { status: 'unresolved', raw: String(value), reason: 'invalid_date_object' };
    }
    return { status: 'resolved', date: toIsoDate(value) };
  }
  if (typeof value === 'number') {
    // **ここで変換しない。** カスタム日付書式をライブラリが判定できなかった場合に来る。
    return {
      status: 'unresolved',
      raw: value,
      reason: 'excel_serial_number_needs_confirmation',
    };
  }
  if (typeof value === 'string') {
    const iso = parseJapaneseDateString(value);
    if (iso) return { status: 'resolved', date: iso };
    return { status: 'unresolved', raw: value, reason: 'unrecognized_date_string' };
  }
  return { status: 'unresolved', raw: String(value), reason: `unexpected_type(${typeof value})` };
}

// ---------------------------------------------------------------------------
// 空欄と 0 の区別（spec §5.3.8.1-4）
// ---------------------------------------------------------------------------

/**
 * 「未実施（空欄）」と「値が 0」を区別する。
 * **区別できないと未実施の項目に 0 が入る = 捏造**なので、ここは潰さない。
 *
 * `0` は値。`null` / `undefined` / 空文字 / 空白だけ は未実施。
 */
export function isBlankCell(v: CellValue): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  return false; // 0 も false も「値がある」
}

// ---------------------------------------------------------------------------
// シートの読み取り
// ---------------------------------------------------------------------------

/**
 * 行列（`read-excel-file` が返す 2 次元配列）から健診シートを組み立てる。
 *
 * **ライブラリを直接呼ばない**ので、この関数は**サーバでもテストでも同じように動く**
 * （実物 XLSX が無い環境でも回帰チェックが書ける）。
 */
export function buildHealthCheckupSheet(rows: readonly (readonly CellValue[])[]): HealthCheckupSheet {
  const notes: string[] = [];
  const asText = rows.map((r) => r.map((c) => (c == null ? '' : String(c))));
  const scan = findHeaderRow(asText, HEALTH_CHECKUP_HEADERS);

  if (scan.rowIndex < 0) {
    return {
      headerRowIndex: -1,
      headerHits: 0,
      headers: [],
      rows: [],
      testDate: { status: 'absent' },
      notes: ['header_row_not_found'],
    };
  }

  const headers = asText[scan.rowIndex].map((h) => h.trim());
  const dataRows = rows.slice(scan.rowIndex + 1);

  // 見出しが空の列は落とす（結合セルの余りが空列として来るため）
  const usable = headers
    .map((h, i) => ({ h, i }))
    .filter((x) => x.h !== '');
  if (usable.length !== headers.length) {
    notes.push(`empty_header_columns(${headers.length - usable.length})`);
  }

  const built: HealthCheckupRow[][] = [];
  for (const r of dataRows) {
    // 全部空の行は捨てる（表の下の余白）。**0 だけの行は捨てない。**
    if (usable.every((x) => isBlankCell(r[x.i] ?? null))) continue;
    built.push(usable.map((x) => ({ header: x.h, value: (r[x.i] ?? null) as CellValue })));
  }

  // 検査日: 見出しに「健診日」を含む列（§7.2 の目印と同じ語）
  let testDate: DateResolution = { status: 'absent' };
  const dateCol = usable.find((x) => normalizeHeader(x.h).includes('健診日'));
  if (dateCol && built.length > 0) {
    const cell = built[0].find((c) => c.header === dateCol.h);
    testDate = resolveTestDate(cell ? cell.value : null);
    if (testDate.status === 'unresolved') {
      // **理由だけ残す。値そのものは残さない**（PII ではないが、監査に生値を積まない流儀に合わせる）
      notes.push(`test_date_unresolved(${testDate.reason})`);
    }
  } else if (!dateCol) {
    notes.push('test_date_column_not_found');
  }

  return {
    headerRowIndex: scan.rowIndex,
    headerHits: scan.hits,
    headers,
    rows: built,
    testDate,
    notes,
  };
}

/**
 * XLSX のバイト列を読む。**`read-excel-file` に触れる唯一の場所。**
 *
 * 返すのは `buildHealthCheckupSheet` の結果だけなので、
 * ライブラリを差し替えることになってもここ 1 か所で済む（spec §5.3.8 の弱点対策）。
 *
 * **v9 の既定 export は「シートの配列」を返す**（`Sheet[] = { sheet, data }[]`。
 * 実測: `node_modules/read-excel-file/types/Sheet.d.ts`）。**行の配列ではない。**
 * v8 以前は行の配列だったので、**ここは版が変わると黙って壊れる**箇所。
 *
 * **シート番号を決め打ちしない** — 健診ブックの 1 枚目が表紙・凡例のことがあるため、
 * **全シートを見出しの一致数で採点し、いちばん高いものを採る**。
 * 同点なら先に出てきたシート（後ろを優先すると集計シートを掴む）。
 */
export async function readHealthCheckupXlsx(bytes: Uint8Array): Promise<HealthCheckupSheet> {
  // 遅延 import。**ブラウザ向けバンドルに入れない**ためと、
  // 読めない XLSX で機能全体を巻き込まないため。
  const mod = await import('read-excel-file/node');
  const readXlsxFile = (mod as unknown as {
    default: (input: unknown) => Promise<{ sheet: string; data: CellValue[][] }[]>;
  }).default;

  const sheets = await readXlsxFile(Buffer.from(bytes));
  if (!Array.isArray(sheets) || sheets.length === 0) {
    return {
      headerRowIndex: -1, headerHits: 0, headers: [], rows: [],
      testDate: { status: 'absent' }, notes: ['workbook_has_no_sheets'],
    };
  }

  let best: HealthCheckupSheet | null = null;
  let bestName = '';
  for (const s of sheets) {
    const built = buildHealthCheckupSheet(s.data ?? []);
    if (!best || built.headerHits > best.headerHits) {
      best = built;
      bestName = s.sheet;
    }
  }
  const chosen = best!;
  chosen.notes.push(`sheet=${bestName}`, `sheet_count=${sheets.length}`);
  return chosen;
}
