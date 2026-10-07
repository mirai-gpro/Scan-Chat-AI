-- AI疾病予防報告書: **承認した紙面の指紋**を控える列。
--
-- 正本: `docs/elith/AI疾病予防報告書_承認と再作成_仕様書.md` §3.3
--
-- 【なぜ要るか】紙面は DB に保存されておらず、表示のたびに `buildReportVM()` が組む。
--   つまり一度承認したあとに**生成ロジックを直してデプロイすると、
--   `publish_status='approved'` のまま紙面だけが変わる**。それでは
--   「管理者が実際に確認した報告書だけを公開する」を満たさない。
--   → 承認した時点の紙面の指紋 (SHA-256) を控え、**表示時に一致しなければ公開しない**。
--
-- 【報告書そのものは保存しない・版も持たない】控えるのは 64 文字のハッシュ 1 本だけ。
--   revision テーブルも過去版も作らない (§11.3)。
--
-- 【既存行は NULL のまま】`20261007000010` が `approved` へ移行した行には
--   承認時の紙面が無いので照合できない。**NULL は「指紋なし」= 従来どおり公開**
--   として扱う (§4・受入条件 1)。ハッシュのゲートは**新しい承認 API で
--   承認した回から**効く。
--
-- 後方互換 (列の追加のみ)。**アプリより先に DB へ適用する** (CLAUDE.md migration 規約)。
-- 本番投入順は ① DB migration ② Scan-Chat-AI ③ wellfort-site (§13.1)。

alter table diagnosis.diagnosis_results
  add column if not exists approved_report_hash text;

comment on column diagnosis.diagnosis_results.approved_report_hash is
  '承認した時点の紙面の指紋 (SHA-256 16進 64文字)。表示時に同じ方法で算出した値と'
  ' 一致しなければユーザーへ出さない (生成ロジックの変更で紙面が変わった回を検知する)。'
  ' NULL = 指紋なし (migration で approved へ移行した既存行・この機能より前の承認) で、'
  ' 従来どおり公開する。再作成すると NULL に戻る。'
  ' 対象は受領 JSON・生成ロジック・app_config から作られる部分で、'
  ' 閲覧者ごとに注入される値 (氏名・実年齢・ウェルネス年齢・第N回) は含まない。';
