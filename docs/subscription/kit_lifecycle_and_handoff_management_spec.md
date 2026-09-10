# 検査キット 出荷・進捗・データ受渡 統合管理仕様（サブスク駆動）

| 項目 | 内容 |
|---|---|
| 目的 | サブスク検査プランを起点に、**①タカセへの出荷指示 ②Webアプリでのキット・ライフサイクル管理（発送/受取/返送/問診促し）③進捗駆動の各社データ受渡・検査結果受領・Elith作成指示** を一元管理する仕様。 |
| 元資料 | Wellfort 提供 Excel『商材送付タイミング一覧』（プラン×検査キット×発送タイミング）。 |
| 版 | 2026-08-04（Draft） |
| 上位文書 | **本書は「キット出荷・進捗・受渡・データモデル」の詳細（②③④）。EC購入→表示までの E2E 全体像は `docs/lab/lab_data_pipeline_master_spec.md`（総合仕様書）が正本。** |
| 関連 | `docs/subscription/subscription_management_feature_requirements.md`／`docs/lab/kit_progress_management.md`（発送〜完了ライフサイクル・パイロット実装済）／`docs/lab/lab_data_reception_overview.md`（各社受取）／`docs/lab/questionnaire_to_lab_csv_spec.md`（問診→各社CSV）／`docs/elith/elith_batch_centralization_design.md`・`docs/elith/elith_assembly_wrapping_spec.md`（Elith）／wellfort-site `admin/shipping.astro`・`api/cron-shipping.ts`（現行出荷）・`docs/billing/gmo_subscription_billing_spec.md` |

---

## 1. プラン × 検査キット × 発送タイミング（元資料）

> **【プラン名称は変わる・2026-09-10 発注者指示】**
> **プラン名称は追加・改称・廃止が続く**前提で読むこと。下表の「経営層・幹部 / ミドルマネジメント」は
> **元資料 Excel 当時の名称で、現行の商品名ではない**。現行は
> **ウェルテクト スタンダード / ウェルテクト ライト**（`wellfort-site src/pages/welltect.astro:569-590` の
> 4 プラン定義が現物。`src/pages/admin/elith-batch.astro:241-242` の
> `value="executive">ウェルテクト スタンダード` / `value="middle">ウェルテクト ライト` も同じ対応）。
> **旧名 → 現行名の対応は価格が 1 対 1 で一致することで確定**している
> （187,000/157,300・143,000/113,300・90,200/60,500・79,200/49,500）。
>
> → **仕様・実装・SQL のいずれもプラン名をキーにしない。** プランの同定は
> **`test_products.id`（＋構成は `plan_compositions.version`）だけ**で行う（§6.1 のモデルが
> 名称に依存しない理由そのもの）。**名称が変わってもデータは壊れない**のが正しい状態で、
> 名称で照合している箇所を見つけたら、それは直す対象。
> 表中の名称は「当時どのプランを指していたか」を人が追うための注記として残す。

| プラン（元資料の名称・**現行名は上記注記**） | 初年度¥ | 2年目¥ | 発送頻度 | 遺伝子 | がんリスク | 血液 | (AI疾病予測) | (AI疾病予防) |
|---|---|---|---|---|---|---|---|---|
| 経営層・幹部（50代以上）＝現 スタンダード（50代以上） | 187,000 | 157,300 | 年3回(4カ月毎) | 1(初回) | 3 | 3 | 1 | 4 |
| 経営層・幹部（30・40代）＝現 スタンダード（30・40代） | 143,000 | 113,300 | 年2回(6カ月毎) | 1(初回) | 2 | 2 ※ | 1 | 2 |
| ミドルマネジメント（50代以上）＝現 ライト（50代以上） | 90,200 | 60,500 | 年3回(4カ月毎) | 1(初回) | 3 | — | — | 1 |
| ミドルマネジメント（30・40代）＝現 ライト（30・40代） | 79,200 | 49,500 | 年2回(6カ月毎) | — | 2 | — | — | 1 |

