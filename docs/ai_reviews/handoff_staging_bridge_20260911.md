# 引継ぎ: staging 購入者の「検査キットの進捗」が空になる — bridge 接続が未成立

作成 2026-09-11 / 宛先: 外部レビュー (ChatGPT)

**この文書には推測を書かない。** 各項目に出典 (`file:line` / 実測値 / 発注者報告) を付け、
確認できていないものは §8 に分離した。§8 を既知として扱わないこと。

---

## 1. いま何が起きているか

Scan-Chat-AI の `/kit`・`/dashboard` で「検査キットの進捗」が空になる。
サインイン自体は成功している (前段の `linked:false` 問題は解消済み)。

## 2. 構成 (実測)

| 系統 | project | 備考 |
|---|---|---|
| HP/EC Production | `wellfort` = `nlydlveiokiivjwpnnaf` | `wellfort-site/supabase/config.toml:3` / 本番サイトの HTML から実測 |
| HP/EC Staging | `wellfort-staging` = `fwznrwwqfwoywjbozwvd` | 発注者提示 |
| Web アプリ (診断系) | `nfubaioudhggqbzaussw` | `wellfort-site/docs/web_linkage/お知らせ機能_仕様書.md:28` |

総合テストは **staging の EC で購入 → 本番の Web アプリ (`scan-chat-ai.vercel.app`) でサインイン**
という環境跨ぎの構成で行っている。

## 3. データ側 (staging・実測)

`app_bridge` の同期は確立済み。

| 表 | 件数 |
|---|---|
| `app_bridge.customer_account` | 1 |
| `app_bridge.subscription` | 1 |
| `app_bridge.kit_shipment` | **2** |

`kit_shipment` の中身:

| diagnostic_user_id | order_id | test_type | shipping_status | shipped_at | tracking_no |
|---|---|---|---|---|---|
| `5c4c5c71-7cdb-47b5-a50e-9bb37e8b5338` | `WF-20260910-T2J5EO` | 検査パッケージ | preparing | null | null |
| 同上 | `WF-20260911-4H71PV` | 検査パッケージ | preparing | null | null |

元注文 (`public.orders`) は 2 件とも `payment_status=paid` / `brand=wellfort` /
`is_subscription=true` / `shipping_status=preparing`。

同期の経路は **DB 内の pg_cron**。`scripts/app-bridge-refresh.sql` §5 に定義があり
(従来コメントアウト)、今回 staging に登録済み。`refresh_*` を呼ぶアプリコード・
Edge Function・GitHub Actions・Vercel Cron は **repo 全体で 0 件**。

## 4. アプリ側 (Scan-Chat-AI・実測)

- ブリッジ読み取りは `src/lib/bridge-queries.ts:104` `loadBridgeBundle()`。
  `customer_account` の取得に失敗すると `{error}` を返し、
  `src/lib/dashboard-queries.ts` が `safeBundle`（空）へ潰す。**画面にエラーは出ない。**
- 接続は `src/lib/supabase.ts` の `getBridgeSupabase(origin)`。
  `createClient(url, key, { db: { schema: 'app_bridge' } })`
  ＝ **supabase-js は同じ key を `apikey` と `Authorization` の両方に載せる。**
