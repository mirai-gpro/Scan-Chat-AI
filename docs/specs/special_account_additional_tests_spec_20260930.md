# スペシャルアカウント 追加検査登録・Elith 納品 統合機能 仕様書

**版**: 1.0 (2026-09-30)
**状態**: **仕様のみ。実装していない。**
**対象**: `mirai-gpro/Scan-Chat-AI`（処理 API）/ `mirai-gpro/wellfort-site`（管理 UI）

| | |
|---|---|
| 文書 ID | `special_account_additional_tests_spec_20260930` |
| 正本の範囲 | **この追加検査機能に限り本書を優先**（§48） |
| 調査基準 | Scan-Chat-AI `claude/awesome-carson-UeyUZ` / **`6abc310`**（発注者指示の `95ab5ed` は PR #285 マージ前。§0.1 参照）<br>wellfort-site `main` / `cf1efe79` |

---

## 0. この文書の読み方

### 0.0 本書は発注者指示書を**実コードで裏取りしたもの**

本書の骨格（§1〜§48）は発注者指示書（2026-09-30）そのままである。**設計を増やしていない。**
こちらが足したのは次の 3 種だけ。

1. **`file:line` の根拠**（CLAUDE.md R1「断言には出典を付ける」）。
2. **指示書の記述と実コードが食い違う点の訂正**（§0.2 に一覧。いずれも指示の**意図は変えていない**）。
3. **実装前に潰す必要がある落とし穴**（§0.3）。既存コードを読めば分かるもので、推測ではない。

> **既存コードを読まずに実装を始めてはならない**（§47）。本書の `file:line` は
> 「読むべき場所」の索引でもある。

### 0.1 調査基準のずれ（先に断っておく）

発注者指示書は Scan-Chat-AI の基準を `95ab5ed` としているが、**同日 11:59 に PR #285 が
本番ブランチへマージされ、現在の本番は `6abc310`** である（外部共有・Admin 代理表示ぶん）。

- 本書の `file:line` は **`6abc310`（= `claude/cool-dirac-1dkyx7` の `1b941aa`）**で実測した。
- **本機能が触る範囲に差はない** — マージされたのは `share-access.ts` / `middleware.ts` /
  `viewer.ts` / `write-guard.ts` と各 API の認可行で、`elith-*` / `scan-persist` /
  `originals-*` / `lab-results` の**中身は変わっていない**。
- ただし **migration 番号は変わった**（§41 の訂正を必ず読む）。

### 0.2 指示書の記述に対する訂正（4 件・意図は変えていない）

| # | 指示書の記述 | 実測 | 本書での扱い |
|---|---|---|---|
| **C-1** | 「現在 `/admin/elith-batch` に存在する `renderPdfToJpeg()`」 | **在る。ただし Scan-Chat-AI ではなく wellfort-site のブラウザ側** `src/pages/admin/elith-batch.astro:517`。同ファイル `:564` に**1 ページ = 1 画像**の `renderPdfPages(file, from, to, width, quality)` も既にある | §10 を「使わない関数」と「流用する関数」に分けて書いた |
| **C-2** | 「縦連結はページ脱落を起こす」 | **2026-09-27 に修正済み**。`renderPdfToJpeg` は高さ上限（`PDF_STRIP_MAX_H = 16000`）を超えたら**例外で中止**する（`elith-batch.astro:502-536`）。黙って捨てるのは**もう起きない** | 禁止理由を「脱落する」から**「高さ上限で PDF 全体が中止になり、大きな PDF が構造的に通らない」**へ直した（§10.1）。**禁止という結論は変えない** |
| **C-3** | 「migration は `20260930000010` が在るので同じ番号を使わない」 | `20260930000010` / **`000020` / `000030` / `000040` / `000050`** まで使用済み（外部共有ぶん・本番マージ済み） | §41 で **`20260930000060` 以降**を指定 |
| **C-4** | 「§30 `elith_deliveries` は `uid + bundle_date + delivery_prefix` で 1 行」 | **そのとおり**（`20260924000010_elith_deliveries.sql:41`）。`format_ids text[]` を upsert で**丸ごと上書き**する形なのも指示のとおり | 訂正なし（裏取りのみ） |

### 0.3 実装前に必ず読む「既存の落とし穴」（3 件・本機能の設計根拠）

これは**指示書に書かれていないが、指示書の要求を満たすために避けられない**事実である。

#### P-1 `test_artifacts` の UNIQUE は重複を止めない

```sql
-- supabase/migrations/20260601000010_schemas_and_tables.sql:208
unique (diagnostic_user_id, source, test_type, test_date, external_test_id)
```

- **`source` が入っている** → `wellfort_lab` の行と `admin_batch` の行は**別物として両立する**。
- **`external_test_id` が NULL のとき UNIQUE は効かない**（PostgreSQL は NULL を互いに
  distinct とみなす。このマイグレーションは `nulls not distinct` を付けていない）。
  → **同じ (uid, source, test_type, test_date) の行が何行でも入る。**

**帰結**: §18 の重複防止は **DB が守ってくれない。アプリが守る。**
「UNIQUE があるから大丈夫」と読んではいけない。

#### P-2 `persistAdminBatchArtifact()` は `source='admin_batch'` の行しか置き換えない

```ts
// src/lib/scan-persist.ts:306-312
await replaceSameDateArtifacts(sb, { diagnosticUserId, testType, testDate, source: 'admin_batch' });
```
`replaceSameDateArtifacts` は `.eq('source', q.source)` で絞る（`scan-persist.ts:98`）。

→ 既に `source='wellfort_lab'` の active 行がある人に対してこの関数を呼ぶと、
**その行は残したまま `admin_batch` の行が増える**。これが本田さんの重複事故の機構である。

**帰結**: 本機能は `persistAdminBatchArtifact()` を**そのまま呼んではいけない**。
先に §18 の検索（**`source` を条件に入れない**）を行い、1 件見つかったら
`persistIntoExistingArtifact()` へ回す。

#### P-3 `persistAdminBatchArtifact()` は受診日を today へ落とす

```ts
// src/lib/scan-persist.ts:295
const testDate = /^\d{4}-\d{2}-\d{2}$/.test(input.testDate) ? input.testDate : jstToday();
```

