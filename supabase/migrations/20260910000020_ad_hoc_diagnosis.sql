-- 臨時診断バッチ (ad-hoc diagnosis batch) の状態表 6 本。
-- 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md (v0.3・2026-09-10)。
--
-- 企業・団体から臨時に受領した「複数人分の検査データ一式 (ZIP)」を、管理者が投入し
-- 分類 → 人物単位の整理 → 構造化 → 管理者確認 → Elith 納品 まで進めるための状態を持つ。
-- UI は wellfort-site / 処理は Scan-Chat-AI (spec §4)。
--
-- 【なぜ既存表に相乗りさせないか】(spec §23.5)
--   diagnosis.test_artifacts は「確定した検査 1 件」で diagnostic_user_id (app_users への FK) を要求する。
--   臨時バッチの被験者は EC 顧客でもアプリ利用者でもなく app_users に行が無いので**そのままでは入らない**。
--   app_users に偽の行を作るのは識別と PII の設計に反する。よって別表にする。
--   diagnosis.scan_jobs とも別 (あちらは利用者 1 人のスキャン。こちらは複数人分の取込バッチ)。
--
-- 【PII】この 6 表に **氏名・生年月日・社員番号・元ファイル名・フォルダ名を保存しない** (spec §6.1 / §8)。
--   持つのは性別・年齢・内容ハッシュ・S3 キーだけ。**S3 キーと各種ハッシュをログに出さない。**
--   **内容ハッシュ (sha256 / subject_fp) は平文 PII を含まないが、特定個人のファイルに
--   1 対 1 で対応する照合用識別子なので、機微情報と同等に扱う。**
--   ZIP と展開ファイルは Elith バケットの一時領域 {prefix}ad-hoc-uploads/ にあり、
--   **ライフサイクルで失効させる** (spec §24.4。AWS 側の作業が別途 1 つ要る)。
--
-- 適用は発注者が行う (CLAUDE.md「Claude 側では Production DB を変更しない」)。
-- **Production DB へ適用しない。** **適用後にこのファイルを編集しないこと** —
-- 直すときは前進マイグレーションを足す。


