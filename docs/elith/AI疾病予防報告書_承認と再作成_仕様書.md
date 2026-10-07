# AI疾病予防報告書 承認・再作成 仕様書

- 対象: AI疾病予防報告書 (`diagnosis.diagnosis_results`)
- 目的: Elith 受領 JSON から生成された報告書を、**利用者のダッシュボードへ出す前に Wellfort 管理者が確認・承認**できるようにする
- 方針: **暫定機能**。既存処理を最大限流用し、実装・運用とも最小構成にする
- バージョン管理: **行わない**。報告書は常に最新生成結果で上書きする
- 発注日: 2026-10-07 (発注者指示書 `claudecode_ai_report_approval_instructions.md` + 要件 `wellfort_ai_report_approval_spec.md`)
- 実装: 済み (この文書が正本)

---

## 読み方 (節番号について)

**節番号は発注の要件定義書 `wellfort_ai_report_approval_spec.md` に合わせてある**
(コードのコメントがこの番号で参照しているため)。
要件定義書の §1 背景 / §2 基本方針 はそのまま有効なのでここでは繰り返さない。
§0 だけがこの文書の追加で、**実装を読む前に必ず読む前提**。

| 節 | 内容 |
|---|---|
| §0 | **【最重要】紙面は保存されていない** という前提 |
| §3 | 公開状態 (状態遷移 / 既存 `status` を使わない理由 / **§3.3 承認した紙面の指紋**) |
| §4 | 既存報告書の扱い (導入時に消さない) |
| §5 | 管理画面 (1 画面・一覧 / 確認 / 承認 / 再作成) |
| §6 | 1 件再作成の処理 |
| §7 | Elith 再 RUN 時 |
| §8 | ユーザー側の表示条件 (サーバ側で approved 限定) |
| §9 | 同時実行・誤操作対策 |
| §10 | 権限 |
| §11 | 実装上の重要原則と、実装していないもの |
| §12 | 検証と受入条件 |
| §13 | **§13.1 本番反映の順序 (必須)** / 申し送り |

---

## 0. 【最重要】この機能の前提 — 紙面は保存されていない

**実装を読む前にここを理解すること。** 誤解すると「再作成」の意味を取り違える。

`diagnosis.diagnosis_results` に入っているのは **Elith 受領 JSON** であって、
報告書の**紙面 (HTML) は保存されていない**。紙面は表示のたびに組まれる。

```
Elith 受領 JSON (S3)
  → 取り込み   elith-intake.ts / api/admin/elith-report/upload.ts
  → 保存       elith-report-ingest.ts ingestElithReport()
               diagnosis.diagnosis_results (report / checkup_values / schema_version / source_key)
  → 生成       report-adapter.ts buildReportVM()   ★表示のたびに毎回
  → 取得       elith-report-queries.ts loadReportVM()
  → 表示       report.astro (画面と ?print=1 が同じレンダラ)
```

したがって:

- **生成ロジックを直してデプロイした時点で、過去分の紙面も自動的に新しくなる。**
  「過去分に修正を反映するための再生成」は、紙面については**何もしなくても効いている**。
- 保存されている成果物は受領 JSON だけ。再作成で**作り直せるのは受領 JSON の控えと生成の検証**。

**「最新版生成処理で再作成」の実体は 3 つ** (§6.4):

1. その報告書に対応する**現在の**受領 JSON を取り直す (S3 → 無ければ DB の控え)
2. **本番と同じ `buildReportVM()`** に通し、最後まで生成できることを確かめる
3. 成功したときだけ上書きし、`pending` へ戻して**再承認を要求する**

→ **バグ修正を過去分へ反映したうえで「人が目で確認し直す」**という運用が、この機能の価値。
**再作成専用の生成ロジックは作らない。**

---

## 3. 公開状態

`diagnosis.diagnosis_results` に専用の列を足す
(migration `20261007000010_diagnosis_report_approval.sql` ＋
`20261007000020_diagnosis_report_approval_hash.sql`)。

| 列 | 意味 |
|---|---|
| `publish_status` | `pending` = 未承認 (**ユーザーに返さない**) / `approved` = 承認済 |
| `approved_at` | 承認日時。`pending` のときは null |
| `approved_by` | 承認した管理者。**`adminIdentity()` の HMAC digest だけ** (生メールは入れない) |
| `publish_rev` | 再作成のたびに +1 するカウンタ。**履歴ではない** (§9 の競合検知用) |
| `approved_report_hash` | **承認した紙面の指紋** (SHA-256 16進 64文字)。表示時に一致しなければ公開しない (§3.3)。NULL = 指紋なし = 従来どおり公開 |

### 3.1 状態遷移

```
新しい Elith 受領 JSON → 報告書の行を insert → pending   (DB の既定。追加処理なし)
pending  → 管理者が承認 → approved (+ approved_at / approved_by / approved_report_hash)
approved or pending → 再作成成功 → 上書き → pending
                      (approved_at / approved_by / approved_report_hash は null へ)
再作成失敗 → 報告書・承認状態・指紋とも一切変更しない

approved かつ 指紋が現在の紙面と一致     → ユーザーに出る
approved だが 指紋が一致しない           → **出ない** (生成ロジック / 章立ての設定が変わった)
                                           → 管理者が再確認して再承認すれば戻る
```

