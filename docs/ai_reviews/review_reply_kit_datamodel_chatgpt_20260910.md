# ChatGPT レビュー回答 — 検査キット データモデル

日付: 2026-09-10  
対象: `mirai-gpro/Scan-Chat-AI` / `claude/clever-cray-ngg0h6`  
レビュー対象: `docs/subscription/検査キット_データモデル_仕様書.md`  
実装変更: なし  
Production DB: NO-TOUCH  
wellfort-staging DB: SELECT / schema inspection のみ

## 総合判定

方向性は概ね正しいが、現版のまま実装の正本にするのは NO-GO。
特に「実際の /kit が app_bridge を使っている」という前提を runtime で確認していないことが最大の欠落。

### P0 修正事項

1. **「/kit は app_bridge だけを読む」は誤り。**  
   `dashboard-queries.ts` は `isBridgeConfigured()` で分岐し、bridge env が無ければ `customer.kit_shipments` を読む。  
   よって「customer.kit_shipments は使われていない」も誤り。正しくは「bridge構成時には使わず、fallback経路として現役」。

2. **A-2「migration は同じ1セットだから staging / Production も同じ」は誤り。**  
   Git上の migration ファイル列と実DBの適用状態は別。実 staging では `schema_migrations` は baseline + p0 hardening だけだが、後発の payment_provider 列は存在する。さらに Production では `magic_links` drop 済みと記録されている一方、staging には `magic_links` が残る。  
   したがって `Git migration set ≠ Production実DB ≠ staging実DB`。

3. **「1注文=1bridge行」は強すぎる。**  
   `refresh_kit_shipment()` は `JOIN customer_profiles` を通るため、正しくは「対応する customer_profiles がある source order 1件につき最大1bridge行」。  
   実 staging は `orders=13 / customer_profiles=0 / app_bridge.kit_shipment=0`。

4. **今回観測した10件の表示元が未確定。**  
   対象 `WF-20260909-1WJKKK` は staging に存在し、`category=検査パッケージ / amazon / paid / preparing`。同じ user_id の注文は13件で、検査パッケージ12件（paid 2 / pending 10）＋サプリメント1件（paid）。  
   しかし staging bridge は0行。よって観測した「がん検査 / 検査会社未定 ×10」は、現在の `wellfort-staging.app_bridge` からは生成できない。  
   次に `HP_BRIDGE_SUPABASE_URL` の接続先と `shipmentSource`、fallback有無を確定する必要がある。

5. **`orders.billing_sequence` をキットの「第N回」と同一視しない。**  
   create-orderでは `successful_billing_count + 1` であり、これは課金回数。Wellfortの物理キット発送は年2〜3回なので別軸。  
   「ordersに回があるのにbridgeへ運んでいない」ではなく、「課金回数はあるが、kit shipment round の正本ではない」とする。

6. **案Aは現記述のままでは実装不能。**  
   bridgeに `payment_status` も shipment round も無いので、DB変更なしの読み取り側だけで「未決済除外」「回基準の件数制御」はできない。

## 追加で見落としている経路

- `refresh_kit_shipment()` は UPSERT のみで DELETE 同期が無い。source order が削除・JOIN対象外になっても stale bridge row が残り得る。
- `test_type` は `tp.category` 由来だが差分条件は `orders.updated_at` のみ。`test_products.category` だけ変更すると差分refreshでは bridge の古い値が残り得る。
- `.order('shipped_at', desc).limit(10)` は同値/NULL多数時の安定tie-breakerがない。「どの10件」が選ばれるか保証できない。
- runtime wiring 自体が原因候補。Scan staging の `HP_BRIDGE_SUPABASE_URL` と `HP_EDGE_BASE_URL` が本番を指していないことを必ず確認する。これは staging の目的「本番DBを汚さない / 不要な外部連携を走らせない」の必須ゲート。

## 主張 A〜E の判定

| 主張 | 判定 |
|---|---|
| A-1 目標7要素未実装 | staging実DBでは確認済み。Production現在値はNO-TOUCHなので未確認 |
| A-2 migration同一→staging/本番同一 | **誤り** |
| A-3 Production 19表 | 2026-09-05 baseline時点なら可。現在値としては不可 |
| B-1 bridge 12列 | 正しい |
| B-2 id=o.id→1注文=1行 | 「qualifying order 1件につき最大1行」へ修正 |
| B-3 filterはuser_idだけ | 「業務状態 filter が無い」へ修正 |
| B-4 subscription_id/billing_sequenceあり | 列の存在は正しい。ただし billing_sequence は kit round ではない |
| C-1 limit10、状態等filterなし | bridge経路なら正しい |
| C-2 null固定 | bridge経路なら正しい |
| C-3 検査会社未定fallback | 正しい |
| D-1 unknown type素通し | 正しい |
| D-2 canonical 5 vs tp.category | 構造は正しい |
| D-3 全bridge行がraw | 過剰断定。DB値がcanonicalならmapされる |
| D-4 demoはcanonical | 正しい |
| D-5 がん検査 src 0件 | repo検索として妥当。ただし staging DB には旧inactive商品8件で `category='がん検査'` が実在 |
| E-1 create-orderが決済前pending INSERT | 正しい |
| E-2 success-only仕様に反する | 正しい |
| E-3 注文番号形式一致 | 正しい。ただし個別行の生成元証明は形式一致だけでは不足 |

