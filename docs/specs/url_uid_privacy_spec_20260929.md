# 一般ユーザー URL からの diagnostic_user_id 除去 — 改修仕様書

| | |
|---|---|
| 文書 ID | `url_uid_privacy_spec_20260929` |
| 作成日 | 2026-09-29 |
| 調査基準 | `708dd53`（branch `claude/cool-dirac-1dkyx7`） |
| 状態 | **仕様書のみ。実装は未着手** |

> **この文書は `docs/specs/_TEMPLATE.md`（`WF-NNNN` 形式の Implementation Spec）ではない。**
> `scripts/spec-guard.mjs:52` は `docs/specs/WF-\d{4}\.md` のみを検証対象とし、CI には接続されていない
> （`.github/workflows/*.yml` に `spec-guard` の記述なし）ので、本ファイルの存在は既存の検証を壊さない。
> 実装フェーズに入るときは、本書を根拠に別途 `WF-NNNN.md` を起こすこと。

---

## 1. 目的

一般ユーザー向け画面の URL から `diagnostic_user_id` を消す。

医療・健康情報を扱うサービスとして、本人の識別は**既存の署名付き HttpOnly Cookie と
`resolveViewer()` が返す `viewer.uid` を唯一の正**とし、URL には識別子を載せない。

**ハッシュ化・暗号化・別 ID への置換は行わない。** URL 自体にユーザー識別子を持たせない。

---

## 2. 現行仕様

### 2.1 入場と本人解決（本線・変更しない）

`src/lib/viewer.ts` が本人を解決する。優先順位は同 `:237-240` のコメントどおり。

1. **Cookie（署名検証済み）= 本人**（`:246`）
2. 本人が admin なら `?u=` を尊重（代理表示・`:271-273`）
3. `ALLOW_UID_ENTRY=on` のときだけ `?u=` を本人として扱う（緊急用・`:249-257`）

Cookie は `uid.exp.admin[.s].HMAC`（`signViewer` `:88-109`）。`HttpOnly` / `SameSite=Lax` /
本番は `Secure`（`viewerCookieOptions` `:179-190`）。発行は `POST /api/auth/resolve`。

`?u=` を読むのは **`viewer.ts:244` の 1 か所だけ**（他は `admin/index.astro:9` と
`admin/lab-results/upload.astro:10` で、いずれも admin 画面）。

### 2.2 `resolveViewer()` が返す値

`Viewer`（`viewer.ts:192-230`）の主要フィールド。

| フィールド | 意味 | 一般ユーザー | Admin 代理表示 | 緊急 `?u=` 入場 |
|---|---|---|---|---|
| `uid` | 表示対象 | 本人 | **対象者** | 指定 uid |
| `selfUid` | サインイン本人 | 本人 | **閲覧者本人** | 指定 uid |
| `isAdmin` | 本人が admin か | false | true | **false**（`:256`） |
| `impersonating` | 代理表示中か | false | **true** | **false**（`:256`） |

`impersonating` が true になるのは `isAdmin && requested && requested !== selfUid` の
ときだけ（`:271`）。**admin が自分の uid を `?u=` に付けた場合も false になる。**

### 2.3 一般ユーザー向けページは全て `resolveViewer()` を通っている

`resolveViewer` の呼び出し元（実測）:

- ページ: `dashboard` / `report` / `trend` / `kit` / `scan` / `chat` / `coach` / `notices` /
  `result/[id]`
- API: `api/scan/save.ts` / `api/scan/jobs.ts` / `api/interview/export.ts` / `api/debug/viewer.ts`
- その他: `components/GoogleOneTap.astro` / `admin/index.astro` / `admin/lab-results/upload.astro`

**つまり、どのユーザー向けページも `?u=` なしで本人を解決できる。**
各ページは `const u = viewer.uid`（`dashboard.astro:47` 他）としており、
**`?u=` はデータ取得には使われていない**。使われているのは**リンクの組み立てだけ**。

### 2.4 URL へ UID が載る経路（全件）

#### (a) 起点 — サインイン直後のリダイレクト

**`src/components/GoogleOneTap.astro:202-204`**

```js
url.searchParams.set('u', payload.diagnosticUserId);
window.location.replace(url.toString());
```

**これが一般ユーザーの URL に UID が出る唯一の起点。** サインインに成功すると、
現在の URL に `?u=<uid>` を足して必ずリダイレクトする。

#### (b) 伝播 — `q` による引き回し

