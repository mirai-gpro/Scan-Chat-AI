/**
 * ════════════════════════════════════════════════════════════════════════════
 * **体験アカウント = canonical `diagnostic_user_id` の唯一の決定層**
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 正本 `docs/specs/special_demo_integration_spec_20261022.md` (PR-B)。
 *
 * 【これは何を解く層か】**1 人につき `diagnostic_user_id` は 1 つ**という絶対条件を、
 * Demo 資格 (`demo.account_*`) と Real/Special 資格 (`special.account_*`) の
 * **2 つの名簿をまたいで**守るための層。
 *
 * 【壊れていた経路 (実測)】
 *   R2 … Demo に登録済みの人 (メール行 uid=B) を Special へ足すと、
 *        admin API が `mintSpecialUid()` で**まったく新しい uid=C** を採番していた。
 *        Demo のメール行を 1 度も見ていないため。
 *   R3 … その人が次にサインインすると `resolve.ts` の事前発行 uid ガードが
 *        `C !== B` を検出して **409 (書き込み 0)** になる = **ログインできない**。
 * → **uid を決める場所が 2 つあった**のが原因。この層に 1 本化し、
 *   **片方に uid が在るならそれを採る**ことで R2 を根から消す。
 *
 * 【越えてはならない線】
 *   ・**UID を増やさない。** 片方に uid が在れば必ずそれを採る (再採番しない)
 *   ・**自動統合しない。** 両方に uid が在って**値が違う**ときは
 *     `uid_conflict` で止める (fail-closed・人が判断する)。どちらかを勝たせない
 *   ・**同じ uid が両方に在るのは正常な Dual** (本番に 2 件実在)。競合ではない
 *   ・**採番はこの層だけ。** `mintSpecialUid` を他所から直接呼ばない
 *   ・**表示モードは扱わない。** ここは「資格」と「uid」だけ (PR-C が表示を扱う)
 */
import {
  demoEmailEntries, hashEmail, isDemoAccount, isUuid,
} from './demo-accounts';
import {
  isSpecialAccount, mintSpecialUid, specialEmailEntries,
} from './special-accounts';
import { refreshConfig } from './app-config';

const norm = (uid?: string | null): string => (uid ?? '').trim().toLowerCase();

/** どちらの名簿の話か。 */
export type ExperienceSide = 'demo' | 'special';

/** 名簿 1 つぶんの登録状態。`uid` は記録済みの uid (無ければ null)。 */
export interface SideRegistration {
  /** その名簿にメール行が在るか。 */
  registered: boolean;
  /** 記録済みの `diagnostic_user_id`。行が無い / uid 空なら null。 */
  uid: string | null;
}

/** 両方に uid が在って値が違う = 人が判断する (自動統合しない)。 */
export interface UidConflict {
  demoUid: string;
  specialUid: string;
}

export type ExperienceLookup =
  | { ok: true; demo: SideRegistration; special: SideRegistration; conflict: UidConflict | null }
  | { ok: false; reason: string };

/**
 * **メールで両方の名簿を 1 度に引く。**
 *
 * 【fail-closed】引けなかったら `ok:false`。**「登録なし」と同一視しない** —
 * 同一視すると app_config の取得が落ちた回に新しい uid を採番してしまう
 * (`specialPreassignedUidByEmail` と同じ約束)。
 *
 * @param email `sb.auth.getUser()` が返した**サーバ検証済み**の値、または admin が入力した値。
 *   **現物はここから先へ出さない** (sha256 にして名簿を引くだけ)。
 */
export async function lookupExperienceByEmail(
  email: string | null | undefined,
): Promise<ExperienceLookup> {
  if (!email) {
    // 引くものが無い = 失敗ではない。
    return { ok: true, demo: { registered: false, uid: null }, special: { registered: false, uid: null }, conflict: null };
  }
  try {
    await refreshConfig();
    const h = await hashEmail(email);
    const d = demoEmailEntries().find((e) => e.hash === h);
    const s = specialEmailEntries().find((e) => e.hash === h);
    const demo: SideRegistration = { registered: !!d, uid: d?.uid ? norm(d.uid) : null };
    const special: SideRegistration = { registered: !!s, uid: s?.uid ? norm(s.uid) : null };
    return { ok: true, demo, special, conflict: detectConflict(demo.uid, special.uid) };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error('[experience-accounts] lookupExperienceByEmail 失敗 (登録なしと同一視しない):', reason);
    return { ok: false, reason };
  }
}

/**
 * **競合の定義 — ここだけが判定の正。**
 *
 * 競合 = **両方に uid が在って、値が違う**とき。それ以外は競合ではない:
 *   ・同じ uid が両方に在る → **正常な Dual** (絶対条件「同時に持てる」の形)
 *   ・片方が空 → 競合ではない (空の側へ在る側の uid を写せばよい)
 *   ・両方が空 → 競合ではない
 */
export function detectConflict(demoUid: string | null, specialUid: string | null): UidConflict | null {
  const d = norm(demoUid);
  const s = norm(specialUid);
  if (!d || !s) return null;
  if (d === s) return null;
  return { demoUid: d, specialUid: s };
}

export type CanonicalResolve =
  | { ok: true; uid: string | null; side: ExperienceSide | null; dual: boolean }
  | { ok: false; reason: 'uid_conflict'; conflict: UidConflict }
  | { ok: false; reason: 'lookup_failed'; detail: string };