-- ════════════════════════════════════════════════════════════════════
-- 1) ad_hoc_diagnosis_batches — 取込 1 回分
-- ════════════════════════════════════════════════════════════════════
create table if not exists diagnosis.ad_hoc_diagnosis_batches (
  id                 uuid primary key default gen_random_uuid(),

  -- 管理者が付ける案件名 (例「○○社 10名 デモ 2026-09」)。**氏名を入れない運用**。
  title              text not null,

  -- draft            … ticket 発行直後。ZIP はまだ届いていない
  -- uploaded         … S3 に ZIP が置かれた (実サイズ検証も通った)
  -- classified       … 展開・分類が終わり、管理者の確認待ち
  -- processing       … 変換 (スキャン/ページ処理) が進行中
  -- needs_review     … 管理者の判断が要る人物・ファイルが残っている
  -- ready            … required_formats が揃い、確定できる
  -- exporting        … S3 への書き出し中
  -- completed        … 書き出し完了
  -- failed           … 復旧不能。**黙って消さない**ための終端
  status             text not null default 'draft'
                       check (status in ('draft','uploaded','classified','processing',
                                         'needs_review','ready','exporting','completed','failed')),

  -- この診断回の単位日 = **Elith の date フォルダになる** (spec §14)。
  -- 各検査の実施日 (test_date) とは別物なので、**最初から同一値に潰さない**。
  -- 決められないうちは null (今日の日付で埋めない)。
  bundle_date        date,

  -- 投入された ZIP の SHA-256 (16 進小文字)。
  -- **再開時に「同じ ZIP か」を判定する唯一の入口** (spec §6.2.3-1)。
  -- これが一致しない ZIP を同じバッチの続きとして扱わない。
  source_sha256      text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),

  -- ZIP のサイズは**申告値と実測値を分けて持つ** (v0.4)。
  --   batch 行が出来るのは presigned ticket を発行する時点で、**まだ PUT が済んでいない**。
  --   その時点に HeadObject の実測値は存在しないので、1 列に混ぜると
  --   「申告値を実測値として保存する」ことになってしまう。
  --
  -- ticket 発行時にブラウザが申告したサイズ。**上限の一次判定に使うだけで信用しない**。
  declared_source_size bigint not null check (declared_source_size >= 0),
  --
  -- PUT 完了後に **HeadObject で確認した実サイズ**。classify の冒頭で確定させる。
  -- **確定するまで null**。上限超過ならバッチを failed にし、一時 ZIP を削除する。
  -- Content-Length が署名に固定されるかは未確認なので (spec §5.2.1)、**ここが主防御**。
  source_size        bigint check (source_size is null or source_size >= 0),

  -- S3 キー。形は {prefix}ad-hoc-uploads/{batch_id}/source.zip に完全一致する
  -- (isAdHocZipKey。部分一致にしない)。**ログに出さない。**
  source_key         text not null,

  -- 画面と監査のための実数。展開・分類のたびに更新する。
  subject_count      int  not null default 0 check (subject_count >= 0),
  file_count         int  not null default 0 check (file_count    >= 0),

  -- **この案件で必要な format 集合** (spec §15.2)。
  -- 既存の GATING_FORMAT_IDS (通常プランの 5 種必須・elith-assemble.ts:29) は
  -- **この機能のために変更しない**。案件ごとの要件はここに持つ。
  -- 例: required=["HealthCheckupData","GeneticTestResultData","LifestyleQuestionnaireData"]
  --     optional=["HealthAgeData"]
  required_formats   jsonb not null default '[]'::jsonb,
  optional_formats   jsonb not null default '[]'::jsonb,

  -- 原本を 10 年保管 (putOriginal → Object Lock) の対象にするか。
  -- **既定 false** — 原本用バケットは削除不可なので、氏名・生年月日を含む臨時案件の
  -- ファイルを入れると後から消せない (spec §9 / §28.2-O2 = 発注者判断待ち)。
  retain_originals   boolean not null default false,

  -- 誰が作ったか。**操作者識別の正は `created_by_user_id`** (v0.4・発注者判断)。
  --   wellfort-site が `/auth/v1/user` で検証した Supabase Auth の user.id (UUID) を
  --   **サーバ側で注入する**。**ブラウザ body の値は信用しない。**
  -- メールの現物は保存しない (既存 demo.account_emails と同じ規律)。マスクは表示用の補助。
  created_by_user_id uuid,
  created_by_masked  text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  confirmed_at       timestamptz,   -- 管理者が「納品データを確定」を押した時刻 (spec §17 STEP 4)
  exported_at        timestamptz,   -- S3 へ書き出した時刻

  -- 失敗の理由。**ここに残らないと誰も気づけない。**
  last_error         text
);

comment on table diagnosis.ad_hoc_diagnosis_batches is
  '臨時診断バッチ 1 回分。正本 docs/lab/ad_hoc_diagnosis_batch_spec.md。氏名・生年月日は保存しない';
comment on column diagnosis.ad_hoc_diagnosis_batches.source_sha256 is
  '投入 ZIP の SHA-256。再開時に「同じ ZIP か」を判定する唯一の入口 (spec §6.2.3-1)';
comment on column diagnosis.ad_hoc_diagnosis_batches.declared_source_size is
  'ticket 発行時のブラウザ申告値。上限の一次判定に使うだけで信用しない (spec §5.2.1 ①)';
comment on column diagnosis.ad_hoc_diagnosis_batches.source_size is
  'PUT 完了後に HeadObject で確認した実サイズ。確定するまで null。申告値をここへ入れない (spec §5.2.1 ②)';
comment on column diagnosis.ad_hoc_diagnosis_batches.required_formats is
  'この案件で必要な format 集合。既存 GATING_FORMAT_IDS (通常プランの 5 種必須) は変更しない (spec §15.2)';
