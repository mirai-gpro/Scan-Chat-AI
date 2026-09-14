# 臨時診断バッチ仕様書
## AI疾病予防報告書・単品購入拡張ケース（トランスコスモス役員10名）

| 項目 | 内容 |
|---|---|
| 版 | v1.1 |
| 作成日 | 2026-09-14 |
| 対象 | トランスコスモス役員10名向け AI疾病予防報告書 |
| 位置づけ | AI疾病予防報告書「単品購入（タイプ2）」の管理者一括投入・追加検査対応 |
| 正本 | 本書 |
| 上位正本 | `docs/lab/lab_data_pipeline_master_spec.md` / `docs/subscription/single_item_purchase_handling_spec.md` |
| 紙面正本 | `docs/elith/AI疾病予防報告書_仕様書.md` |
| 旧仕様 | `docs/旧版・ボツ/臨時診断バッチ/ad_hoc_diagnosis_batch_spec.md` — **参照禁止（履歴調査のみ）** |

---

# 0. 最重要結論

本件は「10名専用の新しい診断方式」ではない。

**AI疾病予防報告書の単品購入（タイプ2）の標準フローを、管理者が10名分まとめて投入できるようにし、標準では存在しない Genoplan 遺伝子検査結果を追加素材として既存診断へ渡す拡張ケース**である。

したがって、臨時診断バッチが行うべきことは次だけである。

```text
受領ZIP
  ↓
人物ごとに整理
  ↓
ファイル種別を確認
  ↓
既存の本番処理へ振り分け
  ↓
既存処理で Elith JSON を生成
  ↓
人間が入力とJSONを確認
  ↓
同一人物の診断素材として Elith へ渡す
  ↓
AI疾病予防報告書
```

臨時診断バッチ自身が、

- 新しいOCR
- 新しい検査parser
- 新しいJSON schema
- 新しい診断ロジック
- 新しい検査値mapping
- 本番と並行する独自状態機械

を作ってはならない。

---

# 1. AI疾病予防報告書・単品購入との関係

## 1.1 標準の単品購入（タイプ2）

上位仕様で確定している AI疾病予防報告書（Elith・単品）の標準フローは次である。

```text
ユーザーがAI疾病予防報告書を単品購入
  ↓
人間ドック または 健康診断データをアップロード
  ＋
WebアプリのAI問診に回答
  ↓
両方が揃う
  ↓
健診データを既存AIスキャン
  ↓
HealthCheckupData
  ＋
既存AI問診結果
  ↓
LifestyleQuestionnaireData
  ↓
Elith S3
  ↓
Elith AI診断
  ↓
AI疾病予防報告書
```

標準タイプ2では、ユーザーがスキャン／アップロードする検査資料は **人間ドックまたは健康診断** が基本である。

AI問診は検査票をスキャンするのではなく、Webアプリ内で回答し、既存の問診処理から `LifestyleQuestionnaireData` を生成する。

## 1.2 今回の10名案件

今回の10名は通常の購入導線から入力したのではなく、既に実施済みの資料一式がZIPで提供された。

さらに、標準タイプ2には無い **Genoplan 遺伝子検査結果** が全員分提供されている。

したがって今回を次のように定義する。

```text
【標準タイプ2】
健診/人間ドック
  → HealthCheckupData

AI問診
  → LifestyleQuestionnaireData

【今回追加】
Genoplan PDF
  → GeneticTestResultData

この3素材を同一人物へ紐付け
  ↓
Elith AI診断
  ↓
AI疾病予防報告書
```

**遺伝子検査が追加されても、本案件の商品区分はタイプ2（単品購入）のままとする。**

遺伝子検査の存在だけを理由に、コースプラン用のタイプ1へ変更してはならない。

AI疾病予防報告書の紙面・カード構成・タイプ判定は `docs/elith/AI疾病予防報告書_仕様書.md` を正本とし、本仕様書で再定義しない。

---

# 2. 実データ確認結果

2026-09-10受領ZIPを実物確認した結果、以下を確認した。

## 2.1 構成

- 人物フォルダ: **10名**
- ファイル総数: **38**
- PDF: **22**
- XLSX: **15**
- DOCX: **1**
- Genoplan PDF: **10件**
- Genoplan PDFページ数: **208ページまたは210ページ**
- 共通問診XLSX: **8名分**
- 問診PDF: **2名分**
- 健診PDF: **10名分**
- 追加の健診系XLSX: **5名分**
- Demecal血液CSV: **0件**

一時Officeファイル等は検査入力として扱わない。

## 2.2 今回の入力種別

