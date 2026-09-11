/**
 * 閲覧者の解決（**本番相当の入場制御**）。
 *
 * 【なぜ作ったか】従来は `?u=<diagnostic_user_id>` が**そのまま本人確認**になっていた
 * （`dashboard.astro` の `needsSignIn = authEnabled && !u`）。URL を知っていれば
 * サインインせずに他人の画面が開く。`CLAUDE.md` の
 * 「本番相当への切替（`?u=` 入場の廃止・`PUBLIC_DEMO_FALLBACK=false`・デバッグ表示の遮蔽）は
 * 総合テストの段階で行う」を、9/1 ローンチ前に実施したもの（2026-08-30）。
 *
 * 【方式】サインイン成功時にサーバが **HttpOnly Cookie** を発行し、以後はそれを本人とする。
 *   - Cookie は `uid.exp.HMAC-SHA256(uid.exp)`。**署名鍵はサーバ env のみ**。
 *   - `HttpOnly` なので JS から読めない。`SameSite=Lax` / `Secure`（本番）。
 *   - 発行は `POST /api/auth/resolve`（Supabase のアクセストークンを検証した後）。
 *
 * 【`?u=` の扱い】**Cookie の本人が admin のときだけ**尊重する（サポート/デモ用の代理表示）。
 *   非 admin の `?u=` は**黙って無視**して本人の uid を使う。
 *
 * 【緊急時の逃げ道】env `ALLOW_UID_ENTRY=on` で従来の `?u=` 入場に戻せる（既定 off）。
 *   ローンチ直前の切替で締め出された場合の復旧用。**本番では off のままにすること。**
 */

import type { BridgeOrigin } from './supabase';
import type { APIContext, AstroGlobal } from 'astro';

/** Cookie 名。値は署名付きなので中身を書き換えても通らない。 */
export const VIEWER_COOKIE = 'welltect_v';

/** 有効期間（秒）。30 日。 */
const MAX_AGE_SEC = 30 * 24 * 60 * 60;

function env(name: string): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return p != null && p !== '' ? p : undefined;
}

/** 従来の `?u=` 入場を許すか（既定 off＝本番相当）。 */
export function uidEntryAllowed(): boolean {
  return (env('ALLOW_UID_ENTRY') ?? '').toLowerCase() === 'on';
}

/**
 * 署名鍵。
 *
 * `APP_SESSION_SECRET` があればそれを使う（ローテーション可能）。
 * 無ければ `SUPABASE_SERVICE_ROLE_KEY` から導出する — **サーバにしか無い秘密**であり、
 * これが無い環境では admin API も DB 書込も動かないため、追加の env 設定漏れで
 * 認証だけ静かに壊れる事故を避けられる。どちらも無ければ **null＝Cookie 発行も検証もしない**
 * （fail-closed。サインインできないことは気づけるが、誰でも入れる状態にはならない）。
 */
function secret(): string | null {
  return env('APP_SESSION_SECRET') ?? env('SUPABASE_SERVICE_ROLE_KEY') ?? null;
}

function b64url(bytes: ArrayBuffer): string {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(payload: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(payload)));
}

/** タイミング差で署名を推測されないように定数時間で比較する。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cookie に載せる署名付きトークンを作る。鍵が無ければ null。
 *
 * 【admin フラグを載せる理由】判定は**サインインのときに 1 回だけ**行う。
 * その場でしか**サーバで検証済みの email** が手に入らないため
 * (`sb.auth.getUser(accessToken)`)。判定結果をここに載せておけば、以後のページ表示で
 * 毎回 wellfort-site の管理者リストへ問い合わせずに済む。
 * **管理者リストから外れた場合は、次のサインイン (または Cookie の再発行) で反映される。**
 *
 * **改竄はできない** — payload に admin を含めて HMAC を取るので、`1` に書き換えると署名が合わない。
 */
export async function signViewer(
  uid: string,
  isAdmin = false,
  now = Date.now(),
  origin: BridgeOrigin = 'production',
): Promise<string | null> {
  const key = secret();
  if (!key || !UUID_RE.test(uid)) return null;
  const exp = Math.floor(now / 1000) + MAX_AGE_SEC;
  /*
   * **staging 由来のときだけ 5 分割にする。**
   *
   * production は従来どおり 4 分割 (`uid.exp.admin`) のままにして、
   * **既存の Cookie と発行物を 1 バイトも変えない**。staging は総合テスト用の
   * 一時的な経路なので、そちらにだけ印を足す。
   * 改竄不可 — origin も payload に含めて HMAC を取る。
   */
  const payload = origin === 'staging'
    ? `${uid.toLowerCase()}.${exp}.${isAdmin ? '1' : '0'}.s`
    : `${uid.toLowerCase()}.${exp}.${isAdmin ? '1' : '0'}`;
  return `${payload}.${await hmac(payload, key)}`;
}

