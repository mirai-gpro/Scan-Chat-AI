-- ════════════════════════════════════════════════════════════════════════════
-- 臨時診断バッチ — 分割分類 (classify-plan / classify-entry / classify-finalize)
-- Phase B2.1・2026-09-12
--
-- **なぜ要るか**: 159MB / 38 ファイル (Genoplan PDF ≒21MB × 10) の ZIP を
-- 1 リクエストで全部展開・解析していたため、`maxDuration=800` でも
-- `FUNCTION_INVOCATION_TIMEOUT` になった。**タイムアウトを伸ばすのでなく、
-- 1 リクエスト = ZIP 内 1 ファイル**に分割する。
--
-- **前進マイグレーションのみ。** 既存 (`20260910000020` / `20260911000010`) は編集しない。
-- 既存バッチは `archive_entry_index` / `normalized_payload` とも NULL で始まり、
-- **後方互換** (どちらも nullable・既定なし)。
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) ZIP 内の位置 (Central Directory の序数)
--
-- **path も元ファイル名も人物フォルダ名も保存しない** (§8.1 の PII 規則は不変)。
-- 保存してよいのは「Central Directory の何番目か」という **整数だけ**。
-- これがあると、後工程が ZIP 全体を再解析せずに目的の 1 エントリへ直行できる。
-- ────────────────────────────────────────────────────────────────────────────

alter table diagnosis.ad_hoc_diagnosis_files
  add column if not exists archive_entry_index integer;

alter table diagnosis.ad_hoc_diagnosis_files
  drop constraint if exists ad_hoc_diagnosis_files_archive_entry_index_check;
alter table diagnosis.ad_hoc_diagnosis_files
  add constraint ad_hoc_diagnosis_files_archive_entry_index_check
  check (archive_entry_index is null or archive_entry_index >= 0);

comment on column diagnosis.ad_hoc_diagnosis_files.archive_entry_index is
  'ZIP の Central Directory における序数 (0 始まり) = **不透明な位置情報**。'
  ' **path / 元ファイル名 / 人物フォルダ名は保存しない** — これらは処理中のメモリでだけ使う。'
  ' 分割分類より前に作られた行は NULL。';

-- **同じエントリから 2 行作らない** (再実行を冪等にする土台)。
-- NULL は何行でも許す = 旧バッチの行と共存できる。
create unique index if not exists ad_hoc_diagnosis_files_batch_entry_unique
  on diagnosis.ad_hoc_diagnosis_files (batch_id, archive_entry_index)
  where archive_entry_index is not null;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) 正規化済みの解析結果
--
-- 健診 XLSX / 問診 を **その 1 エントリを読んだそのとき**に正規化して保存する。
-- これが無いと、process / ウェルネス年齢 / dry-run のたびに ZIP を開き直して
-- 全ファイルを再展開することになり、**分割分類だけでは結局タイムアウトする**。
--
-- **入れてよいもの** = `buildHealthCheckupJson()` / `buildQuestionnaireJson()` を
-- 後から再実行するのに必要な最小限だけ。
-- **入れてはならないもの** = 氏名 / メール / 会社名 / 役職 / path / 元ファイル名 /
-- 人物フォルダ名。**遺伝子 PDF の本文・ページ画像も保存しない** (ページは既存の
-- `ad_hoc_diagnosis_pages` が持つ)。
--
-- 書き込み前に `normalized-payload.ts` の sanitizer が禁止キーを検査し、
-- **1 つでも見つかったら DB へ書かずに throw する** (黙って PII を通さない)。
-- ────────────────────────────────────────────────────────────────────────────

alter table diagnosis.ad_hoc_diagnosis_files
  add column if not exists normalized_payload jsonb;

comment on column diagnosis.ad_hoc_diagnosis_files.normalized_payload is
  '健診 / 問診の正規化済み解析結果 (再解析せずに Elith JSON を組み直すための最小限)。'
  ' **氏名・メール・会社名・役職・path・元ファイル名・人物フォルダ名は禁止**'
  ' (書き込み前に sanitizer が検査し、見つかれば throw する)。'
  ' 遺伝子 PDF の本文・ページ画像は入れない (ページは ad_hoc_diagnosis_pages)。'
  ' 分割分類より前に作られた行は NULL。';