→ **§8 の「today fallback 禁止」はこの 1 行と正面から衝突する。**
本機能は `YYYY-MM-DD` でないものを**受け付けずに 400 で止める**（呼ぶ前に検証する）。

---

## 1. 目的

スペシャルアカウントは「AI 疾病予防報告書」単品利用を基本とし、標準フローは次のとおり。

```text
ユーザー
  ├─ AIスキャン（健診・人間ドック）
  └─ AI問診
        ↓ Wellfort → Elith 納品 JSON → Elith S3
        ↓ Elith 処理 → 受領 JSON
        ↓ AI疾病予防報告書 → Welltect ダッシュボード
```

これに対し、**本田さんのケースを代表例として**、次の追加検査を登録する必要がある。

- 遺伝子検査
- 血液検査（単年 / 複数年）
- がんリスク検査（単年 / 複数年）
- AI 疾病発症予測（単年 / 複数年）

追加した検査について、**1 回の原本選択から以下を一連で完了**できる機能を実装する。

1. 原本 PDF の保存
2. 検査内容の解析
3. Elith 形式 JSON 生成
4. Welltect ダッシュボードへの反映
5. 原本 PDF と検査データの紐付け
6. Elith 本番 S3 への納品
7. 納品結果の検証

**第一目的は、現在必要になっている二重アップロード運用の廃止**である。

```text
/admin/elith-batch へ PDF アップロード
  ↓
同じ PDF をもう一度 /admin/lab-results へアップロード   ← これを無くす
```

---

## 2. 現状の問題（実測）

### 2.1 `/admin/elith-batch` 側は「解析 → Elith JSON → DB」まで持っている

`src/pages/api/admin/elith-scan.ts` は 1 リクエストで次を行う。

| 処理 | 根拠 |
|---|---|
| 検査票解析 → Elith バンドル生成 | `elith-scan.ts:109` `buildElithScanBundle(...)` |
| Elith 用 S3 への出力 | `elith-scan.ts:193` `putFiles(bundle.files)` |
| `test_artifacts` 保存 | `elith-scan.ts:35, 235` `persistAdminBatchArtifact` / `persistIntoExistingArtifact` |
| `measurement_values` 保存 | 上記の中で `persistMeasurements()`（`scan-persist.ts` → `measurement-persist.ts:100`）|

つまり **Elith 入力データ作成と Dashboard 数値登録は、既に同じ処理から出ている。**

### 2.2 `/admin/lab-results` 側は「原本の紐付け」だけを持っている

`src/pages/api/admin/lab-results/register.ts` は
**既存の `test_artifacts` に原本を足す**（`test_artifact_files`）だけで、解析はしない。

しかもこの API は、本機能が §19〜§21 で求める性質を**既に持っている**。

| 要求 | 実装 | 根拠 |
|---|---|---|
| ブラウザの自己申告を信じず S3 実体から SHA/サイズを再算出 | 実装済 | `register.ts:8`（方針コメント）・`:216` `got.sha256` |
| 同じ SHA なら no-op（`already_registered`） | 実装済 | `register.ts:216-223` |
| 別 SHA なら自動差し替えせず停止 | 実装済（`error:'file_exists'` / **409**） | `register.ts:227-237` |
| `raw_pdf` / `raw_csv` の振り分け | 実装済 | `register.ts:206` |

→ **§19〜§21 は新規実装ではなく、この本体を共通ライブラリへ切り出して共用する**のが正しい。

### 2.3 結果として発生している二重操作

```text
① elith-batch : PDF 解析 → artifact 作成 → Elith JSON
② lab-results : 同じ PDF を再度選択 → artifact へ原本 PDF を紐付け
```

---

## 3. 基本方針

既存処理を捨てて「スペシャルアカウント専用の別解析」を作らない。
**既存の本番パイプラインを組み合わせ、管理操作のみを 1 本化する。**

```text
原本PDF ── 一度だけ選択 ── 解析・確認 ── 登録・Elith納品
                                          ├─ 原本S3
                                          ├─ test_artifacts
                                          ├─ measurement_values
                                          ├─ test_artifact_files
                                          ├─ Elith source JSON
                                          └─ Elith production JSON
```

> **1 つの解析結果から、Dashboard 用データと Elith 納品 JSON の両方を作る。**

Dashboard 用と Elith 用に**別々の OCR / LLM 解析を行ってはならない**。

---

## 4. 対象検査

| 表示名称 | `test_type` | Elith `format_id` | 入力 |
|---|---|---|---|
| 血液検査 | `blood` | `BloodTestData` | PDF |
| がんリスク検査 | `cancer_urine` | `CancerRiskAssessmentData` | PDF |
| 遺伝子検査 | `genetics` | `GeneticTestResultData` | PDF |
| AI 疾病発症予測 | `ai_prediction` | `Other` | PDF |

**この対応は既存の写像表と同一**（`src/lib/scan-persist.ts:244-250` `TEST_TYPE_BY_FORMAT`）。
新しい写像を作らない。`format_id` の集合は `src/lib/elith-export.ts:39-47` `ELITH_FORMAT_IDS`。
`test_type` の集合は `supabase/migrations/20260601000010_schemas_and_tables.sql:192` の CHECK。

### 4.1 通常の血液 CSV は変更しない

検査会社から受領する血液 CSV 処理は**正本のまま維持**する。

- `src/lib/elith-blood-csv.ts`（`decodeBloodCsv:29` / `buildBloodCsvBundles:298` /
  `parseBloodCsvRowsStrict:494`）= デメカル CSV の決定論パーサ。

今回追加する PDF 経路は、**CSV が存在せず PDF しかない場合（スペシャル案件・過去データ）の
補助経路**である。**CSV 経路を PDF 解析へ置き換えてはならない。**

---

## 5. 管理画面

新規に `/admin/special-additional-tests` を設ける（wellfort-site）。

既存 `/admin/elith-batch` を改造して本番運用画面にしない。あれは今後も
**テスト・検証・個別バッチ・🎯ゴールデン照合**の技術管理画面として残す。

---

## 6. 対象ユーザーの指定

対象は **スペシャルアカウントとして登録済み、かつ `diagnostic_user_id` が確定済み**の人だけ。

