/**
 * カメラ起動 → 撮影 → /api/scan に画像を 1 枚まるごと POST → Markdown 受信。
 *
 * - 画像は分割しない。canvas からそのまま 1 枚を JPEG dataURL 化して送る。
 * - サーバ応答は { markdown, finishReason } の JSON。下流診断 AI も Markdown
 *   をそのまま消費するため、H2 + bbox HTML コメントで領域メタを埋め込む。
 */

import { stripColumnFromTables } from '../lib/scan-markdown';

/** 1 領域分のデータ (Markdown を parse した結果) */
export interface RegionResult {
  /** 領域ラベル (H2 見出し) */
  label: string;
  /** 正規化 bbox [ymin, xmin, ymax, xmax] (0.0-1.0)。HTML コメントから抽出。 */
  bbox?: [number, number, number, number];
  /** 領域内の Markdown 本文 (見出し直下〜次の H2 までのテキスト) */
  body: string;
}

export interface AnalyzeResult {
  /**
   * Gemini が出した生 Markdown (推論値列を含む)。
   * Gemini の自己チェック用カラムが残っているため**デバッグ用途のみ**。
   * UI 表示にも下流診断 AI への送信にも使わない。
   */
  markdown: string;
  /**
   * 推論値列を削除した「確定 scan_md」候補。
   * UI 表示用カード本文 + Supabase #2 / Elith への送信に使う。
   * (docs/architecture/diagnostic_session_data_spec.md §3.2 の scan_md フォーマット)
   */
  markdownClean: string;
  /** 領域ごとに切り分けたメタデータ + 本文 (UI 表示用、markdownClean ベース) */
  regions: RegionResult[];
  /** 表示用フル画像 URL (objectURL)。S3 経由のときは縮小したプレビュー。 */
  fullImage?: string;
  /**
   * 元ファイルの種別。PDF はプレビューを描けないので表示側が分岐する。
   * 以前は `fullImage` が `data:application/pdf` で始まるかで判定していたが、
   * S3 経由では `fullImage` に PDF の data URL が入らないため明示的に持つ。
   */
  sourceKind?: 'pdf' | 'image';
  /** Gemini finishReason */
  finishReason?: string;
  /** 束ねたページ数 (1 なら単票)。複数ページでは bbox 重ね描きを行わない。 */
  pageCount?: number;
}

export type ScanState = 'idle' | 'running' | 'busy';

/**
 * 解析対象の指定。**本体を Vercel 関数に通すか通さないか**の 2 通り。
 *   dataUrl  … 小さいファイル。従来どおり JSON body に載せる。
 *   imageKey … 大きいファイル。ブラウザが S3 へ直接置いたキーだけを渡す
 *              (Vercel の 4.5 MB 制限は関数を通るデータにしかかからない)。
 */
export interface AnalyzeSource {
  dataUrl?: string;
  imageKey?: string;
  /** 画面表示用。imageKey のときはここに縮小版が入る。 */
  previewDataUrl?: string;
  kind?: 'pdf' | 'image';
}

export interface CameraRefs {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  status: HTMLElement;
  hint?: HTMLInputElement | null;
  shotBtn?: HTMLButtonElement;
  onStateChange?: (state: ScanState) => void;
  /** 撮影直後の画像 URL（objectURL）を結果ページに渡す用 */
  onCapture?: (objectUrl: string) => void;
  /**
   * **これを渡すと撮影が「確認待ち」になる** — シャッターを押しても解析せず、
   * 撮れた 1 枚を呼び出し側へ返すだけにする (プレビューして撮り直せるようにするため)。
   * 未指定なら従来どおり撮影 → 即解析。
   */
  onShot?: (dataUrl: string) => void;
  onAnalyze?: (result: AnalyzeResult) => void;
  onError?: (message: string) => void;
}

export interface CameraScanController {
  start: () => Promise<void>;
  stop: () => void;
  capture: () => Promise<void>;
  /** カメラ起動なしで dataURL (PDF / 画像) を /api/scan に投げて解析する */
  analyzeDataUrl: (dataUrl: string, opts?: { sourceLabel?: string }) => Promise<void>;
  /**
   * アップロード経路。`dataUrl` (小さいファイル) か `imageKey`
   * (S3 へ直接置いた大きいファイル) のどちらかを送る。
   */
  analyzeUpload: (src: AnalyzeSource, opts?: { sourceLabel?: string }) => Promise<void>;
  /**
   * 1 ページ解析して**結果を返す** (onAnalyze は呼ばない)。
   * 完了時のバッチ処理で、呼び出し側がページを順に回すために使う。
   * 失敗時は null (メッセージは onError へ流す)。
   */
  analyzeToResult: (src: AnalyzeSource, opts?: { statusText?: string }) => Promise<AnalyzeResult | null>;
  isRunning: () => boolean;
}

