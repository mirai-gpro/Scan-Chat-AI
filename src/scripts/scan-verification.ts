/**
 * 撮影 → AI 解析 → 「ユーザー検証」フェーズの UI コントローラ。
 *
 * ユーザーが経るフロー (docs/proposals/scan_chat_medical_ai_proposal.pdf + 5/24 仕様確認):
 *   1. 撮影画像から「表全体」だけを切り出した画像を上部に表示
 *   2. 各ブロック (region) を bbox に基づいて緑/黄/赤の半透明矩形でオーバーレイ
 *   3. ブロックをタップ → そのブロックの表データをテキスト一覧表示。
 *      確度高 = 緑、疑念あり = 黄。
 *   4. 疑念行をタップ → 手入力修正 or 「このまま OK」を選択
 *   5. 全疑念が解消されると画像オールグリーンになり「確認して送信」が活性化
 *      → /chat に遷移 (Phase 0、データはメモリ保持)
 *
 * 永続化 (docs/architecture/diagnostic_session_data_spec.md §3.2):
 *   - Gemini 生 markdown は scan_artifacts.content に**そのまま保存されない**
 *   - 確定 scan_md = ユーザー検証 (編集 + userConfirmed) を反映した markdownClean
 *   - 現状は localStorage に diagnostic_id 単位で行状態を保存し、ページ再ロード時に復元
 */

import { marked } from 'marked';
import type { AnalyzeResult, RegionResult } from './camera-scan';

// ============================================================
// 公開ヘルパー: テーブル解析、疑念判定、Markdown 再構築
// ============================================================

export interface TableCell {
  raw: string;
}
export interface TableRow {
  cells: string[];
  /** Markdown 上の元の 1 行 (パイプ込みの生テキスト) */
  rawLine: string;
}
export interface TableModel {
  headers: string[];
  rows: TableRow[];
  /** ヘッダ行と区切り行を含む先頭 2 行 (再構築用) */
  preamble: string[];
}

/**
 * 領域本文から GFM テーブルをパースする。テーブルが無ければ null。
 * 表は本文中に 1 つだけ存在する前提 (複数表が混在する領域は未対応)。
 */
export function parseTable(body: string): TableModel | null {
  const lines = body.split('\n');
  const tableLineIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|/.test(lines[i])) tableLineIndexes.push(i);
  }
  if (tableLineIndexes.length < 3) return null;
  const tableLines = tableLineIndexes.map((i) => lines[i].trim());
  const headers = splitRow(tableLines[0]);
  // 区切り行 (`|---|---|`) をスキップして残りがデータ行
  const separatorIdx = tableLines.findIndex((l) =>
    /^\|[\s\-:|]+\|?$/.test(l),
  );
  if (separatorIdx < 0) return null;
  const dataLines = tableLines.slice(separatorIdx + 1);
  const rows = dataLines.map((line) => ({
    cells: splitRow(line),
    rawLine: line,
  }));
  return {
    headers,
    rows,
    preamble: [tableLines[0], tableLines[separatorIdx]],
  };
}

function splitRow(line: string): string[] {
  const inner = line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|\s*$/, '');
  return inner.split('|').map((c) => c.trim());
}

/** ヘッダ配列から指定列名を含むインデックスを返す。無ければ -1。 */
export function findColumnIndex(headers: string[], keyword: string): number {
  return headers.findIndex((h) =>
    h.replace(/\s+/g, '').includes(keyword.replace(/\s+/g, '')),
  );
}

/**
 * セル単位の疑念判定。返り値はその行で疑念がある「セルのインデックス集合」。
 * 行が空集合を返したらその行は「確度高」とみなす (= 最初から緑)。
 *
 * 方針 (読取精度が高いので、基準値超えでは黄色にしない):
 *   黄色 = 「LLM が判読の確度が低いと示したもの」だけに限定する。
 *   (a) いずれかのセルに `(?)` または `??` を含む (= 読み取れなかった) → そのセル
 *   (b) 備考列に【要確認/不整合/欠落/混線/捏造】タグ (= LLM が疑義を明記) → 備考セル
 *
 *   ※ 以前あった「読取値の H/L マーカ・[強調]・判定列 H/L・桁数異常」は
 *      基準値超え/装飾の検出であり、判読確度とは無関係なため黄色対象から除外。
 */
