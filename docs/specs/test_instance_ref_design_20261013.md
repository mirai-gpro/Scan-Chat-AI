# ③-1 `test_instance_ref` 設計案（「1回・1検査」の cross-system 正本キー）

| 項目 | 内容 |
|---|---|
| 版 | **v0.1 設計案（2026-10-13）。実装なし・migration なし** |
| 目的 | `test_instance_ref → lab_tests.id → 出荷 → 受取撮影 → 問診 → 結果` を **4 検査共通の骨格**にする |
| 発注者の確定原則 | `orders.id` 単独は使わない／`shipment_id` を検査インスタンスIDに流用しない／`diagnostic_user_id`（人単位）は使わない／**日付や「最新」での推定相関は禁止**／プリベント専用設計にしない／血液・プリベント・LAiF・Genoplan 共通／問診は **link table 型**／1 問診 → 複数検査を表現可能／③-1 導入後は **出荷側が `lab_tests` 行を先に作り、受取撮影は新規作成せず更新** |
| 上位 | `docs/lab/lab_data_pipeline_master_spec.md` §4-5 ／ `docs/lab/kit_receipt_external_id_capture_spec.md` §7.1.2（相関の裁定） |
| この文書の性格 | **調査結果（A/B）は実コードの実測。C 以降は案であって確定ではない。** |

---

## A. 現在の実データモデル（実測）

### A-1. いちばん重要な事実 3 つ

| # | 事実 | 根拠 |
|---|---|---|
| 1 | **「1回・1検査」を表す行は、本番のどこにも無い。** 出荷も進捗も**注文（プラン）単位**で動いている | `app_bridge.refresh_kit_shipment()` が `public.orders` 1 行 → `app_bridge.kit_shipment` 1 行（wellfort-site `supabase/migrations/20260905000010_wellfort_baseline.sql:596-637`）／出荷指示 CSV も `orders.map()` で **1 注文 = 1 行 = 1 JAN**（同 `supabase/functions/generate-shipping-csv/index.ts:254-255`） |
| 2 | **回（サイクル）単位の DDL は既に在るが、行が 0 件。** `kit_shipment_schedule` の UNIQUE が **まさに「1回・1キット」** | wellfort-site `supabase/migrations/20260910000020_kit_lifecycle_model.sql:52-68`（`UNIQUE (subscription_id, cycle_year, cycle_seq, kit_id)`）。0 件であることは `docs/subscription/検査キット_データモデル_仕様書.md` の実測記録 |
| 3 | **`customer.lab_tests` はほぼ使われていない。** INSERT は 1 か所（受取撮影・2026-10-11 追加）、SELECT は 1 か所だけ | INSERT = `src/lib/external-id-persist.ts:371`／SELECT = `src/lib/chat-context.ts:79`。結果受領 4 経路はどこも `lab_tests` に書かない（下記 A-5） |

### A-2. `customer.lab_tests`（Scan-Chat-AI・`customer` スキーマ）

`supabase/migrations/20260601000010_schemas_and_tables.sql:143-165`

| 列 | 型 | 備考 |
|---|---|---|
| `id` | **uuid PK `default gen_random_uuid()`** | `:144` |
| `shipment_id` | uuid → `customer.kit_shipments(id)`（**nullable**） | `:145` |
| `customer_id` | uuid **NOT NULL** → `customer_profiles(user_id)` | `:146` |
| `diagnostic_user_id` | uuid **NOT NULL**（人単位） | `:147` |
| `lab_company_id` | uuid **NOT NULL** → `lab_companies(id)` | `:148` |
| `test_type` | text NOT NULL | `:149` |
| `external_test_id` / `external_barcode` | text | `:150-151`。`unique (lab_company_id, external_test_id)` `:161` |
| `status` | `pending｜in_lab｜reported｜imported｜failed` | `:154-155` |

- **回（cycle）を表す列が無い。** `sampled_at` / `reported_at` は日付で、回の識別子ではない。
- **生成箇所は 1 つだけ**: `external-id-persist.ts:371`（受取撮影の登録時）。
  そこは NOT NULL FK を満たすために `customer_profiles` と `lab_companies` を引き直し、
  揃わなければ **`deferred` にして行を作らない**（同 `:344-348`）。
  `shipment_id` は **`customer.kit_shipments` に実在を確かめた時だけ**入れる（同 `:365-368`）。
