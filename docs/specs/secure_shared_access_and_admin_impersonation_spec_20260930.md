# Welltect セキュア共有アクセス ／ Admin 代理表示の UID-less 化 仕様書

**版**: 1.1 (2026-09-30・レビュー反映)
**状態**: **仕様のみ。実装は 1 行も行っていない。**

> **v1.1 の変更（レビュー 2026-09-30・7 点）**
> ① **§13.0 を新設** — 現行の `target="_blank"` による複数タブ運用が Cookie 1 本方式で壊れる
> （既存機能の退行）。案 A / 案 B を比較し、**案 B（URL path の opaque view-context）を推奨**。
> あわせて §13.1-13.3 / §23 / §24.1 / §25.1 / 付録 A-B・E を更新。
> ② **§17.2 を確定** — `kit/self-report` / `notices/read` は **share で BLOCK**。
> 発注者が許可した更新は AI 問診と AI スキャンだけ。`view` は閲覧のみ。**U18 を確定済みへ**。
> ③ **§17.5 を新設** — `auth/resolve` / `auth/signout` / `auth/refresh-admin` は **share で BLOCK**。
> 共有終了は `/share/end` が `welltect_share_v` だけを消す。
> ④ **§19.5 を新設** — 対象者 profile metadata（`userName` / `dateOfBirth` / `sex`）の
> サーバ解決を**未確定（旧 U7）から Phase 0 必須へ昇格**。
> ⑤ **§27.3 を新設** — 「revoke は即時停止」を実コードに合わせて訂正。
> **発行済みの Gemini Live token（最大 30 分）と S3 presigned PUT（15 分）は失効できない**。
> ⑥ **§12.3 / §12.6 を統一** — 「アクセスログにも残らない形」を削除し、
> 「custom log には絶対書かない／アクセスログには残り得る／60 秒・単一使用・no-referrer で限定」へ。
> ⑦ **§21.4 を新設** — `resolveViewer` も `checkAdminAuth` も通っていない **未認証の AI / S3
> コスト API 6 本**を実測で特定し、**Phase 0 必須**とした。**「UID を使っていないから安全」としない**。
**対象リポジトリ**: `mirai-gpro/Scan-Chat-AI`（本体）/ `mirai-gpro/wellfort-site`（admin UI・入口）

**調査開始時点の HEAD（`git ls-remote` による実測）**

| リポジトリ | ブランチ | HEAD |
|---|---|---|
| Scan-Chat-AI | `claude/awesome-carson-UeyUZ`（Production / default） | `f20a5bff3c88354224b951c7c3a4b3c050eaea95` |
| Scan-Chat-AI | `claude/cool-dirac-1dkyx7`（作業） | `30943caa8d8dc2133f8a6108a8bf8332218db478` |
| wellfort-site | `main`（**Production / default**。`origin/HEAD → main`） | `0c9c35d9a90795e20970cd51b7aaec2c0f38ceb3` |
| wellfort-site | `claude/cool-dirac-1dkyx7`（作業・`main` に取り込み済み） | `9b5ed2892e3612c4567643e169bf3206d06cff52` |

> **注記（CLAUDE.md との差異）**: CLAUDE.md「デプロイ元ブランチ」節は wellfort-site の Production Branch を
> `claude/wellfort-ui-design-draft-7y8dup` と記している（2026-08-29 確定）が、**2026-09-30 の実測では
> `origin/HEAD` は `main` を指し、`main` が最新**（`claude/wellfort-ui-design-draft-7y8dup` は 2026-09-25 で止まり、
> `main` は 2026-09-29 まで進んでいる）。本書の調査は `main` を正として行った。
> **Vercel の Production Branch 設定は当方から確認できない**ので、これは「default branch の実測」であって
> 「デプロイ元の確定」ではない。**実装着手前に発注者が Vercel 側で確認すること**（§38-U1）。

---

## 1. 目的

2 つの課題を 1 つの設計で解く。

1. **Admin 代理表示の UID-less 化** — 現在 Wellfort Admin は
   `{SCAN_APP_BASE}/dashboard?u=<diagnostic_user_id>`（`wellfort-site/src/pages/admin/customers.astro:438`）で
   対象顧客の画面を開き、Scan-Chat-AI 側は `viewerLinkQuery()`（`src/lib/viewer.ts:306-310`）で
   以降のページへ `?u=` を引き回している。これを URL から消す。
2. **外部セキュア共有** — 助成金事務局・法人顧客・営業先・専門家などへ、
   **専用 URL を開くだけ**で特定ユーザーの Welltect を使ってもらえるようにする。

一般ユーザー本線（Google 認証 → 署名付き HttpOnly Cookie → `resolveViewer()`）の
UID-less 化は **2026-09-29 に完了済み**（`f20a5bf`・仕様は `docs/specs/url_uid_privacy_spec_20260929.md`）。
**本線は作り直さない。**

---

## 2. Wellfort 要望（原文の趣旨）

> 共通の ID・パスワードを渡して、複数の外部関係者が特定ユーザーのダッシュボードを見られるようにしたい。

これを**共通 ID・パスワード方式では実装しない**。共通 ID・パスワードは

- 誰が入ったか分からない（監査不能）
- 1 人へ渡すと全員へ渡る（部分失効できない）
- 相手のパスワード管理に依存する
- 変更すると全員が同時に締め出される

という性質を持ち、「管理しやすく監査性が高い」という要望の本体を満たせない。

代わりに **推測困難な共有アクセスキー ＋ サーバ側の有効性判定 ＋ Cookie セッション** を採る。

---

## 3. プロダクトコンセプト

> **「URL で開くだけ。なのに、ID・パスワード方式より安全で簡単。」**
> **「入口は簡単に。内部のセキュリティは強く。」**

| 相手から見えるもの | 内部で起きていること |
|---|---|
| 専用 URL を開く | 256bit の共有トークンを Bearer credential として検証 |
| 確認画面で「同意して利用する」 | 短命 pending セッション → 同意記録 → 共有セッション発行 |
| 以後はふつうの Welltect | 全リクエストで有効期限・停止・失効・target lock をサーバ側で判定 |
| （見えない） | アクセス日時・接続元・経路を監査ログへ記録 |

**外部閲覧者に Google / Microsoft / Welltect のアカウント発行を求めない。**

---

## 4. 現行構成

### 4.1 2 リポジトリの責務

| | Scan-Chat-AI | wellfort-site |
|---|---|---|
| 役割 | Web アプリ本体・API 提供側 | 企業サイト・EC・**admin UI** |
| 本番 URL | `https://scan-chat-ai.vercel.app/` | `https://www.wellfort.co.jp/` |
| origin | **別 origin**。Cookie は共有できない | 同上 |

CLAUDE.md「アプリ構成 / 管理画面の所在」の確定事項どおり、**admin UI は wellfort-site 側 /
処理は Scan-Chat-AI の API**。本書もこの分界を守る。

### 4.2 Scan-Chat-AI の一般ユーザー向けページ（実測 10 本）

`src/pages/index.astro` `dashboard.astro` `report.astro` `trend.astro` `kit.astro`
`scan.astro` `chat.astro` `coach.astro` `notices.astro` `result/[id].astro`

### 4.3 API 一覧（`src/pages/api/**` 実測 52 本）

- `admin/**` … 28 本（Bearer `ADMIN_API_KEY`）
- `cron/**` … 3 本（`elith-deliver` / `elith-intake` / `scan-worker`・Bearer `CRON_SECRET`）
- `ops/**` … 4 本（`PROBE_UPLOAD_TOKEN`）
- `auth/**` … 3 本（`resolve` / `refresh-admin` / `signout`）
- 一般ユーザー向け … `scan.ts` `scan/save.ts` `scan/export.ts` `scan/jobs.ts`
  `scan/upload-ticket.ts` `interview/export.ts` `interview/classify-voice.ts`
  `live-token.ts` `insight.ts` `coach/ask.ts` `kit/[id]/self-report.ts`
  `notices/[id]/read.ts` `debug/viewer.ts`

### 4.4 DB（Supabase・2 スキーマ）

`customer`（PII）/ `diagnosis`（非 PII）を `diagnostic_user_id` だけで橋渡し。
`diagnosis` の現行テーブル（migration からの実測 12 本）:

```
app_config  app_users  announcements  diagnosis_results  elith_deliveries
health_age_scores  interview_completions  measurement_values  scan_jobs
test_artifact_files  test_artifacts  user_notices
```

**RLS は現在テストフェーズの緩い設定**（`supabase/migrations/20260601000020_rls_policies.sql:63,67`）:
`dev_read_all`（`for select using (true)`）と `dev_authn_write`（`for all to authenticated using(true) with check(true)`）が
全テーブルに付いている。CLAUDE.md「DB 権限まわりの既知の宿題」に記載のとおり**総合テストで潰す前提**。
**共有機能のテーブルをこの RLS の下に素で置いてはいけない**（§22.6）。

---

## 5. 現行の本人認証（変更しない）

### 5.1 Cookie

`src/lib/viewer.ts`

| 項目 | 実測値 | 根拠 |
|---|---|---|
| Cookie 名 | `welltect_v` | `:26` |
| 形式 | `uid.exp.admin[.s].HMAC-SHA256(payload)` | `:105-108` |
| 有効期間 | **30 日** | `:29` |
| 署名鍵 | `APP_SESSION_SECRET` ?? `SUPABASE_SERVICE_ROLE_KEY`。どちらも無ければ **null = fail-closed** | `:52-54` |
| 属性 | `HttpOnly` / `Secure`（本番）/ `SameSite=Lax` / `Path=/` | `:179-190` |
| 検証 | 3・4・5 分割を受理。`origin` 印は `s` のみ許可。定数時間比較 | `:145-176`, `:68-73` |

### 5.2 解決順序（`resolveViewer()`・`:255-288`）

```
1. Cookie を検証 → 本人 (selfUid)
2. 本人が admin かつ ?u= が自分以外  → 代理表示 (uid=?u= / impersonating=true)
3. Cookie 無し かつ ALLOW_UID_ENTRY=on かつ ?u=  → 緊急入場 (uidEntry=true / isAdmin=false)
4. それ以外 → ANONYMOUS
```

**admin の成立経路は Cookie の admin フラグ 1 本だけ**（`:276-283`）。
フラグはサインイン時に wellfort-site の `admin_users` へ問い合わせて載せる
（`src/pages/api/auth/resolve.ts` → `isAdminEmailAsync`）。

### 5.3 `Viewer` 型（`:192-243`）

```ts
uid: string | null        // 表示対象
selfUid: string | null    // サインイン本人 (代理表示中も本人)
isAdmin: boolean
adminBy: 'cookie' | null
impersonating: boolean
origin: BridgeOrigin      // 'production' | 'staging'
cookieStale: boolean
uidEntry: boolean         // ALLOW_UID_ENTRY での入場。リンク維持専用
```

### 5.4 【最重要の既存規律】読みは `uid` / 書きは `selfUid`

実測（`grep viewer.uid|viewer.selfUid src/pages src/components`）:

| 用途 | 使う値 | 実測箇所 |
|---|---|---|
| **ページの表示対象（読み）** | `viewer.uid` | `dashboard.astro:47` / `report.astro:50` / `trend.astro:42` / `kit.astro:41` / `scan.astro:40` / `chat.astro:16` / `coach.astro:37` / `notices.astro:21` / `result/[id].astro:22` |
| **保存先（書き）** | `viewer.selfUid` | `api/scan/save.ts:36` / `api/scan/jobs.ts:39` / `api/interview/export.ts:92` |

`api/scan/save.ts:32-36` のコメントが理由を明記している:

> `?u=` は admin の代理表示専用。**保存には使わない** — 代理表示中に保存すると
> 相手の検査結果を勝手に作ることになる。自分の uid だけを保存先にする。

**この規律は Admin 代理表示にとっては正しいが、外部共有にはそのままでは使えない。**
共有利用者には `selfUid` に相当するものが無く、**読みも書きも target へ向ける**必要がある。
これが本設計の中心的な差分である（§9 / §10）。

---

## 6. 現行の Admin 代理表示（全経路）

### 6.1 入口（wellfort-site）

| # | 場所 | 生成される URL |
|---|---|---|
| 1 | `src/pages/admin/customers.astro:436-438` | `{SCAN_APP_BASE}/dashboard?u=<duid>`（顧客一覧の diagnostic_user_id セルをリンク化） |
| 2 | `src/pages/admin/health-age.astro:261` | `{SCAN_APP_BASE}/dashboard?u=<uid>`（ウェルネス年齢パネルの導線） |

`SCAN_APP_BASE = import.meta.env.PUBLIC_SCAN_APP_BASE_URL || 'https://scan-chat-ai.vercel.app'`
（`customers.astro:14` / `health-age.astro:10`）。**どちらもクライアント側 JS で組み立てている**
（`is:inline` の `define:vars`）。

`customers.astro:433-435` のコメント:

> 開いた先が本人の画面になるには、押す人が Scan-Chat-AI 側でも管理者としてサインインしている必要がある

= **ブラウザに Scan-Chat-AI の admin Cookie がある前提**の導線。

### 6.2 受け口（Scan-Chat-AI）

| # | 場所 | 役割 |
|---|---|---|
| 1 | `src/pages/index.astro:11-12` | `/` へ来た `?u=` を含む全クエリを `/dashboard` へ 302 転送 |
| 2 | `src/lib/viewer.ts:257` | `?u=` の読み取り。**アプリ全体でここ 1 か所だけ** |
| 3 | `src/lib/viewer.ts:284-286` | `isAdmin && requested !== selfUid` のときだけ代理表示 |
| 4 | `src/lib/viewer.ts:306-310` | `viewerLinkQuery()`。代理表示中だけ `?u=<対象>` を返す |

### 6.3 引き回し（`viewerLinkQuery()` の消費先・実測）

`linkQuery` prop を受ける部品: `AppNav.astro` / `BackToDashboard.astro` /
`dashboard/HealthAgeCard.astro` / `dashboard/TestResultsSection.astro` /
`dashboard/ProgressSection.astro`。
ページ側: `dashboard.astro:236` / `report.astro:196-202` / `trend.astro` / `kit.astro` /
`scan.astro` / `chat.astro`（→ `data-dashboard-link-query` で `live-controller.ts` へ）/
`coach.astro` / `notices.astro`（`noticesHref()`）/ `result/[id].astro`。

**一般ユーザーでは `viewerLinkQuery()` が `''` を返す**ので、現在 URL に UID が出るのは
**admin 代理表示中と緊急入場中だけ**（`f20a5bf` で達成済み）。

### 6.4 現行方式の問題

1. **対象顧客の `diagnostic_user_id` が admin のブラウザ履歴・Referer に残る。**
   共有 PC・画面共有・スクリーンショットで外へ出る。
2. **`?u=` は「知っていれば使える」形**をしている。実際の認可は Cookie の admin フラグなので
   漏れても即座に悪用はできないが、**「URL に uid を書けば何かが変わる」経路が生き続ける**。
   CLAUDE.md がこの形を 2026-08-30 に一度撤去した経緯がある。
3. **外部共有と同じ土俵に乗らない。** 共有は URL に uid を出せないので、
   どのみち「target をサーバ側で持つ」仕組みが要る。**2 つ作るより 1 つの考え方で揃える。**

---

## 7. 現行の外部導線

| 入口 | 現状 | 根拠 |
|---|---|---|
| wellfort-site 一般マイページ → Welltect | **素の URL**。`?u=` は 2026-09-29 に撤去済み | `wellfort-site/src/pages/mypage.astro:107-108`、撤去は `9b5ed28` |
| wellfort-site admin → Welltect | `?u=<duid>` 付き（§6.1） | `customers.astro:438` / `health-age.astro:261` |
| 外部関係者向けの共有導線 | **存在しない**（これから作る） | grep で該当 0 件 |

---

## 8. 設計原則

| # | 原則 | 理由 |
|---|---|---|
| **P1** | **target はサーバ側セッションが持つ。URL・body・ヘッダから受け取らない。** | 本書の全体を貫く唯一の安全条件（§10） |
| **P2** | **本人認証の本線（Google → `welltect_v` → `resolveViewer`）を作り直さない。** | 稼働中。壊すと全員が入れなくなる |
| **P3** | **Admin 代理表示と外部共有は Cookie・セッション・テーブルを分ける。** | 権限モデルが違う。統合すると「共有が admin になる」事故の面が生まれる |
| **P4** | **共通化するのは「target 解決 / 期限 / 失効 / UID-less 遷移 / セッション検証」の 5 つだけ。** | 共通化の利点はここで取り切れる |
| **P5** | **raw token を DB にもログにも残さない。** | 漏れたときの被害を「その 1 本」に閉じる |
| **P6** | **共有利用者は対象ユーザーとして一般機能を使える。読み取り専用にしない。** | 発注者要件（§17） |
| **P7** | **既存 helper で足りるなら新設しない。** `noStore()` / `checkAdminAuth()` / `resolveViewer()` を使う | CLAUDE.md の「二重管理しない」 |
| **P8** | **fail-closed。** 判定できないときは拒否する | `viewer.ts:52-54` / `api-auth.ts` の既存規律と揃える |
| **P9** | **静かに壊れるものは機械で固定する。** 退行注入で落ちることまで確認する | `verify:*` の既存規律 |

