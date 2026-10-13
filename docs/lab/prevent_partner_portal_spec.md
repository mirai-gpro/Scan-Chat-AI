# プリベント Partner Portal 仕様書（LAiF 実装の流用を前提とした新規正本）

| 項目 | 内容 |
|---|---|
| 版 | **v0.1（2026-10-13・新規作成）。実装なし・migration なし** |
| 位置づけ | **プリベント（がんリスク検査・尿・ALA-PDS）の Partner Portal の正本候補。** 既存仕様書の修正版ではなくゼロから起こしたもの |
| 大原則 | **プリベント専用の Portal 基盤を作らない。** 実装・テスト済みの **LAiF Partner Portal をそのまま流用**し、プリベント固有部分だけを足す |
| 上位 | `docs/lab/laif_s3_secure_handoff_spec.md`（LAiF 設計の正本）／`docs/lab/lab_data_pipeline_master_spec.md` §4-5 |
| 手順書 | `docs/lab/prevent_partner_portal_implementation_plan.md` |
| 凡例 | **[LAiF流用]** / **[Prevent差分]** / **[既存実装あり]** / **[新規実装必要]** / **[未確定]** |

> **この文書の調査部分（§3・§11・§12）は実コードの実測です。** §13 の CSV 仕様は
> **先方提供資料が手元に無いため「未確定」で止めてあります**（推測で書いていません）。

---

## 0. LAiF との差分表（最初に読む）

| 境界 | LAiF（既存・動いている） | プリベント | 判定 |
|---|---|---|---|
| **Portal 画面** | `partner-portal-preview.astro`（1 ファイルに 5 画面）。`?partner=` で設定を切替 | **同じ画面を使う**。`PARTNERS.prevent` の設定値だけ差し替え | **[LAiF流用]** |
| **認証** | パスキー（WebAuthn 自前実装）。`PARTNERS = ['laif','prevent']` に **prevent は既に含まれている** | **そのまま**。新しい認証方式を作らない | **[LAiF流用][既存実装あり]** |
| **partner 別認可** | `requirePartner(request, want)` が session の partner と突き合わせ、他社領域を 403 | **そのまま** | **[LAiF流用][既存実装あり]** |
| **上り（Wellfort → 先方）の中身** | **LAiF 指定 XLSX**（`input_format_new_202312.xlsx`・約158項目） | **PREVENT 指定 問診CSV** | **[Prevent差分][未確定]**（§13） |
| **上りの配布方式** | 画面の「取得」で**静的ファイルを直 DL**（`/partner-samples/...xlsx`）。**顧客別生成は未実装** | **顧客別 CSV をサーバで生成して渡す** | **[Prevent差分][新規実装必要]** |
| **検査識別 ID** | **Wellfort 整理番号／識別番号**（Wellfort 採番の仮名ID・10桁・`W026…`） | **検査キットに印字された バーコードNo.**（先方発行・現物確認済み `704000`＋3桁） | **[Prevent差分]** |
| **下り（先方 → Wellfort）** | 結果PDF を Presigned PUT でブラウザ → S3 `quarantine/laif/` | **結果PDF**（同じ流儀。prefix が `quarantine/prevent/`） | **[LAiF流用][既存実装あり]** |
| **S3 授受** | `laif-portal.ts`（ticket / list / revoke / download）。**partner はキーの階層**に入るだけ | **そのまま**。`normalizePartner()` が `prevent` を既に受ける | **[LAiF流用][既存実装あり]** |
| **中継** | wellfort-site `api/partner/upload.ts` → Scan-Chat-AI `api/partner/laif-upload.ts` | **下りはそのまま**。上りだけ口が要る | **[LAiF流用]** ＋ **[新規実装必要]**（上り） |
| **結果 → 検査への突合** | **未実装**（キーに検査IDが入らない） | **未実装**（§8） | **[未確定]** |

---

## 1. 目的

1. プリベントが**パスキーで Portal にログイン**し、**顧客別の問診CSV を取得**できるようにする。
2. プリベントが**結果PDF を同じ Portal から提出**できるようにする（**これは既に動いている**）。
3. 先方との往復キーを**検査キットのバーコードNo.** に統一する（Wellfort 独自の整理番号を作らない）。