comment on column diagnosis.ad_hoc_diagnosis_batches.retain_originals is
  '原本を 10 年保管の対象にするか。既定 false = 保存しない (spec §28.2-O2 が未裁定のため)';
comment on column diagnosis.ad_hoc_diagnosis_batches.created_by_user_id is
  '作成者識別の正。wellfort-site が /auth/v1/user で検証した Supabase Auth の user.id。ブラウザ申告値は使わない';
comment on column diagnosis.ad_hoc_diagnosis_batches.created_by_masked is
  '画面表示用のマスク済み文字列 (例 h***@example.com)。識別には使わない。現物のアドレスを入れない';

create index if not exists ix_ad_hoc_batches_status_created
  on diagnosis.ad_hoc_diagnosis_batches(status, created_at desc);

-- 同一 ZIP の二重登録を検知する (spec §19.1)。**一意にはしない** —
-- 「同じ ZIP をもう一度投入したい」が正当な場合 (前回 failed 等) を塞がないため。
-- 検知して管理者に警告するだけで、自動で拒否も自動で続行もしない。
create index if not exists ix_ad_hoc_batches_source_sha256
  on diagnosis.ad_hoc_diagnosis_batches(source_sha256);


-- ════════════════════════════════════════════════════════════════════
-- 2) ad_hoc_diagnosis_subjects — 人物 (= ZIP 内の人物フォルダ 1 つ)
-- ════════════════════════════════════════════════════════════════════
-- **氏名・生年月日・社員番号・フォルダ名を保存しない** (spec §6.1)。
-- 照合は展開直後のメモリ内でのみ行い、結果の「種類」だけを identity_reason に残す。
create table if not exists diagnosis.ad_hoc_diagnosis_subjects (
  id                 uuid primary key default gen_random_uuid(),
  batch_id           uuid not null references diagnosis.ad_hoc_diagnosis_batches(id) on delete cascade,

  -- 画面表示用の連番 (No.01 …)。**Central Directory の出現順**で採番するので
  -- 同じ ZIP なら再選択でも同じ番号になる (spec §6.2.2)。
  -- **結び直しにはこれを使わない** (使うと分類を直した回に静かに入れ替わる)。
  subject_no         int  not null check (subject_no >= 1),

  -- 内容由来の非可逆 fingerprint (spec §6.2.1)。
  --   SHA-256( そのフォルダのファイルの content SHA-256 を 16進小文字で昇順ソートし "\n" 連結 )
  -- **材料はファイルの中身のハッシュだけ**で、氏名・フォルダ名・ファイル名を一切使わない。
  -- **平文の PII は含まないが、特定の個人の検査ファイル群に 1 対 1 で対応する照合用識別子**
  -- なので、**機微情報と同等に扱う** (ログに出さない・外部へ渡さない・納品 JSON に載せない)。
  -- ファイルが 0 件の人物は計算できないので null (identity_status='unresolved')。
  subject_fp         text check (subject_fp is null or subject_fp ~ '^[0-9a-f]{64}$'),

  -- 分類を管理者が手で直すとファイル集合が変わり fp も変わる。auto / manual を残す (spec §6.2.4)。
  subject_fp_source  text not null default 'auto' check (subject_fp_source in ('auto','manual')),

  -- Elith 納品の client_id (spec §13.1)。**app_users.diagnostic_user_id とは別空間の UUID**。
  -- 臨時バッチの被験者は EC 顧客でもアプリ利用者でもないので diagnostic_user_id を持たない。
  -- 先行例: elith-scan.ts が「clientId 未指定ならサーバで UUID 採番 (サンプル用)」を既にしている。
  client_id          uuid not null default gen_random_uuid(),

  -- 問診 export (interview-export.ts) が要求する識別子。client_id と同値でもよいが
  -- **意味が違うものを 1 列に潰さない**ので別に持つ (spec §13.2)。
  diagnostic_id      uuid not null default gen_random_uuid(),

  -- confirmed    … 資料間で矛盾が無い
  -- needs_review … 管理者の判断が要る (氏名/生年月日の食い違い・fp 不一致・fp 衝突 等)
  -- unresolved   … そもそも判定材料が無い (ファイル 0 件 等)
  identity_status    text not null default 'needs_review'
                       check (identity_status in ('confirmed','needs_review','unresolved')),

  -- 食い違いの**種類と件数だけ**。**値そのものを書かない** (例 'dob_mismatch:2' /
  -- 'fp_collision' / 'unmatched')。ここに氏名や生年月日を入れないこと。
  identity_reason    text,

  sex                text not null default 'unknown' check (sex in ('male','female','unknown')),

  -- 生年月日から算出した結果**のみ**。DOB そのものは保存しない (spec §8)。
  age                int check (age is null or (age >= 0 and age <= 150)),

  status             text not null default 'pending'
                       check (status in ('pending','processing','needs_review','ready','exported','failed')),

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- 表示連番は同一バッチ内で重複させない。
  unique (batch_id, subject_no)
);

