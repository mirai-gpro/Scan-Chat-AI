/**
 * 検診・人間ドック (`HealthCheckupData`) の **finalize を副作用なしで行う共通 core**。
 *
 * 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §6.2 / §6.5
 *
 * ここは `src/pages/api/admin/elith-hc-merge.ts` の finalize から**そのまま切り出した**もので、
 * 通常の admin バッチと臨時診断バッチの**両方がこの 1 つを呼ぶ**。
 *
 * **なぜ切り出すのか** — 臨時診断バッチは Human Review の前に S3 へ書いてはならない
 * (spec §6.5)。しかし `elith-hc-merge` は通常運用では part で元画像・finalize で JSON を
 * S3 へ書くので、そのまま呼べない。かといって **ad-hoc 側に同じ整形を書き直すと
 * 「本番と別の検査項目正規化」になる** (spec §4.3 の禁止事項)。
 * だから「計算」と「書き込み」を分け、計算だけを共有する。
 *
 * **この関数は I/O をしない。** S3 にも DB にも触らず、fetch もしない。
 * 例外は `MODELS.scan` (app_config を読む getter) と `new Date()` だけで、
 * どちらも呼び出し側から差し替えられる。
 *
 * **ここに新しい整形規則を足さない。** 納品整形の唯一の本体は
 * `sanitizeMeasurementsForDelivery()` (CLAUDE.md「納品整形は決定論プログラムに集約」)。
 */

import {
  ELITH_HANDOFF_SCHEMA_VERSION,
  sanitizeMeasurementsForDelivery,
  canonicalizeEnabled,
  obsDedupEnabled,
  scrambleFixEnabled,
  scanEyeResolveEnabled,
  scanLipidFixEnabled,
} from './elith-export';
import { canonicalize } from './canonicalize';
import { dedupObservations, dedupAudit, semanticKey } from './observation-dedup';
import { detectScramble, reassignScramble } from './scramble-detect';
import { resolveEyeCollapsed } from './collapsed-row';
import { fixLipidSwap } from './lipid-fix';
import { masterItemNames } from './standard-master';
import { MODELS } from './gemini';
import { checkNecessity } from './elith-necessity-check';

/** finalize に渡す 1 ページ (= 1 画像) ぶんの解析結果。 */
export interface HcFinalizePart {
  measurements?: unknown;
  notes?: unknown;
  /**
   * そのページの生 Markdown。
   *
   * **臨時診断バッチは渡さない** — 実在の人の検査票の生テキストは氏名を含み得るので、
   * 診断 DB にも Elith JSON にも残さない (spec §2.4 / §16)。
   * 代わりに `isTrendPage` を渡す。
   */
  rawMarkdown?: string | null;
  /**
   * 推移グラフページ (⑧-2「検査結果の推移」) か。
   *
   * 省略時は `rawMarkdown` から判定する (通常経路の従来どおりの挙動)。
   * **生 Markdown を保存しない経路は、分類の時点で判定した結果をここへ渡す。**
   */
  isTrendPage?: boolean;
}

export interface HcFinalizeInput {
  clientId: string;
  /** `YYYY-MM-DD`。**呼び出し側が確定させる。ここで today を埋めない** (spec §6.4)。 */
  testDate: string;
  parts: readonly HcFinalizePart[];
  sourceFiles?: readonly string[];
  /** S3 prefix。key の組み立てにだけ使う (書き込みはしない)。 */
  prefix?: string;
  /** `source.note`。経路が分かるように呼び出し側が入れる。 */
  note?: string;
  /**
   * 納品 JSON に `raw_markdown` を含めるか (既定 true = 通常経路の従来どおり)。
   *
   * **臨時診断バッチは false。** 生 Markdown は氏名を含み得るため
   * 「Elith JSON へ氏名・住所・メール等を入れない」(spec §16) に触れる。
   */
  includeRawMarkdown?: boolean;
  /** 省略時は `crypto.randomUUID()`。 */
  diagnosticId?: string;
  /** 省略時は `new Date()`。 */
  exportedAt?: Date;
}