**[Prevent差分]** は実質 **「上りの中身（CSV）」と「上りの配布」の 2 点だけ**。
認証・画面・S3・下りは **[LAiF流用]**。

## 2. 対象範囲

| 含む | 含まない |
|---|---|
| Portal のプリベント側表示（`?partner=prevent`） | LAiF の挙動（**1 行も変えない**） |
| 顧客別 問診CSV の生成と配布 | 受取撮影機能そのもの（**既に実装済み・既定 off**。本仕様は**その成果物を読むだけ**） |
| 結果PDF 提出（LAiF 流用の確認のみ） | 血液・Genoplan・AI疾病発症予測 |
| 監査ログ（LAiF 流用） | 結果PDF と検査の構造的突合（§8・**未確定**） |

## 3. LAiF Partner Portal の既存構成（**実コードで確認**）

### 3.1 wellfort-site（UI と中継）

| 要素 | 実装 | 状態 |
|---|---|---|
| 画面 | `src/pages/partner-portal-preview.astro`。5 画面 = `scr-login`（`:98`）／`scr-register`（`:113`）／`scr-menu`（`:129`）／`scr-csv`（`:150`）／`scr-pdf`（`:161`） | **[既存実装あり]** |
| partner 切替 | 同ファイルの `var PARTNERS = { laif: {...}, prevent: {...} }`。`?partner=` で選ぶ | **[既存実装あり]** |
| パスキー API | `src/pages/api/partner/auth/[action].ts`。action は **`register-options`（`:82`）/ `register-verify`（`:128`）/ `login-options`（`:209`）/ `login-verify`（`:225`）/ `logout`（`:305`）** の 5 つ | **[既存実装あり]** |
| 認証ライブラリ | `src/lib/partner-auth.ts`。`PARTNERS = ['laif','prevent']`（`:43`）／`SESSION_COOKIE='wf_partner_sess'`（`:40`）／`SESSION_TTL_SEC = 8h`（`:35`）／`CHALLENGE_TTL_SEC = 5min`（`:37`）／`INVITE_TTL_SEC = 7日`（`:39`）／`ALLOWED_ALGS = [-7,-257]`（`:42`） | **[既存実装あり]** |
| 認可 | `requirePartner(request, wantPartner)`（`:412-430`）。**session が正**で、want と違えば **403 `partner_mismatch`**（`:426`） | **[既存実装あり]** |
| 下りの中継 | `src/pages/api/partner/upload.ts`。`ALLOWED_MODES = {ticket, list}`（`:28`）／`requirePartner`（`:53`）／上流は `${SCAN_CHAT_AI_BASE_URL}/api/partner/laif-upload`（`:79`）／`MAX_MB = 50`（`:25`） | **[既存実装あり]** |
| 上りの配布 | 画面が `C.sampleFile(id)` の**静的ファイルを直 DL**。**サーバ生成は無い** | **[既存実装あり（ただしサンプル）]** |

**DB**: `supabase/migrations/20260909000010_partner_portal_auth.sql`（6 表）。

### 3.2 Scan-Chat-AI（鍵と S3）

| 要素 | 実装 | 状態 |
|---|---|---|
| 上流 API | `src/pages/api/partner/laif-upload.ts`。認可は **`isAdminAuthorized`（`:31`）= Bearer `ADMIN_API_KEY`**。mode は **`ticket`（`:52`）/ `list`（`:71`）/ `revoke`（`:81`）/ `download`（`:93`）** | **[既存実装あり]** |
| S3 ライブラリ | `src/lib/laif-portal.ts`。`createUploadTicket`（`:149`）／`listUploads`（`:268`）／`revokeUpload`（`:312`）／`createDownloadUrl`（`:351`）／`isQuarantineKey`（`:219`）／`sanitizeFilename`（`:105`） | **[既存実装あり]** |
| 定数 | `ACCEPTED_CONTENT_TYPE='application/pdf'`（`:36`）／`MAX_UPLOAD_BYTES=50MB`（`:45`）／`PRESIGN_EXPIRES_SEC=900`（`:54`） | **[既存実装あり]** |
| キーの階層 | `quarantine/{partner}/`（`:56`・`DEFAULT_QUARANTINE_PREFIX`）／取消は `revoked/`（`:62`）。**`normalizePartner()` が `prevent` を既に受ける**（`:95`） | **[既存実装あり]** |
| 有効化 | `isPortalUploadEnabled()`（`:72`）= env `LAIF_PORTAL_UPLOAD` | **[既存実装あり]** |
| 仕様書 | `docs/lab/laif_s3_secure_handoff_spec.md`（313 行） | **[既存実装あり]** |

