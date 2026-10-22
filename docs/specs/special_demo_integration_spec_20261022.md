# Special / Demo 統合・表示モード切替・デモ検証 — 実装の正本

作成 2026-10-22 / 対象 `mirai-gpro/Scan-Chat-AI`・`mirai-gpro/wellfort-site`

発注者から受領した 2 文書（`Wellfort_Special_Demo_統合仕様書_v1.0_20261022.md` /
`ClaudeCode指示書_Special_Demo統合_20261022.md`）と、**Phase 0 報告に対する発注者裁定
（2026-10-22）**を 1 本にまとめたもの。**以後はこの文書が正本**で、2 文書の記述と
食い違う箇所は本書（＝裁定）が勝つ。

> **実装状況: PR-A（§3）〜 PR-E（§4.5）すべて実装済み。**
> 残っているのは**本番での通し確認**だけ（各節末の「未確認」）。
> **PR ごとに他の変更を混ぜない**（発注者指示 10）。

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

### 4.2 表示モード（PR-C・**2026-10-22 実装済み**）

- Cookie `welltect_mode`（`real` / `demo`・HttpOnly・SameSite=Lax・本番 Secure・30 日）
- **Cookie は権限根拠にしない。** サーバで毎回資格を再検証して `effectiveMode` を決める
- `POST /api/session/view-mode`。**admin 代理表示・share・anonymous・Demo 資格なしは 403**
- Dual のログイン直後は **`real`**
- `welltect_v` の構造・署名・30 日・admin 判定・origin 判定は**変えない**

#### 4.2.1 Cookie が無いときの既定（実装で確定）

裁定は Dual についてのものなので、**他の枠は PR-C 前の挙動を変えない**ことにした。

| 資格 | 既定 | 理由 |
|---|---|---|
| **Dual（両資格）** | **`real`** | 絶対条件。実データを持つ人にダミーを先に見せない |
| Demo の資格だけ | `demo` | **実データを 1 件も持たない枠**。`real` にすると**記者が空の画面に着く**（お披露目の導線が壊れる） |
| Real の資格だけ / 一般顧客 | `real` | 従来どおり |
| 未サインイン | `demo` | 資格が引けない。**ダミーの可否は `shouldUseDemoData` が「表示する uid」で判定する**ので一般顧客にダミーは出ない（本番はサインイン画面で止まる） |

**代理表示・共有・緊急入場は切り替え不可**（`switchable:false` = Cookie を見ない）だが、
**既定は表示対象の資格に従う** — スペシャル枠を代理表示・共有しているときは `real` で
ダミーが混ざらない。デモ専用アカウントを代理表示して `demo` になるのは PR-C 前と同じ。

#### 4.2.2 実装（PR-C）

| 置き場所 | 中身 |
|---|---|
| **新規** `src/lib/view-mode.ts`（leaf） | `MODE_COOKIE` / `parseMode` / `modeCookieOptions` / `resolveViewMode` / `shouldUseDemoData` / `viewModeFromRequest` |
| **新規** `src/pages/api/session/view-mode.ts` | Cookie を書く唯一の口。403 は `state.switchable` 1 本（条件を書き写さない） |
| **新規** `src/components/dashboard/ViewModeSwitch.astro` | `switchable` の人にだけ出る。既存の同格の淡色ペアだけを使う |
| 画面 7 本 | `viewModeFromRequest(Astro, viewer)` を 1 回通して `effectiveMode` を全部の問い合わせへ渡す |
| `api/debug/viewer.ts` | `mode`（effective / requested / switchable / can_demo / can_real / dual）を追加 |
| **新規** `scripts/verify-view-mode.mjs` | 147 件（CI の A 層） |

**モジュール変数にモードを置かない** — SSR は 1 つの isolate で同時リクエストを捌くので、
置くと**他人のモードが漏れる**。常に引数で渡す。

### 4.3 Demo データ読込の明示化（PR-C・**2026-10-22 実装済み**）

`demoFallbackEnabled()`（**本番コードに 20 call site**）を `shouldUseDemoData(uid, mode)` へ
**全件**置換し、**`demo-data.ts` から関数ごと撤去**した（資格だけで決める関数が残ると
モードを渡し忘れた経路で使われる）。あわせて**スペシャル排他 1 行も撤廃**し、
**排他ではなくモードで分ける**形へ移した（**別の場所へ移植していない**）。

- **`mode` は必須の引数**。9 関数（`loadDashboard` / `getHealthAge` /
  `getLatestMeasurements` / `getTrendCandidates` / `getMeasurementTrend` /
  `loadNotices` / `countUnreadImportant` / `loadResult`）＋ `ReportContext` に足し、
  **既定値を置かない** → 渡し忘れは `astro check` が落とす（§4.3「一部だけ旧判定を残さない」を型で担保）