人物ごとの診断素材は、実質的に次の3系統である。

1. 健康診断／人間ドック
2. 問診
3. Genoplan 遺伝子検査

一部人物には健診PDFに加え、39列の健診系XLSXが存在する。

ただし本仕様 v1 では、そのXLSXから臨時バッチ独自に `HealthCheckupData` を生成しない。

**標準タイプ2と同じ「健診スキャン」経路を正とする。**

追加XLSXは入力照合・人間レビューの補助資料として利用できるが、新parserの根拠にはしない。

---

# 3. 事実の優先順位

本案件では仕様判断の優先順位を次で固定する。

1. Productionで実際に動いているコード
2. Productionの実データ・実ファイル・実API結果
3. 本番正本仕様
4. 人間が確認したGolden Sample
5. 実測ログ
6. 推論

推論が上位の事実を上書きしてはならない。

禁止事項:

- 「一般的には」で処理を決める
- 旧臨時診断仕様を本番仕様の根拠にする
- ファイル名だけで検査種別を確定する
- 日付を推定する
- 人物を推定で紐付ける
- 項目名を類似文字列で勝手にmappingする
- parser成功をデータ正当性とみなす
- テストPASSだけで診断可能と判定する
- 本番処理を読まずに同じ機能を再実装する

---

# 4. 責務分界

## 4.1 wellfort-site

担当:

- 管理者UI
- 人物マスタ（PII）
- ZIP投入
- 人物とファイルの確認
- Executive Subjectとの明示的な紐付け
- 処理開始
- 人間レビュー
- Elith投入の最終承認

氏名、会社名、役職、メール等のPIIは原則として Wellfort 側だけに保持する。

## 4.2 Scan-Chat-AI

担当:

- 既存の検査スキャン／構造化処理
- 既存問診JSON生成
- 既存Genoplan構造化
- validation
- Elith形式JSON生成
- S3処理

Scan-Chat-AIには原則として opaque ID を渡し、氏名を診断キーとして使用しない。

## 4.3 臨時診断バッチ

臨時診断バッチは **オーケストレーション層**である。

担当してよいもの:

- ZIPエントリの一覧化
- 人物フォルダ単位のグルーピング
- ファイル種別の候補判定
- 管理者による確定
- 既存本番処理の呼び出し
- 処理結果の一覧表示
- 人間レビューのための元資料とJSONの対応表示
- retryの起動

担当してはいけないもの:

- 検査値の独自抽出
- 独自のElith JSON組み立て
- LLM利用可否を独自判断
- 本番と別の検査項目正規化
- 独自の診断readyルール

---

# 5. 人物の識別

## 5.1 ZIP内の人物フォルダ

今回のZIPは人物フォルダ単位に資料がまとまっている。

このフォルダ構造は「どのファイルが同一人物か」を確認する一次情報として使用してよい。

ただしフォルダ名に氏名が含まれるため、Scan-Chat-AI側の永続的な識別キーとしては使用しない。

## 5.2 Executive Subject

Wellfort側の `executive_subjects` を人物マスタとする。

管理者が、

```text
ZIPの人物フォルダ
   ↕ 人間が確認
executive_subject_id
```

を確定する。

Scan-Chat-AIへ渡す人物識別子は `executive_subject_id` 等のopaque UUIDとする。

**fingerprintから人物を推定して自動確定してはならない。**

fingerprintは重複検出等の補助に使う場合があっても、本人確定の根拠にはしない。

---

# 6. 健診・人間ドック処理

## 6.1 今回の正規入力

今回、全10名に健診PDFが存在する。

したがって v1 の `HealthCheckupData` 生成元は **健診PDF** を正とする。

## 6.2 使用する本番処理

既存の本番健診処理を使用する。

主要実装:

- `src/pages/api/admin/elith-hc-merge.ts`
- `src/lib/elith-export.ts`
- `scanImageToParsed()`
- `sanitizeMeasurementsForDelivery()`
- 既存canonicalize / dedup / validation

基本処理:

```text
健診PDF
  ↓
ページを画像化
  ↓
既存 HealthCheckup AI scan
  ↓
各ページの measurements
  ↓
既存 finalize
  ↓
正規化 / dedup / validation
  ↓
HealthCheckupData JSON
```

**臨時バッチ専用 `health-checkup-xlsx.ts` をHealthCheckupData生成の正経路にしない。**

## 6.3 健診系XLSX

今回、一部人物に39列の健診系XLSXがある。

本仕様 v1では、

- 健診PDFからの生成結果との照合
- 欠落項目の人間確認
- Golden Sample作成

