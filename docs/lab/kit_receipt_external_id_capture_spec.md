# 受取時・外部検査ID 撮影／登録 仕様書

| 項目 | 内容 |
|---|---|
| 目的 | 外部検査キットをユーザーが**受け取った時点**で、検査会社がキットに付与した外部IDをスマホで撮影・読取し、Wellfort 内部の「今回の検査」へ**安全かつ一意に**紐づける。物理検体・問診データ・検査結果を、推測ではなく**機械的なキー**で同一検査へ戻せる状態を作る。 |
| 版 | **v1.1（2026-10-11・実装済み／既定 off）**。v1.0 = 発注者裁定 **D-1=案A（登録時に `lab_tests` 行を作る）** / **D-4=サーバ側 Gemini**。**v1.1 = 実装レビューの是正 2 点**（発注者指示 2026-10-11）: **①`lab_tests` を「人 + 検査種別で 1 件だから」という理由で使い回さない**（前年の外部IDを上書きし得た＝§3.2.1） **②プリベント問診CSV のゲートを `confirmed` ∧ `linked` ∧ `lab_test_id` 非 null の 3 条件へ**（§7.1）。**migration の構造は変えていない**（additive のまま）。**app_config の `labid.*_capture` は既定 off のまま** なので、実物の書面とバーコード規格を確認するまで誰にも出ない（§9）。 |
| 上位文書 | **`docs/lab/lab_data_pipeline_master_spec.md` §4-5（v2.1・4検査横断の正本）**。本書はその §4-5.7 の詳細。矛盾したら上位が勝つ。 |
| 対象 | **P0＝① がんリスク（プリベント / ALA-PDS）のバーコードNo.** ／ **P1＝② 血液（リージャー / デメカル）の 15桁「問合せ番号」（Secondary）** |
| 対象外 | **④ 遺伝子（Genoplan）**。正本は**タカセ返送CSV 方式**（上位 §4-5.6）。**ユーザー撮影方式へ置き換えない。** |
| 関連 | `docs/lab/lab_data_reception_overview.md §2`（プリベント受取方式）・`§5`（ID 連携の実務断面）／`docs/lab/questionnaire_to_lab_csv_spec.md §4.2`（プリベント上り33項目）／`docs/lab/demecal_unattended_spec.md`（血液の正本）／`docs/architecture/id_management_and_correlation_spec.md`（ID 体系）／`docs/lab/kit_progress_management.md`（キット進捗・受取確認） |

> ## 実装の地図（v1.0・2026-10-11）
>
> | ファイル | 役割 |
> |---|---|
> | `src/lib/external-test-id.ts` | **純関数**。正規化 / 構造ガード / 期待パターン / 採否判定 / 問診CSV ゲート |
> | `src/lib/external-id-evidence.ts` | 証跡画像の presigned PUT と読み出し（`scan-upload-ticket.ts` の形を流用） |
> | `src/lib/external-id-read.ts` | **サーバ側 Gemini** で読む（候補だけ返す・確定しない） |
> | `src/lib/external-id-persist.ts` | 台帳への記録 ＋ **案A** の `lab_tests` 紐付け |
> | `src/pages/api/kit/[id]/external-id.ts` | `mode: ticket / read / register`（認可は `self-report.ts` の 3 段ガードを流用） |
> | `src/components/dashboard/ExternalIdCapture.astro` ／ `src/scripts/external-id-capture.ts` | 画面と処理 |
> | `supabase/migrations/20261011000010_lab_test_id_captures.sql` | 撮影台帳（**service_role だけ**・ポリシー 0 件） |
> | `scripts/verify-external-id-capture.mjs` | `npm run verify:external-id-capture`（**257 件**・CI の A 層。⑭ が年跨ぎの回帰①〜⑤） |
>
> **§3.2 のブロッカーは「案A ＋ 紐付け失敗を deferred で残す」で解いた**（§3.2 の末尾）。
> **実装の前提と残っている未確認は §9 と §12。**

---

## 1. 設計原則（厳守）

1. **Wellfort 内部の主キーは `lab_tests.id` を維持する。** 外部検査会社のIDを内部主キーへ置き換えない。
2. 外部IDは **`external_test_id` / `external_barcode` 等の相関キー**として保持する（上位 §4-5.1）。
3. **0 件・複数件・重複・不一致は自動確定しない。** `review_required` に落として人が見る。
4. 撮影画像は**証跡**として扱い、**公開URLに置かない**。
5. **ユーザーが所有する検査以外へ外部IDを登録できないこと**（サーバ側で再検証）。
6. **既存スキーマ・既存API・既存RLS を調査し、再利用できるものを優先する。**
   新規テーブル／列は**必要性を示してから**追加する。
7. **読取値はユーザーの確認操作を経てから確定する。** 自動で登録しない。
8. **仕様に無い外部IDを推測で作らない。** 桁数・prefix は実物で確定するまでコードに固定しない（§5.1）。

---

## 2. 取得対象（実物の仕様）

### 2.1 ① プリベント（P0）

| 項目 | 内容 |
|---|---|
| 先方名称 | **バーコードNo.** |
| 表示例 | `704000xxx` |
| 物理 | 検体に貼付される **1次元バーコード**と、その近傍に印字された「**ユーザーID**」 |
| 紐づけ先 | 対象の `lab_tests.id` |
| 下流 | **プリベント向け問診CSV を生成する前に、このIDが確定していること**（§7 ゲート） |

**【UI の確定事項】QR コードを撮影対象にしない。**
同梱書面には QR コードも印字されているが、**こちらが要るのは 1次元バーコードと「ユーザーID」の印字**である。
ガイドでユーザーに QR を撮影対象と誤認させると、**読めない画像が集まり続ける**（ユーザーは「撮れた」と思っている）。

