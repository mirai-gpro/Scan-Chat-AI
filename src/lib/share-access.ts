/**
 * **Welltect セキュア共有閲覧（External Share）の本体。**
 * 正本: `docs/specs/secure_shared_access_and_admin_impersonation_spec_20260930.md` §14〜§18 / §26 / §27。
 *
 * 【コンセプト】「**URL で開くだけ。なのに、ID・パスワード方式より安全で簡単。**」（§3）
 * **外部閲覧者に Google / Microsoft / Welltect のアカウント発行を求めない。**
 * 共通 ID・パスワードは採らない — 誰が入ったか分からず、部分失効もできないため（§2）。
 *
 * 【三段構え】Admin 代理表示（`admin-impersonation.ts`）とよく似た形だが**別物**。
 *
 *   share link (raw token・URL で配る・期限は発行時に設定)
 *     → pending (Cookie・10 分・同意画面を読む時間)
 *       → share session (Cookie・link の期限を超えない)
 *
 * 【絶対に守ること】
 *   - **raw token / raw session / raw IP は DB に 1 列も保存しない**（digest だけ）。
 *   - **`target_uid` を Cookie にも URL にも入れない。** 解決は毎回 DB。
 *   - **毎リクエストで link 側の status / starts_at / expires_at を見る**（§27.1）。
 *     セッションだけ見ると **revoke が効かない**。
 *   - **不一致と不存在を区別できる応答を返さない**（§16.3）。
 */

import { getServerSupabase, type BridgeOrigin } from './supabase';

/** pending（同意前）の寿命（秒）。同意画面を読む時間。 */
export const SHARE_PENDING_TTL_SEC = 10 * 60;
/** 共有セッションの既定の寿命（秒）。**link の期限を超えない**（§18.1）。 */
export const SHARE_SESSION_TTL_SEC = 8 * 60 * 60;

export const SHARE_PENDING_COOKIE = 'welltect_share_pending';
export const SHARE_COOKIE = 'welltect_share_v';
/** 匿名 viewer の相関 ID。**本人確認には使わない**（§31.1）。 */
export const SHARE_VIEWER_COOKIE = 'welltect_share_viewer';

/** token / session の字面。**base64url 以外は受けない。** */
export const SHARE_OPAQUE_RE = /^[A-Za-z0-9_-]{32,64}$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 32 byte CSPRNG → base64url（**256bit**・§14.2）。 */
export function randomShareToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256hex(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map((n) => n.toString(16).padStart(2, '0')).join('');
}

function env(name: string): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return p != null && p !== '' ? p : undefined;
}

/**
 * IP の HMAC（§32）。**素の sha256 にしない** — IPv4 は 2^32 なので総当たりで復元できる。
 * 鍵は `viewer.ts` と同じものを流用する（env を足さない）。取れなければ null（**記録しない**）。
 */
export async function ipHmac(ip: string | null | undefined): Promise<string | null> {
  const key = env('APP_SESSION_SECRET') ?? env('SUPABASE_SERVICE_ROLE_KEY');
  if (!key || !ip) return null;
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(`share_ip:v1:${ip}`));
  return Array.from(new Uint8Array(sig)).map((n) => n.toString(16).padStart(2, '0')).join('');
}

/** プロキシ越しの接続元。**raw は保存しない**（上の `ipHmac` に通す）。 */
export function clientIp(request: Request): string | null {
  const raw = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip');
  const first = raw?.split(',')[0]?.trim();
  return first || null;
}

/* ══════════════════════════════════════════════════════════════════════
 * 型
 * ════════════════════════════════════════════════════════════════════ */

/** §17.2。**`view` は閲覧だけ**を意味する。更新は `interview` / `scan` に限る。 */
export interface ShareScope {
  view: true;
  interview: boolean;
  scan: boolean;
}

export interface ShareLinkRow {
  id: string;
  target_uid: string;
  target_origin: string;
  label: string | null;
  purpose: string | null;
  starts_at: string | null;
  expires_at: string;
  status: string;
  scope: unknown;
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
  /** 論理削除（admin 一覧から隠すだけ・§33.2）。 */
  hidden_at: string | null;
}

