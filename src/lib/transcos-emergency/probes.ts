// src/lib/transcos-emergency/probes.ts
// Preflight の I/O 実装 (指示書 §8)。**判定は preflight.ts が持ち、ここは観測だけ。**
//
// - SHA-256 … Node の crypto
// - PDF ページ数 … **正規の PDF parser (`pdfjs-dist`)**。
//   `countPdfPages()` の正規表現だけを根拠にしない (§8)。本文は読まない・保存しない。
// - XLSX 先頭行 … 既存 `readWorkbookSheets()`。**`read-excel-file` に触れるのはあちら 1 か所。**

import { createHash } from 'node:crypto';
import { readWorkbookSheets } from '../ad-hoc-diagnosis/health-checkup-xlsx';
import { checkExternalFormSchema, EXTERNAL_FORM_V1_COLUMNS } from '../ad-hoc-diagnosis/external-form-contract';
import type { PreflightProbes } from './preflight';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * PDF のページ数。**numPages だけを取る。** 本文も画像も取り出さない。
 *
 * `useWorkerFetch:false` / `isEvalSupported:false` / `disableFontFace:true` は
 * **サーバで worker やフォントを取りに行かせない**ため (取りに行くと落ちる)。
 * 数えられなければ `null` を返す — **推測値を返さない**。
 */
export async function pdfPageCount(bytes: Uint8Array): Promise<number | null> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      // pdf.js は渡した配列を破壊するので複製を渡す (呼び出し側の bytes を壊さない)。
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

/** XLSX の先頭行。読めなければ null (**空配列と区別する**)。 */
export async function xlsxHeader(bytes: Uint8Array): Promise<readonly unknown[] | null> {
  try {
    const sheets = await readWorkbookSheets(bytes);
    const first = sheets[0]?.data ?? [];
    const head = first[0];
    return Array.isArray(head) ? head : null;
  } catch {
    return null;
  }
}

export const nodeProbes: PreflightProbes = { sha256: sha256Hex, pdfPageCount, xlsxHeader };

/**
 * 問診 XLSX の Golden 62 列判定。
 * **Golden 本体は既存の専用 contract が持つ** (`EXTERNAL_FORM_V1_COLUMNS`)。
 * ここで 62 本の見出しを書き写さない — 2 か所に持つと片方だけ古くなる。
 */
export const goldenChecks = {
  questionnaireHeaderOk(h: readonly unknown[] | null): { ok: boolean; detail: string } {
    if (h == null) return { ok: false, detail: '先頭行を読めない' };
    const r = checkExternalFormSchema(h);
    if (r.ok) return { ok: true, detail: '' };
    const first = r.mismatches[0];
    return {
      ok: false,
      detail: `列 ${r.columnCount}/${EXTERNAL_FORM_V1_COLUMNS.length}`
        + (first ? ` / 最初の相違 col ${first.index}` : ''),
    };
  },
};
