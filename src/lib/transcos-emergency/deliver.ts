// src/lib/transcos-emergency/deliver.ts
// トランスコスモス10名 緊急専用 v2.0 — **人物ごとの納品ゲートと create-only 書き込み** (§16 / §17)。
//
// 【通常納品の規則を変えない】
// 汎用バッチは「1 人でも未完成なら部分納品しない」で、それは**そのまま**。
// 今回は **人物単位で独立**させるのが要件 (§15) なので、
// `assembleBatch()` に例外分岐を足すのではなく**経路を分ける**
// (E2E の 1 件書き出しを別関数にしたときと同じ考え方)。
//
// 【安全側の検査は 1 つも外さない】
//   env 2 本の一致 (`checkWriteTarget`) / key の形 (`validateDeliveryKey`) /
//   HeadObject で既存確認 / `IfNoneMatch:'*'` の create-only / PUT 後の readback。
//   **overwrite しない・delete して再実行しない・key を変えて逃げない** (§16 / §26)。
//
// 【JSON を作り直さない】
// 納品する本文は**既存 `buildSubjectDelivery()` が組んだものそのまま**。
// 専用の Health / Questionnaire / Genetic builder は作らない (§10 / §11 / §13 / §19)。

import * as store from '../ad-hoc-diagnosis/store';
import { buildSubjectDelivery } from '../ad-hoc-diagnosis/service';
import {
  checkWriteTarget, validateDeliveryKey, headDeliveryObject, putDeliveryFilesCreateOnly,
} from '../ad-hoc-diagnosis/write-guard';
import type { DeliveryFile } from '../ad-hoc-diagnosis/pipeline';
import { TRANSCOS_RUN_KIND, TRANSCOS_SUBJECTS } from './manifest';

/** 今回納品する 3 形式。**これ以外は書かない** (§11 の「今回やらないこと」)。 */
export const TRANSCOS_DELIVERY_FORMATS = [
  'HealthCheckupData',
  'LifestyleQuestionnaireData',
  'GeneticTestResultData',
] as const;

export interface SubjectGate {
  subjectNo: number;
  subjectId: string;
  clientId: string;
  ok: boolean;
  /** 満たしていない条件 (§16 の 1〜9)。**1 つでも残っていれば書かない。** */
  blockers: string[];
  files: DeliveryFile[];
}

/**
 * §16 の 9 条件。**通らなければその人物は書かない** (他の人物は続ける)。
 * ここで値を作らない・日付を埋めない。判定だけ。
 */
export async function gateSubject(
  subject: store.SubjectRow,
  files: readonly store.FileRow[],
  cfg: { prefix: string },
): Promise<SubjectGate> {
  const blockers: string[] = [];
  // 1. Executive の exact link
  if (!subject.executive_subject_id) blockers.push('executive_not_linked');
  // 2. client_id
  if (!subject.client_id) blockers.push('client_id_missing');

  const own = files.filter((f) => f.subject_id === subject.id);
  const build = await buildSubjectDelivery(subject, own, cfg);

  // 3〜5. 3 形式がそれぞれ**ちょうど 1 件**
  for (const fmt of TRANSCOS_DELIVERY_FORMATS) {
    const n = build.built.filter((b) => b.formatId === fmt).length;
    if (n !== 1) blockers.push(`${fmt}_count_${n}`);
  }
  // それ以外の形式は今回書かない (HealthAgeData 等が混ざっても落とす)
  const extra = build.built.filter((b) => !(TRANSCOS_DELIVERY_FORMATS as readonly string[]).includes(b.formatId));
  const deliver = build.built.filter((b) => (TRANSCOS_DELIVERY_FORMATS as readonly string[]).includes(b.formatId));

  for (const f of deliver) {
    // 6. test_date が source 由来で確定している
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.testDate ?? '')) {
      blockers.push(`${f.formatId}_test_date_unresolved`);
      continue;
    }
    // 7〜8. JSON 本文の format_id / client_id / test_date が一致
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(f.body) as Record<string, unknown>;
    } catch {
      blockers.push(`${f.formatId}_body_not_json`);
      continue;
    }
    if (parsed.format_id !== f.formatId) blockers.push(`${f.formatId}_body_format_mismatch`);
    if (parsed.client_id !== subject.client_id) blockers.push(`${f.formatId}_body_client_mismatch`);
    if (parsed.test_date !== f.testDate) blockers.push(`${f.formatId}_body_date_mismatch`);
  }

  return {
    subjectNo: subject.subject_no,
    subjectId: subject.id,
    clientId: subject.client_id,
    // **余分な形式が混ざっていたら書かない** (今回書くのは 3 つだけ)。
    ok: blockers.length === 0 && extra.length === 0 && deliver.length === 3,
    blockers: extra.length > 0 ? [...blockers, `unexpected_format:${extra.map((e) => e.formatId).join(',')}`] : blockers,
    files: deliver,
  };
}

export interface DeliveredFile {
  formatId: string;
  key: string;
  bytes: number;
  etag: string | null;
  testDate: string;
  /** `created` = 今回作った / `already` = 既に同じ中身が在った / `blocked` = 中身が違う。 */
  outcome: 'created' | 'already' | 'blocked';
  readback: boolean;
  detail?: string;
  /** 実際に PUT した (または既に在った) 本文。**保存・表示できるように返す** (§17)。 */
  body: string;
}

export type DeliverSubjectResult =
  | { ok: true; subjectNo: number; clientId: string; files: DeliveredFile[] }
  | { ok: false; status: number; error: string; detail: string; subjectNo: number; blockers?: string[] };

