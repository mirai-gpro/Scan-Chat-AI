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
 * `704000xxx` は**業務上の形式例**にすぎず、総桁数・prefix の固定範囲・チェックディジットの
 * 有無・1次元バーコードの規格は**未確認**（`704000` の文字列は両リポジトリに 0 件＝実測 grep）。
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

/**
 * 画面に出す呼び名。**先方の呼び方をそのまま使う**（当社で言い換えない）。
 *
 * 撮影ブロック (`ExternalIdCapture.astro`) と 7 日ワーニング
 * (`ExternalIdReminder.astro`) が**同じ文字列を使う**ために、ここ 1 か所に置く。
 * 画面ごとに別名が出ると、利用者が「どの番号の話か」を取り違える。
 */
export const PROVIDER_ID_LABEL: Record<ExternalIdProvider, string> = {
  prevent: 'バーコードNo.',
  demecal: '問合せ番号',
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
 * - prevent: **仕様書に出ている表示例 `704000xxx` をそのまま写したもの**。
 *   当社が桁数を発明したのではなく「`704000` ＋ 3 桁」という**記載どおり**。
 *   実物が違えば `review_required` が増えるだけで**登録は止まらない** → admin が直す。
 * - demecal: **「15桁の問合せ番号」という記載どおり**の 15 桁。
 */
export const DEFAULT_EXPECTED_PATTERN: Record<ExternalIdProvider, string> = {
  prevent: '^704000[0-9]{3}$',
  demecal: '^[0-9]{15}$',
};

/**
 * **発行元（法人）を表す接頭辞**のコード既定（app_config `labid.prevent_org_prefix`）。
 *
 * **プリベントのユーザーID の頭 `704` は Wellfort 法人を指す**（先方の説明・2026-10-21）。
 * つまり**当社の検査キットの番号は必ず `704` で始まる**ので、
 * **読み取りが成功したかの判定に使える**:
 *   - 読めた番号が `704` で始まらない ＝ **別の数字を読んだ疑いが濃い**
 *     （用紙には URL・パスワード・管理用の記号も印字されている）。
 *   - バーコードと印字で値が食い違ったとき、**`704` で始まる側を採る**。
 *
 * **期待パターン（`DEFAULT_EXPECTED_PATTERN`）とは別物。** あちらは総桁数まで含む
 * 「形式例」で**実物は未確認**（仕様 §2.3）だが、**`704` は先方から説明を受けた事実**。
 * 形式が違う実物が出てきたら `labid.prevent_pattern` の方を緩める。**接頭辞は緩めない。**
 *
 * デメカルは**この概念を確認していない**ので空＝判定しない（想像で足さない）。
 */
export const DEFAULT_ORG_PREFIX: Record<ExternalIdProvider, string> = {
  prevent: '704',
  demecal: '',
};

/**
 * 発行元の接頭辞で始まるか。
 *
 * - `null` ＝ **判定しない**（未設定、または数字以外が入っている＝設定の誤り）。
 *   値は構造ガードで数字のみに絞られているので、**数字でない接頭辞は必ず不一致になる** —
 *   それを「全件アウト」にすると設定の打ち間違いで**運用が止まる**ので、判定しない側へ倒す。
 * - `false` ＝ **当社の検査キットの番号ではない**（＝読み取りに失敗した疑い）。
 */
export function matchesOrgPrefix(normalized: string, prefix: string | null | undefined): boolean | null {
  const p = (prefix ?? '').trim();
  if (!p || !/^[0-9]+$/.test(p)) return null;
  return normalized.startsWith(p);
}

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
   * 剥がさないと `^[0-9]+$` で落ちて **バーコード側が常に捨てられる**。
   * **`labid.decode_skip_llm` が on の今はこれが致命的** — 印字の OCR を取らないので
   * **読める値が 1 つも無くなり毎回「撮り直してください」**になる
   * （この罠を踏んだときは「毎回 `single_source` = `review_required`」だった・実測）。
   *
   * **中身が全部数字のときだけ**剥がす。`7O4000123` のように**間に**英字が混ざる場合は
   * 従来どおり null（`O`→`0` のような補正をすると別の番号に化ける）。
   *
   * **Code39 の `*` は剥がさない。** 実物で見ていないので入れない。
   * もし `*` 付きで返るデコーダがあれば**その回はバーコード側が捨てられる**:
   * 印字の OCR が在ればそちらを採り（`single_source`。**裁定 2026-10-22 以降は
   * 接頭辞とパターンを通れば `confirmed`**）、OCR も無ければ撮り直しになる。
   * どちらも**黙って別の値になることはない**。
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
  | 'org_prefix_mismatch'    // 発行元の接頭辞 (704=Wellfort) で始まらない＝当社のキットでない
  | 'pattern_mismatch'       // 期待パターンに合わない
  | 'pattern_unknown'        // 期待パターンが未設定／壊れている＝判定不能
  | 'manual_entry';          // 手入力で入れた値

/**
 * **`review_required` へ倒さない理由コード**（＝自動確定を妨げない理由）。
 *
 * 【`single_source` はここに入る（発注者裁定 2026-10-22・仕様 §12.4.2）】
 * 発注者指示:「**片方しか、、、の表示を止めて、最初に読めた状態で確定にして**」。
 * `labid.decode_skip_llm` を on にした (§12.4.1) ので、**正常系は毎回**
 * 「バーコードは機械が読めた / 印字の OCR は無い」= `single_source` になる。
 * これを `review_required` のままにすると**全件が問診CSV のゲートで止まる**。
 *
 * **残る検査は 2 つ**（どちらも外れたらこれまでどおり `review_required`）:
 *   - **発行元の接頭辞** `704`（`labid.prevent_org_prefix`・**先方の説明で確認済み**）
 *   - **期待パターン** `labid.prevent_pattern`（既定 `^704000[0-9]{3}$` = 9 桁。
 *     **ただしこの桁数は業務上の形式例が出どころで、実物の同梱書面では未確認**・§2.3）
 *
 * **引き換えに失うもの**: バーコード × 印字の突合。機械デコードが誤読した値が
 * **9 桁で `704` から始まっていれば自動確定する**（この番号にチェックディジットは無い・
 * §4.4.2）。残る網は **証跡画像**と、同じ番号が別の検査に在るときの `conflict` だけ。
 * **`pattern_unknown`（パターン未設定・壊れている）は入れない** — 桁数を検査できない回は
 * 上の前提が崩れるので、**判定不能は従来どおりブロックする**（fail-closed）。
 *
 * **allow-list で持つ**のが要点。将来 `ReviewReason` を足した人が何もしなくても
 * **既定でブロック側になる**（ここへ明示的に入れない限り自動確定しない）。
 */
export const NON_BLOCKING_REASONS: readonly ReviewReason[] = ['single_source'];

/** その理由だけなら自動確定してよいか。 */
function blocksAutoConfirm(reason: ReviewReason): boolean {
  return !NON_BLOCKING_REASONS.includes(reason);
}

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
  /** 発行元の接頭辞（app_config 由来。`704`＝Wellfort）。 */
  orgPrefix?: string | null;
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
 * **自動確定（`confirmed`）の条件は「ブロックする理由が 1 つも無いこと」**
 * （`NON_BLOCKING_REASONS` の allow-list）。**片方しか読めていない回も確定する**
 * （発注者裁定 2026-10-22・§12.4.2）が、**接頭辞 `704` と期待パターンは必ず通す**
 * （どちらも外れたら `review_required`・パターンが未設定／壊れている回も同じ）。
 * `review_required` でも**登録は通す** —
 * 止めてしまうと実物の形式が既定と違う回に**何も記録できなくなる**（仕様 §2.3）。
 */
export function evaluateExternalId(input: EvaluateInput): EvaluateResult {
  const barcode = normalizeExternalId(input.barcode);
  const ocr = normalizeExternalId(input.ocr);
  const manual = normalizeExternalId(input.manual);
  const sources = { barcode, ocr, manual };

  const orgPrefix = input.orgPrefix ?? DEFAULT_ORG_PREFIX[input.provider];
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
      if (bOk === oOk) {
        value = bOk;
        decodeMethod = 'barcode+ocr';
      } else {
        /*
         * 食い違ったときは **発行元の接頭辞で選ぶ**（`704`＝Wellfort）。
         * 片方だけが `704…` なら、そちらが「読めた方」である可能性が高い。
         * **どちらも／どちらとも言えないときは従来どおりバーコードを採る**
         * （印字より機械可読が確実）。
         * **どちらを採っても `barcode_ocr_mismatch` は残す** — 接頭辞が合ったことは
         * 「正しい番号だ」という保証ではないので、**自動確定はさせない**。
         */
        const bPre = matchesOrgPrefix(bOk, orgPrefix);
        const oPre = matchesOrgPrefix(oOk, orgPrefix);
        if (bPre === false && oPre === true) {
          value = oOk;
          decodeMethod = 'ocr';
        } else {
          value = bOk;
          decodeMethod = 'barcode';
        }
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

  /*
   * **発行元の接頭辞**（`704`＝Wellfort）。**読み取りが成功したかの検査**として使う。
   * 外れても**登録は止めない**（撮影そのものを失わせない）が `review_required` になり、
   * 画面は「別の数字を読んだかもしれません」と図へ戻す。
   * **足りない接頭辞をこちらで補わない**（補うと別の番号に化ける＝捏造）。
   */
  if (matchesOrgPrefix(value, orgPrefix) === false) reasons.push('org_prefix_mismatch');

  const pattern = input.expectedPattern ?? DEFAULT_EXPECTED_PATTERN[input.provider];
  const m = matchesExpectedPattern(value, pattern);
  if (m === null) reasons.push('pattern_unknown');
  else if (m === false) reasons.push('pattern_mismatch');

  /*
   * **自動確定の判定は `NON_BLOCKING_REASONS` の allow-list で行う**
   * (発注者裁定 2026-10-22・§12.4.2)。`single_source` だけの回は `confirmed`。
   * **理由コードは消さない** — 「片方しか読めていなかった」ことは台帳と監査に残す
   * (画面には出さない)。
   */
  return {
    ok: true,
    value,
    status: reasons.some(blocksAutoConfirm) ? 'review_required' : 'confirmed',
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
  /** 発行元の接頭辞（app_config 由来。`704`＝Wellfort）。 */
  orgPrefix?: string | null;
}

export type PreventGateReason =
  | 'ok'
  | 'capture_missing'
  | 'barcode_no_missing'
  | 'barcode_no_malformed'
  | 'org_prefix_mismatch'
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

  /*
   * **発行元の接頭辞**（`704`＝Wellfort）。ここは**ハードな不変条件なので再判定する**。
   *
   * 期待パターン（総桁数まで含む形式例）は**実物が未確認**なので再判定しない
   * ＝ 台帳の `status` を正とする（下の段で止まる）。一方 `704` は**先方から説明を受けた
   * 事実**で、構造ガードと同じ性質の不変条件。`confirmed` の行でも `704` で始まらない値は
   * **当社の検査キットの番号ではない**ので、問診CSV に出してはいけない
   * （admin の訂正で値が差し替わった回・接頭辞の設定が後から変わった回に効く）。
   *
   * **未設定・数字でない設定のときは判定しない**（`matchesOrgPrefix` が null）。
   * 設定の打ち間違いで**全件が止まる**方が運用の被害が大きい。
   */
  if (matchesOrgPrefix(v, input.orgPrefix ?? DEFAULT_ORG_PREFIX.prevent) === false) {
    return {
      allowed: false,
      reason: 'org_prefix_mismatch',
      detail: `登録済みのバーコードNo. が発行元の接頭辞で始まっていません (${maskExternalId(v)})。`
        + ' 当社の検査キットの番号ではない可能性があります。管理画面で確認してください。',
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
