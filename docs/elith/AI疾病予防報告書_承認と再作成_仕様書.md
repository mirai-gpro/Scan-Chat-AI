# AI疾病予防報告書 承認・再作成 仕様書

- 対象: AI疾病予防報告書 (`diagnosis.diagnosis_results`)
- 目的: Elith 受領 JSON から生成された報告書を、**利用者のダッシュボードへ出す前に Wellfort 管理者が確認・承認**できるようにする
- 方針: **暫定機能**。既存処理を最大限流用し、実装・運用とも最小構成にする
- バージョン管理: **行わない**。報告書は常に最新生成結果で上書きする
- 発注日: 2026-10-07 (発注者指示書 `claudecode_ai_report_approval_instructions.md` + 要件 `wellfort_ai_report_approval_spec.md`)
- 実装: 済み (この文書が正本)

---

## 読み方 (節番号について)

**節番号は発注の要件定義書 `wellfort_ai_report_approval_spec.md` に合わせてある**
(コードのコメントがこの番号で参照しているため)。
要件定義書の §1 背景 / §2 基本方針 はそのまま有効なのでここでは繰り返さない。
§0 だけがこの文書の追加で、**実装を読む前に必ず読む前提**。

| 節 | 内容 |
|---|---|
| §0 | **【最重要】紙面は保存されていない** という前提 |
| §3 | 公開状態 (状態遷移 / 既存 `status` を使わない理由) |
| §4 | 既存報告書の扱い (導入時に消さない) |
| §5 | 管理画面 (1 画面・一覧 / 確認 / 承認 / 再作成) |
| §6 | 1 件再作成の処理 |
| §7 | Elith 再 RUN 時 |
| §8 | ユーザー側の表示条件 (サーバ側で approved 限定) |
| §9 | 同時実行・誤操作対策 |
| §10 | 権限 |
| §11 | 実装上の重要原則と、実装していないもの |
| §12 | 検証と受入条件 |
| §13 | 申し送り |

---

## 0. 【最重要】この機能の前提 — 紙面は保存されていない

**実装を読む前にここを理解すること。** 誤解すると「再作成」の意味を取り違える。

`diagnosis.diagnosis_results` に入っているのは **Elith 受領 JSON** であって、
報告書の**紙面 (HTML) は保存されていない**。紙面は表示のたびに組まれる。

```
Elith 受領 JSON (S3)
  → 取り込み   elith-intake.ts / api/admin/elith-report/upload.ts
  → 保存       elith-report-ingest.ts ingestElithReport()
               diagnosis.diagnosis_results (report / checkup_values / schema_version / source_key)
  → 生成       report-adapter.ts buildReportVM()   ★表示のたびに毎回
  → 取得       elith-report-queries.ts loadReportVM()
  → 表示       report.astro (画面と ?print=1 が同じレンダラ)
```

したがって:

- **生成ロジックを直してデプロイした時点で、過去分の紙面も自動的に新しくなる。**
  「過去分に修正を反映するための再生成」は、紙面については**何もしなくても効いている**。
- 保存されている成果物は受領 JSON だけ。再作成で**作り直せるのは受領 JSON の控えと生成の検証**。

**「最新版生成処理で再作成」の実体は 3 つ** (§6.4):

1. その報告書に対応する**現在の**受領 JSON を取り直す (S3 → 無ければ DB の控え)
2. **本番と同じ `buildReportVM()`** に通し、最後まで生成できることを確かめる
3. 成功したときだけ上書きし、`pending` へ戻して**再承認を要求する**

→ **バグ修正を過去分へ反映したうえで「人が目で確認し直す」**という運用が、この機能の価値。
**再作成専用の生成ロジックは作らない。**

---

## 3. 公開状態

`diagnosis.diagnosis_results` に専用の列を足す
(migration `supabase/migrations/20261007000010_diagnosis_report_approval.sql`)。

| 列 | 意味 |
|---|---|
| `publish_status` | `pending` = 未承認 (**ユーザーに返さない**) / `approved` = 承認済 |
| `approved_at` | 承認日時。`pending` のときは null |
| `approved_by` | 承認した管理者。**`adminIdentity()` の HMAC digest だけ** (生メールは入れない) |
| `publish_rev` | 再作成のたびに +1 するカウンタ。**履歴ではない** (§9 の競合検知用) |

### 3.1 状態遷移