- 唯一の読み手は AI問診の「実施検査」供給（`chat-context.ts:72-92`）。
  `diagnostic_user_id` で引いて `status` が active なものを優先するだけで、**回は見ていない**。

### A-3. `orders` / `order_items`（wellfort-site・`public`）

`supabase/migrations/20260905000010_wellfort_baseline.sql`

| | 内容 |
|---|---|
| `orders` `:333-370` | `id uuid` / `order_number text` / **`test_product_id uuid`（単数）** / `subscription_id` / `billing_sequence int default 1` / `is_subscription bool` / `shipping_status` / `tracking_number` / `shipped_at` / **`user_received_at` / `user_returned_at`** |
| `order_items` `:306-314` | `id` / `order_id` / `product_id` / `quantity` / `price` |

- **1 注文に複数検査が入り得る構造は `order_items` が持っているが、実際には使われていない。**
  ブリッジは `orders.test_product_id → test_products.category` を 1 つだけ採る（`:610`）。
  出荷指示 CSV も `orders.test_products.jan_code` を 1 つだけ採る（`generate-shipping-csv/index.ts:254-255`）。
- **検査商品から `lab_tests` へ展開できる既存情報**は `plan_composition_items`
  （`20260910000010_kit_composition_model.sql:92-104`: `composition_id × kit_id × qty_per_year × ship_rule`）
  と `test_kits`（同 `:37-47`: `kit_code` / `lab_company` / **`format_id`**）。
  **これが「1 プラン → 何の検査が何回」の唯一の機械可読な根拠**。ただし**行は 0 件**（seed 未投入）。
- → **`orders.id` 単独では回も検査も特定できない**（発注者原則の裏付け）。

### A-4. 出荷・受取の単位（`kit_shipments` と `shipment_ref`）

| 層 | 実体 | 粒度 |
|---|---|---|
| wellfort-site `public.orders` | 正本 | **注文（プラン）単位** |
| `app_bridge.kit_shipment` | read-only ミラー。**`id` = `orders.id`（`:607`）** | 注文単位（`refresh_kit_shipment()` `:607`） |
| Scan-Chat-AI `customer.kit_shipments` | 旧設計の表（`20260601000010:112-130`）。`subscription_year` / `subscription_seq` 列は**在る** | 設計上は回単位 |
| Scan-Chat-AI が実際に読むもの | `bridge-queries.adaptShipment()` | **注文単位を kit_shipments の形に見せかけている** |

`src/lib/bridge-queries.ts:70-95` の実測:

- `id` = ブリッジ行の id（= `orders.id`）／`customer_id` には **`diagnostic_user_id`** が入る（`:74`）
- `lab_company_id: ''`（`:75`）／`subscription_year: null` `subscription_seq: null`（`:78-79`）
- `lab_received_at: null` `lab_completed_at: null`（`:92-93`）

→ **`shipment_ref`（受取確認の対象 ID）は本番では `orders.id`** であり、
`customer.kit_shipments` には**存在しない**（`external-id-persist.ts:18-21` に同じ記録）。
**1 shipment に複数検査が入り得る**（コースプランの 1 注文で がん＋血液＋遺伝子）。
→ **`shipment_id` を検査インスタンスIDに流用できない**（発注者原則の裏付け）。

### A-5. 結果受領が `lab_tests.id` へ戻る経路（実測＝**どれも戻っていない**）