### 2.2 ② デメカル（P1・Secondary）

| 項目 | 内容 |
|---|---|
| 対象書面 | 同梱の「検査申し込み用紙（返送用）」 |
| 取得対象 | **15桁の「問合せ番号」** |
| 位置 | 用紙上部 |
| 役割 | **Secondary**。Primary は「結果CSV の 氏名 ＋ 生年月日」照合（上位 §4-5.4） |

**ハードゲートをかけない。** プリベントと違い、撮影未完了だけを理由に AI問診をブロックしない（§7.2）。

### 2.3 `704000xxx` と 15桁番号は**まだ確定仕様ではない**（未確認）

| 項目 | 状態 | 根拠 |
|---|---|---|
| プリベントのバーコード形式 | **未確認**。`704000` の文字列は両リポジトリに **0 件**（実測 grep。実装・サンプル画像・fixture いずれも無し） | 実測 |
| → 確定が要るもの | **総桁数 / prefix の固定範囲 / チェックディジットの有無 / 1次元バーコードの規格（CODE39・CODE128・ITF 等）** | — |
| デメカル 15桁 と DSS `指図番号` の同一性 | **未確認。同一と断定しない**（上位 §4-5.4） | `src/lib/elith-blood-csv.ts:539`（`指図番号` は「15 桁前後」）／本番様式 fixture の実値は **16桁・17桁**（`scripts/blood-csv-fixtures/prod_ok_2rows.sjis.csv`・ただし当社が作った架空値） |

→ **帰結**: 桁数・prefix は **`lab_companies.external_id_pattern`（regex・実在・未登録）か共通 validator に置き、コードへ直書きしない。**
実物 1 枚で確定するまでは「**形式検証を通らない値は自動確定しない**」という振る舞いだけを実装する。

---

## 3. 実装前調査の結果（実コード・2026-10-11）

### 3.1 既存実装の棚卸し

| 項目 | 現行実装 | `file:line` | 変更要否 |
|---|---|---|---|
| 受取確認 UI（ダッシュボード） | `KitProgressRows.astro` の「受け取りました」ボタン。`data-self-report` / `data-shipment-id` / `data-action` の 3 属性だけを持つ | `src/components/dashboard/KitProgressRows.astro:92-101` | **拡張**（撮影導線をここから出す） |
| 受取確認 UI（詳細ページ） | `/kit` の同じボタン。全件が出る | `src/pages/kit.astro:229-234` | **拡張** |
| 受取確認の処理（唯一の実装） | `initKitSelfReport()`。2 画面から使うので**ここが唯一**。`confirm()` → `POST /api/kit/:id/self-report` → `location.reload()` | `src/scripts/kit-self-report.ts:26-62` | **拡張**（複製しない） |
| 受取確認 API | `POST /api/kit/[id]/self-report`。`:id` は **`kit_shipments.id`**。**uid は body から取らず `viewer.writeTargetUid`** を使う。代理表示・共有閲覧・未認証を 3 段で拒否 | `src/pages/api/kit/[id]/self-report.ts:18-61` | **拡張**（認可はそのまま流用） |
| 受取確認の本番の正本 | HP Edge Function `kit-self-report` に委譲。**`order_id` を主キーに `orders.user_received_at` を更新** | 同 `:63-76`／wellfort-site `supabase/functions/kit-self-report/index.ts:4-5,94-99` | **変更しない** |
| 受取状態の表示 | `shipmentLabel()` / `SHIPMENT_STAGES`（6 段） | `src/lib/dashboard-queries.ts`（`KitProgressRows.astro:4` が import） | **拡張**（ID 取得状態を足す） |
| `lab_tests` スキーマ | `external_test_id`（`unique (lab_company_id, external_test_id)`）／`external_barcode` **とも実在** | `supabase/migrations/20260601000010_schemas_and_tables.sql:143-162`（`:150,151,161`） | **変更不要（列は足りている）** |
| `lab_tests` の RLS | `enable row level security` のみ。**この表に個別ポリシーは無い**（baseline の `dev_read_all` / `dev_authn_write` がループで当たる） | `supabase/migrations/20260601000020_rls_policies.sql:35`／同 `:63,67` | **要検討**（§6.3） |
| `kit_shipments` スキーマ | `tracking_no` 等は在るが、**個体ID列は無い** | 同 `:112-141`（`:123`） | 本書の対象外（上位 ③-1） |
| `external_test_id` の現行利用 | **`lab_tests` 用途では未使用**。ヒットするのは全て `diagnosis.test_artifacts` 側の同名列（blood episode 番号 `g<N>` 等） | `src/lib/blood-subset.ts:81-82`／`src/lib/scan-persist.ts:622`／`src/lib/result-queries.ts:263` | — |
| `external_barcode` の現行利用 | **Genoplan の取得時に S3 の横へ JSON で控えるだけ**（DB には書かない） | `src/pages/api/admin/genoplan-fetch.ts:274-275` | — |
| ブラウザ → S3 直 PUT の既存基盤 | **サーバがキーを採番** → `isScanUploadKey` で**完全一致**検証 → Content-Type と ContentLength を**署名に固定** → 15 分期限 | `src/lib/scan-upload-ticket.ts:14-31,74-82,84-` | **流用する**（§6.2） |
| 原本の private storage | `putOriginal()` → S3（Object Lock・10 年保管）／未設定時は Supabase Storage `lab-results` へフォールバック。読み出しは短時間 signed URL | `src/lib/originals-storage.ts:29,55-58,103-120,182-196` | **流用しない**（§6.2 の理由） |
| カメラ撮影の既存基盤 | `initCameraScan()`（`getUserMedia` → canvas → dataURL・`maxEdge: 2400, quality: 0.92`） | `src/scripts/camera-scan.ts:105-142,266-272` | **流用する** |
| AI問診の完了記録 | `diagnosis.interview_completions` に**完了日時と設問数だけ**。回答の中身は保存しない | `src/lib/interview-completion.ts:23-78` | — |
| AI問診の「この回の分が済んだか」 | `interviewCycleStatus()`（回窓連動・純関数・fail-safe は「催促しない」側） | `src/lib/interview-cycle.ts:31-44` | **拡張**（§7.1 のゲートはここに足さない。理由は §7.1） |
| プリベント問診CSV 生成 | **存在しない**。写像表だけが文書に在る | 実測 grep（生成処理 0 件）／`docs/lab/questionnaire_to_lab_csv_spec.md §4.2` | **新規**（本書の範囲外・上位 §4-5.9 の P0-2） |
| プリベント結果PDF の取込・ID bind | **存在しない**。提出 PDF の S3 キーは `{quarantine}{partner}/{YYYY/MM/DD}/{UUIDv4}.pdf` で**検査IDを含まない** | `src/lib/laif-portal.ts:182-183,219-224`／consumer は `listUploads`/`createDownloadUrl`/`revokeUpload` の 3 つだけ（同 `:261-272,297-322,354`） | **新規**（本書の範囲外・上位 §4-5.9 の P0-2） |
| admin 訂正／監査ログ | **汎用の監査ログ表が無い**。在るのは Partner Portal 専用の `partner_auth_events` と、各 admin API が個別に持つ `triggered_by`（HMAC digest）だけ | wellfort-site `supabase/migrations/20260909000010_partner_portal_auth.sql:115`／`src/lib/admin-identity.ts`（`adminIdentity()`） | **新規**（§8） |
| private storage の既存画像 upload | **wellfort-site 側には無い**（`storage.` / `bucket` のヒット 0 件）。画像／原本の受け口は**すべて Scan-Chat-AI 側** | 実測 grep | — |
| バーコードデコードのライブラリ | **無い**。`BarcodeDetector` / zxing / quagga / jsQR のヒット **0 件**。`qrcode-generator` は**生成**用 | `package.json` の `dependencies`／実測 grep | **§6.4 で方式決定** |

