/**
 * 受取時・外部検査ID — **読み取り結果をサーバ側に控える**（仕様 §12.2 の案 (c)）。
 *
 * 正本: `docs/lab/kit_receipt_external_id_capture_spec.md` §12.2。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【なぜ要るか】`register` が画面の自己申告を信じていた
 * ══════════════════════════════════════════════════════════════════════
 * 画面は `read` で返した候補を **`manual` フィールドに載せて送り返して**いた。
 * `evaluateExternalId` は `manual` が入っていれば無条件に `manual_entry` を積むので、
 * **どんなにきれいに読めても `confirmed` にならず**、問診CSV のゲート（§7.1）が
 * 全件ブロックしていた（2026-10-21 実測）。
 *
 * 直し方は 3 つあり、**発注者が (c) を選んだ**（2026-10-22）:
 *   (a) 画面が barcode / printed を送り返す … **採らない**。一致する 2 値を送れば
 *       誰でも `confirmed` を作れる＝ゲートの前提が崩れる。
 *   (b) register で証跡画像をもう一度読む … 安全だが Gemini 呼び出しが 1 回増える。
 *   **(c) `read` の結果を `evidenceKey` で控え、register で引く** … 画面を信じず、
 *       追加の読み取りも無い。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【控える場所 = 証跡画像の隣（S3）。表を足さない】
 * ══════════════════════════════════════════════════════════════════════
 *   - **migration が要らない**（＝発注者の DB 適用を待たずに入る）。
 *   - **証跡と同じ prefix / 同じ寿命**。保存期間は仕様 §9 の D-3 で未決なので、
 *     あとで決めたライフサイクルが**画像と控えの両方に同時に効く**
 *     （別の場所に置くと片方だけ残る）。
 *   - **プロセス内メモリに置いてはいけない**: Vercel の serverless は
 *     `read` と `register` が**別インスタンスに載り得る**ので、控えが黙って消え、
 *     「撮れたのに登録できない」が再現しにくい形で出る。
 *
 * 【キーはサーバが組む。クライアントは触れない】
 * 控えのキーは**検証済みの証跡キー**（`isEvidenceKey`）から導くだけなので、
 * 任意のパスを書かせる余地が無い。`.read.json` は `createEvidenceTicket` が
 * 発行しない拡張子で、`isEvidenceKey` も通さない
 * → **ブラウザはこの控えを PUT も読み出しもできない**。
 *
 * 【控えるのは読み取りの生値だけ。判定は控えない】
 * `barcode` / `printed` を控え、**`register` で `evaluateExternalId` を呼び直す**。
 * 判定（`status` / `reasons`）を控えて使い回すと、`labid.*` を直したあとの回に
 * **古い判定が貼り付く**。判定の置き場所を 2 つにしない（CLAUDE.md の二重管理禁止）。
 *
 * 【バインドを必ず確かめる】
 * 控えには `uid` / `shipmentRef` / `provider` を書き、`register` で**全部一致**を要求する。
 * 証跡キーは推測不能な UUID だが、**漏れた 1 本で他人・別回の登録に使われない**よう
 * 形だけでなく結び付きで止める（追加検査の `invalid_original_binding` と同じ規律）。
 */

import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getS3Config, makeS3Client } from './s3';
import { isEvidenceKey } from './external-id-evidence';
import type { ExternalIdProvider } from './external-test-id';

/**
 * 控えの有効期間。**撮影 → 確認 → 登録**は続けて行う操作なので長く持たない。
 * 切れた回は「もう一度撮影してください」へ倒す（**fail-closed**）。
 */
export const READ_CACHE_TTL_MS = 60 * 60 * 1000;

/** 控えのキー。**証跡キーから導くだけ**（クライアントの指定を受けない）。 */
export function readCacheKey(evidenceKey: string): string {
  return `${evidenceKey}.read.json`;
}

interface CachedShape {
  v: 1;
  uid: string;
  shipment_ref: string;
  provider: string;
  /** Gemini が読んだ生値。**判定結果は入れない**（上のコメント参照）。 */
  barcode: string | null;
  printed: string | null;
  read_at: string;
}

