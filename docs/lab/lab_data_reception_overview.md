# 検査データ受取 総合仕様（4検査・受取方式まとめ）

| 項目 | 内容 |
|---|---|
| 目的 | Wellfort が外部検査会社から受け取る **4 検査**のデータ受取方式・経路・現状・課題を一枚に集約する。各検査は最終的に **Elith 形式 JSON（`elith-handoff-v0.1`）へ変換し S3 経由で Elith へ受け渡す**（詳細=`docs/elith/elith_s3_data_handoff_spec.md` / `docs/elith/elith_assembly_wrapping_spec.md`）。 |
| 対象 | ①血液検査（リージャー）②がんリスク検査・尿（プリベント）③AI疾病発症予測（LAiF）④遺伝子検査（Genoplan）。※健診・人間ドックは会員がアプリでAIスキャンするため本書対象外。 |
| 版 | **v2.1 overlay 2026-10-09（§2 プリベントの「提案中」を失効させ採用方式へ／§4.2(e) に Genoplan の運用工程確定を追記／§5.4 項目2 を現行コードに合わせて訂正。4検査横断の正本は `lab_data_pipeline_master_spec.md` §4-5）**<br>**2026-09-01c（遺伝子=Wellfort 提供の操作動画を確認。突合キー＝ボックスナンバー(`extchar03`)と判明・PDF は 208 頁で 2 頁目に認証キー/顧客名・§4.1.2 追加）**<br>2026-09-01b（遺伝子=実アカウントで疎通確認。許諾取得済・partner選択不要・`kit_status='600'`で72件・PDF実体21MBを確認。§4.1.1／§4.2／§4.4 を更新）<br>2026-09-01（遺伝子=Genoplan の受取方式を実測で判定。**RPA も PowerShell も不要でサーバ側完結**・§4 を全面改訂／§0.1 追随）<br>2026-08-31（血液=受取方式を RPA/PAD から **PowerShell 方式**へ変更・§1/§0.1/§7 を更新）<br>2026-08-26（Draft・LAiF 実データ疎通の結果／ID 連携仕様／問診データの渡し方マトリクスを追記） |
| 上位文書 | **本書は「受取方式（各社別）」に特化した詳細。EC購入→キット→問診→受取→Elith→表示の E2E 全体像は `docs/lab/lab_data_pipeline_master_spec.md`（総合仕様書）が正本。** **【v2.1 / 2026-10-09】さらに「検査IDの紐づけ／問診受渡／結果受領」の 4検査横断は同書 §4-5 が正本**になった。本書は**同書 §4-5 と矛盾しない範囲で有効**（矛盾箇所＝同書 §4-5.11）。 |
| 関連 | **`docs/lab/demecal_unattended_spec.md`（血液=無人定期取得の正本・PowerShell方式）** / `docs/lab/demecal_powershell_probe_guide.md`（方式決定の実測）/ `docs/lab/demecal_auto_download_overview_spec.md`（概要）、`docs/elith/elith_assembly_wrapping_spec.md`（LAiF/ウェルネス年齢のラップ）、`docs/lab/lab_integration_workflow.md`（割当・PII）、`docs/lab/kit_progress_management.md`（進捗）、`docs/lab/wellfort_admin_lab_upload_spec.md`（admin取込） |

---

## 0. 一覧表

### 0.1 受取方式（下り：検査会社 → Wellfort）

| # | 検査 | 検査会社 | 受取方式 | 取得データ | Elith format_id | 変換方法 | ステータス |
|---|---|---|---|---|---|---|---|
| 1 | 血液検査 | 株式会社リージャー（Leisure／デメカル DSS） | **PowerShell 方式**（専用PC・mTLS＋無人定期実行。**RPA/PAD は不要**・2026-08-31 確定） | CSV | `BloodTestData` | **決定論パース**（CSV→JSON・LLM不使用） | 自動アクセス承認済・サーバ側実装済／**方式確定・PC側は未実装**（**外部からの回答待ちは無い**） |
| 2 | がんリスク検査（尿） | プリベント社（ALA-PDS） | **専用ポータル＋AWS S3＋パスキー方式を提案中**（LAiF流用）／現状：メール＋フォルダ共有の手動 | PDF/報告書 | `CancerRiskAssessmentData` | **admin バッチ AIスキャン**（画像→JSON） | **方式を提案中（プレゼン段階）**。現状は手動 |
| 3 | AI疾病発症予測 | LAiF社 | **AWS S3 専用バケット**（URLで受渡） | PDF | `Other`（`kind:"ai_prediction"`） | **admin バッチ AIスキャン**（多ページ・LLM構造化） | 受取方式確定・スキャン対応実装済／**2026-08-26 上り(弊社→LAiF)疎通OK・下り(返送)は未検証** |
| 4 | 遺伝子検査 | Genoplan社（ジェノプランジャパン） | **サーバ側（Vercel）から API 取得**（ID/PW のみ・**証明書不要＝専用PC不要**・2026-09-01 実測で確定） | PDF | `GeneticTestResultData` | **admin バッチ AIスキャン**（多ページ・LLM構造化） | **自動アクセス許諾 取得済／実アカウントで疎通済（login→一覧 255件→PDF 21MB・§4.1.1）／取得部は未実装**。**RPA・PowerShell はいずれも不要** |

### 0.2 問診データの渡し方（上り：Wellfort/ユーザー → 検査会社）— **確定 2026-08-26・発注者確認**

**下り（受取）とは経路も担い手も別**。AI問診（アプリ）を経由するのは **②がんリスクと③AI疾病発症予測の 2 検査だけ**で、①血液と④遺伝子は**ユーザーが検査会社へ直接届ける**ため**弊社の実装対象外**。

| # | 検査 | 問診の取得方法 | 渡し方（経路） | 形式 | 弊社の実装要否 |
|---|---|---|---|---|---|
| 1 | 血液検査（リージャー） | **ユーザーが専用用紙へ記入** | **郵送**（検体と共に検査会社へ返送） | 紙 | **なし**（弊社を経由しない） |
| 2 | がんリスク検査・尿（プリベント） | **AI問診**（アプリ） | **専用ポータル＋AWS S3＋パスキー方式**（提案中） | **CSV** | **あり**（AI問診→CSV変換＋ポータル配置） |
| 3 | AI疾病発症予測（LAiF） | **AI問診**（アプリ） | **専用ポータル＋AWS S3＋パスキー方式** | **所定 Excel フォーム**（`input_format_new_202312.xlsx`・約158項目）※ | **あり**（AI問診→所定フォーム変換＋ポータル配置） |
| 4 | 遺伝子検査（Genoplan） | **ユーザーが Genoplan 社の検査専用 Web へ直接入力** | **弊社は渡さない**（検査会社が直接取得） | — | **なし**（弊社を経由しない） |

> ※ **③の形式について**: 発注者ご指示は「AI問診→CSV」ですが、**LAiF 社は「CSV」表記を避け、所定の Excel フォーム
> `input_format_new_202312.xlsx` での受渡を要望**しており（2026-08 に行き違いを是正済・`docs/lab/partner_demo_confirmation_request_laif.md`）、
> 現行実装（`scripts/build-laif-input.py`）もこの Excel を出力します。**本表は実装に合わせて「所定 Excel フォーム」と記載**しています。
> 「CSV で確定」の意図であれば先方合意の取り直しが必要なため、**ご確認ください**。
>
> **本確定により `docs/lab/questionnaire_to_lab_csv_spec.md` の未確定事項が 2 件解消**します
> （§7-7 血液への問診受渡＝**不要**で確定／§4.4・§6 の Genoplan 列＝**対象外**）。同仕様書も追随して更新済み。

---

## 1. 血液検査（株式会社リージャー）

- **検査会社/ポータル**: 株式会社リージャー（Leisure）＝デメカル `DSS Web System`（`https://dl.demecal.net`）。
- **受取方式**: **PowerShell 方式（2026-08-31 確定・専用PC 実測）。RPA / PAD は不要。**
  正本 = **`docs/lab/demecal_unattended_spec.md`**（無人定期実行）。
  - 根拠（`demecal_powershell_probe_guide.md`「実測結果」）: 証明書つき接続 **HTTP 200**
    （`CN=Q05-0010`・発行者 `demecal.net CA`・**期限 2028-12-12**）／証明書なしは 400 ／
    ログイン画面は **`<form>` 1・`<input>` 3 の素の HTML フォーム**（ログインを動かす JS は無い）。
  - **PAD より優れる点**: ライセンス不要・**ブラウザ要素を指さないので画面デザイン変更に強い**・
    セットアップが「ダブルクリック 1 回」。
  - **旧案は不採用**: PAD ／ サーバ側 Playwright。どちらも `docs/旧版・ボツ/` へ移動済み
    （`旧版・ボツ/demecal_pad_{flow_skeleton,operation_guide,setup_guide}.md`・`旧版・ボツ/demecal_server_playwright_design.md`）。
