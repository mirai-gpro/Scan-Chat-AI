# レビュー依頼: サブスク → 検査キット → 進捗 データモデル 仕様書

- 日付: 2026-09-10
- 依頼先: ChatGPT（**両リポジトリを読める前提**）
- 対象: `Scan-Chat-AI/docs/subscription/検査キット_データモデル_仕様書.md`
- **この依頼は「仕様書の内容が事実として正しいか」の検証です。実装・修正は求めていません。**

---

## 0. 何を見てほしいか（結論から）

この仕様書は、`/kit` に「がん検査 / 検査会社未定」が最大 10 件並ぶ事象の調査から起票したものですが、
調査の途中で**原因が個別のバグではなく、契約→キット→進捗の背骨のデータモデルの差**だと分かったため、
恒久的な参照先として書いたものです。

見てほしいのは 3 点です。

1. **事実として誤っている記述はないか。** 引用した `file:line` を実際に開いて突き合わせてください。
2. **「確定 / 高確度 / 未確認」の切り分けが妥当か。** とくに**確定と書きすぎている箇所**を指摘してください。
3. **因果の連鎖に抜けはないか。** 10 件表示に寄与する経路を他に見落としていないか。

**私は既にこの調査で 1 度、検証不足による誤りを出しています**（§5 に詳述）。同種の見落としを疑ってください。

---

## 1. 読む順番

| # | ファイル | 役割 |
|---|---|---|
| 1 | `Scan-Chat-AI/docs/subscription/検査キット_データモデル_仕様書.md` | **レビュー対象（本体）** |
| 2 | `Scan-Chat-AI/docs/subscription/kit_lifecycle_and_handoff_management_spec.md` §1・§6 | 目標モデルの正本 |
| 3 | `Scan-Chat-AI/docs/architecture/bridge_table_design_draft.md` v0.3 | 現行 bridge が `orders` 由来になった経緯 |
| 4 | `Scan-Chat-AI/docs/subscription/kit_progress_ui_spec.md` / `docs/lab/kit_progress_management.md` | UI 仕様・旧進捗仕様 |
| 5 | `wellfort-site/docs/payment/ec_order_on_payment_success_spec.md` | 注文生成の仕様（実装が反している） |

---

## 2. 前提（誤解しやすいので先に）

- **データベースは 2 つある。**
  - **HP/EC DB**（`nlydlveiokiivjwpnnaf` / wellfort）: `public.*` ＋ `app_bridge.*`
  - **アプリ DB**（Scan-Chat-AI）: `customer.*` ＋ `diagnosis.*`
- **`/kit` が読むのは HP/EC DB の `app_bridge` だけ。**
- **同名に見えて別物のテーブルが 2 つある。**
  - `app_bridge.kit_shipment`（**単数**・HP/EC DB・**使用中**・回の列なし）
  - `customer.kit_shipments`（**複数**・アプリ DB・回の列あり・**読まれていない**）
  - **既存の仕様書の一部が後者を指して「既存列だから集約するだけでよい」と読める記述になっています**（仕様書 §7）。ここは意図的に固定しました。
- **本番スキーマの正**: `wellfort-site/supabase/migrations/20260905000010_wellfort_baseline.sql`。
  冒頭に**本番のスキーマダンプである旨と出典**（`wellfort_prod_schema_all_20260905.sql`・2026-09-05 取得）が明記されています。
- **今回は調査のみ。** コード・SQL・migration・DB は一切変更していません（仕様書とこの依頼文だけ）。

---

## 3. 独立に検証してほしい主張（実測と称している箇所）

**すべて「開けば真偽が分かる」ものにしてあります。** 1 つずつ潰してください。

