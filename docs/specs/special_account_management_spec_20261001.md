# スペシャルアカウント管理機能 改訂仕様書

**版**: 1.0 (2026-10-01)
**状態**: **仕様のみ。実装していない。** `src` / `supabase` / `scripts` は 1 行も変更していない。
**対象**: `mirai-gpro/Scan-Chat-AI`（処理 API・判定ロジック）/ `mirai-gpro/wellfort-site`（管理 UI）

| | |
|---|---|
| 文書 ID | `special_account_management_spec_20261001` |
| 正本の範囲 | **スペシャルアカウントの「管理画面と Elith 納品の起動」に限り本書を優先**（§28） |
| 作業ブランチ | `claude/cool-dirac-1dkyx7`（両リポジトリ）。**Production へ merge しない** |
| 調査基準 | Scan-Chat-AI `claude/cool-dirac-1dkyx7` / **`f7bb8a9`**<br>wellfort-site `claude/cool-dirac-1dkyx7` / **`1629580`** |
| 発注者指示書 | 2026-10-01「スペシャルアカウント管理機能 改訂仕様書の作成」（26 節） |

**§1〜§27 は発注者指示書 §23「仕様書で必ず出すもの」の 27 項目と 1 対 1 で対応する。**

---

## 0. この文書の読み方

### 0.0 本書は発注者指示書を実コードで裏取りしたもの

骨格は発注者指示書そのまま。**設計を増やしていない。**
こちらが足したのは次の 3 種だけで、いずれも**既存コードを読めば分かること**であって推測ではない。

1. **`file:line` の根拠**（CLAUDE.md R1「断言には出典を付ける」）。
2. **指示書の前提と実コードが食い違う点の訂正**（§0.2。いずれも**指示の意図は変えていない**）。
3. **実装前に潰す必要がある落とし穴**（§0.3）。

> **本書を読まずに実装を始めてはならない。** `file:line` は「読むべき場所」の索引でもある。

### 0.1 「現行実装」「旧仕様」「新仕様」を混ぜない（指示書 §0）

| 表記 | 意味 |
|---|---|
| **現行実装** | `f7bb8a9` / `1629580` で**実際に動いている**もの。必ず `file:line` を付ける |
| **旧仕様** | 既存の仕様書に書かれているが、今回**置き換わる**もの。出典の文書名と § を付ける |
| **新仕様** | 本書で**今回確定する**もの。実装はまだ無い |

### 0.2 指示書の記述に対する訂正（5 件・意図は変えていない）

| # | 指示書の記述 | 実コード | 本書での扱い |
|---|---|---|---|
| **C-1** | §3「**AI問診＋検診データが揃ったら自動納品**という従来の固定条件」 | 正しい。`elith-delivery.ts:467` の `SINGLE_FORMATS = ['LifestyleQuestionnaireData','HealthCheckupData']` が**スペシャル/単品の固定 2 条件**で、`:469` で全 `singleUids` に適用される | 指示どおり。**§9 / §17 で廃止** |
| **C-2** | §6/§8「既存 **opaque context / server session / short-lived handoff** を再利用」 | **再利用できる既存機構が無い。** 既存の short-lived handoff（`admin-impersonation.ts:106` `createHandoff`）が発行するのは **Scan-Chat-AI の `/admin-view/<ctx>/…` 代理表示 context**（同 `:42` `ADMIN_VIEW_PREFIX`・`middleware.ts:220-262`）で、**wellfort-site の admin 画面に対象をセットする用途には使えない**。`share-access.ts` の pending / session も**外部閲覧者**用 | **§19.2 で 3 案を提示し 1 案を推奨 + 要裁定（U-2）**。「既存を流用」と書いて実体の無い機構を指さない（R2） |
| **C-3** | §4/§15 一覧に**氏名・会社名**を出す案（§16 の検索条件にも氏名/会社名） | スペシャルアカウントは **EC 購入が無いので `customer.customer_profiles` に行が無い**。`makeSubjectResolver()`（`elith-delivery.ts:82-90`）が `customer_profiles` を引いて空振りし `:103` の `specialSubjectByUid(uid)` にフォールバックしている構造がその証拠。保持しているのは**メールのマスク（`r***@example.com`）とメモ**だけ（`special-accounts.ts:114` / `api/admin/special-accounts.ts:12`） | **氏名・会社名は出せない。**「対象者」は**メモ（案件名）＋マスク＋uid 先頭**で構成（§6.2）。検索も同じ 3 つに限る（§25 U-8） |
| **C-4** | §8「対象 UID がセット済みの共有 URL 設定画面へ遷移」 | `/admin/share-links` の対象選択は**氏名カナで `customer_profiles` を検索する**実装（`share-links.astro:208-226`）。スペシャルアカウントは**この検索に 1 件も出ない** | 導線を足すだけでは足りない。**対象を外から受け取る受け皿が無い**ことを §13.3 に明記 |
| **C-5** | §17「既存『Elith納品を一括作成』は廃止 **または** 役割分離」 | あのボタンが呼ぶ `deliverReadySpecialAccounts()` は**スペシャルと契約者の両方**を母集団にする（`elith-delivery.ts:450-457`）。**スペシャルだけ外す**のが正しく、**ボタン自体を消すと契約者の手動再ラップ手段が消える** | **§18.2 で「役割分離」を採用**（廃止しない） |

### 0.3 実装前に必ず読む「既存の落とし穴」（4 件）

| # | 落とし穴 | 根拠 |
|---|---|---|
| **P-1** | **`deliverReadySpecialAccounts()` は追加検査（血液 / がん / 遺伝子 / AI疾病）を納品しない。** `manualMapping` に入るのは `HealthCheckupData` と `LifestyleQuestionnaireData` の 2 つだけで、`assembleElithDeliverySet` は `manualMapping` 指定時に**そのキーしか picks に入れない** | `elith-delivery.ts:548-556` / `elith-assemble.ts:408-416` |
| **P-2** | **一覧の「Elith納品」列は追加検査の納品を数えない。** `getAccountProgress` は `elith_deliveries`（バンドル単位）だけを見る。追加検査は `elith_delivery_items`（検査単位）に記録される | `account-progress.ts:75-79` / `elith-delivery-json.ts:306-345` |
| **P-3** | **一覧の「スキャン」列は `health_checkup` しか数えない。** 血液 / がん / 遺伝子 / AI疾病は一覧に**一切出ない** | `account-progress.ts:69-74` |
| **P-4** | **`elith-delivery-cleanup` は本番納品先ではなく中間 source を消す。** 対象は `${cfg.prefix}user/`（既定 `scan-accuracy-test/user/`）。docstring が「Elith 納品先」と書いているが**実際は監査層** | `elith-delivery-cleanup.ts:71` / `elith-delivery-json.ts:96-106`（本番は prefix を外した `user/…`） |

---

## 1. 背景・目的

### 1.1 スペシャルアカウントとは（既存の確定事項・変えない）

EC 購入を伴わない招待で、**本人の実データ**を扱う枠。デモ用アカウント（ダミーを見せる枠）とは
目的が逆で、混ぜると本人の画面に他人名義のダミーが出る。
正本は `docs/operations/スペシャルアカウント_仕様書.md`。

- 判定は **`isSpecialAccount(uid)` 1 本**（`special-accounts.ts:48-51`）。admin かどうかは見ない。
- 一覧は **組み込み ∪ env `SPECIAL_ALLOWED_UIDS` ∪ app_config `special.account_uids` − `special.account_denied_uids`**（同 `:65-73`。**除外は和のあと**）。
- **全停止スイッチを持たない**（止めるとその人がログインできなくなる）。
- 登録は**メールアドレス**、判定は **uid**。現物のメールは保存せず sha256 / マスク / uid / メモ の 4 つだけ（`api/admin/special-accounts.ts:12`）。
- 生年月日・性別は専用キー **`special.account_dob`** に隔離し**ブラインド表示**（同 `:79-93` の `present()`）。
- ダッシュボードは**単品購入の形**（`dashboard.astro:137`）。

### 1.2 本書の目的

スペシャルアカウントは実質「**AI疾病予防報告書 単品プランをベースにした特別運用枠**」である。
基本構成（AI問診 + 検診／人間ドック）は本人がアプリから登録できるが、**案件ごとに必要な検査構成が違う**。

- AI問診 / 検診・人間ドック / 血液 / 遺伝子 / がんリスク / AI疾病発症予測 を**組み合わせて**
  Elith の AI疾病予防報告書へ反映する。
- **「何が必須か」をシステムが固定的に決めない。** Wellfort 担当者が「この案件に必要なデータが
  揃った」と判断した時点で Elith 納品を実行する。

本書が確定するのはこの 3 点である。

1. **Elith 本番納品の起動を、人の判断（ボタン）に移す**（§9）。
2. **一覧画面を「今この人に何が入っているか」が分かる形に整える**（§6 / §8）。
3. **追加検査登録・共有 URL 設定への導線を一覧から張る**（§7 / §12 / §13）。

---

## 2. 現行仕様（旧仕様・今回置き換わるもの）

| # | 旧仕様 | 出典 | 置き換え |
|---|---|---|---|
| **O-1** | Elith 自動納品の発火 = **毎日 23:00 JST の cron**。対象は「条件を機械判定できる単品/スペシャルアカウント（問診済 ∧ スキャン済）」 | `docs/subscription/kit_lifecycle_and_handoff_management_spec.md §4.3.1` / CLAUDE.md「§4.3.1 A」 | **スペシャルだけ cron から外す**（§9 / §17）。契約者/単品は従来どおり |
| **O-2** | 揃い判定 = プランごとの `required_formats` の総当たり。単品/スペシャルは「問診 ∧ 人間ドック」 | 同上 §4.3.1 | **スペシャルは「Elith へ渡せるデータが 1 種類以上」に緩める**（§9.2 / §10） |
| **O-3** | 追加検査は「**登録 → その場で Elith 本番納品**」（STEP 2 ［② 登録・Elith 納品］） | `docs/specs/special_account_additional_tests_spec_20260930.md §9 / §24 / §28` | **登録だけにする**（§12）。納品は一覧の［Elith納品］のみ |
| **O-4** | 追加検査の対象は **4 種**（血液 / がんリスク / 遺伝子 / AI疾病発症予測）。検診・人間ドックは「本人がアプリでスキャンするので含めない」 | 同上 §4 / `additional-originals.ts:41` | **検診・人間ドックの Admin 登録を足す**（§11） |
| **O-5** | 一覧の操作は **Delete 1 つ**。納品は**一括ボタン 1 つ** | `special-accounts.astro:303` / `:61` | **行ごとに 3 ボタン**（§6 / §7）。一括は役割分離（§18.2） |

**置き換えないもの**（§18 で改めて列挙）: secure share の全仕様 / Admin 代理表示 / lab-results /
Elith intake / ウェルネス年齢 / 複数年 / 既存 S3 パス規約 / 通常ユーザーの購入・診断フロー。

---

## 3. 現行実装（実コードで確認した事実）

### 3.1 一覧画面（wellfort-site `src/pages/admin/special-accounts.astro`）

| 事実 | file:line |
|---|---|
| メール登録テーブルの列は **Google アカウント / メモ / 生年月日・性別 / Elith USER ID / 問診 / スキャン / Elith納品 / 利用中 / （Delete）** の 9 列 | `:274-282` |
| 行の操作は **Delete だけ**（除外中の行は「戻す」） | `:303` / `:359-365` |
| **［Elith納品を一括作成］が 1 つ**だけ上部にある。confirm を 1 枚挟んで `POST /api/admin/special-accounts/deliver` へ | `:61` / `:477-490` |
| 「問診 / スキャン / Elith納品」は `status[uid]` を `✅ + 日付` か「未」で描くだけ。**検査種別を増やせない形**（`progressOne(uid, status, key)` の `key` が 3 つに固定） | `:255-265` / `:295-297` |
| 追加検査への導線は**本文中のテキストリンク 1 本**。対象は渡さない | `:54` |
| uid 直接追加は `<details>` の中（第 2 テーブル） | `:68-85` / `:314-350` |
| 未納品の理由を集計して見せる（「0 件」を不透明にしない） | `:497-510` |

