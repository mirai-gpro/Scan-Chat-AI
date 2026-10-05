/**
 * トランスコスモス 10 名の **完成済み AI疾病予防報告書 PDF** を本人へ見せるための
 * 決定論部分 (slot↔uid の対応・保存キー・検証)。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【この 10 本が何で、何でないか】取り違えると別の検査として登録される
 * ══════════════════════════════════════════════════════════════════════
 *
 *   これ    … **AI疾病予防報告書** の完成済み PDF (Elith の出力を組版したもの)
 *   違うもの … `ai_prediction` / 「AI疾病発症予測」/ LAiF
 *
 * したがって **`test_artifacts` には 1 行も書かない**。`test_type='ai_prediction'`
 * として登録してはいけない。Elith JSON への逆変換もしない。
 * 置き場所は `diagnosis.diagnosis_results` (= 「Elith の診断結果 1 回分」) で、
 * 受領 JSON の代わりに **PDF だけ**を持つ行として入れる。
 *
 * 【PII をこのリポジトリへ持ち込まない】ZIP 内のファイル名には氏名が入っているが、
 * **固定するのは先頭 2 桁 (01〜10) と uid の対応だけ**。氏名・メールアドレスは
 * コードにも DB にもログにも保存キーにも入れない。管理画面が選択した ZIP から
 * 読んだファイル名をその場で表示するのは可 (ブラウザ内に留まる)。
 */

/** 10 名の slot (ZIP のファイル名先頭 2 桁) → `diagnostic_user_id`。**氏名は持たない。** */
export const TRANSCOSMOS_SLOT_UIDS: Readonly<Record<string, string>> = Object.freeze({
  '01': '2d40c6b1-03f4-4058-934f-16b32dd57cc6',
  '02': '5c54a5aa-d6a9-416c-8e2d-8e12f50f6f49',
  '03': 'ff5a9960-d1dd-4eca-b8bb-06c29d4f5e0f',
  '04': '4e7d49d9-9487-4205-8556-324ec507e515',
  '05': 'fc2e785c-8a80-49bf-b694-93eb7f65e146',
  '06': 'd81e6bc1-df02-4cae-8079-698898b69eda',
  '07': 'dfad9edd-2828-4227-ad54-63cbffc3bcf8',
  '08': 'b2447c25-5771-4ad5-9db0-05577cba3743',
  '09': 'fc3c6cd5-0264-4b5a-9f70-4010c316966c',
  '10': 'fc0fd56b-0ab4-43a8-a25a-099e0060a16f',
});

/** `01`〜`10` の昇順。画面と検証で同じ順序を使う。 */
export const TRANSCOSMOS_SLOTS: readonly string[] = Object.freeze(
  Object.keys(TRANSCOSMOS_SLOT_UIDS).sort(),
);

/** この一括登録が表す回。保存キーと `source_key` の両方に入る。 */
export const TRANSCOSMOS_BATCH = '20260928';

/** 保存先 (Supabase Storage のバケット)。既存の原本置き場と同じものを使う。 */
export const TRANSCOSMOS_BUCKET = 'lab-results';

/** `diagnosis_results.schema_version`。受領 JSON ではなく PDF だけの行であることの印。 */
export const TRANSCOSMOS_SCHEMA_VERSION = 'manual-pdf-v1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const SLOT_RE = /^(?:0[1-9]|10)$/;

/** PDF 1 本の上限。最大は実測 15MB 超なので余裕を持たせる (ブラウザ→Storage 直送)。 */
export const TRANSCOSMOS_MAX_BYTES = 40 * 1024 * 1024;

/** `slot` が 01〜10 のいずれかで、かつ対応 uid を持つか。 */
export function isTranscosmosSlot(slot: unknown): boolean {
  const s = String(slot ?? '');
  return SLOT_RE.test(s) && s in TRANSCOSMOS_SLOT_UIDS;
}

/**
 * **slot から uid を引く。これがサーバ側の正。**
 *
 * クライアントが送ってきた uid は**信用しない** — 送られた uid を使うと、
 * admin 画面を踏んだ誰かが slot と別人の uid を組み合わせて
 * **他人の枠へ PDF を紐付けられる**。slot だけ受け取ってここで引き直す。
 */
export function transcosmosUidForSlot(slot: unknown): string | null {
  const s = String(slot ?? '');
  return isTranscosmosSlot(s) ? TRANSCOSMOS_SLOT_UIDS[s] ?? null : null;
}

