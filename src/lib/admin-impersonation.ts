/**
 * **Admin 代理表示（UID-less）の本体。**
 * 正本: `docs/specs/secure_shared_access_and_admin_impersonation_spec_20260930.md` §12 / §13。
 *
 * 【何を解決するか】現在 Wellfort Admin は `{SCAN_APP_BASE}/dashboard?u=<diagnostic_user_id>` で
 * 顧客の画面を開いている。**対象者の uid が admin のブラウザ履歴・Referer・画面共有に残る。**
 * これを **URL path の opaque な view-context** へ置き換える。
 *
 * 【三段構え】
 *   handoff (raw token・60 秒・single-use)
 *     → pending (Cookie・10 分・Admin ログイン待ち)
 *       → context (URL path・60 分・`/admin-view/<ctx>/…`)
 *
 * 【絶対に守ること】
 *   - **raw token / raw context / 生 email は DB に 1 列も保存しない**（digest だけ）。
 *   - **GET では状態を変えない**（claim は `POST /api/admin/handoff/claim` だけ）。
 *   - **状態遷移は全部 DB 側の条件付き UPDATE**（`read → +1 → write` をしない）。
 *   - **context 単体では何の権限も生まない**。`welltect_admin_v` の admin 本人と
 *     一致して初めて解決する（§12.4.1 の「毎リクエスト」）。
 */

import { getServerSupabase, type BridgeOrigin } from './supabase';

/** context の寿命（秒）。`welltect_v` の 30 日に合わせない（§27.4）。 */
export const CONTEXT_TTL_SEC = 60 * 60;
/** pending（Admin ログイン待ち）の寿命（秒）。 */
export const PENDING_TTL_SEC = 10 * 60;
/** raw handoff token の寿命（ミリ秒）。**pending へ交換するまで**の TTL。 */
export const HANDOFF_TTL_MS = 60 * 1000;
/**
 * 本人照合の失敗をこの回数まで許す（§12.8・**U25 は 5 回で確定**）。
 *
 * いちばん多い失敗は「個人の Google でサインインしていた」。1 回の試行に
 * Google のサインインが挟まるので 5 回は十分に多い。
 */
export const MAX_PENDING_ATTEMPTS = 5;

/** pending Cookie 名。**opaque な札**であって権限ではない。 */
export const HANDOFF_PENDING_COOKIE = 'welltect_handoff_pending';

/** 代理表示の URL prefix。ここ以外にベタ書きしない。 */
export const ADMIN_VIEW_PREFIX = '/admin-view';


/*
 * **生成済みの型 (`src/types/supabase.ts`) にまだ無い表を触るための最小の口。**
 *
 * `interview-completion.ts:57-59` と同じ流儀 — 型定義の再生成を待たずに進めるため、
 * **使う操作だけ**を構造的に宣言して `unknown` 経由で当てる。
 * `as any` にしないのは、列名やメソッドの打ち間違いをここで止めるため。
 */
type DbErr = { message: string } | null;
interface Filterable {
  eq(col: string, v: unknown): Filterable;
  is(col: string, v: unknown): Filterable;
  select(cols: string): Promise<{ data: Record<string, unknown>[] | null; error: DbErr }>;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: DbErr }>;
}
interface Table {
  select(cols: string): Filterable;   // select は Filterable を返す (そこから eq で絞る)
  insert(v: unknown): Promise<{ error: DbErr }>;
  update(v: unknown): Filterable;
}
interface DiagnosisSchema {
  from(t: string): Table;
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: DbErr }>;
}
function dg(sb: NonNullable<ReturnType<typeof getServerSupabase>>): DiagnosisSchema {
  return sb.schema('diagnosis') as unknown as DiagnosisSchema;
}

/** 32 byte CSPRNG → base64url（256bit）。**連番にも時刻由来にもしない。** */
export function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `sha256(raw)` の hex。**DB にはこれしか入らない。** */
export async function sha256hex(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map((n) => n.toString(16).padStart(2, '0')).join('');
}

/**
 * token / context の字面。**base64url だけ許す。**
 * ここを緩めると `..` や `/` が混じって path を抜けられる。
 */
export const OPAQUE_RE = /^[A-Za-z0-9_-]{32,64}$/;