新画面は既存 API から候補を取る。

- `GET /api/admin/special-accounts` → `{ ok, rows:[{uid,label,source,viaEmail,denied}], emails:[…] }`
  （`src/pages/api/admin/special-accounts.ts:20`）
- メールは**マスク済みのものだけ**返る（`maskEmail`・同 `:205`）。

画面に出すのは **マスク済み Google アカウント / `diagnostic_user_id` / 利用中・停止中** の 3 つ。

- **氏名・生メールアドレスは表示も保存もしない。**
- **`?u=<diagnostic_user_id>` で UID を受け渡す設計にしない。** 画面内で選択する。
- **サインイン前で uid が未確定のスペシャルアカウントは対象にできない**
  （`special.account_emails` に予約があるだけでは uid が無い）。

---

## 7. UI

```text
─────────────────────────────
対象ユーザー
  h******@example.com
  USER ID: xxxxxxxx-....

追加検査
─────────────────────────────
検査種別   [ 血液検査 ▼ ]
受診日     [ 2025-06-15 ]
原本PDF    [ blood_2025.pdf ]

[ ＋別の検査・別年度を追加 ]
─────────────────────────────
[ ① 解析・確認 ]
─────────────────────────────
```

複数年は **検査 1 回 = 1 行**。

```text
血液  2023-06-10  blood_2023.pdf
血液  2024-06-11  blood_2024.pdf
血液  2025-06-15  blood_2025.pdf
血液  2026-06-08  blood_2026.pdf
```

異なる検査を同時に並べてよい。

```text
遺伝子      2024-03-10  genetic.pdf
血液        2024-06-11  blood.pdf
がんリスク  2025-08-04  ala.pdf
AI疾病予測  2025-09-10  laif.pdf
```

---

## 8. 受診日の扱い

**受診日は必須入力。自動抽出のみで確定してはならない。**

理由は既に踏んでいるため（推測ではない）。

- ALA-PDS の受付日／報告日の取り違え
- 遺伝子・AI 疾病予測が実行日になった
- 同一日付による S3 キー衝突

| 検査 | `test_date` |
|---|---|
| 血液 | 採血日または検査実施日 |
| ALA-PDS | **受付日** |
| 遺伝子 | 検査日として採用する原本記載日 |
| AI 疾病予測 | 検査・解析の基準日 |

**アップロード日・処理実行日を `test_date` として自動採用してはならない。**

> **実装上の関所**（§0.3 P-3）: `persistAdminBatchArtifact()` は不正な日付を
> `jstToday()` へ落とす（`scan-persist.ts:295`）。本機能は**その関数へ渡す前に**
> `^\d{4}-\d{2}-\d{2}$` を検証し、外れたら **400 で止める**。

---

## 9. 二段階操作（PDF を選ぶのは一度だけ）

### STEP 1 ［① 解析・確認］

- PDF をページ展開
- AI 解析
- データ構造化
- 数値・項目のプレビュー

**この段階でやらないこと**（1 つでもやったら仕様違反）:

- `test_artifacts` を作る
- `measurement_values` を書く
- Elith 本番へ書く
- 原本 S3 への永久保存

### STEP 2 ［② 登録・Elith 納品］

管理者が解析結果を確認して初めて、

- 原本永久保存
- DB 登録
- Elith JSON 生成
- Elith 本番納品

を行う。

**狙い**: 解析に失敗した PDF を **Object Lock 付き原本 S3 へ大量に残さない**
（原本バケットは 10 年保管・削除不可。`docs/operations/S3原本ストレージ_構築手順書.md`）。

---

## 10. PDF の解析方法

### 10.1 縦連結（1 枚の巨大 JPEG）を使わない

**使わない**: wellfort-site `src/pages/admin/elith-batch.astro:517` `renderPdfToJpeg(file)`。

禁止の理由（**C-2 の訂正済み版**）:

- この関数は高さ上限 `PDF_STRIP_MAX_H = 16000`（`:503`）を超えると
  **例外を投げて PDF 全体を中止する**（`:528-533`）。
  1240px 幅の A4 は約 1754px なので **実効 9 ページで打ち止め**。
  → 遺伝子（数十ページ）・LAiF・多ページ血液票は**構造的に通らない**。
- 縦連結は 1 枚の JPEG に押し込むため**解像度が落ちる**。

> **「ページが黙って消える」は 2026-09-27 に直っている**（旧実装は `Math.min(numPages,10)` と
> `Math.min(totalH,16000)` で 41〜45 ページを警告なしに落としていた）。
> 今の実装は中止するので**黙って消えることはない**。
> それでも**大きな PDF が通らない**ので、本機能では使わない。

### 10.2 1 ページ = 1 リクエスト

全検査とも次の形にする。

```text
PDF → 1ページずつ画像化 → 1ページ = 1 AIリクエスト → 全ページ結果をマージ
```

**流用する**: wellfort-site `elith-batch.astro:564`
`renderPdfPages(file, from, to, width, quality)`（既定 1600/0.8。人間ドックは 2200/0.85 を渡す）。
**新しいページ分割器を書かない。**

**ページを黙って省略してはならない。** 省略するのは §13 のとおり
**管理者が明示的に範囲を指定した場合だけ**。

---

## 11. 血液 PDF（今回の新規対応の中心）

```text
Blood PDF
  → ページ単位 AI スキャン
  → measurements[]
  → sanitizeMeasurementsForDelivery()
  → canonicalize
  → dedup
  → BloodTestData
```

**新しい血液専用 OCR ロジックを作らない。** 既存 `src/lib/elith-export.ts` の処理を使う。

| 使うもの | 在処 |
|---|---|
| `scanImageToParsed` | `src/lib/elith-export.ts`（`elith-hc-merge.ts` も同じものを使う）|
| `sanitizeMeasurementsForDelivery` | `src/lib/elith-export.ts`（納品整形の唯一の本体。CLAUDE.md「納品整形は決定論プログラムに集約」）|
| `canonicalize` | `src/lib/canonicalize.ts`（`scan.canonicalize` で on/off）|
| `dedupObservations` | `src/lib/observation-dedup.ts`（`scan.obs_dedup` で on/off）|

### 11.1 CSV との違い

