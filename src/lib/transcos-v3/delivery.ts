// src/lib/transcos-v3/delivery.ts
// トランスコスモス10名 v3.0 — 人物単位の納品ゲート (§17) と S3 の同一性判定 (§18)。
//
// **ここは判定だけ。S3 を呼ぶのは `deliver.ts` 側** (`preflight.ts` / `health-validate.ts` と同じ)。
//
// 【この層で守ること】
// ① **1 人が BLOCK しても他 9 人は納品できる** (§17 末尾)。人物ごとに独立して判定する。
// ② **ETag を同一性の根拠にしない** (§18.4 / Appendix F-12)。
//    ETag はマルチパートや SSE-KMS で中身の SHA-256 と一致しない。
//    同一性は **GetObject した本文の SHA-256** だけで決める。
// ③ **Head だけで成功扱いしない** (§18.3)。「在る」と「中身が合っている」は別。
// ④ **上書き・削除・key 変更をしない** (§18.1 / Appendix F-14)。
//    既存が在って中身が違うなら、その人物を止める。直しに行かない。

import { createHash } from 'node:crypto';

/** 今回 S3 へ出す format はこの 3 つだけ (§15)。 */
export const V3_DELIVERY_FORMATS = [
  'HealthCheckupData',
  'LifestyleQuestionnaireData',
  'GeneticTestResultData',
] as const;
export type V3Format = (typeof V3_DELIVERY_FORMATS)[number];

/**
 * v3 専用の env 2 本 (§18.2)。**既存 ad-hoc の 2 本と共用しない** —
 * 既存 ad-hoc を ON にしていても v3 は ON にならず、逆も同じ。
 */
export const V3_WRITE_ENV = {
  enabled: 'TRANSCOS_V3_ELITH_WRITE_ENABLED',
  target: 'TRANSCOS_V3_ELITH_WRITE_TARGET',
} as const;

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// §16 Format validation
// ---------------------------------------------------------------------------

export interface FormatExpectation {
  clientId: string;
  formatId: V3Format;
  /** source 由来の検査日。**`today` 由来はここへ来る前に捨てる。** */
  testDate: string;
  /** production の `schema_version`。 */
  schemaVersion: string;
}

export interface FormatCheck { ok: boolean; reasons: string[] }

/**
 * §16 の共通契約。**body そのものを見る** (key の形は `validateDeliveryKey()` の担当)。
 * `bodyBytes` は実際に PUT する / した本文。**zero-byte は不可。**
 */
export function validateFormatBody(
  bodyBytes: Uint8Array,
  expect: FormatExpectation,
  keyMeta: { clientId: string; testDate: string; formatId: string } | null,
): FormatCheck {
  const reasons: string[] = [];
  if (bodyBytes.length === 0) {
    return { ok: false, reasons: ['本文が 0 バイト'] };
  }
  let json: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bodyBytes).toString('utf8'));
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reasons: ['JSON の最上位が object でない'] };
    }
    json = parsed as Record<string, unknown>;
  } catch (err) {
    return { ok: false, reasons: [`JSON として読めない: ${err instanceof Error ? err.message : String(err)}`] };
  }

  const str = (k: string) => (typeof json[k] === 'string' ? (json[k] as string) : null);
  if (str('client_id') !== expect.clientId) reasons.push(`body の client_id が違う (${str('client_id') ?? '—'})`);
  if (str('format_id') !== expect.formatId) reasons.push(`body の format_id が違う (${str('format_id') ?? '—'})`);
  if (str('test_date') !== expect.testDate) reasons.push(`body の test_date が違う (${str('test_date') ?? '—'})`);
  if (str('schema_version') !== expect.schemaVersion) {
    reasons.push(`schema_version が production 値でない (${str('schema_version') ?? '—'})`);
  }

  // key と body の食い違い (§16「S3 key 内 client/date/format と body 一致」)
  if (keyMeta) {
    if (keyMeta.clientId !== expect.clientId) reasons.push('key の client_id が違う');
    if (keyMeta.formatId !== expect.formatId) reasons.push('key の format_id が違う');
    if (keyMeta.testDate !== expect.testDate) reasons.push('key の test_date が違う');
  } else {
    reasons.push('key を解析できていない');
  }
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// §17 人物単位ゲート
// ---------------------------------------------------------------------------

export interface SubjectGateInput {
  subject: string;
  /** manifest に人物が居るか (§17-1)。 */
  manifestResolved: boolean;
  /** Executive の exact 1 件リンクが済んでいるか (§17-2)。 */
  executiveLinked: boolean;
  /** 不変 client_id (§17-3)。未確定は null。 */
  clientId: string | null;
  healthPass: boolean;
  questionnairePass: boolean;
  geneticPass: boolean;
  /** この人物ぶんの build 済み成果物。**3 形式がちょうど 1 件ずつ**であること (§17-7)。 */
  built: readonly { formatId: string; testDate: string | null; bodyOk: boolean }[];
  /** 人の確認待ちが残っているか (§17-10)。 */
  humanPending: number;
  /** source / Golden の照合 (§17-11)。 */
  sourceValidationPass: boolean;
}

export interface SubjectGateResult {
  subject: string;
  ok: boolean;
  reasons: string[];
}

/**
 * §17。**1 人が BLOCK しても他 9 人には影響しない** ので、ここは 1 人ぶんだけを見る。
 *
 * `HealthAgeData` のような production 側の派生 format は
 * **在るだけでは 3 形式を BLOCK しない** (§15)。数にも含めない。
 * **未知の format が混じったときだけ** BLOCK する。
 */