### 3.2 一覧データの供給（Scan-Chat-AI）

`src/pages/api/admin/special-accounts.ts` → `src/lib/account-progress.ts`

| 事実 | file:line |
|---|---|
| GET は `listSpecialAccounts()` の snapshot に `getAccountProgress(uids)` を添えて返す | `api/admin/special-accounts.ts:105-111` |
| 生年月日は `present()` が `dobRaw` を落としマスクだけ添える（ブラインド） | 同 `:74-93` |
| `interview` = `diagnosis.interview_completions` の有無 + 件数 + 最新 `completed_at` | `account-progress.ts:68` |
| `scan` = `test_artifacts` の **`test_type='health_checkup'` かつ `status='active'`** のみ | `account-progress.ts:69-74` |
| `delivered` = `diagnosis.elith_deliveries` の `status='delivered'` のみ | `account-progress.ts:75-79` |
| **血液 / がん / 遺伝子 / AI疾病の件数は取っていない**（P-3） | 同上（他の `test_type` を引く箇所が無い） |
| **`elith_delivery_items` を見ていない**（P-2） | 同上 |
| 失敗しても空（未完了）で返す fail-safe。**PII は載せない**（件数と日時だけ） | `account-progress.ts:10-12` / `:106-108` |

### 3.3 Elith 納品の実体（Scan-Chat-AI `src/lib/elith-delivery.ts`）

| 事実 | file:line |
|---|---|
| 母集団 = **スペシャル（rows ∪ emails の uid）∪ 契約者（`app_bridge.subscription` の `status='active'`）** | `:450-457` |
| 揃い判定 = `checkFormatsReady()`。スペシャル/単品は `SINGLE_FORMATS`（問診 ∧ 人間ドック）固定 | `:467-469` / `:476-477` |
| 揃わない uid は `skipped` + 理由を必ず載せる（黙って落とさない） | `:479-491` |
| `HealthCheckupData` は `test_artifacts.scan_md` から **年ごと（最大 20 行取得・仕様上限 5 年）** に生成して**中間 source** へ置く | `:159-242`（`:175` の `limit(20)` / `:221` のキー） |
| 同一 `dateFolder` は 1 つに畳む | `:183` / `:197-198` |
| ウェルネス年齢も**年ごと**に算出し `healthAgeByRef[hcKey]` へ。**算出不能な年は載せない**（捏造ゼロ） | `:508-533` / `:266-271` |
| `manualMapping[uid]` に入るのは **`HealthCheckupData`（代表＝最新年）と `LifestyleQuestionnaireData` の 2 つだけ** | `:548-556` |
| 納品は `assembleElithDeliverySet()` → `putFiles()` | `:562-573` |
| 納品記録は **年（date フォルダ）ごとに `elith_deliveries` へ upsert** | `:578-598` / `:393-422` |
| `skipDelivered:true` のときだけ既納品の回を飛ばす。**admin ボタンは未指定＝毎回ラップし直す** | `:429-437` / `:503-520` |
| 被験者解決 `makeSubjectResolver()` = 顧客DB生年月日 → **スペシャル登録 DOB**（`specialSubjectByUid`） | `:72-117` |

`src/lib/elith-assemble.ts`

| 事実 | file:line |
|---|---|
| 納品 format は 6 種（`GATING_FORMAT_IDS` 5 種 + `Other`） | `:29-37` |
| **時系列 format** = `BloodTestData` / `CancerRiskAssessmentData` / `HealthCheckupData` / `Other`。この 4 つは client 単位で**全 date フォルダを丸ごと納品**する | `:401` / `:492-500` |
| `manualMapping` 指定時は **`m[f]` があるキーだけ** picks に入る（指定の無い format は納品されない） | `:408-416` |
| 納品 JSON は `rewriteClientId()` → `sanitizeDelivery()` を通す | `:492-513` / `:322` / `:361` |

`src/lib/elith-entitlement.ts`

| 事実 | file:line |
|---|---|
| format → 揃い判定の引き先（`testType` / `interview` / `nonBlocking`）。**`HealthAgeData` は非ブロッカー** | `:49-57` |
| 判定本体 `decideReady()` は純粋関数。**`required` が null / 空なら ready=false（fail-closed）** | `:227-240` |
| 契約者は `app_bridge.subscription` の `status='active'` だけ（pending を権利と読まない） | `:109-120` |

### 3.4 cron（Scan-Chat-AI）

| 事実 | file:line |
|---|---|
| `GET /api/cron/elith-deliver` が `deliverReadySpecialAccounts({ deliveryPrefix:'', sourcePrefix: cfg.prefix, skipDelivered:true })` を呼ぶ | `api/cron/elith-deliver.ts:56-61` |
| スケジュールは `0 14 * * *`（14:00 UTC = **23:00 JST**） | `vercel.json:16-18` |
| 認可は `CRON_SECRET` **または `ADMIN_API_KEY`**（手で叩ける） | `api/cron/elith-deliver.ts:40-47` |
| `maxDuration: 800` | 同 `:26` |

### 3.5 追加検査（Scan-Chat-AI・2026-09-30 実装済み）

| 事実 | file:line |
|---|---|
| 対象は **4 種**（`blood` / `cancer_urine` / `genetics` / `ai_prediction`）。検診・人間ドックは入っていない | `additional-originals.ts:41` |
| 対象者は**スペシャルアカウントだけ**（`isSpecialAccount`）。admin は資格にならない | `special-additional-tests.ts:109-121` |
| `scan-part` は**何も保存しない**（解析だけ）。解析関数は既存の `scanImageToParsed` / `scanGeneticPage` / `scanAiPredictionPage` を共用 | `scan-part.ts:9-14` / `:80-110` |
| `finalize` の順序 = 解析 → データ有 → **原本 S3 存在確認** → artifact → measurement → 原本紐付け → source JSON → **納品** | `finalize.ts:12-16` |
| **既定で Elith 本番へ納品する。`deliver:false` を送ったときだけ止まる** | 同 `:263-266` / `:268-270` |
| artifact は `uid + test_type + test_date + status='active'` で引き、**`source` を条件に入れない**。0 件=新規 / 1 件=その行へ / 2 件以上=`artifact_ambiguous` で停止 | `special-additional-tests.ts:144-174` / `:194-235` |
| 1 件のときは `persistIntoExistingArtifact()` で **`scan_md` と測定値だけ**更新（`source` / `test_date` / `status` / 原本は触らない） | 同 `:181-188` / `:211-223` |
| 受診日は**渡す前に弾く**（下の 2 関数は today へ落とす） | 同 `:202-205` / `scan-persist.ts:295` |
| 本番納品は `deliverAdditionalJson()`。**既存 `rewriteClientId()` を共用**し、**PUT 後に読み戻して SHA256 を突合**して初めて `verified` | `elith-delivery-json.ts:211-272`（`:233` / `:261-271`） |
| **既に同じ内容が在れば PUT し直さない** | 同 `:240-248` |
| 納品先キーは **source キーから prefix を外すだけ**（組み替えない）。`.json` 以外は置かない | 同 `:96-106` |
| 納品記録は **`elith_delivery_items`**（検査単位）。`elith_deliveries`（バンドル単位）には書かない | 同 `:295-351` / `20260930000060_elith_delivery_items.sql:4-10` |
| 一意キー `(test_artifact_id, format_id, destination_key)` で upsert（再実行で行が増えず `attempt_count` だけ進む） | `20260930000060:49-51` |
| 原本キーに**氏名も元ファイル名も入れない**（`additional_results/{uid}/{test_type}/{YYYY_MM_DD}/{sha256}.pdf`） | `additional-originals.ts:5-15` |

### 3.6 追加検査の UI（wellfort-site `src/pages/admin/special-additional-tests.astro`）

| 事実 | file:line |
|---|---|
| 対象者は `<select id="at-uid">`。候補は `/api/admin/special-accounts` の GET から **uid が確定している人だけ** | `:65` / `:215-239` |
| **URL から対象を受け取る口が無い**（`searchParams` を読む箇所が 0） | 同ファイル全体 |
| 検査種別は **4 択**（検診・人間ドックは無い） | `:70-75` |
| `finalize` を **`deliver` 指定なしで**呼ぶ ＝ **その場で本番納品される** | `:392-395` |
| 画面文言は「登録して Elith へ納品しています…」 | `:391` |
| 結果表示に「Elith 本番納品 ✅ 納品して読み戻し検証まで一致」が出る | `:439-447` |

### 3.7 共有リンク（既存・変更しない）

| 事実 | file:line |
|---|---|
| 発行は `POST /api/admin/share-links` の `create` → `createShareLink()` | `api/admin/share-links.ts:90-118` / `share-access.ts:257-310` |
| **raw token は DB に入らない**（`token_hash` だけ）。返るのは発行の瞬間だけ | `share-access.ts:252-253` / `:298` |
| 三段構え **share link → pending（Cookie・10 分）→ share session（Cookie）** | 同 `:11-13` |
| `target_uid` は **Cookie にも URL にも入れない。毎回 DB で解決** | 同 `:17` |
| 毎リクエストで link 側の status / starts_at / expires_at を見る（**セッションだけ見ると revoke が効かない**） | 同 `:18-19` |
| `SHARE_ENABLED=off` で外部共有だけを止める kill switch | 同 `:39-53` |
| `created_by` に**生 email を入れない**（`@` を含む値は捨てる） | 同 `:283-292` |
| **対象の実在確認**は `diagnosis.app_users` に行があるか | 同 `:276-278` |
| **admin 画面の対象選択は氏名カナで `customer_profiles` を検索**。スペシャルアカウントは出ない（C-4） | wellfort-site `admin/share-links.astro:208-226` |
| 画面は「uid は admin 画面なので出してよい（共有相手の画面には絶対に出さない）」としている | 同 `:231-232` |

### 3.8 Admin 代理表示の handoff（既存・参照のみ）

| 事実 | file:line |
|---|---|
| `handoff（raw token・60 秒・single-use）→ pending（Cookie・10 分）→ context（URL path・60 分）` | `admin-impersonation.ts:9-12` / `:25-29` |
| **raw token / raw context / 生 email を DB に保存しない** | 同 `:15` |
| **GET では状態を変えない**（claim は `POST /api/admin/handoff/claim` だけ） | 同 `:16` |
| context が指すのは **Scan-Chat-AI の `/admin-view/<ctx>/…`** | 同 `:42` / `middleware.ts:220-262` |
| wellfort-site の中継は `POST /api/admin/impersonation-handoff`。**admin_email はブラウザから受け取らず Supabase 検証値だけ送る** | wellfort-site `api/admin/impersonation-handoff.ts:59-79` |

→ **この機構は「Scan-Chat-AI の画面を対象者として開く」ためのもの**で、
**wellfort-site の admin 画面に対象をセットする用途には使えない**（C-2）。

### 3.9 中間 source と本番納品先（混同しない）

| 層 | キー | 書く所 | file:line |
|---|---|---|---|
| **A. 中間 source（監査層）** | `{AWS_S3_PREFIX}user/{uid}/date/{YYYY_MM_DD}/{format_id}_…json`（既定 prefix = `scan-accuracy-test/`） | 問診 export / scan export / 追加検査 finalize / deliver の HC materialize | `s3.ts:64-75` / `interview/export.ts:5-6,180` / `elith-delivery-json.ts:79-90` / `elith-delivery.ts:221` |
| **B. Elith 本番受取位置** | `user/{uid}/date/{YYYY_MM_DD}/…json`（**バケット直下** = `deliveryPrefix:''`） | `assembleElithDeliverySet` / `deliverAdditionalJson` | `api/admin/special-accounts/deliver.ts:11-13,48` / `elith-delivery-json.ts:96-106` |

