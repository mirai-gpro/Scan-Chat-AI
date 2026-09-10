// scripts/lib/make-test-xlsx.mjs
// 検証用の最小 .xlsx を組む。**バイナリを commit しないため**にコードで作る。
// **個人情報は 1 文字も入れない** (氏名欄は '-' 固定)。
import { ZipWriter, Uint8ArrayWriter, TextReader, configure } from '@zip.js/zip.js';
configure({ useWebWorkers: false });

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const COLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 1900 方式のシリアル値 (Excel 既定・起点 1899-12-30)。 */
export function serial1900(y, m, d) {
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}
/** 1904 方式のシリアル値 (起点 1904-01-01)。**1900 方式より 1462 小さい。** */
export function serial1904(y, m, d) {
  return serial1900(y, m, d) - 1462;
}

/**
 * @param {object} o
 * @param {string[]} o.headers          ヘッダー行
 * @param {Array<Array<{v:any,kind:'text'|'number'|'date'}|null>>} o.rows
 * @param {boolean} [o.date1904]        1904 方式にするか
 * @param {boolean} [o.customDateFormat] 日付を組み込み書式でなくユーザー定義書式にするか
 * @param {string}  [o.sheetName]
 * @param {boolean} [o.withCoverSheet]  1 枚目に表紙シートを足すか (シート決め打ちの検出用)
 */
export async function buildXlsx(o) {
  const dateStyle = 1;
  const sheetName = o.sheetName ?? '健診結果';

  const cellXml = (ref, cell) => {
    if (cell == null) return ''; // **出力しない = 空欄**
    if (cell.kind === 'text') return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(cell.v)}</t></is></c>`;
    if (cell.kind === 'date') return `<c r="${ref}" s="${dateStyle}"><v>${cell.v}</v></c>`;
    return `<c r="${ref}"><v>${cell.v}</v></c>`;
  };

  const rowXml = (cells, rowNo) =>
    `<row r="${rowNo}">${cells.map((c, i) => cellXml(`${COLS[i]}${rowNo}`, c)).join('')}</row>`;

  const headerCells = o.headers.map((h) => ({ v: h, kind: 'text' }));
  const body = [headerCells, ...o.rows].map((cells, i) => rowXml(cells, i + 1)).join('');
  const dataSheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;

  const coverSheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>結果一覧 (表紙)</t></is></c></row>
</sheetData></worksheet>`;

  const numFmts = o.customDateFormat
    ? '<numFmts count="1"><numFmt numFmtId="176" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/></numFmts>'
    : '';
  const dateFmtId = o.customDateFormat ? 176 : 14; // 14 = 組み込みの日付書式
  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts}
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="${dateFmtId}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
</styleSheet>`;

  const sheets = o.withCoverSheet
    ? '<sheet name="表紙" sheetId="1" r:id="rId1"/><sheet name="' + esc(sheetName) + '" sheetId="2" r:id="rId2"/>'
    : '<sheet name="' + esc(sheetName) + '" sheetId="1" r:id="rId1"/>';
  const wb = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${o.date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets>${sheets}</sheets></workbook>`;

  const relTargets = o.withCoverSheet
    ? ['worksheets/sheet1.xml', 'worksheets/sheet2.xml']
    : ['worksheets/sheet1.xml'];
  const wbRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relTargets.map((t, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${t}"/>`).join('')}
<Relationship Id="rId${relTargets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const ct = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${relTargets.map((t) => `<Override PartName="/xl/${t}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const files = [
    ['[Content_Types].xml', ct],
    ['_rels/.rels', rels],
    ['xl/workbook.xml', wb],
    ['xl/_rels/workbook.xml.rels', wbRels],
    ['xl/styles.xml', styles],
  ];
  if (o.withCoverSheet) {
    files.push(['xl/worksheets/sheet1.xml', coverSheet], ['xl/worksheets/sheet2.xml', dataSheet]);
  } else {
    files.push(['xl/worksheets/sheet1.xml', dataSheet]);
  }

  const w = new ZipWriter(new Uint8ArrayWriter());
  for (const [name, content] of files) await w.add(name, new TextReader(content));
  return await w.close();
}
