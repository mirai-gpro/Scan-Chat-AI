# ID 体系・採番・相関 整理仕様（顧客 / サブスク / 検査 / Elith）

| 項目 | 内容 |
|---|---|
| 目的 | パイプライン全体で使う **ID を層別に整理**し、①採番主体 ②相関（どのIDが何を結ぶか）③PII境界 ④**現時点=全ID Wellfort側で採番・管理** ⑤**将来=各検査会社の独自ID／検査キットの物理ID(POS/バーコード)連携** の方針を1枚に集約する。 |
| 位置づけ | ID の**正本**。個々のテーブル定義は各スキーマ型（`src/types/supabase-*.ts`）／各 spec が正。本書は横断の相関と採番方針を規定。 |
| 版 | 2026-08-12（Draft・初版）／**§0 に一部失効の注記を追加 2026-10-09（v2.1）**。外部ID運用の現行正本＝`docs/lab/lab_data_pipeline_master_spec.md` §4-5 |
| 出典（実在確認済） | `src/types/supabase-customer.ts`（customer/PII）・`src/types/supabase-diagnosis.ts`（diagnosis/非PII）・`src/types/supabase-bridge.ts`（橋渡し）・`docs/elith/elith_s3_data_handoff_spec.md`（client_id）・`docs/architecture/data_integration_requirements.md`（連携キー）・`docs/subscription/kit_lifecycle_and_handoff_management_spec.md`（プラン/キット）・`docs/lab/questionnaire_to_lab_csv_spec.md`（各社ID） |
| 関連 | `docs/lab/lab_data_pipeline_master_spec.md`（E2E総合仕様・上位） |

---

## 0. 大原則

> ### ⚠️ 【一部失効・2026-10-09 / v2.1】
>
> **下の原則 1「全ID は Wellfort 側で採番・管理」は、プリベント／デメカル／Genoplan の
> 外部ID運用については失効した。** 現行正本＝**`docs/lab/lab_data_pipeline_master_spec.md` §4-5**
> （4検査横断・v2.1 / 基準日 2026-10-09）。
>
> 現行の原則はこう:
> - **内部主キーは Wellfort（`lab_tests.id`）を維持する**（ここは不変）。
> - **外部検査会社が発行する番号も実運用に入る**（プリベントのバーコードNo. / Genoplan の
>   ボックスナンバー・認証キー / デメカルの番号）。これらは**内部主キーを置き換えず、
>   `external_test_id` / `external_barcode` の相関キーとして併置する**。
> - 原則 3 の「**将来**：各検査会社の独自ID／キット物理IDとの双方向連携」は、**もう将来ではない**。
>   プリベントの受取時 ID 取得は **P0**（正本＝`docs/lab/kit_receipt_external_id_capture_spec.md`）。
>
> **§7-3（採番タイミング・スキャン工程）は依然 未実装**で、しかも
> **`customer.lab_tests` に行を作るコードが両リポジトリに 1 つも無い**
> （SELECT は `src/lib/chat-context.ts:79-80` の 1 か所だけ・INSERT/UPDATE/UPSERT は 0 件・実測 grep）。**これが外部ID紐づけ全体の先行条件**＝
> 上位 §4-5.12 の 3。
>
> なお **§1.1 の見出し「customer スキーマ = HP/wellfort-site Supabase」は正確でない。**
> `customer` スキーマは **Scan-Chat-AI 自身の Supabase プロジェクト**に在り
> （`supabase/migrations/20260601000010_schemas_and_tables.sql`）、service_role で**書き込みもできる**
> （`src/lib/supabase.ts:31-38`／`src/pages/api/kit/[id]/self-report.ts:117-123`）。
> wellfort-site 側に在るのは `public`（`customer_profiles` 等）と `app_bridge` で、
> `HP_BRIDGE_READONLY_KEY` は**後者専用**（`src/lib/supabase.ts:41-46`）。
> 本番のキット／注文の正本は wellfort-site の `orders` 側。