> ※ **要確認（1 セルのみ・2026-09-10）**: スタンダード（30・40代）の**血液の年間回数**が、
> 本表（元資料 Excel）= **2** に対し、LP `wellfort-site src/pages/welltect.astro:577` = **`blood: 1`** で
> 食い違う。**初期データ投入 `scripts/seed-kit-composition.sql` は本表の 2 を採っている**
> （元資料が一次資料であること、および `per_year=2` のプランで `ship_rule='every'` なら
> 年 2 回にしかならず、年 1 回だけ送る規則は現行の `ship_rule` 3 値では表せないため）。
> **LP が正なら血液は `first_only` 相当**になる。Wellfort へ確認して、食い違えば seed を流し直す。

- **物理キット発送（タカセ対象）＝ 遺伝子・がんリスク・血液** のみ（元資料の発送マーク○が付く行）。
  - **遺伝子**: 初年度1回目のみ発送（生涯1回）。
  - **がんリスク**: 発送頻度どおり毎回（年3 or 年2、初年度・次年度とも）。
  - **血液**: 上位2プラン（現 スタンダード）のみ毎回。下位2プラン（現 ライト）は無し。
- **(AI疾病予測)＝LAiF**・**(AI疾病予防)＝アプリ機能** は元資料で発送マークが全て「-」＝**物理キット発送ではない**（データ/アプリ由来）。**タカセ出荷指示の対象外**。
  - AI疾病予測は「年1回」相当（データ受領）。AI疾病予防は開発中（回数は将来仕様）。

### 1.1 商品DB連携（確定）
- **4プランは商品DB `test_products`（wellfort-site Supabase）の行**（列: `name`/`price`/`first_time_price`/`renewal_price`/`category`/`features(jsonb)`/`is_active`/`is_renewal_available`/`shop_wellfort_id`/`jan_code` 等）。`products/[id].astro` は最上位プラン(¥187,000/¥157,300 ＝現 スタンダード(50代以上))を既定に読む。契約は `subscriptions` テーブル。
- **ギャップ**: `test_products` には**キット構成・年間回数・発送間隔・キット別発送ルール（遺伝子=初回のみ 等）を持つ列が無い**。→ **プラン→キット構成・発送タイミングの定義を `features(jsonb)` かプラン別マッピング表として持たせる**（本§1の表をデータ化）。出荷スケジュール(§2)・合成データ生成はこの定義を参照する。
- **合成データ生成 `elith-plan.ts` は現状 executive/middle の2プラン**。**実プラン4バリアントに合わせて拡張**する（`test_products`/上記マッピングを正とする）。※実DBの行データはキーがVercel側のため本環境から直接照会不可＝スキーマと既定値で確認。

---

## 2. 要件① タカセ出荷指示（サブスク駆動へ改修）

### 2.1 現状
- ECで検査プラン商品の**決済完了時**に、該当検査商品の**発送指示票（CSV）を出力→メール送信**。
- 併せて `api/cron-shipping.ts` が営業日 9:00 JST に自動送信（`warehouse_calendar` で休業日スキップ）。

### 2.2 課題
- 出荷単位が「購入商品」であり、**プラン→含まれる検査キットへの展開**になっていない。
- サブスクの**年間回数・発送タイミング（4/6カ月毎）**に沿った**2回目以降の定期出荷**が未対応。

### 2.3 あるべき仕様（プラン駆動の定期出荷）
1. **契約時**に、プラン（§1）から**キット別の出荷スケジュール**を確定・登録:
   - 起点 `D0`（確定）＝**契約日（＝決済日）**。**契約日が土日祝なら翌営業日**へ繰り下げ（`warehouse_calendar.is_business_day` で判定）。
   - 各回の予定日 = `D0 + 発送間隔(4 or 6カ月) × (回index)`（末日は月末クランプ、当日が非営業日なら翌営業日）。
   - キット別ルール: 遺伝子＝初回のみ／がん＝毎回／血液＝毎回(上位2プラン＝現 スタンダードのみ)。
2. **出荷指示の生成**は各予定日に、その回で発送するキットだけを **1件=1出荷指示（CSV行）** として生成 → タカセへCSV送信（既存 `cron-shipping` を**スケジュール参照型**へ拡張）。
3. CSV項目・宛先様式はタカセ様式に準拠（現行CSVを踏襲）。**サブスク解約/停止**時は以降の予定出荷を停止（`gmo_subscription_billing_spec` の契約状態と連動）。
4. **冪等性**: 同一(契約×回×キット)の二重出荷を防ぐ（出荷済フラグ＝顧客ステータス `instruction_sent` 等）。