---

## 9. Viewer / Target Model

### 9.1 現行 `Viewer` を全面刷新しない

`viewer.uid` は**全ページ・全コンポーネント**が参照している（§5.4）。型を作り直すと
差分が全ファイルへ広がる。**フィールドを足す形**にする（`uidEntry` を足したときと同じ流儀）。

### 9.2 追加するフィールド（案）

```ts
export type ViewerKind = 'anonymous' | 'self' | 'admin_self' | 'admin_impersonation' | 'share' | 'uid_entry';

export interface Viewer {
  // ── 既存（変更しない）─────────────────────────
  uid: string | null;          // 表示対象 = targetUid と同義。既存コードの互換のため名前を保つ
  selfUid: string | null;      // サインイン本人。share では null
  isAdmin: boolean;
  adminBy: 'cookie' | null;
  impersonating: boolean;      // 既存の ?u= 代理表示。新方式でも true にする（§12.4）
  origin: BridgeOrigin;
  cookieStale: boolean;
  uidEntry: boolean;

  // ── 追加 ─────────────────────────────────
  kind: ViewerKind;            // どの経路で解決されたか
  targetLocked: boolean;       // true = URL/body で target を変えられない
  writeTargetUid: string | null; // **書き込み先**。§9.3
  sessionExpiresAt: number | null; // epoch ms。share / impersonation のみ
  shareScope: ShareScope | null;   // share のときだけ。§17.2
}
```

### 9.3 `writeTargetUid` を分けて持つ理由

現行の書き込み API は `viewer.selfUid` を使う（§5.4）。これを `viewer.uid` に変えると
**admin 代理表示中の保存が相手のデータを書き換える**ようになり、既存の明示的な設計判断
（`api/scan/save.ts:32-35`）を破る。かといって share では `selfUid` が無い。

→ **「書き込み先」という第 3 のフィールドを明示的に持つ。**

| kind | `uid`（読み） | `writeTargetUid`（書き） |
|---|---|---|
| `self` / `admin_self` | selfUid | **selfUid** |
| `admin_impersonation` | targetUid | **null**（＝書き込み API は 403）※§12.5 |
| `share` | targetUid | **targetUid** |
| `uid_entry` | requested | requested |
| `anonymous` | null | null |

**書き込み API は `viewer.selfUid` を直接読むのをやめ、`viewer.writeTargetUid` を読む。**
これだけで「共有は書ける・代理表示は書けない」が 1 か所で決まる。

> **これは既存挙動を変える改修**なので、実装時は
> 「`self` では `writeTargetUid === selfUid` であること」を検査で固定し、
> 通常利用者の挙動が 1 ミリも変わらないことを担保する（§34 T-W1）。

---

## 10. Target Lock

### 10.1 定義

**共有セッション／代理表示セッションの開始時に確定した `targetUid` は、
そのセッションの有効期間中、いかなるクライアント入力でも変更できない。**

### 10.2 具体的に無効化するもの

| 入力 | 現状の扱い | Target Lock 下 |
|---|---|---|
| `?u=<別UID>` | `viewer.ts:257` が読み `:284` で admin のときだけ採用 | **完全に無視**（share / 新方式 impersonation では読まない） |
| `POST body.diagnosticUserId` | §11 の 6 API が受け取っている | **認可根拠として使わない。** 付随情報としてのみ許容 |
| `POST body.clientId` | `api/interview/export.ts:105` → S3 パス | **サーバ側 target から組む** |
| `GET /result/<他人のartifact_id>` | `result-queries.ts` が `id + diagnostic_user_id` で検証済み | **`viewer.uid` が target なのでそのまま通る**（§24） |
| `data-diagnostic-user-id`（DOM 改竄） | `coach.astro:123` / `chat.astro:77` / `kit.astro:226` が埋め込み、クライアントが送り返す | **サーバが body の値を捨てる**ので無効 |

### 10.3 実装の置き場所

**`resolveViewer()` の戻り値の内側で閉じる。** 個別 API が「share だったら〜」と
分岐を書くのではなく、`viewer.writeTargetUid` / `viewer.uid` を読むだけにする。
分岐を各 API に散らすと**必ず 1 か所直し忘れる**（`viewerLinkQuery()` を 1 か所に集約したのと同じ理由）。

---

## 11. 【最重要】クライアント申告 UID に依存している箇所（実測・全件）

**共有を公開する前に、ここを全部潰す必要がある。**

| # | API | 受け取り方 | 現在の扱い | 危険度 | 根拠 |
|---|---|---|---|---|---|
| **1** | `POST /api/interview/export` | `body.clientId` / `body.diagnosticUserId` | **S3 の納品パスに直結**。`client_id = clientId \|\| diagnosticUserId \|\| diagnosticId` → `{prefix}user/{client_id}/date/{YYYY_MM_DD}/LifestyleQuestionnaireData_*.json` | **最高** | `api/interview/export.ts:104-105` → `lib/interview-export.ts:252, 281-282` |
| **2** | `POST /api/live-token` | `body.diagnosticUserId` | `buildUserContextForChat` / `getCustomerProfile` / `getAppliedExamLabels` へ直渡し。**検証なし** | 高 | `api/live-token.ts:26-28, 44-46` |
| **3** | `POST /api/insight` | `body.diagnosticUserId` | `buildUserContextForChat` へ直渡し。**検証なし** | 高 | `api/insight.ts:30, 42` |
| **4** | `POST /api/coach/ask` | `body.diagnosticUserId` | `buildCoachContext()` へ直渡し。**検証なし**。未指定なら 400 | 高 | `api/coach/ask.ts:83, 92-94` |
| **5** | `POST /api/scan/export` | `body.diagnosticUserId` | JSON 本文の `diagnostic_user_id` フィールドへ（**S3 フォルダは `{prefix}{diagnosticId}/` なのでパスには効かない**） | 中 | `api/scan/export.ts:56` → `lib/scan-export.ts:187, 272` |
| **6** | `POST /api/kit/[id]/self-report` | `body.diagnosticUserId` | **所有確認あり**（`diagnostic_user_id` → `customer_profiles.user_id` → `kit_shipments.customer_id`）。ただし**他人の uid を送れば他人の出荷を操作できる**（所有者「本人であること」の確認が無い） | 高 | `api/kit/[id]/self-report.ts:24-60` |
| **7** | `POST /api/notices/[id]/read` | `body.diagnosticUserId` | **所有確認あり**（`notice.diagnostic_user_id !== body` なら拒否）。同じく**本人性の確認は無い** | 中 | `api/notices/[id]/read.ts:24-44` |

**安全な側（既に Cookie から解決している）**

| API | 使う値 | 根拠 |
|---|---|---|
| `POST /api/scan/save` | `viewer.selfUid` | `api/scan/save.ts:31-36` |
| `POST /api/scan/jobs` | `viewer.selfUid` | `api/scan/jobs.ts:38-39` |
| `POST /api/interview/export`（**DB 完了記録のみ**） | `viewer.selfUid` | `api/interview/export.ts:91-96` |
| `GET /api/cron/scan-worker` | `job.diagnostic_user_id`（enqueue 時に `selfUid` で確定） | `api/cron/scan-worker.ts:150-152, 180-182` |

> **#1 は共有の有無に関係なく現在も成立する穴。** サインイン済みの利用者が
> `clientId` に他人の uid を入れて POST すると、**その人の Elith 納品フォルダへ
> `LifestyleQuestionnaireData_*.json` を書き込める**。Elith はそのフォルダを入力として
> AI 診断を回すので、**他人の診断入力を汚染できる**。
> **共有導入前どころか、単独で優先度の高い修正**（§31 T-13 / §36 の Phase 0）。

### 11.1 付随して判明した事項（`f20a5bf` の副作用・**セキュリティ課題ではない**）

`src/pages/scan.astro:1015` は

```js
const diagnosticUserId = new URLSearchParams(location.search).get('u');
```

で uid を取り、`/api/scan/export` の body に載せている（`:1041`）。
この行自体は `dd6023c` からあり **URL UID 除去では触っていない**が、
**URL に `?u=` が無くなった結果、一般ユーザーでは常に `null` になる**。

影響は **Elith 納品 JSON の `diagnostic_user_id` フィールドが `null` になる**ことだけで、
**S3 のフォルダは `{prefix}{diagnosticId}/` なので配置は変わらない**
（`lib/scan-export.ts:272`）。また**背景ジョブ経路（`scan-worker`）は
`job.diagnostic_user_id` を使うので影響を受けない**（`scan-worker.ts:182`）。

→ **修正方針は §11 の #5 と同じ**（サーバ側 resolver から取る）。本書の対応で一緒に消える。

---

## 12. Admin Handoff（cross-app）

### 12.1 既存の server-to-server 信頼境界（再利用する）

wellfort-site には **admin 中継 API のパターンが既に確立している**（実測 8 本以上）。
代表例 `wellfort-site/src/pages/api/admin/demo-accounts.ts`:

```
① 入口（admin 判定）: verifyAdmin(request)              … :30-51
   - Authorization: Bearer <ユーザー自身の Supabase access token>
   - GET {SUPABASE_URL}/auth/v1/user  (apikey = anon)     → email
   - GET {SUPABASE_URL}/rest/v1/admin_users?email=eq.…&is_active=eq.true → 在籍確認
   - service_role は使わない
② 上流（Scan-Chat-AI）: Authorization: Bearer SCAN_CHAT_AI_API_KEY … :54
   - SCAN_CHAT_AI_BASE_URL（既定 https://scan-chat-ai.vercel.app）  … :19
   - キーはサーバ側のみ。ブラウザへ出さない・CORS 不要
```

受け側は `Scan-Chat-AI/src/lib/api-auth.ts` の `checkAdminAuth(request)`
（`ADMIN_API_KEY` と完全一致・**未設定の本番は拒否＝fail-closed**）。

**Admin 認証を新しく発明しない。この経路の上に handoff を載せる。**

### 12.2 採用候補フロー

```
Wellfort Admin 顧客管理 (ブラウザ)
  │  ① 「このユーザーの画面を開く」を押す
  ▼
wellfort-site  POST /api/admin/impersonation-handoff        [新設]
  │  ② verifyAdmin(request)  … 既存 §12.1① と同一
  │  ③ Bearer SCAN_CHAT_AI_API_KEY で上流へ  … 既存 §12.1②
  ▼
Scan-Chat-AI   POST /api/admin/impersonation/handoff        [新設・ADMIN_API_KEY]
  │  ④ target_uid の実在確認 (diagnosis.app_users)
  │  ⑤ raw token = 32byte CSPRNG → DB には SHA-256(token) だけ保存
  │  ⑥ { url: "https://scan-chat-ai.vercel.app/admin/handoff/<raw>" } を返す
  ▼
wellfort-site → ブラウザ  ⑦ window.open(url)  （raw token は ここで初めてブラウザへ）
  ▼
Scan-Chat-AI   GET /admin/handoff/<raw>                     [新設]
  │  ⑧ SHA-256 して DB 照合 / 未使用 / 未失効 / 期限内 を確認
  │  ⑨ **単一使用**: consumed_at を条件付き UPDATE で確定 (二重消費を DB で防ぐ)
  │  ⑩ impersonation session を発行 → Set-Cookie
  ▼
  302 /dashboard     ← URL に UID も token も含まない
```

### 12.3 handoff token の要件

| 要件 | 内容 |
|---|---|
| 生成 | `crypto.getRandomValues` 32 byte → base64url（**256bit**） |
| 推測不能性 | target_uid を含めない・連番にしない・時刻から導出しない |
| 有効期間 | **60 秒**（画面を開くまでの時間だけあればよい） |
| 単一使用 | `update … set consumed_at = now() where id = ? and consumed_at is null` の**更新行数が 1 のときだけ成立** |
| DB 保存 | **`sha256(raw)` のみ**。raw は保存しない |
| ログ | **カスタムアプリケーションログには raw を絶対に記録しない。** ただし **raw は URL path に載るので、Vercel / CDN / プロキシのアクセスログには残り得る**。これは消せないので、**60 秒・単一使用・consumed 後即失効・`Referrer-Policy: no-referrer`** でリスクを限定する（詳細は §12.6） |
| 権限 | **handoff token を知っているだけで永続 admin 権限にはならない**。得られるのは「その 1 顧客の代理表示セッション」だけ |

### 12.4 「handoff token を知っていれば代理表示できる」ことの評価

これは**意図した性質**である（one-time bearer）。緩和策:

1. 60 秒・単一使用・使用後即失効
2. 発行できるのは **verifyAdmin を通った人だけ**（§12.1①）
3. **得られる権限は「その顧客の一般ユーザー画面」だけ**。admin 画面・admin API には入れない
4. 発行と消費を監査ログに残す（誰が・いつ・どの顧客を開いたか）

### 12.5 代理表示セッションで書き込みを許すか

**許さない**（`writeTargetUid = null`・§9.3）。

理由: 現行の `api/scan/save.ts:32-35` が既に「代理表示中に保存すると相手の検査結果を
勝手に作ることになる」として明示的に禁じている。**この判断を新方式でも維持する。**
admin がサポート目的で相手の画面を見るだけなら書き込みは要らない。

> **未確定**: 「admin が代理で問診・スキャンを代行入力したい」という運用要望が出た場合は
> 別途の裁定が要る（§38-U5）。

### 12.6 raw token を URL path に置くことの扱い（**§12.3 のログ欄と同一の記述**）

`GET /admin/handoff/<raw>` は raw token が URL に乗る。**この事実は消せない。**
「アクセスログにも残らない形にする」とは書かない — **できないことを仕様に書かない**。

| | 方針 |
|---|---|
| **カスタムアプリケーションログ** | **raw token を絶対に記録しない**（自分たちが書くログは完全に統制できる） |
| **Vercel / CDN / プロキシのアクセスログ** | **残り得る**。URL path なので不可避。**残る前提で設計する** |
| 緩和① | **有効期間 60 秒**。ログが読まれる時点ではまず失効している |
| 緩和② | **単一使用**。`consumed_at` の条件付き UPDATE で、1 度使われたら 2 度目は通らない |
| 緩和③ | **consumed 後は即失効**。正規の利用者が開いた時点で、ログに残った値は無価値になる |
| 緩和④ | 応答は **302 で即座に別 URL へ**（画面を描かない＝Referer を作らない） |
| 緩和⑤ | **`Referrer-Policy: no-referrer`**（§28.2） |
| 残存リスク | **発行から 60 秒以内に、まだ誰も開いていない状態でアクセスログを読める者**は代理表示に入れる。これは受容する（そのログを読める者は通常インフラ管理者であり、別の経路をすでに持つ） |

**代案の評価**: `POST /admin/handoff` に raw を body で渡す（自動 POST の中間 HTML）。
**採らない** — UX を落とし、かつ**中間 HTML 自体が token を含む文書**になるので利点が薄い。
**GET ＋ 60 秒 ＋ 単一使用**を推奨する。

---

## 13. Admin Impersonation Session

### 13.0 【最重要・既存機能の退行になる】複数タブ問題

**現行の `?u=` 方式はタブごとに対象を保持している。** リンクは
`target="_blank"`（`wellfort-site/src/pages/admin/customers.astro:439`）で新しいタブに開き、
**対象は URL クエリが持つ**ので、A 顧客のタブと B 顧客のタブが**独立して成立する**。

**Cookie 1 本（`welltect_imp_v` / `Path=/`）に target を持たせると、これが壊れる。**

```
① A 顧客を開く      → Set-Cookie: welltect_imp_v = <session_A>   （target = A）
② B 顧客を別タブで  → Set-Cookie: welltect_imp_v = <session_B>   （target = B・A を上書き）
③ A のタブで「報告書」へ遷移
   → Cookie は session_B  → **B 顧客の報告書が出る**
```

**admin が「A さんの画面だと思って B さんのデータを見る」**という、
サポート業務として最悪の種類の事故になる。しかも**画面に UID が出なくなった後なので
気づきにくい**（現行は URL の `?u=` で分かる）。

> **これは本改修が持ち込む退行であり、許容できない。** 設計で潰す。

#### 案 A — 1 ブラウザ 1 代理対象に制限する

