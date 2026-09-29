-- Admin 代理表示の UID-less 化 (handoff → pending → context)。
-- 正本: docs/specs/secure_shared_access_and_admin_impersonation_spec_20260930.md §12 / §13 / §22
--
-- 【なぜ要るか】現在 Wellfort Admin は
--   {SCAN_APP_BASE}/dashboard?u=<diagnostic_user_id>
-- で対象顧客の画面を開いている (wellfort-site admin/customers.astro:438)。
-- 対象者の uid が admin のブラウザ履歴・Referer・画面共有に残る。
-- これを **URL path の opaque な view-context** へ置き換える。
--
-- 【非 PII】このスキーマに入るのは
--   ・digest (sha256 / HMAC) … 生の token も生の email も入らない
--   ・diagnostic_user_id     … 非 PII (CLAUDE.md「PII / データ分離」)
-- **生の raw token / raw context / 生 email は 1 列も保存しない。**
--
-- 【RLS】**service_role 以外に権限を出さない。**
-- 既存の dev_read_all (`using (true)`) をここへ広げると、
-- token_hash / session_digest が anon で読めてしまい、**共有 URL の総当たりが不要になる**
-- (仕様書 §22.6)。この 2 表だけは最初から本番相当で閉じる。

-- ════════════════════════════════════════════════════════════════════
-- 1. handoff (60 秒・single-use。pending への交換までが TTL)
-- ════════════════════════════════════════════════════════════════════
create table if not exists diagnosis.admin_impersonation_handoffs (
  id                 uuid primary key default gen_random_uuid(),

  -- sha256(raw handoff token)。**raw は保存しない。**
  token_hash         text not null unique,

  -- base64url(HMAC-SHA256(APP_SESSION_SECRET, 'admin_identity:v1:' || lower(trim(email))))
  -- **発行した admin が誰か**。消費時に welltect_admin_v の値と一致することを要求する。
  -- **生 email は入らない。**
  admin_identity     text not null,

  -- 代理表示の対象。**URL にも Cookie にも出さない。ここだけが持つ。**
  target_uid         uuid not null references diagnosis.app_users(diagnostic_user_id),
  target_origin      text not null default 'production'
                       check (target_origin in ('production','staging')),

  -- raw token の寿命 (60 秒)。**pending へ交換するまで**の TTL。
  expires_at         timestamptz not null,

  -- pending (Admin ログイン待ち)。claim で原子的に埋める。
  -- **pending_digest is null を条件にした UPDATE** が「1 handoff = 1 pending」を保証する。
  pending_digest     text unique,
  pending_expires_at timestamptz,
  -- 本人照合に失敗した回数。**read → +1 → write をしない** (RPC 内で原子的に +1)。
  pending_attempts   int not null default 0,

  consumed_at        timestamptz,
  created_at         timestamptz not null default now()
);

comment on table diagnosis.admin_impersonation_handoffs is
  'Admin 代理表示の受け渡し券。60 秒・single-use。raw token も生 email も保存しない。';
comment on column diagnosis.admin_impersonation_handoffs.admin_identity is
  'HMAC-SHA256 の digest。生 email は保存しない (仕様書 §12.4.1)。';
comment on column diagnosis.admin_impersonation_handoffs.expires_at is
  'raw token の寿命。pending へ交換したあとは pending_expires_at が効く。';

create index if not exists admin_imp_handoffs_pending_idx
  on diagnosis.admin_impersonation_handoffs (pending_digest)
  where pending_digest is not null;

-- ════════════════════════════════════════════════════════════════════
-- 2. impersonation session (= URL path の opaque view-context)
-- ════════════════════════════════════════════════════════════════════
create table if not exists diagnosis.admin_impersonation_sessions (
  id                 uuid primary key default gen_random_uuid(),

  -- **1 handoff = 1 context を DB が保証する。**
  handoff_id         uuid not null unique
                       references diagnosis.admin_impersonation_handoffs(id) on delete cascade,

  -- sha256(raw context)。**raw context は保存しない** (URL path にしか存在しない)。
  session_digest     text not null unique,

  -- handoff 行からのコピー。毎リクエストの照合をこの 1 行で完結させるため。
  admin_identity     text not null,
  target_uid         uuid not null references diagnosis.app_users(diagnostic_user_id),
  target_origin      text not null default 'production'
                       check (target_origin in ('production','staging')),

  expires_at         timestamptz not null,
  revoked_at         timestamptz,
  last_seen_at       timestamptz,
  created_at         timestamptz not null default now()
);

comment on table diagnosis.admin_impersonation_sessions is
  'Admin 代理表示の view-context。context の raw は URL path のみで DB は sha256 だけ持つ。';
comment on column diagnosis.admin_impersonation_sessions.handoff_id is
  'UNIQUE。1 つの handoff から context は 1 つしか作れない (仕様書 §12.8 ③)。';

create index if not exists admin_imp_sessions_digest_idx
  on diagnosis.admin_impersonation_sessions (session_digest);