```
新しい Elith 受領 JSON → 報告書の行を insert → pending   (DB の既定。追加処理なし)
pending  → 管理者が承認 → approved (+ approved_at / approved_by)
approved or pending → 再作成成功 → 上書き → pending (approved_at / approved_by は null へ)
再作成失敗 → 報告書・承認状態とも一切変更しない
```

---

### 3.2 なぜ既存の `status` を使わないか

既存 `status` (`received | extracted | published | superseded`) は**世代管理を兼ねている**。
取り込みは「既存行を `superseded` に落として新しい行を足す」ので、承認状態を同じ列に載せると
**差し替えのたびに承認の記録が消える**。

さらに `status='published'` は 4 か所が読んでいる
(`coach-context.ts` / `chat-context.ts` / `result-queries.ts` / `dashboard-queries.ts`。
実データでは一度も立たないため現在は死蔵)。ここへ承認の意味を持ち込むと
**その 4 経路の挙動が黙って変わる**。

→ 承認は専用列に分け、**`status` は 1 文字も触らない**。

## 4. 既存報告書の扱い (導入時に消さない)

**導入した瞬間に既存の公開中の報告書が全部消えてはいけない。**

`add column ... not null default 'pending'` と書くと**既存の全行が pending** になる。
だから migration は 3 段で行う:

1. 列を**既定なし**で足す (既存行は null)
2. `update ... set publish_status = 'approved' where publish_status is null`
3. そのあとで `set default 'pending'` / `set not null`

→ **今後 insert される行だけが `pending`** になる。
**migration で報告書を一括再生成しない** (insert を 1 つも書かない)。

### 4.1 適用順序の保険

CLAUDE.md の migration 規約どおり **DB を先に適用する**。
ただし順序が入れ替わっても利用者の画面を落とさないよう、アプリ側は
**列が無い環境では「全行 approved 相当」** として振る舞う (`isApprovedRow()` が
`undefined` / `null` を承認済として扱う)。列が無い環境には `pending` の行も存在しないので、
これで未承認が漏れることはない。

- `loadReportVM` は列の有無で 3 段に落として引き直す
- `/api/report-route` も列を外して引き直す (**無いと 10 名の公開中 PDF が「開けない」に化ける**)
- 管理一覧は引けたら `migrationApplied: false` を返し、画面に「未適用」と出す
  (**「対象 0 件」と混同させない**)

---

## 5. 管理画面 (1 画面)

**UI = wellfort-site / 処理 = Scan-Chat-AI API** (CLAUDE.md の責務分界)。

- 画面 … `wellfort-site/src/pages/admin/report-approval.astro`
  (サイドバー「検査連携」→「AI疾病予防報告書 承認」)
- 中継 … `wellfort-site/src/pages/api/admin/report-approval/[action].ts`
  (allow-list: GET `list` / POST `approve` `recreate`)
- API … `Scan-Chat-AI/src/pages/api/admin/report-approval/{list,approve,recreate}.ts`

### 5.1 一覧

**画面は 1 枚**。上部の切替で `未承認` / `承認済` を出す。
**専用の「承認済リスト」ページは作らない。**

各行に出すもの: チェックボックス / 公開状態 / `diagnostic_user_id` / 受領日時 /
再作成回数 / 形式 (`schema_version`) / 取り込み元 (`source_key`) / 操作。

**氏名は返さない・出さない。** 識別は `diagnostic_user_id` と受領日で行う
(Scan-Chat-AI 側は PII を持たない。報告書の中身で本人を確かめるのは次の「確認」で行う)。

### 5.2 確認

「確認」は**既存の代理表示 (handoff)** でその方の画面を新しいタブに開く
(`/api/admin/impersonation-handoff` → `/admin-view/<ctx>/dashboard` → 「報告書を読む」)。

**管理画面に報告書の表示処理を複製しない。** 本番の `/report` をそのまま見るので、
「管理画面では正常に見えたが本番ダッシュボードでは違う」が構造的に起こらない。
未承認の紙面が見えるのは `viewer.isAdmin` のときだけ (§5)。

**URL に uid を載せない** — handoff を使うのは 2026-09-29 の方針どおり。

### 5.3 承認

行の「承認してダッシュボードへ反映」。確認ダイアログを 1 枚出す。
一覧で見た `publish_rev` を `expectedRev` として送り、**その間に再作成が入っていたら 409**
(§9)。409 のときは一覧を読み込み直して、もう一度確認してもらう。

### 5.4 再作成

`未承認` / `承認済` どちらの一覧でも、行のチェックボックスで選んで
**「選択した報告書を最新版生成処理で再作成」**。