の補助資料とする。

XLSXを直接JSON化する新しい本番parserを追加する場合は、別途仕様決裁を行うこと。

## 6.4 日付

健診日を原資料または既存本番処理から確定する。

日付が確定できない場合:

- todayを入れない
- ZIP作成日を入れない
- ファイルmtimeを入れない
- 他検査の日付を流用しない

管理者確認へ送る。

---


## 6.5 ad-hoc からの健診PDF結線

現行 ad-hoc 実装は健診 XLSX の `normalized_payload` を前提としており、
健診 PDF を `HealthCheckupData` と分類しても production HealthCheckup scan へは結線されていない。

したがって v1.1 では、**健診 PDF を既存 production HealthCheckup 処理へ新規結線する**。

ただし、現在の `POST /api/admin/elith-hc-merge` を ad-hoc UI からそのまま実行してはならない。
同 API は通常運用では part 時に元画像、finalize 時に JSON を S3 へ書くため、
Human Review 前に実書き込みが発生する。

### 必須条件

- 解析アルゴリズムを ad-hoc に複製しない。
- production の `scanImageToParsed()` および HC finalize の正規化処理を共用する。
- ad-hoc の解析段階では S3 の Elith 納品領域へ書かない。
- Human Review 後の既存 ad-hoc export/write-guard だけが実納品を行う。
- production 通常経路の既定挙動は変更しない。

### 実装方針

第一候補は、`elith-hc-merge.ts` 内の finalize 処理を **副作用のない共通 core** へ抽出し、
通常 endpoint と ad-hoc の両方が同一 core を呼ぶ方式とする。

ad-hoc 側は PDF ページ画像を 1ページずつ既存 scan に渡し、
ページ結果を保持して同じ finalize core で `HealthCheckupData` を生成する。

共通 core 抽出が不可能または過大変更になる場合に限り、
既存 endpoint へ挙動互換の `dryRun` を追加する案を検討する。
その場合も、dry-run 結果と本番 export が別ロジックになってはならない。

**Human Review 前の S3 書き込みを回避するためだけに、
ad-hoc 独自の HealthCheckup JSON builder を作ってはならない。**

# 7. 問診処理

## 7.1 標準タイプ2との違い

標準タイプ2では、ユーザーがWebアプリ上でAI問診に回答する。

今回の10名は、その回答結果が外部ファイルとして既に提供されている。

実物:

- 62列の共通問診XLSX: 8名
- 問診PDF: 2名

したがって、ここだけは標準UI入力をファイル入力へ橋渡しする必要がある。

## 7.2 JSON生成は既存処理を使用

最終的な `LifestyleQuestionnaireData` JSON生成は既存関数を使用する。

主要実装:

- `src/lib/interview-export.ts`
- `buildElithInterviewJson()`
- 既存 `QUESTIONS`
- 既存 question ID / AnswerValue

新しい `LifestyleQuestionnaireData` schemaを作ってはならない。

## 7.3 ファイル→answers変換

外部問診ファイルは、まず既存問診の内部表現である

```ts
Record<question_id, AnswerValue>
```

へ変換する。

その後、

```text
外部問診
  ↓
既存question_idへ明示mapping
  ↓
answers
  ↓
buildElithInterviewJson()
  ↓
LifestyleQuestionnaireData
```

とする。

### 重要

この「外部ファイル→answers」の部分は、標準タイプ2には存在しない **今回必要な薄い入力adapter** である。

許されるのは、

- 既存question IDへの明示mapping
- 完全一致／承認済み対応表による値変換
- PIIを除いたsubject属性の生成
- unmapped項目の検出

まで。

禁止:

- fuzzy mapping
- LLMによる設問推定
- 未知の回答値を近い選択肢へ自動変換
- 未回答を推測で補完

## 7.4 実物確認結果と現行adapterの扱い

実際の62列XLSXを現行 `questionnaire-map.ts` と照合したところ、
外部XLSXの列名は「身長を教えてください。（172cmの場合…）」等の**完全な設問文**であるのに対し、
現行 `COLUMN_TO_QUESTION` は「身長」「喫煙習慣」等の短縮キーを持つ。

現行実装は正規化後の完全一致で引くため、**このままでは実物62列XLSXを正しく既存 question_id へ結線できない。**

したがって、現行adapterを「Goldenで問題が無ければそのまま採用」とはしない。
**実物の列見出しを正本に、外部列 → production question_id の明示変換契約を作り直す。**

### XLSX

8名分のXLSXは構造化データとして扱う。