---

## 3. 要件② Webアプリ 検査キット・ライフサイクル管理

`docs/lab/kit_progress_management.md`（パイロット版実装済）を土台に、サブスク契約テーブルと連携して1キットの全ライフサイクルを管理する。

### 3.1 状態機械（1キット×1回）
```
(出荷予定) → 出荷指示済 → 発送済 → [ユーザー]受取確認 → 検体採取/問診 → 検体返送 →
  検査会社受領 → 検査結果受領 → Elithデータ作成 → (完了)
```
- 各状態に日時・担当（システム/ユーザー/検査会社）を記録。ユーザー操作は「受取確認」「返送済」。
- **AI問診の促し（確定・催促エスカレーション）**: 検体提出時に問診データが必要な検査（血液 等・`questionnaire_to_lab_csv_spec` 参照）について、**ユーザーの検体返送に関する Webアプリ通知の時点で AI問診が未完了なら催促**する。
  - **ハードブロックにはしない**（返送自体は止めない）。未完了が続く限り **Webアプリ通知機能で毎日催促**。
  - **7日経過しても未完了なら Wellfort 管理者へワーニング通知**（管理ダッシュボードのアラート）。
  - 問診完了で催促停止。問診CSVの各社受渡(§4.1)は問診完了が前提。

### 3.2 サブスク契約テーブルとの連携
- 契約（プラン・D0・回数・状態）→ §2 の出荷スケジュール → 各回のキット・ライフサイクル行を生成。
- 管理者ダッシュボード「サブスク契約管理」（`subscription_management_feature_requirements`）から、契約単位で全キットの進捗を一覧・操作。

---

## 4. 要件③ 進捗駆動のデータ受渡・受領・Elith作成指示

§3 の進捗をトリガに、下流の受渡を管理する。

### 4.1 問診データ → 検査会社へ受渡
- 対象回の検査に応じ、**AI問診回答→各社CSV**（`docs/lab/questionnaire_to_lab_csv_spec.md`）を生成し受渡（受渡経路は `docs/lab/lab_data_reception_overview.md`）。
- トリガ: §3.1「検体返送」前（問診完了済み）／がんリスク等は検体と同送の運用に合わせる。

#### 4.1.1 LAiF 上りCSV（AI疾病発症予測 入力フォーム）生成 — 写像仕様とフロー【2026-08 追加】

> **位置づけ（責務分離・重要）**: LAiF の上り入力フォーム（`input_format_new_202312.xlsx`＝No.0〜157・約158項目）は、
> **健診/人間ドックのAIスキャン結果（HealthCheckupData）＋ AI問診 ＋ 基本情報 を "1人分" に集約して写像**するもの。
> **検査票スキャン（読取）フローには足さない**。スキャンは HealthCheckupData（材料）を作る役、LAiF上りCSVは
> その材料＋問診＋基本情報を集約する**別の"上りexport"ステップ**（Elith納品アセンブリと同じ「集約・書き出し」層）。

**(A) データ源マッピング（3系統）**

| フォーム区分 | No | 主な取得元 | 備考 |
|---|---|---|---|
| 基本情報 | 0–8 | 識別番号=**整理番号（Wellfort採番の仮名ID・確定）**／性別・生年月日=**customer**／受診日・身長・体重・BMI・腹囲=**健診スキャン** | **生年月日は渡す（確定・発注者決定）**→CSVは個人データ扱い |
| 既往歴・服薬・手術・輸血 | 9–24 | **AI問診**（既往/服薬設問）＋（あれば）健診票の既往欄 | 有/無・部位コメント等 |
| 問診情報（喫煙/飲酒/体重変化/運動/食事/睡眠/改善意思） | 25–61 | **AI問診**（`LifestyleQuestionnaireData`） | Y/N・選択肢を LAiF 記法へ |
| 健診情報（血圧・脈・眼圧・視力・聴力・K-W・眼底・エコー所見・CAVI/ABI・尿定性・血算・生化学・腫瘍マーカー 等） | 62–157 | **健診・人間ドックスキャン（HealthCheckupData measurements）が主**（血液=デメカルも源） | 大半が既存スキャン抽出項目に一致 |

