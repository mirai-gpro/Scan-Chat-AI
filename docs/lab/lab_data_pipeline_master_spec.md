# 検査データ・パイプライン 総合仕様書（EC購入 → キット → 問診 → 各社受渡 → Elith → 表示）

| 項目 | 内容 |
|---|---|
| 目的 | **サブスク検査プラン および 単品検査商品 の購入から、キット発送・進捗管理・AI問診／検体返送・各社への問診データ受渡・検査結果受領・Elithへのラップ書き出し・AI診断結果の表示まで**、E2E の一連の流れを1本に束ねる**総合仕様書（正本・上位文書）**。個別の詳細は下記4ドキュメントに委譲し、本書はそれらを **6ステップの流れ**（＋単品検査商品＝§0-2）で連結・統合する。 |
| 位置づけ | **本書＝E2E 全体像の正本**。各論の正本は下記(a)(b)(c)(d)＋Elith/サブスク各 spec。**二重管理しない**（詳細は各 spec を参照し、本書は流れと責務分界・連結点のみ規定）。 |
| 統合対象（4本） | (a) `docs/lab/lab_data_reception_overview.md`（各社**受取方式**）／(b) `docs/lab/questionnaire_to_lab_csv_spec.md`（**AI問診→各社CSV** 写像）／(c) `docs/subscription/kit_lifecycle_and_handoff_management_spec.md`（**キット出荷・進捗・受渡** 統合管理・データモデル）／(d) `docs/subscription/single_item_purchase_handling_spec.md`（**単品検査商品**の購入者対応） |
| 版 | **v2.1 / 基準日 2026-10-09（4検査横断の「検査ID紐づけ／問診受渡／結果受領」を §4-5 に統合＝本書が横断の正本。受取時・外部検査ID 撮影／登録を P0 として §4-5.7 と専用仕様書 `docs/lab/kit_receipt_external_id_capture_spec.md` に新設。実装状況を実コードで再確認し 4 件訂正＝§4-5.8）**／**2026-09-01b（単品検査商品 3 つの E2E を §0-2 に追補＝(d) の宿題を消化）**／**2026-09-01（遺伝子=Genoplan を実証。RPA/専用PC 不要＝サーバ側 API 取得で確定・72 件取得成功。③にキット個体IDの捕捉を追加・④-3/⑤/⑦/⑧/⑨ を更新）**／2026-08-31（血液=PowerShell 方式へ更新・遺伝子の再検討を追記）／初版 2026-08-12 |
| 関連 | **`docs/lab/kit_receipt_external_id_capture_spec.md`（受取時・外部検査ID 撮影／登録＝§4-5.7 の正本）**／`docs/subscription/subscription_management_feature_requirements.md`（サブスク契約管理）／`docs/billing/gmo_subscription_billing_spec.md`（決済・契約状態）／`docs/elith/elith_batch_centralization_design.md`・`docs/elith/elith_assembly_wrapping_spec.md`・`docs/elith/elith_s3_data_handoff_spec.md`（Elith 受渡）／`docs/lab/lab_integration_workflow.md`・`docs/architecture/data_integration_requirements.md`（割当・PII） |

---

> ## 本版の位置づけ（v2.1 / 基準日 2026-10-09）
>
> - **本書は 4検査横断（①がんリスク ②血液 ③AI疾病予測 ④遺伝子）の現行正本**であり、
>   E2E の流れ（①〜⑥）に加えて、**「検査IDの紐づけ／問診データの受渡／検査結果の受領」を §4-5 で横断的に確定**する。
> - **優先順位 = 本書 §4-5 ＞ 会社別詳細仕様 ＞ 旧版。**
>   会社別詳細仕様（`demecal_unattended_spec.md`／`laif_s3_secure_handoff_spec.md`／`lab_data_reception_overview.md`／
>   `questionnaire_to_lab_csv_spec.md`／`kit_lifecycle_and_handoff_management_spec.md`／
>   `id_management_and_correlation_spec.md` ほか）は、**本書と矛盾しない範囲で有効**。
>   矛盾した箇所は本書が勝ち、どこを上書きしたかは **§4-5.11** に列挙する。
> - 旧版は削除していない。**`docs/旧版・ボツ/` へ移していない文書は現行として生きている**ので、
>   会社別の運用手順・実測記録はそのまま根拠に使える（**矛盾箇所だけが失効**）。
> - **断言には `file:line` を付ける**という本リポジトリの規律（`CLAUDE.md` R1）に従い、
>   §4-5 の実装状況はすべて実コードの出典付きで書いてある。**出典の無い項目は「未確認」と明示**した。

---

## 0. E2E フロー全体像（6ステップ）

```
①EC購入(サブスク検査プラン)
   └─▶ ②プラン→キット構成・検査タイミング(版管理)  ……(c)§1,§6.1
          └─▶ ③倉庫(タカセ)へ発送指示 / ユーザーへ進捗管理  ……(c)§2,§3
                 ├─▶ ④AI問診＋検体返送を促し、問診データを各社へ所定方式で受渡  ……(b)全体 / (a)受取方式 / (c)§4.1
                 │       ・血液=リージャー(PowerShell・専用PC/mTLS) / がん=プリベント(専用ポータル+S3を提案中) /
                 │        AI疾病予測=LAiF(専用ポータル+S3) / 遺伝子=Genoplan(サーバ側API取得・2026-09-01 実証済)
                 └─▶ ⑤各社の検査結果を所定タイミング(仮:週次)でチェック→
                         必要データが揃ったらElith形式へラップ→AWS S3へ書き出し  ……(a)変換 / Elith各spec
                            └─▶ ⑥ElithのAI診断結果(PDF)をS3から受取→Webアプリへ表示UP
                                    (受取仕様は今後詰める・バケット設定済・PDF・表示実装テスト済)
```

- **責務分界（横断・重要）**: **UI＝wellfort-site（admin/マイページ）／処理・鍵・API＝Scan-Chat-AI**（`CLAUDE.md`「admin UI は wellfort-site / Scan-Chat-AI は API 提供側」）。鍵は **Vercel 本番 env のみ**。
- **PII 分離**: 外部・S3・診断系に氏名/住所は載せない。橋渡しは `client_id=diagnostic_user_id`（仮名）。**例外＝LAiF/プリベント上りCSVの生年月日**（発注者決定・ポータルで保護・(b)§6／(c)§4.1.1）。
- **ID 体系（採番・相関・PII境界・将来の外部ID/キット物理ID連携）＝`docs/architecture/id_management_and_correlation_spec.md` が正本**（顧客ID/診断ユーザーID/契約ID/検査ID/Elith client_id を層別に整理）。

---

## 0-2. もう 1 本の入口 — 単品検査商品（サブスク外）

**①〜⑥はサブスク検査プランの流れ**。EC にはこれとは別に**単品（非サブスク）検査商品**があり、
**購入単位が「1 商品」**なので出荷スケジュールも回数も無い。**別軸として本節で束ねる**
（詳細の正本＝(d) `single_item_purchase_handling_spec.md`）。

```
①EC購入(単品検査商品)
   ├─ ① AI疾病予測報告書 (LAiF・¥55,000)
   │     ユーザー: 人間ドックデータUP ＋ AI問診  →(両方揃ったら)→ Excel生成→LAiFへ送信
   │                                              →レポート受信→マイページへ格納   [Elith納品なし]
   ├─ ② AI疾病予防報告書 (Elith・¥7,700)
   │     ユーザー: 人間ドック**又は**健診データUP ＋ AI問診 →(両方揃ったら)→ OCR→JSON→S3
   │                                              →Elithがレポート生成→PDFをマイページへ [Elith納品あり]
   └─ ③ ジェノプラン遺伝子検査キット (Genoplan・¥32,780)
         ユーザー: 検体送付＋**検査会社サイトで**アンケート回答 (Webアプリの問診は使わない)
                   →サーバ側が自動DL→マイページへ格納                              [Elith納品なし]
```