---

### 3.2 なぜ既存の `status` を使わないか

既存 `status` (`received | extracted | published | superseded`) は**世代管理を兼ねている**。
取り込みは「既存行を `superseded` に落として新しい行を足す」ので、承認状態を同じ列に載せると
**差し替えのたびに承認の記録が消える**。

さらに `status='published'` は 4 か所が読んでいる
(`coach-context.ts` / `chat-context.ts` / `result-queries.ts` / `dashboard-queries.ts`。
実データでは一度も立たないため現在は死蔵)。ここへ承認の意味を持ち込むと
**その 4 経路の挙動が黙って変わる**。

→ 承認は専用列に分け、**`status` は 1 文字も触らない**。

### 3.3 承認した紙面の指紋 (`approved_report_hash`)

**§0 のとおり紙面は保存されていない。** だから `publish_status='approved'` だけでは
「管理者が実際に確認した報告書だけを公開する」を満たさない —
**一度承認したあとに生成ロジックを直してデプロイすると、状態は `approved` のまま
紙面だけが変わる**。

→ **承認した時点の `ReportVM` の指紋 (SHA-256) を控え、表示時に同じ方法で算出した
指紋と一致しなければ公開しない。**

- 報告書そのものは保存しない・版も持たない。控えるのは **64 文字のハッシュ 1 本だけ**
  (§11.3 のとおり revision テーブルも過去版も作らない)。
- 「生成ロジックを直せば過去分の紙面も自動的に新しくなる」仕組みは**変えない**。
  変わったことを**検知して非公開に戻す**のがここの役目で、そのあと管理者が
  新しい紙面を確認して再承認する。
- 実装は `src/lib/report-fingerprint.ts` 1 本。承認・一覧・表示が**同じ関数**を呼ぶ。

#### 3.3.1 指紋の対象 (= 生成ロジックが作る部分だけ)

`buildReportVM` の入力 7 件の使われ方を実測して決めた (`report-adapter.ts`)。

| 入力 | 紙面への影響 | 扱い |
|---|---|---|
| `reportText` / `checkup` (受領 JSON) | digest・chapters・`cover.testedOn` の全部 | **含む** |
| `readConfig` (app_config `report.sections.*`) | 章の順序・表示可否・見出し・開閉 | **含む** |
| `issuedOn` | `cover.issuedOn` (= その行の `received_at`。承認時も表示時も同値) | **含む** |
| `hasCancerRisk` | **`reportType` にしか入らない** (`:915`)。`reportType` は**レンダラが 1 度も読んでいない** (`report.astro` に 0 件。使うのは audit / debug API だけ) | 除外 |
| `isSample` | 「サンプル表示」バッジのみ。承認対象は実データ行なので常に false | 除外 |
| `name` / `cycleSeq` / `chronologicalAge` | `cover` にそのまま入る (`:891,895,898`)。閲覧者の氏名・契約の回・当社 `health_age_scores` | 除外 |
| `ourWellnessAge` | `cover.wellnessAge` の**フォールバック** (`:885`) と `audit.anomalies` (`:661,887`) | 除外 |
| `selfReported` | 本文に「（問診時）」を付ける = **紙面を変える**。ただし表示経路の `common()` は渡していない (開発用の PDF 生成だけが使う) | 除外 (検査で固定) |

コードの定数 (`sheetVersion` / `cycleTotal` / `axes` の見出し) は**含む** — 変えれば紙面が変わる。
`audit` は紙面に出ない (`report.astro` に 0 件) ので**除外**。

**この分け方が成り立つ要点**: 除外する値はどれも `buildReportVM` の入力をそのまま写して
いるだけなので、**指紋は閲覧者の文脈に依存しない**。だから

```
承認 API (中立の文脈で組んだ VM) の指紋  ==  表示経路 (本人の文脈で組んだ VM) の指紋
```

となり、**承認側が閲覧者の文脈 (氏名・実年齢・第 N 回・がんリスク検査の有無) を
再現する必要がない**。再現を要求する設計にすると、承認 API が `loadDashboard` +
`getHealthAge` + bridge origin の組み立てを複製することになり、**少しでも食い違った瞬間に
指紋が永久に一致せず承認済みの報告書が全件消える** (静かに起きる最悪の形)。
加えて、利用者が 1 歳年を取る / 検査サイクルが進む / がんリスク検査が 1 件増える、
だけで公開が落ちる。どれも「生成ロジックが変わった」ではない。

この性質は `verify:report-approval` ⑪ が**本物のアダプタ**で固定する
(文脈を全部変えても指紋が同じ / 本文を 1 文字変えると指紋が変わる)。

#### 3.3.2 この指紋が保証する範囲 (「紙面の完全一致」ではない)

**保証するのは「受領 JSON・生成ロジック・app_config から生成される承認対象部分の一致」**で、
紙面の完全一致ではない。

