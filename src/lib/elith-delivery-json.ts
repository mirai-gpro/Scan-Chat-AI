/**
 * **追加検査の Elith JSON** — source（監査層）の組み立て / 本番納品 / 読戻し検証 / 納品履歴。
 * 正本: `docs/specs/special_account_additional_tests_spec_20260930.md` §23〜§33。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ① サニタイズは**共用する。写さない**（§25）
 * ══════════════════════════════════════════════════════════════════════
 * 本番へ置く JSON は `elith-assemble.ts` の `rewriteClientId()` → `sanitizeDelivery()`
 * を**そのまま**通す。あちらは 2026-09-30 に `export` を足しただけで中身は変えていない。
 * **追加検査専用の JSON 整形を作らない** — 作ると片方だけ直る。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ② `elith-delivery-promote` を呼ばない（§24）
 * ══════════════════════════════════════════════════════════════════════
 * あの API は `listObjects(`${prefix}user/`)` で **uid 配下を全部列挙してコピーする**
 * （`elith-delivery-promote.ts:77, 82-89`）ので、**今回の対象外 JSON まで再納品し得る**。
 * ここでは **今回確定した 1 ファイルだけ**を納品する。
 *
 * ただし、あの API から**流用してよい性質 2 つ**は守る:
 *   ① `.json` 以外は納品先へ置かない（`:87`）
 *   ② **キーを組み替えない**（`:12`）— 納品先キーは source キーから
 *      **prefix を外すだけ**で作る（`toDestinationKey`）。取り違え防止。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ③ PutObject の成功を「納品完了」にしない（§29）
 * ══════════════════════════════════════════════════════════════════════
 * 書いた後に**本番から読み戻して SHA256 を突き合わせる**。一致して初めて delivered。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ④ `manifest.json` を作らない（§27）
 * ══════════════════════════════════════════════════════════════════════
 * `elith_s3_data_handoff_spec.md` に Draft 段の記述が残っているが、現行
 * `elith-assemble.ts:543-546` が正（規約外のファイルを納品先へ置かない）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⑤ PII（§39）
 * ══════════════════════════════════════════════════════════════════════
 * **元 PDF のファイル名をこの JSON に載せない。** 実ファイル名が
 * `250804ALAPDS結果本田大作.pdf` のように**氏名を含む**ことがあり、
 * 載せると Elith へ氏名が渡る。既存 scan 経路の `source_image` /
 * 遺伝子経路の `source_file` に相当するフィールドは**持たせない**。
 * 生年月日も載せない（`subject` は性別と年齢だけ = `applySubject` の既存挙動）。
 */