**(B) 写像の原則（決定論・捏造ゼロ）**
- **既存の正準化語彙で対応付け**（`canonicalize.ts`/標準マスタと同じ名寄せ・単位・定性正規化）。項目名は LAiF フォームの固定キーに合わせる。
- **定性**（尿蛋白/尿糖/尿潜血/ケトン/便潜血/HBs/HCV/RPR 等）は LAiF 記法 `(ー)/(±)/(1＋)…`・`(ー)/(＋)` へ正規化。K-W/Scheie は群/度の記法へ。
- **値の無い項目は空**（前回値の繰り上げ・推定で埋めない＝捏造ゼロ）。左右別（眼圧/視力/聴力/CAVI/ABI/K-W）はフォームの右左キーへ。
- 写像表の**正本＝`docs/lab/questionnaire_to_lab_csv_spec.md`**（LAiF 列を全158項目ぶん確定していく）＋ 本フォーム原本。

**(C) 生成・受渡フロー（進捗駆動）**
1. §4.3 の「その回の**健診結果＋AI問診が揃った**」判定と同期して **LAiF上り xlsx を生成**（集約＝Scan-Chat-AI API／指示UI＝wellfort-site admin）。
2. S3 の上り領域 `to-laif/` へ xlsx 書き出し（**整理番号でひも付け**・氏名等は載せない）。
3. `laif_s3_secure_handoff_spec §4.5` の**自動メール通知**（登録3宛先）→ LAiF がポータルから取得（`§0.3` デモ画面あり）。

**【確定 2026-08-27・発注者指示】受渡形式は xlsx。CSV は撤回**：
LAiF の正式フォーム `input_format_new_202312.xlsx`（シート `KM`・No.0〜157）**そのものを渡す**。
初期計画にあった「独自CSV」は**当初の仮予定であり不採用**（本文書中の旧「上りCSV」表記は xlsx と読み替える）。
**1 ファイル = 1 名分**（入力フィールドは G 列 1 本・名前欄も 1 つ＝人数分のファイルを並べる）。

**【確定 2026-08-27・発注者指示】ファイル名 = `input_wellfort_laif_{整理番号}.xlsx`**：
例 `input_wellfort_laif_W026000123.xlsx`。`{整理番号}` は**名前欄 G1 に入れる識別番号と同一表記**
（画面表示・ファイル名・ファイル中身の 3 者を必ず一致させる。旧デモは画面が `WF-2026-000123`、
中身が `W026000123` で食い違っていた＝2026-08-27 に `W026…` へ統一）。
ファイル名に氏名・生年月日は載せない（`data_integration_requirements` 準拠。生年月日は
フォーム**中身**にのみ入る＝上記(D)の LAiF 向け明示例外）。**LAiF 側の受入名指定の有無は要確認**。

**(D) 確定事項・残（`laif_s3_secure_handoff_spec §0.2` と同一）**
- **整理番号（識別番号 No.0）＝Wellfort採番の仮名ID（確定 2026-08）**。LAiF自社連番は使わない（突合はWellfort整理番号）。
- **生年月日（No.3）＝渡す（確定 2026-08・発注者決定）**。→ 上りCSVは**生年月日を含む個人データ**（PIIフリーでない）＝`data_integration_requirements` の外部非送付ルールへのLAiF向け明示的例外。ポータルで保護。**残=同意範囲の確認（運用）**。
- **問診由来項目の充足（残）**：既往歴/服薬(9–24)・生活習慣(25–61) は AI問診の設問網羅性に依存（不足設問は問診票側で補完）。
- **名前欄（G1／識別欄）＝識別番号（仮名ID）を必ずセット・空欄不可【確定 2026-08・LAiF回答】**：
  LAiF より「**名前の欄は空白ですと解析できません。識別番号など、特定できる記号を入れてください**」との回答。
  → 上り入力フォームの **名前欄セル `G1`＝整理番号（Wellfort採番の仮名ID）を必ず記入**する。
  **実氏名は載せない**（PII非送付・(D)の生年月日例外とは別。名前欄はあくまで仮名ID）。空欄で渡すと JOBRUNNER が解析不能になる。