comment on table diagnosis.ad_hoc_diagnosis_subjects is
  '臨時診断バッチの被験者 1 人。氏名・生年月日・社員番号・フォルダ名は保存しない (spec §6.1)';
comment on column diagnosis.ad_hoc_diagnosis_subjects.subject_fp is
  '内容ハッシュだけから作る非可逆 fingerprint。再開時の照合用の検索キーであって一意識別子ではない (spec §6.2.5.1)。'
  ' 平文 PII は含まないが個人の検査ファイル群に 1 対 1 で対応するため、機微情報と同等に扱う (ログに出さない)';
comment on column diagnosis.ad_hoc_diagnosis_subjects.identity_reason is
  '食い違いの種類と件数だけ。氏名・生年月日などの値そのものを書かないこと';
comment on column diagnosis.ad_hoc_diagnosis_subjects.client_id is
  'Elith 納品の client_id。app_users.diagnostic_user_id とは別空間の UUID (spec §13.1)';

-- **一意制約ではなく通常 INDEX** (spec §6.2.5.1・v0.3 の発注者指示)。
--   UNIQUE にすると「fp が衝突したら両方を needs_review として残す」が実行できない
--   (2 人目の INSERT がそもそも失敗する)。同一 fp が複数人物に存在し得ることを仕様として認め、
--   衝突は**検索件数で検出する**: 0 件=unmatched / 1 件=match / 2 件以上=fp_collision (全件 needs_review)。
create index if not exists ix_ad_hoc_subjects_batch_fp
  on diagnosis.ad_hoc_diagnosis_subjects(batch_id, subject_fp);

create index if not exists ix_ad_hoc_subjects_batch_status
  on diagnosis.ad_hoc_diagnosis_subjects(batch_id, status);