Cookie 1 本のまま。②で B を開いた時点で **A のタブは次の遷移で「代理表示が切り替わりました」と表示して止める**
（session id をページに埋めて、遷移先で Cookie と突き合わせる）。

| | |
|---|---|
| 利点 | 実装が最小。Cookie 1 本のまま |
| 欠点 | **現行できていた「2 顧客を並べて見る」ができなくなる＝機能の後退**。`target="_blank"` の導線と噛み合わない（新しいタブで開く UI なのに並べられない） |
| 誤作動時 | 「切り替わりました」を出せるので**黙って別人を見る事故にはならない**（最低限の安全は確保できる） |

#### 案 B — タブ単位の opaque な view-context（**推奨**）

**URL の path に「どの代理表示か」を示す opaque な ID を置く。** UID は出さない。

```
/admin-view/<opaque-context>/dashboard
/admin-view/<opaque-context>/report
/admin-view/<opaque-context>/trend
/admin-view/<opaque-context>/result/<artifact_id>
…
```

| 項目 | 内容 |
|---|---|
| `<opaque-context>` | **32byte CSPRNG の base64url**。**target_uid から導出しない・含まない・推測できない** |
| 単独では使えない | **`welltect_v`（admin 本人の認証 Cookie）と組み合わせないと解決しない。** context を知っているだけの第三者は 403 |
| 解決 | `sha256(context)` → `admin_impersonation_sessions` → `{ admin_identity, target_uid, … }`。**`admin_identity` が Cookie の admin 本人と一致することを必ず検証する** |
| タブ分離 | **path が違えばタブごとに別 context** → A タブは A のまま、B タブは B のまま |
| Cookie | **`welltect_imp_v` は不要になる**（context が path にあるので Cookie で持たなくてよい）。§23 の Cookie を 1 本減らせる |
| URL への UID 露出 | **無い**（目的を維持） |

**「URL に識別子を出さない」という目的との整合**: 本改修が消したかったのは
**`diagnostic_user_id`（対象者を一意に指す、通年不変の、他システムとも突き合わせられる識別子）**であって、
**「URL に何も書かない」ことではない**。`<opaque-context>` は

- ランダムで target を推測できない
- **admin 本人の Cookie が無ければ何の権限も生まない**（bearer ではない）
- セッションの終了・期限切れで無効になる（通年不変ではない）

ので、`?u=<uid>` とは性質が違う。**目的は維持される。**

#### 判断

**案 B を推奨。** 現行の `target="_blank"` による複数タブ運用を壊さず、UID も出さない。

**案 B の追加コスト**: 代理表示中のページ・リンクをすべて `/admin-view/<ctx>/…` 配下で扱う必要がある。
`viewerLinkQuery()` を置き換える形で **`viewerPathPrefix(viewer)`**（`''` か `/admin-view/<ctx>`）を
`viewer.ts` に持ち、**リンクの組み立てを引き続き 1 か所に集約する**のが素直
（`url_uid_privacy_spec_20260929.md` §4.2 と同じ規律）。

> **未確定**: Astro のルーティングで `/admin-view/[ctx]/[...rest]` と既存ページを
> **二重に書かずに**同居させる方法（rewrite / 共通コンポーネント化 / middleware）。
> **middleware は §28.3 の方針で避けたい**ので、実装前に方式を 1 つ選ぶ（§38-U20）。

### 13.1 セッションの持ち方（**案 B 採用時 = Cookie を使わない**）

| 項目 | 案 B（推奨） | 案 A（不採用） |
|---|---|---|
| 置き場所 | **URL path の `<opaque-context>`** | Cookie `welltect_imp_v` |
| 値 | 32byte CSPRNG base64url。**target_uid を含めない** | 同左 |
| 単独での効力 | **無し**（`welltect_v` の admin 本人と一致して初めて成立） | Cookie 単体で成立 |
| タブ分離 | **できる** | できない（§13.0） |
| 有効期間 | **60 分**（DB の `expires_at`。`welltect_v` の 30 日に合わせない） | 同左 |

**どちらの案でも `welltect_v` は消さない**（P3）。既存の本人セッションが残るので、
代理表示を終えれば admin 本人へ即座に戻れる（§13.3）。

### 13.2 サーバ側の解決

```
URL path の <opaque-context>            （案 B）
   → sha256 → diagnosis.admin_impersonation_sessions.session_digest
   → { admin_identity, target_uid, target_origin, expires_at, revoked_at }
   → **welltect_v の admin 本人 == admin_identity を検証**   ← ここが必須
   → 不一致 / 期限切れ / revoked / 非 admin  ならすべて 403（理由を区別しない）
```

**`<opaque-context>` 単体では何の権限も生まない。** bearer token ではなく
**「admin 本人の認証 Cookie と組み合わせて初めて解決できる参照キー」**である。
これが handoff token（§12・bearer）との決定的な違いで、
**URL path に置いても安全**な理由でもある。

**target_uid を Cookie にも URL にも入れない理由**: 署名付きなら改竄はできないが、
**Cookie も URL も本人（および端末を触れる誰か）が読める**。
`welltect_v` は自分の uid なので問題にならないが、**代理表示では「他人の uid」を
admin のブラウザに置くことになる**。URL から消した意味が薄れるので、DB 引きにする。

> **トレードオフ（実装時に測る）**: 全リクエストで DB を 1 回引く。
> ページは既に Supabase を引いているので追加 1 クエリで済む見込みだが、
> **未計測**（§38-U6）。許容できなければ「短命（5〜10 分）の署名付き Cookie ＋
> 失効リストを DB で持つ」形へ落とす。

### 13.3 代理表示の終了

- 画面に **「代理表示を終了する」** を出す（現在そういう導線は無い＝実測）
- `POST /api/admin/impersonation/end`（body に対象 context）→ その session だけを
  `revoked_at` で失効 → `/dashboard` へ
- **`welltect_v` は消さない**ので、admin 本人の画面へそのまま戻る
- セッション期限切れ（60 分）でも同じ状態になる
- **案 B では「そのタブの代理表示だけ」が終わる。** 他のタブで開いている別顧客の
  代理表示は生き続ける（§13.0 の目的そのもの）。**「すべての代理表示を終了」も別に用意する**
  （admin が席を離れるときに 1 操作で全部切れるようにする）

### 13.4 代理表示中であることの表示

**必須。** 現在も「いま誰の画面を見ているか」の表示は無い（実測）。
UID を URL から消すと**見分けがつかなくなる**ので、
画面上部に帯を出す（例: `代理表示中: <顧客名の頭文字> / <契約番号>` ＋ 終了ボタン）。

> **未確定**: 帯に何を表示するか。**氏名は PII** なので `diagnosis` 側からは引けない。
> 顧客の識別に何を使うかは発注者判断（§38-U4）。

---

## 14. Share Link

### 14.1 URL

```
https://scan-chat-ai.vercel.app/share/<opaque-token>
```

**含めないもの**: `diagnostic_user_id` / Supabase `user_id` / email / 氏名 / 連番 / 推測可能な ID。

### 14.2 token

| 項目 | 案 |
|---|---|
| 生成 | `crypto.getRandomValues` 32 byte（**256bit**）→ base64url（43 文字） |
| 扱い | **Bearer credential**（知っている人が使える。これが UX の本体） |
| DB 保存 | **`sha256(raw)` のみ**（§15） |
| 有効期間 | 発行時に `starts_at` / `expires_at` を設定 |
| 状態 | `active` / `paused` / `revoked` |

### 14.3 なぜ 256bit か

総当たりを実務上不可能にするため。128bit でも十分だが、
**URL が 1 本しか無い＝これが唯一の認証要素**なので余裕を取る。
併せてレート制限（§31 T-4）を入れる。

---

## 15. Share token の保存（hash-only を推奨）

### 15.1 推奨案 — hash-only

- DB には `token_hash = sha256(raw)` だけ
- **raw が読めるのは発行の瞬間だけ**。admin 画面で「URL をコピー」して渡す
- 後から同じ URL は**復元できない**。必要なら「URL 再発行」で新 token を作り、旧 token は即失効

**利点**: DB が漏れても URL は再現できない。運用者も見られない。
**欠点**: 「さっきの URL をもう一度教えて」に応えられない。

### 15.2 比較案 — 暗号化保存

`AES-GCM(raw, key)` を保存し、admin 画面で復号して再表示する。

**利点**: 何度でも再コピーできる。
**欠点**: 鍵を持つサーバなら常に平文化できる＝**DB 漏洩＋鍵漏洩で全共有 URL が漏れる**。
「運用者も見られない」という説明ができなくなる。

### 15.3 判断

**hash-only を推奨。** 再コピーの要望は「再発行」で満たせる
（旧 URL が失効するのは**むしろ正しい**＝前に渡した相手が使えなくなるのが可視化される）。

> **未確定**: 「同じ URL を後から何度でも再コピーしたい」が業務上の必須要件かは
> 発注者へ確認する（§38-U2）。必須なら §15.2 と再比較する。

---

## 16. Pending Session（同意前）

### 16.1 なぜ挟むか

`GET /share/<token>` でいきなりダッシュボードを出すと

1. **同意前に健康情報が表示される**
2. **raw token を持ったまま以後の画面を歩く**ことになりかねない

→ **token 検証 → 短命 pending セッション → 302 `/share/consent`** とし、
**raw token を通常画面へ持ち回らない**。

### 16.2 pending Cookie

| 項目 | 案 |
|---|---|
| 名前 | `welltect_share_pending` |
| 値 | **opaque**。**target_uid を入れない** |
| 有効期間 | **10 分**（同意画面を読む時間） |
| 属性 | `HttpOnly` / `Secure` / `SameSite=Lax` / `Path=/` |

### 16.3 `/share/<token>` の応答

| 状況 | 応答 |
|---|---|
| 有効 | pending 発行 → `302 /share/consent` |
| 期限前（`starts_at` 未到達） | `/share/unavailable`（理由は「まだ利用できません」まで） |
| 期限切れ / paused / revoked / 不一致 / 不存在 | **すべて同一の `/share/unavailable`** |

**不一致と不存在を区別できる応答を返さない**（`result-queries.ts` の所有者検証と同じ規律）。

---

## 17. Consent（同意画面）

### 17.1 文案（たたき台）

```
共有閲覧に関する確認

本ページでは、不正利用防止およびアクセス管理のため、Cookie を使用し、
接続元 IP アドレス、ブラウザ情報、アクセス日時等を記録します。

これらの情報は、本共有ページのアクセス管理およびセキュリティ確認を
目的として使用します。

［ 同意して利用する ］   ［ 利用を中止する ］
```

- **ボタンは「同意して利用する」**。「閲覧する」だと AI 問診・AI スキャンの利用を含みにくい
- **法的義務だと断定しない。** Welltect のアクセス管理要件として書く
- 同意記録は `shared_access_sessions.consented_at`

> **未確定**: 対象者本人の氏名を同意画面に出すか。出すと**共有相手に PII を渡す**ことになる。
> 業務上は「誰のデータを見るのか」を明示したいはずなので、**発注者判断**（§38-U3）。

### 17.2 Share 権限（scope）

**External Share は「対象ユーザーとして一般機能を利用できるセッション」。読み取り専用ではない。**

```ts
type ShareScope = {
  view: true;          // dashboard / report / trend / result / kit / notices の「閲覧」
  interview: boolean;  // AI 問診（既定 true）
  scan: boolean;       // AI スキャン（既定 true）
};
```

**`view` は閲覧だけを意味する。更新を伴う操作は `interview` / `scan` に限る。**

発注者が明示的に許可した更新は **AI 問診と AI スキャンの 2 つ**であり、
それ以外の更新は scope に含まれない。したがって

| 操作 | 判定 | 理由 |
|---|---|---|
| `POST /api/kit/[id]/self-report`（受取済・返送済の自己申告） | **BLOCK** | **本人の配送状態**を外部共有者が変更してはいけない。キットの受け取りは対象者本人しか知り得ない事実で、外部相手が代わりに申告すると**進捗が実態と食い違い、以後の出荷・検査の段取りが狂う** |
| `POST /api/notices/[id]/read`（既読化） | **BLOCK** | **本人の既読状態**を外部共有者が変えてはいけない。本人が未読のお知らせが勝手に既読になると、**重要な通知を見落とす** |

**`/kit` と `/notices` のページ閲覧そのものは許可する**（`view`）。
**画面は見えるが、自己申告ボタンと既読化は効かない**という形にする。

> **UI 上の扱い**: share セッションでは自己申告ボタンを**描かない**
> （押せるのに 403 が返るのは不親切）。サーバ側は描画に関わらず **403 で拒否する**
> （UI を消しただけでは API 直叩きを防げない）。

これは §25.2 の Access Matrix と一致させる。**scope に無い更新は既定 BLOCK**、が原則。

| 概念上の値 | share セッション |
|---|---|
| `kind` | `'share'` |
| `uid`（＝targetUid） | share link の `target_uid` |
| `selfUid` | **null** |
| `isAdmin` | **false**（固定） |
| `impersonating` | **false** |
| `targetLocked` | **true** |
| `writeTargetUid` | **targetUid**（scope が許す機能のみ） |

### 17.3 許可するもの（発注者要件・§4 原文）

- Dashboard 閲覧 / 検査結果閲覧 / グラフ操作 / AI疾病予防報告書閲覧 / キット進捗の閲覧 / お知らせの閲覧
- **AI 問診** … 開始・回答・音声入力・テキスト入力・AI 応答・完了・
  **現行 DB 更新 / 完了記録 / S3 出力 / 進捗反映を許可**
- **AI スキャン** … ファイル選択・解析・結果確認・結果編集・完了・
  **現行 DB 保存 / artifact 作成 / measurement 保存 / S3 出力 / 後続処理を許可**

**「デモ専用」「dry-run」「temporary mode」にはしない。**

### 17.4 禁止するもの

- Wellfort Admin 画面 / Scan-Chat-AI Admin API / 顧客管理 / 管理設定変更 / 権限変更
- share link の管理 / admin 代理表示の開始 / 他ユーザーへの切替
- URL・body による target 変更 / 対象外ユーザーのデータ参照・保存
- **キット受取・返送の自己申告**（`/api/kit/[id]/self-report`・§17.2）
- **お知らせの既読化**（`/api/notices/[id]/read`・§17.2）
- **通常本人セッションの発行・削除**（`/api/auth/resolve` / `/api/auth/signout`・§17.5）

### 17.5 共有中に通常本人の認証セッションへ触らせない

**share 利用中に `welltect_v` を発行・削除する必要は無い。**

| API | share での扱い | 理由 |
|---|---|---|
| `POST /api/auth/resolve` | **BLOCK** | share セッションから叩かれても意味が無い。**通す理由が無いものは通さない** |
| `POST /api/auth/signout` | **BLOCK** | **共有相手の操作で、その端末の持ち主（＝別人かもしれない）の本人セッションを消させない** |
| `POST /api/auth/refresh-admin` | **BLOCK**（従来どおり） | admin フラグの再取得。share には無関係かつ危険 |

**共有の終了は専用の `/share/end` が担う。**
`/share/end` は **`welltect_share_v` だけを失効・削除し、背後の `welltect_v` には一切触れない。**

> 共有相手の端末にたまたま別人の `welltect_v` が残っている状況
> （共有オフィス PC・家族の端末）を想定している。**共有セッションの操作が
> 本人セッションを壊さない**ことを構造で保証する。

---

## 18. Share Session

### 18.1 Cookie

| 項目 | 案 |
|---|---|
| 名前 | `welltect_share_v` |
| 値 | **opaque session id**（32byte CSPRNG）。**target_uid を入れない** |
| 属性 | `HttpOnly` / `Secure` / `SameSite=Lax` / `Path=/` |
| 有効期間 | **`min(発行から N 時間, share_link.expires_at)`**。link の期限を超えない |

### 18.2 サーバ側の解決

```
welltect_share_v (opaque)
  → sha256 → diagnosis.shared_access_sessions.session_digest
  → shared_access_links
  → { target_uid, target_origin, scope, status, starts_at, expires_at }
```

**毎リクエストで link 側の `status` / `starts_at` / `expires_at` を見る**（§27）。
セッションだけを見ると **revoke が効かない**。

### 18.3 同意後の遷移

```
POST /share/consent  (同意)
  → pending session を消費
  → share session 発行 (Set-Cookie)
  → 302 /dashboard
```

以後 `/dashboard` `/report` `/trend` `/result/...` `/chat` `/scan` `/kit` `/notices` は
**URL に UID も token も出さない**。

---

## 19. AI 問診の Share 対応（現行経路の全追跡）

### 19.1 現行フロー（実測）