| # | ファイル:行 | 内容 |
|---|---|---|
| 1 | `src/pages/index.astro:12` | `/dashboard${url.search}` — `?u=` をそのまま転送 |
| 2 | `src/pages/dashboard.astro:236` | `const q = u ? '?u=…' : ''`（`u = viewer.uid`・`:47`） |
| 3 | `src/components/AppNav.astro:42` | `const q = u ? '?u=…' : ''` → `:44-50` の 7 リンク＋`:71` お知らせ |
| 4 | `src/components/BackToDashboard.astro:28` | `/dashboard?u=…` |
| 5 | `src/components/dashboard/HealthAgeCard.astro:39` | `/trend…type=wellness` |
| 6 | `src/components/dashboard/TestResultsSection.astro:128,139` | `/result/{id}${q}` / `/trend…type=` |
| 7 | `src/components/dashboard/ProgressSection.astro:91,104` | `/chat${q}` / `/scan${q}` |
| 8 | `src/pages/report.astro:196-202` | `q()` ヘルパ（`if (u) p.set('u', u)`）→ `:624,628` |
| 9 | `src/pages/result/[id].astro:32-37, 53-59, 225` | `linkFor` / `siblingHref` / `/report?u=` |
| 10 | `src/scripts/chat/live-controller.ts:1489` | 問診完了後の `/dashboard?u=…`（クライアント側） |

`dashboard.astro` の `q` の消費先（`:280,325,326,329,352,353,363,381,391,438`）:
`AppNav` / `HealthAgeCard` / `ReportLinkCard`(`/report`) / `/kit` / `ProgressSection` /
`TestResultsSection` / `/scan` / `/chat` / `/chat…&trace=1`。

各ページの `BackToDashboard u={…}`: `trend.astro:98` / `kit.astro:108,117` /
`scan.astro:65` / `chat.astro:27` / `coach.astro:55` / `notices.astro:67` /
`report.astro:259` / `result/[id].astro:72,80`。
`AppNav u={u}`: `dashboard.astro:280` / `report.astro:253` / `trend.astro:95` / `kit.astro:114`。

#### (c) 死んでいる経路（現状ページから参照されない）

- `src/components/dashboard/HealthInsightCard.astro:89` — `/chat?u=…`。
  呼び出しは `dashboard.astro:407` で**コメントアウト**されている
- `src/components/dashboard/TestHistoryList.astro:11,34` — **未参照**
- `src/components/dashboard/HealthCoachPreview.astro:28` — **未参照**

#### (d) Admin 側の入口（本改修の対象外・維持する）

- wellfort-site `src/pages/admin/customers.astro:438` — `{SCAN_APP_BASE}/dashboard?u=<duid>`
- wellfort-site `src/pages/admin/health-age.astro:261` — 同形
- Scan-Chat-AI `src/pages/admin/index.astro:9,17` / `admin/lab-results/upload.astro:10`

---

## 3. 問題点

1. **一般ユーザーの URL に本人の `diagnostic_user_id` が常時露出する。**
   ブラウザのアドレスバー・履歴・ブックマーク・`Referer`・スクリーンショット・
   画面共有・サポート問い合わせのコピペに残る。
2. `diagnostic_user_id` は PII を含まない設計（`CLAUDE.md`「PII / データ分離」）だが、
   **Elith 納品の S3 パスや `measurement_values` の主キーであり、他人の識別子を知る手段を
   増やす**こと自体が望ましくない。
3. **`ALLOW_UID_ENTRY=on` に切り替わった瞬間、URL の UID がそのまま入場キーになる**
   （`viewer.ts:249-257`）。緊急用の env だが、URL に UID が載っていなければ
   「拾った URL でそのまま入れる」経路は成立しない。
4. `?u=` は非 admin では無視されるので**他人のデータは見えない**（`viewer.ts:271`）。
   よって本件は**アクセス制御の欠陥ではなく、識別子の露出**という位置づけ。

---

## 4. 改修方針

**`q`（リンクに付けるクエリ）の作り方を 1 か所に集約し、代理表示のときだけ `?u=` を出す。**

```
一般ユーザー本人        → q = ''
Admin 代理表示中        → q = '?u=<対象uid>'
緊急 ?u= 入場中         → q = '?u=<uid>'   ← §13
```

### 4.1 判定に使う値

`viewer.impersonating`（`viewer.ts:209,271-273`）が**そのまま使える**。
一般ユーザーでは常に false、admin 代理表示でだけ true。

ただし**緊急 `?u=` 入場（`ALLOW_UID_ENTRY=on`）では `impersonating` が false になる**
（`viewer.ts:256`）ため、`impersonating` だけを条件にすると次の遷移で UID を失い、
**既存の緊急復旧仕様が壊れる**。→ §13 の追加フィールドで解決する。

### 4.2 リンククエリの生成を 1 か所にする

`src/lib/viewer.ts` に**導出専用のヘルパ**を追加する（認証本線には手を入れない）。

