-- ════════════════════════════════════════════════════════════════════════════
-- Executive Diagnosis — 人物の紐付けと validation_status の是正 (Phase B1・2026-09-11)
--
-- **前進マイグレーションのみ。** `20260910000020_ad_hoc_diagnosis.sql` は編集しない
-- (適用済みのファイルを直しても `db push` はスキップするので、新環境にしか届かず
--  同じファイル名で中身の違う DB が並ぶ。CLAUDE.md の確定事項)。
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) 人物 → Executive 人物マスタ の紐付け
--
-- **ここに入れてよいのは UUID 1 つだけ。**
-- 氏名・メール・会社名・役職は Wellfort の `public.executive_subjects` にしか置かない
-- (`diagnosis` スキーマは PII を持たない、が全体の設計前提)。
-- ────────────────────────────────────────────────────────────────────────────

alter table diagnosis.ad_hoc_diagnosis_subjects
  add column if not exists executive_subject_id uuid;

comment on column diagnosis.ad_hoc_diagnosis_subjects.executive_subject_id is
  'Wellfort public.executive_subjects.id への opaque な外部参照。'
  ' **別 Supabase プロジェクトに跨りうるので外部キーは張らない。**'
  ' PII (氏名/メール/会社名/役職) は Wellfort 側にしか無く、ここへは持ち込まない。';

create index if not exists ad_hoc_diagnosis_subjects_executive_idx
  on diagnosis.ad_hoc_diagnosis_subjects (executive_subject_id)
  where executive_subject_id is not null;

-- **同じバッチの中で同じ Executive を 2 人に割り当てない。**
-- 取り違えたまま 2 人分の納品 JSON が出ると、誰のデータか後から判別できなくなる。
-- 未割当 (NULL) は何人でも許す。
create unique index if not exists ad_hoc_diagnosis_subjects_batch_executive_unique
  on diagnosis.ad_hoc_diagnosis_subjects (batch_id, executive_subject_id)
  where executive_subject_id is not null;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) `outputs.validation_status` の値域をコードに合わせる
--
-- コードは `pending` / `ok` / `warn` / `error` を書くが (`store.ts` の
-- `ValidationStatus`・`service.ts` が `warn` と `error` を実際に渡す)、
-- 元マイグレーションの CHECK は `('pending','ok','invalid')` だった。
-- つまり **失敗ページがある遺伝子や、整形に失敗した行を書こうとすると DB が弾く**。
--
-- 既存値との互換のため `invalid` は**残したまま** `warn` / `error` を足す。
-- 既に `invalid` の行があっても落とさない。
--
-- 制約名は元ファイルが**列インラインの無名 CHECK** で作っているため、
-- 生成名を決め打ちせず `pg_constraint` から実際の名前を引いて落とす。
-- ────────────────────────────────────────────────────────────────────────────

do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class      rel on rel.oid = con.conrelid
    join pg_namespace  nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'diagnosis'
      and rel.relname = 'ad_hoc_diagnosis_outputs'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%validation_status%'
  loop
    execute format(
      'alter table diagnosis.ad_hoc_diagnosis_outputs drop constraint %I', c.conname
    );
  end loop;
end
$$;

alter table diagnosis.ad_hoc_diagnosis_outputs
  add constraint ad_hoc_diagnosis_outputs_validation_status_check
  check (validation_status in ('pending','ok','invalid','warn','error'));

comment on column diagnosis.ad_hoc_diagnosis_outputs.validation_status is
  'pending / ok / warn / error をコードが書く。'
  ' invalid は旧値との互換のために残してあり、新しくは書かない。';
