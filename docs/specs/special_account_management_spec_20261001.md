# スペシャルアカウント管理機能 改訂仕様書

**版**: 2.0 (2026-10-01・**P1〜P8 実装済み**。実装の地図と、実装で分かったことを §26.1 / §27.1 に足した)
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
| **C-2** | §6/§8「既存 **opaque context / server session / short-lived handoff** を再利用」 | **再利用できる既存機構が無い。** 既存の short-lived handoff（`admin-impersonation.ts:106` `createHandoff`）が発行するのは **Scan-Chat-AI の `/admin-view/<ctx>/…` 代理表示 context**（同 `:42` `ADMIN_VIEW_PREFIX`・`middleware.ts:220-262`）で、**wellfort-site の admin 画面に対象をセットする用途には使えない**。`share-access.ts` の pending / session も**外部閲覧者**用 | **§19.2 のとおり `sessionStorage` 方式で確定（D-2）**。「既存を流用」と書いて実体の無い機構を指さない（R2） |
| **C-3** | §4/§15 一覧に**氏名・会社名**を出す案（§16 の検索条件にも氏名/会社名） | スペシャルアカウントは **EC 購入が無いので `customer.customer_profiles` に行が無い**。`makeSubjectResolver()`（`elith-delivery.ts:82-90`）が `customer_profiles` を引いて空振りし `:103` の `specialSubjectByUid(uid)` にフォールバックしている構造がその証拠。保持しているのは**メールのマスク（`r***@example.com`）とメモ**だけ（`special-accounts.ts:114` / `api/admin/special-accounts.ts:12`） | **氏名・会社名は出せない。**「対象者」は**メモ（案件名）＋マスク＋uid 先頭**で構成（§6.2）。検索も同じ 3 つに限る（D-8・§19.3） |
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

### 6.5 承認画面案（2026-10-01）を実装へ落とすときの補正事項

発注者から提示された画面案（ChatGPT 作成）を実コードと突き合わせた結果の**確定事項**。
**これは「デザイン参考」ではなく禁止事項である** — 画像だけを見て**存在しない機能を実装させない**ために置く。

**採用する**（画面案のとおり）

- 1 アカウント = 1 行 / 検査 6 種の件数＋最新日 / 状態 badge / 最終更新 / 前回納品 / メモ /
  右端 3 ボタン / 行クリックでの詳細展開。

**補正する**（画面案のままでは作れない、または作ってはいけない）

| # | 画面案 | 確定 | 根拠 |
|---|---|---|---|
| **F-1** | 対象者を**氏名・会社名**で表す | **氏名・会社名を表示の前提にしない。** 表示の正本は **メモ（案件名）＋メールマスク（`r***@example.com`）＋UID** | **現在のスペシャルアカウント管理の正本と API が、氏名・会社名を保持も返却もしていない**ため。保持しているのは sha256 / マスク / uid / メモ の 4 つ（`api/admin/special-accounts.ts:12`）で、一覧 API の応答にも氏名・会社名は無い（同 `:79-93` の `present()`）。**「`customer_profiles` に行が必ず無い」と言っているのではない** — 将来その人が EC 顧客にもなれば行は在り得る。**この枠の管理 UI がその経路に依存しない**、という意味である |
| **F-2** | UID が `wf_7f3a9c2e` | **実体は UUID。** 画面では可読性のため**先頭 8 文字程度の短縮表示は可**。ただし**内部値と API は完全な UUID** を使う | `special-accounts.astro:425` の入力検証が UUID 固定 |
| **F-3** | AI問診が「**未実施**」と「なし」で混在 | **「完了 / なし」の 2 語に統一。**「未実施」は使わない | §10.1 |
| **F-4** | 列見出し「AI疾病予測」 | **正式表示名は `AI疾病予測報告書`。** 列幅の都合でやむを得ず短縮するときも、**正式名称を `title` / `aria-label` 等で保持**する。**勝手な別名称を正本化しない** | `display-names.ts:28` の `AI_PREDICTION_REPORT_LABEL` |
| **F-5** | badge の副文言「追加データあり」「最新と同一」 | **前回 run の snapshot（D-7）が実装されるまで表示しない** | 差分の出所は §14.3 の snapshot。**snapshot が無い回（初回・migration 適用前）は副文言を出さない** |
| **F-6** | badge の副文言「データあり / データなし」 | **不要**（badge 本体「準備あり / 未準備」と同義の重複） | §8.1 |
| **F-7** | ページネーション / 通知ベル / ヘルプボタン | **今回は追加しない**（現在存在しない装飾機能） | 指示書 §16「実装コストに対して過剰なものは作らない」 |
| **F-8** | 独自のサイドバー | **`AdminLayout` を既存のまま使う。** 利用者側の「検査結果」「AI疾病予防報告書」を**持ち込まない** | 下記 6.5.1 |

#### 6.5.1 Admin メニューの実際（本書 1.0 の誤りを訂正）

**本書 1.0 の §0.2 C-5 周辺で「ダッシュボードも admin には無い」と書いたのは誤りだった。**
実コードを再確認した結果は次のとおり。

| 項目 | 実際 | 根拠 |
|---|---|---|
| **ダッシュボード** | **admin に存在する**（`group: 'main'`） | `AdminLayout.astro:16` |
| 検査結果 | **admin に無い**（利用者側の画面） | 同ファイルに該当 label なし |
| AI疾病予防報告書 | **admin に無い**（利用者側の画面） | 同上 |

`group: '設定'` 配下の実際（`main` 時点）:
営業日カレンダー / 決済 環境切替 / 管理者管理 / **デモ用アカウント** / **スペシャルアカウント** / **セキュア共有リンク**
（`AdminLayout.astro:36-50`）。

> **「追加検査の登録」は `main` にはまだ無い。** あれは `1629580`（未マージ）が足した項目で、
> `claude/cool-dirac-1dkyx7` にしか存在しない。**§7.1 の［追加検査データ］導線は、
> その遷移先ページが main に入ってからでないと成立しない**（実装順序 §27 P5 の前提）。

---

## 7. 各ボタンの動作

### 7.1 ［追加検査データ］（指示書 §6）

- 押すと **対象アカウントがセット済みの `/admin/special-additional-tests`** へ入る。
- 対象者表示は **メモ（案件名）＋マスク＋uid**（C-3 により氏名は出せない）。
- 管理者が再度 uid を探して選ぶ操作をなくす。
- 受け渡し方式は **`sessionStorage`**（D-2・§19.2）。
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

#### 7.3.1 件数の正本は **delivery preview（実際の assemble 結果）**。DB 件数をそのまま出さない

**モーダルの件数に §6.4 の `getAccountProgress` の DB 件数をそのまま出してはならない。**
**DB に行が在ること**と、**その回が実際に Elith 納品 JSON になること**は別である。実コードの裏付け:

- 受診日が読めない回は**そもそも保存されない**（スペシャルは `exam_date_unreadable` で差し戻し・§12）。
- `materializeHealthCheckups` は **date フォルダ単位で dedup** する（`elith-delivery.ts:159-242`）ので、
  **artifact が 5 件でも受診日が 3 通りなら JSON は 3 つ**になる。
- ウェルネス年齢は**算出不能な年を載せない**（同 `:266-271`）。

→ DB 件数を出すと **「5件」と書いて 3 ファイルしか出ない**ことが起こる。これは §7.3 の
「件数を実際の算出結果から出す」をウェルネス年齢だけでなく**全種別に広げる**ということである。

**確定した形**:

