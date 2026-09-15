// src/lib/elith-genetic-finalize.ts
// 遺伝子 / LAiF AI疾病発症予測 の finalize **共通 core** (spec v3 §13.3)。
//
// 【なぜ切り出すか】
// `elith-genetic-merge` の finalize は納品 JSON の組み立てと **S3 書き込み**が
// 1 つの分岐に同居していた。トランスコスモス v3 は
// **Human Review より前に S3 へ 1 バイトも書かない**ので、あの API を
// そのまま呼べない。かといって v3 用の builder を別に作ると
// **同じ納品 JSON の作り方が 2 つ**になり、片方だけ直って静かにずれる。
// → **組み立てだけを副作用なしで取り出し、通常経路と v3 が同じこれを呼ぶ。**
//
// 【この core の約束】
// - **S3 を書かない・読まない。** 書き込みは通常経路の endpoint と、
//   v3 は §18 の delivery 層だけが行う。
// - **`today` を埋めない。** `testDate` は必須引数で、確定させるのは呼び出し側。
//   通常経路の today フォールバックは**互換のため endpoint 境界に残す** (§13.3)。
// - **時刻依存フィールドと乱数 ID の生成責務はここに一本化する** (§13.3)。
//   `diagnostic_id` と `exported_at` をここで作るので、**v3 が別形式を作らない**。

import { ELITH_HANDOFF_SCHEMA_VERSION } from './elith-export';
import { consolidateAiPredictionItems, type ConsolidateAudit } from './ai-prediction-consolidate';
import { MODELS } from './gemini';

export type GeneticFormatId = 'GeneticTestResultData' | 'Other';

/** finalize へ渡す 1 ページぶん。`items` の中身は LLM 出力そのままで、ここでは解釈しない。 */
export interface GeneticFinalizePart {
  page?: unknown;
  section?: unknown;
  items?: unknown;
}

export interface GeneticFinalizeInput {
  formatId: GeneticFormatId;
  /** 納品 JSON の `kind`。`resolveGeneticFormat()` が formatId と対で返す。 */
  kind: string;
  clientId: string;
  /** `YYYY-MM-DD`。**core は today を埋めない** — 呼び出し側が確定させる。 */
  testDate: string;
  /**
   * `date_source`。通常経路は「明示指定なら provided / 無ければ today」を
   * endpoint 側で決めて渡す。**v3 は必ず `provided`** (today 由来を捨てるため)。
   */
  dateSource: 'provided' | 'today';
  parts: readonly GeneticFinalizePart[];
  /** S3 prefix。**key の組み立てにだけ使う。書き込みはしない。** */
  prefix: string;
  sourceFile: string | null;
  sourcePages: string | null;
  /**
   * LAiF(Other) の疾患単位統合を行うか。
   * **app_config を読むのは呼び出し側** (core は env / DB を見ない = 副作用なし)。
   */
  consolidateAiPrediction: boolean;
  /**
   * **テストと parity 検証のためだけの差し込み口。**
   * 本番の呼び出しは渡さない (渡さなければ core が生成する = 生成責務はここ)。
   */
  diagnosticId?: string;
  exportedAt?: Date;
  scanModel?: string;
}

export interface GeneticFinalizeResult {
  json: Record<string, unknown>;
  jsonKey: string;
  /** そのまま PUT できる本文 (production と同じ 2 スペース整形)。 */
  jsonBody: string;
  bytes: number;
  itemCount: number;
  pageCount: number;
  /** LAiF 統合の監査。`null` = 未実施。**納品 data には含めない。** */
  consolidation: ConsolidateAudit | null;
}

/** このエンドポイントが扱う多ページ自由構造レポート。既定=遺伝子 / `Other`=LAiF。 */
export function resolveGeneticFormat(v: unknown): { formatId: GeneticFormatId; kind: string } {
  return v === 'Other'
    ? { formatId: 'Other', kind: 'ai_prediction' }
    : { formatId: 'GeneticTestResultData', kind: 'genetic_scan_merged' };
}

export function geneticFolderOf(
  prefix: string, clientId: string, testDate: string, formatId: string,
): { folder: string; stem: string } {
  const dateFolder = testDate.replace(/-/g, '_');
  const cleanPrefix = prefix ? prefix.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
  return {
    folder: `${cleanPrefix}user/${clientId}/date/${dateFolder}/`,
    stem: `${formatId}_date_${dateFolder}_user_${clientId}`,
  };
}

function utf8Bytes(s: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : Buffer.byteLength(s, 'utf-8');
}

function randomUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * 全 part の items を集約して 1 つの納品 JSON を組み立てる。**副作用なし。**
 *
 * 出力は通常経路の finalize が作っていたものと**バイト単位で同じ**
 * (同じ `diagnosticId` / `exportedAt` / `scanModel` を与えたとき)。
 */
export function finalizeGeneticDelivery(input: GeneticFinalizeInput): GeneticFinalizeResult {
  const items: unknown[] = [];
  const pages: { page: number; section: string | null; count: number }[] = [];
  for (const p of input.parts) {
    const pageItems = Array.isArray(p.items) ? (p.items as unknown[]) : [];
    items.push(...pageItems);
    pages.push({
      page: typeof p.page === 'number' ? p.page : pages.length + 1,
      section: typeof p.section === 'string' ? p.section : null,
      count: pageItems.length,
    });
  }

  // LAiF(Other) のみ: 同一疾患の重複 (発症予測/アドバイス/用語解説/ネスト) を疾患単位に統合。
  // 疾患名は印字どおり維持 (完全一致統合のみ)・捏造ゼロ・漏れゼロ。監査は納品 data に含めない。
  let deliverItems: unknown[] = items;
  let consolidation: ConsolidateAudit | null = null;
  if (input.formatId === 'Other' && input.consolidateAiPrediction) {
    const c = consolidateAiPredictionItems(items);
    deliverItems = c.items;
    consolidation = c.audit;
  }

  const { folder, stem } = geneticFolderOf(input.prefix, input.clientId, input.testDate, input.formatId);
  const jsonKey = `${folder}${stem}.json`;
  const json: Record<string, unknown> = {
    format_id: input.formatId,
    schema_version: ELITH_HANDOFF_SCHEMA_VERSION,
    kind: input.kind,
    client_id: input.clientId,
    diagnostic_id: input.diagnosticId ?? randomUuid(),
    source_file: str(input.sourceFile),
    source_pages: str(input.sourcePages),
    page_count: input.parts.length,
    test_date: input.testDate,
    date_source: input.dateSource,
    exported_at: (input.exportedAt ?? new Date()).toISOString(),
    subject: { sex: null, age: null },
    source: {
      origin: 'scan-chat-ai',
      app: 'scan-chat-ai',
      model: input.scanModel ?? MODELS.scan,
      note: input.formatId === 'Other'
        ? 'admin バッチ (LAiF AI疾病発症予測・AIスキャン・構造化はLLM全面委任)。項目構造はLLM判定。'
        : 'admin バッチ (遺伝子・AIスキャン・構造化はLLM全面委任)。項目構造はLLM判定。',
      lab_name: input.formatId === 'Other' ? 'LAiF' : null,
    },
    data: { item_count: deliverItems.length, items: deliverItems, pages },
  };
  const jsonBody = JSON.stringify(json, null, 2);
  return {
    json, jsonKey, jsonBody,
    bytes: utf8Bytes(jsonBody),
    itemCount: deliverItems.length,
    pageCount: input.parts.length,
    consolidation,
  };
}