```ts
/** リンクに引き継ぐクエリ。一般ユーザーは ''、代理表示/緊急入場のみ '?u=<uid>'。 */
export function viewerLinkQuery(v: Viewer): string
```

あるいは `Viewer` に `linkQuery: string` を持たせる。**どちらにするかは §20 の未確定事項。**

各ページ・コンポーネントは `viewer.uid` から `q` を組むのをやめ、この 1 本を使う。

### 4.3 サインイン直後のリダイレクトから `?u=` を外す

`GoogleOneTap.astro:202` の `url.searchParams.set('u', …)` を削除する。
Cookie は同 `:183-187` の `POST /api/auth/resolve` で既に発行されているので、
**`?u=` なしでリダイレクトすれば次のリクエストで Cookie から本人が解決される。**

**「`?u=` を消すだけ」にせず、リダイレクト自体は残す** — `:176-177` で
`/` を `/dashboard` に差し替えており、サインイン後の画面遷移に必要。

### 4.4 UID を含む URL で来た一般ユーザーの扱い

既存のブックマーク（`?u=<自分の uid>` 付き）で来る人がいる。

- **データは Cookie で解決される**ので表示は正しい（`viewer.ts:271` は
  `requested === selfUid` のとき `impersonating=false` を返す）
- **その画面のリンクからは `?u=` が消える**（`q=''`）ので、1 回遷移すれば URL は綺麗になる
- **URL からの能動的な除去（`Astro.redirect` で `?u=` を落とす）を行うかは §20 の未確定事項**

---

## 5. 対象範囲

### 5.1 一般ユーザー向けページ

`/dashboard` `/report` `/trend` `/kit` `/scan` `/chat` `/coach` `/notices` `/result/[id]` `/`

### 5.2 行うこと

1. `viewer.ts` に**リンククエリの導出ヘルパを追加**（既存の解決ロジックは変更しない）
2. `GoogleOneTap.astro` のリダイレクトから `?u=` を外す
3. `q` を組んでいる全箇所（§2.4(b) の 10 件）をヘルパ経由に置き換える
4. `BackToDashboard` / `AppNav` の `u` prop を**クエリ文字列を受け取る形**に整理するか、
   `u` に「代理表示中だけ値が入る」意味を与えるかを統一する（§20）
5. `index.astro` の `url.search` 転送を、`?u=` だけ落とすか維持するかを決める（§20）
6. 一般ユーザー向けページに `Cache-Control: no-store` を付ける（§14）
7. 回帰検査 `verify:url-uid-privacy`（仮）を追加（§19）

---

## 6. 対象外

1. **Admin 代理表示の `?u=` 廃止**（→ §21 将来対応）
2. **wellfort-site の変更**（`admin/customers.astro` / `admin/health-age.astro` の
   リンク形式は維持）
3. **Scan-Chat-AI の admin 画面**（`admin/index.astro` / `admin/lab-results/upload.astro` ほか）
4. **Google 認証 / Cookie 発行 / admin 判定の本線**（`api/auth/resolve.ts` /
   `signViewer` / `verifyViewer` / `isAdminEmailAsync`）
5. **DB schema**（変更不要）
6. **`ALLOW_UID_ENTRY` の既存挙動**（維持。§13）
7. **UID のハッシュ化・暗号化・別 ID 発行**（本改修では行わない）
8. **`api/live-token.ts:26-28` / `api/insight.ts:30` が body の `diagnosticUserId` を
   検証せず受け取る問題**（別課題。§15.4 / §18.6 に記録）
9. **未参照コンポーネント**（`TestHistoryList` / `HealthCoachPreview` /
   `HealthInsightCard`）— 参照が復活したときに漏れないよう §19 の検査でだけ見張る

---

## 7. 現行認証との関係

**本改修は認証を一切変更しない。** 依存するのは以下の既存の性質だけ。

| 依存する性質 | 根拠 |
|---|---|
| Cookie だけで本人が解決できる | `viewer.ts:246,260,274` |
| `?u=` はデータ取得に使われていない（リンク組み立てのみ） | §2.3 |
| `?u=` は非 admin では無視される | `viewer.ts:271` |
| 代理表示は `impersonating` で判別できる | `viewer.ts:209,271-273` |
| Cookie はサインイン時に発行済み | `GoogleOneTap.astro:183-187` |

**署名鍵が無い環境（`secret()` が null・`viewer.ts:52-54`）では Cookie を発行も検証もしない**
= サインインできない。この fail-closed は変更しない。

---

## 8. self / admin impersonation の扱い

