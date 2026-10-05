/**
 * **スペシャルアカウントの「資格」** — EC で購入していない人に、
 * **本人の実データで**アプリを使ってもらうための枠。
 *
 * 正本: `docs/operations/スペシャルアカウント_仕様書.md`
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【設計の要】デモ用アカウントとは**目的が逆**。仕組みが似ていても混ぜない。
 * ══════════════════════════════════════════════════════════════════════
 *
 *   デモ用アカウント   … **ダミー**を見せる。相手は記者・パートナー (社外)
 *   スペシャルアカウント … **本人の実データ**を扱う。相手は本人
 *
 * 同じ枠に入れると `demoFallbackEnabled()` が真になり、
 * **本人の画面に他人名義のダミー検査結果が出る**。実データを扱う本枠では致命的なので、
 * `demo-data.ts` 側にも 1 行だけ止めを入れてある (仕様書 §7)。
 *
 * 【デモ枠と共有するもの / しないもの】(仕様書 §9.1)
 *   - 共有する = **純粋関数だけ** (`hashEmail` / `maskEmail` / `parseEntries` /
 *     `parseEmailEntries` / `serializeEmailEntries` / `isUuid`) を import する。再実装しない
 *   - 分ける   = 判定・供給元・app_config キー・admin 画面
 *   - やらない = デモ枠を共通基盤へリファクタすること (稼働中の機能に波及する)
 */

import { cfg, refreshConfig, setConfig } from './app-config';
import {
  hashEmail, isUuid, maskEmail,
  parseEmailEntries, parseEntries, serializeEmailEntries,
  type DemoAccountEntry, type DemoEmailEntry,
} from './demo-accounts';

/** 一覧の 1 行 = uid ＋ 注釈。**PII は書かない**。 */
export type SpecialAccountEntry = DemoAccountEntry;
/** メールで登録した 1 件。**現物のアドレスは持たない。** */
export type SpecialEmailEntry = DemoEmailEntry;

/** uid の表記ゆれを吸収する (大文字・前後の空白)。 */
const norm = (uid?: string | null): string => (uid ?? '').trim().toLowerCase();

/**
 * **この uid はスペシャルアカウントか。**
 *
 * 判定はこれ 1 つ。閲覧者が admin かどうかは**見ない**(デモ枠で踏んだ誤り)。
 *
 * @param uid **表示中の** `diagnostic_user_id`。
 *   admin が `?u=` で代理表示しているときは相手の uid になる。
 */
export function isSpecialAccount(uid?: string | null): boolean {
  const u = norm(uid);
  return !!u && specialAccountUids().has(u);
}

/**
 * **スペシャルアカウントの uid 一覧** = 3 つの供給元の**和** − 除外リスト。
 *
 *   1. `BUILTIN_SPECIAL_UIDS`          … **原則として空**。下記参照
 *   2. env `SPECIAL_ALLOWED_UIDS`      … 要デプロイ。DB 障害時の保険
 *   3. app_config `special.account_uids` … **admin から即時**(TTL 45 秒・再デプロイ不要)
 *
 * **上書きでなく和。** 上書きにすると 1 件登録した瞬間に他が消える。
 * **除外は和のあと。** 先に引くと config 側で足し直せてしまう。
 *
 * **キャッシュしない。** `cfg()` は TTL 45 秒で入れ替わるので、固定すると登録が反映されない。
 */
function specialAccountUids(): ReadonlySet<string> {
  const set = new Set([
    ...BUILTIN_SPECIAL_UIDS,
    ...splitUids(String(import.meta.env.SPECIAL_ALLOWED_UIDS ?? '')),
    ...splitUids(cfg('special.account_uids')),
  ]);
  for (const uid of deniedUids()) set.delete(uid);
  return set;
}

/**
 * **除外リスト** — 供給元に関わらず資格を止める uid。
 *
 * **これが緊急停止の手段**。本枠には全停止 env スイッチを置かない (仕様書 §7) —
 * 止めると**その人がログインできなくなる** (EC 顧客ではないため)。
 * 供給元は残るので「戻す」で元に戻る。
 */
