// src/lib/transcos-v3/xlsx-raw-header.ts
// トランスコスモス10名 v3.0 — **XLSX の先頭行を raw のまま読む** (§8.4 / Appendix B)。
//
// 【なぜ専用の読み手が要るか・実測 2026-09-14】
// 仕様の raw header digest は「XLSX セルの raw 文字列を **trim / NFKC せず**
// U+001F で join した SHA-256」で、**列 47 は末尾改行 `\n` を含む**。
// ところが既存の `readWorkbookSheets()` が使う `read-excel-file` は
// **セルの前後の空白を必ず落とす**（実測:
//   `"trail\n"` → `"trail"` / `"trail "` → `"trail"` / `" lead"` → `"lead"` /
//   `"tab\t"` → `"tab"`。**内部の改行 `"mid\nline"` は保たれる**）。
// つまりあの経路では**列 47 の末尾改行が消え、raw digest は永久に一致しない**
// = Preflight が T+3 で必ず落ちる。
//
// → digest のためだけに、XLSX (= ZIP) の中の worksheet XML から
//    **先頭行のテキストをそのまま**取り出す。
//    **値・行数・日付の解釈は従来どおり `read-excel-file` の担当**で、ここでは何も解釈しない。
//    (規則を 2 つ持つのではなく、「raw を見る役」と「値を読む役」を分ける)

import { ZipReader, Uint8ArrayReader, TextWriter, type FileEntry } from '@zip.js/zip.js';

/** XML のテキストを素に戻す。**数値文字参照も含めてそのまま**。 */
function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** `<t>` の中身を出現順に連結する (rich text の run をまたいで 1 セル 1 文字列)。 */
function joinTextRuns(xml: string): string {
  const out: string[] = [];
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g)) {
    out.push(m[1] == null ? '' : unescapeXml(m[1]));
  }
  return out.join('');
}

/** `A1` / `AB12` → 0 始まりの列番号。 */
export function columnIndexOf(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref.toUpperCase())?.[1] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

async function readEntry(bytes: Uint8Array, path: string): Promise<string | null> {
  const zr = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const entries = await zr.getEntries();
    /*
     * `Entry` は `directory` で判別される union で、`getData` は file 側にしか無い。
     * **ここで型を絞る** (絞らずに呼ぶと型エラーになるうえ、directory を読もうとする)。
     */
    const e = entries.find((x): x is FileEntry => !x.directory && x.filename === path);
    if (!e) return null;
    return await e.getData(new TextWriter());
  } catch {
    return null;
  } finally {
    await zr.close().catch(() => {});
  }
}

/** workbook の 1 枚目の worksheet のパス。解決できなければ既定を返す。 */
async function firstSheetPath(bytes: Uint8Array): Promise<string> {
  const wb = await readEntry(bytes, 'xl/workbook.xml');
  const rels = await readEntry(bytes, 'xl/_rels/workbook.xml.rels');
  const rid = wb ? /<sheet\b[^>]*r:id="([^"]+)"/.exec(wb)?.[1] : null;
  if (rid && rels) {
    const re = new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`);
    const target = re.exec(rels)?.[1];
    if (target) {
      const clean = target.replace(/^\/+/, '').replace(/^xl\//, '');
      return `xl/${clean}`;
    }
  }
  return 'xl/worksheets/sheet1.xml';
}

/**
 * 先頭行のセルを **raw 文字列のまま**、列順に返す。
 * 読めなければ null (**空配列と区別する** — 空配列は「1 行目が空」の意味になる)。
 *
 * **ここでは trim も NFKC もしない。値の解釈もしない。**
 */
export async function readRawHeaderRow(xlsxBytes: Uint8Array): Promise<string[] | null> {
  const sheetPath = await firstSheetPath(xlsxBytes);
  const sheet = await readEntry(xlsxBytes, sheetPath);
  if (sheet == null) return null;

  const rowXml = /<row\b[^>]*\br="1"[^>]*>([\s\S]*?)<\/row>/.exec(sheet)?.[1]
    // `r` 属性が無いブックもあるので、その場合は最初の `<row>` を使う。
    ?? /<row\b[^>]*>([\s\S]*?)<\/row>/.exec(sheet)?.[1];
  if (rowXml == null) return null;

  let shared: string[] | null = null;
  const cells = new Map<number, string>();

  for (const m of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
    const attrs = (m[1] ?? m[3] ?? '');
    const body = m[2] ?? '';
    const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (!ref) continue;
    const col = columnIndexOf(ref);
    const t = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';

    if (t === 's') {
      // 共有文字列。**必要になったときだけ**読む。
      if (shared === null) {
        const ss = await readEntry(xlsxBytes, 'xl/sharedStrings.xml');
        shared = ss == null ? [] : [...ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)]
          .map((x) => joinTextRuns(x[1] ?? ''));
      }
      const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '-1');
      cells.set(col, shared[idx] ?? '');
      continue;
    }
    if (t === 'inlineStr') {
      cells.set(col, joinTextRuns(body));
      continue;
    }
    if (t === 'str') {
      cells.set(col, unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''));
      continue;
    }
    // 数値・真偽・日付シリアルは見出しに現れない想定だが、**黙って落とさず**素で入れる。
    cells.set(col, unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''));
  }

  if (cells.size === 0) return [];
  const max = Math.max(...cells.keys());
  return Array.from({ length: max + 1 }, (_, i) => cells.get(i) ?? '');
}
