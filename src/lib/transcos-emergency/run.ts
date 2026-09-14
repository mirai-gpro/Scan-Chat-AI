// src/lib/transcos-emergency/run.ts
// トランスコスモス10名 緊急専用 v2.0 — **run の入口** (指示書 §8 / §14 / §15 / §21)。
//
// 【durable state】(§14)
// 途中で切れても最初からやり直さない。preflight の 1 エントリぶんの観測は
// **既存の events テーブルに `parsed` として積む** (DB migration を足さない)。
// run の識別は `detail.run_kind = transcos_emergency_v2`。
//
// 【ZIP を上げ直させない】(§21)
// 同じ SHA-256 の ZIP が既存の臨時診断アップロードに在れば、その S3 オブジェクトを
// **immutable source として参照する**。候補が複数あっても中身は同一なので、
// どれを選んだかを監査へ残したうえで最新の使えるものを使う。

import * as store from '../ad-hoc-diagnosis/store';
import { openArchiveFromS3 } from '../ad-hoc-diagnosis/archive';
import { getS3Config, type S3Config } from '../s3';
import {
  TRANSCOS_ZIP, TRANSCOS_MANIFEST, TRANSCOS_SUBJECTS, TRANSCOS_RUN_KIND,
  manifestEntry, subjectByNo,
} from './manifest';
import {
  preflightStructure, preflightFinish, probeEntry,
  type EntryProbe, type PreflightReport, type ExecutiveCount,
} from './preflight';
import { nodeProbes, goldenChecks } from './probes';
import { createRun, seedRun } from './seed';
import { crossCheckHealth, type CrossCheckResult } from './crosscheck';
import { restoreHealthCheckupSheet } from '../ad-hoc-diagnosis/normalized-payload';
import { GENOPLAN_V1_REQUIRED_PAGES } from '../elith-genetic';

/**
 * Genoplan の対象ページ。**production の正本をそのまま使う** (§13)。
 * ここに `10` / `35` をベタ書きしない — 2 か所に数字を持つと片方だけ直って黙ってずれる。
 */
export const GENETIC_PAGES: readonly number[] = GENOPLAN_V1_REQUIRED_PAGES;

const PREFLIGHT_DETAIL = 'transcos_preflight_entry';

export interface Actor { userId: string | null; masked: string | null; sha256?: string | null }

function cfgOrNull(): S3Config | null {
  return getS3Config();
}

/**
 * この run が本当に専用 run か。**汎用バッチを専用 API で操作させない。**
 * 判定は 2 点 — `source_sha256` が実 ZIP のもの、かつ `title` が run kind。
 */
export function isTranscosRun(batch: store.BatchRow): boolean {
  return batch.source_sha256 === TRANSCOS_ZIP.sha256 && batch.title === TRANSCOS_RUN_KIND;
}

/** 既存の run を探す。無ければ null。 */
export async function findRun(): Promise<store.BatchRow | null> {
  const rows = await store.listBatches(100);
  return rows.find(isTranscosRun) ?? null;
}

/**
 * 実 ZIP が置かれている S3 オブジェクトを探す (§21)。
 * **SHA-256 の完全一致だけ**で選ぶ。ファイル名・日付では選ばない。
 */
export async function findSourceKey(): Promise<{ key: string; from: string; candidates: number } | null> {
  const rows = await store.findBatchesBySha(TRANSCOS_ZIP.sha256);
  const usable = rows.filter((b) => typeof b.source_key === 'string' && b.source_key !== '');
  if (usable.length === 0) return null;
  // 中身は同一なので最新を使う。**どれを選んだかは監査に残す** (§21)。
  const pick = usable[0];
  return { key: pick.source_key, from: pick.id, candidates: usable.length };
}

export interface StartResult {
  runId: string;
  sourceKey: string;
  /** 読むべき manifest entry (構造が壊れていれば空)。 */
  plan: number[];
  structureChecks: PreflightReport['checks'];
  /** 既に観測済みの entry (再開したときはここが埋まっている)。 */
  done: number[];
}

/**
 * Preflight を始める。**Central Directory しか読まない** (中身はまだ 1 バイトも読まない)。
 *
 * `zipSha256` はブラウザが原本を読んで出した値。**サーバはこれを信じ切らない** —
 * 中身の証明は 38 エントリの SHA 一致 (検査5) が行う。
 */