```
/chat  (src/pages/chat.astro)
 ├ :15  resolveViewer(Astro)
 ├ :16  diagnosticUserId = viewer.uid
 ├ :18  linkQuery = viewerLinkQuery(viewer)
 ├ :77  <main data-diagnostic-user-id={diagnosticUserId}>          ← DOM へ埋め込み
 └ :78  <main data-dashboard-link-query={linkQuery}>
        ↓
src/scripts/chat/live-controller.ts
 ├ :365  refs.diagnosticUserId = main.dataset.diagnosticUserId
 ├ :934  POST /api/interview/classify-voice   { question, transcript, options }   ← uid を送らない
 ├ :1109 POST /api/live-token                 { diagnosticUserId: refs.diagnosticUserId }
 ├ :1440 (exportInterviewToS3)                { diagnosticUserId: opts.uid, ... }
 └ :1459 POST /api/interview/export
```

### 19.2 各 API が最終的に何をするか

| API | 参照 | 更新（DB） | 更新（S3） | uid の出所 |
|---|---|---|---|---|
| `/api/interview/classify-voice` | Gemini のみ | なし | なし | **送らない** |
| `/api/live-token` | `buildUserContextForChat` / `getCustomerProfile`（**customer スキーマ = PII**）/ `getAppliedExamLabels` | なし | なし | **body**（`:26-28`） |
| `/api/insight` | `buildUserContextForChat` | なし | なし | **body**（`:30`） |
| `/api/interview/export` | — | **`diagnosis.interview_completions` へ insert**（`lib/interview-completion.ts:44-60`） | **`{prefix}user/{client_id}/date/{YYYY_MM_DD}/LifestyleQuestionnaireData_*.json`**（`lib/interview-export.ts:281-282`） | DB は `viewer.selfUid`（**安全**）/ **S3 は body**（**危険**） |

### 19.3 下流への波及

`interview_completions` は

- `/dashboard` の「進捗」① AI 問診 の完了判定（`ProgressSection.astro`）
- `elith-delivery.ts` の「その回の予定検査が揃ったか」判定

に効く。S3 の `LifestyleQuestionnaireData_*.json` は **Elith の AI 診断の入力**そのもの。

### 19.4 Share 対応で変えること

| 対象 | 変更 |
|---|---|
| `chat.astro:77` の `data-diagnostic-user-id` | **撤去する。** クライアントは uid を持たない |
| `live-controller.ts:1112` の `{ diagnosticUserId }` | **送らない** |
| `live-controller.ts:1440` の `{ diagnosticUserId, clientId }` | **送らない** |
| `/api/live-token` | `resolveViewer(ctx)` → `viewer.uid` を使う。**body は読まない** |
| `/api/insight` | 同上 |
| `/api/interview/export` | DB は `viewer.writeTargetUid`、**S3 の `client_id` も `viewer.writeTargetUid`**。body の `clientId` / `diagnosticUserId` は捨てる |

**これで share でも self でも同じコードが走り、target だけが resolver で決まる。**

### 19.5 【Phase 0 必須】対象者の profile metadata もクライアントから信用しない

**未確定事項から昇格（レビュー 2026-09-30）。外部共有の公開前に必須。**

現在 `userName` / `dateOfBirth` / `sex` は**クライアントの `userProfile` から送られている**
（`live-controller.ts:1441-1443` → `api/interview/export.ts:104-107`）。
`:106` に「年齢算出のみ (保存しない)」とあるが、**これは「DB に保存しない」という意味であって、
出力に影響しないという意味ではない**。

| 値 | 流れ込む先 | 影響 |
|---|---|---|
| `dateOfBirth` | `buildElithInterviewJson()` の年齢算出 → **`LifestyleQuestionnaireData` の JSON 内容** | Elith の AI 診断入力が変わる |
| `sex` | 同上 | 同上 |
| `userName` | 同上 | 納品 JSON に載る |

→ **UID だけを Target Lock しても不十分。** `clientId` / `diagnosticUserId` と同じく、
**対象者の profile metadata を改竄すれば、対象者本人の正式な AI 入力を汚染できる。**

**方針（share / self とも共通）**

1. **クライアントから送られた `userName` / `dateOfBirth` / `sex` を採用しない。**
   受け取っても捨てる（互換のため受理はしてよいが、値は使わない）。
2. **サーバ側 target resolver が確定した target_uid から取り直す。**
   取得元は既存の経路を使う:
   - `customer_profiles`（`lib/elith-delivery.ts:78` が既に引いている）
   - スペシャルアカウントの登録 DOB（`specialSubjectByUid`・CLAUDE.md「スペシャルアカウント」）
   - `test_artifacts.age_at_test` / `sex`（`elith-delivery.ts:223`）
3. **取れなければ「不明」として出す。クライアントの値で埋めない**（捏造ゼロ）。
4. `chat.astro` / `live-controller.ts` から profile の埋め込みと送信を撤去する。

> **`buildUserContextForChat` / `getCustomerProfile` も同じ扱い**（§11-#2）。
> これらは PII（`customer` スキーマ）を読むので、**target がサーバ側で確定してから呼ぶ**。

---

## 20. AI スキャンの Share 対応（現行経路の全追跡）

### 20.1 現行フロー（実測）

```
/scan  (src/pages/scan.astro)
 ├ :39  resolveViewer(Astro)
 ├ :40  diagnosticUserId = viewer.uid
 ├ :43  uploads = getUserUploads(diagnosticUserId)
 └ :60  multiYear = isSpecialAccount(diagnosticUserId)
        ↓
 [画像取得]
 ├ src/scripts/scan-upload.ts:188  POST /api/scan/upload-ticket  { contentType, bytes }
 │        → presigned PUT → ブラウザ → S3 {prefix}scan-uploads/YYYY/MM/DD/<uuid>.<ext>
 └ src/scripts/camera-scan.ts:201  POST /api/scan               { image | imageKey, hint }
          → Gemini で読み取り（保存はしない）
        ↓
 [送信]
 ├ 背景経路: scan.astro:1138  POST /api/scan/jobs   { keys, hint, diagnosticId, sourceFileName }
 │     → api/scan/jobs.ts:39  uid = viewer.selfUid        ← **安全**
 │     → diagnosis.scan_jobs へ enqueue
 │     → GET /api/cron/scan-worker（毎分・Bearer CRON_SECRET）
 │         ├ :150-152  saveScanResult({ diagnosticUserId: job.diagnostic_user_id, … })
 │         └ :180-182  putScanExport(md, { diagnosticUserId: job.diagnostic_user_id, … })
 └ 前景経路: scan.astro:980   POST /api/scan/save   { markdownClean, pageCount, examDate }
       │     → api/scan/save.ts:36  uid = viewer.selfUid  ← **安全**
       └ scan.astro:1035  POST /api/scan/export  { markdownClean, diagnosticId, diagnosticUserId, … }
             → api/scan/export.ts:56  body.diagnosticUserId  ← **クライアント申告**（§11-#5）
```

### 20.2 最終的な書き込み先

| 経路 | 書き込み先 | 根拠 |
|---|---|---|
| `saveScanResult()` | `diagnosis.test_artifacts` へ insert（`scan_md` / `test_date` / `source` ほか） | `lib/scan-persist.ts:103-121` |
| ↑ に続けて | `persistMeasurements()` が **`test_artifacts.measurements`(jsonb) と `diagnosis.measurement_values` の 2 層**へ | `lib/scan-persist.ts:131-138`、CLAUDE.md「検査値と原本の保存」 |
| `putScanExport()` | S3 `{prefix}{diagnosticId}/` に JSON/MD | `lib/scan-export.ts:272` |
| 下流 | `diagnosis.health_age_scores`（ウェルネス年齢）/ `elith_deliveries` / Elith 納品 | `lib/elith-delivery.ts:276, 401` |
| 受診日ガード | スペシャルアカウントのみ `date_source='today'` を `blocked` で差し戻し（**insert 前**） | `scan-persist.ts:83`、`api/scan/save.ts:57-60` |

### 20.3 Share 対応で変えること

| 対象 | 変更 |
|---|---|
| `api/scan/save.ts:36` | `viewer.selfUid` → **`viewer.writeTargetUid`** |
| `api/scan/jobs.ts:39` | 同上 |
| `scan.astro:1015` | **`location.search.get('u')` を撤去**（§11.1 の副作用もここで消える） |
| `api/scan/export.ts:56` | body ではなく `viewer.writeTargetUid` |
| `api/scan/upload-ticket.ts` | キーはサーバ採番（現状のまま）。**追加の変更不要** |
| `api/scan.ts` | 読み取りのみで保存しない。**変更不要** |
| `scan-worker` | `job.diagnostic_user_id` のまま。**変更不要** |
| `scan.astro:60` `isSpecialAccount(viewer.uid)` | **target で判定する**のが正しい（share でも対象者の属性で動くべき） |

---

## 21. API Authorization（方針）

### 21.1 分類

| クラス | 認可 | 例 |
|---|---|---|
| **A. 一般ユーザー API** | `resolveViewer()` で target を解決。**body の uid を認可根拠にしない** | `scan/save` `scan/jobs` `scan/export` `interview/export` `live-token` `insight` `coach/ask` `kit/[id]/self-report` `notices/[id]/read` |
| **B. Admin API** | `checkAdminAuth(request)`（Bearer `ADMIN_API_KEY`） | `api/admin/**` |
| **C. Cron** | Bearer `CRON_SECRET`（`ADMIN_API_KEY` も可） | `api/cron/**` |
| **D. Ops / Debug** | `PROBE_UPLOAD_TOKEN` | `api/ops/**` `api/debug/viewer` |

### 21.2 共有セッションからの到達可否

- **A は ALLOW（target lock 付き）**
- **B / C / D は BLOCK**

B は Bearer キーが要るので share Cookie では通らない（**現状で既に閉じている**）。
ただし **D の `api/debug/viewer` は `viewer` を露出する**ので、
share セッションから叩かれたときに何を返すかを決める必要がある（§25 / §38-U8）。

### 21.3 `resolveViewer()` を通っていない一般 API（実装時の必須対応）

`api/live-token.ts` / `api/insight.ts` / `api/coach/ask.ts` / `api/scan/export.ts` /
`api/kit/[id]/self-report.ts` / `api/notices/[id]/read.ts` は
**現在 `resolveViewer` を import していない**（実測）。全部通す。

### 21.4 【Phase 0 必須】**誰でも叩ける AI / S3 コスト API**（target UID とは別問題）

**実測（`grep -c` で確認）**: 以下 6 本は `resolveViewer` も `checkAdminAuth` も
`cookies` も**一切参照していない＝完全に未認証で叩ける**。

| API | 未認証で起きること | コスト要因 | 既存の歯止め | 根拠 |
|---|---|---|---|---|
| **`POST /api/scan`** | **任意の画像を Gemini へ投げられる**（本アプリで最も高価な呼び出し。画像 1 枚 = 数十秒） | Gemini（`readScanPage`） | **無い**（body サイズは Vercel の 4.5MB だけ） | `api/scan.ts:38-54`、`resolveViewer` 0 件 |
| **`POST /api/scan/upload-ticket`** | **S3 への presigned PUT を無制限に発行できる**（1 件 10MB まで・15 分有効） | S3 書き込み・ストレージ | `MAX_SCAN_UPLOAD_BYTES`（1 件あたりのサイズのみ。**発行回数の制限は無い**） | `scan/upload-ticket.ts:32`、`lib/scan-upload-ticket.ts:44,109` |
| **`POST /api/interview/classify-voice`** | Gemini を叩ける | Gemini | 入力長のみ（`MAX_TRANSCRIPT=200` / `MAX_OPTIONS=40`・`:29-39`） | `interview/classify-voice.ts` |
| **`POST /api/insight`** | Gemini を叩ける ＋ **body の uid で他人の文脈を読める**（§11-#3） | Gemini | 無い | `insight.ts:30,42,68` |
| **`POST /api/coach/ask`** | 同上（§11-#4） | Gemini | 無い | `coach/ask.ts:83,94,114` |
| **`POST /api/live-token`** | **Gemini Live の ephemeral token を発行できる**（30 分・§27.3）＋ 他人の文脈（§11-#2） | Gemini Live | 無い | `live-token.ts:24-46` |

**「UID を使っていないから安全」とは判断しない。** `/api/scan` と
`/api/scan/upload-ticket` は **UID を一切扱わない**が、
**課金とストレージを他人に使わせる経路**として最も露出が大きい。

#### 方針

**外部共有の公開前に、この 6 本へ「正規の viewer / session のいずれかを要求する」を入れる。**

```
許可する主体 = kind ∈ { 'self', 'admin_self', 'admin_impersonation', 'share', 'uid_entry' }
拒否         = kind === 'anonymous'  → 401
```

- **share セッションも正規の主体として通す**（共有相手はスキャン・問診を使うので）
- `/api/scan` と `/api/scan/upload-ticket` は **target を持たない**（読むだけ・キーはサーバ採番）
  ので、**target lock は不要。要求するのは「正規の主体であること」だけ**
- `upload-ticket` には**追加でレート制限**（viewer あたりの発行数／時間）を検討する。
  認証を付けても、正規利用者 1 人が無制限に発行できる状態は残る

> **未確定**: 未認証を塞ぐと**サインイン前のお試し利用**が壊れないか。
> 現状 `/scan` `/chat` `/coach` はいずれも `resolveViewer` を通し、
> **未サインインではサインインゲートを出す**（`coach.astro:79` など）ので、
> **正規の画面からは未認証でこれらの API を呼ばない**と読める。ただし
> **実測で確認していない**ので、実装時に「未サインインで `/scan` を開いて
> 撮影できてしまう経路が無いか」を確かめる（§38-U21）。

---

## 22. DB Schema（案）

**既存の `diagnosis` スキーマに置く**（非 PII。`diagnostic_user_id` しか持たない）。

### 22.1 `diagnosis.shared_access_links`

| 列 | 型 | 備考 |
|---|---|---|
| `id` | uuid pk | |
| `target_uid` | uuid not null → `app_users(diagnostic_user_id)` | 共有される人 |
| `target_origin` | text not null default `'production'` | `production` / `staging`（§29） |
| `label` | text | 「助成金事務局 確認用」など |
| `purpose` | text | 自由記述 |
| `token_hash` | text not null unique | **`sha256(raw)` のみ**。raw は保存しない |
| `starts_at` | timestamptz | null = 即時 |
| `expires_at` | timestamptz not null | |
| `status` | text not null default `'active'` | `active` / `paused` / `revoked` |
| `scope` | jsonb not null | `{ view, interview, scan }` |
| `created_by` | text | 発行した admin の識別子（email ハッシュ等・§38-U9） |
| `created_at` / `updated_at` / `revoked_at` | timestamptz | |

同一 `target_uid` に**複数 link を許す**（用途ごとに発行・個別に停止）。

### 22.2 `diagnosis.shared_access_sessions`

| 列 | 型 | 備考 |
|---|---|---|
| `id` | uuid pk | |
| `share_link_id` | uuid not null → `shared_access_links(id)` | |
| `session_digest` | text not null unique | `sha256(cookie値)` |
| `viewer_id` | text | 匿名 viewer 相関 ID（§31.1） |
| `consented_at` | timestamptz | |
| `expires_at` | timestamptz not null | **link の expires_at を超えない** |
| `revoked_at` | timestamptz | |
| `last_seen_at` | timestamptz | |
| `created_at` | timestamptz | |

pending セッションは `consented_at is null` の行として同じ表に置く（別表にしない）。

### 22.3 `diagnosis.shared_access_logs`

| 列 | 型 |
|---|---|
| `id` uuid pk / `share_link_id` uuid / `session_id` uuid / `viewer_id` text |
| `event_type` text（§26） |
| `path` text（**UID を含めない**） |
| `ip_hmac` text（§32） |
| `user_agent` text |
| `created_at` timestamptz |

### 22.4 `diagnosis.admin_impersonation_handoffs`

`id` / `token_hash`(unique) / `admin_identity` / `target_uid` / `target_origin` /
`expires_at` / `consumed_at` / `created_at`

### 22.5 `diagnosis.admin_impersonation_sessions`

`id` / `admin_identity` / `target_uid` / `target_origin` / `session_digest`(unique) /
`expires_at` / `revoked_at` / `last_seen_at` / `created_at`

### 22.6 【必須】RLS

**この 5 表に `dev_read_all`（`using (true)`）を付けてはいけない。**
`supabase/migrations/20260601000020_rls_policies.sql:45` が
`grant select on all tables in schema customer to anon` をしており、`diagnosis` 側も
`anon` へ select が出ている表がある。**token_hash / session_digest が anon で読めると、
共有 URL の総当たりが不要になる**（hash を取れば照合できる）。

