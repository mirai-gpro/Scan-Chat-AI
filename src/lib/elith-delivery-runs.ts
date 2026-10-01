/**
 * **手動納品 run の控えと、前回との差分。**
 *
 * 正本: `docs/specs/special_account_management_spec_20261001.md`
 *       §14.3（D-7）/ §14.3.1 / §14.3.1.1 / §14.3.2 / §16.1。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【なぜ「前回 run の snapshot と比べる」か】他の 2 案はどちらも取り逃す
 * ══════════════════════════════════════════════════════════════════════
 *   ① 「前回納品日時以降に created_at が付いた行を数える」
 *      → `persistIntoExistingArtifact` は**既存 artifact の中身を更新して行を増やさない**
 *        （`special-additional-tests.ts:211-223`）。**後から直した回を取り逃す。**
 *   ② 「`elith_delivery_items` と突き合わせる」
 *      → `elith_deliveries` 経由の分はあちらに行を持たないので
 *        **「納品済みなのに差分に出る」**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【集計値だけでは足りない】§14.3.1.1
 * ══════════════════════════════════════════════════════════════════════
 * 件数と最新 `test_date` だけでは **「同じ日・同じ件数で中身だけ変わった回」が
 * 差分に出ない**。上の ① と同じ性質（行が増えないまま中身が変わる）。
 * → **ファイル 1 件ごとの `sha256` fingerprint** を控え、
 *   「追加」だけでなく「**更新**」も検知する。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【対象はスペシャルの手動納品 run だけ】§14.3.2
 * ══════════════════════════════════════════════════════════════════════
 * 通常の cron の run はここに書かない。cron は契約者・単品を含む母集団を
 * 1 起動でまとめて回すので、**この画面のための表が全ユーザーの納品ログになる**。
 * 帰結として **cron が納品した回は snapshot を持たない**。そのときは
 * 「自動納品・内訳の控えなし」と出し、**0 件と偽らない**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【PII を 1 つも入れない】§14.3.1
 * ══════════════════════════════════════════════════════════════════════
 * 氏名・会社名・メール（マスクも）・生年月日・測定値・問診の回答本文・
 * 原本のファイル名は **1 つも入れない**。`sha256` は中身の指紋であって中身ではない。
 * `destination_key` は uid を含むが **uid は非 PII**。
 */

import { getServerSupabase } from './supabase';
import type { PlannedFile } from './elith-manual-delivery';

/** snapshot に入れるファイル 1 件ぶんの明細。**中身は入れない。** */
export interface SnapshotFile {
  format_id: string;
  delivered_date: string;
  destination_key: string;
  /**
   * **差分の判定に使うのはこれだけ**（P0-2）。生成メタ（`exported_at` /
   * `diagnostic_id`）を除いた本文の sha256 なので、**中身が同じなら毎回同じ**。
   * 実 body の sha を使うとこの 2 つが毎回変わり、
   * **何も変えていない回が必ず「更新」になる**（実測で踏んだ）。
   */
  content_sha256: string;
  /** 実際に書いた body の sha256。**監査用で、差分判定には使わない。** */
  delivery_sha256: string;
}

export interface RunSnapshot {
  /** 納品したファイルの明細（verified になったものだけ）。 */
  files: SnapshotFile[];
  /** format_id ごとのファイル数（画面の読みやすさ用。差分の判定は files が正）。 */
  count_by_format: Record<string, number>;
  /** 納品した date フォルダ（年）。 */
  dates: string[];
}

/** **PII が混ざらない形へ落とす。** 明細は 4 つのキーだけを通す（allow-list）。 */
export function buildSnapshot(files: readonly PlannedFile[]): RunSnapshot {
  const out: SnapshotFile[] = files.map((f) => ({
    format_id: String(f.formatId),
    delivered_date: String(f.deliveredDate),
    destination_key: String(f.destinationKey),
    content_sha256: String(f.contentSha256),
    delivery_sha256: String(f.deliverySha256),
  }));
  const count_by_format: Record<string, number> = {};
  for (const f of out) count_by_format[f.format_id] = (count_by_format[f.format_id] ?? 0) + 1;
  return { files: out, count_by_format, dates: Array.from(new Set(out.map((f) => f.delivered_date))).sort() };
}

/**
 * **sha256 digest（hex 64 文字）だけを受け取る**（Hardening 1）。それ以外は `null`。
 *
 * 以前は「`@` を含まなければ通す」だったが、それは**生 email を弾く条件であって、
 * PII を弾く条件ではない**。氏名・社員番号・`admin%40example.com` のような
 * エンコード済みアドレスは全部すり抜ける。控えは 10 年残るので、
 * **形が digest であることを条件にする**（allow-list）。
 * digest は中継側（wellfort-site）が作る（§14.3.1）。
 */
const DIGEST_RE = /^[0-9a-f]{64}$/i;
export function safeTriggeredBy(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!DIGEST_RE.test(s)) return null;
  return s.toLowerCase();
}