**同一バケット（`AWS_S3_BUCKET`・既定 `wellfort-ai-input`）で prefix だけが違う。**
だから「prefix を外すだけ」で納品できる（`elith-delivery-json.ts:93`）。
**P-4 のとおり `elith-delivery-cleanup` は A を消す口である**（本番納品先ではない）。

### 3.10 本人スキャンと Admin 登録の重複（§11 の前提）

| 事実 | file:line |
|---|---|
| 本人アプリスキャンは `source='user_upload'` | `scan-persist.ts:196-197` |
| 同日回の片付けは **`source='user_upload'` だけ**（admin が入れた回を消さない） | 同 `:178-189` |
| admin バッチは `source='admin_batch'`、片付けも `source='admin_batch'` だけ | 同 `:305-310` / `:318` |
| `test_artifacts` の UNIQUE は `(uid, source, test_type, test_date, external_test_id)` で **`source` を含み**、`external_test_id` が NULL のとき効かない | `20260601000010_schemas_and_tables.sql:208`（`special-additional-tests.ts:14-18` が引用） |
| → **DB は重複を止めない。** 同じ `uid + test_type + test_date` で `user_upload` と `admin_batch` の 2 行が `active` になり得る | 上記 3 つの組み合わせ |
| 追加検査の `resolveAdditionalArtifact` は **`source` を条件に入れない**ので、この状況を `ambiguous` として**止める** | `special-additional-tests.ts:153-173` |
| スペシャルは受診日を読めない回を**保存せず 422 で差し戻す**（`requireReadableDate`） | `api/scan/save.ts:86-103` / `scan-persist.ts:164-165` |

---

## 4. 今回の変更理由

| # | 理由 | 根拠 |
|---|---|---|
| **R-1** | **固定 2 条件（問診 ∧ 人間ドック）が案件に合わない。** スペシャルは案件ごとに検査構成が違い、AI問診が無い案件もある。固定条件のままだと**揃っているのに永久に出ない**か、**人の確認前に出てしまう**かのどちらかになる | `elith-delivery.ts:467-469` / 指示書 §1・§2 |
| **R-2** | **追加検査を入れても Elith へ出ない。** 現行 deliver は 2 format しか `manualMapping` に入れない（P-1）。血液 4 年分を登録しても cron では納品されない | `elith-delivery.ts:548-556` / `elith-assemble.ts:408-416` |
| **R-3** | **登録とその場納品が一体なので、人が最終確認する余地が無い。** 追加検査 1 件を登録した瞬間に本番へ出る | `finalize.ts:263-270` |
| **R-4** | **一覧から案件の状態が判断できない。** 出るのは 3 列だけで、血液・遺伝子・がん・AI疾病は 1 件も見えない（P-2 / P-3） | `account-progress.ts:69-79` |
| **R-5** | **対象者を毎回探し直す操作が要る。** 追加検査画面は `<select>` から選び直し、共有リンク画面は**氏名カナ検索でそもそも見つからない**（C-4） | `special-additional-tests.astro:65` / `share-links.astro:208-226` |

---

## 5. 新しい業務フロー

```
［登録フェーズ］何度でも・順不同・Dashboard には即反映
  ① /admin/special-accounts でメール登録（+ 生年月日・性別）
  ② 本人がサインイン → uid 確定（linkSpecialEmail）
  ③ 本人がアプリで 検診／人間ドック をスキャン（複数年可・最大 5 年）
  ③' または Wellfort が /admin/special-additional-tests から 検診／人間ドック を登録   ← 新規(§11)
  ④ 本人が AI問診 を実施（任意。なしでも正常）                                      ← §10
  ⑤ Wellfort が /admin/special-additional-tests から 血液 / 遺伝子 / がん / AI疾病 を登録
       → test_artifacts + measurement_values + 原本 + 中間 source JSON まで
       → **Elith 本番へは出さない**                                                ← 変更(§12)

［納品フェーズ］人の判断でだけ起きる
  ⑥ /admin/special-accounts の行で「今この人に何が入っているか」を見る              ← 新規(§6/§8)
  ⑦ ［Elith納品］→ 確認モーダル（内容・前回納品・前回差分）                        ← 新規(§7.3/§14)
  ⑧ ［この内容でElith納品］→ 本番 user/ へ書き出し → 読み戻し検証 → 履歴記録        ← §9
  ⑨ Elith が当日深夜 0 時のバッチで再診断（外部・§25.2）
  ⑩ 後日データが増えたら ⑤ → ⑦ を繰り返す（再納品・§15）
```

**cron（23:00 JST）はこのフローに一切登場しない。** 契約者/単品の自動納品のためにそのまま残る（§17）。

---

## 6. Admin 一覧 UI（指示書 §4 / §15 / §24）

### 6.1 基本方針

- **1 アカウント = 1 行。**
- 検査種別ごとに **アイコン + 件数 + 最新検査日**。
- **状態 badge / 最終更新 / 前回納品 / メモ / 右端に 3 ボタン。**
- モバイルはカード形式へ落としてよい。
- **Astro 既存構成を維持する。** 過剰な SPA 化・大規模フレームワーク変更をしない（指示書 §15）。
- Welltect 既存デザイン（明るい背景・teal 系・過剰な shadow なし）。
  現行 `special-accounts.astro:108` の `#0f766e` を踏襲する。
- **色だけで状態を表さない**（アイコン + テキスト + 色の 3 点セット。CLAUDE.md の UI 規律）。

### 6.2 列（新仕様）

| 列 | 中身 | 供給元 |
|---|---|---|
| 対象者 | **メモ（案件名）**＋`r***@example.com`（マスク）＋uid 先頭 8 桁 | `emails[].label` / `.masked` / `.uid`（`api/admin/special-accounts.ts:81-89`） |
| 状態 | badge（§8.1） | 下の件数から導出 |
| AI問診 | 「完了 2026/09/08」/「なし」 | `status[uid].interview`（`account-progress.ts:68`） |
| 検診・人間ドック | 「5件 / 最新 2026/09/08」 | `test_artifacts` `test_type='health_checkup'` |
| 血液 | 同形 | `test_type='blood'` ← **新規に集計が要る**（P-3） |
| 遺伝子 | 同形 | `test_type='genetics'` ← 同 |
| がんリスク | 同形 | `test_type='cancer_urine'` ← 同 |
| AI疾病予測 | 同形 | `test_type='ai_prediction'` ← 同 |
| 最終更新 | 上記 6 種の**最新 `test_date` / `completed_at` の最大** | 同上 |
| 前回納品 | `elith_deliveries.delivered_at` ∪ `elith_delivery_items.delivered_at` の最大 ← **新規**（P-2） | `account-progress.ts:75-79` を拡張 |
| メモ | `emails[].label` | 同上 |
| 操作 | ［追加検査データ］［共有URL設定］［Elith納品］ | §7 |

**氏名・会社名は出さない**（C-3）。**生年月日は現行どおりマスク**（`api/admin/special-accounts.ts:79-93`）。

### 6.3 行の詳細展開（指示書 §15）

行クリックで `<details>` を開き、**データ概要 / 基本情報 / 納品履歴 / メモ** を出す。

- データ概要 = §6.2 の 6 種の件数と最新日（**同じ数字を使う。別計算にしない**）。
- 納品履歴 = `elith_deliveries`（年ごと）と `elith_delivery_items`（検査ごと）を**別の表で**出す。
  役割が違うので 1 つにまとめない（§16.1）。
- 既存の `<details class="sa-adv">`（`special-accounts.astro:68`）と同じ流儀。

### 6.4 一覧データの供給（Scan-Chat-AI 側の変更）

`getAccountProgress()` を拡張する（`account-progress.ts`）。

- `test_artifacts` の問い合わせを **`test_type='health_checkup'` 固定から 5 種の `in()`** へ（`:69-74`）。
- `elith_delivery_items` を**第 4 の問い合わせ**として足す（`:75-79` の隣）。
- 返り値は `interview` / `byTestType: Record<ArtifactTestType, CompletionStat>` / `delivered` に拡張。
  **既存キーは消さない**（UI の切り替え中も壊れないように）。
- **fail-safe を崩さない**（`:106-108`）。失敗時は空（未完了）で返し、**存在しない完了を「済み」と偽らない**。
- **PII を admin レスポンスに載せない**（`:10-11`）。件数と日時だけ。測定値・回答本文は読まない。

---

## 7. 各ボタンの動作

### 7.1 ［追加検査データ］（指示書 §6）

- 押すと **対象アカウントがセット済みの `/admin/special-additional-tests`** へ入る。
- 対象者表示は **メモ（案件名）＋マスク＋uid**（C-3 により氏名は出せない）。
- 管理者が再度 uid を探して選ぶ操作をなくす。
- 受け渡し方式は **§19.2（要裁定 U-2）**。
- **サーバ側の関所は必ず通す。** セットされた対象であっても `scan-part` / `original-ticket` /
  `finalize` は毎回 `checkAdditionalTarget()` で `isSpecialAccount(uid)` を再確認する
  （`special-additional-tests.ts:109-121` / `scan-part.ts:64-65` / `finalize.ts:90-92`）。
  **「もう選択済みだから」で省かない。**

### 7.2 ［共有URL設定］（指示書 §8）

→ §13。

### 7.3 ［Elith納品］（指示書 §9）

**押しただけで即納品しない。まず確認モーダルを出す。**

```
────────────────
Elith納品内容の確認

対象：
<メモ（案件名）>
<r***@example.com>
UID: xxxxxxxx-…

今回納品されるデータ
  AI問診               あり / なし
  検診・人間ドック     5件
  血液検査             4件
  遺伝子検査           1件
  がんリスク検査       5件
  AI疾病発症予測       3件
  ウェルネス年齢       5件（算出可能分）

前回納品：
  2026/08/15

前回納品後の追加：
  血液検査       +1件
  がんリスク     +2件

［キャンセル］  ［この内容でElith納品］
────────────────
```

- **「ウェルネス年齢 N件（算出可能分）」**: 算出不能な年は載らない（`elith-delivery.ts:266-271`）。
  **件数を実際の算出結果から出す。**「5件」と書いて 3 件しか出ないことがあってはならない。
  算出不能の理由（`算出不能(不足: 年齢)` 等・同 `:270`）も出せるなら出す。
- **AI問診が無い場合も「なし」と明示**し、§10.1 の警告文を添える。**ブロックしない。**
- 「**本番の Elith 受け取り位置へ書き出します**」ことを明記する
  （現行の一括ボタンの confirm 文と同じ水準・`special-accounts.astro:478`）。
- **深夜 0 時より前に押す**運用である旨を添える（§25.2 の前提）。

### 7.4 ボタンの有効 / 無効

| ボタン | 無効になる条件 |
|---|---|
| ［追加検査データ］ | uid 未確定（サインイン待ち） |
| ［共有URL設定］ | uid 未確定（`createShareLink` が `app_users` の実在を要求・`share-access.ts:276-278`） |
| ［Elith納品］ | uid 未確定、**または** Elith へ渡せるデータが 0 種類（§10.2） |

**無効の理由を必ず画面に出す**（押せない理由が分からない状態を作らない）。

---

## 8. データ状態一覧（指示書 §5）

### 8.1 状態 badge

| badge | 条件 | 意味 |
|---|---|---|
| **未準備** | uid 未確定、または Elith へ渡せるデータが 0 種類 | ［Elith納品］は**押せない** |
| **準備あり** | uid 確定 ∧ Elith へ渡せるデータが **1 種類以上** | ［Elith納品］が**押せる** |
| **納品済み** | 上記 ∧ 納品履歴が 1 件以上ある | **再納品は可**（§15） |