### 3.3 LAiF で「実装済み」と言えること／言えないこと

| # | 項目 | 実コードでの結論 |
|---|---|---|
| 1 | **パスキー認証** | **実装済み**（§3.1）。画面冒頭に「**パスキー認証は常時必須**」と明記され、env での切替は撤去済み |
| 2 | **partner 別認可** | **実装済み**（`requirePartner`）。**prevent も既に許可された partner 値** |
| 3 | **Portal 画面** | **実装済み**（5 画面・partner で設定切替） |
| 4 | **ファイル取得画面（上り）** | **画面は実装済み。中身は静的サンプル**（`C.sampleFile`）。**顧客別生成は未実装** |
| 5 | **結果PDF 提出（下り）** | **実装済み**（ブラウザ → S3 直 PUT・アプリは本体を中継しない） |
| 6 | **Presigned S3** | **実装済み**（ticket / list / revoke / download・`quarantine/{partner}/`） |
| 7 | **Scan-Chat-AI との連携** | **実装済み**（wellfort-site サーバ → Bearer `ADMIN_API_KEY` → Scan-Chat-AI。鍵はブラウザに出ない） |

**未実装（LAiF でも）**: 顧客別の上りファイル生成・配布／検疫（GuardDuty）／**結果と検査の構造的突合**。

---

## 4. LAiF からそのまま流用する機能 — **[LAiF流用]**

| # | 流用するもの | 変更の有無 |
|---|---|---|
| 1 | パスキーの登録・ログイン・ログアウト（`api/partner/auth/[action].ts`） | **変更なし** |
| 2 | session と partner 別認可（`partner-auth.ts` / `requirePartner`） | **変更なし** |
| 3 | Portal の 5 画面と `?partner=` 切替 | **変更なし**（`PARTNERS.prevent` の値だけ差し替え） |
| 4 | 結果PDF の Presigned PUT・提出一覧・取消（`laif-portal.ts` / `api/partner/upload.ts` / `api/partner/laif-upload.ts`） | **変更なし**（partner はキーの階層に入るだけ） |
| 5 | 50MB 上限・PDF 限定・15 分署名・`quarantine/{partner}/` | **変更なし** |
| 6 | 監査ログ（`logEvent`） | **変更なし** |
| 7 | メール通知の枠（「新しいCSVがアップロードされると通知」の文面） | **変更なし**（通知実装の有無は §17） |

**新しい Portal・新しい認証・別の S3 授受方式は作らない。**

## 5. プリベント固有差分 — **[Prevent差分]**

| # | 差分 | 実現方法 |
|---|---|---|
| 1 | 検査識別 ID が **バーコードNo.** | `PARTNERS.prevent` の `idLabel` と、CSV の該当列に入れる値 |
| 2 | 上りが **CSV**（LAiF は XLSX） | 生成は Scan-Chat-AI 側。中継は既存の流儀に合わせる |
| 3 | 上りが **顧客別**（LAiF は静的サンプル） | 一覧 ＋ 1 件 DL の口が要る（**[新規実装必要]**） |
| 4 | 生年月日を含む | 既に LAiF も個人データ扱い。**S3・ポータルの保護は共通**（§10） |

**これ以外に Prevent 固有の基盤は作らない。**

## 6. バーコードNo. の扱い

