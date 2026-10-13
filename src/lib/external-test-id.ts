/**
 * 受取時に撮影した**外部検査ID**の正規化・検証・採否判定（**純関数・I/O なし**）。
 *
 * 正本: `docs/lab/kit_receipt_external_id_capture_spec.md`
 *       ＋ `docs/lab/lab_data_pipeline_master_spec.md` §4-5（4検査横断の v2.1 正本）
 *
 * 【このファイルが引き受けること】
 *   ① 読み取り値の正規化（全角→半角・区切りの除去）
 *   ② **構造ガード**（これだけは絶対に間違えない条件＝数字のみ・長さの範囲）
 *   ③ **期待パターン**との照合（app_config から来る・**外れても登録は止めない**）
 *   ④ バーコードと印字IDの一致確認 → **自動確定してよいかの判定**
 *   ⑤ プリベントの問診CSV 生成を止める fail-closed ゲート
 *
 * 【なぜ期待パターンをコードに焼かないか】
 * プリベントの **総桁数・prefix は現物で確定している** —
 * 実物のシール台紙 1 枚（2026-10-13・仕様 §2.1.1）で「ユーザーID」が
 * **`704000` ＋ 3 桁の計 9 桁**であること、バーコードの下に **`A` ＋ 数字 ＋ `A`** が
 * 印字されていることを確認した（下の `DEFAULT_EXPECTED_PATTERN` と一致）。
 * **それでもコードに焼かない。** 見たのは 1 枚で、
 * **① 1次元バーコードの規格名**（`A…A` は Codabar (NW-7) の start/stop の使い方と整合するが
 * **断定していない**）**② チェックディジットの有無 ③ prefix が全ロットで固定か**は未確認。
 * しかも dev seed の `customer.lab_companies` にはプリベントの `external_id_pattern` が
 * **`^K[0-9]{4}$`** と入っており（`supabase/seed.sql:21`）、これは `704000123` を**弾く**。
 * つまり「DB に在るパターン」を信じると実物が通らない。
 *
 * → **2 段構えにする**:
 *   - **構造ガード（ハード）**= 数字のみ・長さ 4〜20。形式が何であれ成り立つ条件だけを見る。
 *     ここを外れた値は**そもそも受け付けない**。
 *   - **期待パターン（ソフト）**= app_config `labid.prevent_pattern` / `labid.demecal_pattern`。
 *     外れたら**登録は通すが `review_required` にする**（自動確定しない）。
 *     実物の形式が既定と違っても**運用が止まらず**、admin が即日パターンを直せる。
 *
 * 仕様 §1-3「0 件・複数件・重複・不一致は自動確定しない」をここで機械化している。
 */

/** 対応する検査会社。**Genoplan は入れない**（正本はタカセ返送CSV 方式・仕様 §2.3）。 */
export const EXTERNAL_ID_PROVIDERS = ['prevent', 'demecal'] as const;
export type ExternalIdProvider = (typeof EXTERNAL_ID_PROVIDERS)[number];

/**
 * provider ↔ `test_type` の対応。**片方だけ送られても整合を検証できるようにする**
 * （仕様 §6.3「provider と test_type の整合を検証する」）。
 * `test_type` の値は `customer.kit_shipments.test_type` / `customer.lab_companies.test_types`
 * と同じ語彙（`supabase/seed.sql:20-21`）。
 */
export const PROVIDER_TEST_TYPE: Record<ExternalIdProvider, string> = {
  prevent: 'cancer_urine',
  demecal: 'blood',
};

/** その検査で取る ID の種類。先方の呼び方をそのまま使う（当社で言い換えない）。 */
export const PROVIDER_ID_KIND: Record<ExternalIdProvider, string> = {
  prevent: 'barcode_no',   // 先方名称「バーコードNo.」
  demecal: 'inquiry_no',   // 先方名称「問合せ番号」
};