1. **確認モーダルを開いた時点で assemble を実走させ、`plan` を作る。**
   `plan` = **これから書く予定のファイル一覧**で、各要素は
   **`format_id` / `delivered_date`（date フォルダ）/ `destination_key` /
   `content_sha256`（生成メタを除いた中身の指紋）/ `delivery_sha256`（実 body の指紋）** を持つ。
   **この時点で Elith 本番受取領域（`deliveryPrefix` 配下）へは書かない**（§23 K-46 / V-4）。

   **【P0-1・2026-10-01 訂正】「S3 へ 1 バイトも書かない」は事実ではなかった。**
   preview は確認用データを組み立てるために既存パイプラインを実走させるので、副作用として

   | 書かれる先 | 経路 | 何か |
   |---|---|---|
   | **中間 source** `{sourcePrefix}user/…` | `elith-manual-delivery.ts` `materializeHealthCheckups()` → `elith-delivery.ts:231` `putFiles()` | HealthCheckupData（§16.3 で恒久的に残すと決めた監査層） |
   | **`diagnosis.health_age_scores`** | `elith-manual-delivery.ts` `computeWellnessFromMeasurements()` → `elith-delivery.ts:288` `upsert()` | ウェルネス年齢（同じ入力から同じ値が出る算出結果） |

   が**更新される場合がある**。どちらも**納品ではない**ので要件
   （= 確認前に Elith 本番受取領域へ書かない）は満たしているが、**文言が実装と違っていた**。

   - **大規模な in-memory 化はしない**（発注者判断 2026-10-01）。副作用を消すには
     assemble 全体をメモリ上で完結させる必要があり、既存パイプラインの作り替えになる。
   - **仕様書・コード・UI の文言を実装に合わせる**。画面・API の `note` は次の 1 文で統一する:

     > この確認では Elith 本番受取領域には書き込みません。確認用データを組み立てるため、
     > 中間 source とウェルネス年齢の算出結果は更新される場合があります。

   - **K-46 も「preview では本番 `user/` へ PUT しない」を検査する内容へ直す**（§23）。
2. **モーダルの件数は `plan` を数えた数**である。ウェルネス年齢の「N件（算出可能分）」も `plan` から数える。
3. **一覧の DB 件数と `plan` が食い違ったら警告を出す。** 黙って `plan` を採らない。

   > 「一覧の件数（血液検査 4件）と、実際に納品されるファイル数（3件）が一致しません。
   > 　受診日が読めない回・同じ受診日に畳まれた回が含まれている可能性があります。」

   - **ブロックはしない**（押せなくすると運用が止まる）。
   - **どちらが正かを画面で明示する** — **納品されるのは `plan` 側**である。
   - 食い違いは**異常ではなく起こり得る状態**なので、赤いエラーにしない（§13.4 の語彙の規律）。
4. **［この内容でElith納品］を押したら、同じ `plan` をそのまま `putVerified`（§9.6）へ渡す。**
   **確定後に assemble を作り直さない** — 作り直すと「確認した内容」と「実際に書いた内容」がずれ、
   **確認モーダルが確認になっていない**状態になる。
5. **snapshot は `putVerified` の verified 結果から作る**（§14.3.1）。
   `plan` でも DB 件数でもなく、**実際に読み戻して SHA256 が一致したファイル**が控えの正本である。

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

### 9.6 納品の書き込みは **共通 Verified PUT/readback helper** に一本化する（**D-1・確定**）

現状、納品の書き込み方が **2 つあり、挙動が違う**。

| | A. `assembleElithDeliverySet` 経路 | B. `deliverAdditionalJson` 経路 |
|---|---|---|
| 単位 | uid 丸ごと（全 format・全 date） | **1 ファイル** |
| **読み戻し検証** | **無い**（`putFiles` の成否だけ・`elith-delivery.ts:573`） | **有る**（PUT → GET → SHA256 突合・`elith-delivery-json.ts:261-271`） |
| 既に同一内容なら PUT しない | 無い | 有る（同 `:240-248`） |
| 履歴 | `elith_deliveries`（年ごと） | `elith_delivery_items`（検査ごと） |
| 複数年 | `SERIES_FORMATS` が自動展開 | 呼び出し側がループする |
| 既存の呼び出し元 | deliver API / cron | 追加検査 finalize |

#### 9.6.1 確定した方式

**「A を主にして、そのあとに `deliverAdditionalJson` を回す」ではない。**
（1.1 までの推奨案はこれだったが、**発注者裁定で変更**した。B は
「source を GET → `rewriteClientId` → キー変換 → PUT → 読み戻し」まで**丸ごと 1 つ**なので、
A のあとに回すと **PUT が 2 度走り、キー変換と client_id 書き換えも二重に通る**。）

→ **「書いて・読み戻して・突合する」部分だけを共通 helper に切り出し、A と B の両方がそれを呼ぶ。**

```
putVerified(files: S3PutFile[]) → VerifiedPutResult[]
  各ファイルについて
    ① 納品先を GET し、SHA256 が一致すれば **PUT しない**（冪等・既存 B の性質）
    ② PUT する
    ③ **読み戻して SHA256 を突合**し、一致して初めて verified:true
    ④ **投げない。** 失敗は戻り値（verified:false + 理由）で返す
```

**1 ファイルあたりの追加 GET は最大 2 回**である（① 事前比較の GET ＋ ③ PUT 後の readback GET）。
**既に同一内容が在る回は ① で止まるので GET 1 回・PUT 0 回**（既存 B の冪等性をそのまま引き継ぐ・
`elith-delivery-json.ts:240-248`）。
**「1 ファイルにつき GET が 1 回増える」ではない** — 見積り（V-1）は**新規 / 変更ファイルの 2 回**で立てる。

- 置き場所は **`src/lib/s3.ts` の隣に 1 本**（`putFiles` を置き換えず、**その上に重ねる**）。
- **A は `putFiles(files)` を `putVerified(files)` に差し替える**だけ。
- **B は自前の PUT・readback・sha 比較を捨てて helper を呼ぶ**。
  **`toDestinationKey` / `rewriteClientId` / `sanitizeDelivery` は helper に持たせない** —
  あれらはキーと中身の責務で、書き込みの責務ではない（§9.4 の共用方針のまま）。

#### 9.6.2 これに伴って必ず決めること（実装時の受入条件）

| # | 事項 | 確定 |
|---|---|---|
| a | **既存 deliver API と cron にも読み戻しが入る**（GET が増える） | **許容する。** 増える GET は **新規 / 内容が変わったファイルで最大 2 回**（事前比較 GET ＋ PUT 後 readback GET）、**既存と同一内容なら 1 回**（PUT は 0 回）。複数年 × 複数 format でファイル数が増えるので、**cron の `maxDuration: 800`（`api/cron/elith-deliver.ts:26`）に収まること**を、**最悪ケース = 全ファイルが新規 / 変更（1 ファイルあたり GET 2 回 ＋ PUT 1 回）**で実測する（**V-1**） |
| b | 一部のファイルだけ verified:false になったとき | **その年（date フォルダ）を `elith_deliveries` へ `delivered` として記録しない。** 「書けたが読み戻せていない」を納品済みと呼ばない（既存 B の §29 と同じ規律） |
| c | 結果の見せ方 | **黙って落とさない。** verified:false のファイルは件数と理由を結果に載せ、確認モーダルの戻りと admin の表示に出す（§20） |
| d | 既存 `elith_delivery_items` の記録 | **変えない。** B の呼び出し側が従来どおり `recordDeliveryItem` を呼ぶ |

**`putFiles` 自体の挙動は変えない** — 他の経路（scan export / 問診 export / 中間 source の書き出し）が
そのまま使っているため。**読み戻しが要るのは納品先（`user/…`）だけ**である。

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