/**
 * 1 人ぶんの 3 JSON を書く。**全 key を先に Head してから PUT を始める** (§16)。
 *
 * 途中で通信が切れても、既に作られた object は**消さない**。
 * 次に呼んだときは `already` として readback 一致を確かめ、残りだけ create する。
 */
export async function deliverSubject(input: {
  batchId: string;
  subject: store.SubjectRow;
  files: readonly store.FileRow[];
  actor: { userId: string | null; masked: string | null };
}): Promise<DeliverSubjectResult> {
  const t = checkWriteTarget();
  if (!t.ok) {
    return { ok: false, status: t.status, error: t.error, detail: t.detail, subjectNo: input.subject.subject_no };
  }
  const cfg = t.cfg;

  const gate = await gateSubject(input.subject, input.files, cfg);
  if (!gate.ok) {
    return {
      ok: false, status: 409, error: 'subject_not_ready',
      detail: '納品の条件を満たしていません。', subjectNo: gate.subjectNo, blockers: gate.blockers,
    };
  }

  // 9. key が production の規則どおりか
  for (const f of gate.files) {
    const v = validateDeliveryKey(f, cfg);
    if (!v.ok) {
      return {
        ok: false, status: 400, error: 'invalid_delivery_key',
        detail: `納品先 key が想定外です (${v.reason})。`, subjectNo: gate.subjectNo,
      };
    }
  }

  // ── ① 全 key を先に Head する ────────────────────────────────────────────
  const heads = new Map<string, { exists: boolean; bytes: number | null; etag: string | null }>();
  for (const f of gate.files) {
    try {
      heads.set(f.key, await headDeliveryObject(f.key, cfg));
    } catch (e) {
      // **「確認できなかった」を「無い」にしない。** ここで止める。
      return {
        ok: false, status: 502, error: 'head_failed',
        detail: `既存の確認に失敗したため書き込みを中止しました (${String(e).slice(0, 120)})。`,
        subjectNo: gate.subjectNo,
      };
    }
  }

  const out: DeliveredFile[] = [];
  const toCreate = gate.files.filter((f) => !heads.get(f.key)?.exists);
  const existing = gate.files.filter((f) => heads.get(f.key)?.exists);

  /*
   * 既存があるものは**触らない**。中身が今回の本文と同じバイト数かだけ確かめ、
   * 違えば `blocked` にしてその人物を止める (**上書きも削除もしない**)。
   */
  for (const f of existing) {
    const h = heads.get(f.key)!;
    const same = h.bytes === f.bytes;
    out.push({
      formatId: f.formatId, key: f.key, bytes: f.bytes, etag: h.etag, testDate: f.testDate,
      outcome: same ? 'already' : 'blocked',
      readback: same,
      detail: same ? '既に同じ納品データが在ります (上書きしていません)' : '既存の中身が今回と違います (上書きしていません)',
      body: f.body,
    });
  }
  if (out.some((o) => o.outcome === 'blocked')) {
    await store.logEvent({
      batch_id: input.batchId, subject_id: gate.subjectId, event: 'override',
      detail: { kind: TRANSCOS_RUN_KIND, action: 'delivery_blocked_existing', subject_no: gate.subjectNo },
    });
    return {
      ok: false, status: 409, error: 'destination_exists_different',
      detail: '同じ納品データが既に存在し、中身が今回と違います。上書きしていません。',
      subjectNo: gate.subjectNo,
    };
  }

  // ── ② create-only PUT ───────────────────────────────────────────────────
  if (toCreate.length > 0) {
    try {
      await putDeliveryFilesCreateOnly(
        toCreate.map((f) => ({ key: f.key, body: f.body, bytes: f.bytes })),
        cfg,
      );
    } catch (e) {
      return {
        ok: false, status: 502, error: 'put_failed',
        detail: `書き込みに失敗しました (${String(e).slice(0, 120)})。既に作られた分は消していません。`,
        subjectNo: gate.subjectNo,
      };
    }
  }

  // ── ③ readback ──────────────────────────────────────────────────────────
  for (const f of toCreate) {
    let h: { exists: boolean; bytes: number | null; etag: string | null };
    try {
      h = await headDeliveryObject(f.key, cfg);
    } catch (e) {
      out.push({
        formatId: f.formatId, key: f.key, bytes: f.bytes, etag: null, testDate: f.testDate,
        outcome: 'created', readback: false,
        detail: `書き込み後の確認に失敗 (${String(e).slice(0, 80)})`, body: f.body,
      });
      continue;
    }
    out.push({
      formatId: f.formatId, key: f.key, bytes: f.bytes, etag: h.etag, testDate: f.testDate,
      outcome: 'created',
      readback: h.exists && h.bytes === f.bytes,
      detail: h.exists ? '' : '書き込み後に見つかりません',
      body: f.body,
    });
  }

  for (const f of gate.files) {
    await store.upsertOutput({
      subject_id: gate.subjectId,
      format_id: f.formatId as never,
      output_status: 'exported',
      validation_status: 'ok',
      test_date: f.testDate,
      json_storage_key: f.key,
    });
  }
  await store.logEvent({
    batch_id: input.batchId, subject_id: gate.subjectId, event: 'exported',
    detail: {
      kind: TRANSCOS_RUN_KIND, subject_no: gate.subjectNo,
      created: out.filter((o) => o.outcome === 'created').length,
      already: out.filter((o) => o.outcome === 'already').length,
    },
  });

  return { ok: true, subjectNo: gate.subjectNo, clientId: gate.clientId, files: out };
}

/** 人物番号 → manifest の表示名 (画面に出すのは Wellfort 側だけ・§22)。 */
export function subjectLabel(subjectNo: number): string {
  return TRANSCOS_SUBJECTS.find((s) => s.subjectNo === subjectNo)?.displayName ?? `人物 ${subjectNo}`;
}