export function detectSuspiciousCells(
  row: TableRow,
  headers: string[],
): Set<number> {
  const suspicious = new Set<number>();
  const remarksIdx = findColumnIndex(headers, '備考');

  row.cells.forEach((cell, i) => {
    // (a) (?) or ?? — どのセルでも (読み取り不能)
    if (/\(\?\)|\?\?/.test(cell)) {
      suspicious.add(i);
    }
    // (b) 備考タグ — LLM が判読の疑義を明記した行
    if (
      i === remarksIdx &&
      /【要確認|【不整合|【欠落|【混線|【捏造/.test(cell)
    ) {
      suspicious.add(i);
    }
  });
  return suspicious;
}

/**
 * 行の「疑念」判定 (= 疑念セルが 1 つ以上ある)。
 * 互換用に残しているが、内部は detectSuspiciousCells.
 */
export function isRowSuspicious(row: TableRow, headers: string[]): boolean {
  return detectSuspiciousCells(row, headers).size > 0;
}

/**
 * 領域配列 + セル単位の編集 → 確定 scan_md を再構築。
 * overrides の構造: `${regionIdx}:${rowIdx}` → cellIdx → 編集後セル文字列。
 */
export function assembleMarkdownClean(
  regions: RegionResult[],
  rowOverrides: Map<string, Map<number, string>>,
): string {
  const out: string[] = [];
  regions.forEach((region, regionIdx) => {
    out.push(`## ${region.label}`);
    if (region.bbox) {
      out.push(`<!-- bbox: ${region.bbox.map((n) => n.toFixed(2)).join(',')} -->`);
    }
    out.push('');
    const table = parseTable(region.body);
    if (!table) {
      out.push(region.body);
      out.push('');
      return;
    }
    out.push(...table.preamble);
    table.rows.forEach((row, rowIdx) => {
      const cellOverrides = rowOverrides.get(`${regionIdx}:${rowIdx}`);
      if (!cellOverrides || cellOverrides.size === 0) {
        out.push(row.rawLine);
        return;
      }
      const cells = row.cells.map(
        (cell, cellIdx) => cellOverrides.get(cellIdx) ?? cell,
      );
      out.push(`| ${cells.join(' | ')} |`);
    });
    out.push('');
  });
  return out.join('\n').trim() + '\n';
}

// ============================================================
// 行状態管理 (localStorage)
// ============================================================

interface CellState {
  /** ユーザーが編集したセル値。未編集なら未設定 */
  edited?: string;
  /** ユーザーが「このまま OK」と確認した (= このセルの疑念解消) */
  userConfirmed: boolean;
}

interface RowState {
  /** key = cellIdx → CellState。記録のあるセルだけ含む */
  cells: Record<number, CellState>;
}

interface VerificationState {
  /** key = `${regionIdx}:${rowIdx}` */
  rows: Record<string, RowState>;
}

function storageKey(diagnosticId: string): string {
  return `scan-chat-ai.verification.${diagnosticId}`;
}

function loadState(diagnosticId: string): VerificationState {
  if (typeof window === 'undefined') return { rows: {} };
  const raw = window.localStorage.getItem(storageKey(diagnosticId));
  if (!raw) return { rows: {} };
  try {
    const parsed = JSON.parse(raw) as { rows?: Record<string, unknown> };
    const rows: Record<string, RowState> = {};
    // 旧形式 ({ edited?, userConfirmed }) は破棄。新形式 ({ cells: {...} }) だけ受理。
    Object.entries(parsed.rows ?? {}).forEach(([key, value]) => {
      if (
        value &&
        typeof value === 'object' &&
        'cells' in value &&
        value.cells &&
        typeof value.cells === 'object'
      ) {
        rows[key] = { cells: value.cells as Record<number, CellState> };
      }
    });
    return { rows };
  } catch {
    return { rows: {} };
  }
}

function saveState(diagnosticId: string, state: VerificationState): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(storageKey(diagnosticId), JSON.stringify(state));
}

// ============================================================
// コントローラ
// ============================================================

export interface VerificationRefs {
  trimmedImage: HTMLElement;     // 上部の表トリミング画像 + bbox オーバーレイ
  blockDetail: HTMLElement;      // 選択ブロックの詳細パネル
  blockDetailTitle: HTMLElement; // 詳細パネルの見出し
  blockDetailBody: HTMLElement;  // 詳細パネルの本文 (表が入る)
  resultSummary: HTMLElement;    // 「2 領域 / N 行 / M 件 要確認」
  downstreamPreview: HTMLElement;// 下流送信 markdown プレビュー <pre>
  submitBtn: HTMLButtonElement;  // 「✓ 確認して送信」
  submitHint: HTMLElement;       // 送信ボタン下のヒント

  // 行修正モーダル (セル単位編集)
  rowEditModal: HTMLElement;
  rowEditTitle: HTMLElement;
  rowEditCellsContainer: HTMLElement;
  rowEditSaveBtn: HTMLButtonElement;
  rowEditCancelBtn: HTMLButtonElement;