-- ════════════════════════════════════════════════════════════════════
-- 3) ad_hoc_diagnosis_files — ZIP 内の 1 ファイル
-- ════════════════════════════════════════════════════════════════════
create table if not exists diagnosis.ad_hoc_diagnosis_files (
  id                 uuid primary key default gen_random_uuid(),
  batch_id           uuid not null references diagnosis.ad_hoc_diagnosis_batches(id) on delete cascade,

  -- 人物が決まらないもの (ZIP 直下の参考資料など) は null (spec §5.6)。
  -- 人物の行が消えてもファイルの記録は残す。
  subject_id         uuid references diagnosis.ad_hoc_diagnosis_subjects(id) on delete set null,

  -- 展開先の S3 キー。{prefix}ad-hoc-uploads/{batch_id}/files/{file_id}.{ext} を**サーバが採番**する。
  -- **元ファイル名を key に入れない** (氏名が含まれ得るため。spec §8.1)。**ログに出さない。**
  storage_key        text not null,

  -- 画面に出す名前。**元ファイル名そのものは保存しない** —
  -- {分類}_{連番}{拡張子} 形式に置き換える (spec §8.1 / §28.2-O3)。
  display_name       text not null,

  -- ファイルの内容ハッシュ。subject_fp の材料であり (spec §6.2.1)、
  -- ページ結果のキャッシュキーでもある (spec §19.3)。**ログに出さない。**
  sha256             text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes         bigint not null check (size_bytes >= 0),
  mime_type          text,

  -- person_file      … 人物フォルダ配下の検査ファイル
  -- batch_reference  … ZIP 直下の参考資料。**どの人物にも自動割当しない** (spec §5.6)
  -- ignored          … ~$ 一時ファイル・__MACOSX 等
  source_kind        text not null default 'person_file'
                       check (source_kind in ('person_file','batch_reference','ignored')),

  -- 分類結果。判定できないうちは null (classification_confidence='needs_review')。
  classified_format_id text
                       check (classified_format_id is null or classified_format_id in
                         ('HealthCheckupData','BloodTestData','GeneticTestResultData',
                          'CancerRiskAssessmentData','LifestyleQuestionnaireData','Other')),
  classification_confidence text not null default 'needs_review'
                       check (classification_confidence in ('confirmed','probable','needs_review')),

  -- この検査の実施日 (spec §14.2)。**bundle_date とは別物**。
  -- 決められないうちは null。**今日の日付や 10名の情報.xlsx の実施日で埋めない。**
  test_date          date,

  -- pending/running/done/partial(一部ページ失敗)/failed/skipped(重複で非採用)/
  -- unsupported(.xls・許可外拡張子。**黙って捨てず一覧に出す**・spec §5.5)
  parse_status       text not null default 'pending'
                       check (parse_status in ('pending','running','done','partial',
                                               'failed','skipped','unsupported')),
  page_count         int check (page_count is null or page_count >= 0),

  -- 健診 PDF と XLSX が両方ある人物で、**構造化値の正はどちらか** (spec §12)。
  selected_as_primary boolean not null default false,
  duplicate_of_file_id uuid references diagnosis.ad_hoc_diagnosis_files(id) on delete set null,

  error_detail       text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table diagnosis.ad_hoc_diagnosis_files is
  'ZIP 内の 1 ファイル。元ファイル名は保存せず display_name へ置換する (spec §8.1)';
comment on column diagnosis.ad_hoc_diagnosis_files.sha256 is
  'ファイルの内容ハッシュ。subject_fp の材料 (spec §6.2.1) 兼 ページ結果のキャッシュキー (spec §19.3)';
comment on column diagnosis.ad_hoc_diagnosis_files.parse_status is
  'unsupported = .xls や許可外拡張子。黙って捨てず一覧に出すための状態 (spec §5.5)';

create index if not exists ix_ad_hoc_files_batch_subject
  on diagnosis.ad_hoc_diagnosis_files(batch_id, subject_id);

-- 同一原本の重複候補を引く (spec §19.2) / subject_fp の材料をまとめて取る (spec §6.2.1)。
create index if not exists ix_ad_hoc_files_sha256
  on diagnosis.ad_hoc_diagnosis_files(sha256);

-- 「まだ処理していないファイル」を拾う。終わった行が積もっても劣化しないよう部分索引。
create index if not exists ix_ad_hoc_files_pending
  on diagnosis.ad_hoc_diagnosis_files(batch_id, parse_status)
  where parse_status in ('pending','running','partial');


-- ════════════════════════════════════════════════════════════════════
-- 4) ad_hoc_diagnosis_pages — 多ページ PDF の 1 ページ
-- ════════════════════════════════════════════════════════════════════
-- 遺伝子 PDF は約 208〜210 ページ/人 × 10 名。**1 PDF 一括 Gemini 送信は禁止**で
-- 1 ページ = 1 リクエスト (spec §11.5)。**ブラウザを再読込しても続きから再開する**ため
-- 途中経過をクライアントでなくここに持つ (spec §10.1)。
create table if not exists diagnosis.ad_hoc_diagnosis_pages (
  id                 uuid primary key default gen_random_uuid(),
  file_id            uuid not null references diagnosis.ad_hoc_diagnosis_files(id) on delete cascade,

  -- **キャッシュ参照は (file_sha256, page_no)** (spec §19.3)。
  -- files へ join せず 1 本の索引で引けるよう非正規化して持つ。
  -- **同じ PDF を再処理しても成功済みページを Gemini へ送り直さない**ためのキー。
  file_sha256        text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),

  page_no            int  not null check (page_no >= 1),
  status             text not null default 'pending'
                       check (status in ('pending','done','failed')),

  -- LLM の構造化結果。**構造は LLM 任せ** (既存 elith-genetic.ts の思想を踏襲)。
  parsed             jsonb,

  -- LLM の生出力 (監査用)。**Elith 納品 data には含めない。**
  raw                text,

  attempts           int  not null default 0 check (attempts >= 0),
  error_detail       text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (file_id, page_no)
);

