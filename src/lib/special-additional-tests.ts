/**
 * **スペシャルアカウント 追加検査** — 対象者の判定 / artifact の確定 / 原本の紐付け。
 * 正本: `docs/specs/special_account_additional_tests_spec_20260930.md` §6 / §18 〜 §22 / §28。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ① artifact の確定（**本機能の核心**・§18）
 * ══════════════════════════════════════════════════════════════════════
 * 検索キーは
 *
 *     diagnostic_user_id ＋ test_type ＋ test_date ＋ status='active'
 *
 * で、**`source` を条件に入れない**。
 *
 * 理由（§0.3 P-1 / P-2・実障害）:
 *   - `test_artifacts` の UNIQUE は `(uid, source, test_type, test_date, external_test_id)`
 *     で **`source` を含み**、`external_test_id` が NULL のときは
 *     **PostgreSQL が NULL 同士を別物として扱うので効かない**
 *     （`20260601000010_schemas_and_tables.sql:208`）。**DB は重複を止めてくれない。**
 *   - `persistAdminBatchArtifact()` は **`source='admin_batch'` の行しか置き換えない**
 *     （`scan-persist.ts:306`）。既に `source='wellfort_lab'` の行がある人に流すと
 *     **行が増える** — これが本田さんの重複事故の機序。
 *
 * → 0 件 = 新規作成 / 1 件 = **その行へ入れる** / 2 件以上 = **止める**（自動判断禁止）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ② 受診日は必須。today へ落とさない（§8 / §47）
 * ══════════════════════════════════════════════════════════════════════
 * `persistAdminBatchArtifact()` は不正な日付を `jstToday()` にする（`scan-persist.ts:295`）。
 * **渡す前にここで弾く。** 受診日が今日に化けると、複数年が同じ日付に畳まれて
 * S3 キーが衝突し、**片方が消える**（`がんリスク検査_ALA-PDS_追加登録手順書.md` の前例）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ③ 原本（§19 〜 §21）
 * ══════════════════════════════════════════════════════════════════════
 * **ブラウザの自己申告値を DB へ保存しない。** S3 の実体を読み直して
 * SHA256 / サイズ / Content-Type を確定する（`register.ts:8` と同じ規律）。
 * 判定は `additional-originals.ts` の `decideOriginalRegistration()` を共用し、
 * **エラー名（`original_conflict`）はこちら側で決める**（§0.4.2）。
 */

import { getServerSupabase } from './supabase';
import {
  persistAdminBatchArtifact, persistIntoExistingArtifact,
  TEST_TYPE_BY_FORMAT, type ArtifactTestType,
} from './scan-persist';
import { isSpecialAccount } from './special-accounts';
import { readUploadedOriginal } from './originals-upload-ticket';
import {
  decideOriginalRegistration, isAdditionalTestType,
  type AdditionalTestType, type ExistingOriginalRow,
} from './additional-originals';
import type { ElithFormatId } from './elith-export';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// supabase-js の型を引き回さずに使うための最小形（`register.ts:64` と同じ）。
type Db = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const db = (sb: NonNullable<ReturnType<typeof getServerSupabase>>): Db =>
  sb.schema('diagnosis') as unknown as Db;

/**
 * `test_type` → Elith `format_id`。
 * **新しい対応表を作らない** — `scan-persist.ts` の `TEST_TYPE_BY_FORMAT` を**反転**する
 * （2 つ持つと片方だけ直る）。
 */
export const FORMAT_BY_TEST_TYPE: Record<AdditionalTestType, ElithFormatId> = (() => {
  const out = {} as Record<AdditionalTestType, ElithFormatId>;
  for (const [format, type] of Object.entries(TEST_TYPE_BY_FORMAT)) {
    if (isAdditionalTestType(type)) out[type] = format as ElithFormatId;
  }
  return out;
})();

/**
 * `scan-part` が返したページ 1 枚ぶん（`finalize` がそのまま受け取る形）。
 * **ブラウザが持ち回る値**なので、ここでは形だけを決めて中身は信用しない
 * （受診日・原本の SHA256 はサーバが別途確定する）。
 */
export interface AdditionalPageLike {
  page?: unknown;
  items?: unknown;
  measurements?: unknown;
  notes?: unknown;
  raw_markdown?: unknown;
  raw?: unknown;
  section?: unknown;
}

/** `data.items[]` 型（測定値を持たない）。**`rows=0` は正常**（§13）。 */
export function isItemsFormat(testType: AdditionalTestType): boolean {
  return testType === 'genetics' || testType === 'ai_prediction';
}

/* ══════════════════════════════════════════════════════════════════════
 * 対象者（§6 / §44 A）
 * ════════════════════════════════════════════════════════════════════ */

export type TargetCheck =
  | { ok: true; uid: string }
  | { ok: false; error: 'invalid_diagnostic_user_id' | 'not_special_account'; detail: string };