1. **現時点＝全ID は Wellfort（本システム）側で採番・管理**する。外部検査会社・Elith へ渡す識別子も**こちらの採番値**を用いる。
2. **外部（各社 / S3 / Elith）へ持ち出す識別子は仮名 `diagnostic_user_id`（および派生）のみ**。氏名・住所・生年月日等の PII は識別子に使わない（PII例外＝LAiF/プリベント上りCSVの**生年月日**のみ・発注者決定・ポータル保護）。
3. **将来**：各検査会社の**独自ID**（採番元＝検査会社）と、ユーザーへ送付する**検査キットの物理ID（バーコード/POS等）**との**双方向連携**を想定する。**受け皿カラムは実装済**（§5）＝いま採番方針を変えなくても後付けで紐付け可能。

---

## 1. ID 一覧（層別・実在カラム）

### 1.1 認証・顧客（PII / customer スキーマ = HP/wellfort-site Supabase）
| ID | カラム（実在） | 採番 | 役割 | PII |
|---|---|---|---|---|
| 顧客ID | `customer_profiles.customer_id` | Wellfort | **顧客マスタの主キー**（PII オーナーキー） | ●PII側 |
| 認証user_id(HP) | `customer_profiles.user_id`（FK→`auth.users`） | Supabase Auth | HP 側ログイン主体 | ●PII側 |
| 注文ID | `orders.order_id`（+`customer_id`） | Wellfort(EC) | EC 決済・注文単位 | ●PII側 |

### 1.2 橋渡し（唯一の連携キー / bridge）
| ID | カラム（実在） | 採番 | 役割 | PII |
|---|---|---|---|---|
| **診断ユーザーID** | **`diagnostic_user_id`**（`customer_profiles`／`app_users`／診断系全テーブル／`bridge`） | **Wellfort（App側 Edge Function で発行・uuid）** | **customer(PII)⇔diagnosis(非PII)⇔外部/Elith を結ぶ唯一のマスターキー。ユーザー非開示** | ○**非PII**（=外部持出可） |
| HP顧客ミラー | `bridge.hp_customer_id` / `customer_profiles.diagnostic_user_id` | Wellfort | 双方向ミラー（再同期用） | 参照のみ |

> **命名の確定（R1/R2）**：コードの正カラムは **`diagnostic_user_id`**（`supabase-*.ts` に89箇所・Elith `client_id` の実体・CLAUDE.md 表記もこれ）。
> `docs/architecture/data_integration_requirements.md` 内の **`diagnosis_user_id` は旧・別表記の揺れ**（同一概念）。**正＝`diagnostic_user_id`**。

### 1.3 認証・診断（非PII / diagnosis スキーマ = App Supabase）
| ID | カラム（実在） | 採番 | 役割 | PII |
|---|---|---|---|---|
| App認証ID | `app_users.auth_user_id`（unique・FK→App auth.users） | App Supabase Auth | App 側ログイン主体（Google） | 非PII |
| 診断系オーナー | `app_users.diagnostic_user_id`（pk） | Wellfort | sessions/test_artifacts/diagnosis_results 等の owner（全て FK） | 非PII |

### 1.4 サブスク（購入した検査プラン）
| ID | カラム（実在／仕様） | 採番 | 役割 |
|---|---|---|---|
| プランマスタID | `subscription_plans.id`（実在）／EC商品 `test_products.id`（(c)§1.1） | Wellfort | 検査プランの定義（**両表現の対応は要整合＝§7**） |
| 契約ID | `subscriptions.id`（+`customer_id`,`plan_id`,`status`,`current_cycle_year/seq`） | Wellfort | **ユーザーが購入した検査プランの契約単位** |
| 構成版pin | `subscriptions.plan_composition_id`（(c)§6.1・版管理） | Wellfort | 契約時のキット構成【版】を固定（サブスク保護） |

### 1.5 キット発送・検査（回・検体単位）
| ID | カラム（実在） | 採番 | 役割 |
|---|---|---|---|
| 出荷ID | `kit_shipments.id`（+`order_id`,`subscription_id`,`subscription_year`,`subscription_seq`,`lab_company_id`,`test_type`） | Wellfort | **1回×1キットの発送単位**（回の識別＝year/seq） |
| 配送追跡番号 | `kit_shipments.tracking_no`（+`carrier`） | 配送業者 | 物流トラッキング（外部採番・キットのPOS/バーコードとは別物） |
| 検査ID | `lab_tests.id`（+`shipment_id`,`customer_id`,`diagnostic_user_id`,`lab_company_id`,`test_type`） | Wellfort | **1検査（検体）単位**。発送→検体→結果を束ねる |
| 検査会社ID | `lab_companies.id`（+`name`,`external_id_label`,`external_id_pattern`） | Wellfort | 検査会社マスタ（リージャー/プリベント/LAiF/Genoplan） |

