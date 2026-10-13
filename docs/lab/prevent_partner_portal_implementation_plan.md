# プリベント Partner Portal 実装手順書

| 項目 | 内容 |
|---|---|
| 版 | **v0.1（2026-10-13・新規作成）。この文書の時点で実装は 0 行・migration は 0 本** |
| 仕様の正本 | `docs/lab/prevent_partner_portal_spec.md`（**先にこれを読む**） |
| 位置づけ | **仕様書ではなく、後日 Claude Code が実装するための手順書**。Step 0〜12 |
| 大原則 | **プリベント専用の Portal 基盤を作らない。** LAiF Partner Portal を流用し、**差分だけ**を足す |
| 凡例 | **[LAiF流用]** / **[Prevent差分]** / **[既存実装あり]** / **[新規実装必要]** / **[未確定]** |

### 正本の優先順位

**プリベント Partner Portal については `docs/lab/prevent_partner_portal_spec.md` を今回の正本とする。**
既存 4 仕様書（`docs/architecture/id_management_and_correlation_spec.md` /
`docs/lab/lab_data_reception_overview.md` / `docs/lab/lab_data_pipeline_master_spec.md` /
`docs/lab/kit_receipt_external_id_capture_spec.md`）の **Prevent 節に矛盾が残っている間は、
本仕様書を優先する**（例: 「プリベント＝会員ID／Wellfort 採番の仮名ID」は**古い**。
正は**先方発行のバーコードNo.**）。
→ 既存 4 仕様書側の記述（仕様書 §17.1 の **R-1〜R-4**）は、
**別の小さな docs 整合タスク**で修正する。**本手順書の Step では直さない。**

> **着手条件**: 仕様書 `prevent_partner_portal_spec.md` が**発注者確認を通ってから**。
> **Step 4 / 5 / 7 / 9 / 12 は仕様書 §17 の未確定事項が解けるまで着手できない。
> Step 6 は「API / UI の骨格、または準備中表示」までで止める**（実データの配布を開かない）。
> 各 Step の「完了条件」に明記した。**推測で埋めて進めない。**

---

## Step 0. 基準 commit と変更範囲の確認

| | |
|---|---|
| **目的** | 「どこから分岐したか」「どのファイルに触る権利があるか」を先に固定する。過去に**デプロイ元ブランチの食い違い**で巻き戻し事故が起きているため（ルート `CLAUDE.md`「デプロイ元ブランチ」） |
| **既存流用コード** | なし（調査のみ） |
| **変更対象ファイル** | なし |
| **新規ファイル** | なし |
| **DB 変更有無** | **なし** |
| **migration 有無** | **なし** |
| **API 変更** | なし |
| **UI 変更** | なし |
| **テスト方法** | `git rev-parse --is-shallow-repository` が `false` であること（`true` なら `--unshallow`。shallow のまま差分を測ると ahead/behind が狂う）／`git fetch origin && git log --oneline -1 origin/claude/awesome-carson-UeyUZ`（Scan-Chat-AI）と `origin/main`（wellfort-site）／`git diff --name-status <base>...HEAD` が空 |
| **完了条件** | 両リポジトリで **基準ブランチの先頭 SHA をメモに残した**。作業ブランチを**その先頭から新規に切った**（過去の `claude/*` / `feature/*` / `fix/*` を掘り起こさない） |
| **rollback 方法** | 不要（読み取りのみ） |

**基準ブランチ（2026-10-13 時点）**

| repo | 基準 | 根拠 |
|---|---|---|
| Scan-Chat-AI | `claude/awesome-carson-UeyUZ` | 既定ブランチ（`main` は存在しない） |
| wellfort-site | **`main`** | **`wellfort-site/CLAUDE.md`「Git 運用（必須）」1**：新規タスクは**必ず最新 `origin/main` から開始**する |

```bash
# wellfort-site
git fetch origin && git switch main && git pull --ff-only origin main && git switch -c <type>/<task>
```

