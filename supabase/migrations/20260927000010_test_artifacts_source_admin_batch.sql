-- test_artifacts.source に 'admin_batch' を許可する (前進マイグレーション・2026-09-27)
--
-- 【何が壊れていたか】
--   `src/lib/scan-persist.ts` の persistAdminBatchHc() は admin バッチ (Elith 納品) の
--   読み取り結果を本人ダッシュボード用に `source='admin_batch'` で insert するが、
--   20260601000010_schemas_and_tables.sql:191 の CHECK は
--     check (source in ('user_upload','wellfort_lab'))
--   だったため、**insert が毎回 23514 (check_violation) で失敗**していた。
--
--   失敗は呼び出し側 (elith-scan / elith-hc-merge) が握り潰さずに応答の `dashboard.reason`
--   へ載せているが、admin 画面がその欄を描いていなかったので**画面上は成功に見えていた**。
--   結果、admin バッチで処理した検査は S3 (Elith 納品) にだけ存在し、
--   `test_artifacts` / `measurement_values` には 1 行も入らない
--   = 本人のダッシュボードの「読み取り結果」も「推移グラフ」も空のままだった。
--
-- 【なぜ値を 'wellfort_lab' に寄せないか】
--   'wellfort_lab' は「検査機関から受領したファイルをそのまま取り込んだ」経路
--   (api/admin/lab-results/upload.ts) で既に使っている。admin バッチは
--   **画像を AI で読み取って値を起こした**経路なので、由来が違う。
--   persistAdminBatchHc の冪等削除は (uid, test_type, test_date, source) で対象を絞るので、
--   ここを混ぜると受領ファイル由来の行を巻き込んで消しかねない。→ 値を分けたまま許可する。
--
-- 【適用】supabase db push (未適用ぶんのみ反映)。DDL は CHECK の差し替えのみ。
--   既存行は 'user_upload' / 'wellfort_lab' しか無い (admin_batch は 1 行も入れられていない)
--   ので、制約を**広げる**方向の変更であり既存データの検証で落ちることはない。

alter table diagnosis.test_artifacts
  drop constraint if exists test_artifacts_source_check;

alter table diagnosis.test_artifacts
  add constraint test_artifacts_source_check
  check (source in ('user_upload', 'wellfort_lab', 'admin_batch'));

comment on column diagnosis.test_artifacts.source is
  '取込経路。user_upload=利用者のアプリスキャン / wellfort_lab=検査機関の受領ファイル取込 / admin_batch=admin の Elith バッチスキャン。';