### 1.6 各検査会社へ渡す上りID（会社別・(b)§6）
| 検査会社 | 渡すID | 採番 | 状態 |
|---|---|---|---|
| LAiF（AI疾病予測） | **整理番号（識別番号 No.0）** | **Wellfort採番の仮名ID（確定 2026-08）** | 確定。LAiF自社連番は使わない |
| プリベント（がん・尿） | **会員ID/ユーザーID ＝ 検査セットの バーコードNo.**（`704000`＋3桁・`lab_tests.external_barcode`） | **プリベント（検査会社）** | **確定 2026-10**（先方要望）。**当社は採番しない**。現物確認済み（`kit_receipt_external_id_capture_spec.md §2.1.1`）。正本 = `lab_data_pipeline_master_spec.md §4-5.3` |
| リージャー（血液） | デメカルDSS上の検体ID等 | 検査会社/キット由来 | キット同梱情報から供給（実装時確定） |
| Genoplan（遺伝子） | 整理番号系（国籍等と共に） | 要確認 | (b)§7-4 |

### 1.7 Elith 受渡ID（S3）
| ID | 値 | 役割 |
|---|---|---|
| `client_id` | **＝`diagnostic_user_id`**（`elith_s3_data_handoff_spec §2`） | 顧客の唯一識別（PIIなし）。パス `user/{client_id}/date/{YYYY_MM_DD}/` |
| `format_id` | HealthCheckupData / BloodTestData / CancerRiskAssessmentData / GeneticTestResultData / LifestyleQuestionnaireData / Other | 検査種別（＋日付フォルダで「いつの回か」を分離） |
| `source_ref` | 元S3キー | 突合（ウェルネス年齢等の派生生成時） |

---

## 2. 相関マップ（どのIDが何を結ぶか）

```
[PII / customer]                         [橋渡し]                 [非PII / diagnosis]
 auth.users.id ──▶ customer_profiles.customer_id ─┐
                                     │            │  diagnostic_user_id  ┌─▶ app_users.diagnostic_user_id
                                     │            └──────(唯一の連携キー)─┤   ├─ sessions / test_artifacts
 orders.order_id ─(customer_id)──────┤                                   │   └─ diagnosis_results
                                     │                                   │
 subscriptions.id ─(plan_id)─▶ subscription_plans.id                     │
    │  └─(plan_composition_id 版pin)                                     │
    ▼                                                                    │
 kit_shipments.id ─(subscription_id, year/seq = 回)─(lab_company_id)     │
    │                                                                    │
    ▼                                                                    │
 lab_tests.id ─(shipment_id)─(lab_company_id)─(diagnostic_user_id)───────┘
    │   ├─ external_test_id     ◀── 各検査会社の独自ID
    │   └─ external_barcode     ◀── 検査キット物理ID(バーコード/POS)
    │          └─ プリベント：バーコードNo.(=ユーザーID・704000+3桁)
    │             **受取時にユーザーが撮影して紐づけ（実装済・既定 off）**
    ▼
 各社上りID：LAiF整理番号（= Wellfort採番の仮名値）
    ※ プリベントは②を使わない。往復キーは上の external_barcode（先方発行・確定 2026-10）
    ▼
 Elith S3：client_id(=diagnostic_user_id) + format_id + date
    ▼
 ⑥Elith下りPDF ─(diagnostic_user_id / 検査日 でひも付け・受取仕様は未確定=master §9)
```

- **回（cycle）の識別**＝`subscriptions.current_cycle_year/seq` ＝ `kit_shipments.subscription_year/seq` ＝ Elith の**日付フォルダ**。IDではなく (契約ID×年×連番×日付) で回を特定する。
- **1ユーザーの通しキー**＝`diagnostic_user_id`（通年不変）。**回ごとの分離は日付**（Elith §3）。

---

## 3. PII 境界（持ち出し可否）

| 区分 | ID | 外部/S3/Elith 持出 |
|---|---|---|
| PII側（持出不可） | `customer_id`・`user_id`・`order_id`・氏名/住所/連絡先 | ✕ |
| 非PII（持出可） | **`diagnostic_user_id`（=client_id）**・整理番号(仮名)・format_id・日付・検査種別 | ○ |
| PII例外（限定持出） | **生年月日**（LAiF/プリベント上りCSVのみ・発注者決定・ポータル保護・同意前提） | △（限定） |