> **「準備あり」を「必須データが全部揃った」の意味にしてはいけない**（指示書 §5）。
> スペシャル案件は案件ごとに必要条件が違うので、**完成判定ではなく運用補助**である。
> 最終判断は Wellfort 担当者。
> **UI 文言にも「案件として揃ったかの判定ではありません」を 1 行添える。**

### 8.2 検査種別ごとの表示

```
血液
4件
最新 2026/09/08
```

- **件数 0 のときは「—」**（「0件」と「取得できなかった」を混同しない）。
- 取得に失敗した回は **空（未完了）** として出る（`account-progress.ts:106-108`）。
  **「済み」と偽らない。**

---

## 9. Elith 手動納品オーケストレーション（指示書 §3 / §11）

### 9.1 確定事項 — 起動は人のボタンだけ

**スペシャルアカウントの Elith 本番納品は、`/admin/special-accounts` の対象行の
［Elith納品］を Wellfort 管理者が押したときだけ行う。**

- **23:00 JST の cron の対象から外す。**
- **cron 自体は削除しない。** 通常購入・通常契約ユーザーの自動納品は従来どおり（§17）。
- 「スペシャルは手動」「通常は従来運用」を**コードの 1 か所で分岐させる**（§9.5）。

**廃止されるもの**

| 廃止 | 現行実装 |
|---|---|
| スペシャルに対する固定 2 条件（問診 ∧ 人間ドック）での自動納品 | `elith-delivery.ts:467-469` |
| cron が `singleUids`（= スペシャル）を母集団に含めること | `elith-delivery.ts:450-455` → `api/cron/elith-deliver.ts:61` |
| 一覧の［Elith納品を一括作成］がスペシャルを対象にすること | `special-accounts.astro:61` / §18.2 |

**壊してはいけないもの**

- `listEntitledSubscribers()` が返す**契約者**の経路（`elith-entitlement.ts:109-148`）。
- `decideReady()` の fail-closed（同 `:232`）。
- `skipDelivered` による冪等（`elith-delivery.ts:503-520`）。
- 納品記録を**年ごと**に `elith_deliveries` へ入れる粒度（同 `:578-598`）。

### 9.2 手動納品が集める対象（7 種）

| format_id | 引き先 | 時系列か | 現行で deliver に載るか |
|---|---|---|---|
| `LifestyleQuestionnaireData` | 中間 source（問診 export が書いた JSON） | 単発 | ○（`elith-delivery.ts:549-554`） |
| `HealthCheckupData` | `test_artifacts.scan_md` から年ごとに materialize | **時系列** | ○（同 `:506-533`） |
| `BloodTestData` | 中間 source（追加検査 finalize が書いた JSON） | **時系列** | **×（P-1）** |
| `CancerRiskAssessmentData` | 同上 | **時系列** | **×（P-1）** |
| `GeneticTestResultData` | 同上 | 単発 | **×（P-1）** |
| `Other`（AI疾病発症予測） | 同上 | **時系列** | **×（P-1）** |
| `HealthAgeData` | `computeWellnessFromMeasurements` が年ごとに算出 | **時系列**（HC と同じ date へ） | ○（同 `:508-533`） |

**新仕様**: 手動納品は **7 種すべてを対象にする。**
具体的には `manualMapping[uid]` に、`inventoryElithSource(sourcePrefix)` でその uid について
実在が確認できた**各 format の代表キー**を入れる
（`elith-delivery.ts:540-546` の `latestByClient()` を 2 format から 6 format へ広げる形）。
**存在しない format は載せない**（空のファイルを作らない）。

### 9.3 複数年を縮退させない（**必須受入条件**）

`assembleElithDeliverySet` の **`SERIES_FORMATS`**
（`BloodTestData` / `CancerRiskAssessmentData` / `HealthCheckupData` / `Other`・`elith-assemble.ts:401`）は
**代表キーを 1 つ渡せば、その client の全 date フォルダを丸ごと納品する**（同 `:492-500`）。

→ **`manualMapping` に代表 1 件を入れるだけで複数年が出る。** 年ごとに `manualMapping` を
作り直す必要はない。**最新 1 件へ縮退させる改造を入れてはいけない。**

> 現行の HC がこの性質に依存している（`elith-delivery.ts:551-553` のコメント
> 「代表(最新年)のみ渡すが、assemble は…全 date フォルダへ展開する」）。

### 9.4 既存を共用する（新しい JSON 形式を作らない）

| 共用するもの | file:line |
|---|---|
| `sanitizeDelivery()` | `elith-assemble.ts:322` |
| `rewriteClientId()` | `elith-assemble.ts:361` |
| measurement sanitizer `sanitizeMeasurementsForDelivery()` | `elith-export.ts`（`finalize.ts:149` が使用） |
| cancer normalization `normalizeCancerRisk()` | `finalize.ts:153` |
| AI prediction consolidation `consolidateAiPredictionItems()` | `finalize.ts:144-146` |
| subject resolver `makeSubjectResolver()` | `elith-delivery.ts:72-117` |
| 時系列納品 `SERIES_FORMATS` | `elith-assemble.ts:401` |
| 読み戻し検証 `deliverAdditionalJson()` | `elith-delivery-json.ts:211-272` |

**追加検査専用・手動納品専用の JSON 整形を作らない**
（`elith-delivery-json.ts:6-10` の既存規律をそのまま守る）。

### 9.5 分岐は 1 か所（`isSpecialAccount`）

| 入口 | 対象 | 判定 |
|---|---|---|
| `GET /api/cron/elith-deliver`（23:00 JST） | **契約者 + 単品（スペシャルを除く）** | 従来の `checkFormatsReady` |
| **（新）1 uid 指定の手動納品** | **スペシャルアカウント 1 件** | §10.2 の 2 条件だけ |

分岐は **`isSpecialAccount(uid)` 1 本**（`special-accounts.ts:48`）。
これは既にアプリ全体でこの枠の唯一の判定として使われている（`dashboard.astro:137` /
`api/scan/save.ts:87` / `cron/scan-worker.ts:150` / `special-additional-tests.ts:113`）。
**件数や「キットが 0 件なら」で判定しない**（CLAUDE.md の確定事項）。

**除外は `elith-delivery.ts` の母集団構築（`:450-457`）で 1 回だけ行う。**
cron 側（`api/cron/elith-deliver.ts:61`）に条件を書くと、
**admin の一括ボタンと cron で母集団がずれる**（§18.2 と二重管理になる）。

### 9.6 どちらの納品器を使うか（**要裁定 U-1**）

手動納品には 2 つの実装が既にあり、**挙動が違う**。

| | A. `assembleElithDeliverySet` 経路 | B. `deliverAdditionalJson` 経路 |
|---|---|---|
| 単位 | uid 丸ごと（全 format・全 date） | **1 ファイル** |
| 読み戻し検証 | **無い**（`putFiles` の成否だけ） | **有る**（SHA256 突合・`elith-delivery-json.ts:261-271`） |
| 履歴 | `elith_deliveries`（年ごと・`format_ids` を upsert で上書き） | `elith_delivery_items`（検査ごと・`attempt_count`） |
| 複数年 | `SERIES_FORMATS` が自動展開 | ファイル単位なので呼び出し側がループする |
| 既存の呼び出し元 | deliver API / cron | 追加検査 finalize |

**推奨 = A を主とし、B の読み戻し検証を A のあとに回す。**
理由: ①複数年の展開を自分で書き直さずに済む（§9.3）②`elith_deliveries` の年ごと記録と
`elith_delivery_items` の検査ごと記録を**両方残せる**（§14）。
ただし A に読み戻しを足すのは**既存 deliver API と cron にも波及する**ので**裁定が要る**（U-1）。

---

## 10. AI問診なしの場合（指示書 §2 / §10）

### 10.1 新仕様

- AI問診は**必須ではない**。「実施済」も「なし」も**正常状態**。
- **Admin から AI問診を代理入力する機能は作らない**（指示書 §2）。
- 確認モーダルには**「AI問診：なし」と明示**する。空欄にして黙らせない。
- **AI問診が無いことを理由に納品をブロックしない。** 警告文は出してよい。

  > 「AI問診データはありません。現在準備済みの検査データのみで納品します。」

### 10.2 ［Elith納品］の最低条件（これだけ）

1. **uid が確定済み**（メール登録だけでサインイン前の行は押せない）。
2. **Elith へ渡せる検査データが 1 種類以上**存在する。

**次のどれも固定必須条件にしない**:
AI問診 / `HealthCheckupData` / 血液 / 遺伝子 / がんリスク / AI疾病予測。

### 10.3 実装上の意味（`decideReady` を壊さない）

`decideReady()` は「`required` が null / 空なら ready=false」という **fail-closed** を持つ
（`elith-entitlement.ts:232`）。これは**契約者の誤納品を防ぐための正しい規律**なので変えない。

→ **スペシャルは `checkFormatsReady` の判定を通さない。** 代わりに
**「納品可能な format が 1 つ以上あるか」という別の述語**を用意する（`hasAnyDeliverable` 仮称）。
`decideReady()` に「空なら OK」の分岐を足すと、**契約者側の fail-closed が黙って消える。**

---

## 11. 検診／人間ドックの Admin 登録（指示書 §14）

### 11.1 新仕様

| 経路 | 現行 | 新仕様 |
|---|---|---|
| A. 本人がアプリから | ○（`api/scan/save.ts` → `saveScanResult` → `source='user_upload'`） | **変えない** |
| B. Wellfort 管理者が Admin から | **×**（追加検査 4 種に `health_checkup` が無い・`additional-originals.ts:41`） | **○（追加）** |

**どちらの経路でも同じユーザーの同じ検査データとして扱う。**

### 11.2 新しい解析を作らない

`scan-part.ts:97` の `scanImageToParsed()` は **`elith-hc-merge` と同じ関数**（同 `:19`）で、
検診・人間ドックの解析そのものである。**`health_checkup` を対象に足せばそのまま使える。**
健診専用 OCR も専用プロンプトも作らない。

### 11.3 重複 artifact 事故を起こさない（**最重要**）

**危険**: `uid + test_type + test_date` が同じでも、`source` が `user_upload` と `admin_batch` で違えば
**DB の UNIQUE は効かない**（`20260601000010:208` が `source` を含む + `external_test_id` が NULL）。
本人がアプリで入れた回に admin が同じ日付で入れると、**`active` が 2 行になる**。

**新仕様（既存機構をそのまま使う）**

1. **`resolveAdditionalArtifact()` を `health_checkup` にも使う。** これは
   **`source` を検索条件に入れない**（`special-additional-tests.ts:153-159`）ので、
   本人の `user_upload` 行を**見つける**。
2. **1 件見つかったら `persistIntoExistingArtifact()` で `scan_md` と測定値だけ更新**する
   （同 `:211-223`）。**`source` / `test_date` / `status` / `display_mode` / 既存の原本は触らない**
   （同 `:185-187`）。→ **source 違いだけで別 artifact を作らない。**
3. **2 件以上なら `artifact_ambiguous` で停止**（同 `:172-173` / `finalize.ts:180-185`）。
   **自動で最新 1 件を選ばない。**
4. **`persistAdminBatchArtifact()` を直接呼ばない。** あれは `source='admin_batch'` の行しか
   片付けないので（`scan-persist.ts:305-310`）、**本人の行の隣に 2 行目を作る。**

### 11.4 受診日は必須（today へ落とさない）

- `saveAdditionalArtifact()` が**渡す前に弾く**（`special-additional-tests.ts:202-205`）。
  `persistAdminBatchArtifact` / `persistIntoExistingArtifact` は不正な日付を `jstToday()` にする
  （`scan-persist.ts:295`）ので、**ここで止めないと複数年が同じ日付へ畳まれる**。