import { rewriteClientId, type SubjectInfo } from './elith-assemble';
import { ELITH_HANDOFF_SCHEMA_VERSION, type ElithFormatId } from './elith-export';
import { MODELS } from './gemini';
import { getS3Config, getObjectText, putFiles } from './s3';
import { getServerSupabase } from './supabase';
import { sha256Hex } from './originals-storage';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function randomUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}
/** prefix を `a/b/` の形へ整える（空は空のまま）。`s3.ts` / `elith-export.ts` と同じ流儀。 */
function normPrefix(prefix: string | null | undefined): string {
  const p = (prefix ?? '').trim();
  return p ? p.replace(/^\/+/, '').replace(/\/*$/, '/') : '';
}

/* ══════════════════════════════════════════════════════════════════════
 * キー（§23 / §26）
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 中間（監査）層のキー（§23）。
 *
 *   {AWS_S3_PREFIX}user/{uid}/date/{YYYY_MM_DD}/{format_id}_date_{YYYY_MM_DD}_user_{uid}.json
 *
 * 同じ `uid + test_date + format_id` は**同じキー**になる = 再実行で増えない（§33）。
 * 命名は `docs/elith/elith_s3_data_handoff_spec.md` / 既存 `buildElithScanBundle` と同一。
 */
export function buildAdditionalSourceKey(input: {
  prefix?: string | null;
  uid: string;
  testDate: string;
  formatId: ElithFormatId;
}): string | null {
  if (!UUID_RE.test(input.uid)) return null;
  if (!DATE_RE.test(input.testDate)) return null;
  const folder = input.testDate.replace(/-/g, '_');
  const uid = input.uid.toLowerCase();
  return `${normPrefix(input.prefix)}user/${uid}/date/${folder}/${input.formatId}_date_${folder}_user_${uid}.json`;
}

/**
 * 本番納品先キー（§24 / §26）。**キーを組み替えない** — prefix を外すだけ。
 * prefix 配下でない / `.json` でない キーは `null`（納品しない）。
 */
export function toDestinationKey(sourceKey: string, prefix: string | null | undefined): string | null {
  const p = normPrefix(prefix);
  const head = `${p}user/`;
  if (!sourceKey.startsWith(head)) return null;
  const rest = sourceKey.slice(head.length);
  const id = rest.split('/')[0];
  if (!id || !UUID_RE.test(id)) return null;
  // 納品先へ置くのは `.json` だけ（`elith-delivery-promote.ts:87` と同じ規律）。
  if (!rest.toLowerCase().endsWith('.json')) return null;
  return `user/${rest}`;
}

/* ══════════════════════════════════════════════════════════════════════
 * source JSON の組み立て（§23）
 * ════════════════════════════════════════════════════════════════════ */

/** ページ単位の読み取り記録（遺伝子 / AI疾病の `data.pages`。既存 `elith-genetic-merge` と同形）。 */
export interface AdditionalPageRef {
  page: number;
  section: string | null;
  count: number;
}

export interface AdditionalSourceJsonInput {
  formatId: ElithFormatId;
  uid: string;
  /** 受診日 YYYY-MM-DD。**必須**（§8。today へ落とさない）。 */
  testDate: string;
  /**
   * measurement 型（血液 / がんリスク）。
   * **`sanitizeMeasurementsForDelivery()` を通した後**の lean measurement を渡す
   * （整形はここでしない = 二重管理しない。CLAUDE.md「納品整形は決定論プログラムに集約」）。
   */
  measurements?: Record<string, unknown>[];
  /** items 型（遺伝子 / AI疾病発症予測）。構造は LLM 全面委任なので中身に触らない。 */
  items?: unknown[];
  notes?: unknown;
  pages?: AdditionalPageRef[];
  pageCount?: number;
  labName?: string | null;
}

/**
 * 中間層に置く JSON を組む。**エンベロープは既存経路と同じ形**
 * （`buildElithScanBundle` / `elith-genetic-merge` の finalize）。
 *
 * **元ファイル名を載せない**（§39・上の ⑤）。`date_source` は常に `'provided'` —
 * 追加検査の受診日は**画面の必須入力**で、推測も today fallback もしないため。
 */
export function buildAdditionalSourceJson(input: AdditionalSourceJsonInput): Record<string, unknown> {
  const hasItems = Array.isArray(input.items);
  const data: Record<string, unknown> = hasItems
    ? {
        item_count: (input.items ?? []).length,
        items: input.items ?? [],
        ...(input.pages ? { pages: input.pages } : {}),
      }
    : {
        measurements: input.measurements ?? [],
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      };

  return {
    format_id: input.formatId,
    schema_version: ELITH_HANDOFF_SCHEMA_VERSION,
    kind: hasItems ? 'additional_items' : 'additional_scan',
    client_id: input.uid,
    diagnostic_id: randomUuid(),
    test_date: input.testDate,
    date_source: 'provided',
    ...(input.pageCount ? { page_count: input.pageCount } : {}),
    exported_at: new Date().toISOString(),
    // 生年月日は載せない。性別/年齢は納品時に `rewriteClientId` → `applySubject` が充填する。
    subject: { sex: null, age: null },
    source: {
      origin: 'scan-chat-ai',
      app: 'scan-chat-ai',
      model: MODELS.scan,
      note: 'admin: スペシャルアカウント 追加検査 (原本PDF → AIスキャン)。',
      lab_name: input.labName ?? null,
    },
    data,
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 本番納品 + 読戻し（§24 / §25 / §29）
 * ════════════════════════════════════════════════════════════════════ */

export interface DeliverResult {
  ok: boolean;
  /** 納品先キー（`user/...`）。組めなかったときだけ null。 */
  destinationKey: string | null;
  /** **納品版**（サニタイズ後）の SHA256 = 実際に PUT したバイト列のハッシュ。 */
  sourceSha256: string | null;
  /** 本番から読み戻した JSON の SHA256。 */
  destinationSha256: string | null;
  /** 読戻し一致で true。PutObject の成否ではない（§29）。 */
  verified: boolean;
  error?: string;
  detail?: string;
}

/**
 * 中間層の 1 ファイルを**本番へ納品して読み戻す**（§24 / §29）。
 *
 * 1. source を GET
 * 2. `rewriteClientId()`（= `sanitizeDelivery()` 込み）で納品版へ
 * 3. `user/...` へ PUT
 * 4. **読み戻して SHA256 を突合**。一致して初めて `verified:true`。
 *
 * **既に同じ内容が納品先に在れば PUT をやり直さない**（§32 の修復経路 / §33 冪等）。
 * 失敗しても投げない — 呼び出し側は Dashboard 側の登録を残したまま
 * `status='failed'` として**再実行可能**にする（§32）。
 */
export async function deliverAdditionalJson(input: {
  sourceKey: string;
  uid: string;
  subject?: SubjectInfo | null;
}): Promise<DeliverResult> {
  const cfg = getS3Config();
  if (!cfg) {
    return { ok: false, destinationKey: null, sourceSha256: null, destinationSha256: null, verified: false, error: 's3_not_configured' };
  }
  const destinationKey = toDestinationKey(input.sourceKey, cfg.prefix);
  if (!destinationKey) {
    return { ok: false, destinationKey: null, sourceSha256: null, destinationSha256: null, verified: false, error: 'invalid_source_key', detail: input.sourceKey };
  }

  let sourceText: string;
  try {
    sourceText = await getObjectText(input.sourceKey);
  } catch (err) {
    return { ok: false, destinationKey, sourceSha256: null, destinationSha256: null, verified: false, error: 'source_read_failed', detail: msg(err) };
  }

  // **既存のサニタイズを共用**（§25）。ここで独自整形をしない。
  const { text: deliveryText } = rewriteClientId(sourceText, input.uid, input.sourceKey, input.subject ?? null);
  const sourceSha256 = sha256Hex(utf8(deliveryText));

  /*
   * **既に同じものが在るなら書き直さない**（§32「Elith 書き込み成功・履歴 DB 記録失敗」の修復 /
   * §33 冪等）。読めない = まだ無い、として通常の PUT へ進む。
   */
  let already: string | null = null;
  try {
    already = sha256Hex(utf8(await getObjectText(destinationKey)));
  } catch {
    already = null;
  }
  if (already && already === sourceSha256) {
    return { ok: true, destinationKey, sourceSha256, destinationSha256: already, verified: true };
  }

  try {
    await putFiles([{
      key: destinationKey,
      contentType: 'application/json; charset=utf-8',
      body: deliveryText,
      bytes: utf8(deliveryText).length,
    }]);
  } catch (err) {
    return { ok: false, destinationKey, sourceSha256, destinationSha256: null, verified: false, error: 'put_failed', detail: msg(err) };
  }

  // **読み戻して突合するまで「納品完了」と言わない**（§29）。
  let destinationSha256: string | null = null;
  try {
    destinationSha256 = sha256Hex(utf8(await getObjectText(destinationKey)));
  } catch (err) {
    return { ok: false, destinationKey, sourceSha256, destinationSha256: null, verified: false, error: 'readback_failed', detail: msg(err) };
  }
  if (destinationSha256 !== sourceSha256) {
    return { ok: false, destinationKey, sourceSha256, destinationSha256, verified: false, error: 'readback_mismatch' };
  }
  return { ok: true, destinationKey, sourceSha256, destinationSha256, verified: true };
}

function msg(err: unknown): string {
  return String(err instanceof Error ? err.message : err);
}

/* ══════════════════════════════════════════════════════════════════════
 * 納品履歴（§30 / §31 / §32）
 * ════════════════════════════════════════════════════════════════════ */

export interface DeliveryItemRecord {
  testArtifactId: string;
  diagnosticUserId: string;
  formatId: ElithFormatId;
  testDate: string;
  sourceKey: string;
  destinationKey: string;
  sourceSha256: string | null;
  destinationSha256: string | null;
  status: 'pending' | 'delivered' | 'failed';
  lastError?: string | null;
}

/**
 * `diagnosis.elith_delivery_items` へ 1 件記録する（§30）。
 *
 * **`elith_deliveries`（バンドル単位）には書かない**（§31）— あちらは
 * `format_ids text[]` を upsert で丸ごと上書きするので、追加検査を混ぜると
 * **既に納品済みの format_ids を消す**。
 *
 * 一意キー `(test_artifact_id, format_id, destination_key)` で **upsert** する
 * ので、再実行しても行は増えず `attempt_count` が進むだけ（§33）。
 * **失敗しても投げない** — 納品そのものは成功し得るため（§32 の最終行）。
 */
export async function recordDeliveryItem(rec: DeliveryItemRecord): Promise<{ ok: boolean; reason?: string }> {
  const sb = getServerSupabase();
  if (!sb) return { ok: false, reason: 'supabase_not_configured' };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = (sb.schema('diagnosis') as any).from('elith_delivery_items');

  // 既存行の attempt_count を引き継いで +1 する（upsert は列を丸ごと置き換えるため）。
  let attempt = 0;
  try {
    const { data } = await t
      .select('attempt_count')
      .eq('test_artifact_id', rec.testArtifactId)
      .eq('format_id', rec.formatId)
      .eq('destination_key', rec.destinationKey)
      .maybeSingle();
    const prior = (data as { attempt_count?: number } | null)?.attempt_count;
    if (typeof prior === 'number' && Number.isFinite(prior)) attempt = prior;
  } catch {
    attempt = 0;
  }

  const row = {
    test_artifact_id: rec.testArtifactId,
    diagnostic_user_id: rec.diagnosticUserId,
    format_id: rec.formatId,
    test_date: rec.testDate,
    source_key: rec.sourceKey,
    destination_key: rec.destinationKey,
    source_sha256: rec.sourceSha256,
    destination_sha256: rec.destinationSha256,
    status: rec.status,
    last_error: rec.lastError ?? null,
    attempt_count: attempt + 1,
    delivered_at: rec.status === 'delivered' ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  };

  try {
    const { error } = await t.upsert([row], { onConflict: 'test_artifact_id,format_id,destination_key' });
    if (error) return { ok: false, reason: String((error as { message?: string }).message ?? error) };
  } catch (err) {
    return { ok: false, reason: msg(err) };
  }
  return { ok: true };
}