---

## Step 1. LAiF 再利用箇所の確定 — **[LAiF流用][既存実装あり]**

| | |
|---|---|
| **目的** | 「触らない」と決めたファイルを先に名指しし、以降の Step で**誤って触っていないこと**を機械で言えるようにする |
| **既存流用コード** | wellfort-site `src/lib/partner-auth.ts`（パスキー・セッション・`requirePartner`・`logEvent`）／`src/pages/api/partner/auth/[action].ts`（5 action）／`src/pages/api/partner/upload.ts`（下りの中継）／`src/pages/partner-portal-preview.astro`（5 画面）<br>Scan-Chat-AI `src/lib/laif-portal.ts`（ticket / list / revoke / download・`normalizePartner()` は **`prevent` を既に受ける**）／`src/pages/api/partner/laif-upload.ts` |
| **変更対象ファイル** | **なし（この Step では 1 行も変えない）** |
| **新規ファイル** | なし |
| **DB 変更有無** | なし |
| **migration 有無** | なし |
| **API 変更** | なし |
| **UI 変更** | なし |
| **テスト方法** | 既存の回帰を**先に 1 回通して緑を記録**する：Scan-Chat-AI `npm run verify:external-id-capture` ／ `npx astro check` ／ wellfort-site `npx astro build`（**`@astrojs/check` は未インストール。依頼外の依存追加になるので足さない**） |
| **完了条件** | 上記が緑。**「LAiF の挙動は 1 行も変えない」対象ファイル一覧を手順書（この表）に固定した** |
| **rollback 方法** | 不要 |

**この Step の成果物 = 不変リスト。** 以降の Step で
`git diff --name-status <base>...HEAD` に上記 6 ファイルのうち
**`partner-portal-preview.astro` 以外**が出たら**その時点で止める**
（`partner-portal-preview.astro` だけは Step 2・6・7 で触る）。

---

## Step 2. プリベント partner 設定の追加 — **[Prevent差分]**

| | |
|---|---|
| **目的** | Portal の表示を**バーコードNo. 前提**に直す。`WF-CANCER-` などの**Wellfort 独自整理番号を画面から消す** |
| **既存流用コード** | `partner-portal-preview.astro:192-221` の `PARTNERS` 設定オブジェクト（`laif` / `prevent` の 2 ブロック。`?partner=` で切替：`:222-223`） |
| **変更対象ファイル** | wellfort-site `src/pages/partner-portal-preview.astro`（**`prevent:` ブロックの中だけ**。`laif:` ブロック `:193-209` は 1 文字も触らない） |
| **新規ファイル** | なし |
| **DB 変更有無** | **なし** |
| **migration 有無** | **なし** |
| **API 変更** | なし |
| **UI 変更** | **あり**（`?partner=prevent` のときの ID ラベル・一覧の見出し・説明文） |
| **テスト方法** | wellfort-site に**新規 verify スクリプト**（Step 11）で ①`prevent` ブロックに `WF-CANCER-` / `idPrefix` / `整理番号（ID）` が**識別子として**出ないこと ②`laif` ブロックの `W026` / `識別番号（ID）` / `sampleFile` / `sampleName` / `itemCount:'約158項目'` が**そのまま在ること**を固定。**スライスは `laif: {` から `prevent: {` まで**（`},` で切ると早く終わる）。**コメントを落としてから検査する**（自分のコメントに当たる） |
| **完了条件** | `?partner=laif` の DOM が**変更前とバイト単位で同じ**（実ブラウザで比較）。`?partner=prevent` の ID ラベルが**バーコードNo.** になっている |
| **rollback 方法** | この Step の commit を `git revert`（1 ファイル・設定値のみなので単独で戻せる） |

**注意**: 「整理番号は使用しません」のような**利用者向けの説明文は残してよい**。
禁じるのは**識別子としての使用**（`idPrefix` / `idLabel` に入れること）。
検査は**識別子の用途だけ**を見るように書く（文章まで一律禁止にすると正しい説明文で落ちる）。