  /** 「確認して送信」確定時に awaited で呼ばれる (S3 書き出し等)。失敗してもよい。 */
  onBeforeSubmit?: () => Promise<void> | void;

  /**
   * **送信が終わったあとの行き先を呼び出し側が決める** (複数年アップロード用・2026-09-15)。
   *
   * 渡されていなければ**従来どおり `/chat` へ遷移する** (挙動不変)。
   * 渡されていれば遷移せずにこれを呼ぶ — スペシャルアカウントは
   * 「他の年度分も続けてアップしますか?」を尋ねてから行き先を決めるため
   * (`docs/lab/スペシャルアカウント_複数年スキャン_仕様書.md` §4)。
   */
  onSubmitted?: () => void;
}

interface RegionView {
  region: RegionResult;
  table: TableModel | null;
  /** 各データ行の元の疑念セル集合 (state を考慮しない) */
  suspiciousCellsByRow: Array<Set<number>>;
}

/**
 * 行修正モーダル内で持つ「保存前」のセル状態。
 * 「保存」ボタンを押すまで永続化されない。
 */
interface ModalCellDraft {
  cellIdx: number;
  header: string;
  /** Gemini が出力した元のセル値 */
  original: string;
  /** 現在 input に表示されている値 */
  value: string;
  /** 元から疑念ありフラグ (= 黄色表示の対象) */
  originalSuspicious: boolean;
  /** ユーザーが値を書き換えた (= 元と異なる) */
  isEdited: boolean;
  /** ユーザーが「このまま OK」を押した */
  userConfirmed: boolean;
}

const STATUS_RING: Record<'green' | 'yellow' | 'red', string> = {
  green: 'border-emerald-500/80 bg-emerald-300/25',
  yellow: 'border-amber-500/80 bg-amber-300/25',
  red: 'border-rose-500/80 bg-rose-300/25',
};

export class ScanVerificationController {
  private state: VerificationState;
  private regions: RegionView[] = [];
  /** トリミング画像内での各領域の bbox (再正規化済) */
  private overlayBoxes: Array<[number, number, number, number] | undefined> =
    [];
  /** 編集モーダルの編集対象 */
  private editing: { regionIdx: number; rowIdx: number } | null = null;
  /** モーダル内の保存前セル状態 */
  private modalDrafts: ModalCellDraft[] = [];
  private selectedRegionIdx: number | null = null;
  /** 画像が onload で読み終わってトリミングが完了したかフラグ */
  private trimmedImageReady = false;

  constructor(
    private refs: VerificationRefs,
    private result: AnalyzeResult,
    private diagnosticId: string,
  ) {
    this.state = loadState(diagnosticId);
  }

  async render(): Promise<void> {
    marked.setOptions({ gfm: true, breaks: false });
    this.prepareRegionViews();
    await this.renderTrimmedImage();
    this.renderSummary();
    this.refs.blockDetail.hidden = true;
    this.bindModal();
    this.bindSubmit();
    this.updateDownstreamPreview();
    this.updateSubmitState();
  }

  // ----------------------------------------------------------
  // 領域ビューの準備
  // ----------------------------------------------------------

  private prepareRegionViews(): void {
    const regions = this.result.regions ?? [];
    this.regions = regions.map((region) => {
      const table = parseTable(region.body);
      const suspiciousCellsByRow = table
        ? table.rows.map((row) => detectSuspiciousCells(row, table.headers))
        : [];
      return { region, table, suspiciousCellsByRow };
    });
  }

  // ----------------------------------------------------------
  // 表全体トリミング画像 + bbox オーバーレイ
  // ----------------------------------------------------------