| # | 商品 | 問診の入手 | ユーザーのUP | 上り | 下り | Elith納品 |
|---|---|---|---|---|---|---|
| ① | AI疾病予測(LAiF) | WebアプリAI問診 | 人間ドック | **Excel を自動送信** | レポート受信→マイページ | **なし** |
| ② | AI疾病予防(Elith) | WebアプリAI問診 | 人間ドック**又は**健診 | OCR→JSON→**S3** | ElithのPDF→マイページ | **あり** |
| ③ | 遺伝子(Genoplan) | **検査会社サイトで直接** | なし（検体送付） | （検体） | **サーバ側が自動DL**→マイページ | **なし** |

**サブスク（①〜⑥）と何が同じで何が違うか**

| | サブスク | 単品 |
|---|---|---|
| ②プラン→キット構成・回数 | あり（版管理） | **無い**（1 商品 1 回） |
| ③タカセ出荷指示 | あり | **③のみ物理キット**（①②は発送なし） |
| ④問診 | AI問診（がん・LAiF へ受渡） | **①②＝AI問診／③＝検査会社サイト** |
| ⑤Elith へラップ→S3 | あり | **②だけ**（①③は生じない） |
| ⑥AI診断結果の表示 | あり | ①②③とも**マイページに格納・表示** |
| 起動トリガ | 検体返送・各社受領の進捗 | **①②＝「データUP ＋ 問診」が揃った時点**／③＝レポート発行 |

- **①②の起動判定は ⑤ の「揃った時点」判定と同じ機構を流用する**（別実装にしない）。
- **③の取得はサブスク購入分と同じ実装**（`src/lib/genoplan.ts` ＋ `POST /api/admin/genoplan-fetch`）。
  **商品が単品かサブスクかで取得方法は変わらない** — Genoplan 側は同じ 1 つの一覧に並ぶ。
  したがって ③-1 の**キット個体IDの捕捉（誰のレポートか）も単品で同じく必要**。
- **【事業判断・関連】従来の AI疾病予防報告書（Wonderlust社製）は保守契約を解除し停止**（保守 15 万円／月の支払い終了）。
  **後継＝②（Elith社製）**。旧レポートの表示・導線の撤去と移行計画が要る（(d)§5-5・§6）。
- **紙面（②の中身）の正本は `docs/elith/AI疾病予防報告書_仕様書.md`**。単品購入は同仕様書の**タイプ2**に当たる。
- **正本**: (d) 全体（商品別フロー・まとめ表・残る要確認・実装への影響）。

---

## ① ユーザーが EC で検査プラン商品を購入

- **対象＝サブスク検査プラン（4バリアント）**。商品DB `test_products`（wellfort-site Supabase）の行、契約は `subscriptions`。決済は GMO（`gmo_subscription_billing_spec`）。
  - 幹部(50代以上) ¥187,000/157,300・年3回(4カ月毎)／幹部(30・40代) ¥143,000/113,300・年2回(6カ月毎)／ミドル(50代以上) ¥90,200/60,500・年3回／ミドル(30・40代) ¥79,200/49,500・年2回。
- **契約成立で D0 を確定**: **D0＝契約日（＝決済日）／土日祝は翌営業日**（`warehouse_calendar`）。以降の全スケジュールの起点。
- **正本**: (c)§1・§1.1（プラン×キット×タイミング／商品DB連携）。

## ② プラン毎にアセットされた検査キット・検査タイミング

- **キット構成・回数・発送間隔は「版管理された別テーブル」で保持**（確定＝案A・正規化＋版管理）:
  - `test_kits`（キット/項目マスタ・`kind`=physical_kit/data/app・`lab_company`・`format_id`）／`plan_compositions`（プラン構成ヘッダ＝版・per_year・interval_months・is_current）／`plan_composition_items`（明細・`ship_rule`=every/first_only/none）／`subscriptions.plan_composition_id`（**契約時の版をpin**＝プラン改定後も既存契約は当時構成のまま）。
- **物理キット発送（タカセ対象）＝ 遺伝子・がんリスク・血液**。
  - 遺伝子＝初回のみ(first_only) ／ がん＝毎回(every) ／ 血液＝毎回(幹部のみ) ／ AI疾病予測(LAiF)＝none（データ受領・年1回相当） ／ AI疾病予防＝none（アプリ機能・開発中）。
- **正本**: (c)§1・§6.1（DDL・初期データ・変更シナリオ耐性）。合成データ `elith-plan.ts` は上記テーブルを正として4プランへ拡張。

## ③ 倉庫（タカセ）への発送指示 ／ ユーザーへの進捗管理

### ③-1 タカセ出荷指示（プラン駆動の定期出荷）
- **契約時にキット別の出荷スケジュールを確定・登録**。各回予定日＝`D0 + 発送間隔(4/6カ月)×回index`（月末クランプ・非営業日は翌営業日）。キット別ルール（遺伝子=初回のみ／がん・血液=毎回）。
- 各予定日に、その回で発送するキットだけを **1件=1出荷指示（CSV行）** で生成→タカセへCSV送信（現行 `cron-shipping` を**スケジュール参照型**へ拡張・CSV様式は**現行踏襲**）。
- **解約/停止**で以降の予定出荷を停止（契約状態連動）。**冪等性**（契約×回×キットの二重出荷防止・`instruction_sent` 等）。
- **【追加 2026-09-01】出荷実績で「キット個体ID」を受ける**（＝どの箱を誰に送ったか）。
  これが無いと ⑤ で受領した結果を**本人に紐付けられない**（`lab_integration_workflow §2 Workflow 2`＝
  Phase 1 の主軸「発注時に `external_test_id ↔ diagnostic_user_id` を保持して逆引き」が成立しない）。
  - **主経路＝タカセの返送 CSV に相乗り**。**伝票番号を CSV で返してもらう仕組みが既にある**
    （下記 ③-2 の `tracking_no`）ので、**同じ CSV に個体IDを 1 列足す**。新経路は作らない。
  - **補助経路＝受取確認時にスマホ撮影**（案・(a)§4.2(e)）。主経路が欠けた回の保険。任意操作。
  - **【v2.1 更新】プリベント（がんリスク）だけは、この撮影が「補助」ではなく P0 の主経路**になった。
    バーコードNo.（例 `704000xxx`）をユーザーが受取時に撮影して `lab_tests` へ紐づける。
    **Genoplan は従来どおりタカセ返送CSV が主経路**で、撮影方式へ差し替えない。→ **§4-5.7** と
    `docs/lab/kit_receipt_external_id_capture_spec.md`（正本）。
  - 受け皿カラムは実在: `customer.lab_tests.external_test_id` / `external_barcode`
    （`20260601000010_schemas_and_tables.sql`）。**`kit_shipments` 側は列追加が要る**。
  - 遺伝子（Genoplan）での実体＝**認証キー**（`external_test_id`）と**ボックスナンバー**（`external_barcode`）。
    どちらも Genoplan の API が構造化データで返すので **OCR は不要**（(a)§4.1.2）。
  - **採番タイミング・スキャン工程の確定＝`id_management_and_correlation_spec §7-3`**（未実装）。
- **正本**: (c)§2。

### ③-2 Webアプリ 検査キット・ライフサイクル管理
- 状態機械（1キット×1回）:
  `出荷予定 → 出荷指示済 → 発送済 → [ユーザー]受取確認 → 検体採取/問診 → 検体返送 → 検査会社受領 → 検査結果受領 → Elithデータ作成 → 完了`。
- **ユーザー操作＝「受取確認」「返送済」**。各状態に日時・担当を記録。管理者ダッシュボード（サブスク契約管理）から契約単位で全キット進捗を一覧・操作。
- **正本**: (c)§3・`docs/lab/kit_progress_management.md`（パイロット実装済）。

## ④ 問診データが必要な検査：AI問診＋検体返送を促し、各社所定方式で受渡

### ④-1 AI問診の促し（催促エスカレーション・確定）
- 検体返送に関する Webアプリ通知の時点で **AI問診が未完了なら催促**（ハードブロックしない＝返送は止めない）。未完了の間 **毎日 Webアプリ通知**、**7日超で Wellfort 管理者へワーニング**。問診完了で停止。
- 問診CSVの各社受渡は**問診完了が前提**。
- **正本**: (c)§3.1。