/** ZIP 内の basename から slot を取り出す。`01_<氏名>….pdf` → `01`。 */
export function slotFromPdfName(name: unknown): string | null {
  const base = String(name ?? '').split('/').pop() ?? '';
  const m = /^(0[1-9]|10)[_\-\s]/.exec(base);
  if (!m) return null;
  if (!/\.pdf$/i.test(base)) return null;
  return m[1];
}

/**
 * Supabase Storage の保存キー。
 *
 * **氏名・元ファイル名・メールアドレスを入れない。** 末尾を乱数にするのは、
 * 同じ ZIP を再実行したときに**キー衝突で upsert が要らなくなる**ため
 * (既存オブジェクトを上書きせず、新しいキーへ置いて DB の参照だけ差し替える)。
 */
export function transcosmosStoragePath(uid: string, random: string): string {
  if (!UUID_RE.test(uid)) throw new Error('transcosmosStoragePath: uid の形式が違う');
  if (!/^[0-9a-f-]{36}$/i.test(random)) throw new Error('transcosmosStoragePath: random の形式が違う');
  return `manual/transcosmos/${TRANSCOSMOS_BATCH}/${uid}/${random}.pdf`;
}

/** 保存キーが規約どおりか (読み出し側・検証側の両方で使う)。 */
export function isTranscosmosStoragePath(path: unknown): path is string {
  const p = String(path ?? '');
  const m = new RegExp(
    `^manual/transcosmos/${TRANSCOSMOS_BATCH}/([0-9a-f-]{36})/([0-9a-f-]{36})\\.pdf$`,
  ).exec(p);
  if (!m) return false;
  return UUID_RE.test(m[1]) && UUID_RE.test(m[2]);
}

/** `diagnosis_results.source_key`。**uid 込みなので人ごとに 1 本**で、冪等の鍵になる。 */
export function transcosmosSourceKey(uid: string): string {
  if (!UUID_RE.test(uid)) throw new Error('transcosmosSourceKey: uid の形式が違う');
  return `manual:transcosmos:${TRANSCOSMOS_BATCH}:${uid}`;
}

export interface TranscosmosPlanItem {
  slot: string;
  sizeBytes: number;
  sha256: string;
}

export interface TranscosmosValidated {
  slot: string;
  uid: string;
  sizeBytes: number;
  sha256: string;
}

export type TranscosmosValidation =
  | { ok: true; items: TranscosmosValidated[] }
  | { ok: false; error: string; detail?: string };

/**
 * **10 件ちょうど・01〜10 が各 1 件・重複なし・0 byte なし・SHA-256 の形**を見る。
 *
 * 1 つでも欠けたら**全部通さない**。10 名まとめての登録なので、
 * 半分だけ入った状態を作ると「誰が入っていて誰が入っていないか」が
 * 画面からも DB からも分からなくなる。
 *
 * **PDF の中身は見ない** (医学的な解析はしない)。見るのは形だけ。
 */
export function validateTranscosmosPlan(raw: unknown): TranscosmosValidation {
  if (!Array.isArray(raw)) return { ok: false, error: 'files_not_array' };
  if (raw.length !== TRANSCOSMOS_SLOTS.length) {
    return { ok: false, error: 'file_count_mismatch', detail: `${raw.length} 件 (10 件ちょうどが必要)` };
  }

  const seen = new Set<string>();
  const items: TranscosmosValidated[] = [];
  for (const entry of raw) {
    const e = (entry ?? {}) as Partial<TranscosmosPlanItem>;
    const slot = String(e.slot ?? '');
    if (!isTranscosmosSlot(slot)) return { ok: false, error: 'unknown_slot', detail: slot.slice(0, 8) };
    if (seen.has(slot)) return { ok: false, error: 'duplicate_slot', detail: slot };
    seen.add(slot);

    const sha256 = String(e.sha256 ?? '').toLowerCase();
    if (!SHA_RE.test(sha256)) return { ok: false, error: 'invalid_sha256', detail: slot };

    const sizeBytes = Number(e.sizeBytes ?? 0);
    if (!Number.isFinite(sizeBytes) || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      return { ok: false, error: 'invalid_size', detail: slot };
    }
    if (sizeBytes > TRANSCOSMOS_MAX_BYTES) return { ok: false, error: 'file_too_large', detail: slot };

    // **uid はここで引き直す。** クライアントが送った uid は見ない。
    const uid = transcosmosUidForSlot(slot)!;
    items.push({ slot, uid, sizeBytes, sha256 });
  }

  if (seen.size !== TRANSCOSMOS_SLOTS.length) {
    return { ok: false, error: 'slot_coverage_incomplete', detail: `${seen.size} slots` };
  }
  items.sort((a, b) => a.slot.localeCompare(b.slot));
  return { ok: true, items };
}
