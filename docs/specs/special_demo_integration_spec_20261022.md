# Special / Demo 統合・表示モード切替・デモ検証 — 実装の正本

作成 2026-10-22 / 対象 `mirai-gpro/Scan-Chat-AI`・`mirai-gpro/wellfort-site`

発注者から受領した 2 文書（`Wellfort_Special_Demo_統合仕様書_v1.0_20261022.md` /
`ClaudeCode指示書_Special_Demo統合_20261022.md`）と、**Phase 0 報告に対する発注者裁定
（2026-10-22）**を 1 本にまとめたもの。**以後はこの文書が正本**で、2 文書の記述と
食い違う箇所は本書（＝裁定）が勝つ。

> **実装状況: PR-A（§3）だけが実装済み。** §4 以降は未実装。
> **PR-A 以外の変更を PR-A へ混ぜない**（発注者指示 10）。

---

## 1. 絶対条件（発注者）

1. 1 人につき `diagnostic_user_id` は 1 つ。Demo / Special 追加で UID を増やさない
2. Demo 資格と Special / Real 資格を**同時に持てる**
3. **資格**（`canDemo` / `canReal`）と**現在の表示モード**（`effectiveMode`）を分離する
4. Dual ユーザーのログイン直後は**必ず Real**
5. Demo 表示中だけ Demo データを使う
6. Real 表示中は**同じ UID の本人実データ**を使う
7. Demo でバーコードNo. 撮影・読取を**何度でも**テストできる
8. Demo では `customer.lab_test_id_captures` / `customer.lab_tests` を変更しない
9. Real のバーコード登録は**現在の本番動作を一切壊さない**
10. UID が Demo / Special で既に異なる場合は**自動統合しない**（fail-closed で管理者確認）
11. admin 代理表示・share では**モード切替不可**
12. 既存 Special の検査データ・Elith 納品・報告書を **re-key しない**

---

## 2. 発注者裁定（2026-10-22・Phase 0 報告への回答）

| # | 裁定 |
|---|---|
| **1** | **Demo fixture は追加しない。** Phase 0 の「デモでは `ExternalIdCapture` が出ない」は**誤り**。`kit.astro` の `st.step === 3` は `SHIPMENT_STAGES` を描くループ内の「**受取という段の行**」で、出荷の現在 step ではない。条件は `captureProviderFor(s)`（本人操作可 ∧ `shipped_at` ∧ provider ∧ flag）だけ＝**発送済みのデモのがんリスク出荷では撮影ブロックは出る**（実コードで再確認済み） |
| **2** | **Demo 専用 capture flag を作らない。** `labid.prevent_capture` は本番で**既に on**。`labid.prevent_capture_demo` のような追加設定は作らない。**DB migration も app_config キーも増やさない** |
| **3** | **Dual のレイアウトは `effectiveMode` で決める。** Special 専用 UI は概念的に `effectiveMode === 'real' && isSpecialAccount(uid)` のときだけ。少なくとも `dashboard.astro` の `singlePurchase` と `scan.astro` の `multiYear` を含む。Demo モードでは Special 資格者でも通常の Demo 体験・Demo データ。Real へ戻せば同じ canonical UID の実データへ戻る。**切替で実データを変更・削除・re-key しない** |
| **4** | **AI問診・AIスキャンは今回 Demo 書込み対応しない。** Demo から「scan 結果の本番保存 / `measurement_values` 更新 / `scan_jobs` 作成 / Elith source export / interview completion の本番記録 / Elith 納品」を行わせない。実データで試す必要がある人には Special / Real 資格を付与して Real で使う |
| **5** | **本番の Demo 由来台帳行（1 件）を自動で消さない・更新しない。** PR-A 完了報告で SELECT と `superseded` 化の SQL 案だけ提示する。本番 DB 変更は別途判断 |
| **6** | **同じ UID に Demo ＋ Real 資格が付いているのは正常な Dual 状態**（本番に 2 件実在）。`uidConflict` は「**同一人物のメール登録に異なる UID が存在する**」場合だけ |
| **7** | 正規入口は `/admin/experience-accounts` に一本化。旧 2 画面は削除しないが**新画面へ redirect** し、旧 API も**必ず canonical UID 解決層を通す**。**旧 API 経由で UID 分裂を再発させない**／**新 UI 以外に UID 採番ロジックを持たない** |
| **8** | PR-A の条件は暫定で `demoFallbackEnabled(uid) && isDemoShipmentId(shipmentRef)` の**両方**。片方だけで判定しない |
| **9** | 順序は PR-A → B（canonical UID）→ C（view-mode ＋ `shouldUseDemoData`）→ D（write 監査）→ E（統合管理画面）。**PR-C で PR-A の暫定判定を `effectiveMode === 'demo'` 系の共通判定へ必ず差し替える。スペシャル排他を別の場所へ移植しない** |