**対象外の紙面要素 = 表紙の 2 値** (ウェルネス年齢・実年齢) **と、そこから描く数直線**。
どちらも閲覧者側の値で描かれるため。具体的なギャップ:

- `health_age: null` の回は `cover.wellnessAge` が当社 CABA の値へフォールバックする
  (**意図された現行仕様**。§3.3.3) ので、後日その値が 58→56 に変われば
  **表紙の大数字と数直線だけが変わって指紋は変わらない**。
- 実年齢も同様で、こちらは Elith の値の有無に関係なく誕生日を越えれば動く。
- 本文・章・検査値の表は**すべて対象内**なので、文が 1 文字でも変われば検知する。

含めない理由は §3.3.1 のとおり (新しいスキャンで CABA が再計算された／1 歳年を取った
だけで承認済み報告書が全件非公開になり、かつ承認側が閲覧者の値を再現できない)。
**恒久解消は「Elith に `health_age` を必ず返してもらう」側** — フォールバックが
発火しなくなればこのギャップは消える (§6.4 の Elith 確認事項へ追記)。

#### 3.3.3 `ourWellnessAge` のフォールバックは意図された現行仕様 (2026-10-07 確認)

今回の対応で「過去実装の残存ではないか」を疑い、一次資料で確認した結果:

1. `report-adapter.ts:877-884` のコメントが **発注者指示 2026-09-01** を明示
2. 仕様書 `docs/elith/AI疾病予防報告書_仕様書.md:167` に**専用の節**
   「`health_age` が `null` の回は当社の元の値で埋める【発注者指示 2026-09-01】」がある
3. **コードと仕様書の節が同一コミット `9a047ca`** で入っている (残骸なら片方だけ残る)
4. 根拠も記録されている — ウェルネス年齢は当社が CABA で算出して `HealthAgeData` として
   Elith へ渡した値で **Elith は計算しない**ので、返さなかった回に当社の元の値を出すのは
   新しい数字を作ることではない。実測で 2026-08-24 受領のタイプ1 が `health_age: null`、
   補完が無いと表紙が空になる

**`report.astro:234-236` の「当社 CABA 値を持ち込まない」とは矛盾しない。** あれは数直線の
実装規律で、「ダッシュボードが別に持っている `healthAge.latest.biologicalAge` を直接使わず、
アダプタが決めた 1 つの値 `vm.cover.wellnessAge` を使え」という意味
(実コードも `gWell = vm.cover.wellnessAge`)。アダプタ内部のフォールバックを禁じる文ではない。

→ **挙動は変更していない。** 今回は §3.3.2 のとおり**保証の範囲を明文化**しただけ。

#### 3.3.4 正規化の方法

鍵の挿入順が指紋に混ざらないよう、**明示的に配列 (タプル) へ写してから**
`JSON.stringify` → UTF-8 → SHA-256 → hex 64 文字。

```
[ v, sheetVersion, issuedOn, testedOn, cycleTotal,
  [[axisKey, title], …],
  [[key, title, axis, source, detailAnchor, lead, blocks], …],       // digest
  [[key, title, axis, collapsed, [[anchor,heading,body],…], [[name,value,date],…]], …] ]  // chapters
```

`blocks` は判別共用体を `[kind, …payload]` で畳む (`paragraphs`/`steps`/`weeks`/`table`/`pairs`)。
先頭の `v` (`FINGERPRINT_VERSION`) は**正規化そのものの版**で、
**ここを上げると全件が再承認待ちになる** (指紋が一斉に変わる)。

#### 3.3.5 指紋が無い行は従来どおり公開する

`approved_report_hash` が NULL / 列ごと無い行は**照合せずに公開する**。理由 2 つ:

1. `20261007000010` が `approved` へ移行した**既存行**と、この機能より前に承認された行は
   承認時の紙面を控えていないので照合できない (§4・受入条件 1)
2. 列がまだ無い環境 (migration 未適用) — fail-open (§13.1)

**ハッシュのゲートは新しい承認 API で承認した回から効く。**

#### 3.3.6 app_config を変えると全件が再承認待ちになる

`report.sections.{order,hidden,labels,collapsed}` は紙面の構成そのものを変えるので
指紋の対象に入れている。つまり**章立ての設定を 1 つ変えると、承認済みの報告書が
全件「紙面が変わったため非公開」になり再承認が必要**になる。

「admin から即時に見せ方を変えられる」という利点と衝突するが、設定変更は紙面を実際に
変えるので「管理者が確認した紙面だけを公開する」を優先した (発注者了承 2026-10-07)。
管理一覧に **「紙面が変わった（非公開）」** を出すので、admin は原因を辿れる。

## 4. 既存報告書の扱い (導入時に消さない)

**導入した瞬間に既存の公開中の報告書が全部消えてはいけない。**

`add column ... not null default 'pending'` と書くと**既存の全行が pending** になる。
だから migration は 3 段で行う:

1. 列を**既定なし**で足す (既存行は null)
2. `update ... set publish_status = 'approved' where publish_status is null`
3. そのあとで `set default 'pending'` / `set not null`

→ **今後 insert される行だけが `pending`** になる。
**migration で報告書を一括再生成しない** (insert を 1 つも書かない)。