- **フロー**（`demecal_unattended_spec.md §4.1`）:
  1. 専用PC（Pマーク準拠・クライアント証明書導入済）の **タスクスケジューラが PowerShell を起動**。
  2. 証明書を選ぶ（**発行者CN=`demecal.net CA` かつ秘密鍵あり**で絞る。CN のベタ書きはしない）。
  3. `GET /account/login` で **antiforgery トークン（`__RequestVerificationToken`）**を取得し、
     **同一セッション**で `POST /account/login`（**証明書は GET・POST の両方に付ける**）。
  4. **日付重複なく**新規分の血液CSVをダウンロード（状態は `/api/admin/demecal-state` で管理）。
     保存先は **`C:\demecal\`**（**デスクトップは OneDrive 同期対象＝PII がクラウドへ上がる**ため使わない）。
  5. admin 取込API `/api/admin/elith-blood-csv` へ投入 → **決定論パース**で `BloodTestData` JSON 化 → S3。
  6. 成功時のみ `last_to` を前進 → **原本CSVを削除** → 成否を実行ログAPIへ報告。
- **無人化の要点**: 証明書が **`Cert:\CurrentUser\My` にしかない**ため、タスクは
  **ユーザー `info` / 「ログオン中のみ実行」/ ログオン時＋毎日 / 「開始時刻を過ぎたらすぐ開始」**で組む。
  **自動ログオンも LocalMachine への証明書移設も不要**（`last_to` が単調前進なので、
  走らない日があっても次の成功回がまとめて回収する＝取り漏れゼロ）。
- **鍵管理**: AWS/Gemini 等の鍵は **Vercel 本番 env のみ**。専用PCには据え置きの鍵を置かない（CLAUDE.md）。取込は専用キー `x-intake-key`。
- **特記**: 血液のみ **CSV＝決定論パース**（画像AIスキャン不要）。ウェルネス年齢（CABA）の主要マーカー源。
- **問診データ（上り）**: **ユーザーが専用用紙へ記入し、検体と共に郵送**（§0.2）。**弊社を経由しない＝実装対象外**。
  ※ 旧検討の「Wellfort→デメカルへ問診CSVを渡す」方向は**不要で確定**（`questionnaire_to_lab_csv_spec §7-7` を解消）。
- **④ 構造照合（実装済）**: CSV↔JSON の**漏れゼロ/捏造ゼロ/コード解決/PII非混入**を固定検証する fixture。
  `scripts/verify-blood-csv-structure.ts`＋`scripts/blood-csv-fixtures/demecal_sample_v1.csv`。実行 `npm run verify:blood-csv`（決定論・鍵不要・26チェック全PASS）。
- **DL画面手順（確定済）**: `demecal_auto_download_overview_spec.md §2.1` と
  `demecal_attended_manual_guide.md` ステップ② に**確定手順を記載済**（ログイン→データDL→汎用CSV設定→確認→DL）。
  **HTML レベルの `action` / `name` だけが未取得**（接続チェックの bat は**設計上ログインしない**ので、
  取れたのは `/account/login` のログイン**前**ページだけ）。**ただし人手で取り直す必要は無い** —
  ログインはスクリプトが行うので、**初回実行の「偵察モード」が form 構造を実行ログAPIへ報告する**
  （PII を含む CSV は取らない）。`demecal_unattended_spec.md §8`。
- **ステータス**: 自動アクセス承認済／サーバ側（変換・S3・状態管理・取込UI）実装済／DL画面手順=仕様確定済／
  ④構造照合fixture=実装済。**残＝PC側の PowerShell 実装**（`demecal_unattended_spec.md §9` に TODO 9 件）。
  **外部からの回答待ちは無い**（2026-08-31 訂正）。
  ①ログイン後の一覧 URL／form は **スクリプトの初回実行が自分で報告する**（画面手順は既知＝下記「DL画面手順」）。
  ②`指図番号`→本人の対応づけは **§5.1/§5.2 と `id_management_and_correlation_spec.md:131` に設計済**で、
  **未実装なだけ**（§5.4 の #3）。残る決めは同 :145 の「採番タイミング・スキャン工程・突合ルール」の社内確定。
  先方確認は `demecal_auto_download_overview_spec §6`（日付基準/レート制限）。**証明書のサーバ移設は不要になった**（下記）。
- **進め方（技術者不在への対応・2案並行）**:
  - **案1（即運用・技術者不要）**: attended手動DL＋admin取込。スタッフ向けクリック手順書＝`docs/lab/demecal_attended_manual_guide.md`。
  - **案2（確定・本命）**: **専用PC上の PowerShell を無人で定期実行**。正本＝`docs/lab/demecal_unattended_spec.md`。
    **発注者判断（2026-08-31）で「最初から無人」**。段階導入（まず手動ダブルクリック）は採らない。
    Wellfort 側の作業は**セットアップ bat のダブルクリック 1 回**。
  - **不採用**: ~~サーバ側 Playwright(mTLS)~~（`旧版・ボツ/demecal_server_playwright_design.md`）。
    **証明書をサーバへ移設する必要が無くなった**ため（専用PC上で完結）。
    ~~PAD~~（`旧版・ボツ/demecal_pad_*.md`）も同様に不採用。**最善は案0=公式データ連携(SFTP/API)を Leisure へ打診**（変わらず）。
- **詳細**: **`demecal_unattended_spec.md`（無人運用の正本）**・`demecal_powershell_probe_guide.md`（方式決定の実測＋ログインフォーム構造）・
  `demecal_auto_download_overview_spec.md`（概要）・`demecal_attended_manual_guide.md`（手動運用・**現在稼働中**）・
  `demecal_rpa_operation_design.md`（§1役割分担/§2API/§3attended は有効。**§4 unattended は上記正本が上書き**）。
  **不採用案**（参照しない）: `docs/旧版・ボツ/demecal_pad_*.md`・`docs/旧版・ボツ/demecal_server_playwright_design.md`。

## 2. がんリスク検査（尿・プリベント社）

- **検査会社**: プリベント社（様式=ALA-PDS）。
> **⚠️ 【一部失効・2026-10-09 / v2.1】** 本章の「**提案中・プレゼン段階**」は失効。
> **専用ポータル＋AWS S3＋パスキー方式は「採用方式」として扱う**（ポータル・パスキー・
> 結果PDF の Presigned PUT・受領一覧が実装済であることを踏まえた判断）。
> ただし **本番問診CSV の生成／配布** と **受取時のバーコードNo. 取得** と
> **結果PDF の ID bind** は**いずれも未実装**。
> また本章の「現状フロー（手動・8ステップ）」の 5. が言う「プリベント社が『ID』で検体を特定」の **ID の実体は
> 先方の バーコードNo.（例 `704000xxx`）** で、**これをユーザーが受取時に撮影して `lab_tests.id` へ
> 紐づける**のが現行方針（**P0**）。
> 現行正本＝`docs/lab/lab_data_pipeline_master_spec.md` §4-5.3 ／
> 撮影・登録の詳細＝`docs/lab/kit_receipt_external_id_capture_spec.md`。

- **受取方式（採用方式・v2.1）**: **LAiF と同じ「専用ポータル＋AWS S3＋パスキー認証」方式**。
  上り（弊社→プリベント）で **問診CSV** をポータル経由で受渡し、下り（プリベント→弊社）で **報告書PDF** を専用S3で受領する双方向運用へ移行する狙い。往復メール／アクセス権未設定リンクを解消する。
  - **提案資料**: `がんリスク検査_プリベント_データ受け渡し方式ご提案_v0.1_20260806.pdf`（冒頭フロー図＋3ページ）。
  - **デモ画面（パスキー設定前にお試し）**: `https://wellfort.co.jp/partner-portal-preview?partner=prevent`（LAiF ポータルを流用・ダミーデータ・noindex）。
  - **上り問診CSV（サンプル）**: `docs/lab/questionnaire_to_lab_csv_spec.md §4.2`（33項目）に準拠した仮データCSVを先方確認用に用意済。
  - **設計正本**: LAiF の `docs/lab/laif_s3_secure_handoff_spec.md`（ゼロトラスト・多層防御）を流用。IP許可制はプリベントの固定IP有無で判断（未確認）。