| 状態 | `uid` | `selfUid` | `isAdmin` | `impersonating` | リンククエリ |
|---|---|---|---|---|---|
| 未サインイン | null | null | false | false | `''` |
| 一般ユーザー本人 | 本人 | 本人 | false | false | **`''`** |
| Admin 本人の画面 | 本人 | 本人 | true | false | **`''`** |
| Admin 代理表示 | **対象者** | 閲覧者 | true | **true** | **`?u=<対象者>`** |
| Admin が自分を `?u=` 指定 | 本人 | 本人 | true | **false** | **`''`**（`?u=` が消える） |
| 緊急 `?u=` 入場 | 指定 uid | 同じ | false | false | **`?u=<uid>`**（§13） |

**「Admin が自分を `?u=` 指定」で `?u=` が消えるのは意図した挙動**
（本人表示なので URL に識別子を残す理由がない）。

---

## 9. URL 変更前後

### 9.1 一般ユーザー

| 画面 | 現行 | 改修後 |
|---|---|---|
| サインイン直後 | `/dashboard?u=5d11742f-f196-450c-800b-d9ffa89ba64b` | **`/dashboard`** |
| 報告書 | `/report?u=5d11742f-…` | **`/report`** |
| 推移グラフ | `/trend?u=5d11742f-…&type=wellness` | **`/trend?type=wellness`** |
| 検査結果 | `/result/9b6bafd0-…?u=5d11742f-…&mode=full` | **`/result/9b6bafd0-…?mode=full`** |
| 印刷ビュー | `/report?u=5d11742f-…&print=1` | **`/report?print=1`** |
| キット | `/kit?u=5d11742f-…` | **`/kit`** |
| スキャン | `/scan?u=5d11742f-…` | **`/scan`** |
| 問診 | `/chat?u=5d11742f-…` | **`/chat`** |

### 9.2 Admin 代理表示（変更なし）

| 画面 | 現行＝改修後 |
|---|---|
| 入口（wellfort-site から） | `/dashboard?u=<対象uid>` |
| 報告書へ遷移 | `/report?u=<対象uid>` |
| 推移グラフへ遷移 | `/trend?u=<対象uid>&type=wellness` |

---

## 10. ページ間遷移ルール

1. **リンクの `href` に付けるクエリは `viewerLinkQuery(viewer)` の結果だけ**を使う。
   各ページ・各コンポーネントで `viewer.uid` から組み立てない。
2. 既存の `?u=` 以外のクエリ（`type` / `mode` / `print` / `save` / `preview` / `trace` /
   `debug` / `render`）は**現行どおり保持**する。
3. クエリの連結は `q ? `${q}&` : '?'` の既存パターンを踏襲する
   （`HealthAgeCard.astro:39` / `TestResultsSection.astro:139` / `dashboard.astro:438`）。
   **`q` が空でも `?` が二重にならないこと**を検査で固定する。
4. `BackToDashboard` / `AppNav` は**クエリ文字列そのもの**を受け取る形に揃える
   （現行は uid を受け取って内部で組み立てている）。**prop 名は §20 の未確定事項。**
5. クライアント側の遷移（`live-controller.ts:1489`）も同じクエリを使う。
   サーバからクエリ文字列を渡す（uid を渡さない）。

---

## 11. UID を URL へ出さない範囲

**出さない**

- 一般ユーザー向けページの `href` / `action` / `Location`（リダイレクト先）
- サインイン直後のリダイレクト先
- `history.pushState` / `replaceState`（現状 UID を載せる箇所なし。将来も載せない）

**従来どおり出る／出てよい**

- Admin 代理表示中のリンク（`?u=<対象uid>`）
- Admin 画面（`/admin/**`）
- 緊急 `?u=` 入場中のリンク（§13）

**URL 以外は対象外**

- サーバがページへ埋め込む uid（`data-diagnostic-user-id` 等・`kit.astro:224`）は
  **URL ではないので本改修の対象外**。ただし §21 で扱う。
- API のリクエストボディ（`api/live-token.ts` / `api/insight.ts`）も対象外（§6-8）。

---

## 12. Admin 代理表示の後方互換

1. **wellfort-site 側は 1 行も変更しない。**
   `/dashboard?u=<duid>` で従来どおり代理表示に入れること。
2. `viewer.ts:244` の `?u=` 読み取りと `:271-273` の代理表示判定は**変更しない**。
3. 代理表示中は `report` / `trend` / `kit` / `scan` / `chat` / `coach` / `notices` /
   `result/[id]` へ遷移しても**対象 uid を維持**する。
4. `normalizeUid`（`viewer.ts:278-284`）が受ける**先頭 8 桁の短縮形**も従来どおり動くこと。
5. 代理表示から**本人の画面へ戻る導線は本改修では追加しない**（現状も無い。
   admin は `?u=` を外して開き直す）。

---

## 13. `ALLOW_UID_ENTRY` との関係

