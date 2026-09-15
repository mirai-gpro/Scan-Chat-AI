/**
 * スキャンの Markdown を扱う **純関数**だけを置く。
 *
 * 【なぜ切り出したか】同じ整形を**ブラウザ (前景処理) とワーカー (バックグラウンド) の
 * 両方**が使うため (`docs/scan/スキャン非同期処理_仕様書.md` §4.4)。
 * **写して 2 か所に置かない** — 片方だけ直すと、同じ紙から違う結果が出る。
 */

/**
 * 表から指定の列を落とす (推論値・推定値の列を納品前に外すために使う)。
 *
 * **camera-scan.ts から移してきたもの。ロジックは 1 行も変えていない。**
 */
export function stripColumnFromTables(md: string, columnNames: string[]): string {
  const targets = columnNames.map((n) => n.replace(/\s+/g, ''));
  const lines = md.split('\n');
  const out: string[] = [];
  let colIndex = -1; // -1 = 表の外
  for (const line of lines) {
    if (!/^\s*\|/.test(line)) {
      colIndex = -1;
      out.push(line);
      continue;
    }
    // 両端の境界パイプを落としてからセル分解
    const inner = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
    const cells = inner.split('|');
    if (colIndex === -1) {
      // 各表の最初のパイプ行 = ヘッダとみなして対象列を確定
      colIndex = cells.findIndex((c) =>
        targets.some((t) => c.trim().replace(/\s+/g, '').includes(t)),
      );
      if (colIndex === -1) {
        // 対象列が無い表は無加工
        out.push(line);
        continue;
      }
    }
    if (colIndex < cells.length) cells.splice(colIndex, 1);
    out.push('| ' + cells.map((c) => c.trim()).join(' | ') + ' |');
  }
  return out.join('\n');
}

/**
 * 複数ページ分の Markdown を 1 つに束ねる。
 *
 * **見出しに「N枚目」を付ける** — どの紙から来た表かが分からなくなると、
 * 利用者が値を確認できない (`scan-pages.ts` の `mergeResults` と同じ規則)。
 */
export function joinPageMarkdown(parts: readonly string[]): string {
  if (parts.length === 1) return parts[0] ?? '';
  return parts.map((t, i) => `## ${i + 1}枚目\n\n${t ?? ''}`.trim()).join('\n\n');
}