- **現状フロー（手動・8ステップ・提案が合意されるまでの暫定）**:
  1. 会員がマイページ内Webアプリで「問診への回答」を行う。
  2. Webアプリのai機能でCSVへ転記。
  3. そのファイルを格納したフォルダのリンクを、**アクセス権未設定のまま**プリベント社へメール送付。
  4. プリベント社がアクセス権をリクエストし、ファイルを入手。
  5. プリベント社が「ID」で検体を特定・データ紐づけ → リスク検査報告書を作成。
  6. プリベント社が報告書を同フォルダへ格納。
  7. プリベント社が格納した旨をメールでウェルフォート社へ連絡。
  8. ウェルフォート社が報告書を確認し、その旨を返信して完了。
- **問診データ（上り）**: **AI問診（アプリ）→ CSV** を、**専用ポータル＋AWS S3＋パスキー方式**で受渡（§0.2）。項目は `questionnaire_to_lab_csv_spec §4.2`（主要33項目）。**弊社の実装対象**。
- **変換**: 受領した報告書（PDF/画像）を **admin バッチAIスキャン** → `CancerRiskAssessmentData` JSON → S3（🎯ゴールデン照合対応済）。
- **課題（提案で解消を狙う）**:
  - リンク共有＝手動・往復メール多く、リードタイム長い → **専用ポータル＋S3で双方向自動化**。
  - **アクセス権未設定リンクの送付**はセキュリティ/PII 面で要見直し（`docs/architecture/data_integration_requirements.md` の PII 分離方針との整合）→ **パスキー認証＋暗号化保管**で担保。
  - **提案の合意取り付け**（方式・IP有無・担当者/通知先・同意前提）が次アクション。
- **デモ画面ご確認依頼（2026-08 作成済・送付待ち）**: 文面＝`docs/lab/partner_demo_confirmation_request_prevent.md`／送付用PDF作成済。
  **送付前提＝デモURLが実際に開けること**（本番デプロイの鮮度を要確認）。

## 3. AI疾病発症予測（LAiF社）

- **検査会社**: LAiF社。
- **受取方式**: **AWS S3 専用バケットに置かれた URL で受渡**（LAiF→Wellfort）。
- **フロー**: 専用バケットURLからレポートPDFを入手 → **admin バッチAIスキャン（多ページ・LLM構造化）** → `Other`（`kind:"ai_prediction"`・`lab_name:"LAiF"`）JSON → S3（Elith納品層）。
- **データ内容**（実サンプル準拠）: 疾患ごとに **5年発症率(%)・10年発症率(%)・相対リスク比・昨年の相対リスク比**、カテゴリ（生活習慣病/循環器/悪性腫瘍/神経疾患）、リスク因子・予防策（AIアドバイス）。
- **変換/ラップ仕様**: `docs/elith/elith_assembly_wrapping_spec.md §5`（`Other`/`ai_prediction`・命名・data.items・時系列疑似データ提案）。
- **セキュア受渡方式（設計正本）**: `docs/lab/laif_s3_secure_handoff_spec.md`（**ポータル共有型ゼロトラスト**：Passkey認証＋IP制限＋Presigned直転送＋GuardDuty検疫＋Gemini File API丸投げ＋決定論検証＋Object Lock。Gemini/ChatGPT統合）。
- **問診データ（上り）**: **AI問診（アプリ）→ 所定 Excel フォーム**（`input_format_new_202312.xlsx`・約158項目）を、**専用ポータル＋AWS S3＋パスキー方式**で受渡（§0.2）。写像仕様＝`kit_lifecycle_and_handoff_management_spec §4.1.1`、生成＝`scripts/build-laif-input.py`。**名前欄(G1)＝整理番号（空欄不可）**。**弊社の実装対象**。
- **ステータス**: 受取方式確定。スキャン→JSON化 実装済（admin「🔮 AI疾病発症予測(LAiF)」）。**Elith 側の `Other`/`ai_prediction` 受領仕様は §5.6 で確認中**。**セキュア受渡は設計確定（実装/LAiF確認は上記spec §12-13）**。

### 3.1 実データ疎通の結果（2026-08-26・メール往復の記録）

**上り（弊社→LAiF）は疎通しました。下り（LAiF→弊社）は未検証のまま止まっています。**

| 時刻 | 主体 | 内容 |
|---|---|---|
| 10:55 | Wellfort | 動作確認用の手順書を送付し確認依頼 |
| 11:37 | LAiF | 手順は問題なし。ただし **URL が not found** |
| 14:02 | Wellfort | リンク修正・動作確認済み、再確認依頼 |
| 14:45 | LAiF | **データ受領**。ただし「**ID に英字を入れてほしい。数字のみだと解析できない**」／今回は便宜上 LAiF 側で末尾に **W** を付与／**システム改修中のため時間がかかる** |
| 14:58 | Wellfort | 英字の大小区別を照会／**ダミーデータでのアップロードを依頼** |
| 15:01 | LAiF | 今後は Wellfort 側で任意の文字を付与／**大文字小文字どちらでも可**／解析終了後にアップ |
| — | Wellfort | 了解。解析後のデータ返送と、返送時のメール一報を依頼 |

**判明した仕様制約（重要）**
- **LAiF の解析システムは、ID に英字を 1 文字以上含む必要がある**（数字のみは解析不可）。**大文字・小文字は不問／文字の位置・内容は任意**。
- この制約は **§5 の「②各社上りID（LAiF 整理番号）」の採番規則**にかかるもの。**Elith の `client_id`（＝`diagnostic_user_id`）を変更する必要はない**。

**未解決（次アクション）**
1. **今回分の ID 突合**: LAiF が独自に末尾へ `W` を付けたため、**返送される結果の ID は送信した ID と一致しない**（`…0001` → `…0001W`）。受領時の読み替えが必要（本来は §5 の `external_test_id` に格納して突合する対象）。
2. **ダミーでの往復テストが未確約**: 弊社の依頼に対する回答は「解析終了後にアップ」のみ。**下り経路（LAiF がサーバへ上げる→弊社が取得）は一度も検証できていない**。
3. **返送時のメール一報**の了承が未取得（最新メールが弊社発信）。
4. **LAiF 側の桁数上限**が未確認（採番規則の桁決めに必要）。
5. **経年で同一人物として突合する必要があるか**が未確認（レポートに「昨年比」欄があるため。§5.3 の単位決定に必要）。

> 【未確認の仮説】11:37 の `not found` は、`wellfort.co.jp` の本番デプロイが古く一部ページが 404 を返す事象と症状が一致するが、**該当 URL がメールから特定できないため同一原因かは未確認**。同じ原因であれば手順書内の他リンクも同様に落ちうるため、本番デプロイの鮮度確認が望ましい。

## 4. 遺伝子検査（Genoplan社）

- **検査会社**: Genoplan社（ジェノプランジャパン／GenePlanet）。
- **受取方式**: **【判定済み 2026-09-01・実測】RPA も PowerShell も不要。サーバ側（Vercel）で完結できる。**
  §4.1 に判定の根拠、§4.2 に着手前に潰す項目を書く。

### 4.1 判定（2026-09-01・実測）

判定の観点は血液で決め手になったのと同じ 2 点。**両方とも満たす。**

| 観点 | 結果 | 根拠（実測） |
|---|---|---|
| ① ログインが機械で通せるか | **通せる** | 画面は Vue SPA だが、背後は素の PHP REST API |
| ② レポート PDF が URL で直接取れるか | **取れる** | `window.open(url)` のみ。Blob/ブラウザ内描画を使っていない |
| （追加）クライアント証明書 | **不要** | Wellfort 提供情報。ID/PW のみ |

**測り方**: 配布中の SPA バンドルを静的解析した（`https://biz.genoplan.com/static/js/app.4a670d265dc496d6c712.js`
＋遅延チャンク `466.301d1e7427cc6cc6d37d.js`）。**ログインは行っていない**（パスワード未受領）。

#### ① 画面は SPA。ただし「素の HTML フォームか」は問う意味がない

`https://biz.genoplan.com/` の HTML は `<div id="app"></div>` と JS 1 本だけ＝**Vue SPA**。
`<form>` も antiforgery hidden も無い。**だが SPA の背後は普通の PHP REST API** で、
デメカル（ASP.NET Core・antiforgery の GET→POST 往復が必須）**より簡単**。

- **API ベース**: `https://bizapi.genoplan.com`（バンドル内の `RequestAPI.getBaseURL()`。
  `biz.genoplan.com` から来たときのみ本番、他は `testbizapi` へ向く）