- LLMで設問意味を推定しない。
- 実物の完全な列見出しを明示mapする。
- production側の question_id / AnswerValue を最終形とする。
- 選択肢ラベルが同一の場合は完全一致。
- 数値からproductionの帯域選択へ変換する必要がある場合は、境界条件を仕様化した決定論変換だけを許す。
- production schemaで表現できない複数回答・未知疾病・未知値は勝手に切り捨てず `needs_review` とする。
- がんリスク検査専用列、AI疾病予測専用列、同意列など、今回の `LifestyleQuestionnaireData` 対象外項目は明示的に `ignored_by_spec` として扱う。
- 「最初に一致した値だけ採る」のような情報欠落を禁止する。

### PDF

今回の2名分PDFは、回答がラジオボタン／チェックボックスの**視覚的な選択状態**で表現されている。

PDF本文のテキスト抽出では、選択・未選択の両方の選択肢文字列が取得されるため、
現行 `normalizePdfText()` の「同じ行または次行を回答とみなす」方式では回答を保証できない。

よって本案件では、

- PDF問診をtext parserで自動 `answers` 化しない。
- LLMに選択状態を推測させない。
- 管理者がPDFを見て、productionの question_id / AnswerValue へ**手動確認入力**する。
- 入力後に別の管理者または同等の二重確認を行う。

2名だけの臨時入力であるため、誤変換リスクを負って自動化するよりHuman Reviewを優先する。

## 7.5 production分岐の適用と納品ゲート（最終指示書 §3〜§5・2026-09-14）

§7.4 の決定論写像（Phase A）だけでは**production の問診票として成立しない**。
`QUESTIONS[].when` の分岐が最終 answers へ適用されておらず、
`buildElithInterviewJson()` は渡された answers をそのまま出すためである。

### Phase A / Phase B の2段

```text
raw XLSX
  ↓  Phase A  external-form-contract.ts の決定論写像（§7.4）
tentative answers
  ↓  Phase B  production resolvePath() / QUESTIONS[].when を**共用**
active answers
  ↓
buildElithInterviewJson()          ← 既存関数だけ
LifestyleQuestionnaireData
```

**独自のwhenロジックをコピーしない。** `interview-script.ts` の `resolvePath()` を
そのまま呼ぶ。同じ条件式を2か所に置くと問診票を直したとき必ず片方が腐る。

### inactive question の扱い

productionで質問されない設問は `LifestyleQuestionnaireData` に入れない。
件数は `ignored_by_branch` として監査用に持つ（DB migrationは不要。
既存 `normalized_payload jsonb` の中で足りる）。

ただし**黙って医療情報を捨てない**。

| inactive な設問の値 | 扱い |
|---|---|
| `なし` / `摂取していない` / 空欄 / `0` | 通常の branch ignore |
| `E-TIME` / `E-TYPE`（運動の時間・種類） | 値の中身に関わらず branch ignore |
| それ以外の実質的な値（実薬名・喫煙本数・飲酒量・治療状況 等） | **矛盾として `needs_review`** |

例:
- `E-FREQ = ほとんどしない` → `E-TIME` / `E-TYPE` は納品 answers へ入れない（`ignored_by_branch`）
- `M-HAS = ない` + `M-NAME = なし` → branch ignore
- `M-HAS = ない` + 実薬名 → `needs_review`（薬情報を黙って捨てない）
- `S-STATUS = 吸ったことはない` + `0`/空 → branch ignore
- 非喫煙なのに正数の喫煙本数 → `needs_review`

### 納品ゲート（最重要）

`questionnaireIsUsable()` が true になるのは次の**すべて**を満たすときだけ。

```text
schema OK
completedAt resolved
mapped answers > 0
未解決の active な要確認 = 0
```

**一部だけ写像できた `LifestyleQuestionnaireData` を完成品として出さない。**
要確認が1件でも残る人物は納品しない。

### Human Review による解決

PDF用に作った `questionnaire-manual.ts` / `questionnaire-answers` API /
`QUESTIONS` による厳密validation / confirmation を**そのまま再利用する**。
新しい自由形式parserを作らない。

```text
deterministic answers + confirmed manual overrides → production分岐 → final answers
```

- 保存してよいのは `review_question_ids: string[]` と `ignored_by_branch_count: number` の
  **question_idと件数だけ**。未知の生回答値そのものは永続化しない。
- 原本のraw回答値を診断DBへ保存しない。管理者は既存
  `GET /api/admin/ad-hoc-diagnosis/file?batchId=...&fileId=...` で原本を開いて確認する
  （新しいファイル保存機構は作らない）。
