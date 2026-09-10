# 臨時診断バッチ 仕様書（クロスシステム）

| 項目 | 内容 |
|---|---|
| 版 | **1.0**（2026-09-10・**実装済み**・**決定仕様**。未確定は §28 に `OPEN` として分離。変更点は §30） |
| 未確定の残り | **6 件**（O2 / O3 / O4 / O6 / O7 / O9・§28.2）。**O1 / O5 / O8 / O10 は解決済み**（§28.1） |
| 実装 | **完了**（§31）。Scan-Chat-AI = `src/lib/ad-hoc-diagnosis/*` + `src/pages/api/admin/ad-hoc-diagnosis/*` ／ wellfort-site = `/admin/ad-hoc-diagnosis` + 中継 API |
| 対象システム | **wellfort-site**（管理画面 UI・管理者認証・ブラウザとのやり取り）／ **Scan-Chat-AI**（ZIP 受付処理・分類・解析・ジョブ状態・ウェルネス年齢・Elith JSON 生成・S3） |
| 同系統の先行仕様 | `docs/lab/wellfort_admin_lab_upload_spec.md`（**責務分界の正**。§3 配置場所／§6-1 Bearer API Key） |
| 上位・関連 | `docs/elith/elith_s3_data_handoff_spec.md`（納品パス・命名）／`docs/elith/elith_assembly_wrapping_spec.md`／`docs/elith/elith_masking_definition.md`／`docs/scan/health_age_caba_v5.4_spec.md`／`docs/scan/health_age_simple_v7.0_spec.md`／`docs/lab/lab_data_pipeline_master_spec.md` |
| 発端 | 発注者指示書「ClaudeCode 実装指示書 — 臨時診断バッチ 仕様書作成・保存・実装」（2026-09-10） |

---

## 0. この文書の読み方

- **「既存仕様」「現行実装（実測）」「今回の要求」を必ず分けて書く。**
- 断定には出典（`file:line` か実測値）を付ける（CLAUDE.md R1）。**出典を出せないものは「未確認」と明示**する。
- **実装対象として決めたことは「決定仕様」として書く。** 決められないものだけ §28 に `OPEN` として置く。
- **本書に出てくる件数・列数のうち、出典が「指示書」のものは私の実測ではない。**
  今回のサンプル ZIP は本作業環境に渡っていない（アップロード領域に `.zip` は 0 件・実測）。
  ZIP の中身に関する記述（10 名／38 ファイル／健診 39 列／問診 62 列 等）は**すべて指示書 §2 からの引用**であり、
  実物での照合は行っていない。**列名に依存する箇所は `OPEN` に落としてある**（§28-O5）。

---

## 1. 目的

企業・団体等から**臨時に受領した複数人分の検査データ一式（ZIP）**を、管理者が投入し、
**自動分類 → 人物単位の整理 → 構造化 → ウェルネス年齢判定 → 管理者確認 → Elith 納品セット生成**
まで安全に実行できる管理機能を追加する。

**この機能の中心は「ZIP の OCR」ではない。**

```
ZIP → 人物単位へ整理 → データ種別を判定 → 既存の専門処理へ振り分け
    → 重複を除去 → 管理者確認 → Elith 形式へ統一
```

**分類と人物識別を分離すること**、**PII を client_id へ変換すること**、
**Elith 送信前に人間が確認すること**が設計の芯である。

---

## 2. 対象ユースケース

1. 企業・団体から「N 名分の健診 PDF／XLSX・遺伝子検査 PDF・問診 XLSX／PDF」を 1 つの ZIP で受領した。
2. 管理者が wellfort-site の管理画面から ZIP を投入する。
3. 人物ごとに何が揃っているかを画面で確認し、誤分類を直す。
4. 変換結果（項目数・警告・ウェルネス年齢の可否）を確認する。
5. **管理者が「確定」を押して初めて** Elith 納品先へ書き出す。
6. 結果（client_id／format／test_date／S3 key／validation）を後から再表示できる。

---

## 3. 非対象範囲

- **通常プラン（サブスク契約者）の検査パイプラインは変更しない。** 既存 5 種ゲート
  （`src/lib/elith-assemble.ts:29` `GATING_FORMAT_IDS`）は**この機能のために変更しない**（§15.5）。
- 顧客（`customer_profiles`）との自動紐付けはしない。**臨時バッチの被験者は EC 顧客ではない**前提で、
  診断側の識別子（`client_id`）だけを採番する（§13）。
- 検査機関 API からの自動受信（`wellfort_admin_lab_upload_spec` 付録 B-1）は対象外。
- 既存 `/admin/lab-results/upload`（検査結果アップロード）は**置換しない**。別機能として追加する。
- **Scan-Chat-AI 側に管理画面を作らない**（§4）。既存 `Scan-Chat-AI/src/pages/admin/*` は
  今回の前例として使わない。**削除・移設も本仕様のスコープ外。**

---

## 4. システム責務境界（**本仕様の要**・2026-09-10 発注者確定）

`docs/lab/wellfort_admin_lab_upload_spec.md` L5-6／§3／§6-1 の既存確定アーキテクチャを正とする。

| 層 | wellfort-site | Scan-Chat-AI |
|---|---|---|
| 管理画面メニュー | **担当**（`src/components/AdminLayout.astro` の `検査連携` グループへ追加） | — |
| 6 ステップ UI | **担当**（`/admin/ad-hoc-diagnosis`） | — |
| 管理者認証（入口） | **担当**（ユーザーのアクセストークン + anon apikey で `admin_users` を照会。`api/admin/elith-scan.ts:27-49` と同形。**service_role は使わない**） | — |
| ブラウザとのやり取り | **担当**（中継 API のみ。**ブラウザに `SCAN_CHAT_AI_API_KEY` を渡さない**） | — |
| PDF のページ画像化 | **担当**（pdf.js。既存 `admin/elith-batch.astro:494-508` と同じ） | — |
| ZIP 受付（ticket 発行） | 中継のみ | **担当**（キー採番・presigned PUT 発行） |
| ZIP 展開・安全検査 | — | **担当** |
| ファイル分類 | — | **担当** |
| XLSX / PDF 解析 | — | **担当** |
| ジョブ状態 | — | **担当**（`diagnosis` スキーマ） |
| ウェルネス年齢 | — | **担当**（`wellness-age.ts` を呼ぶだけ） |
| Elith JSON 生成・アセンブリ | — | **担当** |
| S3 処理 | — | **担当** |

### 4.1 呼び出しの向き（固定）

```
ブラウザ ──(ユーザーのアクセストークン)──▶ wellfort-site /api/admin/ad-hoc-diagnosis/*
                                              │  ① admin_users で admin 判定
                                              │  ② Bearer SCAN_CHAT_AI_API_KEY を付けて中継
                                              ▼
                                      Scan-Chat-AI /api/admin/ad-hoc-diagnosis/*
                                              │  isAdminAuthorized() (api-auth.ts)
                                              ▼
                                      S3 / Supabase / Gemini
```

- **鍵はサーバ側だけ**。`ADMIN_API_KEY` / `SCAN_CHAT_AI_API_KEY` は**ブラウザに出さない**。
- ブラウザが直接触れる外部 URL は **presigned URL 1 本だけ**（§5.2）。これは
  「特定の 1 オブジェクトに、決められた Content-Type と長さで、15 分だけ PUT できる」もので、鍵ではない。
- **Scan-Chat-AI 側 API 同士を HTTP で呼び合わない。** 既存処理の再利用は
  **共通 lib への切り出し**で行う（指示書 §13）。

### 4.2 なぜこの形か

- 既存の Elith バッチが**まさにこの形で動いている**（実測）:
  UI=`wellfort-site/src/pages/admin/elith-batch.astro` / 中継=`wellfort-site/src/pages/api/admin/elith-scan.ts`
  / 処理=`Scan-Chat-AI/src/pages/api/admin/elith-scan.ts`。**新しい形を発明しない。**
- `SCAN_CHAT_AI_API_KEY` を使う中継は wellfort-site に **10 本実在**（実測）。同じ規律に乗せる。

---

## 5. 入力 ZIP 仕様

### 5.1 受け入れるもの

| 項目 | 値 | 根拠 |
|---|---|---|
| 形式 | `application/zip`（`.zip`） | — |
| 上限サイズ | **512 MB**（`MAX_ZIP_BYTES`） | 指示書 §22「約160MB級」に対する余裕。**超過の検知は §5.2.1 の多層**（署名任せにしない） |
| 展開後の総容量上限 | **1.5 GB**（`MAX_TOTAL_UNCOMPRESSED`） | ZIP 爆弾対策 |
| ファイル数上限 | **2,000**（`MAX_ENTRIES`） | 同上 |
| 1 ファイル上限 | **80 MB**（`MAX_ENTRY_BYTES`） | Genoplan 208 ページ PDF を通す |
| ネスト深度上限 | **8**（`MAX_DEPTH`） | 同上 |
| 許可拡張子 | `.pdf` / `.xlsx` / `.docx` / `.csv` | 指示書 §2 の実構成 |

**`.xls`（旧 Excel 97-2003）は Phase 1 の解析対象から外す（v0.2 で明記）。**
`.xls` は **OLE2 複合ドキュメントで ZIP/XML ではない**（`.xlsx` とはファイル形式が別物）ため、
`.xlsx` の読み方をそのまま適用できない。**受入対象から外し、検出したら
`unsupported_file` として一覧に出す**（§5.5。黙って捨てない）。
Phase 1 で `.xls` を読む必要が出たら、§5.3 の選定と**同じ手順で別途決める**
（`.xlsx` 用に選んだライブラリが `.xls` も読めるとは限らない）。

### 5.2 ブラウザ → S3（presigned PUT・**Vercel を本体が通らない**）

**Vercel Functions のリクエストボディ上限は 4.5 MB**（出典: vercel.com/docs/functions/limitations
「Request body size」・2026-08-24 版。CLAUDE.md に実測記録あり）。ZIP 本体は関数を通せない。
`src/lib/scan-upload-ticket.ts` と**同じ考え方**で presigned PUT にする。

```
1. ブラウザ  → wellfort-site  POST /api/admin/ad-hoc-diagnosis/upload-ticket
                              { title, fileName, contentType, contentLength, sha256 }
2. wellfort-site（サーバ）→ Scan-Chat-AI  同名 API（Bearer SCAN_CHAT_AI_API_KEY）
3. Scan-Chat-AI → batch 行を作成（status=draft）＋ presigned PUT を発行
                  { batchId, url, key, headers, expiresIn }
4. wellfort-site → ブラウザへは **url / headers / expiresIn / batchId だけ**返す
                  （key も返してよいが、以後クライアントから key を受け取らない＝§24.2）
5. ブラウザ → S3 へ直接 PUT（Content-Type は署名対象。**サイズは §5.2.1 の多層で守る**）
6. ブラウザ → wellfort-site POST /api/admin/ad-hoc-diagnosis/{batchId}/classify
   → Scan-Chat-AI は**まず HeadObject で実サイズを検証**してから展開に入る（§5.2.1 ②）
```

**安全性（`/api/scan` で踏んだ罠と同型の対策）**

1. **キーはサーバが採番する。** クライアントは PUT 先を選べない。
2. 形は `{prefix}ad-hoc-uploads/{batch_id}/source.zip` に**完全一致**（`isAdHocZipKey`。部分一致にしない）。
3. `batch_id` は UUID v4（推測不能）。
4. **Content-Type（`application/zip`）を署名対象に含める。**
   **ContentLength が署名で固定されるかは未確認**（v0.3 で断定を撤回。§5.2.1）。
5. 期限 **15 分**（`PRESIGN_EXPIRES_SEC`）。
6. **`.json` を許可拡張子に入れない**（Elith 納品 JSON を読ませない・書かせないため）。

#### 5.2.1 サイズの防御は多層にする（v0.3・発注者指摘）

**v0.2 の「Content-Length も署名に固定され、違うサイズなら S3 自身が拒否する」は撤回する。**

**実測（`src/lib/scan-upload-ticket.ts`）**:
- `PutObjectCommand` に `ContentLength: bytes` を渡している（`:127`）。
- しかし `getSignedUrl` の第 3 引数は
  **`{ expiresIn, signableHeaders: new Set(['content-type']) }`**（`:129`）＝
  **明示している署名対象は `content-type` だけ**。
- クライアントへ返す `headers` も **`{ 'content-type': contentType }` のみ**（`:132`）で、
  **Content-Length を送れとは指示していない**（ブラウザが本文から自動で付ける）。
- 同ファイルのコメント（`:21-22` / `:127` / `:158`）は「ContentLength も署名に固定」と書いているが、
  **`signableHeaders` の実装と食い違っている。この文書はコメントを根拠にしない。**

→ **署名だけに頼らない。次の 3 層で守る。**

| 層 | いつ | 何をする | 効果 |
|---|---|---|---|
| **① ticket 発行時** | presigned URL を出す前 | クライアント申告の `contentLength` が `MAX_ZIP_BYTES`（§5.1）以下か検査。超えていれば**URL を出さない** | 明らかな超過をそもそも通さない |
| **② アップロード後** | `classify` の冒頭 | **S3 に `HeadObject` して実バイト数を見る**。`MAX_ZIP_BYTES` 超なら `413` でバッチを `failed` にし、**そのオブジェクトを削除する** | **申告と実物の食い違いをここで必ず捕まえる**（署名の挙動に依存しない） |
| **③ ZIP 解析時** | Central Directory 読取時と展開中 | 宣言値の合計が `MAX_TOTAL_UNCOMPRESSED` / `MAX_ENTRIES` / `MAX_ENTRY_BYTES` を超えたら中断。**展開中も実バイト数を数えて宣言値超過で中断**（§5.3.3-4） | 圧縮率の詐称（ZIP 爆弾）を止める |

**②が本命**。①はクライアント申告なので信用しない。③は「小さく見せかけた ZIP」への備え。

**保存も 2 列に分ける（v0.4・§23.1）。** ①の申告値は `declared_source_size`、
②の実測値は `source_size` に入れ、**混ぜない**。
batch 行が出来るのは ticket 発行時点で**まだ PUT が済んでいない**ため、
1 列にすると**申告値を実測値として保存する**ことになる。
②を通るまで `source_size` は **null（＝まだ確認していない）**。
先行例として `scan-upload-ticket.ts:158-161` が**読み出し側でもサイズを見ている**
（コメントは「署名で固定してあるが念のため」だが、**実際にはこちらが主防御**）。

**Phase D-0 または upload-ticket 実装時に実測して確定する 3 点**（§28.2-O9）:
1. `getSignedUrl` が返す URL の **`X-Amz-SignedHeaders` に `content-length` が入るか**。
2. **ブラウザの `fetch`/`XHR` で `Content-Length` を明示できるか**
   （fetch は禁止ヘッダ扱いで設定できない可能性がある。**未確認**）。
3. **申告と違うサイズの PUT を S3 が本当に拒否するか**（実際に試す）。

結果がどうであれ**②は残す**（署名で守れていたとしても二重で困らない）。

**置き場所（決定）**: Elith 用バケット `AWS_S3_BUCKET` の**一時領域** `{AWS_S3_PREFIX}ad-hoc-uploads/`。
- 理由: `scan-uploads/` が既に**同じバケットの一時領域**として運用されており（CLAUDE.md・2026-09-04 実測）、
  **CORS（`PUT` / `content-type`）が既に設定済み**なので AWS 側の追加作業が 1 つ減る。
- **納品物として置くのではない。** 指示書 §10「ZIP 内原本を Elith 納品バケットへ直接保存しない」は
  **納品セットとして置かない**という意味で受け取り、`user/{client_id}/date/...` の納品領域には一切書かない。
  一時領域と納品領域はパスで完全に分かれる。
- **原本用バケット（`AWS_S3_ORIGINALS_BUCKET`）には置かない。** あちらは 10 年保管・Object Lock
  （`docs/operations/S3原本ストレージ_構築手順書.md`）で、**PII を含む ZIP を置くと削除できなくなる**（§28-O2）。
- **【AWS 側の作業が 1 つ要る】** `ad-hoc-uploads/` のライフサイクル失効ルール（§24.4）。

### 5.3 ZIP / XLSX の読み方（**Phase D-0 で決定・v0.4**）