/** UUID の字面（`viewer.ts` と同じ）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HandoffIssued {
  /** **raw token。応答で 1 度だけ返す。DB にもログにも残さない。** */
  token: string;
  expiresAt: string;
}

/**
 * handoff を発行する。**呼べるのは `ADMIN_API_KEY` を持つ中継だけ**（§12.1）。
 *
 * `adminEmail` は wellfort-site の `verifyAdmin()` が Supabase で検証した値。
 * **受けた直後に HMAC へ落とし、以後 digest しか扱わない。**
 */
export async function createHandoff(args: {
  targetUid: string;
  adminIdentity: string;
  targetOrigin: BridgeOrigin;
  now?: number;
}): Promise<HandoffIssued | null> {
  const sb = getServerSupabase();
  if (!sb || !UUID_RE.test(args.targetUid) || !args.adminIdentity) return null;

  // **対象の実在確認**（存在しない uid で券だけ出さない）。
  const { data: user } = await dg(sb)
    .from('app_users')
    .select('diagnostic_user_id')
    .eq('diagnostic_user_id', args.targetUid)
    .maybeSingle();
  if (!user) return null;

  const token = randomToken();
  const expiresAt = new Date((args.now ?? Date.now()) + HANDOFF_TTL_MS).toISOString();
  const { error } = await dg(sb)
    .from('admin_impersonation_handoffs')
    .insert({
      token_hash: await sha256hex(token),
      admin_identity: args.adminIdentity,
      target_uid: args.targetUid,
      target_origin: args.targetOrigin,
      expires_at: expiresAt,
    });
  if (error) {
    // **raw token を絶対にログへ出さない。**
    console.error('[admin-impersonation] handoff の発行に失敗:', error.message);
    return null;
  }
  return { token, expiresAt };
}

/**
 * **claim**: raw token を pending へ**原子的に**交換する（§12.8 ①）。
 *
 * **GET から呼ばない。** `POST /api/admin/handoff/claim` だけが呼ぶ。
 * 成功したら **raw token はここで死ぬ**（`pending_digest is null` が排他条件）。
 *
 * @returns pending Cookie に入れる raw な札。失敗は null（理由は区別しない）。
 */
export async function claimHandoff(rawToken: string): Promise<string | null> {
  const sb = getServerSupabase();
  if (!sb || !OPAQUE_RE.test(rawToken)) return null;
  const pending = randomToken();
  const { data, error } = await dg(sb).rpc('claim_admin_handoff', {
    p_token_hash: await sha256hex(rawToken),
    p_pending_digest: await sha256hex(pending),
    p_pending_ttl_sec: PENDING_TTL_SEC,
  });
  if (error) {
    console.error('[admin-impersonation] claim に失敗:', error.message);
    return null;
  }
  const rows = (data ?? []) as unknown[];
  return rows.length === 1 ? pending : null;
}

/** 本人照合の失敗を**原子的に** +1 する（5 回で pending を失効させる）。 */
export async function failPendingAttempt(pending: string): Promise<{ attempts: number; exhausted: boolean }> {
  const sb = getServerSupabase();
  if (!sb || !OPAQUE_RE.test(pending)) return { attempts: 0, exhausted: true };
  const { data, error } = await dg(sb).rpc('fail_admin_handoff_attempt', {
    p_pending_digest: await sha256hex(pending),
    p_max_attempts: MAX_PENDING_ATTEMPTS,
  });
  if (error) return { attempts: 0, exhausted: true };
  const row = ((data ?? []) as { attempts?: number; exhausted?: boolean }[])[0];
  return { attempts: row?.attempts ?? 0, exhausted: row?.exhausted !== false };
}

export interface ConsumedContext {
  /** **raw context。URL path にしか出さない。DB は sha256 だけ持つ。** */
  ctx: string;
  targetUid: string;
  targetOrigin: BridgeOrigin;
  expiresAt: string;
}

/**
 * **consume + context 発行を 1 トランザクションで行う**（§12.8 ②③・DB 関数側で担保）。
 *
 * `adminIdentity` が handoff 行と一致しなければ **0 行**（= handoff を焼かずに再試行できる）。
 * context の INSERT が落ちれば `consumed_at` も一緒に ROLLBACK される。
 */
