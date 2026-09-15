# トランスコスモス10名 ― 一括投入 仕様書 v4.0

作成: 2026-09-15 / 状態: **設計。発注者承認まで実装しない**
撤回: `design/transcos-zero-base` (Scan-Chat-AI `7d30669` / wellfort-site `146fa46`)

---

## 0. この案件は何か

**新しい診断システムを作る案件ではない。**
既に本番で何度も正常完了している診断処理へ、**10 人分をまとめた ZIP の各人の入力を
正しく渡す**案件である。

この前提と矛盾する設計になった時点で、実装せず理由を報告して STOP する。

### 0.1 V1 / V2 / V3 は全廃案

設計・実装・仕様書・テスト・validation・manifest・preflight・独自 mapping・
独自 state machine を**新設計の参考実装として使用しない**。
撤回の内訳は上記 2 コミットの本文にある。**旧仕様を正本にしない。**

---

## 1. 設計を支配する 2 つの事実

### 事実 1 — Production の診断処理は完成・実証済み

入力 → 既存解析 → 必要な LLM 処理 → Elith 仕様の JSON → S3 → Elith → Elith 側で正常処理完了、
までを何度も実データで完了している。

したがって **JSON 生成方法 / 検査項目の解釈 / LLM prompt / parser / canonicalization /
項目名変換 / Elith schema / S3 納品形式 / 検査別処理 を今回の案件用に再設計しない。**

### 事実 2 — 今回の入力も Production の入力要件を満たす

違いは **1 つの ZIP に 10 人分がまとまっている**ことだけ。
ZIP 内部の各人の実データ自体は、事実 1 の処理が受け付ける形をしている。

### 1.1 帰結

```
ZIP → 人物単位に分離 → 既存 Production 処理 → 既存 JSON → 確認 → 既存 S3 → Elith
```

**今回専用に新しい診断パイプラインを作らない。**

---

## 2. 実測した Production 処理マップ

すべて `design/transcos-zero-base` (撤回後) の実コードから。**関数名・ルートは推測していない。**

### 2.1 共通

| 役割 | ファイル | 関数 / 定数 |
|---|---|---|
| S3 設定 | `src/lib/s3.ts` | `getS3Config()` / `isS3Configured()` (`:63` / `:76`) |
| S3 書込 | `src/lib/s3.ts` | `putFiles()` (`:160`) |
| Bearer 認可 | `src/lib/api-auth.ts` | `isAdminAuthorized()` (`:61`) |

S3 キー (3 系統共通):
`{prefix}user/{client_id}/date/{YYYY_MM_DD}/{format_id}_date_{YYYY_MM_DD}_user_{client_id}.json`

**`AWS_REGION` 未設定 = 全系統ドライラン** (`s3.ts:63-65` が null を返し、各 API は
`configured:false` + `preview` を返して書かない)。**これが V4 の最重要の安全装置**。

### 2.2 入力別

| 入力 | 人数 | 既存入口 | 既存処理 | 入力の形 |
|---|---:|---|---|---|
| 健診 (複数枚) | 10 | `POST /api/admin/elith-hc-merge`<br>`action=part` → `finalize` | `src/lib/elith-export.ts` `scanImageToParsed()` (`:1308`) | part = 画像 data URL + `seq`<br>finalize = part 応答の `parts[]` |
| 健診 (1 枚) | — | `POST /api/admin/elith-scan` | `src/lib/elith-export.ts` `buildElithScanBundle()` (`:1392`) | data URL + `formatId` + `checkOnly` |
| 遺伝子 | 10 | `POST /api/admin/elith-genetic-merge`<br>`action=part` → `finalize` | `src/lib/elith-genetic.ts` `scanGeneticPage()` (`:158`) | **1 ページ = 1 画像 = 1 req** + `page` |
| 問診 | 10 | `POST /api/interview/export` | `src/lib/interview-export.ts` `buildElithInterviewBundle()` (`:274`) | **`answers: Record<string, string\|string[]\|number>`**<br>**LLM 不使用** |

### 2.3 既存の管理 UI と中継

UI は wellfort-site、処理は Scan-Chat-AI。中継はユーザートークン + `admin_users` 照会 →
上流へ `Bearer SCAN_CHAT_AI_API_KEY` の 2 層。

| 系統 | 管理 UI | 中継 (wellfort-site) |
|---|---|---|
| 健診・遺伝子 | `src/pages/admin/elith-batch.astro` | `src/pages/api/admin/elith-{scan,hc-merge,genetic-merge}.ts` |
| 問診 | **存在しない** | **存在しない** |