| 検査 | 受領の実装 | `lab_tests` を触るか | 実際の着地 |
|---|---|---|---|
| プリベント（がん・尿） | Partner Portal の Presigned PUT → S3 `quarantine/prevent/`（`src/lib/laif-portal.ts:149-183`） | **0 件** | S3 に置くだけ。admin が手で `test_artifacts` へ |
| 血液（デメカル） | 結果CSV 取込（`src/lib/elith-blood-csv.ts`） | **0 件**（`:171` に「**将来** lab_tests への割当に使用」とコメントのみ） | `test_artifacts` / `measurement_values` |
| LAiF（AI疾病予測） | 同 Partner Portal | **0 件** | 同上 |
| Genoplan（遺伝子） | API 取得（`src/pages/api/admin/genoplan-fetch.ts`） | **0 件** | S3 原本＋横の JSON に `external_test_id` / `external_barcode` を控えるだけ。`:281` に「**顧客への割り当ては未実施**」 |
| 原本登録（共通） | `src/pages/api/admin/lab-results/register.ts` | **0 件** | `diagnosis.test_artifact_files`。`:12-21`「**既存の artifact に足す。勝手に作らない**」 |

**結果の正本は `diagnosis.test_artifacts`** で、その同一性は
`unique (diagnostic_user_id, source, test_type, test_date, external_test_id)`（`20260601000010:208`）。
**`source` を含み `external_test_id` が NULL でも通る**ので、回の識別子としては弱い。

### A-6. 問診

| | 実測 |
|---|---|
| 完了記録 | `diagnosis.interview_completions`（`20260915000010`）。列は `diagnostic_user_id` / `completed_at` / `answered_count` / **`diagnostic_id text`** / `created_at`。**`lab_test_id` も `shipment_ref` も無い** |
| 書き込み | `src/lib/interview-completion.ts:44-70`。**append-only な INSERT**（1 完了 = 1 行）。例外を投げない |
| `diagnostic_id` の出所 | **クライアント申告**（`src/pages/api/interview/export.ts:110` = `str(body.diagnosticId) ?? crypto.randomUUID()`）。**unique 制約も無い**（`20260915000010:32`） |
| 回答本文 | **S3 のみ**。`{prefix}user/{uid}/date/{YYYY_MM_DD}/LifestyleQuestionnaireData_date_..._user_{uid}.json`（`src/lib/interview-export.ts:274-293`）。JSON 内に `diagnostic_id` が入る（`:258`） |
| 対象検査を知り得るか | **`chat-context.ts:72-92` が既に `customer.lab_tests` を引いている**（`EXAM-TYPE` の供給）。ただし `diagnostic_user_id` で引くだけで**回を見ていない**。取れなければ `EXAM-TYPE` を利用者に尋ねる（`interview-script.ts:524-531`）＝**利用者の自己申告も存在する** |
| 回（サイクル）判定 | `src/lib/interview-cycle.ts`。`cycleStart` は `subscription.last_test_at` → `started_at` の**暫定アンカー**で、取れなければ **`done_this_cycle` へ倒す fail-safe**（`:40-43`）。**ゲートに使ってはいけない向き** |

---

## B. 境界ごとの既存 ID（どこで何が切れているか）

| 境界 | 上流が持つ ID | 下流が持つ ID | 切れ目 |
|---|---|---|---|
| EC 注文 → 出荷指示 | `orders.id` / `order_number` / `test_product_id` | タカセ CSV（JAN 1 つ） | **検査ごとに分かれない**（1 注文 = 1 行） |
| 出荷 → アプリ進捗 | `orders.id` | `app_bridge.kit_shipment.id`（= `orders.id`） | **回も検査も載らない**（`test_type` は `test_products.category` の日本語） |
| アプリ進捗 → 受取撮影 | `shipment_ref`（= `orders.id`） | `lab_test_id_captures.shipment_ref` | 1 shipment に複数検査 → **どの検査か決まらない** |
| 受取撮影 → `lab_tests` | `lab_test_id_captures.lab_test_id` | `lab_tests.id` | **撮影側が行を作っている**（本来は出荷側） |
| `lab_tests` → 問診 | なし | なし | **完全に切断**（§A-6） |
| 問診 → 各社 | `diagnostic_id`（クライアント申告） | プリベント CSV の バーコードNo. | 相関不能 → 現在 fail-closed |
| 各社 → 結果 | ベンダー番号（バーコードNo. / 指図番号 / serialNumber＋boxNumber） | `test_artifacts` | **`lab_tests.id` へ戻る経路が 0 件**（§A-5） |

---

## C. `test_instance_ref` の候補（3 案）