- wellfort-site の画面には 要確認 question_id / production設問文 / production選択肢 /
  「原本を開く」/ 回答入力 / 確認 を出す。**PDFと同じ confirmation 機構**。
- 未確認の手入力は納品に使わない。入力を差し替えたら確認は外れる。

### 既知の落とし穴（実測 2026-09-14）

`assertNoPiiKeys()` の deny-list は `name` を部分一致で見るため、
**設問id `M-NAME` に当たって「服薬あり」と答えた人物の保存が丸ごと throw していた。**
→ 除外は**実在する設問idとの完全一致のみ**。`display_name` のような本物のPIIキーは
今までどおり止める（部分一致での除外にしてはならない）。

---

### Golden / fixture の取り扱い

実在役員の氏名・問診回答・健康情報をGitリポジトリへfixtureとしてcommitしてはならない。

- 実データは安全な環境で一時照合に使う。
- repoへ残すテストfixtureは匿名化・合成データとする。
- 実物から得た**列schema、値domain、mapping規則**のみを仕様・テストへ反映する。

---

# 8. Genoplan 遺伝子検査処理

## 8.1 今回の追加検査

全10名にGenoplan PDFが存在する。

ページ数は208または210ページである。

この全ページをLLMへ送ってはならない。

## 8.2 本番での対象ページ

既存本番UIおよびGenoplan Golden Sampleで使用している対象は、

**元PDF p10〜35 inclusive**

である。

対象ページ数は **26ページ**。

既存Golden:

`docs/scan/golden/scan_golden_genetic_geneplanet_20240131.md`

で、p10〜35から疾患リスク倍率を持つ項目220件を対象としている。

体質系の定性項目はv1対象外。

p29〜35のランキングページはdetailページとの重複を含むため、既存の項目名dedupルールを維持する。

## 8.3 使用する本番処理

既存処理:

- `src/lib/elith-genetic.ts`
- `scanGeneticPage()`
- `src/pages/api/admin/elith-genetic-merge.ts`

を使用する。

```text
Genoplan PDF
  ↓
p10〜35だけをページ画像化
  ↓
1ページ = 1リクエスト
  ↓
scanGeneticPage()
  ↓
既存 finalize
  ↓
GeneticTestResultData
```

構造化は既存仕様どおりLLMを使用する。

## 8.4 全ページ走査は禁止

以下は禁止。

```text
p1 → p208/210 を全部LLM処理
```

cacheが存在することは、不要ページを送ってよい理由にならない。

## 8.5 ページ制約の責務

wellfort-siteだけでp10〜35へ絞ってはならない。

Scan-Chat-AI側でもGenoplanの対象ページ集合を検証する。

少なくとも臨時診断経路では、

- page < 10
- page > 35

をLLM処理へ到達させない。

対象ページ情報は可能な限り1箇所を正本とし、UIとサーバへ別々に同じ数値をコピーしない。

### 正本の配置

Genoplan v1 の required page set は **Scan-Chat-AI 側を正本**とする。

第一候補:

- `src/lib/elith-genetic.ts` に p10〜35 のrequired page set / 判定関数をexportする。
- ad-hoc status または processing plan API がそのrequired page setを返す。
- wellfort-siteはAPIから受けたpage setだけをレンダリングする。
- Scan側の受付拒否とcomplete判定も同じ定数を使う。

wellfort-siteへ `10` / `35` を独立した正本としてハードコードしない。
既存 `elith-batch.astro` の編集可能なfrom/to既定値は運用UIの初期値であり、
ad-hocのcomplete条件の正本として使用しない。


## 8.6 完了判定

「受信したページを全部処理した」ではなく、

**必要なp10〜35の処理が揃っている**

ことを確認する。

通信断などで1ページ自体が登録されていない場合も未完了とする。

## 8.7 日付

`elith-genetic-merge.ts` の汎用admin処理には未指定時today fallbackが存在するが、今回の実データ処理では利用しない。

Genoplanの `test_date` は原資料または確認済みの業務データから確定する。

不明な場合は管理者確認。

---

# 9. BloodTestDataの扱い

## 9.1 今回ZIPにはBloodTestData用CSVが存在しない

今回のZIPに Demecal CSV は存在しない。

したがって、この10名について独立した `BloodTestData` を生成する要件は **現時点ではない**。

健診PDF内に記載されている血液検査値は `HealthCheckupData` の一部として健診処理で読み取る。

この2つを混同してはならない。

## 9.2 本番のBloodTestData原則

将来、臨時投入でDemecal血液CSVを扱う場合も、本番処理を使用する。

主要実装:

- `src/lib/elith-blood-csv.ts`
- `parseBloodCsvRowsStrict()`
- `src/pages/api/admin/elith-blood-csv.ts`

本番原則:

> **LLMは使用しない。構造化データは決定論パースで値を完全転記する。**

```text
Demecal CSV
  ↓
Shift_JIS decode
  ↓
既存production strict parser
  ↓
本人解決
  ↓
BloodTestData
```

以下は禁止。

```text
CSV → Gemini/LLM → BloodTestData
```

また、

- `0` と空欄を混同しない
- 指図番号を数値化しない
- 日付をtodayで補完しない
- PIIをElith JSONに載せない

という既存本番仕様を守る。

---

# 10. 今回の人物単位の診断素材

本案件の v1 では人物ごとに次を扱う。

| format | 今回 | 役割 |
|---|---:|---|
| `HealthCheckupData` | 必須 | 標準タイプ2の健診入力 |
| `LifestyleQuestionnaireData` | 必須 | 標準タイプ2のAI問診相当 |
| `GeneticTestResultData` | 今回は全員あり | 今回追加された診断素材 |
| `BloodTestData` | なし | Demecal CSVが無いため生成しない |
| `CancerRiskAssessmentData` | なし | 今回入力に無い |
| `Other` | なし | 今回入力に無い |

「今回は全員に遺伝子がある」ことと、「AI疾病予防報告書タイプ2で遺伝子が永久に必須」であることを混同しない。

商品標準仕様としては遺伝子は追加素材であり、今回案件の入力条件として全員分が存在している。

---

# 11. Elith handoff

## 11.1 JSONを人物単位に揃える

同一人物について、

- `HealthCheckupData`
- `LifestyleQuestionnaireData`
- `GeneticTestResultData`

を同じ `client_id` / `diagnostic_user_id` 系統へ紐付ける。

S3パスは既存Elith handoff仕様を使用する。

```text
user/{client_id}/date/{YYYY_MM_DD}/
```

ファイル名も既存format規則を使用する。

臨時バッチ独自のファイル名を作らない。

## 11.2 日付を無理に統一しない

各検査にはそれぞれ実施日／完了日／報告日がある。

本番仕様が要求する場合を除き、異なる検査を同一の架空日付へ書き換えない。

Elithへ渡す最終構成は既存Elith handoff / assembly仕様を正とする。

## 11.3 書き込み前レビュー

実S3への最終書き込み前に、人物ごとに以下を確認できるようにする。

- Executive Subject
- 元ファイル
- format_id
- test_date
- JSON item数
- validation結果
- 元資料との照合結果
- 未解決項目

管理者が最終承認してから書き込む。

## 11.4 E2E確認用「1 JSONだけS3へ書く」経路（2026-09-14・発注者指示）

**正式なバッチ納品ではない。** 1名のE2E確認として、生成済みの `HealthCheckupData` JSON
**1ファイルだけ**を実際のElith納品先へ置き、中身を原本と突き合わせるための口。

### 通常納品との関係

**通常の `assembleBatch` / write-guard / 部分納品禁止は1文字も変えない。**
「1人でも未完成なら部分納品しない」という規則を緩めるのではなく、
**経路そのものを分ける**（`exportSingleDeliveryFile()` / `POST /export-one`）。
E2E確認では部分納品禁止に引っかかるのが**正常**なので、例外分岐を足すのではなく別経路にする。

### 新しいJSONを作らない

納品ファイルの組み立ては `buildSubjectDelivery()` **1か所だけ**で、
通常の dry-run / 本番納品と **同じこれ**を呼ぶ。
→ PUTするbodyは通常納品時にS3へ書くJSONと**バイト単位で同じ**。
E2E用の builder を作らない（作ると「確認したJSONと納品したJSONが別物」になる）。

### PUT前の条件（すべて満たさなければ書かない）

| | 内容 |
|---|---|
| 人物 | Executive Subject が紐付いていること（誰のものか確定しないまま置かない） |
| 件数 | 指定 subject × 指定 format で**ちょうど1件**（0件・2件以上は失敗） |
| 日付 | 操作者が原本で確認した `expectTestDate` と生成された `test_date` が一致（**省略不可**・today混入の番人） |
| 本文 | JSON本文の `format_id` / `client_id` / `test_date` が想定と一致 |
| env | `AD_HOC_ELITH_WRITE_ENABLED=on` かつ `AD_HOC_ELITH_WRITE_TARGET` が実際の bucket+prefix と完全一致 |
| key | `validateDeliveryKey()` を通ること（`DeliveryFile.key` をそのまま使う・手で組み直さない） |
| 既存 | `HeadObject` で既存を確認し、**在れば中止**（上書きしない・削除して再実行もしない） |
| PUT | `IfNoneMatch: '*'` の create-only |
| 事後 | `HeadObject` で読み戻して存在を確認 |