---

## Step 3. バーコードNo. 取得経路の確認 — **[既存実装あり]**

| | |
|---|---|
| **目的** | CSV の 3 値（**画面の表示 / CSV 内の ID / ファイル名**）を**1 つのサーバ側確定値**から派生させる。その確定値をどこから引くかを**既存コードで**固定する |
| **既存流用コード** | Scan-Chat-AI `src/lib/external-id-persist.ts:428` `loadCapturedExternalId({ sb, diagnosticUserId, provider, shipmentRef \| labTestId })`（**`shipmentRef` か `labTestId` が必須**。`:433` のコメントどおり「人だけ」では引かない＝前年のレコードが混ざるため。有効行が 2 件見えたら `null`：`:451`）<br>`src/lib/external-test-id.ts:365` `checkPreventQuestionnaireGate()`（**3 条件 fail-closed**：`status='confirmed'` ∧ `lab_test_link_status='linked'` ∧ `lab_test_id` 非 null） |
| **変更対象ファイル** | **なし（調査のみ）** |
| **新規ファイル** | なし |
| **DB 変更有無** | **なし**（`customer.lab_test_id_captures` は `20261011000010` で既に在る） |
| **migration 有無** | **なし** |
| **API 変更** | なし |
| **UI 変更** | なし |
| **テスト方法** | 既存 `npm run verify:external-id-capture`（324 件）が緑。追加で**この Step では何も書かない** |
| **完了条件** | 次の 3 点を**実コードで確認して手順書に追記した**：①一覧の供給元は **`customer.lab_test_id_captures`**（`provider='prevent'` ∧ `status='confirmed'` ∧ `lab_test_link_status='linked'` ∧ `lab_test_id is not null`）②その行が `shipment_ref` と `lab_test_id` を**自分で持っている**ので、**新しい cross-system ID を作らずに** `loadCapturedExternalId` を呼べる ③`normalized_value` が唯一の確定値 |
| **rollback 方法** | 不要 |

> **ここが「新しい基盤を作らない」の要**。
> **バーコードNo. → 対象ユーザー／検査の特定、および Portal 一覧の「候補」の取得には、
> 既存 `customer.lab_test_id_captures` で足りる**（台帳行 1 件がその回・その検査の撮影結果で、
> `shipment_ref` と `lab_test_id` を自分で持っているため）。
>
> **ただし「問診と検査の相関」は現在未解決**（Step 4 / 仕様書 §17 の #1）。
> **その解決方式は本仕様では決めない。**
> そして **`test_instance_ref` 等を今回の Portal 実装の前提条件にはしない**
> （解決方式が決まる前でも Step 0〜3・6 骨格・8・10・11 は進められる、という意味）。
> → この Step で新しいテーブル・新しい cross-system ID を**作らない**（仕様書 §19）。

---

## Step 4. 問診データの取得 — **[未確定・着手不可]**

| | |
|---|---|
| **目的** | 「**その検査の**問診 1 件」を特定する |
| **既存流用コード** | Scan-Chat-AI `src/pages/api/interview/export.ts`（S3 へ `LifestyleQuestionnaireData_date_{YYYY_MM_DD}_user_{client_id}.json` を書く）／`supabase/migrations/20260915000010_interview_completions.sql`（完了日時と設問数だけ） |
| **変更対象ファイル** | **未定（着手しない）** |
| **新規ファイル** | **なし（作らない）** |
| **DB 変更有無** | **不明＝判断待ち。この手順書では「なし」で固定する** |
| **migration 有無** | **なし（この一連の作業では作らない）** |
| **API 変更** | なし |
| **UI 変更** | なし |
| **テスト方法** | — |
| **完了条件** | **発注者判断（仕様書 §17 の #1）が出てから書き直す。** それまでは「特定できない」＝**fail-closed（一覧に出さない）** が正しい挙動 |
| **rollback 方法** | — |