### ④-2 AI問診回答 → 各社CSV 写像・受渡
- **AI問診（`LifestyleQuestionnaireData`）＋健診スキャン（`HealthCheckupData`）＋基本情報**を、**各社が必要とする項目・記法へ決定論写像**（捏造ゼロ・値の無い項目は空）。共通設問No→各社行のマスターマッピングで管理。
  - がん（プリベント）＝主要33項目 ／ LAiF＝主要35項目〔上り入力フォームは約158項目に拡張・(c)§4.1.1〕。
  - **血液（リージャー）と遺伝子（Genoplan）は本項の対象外**（2026-08-26 確定・(a)§0.2）。
    血液＝ユーザーが専用用紙へ記入し検体と郵送／遺伝子＝ユーザーが Genoplan の検査専用 Web へ直接入力。
    どちらも**弊社を経由しない**。旧記載の「血液 23項目／遺伝子 主要70項目」は確定前の検討値なので削除した
    （`questionnaire_to_lab_csv_spec §4.4` の Genoplan 列・§7-7 の血液も対象外で解消済み）。
- **正本**: (b) 全体（§3 マスターマッピング／§4 各社項目リスト／§5 生成ルール／§6 会社別出力仕様）。LAiF 上りCSVの集約写像は (c)§4.1.1（3系統源・進捗駆動生成）。

### ④-3 各社への受渡方式（所定方式＝会社別）
| # | 検査 | 検査会社 | 受渡・受取方式 | Elith format_id | ステータス |
|---|---|---|---|---|---|
| 1 | 血液 | リージャー（デメカルDSS） | **PowerShell**（専用PC・mTLS・無人定期実行）で CSV DL → 決定論パース。**RPA/PAD 不要**（2026-08-31 確定・正本 `demecal_unattended_spec.md`） | `BloodTestData` | サーバ側実装済／**PC側は未実装**。bat は **2 本立て**＝①偵察・初回テスト `scripts/demecal-recon.ps1`（実装済・ログイン後のDL画面 form をその場で自己発見）→ ②本番の自動実行（①の結果を見てから作る）。**`LAB_INTAKE_API_KEY` が未実装**（無人化の前提） |
| 2 | がんリスク（尿） | プリベント（ALA-PDS） | **専用ポータル＋AWS S3＋パスキー方式（採用方式・v2.1）**。上り＝問診CSV を先方が DL／下り＝結果PDF を同ポータルから UP | `CancerRiskAssessmentData` | **一部実装**。パスキー Portal・結果PDF の Presigned PUT・受領一覧は**実装済**／**本番問診CSV の生成・配布**と**受取時バーコード撮影**と**結果の ID bind** は**未実装**（→ §4-5.3） |
| 3 | AI疾病発症予測 | LAiF | **AWS S3 専用バケット**（ポータル・パスキー・**上り＝所定XLSX**／下りPDF）。※**CSV ではない** | `Other`(ai_prediction) | 受取方式確定・スキャン実装済。**上り XLSX ビルダーも実装済だが CLI 単体**で、入るのは人単位の仮名ID 1 か所のみ。**本番配布結線と結果の検査ID bind は未実装**（→ §4-5.5） |
| 4 | 遺伝子 | Genoplan | **サーバ側（Vercel）から API 取得**（ID/PW のみ・**クライアント証明書も Cookie セッションも無い**＝**RPA も PowerShell も専用PC も不要**・2026-09-01 実証。正本 `lab_data_reception_overview.md §4`） | `GeneticTestResultData` | **取得＝実装済**（`src/lib/genoplan.ts` ＋ `POST /api/admin/genoplan-fetch`）。**実証で 72 件全件取得成功・失敗 0**。差分は**ボックスナンバーの差集合**で判定（日付では絞れない）。**顧客への割当は未実装**（③-1 の個体ID捕捉待ち） |
- **正本**: **検査IDの紐づけ／問診受渡／結果受領の横断は本書 §4-5（v2.1）**。会社別の詳細は (a) 各章（§1血液／§2がん／§3 LAiF／§4遺伝子）。
  LAiF/プリベントのセキュア受渡設計＝`docs/lab/laif_s3_secure_handoff_spec.md`（ゼロトラスト・多層防御）。
  受取時の外部検査ID 撮影／登録＝`docs/lab/kit_receipt_external_id_capture_spec.md`。

## 4-5. 外部検査ID の紐づけ ／ 問診受渡 ／ 結果受領（**4検査横断・v2.1 正本**）

| 項目 | 内容 |
|---|---|
| 版 | **v2.1 / 基準日 2026-10-09** |
| 位置づけ | **4検査横断の「①検査IDの紐づけ ②問診データの受渡 ③検査結果の受領」は本節が現行正本。** |
| 優先順位 | **本節 ＞ 会社別詳細仕様 ＞ 旧版**。会社別詳細仕様（`demecal_unattended_spec.md` / `laif_s3_secure_handoff_spec.md` / `lab_data_reception_overview.md` / `id_management_and_correlation_spec.md` 等）は、**本節と矛盾しない範囲で有効**。矛盾したら本節が勝つ。 |
| 上書きする旧前提 | `lab_data_reception_overview.md`（2026-09-01c 以前）／`id_management_and_correlation_spec.md`（2026-08-12）に残る旧前提 → §4-5.11。 |
| 本節で扱わないこと | 問診項目の写像表（=(b)）／キット出荷スケジュールの DDL（=(c)）／Elith ラップ（Elith 各 spec）。**二重管理しない。** |

> **本節は「①〜⑥の流れ」のうち ③-1（キット個体ID）・④（問診受渡）・⑤（結果受領）に横串を通したもの**であり、
> ①〜⑥の記述を置き換えるものではない。各ステップの本文は従来どおり上に在る。

### 4-5.1 ID の正本定義

| ID | 役割 | 正本／格納先 | 実在確認 |
|---|---|---|---|
| `diagnostic_user_id` | **人**単位の非PII通しキー | Wellfort 内部（`diagnosis.app_users` 主キー） | `supabase/migrations/20260601000010_schemas_and_tables.sql:173-174` |
| `lab_tests.id` | **1回・1検査**単位の内部主キー | Wellfort 内部（`customer.lab_tests`） | 同 `:143-162` |
| `external_test_id` | 検査会社が発行する**外部検査ID／認証キー** | `customer.lab_tests.external_test_id`（`unique (lab_company_id, external_test_id)`） | 同 `:150,161` |
| `external_barcode` | **検査キットの物理ID**（バーコードNo. / ボックスナンバー等） | `customer.lab_tests.external_barcode` | 同 `:151` |
| `kit_shipments.tracking_no` | **配送追跡番号**（ヤマト等） | `customer.kit_shipments.tracking_no` | 同 `:112,123` |
| ②上りID（整理番号） | 各社へ**渡す**仮名ID | **列が存在しない**（`upstream_ref` の新設案＝`lab_data_reception_overview.md §5.2/§5.5`） | 実測 |

**原則（厳守）**

- **外部検査会社の番号を Wellfort 内部主キーへ置き換えない。** 内部主キーは `lab_tests.id` を維持し、外部IDは**相関キー**として併置する。
- **`external_test_id`（検査会社の検査ID）と `external_barcode`（物理キットID）と `tracking_no`（配送追跡番号）を混同しない。** 3 つは別物。
- **0 件 / 複数件 / 重複 / 不一致は自動確定しない**（`review_required` に落とす）。
- 手動訂正は **理由・操作者・時刻**を監査可能に残す。

### 4-5.2 4検査サマリー