### 12.2 サーバ側の既定を「納品しない」へ反転する（**D-3・確定**）

`finalize.ts:264` は `if (body.deliver === false)` で**明示的に false のときだけ**止まる。
つまり**既定は納品**。

| 案 | 変更 | リスク |
|---|---|---|
| **案 a（推奨）** | **サーバ側の既定を「納品しない」へ反転**し、`deliver:true` を明示したときだけ納品する | 既存の呼び出し元は wellfort-site の 1 か所だけ（`special-additional-tests.astro:392`）なので波及が小さい。**UI 側の送信漏れで誤納品になる事故が構造的に消える** |
| 案 b | サーバは据え置き、UI が `deliver:false` を送る | **UI の 1 行を忘れたら本番へ出る。**「送り忘れ = 誤納品」は危険側のフェイルセーフ |

→ **案 a を推奨。** CLAUDE.md の規律（「綴り違いで黙って全停止しないよう、止める側を明示的な値に
寄せる」）の裏返しとして、**危険な側を明示的な値に寄せる**。

**確定（D-3）= 案 a。** `finalize` は **`deliver: true` を明示されたときだけ**本番へ出す。
実装時の受入条件: **`deliver` を送らない既存の呼び出しが本番へ出ないこと**を検査で固定する（§23 D-16 / §24 注入 4）。

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
- 受け渡し方式は **`sessionStorage`**（D-2・§19.2）。

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

### 13.4 承認画面案（2026-10-01）を実装へ落とすときの補正事項

画面案の「レポート共有URLの作成」モーダルを実コードと突き合わせた結果の**確定事項**。
**既存のセキュア共有の設計思想と正面から衝突する項目が 2 つある**ので、禁止事項として置く。

| # | 画面案 | 確定 | 根拠 |
|---|---|---|---|
| **G-1** | 新しい共有設定モーダルを作る | **作り直さない。既存 `/admin/share-links` を再利用する** | §13.1 |
| **G-2** | 「**パスワードを設定する**」トグル | **追加禁止。** 既存の「**共通 ID・パスワードを採らない**」原則を維持する | `share-access.ts:7`「共通 ID・パスワードは採らない — 誰が入ったか分からず、部分失効もできないため」。DB にパスワード列も無い |
| **G-3** | 権限設定「**閲覧のみ / ダウンロード可**」 | **「ダウンロード可」という権限は追加しない。** そもそも存在しない | `ShareScope = { view: true; interview: boolean; scan: boolean }`（`share-access.ts:103-107`） |
| **G-4** | 上記を scope として扱う | **scope は既存どおり `view=true` 固定、任意権限は `interview` / `scan` のみ** | `normalizeScope`（同 `:139-143`）「既定は閲覧のみ（未知の値で権限を広げない）」 |
| **G-5** | 「有効期限 30日間（推奨）」等の独自項目 | **設定項目の正本は既存の 5 つ** — 用途・ラベル / 開始日時 / 期限 / **AI問診の利用を許可** / **AIスキャンの利用を許可** | `share-links.astro:66-72` |
| **G-6** | 一覧から共有設定へ入る | **対象 UID をセット済みにする導線だけを追加する。** 共有基盤・token・session・revoke・access log・kill switch は**変更しない** | §13.2 |

#### 13.4.1 用途ラベルの placeholder を一般化する（**G-7・今回の必須文言変更**）

`/admin/share-links` の用途ラベルの placeholder が

```
用途・ラベル（例: 助成金事務局 確認用）
```

で、**特定の利用先を想起させる**（`share-links.astro:66`）。

**今回の UI 改修で「外部確認用」等の一般的な表現へ変更する。必須。**
（1.1 では「候補・必須ではない」としていたが、**発注者裁定で必須の文言変更へ格上げ**した。）

- **変えるのは placeholder の文字列だけ。** `maxlength` も `id` も送信値も触らない。
- **既に発行済みリンクの `label` は書き換えない**（過去の記録を改変しない）。
- §13 の導線を入れる PR に**同梱する**（単独の PR にしない）。

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

### 14.3 差分の出し方 — **前回 run の PII なし snapshot と比べる**（**D-7・確定**）

**納品が成立した時点の「何が入っていたか」を PII なしで控えておき、次回はそれと今を比べる。**

1.1 までの推奨案（「前回納品日時以降に `created_at` が付いた行を数える」）と、
代替案（`elith_delivery_items` と突き合わせる）は**どちらも採らない**。前者は
**artifact が後から更新された回を取り逃す**（`persistIntoExistingArtifact` は `created_at` を動かさない・
`special-additional-tests.ts:211-223`）し、後者は **`elith_deliveries` 経由の分が
`elith_delivery_items` に行を持たない**ので「納品済みなのに差分に出る」。

#### 14.3.1 snapshot に入れるもの / 入れないもの

| 入れる（**すべて非 PII**） | 入れない（**絶対に**） |
|---|---|
| `diagnostic_user_id`（非 PII） | 氏名・会社名・メールアドレス（マスクも含め**入れない**） |
| 納品時刻 / 納品先 prefix | 生年月日 |
| **検査種別ごとの件数と最新 `test_date`** | **測定値・検査結果の中身** |
| AI問診の有無と最新 `completed_at` | **問診の回答本文** |
| format_id ごとのファイル数と date フォルダの一覧 | S3 の中身・原本のファイル名 |
| ウェルネス年齢を載せた年数 | 算出に使ったマーカーの値 |
| **納品したファイル 1 件ごとの明細** — `format_id` / `delivered_date` / `destination_key` / 中身の **`sha256` fingerprint** | **JSON の中身そのもの**（指紋だけを控え、本文は入れない）・**原本のファイル名** |
| 実行した admin の**識別子 digest** | **生 email**（`@` を含む値は捨てる・`share-access.ts:283-292` と同じ規律） |

**snapshot は §9.6 の `putVerified` が `verified:true` を返したファイル**から作る。
**`getAccountProgress` の DB 件数から作らない** — §7.3.1 のとおり **DB 件数と実ファイル数は一致しないことがある**ので、
DB 件数で控えると**「書いたもの」を表さない記録**ができ、次回の差分がそのぶんずれる。

#### 14.3.1.1 なぜ集計値だけでは足りないか（ファイル明細を持つ理由）

**件数と最新 `test_date` だけでは「同じ日・同じ件数で、中身だけ変わった回」が差分に出ない。**
これは実際に起こり得る: `persistIntoExistingArtifact` は**既存 artifact の中身を更新して行を増やさない**
（`special-additional-tests.ts:211-223`。§14.3 冒頭で「`created_at` 方式を採らない」理由にしたのと同じ性質）。
**件数も `test_date` も動かないまま納品内容だけが変わる。**

→ **ファイル 1 件ごとの `sha256` fingerprint を控える。** 差分はこう判定する:

| 比較 | 差分の呼び方 |
|---|---|
| 今回の `plan` にあって前回 snapshot に無い `destination_key` | **追加** |
| 両方にあるが **`sha256` が違う** | **更新**（件数は増えていないが内容が変わった） |
| 前回 snapshot にあって今回の `plan` に無い | **「減った」とは出さない**（S3 の既存ファイルは消していないため・§16.2） |

- **`sha256` は中身の指紋であって中身ではない**（復元できない）ので、**PII を持たない**。
- `destination_key` は uid を含むが **uid は非 PII**（CLAUDE.md「PII / データ分離」）。
  氏名由来の文字列・原本のファイル名は**含めない**（§16.2 のキー規約に氏名が入らないことが前提・
  `additional-originals.ts` のキーは `sha256` で、`special_account_additional_tests_spec_20260930.md` の
  「原本キーに氏名・元ファイル名を入れない」と同じ規律）。