/**
 * 対象は**スペシャルアカウントだけ**。
 * `isSpecialAccount()` は **uid が一覧にあるか、それだけ**を見る（admin かどうかは見ない）。
 * **UID が確定していない（メール登録だけでサインイン前の）アカウントは通さない** —
 * uid が無ければ `test_artifacts` の行を作れないため、ここで止めるほうが親切。
 */
export function checkAdditionalTarget(uid: unknown): TargetCheck {
  if (typeof uid !== 'string' || !UUID_RE.test(uid)) {
    return { ok: false, error: 'invalid_diagnostic_user_id', detail: '診断ユーザー ID (UUID) が要ります' };
  }
  if (!isSpecialAccount(uid)) {
    return {
      ok: false,
      error: 'not_special_account',
      detail: 'この機能はスペシャルアカウントの利用者にだけ使えます。先に /admin/special-accounts で登録してください。',
    };
  }
  return { ok: true, uid };
}

/* ══════════════════════════════════════════════════════════════════════
 * artifact の確定（§18）
 * ════════════════════════════════════════════════════════════════════ */

export interface ArtifactCandidate {
  id: string;
  test_date: string | null;
  source: string;
  display_mode: string;
}

export type ArtifactResolution =
  | { kind: 'none' }
  | { kind: 'one'; artifactId: string; candidate: ArtifactCandidate }
  | { kind: 'ambiguous'; candidates: ArtifactCandidate[] }
  | { kind: 'error'; detail: string };

/**
 * `uid + test_type + test_date + status='active'` で既存 artifact を探す。
 * **`source` を検索条件に入れない**（上の ①）。
 */
export async function resolveAdditionalArtifact(input: {
  uid: string;
  testType: ArtifactTestType;
  testDate: string;
}): Promise<ArtifactResolution> {
  const sb = getServerSupabase();
  if (!sb) return { kind: 'error', detail: 'supabase_not_configured' };
  if (!DATE_RE.test(input.testDate)) return { kind: 'error', detail: 'invalid_test_date' };

  const { data, error } = await db(sb)
    .from('test_artifacts')
    .select('id, test_date, status, source, display_mode')
    .eq('diagnostic_user_id', input.uid)
    .eq('test_type', input.testType)
    .eq('test_date', input.testDate)
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  if (error) return { kind: 'error', detail: error.message };

  const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r): ArtifactCandidate => ({
    id: String(r.id),
    test_date: typeof r.test_date === 'string' ? r.test_date.slice(0, 10) : null,
    source: String(r.source ?? ''),
    display_mode: String(r.display_mode ?? ''),
  }));

  if (rows.length === 0) return { kind: 'none' };
  if (rows.length === 1) return { kind: 'one', artifactId: rows[0].id, candidate: rows[0] };
  // **勝手に最新 1 件を選ばない。** 候補を返して人に決めさせる。
  return { kind: 'ambiguous', candidates: rows };
}

export type SaveResult =
  | { ok: true; artifactId: string; rows: number; created: boolean; reason?: string }
  | { ok: false; error: 'artifact_ambiguous'; candidates: ArtifactCandidate[] }
  | { ok: false; error: 'invalid_test_date' | 'save_failed' | 'artifact_mismatch'; detail: string };

/**
 * 解析結果を `test_artifacts` / `measurement_values` へ保存する（§18 / §22）。
 *
 * - 0 件 → `persistAdminBatchArtifact()`（`source='admin_batch'`）
 * - 1 件 → `persistIntoExistingArtifact()`（**`scan_md` と測定値だけ**更新。
 *   `source` / `external_test_id` / `lab_name` / `display_mode` / `test_date` /
 *   `status` / 既存の原本は触らない）
 * - 2 件以上 → `artifact_ambiguous` で停止
 *
 * **測定値の書き込み口は `persistMeasurements()` だけ**（両関数の内側で呼ばれる）。
 * ここで独自に INSERT しない（§47）。
 * items 形式（遺伝子 / AI疾病）は `measurements: []` で呼ぶ → **`rows=0` は正常**（§13）。
 */
export async function saveAdditionalArtifact(input: {
  uid: string;
  testType: AdditionalTestType;
  testDate: string;
  markdownClean: string;
  measurements: Record<string, unknown>[];
  pageCount?: number;
}): Promise<SaveResult> {
  // **受診日は必須。ここで弾く**（下の 2 関数は today へ落とす・§8 / §47）。
  if (!DATE_RE.test(input.testDate)) {
    return { ok: false, error: 'invalid_test_date', detail: '受診日 (YYYY-MM-DD) が要ります。実行日で代用しません。' };
  }

  const found = await resolveAdditionalArtifact({ uid: input.uid, testType: input.testType, testDate: input.testDate });
  if (found.kind === 'error') return { ok: false, error: 'save_failed', detail: found.detail };
  if (found.kind === 'ambiguous') return { ok: false, error: 'artifact_ambiguous', candidates: found.candidates };

  if (found.kind === 'one') {
    const r = await persistIntoExistingArtifact({
      artifactId: found.artifactId,
      diagnosticUserId: input.uid,
      testType: input.testType,
      markdownClean: input.markdownClean,
      measurements: input.measurements,
      testDate: input.testDate,
    });
    if (r.mismatch) return { ok: false, error: 'artifact_mismatch', detail: r.mismatch };
    if (!r.artifactId) return { ok: false, error: 'save_failed', detail: r.reason ?? 'artifact 更新に失敗しました' };
    return { ok: true, artifactId: r.artifactId, rows: r.rows, created: false, reason: r.reason };
  }

  const c = await persistAdminBatchArtifact({
    diagnosticUserId: input.uid,
    testType: input.testType,
    markdownClean: input.markdownClean,
    measurements: input.measurements,
    testDate: input.testDate,
    pageCount: input.pageCount,
  });
  if (!c.artifactId) return { ok: false, error: 'save_failed', detail: c.reason ?? 'artifact 作成に失敗しました' };
  return { ok: true, artifactId: c.artifactId, rows: c.rows, created: true, reason: c.reason };
}

