// src/lib/ad-hoc-diagnosis/store.ts
// 臨時診断バッチ: DB (diagnosis スキーマ 6 表) への読み書き。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §23
// migration: supabase/migrations/20260910000020_ad_hoc_diagnosis.sql
//
// **API ルートから直接 Supabase を触らない。** 表の形を知るのはこのファイルだけにする
// (列を足すときにここ 1 か所で済む)。
//
// 型は `src/types/supabase.ts` にまだ載っていない (migration を Production へ当てていないため
// 型再生成をしていない) ので、**この層でだけ最小の形を宣言して `as unknown as` で通す**。
// 既存 `measurement-persist.ts` / `app-config.ts` が同じやり方をしている。

import { getServerSupabase } from '../supabase';
import type { FormatId, Confidence, SourceKind } from './classify';
import type { RejectReason } from './archive';

// ---------------------------------------------------------------------------
// 型 (DB の行)
// ---------------------------------------------------------------------------

export type BatchStatus =
  | 'draft'
  | 'uploaded'
  | 'classified'
  | 'processing'
  | 'needs_review'
  | 'ready'
  | 'exporting'
  | 'completed'
  | 'failed';

export type SubjectIdentityStatus = 'confirmed' | 'needs_review' | 'unresolved';
export type SubjectStatus = 'pending' | 'processing' | 'needs_review' | 'ready' | 'failed';
export type ParseStatus = 'pending' | 'processing' | 'done' | 'failed' | 'unsupported' | 'skipped';
export type PageStatus = 'pending' | 'processing' | 'done' | 'failed';
export type OutputStatus = 'pending' | 'generated' | 'exported' | 'failed';
export type ValidationStatus = 'pending' | 'ok' | 'warn' | 'error';
export type EventName =
  | 'created' | 'classified' | 'reclassified' | 'parsed' | 'page_done'
  | 'page_failed' | 'confirmed' | 'exported' | 'retry' | 'override';

export interface BatchRow {
  id: string;
  title: string;
  status: BatchStatus;
  bundle_date: string | null;
  source_sha256: string;
  declared_source_size: number;
  source_size: number | null;
  source_key: string;
  subject_count: number;
  file_count: number;
  required_formats: string[];
  optional_formats: string[];
  retain_originals: boolean;
  created_by_user_id: string | null;
  created_by_masked: string | null;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
  exported_at: string | null;
  last_error: string | null;
}

export interface SubjectRow {
  id: string;
  batch_id: string;
  subject_no: number;
  subject_fp: string | null;
  subject_fp_source: 'auto' | 'manual';
  client_id: string;
  diagnostic_id: string | null;
  identity_status: SubjectIdentityStatus;
  identity_reason: string | null;
  sex: 'male' | 'female' | 'unknown';
  age: number | null;
  status: SubjectStatus;
  created_at: string;
  updated_at: string;
}

export interface FileRow {
  id: string;
  batch_id: string;
  subject_id: string | null;
  storage_key: string;
  display_name: string;
  sha256: string;
  size_bytes: number;
  mime_type: string | null;
  source_kind: SourceKind;
  classified_format_id: FormatId | null;
  classification_confidence: Confidence;
  test_date: string | null;
  parse_status: ParseStatus;
  page_count: number | null;
  selected_as_primary: boolean;
  duplicate_of_file_id: string | null;
  error_detail: string | null;
  created_at: string;
  updated_at: string;
}

export interface PageRow {
  id: string;
  file_id: string;
  file_sha256: string;
  page_no: number;
  status: PageStatus;
  parsed: unknown;
  raw: string | null;
  attempts: number;
  error_detail: string | null;
}

export interface OutputRow {
  id: string;
  subject_id: string;
  format_id: FormatId;
  output_status: OutputStatus;
  json_storage_key: string | null;
  validation_status: ValidationStatus;
  item_count: number | null;
  test_date: string | null;
  generated_at: string | null;
  error_detail: string | null;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** Supabase が未設定なら null。**呼び出し側は 503 を返す** (黙って成功にしない)。 */
function db() {
  const sb = getServerSupabase();
  if (!sb) return null;
  return sb.schema('diagnosis') as unknown as {
    from: (t: string) => any;
  };
}

export function isStoreAvailable(): boolean {
  return db() !== null;
}

class StoreUnavailable extends Error {
  constructor() {
    super('Supabase が未設定 (PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    this.name = 'StoreUnavailable';
  }
}

function need() {
  const d = db();
  if (!d) throw new StoreUnavailable();
  return d;
}

function unwrap<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data == null) throw new Error(`${what}: 行が返らなかった`);
  return res.data;
}