**既存仕様（`viewer.ts:39-41, 249-257`）を変更しない。**

ただし §4.1 のとおり、緊急入場では `impersonating` が false になるため、
`impersonating` だけでリンククエリを決めると**遷移した瞬間に UID を失って締め出される**。
緊急復旧の目的（ローンチ直前の切替で締め出された場合の復旧）が果たせなくなる。

**対処：`Viewer` に「この閲覧者は `?u=` で入場したか」を表す派生フィールドを追加する。**

```ts
/** `ALLOW_UID_ENTRY=on` で `?u=` から入場した状態か。リンククエリの維持にだけ使う。 */
uidEntry: boolean;
```

- `resolveViewer` の `:256`（緊急入場の return）でのみ true
- リンククエリの条件は **`impersonating || uidEntry`**
- **入場判定・admin 判定には一切使わない**（表示リンクの組み立て専用）
- これは既存 3 経路の**追加情報**であって、`ALLOW_UID_ENTRY` の挙動そのものは不変

**`ALLOW_UID_ENTRY=on` のときは UID が URL に載り続ける。** これは緊急時の意図した挙動で、
本番は既定 off（`viewer.ts:19`「本番では off のままにすること」）。

---

## 14. キャッシュ / no-store

**現状、`Cache-Control` を設定している箇所は 0 件**（`src/pages/**.astro` /
`src/middleware*` に該当なし。`astro.config.mjs` / `vercel.json` にも `headers` 指定なし）。
Astro の SSR 既定に委ねている。

**本改修で行うこと**

1. 一般ユーザー向けページに **`Cache-Control: no-store`** を付ける。
   URL から識別子が消えることで**キャッシュキーが全ユーザー共通になる**ため、
   共有キャッシュに他人の画面が残るリスクが上がる。**この改修と同時に入れる必要がある。**
2. 実装箇所は `src/middleware.ts` の新設（現状 middleware なし）か、
   各ページでの `Astro.response.headers.set(...)` か。**§20 の未確定事項。**
3. `?print=1` / `?render=` も同様に `no-store`。
4. **Cookie は既に `HttpOnly` なので、キャッシュに Cookie は載らない。**

---

## 15. セキュリティ要件

1. **非 admin が `?u=<他人UID>` を指定しても他人に切り替わらないこと**（現行 `viewer.ts:271`）。
   **本改修で条件を緩めない。**
2. **`?u=` の読み取りは `viewer.ts:244` の 1 か所のまま**。他のページ・コンポーネントで
   `searchParams.get('u')` を増やさない。
3. **リンククエリの生成は 1 か所**（§4.2）。個別ページで `?u=` を組み立てない
   = 「1 か所直し忘れて UID が漏れる」を構造的に防ぐ。
4. **本改修では手を付けないが記録しておく問題**:
   `api/live-token.ts:26-28` と `api/insight.ts:30` は、**リクエストボディの
   `diagnosticUserId` を検証せずにそのまま使っている**（`resolveViewer` を通していない）。
   UID を知っていれば他人の検査文脈を Live プロンプトへ載せられる可能性がある。
   **URL から UID が消えることで入手経路は減るが、穴自体は残る。別課題として起票すること。**
5. `Referer` 経由の漏出が減る（外部リンクを踏んだときに UID が渡らなくなる）。
6. **UID をハッシュ化して URL に残すことはしない**（要件 H）。ハッシュでも
   「同一人物を追跡できる安定識別子」である以上、露出を残す意味がない。

---

## 16. 実装対象候補ファイル

### 16.1 Scan-Chat-AI（変更が見込まれるもの）

| ファイル | 変更内容 |
|---|---|
| `src/lib/viewer.ts` | `viewerLinkQuery()` 追加 ＋ `Viewer.uidEntry` 追加（§13）。**解決ロジックは不変** |
| `src/components/GoogleOneTap.astro` | `:202` の `searchParams.set('u', …)` を削除 |
| `src/pages/dashboard.astro` | `:236` の `q` をヘルパ経由に |
| `src/pages/report.astro` | `:196-202` の `q()` をヘルパ経由に |
| `src/pages/trend.astro` | `AppNav` / `BackToDashboard` への引き渡し |
| `src/pages/kit.astro` | 同上 |
| `src/pages/scan.astro` | 同上 |
| `src/pages/chat.astro` | 同上 ＋ `live-controller` へ渡すクエリ |
| `src/pages/coach.astro` | 同上 |
| `src/pages/notices.astro` | 同上 |
| `src/pages/result/[id].astro` | `:32-37` `linkFor` / `:53-59` `siblingHref` / `:225` |
| `src/pages/index.astro` | `:12` の `url.search` 転送の扱い（§20） |
| `src/components/AppNav.astro` | `:42` の `q` 生成を prop 受け取りへ |
| `src/components/BackToDashboard.astro` | `:28` 同上 |
| `src/components/dashboard/HealthAgeCard.astro` | `:39` |
| `src/components/dashboard/TestResultsSection.astro` | `:128,139` |
| `src/components/dashboard/ProgressSection.astro` | `:91,104` |
| `src/scripts/chat/live-controller.ts` | `:1489` の `/dashboard?u=` |
| `src/middleware.ts`（新設） | `Cache-Control: no-store`（§14・方式は §20） |
| `scripts/verify-url-uid-privacy.mjs`（新設） | §19 の回帰検査 |
| `package.json` / `.github/workflows/ci.yml` | 検査の登録（CI の A 層） |