| 検査 | 取得方式 | 上り（問診等） | 下り（結果） | ID紐づけ | 現状 |
|---|---|---|---|---|---|
| **① がんリスク（プリベント / ALA-PDS）** | 専用ポータル＋AWS S3＋**パスキー** | 問診CSV を先方が DL | 結果PDF を同ポータルから UP | 先方**バーコードNo.**（例 `704000xxx`）を**受取時にユーザーがスマホ撮影**し、対象 `lab_tests.id` へ紐づけ | 一部実装（§4-5.3） |
| **② 血液（リージャー / デメカル）** | 専用PC＋**PowerShell**＋mTLS＋ID/PW＋**無人定期実行**（2026-08-31 確定） | 紙問診を検体と同梱返送（**弊社からの電子受渡なし**） | DSS から結果CSV を自動取得 | **Primary（暫定）= 氏名＋生年月日** ／ **Secondary（計画）= 受取時に 15桁「問合せ番号」を撮影** | 取得系は実装進行／本人紐づけ未実装（§4-5.4） |
| **③ AI疾病予測（LAiF）** | 専用ポータル＋AWS S3＋**パスキー** | **所定XLSX**（CSV ではない）を先方が DL | 結果PDF を同ポータルから UP | Wellfort 側の検査IDを往復キーにする（**目標**。現状は人単位の仮名ID） | 一部実装（§4-5.5） |
| **④ 遺伝子（Genoplan）** | **Vercel サーバから API 取得**（ID/PW のみ・証明書／専用PC 不要・2026-09-01 実測） | **弊社からの受渡なし**（Genoplan 側 Web で本人が回答） | API から結果PDF を自動取得 | **タカセ出荷時に「ヤマト送り状番号＋ボックスナンバー」を既存出荷指示CSVの同一行へ追記 → 返送CSVを取込** | 取得は実装済／割当は未実装（§4-5.6） |

### 4-5.3 ① がんリスク検査（プリベント / ALA-PDS）

**確定仕様（E2E）**

1. ユーザーが検査キットを受取・開封する。
2. Webアプリの受取確認時に、同梱の IDシートの **バーコードNo.（例 `704000xxx`）** をスマホで撮影する。
3. 読取値をユーザーが確認したうえで、対象 `lab_tests.id` へ紐づける。
4. AI問診の完了後、**このバーコードNo. を載せた**プリベント向け問診CSV を生成する。
5. プリベント担当者が**パスキー必須**の専用ポータルへログインし、該当問診CSV を DL する。
6. 結果PDF を同ポータルから UP する。**結果は同一バーコードNo. で対象検査へ戻せる状態**を完成条件とする。

**完成条件（E2E 一貫性）**

`lab_tests.id` → 受取時の `704000xxx` → 問診CSV → 物理検体 → 結果PDF → **同じ `lab_tests.id`**

**実装状況（実コードで確認・2026-10-11）**

| 要素 | 状態 | 根拠 |
|---|---|---|
| パスキー必須 Partner Portal | **実装済** | wellfort-site `src/lib/partner-auth.ts:43`（`PARTNERS = ['laif','prevent']`）／`src/pages/partner-portal-preview.astro:3-5`（「パスキー認証が必須の本番画面」「常時必須」）／`supabase/migrations/20260909000010_partner_portal_auth.sql:30-115`（6 表） |
| 結果PDF → S3 Presigned PUT | **実装済** | wellfort-site `src/pages/api/partner/upload.ts:78-89` → Scan-Chat-AI `src/pages/api/partner/laif-upload.ts:52-68` → `src/lib/laif-portal.ts:149-183` |
| 受領一覧（`mode:'list'`） | **実装済（本番結線）** | `src/pages/partner-portal-preview.astro:518`／`src/lib/laif-portal.ts:268-272` |
| **顧客ごとの本番問診CSV 配布** | **未実装**（画面は記入例サンプルを返す） | `src/pages/partner-portal-preview.astro:10,200,216`（「入力ファイルの取得だけは、まだ配布用のサンプルを返す」） |
| **受取時バーコード撮影／ID登録** | **未実装** | `704000` の文字列が両リポジトリに **0 件**（実測 grep）。撮影UI・読取・登録APIとも存在しない |
| **結果PDF upload 時の `704000xxx` 構造的 bind** | **未実装** | §4-5.5 の調査結果と同じ（キーに検査IDが入らない） |
| プリベント向け問診CSV 生成コード | **未実装** | 生成処理が **0 件**（実測 grep）。写像表だけが `questionnaire_to_lab_csv_spec.md §4.2`（33項目）に在る |

### 4-5.4 ② 血液検査（リージャー / デメカル）

**取得方式（確定・2026-08-31）**

- **専用PC ＋ PowerShell ＋ mTLS ＋ ID/PW ＋ 無人定期実行**。**RPA / PAD / ブラウザ要素操作は使わない。**
- `last_to` を状態管理し、**取り込みに成功した範囲だけ前進**させる（失敗時に前進させない）。走らない日があっても次の成功回がまとめて回収するので**取り漏れゼロ**。
- 原本CSV は **完全な PII を含む**ため、取込後に削除する。正本＝`demecal_unattended_spec.md`。

**ID紐づけ方針**

- **Primary（暫定）**: 結果CSV の **氏名 ＋ 生年月日**で Wellfort のユーザー／検査を照合する。
- **Secondary（計画）**: ユーザーが受取時に同梱用紙の **15桁「問合せ番号」**をカメラ撮影して先に紐づけておく。
- Primary で **0 件／複数件**になる回は自動確定せず `review_required`。Secondary が登録済みならその補助キーを使う。

**実装前ゲート（v2.1 の指摘を実データで再確認・2026-10-11）**

v2.1 原案は「氏名列の存在確認を実装前ゲートとする」としていた。**列の存在は文書・fixture の両方で確認できた**ので、
ゲートの残りは **パーサ改修**と**実受領CSVでの最終確認**だけになる。

| 確認 | 結果 | 根拠 |
|---|---|---|
| 実CSV に氏名列が在るか | **在る。ただし `氏名` 1 列ではなく `姓` / `名` / `姓かな` / `名かな` の 4 列** | `docs/lab/demecal_unattended_spec.md:594-596`（実画面から起こした列一覧）／本番様式 fixture `scripts/blood-csv-fixtures/prod_ok_2rows.sjis.csv` のヘッダ 1-5 列目＝`指図番号,姓,名,姓かな,名かな` |
| 生年月日列が在るか | **在る**（`生年月日`） | 同上（7 列目）／`src/lib/elith-blood-csv.ts:308,524` が実際に読んでいる |
| パーサは氏名を読むか | **読まない。`氏名`/`姓`/`名`/`かな` の列引当が 0 件**（PII を Elith JSON に載せない設計のため意図的） | `src/lib/elith-blood-csv.ts:8-10`（PII 厳守）・実測 grep |
| 旧記述「氏名は無い」 | **`demecal_sample_v1.csv`（当社が作った合成 fixture）についての記述**で、実様式の話ではない | `docs/lab/demecal_unattended_spec.md:81`（この行の根拠が `demecal_sample_v1.csv`）。同じ文書の `:600` は実CSV を「**完全な PII**（氏名・カナ・生年月日・電話・郵便番号・住所・メールアドレス）」と書いている |

→ **帰結**: 「氏名＋生年月日」を Primary にする方針は**データ上は成立する**。残る実装前ゲートは
**①`elith-blood-csv.ts` に氏名列の引当を足す（PII を S3 へ出さないまま、照合にだけ使う）
②実受領CSV 1 本で列名の完全一致を確認する**の 2 点。

**15桁「問合せ番号」と DSS `指図番号` の関係 — 未確認（断定しない）**

| 観測 | 根拠 |
|---|---|
| `指図番号` の実値は **15桁前後**の数値（Excel が `2.02E+14` と丸めて表示） | `docs/lab/demecal_unattended_spec.md:599`／`src/lib/elith-blood-csv.ts:539`（「実値は 15 桁前後の数値だが、Number 化すると 16 桁以上で精度が落ちる」ため string 保持） |
| 本番様式 fixture の `指図番号` は **16桁・17桁** | `scripts/blood-csv-fixtures/prod_ok_2rows.sjis.csv`（`20212345678901234`＝17桁 / `0202123456789012`＝16桁）。**ただしこれは当社が作った架空値** |

→ **桁数が一致しないので「同一」とは言えないし、「別物」とも言えない。**
**実受領CSV の `指図番号` と、実際のキット同梱用紙の「問合せ番号」を 1 件突き合わせるまで、同一と断定しない**（禁止事項）。
Secondary の設計は**同一でなくても成り立つ**ように（`external_test_id` へ独立に保存し、Primary を置き換えない）作る。

**問診データ（上り）**

血液は **Wellfort から電子問診データを渡さない**。ユーザーが専用用紙へ記入し、検体とともに返送する（`lab_data_reception_overview.md §0.2`・2026-08-26 確定）。

### 4-5.5 ③ AI疾病予測（LAiF ほか Elith 以外）

**確定仕様**