export async function consumeHandoff(pending: string, adminIdentity: string): Promise<ConsumedContext | null> {
  const sb = getServerSupabase();
  if (!sb || !OPAQUE_RE.test(pending) || !adminIdentity) return null;
  const ctx = randomToken();
  const { data, error } = await dg(sb).rpc('consume_admin_handoff', {
    p_pending_digest: await sha256hex(pending),
    p_admin_identity: adminIdentity,
    p_session_digest: await sha256hex(ctx),
    p_session_ttl_sec: CONTEXT_TTL_SEC,
  });
  if (error) {
    console.error('[admin-impersonation] consume に失敗:', error.message);
    return null;
  }
  const row = ((data ?? []) as { target_uid?: string; target_origin?: string; expires_at?: string }[])[0];
  if (!row?.target_uid) return null;
  return {
    ctx,
    targetUid: row.target_uid,
    targetOrigin: row.target_origin === 'staging' ? 'staging' : 'production',
    expiresAt: row.expires_at ?? '',
  };
}

export interface ImpersonationContext {
  ctx: string;
  targetUid: string;
  targetOrigin: BridgeOrigin;
  expiresAt: string;
}

/**
 * **毎リクエストの解決**（§12.4.1「毎リクエスト」・§13.2）。
 *
 * `sha256(ctx)` で行を引き、**`admin_identity` が呼び出し元の admin 本人と一致する**ことを
 * 要求する。**`isAdmin === true` の一致だけでは通さない** — それだと
 * **別の admin が URL を拾っただけで開ける**。
 *
 * 期限切れ / revoked / 不一致 は全部 null（理由を区別しない）。
 */
export async function resolveImpersonationContext(
  ctx: string,
  adminIdentity: string | null,
  now = Date.now(),
): Promise<ImpersonationContext | null> {
  const sb = getServerSupabase();
  if (!sb || !adminIdentity || !OPAQUE_RE.test(ctx)) return null;
  const { data, error } = await dg(sb)
    .from('admin_impersonation_sessions')
    .select('admin_identity, target_uid, target_origin, expires_at, revoked_at')
    .eq('session_digest', await sha256hex(ctx))
    .maybeSingle();
  if (error || !data) return null;
  const expiresAt = typeof data.expires_at === 'string' ? data.expires_at : '';
  if (data.admin_identity !== adminIdentity) return null;
  if (data.revoked_at) return null;
  if (!expiresAt || Date.parse(expiresAt) <= now) return null;
  return {
    ctx,
    targetUid: String(data.target_uid),
    targetOrigin: data.target_origin === 'staging' ? 'staging' : 'production',
    expiresAt,
  };
}

/**
 * 代理表示を終える。**その context だけ**（他のタブの別顧客は生き続ける・§13.3）。
 * `all` なら同じ admin の代理表示を全部落とす（席を離れるとき）。
 */
export async function revokeImpersonation(args: {
  adminIdentity: string;
  ctx?: string | null;
  all?: boolean;
}): Promise<number> {
  const sb = getServerSupabase();
  if (!sb || !args.adminIdentity) return 0;
  let q = dg(sb)
    .from('admin_impersonation_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('admin_identity', args.adminIdentity)   // ★ 他人の代理表示は落とせない
    .is('revoked_at', null);
  if (!args.all) {
    if (!args.ctx || !OPAQUE_RE.test(args.ctx)) return 0;
    q = q.eq('session_digest', await sha256hex(args.ctx));
  }
  const { data, error } = await q.select('id');
  if (error) return 0;
  return (data ?? []).length;
}

/** `/admin-view/<ctx>/<rest>` を分解する。**base64url 以外は受けない。** */
export function parseAdminViewPath(pathname: string): { ctx: string; rest: string } | null {
  if (!pathname.startsWith(`${ADMIN_VIEW_PREFIX}/`)) return null;
  const tail = pathname.slice(ADMIN_VIEW_PREFIX.length + 1);
  const slash = tail.indexOf('/');
  const ctx = slash < 0 ? tail : tail.slice(0, slash);
  const rest = slash < 0 ? '' : tail.slice(slash);
  if (!OPAQUE_RE.test(ctx)) return null;
  // **`..` を含む rest は受けない**（rewrite 先を外へ逃がさない）。
  if (rest.includes('..')) return null;
  return { ctx, rest: rest === '' || rest === '/' ? '/dashboard' : rest };
}
