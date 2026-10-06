/**
 * トランスコスモス 10 名の **検査データ一括反映** (営業デモ向け・2026-10-06 P0)。
 *
 * ZIP 1 個・ボタン 1 回で、10 名それぞれの
 *
 *   健康診断 PDF  → 既存の追加検査登録 (`scan-part` → `original-ticket` → `finalize`)
 *   Genoplan PDF  → **この口** (原本だけを Supabase Storage へ置いて artifact へ紐付ける)
 *
 * を入れ、ダッシュボードに「人間ドック / 健康診断」「血液検査」「遺伝子検査」を出す。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【氏名を持たない】
 * ══════════════════════════════════════════════════════════════════════
 * ZIP のフォルダ名・ファイル名には氏名が入っている。**固定するのは
 * フォルダ番号 (01〜10) と uid / 受診日の対応だけ。** 氏名・メールアドレスを
 * コード・DB・ログ・保存キーのどこにも入れない。ブラウザもサーバへ送らない。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【完成済み AI疾病予防報告書 (`transcosmos-reports.ts`) とは別物】
 * ══════════════════════════════════════════════════════════════════════
 * あちらは `diagnosis_results` に PDF を持つ**報告書**で、こちらは
 * `test_artifacts` / `measurement_values` / `test_artifact_files` に入る**検査**。
 * **番号 → uid の対応も別**なので、どちらの表も流用しない (取り違えると別人に出る)。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【Genoplan だけ別扱いにする理由】
 * ══════════════════════════════════════════════════════════════════════
 * 実ファイルに 20MiB を少し超えるものがあり、汎用の原本アップロード
 * (`MAX_ORIGINAL_BYTES = 20MiB`) では `too_large` で止まる。**汎用の上限は変えない**
 * (通常の追加検査の仕様に触らない) 代わりに、**この口だけ 25MiB** とし、
 * 保存先も Object Lock 付きの原本バケットでなく **Supabase Storage `lab-results`**
 * にする。`getOriginalSignedUrl()` は相対キーなら `lab-results` の署名 URL を作るので、
 * 「原本を開く」は既存のまま動く。
 *
 * **208〜210 ページを LLM に解析させない** (§15)。遺伝子は原本 PDF の登録だけで、
 * 測定値は作らない (`measurements: []`)。AI に項目を捏造させない。
 */

/** フォルダ番号 → 対象者と日付。**氏名は持たない。** */
export interface TranscosSlot {
  /** 診断ユーザー ID (PII を含まない)。 */
  uid: string;
  /** 健康診断の受診日 (実ファイルから確定済み)。 */
  healthDate: string;
  /** Genoplan My Book の表紙に印字された発行日。 */
  geneticsDate: string;
}

export const TRANSCOS_SLOTS: Readonly<Record<string, TranscosSlot>> = Object.freeze({
  '01': { uid: '5c54a5aa-d6a9-416c-8e2d-8e12f50f6f49', healthDate: '2025-10-22', geneticsDate: '2026-08-12' },
  '02': { uid: 'fc3c6cd5-0264-4b5a-9f70-4010c316966c', healthDate: '2025-11-13', geneticsDate: '2026-08-12' },
  '03': { uid: 'fc2e785c-8a80-49bf-b694-93eb7f65e146', healthDate: '2025-11-14', geneticsDate: '2026-08-12' },
  '04': { uid: 'd81e6bc1-df02-4cae-8079-698898b69eda', healthDate: '2025-09-25', geneticsDate: '2026-08-12' },
  '05': { uid: 'b2447c25-5771-4ad5-9db0-05577cba3743', healthDate: '2025-09-18', geneticsDate: '2026-08-12' },
  '06': { uid: '2d40c6b1-03f4-4058-934f-16b32dd57cc6', healthDate: '2025-10-30', geneticsDate: '2026-08-12' },
  '07': { uid: 'ff5a9960-d1dd-4eca-b8bb-06c29d4f5e0f', healthDate: '2025-07-11', geneticsDate: '2026-08-12' },
  '08': { uid: 'fc0fd56b-0ab4-43a8-a25a-099e0060a16f', healthDate: '2025-08-04', geneticsDate: '2026-07-29' },
  '09': { uid: 'dfad9edd-2828-4227-ad54-63cbffc3bcf8', healthDate: '2025-09-04', geneticsDate: '2026-07-29' },
  '10': { uid: '4e7d49d9-9487-4205-8556-324ec507e515', healthDate: '2026-01-14', geneticsDate: '2026-08-12' },
});