### 案 A — **`customer.lab_tests.id` をそのまま cross-system 正本キーにする**（新キーを作らない）

出荷側（wellfort-site）が Scan-Chat-AI の新 admin API を**同期で**叩いて `lab_tests` 行を作り、
返った `id` を自分側に控える。`test_instance_ref` という別概念を作らない。

### 案 B — **`test_instance_ref uuid` を独立したキーとして持つ**（**推奨**）

「1回・1検査」を表す値を**出荷側がローカルで発番**し、両側の行がその値を持つ。
`lab_tests` には `test_instance_ref` 列（unique）として載せる。

### 案 C — **`kit_shipment_schedule.id` を流用する**

既存 DDL の `UNIQUE (subscription_id, cycle_year, cycle_seq, kit_id)` がまさに 1回・1検査なので、
その PK を ref として配る。

### 比較

| 比較項目 | 案 A（`lab_tests.id`） | 案 B（独立 ref・**推奨**） | 案 C（`schedule.id`） |
|---|---|---|---|
| DB 型 | uuid（既存 PK） | **uuid**（新列） | uuid（既存 PK） |
| UUID か人可読か | UUID | **UUID**（両側で発番するので連番は衝突する。admin 表示は先頭 8 文字で足りる） | UUID |
| 誰が発番するか | **Scan-Chat-AI**（行を作る側）。出荷側は API 経由で頼む | **出荷側（wellfort-site）**。単品・スペシャルは Scan-Chat-AI 側が同じ形式で発番 | wellfort-site |
| いつ発番するか | 出荷指示の送信時（同期 API） | **`kit_shipment_schedule.status: planned → instruction_sent` の瞬間**（§F） | 契約時にスケジュールを展開した時 |
| `lab_tests.id` と同一か | **同一** | **別キー**（`lab_tests` は ref を持つ） | 別キー |
| 外部へ露出するか | しない（外部はベンダー番号） | しない | しない |
| 冪等性 | **自然キーの unique が別途必要**（今の `lab_tests` には回の unique が無い）＝ **migration は避けられない** | `unique (test_instance_ref)` ＋ 発番元の `UNIQUE (subscription, cycle_year, cycle_seq, kit_id)` で**二重発番しない** | schedule の既存 UNIQUE で担保 |
| 再送／再出荷 | 同じ自然キーなら同じ行（upsert） | **再出荷は新しい ref**（＝別インスタンス）。同じ回の**再発送**は schedule 行を分けるか `note` で表すかを別途決める | 同じ |
| 1 注文複数検査 | OK（検査ごとに行） | OK | OK |
| 1 問診複数検査 | link table 側の表現力の話なので同じ | 同じ | 同じ |
| 年跨ぎ | OK（別の行） | OK（別の ref） | OK（`cycle_year` が別） |
| **単品購入・スペシャル**（subscription 無し） | **OK**（Scan 側で作れる） | **OK**（Scan 側でも同形式で発番） | **✗ 不可**。`subscription_id NOT NULL`（`20260910000020:54`）。`kit_lifecycle` / `lab_handoff` も subscription 前提 |
| 出荷が Scan-Chat-AI の可用性に依存するか | **する**（同期 API が出荷のクリティカルパスに入る） | **しない** | しない |
| `lab_tests` の NOT NULL FK を満たせない回 | **ref ごと作れない**（今の `deferred` が残る） | **ref だけ先に確定できる**（`lab_tests` は後から作れる） | 同じく ref は作れる |
| migration 影響 | Scan: `lab_tests` に回の unique ＋ 新 admin API／wellfort: 控え列／ブリッジ拡張 | Scan: `lab_tests.test_instance_ref` ＋ unique、`lab_test_id_captures.test_instance_ref`、`interview_test_links`／wellfort: `kit_shipment_schedule.test_instance_ref` ＋ ブリッジ | wellfort は列不要／Scan 側は案 B と同じ |
| 既存コード変更量 | 中（出荷バッチ ＋ 新 API ＋ 撮影側） | **中**（出荷バッチ ＋ ブリッジ ＋ 撮影側 ＋ 問診） | 小（ただし単品・スペシャルが落ちるので実質不可） |