- **Special 専用 UI** は `effectiveMode === 'real' && isSpecialAccount(uid)`
  （`dashboard.astro` の `singlePurchase` / `scan.astro` の `multiYear`）
- **PR-A の暫定ゲート**は `viewMode.effectiveMode === 'demo' && isDemoShipmentId(...)` へ。
  資格で見ていたので **Dual が Real を表示していても読取テスト扱い**だった
- **admin のバッチ・監査は Real 固定**（閲覧者の Cookie に左右されない）。
  ただし `elith-report/audit` だけ `'demo'` = **従来の挙動**（デモ用アカウントならサンプルを組む）
- **既存 verify 8 本は弱めずに書き直した**: `special-accounts` ①（排他 →「既定が Real」で
  同じ要件を担保）/ `demo-gate` / `experience-accounts` ⑧ / `single-purchase` /
  `external-id-capture` / `report-approval` / `report-model` / `url-uid-privacy` ＋ stub 3 本
- **退行注入 15 種**とも名指しで落ちる。**うち 1 件は注入して初めて検査の穴が見つかり直した**
  — `demoFallbackEnabled` の不在だけを見ていたので、**`isDemoAccount(uid)` の直呼びで
  旧判定が戻る**のを拾えていなかった（資格の関数の直呼びを落とす検査を追加）

**未確認（本番で 1 回通すこと）**: Dual のアカウントで ①ログイン直後が Real ②切り替えて
Demo のダミーが出る ③戻すと実データに戻る ④Demo 表示中に単品購入の枠・複数年の枠が出ない。

### 4.4 書込み監査（PR-D・**2026-10-22 実装済み**）

`viewer.writeTargetUid` を使う **7 本**（`external-id` / `self-report` / `scan/save` /
`scan/jobs` / `scan/export` / `interview/export` / `notices/[id]/read`）を分類に従って塞いだ。
裁定 4 のとおり、**AI問診・AIスキャンに擬似成功を足していない**。

#### 4.4.1 棚卸しで分かったこと

PR-A / PR-C で塞いだのは **2 本だけ**（`external-id` / `self-report`）で、
**残り 5 本はデモを表示している最中でもそのまま本番へ届いていた**。
デモの画面は `shouldUseDemoData()` が**ダミーを出す**ので、書いた行は**本人にも
見えない** = 誰にも見えない本物の行だけが増える。

**もう 1 つ fail-open が在った。** `external-id` / `self-report` は
`viewModeFromRequest()` を **`refreshConfig()` より前**で呼んでいた。
`isDemoAccount()` は app_config（`demo.account_uids`）を読むので、**冷えた isolate で
未取得のまま判定すると資格が無いと見えてゲートが開く**。組み込みの 4 件
（`BUILTIN_DEMO_UIDS`）は config 無しでも当たるので、**app_config で登録した
デモ用アカウントだけが黙って本番へ書く**という見つけにくい形だった。
→ 7 本とも **`refreshConfig()` → モード** の順に揃え、`verify:write-audit` が見張る。

#### 4.4.2 分類

| 口 | 分類 | 挙動 |
|---|---|---|
| `kit/[id]/external-id` | **A: Demo-safe no-op** | PR-A 済（順序だけ直した） |
| `kit/[id]/self-report` | **A** | PR-A 済（順序だけ直した） |
| `notices/[id]/read` | **A（PR-D で追加）** | デモのお知らせ → どこにも書かず `demo: true` |
| `scan/save` | **B: Demo では 403** | `test_artifacts` / `measurements` / `measurement_values` |
| `scan/jobs` | **B** | `scan_jobs`（cron ワーカーが後から本番として読む） |
| `scan/export` | **B** | Elith の source JSON を S3 へ |
| `interview/export` | **B** | Elith 納品 ＋ `interview_completions` |

- **A = デモの作り物に対する操作。** そのまま下へ流すと `Order not found` /
  `notice not found` になり、**押すとエラーになるボタン**が記者やパートナーの前に残る。
  どこにも書かず `demo: true` を返し、**画面が「記録されません」と出す**。
- **B = 本番のデータ・納品物を作る口。** `ok: true` を返さず **403
  `demo_mode_write_blocked`** で止める（裁定 4「AI問診・AIスキャンは今回 Demo 書込み
  対応しない」「擬似成功を足さない」）。実データで試す必要がある人には
  **Real（スペシャル）資格を付けて Real 表示で使ってもらう**。