確認ダイアログ:

> 選択した N 件の報告書を、現在の最新版生成処理で再作成します。
> 再作成に成功した報告書は未承認となり、再承認するまでダッシュボードには表示されません。

- **1 件用 API を 1 件ずつ順番に叩く** (§6.3)。並列にしない
- 処理中は重複操作を止める (タブ切替・再読み込み・ボタンとも)
- 終わったら **成功件数 / 失敗件数 / 失敗対象 / 失敗理由**を出す
- **一部失敗しても残りは続ける**。失敗した行には
  「この報告書と承認状態は変更されていません」と添える
- **再作成できない行にはチェックボックスを出さない** (押しても必ず失敗するため)

---

## 6. 1 件再作成の処理

### 6.1 受け取るもの

**`resultId` (`diagnosis_results.id`) だけ。**
S3 キー・受領 JSON 本文・生成パラメータは受け取らない。中継も body を素通ししない。

### 6.2 材料の解決 (サーバ側)

| 行の種類 | 材料 | `source` |
|---|---|---|
| `source_key` が Elith 下りのフォルダ (`output/user/<uuid>/date/<YYYY_MM_DD>/`) | **S3 を読み直す** | `s3` |
| 手動アップロード等 (受領 JSON が DB にある) | DB の控え (取り込み時に 1 バイトも加工していない) | `stored` |
| 完成済み PDF の行 (`manual-pdf-v1` / `manual:transcosmos:`) | **再作成しない** (§6.5) | — |
| 材料が何も無い行 | **再作成しない** | — |

S3 の読み取りは**取り込みと同じ関数**を通す
(`elith-intake.ts` の `groupByFolder()` / `readFolderMaterial()`)。
**新しい S3 探索ルールを作らない。** 読み方が 2 つあると、再作成だけ別の解釈をして静かに食い違う。

「揃った」判定も取り込みと同じ (**ファイル 2 つ以上** かつ `report_text.json` がある)。

**S3 が未設定・読めないときに DB の控えへ黙って落ちない** — 失敗として返す
(「S3 を読み直したつもりで読んでいない」を作らない)。

### 6.3 一括 API は作らない

**1 リクエスト = 1 件。** 一括処理専用 API・長時間ジョブ・キュー・
一括トランザクション・複雑なロールバックを作らない。

### 6.4 処理順 (この順序が要件)

```
対象を引く
→ 承認用の列があることを確認 (無ければ中止)
→ 再作成できる行かを確認 (§6.5)
→ 材料を取り直す
→ 本番と同じ buildReportVM() で生成
→ 生成が最後まで通ったことを確認
→ 【ここで初めて書く】1 本の update で 上書き + pending + approved_* を null + rev+1
```

**上書きと `pending` 化は同じ 1 本の update。** 分けると
「紙面だけ入れ替わって承認済のまま」が起こり得る。

### 6.5 失敗したら 1 バイトも変えない

次のどれでも、**報告書と承認状態を一切変更しない**:

| 失敗 | 返す error |
|---|---|
| 対象が無い | `not_found` |
| 承認用の列が無い (migration 未適用) | `migration_required` |
| 完成済み PDF の行 / 材料が無い行 | `not_recreatable` |
| S3 未設定 | `s3_not_configured` |
| 元フォルダが無い | `source_not_found` |
| 元が揃っていない | `source_incomplete` |
| 元を読めない | `source_read_failed` |
| 生成が例外 | `generate_failed` |
| **生成結果が空 (章 0 件 かつ 検査値 0 件)** | `generated_empty` |
| 処理中に別の再作成が入った | `changed_during_recreate` |
| 保存に失敗 | `save_failed` |

**`generated_empty` を成功として扱わない。** 章も検査値も 0 件なら紙面は帯だけになり、
利用者から見れば報告書が消えたのと同じ。**生成途中の不完全なデータで既存報告書を上書きしない。**

### 6.6 完成済み PDF の行を再作成しない理由

トランスコスモス 10 名の行 (`schema_version='manual-pdf-v1'` /
`source_key='manual:transcosmos:…'`) は**組版済み PDF そのもの**を持ち、受領 JSON を持たない
(`report: []`)。ここで再作成を走らせると生成は空になり、
**公開中の PDF が `pending` に落ちて 10 名のダッシュボードから消える。**