1. Wellfort 側で **1 検査ごとの内部検査ID** を確定する。
2. 先方へ渡す問診データに**その検査IDを含める**。
3. 先方は**パスキー必須**の専用ポータルから問診データを DL する。
4. 結果PDF をアップロードする際、**同じ検査IDを指定して**提出する。
5. Wellfort はその ID で `lab_tests.id` へ一意に戻す。

**ファイル形式**

本節の共通仕様では「**問診データ**」と定義し、会社別の所定形式に従う。
**LAiF の現行実装は CSV ではなく所定 XLSX**（`input_format_new_202312.xlsx`・No.0〜157）。
**一般論で CSV に変えない**。CSV を使う会社では `test_id` を必須列／メタデータとして含める。

**実装状況（実コードで確認・2026-10-11／v2.1 原案を 2 点訂正）**

| 要素 | 状態 | 根拠 |
|---|---|---|
| Partner Portal / パスキー | **実装済** | §4-5.3 と同じ（`PARTNERS` に `laif` を含む） |
| 結果PDF → S3 Presigned PUT | **実装済** | `src/lib/laif-portal.ts:149-183`（着弾は必ず `quarantine/`・PDF 限定・サイズとContent-Type を署名に固定） |
| 顧客別 LAiF 入力 XLSX 生成 | **実装済（ただし CLI 単体）** | `scripts/build-laif-input.py`（＋`scripts/laif_form_rules.py` が入力規則の全数検証） |
| 受領一覧（`mode:'list'`） | **実装済（本番結線）** | `src/pages/partner-portal-preview.astro:518` |
| **Partner Portal の本番「入力ファイル」配布結線** | **未実装** | `src/pages/partner-portal-preview.astro:10,200,216` |
| **結果 upload 時の検査ID bind** | **未実装** | 下記「bind の最終確認」 |

**訂正 1 — 「Wellfort 整理番号／検査IDを XLSX に含める」は現状**成り立っていない**。**

v2.1 原案は「所定XLSXを顧客別生成し **Wellfort整理番号/検査IDを含める**。実装済」と書いていたが、実コードは違う。

- `scripts/build-laif-input.py:264` が書き込むのは **名前欄 G1 の `client_id` 1 か所だけ**。
  No.0「識別番号」は **LAiF 指摘により黒枠＝自動計算なので記入しない**（同 `:262-263`）。
- その `client_id` は**人単位の仮名ID**（`diagnostic_user_id` 層＝①）であって、
  **`lab_tests.id`（検査単位）でも ② 整理番号でもない**。
- **② 整理番号の採番機構そのものが未実装**（`整理番号` の実装ヒットが `src/` `scripts/` で **0 件**。
  `lab_data_reception_overview.md §5.4` 項目 1・2 と一致）。
- したがって **現状の往復キーは「人」までしか効かず、「どの回か」は ID だけでは判別できない**。
  採番規則（§5.3 の案 A-1/B-3 等）の決定が先行条件。

> なお `lab_data_reception_overview.md §5.4` 項目 2 の「G1 **と No.0** に書いている」は**現行コードより古い**。
> No.0 への書き込みは 2026-08-27 の LAiF 指摘で撤回済み（`build-laif-input.py:262-266`）。

**訂正 2 — Partner Portal は「サンプル一覧の画面」ではない。**

v2.1 原案は「現行 `wellfort-site/main` のPartner Portal画面はサンプル一覧のため…」としていたが、現行 `origin/main` では

- 画面自体は**パスキー必須の本番画面**（`partner-portal-preview.astro:3-5`）、
- **結果PDF の提出は本番と同じ実転送**（同 `:8`）、
- **受領一覧も本番結線**（同 `:518`）。

**サンプルなのは「上り入力ファイルの取得」だけ**（同 `:10,200,216`）。

**bind の最終確認（v2.1 完了報告 項目12 への回答）**

「upload ticket だけを見て未実装と断定しない」との指示に従い、**提出から後段までの経路を全て追った**。結論は **未実装**。

| 追った箇所 | 検査IDを運ぶか | 根拠 |
|---|---|---|
| wellfort-site の中継 | **運ばない**。転送するのは `mode / partner / filename / contentType / bytes` のみ | `src/pages/api/partner/upload.ts:82-88` |
| Scan-Chat-AI の受け口 | **運ばない**。`createUploadTicket` へ渡すのは `partner / filename / contentType / bytes` | `src/pages/api/partner/laif-upload.ts:52-58` |
| S3 キーの採番 | **検査IDを含まない**。`{quarantinePrefix}{partner}/{YYYY/MM/DD}/{UUIDv4}.pdf`。元ファイル名は **S3 メタデータにのみ**保持 | `src/lib/laif-portal.ts:182-183` |
| キー検証 | 上記の**形だけ**を見る（検査IDの欄が無い） | 同 `:219-224`（`isQuarantineKey`） |
| 後段の consumer | `listUploads` / `createDownloadUrl` / `revokeUpload` の **3 つだけ**。**`quarantine` を読んで `lab_tests` へ結び付けるコードは両リポジトリに 0 件** | 同 `:261-272,297-322,354`／両リポジトリ `src` 全体の `quarantine` 実測 grep |

→ **別経路の bind 処理も存在しない。** 現状、提出された結果PDF は
**「どの検査のものか」を機械的に判別できない**（ファイル名を人が読む以外に手段がない）。

### 4-5.6 ④ 遺伝子検査（Genoplan）

**取得方式（確定・実装済・2026-09-01 実測）**

- Vercel サーバから Genoplan の PHP REST API へ直接接続。`GENOPLAN_LOGIN_ID` ＋ `GENOPLAN_PASSWORD` のみ。
  **クライアント証明書・Cookie セッション・専用PC は不要。**
- 発行済みレポートを API から抽出して PDF を取得。差分判定は**ボックスナンバーの差集合**（日付では絞れない）。

**ID紐づけ方針（最新版）**

1. Wellfort → タカセの**既存**出荷指示CSV でキットを発送する。
2. タカセが出荷作業時に、**ヤマト運輸送り状番号 ＋ Genoplan ボックスナンバー**を**同じ出荷行**へ追記する。
3. 返送CSV を Wellfort が取り込む。配送追跡番号／出荷行から `kit_shipments` を特定し、
   ボックスナンバーを当該 `lab_tests` へ保存する。
4. Genoplan API から結果取得時、**API が返すボックスナンバーで `lab_tests` を逆引き**して結果PDF を対象ユーザーへ割り当てる。

> **DB 上の置き場**: 物理キットID である**ボックスナンバーは `external_barcode`**。
> Genoplan API は別に認証キー `serialNumber` も返すので、こちらは `external_test_id` として併置できる。
> **業務上の主照合キーはボックスナンバー。**

**【禁止】④をユーザー撮影方式へ置き換えない。** 正本は**タカセ返送CSV 方式**。
受取時撮影の共通部品を将来 Genoplan へ流用できる設計にするのは可だが、**今回の実装で方式を差し替えない**。

**実装状況**

| 要素 | 状態 | 根拠 |
|---|---|---|
| API login / 一覧 / PDF 取得 | **実装済**（実証で発行済み 72 件を全件取得・失敗 0） | `src/lib/genoplan.ts`／`src/pages/api/admin/genoplan-fetch.ts` |
| PDF 保存キー | **実装済**（`genoplan/{boxNumber}__{serialNumber}.pdf`） | `src/lib/genoplan.ts:210-213`（`originalKey`）／`src/pages/api/admin/genoplan-fetch.ts:267` |
| 取得時の外部ID 控え | **実装済**（`external_test_id`=`serialNumber` / `external_barcode`=`boxNumber` を JSON で横に保存。**氏名・電話は入れない**） | `src/pages/api/admin/genoplan-fetch.ts:268-282`（とくに `:274-275`） |
| **顧客への割当** | **意図的に未実施** | 同 `:281`（「顧客への割り当ては未実施（対応表の運用工程が未確定）」） |
| **タカセ返送CSV のボックスナンバー取込 → `lab_tests` 紐づけ** | **未実装** | 実測 |

### 4-5.7 受取時・外部検査ID 撮影／登録（**P0・新規**）

ユーザーが検査キットを受け取った時点で、検査会社がキットに付与した外部IDをスマホで撮影・読取し、
Wellfort 内部の「今回の検査」へ安全かつ一意に紐づける。