export interface ResolvedShare {
  linkId: string;
  sessionId: string;
  targetUid: string;
  targetOrigin: BridgeOrigin;
  scope: ShareScope;
  /** 常設の帯に出す用途ラベル（§24.4）。**対象者の氏名ではない**。 */
  label: string | null;
  /** セッションの期限（link の期限を超えない）。 */
  expiresAt: string;
  viewerId: string | null;
}

/** jsonb をそのまま信じない。**既定は閲覧のみ**（未知の値で権限を広げない）。 */
export function normalizeScope(raw: unknown): ShareScope {
  const o = (raw ?? {}) as Record<string, unknown>;
  return { view: true, interview: o.interview === true, scan: o.scan === true };
}

/* ══════════════════════════════════════════════════════════════════════
 * DB（生成済みの型にまだ無い表なので、使う操作だけ構造的に宣言する）
 * `interview-completion.ts:57-59` と同じ流儀。
 * ════════════════════════════════════════════════════════════════════ */
type DbErr = { message: string } | null;
interface Filterable {
  eq(col: string, v: unknown): Filterable;
  is(col: string, v: unknown): Filterable;
  in(col: string, v: unknown[]): Filterable;
  order(col: string, o: { ascending: boolean }): Filterable;
  limit(n: number): Filterable;
  select(cols: string): Promise<{ data: Record<string, unknown>[] | null; error: DbErr }>;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: DbErr }>;
}
interface Table {
  select(cols: string): Filterable;
  insert(v: unknown): { select(cols: string): Promise<{ data: Record<string, unknown>[] | null; error: DbErr }> };
  update(v: unknown): Filterable;
}
interface DiagnosisSchema {
  from(t: string): Table;
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: DbErr }>;
}
function dg(sb: NonNullable<ReturnType<typeof getServerSupabase>>): DiagnosisSchema {
  return sb.schema('diagnosis') as unknown as DiagnosisSchema;
}

/* ══════════════════════════════════════════════════════════════════════
 * アクセスログ（§26）
 * ════════════════════════════════════════════════════════════════════ */

export type ShareEvent =
  | 'token_access' | 'consent'
  | 'dashboard_view' | 'report_view' | 'trend_view' | 'result_view' | 'kit_view' | 'notices_view'
  | 'chat_use' | 'scan_use'
  | 'expired' | 'revoked' | 'paused' | 'not_found'
  | 'blocked_admin_access' | 'target_tamper_attempt' | 'share_end';

/**
 * アクセス記録（PDF の「見える化」「アクセス記録確認」）。
 *
 * **raw token を書かない / path に UID を入れない / 中身は書かない**（§26.2）。
 * **投げない** — 記録の失敗で本体を止めない。
 */