- 本人経路は `requireReadableDate`（スペシャルのみ）で 422 差し戻し（`api/scan/save.ts:86-103`）。
  **Admin 経路も同じ厳しさにそろえる。**

### 11.5 複数年を壊さない

`materializeHealthCheckups()` は `health_checkup` を**全件（最大 20 行取得）**読んで年ごとに
source を書く（`elith-delivery.ts:168-175`）。**同一 `dateFolder` は 1 つに畳まれる**（同 `:183` / `:197-198`）。
→ **Admin 登録で受診日が今日に化けると、その年が別の年を押し出す。** §11.4 が必須の理由。

---

## 12. 追加検査登録画面の役割変更（指示書 §7）

### 12.1 新仕様

| | 旧仕様 / 現行実装 | 新仕様 |
|---|---|---|
| STEP 2 のボタン名 | 「② 登録・Elith 納品」 | **「② 登録」** |
| 既定の挙動 | **Elith 本番へ納品する**（`finalize.ts:263-266`。`deliver:false` のときだけ止まる） | **納品しない** |
| 呼び出し側 | `deliver` を送っていない（`special-additional-tests.astro:392-395`） | 納品しないことを**サーバ側の既定**にする（§12.2） |
| 進捗文言 | 「登録して Elith へ納品しています…」（同 `:391`） | 「登録しています…」 |
| 完了表示 | 「Elith 本番納品 ✅ …」（同 `:439-447`） | 下記 |
| 検査種別 | 4 択（`:70-75`） | **5 択**（検診・人間ドックを追加・§11） |

**新しい完了表示**

```
✅ 検査データを登録しました
✅ ダッシュボードへ反映しました
○ Elith未納品

Elith納品は「スペシャルアカウント」画面から実行してください。
```

### 12.2 既定をどちらに置くか（**要裁定 U-3**）

`finalize.ts:264` は `if (body.deliver === false)` で**明示的に false のときだけ**止まる。
つまり**既定は納品**。

| 案 | 変更 | リスク |
|---|---|---|
| **案 a（推奨）** | **サーバ側の既定を「納品しない」へ反転**し、`deliver:true` を明示したときだけ納品する | 既存の呼び出し元は wellfort-site の 1 か所だけ（`special-additional-tests.astro:392`）なので波及が小さい。**UI 側の送信漏れで誤納品になる事故が構造的に消える** |
| 案 b | サーバは据え置き、UI が `deliver:false` を送る | **UI の 1 行を忘れたら本番へ出る。**「送り忘れ = 誤納品」は危険側のフェイルセーフ |

→ **案 a を推奨。** CLAUDE.md の規律（「綴り違いで黙って全停止しないよう、止める側を明示的な値に
寄せる」）の裏返しとして、**危険な側を明示的な値に寄せる**。**裁定が要る（U-3）。**

### 12.3 Dashboard 反映 ≠ Elith 納品（指示書 §18）

| | いつ起きるか |
|---|---|
| **Dashboard 反映** | 追加検査を登録した時点（`test_artifacts` / `measurement_values` / 原本） |
| **Elith 本番納品** | Wellfort 担当者が［この内容でElith納品］を押した時点 |

この分離は**現行実装が既に持っている**（`finalize.ts:17-20`「Elith 本番の書き込みだけ失敗 →
Dashboard 側の登録は残す」）。**新仕様はこれを常態にするだけ。**

---

## 13. 共有 URL 導線（指示書 §8）

### 13.1 新仕様

- 各行に［共有URL設定］を置く。押すと **対象 uid がセット済みの `/admin/share-links`** へ入る。
- **新しい共有機能を作らない。** 既に実装済みのセキュア共有リンク機能をそのまま使う。
- 今回追加するのは**導線だけ**であり、**共有基盤そのものの再実装ではない。**
- 受け渡し方式は **§19.2（要裁定 U-2）**。

### 13.2 変更しない既存セキュリティ仕様（指示書 §8・そのまま転記）

| 項目 | 現行実装 |
|---|---|
| raw share token を DB 保存しない | `share-access.ts:252-253` / `:298`（`token_hash` だけ） |
| token → pending → consent → opaque session | `share-access.ts:11-13` / `api/share/consent.ts` |
| target は server-side で固定 | `share-access.ts:17`（Cookie にも URL にも入れない・毎回 DB で解決） |
| revoke は不可逆 | `setShareLinkStatus(id,'revoked')`（同 `:423`）+ 毎リクエストで link 側を見る（同 `:18-19`） |
| ShareBanner | `middleware.ts:193` が `locals.share` を置き、各ページが帯を出す |
| access log | `logShareEvent()` / `logShareApiEvent()`（同 `:189` / `:229`） |
| `SHARE_ENABLED` kill switch | 同 `:39-53` |
| share viewer 権限制御 | `write-guard.ts` の `denyUnlessShareScope()`（`api/scan/save.ts:47` 等） |

### 13.3 導線だけでは足りない（C-4・実装前の注意）

`/admin/share-links` の対象選択は**氏名カナで `customer_profiles` を検索する**実装
（`share-links.astro:208-226`）。スペシャルアカウントは `customer_profiles` に行が無いので
**この検索に 1 件も出ない**。

→ **画面側に「外から対象を受け取る経路」が要る**
（§19.2 の案 1 なら一覧側のパネル、案 2 なら `sessionStorage` の読み取り）。

**発行 API 側は変更不要**: `createShareLink()` の実在確認は `diagnosis.app_users` を見るので
（`share-access.ts:276-278`）、**サインイン済みのスペシャルアカウントは通る**。

---

## 14. 前回納品との差分（指示書 §12）

### 14.1 新仕様

**「現在登録済みデータ」「前回 Elith 納品時点」「今回追加されたデータ」を比較できるようにする。**
表示場所は**一覧（前回納品の日付）**と**確認モーダル（前回納品後の追加）**の 2 か所。

```
前回納品 2026/08/15

その後追加：
  血液 1件
  がんリスク 2件
```

### 14.2 どの表をどの粒度で使うか（**既存データを壊す統合をしない**）

| 表 | 粒度 | 役割（変えない） | 根拠 |
|---|---|---|---|
| `diagnosis.elith_deliveries` | **(uid, bundle_date, delivery_prefix)** = 年 × 納品先 | **診断バンドル単位**の納品記録。`format_ids text[]` を upsert で**丸ごと上書き**する | `20260924000010:41` / `elith-delivery.ts:406-418` |
| `diagnosis.elith_delivery_items` | **(test_artifact_id, format_id, destination_key)** = 検査 × format × 納品先 | **個別検査単位**の納品記録。`attempt_count` / `source_sha256` / `destination_sha256` / `last_error` | `20260930000060:49-51` |

**統合しない。** `elith_deliveries` へ追加検査を upsert すると
**既に納品済みの `format_ids` を消す**（`20260930000060:4-7` が明記）。

| 用途 | 使う表 |
|---|---|
| 一覧の「前回納品」 | 両方の `delivered_at` の最大 |
| 確認モーダルの「前回納品後の追加」 | **検査種別ごとの件数差分**（§14.3） |
| 詳細展開の納品履歴 | **2 つの表を別の表として並べる** |
| 冪等 | 各表の既存 unique をそのまま使う |

### 14.3 差分の出し方（**要裁定 U-7**）

**推奨**: 「前回納品日時」以降に `created_at` が付いた `test_artifacts` を**検査種別ごとに数える**。
一覧の件数と同じ数え方なので**数字が食い違わない**。

代替案（date × format 単位で `elith_delivery_items` と突き合わせる）はより正確だが、
**`elith_deliveries` 経由で納品した分は `elith_delivery_items` に行が無い**ため
「納品済みなのに差分に出る」が起きる。**裁定が要る（U-7）。**

---

## 15. 再納品（指示書 §19）

### 15.1 新仕様

同じユーザーについて、後日追加検査が増えたら**何度でも［Elith納品］を押せる。**

```
初回：  健診 + AI問診
後日：  血液3年分 + 遺伝子追加
        → 再度［Elith納品］
        → **その時点で有効なデータを改めて納品**
        → Elith が次回深夜バッチで再診断
```

- 前回との差分は管理画面に表示する（§14）。
- **「納品済み」badge は再納品を妨げない**（§8.1）。
- **何度押しても安全**であること（= 同じ内容なら S3 もキーも増えない）を**受入条件**とする（§21）。

### 15.2 Elith 側の再診断条件は**推測しない**

**Wellfort リポジトリだけでは確認できない。**
「既存 UID のフォルダに新しい JSON を追加・更新したとき、次回の深夜バッチで再診断が走るか」は
**§25.2 E-1 の Elith 確認事項**として分離する。**仕様で断定しない。**

---

## 16. DB / S3 / API への影響（指示書 §16）

### 16.1 DB — 新しい表は作らない

§14.2 の 2 表をそのまま使う。**新しい列も表も要らない**見込み（**要確認 U-4**）。

→ **migration は不要。** 実装着手時に §6.2 の表示項目を既存列と 1 つずつ突き合わせて確認する。

### 16.2 S3 — 既存のパス規約を変えない

| 層 | キー | 変更 |
|---|---|---|
| A. 中間 source | `{AWS_S3_PREFIX}user/{uid}/date/{YYYY_MM_DD}/{format_id}_date_{YYYY_MM_DD}_user_{uid}.json` | **変えない** |
| B. 本番 Elith 受取 | `user/{uid}/date/{YYYY_MM_DD}/…json` | **変えない** |
| 原本 | `additional_results/{uid}/{test_type}/{YYYY_MM_DD}/{sha256}.pdf` | **変えない** |

- **`manifest.json` を作らない**（`elith-delivery-json.ts:30-33`）。
- **キーを組み替えない**。本番キーは source キーから prefix を外すだけ（同 `:93`）。
- **A と B を混同しない**（§3.9）。**`elith-delivery-cleanup` は A を消す口**である（P-4）ので、
  **スペシャルアカウントの運用手順に組み込まない。**

### 16.3 中間 source をどうするか（指示書 §13・**要裁定 U-5**）

指示書は「AI問診完了時 / Scan export / 追加検査登録時に source JSON を残すか、
すべて Admin 納品時に DB から再生成するか」を調査して整理せよ、としている。**現行実装の事実:**

| 経路 | source を書くか | file:line | DB から再生成できるか |
|---|---|---|---|
| AI問診完了 | **書く**（`LifestyleQuestionnaireData`） | `interview/export.ts:180` | **できない。** `interview_completions` は**完了日時と設問数だけ**で、回答本文を保存しない（CLAUDE.md の確定事項） |
| ユーザースキャン | 書く（`scan-export-v0` 形式。Elith 形式ではない） | `api/scan/export.ts` | **できる。** `test_artifacts.scan_md` から `materializeHealthCheckups()` が決定論生成する（`elith-delivery.ts:142-154`） |
| 追加検査登録 | 書く（4 format） | `finalize.ts:251-253` | **一部できない。** 血液 / がんは `measurement_values` から戻せるが、**遺伝子 / AI疾病は `data.items[]` 形式で `measurement_values` に入らない**（`rows=0` が正常・`special-additional-tests.ts:192`） |

**本書の整理**

- **A（中間 source）を廃止できない。** 問診の回答本文と items 形式（遺伝子 / AI疾病）は
  **S3 の中間 source が唯一の保存先**である。消すと納品し直せない。
- **したがって手動納品は「中間 source を集めて B へ写す」形が正しい**
  （現行の `inventoryElithSource` + `assembleElithDeliverySet` と同じ）。
  **「Admin 納品時に全部 DB から再生成する」案は採れない。**
- **A の削除を自動化しない。** **勝手に既存 source 保存を消さない**（指示書 §13）。

> **要裁定 U-5**: 上記の整理で確定としてよいか（= 中間 source を恒久的に監査層として残す）。