---

## 3. PR-A（実装済み）— バーコード Demo-safe

詳細は `docs/lab/kit_receipt_external_id_capture_spec.md` **§4.4.10**。要点のみ:

- `register` の **`confirmedValue` 照合の後・`getServerSupabase()` の前**に Demo 分岐
- 条件は 2 つとも（裁定 8）／応答は `demo: true` ＋ **マスクだけ**（全文を返さない）
- 画面は再読込せず「読取テスト完了 → もう一度撮影する」で**何度でも**繰り返せる
- fail-closed はデモでも効く（控え無し 409 / 読めない 400 / 画面と食い違い 409 / 画面から値 400）
- 検証 `npm run verify:external-id-capture` **754 件**（㉑ は API を実走させ
  `persistExternalIdCapture` の**呼び出し回数**を数える）

---

## 4. PR-B 以降

### 4.1 canonical UID（PR-B・**2026-10-22 実装済み**）

`src/lib/experience-accounts.ts` を新設し、`canDemo` / `canReal` / `canonicalUid` /
`uidConflict` を 1 か所で返す。既存 app_config キー（`demo.*` / `special.*`）は維持。

| 状態 | canonical UID |
|---|---|
| Special UID が既にある | その UID |
| Demo UID だけある | その UID を Special でも使う |
| どちらも無い | 1 個だけ発行 |
| **Demo と Special に異なる UID** | **`uidConflict`。自動統合しない・設定を書き換えない** |

**同じ UID が両資格に在るのは conflict ではない**（裁定 6）。

**現行の分裂経路（Phase 0 実測）**: Demo 登録済み（uid=B・サインイン済み）の人を Special に
メール登録すると、Special 登録 API が**その場で新 uid=C を発行**して B を見ない。
次のサインインで `resolve.ts` の事前発行ガードが **409**（＝本人がログインできない）。
→ PR-B でここを canonical 解決へ寄せた。**409 自体は維持**し、conflict として管理画面に出す（管理画面は PR-D）。

#### 4.1.1 実装（PR-B）

| 置き場所 | 中身 |
|---|---|
| **新規** `src/lib/experience-accounts.ts` | `detectConflict` / `lookupExperienceByEmail` / `resolveCanonicalUidByEmail` / `canonicalUidForRegistration` / `experienceCapabilities` |
| `api/auth/resolve.ts` | **変更は 1 か所だけ**。2 行の直呼びを canonical 層の 1 呼び出しへ |
| `api/admin/special-accounts.ts` | uid の決定を委譲。**`mintSpecialUid` の直呼びを撤去** |
| `api/admin/demo-accounts.ts` | Real 側に uid が在れば**写す**。**自分では採番しない** |
| `api/debug/viewer.ts` | `can_demo` / `can_real` / `dual_capability` を追加 |
| **新規** `scripts/verify-experience-accounts.mjs` | 62 件（CI の A 層） |

**side ごとに採番の扱いが違う**（設計提示時の「どちらも無ければ 1 個だけ発行」を実装で分けた）:

- `special` … uid が無ければ**その場で発行する**（本人のログイン前に検査データを入れる
  運用が成立しないため。スペシャル仕様書 §4.1.1）
- `demo` … uid が無ければ**発行しない**（`uid: null`）。デモ枠の uid は**従来どおり
  サインイン時に `linkDemoEmail` が埋める**。ここで発行すると現行の Demo の仕様を変えたうえ、
  **UID を増やす側へ倒れる**

**Demo 側に uid を写したときは `demo.account_uids` にも足す**（Special 側の「両方へ書く」と同じ）。
片方だけだと `isDemoAccount(uid)` が立たず、**画面上は登録済みなのにデモが出ない**。

**fail-closed の位置**: 競合は 409 / 名簿の照会失敗は 503 で、どちらも
`issueAdminCred`・未連携 early return・detach / upsert・`linkDemoEmail` / `linkSpecialEmail`・
Cookie 発行の**すべてより前**。admin API の競合は **`setConfig` に 1 度も到達しない**。

**変えていないもの**: Google × パスワードの 409 / 事前発行 uid の 409 / `issueAdminCred` の位置 /
本人解決の順序（実顧客 → staging → 体験アカウント）/ 体験アカウント内の Real → Demo の優先順 /
`demoFallbackEnabled` の Special 排他（PR-C で移す）/ `welltect_mode` Cookie（PR-C）/
**migration も app_config キーも 1 つも足していない**。

**既存 verify 3 本は弱めずに書き直した**（旧コードの名前をリテラルで固定していた箇所）:
`verify-special-accounts` ③ と 5' ・ `verify-demo-gate` ・ `verify-email-auth` S-06 / S-07。
あわせて `verify-email-auth` に **P-17 / P-18** を追加し、競合 409・照会失敗 503 で
**DB 書き込み 0 / Cookie 0 / admin credential 0** を実走で固定した。
**退行注入 12 種**とも名指しで落ちることを確認済み。

**未確認（本番で 1 回通すこと）**: Demo 登録済みの人を Real へ足して uid が写ること /
競合を人為的に作った回に 409 で何も書かないこと（この環境に Supabase も app_config も無い）。

### 4.2 表示モード（PR-C）

- Cookie `welltect_mode`（`real` / `demo`・HttpOnly・SameSite=Lax・本番 Secure）
- **Cookie は権限根拠にしない。** サーバで毎回資格を再検証して `effectiveMode` を決める
- `POST /api/session/view-mode`。**admin 代理表示・share・anonymous・Demo 資格なしは 403**
- Dual のログイン直後は **`real`**
- `welltect_v` の構造・署名・30 日・admin 判定・origin 判定は**変えない**

### 4.3 Demo データ読込の明示化（PR-C）

`demoFallbackEnabled()`（**本番コードに 19 call site**）を `shouldUseDemoData(uid, mode)` 等へ
**全件**置換し、`demo-data.ts` の**スペシャル排他 1 行を撤廃**する。
**一部だけ旧判定を残さない**（ページごとに Demo / Real が食い違う）。
置換後、旧い暗黙判定の再導入を grep ベースの verify で落とす。

### 4.4 書込み監査（PR-D）

`viewer.writeTargetUid` を使う **7 本**（`external-id` / `self-report` / `scan/save` /
`scan/jobs` / `scan/export` / `interview/export` / `notices/[id]/read`）を分類に従って塞ぐ。
裁定 4 のとおり、**AI問診・AIスキャンに擬似成功を足さない**。

### 4.5 管理画面（PR-E）

`/admin/experience-accounts`（**デモ／スペシャルアカウント**）1 人 1 行。
旧 2 画面は redirect、旧 API は canonical 解決層を通す（裁定 7）。

---

## 5. 本番 DB の申し送り（裁定 5）

PR-A は**既存行に一切触らない**。棚卸しと無効化の SQL 案は PR-A の完了報告に記載。
**実行は発注者判断。**