export interface HcFinalizeResult {
  json: Record<string, unknown>;
  jsonKey: string;
  measurements: Record<string, unknown>[];
  rows: number;
  partCount: number;
  necessity: ReturnType<typeof checkNecessity>;
  canon: { mapped: unknown; unmapped: unknown; deficient: unknown } | null;
  dedup: ReturnType<typeof dedupAudit> | null;
  trendDropped: number;
  scramble: { checked: number; suspects: { name: string }[] };
  reassigned: unknown[] | null;
  eyeResolved: unknown[] | null;
  lipidFix: unknown | null;
  scanModel: string;
}

/** `user/{client_id}/date/{YYYY_MM_DD}/` と納品ファイル名の stem。既存 handoff 仕様どおり。 */
export function healthCheckupFolder(
  prefix: string,
  clientId: string,
  testDate: string,
): { folder: string; dateFolder: string; stem: string } {
  const dateFolder = testDate.replace(/-/g, '_');
  const cleanPrefix = prefix ? prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  const folder = `${cleanPrefix}user/${clientId}/date/${dateFolder}/`;
  return { folder, dateFolder, stem: `HealthCheckupData_date_${dateFolder}_user_${clientId}` };
}

function randomUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

function nameOf(m: unknown): string | null {
  const nm = m && typeof m === 'object' ? (m as Record<string, unknown>).name : null;
  return typeof nm === 'string' && nm.trim() ? nm : null;
}

/**
 * 複数ページの解析結果を 1 つの `HealthCheckupData` へまとめる (**書き込みはしない**)。
 *
 * 手順は `elith-hc-merge` の finalize と 1 対 1:
 *   推移ページの除去 → `sanitizeMeasurementsForDelivery` → 正準化 → dedup →
 *   scramble 検知(再割当前) → 再割当 → 眼科 → 脂質 → necessity。
 */