#### 14.3.2 いつ書くか

- **実際に 1 件以上 verified 納品できた run だけ**記録する（§9.6 の `putVerified` が verified:true を返した回）。
  **何も納品しなかった空振りで行を増やさない。**
- **対象は「スペシャルアカウントの手動納品 run」だけ**である
  （= この画面の［Elith納品］＝ §9 の 1 uid 手動納品 API）。
  **通常の cron（`api/cron/elith-deliver.ts`）の run snapshot までは広げない。**
  - 理由: cron は**契約者・単品を含む母集団を 1 起動でまとめて回す**（`elith-delivery.ts:450-457`）ので、
    run 単位の控えを全員分書くと、**この画面のための表が全ユーザーの納品ログになる。**
    今回の目的は「**この画面で前回との差分を出すこと**」だけなので、そこまで広げない。
  - **cron 側の記録は従来どおり `elith_deliveries` / `elith_delivery_items` のままで、1 行も変えない。**
  - 帰結として、**cron が納品した回は snapshot を持たない。** そのときは
    **「前回納品：YYYY/MM/DD（自動納品・内訳の控えなし）」**と出し、**0 件と偽らない**
    （§6.5 F-5 と同じ規律 =「引けなかった」を「無い」と混同しない）。
    **「前回納品」の日時そのものは `elith_deliveries` / `elith_delivery_items` から引ける**ので消えない（§14.2）。
  - 一覧の「前回納品後の追加」に使うのは、その uid の **最新の手動 run 1 件**である。
- **初回（snapshot が無い）回は差分を出さない。**「前回納品：なし」とだけ出す
  （0 件と「まだ無い」を混同しない）。

#### 14.3.3 差分の粒度

**検査種別ごとの件数差分**（現在の件数 − snapshot の件数）。確認モーダルの表示例は §7.3 のとおり。
date 単位の内訳は**行の詳細展開**でだけ出す（§6.3）。

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

### 16.1 DB — **migration を 1 本足す**（**D-4・確定**）

> **1.1 までの「migration は不要（0 本で足りる）」は撤回する。**
> §14.3 の snapshot を置く先が既存 2 表のどちらにも無いため。

#### 16.1.1 既存 2 表は意味を変えない

§14.2 のとおり `elith_deliveries`（年 × 納品先）と `elith_delivery_items`（検査 × format × 納品先）は
**役割も粒度もそのまま**。**統合しない。列も足さない。**

#### 16.1.2 新設する表（1 本）

`diagnosis.elith_delivery_runs` — **1 行 = 1 回の納品 run**。

**なぜ既存表に入れないか**: `elith_deliveries` の粒度は **(uid, bundle_date, delivery_prefix) = 年単位**だが、
1 回の手動納品は**複数年をまとめて**出す。run 単位の控えは年単位の表に収まらない。
`20260930000060_elith_delivery_items.sql:4-10` が `elith_deliveries` と `elith_delivery_items` を
分けたのと**同じ理由**（粒度が違うものを同じ表へ upsert すると、既にある情報を消す）。

| 列 | 中身 |
|---|---|
| `id` | uuid pk |
| `diagnostic_user_id` | uuid not null（`app_users` 参照） |
| `delivery_prefix` | text（`''` = 本番） |
| `delivered_at` | timestamptz |
| `triggered_by` | text — **admin 識別子の digest。生 email を入れない** |
| `source` | text — **`manual` 固定**。この表は**スペシャルの手動納品 run だけ**を記録する（§14.3.2）。将来 cron を足すときのための列であって、**今回 cron は 1 行も書かない** |
| `file_count` / `verified_count` | int — §9.6 の `putVerified` の結果 |
| `snapshot` | jsonb — **§14.3.1 の内訳 ＋ 納品したファイル 1 件ごとの明細**（`format_id` / `delivered_date` / `destination_key` / `sha256`）。**PII を 1 つも入れない** |

- **RLS は service_role 以外に権限を出さない**（新表の既定の規律・`20260930000060:15`）。
- migration 番号は **`20261001000010` 以降**（`…20260930000060` まで使用済み）。
- **`drop` も `alter` もしない。追加だけ。**
- **この表に cron の run を書かない**（§14.3.2）。**cron の履歴は既存 2 表のまま**で、何も変えない。
- `snapshot` は **`putVerified` の verified 結果**から作る（§14.3.1）。
  **`getAccountProgress` の DB 件数から作らない。**

#### 16.1.3 適用の順序

**後方互換な追加**（表を足すだけ）なので、**アプリより先に DB へ適用する**
（CLAUDE.md「migration / Edge Function」）。**適用前はアプリが snapshot を読めない** ので、
その間は **F-5 のとおり差分の副文言を出さない**（§6.5）。

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

### 16.3 中間 source は監査層として恒久的に残す（指示書 §13・**D-5・確定**）

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

**確定（D-5）= 中間 source を恒久的に監査層として残す。**
**「Admin 納品時に全部 DB から再生成する」案は採らない**（問診の回答本文と items 形式は S3 が唯一の保存先）。
**A の削除を自動化しない** — `elith-delivery-cleanup` は A を消す口（P-4）なので、
**スペシャルアカウントの運用手順に組み込まない。**

### 16.4 API

| API | 変更 |
|---|---|
| Scan-Chat-AI `GET /api/admin/special-accounts` | **返り値を拡張**（§6.4）。既存キーは消さない |
| Scan-Chat-AI `POST /api/admin/special-accounts/deliver` | **母集団からスペシャルを外す**（§18.2） |
| Scan-Chat-AI **（新）1 uid 指定の手動納品** | 新規。`isSpecialAccount` 必須・§10.2 の 2 条件 |
| Scan-Chat-AI `POST /api/admin/special-additional-tests/finalize` | **既定を「納品しない」へ**（D-3・§12.2）/ `health_checkup` を受ける / PUT は `putVerified` 経由へ（D-1） |
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
   **移設先は `/admin/elith-batch`（D-6・確定）。** あの画面は既に `elith-assemble` の単発納品と
   promote を持つ技術管理画面で、契約者向けの一括操作の置き場として筋が通る。
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

### 19.2 対象 UID の受け渡し — **`sessionStorage` 方式**（**D-2・確定**）

**現行実装では uid は URL に出ていない（確認済み）**

- `special-additional-tests.astro` は `<select>` の value を **POST body** で送る（`:65` / `:392-395`）。
- `share-links.astro` も `picked.uid` を **POST body** で送る（`:244-253`）。
- どちらも `searchParams` を読まない。

→ **現状は漏れていない。** 問題は「**対象をセット済みで遷移する手段が無い**」ことだけ。

C-2 のとおり**再利用できる既存機構が無い**ので 3 案を比較し、**案 2（`sessionStorage`）で確定した**。

| 案 | 方式 | URL / 履歴 / Referer | サーバ変更 | 評価 |
|---|---|---|---|---|
| **案 1** | 遷移先を**別画面にしない**。一覧の行から**その場でパネルを開く**（`<details>` / モーダル）。対象は**既にその行の DOM にある値**をそのまま POST | **何も載らない** | **ゼロ**（新テーブル・新 API なし） | 「新方式を増やさない」に最も忠実。admin 画面で uid を表示することは既に許容されている（`share-links.astro:231-232`） |
| **案 2（採用）** | `sessionStorage` の 1 キー（例 `welltect.admin.target`）に uid を置いて遷移。遷移先が読んで `<select>` を選択済みにする | 載らない（タブ単位・閉じれば消える） | ゼロ | 画面を分ける指示書 §6 の形に沿う。新しい受け渡し規約が 1 つ増えるが、**サーバ側の新機構はゼロ** |
| 案 3 | wellfort-site 側に short-lived handoff（opaque token → サーバで uid へ解決）を新設 | 載るのは opaque token だけ | **新テーブル + 新 API**（`admin-impersonation.ts` と同形を 2 本目として作る） | 指示書 §6 の「既存パターン」に最も近い見た目だが、**実体は新機構**。コストが大きい |