---

## 3. 設計の核心 — 既存 Production はすでにブラウザ駆動である

`elith-batch.astro` は **ファイルをブラウザで読み** (`:366-369` `FileReader.readAsDataURL`)、
**PDF をブラウザでページ画像へ展開し** (`:459` `ensurePdfjs` / `:493` `renderPdfPages`)、
**1 件ずつ既存 API を呼ぶ**。サーバはファイルを受け取らず data URL を受け取る。

→ **ZIP を解く場所もブラウザである。** これは好みではなく、既存入口の入力形が
data URL だからそうなる。この 1 点から以下が自動的に決まる:

- ZIP を S3 へアップロードしない → **presigned チケット不要・S3 の新しい置き場不要**
- サーバに ZIP を渡さない → **サーバ側 ZIP reader / Range GET / 分割読み 不要**
- 関数の実行時間を延ばす理由が無い → **`astro.config.mjs` の `maxDuration` を触らない**
  (V1/V2 は 60→800 秒へ上げていた。V4 では**戻したまま**)
- 新しい API を Scan-Chat-AI に作らない → **`src/pages/api/admin/` に新規ルート 0 本**

**V1/V2 が DB 6 テーブル・S3 アップロード口・専用 API 13 本・サーバ側 ZIP 基盤を
必要としたのは、ZIP をサーバへ持ち込む設計を先に選んだからである。**
その前提を外すと、それらは全部要らなくなる。

---

## 4. V4 の全体像

```
[管理者のブラウザ]
  ZIP を選ぶ
   ↓ JSZip 等で展開 (ブラウザ内・サーバへ送らない)
  人物フォルダごとに分離 → 10 人の一覧を表示
   ↓ 人物ごとに Executive (client_id) を確認・指定
  ┌──────────────────────────────────────┐
  │ 人物ループ × 検査ループ                          │
  │   健診 PDF  → renderPdfPages → elith-hc-merge part×N │
  │   遺伝子PDF → renderPdfPages(10,35) → genetic part×26│
  │   (問診は §5)                                    │
  └──────────────────────────────────────┘
   ↓ 各 part の応答をブラウザに保持
  Human Review 画面 (10 人 × 3 形式の一覧と中身)
   ↓ 承認した人物だけ
  finalize → 既存 S3 → Elith
```

**診断処理そのものは 1 行も書かない。** 書くのは順番に呼ぶことと、見せることだけ。

---

## 5. 問診 — 唯一「そのまま呼べない」入力

### 5.1 事実

```
既存入口:        POST /api/interview/export
呼べない理由:    入口が受けるのは answers オブジェクト
                 (src/pages/api/interview/export.ts:16,38,68)。
                 production はこれを問診アプリの InterviewEngine が作る前提で、
                 XLSX / PDF を読む処理を LLM 含め一切持たない
                 (interview-export.ts の gemini 参照 0 件)。
ZIP の中身:      Google Forms 由来 XLSX 8 名 / 紙の PDF 2 名
```

健診と遺伝子は入力が画像なのでそのまま渡せる。**問診だけが形が違う。**

### 5.2 選択肢 (発注者判断)

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| **P-1** | **本人に問診アプリを通してもらう** | 新規実装ゼロ。production の分岐・検証がそのまま効く | 10 名に操作を依頼する必要がある |
| **P-2** | 管理者が問診アプリの画面に代理入力する | 新規実装ゼロ。answers は engine が作るので正しさが担保される | 10 名 × 約 35 問の手入力 |
| **P-3** | XLSX の列 → `question_id` の**変換表**を書く | 8 名ぶんが自動。PDF 2 名は結局手入力 | **今回専用の変換規則が生まれる**。§12 の「独自 canonical table を作らない」に触れる |

**推奨 = P-1 または P-2。** 理由は、問診は LLM を使わない決定論処理で、
`QUESTIONS[].when` の分岐や選択肢の完全一致を **production の engine が保証している**ため。
外部フォームの値を写す変換を挟むと、その保証が変換表の正しさに置き換わる。

**P-3 を採る場合は、それが「今回限りの入力アダプタ」であって
診断パイプラインの一部ではないことを仕様で明示し、別ファイルに閉じる。**

### 5.3 問診の中継が無い

`/api/interview/export` は wellfort-site に中継が無く、**Bearer 認可も持たない**
(`export.ts` の import に `api-auth` が無い = エンドユーザー経路として設計されている)。
P-1 / P-2 なら本人・管理者がアプリ画面を通るので**中継を作る必要が無い**。
P-3 を採るときだけ中継 1 本が要る。