- **ログイン**: `POST /api/biz/login.php` — 本文は `lang` / `loginid` / `password` の
  **form-urlencoded**（axios ラッパ `Mt = (url, body) => xt.post(url, URLSearchParams(body))`）
  → `{ success, data: { accesskey, seq, multi, accounts[] } }`
- **以降の認証 = `accesskey` と `partner_seq` を毎回 body に載せるだけ**。
  **Cookie セッションを使わない・CSRF トークン無し・`Authorization` ヘッダ無し**
  （axios の request interceptor は `console.log` のみ）
- **ログイン経路に MFA / CAPTCHA が無い**。`sendAuthNumber.php` / `checkAuthNumber.php` は
  **パスワード再設定・新規登録・マイページの電話番号認証にしか出てこない**（バンドル内 grep）
- **疎通確認（資格情報を送らずに 1 回だけ）**: `GET https://bizapi.genoplan.com/api/biz/login.php`
  → **HTTP 200** `{"success":false,"code":"1002","message":"User ID/Password does not exist."}`。
  403 でも 419 でもなくアプリ層のエラーが返る＝**前提となるトークンもセッションも要らない**ことの裏付け。

#### ② PDF は URL で取れる（しかも 2 経路とも直リンク）

- **一覧**: `POST /api/biz/getKitInfoList.php`（`accesskey` / `partner_seq` / `sn[]` / `lang`）
  → `serialnumber` / `signer_name` / `publish_origin` / `statuscode` / `report_seq` /
  `pdf_seq` / `serviceExpireYN` / `surveyStatus` などを返す
- **本レポート（My Book）**:
  `GET https://s3r5oxqcgwmyf4inuxdao64wae0yflhw.lambda-url.ap-northeast-1.on.aws/gpj/{lang}/{serialnumber}`
  （カスタム版は `?custom-seq={pdf_seq}`）→ `{ pdfUrl }` = **S3 の署名付き URL（有効 1 時間）**
  → その URL を GET すれば PDF。生成中は `{ code: 6020 }` が返るのでリトライ
- **PCR レポート**:
  `GET https://api.genoplan.com/pdfMaker5/dtc_pdf/php/download.php?qq={base64}`
  — `qq` は `{"report_seq":N,"time":<ミリ秒>}` を UTF-8 base64 したもの（`getPDFPCR()`）
- **ブラウザ内描画・Blob 生成は無い**（`saveAs` / `createObjectURL` / `a.download` の出現 **0 件**）。
  UI は `window.open(url)` を呼ぶだけ＝**そのまま `Invoke-WebRequest` / `fetch` で落とせる**。

#### ③ 結論：専用PC が要らない

クライアント証明書が無く、Cookie セッションも使わないので、**血液で専用PC が必須だった理由が
そもそも成立しない**（血液は証明書が `Cert:\CurrentUser\My` にしか無いのが制約）。
→ **Vercel のサーバ側で完結**でき、PC の電源・ログオン状態に左右されない。
PowerShell 方式も技術的には可能だが、**わざわざ PC を挟む理由が無い**。

> **PowerShell 方式は「不可」ではなく「不要」。** 現地実行 bat（`demecal-recon.ps1` の流用）は
> **作らない**。Wellfort の操作は 0 回で済む。

### 4.1.1 実アカウントでの疎通結果（2026-09-01・実測・全ステップ成功）

**許諾取得済（発注者確認 2026-09-01）**を受けて、サーバ側プローブ
`GET /api/ops/genoplan-probe?k=<PROBE_UPLOAD_TOKEN>`（実装 `src/pages/api/ops/genoplan-probe.ts`）を
Vercel から 1 回流した。**読み取りのみ**（login / 一覧 / PDF URL の 3 種。状態を変える API は呼んでいない）。
所要 **21 秒**・7 ステップすべて成功。

#### ① アカウント（§4.2(b) は解消）

| 項目 | 値 |
|---|---|
| `multi` | **`"N"`** ＝ **partner 選択は発生しない** |
| `accounts[]` | **1 件のみ** |
| `partner_seq` | `1657` / `seq` `12773` |
| `group_type` | **`M`** ＋ `auth_sales_kits=Y` → UI 区分は **manager** |
| 一覧の口 | **`/api/biz/kitStatusAdmin.php`**（master/seller ではない） |
| 権限 | `auth_report_view=Y` / **`auth_pdf_down=Y`** / `auth_kit_admin=Y` / `auth_analysis=Y` |
| 持たない権限 | `auth_buy_mybook=N` / `auth_report_upgrade=N` / `auth_request_resend=N` / `auth_request_survey=N` |

**PDF ダウンロード権限がある**ので、本件に必要な権限は揃っている。

#### ② 一覧（`kitStatusAdmin.php`）

- **総件数 `list_total_cnt` = 255**（`list_total_page` / `list_limit` / `list_first_num` / `list_last_num` も返る）
- **ページングは素直に効く**: `page=2` は 55 件で **1 ページ目との重複 0**（`limit=200`）→ **全件走査できる**
- 状態の分布（先頭 200 件）: **販売中 137（`statuscode` 220）/ レポート発行完了 62（600）/ 再検査キット発送中 1（440）**
- `kit_type` は **全件 `g1`** → **PCR 経路（`getPDFPCR`）は現状の在庫では使わない**
- `publish_origin` の範囲 **2024-02-13 〜 2026-08-27**
- 主なキー: `serialnumber` / `report_seq` / `statuscode` / `publish_origin` / `expiry_date` /
  `report_download_available` / `survey_status` / `pdf_seq`※ / `extchar03`（12 桁のキット番号らしき値）

#### ③ 絞り込み — **`kit_status` は効く。`finaldate_*` は使えない**

| 条件 | `list_total_cnt` | 判定 |
|---|---|---|
| 絞り込みなし | 255 | — |
| `finaldate_start=20200101` / `end=20301231` | **255（変わらず）** | 広すぎて除外なし |
| `finaldate_start=20260802` / `end=20260901`（直近 30 日） | **0 件** | — |
| **`kit_status='600'`（レポート発行完了）** | **72** | **効く** |

**`finaldate_*` は `final_update_date` を見ていない。** 直近 30 日で 0 件になった一方、
同じ一覧の `final_update_date` の最大は **2026-08-27**（＝その窓の中）だったため。
UI 上のラベルが「販売期間」なので**販売日（`selldate`）系を指している**と考えられるが、
**これは推測なので実装の根拠にしない。**

→ **差分取得の設計**: 血液の `last_to`（日付で前進）と同じ手は使えない。
**`kit_status='600'` で発行済み 72 件を引き、こちら側で「未取込の `serialnumber`」を差集合で出す**。
件数が小さく `serialnumber` が安定キーなので、これで十分。

#### ④ PDF — 取れた（実体を確認）

- `GET {lambda}/gpj/ja/{serialnumber}` → **HTTP 200** で `pdfUrl`（`s3.ap-northeast-1.amazonaws.com` /
  `X-Amz-Expires=3600`）
- その URL を **Range GET**（`bytes=0-1023`）→ **HTTP 206** / `content-type: application/pdf` /
  先頭 5 バイト **`%PDF-`** / **全体 21,313,936 バイト（約 21 MB）**
- **Range リクエストが通る**ので、分割取得・ストリーミングができる（60s 関数の中で扱いやすい）
- **本文は保存も出力もしていない**（先頭 1KB を読んで magic を見ただけ）

> **1 検体での実測**。21 MB が全件に共通かは未確認。**S3 へは受け取りながら流す**設計にしておく。

#### ⑤ `getKitInfoList.php` は PDF URL を持っていない

Mybook 画面が使う口だが、**`pdf_url` は `null`、`pdf_url_ko` / `pdf_url_ja` / `pdf_url_en` は空**だった。
→ **PDF は Lambda 経由が必須**（この口では省略できない）。

ただし一覧に無い有用なキーを返す: `pdf_seq` / `custom_require` / `serviceExpireYN` /
`surveyStatus` / `report_code` / `report_price` / `product_name_ja`。
**同時に `signer_mobile`（電話番号）も返す**＝一覧より PII が 1 つ増える（§4.2(c)）。

**カスタム PDF（画面の「My Book 編集」）は使われていない** — 発行済み 20 件を問い合わせた実測で
`custom_require=Y`（＝カスタマイズ**可能**なレポート）だが **`pdf_seq` は 20 件すべて空**
（＝実際にカスタム版を作った実績が無い）。→ **標準版をそのまま取ればよく、`?custom-seq=` は付けない。**
`surveyStatus` は 20/20 が完了、`serviceExpireYN` は 20/20 が有効。