**禁止事項（この Step で特に）**:
- **日時近似・「その人の最新」で問診を選ばない**（`loadLatestInterview(uid)` 相当を作らない）。
  `interview_completions` に検査への参照は **0 件**（`grep 'lab_test\|shipment'` = 0）、
  S3 のキーも「人と日付」だけなので、**現在の DB では特定できない**。
- **特定できないことを「空の CSV を出す」で回避しない**（捏造ゼロ）。

---

## Step 5. PREVENT 指定 CSV への変換 — **[未確定・着手不可]**

| | |
|---|---|
| **目的** | 問診回答を**先方指定の CSV 様式**へ落とす |
| **既存流用コード** | 変換の規律の前例＝Scan-Chat-AI `src/lib/elith-blood-csv.ts`（文字コード・改行・空欄の扱いを**1 モジュールに集約**する流儀）／`docs/lab/questionnaire_to_lab_csv_spec.md`（共通設問No → 各社行の写像表） |
| **変更対象ファイル** | **未定（着手しない）** |
| **新規ファイル** | **未定**（想定＝`src/lib/prevent-questionnaire-csv.ts` 1 本。**変換規則はこの 1 ファイルが所有**） |
| **DB 変更有無** | **なし** |
| **migration 有無** | **なし** |
| **API 変更** | なし |
| **UI 変更** | なし |
| **テスト方法** | 先方様式を正とした fixture 比較（`scripts/prevent-csv-fixtures/expected_<バーコードNo.>.csv` と**バイト単位**で一致） |
| **完了条件** | **仕様書 §13 の 10 項目（列数・ヘッダ・ヘッダ行数・項目順・値形式・選択肢・日付形式・文字コード・改行コード・空欄表現）が確定してから着手。** 1 つでも未確認なら着手しない |
| **rollback 方法** | — |

**禁止事項**: **CSV 仕様を推測しない。** 本番の設問文をヘッダへ流用しない
（「様式未確定」と書きながら production の設問文を本番 CSV に出すのは矛盾。過去に指摘を受けた）。

---

## Step 6. Portal の一覧表示 — **[Prevent差分][新規実装必要・骨格まで]**

> **現時点では「DL 可能な実一覧」を公開できない。**
> Step 4 で「**その検査の**問診」を**一意に特定**できるようになるまで、この Step は
> **API / UI の骨格、または「準備中」表示まで**とする。
> **台帳に `confirmed` / `linked` の行があるだけで「取得可能」として表示しない。**

**公開一覧の成立条件（5 つすべて）**

| # | 条件 | 現状 |
|---|---|---|
| 1 | barcode が `confirmed` | **判定可**（台帳 `status`） |
| 2 | `lab_test` が `linked` | **判定可**（台帳 `lab_test_link_status`） |
| 3 | `lab_test_id` あり | **判定可**（台帳 `lab_test_id`） |
| 4 | **対応する問診が一意に特定済み** | **不可**（Step 4 / 仕様書 §17 #1 が未解決） |
| 5 | **CSV 様式が確定済み** | **不可**（Step 5 / 仕様書 §13 が未確認） |

→ **1〜3 だけ満たした行は「公開一覧に出せる行」ではない。**
既存 `checkPreventQuestionnaireGate()` が見るのは 1〜3 なので、
**ゲートを通ったこと＝配布可、ではない**（4・5 を別に満たす必要がある）。