### 4.1 適用順序の保険

CLAUDE.md の migration 規約どおり **DB を先に適用する**。
ただし順序が入れ替わっても利用者の画面を落とさないよう、アプリ側は
**列が無い環境では「全行 approved 相当」** として振る舞う (`isApprovedRow()` が
`undefined` / `null` を承認済として扱う)。列が無い環境には `pending` の行も存在しないので、
これで未承認が漏れることはない。

- `loadReportVM` は列の有無で 3 段に落として引き直す
- `/api/report-route` も列を外して引き直す (**無いと 10 名の公開中 PDF が「開けない」に化ける**)
- 管理一覧は引けたら `migrationApplied: false` を返し、画面に「未適用」と出す
  (**「対象 0 件」と混同させない**)
- `approved_report_hash` が無い環境では**指紋の照合もしない** (指紋なし扱い・§3.3.5)。
  承認 API は**この状態では承認しない** (`migration_required`) — 指紋を書けないまま
  承認すると「生成ロジックが変わっても公開され続ける」状態になるため

**どちらも fail-open なので、本番は必ず migration を先に当てる (§13.1)。**

---

## 5. 管理画面 (1 画面)

**UI = wellfort-site / 処理 = Scan-Chat-AI API** (CLAUDE.md の責務分界)。

- 画面 … `wellfort-site/src/pages/admin/report-approval.astro`
  (サイドバー「検査連携」→「AI疾病予防報告書 承認」)
- 中継 … `wellfort-site/src/pages/api/admin/report-approval/[action].ts`
  (allow-list: GET `list` / POST `approve` `recreate`)
- API … `Scan-Chat-AI/src/pages/api/admin/report-approval/{list,approve,recreate}.ts`

### 5.1 一覧

**画面は 1 枚**。上部の切替で `未承認` / `承認済` を出す。
**専用の「承認済リスト」ページは作らない。**

各行に出すもの: チェックボックス / 公開状態 / `diagnostic_user_id` / 受領日時 /
再作成回数 / 形式 (`schema_version`) / 取り込み元 (`source_key`) / 操作。

**氏名は返さない・出さない。** 識別は `diagnostic_user_id` と受領日で行う
(Scan-Chat-AI 側は PII を持たない。報告書の中身で本人を確かめるのは次の「確認」で行う)。

### 5.2 確認

「確認」は**既存の代理表示 (handoff)** でその方の画面を新しいタブに開く
(`/api/admin/impersonation-handoff` → `/admin-view/<ctx>/dashboard` → 「報告書を読む」)。

**管理画面に報告書の表示処理を複製しない。** 本番の `/report` をそのまま見るので、
「管理画面では正常に見えたが本番ダッシュボードでは違う」が構造的に起こらない。
未承認の紙面が見えるのは `viewer.isAdmin` のときだけ (§5)。

**URL に uid を載せない** — handoff を使うのは 2026-09-29 の方針どおり。

### 5.3 承認

行の「承認してダッシュボードへ反映」。確認ダイアログを 1 枚出す。
一覧で見た `publish_rev` を `expectedRev` として送り、**その間に再作成が入っていたら 409**
(§9)。409 のときは一覧を読み込み直して、もう一度確認してもらう。

承認 API は **その時点の紙面を組んで指紋を取り、同じ 1 本の update で
`publish_status` / `approved_at` / `approved_by` / `approved_report_hash` を書く** (§3.3)。
`report.sections.*` も紙面を決めるので、**指紋を取る前に `refreshConfig()`** を通す
(一覧・表示経路と同じ app_config を見るため)。

一覧の各行には**指紋の状態**を出す: `公開中` (`match`) /
**`紙面が変わった（非公開）`** (`mismatch`) / 表示なし (`none` = 指紋なし)。
**これが無いと「承認済なのに利用者に出ない」理由を admin が辿れない。**

### 5.4 再作成

`未承認` / `承認済` どちらの一覧でも、行のチェックボックスで選んで
**「選択した報告書を最新版生成処理で再作成」**。

確認ダイアログ:

> 選択した N 件の報告書を、現在の最新版生成処理で再作成します。
> 再作成に成功した報告書は未承認となり、再承認するまでダッシュボードには表示されません。

- **1 件用 API を 1 件ずつ順番に叩く** (§6.3)。並列にしない
- 処理中は重複操作を止める (タブ切替・再読み込み・ボタンとも)
- 終わったら **成功件数 / 失敗件数 / 失敗対象 / 失敗理由**を出す
- **一部失敗しても残りは続ける**。失敗した行には
  「この報告書と承認状態は変更されていません」と添える
- **再作成できない行にはチェックボックスを出さない** (押しても必ず失敗するため)

---

## 6. 1 件再作成の処理

### 6.1 受け取るもの

**`resultId` (`diagnosis_results.id`) だけ。**
S3 キー・受領 JSON 本文・生成パラメータは受け取らない。中継も body を素通ししない。

### 6.2 材料の解決 (サーバ側)

