-- ============================================================================
-- 既に入ってしまった「同じ受診日の重複回」を片付ける（1 回きりの後始末）
--
-- 発端: 2026-09-30 本田さんの「人間ドックデータが重複して表示される」報告。
-- 真因: `src/lib/scan-persist.ts` の `saveScanResult` が**無条件 insert** で、
--       同じ回を送り直すたびに `test_artifacts` が 1 行増えていた
--       （admin バッチ側は元から冪等だったが、**ユーザー経路にだけ無かった**）。
--       複数年アップロード（スペシャルアカウント）は受診日が読めなかった回の
--       **再アップロードが前提**なので、必ず踏む。
-- コード側は同日に修正済み（差し替え方式）。**このファイルは既存データの後始末だけ**。
--
-- ----------------------------------------------------------------------------
-- 【マイグレーションにしていない理由】
--   `supabase db push` は未適用のものを**全環境で自動的に**流す。
--   データを消す処理をそこへ置くと、**新しい環境で意図せず走る**。
--   これは 1 回きりの後始末なので、**人が中身を見てから手で流す**。
--
-- 【実行の順序（必ずこの順で）】
--   STEP 1  何が消えるかを**見る**（SELECT だけ。何も変わらない）
--   STEP 2  納得したら STEP 3 を実行する
--   STEP 3  実際に片付ける（**1 文で完結**。戻り値の件数が STEP 1 と一致することを確認）
--
--   **このファイルを丸ごと実行すると STEP 3 まで走る。**
--   まず STEP 1 だけを選択して実行し、中身を見てから STEP 3 を流すこと。
--
-- 【安全のための約束】
--   ・**残すのは各 (uid, 検査種別, 受診日, 取込元) の最新 1 件**（`imported_at` が最大）
--   ・**原本ファイルが付いている行は消さない** — `test_artifact_files` は
--     `on delete cascade`（`20260601000010_schemas_and_tables.sql:215`）なので、
--     消すと**原本の記録ごと消える**（10 年保管・削除不可 §6.1 と衝突）。
--     そういう行は `status='superseded'` に落とすだけにする。
--   ・`measurement_values` は `on delete cascade`
--     （`20260820000010_measurement_values.sql:33`）なので**一緒に消える**。
--     これは正しい — 残るとグラフに幽霊の点が出る。
--   ・**`status='active'` の行だけを対象**にする（既に superseded のものは触らない）。
--
-- 【この表の列名（実測・`20260601000010_schemas_and_tables.sql`）】
--   時刻の列は **`imported_at` だけ**。**`created_at` も `updated_at` も無い**。
--   （初版で `created_at` を書いて `42703: column a.created_at does not exist` で落ちた。
--    他の表の癖で書くと必ず踏むので、ここに明記しておく。）
--
-- 【なぜ DB が重複を止めなかったか】UNIQUE は
--   `(diagnostic_user_id, source, test_type, test_date, external_test_id)` だが、
--   **PostgreSQL は NULL 同士を「別の値」として扱う**ので、
--   `external_test_id` が NULL のユーザースキャンは**何行でも入る**。
--   （だから制約ではなくアプリ側の差し替えで塞いだ。）
-- ============================================================================


-- ============================================================================
-- STEP 1 — 何が起きているか / 何が消えるかを見る（読み取りだけ）
-- ============================================================================

-- 1-a. 重複している (人・検査種別・受診日・取込元) の一覧
select
  diagnostic_user_id,
  test_type,
  test_date,
  source,
  count(*) as active_rows          -- ← 2 以上が重複
from diagnosis.test_artifacts
where status = 'active'
group by diagnostic_user_id, test_type, test_date, source
having count(*) > 1
order by diagnostic_user_id, test_date desc;


-- 1-b. 実際に消える行（最新 1 件を残し、原本のある行は除外）
with ranked as (
  select
    a.id,
    a.diagnostic_user_id,
    a.test_type,
    a.test_date,
    a.source,
    a.imported_at,
    a.scan_md is not null and length(btrim(a.scan_md)) > 0 as has_md,
    row_number() over (
      partition by a.diagnostic_user_id, a.test_type, a.test_date, a.source
      order by a.imported_at desc, a.id desc            -- ★ 最新を残す
    ) as rn,
    exists (
      select 1 from diagnosis.test_artifact_files f
      where f.test_artifact_id = a.id
    ) as has_original
  from diagnosis.test_artifacts a
  where a.status = 'active'
)
select
  id, diagnostic_user_id, test_type, test_date, source, imported_at, has_md, has_original,
  case when has_original then 'superseded に落とす（原本があるので消さない）'
       else '削除する' end as action
from ranked
where rn > 1                                            -- ★ 最新以外
order by diagnostic_user_id, test_date desc, imported_at desc;


-- 1-c. 本田さんだけ見たいとき（uid を差し替えて使う）
-- select id, test_type, test_date, source, status, imported_at,
--        length(coalesce(scan_md, '')) as md_len
--   from diagnosis.test_artifacts
--  where diagnostic_user_id = '5d11742f-f196-450c-800b-d9ffa89ba64b'
--    and test_type = 'health_checkup'
--  order by test_date desc, imported_at desc;