### 3.2 【ブロッカー】紐づけ先の `lab_tests` 行が存在しない

**本書の中心的な要件は「ユーザーが所有する `lab_tests.id` に外部IDを登録する」だが、その行を作るコードが存在しない。**

| 観測 | 根拠 |
|---|---|
| `customer.lab_tests` を参照しているアプリコードは **1 か所だけ**で、**SELECT のみ** | `src/lib/chat-context.ts:79-80`（AI問診の EXAM-TYPE 設問へ `test_type` を供給するため） |
| **INSERT / UPDATE / UPSERT は両リポジトリに 0 件** | 実測 grep（`from('lab_tests')` の全ヒットが上記 1 件） |
| 既存行は **seed だけ** | `supabase/seed.sql:128`／`supabase/seed_admin_users.sql:127`／`supabase/demo_oem_account.sql:73` |
| wellfort-site 側には `lab_tests` が**そもそも存在しない**（`src` / `supabase` 全体で 0 件） | 実測 grep |
| 本番のキット／注文の正本は wellfort-site の `orders`。Scan-Chat-AI の表示は `app_bridge.kit_shipment`（**`orders` のミラー・1注文=1行**）から来る | `src/lib/bridge-queries.ts:1-9`／wellfort-site `supabase/migrations/20260905000010_wellfort_baseline.sql:149-166`／`CLAUDE.md`「`app_bridge.kit_shipment` はキットでなく `orders` のミラー」 |

→ **この状態で登録APIを実装すると、本番で登録先が 1 行も無い API になる。**

**仕様と実装のどちらが古いか（Task C の様式に従った明示）**

> **実装が古い（未実装）。** 仕様（`lab_tests.id` を主キーに外部IDを相関させる）は
> `id_management_and_correlation_spec.md` と `lab_data_reception_overview.md §5.2` で一貫しており、**列も実在する**。
> 足りないのは**行を作る工程**で、それは `id_management_and_correlation_spec §7-3`（採番タイミング・スキャン工程）が
> **未実装のまま**残していた宿題である。**本書の都合でここを推測で埋めない。**

**解きかたの選択肢（発注者判断が要る・§9 の D-1）**

| 案 | 内容 | 影響 |
|---|---|---|
| **案 A** | **登録時に `lab_tests` 行を作る**（`kit_shipments`/`orders` の行 ＋ `test_type` から確定し、無ければ insert・在れば update） | 本書だけで閉じる。ただし「1 注文 = 1 行」のミラーから**どの回のどのキットか**を決める規則が別途要る |
| **案 B** | **出荷指示の時点で `lab_tests` 行を作る**（上位 ③-1 の本筋）。登録は update だけ | 筋が通る。ただし上位 ③-1（タカセ連携）の実装が先行条件になり、本書は待ちになる |
| **案 C** | **当面 `lab_tests` を使わず、受取確認の単位（`kit_shipments.id` / `orders.id`）へ外部IDを控える**。`lab_tests` が整備された時点で移行 | すぐ作れる。ただし **`unique (lab_company_id, external_test_id)` による重複検出が効かない**ので、重複は別途の一意制約が要る |

**【裁定 2026-10-11・発注者】案A を採る。** 以下はその実装。