## 「がん検査」のstaging実データ

`wellfort-staging.test_products` には `category='がん検査'` が8商品ある。すべて Wellfort の旧 ALA-PDS 商品で `is_active=false`。  
一方、対象ユーザーの注文カテゴリは `検査パッケージ` と `サプリメント` だけ。  
したがって、観測した「がん検査」が対象staging注文から直接出たとは言えない。

## §5「意図的な暫定策」の評価

`bridge_table_design_draft.md v0.3` は、HP側にkit系テーブルが無い状況で `kit_shipment` を orders 由来にし、検査完了を #2 `test_artifacts` で補う設計を明記している。  
よって「orders由来は偶然の実装ミスでなく当時の設計判断」は支持できる。

ただし原典は **Draft / 叩き台** であり、「将来target modelへ置換するまでの暫定」と明記してはいない。  
推奨表現:

> 当時の実スキーマ制約に合わせて意図的に採用されたorders由来設計。後続のサブスク駆動仕様から見ると、現在は移行対象の旧設計になっている。

## 案A / A′ / B / C

**A**: 現状のbridgeのままでは未決済除外・回基準制御はできない。残すなら「見た目の件数制御」程度。  
**A′**: `tp.category` は商品カテゴリで、対象Welltectプランは `検査パッケージ`。これを `blood/cancer_urine/genetics` の1つへ正しく変換できない。1商品→複数kitだから根本代替にならない。  
**B**: `subscription_id` と `payment_status` の追加は有用。`billing_sequence` は課金回としてのみ扱う。DB migration、refresh関数、型、adapter、query、full refresh/cleanupまで必要で「運ぶだけ」ではない。  
**C**: 最新仕様への整合は最も高い。ただし authoritative data をどのDBに置くかを実装前に固定すること。

## create-order問題

ここはClaudeCodeの指摘を支持する。実装は決済前に `subscriptions.active` と `orders.pending` を作り、最新specは決済成立時のみ生成を要求している。  
staging実データでも対象ユーザーに `検査パッケージ pending 10件` を確認した。

ただし「この10 pending = 画面の10件」とはまだ確定できない。staging bridgeが0行だから。  
位置づけは「独立して確定した上流欠陥。表示への直接因果は runtime source 確定後」。

## bridge同期駆動元

repoのcronはコメント例だけ。Productionの `cron.job` はNO-TOUCHのため未確認のままでよい。  
`wellfort-staging` の `cron.job` をSELECTした結果、`app_bridge / refresh_kit_shipment / refresh_all` の該当jobは0件。  
したがって staging については「bridge cronなし」と確定できる。

## 仕様書の位置づけ

「この背骨のデータモデルの正本」とすると、既存の「目標モデルの正本 = kit_lifecycle...」と二重Source of Truthに見える。  
本書は以下に限定するのがよい。

> **現行実装と目標モデルの差分・移行判断の正本**

- E2E正本: `lab_data_pipeline_master_spec.md`
- 目標データモデル正本: `kit_lifecycle_and_handoff_management_spec.md`
- 現在地 / gap / migration decision: `検査キット_データモデル_仕様書.md`

## 次の調査指示

まだ実装しない。

1. 上記P0/P1を仕様書へ反映。
2. 実際の `/kit` runtime source を確定:
   - `shipmentSource`
   - `HP_BRIDGE_SUPABASE_URL` の接続先project（secret不要）
   - fallback有無
3. Scan staging `HP_EDGE_BASE_URL` の接続先を確認し、Production writeでないことを確認。
4. stagingの外部writeを `disabled / sandbox / staging` に分類。
5. 実際に `/kit` が読んでいるデータ源から10件の実体を再取得。
6. その結果でA/B/Cを再評価。
7. 再レビューPASS後に実装。

### 最優先質問

> **観測した `/kit` は、実際にどのDBのどのテーブルを読んでいたのか？**

これを確定してから恒久修正へ進むべき。