```text
CSV : CSV → elith-blood-csv → 決定論パース
PDF : PDF → AIスキャン    → 同じ Elith measurements 形式
```

最終的な **`BloodTestData.data.measurements[]` の形は一致させる**。
（`elith-blood-csv.ts` も `sanitizeMeasurementsForDelivery` を通している。）

---

## 12. がんリスク（ALA-PDS）

既存をそのまま使う。

- `format_id = CancerRiskAssessmentData`
- `normalizeCancerRisk()` … `src/lib/cancer-risk-fix.ts`（`elith-export.ts` /
  `measurement-persist.ts` から呼ばれている）

ALA-PDS について**既に実装されている**次を**別実装してはならない**。

- 「尿中のポルフィリン量」/「インデックス値」の扱い
- リスクランク
- 分数値の正規化
- 不要な目安表の除外

複数年は `2024-xx-xx` / `2025-xx-xx` / `2026-xx-xx` を**別 artifact** として登録する。

> 運用の前例: `docs/operations/がんリスク検査_ALA-PDS_追加登録手順書.md`
> （**受診日を空欄にすると 2 件が同じ日付になり、片方が S3 キー衝突で消える**）。

---

## 13. 遺伝子検査

- `scanGeneticPage()` … `src/lib/elith-genetic.ts`（`elith-genetic-merge.ts` が呼ぶ）
- マージは `src/pages/api/admin/elith-genetic-merge.ts`

遺伝子結果は **`data.items[]` 型**（`elith-genetic.ts:46` `items: unknown[]`）なので
**`measurement_values` には保存しない。`rows=0` は正常。**
（`scan-persist.ts:337-339` が「測定値を持たない形式は artifact 行だけで終わる。
**これは失敗ではない**」と明記している。）

Dashboard 用には `test_artifacts` / `scan_md` / 原本 PDF を保存する。

### 13.1 ページ範囲

**新機能では既定で全ページを対象**とする。

現行テスト画面の既定 **10〜35 ページ**（wellfort-site `elith-batch.astro:61,63,393`）を
**本番機能へ持ち込まない**。省略は**管理者が明示指定した場合だけ**。

---

## 14. AI 疾病発症予測（LAiF）

- `format_id = Other` / `test_type = ai_prediction`（`scan-persist.ts:249`）
- `scanAiPredictionPage()` … `src/lib/elith-genetic.ts`
- `consolidateAiPredictionItems()` … `src/lib/ai-prediction-consolidate.ts`
  （`fabgate` と直交・`scan.ai_prediction_dedup` で on/off）

**新規解析方式を作らない。** 複数年は `test_date` ごとに**別 artifact**。

> 様式特化プロンプト（`AI_PREDICTION_USER`）は**単一ベンダー・固定様式**という例外で
> 採用済み（CLAUDE.md「却下再掲」の例外）。ここも作り直さない。

---

## 15. 原本 PDF 保存

原本は既存の `AWS_S3_ORIGINALS_BUCKET`（`src/lib/originals-storage.ts`）を使う。

**Vercel Function へ PDF 本体を送信してはならない。**
20MB 超で 413 になる既知問題があるため、

```text
ブラウザ → 署名付き PUT → S3 ORIGINALS
```

とする。

> 既存の上限: `originals-upload-ticket.ts:53` `MAX_ORIGINAL_BYTES = 20 * 1024 * 1024`、
> 署名の有効期限 `:55` `PRESIGN_EXPIRES_SEC = 900`。
> `lab-results/upload.ts:32` の `MAX_FILE_SIZE = 20MB` は**関数を通す旧経路**の値。

---

## 16. 原本キー（氏名を含めない）

**生ファイル名を S3 キーに使用しない。** 本田さん案件の実ファイル名のように

```text
250804ALAPDS結果本田大作.pdf
```

**氏名がファイル名に入る**ことがあるため。

新しい追加検査経路のキーは次の形に**固定**する。

```text
additional_results/{diagnostic_user_id}/{test_type}/{YYYY_MM_DD}/{sha256}.pdf
```

例:

```text
additional_results/5d11742f-.../cancer_urine/2025_08_04/9f2a....pdf
```

**ファイル名・S3 キーに氏名を含めない。**

> **既存キーとの違い**: `originals-upload-ticket.ts:108` `buildOriginalKey()` は
> `lab_results/<company>/YYYY/MM/<filename>` で、**ファイル名をそのまま使う**。
> `isOriginalUploadKey()`（同 `:119`）もその形にしか一致しない
> （`ORIGINAL_COMPANIES = ['rieger','prevent','genoplan','laif']`・`:49`）。
> → **新しいキー用の builder と検証器を足す**（既存の 2 つは変えない）。
> 検証器は既存と同じ規律で書く: **完全一致・`..` と `//` と先頭 `/` を弾く・制御文字を弾く・
> 拡張子を許可集合で見る**（`:119-130` をそのまま写す）。**部分一致にしない。**

---

## 17. 原本アップロード

STEP 2 の開始時、**ブラウザで PDF の SHA-256 を計算**してから

```text
POST /api/admin/special-additional-tests/original-ticket
```

を呼ぶ。入力は `uid` / `test_type` / `test_date` / `bytes` / `sha256_base64`。
サーバは署名付き PUT URL を返す。

**署名処理は `originals-upload-ticket.ts` のものを共用し、独自実装しない。**
Object Lock バケットが要求する checksum の扱いは既に解決済みで、**再現が難しい**。

| 要点 | 根拠 |
|---|---|
| Object Lock 対象への `PutObject` は checksum が必須（無いと 400） | `originals-upload-ticket.ts:28-34` |
| `ChecksumSHA256` を署名に固定する | 同 `:198` |
| **`unhoistableHeaders` が無いと checksum が署名に入らない（実測）** | 同 `:203-212` |
| SHA-256 は **base64・44 文字**で受ける（`isSha256Base64`） | 同 `:97, :172` |

---

## 18. artifact の確定方法（**今回最重要**）

検索キー:

```text
diagnostic_user_id ＋ test_type ＋ test_date ＋ status='active'
```

**`source` を検索条件に入れない。** これが本機能の核心である（§0.3 P-1 / P-2）。