export function checkSubjectGate(input: SubjectGateInput): SubjectGateResult {
  const reasons: string[] = [];
  if (!input.manifestResolved) reasons.push('manifest に人物が確定していない');
  if (!input.executiveLinked) reasons.push('Executive の exact リンクが未確定');
  if (!input.clientId) reasons.push('client_id が未確定');
  if (!input.healthPass) reasons.push('Health が PASS していない');
  if (!input.questionnairePass) reasons.push('Questionnaire が PASS していない');
  if (!input.geneticPass) reasons.push('Genetic が PASS していない');
  if (input.humanPending > 0) reasons.push(`人の確認待ちが ${input.humanPending} 件`);
  if (!input.sourceValidationPass) reasons.push('source / Golden の照合が PASS していない');

  // §15: 3 形式ちょうど 1 件ずつ。派生 format は無視、未知の format だけ BLOCK。
  const known = new Set<string>([...V3_DELIVERY_FORMATS, ...PRODUCTION_DERIVED_FORMATS]);
  for (const b of input.built) {
    if (!known.has(b.formatId)) reasons.push(`未知の format が混じっている (${b.formatId})`);
  }
  for (const f of V3_DELIVERY_FORMATS) {
    const hit = input.built.filter((b) => b.formatId === f);
    if (hit.length !== 1) {
      reasons.push(`${f} が ${hit.length} 件 (ちょうど 1 件でなければ納品しない)`);
      continue;
    }
    if (!hit[0].testDate) reasons.push(`${f} の test_date が未確定`);
    if (!hit[0].bodyOk) reasons.push(`${f} の body が §16 を満たしていない`);
  }
  return { subject: input.subject, ok: reasons.length === 0, reasons };
}

/**
 * production 側が作る派生 format。**今回の納品対象ではないが、在っても BLOCK しない** (§15)。
 * v2 ではここを「未知」と数えて **10 名全員が止まった**。
 */
export const PRODUCTION_DERIVED_FORMATS: readonly string[] = ['HealthAgeData'];

// ---------------------------------------------------------------------------
// §18 既存 object との同一性 / PUT 後の読み戻し
// ---------------------------------------------------------------------------

/** S3 から読み戻した実体。**ETag は監査表示用で、判定には使わない。** */
export interface ObjectObservation {
  exists: boolean;
  bodyBytes: Uint8Array | null;
  /** 監査へ出すためだけに持つ。**同一性の判定に使わない** (§18.4)。 */
  etag?: string | null;
}

export type ExistingVerdict =
  | { kind: 'missing' }
  | { kind: 'already_verified' }
  | { kind: 'mismatch'; reasons: string[] };

/**
 * §18.1。既存 object が「無い」「完全一致」「違う」のどれかを決める。
 *
 * **違うときは BLOCK であって、上書きでも削除再実行でもない** (Appendix F-14)。
 * 判定は **本文の SHA-256** と **body の 3 フィールド**だけ。**ETag を見ない。**
 */
export function judgeExisting(
  observed: ObjectObservation,
  intendedBody: Uint8Array,
  expect: FormatExpectation,
  keyMeta: { clientId: string; testDate: string; formatId: string } | null,
): ExistingVerdict {
  if (!observed.exists || observed.bodyBytes == null) return { kind: 'missing' };
  const reasons: string[] = [];
  const actualSha = sha256Hex(observed.bodyBytes);
  const intendedSha = sha256Hex(intendedBody);
  if (actualSha !== intendedSha) {
    reasons.push(`本文の SHA-256 が違う (既存 ${actualSha.slice(0, 12)}… / 今回 ${intendedSha.slice(0, 12)}…)`);
  }
  if (observed.bodyBytes.length !== intendedBody.length) {
    reasons.push(`バイト数が違う (既存 ${observed.bodyBytes.length} / 今回 ${intendedBody.length})`);
  }
  const body = validateFormatBody(observed.bodyBytes, expect, keyMeta);
  reasons.push(...body.reasons);
  return reasons.length === 0 ? { kind: 'already_verified' } : { kind: 'mismatch', reasons };
}

export type ReadbackVerdict = { ok: true } | { ok: false; reasons: string[] };

/**
 * §18.3。**PUT 後は Head だけで成功扱いしない。**
 * GetObject した本文で SHA-256 / バイト数 / JSON / client_id / format_id / test_date を見る。
 */
export function judgeReadback(
  observed: ObjectObservation,
  intendedBody: Uint8Array,
  expect: FormatExpectation,
  keyMeta: { clientId: string; testDate: string; formatId: string } | null,
): ReadbackVerdict {
  if (!observed.exists || observed.bodyBytes == null) {
    return { ok: false, reasons: ['PUT 後に GetObject できない'] };
  }
  const v = judgeExisting(observed, intendedBody, expect, keyMeta);
  if (v.kind === 'already_verified') return { ok: true };
  if (v.kind === 'missing') return { ok: false, reasons: ['PUT 後に object が無い'] };
  return { ok: false, reasons: v.reasons };
}

// ---------------------------------------------------------------------------
// §18.4 status
// ---------------------------------------------------------------------------

export type FileOutcome = 'created_verified' | 'already_verified' | 'blocked_existing_mismatch' | 'readback_failed' | 'not_attempted';

/**
 * §18.4。**3 ファイル全てが `created_verified` か `already_verified` のときだけ** complete。
 * 1 件でも readback FAIL なら `exported` にしない。
 */
export function subjectComplete(outcomes: readonly FileOutcome[]): boolean {
  if (outcomes.length !== V3_DELIVERY_FORMATS.length) return false;
  return outcomes.every((o) => o === 'created_verified' || o === 'already_verified');
}
