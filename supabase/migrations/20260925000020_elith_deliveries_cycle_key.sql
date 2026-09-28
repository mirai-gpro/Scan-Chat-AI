-- ============================================================================
-- elith_deliveries に Diagnosis Cycle 冪等キーを追加 (P0-2 §15)
--
-- 正本: 最終実装指示 §15 / P0-2_修正設計案_rev3.md §9
--
-- 【なぜ要るか】従来の一意制約 (diagnostic_user_id, bundle_date, delivery_prefix) は
--   「同じ人・同じ日・同じ納品先へ二重に書かない」ものであって、
--   **「同じ回の一式か」を保証しない**。契約者の Diagnosis Cycle 単位納品では
--   回そのものをキーにする必要がある。
--
-- 【方針: 追加のみ】
--   - 既存の一意制約は **落とさない**（単品/スペシャル経路は従来キーをそのまま維持）。
--   - 契約者経路には **部分 unique index** を足す（subscription_id が入っている行だけ対象）。
--   - 2 系統が併存する。単品経路の行は新 3 列が NULL のままなので新 index の対象外。
--
-- 【既存制約との相互作用（既知・意図的）】
--   契約者経路の行も従来の (uid, bundle_date, delivery_prefix) 制約は受ける。
--   万一 2 つの Diagnosis Cycle が同じ bundle_date で納品されようとすると 2 件目が弾かれる。
--   これは **fail-closed（二重納品より安全）** であり、エラーとして表に出る（黙って消えない）。
-- ============================================================================

alter table diagnosis.elith_deliveries
  add column if not exists subscription_id     uuid    null,
  add column if not exists cycle_year          integer null,
  add column if not exists diagnosis_cycle_seq integer null;

comment on column diagnosis.elith_deliveries.subscription_id is
  '契約者経路のみ。単品/スペシャルは NULL（従来キーで冪等を取る）';
comment on column diagnosis.elith_deliveries.diagnosis_cycle_seq is
  'Diagnosis Cycle の回次。発送回次(cycle_seq)とは別物';

-- 契約者経路の冪等キー: (uid, subscription_id, cycle_year, diagnosis_cycle_seq, delivery_prefix)
create unique index if not exists uq_elith_deliveries_diagnosis_cycle
  on diagnosis.elith_deliveries
     (diagnostic_user_id, subscription_id, cycle_year, diagnosis_cycle_seq, delivery_prefix)
  where subscription_id is not null;

-- 回で引く用（cron が「この回は納品済みか」を見る）
create index if not exists idx_elith_deliveries_cycle
  on diagnosis.elith_deliveries (subscription_id, cycle_year, diagnosis_cycle_seq)
  where subscription_id is not null;