| 行の種類 | 材料 | `source` |
|---|---|---|
| `source_key` が Elith 下りのフォルダ (`output/user/<uuid>/date/<YYYY_MM_DD>/`) | **S3 を読み直す** | `s3` |
| 手動アップロード等 (受領 JSON が DB にある) | DB の控え (取り込み時に 1 バイトも加工していない) | `stored` |
| 完成済み PDF の行 (`manual-pdf-v1` / `manual:transcosmos:`) | **再作成しない** (§6.5) | — |
| 材料が何も無い行 | **再作成しない** | — |

S3 の読み取りは**取り込みと同じ関数**を通す
(`elith-intake.ts` の `groupByFolder()` / `readFolderMaterial()`)。
**新しい S3 探索ルールを作らない。** 読み方が 2 つあると、再作成だけ別の解釈をして静かに食い違う。

「揃った」判定も取り込みと同じ (**ファイル 2 つ以上** かつ `report_text.json` がある)。

**S3 が未設定・読めないときに DB の控えへ黙って落ちない** — 失敗として返す
(「S3 を読み直したつもりで読んでいない」を作らない)。

### 6.3 一括 API は作らない

**1 リクエスト = 1 件。** 一括処理専用 API・長時間ジョブ・キュー・
一括トランザクション・複雑なロールバックを作らない。

### 6.4 処理順 (この順序が要件)

```
対象を引く
→ 承認用の列があることを確認 (無ければ中止)
→ 再作成できる行かを確認 (§6.5)
→ 材料を取り直す
→ 本番と同じ buildReportVM() で生成
→ 生成が最後まで通ったことを確認
→ 【ここで初めて書く】1 本の update で
   上書き + pending + approved_at/approved_by/approved_report_hash を null + rev+1
```

**上書きと `pending` 化は同じ 1 本の update。** 分けると
「紙面だけ入れ替わって承認済のまま」が起こり得る。

### 6.5 失敗したら 1 バイトも変えない

次のどれでも、**報告書と承認状態を一切変更しない**:

| 失敗 | 返す error |
|---|---|
| 対象が無い | `not_found` |
| 承認用の列が無い (migration 未適用) | `migration_required` |
| 完成済み PDF の行 / 材料が無い行 | `not_recreatable` |
| S3 未設定 | `s3_not_configured` |
| 元フォルダが無い | `source_not_found` |
| 元が揃っていない | `source_incomplete` |
| 元を読めない | `source_read_failed` |
| 生成が例外 | `generate_failed` |
| **生成結果が空 (章 0 件 かつ 検査値 0 件)** | `generated_empty` |
| 処理中に別の再作成が入った | `changed_during_recreate` |
| 保存に失敗 | `save_failed` |

**`generated_empty` を成功として扱わない。** 章も検査値も 0 件なら紙面は帯だけになり、
利用者から見れば報告書が消えたのと同じ。**生成途中の不完全なデータで既存報告書を上書きしない。**

### 6.6 完成済み PDF の行を再作成しない理由

トランスコスモス 10 名の行 (`schema_version='manual-pdf-v1'` /
`source_key='manual:transcosmos:…'`) は**組版済み PDF そのもの**を持ち、受領 JSON を持たない
(`report: []`)。ここで再作成を走らせると生成は空になり、
**公開中の PDF が `pending` に落ちて 10 名のダッシュボードから消える。**

判定は `report` の中身ではなく **`schema_version` / `source_key` で明示的に**行う
(「`report` が空だから止まった」に頼ると、将来 `report` に何か入った途端に穴が開く。
退行注入で実証済み)。

### 6.7 連打しても二重にならない

再作成は **UPDATE しかしない**ので、連打でも行は増えない (冪等)。
加えて画面側で行ごとに操作を止め、サーバ側も `publish_rev` 一致を条件に更新する。

---

## 7. Elith 再 RUN 時

新しい受領 JSON が届いたら**既存の受領処理をそのまま使う**。
新しいワークフローは作らない。

```
新しい Elith 受領 JSON → 既存の取り込み (ingestElithReport) → 新しい行 → pending
```

取り込みは `publish_status` を**明示しない**。DB の既定 (`pending`) に任せるので、
取り込み側のコードは 1 行も変えていない。

---

## 8. ユーザー側の表示条件 (サーバ側で approved 限定)

**フロントの表示 / 非表示で実装してはいけない。** CSS・JS で隠す実装は作らない。
以下の**全経路**をサーバ側で絞る。

| 経路 | 絞り方 |
|---|---|
| `loadReportVM()` (紙面の本体) | 紙面を組んだあと **`isPubliclyVisibleRow(row, vm)`** = 承認状態 ＋ **指紋の一致** |
| `loadDashboard()` → `latestResult` | 同じ **`isPubliclyVisibleRow(row)`** で絞る (タイルの可否・受領日・進捗がこれで決まる) |
| `/api/report-route` (完成済み PDF の署名 URL) | **署名を発行する手前**で `isApprovedRow()`。**指紋は見ない** (下記) |
| `coach-context.ts` (AI コーチ) | `isApprovedRow()` のみ (VM を持たない死蔵経路) |
| `chat-context.ts` (AI 問診) | 同 |
| `result-queries.ts` (`/result/[id]` の 3 モード) | 同 |