### 16.2 参照が復活したときに漏れる候補（今回は変更しないが検査で見張る）

- `src/components/dashboard/HealthInsightCard.astro:89`（`dashboard.astro:407` でコメントアウト）
- `src/components/dashboard/TestHistoryList.astro:11,34`（未参照）
- `src/components/dashboard/HealthCoachPreview.astro:28`（未参照）

---

## 17. 非対象ファイル

**変更してはならない。**

```
src/pages/api/auth/resolve.ts
src/pages/api/auth/refresh-admin.ts
src/lib/admin-auth.ts
src/lib/hp-edge.ts
src/lib/demo-accounts.ts
src/lib/special-accounts.ts
src/pages/admin/**
supabase/migrations/**
CLAUDE.md
（wellfort-site 全体）
```

`viewer.ts` は §16.1 のとおり**追加のみ**。`signViewer` / `verifyViewer` /
`viewerCookieOptions` / `resolveViewer` の既存分岐と `normalizeUid` は変更しない。

---

## 18. 回帰リスク

| # | リスク | 内容 | 対策 |
|---|---|---|---|
| 1 | **Admin 代理表示の連鎖が切れる** | `q` を一律 `''` にすると、代理表示で `/report` へ移った瞬間に admin 本人の画面になる | §8 の表を検査で固定（`verify` で `impersonating=true` のとき全リンクに `?u=` が付くこと） |
| 2 | **緊急 `?u=` 入場が使えなくなる** | `impersonating=false` のため（§13） | `uidEntry` フィールドを追加し `impersonating \|\| uidEntry` にする |
| 3 | **クエリ連結の `?` 二重化** | `q ? `${q}&` : '?'` のパターンで `q=''` の経路が今まで通っていない | `/trend?type=…` `/report?print=1` を実ブラウザで確認 |
| 4 | **サインイン直後に真っ白** | `?u=` を外した結果、Cookie が未発行のままリダイレクトすると未サインイン扱いになる | `/api/auth/resolve` の成功後にのみリダイレクトする現行順序（`:183-204`）を維持 |
| 5 | **既存ブックマーク（`?u=` 付き）** | 表示は Cookie で正しく解決される（§4.4）が、`?u=` が残ったままの画面が存在する | 遷移 1 回で消える。能動的除去は §20 |
| 6 | **body の uid を信じる API** | `api/live-token.ts` / `api/insight.ts`（§15.4）。本改修では変わらない | 別課題として起票 |
| 7 | **デモ / スペシャルアカウントの判定** | `demo-accounts.ts` / `special-accounts.ts` は `viewer.uid` を受け取る。URL とは無関係 | `verify:demo-gate` / `verify:special-accounts` を回帰で流す |
| 8 | **`/api/debug/viewer` の切り分け** | `?u=` が付いていないかの確認手順が変わる | 切り分け手順を docs へ追記 |
| 9 | **`report.astro` の `?render=` 経路** | 開発時のローカルレンダリング（`report-local-render.ts`）。`u` と無関係だが `q()` を共有 | `verify:report-render` を回帰で流す |

---

## 19. テスト項目

### 19.1 新設する自動検査 `npm run verify:url-uid-privacy`

**静かに壊れる種類の不具合**（UID が 1 か所だけ残る／代理表示が切れる）なので、
目視ではなく機械で固定する。