### 書いてもバッチを納品済みにしない

- `batch.status` を `completed` にしない（失敗しても `failed` にしない）
- 他 format の output を `exported` にしない
- 通常exportの完了イベント（`exported`）を発火しない
- 監査だけは既存 event 名 `override` + `detail.kind = 'e2e_single_write'` で残す（**新 migration なし**）

→ 通常の一括納品から見ると、バッチは**引き続き未納品**。

### 確認は「1ファイル在ったこと」では終わらない

API は**実際にPUTした本文そのもの**を返し、管理画面から保存できる。
原本の健診PDFと 身長/体重/BMI/血圧/HbA1c/AST/ALT/γ-GTP/HDL/TG/LDL を突き合わせて
初めて PASS とする。**本文はログに出さない・repoにcommitしない。**

### 検証

`npm run verify:ad-hoc-single-write`（退行注入10種）。
とくに「通常納品の部分納品禁止が緩んでいないこと」「create-onlyのままであること」
「batchをcompletedにしないこと」を機械で固定する。

---

# 12. Golden Sample

実装・本番投入前に最低限次を作る。

## 12.1 健診

1名以上について、

```text
元健診PDF
  ↓ 人間確認
期待 HealthCheckupData
```

を作る。

特に、

- 血圧
- 身長・体重・BMI
- 血算
- 肝機能
- 脂質
- 血糖
- 腎機能
- 尿
- 定性項目

を確認する。

## 12.2 問診

XLSX形式とPDF形式を別々にGolden化する。

```text
元ファイル
  ↓
期待 question_id / answer
  ↓
期待 LifestyleQuestionnaireData
```

全mappingを人間確認する。

## 12.3 Genoplan

既存Genoplan Goldenを使用する。

最低条件:

- p10〜35だけが入力
- 疾患リスク倍率220項目
- 重複ページのdedup
- 対象外体質ページを混入させない

---

# 13. ValidationとHuman Review

処理段階を次のように分ける。

```text
Read
 ↓
Route
 ↓
Production Process
 ↓
Normalize
 ↓
Validate
 ↓
Human Review
 ↓
Deliver
```

次を同一視しない。

```text
ファイルを開けた
≠ JSONを作れた
≠ JSONが正しい
≠ Elithへ渡してよい
≠ AI疾病予防報告書が正しい
```

### 人間レビューで確認するもの

健診:
- 元資料の主要値とJSON値

問診:
- 回答数
- unmapped
- unknown_value
- 選択肢mapping

遺伝子:
- 対象ページ
- item数
- Golden一致率
- missing / wrong / surplus

---

# 14. Retry

retryは新しい解析ロジックを持たない。

**初回と同じ既存処理を再実行するだけ**とする。

- 健診 → 同じHealthCheckup処理
- 問診 → 同じadapter＋既存JSON生成
- Genoplan → 同じp10〜35＋同じ`scanGeneticPage`

成功済みGenoplanページcache等、既存の安全な再利用機構は利用してよい。

ただしcacheの存在を理由に全208/210ページを再送してはならない。

---

# 15. 状態管理

臨時診断バッチ独自の診断状態機械を正本にしてはならない。

既存DBにad-hoc用テーブルや列が存在していても、

- `parse_status`
- `validation_status`
- `ready`
- `required_formats`
- `optional_present_but_not_ready`

等の独自状態だけを根拠に「診断可能」と判断しない。

これらを運用表示・監査補助として残す場合でも、最終判定は

1. 既存本番処理の正常完了
2. JSON validation
3. Golden / 元資料確認
4. Human Review
5. Elith handoff条件

による。

---

# 16. セキュリティ・PII

- 氏名・メール・会社名・役職はWellfort側に保持
- Scan側へPIIを不要に送らない
- Elith JSONへ氏名・住所・メール等を入れない
- ZIP原本はPII・健康情報を含むためアクセスを管理する
- ログへ検査値・氏名を大量出力しない
- エラーにはファイル内部の健康情報をコピーしない
- S3書き込みは既存write guardを維持
- dry-run / previewで確認後に実write

---

# 17. 今回、作ってよい専用機能

今回専用に必要なのは次に限定する。