  private async renderTrimmedImage(): Promise<void> {
    const container = this.refs.trimmedImage;
    container.innerHTML = '';
    const full = this.result.fullImage;
    // PDF アップロードの場合、img タグでは表示できないのでプレースホルダ。
    // **「画像がありません」より先に見る** — S3 経由の PDF は `fullImage` を持たないので、
    // 後ろに置くと PDF なのに「画像がありません」と出てしまう。
    if (this.result.sourceKind === 'pdf' || full?.startsWith('data:application/pdf')) {
      container.innerHTML = `
        <div class="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
          <span class="text-5xl"></span>
          <p class="text-sm font-medium text-slate-700">PDF を解析しました</p>
          <p class="text-xs text-slate-500">表領域のプレビュー画像はありません。下のブロックから内容を確認してください。</p>
        </div>`;
      return;
    }
    /*
     * 複数ページをまとめて読み取った回は重ね描きをしない。
     * bbox は**そのページの画像に対する相対座標**なので、別の紙の座標を
     * 1 枚の上に描くことになる (scan-pages.ts の mergeResults を参照)。
     * 黙って「画像がありません」と出すと不具合に見えるので、理由を書く。
     */
    if ((this.result.pageCount ?? 1) > 1) {
      container.innerHTML = `
        <div class="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
          <p class="text-sm font-medium text-slate-700">${this.result.pageCount} 枚を読み取りました</p>
          <p class="text-xs text-slate-500">複数ページのときは、読み取り位置の重ね表示は行いません。下のブロックから内容をご確認ください。</p>
        </div>`;
      return;
    }
    if (!full || this.regions.length === 0) {
      container.innerHTML =
        '<p class="px-4 py-6 text-center text-sm text-slate-500">画像がありません</p>';
      return;
    }
    // 領域 bbox の union を計算 (表全体のおおまかな範囲)
    const bboxes = this.regions
      .map((r) => r.region.bbox)
      .filter((b): b is [number, number, number, number] => !!b);
    if (bboxes.length === 0) {
      // bbox 無し: 全画像をそのまま表示
      container.innerHTML = `<img src="${full}" class="block w-full" alt="撮影画像" />`;
      return;
    }
    const padding = 0.02;
    const ymin = clamp01(Math.min(...bboxes.map((b) => b[0])) - padding);
    const xmin = clamp01(Math.min(...bboxes.map((b) => b[1])) - padding);
    const ymax = clamp01(Math.max(...bboxes.map((b) => b[2])) + padding);
    const xmax = clamp01(Math.max(...bboxes.map((b) => b[3])) + padding);
    const unionW = xmax - xmin;
    const unionH = ymax - ymin;
    if (unionW <= 0 || unionH <= 0) {
      container.innerHTML = `<img src="${full}" class="block w-full" alt="撮影画像" />`;
      return;
    }
    // 各領域 bbox をトリミング後座標に再正規化
    this.overlayBoxes = this.regions.map(({ region }) => {
      const b = region.bbox;
      if (!b) return undefined;
      return [
        (b[0] - ymin) / unionH,
        (b[1] - xmin) / unionW,
        (b[2] - ymin) / unionH,
        (b[3] - xmin) / unionW,
      ];
    });
    const trimmed = await trimImage(full, [ymin, xmin, ymax, xmax]);
    this.trimmedImageReady = true;
    container.innerHTML = `
      <div class="relative">
        <img src="${trimmed}" alt="切り出した表全体" class="block w-full select-none" />
        <div class="absolute inset-0" id="trimmed-overlay-layer"></div>
      </div>
    `;
    const layer = container.querySelector(
      '#trimmed-overlay-layer',
    ) as HTMLElement | null;
    if (!layer) return;
    this.regions.forEach((_, idx) => {
      const box = this.overlayBoxes[idx];
      if (!box) return;
      const [yt, xl, yb, xr] = box;
      const top = (yt * 100).toFixed(2);
      const left = (xl * 100).toFixed(2);
      const height = ((yb - yt) * 100).toFixed(2);
      const width = ((xr - xl) * 100).toFixed(2);
      const overlay = document.createElement('button');
      overlay.type = 'button';
      overlay.dataset.regionIdx = String(idx);
      overlay.className =
        'absolute rounded border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1';
      overlay.style.top = `${top}%`;
      overlay.style.left = `${left}%`;
      overlay.style.height = `${height}%`;
      overlay.style.width = `${width}%`;
      overlay.title = this.regions[idx].region.label;
      overlay.addEventListener('click', () => this.selectRegion(idx));
      const labelEl = document.createElement('span');
      labelEl.className =
        'absolute -top-5 left-0 rounded bg-slate-900/80 px-1.5 py-0.5 text-xs font-medium text-white';
      labelEl.textContent = `#${idx + 1} ${this.regions[idx].region.label}`;
      overlay.appendChild(labelEl);
      layer.appendChild(overlay);
    });
    this.refreshOverlayColors();
  }

  private refreshOverlayColors(): void {
    if (!this.trimmedImageReady) return;
    const layer = this.refs.trimmedImage.querySelector(
      '#trimmed-overlay-layer',
    );
    if (!layer) return;
    layer.querySelectorAll('button[data-region-idx]').forEach((el) => {
      const idx = Number((el as HTMLButtonElement).dataset.regionIdx);
      const status = this.computeRegionStatus(idx);
      const ring = STATUS_RING[status];
      // 既存の色クラスを除去して新規付与
      (el as HTMLButtonElement).className =
        'absolute rounded border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 ' +
        ring;
    });
  }