// ---------------------------------------------------------------------------
// batches
// ---------------------------------------------------------------------------

export async function createBatch(input: {
  id: string;
  title: string;
  sourceSha256: string;
  declaredSourceSize: number;
  sourceKey: string;
  requiredFormats: string[];
  optionalFormats: string[];
  retainOriginals?: boolean;
  createdByUserId?: string | null;
  createdByMasked?: string | null;
}): Promise<BatchRow> {
  const res = await need()
    .from('ad_hoc_diagnosis_batches')
    .insert({
      id: input.id,
      title: input.title,
      status: 'draft',
      source_sha256: input.sourceSha256,
      declared_source_size: input.declaredSourceSize,
      source_key: input.sourceKey,
      required_formats: input.requiredFormats,
      optional_formats: input.optionalFormats,
      retain_originals: input.retainOriginals ?? false,
      created_by_user_id: input.createdByUserId ?? null,
      created_by_masked: input.createdByMasked ?? null,
    })
    .select('*')
    .single();
  return unwrap<BatchRow>(res, 'createBatch');
}

export async function getBatch(id: string): Promise<BatchRow | null> {
  const res = await need().from('ad_hoc_diagnosis_batches').select('*').eq('id', id).maybeSingle();
  if (res.error) throw new Error(`getBatch: ${res.error.message}`);
  return (res.data as BatchRow) ?? null;
}

export async function listBatches(limit = 50): Promise<BatchRow[]> {
  const res = await need()
    .from('ad_hoc_diagnosis_batches')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (res.error) throw new Error(`listBatches: ${res.error.message}`);
  return (res.data as BatchRow[]) ?? [];
}

/** 同じ ZIP の再投入を検知する (§19.1)。**拒否も自動続行もしない。警告のため。** */
export async function findBatchesBySha(sha256: string, excludeId?: string): Promise<BatchRow[]> {
  const res = await need()
    .from('ad_hoc_diagnosis_batches')
    .select('*')
    .eq('source_sha256', sha256)
    .order('created_at', { ascending: false });
  if (res.error) throw new Error(`findBatchesBySha: ${res.error.message}`);
  const rows = (res.data as BatchRow[]) ?? [];
  return excludeId ? rows.filter((r) => r.id !== excludeId) : rows;
}

export async function updateBatch(
  id: string,
  patch: Partial<
    Pick<
      BatchRow,
      | 'status' | 'bundle_date' | 'source_size' | 'subject_count' | 'file_count'
      | 'confirmed_at' | 'exported_at' | 'last_error' | 'required_formats' | 'optional_formats'
    >
  >,
): Promise<BatchRow> {
  const res = await need()
    .from('ad_hoc_diagnosis_batches')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  return unwrap<BatchRow>(res, 'updateBatch');
}

// ---------------------------------------------------------------------------
// subjects
// ---------------------------------------------------------------------------

export async function replaceSubjects(
  batchId: string,
  subjects: {
    subject_no: number;
    subject_fp: string | null;
    client_id: string;
    diagnostic_id: string;
    identity_status: SubjectIdentityStatus;
    identity_reason: string | null;
  }[],
): Promise<SubjectRow[]> {
  const d = need();
  // 再分類のときは作り直す (files が cascade で消えるので分類も同時に流し直す)
  const del = await d.from('ad_hoc_diagnosis_subjects').delete().eq('batch_id', batchId);
  if (del.error) throw new Error(`replaceSubjects(delete): ${del.error.message}`);
  if (subjects.length === 0) return [];
  const res = await d
    .from('ad_hoc_diagnosis_subjects')
    .insert(subjects.map((s) => ({ ...s, batch_id: batchId })))
    .select('*');
  if (res.error) throw new Error(`replaceSubjects(insert): ${res.error.message}`);
  return (res.data as SubjectRow[]) ?? [];
}

export async function listSubjects(batchId: string): Promise<SubjectRow[]> {
  const res = await need()
    .from('ad_hoc_diagnosis_subjects')
    .select('*')
    .eq('batch_id', batchId)
    .order('subject_no', { ascending: true });
  if (res.error) throw new Error(`listSubjects: ${res.error.message}`);
  return (res.data as SubjectRow[]) ?? [];
}

/** 再開時の照合 (§6.2.3)。**同じ fp が複数返り得る** ので配列で受ける。 */
export async function findSubjectsByFingerprint(
  batchId: string,
  fp: string,
): Promise<SubjectRow[]> {
  const res = await need()
    .from('ad_hoc_diagnosis_subjects')
    .select('*')
    .eq('batch_id', batchId)
    .eq('subject_fp', fp);
  if (res.error) throw new Error(`findSubjectsByFingerprint: ${res.error.message}`);
  return (res.data as SubjectRow[]) ?? [];
}