**承認状態と指紋の合成は `report-approval.ts` の `isPubliclyVisibleRow()` 1 本**。
表示経路が `hashGateOk()` を直接呼ばないことを検査で固定する (判定を 2 つ持たない)。

**`loadReportVM` は組み上がった `vm` をそのまま渡す** — 指紋は閲覧者の文脈に依存しない
(§3.3.1) ので、本人の文脈で組んだ VM の指紋は承認時の指紋と一致する。二度組まない。

**`/api/report-route` が指紋を見ない理由**: トランスコスモス 10 名の紙面は S3 の
組版済み PDF で、生成ロジックを通らない。**照合する対象が無い。**
(再作成も禁止・§6.6。`publish_status` の判定は従来どおり効く。)

**`loadDashboard` でも指紋を見る理由**: `latestResult` が報告書タイルを押せるかどうかを
決めるので、指紋が合わない回に押せるままにすると**押した先が帯だけの紙面**になる
(`reportAvailable` が防いでいるはずの状態)。コストは `approved_report_hash` が
入っている行だけ `buildReportVM` を通す形に抑える (移行した既存行は NULL = コスト 0)。

**未承認を見られるのは管理者だけ** — `report.astro` が `includeUnapproved: viewer.isAdmin`、
`loadDashboard(u, viewer.origin, viewer.isAdmin)` を渡す。既定は false (fail-closed) なので、
引数を渡していない呼び出し (`kit.astro` / `trend.astro` / debug) は承認済だけになる。
外部共有リンク (`viewer.kind === 'share'`) は admin ではないので**承認済しか見えない**。

抽出監査 API (`/api/admin/elith-report/audit`) だけは `includeUnapproved: true`。
**承認する前に「黙って空になっていないか」を確かめるのがその API の仕事**なので、
ここで承認済だけに絞ると承認前の確認ができない。

### 8.1 承認されるまでは「何も出ない」

取り込みは既存行を `superseded` に落としてから新しい行を足すので、
**新しい受領分が届くと、1 つ前の承認済の行は世代落ちしている**。
つまり承認するまで利用者の報告書は**一時的に出ない**。

これは仕様どおり (§3.1「上書き → 未承認 → 再承認まで非表示」)。
**1 件前に遡って古い紙面を出すことはしない** (常に 1 つの最新報告書だけを保持する方針)。

---

## 9. 同時実行・誤操作対策

| 防ぐこと | 手段 |
|---|---|
| 再作成中の同じ報告書を連打 | 画面で行ごとに操作を止める + UPDATE のみ (冪等) |
| **承認と再作成の競合で、再作成後の報告書が `approved` になる** | 承認は `where id=? and publish_status='pending' and publish_rev=?`。一覧で見た rev と違えば **409** |
| 処理中に別の再作成が割り込む | 再作成も `where publish_rev=?` を条件にする → `changed_during_recreate` |
| 生成途中の不完全なデータで上書き | §6.4 の順序 + `generated_empty` |

**バージョン履歴は追加しない。** `publish_rev` は履歴ではなく条件付き更新のためのカウンタ。

---

## 10. 権限

一覧・確認・承認・再作成は**すべて既存の管理者権限をサーバ側で確認する**。新しい認証方式は作らない。

2 層 (既存の `elith-intake` / `special-accounts` と同一):

1. **入口 (admin 判定)** … wellfort-site `verifyAdmin()`。ユーザー自身のアクセストークン +
   anon apikey で `admin_users` を照会 (`is_active=true`)。**service_role は使わない**
2. **上流 (Scan-Chat-AI)** … Bearer `ADMIN_API_KEY` (`api-auth.ts`・キー未設定の本番は拒否)

**鍵はブラウザへ出さない。** 画面は自分のアクセストークンで中継を叩くだけ。

**承認者のメールはブラウザから受け取らない。** 1) で Supabase が検証した値だけを
`triggeredByEmail` として中継が送り、**その名前のまま DB へは入らない** —
上流が `adminIdentity()` の HMAC digest に落としてから `approved_by` へ入れる
(鍵は Scan-Chat-AI 側にしかないので中継では digest を作れない)。
`safeApprovedBy()` は **base64url 43 文字だけ**を通す allow-list。

---

## 11. 実装上の重要原則と、実装していないもの

### 11.1 既存本番報告書生成処理を再利用する
再作成専用の別生成ロジックを作らない。`buildReportVM()` は表示・取込・監査が共用している
唯一の生成本体なので、切り出しも共通化もしていない。

### 11.2 既存の Elith 受領 JSON 特定方法を再利用する
**新しい独自 S3 探索ルールを作らない。** S3 の読み取りは取り込みと同じ
`groupByFolder()` / `readFolderMaterial()` を通す (そのために `elith-intake.ts` から
読み取りループを**挙動を変えずに**関数へ切り出した。これが今回した唯一の共通化)。
手動アップロードの行は、取り込み時に 1 バイトも加工せず入れてある DB の控えが
「その報告書に対応する受領 JSON」そのもの。

