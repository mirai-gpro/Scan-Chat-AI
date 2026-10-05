# トランスコスモス10名 — 完成済み AI疾病予防報告書 PDF の一括登録

**発注者指示 2026-10-05 / P0。** 既に完成している報告書 PDF 10 本を、
**Elith 再処理・JSON 再生成・OCR を一切行わず**、本人のダッシュボードから
開ける状態にする。

---

## 0. 最初に — この 10 本が何で、何でないか

| | |
|---|---|
| **これ** | **AI疾病予防報告書** の完成済み PDF (Elith の出力を組版したもの) |
| **違うもの** | `ai_prediction` / 「AI疾病発症予測」/ LAiF |

- **`test_artifacts` に 1 行も書かない。** `test_type='ai_prediction'` として
  登録してはいけない。
- **Elith JSON へ逆変換しない。** 完成 PDF をそのまま見せる。
- 置き場所は `diagnosis.diagnosis_results` (= 「Elith の診断結果 1 回分」)。
  受領 JSON の代わりに **PDF だけ**を持つ行として入れる (`schema_version='manual-pdf-v1'`)。

---

## 1. 発注者の操作 — これだけ

1. 本番 **`https://scan-chat-ai.vercel.app/admin/transcosmos-reports`** を開く
   (管理画面のメニュー「トランスコスモス10名 報告書 一括登録」からも行ける)
2. ZIP を選ぶ (`20261005‗トランス・コスモス②　10名【最終】.zip`)
3. **［10名へ登録する］** を押す
4. **`10 / 10 登録完了`** を確認

直後から各本人のダッシュボードの「AI疾病予防報告書」が押せるようになり、
押すと**本人の完成済み PDF** が開く。各行の［ダッシュボード確認］で
admin 代理表示から先に確かめられる。

---

## 2. なぜこの形か

### 2.1 PDF 本体を Vercel Functions へ通さない

最大 15MB 超の PDF が 10 本、ZIP 全体は 91MB。**Vercel Functions の
リクエスト本文は 4.5MB** (出典: vercel.com/docs/functions/limitations) なので、
ブラウザ → 関数 → Storage と中継すると**関数に届く前に 413** で落ちる
(しかもアプリのログには何も残らない)。

```
ブラウザ (ZIP を展開・SHA-256 を計算)
  ↓ slot / サイズ / SHA だけ (数百バイト)
POST /api/admin/transcosmos-reports { action: 'plan' }
  ↓ 署名つき upload URL × 10
ブラウザ → Supabase Storage へ直接 PUT (2 並列)
  ↓ 保存キーだけ
POST /api/admin/transcosmos-reports { action: 'finalize' }
  ↓ 存在確認 → app_users placeholder → diagnosis_results
完了
```

スキャンの S3 直アップロード (`docs/operations/スキャンS3直アップロード_バケット設定手順書.md`)
と同じ考え方。**ZIP はブラウザの中だけで開く** (`fflate`)。

### 2.2 保存先は Supabase Storage `lab-results`

今回 S3 は使わない。`originals-storage.ts` の `getOriginalSignedUrl()` は
**相対キーなら `lab-results` の署名 URL を作る** (`:200-206`) ので、DB には

```
manual/transcosmos/20260928/<uid>/<randomUUID>.pdf
```

という**相対キー**を保存する。公開 URL を保存しない・`public/` に置かない・
GitHub へ PDF を commit しない。

### 2.3 認可は管理者 session (`ADMIN_API_KEY` を使わない)

`resolveViewer` → `viewer.isAdmin`。鍵認可にすると**鍵を持つ誰か**
(専用 PC・スクリプト) が 10 名の枠へ書けることになる。
`?u=` を admin uid にしただけでは通らない (`admin/index.astro` と同じ)。

---

## 3. 氏名をどこにも残さない

ZIP 内のファイル名には氏名が入っている。**固定するのは先頭 2 桁 (01〜10) と
`diagnostic_user_id` の対応だけ** (`src/lib/transcosmos-reports.ts`)。

- 氏名・メールアドレスを**コード・DB・ログ・保存キー**に入れない
- ブラウザが**サーバへ送るのは `slot` / `sizeBytes` / `sha256` / 保存キー**だけ
  (ファイル名は送らない)
- 画面に出るファイル名はブラウザ内に留まる

`verify:transcosmos-reports` の A が「メールアドレスを埋め込んでいない」ことを見張る。

---

## 4. 静かに壊れるところ (ここが検査の本体)

