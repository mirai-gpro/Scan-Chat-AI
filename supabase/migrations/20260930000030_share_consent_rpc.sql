-- 共有セッションの「同意 → 発行」を **1 文で原子的に**行う RPC。
-- 正本: docs/specs/secure_shared_access_and_admin_impersonation_spec_20260930.md §18.3 / §31 T-5。
--
-- 【なぜ RPC か】アプリ側で
--   ① read（pending を引く） → ② update（昇格させる）
-- と 2 往復すると、**同じ pending で同時に 2 回 POST された時に 2 つ成功し得る**
-- （どちらの update も「①で読んだときは consented_at is null だった」ため）。
-- そうなると **共有セッションが 2 つ**でき、片方を revoke しても他方が生き残る。
-- Admin 代理表示で `consume_admin_handoff` に寄せたのと同じ規律をここでも採る。
--
-- 【pending の値を昇格させない】§31 T-5（session fixation）。
-- 同意の瞬間に **session_digest を別の値へ差し替える**。
-- したがって「同意前に配られた pending」を後から session として使えない。
--
-- 【link 側も同じ文の中で見る】status / starts_at / expires_at。
-- 同意ボタンを押すまでの 10 分の間に revoke / pause された link を通さない（§27.1）。

create or replace function diagnosis.consume_share_pending(
  p_pending_digest  text,
  p_session_digest  text,
  p_viewer_id       text default null,
  p_session_ttl_sec int default 28800
)
returns table (link_id uuid, target_uid uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update diagnosis.shared_access_sessions s
     set session_digest = p_session_digest,          -- ★ pending を昇格させない
         consented_at   = now(),
         viewer_id      = coalesce(p_viewer_id, s.viewer_id),
         expires_at     = least(
                            now() + make_interval(secs => p_session_ttl_sec),
                            l.expires_at                      -- ★ link の期限を超えない
                          )
    from diagnosis.shared_access_links l
   where s.session_digest = p_pending_digest
     and s.consented_at   is null      -- ★ 二重 POST の 2 本目をここで落とす
     and s.revoked_at     is null
     and s.expires_at     > now()      -- ★ pending の 10 分
     and l.id             = s.share_link_id
     and l.status         = 'active'   -- ★ 同意の直前に停止された link を通さない
     and (l.starts_at is null or l.starts_at <= now())
     and l.expires_at     > now()
  returning l.id, l.target_uid, s.expires_at;
end;
$$;

comment on function diagnosis.consume_share_pending is
  '同意 → 共有セッション発行を原子的に行う。0 行なら不存在/同意済/失効/link 停止（区別しない）。';

revoke all on function diagnosis.consume_share_pending(text, text, text, int)
  from public, anon, authenticated;
grant execute on function diagnosis.consume_share_pending(text, text, text, int)
  to service_role;