- **P0 = ① プリベントの `704000xxx`**（撮影対象＝「ユーザーID」の印字と **1次元バーコード**）。
- **P1 = ② デメカルの 15桁「問合せ番号」**（Secondary）。
- **対象外 = ④ Genoplan**（正本はタカセ返送CSV 方式・§4-5.6）。

**【UI の確定事項】プリベントの撮影対象に QR コードを据えない。**
ガイドは**書面全体**を見せ、その中の「ユーザーID」と**その近傍の 1次元バーコード**を枠で囲って示す。
ユーザーに QR コードを撮影対象と誤認させない。

**正本＝`docs/lab/kit_receipt_external_id_capture_spec.md`（v1.0・実装済み／既定 off）。** 触る前に必読。

**【実装済み 2026-10-11・発注者裁定を受けて】**

| 裁定 | 内容 |
|---|---|
| **D-1 = 案A** | **登録時に `lab_tests` 行を作る。** 本番の shipment は `app_bridge`（= `orders` のミラー）由来で `lab_company_id` が空・`customer_id` が実は `diagnostic_user_id`・受取 ID が `customer.kit_shipments` に無いので、**材料はその場で引き直し、`shipment_id` は実在を確かめた時だけ入れる**（埋めに行くと本番で FK 違反）。揃わない回は `deferred` で台帳に残し**撮影を失わない** |
| **D-4 = サーバ側 Gemini** | `BarcodeDetector` は **iOS Safari に無い**ので単独では成立しない。`/scan` が本番で使っている「ブラウザ → S3 → Gemini」と同じ形にした＝**追加依存ゼロ・端末差なし** |

→ **§4-5.3 の「受取時バーコード撮影／ID登録: 未実装」はこれで解消**（ただし下記のとおり**既定 off**）。

**既定は off のまま。** `app_config` の `labid.prevent_capture` / `labid.demecal_capture` が
`off` なので、**画面にも API にも出ない**（UI だけ隠して API を開けた状態にしない）。
**実物の同梱書面 1 枚でバーコード規格と桁数を確定してから on にする**
（`704000xxx` は**業務上の形式例**にすぎない＝§4-5.12 の 1）。

**プリベント問診CSV のゲートは部品として先に置いた** — `checkPreventQuestionnaireGate()`
（純関数・fail-closed）と `loadCapturedExternalId()`。**CSV 生成を実装する人は出力前に必ず通すこと**
（CSV 生成そのものは未実装＝§4-5.9 の P0-2）。

**【v1.1 の是正 2 点・発注者指示 2026-10-11】** 実装レビューで出た 2 件を直した。
**どちらも「今回の検査」の同一性に関わる**ので、ON の前に閉じておく必要があった。

| # | 直したこと | 直さないと何が起きるか |
|---|---|---|
| 1 | **`lab_tests` 行を「人 + 検査種別で 1 件だから」という理由で使い回さない。** 使い回す根拠は、同じ `(diagnostic_user_id, shipment_ref, provider)` の台帳行が既に持っている `lab_test_id` だけ（＝同じ回の撮り直し）。初回撮影は**今回用の行を作る** | プリベントは**年 1 回**なので、2 年目の撮影で前年の行がちょうど 1 件ヒットし、**前年の `external_barcode` を今年の値で上書きする**。前年の結果PDF を辿るキーが消え、画面も台帳も `linked` と表示するので**黙って壊れる** |
| 2 | **問診CSV のゲートを `status='confirmed'` ∧ `lab_test_link_status='linked'` ∧ `lab_test_id` 非 null の 3 条件へ**。`review_required` / `deferred` / `conflict` は fail-closed でブロック。`loadCapturedExternalId()` は **`shipmentRef` か `labTestId` が必須**（「その人の最新」を返さない） | ①値が読めていても**この検査のものだと確定していない**番号で問診CSV が出る ②前年の confirmed なレコードで**今年未撮影のまま CSV が通る** |

→ これで **受取撮影 → 今回の `lab_tests.id` → 問診CSV → 結果PDF** が一本線になる。
詳細は `kit_receipt_external_id_capture_spec.md` §3.2.1 / §7.1。

検証 = `npm run verify:external-id-capture`（**257 件**・CI の A 層。**⑭ が年跨ぎの回帰①〜⑤**）・
**退行注入 22 種**とも名指しで落ちることを確認済み。

### 4-5.8 実装状況の実測訂正（v2.1 原案からの差分）

v2.1 原案の記述を実コードで再確認し、**4 件を訂正**した。いずれも「実装が原案より進んでいる／遅れている」の両方向。

| # | v2.1 原案 | 実測 | 根拠 |
|---|---|---|---|
| 1 | 「Partner Portal 画面はサンプル一覧」 | **本番画面（パスキー必須）。サンプルは上り入力ファイルの取得だけ**。受領一覧は本番結線 | `partner-portal-preview.astro:3-10,200,216,518` |
| 2 | 「LAiF XLSX に Wellfort 整理番号/検査IDを含める。実装済」 | XLSX 生成は実装済だが、**入るのは人単位の仮名ID（①）1 か所のみ**。② 整理番号の採番機構は **0 件＝未実装** | `build-laif-input.py:262-266`／`整理番号` の実測 grep |
| 3 | （血液）「現行parser/fixture/旧仕様には氏名列なしの前提があるため、実CSV列確認を実装前ゲート」 | **列の存在は確認済**（`姓`/`名`/`姓かな`/`名かな`）。ゲートの残りは**パーサ改修**と**実受領CSV での列名最終確認** | `demecal_unattended_spec.md:594-596`／`prod_ok_2rows.sjis.csv` ヘッダ |
| 4 | （本書 §8 実装状況 (f)）「Scan-Chat-AI は `customer` スキーマを**読み取り専用**でしか触れない（`HP_BRIDGE_READONLY_KEY`）ので、書き込みは wellfort-site 側」 | **誤り。`HP_BRIDGE_READONLY_KEY` は wellfort-site 側プロジェクトの `app_bridge` 用**であって `customer` 用ではない。`customer` は Scan-Chat-AI 自身のプロジェクトに在り、**service_role で実際に書いている箇所がある** | `src/lib/supabase.ts:31-38`（service_role クライアント）・`:41-46`（bridge は別物）／`src/pages/api/kit/[id]/self-report.ts:117-123`（`.schema('customer').from('kit_shipments').update(...)`） |

**訂正 4 の意味（重要）**: 「書き込めないから wellfort-site 側」という制約は**存在しない**。
ただし**書けること**と**書くべきこと**は別で、**本番ではキット／注文の正本が wellfort-site の `orders`** にあるため、
`lab_tests` の行をどちらで作るかは**まだ決まっていない設計判断**である（§4-5.12 の 3）。

### 4-5.9 実装優先順位

**P0**

1. **プリベント**: 受取時バーコード撮影 → `lab_tests` 紐づけ（§4-5.7・専用仕様書）。
2. **プリベント**: 本番問診CSV の生成／配布 ＋ 結果PDF への バーコードNo. bind。
3. **AI疾病予測**: Portal の本番配布結線と result ID bind の実装（§4-5.5 のとおり**現状どちらも未実装**）。
   生成済み XLSX を本番画面から DL でき、結果PDF が**同一の Wellfort 検査ID へ機械的に戻る**ことを E2E で確認する。
4. **Genoplan**: タカセ返送CSV のボックスナンバー取込・自動割当。
5. **デメカル**: Primary 照合に使う実受領CSV の列名を確認し、本人照合ロジックを実装（§4-5.4 の残りゲート 2 点）。

**P1**

- デメカル受取時 15桁「問合せ番号」撮影を **Secondary** として実装。
- 重複ID・0件/複数候補・訂正履歴を**管理者レビューに統一**。

### 4-5.10 受入条件（最小）

- 外部結果 1 件が、**推測ではなく機械的キー**で 1 つの `lab_tests.id` へ一意に戻る。
- **0 件／複数件は自動確定しない。**
- 手動訂正は**理由・操作者・時刻**を監査ログへ残す。
- **外部IDと配送追跡番号を混同しない。**
- Partner Portal は**パスキー必須**、PDF は **S3 非公開領域へ Presigned upload**。

