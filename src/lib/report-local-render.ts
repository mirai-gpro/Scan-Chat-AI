/**
 * **開発時だけ**、受領 JSON をそのまま紙面に流し込むための読み込み口。
 *
 * 【何のため】Elith から受け取った JSON を **AI疾病予防報告書の紙面のまま PDF にする**
 *   ための一括処理 (`scripts/render-report-pdf.mjs`)。DB に取り込む前でも、
 *   **本番と同じアダプタ・同じレンダラ**を通した紙面を出せるようにする。
 *
 * 【本番には出ない】呼び出し側 (`report.astro`) が `import.meta.env.DEV` で囲う。
 *   ビルドした本番では常に無効。**サーバ側 PDF 生成 (決裁台帳 S-3) とは別物** —
 *   Vercel には何も足さない (Chromium を載せない)。
 *
 * 【PII】読むのは**リポジトリの外**のディレクトリだけ (`REPORT_RENDER_DIR`)。
 *   実在の方の氏名・健康情報を repo に置かないため、既定値を持たせない。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BuildInput } from './report-adapter';

/** ディレクトリ名として安全な形だけ通す (`..` や `/` を弾く)。 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `meta.json`。**Elith の JSON に無い項目**をここから補う。 */
export interface RenderMeta {
  /** 「〇〇様」。本人への画面表示なので PII 分離の対象外 (spec §4.0.0.1)。 */
  name?: string;
  /** 実年齢。**無ければ表紙の数直線を描かない** (片方だけで位置を作らない)。 */
  chronologicalAge?: number | null;
  /** 作成日 (YYYY-MM-DD)。 */
  issuedOn?: string;
  /** 第 N 回。無ければ出さない。 */
  cycleSeq?: number | null;
  /** その回にがんリスク検査があったか。**既定は false = タイプ2**。 */
  hasCancerRisk?: boolean;
  /**
   * **問診で本人が申告した身長・体重** (spec §4.13)。本文の数値が検診の実測値と
   * 食い違うとき、**この値と一致した数値にだけ**「（問診時）」と出所を添える。
   * 無ければ何もしない (推測で出所を書かない)。
   */
  selfReported?: { height?: number | null; weight?: number | null } | null;
}

function readJson(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; } catch { return null; }
}

/**
 * `<REPORT_RENDER_DIR>/<id>/` から紙面の材料を組む。
 * 材料が無ければ `null` (呼び出し側は通常の経路へ落ちる)。
 */
export function loadLocalRenderInput(id: string | null): BuildInput | null {
  if (!id || !ID_RE.test(id)) return null;
  const dir = process.env.REPORT_RENDER_DIR;
  if (!dir) return null;

  const base = join(dir, id);
  const report = readJson(join(base, 'report_text.json'));
  if (!report) return null; // 本文が無ければ紙面にならない

  const lab: Record<string, unknown> = {};
  for (const part of ['health_checkup', 'blood_test', 'cancer_risk']) {
    const v = readJson(join(base, `${part}.json`));
    if (v && typeof v === 'object' && !Array.isArray(v)) lab[part] = v;
  }
  const meta = (readJson(join(base, 'meta.json')) ?? {}) as RenderMeta;

  return {
    reportText: report,
    checkup: Object.keys(lab).length ? (lab as never) : null,
    name: meta.name ?? 'お客様',
    issuedOn: meta.issuedOn ?? '',
    isSample: false,
    hasCancerRisk: meta.hasCancerRisk === true,
    cycleSeq: meta.cycleSeq ?? null,
    chronologicalAge: meta.chronologicalAge ?? null,
    selfReported: meta.selfReported ?? null,
  };
}
