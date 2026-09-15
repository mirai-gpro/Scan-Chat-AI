-- AI 問診の「完了した」という事実だけを残す (発注者裁定 2026-09-15)。
--
-- 背景 (実測): 完了は**どこにもサーバ側の記録が無かった**。
--   ・`/api/interview/export` は S3 へ書くだけで Supabase への書き込みが 0 件
--   ・完了記録は端末の localStorage のみ (`src/lib/session-store.ts` の InterviewResult)
--   → **スマホで問診 → PC で開くと「未回答」に見える**。ダッシュボードの進捗
--     (「AI疾病予防報告書 単品購入」の ① AI問診) を出す根拠が無い。
--
-- 【回答の中身は保存しない】answers には設問 `M-NAME` (服薬名) など医療情報が入る。
--   ここに残すのは **完了日時と設問数だけ**。中身が要るのは Elith 納品の JSON で、
--   それは従来どおり S3 へ書く (`interview-export.ts`)。**保管場所を増やさない。**
--
-- 【なぜ test_artifacts に相乗りしないか】`test_type` の CHECK は
--   health_checkup|blood|genetics|cancer_urine|ai_prediction の 5 値 (20260601000010:193)。
--   問診は検査ではないので値を足すと「検査結果 5 種」の一覧にも現れてしまう
--   (`TestResultsSection.astro` は test_artifacts を種別で引いている)。別表にする。
--
-- 非PII (diagnosis スキーマ)。氏名・住所・生年月日・回答本文は含めない。

create table if not exists diagnosis.interview_completions (
  id                 uuid primary key default gen_random_uuid(),
  diagnostic_user_id uuid not null references diagnosis.app_users(diagnostic_user_id),

  -- 問診を完了した日時。**クライアント申告の completedAt をそのまま入れない** —
  -- 書き込み側 (`src/lib/interview-completion.ts`) が妥当性を見てから渡す。
  completed_at       timestamptz not null,

  -- 回答した設問の数。**中身は入れない** (監査で「空の完了」を見分けるためだけ)。
  answered_count     int not null default 0,

  -- 書き出しに使った識別子。S3 側の納品物 (LifestyleQuestionnaireData_*) と突き合わせる用。
  diagnostic_id      text,

  created_at         timestamptz not null default now()
);

comment on table diagnosis.interview_completions is
  'AI問診を完了した事実の記録。回答の中身は持たない (中身は S3 の LifestyleQuestionnaireData)。';
comment on column diagnosis.interview_completions.answered_count is
  '回答した設問数のみ。設問 id も回答値も保存しない (M-NAME 等の医療情報を診断系に置かないため)。';

-- 「この人の最新の完了はいつか」だけを引く。ダッシュボードの hot path なのでこの 1 本で足りる。
create index if not exists ix_ic_user_completed
  on diagnosis.interview_completions(diagnostic_user_id, completed_at desc);

alter table diagnosis.interview_completions enable row level security;
grant select on diagnosis.interview_completions to anon, authenticated;
grant all    on diagnosis.interview_completions to service_role;

-- 既存テーブルと同方針 (サーバは service_role で RLS バイパス)。再実行で詰まらないよう冪等。
drop policy if exists "dev_read_all"    on diagnosis.interview_completions;
drop policy if exists "dev_authn_write" on diagnosis.interview_completions;
create policy "dev_read_all"    on diagnosis.interview_completions for select using (true);
create policy "dev_authn_write" on diagnosis.interview_completions for all to authenticated using (true) with check (true);