- **【重要・訂正 2026-08-27・LAiF指摘】黒枠セル＝LAiF側の自動計算項目。書き込んではいけない**：
  LAiF より「**最初の識別番号は入力しないでください。その後の黒い色の枠は自動計算項目です。入力しないでください**」との指摘。
  → **No.0 識別番号（行4）・No. 年齢（行8）・BMI（行11）へは書かない**。識別番号は **`G1` だけ**に入れる
  （「G1＝No.0 と同値をセット」という旧記述は誤り。**撤回**）。年齢は生年月日から、BMI は身長・体重から LAiF 側で計算される。
  黒枠は該当セルの塗り＝**テーマ色 1（黒）**で機械判別できる（通常の入力欄はテーマ色 7）。対象は実測 11 セル＝
  行4 識別番号 / 行8 年齢 / 行11 BMI / 行44 服薬情報（処方薬品）/ 行112–118 心電図・各エコー所見。
  実装＝`scripts/laif_form_rules.py` の `readonly_rows()`。ビルダーは**書き込みを拒否**し、検証で**違反として報告**する。

**(E) 生成ロジック（実装・決定論ビルダー）**
- **正本スクリプト＝`scripts/build-laif-input.py`**（openpyxl・決定論・追加サーバ不要のops/buildツール）。
  - 入力: `{client_id, profile{exam_date,sex,birth_date,age,height,weight,bmi,waist}, measurements[], questionnaire{}}`。
    `measurements` は HealthCheckupData の measurements、`questionnaire` は LAiF項目名キーの Y/N・記法値。
  - 出力: LAiF 正式フォーム `input_format_new_202312.xlsx`（シート `KM`）の**入力フィールド列 `G`** を穴埋めした xlsx。
  - **名前欄 `G1`＝`client_id` を必ずセット**（上記(D)の LAiF 要件を機械的に保証）。**No.0 識別番号（行4）には書かない**（黒枠＝自動計算）。
  - **黒枠（テーマ色1）セルへは書かない**。`readonly_rows()` で判定し、書き込み要求は skip して監査に出す（`--repair` では既存値を消す）。
  - **写像＝項目名の正規化一致（括弧内英略称・全半角空白を除去して照合）＋別名辞書**（AST→GOT/ALT→GPT/BUN→尿酸窒素(原文ママ)/
    ALP→アルカリフォスターゼ/収縮期血圧→最高血圧 初回値/拡張期血圧→最低血圧 初回値 等）。No列は数式のため**項目名(C/D列)で行検出**。
  - **捏造ゼロ**：与えられた実値のみ記入。写像先が無い/値が空の項目は**空のまま**（推定で埋めない）。未一致は stderr に `未一致` として報告（黙って捨てない）。
  - 自己検証（2026-08・LAiF正式フォームで実行）: 名前欄G1＝識別番号 / No.0＝識別番号 / 基本情報8件 / 血算・脂質・肝腎・血糖・血圧 等が正規化一致で `G` 列に充填、
    未対応項目は空＋報告、を確認済。**問診(25–61)の写像は LAiF固定キーへの分解対応が必要**（正本＝`questionnaire_to_lab_csv_spec.md`。現状は LAiF項目名キーで渡せば一致・未確定分は空＝捏造ゼロ）。
- **本番ランタイム移植（follow-up）**：現状は ops/build 用の Python スクリプト。§4.1.1 のフロー(C)を **Scan-Chat-AI API（Node/TS・`exceljs`）** で自動化する際は
  同じ写像・同じ名前欄=識別番号ルールをそのまま移植する（写像辞書は本スクリプトを参照実装とする）。

### 4.2 検査結果 受領タイミング管理
- 各社の受領方式（血液=リージャー/RPA・がん=プリベント/調整中・AI予測=LAiF/S3・遺伝子=Genoplan/RPA）ごとに**受領予定と実績を管理**（`lab_data_reception_overview`）。
- 未受領のアラート／再督促。受領=そのキット行を「検査結果受領」へ前進。

### 4.3 Elith データ作成指示 管理
- 全必要データ（当該回の検査結果＋問診＋ウェルネス年齢等）が揃った時点で、**Elith 形式 JSON 生成＋S3受渡を指示**（`docs/elith/elith_batch_centralization_design.md`／`elith_assembly_wrapping_spec.md`）。
- ウェルネス年齢・AI疾病予測も §該当仕様どおり同梱（検査日毎の時系列）。作成/受渡の状態を記録。