判定は `report` の中身ではなく **`schema_version` / `source_key` で明示的に**行う
(「`report` が空だから止まった」に頼ると、将来 `report` に何か入った途端に穴が開く。
退行注入で実証済み)。

### 6.7 連打しても二重にならない

再作成は **UPDATE しかしない**ので、連打でも行は増えない (冪等)。
加えて画面側で行ごとに操作を止め、サーバ側も `publish_rev` 一致を条件に更新する。

---

## 7. Elith 再 RUN 時

新しい受領 JSON が届いたら**既存の受領処理をそのまま使う**。
新しいワークフローは作らない。

```
新しい Elith 受領 JSON → 既存の取り込み (ingestElithReport) → 新しい行 → pending
```

取り込みは `publish_status` を**明示しない**。DB の既定 (`pending`) に任せるので、
取り込み側のコードは 1 行も変えていない。

---

## 8. ユーザー側の表示条件 (サーバ側で approved 限定)

**フロントの表示 / 非表示で実装してはいけない。** CSS・JS で隠す実装は作らない。
以下の**全経路**をサーバ側で絞る。

| 経路 | 絞り方 |
|---|---|
| `loadReportVM()` (紙面の本体) | `publish_status` を引き、`isApprovedRow()` で採用を決める |
| `loadDashboard()` → `latestResult` | 取得後に `isApprovedRow()` で絞る (タイルの可否・受領日・進捗がこれで決まる) |
| `/api/report-route` (完成済み PDF の署名 URL) | **署名を発行する手前**で止める |
| `coach-context.ts` (AI コーチ) | 同 |
| `chat-context.ts` (AI 問診) | 同 |
| `result-queries.ts` (`/result/[id]` の 3 モード) | 同 |

**未承認を見られるのは管理者だけ** — `report.astro` が `includeUnapproved: viewer.isAdmin`、
`loadDashboard(u, viewer.origin, viewer.isAdmin)` を渡す。既定は false (fail-closed) なので、
引数を渡していない呼び出し (`kit.astro` / `trend.astro` / debug) は承認済だけになる。
外部共有リンク (`viewer.kind === 'share'`) は admin ではないので**承認済しか見えない**。

抽出監査 API (`/api/admin/elith-report/audit`) だけは `includeUnapproved: true`。
**承認する前に「黙って空になっていないか」を確かめるのがその API の仕事**なので、
ここで承認済だけに絞ると承認前の確認ができない。

### 8.1 承認されるまでは「何も出ない」

取り込みは既存行を `superseded` に落としてから新しい行を足すので、
**新しい受領分が届くと、1 つ前の承認済の行は世代落ちしている**。
つまり承認するまで利用者の報告書は**一時的に出ない**。

これは仕様どおり (§3.1「上書き → 未承認 → 再承認まで非表示」)。
**1 件前に遡って古い紙面を出すことはしない** (常に 1 つの最新報告書だけを保持する方針)。

---

## 9. 同時実行・誤操作対策

| 防ぐこと | 手段 |
|---|---|
| 再作成中の同じ報告書を連打 | 画面で行ごとに操作を止める + UPDATE のみ (冪等) |
| **承認と再作成の競合で、再作成後の報告書が `approved` になる** | 承認は `where id=? and publish_status='pending' and publish_rev=?`。一覧で見た rev と違えば **409** |
| 処理中に別の再作成が割り込む | 再作成も `where publish_rev=?` を条件にする → `changed_during_recreate` |
| 生成途中の不完全なデータで上書き | §6.4 の順序 + `generated_empty` |

**バージョン履歴は追加しない。** `publish_rev` は履歴ではなく条件付き更新のためのカウンタ。

---

## 10. 権限

一覧・確認・承認・再作成は**すべて既存の管理者権限をサーバ側で確認する**。新しい認証方式は作らない。

2 層 (既存の `elith-intake` / `special-accounts` と同一):

1. **入口 (admin 判定)** … wellfort-site `verifyAdmin()`。ユーザー自身のアクセストークン +
   anon apikey で `admin_users` を照会 (`is_active=true`)。**service_role は使わない**
2. **上流 (Scan-Chat-AI)** … Bearer `ADMIN_API_KEY` (`api-auth.ts`・キー未設定の本番は拒否)

**鍵はブラウザへ出さない。** 画面は自分のアクセストークンで中継を叩くだけ。