> **結論（2026-09-10・Phase D-0 実施）**
> - **ZIP = 案 L / [`@zip.js/zip.js`](https://www.npmjs.com/package/@zip.js/zip.js)**（ブラウザ・サーバ共通で 1 本）
> - **XLSX = 案 H / [`read-excel-file`](https://www.npmjs.com/package/read-excel-file)**（ZIP とは別に選ぶ）
> - **案 M（自作）は不採用。** ①②を満たすライブラリが実在したため（§5.3.4-4 の条件を満たさない）。
> - **SheetJS `xlsx`（および依存する `node-xlsx`）は採用不可。** 理由は §5.3.6。
>
> **v0.5 で足した 3 点（発注者指示 2026-09-10）**
> - **ブラウザの SHA-256 = [`@noble/hashes`](https://www.npmjs.com/package/@noble/hashes) の incremental API**
>   （`sha256.create()` → `update()` → `digest()`）。
>   **ZIP 全体を `arrayBuffer()` 化して `crypto.subtle.digest()` へ渡すのは禁止**（§11.6）。
> - **サーバ側の ZIP は custom `Reader` → AWS SDK `GetObjectCommand` の `Range`。
>   HTTP presigned GET は使わない**（§5.3.7.1）。
> - **`read-excel-file` は Scan-Chat-AI のサーバ側だけ**で使い、実物 XLSX で 5 点を実測する。
>   **判定できないカスタム日付書式を勝手に日付化しない**（§5.3.8.1）。
>
> 根拠はすべて **2026-09-10 に一次資料から実測**（`registry.npmjs.org` / `api.osv.dev` /
> 各プロジェクトの README・型定義）。**記憶で書いていない**（CLAUDE.md R2 / R3）。

> **【経緯・v0.2 で「自作」の決定を撤回】** v0.1 は「`package.json` にライブラリが 0 件だから自作」と書いたが、
> **依存が入っていないことは依存を足してはいけない根拠ではない**（発注者指摘 2026-09-10）。
> **医療関連データを扱うので、独自 ZIP parser を第一選択にしない。**
> → v0.2 で決定仕様から外し、**v0.4（Phase D-0）で実測比較して上記のとおり決めた**。
> **この方針は生きている**（自作を採らなかった理由がこれ）。以下 §5.3.1〜§5.3.4 は**そのときの比較の枠組み**で、
> 結果は §5.3.5 以降にある。

#### 5.3.1 比較する 3 案

| 案 | ZIP | XLSX |
|---|---|---|
| **案 L**（ライブラリ） | 既存ライブラリ | 既存ライブラリ |
| **案 H**（ハイブリッド） | 既存ライブラリ | 既存ライブラリ（ZIP とは別のもの可） |
| **案 M**（最小自作） | 自作 | 自作（ZIP 基盤を共用） |

※ 案 L と案 H は「同じライブラリで両方賄うか / 別々に選ぶか」の違い。
**候補ライブラリ名は挙げない**（実在・保守状況・ライセンス・脆弱性履歴を**引いてから**名指しする＝CLAUDE.md R2）。

#### 5.3.2 比較の観点（**この 8 つで評価する**）

| # | 観点 | 見るもの |
|---|---|---|
| 1 | **セキュリティ** | 既知の脆弱性履歴（Zip Slip・ZIP 爆弾・パス traversal）／**現在も保守されているか**（最終リリース日・未解決 issue）／依存の深さ（推移的依存の数＝攻撃面）／ライセンス |
| 2 | **メモリ** | **エントリ単位のストリーム読取ができるか**（全体をバッファに載せない API があるか）。§5.3.3 の要件を満たせるか |
| 3 | **ZIP64** | 4 GB 超・65,535 エントリ超の EOCD64 / Zip64 extra field に対応しているか（**512 MB 上限でも Zip64 で作られた ZIP は来得る**） |
| 4 | **data descriptor** | general purpose bit 3（サイズ・CRC が Local Header でなく後置される形式）を扱えるか。**ストリーム生成された ZIP で普通に出る** |
| 5 | **文字コード** | UTF-8 フラグ（bit 11）を見るか／立っていないときに CP932 を解釈できるか（§5.4） |
| 6 | **保守性** | 自作した場合に**誰が仕様追随の責任を持つか**。ライブラリなら更新を受け取れる |
| 7 | **Vercel 対応** | Node ランタイムで動くか／バンドルサイズ（関数サイズ上限）／ネイティブ依存の有無（**ネイティブ拡張は避ける**） |
| 8 | **XLSX の必要機能** | 共有文字列・inline string・**日付書式（`numFmt`）の判定**・1904 年方式・列順非依存の読み取りが**できるか**（§11.1 の要件） |

#### 5.3.3 案によらず満たすべき要件（**ここは決定仕様**）

1. **展開は Central Directory を正とする**（Local File Header だけを信用しない）。
2. **エントリ単位で読む。ZIP 全体を一度にメモリへ載せない。**
   - サーバ: S3 の **Range GET** で ①末尾（EOCD / Zip64 EOCD → Central Directory）
     ②必要なエントリの範囲だけ、を取得する。
   - ブラウザ: **`File.slice()` による部分読み**（§11.5）。
3. **§24.3 の ZIP security を、選んだ手段の外側でも自分で検査する。**
   ライブラリが守ってくれることを前提にしない（Zip Slip・絶対パス・symlink・
   総容量・エントリ数・1 ファイル容量・深度・拡張子・マジックバイト）。
4. **サイズ上限は展開前に Central Directory の宣言値で判定**し、
   **展開中も実バイト数を数えて宣言値を超えたら中断**する（宣言値の詐称対策）。
5. 対応しない圧縮方式は `unsupported_file` として**一覧に出す**（黙って捨てない）。

#### 5.3.4 決め方（Phase D 着手前・**v0.4 で実施済み**。結果は §5.3.5〜）

1. 候補ライブラリを**実在確認**（npm の最終公開日・ライセンス・既知脆弱性・推移的依存数）。
2. §5.3.2 の 8 観点で表を埋める。**埋まらない欄は「未確認」と書く**（推測で埋めない）。
3. **結果を本節に追記して「決定」に格上げし、そのうえで Phase D に入る。**
4. **既定の姿勢 = 案 L / 案 H を優先。案 M（自作）は、①②が満たせるライブラリが無い、
   または脆弱性・保守停止で採れない、と示せたときだけ採る。**

**現時点で確認できている環境事実（実測。案の優劣ではない）**:
`zlib.inflateRawSync` が使える（Node v22）／`DecompressionStream` が Node 側に存在する
（**ブラウザ実機は未確認**→§28-O4）／`TextDecoder('shift_jis')` が使える（§5.4）。

#### 5.3.5 Phase D-0 の実測結果（2026-09-10・一次資料）

**取得元**: `https://registry.npmjs.org/{pkg}`（最終公開日・ライセンス・依存・engines）/
`https://api.osv.dev/v1/query`（既知脆弱性）/ `https://api.npmjs.org/downloads/point/last-week`（週間 DL）/
各プロジェクトの README・`index.d.ts`（機能）。

**ZIP 候補（7 本）**

| ライブラリ | 最新 / 最終公開 | ライセンス | 直接依存 | 週間DL | 既知脆弱性（OSV） | 部分読み | ZIP64 | 文字コード | 判定 |
|---|---|---|---|---|---|---|---|---|---|
| **`@zip.js/zip.js` 2.14.0** | **2026-09-09** | BSD-3-Clause | **0** | 2.8M | **0 件** | **`BlobReader` / `HttpRangeReader` / 独自 `Reader` 実装可**（`index.d.ts:888,1006`） | あり（README） | **`filenameEncoding` + `decodeText` フック**（`index.d.ts:1652,1668`） | **採用** |
| `yauzl` 3.4.0 | 2026-06-07 | MIT | 1 | 27.1M | 1（MODERATE・`fixed<3.2.1` ＝最新は解消済） | `fromRandomAccessReader()` | あり（8PiB まで） | **CP437 / UTF-8 のみ**（README L112）。CP932 は `decodeStrings:false` で自前 | 次点（サーバ専用） |
| `node-stream-zip` 1.16.0 | 2026-07-22 | MIT | 0 | 2.9M | **0 件** | 「アーカイブ全体をメモリに載せない」（README L6） | あり（README L13） | `nameEncoding`（`TextDecoder` へ委譲・実装 L144） | 次点（**Node 専用・`fd` 前提**） |
| `unzipper` 0.12.5 | 2026-06-21 | MIT | **5**（`bluebird` ほか） | 11.6M | 1（MODERATE・`fixed<0.8.13`） | `Open.s3` / `Open.url` / `Open.custom`（Range ヘッダ・README L24,72） | 記載あり | — | 不採用（依存が重い） |
| `fflate` 0.8.3 | 2026-05-16 | MIT | 0 | 42.6M | 1（MODERATE・**ZIP64 の不正データで無限ループ**・`fixed<0.6.11`） | 非同期 API はあるが Central Directory 前提の部分読みではない | あり | — | 不採用（下記 `read-excel-file` の内部で間接利用） |
| `jszip` 3.10.2 | 2026-09-08 | MIT or GPL-3.0 | 4 | 23.6M | 2（`fixed<3.8.0` / `fixed<3.7.0`） | **全体をメモリに載せる設計** | — | — | **不採用**（§11.5 に反する） |
| `adm-zip` 0.6.0 | 2026-07-10 | MIT | 0 | 11.1M | **3（HIGH 1・うち 1 件は未修正）** | 全体メモリ | — | — | **不採用**（下記） |

**`adm-zip` を外した理由（決定的）**: `GHSA-vwc7-r8mq-g2x9`（展開先の symlink を辿って任意ファイル上書き）が
**`introduced=0.5.9 / last_affected=0.6.0` ＝ 現在の最新版がまだ影響下**で、**修正版が無い**。
加えて `GHSA-xcpc-8h2w-3j85`（HIGH・細工 ZIP で 4GB 確保）。設計も全体メモリ展開で §11.5 と両立しない。

**XLSX 候補（4 本）**

| ライブラリ | 最新 / 最終公開 | ライセンス | 直接依存 | 週間DL | 既知脆弱性 | 実行環境 | 判定 |
|---|---|---|---|---|---|---|---|
| **`read-excel-file` 9.3.10** | **2026-08-10** | MIT | 4（`saxen` / `fflate` / `worker-f` / `unzipper-esm`） | 1.1M | **0 件** | **ブラウザ・Node 両対応**（README L6）。値は `string`/`number`/`boolean`/**`Date`** で返る（L139） | **採用** |
| `exceljs` 4.4.0 | **2023-10-19（約 2 年停止）** | MIT | **9**（`jszip` / `archiver` / `tmp` / `fast-csv` ほか） | 8.0M | 1（MODERATE・`fixed<1.6.0`） | Node 中心 | 次点 |
| `xlsx`（SheetJS CE）0.18.5 | **2022-03-24** | Apache-2.0 | 7 | 6.7M | **5（HIGH 2・npm に修正版が無い）** | — | **採用不可**（§5.3.6） |
| `node-xlsx` 0.24.0 | 2024-04-15 | Apache-2.0 | 1（**`xlsx`**） | — | 自身は 0 件だが**上記を推移的に継承** | — | **採用不可** |

#### 5.3.6 SheetJS `xlsx` を採用できない理由（**この 1 点で確定**）

`GHSA-5pgg-2g8v-p4x9`（**HIGH**・ReDoS）の advisory 本文が、**npm には修正版が存在しないと明記している**:

> "SheetJS Community Edition before 0.20.2 is vulnerable to Regular Expression Denial of Service (ReDoS).
> **A non-vulnerable version cannot be found via npm**, as the repository hosted on GitHub and the npm package `xlsx` are n…"

- 実測: npm の `xlsx` は **0.18.5（2022-03-24）で止まっている**（総 171 版・以降の公開 0）。
- もう 1 件 `GHSA-4r6h-8v6p-xvw6`（**HIGH**・Prototype Pollution）は
  **"when reading specially crafted files"** ＝ **管理者が投入した XLSX を読む本機能そのものが該当**する。
  advisory は「ファイルを読まない用途（書き出しのみ）なら影響なし」としているが、**本機能は読む**。
- → **医療データを扱う経路に、修正版の無い HIGH を 2 件持ち込むことになる**ので採らない。
  `node-xlsx` は `xlsx` に依存するので**同じ理由で不可**。
- **回避策として SheetJS 公式 CDN（`cdn.sheetjs.com`）から入れる案も採らない** —
  ①CLAUDE.md の「標準スクリプトは追加依存なし方針」に対して npm 外の取得経路を増やす
  ②Vercel のビルドが外部 CDN に依存する ③本機能に必要な機能は他で足りる。

#### 5.3.7 なぜ ZIP に `@zip.js/zip.js` を選んだか

1. **ブラウザとサーバで同じ実装を使える**（`engines: node >=18` かつブラウザ向けが本来の出自）。
   本仕様は **ブラウザ側 `File.slice()` 部分読み（§11.5）** と **サーバ側 S3 Range GET（§5.3.3-2）**
   の**両方**が要る。`Reader` 基底クラス（`index.d.ts:888`）を継承すれば **S3 Range GET の Reader を自作して
   同じ `ZipReader` に食わせられる**ので、**ZIP の解釈は 1 本に統一できる**。
   → §24.3 のセキュリティ検査も **1 か所**で済む（2 実装だと片方に検査が抜ける）。
2. **`BlobReader`（`:958`）がブラウザの `File` をそのまま受ける** ＝ §11.5 の「全体を `ArrayBuffer` にしない」を
   ライブラリ側の設計として満たす。`HttpRangeReader`（`:1006`）も標準で在る。
3. **直接依存 0 ／ 既知脆弱性 0 ／ BSD-3-Clause ／ 最終公開 2026-09-09（総 365 版）** —
   §5.3.2-1（攻撃面・保守）で候補中もっとも良い。
4. **`filenameEncoding` と `decodeText` フック（`:1652,1668`）で CP932 を自分で解釈できる**（§5.4）。
   `yauzl` は仕様どおり **CP437 / UTF-8 しか解釈しない**（README L112）ので、
   日本語ファイル名は `decodeStrings:false` にして自前で decode する必要がある。
5. ネイティブ拡張なし・ESM/CJS 両方・型定義同梱（§5.3.2-7）。

**`yauzl` / `node-stream-zip` を次点として残す**（どちらもサーバ側だけなら十分）。
`@zip.js/zip.js` で実測上の問題が出たら**この 2 本のどちらかへ差し替える**
— そのために **ZIP を触るコードは `src/lib/ad-hoc-diagnosis/archive.ts` の内側にだけ置く**（§22）。

#### 5.3.8 なぜ XLSX を別に選んだか（案 H）

XLSX は実体が ZIP なので「`@zip.js/zip.js` で開いてシート XML を自前で読む」（案 M 相当）も成立するが、**採らない**。

- **理由 = 日付**。Excel はセルに**日付を数値（シリアル値）で持つ**ので、
  1900 年うるう年問題・`date1904` 方式・`numFmt` の判定を**自前でやると静かに間違える**。
  本仕様では `test_date` が **Elith 納品パス `date/{YYYY_MM_DD}`（§15）** と 🎯 照合の両方を決めるので、
  **1 日ずれても納品先が変わる**。**「捏造ゼロ／サイレント脱落ゼロ」より前に、値が合っていること**が要る。
- `read-excel-file` は **セル値を `Date` として返す**（README L139）ので、この判定をライブラリが持つ。
- **ブラウザ・Node 両対応**なので、`@zip.js/zip.js` と同じく**片側だけの実装にならない**。
- **既知脆弱性 0 件・MIT・最終公開 2026-08-10** と、§5.3.2-1 も満たす。

**採用にあたって記録しておく弱点（隠さない）**:
- **依存 4 本のうち 2 本（`unzipper-esm` / `worker-f`）が `read-excel-file` と同一の単独メンテナ**
  （`catamphetamine`・実測）。週間 DL は 73 万 / 50 万で無名ではないが、**供給網は 1 人に寄っている**。
- **v9 で API が変わっている**（既定 export の改名・`parseExcelDate` の削除・`type: Date` の扱い変更）＝
  活発だが**API は安定していない**。→ **呼び出しは `src/lib/ad-hoc-diagnosis/` のパーサ 1 枚に閉じ込める**。
- **XLSX の内側の ZIP は `read-excel-file` 側が読む**ので、§24.3 の検査は外側の ZIP にしか掛からない。
  → **XLSX 1 ファイルのサイズは外側の `MAX_ENTRY_BYTES`（80 MB）で既に上限が掛かっている**ことを
  受け入れ条件とする（無制限のものを渡さない）。
- **`exceljs` へ切り替える条件**: 健診 XLSX が `read-excel-file` で読めない構造だった場合
  （結合セルをまたぐ見出し・複数シートの書式依存など）。**その場合も `xlsx` には戻らない。**

#### 5.3.7.1 サーバ側は custom `Reader` を AWS SDK の Range GET へ繋ぐ（v0.5・発注者指示・**決定**）

**【禁止】サーバ側で HTTP presigned GET を使うこと。** `HttpRangeReader` は使わない。

**理由**: presigned GET を出すと ①**署名付き URL という新しい秘密**が増える
（発行・期限・漏洩の管理が要る） ②Vercel → S3 が**素の HTTP 経由**になり、
既存の資格情報（`AWS_ACCESS_KEY_ID` ほか・CLAUDE.md）で完結する経路から外れる
③CLAUDE.md の「バケットの `GET` を CORS に足さない」と紛らわしくなる。
**サーバ側は SDK でそのまま読めるので、URL を作る理由が無い。**

**採る形 = `@zip.js/zip.js` の `Reader` を継承し、`readUint8Array(offset, length)` の中で
AWS SDK の `GetObjectCommand` に `Range` を付けて呼ぶ。**

```ts
// Scan-Chat-AI: src/lib/ad-hoc-diagnosis/archive.ts（ZIP を触るのはこの中だけ・§5.3.7-5）
class S3RangeReader extends Reader<string /* key */> {
  size!: number;                       // init() で HeadObject の ContentLength を入れる
  async init() { /* HeadObjectCommand → this.size */ }
  async readUint8Array(offset: number, length: number): Promise<Uint8Array> {
    const end = offset + length - 1;   // HTTP Range は「両端を含む」
    const res = await client.send(new GetObjectCommand({
      Bucket, Key: this.key, Range: `bytes=${offset}-${end}`,
    }));
    return await res.Body!.transformToByteArray();
  }
}
```

- **`Range` は両端を含む閉区間**（`bytes=0-99` は 100 バイト）。**`offset + length` をそのまま
  終端に書くと 1 バイト多い範囲を取りに行く。**
  - **【v0.5.1 で訂正・実測 2026-09-10】** ここは当初「Central Directory の解釈がずれる」と書いたが、
    **実測すると 1 バイト多く返しても `@zip.js/zip.js` は壊れなかった**
    （要求した長さぶんしか使わないため）。**つまりライブラリは守ってくれない** —
    症状が出ないまま「思っている範囲と実際に取る範囲が静かにずれる」だけになる。
  - → **ずれを捕まえるのはこちらの責任**。`readUint8Array` は
    **返却バイト数が要求とちょうど同じでなければ投げる**（`assertExactLength`）。
    **短い側だけでなく長い側も投げる** — 長い側を見逃すと閉区間の取り違えが誰にも気づかれない。
  - 算術は純粋関数 `rangeHeaderFor(offset, length)` に切り出して**検証で直接固定する**
    （ZIP を組んで通すだけでは、上のとおり退行が素通りする）。
- `transformToByteArray()` は**既存コードと同じ読み方**
  （`scan-upload-ticket.ts:164` の `fetchScanUpload` が同じ形）＝**新しい流儀を持ち込まない**。
- **`ZipReader` はブラウザ側と同じ**。差し替わるのは `Reader` の実装だけなので、
  §24.3 の ZIP security 検査は**1 か所のまま**（§5.3.7-1 の狙いがここで効く）。
- **`size` は `HeadObject` の `ContentLength`**。これは §5.2.1 ② で
  `source_size` を確定させるのと**同じ呼び出しでよい**（2 度叩かない）。
- **範囲外・欠損の扱い**: S3 が `416` を返す / 返却バイト数が要求と違う場合は
  **黙って返さない**（短ければ ZIP パーサが壊れた構造として誤解釈し、長ければ範囲の取り違えを見逃す）。
  例外にしてバッチを `failed` にする。

#### 5.3.8.1 `read-excel-file` は Scan-Chat-AI のサーバ側だけで使う（v0.5・発注者指示）

**ブラウザ側（wellfort-site）では使わない。** ブラウザが触るのは
**ZIP の部分読み（`@zip.js/zip.js`）／SHA-256（`@noble/hashes`）／PDF のページ画像化（pdf.js）**
の 3 つだけで、**XLSX の解釈はサーバへ寄せる**（§4 の責務境界どおり・検査値の解釈を 2 か所に置かない）。

**実物の XLSX で必ず実測する 5 点（Phase D の入口・§5.3.9 の 4 を具体化）**

| # | 見るもの | なぜ |
|---|---|---|
| 1 | **Excel の日付** | シリアル値が `Date` として返るか。**`test_date` は納品パス `date/{YYYY_MM_DD}`（§15）と 🎯 照合の両方を決める** |
| 2 | **カスタム日付書式** | `numFmt` が組み込みでなくユーザー定義（`yyyy"年"m"月"d"日"` 等）のとき、日付と判定できるか |
| 3 | **1900 / 1904 date system** | ブックが 1904 方式だと**全日付が 4 年ずれる**。どちらで解釈しているか |
| 4 | **空欄と 0** | 空欄が `null`/`undefined`/`''` のどれで来るか、**0 と空欄が区別できるか**（区別できないと「未実施」と「値 0」が混ざる＝§5 の捏造ゼロに直結） |
| 5 | **日本語ヘッダー** | 見出しの文字化け・全角空白・改行が入った見出しをどう返すか |

**【重要】カスタム日付書式は自動判定できない場合がある。判定できないものを勝手に日付化しない（発注者指示）。**

- ライブラリが `Date` を返した → **そのまま採る**。
- ライブラリが**数値のまま返した** → **こちらでシリアル値を日付へ変換しない。**
  数値のまま持ち、その項目は **`needs_review`** にして**管理者に確認させる**。
  - 理由: シリアル値を日付に変換するには **1900/1904 のどちらか**を決める必要があり、
    ブックの設定を読まずに決めれば**4 年ずれた日付を静かに作る**ことになる＝捏造。
  - **`test_date` が確定しない人物は納品しない**（§15 のパスが決まらないため）。
    **黙って今日の日付や別ファイルの日付を流用しない。**
#### 5.3.8.2 5 点の実測結果（**Phase D で実施・2026-09-10**）

**実物のサンプル ZIP はまだ無い**ので、**こちらで組んだ実物の `.xlsx`** に
`read-excel-file` 9.3.10 を通して測った（`scripts/lib/make-test-xlsx.mjs` が
最小の OOXML を組む。**バイナリは commit しない**・個人情報は 1 文字も入れない）。
**実物の健診 XLSX（39 列）での確認は投入時**に別途行う（§0 の但し書きと同じ）。

| # | 見たもの | 実測 | 帰結 |
|---|---|---|---|
| 1 | **Excel の日付**（組み込み書式 `numFmtId=14`） | **`Date` インスタンスで返る** | そのまま採れる |
| 2 | **カスタム日付書式**（ユーザー定義 `numFmtId=176`・`yyyy"年"m"月"d"日"`） | **`Date` で返る**（書式コードの日付トークンを見ている） | そのまま採れる |
| 3 | **1900 / 1904 date system** | **`workbookPr date1904="1"` を honour する。** 1904 方式のシリアル値を入れても**同じ日付**になった | **ライブラリに任せる。自前で変換しない** |
| 4 | **空欄と 0** | 空欄 = **`null`** / 0 = **`number: 0`** = **区別できる** | 「未実施」に 0 を入れずに済む |
| 5 | **日本語ヘッダー** | **化けない**（`健診日` / `身長(cm)` がそのまま） | 見出しは名前で引ける |

**あわせて分かった 2 件（設計の根拠になったもの）**

- **書式の無い数値は `Date` にならず `number` のまま返る。**
  → **これが「勝手に日付化しない」を適用する対象**。実測で `46110` は `number` のまま来た。
- **同じシリアル値 `46110` は 1900 方式で `2026-03-29` / 1904 方式で `2030-03-31`。**
  → **決め打ちで変換すると約 4 年ずれる**ことを実測で確認した（回帰チェックに固定してある）。
  **これが「判定できないものを日付化しない」の具体的な根拠。**

**v9 の API で踏んだもの（版が変わると黙って壊れる箇所）**

- **既定 export は「シートの配列」を返す**（`Sheet[] = { sheet, data }[]`。
  実測 `node_modules/read-excel-file/types/Sheet.d.ts`）。**行の配列ではない**（v8 以前は行だった）。
- **シート番号を決め打ちしない。** 健診ブックの 1 枚目が表紙のことがあるので、
  **全シートを §7.2 の見出し一致数で採点して選ぶ**。回帰チェックは
  **1 枚目を表紙にした XLSX** で「決め打ちしていたら落ちる」形にしてある。

**呼び出しは `src/lib/ad-hoc-diagnosis/health-checkup-xlsx.ts` の
`readHealthCheckupXlsx()` 1 か所に閉じ込める**（§5.3.8 の弱点対策）。

#### 5.3.9 Phase D で実測して確かめること（**まだ未確認**）

**ライブラリを選んだだけで、動かして確かめてはいない。** 次を Phase D の最初に実測する。

1. ~~**Vercel の Node ランタイムで `TextDecoder('cp932' / 'shift_jis')` が使えるか**~~ →
   **決着（§5.4）。`'cp932'` はそもそも WHATWG のラベルではなく投げる**（実測）。
   `'shift_jis'` を使い、**実行時に probe して駄目なら既定に委ねる**ので、
   **もう実行環境の測定に依存しない**。
2. **ブラウザ実機で `BlobReader` が本当に部分読みになるか**（ピークメモリを実測・§11.5 / §28-O4）。
3. **S3 Range GET を `Reader` として実装したときの往復回数と所要時間**（512 MB の ZIP で）。
   実装の形は **§5.3.7.1 で決定済み**（custom `Reader` → `GetObjectCommand` の `Range`。
   **presigned GET は使わない**）。ここで測るのは往復回数と時間だけ。
4. ~~**`read-excel-file` が実物の健診 XLSX（39 列）を読めるか**~~ →
   **§5.3.8.1 の 5 点は実測済み（§5.3.8.2）。** こちらで組んだ実物の `.xlsx` で
   1〜5 とも確認し、回帰チェックに固定した（`npm run verify:ad-hoc-parse`）。
   **残るのは実物の健診 XLSX（39 列）での確認だけ**で、これは**投入時**（§0 の但し書きと同じ）。
5. **バンドルサイズが Vercel の関数サイズ上限に収まるか**（§5.3.2-7）。
6. **ブラウザの逐次 SHA-256（§11.6）が `crypto.subtle.digest()` と同値になるか**、
   および**ピークメモリが chunk 1 個ぶんの桁に収まるか**。

### 5.4 ファイル名の文字コード

ZIP の general purpose bit 11（UTF-8 フラグ）を見る。
- 立っていれば UTF-8。
- 立っていなければ **`TextDecoder('shift_jis')`**（Windows 製 ZIP の日本語名。実測: Node v22 / full ICU で `shift_jis` 実在・`日本` を正しく復号）。
- どちらでも復号できない場合は**推測しない**。`needs_review` にして**バイト列の hex** を表示する。

**【実測 2026-09-10・§5.3.9-1 の答え】`'cp932'` は WHATWG Encoding Standard のラベルではない。**
`new TextDecoder('cp932')` は **`ERR_ENCODING_NOT_SUPPORTED` を投げる**（Node v22.22.2・full-icu）。
しかも **`@zip.js/zip.js` は `getEntries()` の中で decode する**ので、
**投げた瞬間に ZIP を開くこと自体が失敗する**（文字化けで済まない）。

| ラベル | この環境 | 解決先 |
|---|---|---|
| `shift_jis` / `windows-31j` / `ms932` / `sjis` / `x-sjis` | **OK** | いずれも `shift_jis` |
| `euc-jp` / `iso-2022-jp` | OK | そのまま |
| **`cp932`** / `cp437` | **NG（投げる）** | — |

- WHATWG の `shift_jis` デコーダは **Windows-31J（= CP932）の割り当てを含む**ので、
  **`shift_jis` を選べば目的は果たせる**。
- 実装は `pickFilenameEncoding()`（`archive.ts`）で
  **候補を順に `new TextDecoder()` して、作れたものを使う**。
  **どれも作れなければ `undefined` を返してライブラリ既定に委ねる** —
  ICU の無い環境でも**開けなくなることはない**（ファイル名は化けるが、
  **パスは DB に保存しない**ので納品には影響しない・§6.1）。
- **Vercel の実行環境では未測定**だが、**この実装は測定結果に依存しない**
  （実行時に probe するため）。

### 5.5 常に無視するもの

| 対象 | 扱い | 根拠 |
|---|---|---|
| `~$*`（Excel 一時ファイル） | **常に無視**（一覧にも出さない） | 指示書 §2 |
| `__MACOSX/` 配下・`.DS_Store` | 無視 | 一般的な ZIP のごみ |
| ディレクトリエントリ | 無視（構造の把握にのみ使う） | — |
| サイズ 0 のファイル | `unsupported_file` として一覧に出す（黙って捨てない） | 指示書 §22 |
| **`.xls`（旧 Excel 97-2003）** | **`unsupported_file` として一覧に出す**（人物へは割り当てるが解析しない） | §5.1。OLE2 複合ドキュメントで ZIP/XML ではない |
| 許可拡張子以外 | 同上 | §5.1 |

### 5.6 ZIP 直下の参考資料

ZIP 直下（人物フォルダの外）にあるファイルは **`batch_reference`** として扱い、
**どの人物にも自動割当しない**（指示書 §2）。

- `10名の情報.xlsx` … **人物識別の正として使わない**（サンプルでは氏名セルが空。指示書 §2）。
  `実施日` 列も**どの検査日か未確定**なので、`test_date` へ自動転用しない（§14.4）。
- `問診サイト.docx` … 参考資料。解析しない。

---

## 6. 人物単位の識別仕様

**ZIP 直下の「人物フォルダ」を第一の人物境界**とする（指示書 §6）。

1. ZIP 直下のディレクトリを人物候補として検出する。**フォルダ 1 つ = 被験者 1 人**。
2. 各人物フォルダに**新規 UUID v4 の `client_id`** を発番する（§13）。
3. **ファイル名中の番号・Excel 内部 ID・フォルダ名の番号を `client_id` に使わない。**
   指示書 §2 に「人物フォルダ番号と問診ファイル名中の番号は一致しないケースがある」と明記されている。
4. 氏名は**異なる資料間の整合チェックにのみ**使う。
5. 氏名は照合後に**納品 JSON・S3 key へ一切残さない**（§8）。
6. 生年月日は **age 算出にのみ**使い、納品 JSON へ DOB を出さない。
7. 社員番号も納品 JSON へ出さない。
8. 同一フォルダ内で氏名／生年月日が食い違う場合、**自動確定しない**。
9. 食い違いは **`identity_status = 'needs_review'`** とし、管理者が判断する。

### 6.1 保存するもの（PII を持たない）

`ad_hoc_diagnosis_subjects` に持つのは以下だけ（§23）。

| 列 | 内容 |
|---|---|
| `subject_no` | 画面表示用の連番（`No.01` …）。**フォルダ名そのものは保存しない**（採番規則は §6.2.2） |
| `subject_fp` | **内容由来の非可逆 fingerprint**（§6.2.1）。再開時の**照合用の検索キー**（**一意識別子ではない**・§6.2.5.1）。材料はファイルの content SHA-256 だけで、**氏名・フォルダ名・ファイル名を含まない** |
| `subject_fp_source` | `auto` / `manual`（分類を手で直したか。§6.2.4） |
| `client_id` | 採番した UUID |
| `identity_status` | `confirmed` / `needs_review` / `unresolved` |
| `identity_reason` | 食い違いの**種類**だけ（例 `dob_mismatch:2`）。**値そのものは書かない** |
| `sex` | `male` / `female` / `unknown` |
| `age` | 整数（DOB から算出した結果のみ） |

**氏名・生年月日・社員番号・メールは DB に保存しない。** 照合は展開直後のメモリ内でのみ行う。
長期保存が必要と判断された場合は、既存の PII データ設計（`customer` スキーマ）を確認したうえで
別途決めること。**`diagnosis` スキーマへ無断で追加しない**（CLAUDE.md「PII / データ分離」）。

### 6.2 再開時に「この人物 = この client_id」を取り違えない仕組み（v0.2 で追加）

**問題**: 氏名もフォルダ名も保存しないので、ブラウザ再読込 → ZIP 再選択のあと
**「いま画面に出ている人物」と「DB の `client_id`」を結び直す手がかりが無い**。
`subject_no`（表示連番）だけで結ぶと、**分類を修正した回や ZIP が別物だった回に静かに入れ替わる**。

**採る形 = 内容由来の非可逆 fingerprint で結び直す。**

#### 6.2.1 `subject_fp` の定義（**原文を一切保存しない**）

```
subject_fp = SHA-256(  そのフォルダに属するファイルの content SHA-256 を
                       16 進小文字で昇順ソートし、"\n" で連結した文字列  )
```

- 材料は **ファイルの中身のハッシュだけ**。
  **フォルダ名・ファイル名・氏名・生年月日を一切使わない**ので、
  **平文の PII は含まない**（原像に氏名等が無いため、辞書攻撃で氏名に戻す経路が無い）。
  秘密鍵（HMAC）も要らない。
- **ただし「安全な値」として扱わない（v0.4・発注者指摘）。** `subject_fp` は
  **特定の個人の検査ファイル群に 1 対 1 で対応する照合用識別子**なので、
  **機微情報と同等に扱う** — ログに出さない / 外部へ渡さない / 納品 JSON に載せない /
  画面に出すときも先頭数文字に留める。
  （元の ZIP を持っている者にとっては「どの人物の行か」を突き合わせられる値である。）
- 材料の `sha256` は **`ad_hoc_diagnosis_files.sha256` として既に保存する値**（§23.3）＝新しい保存物を増やさない。
- **昇順ソート**するので、ZIP のエントリ順や読み取り順が変わっても同じ値になる。
- 同じ ZIP を選び直せば**バイトが同じ＝必ず同じ値**になる。

#### 6.2.2 `subject_no`（表示連番）の決め方

**Central Directory の出現順**で採番する（`No.01` …）。
同じ ZIP なら Central Directory の並びも同じなので**再選択で同じ番号になる**。
**フォルダ名は保存しないが、順番を決めるのに一度使うだけなら原文を残す必要がない。**
`subject_no` は**表示のためだけ**に使い、**結び直しには使わない**（§6.2.3）。

#### 6.2.3 再開の手順（**推測で結ばない**）

1. **まず ZIP が同一か確認する。** 再選択された ZIP の SHA-256 が
   `ad_hoc_diagnosis_batches.source_sha256` と一致しなければ、**そこで止める**
   （「このバッチとは別の ZIP です」と出す。**別 ZIP を同じバッチの続きとして扱わない**）。
2. 一致したら、Central Directory と各エントリから `subject_fp` を**計算し直す**。
3. `(batch_id, subject_fp)` で `ad_hoc_diagnosis_subjects` を引き、**ヒット件数で判定する**
   （v0.3 で明確化。**`subject_fp` は一意ではない** = §6.2.5）。

   | ヒット件数 | 判定 | 動作 |
   |---|---|---|
   | **0 件** | `unmatched` | **推測で近い人物へ寄せない。** `identity_status = 'needs_review'`（`identity_reason = 'unmatched'`）にして**「DB 上のどの人物にも一致しませんでした」**と出し、管理者が判断する |
   | **1 件** | `match` | その行の `client_id` を使う。**これが唯一の自動結び直し経路** |
   | **2 件以上** | `fp_collision` | **該当する subject を全件** `identity_status = 'needs_review'`（`identity_reason = 'fp_collision'`）にする。**どれか 1 つを自動で選ばない** |

4. **DB 側に在るのに再計算側に現れなかった人物**も同じく画面に出す（黙って消さない）。

#### 6.2.4 分類を修正したとき

管理者が STEP 2 でファイルの人物割り当てを直すと、その人物の**ファイル集合が変わる＝`subject_fp` も変わる**。

- **編集の時点で `subject_fp` を再計算して更新する**（`client_id` は変えない）。
  → 以後の再開は**編集後の fp** で引ける。
- `subject_fp_source` に `auto` / `manual` を持ち、**手で動かした人物が分かる**ようにする（§21 の監査にも残す）。

#### 6.2.5 衝突と例外

| 事象 | 扱い |
|---|---|
| 同一バッチ内で `subject_fp` が衝突（**ファイル集合がバイト単位で完全一致する 2 人**） | **仕様上あり得ることとして認める**（v0.3）。`subject_fp` に UNIQUE 制約は**置かない**（§6.2.5.1）。再開時のヒットが 2 件以上になった場合、**該当 subject を全件 `needs_review`**（`identity_reason = 'fp_collision'`）にする。**自動で片方に寄せない** |
| 人物フォルダにファイルが 0 件 | `subject_fp` を作れない → `identity_status = 'unresolved'`。人物として立てるが処理対象にしない |
| ZIP が壊れて一部エントリを読めない | その人物の fp が変わるので**ヒットしない** → §6.2.3-3 の `needs_review` に落ちる（**誤って別人へ結ばない**） |

##### 6.2.5.1 なぜ `UNIQUE (batch_id, subject_fp)` を置かないか（v0.3・発注者指示）

v0.2 は `UNIQUE (batch_id, subject_fp)` を置いていたが、**同じ節の「衝突したら両方を
`needs_review` として残す」と矛盾していた** — UNIQUE があると
**2 人目の INSERT がそもそも失敗し、「両方残す」が実行できない**。

→ **`subject_fp` は「再開時の照合用の検索キー」であって一意識別子ではない**、と位置づけを確定する。
**同一 fp が複数人物に存在し得ることを仕様として認める。**

```sql
-- 一意制約ではなく通常 INDEX
CREATE INDEX ... ON diagnosis.ad_hoc_diagnosis_subjects (batch_id, subject_fp);
```

- 衝突は**制約で防ぐのではなく、検索件数で検出して管理者へ出す**（§6.2.3 の表）。
- **`subject_no` は表示用だが、同一バッチ内で重複させる意味が無いので
  `UNIQUE (batch_id, subject_no)` は維持する。**

#### 6.2.6 ブラウザ側

- ブラウザは「画面の人物 ↔ `client_id`」を**メモリにしか持たない**。
- 再選択のたびに §6.2.3 で**サーバから結び直してもらう**。
  **ブラウザが覚えていた対応関係を再利用しない**（古い対応で上書きする事故を構造的に防ぐ）。
- **`localStorage` / `sessionStorage` / IndexedDB に人物の対応を保存しない**（PII の残留を作らない）。

#### 6.2.7 検証（§25.2）

- 同じ ZIP を 2 回読ませて **`subject_fp` が完全一致**すること。
- **エントリ順を入れ替えた同内容の ZIP** でも一致すること（昇順ソートが効いている）。
- **1 バイト違う ZIP** では `source_sha256` の段階で止まること。
- **1 ファイルだけ人物間で入れ替えた ZIP** で、両方が `needs_review` になり
  **どちらの `client_id` も別人へ付け替わらない**こと。
- **fp が同じ subject を 2 行 INSERT できること**（UNIQUE を置き直す退行で落ちる）。
  そのうえで再開時に**2 件ヒット → 全件 `fp_collision`** になること。
- ヒット **0 件**で `unmatched`・**1 件**で `match` になること（境界を 3 通りとも通す）。
- **`subject_fp` の材料に氏名・フォルダ名・ファイル名が混ざっていないこと**
  （混ぜる実装を注入すると落ちる形で固定する）。

---

## 7. ファイル分類仕様

**ファイル名だけに依存しない。** 拡張子・ファイル内容・ヘッダー・PDF 内テキストを組み合わせる。

### 7.1 判定の順序（決定論・上から評価）

| # | 条件 | 分類 | 信頼度 |
|---|---|---|---|
| 1 | `~$` 始まり / `__MACOSX` / `.DS_Store` | `ignored` | — |
| 2 | 人物フォルダの外にある | `batch_reference` | `confirmed` |
| 3 | `.xlsx` かつ **健診ヘッダ群**が閾値以上一致（§7.2） | `HealthCheckupData`（構造化元） | `confirmed` |
| 4 | `.xlsx` かつ **問診ヘッダ群**が閾値以上一致（§7.3） | `LifestyleQuestionnaireData` | `confirmed` |
| 5 | `.pdf` かつ **Genoplan 識別要素**あり（§7.4） | `GeneticTestResultData` | `confirmed` |
| 6 | `.pdf` かつ 健診語彙が閾値以上 | `HealthCheckupData`（原票 or 構造化元） | `probable` |
| 7 | `.pdf` かつ 問診語彙が閾値以上 | `LifestyleQuestionnaireData` | `probable` |
| 8 | 上記いずれにも当たらない | `needs_review` | `needs_review` |

- **信頼度は 3 値**: `confirmed` / `probable` / `needs_review`。
- **誤分類は管理者が画面で修正できる**（§17 STEP 2）。修正した事実は監査に残す（§21）。
- **`probable` / `needs_review` が 1 件でもある人物は、管理者が確認するまで `ready` にしない。**

### 7.2 健診 XLSX の判定

指示書 §2 の代表 39 列のうち、次の**ヘッダー名が 6 件中 4 件以上**あれば健診とみなす。

`健診日` / `身長` / `体重` / `BMI` / `収縮期血圧` / `拡張期血圧`

- **ヘッダー行は 1 行目固定にしない**（先頭 10 行を走査して最も一致数の多い行をヘッダーとする）。
- **列順に依存しない**（名前で引く）。
- **XLSX は LLM へ送らない。決定論 parser で読む**（指示書 §7）。

### 7.3 問診 XLSX の判定

指示書 §2 の代表 62 列のうち、次の**語が 3 件以上**ヘッダーにあれば問診とみなす。

`既往歴` / `喫煙` / `飲酒` / `食事` / `運動` / `睡眠` / `ストレス`

### 7.4 Genoplan PDF の判定

- 拡張子が `.pdf`。
- **PDF 内部に Genoplan / ジェノプラン の識別要素**がある（テキスト抽出できる場合）。
- ファイル名が Genoplan の検査キー形式（`XXXX-XXXX-XXXX.pdf`。
  `wellfort_admin_lab_upload_spec.md` 付録 A-3）に一致する。
- **①②のどちらかだけでは `probable`**。両方そろって `confirmed`。

分類後の処理は**既存経路をそのまま使う**（指示書 §7）:
`src/lib/elith-genetic.ts` の `scanGeneticPage` と、`elith-genetic-merge.ts` の part/finalize 構造。
**新しい遺伝子 OCR / LLM プロンプトを作らない。**

---

## 8. PII 取扱

| データ | 変換時に使う | DB に保存 | 納品 JSON | S3 key | ログ |
|---|---|---|---|---|---|
| 氏名 | ○（整合チェックのみ） | **×** | **×** | **×** | **×** |
| 生年月日 | ○（age 算出のみ） | **×** | **×** | **×** | **×** |
| 社員番号 | ○（同一人物性の補助） | **×** | **×** | **×** | **×** |
| 性別 | ○ | ○ | ○（`subject.sex`） | × | × |
| 年齢 | ○ | ○ | ○（`subject.age`） | × | × |
| 元ファイル名 | ○ | **正規化して保存**（§8.1） | × | **×** | × |

### 8.1 元ファイル名の扱い

ユーザー提供のファイル名には**氏名が含まれ得る**（指示書 §10）。

- **S3 key に元ファイル名を入れない。** key は `{batch_id}/files/{file_id}.{ext}` で採番する。
- DB には `display_name` として保存するが、**氏名らしき部分をマスクした形**にする
  （`原ファイル名` そのままは保存しない）。画面には `display_name` を出す。
- **マスクの規則を「氏名らしさの推測」に依存させない**: 保存するのは
  `{分類}_{連番}{拡張子}`（例 `健診_01.xlsx`）とし、**元の文字列は保存しない**のが既定。
  「元のファイル名が分からないと現場が困る」場合は §28-O3 で判断する。

### 8.2 masking

Elith へ渡す JSON の PII 規則は `docs/elith/elith_masking_definition.md` に従う。
本機能で新しいマスキング規則を作らない。

---

## 9. 原本保存仕様

**新規方式を作らない。** 既存 `src/lib/originals-storage.ts` の `putOriginal()` を再利用する（指示書 §10）。

ただし**保存の可否そのものが未確定**なので、Phase 1 では次のとおりにする。

| 対象 | 置き場所 | 保持 | Phase 1 の既定 |
|---|---|---|---|
| ZIP 本体 | `{AWS_S3_PREFIX}ad-hoc-uploads/{batch_id}/source.zip` | **ライフサイクルで失効**（§24.4） | 置く |
| 展開後の個別ファイル | `{AWS_S3_PREFIX}ad-hoc-uploads/{batch_id}/files/{file_id}.{ext}` | 同上 | 置く |
| 長期原本（10 年保管） | `putOriginal()`（`AWS_S3_ORIGINALS_BUCKET`） | Versioning + Object Lock | **保存しない**（`retain_originals=false` 既定） |

**なぜ長期保存を既定 off にするか**: 原本用バケットは 10 年保管・削除不可の設計
（`docs/operations/S3原本ストレージ_構築手順書.md`）。**氏名・生年月日を含む臨時案件のファイルを
そこへ入れると、後から消せない。** 契約顧客の検査原本とは保管要件が同じとは限らないので、
**発注者の判断（§28-O2）を受けてから on にする**。受け皿（`retain_originals` 列と分岐）は用意しておく。

---

## 10. 一時状態・ジョブ状態管理

### 10.1 なぜ DB に持つか

- Genoplan PDF は**約 208〜210 ページ/人 × 10 名**（指示書 §2/§11）。
- **ZIP 全体を 1 リクエストで処理してはいけない**（指示書 §11）。
- **ブラウザを再読込しても状態が戻る**ことが受入条件（指示書 §26-17）。

→ 進捗は**サーバ側 DB に置く**。既存 `diagnosis.scan_jobs`
（`supabase/migrations/20260910000010_scan_jobs.sql`）と同じ考え方を踏襲する
（**確定した検査 1 件 = `test_artifacts`、途中経過 = 別表**）。

### 10.2 粒度

| 単位 | 行 | 再開できること |
|---|---|---|
| バッチ | `ad_hoc_diagnosis_batches` | 状態・確定・書出しの各段 |
| 人物 | `ad_hoc_diagnosis_subjects` | 人物単位の ready 判定 |
| ファイル | `ad_hoc_diagnosis_files` | 解析済み／失敗のファイルを飛ばす |
| ページ | `ad_hoc_diagnosis_pages` | **成功済みページを毎回 LLM に再送しない** |

- **1 件失敗で 10 名全体を破棄しない**（指示書 §11）。
- **成功済みページを毎回再 LLM 処理しない**（同）。キーは `(file_sha256, page_no)`（§19.3）。

---

## 11. 変換仕様

### 11.1 健診 XLSX → `HealthCheckupData`

**構成**: 「シートを読む層」＋ `src/lib/health-checkup-xlsx.ts`（写像）。
**シートを読む層の実現手段は §5.3 で決定済み（`read-excel-file`・v0.4）。**
呼び出しは `src/lib/ad-hoc-diagnosis/` のパーサ 1 枚に閉じ込め、ライブラリの API を画面や API 層へ漏らさない（§5.3.8）。
どちらになっても**写像側のインターフェースは変えない**ように、
`readSheet(bytes) → { headers: string[]; rows: Cell[][] }` の形で切っておく。

**XLSX の読み方に求める機能（**手段によらず必要**・§5.3.2 の観点 8）**
- 読む対象: `xl/workbook.xml`（シート名・`r:id`・`date1904` フラグ）/ `xl/_rels/workbook.xml.rels` /
  `xl/sharedStrings.xml` / `xl/worksheets/sheet*.xml` / `xl/styles.xml`（`numFmt` の日付判定）。
- セル型: `t="s"`（共有文字列）/ `t="inlineStr"` / `t="str"` / `t="b"` / 既定（数値）。
- **日付**: 数値セルのうち、`s`（style index）→ `cellXfs` → `numFmtId` が日付書式なら**シリアル値→日付**へ。
  1900 年方式の**うるう年バグ（1900-02-29 が存在する）**を織り込む。`date1904` が真なら 1904 年方式。
  文字列日付（`2026/03/29` 等）も受ける。**Excel 日付型 / 文字列日付型の両方に対応**（指示書 §15）。
- **`.xls`（旧形式）は対象外**（§5.1）。

**写像の要件（指示書 §15）**
- **PII 列（社員番号・漢字氏名・生年月日）を `measurements` に混入させない。** 変換時のみ利用する。
- 数値変換する。**単位は保持**する。
- **空欄は行を作らない。`0` と空欄を区別する**（`0` は実測値、空欄は未実施）。
- **列順に依存しない**（名前で引く）。**列追加に強い**（未知列は落とすだけで壊れない）。
- **未知列を勝手に診断項目化しない**（捏造ゼロ）。未知列は監査に件数だけ出す。
- 出力は既存 `HealthCheckupData` の共通エンベロープに合わせる。
  整形は必ず **`sanitizeMeasurementsForDelivery()`**（`src/lib/elith-export.ts:467`）を通す
  ——「納品整形は決定論プログラムに集約」（CLAUDE.md）。**ここで二重管理しない。**

### 11.2 健診 PDF → `HealthCheckupData`

- **同一人物に健診 XLSX があるなら、PDF は原票（証跡）としてのみ扱う**（§12）。
- 健診 XLSX が無い人物のみ、**既存 AI スキャン経路**で構造化する。
  再利用: `src/lib/elith-export.ts` `buildElithScanBundle`。
  `application/pdf` は **`MIME_TO_EXT`（`elith-export.ts:117`）に実在**するので、
  **PDF をそのまま Gemini へ渡せる**（ページ画像化は不要）。
- **1 ファイル = 1 リクエスト**（CLAUDE.md の実行モデル）。

### 11.3 問診 XLSX → `LifestyleQuestionnaireData`

**新規 parser**: `src/lib/questionnaire-xlsx.ts`。シートを読む層は §11.1 と共用する。
**この parser は O5（§28.2）が解消するまで着手しない**（発注者指示 2026-09-10）。
62 列 → 既存問診スキーマの mapping を**推測で作らない**。健診・遺伝子側と共通の基盤までは先行してよい。

- 出力は **既存 `src/lib/interview-export.ts` の `buildElithInterviewJson()` / `buildElithInterviewBundle()`
  が作るものと同じ構造**にする。**新しい独自 JSON 形式を作らない**（指示書 §7）。
- ヘッダー文 → 安定した項目 ID へのマッピング表を持つ（`QUESTIONNAIRE_XLSX_MAP`）。
- 複数選択の区切り（`;` 等）は**既存 export の表現に合わせる**。
- **氏名 / DOB / メールを納品しない。** `sex` / `age` は `subject` へ。
- **未知の設問は捨てない。** マッピングに無い列は `needs_review` として件数と列名を監査に出す
  （**中身を勝手に項目化しない**）。

### 11.4 問診 PDF → `LifestyleQuestionnaireData`

- **汎用スキャン結果をそのまま `LifestyleQuestionnaireData` にしない**（指示書 §7）。
  既存問診スキーマ（`interview-export.ts`）の形へ正規化する。
- 実現方式は **既存の VLM 経路を再利用**する。
- **今回のサンプルの問診 PDF を確認できていない**ため、**写像表は `OPEN`**（§28-O5）。
  Phase 1 では **問診 PDF の人物は `needs_review`** とし、
  管理者が「この人物は問診なしで確定する」を選べるようにする（**捏造しない**）。

### 11.5 Genoplan PDF → `GeneticTestResultData`

**既存の専用処理を維持する**（指示書 §16）。

- **1 PDF 一括 Gemini 送信は禁止。1 ページずつ。**
- ページ画像化は **wellfort-site のブラウザ（pdf.js）**が行う。
  既存 `admin/elith-batch.astro:494-508`（jsDelivr `pdfjs-dist@3.11.174`）と同じ経路。
  **ページ画像は wellfort-site の中継 API を通って Scan-Chat-AI へ渡る**（本体は数百 KB＝4.5 MB 内）。
- Scan-Chat-AI は `scanGeneticPage` を呼び、結果を `ad_hoc_diagnosis_pages` に保存する
  （page_no・parsed・raw を監査保持）。
- `finalize` で 1 つの `GeneticTestResultData` に集約する。
- **同じ PDF を再処理した場合、`(file_sha256, page_no)` でキャッシュを使う**（§19.3）。
- **既存プロンプトを重複定義しない。**

**ブラウザがページ画像を作るための PDF バイト列の入手（v0.2 で修正）**

**【禁止】ZIP 全体を `ArrayBuffer` 化してメモリに置くこと。**
**【禁止】展開後のファイル群を同時に保持すること。**
上限は 512 MB（§5.1）で実物も 160 MB 級なので、どちらもブラウザのメモリを溢れさせる。

**採る形 = 必要な PDF エントリだけを、そのつど部分読みして展開する。**

- ブラウザは `<input type=file>` が返す **`File` オブジェクトの参照だけ**を保持する。
  `File` は**ディスク上の実体への参照**で、`File.slice(start, end)` は
  **その範囲だけの `Blob`** を返す（読むまで中身はメモリに載らない）。
  これがサーバ側の **S3 Range GET と同じ役割**を果たす。
- 手順（サーバ側 §5.3.3-2 と同型）:
  1. `file.slice(file.size - N)` で末尾を読み、EOCD（+ Zip64 EOCD）→ **Central Directory だけ**を得る。
     以後 Central Directory（エントリ名・offset・サイズ）だけを保持する。
  2. ページ画像化したい PDF について、`file.slice(offset, offset + compressedSize)` で
     **そのエントリの範囲だけ**を読む。
  3. `deflate` なら `DecompressionStream('deflate-raw')` で展開し、pdf.js へ渡す。
  4. **その PDF の処理が終わったら参照を捨てる**（次の PDF を読む前に解放する）。
- **同時にメモリへ載せてよいのは「Central Directory」＋「処理中の 1 エントリ」だけ。**
  複数の PDF を先読みしない。
- pdf.js には **1 ファイルずつ渡し、`pdf.destroy()` 相当で解放してから次へ**進む。
  ページ画像も 1 枚ずつ作って送信し、次を作る前に捨てる。
- **再読込した場合**、DB の状態（どのページまで終わったか）は復元されるが、
  `File` の参照は失われる。→ 画面に
  **「続きから処理するには同じ ZIP をもう一度選んでください」**と出し、
  **ZIP の SHA-256 が一致すれば同じバッチの続きから**再開する（**再アップロードはしない**）。
  人物と `client_id` の再対応は §6.2 の fingerprint で行う。
  - SHA-256 の計算も**全体をメモリに載せずに** `file.stream()` を逐次読みして進める（**§11.6**）。
- **S3 から presigned GET でブラウザへ渡す案は採らない。** バケットの CORS は現在 `PUT` のみで、
  `GET` を足す運用変更が要る（CLAUDE.md「`GET` も足さない」）。必要になったら §28-O4 で判断する。
- **検証（§25.2）**: 大きな ZIP を通したときに
  **ピークメモリが「Central Directory ＋ 最大エントリ 1 件」の桁に収まる**ことを実測で見る。
  「全体を `arrayBuffer()` する」実装に戻すと落ちること（退行注入）も確認する。

### 11.6 ブラウザ側の SHA-256 は逐次計算する（v0.5・発注者指示）

**【禁止】ZIP 全体を `file.arrayBuffer()` 化して `crypto.subtle.digest()` へ渡すこと。**

**理由（API の形からの帰結）**: `SubtleCrypto.digest(algorithm, data)` は
**`data` を 1 個の `BufferSource` として受け取り、その場でダイジェストを返す一発 API**で、
**`update()` に相当する逐次インタフェースを持たない**。
→ **`file.stream()` を読んでも `crypto.subtle` に渡せる形にするには結局全体を連結することになる**ので、
「ストリームで読んでいるから省メモリ」にはならない。**上限 512 MB（§5.1）でこれをやると溢れる。**

**採る形 = `@noble/hashes` の incremental API。**

```ts
// wellfort-site 側（ブラウザ）
import { sha256 } from '@noble/hashes/sha2.js';   // ← 拡張子 .js まで含めて 1 文字も変えない（下記）

const h = sha256.create();
const reader = file.stream().getReader();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  h.update(value);            // chunk ごとに update。chunk は使い終わったら捨てる
}
const digest = h.digest();     // Uint8Array(32) → 16 進小文字へ
```

**実測で確認した事実（2026-09-10・パッケージ本体の型定義から。記憶で書いていない）**

| 項目 | 実測値 | 出典 |
|---|---|---|
| バージョン / ライセンス | **2.4.0 / MIT** | `registry.npmjs.org/@noble/hashes/latest` |
| 直接依存 | **0** | 同上 |
| 既知の脆弱性 | **0 件** | `api.osv.dev`（npm ecosystem） |
| `engines` | `node >= 20.19.0` | 同上（**ビルド環境の Node がこれ未満だと入らない**） |
| **import パス** | **`@noble/hashes/sha2.js`（`.js` 必須）** | `exports` に **`"./sha2.js"` は在るが `"./sha2"` は無い**（実測）。**拡張子を落とすと解決に失敗する** |
| `create()` | `create(): T` | `package/utils.d.ts:504` |
| `update()` | `update(buf: TArg<Uint8Array>): this` | 同 `:419` |
| `digest()` | `digest(): TRet<Uint8Array>` | 同 `:430` |
| 逐次利用の作例 | `const hash = sha256.create();` | 同 `:137` / `:154`（**パッケージ自身の JSDoc**） |

**この 1 つの実装を 2 か所で使い回す（発注者指示）**

| 使う場面 | 何のため |
|---|---|
| **① 初回 ticket 発行の前** | `source_sha256`（§23.1 は **NOT NULL**）を決める。**DB 設計は変更不要** — 逐次計算でも ticket を出す前に値が確定するため |
| **② 再読込のあと** | 選び直された ZIP が**同じものか**を照合する（§6.2.3-1 / §11.5）。一致しなければそこで止める |

**①②で別実装にしない。** 片方だけ違う計算をすると「同じ ZIP なのに一致しない」が起き、
その症状は**再開が黙って新規バッチになる**という形で出る（人物と `client_id` の対応が切れる）。

**検証（§25.2 に追加）**
- 8 MB 級のファイルで **`crypto.subtle.digest()` の結果と 1 バイトも違わない**ことを突き合わせる
  （逐次実装が正しいことの確認。**比較のためだけに使い、本番経路では使わない**）。
- **ピークメモリ**が chunk 1 個ぶんの桁に収まること。
- **退行注入**: `arrayBuffer()` + `crypto.subtle.digest()` に差し替えると
  **ピークメモリの検査が落ちる**ことを確認する（結果は一致してしまうので、値だけ見ても検出できない）。

---

## 12. 同一検査の PDF / XLSX 重複判定

同一人物に健診 PDF と健診 XLSX がある場合（指示書 §8）:

- **XLSX = 構造化値の正**
- **PDF = 原票証跡**
- **両方を別々の `HealthCheckupData` として Elith に納品しない。**

### 12.1 判定キー（ファイル名では判定しない）

次を**すべて**満たすとき「同一検査」とみなす。

1. 同一人物（同じ `subject_id`）
2. 同一検査種別（同じ `classified_format_id`）
3. **健診日が一致**
4. **主要計測値が一致**: 身長 / 体重 / BMI / 収縮期血圧 / 拡張期血圧 / 血糖 or HbA1c / LDL
   のうち、**両方に値がある項目の 80% 以上**が一致（数値は絶対値差 0、丸めのみ許容）

### 12.2 一致しない場合

**勝手に XLSX 優先で確定しない。** `needs_review` とし、画面に
**どの項目がどう食い違ったか**（項目名と 2 つの値）を出す。管理者がどちらを主ソースにするか選ぶ。

### 12.3 出力への反映

- 採用した方の `selected_as_primary = true`。
- 採用しなかった方は `duplicate_of_file_id` を埋め、**納品 JSON を生成しない**（原票としては残る）。

---

## 13. `client_id` / `diagnostic_id` の採番

### 13.1 `client_id`

- **人物フォルダごとに新規 UUID v4 を発番**する（指示書 §6）。
- **ファイル名やフォルダ名の番号を使わない。**
- **【既存仕様との差・明記】** CLAUDE.md は「`client_id` = `diagnostic_user_id`（PII 非含有）」としている。
  臨時バッチの被験者は **EC 顧客でもアプリ利用者でもない**ので `diagnostic_user_id` を持たない。
  → **`diagnosis.app_users` とは別空間の UUID** を採番する。
  先行例: `Scan-Chat-AI/src/pages/api/admin/elith-scan.ts` のコメント
  「`clientId?: string, // 未指定ならサーバで UUID 採番 (サンプル用)`」= **同じことを既にしている**。
  対応は `ad_hoc_diagnosis_subjects.client_id` にだけ持ち、**PII は生まれない**。

### 13.2 `diagnostic_id`

- 問診 export（`interview-export.ts`）が要求する識別子。**バッチ × 人物ごとに 1 つ採番**する。
- `client_id` と同値にしてよいが、**別列で保持**する（意味が違うものを 1 列に潰さない）。

---

## 14. 日付の決定（`test_date` / `bundle_date`）

### 14.1 既存仕様の整理（指示書 §9 の要求）

- `docs/elith/elith_s3_data_handoff_spec.md`: **date フォルダ = AI 診断回の単位日** /
  **`test_date` = 各検査の実施日**。
- 後続のアセンブリ実装・仕様では `bundleDate` と各 `test_date` の扱いに拡張がある。

**決定: 内部データでは 2 つを必ず別フィールドで持ち、最初から同一値に潰さない。**

| フィールド | 意味 | 持つ場所 |
|---|---|---|
| `bundle_date`（= `diagnosis_date`） | この診断回の単位日。**Elith の date フォルダになる** | `ad_hoc_diagnosis_batches` |
| `test_date` | その検査の実施日。**納品 JSON の `test_date`** | `ad_hoc_diagnosis_files` / 出力 |

### 14.2 `test_date` の決定（ソース別・優先順）

| ソース | `test_date` |
|---|---|
| 健診 XLSX | **`健診日` 列** |
| 健診 PDF | 既存スキャンの抽出（`buildElithScanBundle` の `examDateFromScan` → `extractExamDate`。`elith-export.ts:1322-1328`） |
| 問診 XLSX | **`OPEN`（§28-O5）**。開始時刻 / 完了時刻 / 診断基準日のどれを正とするか、実列を見てから決める。Phase 1 は**未決なら空**にし、埋めない |
| 問診 PDF | 同上 |
| Genoplan | **既存 Genoplan 実装の決定ルールを継承**する（新しい規則を作らない） |

### 14.3 `bundle_date` の決定

1. 管理者が STEP 1 で「診断回の基準日」を入力していればそれ。
2. 入力が無ければ、**そのバッチで確定した `test_date` のうち最も新しい日**。
3. どちらも無ければ**確定できない**として `needs_review`（**今日の日付で埋めない**）。

### 14.4 `10名の情報.xlsx` の `実施日`

**意味が確定していないので、どの format の `test_date` にも自動転用しない**（指示書 §9・§27）。
画面には参考情報として出してよいが、**採用するには管理者の明示操作を必要とする**。

---

## 15. Elith 出力

### 15.1 今回の対象 format

| format_id | 出所 | 必須/任意 |
|---|---|---|
| `HealthCheckupData` | 健診 XLSX（正）／健診 PDF | **必須** |
| `GeneticTestResultData` | Genoplan PDF | **必須** |
| `LifestyleQuestionnaireData` | 問診 XLSX / PDF | **必須** |
| `HealthAgeData` | 算出できた場合のみ | 任意 |

**今回のデータに無い format を捏造しない。** `BloodTestData` / `CancerRiskAssessmentData` は出さない。

### 15.2 既存 5 種ゲートを壊さない（**重要**）

`src/lib/elith-assemble.ts:29` の `GATING_FORMAT_IDS`（5 種必須）は
**通常プランの完全性判定**であり、**この機能のために変更しない**（指示書 §18・§27）。

臨時バッチは**案件ごとに必要な format 集合**を batch 設定として持つ。

```json
{
  "required_formats": ["HealthCheckupData", "GeneticTestResultData", "LifestyleQuestionnaireData"],
  "optional_formats": ["HealthAgeData"]
}
```

- 人物の `ready` 判定は**この集合だけ**で行う。
- `HealthAgeData` が無くても **他 3 種の ready を維持する**（指示書 §26-21）。

### 15.3 納品パス・命名

`docs/elith/elith_s3_data_handoff_spec.md` に従う（新規則を作らない）。

```
{prefix}user/{client_id}/date/{YYYY_MM_DD}/{format_id}_date_{YYYY_MM_DD}_user_{client_id}.json
```

`{YYYY_MM_DD}` は **`bundle_date`**（§14）。

### 15.4 manifest（1 人分の納品セット）

| キー | 内容 |
|---|---|
| `batch_id` / `client_id` | — |
| `bundle_date` | date フォルダの日付 |
| `included_formats` | 実際に書き出した format |
| `source_test_dates` | format ごとの `test_date` |
| `validation` | schema validation の結果 |
| `health_age` | `full` / `simple` / `unavailable` と不足マーカー |
| `generated_at` | — |

**PII を入れない。** Elith 側に既存 manifest 定義があればそれを再利用する
（`docs/elith/elith_assembly_wrapping_spec.md`）。

### 15.5 書出し前チェック

PII 除外 / schema validation（`docs/elith/elith_handoff.schema.json`）/ 同一 format の重複 /
空 JSON / `client_id` 整合 / `test_date` / `format_id`。**1 つでも落ちたら書き出さない。**

---

## 16. ウェルネス年齢

**既存ロジックを一切変更しない**（指示書 §17）。入口は `src/lib/wellness-age.ts` の
`computeWellnessAge` **だけ**（`computeHealthAge` を直接呼ばない。CLAUDE.md）。

計算順（既存の 3 段階フォールバック）:

1. **CABA v5.4 full**（`health-age.ts`）
2. **CABA v7.0 simple**（`health-age-simple.ts`）
3. **unavailable** → 値を作らず定型文 `WELLNESS_AGE_UNAVAILABLE_MESSAGE`。**保存しない**

### 16.1 全員が算出できると仮定しない

指示書 §17 のとおり、**確認された 39 列型の健診 XLSX ヘッダーに `albumin` / `creatinine` は無い**。
簡易版の必須は「実年齢・アルブミン・クレアチニン＋（血糖 or HbA1c）」なので、
**この様式だけでは 10 名全員が `unavailable` になり得る。**

→ 人物ごとに **`full` / `simple` / `unavailable`** を明示し、**不足マーカーも表示**する。

```
simple unavailable: albumin, creatinine
```

### 16.2 捏造しない

- **値が足りなければ勝手に補完しない。** 既存仕様で許可済みの補完（CABA v5.4 の
  MCV / RDW / CRP / WBC 桁 / BMI）**のみ**使う。
- 既存管理 API にある `syntheticMarkers` の例外運用は、**この機能では初期状態で自動使用しない**。
  必要なら**管理者の明示操作**とし、元データとの区別と監査情報を必ず残す（§21）。
- `health_age_unavailable` は**バッチ全体の致命エラーにしない**（§20.2）。

---

## 17. 管理者確認画面（6 ステップ・wellfort-site）

配置: `/admin/ad-hoc-diagnosis`。
`src/components/AdminLayout.astro` の **`検査連携` グループ**へメニューを追加する
（既存: `Elith バッチ生成` / `健康年齢テスト`。実測 `AdminLayout.astro:23-24`）。

### STEP 1 — ZIP 受付
入力: 案件名 / 診断回の基準日（任意）/ ZIP。
表示: ファイル件数 / ZIP サイズ / **SHA-256**。
**この時点で Elith 本番 S3 へ送らない。**

### STEP 2 — 自動分類・人物グループ確認
- **氏名を出さない。** `No.01` … `No.10` の管理用表示にする。
- 人物ごとにファイル一覧（種別 / ファイル / 判定 / 採用）と**分類信頼度**を出す。
- **誤分類を管理者が修正できる。**

### STEP 3 — 変換・事前検証
人物ごとに: 健診構造化 / 問診構造化 / 遺伝子構造化 / `test_date` 抽出 /
`subject.sex`・`subject.age` 生成 / schema validation / ウェルネス年齢適合判定。

```
健診: OK / 39 項目中 xx 件
遺伝子: OK / 208 ページ
問診: OK
ウェルネス年齢: full / simple / unavailable
警告: 2   エラー: 0
```

### STEP 4 — 管理者確認
**この確認前に Elith 納品先へ確定書き出ししない。**
管理者が **`納品データを確定`** を実行して初めて納品対象として固定する。

### STEP 5 — Elith 納品セット生成・書出し
§15.5 のチェックを全て通してから書き出す。**ドライラン（`dry_run=true`）を必ず用意する。**

### STEP 6 — 完了・監査
人物ごとに `client_id` / format 一覧 / `test_date` / HealthAge method / S3 key / validation result。
**成功 / 警告あり / 失敗** を明示。**実行結果は後から再表示できる。**

---

## 18. S3 書出し

- 書出しは **Scan-Chat-AI 側のみ**が行う（§4）。
- 既存 `src/lib/s3.ts` の `getS3Config` / `isS3Configured` / `putFiles` を使う。
- **S3 未設定ならドライラン**（既存 API と同じ挙動。`elith-scan.ts` の
  `{ ok:false, configured:false, ..., preview }`）。
- **`dry_run=true` のときは `putFiles` を呼ばない。** 生成した JSON と書き込み予定 key を返すだけ。
- **この実装作業では本番 Elith S3 へ今回の実データを送らない**（§24.5）。

---

## 19. 再実行・冪等性

### 19.1 同一 ZIP の二重登録

キー = **ZIP の SHA-256**。同じ SHA のバッチが既にあれば**管理者へ警告**する
（`{ duplicate_of_batch_id, created_at, status }`）。**自動で拒否も自動で続行もしない。**

### 19.2 同一原本の重複

同じファイル SHA-256 が同一バッチ内に複数あれば**自動重複候補**として `duplicate_of_file_id` を付ける。

### 19.3 ページ結果のキャッシュ

`(file_sha256, page_no)` で `ad_hoc_diagnosis_pages` を引き、**成功済みなら Gemini を呼ばない**。
これにより「同じ PDF を再処理しても課金と時間が積み上がらない」。

### 19.4 S3 への再 export

**無制限に別物を増やさない。**
- 同じ `(client_id, bundle_date, format_id)` へ 2 回目を書くのは **overwrite** になる。
- **overwrite には管理者の明示確認を必要とする**（`overwrite=true`）。
  確認が無ければ `export_failed: would_overwrite` を返す。

---

## 20. 部分失敗・リトライ

### 20.1 原則

- **1 件失敗で 10 名全体を破棄しない**（指示書 §11）。
- 失敗は**その単位に閉じる**（ページ → ファイル → 人物 → バッチ の順に集約して表示）。
- `retry` は**失敗した対象だけ**を再実行する。成功済みは触らない。

### 20.2 致命でないもの

| 状態 | バッチの扱い |
|---|---|
| `health_age_unavailable` | **致命にしない。** 「ウェルネス年齢なしで他データは納品可能」を表せる |
| `needs_review` が残っている | `ready` にしないが、**他の人物の確定は妨げない** |
| 1 ページの `page_failed` | ファイルは `partial`。リトライ可 |

---

## 21. 監査ログ

`ad_hoc_diagnosis_events`（append only）に次を積む。**PII は入れない。**

| 列 | 内容 |
|---|---|
| `batch_id` / `subject_id?` / `file_id?` | 対象 |
| `event` | `created` / `classified` / `reclassified` / `parsed` / `page_done` / `page_failed` / `confirmed` / `exported` / `retry` / `override` |
| **`actor_user_id`** | **操作者識別の正**（v0.4・発注者判断で O10 CLOSE）。wellfort-site が `/auth/v1/user` で検証した Supabase Auth の **`user.id`（UUID）**。**中継のサーバ側で注入する** — **ブラウザ body の `actor_user_id` は信用しない**（申告値をそのまま積むと監査ログとして成立しない）。UUID なので PII ではなく、`admin_users` を引けば後から人に戻せる |
| `actor_masked` / `actor_sha256` | **表示用と補助**（正ではない）。`actor_masked` は一覧に出すマスク済み文字列（`h***@example.com`）、`actor_sha256` は任意。**メールの現物は保存しない** — 既存 `demo.account_emails` と同じ規律（CLAUDE.md「メールの現物は保存しない」）。wellfort-site が検証した email を中継時に渡し、**Scan-Chat-AI 側で受け取った直後にマスク＋ハッシュ化して原文を捨てる** |
| — | **自動処理（人の操作でない）は actor 3 列とも null** のまま積む。`page_done` などに架空の操作者を入れない |
| `detail` | JSON。**値そのものではなく種類と件数**（例 `{ "from": "needs_review", "to": "HealthCheckupData" }`） |
| `created_at` | — |

**必ず残すもの**: 分類の手動修正 / 重複判定の上書き / `syntheticMarkers` の明示使用 /
overwrite export / retry。

---

## 22. API 一覧

`{B}` = wellfort-site の中継（ブラウザから呼ぶ。admin token）
`{S}` = Scan-Chat-AI の処理（サーバ間。Bearer `ADMIN_API_KEY`）
**パスは両側で同じにする**（中継が何を呼ぶか自明にするため）。

| # | パス | メソッド | 役割 |
|---|---|---|---|
| 1 | `/api/admin/ad-hoc-diagnosis/upload-ticket` | POST | batch 作成 + presigned PUT 発行（§5.2） |
| 2 | `/api/admin/ad-hoc-diagnosis/{batchId}` | GET | 状態取得（バッチ / 人物 / ファイル / 進捗） |
| 3 | `/api/admin/ad-hoc-diagnosis/{batchId}/classify` | POST | ZIP 展開・分類・人物グループ化 |
| 4 | `/api/admin/ad-hoc-diagnosis/{batchId}/reclassify` | POST | 管理者による分類修正 |
| 5 | `/api/admin/ad-hoc-diagnosis/{batchId}/process-file` | POST | 1 ファイル or 1 ページ処理（body に `fileId` / `page` / `image`） |
| 6 | `/api/admin/ad-hoc-diagnosis/{batchId}/health-age-check` | POST | 全人物のウェルネス年齢適合判定 |
| 7 | `/api/admin/ad-hoc-diagnosis/{batchId}/finalize` | POST | Elith format JSON 確定（S3 書出しはしない） |
| 8 | `/api/admin/ad-hoc-diagnosis/{batchId}/export` | POST | S3 納品（`dry_run` / `overwrite`） |
| 9 | `/api/admin/ad-hoc-diagnosis/{batchId}/retry` | POST | 失敗対象の再実行 |

- **HTTP API 同士を Scan-Chat-AI 内部から呼ばない。** 既存 `elith-scan` / `elith-genetic-merge` /
  `health-age` / `elith-assemble` の処理は**共通 lib へ切り出して再利用**する（指示書 §13）。
- **操作者は中継のサーバ側で注入する（v0.4・§21 / §28.1-O10）。**
  `{B}` の各中継は `verifyAdmin` で `/auth/v1/user` を引いた**その応答の `user.id`** を
  `{S}` へ渡す（`actor_user_id`）。**ブラウザ body に同名のキーが在っても捨てる**
  — 上書きを許すと監査ログが自己申告になる。人の操作でない処理は**渡さない**（null のまま）。
- 切り出す先: `src/lib/ad-hoc-diagnosis/*.ts`（`archive`（§5.3 の手段をここに隠す） / `classify` /
  `parsers` / `pipeline` / `state` / `fingerprint`（§6.2））。

---

## 23. DB 変更（`diagnosis` スキーマ・**Production 適用禁止**）

既存テーブルの調査結果（実測・`supabase/migrations/`）: `announcements` / `app_config` / `app_users` /
`diagnosis_results` / `health_age_scores` / `measurement_values` / `scan_jobs` /
`test_artifact_files` / `test_artifacts` / `user_notices`。
**臨時バッチの状態を持てる表は無い**ので新設する。

### 23.1 `diagnosis.ad_hoc_diagnosis_batches`

`id` / `title` / `status` / `bundle_date`(null 可) / `source_sha256` /
**`declared_source_size`(NOT NULL)** / **`source_size`(NULL 可)** /
`source_key` / `subject_count` / `file_count` / **`required_formats`(jsonb)** / **`optional_formats`(jsonb)** /
`retain_originals`(bool, 既定 false) / **`created_by_user_id`(uuid)** / **`created_by_masked`** /
`created_at` / `updated_at` / `confirmed_at` / `exported_at` / `last_error`

- `required_formats` / `optional_formats` は §15.2 の JSON の 2 キーを**別列に分けた**もの（Phase C）。
- **`created_by_user_id` が作成者識別の正**（v0.4）。wellfort-site が `/auth/v1/user` で検証した
  `user.id` を**サーバ側で注入する**。`created_by_masked` は表示用で、識別には使わない。
  **メールの現物は保存しない**（§21 と同じ規律）。
- **ZIP のサイズは申告値と実測値を分けて持つ（v0.4・発注者指示）。**
  - `declared_source_size` = **ticket 発行時のブラウザ申告値**。上限の一次判定に使うだけで信用しない（§5.2.1 ①）。
  - `source_size` = **PUT 完了後に `HeadObject` で確認した実サイズ**（§5.2.1 ②）。
  - **なぜ 1 列にしないか**: batch 行が出来るのは ticket 発行時点で、**まだ PUT が済んでいない**。
    その時点に実測値は存在しないので、1 列に混ぜると**申告値を実測値として保存する**ことになる。
    だから `source_size` は **NULL 可**（＝まだ確認していない）にし、**申告値をここへ入れない**。
  - **classify 開始時に `HeadObject` を行い `source_size` を確定させる。**
    上限超過なら `failed` にし、**一時 ZIP を削除する**。
- `source_sha256` は**一意にしない**。同じ ZIP の再投入は「検知して警告する」だけで、
  自動で拒否も自動で続行もしない（§19.1）。索引だけ張る。

`status`: `draft` / `uploaded` / `classified` / `processing` / `needs_review` / `ready` /
`exporting` / `completed` / `failed`

### 23.2 `diagnosis.ad_hoc_diagnosis_subjects`

`id` / `batch_id` / `subject_no` / **`subject_fp`** / **`subject_fp_source`** / `client_id` / `diagnostic_id` /
`identity_status` / `identity_reason` / `sex` / `age` / `status` / `created_at` / `updated_at`

**制約とインデックス（v0.3）**
- **`subject_fp` は一意にしない。** `CREATE INDEX ... (batch_id, subject_fp)`（通常 INDEX）。
  同一 fp が複数人物に存在し得ることを仕様として認め、**衝突は検索件数で検出する**（§6.2.3 / §6.2.5.1）。
- **`UNIQUE (batch_id, subject_no)`** — 表示連番は同一バッチ内で重複させない。

**氏名・生年月日・社員番号・フォルダ名・元ファイル名は保存しない**（§6.1 / §8.1）。
`subject_fp` は**内容ハッシュだけから作る**ので、この列から PII を引き出す経路は無い（§6.2.1）。

### 23.3 `diagnosis.ad_hoc_diagnosis_files`

`id` / `batch_id` / `subject_id`(null 可) / `storage_key` / `display_name` / `sha256` /
`size_bytes` / `mime_type` / `source_kind` / `classified_format_id` /
`classification_confidence` / `test_date` / `parse_status` / `page_count` /
`selected_as_primary` / `duplicate_of_file_id` / `error_detail`

### 23.4 `diagnosis.ad_hoc_diagnosis_pages`

`id` / `file_id` / **`file_sha256`** / `page_no` / `status` / `parsed`(jsonb) / `raw`(text・監査) /
`attempts` / `error_detail` / `created_at` / `updated_at`

- **UNIQUE (file_id, page_no)**。
- **キャッシュ参照 `(file_sha256, page_no)` は 1 本の索引で引く**（§19.3）ので、
  `files.sha256` を**非正規化して持つ**（Phase C）。join せずに
  「このページは前に読んだか」を判定でき、**別バッチで同じ PDF が来ても効く**。

### 23.5 `diagnosis.ad_hoc_diagnosis_outputs`

**既存 `test_artifacts` / `test_artifact_files` では表現しない。**
理由: あちらは「**確定した検査 1 件**」＋「その原本ファイル」で、
`diagnostic_user_id`（`app_users` への FK）を要求する。臨時バッチの被験者は
`app_users` に行が無いので**そのままでは入らない**（`app_users` に偽の行を作るのは PII/識別の設計に反する）。
→ 別表にする。**似た表を二重に作らない**という指示（§12）とは、
「**入る器があるなら新設しない**」の意味で読み、入らないことを根拠に新設する。

`id` / `subject_id` / `format_id` / `output_status` / `json_storage_key` /
`validation_status` / `item_count` / `test_date` / `generated_at` / `error_detail` /
`created_at` / `updated_at`

**UNIQUE (subject_id, format_id)** — **同一人物に同じ format を 2 つ作らない**（§15.5 の
「同一 format の重複」）。健診 PDF と XLSX を別々に納品しないための構造的な歯止めでもある（§12）。

### 23.6 `diagnosis.ad_hoc_diagnosis_events`

§21 のとおり。

### 23.7 適用の約束

- **migration ファイルの作成までが本作業。** 適用は発注者の操作。
  **`supabase db push` はこちらで実行しない**（CLAUDE.md）。
- **Production DB へ適用しない。**
- **適用済みの migration を編集して当て直さない。** 直すときは前進 migration を足す（CLAUDE.md）。
- RLS: `enable row level security` + `force row level security` を付け、**ポリシーは置かない**。
  `revoke all ... from anon, authenticated` / `grant all to service_role`
  （`scan_jobs`（`20260910000010`）と同形）。**この設計は `service_role` の BYPASSRLS に依存する**
  ——無いと `grant all` は通るのに **0 行しか見えず、エラーも出ない**。

---

## 24. セキュリティ

### 24.1 認可

- **管理画面ページ**: wellfort-site 側で `admin_users`（`is_active=true`）を
  **ユーザー自身のアクセストークン + anon apikey** で照会する（`api/admin/elith-scan.ts:27-49` と同形。
  **service_role を使わない**）。
- **Scan-Chat-AI 側 API**: `src/lib/api-auth.ts` の `isAdminAuthorized()` を使う
  （**キー未設定の本番は拒否＝fail-closed**）。
- **ブラウザへ `ADMIN_API_KEY` / `SCAN_CHAT_AI_API_KEY` を渡さない。**
- **`LAB_INTAKE_API_KEY`（取り込み専用キー）ではこの API を通さない。**
  intake キーが通ってよい口は 3 つだけで（`api-auth.ts` のコメント）、
  `npm run verify:intake-scope` が「他の口が intake キーで通ったら落とす」形で固定している。
  **臨時診断バッチの API をその 3 つに足さない。**

### 24.2 presigned とキー検証

§5.2 のとおり。加えて:
- **サイズは署名に依存せず多層で守る**（§5.2.1）。とくに**アップロード後の `HeadObject` を必ず通す**。
- **クライアントから S3 key を受け取らない。** `batchId` から**サーバが導出**する。
- `isAdHocZipKey` / `isAdHocFileKey` は**完全一致**で検証する（部分一致にしない）。

### 24.3 ZIP security（指示書 §22）

| 対策 | 実装 |
|---|---|
| Zip Slip（`../`） | 正規化後にベースディレクトリ配下か検査。外れたら**そのエントリを捨てて記録** |
| 絶対パス | `/` 始まり・`C:` 等のドライブレターを拒否 |
| symlink | 外部属性の Unix モード上位ビットが `S_IFLNK` のエントリを拒否 |
| 展開後総容量 | `MAX_TOTAL_UNCOMPRESSED`（§5.1）。Central Directory の `uncompressed size` を**先に合計**して判定 |
| ファイル数 | `MAX_ENTRIES` |
| 1 ファイル容量 | `MAX_ENTRY_BYTES` |
| ネスト深度 | `MAX_DEPTH` |
| 許可拡張子 | §5.1。**それ以外は展開しない** |
| MIME 確認 | 拡張子だけで信じず**マジックバイト**を見る（PDF=`%PDF-`、XLSX=`PK\x03\x04` かつ `[Content_Types].xml` を含む） |
| 空ファイル | 検出して一覧に出す |
| パスワード保護 | general purpose bit 0 が立っていたら `password_protected_file` |

### 24.4 AWS 側の作業（**運用・発注者側**）

`{AWS_S3_PREFIX}ad-hoc-uploads/` に**ライフサイクル失効ルール**を足す。

- `Expiration { Days: 7 }` + **バケットがバージョニング有効なら
  `NoncurrentVersionExpiration { NoncurrentDays: 7 }` も必須**
  （`Expiration` だけだと削除マーカーが付くだけで実データが残る。2026-09-04 の実測）。
- **prefix を誤ると Elith 納品 JSON が消える。** `ad-hoc-uploads/` で終わることを必ず確認する。
- 既存ルール（`scan-uploads/` 用）を**消さない**。get → 統合 → put。

### 24.5 この実装作業でやらないこと

- Production DB への migration 実行 / Production データの更新・削除
- 本番 Elith S3 への今回の実データ送信
- 本番の検査機関・タカセ・メールへの送信
- `.env` / 秘密鍵の追加・commit・画面出力
- **サンプル ZIP・実在氏名の commit**

---

## 25. テスト

### 25.1 fixture（**実在 10 名の ZIP を Git に入れない**・指示書 §24）

`scripts/` で**匿名・架空データから生成**する（生成物は `.gitignore`）。

1. 1 人 3 ファイル / 2. 1 人 4 ファイル（健診 PDF + XLSX 重複）/ 3. 問診 XLSX /
4. 問診 PDF / 5. 多ページ PDF（**ページ数を縮小した疑似 fixture**）/ 6. 氏名不一致 /
7. `test_date` 不一致 / 8. unsupported file / 9. `~$` 一時ファイル / 10. duplicate SHA /
11. malformed ZIP / 12. Zip Slip

### 25.2 Unit（`npm run verify:ad-hoc-*`・サーバ不要）

ZIP 安全展開 / 分類 / 健診 XLSX parser / 問診 XLSX parser（**O5 解消後**） / identity check /
duplicate 判定 / date parse（Excel シリアル・1900 うるう年バグ・`date1904`・文字列日付） /
age 算出 / PII masking / state transition /
**部分読み（§11.5 のピークメモリ）** / **`subject_fp` の再現性と非 PII 性（§6.2.7）**。

**「壊して落ちること」を必ず確認する**（この種の検査は静かに壊れるため。CLAUDE.md の
`verify:demo-gate` / `verify:scan-upload-key` と同じ規律）。とくに:
- **PII masking**: 保存物・応答・ログのどこにも氏名 / DOB が出ないこと。
  → `hashEmail` を壊すと落ちる形（`verify:demo-gate`）を真似て、**実際に動かして**検査する。
- **Zip Slip**: `../` を通す実装にすると落ちること。
- **部分読み**: ZIP 全体を `arrayBuffer()` する実装に戻すと**ピークメモリの検査が落ちる**こと（§11.5）。
- **`subject_fp`**: 材料に氏名・フォルダ名・ファイル名を混ぜる実装を注入すると落ちること（§6.2.7）。
- **再開の結び直し**: `subject_fp` でなく `subject_no` で結ぶ実装に戻すと、
  「1 ファイルだけ人物間で入れ替えた ZIP」で**別人の `client_id` に付いてしまい落ちる**こと。

### 25.3 Integration

ZIP → 1 人物認識 / 3 format 生成 / PDF+XLSX 重複抑止 / Genoplan page resume /
health age check / schema validation / **dry-run export**。

### 25.4 Regression（既存を壊さない）

`elith-scan` / `elith-genetic-merge` / `health-age` / `elith-assemble` / `admin lab upload`。
既存の `npm run verify:*` と `astro check` / `astro build` を通す。
**CI（`.github/workflows/ci.yml`）には新しい検査を書き足さず、`verify:*` を足して既存 job に載せる。**

---

## 26. 受入条件

指示書 §26 の 30 項目をそのまま受入条件とする。要点の再掲:

1. **管理トップ（wellfort-site）に「臨時診断バッチ」が表示される**（※指示書原文の
   「管理トップ」は wellfort-site 側 = §4 の確定に読み替え）
2. admin 以外はアクセス不可 / 3. ZIP を投入できる / 4. 10 人物フォルダ構成を検出 /
5. `~$` を無視 / 6. root 参考ファイルを人物へ誤割当しない /
7. フォルダ番号と問診内部 ID を同一 ID 扱いしない / 8. 各人物へ新規 UUID `client_id` /
9〜14. 分類と変換 / **15. PII が納品 JSON / S3 key に出ない** /
16. 1 ページ失敗から再開 / 17. ブラウザ再読込後もバッチ状態が復元 /
18. full/simple/unavailable を人物ごとに表示 / **19. 不足値からウェルネス年齢を捏造しない** /
20〜21. ready 判定 / 22. schema validation / **23. 管理者確定前に Elith 納品しない** /
24. dry-run / 25. 同一 ZIP 再投入を検知 / **26. Production へ実データを書かずにテスト完了** /
**27. 既存 5 種 GATING 仕様を壊さない** / **28. 実 PII を Git に含めない** /
29. unit/integration/regression PASS / 30. build PASS

---

## 27. 既存再利用 / 新規実装

### 27.1 再利用（そのまま呼ぶ）

| 対象 | 実装 |
|---|---|
| 遺伝子 1 ページ構造化 | `src/lib/elith-genetic.ts` `scanGeneticPage` |
| 健診 PDF スキャン → Elith bundle | `src/lib/elith-export.ts` `buildElithScanBundle` |
| 納品整形（唯一の正規化本体） | `src/lib/elith-export.ts` `sanitizeMeasurementsForDelivery` |
| 問診エンベロープ | `src/lib/interview-export.ts` `buildElithInterviewJson` / `buildElithInterviewBundle` |
| ウェルネス年齢 | `src/lib/wellness-age.ts` `computeWellnessAge` |
| S3 | `src/lib/s3.ts` `getS3Config` / `isS3Configured` / `putFiles` |
| 原本保存 | `src/lib/originals-storage.ts` `putOriginal`（`retain_originals=true` のときだけ） |
| 認可 | `src/lib/api-auth.ts` `isAdminAuthorized` |
| 運用パラメータ | `src/lib/app-config.ts` `refreshConfig`（処理前に呼ぶ） |

### 27.2 ラップして利用

| 対象 | 方法 |
|---|---|
| 遺伝子ページ集約 | `elith-genetic-merge.ts` の part/finalize の**思想**を `src/lib/ad-hoc-diagnosis/genetic.ts` へ切り出して共用（HTTP で呼び合わない） |
| Elith 納品 key 生成 | `elith-genetic-merge.ts` の `folderOf()` 相当を共通化 |

### 27.3 新規実装

ZIP / XLSX を読む層（**手段は §5.3 で決定＝`@zip.js/zip.js` + `read-excel-file`**。
`src/lib/ad-hoc-diagnosis/archive.ts` が ZIP を、パーサ 1 枚が XLSX を隠す薄いラッパ。
**`archive.ts` は S3 Range の custom `Reader` も持つ**・§5.3.7.1） /
（wellfort-site 側）**ブラウザの逐次 SHA-256**（`@noble/hashes`・§11.6）と ZIP の部分読み /
`src/lib/health-checkup-xlsx.ts` /
`src/lib/questionnaire-xlsx.ts` / `src/lib/ad-hoc-diagnosis/{classify,state,pipeline,keys}.ts` /
`src/pages/api/admin/ad-hoc-diagnosis/*.ts` / migration 1 本 /
（wellfort-site 側）`src/pages/admin/ad-hoc-diagnosis.astro` + `src/pages/api/admin/ad-hoc-diagnosis/*.ts`

---

## 28. 既存仕様との矛盾・`OPEN`

### 28.1 解決済み（記録）

**O1. admin UI をどちらのリポジトリに置くか — 解決（2026-09-10 発注者確定）**
指示書の初版は「Scan-Chat-AI の `/admin/ad-hoc-diagnosis` に UI を追加」としていたが、
**発注者が訂正**し、`docs/lab/wellfort_admin_lab_upload_spec.md` の既存確定アーキテクチャを正とした。
→ **UI = wellfort-site / 処理・API = Scan-Chat-AI**（§4）。
Scan-Chat-AI に既存する `src/pages/admin/*` は**今回の前例として使わない**。
削除・移設は**本仕様のスコープ外**。**CLAUDE.md に「Scan 側 admin UI の例外」を追加しない。**

**O10. 監査ログの操作者をどう持つか — 解決（2026-09-10 発注者判断・v0.4 で CLOSE）**
v0.3.1 は `actor_masked` + `actor_sha256` だけにしたため、**「誰がやったか」を一覧から直接読めず**、
候補アドレスを hash して突き合わせる必要があった（監査ログとして弱い）。
→ **`actor_user_id`（uuid）を操作者識別の正**にする。wellfort-site は既に `/auth/v1/user` で
認証済みユーザーを取得している（`elith-scan.ts:34-39` と同形）ので、**そこから `user.id` を取り出し、
中継のサーバ側で Scan-Chat-AI へ渡す**。
- **`actor_user_id`** = 操作者識別の正 / **`actor_masked`** = 表示用 / **`actor_sha256`** = 任意の補助。
- **ブラウザ body の `actor_user_id` は信用しない。wellfort-site で検証した値だけを注入する。**
- `batches` の作成者も同じ形（`created_by_user_id` / `created_by_masked`・§23.1）。
- UUID は PII ではなく、後から `admin_users` を引けば人に戻せる＝**追跡性と PII 非保存が両立する**。

**O8. ZIP / XLSX を読む手段 — 解決（2026-09-10・Phase D-0 で実測比較・v0.4 で CLOSE）**
候補 11 本を一次資料（npm registry / OSV / 各 README・型定義）で比較し、
**ZIP = `@zip.js/zip.js`（案 L）／ XLSX = `read-excel-file`（案 H）**に決めた。**案 M（自作）は不採用**
— §5.3.4-4 の「①②を満たすライブラリが無いときだけ自作」の条件を満たさなかったため。
**SheetJS `xlsx` と `node-xlsx` は採用不可**（npm に修正版の無い HIGH 2 件・§5.3.6）。
比較表と選定理由は §5.3.5〜§5.3.8。**ただし動かして確かめてはいない** — Phase D の最初に
実測することを §5.3.9 に 5 件挙げてある（**「決めた」と「動く」を混同しない**）。

**O5. 問診 XLSX / PDF の実列・実レイアウト — 解決（2026-09-10・発注者から実列の提示・v1.0 で CLOSE）**
発注者より **8 ファイルとも同一の 62 列構成**であること、先頭 6 列が
`ID` / `開始時刻` / `完了時刻` / `メール` / `名前` / `最終変更時刻` であること、
以降が共通問診項目であることの提示を受けた。
→ **`questionnaire-map.ts` に明示の写像表**を実装（`COLUMN_TO_QUESTION` /
`COLUMN_TO_MATRIX_ROW` / `VALUE_ALIASES`）。**fuzzy な LLM 推測は使わない** —
完全一致か、この表に書いた読み替えだけ。写像に無い列・値は **`unmapped`** として
管理画面に出し、**1 項目未対応で人物全体を失敗にしない**。
`完了時刻` を問診実施日時として扱い、既存仕様どおり `test_date` を作る。
**氏名・メール・生年月日は Elith JSON へ入れない**（`sex` / `age` だけ渡す）。
問診 PDF は 2 様式（`welltect_common_v1` / `ai_prevention_short_v1`）を判定し、
共通の内部形式 `QuestionnaireNormalized` を経て**既存 `buildElithInterviewJson()`** へ入れる。

### 28.2 未確定（`OPEN`）

| # | 論点 | 影響 | 既定（Phase 1） |
|---|---|---|---|
| **O2** | **臨時バッチの原本を 10 年保管（Object Lock）の対象にするか。** 原本用バケットは削除不可なので、氏名・DOB を含むファイルを入れると消せない | 保管ポリシー | **保存しない**（`retain_originals=false`）。受け皿だけ用意 |
| **O3** | **元ファイル名を DB に保存するか。** 氏名が含まれ得る（指示書 §10）。保存しないと現場が原本を追いにくい | 運用性 vs PII | **保存しない**（`{分類}_{連番}{拡張子}` に置換） |
| **O4** | **ブラウザで「必要なエントリだけ部分展開」が実機で成立するか**（`File.slice()` ＋ `DecompressionStream('deflate-raw')`、または §5.3 で選ぶライブラリの部分読み API）。代替として **S3 の CORS に `GET` を足すか**（CLAUDE.md は「`GET` も足さない」） | 遺伝子 PDF のページ画像化経路 | ブラウザ内で**部分読み**（§11.5。**全体展開は禁止**）。**再読込後は ZIP を選び直す** |
| **O9** | **presigned PUT で `Content-Length` が署名対象になるか / ブラウザから明示できるか / 違うサイズを S3 が拒否するか**（§5.2.1 の 3 点）。既存コードのコメントと `signableHeaders` の実装が食い違っている | サイズ防御の設計 | **署名に依存しない**。①ticket 発行時上限 ②アップロード後の `HeadObject` ③ZIP 解析時の展開上限 の**多層で守る**（§5.2.1） |
| **O6** | `10名の情報.xlsx` の `実施日` の意味 | `bundle_date` の自動決定 | **転用しない**（§14.4） |
| **O7** | Elith 側に既存 manifest 定義があるか | §15.4 | 定義があればそれに合わせる。無ければ §15.4 の最小形 |

**`OPEN` を推測で埋めない。** 埋めた瞬間にこの文書は「決定仕様」でなくなる。

---

## 29. 実装フェーズ

| Phase | 内容 | Production |
|---|---|---|
| A | 調査（git / docs / DB / 既存 API / originals / Elith 出力 / health age） | 触れない |
| **B** | **本仕様書の作成・保存** | 触れない |
| C | DB migration（**ファイル作成のみ**） | **適用禁止** |
| **D-0** | **§5.3 の 3 案比較 → ZIP / XLSX の手段を決定し §5.3 を「決定」へ格上げ**（**これが済むまで D に入らない**） | 触れない |
| D | parser / lib（archive・分類・XLSX・state・fingerprint）を単体で実装 + unit 検査。**問診 parser は O5 が解消するまで着手しない**（共通基盤までは先行可） | 触れない |
| E | Scan-Chat-AI 側 管理 API | 触れない |
| F | wellfort-site 側 6 ステップ UI + 中継 API | 触れない |
| G | 既存 Elith / HealthAge との接続 | 触れない |
| H | integration / regression | **dry-run のみ** |
| I | 実装差異を本仕様書へ反映 | — |

---

## 30. 変更履歴

| 版 | 日付 | 内容 |
|---|---|---|
| **0.4** | 2026-09-10 | **Phase D-0（ZIP/XLSX ライブラリの比較）を実施し §5.3 を「未決定」から「決定」へ格上げ。O8 CLOSE。** 候補 11 本を**一次資料から実測**（`registry.npmjs.org` / `api.osv.dev` / 各 README・`index.d.ts`）。**ZIP = `@zip.js/zip.js`**（直接依存 0・既知脆弱性 0・BSD-3-Clause・最終公開 2026-09-09。**ブラウザの `BlobReader` とサーバの Range GET を同じ `ZipReader` で賄えるので ZIP の解釈を 1 本に統一でき、§24.3 の検査も 1 か所で済む**。`filenameEncoding`/`decodeText` で CP932 も扱える）。**XLSX = `read-excel-file`**（MIT・既知脆弱性 0・最終公開 2026-08-10・ブラウザ/Node 両対応。**セル値を `Date` で返す**＝日付シリアル値の判定をライブラリが持つ。`test_date` は納品パスと 🎯 照合を決めるので自前判定で静かに 1 日ずらすわけにいかない）。**案 M（自作）は不採用**。**SheetJS `xlsx` / `node-xlsx` は採用不可** — `GHSA-5pgg-2g8v-p4x9`(HIGH) の advisory 本文が**「npm に修正版が存在しない」と明記**しており、実測でも npm は **0.18.5(2022-03-24) で停止**。もう 1 件 `GHSA-4r6h-8v6p-xvw6`(HIGH・Prototype Pollution) は**「細工されたファイルを読むとき」＝本機能そのもの**が該当（§5.3.6）。`adm-zip` も除外（`GHSA-vwc7-r8mq-g2x9` が `last_affected=0.6.0` ＝**最新版がまだ影響下で修正版が無い**）。`jszip` は全体メモリ展開で §11.5 に反するため不採用。**採用 2 本の弱点も隠さず記録**（`read-excel-file` の依存 4 本中 2 本が同一の単独メンテナ・v9 で API 破壊あり → 呼び出しをパーサ 1 枚に閉じ込める）。**まだ動かして確かめてはいない** — Phase D 冒頭で実測する 5 件を §5.3.9 に明記（full-ICU の有無・ブラウザ実機のピークメモリ・S3 Range の往復・実物 XLSX・バンドルサイズ）。 |
| **1.0** | 2026-09-10 | **実装完了（§31）。** ZIP 投入 → S3 → 解析 → 人物分離 → 分類 → 健診/遺伝子/問診 → 人物整合 → ウェルネス年齢 → 管理者確認 → Elith JSON → 納品セット → dry-run → 管理 UI まで通した。**O5 を CLOSE**（発注者から 62 列の実列の提示。明示の写像表を実装し fuzzy 推測は使わない）。**DB 6 表を実コードから使用**（`store.ts` が唯一の口・migration を置いただけの状態を解消）。**Genoplan は既存 `scanGeneticPage` を再利用**しページ単位保存・キャッシュ・失敗ページ retry まで接続。**ウェルネス年齢は既存 `computeWellnessAge()` を呼ぶだけ**で、`unavailable` でも人物を failed にしない。**納品は既定 dry-run**（S3 key / JSON body / format / 検証 を書き込み前に確認できる）。検証は **archive 85 / parse 113 / e2e 92 / zip-digest 40**、`astro check` 0 errors、両リポジトリ build 成功、既存 A 層 11 本と `verify:screen` 47/47・`verify:scan-pages` 47/47 に回帰なし。実装中に直したもの: ①**ワークブックの二重読み**で片方の失敗がもう片方を道連れにしていた → 1 回読んで両方に使う ②`sanitizeMeasurementsForDelivery` の戻り値を配列と誤認（実際は `{ kept, anomalies }`） ③**単一選択の設問まで配列**にしていた（`multi` のときだけ配列が正） ④`S3RangeReader` が zip.js の Reader 契約（末尾をまたぐ要求）に合っておらず 416 を招く形だった → `clampReadLength()` で `min(length, size - offset)` に丸め、`offset >= size` は空を返す ⑤設定未了を 500 で返していた → **503 と理由**。 |
| **0.5** | 2026-09-10 | **Phase D 着手前に、発注者指示で経路を 3 点 確定。** **A. ブラウザの SHA-256 を逐次計算へ（§11.6・新設）** — `SubtleCrypto.digest()` は **`BufferSource` を 1 個受け取る一発 API で `update()` を持たない**ので、`file.stream()` を読んでも結局全体を連結することになり省メモリにならない。→ **wellfort-site に `@noble/hashes` を追加**し `sha256.create()` → `update()` → `digest()` で計算する。**ZIP 全体を `arrayBuffer()` 化して `crypto.subtle.digest()` へ渡すのは禁止。** **①初回 ticket 発行前の `source_sha256` と ②再読込後の同一性照合を同じ実装で処理する**（別実装にすると「同じ ZIP なのに一致しない」が起き、**再開が黙って新規バッチになる**）。**`source_sha256 NOT NULL` の DB 設計は変更不要**（逐次でも ticket 前に確定する）。実測: 2.4.0 / MIT / 依存 0 / 既知脆弱性 0 / `engines: node>=20.19.0`、**import は `@noble/hashes/sha2.js` で `.js` 必須**（`exports` に `"./sha2"` は無い＝拡張子を落とすと解決失敗）、`create`/`update`/`digest` は `utils.d.ts:504/419/430`。 **B. サーバ側 ZIP は custom `Reader` → AWS SDK Range（§5.3.7.1・新設）** — **presigned GET は使わない**（署名付き URL という秘密を増やさない・既存の資格情報で完結する経路から外れない）。`readUint8Array(offset,length)` の中で `GetObjectCommand` に `Range: bytes=offset-(offset+length-1)` を付ける。**Range は両端を含む閉区間**なので終端に `offset+length` を書くと 1 バイト多く読み Central Directory の解釈がずれる=検証で固定。`ZipReader` はブラウザ側と同一なので **§24.3 の検査は 1 か所のまま**。`size` は §5.2.1 ② の `HeadObject` と同じ呼び出しで取る。 **C. `read-excel-file` はサーバ側だけ（§5.3.8.1・新設）** — ブラウザが触るのは ZIP 部分読み / SHA-256 / pdf.js の 3 つだけ。実物 XLSX で **Excel 日付 / カスタム日付書式 / 1900・1904 date system / 空欄と 0 / 日本語ヘッダー** の 5 点を必ず実測する。**カスタム日付書式は自動判定できない場合があるので、判定できないものを勝手に日付化しない** — 数値のまま持ち `needs_review` にする（シリアル値の変換は 1900/1904 の決め打ちが要り、**4 年ずれた日付を静かに作る**＝捏造）。**`test_date` が確定しない人物は納品しない**（今日の日付や別ファイルの日付を流用しない）。 |
| **0.4** | 2026-09-10 | **発注者レビューで migration を DB 適用前に 3 点修正（Phase C 最終 PASS）。** **A. ZIP のサイズを申告値と実測値に分離**（§23.1）— **`declared_source_size`(NOT NULL) / `source_size`(NULL 可)**。理由は **batch 行が出来るのが ticket 発行時点で、まだ PUT が済んでいない**こと。1 列に混ぜると**申告値を実測値として保存する**ことになる。`source_size` は **classify 開始時の `HeadObject` で確定**させ、上限超過なら `failed` ＋一時 ZIP 削除。**申告値をここへ入れない**。 **B. 操作者識別の正を `actor_user_id`（uuid）にして O10 を CLOSE**（§21 / §22 / §23.1 / §28.1）— wellfort-site は既に `/auth/v1/user` で認証済みユーザーを取得している（`elith-scan.ts:34-39` と同形）ので、**`user.id` をサーバ側で注入**する。`actor_masked` は表示用・`actor_sha256` は任意の補助へ降格。**ブラウザ body の `actor_user_id` は信用しない。** `batches` にも `created_by_user_id` / `created_by_masked`。UUID は PII でなく後から `admin_users` で人に戻せる＝**追跡性と PII 非保存が両立**。 **C. `subject_fp` の表現を弱めた**（§6.2.1）— 「PII を引き出す経路が**原理的に無い**」は言い過ぎ。**平文の PII は含まないが、特定個人のファイル群に 1 対 1 で対応する照合用識別子**なので、**機微情報と同等に扱う**（ログに出さない・外部へ渡さない・納品 JSON に載せない）へ修正。 **検証**: scratch PostgreSQL 16 に**全 17 migration を白紙から適用 OK**・再適用も冪等・`ix_ad_hoc_subjects_batch_fp` が**非 UNIQUE**であること・**同一 batch 内の fp 衝突が 2 行とも INSERT できる**こと・`declared_source_size` NOT NULL / `source_size` が後から埋められること・`actor_user_id` / `created_by_user_id` が UUID を受けること・RLS force＋policy 0＋`anon`/`authenticated` に権限が無いことを実測。 |
| **0.3.1** | 2026-09-10 | **Phase C（migration ファイル作成）で実装した形に §21 / §23 を同期。** ①**監査ログの `actor` を `actor_masked` + `actor_sha256` に変更** — §21 は「admin の email」と書いていたが、**Scan-Chat-AI 側にメールの現物を置かない**既存の規律（`demo.account_emails`・CLAUDE.md）に合わせた。**発注者確認事項**（§28.2-O10） ②`required_formats` / `optional_formats` を**別列**に ③`created_by` も `_masked` / `_sha256` の 2 列に ④`pages` に **`file_sha256` を非正規化**（キャッシュ参照 `(file_sha256, page_no)` を 1 索引で引くため・§19.3） ⑤`outputs` に **UNIQUE (subject_id, format_id)** を明記 ⑥`batches.source_sha256` は**一意にしない**（再投入は検知して警告するだけ・§19.1）ことを明記。 |
| **0.3** | 2026-09-10 | **発注者レビューで 2 点を修正（Phase C 着手前）。** **A. `subject_fp` の UNIQUE 制約を撤回** — v0.2 は「衝突したら両方を `needs_review` で残す」と `UNIQUE (batch_id, subject_fp)` が**矛盾していた**（UNIQUE があると 2 人目の INSERT が失敗し「両方残す」が実行できない）。**`subject_fp` は再開時の照合用の検索キーであって一意識別子ではない**と位置づけを確定し、**同一 fp が複数人物に存在し得ることを仕様として認める**。制約を**通常 INDEX `(batch_id, subject_fp)`** へ変更し、再開時は**ヒット件数で判定**（0 件=`unmatched` / 1 件=`match` / **2 件以上=`fp_collision` で該当 subject を全件 `needs_review`**）。**`UNIQUE (batch_id, subject_no)` は維持**。**B. `Content-Length` の「署名固定」を未確認へ落とした** — 実測すると `scan-upload-ticket.ts:129` の `signableHeaders` は **`content-type` だけ**で、返す `headers` にも Content-Length は無い（`:132`）。同ファイルのコメント `:21-22`/`:127`/`:158` は「署名に固定」と書いているが**実装と食い違う**ので根拠にしない。→ 断定を撤回し、**サイズ防御を ①ticket 発行時上限 ②アップロード後 `HeadObject` の実サイズ検証 ③ZIP 解析時の展開上限 の多層**にした（**②が本命**・§5.2.1）。署名の実挙動 3 点は O9 として Phase D-0 / upload-ticket 実装時に実測する。 |
| **0.2** | 2026-09-10 | **発注者レビューで 3 点を修正。** ①**ZIP/XLSX の自作リーダを「決定仕様」から外した** — 「`package.json` に無いから自作」は依存追加禁止の根拠にならない、という指摘。§5.3 を「案 L(ライブラリ) / 案 H / 案 M(最小自作) を **8 観点**（セキュリティ・メモリ・ZIP64・data descriptor・文字コード・保守性・Vercel 対応・XLSX 必要機能）で比較して **Phase D 着手前に決める**」へ書き換え、**医療関連データなので独自 ZIP parser を第一選択にしない**と明記。手段によらず満たす要件（Central Directory を正 / エントリ単位で読む / ZIP security は自分でも検査 / サイズは宣言値と実バイトの両方で判定）は決定仕様として残した。あわせて**`.xls` を受入対象から外した**（OLE2 で ZIP/XML ではない → `unsupported_file` として一覧に出す） ②**ブラウザ側の ZIP 全体メモリ展開を禁止**。`File.slice()` で **Central Directory ＋ 処理中の 1 エントリだけ**を載せる形へ（サーバの S3 Range GET と同型）。SHA-256 も逐次計算。ピークメモリを実測で見張る ③**§6.2 を新設**: 再開時に「この人物 = この client_id」を取り違えない仕組み。**内容ハッシュだけから作る非可逆 `subject_fp`**（氏名・フォルダ名・ファイル名を材料にしない＝PII を引き出す経路が無い・秘密鍵も不要）で結び直し、**ヒットしなければ推測で寄せず `needs_review`**。`UNIQUE (batch_id, subject_fp)` で衝突も検出する。§6.1 / §23.2 に列を追加し、§29 に **Phase D-0（手段の決定）** を挿入。 |
| 0.1 | 2026-09-10 | 初版。発注者指示書（臨時診断バッチ）を受けて Phase B として作成。**責務境界は 2026-09-10 の発注者確定（UI=wellfort-site / 処理=Scan-Chat-AI）を反映**し、指示書初版の「Scan-Chat-AI に UI」は §28.1 に訂正記録として残した。ZIP は presigned PUT・`GATING_FORMAT_IDS` 不変・案件別 `required_formats` を決定（**ZIP/XLSX の読み方は v0.2 で未決定へ差し戻した**）。未確定 6 件を §28.2 に分離。 |

---

## 31. 実装（v1.0・2026-09-10）

**この節は「どこに何が在るか」だけを書く。** 決定の理由は各節（§5〜§24）が正。

### 31.1 Scan-Chat-AI（処理・API）

| ファイル | 役割 |
|---|---|
| `src/lib/ad-hoc-diagnosis/keys.ts` | S3 キーの採番と**完全一致**検証（§24.2） |
| `src/lib/ad-hoc-diagnosis/ticket.ts` | presigned PUT 発行 ／ `HeadObject` の実サイズ検証 ／ 一時 ZIP 削除（§5.2.1） |
| `src/lib/ad-hoc-diagnosis/archive.ts` | **ZIP を触る唯一の場所**。`S3RangeReader` ／ §24.3 の検査 ／ 文字コード probe |
| `src/lib/ad-hoc-diagnosis/classify.ts` | 決定論の分類（§7）。`ELITH_ALLOWED_FORMATS` |
| `src/lib/ad-hoc-diagnosis/fingerprint.ts` | `subject_fp` とヒット件数での照合（§6.2） |
| `src/lib/ad-hoc-diagnosis/health-checkup-xlsx.ts` | **`read-excel-file` を触る唯一の場所**。日付の確定（§5.3.8.1） |
| `src/lib/ad-hoc-diagnosis/questionnaire-map.ts` | 62 列 → `question_id` の**明示の写像表**（§11.3） |
| `src/lib/ad-hoc-diagnosis/questionnaire.ts` | XLSX / PDF 2 様式 → `QuestionnaireNormalized` |
| `src/lib/ad-hoc-diagnosis/pipeline.ts` | ZIP 解析 → 人物分離 → 各 format の JSON ／ ready 判定 ／ 納品 key |
| `src/lib/ad-hoc-diagnosis/store.ts` | **DB 6 表を触る唯一の場所** |
| `src/lib/ad-hoc-diagnosis/service.ts` | API から呼ぶ「動詞」。`store` と `pipeline` を繋ぐ |
| `src/pages/api/admin/ad-hoc-diagnosis/*.ts` | 8 ルート（下記）。**手続きを書かず `service` を呼ぶだけ** |

**API（すべて Bearer `ADMIN_API_KEY`。取り込み専用キーは通さない）**

| メソッド | パス | 役割 |
|---|---|---|
| POST | `upload-ticket` | batch 作成 + presigned PUT 発行。同一 ZIP の再投入を**警告だけ**返す |
| POST | `classify` | `HeadObject` → ZIP 解析 → 人物分離 → 分類 → DB |
| GET | `status` | 画面が見る状態（batch / subject / file / output / 監査） |
| POST | `confirm` | 管理者の分類修正と人物識別の確定。**監査に残す** |
| POST | `process` | 解析して Elith JSON を作る（**S3 へは書かない**）。遺伝子は 1 ページ = 1 リクエスト |
| POST | `health-age` | 人物ごとのウェルネス年齢（**保存しない**） |
| POST | `export` | 納品セット。**既定 `dryRun: true`** |
| POST | `retry` | 失敗ページ・ファイルを `pending` へ戻す |
| GET | `file` | ZIP 内の 1 ファイルの**生バイト列**（ブラウザが PDF をページ画像化するため） |

### 31.2 wellfort-site（UI・中継）

| ファイル | 役割 |
|---|---|
| `src/pages/admin/ad-hoc-diagnosis.astro` | 6 ステップの管理画面。**実 API に繋がっている** |
| `src/pages/api/admin/ad-hoc-diagnosis/[...path].ts` | 中継。**allow-list の 9 パスだけ**。`file` は生バイト列を素通し |
| `src/scripts/ad-hoc-diagnosis/zip-digest.ts` | 逐次 SHA-256（§11.6） |
| `src/components/AdminLayout.astro` | サイドバー「検査連携 › 臨時診断バッチ」 |

**操作者の注入**: 中継が `/auth/v1/user` で検証した `user.id` を
`x-ad-hoc-actor-user-id` に載せる。**ブラウザ body の `actor` 系は削除してから転送する**（§21）。

### 31.3 検証

| コマンド | 件数 | 中身 |
|---|---|---|
| `npm run verify:ad-hoc-archive` | 85 | キー検証 ／ §24.3 の各検査 ／ Range の算術 ／ 文字コード probe |
| `npm run verify:ad-hoc-parse` | 113 | 分類 ／ fingerprint ／ **実物 .xlsx** での日付・空欄・和文見出し |
| `npm run verify:ad-hoc-e2e` | 92 | **ZIP → 分類 → 解析 → 納品 (dry-run)** の通し |
| `npm run verify:zip-digest`（wellfort-site） | 40 | 逐次 SHA-256 が `crypto.subtle` と一致 ／ 確保量 |

**S3 も DB も Gemini も要らない。** ZIP も XLSX もその場でコードから組む
（`scripts/lib/make-test-xlsx.mjs`）ので、**バイナリを commit しない**。
CI は `static-required`（A 層）で 3 本とも走る。

### 31.4 実装で決めたこと（§ の決定に足したもの）

- **`HealthAgeData` は `outputs.format_id` の許可集合に無い**ので、DB には `Other` として
  記録し `error_detail` に `HealthAgeData:{method}` を残す。**納品 JSON の `format_id` は
  `HealthAgeData`** のまま（Elith 側の名前を変えない）。
- **ワークブックは 1 回だけ読む。** 健診と問診で 2 回読むと、片方の失敗が
  もう片方を道連れにする（実測）。`readWorkbookSheets()` の結果を両方で使う。
- **`sanitizeMeasurementsForDelivery` の戻り値は `{ kept, anomalies }`**（配列ではない）。
  納品に載せるのは `kept` だけで、`anomalies` は監査へ回す。
- **単一選択の設問は文字列**、`multi` のときだけ配列（`interview-script.ts` の
  `QuestionDef.multi` に合わせる）。常に配列にすると既存の表示・書き出しが
  「1 件の配列」を受け取ることになる。
- **設定が無いだけのときは 500 にしない。** Supabase / S3 未設定は **503 と理由**を返す。