**採らない案**: メールの sha256（`e.hash`・`special-accounts.astro:303` で既に使われている）を URL に載せる。
uid は非 PII だが**メールの digest は PII 由来で、かつメールは推測可能なので総当たりが効く**。
**uid より悪い**ので候補にしない。

#### 19.2.1 採用した案 2 の約束

- キーは **1 本だけ**（`welltect.admin.target`）。**用途ごとに増やさない。**
- 置く値は **uid 1 つだけ**。氏名・メール・メールの digest は**置かない**。
- **読んだら消す**（`sessionStorage.removeItem`）。遷移先に残したまま別の対象を開くと**取り違える**。
- **`sessionStorage` はタブ単位**なので、別タブで開いた一覧の選択が混ざらない。
  タブを閉じれば消える。**`localStorage` を使わない**（端末に残る）。
- **無い / 壊れている / UUID でない**ときは**何もセットせず通常の `<select>` を出す**。
  当てずっぽうで 1 件目を選ばない。
- **URL・履歴・Referer には何も載らない。**

**採用後も守ること**: 遷移先のサーバ API は**渡された uid を信用せず `isSpecialAccount(uid)` を再確認する**
（§19.1・`special-additional-tests.ts:109-121`）。
**受け渡しは「探す手間を省く」ためのものであって、認可の根拠にしない。**

### 19.3 検索・フィルタ（**D-8・確定**）

指示書 §16 の「氏名 / 会社名 / UID 検索」は、**F-1 のとおり氏名・会社名を持っていない**ので成立しない。

**確定した範囲（これ以上は作らない）**

| 作る | 作らない |
|---|---|
| **メモ（案件名）/ メールマスク / UID** の**部分一致 1 本** | 氏名・会社名での検索 |
| **状態**（未準備 / 準備あり / 納品済み）での絞り込み | データ有無・登録日順などの多段フィルタ |
| — | ページネーション（F-7） |

- UID の検索は**先頭一致でも部分一致でもよい**が、**入力は完全 UUID でなくてよい**（短縮表示から探せること）。
- **検索はクライアント側で足りる**（一覧は 1 回の GET で全件取れている）。
  **検索のためにサーバ API を増やさない。**
- 検索語を**ログにも URL にも残さない**（メモには案件名が入る）。

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

### K. Verified PUT と run snapshot（D-1 / D-4 / D-7）

| # | 検査 |
|---|---|
| 37 | `putVerified` が **読み戻して SHA256 が一致したときだけ** `verified:true` を返す |
| 38 | 納品先に**同一内容が既に在れば PUT しない**（PUT 回数で見る） |
| 39 | **一部が `verified:false` の年を `elith_deliveries` へ delivered として記録しない** |
| 40 | `putVerified` は**投げない**（失敗は戻り値で返る） |
| 41 | **snapshot に PII が 1 つも入らない** — 氏名・会社名・メール・マスク・生年月日・測定値・回答本文・原本ファイル名のいずれも現れない（**V-3**） |
| 42 | `triggered_by` に **`@` を含む値が入らない**（生 email を弾く） |
| 43 | **1 件も verified 納品できなかった run は snapshot 行を作らない** |
| 44 | snapshot が無い uid では**差分の副文言を出さない**（初回は「前回納品：なし」） |
| 45 | 差分が **「前回 snapshot のファイル明細」と「今回の `plan`」の突合**から出ている（`getAccountProgress` の DB 件数で作っていない） |
| 46 | **確認モーダルを開いただけでは Elith 本番受取領域（`deliveryPrefix` 配下 = `user/…`）へ PUT しない**（中間 source とウェルネス年齢は更新され得る・§7.3.1 P0-1・**V-4**） |
| 47 | **モーダルの件数が `plan` の件数**であり、**DB 件数と食い違う回は警告が出る**（黙って片方を採らない・§7.3.1） |
| 48 | **確定後に assemble を作り直さず、確認した `plan` をそのまま `putVerified` に渡す** |
| 49 | **同日・同件数で中身だけ変わった回が「更新」として差分に出る**（`sha256` 比較が効いている・§14.3.1.1） |
| 50 | **`elith_delivery_runs` に cron の run が入らない**（`source` が `manual` 以外の行を作らない・§14.3.2） |
| 51 | `putVerified` の追加 GET が **新規 / 変更ファイルで 2 回・既存同一で 1 回**（PUT 0 回）である（§9.6.1） |

---

## 24. 退行テスト（指示書 §24）

**この家の規律として、退行を注入して「名指しで落ちる」ことを確認する。最低 16 種。**

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
| 9 | `putVerified` の**読み戻しを省いて PUT の成否だけ**にする | K-37 |
| 10 | snapshot に**氏名 / メール / 測定値のどれか 1 つ**を混ぜる | K-41（V-3） |
| 11 | `triggered_by` に**生 email** を入れる | K-42 |
| 12 | `sessionStorage` の代わりに **`localStorage`** を使う（端末に残る） | C-14 と同系（新設） |
| 13 | 確認モーダルの件数を **`getAccountProgress` の DB 件数**に戻す | K-47 |
| 14 | **確定後に assemble を作り直して** `putVerified` へ渡す | K-48 |
| 15 | snapshot から **ファイル明細（`sha256`）を落として集計値だけ**にする | K-49 |
| 16 | **cron 経路にも `elith_delivery_runs` への記録を足す** | K-50 |

**16 種とも落ちることを確認してから実装完了とする。**

あわせて **§18.1 の既存 `verify:*` を全部通す**こと（特に `verify:elith-entitlement` /
`verify:special-accounts` / `verify:special-additional-tests` / `verify:share-access` /
`verify:admin-handoff` / `verify:scan-persist` / `verify:demo-gate` / `verify:single-purchase`）。

---

## 25. 未確定事項 / Elith 確認事項（指示書 §19 / §20 / §25）

### 25.1 裁定済み（2026-10-01・発注者確定）

**発注者裁定事項 U-1〜U-8 は全て確定した。** 内容は下表の **D-1〜D-8** で、本文の該当節が正本である。
**実装はここに書かれた形から外れてはならない。**

**ただし「未確認が無くなった」わけではない。** 次の 2 系統は**未確認のまま残っている**ので、
**確定事項として扱わないこと**（1.2 の「未確定事項として残っているものは無い」は**この点で誤り**だったので撤回する）:

| 系統 | 中身 | どこ |
|---|---|---|
| **E-1〜E-6** | **Elith 側の挙動**（再診断の発火条件・上書きの扱い・複数年の入力範囲・manifest 等）。**Wellfort リポジトリでは裏取りできない**（R3） | **§25.2** |
| **V-1〜V-4** | 確定した方式を実装するときに**実測で確かめる**こと（cron の所要時間 / migration の適用順 / snapshot の非 PII 性 / `plan` が S3 を変更しないこと） | **§25.1.1** |