| | |
|---|---|
| **目的** | 画面の**ダミー一覧**を撤去し、**サーバが返す一覧に置き換えられる骨格**を作る。**実データの配布は開かない**（4・5 が未達のため「準備中」を表示する） |
| **既存流用コード** | 中継の型＝wellfort-site `src/pages/api/partner/upload.ts`（**`SCAN_CHAT_AI_API_KEY` をサーバ側だけで使い、`requirePartner` で partner を session から取り、body の `partner` を信用しない**：`:53-60`）／画面側の `show()` / `scr-csv` 画面（`partner-portal-preview.astro:150`） |
| **変更対象ファイル** | wellfort-site `src/pages/partner-portal-preview.astro:401-423`（**ダミー一覧 `var ids = [C.idPrefix + '000123', …]` と、クライアント側 Blob 生成を撤去**。`laif` は `sampleFile` 経路のまま＝**分岐で守る**） |
| **新規ファイル** | wellfort-site `src/pages/api/partner/questionnaire.ts`（中継）／Scan-Chat-AI `src/pages/api/partner/prevent-questionnaire.ts`（一覧 + DL） |
| **DB 変更有無** | **なし**（読むのは既存 `customer.lab_test_id_captures`） |
| **migration 有無** | **なし** |
| **API 変更** | **新規 2 本**（`mode: 'list'`）。**既存 `api/partner/upload.ts` の `ALLOWED_MODES` は広げない** |
| **UI 変更** | **あり**（`?partner=prevent` のみ。**一覧は「準備中」表示**。`?partner=laif` の画面は不変） |
| **テスト方法** | Step 11 の verify で ①中継が `Authorization` を**サーバ側で**付けていること ②`requirePartner` を通っていること ③body の `partner` を使っていないこと ④**ゲート（`checkPreventQuestionnaireGate`）が wellfort-site 側にコピーされていないこと**（grep で 0 件）⑤**`list` が 4・5 を満たさない行を返さないこと**（台帳に `confirmed`/`linked` 行を置いた fixture で **0 行**になる） |
| **完了条件** | `?partner=prevent` の一覧が **「準備中」** で、**DL できる行が 1 件も出ない**。ダミー ID（`WF-CANCER-000123` 等）も出ない。`?partner=laif` の一覧が**従来どおり**（ダミー 3 件 + 静的 xlsx）。**「実データの一覧を公開する」のは Step 4・5 の判断が出てから**（この Step の完了条件ではない） |
| **rollback 方法** | 新規 2 ファイルを削除し、`partner-portal-preview.astro` の該当 commit を `git revert`。**DB も S3 も触っていないので戻すだけで完全に元へ戻る** |

**採用する構成（Step 6・7 共通・実装前に発注者へ報告する）**:

```
プリベントのブラウザ（パスキー session のみ）
  → wellfort-site /api/partner/questionnaire     ← requirePartner でゲート・Bearer をここで付ける
  → Scan-Chat-AI  /api/partner/prevent-questionnaire  ← isAdminAuthorized・台帳照会・ゲート判定・CSV 生成
```

- **既存 `upload.ts` に mode を足す案も検討した**が、あちらは**結果PDF（下り）専用**で
  `contentType`/`bytes` の検査が前提になっているため、CSV の list/download を混ぜると
  **既存の検査を緩める**ことになる。→ **別ファイルにする**（LAiF の挙動を 1 行も変えない方を採る）。
- **ゲートは Scan-Chat-AI 側だけに置く**。wellfort-site は**認証（誰か）**だけを見る。
  **二重実装すると片方だけ直って黙って通る**。

---

## Step 7. CSV のダウンロード — **[Prevent差分][新規実装必要・§13 待ち]**

| | |
|---|---|
| **目的** | 一覧の「取得」で**顧客別 CSV 1 件**を落とす |
| **既存流用コード** | Step 6 と同じ 2 本（`mode: 'download'` を足す）／ファイル名のサニタイズの前例＝Scan-Chat-AI `src/lib/laif-portal.ts:105` `sanitizeFilename` |
| **変更対象ファイル** | Step 6 で作った 2 本 ＋ `partner-portal-preview.astro` の「取得」ハンドラ |
| **新規ファイル** | なし（Step 5 の `prevent-questionnaire-csv.ts` を使う） |
| **DB 変更有無** | **なし** |
| **migration 有無** | **なし** |
| **API 変更** | **あり**（`mode: 'download'` 追加） |
| **UI 変更** | あり（`prevent` のみ） |
| **テスト方法** | ①**3 値が同一の確定値から派生している**こと（一覧の表示 / CSV 内の ID / ファイル名 `<バーコードNo.>.csv`）を 1 つの fixture で突き合わせ ②`Content-Disposition` の filename に**サーバの確定値しか入らない**（クライアント申告を使わない）③**URL に内部ID（`diagnostic_user_id` / `lab_tests.id` / UUID）を出さない** |
| **完了条件** | **§13 の 10 項目が確定してから。** 確定前は **list に出さない（0 行）** のが正しい状態 |
| **rollback 方法** | commit を `git revert`。**S3 へは何も置かない**（CSV は生成して返すだけ・保存しない）ので残骸が出ない |