---

## 6. Human Review より前に S3 を汚さない

### 6.1 実測した唯一の汚染源

**`elith-hc-merge` の `action=part` は、1 枚ごとに元画像を即 S3 へ PUT する**
(`src/pages/api/admin/elith-hc-merge.ts:117-121`)。`part` に `checkOnly` 相当の抑止は無い。

他は汚染しない: `elith-scan` は `checkOnly:true` で書かない (`:126`) /
`elith-genetic-merge` の `part` は `putFiles` を呼ばない (ファイル冒頭にも明記) /
`interview/export` は書込 1 回だが承認ステップ自体が無い。

### 6.2 V4 の扱い

**`AWS_REGION` 未設定のドライランで解析フェーズを回す。**
これで 4 系統すべてが `putFiles` に到達せず `preview` を返す (§2.1)。
承認後に本番設定で finalize だけを実行する。

**`elith-hc-merge` の `part` を改造しない。** 通常運用の健診バッチが元画像を S3 に
残すのは監査のための既存仕様で、V4 の都合で変える理由が無い。

> **発注者確認 Q1**: 解析フェーズをドライランで回すと、健診の元画像が S3 に残らない。
> 通常運用では残している。**今回 10 名ぶんの元画像を監査用に残すかどうか**を決めたい。
> 残すなら「解析も本番設定で回し、S3 が汚れるのは元画像だけ (納品 JSON は finalize まで
> 書かれない)」という整理になる。

---

## 7. 進捗の持ち方

### 7.1 規模

10 名 × (健診 1〜数枚 + 遺伝子 26 ページ) ≒ **270 回以上の LLM 呼び出し**。
全部やり直すとコストと時間が無視できない。

### 7.2 方針 — DB を作らない

**新しいテーブルを作らない** (V1/V2 の 6 テーブル + `executive_subjects` は撤回済み)。
part の応答をブラウザ側 (IndexedDB) に (人物, ファイル, ページ) をキーに保持し、
**再開時は保持済みを飛ばす**。

- ブラウザを閉じても残る (localStorage / IndexedDB はタブを越えて残る)
- **PII を持つ**ので、納品完了後に**明示的に消す導線を置く**
- 別の PC では再開できない (今回 1 人の管理者が通す前提なので許容)

> **発注者確認 Q2**: この割り切り (1 台のブラウザで通す・別 PC では再開不可) でよいか。
> 跨ぎたいなら DB が要るので、その時点で「DB を触らない」が崩れる。

---

## 8. Executive (client_id) の決め方

**`client_id` = `diagnostic_user_id`** (既存の Elith 連携仕様)。
10 名は EC の顧客とは限らないので、**誰の client_id を使うかは発注者が指定する**。

V4 は **人物フォルダ名と client_id の対応を管理者が画面で確認して確定する**だけを持つ。
**氏名から自動で当てない** (CLAUDE.md「氏名 OCR のみでの顧客割当確定は禁止」)。

> **発注者確認 Q3**: 10 名の `client_id` をどう用意するか。
> ①既存の診断ユーザーがいる ②今回用に採番する ③Wellfort 側で払い出す。

---

## 9. 遺伝子のページ範囲

Genoplan は 208 または 210 ページあるが、**疾患リスク倍率を持つ項目が印字されているのは
p10〜35 の 26 ページだけ**。根拠 = `docs/scan/golden/scan_golden_genetic_geneplanet_20240131.md`
(この範囲から 220 項目を建立)。

**既存 UI が編集可能な from/to を持っている**ので、V4 は**同じ入力欄を使う**。
**定数を新設しない** (V1/V2 が `GENOPLAN_V1_REQUIRED_PAGES` を作ったが撤回済み)。
既定値に 10 / 35 を入れておき、**残りのページを LLM へ送らない**ことだけ守る。

---

## 10. テスト設計

**大量の unit test から始めない。** 順に通す。

| # | 内容 | 合格条件 |
|---|---|---|
| **A** | 実 ZIP から 1 人を取り出す | 人物フォルダと所属ファイルが画面に正しく出る |
| **B** | その 1 人を既存 Production 処理へ流す | part / finalize が 200 を返し JSON が出る |
| **C** | **通常経路と同一であること** | **同じ builder を 2 つ比較するのではなく、`elith-batch.astro` と V4 が同じ API・同じ関数を呼んでいることをコードで示す**。加えて同一入力で JSON をバイト比較 |
| **D** | 10 人全員を実行 | 30 JSON (健診 10 / 問診 10 / 遺伝子 10) |
| **E** | **人物 A の入力が人物 B へ混ざらない** | 全 JSON の `client_id` と中身が人物と一致 |
| **F** | **Human Review 前に Elith へ納品されない** | 承認前に納品キーが S3 に存在しない |
| **G** | 承認後に既存 S3 納品で Elith へ渡り、Elith 側で正常処理できること | Elith からの完了確認 |