### 0 件 → 新規作成

```text
source = admin_batch
imported_by = admin
status = active
```

`source='admin_batch'` は CHECK に入っている
（`supabase/migrations/20260927000010_test_artifacts_source_admin_batch.sql:32`）。

### 1 件 → **その既存 artifact を利用する**

新しい artifact を作らない。`persistIntoExistingArtifact()`
（`src/lib/scan-persist.ts:378`）相当で次だけ更新する。

- `scan_md`
- `measurements`
- `measurement_values`

**変更しないもの**: `source` / `external_test_id` / `lab_name` / `display_mode` /
`test_date` / `status` / 既存の原本。

> 既存関数はこの規律を既に持っている — `scan_md` だけ更新し
> 「**他の列は書かない（three_mode などを壊さない）**」と明記されている（`:410`）。
> さらに **uid・test_type・test_date の不一致で止める**（`:400-408`）ので、
> 取り違えの最後の関所になる。

**これは本田さんの既存 `wellfort_lab` 行を重複させた過去事故を再発させないため。**

### 2 件以上 → **自動判断禁止**

```text
error: artifact_ambiguous
HTTP 409
```

で停止する。候補として `artifact_id` / `test_date` / `source` / `display_mode` を
管理画面へ返す。**勝手に最新 1 件を選んではならない。**

---

## 19. 原本と artifact の紐付け

解析結果の保存後、`test_artifact_files` へ **`raw_pdf`** として紐付ける
（許可値は `supabase/migrations/20260820000020_originals_file_kind.sql:21`。
redaction は未実装なので `raw_pdf_redacted` を名乗らない）。

**`lab-results/register.ts` の原本検証ロジックを共通ライブラリへ切り出して利用する。**

サーバ側で **S3 の実体を読み直して** SHA256 / ファイルサイズ / Content-Type を確定する。
**ブラウザの自己申告値を DB へ保存してはならない**（`register.ts:8`）。

---

## 20. 同じ PDF の再実行

同じ artifact に**同じ SHA256 の PDF が既に付いていれば成功扱いの no-op**。

```text
already_registered = true
```

新しい `test_artifact_files` 行を増やさない（既存実装 `register.ts:216-223` と同じ）。

---

## 21. 異なる原本が既に存在する場合

同じ artifact に `raw_pdf` があり **SHA256 が異なる**場合は**自動差し替え禁止**。

```text
error: original_conflict
```

で停止する。**新画面から黙って原本を置換しない。**
原本訂正が必要なら管理者が明示的に差し替え操作を行う。

> 既存 `register.ts:227-237` は同じ状況を `error:'file_exists'` / 409 で止め、
> `replace` を明示したときだけ**台帳の古い行だけ**消す（**S3 のオブジェクトは消さない** —
> 10 年保管・削除不可・versioning が履歴を持つ・`:239-241`）。
> 新画面はこの `replace` 経路を**呼ばない**。

---

## 22. 測定値の保存

血液・がんリスクは 2 層へ保存する。

- `test_artifacts.measurements`（jsonb・原本忠実）
- `diagnosis.measurement_values`（正規化・時系列グラフ用）

**書き込み入口は `persistMeasurements()` のみ**（`src/lib/measurement-persist.ts:100`）。
**別の INSERT ロジックを作ってはならない。**
**Dashboard と Elith で異なる値を持たせてはならない。**

---

## 23. Elith source JSON（Wellfort 側の中間・監査層）

```text
{AWS_S3_PREFIX}user/{uid}/date/{YYYY_MM_DD}/{format_id}_date_{YYYY_MM_DD}_user_{uid}.json
```

同じ `uid + test_date + format_id` は**同じキー**になる。**再実行時は同じキーへ書く。**

（既定 prefix は `scan-accuracy-test/`。`src/lib/s3.ts` の `getS3Config()`。
命名は `docs/elith/elith_s3_data_handoff_spec.md`。）

---

## 24. Elith 本番納品

本番納品先:

```text
user/{uid}/date/{YYYY_MM_DD}/
```

追加検査については **今回確定した format の JSON だけを納品する。**

**既存 `elith-delivery-promote.ts` を自動的にそのまま呼んではならない。**

理由（実測）: あの API は `listObjects(`${fromPrefix}user/`)` で**対象 uid 配下を列挙し、
`keep` に一致する全キーをコピーする**（`src/pages/api/admin/elith-delivery-promote.ts:77, 82-89`）。
→ **本機能の対象外 JSON まで再納品し得る。**

> あの API から**流用してよい性質**は 2 つある。
> ① **`.json` 以外は既定でコピーしない**（`:87` `skippedNonJson`。健診のページ画像が
> `HealthCheckupData_…_01.jpg` と format_id 接頭辞で始まるため・`:14-17`）。
> ② **キーの組み替えをしない**（取り違え防止・`:12`）。
> 本機能も**この 2 つを守る**。

---

## 25. Elith 納品 JSON のサニタイズ

本番へ置く JSON は、既存 `src/lib/elith-assemble.ts` の納品サニタイズと**完全に同じ処理**を通す。

現在 **module-private** の

- `sanitizeDelivery()` … `elith-assemble.ts:316`
- `rewriteClientId()` … `elith-assemble.ts:352`

を**共通ライブラリ化**する（呼び出し元の挙動は変えない）。
**追加検査専用に別の JSON 整形を作ってはならない。**

本番納品物では従来どおり次を実行する（`elith-assemble.ts:301-346` で実測）。

| 除去するもの | 根拠 |
|---|---|
| `data.regions`（bbox の器） | `:322` |
| 各要素の `region` / `bbox` | `:337-338` |
| `raw_markdown`（＋ `assembled_from`） | `:344-346` |
| 不要 `category`（区分/region 見出し。**検診・がん・血液とも Elith 要望で除去**） | `:301, :309` |
| measurement の lean 化 | `sanitizeMeasurementsForDelivery`（`elith-export.ts`）|

---

## 26. Elith 納品先キー

追加検査では **`test_date`** を日付フォルダに使う。

```text
user/{uid}/date/2025_08_04/CancerRiskAssessmentData_date_2025_08_04_user_{uid}.json
```

複数年はそれぞれ**別フォルダ**。

---