**禁止事項**: **DL 後削除の仕様を新設しない**（LAiF に前例が無い。消す/残すは判断待ち）。

---

## Step 8. 結果PDF のアップロード — **[LAiF流用][既存実装あり・変更なし]**

| | |
|---|---|
| **目的** | プリベントが結果PDF を提出できる。**これは既に動いている** |
| **既存流用コード** | wellfort-site `api/partner/upload.ts`（`mode:'ticket'`・`MAX_MB=50`・`ACCEPTED='application/pdf'`）→ Scan-Chat-AI `api/partner/laif-upload.ts:52`（ticket）→ `laif-portal.ts:149` `createUploadTicket`（Presigned PUT・`quarantine/{partner}/`・`PRESIGN_EXPIRES_SEC=900`）。`normalizePartner()` が **`prevent` を既に受ける**（`laif-portal.ts:95`） |
| **変更対象ファイル** | **なし（1 行も変えない）** |
| **新規ファイル** | なし |
| **DB 変更有無** | なし |
| **migration 有無** | なし |
| **API 変更** | **なし** |
| **UI 変更** | **なし**（`scr-pdf` 画面は partner 共通） |
| **テスト方法** | Step 11 の verify で「`upload.ts` / `laif-upload.ts` / `laif-portal.ts` が `git diff` に出ない」ことを固定。実挙動は**本番の鍵が要る**ので別途（この環境に S3 鍵は無い） |
| **完了条件** | **差分 0**。プリベントの提出は**設定なしで既に通る**ことを確認して記録 |
| **rollback 方法** | 不要（変更しない） |

---

## Step 9. 結果PDF と バーコードNo. の突合 — **[未確定・着手不可]**

| | |
|---|---|
| **目的** | 受け取った結果PDF を**どの検査の結果か**に結ぶ |
| **既存流用コード** | `laif-portal.ts:268` `listUploads` / `:219` `isQuarantineKey`（キーは `quarantine/{partner}/{日付}/{sanitize 済みファイル名}`。**検査ID は入らない**） |
| **変更対象ファイル** | **未定（着手しない）** |
| **新規ファイル** | **なし** |
| **DB 変更有無** | **なし** |
| **migration 有無** | **なし** |
| **API 変更** | なし |
| **UI 変更** | なし |
| **テスト方法** | — |
| **完了条件** | **発注者判断（仕様書 §17 の #2）。LAiF でも未実装なので前例が無い** |
| **rollback 方法** | — |

**禁止事項**: **ファイル名からの推測で bind を実装しない**（先方のファイル名規則は未確定）。

---

## Step 10. 監査ログ — **[LAiF流用][既存実装あり]**

> **CSV の DL 自体を監査ログへ残すかは未確定**（仕様書 §17 の #6。LAiF は静的 DL でログが無く
> 前例が無い）。→ **発注者判断が出るまで、DL のログは実装しない。**
> この Step で入れるのは **認証・認可の既存イベント（`gate_deny` 等）を新しい口でも同じ書式で残すこと**だけ。