| | 内容 | 状態 |
|---|---|---|
| 値 | 検査キット（シール台紙）に **「ユーザーID」** として印字。**`704000` ＋ 3 桁の計 9 桁**（2026-10-13 に実物 1 枚で確認） | **[既存実装あり]** |
| 格納先 | **`customer.lab_tests.external_barcode`**（`20260601000010:151`） | **[既存実装あり]** |
| 期待パターン | app_config **`labid.prevent_pattern`**（既定 `^704000[0-9]{3}$`）。外れても登録は通り `review_required` | **[既存実装あり]** |
| 構造ガード | `passesStructuralGuard()`（数字のみ 4〜20 桁） | **[既存実装あり]** |
| 取得経路 | 受取確認時にユーザーが撮影 → `customer.lab_test_id_captures` に記録（`20261011000010:36`） | **[既存実装あり・既定 off]** |
| **使わないもの** | **Wellfort 独自の整理番号を新規に作らない。** LAiF の整理番号体系はプリベントへ持ち込まない | — |
| 外部露出 | **Portal にはバーコードNo. だけ**出す。`lab_tests.id` / `diagnostic_user_id` / `orders.id` / `shipment_ref` は出さない | **[新規実装必要]**（§7 の一覧で守る） |

## 7. Wellfort → PREVENT 問診CSV — **[Prevent差分][新規実装必要]**

| | 内容 |
|---|---|
| 置き場所 | **生成は Scan-Chat-AI**（S3 の問診 JSON と `customer` スキーマに触れるのはこちらだけ）。**UI と中継は wellfort-site** |
| 経路 | ブラウザ（パスキー session のみ）→ wellfort-site の中継（Bearer をサーバ側で付与）→ Scan-Chat-AI |
| 一覧に出す列 | **バーコードNo. / 作成日 / 項目数 / 操作**（現行画面の表の形をそのまま使う） |
| ファイル名 | **バーコードNo. を基準にする**（先方要望）。具体形は **[未確定]**（§13 と同時に決める） |
| 配布の有効化 | **CSV 仕様が確定するまで配らない。** 止め方は §17 の #3 の判断待ち（**根拠なく flag を増やさない**） |

**出す対象の条件**（§12 の事実から導けるもの）:

1. その検査の **バーコードNo. が登録済みで確定している**（台帳 `status='confirmed'`）
2. **その検査レコードへ紐づいている**（`lab_test_link_status='linked'` かつ `lab_test_id` 非 null）
3. **その検査に対応する問診の回答が在る**

**1・2 は `checkPreventQuestionnaireGate()` が既に実装済み**（`src/lib/external-test-id.ts`・
#321 の revert でも**消えていない**＝ #319 以前からある）。**3 は §17 の #1 の未確定**。

## 8. PREVENT → Wellfort 結果PDF — **[LAiF流用][既存実装あり]**

- ブラウザ → S3 直 PUT（`quarantine/prevent/`）。アプリは本体を中継しない。
- 提出状況の一覧・取消も既存のまま。
- **結果PDF と バーコードNo. の構造的突合は未実装**（キーに検査IDが入らない）。
  現状は **admin が原本を見て `test_artifacts` へ紐づける**。→ §17 の #2。

## 9. 認証・認可 — **[LAiF流用][既存実装あり]**

| 層 | 内容 |
|---|---|
| ブラウザ → wellfort-site | **パスキー session のみ**。鍵は持たない |
| partner の決定 | **session が正**。body の申告は突き合わせにしか使わない（`requirePartner`） |
| wellfort-site → Scan-Chat-AI | **Bearer `ADMIN_API_KEY`**（＝ wellfort-site の `SCAN_CHAT_AI_API_KEY`）。**サーバ側だけ** |
| Scan-Chat-AI 側 | `isAdminAuthorized`。**キー未設定の本番は拒否**（fail-closed） |

**新しい認証方式を作らない。パスキー必須を緩めない。**

## 10. S3 / ファイル授受 — **[LAiF流用][既存実装あり]**

| | 内容 |
|---|---|
| 下り（結果PDF） | Presigned PUT・PDF 限定・50MB・15 分・`quarantine/{partner}/`・ファイル名は metadata（非ASCII は base64 併記） |
| 上り（問診CSV） | **数 KB なので S3 を経由する必要がない。** 中継の JSON に載せて返せる（Vercel の本文上限 4.5MB に対し十分小さい）。**別の授受方式を作らない**判断 |
| 検疫 | **未実装**（LAiF と同じ・§17） |

## 11. DB との関係（**実測**）