### 11.3 報告書は上書きする
バージョンテーブル・履歴レコードを作らない。再作成は UPDATE だけで行い、行は増えない。

### 11.4 失敗時は現状維持
正常な新報告書が完成するまで既存報告書を変更しない (§6.4 / §6.5)。

### 11.5 既存公開済報告書を導入時に消さない
既存データは `approved` 相当として移行する (§4)。

### 11.6 一括処理専用バックエンドを作らない
1 件用再作成 API を管理画面から順番に呼ぶ (§6.3)。

### 11.7 無関係なリファクタリングをしない
本機能に必要な最小差分だけ。既存の `status` / 世代管理 / 取り込み / Elith 連携仕様 /
納品 JSON 生成仕様 / S3 のディレクトリ構成は**触っていない**。

### 11.8 実装していないもの (意図的)

- 報告書の revision テーブル / 過去版の保存 / 差分表示 / report hash による履歴管理
- コメント・差戻し理由 / 多段階承認 / 承認ワークフロー
- 専用の「承認済一覧」画面
- S3 オブジェクトの pending/approved フォルダ移動
- 一括再作成の API / ジョブ / キュー
- 報告書内容の手動編集
- `/report` の紙面への「未承認」表示 (§13 の申し送り)

## 12. 検証と受入条件

`npm run verify:report-approval` (A 層・CI の `static-required`)。
**実物を transpile して動かす** — Supabase / S3 / 生成本体だけスタブに差し替えるので
DB も鍵も要らない。

| 章 | 見るもの |
|---|---|
| ① | migration が既存行を未承認にしないこと (列追加 → approved で埋める → 既定 pending の順序) |
| ② | `isApprovedRow()` が列の無い環境を承認済相当にし、知らない値は fail-closed |
| ③ | 再作成できる行の判定 (完成済み PDF を**中身の有無に関係なく**止める) |
| ④ | 承認は `pending` かつ rev 一致のときだけ / 生メールが `approved_by` に入らない |
| ⑤ | 再作成成功 = 上書き + pending + rev+1、**1 本の update**、行が増えない |
| ⑥ | **失敗 9 種で DB を 1 度も書かない**・承認済のまま・中身が残る |
| ⑦ | 一覧は最新世代だけ / migration 未適用を 0 件と混同しない / 氏名を返さない |
| ⑧ | ユーザー向け 6 経路の承認ゲートと、既定が fail-closed であること |
| ⑨ | API の認可 / 受け取るのは resultId だけ / 一括 API が無い / 画面の形 |
| ⑩ | 既存の取り込みを壊していないこと (S3 の読み方が 1 つ) |
| ⑪ | **指紋の性質を本物のアダプタで見る** — 文脈 (氏名・実年齢・第 N 回・`reportType`・`isSample`・当社 CABA) を全部変えても指紋が同じ / 本文を 1 文字変えると変わる / 検査値・章立ての設定でも変わる / 正規化に閲覧者の値が入っていない / `common()` が `selfReported` を渡していない |

**退行注入 15 種とも名指しで落ちることを確認済み。**
うち 2 件はこの注入で穴が見つかり、検査を直してある:

- **注入 4** (完成済み PDF の判定を外す) … `report: []` の方で止まるため素通りした
  → **中身のある PDF 行**で見るように変更
- **注入 10** (署名発行の後ろへ承認チェックを動かす) … 先頭の `import { isApprovedRow }` に
  当たって素通りした → **呼び出しの位置**を見るように変更

その他の実行した検査 (すべて PASS):
`astro check` 0 errors / `astro build` 成功 / A 層 38 本 /
`verify:screen`・`verify:interview-ui`・`verify:scan-pages` (実ブラウザ) /
wellfort-site: `astro build` 成功・verify 10 本。

---

### 12.1 受入条件 (要件定義書 §12)

