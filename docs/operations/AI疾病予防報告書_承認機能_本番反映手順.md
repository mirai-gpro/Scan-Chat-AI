# AI疾病予防報告書 承認機能 本番反映手順

- 対象: AI疾病予防報告書の**管理者承認ゲート**と**1 件再作成** (2026-10-07)
- 仕様の正本: `docs/elith/AI疾病予防報告書_承認と再作成_仕様書.md`
- この文書は**本番へ入れる順序と確認のしかた**だけを扱う

---

## 0. 【最重要】順序を守る

```
① DB migration   20261007000010_diagnosis_report_approval.sql
                 20261007000020_diagnosis_report_approval_hash.sql
② Scan-Chat-AI   (API と承認ゲート)
③ wellfort-site  (管理画面)
```

**① を飛ばす・後回しにすると、承認ゲートが効かない時間帯ができる。**

> ### ⚠️ migration 適用前に新規の Elith 取込が発生すると、その報告書は承認ゲートを通らずユーザーへ公開され得る
>
> `publish_status` 列が無い間、取り込み (`ingestElithReport`) はその列を書けないので
> 新しい行に `publish_status` が存在しない。アプリは**列が無い環境を「承認済相当」として
> 扱う** (既存の公開中の報告書を落とさないための fail-open) ため、
> **管理者が一度も確認していない報告書がそのまま利用者のダッシュボードに出る。**
>
> 取り込みは **毎日 9:00 JST の cron** (`/api/cron/elith-intake`) で自動で走る。
> **適用を翌日へ持ち越さないこと。**

**`approved_report_hash` だけ未適用** (① の 1 本目だけ当てた状態) では、
未承認/承認済のゲートは効くが**指紋の照合が効かない**。この状態では承認 API が
`migration_required` で止まるので承認操作はできない — つまり「承認したのに
指紋が無い行」が生まれることはない。

**②→③ の順**: 管理画面 (③) は Scan-Chat-AI の API (②) を叩くだけなので、
逆順だと画面だけ出て API が 404 になる。

---

## 1. ① DB migration

Supabase へ 2 本を適用する (`supabase db push` = 未適用ぶんだけ反映)。
**後方互換な列追加のみ**で、アプリより先に当ててよい。

| migration | 内容 |
|---|---|
| `20261007000010_diagnosis_report_approval.sql` | `publish_status` / `approved_at` / `approved_by` / `publish_rev` を追加。**既存行を `approved` で移行**し、以後の既定を `pending` にする |
| `20261007000020_diagnosis_report_approval_hash.sql` | `approved_report_hash` を追加 (既存行は NULL = 指紋なし) |

### 1.1 適用後に必ず確かめること

```sql
-- 既存の公開中の報告書が全部 approved になっているか (pending が 0 であること)
select publish_status, count(*) from diagnosis.diagnosis_results group by 1;

-- 以後の既定が pending か
select column_name, column_default, is_nullable
  from information_schema.columns
 where table_schema = 'diagnosis' and table_name = 'diagnosis_results'
   and column_name in ('publish_status','approved_at','approved_by','publish_rev','approved_report_hash');
```

- `publish_status` の `column_default` が `'pending'::text`
- **`pending` の行が 0 件** (この時点ではまだ 1 件も `pending` にならない)
- `approved_report_hash` が存在し `is_nullable = YES`

**`pending` が 1 件以上あったら止めて相談する** — 既存の公開中の報告書が
非表示になる状態なので、`20261007000010` の 3 段 (列追加 → `approved` で埋める →
既定を `pending`) のどこかが効いていない。

---

## 2. ② Scan-Chat-AI

通常どおりデプロイ元ブランチへ反映する。CI の `static-required`
(astro check / build / A 層) が緑であることが前提。

### 2.1 反映後の確認

1. **既存の公開中の報告書が今までどおり見えるか** — 受領済みの利用者を
   代理表示 (`/admin/customers` の代理表示ボタン) で開き、「報告書を読む」が
   押せて紙面が出ること。
   (移行した行は指紋なしなので従来どおり公開される。)
2. **切り分け用の自己診断** — `GET /api/debug/viewer` の `received.publish_status`。
   `approved` / `pending` / `(列なし = 承認済相当)` のどれかが出る。
   **「列なし」が出たら ① が未適用。**

---

## 3. ③ wellfort-site

管理画面 `/admin/report-approval` (サイドバー「検査連携」→「AI疾病予防報告書 承認」)。

### 3.1 反映後の確認

1. `未承認` タブ … 直後は 0 件 (既存は全部 `承認済` へ移行済み)
2. `承認済` タブ … 既存の件数が並び、各行に **`公開中`** と出る
   (指紋が無い行なので照合せず公開している状態)
3. 画面上部に **「承認用の列がまだありません」** が出たら ① が未適用

---

## 4. 通し確認 (1 件でよい)

次の取込を待たずに確かめるなら、`/admin/elith-intake` で 1 人ぶんを取り込む。

| # | 操作 | 期待 |
|---|---|---|
| 1 | Elith の受領分を取り込む | `未承認` タブに 1 行増える |
| 2 | その利用者を代理表示で開く | **報告書タイルがグレーアウト**（押せない） |
| 3 | 管理画面の「確認」→ 代理表示で紙面を見る | 管理者には紙面が出る |
| 4 | 「承認してダッシュボードへ反映」 | 行が `承認済` + `公開中` になる |
| 5 | 利用者側をもう一度開く | タイルが押せて紙面が出る |
| 6 | その行を「再作成」 | `未承認` へ戻り、利用者側は再びグレーアウト |

### 4.1 承認後に生成ロジックを直したときの挙動 (今回の本題)

生成ロジック (`report-adapter.ts` 等) を直してデプロイすると、
**承認済みの行は自動的に `紙面が変わった（非公開）` になり、利用者には出なくなる。**
管理者が内容を確認して**もう一度承認**すれば公開に戻る。

**章立ての設定 (`app_config` の `report.sections.*`) を変えたときも同じ**で、
**全件が再承認待ちになる** (仕様書 §3.3.6)。見せ方を変えるだけのつもりで
全件が非公開になるので、**変更は承認の手間と合わせて計画する**。

---

## 5. 切り戻し

**コードだけ戻す。** 列は残してよい (後方互換・アプリが読まなければ無害)。

- ② を前の版へ戻すと、承認ゲートごと無くなるので**全件がまた公開される**
  (`publish_status='pending'` の行も出る)。**それが許容できるかを先に判断する。**
- `drop column` はしない (`20261007000010` が `approved` へ移行した情報と、
  承認済みの指紋が失われる)。

---

## 6. 関連

| 文書 | 内容 |
|---|---|
| `docs/elith/AI疾病予防報告書_承認と再作成_仕様書.md` | 仕様の正本 (§13.1 に同じ順序) |
| `docs/elith/AI疾病予防報告書_仕様書.md` | 報告書そのものの正本 |
| `npm run verify:report-approval` | 承認ゲートと指紋の回帰チェック (CI の A 層) |
