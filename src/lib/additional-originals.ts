/**
 * **スペシャルアカウント 追加検査の原本** — S3 キーの組み立てと、原本登録の判定。
 * 正本: `docs/specs/special_account_additional_tests_spec_20260930.md` §16 / §17 / §19〜§21 / §0.4.2。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ① キー: **氏名も元ファイル名も入れない**（§16）
 * ══════════════════════════════════════════════════════════════════════
 * 既存の `buildOriginalKey()`（`originals-upload-ticket.ts:108`）は
 * `lab_results/<company>/YYYY/MM/<filename>` で**ブラウザのファイル名をそのまま使う**。
 * 本田さん案件の実ファイル名が `250804ALAPDS結果本田大作.pdf` のように
 * **氏名を含む**ため、追加検査では使えない。
 *
 *   additional_results/{diagnostic_user_id}/{test_type}/{YYYY_MM_DD}/{sha256}.pdf
 *
 * `sha256` は**中身から決まる**ので、同じ PDF を何度上げても同じキー = 増えない（§33）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ② 原本登録の判定: **HTTP を組み立てない**（§0.4.2）
 * ══════════════════════════════════════════════════════════════════════
 * `lab-results/register.ts` と追加検査の `finalize` は**同じ判定**を使うが、
 * **返すエラー名と HTTP ステータスは違う**。
 *
 *   'same_sha'      → register : 200 `already_registered:true`
 *                   → 追加検査 : 200 `already_registered:true`
 *   'different_sha' → register : 409 `error:'file_exists'`      ★既存の契約のまま
 *                   → 追加検査 : 409 `error:'original_conflict'`
 *   'none'          → どちらも通常登録
 *
 * **ここで `'file_exists'` や `'original_conflict'` を返さない。**
 * 返してしまうと、**片方を直したときにもう片方が黙って変わる**
 * （呼び出し元の wellfort-site は `error === 'file_exists'` を見て文言を出している）。
 */

import { getOriginalsS3Config } from './originals-storage';
import {
  MAX_ORIGINAL_BYTES, PRESIGN_EXPIRES_SEC, isSha256Base64, signOriginalPut,
  type TicketResult,
} from './originals-upload-ticket';

/**
 * Admin から登録できる検査（`test_artifacts.test_type` の部分集合）。
 *
 * **2026-10-01 に `health_checkup` を足した**（P7）。正本
 * `docs/specs/special_account_management_spec_20261001.md` §11
 * （`special_account_additional_tests_spec_20260930.md` §4 の「4 種」を置き換える）。
 *
 * 検診・人間ドックは本人がアプリでスキャンする経路（`source='user_upload'`）が主だが、
 * **本人が入れられない回を Wellfort 管理者が代わりに入れられない**のは運用上の穴だった。
 * **どちらの経路でも同じユーザーの同じ検査データとして扱う**（§11.1）。
 *
 * **新しい解析は作らない。** `scanImageToParsed()` は `elith-hc-merge` と同じ関数で、
 * 検診・人間ドックの解析そのもの。健診専用 OCR も専用プロンプトも作らない（§11.2）。
 *
 * **重複 artifact を作らない**のが受入条件（§11.3）。
 * `test_artifacts` の UNIQUE は `source` を含み `external_test_id` が NULL だと効かないので、
 * **DB は守ってくれない**。`resolveAdditionalArtifact()`（`source` を条件に入れない）で
 * 本人の行を見つけ、`persistIntoExistingArtifact()` で中身だけ更新する。
 */
export const ADDITIONAL_TEST_TYPES = ['health_checkup', 'blood', 'cancer_urine', 'genetics', 'ai_prediction'] as const;
export type AdditionalTestType = (typeof ADDITIONAL_TEST_TYPES)[number];

export function isAdditionalTestType(v: unknown): v is AdditionalTestType {
  return typeof v === 'string' && (ADDITIONAL_TEST_TYPES as readonly string[]).includes(v);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * **実在する暦日か**（形式 + カレンダー往復）。`2025-13-45` / `2026-02-31` は false。
 *
 * **日付判定はこの 1 か所だけ**（Hardening 2）。以前は形式だけを見る `DATE_RE` が
 * 署名の段 (`createAdditionalOriginalTicket`) に、実在判定が保存の段
 * (`saveAdditionalArtifact`) にあり、**`2026-02-31` の PDF が S3 へ上がったあとに
 * DB 保存が 400 で落ちる**＝誰からも参照されない孤児ファイルが 10 年保管の
 * バケットに残り得た（原本バケットは削除不可）。
 */
export function isRealDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

/** `YYYY-MM-DD` → `YYYY_MM_DD`（S3 の日付フォルダ。Elith の命名と同じ流儀）。 */
export function dateFolder(testDate: string): string {
  return testDate.replace(/-/g, '_');
}

/** base64 の SHA-256（44 文字）を hex（64 文字）へ。**キーに入れるのは hex**。 */
export function sha256Base64ToHex(b64: string): string | null {
  if (!isSha256Base64(b64)) return null;
  try {
    const bin = atob(b64);
    if (bin.length !== 32) return null;
    let out = '';
    for (let i = 0; i < bin.length; i += 1) out += bin.charCodeAt(i).toString(16).padStart(2, '0');
    return out;
  } catch {
    return null;
  }
}

/**
 * 追加検査の原本キーを組む。**元ファイル名を受け取らない**（渡せないようにしてある）。
 * 不正な入力では `null`（当て推量で組まない）。
 */
export function buildAdditionalOriginalKey(input: {
  uid: string;
  testType: string;
  testDate: string;
  sha256Hex: string;
}): string | null {
  if (!UUID_RE.test(input.uid)) return null;
  if (!isAdditionalTestType(input.testType)) return null;
  if (!isRealDate(input.testDate)) return null;
  if (!SHA256_HEX_RE.test(input.sha256Hex)) return null;
  return `additional_results/${input.uid.toLowerCase()}/${input.testType}/${dateFolder(input.testDate)}/${input.sha256Hex}.pdf`;
}

/**
 * 署名・読み出しを許すキーか。**完全一致で見る**（部分一致にしない）。
 * `isOriginalUploadKey()` と同じ規律 — 原本バケットには納品物も入り得るので、
 * ここを緩めると **admin キー 1 本でバケットへ任意に書ける口**になる。
 */
export function isAdditionalOriginalKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 300) return false;
  if (key.includes('..') || key.includes('//') || key.startsWith('/')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) return false;
  const m = /^additional_results\/([0-9a-f-]{36})\/([a-z_]+)\/(\d{4})_(\d{2})_(\d{2})\/([0-9a-f]{64})\.pdf$/.exec(key);
  if (!m) return false;
  if (!UUID_RE.test(m[1])) return false;
  if (!isAdditionalTestType(m[2])) return false;
  const mo = Number(m[4]);
  const day = Number(m[5]);
  if (mo < 1 || mo > 12 || day < 1 || day > 31) return false;
  return true;
}

