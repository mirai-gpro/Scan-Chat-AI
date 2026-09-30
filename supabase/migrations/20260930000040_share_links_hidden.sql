-- 共有リンクの**論理削除**（仕様書 §33.2「一覧から隠すだけ。ログは消さない」）。
--
-- 【なぜ物理削除しないか】`shared_access_logs.share_link_id` が参照しているので、
-- 行を消すと **「誰がいつ見たか」の記録が link と結び付かなくなる**
-- （`on delete set null` なので消えはしないが、どのリンクの記録か分からなくなる）。
-- PDF の「アクセス記録確認」は共有機能の売りなので、**記録は残す**。
--
-- 【revoke とは別の概念】
--   revoke … アクセスを止める（不可逆・利用者側に効く）
--   hidden … admin の一覧から隠すだけ（アクセス可否は変えない）
-- 隠す前に revoke するかは admin の操作に委ねる（API 側で強制しない）。

alter table diagnosis.shared_access_links
  add column if not exists hidden_at timestamptz;

comment on column diagnosis.shared_access_links.hidden_at is
  '論理削除。admin 一覧から隠すだけで、アクセス可否とログには影響しない（仕様書 §33.2）。';