function deniedUids(): ReadonlySet<string> {
  return new Set(splitUids(cfg('special.account_denied_uids')));
}

function splitUids(raw: string): string[] {
  return parseEntries(raw).map((e) => e.uid);
}

/**
 * 組み込みのスペシャルアカウント = **原則として空のままにする** (仕様書 §5)。
 *
 * デモ枠と違い**実データが紐づく**ので、コードに焼き込むと
 * 外すのに再デプロイが要る。通常は app_config `special.account_uids` で管理する
 * (admin 画面から即時)。
 *
 * **ここを名簿として育てないこと。**
 */
const BUILTIN_SPECIAL_UIDS: readonly string[] = [];

/** 管理画面に「何用か」を出すための説明。**PII は書かない**。 */
const BUILTIN_LABELS: Readonly<Record<string, string>> = {};


// ══════════════════════════════════════════════════════════════════════
// Google アカウント (メールアドレス) で登録する
// ══════════════════════════════════════════════════════════════════════
//
// **登録はメール / 判定は uid。** 人は自分の `diagnostic_user_id` を知らない。
// **uid はメール登録のその場で発行する** (2026-10-05 発注者指示・仕様書 §4.1)。
// 本人の初回ログインを uid 発行の条件にしない — **ログイン前に検査データを入れられる**
// 必要があるため (トランスコスモス 10 名のように、先にデータを準備する運用)。
// サインイン時の `linkSpecialEmail` は**事前発行済みの uid をそのまま確認する**だけで、
// 新しい uid は作らない。
// **メールアドレスの現物は保存しない** — sha256 / マスク / uid / メモ の 4 つだけ。
//
// ⚠️ **ここで作るのは `diagnostic_user_id` だけ。** Supabase Auth user / password /
// Google identity / `auth_user_id` / `google_sub` は**一切作らない**。
// Auth アカウントは本人が Web アプリで Sign up / Sign in したときに従来どおり作られる。

export function specialEmailEntries(): SpecialEmailEntry[] {
  return parseEmailEntries(cfg('special.account_emails'));
}

/**
 * **この email に事前発行済みの uid が記録されているか** (記録済みの ① だけを見る)。
 *
 * 2026-10-05 の新仕様では、メール登録のその場で uid を発行して**実データを先に入れる**。
 * そのため `/api/auth/resolve` は「いま返した uid が**事前発行された本物**なのか、
 * それとも既存 uid・新規発行にフォールバックした結果なのか」を区別する必要がある
 * (区別できないと、事前投入したデータを別 uid へ黙って張り替えてしまう)。
 *
 * **判定を推論に頼らないためにこの関数を置いている。** `resolveSpecialUidByEmail` の
 * 戻り値から逆算すると、将来そちらを 1 行変えた瞬間にガードが静かに効かなくなる。
 *
 * 【照会の失敗を「事前発行なし」と同一視しない】**ここが肝**。null 1 本で返すと、
 * app_config の取得が落ちた回が「登録されていない人」と**見分けが付かない**。
 * すると競合ガードが素通りし、**事前投入済みの UID-A が黙って UID-B へ張り替わる** —
 * 守りたかったものがちょうど守れない。だから `ok` で**引けたかどうか**を分けて返し、
 * 呼び出し側は引けなかったら fail-closed で止める (`resolve.ts` が 503)。
 *
 * @returns `{ ok: true, uid }` … 引けた (`uid` は記録済みの uid / 記録が無ければ null)
 *          `{ ok: false }`     … **引けなかった** (通してはいけない)
 */
export type PreassignedUidLookup =
  | { ok: true; uid: string | null }
  | { ok: false; reason: string };