## 27. `manifest.json` は作らない

**今回の機能では作らない。**

`docs/elith/elith_s3_data_handoff_spec.md:414, 418, 441, 445` に
`manifest.json`（`complete:true`）の **Draft／「提案」段の記述が残っている**が、
現行 `elith-assemble.ts:543-546` は

> 納品フォルダには Elith 規約のファイル (`{format_id}_..._user_....json`) のみを置く。
> 規約外の `manifest.json` は S3 へ書き出さない（Elith「構成が違う」対策）

という実装になっている。**今回の仕様では現行実装を正とする。**

**古い Draft を読んで manifest を復活させてはならない。**

---

## 28. Elith 納品の実行条件

本番 S3 への納品は、次が**全部**成功した後だけ。

1. 解析成功
2. 有効データあり
3. original S3 存在確認
4. artifact 保存成功
5. measurement 保存成功（**items 形式は `rows=0` で正常**）
6. original ↔ artifact 紐付け成功
7. source JSON 生成成功

**この 7 条件が揃う前に本番 `user/` へ書かない。**

---

## 29. 本番納品後の検証（readback）

**PutObject 成功だけで「納品完了」にしない。**

本番 S3 から書き戻した JSON を再取得し、

```text
source JSON の納品版 SHA256 == destination JSON の SHA256
```

を確認する。一致して初めて **Elith 納品完了**とする。

---

## 30. Elith 納品履歴 — 新テーブル

既存 `diagnosis.elith_deliveries` は

```text
unique (diagnostic_user_id, bundle_date, delivery_prefix)
```

で 1 行（`supabase/migrations/20260924000010_elith_deliveries.sql:41`）。
`format_ids text[]`（同 `:27`）を **upsert で丸ごと上書き**する形なので、
追加検査をここへ単純 upsert すると**既存の `format_ids` を消す**。

→ **追加検査の個別納品履歴には使用しない。** 新規に次を作る。

```text
diagnosis.elith_delivery_items
```

| 列 |
|---|
| `id` |
| `test_artifact_id` |
| `diagnostic_user_id` |
| `format_id` |
| `test_date` |
| `source_key` |
| `destination_key` |
| `source_sha256` |
| `destination_sha256` |
| `status` |
| `last_error` |
| `attempt_count` |
| `delivered_at` |
| `updated_at` |

- **PII は保存しない。**
- 一意キー = **`test_artifact_id + format_id + destination_key`**。
- RLS は新テーブルの規律どおり: **有効化・ポリシーを作らない・
  `revoke all from anon, authenticated` / `grant all to service_role`**
  （`20260930000020_shared_access.sql:117-134` と同じ形）。

---

## 31. `elith_deliveries` との役割分担

| テーブル | 意味 |
|---|---|
| `elith_deliveries` | AI 疾病予防報告書等の **診断バンドル単位**の納品記録 |
| `elith_delivery_items` | 今回追加する **個別検査単位**の納品記録 |

**既存 `elith_deliveries` の意味を変更しない。**

---

## 32. エラー時の扱い

| 失敗点 | 挙動 |
|---|---|
| 解析失敗 | **何も保存しない** |
| 原本 S3 upload 失敗 | DB へ登録しない / Elith へ出さない |
| DB 保存失敗 | Elith 本番へ出さない |
| 原本紐付け失敗 | Elith 本番へ出さない |
| source JSON 生成失敗 | Elith 本番へ出さない |
| **Elith 本番書き込み失敗** | **Dashboard 側の登録は残す。** `elith_delivery_items.status='failed'` として**再実行可能**にする |
| **Elith 書き込み成功・履歴 DB 記録失敗** | 本番 S3 を読み直す。同じ destination key で SHA 一致なら **再コピーせず納品履歴だけ修復する** |

---

## 33. 冪等性（必須受入条件）

同じ **ユーザー / 検査種別 / 受診日 / 原本 PDF** を何度処理しても、

- active artifact が増殖しない
- measurement が重複しない
- original file 行が増殖しない
- Elith 納品履歴が増殖しない
- 本番 S3 キーが増殖しない

こと。

---

## 34. 複数年

4 年分の血液は **4 つの独立処理**。

```text
blood 2023 / blood 2024 / blood 2025 / blood 2026
```

**1 件が失敗しても残り 3 件は登録可能。** 画面最後に結果を並べる。

```text
血液 2023  ✅
血液 2024  ✅
血液 2025  ❌ Elith納品失敗
血液 2026  ✅
```

**全件を 1 トランザクション扱いにはしない。**

---

## 35. Dashboard 表示

| 検査 | `test_type` | 反映 |
|---|---|---|
| 血液 | `blood` | `measurement_values` を保存するので **データ一覧・過去データ・時系列グラフ**へ既存クエリで反映 |
| がんリスク | `cancer_urine` | 既存 ALA-PDS 判定・グラフロジックを使用 |
| 遺伝子 | `genetics` | `data.items[]` 型。**measurement rows=0 で正常。** artifact / `scan_md` / 原本 PDF を使う |
| AI 疾病予測 | `ai_prediction` | 同じく items 型。**rows=0 をエラー扱いしてはならない** |

> グラフ系列のキーは `canonical_name`、無ければ `item_name`
> （`measurement-queries.ts` の `seriesKey`。CLAUDE.md「テストフェーズの暫定措置」）。
> **推移は 2 回目の検査から**線が引ける。

---

## 36. 原本表示（本機能の受入条件）

Dashboard → データ → 該当検査で `test_artifact_files.raw_pdf` から原本を表示する。

**今回の機能で登録した PDF について、後から `/admin/lab-results` で再登録する必要が
あってはならない。** これが本機能の受入条件である。

---

## 37. Elith 受領後

本機能が保証する「Elith 納品完了」は
**Wellfort → Elith 本番 S3 への JSON 配置と読戻し検証まで**とする。

Elith が追加 JSON を検知して AI 疾病予防報告書を再処理する起動方式は、
**Wellfort リポジトリ内では確認できない**（未確認。公式に要確認）。

```text
Elith 納品完了  ≠  Elith 再診断完了
```