| 表 | 役割 | プリベントでの使い方 |
|---|---|---|
| `customer.lab_tests`（`20260601000010:143-165`） | 1 検査のレコード。`external_barcode`（`:151`）を持つ | **バーコードNo. の格納先** |
| `customer.lab_test_id_captures`（`20261011000010:36`） | 受取撮影の台帳。`diagnostic_user_id` / `shipment_ref` / `provider` / `normalized_value` / `status` / `lab_test_id` / `lab_test_link_status` を持つ | **バーコードNo. ↔ 人 ↔ 検査**の現在の結び目 |
| `diagnosis.interview_completions`（`20260915000010`） | 問診完了の事実。`diagnostic_user_id` / `completed_at` / `answered_count` / `diagnostic_id` | **完了の記録のみ。回答本文は持たない** |
| S3 | `{prefix}user/{uid}/date/{YYYY_MM_DD}/LifestyleQuestionnaireData_date_..._user_{uid}.json` | **問診回答の唯一の実体** |

**[未確定]** `interview_completions` に **`lab_test` / `shipment` への参照は 0 件**（実測 grep）。
→ **問診と「どの検査」の結び付きは、現在の DB には無い**（§17 の #1）。

## 12. CSV 生成元データ（**今ある材料だけで何ができるか**）

| 必要なもの | 今ある材料 | 判定 |
|---|---|---|
| **バーコードNo.** | `lab_test_id_captures.normalized_value`（確定は `status='confirmed'`） ＋ `lab_tests.external_barcode` | **[既存実装あり]** |
| **対象ユーザー** | 台帳の `diagnostic_user_id` | **[既存実装あり]** |
| **生年月日・性別** | `resolveTargetSubject(uid)`（`src/lib/target-subject.ts:43`）。`customer_profiles` → スペシャル登録値の順 | **[既存実装あり]** |
| **身長・体重・生活習慣** | S3 の `LifestyleQuestionnaireData` の `data.answers[]`（`id` と `answer_label`） | **[既存実装あり]** |
| **「その検査の」問診** | **無い**（§11 の未確定） | **[未確定]** → §17 の #1 |
| **ALA摂取日時 / 採尿日時** | **無い**。AI問診からは意図的に削除されており（`src/scripts/chat/interview-script.ts:538-541`）、キット進捗にも入力欄が無い（`api/kit/[id]/self-report.ts` は受取・返送の 2 列だけ） | **[未確定]** → §17 の #4 |
| **排尿回数 / 冷凍保存 / 採尿前日の薬・飲酒** | **無い**（同上） | **[未確定]** → §17 の #4 |

**事実として**: バーコードNo. は **「人 ＋ 受取確認の対象（`shipment_ref`）＋ provider」** で台帳に結ばれ、
そこから `lab_test_id` へ紐づく。**問診とは結ばれていない。**

## 13. CSV フォーマット — **[未確定]**

**先方提供資料「ウェルフォート様_問診・アンケートデータ_例_問診1回.xlsx」は
リポジトリに存在しません**（実測: `*.xlsx` の全検索で LAiF の
`scripts/laif-fixtures/input_format_new_202312_blank.xlsx` のみ。
ファイル名・「アンケートデータ」「問診1回」の文字列ヒットも 0 件）。

| 項目 | 状態 |
|---|---|
| 列数 | **未確認** |
| ヘッダ | **未確認** |
| ヘッダ行数 | **未確認** |
| 項目順 | **未確認** |
| 値形式 | **未確認** |
| 選択肢 | **未確認** |
| 日付形式 | **未確認** |
| 文字コード | **未確認** |
| 改行コード | **未確認** |
| 空欄表現 | **未確認** |

**推測して CSV 仕様を作りません。** 先方提供 Excel をリポジトリへ取り込み
（PII 確認後・`docs/lab/reference/prevent/`）、**そこから機械的に起こす**のが正しい順序です。
それまで §7 の配布は有効化できません。

## 14. エラー処理