- 環境の切り替えは 2026-09-11 に実装済み (PR #217 / マージ済み `7cb8d06`)。
  - `BridgeOrigin = 'production' | 'staging'`
  - staging 用 env は `HP_BRIDGE_STAGING_SUPABASE_URL` / `HP_BRIDGE_STAGING_READONLY_KEY`
  - どちらの向きにも**無条件フォールバックしない**
  - 判定はサインイン時に Cookie へ載せた印 (`viewer.origin`)。
    staging のときだけ 5 分割 (`uid.exp.admin.s`)、production は従来の 4 分割のまま。
    印の無い Cookie は production 扱い。

## 5. staging の権限まわり (実測・時系列)

1. 初期状態: `Accept-Profile: app_bridge` で REST 照会 →
   `{"code":"PGRST106","message":"Invalid schema: app_bridge",
     "hint":"Only the following schemas are exposed: public, graphql_public"}`
   → **`app_bridge` が PostgREST に公開されていなかった**
2. Exposed schemas に `app_bridge` を追加 (発注者操作) → 同じ照会が
   `{"code":"42501","message":"permission denied for schema app_bridge"}` に変化
   → **公開は成功。anon に権限が無い状態** (同じ鍵で `public.test_products` は HTTP 200)
3. `wellfort-site/supabase/migrations/20260905010000_p0_authorization_hardening.sql:444-449`
   が **anon から `app_bridge` の USAGE / SELECT を明示的に REVOKE** している。
   同 `:452-456` が `app_bridge_readonly` へ USAGE + 4 表の SELECT を GRANT。
4. `app_bridge_readonly` ロールは `20260905000010_wellfort_baseline.sql:56-65` で
   **NOLOGIN** として作成される。RLS ポリシーは同 `:963-967` で `TO app_bridge_readonly`。
5. staging で以下を実行済み (発注者操作)。結果も実測:

   | 確認 | 値 |
   |---|---|
   | `app_bridge_readonly` の存在 / `rolcanlogin` | あり / **false** |
   | `authenticator` への付与 | **true** |
   | RLS ポリシー | `customer_account` / `kit_shipment` / `subscription` の 3 表に `dev_select_all` (`TO {app_bridge_readonly}` / SELECT) |

## 6. 詰まっている点

`HP_BRIDGE_STAGING_READONLY_KEY` に入れるべき鍵が用意できていない。

- staging の API Keys 画面にあるのは **新方式**の
  `sb_publishable_…`（Publishable）と `sb_secret_…`（Secret）。
  別タブに「Legacy anon, service_role API keys」が存在する。
- `role: app_bridge_readonly` の JWT を自作して試す方針を取ったが、
  **JWT Secret を取得できず**、署名に使った変数が空 (`$secret.Length = 0`) のまま
  実行され続けた。したがって**自作 JWT が受け付けられるか否かは検証できていない**
  (空文字で署名した JWT に対する `{"message":"Invalid API key"}` は、
   鍵方式の可否の証拠にならない)。

## 7. 変更済みのもの (参考)

| repo | branch / PR | 状態 |
|---|---|---|
| Scan-Chat-AI | PR #217 `feature/staging-bridge` | **マージ済み** (`7cb8d06`)。staging bridge 経路 |
| Scan-Chat-AI | PR #214/#216 `feature/staging-customer-resolve` | マージ済み。staging の `resolve-customer` を引く段 |
| wellfort-site | PR #403 / #404 | マージ済み。staging へ `resolve-customer` を配る手動ワークフロー (`--no-verify-jwt`) |
| wellfort-site | PR #405 (main) / #406 (staging) | **未マージ**。`WellfortProductDetail.astro` の `customer_profiles` upsert に `email` 追加 + 失敗時に決済へ進ませない |

## 8. 未確認 (既知として扱わないこと)

1. staging に **legacy JWT secret が存在するか**（存在すれば自作 JWT の路線が使える）
2. **自作 HS256 JWT が staging のゲートウェイで `apikey` として受理されるか**
   （新 API キー方式での挙動。上記のとおり未検証）
3. production の `HP_BRIDGE_READONLY_KEY` の `role` クレームが何か
   （production がどの方式で通っているかの手掛かり）
4. Vercel Production の `HP_BRIDGE_STAGING_SUPABASE_URL` /
   `HP_BRIDGE_STAGING_READONLY_KEY` の現在値（設定済みか、何を入れたか）
5. サインイン時の Cookie に staging 印が付いたか
   （サーバログ `[auth/resolve] ステージングの顧客として解決しました` の有無で判る）
6. `test_type` の値 `検査パッケージ` の扱い。
   `src/lib/dashboard-queries.ts:479-488` の `testTypeLabel()` が持つキーは
   `health_checkup` / `blood` / `genetics` / `cancer_urine` / `ai_prediction` の 5 種のみで、
   未知の値は `map[type] ?? { name: type, icon: 'result' }` にフォールバックする。
   仕様書 `docs/subscription/検査キット_データモデル_仕様書.md` §2.5.1 が
   「アプリ側が期待する正準コードとは別の語彙」と記載。
   **どの正準コードに対応させるべきかを決められる記述は見つかっていない。**

## 9. 検討したが決めていない選択肢

いずれも staging 限定・production 無変更。**採否は未決定。**

| 案 | 内容 | 判明している性質 |
|---|---|---|
| A | `HP_BRIDGE_STAGING_READONLY_KEY` に `sb_secret_…` を使う | SQL・コード変更なし。service_role 相当の権限をブリッジに渡す。`HP_BRIDGE_*` は SSR 専用でブラウザには出ない |
| B | staging の `anon` に `app_bridge` の USAGE/SELECT を戻し `sb_publishable_…` を使う | `p0_authorization_hardening.sql:444-449` が REVOKE した対象を再付与することになる。publishable key はブラウザに出る。RLS ポリシーは `app_bridge_readonly` 向けのみで anon 向けは無い |
| C | `role: app_bridge_readonly` の JWT を発行 | §8-1・§8-2 が未確認のため可否不明 |
| D | コード側で `apikey` と `Authorization` を分けて送る | supabase-js は `global.headers` で `apikey` を上書きできる。現状は同一 key を両方に載せている (`supabase.ts`)。C が可能な場合に意味を持つ |

## 10. レビューで判断してほしいこと

1. §8 の 1・2 をどう確定させるか（確定手段も含めて）
2. §9 の A〜D のどれを採るべきか。**staging 限定で service_role 相当を使うことの是非**
3. `test_type` = `検査パッケージ` を、bridge 側 (`refresh_kit_shipment` で
   `test_products.category` → 正準コードへ写像) と Scan 側 (`testTypeLabel` に追加) の
   どちらで扱うべきか
4. 「環境跨ぎ (staging EC → production Web アプリ) でテストする」という構成自体の妥当性。
   Scan-Chat-AI 側に staging デプロイを立てて env を staging に向ける案との比較
