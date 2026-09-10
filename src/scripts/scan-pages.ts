/**
 * スキャンの「ページ列」。撮影とアップロードを 1 セッションに積み、**完了時にまとめて**
 * 読み取る (発注者指示 2026-09-04)。
 *
 * 【流れ】
 *   撮影 or アップロード → **1 枚ごとにプレビュー** → 撮り直す / 次の用紙 / 完了
 *   完了 → ここに溜めた全ページを順に `/api/scan` へ投げ、結果を 1 つに束ねる
 *
 * 【なぜ「順に」なのか】
 * まとめて 1 リクエストにはできない。Vercel の関数は 60 秒で切れるため
 * **1 画像 = 1 リクエスト**が本アプリの決まり (CLAUDE.md「インフラ / 実行モデル」)。
 * ここでいうバッチは「撮影中は読まず、完了時に全ページを続けて処理する」という意味。
 *
 * 【前のページには戻らない】(発注者指示)
 * 撮り直せるのは**いま撮った 1 枚だけ**。3 枚前に戻る導線は作らない。
 * 途中で駄目になったときの逃げ道は「最初からやり直し」だけにする。
 */

import type { AnalyzeResult, AnalyzeSource, RegionResult } from './camera-scan';

/**
 * この 1 枚がどの経路で入ったか。
 * 「次の用紙」「撮り直す」を**入れたときと同じ手段で続ける**ために要る
 * (これが無いと、アップロードした人にもカメラが起動する)。
 */
export type ScanPageOrigin = 'camera' | 'file';

export interface ScanPage extends AnalyzeSource {
  /** 表示・削除用の一意キー。 */
  id: string;
  /** アップロード由来ならファイル名。撮影なら null。 */
  name: string | null;
  /** 追加経路。名前の有無から推測しない (PDF/画像とも名前は付くため)。 */
  origin: ScanPageOrigin;
}

/** ページ列。scan.astro が 1 つだけ持つ。 */
export class ScanPageList {
  private pages: ScanPage[] = [];

  get length(): number {
    return this.pages.length;
  }
  get all(): readonly ScanPage[] {
    return this.pages;
  }
  /** いま確認中 (最後に積んだ) の 1 枚。 */
  get last(): ScanPage | null {
    return this.pages[this.pages.length - 1] ?? null;
  }

  add(src: AnalyzeSource, name: string | null, origin: ScanPageOrigin): ScanPage {
    const page: ScanPage = { ...src, id: crypto.randomUUID(), name, origin };
    this.pages.push(page);
    return page;
  }

  /** 「撮り直す」= いま確認中の 1 枚だけ捨てる。 */
  dropLast(): void {
    this.pages.pop();
  }

  /** 「最初からやり直し」= 全部捨てる。 */
  clear(): void {
    this.pages = [];
  }
}

/**
 * 複数ページの解析結果を 1 つに束ねる。
 *
 * **bbox の重ね描きは 1 ページのときだけ**。領域の bbox はそのページの画像に対する
 * 相対座標なので、複数ページ分を 1 枚の画像に重ねると**別の紙の座標を描くことになる**。
 * そこで 2 ページ以上のときは `fullImage` を渡さず、`pageCount` で表示側に知らせる。
 *
 * 領域の見出しには「1枚目/」のように出所を付ける。どの紙から来た表かが
 * 分からなくなると、利用者が値を確認できないため。
 */
export function mergeResults(results: AnalyzeResult[]): AnalyzeResult {
  const usable = results.filter((r): r is AnalyzeResult => r != null);
  if (usable.length === 1) return { ...usable[0], pageCount: 1 };

  const regions: RegionResult[] = [];
  usable.forEach((r, i) => {
    for (const region of r.regions ?? []) {
      regions.push({ ...region, label: `${i + 1}枚目 / ${region.label}` });
    }
  });

  const join = (pick: (r: AnalyzeResult) => string | undefined) =>
    usable.map((r, i) => `## ${i + 1}枚目\n\n${pick(r) ?? ''}`.trim()).join('\n\n');

  return {
    markdown: join((r) => r.markdown),
    markdownClean: join((r) => r.markdownClean),
    regions,
    // 2 ページ以上では重ね描きが成立しないので画像を渡さない (上のコメント)。
    fullImage: undefined,
    sourceKind: usable.some((r) => r.sourceKind === 'pdf') ? 'pdf' : 'image',
    finishReason: usable.find((r) => r.finishReason && r.finishReason !== 'STOP')?.finishReason
      ?? usable[0]?.finishReason,
    pageCount: usable.length,
  };
}