### 4-5.11 旧仕様からの上書き事項

| 旧記述 | 上書き後 |
|---|---|
| `id_management_and_correlation_spec.md` の「**現時点＝全ID Wellfort 側で採番・管理**」 | プリベント・デメカル・Genoplan の**外部ID運用については失効**。内部主キーは Wellfort（`lab_tests.id`）、**外部IDは別名／相関キーとして持つ**（§4-5.1） |
| `lab_data_reception_overview.md §2` プリベント「**提案中（プレゼン段階）**」 | ポータル／パスキー／PDF upload の実装が在ることを踏まえ **採用方式**として扱う。ただし**本番問診データ配布と ID capture は未完成**（§4-5.3） |
| `lab_data_reception_overview.md §4` 遺伝子「取得部**未実装**」 | **失効**。API 取得コードは実在し実証済。**未実装は顧客割当だけ**（§4-5.6） |
| `lab_data_reception_overview.md §5.4` 項目 2「G1 **と No.0** に書いている」 | **No.0 への書き込みは撤回済**（`build-laif-input.py:262-266`） |
| 本書 §3 ③-1 の「補助経路＝受取確認時にスマホ撮影（**案**）。主経路が欠けた回の保険。**任意操作**」 | **プリベントについては P0 の主経路**へ格上げ（§4-5.7）。**Genoplan は従来どおりタカセ返送CSV が主経路**で、撮影は採らない |
| 本書 §8 (f)「Scan-Chat-AI は `customer` を読み取り専用でしか触れない」 | **誤りとして訂正**（§4-5.8 の 4） |

### 4-5.12 確認事項（本節で束ねる横断項目）

1. **プリベント バーコードNo. の実フォーマット**（未確認）。`704000xxx` は**業務上の形式例**にすぎず、
   両リポジトリに `704000` の実装・サンプルは **0 件**。**総桁数・prefix の固定範囲・チェックディジットの有無・
   1次元バーコードの規格（CODE39 / CODE128 / ITF 等）**を、先方資料または実物 1 枚で確定する。
   → 確定するまで**桁数と prefix をコードへ固定しない**（設定または共通 validator に置く）。
2. **デメカル 15桁「問合せ番号」と DSS `指図番号` の関係**（未確認・§4-5.4）。
   実受領CSV と実物の用紙を 1 件突き合わせる。**同一と断定して Primary を置き換えない。**
3. **`lab_tests` の行を誰がいつ作るか** → **裁定済み 2026-10-11 = 案A（登録時に作る）。**
   以前はここが「最重要・未決」だった（`customer.lab_tests` を SELECT している箇所は
   `src/lib/chat-context.ts:79-80` の 1 つだけで、INSERT / UPDATE / UPSERT は両リポジトリに 0 件・
   既存行は seed だけ＝`supabase/seed.sql:128` 他）。
   **§4-5.7 の実装が「登録時に作る」側を引き受けた**ので、
   **プリベントの受取時 ID 取得（P0-1）はこの先行条件に縛られなくなった。**
   - **ただし ②③④ の P0 は依然この工程を必要とする**。プリベントは「ユーザーが受取時に
     撮る」ので登録のきっかけが画面に在るが、**LAiF の往復キー・Genoplan のボックスナンバー・
     デメカルの本人照合は、受領側から `lab_tests` を逆引きする**ので、
     出荷・受領の工程で行が作られていないと引く相手が無い
     （`id_management_and_correlation_spec §7-3` は未実装のまま）。
   - **本番に `customer.customer_profiles` / `customer.lab_companies` の行が在るかは未確認**
     （この環境から引けない）。無い回は `deferred` になり撮影は残るが紐付かない。
4. **② 上りID（整理番号）の採番規則**（未決）。書式案と単位案は `lab_data_reception_overview.md §5.3`。
   LAiF が経年で同一人物として突合する必要があるか（レポートの昨年比欄）の回答待ち。
5. **キット個体ID の捕捉**: タカセの返送CSV に 1 列足す合意（タカセ側の運用調整）。
6. **撮影証跡画像の保存期間**（未決・§4-5.7 の専用仕様書）。既存の医療関連画像／検査証跡ポリシーに合わせる。
   既存ルールが無いので**こちらで勝手に決めない**。

## ⑤ 検査結果を所定タイミング（仮：週次）でチェック → Elith へラップ → AWS S3 書き出し

- **受領チェック（週次案）**: 各社の受領方式ごとに**受領予定と実績を管理**し、未受領はアラート／再督促。受領でキット行を「検査結果受領」へ前進。〔チェック頻度＝**仮に週次**。確定は §確認事項。〕
- **変換（会社別）**: 血液＝**CSV決定論パース**（LLM不使用）／がん・遺伝子・AI疾病予測＝**画像AIスキャン**（Gemini・サーバ側 admin バッチ）。納品整形は決定論（`sanitizeMeasurementsForDelivery`）に集約。
  - **遺伝子の入力は「取得済みの PDF」**（1 件 208 ページ・約 21MB）。取得は ④-3 のとおり自動化済みで、
    **スキャンは従来どおり PDF → LLM**（`elith-genetic.ts`）。読取範囲は
    `docs/scan/golden/scan_golden_genetic_geneplanet_20240131.md`（疾患リスク項目 220 件・体質系は v1 対象外）。
  - **【未検証・要判断】LLM を通さず JSON→JSON にできる可能性がある**。Genoplan の一般ユーザー向けサイトに
    レポート閲覧画面があり、biz 一覧が返す `report_access_token` を渡すと
    **`POST /api/v2/report/dna/summary_by_token.php`（引数 `token`/`lang`）** で本文を取得している
    （配布バンドルの実測。項目単位の `detail_by_token.php` もある）。**応答の中身は未確認**
    （検証は発注者指示で中止・2026-09-01）。中身に発症リスク倍率が含まれるなら
    **PDF も LLM も経由せず決定論変換にできる**ので、再開の判断材料として記録しておく。
- **Elith データ作成指示**: 当該回の**全必要データ（検査結果＋問診＋ウェルネス年齢等）が揃った時点**で、**Elith 形式 JSON 生成＋S3受渡を指示**。
  - S3 パス `user/{client_id}/date/{YYYY_MM_DD}/{format_id}_date_{YYYY_MM_DD}_user_{client_id}.json`（`client_id=diagnostic_user_id` 仮名）。
  - ウェルネス年齢（CABA）・AI疾病予測も**検査日毎の時系列**で同梱（`elith_assembly_wrapping_spec`）。
- **正本**: (c)§4.2・§4.3／`docs/elith/elith_s3_data_handoff_spec.md`・`elith_batch_centralization_design.md`・`elith_assembly_wrapping_spec.md`。

## ⑥ Elith の AI 診断結果を S3 から受取 → Webアプリへ表示 UP

- **方向＝Elith→Wellfort（下り）**。ElithはAI診断結果を**所定のS3バケットに出力**、Wellfortが受取ってWebアプリ（マイページ）へ表示する。
- **フォーマット＝PDF**。**サンプルデータで表示実装テスト済**。
- **バケット＝設定済**（所定S3）。
- **受取仕様＝これから詰める（未確定）**: 命名規則・出力トリガ／通知・世代管理（同一ユーザー複数回の版）・表示のひも付け（`diagnostic_user_id`／検査日）・受領確認の運用。→ §確認事項。
- **注記**: ①〜⑤は主に**上り（Wellfort→各社／Wellfort→Elith）**、⑥は**下り（Elith→Wellfort→ユーザー）**。上り書き出し（⑤）と下り受取（⑥）は**別S3経路・別仕様**（同一バケットに混在させない前提で受取仕様を詰める）。

---

## 7. 横断事項（4検査・全ステップ共通）

- **鍵一元管理**: AWS/Gemini の鍵は Vercel 本番 env のみ。専用PC・operator・クライアントに鍵を置かない。
- **PII 分離**: `client_id=diagnostic_user_id`（仮名）で橋渡し。氏名/住所は外部・S3・診断系に載せない。氏名OCRのみの割当確定は禁止。**例外**＝LAiF/プリベント上りCSVの**生年月日**（発注者決定・ポータル保護・同意前提の確認は運用）。
- **変換の別**: 血液＝CSV決定論パース／がん・遺伝子・AI疾病予測＝画像AIスキャン。
  ※ 遺伝子は**取得の自動化と変換の方式は別問題**。取得はサーバ側 API で自動化済み、変換は現状 PDF→LLM のまま（⑤）。