/** 検証済みの閲覧者。`admin` は Cookie 発行時に email から判定した値。 */
export interface VerifiedViewer {
  uid: string;
  /** Cookie に admin フラグが載っていたか。**旧 3 分割の Cookie では false**。 */
  admin: boolean;
  /**
   * **admin フラグを持たない旧形式 (3 分割) の Cookie か。**
   *
   * 【なぜ要るか】Cookie は**サインイン時にしか発行されない** (`GoogleOneTap` は
   * サインインパネルが在るときだけ One Tap を出すので、既にサインイン済みなら
   * `/api/auth/resolve` は走らない)。有効期間は 30 日あるため、
   * **email 由来の admin 判定を入れても、既存の Cookie を持っている人には
   * 最大 30 日効かない** (実測 2026-08-30: 本番へ入れても報告書が空のままだった)。
   * → この印を見て**その場で発行し直す** (`GoogleOneTap` の自己修復)。
   */
  legacy: boolean;
  /**
   * **この閲覧者を解決した HP/EC 環境。**
   *
   * 総合テストは staging の EC で購入した人を本番の Web アプリで受けるため、
   * キット進捗が読む `app_bridge` の**接続先を人ごとに変える**必要がある。
   * `/api/auth/resolve` が解決に使った経路をそのまま Cookie に載せる。
   * **印が無い Cookie は production 扱い** (既定を staging にしない＝混線を作らない)。
   */
  origin: BridgeOrigin;
}

/**
 * 署名付きトークンを検証して uid を返す。不正・期限切れは null。
 *
 * **旧形式 (`uid.exp.sig` の 3 分割) も受ける。** 発行済みの Cookie を一斉に無効化すると
 * 全員がサインインし直しになるため。旧形式は `admin: false` で返り、
 * `resolveViewer` 側が uid リストで補う。
 */
export async function verifyViewer(token: string | undefined | null, now = Date.now()): Promise<VerifiedViewer | null> {
  const key = secret();
  if (!key || !token) return null;
  const parts = token.split('.');
  // 3=旧形式 / 4=admin つき / 5=admin + 環境印 (staging)
  if (parts.length < 3 || parts.length > 5) return null;

  const [uid, expRaw] = parts;
  const adminRaw = parts.length >= 4 ? parts[2] : null;
  const originRaw = parts.length === 5 ? parts[3] : null;
  const sig = parts[parts.length - 1];
  if (!UUID_RE.test(uid)) return null;
  if (adminRaw !== null && adminRaw !== '0' && adminRaw !== '1') return null;
  // **印は `s` だけ許す。** 未知の値は受け付けない (production へ落とさず拒否)。
  if (originRaw !== null && originRaw !== 's') return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp * 1000 < now) return null;

  const payload = adminRaw === null
    ? `${uid.toLowerCase()}.${expRaw}`
    : originRaw === null
      ? `${uid.toLowerCase()}.${expRaw}.${adminRaw}`
      : `${uid.toLowerCase()}.${expRaw}.${adminRaw}.${originRaw}`;
  const expected = await hmac(payload, key);
  if (!timingSafeEqual(sig, expected)) return null;
  return {
    uid: uid.toLowerCase(),
    admin: adminRaw === '1',
    legacy: adminRaw === null,
    origin: originRaw === 's' ? 'staging' : 'production',
  };
}

/** `Set-Cookie` に載せる属性。 */
export function viewerCookieOptions(): {
  httpOnly: true; secure: boolean; sameSite: 'lax'; path: string; maxAge: number;
} {
  return {
    httpOnly: true,
    // dev サーバは http なので Secure を付けると Cookie が保存されない。
    secure: import.meta.env.DEV !== true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SEC,
  };
}