### 「新しい UUID 列を足せばよい」で済まない点（明示）

- **どの案でも migration は要る。** 案 A は「新列を足さない」が、**回の自然キーに unique が無い**ので
  冪等な upsert ができず、unique index の追加が必須。**新列を避けても migration は避けられない。**
- **案 C は既存 DDL を活かせて一番小さいが、単品購入・スペシャルアカウントを表現できない**
  （`subscription_id NOT NULL`）。**「プリベント専用設計にしない」と同じ理由で、契約者専用設計にもできない。**
- **`lab_tests.id` を ref にすると、ref の発番が「行を作れること」に縛られる。**
  今まさに `customer_profiles` / `lab_companies` が無い環境で `deferred` が起きており
  （`external-id-persist.ts:344-348`）、**ref が作れない＝問診リンクも張れない**状態を引きずる。

---

## D. 推奨案

**案 B（独立した `test_instance_ref uuid` ＋ 出荷側で発番）を推奨します。**

理由を優先順に:

1. **出荷を他システムの可用性に依存させない。** 発番がローカルで完結する（案 A は同期 API が
   物理工程のクリティカルパスに入る）。
2. **`lab_tests` 行が作れない回でもキーだけ先に確定できる。** 現に `deferred` が起きている穴を
   構造的に消す。問診リンクも結果の受け皿も、ref があれば先に張れる。
3. **単品購入・スペシャルアカウントを同じ形式で扱える**（案 C はここで落ちる）。
   `uuid v4` なので**両側で発番しても衝突しない**。
4. **`lab_tests.id` と役割を分けられる。** `lab_tests.id` は Scan-Chat-AI 内部の行 ID のまま、
   `test_instance_ref` が**システムを跨ぐ名前**になる。ID 体系の層別（`id_management_and_correlation_spec.md`）
   と整合する。

**採らなかった案の扱い**: 案 A は「同期呼び出しを出荷パスに入れてよい」と判断するなら成立します
（新概念が増えないのは実際の利点）。案 C は単品・スペシャルを別キーで扱う二重設計を許すなら成立しますが、
**4 検査共通の骨格という目的に反する**ので推しません。

---

## E. migration 案（**この段階では作成しない**）

### E-1. wellfort-site（`public` ＋ `app_bridge`）

```
-- ① 発番元。既存行 0 件なので NOT NULL で入れられる（要・実測の再確認）
alter table public.kit_shipment_schedule
  add column test_instance_ref uuid not null default gen_random_uuid();
create unique index on public.kit_shipment_schedule (test_instance_ref);

-- ② ブリッジ。kit_shipment は注文単位なので**別表にする**（意味を混ぜない）
create table app_bridge.test_instance (
  test_instance_ref  uuid primary key,
  diagnostic_user_id uuid not null,
  order_id           text,          -- orders.order_number（既存ブリッジの流儀に合わせる）
  test_type          text not null, -- **正準コード**（test_kits から引く。category の日本語を流さない）
  lab_company        text,
  format_id          text,
  cycle_year         integer not null,
  cycle_seq          integer not null,
  scheduled_date     date,
  instruction_sent_at timestamptz,
  shipped_at         timestamptz,
  tracking_no        text,
  user_received_at   timestamptz,
  user_returned_at   timestamptz,
  synced_at          timestamptz not null default now()
);
-- refresh_test_instance() を refresh_all() に足す
```

**注意**: `test_type` は**正準コード**（`health_checkup｜blood｜genetics｜cancer_urine｜ai_prediction`）
を流すこと。現行ブリッジは `test_products.category` の**日本語**を流しており、
これが `testTypeLabel` の素通しで生文字列として画面に出る既知の不整合
（`docs/subscription/検査キット_データモデル_仕様書.md` §2.5.1）。**同じ穴を再生産しない。**

### E-2. Scan-Chat-AI（`customer` ＋ `diagnosis`）

