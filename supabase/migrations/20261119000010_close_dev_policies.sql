-- ============================================================================
-- 開発用の全開放ポリシーを閉じる (customer / diagnosis の全表)
-- ============================================================================
--
-- 【何が開いていたか — 2026-11-19 に本番で実測】
--   `pg_policies` に次の 2 本が 17 表ぶん残っていた。
--     dev_read_all     … to public / for select using (true)
--                        = ページに出ている公開用キー (anon) だけで全行を読める
--     dev_authn_write  … to authenticated / for all using (true) with check (true)
--                        = ログインした利用者なら誰でも全行を読み書き・削除できる
--                          (2026-10 からメールで誰でも新規登録できる)
--   対象 17 表:
--     customer : customer_profiles / kit_shipments / lab_companies / lab_tests /
--                subscription_plans / subscriptions
--     diagnosis: announcements / app_config / app_users / diagnosis_results /
--                elith_deliveries / health_age_scores / interview_completions /
--                measurement_values / test_artifact_files / test_artifacts / user_notices
--
-- 【なぜ残っていたか】
--   20260601000020 が開発初期に「全表に dev_read_all / dev_authn_write」を一括で
--   作った。その後の表のうち 9 表 (scan_jobs / shared_access_* / admin_impersonation_* /
--   elith_delivery_items / elith_delivery_runs / lab_test_id_captures) は個別に閉じたが、
--   7 表は**同じ開発用の書き方を写して**作られ (例: 20260820000010:84-92)、
--   初期の 10 表は一度も処理されなかった。
--
-- 【閉じても壊れない根拠 — 2026-11-19 にコードで確認】
--   - アプリのデータ処理はすべて `getServerSupabase()` = service_role 経由。
--     service_role は RLS を通らず、本 migration は service_role の権限を触らない。
--   - ブラウザで anon キーを使うのは `sb.auth.*` (GoogleOneTap / EmailPasswordAuth) と
--     Storage への署名付き upload (admin/transcosmos-reports) だけ。表は 0 件。
--   - wellfort-site の Edge Function (notices-admin) と本リポジトリの
--     sync-announcements も service_role キーで接続している。
--   → 後方互換な変更。CLAUDE.md の規律どおり**アプリより先に適用してよい**。
--
-- 【方針】既に閉じた 9 表と同じ形にそろえる。
--   ① 名前が dev_ で始まるポリシーを customer / diagnosis から全部消す
--      (17 表を名指しせずスキーマで掃く = 取りこぼした表を作らない)
--   ② 全表で RLS を有効にする (ポリシー 0 本 + RLS 有効 = service_role 以外は 0 行)
--   ③ 全表・全シーケンスの権限を anon / authenticated から外し、service_role だけに残す
--   ④ 今後この 2 スキーマに作る表が anon / authenticated へ自動付与されないよう
--      default privileges も外す
--   スキーマの USAGE と関数の EXECUTE は触らない (関数は既に個別に閉じてある)。
--
-- 冪等。何度当てても同じ結果になる。DDL のみでデータは 1 行も変えない。
-- 検証: `npm run verify:dev-policies-closed` (静的・CI) /
--       `npm run verify:anon-db-access` (適用後に本番へ読み取りだけで確認)
-- ============================================================================

begin;

-- ① 開発用ポリシーを消す ----------------------------------------------------
do $$
declare
  p record;
begin
  for p in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname in ('customer', 'diagnosis')
      and policyname like 'dev\_%'
  loop
    execute format('drop policy if exists %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end
$$;

-- ② RLS を有効にする --------------------------------------------------------
do $$
declare
  t record;
begin
  for t in
    select schemaname, tablename
    from pg_tables
    where schemaname in ('customer', 'diagnosis')
  loop
    execute format('alter table %I.%I enable row level security', t.schemaname, t.tablename);
  end loop;
end
$$;

-- ③ 権限を service_role だけに残す -------------------------------------------
revoke all on all tables    in schema customer  from anon, authenticated;
revoke all on all tables    in schema diagnosis from anon, authenticated;
revoke all on all sequences in schema customer  from anon, authenticated;
revoke all on all sequences in schema diagnosis from anon, authenticated;

grant all on all tables    in schema customer  to service_role;
grant all on all tables    in schema diagnosis to service_role;
grant all on all sequences in schema customer  to service_role;
grant all on all sequences in schema diagnosis to service_role;

-- ④ 今後作る表にも自動で付与させない -----------------------------------------
alter default privileges in schema customer  revoke all on tables    from anon, authenticated;
alter default privileges in schema diagnosis revoke all on tables    from anon, authenticated;
alter default privileges in schema customer  revoke all on sequences from anon, authenticated;
alter default privileges in schema diagnosis revoke all on sequences from anon, authenticated;

commit;