**画面の「レポート情報」チェックは別ファイルではない** — バンドルの i18n 実測で
`"리포트 정보":"レポート情報"` ＝**選択リストの見出しラベル**（同じ表に「全て選択」もある）。
ダウンロードされるのは My Book の PDF 1 本だけ。

### 4.1.2 Wellfort 提供の操作動画から分かったこと（2026-09-01・3分28秒・1920x1080）

**動画そのものはリポジトリに入れない**（顧客氏名が画面に映っている）。ここには**手順と画面項目だけ**を書く。

#### 画面の「選択」は絞り込みではなく、目視の手選択だった

1. `biz.genoplan.com/#/` でログイン → **`/kit/manager`**（API 側の `kitStatusAdmin.php` と一致）
2. 「キット状態別リスト」の **`選択 ▼` ドロップダウン → 「My Book ダウンロード」** を選ぶ
3. すると**各行にチェックボックスが出る**（発行前・期限切れの行は押せない）
4. **1 件ずつ目で見てチェック**する。画面に **「PDFファイルのダウンロードは、一度に10個まで可能です。」**
5. 下部の緑帯「My Book ダウンロード」→ **`/mybook/pdf`** へ遷移
6. 「レポート情報」「My Book (Genoplan DNA)」にチェック → 「PDF ダウンロード」
7. **「PDFファイルを作成中です…完了までに約 30〜60 秒」** の進捗モーダル
8. 完了モーダルに **「認証キー ｜ 顧客名」のボタン**が出る → 押すと S3 の署名付き URL が開く

> **手順として参考にはなるが、「どれを取るか」の判断材料は画面に無い。** 担当者が目視で選んでいる。
> **10 件制限は UI の制約**で、API を直接叩く経路（§4.4）には掛からない
> （ただし **生成 30〜60 秒は Lambda 側**なので、**1 リクエスト 1 件**で回す＝60s 関数タイムアウト対策）。

#### 【重要】(e) の答え — **突合キーは「ボックスナンバー」＝ API の `extchar03`**

一覧の列は **認証キー / ボックスナンバー / サービス名 / 販売者 / キット状態 / 情報更新日 / 利用期限 /
アンケート / 顧客名 / 追加同意**。API の項目と並べるとこう対応する。

| 画面の列 | API のキー | 実測値の例 |
|---|---|---|
| 認証キー | `serialnumber` | `CFBB-NFPC-GSLP` |
| **ボックスナンバー** | **`extchar03`** | `5844-6059-9293` |
| キット状態 | `status` / `statuscode` | レポート発行完了 / `600` |
| 情報更新日 | `final_update_date` | 2026-08-27 |
| 利用期限 | `expiry_date` | 2027-11-30 |
| アンケート | `survey_status` | 完成 / 未回答 |
| 顧客名 | `signer_name` | （PII・出力しない） |

**`extchar03` は物理キットの箱に印字された番号**。Wellfort はキットを発送する側なので
**「どの箱を誰に送ったか」を自社で持てる** → **これが内部 ID との突合キーの本命**。
受け皿カラムは実在する（`lab_tests.external_barcode`）。**採用は Wellfort の確認後**。

#### 「どれが Wellfort のものか」は問いの立て方が違った

画面上部の **「キット販売現況」= 全体 **255** / 販売数 73 / 検査中 73 / 会員登録 73 / レポート発行完了 **72****。
API 実測（`list_total_cnt=255` / `kit_status='600'` → 72）と**完全に一致**する。
つまり **この partner アカウントに見えている 255 件は、すべて Wellfort が販売したキット**であり、
他社のキットは混ざっていない。→ **「どれが Wellfort のものか」ではなく「どの顧客のものか」**が
解くべき問題で、その答えが上記のボックスナンバー。

#### PDF の中身（実物）

- **208 ページ**（21 MB の内訳がこれ）。ファイル名は **`{認証キー}.pdf`**、
  置き場は `pdf-resources.genoplan.com/{生成日}/`（例 `2026-09-01/CFBB-NFPC-GSLP.pdf`）
- **2 ページ目に `認証キー` / `顧客名` / `発行日` が印字**されている
  → **PDF 単体から認証キーが復元できる**（取り違え検知に使える）
  → **同時に PDF は氏名を含む**＝原本は PII。S3 原本ストレージ（`ap-northeast-1`・Object Lock）へ置く前提は
    従来どおりだが、**Elith へ渡す JSON には載せない**
- 構成は「**主要分析レポート 100**（がん 25 ｜ 一般疾患 40 ｜ 体質 35）」

> **208 ページは既存の admin バッチ AI スキャンにとって大きい**（現行はページ範囲指定で運用）。
> **どのページを納品対象にするかは別途決める**。ここでは事実だけ記録する。

### 4.2 着手前に潰すこと（更新 2026-09-01）

- **(a) 【解消】Genoplan の自動アクセス許諾 — 取得済**（発注者確認 2026-09-01）。
  ただし **公式の受渡手段（API / S3 / 定期メール）の有無は未確認**。あればそちらが正になるので、
  次に先方とやり取りする機会に併せて訊く。
- **(b) 【解消】partner 選択は不要**。`multi="N"` / `accounts[]` 1 件（§4.1.1①）。
- **(c) 【要設計・当初想定より 1 つ多い】PII**。
  一覧（`kitStatusAdmin.php`）が **`signer_name`（氏名）と `doctor_name`**、
  `getKitInfoList.php` がさらに **`signer_mobile`（電話番号）** を返す。
  → **取得直後に捨て、`serialnumber` と `report_seq` だけを持つ。** DB にも S3 にも載せない。
  プローブは値を出力しない実装にしてある（`PII_KEYS` の `presence()`）。
- **(d) 【解消・部分的】IP 制限**。Vercel（iad1 / US East）から**ログインも一覧も PDF も通った**ので、
  少なくとも現時点でこのアカウントに IP 制限は掛かっていない。
  **将来掛けられる可能性は残る**ので、失敗時に黙って止まらないようにする（§4.4）。