  // ----------------------------------------------------------
  // ブロック詳細
  // ----------------------------------------------------------

  private selectRegion(idx: number): void {
    this.selectedRegionIdx = idx;
    this.renderBlockDetail(idx);
    this.refs.blockDetail.hidden = false;
    // 詳細パネルが表示されたらスムーズスクロール
    this.refs.blockDetail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private renderBlockDetail(idx: number): void {
    const view = this.regions[idx];
    if (!view) return;
    this.refs.blockDetailTitle.textContent = `#${idx + 1} ${view.region.label}`;
    const body = this.refs.blockDetailBody;
    body.innerHTML = '';
    if (!view.table) {
      // 表が無い領域 (手書きメモ等) は markdown 表示
      const div = document.createElement('div');
      div.className = 'md-region';
      const parsed = marked.parse(view.region.body);
      Promise.resolve(parsed).then((html) => {
        div.innerHTML = typeof html === 'string' ? html : '';
      });
      body.appendChild(div);
      return;
    }
    const table = document.createElement('table');
    table.className =
      'w-full table-auto border-collapse text-xs md:text-sm';
    // ヘッダ
    const thead = document.createElement('thead');
    const trH = document.createElement('tr');
    view.table.headers.forEach((h) => {
      const th = document.createElement('th');
      th.className =
        'border border-slate-200 bg-slate-50 px-2 py-1 text-left font-medium';
      th.textContent = h;
      trH.appendChild(th);
    });
    thead.appendChild(trH);
    table.appendChild(thead);
    // 本文
    const tbody = document.createElement('tbody');
    view.table.rows.forEach((row, rowIdx) => {
      const rowOk = this.isRowOk(idx, rowIdx);
      const originallySuspicious =
        (view.suspiciousCellsByRow[rowIdx]?.size ?? 0) > 0;
      const tr = document.createElement('tr');
      tr.dataset.rowIdx = String(rowIdx);
      // 元から疑念ありなら、解消済みでもクリック可 (再修正)。元から OK の行はクリック不可。
      if (originallySuspicious) {
        tr.className = rowOk
          ? 'cursor-pointer bg-emerald-50/60 transition-colors hover:bg-emerald-100/80'
          : 'cursor-pointer bg-amber-50 transition-colors hover:bg-amber-100';
        tr.addEventListener('click', () => this.openRowEdit(idx, rowIdx));
      } else {
        tr.className =
          'bg-emerald-50/40';
      }
      const persistedCells = this.state.rows[`${idx}:${rowIdx}`]?.cells ?? {};
      const suspiciousCells =
        view.suspiciousCellsByRow[rowIdx] ?? new Set<number>();
      row.cells.forEach((origCell, cellIdx) => {
        const cs = persistedCells[cellIdx];
        const displayText = cs?.edited ?? origCell;
        const isCellEdited = cs?.edited != null && cs.edited !== origCell;
        const isCellConfirmed = cs?.userConfirmed === true;
        const cellOriginallySuspicious = suspiciousCells.has(cellIdx);
        const td = document.createElement('td');
        // セルごとに状態色を反映
        let cellClasses =
          'border border-slate-200 px-2 py-1 align-top';
        if (cellOriginallySuspicious) {
          if (isCellEdited || isCellConfirmed) {
            cellClasses +=
              ' bg-emerald-100/80';
          } else {
            cellClasses +=
              ' bg-amber-100/80 font-semibold';
          }
        }
        td.className = cellClasses;
        if (isCellEdited) {
          td.innerHTML =
            '<span class="mr-1 text-emerald-600" title="修正済"></span>' +
            escapeHtml(displayText);
        } else {
          td.textContent = displayText;
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);
    // 凡例
    const legend = document.createElement('p');
    legend.className = 'mt-3 text-xs text-slate-500';
    legend.innerHTML =
      '<span class="inline-block h-2 w-2 rounded bg-amber-300"></span> 要確認セル / ' +
      '<span class="inline-block h-2 w-2 rounded bg-emerald-300"></span> 確認済 (タップで修正できます)';
    body.appendChild(legend);
  }

  // ----------------------------------------------------------
  // 行編集モーダル
  // ----------------------------------------------------------

  private openRowEdit(regionIdx: number, rowIdx: number): void {
    const view = this.regions[regionIdx];
    if (!view?.table) return;
    const row = view.table.rows[rowIdx];
    if (!row) return;
    this.editing = { regionIdx, rowIdx };
    const persisted = this.state.rows[`${regionIdx}:${rowIdx}`]?.cells ?? {};
    const suspiciousCells =
      view.suspiciousCellsByRow[rowIdx] ?? new Set<number>();
    // 各セルのドラフトを構築
    this.modalDrafts = view.table.headers.map((header, cellIdx) => {
      const original = row.cells[cellIdx] ?? '';
      const cs = persisted[cellIdx];
      const editedFromState = cs?.edited != null && cs.edited !== original;
      return {
        cellIdx,
        header,
        original,
        value: cs?.edited ?? original,
        originalSuspicious: suspiciousCells.has(cellIdx),
        isEdited: editedFromState,
        userConfirmed: cs?.userConfirmed === true,
      };
    });
    // 行ラベル: 検査項目列があればそれをタイトルに使う
    const nameIdx = findColumnIndex(view.table.headers, '検査項目');
    const rowLabel =
      nameIdx >= 0 ? row.cells[nameIdx] : `行 ${rowIdx + 1}`;
    this.refs.rowEditTitle.textContent = `行の修正: ${rowLabel}`;
    this.renderModalCells();
    this.refs.rowEditModal.hidden = false;
  }

  private closeRowEdit(): void {
    this.editing = null;
    this.modalDrafts = [];
    this.refs.rowEditModal.hidden = true;
  }

  /**
   * モーダル内のセル入力フォームを描画。
   * 各セルは 1 つの「行カード」として表示:
   *   - 元から OK のセル: 緑枠、ラベル + input のみ
   *   - 元から疑念ありで未解消: 黄枠 + 「このまま OK」ボタン
   *   - 元から疑念ありで解消済 (編集 or OK 押下): 緑枠、ステータス表示
   */
  private renderModalCells(): void {
    const container = this.refs.rowEditCellsContainer;
    container.innerHTML = '';
    this.modalDrafts.forEach((draft) => {
      const card = document.createElement('div');
      card.className =
        'rounded-lg border-2 p-2 transition-colors';
      const headerRow = document.createElement('div');
      headerRow.className = 'mb-1 flex items-center justify-between gap-2';
      const label = document.createElement('label');
      label.className = 'text-xs font-medium text-slate-700';
      label.textContent = draft.header;
      const status = document.createElement('span');
      status.className = 'text-xs font-medium';
      headerRow.append(label, status);
      card.appendChild(headerRow);

      // 入力フィールド
      const input = document.createElement('input');
      input.type = 'text';
      input.value = draft.value;
      input.spellcheck = false;
      input.className =
        'w-full rounded border bg-white px-2 py-1 font-mono text-sm text-slate-900 focus:outline-none focus:ring-1';
      card.appendChild(input);

      // 「このまま OK」ボタン (元から疑念ありのセルのみ)
      let okBtn: HTMLButtonElement | null = null;
      if (draft.originalSuspicious) {
        okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.textContent = '✓ このまま OK';
        okBtn.className =
          'mt-1.5 rounded border border-amber-500 px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-100';
        card.appendChild(okBtn);
      }

      const refresh = () => {
        const resolved =
          !draft.originalSuspicious || draft.isEdited || draft.userConfirmed;
        if (!draft.originalSuspicious) {
          // 元から OK: 中立色
          card.className =
            'rounded-lg border-2 border-slate-200 bg-slate-50 p-2 transition-colors';
          input.className =
            'w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500';
          status.textContent = draft.isEdited ? '修正済' : '';
          status.className =
            'text-xs font-medium text-emerald-700';
        } else if (resolved) {
          card.className =
            'rounded-lg border-2 border-emerald-400 bg-emerald-50 p-2 transition-colors';
          input.className =
            'w-full rounded border border-emerald-400 bg-white px-2 py-1 font-mono text-sm text-slate-900 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500';
          status.textContent = draft.isEdited
            ? '修正済'
            : '✓ 確認済';
          status.className =
            'text-xs font-medium text-emerald-700';
        } else {
          card.className =
            'rounded-lg border-2 border-amber-400 bg-amber-50 p-2 transition-colors';
          input.className =
            'w-full rounded border border-amber-400 bg-white px-2 py-1 font-mono text-sm text-slate-900 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500';
          status.textContent = '要確認';
          status.className =
            'text-xs font-medium text-amber-700';
        }
        if (okBtn) okBtn.hidden = resolved;
      };
      refresh();

      input.addEventListener('input', () => {
        draft.value = input.value;
        draft.isEdited = input.value !== draft.original;
        refresh();
        this.updateModalSummary();
      });
      if (okBtn) {
        okBtn.addEventListener('click', () => {
          draft.userConfirmed = true;
          refresh();
          this.updateModalSummary();
        });
      }
      container.appendChild(card);
    });
    this.updateModalSummary();
  }

  /** モーダル下部の「残 N 件」表示を更新 */
  private updateModalSummary(): void {
    const unresolved = this.modalDrafts.filter(
      (d) => d.originalSuspicious && !d.isEdited && !d.userConfirmed,
    ).length;
    if (unresolved === 0) {
      this.refs.rowEditSaveBtn.textContent = '保存して閉じる (全セル OK)';
      this.refs.rowEditSaveBtn.classList.remove(
        '!bg-amber-500',
        'hover:!bg-amber-600',
      );
    } else {
      this.refs.rowEditSaveBtn.textContent = `保存して閉じる (残 ${unresolved} 件)`;
      this.refs.rowEditSaveBtn.classList.add(
        '!bg-amber-500',
        'hover:!bg-amber-600',
      );
    }
  }

  private bindModal(): void {
    this.refs.rowEditSaveBtn.addEventListener('click', () =>
      this.handleRowSave(),
    );
    this.refs.rowEditCancelBtn.addEventListener('click', () =>
      this.closeRowEdit(),
    );
    this.refs.rowEditModal.addEventListener('click', (ev) => {
      if (ev.target === this.refs.rowEditModal) this.closeRowEdit();
    });
  }

  private handleRowSave(): void {
    if (!this.editing) return;
    const { regionIdx, rowIdx } = this.editing;
    const key = `${regionIdx}:${rowIdx}`;
    const cells: Record<number, CellState> = {};
    this.modalDrafts.forEach((draft) => {
      // 永続化対象: ユーザーが触ったセルのみ (編集 or OK 押下)
      const editedAndDifferent =
        draft.isEdited && draft.value !== draft.original;
      if (editedAndDifferent) {
        cells[draft.cellIdx] = {
          edited: draft.value,
          userConfirmed: true,
        };
      } else if (draft.userConfirmed) {
        cells[draft.cellIdx] = { userConfirmed: true };
      }
    });
    if (Object.keys(cells).length === 0) {
      // 何も変更がなければ既存状態を保持
      delete this.state.rows[key];
    } else {
      this.state.rows[key] = { cells };
    }
    saveState(this.diagnosticId, this.state);
    this.closeRowEdit();
    this.afterRowChange(regionIdx);
  }

  private afterRowChange(regionIdx: number): void {
    this.renderBlockDetail(regionIdx);
    this.refreshOverlayColors();
    this.renderSummary();
    this.updateDownstreamPreview();
    this.updateSubmitState();
  }

  // ----------------------------------------------------------
  // 状態判定
  // ----------------------------------------------------------

  /**
   * その行が「ユーザー視点で OK 扱い」か。
   * 元から疑念があったセル**全て**が、編集 or「このまま OK」のいずれかで
   * 解消されていれば OK。
   */
  private isRowOk(regionIdx: number, rowIdx: number): boolean {
    const view = this.regions[regionIdx];
    if (!view?.table) return true;
    const suspiciousCells =
      view.suspiciousCellsByRow[rowIdx] ?? new Set<number>();
    if (suspiciousCells.size === 0) return true;
    const cells = this.state.rows[`${regionIdx}:${rowIdx}`]?.cells ?? {};
    for (const cellIdx of suspiciousCells) {
      const cs = cells[cellIdx];
      if (!cs) return false;
      const original = view.table.rows[rowIdx]?.cells[cellIdx] ?? '';
      const isEdited = cs.edited != null && cs.edited !== original;
      if (!isEdited && !cs.userConfirmed) return false;
    }
    return true;
  }

  private computeRegionStatus(idx: number): 'green' | 'yellow' | 'red' {
    const view = this.regions[idx];
    if (!view) return 'red';
    if (!view.table) {
      // 手書きメモ等: 緑 (確認対象ではない)
      return 'green';
    }
    const total = view.table.rows.length;
    if (total === 0) return 'red';
    const unresolved = view.table.rows.filter(
      (_, rowIdx) => !this.isRowOk(idx, rowIdx),
    ).length;
    return unresolved === 0 ? 'green' : 'yellow';
  }

  // ----------------------------------------------------------
  // サマリ / プレビュー / 送信ゲート
  // ----------------------------------------------------------

  private renderSummary(): void {
    let totalRows = 0;
    let unresolved = 0;
    this.regions.forEach((view, regionIdx) => {
      if (!view.table) return;
      totalRows += view.table.rows.length;
      view.table.rows.forEach((_, rowIdx) => {
        if (!this.isRowOk(regionIdx, rowIdx)) unresolved++;
      });
    });
    const parts = [`${this.regions.length} 領域`];
    if (totalRows) parts.push(`${totalRows} 行`);
    if (unresolved > 0) {
      parts.push(`${unresolved} 件 要確認`);
    } else {
      parts.push('すべて確認済み');
    }
    this.refs.resultSummary.textContent = parts.join(' / ');
  }

  private updateDownstreamPreview(): void {
    const overrides = new Map<string, Map<number, string>>();
    Object.entries(this.state.rows).forEach(([key, rowState]) => {
      const cellMap = new Map<number, string>();
      Object.entries(rowState.cells).forEach(([cellIdx, cs]) => {
        if (cs.edited != null) cellMap.set(Number(cellIdx), cs.edited);
      });
      if (cellMap.size > 0) overrides.set(key, cellMap);
    });
    const md = assembleMarkdownClean(this.result.regions ?? [], overrides);
    this.refs.downstreamPreview.textContent = md || '(empty)';
  }

  /**
   * 送信ボタンの表示を更新する。**関門ではない。**
   *
   * 【2026-09-15・仕様書 §8 の確定 3 点目を実装】
   * 以前はここが **疑念セルを全部解消するまで `disabled`** にする
   * 「先へ進むための関門」だった。**読み取り精度は LLM 側で上げるものであって、
   * 利用者に直させる作業ではない** (発注者指示) ため、関門をやめた。
   *
   * - **`disabled` にしない。** 未解消が残っていても送信できる。
   * - 件数は**情報として**出す。「未解消です」と行き止まりにしない。
   * - 画面自体は残す (案B)。直したい人は直せるが、**直さなくても先へ進める**。
   */
  private updateSubmitState(): void {
    let unresolved = 0;
    this.regions.forEach((view, regionIdx) => {
      if (!view.table) return;
      view.table.rows.forEach((_, rowIdx) => {
        if (!this.isRowOk(regionIdx, rowIdx)) unresolved++;
      });
    });
    // **どの場合もボタンは押せる。** 送信できない状態を作らない。
    this.refs.submitBtn.disabled = false;
    this.refs.submitBtn.textContent = '✓ 確認して送信';
    if (unresolved === 0) {
      this.refs.submitHint.textContent = '✓ 全行を確認しました。問診へ進めます。';
      this.refs.submitHint.className = 'text-center text-xs text-emerald-700';
    } else {
      // **作業を指示しない。** 「直せる」ことだけを伝える。
      this.refs.submitHint.textContent =
        `読み取りの確度が低い箇所が ${unresolved} 件あります。直さずにこのまま送信できます。`;
      this.refs.submitHint.className = 'text-center text-xs text-slate-600';
    }
  }

  private bindSubmit(): void {
    this.refs.submitBtn.addEventListener('click', async () => {
      if (this.refs.submitBtn.disabled) return;
      /*
       * **確認の文言も行き先に合わせる。** 続きを尋ねる画面へ行くのに
       * 「問診に進みますか?」と聞くと、押した先と言っていることが食い違う。
       */
      const ok = window.confirm(
        this.refs.onSubmitted
          ? 'この 1 回分 (1 年分) を確定しますか?\n確定後は同じ画面で編集できません。'
          : 'この内容で確定し、問診に進みますか?\n確定後は同じ画面で編集できません。',
      );
      if (!ok) return;
      // 完了時に確定結果を S3 (Elith 連携) へ自動書き出し (best-effort)。
      if (this.refs.onBeforeSubmit) {
        this.refs.submitBtn.disabled = true;
        this.refs.submitBtn.textContent = '書き出し中…';
        try {
          await this.refs.onBeforeSubmit();
        } catch {
          /* テスト用途のため失敗は握りつぶし、遷移は続行 */
        }
      }
      /*
       * **行き先は呼び出し側が決める。** 渡されていなければ従来どおり /chat
       * (Phase 0: メモリ保持で遷移)。複数年のときだけ「続けますか?」を挟む。
       */
      if (this.refs.onSubmitted) {
        this.refs.onSubmitted();
        return;
      }
      window.location.href = '/chat';
    });
  }
}

// ============================================================
// 内部ヘルパー
// ============================================================

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * dataURL の画像から指定 bbox (0-1 正規化) を切り出し、新しい dataURL を返す。
 */
function trimImage(
  dataUrl: string,
  bbox: [number, number, number, number],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const [ymin, xmin, ymax, xmax] = bbox;
        const sx = Math.round(xmin * img.width);
        const sy = Math.round(ymin * img.height);
        const sw = Math.round((xmax - xmin) * img.width);
        const sh = Math.round((ymax - ymin) * img.height);
        const canvas = document.createElement('canvas');
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        resolve(canvas.toDataURL('image/jpeg', 0.92));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error('image load failed'));
    img.src = dataUrl;
  });
}