→ **`service_role` 以外に `select` を出さない**。アプリは常にサーバ側（service role）から引く。

---

## 23. Cookie 一覧（最終形）

| Cookie | 発行 | 内容 | 期限 | 目的 |
|---|---|---|---|---|
| `welltect_v` | `/api/auth/resolve` | 署名付き `uid.exp.admin[.s].sig` | 30 日 | **本人**（既存・変更しない） |
| ~~`welltect_imp_v`~~ | — | — | — | **案 B 採用により不要**（§13.0）。代理表示の状態は **URL path の `<opaque-context>`** が持つ。案 A を採る場合のみ復活する |
| `welltect_share_pending` | `/share/<token>` | **opaque** | 10 分 | 同意前 |
| `welltect_share_v` | `POST /share/consent` | **opaque** | link 期限以内 | 外部共有 |
| `welltect_share_viewer` | 初回共有アクセス | ランダム ID | 長め（1 年） | **匿名 viewer の相関のみ**（§31） |

全て `HttpOnly` / `Secure` / `SameSite=Lax` / `Path=/`。
（`welltect_share_viewer` は本人確認に使わないので `HttpOnly` でなくてもよいが、**付けて困らないので付ける**。）

---

## 24. Session Precedence（優先順位）

**「存在する Cookie のどれかが偶然勝つ」を禁止する。** 明示的に順序を決める。

### 24.1 順序（案）

```
1. URL が /admin-view/<ctx>/…  かつ welltect_v が admin 本人 かつ ctx が有効
                                    → kind='admin_impersonation'   （最優先・§13.0 案 B）
                                       ※ ctx が無効/不一致なら **403**。他の kind へ落とさない
2. welltect_share_v   が有効        → kind='share'
3. welltect_v         が有効 かつ ?u= かつ isAdmin
                                    → kind='admin_impersonation'（旧方式・§30 の移行期間のみ）
4. welltect_v         が有効        → kind='self' / 'admin_self'
5. ALLOW_UID_ENTRY=on かつ ?u=      → kind='uid_entry'
6. それ以外                          → kind='anonymous'
```

**1 を 2 より先に置き、しかも「失敗したら 403」にする理由**: 代理表示は
**URL が明示している**ので、解決に失敗したときに黙って別の主体（share や self）へ
落とすと、**admin が「A さんの画面のつもりで自分の画面を見る」**ことになる。
**URL が名指ししたものが出せないなら、何も出さない。**

### 24.2 share を最優先にする理由

共有相手が**たまたま自分の Welltect アカウントを持っている**場合
（例: 提携先の担当者が Wellfort の顧客でもある）、`welltect_v` が先に立つと
**共有 URL を開いたのに自分の画面が出る**。「URL を開くだけ」という約束が崩れる。

**明示的に共有 URL から入場した事実を優先する。**

### 24.3 元のセッションを消さない

`welltect_v` は**削除しない**。share は別 Cookie、代理表示は URL path（案 B）なので、
終了すれば元の状態へ戻る。

| 操作 | 結果 |
|---|---|
| 共有を終了（`POST /share/end` または期限切れ） | **`welltect_share_v` だけ**を失効・削除 → 4 へ落ちる。**`welltect_v` には触れない**（§17.5） |
| 代理表示を終了 | その context の session を失効 → 通常の `/dashboard` へ（admin 本人） |

### 24.4 【明文化】share Cookie が残ったまま通常 `/dashboard` を開いたとき

**§13.0 と同じ「混線」が share 側にも起こり得る。** 明文化しておく。

想定: 共有相手が Welltect の顧客でもあり、`welltect_v` と `welltect_share_v` を
同時に持っている状態で、**マイページ等から素の `/dashboard` を開く**。

**採る挙動 — 「share が続いている」ことを見せた上で、本人へ戻る手段を必ず出す。**

```
/dashboard を開く
  → welltect_share_v が有効 → kind='share'（§24.1 の順序 1 が勝つ）
  → 画面上部に常設の帯:
       「<ラベル> の共有ページを表示しています   ［ 共有を終了して自分の画面へ ］」
  → ボタン = POST /share/end → welltect_share_v だけ失効 → /dashboard へ戻る
       → welltect_v が残っているので **本人の画面が出る**
```

| 案 | 内容 | 判断 |
|---|---|---|
| **採用** | **share を勝たせる ＋ 常設の帯で状態を明示 ＋ 1 タップで終了できる** | 「URL を開くだけ」の約束を守りつつ、**黙って別人のデータを見ている状態を作らない** |
| 不採用 | `welltect_v` を優先する | **共有 URL を開いたのに自分の画面が出る**。「URL を開くだけ」が成立しない |
| 不採用 | 両方あるときはエラーにする | 共有相手を行き止まりにする。**UX 要件（§37）に反する** |
| 不採用 | share 開始時に `welltect_v` を消す | **他人のセッションを勝手に壊す**（§17.5） |

**帯は share セッション中の全ページに常設する**（`/dashboard` だけでなく
`/report` `/trend` `/result` `/chat` `/scan` `/kit` `/notices` すべて）。
代理表示の帯（§13.4）と同じ仕組みで出す。

> **admin 代理表示との対称性**: 代理表示は**案 B（URL path）でタブ単位に分離**するので
> この混線は起きない。share は Cookie なので**分離できず**、代わりに**常時の可視化と
> 1 タップの終了**で担保する。**share を URL path 方式にしない理由**は、
> 共有相手に渡す URL は `/share/<token>` の 1 本だけにしたい（UX 要件）ため。

### 24.5 admin が共有 URL を開いたら

**share が勝つ**（順序 1）。ただし `isAdmin = false` として扱うので、
**admin 権限は共有セッション中は使えない**。admin 作業へ戻るには共有を終了する。

> **未確定**: この挙動が運用上ストレスにならないか。
> 代案は「admin のときは share を拒否して警告」だが、**動作確認のために admin 自身が
> 共有 URL を踏む**のは普通の運用なので、share を勝たせるのが自然と考える（§38-U10）。

---

## 25. Access Matrix

**凡例**: `ALLOW` = そのまま許可 / `ALLOW+LOCK` = 許可するが target をセッションから固定 /
`BLOCK` = 403 / `—` = そもそも到達しない

### 25.1 ページ

| Route | Self | Admin 代理 | Share | Target Lock | 副作用 | 根拠 |
|---|---|---|---|---|---|---|
| `/` | ALLOW | ALLOW | ALLOW | — | 302 `/dashboard` | `index.astro:11-12` |
| `/dashboard` | ALLOW | ALLOW | **ALLOW+LOCK** | ✔ | 読み取りのみ | `dashboard.astro:47` |
| `/report` | ALLOW | ALLOW | **ALLOW+LOCK** | ✔ | 読み取りのみ | `report.astro:50` |
| `/trend` | ALLOW | ALLOW | **ALLOW+LOCK** | ✔ | 読み取りのみ | `trend.astro:42` |
| `/result/[id]` | ALLOW | ALLOW | **ALLOW+LOCK** | ✔ | 原本の署名 URL 発行 | `result/[id].astro:22`、所有者検証は `result-queries.ts` |
| `/kit` | ALLOW | ALLOW | **ALLOW+LOCK**（**閲覧のみ。自己申告ボタンは描かない**・§17.2） | ✔ | 読み取り | `kit.astro:41, 226` |
| `/scan` | ALLOW | ALLOW | **ALLOW+LOCK** | ✔ | **DB/S3 書き込みへ繋がる** | `scan.astro:39-60` |
| `/chat` | ALLOW | ALLOW | **ALLOW+LOCK** | ✔ | **DB/S3 書き込みへ繋がる** | `chat.astro:15-16` |
| `/coach` | ALLOW | ALLOW | **ALLOW+LOCK** | ✔ | 読み取り＋Gemini | `coach.astro:37` |
| `/notices` | ALLOW | ALLOW | **ALLOW+LOCK**（**閲覧のみ。既読化は効かない**・§17.2） | ✔ | 読み取り | `notices.astro:21` |
| `/share/<token>` | — | — | 入口 | — | pending 発行 | 新設・§16 |
| `/share/consent` | — | — | ALLOW | — | share session 発行 | 新設・§17 |
| `/share/unavailable` | — | — | ALLOW | — | 無し（理由を区別しない） | 新設・§16.3 |
| `/admin/handoff/<token>` | — | 入口（**bearer・60 秒・単一使用**） | **BLOCK** | — | imp session 発行 → 302 | 新設・§12 |
| **`/admin-view/<ctx>/…`** | — | **代理表示中の全ページ（案 B・§13.0）** | **BLOCK** | ✔ | 各ページと同じ。**`welltect_v` の admin 本人と `admin_identity` の一致を必ず検証** | 新設・§13.0 |
| `/admin/**`（Scan-Chat-AI） | admin のみ | admin のみ | **BLOCK** | — | | `src/pages/admin/**` |

### 25.2 API

| Route | Self | Admin 代理 | Share | Target Lock | 副作用（最終的にどこへ書くか） | 根拠 |
|---|---|---|---|---|---|---|
| `POST /api/auth/resolve` | ALLOW | ALLOW | **BLOCK**（§17.5） | — | `diagnosis.app_users` upsert・`welltect_v` 発行 | `auth/resolve.ts` |
| `POST /api/auth/refresh-admin` | ALLOW | ALLOW | **BLOCK** | — | `welltect_v` 再発行 | `auth/refresh-admin.ts` |
| `POST /api/auth/signout` | ALLOW | ALLOW | **BLOCK**（§17.5） | — | Cookie 削除。**共有相手に本人セッションを消させない** | `auth/signout.ts` |
| `POST /share/end` | — | — | **ALLOW** | — | `welltect_share_v` **だけ**失効。`welltect_v` に触れない | 新設・§17.5 |
| `POST /api/scan` | **要 viewer**（§21.4） | 同左 | **ALLOW**（§21.4） | — | **書かない**（Gemini 読み取りのみ）。**現在は未認証で叩ける** | `api/scan.ts:38-54`・`resolveViewer` 0 件 |
| `POST /api/scan/upload-ticket` | **要 viewer**（§21.4） | 同左 | **ALLOW**（§21.4） | — | S3 presigned PUT（キーはサーバ採番・15 分）。**現在は未認証で叩ける** | `scan/upload-ticket.ts:32`・`lib/scan-upload-ticket.ts:47` |
| `POST /api/scan/save` | ALLOW | **BLOCK**(§12.5) | **ALLOW+LOCK** | ✔ | `test_artifacts` insert ＋ `measurement_values` | `scan/save.ts:36` → `scan-persist.ts:103,138` |
| `POST /api/scan/jobs` | ALLOW | **BLOCK** | **ALLOW+LOCK** | ✔ | `scan_jobs` insert → worker が上と同じ書き込み | `scan/jobs.ts:39` |
| `POST /api/scan/export` | ALLOW | **BLOCK** | **ALLOW+LOCK** | ✔ | S3 `{prefix}{diagnosticId}/` | `scan/export.ts:56` → `scan-export.ts:272` |
| `POST /api/interview/classify-voice` | **要 viewer**（§21.4） | 同左 | **ALLOW** | — | **書かない**。**現在は未認証で叩ける** | `interview/classify-voice.ts:29-39`・`resolveViewer` 0 件 |
| `POST /api/interview/export` | ALLOW | **BLOCK** | **ALLOW+LOCK**（scope.interview） | ✔ | `interview_completions` insert ＋ S3 `user/{client_id}/…`。**profile metadata もサーバ解決**（§19.5） | `interview/export.ts:92,101` → `interview-export.ts:281` |
| `POST /api/live-token` | ALLOW | ALLOW | **ALLOW+LOCK**（scope.interview） | ✔ | 書かない。**customer(PII) を読む** ＋ **30 分有効の Gemini Live token を発行**（§27.3） | `live-token.ts:26-46`、TTL は `:39-40` |
| `POST /api/insight` | ALLOW | ALLOW | **ALLOW+LOCK** | ✔ | 書かない。**現在は未認証で叩ける** | `insight.ts:30,42,68` |
| `POST /api/coach/ask` | ALLOW | ALLOW | **ALLOW+LOCK** | ✔ | 書かない。**現在は未認証で叩ける** | `coach/ask.ts:83,94,114` |
| `POST /api/kit/[id]/self-report` | ALLOW | **BLOCK** | **BLOCK**（§17.2） | — | `kit_shipments` 更新。**本人の配送状態を外部共有者が変えない** | `kit/[id]/self-report.ts:24-60` |
| `POST /api/notices/[id]/read` | ALLOW | **BLOCK** | **BLOCK**（§17.2） | — | `user_notices` 更新。**本人の既読状態を外部共有者が変えない** | `notices/[id]/read.ts:24-44` |
| `GET /api/debug/viewer` | token 必須 | token 必須 | **BLOCK**(要裁定 §38-U8) | — | 読み取り | `debug/viewer.ts:48` |
| `**/api/admin/**`（28 本） | **BLOCK** | **BLOCK** | **BLOCK** | — | | `api-auth.ts checkAdminAuth` |
| `**/api/cron/**`（3 本） | **BLOCK** | **BLOCK** | **BLOCK** | — | | `CRON_SECRET` |
| `**/api/ops/**`（4 本） | **BLOCK** | **BLOCK** | **BLOCK** | — | | `PROBE_UPLOAD_TOKEN` |

> **「一般ユーザーが使えるから Share も OK」で決めていない**箇所:
>
> - `auth/resolve` `auth/signout` `auth/refresh-admin` … **share では BLOCK**（§17.5）。
>   共有相手の操作で端末の持ち主の本人セッションを作らせない／消させない
> - `debug/viewer` … viewer 構造をそのまま返すので **BLOCK**
> - **`kit/self-report` `notices/read` … share では BLOCK**（§17.2）。
>   発注者が許可した更新は **AI 問診と AI スキャンだけ**。
>   ページ閲覧は許可するが、**本人の配送状態・既読状態は変えさせない**
> - `scan/save` `scan/jobs` `scan/export` `interview/export` …
>   **副作用があるので target lock が必須**
> - `scan` `scan/upload-ticket` `classify-voice` …
>   **UID を扱わないが未認証で叩ける**ので、**正規 viewer を要求する**（§21.4）

---

## 26. Access Log

### 26.1 記録するイベント

```
token_access     … /share/<token> が叩かれた（成功・失敗とも）
consent          … 同意
dashboard_view / report_view / trend_view / result_view / kit_view / notices_view
chat_use         … /api/live-token または /api/interview/export
scan_use         … /api/scan/save または /api/scan/jobs
expired / revoked / paused / not_found
blocked_admin_access      … admin route/API を share セッションで叩いた
target_tamper_attempt     … ?u= / body.diagnosticUserId が target と異なっていた
```

### 26.2 記録しないもの

- **raw bearer token**（share token / handoff token）— P5
- **path に UID を入れない**（`/result/<artifact_id>` は artifact_id を別列 or ハッシュで）
- 回答本文・検査値などの中身

### 26.3 集計

`shared_access_links` に `access_count` / `last_access_at` を持つか、
ログから集計するか。**ログからの集計を推奨**（二重管理を避ける）。
一覧の表示が重くなるなら materialized な列を後から足す。

---

## 27. Expiry / Revoke

### 27.1 毎リクエストで見るもの

```
share session 有効
  ∧ share_link.status = 'active'
  ∧ (starts_at is null ∨ starts_at <= now())
  ∧ share_link.expires_at > now()
  ∧ session.expires_at > now()
  ∧ session.revoked_at is null
```

**link 側を毎回見るのが要点。** セッションだけを見ると
**revoke してもそのセッションは生き続ける**。

### 27.2 操作と効果

| 操作 | 効果 |
|---|---|
| `pause` | `status='paused'`。**Welltect サーバへの次のリクエストから不可**。`resume` で戻る |
| `revoke` | `status='revoked'`。不可逆。**Welltect サーバへの次のリクエストから不可** |
| `regenerate`（URL 再発行） | **新 token を発行し、旧 `token_hash` を失効。旧 token の全セッションも失効** |
| 期限到来 | 何もしなくても不可になる |

### 27.3 【正確な記述】revoke は「即時停止」ではない — 発行済みの第三者 credential は残る

**「revoke 後は即時停止」と単純に書いてはいけない。** 実コードを見ると、
Welltect が**第三者サービス向けに発行した credential** は、revoke しても**こちらから失効させられない**。

| credential | 発行元 | 最大有効期間（実測） | revoke の効き方 | 根拠 |
|---|---|---|---|---|
| **Gemini Live の ephemeral token** | `POST /api/live-token` | **セッション 30 分**（`expireTime = now + 30*60*1000`）。新規セッション開始は 60 秒以内・1 回限り | **効かない。** Google 側が持つ token なので Welltect からは失効させられない | `api/live-token.ts:11, 39-40` |
| **S3 の presigned PUT URL** | `POST /api/scan/upload-ticket` | **15 分**（`PRESIGN_EXPIRES_SEC = 900`） | **効かない。** 署名済み URL は S3 が検証するので、Welltect のセッション状態と無関係 | `lib/scan-upload-ticket.ts:47, 135` |

