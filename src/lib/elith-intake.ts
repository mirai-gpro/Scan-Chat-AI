/**
 * Elith の下り (S3) を走査して、取り込めるものを取り込む。
 *
 * 正本の経路 = `docs/lab/lab_data_pipeline_master_spec.md` ⑥。
 * **受取仕様は 2026-09-17 に発注者が確定** (Elith 側は毎日 0:00 JST 起動・1 件 ≒ 20 分):
 *   1. 置き場所  `output/user/{client_id}/date/{YYYY_MM_DD}/{固定名}`
 *      (個人 ID > 日付 > 固定名。連番は付かない)
 *   2. 揃った判定 **ファイルが 2 つ以上**。**1 つだけ = 先方の処理途中なので保留**
 *   3. `client_id` = `diagnostic_user_id` (入力と同じ ID で返る)
 *   4. 再発行 (訂正版) は**イレギュラーなので個別対応** → ここでは扱わない
 *
 * 【日付で絞らない (最重要)】
 * 対象は「昨日ぶん」ではなく **「まだ取り込んでいないもの」**。
 * 1 件 20 分なので件数が増えた日は 0:00 起動でも朝 9 時の実行を追い越す。
 * 日付で絞ると**追い越したぶんが二度と拾われない**。取込済みは
 * `diagnosis_results.source_key` で分かるので、走らない日があっても
 * 次の成功回がまとめて回収する (デメカルの `last_to` 単調前進と同じ考え方)。
 *
 * 【壊れたものを黙って取り込まない】
 * 材料が足りない・JSON が壊れている回は **`needs_review` にして飛ばす**。
 * 消さない・空の行を作らない・次回また見にいく。
 */
import { listObjects, getObjectText, isS3Configured } from './s3';
import { ingestElithReport, type ElithIngestResult } from './elith-report-ingest';
import type { LabFiles } from './report-adapter';

/** 下り専用。ここを広げると上り (`user/…` の納品データ) まで読めてしまう。 */
export const OUTPUT_ROOT = 'output/user/';

/** 固定名 (発注者確定 2026-09-17)。**連番も日付も付かない。** */
export const REPORT_FILE = 'report_text.json';
export const LAB_FILES = ['health_checkup', 'blood_test', 'cancer_risk'] as const;

/** 「揃った」= ファイル 2 つ以上 (発注者確定 2026-09-17)。1 つだけは先方の処理途中。 */
export const MIN_FILES_COMPLETE = 2;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}_\d{2}_\d{2}$/;
/** 1 オブジェクトの上限。報告書 JSON は数十 KB なので充分な余裕を見た値。 */
const MAX_BYTES = 8 * 1024 * 1024;

export type IntakeStatus =
  | 'ready'         // 取り込める
  | 'holding'       // ファイルが 1 つ = 先方の処理途中。次回また見る
  | 'ingested'      // 取り込み済み (source_key で判定)
  | 'needs_review'  // 材料が足りない / 壊れている。人が見る
  | 'done'          // この実行で取り込んだ
  | 'failed';       // 取り込もうとして失敗した

export interface IntakeItem {
  clientId: string;
  date: string;
  /** 取り込みの単位。`source_key` に入る値。 */
  folder: string;
  files: string[];
  status: IntakeStatus;
  reason?: string;
  result?: ElithIngestResult;
}

export interface IntakeSummary {
  ok: boolean;
  configured: boolean;
  dryRun: boolean;
  scanned: number;
  counts: Record<IntakeStatus, number>;
  items: IntakeItem[];
  error?: string;
}

/**
 * S3 のキー一覧を「1 件 = 1 フォルダ」へまとめる。
 * **形の違うキーは黙って捨てない** — 数に出す (`skippedKeys`)。
 */
export function groupByFolder(keys: string[]): {
  folders: Map<string, { clientId: string; date: string; files: string[] }>;
  skippedKeys: string[];
} {
  const folders = new Map<string, { clientId: string; date: string; files: string[] }>();
  const skippedKeys: string[] = [];
  for (const key of keys) {
    if (!key.startsWith(OUTPUT_ROOT) || key.endsWith('/')) { skippedKeys.push(key); continue; }
    // output/user/{client_id}/date/{YYYY_MM_DD}/{name}
    const rest = key.slice(OUTPUT_ROOT.length).split('/');
    if (rest.length !== 4 || rest[1] !== 'date') { skippedKeys.push(key); continue; }
    const [clientId, , date, name] = rest;
    if (!UUID_RE.test(clientId) || !DATE_RE.test(date) || !name) { skippedKeys.push(key); continue; }
    const folder = `${OUTPUT_ROOT}${clientId}/date/${date}/`;
    const e = folders.get(folder) ?? { clientId, date, files: [] };
    e.files.push(name);
    folders.set(folder, e);
  }
  for (const e of folders.values()) e.files.sort();
  return { folders, skippedKeys };
}