/** 番号の一覧 (01〜10)。画面も検査もここを数える。 */
export const TRANSCOS_SLOT_IDS: readonly string[] = Object.freeze(Object.keys(TRANSCOS_SLOTS).sort());

/** Genoplan 原本の保存先バケット。**S3 ではない** (§12)。 */
export const TRANSCOS_GENETICS_BUCKET = 'lab-results';

/** この口だけの上限 25MiB。**汎用の `MAX_ORIGINAL_BYTES` (20MiB) は変えない** (§11)。 */
export const TRANSCOS_GENETICS_MAX_BYTES = 25 * 1024 * 1024;

/** artifact の出所。普段の admin バッチと区別が付くようにする。 */
export const TRANSCOS_IMPORTED_BY = 'transcosmos_bulk_202610';
export const TRANSCOS_GENETICS_LAB = 'Genoplan';

/** 遺伝子 artifact の `scan_md`。**事実だけ。** 医学的要約・評価は書かない (§17)。 */
export const TRANSCOS_GENETICS_NOTE =
  'Genoplan My Book 原本PDFを登録しています。「原本を開く」からご確認ください。';

const SLOT_RE = /^(0[1-9]|10)$/;
const SHA_RE = /^[0-9a-f]{64}$/i;

/** 番号が manifest に在るか。**在る番号しか通さない。** */
export function isTranscosSlot(slot: unknown): boolean {
  const s = String(slot ?? '');
  return SLOT_RE.test(s) && Object.prototype.hasOwnProperty.call(TRANSCOS_SLOTS, s);
}

/**
 * **番号から uid を引き直す。** クライアントが送ってきた uid は使わない —
 * 送らせると A さんの PDF が B さんに付く経路ができる。
 */
export function transcosSlotInfo(slot: unknown): TranscosSlot | null {
  const s = String(slot ?? '');
  return isTranscosSlot(s) ? TRANSCOS_SLOTS[s] : null;
}

/**
 * Genoplan 原本の保存キー。**サーバが採番する** (元ファイル名を受け取らない)。
 * 相対キーなので `getOriginalSignedUrl()` が `lab-results` の署名 URL を作る。
 */
export function geneticsStoragePath(uid: string, random: string): string {
  return `manual/transcosmos-tests/genetics/${uid}/${random}.pdf`;
}

/**
 * 保存キーの形 (**完全一致**)。部分一致にすると別領域を読ませる余地が残る。
 * uid もファイル名も UUID の形でなければ通さない (`..` や別 prefix を弾く)。
 */
const U = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const GENETICS_PATH_RE = new RegExp(`^manual/transcosmos-tests/genetics/(${U})/(${U})\\.pdf$`, 'i');

export function isGeneticsStoragePath(path: unknown): path is string {
  return GENETICS_PATH_RE.test(String(path ?? ''));
}

/** 保存キーに埋まっている uid。**キーと番号の突き合わせに使う** (別人のキーを弾く)。 */
export function uidFromGeneticsPath(path: unknown): string | null {
  const m = GENETICS_PATH_RE.exec(String(path ?? ''));
  return m ? m[1].toLowerCase() : null;
}

export type GeneticsInputCheck =
  | { ok: true; slot: string; info: TranscosSlot; sizeBytes: number; sha256: string; pageCount: number }
  | { ok: false; error: string; detail: string | null };

/**
 * ブラウザから来る 1 件ぶんを検める。**uid と受診日は引き直す** (申告を使わない)。
 * サイズ・SHA・ページ数は形だけ見る (実体の確認は Storage を見てから)。
 */
export function checkGeneticsInput(raw: unknown): GeneticsInputCheck {
  const e = (raw ?? {}) as Record<string, unknown>;
  const slot = String(e.slot ?? '');
  const info = transcosSlotInfo(slot);
  if (!info) return { ok: false, error: 'unknown_slot', detail: slot || null };

  const sizeBytes = Number(e.sizeBytes ?? e.size ?? 0);
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, error: 'invalid_size', detail: slot };
  }
  if (sizeBytes > TRANSCOS_GENETICS_MAX_BYTES) {
    return { ok: false, error: 'too_large', detail: `${slot}: ${sizeBytes} bytes` };
  }

  const sha256 = String(e.sha256 ?? '').toLowerCase();
  if (!SHA_RE.test(sha256)) return { ok: false, error: 'invalid_sha256', detail: slot };

  const pageCount = Number(e.pageCount ?? 0);
  if (!Number.isInteger(pageCount) || pageCount <= 0 || pageCount > 1000) {
    return { ok: false, error: 'invalid_page_count', detail: slot };
  }

  return { ok: true, slot, info, sizeBytes, sha256, pageCount };
}