/** どの列へ入れるか。物理キットの番号は `external_barcode`、外部照会系の番号は `external_test_id`。 */
export const PROVIDER_ID_COLUMN: Record<ExternalIdProvider, 'external_barcode' | 'external_test_id'> = {
  // バーコードNo. は**検体に貼付される物理バーコード**なので物理キットID の列（仕様 §6.2）。
  prevent: 'external_barcode',
  // 15桁「問合せ番号」は外部照会／注文系のID（仕様 §6.2）。
  // **DSS の `指図番号` と同一だと断定していない**（桁数が一致しない・仕様 §2.3）。
  demecal: 'external_test_id',
};

/** 構造ガード（ハード）。形式が何であれ成り立つ条件だけ。 */
export const ID_MIN_DIGITS = 4;
export const ID_MAX_DIGITS = 20;

/**
 * 期待パターンのコード既定（app_config `labid.*_pattern` の `default`）。
 *
 * - prevent: **実物と一致している**（2026-10-13・実物のシール台紙 1 枚＝仕様 §2.1.1。
 *   「ユーザーID」が `704000` ＋ 3 桁の計 9 桁）。もともと仕様書の表示例を写した値で、
 *   当社が桁数を発明したものではない。**ロット差は未確認なので app_config のまま**にする —
 *   違う形式が来れば `review_required` が増えるだけで**登録は止まらず**、admin が即日直せる。
 * - demecal: **「15桁の問合せ番号」という記載どおり**の 15 桁（**こちらは実物未確認**）。
 */
export const DEFAULT_EXPECTED_PATTERN: Record<ExternalIdProvider, string> = {
  prevent: '^704000[0-9]{3}$',
  demecal: '^[0-9]{15}$',
};

export function isExternalIdProvider(v: unknown): v is ExternalIdProvider {
  return typeof v === 'string' && (EXTERNAL_ID_PROVIDERS as readonly string[]).includes(v);
}

/** provider と test_type が噛み合っているか。*/
export function providerMatchesTestType(provider: ExternalIdProvider, testType: unknown): boolean {
  return typeof testType === 'string' && PROVIDER_TEST_TYPE[provider] === testType;
}

/** `test_type` から provider を引く（対応が無ければ null＝この検査は撮影の対象外）。 */
export function providerForTestType(testType: unknown): ExternalIdProvider | null {
  if (typeof testType !== 'string') return null;
  for (const p of EXTERNAL_ID_PROVIDERS) {
    if (PROVIDER_TEST_TYPE[p] === testType) return p;
  }
  return null;
}

/**
 * 読み取り値を数字列へ正規化する。
 *
 * - **全角数字を半角へ**（スマホの手入力・OCR で混ざる）
 * - 空白（半角/全角）・ハイフン類（`-` `‐` `‑` `–` `—` `ー` `−`）・`.` を**区切りとして捨てる**
 * - それ以外の文字が残ったら **null**（数字列にならないものを通さない＝構造ガード）
 *
 * **数字以外を黙って削らない**のが要点。`O`→`0` のような「親切な補正」は、
 * 別の番号に化ける可能性があるので**やらない**（捏造ゼロ）。
 */
export function normalizeExternalId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  // 全角数字 → 半角
  s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  // 区切りとして捨ててよい文字だけを除去する
  s = s.replace(/[\s　\-‐‑‒–—―ー−.]/g, '');
  /*
   * **バーコードの start/stop 文字を 1 文字だけ剥がす。**
   *
   * 実物のプリベントのシール台紙（2026-10-13 に確認）では、バーコードの下に
   * **`A` で挟んだ形**（`A` + ユーザーID + `A`）が印字されている。Codabar (NW-7) は
   * **A〜D を start/stop に使う**ので、デコーダがそれを含めて返すことがある。
   * 剥がさないと `^[0-9]+$` で落ちて **バーコード側が常に捨てられ**、
   * 印字の OCR だけが残って**毎回 `single_source` = `review_required`** になる（実測）。
   *
   * **中身が全部数字のときだけ**剥がす。`7O4000123` のように**間に**英字が混ざる場合は
   * 従来どおり null（`O`→`0` のような補正をすると別の番号に化ける）。
   *
   * **Code39 の `*` は剥がさない。** 実物で見ていないので入れない。
   * もし `*` 付きで返るデコーダがあれば、その回は確定せず `review_required` に落ちる
   * ＝**黙って別の値になるより安全な側**に倒れる。
   */
  const m = /^[A-Da-d]?([0-9]+)[A-Da-d]?$/.exec(s);
  return m ? m[1] : null;
}

