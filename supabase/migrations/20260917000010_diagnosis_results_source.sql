-- diagnosis.diagnosis_results に「どの S3 フォルダから取り込んだか」を持たせる。
--
-- 【なぜ要るか】
-- Elith の下り (output/user/{client_id}/date/{YYYY_MM_DD}/) を**毎日自動で取り込む**
-- ようになると、同じフォルダを二度取り込まない仕組みが要る。取込 API は
-- 「既存行を superseded にして新しい行を足す」ので、**同じ材料で 2 回走ると
-- 中身の同じ行が 2 つ増える**(世代管理は「最新 1 件」なので画面は壊れないが、
-- 監査で「2 回届いた」と誤読する)。
--
-- 【日付で絞らない】取り込み対象は「昨日ぶん」ではなく「まだ取り込んでいないもの」。
-- Elith は 1 件 20 分・深夜 0 時起動なので、件数が増えた日は朝 9 時の実行を追い越す。
-- 日付で絞ると**追い越したぶんが二度と拾われない**。この列があると
-- 「取り込み済みか」を材料そのもので判定でき、走らない日があっても次の成功回が
-- まとめて回収する (デメカルの `last_to` 単調前進と同じ考え方)。
--
-- 【部分 unique index にする理由】既存行は null のまま。null は unique の対象外なので
-- 何行あっても衝突しない。**取り込み経路を通った行だけ**が一意になる。
--
-- 後方互換 (列の追加のみ)。**アプリより先に DB へ適用してよい** (CLAUDE.md migration 規約)。

alter table diagnosis.diagnosis_results
  add column if not exists source_key text;

comment on column diagnosis.diagnosis_results.source_key is
  '取り込み元。Elith 下りの S3 フォルダ (例 output/user/<uuid>/date/2026_09_16/)。手動アップロードは null。';

create unique index if not exists diagnosis_results_source_key_uniq
  on diagnosis.diagnosis_results (source_key)
  where source_key is not null;