### 16.4 API

| API | 変更 |
|---|---|
| Scan-Chat-AI `GET /api/admin/special-accounts` | **返り値を拡張**（§6.4）。既存キーは消さない |
| Scan-Chat-AI `POST /api/admin/special-accounts/deliver` | **母集団からスペシャルを外す**（§18.2） |
| Scan-Chat-AI **（新）1 uid 指定の手動納品** | 新規。`isSpecialAccount` 必須・§10.2 の 2 条件 |
| Scan-Chat-AI `POST /api/admin/special-additional-tests/finalize` | **既定を「納品しない」へ**（§12.2・要裁定 U-3）/ `health_checkup` を受ける |
| Scan-Chat-AI `POST /api/admin/special-additional-tests/scan-part` | `health_checkup` を受ける |
| Scan-Chat-AI `GET /api/cron/elith-deliver` | **削除しない。** 母集団の変更に追従するだけ |
| Scan-Chat-AI `POST /api/admin/share-links` | **変更しない** |
| wellfort-site `api/admin/special-accounts.ts` / `.../deliver.ts` | 中継の形は変えない（2 層認証 + `updated_by` をサーバ側で付与・`:95-108`） |
| wellfort-site `api/admin/special-additional-tests/[action].ts` | `finalize` の既定変更に追従 |

---

## 17. cron への影響（指示書 §3）

### 17.1 新仕様

| | 変更 |
|---|---|
| `vercel.json` の `crons` | **変更しない**（`0 14 * * *` のまま・`vercel.json:16-18`） |
| `GET /api/cron/elith-deliver` | **削除しない。** 呼び出す母集団から**スペシャルアカウントを外す** |
| 契約者 / 単品（非スペシャル） | **従来どおり自動納品。** `checkFormatsReady` の判定も `skipDelivered:true` も据え置き |
| スペシャルアカウント | **cron では 1 件も納品しない** |

### 17.2 分岐は 1 か所

§9.5 のとおり **`elith-delivery.ts` の母集団構築（`:450-457`）で 1 回だけ**除外する。

### 17.3 退行の見張り

**ここは静かに壊れる**（契約者が納品されなくなっても画面は正常に見える）。
→ `verify:elith-entitlement` に **「スペシャルでない単品/契約者が母集団に残ること」**と
**「スペシャルが母集団から消えること」**の 2 方向を入れ、**退行注入で落ちることを確認する**（§24）。

---

## 18. 通常ユーザーとの分離（指示書 §17 / §22）

### 18.1 退行させないもの

| 退行させない | 現行の要点 | 見張り |
|---|---|---|
| 通常ユーザーの購入・診断フロー | `app_bridge.subscription` の `status='active'` だけを権利とする（`elith-entitlement.ts:105-120`） | `verify:elith-entitlement` |
| 通常契約の自動 Elith 納品 | §17 | `verify:elith-entitlement`（新規ケース） |
| AI問診 | `interview/export.ts` / `interview-completion.ts` | `verify:interview-cycle` / `verify:interview-ui` |
| ユーザー自身の検診スキャン | `api/scan/save.ts` / `scan-persist.ts` | `verify:scan-persist` / `verify:scan-pages` / `verify:scan-async` |
| Admin impersonation | `admin-impersonation.ts` / `middleware.ts` | `verify:admin-handoff` / `verify:url-uid-privacy` |
| secure shared access | `share-access.ts` | `verify:share-access` |
| lab-results | `api/admin/lab-results-upload` / `originals-upload-ticket.ts` | `verify:originals-upload` / `verify:originals-put` |
| Elith intake | `api/cron/elith-intake` | `verify:elith-intake` |
| health age / wellness age | `wellness-age.ts` / `health-age*.ts` | 既存の照合 |
| 複数年表示 | `materializeHealthCheckups`（`elith-delivery.ts:159-242`）/ `SERIES_FORMATS` | `verify:scan-async` ⑥ / 新規（§23 E） |
| 既存 Dashboard | `dashboard.astro` / `ProgressSection.astro` | `verify:single-purchase` / `verify:demo-gate` |
| 既存 S3 path convention | §16.2 | `verify:special-additional-tests` E / 新規 |
| デモ用アカウント | `demo-data.ts:76` が `isSpecialAccount` で止める | `verify:demo-gate` / `verify:special-accounts` |

### 18.2 既存「Elith納品を一括作成」の扱い（指示書 §17）

**判断 = 役割を完全分離する（廃止しない）。**

**根拠**: あのボタンが呼ぶ `deliverReadySpecialAccounts()` の母集団は
**スペシャル ∪ 契約者**（`elith-delivery.ts:450-457`）。
**ボタンを消すと契約者の手動再ラップ手段が無くなる。**
（`/admin/elith-batch` にあるのは `elith-assemble` の単発納品と promote で、
`deliverReadySpecialAccounts` を呼ぶ口は**この 1 つだけ**。）

**新仕様**

1. **`deliverReadySpecialAccounts()` の母集団からスペシャルアカウントを外す。**
   `singleUids`（`:450-455`）を「単品だがスペシャルではない uid」に絞る
   = **`isSpecialAccount(uid)` が true の uid を除く**。
2. **ボタンは「契約者/単品の一括納品」として残す。** ただし
   **`/admin/special-accounts` から外す**（この画面の対象は全員スペシャルなので、
   同じ画面に「この画面の人は対象外のボタン」を置くと必ず誤解される）。
   置き場所は `/admin/elith-batch` が自然（**要裁定 U-6**）。
3. **スペシャルを一括で自動選択・納品する操作は作らない**（指示書 §17 末尾）。

**移設までの間の手段**: `GET /api/cron/elith-deliver` は **`ADMIN_API_KEY` でも通る**
（`api/cron/elith-deliver.ts:40-47`）ので、契約者の手動実行手段は失われない。

---

## 19. セキュリティ（指示書 §21）

### 19.1 守ること

| 規律 | 新仕様での守り方 | 現行の根拠 |
|---|---|---|
| Admin 認証を必須 | 2 層。①入口 = ユーザーのアクセストークン + anon apikey で `admin_users` を照会（**service_role を使わない**）②上流 = Bearer `SCAN_CHAT_AI_API_KEY`（= Scan-Chat-AI の `ADMIN_API_KEY`） | wellfort-site `api/admin/special-accounts.ts:34-55` / `:57-59` / Scan-Chat-AI `api-auth.ts:61-63` |
| **対象 uid はサーバ側で確定** | `checkAdditionalTarget()` / 新しい手動納品 API でも**毎回 `isSpecialAccount(uid)` を再確認**する | `special-additional-tests.ts:109-121` |
| ブラウザ申告だけを信じない | `updated_by` は中継がサーバ側で付与（`:95-96`）。`admin_email` も Supabase 検証値だけ（`impersonation-handoff.ts:75-76`） | 同上 |
| **PII を URL に載せない** | §19.2 | `url_uid_privacy_spec_20260929.md` |
| **PII を S3 key に載せない** | 原本キーに氏名も元ファイル名も入れない | `additional-originals.ts:5-15` |
| **PII を log に載せない** | メール現物を中継でもログに出さない / raw token をログに出さない / PDF の base64 と parsed 全文を出さない | wellfort-site `api/admin/special-accounts.ts:90-93` / `share-access.ts:305-306` / `scan-part.ts:112` |
| **PII を Elith JSON に載せない** | `subject` は性別と年齢だけ。元 PDF のファイル名を載せない。生年月日も載せない | `elith-delivery-json.ts:35-42` / `interview/export.ts:7` |
| 共有 URL の仕様を変えない | §13.2 | — |
| intake 専用キーの範囲を広げない | 新しい API を `LAB_INTAKE_API_KEY` で通さない（admin キーだけ） | `api-auth.ts:74-79` / `verify:intake-scope` |

### 19.2 対象 UID の受け渡し（**要裁定 U-2**）

**現行実装では uid は URL に出ていない（確認済み）**

- `special-additional-tests.astro` は `<select>` の value を **POST body** で送る（`:65` / `:392-395`）。
- `share-links.astro` も `picked.uid` を **POST body** で送る（`:244-253`）。
- どちらも `searchParams` を読まない。

→ **現状は漏れていない。** 問題は「**対象をセット済みで遷移する手段が無い**」ことだけ。

C-2 のとおり**再利用できる既存機構が無い**ので、3 案を比較する。

| 案 | 方式 | URL / 履歴 / Referer | サーバ変更 | 評価 |
|---|---|---|---|---|
| **案 1** | 遷移先を**別画面にしない**。一覧の行から**その場でパネルを開く**（`<details>` / モーダル）。対象は**既にその行の DOM にある値**をそのまま POST | **何も載らない** | **ゼロ**（新テーブル・新 API なし） | 「新方式を増やさない」に最も忠実。admin 画面で uid を表示することは既に許容されている（`share-links.astro:231-232`） |
| **案 2** | `sessionStorage` の 1 キー（例 `welltect.admin.target`）に uid を置いて遷移。遷移先が読んで `<select>` を選択済みにする | 載らない（タブ単位・閉じれば消える） | ゼロ | 画面を分ける指示書 §6 の形に沿う。**ただし新しい受け渡し規約が 1 つ増える** |
| 案 3 | wellfort-site 側に short-lived handoff（opaque token → サーバで uid へ解決）を新設 | 載るのは opaque token だけ | **新テーブル + 新 API**（`admin-impersonation.ts` と同形を 2 本目として作る） | 指示書 §6 の「既存パターン」に最も近い見た目だが、**実体は新機構**。コストが大きい |

**採らない案**: メールの sha256（`e.hash`・`special-accounts.astro:303` で既に使われている）を URL に載せる。
uid は非 PII だが**メールの digest は PII 由来で、かつメールは推測可能なので総当たりが効く**。
**uid より悪い**ので候補にしない。

> **裁定が要る（U-2）**: 指示書 §6 は「`/admin/special-additional-tests` へ遷移」と書いているので
> **案 2 が指示に近い**が、「新しい独自方式を勝手に増やさない」に忠実なのは**案 1**。こちらでは決めない。

**どの案でも守ること**: 遷移先のサーバ API は**渡された uid を信用せず `isSpecialAccount(uid)` を再確認する**
（§19.1）。受け渡しは「探す手間を省く」ためのものであって、**認可の根拠にしない。**

---

## 20. エラー時の扱い（指示書 §20）

**原則は現行実装のまま**（`finalize.ts:17-20` / `elith-delivery-json.ts:208-209`）。

| 失敗箇所 | Dashboard 登録 | Elith 納品 | 返す形 |
|---|---|---|---|
| 解析が空 | **しない** | しない | 422 `no_data`（`finalize.ts:158-163`） |
| 原本が S3 に無い | **しない** | しない | 404 / 503（同 `:166-170`） |
| 同日 active が 2 件以上 | **しない** | しない | 409 `artifact_ambiguous` + 候補一覧（同 `:180-185`） |
| 別内容の原本が既にある | **検査値は残す** | しない | 409 `original_conflict`（同 `:195-201`） |
| 中間 source を書けない | 残す | しない | 502 `source_json_failed`（同 `:254-260`） |
| **本番 PUT / 読み戻しだけ失敗** | **残す** | **failed として再実行可能** | 502 `delivery_failed` + `elith_delivery_items.status='failed'`（同 `:299-305`） |
| ウェルネス年齢が算出不能 | — | **HealthAgeData を載せずに続行**（捏造ゼロ） | `wellness_reason` を結果に載せる（`elith-delivery.ts:266-271` / `:604`） |
| 受診日が読めない | **しない** | しない | 422 `exam_date_unreadable` / 400 `invalid_test_date`（`api/scan/save.ts:97-103` / `finalize.ts:102-107`） |
| 揃っていない / 仕様を引けない | — | しない | `skipped` + **理由を必ず載せる**（`elith-delivery.ts:483-490`） |

