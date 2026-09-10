# 引継ぎ: 総合テストでサインインが「お客様情報が見つかりませんでした」で止まる

作成 2026-09-10 / 宛先: 外部レビュー (ChatGPT)

**この文書には推測を書かない。** 各項目に出典（`file:line` / 実測値 / 公式ドキュメント）を付け、
出典を出せないものは「§7 未確認」に分離した。§7 の項目を既知として扱わないこと。

---

## 1. 事象

総合テストの構成:

- **ステージングの EC サイトで、新規 Google アカウントを作成して検査プラン商品を購入**（発注者報告）
- **購入後、マイページを開けた**（発注者報告）
- マイページから Web アプリ（Scan-Chat-AI）へのリンクで遷移し、Google 認証
- → 画面に「**お客様情報が見つかりませんでした。検査のお申し込み状況をご確認のうえ、サポートまでご連絡ください。**」

ブラウザコンソール（発注者提供・原文）:

```
[OneTap] signInWithIdToken OK, uid: d1f1aa90-fc74-4456-9ce3-678e5779ff7c hasToken: true
[OneTap] resolving customer server-side…
[OneTap] not linked
```

## 2. この文言が出る条件（コード実測）

`src/components/GoogleOneTap.astro:192`

```js
if (!payload.linked || !payload.diagnosticUserId) { … 当該文言 … }
```

- 直前 `:186` で `!res.ok` なら別文言（`連携処理エラー: …`）
- さらに前 `:164` で Supabase 認証失敗なら別文言（`認証エラー: …`）

→ **この文言が出た時点で、Google 認証は成功し、`POST /api/auth/resolve` は HTTP 200 を返し、
その中身が未連携だったことが確定する。**

## 3. `/api/auth/resolve` の分岐（`src/pages/api/auth/resolve.ts`・実測）

行番号は 2026-09-10 の変更後（コミット `20a4556` 適用後）。

| 行 | 処理 |
|---|---|
| `:61` | `isHpEdgeConfigured()` が真なら `resolveCustomerWithAdmin(email)` を呼ぶ |
| `:100` | `outcome.customer` が取れたら採用 |
| `:104-108` | 取れなければ `resolveLocally()`（**例外時も「該当なし」時も同じ else に入る**） |
| `:161` | **staging の `resolve-customer` を引く段（2026-09-10 追加）** |
| `:178` | `uidIsAuthoritative = diagnosticUserId !== null` |
| `:180` | デモ用アカウントの uid 発行（`resolveDemoUidByEmail`） |
| `:185` | `if (!diagnosticUserId) return json({ linked: false }, 200)` |
| `:194` | 既存束縛との張り替え |
| `:210` | `signViewer(diagnosticUserId, isAdmin \|\| await isAdminEmailAsync(email))` |

**管理者判定は入場資格ではない。** `:210` は `:185` の return より後にあり、
uid が決まらなければ到達しない。`isAdmin` は Cookie に載せる権限フラグのみ。
（コード上のコメント `:78`「admin 判定は顧客の有無と独立」とも一致）

`resolveLocally()`（`:46-59`）が引くのは
**Scan-Chat-AI 自身の Supabase の `customer.customer_profiles`**（`sb.schema('customer')`）で、
`ilike('email', email)`。

## 4. 顧客の解決に使われる Edge Function（実測）

`wellfort-site/supabase/functions/resolve-customer/index.ts`

- `:73-80` **`public.customer_profiles` を `ilike(email)` で検索**、`is_default` → `created_at` 降順、`limit(1)`
- `:84-87` 該当なし または `status === 'withdrawn'` は `{ success: true, data: null }`（**例外にしない**）
- `:89-93` 返すのは `diagnostic_user_id` と `display_name`（**姓のみ**。`toFamilyName()` で整形）
- `:46-53` **`RESOLVE_SHARED_SECRET` が未設定なら、シークレット照合そのものをスキップする**

呼び出し側 `src/lib/hp-edge.ts:13` は
`const EDGE_BASE = () => import.meta.env.HP_EDGE_BASE_URL`
＝ **接続先は env 1 本**。`hp-edge.ts` / `supabase.ts` / `resolve.ts` を `staging` で grep して **0 件**
（＝コードに環境切替は存在しない）。

## 5. `customer_profiles` は 2 つある（同名・別物）