- **(e) 【方式は既定・運用工程だけ未確定】顧客との突合**。
  **新しい論点ではない。**
  > **【v2.1 / 2026-10-09 追記】Genoplan の運用工程は確定した**＝
  > **タカセ出荷時に「ヤマト運輸送り状番号 ＋ ボックスナンバー」を既存の出荷指示CSV の同一行へ追記し、
  > 返送CSV を Wellfort が取り込む**（正本＝`docs/lab/lab_data_pipeline_master_spec.md` §4-5.6）。
  > **Genoplan をユーザー撮影方式へ置き換えない。**
  > ユーザー撮影（スマホ）は**プリベントの P0 主経路**としてだけ採用する
  > （`docs/lab/kit_receipt_external_id_capture_spec.md`）。
  >
  > **ただし `customer.lab_tests` に行を作るコードが両リポジトリに 0 件**（実測 grep・
  > SELECT は `src/lib/chat-context.ts:79-80` の 1 か所のみ）なので、
  > **受け皿カラムが実在していても書き込む先の行が無い**。これが最上位の先行条件
  > （上位 §4-5.12 の 3）。 突合方式は `lab_integration_workflow.md §2 Workflow 2`（**Phase 1 の主軸**）で既定＝
  「**発注時に `external_test_id ↔ diagnostic_user_id` を DB に保持 → 結果から検査 ID を読取って逆引き**」、
  **二重照合＝検査ID一致＋検査日一致＋検査機関名一致の 3 つすべて**。
  受け皿カラムも実在（`customer.lab_tests.external_test_id` / `external_barcode`・
  `20260601000010_schemas_and_tables.sql:150`）。

  今回の調査で**Genoplan 側の実体が確定した**（＝仕様の穴埋めができた）:

  | 仕様の項目 | Genoplan での実体 | 取得元 |
  |---|---|---|
  | `external_test_id`（検査ID） | **認証キー** `serialnumber`（例 `CFBB-NFPC-GSLP`） | API の一覧／**PDF 2 ページ目にも印字** |
  | `external_barcode`（キット物理ID） | **ボックスナンバー** `extchar03`（例 `5844-6059-9293`） | API の一覧（画面の「ボックスナンバー」列） |
  | 検査日 | `publish_origin` | API の一覧 |
  | 検査機関名 | Genoplan（固定） | — |

  **Workflow 2 のデメリット「`external_test_id` の OCR が必要」は Genoplan では発生しない** —
  **API が両 ID を構造化データで返す**ので OCR 不要。PDF 2 ページ目の印字は突合の裏取りに使える。

  **残りは「当方の未実装」であって Wellfort への確認事項ではない**（発注者指摘 2026-09-01）。
  **検査キットの出荷管理はこのシステムの機能**（`kit_lifecycle_and_handoff_management_spec.md`＝
  タカセ出荷指示 → ライフサイクル管理 → 進捗駆動の受渡）なので、
  **箱番号を控えて注文に結び付けるのは、こちらが実装すること**。

  受け皿は揃っている:

  ```
  subscriptions → 出荷スケジュール → タカセ出荷指示CSV → customer.kit_shipments
                                                            (order_id / customer_id / test_type / shipped_at)
                                                                │ shipment_id
  customer.lab_tests { diagnostic_user_id, external_test_id, external_barcode,
                       workflow_used(1|2|3), assigned_by }
  ```

  `20260601000010_schemas_and_tables.sql` の `lab_tests` に
  `external_test_id`（`unique (lab_company_id, external_test_id)` 付き）/ `external_barcode` /
  `workflow_used` / `assigned_by` があり、**Workflow 2 はスキーマの段階で表現済み**。

  **実際に欠けているもの（実測）**:

  | 欠けているもの | 根拠 |
  |---|---|
  | `lab_tests` に行を作るコードが無い | `grep` で読み取り（`chat-context.ts:78` の `select`）のみ |
  | Scan-Chat-AI から `customer` へ書けない | `supabase.ts:58` が `HP_BRIDGE_READONLY_KEY`＝読み取り専用。**書き込みは wellfort-site 側** |
  | `kit_shipments` に個体 ID の列が無い | 同マイグレーションの列一覧（`tracking_no` はあるが物流用・個体IDではない） |
  | タカセの**返送** CSV にボックスナンバー欄が無い | 伝票番号は返ってくる（`kit_progress_management §9.1`）。**1 列足すだけ**＝下記 |

  **`id_management_and_correlation_spec.md §7-3`「採番タイミング・スキャン工程」がそのまま未実装。**
  ただし §5 の想定フロー「出荷時に `external_barcode` を**印字/貼付**」は Genoplan では当てはまらない —
  **ボックスナンバーは Genoplan が箱に印字済み**なので、こちらは**出荷時に読む**ことになる。

  **実装の形**: ①wellfort-site が出荷実績登録でボックスナンバーを受け `kit_shipments`（列追加）と
  `lab_tests` へ書く ②Scan-Chat-AI は取得済み PDF の manifest を引き当て API として出し、
  `external_barcode` → `shipment_id` → `diagnostic_user_id`（**二重照合＝識別子＋検査日＋検査機関名**）
  ③一致しない分は `workflow_used=3`（人手承認）。**氏名からの推測割当はしない。**

  **ボックスナンバーをどこで捕まえるか（発注者指示 2026-09-01・2 経路を併用）**

  - **主経路 = タカセ出荷時（返送 CSV に相乗り）。**
    **伝票番号はタカセから CSV で返してもらう仕様が既にある**ので、**ボックスナンバーも同じ CSV に載せてもらう**。
    現に `kit_shipments.tracking_no` / `carrier` はこの返送で埋まる想定
    （`kit_progress_management.md §9.1`「2. タカセ倉庫から発送 → `tracking_no` = 伝票番号」）。
    → **新しい経路を作る必要はない。既存の返送 CSV に 1 列足すだけ。**
    （前版で「タカセ出荷指示 CSV に欄が無い」と書いたのは**出荷指示＝下り**の話で、
    捕まえるべきは**実績＝上りの返送 CSV**。訂正。）
    出荷時点で分かるので、**ユーザーの操作を待たずに紐付けが確定する**のが最大の利点。

  - **補助経路 = ユーザーの受取確認時にスマホカメラで撮影（案・発注者提案 2026-09-01）。**
    受取の自己申告 UI は既にある（`kit_progress_management.md §165`「タップ → `user_received_at = now()`」/
    Edge Function `kit-self-report`）ので、**そこに「箱番号の部分を撮影」を足す**。
    - 位置づけは**保険**。タカセの返送に載らなかった回・倉庫が取り違えた回を、
      **本人の手元にある実物**で確定できる（出荷実績より強い証拠になる場面がある）。
    - **読み取りは決定論で検証する**。ボックスナンバーは 12 桁 `NNNN-NNNN-NNNN` の固定書式なので、
      **書式に合わない読み取りは採用しない**。さらに **Genoplan 側の一覧に実在する番号か**を照合する
      （実在しなければ採用しない＝捏造ゼロ）。読めなければ**空のままにして人手へ回す**。
    - **必須にしない**（受取確認自体を止めない。`kit_progress_management` の自己申告は任意）。
    - 撮影画像の保管方針（保持期間・PII 判定）は別途決める。**箱番号だけが要る**ので、
      **読み取り後に画像を破棄する**のが既定でよい。

  どちらも**外部に新しい仕組みを頼まない**。要るのは
  **タカセの返送 CSV に 1 列足す合意**（Wellfort ではなくタカセ側の運用調整）だけ。

  なお **partner 配下の 255 件はすべて Wellfort のキット**（画面の「キット販売現況」と API の
  `list_total_cnt` が一致）なので、他社分を除外する処理は要らない。

### 4.3 先方へ報告すべき事項（当方の実装とは別件）

**PDF の署名付き URL を返す Lambda に認証が無い。** 実測（2026-09-01）:
存在しないシリアル `INVALID-TEST-0000` を指定した無認証の GET に対し、
`https://s3.ap-northeast-1.amazonaws.com/pdf-resources.genoplan.com/2026-09-01/INVALID-TEST-0000.pdf?X-Amz-...`
という**署名付き URL が返ってきた**（`X-Amz-Expires=3600`）。
つまり **シリアル番号を知っていれば誰でも他人の遺伝子検査レポートの URL を取得できる**可能性がある。
**実在するシリアルでの確認は行っていない**（他人のデータに触れないため）。
Wellfort の顧客データの保護に関わるので、**Wellfort 経由で Genoplan へ伝える。**

### 4.4 実装（疎通は済み・残りはこれだけ）

疎通（§4.1.1）は全ステップ成功したので、**取得処理の設計は確定している**。

```
① POST /api/biz/login.php            (lang, loginid, password)      → accesskey
② POST /api/biz/kitStatusAdmin.php   (accesskey, partner_seq=1657,
                                      kit_status='600', page, limit) → 発行済み一覧 (72 件)
③ 差集合                              既取込の serialnumber を除く
④ GET  {lambda}/gpj/ja/{serialnumber}                               → { pdfUrl } (1h)
⑤ GET  pdfUrl                                                       → PDF (約 21MB)
⑥ putOriginal() で S3 へ → 既存の admin バッチ AI スキャン（実装済）
```

**実装するときの約束**:

- **`serialnumber` と `report_seq` 以外は持ち越さない**（§4.2(c)）。氏名・電話は受け取った時点で捨てる。
- **`accesskey` をログに出さない**。1 つで全 API が叩ける（プローブで一度出力してしまった。
  `SECRET_KEYS` で潰し済み）。
- **PDF は受け取りながら S3 へ流す**。Range が効くので分割もできる（§4.1.1④）。
- **`{ code: 6020 }`（生成中）は失敗ではない**。次回に回す。
- **失敗を黙って飲まない**。血液の `last_to` 単調前進と同じで、
  **取り込み成功したものだけを「済み」に記録する**（失敗を済みにすると取り漏れる）。
- 認証情報は **Vercel env `GENOPLAN_LOGIN_ID` / `GENOPLAN_PASSWORD`**。
  **リポジトリにも bat にも置かない**（設定済み 2026-09-01）。

#### 実装状況（2026-09-01）

**①〜⑤ は実装済み。** `src/lib/genoplan.ts`（読み取り専用クライアント）＋
`POST /api/admin/genoplan-fetch`（Bearer `ADMIN_API_KEY`）。UI は wellfort-site 側に作る。

- **差分は「ボックスナンバー」で判定する**（発注者指示 2026-09-01）。
  保存キーを **`genoplan/{ボックスナンバー}__{認証キー}.pdf`** にし、
  **保存先を list して既にあるボックスナンバーを差し引く**。
  **取得済みテーブルを別に持たない** — 保存に成功したのに台帳更新に失敗した回で
  取り漏れ/二重取得が起きるため。**保存できたものだけが「取得済み」**（血液の
  `last_to` 単調前進と同じ考え方）。