export async function updateSubject(
  id: string,
  patch: Partial<
    Pick<SubjectRow, 'identity_status' | 'identity_reason' | 'sex' | 'age' | 'status' | 'subject_fp' | 'subject_fp_source'>
  >,
): Promise<SubjectRow> {
  const res = await need()
    .from('ad_hoc_diagnosis_subjects')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  return unwrap<SubjectRow>(res, 'updateSubject');
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

export async function replaceFiles(
  batchId: string,
  files: {
    subject_id: string | null;
    storage_key: string;
    display_name: string;
    sha256: string;
    size_bytes: number;
    mime_type: string | null;
    source_kind: SourceKind;
    classified_format_id: FormatId | null;
    classification_confidence: Confidence;
    test_date: string | null;
    parse_status: ParseStatus;
    page_count: number | null;
    error_detail: string | null;
  }[],
): Promise<FileRow[]> {
  const d = need();
  const del = await d.from('ad_hoc_diagnosis_files').delete().eq('batch_id', batchId);
  if (del.error) throw new Error(`replaceFiles(delete): ${del.error.message}`);
  if (files.length === 0) return [];
  const res = await d
    .from('ad_hoc_diagnosis_files')
    .insert(files.map((f) => ({ ...f, batch_id: batchId })))
    .select('*');
  if (res.error) throw new Error(`replaceFiles(insert): ${res.error.message}`);
  return (res.data as FileRow[]) ?? [];
}

export async function listFiles(batchId: string): Promise<FileRow[]> {
  const res = await need()
    .from('ad_hoc_diagnosis_files')
    .select('*')
    .eq('batch_id', batchId)
    .order('display_name', { ascending: true });
  if (res.error) throw new Error(`listFiles: ${res.error.message}`);
  return (res.data as FileRow[]) ?? [];
}

export async function getFile(id: string): Promise<FileRow | null> {
  const res = await need().from('ad_hoc_diagnosis_files').select('*').eq('id', id).maybeSingle();
  if (res.error) throw new Error(`getFile: ${res.error.message}`);
  return (res.data as FileRow) ?? null;
}

export async function updateFile(
  id: string,
  patch: Partial<
    Pick<
      FileRow,
      | 'subject_id' | 'classified_format_id' | 'classification_confidence' | 'test_date'
      | 'parse_status' | 'page_count' | 'selected_as_primary' | 'duplicate_of_file_id' | 'error_detail'
    >
  >,
): Promise<FileRow> {
  const res = await need()
    .from('ad_hoc_diagnosis_files')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  return unwrap<FileRow>(res, 'updateFile');
}

// ---------------------------------------------------------------------------
// pages (Genoplan の多ページ PDF)
// ---------------------------------------------------------------------------

export async function upsertPage(input: {
  file_id: string;
  file_sha256: string;
  page_no: number;
  status: PageStatus;
  parsed?: unknown;
  raw?: string | null;
  error_detail?: string | null;
}): Promise<PageRow> {
  const d = need();
  const existing = await d
    .from('ad_hoc_diagnosis_pages')
    .select('*')
    .eq('file_id', input.file_id)
    .eq('page_no', input.page_no)
    .maybeSingle();
  if (existing.error) throw new Error(`upsertPage(select): ${existing.error.message}`);

  const prev = existing.data as PageRow | null;
  const attempts = (prev?.attempts ?? 0) + 1;
  const payload = {
    file_id: input.file_id,
    file_sha256: input.file_sha256,
    page_no: input.page_no,
    status: input.status,
    parsed: input.parsed ?? prev?.parsed ?? null,
    raw: input.raw ?? prev?.raw ?? null,
    attempts,
    error_detail: input.error_detail ?? null,
  };
  const res = prev
    ? await d.from('ad_hoc_diagnosis_pages').update(payload).eq('id', prev.id).select('*').single()
    : await d.from('ad_hoc_diagnosis_pages').insert(payload).select('*').single();
  return unwrap<PageRow>(res, 'upsertPage');
}

export async function listPages(fileId: string): Promise<PageRow[]> {
  const res = await need()
    .from('ad_hoc_diagnosis_pages')
    .select('*')
    .eq('file_id', fileId)
    .order('page_no', { ascending: true });
  if (res.error) throw new Error(`listPages: ${res.error.message}`);
  return (res.data as PageRow[]) ?? [];
}

/**
 * ページ単位のキャッシュ (§19.3)。**同じ PDF を再処理するとき Gemini を呼ばない。**
 * キーは `(file_sha256, page_no)` — file_id ではないので、**別バッチの同じ PDF にも効く**。
 */
export async function findCachedPage(fileSha256: string, pageNo: number): Promise<PageRow | null> {
  const res = await need()
    .from('ad_hoc_diagnosis_pages')
    .select('*')
    .eq('file_sha256', fileSha256)
    .eq('page_no', pageNo)
    .eq('status', 'done')
    .limit(1);
  if (res.error) throw new Error(`findCachedPage: ${res.error.message}`);
  const rows = (res.data as PageRow[]) ?? [];
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// outputs
// ---------------------------------------------------------------------------

export async function upsertOutput(input: {
  subject_id: string;
  format_id: FormatId;
  output_status: OutputStatus;
  json_storage_key?: string | null;
  validation_status?: ValidationStatus;
  item_count?: number | null;
  test_date?: string | null;
  generated_at?: string | null;
  error_detail?: string | null;
}): Promise<OutputRow> {
  const d = need();
  const existing = await d
    .from('ad_hoc_diagnosis_outputs')
    .select('*')
    .eq('subject_id', input.subject_id)
    .eq('format_id', input.format_id)
    .maybeSingle();
  if (existing.error) throw new Error(`upsertOutput(select): ${existing.error.message}`);
  const prev = existing.data as OutputRow | null;
  const payload = {
    subject_id: input.subject_id,
    format_id: input.format_id,
    output_status: input.output_status,
    json_storage_key: input.json_storage_key ?? null,
    validation_status: input.validation_status ?? 'pending',
    item_count: input.item_count ?? null,
    test_date: input.test_date ?? null,
    generated_at: input.generated_at ?? null,
    error_detail: input.error_detail ?? null,
  };
  const res = prev
    ? await d.from('ad_hoc_diagnosis_outputs').update(payload).eq('id', prev.id).select('*').single()
    : await d.from('ad_hoc_diagnosis_outputs').insert(payload).select('*').single();
  return unwrap<OutputRow>(res, 'upsertOutput');
}

export async function listOutputs(subjectIds: readonly string[]): Promise<OutputRow[]> {
  if (subjectIds.length === 0) return [];
  const res = await need()
    .from('ad_hoc_diagnosis_outputs')
    .select('*')
    .in('subject_id', subjectIds as string[]);
  if (res.error) throw new Error(`listOutputs: ${res.error.message}`);
  return (res.data as OutputRow[]) ?? [];
}

// ---------------------------------------------------------------------------
// events (監査ログ・append only)
// ---------------------------------------------------------------------------

/**
 * 監査ログを積む。
 *
 * **操作者識別の正は `actor_user_id`** (§21)。wellfort-site が `/auth/v1/user` で
 * 検証した user.id を**中継のサーバ側で注入**したものだけを受ける。
 * **自動処理は actor 3 列とも null のまま積む** (架空の操作者を作らない)。
 *
 * **detail に値そのものを入れない。** 種類と件数だけ (§21)。
 */
export async function logEvent(input: {
  batch_id: string;
  event: EventName;
  subject_id?: string | null;
  file_id?: string | null;
  actor_user_id?: string | null;
  actor_masked?: string | null;
  actor_sha256?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const d = db();
  if (!d) return; // 監査が書けないことで本処理を止めない
  const res = await d.from('ad_hoc_diagnosis_events').insert({
    batch_id: input.batch_id,
    event: input.event,
    subject_id: input.subject_id ?? null,
    file_id: input.file_id ?? null,
    actor_user_id: input.actor_user_id ?? null,
    actor_masked: input.actor_masked ?? null,
    actor_sha256: input.actor_sha256 ?? null,
    detail: input.detail ?? {},
  });
  if (res.error) {
    // 監査の失敗は本処理を落とさない (握りつぶさずログには出す)
    console.warn('[ad-hoc] logEvent failed:', res.error.message);
  }
}

export async function listEvents(batchId: string, limit = 200): Promise<
  { id: number; event: string; subject_id: string | null; file_id: string | null;
    actor_user_id: string | null; actor_masked: string | null; detail: unknown; created_at: string }[]
> {
  const res = await need()
    .from('ad_hoc_diagnosis_events')
    .select('*')
    .eq('batch_id', batchId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (res.error) throw new Error(`listEvents: ${res.error.message}`);
  return (res.data as never) ?? [];
}

export { StoreUnavailable };
export type { RejectReason };