export function finalizeHealthCheckup(input: HcFinalizeInput): HcFinalizeResult {
  const parts = input.parts ?? [];
  const rawMeasurements: unknown[] = [];
  const notes: string[] = [];
  const markdowns: string[] = [];

  /*
   * 推移グラフページ(⑧-2「検査結果の推移」)由来の行は非納品
   * (前回/トレンド点 = 詳細表の重複 or 過去値)。同一概念が詳細ページにも在れば trend 行を落とす
   * (汚染除去=選択でない)。trend にしか無い概念は残す (漏れ防止=捏造ゼロ/漏れゼロ両立)。
   * 推移ページが無い/検出できない検体では発火せず挙動不変 (fail-safe)。
   */
  const trendMeas: unknown[] = [];
  const detailKeys = new Set<string>();
  for (const p of parts) {
    const md = typeof p.rawMarkdown === 'string' ? p.rawMarkdown : '';
    // **判定済みのフラグが来ていればそれを使う** (生 Markdown を保存しない経路のため)。
    const isTrend = typeof p.isTrendPage === 'boolean' ? p.isTrendPage : isTrendMarkdown(md);
    if (Array.isArray(p.measurements)) {
      if (isTrend) {
        trendMeas.push(...p.measurements);
      } else {
        for (const m of p.measurements) {
          rawMeasurements.push(m);
          const nm = nameOf(m);
          if (nm) detailKeys.add(semanticKey(nm));
        }
      }
    }
    if (Array.isArray(p.notes)) notes.push(...(p.notes as string[]));
    if (md.trim()) markdowns.push(md);
  }
  // trend 行: 詳細に同概念が在れば除外 (重複/前回列混入の汚染除去)、無ければ残す (漏れ防止)。
  let trendDropped = 0;
  for (const m of trendMeas) {
    const nm = nameOf(m);
    if (nm && detailKeys.has(semanticKey(nm))) { trendDropped++; continue; }
    rawMeasurements.push(m);
  }

  // 書き出し時点で lean 正規化 (↑↓→flag/value_num・空行/総合判定欄 除外・妥当性ガード)。
  const kept = sanitizeMeasurementsForDelivery(rawMeasurements).kept;
  // ②正準化 (S1〜S3)。SCAN_CANONICALIZE=on のときだけ。監査は納品 data に含めない。
  const canon = canonicalizeEnabled() ? canonicalize(kept) : null;
  const canonMeasurements = canon ? canon.delivery : kept;
  // 後段 dedup。マージ由来のページ跨ぎ重複 (体重×2・眼底×2 等) はここでしか消せない。
  const dedup = obsDedupEnabled() ? dedupObservations(canonMeasurements) : null;
  let measurements = dedup ? dedup.delivery : canonMeasurements;
  const canonAudit = canon
    ? { mapped: canon.mapped, unmapped: canon.unmapped, deficient: canon.deficient }
    : null;
  const dedupAuditOut = dedup ? dedupAudit(dedup) : null;
  // 基準レンジ scramble 検知 (監査のみ)。**再割当前**の生の scramble を捉える
  // (再割当後に検知すると、修正で空いたスロットを次の行が埋める偽陽性が出る)。
  const preScramble = detectScramble(measurements);
  // 基準レンジ再割当 (出力値は実読値の付け替えのみ＝捏造ゼロ)。
  const reassign = scrambleFixEnabled() ? reassignScramble(measurements) : null;
  if (reassign) measurements = reassign.delivery as Record<string, unknown>[];
  // 眼科 collapsed-row 付け替え (右眼/左眼→裸眼視力/眼圧/眼底)。
  const eye = scanEyeResolveEnabled() ? resolveEyeCollapsed(measurements) : null;
  if (eye) measurements = eye.delivery as Record<string, unknown>[];
  // 脂質 LDL↔TG 入替の物理制約修正 (LDL+HDL≤TC)。
  const lipid = scanLipidFixEnabled() ? fixLipidSwap(measurements) : null;
  if (lipid && lipid.swapped) measurements = lipid.delivery as Record<string, unknown>[];
  // ⚠ 残差 = 検知した scramble から「自動修正済(reassigned.from)」を除いた未修正分のみ。
  const fixedFrom = new Set((reassign?.reassigned ?? []).map((r) => r.from));
  const scramble = {
    checked: preScramble.checked,
    suspects: preScramble.suspects.filter((s) => !fixedFrom.has(s.name)),
  };

  const { folder, stem } = healthCheckupFolder(input.prefix ?? '', input.clientId, input.testDate);
  const jsonKey = `${folder}${stem}.json`;
  const exportedAt = input.exportedAt ?? new Date();
  const includeRaw = input.includeRawMarkdown !== false;

  const json: Record<string, unknown> = {
    format_id: 'HealthCheckupData',
    schema_version: ELITH_HANDOFF_SCHEMA_VERSION,
    kind: 'scan_merged',
    client_id: input.clientId,
    diagnostic_id: input.diagnosticId ?? randomUuid(),
    source_images: [...(input.sourceFiles ?? [])],
    part_count: parts.length,
    test_date: input.testDate,
    date_source: 'merged',
    exported_at: exportedAt.toISOString(),
    subject: { sex: null, age: null },
    source: {
      origin: 'scan-chat-ai',
      app: 'scan-chat-ai',
      model: MODELS.scan,
      note: input.note ?? 'admin バッチ (AIスキャン・複数画像を1検査へマージ)。書式は暫定。',
      lab_name: null,
    },
    // 納品 data は共通 measurements[] + notes のみ (版面座標 regions/bbox は含めない・§7.1)。
    data: { measurements, notes },
  };
  // **`raw_markdown` はキーごと出さない** (空文字を置くと「読めなかった」と区別できない)。
  if (includeRaw) json.raw_markdown = markdowns.join('\n\n---\n\n');

  const necessity = checkNecessity(json, {
    requiredItemsMaster: canonicalizeEnabled() ? masterItemNames() : null,
  });

  return {
    json,
    jsonKey,
    measurements,
    rows: measurements.length,
    partCount: parts.length,
    necessity,
    canon: canonAudit,
    dedup: dedupAuditOut,
    trendDropped,
    scramble,
    reassigned: reassign?.reassigned ?? null,
    eyeResolved: eye?.resolved ?? null,
    lipidFix: lipid && lipid.swapped ? lipid.detail : null,
    scanModel: MODELS.scan,
  };
}

/**
 * 推移グラフページ (⑧-2「検査結果の推移」) かどうか。
 *
 * **生 Markdown を保存しない経路でも、読んだ直後にこれで判定してフラグだけ残せる。**
 * 判定条件は従来の finalize と同じ 1 本 (増やすと通常経路の挙動が変わる)。
 */
export function isTrendMarkdown(markdown: string | null | undefined): boolean {
  return typeof markdown === 'string' && /検査結果の推移/.test(markdown);
}