**承認者のメールはブラウザから受け取らない。** 1) で Supabase が検証した値だけを
`triggeredByEmail` として中継が送り、**その名前のまま DB へは入らない** —
上流が `adminIdentity()` の HMAC digest に落としてから `approved_by` へ入れる
(鍵は Scan-Chat-AI 側にしかないので中継では digest を作れない)。
`safeApprovedBy()` は **base64url 43 文字だけ**を通す allow-list。

---

## 11. 実装上の重要原則と、実装していないもの

### 11.1 既存本番報告書生成処理を再利用する
再作成専用の別生成ロジックを作らない。`buildReportVM()` は表示・取込・監査が共用している
唯一の生成本体なので、切り出しも共通化もしていない。

### 11.2 既存の Elith 受領 JSON 特定方法を再利用する
**新しい独自 S3 探索ルールを作らない。** S3 の読み取りは取り込みと同じ
`groupByFolder()` / `readFolderMaterial()` を通す (そのために `elith-intake.ts` から
読み取りループを**挙動を変えずに**関数へ切り出した。これが今回した唯一の共通化)。
手動アップロードの行は、取り込み時に 1 バイトも加工せず入れてある DB の控えが
「その報告書に対応する受領 JSON」そのもの。

### 11.3 報告書は上書きする
バージョンテーブル・履歴レコードを作らない。再作成は UPDATE だけで行い、行は増えない。

### 11.4 失敗時は現状維持
正常な新報告書が完成するまで既存報告書を変更しない (§6.4 / §6.5)。

### 11.5 既存公開済報告書を導入時に消さない
既存データは `approved` 相当として移行する (§4)。

### 11.6 一括処理専用バックエンドを作らない
1 件用再作成 API を管理画面から順番に呼ぶ (§6.3)。

### 11.7 無関係なリファクタリングをしない
本機能に必要な最小差分だけ。既存の `status` / 世代管理 / 取り込み / Elith 連携仕様 /
納品 JSON 生成仕様 / S3 のディレクトリ構成は**触っていない**。

### 11.8 実装していないもの (意図的)

- 報告書の revision テーブル / 過去版の保存 / 差分表示 / report hash による履歴管理
- コメント・差戻し理由 / 多段階承認 / 承認ワークフロー
- 専用の「承認済一覧」画面
- S3 オブジェクトの pending/approved フォルダ移動
- 一括再作成の API / ジョブ / キュー
- 報告書内容の手動編集
- `/report` の紙面への「未承認」表示 (§13 の申し送り)

## 12. 検証と受入条件

`npm run verify:report-approval` (A 層・CI の `static-required`)。
**実物を transpile して動かす** — Supabase / S3 / 生成本体だけスタブに差し替えるので
DB も鍵も要らない。

| 章 | 見るもの |
|---|---|
| ① | migration が既存行を未承認にしないこと (列追加 → approved で埋める → 既定 pending の順序) |
| ② | `isApprovedRow()` が列の無い環境を承認済相当にし、知らない値は fail-closed |
| ③ | 再作成できる行の判定 (完成済み PDF を**中身の有無に関係なく**止める) |
| ④ | 承認は `pending` かつ rev 一致のときだけ / 生メールが `approved_by` に入らない |
| ⑤ | 再作成成功 = 上書き + pending + rev+1、**1 本の update**、行が増えない |
| ⑥ | **失敗 9 種で DB を 1 度も書かない**・承認済のまま・中身が残る |
| ⑦ | 一覧は最新世代だけ / migration 未適用を 0 件と混同しない / 氏名を返さない |
| ⑧ | ユーザー向け 6 経路の承認ゲートと、既定が fail-closed であること |
| ⑨ | API の認可 / 受け取るのは resultId だけ / 一括 API が無い / 画面の形 |
| ⑩ | 既存の取り込みを壊していないこと (S3 の読み方が 1 つ) |

**退行注入 15 種とも名指しで落ちることを確認済み。**
うち 2 件はこの注入で穴が見つかり、検査を直してある:

- **注入 4** (完成済み PDF の判定を外す) … `report: []` の方で止まるため素通りした
  → **中身のある PDF 行**で見るように変更
- **注入 10** (署名発行の後ろへ承認チェックを動かす) … 先頭の `import { isApprovedRow }` に
  当たって素通りした → **呼び出しの位置**を見るように変更

その他の実行した検査 (すべて PASS):
`astro check` 0 errors / `astro build` 成功 / A 層 38 本 /
`verify:screen`・`verify:interview-ui`・`verify:scan-pages` (実ブラウザ) /
wellfort-site: `astro build` 成功・verify 10 本。

---