1. ZIP受付
2. ZIP内ファイル一覧
3. 人物フォルダのグルーピング
4. Executive Subjectとの手動紐付け
5. 入力種別の候補表示
6. 管理者による種別確定
7. 外部問診ファイルを既存`answers`へ変換する薄いadapter
8. 既存本番処理の起動
9. 元資料と結果のレビューUI
10. 10名分の進捗一覧

それ以外は原則として既存機能を使用する。

---

# 18. 今回、作ってはいけないもの

- 独自HealthCheckup JSON parser
- 独自BloodTestData parser
- 独自Genoplan JSON parser
- 全GenoplanページLLM処理
- LLMによる問診column推定
- 臨時バッチ専用Elith schema
- 独自の疾病診断ロジック
- 別系統のAI疾病予防報告書生成
- 推定日付
- 推定人物紐付け
- 必要性が証明されていない新DB状態

---

# 19. 既存実装の扱い

旧ad-hoc実装は一括して正とも誤りとも扱わない。

ファイル／hunk単位で次に分類する。

### A. 維持
例:
- Executive Subject分離
- PIIをWellfort側だけに置く仕組み
- write guard
- S3 Range処理
- chunked ZIP読取
- resume
- 安全なproxy fail-closed
- 既存処理を呼び出すだけのUI

### B. 修正
例:
- Genoplan全ページ処理
- 対象ページのサーバ側制約不足
- 完了判定
- today fallbackへ依存する経路

### C. 原則撤去／不使用
例:
- ad-hoc独自健診XLSX→HealthCheckupData生成
- 本番と重複するJSON生成
- 本番と競合する独自ready判定

### D. 要Golden確認
- `questionnaire-map.ts`
- `questionnaire.ts`

---

# 20. 現時点の要決裁事項

## Q1. 外部問診adapter — 決裁済み

今回、標準Web問診ではなくXLSX/PDFを受領しているため、

**外部ファイル → 既存answers**

の入力adapterは必要。

決裁:

- XLSX: 実物62列schemaを基にした**明示的・決定論adapterを作り直す**。
- PDF: 自動text parserを使わず、Human Reviewで既存answersへ入力する。
- 最終JSONは必ず既存 `buildElithInterviewJson()` を使用する。
- production question schemaで表現できない値は推測・切捨てせず `needs_review` とする。

## Q2. 健診XLSXの位置づけ

v1では補助資料とする。

将来、PDFスキャンより構造化XLSXを正として直接取り込む要件が生じた場合は、臨時案件ではなくProduction機能として別仕様化する。

## Q3. Elith側でGeneticTestResultDataをタイプ2診断へ追加した際の受入

Scan側でJSONを生成できることと、Elith診断がその素材を今回のAI疾病予防報告書へ正しく反映することは別問題である。

本番投入前に、

- 同一client_id
- `HealthCheckupData`
- `LifestyleQuestionnaireData`
- `GeneticTestResultData`

を渡したテスト1名について、Elith出力へ遺伝子情報が正しく反映されることをE2E確認する。

この確認が取れるまで10名一括本番投入しない。

---

# 21. E2E Acceptance Criteria

1. 10名が明示的にExecutive Subjectへ紐付く
2. 全員の健診PDFが既存HealthCheckup処理を通る
3. ad-hoc独自健診XLSX parserを本経路で使わない
4. 問診は既存question IDへmappingされる
5. 問診JSONは既存`buildElithInterviewJson()`で生成される
6. Genoplanは各人p10〜35だけを処理する
7. p1〜9 / p36以降はLLMへ送られない
8. GeneticTestResultDataは既存`scanGeneticPage()`を利用する
9. BloodTestDataを今回のZIPから捏造生成しない
10. 独立Blood CSVを将来扱う場合もLLMを使わない
11. 日付を推定・today補完しない
12. 各人物について元資料とJSONを人間確認できる
13. dry-runでElith納品内容を確認できる
14. 1名でElith E2Eを先行確認する
15. 遺伝子情報がAI疾病予防報告書へ反映されたことを確認する
16. その後に10名を処理する
17. 他の本番案件・決済・メール・通常検査パイプラインを変更しない

---

# 22. 最終成功条件

本案件の成功条件は、

- APIが200を返した
- ZIPを展開できた
- JSONを生成できた
- DB上readyになった
- テストがPASSした

ことではない。

唯一の最終条件は、

> **10名全員について、本人の健診・問診・Genoplanの実データが正しく反映されたAI疾病予防報告書を完成させ、トップセールスで使用できる状態にすること。**

そのために必要のない独自機能は作らない。

既存のProduction処理を最大限再利用し、不足する入口だけを薄く追加する。