/**
 * run を 1 行書く。
 *
 * **1 件も verified 納品できなかった run は行を作らない**（§14.3.2）。
 * 空振りで行を増やすと「前回納品」が実体の無い日時を指す。
 * **投げない** — 控えが残らなくても納品そのものは成立している。
 */
export async function recordDeliveryRun(input: {
  uid: string;
  deliveryPrefix: string;
  files: readonly PlannedFile[];
  verifiedKeys: ReadonlySet<string>;
  fileCount: number;
  triggeredBy?: unknown;
}): Promise<{ ok: boolean; reason?: string }> {
  const delivered = input.files.filter((f) => input.verifiedKeys.has(f.destinationKey));
  if (delivered.length === 0) return { ok: false, reason: 'no_verified_file' };

  const sb = getServerSupabase();
  if (!sb) return { ok: false, reason: 'supabase_not_configured' };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (sb.schema('diagnosis') as any).from('elith_delivery_runs').insert({
      diagnostic_user_id: input.uid,
      delivery_prefix: input.deliveryPrefix,
      triggered_by: safeTriggeredBy(input.triggeredBy),
      source: 'manual',
      file_count: input.fileCount,
      verified_count: delivered.length,
      snapshot: buildSnapshot(delivered),
    });
    return error ? { ok: false, reason: String(error.message ?? error) } : { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e as { message?: string })?.message ?? e) };
  }
}

export interface RunDiff {
  /** 前回の手動 run が無い。**0 件と区別する。** */
  noPrevious: boolean;
  previousAt: string | null;
  /** 前回に無かった納品先キー。 */
  added: SnapshotFile[];
  /** 両方にあるが `content_sha256` が違う = **件数は増えていないが内容が変わった**。 */
  updated: SnapshotFile[];
  /** format_id ごとの「追加 + 更新」件数（画面の副文言用）。 */
  countByFormat: Record<string, number>;
}

/**
 * 前回の手動 run の snapshot と、いまの plan を比べる。
 *
 * **「減った」は出さない** — S3 の既存ファイルは消していないので、
 * 今回の plan に無い = 消えた、ではない（§14.3.1.1）。
 */
export function diffAgainst(previous: RunSnapshot | null, current: readonly PlannedFile[]): RunDiff {
  const now = buildSnapshot(current);
  if (!previous) {
    return { noPrevious: true, previousAt: null, added: [], updated: [], countByFormat: {} };
  }
  // **`content_sha256` で比べる**（P0-2）。古い snapshot（`sha256` しか無い回）は
  // 判定材料が無いので **`undefined` にはせず「比較できない = 変化なし扱い」**にする
  // （`added` へ誤って入れない。キーは両方に在るので `added` でもない）。
  const prev = new Map(previous.files.map((f) => [
    f.destination_key,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    f.content_sha256 ?? (f as any).sha256 ?? null,
  ]));
  const added: SnapshotFile[] = [];
  const updated: SnapshotFile[] = [];
  for (const f of now.files) {
    const was = prev.get(f.destination_key);
    if (was === undefined) added.push(f);
    else if (was !== null && was !== f.content_sha256) updated.push(f);
  }
  const countByFormat: Record<string, number> = {};
  for (const f of [...added, ...updated]) countByFormat[f.format_id] = (countByFormat[f.format_id] ?? 0) + 1;
  return { noPrevious: false, previousAt: null, added, updated, countByFormat };
}

/**
 * その uid の **最新の手動 run 1 件**を読む。
 *
 * **引けなかったことと「無い」を混同しない** — 表が未作成（migration 未適用）でも
 * 画面を壊さないが、そのときは `noPrevious` ではなく `unavailable` を返して
 * **差分の副文言を出さない**（§6.5 F-5）。
 */
export async function loadLatestRun(uid: string): Promise<
  { state: 'found'; snapshot: RunSnapshot; deliveredAt: string | null }
  | { state: 'none' }
  | { state: 'unavailable'; reason: string }
> {
  const sb = getServerSupabase();
  if (!sb) return { state: 'unavailable', reason: 'supabase_not_configured' };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (sb.schema('diagnosis') as any)
      .from('elith_delivery_runs')
      .select('snapshot, delivered_at')
      .eq('diagnostic_user_id', uid)
      .eq('source', 'manual')
      .order('delivered_at', { ascending: false })
      .limit(1);
    if (error) return { state: 'unavailable', reason: String(error.message ?? error) };
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return { state: 'none' };
    const snap = row.snapshot as RunSnapshot | null;
    if (!snap || !Array.isArray(snap.files)) return { state: 'none' };
    return { state: 'found', snapshot: snap, deliveredAt: row.delivered_at ?? null };
  } catch (e) {
    return { state: 'unavailable', reason: String((e as { message?: string })?.message ?? e) };
  }
}
