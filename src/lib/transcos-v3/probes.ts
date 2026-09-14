// src/lib/transcos-v3/probes.ts
// トランスコスモス10名 v3.0 — Preflight の I/O 実装 (§8)。
// **判定は `preflight.ts` が持ち、ここは観測だけ。**
//
// - SHA-256 … Node の crypto
// - マジックバイト … 既存 `archive.magicMatchesExtension()` (規則を 2 つ書かない)
// - PDF ページ数 … **正規の PDF parser (`pdfjs-dist`)**。本文は読まない・保存しない (§8.3)
// - XLSX … 既存 `readWorkbookSheets()` (`read-excel-file` に触れるのはあちら 1 か所)
//
// 【digest だけは raw で読む (§8.4)】
// 既存の問診 adapter は比較のために `normalizeForm()` を通すが、
// **digest は XLSX セルの raw 文字列を trim / NFKC せず** U+001F で join して計算する。
// 列 47 の末尾改行を落とすと別値になる。**この 2 つは別物なので同じ関数にしない。**

import { createHash } from 'node:crypto';
import { extensionOf, magicMatchesExtension } from '../ad-hoc-diagnosis/archive';
import {
  readWorkbookSheets, resolveTestDate, isBlankCell,
  type CellValue,
} from '../ad-hoc-diagnosis/health-checkup-xlsx';
import { DIGEST_SEPARATOR, type TranscosRole } from './manifest';
import { readRawHeaderRow } from './xlsx-raw-header';
import type { FileProbes, XlsxProbe } from './preflight';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** raw header 配列の digest (§8.4)。**trim も NFKC もしない。** */
export function rawHeaderDigest(rawHeaders: readonly string[]): string {
  return createHash('sha256').update(rawHeaders.join(DIGEST_SEPARATOR), 'utf8').digest('hex');
}

/**
 * PDF のページ数。**numPages だけ**を取る。本文も画像も取り出さない (§8.3)。
 * worker / フォントを取りに行かせない設定にする (サーバで取りに行くと落ちる)。
 * 数えられなければ `null` — **推測値を返さない**。
 */
export async function pdfPageCount(bytes: Uint8Array): Promise<number | null> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      // pdf.js は渡した配列を破壊するので複製を渡す。
      data: new Uint8Array(bytes),
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
    }).promise;
    const n = doc.numPages;
    await doc.destroy();
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 問診 XLSX の `完了時刻` の列位置 (1 始まりで 3 列目・Appendix B)。 */
const COMPLETED_AT_COL = 3;

/**
 * XLSX を開いて §8.4 の観測を返す。
 *
 * - `rawHeaders` … 先頭行の **raw セル文字列** (trim しない)
 * - `meaningfulRows` … 見出しより下で、1 セルでも中身がある行の数
 * - `completedAt` … 問診のみ。**Excel native datetime として解決できるか**
 *   (数値シリアルのままなら `unresolved` — **こちらで日付に変換しない**)
 */
export async function xlsxProbe(bytes: Uint8Array, role: TranscosRole): Promise<XlsxProbe | null> {
  let rows: CellValue[][];
  try {
    const sheets = await readWorkbookSheets(bytes);
    rows = sheets[0]?.data ?? [];
  } catch {
    return null;
  }
  /*
   * **見出しは raw で読む** (§8.4)。`read-excel-file` はセル前後の空白を必ず落とすので
   * (実測: `"trail\n"` → `"trail"`)、**あの経路の見出しでは digest が永久に一致しない**。
   * 値・行数・日付は従来どおり `read-excel-file` の担当。
   */
  const rawHeaders = await readRawHeaderRow(bytes);
  if (rawHeaders == null) return null;
  const body = rows.slice(1);
  const meaningfulRows = body.filter((r) => (r ?? []).some((c) => !isBlankCell(c))).length;

  let completedAt: XlsxProbe['completedAt'] = null;
  if (role === 'QUESTIONNAIRE_XLSX') {
    const cell = body.find((r) => (r ?? []).some((c) => !isBlankCell(c)))?.[COMPLETED_AT_COL - 1] ?? null;
    const r = resolveTestDate(cell);
    completedAt = r.status === 'resolved' ? 'resolved' : r.status === 'absent' ? 'absent' : 'unresolved';
  }

  return { rawHeaders, rawDigest: rawHeaderDigest(rawHeaders), meaningfulRows, completedAt };
}

export const nodeProbes: FileProbes = {
  sha256: sha256Hex,
  magicOk: (relPath, head) => magicMatchesExtension(extensionOf(relPath), head),
  pdfPageCount,
  xlsx: xlsxProbe,
};
