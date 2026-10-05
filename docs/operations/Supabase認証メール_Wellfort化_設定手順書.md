# Supabase 認証メールの Wellfort 化 — 設定手順書

**対象プロジェクト**: `nfubaioudhggqbzaussw`（診断アプリ側 = Scan-Chat-AI）
**作成**: 2026-10-05 ／ **状態**: 準備完了・**本番は未適用**（発注者操作が要る）

---

## 0. この文書の位置づけ（最初に読む）

**Hosted Supabase の認証メールは、リポジトリのファイルでは変わらない。**

| 項目 | 変更できる場所 | リポジトリで管理できるか |
|---|---|---|
| メールテンプレート（件名・本文） | **Dashboard** → Authentication → Email Templates（または Management API） | **できない**（下記のとおり） |
| Custom SMTP | **Dashboard** → Authentication → SMTP Settings | できない |
| Site URL / Redirect URLs | **Dashboard** → Authentication → URL Configuration | できない |

出典（Supabase 公式 [Email Templates](https://supabase.com/docs/guides/auth/auth-email-templates)）:
> "Edit templates on the Email Templates page in the dashboard."
> "The dashboard template builder does not apply when running local development with CLI or self-hosted Supabase."

→ `supabase/config.toml` の `[auth.*]` は**ローカル CLI / セルフホスト専用**で、
Hosted プロジェクトには届かない。実際このリポジトリの `config.toml` は
`site_url = "http://localhost:4321"` のままだが、本番はそれとは無関係に動いている。

**`supabase/templates/confirmation.html` は「文面の正本」であって「本番が変わった証拠」ではない。**
本番を変えたら、**この文書の §5 に設定値を書き戻すこと**（それが唯一の記録になる）。

---

## 1. 現状（2026-10-05 実測）

| | 現在 | 目標 |
|---|---|---|
| 送信者 | `Supabase Auth <noreply@mail.app.supabase.io>` | `Wellfort <no-reply@wellfort.co.jp>` |
| 件名 | `Confirm Your Signup` | `【Wellfort】メールアドレスの確認` |
| 本文 | Supabase 標準の英語テンプレート | `supabase/templates/confirmation.html` |
| SMTP | **Supabase 既定**（未設定） | Custom SMTP |
| Site URL | **`localhost` 系**（実測：確認メールのリンクが localhost へ飛んだ） | `https://scan-chat-ai.vercel.app` |

**Supabase 既定 SMTP は本番で使ってはいけない。** 公式 [Custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp) より:
> "Currently this value is set to **2 messages per hour**."
> "The default SMTP service is provided as best-effort only and intended for the following **non-production** use cases"
> "We urge all customers to set up custom SMTP server for all other use cases."

→ **1 時間に 2 通**。テスト数人で頭打ちになる。Custom SMTP は体裁の話ではなく**稼働の前提**。

---

## 2. 確認フローは変えない（重要）

- 本アプリは **implicit flow**。`@supabase/auth-js` 2.106.1 の既定が
  `flowType: 'implicit'`（`node_modules/@supabase/auth-js/dist/main/GoTrueClient.js:24` で実測）で、
  `createClient(url, key)` に options を渡していない（`EmailPasswordAuth.astro:110` / `GoogleOneTap.astro:113,168`）。
- したがってテンプレートは **`{{ .ConfirmationURL }}` のままで成立する**。
- **PKCE へ変えない / `/auth/confirm` を新設しない / token・token_hash・redirect_to・SiteURL から
  URL を自分で組み立て直さない。**
- `EmailPasswordAuth.astro` の `emailRedirectTo: ${location.origin}/dashboard`（`:164`）は**変更不要**。
  本番からは `https://scan-chat-ai.vercel.app/dashboard` が渡る。

---

## 3. 発注者の操作（Dashboard・3 か所）

### A. Email Templates

`Authentication` → `Email Templates` → **`Confirm signup`**

| 欄 | 入れる値 |
|---|---|
| Subject heading | `【Wellfort】メールアドレスの確認` |
| Message body | `supabase/templates/confirmation.html` の**コメント（`<!-- -->`）を除いた本文**をそのまま貼る |

**確認**: 貼ったあと本文に `{{ .ConfirmationURL }}` が **1 個**在ること。

### B. URL Configuration（**先にこれを入れる**）

`Authentication` → `URL Configuration`

| 欄 | 入れる値 |
|---|---|
| Site URL | `https://scan-chat-ai.vercel.app` |
| Redirect URLs | `https://scan-chat-ai.vercel.app/**` |

- `**` は「任意の文字列にマッチ」（公式 [Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)）。
  `/dashboard` だけを登録してもよいが、`/**` にしておくと将来パスが増えても設定変更が要らない。
- Preview デプロイでも確認するなら
  `https://scan-chat-ai-git-*-harus-projects-a666f08d.vercel.app/**` も足す（Preview は毎回オリジンが変わる）。
- ローカル開発用に `http://localhost:4321/**` を足しても害は無い。
- 将来 `app.wellfort.co.jp` へ移すときは**この 2 欄も一緒に変える**。

### C. SMTP Settings

`Authentication` → `SMTP Settings` → Custom SMTP を有効化。§4 を参照。

---

## 4. Custom SMTP — 既存の Resend を使う

**Wellfort は既に Resend を本番で使っている。** 新規契約は要らない。

- 実装: `wellfort-site` の Edge Function `supabase/functions/order-mail/index.ts`
  （`:190` で `https://api.resend.com/emails` を叩く）
- 使っている env 名: **`RESEND_API_KEY`** / **`RESEND_FROM_EMAIL`**（Supabase Secrets に設定済み）
- 既定差出人: **`noreply@wellfort.co.jp`**（`order-mail/index.ts:31` の `FROM_FALLBACK`）
- `wellfort-site/docs/payment/order_mail_spec.md:184`:
  「**Resend の送信ドメイン検証**: 既定差出人は `noreply@wellfort.co.jp`。未検証だと全送信が拒否される。」

→ **注文メールが本番で届いている＝`wellfort.co.jp` は Resend で検証済み**（＝SPF/DKIM の DNS は既に入っている）
と考えられる。**ただしこれは推測なので、Resend 管理画面の Domains で「Verified」を目視確認すること。**

### Supabase の SMTP Settings に入れる値

Resend 公式 [Send with SMTP](https://resend.com/docs/send-with-smtp) より:

| Supabase の欄 | 値 | 出典 |
|---|---|---|
| Host | `smtp.resend.com` | Resend 公式 |
| Port | **`587`**（STARTTLS）／ `465` でも可（Implicit TLS） | Resend 公式。`25/587/2587` は Explicit、`465/2465` は Implicit |
| Username | `resend` | Resend 公式 |
| Password | **Resend の API キー**（`RESEND_API_KEY` と同じ値でよい） | Resend 公式「Your API key should be used as the password」 |
| Sender email | `no-reply@wellfort.co.jp`（※ §4.1 参照） | — |
| Sender name | `Wellfort` | — |
| Minimum interval | 既定のまま | — |

**API キーの実値はこの文書にも、コードにも、チャットにも書かない。**
Resend 管理画面 または 既存の Supabase Secrets（`wellfort-site` 側プロジェクト）から取得して、
**Dashboard の入力欄に直接貼る**こと。

### 4.1 差出人アドレスの表記ゆれ（要判断）

| | アドレス |
|---|---|
| ご指定 | `no-reply@wellfort.co.jp`（ハイフン**あり**） |
| 既存の注文メール | `noreply@wellfort.co.jp`（ハイフン**なし**） |

**どちらでも送れる**（Resend はドメイン単位の検証なので、`@wellfort.co.jp` なら
ローカル部は自由）。ただし**利用者から見ると別の差出人に見える**ので、
**揃えるかどうかは発注者の判断**。揃えるなら既存の `noreply@` に合わせるのが変更が少ない。

### 4.2 サブドメイン分離（候補・今回は実施しない）

Resend 公式 [Domains](https://resend.com/docs/dashboard/domains/introduction):
> "We recommend sending your emails from one or more subdomains (e.g., `updates.example.com`)
>  instead of your root domain to isolate your sending reputation."

→ 認証メールを `no-reply@auth.wellfort.co.jp` に分ける構成は**公式も推奨する形**。
ただし **`auth.wellfort.co.jp` を Resend で新規にドメイン検証する必要があり、
DKIM/SPF の DNS レコード追加が要る**。今回は既存の `wellfort.co.jp` をそのまま使えば
DNS 変更ゼロで済むので、**初回は分離しない**ことを薦める。
分離するなら別タスクとして DNS 作業込みで計画すること。**DNS はこちらでは変更しない。**

---

## 5. 適用後に書き戻す（この表が本番の記録）

本番へ入れたら、ここを埋めること。**埋まっていない＝未適用**として扱う。

| 項目 | 設定値 | 適用日 | 適用者 |
|---|---|---|---|
| Site URL | | | |
| Redirect URLs | | | |
| Confirm signup Subject | | | |
| Confirm signup Body | `supabase/templates/confirmation.html` の版（commit SHA） | | |
| SMTP Host / Port | | | |
| SMTP Username | | | |
| Sender email / name | | | |
| Resend ドメイン検証 | Verified / 未 | | |

---

## 6. 通し確認（設定後）

**新規のテスト用メールアドレス**で行う。**本番データに行が増える**ので、
実施前に発注者の許可を取り、使ったアドレスをここに記録すること。

1. `https://scan-chat-ai.vercel.app/` で新規登録
2. 確認メールが届く
3. 送信者が **Wellfort**（`noreply@mail.app.supabase.io` でない）
4. 件名が **`【Wellfort】メールアドレスの確認`**
5. 本文が Wellfort 仕様（ロゴ文字・見出し・ボタン・破棄案内・社名）
6. ボタンが表示される
7. ボタンの URL が `https://nfubaioudhggqbzaussw.supabase.co/auth/v1/verify?...` で始まる
   （＝ `{{ .ConfirmationURL }}` が正しく展開されている。自前 URL になっていない）
8. クリック後 `https://scan-chat-ai.vercel.app/dashboard` へ遷移する（localhost へ行かない）
9. 同じメール＋パスワードでサインインできる
10. `/api/auth/resolve` を経て既存 Web アプリへ入れる

**8 が localhost のままなら §3-B（URL Configuration）が入っていない。**
**3 が `Supabase Auth` のままなら §3-C（SMTP）が入っていない。**

---

## 7. やらないこと

- **PKCE へ変えない。** `/auth/confirm` を作らない。
- `{{ .ConfirmationURL }}` 以外でリンクを組み立てない。
- `emailRedirectTo` をコードで変えて URL Configuration の代わりにしない（代替にならない）。
- 認証メールをマーケティングメール化しない（商品説明・宣伝・キャンペーン・SNS リンクを入れない）。
- 外部画像を入れない（ブロック・tracking 扱い・spam 判定）。正式ロゴは別途ホスティング先を決めてから。
- **SMTP の API キー・パスワードをコード / commit / ログ / チャットに出さない。**
- DNS を勝手に変更しない。