export interface CachedRead {
  barcode: string | null;
  printed: string | null;
  readAt: string;
}

export type RememberResult = { ok: true } | { ok: false; error: string };

/**
 * `read` の結果を控える。**失敗を飲み込まない** —
 * 控えられなかった回は `register` で必ず詰まるので、
 * 呼び出し側は**確認画面へ進める前に**利用者へ伝える。
 */
export async function rememberRead(input: {
  /** 検証前の値を受ける（`isEvidenceKey` でここでも形を確かめる）。 */
  evidenceKey: unknown;
  diagnosticUserId: string;
  shipmentRef: string;
  provider: ExternalIdProvider;
  barcode: string | null;
  printed: string | null;
}): Promise<RememberResult> {
  const cfg = getS3Config();
  if (!cfg) return { ok: false, error: 's3_not_configured' };
  if (!isEvidenceKey(input.evidenceKey, cfg)) return { ok: false, error: 'invalid_key' };
  const evidenceKey: string = input.evidenceKey;

  const body: CachedShape = {
    v: 1,
    uid: input.diagnosticUserId,
    shipment_ref: input.shipmentRef,
    provider: input.provider,
    barcode: input.barcode ?? null,
    printed: input.printed ?? null,
    read_at: new Date().toISOString(),
  };

  try {
    await makeS3Client(cfg).send(new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: readCacheKey(evidenceKey),
      Body: JSON.stringify(body),
      ContentType: 'application/json; charset=utf-8',
    }));
  } catch {
    return { ok: false, error: 'read_cache_write_failed' };
  }
  return { ok: true };
}

export type RecallResult =
  | { ok: true; read: CachedRead }
  | { ok: false; status: number; error: string };

/**
 * 控えを引く。**バインドが 1 つでも違えば通さない。**
 *
 * 返すのは読み取りの生値だけで、**値を採るのも判定するのも呼び出し側の
 * `evaluateExternalId`**（判定の置き場所を増やさない）。
 */
export async function recallRead(input: {
  evidenceKey: unknown;
  diagnosticUserId: string;
  shipmentRef: string;
  provider: ExternalIdProvider;
  now?: Date;
}): Promise<RecallResult> {
  const cfg = getS3Config();
  if (!cfg) return { ok: false, status: 503, error: 's3_not_configured' };
  if (!isEvidenceKey(input.evidenceKey, cfg)) return { ok: false, status: 400, error: 'invalid_key' };

  let text: string;
  try {
    const res = await makeS3Client(cfg).send(new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: readCacheKey(input.evidenceKey),
    }));
    if (!res.Body) return { ok: false, status: 409, error: 'read_result_missing' };
    text = await res.Body.transformToString();
  } catch {
    return { ok: false, status: 409, error: 'read_result_missing' };
  }

  let row: CachedShape | null = null;
  try {
    const parsed = JSON.parse(text) as CachedShape;
    if (parsed && typeof parsed === 'object' && parsed.v === 1) row = parsed;
  } catch {
    row = null;
  }
  if (!row) return { ok: false, status: 409, error: 'read_result_unreadable' };

  // **結び付きを全部確かめる。** 1 つでも違えば他人・別回・別検査の控え。
  if (row.uid !== input.diagnosticUserId
    || row.shipment_ref !== input.shipmentRef
    || row.provider !== input.provider) {
    return { ok: false, status: 409, error: 'read_result_mismatch' };
  }

  const at = Date.parse(row.read_at);
  const now = (input.now ?? new Date()).getTime();
  // **読めない日時は期限切れ扱い**（通すと無期限の控えになる）。
  if (!Number.isFinite(at) || now - at > READ_CACHE_TTL_MS || at - now > READ_CACHE_TTL_MS) {
    return { ok: false, status: 409, error: 'read_result_expired' };
  }

  return {
    ok: true,
    read: { barcode: row.barcode ?? null, printed: row.printed ?? null, readAt: row.read_at },
  };
}