comment on table diagnosis.ad_hoc_diagnosis_pages is
  '多ページ PDF の 1 ページぶんの処理結果。成功済みページを再処理しないためのキャッシュでもある (spec §19.3)';
comment on column diagnosis.ad_hoc_diagnosis_pages.file_sha256 is
  'files.sha256 の写し。キャッシュ参照 (file_sha256, page_no) を 1 索引で引くための非正規化';

-- キャッシュの引き当て (spec §19.3)。
create index if not exists ix_ad_hoc_pages_cache
  on diagnosis.ad_hoc_diagnosis_pages(file_sha256, page_no);

-- 「このファイルの残りページ」を拾う。
create index if not exists ix_ad_hoc_pages_pending
  on diagnosis.ad_hoc_diagnosis_pages(file_id, page_no)
  where status <> 'done';


-- ════════════════════════════════════════════════════════════════════
-- 5) ad_hoc_diagnosis_outputs — 人物 × format の納品 JSON 1 件
-- ════════════════════════════════════════════════════════════════════
create table if not exists diagnosis.ad_hoc_diagnosis_outputs (
  id                 uuid primary key default gen_random_uuid(),
  subject_id         uuid not null references diagnosis.ad_hoc_diagnosis_subjects(id) on delete cascade,

  format_id          text not null
                       check (format_id in
                         ('HealthCheckupData','BloodTestData','GeneticTestResultData',
                          'CancerRiskAssessmentData','LifestyleQuestionnaireData',
                          'HealthAgeData','Other')),

  output_status      text not null default 'pending'
                       check (output_status in ('pending','generated','exported','failed','skipped')),

  -- 書き出した Elith 納品 JSON の S3 キー。
  -- {prefix}user/{client_id}/date/{YYYY_MM_DD}/{format_id}_date_{YYYY_MM_DD}_user_{client_id}.json
  json_storage_key   text,

  validation_status  text not null default 'pending'
                       check (validation_status in ('pending','ok','invalid')),
  item_count         int check (item_count is null or item_count >= 0),

  -- この format の実施日 (spec §14.2)。date フォルダは batches.bundle_date のほう。
  test_date          date,
  generated_at       timestamptz,
  error_detail       text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- **同一人物に同じ format を 2 つ作らない** (spec §15.5 の「同一 format の重複」)。
  -- 健診 PDF と XLSX を別々に納品しないための構造的な歯止めでもある (spec §12)。
  unique (subject_id, format_id)
);

comment on table diagnosis.ad_hoc_diagnosis_outputs is
  '人物 × format の納品 JSON 1 件。既存 test_artifacts に入らないため別表 (spec §23.5)';

create index if not exists ix_ad_hoc_outputs_status
  on diagnosis.ad_hoc_diagnosis_outputs(output_status);


