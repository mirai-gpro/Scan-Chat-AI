-- diagnosis.scan_jobs に「Elith 納品の書き出しに要る 2 つ」を足す。
--
-- 【なぜ要るか】
-- 前景経路 (結果画面の「✓ 確認して送信」) は DB 保存と一緒に
-- **Elith 納品 JSON の S3 書き出し** (`/api/scan/export`) も行っていた。
-- 送信をバックグラウンド化すると書き出しはワーカー側で行うことになるが、
-- ワーカーは以下 2 つを知らないと前景と同じ納品物を作れない:
--   * diagnostic_id   … 納品先フォルダ名 (端末が採番し、同じ回で使い回す UUID)
--   * source_file_name … 書き出しファイル名に混ぜる元ファイル名の一部
-- どちらも無ければ null。**null を理由に書き出しを止めない**
-- (diagnostic_id はサーバ側で採番、ファイル名はスラグ無しになるだけ)。
--
-- **前進マイグレーション。** 20260910000010 は編集しない
-- (適用済みの環境では編集分が push でスキップされ、同じ名前で中身の違う DB が並ぶ)。

alter table diagnosis.scan_jobs
  add column if not exists diagnostic_id    uuid,
  add column if not exists source_file_name text;

comment on column diagnosis.scan_jobs.diagnostic_id is
  'Elith 納品フォルダ名に使う診断 ID (端末採番)。null ならワーカーが採番する。';
comment on column diagnosis.scan_jobs.source_file_name is
  '読込元ファイル名。納品ファイル名のスラグにだけ使う。PII を意図した欄ではない。';