- `GET` = 差分の確認のみ（副作用なし）／`POST` = 取得（**既定 1 件**・`?max=N` で最大 10）。
  1 件ずつなのは **PDF 約 21MB・208 頁**＋**Lambda の生成 30〜60 秒**に対して関数が 60 秒だから。
- `code 6020`（生成中）は**失敗として扱わない**。保存しないので次回また候補に上がる。
- 保存前に**先頭 `%PDF-` を確認**する（エラーページを原本として残さない）。
- 期限切れ（`serviceExpireYN=Y`）は取りに行かない（画面でも選べない行）。
- **顧客への割り当てはしない。** 材料（認証キー・ボックスナンバー・発行日・sha256）を
  同名の `.json` に残し、対応表の運用工程（§4.2(e)）が決まってから紐付ける。
  **氏名から推測して割り当てるのは禁止**（PII 分離・捏造ゼロ）。
- **原本は無加工で保存**（発注者判断 2026-09-01「暫定でそのまま保存」）。PDF 2 ページ目に氏名が
  印字されているが、原本の保管方針は CLAUDE.md 案C′ のまま。

#### 差分の実測（2026-09-01・dry-run）

| 項目 | 値 |
|---|---|
| 発行済み（`kit_status='600'`） | **72** |
| 保存済み | **0** |
| 未取得 | **72** |
| 期限切れでスキップ | 0 |
| **ボックスナンバーが空の行** | **0** ＝ 全 72 件で箱番号がキーとして使える |
| 発行日の範囲 | 2023-05-11 〜 2026-08-27 |

#### テスト取得の保存先（発注者指示 2026-09-01）

**`?dest=exchange`** で **`s3://wellfort-partner-exchange/genoplan/`**（`ap-northeast-1`）へ保存する。
このバケットは LAiF/プリベントとの受渡用で 2026-08-27 作成済み
（`laif_s3_secure_handoff_spec.md §7`）。**原本ストレージ（案C′）ではない**ので
Object Lock の 10 年保管に掛からず、**テスト後に消せる**。

- ファイルは 2 本ずつ: `{ボックスナンバー}__{認証キー}.pdf` と 同名 `.json`
- `.json` に入れるのは **`external_test_id`（認証キー）/ `external_barcode`（ボックスナンバー）/
  `published_on` / `report_seq` / `pdf_sha256` / `pdf_bytes` / `fetched_at`** だけ。
  **氏名・電話は入れない**（対応表ができたときに、この JSON だけで紐付けられる）
- 認可は、原本ストレージへの書き込みだけ `ADMIN_API_KEY`。
  dry-run と `dest=exchange` は `PROBE_UPLOAD_TOKEN` でも通す（**トークンを消せば両方閉じる**）
- **本番運用では `dest` を付けない**（既定＝原本ストレージ）

#### 実装上のつまずき（wellfort-site の admin UI を作る人向け）

- **POST は `content-type: application/json` を付けないと Astro に弾かれる**
  （`Cross-site POST form submissions are forbidden`＝`security.checkOrigin`）。
  `fetch` から呼ぶときは JSON で送ること。
- **`max` は「試行回数」でなく「保存できた件数」で数える。** 生成中（`code 6020`）は保存されず、
  `pending` は発行日の昇順なので、試行回数で数えると**次の呼び出しでも同じ行が先頭に来て足踏みする**。
- **1 リクエスト 1 件が上限。** 実測で 1 件 **約 32 秒**（ログイン＋一覧＋PDF URL＋21MB DL＋21MB PUT）。
  関数は 60 秒なので 2 件にすると超える。

#### 【要対応】本番運用に移す前に — 原本の置き場が未設定

dry-run の `storage_backend` が **`supabase`** だった。
**`AWS_S3_ORIGINALS_BUCKET` が Vercel env に無い**ため、このまま実行すると
原本が **Supabase Storage（US Central）** に落ちる。原本の置き場は
**S3 `ap-northeast-1`・Versioning + Object Lock・10 年保管**が正（CLAUDE.md 案C′）。
72 件 ≒ **約 1.5GB** を意図しない側へ書くと戻せない。

→ **`docs/operations/S3原本ストレージ_構築手順書.md` の手順で
`AWS_S3_ORIGINALS_BUCKET` を設定してから実行する。**（`AWS_REGION` は既存と共用で設定済み。
同手順書 §env 表のとおり、このバケット名が切替スイッチ。設定後は再デプロイが必要。）
**Object Lock は運用開始まで GOVERNANCE にすること**（Compliance はルートでも削除不可）。

**未着手**: ⑥ の結線（取得した PDF を admin バッチ AI スキャンへ流す）、
および §4.2(e) の運用工程（発送時に認証キー／ボックスナンバーを控える）。

**後始末**: 調査が終わったら **`PROBE_UPLOAD_TOKEN` を消す**（プローブ口が閉じる）。
本実装は admin 側の口に置き換えるので、プローブは残さない。
- **フロー**: **サーバ側（Vercel）が Genoplan の API からレポートPDFを取得** → **admin バッチAIスキャン（多ページ・LLM構造化）** → `GeneticTestResultData` JSON → S3。
- **問診データ（上り）**: **ユーザーが Genoplan 社の検査専用 Web へ直接入力**（§0.2）。**弊社は渡さない＝実装対象外**
  （`questionnaire_to_lab_csv_spec §4.4` の 70 項目マッピングは**対象外で確定**）。
- **データ内容**: 疾患ごとの**発症リスク倍率**＋発症率（％/定性）。🎯倍率ゴールデン照合（220項目）対応済。
- **ステータス**: **受取方式=サーバ側 API 取得で確定（2026-09-01・§4.1 実測）。RPA・PowerShell・専用PC はいずれも不要。**
  取得部は**未実装**（着手は §4.2(a) の許諾取得後）。スキャン→JSON化 実装済（admin「🧬 遺伝子検査」・ページ範囲指定）。

---

## 5. ID 連携仕様（検査会社ID ↔ 内部ID の同期）

> 正本＝`docs/architecture/id_management_and_correlation_spec.md`。本章はその**受取側の実務断面**を抜き出したもの。
> **検査会社とのやり取りに使う ID は、Elith へ渡す ID とは別物**であり、`customer.lab_tests` で対応づける。

### 5.1 ID は 3 層ある（混同しないこと）

| 層 | 実体 | 採番 | 用途 |
|---|---|---|---|
| **① 内部の軸** | `diagnostic_user_id`（uuid・非PII） | Wellfort | PII と診断系を結ぶ**唯一の連携キー**。**Elith の `client_id` はこれ**（`elith_s3_data_handoff_spec §2`） |
| **② 各社への上りID** | LAiF＝**整理番号（識別番号 No.0）**／プリベント＝会員ID／Genoplan＝整理番号系 | **Wellfort 採番の仮名ID** | 検査会社へ渡す ID。**会社ごとに別体系**。LAiF は「**自社連番は使わない・Wellfort 整理番号で突合**」で確定（2026-08） |
| **③ 検査会社の独自ID** | `lab_tests.external_test_id`／`external_barcode` | **検査会社** | 検査会社が結果に付す固有ID・キット物理ID。**受領時に格納して①と対応づける**（照合・突合用） |

**原則**: **内部 `diagnostic_user_id` を軸に、②③は補助照合キーとして持つ**。②③を軸にしない。

### 5.2 同期テーブル（`customer.lab_tests`）

`supabase/migrations/20260601000010_schemas_and_tables.sql:143-162`（実在）。

| カラム | 層 | 状態 |
|---|---|---|
| `diagnostic_user_id` | ① | **実在**（`lab_companies` / `kit_shipments` と併せて 1 検査＝1 行） |
| `external_test_id`（`unique (lab_company_id, external_test_id)`） | ③ | **実在**。ただし**受領時に書き込む処理は未実装** |
| `external_barcode` | ③ | **実在**（キット物理ID・POS/バーコード用）。未実装 |
| **②の上りIDを入れる列** | ② | **存在しない → 新規カラムが必要**（例 `upstream_ref text` ＋ `unique (lab_company_id, upstream_ref)`） |

会社ごとの様式差は **`customer.lab_companies.external_id_label` / `external_id_pattern`（regex）** で吸収する設計（実在・未登録）。

### 5.3 上りID（②）の採番規則 — **未確定・要決定**

LAiF の条件は「**英字を 1 文字以上含む／大小不問／文字は任意**」のみ。**先頭を英字にすると「数字のみ」が構造的に起こらない**。