| | EC 側 `public.customer_profiles` | Web アプリ側 `customer.customer_profiles` |
|---|---|---|
| 実体 | Wellfort の Supabase | Scan-Chat-AI の Supabase |
| 書く場所 | `wellfort-site/src/components/CheckoutFlow.astro:254-268`（**ブラウザからの upsert**・`onConflict: 'user_id'`・`email: currentSession.user.email`）／`src/pages/mypage.astro:1181`（同じ upsert） | **アプリ内に書く実装が無い**。`insert` は `supabase/seed.sql:35` / `seed_admin_users.sql:23` / `demo_oem_account.sql:43` の 3 本のみ |
| 読む場所 | `resolve-customer` Edge Function | 下記 7 か所 |

**`create-order` Edge Function は `customer_profiles` に触れない**
（`wellfort-site/supabase/functions/create-order/index.ts` を `customer_profiles` / `diagnostic_user_id` で grep して 0 件）。

`CheckoutFlow.astro:267` は **upsert が失敗しても決済を止めず `console.error` のみ**。
同ファイル `:251-253` のコメントに、過去に `email` 欠落で新規顧客の INSERT が失敗し
「購入だけした顧客のプロフィールが作られないまま注文が成立していた」実績が記録されている。

`diagnostic_user_id` は `wellfort-site/scripts/migration-add-diagnostic-user-id.sql:23` で
`NOT NULL DEFAULT gen_random_uuid()`。

`mypage.astro:1135` は `customer_profiles` を `eq('user_id', currentUser.id)` で `select` する。

### Web アプリ側 `customer.customer_profiles` を読む 7 か所（すべて `select`・すべて `sb.schema('customer')`）

| 場所 | 引き方 | 取る列 |
|---|---|---|
| `src/pages/api/auth/resolve.ts:49` | `ilike('email')` | `diagnostic_user_id, family_name` |
| `src/lib/dashboard-queries.ts:210` | `eq('diagnostic_user_id')` | `*`（無ければ `customer:null` で以降空） |
| `src/lib/chat-context.ts:44` | `eq('diagnostic_user_id')` | `family_name, date_of_birth, sex` |
| `src/lib/chat-context.ts:106` | 同上 | 同上 |
| `src/lib/coach-context.ts:51` | 同上 | `family_name, given_name, date_of_birth, sex` |
| `src/pages/api/admin/elith-assemble.ts:205` | 同上 | `date_of_birth, sex` |
| `src/pages/api/kit/[id]/self-report.ts:55` | 同上 | `user_id`（無ければ 404 `customer not found for diagnostic_user_id`） |

## 6. 環境（プロジェクト）

| 系統 | project | 出典 |
|---|---|---|
| HP/EC 本番 | `wellfort` = **`nlydlveiokiivjwpnnaf`** | `docs/subscription/検査キット_データモデル_仕様書.md:70` ／ `wellfort-site/supabase/config.toml:3` ／ `https://www.wellfort.co.jp/mypage` の HTML から実測 |
| HP/EC ステージング | **`wellfort-staging`** | 同仕様書 `:70`。**ref・URL はリポジトリのどこにも記載が無い** |
| Web アプリ（診断系） | **`nfubaioudhggqbzaussw`** | `wellfort-site/docs/web_linkage/お知らせ機能_仕様書.md:28`（「両プロジェクト ref を実値で確定」） |

仕様書の記載（同仕様書 §2 の囲み）:
「`isBridgeConfigured()` は env の有無しか見ず、**接続先の project を見ない**（`supabase.ts:67-69`）」。
`isHpEdgeConfigured()`（`hp-edge.ts:17-19`）も `!!EDGE_BASE()` を返すだけで同形。

Edge Function のデプロイ設定 `wellfort-site/.github/workflows/deploy-supabase-functions.yml`:
`PROJECT_REF` は **secret 1 本**、トリガーは **`main` への push のみ**
（＝リポジトリ上、staging へ配る仕組みは無い）。

## 7. 2026-09-10 に加えた変更と、そこで見つかった不具合

### 7.1 変更

`resolve.ts:161-176` に「staging の `resolve-customer` を引く段」を追加。
`hp-edge.ts` に `isHpEdgeStagingConfigured()` / `resolveStagingCustomerByEmail()` を追加。
新 env: `HP_EDGE_STAGING_BASE_URL` / `RESOLVE_SHARED_SECRET_STAGING`。
staging 経路は `is_admin` を読まない（権限を運ばない）。

- コミット `20a4556` → PR #214 でマージ → 本番ブランチ `claude/awesome-carson-UeyUZ` の `2b06749`
  （マージ時刻 2026-09-11 06:16:43 +0900）

### 7.2 その実装に不具合があった（ビルド成果物で実測）

デプロイされた成果物
`.vercel/output/functions/_render.func/dist/server/pages/api/auth/resolve.astro.mjs`:

```js
function isHpEdgeStagingConfigured() {
  return false;
}
```

`EDGE_BASE_STAGING` の定義自体が消えている。
Vite が `import.meta.env.HP_EDGE_STAGING_BASE_URL` を**ビルド時に畳み込み**、
ビルド時点で未定義だったため `!!undefined` → `false` が定数化された。
→ **env を後から設定しても効かない。上記の段は呼ばれず、ログも一切出ない。**

同リポジトリにはこの事象への対策が既に存在した:
`src/lib/supabase.ts:47-48`「SSR ランタイムで非 PUBLIC 変数を確実に読むため、
`import.meta.env` を優先しつつ取れない場合は `process.env`（Node ランタイム = Vercel SSR）に
フォールバックする」。`src/pages/dashboard.astro:51` も同じ二段読み。

### 7.3 修正（**未マージ**）

コミット `9233e14`（ブランチ `feature/staging-customer-resolve`・push 済み・**本番ブランチには未反映**）。
`envOfStaging()` で二段読みへ変更。再ビルド後の成果物
`.vercel/output/functions/_render.func/dist/server/chunks/hp-edge_DEn0x5rn.mjs`:

```js
function isHpEdgeStagingConfigured() { return !!EDGE_BASE_STAGING(); }
const EDGE_BASE_STAGING = () => envOfStaging("HP_EDGE_STAGING_BASE_URL") || void 0;
function envOfStaging(name) {
  const v = Object.assign(__vite_import_meta_env__, { _: process.env._ })[name];
  if (v) return v;
  if (typeof process !== "undefined" && process.env) return process.env[name] ?? "";
  return "";
}
```

`astro check` 0 errors / `astro build` 成功。

**注意**: §1 の事象（`[OneTap] not linked`）は **7.1 のマージ後・7.3 の修正前**に観測されている。
その時点の本番コードは 7.2 の `return false` なので、**staging の段は実行されていない**。

## 8. 未確認（既知として扱わないこと）

1. `wellfort-staging` の project ref / URL（リポジトリに記載なし）
2. `wellfort-staging` に `resolve-customer` がデプロイされているか
3. Vercel（Scan-Chat-AI）に `HP_EDGE_STAGING_BASE_URL` / `RESOLVE_SHARED_SECRET_STAGING` が
   設定されたか
4. 本番 Web アプリの `HP_EDGE_BASE_URL` が実際にどの project を指しているか
   （`GET /api/debug/viewer` は「設定あり／未設定」しか返さない・実測）
5. **staging の `public.customer_profiles` に、今回のテストアカウントの行が在るか**
   - 仕様書 `docs/subscription/検査キット_データモデル_仕様書.md:423` には
     「`wellfort-staging.app_bridge.kit_shipment` = 0 行（`customer_profiles`=0 のため内部結合で 0）」
     という **レビュー報告値**があるが、これは別ユーザー・別時点（対象注文 `WF-20260909-1WJKKK`）の
     観測であり、**今回のアカウントには適用できない**
6. Vercel の関数ログの内容（`[auth/resolve]` 系の出力有無）

## 9. 関連仕様（正本）

- `docs/subscription/検査キット_データモデル_仕様書.md`
  - §2 環境の定義（Production / Staging が別 project）
  - §6.3(a) staging 実測（レビュー報告値）
  - §9-0 未確認事項（③「staging の env が本番を指していないか」を着手初期に確認）
  - §10.1 実装フェーズの約束事（**staging 限定・Production は NO-TOUCH**）
- `CLAUDE.md`「アプリ構成 / 管理画面の所在」（admin UI = wellfort-site / API = Scan-Chat-AI）
- `CLAUDE.md`「PII / データ分離」（`diagnostic_user_id` のみで橋渡し）

## 10. レビューで判断してほしいこと

1. §8 のうち、どれを先に確定させるべきか（確定手段も含めて）
2. 「staging の顧客を本番 Web アプリで解決する」方式（7.1）と、
   「Scan-Chat-AI の別デプロイの env を staging に向ける」方式のどちらを採るべきか
3. 7.1 を採る場合、本番の認証経路に staging の解決口を常設することの是非
   （staging 由来 uid が本番 `diagnosis` にデータを作る／`app_users` の
   `auth_user_id` / `google_sub` は UNIQUE で、後から本番 uid と食い違うと
   `resolve.ts:194-215` の張り替えが走る）
4. `CheckoutFlow.astro:254-268` の upsert が
   「配送先フォームの submit ハンドラ内にあり、失敗しても決済を止めない」構造の是非
