-- `consume_share_pending` に **`revoked_at is null`** を足す（前進マイグレーション）。
-- 正本: docs/specs/secure_shared_access_and_admin_impersonation_spec_20260930.md §27.2。
--
-- 【なぜ足すか（2026-09-30 のレビュー）】revoke は **不可逆**であるべきなのに、
-- アプリ側の状態遷移だけで守っていた。`status` は列なので、将来 `status='active'` を
-- 書き戻す経路が 1 本できた瞬間に**失効が黙って解ける**。
-- 失効は `revoked_at` に残る**事実**なので、**同意の 1 文でもそこを見る**
-- （`linkUsable()` にも同じ条件を入れて二重に閉じた）。
--
-- **20260930000030 を書き換えずに前進で当てる**（CLAUDE.md の DB 適用プロセス）。
-- 本文は `…30` と同一で、`and l.revoked_at is null` の 1 行だけが増えている。

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
     and l.revoked_at     is null      -- ★ 失効は不可逆（§27.2・2026-09-30 追加）
     and (l.starts_at is null or l.starts_at <= now())
     and l.expires_at     > now()
  returning l.id, l.target_uid, s.expires_at;
end;
$$;

comment on function diagnosis.consume_share_pending is
  '同意 → 共有セッション発行を原子的に行う。revoked は不可逆なので revoked_at も見る（仕様書 §27.2）。';

revoke all on function diagnosis.consume_share_pending(text, text, text, int)
  from public, anon, authenticated;
grant execute on function diagnosis.consume_share_pending(text, text, text, int)
  to service_role;