Elith から新しい受領 JSON が返った後は、既存 `src/lib/elith-report-ingest.ts` を
**変更せず**使用する。既存 `diagnosis_results` を `superseded` へ落として新しい報告書を
最新として扱う現行処理を維持する（`elith-report-ingest.ts:80-85`）。

---

## 38. セキュリティ

既存の分界どおり。

```text
UI        wellfort-site
処理 API  Scan-Chat-AI
```

ブラウザへ次を出してはならない。

- `ADMIN_API_KEY`
- `SCAN_CHAT_AI_API_KEY`
- AWS access key
- Supabase `service_role`

wellfort-site で管理者認証し（`verifyAdmin` = ユーザー自身のアクセストークン +
anon apikey で `admin_users` を照会）、**サーバ間通信**で Scan-Chat-AI API を
Bearer `ADMIN_API_KEY` で呼ぶ（既存 `api/admin/demo-accounts.ts:30-55` が正本パターン）。

原本 S3 については**短時間の署名付き URL のみ**ブラウザへ渡す（15 分・§17）。

---

## 39. PII

**禁止**:

- 生メールアドレスを `diagnosis` DB へ保存
- 氏名を Elith S3 キーへ含める
- 元 PDF ファイル名を S3 キーへ含める
- 生年月日を追加検査 JSON へ含める
- PDF の base64 をログへ出す
- parsed raw 全文をサーバログへ出す

対象の識別は **`diagnostic_user_id` のみ**。

---

## 40. 実装対象ファイル構成案

### Scan-Chat-AI

**新規**

```text
src/lib/special-additional-tests.ts
src/lib/elith-delivery-json.ts
src/lib/additional-originals.ts

src/pages/api/admin/special-additional-tests/
  scan-part.ts
  original-ticket.ts
  finalize.ts

scripts/verify-special-additional-tests.mjs
```

**変更候補**

```text
src/lib/elith-assemble.ts              … sanitizeDelivery / rewriteClientId を切り出す
src/lib/scan-persist.ts                … artifact 検索の共通化 (既存挙動は変えない)
src/lib/originals-upload-ticket.ts     … 新キー用の builder / 検証器を足す
src/pages/api/admin/lab-results/register.ts … 原本登録本体を共通ライブラリへ切り出す
package.json / CI / CLAUDE.md
```

> `lab-results/register.ts` の原本登録本体は共通ライブラリへ切り出し、
> **既存 API もその共通関数を使う**（実装を 2 つ持たない）。

### wellfort-site

**新規**

```text
src/pages/admin/special-additional-tests.astro
src/pages/api/admin/special-additional-tests/   … 中継
```

**既存**

```text
src/pages/admin/special-accounts.astro          … 「追加検査登録」導線を追加
src/components/AdminLayout.astro                … メニュー 1 行
```

---

## 41. DB migration

追加は **`diagnosis.elith_delivery_items` のみ**。

既存 `test_artifacts` / `measurement_values` / `test_artifact_files` / `elith_deliveries` の
**意味・既存データを変更しない**。

### 番号（**C-3 の訂正**）

`supabase/migrations/` は **`20260930000050` まで使用済み**。

```text
20260930000010_admin_impersonation.sql
20260930000020_shared_access.sql
20260930000030_share_consent_rpc.sql
20260930000040_share_links_hidden.sql
20260930000050_share_consent_rpc_revoked.sql
```

→ 新しい migration は **`20260930000060` 以降**（または後の日付）にする。

**適用済みの migration を編集して当て直してはならない**（CLAUDE.md「【重要】」)。
直すときは前進マイグレーションを足す。

---

## 42. 絶対に変更しない機能

- 通常ユーザーの AI スキャン
- AI 問診
- 通常のデメカル CSV 取込
- 検査会社自動連携
- 通常サブスクリプションの Elith entitlement
- 外部共有（External Share）
- admin impersonation（代理表示）
- AI 疾病予防報告書の表示ロジック
- Elith 受領 JSON の解析
- `HealthCheckupData` の既存複数年処理

---

## 43. 今回実装しないもの

- ユーザー自身による追加検査アップロード
- PDF から血液 CSV を生成する処理
- 血液 PDF から不足値を推定する処理
- 血液 PDF からウェルネス年齢を自動再計算
- 任意の検査会社フォーマット専用解析
- 原本の自動差し替え
- AI による受診日の自動確定
- Elith 側の再診断トリガ
- `manifest.json` の復活

---

## 44. 検証項目（`npm run verify:special-additional-tests`）

既存の `verify:*` と同型（実物の TS を transpile し、DB / S3 だけスタブに差し替えて
**実際に動かす**）。**鍵もサーバも要らないので CI の A 層**に置く。

### A. 対象者

| # | 検査 |
|---|---|
| 1 | 非 admin 拒否 |
| 2 | スペシャルアカウント以外拒否 |
| 3 | UID 未確定アカウント拒否 |
| 4 | 別ユーザーへの取り違え拒否 |

### B. PDF

| # | 検査 |
|---|---|
| 5 | PDF を 1 度しか選択しない |
| 6 | 全ページ処理 |
| 7 | 途中ページを黙って捨てない |
| 8 | 20MB 超拒否 |
| 9 | raw filename が S3 キーに入らない |

### C. 日付

| # | 検査 |
|---|---|
| 10 | `test_date` 必須 |
| 11 | **today fallback 禁止**（§0.3 P-3） |
| 12 | ALA 受付日を明示指定可能 |
| 13 | 年度ごとに別 artifact になる |

### D. artifact

| # | 検査 |
|---|---|
| 14 | 既存 0 件 → 新規 |
| 15 | 既存 1 件 → 更新 |
| 16 | 既存 2 件以上 → 409 `artifact_ambiguous` |
| 17 | **`wellfort_lab` 既存行を新規複製しない**（§0.3 P-2） |
| 18 | `display_mode` を変更しない |
| 19 | `external_test_id` を変更しない |
| 20 | `source` を変更しない |

### E. original

| # | 検査 |
|---|---|
| 21 | SHA 同一 → no-op（`already_registered`） |
| 22 | SHA 違い → `original_conflict` |
| 23 | サーバが S3 実体から SHA を再算出 |
| 24 | `test_artifact_files` に 1 件だけ |

### F. 血液