| # | 条件 | 結果 | 根拠 |
|---|---|---|---|
| 1 | 導入前から存在する公開済み報告書が、導入後もダッシュボードで表示される | PASS | migration 3 段 (§4) ・`verify:report-approval` ① |
| 2 | 導入後に新規生成された報告書は `pending` で、承認前はユーザーに表示されない | PASS | DB 既定 `pending` ・ユーザー側 6 経路 (§8) ・同 ⑧ |
| 3 | 管理者が承認するとダッシュボードで表示される | PASS | `approveReport()` ・同 ④ |
| 4 | 未承認を再作成すると上書きされ `pending` のまま | PASS | `recreateReport()` ・同 ⑤ |
| 5 | 承認済を再作成すると上書き後 `pending` へ戻り、再承認まで非表示 | PASS | 同 ⑤ (approved→pending / approved_* を null) |
| 6 | **承認済の再作成が失敗したら旧報告書と `approved` が完全に維持される** | PASS | §6.4 の順序 ・同 ⑥ (失敗 9 種で書き込み 0 件) |
| 7 | 複数選択で 1 件ずつ処理され、成功したものだけ `pending` になる | PASS | 画面が 1 件用 API を順番に ・同 ⑨ |
| 8 | 一部失敗しても残りは継続し、成功/失敗が分かる | PASS | 画面の集計表示 ・同 ⑨ |
| 9 | Elith の新しい受領 JSON で再生成された報告書は `pending` | PASS | 取り込みは既定に任せる (§7) ・同 ⑩ |
| 10 | 一般ユーザーは `pending` を API / URL 直接アクセスでも取得できない | PASS | §8 の 6 経路 (署名 URL も発行前に停止) ・同 ⑧ |
| 11 | 管理者以外は一覧・確認・承認・再作成を実行できない | PASS | 2 層認可 (§10) ・同 ⑨ |
| 12 | 管理者の確認表示はユーザーと同じ報告書データ / 表示処理を使う | PASS | 代理表示で本番 `/report` を開く (§5.2) |
| 13 | 通常の再作成で複製・バージョン履歴が増えない | PASS | UPDATE のみ ・同 ⑤ (行数不変・insert 0 回) |
| 14 | 再作成と承認が競合しても、新報告書が自動的に承認済になる事故がない | PASS | `publish_rev` 条件付き更新 (§9) ・同 ④ |
| **15** | **承認後に生成ロジックを直してデプロイしても、承認した紙面と違うものは公開されない** | PASS | `approved_report_hash` (§3.3) ・同 ④/⑪ |

**この環境で確認できていないこと**: 実 DB への migration 適用後の挙動・S3 からの実再取得・
署名 URL の実挙動・admin 画面の実ブラウザ操作 (Supabase / S3 / 鍵がこの作業環境に無い)。
**本番で 1 回通すのが完了条件** (§13-4)。

## 13. 申し送り (人の判断が要る)

### 13.1 【必須】本番反映の順序

**必ずこの順で入れる。** 手順の正本は
`docs/operations/AI疾病予防報告書_承認機能_本番反映手順.md`。

```
① DB migration   20261007000010_diagnosis_report_approval.sql
                 20261007000020_diagnosis_report_approval_hash.sql
② Scan-Chat-AI   (API と承認ゲート)
③ wellfort-site  (管理画面)
```

**なぜ DB が先か。** アプリ側は列が無い環境を **fail-open** で扱う (§4.1・§3.3.5) ——
既存の公開中の報告書を落とさないための保険だが、**承認ゲートとしては穴になる**。

> **migration 適用前に新規の Elith 取込が発生すると、その報告書は承認ゲートを
> 通らずユーザーへ公開され得る。**
>
> `publish_status` 列が無い間、取り込みは列を書けないので新しい行の
> `publish_status` は存在しない。`isApprovedRow()` は「列なし = 承認済相当」と
> 判定するので、**管理者が一度も確認していない報告書がそのまま出る**。
> 取り込みは毎日 9:00 JST の cron (`/api/cron/elith-intake`) で自動で走るため、
> **適用を翌日へ持ち越さない**。

`approved_report_hash` だけが無い状態 (① の 1 本目だけ適用) では、
未承認/承認済のゲートは効くが**指紋の照合が効かない** (指紋なし扱い)。
この状態では承認 API が `migration_required` で止まるので、承認操作はできない。

**②→③ の順**: 管理画面 (③) は Scan-Chat-AI の API (②) を叩くだけなので、
逆順だと画面だけ出て API が 404 になる。

### 13.2 残っている確認事項

1. **migration の適用が必要 (2 本)** — `20261007000010_diagnosis_report_approval.sql` と
   `20261007000020_diagnosis_report_approval_hash.sql`。
   **アプリより先に DB へ適用する** (§13.1。後方互換な列追加なので先に当てて問題ない)。
   未適用のままアプリが出ても公開中の報告書は消えないが、**承認・再作成はできない**
   (一覧に「未適用」と出る) し、**その間の新規取込は承認ゲートを通らず公開され得る**。
2. **「確認」は代理表示のダッシュボードに着地する** — handoff の着地先は
   `/admin-view/<ctx>/dashboard` 固定なので、紙面までは**タブ内で 1 クリック**が要る。
   報告書へ直接着地させるには handoff に行き先を持たせる改修が必要で、
   それは代理表示の仕組み (`verify:admin-handoff` が守っている領域) に手を入れることになるため、
   今回はしていない。
3. **紙面そのものに「未承認」と出していない** — 管理者が見ているのが未承認かどうかは
   **管理一覧の状態**で判別する。`/report` の紙面に当社の文言を足すと
   `verify:report-verbatim` (受領 JSON に無い文言を紙面に出さない検査) の対象になるため、
   紙面は 1 文字も変えていない。必要なら「操作の語」として `ALLOW` に理由つきで足す判断が要る。
4. **本番での通し確認が要る** — この作業環境には Supabase も S3 も鍵も無いので、
   実際の承認・S3 からの再取得・署名 URL の挙動は未確認。検証はすべて決定論部とスタブ。
5. **既存の `status='published'` を読む 4 経路は死蔵のまま** — 実データでは一度も立たないので
   承認ゲートだけ足し、`status` の設計自体は触っていない。
   `/result/[id]` の 3 モード (決裁台帳 D-19) の扱いは別途判断。
