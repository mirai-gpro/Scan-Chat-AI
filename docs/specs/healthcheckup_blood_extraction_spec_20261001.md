# 人間ドック・健康診断由来 血液検査データ連携 — 実装仕様書

| | |
|---|---|
| 文書 ID | `healthcheckup_blood_extraction_spec_20261001` |
| 業務仕様の正 | Wellfort「人間ドック・健康診断由来 血液検査データ連携仕様書 v1.1 (2026-10-01)」(発注者支給) |
| 版 | **v4.1 (2026-10-03・レビュー指摘で fail-closed 3 点を追加)** |
| 状態 | **確定仕様＋実装済み** |

> **v1.x / v2.x は 2026-10-02 に全て revert 済み** (PR #288 / #290 / #291 / #292 → PR #293)。
> 取り消した理由は実装の中身ではなく**進め方** — 一時 E2E ページ・Scan-Chat-AI 側 admin 画面が
> 本番へ入ってしまったこと。**裁定 Q-1〜Q-14 (§10) はそのまま有効**で、v3.0 はそれを満たす。
>
> 本文の `file:line` はすべて `7251bc8` (= PR #293 merge 後の本番) 時点の実コードで確認したもの。

---

## 0. 最上位ルール (2026-10-03 発注者指示・**これが最優先**)

> ## **人間ドック・健康診断由来の派生 blood (`imported_by='derived_healthcheck_blood'`) は
> ## Dashboard 表示専用であり、Elith 納品用 `BloodTestData` ではない。**

**なぜ禁止か**: 人間ドック・健康診断の血液部分は、既に `HealthCheckupData` として Elith の診断に
使われている。それを `BloodTestData` として**もう一度**送ると**同一検査情報の二重納品**になる。

| | Dashboard | Elith |
|---|---|---|
| 通常の血液検査 (デメカル等・`test_type='blood'`) | **出す** | **従来どおり納品する** |
| 人間ドック由来 派生 blood | **出す** | **禁止** |

**「readiness 判定から除外する」だけでは不十分。** 次の全経路から外す:

- `BloodTestData` JSON 生成 / Elith 向け S3 配置 / 自動納品 / cron 納品 / 手動納品 / 再納品 /
  delivery assemble / manual mapping / その他すべての Elith 納品経路

**判定は 1 本に集約してある**: `isDerivedHealthcheckBlood()` (`src/lib/blood-subset.ts`)。
`imported_by` の**完全一致**で、`test_type='blood'` のときしか true にならない
(他の検査種別の判定は 1 文字も変わらない)。各経路が独自に文字列比較を書かない。

### 0.0 Production の現状 (**発注者確認済み・2026-10-03。触らない**)

既存の人間ドックからの過去データ backfill は**正式機能**なので、下の 2 件が Dashboard 用データとして
存在していて**問題ない**。**削除・`withdrawn`・作り直しをしない。**

| 受診日 | `imported_by` | 項目数 | artifact id |
|---|---|---|---|
| `2026-09-17` | `derived_healthcheck_blood` | 2 | (確認済・id は未記録) |
| `2026-09-24` | `derived_healthcheck_blood` | 11 | **`98bb8668-c794-452a-9529-594fbc540a44`** |

今回の修正は**この既存 2 件についても** 次を保証するもの (§12.1 ⑨):

1. Dashboard では従来どおり取得される
2. Elith readiness に数えられない
3. `BloodTestData` JSON 生成の対象にならない
4. manual delivery の対象にならない
5. cron / 自動納品の対象にならない
6. retry / 再納品の対象にならない

> **「新しく派生を作らない」だけでは足りない。** 既に Production DB に在る派生 artifact が
> 将来どの Elith 経路からも流れないことを保証する。

### 0.0.1 fail-closed (**発注者レビュー 2026-10-03 ①②③**)

「確認できなかったから通した」を 3 か所で潰した。**最上位仕様は「絶対に送らない」**なので、
確認不能を許可側に倒すと絶対が条件付きになる。DB の瞬断なら**やり直せば通る**ので止める損失は小さい。

| # | 箇所 | 以前 | いま |
|---|---|---|---|
| ① | `finalize.ts` の Elith 最終関門 | Supabase 無し / query 失敗 / 例外 / 行が無い → **`null` を返して納品を許可** | **`test_type='blood'` のときは、取得できて `imported_by != derived` と確認できたときだけ通す。** 確認不能 → **503 `elith_guard_unverifiable` / `delivered:false` / S3 write 0**。派生と確認 → 409 `derived_blood_not_deliverable`。**blood 以外には適用しない** |
| ② | backfill の処理済み照会 | `error` を見ておらず、**DB エラーを「未処理 0 件」として扱っていた** | **500 `db_error` で終了**。`persistDerivedBloodArtifact()` を **1 回も呼ばない** |
| ③ | `mode:'one'` | 指定日に active な派生が在っても**作り直していた** | **`already_processed` で何も書かない。** 再生成・置換の口 (`replace:true` 等) は**作らない** |

> **① は「関門の位置」も直した。** 以前は `deliverAdditionalJson()` の直前に置いていたが、
> **その手前で中間 source prefix へ `BloodTestData_*.json` を書いていた**。
> source の JSON は `inventoryElithSource()` がキー名で拾い `assembleElithDeliverySet()` が納品するので、
> **source へ書いた時点で「将来の納品対象」**になる (しかも `deliver:false` でも source は書く)。
> → 関門を **source JSON の `putFiles` より前**へ移した。検査が位置を固定している。

### 0.1 保証の形 (3 段)

| 段 | 内容 | 検査 |
|---|---|---|
| ① | **納品の材料に DB の blood が入っていない** — 納品は `materializeHealthCheckups()` (検診のみ) と **S3 の inventory** だけを材料にする。**派生 blood から `BloodTestData` JSON を作る関数は 1 つも存在しない** | ⑧-4 / ⑧-5 |
| ② | **DB の blood artifact を触る経路を名簿で固定** — 増えたら落ちる (人が「Elith へ繋がるか」を分類するしかない) | ⑧-5 |
| ③ | **Elith へ繋がる 3 本に関門** — 揃い判定 / 既存 artifact への書き込み / 追加検査の納品 | ⑧-2 / ⑧-3 / ⑧-5b |

### 0.2 ② が要る理由 (実際に在った穴)

`persistIntoExistingArtifact()` は `uid` / `test_type` / `test_date` しか照合していなかったので、
**同じ受診日に派生 blood が在ると、検査機関の本物の血液検査がその行へ上書きされ得た**。
更新されるのは `scan_md` と測定値だけなので **`imported_by='derived_healthcheck_blood'` が残り**:

1. 本物の血液検査が Elith の揃い判定・納品から**黙って外れる** (§0 の表の下段と逆)
2. 画面に「人間ドックから抽出」が付く (由来の偽り)

**どちらもエラーにならない。** → 関門を入れ、`resolveAdditionalArtifact()` では
そもそも派生を候補に出さないようにした。

---

## 1. 目的と、やらないこと

年 3 回のデメカル血液検査に加えて、利用者がアプリでスキャンした
**人間ドック／健康診断の結果に含まれる血液検査値**を、**4 回目の血液データポイント**として
Dashboard の推移グラフへ反映する。

### 1.1 絶対条件 (v1.1 / 発注者指示)

| # | 条件 |
|---|---|
| 1 | **既存のスキャン結果を再利用する。同じ PDF を血液用に再解析しない** (v1.1 §3)。OCR / Gemini / PDF を 1 度も呼ばない |
| 2 | **欠損はブランク。`0` にしない・推定しない・他項目から計算しない** (v1.1 §6 / §12)。**行ごと作らない** |
| 3 | **15 項目が揃うことを条件にしない。1 件でも作る。0 件なら何も作らない** (v1.1 §11 C3 / 裁定 Q-6) |
| 4 | **`eGFR` は原本記載値のみ。クレアチニンから計算しない** (v1.1 §5) |
| 5 | **`血糖` / `随時血糖` を `空腹時血糖` へ推測マッピングしない** (v1.1 §5) |
| 6 | **元の `HealthCheckupData` を変えない。** 上書き・変換・削除しない (v1.1 §1.1 / §8) |
| 7 | 利用者画面に **「人間ドックから抽出」** と出す。**文言を変えない** (v1.1 §11 C1) |

### 1.2 対象外 / 今回やらないこと

- **wellfort-site の血液 CSV 経路**・**デメカル取り込み処理**・**AI スキャンのプロンプト**。
- **admin バッチ経路** (`/api/admin/elith-scan` / `elith-hc-merge`)。**裁定 Q-13 で明示的に対象外。**
  `persistAdminBatchArtifact` の挙動を 1 バイトも変えない (検査で固定・§9 ④-2)。
- **Elith への `BloodTestData` JSON 書き出し (`materializeDerivedBloodTests` 等)。**
  **先送りではなく「禁止」** (2026-10-03 発注者指示・§0)。
  **作らない。** 同一検査情報の二重納品になるため。
  以前の版には「Dashboard 確認後に別 PR で入れる」と書いてあったが、**その予定は取り消された。**

---

## 2. 現行実装の実測 (`7251bc8`)

| 事実 | 出典 |
|---|---|
| `BloodTestData` は**独立テーブルではない**。`test_artifacts.test_type='blood'` + `measurement_values.test_type='blood'` で、健診と格納先・列・型が同一 | `supabase/migrations/20260601000010_schemas_and_tables.sql:186-215` / `20260820000010_measurement_values.sql:28-66` |
| 検査値の書き込み口は `persistMeasurements()` **だけ**。jsonb と正規化層の 2 層を同時に書く | `src/lib/measurement-persist.ts:100-168` |
| `canonical_name` は `findByAlias()` が**完全一致したときだけ**付く。**既存行には遡って付かない** | `src/lib/measurement-persist.ts:125-128` |
| 推移グラフは `measurement_values.test_type` を**等値で**絞る → 人間ドックの血液値はいま血液グラフに出ていない | `src/lib/measurement-queries.ts` `getMeasurementTrend()` の `typed` |
| 系列キーは `canonical_name`、無ければ `item_name` | `src/lib/measurement-queries.ts` `seriesKey()` |
| 基準線は**系列の最後の行**の `ref_*_num` から取る | `src/lib/measurement-queries.ts` `getMeasurementTrend()` |
| 検査カードの「グラフ」ボタンは **artifact 件数 >= 2** で出る (推移は 2 回目から) | `src/components/dashboard/TestResultsSection.astro` `canGraph` |
| readiness は `test_artifacts(status='active')` の**有無だけ**を見る | `src/lib/elith-entitlement.ts` `checkFormatsReady()` |
| `test_artifacts.imported_by` は `text not null` で **CHECK が無い** → 新しい値を migration なしで入れられる | `supabase/migrations/20260601000010_schemas_and_tables.sql:204` |
| デメカル由来の血液値は `unit` / `ref_*` / `flag` が**全部 null** (`BLOOD_REFERENCE` が空) | `src/lib/blood-reference-master.ts` |

**15 項目の名寄せ (実装前に `findByAlias()` を実行して実測)**: `アルブミン` / `尿素窒素` /
無修飾の `中性脂肪` / `e-GFR` は **NULL** だった。`血糖` / `随時血糖` も **NULL** (仕様どおり)。

---

## 3. DB 変更

> ## **migration なし**

`test_artifacts.source` の CHECK に `'user_upload'`、`test_type` の CHECK に `'blood'` が既にあり
(`20260927000010_test_artifacts_source_admin_batch.sql:30-32` / `20260601000010:192-193`)、
派生の印は CHECK の無い `imported_by` に入れる (裁定 D-2)。
`npm run verify:db-enums` が「コードが書く値が CHECK に載っているか」を機械で見ている。

---

## 4. 対象 15 項目

`BLOOD_SUBSET_ITEMS` (`src/lib/blood-subset.ts`) = `standard-master.ts` の `canonical_name` で書く。
**この並びがそのまま出力順** (= `measurement_values.seq`) なので run ごとに揺れない。

| # | 業務名称 (v1.1 §4) | canonical_name | 備考 |
|---|---|---|---|
| 1 | AST（GOT） | `GOT(AST)` | |
| 2 | ALT（GPT） | `GPT(ALT)` | |
| 3 | γ-GTP | `γ-GTP` | `γ-GT` は当たらない (実測) |
| 4 | 総蛋白（TP） | `総蛋白` | |
| 5 | アルブミン（Alb） | `アルブミン` | **★マスタへ追加** (裁定 Q-2) |
| 6 | LDLコレステロール | `LDLコレステロール` | `(F式)` は別項目のまま |
| 7 | HDLコレステロール | `HDLコレステロール` | |
| 8 | 総コレステロール | `総コレステロール` | |
| 9 | 中性脂肪（TG） | `中性脂肪` | **★マスタへ追加**。空腹時/随時 からの統合は §5 |
| 10 | 空腹時血糖 | `空腹時血糖` | `血糖` / `随時血糖` は**対象外** |
| 11 | HbA1c | `HbA1c(NGSP)` | |
| 12 | クレアチニン | `クレアチニン` | |
| 13 | eGFR | `eGFR` | **★`e-GFR` を alias に追加**。計算しない |
| 14 | 尿酸（UA） | `尿酸` | |
| 15 | 尿素窒素（BUN） | `尿素窒素` | **★マスタへ追加** (裁定 Q-2) |

★の 4 件は `docs/scan/golden/` の検体に実在するので、`standard-master.ts` の明文の規律
(「代表ゴールデンに実在する標準項目だけを収録する」) に反しない。

---

## 5. 中性脂肪の統合 (裁定 Q-3)

**派生 blood の中だけ**で `空腹時中性脂肪` / `随時中性脂肪` / `中性脂肪(TG)` → **`中性脂肪`** へ寄せる。
原本は様式ごとに印字が違う (3 検体で実測) ので、デメカルと同じ 1 本の時系列に並べるために要る。

| 層 | 変えるか |
|---|---|
| `scan_md` (原文) / `test_artifacts.measurements` / `measurement_values(health_checkup)` / `HealthCheckupData` | **変えない** |
| 派生 `measurement_values(blood)` | **`中性脂肪` へ統合する** |

⚠️ **`STANDARD_MASTER` で `空腹時中性脂肪 = 随時中性脂肪 = 中性脂肪` の alias を作らない。**
統合を知っているのは **`src/lib/blood-subset.ts` の `TG_SOURCES` 1 か所だけ**。
`空腹時血糖` には同じ統合を**しない** (v1.1 §5 の推測マッピング禁止に直接反する)。

---

## 6. 欠損・競合

| ケース | 挙動 |
|---|---|
| 項目が原本に無い / 値が空 | **行を作らない**。`null` 行も `0` 行も作らない |
| 15 項目が 1 件も取れない | **artifact も測定値も作らない** (裁定 Q-6)。health_checkup 側は通常どおり保存される |
| 同一項目に**別値**が複数 (例 空腹時 54 と 随時 221 / 尿酸 5.9 と UA 7.2) | **その項目だけ除外**し理由を返す (裁定 Q-12)。推測で片方を選ばない。**他の項目は通常どおり出す** |
| 同一項目に**同値**が別名で複数 | 1 件に畳む (競合にしない) |
| 同一項目の別値が**別の入力グループ** (別の「N枚目」) に在る | **競合にしない。** グループごとに別の派生 blood を作る (§13)。2026-09-17 の LDL 96 / 102 がこれ |

> **競合の判定は「同じ入力グループの中」だけ** (2026-10-03 §13)。
> 1 件の health_checkup に独立した健診結果が 2 通入っている回で、**通ごとに違う値**を
> 「同じ項目の別値」と見ると、15 項目のほとんどが `value_conflict` で落ちる
> (実測 2026-09-17: **11 項目 → 1 項目**)。グループの**中**の競合は従来どおり除外する。

---

## 7. 同一日の優先 (裁定 Q-10 / D-5)

**通常 blood が常に勝つ。** 「通常 blood」= `test_type='blood'` かつ
`imported_by !== 'derived_healthcheck_blood'` の active 行。

| 順序 | 挙動 |
|---|---|
| 通常が先に在る → 人間ドックをスキャン | **派生を作らない**。理由を呼び出し元へ返す (黙らせない) |
| 派生が先に在る → 通常が後から届く | **派生を `superseded` に落とす** (削除しない)。通常の行には触らない |
| 同日の blood を**引けなかった** | **作らない** (fail-closed)。「在るのに分からない」まま作ると通常を潰し得る |

「後から届く」側の実装位置は **`api/admin/lab-results/register.ts` の 1 本だけ**。
`upload.ts` は artifact を `UNASSIGNED_UID` で作るので、呼んでも空振りにしかならない。

---

## 8. Elith から外す (裁定 Q-4 / D-1 → **2026-10-03 に全経路へ拡大**)

`checkFormatsReady()` は blood の active 行の**有無だけ**を見るので、派生をそのまま数えると
**デメカル到着前に納品が発火**し、`elith_deliveries` の unique + `skipDelivered` で
**同じ回は二度と再送されない**。

> **確定 (2026-10-03 改訂): 派生 blood は readiness に数えない。納品データにも含めない。**
>
> **旧版の「納品データには含める」は取り消された** (§0)。
> 人間ドックの血液部分は `HealthCheckupData` として既に納品されているので、
> `BloodTestData` として再送すると**同一検査情報の二重納品**になる。

実装は `countsTowardReadiness()` (`src/lib/elith-entitlement.ts`) 1 か所。

- 除外は **`imported_by` の完全一致 1 本**。前方一致・部分一致にしない。
- **`source='user_upload'` 全体を除外しない** — 将来の「利用者が血液検査の紙をスキャンする」経路を
  誤って排除するため。
- **blood 以外の format の判定は 1 文字も変えない。**

---

## 9. 実装の地図

| # | 実体 | 中身 |
|---|---|---|
| 1 | `src/lib/standard-master.ts` | ★4 件 (アルブミン / 尿素窒素 / 中性脂肪 / `e-GFR` alias) ＋ **`γ-GT` / `γGT` を `γ-GTP` の同義語へ (§13.8)**。**空腹時/随時 は alias にしない** |
| 2 | `src/lib/blood-subset.ts` (新規) | **I/O 無しの純関数だけ。** 15 項目マスタ・抽出・TG 統合・競合除外・marker・固定文言 ＋ **sibling 識別子** (`derivedBloodExternalTestId` / `…ParentId` / `…GroupIndex`・§13.4) |
| 3 | `src/lib/scan-persist.ts` | `replaceSameDateArtifacts` に任意 `importedBy` / **`externalTestId`** / `persistDerivedBloodArtifact()` (**グループごとに 1 件・`onlyGroups`**) / **`toDerivedBloodGroups()`** / `supersedeDerivedBloodOnSameDate()` / `saveScanResult` の後段から呼ぶ |
| 4 | `src/lib/elith-entitlement.ts` | `countsTowardReadiness()` |
| 5 | `src/lib/measurement-queries.ts` | `activeArtifacts()` が `imported_by` も返す / 点に `source` / 混在系列の基準線抑止 / **`SERIES_NAME_ALIASES` にマスタ追加の後始末 (§9.4)** |
| 6 | `src/lib/dashboard-queries.ts` | `MetricTrendPoint.source` の型 |
| 6' | `src/lib/elith-export.ts` | **`measurementGroupsFromMarkdown()` / `sheetGroupNumber()`** (入力グループの境界・§13.2)。**`measurementsFromMarkdown()` は 1 行も変えていない** |
| 7 | `src/components/dashboard/MetricTrendChart.astro` | 「人間ドックから抽出」(履歴テーブルの検査日セル 2 行目 + 最新点のミニカード) ＋ **同日 sibling の表示名** `9/17①` / `2026年9月17日（抽出1）` (§13.9) |
| 7' | `src/components/dashboard/TestResultsSection.astro` | **同日に 2 件あることを出す** (`人間ドックから抽出・2件`・§13.10) |
| 7'' | `src/lib/result-queries.ts` / `src/pages/result/[id].astro` | 「過去データ」の **並びと表示名** (同日は g1 → g2・`（抽出1）`・§13.10) |
| 8 | `src/pages/api/admin/lab-results/register.ts` | 通常 blood 到着時の supersede |
| 9 | `src/pages/api/admin/derived-blood/backfill.ts` (新規) | **正式な server-side admin backfill** (§11) |
| 10 | `scripts/verify-blood-subset.mjs` (新規) | 回帰 **547 件**。CI の `static-required` |
| 11 | `src/lib/special-additional-tests.ts` | 追加検査の artifact 候補から**派生を外す** (§0.2) |
| 12 | `src/pages/api/admin/special-additional-tests/finalize.ts` | 検診登録で**派生を 1 回だけ作る** (§11) / 血液登録で同日の派生を降ろす / **納品の直前の関門** |

**派生処理は 1 か所しかない。** 新規スキャン (`saveScanResult` の後段) と backfill
(`/api/admin/derived-blood/backfill`) が **`persistDerivedBloodArtifact()` という同じ関数**を通る
(発注者指示 §11)。抽出ロジックを 2 本持たない。

### 9.0 派生を作る経路 (**共通関数 1 本・2026-10-03 調査で確定**)

| # | 入口 | 経路 | 派生の生成 |
|---|---|---|---|
| A | 利用者のアプリ内スキャン | `/scan` → `POST /api/scan/save` → `saveScanResult()` | **組み込み済み** (後段で 1 回) |
| A' | 送信後の背景ジョブ | `GET /api/cron/scan-worker` → **同じ `saveScanResult()`** | **組み込み済み** (A と同じ 1 か所) |
| B | スペシャルアカウントの複数年アップロード | **A と同じ** `/scan` → `/api/scan/save` (`requireReadableDate` が立つだけ) | **組み込み済み** (追加実装は不要) |
| B' | スペシャルアカウントの **検診・人間ドック Admin 登録** | `/admin/special-additional-tests` → `finalize.ts` → `saveAdditionalArtifact()` | **`saveScanResult()` を通らない** → **ここに 1 回だけ足した** (§11) |
| C | 既存データの backfill | `POST /api/admin/derived-blood/backfill` | 同じ `persistDerivedBloodArtifact()` |
| D | admin バッチ (`elith-scan` / `elith-hc-merge`) | — | **対象外** (裁定 Q-13。拡張しない) |

**抽出ロジックは `persistDerivedBloodArtifact()` 1 本だけ。** スペシャル専用の血液抽出は作らない。
**二重呼び出しは足していない** — A/A'/B は `saveScanResult()` の 1 か所を共有しており、
B' だけが別経路なので、そこへ 1 回だけ追加した。

### 9.1 冪等

`replaceSameDateArtifacts` に **5 条件** `(uid, 'blood', test_date, 'user_upload', imported_by=marker)`
＋ **6 つ目の任意条件 `external_test_id`** (sibling を消し合わせないため・§13.5)。
**何度叩いても artifact はグループ数を超えて増えない。** `measurement_values` も artifact 単位の総入れ替え。

`imported_by` を 5 つ目に足すのは、`source='user_upload'` を他の経路と共有するため。
active な行なら §7 の優先判定が先に止めるが、**superseded / withdrawn の行はそこを通らない**ので
冪等キー側で守る (測定値は `on delete cascade` なので道連れになる)。

### 9.2 画面

- 由来は**列を増やさず**「検査日」セルの 2 行目に置く (列を足すと 390px で表が潰れる)。
- ミニカードは**最新点が派生のときだけ**出す (点単位の由来なので)。
- 文言は `DERIVED_HC_BLOOD_LABEL = '人間ドックから抽出'` の 1 定数。
- **判定は `test_artifacts.imported_by` が唯一の根拠。** `measurement_values` の中身から推測しない。

### 9.4 マスタ追加の後始末 — 既存系列を割らない

`canonical_name` は**書き込み時点で確定する**ので、マスタに `中性脂肪` / `尿素窒素` /
`e-GFR` を足しても**既存行には遡って付かない**。すると同じ項目が

- 古い行 … `canonical_name=null` → キー = `item_name` (`中性脂肪(TG)` / `e-GFR` / `BUN` …)
- 新しい行 … canonical が付く → キー = `中性脂肪` / `尿素窒素` / `eGFR`

に割れ、**推移グラフの点が減る**。2026-09-29 の塩分の実障害と同型で、
**線は 1 本描かれるのでエラーも出ない = 目視では気づけない。**

→ `measurement-queries.ts` の `SERIES_NAME_ALIASES` (読み出し時の**完全一致**寄せ・既存の仕組み) へ
`中性脂肪(TG)` / `TG` / `トリグリセライド` → `中性脂肪`、`e-GFR` → `eGFR`、
`BUN` / `UN` / `血中尿素窒素` → `尿素窒素`、`Alb` / `ALB` → `アルブミン` を足した。
**DB の `item_name` は書き換えない。**

⚠️ **`空腹時中性脂肪` / `随時中性脂肪` はここに入れない** — 原本が区別しているものを
読み出しで潰すことになる (裁定 Q-3)。検査 ⑦ が「2 系列のまま」であることを固定している。

### 9.3 混在系列の基準線 (裁定 Q-5 / D-4)

デメカル由来は `ref_*` が全部 null なので、**人間ドックの点が最新になった回だけ**
その施設の基準値が系列全体の基準帯として描かれてしまう。
→ **混在している系列では `referenceUpper` / `referenceLower` を付けない。**
**点ごとの H/L は残す** (原本が付けた印で、アプリが比較して出したものではない)。

---

## 10. 発注者裁定 (全 14 件・2026-10-01・**確定済み。蒸し返さない**)

| # | 論点 | 確定した内容 |
|---|---|---|
| Q-1 | デメカル CSV の実ヘッダ | v1.1 添付の 15 項目を業務仕様上の正とする。**未確認の名称を「デメカル実ヘッダ」と書かない**。実ヘッダとの一致確認は merge 前の受入条件 |
| Q-2 | 標準マスタへの追加 | アルブミン / 尿素窒素 / `e-GFR` alias を追加してよい (golden に実在) |
| Q-3 | 中性脂肪 | **派生の中だけ**で `中性脂肪` へ統一。`HealthCheckupData` は不変。**マスタで 空腹時=随時 の alias を作らない** |
| Q-4 | Elith 揃い判定 | **派生を readiness に数えない。** marker は `imported_by`。**`source` 全体を除外しない。** ~~納品セットには含める~~ → **2026-10-03 に取り消し: 納品にも含めない (§0)** |
| Q-5 | 基準値・グラフ | **混在系列では基準線を表示しない。** 点ごとの H/L は保持。互いの基準値を当てはめるのを禁止 |
| Q-6 | 0 件のとき | artifact も JSON もグラフも作らない。**成立判定ではない** |
| Q-7 | 由来表示 | **「人間ドックから抽出」固定** |
| Q-8 | `source.note` | 固定文言 `人間ドック・健康診断の既存AIスキャン結果から血液検査値を抽出（再解析なし）` |
| Q-9 | measurements の形 | 既存 `leanMeasurement` の 7 フィールド。独自構造を新設しない |
| Q-10 | 同一受診日の重複 | **通常 blood を優先。** 同一日に 2 つ並べない。後から届いても最終的に通常が勝つ |
| Q-11 | 過去データ | backfill は**新規経路と分離**。本番 DB を自動変更しない・**cron にしない**・対象と予定内容を表示・明示的な実行指示まで production で実行しない |
| Q-12 | 値の競合 | **確定できない項目だけ除外。** 推測で選ばない。他項目まで無効にしない |
| Q-13 | admin バッチ | **対象外。** 拡張しない |
| Q-14 | Production の既存データ | 適用前に read-only で確認。**既存行を勝手に削除・supersede しない** |

---

## 11. backfill (裁定 Q-11 / 発注者指示 §12)

```
POST /api/admin/derived-blood/backfill        (Bearer ADMIN_API_KEY)
  body: { diagnosticUserId, mode: 'one' | 'pending', testDate?, confirm?: boolean }
```

| 条件 | 内容 |
|---|---|
| 認証 | **既存の `isAdminAuthorized()` (Bearer `ADMIN_API_KEY`) をそのまま使う。独自認証を作らない** |
| 画面 | **UI は wellfort-site `/admin/derived-blood-backfill`** (CLAUDE.md「UI=wellfort-site / 処理=Scan-Chat-AI」)。**Scan-Chat-AI 側に admin 画面を作らない** |
| 鍵 | wellfort-site の中継がサーバ側 env `SCAN_CHAT_AI_API_KEY` で付ける。**ブラウザへ鍵を出さない** |
| 既定 | **`confirm` 無しは preview。DB にも S3 にも 1 行も書かない** (読み取りだけ) |
| 再生成 | **しない。** `mode:'one'` でも **全グループ済みなら `already_processed` で何も書かない**。`replace:true` のような口は作らない。**処理済みの判定はグループ単位** (§13.7) |
| 範囲 | **`mode` で明示する** (2026-10-03 §12 / §13)。`'one'` = 受診日を 1 つ指定 (受診日は**必須**) / `'pending'` = **その uid の未処理すべて** (= 同じ受診日に派生がまだ無い回だけ)。**「受診日を空欄にすると全件」という暗黙の操作は廃止**。未指定・未知の値・`'one'` で日付が空・`'pending'` に日付あり は**すべて 400**。**全ユーザー一括は実装しない** |
| cron | **載せない** |
| 材料 | `test_artifacts.measurements` (jsonb) ＋ **入力グループの境界だけ `scan_md` から読む** (§13.3)。**Gemini も PDF も S3 も触らない** |
| 旧ロジック由来 | **`external_test_id` を持たない派生が同日に在る回は自動では触らない** (`legacy_derived:true`)。本番の `9d350c7e…` がこれ。置き換えは発注者の指示を受けてから (§13.7) |
| 読み戻し | **Dashboard / 推移グラフ / readiness が本番で使う同じ関数**を通して結果を返す (`loadDashboard` / `getTrendCandidates` / `getMeasurementTrend` / `checkFormatsReady`)。独自クエリで「入っているはず」を作らない |

**一時 E2E ページ・固定 UID のページ・テスト専用の本番ページは作らない** (v2.x の失敗の直接の対策)。

---

## 12. 検証

### 12.1 `npm run verify:blood-subset` — **547 件**・CI の `static-required`

サーバも鍵もブラウザも要らない。Supabase は**インメモリの偽物**
(`on delete cascade` まで再現してある)。`demo-data` は通さない。

| 群 | 内容 |
|---|---|
| ① 標準マスタ | 空腹時/随時/無修飾 の 3 つが別々 / ★4 件が引ける / **`血糖`・`随時血糖` が NULL** / 総蛋白≠尿蛋白 |
| ② 抽出 | **0 / 1 / 11 / 15 件** / TG 統合 6 表記 / 競合除外 / 推測しない (血糖・eGFR・総コレステロール) / 入力を書き換えない |
| ③ 保存 | artifact の全列 / 11 行 / `canonical_name` が全行付く / **0 補完 0 件** / 冪等 (3 回流して 1 件) / **冪等キーが派生以外を巻き込まない** / 0 件なら作らない / 同日優先 / supersede |
| ④ 新規スキャン | `saveScanResult` の後段で**自動生成**される / 再送で増えない / **admin バッチは作らない** |
| ⑤ readiness | 派生は数えない / デメカル・admin・`imported_by='user'` は数える / 前方一致で外さない / **他 4 種別の判定は不変** |
| ⑥ グラフ | 4 点 / **派生の点にだけ `source`** / **混在で基準線なし** / 派生だけなら基準線あり / superseded は点にならない / **health_checkup のグラフが汚染されない** |
| ⑦ 系列割れ | マスタ追加の前後に書かれた行が **1 系列 2 点**になる (5 表記) / **空腹時・随時 は 2 系列のまま** |
| ⑧-1 | 判定そのもの — 完全一致 / 前後空白 / 前方一致 / **他 4 種別では常に false** |
| ⑧-2 | §18-15 readiness が同じ判定関数に委ねている |
| ⑧-3 | §18-9/11 **派生 artifact への書き込みが止まる** (測定値も scan_md も書かない) / **通常 blood と health_checkup へは従来どおり通る** |
| ⑧-4 | §18-10 検診 materialize が書くキーは `HealthCheckupData` だけ・**`BloodTestData` が 1 本も作られない** |
| ⑧-5 | §18-9/12/13/14 **blood artifact を触るモジュールの名簿が増えたら落ちる** / 関門 3 本の実在 / **関門は納品より前に在る** / **§11 の配線 (検診→派生) と §8 の配線 (血液→supersede) の位置** / 派生→JSON を作る関数が存在しない |
| ⑧-5b | 追加検査の候補から**実際に**派生が外れる (派生だけ→0 件 / 通常→1 件 / 両方→通常だけ / health_checkup は不変) |
| ⑧-5c | **backfill は範囲を明示しないと動かない** (mode 未指定・未知・日付の過不足で 400) / preview は書かない / apply で 11 件 / pending は処理済みを触らない |
| ⑧-6 | §18-11 同日に通常と派生 → 数えるのは通常だけ・派生だけが降りる |
| **⑨-1** | **既存の派生 2 件** (本番と同じ形で seed) が `loadDashboard` で**2 件とも取得される** / グラフの候補・系列に出る / **全点に「人間ドックから抽出」** |
| **⑨-2** | 既存の派生 2 件が在っても `checkFormatsReady` が **ready:false** / 通常 blood を 1 件足すと **ready:true** (§16) |
| **⑨-3** | `materializeHealthCheckups` が書くキーは HealthCheckupData だけ / **元の検診も既存の派生も無傷** |
| **⑨-4** | `buildDeliveryPlan` (manual) が **BloodTestData を 1 件も納品予定に入れない** (実際に 2 ファイル作られる = 空振りでない) |
| **⑨-5/6** | cron の `manualMapping` に BloodTestData が無い (**コメント除去後**に確認) / **その mapping では source の BloodTestData が納品されない** / **mapping に載せれば納品される** (= 空振りでない・§16) / **再納品でも同じ** / **派生が在る/無いで納品物が同一** |
| **⑨-7** | 同日に派生が在っても **通常 blood の登録が成功**し**新しい artifact** になる / 派生は **superseded (削除ではない)** / 別日の派生は無傷 / **通常 blood で ready:true** / グラフの点が通常の値に差し替わる |
| **⑩-1** | ① **blood + 照会 DB error → 503 / S3 write 0** (source JSON も書かない) / Supabase 無しでも出さない / **派生と確認 → derived (409)** / **通常 blood は通る** / **blood 以外は照会せず通す** / blood で行が無ければ unverifiable |
| **⑩-2** | ② 派生一覧の照会が落ちたら **`mode` を問わず 500 `db_error`** / **blood artifact 0 件・測定値 0 件** (1 回も呼ばない) |
| **⑬-A〜H2** | **blood episode の必須 fixture** (§13.2.1)。**A** 2026-09-17 → 2 件 × 11 項目・excluded 0 / **B** 通常の複数ページ (1枚目 身体計測 / 2・3枚目 血液 / 4枚目 その他) → **1 件**・`groupIndexes=[2,3]` / **C** 同一値の重複 → 1 件 1 行 / **C2** 11 項目が丸ごと同値で 2 ページ → **1 件** (閾値を作っていない番人) / **D** 同一グループ内の競合 → 分割せず LDL だけ `value_conflict` / **E** 3 episode → `g1`/`g2`/`g3` / **F** 冪等 (3 回 + `onlyEpisodes` 混在で 2 件) / **G** 規則 A/B/C と境界判定そのもの / **H2** backfill も episode 単位 / **H** グラフは受診日 2 日以上 |
| **⑫-①②③** | **発注者レビュー 2026-10-03**。① legacy は `legacyDates` だけで判定 (同日・別親の新方式 sibling を legacy 扱いしない) / ② 同日 2 点が**同じ系列に** `96, 102, 116` の順で出る・`groupIndex` が付く・**1 件の日には付けない**・丸番号と接尾辞の文言 / ③ `orderDerivedSiblings` が**派生だけ**を昇順に並べる・`mine[0]` が `g1`・詳細画面で g1→g2 を辿れる |
| **⑪-A〜J** | **入力グループごとの分割** (§13)。境界は「N枚目」だけ / `ページN` では割らない / 1 枚なら 1 グループ / **2026-09-17 と同じ fixture で A・B 11 項目ずつ** / 競合はグループ内だけ / sibling は消し合わない / 冪等 (3 回でも 2 件) / **親 id が変わる再送でも 2 件** / 片方 0 件なら片方だけ / 同日通常 blood で全グループ中止 / `saveScanResult` でも 2 件 / backfill の処理済みはグループ単位 / **旧ロジック由来は触らない** / **sibling が増えても Elith 全面除外は不変** |
| **⑩-3** | ③ **本番の 2 件 (`2026-09-17` / `2026-09-24` `98bb8668…`) を `mode:'one'` で叩いても `already_processed`** / id の増減ゼロ / 測定値 11 件のまま / superseded は処理済みに数えない / **`replace` の口が無い** |

**②-2 の fixture は本番の対象検体そのもの** — `docs/scan/golden/scan_golden_healthcheckup_20250123.md`
の実測値で、**15 項目のうち 11 項目だけが在る**。期待値 11 件
(`GOT(AST)`=19 / `GPT(ALT)`=20 / `γ-GTP`=26 / `LDL`=116 / `HDL`=83.2 / `TC`=196 / `中性脂肪`=54 /
`空腹時血糖`=104 / `クレアチニン`=1.03 / `eGFR`=56.9 / `尿酸`=7.8) と、
**行を作らない 4 項目** (総蛋白 / アルブミン / HbA1c(NGSP) / 尿素窒素) を固定している。

### 12.2 退行注入 (**68 種とも名指しで落ちることを確認済み**・2026-10-02 / 10-03)

| # | 壊し方 | 結果 |
|---|---|---|
| R-1 | `hasValue` を常に true (空行・0 補完が入る) | FAIL 1 |
| R-2 | `血糖` を `空腹時血糖` へ推測マップ | FAIL 2 |
| R-3 | 競合を「先に出てきた方」で確定 | FAIL 4 |
| R-4 | 冪等キーから `importedBy` を外す | FAIL 4 |
| R-5 | readiness の除外を消す | FAIL 1 |
| R-6 | readiness の除外を `source` ベースにする | FAIL 1 |
| R-7 | 混在系列でも基準線を付ける | FAIL 1 |
| R-8 | 点から `source` を落とす | FAIL 4 |
| R-9 | マスタで 空腹時/随時 を `中性脂肪` の alias にする (先勝ちで勝たせる) | FAIL 3 |
| R-10 | 同日の通常 blood 優先を外す | FAIL 4 |
| R-11 | supersede が通常 blood にも触る | FAIL 2 |
| R-12 | `saveScanResult` が派生を作らない | FAIL 6 |
| R-13 | 入力の measurements を書き換える | FAIL 2 |
| R-14 | 15 項目マスタに `随時血糖` を足す | FAIL 3 |
| R-15 | 読み出しエイリアスを 1 件外す (系列が割れる) | FAIL 2 |
| R-16 | `空腹時中性脂肪` / `随時中性脂肪` を読み出しで `中性脂肪` へ潰す | FAIL 3 |

**2026-10-03 追加 (Elith 除外・§0)**

| # | 壊し方 | 結果 |
|---|---|---|
| E-1 | 既存 artifact への書き込みの関門を外す | FAIL 4 |
| E-2 | 追加検査の候補から派生を外さない | FAIL 3 |
| E-3 | `finalize` の関門を納品の**後ろ**へ動かす | FAIL 1 |
| E-4 | 判定を前方一致に緩める | FAIL 2 |
| E-5 | 判定が `blood` 以外にも効くようにする | FAIL 9 |
| E-6 | backfill の `mode` を既定 `'pending'` にする (暗黙の全件) | FAIL 1 |
| E-7 | `mode='one'` で受診日が空でも通す | FAIL 1 |
| E-8 | `mode='pending'` が処理済みの回も対象にする | FAIL 1 |
| E-9 | readiness の除外を消す | FAIL 4 |
| E-10 | `finalize` の検診登録から派生の生成を消す | FAIL 3 |
| E-11 | `finalize` の血液登録から supersede を消す | FAIL 2 |
| F-1 | cron の `manualMapping` に `BloodTestData` を足す | FAIL 1 |
| F-2 | supersede を `delete` にする (行を消す) | FAIL 4 |
| F-3 | 候補解決が派生を返す | FAIL 13 |
| F-4 | supersede が**別の日**の派生も降ろす | FAIL 4 |

**入力グループの分割 (§13・2026-10-03)**

| # | 壊し方 | 結果 |
|---|---|---|
| S-1 | 内部ページ (`ページN`) も境界にする | FAIL 2 |
| S-2 | 分割をやめて全部まとめて渡す (壊れていた形に戻す) | FAIL 58 |
| S-3 | 冪等キーから `externalTestId` を外す (sibling が消し合う) | FAIL 9 |
| S-4 | 全グループ run の事前片付けを外す (親 id が変わる再送で増える) | FAIL 10 |
| S-5 | backfill の処理済み判定を受診日単位に戻す | FAIL 6 |
| S-6 | 旧ロジック由来 (`external_test_id` なし) も自動で作り直す | FAIL 8 |
| S-7 | 派生判定を `external_test_id` ベースに変える (marker を見ない) | FAIL 21 |
| S-8 | `γ-GT` の同義語を外す | FAIL 9 |
| S-9 | `scan_md` を常に優先する (jsonb の measurements を無視) | FAIL 6 |

**表示と順序 (§13.9 / §13.10・発注者レビュー 2026-10-03)**

| # | 壊し方 | 結果 |
|---|---|---|
| T-1 | legacy を `doneDates` ベースに戻す (レビュー ① の退行) | FAIL 3 |
| T-2 | 解析できない `external_test_id` を `legacyDates` に入れない | FAIL 11 |
| T-3 | グラフの同日の並びを `test_date` だけに戻す | FAIL 2 |
| T-4 | 点から `groupIndex` を落とす | FAIL 1 |
| T-5 | Dashboard の並べ替えをやめる | FAIL 1 |
| T-6 | `orderDerivedSiblings` が派生以外も並べ替える | FAIL 2 |
| T-7 | 同日 2 件の「人間ドックから抽出・N件」を外す | FAIL 1 |
| T-8 | グラフの `markOf` から dup 判定を外す (1 件でも ① を付ける) | FAIL 1 |
| T-9 | 履歴テーブルの `（抽出1）` を外す | FAIL 1 |
| T-10 | 詳細画面の sibling から `groupIndex` と並びを落とす | FAIL 2 |
| T-11 | 詳細画面のラベルを日付だけに戻す | FAIL 1 |

**blood episode (§13.2.1・発注者の最終仕様 2026-10-03)**

| # | 壊し方 | 結果 |
|---|---|---|
| U-1 | `N枚目 = derived blood 1 件` に戻す (旧仕様) | FAIL 23 |
| U-2 | 重複が無いのに分割する (規則 A を壊す) | FAIL 23 |
| U-3 | 同値の重複でも分割する (規則 B を壊す) | FAIL 10 |
| U-4 | 値が違っても結合する (規則 C を壊す) | FAIL 89 |
| U-5 | **「11 項目揃っていたら新 episode」の閾値を入れる** | FAIL 4 |
| U-6 | 続きページの measurements を結合しない (§13.2.1 の最終値を壊す) | FAIL 5 |
| U-7 | 血液項目が無いページも episode にする | FAIL 6 |
| U-8 | backfill の処理済み判定を「N枚目」単位に戻す | FAIL 2 |
| U-9 | `canGraph` を件数判定に戻す | FAIL 2 |
| U-10 | 候補判定を「点が 2 つ以上」に緩める | FAIL 1 |
| U-11 | episode 番号を「N枚目」の番号にする | FAIL 4 |

> **U-5 と U-8 は最初の版で落ちなかった** (記録)。
> **U-5**: fixture の形が偶然ヒューリスティックと一致していた (11 項目 2 組は
> どちらの規則でも 2 件、6+4 項目は 1 件)。→ **11 項目が丸ごと同値で 2 ページ**の
> 検体 (⑬-C2) を足して、「件数では判断していない」ことを固定した。
> **U-8**: backfill の fixture が 1 グループだけで、グループ番号 = episode 番号に
> なっていた。→ **Fixture B の形を backfill に通す** 検査 (⑬-H2) を足した
> (入力グループ 4 / episode 1 / `missing_episodes=[1]` / `groups=[2,3]`)。

> **T-8 は最初の版で落ちなかった** (記録)。「どこかに `dup` の判定がある」ことだけを
> 見ていたので、`markOf` から外しても `suffixOf` 側のパターンが拾って緑のままだった。
> → **`markOf` と `suffixOf` の両方を別々に固定**する形に直した。

**レビュー指摘の fail-closed (①②③)**

| # | 壊し方 | 結果 |
|---|---|---|
| G-1 | 関門を fail-open に戻す (確認不能→通す) | FAIL 7 |
| G-2 | 関門を source JSON の**後ろ**へ動かす | FAIL 3 |
| G-3 | fail-closed を blood 以外にも広げる | FAIL 3 |
| G-4 | 派生一覧の `error` を無視する | FAIL 6 |
| G-5 | `mode:'one'` の `already_processed` を外す | FAIL 7 |
| G-6 | superseded も「処理済み」に数える | FAIL 1 |

> **⑨ でも空振りを 2 件踏んだ (2026-10-03・記録)**: `buildDeliveryPlan` は
> 「スペシャルアカウントとして登録されていません」で早期 return し、
> `deliverReadySpecialAccounts` は母集団が空で、**どちらも何も実行せずに緑**だった。
> → S3 スタブを**インメモリの実装**に変えて materialize→inventory→assemble を通し、
> cron は**合成の仕組み** (`manualMapping` ＋ `assembleElithDeliverySet`) を直接検査する形にした。
> **「mapping に載せれば納品される」ことも併せて確かめ**、空振りでないことを示している。
>
> **注入そのものを間違えた例も記録しておく**: 最初 `void f(x)` の形で潰そうとしたが、
> **`void f(x)` は f を呼ぶ**ので挙動は変わらず、検査が緑のままだった (= 検査の穴ではない)。
> 退行注入は「本当に壊れているか」を先に確かめること。

> **E-2 と E-6 は最初の版では落ちなかった** (文字列の有無しか見ていなかった / 検査が無かった)。
> `resolveAdditionalArtifact()` と backfill の `POST` を**実際に動かす**検査 (⑧-5b / ⑧-5c) を
> 足して捕まえた。**⑧-5 の名簿検査も、最初は「違反 0 件」を数える形にしたら
> 該当モジュールが 1 本も無くて常に緑だった** (= 関門を全部外しても通る) ので、
> **名簿を固定する形**に変えてある。

> **注意**: ⑥ の「混在系列の基準線」は、**派生の点を系列の最新に置かないと検知できない**。
> 基準値は `sorted` の最後の行から取る作りなので、派生を途中の日付に置くと
> **抑止を外しても検査が緑のまま通る**。fixture は派生を最新に置いてある。

### 12.3 既存の検査を緩めていないこと

- `verify:measurement-status` が backfill の読み戻しを捕まえたので、**ALLOW へ逃がさず**
  `.in('status', AUDIT_STATUSES)` / `.in('artifact_id', …)` へ直した (24/24 緑)。
- `verify:scan-async` の「ガードは insert より前」は**ファイル内の最初の `.insert([`** を見るので、
  派生のブロックを `saveScanResult` の**後ろ**へ置いた (検査は 1 行も変えていない)。
- `verify:url-uid-privacy` は `result-queries.ts` の相対 import を全部落として
  必要な記号だけ差し込む作りなので、**新しく増えた 2 つ
  (`orderDerivedSiblings` / `derivedBloodGroupIndex`) をその prelude に足した**。
  **検査そのものは 1 行も変えていない** (所有者の分離を見る assertion は不変)。
  並びとグループ番号の中身はこの検査に関係しないので最小の実装を置き、
  **本物は `verify:blood-subset` ⑫-③ が動かして検査している**。
- `astro check` 0 errors / `astro build` 成功 / A 層 全件緑
  (B 層 6 本は pwsh がこの作業環境に無いため CI の `pwsh-verify` job で走る)。

### 12.4 merge 前に残る確認 (コードで閉じられないもの)

| # | 条件 |
|---|---|
| AC-1 | 現行デメカル CSV の実ヘッダ 15 件と §4 の mapping の一致 (裁定 Q-1) |
| AC-2 | Production の read-only 確認 (裁定 Q-14)。`source='user_upload' AND test_type='blood'` の既存行 / `imported_by='derived_healthcheck_blood'` の先行使用 / 同一日 blood の重複 — **backfill の preview がこの 3 つをそのまま返す**ので、別途 SQL を流す必要はない |
| AC-3 | backfill は発注者の明示指示まで production で実行しない (裁定 Q-11) |

---

## 13. 入力グループ (「N枚目」) ごとの分割 (発注者指示 2026-10-03)

### 13.1 何が起きていたか (実測)

1 件の health_checkup に**独立した健診結果が 2 通**入っていることがある。
アップロードが**複数ファイルを 1 回で受ける**ので、`joinPageMarkdown()`
(`src/lib/scan-markdown.ts:51`) が `## 1枚目` / `## 2枚目` を付けて 1 本の
`markdownClean` に束ねる。**これが原本の入力単位**。

本番 `2026-09-17` がその形で、

- 1 枚目 … LDL **96** / 総コレステロール 159 / 空腹時血糖 97 …
- 2 枚目 … LDL **102** / 総コレステロール 196 / 空腹時血糖 104 …

を**まとめて `extractBloodSubset()` に渡していた**ため、通ごとに違う値が
「同じ項目の別値」に見えて `value_conflict` で両方落ち、
**15 項目のうち 2 項目しか残らなかった**。
除外の判断そのものは正しい (§6・推測で片方を選ばない)。**渡す単位が間違っていた。**

### 13.2 `N枚目` は**分割候補の境界**でしかない (発注者の訂正 2026-10-03)

> ## **取り消し: `N枚目 = derived blood 1 件`**
>
> `N枚目` は**入力ページ / 入力ファイルの出所情報**。既存仕様では
> **1 回の送信 = 1 回分の人間ドック**で、1 回の人間ドックは 4〜10 枚になるので
>
> ```
> 1枚目 身体計測 / 2枚目 肝機能・脂質 / 3枚目 腎機能
> ```
>
> は**本来 derived blood 1 件**。一方 2026-09-17 の検体は
> **入力グループ 1 にも 2 にも血液一式 (別値)** が在るので **2 件**が正しい。
>
> **件数を決めるのは blood episode** (§13.2.1)。`N枚目` の数ではない。

**値の内容からは一切分割しない** (発注者指示)。

| 見出し | 扱い |
|---|---|
| `1枚目` / `２枚目` (全角も) | **境界。** そこから次の `N枚目` までが 1 グループ |
| `1枚目 / ページ2` / `1枚目／ページ3` | **同じ 1 枚目グループ。** 内部のページ番号では割らない |
| `ページ2` 単独 / `血液検査` / `3枚目の所見` | **境界ではない** (完全な形だけを見る) |
| `N枚目` が 1 つも無い (1 枚だけの回) | **1 グループ**。従来と同じ挙動 |
| 見出しの前の前文 | 1 グループ目に入れる |

グループ番号は**原本の数字そのまま**なので、何度やり直しても同じ番号になる
(= sibling の識別子が安定する)。

実装 = `measurementGroupsFromMarkdown()` / `sheetGroupNumber()` (`src/lib/elith-export.ts`)。
**`measurementsFromMarkdown()` (health_checkup 側の経路) は 1 行も変えていない** —
通す整形は同じ `toMeasurements` → `sanitizeMeasurementsForDelivery` を
**グループごとに**呼ぶだけ。検査が「全グループの合計 = まとめて整形した件数」を固定している。

### 13.2.1 blood episode — **派生 blood 1 件の単位** (最終規則)

> ## **閾値も推測ヒューリスティックも作らない。**
> 「11 項目揃っているか」「項目の種類」では判断しない。

入力グループを**原本順**に処理する。各グループについてまず
`extractBloodSubset(group.measurements)` を通して 15 対象項目の
canonical item / value を得る (**ここでは件数を見ない**)。

| 規則 | 条件 | 挙動 |
|---|---|---|
| — | 血液項目を 1 つも持たないグループ | **episode に属さない** (身体計測・画像所見のページ)。境界判定にも関わらせない |
| — | 最初に血液項目を持つグループ | **episode 1 を開始** |
| **A** | 現在の episode と**重複する canonical 項目が無い** | 同じ人間ドックの続きページ → **現在の episode へ結合** |
| **B** | 重複はあるが**値が全部同じ** | 同じ検査内容の重複記載 → **現在の episode へ結合** |
| **C** | 重複する canonical 項目のうち**1 つでも値が異なる** | **そのグループから新しい episode を開始** |

**ページ途中では分割しない。** 同一トップレベルグループの中に別値が在る場合は
従来どおりその項目だけ `value_conflict` で除外する (§6)。

**最終値は episode が確定してから 1 回だけ作る** —
**episode に属する全入力グループの元 measurements を結合**して
`extractBloodSubset()` を通す。これで

- 同一人間ドックの複数ページ → **1 件へ統合** (同値の重複は 1 行に畳まれる)
- 独立した複数の血液結果 → **複数件**

**OCR / Gemini / PDF の再解析はしない。** 材料は保存済みの `scan_md` /
`test_artifacts.measurements` だけ。

実装 = `buildBloodEpisodes()` (`src/lib/blood-subset.ts`・**純関数**)。
値の同一性は `extractBloodSubset` と同じ `sameValue()` (`value_num` 優先)。
TG の表記ゆれ (`空腹時中性脂肪` / `随時中性脂肪` / `中性脂肪`) は
**統合後の概念 `中性脂肪`** で突き合わせる。

### 13.3 材料の選び方 (`toDerivedBloodGroups`)

| 条件 | 使う材料 |
|---|---|
| `scan_md` が **2 グループ以上**に割れて、測定値が 1 件以上取れる | **markdown 由来の分割** |
| 1 グループしか無い | **保存済み jsonb の `measurements`** = 従来と 1 バイトも変わらない |
| 1 グループで jsonb が空 | markdown 由来 (材料がそれしかない) |
| `scan_md` が無い (admin バッチ等) | jsonb の `measurements` を 1 グループ |

**1 グループのときに markdown を優先しない**のが要点。`scan_md='## 原文'` のように
表を持たない原文だと markdown 側は 0 件になるので、優先すると**従来 11 項目取れていた回が
0 件になる** (実装中に実際に踏んだ。退行注入 S-9 がこれを固定している)。

**再解析ではない** — `scan_md` は保存済みの確定 Markdown で、通すのは決定論関数だけ。
Gemini も PDF も 1 度も呼ばない (v1.1 §3)。

### 13.4 sibling の識別子 — **migration なし**

> ## **既存カラム `external_test_id` を使う。migration は足さない。**

`external_test_id = 'derived_hc:<親 health_checkup の artifact id>:g<episode 番号>'`
(`derivedBloodExternalTestId()` / `derivedBloodParentId()` / `derivedBloodEpisodeIndex()`
= `src/lib/blood-subset.ts`)。

⚠️ **`g<N>` の N は「N枚目」ではなく blood episode 番号** (発注者の訂正 2026-10-03)。
**原本順に `g1` / `g2` / `g3`…** と決まる。形式は据え置き = **migration は要らない**。
由来の「N枚目」は `notes` と `siblings[].groupIndexes` に残す。

- **UNIQUE がこれで初めて効く。** `test_artifacts` の UNIQUE は
  `(uid, source, test_type, test_date, external_test_id)` で、
  **`external_test_id` が NULL のとき効かない** (`20260601000010:208` / §0.4 と同じ罠)。
  グループ番号を入れると同じ受診日に 2 件並べても衝突しない。
- `notes` にもグループの見出しを書く (監査用。`… / 1枚目` )。
- **Elith 除外の判定には使わない。** 判定は `imported_by` の完全一致 1 本のまま (§8)。
  `external_test_id` だけが派生の形をしていても派生とは見なさない
  (検査 ⑪-J / 退行注入 S-7)。
- 並べ替えの純関数 **`orderDerivedSiblings()` は `blood-subset.ts` が持つ** (§13.10)。
  読み出し側 (`dashboard-queries` / `result-queries`) が取得直後に 1 回通す。
  **2 か所で並べ替えない。**

### 13.5 冪等 — 片付けの範囲を run の種類で変える

| run | 片付ける範囲 |
|---|---|
| **全 episode** (`onlyEpisodes` 無し。新規保存・`mode:'one'` の初回) | ループの**前に 1 回**、その受診日の派生を `external_test_id` を問わず片付ける |
| **一部だけ** (`onlyEpisodes` 指定。backfill の差分補完) | その episode の `external_test_id` **完全一致**だけ |

全グループ側で `external_test_id` を問わないのは、**`saveScanResult` で同じ回を送り直すと
親 health_checkup の id が変わる**ため (古い行を片付けて insert し直す)。
完全一致だけで片付けると**前の親の派生が残って 2 倍に増える** (退行注入 S-4)。
一部だけ側で完全一致にするのは、**隣の sibling を巻き込んで消さない**ため (S-3)。

`replaceSameDateArtifacts()` の条件は 4 → 6 個 (`importedBy` / `externalTestId` は任意) で、
**渡さなければ既存 2 呼び出しの挙動は 1 バイトも変わらない。**

### 13.6 グループごとの結果を黙らせない

`DerivedBloodOutcome.siblings[]` (`episodeIndex` / `groupIndexes` / `externalTestId` /
`created` / `reason` / `artifactId` / `rows` / `items` / `excluded` / `skipped`) と
`groupCount` (= **episode の数**)。`created` / `rows` / `items` は
**全 episode の合計 / 連結**で、内訳は `siblings` を見る。

| ケース | 挙動 |
|---|---|
| 血液項目を持たないページ | **episode にならない** (身体計測・画像所見。§13.2.1) |
| どの episode も 0 件 / episode が 0 件 | 何も作らない (§6 と同じ)。`reason='no_items'` |
| 同日に通常 blood が在る | **どの episode も作らない** (§7 は受診日単位の規則なので不変) |
| 通常 blood が後から届く | **sibling 全件を `superseded`** (`supersedeDerivedBloodOnSameDate` は marker と受診日で絞るので自然に全件) |

### 13.7 backfill の処理済み判定は**episode 単位**

`external_test_id` から `親 → 済んだグループ番号` を組み、**欠けているグループだけ**
`onlyGroups` で作る。

| 状態 | `mode:'one'` | `mode:'pending'` |
|---|---|---|
| 全 episode 済み | `already_processed` (何も書かない) | 対象外 |
| 一部の episode だけ済み | **欠けた分だけ作る** | 対象に拾う |
| **`external_test_id` を持たない派生が同日に在る** (旧ロジック由来) | `already_processed` + `legacy_derived:true` | **対象外** |

**旧ロジック由来を自動で触らないのが要件** (発注者指示: 既存の
`9d350c7e-4de7-4cda-b854-5099f9687d06` を削除・supersede・再生成しない)。
グループ番号が分からない行を「未処理」と見ると**作り直してしまう**ので、
その受診日は**済み扱いで止める** (退行注入 S-6)。
置き換えが要るなら**発注者の指示を受けてから**。

> **根拠は `legacyDates` だけ (発注者レビュー 2026-10-03 ①・修正済み)。**
>
> 最初の実装は `doneDates`(= その日に派生が 1 件でも在る) を legacy の根拠にしていたので、
> **同じ受診日に「別の親」の新方式 sibling が在るだけで**、まだ派生が無い health_checkup まで
> 「旧ロジックの行が在る日」と誤認して `already_processed` にしていた。
>
> `legacyDates` に入れるのは、**`external_test_id` が NULL か
> `derived_hc:<親>:g<N>` として解析できない** active な派生が在る日付**だけ**。
> 新方式の sibling はグループ番号が分かるので legacy の根拠にならない。
>
> 判定は `legacy = legacyDates.has(date) && doneGroups.size === 0`。
> 検査 ⑫-① (同日に親 A＝sibling 完備 / 親 B＝派生なし → **B は legacy でなく pending 対象**) と
> 退行注入 T-1 / T-2 が固定している。

preview は `group_count` (「N枚目」の数) / **`episode_count`** / `missing_episodes` /
`legacy_derived` と `would_create.episodes[]` (episode ごとの `groups` / 項目名 / 件数) を返す。

### 13.8 `γ-GT` を `γ-GTP` の同義語に足した

原本が `γ-GT` と印字する様式がある (2026-09-17 の 1 枚目)。足さないと
**15 項目のうち γ-GTP だけが落ちる**。

- `standard-master.ts` の `γ-GTP` の `synonyms` に `γ-GT` / `γGT` を追加。
  `normKey('γ-GT')='γ-gt'` で**既存のどのキーとも衝突しない** (確認済み)。
- `measurement-queries.ts` の `SERIES_NAME_ALIASES` にも
  `'γ-GT' → 'γ-GTP'` を追加。`canonical_name` は**書き込み時点で確定する**ので
  マスタに足しても既存行には遡って付かず、寄せないと**既定の推移グラフ
  (`DEFAULT_TREND_ITEMS` に γ-GTP が在る) が割れる** (§9.4 と同型)。
- **`HealthCheckupData` の納品名は変わらない。** 納品名は `pickDeliveryName()` が決めており
  `findByAlias()` を通さない。`canonicalize.ts` は通すが
  **`scan.canonicalize` は既定 off** (CLAUDE.md) なので現行の本番では発火しない。
  on にする判断をするときに**ここも 🎯 で見る**こと (`γ-GT` → `γ-GTP` に寄る)。
- 同じ概念になることで `observation-dedup` (`scan.obs_dedup`) が
  `γ-GT` と `γ-GTP` を同一概念として扱う。**同値なら畳む / 別値は競合記録で自動採用しない**
  ので捏造は増えない。

### 13.9 画面・グラフ (**発注者裁定 2026-10-03 ②・確定**)

> ## **両方残す。平均しない。捨てない。別系列にも分けない。**
>
> `g1` / `g2` は**表示上の識別子だけ**で、**医学的な別系列にはしない。**

**同一検査項目の同一系列に 2 点出す。**

```
9/17①  96
9/17②  102
9/24    116
```

| 置き場所 | 表示名 |
|---|---|
| 詳細・履歴 (拡大グラフの履歴テーブル / `/result/[id]` の「過去データ」) | `2026年9月17日（抽出1）` / `（抽出2）` |
| グラフの狭いラベル (X 軸・ミニカードの両端) | `9/17①` / `9/17②` |

- 文言は `derivedBloodSuffix()` / `derivedBloodMark()` (`blood-subset.ts`) の 1 か所。
  丸番号は `①`〜`⑳`、超えたら `(21)` (**作字しない**)。
- **同じ日が 2 つ以上あるときだけ付ける。** 1 件しか無い日に「（抽出1）」と出すと、
  利用者には**何かが欠けているように見える** (検査 ⑫-② / 退行注入 T-8・T-9)。
- 点ごとの `groupIndex` は `MetricTrendPoint.groupIndex` (**表示用**)。
  `activeArtifacts()` が `external_test_id` から読む。**値からは推測しない。**

### 13.10 同日 sibling の順序 (発注者裁定 2026-10-03 ③)

**同日の派生 sibling は `groupIndex` の昇順。** 取得は `order('test_date', desc)` だけなので
**同じ受診日の 2 件は DB が返した順** = 実行ごとに入れ替わり得る。
`TestResultsSection` は `mine[0]` を「最新」として「データ」のリンク先にするので、
**押すたびに開く回が変わる**ことになる (裁定 ③ の発端)。

| 場所 | 直し方 |
|---|---|
| Dashboard の検査カード | `loadDashboard` が `orderDerivedSiblings()` を 1 回通す → **`mine[0]` は必ず `g1`** |
| 推移グラフ | `getMeasurementTrend` の並びを `test_date` → `groupIndex` → `artifact_id` の 3 段に |
| `/result/[id]` の「過去データ」 | `loadResult` が同じ `orderDerivedSiblings()` を通す。**g1 の画面から g2 へ辿れる** |

**並べ替えるのは派生 sibling 同士だけ。** 他の行は**位置も相対順も 1 つも動かさない** —
元の枠に書き戻すので、受診日が null の行の扱いや他種別の並びは DB のまま
(検査 ⑫-③ / 退行注入 T-6)。**画面側では並べ替えない** (2 か所で並べると食い違う)。

**Dashboard に「2 件ある」ことを出す。** 同じ受診日に派生が 2 件以上あるときだけ、
検査カードの提供元の行を **`人間ドックから抽出・2件`** に差し替える
(`DERIVED_HC_BLOOD_LABEL` ＋ 件数。**数えるだけで値の解釈はしない**)。
出さないと「データ」が開く 1 件だけが全部に見える (退行注入 T-7)。
**「データ」で最初に開くのは `g1`**、もう片方は詳細画面の「過去データ」から辿る。

### 13.11 グラフのボタンは「異なる受診日が 2 日以上」 (発注者裁定 §8)

> ## `canGraph = active artifact の distinct `test_date` が 2 日以上`
> (旧 `mine.length >= 2` は**件数**なので、同日 sibling 2 件だけでも出てしまっていた)

| 状態 | グラフ |
|---|---|
| `9/17①` + `9/17②` | **無効** (同じ日の 2 点に線を引いても時間軸が無い) |
| `9/17①` + `9/17②` + `9/24` | **有効** |

**`getTrendCandidates()` の「日付の違う点が 2 つ以上」と一致させる** —
ずれると「グラフ」を押した先が空になる。添え書きも
`推移グラフ：記録 N 回分` の N を**受診日の数**で言う (件数で言うと食い違う)。

`getTrendCandidates()` 自体は**変えていない**。ここを「点が 2 つ以上」に緩めると
**1 回しか受けていない人に線が引ける** (退行注入 U-10)。