---

## 5. 全体フロー

```
サブスク契約(プラン/D0)  ─▶ ②出荷スケジュール ─▶ タカセ出荷指示(CSV) ─▶ 発送
        │                                                          │
        └────────── ③Webアプリ ライフサイクル管理 ◀──────────────┘
                     受取確認 → (AI問診促し) → 検体返送
                          │
                          ├─▶ ④-1 問診→各社CSV 受渡
                          ├─▶ ④-2 検査結果 受領(各社方式)
                          └─▶ ④-3 Elith JSON 作成・S3受渡 指示
```

## 6. データモデル

### 6.1 キット構成の持ち方（**確定＝案A: 正規化＋版管理**・2026-08）
キット自体（検査会社都合で変更/追加/削除が頻繁）と、プラン×キット構成（サブスク契約保護で慎重に変更）は
ライフサイクルが別なので、**商品DB `test_products` と連携する別テーブルへ正規化し、構成は版管理**する。

| テーブル | 役割・主な列 |
|---|---|
| `test_kits`（キット/項目マスタ） | `id`/`kit_code`(UK)/`name`/`kind`('physical_kit'\|'data'\|'app')/`lab_company`(リージャー/プリベント/LAiF/Genoplan)/`format_id`(Elith)/`is_active`/`sort_order`。**キット変更・追加・削除はここで完結**。physical_kit=遺伝子・がん・血液(タカセ発送)／data=AI疾病予測(LAiF)／app=AI疾病予防 |
| `plan_compositions`（プラン構成ヘッダ＝**版**） | `id`/`product_id`(FK→`test_products`)/`version`/`per_year`/`interval_months`/`effective_from`/`is_current`/`note`。**プラン単位で構成をバージョン管理** |
| `plan_composition_items`（構成明細） | `id`/`composition_id`(FK)/`kit_id`(FK→`test_kits`)/`qty_per_year`/`ship_rule`('every'\|'first_only'\|'none')。遺伝子=first_only／がん・血液=every／AI予測・予防=none(発送しない) |
| `subscriptions`（列追加） | `plan_composition_id`(FK→`plan_compositions`)。**契約時の構成【版】をpin** → プラン改定後も既存契約は当時の構成のまま（サブスク保護） |

**変更シナリオ耐性**:
- キット変更/追加/削除 → `test_kits` 1箇所（既存構成は `kit_id` 参照で属性は自動追従、差替は明細更新）。
- プラン構成変更/新プラン → 新 `plan_compositions` 版を作成。**既存契約は旧版pinのまま不変**。
- プラン廃止 → `is_current=false`（＋商品 `is_active=false`）。走行中サブスク契約は旧版で継続。

> 他案比較: B=`test_products.features(jsonb)`埋込(手軽だがキット非正規化・版/契約保護が弱い・逆引き不可)、C=ハイブリッド(キットのみ正規化・構成jsonb)、D=コード定数(DB非連携・契約pin不可=合成/開発用のみ)。→ **整合性・双方向照会・契約版pin で案Aを確定採用**。

#### DDL スケッチ（実装用・wellfort-site Supabase＝`test_products`/`subscriptions` と同一DB）
```sql
create table test_kits (
  id uuid primary key default gen_random_uuid(),
  kit_code text unique not null,
  name text not null,
  kind text not null check (kind in ('physical_kit','data','app')),
  lab_company text,                 -- リージャー/プリベント/LAiF/Genoplan
  format_id text,                   -- Elith: BloodTestData/CancerRiskAssessmentData/GeneticTestResultData/Other 等
  is_active boolean default true,
  sort_order int default 0,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table plan_compositions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references test_products(id),
  version int not null,
  per_year int not null,            -- 発送/受診 回数/年
  interval_months int not null,     -- 4 or 6
  effective_from date,
  is_current boolean default true,
  note text,
  created_at timestamptz default now(),
  unique (product_id, version)
);
create table plan_composition_items (
  id uuid primary key default gen_random_uuid(),
  composition_id uuid not null references plan_compositions(id) on delete cascade,
  kit_id uuid not null references test_kits(id),
  qty_per_year int not null,
  ship_rule text not null check (ship_rule in ('every','first_only','none')),
  unique (composition_id, kit_id)
);
alter table subscriptions add column plan_composition_id uuid references plan_compositions(id);  -- 契約時の版をpin
```
- インデックス: `plan_compositions(product_id, is_current)`、`plan_composition_items(kit_id)`（キット→プラン逆引き）。