export async function specialPreassignedUidByEmail(
  email: string | null | undefined,
): Promise<PreassignedUidLookup> {
  // メールが無い = 照会するものが無い。これは失敗ではない (Google 以外の経路など)。
  if (!email) return { ok: true, uid: null };
  try {
    await refreshConfig();
    const h = await hashEmail(email);
    const hit = specialEmailEntries().find((e) => e.hash === h);
    return { ok: true, uid: hit?.uid ? norm(hit.uid) : null };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error('[special-accounts] specialPreassignedUidByEmail 失敗 (事前発行なしと同一視しない):', reason);
    return { ok: false, reason };
  }
}

/**
 * **顧客レコードを持たないスペシャルアカウントに、診断ユーザー ID を与える。**
 *
 * EC で購入していないので `resolve-customer` では引けず、そのままだと
 * 未連携の early return に落ちて「お客様情報が見つかりませんでした」で入口で弾かれる。
 *
 * - **1 度決めたら変わらない。** メール行に記録した uid をそのまま返す
 * - **顧客レコードは作らない。** 作るのは診断側の識別子だけ (PII は生まれない)
 * - **保存はしない。** 直後に呼ばれる `linkSpecialEmail` が書く (書き込み口を 2 つに増やさない)
 *
 * **新仕様 (2026-10-05) では ① がほぼ必ず当たる** — 登録時に uid を発行済みなので。
 * ②③ は**新仕様より前に登録した行 (uid 空) の救済**として残す。**順序は変えない。**
 *
 * @param existingUid **その Google アカウントに既に割り当てられている uid**
 *   (`diagnosis.app_users` を `auth_user_id` / `google_sub` で引いた結果)。
 *   **渡さないと新しい uid を作ってしまい、`app_users.auth_user_id` の
 *   UNIQUE 制約に衝突してサインインが 500 で壊れる** (デモ枠で本番実測済み)。
 */