#### 4.4.3 番人は 1 本

`denyDemoWrite(viewer, mode)`（`src/lib/write-guard.ts`）。判定は
**`shouldUseDemoData()`（PR-C の唯一の口）**を通し、資格の関数を直に呼ばない。

- **`viewer.uid`（表示中）と `writeTargetUid`（書く相手）の 2 つとも見る。**
  現行の `kind` では必ず一致するが、片方だけだと**将来 kind を足したときに静かに抜ける**
  （`isReadOnlyViewer` が 2 つとも見るのと同じ規律）。
- **一般顧客は Demo 表示でも止まらない**（資格が無いので `shouldUseDemoData` が false）。
  ゲートが広がると**利用者が保存できなくなるのに、デモで試している側には何も起きない**
  ので、ここは実走で見張る。
- **文言は 1 か所**（`write-guard.ts` の `message`）。符号だけを画面に出さないため、
  `scan.astro` の 2 か所と `notices.astro` が**サーバの `message` を優先**する。

#### 4.4.4 デモのお知らせ ID を UUID の形へ

既読 API は `/^[0-9a-f-]{36}$/i` で ID の形を見るので、`demo-un-0001` では
**押した瞬間に 400 `invalid notice id`** になり「更新に失敗しました: invalid notice id」が
出ていた（デモの出荷 ID を UUID 形へ直したのと同じ理由）。
`DEMO_NOTICE_IDS` を唯一の定義にし、`buildDemoNotices()` もそこから引く。
**API 側の形の検査は緩めない**（本番の `user_notices.id` を守るもの）。
**Demo fixture を足したのではなく、既にある 2 件の ID の形を直しただけ**（裁定 1）。

#### 4.4.5 変えていないもの

migration 0 本 ・ app_config キー 0 件 ・ Demo 専用 flag なし ・
`isDemoAccount` / `isSpecialAccount` / `shouldUseDemoData` の中身 ・
`resolveViewMode` の既定 ・ `welltect_mode` の扱い ・ 共有と代理表示の判定 ・
**AI問診・AIスキャンの画面の流れ**（擬似成功も進捗の作り物も足していない）

#### 4.4.6 検証

- 新規 `npm run verify:write-audit` **96 件**（CI の A 層）。番人は**実物を動かし**、
  `notices/[id]/read` と `scan/save` の POST を実走させて**書き込み関数の呼び出し
  回数を数える**（デモで 0 回・一般顧客で 1 回）
- `verify:view-mode` は 147 → **161 件**（書き込みの 5 本も LIVE に入れた）
- `verify:viewer-origin` が `write-guard.ts` の新しい実行時 import を繋ぐようになった
  （繋がないと `ERR_MODULE_NOT_FOUND` で**実行すらできない**。2026-10-02 と同じ形の
  事故なので同じやり方で閉じた）。**番人は実物のまま**
- **退行注入 20 種**とも名指しで落ちる。**うち 1 件は注入して初めて検査の穴が見つかり
  直した** — 「資格の関数を直に呼ぶ形に戻す」注入で `data:` URL から相対 import が
  解決できず**スクリプトごと落ち**、名指しの失敗が 1 件も出なかった（`load()` が
  差し替え漏れを検査の失敗として出してから止めるようにした）

#### 4.4.7 残っていること（発注者の判断待ち）

- **分類 B の入口は、まだ操作を誘う。** `/scan`・`/chat` は Demo 表示でも開けるので、
  デモの利用者は**スキャンし終えてから 403 を受け取る**（Gemini の呼び出しは
  その手前で走る）。裁定 4 が「Demo では使わない」と決めているので、
  **入口に「デモ表示では利用できません」を出すかは UI の判断**として残した。
  サーバ側は止まっているので実害は無い。
- **AI問診の完了画面は、止まったことを出さない。** `interview/export` の呼び出しは
  元から fire-and-forget で失敗を握りつぶすので、デモで完走すると画面は「完了」に
  見える（端末の控えだけが残り、本番には何も無い）。**AI問診の画面に手を入れるのは
  いちばん慎重にすべき領域**なので、文言を足すかは判断を仰ぐ。

### 4.5 管理画面（PR-E・**2026-10-22 実装済み**）

`/admin/experience-accounts`（**デモ／スペシャルアカウント**）1 人 1 行。
旧 2 画面は redirect、旧 API は canonical 解決層を通す（裁定 7）。

#### 4.5.1 なぜ 1 枚にしたか