| ID | 検査 |
|---|---|
| T-01 | 一般ユーザー（Cookie のみ・非 admin）で `/dashboard` を開き、**HTML 内の全 `href` に `u=` が現れない** |
| T-02 | 同じく `/report` `/trend` `/kit` `/scan` `/chat` `/coach` `/notices` `/result/{id}` |
| T-03 | **レスポンスの `Location` ヘッダにも `u=` が無い**（`/` → `/dashboard`） |
| T-04 | サインイン直後のリダイレクト先に `u=` が無い（`GoogleOneTap` のソース検査で `searchParams.set('u'` が無いこと） |
| T-05 | admin 代理表示（`?u=<他人>`）で `/dashboard` を開くと、**全ての内部リンクに `?u=<他人>` が付く** |
| T-06 | 代理表示で `/report` `/trend` `/kit` へ遷移しても対象 uid が維持される |
| T-07 | 非 admin が `?u=<他人UID>` を付けても、表示されるのは**本人のデータ**（`/api/debug/viewer` の `uid` が本人） |
| T-08 | `ALLOW_UID_ENTRY=on` ＋ Cookie なし ＋ `?u=<uid>` で、**リンクに `?u=` が維持される** |
| T-09 | `/trend?type=wellness` `/report?print=1` `/result/{id}?mode=full` が **`?` 二重化なしで生成**される |
| T-10 | ソース検査：`src/pages/**` `src/components/**` `src/scripts/**` に **`?u=${` / `set('u'` の直書きが無い**（`viewer.ts` と `admin/**` を除く） |
| T-11 | ソース検査：`searchParams.get('u')` は `viewer.ts` と `admin/**` にしか無い |
| T-12 | 一般ユーザー向けページの応答に **`Cache-Control: no-store`** が付く |

### 19.2 退行注入（検査が本当に落ちるかの確認）

1. `GoogleOneTap.astro` の `searchParams.set('u', …)` を戻す → **T-04 が落ちる**
2. リンククエリを `viewer.uid` から組む実装に戻す → **T-01/T-02 が落ちる**
3. 条件を `impersonating` だけにする → **T-08 が落ちる**
4. 条件を「常に `?u=`」にする → **T-01 が落ちる**
5. `no-store` を外す → **T-12 が落ちる**
6. `q ? `${q}&` : '?'` を `${q}&` 固定にする → **T-09 が落ちる**

### 19.3 既存検査の回帰（全て緑のままであること）

`verify:demo-gate` / `verify:special-accounts` / `verify:single-purchase` /
`verify:viewer-origin` / `verify:screen` / `verify:report` / `verify:report-render` /
`verify:scan-pages` / `verify:scan-async` / `npm run check` / `astro build`

### 19.4 手動確認

1. 本番相当の Google 認証でサインイン → **アドレスバーに UID が出ないこと**
2. wellfort-site の admin 顧客管理から代理表示 → **従来どおり対象者の画面が出ること**
3. 代理表示中にメニューから各画面へ移動 → **対象者のまま**であること
4. ブラウザの履歴に UID を含む URL が増えないこと

---

## 20. 受入条件

| ID | 条件 | 対応するテスト |
|---|---|---|
| A | 一般ユーザーが `/dashboard` `/report` `/trend` 等を **UID なしで正常利用できる** | T-01, T-02, 19.4-1 |
| B | 一般ユーザー画面内の**リンクにも UID が出ない** | T-01, T-02, T-03, T-10 |
| C | 一般ユーザーが手入力で `?u=<他人UID>` を付けても**他人へ切り替わらない** | T-07 |
| D | Admin は従来どおり `/dashboard?u=<対象UID>` で**代理表示できる** | T-05, 19.4-2 |
| E | Admin 代理表示中は `report` / `trend` / `kit` 等へ移動しても**対象 UID を維持** | T-06, 19.4-3 |
| F | **Google 認証・Cookie 発行・Admin 判定を壊さない** | T-04, 19.3, 19.4-1,2 |
| G | **DB schema 変更が無い** | `git diff --stat` に `supabase/migrations/` を含まない |
| H | **UID のハッシュ化・暗号化・別 ID 置換を行わない** | T-10, T-11（URL に識別子を載せる実装が無いこと） |
| I | `ALLOW_UID_ENTRY=on` の**既存挙動が維持される** | T-08 |
| J | 一般ユーザー向けページが **`no-store`** を返す | T-12 |

**未確定事項（実装前に決めること）**

1. **リンククエリの持たせ方** — `viewerLinkQuery(viewer)` 関数か、`Viewer.linkQuery` フィールドか。
   後者は全ページで `viewer` を渡すだけで済むが `Viewer` の意味が「解決結果」から
   「表示用の値も持つ器」に広がる。
2. **`BackToDashboard` / `AppNav` の prop** — 現行の `u`（uid）を残して意味を変えるか、
   `q`（クエリ文字列）に改名するか。改名すると呼び出し元 10 ファイルに波及する。
3. **`index.astro:12` の `url.search` 転送** — `?u=` だけ落とすか、現行どおり全部通すか。
   落とすと admin が `/?u=<対象>` で入る経路が切れる（現状その導線は wellfort-site に無い）。
