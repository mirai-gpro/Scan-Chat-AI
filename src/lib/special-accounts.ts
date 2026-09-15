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
// uid はサインイン時に自動で埋まる (`linkSpecialEmail`)。
// **メールアドレスの現物は保存しない** — sha256 / マスク / uid / メモ の 4 つだけ。

export function specialEmailEntries(): SpecialEmailEntry[] {
  return parseEmailEntries(cfg('special.account_emails'));
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
  emails: (SpecialEmailEntry & { linked: boolean })[];
  configRaw: string;
  emailsRaw: string;
  deniedRaw: string;
} {
  const configRaw = cfg('special.account_uids');
  const emailsRaw = cfg('special.account_emails');
  const deniedRaw = cfg('special.account_denied_uids');
  const denied = deniedUids();
  const rows: SpecialAccountRow[] = [
    ...BUILTIN_SPECIAL_UIDS.map((uid) => ({ uid, label: BUILTIN_LABELS[uid] ?? '', source: 'builtin' as const })),
    ...parseEntries(String(import.meta.env.SPECIAL_ALLOWED_UIDS ?? '')).map((e) => ({ ...e, source: 'env' as const })),
    ...parseEntries(configRaw).map((e) => ({ ...e, source: 'config' as const })),
  ];
  /*
   * `linked` = その人が**もうサインインしたか**。false なら「登録はしたがまだ本人が来ていない」
   * = 正常。**異常に見せない** (仕様書 §4.1)。
   * 判定は**記録した uid が一覧に在るか**だけ。ラベルの一致で推測しない
   * (ラベルは admin が書き換えられるので、推測すると黙って誤判定する)。
   */
  const known = new Set(rows.map((r) => r.uid));
  const emails = parseEmailEntries(emailsRaw).map((e) => ({
    ...e,
    linked: !!e.uid && known.has(e.uid),
  }));

  const fromEmail = new Set(emails.filter((e) => e.uid).map((e) => e.uid));
  for (const r of rows) {
    if (fromEmail.has(r.uid)) r.viaEmail = true;
    if (denied.has(r.uid)) r.denied = true;
  }

  return { rows, emails, configRaw, emailsRaw, deniedRaw };
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
