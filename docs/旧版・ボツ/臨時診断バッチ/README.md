# 臨時診断バッチ — 不採用仕様・リバート精査用記録

> **結論**
>
> - このフォルダに退避した `ad_hoc_diagnosis_batch_spec.md` は **不採用（ボツ）**。現行仕様・本番仕様の根拠として使用しない。
> - この仕様を前提に追加・変更した **Scan-Chat-AI / wellfort-site のコード、API、DB migration、CI、管理UIはリバート／撤去候補**。
> - ただし、ここ最近リバートの巻き添え事故が多発しているため、**コミットや PR を機械的に丸ごと revert しないこと**。新担当者が changed files、本番コード、Production DB、後続変更を照合して撤去単位を決める。
> - B3 / B3.1 / B3.2 の試行は作業ブランチから既に外してあり、現在の `claude/clever-cray-ngg0h6` は B2.2 後の記録コミットを先頭としている。**存在しない変更をさらに revert しないこと。**

---

## 1. この機能で実現しようとしていたこと

### 目的

企業・団体などから臨時に受領した**複数人分の検査データ一式を 1 個の ZIP で投入**し、通常の検査受付フローとは別に、管理者操作でまとめて診断用データへ変換して Elith へ渡すための管理機能を作ろうとしていた。

想定していた入力は、人物ごとに混在する次のようなファイル群だった。

- 健診 PDF
- 健診 XLSX
- 問診 XLSX
- 問診 PDF
- Genoplan 遺伝子検査 PDF

### 想定フロー

```text
ZIP投入
  ↓
ZIP内ファイルを人物単位へ整理
  ↓
検査種別を自動分類
  ↓
健診 / 問診 / 遺伝子をそれぞれ構造化
  ↓
HealthCheckupData / LifestyleQuestionnaireData /
GeneticTestResultData / HealthAgeData を生成
  ↓
人物ごとの不足・警告・重複を判定
  ↓
管理者確認
  ↓
Elith 納品セットを生成・S3へ出力
```

システム上は、

- **wellfort-site**: 管理画面、管理者認証、ブラウザ操作、中継 API
- **Scan-Chat-AI**: ZIP 受付、分類、解析、状態管理、Elith JSON 生成、S3

という分担で実装を進めた。

この目的自体を否定するものではない。**ボツになったのは、この目的を実現するために今回作った設計・仕様・実装方式である。**

---

## 2. 今回の失敗の核心 — 重要仕様・実装を確認せず、仮説を「決定仕様」にして実装した

今回の最大の問題は、コードの細かなバグではない。

**本番で既に動いている検査処理について、重要な仕様・実装・実データを十分に確認しないまま、未確認部分を推測で設計し、その推測を「決定仕様」として DB・API・状態管理・UI・テストまで実装したこと**にある。

特に問題だったのは次の点。

### 2.1 実物データを確認せずに仕様を固定した

最初の仕様書自身が、サンプル ZIP は作業環境に無く、10名／38ファイル／健診39列／問診62列などは指示書からの引用で、実物照合していないと記録している。

それにもかかわらず、その後の実装では**実データで証明されていない前提を中心に全体モデルを組んだ**。

結果として、Production で実際の問診 XLSX を確認すると、8人分がほぼ `mapped_count=1`、`unmapped_count=51〜57` という状態だった。つまり、作成した問診マッピングは実際の外部問診表を正しく処理できていなかった。

### 2.2 本番の専門処理を「再利用したつもり」で、臨時バッチ独自の判定を上に作った

健診、問診、遺伝子、HealthAge、Elith 出力には既存の本番処理がある。

本来は最初に、

1. 本番で何を入力とするか
2. どの関数・API・DB状態が正なのか
3. 何をもって「処理完了」「納品可能」とするか
4. 欠損・部分成功・再試行を本番がどう扱うか

をコードと実データで確認し、**臨時バッチはその入口だけを追加する**べきだった。

しかし実際には、臨時バッチ側に `required_formats`、`producedFormats`、`validation_status`、`parse_status`、`ready`、`optional_present_but_not_ready` などの独自判定を積み上げた。

その結果、

- output 行が存在するだけで「揃った」と数える
- 未完了の遺伝子 PDF が `ok` / `done` に見える
- 任意検査が「無い」のか「あるが壊れている」のかを区別できない
- 問診 XLSX の unmapped 情報が DB 復元時に消える
- parser が動いたことと、Elith に納品可能なデータが生成できたことを混同する