`persistExternalIdCapture()` → `linkLabTest()`（`src/lib/external-id-persist.ts`）が、
**本番の形で使えない材料をその場で引き直す**。本番の shipment は `app_bridge`（= `orders` のミラー）
由来なので、そのまま使うと 3 か所で壊れる:

| 列 | 本番の shipment の値 | どう解いたか |
|---|---|---|
| `lab_company_id` (NOT NULL FK) | **`''`**（`bridge-queries.ts:75` — app_bridge は検査会社を持たない） | `customer.lab_companies.test_types` に当該 `test_type` を含む行から引く。**1 件でなければ作らない** |
| `customer_id` (NOT NULL FK) | 実は **`diagnostic_user_id`**（同 `:74`） | `customer.customer_profiles` を `diagnostic_user_id` で引き直す |
| `shipment_id` (FK → `kit_shipments`) | **`orders.id`**（`customer.kit_shipments` に無い） | **その ID で実在を確かめた時だけ入れ、無ければ NULL**（列は nullable）。埋めに行くと本番で必ず FK 違反 |

**材料が揃わない回は登録ごと失敗させない。** 台帳には必ず記録し、
`lab_test_link_status='deferred'` と理由を残す（「サイレント脱落ゼロ」を採る）。
`linked` / `deferred` / `conflict` を返すので、**どこまでできたかが呼び出し側に分かる**。

| 状況 | `lab_tests` | 台帳 | status |
|---|---|---|---|
| 材料そろい・**初回撮影** | **今回用の行を作って紐付け** | 記録 | `confirmed`（判定が通れば） |
| **同じ回の撮り直し / 二重 submit**（台帳に `lab_test_id` が在る） | **その行を今回の値で更新** | 更新 or 旧行を `superseded` | 同上 |
| 台帳が指す行が**消えている** | **作り直す**（黙って `linked` を装わない） | 記録 | 同上 |
| 過去の検査の行が在る（1 件でも 2 件でも） | **1 バイトも触らない**（§3.2.1） | 記録 | 同上（今回用の行を作る） |
| `customer_profiles` / `lab_companies` が引けない | **作らない** | 記録 | `review_required` |
| 同じ値が**別の検査**に在る | **1 バイトも触らない** | 記録（`conflict`） | `review_required` |
| 台帳が引けない（migration 未適用） | 触らない | — | **503 で失敗**（黙って成功を装わない） |

これらは `verify:external-id-capture` の ⑩ が **実物の `persistExternalIdCapture` を動かして**
確認している（(a)〜(k) ＋ (h2)(h3)）。年跨ぎは ⑭（下記 §3.2.1）。

#### 3.2.1 既存行を使い回す条件は 1 つだけ（発注者指示 2026-10-11）

**`(diagnostic_user_id, test_type)` で引いた既存行を「今回の検査」とみなしてはいけない。**

v1.0 の初版は「既存 1 件ならその行へ入れる / 2 件以上なら触らない」だった。
**プリベントは年 1 回**なので、2 年目の撮影では前年の行が**ちょうど 1 件**ヒットし、
**前年の `external_barcode` を今年の値で上書きする**。前年の結果PDF を辿るキーが消え、
しかも画面も台帳も `linked` と表示するので**黙って壊れる**。
「1 件だからこれだろう」は推測であって、今回の検査である根拠ではない（R4）。

→ **行を使い回す根拠は、同じ `(diagnostic_user_id, shipment_ref, provider)` の台帳行が
既に持っている `lab_test_id` だけ**（＝同じ回の撮り直し・二重 submit）。
それが無ければ**今回用の行を新しく作る**。`linkLabTest()` は
**`test_type` で `lab_tests` を引く問い合わせを 1 本も出さない**
（`verify:external-id-capture` の ⑩(f) がそれを見ている）。

**申し送り**: 上位 ③-1（出荷時に `lab_tests` 行を作る）が実装されたら、初回撮影でも
**出荷側が作った行**を使うべきで、常に新規作成すると二重になる。その突き合わせ方
（`shipment_id` か別のキーか）は**仕様に無いので作らない**（§12 の確認事項）。
今は「新規作成」で一貫させ、重複は admin が見る。

---

## 4. ユーザー体験

### 4.1 起点

**既存の「検査キットを受け取りました」導線を拡張する。別系統の似た機能を増やさない**（`kit-self-report.ts:4-5` が
「2 画面から使うのでここが唯一の実装」と明記しているのと同じ規律）。

対象検査で外部ID取得が必要な場合の並び:

1. 受取確認（既存ボタン）
2. 撮影対象の説明（§4.2 / §4.3）
3. カメラ起動
4. **書面全体**を撮影
5. 外部IDの読取（§5）
6. 読取結果の確認（§6.1）
7. 登録
8. 受取確認完了・検査進捗へ反映

**現行の `confirm()` → 即 POST（`kit-self-report.ts:41-52`）を、対象検査のときだけ撮影ステップへ差し替える。**
**対象外の検査は 1 バイトも挙動を変えない**（回帰テスト §10 の 13）。

### 4.2 撮影前ガイド — プリベント

**QR コードを主対象として見せない**（§2.1）。

ガイド画像は実際の同梱書面を**書面全体が分かる状態**で表示し、その中の

- 「**ユーザーID**」の印字
- その直下または近傍の **1次元バーコード**

を**枠で囲って**「ここが入るように撮影してください」と明示する。

### 4.3 撮影前ガイド — デメカル

書面全体を示し、上部の「**問合せ番号**」と **15桁の番号**の位置を枠で強調する。

### 4.4 カメラ画面