```
-- ③ lab_tests に cross-system キーを載せる（nullable で入れて既存行を壊さない）
alter table customer.lab_tests add column test_instance_ref uuid;
create unique index on customer.lab_tests (test_instance_ref)
  where test_instance_ref is not null;

-- ④ 撮影台帳にも控える（監査用・nullable）
alter table customer.lab_test_id_captures add column test_instance_ref uuid;

-- ⑤ 問診 ↔ 検査インスタンスの link table（§H）
create table diagnosis.interview_test_links (
  id                 uuid primary key default gen_random_uuid(),
  diagnostic_id      text not null,
  test_instance_ref  uuid not null,
  diagnostic_user_id uuid not null,   -- 取り違え検知用（冗長だが必須）
  linked_at          timestamptz not null default now(),
  link_source        text not null
                       check (link_source in ('interview_export','admin','backfill')),
  superseded_at      timestamptz,
  note               text,
  unique (diagnostic_id, test_instance_ref)
);
-- **有効な問診は 1 検査につき 1 件**（部分 unique で構造的に担保。最新を採る実装にしない）
create unique index on diagnosis.interview_test_links (test_instance_ref)
  where superseded_at is null;
```

**`customer.kit_shipments` は触らない。** 本番の受取 ID は `orders.id` でこの表に行が無く、
`shipment_id` を埋めに行くと FK 違反になる（`external-id-persist.ts:18-21` の既知事項）。

---

## F. 出荷側で `lab_tests` 行を作る正確なポイント

**発番と行作成は分ける。**

| 段 | どこ | 何をするか |
|---|---|---|
| 1. **ref の確定** | wellfort-site。`kit_shipment_schedule.status: planned → instruction_sent` に落とし **`instruction_sent_at` を立てる同一トランザクション** | ここが**二重出荷防止の実判定点**（`20260910000020:84` のコメント）。ref はこの行の既定値として既に在るので、**確定するのは「出た」という事実**。出荷指示 CSV は**この ref 単位で 1 行**にする（＝ 現行の「1 注文 1 行」を改める） |
| 2. **ブリッジへ出す** | `app_bridge.refresh_test_instance()` | 既存 `refresh_all()` の流儀に合わせる（`:550-559`） |
| 3. **`lab_tests` 行の作成** | Scan-Chat-AI。**ブリッジを読む側の処理**（既存の bridge pull / cron） | `test_instance_ref` で upsert。NOT NULL FK（`customer_profiles` / `lab_companies`）が揃わなければ**作らずに記録だけ残す**（今の `deferred` と同じ fail-safe）。**出荷の同期パスに入れない** |

**単品購入・スペシャルアカウント**（subscription 無し）は 1〜2 を通らないので、
**Scan-Chat-AI 側が発番する**。発番の口は 1 つに集約する（例: `src/lib/test-instance.ts` の
`mintTestInstanceRef()`）。`uuid v4` なので両側発番で衝突しない。

---

## G. 受取撮影側の変更点（`external-id-persist.ts`）

| 現在 | ③-1 後 |
|---|---|
| `linkLabTest()` が**行を新規作成する**（`:371-393`） | **新規作成しない。** `test_instance_ref` で既存行を引いて **UPDATE だけ** |
| 行を使い回す根拠は「同じ `(uid, shipment_ref, provider)` の台帳行が持つ `lab_test_id`」（`:33-38` / §3.2.1） | **根拠が `test_instance_ref` に変わる**ので、この回避策は**不要になる**（年跨ぎで前年を上書きする危険の出どころそのものが消える） |
| `shipment_ref`（= `orders.id`）で台帳を引く | `shipment_ref` は**監査用に残す**。紐づけの主キーは `test_instance_ref` |
| 1 shipment に複数検査があると**どれか決まらない** | **ref が検査を特定する**ので曖昧さが無い |
| 材料が揃わなければ `deferred` | **同じ（fail-safe は維持）**。ただし「行が無い」ではなく「**出荷側の ref がまだ来ていない**」が理由になる |

**受取撮影の UI 側で ref をどう選ぶか**が残る論点。1 shipment に複数検査があるとき、
**利用者に「どの検査の台紙か」を選ばせる**か、**provider から一意に決める**か。
`provider → test_type` は 1:1（`external-test-id.ts:41-44`（`PROVIDER_TEST_TYPE`））なので、
**同じ回に同じ検査が 2 つ無い限り一意に決まる**。決まらない回は `deferred`（推定しない）。