export async function resolveSpecialUidByEmail(
  email: string | null | undefined,
  existingUid?: string | null,
): Promise<string | null> {
  try {
    if (!email) return null;
    await refreshConfig();
    const h = await hashEmail(email);
    const hit = specialEmailEntries().find((e) => e.hash === h);
    if (!hit) return null;
    // ① 記録済み → ② その Google アカウントの既存 uid → ③ 新規発行 (最後の手段)
    return hit.uid || norm(existingUid) || crypto.randomUUID();
  } catch (e) {
    console.error('[special-accounts] resolveSpecialUidByEmail 失敗:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * **サインイン時に呼ぶ。** この email がスペシャル枠として登録されていれば、
 * その uid を uid 側の一覧へ写す (以後は uid だけで毎リクエスト判定できる)。
 *
 * **新仕様 (2026-10-05) では登録時に両方へ書いてあるので、ここは何も書かずに
 * true を返すのが通常**(下の「何も変わらない = 書きに行かない」で抜ける)。
 * 書くのは**新仕様より前に登録した uid 空の行**が初めてサインインしたときだけ。
 *
 * @param email `sb.auth.getUser()` が返した**サーバ検証済み**の値。クライアントの申告ではない。
 * @returns 写したら true (＝この人はスペシャルアカウント)。
 *
 * **失敗しても例外を投げない。** サインインの経路なので、
 * 登録の失敗でサインインが壊れる方が害が大きい。
 */
export async function linkSpecialEmail(email: string | null | undefined, uid: string): Promise<boolean> {
  try {
    const u = norm(uid);
    if (!u || !isUuid(u) || !email) return false;
    /*
     * **強制リフレッシュしない (`refreshConfig()` は TTL を尊重する)。**
     * サインインは全ユーザーが通る経路なので、`refreshConfig(true)` にすると
     * **登録の無い人のサインインごとに DB 往復が 1 回増える** (＝ほぼ毎回)。
     */
    await refreshConfig();
    const h = await hashEmail(email);
    const emails = specialEmailEntries();
    const at = emails.findIndex((e) => e.hash === h);
    if (at < 0) return false; // 登録の無い人 = ここで抜ける (書きに行かない)
    const hit = emails[at];

    const uids = parseEntries(cfg('special.account_uids'));
    const already = uids.some((e) => e.uid === u);
    if (already && hit.uid === u) return true; // 何も変わらない = 書きに行かない

    const updates: Record<string, string> = {};
    if (!already) {
      uids.push({ uid: u, label: hit.label || hit.masked });
      updates['special.account_uids'] = serializeUidEntries(uids);
    }
    if (hit.uid !== u) {
      emails[at] = { ...hit, uid: u };
      updates['special.account_emails'] = serializeEmailEntries(emails);
    }
    await setConfig(updates, 'sign-in:special-email');
    await refreshConfig(true); // 次の画面描画で即座に効くように
    return true;
  } catch (e) {
    console.error('[special-accounts] linkSpecialEmail 失敗 (サインインは継続):',
      e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * **メール登録のその場で `diagnostic_user_id` を発行する** (2026-10-05 発注者指示)。
 *
 * 【なぜ登録時か】本人の初回ログインを uid 発行の条件にすると、
 * **ログイン前に検査データを入れられない**。実際の用途 (トランスコスモス 10 名) は
 * 「本人がまだ来ていないうちに健診・遺伝子・報告書を準備する」ことなので、
 * 登録の時点で uid が確定していなければ運用が成立しない。
 *
 * 【作るのは uid だけ】Supabase Auth user / password / Google identity /
 * `auth_user_id` / `google_sub` は**作らない**。admin が代理で Auth ユーザーを
 * 作ったり仮パスワードを置いたりは**絶対にしない** (仕様書 §4.3)。
 *
 * 【衝突を作らない (fail-closed)】`crypto.randomUUID()` の衝突確率は無視できるが、
 * **既存 uid を上書きする実装にはしない**のが要件。既に使われている uid
 * (`special.account_uids` ＋ メール行の uid ＋ 組み込み / env) を渡して、当たったら引き直す。
 *
 * **引き直しても駄目なら衝突 uid を返さない。** 以前は `MINT_ATTEMPTS` 回ぜんぶ外したときに
 * **最後の候補 (= 既存 uid と衝突している値) をそのまま返して**いた。確率は現実には 0 だが、
 * 返した瞬間に「既存 uid と衝突しない」という契約が破れ、**別人の uid へ相乗りした行**を
 * 作る。uid には実データが紐づくので、ここは**何もしないで止める**のが正しい
 * (呼び出し側の admin API が `503 uid_generation_failed` で中止し、`setConfig` を呼ばない)。
 * 無限ループは作らない — 回数は `MINT_ATTEMPTS` で打ち切る。
 *
 * @param taken 既に使われている uid。大文字・空白は吸収する。
 * @returns 採れた uid / **採れなければ `null`** (呼び出し側は保存せず中止する)
 */
export const MINT_ATTEMPTS = 8;

export function mintSpecialUid(taken: Iterable<string>): string | null {
  const used = new Set<string>();
  for (const t of taken) {
    const u = norm(t);
    if (u) used.add(u);
  }
  for (let i = 0; i < MINT_ATTEMPTS; i += 1) {
    const uid = crypto.randomUUID().toLowerCase();
    if (!used.has(uid)) return uid;
  }
  console.error(
    `[special-accounts] uid の採番が ${MINT_ATTEMPTS} 回連続で既存 uid と衝突しました。`
    + ' 衝突した uid は返しません (何も保存せず中止します)。ありえないので要調査。',
  );
  return null;
}

/** 保存形式は 1 行 1 件 + `#` 注釈。人が読める形で残す。 */
export function serializeUidEntries(list: SpecialAccountEntry[]): string {
  return list.map((e) => (e.label ? `${e.uid}  # ${e.label}` : e.uid)).join('\n');
}

/**
 * **admin の管理画面が見る一覧。** どの供給元から来たかを付けて返す。
 *
 * uid は `diagnostic_user_id` で **PII を含まない**。氏名やメールはここでは扱わない。
 */
export interface SpecialAccountRow extends SpecialAccountEntry {
  source: 'builtin' | 'env' | 'config';
  /** メール登録のサインインで自動的に入った行か (uid 側から外しても次のサインインで戻る)。 */
  viaEmail?: boolean;
  /** 除外リストに入っていて、いま資格が止まっている行。画面では「除外中」＋「戻す」。 */
  denied?: boolean;
}

export function listSpecialAccounts(): {
  rows: SpecialAccountRow[];
  emails: (SpecialEmailEntry & { uidAllocated: boolean; linked: boolean })[];
  configRaw: string;
  emailsRaw: string;
  deniedRaw: string;
  /** 生年月日・性別の生テキスト (PII)。**admin 画面へはそのまま返さない** — API GET でマスクする。 */
  dobRaw: string;
} {
  const configRaw = cfg('special.account_uids');
  const emailsRaw = cfg('special.account_emails');
  const deniedRaw = cfg('special.account_denied_uids');
  const dobRaw = cfg('special.account_dob');
  const denied = deniedUids();
  const rows: SpecialAccountRow[] = [
    ...BUILTIN_SPECIAL_UIDS.map((uid) => ({ uid, label: BUILTIN_LABELS[uid] ?? '', source: 'builtin' as const })),
    ...parseEntries(String(import.meta.env.SPECIAL_ALLOWED_UIDS ?? '')).map((e) => ({ ...e, source: 'env' as const })),
    ...parseEntries(configRaw).map((e) => ({ ...e, source: 'config' as const })),
  ];
  /*
   * `uidAllocated` = **`diagnostic_user_id` が発行されて資格一覧にも載っているか**。
   *
   * ⚠️ **これは「本人がサインインしたか」ではない** (2026-10-05 の仕様変更)。
   * 新仕様では**メール登録のその場で uid を発行する**ので、登録直後から true になる。
   * 以前のコメントは `linked = その人がもうサインインしたか` と書いていたが、
   * それは**もう成り立たない**ので直した。「本人が認証済みか」を知りたいなら
   * `diagnosis.app_users.auth_user_id` 等、**実際の Auth 紐付けを根拠にすること**
   * (この関数は app_config しか見ないので、その判定はここでは出せない)。
   *
   * 判定は**記録した uid が一覧に在るか**だけ。ラベルの一致で推測しない
   * (ラベルは admin が書き換えられるので、推測すると黙って誤判定する)。
   */
  const known = new Set(rows.map((r) => r.uid));
  const emails = parseEmailEntries(emailsRaw).map((e) => {
    const uidAllocated = !!e.uid && known.has(e.uid);
    return {
      ...e,
      uidAllocated,
      /**
       * @deprecated **`uidAllocated` の別名。** 既存の API 形を壊さないために残しているが、
       * **「サインイン済み」という意味では使わないこと。** 新しい consumer は
       * `uidAllocated` を読む。
       */
      linked: uidAllocated,
    };
  });

  const fromEmail = new Set(emails.filter((e) => e.uid).map((e) => e.uid));
  for (const r of rows) {
    if (fromEmail.has(r.uid)) r.viaEmail = true;
    if (denied.has(r.uid)) r.denied = true;
  }

  return { rows, emails, configRaw, emailsRaw, deniedRaw, dobRaw };
}

/** 監査・診断用の件数だけ (`/api/debug/viewer` が使う)。 */
export function specialAccountStats(): {
  total: number; builtin: number; fromEnv: number; fromConfig: number;
} {
  const { rows } = listSpecialAccounts();
  const by = (s: SpecialAccountRow['source']) => rows.filter((r) => r.source === s).length;
  return {
    total: specialAccountUids().size,
    builtin: by('builtin'),
    fromEnv: by('env'),
    fromConfig: by('config'),
  };
}


// ══════════════════════════════════════════════════════════════════════
// 生年月日・性別 (ウェルネス年齢用・PII) — 発注者指示 2026-09-24
// ══════════════════════════════════════════════════════════════════════
//
// **なぜ要るか**: スペシャルアカウントは EC 購入が無く `customer_profiles` に
// 生年月日を持たないため、ウェルネス年齢 (実年齢が必須) が算出できない
// (実測: 「算出不能(不足: 年齢)」)。登録時に控えて年齢ソースにする。
//
// **なぜ別キー (`special.account_dob`) か**: メール本体 (`special.account_emails`)
// は admin 画面へ生テキスト (emailsRaw) を返して編集させるので、生年月日を混ぜると
// **ブラインド表示が崩れる**。DOB は専用キーに隔離し、**admin へは API GET でマスクして返す**。
// 登録時点では uid はまだ無い (サインイン前) ので **email の sha256 で控える**。
// uid からの参照は email 行 (uid↔hash) を辿る。
// (新仕様では登録時に uid が付くので、**本人のサインイン前でも辿れる**。)
//
// **共有の純粋関数には手を入れていない** (仕様書 §9.1)。DOB は special 専用の追加。

export interface SpecialDobEntry {
  /** メールアドレスの sha256 (`special.account_emails` の hash と対応)。 */
  hash: string;
  /** 生年月日 YYYY-MM-DD。 */
  dob: string;
  /** 'male' | 'female'。 */
  sex: 'male' | 'female' | '';
}

const HASH64_RE = /^[0-9a-f]{64}$/;
const DOB_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 実在する暦日か (形式 + カレンダー往復)。`2026-02-31` 等は false。 */
function isRealDob(v: string): boolean {
  if (!DOB_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

/** 性別トークンを 'male'|'female'|'' に (日本語・英字・M/F を吸収)。 */
export function normSexToken(v: unknown): 'male' | 'female' | '' {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'm' || s === 'male' || s === '男' || s === '男性') return 'male';
  if (s === 'f' || s === 'female' || s === '女' || s === '女性') return 'female';
  return '';
}

/** 保存形式は 1 行 = `<sha256> <YYYY-MM-DD> <male|female>`。壊れた / 空の行は捨てる。 */
export function parseDobEntries(raw: string): SpecialDobEntry[] {
  const out: SpecialDobEntry[] = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const hashIdx = line.indexOf('#');
    const parts = (hashIdx >= 0 ? line.slice(0, hashIdx) : line).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const h = parts[0].toLowerCase();
    if (!HASH64_RE.test(h)) continue;
    const dob = isRealDob(parts[1] ?? '') ? parts[1] : '';
    const sex = normSexToken(parts[2] ?? '');
    if (!dob && !sex) continue; // 中身が無ければ持たない
    out.push({ hash: h, dob, sex });
  }
  return out;
}

export function serializeDobEntries(list: SpecialDobEntry[]): string {
  return list
    .filter((e) => e.dob || e.sex)
    .map((e) => `${e.hash} ${e.dob || '-'} ${e.sex || '-'}`)
    .join('\n');
}

export function specialDobEntries(): SpecialDobEntry[] {
  return parseDobEntries(cfg('special.account_dob'));
}

/**
 * **uid → 登録時に控えた生年月日・性別。** ウェルネス年齢の年齢ソース。
 *
 * 顧客レコードを持たない枠のためのフォールバックなので、email 行 (uid↔hash) を
 * 辿って DOB キーを引く。**uid が埋まっている行のみ**。無ければ null (捏造しない)。
 *
 * 新仕様 (2026-10-05) では登録時に uid を発行するので、**本人のサインイン前でも引ける**
 * (= ログイン前に入れた検査データでもウェルネス年齢が算出できる)。
 * 以前は「サインイン済みの行のみ」と書いていたが、uid の発行時期が変わったので直した。
 */
export function specialSubjectByUid(uid: string): { dateOfBirth: string | null; sex: 'male' | 'female' | null } | null {
  const u = norm(uid);
  if (!u) return null;
  const em = specialEmailEntries().find((e) => e.uid === u);
  if (!em) return null;
  const d = specialDobEntries().find((x) => x.hash === em.hash);
  if (!d) return null;
  return {
    dateOfBirth: DOB_RE.test(d.dob) ? d.dob : null,
    sex: d.sex === 'male' || d.sex === 'female' ? d.sex : null,
  };
}