**Test C が最重要。** 「同じ処理を呼んでいる」ことを保証する形にする
(例: V4 のコードに `elith-export` / `elith-genetic` / `interview-export` の関数を
再実装した箇所が 0 件であることを機械で見る)。

---

## 11. 新規実装

### 11.1 作るもの

| # | 新設 | 置き場所 | 概算 |
|---|---|---|---|
| 1 | ZIP 展開 + 人物分離 | wellfort-site `src/scripts/` | 1 ファイル |
| 2 | 呼び出し順の制御 (人物 × 検査 × ページ) | 同上 | 1 ファイル |
| 3 | 進捗保持と再開 (IndexedDB) | 同上 | 1 ファイル |
| 4 | 画面 (一覧 / Executive 確認 / Human Review / 状態表示) | wellfort-site `src/pages/admin/` | 1 ページ |
| 5 | 問診の扱い | **§5 の判断待ち** | P-1/P-2 = 0 / P-3 = 2 ファイル + 中継 1 |

**合計 4〜5 ファイル + 1 ページ。**

### 11.2 作らないもの (既存呼び出しで済む)

健診の解析・JSON 生成 / 遺伝子の解析・JSON 生成 / 問診の JSON 生成 /
S3 納品 / Elith スキーマ / PDF → ページ画像 / 認可の 2 層 / 中継 (健診・遺伝子)。

### 11.3 触らないもの

- **Scan-Chat-AI の `src/lib/**` と `src/pages/api/**`** (新規ルート 0 本・既存改変 0 行)
- **`astro.config.mjs`** (`maxDuration` は案件前の 60 のまま)
- **DB** (migration 0 件)
- **決済 / EC**: `src/components/products/WellfortProductDetail.astro` /
  `src/pages/products/[id].astro` / `src/pages/api/payment-status*` / `src/lib/payment*` /
  `supabase/**` / checkout / GMO / Amazon Pay

---

## 12. 禁止事項

1. 旧 V1/V2/V3 コードを参考に新設計する
2. 旧仕様を正本にする
3. 新しい診断 pipeline を作る
4. 新しい JSON schema を作る
5. Production と同じ処理をコピーする
6. 独自 parser を先に作る
7. 独自 canonical table を作る
8. 大量の validation を先に作る
9. 大量の合成 fixture テストから始める
10. **「安全のため」という理由だけで処理を追加する**
11. 推測で Production 挙動を再現する
12. **共有 core 化を「綺麗になるから」で行う** — まず既存 API をそのまま呼ぶ方法を検討し、
    どうしても不可能な場合だけ最小限の切り出しを**案として提示**する (承認前に実装しない)

---

## 13. 発注者確認事項

| # | 内容 | 章 |
|---|---|---|
| **Q1** | 解析フェーズをドライランで回すか (= 健診の元画像を S3 に残さない) | §6.2 |
| **Q2** | 進捗をブラウザだけに持つ割り切りでよいか (別 PC では再開不可) | §7.2 |
| **Q3** | 10 名の `client_id` をどう用意するか | §8 |
| **Q4** | **問診を P-1 / P-2 / P-3 のどれで通すか** | §5.2 |
| **Q5** | 撤回した DB (6 テーブル + `executive_subjects`) を実際に DROP するか。<br>`executive_subjects` は email の unique index を持ち **PII を含む** | 撤回報告 |
| **Q6** | S3 の後片付け。`ad-hoc-uploads/` は案件専用で安全。<br>**E2E が書いた納品 JSON 1 件は本番の納品と同じ名前空間**にあるので個別に特定が要る | 撤回報告 |

---

## 14. 実装順序

1. **Q1〜Q4 の回答を得る** ← いまここ
2. Test A (1 人を取り出す) だけを通す最小の画面
3. Test B → C (1 人を既存処理へ / 通常経路と同一であることの証明)
4. Test D → E (10 人 / 混ざらない)
5. Test F (承認前に納品されない)
6. Test G (Elith で正常処理)

**2 以降は発注者承認の後。**
