# トランスコスモス10名 ― 一括投入 仕様書 v4.0

作成: 2026-09-15 / 更新: 2026-09-15 (Q1 / Q2 / Q4 裁定 + 問診=完全オーダーメイド裁定 + Q3 提案)
状態: **設計。発注者承認まで実装しない**
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
  │   問診XLSX → 変換表 → answers → interview/export     │
  │   (8 名。PDF 2 名は手入力 — §5.3)                 │
  └──────────────────────────────────────┘
   ↓ 各 part の応答をブラウザに保持
  Human Review 画面 (10 人 × 3 形式の一覧と中身)
   ↓ 承認した人物だけ
  finalize → 既存 S3 → Elith
```

**診断処理そのものは 1 行も書かない。** 書くのは順番に呼ぶことと、見せることだけ。
**唯一の例外が問診の変換表** (§5.2 裁定 P-3)。これは診断処理ではなく**入力アダプタ**で、
§5.3 の枠を守り、案件終了後に削除できる状態に保つ。

---

## 5. 問診 — 唯一「そのまま呼べない」入力

### 5.1 事実 (実測)

```
既存入口:  POST /api/interview/export   (src/pages/api/interview/export.ts)
受ける形:  answers オブジェクト (:16,38,68)。
           XLSX / PDF を読む処理は LLM 含め一切持たない
           (interview-export.ts の gemini 参照 0 件)。