- スマートフォン**縦画面**を基本とする。
- **書面全体が入るガイド枠**を表示する（部分拡大を促さない）。
- 撮影対象エリアの説明を短く表示する。
- **カメラ権限拒否時は画像ファイル選択へフォールバック**できるようにする
  （`scan.astro` が既に持っている 2 経路と同じ形。`CLAUDE.md`「カメラ可否の判定は CSS `.touch-only` と同じ
  `(pointer: coarse)`」にそろえる＝**画面に出ていないカメラを JS から起動しない**）。
- 撮影後に**プレビュー**を表示し、「**撮り直す**」「**この画像を使う**」を選べるようにする。

---

## 5. ID 読取

### 5.1 プリベント

優先順位:

1. **1次元バーコードのデコード**
2. 印字された「ユーザーID」の **OCR**
3. 必要時のみ**手入力補正**

両方取得できた場合は**一致確認**する。

| 状況 | 挙動 |
|---|---|
| 一致 | 自動**候補**として確認画面へ（自動確定はしない） |
| **不一致** | **自動登録しない。** 再撮影またはレビュー |
| 片方だけ取得 | 信頼度・形式チェックの後、**ユーザー確認を必須**にする |
| **QR だけ読めた／対象バーコードが読めない** | 「対象の番号を読み取れませんでした」として**再撮影**（QR の値は**使わない・保存しない**） |

**`704000xxx` は現時点の業務上の形式例。** 桁数／prefix をコードへ固定する前に、既存実データ・先方資料・現行仕様で
**許容範囲を確認**し、**設定（`lab_companies.external_id_pattern`）または共通 validator** に置く（§2.3）。

### 5.2 デメカル

- 「問合せ番号」の **15桁数字**を OCR。
- 空白・ハイフン・全角を**正規化**して数字列へ変換する。
- **15桁でなければ自動確定しない。**
- 読取失敗時は再撮影、最後の手段として手入力補正。
- **この番号と結果CSV の `指図番号` の関係は、現時点の Primary 照合を置き換える前提にしない**（§2.3）。
  相関が実データで確認された場合のみ、別途仕様を更新する。

---

## 6. 確認・登録

### 6.1 確認画面

表示するもの:

- 検査名
- 読み取った外部ID
- 「この番号で登録する」／「撮り直す」／（必要な場合のみ）「番号を修正する」

**登録前にユーザーへ番号を見せ、確認操作を必須にする。**

登録成功後:

- 「受取確認が完了しました」
- 登録した外部IDの**末尾等、必要最小限**の確認情報
- 検査進捗画面への戻り導線

**外部IDの全文を不必要な画面・ログ・分析イベントへ露出させない。**

### 6.2 撮影画像の保存（**既存基盤を流用する**）

**`scan-upload-ticket.ts` の形をそのまま流用する**（`src/lib/scan-upload-ticket.ts:14-31`）。理由:

- **キーはサーバが採番**し、クライアントは PUT 先を選べない。
- **完全一致の validator**（`isScanUploadKey` 相当）でしか読まない → 同じバケットの **Elith 納品 JSON を読み出せない**。
- Content-Type と ContentLength を**署名に固定** → 別形式・サイズ超過へのすり替えを **S3 自身が拒否**する。
- 期限 15 分。
- **Vercel Functions のリクエストボディ上限 4.5MB を関数に通さずに回避できる**（既に本番で実績がある経路）。

**`putOriginal()`（`originals-storage.ts:103`）は使わない。** あちらは **Object Lock ＋ 10 年保管の「検査原本」**用で、
**削除も上書きもできない**。撮影のやり直しが常態である受取時の画像を入れると、**消せないゴミが積み上がる**。
撮影画像は**検査原本ではなく読取の証跡**なので、別のプレフィックスに置く。

**`test_artifact_files` も使わない。** あれは `diagnosis.test_artifacts`（= 検査結果 1 回分）にぶら下がる表で
（`supabase/migrations/20260601000010_schemas_and_tables.sql:213-226`）、**受取時点では結果 artifact がまだ無い**。
`file_kind` の CHECK に値を足す migration も要るので、無理に寄せない。

**必須条件**

- **private のみ。公開URLを DB へ恒久保存しない。**
- 表示が必要なら**短時間の signed URL**。
- MIME・最大サイズ・画像寸法を制限し、**サーバ側で Content-Type だけでなく実体も検証**する
  （`genoplan-fetch.ts:263-266` が PDF マジックバイトを見ているのと同じ規律）。
- EXIF の位置情報があれば削除を検討する。
- **保存期間は §9 の確認事項**。既存の医療関連画像／検査証跡ポリシーに合わせる。
  既存ルールが無いので**こちらで勝手に決めない**。

### 6.3 登録API の必須条件

実際の API 形状は既存コードを読んで決めるが、以下は必須。

- **認証済みユーザーのみ**（`denyAnonymous`）。
- **代理表示中は書かせない**（`denyReadOnlyWrite`）／**共有閲覧からは叩かせない**（`denyForShare`）。
  → **`self-report.ts:26-40` の 3 段ガードをそのまま使う**。新しい認可を発明しない。
- **対象ユーザーは `viewer.writeTargetUid` が決める。** **body の uid を認可根拠にしない**
  （`self-report.ts:49-54` が「他人の uid を書けばその人の配送状態を変えられた」として明示的に禁じている）。
- 対象の検査が**当該ユーザーの所有**であることを**サーバ側で確認**する。
- **provider と test_type の整合**を検証する。
- 正規化済み外部IDの**形式検証**（§5.1 の validator）。
- **同一 provider 内の重複を検出**する（`unique (lab_company_id, external_test_id)` に依存できるのは案 A/B のとき。
  案 C では別途の一意制約が要る＝§3.2）。