4. **既存ブックマーク（`?u=` 付き）を能動的に除去するか** — `Astro.redirect` で
   `?u=` を落とすと URL は綺麗になるが、**代理表示と区別する条件が必要**で、
   リダイレクトループの危険がある。「遷移 1 回で自然に消える」で足りるかの判断。
5. **`no-store` の実装箇所** — `src/middleware.ts` 新設（全ページに一律・admin も含む）か、
   各ページで個別に付けるか。middleware は影響範囲が広い。
6. **T-01〜T-09 の実行方法** — 実ブラウザ（Playwright・`verify:screen` と同型）か、
   dev サーバへの `fetch` ＋ Cookie 自作（`signViewer` を transpile して使う・
   `verify:special-accounts` と同型）か。後者の方が速く、Cookie の状態を作り分けやすい。
7. **`/result/[id]` の `?u=` 除去後のアクセス制御** — `getResultData` が
   artifact の所有者を検証しているかは本調査で未確認。**URL から UID が消えても
   `artifact_id` は URL に残る**ため、他人の `artifact_id` を指定した場合の挙動を
   実装前に確認すること（本改修で悪化はしないが、確認しておくべき点）。

---

## 21. 将来対応

1. **Admin 代理表示の `?u=` 廃止（今回対象外）**
   代理表示の対象を Cookie またはサーバ側セッションで持ち、URL から UID を完全に消す。
   wellfort-site 側の入口（`admin/customers.astro:438` /
   `admin/health-age.astro:261`）の変更が必要なため、2 リポジトリ同時のリリースになる。
   移行期間は `?u=` と新方式の併存が必要。
2. **`api/live-token.ts` / `api/insight.ts` の uid 検証**（§15.4）。
   `resolveViewer` を通し、body の `diagnosticUserId` を**無視する**か本人と一致検証する。
3. **ページに埋め込む uid の削減**（`data-diagnostic-user-id` 等）。
   クライアント JS が uid を持たずに済む API 設計（サーバが Cookie から解決する）へ。
4. **`ALLOW_UID_ENTRY` の廃止**。本番で使われていないことを確認できたら、
   緊急復旧手段を別方式（管理者による Cookie 再発行など）へ置き換えて削除する。
5. **`Referrer-Policy` / `Content-Security-Policy` の付与**。
   URL から UID が消えても、埋め込み値や外部リンクからの漏出は別に閉じる必要がある。

---

## 22. 調査した根拠

- `src/lib/viewer.ts:1-285`（全体。特に `:39-41, 192-230, 242-284`）
- `src/components/GoogleOneTap.astro:176-204`
- `src/pages/index.astro:1-13`
- `src/pages/dashboard.astro:38-60, 236, 280, 325-329, 352-353, 363, 381, 391, 438`
- `src/pages/report.astro:45-50, 196-202, 253, 259, 624, 628`
- `src/pages/trend.astro:37-42, 95, 98`
- `src/pages/kit.astro:36-41, 108, 114, 117, 224`
- `src/pages/scan.astro:32-33, 65, 1149, 1159`
- `src/pages/chat.astro:15-16, 27`
- `src/pages/coach.astro:36-37, 55`
- `src/pages/notices.astro:19-21, 67`
- `src/pages/result/[id].astro:14-17, 32-37, 53-59, 72, 80, 225`
- `src/components/AppNav.astro:20-51, 71`
- `src/components/BackToDashboard.astro:18-32`
- `src/components/dashboard/HealthAgeCard.astro:34, 39, 169`
- `src/components/dashboard/TestResultsSection.astro:23, 128, 139`
- `src/components/dashboard/ProgressSection.astro:50, 91, 104, 127, 155`
- `src/components/dashboard/KitProgressCard.astro:25, 42`
- `src/components/dashboard/HealthInsightCard.astro:89`（死んだ経路）
- `src/components/dashboard/TestHistoryList.astro:11, 34`（未参照）
- `src/components/dashboard/HealthCoachPreview.astro:28`（未参照）
- `src/scripts/chat/live-controller.ts:120, 1489`
- `src/pages/api/live-token.ts:24-28, 44-46`
- `src/pages/api/insight.ts:26-30, 42`
- `src/pages/api/interview/export.ts:85, 104`
- `src/pages/api/debug/viewer.ts:22, 99-129`
- `src/pages/admin/index.astro:1-17`
- `src/pages/admin/lab-results/upload.astro:10`
- `scripts/spec-guard.mjs:33, 52, 128`
- wellfort-site `src/pages/admin/customers.astro:14, 438`
- wellfort-site `src/pages/admin/health-age.astro:261`
- 検索して**該当 0 件**だったもの: `src/pages/**.astro` の `Cache-Control` /
  `src/middleware.ts` / `astro.config.mjs` と `vercel.json` の `headers` /
  `src/scripts/**` の `searchParams.get('u')`