ZIP:       Google Forms 由来 XLSX 8 名 / 紙の PDF 2 名
```

健診と遺伝子は入力が画像なのでそのまま渡せる。**問診だけが形が違う。**

**そのまま使える引数** (`export.ts:13-18`): `clientId` / `dateOfBirth` / `sex` /
`completedAt`。→ **client_id も test_date も呼び出し側から渡せる**ので、
この 3 点のために新設するものは無い。`AWS_REGION` 未設定ならドライラン (`:93-104`)。

**【重要】値の検証はどこにも無い。**

- `buildAnswers` は `QUESTIONS[id]` を**メタデータの参照にしか使わず**、値を選択肢と
  照合しない (`interview-export.ts:76-96`)。未知の id も `section_id: null` のまま通る。
- `formatAnswerLabel` は join / `String()` するだけ (`interview-script.ts:699-708`)。

→ **P-3 の正しさを保証するものは変換表だけで、後段に受け皿は無い。**

**【重要】分岐 (`when`) はこの経路では走らない。**

- `when` を評価するのは `InterviewEngine` / `resolvePath` だけ (`interview-script.ts:552`)。
- 条件はラベルの完全一致 (例 `:330` `a['S-STATUS'] === '過去に吸っていたが現在は吸わない'`)。

→ engine を通さない P-3 では、`S-STATUS`=吸ったことはない なのに `S-COUNT` に本数が入る、
といった **engine なら絶対に作らない組み合わせ**を誰も止めない。

**production の engine が実際に書く値の形** (ここに合わせる):

| 種別 | 例 | 値 | 根拠 |
|---|---|---|---|
| text (numeric) | `B-HEIGHT` | `"172"` — **単位を付けない** | `interview-script.ts:261-265` の `example: '172cm → 172'` |
| chip | `SL-QUALITY` | ラベル 1 個の文字列 | `interview-script.ts:497-500` |
| multi / list(multi) | `H-PAST` | ラベルの `string[]` | `formatAnswerLabel :700-703` |
| slider | `SL-STRESS` | `"7 / 10"` — **数値ではなく文字列** | `live-controller.ts:431` |
| matrix | `F-FREQ` | `"野菜・海藻類：ほぼ毎日 / フルーツ：週2〜3回 / …"` | `choice-picker.ts:630-634` |

### 5.2 裁定 — **P-3** (2026-09-15 発注者)

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| P-1 | 本人に問診アプリを通してもらう | 新規実装ゼロ。production の分岐・検証がそのまま効く | 10 名に操作を依頼する必要がある |
| P-2 | 管理者が問診アプリの画面に代理入力する | 新規実装ゼロ。answers は engine が作るので正しさが担保される | 10 名 × 約 35 問の手入力 |
| **P-3** ← **採用** | XLSX の列 → `question_id` の**変換表**を書く | 8 名ぶんが自動。PDF 2 名は結局手入力 | 今回専用の変換規則が生まれる。正しさの保証が engine から変換表へ移る |

当初の推奨は P-1 / P-2 だった (理由 = 5.1 のとおり engine が保証していたものが
変換表の正しさに置き換わるため)。**発注者裁定により P-3 で進める。**
保証が移る以上、**移った先を落とさないための枠が 5.3**。

### 5.3 P-3 の枠 — 「今回限りの入力アダプタ」

**位置づけ: 診断パイプラインの一部ではない。** 今回 10 名を通すための入力アダプタであり、
案件終了後に削除しても production の問診が壊れないこと、を設計の条件とする。

| # | 守ること | 理由 |
|---|---|---|
| 1 | **別ファイルに閉じる**。production の `src/lib/**` / `src/pages/api/**` から import されない | 案件終了後に消せる状態を保つ |
| 2 | **語彙は production の定義をそのまま読む** — `QUESTIONS[id]` の `chips` / `multi_options` / `list_options` / `matrix_rows` / `matrix_cols` を許可値の唯一の出典にする。**選択肢の一覧をアダプタ側に書き写さない** | §12 #7「独自 canonical table を作らない」。写すと production 側の選択肢変更と黙って食い違う |
| 3 | **値の形は 5.1 の表に合わせる**。matrix は `formatMatrix()` を、ラベル整形は production の関数を **import して使う**。再実装しない | §12 #5「Production と同じ処理をコピーする」 |
| 4 | **分岐の整合は production の `resolvePath(answers)` で確認する** (`interview-script.ts:549` から export 済み)。生成した id 集合が `resolvePath` の結果と一致しなければ**そこで止める** | engine が走らないぶんの穴を、engine 自身の関数で塞ぐ。整合ロジックを自作しない |
| 5 | **fail-closed**。未知の列 / 許可値に一致しない値 / 表現できない回答は、**推測で寄せず・黙って捨てず**、その人物を「要確認」にして人へ出す | 5.1 のとおり後段に受け皿が無い。捏造ゼロ |
| 6 | **LLM・fuzzy・部分一致・意味推定を使わない**。正規化は NFKC + trim + 連続空白の縮約まで | 決定論。問診は元々 LLM を使わない処理 |
| 7 | **変換表は実物の XLSX から起こす**。列見出しと選択肢の**実際の文字列を verbatim で**表に書き、出典 (ファイル名・列位置) を併記する | CLAUDE.md R2「存在するかを先に確認する」。**本作業環境に ZIP が無いので、表は実装ステップ 1 で実物を開いて書く。いま推測で書かない** |
| 8 | **複数回答を 1 件に落とさない / 表現できない値を切り捨てない**。Google Forms の複数選択は区切り文字で 1 セルに入るので、**区切りも実物で確認してから**決める | 情報の欠落は画面上は正常に見える |
| 9 | **PDF 2 名にパーサを作らない**。P-1 / P-2 と同じ手入力で通す | §12 #6「独自 parser を先に作る」 |
| 10 | 変換表と、**人が目で確認するための「XLSX の生の値 → 送る値」の対照表示**を画面に出す | 納品前に人が確認できることが、変換表の唯一の検算手段 |

**表に無い列は「未対応」として人へ出す。**「安全のため」に既定値を入れない (§12 #10)。

### 5.3.1 裁定 — **完全オーダーメイド。他案件で使い回さない** (2026-09-15 発注者)

> 「既に入力データ (ZIP) が確定して実データもあるので、内容を確認して、
> 完全オーダーメイド (他の案件で使い回しはしない)」

**これは 5.1 の 3 つの懸念に対する答えになっている。** 入力が**閉じた有限集合**
(8 ファイル・列数も選択肢も確定済み) になるので、**一般的な検証を作る代わりに、
実物を網羅で潰せる**。

| 5.1 の懸念 | 一般実装なら | 完全オーダーメイドなら |
|---|---|---|
| ① 値の検証が後段に無い | 汎用 validator を書くことになる (§12 #8 に触れる) | **8 ファイルの全セルが「写像済み」か「未対応として人へ」のどちらかであることを 1 回数え切る**。網羅が検証の代わりになる |
| ② `when` が走らない | 整合ロジックを自作することになる | **8 名ぶんを `resolvePath` に通して一致を確認するだけ**。仕組みでなく実測 |
| ③ 値の形が素直な型と違う | 全設問ぶんの汎用変換が要る | **実際に出現する設問ぶんだけ**、5.1 の表に合わせて固定する |

**したがって守ることが 5.3 に 4 つ足される。**

| # | 守ること | 理由 |
|---|---|---|
| 11 | **一般化しない。** 列の判定は**実際の見出し文字列の完全一致**のみ。パターン照合・正規表現での吸い込み・「Google Forms 一般」への対応をしない | 一般化した瞬間に、確定しているはずの入力に対して未知の分岐が生まれる |
| 12 | **網羅を数える。** 8 ファイルの列を全部列挙し、各列が「どの `question_id` へ写るか」「写さない (理由つき)」のどちらかに決まっていることを**件数で示す**。取りこぼし 0 を数字で確認する | ①の代わり。目視では抜ける |
| 13 | **8 名ぶんの結果を人が 1 回通して見る。** `resolvePath` 一致の確認と、XLSX の生の値 → 送る値の対照表示 (§5.3 #10) を 10 名ぶん出し切る | ②の代わり。10 名しかいないので全件確認できる |
| 14 | **案件名を冠した 1 ファイルに閉じ、他から import しない。** 汎用の名前を付けない (`xlsx-to-answers` のような名前にしない) | 「使い回さない」を名前とファイル境界で担保する。次の案件で流用されると、確定していない入力に確定前提の表が当たる |

**本作業環境に ZIP が無い。** 「内容を確認して」に当たる作業 (列見出しと選択肢の採取) は
**実物を受け取ってから**行う (§5.3 #7 / §14 step 2)。**いま推測で表を書かない。**

### 5.4 中継が 1 本だけ要る — 理由は認可ではなく CORS

`/api/interview/export` には **Bearer 認可が無い** (`export.ts` の import に `api-auth` が無い
= エンドユーザー経路として設計されている)。一方 Scan-Chat-AI 側に CORS ヘッダを付ける
middleware は無い (`src/middleware*` 無し / `access-control-allow-origin` の実装 0 件)。
→ wellfort-site の管理画面 (別オリジン) のブラウザから直接は呼べない。

**既存の中継 (`elith-genetic-merge.ts` 86 行) と同型を 1 本足す。**
入口の admin 判定 (ユーザートークン + anon apikey → `admin_users`) はそのまま流用する。
**この中継が新たに開けるのは「管理者が任意の client_id で問診 JSON を書ける」だけ**で、
これは既存の `elith-scan` / `elith-hc-merge` で管理者が既に持っている権限と同じ。

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

> **裁定 Q1 (2026-09-15 発注者) = ドライラン可。**
> 解析フェーズは `AWS_REGION` 未設定で回す。**今回 10 名ぶんの健診の元画像は S3 に残らない。**
> 通常運用では監査用に残しているが、今回は残さないことを承知のうえで進める。
> 監査に使える原本は**管理者の手元の ZIP** なので、**納品完了まで ZIP を消さない**こと。
> `elith-hc-merge` の `part` は改造しない (通常運用の挙動は不変)。

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

> **裁定 Q2 (2026-09-15 発注者) = 了承。**
> 1 台のブラウザで通す。別 PC では再開できない。DB は作らない。
> **帰結として守ること**: ①作業中にそのブラウザのサイトデータを消さない
> ②納品完了後に**明示的に消す導線**を必ず用意する (PII がブラウザに残るため)
> ③プライベートウィンドウで作業しない (閉じると消える)。

---

## 8. Executive (client_id) の決め方 — Q3 の提案

### 8.1 実測した事実

**仕様上の定義** (`docs/elith/elith_s3_data_handoff_spec.md:44` / §2.1):

- `client_id` = **顧客を一意に識別する ID**。Wellfort の `diagnostic_user_id` (uuid) を充てる。
- 理由は **PII を含まない橋渡しキーだから**。S3 のパスとファイル名は Elith と共有されるので、
  **ここに PII を絶対に載せない**。
- `client_id` は**通年で不変**。回の分離は日付フォルダで行う (`:105`)。
- なお **Elith への確認 #1「client_id に uuid を用いる前提でよいか」は未回答のまま** (`:520`)。

**コードは client_id を検証しない** (実測):

| 経路 | 未指定のとき | 根拠 |
|---|---|---|
| `elith-hc-merge` | **400 で止まる** | `:92-93` |
| `elith-genetic-merge` | **400 で止まる** | `:85-86` |
| `elith-scan` | **黙って `randomUuid()` で納品する** | `:93` |
| `interview/export` | **黙って `diagnosticUserId → diagnosticId`(新規 uuid) で納品する** | `interview-export.ts:252` / `export.ts:73` |

- **形式の検査は 1 か所も無い。** 値はそのまま S3 キーへ文字列連結される
  (`elith-export.ts:1459-1460`)。DB 照会も無い (3 経路とも supabase 参照 0 件)。
- → **存在しない ID でも納品は成功する。** 止めるのは V4 の画面の役目 (§8.5)。

**production の前例 = uuid でない ID も既に納品されている**:

- 既存 admin の「② client_id の付け方」は **自動採番 (`test-…`) / 固定 ID** の 2 択
  (`wellfort-site src/pages/admin/elith-batch.astro:69-75`)。自動は `test-{stamp}-001` (`:1434`)。
- 仕様書のサンプルにも `"client_id": "elith-test-003"` がある (`:349`)。

**uuid でないと後から本人に繋げられない** (決定的):

- `diagnosis.app_users.diagnostic_user_id` は **`uuid` primary key** (`supabase/migrations/20260601000010_schemas_and_tables.sql:174`)。
  `customer.customer_profiles.diagnostic_user_id` も `uuid unique` (`:53`)。
- Elith から返る報告書の置き場 `diagnosis.diagnosis_results` は
  `app_users(diagnostic_user_id)` への FK (`:231`)。
- → **`transcos-01` のような文字列は、後から app_users に載せられない。**

### 8.2 分岐点 — 「この 10 名はアプリで結果を見るか」

**ここだけが案を分ける。** 他は全部同じ。

- **見せない** (Elith の診断結果は Wellfort が受け取り、アプリの外で 10 名へ渡す)
  → client_id は納品の宛名にすぎない。何でもよい。
- **見せる (将来を含む)**
  → client_id は `app_users.diagnostic_user_id` **でなければならない** (8.1 の FK)。
  後から変えるには**納品をやり直す**しかない (S3 のパスにもファイル名にも入っているため)。

### 8.3 案の比較

| | 案A 既存の診断ユーザーを使う | **案B 今回用に uuid を採番** | 案C 読みやすい ID を振る |
|---|---|---|---|
| 例 | `customer_profiles.diagnostic_user_id` | `3f9c…` (uuid v4) | `transcos-01` |
| 前提 | **10 名が EC の顧客であること** | なし | なし |
| 仕様 §2.1 との整合 | ○ | ○ | △ (uuid でない) |
| PII | ○ 含まない | ○ 含まない | **△ 取引先名が Elith と共有するパスに載る** |
| 後から本人に繋げる | ○ そのまま | ○ **そのまま app_users に載せられる** | **× uuid 列に入らない＝納品やり直し** |
| 照合の手間 | **氏名で当てられない** (CLAUDE.md「氏名 OCR のみでの顧客割当確定は禁止」) → 1 名ずつ人が確認 | 対応表を作るだけ | 対応表を作るだけ |
| S3 の後片付け | 本番の顧客と同じ名前空間に混ざる | 同上 (対応表が要る) | ○ 前置詞で一括特定できる |

### 8.4 提案 — **案B (今回用に uuid を採番)**

理由は 3 つ。

1. **10 名が EC の顧客だとは限らない。** 案A はその前提が崩れると使えない。
   production には既に前例がある — 顧客でない人 (記者・パートナー) に
   `crypto.randomUUID()` を振る経路がある (`src/lib/demo-accounts.ts:291`)。
2. **案C は後戻りできない。** 8.1 のとおり `app_users` は uuid 列なので、
   `transcos-01` で納品した後に「やはりアプリで見せたい」となったら**納品のやり直し**になる。
   uuid なら**そのまま** `app_users` に載せられる。「読みやすさ」は§8.5 の対応表と画面のラベルで
   足りるので、**後戻りできない代償を払う理由が無い。**
3. **案C は取引先名を Elith と共有するパスに書く。** 既存ポリシーが禁じているのは個人の PII だが、
   `transcos-01` + 納品日は文脈次第で個人に辿れる。**uuid にすれば論点自体が消える。**

**採番のしかた**:

- **`crypto.randomUUID()` を 10 個**。人物フォルダとの対応は**管理者が画面で 1 名ずつ確認して確定**する
  (V4 は氏名から自動で当てない)。
- **対応表 (氏名 ↔ uuid) は PII なので Elith へ渡す物には入れず、Wellfort 側だけで保管する。**
  納品物・S3 のパス・JSON 本文のどこにも氏名を入れない (既存仕様どおり)。
- **一度決めたら変えない** (`client_id` は通年不変・`:105`)。

**アプリで結果を見せるなら、追加で 1 手**: 採番した uuid で `diagnosis.app_users` に行を作る。
**これは migration ではなくデータ投入**だが、**production DB への書き込み**なので**別途承認が要る**。
V4 の納品自体はこの行が無くても成立する (8.1 のとおり DB を見ないため)。

### 8.5 案がどれでも守ること — **client_id を省略できない画面にする**

8.1 の実測のとおり、**4 経路のうち 2 経路は client_id が無くても黙って別の ID で納品する。**
これは「間違いに気づけない失敗」なので、V4 側で構造的に塞ぐ。

1. **10 名全員の client_id が確定するまで、納品ボタンを押せない。**
2. **呼び出しの直前に、その人物の client_id が入っていることを必ず確かめる。**
   `elith-scan` / `interview/export` の既定値に**一度も頼らない**。
3. **人物 × 検査の全呼び出しで同じ client_id を使う。** 健診・遺伝子・問診が別 ID になると、
   Elith 側では**別人 3 人**に見える (フォルダが `user/{client_id}/` で分かれるため)。
4. **Human Review 画面に、納品先のフルパスをそのまま出す。**
   `user/{client_id}/date/{YYYY_MM_DD}/…` を人が読んで確認できることが最後の砦。

### 8.6 発注者に決めてほしいこと

| | 内容 |
|---|---|
| **① 必須** | この 10 名は**アプリで結果を見るか** (§8.2)。見ないなら案B のまま進められる |
| **② 必須** | 案B (uuid 採番) でよいか。**案A を採るなら、10 名が EC 顧客である確認と、誰がどの `diagnostic_user_id` かの提示が要る** (氏名から当てない) |
| ③ ①が「見る」の場合 | 採番した uuid で `diagnosis.app_users` に行を作ってよいか (production DB への書き込み) |

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
| 5 | 問診アダプタ (XLSX → answers) — **P-3 裁定済み** | wellfort-site `src/scripts/` (**production から import されない別ファイル**) | 1 ファイル |
| 6 | 変換表 (実物の列見出し → `question_id` / 値 → 許可ラベル) | 同上 (5 と分けて data として持つ) | 1 ファイル |
| 7 | `/api/interview/export` への中継 | wellfort-site `src/pages/api/admin/` | 1 ファイル (既存 86 行と同型) |

**合計 7 ファイル + 1 ページ。** うち 5〜7 は **P-3 を採ったぶん**で、
案件終了後に削除しても production の問診は壊れない (§5.3 #1)。

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
   — **P-3 の変換表はこれに当たらない条件で作る**: 許可値の出典は production の
   `QUESTIONS[id]` であり、アダプタ側に選択肢を書き写さない (§5.3 #2)。
   書き写した時点で #7 違反になる。
8. 大量の validation を先に作る
9. 大量の合成 fixture テストから始める
10. **「安全のため」という理由だけで処理を追加する**
11. 推測で Production 挙動を再現する
12. **共有 core 化を「綺麗になるから」で行う** — まず既存 API をそのまま呼ぶ方法を検討し、
    どうしても不可能な場合だけ最小限の切り出しを**案として提示**する (承認前に実装しない)

---

## 13. 発注者確認事項

### 13.1 裁定済み (2026-09-15)

| # | 内容 | 裁定 | 章 |
|---|---|---|---|
| **Q1** | 解析フェーズをドライランで回すか | **ドライラン可**。健診の元画像は S3 に残さない | §6.2 |
| **Q2** | 進捗をブラウザだけに持つ割り切りでよいか | **了承**。1 台のブラウザ・DB を作らない | §7.2 |
| **Q4** | 問診を P-1 / P-2 / P-3 のどれで通すか | **P-3**。枠は §5.3 | §5.2 |

### 13.2 未回答 — **Q3 は納品を止める**

| # | 内容 | 影響 | 章 |
|---|---|---|---|
| **Q3** | 10 名の `client_id` をどう用意するか | **納品の前提条件**。S3 のキーが `user/{client_id}/…` なので、**これが決まるまで誰にも納品できない**。<br>**提案 = 案B (今回用に uuid を採番)。§8.4**。決めてほしいのは §8.6 の 2〜3 点 | §8 |
| **Q5** | 撤回した DB (6 テーブル + `executive_subjects`) を実際に DROP するか。`executive_subjects` は email の unique index を持ち **PII を含む** | 実装は進められる (V4 は DB を使わない)。**PII が残り続けるので別途判断が要る** | 撤回報告 |
| **Q6** | S3 の後片付け。`ad-hoc-uploads/` は案件専用で安全。**E2E が書いた納品 JSON 1 件は本番の納品と同じ名前空間**にあるので個別に特定が要る | 実装は進められる。**削除候補の提示のみで実削除はしていない** | 撤回報告 |

**Q3 は解析・確認までは進められるが、納品 (finalize + S3 write) に入れない。**
Q1 の裁定でドライランを回すので、**解析フェーズは Q3 の回答を待たずに始められる**。

---

## 14. 実装順序

**現在地: Q1 / Q2 / Q4 裁定済み。Q3 未回答 (= 納品まで到達できない)。**

| # | 内容 | 前提 |
|---|---|---|
| 1 | Test A (1 人を ZIP から取り出す) だけを通す最小の画面 | 承認 |
| 2 | 実物の XLSX を開いて**列見出しと選択肢を verbatim で採取**し、変換表を起こす (§5.3 #7) | 承認 + ZIP |
| 3 | 問診アダプタ + 中継。`resolvePath` 一致と対照表示まで (§5.3 #4 #10) | 2 |
| 4 | Test B → C (1 人を既存処理へ / 通常経路と同一であることの証明) | 1 |
| 5 | Test D → E (10 人 / 混ざらない) | 4 |
| 6 | Test F (承認前に納品されない) | 5 |
| 7 | 納品 (finalize + S3 write) → Test G (Elith で正常処理) | **Q3** |

**1 以降は発注者承認の後。** 本仕様書の時点では実装を開始していない。