/** 構造ガードを通るか（数字のみ・長さの範囲内）。 */
export function passesStructuralGuard(normalized: string | null): boolean {
  if (!normalized) return false;
  return /^[0-9]+$/.test(normalized)
    && normalized.length >= ID_MIN_DIGITS
    && normalized.length <= ID_MAX_DIGITS;
}

/**
 * 期待パターン（app_config の文字列）にマッチするか。
 *
 * **パターンが壊れていても落ちない**。コンパイルできない正規表現は「判定不能」として
 * `null` を返し、呼び出し側は `review_required` に倒す（**誤って自動確定しない**）。
 * 空文字は「パターン未設定」＝判定不能。
 */
export function matchesExpectedPattern(normalized: string, pattern: string | null | undefined): boolean | null {
  const p = (pattern ?? '').trim();
  if (!p) return null;
  let re: RegExp;
  try {
    re = new RegExp(p);
  } catch {
    return null;
  }
  return re.test(normalized);
}

/** 外部IDの表示用マスク。**全文を画面・ログ・分析イベントへ出さない**（仕様 §6.1）。 */
export function maskExternalId(normalized: string | null | undefined, keep = 4): string {
  const s = (normalized ?? '').trim();
  if (!s) return '';
  if (s.length <= keep) return '*'.repeat(s.length);
  return '*'.repeat(s.length - keep) + s.slice(-keep);
}

/** 読み取り経路。`manual` は手入力補正。 */
export type DecodeMethod = 'barcode' | 'ocr' | 'barcode+ocr' | 'manual';
/** 撮影経路。 */
export type CaptureMethod = 'camera' | 'file' | 'manual';

/** 採否の判定結果。`confirmed` は「ユーザーが確認すれば確定してよい」という意味。 */
export type CaptureStatus = 'confirmed' | 'review_required';

/**
 * `lab_tests` への紐付け結果（台帳 `lab_test_link_status`）。
 * **`linked` 以外は「この番号がこの検査のものだと確定していない」** という意味なので、
 * プリベント問診CSV のゲートは `linked` だけを通す（§7.1）。
 */
export type LabTestLinkStatus = 'linked' | 'deferred' | 'conflict';

/** 判定が `review_required` になった理由コード（画面と監査の両方で使う）。 */
export type ReviewReason =
  | 'barcode_ocr_mismatch'   // バーコードと印字IDが食い違う
  | 'single_source'          // 片方しか読めていない
  | 'pattern_mismatch'       // 期待パターンに合わない
  | 'pattern_unknown'        // 期待パターンが未設定／壊れている＝判定不能
  | 'manual_entry';          // 手入力で入れた値

export interface EvaluateInput {
  provider: ExternalIdProvider;
  /** 1次元バーコードのデコード結果（無ければ null）。 */
  barcode?: unknown;
  /** 印字された「ユーザーID」等の OCR 結果（無ければ null）。 */
  ocr?: unknown;
  /** 手入力の補正値（あればこれを採る）。 */
  manual?: unknown;
  /** 期待パターン（app_config 由来）。 */
  expectedPattern?: string | null;
}

/** 正規化できた各経路の値（監査用。画面には出さない）。 */
export interface EvaluateSources {
  barcode: string | null;
  ocr: string | null;
  manual: string | null;
}

/**
 * **`ok` で絞れる判別可能ユニオン**にしてある。
 * `value: string | null` を 1 つの型に同居させると、呼び出し側が `ok` を見たあとでも
 * `null` を外せず、**チェックを忘れたコードが型で通ってしまう**。
 */