-- ============================================================================
-- STEP 3 — 片付ける（STEP 1 を見てから実行する）
--
-- **1 文で完結させてある。一時表もトランザクション宣言も使わない。**
--   初版は `create temporary table … on commit drop` を使っていたが、
--   **Supabase の SQL Editor は文ごとに自動コミットする**ので、
--   一時表は次の文の前に消えて
--   `42P01: relation "_dup_targets" does not exist` で落ちた（本番で実測）。
--   → **データ変更 CTE（`sup` / `del`）にまとめた。**
--
-- 【1 文にすると何が良いか】CTE はすべて**同じスナップショット**を見るので、
--   「消す対象を選ぶ」と「実際に消す」の間で行がずれない
--   （一時表を使っていた理由そのものが、1 文にすることで自動的に満たされる）。
--   `sup`（superseded に落とす）と `del`（削除）は**対象が重ならない**ので同居できる。
--
-- **戻り値の 2 つの数字が、STEP 1-b で見た行数と一致することを確認すること。**
-- 何度流しても同じ結果になる（2 回目は 0 件）。
-- ============================================================================

with ranked as (
  select
    a.id,
    row_number() over (
      partition by a.diagnostic_user_id, a.test_type, a.test_date, a.source
      order by a.imported_at desc, a.id desc          -- ★ 最新を残す
    ) as rn,
    exists (
      select 1 from diagnosis.test_artifact_files f
      where f.test_artifact_id = a.id
    ) as has_original
  from diagnosis.test_artifacts a
  where a.status = 'active'
),
targets as (
  select id, has_original from ranked where rn > 1    -- ★ 最新以外
),
sup as (
  -- ① 原本のある重複は消さず superseded に落とす
  --    （test_artifact_files は on delete cascade。消すと原本の記録ごと消える）
  update diagnosis.test_artifacts t
     set status = 'superseded'                        -- ★ この表に updated_at は無い
   where t.id in (select id from targets where has_original)
  returning t.id
),
del as (
  -- ② 残りを削除（measurement_values は cascade で一緒に消える）
  delete from diagnosis.test_artifacts t
   where t.id in (select id from targets where not has_original)
  returning t.id
)
select
  (select count(*) from sup) as superseded_rows,
  (select count(*) from del) as deleted_rows;


-- STEP 3 のあと: 重複が 0 件になっていることの確認（読み取りだけ）
select count(*) as remaining_duplicate_groups from (
  select 1 from diagnosis.test_artifacts
   where status = 'active'
   group by diagnostic_user_id, test_type, test_date, source
  having count(*) > 1
) t;


-- ============================================================================
-- STEP 4 — 画面で確認する（DB だけ見て終わりにしない）
--
--   GET /api/debug/viewer?k=<PROBE_UPLOAD_TOKEN>&u=<diagnostic_user_id>
--     → `health_checkup_years` の **active_rows と受診日の種類数が一致**すること
--   ダッシュボード → 人間ドック / 健康診断 → 「データ」→「過去データ」
--     → **同じ受診日が 2 つ出ないこと**
--   「グラフ」→ 同じ日付に点が 2 つ乗っていないこと
-- ============================================================================


-- ============================================================================
-- 【検証済み】2026-09-30・ローカル PostgreSQL 16 で実際に流して確認した
--
-- 本番と同じ定義の表（`test_artifacts` / `test_artifact_files` /
-- `measurement_values` の FK と cascade を含む）を作り、本田さん相当のデータ
-- （重複 2 組 ＋ 原本付き重複 1 組 ＋ 既に superseded 1 件）と、
-- **巻き込まれてはいけない別人 1 件**を入れて STEP 1 → STEP 3 を実行した。
--
--   superseded_rows = 1 / deleted_rows = 3 / remaining_duplicate_groups = 0
--   （3 行ある重複グループも 1 件だけ残ることを確認。**2 回流しても 0 件**＝冪等）
--
--   ・本田さんの active 行数 4 ＝ 受診日の種類数 4（重複ゼロ）
--   ・残ったのは各組の最新（imported_at が最大）の行
--   ・**原本付きの行は削除されず superseded**。原本レコードも残った
--   ・既に superseded だった行は触られていない
--   ・**別人の行は触られていない**
--   ・measurement_values 9 → 7（削除した 2 行分だけ cascade で消えた）
--
-- 【なぜこの記録を残すか】本番で 2 回落としている。
--   1) `42703: column a.created_at does not exist`（この表の時刻列は imported_at だけ）
--   2) `42P01: relation "_dup_targets" does not exist`
--      （Supabase の SQL Editor は文ごとに自動コミット＝一時表が残らない）
-- どちらも**SQL をどのテストも実行していなかった**のが原因。
-- **この種のスクリプトは、渡す前にローカル PG で、しかも
--   「begin 無し・1 文ずつ自動コミット」の条件で流すこと。**
-- ============================================================================