-- ════════════════════════════════════════════════════════════════════
-- 6) ad_hoc_diagnosis_events — 監査ログ (append only)
-- ════════════════════════════════════════════════════════════════════
-- **必ず残すもの** (spec §21): 分類の手動修正 / 重複判定の上書き /
-- syntheticMarkers の明示使用 / overwrite export / retry。
create table if not exists diagnosis.ad_hoc_diagnosis_events (
  id                 bigint generated always as identity primary key,
  batch_id           uuid not null references diagnosis.ad_hoc_diagnosis_batches(id) on delete cascade,
  subject_id         uuid references diagnosis.ad_hoc_diagnosis_subjects(id) on delete set null,
  file_id            uuid references diagnosis.ad_hoc_diagnosis_files(id) on delete set null,

  event              text not null
                       check (event in ('created','classified','reclassified','parsed',
                                        'page_done','page_failed','confirmed','exported',
                                        'retry','override')),

  -- 誰の操作か。**操作者識別の正は `actor_user_id`** (v0.4・発注者判断で O10 CLOSE)。
  --   wellfort-site は中継の入口で `/auth/v1/user` を叩いて管理者を検証しているので、
  --   そこで得た **Supabase Auth の user.id (UUID)** を Scan-Chat-AI へ**サーバ側で注入**する。
  --   **ブラウザ body に載ってきた actor_user_id は信用しない**
  --   (受け取っても捨て、中継が検証した値だけを使う)。
  -- masked / sha256 は補助。**メールの現物は保存しない** (既存 demo.account_emails と同じ規律)。
  actor_user_id      uuid,
  actor_masked       text,
  actor_sha256       text check (actor_sha256 is null or actor_sha256 ~ '^[0-9a-f]{64}$'),

  -- **値そのものではなく種類と件数** (例 {"from":"needs_review","to":"HealthCheckupData"})。
  -- 氏名・生年月日・元ファイル名をここに入れないこと。
  detail             jsonb not null default '{}'::jsonb,

  created_at         timestamptz not null default now()
);

comment on table diagnosis.ad_hoc_diagnosis_events is
  '臨時診断バッチの監査ログ (append only)。PII を入れない。値でなく種類と件数を残す (spec §21)';
comment on column diagnosis.ad_hoc_diagnosis_events.actor_user_id is
  '操作者識別の正。wellfort-site が /auth/v1/user で検証した Supabase Auth の user.id。ブラウザ申告値は使わない';
comment on column diagnosis.ad_hoc_diagnosis_events.actor_masked is
  '表示用マスク (補助)。メールの現物は保存しない (demo.account_emails と同じ規律)';

create index if not exists ix_ad_hoc_events_batch_created
  on diagnosis.ad_hoc_diagnosis_events(batch_id, created_at desc);


-- ════════════════════════════════════════════════════════════════════
-- updated_at トリガ
-- ════════════════════════════════════════════════════════════════════
-- **関数は新設しない。** 既存 diagnosis.touch_updated_at() を使う
-- (20260601000010:264 で定義・20260820000050 で search_path='' 固定済み)。
-- `create trigger` に if not exists が無いので、再適用できるよう drop してから作る。
-- events は append only なので updated_at を持たず、トリガも付けない。
drop trigger if exists ad_hoc_batches_touch_updated_at on diagnosis.ad_hoc_diagnosis_batches;
create trigger ad_hoc_batches_touch_updated_at before update on diagnosis.ad_hoc_diagnosis_batches
  for each row execute function diagnosis.touch_updated_at();

drop trigger if exists ad_hoc_subjects_touch_updated_at on diagnosis.ad_hoc_diagnosis_subjects;
create trigger ad_hoc_subjects_touch_updated_at before update on diagnosis.ad_hoc_diagnosis_subjects
  for each row execute function diagnosis.touch_updated_at();

drop trigger if exists ad_hoc_files_touch_updated_at on diagnosis.ad_hoc_diagnosis_files;
create trigger ad_hoc_files_touch_updated_at before update on diagnosis.ad_hoc_diagnosis_files
  for each row execute function diagnosis.touch_updated_at();

