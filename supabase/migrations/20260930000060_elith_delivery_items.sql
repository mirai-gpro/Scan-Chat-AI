-- スペシャルアカウント 追加検査の **個別納品記録**。
-- 正本: docs/specs/special_account_additional_tests_spec_20260930.md §30 / §31。
--
-- 【なぜ既存 `elith_deliveries` を使わないか】あちらは
--   unique (diagnostic_user_id, bundle_date, delivery_prefix)   -- 20260924000010:41
-- で **1 行 = 1 バンドル**、`format_ids text[]` を upsert で**丸ごと上書き**する。
-- 追加検査をそこへ upsert すると、**既に納品済みの format_ids を消す**。
-- → 役割を分ける:
--     elith_deliveries      … AI疾病予防報告書等の**診断バンドル単位**の納品記録（意味を変えない）
--     elith_delivery_items  … 追加検査の**個別検査単位**の納品記録（この表）
--
-- 【PII を持たない】診断系スキーマ。氏名・生年月日・測定値・原本のファイル名は入れない。
-- 入るのは uid（非PII）・日付・format_id・S3 キー・SHA256・状態だけ。
--
-- 【RLS】**service_role 以外に権限を出さない**（新表の既定の規律）。

create table if not exists diagnosis.elith_delivery_items (
  id                  uuid primary key default gen_random_uuid(),

  -- どの検査の納品か。artifact が消えたら記録も落とす（記録だけ残っても辿れない）。
  test_artifact_id    uuid not null
                        references diagnosis.test_artifacts(id) on delete cascade,
  diagnostic_user_id  uuid not null
                        references diagnosis.app_users(diagnostic_user_id),

  -- Elith の format_id（BloodTestData / CancerRiskAssessmentData /
  -- GeneticTestResultData / Other）。**集合は `elith-export.ts` の ELITH_FORMAT_IDS。**
  format_id           text not null,
  -- 受診日。納品先の日付フォルダ（YYYY_MM_DD）はこれから作る（§26）。
  test_date           date not null,

  -- 中間（監査）側と本番側の S3 キー。**ファイル名に氏名は入らない**（§16 / §23）。
  source_key          text not null,
  destination_key     text not null,

  -- 読戻し検証の根拠（§29）。**PutObject の成功だけで「納品完了」にしない。**
  source_sha256       text,
  destination_sha256  text,

  status              text not null default 'pending'
                        check (status in ('pending','delivered','failed')),
  last_error          text,
  attempt_count       int not null default 0,

  delivered_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- 冪等（§33）: 同じ検査・同じ format を同じ納品先へ二重に記録しない。
  -- **再実行は upsert で 1 行のまま**（attempt_count が増えるだけ）。
  unique (test_artifact_id, format_id, destination_key)
);

comment on table diagnosis.elith_delivery_items is
  '追加検査の個別納品記録。elith_deliveries (バンドル単位) とは別物で、あちらの意味を変えない（仕様書 §31）。';
comment on column diagnosis.elith_delivery_items.destination_sha256 is
  '本番 S3 から読み戻した JSON の SHA256。source と一致して初めて delivered（仕様書 §29）。';
comment on column diagnosis.elith_delivery_items.status is
  'pending = 未納品 / delivered = 読戻し一致まで確認 / failed = 再実行可能（仕様書 §32）。';

create index if not exists elith_delivery_items_user_idx
  on diagnosis.elith_delivery_items (diagnostic_user_id, test_date desc);
create index if not exists elith_delivery_items_status_idx
  on diagnosis.elith_delivery_items (status)
  where status <> 'delivered';

-- ── RLS: service_role 以外に出さない ────────────────────────────────
alter table diagnosis.elith_delivery_items enable row level security;

-- 既存の緩い dev ポリシーを**足さない**。念のため同名があれば落とす。
drop policy if exists "dev_read_all"    on diagnosis.elith_delivery_items;
drop policy if exists "dev_authn_write" on diagnosis.elith_delivery_items;

revoke all on diagnosis.elith_delivery_items from anon, authenticated;
grant all  on diagnosis.elith_delivery_items to service_role;