---

## H. 問診 link table 設計

### H-1. 形（§E-2 ⑤）

- **1 問診 → 複数検査**: 同じ `diagnostic_id` で複数行（`unique (diagnostic_id, test_instance_ref)`）
- **1 検査 → 有効な問診は 1 件**: `unique (test_instance_ref) where superseded_at is null`
  → **「最新を採る」実装を書かなくても 1 件に決まる**（これが肝）
- 問診の取り直しは **旧行に `superseded_at` を入れて新行を足す**

### H-2. 書き込み点と「対象検査をどう決めるか」

書き込みは **`/api/interview/export` の `recordInterviewCompletion()` の隣**（同じサーバ処理・
`export.ts:130-136`）。**クライアント申告の `diagnostic_id` をそのまま鍵にしない**のが条件で、
ここは要・裁定の論点です。

| 決め方 | 内容 | 評価 |
|---|---|---|
| **(i) 画面が供給した ref**（推奨の第 1 候補） | `chat-context.ts` が `EXAM-TYPE` 供給のために既に `lab_tests` を引いている。ここを **ref も返す**ように広げ、問診セッションが持っている ref を完了時にそのまま張る | **推定ゼロ**。利用者が見た「今回実施する検査」と一致する |
| **(ii) サーバが引き直す ref** | 完了時に「出荷済み・結果未受領」の ref を**サーバ側で引き直して**全部に張る（1 問診 → 複数検査） | 画面申告を信じない点で安全。ただし「出荷済み・結果未受領」が**複数回ぶん**在る回に曖昧さが残る |
| **(iii) admin が後から張る** | 訂正経路（`link_source='admin'`） | **必須**（例外系の出口。`review_required` の訂正経路と同じ思想） |
| **(iv) 日時・最新で推定** | — | **禁止**（発注者原則） |

**推奨**: **(i) を主・(ii) を保険・(iii) を訂正**。(i) と (ii) が食い違う回は**張らずに
`admin` へ回す**（fail-closed）。`diagnostic_id` は **サーバ側で採番する**よう
`export.ts:110` を改める（クライアント申告を鍵にしない）。

### H-3. プリベント CSV 側の差し替え点

`src/lib/prevent-interview-link.ts` の **`findInterviewLink()` の中だけ**を
`interview_test_links` の照会へ置き換える（`lab_test_id` → `test_instance_ref` → 有効な
`diagnostic_id` 1 件）。**`pickInterviewByLink()`（完全一致でしか選ばない）と
呼び出し側の fail-closed は変えない。**

---

## I. 4 検査への適用

| 検査 | 出荷／開始点 | ref の発番 | 受取撮影 | 問診 | 結果 → ref へ戻す |
|---|---|---|---|---|---|
| **がんリスク（プリベント）** | タカセ発送（`ship_rule='every'`） | 出荷側 | **実装済**（`labid.prevent_capture` 既定 off）。ref で UPDATE に変える | **要**（CSV の前提） | Portal の結果PDF に ref を結ぶ（**未実装**・別フェーズ） |
| **血液（デメカル / リージャー）** | タカセ発送（`every`） | 出荷側 | 実装済（`labid.demecal_capture` 既定 off・Secondary） | **弊社から渡さない**（紙同梱） | 結果CSV の `指図番号` → ref（`elith-blood-csv.ts:171` の「将来」をここで実現） |
| **AI疾病予測（LAiF）** | **物理発送なし**（`ship_rule='none'` / `test_kits.kind='data'`） | 出荷側（スケジュール展開時） | **無い**（撮る物が無い） | **要**（所定 XLSX） | Portal の結果PDF に ref を結ぶ |
| **遺伝子（Genoplan）** | **初回のみ発送**（`ship_rule='first_only'`） | 出荷側 | **採らない**（正本はタカセ返送CSV 方式） | **弊社から渡さない**（先方 Web で本人入力） | API 取得の `boxNumber` / `serialNumber` → ref（`genoplan-fetch.ts:274-275` の控えを割り当てに使う） |