/* ══════════════════════════════════════════════════════════════════════
 * 原本の紐付け（§19 / §20 / §21）
 * ════════════════════════════════════════════════════════════════════ */

export type OriginalLinkResult =
  | { ok: true; alreadyRegistered: boolean; storageUrl: string; sha256: string; sizeBytes: number; contentType: string | null }
  | { ok: false; error: 'original_conflict'; detail: string; existing: ExistingOriginalRow[] }
  | { ok: false; error: string; detail: string | null };

/** S3 の実体から確定した原本の情報（`readUploadedOriginal()` の成功形）。 */
export type ReadOriginal = Extract<Awaited<ReturnType<typeof readUploadedOriginal>>, { ok: true }>;

/**
 * **原本が本当に S3 に在るかを先に確かめる**（§28 の 3 番目）。
 * ここで落ちたら **DB へ 1 行も書かない** — 「上げたことにして DB だけ書く」を作らない。
 * 読むのは 1 回だけで、結果をそのまま `linkAdditionalOriginal()` へ渡す
 * （20MB の PDF を 2 度読まない）。
 */
export async function readAdditionalOriginal(key: string): Promise<ReadOriginal | { ok: false; error: string; detail: string | null }> {
  const got = await readUploadedOriginal(key);
  if (!got.ok) return { ok: false, error: got.error, detail: got.detail ?? null };
  return got;
}

/**
 * S3 に置かれた原本を `test_artifact_files` へ **`raw_pdf`** として紐付ける（§19）。
 *
 * - **自己申告を信じない** — SHA256 / サイズ / Content-Type は
 *   `readAdditionalOriginal()` が **S3 の実体から**取ったものだけを使う。
 * - 同じ SHA256 が既に付いていれば **no-op で成功**（§20・再実行で増えない）。
 * - **違う SHA256 が既にある → `original_conflict` で停止**（§21）。
 *   **黙って差し替えない。** 既存 `register.ts` の `replace` 経路は呼ばない。
 *   `redaction` は未実装なので `raw_pdf_redacted` を名乗らない（§19）。
 */
export async function linkAdditionalOriginal(input: {
  artifactId: string;
  original: ReadOriginal;
}): Promise<OriginalLinkResult> {
  const sb = getServerSupabase();
  if (!sb) return { ok: false, error: 'supabase_not_configured', detail: null };

  const got = input.original;
  const fileKind = 'raw_pdf';
  const { data: existing, error: exErr } = await db(sb)
    .from('test_artifact_files')
    .select('id, file_kind, storage_url, sha256, size_bytes, created_at')
    .eq('test_artifact_id', input.artifactId)
    .eq('file_kind', fileKind);
  if (exErr) return { ok: false, error: 'db_error', detail: exErr.message };

  const prior = (existing ?? []) as ExistingOriginalRow[];
  // **判定は共通。表現（エラー名・ステータス）はこちらが決める**（§0.4.2）。
  const { decision } = decideOriginalRegistration(prior, got.sha256);
  if (decision === 'same_sha') {
    return {
      ok: true, alreadyRegistered: true,
      storageUrl: got.storageUrl, sha256: got.sha256, sizeBytes: got.sizeBytes, contentType: got.contentType ?? null,
    };
  }
  if (decision === 'different_sha') {
    return {
      ok: false,
      error: 'original_conflict',
      detail: `この検査には別の内容の原本が既に ${prior.length} 件あります。差し替えは管理者が明示的に行ってください。`,
      existing: prior,
    };
  }

  const { error: insErr } = await db(sb)
    .from('test_artifact_files')
    .insert({
      test_artifact_id: input.artifactId,
      file_kind: fileKind,
      storage_url: got.storageUrl,
      sha256: got.sha256,
      size_bytes: got.sizeBytes,
    });
  if (insErr) return { ok: false, error: 'db_error', detail: insErr.message };

  return {
    ok: true, alreadyRegistered: false,
    storageUrl: got.storageUrl, sha256: got.sha256, sizeBytes: got.sizeBytes, contentType: got.contentType ?? null,
  };
}
