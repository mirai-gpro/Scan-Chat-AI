# Elith 自動納品「母集団を有効なコース契約者へ拡張」— 運用と切り分け

**この文書の目的** = 本番で実購入が走ったときに、**納品されたか / されなかったならなぜか**を
すぐ判定できるようにすること。仕様の正本ではない
(正本 = `docs/subscription/kit_lifecycle_and_handoff_management_spec.md` §4.3.1)。

| | |
|---|---|
| 対象コミット | `ba15df7`「Elith自動納品: 母集団を契約者へ拡張・required_formats で揃い判定 (P0-2)」 |
| 本番反映 | **済**。`1c78c20` (PR #276) にマージ済み。デプロイ元ブランチ `claude/awesome-carson-UeyUZ` |
| 変更ファイル | `src/lib/elith-entitlement.ts` (新規) / `src/lib/elith-delivery.ts` / `src/lib/app-config.ts` / `scripts/verify-elith-entitlement.ts` / `package.json` |
| DB マイグレーション | **無し**。新しい表は作っていない |
| 既存挙動への影響 | **単品/スペシャルアカウントの判定は 1 ミリも変えていない** (下記 §2.3) |

> **【最初に読む一行】現時点では、コース契約者は 1 人も納品されない。**
> `app_config` の `elith.plan_formats` が**空**だからで、これは fail-closed の設計どおりの挙動。
> 「実購入が入ったのに納品されない」を見たら、まず §5 の A-1 を確認すること。

---

## 1. 何が問題で、何を変えたか

### 1.1 変える前 (〜2026-09-24)

夜間 cron `/api/cron/elith-deliver` は次の**固定 2 条件**しか見ていなかった。

- 母集団 = **スペシャルアカウントだけ**
- 条件 = 問診済 ∧ 人間ドックのスキャン済

つまり **EC でコースプランを買った人は永久に拾われなかった**。血液・がんリスク・遺伝子・
AI疾病予測が揃っても納品されず、しかも**エラーが出ないので黙って起きる**。
本番稼働に入っている以上、実購入がいつ入っても動く必要があるため一般化した。

### 1.2 変えた後

母集団と条件を、**プランごとの `required_formats` の総当たり**へ一般化した。
判定の規則は **`src/lib/elith-entitlement.ts` 1 ファイルだけ**が持つ
(`elith-delivery.ts` に散らすと二重管理になるため)。

---

## 2. 実装の中身

### 2.1 母集団 (誰を見るか)

`src/lib/elith-delivery.ts:441-451`

```
母集団 = 単品/スペシャルアカウント  ∪  app_bridge.subscription の status='active'
```

- 契約者は `listEntitledSubscribers()` (`elith-entitlement.ts:109`) が
  `app_bridge.subscription` を `.eq('status','active')` で引く。
- **`pending` は権利として読まない。** wellfort-site の `create-order` は
  **決済前に `status:'pending'` で契約行を INSERT する**ため、pending を拾うと
  **未決済の人へ納品してしまう**。
- `HP_BRIDGE_SUPABASE_URL` / `HP_BRIDGE_READONLY_KEY` が未設定、あるいは bridge が引けない環境では
  **空配列を返す** = 契約者は 0 人 = 納品しない (fail-closed)。例外は投げない。
- uid は小文字化して重複排除。

### 2.2 必要 format の解決 (何が揃えば出すか)

`elith-entitlement.ts:75-90` `planFormatMap()`

| 種別 | 必要 format の供給元 |
|---|---|
| 単品 / スペシャル | **コード内定数** `SINGLE_FORMATS = ['LifestyleQuestionnaireData','HealthCheckupData']` (`elith-delivery.ts:463`) |
| コース契約者 | **app_config `elith.plan_formats`** を `plan_code` で引く |

`elith.plan_formats` の書式 (1 行・カンマ区切り):

```
plan_code=HealthCheckupData|LifestyleQuestionnaireData, 別のplan=HealthCheckupData|BloodTestData
```

- **既定は空文字**。空 = どの plan_code も引けない = **契約者は全員 fail-closed**。
- 未知の format 名は捨てる。**捨てた結果その plan の format が 0 件になったら、
  その plan ごと載せない** (空配列で「条件なし＝即納品」にしない)。
- 変更は admin (Bearer `ADMIN_API_KEY` → `POST /api/admin/config`)。
  **再デプロイ不要・反映は TTL 45 秒**。`deliverReadySpecialAccounts` は冒頭で
  `refreshConfig(true)` を呼ぶので、cron は毎回最新値を読む。
- **本来の正本は Wellfort 側** (`public.single_product_spec.required_formats` /
  `public.plan_compositions` + `test_kits.format_id`)。ただし `app_bridge` が公開しているのは
  `customer_account` / `subscription` / `kit_shipment` の **3 表だけ**でマスタを読めない。
  → 橋渡しの view が生えたら `planFormatMap` の供給元だけを差し替える。
  **`diagnosis` に `elith_delivery_spec` のような表を新設しない** (二重管理になる)。

### 2.3 「揃った」の確かめ方

`elith-entitlement.ts:49-57` の `FORMAT_SOURCE` が format → 確認先を持つ。

| format_id | 確認先 |
|---|---|
| `HealthCheckupData` | `diagnosis.test_artifacts` に `test_type='health_checkup'` かつ `status='active'` の行 |
| `BloodTestData` | 同 `test_type='blood'` |
| `CancerRiskAssessmentData` | 同 `test_type='cancer_urine'` |
| `GeneticTestResultData` | 同 `test_type='genetics'` |
| `Other` (AI疾病発症予測) | 同 `test_type='ai_prediction'` |
| `LifestyleQuestionnaireData` | `diagnosis.interview_completions` に行があるか |
| `HealthAgeData` | **非ブロッカー。判定に数えない** (当社が算出して同梱するもので、到着を待つ対象ではない) |

判定そのものは DB に触れない純粋関数 `decideReady()` (`elith-entitlement.ts:227`)。

- `required` が `null` / 空 → **`ready=false`** (fail-closed)。このとき `missing` は**空のまま**にする
  (何が足りないか分からないのに項目名を捏造しない)。
- **単品/スペシャルは `SINGLE_FORMATS` = 従来の固定 2 条件と完全に同じ** なので、
  この変更で既存の納品対象者の挙動は変わらない。回帰チェック①がそれを固定している。

### 2.4 出さなかった理由は必ず出す

`elith-delivery.ts:476-486`。skip したら**黙って落とさず** `results[].reason` に理由を書く。

| reason 文字列 | 意味 | 直し方 |
|---|---|---|
| `必要 format の仕様を引けないため納品しません (plan_code=xxx)` | `elith.plan_formats` にその `plan_code` の行が無い / 全 format が未知名 | app_config に行を足す (§5 A-1) |
| `必要 format の仕様を引けないため納品しません (plan_code=不明)` | `app_bridge.subscription.plan_code` が NULL または空 | bridge 側の同期を直す (§4.2) |
| `未着の検査があります: BloodTestData / GeneticTestResultData` | 仕様は引けたが検査が揃っていない | 検査の到着待ち。名指しされた format の到着を確認 |
| `確定スキャン(scan_md)が無く HealthCheckupData を生成できない` | 揃い判定は通ったが `test_artifacts.scan_md` が空 | スキャン結果の保存状態を確認 |
| `全ての回が既に納品済み` | `skipDelivered` による正常なスキップ | 異常ではない |

### 2.5 発火と冪等

- スケジュール = `vercel.json` の `crons`: `"path": "/api/cron/elith-deliver", "schedule": "0 14 * * *"`
  (**14:00 UTC = 23:00 JST**。Elith 側が深夜バッチで取り込むため)。
- 認可 = `Authorization: Bearer <CRON_SECRET>`。手動確認用に `ADMIN_API_KEY` も通る。
  **鍵が 1 つも設定されていない本番は 401 で拒否** (fail-closed)。
- 納品先 = バケット直下 (`deliveryPrefix=''`)、元ファイルは `AWS_S3_PREFIX`。
- 冪等 = `diagnosis.elith_deliveries` の `(diagnostic_user_id, bundle_date, delivery_prefix)`。
  cron は `skipDelivered:true` なので**納品済みの回は再送しない**。
  **admin ボタン (`POST /api/admin/special-accounts/deliver`) は `skipDelivered` を渡さない**
  ので、従来どおり毎回ラップし直す (手動で作り直したいときのため)。
- 冪等の粒度は **uid × 受診日 (年)**。複数年アップロードした人は、
  **1 年でも未納品の年があれば uid ごと出し直す** (assemble が inventory の全 date を出す仕様のため。
  既納品の年は同一内容・同一キーの上書きで無害)。

---

## 3. 本番で最初に叩くもの

```bash
# 夜間 cron と同じ処理を手で 1 回走らせる (skipDelivered が効くので安全)
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://scan-chat-ai.vercel.app/api/cron/elith-deliver | jq
```

応答の形:

```jsonc
{
  "ok": true,
  "elapsed_ms": 1234,
  "ready": 0,            // 揃っていると判定された人数
  "delivered": 0,        // 実際に S3 へ書いた人数
  "wellness_delivered": 0,// うちウェルネス年齢を同梱できた件数
  "put_count": 0,
  "delivery_prefix": "",
  "results": [
    { "uid": "…", "status": "skipped",
      "reason": "必要 format の仕様を引けないため納品しません (plan_code=course_a)" }
  ]
}
```

**`results` を必ず見ること。** `ready:0` だけを見て「対象者がいない」と判断しない —
「対象者はいるが仕様を引けなかった」も `ready:0` になる。両者は `results[].reason` でしか区別できない。

その他の確認口:

| 目的 | 口 |
|---|---|
| ある利用者の状態 | `GET /api/debug/viewer` (`is_special` / `health_checkup_years` 等) |
| app_config の現在値 | `GET /api/admin/config` (Bearer `ADMIN_API_KEY`) |
| 納品履歴 | `diagnosis.elith_deliveries` (uid / bundle_date / delivery_prefix / format_ids / status) |

---

## 4. 今わかっている前提条件と穴

**この 3 つは本変更で解決していない。** 実購入が入ったときに効いてくるので先に読むこと。

### 4.1 【最重要】`elith.plan_formats` が空 ⇒ 契約者は全員 fail-closed

現時点の既定値は空文字。**プランの対応を 1 行も入れていないので、契約者は 1 人も納品されない。**
これは設計どおり (分からないまま出すと誤納品になる) だが、
**「実購入が入れば自動で出る」状態にはまだなっていない**ことを意味する。

→ 実購入を受ける前に、実際の `plan_code` を確認して app_config へ登録すること。
`plan_code` は `app_bridge.subscription.plan_code` の実値であって、プラン名ではない。

### 4.2 `app_bridge.subscription` を更新する仕組みが動いていない

母集団の供給元がこの表なので、**ここが古いと契約者を拾えない**。実測 (2026-09-25 時点):

- 同期関数 `app_bridge.refresh_subscription()` は `wellfort-site/scripts/app-bridge-refresh.sql:50` に存在する。
- しかし **それを呼ぶ pg_cron の登録はスクリプト内で全行コメントアウトされたまま**
  (同ファイル L144-159。`-- SELECT cron.schedule('app_bridge_daily', …)`)。
- **コードからの呼び出しも 0 件** (wellfort-site 全体を grep して、ヒットは
  `supabase/functions/kit-self-report/index.ts:5` の**コメント 1 行**のみ)。

→ 契約が作られても `app_bridge.subscription` に載らなければ、本機能から見て契約者は存在しない。
**app_config を埋めても、この同期が動いていなければ納品は始まらない。**

### 4.3 「回 (cycle)」の窓で絞っていない

`checkFormatsReady()` は `test_artifacts` / `interview_completions` の **有無だけ**を見る
(`elith-entitlement.ts:151-157` のコメントに明記)。

- 年 4 回の検査サイクルのうち「第 N 回ぶんが揃ったか」は判定していない。
- **意図的にそうしてある** — 契約テーブル (`subscriptions` / `plan_compositions`) が実在 0 件で
  cadence を引けない段階で日付の窓を推測で入れると、
  **揃っているのに出ない**が黙って起きるため。
- 帰結: **一度全 format が揃った契約者は、以後ずっと `ready` と判定される。**
  再送を止めているのは冪等 (`elith_deliveries` の uid × bundle_date) だけ。

---

## 5. 切り分け手順

### A. 「実購入が入ったのに納品されない」

| # | 確認 | 判定 |
|---|---|---|
| A-1 | `GET /api/admin/config` で `elith.plan_formats` の現在値 | **空なら原因はこれ** (§4.1)。その `plan_code` の行を足す |
| A-2 | cron 応答の `results` にその uid が居るか | **居ない** → 母集団に入っていない → A-3 へ / **居る** → `reason` が答え |
| A-3 | `app_bridge.subscription` にその人の行があり `status='active'` か | 行が無い → §4.2 の同期 / `pending` のまま → 決済が完了していない (仕様どおり拾わない) |
| A-4 | `plan_code` が NULL でないか | NULL なら `reason` が `plan_code=不明` になる。bridge 側の同期を直す |
| A-5 | `reason` が `未着の検査があります: …` | 名指しされた format が本当に未着かを `diagnosis.test_artifacts` (status='active') / `interview_completions` で確認 |

### B. 「出てはいけない人に出た」

| # | 確認 |
|---|---|
| B-1 | `app_bridge.subscription.status` が `active` になっていないか (`pending` を `active` に直す運用が入っていないか) |
| B-2 | `elith.plan_formats` にその plan の行を足したことで、本来 4 検査必要な人が 1 検査で揃う設定になっていないか |
| B-3 | スペシャルアカウント / デモ用アカウントの一覧に混入していないか (`GET /api/debug/viewer` の `is_special`) |

### C. 「同じ回が二重に納品された」

| # | 確認 |
|---|---|
| C-1 | admin の「納品」ボタンを押していないか (**admin は `skipDelivered` を渡さないので毎回出し直す**。これは仕様) |
| C-2 | `diagnosis.elith_deliveries` にその `(uid, bundle_date, delivery_prefix)` の行があるか。無いなら記録に失敗している (`recordDelivery` は失敗しても投げない設計) |
| C-3 | `delivery_prefix` が一致しているか (cron は `''`。prefix が違うと別物として扱われる) |

---

## 6. 検証

```bash
npm run verify:elith-entitlement   # 19 件。CI の A 層 (static-required)
```

固定していること (`scripts/verify-elith-entitlement.ts`):

1. **既存挙動を変えていない** — 単品/スペシャルは「問診 ∧ 人間ドック」で揃う / 片方欠けたら揃わない
2. **fail-closed** — `required` が `null` / 空なら納品しない・`missing` を捏造しない
3. **HealthAgeData は非ブロッカー** — 未着でも揃う・`checked` に数えない
4. **app_config の読み取り** — 2 プラン読める / 未知 format は捨てる /
   **全 format が未知なら plan ごと載せない** (空配列で通さない) / 壊れた要素が他を壊さない

退行注入 2 種で名指しに落ちることを確認済み。
`astro check` 0 errors・`astro build` 成功。

---

## 7. この変更で**やっていない**こと (誤解防止)

- `diagnosis` に新しいマスタ表を作っていない (正本は Wellfort 側)。
- DB マイグレーションを 1 本も足していない。
- `app_bridge` の同期を直していない (§4.2 は本変更の範囲外)。
- 回 (cycle) 単位の揃い判定を入れていない (§4.3)。
- admin 画面を作っていない。状況は cron 応答の `results` で見る。
- 単品/スペシャルの判定条件を変えていない。

---

### 参照

- `docs/subscription/kit_lifecycle_and_handoff_management_spec.md` §4.3.1 (権利と条件の正本)
- `docs/elith/elith_s3_data_handoff_spec.md` (納品パス・命名・format_id)
- `docs/elith/elith_assembly_wrapping_spec.md` (ラップ仕様)
- `docs/lab/スペシャルアカウント_複数年スキャン_仕様書.md` §6.2 (年ごと納品)