- **既登録IDの上書きは通常ユーザー操作では不可。**
- **同時二重送信に対して idempotent。**
- 受取状態の更新と ID 紐づけの**整合性を壊さない**（受取は `orders` が正本・§3.1）。
- **service_role をブラウザへ露出しない。**
- 監査ログに**秘密値や画像を丸ごと書かない**。

### 6.4 バーコードデコードの方式（**既存依存で足りるかの検討**）

**現状、バーコードをデコードできるライブラリは入っていない**（§3.1 の最終行）。選択肢:

| 案 | 内容 | iOS Safari | 追加依存 | 評価 |
|---|---|---|---|---|
| **案 1** | ブラウザの **`BarcodeDetector`** API | **非対応**（WebKit に無い） | **0** | **単独では不可**。主要利用者はスマホで、iPhone が落ちると機能が成立しない |
| **案 2** | **`@zxing/library`** 等を同梱 | 対応 | **+1（数百KB）** | 動くが bundle が増える。`CLAUDE.md` の「追加依存なし方針」に逆行 |
| **案 3** | **撮影画像をサーバへ渡し、既存の Gemini 経路で読む** | 対応（撮るだけ） | **0** | **本線として推奨**。`scan.astro` → S3 → Gemini が**既に本番で動いている同じ形**で、端末差が出ない |

**推奨 = 案 3 を本線、案 1 を「使える端末だけの高速化」として任意で併用。**
案 1 を併用する場合も、**`BarcodeDetector` が無い端末で機能が落ちないこと**を必須条件にする
（`CLAUDE.md` の fail-safe の規律）。**案 2 は、案 3 の読取精度が実物で足りないと分かってから検討する。**

→ **ライブラリを足すなら、既存依存関係・bundle size・iOS Safari 対応の比較を PR 本文に書く。**

---

## 7. AI問診ゲート

### 7.1 プリベント（ハードゲート）

がんリスク検査を含む対象検査で、バーコードNo. が未登録の場合:

- **問診データをプリベントへ出す前に必ずブロックする。**
- UX 上は、**既存フローを最も壊さない位置**で「先に検査キットの受取確認を行ってください」と案内する。

**ゲートを置く場所（調査の結論）**

| 候補 | 判断 |
|---|---|
| `interview-cycle.ts` の `interviewCycleStatus()` | **置かない。** あれは「この回の問診が済んだか」の**純関数**で、fail-safe が「**催促しない**」側に倒してある（`interview-cycle.ts:16-18`）。ここにゲートを足すと、**回窓が取れない回にゲートが素通りする**（fail-open になる） |
| AI問診の開始時（`chat.astro`） | **UX 上の案内はここ**。ただし**開始を塞ぐと、プリベント以外の目的（Elith 報告書・LAiF）の問診まで止まる**ので、**開始自体はブロックしない** |
| **プリベント向け問診CSV の生成時（サーバ側）** | **ここが本当のゲート。** 「問診データをプリベントへ出す前に必ずブロック」を満たすのは**ここだけ**で、UI を迂回されても効く |

→ **結論: 二段にする。** ①**CSV 生成側が fail-closed**（ID 未登録なら生成しない＝これが要件）
②**AI問診の画面には案内だけ**出す（開始は止めない）。

**【v1.0 で用意したもの】** プリベント問診CSV の生成そのものは**まだ存在しない**
（上位 §4-5.9 の P0-2・実測 grep で生成処理 0 件）。だから①のゲートを**先に部品として置いた**:

- **`checkPreventQuestionnaireGate()`**（`src/lib/external-test-id.ts`・純関数）
  — **3 つ揃ったときだけ通す**（発注者指示 2026-10-11）:
  **`status='confirmed'`** ∧ **`lab_test_link_status='linked'`** ∧ **`lab_test_id` が非 null**。
  `review_required` / `deferred` / `conflict` は **fail-closed でブロック**する。
  理由コードは `capture_missing` / `barcode_no_missing` / `barcode_no_malformed` /
  `capture_not_confirmed` / `lab_test_not_linked`。
  - **値だけを見て通してはいけない。** 値が読めていても、`review_required`（パターン外・
    読取が怪しい）や `deferred`（`lab_tests` を作れなかった）`conflict`（同じIDが別の検査に在る）の回は
    **その番号がこの検査のものだと確定していない**。ここで通すと問診CSV が
    **別人・別回の番号で**プリベントへ渡り得る。どれも admin が見て決める事柄なので、
    **判断を機械に代行させない**。
  - **パターン外の扱いは変えていない** — 登録は通り `review_required` になる（§2.3）。
    変わったのは「`review_required` のまま CSV へ出さない」ことだけ。
    実物の形式が確定したら `labid.prevent_pattern` を直せば `confirmed` になり、そこで通る。
    ゲートはパターンを再判定しない（**台帳の `status` を正とする**＝判定を二重に持たない）。
- **`loadCapturedExternalId()`**（`src/lib/external-id-persist.ts`）
  — **`shipmentRef` か `labTestId` のどちらかが必須**。「その人の最新」ではなく
  **「今回の検査」**を引く（どちらも無い呼び出しは型で弾き、実行時も `null`）。
  返すのは `normalizedValue` / `status` / `labTestLinkStatus` / `labTestId` の 4 つ
  — **値だけを返すと、呼び側が status と link を見ずに通せる**（それが元の穴）。
  - **以前は `(diagnostic_user_id, provider)` を `captured_at desc limit 1` で引いていた。**
    それだと**前年の confirmed なレコードで今年の CSV が通る**（今年は未撮影なのに、
    前年の番号でプリベントへ出る）。年 1 回の検査では必ず踏む。