-- ════════════════════════════════════════════════════════════════════
-- 3. claim — raw token を pending へ原子的に交換する
--    **GET では呼ばない** (POST /api/admin/handoff/claim だけ)。
-- ════════════════════════════════════════════════════════════════════
create or replace function diagnosis.claim_admin_handoff(
  p_token_hash     text,
  p_pending_digest text,
  p_pending_ttl_sec int default 600
)
returns table (handoff_id uuid, admin_identity text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update diagnosis.admin_impersonation_handoffs h
     set pending_digest     = p_pending_digest,
         pending_expires_at = now() + make_interval(secs => p_pending_ttl_sec),
         pending_attempts   = 0
   where h.token_hash     = p_token_hash
     and h.consumed_at    is null
     and h.pending_digest is null          -- ★ 二重 claim を止める
     and h.expires_at     > now()          -- ★ raw token の 60 秒
  returning h.id, h.admin_identity;
end;
$$;

comment on function diagnosis.claim_admin_handoff is
  '1 handoff = 1 pending。0 行が返ったら不存在/claim 済/consumed/期限切れ (区別しない)。';

-- ════════════════════════════════════════════════════════════════════
-- 4. 本人照合の失敗を数える (原子的 +1。5 回で pending を失効させる)
-- ════════════════════════════════════════════════════════════════════
create or replace function diagnosis.fail_admin_handoff_attempt(
  p_pending_digest text,
  p_max_attempts   int default 5
)
returns table (attempts int, exhausted boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts int;
begin
  update diagnosis.admin_impersonation_handoffs h
     set pending_attempts    = h.pending_attempts + 1,     -- ★ read→+1→write をしない
         pending_expires_at  = case
                                 when h.pending_attempts + 1 >= p_max_attempts then now()
                                 else h.pending_expires_at
                               end
   where h.pending_digest     = p_pending_digest
     and h.consumed_at        is null
     and h.pending_expires_at > now()
  returning h.pending_attempts into v_attempts;

  if v_attempts is null then
    return query select 0, true;   -- 既に失効している
  end if;
  return query select v_attempts, (v_attempts >= p_max_attempts);
end;
$$;

comment on function diagnosis.fail_admin_handoff_attempt is
  '本人照合の失敗を原子的に +1。5 回で pending_expires_at を now() にして失効させる。';

-- ════════════════════════════════════════════════════════════════════
-- 5. consume + context INSERT を **1 トランザクション**で行う
--    途中で失敗したら全部 ROLLBACK (consumed だけ進んで context が無い、を作らない)
-- ════════════════════════════════════════════════════════════════════
create or replace function diagnosis.consume_admin_handoff(
  p_pending_digest  text,
  p_admin_identity  text,
  p_session_digest  text,
  p_session_ttl_sec int default 3600
)
returns table (target_uid uuid, target_origin text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id       uuid;
  v_target   uuid;
  v_origin   text;
  v_expires  timestamptz;
begin
  -- ① pending を条件付きで consume する。**admin_identity の一致もここで要求する**
  --    (一致しないなら 0 行 = handoff を焼かない → 呼び出し側が attempts を +1 して再試行させる)。
  update diagnosis.admin_impersonation_handoffs h
     set consumed_at = now()
   where h.pending_digest     = p_pending_digest
     and h.consumed_at        is null         -- ★ 二重 consume を止める
     and h.pending_expires_at > now()         -- ★ pending の 10 分
     and h.admin_identity     = p_admin_identity   -- ★ 発行した admin 本人か
  returning h.id, h.target_uid, h.target_origin
       into v_id, v_target, v_origin;

  if v_id is null then
    return;   -- 0 行。呼び出し側は 403。
  end if;

  v_expires := now() + make_interval(secs => p_session_ttl_sec);

  -- ② context を作る。**handoff_id は UNIQUE** なので 2 本目はここで落ちる。
  --    落ちれば ① の consumed_at も一緒に ROLLBACK される (同一トランザクション)。
  insert into diagnosis.admin_impersonation_sessions
    (handoff_id, session_digest, admin_identity, target_uid, target_origin, expires_at)
  values
    (v_id, p_session_digest, p_admin_identity, v_target, v_origin, v_expires);

  return query select v_target, v_origin, v_expires;
end;
$$;

comment on function diagnosis.consume_admin_handoff is
  'consume と context INSERT を 1 トランザクションで行う。途中失敗は全部 ROLLBACK。';

-- ════════════════════════════════════════════════════════════════════
-- 6. RLS — **service_role 以外に出さない**
-- ════════════════════════════════════════════════════════════════════
alter table diagnosis.admin_impersonation_handoffs enable row level security;
alter table diagnosis.admin_impersonation_sessions enable row level security;

-- 既存の緩い dev ポリシーを**足さない**。念のため同名があれば落とす。
drop policy if exists "dev_read_all"    on diagnosis.admin_impersonation_handoffs;
drop policy if exists "dev_authn_write" on diagnosis.admin_impersonation_handoffs;
drop policy if exists "dev_read_all"    on diagnosis.admin_impersonation_sessions;
drop policy if exists "dev_authn_write" on diagnosis.admin_impersonation_sessions;

revoke all on diagnosis.admin_impersonation_handoffs from anon, authenticated;
revoke all on diagnosis.admin_impersonation_sessions from anon, authenticated;
grant all  on diagnosis.admin_impersonation_handoffs to service_role;
grant all  on diagnosis.admin_impersonation_sessions to service_role;

revoke all on function diagnosis.claim_admin_handoff(text, text, int)          from public, anon, authenticated;
revoke all on function diagnosis.fail_admin_handoff_attempt(text, int)         from public, anon, authenticated;
revoke all on function diagnosis.consume_admin_handoff(text, text, text, int)  from public, anon, authenticated;
grant execute on function diagnosis.claim_admin_handoff(text, text, int)         to service_role;
grant execute on function diagnosis.fail_admin_handoff_attempt(text, int)        to service_role;
grant execute on function diagnosis.consume_admin_handoff(text, text, text, int) to service_role;
