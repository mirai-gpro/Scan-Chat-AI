-- スキャンの非同期処理 (送信後はバックグラウンドで読み取る) のジョブ表。
-- 正本: docs/scan/スキャン非同期処理_仕様書.md (発注者判断 2026-09-10)。
--
-- 背景: 現状は「全てを送信」を押した利用者が、1 枚ずつ Gemini の応答を画面で待っている
--   (scan.astro sendAll → await fetch('/api/scan') → サーバは await callGemini())。
--   1 枚 30〜50 秒の記録があり (astro.config.mjs:9-11)、6 枚なら数分。しかもページ列は
--   メモリだけなので、送信中にタブを閉じると全ページ失われる。
--   → **ユーザーは送信で完了**とし、読み取りはサーバ側で進める (発注者判断 2026-09-10)。
--
-- 【なぜ test_artifacts に相乗りさせないか】
--   あちらは「確定した検査 1 件」を表す。失敗・再試行・途中経過を同じ行に持たせると
--   「検査が 1 件ある」の意味が濁る。ジョブは別表にし、完了したら artifact_id で結び付ける。
--
-- 【PII】この表に氏名・生年月日等は入れない (diagnosis スキーマ = 非PII)。
--   持つのは diagnostic_user_id と S3 キーだけ。**キーはログに出さない**。
--   画像そのものは S3 (scan-uploads/) にあり、**ライフサイクルで 1 日後に自動削除**される
--   (2026-09-04 適用済)。ワーカーは読み終わった時点でも DeleteObject する (二段構え)。
--
-- 適用は発注者が行う (CLAUDE.md「Claude 側では Production DB を変更しない」)。
-- **適用後にこのファイルを編集しないこと** — 直すときは前進マイグレーションを足す。

create table if not exists diagnosis.scan_jobs (
  id                 uuid primary key default gen_random_uuid(),

  -- 誰のスキャンか。test_artifacts と同じ型・同じ参照先にそろえる。
  diagnostic_user_id uuid not null references diagnosis.app_users(diagnostic_user_id),

  -- queued  … 登録直後。ワーカーがまだ拾っていない
  -- running … ワーカーが処理中 (locked_until まで他のワーカーは触らない)
  -- done    … 全枚数を処理し、結果を保存し終えた
  -- failed  … attempts を使い切った / 復旧不能。**黙って消さない**ための終端
  status             text not null default 'queued'
                       check (status in ('queued','running','done','failed')),

  -- 読み取る画像の S3 キー。**順番が紙の順番**なので配列で持つ (順序を失わない)。
  -- 値は scan-upload-ticket.ts が採番したものだけ。isScanUploadKey の完全一致を通る形。
  image_keys         text[] not null,

  -- 総枚数と、何枚まで終わったか。**途中で関数が時間切れになっても続きから再開する**ための位置。
  -- image_keys の長さと重複するが、配列長に依存した式を毎回書かずに済むよう持つ。
  page_count         int  not null,
  done_count         int  not null default 0,

  -- 読み取れなかった枚数。ジョブ自体は成功 (done) でも 0 でないことがある
  -- = 「成功分だけで先へ進む」現行の思想を引き継ぐ。admin の監視対象。
  failed_pages       int  not null default 0,

  -- 利用者が入れた読み取りヒント (画面の #scan-hint)。PII を意図した欄ではない。
  hint               text,

  -- 束ねた markdownClean (mergeResults → sanitizeMeasurementsForDelivery 通過後)。
  -- 保存の実体は test_artifacts 側なので、ここは監査・再実行のための控え。
  result_markdown    text,

  -- 保存先の検査 1 件。**後から読み取り結果を確認・修正する画面はここから辿る**
  -- (発注者判断 2026-09-10「確認は任意にする」= 案B)。
  -- 検査ごと消えたときにジョブまで消さないよう on delete set null。
  artifact_id        uuid references diagnosis.test_artifacts(id) on delete set null,

  -- 人が読み取り結果を確認した時刻。**null = 未確認**。
  -- 確認は任意なので null のままでも運用は回る。admin が「疑念ありなのに未確認」を
  -- 拾うための印であって、これを理由に納品を止めない。
  verified_at        timestamptz,

  -- 失敗の理由。ユーザーには出さない (発注者判断: 問題はこちら側で対応する) ので、
  -- **ここに残らないと誰も気づけない**。
  error              text,

  -- 自動再試行の回数。上限 (3) を超えたら status='failed' で止める。
  attempts           int  not null default 0,

  -- 二重起動よけ。cron が重なっても同じジョブを 2 度処理しない。
  -- 期限切れ = ワーカーが落ちたとみなして他のワーカーが拾い直せる。
  locked_until       timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table diagnosis.scan_jobs is
  'ユーザーのスキャンをバックグラウンドで読み取るためのジョブ。画像本体は S3 (scan-uploads/) にあり 1 日で自動削除。正本 docs/scan/スキャン非同期処理_仕様書.md';
comment on column diagnosis.scan_jobs.image_keys is
  'S3 キー。順番が紙の順番。**ログに出さない**。画像は 1 日で自動削除されるため、滞留したジョブは復旧不能になる (その場合は failed で残す)';
comment on column diagnosis.scan_jobs.verified_at is
  '人が読み取り結果を確認した時刻。null=未確認。確認は任意 (発注者判断 2026-09-10・案B) なので、null を理由に納品を止めない';

-- ワーカーが「次に処理すべき 1 件」を拾うための索引。
-- 対象は未終了のジョブだけなので部分索引にする (done/failed が積もっても劣化しない)。
create index if not exists ix_scan_jobs_pick
  on diagnosis.scan_jobs(status, locked_until)
  where status in ('queued','running');

-- admin の監視: 失敗・滞留の一覧 (新しい順)。
create index if not exists ix_scan_jobs_status_created
  on diagnosis.scan_jobs(status, created_at desc);

-- 本人のジョブを引く (後追い確認の導線)。
create index if not exists ix_scan_jobs_user_created
  on diagnosis.scan_jobs(diagnostic_user_id, created_at desc);

-- `create trigger` には if not exists が無く、ここだけ再適用でエラーになる
-- (他は全て if not exists)。既存の 20260621000010 と同じく drop してから作る。
drop trigger if exists scan_jobs_touch_updated_at on diagnosis.scan_jobs;
create trigger scan_jobs_touch_updated_at before update on diagnosis.scan_jobs
  for each row execute function diagnosis.touch_updated_at();

-- ── 権限 ────────────────────────────────────────────────────────────
-- **service_role だけが読み書きする。ポリシーは 1 つも置かない。**
--   この表は S3 キー (= PII を含む検査票画像への参照) を持つので、
--   既存 diagnosis 系の "dev_read_all" (select using true) を真似しない。
--   RLS 有効 + ポリシー無し = service_role 以外は 0 行しか見えない。
-- ※ 20260601000020 の `grant select on all tables in schema diagnosis to anon, authenticated`
--   は**その時点の表への一括付与**で、後から作る表には効かない (default privileges ではない)。
--   それでも取り違えが起きないよう明示的に revoke しておく。
alter table diagnosis.scan_jobs enable row level security;
alter table diagnosis.scan_jobs force row level security;

revoke all on diagnosis.scan_jobs from anon, authenticated;
grant  all on diagnosis.scan_jobs to service_role;