など、**臨時バッチ独自の状態機械を後から何度も補修する構造**になった。

### 2.3 「処理できた」と「納品可能」を混同した

今回、最も危険だった考え方の一つ。

例えば問診 XLSX なら、

```text
ファイルを読めた             = YES
1項目を mapping できた       = YES
LifestyleQuestionnaireData として有効 = NO
```

であるべきなのに、途中の成功をもって output を `generated` / `ok` 側へ進める設計が入った。

**Parser success ≠ Valid artifact ≠ Deliverable artifact**

この3段階を最初から分離していなかったため、B1、B1.1、B1.2、B3 系で状態判定の修正を繰り返すことになった。

### 2.4 実測値や過去サンプルを仕様へ昇格させた

Genoplan PDF のページ数など、過去の一つの実測値・サンプル値を、正常性判定や完了条件の根拠にしかけた。

例:

```text
ある PDF が 208 ページだった
→ 事実: その PDF が 208 ページ

別の PDF が 210 ページだった
→ 事実: その PDF が 210 ページ

だから Genoplan は 208〜210 ページが正常
→ 根拠のない仕様化。禁止。
```

ページ数だけでなく、日付、問診列、人物同定、重複判定、required format、ready 条件についても同じ問題があった。

### 2.5 テストが「正しい本番挙動」ではなく「作った仕様」を検証していた

多数の verify script と退行テストを追加したが、多くは**今回作った設計・状態判定がその通り動くか**を検証していた。

そのためテストが大量に PASS しても、

- 実際の問診 XLSX を正しく処理できるか
- 本番 Genoplan 処理と同じ意味になるか
- 本番で納品可能と判断すべき状態か

を保証していなかった。

**誤った前提をコードとテストの両方に書けば、誤ったシステムが高いテスト通過率で完成する。** 今回はその典型になった。

---

## 3. ドタバタ修正の経緯 — Scan-Chat-AI

以下は、今回の設計を作り、後から問題を補修していった主要コミットの時系列。

**新担当者はこの一覧をリバート候補調査の索引として使用すること。**
**「一覧にあるから commit 全体を revert」ではなく、必ず changed files を確認すること。**

| Commit | 内容 | リバート精査時の意味 |
|---|---|---|
| `0b81f01` | 臨時診断バッチ仕様書 v0.1。ZIP→分類→構造化→Elith の全体仕様を「決定仕様」として作成 | **設計起点**。実物ZIP未確認のまま全体仕様を固定した地点 |
| `04bbd96` | v0.2。自作 ZIP/XLSX 方針撤回、メモリ制約、`subject_fp` を追加 | 初期設計の誤りを仕様修正で補正 |
| `bd0f26c` | v0.3。`subject_fp UNIQUE` の矛盾を撤回、Content-Length 前提を未確認へ戻す | 仕様内部の矛盾・未検証断定の修正 |
| `42eb7bf` | 臨時診断用 DB 6表の migration 追加 | **DB撤去候補**。Production 適用済みか必ず確認 |
| `9d395d1` | migration / v0.4。ZIP実サイズ、actor UUID、subject_fp の扱い修正 | DB設計補修。適用状態の確認必須 |
| `af31234` | ZIP/XLSXライブラリ選定 (`@zip.js/zip.js`, `read-excel-file`) | 依存・package変更を含む撤去候補 |
| `cf3eb49` | v0.5。SHA-256、S3 Range Reader、XLSX 日付処理を仕様化 | 臨時バッチ専用設計の追加 |
| `08bad9e` | Phase D。ZIP基盤、分類、fingerprint、健診XLSX parser 実装 | `src/lib/ad-hoc-diagnosis/**` の本格実装開始 |
| `bc402d0` | ad-hoc 検証を CI に追加、CLAUDE.md 更新 | **CI / CLAUDE.md の撤去候補**。他変更を巻き込まない |
| `f0a8319` | v1.0 バックエンド完成。ticket / questionnaire / pipeline / store / service / API / E2E を追加 | **最大の実装塊**。問診マッピング、ready、output 状態等の中心 |
| `7413098` | PR #213 merge | **merge commit をそのまま revert しない**。中の変更を個別精査 |
| `f716d91` | Phase A。Elith 実S3 write guard を追加 | ad-hoc 専用安全装置。機能撤去なら候補だが共通S3は触らない |
| `d5d1cce` | write guard を CI required へ追加 | CI 撤去候補 |
| `d9d3d5b` | PR #220 merge | merge 単位で戻さず差分確認 |
| `10ec6a4` | Executive B1。`executive_subject_id`、日付補完禁止、subject-link 等 | **Executive連携・追加migrationの撤去候補** |
| `3e6db64` | B1.1。任意formatの「不存在」と「不完全」を分離。遺伝子部分納品禁止 | 既存 readiness 設計の欠陥を後付け修正した地点 |
| `66354b4` | B1.2。遺伝子完了条件統一、failed outputをreadyに数えない、retry修正 | 状態機械の追加補修。今回の設計不安定さを示す重要コミット |
| `692a4a7` | `parse_status` DB constraint を修正 | コードとDB制約が食い違っていた補修。migration適用状態要確認 |
| `fcae4dc` | PR #221 merge | merge 単位で戻さず差分確認 |
| `d1155b8` | ad-hoc ZIP classification timeout 延長 | 性能問題への対症修正。設定ファイルの巻き添え注意 |
| `b107ebe` | timeout をさらに延長 | 同上。後の B2.1 で方針変更 |
| `4537e4f` | B2.1。ZIP全体処理を `plan / entry / finalize` に分割、normalized payload 保存 | **処理方式を大幅変更**。DB/API/状態の撤去候補 |
| `6cde82f` | PR #222 merge | merge 単位で戻さず差分確認 |
| `d619c6b` | B2.2。S3RangeReader client再利用、16MiB chunk へ変更 | ad-hoc ZIP読取性能対策。共通S3実装との境界を必ず確認 |
| `7d3cacd` | PR #223 merge | B2.2 の merge。現在のリバート精査基準点の一つ |

