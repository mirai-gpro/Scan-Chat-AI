-- Welltect セキュア共有閲覧（External Share）。
-- 正本: docs/specs/secure_shared_access_and_admin_impersonation_spec_20260930.md §14〜§22 / §26 / §27
--
-- 【コンセプト】「URL で開くだけ。なのに、ID・パスワード方式より安全で簡単。」（§3）
-- 外部閲覧者に Google / Microsoft / Welltect のアカウント発行を求めない。
-- 共通 ID・パスワードは**採らない**（誰が入ったか分からない・部分失効できない・§2）。
--
-- 【非 PII】このスキーマに入るのは
--   ・digest (sha256 / HMAC)  … raw token も raw session も raw IP も入らない
--   ・diagnostic_user_id      … 非 PII
-- **生の共有 URL は DB に 1 列も保存しない**（§15.3 hash-only）。
--
-- 【RLS】**service_role 以外に権限を出さない**（§22.6）。
-- `token_hash` / `session_digest` が anon で読めると、**共有 URL の総当たりが不要になる**。

-- ════════════════════════════════════════════════════════════════════
-- 1. 共有リンク（用途ごとに発行し、個別に停止できる）
-- ════════════════════════════════════════════════════════════════════
create table if not exists diagnosis.shared_access_links (
  id              uuid primary key default gen_random_uuid(),

  -- 共有される人。**URL にも Cookie にも出さない。ここだけが持つ。**
  target_uid      uuid not null references diagnosis.app_users(diagnostic_user_id),
  target_origin   text not null default 'production'
                    check (target_origin in ('production','staging')),

  label           text,          -- 「助成金事務局 確認用」など
  purpose         text,

  -- sha256(raw token)。**raw は保存しない**（§15.1）。
  -- raw が読めるのは発行の瞬間だけ。再コピーは「再発行」で満たす（§15.3）。
  token_hash      text not null unique,

  starts_at       timestamptz,   -- null = 即時
  expires_at      timestamptz not null,

  status          text not null default 'active'
                    check (status in ('active','paused','revoked')),

  -- { view, interview, scan }（§17.2）。**view は閲覧だけ**を意味する。
  scope           jsonb not null default '{"view":true,"interview":true,"scan":true}'::jsonb,

  -- 発行した admin。**生 email は入れない**（HMAC digest・§38-U9）。
  created_by      text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  revoked_at      timestamptz
);

comment on table diagnosis.shared_access_links is
  '共有リンク。raw token は保存せず sha256 のみ。同一 target_uid に複数発行できる（用途別に停止）。';
comment on column diagnosis.shared_access_links.scope is
  '{view,interview,scan}。発注者が許可した更新は AI 問診と AI スキャンの 2 つだけ（仕様書 §17.2）。';

create index if not exists shared_access_links_target_idx
  on diagnosis.shared_access_links (target_uid, status);

-- ════════════════════════════════════════════════════════════════════
-- 2. 共有セッション
--    **pending（同意前）も同じ表**に置く（`consented_at is null`・§22.2）。
-- ════════════════════════════════════════════════════════════════════
create table if not exists diagnosis.shared_access_sessions (
  id              uuid primary key default gen_random_uuid(),
  share_link_id   uuid not null references diagnosis.shared_access_links(id) on delete cascade,

  -- sha256(Cookie 値)。**raw は保存しない。**
  session_digest  text not null unique,

  -- 匿名 viewer の相関 ID（§31.1）。**本人確認には使わない。**
  viewer_id       text,

  consented_at    timestamptz,   -- null = pending（同意前）
  expires_at      timestamptz not null,   -- link の expires_at を超えない（§18.1）
  revoked_at      timestamptz,
  last_seen_at    timestamptz,
  created_at      timestamptz not null default now()
);

comment on table diagnosis.shared_access_sessions is
  '共有セッション。consented_at is null の行が pending（同意前）。別表にしない（仕様書 §22.2）。';

create index if not exists shared_access_sessions_digest_idx
  on diagnosis.shared_access_sessions (session_digest);
create index if not exists shared_access_sessions_link_idx
  on diagnosis.shared_access_sessions (share_link_id);

-- ════════════════════════════════════════════════════════════════════
-- 3. アクセスログ（§26）
--    **raw token を書かない / path に UID を入れない / 中身は書かない。**
-- ════════════════════════════════════════════════════════════════════
create table if not exists diagnosis.shared_access_logs (
  id              uuid primary key default gen_random_uuid(),
  share_link_id   uuid references diagnosis.shared_access_links(id) on delete set null,
  session_id      uuid references diagnosis.shared_access_sessions(id) on delete set null,
  viewer_id       text,

  event_type      text not null,
  path            text,          -- UID を含めない
  -- HMAC-SHA256(ip, secret)。**素の sha256 にしない**（IPv4 は 2^32 で総当たりできる・§32）。
  ip_hmac         text,
  user_agent      text,
  created_at      timestamptz not null default now()
);

comment on table diagnosis.shared_access_logs is
  'アクセス記録。raw token / UID / 回答本文・検査値は書かない（仕様書 §26.2）。';
comment on column diagnosis.shared_access_logs.ip_hmac is
  'HMAC-SHA256(ip, APP_SESSION_SECRET)。raw IP は保存しない（仕様書 §32）。';

create index if not exists shared_access_logs_link_idx
  on diagnosis.shared_access_logs (share_link_id, created_at desc);

-- ════════════════════════════════════════════════════════════════════
-- 4. RLS — **service_role 以外に出さない**（§22.6）
-- ════════════════════════════════════════════════════════════════════
alter table diagnosis.shared_access_links    enable row level security;
alter table diagnosis.shared_access_sessions enable row level security;
alter table diagnosis.shared_access_logs     enable row level security;

-- 既存の緩い dev ポリシーを**足さない**。念のため同名があれば落とす。
drop policy if exists "dev_read_all"    on diagnosis.shared_access_links;
drop policy if exists "dev_authn_write" on diagnosis.shared_access_links;
drop policy if exists "dev_read_all"    on diagnosis.shared_access_sessions;
drop policy if exists "dev_authn_write" on diagnosis.shared_access_sessions;
drop policy if exists "dev_read_all"    on diagnosis.shared_access_logs;
drop policy if exists "dev_authn_write" on diagnosis.shared_access_logs;

revoke all on diagnosis.shared_access_links    from anon, authenticated;
revoke all on diagnosis.shared_access_sessions from anon, authenticated;
revoke all on diagnosis.shared_access_logs     from anon, authenticated;
grant all  on diagnosis.shared_access_links    to service_role;
grant all  on diagnosis.shared_access_sessions to service_role;
grant all  on diagnosis.shared_access_logs     to service_role;