| # | 旧 | 確定した仕様 | 正本 |
|---|---|---|---|
| **D-1** | U-1 | **共通 Verified PUT/readback helper（`putVerified`）に一本化する。** A と B の**両方がそれを呼ぶ**。**「A の後に `deliverAdditionalJson` を回す」ではない**（PUT とキー変換が二重に走るため・1.1 の推奨案から**変更**） | §9.6 |
| **D-2** | U-2 | 対象 uid の受け渡しは **`sessionStorage` の 1 キー**。読んだら消す。URL・履歴・Referer に載せない。**サーバ側の新機構はゼロ** | §19.2 |
| **D-3** | U-3 | `finalize` の**サーバ側の既定を「納品しない」へ反転**する。`deliver: true` を明示したときだけ本番へ出す | §12.2 |
| **D-4** | U-4 | **migration を 1 本足す**（`diagnosis.elith_delivery_runs`）。**1.1 の「0 本で足りる」は撤回**。既存 2 表は意味も列も変えない | §16.1 |
| **D-5** | U-5 | **中間 source を恒久的に監査層として残す。** 「納品時に全部 DB から再生成」は採らない。削除を自動化しない | §16.3 |
| **D-6** | U-6 | ［Elith納品を一括作成］の移設先は **`/admin/elith-batch`**（廃止はしない・契約者用として残す） | §18.2 |
| **D-7** | U-7 | 差分は **前回 run の PII なし snapshot と現在を比べる**。粒度は**検査種別ごとの件数差分**。snapshot が無い回は差分を出さない | §14.3 |
| **D-8** | U-8 | 検索は **メモ / メールマスク / UID の部分一致 1 本 ＋ 状態フィルタ**まで。氏名・会社名での検索は作らない | §19.3 |

**画面案の補正事項（F-1〜F-8 / G-1〜G-7）も確定事項**である（§6.5 / §13.4）。

### 25.1.1 確定に伴って増えた実装上の宿題（未確定ではない・確認事項）

| # | 確認すること | いつ |
|---|---|---|
| V-1 | `putVerified` の追加 GET は **1 ファイルにつき最大 2 回**（事前比較 ＋ readback）。**最悪ケース = 全ファイルが新規 / 変更**（1 ファイルあたり GET 2 回 ＋ PUT 1 回）で、**複数年 × 複数 format の cron が `maxDuration: 800` に収まるか**を実測する。**既存同一の 1 回で見積らない** | §27 P6 |
| V-2 | `elith_delivery_runs` の migration を**アプリより先に適用**する。適用前は差分の副文言を出さない（F-5） | §27 P8 の前 |
| V-3 | snapshot の中身に **PII が 1 つも入っていないこと**を検査で固定する（目視では守れない） | §23 に追加 |
| V-4 | 確認モーダルの `plan`（assemble 実走）が **Elith 本番受取領域へ PUT しないこと**を検査で固定する（§7.3.1 P0-1 / K-46）。**中間 source とウェルネス年齢は更新され得る**（在ってよい副作用） | §27 P6 |

**実装時点の状況（2026-10-01）**

| # | 状況 |
|---|---|
| **V-1** | **スタブで実測し、1 ファイルあたり GET 2 回・PUT 1 回（最悪ケース）であることを検査で固定した**（K-51）。**本番の所要時間はまだ測っていない** — 鍵も S3 もこの環境に無いため。`maxDuration: 800` に収まるかの実測は**残っている** |
| **V-2** | migration は作成済み（`20261001000010`）。**適用は発注者の操作**。未適用でも画面は成立し、差分の副文言を出さない形にしてある（K-44） |
| **V-3** | **固定済み**（K-41。氏名・メール・生年月日・測定値・原本ファイル名を混ぜても落ちる） |
| **V-4** | **固定済み**（K-46。preview で本番キーが 0 件であることを実測） |

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
| `src/lib/elith-delivery.ts` | modify | 母集団からスペシャル除外（§18.2）/ 1 uid 手動納品（§9）/ `manualMapping` を 7 種へ（§9.2）/ `putFiles` → `putVerified`（D-1）/ run snapshot の記録（D-7） |
| `src/lib/elith-entitlement.ts` | modify | **`decideReady()` は触らない。** スペシャル用の別述語（`hasAnyDeliverable`）を足す（§10.3） |
| `src/lib/special-additional-tests.ts` | modify | `health_checkup` を対象に足す（§11） |
| `src/lib/additional-originals.ts` | modify | `ADDITIONAL_TEST_TYPES` に `health_checkup`（§11.2） |
| `src/pages/api/admin/special-accounts.ts` | modify | 拡張した progress を返す |
| `src/pages/api/admin/special-accounts/deliver.ts` | modify | スペシャル除外に追従 |
| `src/pages/api/admin/special-accounts/deliver-one.ts`（仮） | create | 1 uid 手動納品（§9） |
| `src/pages/api/admin/special-additional-tests/finalize.ts` | modify | 既定を「納品しない」へ（D-3）/ `health_checkup` |
| `src/pages/api/admin/special-additional-tests/scan-part.ts` | modify | `health_checkup` を受ける |
| `src/pages/api/cron/elith-deliver.ts` | modify | **削除しない。** 母集団の変更に追従するだけ |
| `src/lib/elith-put-verified.ts`（仮） | create | **共通 Verified PUT/readback helper**（D-1・§9.6） |
| `supabase/migrations/20261001000010_elith_delivery_runs.sql`（仮） | create | **run の PII なし snapshot**（D-4・§16.1.2） |
| `scripts/verify-special-account-management.mjs` | create | §23 / §24 |
| `package.json` | modify | `verify:special-account-management` |
| `docs/specs/special_account_management_spec_20261001.md` | （本書） | — |

**触らない**: `elith-assemble.ts`（`SERIES_FORMATS` / `sanitizeDelivery` / `rewriteClientId` を共用するだけ）/
`elith-assemble.ts` 以外では、`elith-delivery-json.ts` は**自前の PUT・readback を `putVerified` へ寄せる**（D-1）/ `share-access.ts` / `admin-impersonation.ts` /
`middleware.ts` / `write-guard.ts` / `scan-persist.ts` / `interview/export.ts` / `api/scan/save.ts` /
`src/lib/s3.ts` の `putFiles` 本体（**`putVerified` を上に重ねるだけ**・D-1）。

### 26.2 wellfort-site

| ファイル | 操作 | 内容 |
|---|---|---|
| `src/pages/admin/special-accounts.astro` | modify | 一覧の全面整理（§6）/ 行ごと 3 ボタン（§7）/ 確認モーダル（§7.3）/ 一括ボタンの撤去（§18.2） |
| `src/pages/admin/special-additional-tests.astro` | modify | 対象セット済みで開く（§7.1）/ 文言を「登録」へ（§12.1）/ `health_checkup` を選択肢に |
| `src/pages/admin/share-links.astro` | modify | 外から対象を受け取る経路（§13.3）。**共有基盤は 1 行も触らない** |
| `src/pages/api/admin/special-accounts/deliver-one.ts`（仮） | create | 中継（2 層認証は既存と同形） |
| `src/pages/api/admin/special-additional-tests/[action].ts` | modify | `finalize` の既定変更に追従 |
| `src/pages/admin/elith-batch.astro` | modify | 一括納品ボタンの移設先（D-6） |

**触らない**: `AdminLayout.astro`（メニューは既に 3 本とも在る・`:45` / `:51` / `:56`）/
`api/admin/share-links.ts`（中継の形を変えない）/ `api/admin/impersonation-handoff.ts`。

---

## 27. 実装順序（指示書 §27）

**各段のあいだで検証を通す。1 段ごとに rollback できる形で切る。**

