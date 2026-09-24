-- Elith 納品の記録 (冪等キー ＋ 「Elith納品済み」表示の根拠)。
--
-- 背景: スペシャルアカウントの admin 一括「Elith納品データ作成」ボタン
--   (`/api/admin/special-accounts/deliver`) が、揃った (問診+スキャン済み) アカウントを
--   ウェルネス年齢算出 → Elith 納品セットをラップ → S3 (バケット直下 user/…) へ書き出す。
--   その「いつ・誰の・どの回を納品したか」をここに残す。
--
-- 用途:
--   1. 冪等 … 同じ uid・同じ bundle_date・同じ納品先へ二重に書かない (unique + upsert)。
--   2. 表示 … admin 一覧の「Elith納品」列 (✅) の根拠 (status='delivered' の行があるか)。
--
-- 【PII を持たない】診断系スキーマ。氏名・住所・生年月日・回答本文・測定値は入れない。
--   保持するのは uid (非PII)・日付・format_id 一覧・件数・算出版・状態だけ。

create table if not exists diagnosis.elith_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  diagnostic_user_id  uuid not null references diagnosis.app_users(diagnostic_user_id),

  -- 納品バンドルの日付 (YYYY-MM-DD)。回 (サイクル) の識別に使う。
  bundle_date         date not null,

  -- 書き出し先 prefix。'' = バケット直下 (= 本番 Elith 受け取り位置)。
  -- テスト時は 'scan-accuracy-test/' 等。**納品先が違えば別の納品として記録**する。
  delivery_prefix     text not null default '',

  -- 実際に納品した format_id 群 (HealthCheckupData / LifestyleQuestionnaireData / HealthAgeData 等)。
  format_ids          text[] not null default '{}',
  file_count          int not null default 0,

  -- どの版でウェルネス年齢を算出したか (CABA-v5.4 / CABA-SIMPLE-v7.0)。
  -- 算出不能でスキップした回は null (= HealthAgeData 非同梱)。
  wellness_age_method text,

  status              text not null default 'delivered'
                        check (status in ('delivered','failed')),
  note                text,
  delivered_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),

  -- 冪等: 同じ人・同じ回・同じ納品先は 1 行 (再実行は upsert で上書き)。
  unique (diagnostic_user_id, bundle_date, delivery_prefix)
);

comment on table diagnosis.elith_deliveries is
  'Elith 納品の記録 (冪等キー ＋ admin 一覧の「Elith納品済み」表示根拠)。PII を含まない。';
comment on column diagnosis.elith_deliveries.delivery_prefix is
  'S3 書き出し先 prefix。空 = バケット直下 = 本番 Elith 受け取り位置。';
comment on column diagnosis.elith_deliveries.wellness_age_method is
  'ウェルネス年齢の算出版 (CABA-v5.4 / CABA-SIMPLE-v7.0)。算出不能でスキップした回は null。';

create index if not exists ix_elith_deliveries_user
  on diagnosis.elith_deliveries(diagnostic_user_id, delivered_at desc);

alter table diagnosis.elith_deliveries enable row level security;
grant select on diagnosis.elith_deliveries to anon, authenticated;
grant all    on diagnosis.elith_deliveries to service_role;

-- 既存テーブルと同方針 (サーバは service_role で RLS バイパス)。再実行で詰まらないよう冪等。
drop policy if exists "dev_read_all"    on diagnosis.elith_deliveries;
drop policy if exists "dev_authn_write" on diagnosis.elith_deliveries;
create policy "dev_read_all"    on diagnosis.elith_deliveries for select using (true);
create policy "dev_authn_write" on diagnosis.elith_deliveries for all to authenticated using (true) with check (true);