#### 正確な仕様

```
revoke / pause / 期限到来 の効果:

  ○ Welltect サーバへの次のリクエスト     → 即時に拒否される
  ○ 以後の新しい credential の発行        → 起きない
  ✕ 既に発行済みの Gemini Live token      → 最大 30 分、相手の手元で使える
  ✕ 既に発行済みの S3 presigned PUT       → 最大 15 分、相手の手元で使える
```

**最大残存時間 = 30 分**（Live token）。

#### 各々の実害

| credential | 残存中にできること | 実害の評価 |
|---|---|---|
| Gemini Live token | **その Live セッションを継続できる**（会話を続けられる） | 中。**セッション開始時に渡した文脈しか持たない**ので、新しいデータは読めない。ただし **Gemini の課金は続く** |
| S3 presigned PUT | **その 1 キーへ 1 ファイル PUT できる**（`Content-Type` と `ContentLength` が署名に固定・`scan-upload-ticket.ts:135`） | 低。**キーはサーバ採番の UUID** で `{prefix}scan-uploads/YYYY/MM/DD/<uuid>.<ext>` に限定。かつ **Welltect 側が読み出すには `/api/scan` を叩く必要があり、そちらは revoke 済みで通らない**。置かれたファイルはライフサイクルで 1 日後に消える |

#### Share mode で TTL を短縮するか

| 案 | 内容 | 評価 |
|---|---|---|
| **A（推奨）** | **share セッションでは Live token の `expireTime` を短くする**（例 10 分）。`api/live-token.ts:39` は固定値なので、viewer の kind で分岐できる | 残存 30 分 → 10 分。**問診 1 セクションは 10 分あれば終わる**見込みだが**未計測**（§38-U22） |
| **B** | presigned PUT も share では短縮（例 300 秒） | 効果は小さい（実害が低いため）。**大きなファイルのアップロードが 5 分で切れる**リスクがあるので、**採らない**か、`bytes` から必要時間を見積もる |
| **C** | 何もしない | 最大残存 30 分を受容し、**運用の説明に含める** |

**推奨 = A のみ実施し、B は採らない。**
そのうえで **C の説明責任を果たす**（admin 画面の revoke ボタン付近に
「すでに開始されている AI 問診は最大 N 分継続する場合があります」と明記する）。

#### 受入テストへの反映

§34.1 に **S27 / S28** を追加（revoke 後に Welltect API が即拒否されること／
発行済み credential の残存が仕様どおり最大 TTL で切れること）。

### 27.4 admin impersonation

- セッション **60 分**。`welltect_v` の 30 日に合わせない
- handoff token は **60 秒・単一使用**
- 「代理表示を終了」で即失効

---

## 28. HTTP Security

### 28.1 既存

`src/lib/http-cache.ts` の `noStore(res)` が `cache-control: private, no-store` を付ける。
実測 9 ページに適用済み（`f20a5bf` で `result/[id]` を追加）。**これを使う。新設しない。**

### 28.2 追加候補

| ヘッダ | 対象 | 理由 |
|---|---|---|
| `Cache-Control: private, no-store` | `/share/**` ＋ 既存 9 ページ | 既存 `noStore()` を呼ぶだけ |
| `Referrer-Policy: no-referrer` | **最低でも `/share/<token>` と `/admin/handoff/<token>`** | raw token が外部リンク経由で漏れるのを防ぐ |
| `X-Robots-Tag: noindex, nofollow` | `/share/**` | 共有 URL がどこかに貼られたときの検索インデックス化を防ぐ |

### 28.3 middleware を新設するか

`url_uid_privacy_spec_20260929.md` §14 で「`src/middleware.ts` は新設しない」と確定した。
**今回も既存 helper で足りる範囲では新設しない**（P7）。

ただし `Referrer-Policy` / `X-Robots-Tag` を **全ページへ**付けたい場合は
`http-cache.ts` に `shareSecurityHeaders(res)` のような関数を足して**呼ぶ側を明示する**のが
既存の流儀に合う。**middleware は「全リクエストに効く」ので、
効き方が読めないものを増やさない**という判断をここでも維持する。

> **未確定**: `noindex` を `/share/**` 以外にも広げるか（`/dashboard` 等は
> そもそも認証が要るのでクローラは到達しないが、明示しておく価値はある）（§38-U11）。

---

## 29. production / staging

### 29.1 現行

`Viewer.origin`（`viewer.ts:215`）は **Cookie の持ち主の環境**であり、
**表示対象の環境ではない**。コメント（`:213`）が明記している:

> 代理表示 (`?u=`) 中は**表示対象ではなく Cookie の持ち主の印**が載る点に注意。

`isBridgeConfigured(viewer.origin)`（`dashboard.astro:55`）などが
`app_bridge` の接続先をこれで選ぶ。

### 29.2 本設計での扱い

**share link / impersonation handoff の両方に `target_origin` を持たせる**（§22.1 / §22.4）。

理由: 共有相手には「Cookie の持ち主」が存在しない（`selfUid = null`）ので、
origin を Cookie から取れない。**対象顧客がどちらの環境で解決された人かは、
link を発行するとき（admin が顧客を選ぶとき）にしか分からない。**

`resolveViewer()` は
- `kind='share'` → `viewer.origin = share_link.target_origin`
- `kind='admin_impersonation'` → `viewer.origin = handoff.target_origin`
- それ以外 → 現行どおり Cookie の印

とする。**これは現行の代理表示の挙動を変える改善でもある**（今は admin 本人の origin が使われている）。

> **注意**: この変更は既存の代理表示の見え方を変え得る。
> `verify:viewer-origin` を回帰で流し、**変える場合は意図した変更として記録する**（§38-U12）。

---

## 30. Migration（旧 `?u=` 経路の移行）

### 30.1 段階

| Phase | 内容 | 旧 `?u=` |
|---|---|---|
| **0** | §11 のクライアント申告 UID をすべてサーバ側 resolver へ寄せる（**share とは独立に先行して良い**） | 変更なし |
| **1** | Admin handoff（§12・§13）を実装。wellfort-site 側は**新旧の導線を両方出す** | **生きている** |
| **2** | 新方式で運用し、admin から「旧リンクを使った」報告が出ないことを確認 | 生きている |
| **3** | wellfort-site から `?u=` リンクを撤去。`viewer.ts` の `?u=` 分岐を admin から外す | **廃止** |
| **4** | External Share（§14〜§19）を実装・公開 | — |

### 30.2 旧方式を即時廃止するか

**短期後方互換を推奨（Phase 1〜3 を分ける）。**

理由:
1. **旧方式は wellfort-site のクライアント側 JS で組まれている**（`customers.astro:438`）。
   キャッシュされた JS を踏んだ admin が**リンク切れに見える画面**に当たり得る
2. **2 リポジトリ同時リリースになる**。片方だけ出た瞬間に代理表示が壊れる
3. 旧方式は「admin Cookie が無いと効かない」ので、**残しておいても即座の危険は無い**

### 30.3 `ALLOW_UID_ENTRY` は廃止しない

緊急復旧経路として維持する（発注者指示）。`uidEntry` の性質（リンク維持専用・
認証/admin 判定に使わない）は `url_uid_privacy_spec_20260929.md` §13 のとおり。

---

## 31. Threat Model

| # | 脅威 | 対策 |
|---|---|---|
| 1 | **share URL の漏洩**（転送・スクショ・共有 PC） | 期限 / pause / revoke / regenerate。アクセスログで異常を検知。**URL が唯一の要素であることは受容し、代わりに失効を速くする** |
| 2 | **handoff token の漏洩** | 60 秒・単一使用・使用後即失効。得られるのはその顧客の一般画面のみ |
| 3 | **token replay** | handoff は `consumed_at` の条件付き UPDATE で単一使用。share token は replay 可能だが、それが仕様（bearer）。**セッション化して以後は token を使わない** |
| 4 | **brute force** | 256bit。加えて `/share/<token>` に**レート制限**（IP あたり・全体あたり）。失敗は `token_access` としてログ |
| 5 | **session fixation** | セッション ID は**サーバが生成**。クライアントの値を採用しない。同意時に pending → 本セッションへ**付け替える**（同じ値を昇格させない） |
| 6 | **share session の盗用** | `HttpOnly` / `Secure` / `SameSite=Lax`。期限を短く。**IP や UA の変化で即切らない**（モバイル回線で誤爆する）が、ログには残す |
| 7 | **impersonation session の盗用** | 同上 ＋ 60 分 |
| 8 | **revoke 後に既存セッションが生き残る** | **毎リクエストで link 側を見る**（§27.1）。セッション単体の期限に依存しない |
| **8-1** | **revoke 後も発行済みの第三者 credential が使える** — Gemini Live token **最大 30 分**（`live-token.ts:39`）／S3 presigned PUT **15 分**（`scan-upload-ticket.ts:47`） | **こちらから失効できない。** share では Live token の TTL を短縮（§27.3-A）。実害は限定的（Live は既存文脈のみ・S3 は採番済み 1 キーへの PUT のみで読み出しは revoke 済み API が要る）。**最大残存 30 分を運用文言に明記する** |
| **8-2** | **admin の複数タブで対象が混線する** — Cookie 1 本だと A タブが B 顧客に化ける | **URL path の opaque view-context でタブ単位に分離**（§13.0 案 B）。context は admin 本人の Cookie と組み合わせないと解決しない |
| **8-3** | **share Cookie が残ったまま本人が自分の画面を開く** | share を優先しつつ**常設の帯で状態を明示し、1 タップで終了できる**（§24.4）。**黙って別人のデータを見せない** |
| 9 | **非 admin が handoff を取得** | 発行は `verifyAdmin`（Supabase token → `admin_users` 在籍）を通った人だけ。上流は `ADMIN_API_KEY` |
| 10 | **target UID 差し替え（`?u=`）** | share / 新 impersonation では **`?u=` を読まない**。読み取りは `viewer.ts:257` の 1 か所のみなので、そこで kind を見て無視する |
| 11 | **target UID 差し替え（`body.diagnosticUserId`）** | 全 API を `resolveViewer` 経由へ（§21.3）。body の値は**捨てる**。差異を検知したら `target_tamper_attempt` をログ |
| 12 | **artifact_id 直接指定** | `result-queries.ts` の所有者検証（`id` ＋ `diagnostic_user_id` の 2 条件）に `viewer.uid` = target を渡す。**share 専用の例外を作らない**（§24） |
| 13 | **他人の Elith 納品フォルダへの書き込み** | §11-#1。`client_id` を **`viewer.writeTargetUid` から組む**。**これは現行の穴で、共有の有無に関わらず塞ぐ** |
| 14 | **Admin API 直接呼出し** | Bearer `ADMIN_API_KEY` が必要。share Cookie では通らない（**現状で既に閉じている**） |
| **14-1** | **未認証の AI / S3 コスト悪用** — `/api/scan`（Gemini・任意画像）／`/api/scan/upload-ticket`（S3 presigned PUT・10MB・回数無制限）／`/api/interview/classify-voice`・`/api/insight`・`/api/coach/ask`・`/api/live-token`（Gemini）が **`resolveViewer` も `checkAdminAuth` も `cookies` も参照していない＝完全に未認証**（実測） | **Phase 0 で正規 viewer を要求する**（§21.4）。`kind === 'anonymous'` を 401。`upload-ticket` には**追加でレート制限**。**「UID を使っていないから安全」と判断しない** |
| **14-2** | **対象者 profile metadata の改竄** — `userName` / `dateOfBirth` / `sex` がクライアント送付で、Elith 納品 JSON の内容へ流れ込む | **Phase 0 でサーバ側 target resolver から取り直す**（§19.5）。**UID だけの Target Lock では不十分** |
| **14-3** | **共有相手が本人の配送状態・既読状態を変える** | `kit/self-report` / `notices/read` を **share で BLOCK**（§17.2）。UI からも消すが、**サーバ側で 403 にする**のが本体 |
| **14-4** | **共有相手が端末の持ち主の本人セッションを消す／作る** | `auth/resolve` / `auth/signout` / `auth/refresh-admin` を **share で BLOCK**（§17.5）。共有終了は `/share/end` が `welltect_share_v` だけを消す |
| 15 | **raw token の logging** | DB は hash のみ。**カスタムログへ raw を書かない**。`/share/<token>` は即 302（§28.2 の `Referrer-Policy`） |
| 16 | **cache leakage** | 全ページ `private, no-store`（§28.1） |
| 17 | **Referer** | `Referrer-Policy: no-referrer`（最低でも token を含む 2 route） |
| 18 | **browser history** | token は URL に 1 回しか出ない（以後は Cookie）。**履歴に残るのは避けられない**ので、**共有終了の導線と revoke を運用で使ってもらう** |
| 19 | **共有オフィス PC** | セッション期限を短めに ＋ 「共有を終了する」ボタンを常設 |
| 20 | **URL 転送（意図しない再配布）** | 技術的には防げない。**用途別に link を分けて発行する運用**（§38）＋ アクセスログで検知 |
| 21 | **匿名 viewer の取り違え** | `welltect_share_viewer` は**本人確認ではない**と明記（§31.1） |
| 22 | **share セッションでの書き込みが本人の実データを汚す** | **これは仕様**（§17.3）。ただし**誰が書いたかをログに残す**ことで事後に追える |

### 31.1 匿名 viewer 識別

`welltect_share_viewer=<random-id>` を発行する。

**これは本人確認ではない。** 以下では**別 viewer になり得る**:
Cookie 削除 / シークレットウィンドウ / 別ブラウザ / 別端末。
逆に**同じ端末を複数人で使えば同一 viewer に見える**。

**用途は「同一ブラウザからのアクセスの相関」だけ**。ログの読み手が
これを人の同一性と誤読しないよう、**画面にも仕様書にも明記する**。

---

## 32. IP の扱い

- **IP 単独で本人特定としない**（NAT / VPN / Proxy / 動的 IP）
- 保存するなら **`HMAC-SHA256(ip, server-secret)`**。**素の `SHA-256(ip)` にしない**
  （IPv4 は 2^32 なので総当たりで復元できる）
- secret は `APP_SESSION_SECRET` を流用できるか検討する
  （`viewer.ts:52-54` が既に同じ鍵で HMAC を取っている）。
  **専用 secret（`SHARE_LOG_IP_SECRET`）に分けるほうが望ましい**が、env 追加になるので発注者判断（§38-U13）
- **raw IP を保存する必要があるか**も検討する。
  「不正利用の調査で実 IP が要る」という要件があるなら HMAC では足りない。
  **現時点では HMAC を推奨**（同意画面で「接続元 IP アドレス…を記録します」と書くことと矛盾しない —
  記録はしている）

> **未確定**: raw IP の保存要否（§38-U14）。保存するなら保持期間も決める。

---

## 33. Admin 管理 UI

### 33.1 場所

**wellfort-site `/admin/share-links`**（サイドバー「設定」）。
UI = wellfort-site / 処理 = Scan-Chat-AI の API。CLAUDE.md の分界どおり。
**Scan-Chat-AI 側に admin 画面を作らない。**

**`/admin/demo-accounts` `/admin/special-accounts` とは別メニュー**にする
（デモ＝ダミーを見せる / スペシャル＝実データを扱う本人 / 共有＝実データを他人に見せる。
3 つとも目的が違う。同じ画面に置くと必ず取り違える）。

### 33.2 機能

| 機能 | 備考 |
|---|---|
| 対象顧客の選択 | 既存の顧客一覧から。**氏名で選ぶ**（admin 画面は PII を扱ってよい） |
| 新規発行 | 用途/ラベル・開始日時・有効期限・scope（問診/スキャンの可否） |
| **URL の表示とコピー** | **発行の瞬間だけ**。以後は復元不可（§15） |
| 一覧 | 対象顧客・ラベル・期限・状態・アクセス回数・最終アクセス |
| `pause` / `resume` | |
| `regenerate` | 旧 token と旧セッションを失効 |
| `revoke` | 不可逆 |
| 論理削除 | 一覧から隠すだけ。**ログは消さない** |
| アクセスログ閲覧 | link 単位 |

### 33.3 中継 API（wellfort-site 側・新設）

`wellfort-site/src/pages/api/admin/share-links.ts`
— `demo-accounts.ts:30-55` と**同一の 2 層認証**（`verifyAdmin` ＋ Bearer `SCAN_CHAT_AI_API_KEY`）。