export interface Viewer {
  /** 表示対象の diagnostic_user_id。未サインインなら null。 */
  uid: string | null;
  /** サインイン済み本人の uid（代理表示中でも本人のまま）。 */
  selfUid: string | null;
  /** 本人が admin か。デモ表示・デバッグ表示・admin 画面の可否に使う。 */
  isAdmin: boolean;
  /**
   * **何が根拠で admin になったか**。`null` は admin でない。
   *   `'cookie'` … サインイン時に **wellfort-site の管理者リスト**へ問い合わせて判定
   *
   * **「admin にならない」の原因切り分けのために持つ。** 判定は静かに外れるので、
   * 画面のデバッグ欄に根拠を出せないと「なぜダミーが出ないか」が誰にも分からない
   * (実測 2026-08-30: 本番で報告書が空になり、原因の特定に何往復もした)。
   */
  adminBy: 'cookie' | null;
  /** admin が `?u=` で他人を表示している状態か。 */
  impersonating: boolean;
  /**
   * **表示対象がどの HP/EC 環境で解決された人か。** キット進捗が読む `app_bridge` の
   * 接続先をこれで選ぶ。**印の無い Cookie は production**（既定を staging にしない）。
   * 代理表示 (`?u=`) 中は**表示対象ではなく Cookie の持ち主の印**が載る点に注意。
   */
  origin: BridgeOrigin;
  /**
   * **Cookie の admin フラグを取り直す必要があるか。**
   * `GoogleOneTap` がこれを見て `/api/auth/refresh-admin` を呼ぶ (自己修復)。
   *
   * 【2026-08-30・実測で拡張】以前は **旧 3 分割 Cookie のときだけ** true にしていた。
   * ところが `admin=0` の 4 分割 Cookie は「旧形式ではない」ので**自己修復が一度も
   * 走らず、admin に昇格できないまま最大 30 日固定**になる。
   * 実際にこれで管理者が admin を失った (uid 一覧による判定を撤去した際、
   * 既に `admin=0` の Cookie を持っていた人に回復手段が無かった)。
   * → **admin でないときは毎セッション 1 回だけ取り直す。**
   *   admin の人は取り直さない (既に true なので変化しない)。
   *   剥奪は次のサインイン時に反映される。
   */
  cookieStale: boolean;
}

const ANONYMOUS: Viewer = { uid: null, selfUid: null, isAdmin: false, adminBy: null, impersonating: false, cookieStale: false, origin: 'production' };

/**
 * リクエストから閲覧者を解決する。**すべてのユーザー向けページはこれを通すこと。**
 *
 * 優先順位:
 *   1. Cookie（署名検証済み）= 本人
 *   2. 本人が admin なら `?u=` を尊重（代理表示）
 *   3. `ALLOW_UID_ENTRY=on` のときだけ、従来どおり `?u=` を本人として扱う（緊急用）
 */
export async function resolveViewer(ctx: AstroGlobal | APIContext): Promise<Viewer> {
  const url = new URL(ctx.request.url);
  const requested = normalizeUid(url.searchParams.get('u'));

  const verified = await verifyViewer(ctx.cookies.get(VIEWER_COOKIE)?.value);

  if (!verified) {
    if (uidEntryAllowed() && requested) {
      /*
       * 緊急復旧用の `?u=` 入場。**admin は与えない** (2026-08-30)。
       * 以前はここで uid のベタ書き一覧と照合して admin にしていたが、
       * その一覧は撤去した (admin の正は wellfort-site の管理者リストだけ)。
       * URL に uid を書くだけで admin になれる経路を残さない。
       */
      return { uid: requested, selfUid: requested, isAdmin: false, adminBy: null, impersonating: false, cookieStale: false, origin: 'production' };
    }
    return ANONYMOUS;
  }
  const selfUid = verified.uid;

  /*
   * **admin の成立経路は Cookie の admin フラグ 1 本だけ** (2026-08-30)。
   * そのフラグはサインイン時に、**wellfort-site の管理者リスト (`admin_users`)** へ
   * 問い合わせて載せる (`api/auth/resolve.ts` → `isAdminEmailAsync`)。
   * uid のベタ書き一覧による判定は撤去した — 管理者リストから外しても admin のまま、
   * という**権限剥奪の効かない**状態を作っていたため。
   */
  const adminBy: Viewer['adminBy'] = verified.admin ? 'cookie' : null;
  const isAdmin = adminBy !== null;
  if (isAdmin && requested && requested !== selfUid) {
    return { uid: requested, selfUid, isAdmin, adminBy, impersonating: true, cookieStale: verified.legacy || !isAdmin, origin: verified.origin };
  }
  return { uid: selfUid, selfUid, isAdmin, adminBy, impersonating: false, cookieStale: verified.legacy || !isAdmin, origin: verified.origin };
}

/** `?u=` の短縮形（先頭8桁）も従来どおり受ける。 */
export function normalizeUid(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim().toLowerCase();
  if (!t) return null;
  if (UUID_RE.test(t)) return t;
  const m = /^([0-9a-f]{8})$/.exec(t);
  return m ? `${m[1]}-0000-0000-0000-000000000000` : null;
}