export function initCameraScan(refs: CameraRefs): CameraScanController {
  let stream: MediaStream | null = null;

  refs.shotBtn?.addEventListener('click', capture);

  setState('idle');

  async function start(): Promise<void> {
    if (stream) return;
    setStatus('カメラを起動中…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1500 } },
        audio: false,
      });
      refs.video.srcObject = stream;
      await refs.video.play();
      setState('running');
      setStatus('用紙が枠に収まるようにかざしてください');
    } catch (err) {
      setState('idle');
      const msg = describeMediaError(err);
      setStatus(msg);
      refs.onError?.(msg);
    }
  }

  function stop(): void {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    refs.video.srcObject = null;
    setState('idle');
    setStatus('停止中');
  }

  async function capture(): Promise<void> {
    if (!stream) return;
    const frame = await grabFrameDataUrl({ maxEdge: 2400, quality: 0.92 });
    if (!frame) {
      setStatus('まだ映像が取得できていません');
      return;
    }
    // onShot があれば「確認待ち」。撮っただけで解析しない (プレビューして撮り直せる)。
    if (refs.onShot) {
      refs.onShot(frame.dataUrl);
      return;
    }
    await analyzeDataUrl(frame.dataUrl);
  }

  /**
   * カメラ起動なしで dataURL を /api/scan に POST して解析する。
   * PDF / JPEG / PNG / WebP / HEIC など、Gemini が受け取れる形式ならそのまま渡せる。
   */
  async function analyzeDataUrl(
    dataUrl: string,
    opts?: { sourceLabel?: string },
  ): Promise<void> {
    return analyzeUpload({ dataUrl }, opts);
  }

  async function analyzeUpload(
    src: AnalyzeSource,
    opts?: { sourceLabel?: string },
  ): Promise<void> {
    const result = await runAnalyze(src, opts);
    if (result) refs.onAnalyze?.(result);
  }

  /** 1 ページ解析して結果を返す。onAnalyze は呼ばない (バッチ処理用)。 */
  async function analyzeToResult(
    src: AnalyzeSource,
    opts?: { statusText?: string },
  ): Promise<AnalyzeResult | null> {
    return runAnalyze(src, { sourceLabel: undefined, statusText: opts?.statusText });
  }

  async function runAnalyze(
    src: AnalyzeSource,
    opts?: { sourceLabel?: string; statusText?: string },
  ): Promise<AnalyzeResult | null> {
    // 表示に使うのはプレビュー優先 (S3 経由では原本の data URL を持たない)。
    const display = src.previewDataUrl ?? src.dataUrl;
    if (display) refs.onCapture?.(display);

    setState('busy');
    setStatus(
      opts?.statusText
        ?? (opts?.sourceLabel
          ? `${opts.sourceLabel} を解析中…`
          : 'AI が紙面を精密読解中… (精度優先モード)'),
    );

    const userHint = refs.hint?.value?.trim() || '';

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          src.imageKey
            ? { imageKey: src.imageKey, hint: userHint || undefined }
            : { image: src.dataUrl, hint: userHint || undefined },
        ),
      });
      if (!res.ok) {
        const msg = await readErrorMessage(res);
        setStatus(msg);
        refs.onError?.(msg);
        setState(stream ? 'running' : 'idle');
        return null;
      }
      const data = (await res.json()) as {
        markdown?: string;
        finishReason?: string;
      };
      const markdown = stripMarkdownCodeFence(String(data.markdown ?? ''));
      if (!markdown.trim()) {
        const reason = data.finishReason ?? 'UNKNOWN';
        const msg = `内容が検出されませんでした (finishReason: ${reason})`;
        setStatus(msg);
        refs.onError?.(msg);
        setState(stream ? 'running' : 'idle');
        return null;
      }

      // 「推論値」は Gemini の自己チェック用 (備考列に【要確認】を立てるための内部材料)。
      // ユーザー表示にも下流診断 AI 送信にも漏らさず、ここで除去する。
      // 列名のブレ (推定値) も同時に拾う。
      const markdownClean = stripColumnFromTables(markdown, ['推論値', '推定値']);
      const regions = parseMarkdownRegions(markdownClean);
      const totalRows = regions.reduce(
        (sum, r) => sum + countTableRows(r.body),
        0,
      );
      const result: AnalyzeResult = {
        markdown,
        markdownClean,
        regions,
        fullImage: display,
        sourceKind: src.kind ?? (src.dataUrl?.startsWith('data:application/pdf') ? 'pdf' : 'image'),
        finishReason: data.finishReason,
        pageCount: 1,
      };
      setState(stream ? 'running' : 'idle');
      setStatus(
        totalRows
          ? `${regions.length} 領域 / ${totalRows} 行を読み取りました`
          : `${regions.length} 領域を読み取りました`,
      );
      return result;
    } catch (err) {
      const msg = `通信エラー: ${String(err)}`;
      setStatus(msg);
      refs.onError?.(msg);
      setState(stream ? 'running' : 'idle');
      return null;
    }
  }

  async function grabFrameDataUrl(opts: {
    maxEdge: number;
    quality: number;
  }): Promise<{ dataUrl: string } | null> {
    const vw = refs.video.videoWidth;
    const vh = refs.video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(1, opts.maxEdge / Math.max(vw, vh));
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    refs.canvas.width = w;
    refs.canvas.height = h;
    const ctx = refs.canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(refs.video, 0, 0, w, h);
    const dataUrl = refs.canvas.toDataURL('image/jpeg', opts.quality);
    return { dataUrl };
  }

  function setStatus(text: string): void {
    refs.status.textContent = text;
  }

  function setState(state: ScanState): void {
    if (refs.shotBtn) refs.shotBtn.disabled = state !== 'running';
    refs.onStateChange?.(state);
  }

  return {
    start,
    stop,
    capture,
    analyzeDataUrl,
    analyzeUpload,
    analyzeToResult,
    isRunning: () => stream !== null,
  };
}