### 33.4 Scan-Chat-AI 側 API（新設）

`GET|POST /api/admin/share-links`（Bearer `ADMIN_API_KEY`）。
`api/admin/demo-accounts.ts` / `special-accounts.ts` と同じ形。

---

## 34. テスト

### 34.1 新設する自動検査 `npm run verify:shared-access`（CI の A 層）

既存の `verify:demo-gate` / `verify:special-accounts` と同型
（実物の TS を transpile し、DB だけスタブに差し替えて**実際に動かす**）。

**Admin（A1〜A8・発注者要件）**

| ID | 検査 |
|---|---|
| A1 | 顧客管理から **UID リンクではなく handoff** で対象 Dashboard を開ける |
| A2 | 開いた後の URL に target UID が無い |
| A3 | `/dashboard` `/report` `/trend` `/result` へ遷移しても target 維持 |
| A4 | **非 admin は handoff を発行できない**（`verifyAdmin` / `ADMIN_API_KEY` の両段） |
| A5 | handoff token は **single-use**（2 回目は失敗） |
| A6 | expired handoff を拒否 |
| A7 | 代理表示を終了でき、admin 本人へ戻る |
| A8 | `?u=<別UID>` で target が変わらない |
| **A9** | **複数タブが混線しない**（§13.0）: A 顧客のタブと B 顧客のタブを開き、**A のタブで遷移しても A のまま**であること |
| **A10** | **`<opaque-context>` 単体では使えない**: admin の `welltect_v` を外して同じ URL を叩くと 403。**別の admin の Cookie でも 403**（`admin_identity` 不一致） |
| **A11** | **`/admin-view/<ctx>/…` の URL に target UID が出ない** |
| **A12** | **1 タブだけ終了しても他タブの代理表示が生きている**／「すべて終了」で全部切れる |

**External Share（S1〜S26・発注者要件）**

| ID | 検査 |
|---|---|
| S1 | 有効 share URL → consent 画面 |
| S2 | **同意前に対象の健康情報を 1 バイトも返さない** |
| S3 | 同意後 → `/dashboard` |
| S4 | 以降 URL に UID / token が出ない |
| S5〜S9 | dashboard / report / trend / result / kit が仕様どおり使える |
| S10 | AI 問診を開始・回答・完了できる |
| S11 | **問診の現行更新（`interview_completions` ＋ S3）が share target に対して実行される** |
| S12 | AI スキャンを実行できる |
| S13 | **スキャンの現行更新（`test_artifacts` ＋ `measurement_values` ＋ S3）が share target に対して実行される** |
| S14 | `?u=<別UID>` で target が変わらない |
| S15 | `body.diagnosticUserId=<別UID>` でも target が変わらない |
| S16 | 他人の `artifact_id` を閲覧できない |
| S17 | **他人の UID へデータを保存できない**（全書き込み API） |
| S18 | admin route / API に入れない |
| S19 | 期限切れ share が使えない |
| S20 | paused が使えない |
| S21 | revoked が使えない |
| S22 | **revoke 後、既存セッションも次のリクエストから使えない** |
| S23 | regenerate 後、旧 token が使えない |
| S24 | **raw token がカスタムログに出ない** |
| S25 | 全ページが `private, no-store` |
| S26 | **通常本人の Google ログインに回帰が無い** |
| **S27** | **revoke 直後、Welltect の API が即時に拒否する**（`/api/scan/save` `/api/interview/export` `/api/live-token` ほか） |
| **S28** | **revoke しても発行済みの Gemini Live token / S3 presigned PUT は最大 TTL まで残る**ことを**仕様として確認する**（§27.3）。share の Live token TTL が短縮されていること（§27.3-A 採用時） |
| **S29** | **`kit/self-report` が share で 403**（UI を消しただけでなく API 直叩きでも拒否） |
| **S30** | **`notices/read` が share で 403** |
| **S31** | **`auth/resolve` / `auth/signout` / `auth/refresh-admin` が share で 403**。`/share/end` の後も `welltect_v` が残っている |
| **S32** | **share セッション中の全ページに「共有ページを表示中／終了」の帯が出る**（§24.4） |
| **S33** | **`userName` / `dateOfBirth` / `sex` を body で改竄しても、納品 JSON がサーバ解決値になる**（§19.5） |

**Cross Mode（C1〜C4）**

| ID | 検査 |
|---|---|
| C1 | `welltect_v` ＋ share session → **share が勝つ**（§24.2） |
| C2 | admin `welltect_v` ＋ share session → share が勝ち、`isAdmin=false` |
| C3 | 代理表示終了 → admin self へ戻る |
| C4 | 共有終了 → share target が残らない |

**書き込み先の回帰（W・本書で新設）**

| ID | 検査 |
|---|---|
| W1 | **`kind='self'` では `writeTargetUid === selfUid`**（通常利用者の挙動が変わらないこと） |
| W2 | `kind='admin_impersonation'` では `writeTargetUid === null` で書き込み API が 403 |
| W3 | `kind='share'` では `writeTargetUid === targetUid` |
| W4 | **`viewer.selfUid` を直接読む書き込み API が 0 件**（ソース検査） |
| W5 | **`body.diagnosticUserId` を認可根拠に使う箇所が 0 件**（ソース検査・§11 の 7 件が消えたこと） |
| **W6** | **`userName` / `dateOfBirth` / `sex` をクライアントから採用している箇所が 0 件**（ソース検査・§19.5） |
| **W7** | **`resolveViewer` を通っていない一般 API が 0 件**（ソース検査。§21.4 の 6 本を含む） |
| **W8** | **`kind === 'anonymous'` で `/api/scan` `/api/scan/upload-ticket` `/api/interview/classify-voice` が 401**（§21.4） |

### 34.2 退行注入（検査が本当に落ちるか）

1. `?u=` を share で読むように戻す → **S14 / A8 が落ちる**
2. `body.diagnosticUserId` を保存先に戻す → **S15 / S17 / W5 が落ちる**
3. link 側の `status` を見ずセッションだけ見る → **S20 / S21 / S22 が落ちる**
4. handoff の `consumed_at` チェックを外す → **A5 が落ちる**
5. consent 前に dashboard を返す → **S2 が落ちる**
6. token を DB に平文保存 → **S24 が落ちる**（ソース検査）
7. precedence を「`welltect_v` が先」に変える → **C1 / C2 が落ちる**
8. `writeTargetUid` を `viewer.uid` 固定にする → **W2 が落ちる**（代理表示で書けてしまう）
9. `noStore()` を外す → **S25 が落ちる**
10. 代理表示を **Cookie 1 本**に戻す → **A9 が落ちる**（2 タブ目が 1 タブ目を上書き）
11. `<opaque-context>` の `admin_identity` 照合を外す → **A10 が落ちる**
12. `kit/self-report` / `notices/read` を share で ALLOW に戻す → **S29 / S30 が落ちる**
13. `auth/signout` を share で ALLOW に戻す → **S31 が落ちる**
14. `userName` / `dateOfBirth` / `sex` をクライアント値に戻す → **S33 / W6 が落ちる**
15. `/api/scan` の viewer 要求を外す → **W8 が落ちる**
16. share の帯を消す → **S32 が落ちる**

### 34.3 既存検査の回帰（全部緑のまま）

`verify:url-uid-privacy` / `verify:demo-gate` / `verify:special-accounts` /
`verify:single-purchase` / `verify:viewer-origin` / `verify:screen` / `verify:report` /
`verify:report-verbatim` / `verify:trend-series` / `verify:scan-pages` / `verify:scan-async` /
`verify:scan-persist` / `verify:intake-scope` / `npm run check` / `astro build`

### 34.4 手動確認

1. admin が顧客管理から代理表示 → URL に UID が出ない・対象者の画面
2. 代理表示を終了 → admin 本人へ戻る
3. 共有 URL をスマホで開く → 同意 → ダッシュボード
4. 共有セッションで AI 問診を完走 → **対象者の**ダッシュボードで「完了済」になる
5. 共有セッションで AI スキャン → **対象者の**検査結果に出る
6. admin が revoke → 共有中の相手の画面が次の操作で止まる
7. 通常利用者の Google サインインに変化が無い

---

## 35. 受入条件

| ID | 条件 | テスト |
|---|---|---|
| A | Admin が UID なしで代理表示できる | A1〜A3 |
| B | handoff は admin だけが発行でき、単一使用・短命 | A4〜A6 |
| C | 代理表示を終了でき、admin 本人へ戻る | A7, C3 |
| D | 外部相手が URL を開くだけで利用できる | S1〜S9 |
| E | **同意前に健康情報を出さない** | S2 |
| F | **共有相手が対象者として AI 問診・AI スキャンを実行でき、現行の更新処理が走る** | S10〜S13 |
| G | **target をクライアントから変更できない**（URL / body / artifact_id） | A8, S14〜S17 |
| H | **admin 機能に到達できない** | S18 |
| I | 期限切れ・停止・失効・再発行が即時に効く | S19〜S23 |
| J | **raw token が DB にもログにも残らない** | S24 |
| K | 全ページが `private, no-store` | S25 |
| L | **通常本人の挙動に回帰が無い** | S26, W1, §34.3 |
| M | セッション優先順位が仕様どおり | C1〜C4 |
| N | **書き込み先が resolver 1 か所で決まる** | W2〜W5 |
| **O** | **admin の複数タブが混線しない**（既存機能を退行させない） | A9〜A12 |
| **P** | **共有相手が本人の配送状態・既読状態・認証セッションを変更できない** | S29〜S31 |
| **Q** | **対象者の profile metadata をクライアントから改竄できない** | S33, W6 |
| **R** | **未認証で AI / S3 を消費できない** | W7, W8 |
| **S** | **revoke の効果が正確に説明され、残存 credential の最大 TTL が仕様どおり** | S27, S28 |
| **T** | **share 中であることが常に画面に出ており、1 タップで終了できる** | S32, §24.4 |

---

## 36. Rollout

| Phase | 内容 | 前提 |
|---|---|---|
| **0** | **Phase 0 = 外部共有の公開前に必須。share と独立して先行できる**（下表） | なし |
| **1** | DB migration（§22 の 5 表）＋ RLS | 発注者が staging で適用 |
| **2** | Admin handoff ＋ impersonation session（Scan-Chat-AI） | Phase 1 |
| **3** | wellfort-site 顧客管理に新導線を追加（旧 `?u=` と並置） | Phase 2 |
| **4** | 運用確認後、旧 `?u=` を撤去 | Phase 3 |
| **5** | Share link 発行 API ＋ admin 管理 UI | Phase 1 |
| **6** | `/share/<token>` → consent → share session | Phase 5 |
| **7** | Share での AI 問診・AI スキャン（target lock 付き） | Phase 0, 6 |
| **8** | アクセスログ・監査画面 | Phase 6 |

### 36.1 Phase 0 の中身（**外部共有の公開前に必須・3 項目**）

| # | 内容 | 根拠 | share と独立に価値があるか |
|---|---|---|---|
| **0-a** | **クライアント申告 UID をすべてサーバ側 resolver へ寄せる**（§11 の 7 件） | `interview/export.ts:104-105` → `interview-export.ts:252,281-282` ほか | **ある。** #1 は**現在も成立する穴**で、サインイン済みなら他人の Elith 納品フォルダへ書ける |
| **0-b** | **対象者 profile metadata（`userName` / `dateOfBirth` / `sex`）もサーバ解決にする**（§19.5） | `live-controller.ts:1441-1443` → `api/interview/export.ts:104-107` | **ある。** UID を固定しても **profile を改竄すれば AI 入力を汚染できる** |
| **0-c** | **未認証で叩ける AI / S3 コスト API 6 本に正規 viewer を要求する**（§21.4） | `api/scan.ts` / `scan/upload-ticket.ts` / `interview/classify-voice.ts` / `insight.ts` / `coach/ask.ts` / `live-token.ts`（いずれも `resolveViewer` 0 件・実測） | **ある。** 共有の有無に関わらず**課金とストレージを他人に使わせる経路** |

**Phase 0 を最初に置くのが要点。** ここが済んでいないと
**share を出した瞬間に「共有相手が他人のデータを汚せる／他人の AI 入力を書き換えられる／
無制限に課金を発生させられる」**状態になる。

**3 項目とも「共有機能のための前提」ではなく、現在成立している課題**なので、
**share の設計が固まるのを待たずに着手してよい。**

---

## 37. Rollback

| 状況 | 戻し方 |
|---|---|
| share に問題 | **全 link を `paused` にする**（DB 1 クエリ）。コードは戻さない |
| 緊急 | `/share/**` を 503 にする env フラグ（例 `SHARE_ENABLED=off`）を**最初から入れておく** |
| admin handoff に問題 | **旧 `?u=` を残してある間は**そちらへ戻すだけ（Phase 4 より前なら無停止） |
| Phase 4 以降に問題 | `ALLOW_UID_ENTRY=on`（緊急経路・§30.3）— ただしこれは admin 権限を与えないので代理表示の代替にはならない。**Phase 4 は旧導線の復活 PR を用意してから行う** |
| DB | 追加テーブルのみなので `drop` で戻せる。**既存テーブルを変更しない設計にする** |

---

## 38. 未確定事項（推測で確定しない）

> **レビュー 2026-09-30 で 2 件が未確定を外れた。**
> **U7**（対象者 profile metadata のサーバ解決）→ **Phase 0 必須事項へ昇格**（§19.5 / §36.1-b）。
> **U18**（`kit/self-report` / `notices/read`）→ **BLOCK で確定**（§17.2）。
> 代わりに **U20〜U23** を追加した。

| # | 論点 | 選択肢 | 推奨 | 決める人 |
|---|---|---|---|---|
| **U1** | wellfort-site の **Vercel Production Branch** が `main` か | 実測では `origin/HEAD = main` だが Vercel の設定は未確認 | 実装前に確認 | 発注者 |
| **U2** | 共有 URL の**再コピー**は業務必須か | hash-only / 暗号化保存 | **hash-only**（§15.3） | 発注者 |
| **U3** | 同意画面に**対象者の氏名**を出すか | 出す / 出さない / イニシャル等 | 未定（PII を共有相手へ渡すことになる） | 発注者 |
| **U4** | 代理表示中の帯に**何を表示**するか | 顧客名 / 契約番号 / uid 先頭 8 桁 | 未定（`diagnosis` 側に氏名は無い） | 発注者 |
| **U5** | **admin が代理で問診・スキャンを代行入力**したいか | 現行どおり禁止 / 許可 | **禁止**（§12.5） | 発注者 |
| **U6** | impersonation / share で**毎リクエスト DB を引く**コスト | opaque + DB / 短命署名 Cookie | opaque + DB。**未計測** | 実装時に実測 |
| **U8** | `GET /api/debug/viewer` を share から叩けるか | BLOCK / token があれば ALLOW | **BLOCK**（viewer 構造をそのまま返すため） | 発注者 |
| **U9** | `created_by`（発行した admin）に何を保存するか | email / email のハッシュ / admin_users.id | **ハッシュ**（PII を診断系に置かない） | 発注者 |
| **U10** | admin が共有 URL を開いたとき share を勝たせるか | share 優先 / 警告して拒否 | **share 優先**（§24.4） | 発注者 |
| **U11** | `X-Robots-Tag: noindex` を `/share/**` 以外へ広げるか | 広げる / `/share` のみ | `/share` のみで開始 | 実装 |
| **U12** | `viewer.origin` を **target の origin** に変える（§29.2） | 変える / 現行維持 | **変える**（share では Cookie に origin が無い） | 発注者に報告のうえ実装 |
| **U13** | IP HMAC の secret を専用 env にするか | `APP_SESSION_SECRET` 流用 / `SHARE_LOG_IP_SECRET` 新設 | **専用**が望ましいが env 追加 | 発注者 |
| **U14** | **raw IP を保存する必要があるか** ／ 保持期間 | 保存しない / 保存する（期間つき） | **保存しない（HMAC のみ）** | 発注者 |
| **U15** | share セッションの**既定有効期間** | 1 時間 / 8 時間 / link 期限まで | 未定 | 発注者 |
| **U16** | share の **scope 既定値**（問診・スキャンを既定で許すか） | 両方 ON / 閲覧のみ ON | 発注者要件は「使える」なので**両方 ON** | 発注者 |
| **U17** | 共有相手による更新を**対象者本人へ通知**するか | する / しない | 未定（本人の知らないところで実データが増える） | 発注者 |
| ~~**U18**~~ | ~~`kit/self-report` / `notices/read` を share で許すか~~ | — | **確定: BLOCK**（レビュー 2026-09-30）。発注者が明示的に許可した更新は **AI 問診と AI スキャンだけ**。ページ閲覧は許可するが、**本人の配送状態・既読状態は変えさせない**（§17.2 / §25.2） | **確定済** |
| **U19** | レート制限（§31-#4）の実装方法 | Vercel の機能 / DB カウンタ / 見送り | 未調査 | 実装時に調査 |
| **U20** | 案 B（`/admin-view/<ctx>/…`）を **Astro のルーティングでどう実現するか** — 既存ページを二重に書かずに同居させる方法 | rewrite / 共通コンポーネント化 / middleware | **middleware は §28.3 の方針で避けたい。** 実装前に 1 つ選ぶ（§13.0） | 実装時に調査 |
| **U21** | §21.4 で未認証を塞ぐと**サインイン前のお試し利用**が壊れないか | 塞ぐ / 一部を残す | **塞ぐ。** `/scan` `/chat` `/coach` はいずれも `resolveViewer` を通しサインインゲートを出すので正規画面からは呼ばないと読めるが、**実測していない**。実装時に確認 | 実装時に実測 |
| **U22** | share の **Gemini Live token TTL を短縮するか**（§27.3-A） | 30 分のまま / 10 分へ短縮 | **短縮を推奨**。ただし「問診 1 セクションが 10 分で終わるか」は**未計測** | 発注者 ＋ 実測 |
| **U23** | share セッション中の**帯の文言と表示位置**（§24.4） | — | 未定。代理表示の帯（§13.4）と揃える | 発注者 |