drop trigger if exists ad_hoc_pages_touch_updated_at on diagnosis.ad_hoc_diagnosis_pages;
create trigger ad_hoc_pages_touch_updated_at before update on diagnosis.ad_hoc_diagnosis_pages
  for each row execute function diagnosis.touch_updated_at();

drop trigger if exists ad_hoc_outputs_touch_updated_at on diagnosis.ad_hoc_diagnosis_outputs;
create trigger ad_hoc_outputs_touch_updated_at before update on diagnosis.ad_hoc_diagnosis_outputs
  for each row execute function diagnosis.touch_updated_at();


-- ════════════════════════════════════════════════════════════════════
-- 権限
-- ════════════════════════════════════════════════════════════════════
-- **service_role だけが読み書きする。ポリシーは 1 つも置かない** (spec §23.7)。
--   この 6 表は S3 キー (= PII を含む検査ファイルへの参照) と内容ハッシュを持つので、
--   既存 diagnosis 系の "dev_read_all" (select using true) を真似しない。
--   RLS 有効 + ポリシー無し = service_role 以外は 0 行しか見えない。
--
-- ※ 20260601000020 の `grant select on all tables in schema diagnosis to anon, authenticated`
--   は**その時点の表への一括付与**で、後から作る表には効かない (default privileges ではない)。
--   それでも取り違えが起きないよう明示的に revoke しておく。
--
-- **【この設計は service_role の BYPASSRLS に依存する】** (20260601000020:24-25 で付与)。
--   force row level security は所有者も縛るので、BYPASSRLS が無いと
--   **grant all は通るのにワーカーからは 0 行しか見えず、エラーも出ない**。
alter table diagnosis.ad_hoc_diagnosis_batches  enable row level security;
alter table diagnosis.ad_hoc_diagnosis_batches  force  row level security;
alter table diagnosis.ad_hoc_diagnosis_subjects enable row level security;
alter table diagnosis.ad_hoc_diagnosis_subjects force  row level security;
alter table diagnosis.ad_hoc_diagnosis_files    enable row level security;
alter table diagnosis.ad_hoc_diagnosis_files    force  row level security;
alter table diagnosis.ad_hoc_diagnosis_pages    enable row level security;
alter table diagnosis.ad_hoc_diagnosis_pages    force  row level security;
alter table diagnosis.ad_hoc_diagnosis_outputs  enable row level security;
alter table diagnosis.ad_hoc_diagnosis_outputs  force  row level security;
alter table diagnosis.ad_hoc_diagnosis_events   enable row level security;
alter table diagnosis.ad_hoc_diagnosis_events   force  row level security;

revoke all on diagnosis.ad_hoc_diagnosis_batches  from anon, authenticated;
revoke all on diagnosis.ad_hoc_diagnosis_subjects from anon, authenticated;
revoke all on diagnosis.ad_hoc_diagnosis_files    from anon, authenticated;
revoke all on diagnosis.ad_hoc_diagnosis_pages    from anon, authenticated;
revoke all on diagnosis.ad_hoc_diagnosis_outputs  from anon, authenticated;
revoke all on diagnosis.ad_hoc_diagnosis_events   from anon, authenticated;

grant all on diagnosis.ad_hoc_diagnosis_batches  to service_role;
grant all on diagnosis.ad_hoc_diagnosis_subjects to service_role;
grant all on diagnosis.ad_hoc_diagnosis_files    to service_role;
grant all on diagnosis.ad_hoc_diagnosis_pages    to service_role;
grant all on diagnosis.ad_hoc_diagnosis_outputs  to service_role;
grant all on diagnosis.ad_hoc_diagnosis_events   to service_role;

-- events は identity 列を持つのでシーケンスの使用権も要る (grant all on table では付かない)。
grant usage, select on all sequences in schema diagnosis to service_role;