---

## 4. 採番方針（現時点＝全て Wellfort 側で制御）

- **顧客ID / 診断ユーザーID / 注文ID / 契約ID / 出荷ID / 検査ID / 各社上りID（整理番号等）** は**すべて Wellfort が採番・管理**。
- `diagnostic_user_id` は **App 側 Edge Function（`verify-eligibility`）で uuid 発行**し、HP `customer_profiles` に同期（`data_integration_requirements §EF`）。
- 各社へ渡す識別子は会社ごとに別体系。**LAiF の整理番号は Wellfort 採番の仮名値**（各社自社連番に依存しない）。
  **プリベントは例外（確定 2026-10・先方要望）** — 往復キーは**先方発行のバーコードNo.**
  （= ユーザーID・`704000`＋3桁・`lab_tests.external_barcode`）で、**当社は整理番号／会員IDを採番しない**。
  正本 = `docs/lab/lab_data_pipeline_master_spec.md §4-5.3`。

## 5. 【将来】外部ID・キット物理IDとの連携（受け皿は実装済＝いま設計変更不要）

> 現時点は全ID自前採番だが、以下の**プレースホルダは既にスキーマに存在**する（`supabase-customer.ts` 実在）。
> 将来この2系統が来ても、**Wellfort採番の内部IDを主キーに保ったまま外部IDを"別名(alias)"として紐付ける**方針で吸収する（内部IDを外部IDに置換しない）。

| 将来の外部ID | 受け皿カラム（実在） | 使い方 |
|---|---|---|
| **各検査会社の独自ID** | `lab_tests.external_test_id`（nullable）／会社別の様式は `lab_companies.external_id_label` `external_id_pattern` | 検査会社が結果に付す固有ID。受領時に `lab_tests` へ格納し内部 `id`/`diagnostic_user_id` と対応づけ（照合・突合に使用） |
| **検査キットの物理ID（バーコード/POS）** | `lab_tests.external_barcode`（nullable） | ユーザー送付キットの実体（同梱バーコード/POS）。**キット受取・検体返送のスキャンで検体と会員を確実に紐付け**（誤割当防止＝`lab_integration_workflow` の PII 制約と整合） |
| （配送の追跡番号） | `kit_shipments.tracking_no` `carrier` | ※物流用。キット物理IDとは別。既に外部採番を格納中 |

- **想定フロー（将来）**: 出荷時に `external_barcode` をキットへ印字/貼付→ユーザー受取/返送時にスキャン→検査会社が `external_test_id` を採番→結果受領時に両IDを `lab_tests` に確定。**内部 `diagnostic_user_id` を軸に、外部2IDは補助照合キー**として持つ。
- **キット構成の版管理**（(c)§6.1 `test_kits.kit_code`）は**キット"種別"のコード**であり、上記の**"個体"物理ID（barcode/POS）とは別レイヤ**。混同しない。

## 6. 命名・整合の注意
- 正カラム＝**`diagnostic_user_id`**（`diagnosis_user_id` は `data_integration_requirements.md` 内の旧表記の揺れ・同義）。
- 「プラン」表現が2系統（`subscription_plans` / EC `test_products`）。**対応関係の整合は §7**。

## 7. 確認事項
1. **プラン表現の整合**: `subscription_plans.id`（契約プランマスタ）と EC `test_products.id`（(c)§1.1）の対応（同一か／FK 化するか）。
2. ~~**プリベント**の上りID採番元~~ → **解決（確定 2026-10）**: 採番しない。**先方発行のバーコードNo.**
   （`704000`＋3桁・現物確認済み）を往復キーにする（`lab_data_pipeline_master_spec.md §4-5.3`）。
   **Genoplan の上りID採番元は引き続き要確認**（(b)§7-4）。
3. **将来の外部ID運用**: `external_test_id`/`external_barcode` の**採番タイミング・スキャン工程・突合ルール**（キット個体IDの印字/貼付方式＝POS仕様）。
4. **⑥ Elith 下りPDF のひも付け**: `diagnostic_user_id`＋検査日で確定（受取仕様未確定＝`lab_data_pipeline_master_spec §9`）。
</content>