| # | 主張 | 出典 |
|---|---|---|
| A-1 | 目標モデルの 7 つ（`test_kits` / `plan_compositions` / `plan_composition_items` / `subscriptions.plan_composition_id` / `kit_shipment_schedule` / `kit_lifecycle` / `lab_handoff`）は**両リポジトリに実在 0 件** | 全文検索 |
| A-2 | migrations は**環境別に分かれていない 1 セット**なので staging も本番も同じ | `wellfort-site/supabase/` の構成 |
| A-3 | 本番スキーマのテーブルは **19 本**で、キット系は `app_bridge.kit_shipment` の 1 本だけ | baseline dump |
| B-1 | `app_bridge.kit_shipment` は **12 列**で、`subscription_id` / `billing_sequence` / 検査会社 / 回 を持たない | baseline `:149-162` |
| B-2 | 同期は `id = o.id` なので **1 注文 = 1 行**が構造として確定 | baseline `:596-638` |
| B-3 | 同期の絞り込みは **`o.user_id IS NOT NULL` だけ**で `payment_status` を見ていない | 同上 |
| B-4 | **`orders` には `subscription_id` と `billing_sequence` が実在する**のに、この SELECT が拾っていない | baseline の `orders` 定義 + 同 SELECT |
| C-1 | 読み取りは `.limit(10)` で、回・状態・決済のいずれでも絞っていない | `Scan-Chat-AI/src/lib/bridge-queries.ts:131-137` |
| C-2 | `adaptShipment` が `lab_received_at` / `lab_completed_at` / `lab_name` を **null 固定** | 同 `:92-93`, `:97` |
| C-3 | `検査会社未定` は `lab_name` が null のときの UI fallback | `KitProgressCard.astro:75` / `kit.astro:170` |
| **D-1** | **`testTypeLabel` が未知の値を素通しする**（`map[type] ?? { name: type }`） | `src/lib/dashboard-queries.ts:479` |
| **D-2** | 正準コードは 5 つ（`health_checkup`/`blood`/`genetics`/`cancer_urine`/`ai_prediction`）だが、bridge が渡すのは `tp.category`（**日本語の商品カテゴリ**）で、`adaptShipment` は変換しない | 同 `:471-478` / `bridge-queries.ts:76` |
| **D-3** | ゆえに **bridge 由来の全行が DB の生文字列をそのまま描いている**。正規化は経路のどこにも無い | D-1 + D-2 |
| **D-4** | **デモデータは正準コードを使っている**ので、**デモでは正しいラベルが出て本番だけ生文字列になる** | `src/lib/demo-data.ts:203-224` |
| **D-5** | **「がん検査」という文字列は両リポジトリの `src/` に 0 件**（ヒットは LP・プライバシーポリシー・Figma 生 HTML のみ） | 全文検索 |
| E-1 | `create-order` は **決済前に** `payment_status: 'pending'` で `orders` を INSERT する | `wellfort-site/supabase/functions/create-order/index.ts:233-242` |
| E-2 | これは仕様に反する（仕様は「DB へ一切書かない」「中間ステータスを持たない」） | `docs/payment/ec_order_on_payment_success_spec.md §2.1` |
| E-3 | 注文番号の形式 `WF-YYYYMMDD-<6文字>` は同ファイル `:168` の生成式と一致する | 同 `:168` |

---

## 4. 重点的に意見がほしい論点（自信の低い順）

### 論点 1: 同期がいつ走るのか（**私は答えを出せていません**）

- `app_bridge.refresh_all()` が 3 つの refresh を束ねている（baseline `:550-557`）。
- **しかし `refresh_all` / `refresh_kit_shipment` を呼ぶコードは、両リポジトリに 0 件**でした
  （`src/` / `supabase/functions/` / `.github/` を検索）。
- `orders` に同期トリガも **0 件**。
- 一方で **`pg_cron` は本番で有効**（baseline `:84` `CREATE EXTENSION ... pg_cron`）。
  ただし**スケジュールの実体は `cron.job` のデータ**なので、スキーマダンプには写りません。
- `bridge_table_design_draft.md §6` は「顧客・プラン=日次 / 発送=取込イベント駆動 or 15〜30分間隔」と**設計**しています。

**聞きたいこと**: リポジトリだけから同期の駆動元を特定する方法は他にありますか。
それとも**これは DB を見ないと確定できない**（＝仕様書に未確認として残すのが正しい）という判断で合っていますか。
**これが分からないと「10 件が増え続けるのか、ある時点のスナップショットなのか」が言えません。**

### 論点 2: 10 件表示の因果に、他の寄与経路はないか

仕様書 §6.1 は「`.limit(10)` の上限 × 1 注文 1 行 × 未決済も入る」で説明しています。
**他に行を増やす経路を見落としていませんか。** とくに:

- `refresh_kit_shipment` は `ON CONFLICT (id) DO UPDATE` なので**同一注文で行は増えない**はず → この読みは正しいですか。
- Amazon Pay の決済方法選択で追加の `orders` が生成される可能性
  （`wellfort-site/docs/payment/amazon-pay-handoff-20260909.md`）。
  **私はこれを「未確認・主因と決めつけない」として分離しました**が、分離の判断は妥当ですか。

### 論点 3: 埋め方 3 案（§8）の切り方

案 A（表示だけ）/ A′（語彙の是正）/ B（bridge に回を運ぶ）/ C（目標モデル実装）。

- **案 B のコストを「見た目より低い」と書いた**根拠は「`orders` に列が既に在るから運ぶだけ」ですが、
  この見立ては甘くないですか（列追加・関数変更・型・読み取りの 4 箇所に及びます）。
- **案 A だけを採ると「直ったように見えて差が残る」**と警告を書きましたが、警告の書き方として足りていますか。

### 論点 4: 「暫定策の記録」という §5 の主張

現行 bridge は手抜きでなく、`bridge_table_design_draft.md` v0.3 の**意図的な決定**で、
「検査完了ステージは #2 `test_artifacts` から取得」という**分担の片側が未実装のまま**である、と書きました。

**この読み方は原典に照らして妥当ですか。** 私が経緯を good-faith に解釈しすぎている可能性を疑ってください。

---

## 5. 私が既に 1 度誤った箇所（同種の見落としを疑ってほしい）

初版で **「『がん検査』は `test_products.category` 由来（高確度）」** と書きました。**これは検証不足でした。**

- **文字列そのものを grep していなかった。** 引いたら**コードに 0 件**（D-5）。
- 発注者からの指摘 —「**現在の商品・検査プランに『がん検査』という検査項目は無い。
  該当するのは がんリスク（尿）プリベント（ALA-PDS）だけ**」— で撤回し、再検証して D-1〜D-4 に至りました。
- 真因は**語彙の食い違い + 素通しフォールバック**で、**表示の付け方ではなくデータの中身の問題**でした。

**教訓として共有します**: 「構造上ここしかない」という消去法で出どころを断定し、
**その文字列が実在するかを引かなかった**のが誤りの型です。
**同じ型の推論が他に残っていないか**を重点的に見てください。

---

## 6. 未確認として残しているもの（DB 接続が無いため）

このセッションには **staging / 本番の DB 接続がありません**（資格情報は Vercel の環境変数のみ）。
以下は仕様書でも「未確認」と明示しています。**ここを推測で埋めないでください。**

1. `test_products.category` の**実値**（→ 画面に出ている文字列そのもの）。
2. 対象利用者の `orders` の実行数・`payment_status` / `billing_sequence` の内訳。
3. 10 件が「別注文 10 件」なのか他の形なのか。
4. 同期の駆動元（論点 1）。
5. **2026-09-05 のダンプ以降に、migration を通さない手作業の DDL が当たっていないか。**

**逆に「DB を見なくてもコードだけで確定できるのに、私が未確認に落としているもの」があれば指摘してください。**
それが一番ありがたい指摘です。

---

## 7. 出力してほしい形

1. **事実誤認**（あれば）: 主張番号（A-1 等）＋ 正しい内容 ＋ 根拠の `file:line`。
2. **確度の格下げ / 格上げ**: 「確定と書いてあるが実は未確認」「未確認だがコードで確定できる」。
3. **見落としている経路・論点**（§4 の 4 論点への回答を含む）。
4. **仕様書の構成についての意見**: 正本として使い続けられるか。二重管理になっている箇所はないか。
5. **重要度順**に並べてください。**些細な表記ゆれは最後にまとめて**構いません。

---

## 8. お願いしないこと

- **コードの修正・実装**（今回は調査と仕様化のみ）。
- **DB への接続を前提にした断定**（§6 の 5 点）。
- **「おそらく」で埋めること。** 出典を出せない指摘は、**「未確認の仮説」と明示**してください
  （このリポジトリの作業ルール R1/R2 と同じ基準でお願いします。`Scan-Chat-AI/CLAUDE.md` 冒頭）。