export type EvaluateResult =
  | {
      ok: true;
      /** 採った値（正規化済み）。 */
      value: string;
      status: CaptureStatus;
      decodeMethod: DecodeMethod;
      reasons: ReviewReason[];
      sources: EvaluateSources;
    }
  | {
      ok: false;
      value: null;
      status: CaptureStatus;
      decodeMethod: DecodeMethod;
      reasons: ReviewReason[];
      sources: EvaluateSources;
      /** 構造ガードを通る値が 1 つも無い。 */
      error: 'no_readable_value';
    };

/**
 * バーコード／OCR／手入力から**採る値**と**自動確定してよいか**を決める。
 *
 * 優先順位（仕様 §5.1）: ① 手入力補正 ② 1次元バーコード ③ 印字IDの OCR。
 *
 * **自動確定（`confirmed`）になるのは、両方読めて一致し、期待パターンにも合うときだけ。**
 * それ以外は全部 `review_required`。`review_required` でも**登録は通す** —
 * 止めてしまうと実物の形式が既定と違う回に**何も記録できなくなる**（仕様 §2.3）。
 */
export function evaluateExternalId(input: EvaluateInput): EvaluateResult {
  const barcode = normalizeExternalId(input.barcode);
  const ocr = normalizeExternalId(input.ocr);
  const manual = normalizeExternalId(input.manual);
  const sources = { barcode, ocr, manual };

  const reasons: ReviewReason[] = [];
  let value: string | null = null;
  let decodeMethod: DecodeMethod = 'manual';

  if (manual && passesStructuralGuard(manual)) {
    value = manual;
    decodeMethod = 'manual';
    reasons.push('manual_entry');
  } else {
    const bOk = barcode && passesStructuralGuard(barcode) ? barcode : null;
    const oOk = ocr && passesStructuralGuard(ocr) ? ocr : null;
    if (bOk && oOk) {
      value = bOk;                       // バーコードを採る（印字より機械可読が確実）
      if (bOk === oOk) {
        decodeMethod = 'barcode+ocr';
      } else {
        decodeMethod = 'barcode';
        reasons.push('barcode_ocr_mismatch');
      }
    } else if (bOk) {
      value = bOk;
      decodeMethod = 'barcode';
      reasons.push('single_source');
    } else if (oOk) {
      value = oOk;
      decodeMethod = 'ocr';
      reasons.push('single_source');
    }
  }

  if (!value) {
    return {
      ok: false, value: null, status: 'review_required',
      decodeMethod: 'manual', reasons: [], sources, error: 'no_readable_value',
    };
  }

  const pattern = input.expectedPattern ?? DEFAULT_EXPECTED_PATTERN[input.provider];
  const m = matchesExpectedPattern(value, pattern);
  if (m === null) reasons.push('pattern_unknown');
  else if (m === false) reasons.push('pattern_mismatch');

  return {
    ok: true,
    value,
    status: reasons.length === 0 ? 'confirmed' : 'review_required',
    decodeMethod,
    reasons,
    sources,
  };
}