| # | 検査 |
|---|---|
| 25 | PDF → `BloodTestData` 生成 |
| 26 | `measurements > 0` |
| 27 | `measurement_values` へ保存 |
| 28 | **CSV 通常経路に変更なし** |

### G. ALA

| # | 検査 |
|---|---|
| 29 | 既存 `normalizeCancerRisk` を使用 |
| 30 | ALA 値が Dashboard に反映 |
| 31 | ALA 推移ロジックに回帰なし |

### H. 遺伝子 / AI 疾病

| # | 検査 |
|---|---|
| 32 | items 形式で保存 |
| 33 | **`rows=0` を成功扱い** |
| 34 | `scan_md` 保存 |
| 35 | 原本表示 |

### I. Elith

| # | 検査 |
|---|---|
| 36 | local 保存完了前に production へ出ない |
| 37 | `raw_markdown` が production JSON に無い |
| 38 | `bbox` が production JSON に無い |
| 39 | 対象 format 以外をコピーしない |
| 40 | 非 JSON をコピーしない |
| 41 | destination readback SHA 一致 |
| 42 | 再実行で delivery item 増殖なし |
| 43 | **`elith_deliveries` 既存行を書き換えない** |
| 44 | **manifest を生成しない** |

### J. 複数年

| # | 検査 |
|---|---|
| 45 | 血液 4 年 → 4 artifact |
| 46 | がん複数年 → 各日付独立 |
| 47 | AI 疾病複数年 → 各日付独立 |
| 48 | 1 件失敗しても他年度を処理できる |

### K. 退行注入（**この家の規律。最低 6 種**）

「検査が本当に落ちるか」を確かめる。**いずれも名指しで FAIL** すること。

| # | 注入 | 落ちる検査 |
|---|---|---|
| K-1 | artifact 検索に `source` 条件を足す | 17 |
| K-2 | `persistAdminBatchArtifact` を無条件に呼ぶ | 14/15/17 |
| K-3 | `test_date` を today へ fallback させる | 11 |
| K-4 | `sanitizeDelivery` を通さず納品する | 37/38 |
| K-5 | `elith-delivery-promote` の全件コピーを呼ぶ | 39 |
| K-6 | 生ファイル名で S3 キーを組む | 9 |

---

## 45. 本田さんケースの完成イメージ

```text
スペシャルアカウント（本田さん相当の対象 UID）

追加検査
────────────────
🧬 遺伝子        1回
🩸 血液          N回
🎗 がんリスク     N回
🔮 AI疾病予測     N回
```

各検査票について **ファイルを一度選択 → 解析・確認 → 登録・Elith 納品** だけで、

```text
✅ test_artifacts
✅ measurement_values（対象形式）
✅ test_artifact_files
✅ 原本PDF
✅ Dashboard
✅ Elith source JSON
✅ Elith production JSON
✅ production readback 検証
```

まで完了する。**同じ PDF を `/admin/lab-results` へ再度アップロードする作業は不要。**

---

## 46. 完了条件

1. 原本ファイル選択は 1 回
2. 血液 PDF が正式対応
3. 血液 CSV 通常処理は無変更
4. 4 検査すべて Dashboard へ反映
5. 4 検査すべて Elith JSON を生成可能
6. 複数年を日付別に保持
7. 原本が各 artifact に紐付く
8. 既存 artifact を重複生成しない
9. 再実行してもデータが増殖しない
10. production Elith JSON を読戻し検証する
11. 既存スペシャルアカウント標準フローを壊さない
12. 通常ユーザー・通常検査会社処理を壊さない

---

## 47. 実装上の禁止事項

- 既存コードを読まず推測で新パイプラインを作る
- 血液 CSV 処理を PDF 処理へ統合する
- Dashboard 用と Elith 用を別解析する
- `persistMeasurements()` 以外から measurement を独自 INSERT する
- ALA-PDS 正規化処理を再実装する
- 遺伝子解析ロジックを固定スキーマ化する
- 受診日を today へ自動 fallback する
- 同日既存 artifact を無条件 delete する
- `elith-delivery-promote` で uid 配下全 JSON を自動コピーする
- `elith_deliveries` を追加検査のたびに上書きする
- `manifest.json` を追加する
- 原本 PDF を Vercel Function body へ送る
- 元ファイル名を S3 キーに使用する
- PDF の一部ページを黙って省略する
- **今回の目的外のリファクタリングを行う**

---

## 48. Source of Truth

本機能については**本仕様書を正本**とする。

既存ドキュメントと矛盾した場合、**この追加検査機能の範囲については本仕様書を優先する。**
ただし通常検査会社連携・通常 AI スキャン等、**本仕様の対象外部分については既存仕様を優先**する。

### 48.1 関連ドキュメント（対象外部分の正本）

| 文書 | 何の正本か |
|---|---|
| `docs/elith/elith_s3_data_handoff_spec.md` | S3 受け渡しのパス／命名／format_id。**ただし `manifest.json` の記述は Draft で、§27 のとおり現行実装が正** |
| `docs/elith/elith_assembly_wrapping_spec.md` | 納品セットのラップ仕様（§5.6 = LAiF AI疾病発症予測） |
| `docs/operations/がんリスク検査_ALA-PDS_追加登録手順書.md` | 今の手作業運用（本機能が置き換える対象） |
| `docs/operations/スペシャルアカウント_仕様書.md` | スペシャルアカウントの判定・登録（§6 の前提） |
| `docs/lab/スペシャルアカウント_複数年スキャン_仕様書.md` | `HealthCheckupData` の複数年（**本機能は触らない**・§42） |
| `docs/operations/S3原本ストレージ_構築手順書.md` | 原本バケット（Object Lock・10 年保管） |

### 48.2 未確定（推測で確定しない）

| # | 未確定事項 |
|---|---|
| U-1 | **Elith が追加 JSON を検知して再診断を起動する方式**（§37）。Wellfort リポジトリ内では確認できない。Elith へ要確認 |
| U-2 | 血液 PDF の様式がどこまで多様か（PDF 経路は補助なので、まずは受領済みの実物で確認する） |
| U-3 | ALA-PDS 以外のがんリスク様式が来たときの扱い（§43「任意の検査会社フォーマット専用解析」は今回対象外） |