---

## 39. `file:line` 根拠一覧

### Scan-Chat-AI（`f20a5bf`）

```
src/lib/viewer.ts:26,29,39-41,52-54,68-73,88-109,145-176,179-190,192-243,245,255-288,306-310,313-319
src/lib/http-cache.ts:1-16
src/lib/api-auth.ts:22-27,30-32,50-62（checkAdminAuth / isAdminAuthorized / LAB_INTAKE_API_KEY）
src/lib/result-queries.ts（所有者検証・f20a5bf で追加）
src/lib/scan-persist.ts:83,103-121,131-138,212-213,224-226,254,302-327
src/lib/scan-export.ts:43,59,187,264-300,272
src/lib/scan-export-put.ts:15,38-75
src/lib/interview-export.ts:98,120,151,158,246-252,274-287
src/lib/interview-completion.ts:44-60,78-96
src/lib/elith-delivery.ts:78,154-210,223,253,276,323,372,401,424,504
src/pages/index.astro:1-13
src/pages/dashboard.astro:38-60,236,239
src/pages/report.astro:50,196-202
src/pages/trend.astro:42
src/pages/kit.astro:41,58,226
src/pages/scan.astro:10-13,18,38-43,60,980,1015,1035,1041,1135,1138
src/pages/chat.astro:1-18,77,78
src/pages/coach.astro:37,41,79,88,123,330,334,453,457
src/pages/notices.astro:18-21,28,35,47-49,246-262
src/pages/result/[id].astro:22
src/scripts/chat/live-controller.ts:122,127,365,934,1109-1112,1425-1470,1481,1486
src/scripts/camera-scan.ts:201
src/scripts/scan-upload.ts:188
src/scripts/kit-self-report.ts:15,35-49
src/pages/api/auth/resolve.ts:20-24,30,45-69,99,120-122,162-166
src/pages/api/auth/refresh-admin.ts:30
src/pages/api/coach/ask.ts:4,14,78,83-94,114
src/pages/api/insight.ts:4,11,26-30,42,68
src/pages/api/live-token.ts:11,13,24-28,34,39-40,44-46（ephemeral token の TTL = 30 分 / newSession 60 秒）
src/pages/api/interview/export.ts:12-13,28,36,70-107
src/pages/api/interview/classify-voice.ts:29-39（MAX_TRANSCRIPT / MAX_OPTIONS・resolveViewer 0 件）
src/pages/api/kit/[id]/self-report.ts:10-14,22-60
src/pages/api/notices/[id]/read.ts:9-13,22-44
src/pages/api/scan.ts:2,38-54（readScanPage → Gemini・resolveViewer 0 件）
src/pages/api/scan/save.ts:15,31-90
src/pages/api/scan/jobs.ts:17,38-80
src/pages/api/scan/export.ts:8,29,42-100
src/pages/api/scan/upload-ticket.ts:13,32,41
src/lib/scan-upload-ticket.ts:23,36,44,47(PRESIGN_EXPIRES_SEC=900),63,109,135,138
src/pages/api/cron/scan-worker.ts:24,27,150-152,180-182
src/pages/api/cron/elith-deliver.ts:4,13-21,36,41,56,61
src/pages/api/debug/viewer.ts:22,48,54,99-129,163-167,507
supabase/migrations/20260601000010_schemas_and_tables.sql:193（test_type CHECK）
supabase/migrations/20260601000020_rls_policies.sql:45,51,63,67
supabase/migrations/20260915000010_interview_completions.sql:20-54
```

### wellfort-site（`main` = `0c9c35d`）

```
src/pages/mypage.astro:105-114（素の URL・?u= は 9b5ed28 で撤去）
src/pages/admin/customers.astro:14,300,432-443（:439 が target="_blank" = 現行のタブ分離の根拠）
src/pages/admin/health-age.astro:10,95,261
src/pages/api/admin/demo-accounts.ts:12,17-21,30-55,57-70（2 層認証の正本パターン）
src/pages/api/admin/elith-verify.ts:7,14-15,62-66
src/pages/api/admin/elith-scan.ts:9,16-17,67-71
src/pages/api/admin/demecal-state.ts:8,15-16,50-54
```

### 実測で「0 件」を確認したもの（§21.4 の根拠）

```
resolveViewer / checkAdminAuth / cookies の参照がいずれも 0 件:
  src/pages/api/scan.ts
  src/pages/api/scan/upload-ticket.ts
  src/pages/api/interview/classify-voice.ts
  src/pages/api/insight.ts
  src/pages/api/coach/ask.ts
  src/pages/api/live-token.ts
```

### 検索して該当 0 件だったもの

```
Scan-Chat-AI:  src/middleware.ts（未存在）
               share / consent / handoff に関するコード（全て未実装）
               src/pages/api/** の share 系 route（0 本）
wellfort-site: /admin/share-links（未存在）
               外部共有の導線（0 件）
```

---

## 付録 A. フロー図

### A. 通常本人（変更しない）

```
ブラウザ ── Google One Tap ──▶ Supabase access token
                                    │
                                    ▼
                       POST /api/auth/resolve
                         ├ sb.auth.getUser(token) → email 検証
                         ├ email → diagnostic_user_id 解決
                         ├ admin_users 照会 → isAdmin
                         └ Set-Cookie: welltect_v = uid.exp.admin[.s].sig
                                    │
                                    ▼
                          resolveViewer() → kind='self'
                            uid = selfUid, writeTargetUid = selfUid
                                    │
                                    ▼
                              302 /dashboard      （URL に UID なし）
```

### B. Admin 代理表示（新方式）

```
Wellfort Admin 顧客管理
   │ 「この顧客の画面を開く」
   ▼
wellfort-site  POST /api/admin/impersonation-handoff
   │  verifyAdmin(request)                     … Supabase token → admin_users
   │  Bearer SCAN_CHAT_AI_API_KEY で上流へ
   ▼
Scan-Chat-AI   POST /api/admin/impersonation/handoff    [ADMIN_API_KEY]
   │  target_uid 実在確認
   │  raw = CSPRNG 32byte ／ DB には sha256(raw) のみ
   │  expires_at = now + 60s ／ consumed_at = null
   └──▶ { url: ".../admin/handoff/<raw>" }
   ▼
ブラウザ  GET /admin/handoff/<raw>
   │  sha256 照合 → 未使用・未失効・期限内
   │  UPDATE … SET consumed_at=now() WHERE consumed_at IS NULL   （1 行のときだけ成立）
   │  impersonation session 発行（DB に session_digest / admin_identity / target_uid）
   │  <opaque-context> を採番
   ▼
   302 /admin-view/<opaque-context>/dashboard    （URL に UID も handoff token も無い）
   │
   ▼
 以後 resolveViewer() → kind='admin_impersonation'
      uid = target_uid ／ selfUid = admin ／ writeTargetUid = null ／ targetLocked = true
```

### C. External Share

```
共有相手  GET /share/<token>
   │  sha256 照合 → link: active / starts_at ≤ now < expires_at
   │  pending session 発行 → Set-Cookie: welltect_share_pending (10分)
   │  ※ 失敗はすべて同一の /share/unavailable
   ▼
   302 /share/consent            （raw token はここで URL から消える）
   │
   │  ［ 同意して利用する ］
   ▼
POST /share/consent
   │  pending を消費（同じ値を昇格させない＝新しい ID を発行）
   │  shared_access_sessions へ consented_at / expires_at(= min(N時間, link.expires_at))
   │  Set-Cookie: welltect_share_v = <opaque>
   │  log: consent
   ▼
   302 /dashboard
   │
   ▼
 以後 resolveViewer() → kind='share'
      uid = target_uid ／ selfUid = null ／ isAdmin = false
      writeTargetUid = target_uid ／ targetLocked = true ／ scope = link.scope
```

### D. Share Target Lock

```
                        welltect_share_v (opaque)
                                 │
                                 ▼  sha256
                  shared_access_sessions → shared_access_links
                                 │
                                 ▼
                          target_uid（サーバ側で確定）
                                 │
     ┌───────────────┬───────────┴───────────┬────────────────┐
     ▼               ▼                       ▼                ▼
 /dashboard      /result/[id]            /api/scan/save   /api/interview/export
 読み = target   所有者検証に target     書き = target     DB/S3 とも target
     ▲               ▲                       ▲                ▲
     └───────────────┴───────────┬───────────┴────────────────┘
                                 │
        ?u=<別UID> ─────────────▶ 無視（読まない）        → log: target_tamper_attempt
        body.diagnosticUserId ──▶ 捨てる                  → log: target_tamper_attempt
        他人の artifact_id ─────▶ 所有者検証で不一致 → 「検査結果が見つかりません。」
```

### E. Target Resolver（統合）

```
                      ┌──────────────── リクエスト ────────────────┐
                      ▼
        ┌── /admin-view/<ctx>/… ?  （§13.0 案 B・最優先）
        │      ├─ ctx 有効 かつ welltect_v が admin本人 == admin_identity
        │      │        ──────────────▶ kind='admin_impersonation'
        │      │                          uid=target / write=null / admin=true / locked
        │      └─ それ以外 ─────────────▶ **403**（他の kind へ落とさない）
        no
        │
        ├── welltect_share_v 有効? ──yes──▶ kind='share'
        │                                   uid=target / write=target / admin=false / locked
        │                                   ＋ 全ページに「共有中／終了」の帯（§24.4）
        no
        │
        ├── /admin-view/<ctx>/… ?
        │      ├─ ctx 有効 かつ welltect_v が admin本人 == admin_identity
        │      │        ──────────────▶ kind='admin_impersonation'
        │      │                          uid=target / write=null / admin=true / locked
        │      └─ それ以外 ─────────────▶ **403**（他の kind へ落とさない）
        no
        │
        ├── welltect_v 有効?
        │      │
        │      ├─ isAdmin かつ ?u=≠self（移行期間のみ）
        │      │        ──────────────▶ kind='admin_impersonation'（旧方式）
        │      │
        │      └─ それ以外 ───────────▶ kind='self' / 'admin_self'
        │                                   uid=self / write=self / locked=false
        no
        │
        ├── ALLOW_UID_ENTRY=on かつ ?u= ─▶ kind='uid_entry'
        │                                   uid=req / write=req
        no
        │
        └────────────────────────────────▶ kind='anonymous'
                                            uid=null / write=null
                      │
                      ▼
            authorization（§25 Access Matrix）
                      │
                      ▼
               page / API 実行
```

---

## 付録 B. 実装候補ファイル一覧（**今回は 1 行も変更していない**）

### Scan-Chat-AI — 変更

| ファイル | 変更内容 |
|---|---|
| `src/lib/viewer.ts` | `ViewerKind` / `targetLocked` / `writeTargetUid` / `sessionExpiresAt` / `shareScope` の追加。`resolveViewer()` に precedence（§24.1）。**`viewerPathPrefix(viewer)` を足し、リンク組み立てを 1 か所に集約したまま `/admin-view/<ctx>` を扱う**（§13.0）。**既存の self / admin / uidEntry 分岐は変えない** |
| `src/pages/api/live-token.ts` | body の uid を捨て `resolveViewer` へ |
| `src/pages/api/insight.ts` | 同上 |
| `src/pages/api/coach/ask.ts` | 同上 |
| `src/pages/api/scan/export.ts` | 同上 |
| `src/pages/api/interview/export.ts` | **S3 の `client_id` も `writeTargetUid` から** |
| `src/pages/api/scan/save.ts` / `scan/jobs.ts` | `selfUid` → `writeTargetUid` |
| `src/pages/api/kit/[id]/self-report.ts` / `notices/[id]/read.ts` | `resolveViewer` を通す ＋ **share は 403**（§17.2） |
| `src/pages/api/scan.ts` / `scan/upload-ticket.ts` / `interview/classify-voice.ts` | **正規 viewer を要求**（`kind==='anonymous'` を 401）。**Phase 0**（§21.4） |
| `src/pages/api/auth/resolve.ts` / `signout.ts` | **share セッションからは 403**（§17.5）。**それ以外の挙動は変えない** |
| `src/components/AppNav.astro` / `BackToDashboard.astro` / `dashboard/*.astro` | `linkQuery` に加えて **`pathPrefix`** を受ける（`/admin-view/<ctx>` 配下でリンクが外へ出ないように） |
| `src/pages/scan.astro` | `:1015` の `location.search.get('u')` 撤去・`:60` を target で判定 |
| `src/pages/chat.astro` | `:77` の `data-diagnostic-user-id` 撤去 |
| `src/scripts/chat/live-controller.ts` | `:1112` `:1440` の uid 送信を撤去 |
| `src/pages/coach.astro` | `:123` の埋め込みと `:457` の送信を撤去 |
| `src/lib/interview-export.ts` | `client_id` の決定を `writeTargetUid` 起点へ（`:252`）。**profile metadata もサーバ解決値を受ける**（§19.5） |
| `src/lib/http-cache.ts` | `Referrer-Policy` / `X-Robots-Tag` 用の関数追加（§28.3） |

### Scan-Chat-AI — 新設

```
src/lib/share-access.ts            … link/session の発行・検証・失効
src/lib/admin-impersonation.ts     … handoff/session の発行・検証・失効
src/lib/access-log.ts              … §26
src/pages/share/[token].astro      … §16
src/pages/share/consent.astro      … §17
src/pages/share/unavailable.astro
src/pages/admin/handoff/[token].astro      … §12（画面は出さず 302）
src/pages/admin-view/[ctx]/[...rest].astro … §13.0 案 B（方式は §38-U20 で決める）
src/pages/api/share/consent.ts / end.ts    … /share/end は welltect_share_v だけを消す
src/pages/api/admin/impersonation/end-all.ts … §13.3「すべての代理表示を終了」
src/components/ShareBanner.astro           … §24.4 の常設の帯
src/components/ImpersonationBanner.astro   … §13.4 の代理表示の帯
src/pages/api/admin/share-links.ts                 … ADMIN_API_KEY
src/pages/api/admin/impersonation/handoff.ts       … ADMIN_API_KEY
src/pages/api/admin/impersonation/end.ts
supabase/migrations/2026xxxx_shared_access.sql     … §22（5 表 ＋ RLS）
scripts/verify-shared-access.mjs                   … §34
package.json / .github/workflows/ci.yml            … 検査の登録
```

### wellfort-site — 変更 / 新設

```
src/pages/admin/customers.astro   … :438 の ?u= を新導線へ（Phase 3-4）
src/pages/admin/health-age.astro  … :261 同上
src/pages/admin/share-links.astro                     [新設・§33]
src/pages/api/admin/share-links.ts                    [新設・2 層認証]
src/pages/api/admin/impersonation-handoff.ts          [新設・2 層認証]
```

---

## 付録 C. 非対象（今回の設計に含めない）

1. 一般ユーザー本線の認証（Google / `welltect_v` / `resolveViewer` の既存分岐）
2. `ALLOW_UID_ENTRY` の廃止（緊急経路として維持・§30.3）
3. デモ用アカウント / スペシャルアカウントの仕組み（別の枠。混ぜない）
4. `customer` スキーマの RLS 是正（CLAUDE.md「DB 権限まわりの既知の宿題」）
5. 共有相手ごとのアカウント発行（要件が「発行しない」）
6. 2 要素認証・ワンタイムパスワード（UX 要件と衝突。将来の選択肢として残す）
7. Elith 連携そのものの仕様変更