export async function logShareEvent(args: {
  event: ShareEvent;
  request: Request;
  linkId?: string | null;
  sessionId?: string | null;
  viewerId?: string | null;
  path?: string | null;
}): Promise<void> {
  try {
    const sb = getServerSupabase();
    if (!sb) return;
    await dg(sb).from('shared_access_logs').insert({
      share_link_id: args.linkId ?? null,
      session_id: args.sessionId ?? null,
      viewer_id: args.viewerId ?? null,
      event_type: args.event,
      // **UID を含めない。** `/result/<artifact_id>` は artifact_id までに留める。
      path: (args.path ?? new URL(args.request.url).pathname).slice(0, 300),
      ip_hmac: await ipHmac(clientIp(args.request)),
      user_agent: (args.request.headers.get('user-agent') ?? '').slice(0, 300),
    }).select('id');
  } catch (e) {
    console.error('[share-access] ログ記録に失敗 (本体は継続):', e instanceof Error ? e.message : e);
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 発行（admin）
 * ════════════════════════════════════════════════════════════════════ */

export interface IssuedShareLink {
  id: string;
  /** **raw token。発行の瞬間だけ返る。DB にもログにも残らない**（§15.1）。 */
  token: string;
  expiresAt: string;
}

export async function createShareLink(args: {
  targetUid: string;
  expiresAt: string;
  startsAt?: string | null;
  label?: string | null;
  purpose?: string | null;
  scope?: Partial<ShareScope>;
  targetOrigin?: BridgeOrigin;
  /**
   * 発行した admin。**`adminIdentity()` の HMAC digest だけ**を渡す。
   * 生 email は**入れない**（`@` を含む値はここで捨てられる・§38-U9）。
   */
  createdBy?: string | null;
}): Promise<IssuedShareLink | null> {
  const sb = getServerSupabase();
  if (!sb || !UUID_RE.test(args.targetUid)) return null;
  if (!args.expiresAt || Number.isNaN(Date.parse(args.expiresAt))) return null;

  // **対象の実在確認**（存在しない uid で URL だけ出さない）。
  const { data: user } = await dg(sb).from('app_users')
    .select('diagnostic_user_id').eq('diagnostic_user_id', args.targetUid).maybeSingle();
  if (!user) return null;

  const token = randomShareToken();
  const scope = normalizeScope({ interview: args.scope?.interview ?? true, scan: args.scope?.scan ?? true });

  /*
   * **`created_by` に生 email を入れない**（migration のコメントどおり・2026-09-30）。
   *
   * 呼び出し側（`api/admin/share-links.ts`）が `adminIdentity()` の HMAC digest を渡すのが
   * 正しい使い方だが、**ここでも最後の関所を置く** — 将来別の呼び出し元が増えたときに
   * 静かに生 email が入るのを防ぐ。`@` を含む値は**捨てる**（切り詰めない・置き換えない）。
   */
  const createdBy = typeof args.createdBy === 'string' && !args.createdBy.includes('@')
    ? args.createdBy.slice(0, 200)
    : null;
  const { data, error } = await dg(sb).from('shared_access_links').insert({
    target_uid: args.targetUid,
    target_origin: args.targetOrigin ?? 'production',
    label: args.label ?? null,
    purpose: args.purpose ?? null,
    token_hash: await sha256hex(token),
    starts_at: args.startsAt ?? null,
    expires_at: args.expiresAt,
    scope,
    created_by: createdBy,
  }).select('id, expires_at');
  if (error || !data?.[0]) {
    // **raw token を絶対にログへ出さない。**
    console.error('[share-access] 共有リンクの発行に失敗:', error?.message);
    return null;
  }
  return { id: String(data[0].id), token, expiresAt: String(data[0].expires_at) };
}

const LINK_COLS =
  'id, target_uid, target_origin, label, purpose, starts_at, expires_at, status, scope, created_by, created_at, revoked_at, hidden_at';

/** 一覧（admin 画面用）。**token は復元できない**ので出さない。 */
export async function listShareLinks(targetUid?: string | null): Promise<ShareLinkRow[]> {
  const sb = getServerSupabase();
  if (!sb) return [];
  let q = dg(sb).from('shared_access_links').select(LINK_COLS);
  if (targetUid && UUID_RE.test(targetUid)) q = q.eq('target_uid', targetUid);
  const { data } = await q.order('created_at', { ascending: false }).limit(200).select(LINK_COLS);
  return (data ?? []) as unknown as ShareLinkRow[];
}

/** 一覧 + アクセス回数 / 最終アクセス（§33.2）。**token は含まない**。 */
export interface ShareLinkStatRow extends ShareLinkRow {
  access_count: number;
  last_access_at: string | null;
}

export async function listShareLinksWithStats(args?: {
  targetUid?: string | null;
  includeHidden?: boolean;
}): Promise<ShareLinkStatRow[]> {
  const rows = await listShareLinks(args?.targetUid ?? null);
  const visible = args?.includeHidden ? rows : rows.filter((r) => !r.hidden_at);
  if (visible.length === 0) return [];

  const sb = getServerSupabase();
  if (!sb) return visible.map((r) => ({ ...r, access_count: 0, last_access_at: null }));

  /*
   * **回数は「閲覧系のイベント」で数える**。`token_access` / `consent` まで足すと
   * 「1 回しか開いていないのに 3」になり、admin が実態を読み違える。
   */
  const { data } = await dg(sb).from('shared_access_logs')
    .select('share_link_id, event_type, created_at')
    .in('share_link_id', visible.map((r) => r.id))
    .order('created_at', { ascending: false })
    .limit(5000)
    .select('share_link_id, event_type, created_at');

  const stat = new Map<string, { n: number; last: string | null }>();
  for (const l of (data ?? [])) {
    const id = String(l.share_link_id ?? '');
    if (!id) continue;
    const cur = stat.get(id) ?? { n: 0, last: null };
    if (String(l.event_type ?? '').endsWith('_view') || String(l.event_type ?? '').endsWith('_use')) cur.n += 1;
    const at = String(l.created_at ?? '');
    if (at && (cur.last === null || at > cur.last)) cur.last = at;
    stat.set(id, cur);
  }
  return visible.map((r) => ({
    ...r,
    access_count: stat.get(r.id)?.n ?? 0,
    last_access_at: stat.get(r.id)?.last ?? null,
  }));
}

/** link 単位のアクセスログ（§33.2）。**raw token も UID も入っていない**。 */
export async function listShareLogs(linkId: string, limit = 200): Promise<Record<string, unknown>[]> {
  const sb = getServerSupabase();
  if (!sb || !UUID_RE.test(linkId)) return [];
  const { data } = await dg(sb).from('shared_access_logs')
    .select('id, event_type, path, user_agent, created_at')
    .eq('share_link_id', linkId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 500))
    .select('id, event_type, path, user_agent, created_at');
  return data ?? [];
}

/**
 * **論理削除 / 復帰**（§33.2）。一覧から隠すだけで**アクセス可否は変えない**。
 * **ログは消さない** — 「誰がいつ見たか」は共有機能の売りなので残す。
 */
export async function setShareLinkHidden(id: string, hidden: boolean): Promise<boolean> {
  const sb = getServerSupabase();
  if (!sb || !UUID_RE.test(id)) return false;
  const { data, error } = await dg(sb).from('shared_access_links')
    .update({ hidden_at: hidden ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
    .eq('id', id).select('id');
  // ★ **`revoked` でも可**（アクセス可否ではなく一覧の見え方）。ただし
  //   存在しない id を成功として返さない（実際に 1 行動いたことを確かめる）。
  return !error && Array.isArray(data) && data.length === 1;
}

/**
 * **状態遷移の許可表**（§27.2）。**`revoked` からはどこへも動かない = 不可逆。**
 *
 * 【なぜ表で持つか】`status` を素のまま代入すると、**admin API に
 * `{ resume: "<revoked な id>" }` を直接投げるだけで `active` に戻せる**。
 * `linkUsable()` は `status` を見るので、**失効させた URL が再び開くようになる**
 * （2026-09-30 のレビューで指摘）。UI でボタンを消すだけでは防げないので、
 * **どの状態から呼ばれたかを UPDATE の WHERE 条件に入れて DB で固定する。**
 *
 * `hide` / `unhide` / ログ閲覧は `revoked` でも可 —
 * あれはアクセス可否ではなく admin の一覧の見え方の話（§33.2）。
 */
const STATUS_TRANSITIONS: Record<'active' | 'paused' | 'revoked', ('active' | 'paused' | 'revoked')[]> = {
  // 遷移先 → そこへ動いてよい「現在の状態」
  active: ['paused'],              // resume は paused からだけ
  paused: ['active'],              // pause は active からだけ
  revoked: ['active', 'paused'],   // revoke は生きているものだけ（2 度目は 0 行）
};

/**
 * `pause` / `resume` / `revoke`（§27.2）。
 *
 * **「実際に 1 行だけ更新された」ことを確かめる。** `error == null` は
 * 「SQL が通った」だけで、**0 行でも成功に見える**（存在しない id・許されない遷移）。
 */
export async function setShareLinkStatus(id: string, status: 'active' | 'paused' | 'revoked'): Promise<boolean> {
  const sb = getServerSupabase();
  if (!sb || !UUID_RE.test(id)) return false;
  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (status === 'revoked') patch.revoked_at = new Date().toISOString();

  const { data, error } = await dg(sb).from('shared_access_links')
    .update(patch)
    .eq('id', id)
    // ★ ここが不可逆性の本体。`revoked` は許可表のどの行にも現れない。
    .in('status', STATUS_TRANSITIONS[status])
    .select('id, status');
  // ★ 0 行 = 存在しない id か、許されない遷移。**成功として扱わない。**
  if (error || !Array.isArray(data) || data.length !== 1) return false;

  // **revoke / pause はそのリンクの全セッションも落とす**（§27.2）。
  if (status !== 'active') await revokeSessionsOfLink(id);
  return true;
}

async function revokeSessionsOfLink(linkId: string): Promise<void> {
  const sb = getServerSupabase();
  if (!sb) return;
  await dg(sb).from('shared_access_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('share_link_id', linkId).is('revoked_at', null).select('id');
}

/**
 * URL 再発行（§27.2）。**新 token を発行し、旧 token_hash を失効させ、旧セッションも全部落とす。**
 * 「さっきの URL をもう一度」に応えられないのは hash-only の帰結で、**むしろ正しい**（§15.3）。
 *
 * 【`revoked` からは再発行できない】ここが一番危ない口だった —
 * `status='active'` / `revoked_at=null` を**無条件に**書いていたので、
 * **失効させたリンクを admin API 1 回で復活させられた**（2026-09-30 のレビュー）。
 * 生きているもの（`active` / `paused`）だけを WHERE 条件で通す。
 */
export async function regenerateShareLink(id: string): Promise<{ token: string } | null> {
  const sb = getServerSupabase();
  if (!sb || !UUID_RE.test(id)) return null;
  const token = randomShareToken();
  const { data, error } = await dg(sb).from('shared_access_links').update({
    token_hash: await sha256hex(token),
    status: 'active',
    updated_at: new Date().toISOString(),
    // ★ `revoked_at = null` を書かない。**失効の事実を消さない**（不可逆性の記録）。
  })
    .eq('id', id)
    .in('status', ['active', 'paused'])   // ★ revoked からは再発行できない
    .select('id, status');
  // ★ 0 行 = 存在しない id か revoked。**成功として扱わない。**
  if (error || !Array.isArray(data) || data.length !== 1) return null;
  await revokeSessionsOfLink(id);   // 旧 URL で入っている人を切る
  return { token };
}

/* ══════════════════════════════════════════════════════════════════════
 * 入場（`/share/<token>` → pending → 同意 → session）
 * ════════════════════════════════════════════════════════════════════ */

/** §27.1 の「毎リクエストで見るもの」のうち、link 側。 */
function linkUsable(row: Record<string, unknown>, now: number): boolean {
  /*
   * **`revoked_at` も見る**（2026-09-30 のレビュー）。
   * `status` だけを見ていると、**将来誰かが `status` を書き戻せる経路を作った瞬間に
   * 失効が黙って解ける**。失効は `revoked_at` に残る事実なので、そこも番人にする
   * （`setShareLinkStatus` / `regenerateShareLink` の遷移表と**二重**に閉じる）。
   */
  if (row.revoked_at) return false;
  if (row.status !== 'active') return false;
  const starts = row.starts_at ? Date.parse(String(row.starts_at)) : null;
  if (starts !== null && !Number.isNaN(starts) && starts > now) return false;
  const exp = Date.parse(String(row.expires_at ?? ''));
  return Number.isFinite(exp) && exp > now;
}

/**
 * raw token → pending セッション。
 *
 * **同意前に健康情報を出さない**ため、ここではダッシュボードを出さず pending だけ作る（§16.1）。
 * **raw token を通常画面へ持ち回らない** — 以後は Cookie の opaque な札で引く。
 *
 * @returns pending Cookie に入れる raw。**理由は区別しない**（§16.3）。
 */
export async function startShareFromToken(rawToken: string, now = Date.now()): Promise<
  { pending: string; linkId: string } | null
> {
  const sb = getServerSupabase();
  if (!sb || !SHARE_OPAQUE_RE.test(rawToken)) return null;

  const { data: link } = await dg(sb).from('shared_access_links')
    .select('id, expires_at, starts_at, status, revoked_at')
    .eq('token_hash', await sha256hex(rawToken))
    .maybeSingle();
  if (!link || !linkUsable(link, now)) return null;

  const pending = randomShareToken();
  const linkExp = Date.parse(String(link.expires_at));
  // pending も **link の期限を超えない**。
  const exp = new Date(Math.min(now + SHARE_PENDING_TTL_SEC * 1000, linkExp)).toISOString();
  const { error } = await dg(sb).from('shared_access_sessions').insert({
    share_link_id: link.id,
    session_digest: await sha256hex(pending),
    expires_at: exp,
  }).select('id');
  if (error) return null;
  return { pending, linkId: String(link.id) };
}

/** 同意画面に出す情報。**対象者の氏名は出さない**（PII を共有相手へ渡さない・§17.1 未確定 U3）。 */
export interface SharePendingInfo {
  linkId: string;
  sessionId: string;
  scope: ShareScope;
  label: string | null;
}

export async function readSharePending(pending: string, now = Date.now()): Promise<SharePendingInfo | null> {
  const sb = getServerSupabase();
  if (!sb || !SHARE_OPAQUE_RE.test(pending)) return null;
  const { data: s } = await dg(sb).from('shared_access_sessions')
    .select('id, share_link_id, consented_at, expires_at, revoked_at')
    .eq('session_digest', await sha256hex(pending))
    .maybeSingle();
  if (!s || s.consented_at || s.revoked_at) return null;
  if (!(Date.parse(String(s.expires_at)) > now)) return null;

  const { data: link } = await dg(sb).from('shared_access_links')
    .select('id, label, scope, status, starts_at, expires_at, revoked_at')
    .eq('id', s.share_link_id).maybeSingle();
  if (!link || !linkUsable(link, now)) return null;

  return {
    linkId: String(link.id),
    sessionId: String(s.id),
    scope: normalizeScope(link.scope),
    label: link.label ? String(link.label) : null,
  };
}

/**
 * 同意 → 共有セッション発行（§18.3）。
 *
 * **DB の RPC 1 文で原子的に行う**（`consume_share_pending`・migration `20260930000030`）。
 * アプリ側で read → update と 2 往復すると、**同じ pending で同時に 2 回 POST された時に
 * 両方成功し得る**（どちらも「読んだ時は未同意だった」ため）。そうなると共有セッションが
 * 2 つでき、**片方を revoke しても他方が生き残る**。Admin 代理表示の `consume_admin_handoff`
 * と同じ規律（§7 / §31 T-5）。
 *
 * **pending の値を昇格させない**（session fixation）。**link の期限を超えない**（§18.1）。
 *
 * @returns `null` = 不存在 / 同意済 / 失効 / link 停止。**区別しない**（§16.3）。
 */
export async function consumeSharePending(
  pending: string,
  viewerId: string | null,
): Promise<{ session: string; linkId: string; targetUid: string; expiresAt: string } | null> {
  const sb = getServerSupabase();
  if (!sb || !SHARE_OPAQUE_RE.test(pending)) return null;

  const session = randomShareToken();
  const { data, error } = await dg(sb).rpc('consume_share_pending', {
    p_pending_digest: await sha256hex(pending),
    p_session_digest: await sha256hex(session),
    p_viewer_id: viewerId,
    p_session_ttl_sec: SHARE_SESSION_TTL_SEC,
  });
  if (error) {
    console.error('[share-access] 同意の確定に失敗:', error.message);
    return null;
  }

  /*
   * **「ちょうど 1 行」を確かめる**（§7）。0 行 = 二重 POST の 2 本目か失効。
   * 2 行以上は起こり得ないが、起きたら**成功として扱わない**
   * （どれを Cookie に載せたのか分からない状態で通すほうが危険）。
   */
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  if (rows.length !== 1) return null;

  return {
    session,
    linkId: String(rows[0].link_id),
    targetUid: String(rows[0].target_uid),
    expiresAt: String(rows[0].expires_at),
  };
}

/**
 * **毎リクエストの解決**（§18.2 / §27.1）。
 *
 * **link 側の status / starts_at / expires_at を必ず見る。**
 * セッションだけを見ると **revoke / pause が効かない**。
 */
export async function resolveShareSession(sessionRaw: string, now = Date.now()): Promise<ResolvedShare | null> {
  const sb = getServerSupabase();
  if (!sb || !SHARE_OPAQUE_RE.test(sessionRaw)) return null;

  const { data: s } = await dg(sb).from('shared_access_sessions')
    .select('id, share_link_id, viewer_id, consented_at, expires_at, revoked_at')
    .eq('session_digest', await sha256hex(sessionRaw))
    .maybeSingle();
  if (!s || !s.consented_at || s.revoked_at) return null;          // 同意前・失効は通さない
  if (!(Date.parse(String(s.expires_at)) > now)) return null;

  const { data: link } = await dg(sb).from('shared_access_links')
    .select('id, target_uid, target_origin, scope, label, status, starts_at, expires_at, revoked_at')
    .eq('id', s.share_link_id).maybeSingle();
  if (!link || !linkUsable(link, now)) return null;                // ★ ここが revoke を効かせる

  return {
    linkId: String(link.id),
    sessionId: String(s.id),
    targetUid: String(link.target_uid),
    targetOrigin: link.target_origin === 'staging' ? 'staging' : 'production',
    scope: normalizeScope(link.scope),
    label: link.label ? String(link.label) : null,
    expiresAt: String(s.expires_at),
    viewerId: s.viewer_id ? String(s.viewer_id) : null,
  };
}

/**
 * **失効の理由を「ログのためだけに」判別する**（§26.1 の `expired` / `revoked` / `paused`）。
 *
 * **応答には絶対に出さない。** 画面は理由を区別せず `/share/unavailable` 一択（§16.3）で、
 * 区別できる応答を返すと **URL の総当たりで「存在するが停止中」を炙り出せる**。
 * ここで分かるのはサーバ側のログだけ。
 */
export async function classifyShareFailure(
  sessionRaw: string, now = Date.now(),
): Promise<'expired' | 'revoked' | 'paused' | null> {
  try {
    const sb = getServerSupabase();
    if (!sb || !SHARE_OPAQUE_RE.test(sessionRaw)) return null;
    const { data: s } = await dg(sb).from('shared_access_sessions')
      .select('share_link_id, consented_at, expires_at, revoked_at')
      .eq('session_digest', await sha256hex(sessionRaw)).maybeSingle();
    if (!s) return null;                                  // そもそも知らない札（記録しない）
    if (s.revoked_at) return 'revoked';
    if (!(Date.parse(String(s.expires_at)) > now)) return 'expired';

    const { data: link } = await dg(sb).from('shared_access_links')
      .select('status, starts_at, expires_at, revoked_at').eq('id', s.share_link_id).maybeSingle();
    if (!link) return 'revoked';
    if (link.status === 'revoked') return 'revoked';
    if (link.status === 'paused') return 'paused';
    if (!(Date.parse(String(link.expires_at)) > now)) return 'expired';
    return null;
  } catch {
    return null;   // 記録の都合で本体を止めない
  }
}

/** 共有の終了（§17.5）。**`welltect_share_v` だけを失効させる。** */
export async function endShareSession(sessionRaw: string): Promise<boolean> {
  const sb = getServerSupabase();
  if (!sb || !SHARE_OPAQUE_RE.test(sessionRaw)) return false;
  const { error } = await dg(sb).from('shared_access_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('session_digest', await sha256hex(sessionRaw)).select('id');
  return !error;
}

/** `last_seen_at` の更新。**投げない**（本体を止めない）。 */
export async function touchShareSession(sessionId: string): Promise<void> {
  try {
    const sb = getServerSupabase();
    if (!sb) return;
    await dg(sb).from('shared_access_sessions')
      .update({ last_seen_at: new Date().toISOString() }).eq('id', sessionId).select('id');
  } catch { /* 記録の失敗で画面を止めない */ }
}