export async function startPreflight(input: {
  zipSha256: string | null;
  actor: Actor;
}): Promise<{ ok: true; result: StartResult } | { ok: false; status: number; error: string; detail?: string }> {
  const cfg = cfgOrNull();
  if (!cfg) return { ok: false, status: 503, error: 's3_not_configured' };

  const src = await findSourceKey();
  if (!src) {
    return {
      ok: false, status: 404, error: 'source_zip_not_found',
      detail: '受領済みの ZIP が見つかりません。',
    };
  }

  let batch = await findRun();
  if (!batch) {
    batch = await createRun({ sourceKey: src.key, actor: input.actor });
    await store.logEvent({
      batch_id: batch.id, event: 'created',
      actor_user_id: input.actor.userId, actor_masked: input.actor.masked,
      detail: {
        run_kind: TRANSCOS_RUN_KIND, source_from_batch: src.from,
        source_candidates: src.candidates, zip_sha256: TRANSCOS_ZIP.sha256,
      },
    });
  }

  const archive = await openArchiveFromS3({ key: batch.source_key, cfg });
  let structure;
  try {
    structure = preflightStructure({
      zipBytes: batch.source_size ?? batch.declared_source_size,
      zipSha256: input.zipSha256,
      rawEntries: archive.listing.entries.map((e) => ({
        path: e.path,
        directory: e.rejected === 'directory',
        declaredSize: e.declaredSize,
        encrypted: e.rejected === 'password_protected_file',
      })),
    });
  } finally {
    await archive.close().catch(() => {});
  }

  const done = (await loadProbes(batch.id)).map((p) => p.entry);
  return {
    ok: true,
    result: {
      runId: batch.id,
      sourceKey: batch.source_key,
      plan: structure.plan.map((m) => m.entry),
      structureChecks: structure.checks,
      done,
    },
  };
}

/** 観測済みの entry を events から復元する。 */
export async function loadProbes(batchId: string): Promise<EntryProbe[]> {
  const events = await store.listEvents(batchId, 500);
  const out = new Map<number, EntryProbe>();
  for (const e of events) {
    const d = e.detail as { kind?: string; probe?: EntryProbe } | null;
    if (!d || d.kind !== PREFLIGHT_DETAIL || !d.probe) continue;
    // 新しい順に来るので、**最初に見たものを採る** (再観測があれば新しい方)。
    if (!out.has(d.probe.entry)) out.set(d.probe.entry, d.probe);
  }
  return [...out.values()].sort((a, b) => a.entry - b.entry);
}

/** 1 エントリだけ読んで観測する。**これがチャンク実行の単位。** */
export async function preflightEntry(input: {
  runId: string;
  entry: number;
  actor: Actor;
}): Promise<{ ok: true; probe: EntryProbe } | { ok: false; status: number; error: string; detail?: string }> {
  const cfg = cfgOrNull();
  if (!cfg) return { ok: false, status: 503, error: 's3_not_configured' };
  const batch = await store.getBatch(input.runId);
  if (!batch) return { ok: false, status: 404, error: 'run_not_found' };
  if (!isTranscosRun(batch)) return { ok: false, status: 409, error: 'not_transcos_run' };
  if (!manifestEntry(input.entry)) return { ok: false, status: 400, error: 'entry_not_in_manifest' };

  const archive = await openArchiveFromS3({ key: batch.source_key, cfg });
  let probe: EntryProbe;
  try {
    probe = await probeEntry(input.entry, (i) => archive.readByIndex(i), nodeProbes);
  } finally {
    await archive.close().catch(() => {});
  }
  await store.logEvent({
    batch_id: batch.id, event: 'parsed',
    actor_user_id: input.actor.userId, actor_masked: input.actor.masked,
    // **path も本文も残さない。** 残すのは同一性の観測だけ (§22)。
    detail: { kind: PREFLIGHT_DETAIL, probe },
  });
  return { ok: true, probe };
}

/**
 * Preflight を締める。PASS したときだけ **run を manifest から起こす** (seed)。
 *
 * `executives` は wellfort-site が**自分の人物マスタ**で exact 一致を数えた結果。
 * **氏名は診断側へ渡さない** — 来るのは人物番号・件数・UUID だけ (§22)。
 */