**黙って落とさない。**「0 件」を不透明にしないため、未納品の理由を集計表示する現行の形
（`special-accounts.astro:497-510`）を確認モーダル / 結果表示にも引き継ぐ。

---

## 21. 冪等性（指示書 §21）

| 単位 | 冪等の根拠 | 新仕様で守ること |
|---|---|---|
| 中間 source のキー | `uid + test_date + format_id` で**同じキー**になる（`elith-delivery-json.ts:76`） | 再実行で増えない |
| 本番納品先のキー | source キーから prefix を外すだけ（同 `:93`） | 組み替えない |
| 本番 PUT | **既に同じ内容が在れば PUT し直さない**（SHA256 比較・同 `:240-248`） | そのまま使う |
| `elith_delivery_items` | unique `(test_artifact_id, format_id, destination_key)` の upsert（`20260930000060:49-51`） | 行が増えず `attempt_count` が進む |
| `elith_deliveries` | unique `(uid, bundle_date, delivery_prefix)` の upsert（`20260924000010:41`） | **`format_ids` を丸ごと上書きする**性質に注意（§14.2） |
| artifact | `uid + test_type + test_date + active` で 0/1/2+ 判定（`special-additional-tests.ts:170-173`） | **2 件以上は止める**（§11.3） |
| 原本 | キーが `sha256` 由来（`additional-originals.ts:15`） | 同じ PDF は同じキー |
| cron | `skipDelivered:true`（`elith-delivery.ts:504` / `:517-520`） | **スペシャルは cron に来ないので関係しない** |

**［Elith納品］は何度押しても安全**であること（= 同じ内容なら S3 もキーも増えない）を**受入条件**とする。

---

## 22. rollback（指示書 §22）

**各段階を独立に戻せる形で切る**（§27 の実装順序と対応）。

| 段階 | rollback 手段 |
|---|---|
| cron からのスペシャル除外（§17） | 除外の 1 行を戻すだけ。**DB もデータも触らない** |
| `finalize` の既定反転（§12.2） | 既定を戻すだけ。**既に納品したものは消えない**（消さない） |
| 一覧の集計拡張（§6.4） | 返り値の追加キーは**既存キーを消さない**ので、UI 側を戻せば画面は元に戻る |
| 一覧 UI の整理（§6） | 画面だけ。データに影響しない |
| 導線（§7.1 / §13） | 画面だけ |
| 新しい手動納品 API（§9） | API を外す。**S3 に書いたものは消さない** |
| 検診の Admin 登録（§11） | 対象種別から `health_checkup` を外すだけ |
| 一括ボタンの移設（§18.2） | 画面間の移動だけ |

**やらないこと**: 納品済み JSON の自動削除。Elith 側が既に取り込んでいる可能性があり、
**こちらから消すと先方の診断結果と食い違う**（§25.2 E-6）。
削除が要るときは `elith-delete` / `elith-delivery-cleanup` で**人が明示的に**行う
（ただし後者は中間 source を消す口・P-4）。

---

## 23. テスト項目（指示書 §23）

新規 `npm run verify:special-account-management` を想定する。
既存の `verify:*` と同型（**実物の TS を transpile し、DB / S3 だけスタブに差し替えて実際に動かす**）。
**鍵もサーバも要らないので CI の A 層**（`.github/workflows/ci.yml` の `static-required`）。

### A. 母集団と cron の分離（**最重要**）

| # | 検査 |
|---|---|
| 1 | cron 経路の母集団に**スペシャルアカウントが 1 件も入らない** |
| 2 | cron 経路の母集団に**契約者（`status='active'`）が入る** |
| 3 | cron 経路の母集団に**単品（非スペシャル）が入る** |
| 4 | `status='pending'` の契約者は入らない |
| 5 | 一括ボタン経路も ①〜④ と同じ母集団 |

### B. 最低条件（§10.2）

| # | 検査 |
|---|---|
| 6 | uid 未確定（サインイン前）は納品できない |
| 7 | **AI問診が無くても**納品できる |
| 8 | **`HealthCheckupData` が無くても**（血液だけでも）納品できる |
| 9 | Elith へ渡せるデータが 0 種類なら納品できない |
| 10 | `decideReady()` の fail-closed が**契約者側で生きている**（空 required で ready=false） |

### C. 対象 uid の確定（§19）

| # | 検査 |
|---|---|
| 11 | 非 admin 拒否 |
| 12 | スペシャルアカウント以外の uid を渡しても拒否（`checkAdditionalTarget`） |
| 13 | ブラウザ申告の uid だけで他人のデータを操作できない |
| 14 | **uid が URL に出ない**（生成する URL に UUID が含まれない） |
| 15 | **メールの sha256 も URL に出ない** |

### D. 登録と納品の分離（§12）

| # | 検査 |
|---|---|
| 16 | `finalize` が**既定で本番へ書かない** |
| 17 | `deliver` を明示したときだけ本番へ書く |
| 18 | 本番へ書かなくても `test_artifacts` / `measurement_values` / 原本 / 中間 source は書かれる |
| 19 | 本番 PUT だけ失敗したとき、**DB の登録は残り** `status='failed'` になる |

### E. 複数年（§9.3）

| # | 検査 |
|---|---|
| 20 | 血液 3 年分が**3 つの date フォルダ**として納品される（最新 1 件へ縮退しない） |
| 21 | 検診 5 年分が 5 つの date フォルダとして納品される |
| 22 | ウェルネス年齢が**年ごと**に載り、算出不能な年は載らない |
| 23 | `SERIES_FORMATS` の 4 種が**代表 1 件の指定で全 date 展開**される |

### F. 全 format が載る（P-1）

| # | 検査 |
|---|---|
| 24 | 7 種すべてが `manualMapping` に載り得る |
| 25 | 存在しない format は載らない（空のファイルを作らない） |

### G. 重複 artifact（§11.3）

| # | 検査 |
|---|---|
| 26 | 本人 `user_upload` の回がある日に Admin 登録すると、**その行が更新され 2 行目を作らない** |
| 27 | 更新時に `source` / `test_date` / `status` / 既存の原本が変わらない |
| 28 | 同日 active が 2 件あるときは `artifact_ambiguous` で止まる（自動で選ばない） |
| 29 | 受診日が読めない回は**保存しない**（today へ落とさない） |

### H. 冪等（§21）

| # | 検査 |
|---|---|
| 30 | 同じ内容で 2 回納品しても S3 のオブジェクト数が増えない |
| 31 | `elith_delivery_items` の行が増えず `attempt_count` だけ進む |
| 32 | `elith_deliveries` へ追加検査を書き込んで `format_ids` を消していない |

### I. 一覧の集計（§6.4）

| # | 検査 |
|---|---|
| 33 | 5 つの `test_type` すべての件数と最新日が返る |
| 34 | 「前回納品」が `elith_deliveries` と `elith_delivery_items` の**両方**を見る |
| 35 | DB 失敗時に**空（未完了）**で返り、「済み」と偽らない |
| 36 | 応答に氏名・生年月日・測定値・回答本文が含まれない |

---

## 24. 退行テスト（指示書 §24）

**この家の規律として、退行を注入して「名指しで落ちる」ことを確認する。最低 8 種。**

| # | 注入する退行 | 落ちるべき検査 |
|---|---|---|
| 1 | cron の母集団からスペシャルを外す除外を消す | A-1 |
| 2 | 除外を**和の前**に置く（= config 側で足し直せる形にする） | A-1 |
| 3 | `decideReady()` に「空なら OK」を足す | B-10 |
| 4 | `finalize` の既定を「納品する」へ戻す | D-16 |
| 5 | `manualMapping` を `HealthCheckupData` + `Lifestyle` の 2 つに戻す | F-24 |
| 6 | 複数年を**最新 1 件へ縮退**させる | E-20 / E-21 |
| 7 | `resolveAdditionalArtifact` の検索に **`source` を足す** | G-26（2 行目ができる） |
| 8 | 遷移 URL に `?u=<uid>` を足す | C-14 |

**8 種とも落ちることを確認してから実装完了とする。**

あわせて **§18.1 の既存 `verify:*` を全部通す**こと（特に `verify:elith-entitlement` /
`verify:special-accounts` / `verify:special-additional-tests` / `verify:share-access` /
`verify:admin-handoff` / `verify:scan-persist` / `verify:demo-gate` / `verify:single-purchase`）。

---

## 25. 未確定事項 / Elith 確認事項（指示書 §19 / §20 / §25）

### 25.1 こちらで裁定が要るもの（**実装前に埋める**）

| # | 未確定 | 本書の推奨 |
|---|---|---|
| **U-1** | 手動納品を `assembleElithDeliverySet` 経路（A）で作るか、`deliverAdditionalJson` 経路（B）で作るか。A に読み戻し検証を足すと既存 deliver API / cron にも波及する | **A を主、読み戻しは A の後に足す**（§9.6） |
| **U-2** | 対象 uid の受け渡し方式。案 1（画面を分けず行でパネルを開く）/ 案 2（`sessionStorage`）/ 案 3（新 handoff） | 指示に近いのは**案 2**、「新方式を増やさない」に忠実なのは**案 1**（§19.2） |
| **U-3** | `finalize` の既定を「納品しない」へ反転するか、UI が `deliver:false` を送るか | **反転（案 a）**（§12.2） |
| **U-4** | migration が本当に 0 本で足りるか（既存 2 表の列で §6.2 の表示が全部作れるか） | 本書の調査では**0 本で足りる**。実装着手時に列を 1 つずつ突き合わせて確認する（§16.1） |
| **U-5** | 中間 source を恒久的に監査層として残す整理で確定としてよいか | **残す**（問診の回答本文と items 形式は S3 が唯一の保存先・§16.3） |
| **U-6** | ［Elith納品を一括作成］の移設先 | `/admin/elith-batch`（§18.2） |
| **U-7** | 「前回納品後の追加」の差分粒度（検査種別ごとの件数差分 / format×date 差分） | **検査種別ごとの件数差分**（§14.3） |
| **U-8** | 検索・フィルタ（指示書 §16）をどこまで作るか。**氏名・会社名は出せない**（C-3） | メモ / マスク / uid 先頭の**部分一致 1 本** + 状態での絞り込みまで。それ以上は作らない |

### 25.2 Elith へ確認すること（リポジトリ内では裏取りできない）

| # | 確認事項 |
|---|---|
| **E-1** | **既存 UID のフォルダに新しい JSON を追加・更新したとき、次回の深夜バッチで再診断が走るか。** 走る条件は何か（新規ファイルの有無 / 更新時刻 / ファイル数） |
| **E-2** | 同じ `format_id` × 同じ date フォルダのファイルを**上書き**した場合の扱い（再診断するか・無視するか） |
| **E-3** | 複数年（date フォルダが複数）のとき、どの範囲を入力に使うか |
| **E-4** | `HealthAgeData` が一部の年に無い場合の扱い（当社は算出不能な年を載せない） |
| **E-5** | AI問診（`LifestyleQuestionnaireData`）が無い納品セットを受け付けるか。報告書の生活習慣章が空になるのは想定どおりか |
| **E-6** | 納品後に「取り下げたい」場合の手順（こちらから S3 を消してよいか・§22） |

**発注者確認済みの前提**（指示書 §20。これは変えない）

- Elith は**本番納品フォルダ内のユーザーフォルダ（UID）を対象に処理**する。
- **毎日深夜 0 時**に診断処理バッチが RUN する。
- Wellfort 側はそれ以前に必要な JSON を置く。
  → 23:00 JST の cron はこの 1 時間前に合わせたもの（`api/cron/elith-deliver.ts:6-8`）。
  **手動納品も「深夜 0 時より前に押す」運用**になる（§7.3 で画面に書く）。

### 25.3 既存仕様書から持ち越す未確定