/** ファイル名 → 受け皿の名前。**固定名だけを見る** (推測しない)。 */
export function classifyFile(name: string): 'report' | (typeof LAB_FILES)[number] | null {
  if (name === REPORT_FILE) return 'report';
  for (const p of LAB_FILES) if (name === `${p}.json`) return p;
  return null;
}

type Db = { from: (t: string) => any };

/** 既に取り込んだフォルダの集合。 */
async function ingestedFolders(sb: { schema: (s: string) => unknown }): Promise<Set<string>> {
  const db = sb.schema('diagnosis') as unknown as Db;
  const { data, error } = await db
    .from('diagnosis_results')
    .select('source_key')
    .not('source_key', 'is', null);
  if (error) throw new Error(`取込済みの照会に失敗: ${error.message}`);
  return new Set((data ?? []).map((r: { source_key: string }) => r.source_key));
}

export interface RunOptions {
  /** true なら**読むだけ**。S3 も DB も書き換えない。 */
  dryRun?: boolean;
  /** 1 回の実行で取り込む上限。既定 50。 */
  limit?: number;
  /** この client だけを対象にする (随時バッチで 1 人だけ流したいとき)。 */
  onlyClientId?: string;
}

export async function runElithIntake(
  sb: { schema: (s: string) => unknown } | null,
  opts: RunOptions = {},
): Promise<IntakeSummary> {
  const dryRun = opts.dryRun === true;
  const limit = opts.limit ?? 50;
  const empty: Record<IntakeStatus, number> =
    { ready: 0, holding: 0, ingested: 0, needs_review: 0, done: 0, failed: 0 };

  if (!isS3Configured()) {
    return { ok: false, configured: false, dryRun, scanned: 0, counts: { ...empty }, items: [],
      error: 's3_not_configured' };
  }
  if (!sb) {
    return { ok: false, configured: false, dryRun, scanned: 0, counts: { ...empty }, items: [],
      error: 'supabase_not_configured' };
  }

  const objects = await listObjects(OUTPUT_ROOT);
  const { folders } = groupByFolder(objects.map((o) => o.key));
  const already = await ingestedFolders(sb);

  const items: IntakeItem[] = [];
  let ingestedThisRun = 0;

  for (const [folder, e] of [...folders.entries()].sort()) {
    if (opts.onlyClientId && e.clientId !== opts.onlyClientId) continue;

    const base: IntakeItem = { clientId: e.clientId, date: e.date, folder, files: e.files, status: 'ready' };

    if (already.has(folder)) { items.push({ ...base, status: 'ingested' }); continue; }

    // 【揃った判定】ファイル 1 つ = 先方の処理途中。**エラーにしない・次回また見る。**
    if (e.files.length < MIN_FILES_COMPLETE) {
      items.push({ ...base, status: 'holding', reason: `ファイルが ${e.files.length} 件 (2 件以上で完了)` });
      continue;
    }

    // 報告書本文が無ければ紙面が作れない。**空の行を作らずに人へ回す。**
    if (!e.files.includes(REPORT_FILE)) {
      items.push({ ...base, status: 'needs_review', reason: `${REPORT_FILE} が無い` });
      continue;
    }

    if (dryRun || ingestedThisRun >= limit) { items.push(base); continue; }

    // ここから実取り込み。**1 件が落ちても残りは続ける** (黙って止めない)。
    try {
      let report: unknown = null;
      let schemaVersion = 'elith-v1.0';
      const lab: Record<string, unknown> = {};

      for (const name of e.files) {
        const kind = classifyFile(name);
        if (!kind) continue; // 固定名以外は読まない (推測しない)
        const text = await getObjectText(`${folder}${name}`);
        if (new TextEncoder().encode(text).length > MAX_BYTES) {
          throw new Error(`${name} が大きすぎる`);
        }
        const value = JSON.parse(text) as unknown;
        if (kind === 'report') {
          if (!value || typeof value !== 'object') throw new Error(`${name} が object / array でない`);
          report = value;
          schemaVersion = Array.isArray(value) ? 'elith-v1.0' : 'elith-v2.0';
        } else {
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error(`${name} が object でない`);
          }
          lab[kind] = value;
        }
      }

      const result = await ingestElithReport(sb, {
        diagnosticUserId: e.clientId,
        report,
        checkup: Object.keys(lab).length ? (lab as LabFiles) : null,
        schemaVersion,
        sourceKey: folder,
      });
      if (!result.ok) { items.push({ ...base, status: 'failed', reason: result.detail ?? result.error, result }); continue; }
      ingestedThisRun += 1;
      items.push({ ...base, status: result.duplicate ? 'ingested' : 'done', result });
    } catch (err) {
      items.push({ ...base, status: 'needs_review', reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const counts = { ...empty };
  for (const it of items) counts[it.status] += 1;

  return { ok: true, configured: true, dryRun, scanned: folders.size, counts, items };
}