// ============================================================
// Markdown パース: H2 (## ラベル) で領域に切り分け、HTML コメント
// から bbox を抽出する。
// ============================================================

const HEADING_REGEX = /^##\s+(.+?)\s*$/;
const BBOX_COMMENT_REGEX = /<!--\s*bbox\s*:\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*-->/i;

export function parseMarkdownRegions(md: string): RegionResult[] {
  const lines = md.split('\n');
  const regions: RegionResult[] = [];
  let current: { label: string; bodyLines: string[]; bbox?: [number, number, number, number] } | null = null;
  for (const line of lines) {
    const h = HEADING_REGEX.exec(line);
    if (h) {
      if (current) regions.push(finalize(current));
      current = { label: h[1].trim(), bodyLines: [] };
      continue;
    }
    if (current) {
      const b = BBOX_COMMENT_REGEX.exec(line);
      if (b && !current.bbox) {
        current.bbox = [
          clamp01(parseFloat(b[1])),
          clamp01(parseFloat(b[2])),
          clamp01(parseFloat(b[3])),
          clamp01(parseFloat(b[4])),
        ];
        // bbox コメント行は body には含めない
        continue;
      }
      current.bodyLines.push(line);
    }
  }
  if (current) regions.push(finalize(current));
  return regions;
}

function finalize(c: {
  label: string;
  bodyLines: string[];
  bbox?: [number, number, number, number];
}): RegionResult {
  return {
    label: c.label,
    bbox: c.bbox,
    body: c.bodyLines.join('\n').trim(),
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** GFM テーブル本文の行数を雑にカウント (区切り行 `|---|` を除く) */
function countTableRows(body: string): number {
  let count = 0;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    // ヘッダ/区切り行を除外
    if (/^\|\s*-+/.test(trimmed) || /^\|\s*:?-+/.test(trimmed)) continue;
    count++;
  }
  // 最初の 1 行は表ヘッダなので 1 引く
  return Math.max(0, count - 1);
}

/** モデルが \`\`\`markdown ... \`\`\` で全体を包んできた場合に剥がす */
function stripMarkdownCodeFence(text: string): string {
  const t = text.trim();
  const m = /^```(?:markdown|md)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(t);
  return m ? m[1].trim() : t;
}


async function readErrorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const data = JSON.parse(text) as { error?: unknown; detail?: string };
      const err =
        typeof data.error === 'string'
          ? data.error
          : data.error
            ? JSON.stringify(data.error)
            : text.slice(0, 200);
      const detail = data.detail ? `\n${summarizeGoogleError(data.detail)}` : '';
      return `解析エラー (${res.status}): ${err}${detail}`;
    } catch {
      return `解析エラー (${res.status}): ${text.slice(0, 200) || '不明'}`;
    }
  } catch {
    return `解析エラー (${res.status})`;
  }
}

function describeMediaError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  switch (err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'カメラへのアクセスが拒否されました。設定からカメラ許可をご確認ください。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'カメラが見つかりません。デバイスの設定をご確認ください。';
    case 'NotReadableError':
      return 'カメラが他のアプリで使用中の可能性があります。';
    default:
      return `カメラの起動に失敗しました: ${err.message || err.name}`;
  }
}

function summarizeGoogleError(detail: string): string {
  try {
    const obj = JSON.parse(detail) as {
      error?: {
        status?: string;
        message?: string;
        details?: Array<{
          violations?: Array<{ quotaMetric?: string; quotaId?: string }>;
          retryDelay?: string;
        }>;
      };
    };
    const e = obj.error;
    if (!e) return detail.slice(0, 300);
    const parts: string[] = [];
    if (e.status) parts.push(e.status);
    if (e.message) parts.push(e.message);
    const quota = e.details?.find((d) => d.violations?.length)?.violations?.[0];
    if (quota?.quotaMetric) parts.push(`metric: ${quota.quotaMetric}`);
    if (quota?.quotaId) parts.push(`id: ${quota.quotaId}`);
    const retry = e.details?.find((d) => d.retryDelay)?.retryDelay;
    if (retry) parts.push(`retry in ${retry}`);
    return parts.join(' / ');
  } catch {
    return detail.slice(0, 300);
  }
}