| | |
|---|---|
| **目的** | 新しい口でも**認証・認可の既存イベント**が従来と同じ書式で残るようにする |
| **既存流用コード** | wellfort-site `src/lib/partner-auth.ts:100` `logEvent({ partner, partnerUserId, credentialId, event, detail, request })` → `partner_auth_events` へ insert（**ip は `x-forwarded-for` の先頭**・`user_agent` は 300 字で切る・**失敗しても認証を落とさない**：`:122-124`） |
| **変更対象ファイル** | wellfort-site `src/pages/api/partner/questionnaire.ts`（Step 6 の新規ファイル内で `logEvent` を呼ぶだけ） |
| **新規ファイル** | なし |
| **DB 変更有無** | **なし**（`partner_auth_events` は既存） |
| **migration 有無** | **なし** |
| **API 変更** | なし（既存 API の中で呼ぶ） |
| **UI 変更** | なし |
| **テスト方法** | verify で ①`gate_deny` が**既存と同じ書式**で残ること ②`detail` に**バーコードNo. の全文を入れていない**こと（`maskExternalId` 相当か、件数だけ）③PII（氏名・メール）を入れていないこと ④**DL のイベントを記録していないこと**（§17 #6 の判断待ちなので、先に入れない） |
| **完了条件** | 既存のイベント名の体系に**並ぶ名前**で、**認証・認可のイベントだけ**が記録されている。**新しいログ基盤を作っていない**。**DL ログは未実装**（判断待ち） |
| **rollback 方法** | commit を `git revert`（ログ行が増えなくなるだけで、既存ログは残る） |

**未確定（この Step では実装しない）**: **CSV の DL 自体をログに残すか** = 仕様書 §17 の #6。
残すと決まったら、イベント名と `detail` の粒度（**全文を入れない**）を合わせて別 commit で足す。

---

## Step 11. テスト

| | |
|---|---|
| **目的** | **LAiF の不変**と**プリベント差分の正しさ**の両方を、機械で落とせるようにする |
| **既存流用コード** | Scan-Chat-AI `scripts/verify-external-id-capture.mjs`（324 件・コメントを落として検査する `code()` の流儀）／`.github/workflows/ci.yml` の **A 層（`static-required`）** |
| **変更対象ファイル** | Scan-Chat-AI `package.json`（`verify:prevent-portal` を 1 本追加）／`.github/workflows/ci.yml`（A 層へ 1 行追加）／wellfort-site `package.json`（同） |
| **新規ファイル** | Scan-Chat-AI `scripts/verify-prevent-questionnaire.mjs`／wellfort-site `scripts/verify-prevent-portal.mjs` |
| **DB 変更有無** | **なし** |
| **migration 有無** | **なし** |
| **API 変更** | なし |
| **UI 変更** | なし |
| **テスト方法** | **退行注入**で**名指しで落ちる**ことを確認する（下記 12 種を最低ライン） |
| **完了条件** | 12 種とも**名指しで**落ちる。既存 `verify:external-id-capture` 324 件・`astro check` 0 errors・wellfort-site `astro build` 成功 |
| **rollback 方法** | commit を `git revert`（検査が消えるだけ。プロダクトコードは動く） |

**退行注入（最低 12 種）**

| # | 壊し方 | 落ちるべき検査 |
|---|---|---|
| 1 | `prevent` ブロックに `idPrefix: 'WF-CANCER-'` を戻す | Step 2 |
| 2 | `laif` ブロックの `W026` / `識別番号（ID）` を変える | Step 2（LAiF 不変） |
| 3 | `laif` の `sampleFile` / `sampleName` を消す | Step 2（LAiF 不変） |
| 4 | 中継で `requirePartner` を外す | Step 6 |
| 5 | 中継が body の `partner` を使う | Step 6 |
| 6 | `Authorization` をクライアントから受け取る形にする | Step 6 |
| 7 | `checkPreventQuestionnaireGate` を wellfort-site へコピーする | Step 6（二重実装禁止） |
| 8 | ゲートの 3 条件を 2 条件に緩める | Step 3 |
| 9 | 問診を「その人の最新」で引く（`shipmentRef`/`labTestId` なしで台帳を引く） | Step 4（**最重要**） |
| 10 | ファイル名をクライアント申告から作る | Step 7 |
| 11 | URL / `Content-Disposition` に `diagnostic_user_id` を出す | Step 7 |
| 12 | §13 未確定のまま list に行を出す | Step 7（**配布の封印**） |

