-- ============================================================================
-- diagnosis.cycle_links — Diagnosis Cycle と検査/問診データの相関 (P0-2 §9)
--
-- 正本: P0-2_修正設計案_rev3.md §5 / 最終実装指示 §9
--
-- 【なぜ要るか】Wellfort が「第2回」を確定しても、**S3 のどの source が第2回なのかを
--   Scan 側が特定できない**。`diagnosis.test_artifacts` は test_date / test_type しか持たず、
--   cycle 列が無いため。かといって **test_date から cycle を推測するのは禁止**（境界で必ず誤る）。
--   → 取込の時点で Wellfort 確定の (subscription_id, cycle_year, diagnosis_cycle_seq) を
--     明示的に受け取り、その場で相関を記録する。
--
-- 【なぜ既存表に列を足さないか】検査は test_artifacts、問診は interview_completions と
--   **別表**なので、列を足すと相関が 2 系統に割れる。取込経路も 8 つあり、
--   各経路で列をセットする改修が要る。link 表 1 つなら **既存表を 1 列も変えずに**
--   全 format を一貫して追跡できる。
--
-- 【1 Diagnosis Cycle × 1 format = 正式採用 source は 1 つ】を UNIQUE で構造担保する。
--
-- 追加のみ。既存テーブルの変更なし。
-- ============================================================================

create table if not exists diagnosis.cycle_links (
  id                  uuid primary key default gen_random_uuid(),
  diagnostic_user_id  uuid not null references diagnosis.app_users(diagnostic_user_id),
  -- Wellfort 側の契約。診断側には subscriptions が無いので FK は張らない（スキーマが別）。
  subscription_id     uuid not null,
  cycle_year          integer not null check (cycle_year >= 1),
  diagnosis_cycle_seq integer not null check (diagnosis_cycle_seq >= 1),
  -- Elith の format_id。'HealthAgeData' は算出物なのでここには入れない。
  format_id           text not null
                        check (format_id in ('HealthCheckupData','LifestyleQuestionnaireData',
                                             'BloodTestData','CancerRiskAssessmentData',
                                             'GeneticTestResultData','Other')),
  -- 実体への参照。検査は test_artifacts の行、問診は null（completions は id を持たない運用）。
  artifact_id         uuid null references diagnosis.test_artifacts(id) on delete set null,
  -- **納品時に採用する S3 source key**。exact-source モードはこれだけを納品する。
  source_ref          text null,
  -- どの経路が作ったか（監査）。auto_open_cycle / admin_batch / lab_intake 等。
  linked_by           text not null,
  note                text,
  linked_at           timestamptz not null default now(),
  -- 1 回 × 1 format につき採用 source は 1 つだけ。
  unique (subscription_id, cycle_year, diagnosis_cycle_seq, format_id)
);

comment on table diagnosis.cycle_links is
  'Diagnosis Cycle と検査/問診データの相関。1 回 × 1 format = 正式採用 source 1 つ。'
  ' date から cycle を推測して作ってはならない（Wellfort 確定値を取込時に受け取る）';
comment on column diagnosis.cycle_links.source_ref is
  '納品時に採用する S3 source key。exact-source モードはこれだけを納品する（全date展開しない）';
comment on column diagnosis.cycle_links.linked_by is
  '作成経路の識別子（監査用）。auto_open_cycle = ブラウザ発の open cycle 自動 link / admin_batch 等';

create index if not exists idx_cycle_links_user
  on diagnosis.cycle_links (diagnostic_user_id);
create index if not exists idx_cycle_links_cycle
  on diagnosis.cycle_links (subscription_id, cycle_year, diagnosis_cycle_seq);

alter table diagnosis.cycle_links enable row level security;

-- 既存 diagnosis スキーマと同じ開発ポリシー（本番移行時に service_role 限定へ絞る宿題は既存と同様）。
do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname = 'diagnosis' and tablename = 'cycle_links'
                   and policyname = 'dev_authn_write') then
    create policy dev_authn_write on diagnosis.cycle_links
      for all to authenticated using (true) with check (true);
  end if;
end $$;