/**
 * **サインイン経路 (`resolve.ts`) が呼ぶ。** この email の canonical uid を決める。
 *
 * 優先順 = **① Special のメール行 → ② Demo のメール行 → ③ その Auth アカウントの
 * 既存 uid → ④ 新規発行**。**①②の順序は従来どおり** (Special を先に見る =
 * 実データ側を優先してダミーを掴ませない・`resolve.ts` の元の並びと同じ)。
 *
 * **保存はしない。** 直後に呼ばれる `linkSpecialEmail` / `linkDemoEmail` が書く
 * (書き込み口を増やさない)。
 *
 * @param existingUid その Auth アカウントに既に割り当てられている uid
 *   (`findLinkedUid` の結果)。**渡さないと新しい uid を作って
 *   `app_users.auth_user_id` の UNIQUE に衝突する** (本番実測済み)。
 * @returns `uid: null` … どちらの名簿にも無い (= 従来どおり未連携へ落とす)
 */
export async function resolveCanonicalUidByEmail(
  email: string | null | undefined,
  existingUid?: string | null,
): Promise<CanonicalResolve> {
  const look = await lookupExperienceByEmail(email);
  if (!look.ok) return { ok: false, reason: 'lookup_failed', detail: look.reason };
  if (look.conflict) return { ok: false, reason: 'uid_conflict', conflict: look.conflict };
  if (!look.demo.registered && !look.special.registered) {
    return { ok: true, uid: null, side: null, dual: false };
  }
  const dual = look.demo.registered && look.special.registered;
  // **Special が登録されていれば side は special** (従来の `resolvedFrom` と同じ意味)。
  const side: ExperienceSide = look.special.registered ? 'special' : 'demo';
  const uid = look.special.uid || look.demo.uid || norm(existingUid) || crypto.randomUUID().toLowerCase();
  return { ok: true, uid, side, dual };
}

export type RegistrationUid =
  | { ok: true; uid: string | null; source: 'special' | 'demo' | 'minted' }
  | { ok: false; reason: 'uid_conflict'; conflict: UidConflict }
  | { ok: false; reason: 'mint_failed' };

/**
 * **admin の登録経路 (`/api/admin/{special,demo}-accounts`) が呼ぶ。**
 *
 * 【要点 = R2 を消す】登録しようとしている側に uid が無くても、
 * **もう片方に uid が在ればそれを採る**。ここを飛ばして `mintSpecialUid` を
 * 直接呼んでいたのが UID 分裂の原因だった。
 *
 * 【side ごとの違い】
 *   ・`special` … uid が無ければ**発行する** (登録のその場で確定させる・
 *     本人のログイン前に検査データを入れる運用が成立しなくなるため。仕様書 §4.1.1)
 *   ・`demo` … uid が無ければ**発行しない** (`uid: null` を返す)。
 *     デモ枠は従来どおり**サインイン時に uid が決まる**。
 *     ここで発行すると、現行の Demo の仕様を変えたうえ UID を増やす側に倒れる。
 *
 * @param taken 既に使われている uid (衝突回避用)。`special` のときだけ使う。
 * @returns `uid: null` は「いま決めない」(demo 側のみ)。**競合・採番失敗は `ok:false`** で、
 *   呼び出し側は **`setConfig` に 1 度も到達させない**こと。
 */
export function canonicalUidForRegistration(input: {
  side: ExperienceSide;
  /** 登録先の名簿に既に記録されている uid (無ければ null)。 */
  ownUid: string | null;
  /** もう片方の名簿に記録されている uid (無ければ null)。 */
  otherUid: string | null;
  taken?: Iterable<string>;
}): RegistrationUid {
  const own = norm(input.ownUid);
  const other = norm(input.otherUid);
  const conflict = detectConflict(
    input.side === 'demo' ? own : other,
    input.side === 'demo' ? other : own,
  );
  if (conflict) return { ok: false, reason: 'uid_conflict', conflict };
  // ① 自分の側に記録済み → ② もう片方の uid を**写す** (再採番しない)
  if (own) return { ok: true, uid: own, source: input.side === 'demo' ? 'demo' : 'special' };
  if (other) return { ok: true, uid: other, source: input.side === 'demo' ? 'special' : 'demo' };
  // ③ どちらにも無い
  if (input.side === 'demo') return { ok: true, uid: null, source: 'demo' };
  const minted = mintSpecialUid(input.taken ?? []);
  if (!minted) return { ok: false, reason: 'mint_failed' };
  return { ok: true, uid: minted, source: 'minted' };
}

/** uid 1 つが持つ資格。**表示モードではない** (PR-C が別に扱う)。 */
export interface ExperienceCapabilities {
  /** Demo のダミーを見られるか (`demo.account_uids` に在るか)。 */
  canDemo: boolean;
  /** 本人の実データを扱えるか (`special.account_uids` に在るか)。 */
  canReal: boolean;
  /** 両方の資格を持つ = Dual。**正常な状態。** */
  dual: boolean;
}

/**
 * **uid から資格を引く。** `isDemoAccount` / `isSpecialAccount` をそのまま使う
 * (判定の実装を 2 つ持たない)。
 *
 * **ここでは排他にしない。** 現行の `demoFallbackEnabled()` は
 * 「Special なら Demo を出さない」という排他を持っているが、それは
 * **表示の決定**であって資格ではない。PR-C で表示モード側へ移す。
 */
export function experienceCapabilities(uid?: string | null): ExperienceCapabilities {
  const canDemo = isDemoAccount(uid);
  const canReal = isSpecialAccount(uid);
  return { canDemo, canReal, dual: canDemo && canReal };
}

/** admin 画面・切り分け用。uid の形をしているか (名簿の入力チェックと共有)。 */
export { isUuid };