名簿ごとに画面が 2 枚あると、**同じ人が 2 行に割れる**。PR-B で Dual が正常な
状態になったので、片方だけを見て操作すると**資格の付け外しが噛み合っているか
分からない**（片方だけ外して「外した」と思える）。

#### 4.5.2 読む口は新設・**書く口は増やさない**

| | 口 | 中身 |
|---|---|---|
| 読む | **新規** `GET /api/admin/experience-accounts` | 1 人 1 行の統合一覧（読み取り専用） |
| 書く | 既存 `/api/admin/special-accounts` | 登録・削除・除外・メール変更・Elith 納品 |
| 書く | 既存 `/api/admin/demo-accounts` | デモの登録・削除・除外 |

**POST を新設していない。** 既存 2 本はどちらも PR-B で
`canonicalUidForRegistration` を通るので、**uid を決める口はいまも 1 つだけ**。
ここに書き込みを足すと裁定 7 が禁じた「UID 分裂の経路」が 1 本増える。

実装 = `src/lib/experience-admin.ts`（`listExperienceAccounts()`）。
**メールの sha256 で束ね**、canonical uid は **Real(Special) を優先**
（`resolveCanonicalUidByEmail` と同じ順序なので、画面の uid とサインイン時に
採られる uid が食い違わない）。**畳めない uid 行は捨てずに出す**（捨てると
資格を持つ人が一覧から消える）。**PII は返さない**（メールの現物・生年月日の
実値・生テキストのいずれも）。

#### 4.5.3 画面の約束

- **資格の列は「登録済み」ではなく資格**（`canReal` / `canDemo`）。
  uid 未発行・除外中は「資格なし」＋理由を出す
- **競合（uid 食い違い）は「⚠ uid 食い違い」**と出し、**画面では直さない**。
  両方の uid を `title` に出して開発側へ連絡させる
- **デモの付け外しは行ごと**。**足す**にはメールの現物が要る（上流はハッシュと
  マスクしか持たない）ので再入力してもらい、**送る前にブラウザで SHA-256 を
  計算して行の hash と突き合わせる**。一致しなければ 1 バイトも送らない —
  別人のアドレスで登録すると**その別人にダミーが出て、この行は何も変わらない**
- **Dual 登録は スペシャル → デモ の順**。スペシャル側が uid を発行し、
  デモ側は上流で**それを写す**（デモ側は採番しない）
- **uid 行の操作は名簿ごとに分ける**（`data-side`）。側を無視すると
  **デモの行がスペシャル側の除外リストへ書かれて「外したのに効かない」**
- **全停止（`PUBLIC_DEMO_FALLBACK=false`）は資格と別に出す**。資格は残るのに
  誰にもダミーが出ない状態があり得るので、混ぜると理由が追えない

#### 4.5.4 直した誤り 2 件

- **旧 UI の説明が PR-C と矛盾していた**。「同じ人を両方に登録しないで」
  「スペシャル側を優先してダミーを抑止する」という趣旨だったが、**その排他は
  PR-C で撤廃**した。検査がこの言い回しの復活を grep で見張る
- **詳細行の `colspan` が 1 つ足りなかった**（固定 7 列を 6 列として数えていた）。
  **PR-E より前からのずれ**で、新しい検査がヘッダのセル数と突き合わせて検出した

#### 4.5.5 検証

- 新規 `npm run verify:experience-admin` **55 件**（Scan・CI の A 層）
- `npm run verify:experience-accounts-ui` **166 件**（wellfort・117 → +49・
  regression-guard に追加）。画面の inline script を切り出して**実際に描かせる**
- `verify:admin-target` / `verify:admin-onclick` は**読む先を新 URL へ直した**
  （直さないと空の redirect を検査して全部落ちる）。**検査を弱めていない**
- **退行注入 30 種**（Scan 15 ＋ wellfort 15）とも名指しで落ちる。
  **うち 2 件は注入して初めて検査の穴が見つかり直した** — ①競合の行の鍵を
  普通の行より前に置いていたので**並び替えを外しても偶然先頭に来て通った**
  ②認可の位置を `indexOf` で見ていたが **import 行に当たって常に通っていた**

**未確認（本番で 1 回通すこと）**: 統合画面での 登録（Real / Dual）・デモの
付け外し・uid 行の名簿別の操作・旧 2 URL からの redirect。この環境に Supabase も
鍵も無いので、admin 認証を通した実操作は未確認（画面の 200 / redirect の 302 /
中継の 401 は dev で実測）。

---

## 5. 本番 DB の申し送り（裁定 5）

PR-A は**既存行に一切触らない**。棚卸しと無効化の SQL 案は PR-A の完了報告に記載。
**実行は発注者判断。**
