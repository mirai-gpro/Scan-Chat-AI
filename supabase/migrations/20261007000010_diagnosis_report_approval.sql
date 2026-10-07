-- AI疾病予防報告書の **管理者承認ゲート**。
--
-- 正本: `docs/elith/AI疾病予防報告書_承認と再作成_仕様書.md`
--
-- 【何を足すか】`diagnosis.diagnosis_results` に公開状態を持たせる。
--   publish_status  pending  … 未承認。**ユーザーには出さない**
--                   approved … 承認済。ユーザーのダッシュボードに出る
--   approved_at / approved_by … 誰がいつ承認したか
--   publish_rev     … 再作成のたびに +1 する**世代番号ではなく競合検知用のカウンタ**
--
-- 【なぜ既存の `status` を使わないか】
--   `status` (received | extracted | published | superseded) は**世代管理**を兼ねている。
--   取込は「既存行を superseded に落として新しい行を足す」ので、承認状態を同じ列に
--   載せると**差し替えのたびに承認の履歴が消える**。さらに `status='published'` は
--   `coach-context.ts:60` / `chat-context.ts:115` / `result-queries.ts:215` /
--   `dashboard-queries.ts:312` の 4 か所が読んでおり (実データでは一度も立たないため
--   現在は死蔵)、ここへ承認の意味を持ち込むと**その 4 経路の挙動が黙って変わる**。
--   → 承認は専用の列に分ける。`status` は 1 文字も触らない。
--
-- 【既存行を未承認にしない (仕様書 §4・受入条件 1)】
--   `add column ... default 'pending'` と書くと**既存の全行が pending** になり、
--   いま表示されている報告書が導入した瞬間に全部消える。だから
--     ① 列を null 許容で足す → ② 既存行を approved で埋める → ③ 既定を pending にする
--   の順で行う。**今後 insert される行だけが pending** になる。
--
-- 【competing update 用のカウンタ】`publish_rev` は履歴ではない。
--   承認 API が `where id = ? and publish_status='pending' and publish_rev = ?` で
--   更新するためだけに在る (再作成が割り込んだ回を承認で上書きしないため・仕様書 §9)。
--
-- 後方互換 (列の追加のみ)。**アプリより先に DB へ適用してよい** (CLAUDE.md migration 規約)。
-- アプリ側は列が無い環境では「全行 approved 相当」として振る舞うので、
-- 適用前にデプロイしても**公開中の報告書が消えることはない** (順序事故の保険)。

-- ① 列を足す (既定を付けない = 既存行は null のまま)
alter table diagnosis.diagnosis_results
  add column if not exists publish_status text,
  add column if not exists approved_at    timestamptz,
  add column if not exists approved_by    text,
  add column if not exists publish_rev    integer;

-- ② 既存行は「承認済」として移行する (導入時に非表示にしない)
update diagnosis.diagnosis_results
   set publish_status = 'approved'
 where publish_status is null;

update diagnosis.diagnosis_results
   set publish_rev = 0
 where publish_rev is null;

-- ③ ここから先に入る行は未承認から始める
alter table diagnosis.diagnosis_results
  alter column publish_status set default 'pending',
  alter column publish_status set not null,
  alter column publish_rev    set default 0,
  alter column publish_rev    set not null;

alter table diagnosis.diagnosis_results
  drop constraint if exists diagnosis_results_publish_status_check;

alter table diagnosis.diagnosis_results
  add constraint diagnosis_results_publish_status_check
  check (publish_status in ('pending', 'approved'));

-- 管理一覧は「未承認 / 承認済」を新しい順に引く。
create index if not exists ix_dr_publish_status_received
  on diagnosis.diagnosis_results(publish_status, received_at desc);

comment on column diagnosis.diagnosis_results.publish_status is
  'ユーザーダッシュボードへの公開状態。pending=未承認 (ユーザーには返さない) / approved=承認済。'
  ' 既存の status (received|extracted|published|superseded) は世代管理なので別物。';
comment on column diagnosis.diagnosis_results.approved_at is
  '承認日時。pending のときは null。';
comment on column diagnosis.diagnosis_results.approved_by is
  '承認した管理者。**生のメールアドレスは入れない** — adminIdentity() の'
  ' 鍵つき HMAC digest (base64url 43 文字) だけを入れる (elith_delivery_runs.triggered_by と同じ流儀)。';
comment on column diagnosis.diagnosis_results.publish_rev is
  '再作成のたびに +1 するカウンタ。**履歴ではない** — 承認 API の条件付き更新に使い、'
  ' 「確認した内容と違うものを承認してしまう」事故を防ぐためだけに在る。';