#### 初期データ（Excel 4プラン → 構成明細）
`test_kits`: 遺伝子(physical_kit/Genoplan/GeneticTestResultData)・がんリスク(physical_kit/プリベント/CancerRiskAssessmentData)・血液(physical_kit/リージャー/BloodTestData)・AI疾病予測(data/LAiF/Other)・AI疾病予防(app)。

| プラン(product) | per_year/間隔 | 遺伝子 | がん | 血液 | AI予測 | AI予防 |
|---|---|---|---|---|---|---|
| ¥187,000/157,300 (現 スタンダード 50代以上) | 3 / 4カ月 | first_only(1) | every(3) | every(3) | none(1) | none(4) |
| ¥143,000/113,300 (現 スタンダード 30・40代) | 2 / 6カ月 | first_only(1) | every(2) | every(2) | none(1) | none(2) |
| ¥90,200/60,500 (現 ライト 50代以上) | 3 / 4カ月 | first_only(1) | every(3) | — | — | none(1) |
| ¥79,200/49,500 (現 ライト 30・40代) | 2 / 6カ月 | — | every(2) | — | — | none(1) |

- `ship_rule`: `every`=各回発送(タカセ)、`first_only`=初回のみ発送、`none`=物理発送なし(データ/アプリ)。
- 各 `plan_compositions` は初版 `version=1, is_current=true`。以後の改定は新 `version` を追加し既存契約は旧版pinで保護。

### 6.2 運用系テーブル（本仕様の管理対象）
- `subscription_contract`／`subscriptions`（プラン・`plan_composition_id`・D0・状態）
- `kit_shipment_schedule`（契約×回×キット×予定日×出荷状態）← §2。契約→`plan_composition_id`→明細から展開。
- `kit_lifecycle`（出荷→受取→返送→受領→Elith の各状態・日時）← §3
- `lab_handoff`（回×検査会社×問診CSV送付・結果受領・Elith作成 の各状態）← §4
- 既存の顧客ステータス（`instruction_sent` 等）・`warehouse_calendar`（営業日）と整合。

### 6.3 合成データ生成との整合
`elith-plan.ts`（合成）は上記 `test_kits`／`plan_compositions`／`plan_composition_items` を正として**4プランへ拡張**（ハードコード2プランを置換）。

## 7. 実装状況
- **実装済**: EC決済→発送指示CSV・`cron-shipping`（日次）・検査キット発送情報（パイロット）・各社受取/問診CSV/Elith の各要素仕様。
- **未実装（本仕様の主眼）**: (a) プラン→キット展開の**定期出荷スケジュール**化、(b) ライフサイクル状態機械＋AI問診促しの結線、(c) 進捗駆動の各社受渡・受領・Elith作成指示の**オーケストレーション**。

## 8. 確定事項（2026-08 回答反映）
1. **プラン数（確定）**: 実プランは**4バリアント**。商品DB `test_products` と連携。→ **合成 `elith-plan.ts` を4へ拡張**し、キット構成/回数/間隔は `test_products.features` かプラン別マッピングをデータ源とする（§1.1）。
2. **出荷起点 D0（確定）**: **D0 ＝ 契約日（＝決済日）**。**土日祝は翌営業日**（`warehouse_calendar`）。
3. **AI問診 催促（確定）**: 検体返送通知時に未完なら催促。**毎日通知**、**7日超で Wellfort 管理者へワーニング**。ハードブロックしない（§3.1）。
4. **タカセCSV様式（確定）**: **現行様式を踏襲**（スケジュール駆動でも項目・宛先は同一）。

5. **キット構成データの持ち方（確定）**: **案A＝正規化＋版管理の別テーブル**（`test_kits`/`plan_compositions`/`plan_composition_items`＋`subscriptions.plan_composition_id`）。§6.1 に DDL・初期データ。

### 残・要確認
- **AI疾病予測/予防**: 物理キット外（タカセ対象外）。AI疾病予測=年1回のデータ受領、AI疾病予防=開発中の回数/仕様（管理対象に含める時期）。