| 事象 | 返す | 判定 |
|---|---|---|
| 未ログイン | 401（`requirePartner`） | **[LAiF流用]** |
| 別 partner の領域 | 403 `partner_mismatch` | **[LAiF流用]** |
| 上流キー未設定 | 500 `server_misconfig`（素通ししない） | **[LAiF流用]** |
| 想定外の mode | 400（allow-list） | **[LAiF流用]** |
| 条件を満たさない検査の CSV 要求 | **一般化した理由だけ返す**（台帳の内情を外へ出さない） | **[新規実装必要]** |
| 一覧が空 | 画面に「ありません」を出す（行き止まりにしない） | **[新規実装必要]** |

## 15. 監査ログ

- `logEvent()`（`src/lib/partner-auth.ts:100`）を**そのまま使う**。**[LAiF流用]**
- 記録するのは **event / partner / detail / request の属性**。
  **バーコードNo. の全文・氏名・問診の中身はログに出さない**（表示は `maskExternalId` で末尾 4 桁）。
- **[未確定]** CSV の DL 自体を監査対象にするか（LAiF は静的 DL なのでログが無い）。

## 16. テスト仕様

| 層 | 内容 | 判定 |
|---|---|---|
| 既存の回帰 | wellfort-site `verify:partner-auth`／Scan-Chat-AI `verify:external-id-capture`（324 件） | **[既存実装あり]** |
| **LAiF 不変の固定** | LAiF の `idLabel` / `idPrefix` / `sampleFile` / `sampleName` / サンプル文言 / パスキー必須 が**変わっていないこと** | **[新規実装必要]** |
| ゲート | 条件を満たさない検査が一覧にも DL にも出ないこと（`confirmed` / `linked` / `lab_test_id` の 3 条件） | **[新規実装必要]** |
| 3 値一致 | **Portal 表示 / CSV 内の ID / ファイル名が同じ 1 つの確定値から派生**していること | **[新規実装必要]** |
| CSV 固定 | 先方様式の fixture と**1 バイト単位**で比較（**§13 確定後**） | **[未確定]** |
| 認可 | 未認証で取得不可／LAiF の session でプリベントの CSV を取得不可／API 直叩きでもゲートを迂回不可 | **[新規実装必要]** |

## 17. 未確定事項（**発注者判断待ち。実装案に入れない**）

| # | 事項 | なぜ既存実装で解決できないか |
|---|---|---|
| **1** | **「その検査の問診」をどう特定するか** | `interview_completions` に検査への参照が 0 件。S3 のキーも「人と日付」だけ。**日時近似での選択は禁止**されているので、**現在の DB では特定できない**。→ **問診 1 件を対象検査へ結ぶ仕組みが要る**が、**本仕様では設計しない**（新しい基盤を勝手に作らない） |
| **2** | **結果PDF と バーコードNo. の突合** | S3 のキーに検査IDが入らない（LAiF も同じ）。ファイル名からの推測は禁止 |
| **3** | **CSV 配布の止め方** | 様式確定まで配れない。既存に使える停止手段が無い（`labid.prevent_capture` は**撮影**の flag で、配布とは別物。撮影 off でも台帳に過去の `confirmed` 行が残れば一覧に出得る）。**根拠なく flag を増やさない**ため、止め方は判断待ち |
| **4** | **ALA摂取日時・採尿日時・排尿回数・冷凍保存・採尿前日の薬／飲酒** | AI問診から意図的に削除済み・キット進捗に入力欄が無い。**どこで取るかが決まっていない** |
| **5** | **CSV 仕様**（§13 の 10 項目） | 先方提供 Excel がリポジトリに無い |
| **6** | **CSV の DL を監査ログに残すか** | LAiF は静的 DL でログが無く、前例が無い |
| **7** | **メール通知** | 画面に「新しいCSVがアップロードされると通知が届く」と書いてあるが、**通知の実装は確認していない** |
| **8** | **検疫（GuardDuty）** | LAiF でも未実装 |

### 17.1 revert が巻き戻した既存仕様書の記述（**別タスク・発注者判断待ち**）

**PHASE 1 の revert は「部分 revert（文章だけ選んで残す）」ではなく機械的な完全 revert を採った。**
`git revert -m 1` の結果が `d0b3646^1` と**バイト単位で一致**することを確かめる方が、
「どの散文を残すか」をこちらの判断で選ぶより安全だと考えたため。
**その副作用として、#321 が直していた既存仕様書の記述が元に戻っている。**
**本仕様の実装範囲ではないので、ここに記録だけ残す。直すかは発注者判断。**