- **取得の自動化に「専用PC」が要るのは血液だけ**（クライアント証明書が当該 PC の証明書ストアにしかないため）。
  遺伝子は証明書が無いのでサーバ側で完結する。**「他社も RPA/専用PC が要る」と決めつけない** — 各社ごとに
  ①ログインが機械で通せるか ②成果物が URL で取れるか の 2 点で判定する（(a)§4.1 の判定方法を流用）。
- **admin/UI＝wellfort-site、処理/API/鍵＝Scan-Chat-AI**。

## 8. 実装状況（サマリ）

- **実装済**: EC決済→発送指示CSV・`cron-shipping`（日次）・キット発送（パイロット）・各社スキャン/CSV写像/Elith 書き出しの各要素・LAiFスキャン→JSON・血液CSV↔JSON構造照合。⑥PDF表示のサンプル実装テスト済。
  - **【追加 2026-09-01】遺伝子（Genoplan）のレポート取得**＝`src/lib/genoplan.ts` ＋
    `POST /api/admin/genoplan-fetch`（差分取得・1 リクエスト 1 件）。**実証で発行済み 72 件を全件取得（失敗 0・計 約1.43GB）**。
    報告書＝`docs/lab/genoplan_poc_report_20260901.pdf`（`.html` が原稿・`node scripts/build-html-pdf.mjs <html>` で生成）。
- **未実装（主眼）**: (a) プラン→キット展開の**定期出荷スケジュール**化、(b) ライフサイクル状態機械＋AI問診促しの結線、(c) 進捗駆動の各社受渡・受領・Elith作成指示の**オーケストレーション**、(d) ⑤受領チェック（週次）ジョブ、(e) ⑥Elith下り受取仕様の確定と本番表示結線。
  - **(f) 【2026-09-01 追加・遺伝子で顕在化】キット個体ID → 顧客の紐付け**（③-1）。
    `customer.lab_tests` に**行を作るコードが無い**（現状は読み取りのみ＝`src/lib/chat-context.ts:79-80` の
    SELECT 1 か所だけ。INSERT/UPDATE/UPSERT は両リポジトリに **0 件**・実測 grep）。
    併せて `kit_shipments` への個体ID列追加が要る。
    - **【v2.1 訂正】「Scan-Chat-AI は `customer` スキーマを読み取り専用でしか触れない
      （`HP_BRIDGE_READONLY_KEY`）ので書き込みは wellfort-site 側」は誤り。**
      `HP_BRIDGE_READONLY_KEY` は **wellfort-site 側プロジェクトの `app_bridge` 用**（`src/lib/supabase.ts:41-46`）で、
      `customer` は Scan-Chat-AI 自身のプロジェクトに在り **service_role で実際に書いている箇所がある**
      （`src/lib/supabase.ts:31-38`／`src/pages/api/kit/[id]/self-report.ts:117-123` が
      `.schema('customer').from('kit_shipments').update(...)`）。
      **書けないという制約は無い。** ただし本番ではキット／注文の正本が wellfort-site の `orders` に在るため、
      **`lab_tests` の行をどちらで作るかは未決の設計判断**（→ §4-5.12 の 3）。
    **Wellfort 提出用の提案書＝`docs/subscription/kit_id_linkage_proposal_20260902.pdf`**
    （`.html` が原稿）。遺伝子・血液をまとめて、①返送CSVへの列追加 ②アプリ受取確認での撮影 の
    2 案と確認事項 5 件。**血液は「キットに番号が印字されているか」自体が未確認**（推測で断定しない）。
    → **これが埋まるまで、取得した遺伝子レポートは「誰のものか未確定」のまま保管される**（割当はしない＝捏造ゼロ）。
  - **(h) 【単品検査商品】購入商品 → フロー分岐が未実装**（§0-2）。マイページの
    「検査結果データのアップロード」導線（①②）、「データUP ＋ 問診が揃った」判定、
    **書き出し経路のフラグ分岐**（①③＝Elith納品なし／②＝あり）、レポート格納・表示の共通基盤
    （①LAiF／②ElithPDF／③Genoplan）。**Wonderlust版の停止に伴う旧レポート導線の撤去**も含む。→ (d)§6。
  - **(g) 原本ストレージの本番設定**: `AWS_S3_ORIGINALS_BUCKET` が未設定のため、既定の保存先が
    Supabase Storage にフォールバックする。**本番は S3 `ap-northeast-1`＋Object Lock**（案C′）。
    手順＝`docs/operations/S3原本ストレージ_構築手順書.md`。実証テストは受渡用バケットへ保存した（削除可能）。

## 9. 確認事項（本書で束ねる横断項目）

1. **⑤ 受領チェック頻度**: 「仮：週次」の妥当性（各社の結果提供SLAに合わせる／リアルタイム化の要否）。
2. **⑥ Elith 下り受取仕様（最重要・未確定）**: PDFの命名規則・出力トリガ／通知・世代（版）管理・`diagnostic_user_id`/検査日でのひも付け・受領確認運用。バケットは設定済・PDF・表示はサンプルでテスト済。
3. **がんリスク（プリベント）**: 専用ポータル＋S3方式の合意可否（提案中）。固定IP有無・担当者/通知先・生年月日提供の同意前提。→ (a)§7。
4. **キット構成データ**: 案A（正規化＋版管理）の DDL 実装・初期データ投入・`subscriptions.plan_composition_id` pin の結線。→ (c)§6.1。
5. **AI疾病予測/予防**: 物理キット外。AI疾病予測=年1回データ受領、AI疾病予防=開発中の回数/仕様（管理対象化の時期）。→ (c)§8。
6. **【2026-09-01 追加 / v2.1 更新】キット個体ID の捕捉**（③-1）: タカセの**返送 CSV に 1 列足す**合意（タカセ側の運用調整）。
   **受取確認時のスマホ撮影は「採るかの判断」ではなく、プリベントについては採用済（P0）**。→ **§4-5.7**。
   **4検査横断の確認事項は §4-5.12 に集約した**（本節では再掲しない）。とくに未決の最重要は
   **`lab_tests` の行を誰がいつ作るか**（§4-5.12 の 3）で、これが P0 すべての先行条件。
7. **【2026-09-01 追加】遺伝子の原本保存**: レポート PDF の 2 ページ目に**氏名が印字**されている。
   氏名入りのまま原本として保存してよいか（AI診断へ渡す JSON には載せない）。→ (a)§4.2(c)。
8. **【2026-09-01 追加】Genoplan アカウントの扱い**: `info@wellfort.co.jp` を自動処理と人の操作で共用してよいか。
   分けるなら自動処理専用アカウントの発行を先方へ依頼。→ (a)§4.2。
9. **【2026-09-01 追加・先方へ連絡】Genoplan のレポート PDF 配布 URL が無認証**。認証キーだけで
   署名付き URL が発行される（実在しないキーで確認・他人のデータには触れていない）。→ (a)§4.3。
10. **【単品】残る要確認は (d)§5 に集約**（本書では再掲しない）。とくに未解決なのは
    **①の「CSV→Excel」の実体と「自動送信」の経路**（S3＋ポータル＋通知か、メール添付か）、
    **②のOCR＝既存 AIスキャン流用でよいか**、**②の Elith 納品セットにウェルネス年齢を同梱するか**、
    **Wonderlust版の停止時期と旧レポートの扱い**、**単品購入者の `diagnostic_user_id` 採番・導線**。
    ※ (d)§5-6「③のRPA」は **2026-09-01 に解決**（RPA 不要・サーバ側 API 取得）。

---

### 付記：本書と各論の関係（更新ルール）
- **流れ・責務分界・連結点・E2E確認事項＝本書**を更新。
- **各社受取方式の詳細＝(a)**／**問診→CSV 写像の詳細＝(b)**／**キット出荷・進捗・受渡・データモデル（DDL）＝(c)**。詳細変更は各 spec を先に更新し、本書は要約・参照のみ（**二重管理しない**）。
</content>
</invoke>