**CSV 生成を実装する人は、出力の前にこの 2 つを必ず通すこと。**
`verify:external-id-capture` の ⑦ がゲートの挙動を固定し、
**`interview-cycle.ts` にゲートを足していないこと**も機械で見ている
（足すと fail-safe の向きが逆なので fail-open になる）。

**②の案内はまだ画面に出していない。** 出すのは `labid.prevent_capture` を on にする段
（それまで撮影導線そのものが出ないので、案内だけ先に出すと行き先が無い）。

### 7.2 デメカル

受取撮影は **Secondary** のため、**v2.1 時点では一律ハードブロックの要件にしない**（§2.2）。

---

## 8. 状態遷移・重複・訂正

### 8.1 状態

UI で次を区別できること。

未発送 / 発送済 / 受取確認待ち / **受取済・ID未取得** / **ID読取済・確認待ち** /
**受取確認完了・ID紐づけ完了** / **review_required** / 検査返送済 / 検査中 / 結果受領

**既存 status 体系を乱造しない。** 現行は `SHIPMENT_STAGES`（6 段・`dashboard-queries.ts`）と
`kit_lifecycle.status`（9 値・wellfort-site `20260910000020_kit_lifecycle_model.sql:97-100`）が在るので、
**既存 status ＋ ID capture 状態の組合せ**で表現することを優先する。

### 8.2 重複

同じ外部IDが**別の `lab_tests.id`** に既に紐づいている場合:

- **自動上書き禁止。**
- ユーザーには**一般化したエラー表示**（他人の検査の存在を漏らさない）。
- 管理側で **`review_required`**。

### 8.3 誤読

- **再撮影を第一選択。**
- 手入力修正は**元画像と読取値を残し**、修正前後を監査可能にする。

### 8.4 管理者訂正

**既存 admin 機能へ統合できるかを先に確認する。**
ただし §3.1 のとおり**汎用の監査ログ表が無い**ので、最低限として

- 変更前 / 変更後 / 理由 / 操作者 / 時刻

を保持する。**操作者は素の email を保存しない。**
`adminIdentity()`（鍵つき HMAC ＋ domain separation）の digest を使う
——`CLAUDE.md`「素の `sha256(email)` にしない。メールアドレスは列挙可能なので辞書で戻せる」。

---

## 9. 着手前に決めること（発注者判断）

| # | 論点 | 状態 | 中身 |
|---|---|---|---|
| **D-1** | **`lab_tests` 行を誰がいつ作るか**（§3.2 の案 A / B / C） | **裁定済み 2026-10-11 = 案A** | 登録時に作る。本番で使えない材料は引き直し、揃わない回は `deferred` で台帳に残す（§3.2 の末尾）。**行を使い回すのは「同じ回の撮り直し」だけ** = §3.2.1 |
| **D-4** | バーコードデコードの方式（§6.4 の案 1/2/3） | **裁定済み 2026-10-11 = 案3（サーバ側 Gemini）** | 追加依存ゼロ・iOS Safari でも動く。`BarcodeDetector` の併用は**入れていない**（要るか実機で見てから） |
| **D-2** | プリベント バーコードの**実フォーマット**（総桁数・prefix・チェックディジット・バーコード規格） | **未確認**（先方資料 or 実物 1 枚が要る） | コードに固定していない。app_config `labid.prevent_pattern`（既定 `^704000[0-9]{3}$` = **仕様書の表示例の写し**）。**外れても登録は通り `review_required`** になるだけなので、実物が違っても運用が止まらず admin が即日直せる |
| **D-3** | **撮影証跡画像の保存期間** | **未決**（こちらで決めない） | 医療関連画像・検査証跡のポリシーに属する。**ライフサイクルを前提にした実装をしていない**（`external-id-evidence.ts` 冒頭）。決まり次第バケット側で設定する |
| **D-5** | デメカル 15桁 と DSS `指図番号` の同一性 | **未確認・断定しない** | `external_test_id` へ**独立に**保存し、Primary（氏名＋生年月日）を置き換えない（§2.3） |

**D-2 / D-3 / D-5 が未確認のままでも安全に出せるように、`labid.prevent_capture` /
`labid.demecal_capture` の既定を `off` にしてある**（画面にも API にも出ない）。
**実物の書面を 1 枚見てから on にする。**

---

## 10. テスト要件

自動テストまたは再現可能な手順で確認する。

1. プリベント正常撮影 → 読取 → 確認 → 登録
2. バーコード ＋ 印字ID **一致**
3. バーコード ＋ 印字ID **不一致**（自動登録されないこと）
4. **QR だけ写っていて対象バーコードを読めない**場合（QR の値を使わないこと）
5. 画像不鮮明 → 読取失敗 → 再撮影
6. **重複外部ID**（自動上書きされず `review_required` になること）
7. **他ユーザーの `lab_test_id`** を指定（**必須**・サーバ側で拒否されること）
8. **二重 submit**（idempotent）
9. カメラ権限拒否 → **ファイル選択へフォールバック**
10. デメカル 15桁 正常読取
11. デメカル 14桁 / 16桁 / 文字混入（自動確定しないこと）
12. 管理者訂正と**監査ログ**（変更前後・理由・操作者・時刻）
13. **既存の受取確認だけを使う他検査の回帰が無いこと**（対象外検査は挙動不変）
14. **AI問診のプリベントゲート**（§7.1 の①が fail-closed・②が案内のみ）
15. プリベント問診CSV へ**登録済みIDが正しく入る**
16. 結果受領時に**同じ検査へ戻る** E2E
17. **PWA / iPhone Safari でのカメラ動作**（実機）

**【v1.1 で必須に追加（発注者指示 2026-10-11）】年跨ぎ / ゲートの回帰 5 本**
（`verify:external-id-capture` の ⑭。**この 5 本は目視では絶対に捕まえられない**）:

| # | 見るもの | 落ちたときに起きていること |
|---|---|---|
| ① | 同一人物が **2 年連続**プリベント → `lab_tests` が **2 行**になり**前年を上書きしない** | 前年の `external_barcode` が消える（結果PDF を辿れない） |
| ② | **前年 `confirmed`・今年未撮影** → 前年IDを使わずブロック | 今年未撮影のまま、前年の番号で問診CSV が出る |
| ③ | 今年 **`review_required`** → ブロック | この検査のものだと確定していない番号で CSV が出る |
| ④ | 今年 **`deferred` / `conflict`** → ブロック | 同上（`lab_tests` に紐づいていないのに出る） |
| ⑤ | **同じ shipment の二重 submit** → 同じ `lab_test_id` を維持 | 行が増える・紐付け先が回ごとに変わる |

**代理表示・共有閲覧からの書き込みが拒否されること**も必須
（`self-report.ts:26-40` と同じ 3 段ガードを通していることの確認）。

既存 CI・lint・typecheck・`verify:*` をすべて実行する。
**この機能は静かに壊れる種類**（撮れたつもりで読めていない／他人の検査へ紐づく）なので、
`CLAUDE.md` の流儀どおり**退行注入で名指しに落ちることを確認**する。

---

## 11. 受入条件

- プリベントの `704000xxx` が**ユーザー操作で 1 つの `lab_tests.id` へ一意に登録できる**。
- **QR ではなく「ユーザーID ＋ 1次元バーコード」**を撮影対象として明示できている。
- 読取値をユーザーが**確認・再撮影・必要時修正**できる。
- **重複・不一致は自動確定しない。**
- 証跡画像は **private 領域**にあり、公開URLを DB に持たない。
- プリベント問診CSV へ、登録した**同じ外部IDを機械的に出力**できる。
- デメカル 15桁「問合せ番号」を**同じ共通UI基盤で Secondary として登録できる設計**である。
- **Genoplan の現行タカセCSV 方式を変更していない。**
- 既存の認証・RLS・受取確認・AI問診・検査結果パイプラインを壊していない。

---

## 12. 申し送り（この版で確認できていないこと）

**どれも「実装が足りない」ではなく「この環境では測れない」もの。** 既定 off にしてあるので、
確認が済むまで利用者には 1 行も出ない。

- **実物の同梱書面を 1 枚も見ていない**（D-2）。プリベントのバーコード規格・総桁数・
  レイアウト、デメカルの用紙上の「問合せ番号」の位置。**先方資料または実物 1 枚で確定する。**
  → 確定したら `labid.prevent_pattern` を admin から直す（デプロイ不要）。
- **Gemini の読み取り精度を測っていない**（この環境に `GEMINI_API_KEY` が無い）。
  プロンプトとスキーマは固定したが、**実際に 1次元バーコードを読めるか・QR に引っ張られないか**は
  実物の写真 1 枚で確かめる。読めなければ §6.4 の案2（`@zxing/library`）を再検討する。
- **S3 の実挙動も未確認**（鍵が無い）。presigned PUT・**バケットの CORS**（無いとブラウザの
  PUT が黙って失敗する）・`kit-id-captures/` のライフサイクル。
  手順は `docs/operations/スキャンS3直アップロード_バケット設定手順書.md` と同じ形。
  **CORS はバケット単位**で prefix 単位の許可はできない（上の §12-3）。
- **実機（PWA / iPhone Safari）のカメラ動作は未確認**（手元に WebKit が無い）。
  §10 の 17 は**実機で 1 回ずつ通すのが完了条件**。
- **本番 DB での通し確認は未実施**。とくに
  **`customer.customer_profiles` / `customer.lab_companies` に本番の行が在るか**は
  この環境から引けない。無ければ登録は `deferred` になる（**撮影は失わない**）が、
  `lab_tests` への紐付けは別途の工程が要る。
- **【確認事項・v1.1】③-1（出荷時に `lab_tests` 行を作る）が実装された後の二重行。**
  いま初回撮影は**必ず新しい行を作る**（§3.2.1）。③-1 が入ると出荷側が先に行を作るので、
  同じ検査に 2 行できる。**出荷側の行と撮影を突き合わせるキーが仕様に無い**ので、
  **ここで推測して作らない**（`shipment_id` は本番だと `orders.id` で `kit_shipments` に
  無いため、そのままでは突き合わせに使えない）。③-1 の設計時に決める。
  それまでは重複は admin が見る（**前年を上書きするより軽い事故**を選んでいる）。

### 発注者の操作が要るもの

1. **migration の適用** — `supabase/migrations/20261011000010_lab_test_id_captures.sql`。
   **アプリより先に当てる**（additive なので旧アプリは無害）。未適用のままだと登録 API は
   **503 で明示的に失敗する**（黙って成功しない）。
2. **実物の書面 1 枚**（D-2）→ 確認後に `labid.prevent_capture` を on。
3. **バケットの CORS**。**S3 の CORS はバケット単位で、オブジェクトの prefix 単位では
   絞れない**（`PutBucketCors` に prefix の概念が無い）。設定するのは
   **対象バケットに対して Wellfort の Origin / `PUT` / 必要な header だけを許可する**こと。
   **`kit-id-captures/` に限定するのは CORS の仕事ではない** —
   prefix の制約は **presigned URL を発行するサーバ側のキー検証**
   （`isEvidenceKey` の完全一致・§6.2）が持つ。署名の無いリクエストは
   そもそも S3 に通らないので、CORS が広いこと自体が書き込み権限にはならない。
4. **証跡画像の保存期間の判断**（D-3）。