/**
 * 追加検査の原本アップロード用チケット（§17）。
 * **署名は `signOriginalPut()` を共用**する（Object Lock の checksum と
 * `unhoistableHeaders` の罠を再現しない）。
 */
export async function createAdditionalOriginalTicket(input: {
  uid: unknown;
  testType: unknown;
  testDate: unknown;
  bytes: unknown;
  sha256Base64: unknown;
}): Promise<TicketResult> {
  const cfg = getOriginalsS3Config();
  if (!cfg) {
    return {
      ok: false,
      error: 'originals_s3_not_configured',
      detail: 'AWS_S3_ORIGINALS_BUCKET / AWS_REGION が未設定です',
    };
  }
  if (typeof input.uid !== 'string' || !UUID_RE.test(input.uid)) {
    return { ok: false, error: 'invalid_diagnostic_user_id' };
  }
  if (!isAdditionalTestType(input.testType)) return { ok: false, error: 'invalid_test_type' };
  if (!isRealDate(input.testDate)) {
    // **受診日は必須**（§8）。today へ落とさない。
    // **実在する暦日かをここで見る**（Hardening 2）。形式だけ通すと `2026-02-31` の原本が
    // S3 へ上がったあとに DB 保存が 400 で落ち、**孤児ファイルが 10 年残る**。
    return { ok: false, error: 'invalid_test_date', detail: '受診日 (実在する YYYY-MM-DD) が要ります' };
  }
  if (!isSha256Base64(input.sha256Base64)) {
    return {
      ok: false,
      error: 'invalid_sha256',
      detail: 'ファイルの SHA-256 (base64・44 文字) が要ります。Object Lock バケットは checksum 無しの PUT を 400 で拒否します。',
    };
  }
  const bytes = typeof input.bytes === 'number' ? Math.trunc(input.bytes) : NaN;
  if (!Number.isFinite(bytes) || bytes <= 0) return { ok: false, error: 'invalid_size' };
  if (bytes > MAX_ORIGINAL_BYTES) {
    return { ok: false, error: 'too_large', detail: `${MAX_ORIGINAL_BYTES / 1024 / 1024} MB 以下にしてください` };
  }

  const hex = sha256Base64ToHex(input.sha256Base64);
  if (!hex) return { ok: false, error: 'invalid_sha256' };
  const key = buildAdditionalOriginalKey({
    uid: input.uid, testType: input.testType, testDate: input.testDate, sha256Hex: hex,
  });
  // サーバが組んだキーでも、署名の直前にもう一度検査する（組み立ての誤りを通さない）。
  if (!key || !isAdditionalOriginalKey(key)) return { ok: false, error: 'invalid_key', detail: key ?? '' };

  return signOriginalPut({
    cfg, key, contentType: 'application/pdf', bytes, sha256Base64: input.sha256Base64,
  });
}

export { MAX_ORIGINAL_BYTES, PRESIGN_EXPIRES_SEC };

/* ══════════════════════════════════════════════════════════════════════
 * 原本登録の判定（§19〜§21 / §0.4.2）
 * ════════════════════════════════════════════════════════════════════ */

/** `test_artifact_files` の既存行のうち、判定に要る分だけ。 */
export interface ExistingOriginalRow {
  id: string;
  storage_url: string;
  sha256: string;
  size_bytes: number;
  created_at: string;
}

/**
 * **判定だけを返す。エラー名も HTTP ステータスも決めない**（§0.4.2）。
 *
 *   'none'          … 同じ `file_kind` の行が無い → 通常登録
 *   'same_sha'      … 中身が同じ行が在る         → 何もしない（no-op）
 *   'different_sha' … 別の中身が在る             → 呼び出し側が止める
 *
 * **ここで `'file_exists'` / `'original_conflict'` を返してはいけない。**
 * 表現（error 文字列・ステータス）は各 API の契約であり、共有すると
 * **片方を直したときにもう片方が黙って変わる**。
 */
export type OriginalDecision = 'none' | 'same_sha' | 'different_sha';

export function decideOriginalRegistration(
  existing: readonly ExistingOriginalRow[] | null | undefined,
  incomingSha256: string,
): { decision: OriginalDecision; existing: ExistingOriginalRow[] } {
  const prior = (existing ?? []).slice();
  if (prior.length === 0) return { decision: 'none', existing: prior };
  if (prior.some((p) => p.sha256 === incomingSha256)) return { decision: 'same_sha', existing: prior };
  return { decision: 'different_sha', existing: prior };
}