**検査スクリプトを書くときの既知の罠**（過去に全部踏んだ）:
- **自分のコメントに当たる** → `code()` でコメントを落としてから検査する。
- **ブロックのスライスを `},` で切ると早く終わる** → `laif: {` から `prevent: {` まで切る。
- **型定義の中の文字列も数えてしまう** → export された配列・定数を数える。
- **スクリプトを分割したとき認可の検査が落ちる** → 分割後に**退行注入を全部やり直す**。
- **一律禁止ワードは正しい文章で落ちる** → 用途（`idLabel:` など）に限定する。

---

## Step 12. 本番有効化 — **[未確定]**

| | |
|---|---|
| **目的** | プリベントに実際に配布を始める |
| **既存流用コード** | `src/lib/app-config.ts` の `CONFIG_SPECS`（`labid.prevent_capture:194` / `labid.demecal_capture:199` は**既定 off**） |
| **変更対象ファイル** | **なし（コード変更なしで on にできる形にする）** |
| **新規ファイル** | なし |
| **DB 変更有無** | `diagnosis.app_config` の**値**（行の upsert。**DDL ではない**） |
| **migration 有無** | **なし** |
| **API 変更** | なし |
| **UI 変更** | なし |
| **テスト方法** | 本番で ①`?partner=prevent` にパスキーでログインできる ②一覧が台帳どおり ③1 件 DL して先方様式と一致 ④結果PDF を 1 本提出できる（**鍵と S3 が要るのでこの環境では不可**） |
| **完了条件** | **仕様書 §17 の #3（配布の止め方）が決まってから。** `labid.prevent_capture` / `labid.demecal_capture` の**既定 off は変えない**（コード既定は off のまま・運用で on にする） |
| **rollback 方法** | **app_config の値を戻すだけ**（TTL 45 秒で反映・再デプロイ不要）。コード側の rollback は Step 6/7/10/11 の `git revert` |

**禁止事項**: **根拠なく feature flag を増やさない。**
配布の停止手段が必要だと判断されたら、**そのとき 1 本だけ足す**（§17 #3 の判断を待つ）。

---

## 付録 A. この手順書で**作らないもの**（仕様書 §19 の再掲）

1. **新規 DB テーブル**（`interview_test_links` / `customer.test_instances` …）
2. **新規 cross-system ID**（`test_instance_ref` を**前提条件にしない**）
3. **新規認証方式**／**別の Portal**／**LAiF と別の S3 授受方式**
4. **新しい lab lifecycle**
5. **migration**（この一連の作業では 1 本も作らない）
6. **CSV 仕様の推測**
7. **日時近似での問診選択**
8. **「将来必要そう」での基盤追加**

## 付録 B. 着手順と依存

```
Step 0 → 1 → 2 → 3 ─┬→ 6（骨格／準備中まで）─→ 7 ─→ 12
                     ├→ 10（認証・認可ログのみ。DL ログは判断待ち）
                     └→ 11（2・3・6・10 の都度追加）
Step 4 / 5 / 9 … 発注者判断待ち（着手不可）
Step 6 の「実一覧の公開」/ Step 7 / Step 12 … Step 4（問診の一意特定）と Step 5（CSV 様式）の
                                              両方が解けてから
Step 8 … 変更なし（確認だけ）
```

**いま着手できるのは Step 0〜3・6 の骨格・8・10（認証ログのみ）・11 まで。**
**実際にプリベントへ CSV が渡るのは Step 4・5 が解け、Step 12 の判断が出てから。**
→ **「Portal の口は先に通せるが、一覧は準備中のままで、中身（CSV）は配れない」**のが現状の正しい姿。