| 段 | 内容 | 受入 |
|---|---|---|
| **P0** | **裁定は済んでいる**（D-1〜D-8・§25.1）。着手前に §25.1 と §6.5 / §13.4 を読み、**そこから外れないことを確認する**だけ | — |
| **P1** | **cron からスペシャルを除外**（§17）。**これだけで「人の確認前に本番へ出る」が止まる**ので最初に入れる | `verify:elith-entitlement` に A-1〜A-5 → 退行注入 1・2 で落ちる |
| **P2** | **`finalize` の既定反転**（§12.2）＋ UI 文言（§12.1）。**登録とその場納品の一体化を切る** | D-16〜D-19 → 退行注入 4 で落ちる |
| **P3** | **一覧の集計拡張**（§6.4）。API の返り値を広げるだけで UI はまだ変えない | I-33〜I-36 |
| **P4** | **一覧 UI の整理**（§6）＋ 状態 badge（§8）＋ 3 ボタンの枠（押すとまだ何もしない） | 目視 + 既存 `verify:screen` を壊さない |
| **P5** | **［追加検査データ］導線**（§7.1）＋ **［共有URL設定］導線**（§13）。**`sessionStorage`（D-2）**。**placeholder の一般化（G-7）を同梱** | C-14 / C-15 → 退行注入 8 で落ちる |
| **P6** | **共通 `putVerified`（D-1）**で A・B を寄せる → **1 uid 手動納品 API**（§9）＋ 確認モーダル（§7.3）。**7 種全部・複数年** | E-20〜E-23 / F-24 / F-25 / **K-46〜K-48・K-51** → 退行注入 5・6・13・14 / **V-1（最悪ケースで cron が 800s に収まるか）と V-4（`plan` が本番受取領域へ書かない）を実測** |
| **P7** | **検診・人間ドックの Admin 登録**（§11）。**重複 artifact を作らないことが受入条件** | G-26〜G-29 → 退行注入 7 で落ちる |
| **P8** | **migration を先に適用（V-2）** → run snapshot と前回差分（D-7・§14.3）＋ **一括ボタンの移設**（D-6）＋ 検索（D-8・§19.3） | H-30〜H-32 / **K-49・K-50** → 退行注入 15・16 / **V-3（snapshot に PII が無い）** |

**P1 と P2 を先に入れる理由**: どちらも「意図しない本番納品を止める」側の変更で、
**機能追加を待たずに単独で価値がある**。逆に P6（手動納品）を先に入れると、
**cron と手動の両方が動く期間**ができて二重納品の窓が開く。

### 27.1 実装の地図（**P1〜P8 実装済み・2026-10-01**）

| 段 | Scan-Chat-AI | wellfort-site |
|---|---|---|
| P1 | `elith-entitlement.ts` `buildDeliveryPopulation()` ／ `elith-delivery.ts` の母集団 | — |
| P2 | `api/admin/special-additional-tests/finalize.ts`（既定反転） | `admin/special-additional-tests.astro`（「② 登録」） |
| P3 | `account-progress.ts`（5 種 ＋ `elith_delivery_items`） | — |
| P4 | — | `admin/special-accounts.astro`（1 行 1 アカウント・badge・3 ボタン） |
| P5 | — | **`public/admin/admin-target.js`**（受け渡し）／ `share-links.astro`（G-7） |
| P6 | **`s3-verified-put.ts`** ／ **`elith-manual-delivery.ts`** ／ `api/admin/special-accounts/deliver-one.ts` | `api/admin/special-accounts/deliver-one.ts`（中継）／ 確認モーダル |
| P7 | `additional-originals.ts`（`health_checkup` 追加）／ `special-additional-tests.ts`（暦日検証） | `special-additional-tests.astro`（5 択） |
| P8 | **`20261001000010_elith_delivery_runs.sql`** ／ **`elith-delivery-runs.ts`** | 一括ボタンを `elith-batch.astro` へ移設 ／ 検索 ／ 差分表示 |

**検証**: `npm run verify:special-account-management`（147 件・CI の A 層）／
wellfort-site は `verify:special-accounts-ui`（50 件）と `verify:admin-target`（34 件）。
**退行注入は 16 種とも名指しで落ちることを確認済み。**

#### 27.1.1 実装して分かったこと（仕様の補正）

| # | 事 | どうしたか |
|---|---|---|
| **A-1** | **納品 JSON は呼ばれるたびに作り直され、`exported_at` と `diagnostic_id` が毎回変わる。** そのまま指紋を取ると、何も変わっていなくても毎回不一致になり **確認モーダルが構造的に通らない** | 指紋から**この 2 つだけ**を外す（`stableBody()`）。**データは 1 つも外さない** |
| **A-2** | HTTP は 2 往復なので plan をサーバに持ち越せない。§7.3.1 の「確定後に assemble を作り直さない」を字義どおりには実装できない | **2 回目も組み直し、指紋が一致したときだけ書く**。違えば 409 と新しい plan（**クライアントから plan の中身を送り返させない**＝中身を信用しない） |
| **A-3** | 上の帰結として、検診・ウェルネス年齢は**毎回内容が変わる**ので `putVerified` の「既存同一なら PUT しない」は効かない | **V-1 の見積りは最悪ケース（GET 2・PUT 1）で正しい**。検査で実測して固定した |
| **A-4** | 受診日が `2025-13-45` のような**形は通るが実在しない日付**を素通ししていた | `isRealDate()`（暦日の往復）で弾く。Postgres の `date` 列が拒否して `save_failed` という分かりにくい形で落ちるのと、`date/2025_13_45/` という在りえないフォルダを防ぐ |
| **A-5** | `account-progress` の 4 本の問い合わせを `Promise.all` でまとめていたので、**`elith_delivery_runs` / `elith_delivery_items` が未作成の環境で全部 0 件**になり得た | 問い合わせごとに fail-safe。**1 本引けなくても他を道連れにしない** |
| **A-6** | 退行注入 2（除外を和の前に置く）と 16（cron にも run を記録）は、**素の検査では落ちなかった** | 2 は「緊急停止したスペシャルが契約者としても引ける」ケースを、16 は「cron 経路から呼んでいないこと」を直接見る検査を足した |

#### 27.1.2 実装レビューで出た是正（**P0-1〜P0-4 ＋ Hardening 2 件・2026-10-01**）

発注者が P1〜P8 のコードを読んで出した指摘。**4 件は blocker**で、いずれも
「仕様の意図は正しいが実装がその通りになっていない」もの。**実コードで裏取りしてから直した。**