/**
 * プリベント向け問診CSV の **fail-closed ゲート**（仕様 §7.1 の①）。
 *
 * 【ここが本当のゲート】UI で案内を出すだけでは「問診データをプリベントへ出す前に必ず
 * ブロック」を満たせない（API 直叩き・admin 経路・将来のバッチで迂回できる）。
 * **CSV を生成する側がこの関数を通す**ことで、どの経路からでも止まる。
 *
 * **`interview-cycle.ts` には足さない。** あちらは「この回の問診が済んだか」の純関数で、
 * 回窓が取れないときに **`done_this_cycle`（＝催促しない）へ倒す fail-safe** を持つ
 * （`interview-cycle.ts:16-18`）。そこへゲートを足すと、回窓が読めない回に
 * **ゲートが素通りする（fail-open）**。向きが逆なので混ぜてはいけない。
 *
 * 【通す条件は 3 つ揃ったときだけ（発注者指示 2026-10-11）】
 *   - `status === 'confirmed'`
 *   - `labTestLinkStatus === 'linked'`
 *   - `labTestId` が非 null
 *
 * **値だけを見て通してはいけない。** 値が読めていても
 * `review_required`（パターン外・読取が怪しい）や `deferred`（`lab_tests` を作れなかった）
 * `conflict`（同じIDが別の検査に在る）の回は、**その番号がこの検査のものだと確定していない**。
 * ここで通すと、問診CSV が**別人・別回の番号で**プリベントへ渡り得る。
 * どれも admin が見て決める事柄なので、**判断を機械に代行させずブロックする**。
 *
 * @param input.capture 「**今回の検査**」に紐づいた台帳レコード
 *   （`loadCapturedExternalId()` が `shipmentRef` か `labTestId` で引いたもの）。
 *   **「その人の最新」を渡してはいけない** — 前年の確定済みレコードで今年が通る。
 *   null / undefined は未取得として必ずブロックする。
 */
export interface PreventGateCapture {
  /** 正規化済みの外部ID。 */
  normalizedValue: string | null | undefined;
  /** 台帳の `status`。 */
  status: CaptureStatus | string | null | undefined;
  /** 台帳の `lab_test_link_status`。 */
  labTestLinkStatus: LabTestLinkStatus | string | null | undefined;
  /** 台帳の `lab_test_id`。 */
  labTestId: string | null | undefined;
}

export interface PreventGateInput {
  /** **今回の検査**の台帳レコード（未取得なら null）。 */
  capture: PreventGateCapture | null | undefined;
  /** 期待パターン（app_config 由来）。 */
  expectedPattern?: string | null;
}

export type PreventGateReason =
  | 'ok'
  | 'capture_missing'
  | 'barcode_no_missing'
  | 'barcode_no_malformed'
  | 'capture_not_confirmed'
  | 'lab_test_not_linked';

export interface PreventGateResult {
  allowed: boolean;
  reason: PreventGateReason;
  /** 画面・PR に出せる説明（**外部IDの全文は入れない**）。 */
  detail: string;
}

export function checkPreventQuestionnaireGate(input: PreventGateInput): PreventGateResult {
  const cap = input.capture;
  if (!cap) {
    return {
      allowed: false,
      reason: 'capture_missing',
      detail: 'この回のプリベント検査に紐づく外部ID の登録がありません。受取確認で撮影・登録してください。',
    };
  }

  const v = normalizeExternalId(cap.normalizedValue);
  if (!v) {
    return {
      allowed: false,
      reason: 'barcode_no_missing',
      detail: 'プリベントのバーコードNo. が未登録です。受取確認で撮影・登録してください。',
    };
  }
  if (!passesStructuralGuard(v)) {
    return {
      allowed: false,
      reason: 'barcode_no_malformed',
      detail: `登録済みのバーコードNo. が数字 ${ID_MIN_DIGITS}〜${ID_MAX_DIGITS} 桁の形になっていません (${maskExternalId(v)})。`,
    };
  }

  // **期待パターン外は `review_required` になっている** ので、次の段で止まる。
  // ここでパターンを再判定して独自にブロックしない（台帳の status を正とする）。
  if (cap.status !== 'confirmed') {
    return {
      allowed: false,
      reason: 'capture_not_confirmed',
      detail: `外部ID の登録が確定していません (status=${String(cap.status ?? 'unknown')})。管理画面で確認してください。`,
    };
  }

  const labTestId = typeof cap.labTestId === 'string' ? cap.labTestId.trim() : '';
  if (cap.labTestLinkStatus !== 'linked' || !labTestId) {
    return {
      allowed: false,
      reason: 'lab_test_not_linked',
      detail: `外部ID が検査レコードへ紐づいていません (link=${String(cap.labTestLinkStatus ?? 'unknown')})。管理画面で確認してください。`,
    };
  }

  return { allowed: true, reason: 'ok', detail: '' };
}