export async function finishPreflight(input: {
  runId: string;
  zipSha256: string | null;
  executives: readonly { subjectNo: number; candidates: number; executiveSubjectId: string | null }[];
  actor: Actor;
}): Promise<
  | { ok: true; report: PreflightReport; seeded: Awaited<ReturnType<typeof seedRun>> | null }
  | { ok: false; status: number; error: string; detail?: string }
> {
  const cfg = cfgOrNull();
  if (!cfg) return { ok: false, status: 503, error: 's3_not_configured' };
  const batch = await store.getBatch(input.runId);
  if (!batch) return { ok: false, status: 404, error: 'run_not_found' };
  if (!isTranscosRun(batch)) return { ok: false, status: 409, error: 'not_transcos_run' };

  const archive = await openArchiveFromS3({ key: batch.source_key, cfg });
  try {
    const structure = preflightStructure({
      zipBytes: batch.source_size ?? batch.declared_source_size,
      zipSha256: input.zipSha256,
      rawEntries: archive.listing.entries.map((e) => ({
        path: e.path,
        directory: e.rejected === 'directory',
        declaredSize: e.declaredSize,
        encrypted: e.rejected === 'password_protected_file',
      })),
    });
    const probes = await loadProbes(batch.id);
    const execCounts: ExecutiveCount[] = TRANSCOS_SUBJECTS.map((s) => ({
      subjectNo: s.subjectNo,
      candidates: input.executives.find((e) => e.subjectNo === s.subjectNo)?.candidates ?? 0,
    }));
    const report = preflightFinish(structure, probes, execCounts, goldenChecks);
    if (!report.ok) {
      // **FAIL なら seed しない。LLM も呼ばない。S3 へも書かない。**
      return { ok: true, report, seeded: null };
    }

    const seeded = await seedRun({ batchId: batch.id, archive, cfg, actor: input.actor });

    // Executive の紐付け (**UUID だけ**)。exact 1 件のものだけを結ぶ。
    const subjects = await store.listSubjects(batch.id);
    for (const e of input.executives) {
      if (e.candidates !== 1 || !e.executiveSubjectId) continue;
      const s = subjects.find((x) => x.subject_no === e.subjectNo);
      if (s && s.executive_subject_id !== e.executiveSubjectId) {
        await store.updateSubject(s.id, { executive_subject_id: e.executiveSubjectId });
      }
    }
    await store.updateBatch(batch.id, { status: 'classified' });
    return { ok: true, report, seeded };
  } finally {
    await archive.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 進捗 (§9 の 4 状態)
// ---------------------------------------------------------------------------

export type SubjectState = '準備完了' | '処理中' | '要確認' | '完了';

export interface SubjectStatus {
  subjectNo: number;
  displayName: string;
  state: SubjectState;
  /** 画面に出す 1 行 (技術詳細は details 側へ)。 */
  note: string;
  linked: boolean;
  health: { pagesDone: number; pagesExpected: number };
  genetic: { pagesDone: number; pagesExpected: number };
  questionnaire: 'xlsx' | 'pdf_manual';
  questionnaireReady: boolean;
  outputs: { formatId: string; status: string; testDate: string | null }[];
  delivered: number;
  crossCheck: { mismatches: number; matched: number } | null;
  /** 技術詳細 (`<details>` にだけ出す)。 */
  detail: string[];
}

export interface RunStatus {
  runId: string | null;
  status: string | null;
  subjects: SubjectStatus[];
  done: number;
  total: number;
}

export async function runStatus(runId: string): Promise<RunStatus | null> {
  const batch = await store.getBatch(runId);
  if (!batch || !isTranscosRun(batch)) return null;
  const subjects = await store.listSubjects(runId);
  const files = await store.listFiles(runId);
  const outputs = await store.listOutputs(subjects.map((s) => s.id));

  const out: SubjectStatus[] = [];
  for (const m of TRANSCOS_SUBJECTS) {
    const s = subjects.find((x) => x.subject_no === m.subjectNo);
    const own = s ? files.filter((f) => f.subject_id === s.id) : [];
    const hcFile = own.find((f) => f.classified_format_id === 'HealthCheckupData');
    const gFile = own.find((f) => f.classified_format_id === 'GeneticTestResultData');
    const qFile = own.find((f) => f.classified_format_id === 'LifestyleQuestionnaireData');
    const hcPages = hcFile ? (await store.listPages(hcFile.id)).filter((p) => p.status === 'done').length : 0;
    const gPages = gFile ? (await store.listPages(gFile.id)).filter((p) => p.status === 'done').length : 0;
    const geneticNeeded = GENETIC_PAGES.length;
    const outs = s ? outputs.filter((o) => o.subject_id === s.id) : [];
    const delivered = outs.filter((o) => o.output_status === 'exported').length;

    const qIsPdf = manifestEntry(m.questionnaire)?.role === 'QUESTIONNAIRE_PDF_MANUAL';
    const qReady = qFile ? qFile.parse_status === 'done' && qFile.test_date != null : false;

    const detail: string[] = [];
    let state: SubjectState = '準備完了';
    let note = '';

    if (delivered >= 3) {
      state = '完了';
    } else if (!s || !s.executive_subject_id) {
      state = '要確認';
      note = '対象人物が人物マスタに見つかりません。';
      detail.push('executive_not_linked');
    } else if (qIsPdf && !qReady) {
      state = '要確認';
      note = '問診PDF入力';
      detail.push('questionnaire_manual_pending');
    } else if (qFile?.error_detail) {
      state = '要確認';
      note = '問診の内容を確認してください。';
      detail.push(`questionnaire:${qFile.error_detail}`);
    } else if (hcPages > 0 || gPages > 0) {
      state = hcPages >= (hcFile?.page_count ?? 1) && gPages >= geneticNeeded ? '準備完了' : '処理中';
      if (state === '処理中') {
        note = gPages < geneticNeeded ? `Genoplan ${gPages}/${geneticNeeded}` : `健診 ${hcPages}/${hcFile?.page_count ?? 1}`;
      }
    }
    const failed = outs.filter((o) => o.output_status === 'failed');
    if (state !== '完了' && failed.length > 0) {
      state = '要確認';
      note = note || '解析の結果を確認してください。';
      for (const f of failed) detail.push(`${f.format_id}:${f.error_detail ?? 'failed'}`);
    }

    out.push({
      subjectNo: m.subjectNo,
      displayName: m.displayName,
      state,
      note,
      linked: Boolean(s?.executive_subject_id),
      health: { pagesDone: hcPages, pagesExpected: hcFile?.page_count ?? 1 },
      genetic: { pagesDone: gPages, pagesExpected: geneticNeeded },
      questionnaire: qIsPdf ? 'pdf_manual' : 'xlsx',
      questionnaireReady: qReady,
      outputs: outs.map((o) => ({ formatId: o.format_id, status: o.output_status, testDate: o.test_date })),
      delivered,
      crossCheck: null,
      detail,
    });
  }

  return {
    runId,
    status: batch.status,
    subjects: out,
    done: out.filter((x) => x.state === '完了').length,
    total: out.length,
  };
}

/**
 * 健診 PDF と補助 XLSX の決定論照合 (§10)。
 * **値を作らない。** 不一致が 1 件でもあればその人物を要確認にする。
 */
export async function crossCheckSubject(input: {
  runId: string;
  subjectNo: number;
  measurements: readonly Record<string, unknown>[];
  pdfTestDate: string | null;
}): Promise<CrossCheckResult | null> {
  const m = subjectByNo(input.subjectNo);
  if (!m || m.healthSupport == null) return null;
  const files = await store.listFiles(input.runId);
  const support = files.find((f) => f.archive_entry_index === m.healthSupport! - 1);
  if (!support) return null;
  const sheet = restoreHealthCheckupSheet(support.normalized_payload);
  return crossCheckHealth({
    measurements: input.measurements,
    support: sheet,
    pdfTestDate: input.pdfTestDate,
  });
}

/** 画面に配る「読むべきページ」。**UI が 10 / 35 を自分で持たない** (§13)。 */
export function pagePlan(): {
  health: { entry: number; subjectNo: number; pages: number }[];
  genetic: { entry: number; subjectNo: number; pages: number[] }[];
} {
  return {
    health: TRANSCOS_SUBJECTS.map((s) => ({
      entry: s.health, subjectNo: s.subjectNo,
      pages: manifestEntry(s.health)?.pages ?? 1,
    })),
    genetic: TRANSCOS_SUBJECTS.map((s) => ({
      entry: s.genoplan, subjectNo: s.subjectNo,
      pages: [...GENETIC_PAGES],
    })),
  };
}