### 12.1 受入条件 (要件定義書 §12)

| # | 条件 | 結果 | 根拠 |
|---|---|---|---|
| 1 | 導入前から存在する公開済み報告書が、導入後もダッシュボードで表示される | PASS | migration 3 段 (§4) ・`verify:report-approval` ① |
| 2 | 導入後に新規生成された報告書は `pending` で、承認前はユーザーに表示されない | PASS | DB 既定 `pending` ・ユーザー側 6 経路 (§8) ・同 ⑧ |
| 3 | 管理者が承認するとダッシュボードで表示される | PASS | `approveReport()` ・同 ④ |
| 4 | 未承認を再作成すると上書きされ `pending` のまま | PASS | `recreateReport()` ・同 ⑤ |
| 5 | 承認済を再作成すると上書き後 `pending` へ戻り、再承認まで非表示 | PASS | 同 ⑤ (approved→pending / approved_* を null) |
| 6 | **承認済の再作成が失敗したら旧報告書と `approved` が完全に維持される** | PASS | §6.4 の順序 ・同 ⑥ (失敗 9 種で書き込み 0 件) |
| 7 | 複数選択で 1 件ずつ処理され、成功したものだけ `pending` になる | PASS | 画面が 1 件用 API を順番に ・同 ⑨ |
| 8 | 一部失敗しても残りは継続し、成功/失敗が分かる | PASS | 画面の集計表示 ・同 ⑨ |
| 9 | Elith の新しい受領 JSON で再生成された報告書は `pending` | PASS | 取り込みは既定に任せる (§7) ・同 ⑩ |
| 10 | 一般ユーザーは `pending` を API / URL 直接アクセスでも取得できない | PASS | §8 の 6 経路 (署名 URL も発行前に停止) ・同 ⑧ |
| 11 | 管理者以外は一覧・確認・承認・再作成を実行できない | PASS | 2 層認可 (§10) ・同 ⑨ |
| 12 | 管理者の確認表示はユーザーと同じ報告書データ / 表示処理を使う | PASS | 代理表示で本番 `/report` を開く (§5.2) |
| 13 | 通常の再作成で複製・バージョン履歴が増えない | PASS | UPDATE のみ ・同 ⑤ (行数不変・insert 0 回) |
| 14 | 再作成と承認が競合しても、新報告書が自動的に承認済になる事故がない | PASS | `publish_rev` 条件付き更新 (§9) ・同 ④ |

**この環境で確認できていないこと**: 実 DB への migration 適用後の挙動・S3 からの実再取得・
署名 URL の実挙動・admin 画面の実ブラウザ操作 (Supabase / S3 / 鍵がこの作業環境に無い)。
**本番で 1 回通すのが完了条件** (§13-4)。

## 13. 申し送り (人の判断が要る)

1. **migration の適用が必要** —
   `supabase/migrations/20261007000010_diagnosis_report_approval.sql`。
   **アプリより先に DB へ適用する** (後方互換な列追加なので先に当てて問題ない)。
   未適用のままアプリが出ても公開中の報告書は消えないが、**承認・再作成はできない**
   (一覧に「未適用」と出る)。
2. **「確認」は代理表示のダッシュボードに着地する** — handoff の着地先は
   `/admin-view/<ctx>/dashboard` 固定なので、紙面までは**タブ内で 1 クリック**が要る。
   報告書へ直接着地させるには handoff に行き先を持たせる改修が必要で、
   それは代理表示の仕組み (`verify:admin-handoff` が守っている領域) に手を入れることになるため、
   今回はしていない。
3. **紙面そのものに「未承認」と出していない** — 管理者が見ているのが未承認かどうかは
   **管理一覧の状態**で判別する。`/report` の紙面に当社の文言を足すと
   `verify:report-verbatim` (受領 JSON に無い文言を紙面に出さない検査) の対象になるため、
   紙面は 1 文字も変えていない。必要なら「操作の語」として `ALLOW` に理由つきで足す判断が要る。
4. **本番での通し確認が要る** — この作業環境には Supabase も S3 も鍵も無いので、
   実際の承認・S3 からの再取得・署名 URL の挙動は未確認。検証はすべて決定論部とスタブ。
5. **既存の `status='published'` を読む 4 経路は死蔵のまま** — 実データでは一度も立たないので
   承認ゲートだけ足し、`status` の設計自体は触っていない。
   `/result/[id]` の 3 モード (決裁台帳 D-19) の扱いは別途判断。