**撮影が無い検査（LAiF・Genoplan）でも ref は存在する**のがこの設計の要点。
「撮影された番号」ではなく「**出荷側が作った回の識別子**」が骨格なので、4 検査で形が揃う。

---

## J. 後方互換

| 対象 | 扱い |
|---|---|
| 既存の `lab_tests` 行（ref が NULL） | **そのまま**。`test_instance_ref` は nullable・部分 unique なので既存行は無害 |
| 既存の `lab_test_id_captures` 行 | **そのまま**。ref は nullable |
| プリベント問診CSV | **現状維持（fail-closed）**。`findInterviewLink()` が `not_correlated` を返す限り出ない。`labid.prevent_csv_release` は **off のまま** |
| `chat-context.ts` の `EXAM-TYPE` 供給 | ref を**足すだけ**。既存の戻り値は変えない |
| `app_bridge.kit_shipment` | **触らない**（注文単位のまま）。新表 `test_instance` を**足す** |
| `customer.kit_shipments` | **触らない**（本番に行が無い） |
| ダッシュボードの進捗 | ref が無い間は従来表示。ref が入ってから回単位へ寄せる（**別フェーズ**） |
| backfill | **しない**（`link_source='backfill'` は枠だけ用意）。過去の問診と過去の検査を**日時で結ぶのは禁止**なので、遡及が必要なら admin が 1 件ずつ |

---

## K. 実装順序（案）

| # | 内容 | 置き場所 | 依存 |
|---|---|---|---|
| 1 | **`test_kits` / `plan_compositions` / `plan_composition_items` の seed 投入**（現在 0 件） | wellfort-site（DB 作業） | これが無いと回の展開ができない |
| 2 | `kit_shipment_schedule` の展開（契約時にプラン構成から各回を作る） | wellfort-site | 1 |
| 3 | **ref 列 ＋ ブリッジ新表 ＋ `refresh_test_instance()`** | wellfort-site migration | 2 |
| 4 | **`lab_tests.test_instance_ref` / `lab_test_id_captures.test_instance_ref`** | Scan-Chat-AI migration | — |
| 5 | ブリッジを読んで `lab_tests` を upsert（**出荷の同期パスに入れない**） | Scan-Chat-AI | 3・4 |
| 6 | **受取撮影を「更新のみ」へ**（§G） | Scan-Chat-AI | 4・5 |
| 7 | **`interview_test_links` ＋ 問診完了時のリンク**（§H。`diagnostic_id` のサーバ採番も） | Scan-Chat-AI | 4 |
| 8 | `findInterviewLink()` を link table 照会へ差し替え | Scan-Chat-AI | 7 |
| 9 | 出荷指示 CSV を **ref 単位 1 行**へ（現行は 1 注文 1 行） | wellfort-site | 3 |
| 10 | 結果受領 4 経路を ref へ戻す（**別フェーズ**） | Scan-Chat-AI | 5 |
| 11 | ALA摂取日時・採尿日時を **ref に紐づく工程データ**として取る（§A-6 の裁定） | 両方 | 5 |

**6 と 7 が入った時点で、プリベント問診CSV の相関が成立します**（＝ `#321` で fail-closed に
してある部分が開く）。ただし**配布は `labid.prevent_csv_release` が別に閉じている**ので、
様式確定（別タスク）まで外へは出ません。

---

## 要・裁定（この設計案で決めきれていないもの）

1. **案 A / B / C のどれを採るか**（推奨は B・§D）
2. **問診の対象検査の決め方**（§H-2 の (i)(ii)(iii) の組み合わせ）
3. **`diagnostic_id` をサーバ採番に変えるか**（現在はクライアント申告・`export.ts:110`）
4. **同じ回の「再発送」をどう表すか**（新しい ref か、同じ ref のまま出荷履歴を分けるか）
5. **受取撮影で 1 shipment に同じ検査が 2 つある回の扱い**（`deferred` 固定でよいか）
6. **`test_kits` / `plan_compositions` の seed 投入**（K-1。これが無いと ③-1 全体が動かない）

**この版では migration もソースも変更していません。**