| # | ファイル | 戻った記述 | なぜ問題か |
|---|---|---|---|
| **R-1** | `docs/lab/kit_receipt_external_id_capture_spec.md` §2.3 見出し `:114` / §9 D-2 `:644` / §12 `:715` / §13 `:750` | 「プリベントのバーコード形式は**未確認**」「**実物の同梱書面を 1 枚も見ていない**」 | **同じ文書の §2.1.1 / §2.1.2（`:52` `:70` `:390`）は実物 1 枚（2026-10-13）を前提に「既定パターンと一致・変更不要」と書いたまま残っている** → 文書内で矛盾。#321 がこの 2 つを揃えていたのが戻った |
| **R-2** | `docs/architecture/id_management_and_correlation_spec.md` `:91` `:123` `:149` `:171` | 「プリベント＝**会員ID/ユーザーID**、採番元は**要確認**」「各社へ渡す識別子（…プリベント会員ID）も **Wellfort 採番の仮名値**」 | プリベントの往復キーは**先方発行のバーコードNo.**（Wellfort 採番ではない）。§6 の確定事項と食い違う |
| **R-3** | `docs/lab/lab_data_reception_overview.md` `:620` | 「② 各社への上りID … プリベント＝会員ID … **Wellfort 採番の仮名ID**」 | 同上 |
| **R-4** | `docs/lab/lab_data_pipeline_master_spec.md`（48 行） / `docs/lab/questionnaire_to_lab_csv_spec.md`（88 行） | バーコードNo. 一本化・問診相関の fail-closed・様式未確定の記述が戻った | 本仕様（§6・§7・§17 の #1）が正。両文書は**プリベントの節だけ**が古い |

> **この 4 件は「誤った前提の実装」ではなく、revert の副作用で古い散文が戻ったもの。**
> **本仕様が発注者確認を通った時点で、§6 / §7 / §17 に合わせて 4 ファイルの該当節だけを直す
> 小タスクを別に立てるのが筋**（まとめて直すと、また「実装と仕様の上塗り」になる）。
> **LAiF・血液・Genoplan・AI疾病発症予測の節は 1 行も戻っていない**（revert 対象に入っていない）。

**正本の優先順位（この矛盾が解けるまで）**

> **プリベント Partner Portal については本仕様書を今回の正本とする。**
> 上の 4 文書の **Prevent 節に矛盾が残っている間は、本仕様書を優先する**
> （例: 「プリベント＝会員ID／Wellfort 採番の仮名ID」は**古い**。正は**先方発行のバーコードNo.**）。
> **R-1〜R-4 は、別の小さな docs 整合タスクで修正する**（本仕様・本手順書の Step では直さない）。
> LAiF・血液・Genoplan・AI疾病発症予測・検査パイプライン全体については、**従来どおり各文書が正本**
> （本仕様書が優先するのは **Prevent Partner Portal の範囲だけ**）。

## 18. 実装対象（この仕様で作るもの）

1. `PARTNERS.prevent` の設定値の差し替え（`idLabel` = バーコードNo. ほか）**[Prevent差分]**
2. 顧客別 問診CSV の **一覧** と **1 件 DL** の口（Scan-Chat-AI の生成 ＋ wellfort-site の中継）**[新規実装必要]**
3. **3 値（表示 / CSV 内 ID / ファイル名）を 1 つの確定値から派生させる**こと **[新規実装必要]**
4. 上記の回帰テスト（**LAiF 不変の固定**を含む）**[新規実装必要]**

## 19. 実装対象外

1. **LAiF の挙動**（1 行も変えない）
2. **新しい Portal / 認証 / S3 授受方式**
3. **新規 DB テーブル・新規 cross-system ID**（`test_instance_ref` / `interview_test_links` /
   `customer.test_instances` / 新しい lab lifecycle を**作らない**）
4. **`test_instance_ref` を前提条件にしない**（§17 の #1 は判断待ち項目として挙げるだけ）
5. 受取撮影機能そのもの（既に実装済み）
6. 結果PDF と検査の突合（§17 の #2）
7. CSV 仕様の推測（§13）
8. migration