### B3 / B3.1 / B3.2 について

その後さらに、PDF/VLM routing、遺伝子ページ完全性、問診 unmapped、ready 判定などを B3 / B3.1 / B3.2 として修正したが、設計そのものを見直す判断になったため、**作業ブランチ `claude/clever-cray-ngg0h6` は B2.2 の `7d3cacd` まで force-reset 済み**。

したがって、B3 系のコミットは**現在のこのブランチの ancestry には無い**。

GitHub 上に commit object が残っている場合があっても、**それを理由に追加 revert してはいけない。**

---

## 4. ドタバタ修正の経緯 — wellfort-site

臨時診断はクロスシステム実装なので、Scan-Chat-AI だけを戻して終わりではない。

wellfort-site 側にも管理 UI、中継 API、Executive 人物マスタ等が入っている。

| Commit | 内容 | リバート精査時の意味 |
|---|---|---|
| `55d2653` | 臨時診断管理UIを main 上へ移植。ページ、中継、ZIP digest、メニュー、依存を追加 | **UI側の主要撤去候補** |
| `e1000e5` | 臨時診断中継先を `AD_HOC_SCAN_CHAT_AI_BASE_URL` 専用にし fail-closed 化 | ad-hoc 専用 env / verify の撤去候補 |
| `9f9b096` | PR #407 merge | merge commit 丸ごと revert 禁止 |
| `1276c5e` | Executive B1。`executive_subjects` migration、人物登録／紐付け UI、subject-link | **Wellfort DB migration + UI の重要撤去候補** |
| `3fcc40c` | B2.1 UI。`classify-plan / entry / finalize` を順次実行・再開可能化 | Scan B2.1 と対になったUI変更 |
| `aea7888` | PR #409 merge | merge 単位で戻さず精査 |
| `fb2ec13` | ad-hoc 管理画面の UTF-8 charset 修正 | ad-hoc ページ撤去時の付随候補 |

wellfort-site の作業ブランチ `fix/ad-hoc-vlm-ui` については、B3 UI 試行を取り除くため **`893d38f` まで reset 済み**。B3 以降の試行を二重に revert しないこと。

---

## 5. リバート候補を調べるときの見方

上記コミット一覧は**リバート候補の索引**であり、実行命令ではない。

新担当者は各 commit / PR について、最低でも次を確認する。

### A. その変更は臨時診断専用か

専用なら撤去候補。

例:

- `src/lib/ad-hoc-diagnosis/**`
- `src/pages/api/admin/ad-hoc-diagnosis/**`
- `scripts/verify-ad-hoc-*.mjs`
- wellfort-site `/admin/ad-hoc-diagnosis`
- wellfort-site ad-hoc 中継 API

### B. 臨時診断を契機に変更したが、別の本番機能も使っていないか

