-- スペシャルアカウントの **手動納品 run の控え**（1 行 = 1 回の［Elith納品］）。
-- 正本: docs/specs/special_account_management_spec_20261001.md §14.3 / §16.1（D-4 / D-7）。
--
-- 【なぜ既存 2 表に入れないか】粒度が違う。
--   elith_deliveries      … (uid, bundle_date, delivery_prefix) = **年単位**
--   elith_delivery_items  … 追加検査の**個別検査単位**
--   この表                … **1 回の手動納品（複数年をまとめて出す）単位**
-- 1 回の手動納品は複数年を一度に出すので、年単位の表に run の控えは収まらない。
-- 20260930000060 が elith_deliveries と elith_delivery_items を分けたのと同じ理由
-- （粒度が違うものを同じ表へ upsert すると、既にある情報を消す）。
--
-- 【対象はスペシャルの手動納品 run だけ】§14.3.2。
--   通常の cron（/api/cron/elith-deliver）の run はここに書かない。
--   cron は契約者・単品を含む母集団を 1 起動でまとめて回すので、run 単位の控えを
--   全員分書くと **この画面のための表が全ユーザーの納品ログになる**。
--   cron の履歴は elith_deliveries / elith_delivery_items のまま、何も変えない。
--
-- 【PII を 1 つも入れない】診断系スキーマ。
--   入るのは uid（非PII）・日時・件数・format_id・S3 キー・SHA256 だけ。
--   氏名・会社名・メール（マスクも）・生年月日・測定値・問診の回答本文・
--   原本のファイル名は **1 つも入れない**。
--   snapshot の sha256 は**中身の指紋であって中身ではない**（復元できない）。
--   triggered_by は **adminIdentity() の鍵つき HMAC digest**（素の sha256(email) にしない
--   = メールアドレスは列挙可能で辞書で戻せる。src/lib/admin-identity.ts:93）。
--
-- 【RLS】**service_role 以外に権限を出さない**（新表の既定の規律）。

create table if not exists diagnosis.elith_delivery_runs (
  id                  uuid primary key default gen_random_uuid(),

  diagnostic_user_id  uuid not null
                        references diagnosis.app_users(diagnostic_user_id),

  -- 納品先（'' = バケット直下 = 本番 Elith 受け取り位置）。
  delivery_prefix     text not null default '',
  delivered_at        timestamptz not null default now(),

  -- **admin 識別子の digest。生 email を入れない**（share-access.ts:283-292 と同じ規律）。
  -- 値は `adminIdentity()` = base64url(HMAC-SHA256(鍵, "admin_identity:v1:" + email)) の 43 文字。
  -- **素の sha256(email) を入れない**（辞書で戻せる。この控えは 10 年残る）。
  triggered_by        text,

  -- **'manual' 固定。** この表はスペシャルの手動納品 run だけを記録する（§14.3.2）。
  -- 将来 cron を足すときのための列であって、**今回 cron は 1 行も書かない。**
  source              text not null default 'manual'
                        check (source in ('manual')),

  -- putVerified の結果（§9.6）。file_count は書こうとした数、verified_count は
  -- **読み戻して一致した数**。PutObject の成否ではない。
  file_count          int not null default 0,
  verified_count      int not null default 0,

  -- §14.3.1 の内訳 ＋ **納品したファイル 1 件ごとの明細**
  -- （format_id / delivered_date / destination_key / sha256）。
  -- 明細を持つのは、件数と test_date だけだと
  -- **「同じ日・同じ件数で中身だけ変わった回」が差分に出ない**ため（§14.3.1.1）。
  -- persistIntoExistingArtifact は既存 artifact の中身を更新して行を増やさないので、
  -- これは実際に起こる。
  snapshot            jsonb not null default '{}'::jsonb,

  created_at          timestamptz not null default now()
);

-- 一覧の「前回納品後の追加」は **その uid の最新の手動 run 1 件**だけを見る（§14.3.2）。
create index if not exists elith_delivery_runs_uid_at_idx
  on diagnosis.elith_delivery_runs (diagnostic_user_id, delivered_at desc);

comment on table diagnosis.elith_delivery_runs is
  'スペシャルアカウントの手動納品 run の控え。cron の run は入れない（仕様書 §14.3.2）。PII は 1 つも持たない。';
comment on column diagnosis.elith_delivery_runs.snapshot is
  '納品したファイル 1 件ごとの明細（format_id / delivered_date / destination_key / content_sha256 / delivery_sha256）と検査種別ごとの件数。前回との差分判定に使うのは content_sha256（生成メタ exported_at / diagnostic_id / data.computed_date を除いた本文の指紋）だけで、delivery_sha256（実際に書いた body の指紋）は監査用。どちらも指紋であって中身ではない（仕様書 §14.3.1.1 / §27.1.2 P0-2）。';
comment on column diagnosis.elith_delivery_runs.triggered_by is
  'adminIdentity() の HMAC digest（base64url 43 文字）。生 email も素の sha256(email) も入れない（src/lib/admin-identity.ts:93）。';
comment on column diagnosis.elith_delivery_runs.verified_count is
  '読み戻して SHA256 が一致したファイル数。PutObject の成否ではない（仕様書 §9.6）。';
comment on column diagnosis.elith_delivery_runs.source is
  'manual 固定。通常 cron の run はこの表に書かない（仕様書 §14.3.2）。';

-- ── RLS: service_role 以外に出さない（20260930000060 と同じ形）────────
alter table diagnosis.elith_delivery_runs enable row level security;

-- 既存の緩い dev ポリシーを**足さない**。念のため同名があれば落とす。
drop policy if exists "dev_read_all"    on diagnosis.elith_delivery_runs;
drop policy if exists "dev_authn_write" on diagnosis.elith_delivery_runs;

revoke all on diagnosis.elith_delivery_runs from anon, authenticated;
grant all  on diagnosis.elith_delivery_runs to service_role;