`docs/specs/special_account_additional_tests_spec_20260930.md §48.2` の U-1〜U-3
（Elith の再診断起動方式 / 血液 PDF の様式の多様性 / ALA-PDS 以外のがんリスク様式）は**そのまま残る**。
本書の E-1 は同 U-1 と同じ事項である。

---

## 26. 実装対象ファイル候補（指示書 §26）

**この節はファイル一覧であって、実装の指示ではない。** 指示書 §25 のとおり今回は 1 行も触らない。

### 26.1 Scan-Chat-AI

| ファイル | 操作 | 内容 |
|---|---|---|
| `src/lib/account-progress.ts` | modify | 5 つの `test_type` 集計 + `elith_delivery_items`（§6.4） |
| `src/lib/elith-delivery.ts` | modify | 母集団からスペシャル除外（§18.2）/ 1 uid 手動納品（§9）/ `manualMapping` を 7 種へ（§9.2） |
| `src/lib/elith-entitlement.ts` | modify | **`decideReady()` は触らない。** スペシャル用の別述語（`hasAnyDeliverable`）を足す（§10.3） |
| `src/lib/special-additional-tests.ts` | modify | `health_checkup` を対象に足す（§11） |
| `src/lib/additional-originals.ts` | modify | `ADDITIONAL_TEST_TYPES` に `health_checkup`（§11.2） |
| `src/pages/api/admin/special-accounts.ts` | modify | 拡張した progress を返す |
| `src/pages/api/admin/special-accounts/deliver.ts` | modify | スペシャル除外に追従 |
| `src/pages/api/admin/special-accounts/deliver-one.ts`（仮） | create | 1 uid 手動納品（§9） |
| `src/pages/api/admin/special-additional-tests/finalize.ts` | modify | 既定を「納品しない」へ（§12.2・U-3）/ `health_checkup` |
| `src/pages/api/admin/special-additional-tests/scan-part.ts` | modify | `health_checkup` を受ける |
| `src/pages/api/cron/elith-deliver.ts` | modify | **削除しない。** 母集団の変更に追従するだけ |
| `scripts/verify-special-account-management.mjs` | create | §23 / §24 |
| `package.json` | modify | `verify:special-account-management` |
| `docs/specs/special_account_management_spec_20261001.md` | （本書） | — |

**触らない**: `elith-assemble.ts`（`SERIES_FORMATS` / `sanitizeDelivery` / `rewriteClientId` を共用するだけ）/
`elith-delivery-json.ts`（読み戻し検証を共用するだけ）/ `share-access.ts` / `admin-impersonation.ts` /
`middleware.ts` / `write-guard.ts` / `scan-persist.ts` / `interview/export.ts` / `api/scan/save.ts` /
`supabase/migrations/**`（U-4）。

### 26.2 wellfort-site

| ファイル | 操作 | 内容 |
|---|---|---|
| `src/pages/admin/special-accounts.astro` | modify | 一覧の全面整理（§6）/ 行ごと 3 ボタン（§7）/ 確認モーダル（§7.3）/ 一括ボタンの撤去（§18.2） |
| `src/pages/admin/special-additional-tests.astro` | modify | 対象セット済みで開く（§7.1）/ 文言を「登録」へ（§12.1）/ `health_checkup` を選択肢に |
| `src/pages/admin/share-links.astro` | modify | 外から対象を受け取る経路（§13.3）。**共有基盤は 1 行も触らない** |
| `src/pages/api/admin/special-accounts/deliver-one.ts`（仮） | create | 中継（2 層認証は既存と同形） |
| `src/pages/api/admin/special-additional-tests/[action].ts` | modify | `finalize` の既定変更に追従 |
| `src/pages/admin/elith-batch.astro` | modify | 一括納品ボタンの移設先（U-6） |

**触らない**: `AdminLayout.astro`（メニューは既に 3 本とも在る・`:45` / `:51` / `:56`）/
`api/admin/share-links.ts`（中継の形を変えない）/ `api/admin/impersonation-handoff.ts`。

---

## 27. 実装順序（指示書 §27）

**各段のあいだで検証を通す。1 段ごとに rollback できる形で切る。**

| 段 | 内容 | 受入 |
|---|---|---|
| **P0** | **裁定を取る**（U-1〜U-8）。特に U-2（受け渡し方式）と U-3（既定の向き）は後戻りが大きい | 発注者の回答 |
| **P1** | **cron からスペシャルを除外**（§17）。**これだけで「人の確認前に本番へ出る」が止まる**ので最初に入れる | `verify:elith-entitlement` に A-1〜A-5 → 退行注入 1・2 で落ちる |
| **P2** | **`finalize` の既定反転**（§12.2）＋ UI 文言（§12.1）。**登録とその場納品の一体化を切る** | D-16〜D-19 → 退行注入 4 で落ちる |
| **P3** | **一覧の集計拡張**（§6.4）。API の返り値を広げるだけで UI はまだ変えない | I-33〜I-36 |
| **P4** | **一覧 UI の整理**（§6）＋ 状態 badge（§8）＋ 3 ボタンの枠（押すとまだ何もしない） | 目視 + 既存 `verify:screen` を壊さない |
| **P5** | **［追加検査データ］導線**（§7.1）＋ **［共有URL設定］導線**（§13）。U-2 の裁定どおり | C-14 / C-15 → 退行注入 8 で落ちる |
| **P6** | **1 uid 手動納品 API**（§9）＋ 確認モーダル（§7.3）。**7 種全部・複数年** | E-20〜E-23 / F-24 / F-25 → 退行注入 5・6 で落ちる |
| **P7** | **検診・人間ドックの Admin 登録**（§11）。**重複 artifact を作らないことが受入条件** | G-26〜G-29 → 退行注入 7 で落ちる |
| **P8** | **一括ボタンの移設**（§18.2・U-6）＋ 前回差分（§14・U-7）＋ 検索（U-8） | H-30〜H-32 |

**P1 と P2 を先に入れる理由**: どちらも「意図しない本番納品を止める」側の変更で、
**機能追加を待たずに単独で価値がある**。逆に P6（手動納品）を先に入れると、
**cron と手動の両方が動く期間**ができて二重納品の窓が開く。

---

## 28. Source of Truth

本機能（スペシャルアカウントの**管理画面と Elith 納品の起動**）については**本書を正本**とする。

既存ドキュメントと矛盾した場合、**この範囲については本書を優先**する。
ただし下表の対象外部分については既存仕様を優先する。

| 文書 | 何の正本か | 本書との関係 |
|---|---|---|
| `docs/operations/スペシャルアカウント_仕様書.md` | スペシャルアカウントの**判定・登録** | **変えない**（§1.1 の前提） |
| `docs/specs/special_account_additional_tests_spec_20260930.md` | 追加検査の**解析・artifact・原本・source JSON・納品 JSON** | **§9（納品は STEP 2 で行う）と §4（対象 4 種）だけを本書 §11 / §12 が置き換える。** それ以外（§10〜§34 の解析・artifact・原本・サニタイズ・冪等）は**そのまま正本** |
| `docs/specs/secure_shared_access_and_admin_impersonation_spec_20260930.md` | secure share / Admin 代理表示 | **変えない**（本書は導線を足すだけ・§13.2） |
| `docs/specs/url_uid_privacy_spec_20260929.md` | URL から uid を消す規律 | **従う**（§19.2） |
| `docs/subscription/kit_lifecycle_and_handoff_management_spec.md §4.3.1` | **契約者**の権利と自動納品トリガ | **変えない。** 本書はスペシャルを**対象外**にするだけ（§17） |
| `docs/lab/スペシャルアカウント_複数年スキャン_仕様書.md` | `HealthCheckupData` の複数年 | **変えない**（§9.3 / §11.5 が依存している） |
| `docs/elith/elith_s3_data_handoff_spec.md` | S3 のパス / 命名 / format_id | **変えない**（§16.2） |
| `docs/elith/elith_assembly_wrapping_spec.md` | 納品セットのラップ | **変えない**（§9.3） |

---

## 29. Sources / Evidence

`f7bb8a9`（Scan-Chat-AI）/ `1629580`（wellfort-site）時点の内容を指す。

**Scan-Chat-AI**

- `src/lib/elith-delivery.ts:72-117, 119-130, 159-242, 244-313, 328-391, 393-422, 429-621`
- `src/lib/elith-assemble.ts:29-37, 322, 361, 380-520`
- `src/lib/elith-entitlement.ts:49-57, 62-90, 109-148, 158-240`
- `src/lib/account-progress.ts:17-36, 38-111`
- `src/lib/special-accounts.ts:48-51, 65-73, 99, 114, 217-240, 280-360`
- `src/lib/special-additional-tests.ts:41-53, 67-73, 91-93, 109-121, 144-235, 241-295`
- `src/lib/elith-delivery-json.ts:1-43, 79-106, 185-272, 282-351`
- `src/lib/additional-originals.ts:1-50, 71-90`
- `src/lib/scan-persist.ts:80-130, 136-241, 244-255, 279-330, 365-400`
- `src/lib/share-access.ts:11-20, 26-53, 250-310, 316-330, 423-460, 507-532, 576-616, 617-690`
- `src/lib/admin-impersonation.ts:1-42, 73-80, 94-150, 180-295`
- `src/lib/api-auth.ts:61-63, 65-91`
- `src/lib/s3.ts:64-79`
- `src/middleware.ts:1-30, 101-200, 220-267`
- `src/pages/api/admin/special-accounts.ts:20-27, 41-46, 68-115, 117-150`
- `src/pages/api/admin/special-accounts/deliver.ts:1-14, 34-60`
- `src/pages/api/admin/special-additional-tests/finalize.ts:1-32, 78-120, 141-170, 172-210, 230-266, 268-308`
- `src/pages/api/admin/special-additional-tests/scan-part.ts:1-25, 52-115`
- `src/pages/api/admin/share-links.ts:17-19, 60-77, 79-120`
- `src/pages/api/admin/impersonation/handoff.ts:1-40`
- `src/pages/api/admin/elith-delivery-cleanup.ts:1-20, 39-71`
- `src/pages/api/cron/elith-deliver.ts:1-18, 25-26, 35-47, 49-69`
- `src/pages/api/interview/export.ts:1-23, 125-185`
- `src/pages/api/scan/save.ts:1-13, 32-113`
- `src/pages/dashboard.astro:134-137`
- `supabase/migrations/20260924000010_elith_deliveries.sql:9-48`
- `supabase/migrations/20260930000060_elith_delivery_items.sql:1-60`
- `supabase/migrations/20260930000010_admin_impersonation.sql:23-95`
- `supabase/migrations/20260930000020_shared_access.sql`
- `vercel.json:6-19`
- `package.json`（`verify:*` 51 本）

**wellfort-site**

- `src/pages/admin/special-accounts.astro:29-87, 142-232, 234-365, 367-420, 422-470, 472-527`
- `src/pages/admin/special-additional-tests.astro:60-110, 181, 215-239, 265-300, 355-403, 405-458`
- `src/pages/admin/share-links.astro:40-80, 195-260, 300-340`
- `src/pages/api/admin/special-accounts.ts:14-16, 34-55, 57-68, 70-114`
- `src/pages/api/admin/special-accounts/deliver.ts:1-20, 29-50, 65-83`
- `src/pages/api/admin/special-additional-tests/[action].ts`
- `src/pages/api/admin/share-links.ts`
- `src/pages/api/admin/impersonation-handoff.ts:1-30, 36-57, 59-109`
- `src/components/AdminLayout.astro:45, 51, 56`

---

## 30. 改訂履歴

| 版 | 日付 | 内容 |
|---|---|---|
| 1.0 | 2026-10-01 | 初版。発注者指示書（2026-10-01・26 節）を実コードで裏取りして起こした。**実装は 1 行もしていない。** |