共通なら**丸ごと戻してはいけない**。

特に確認:

- 共通 S3 helper
- Elith assembly / wrapping
- Genoplan の通常処理
- 健診 scan / VLM 処理
- HealthAge
- auth / admin 共通処理
- `.github/workflows/ci.yml`
- `package.json` / lockfile
- `CLAUDE.md`

### C. migration は Git revert と DB rollback を分けて考える

特に:

- `20260910000020_ad_hoc_diagnosis.sql`
- Executive link 系 migration
- wellfort-site `executive_subjects` migration

については、**Production に適用済みかを実 DB で確認すること。**

適用済み migration は、Git からファイルを消しても DB は戻らない。

必要なら、現状スキーマ・データ・参照を確認した上で**前進 migration で安全に撤去**する。

---

## 6. リバート時の最重要注意 — 巻き添え事故を起こさない

ここ最近、リバート／巻き戻し作業で、**目的の変更だけでなく関係のない正常な変更まで巻き添えにする事故が複数回発生**している。

本件は変更範囲が、2リポジトリ、DB migration、CI、依存、S3、Elith、安全装置まで広がっているため、特に危険。

### 禁止

- PR / merge commit を中身を見ずに `git revert -m ...` する
- commit message に `ad-hoc` とあるという理由だけで commit 全体を戻す
- PR #213 / #220 / #221 / #222 / #223 を順番に丸ごと revert する
- `src/lib/ad-hoc-diagnosis/` だけ消して終了とする
- migration ファイルを削除して DB も戻ったと考える
- 本番の既存専門処理を「ad-hoc が使っていた」という理由で戻す
- Scan-Chat-AI だけ戻して wellfort-site の UI / API / DB を残す
- wellfort-site だけ戻して Scan 側 API / DB を残す
- B3 系のように既に branch から消えている変更を再度 revert する
- shared / merged branch を安易に force-reset する

### 必須手順

1. **臨時診断着手前の基準 commit を確定する。**
2. `git diff <base>..<current>` と各 PR changed files を取得する。
3. ファイルを次の4分類に分ける。
   - 臨時診断専用
   - 共通だが臨時診断のために変更
   - 臨時診断を契機に見つけた、本番にも必要な修正
   - 無関係な同時変更
4. 共通ファイルは `git blame` / 後続 commit / 呼出元を確認する。
5. Production DB の migration 適用状態と実データを確認する。
6. S3 に臨時診断の一時ZIP・中間成果物・納品物があるか確認する。
7. Scan と wellfort-site の対応変更をペアで確認する。
8. **小さい撤去単位で commit し、毎回 build / test / 既存本番フローの回帰確認を行う。**
9. 最後に、臨時診断固有の route / menu / env / script / migration / docs / CI entry が残っていないか全文検索する。

---

## 7. 新担当者が再設計する場合の出発点

今回の仕様書から再開しない。

必ず次の順序でゼロから確認する。

1. **本番で実際に動いているコード**
2. **本番の正本仕様書**
3. **実際の入力ファイル**
   - 健診 PDF 1件
   - 健診 XLSX 1件
   - 問診 XLSX 1件
   - 問診 PDF 1件
   - Genoplan PDF 1件
4. 各入力について、現在の本番処理が何を出すかを確認する。
5. 入力 → 正解出力を人間が確認した **Golden Sample** を作る。
6. Golden Sample が無い形式は実装しない。
7. 臨時処理は、本番専門処理を置き換えず、**入力受付・人物整理・人間確認の薄い層**として設計する。

再設計時には少なくとも、

```text
ファイルを読めた
↓
構造化できた
↓
Validation を通った
↓
管理者が承認した
↓
納品可能
```

を別状態として扱う。

**「処理成功」と「納品可能」を二度と同じ状態で表さない。**

---

## 8. このフォルダの扱い

`ad_hoc_diagnosis_batch_spec.md` は削除せず残す。

ただし用途は、

- なぜ今回の実装になったかを追う
- リバート対象を調べる
- 同じ設計ミスを繰り返さないための事故記録

だけ。

### やってはいけない

- この仕様書を現行仕様として引用する
- この仕様書を部分修正して復活させる
- この仕様書に本番を合わせる
- この仕様書の test / ready / required / page count / mapping を正として新実装する

新しい臨時診断仕様を作る場合は、**別ファイルとして、本番実装・実データを起点にゼロから作ること。**