| 壊れ方 | 何が起きるか | 守り |
|---|---|---|
| **slot と uid の取り違え** | 画面は「10 / 10 完了」なのに A さんの報告書が B さんに出る | uid は**サーバが slot から引き直す**。クライアント申告の uid を読まない |
| **キーの uid すり替え** | 別人の uid 配下のキーを添えて送ると紐付けが入れ替わる | `finalize` が**キーが slot の uid 配下か**を見る (`path_uid_mismatch`) |
| **Storage に無いのに DB を書く** | ボタンは押せるのに開くと 503 | `finalize` が **object の存在と size > 0** を確かめてから DB を書く |
| **placeholder に `auth_user_id` を書く** | 本人サインイン時に**別 uid が発行され**事前投入の PDF が孤児になる | 入れるのは `diagnostic_user_id` **1 列だけ**・`ignoreDuplicates: true` |
| **通常利用者の行き先を変える** | 受領 JSON の人に余分な往復が入る | 判定は `dashboard.astro` の 1 か所・条件は `report_pdf_url` **かつ** `source_key` 前方一致 |
| **冪等が壊れる** | 2 回流すと `diagnosis_results` が増え、どれが最新か分からなくなる | `diagnostic_user_id + source_key` で引いて update / insert を明示的に分ける |

---

## 5. `app_users` の placeholder

`diagnosis_results.diagnostic_user_id` は `diagnosis.app_users` への
**FOREIGN KEY** (`20260601000010:231`)。10 名は**まだ誰もログインしていない**ので
行が無く、そのまま insert すると FK 違反で落ちる。

→ `finalize` が **`diagnostic_user_id` 1 列だけ**の placeholder を作る。

**作らないもの**: `auth_user_id` / `google_sub` / `hp_customer_user_id` /
`display_name_cache` (全部 NULL のまま) / **Supabase Auth user** / **password**。

**後の本人ログインを邪魔しない**: `ignoreDuplicates: true` なので既存行は
1 列も上書きしない。本人が Sign up / Sign in すると `/api/auth/resolve` が
**この同じ行**へ認証を紐付ける (別 uid を発行しない)。

---

## 6. 本番で直したもの (この作業に含む)

この 10 名向けの先行実装が production に入っていたが、**2 つ壊れていた**。

### 6.1 `/api/report-route` が全リクエストで 500

`noStore(ctx.response)` を呼んでいた。`Astro.response` が在るのは `.astro`
ページだけで、**API route の `APIContext` に `response` は無い**。
`noStore(undefined)` が TypeError になり、

```
$ curl -o /dev/null -w "%{http_code}" https://scan-chat-ai.vercel.app/api/report-route?dest=%2Freport
500
```

`ReportLinkCard` が**全利用者**をこの口へ通していたので、
**ダッシュボードの「報告書を読む」が誰も開けない状態**だった。
→ 呼び出しを外し、`Response.redirect()` (headers が immutable で
`cache-control` を付けられない) も自前の `redirect()` へ置き換えた
(署名 URL が共有キャッシュへ載らないように `private, no-store`)。

### 6.2 `astro check` が 6 errors で CI が赤

`src/types/supabase-diagnosis.ts` が**生成し直しの取りこぼし**で
migration の 5 列を欠いていた (`report_pdf_url` / `report_pdf_sha256` /
`report_pdf_pages` / `report_pdf_received_at` / `source_key`)。
**型だけ**を実 DDL に合わせた (**DB は 1 文字も変えていない**・migration を足さない)。

### 6.3 行き先の判定を器から画面へ移した

`ReportLinkCard` が全員を resolver へ通していたのを、
`dashboard.astro` の条件分岐に変えた (発注者指示 §22 / §26)。
**通常利用者とデモは従来どおり `/report`**。

---

## 7. 検証

```
npm run verify:transcosmos-reports    # 140 件 (CI の A 層)
npm run verify:url-uid-privacy        # T-11c/T-11d を追加
npm run verify:special-accounts / verify:email-auth / verify:single-purchase
npx astro check / astro build
```

- **退行注入 13 種**とも名指しで落ちることを確認済み
  (クライアント uid を採る / 存在確認を外す / placeholder に `auth_user_id` /
  `ignoreDuplicates` を外す / キーの uid 突合を外す / 器で全員 resolver /
  判定を `source_key` だけに / `noStore(ctx.response)` を戻す /
  デモに manual の `source_key` / 非 admin を通す / 生成型から `source_key` を外す /
  冪等を壊す / `?u=` を非 admin に開く)
- **H** は**本物の ZIP を組んで**画面と同じ `fflate` + `crypto.subtle` 経路を通す
  (ライブラリの実バージョンで動くかは静的検査では分からない)

### 7.1 この環境で確認できていないもの

- **admin 画面の実ブラウザ操作**。`?u=` 入場は**admin を与えない**仕様
  (`viewer.ts:388-391`) なので、Supabase / HP Edge が無いこのコンテナでは
  管理者になれない。**本番で 1 回通すのが完了条件。**
- 実 PDF 10 本の upload / 署名 URL の実挙動 / `lab-results` バケットの書き込み権限

---

## 8. 今回やっていないこと

Elith 再処理 / Elith JSON 生成 / AI問診 / OCR / Genoplan / 健康診断データ /
`test_artifacts` / `measurement_values` / `ai_prediction` / LAiF / S3 /
wellfort-site / **DB migration** / 新規 schema / 報告書 HTML renderer /
PDF→JSON 変換 / Supabase Auth ユーザー作成。