**書式の案**

| 案 | 形式 | 例 | 正規表現 | 評価 |
|---|---|---|---|---|
| A-1 接頭辞＋通番 | `WF-` ＋6桁 | `WF-000123` | `^WF-[0-9]{6}$` | **推奨**。短く読みやすい。電話・メール照合が楽 |
| A-2 短縮ID | `W`＋Base32 7桁 | `W7K9Q2M4` | `^W[0-9A-HJ-NP-Z]{7}$` | 採番テーブル不要（`lab_tests.id` から導出）・推測困難。読み上げにくい |
| A-3 年＋通番 | `WF`＋年2桁＋通番 | `WF26-000123` | `^WF[0-9]{2}-[0-9]{6}$` | 年が目視で分かる。桁が長い（**LAiF の桁数上限が未確認**） |

**単位の案（要 LAiF 確認）**

| 案 | 中身 | 評価 |
|---|---|---|
| B-1 検査（回）単位 | 1 検体＝1 ID | `lab_tests` の一意制約と素直に整合。**LAiF 側からは毎回「別人」に見える** |
| B-2 顧客単位 | 1 顧客＝1 ID | 同一人物として扱えるが、**どの回か ID だけでは判別不可** |
| B-3 顧客＋回（折衷） | `WF-000123-01` | **推奨**。前方一致で同一人物・末尾で回を判別 |

> B は **「LAiF が経年で同一人物として突合する必要があるか」**（レポートに昨年比欄あり）の回答待ち。**不要なら B-1 が最もシンプル**。

**保存方式**: **DB に保存する（`upstream_ref`）**。「いつ・誰に・どの ID で送ったか」の証跡が残り、今回の「先方が `W` を付加」のような差異も突合できる。都度導出（保存しない）方式は、規則変更時に過去分と不整合になり証跡も残らないため不採用。

### 5.4 実装ギャップ（設計に追いついていない箇所）

| # | 状態 | 根拠 |
|---|---|---|
| 1 | **整理番号（②）の採番機構が未実装**。`src/` `scripts/` に「整理番号」のヒット **0 件** | 実測 grep |
| 2 | そのため LAiF 上りビルダーは、入力 JSON の `client_id`（①）を**そのまま名前欄 G1 に書いている**。**【訂正 2026-10-09】「No.0 にも書いている」は古い** — No.0 は LAiF 指摘（2026-08-27・黒枠＝自動計算）により**記入しないことに変更済** | `scripts/build-laif-input.py:262-266` |
| 3 | ③の受領時格納（`external_test_id`）が未実装 | 実測 |
| 4 | `lab_companies.external_id_label` / `external_id_pattern` に各社様式が未登録 | 実測 |

### 5.5 実装の最小セット

1. **マイグレーション** — `lab_tests.upstream_ref text` 追加＋`unique (lab_company_id, upstream_ref)`
2. **マスタ登録** — `lab_companies` の LAiF 行に `external_id_label='整理番号'` と決定した `external_id_pattern` を設定
3. **採番処理** — 決定した規則で発番し `upstream_ref` に保存
4. **ビルダー修正** — `build-laif-input.py` を「**整理番号を受け取る**」に変更（①を渡さない）。**pattern 違反は出力前にエラーで落とす**
5. **受領側** — ③（`external_test_id`）の記録（当面は admin からの手入力でも可）
6. **暫定処理** — 今回の 1 件（`…0001` ↔ `…0001W`）を手動で対応表に記録

---

## 6. 共通事項（4検査共通）

- **最終受け渡し**: いずれも **Elith 形式 JSON へ変換 → S3 `user/{client_id}/date/{YYYY_MM_DD}/{format_id}_..._user_{client_id}.json`**（`docs/elith/elith_s3_data_handoff_spec.md`）。
- **鍵一元管理**: AWS/Gemini の鍵は **Vercel 本番 env のみ**。専用PC・operator・クライアントに鍵を置かない（CLAUDE.md）。
- **PII 分離**: 外部・S3・診断系には氏名/住所/生年月日を載せない。**Elith へは `client_id`＝`diagnostic_user_id`（仮名）のみ**で橋渡し（`docs/architecture/data_integration_requirements.md` / `docs/lab/lab_integration_workflow.md`）。氏名OCRのみでの割当確定は禁止。
- **ID の使い分け**: **検査会社へ渡す ID は Elith の `client_id` とは別物**（§5）。会社別の上りID（②）と会社採番の独自ID（③）を `customer.lab_tests` で①に対応づける。**②③を軸にしない**。
- **変換の別**: 血液＝**CSV決定論パース**（LLM不使用）／がん・遺伝子・AI疾病予測＝**画像AIスキャン**（Gemini・サーバ側 admin バッチ）。
- **進捗管理**: キット発送〜完了は `docs/lab/kit_progress_management.md`、割当は `docs/lab/lab_integration_workflow.md`。

## 7. ステータス早見 & 次アクション

| 検査 | 受取自動化 | 主な次アクション |
|---|---|---|
| 血液（リージャー） | **方式確定（PowerShell・無人定期実行）／PC側は未実装**。**attended 手動取込が現在の本番運用**（admin 独立メニュー `/admin/demecal-csv`・手順書 v1.1） | **外部待ちは無し**。①`LAB_INTAKE_API_KEY`・実行ログAPI・監視（`demecal_unattended_spec.md §9` の 1〜5）②スクリプト本体（初回は**偵察モード**で form 構造を自己報告）③`external_test_id` 受領時格納＝本人への対応づけ（設計は `id_management_and_correlation_spec.md:131`・**未実装**＝§5.4-#3） |
| がんリスク（プリベント） | **専用ポータル＋S3方式を提案中**（現状は手動） | **デモ画面ご確認依頼の送付**（文面・PDF作成済／**デモURLが開けることの確認が前提**）＋固定IP有無・担当者/通知先・生年月日提供の同意前提を確認 |
| AI疾病予測（LAiF） | S3 URL（確定）／**上り疎通OK・下り未検証** | ①**上りID採番規則の決定**（§5.3・英字必須）②**ダミーでの往復テスト**を再依頼（下り経路の検証）③今回分 `…0001W` の突合記録 ④Elith へ `Other`/`ai_prediction` の**受領仕様確認**（`elith_assembly_wrapping_spec §5.6`） |
| 遺伝子（Genoplan） | RPA方針**（要再検討＝PowerShell 化の可能性あり）** | **血液の PAD 枠組みを流用する前提が消えた**（血液は PowerShell 化）。→ **血液と同じ読み取り専用プローブを Genoplan ポータルへ 1 回流し**、①ログインが素の HTML フォームか ②PDF が URL で直接取れるか を判定。素のフォームなら **PowerShell 化**（ライセンス不要・画面変更に強い）。**証明書不要ならサーバ側で完結し専用PCも不要になり得る（未確認）** |

## 8. 確認事項
1. **がんリスク（プリベント・提案中）**: 専用ポータル＋S3方式の合意可否。固定グローバルIPの有無（IP許可制の採否判断）。ご利用担当者／通知先。上りCSVに含める**生年月日の外部提供・同意前提**の可否。合意までの暫定手動運用の継続可否とアクセス権未設定リンクの是正。
2. **AI疾病予測（LAiF）**: S3 専用バケットの命名/URL発行ルール、Elith の `Other`/`ai_prediction` 受領仕様。
   **2026-08-26 追加**: ① ID の**桁数上限**（採番規則の桁決めに必要）② **経年で同一人物として突合する必要があるか**（レポートの昨年比欄・§5.3 の単位決定に必要）③ **ダミーデータでの往復テスト**の可否 ④ 返送時のメール一報の可否 ⑤ 今回 LAiF 側で付与された `W` 付き ID の**返送時の表記**。
3. **上りID（②）の採番規則の決定**（§5.3）: 書式（A-1/A-2/A-3）と単位（B-1/B-2/B-3）。**4 社共通の枠組みとして一度に決めるのが望ましい**（LAiF だけ個別対応しない）。
4. **専用PC運用（血液・遺伝子）**: 専用PC台数・保守主体（UNFIX構築/Wellfort運用）・Pマーク運用の最終確認。
   血液は **PowerShell 方式**で確定（`demecal_unattended_spec.md`）。**RPA/PAD のライセンスは不要**。
   遺伝子は方式が未定（上記のとおり要再検討）。
5. **各社独自ID（③）の運用**: `external_test_id`/`external_barcode` の**採番タイミング・スキャン工程・突合ルール**（`id_management_and_correlation_spec §7-3` の未確定事項）。