| # | 指摘 | 実コードの裏取り | どう直したか |
|---|---|---|---|
| **P0-1** | delivery preview は read-only ではない。「S3 へ 1 バイトも書かない」は事実と違う | `elith-manual-delivery.ts` `materializeHealthCheckups()` → **`elith-delivery.ts:231` `putFiles()`**（中間 source へ PUT）/ `computeWellnessFromMeasurements()` → **`elith-delivery.ts:288` `upsert()`**（`health_age_scores`）。**指摘どおり** | **要件（確認前に本番受取領域へ書かない）は満たしているので挙動は変えない。** 大規模な in-memory 化はしない（発注者判断）。**仕様書 §7.3.1・コードコメント・API の `note`・モーダルの文言を実装に合わせた**。K-46 も「preview では本番 `user/` へ PUT しない」を見る形へ |
| **P0-2** | run snapshot の差分 SHA が volatile metadata を含む。`PlannedFile.sha256` は raw body SHA で、`planFingerprint()` だけが `stableBody()` を使っていた | `elith-manual-delivery.ts:172`（当時）。**指摘どおり** — このままだと `exported_at` / `diagnostic_id` が毎回変わり、**内容が同じでも次回必ず「更新」**になる | `PlannedFile` を **`contentSha256`（`stableBody()` の SHA）と `deliverySha256`（実 body の SHA）へ分離**。**preview→confirm の指紋と run 差分は `contentSha256`** / `putVerified` の読戻し検証は実 body。snapshot は**両方**を持つ（`delivery_sha256` は監査用）。`planFingerprint()` は `contentSha256` を**そのまま使う**（2 か所で別々に計算しない）。**退行検査「同じ実データから 2 回 plan を組んでも `diff.updated=0`」を必須で追加** |
| **P0-3** | 原本 conflict 判定が DB mutation の後。別 PDF で **原本 A / ダッシュボード値 B** の不整合が起こり得る | `finalize.ts:174` `saveAdditionalArtifact()` → `:192` `linkAdditionalOriginal()`。**指摘どおり** — 409 で止めても DB は戻らない | **`preflightAdditionalOriginal()` を新設**（read しかしない）。S3 原本を読んだ直後・**DB mutation の前**に既存 artifact の `raw_pdf` SHA 衝突を見る。衝突なら 409 で停止し、`scan_md` / `measurements` / `measurement_values` / `test_artifact_files` が**すべて unchanged** であることを検査で固定（既存 E22 は原本しか見ていなかった） |
| **P0-4** | `special-additional-tests.ts:167` の `.order('created_at', …)`。repo schema に `created_at` は無い | `20260601000010:203` は **`imported_at`**。`test_artifacts` の定義に `created_at` は**無い**。**指摘どおり** | **`.order()` 自体を削除**。0 / 1 / 2 件以上の判定に順序は要らない。**本番 DB に偶然その列が在ることを前提にしない** |
| **H-1** | `safeTriggeredBy()` が「`@` が無い」で通していた | `elith-delivery-runs.ts`。`@` を弾くのは**生 email を弾く条件であって PII を弾く条件ではない**（氏名・社員番号・`admin%40example.com` は素通り） | **`/^[0-9a-f]{64}$/i` の digest だけ受ける**（allow-list）。それ以外は `null`。控えは 10 年残る |
| **H-2** | 実在暦日の検証が保存の段にしか無く、`2026-02-31` で**原本だけ S3 へ上がる孤児ファイル**が作れた | 署名の段（`createAdditionalOriginalTicket`）は形式だけの `DATE_RE`。原本バケットは**削除不可** | **`isRealDate()` を `additional-originals.ts` の 1 か所へ集約**し、`buildAdditionalOriginalKey` / `createAdditionalOriginalTicket` / `resolveAdditionalArtifact` / `saveAdditionalArtifact` / `finalize.ts` がすべてこれを使う。**複製を置かない**（段ごとに判定が食い違うと孤児が出る） |

**この是正では設計を 1 つも変えていない。** P0-1 は文言、P0-2 は指紋の取り方、
P0-3 は順序、P0-4 は不要な句の削除、H-1/H-2 は入力の絞り込み。

---

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
| 1.1 | 2026-10-01 | 承認画面案（ChatGPT 作成）を実コードと突き合わせ、**§6.5（F-1〜F-8）と §13.4（G-1〜G-6）を追加**。画像だけを見て存在しない機能を実装させないための禁止事項。あわせて **§6.5.1 で 1.0 の誤り（「ダッシュボードも admin に無い」）を訂正**。**設計は 1 つも変えていない。実装は 1 行もしていない。** |
| 1.2 | 2026-10-01 | **発注者裁定により U-1〜U-8 を確定**し、§25.1 の未確定表を**確定仕様（D-1〜D-8）へ移した**。うち 3 件は推奨案からの**変更**: **U-1 = 共通 Verified PUT/readback helper 方式**（「A の後に B を回す」ではない）/ **U-4・U-7 = 前回 run の PII なし snapshot との差分比較**（そのため **migration が 1 本要る**。1.1 までの「0 本で足りる」は撤回）。あわせて **§13.4.1 の placeholder 一般化を「候補」から今回の必須文言変更へ格上げ**、**F-1 の表現を厳密化**。**実装は 1 行もしていない。** |
| 1.3 | 2026-10-01 | 実装着手前の精査で **4 点 ＋ 1 点を修正**。① `putVerified` の追加 GET は **新規 / 変更で最大 2 回**（事前比較＋readback）・既存同一なら 1 回と明記し、**V-1 を最悪ケースで測る**ことにした（§9.6.1 / §9.6.2 a / §25.1.1）。② run snapshot に**集計値だけでなく納品ファイル 1 件ごとの明細**（`format_id` / `delivered_date` / `destination_key` / `sha256`）を持たせ、**同日・同件数で中身だけ変わった回を「更新」として検知**できるようにした（§14.3.1 / §14.3.1.1 / §16.1.2）。③ **確認モーダルの正本を `getAccountProgress` の DB 件数から「実際の assemble 結果（delivery preview = `plan`）」へ変更**し、**DB 件数と不一致なら警告**・**確定後は同じ `plan` を `putVerified`**・**snapshot は verified 結果から**とした（§7.3.1）。④ **「未確定事項は 1 件も残っていない」を撤回**し、「**発注者裁定事項 U-1〜U-8 は全て確定**」に修め、**E-1〜E-6 / V-1〜V-4 は未確認として明示**した（§25.1）。あわせて **`elith_delivery_runs` の対象を「スペシャルの手動納品 run」だけに限定**し、**通常 cron の run snapshot へは広げない**ことを確定した（§14.3.2 / §16.1.2）。検査は **K-45 を改め K-46〜K-51 を追加**、退行注入を **12 → 16 種**へ。**実装は 1 行もしていない。** |
| 2.0 | 2026-10-01 | **P1〜P8 を実装した**（§27 の段取りどおり・1 段 1 コミット）。仕様は変えていない — 足したのは **§27.1 実装の地図**と **§27.1.1「実装して分かったこと」**、および §25.1.1 の V-1〜V-4 の実測結果。実装で補正したのは 6 点で、いずれも仕様の意図を保つための具体化: ①納品 JSON の `exported_at` / `diagnostic_id` が毎回変わるので指紋から外す ②HTTP 2 往復では plan を持ち越せないので「指紋が一致したときだけ書く」形にする ③その帰結として `putVerified` の冪等は検診・ウェルネス年齢には効かない（V-1 は最悪ケースで正しい）④実在しない暦日を弾く ⑤`account-progress` を問い合わせごとに fail-safe にする ⑥退行注入 2 と 16 が素の検査では落ちなかったので検査を足した。**未確認として残っているのは V-1 の本番実測（鍵も S3 もこの環境に無い）と E-1〜E-6（Elith 確認事項）。** |
| 2.1 | 2026-10-01 | **実装レビューの是正**（§27.1.2）。発注者がコードを読んで出した **blocker 4 件 ＋ hardening 2 件**。**P0-1** delivery preview は read-only ではなかった（`elith-delivery.ts:231` が中間 source へ PUT・`:288` が `health_age_scores` を upsert）→ **挙動は変えず**、仕様書 §7.3.1・コード・UI・K-46 の文言を実装へ合わせた。**P0-2** `PlannedFile` を `contentSha256` / `deliverySha256` へ分離し、**差分判定は生成メタを除いた指紋**にした（従来は実 body の SHA なので内容が同じでも毎回「更新」になった）。**P0-3** 原本 SHA 衝突の判定を **DB mutation の前**へ（`preflightAdditionalOriginal()` 新設）。**P0-4** `.order('created_at')` を削除（schema は `imported_at`）。**H-1** `safeTriggeredBy()` を digest allow-list へ。**H-2** 実在暦日の検証を `additional-originals.ts` 1 か所へ集約し、署名の段にも適用した。**設計は 1 つも変えていない。** |
