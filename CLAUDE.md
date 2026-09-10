# CLAUDE.md — このリポジトリで作業する前に必ず読む

この文書は **確定済みの決定事項と、その根拠ドキュメントの索引**。
作業前にここと該当ドキュメントを読み、**推測・再質問で確定事項を蒸し返さない**こと。

## 作業ルール (厳守)

1. **まず `docs/` を読む。** 質問する前に、関連ドキュメントを検索・精読する
   (`docs/`, `docs/operations/`, ルートの各 `*.md`)。答えは大抵書いてある。
2. **確定事項 (下記) を再質問しない。** 変更や矛盾があるときだけ確認する。
3. 決定が変わったら **この CLAUDE.md と該当ドキュメントを更新**してから進む。
4. 憶測で仕様を作らない。ドキュメントに無い場合のみ、明示して確認する。

## 調査・推測のアンチパターン (厳守・上記ルール1/4の具体化)

> 実障害 (2026-07): GMO決済のサブスク課金情報が渡らず、`gmo-return.ts:54-55` を読めば即分かる
> 真因 (`GMO_API_BASE_URL` テスト値残存が `gmoApiBase` を最優先で pt01 に固定) を、根拠の無い仮説
> (存在しない「本番/テスト Vercel」「結果通知URL」「GMO_LINK_BASE_URL 変数」「取引区分＝即時売上」
> 「戻り先URL=/products/complete」等) を**断言→撤回**で何本も繰り返し、泥沼化させた。全て以下違反。

- **R1. 断言には出典を付ける。** 外部システム/env/UI/変数名/仕様に触れる主張は必ず
  `file:line` か 公式ドキュメントの節・URL か 実際の値 を添える。**出典を出せない主張は
  「未確認の仮説」と明示ラベルを付け、断定文で書かない。**
- **R2. 「存在するか」を先に確認する (捏造ゼロ)。** env変数・設定項目・UIフィールド・変数名を
  名指しする前に、必ず grep (コード) か 公式ドキュメント該当箇所 を先に引く。
  「引けば無いと分かるもの」を口にしない。
- **R3. 外部システムは記憶でなく一次資料。** GMO-PG 等の外部仕様は学習知識を根拠にしない
  (信頼性が低い)。公式ドキュメントで確認してから述べる。不明なら「公式で要確認」と言う。
- **R4. 原因はコードのフローで特定。ユーザーに無駄確認をさせない。** 「ログを見て」等の外部確認を
  頼む前に、自分でできるコード/docs追跡を尽くす。順位付けは"勘の自信度"でなく
  **コードパスが実際に何で分岐するか**で行う。
- **R5. 反証が来たら即座に仮説を捨てる。** ユーザーが事実を示したら固執せず即撤回し次へ。
  粘って再主張しない。

## 確定事項 (Settled decisions)

### 設定値の置き場所 (env / app_config の切り分け・2026-08 確定・発注者判断)

**判断基準は「秘匿性」**。

| | 置き場所 | 対象 |
|---|---|---|
| **秘匿性が高い** | **env 継続** (Vercel 環境変数) | API キー・シークレット・接続情報 |
| **秘匿性が低く、切り替えが想定される** | **`diagnosis.app_config` (Supabase) → admin で管理** | 使用モデル・スキャン精度フラグ・画面文言 |

env は「現在値が見えない」「変えるたびに再デプロイが要る」ため運用パラメータに不適、というのが理由
(マイグレーション `supabase/migrations/20260815000010_app_config.sql` の冒頭コメントに記載)。

- **優先順位 = DB値 → コード既定** (`src/lib/app-config.ts` の `CONFIG_SPECS[].default`)。
  **env フォールバックは廃止済み**。旧 `SCAN_*` / `GEMINI_*_MODEL` env は**コードから参照されていない**
  (grep でヒット 0) ので、Vercel 側に残っていても無視される。撤去してよい。
- 反映は TTL 45 秒 (`app-config.ts` の `TTL_MS`)。各 API は処理前に `refreshConfig()` を呼ぶ。
- 変更 API = `src/pages/api/admin/config.ts` (Bearer `ADMIN_API_KEY`)。
  GET でカタログ+現在値、POST で upsert。**UI は wellfort-site admin 側** (この作業ツリーには
  未取得のため実装状況は未確認)。

**app_config の現行キー (28 件・`CONFIG_SPECS` の実測)**: `ui.support_contact` / `ui.health_age_followup` /
`demo.account_emails` / `demo.account_uids` / `demo.account_denied_uids` / `demo.seeded_from_admins` /
`ui.cancer_screening_not_included` / `ui.save_steps` / `report.sections.order` / `report.sections.hidden` /
`report.sections.labels` / `report.sections.collapsed` /
`scan.model` / `live.model` / `scan.output_format` / `scan.boundary_recheck` / `scan.obs_dedup` /
`scan.scramble_fix` / `scan.eye_resolve` / `scan.lipid_fix` / `scan.canonicalize` /
`scan.perception_repair` / `scan.vqa_rowcrop` / `scan.ai_prediction_dedup` /
`fabgate.unperformed` / `fabgate.refbleed` / `fabgate.reftable` / `fabgate.adjacent`

**【重要】この文書の下の方に残っている `env SCAN_XXX` という表記は、すべて app_config キーの
読み替え**で理解すること (`SCAN_BOUNDARY_RECHECK` → `scan.boundary_recheck` のように
小文字ドット区切り。`SCAN_FABGATE_*` → `fabgate.*`)。**env として設定しても効かない。**

**env に残すもの (秘匿値・実測 grep)**: `GEMINI_API_KEY` / `ADMIN_API_KEY` /
`SUPABASE_SERVICE_ROLE_KEY` / `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_ANON_KEY` /
`HP_BRIDGE_SUPABASE_URL` / `HP_BRIDGE_READONLY_KEY` / `HP_EDGE_BASE_URL` /
`RESOLVE_SHARED_SECRET` / `PUBLIC_GOOGLE_CLIENT_ID` / `PUBLIC_DEMO_FALLBACK` /
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` / `AWS_S3_BUCKET` /
`AWS_S3_PREFIX` / `AWS_S3_ENDPOINT` / `AWS_S3_ORIGINALS_BUCKET` / `AWS_S3_ORIGINALS_PREFIX`
(wellfort-site 側は `SCAN_CHAT_AI_API_KEY`)。

### 環境変数・キー管理
- **API キー (Gemini / AWS S3 など) は Vercel 本番環境の環境変数で一元管理**。
  **ローカル `.env`・operator PC・クライアントには置かない。**
  - 根拠: `docs/operations/Gemini_APIキー作成手順書_Wellfort_v1.0.md` L26 / L153
    「UNFIX が受領した API キーを Vercel 本番環境の環境変数 `GEMINI_API_KEY` に設定」。
  - キーローテーション: 3 か月に 1 回程度 (同 L155)。法人パスワードマネージャに保管 (L154)。
  - **キー形式変更 `AIza`→`AQ.`**: 新 `AQ.` キーで本アプリはそのまま動作 (ネイティブ endpoint に
    `x-goog-api-key` ヘッダ + 公式SDK 利用のため。コード変更不要)。
    **旧 `AIza` は 2026-09 に失効** → それまでに Vercel の `GEMINI_API_KEY` を `AQ.` キーへ差し替える
    (運用のみ)。詳細: `docs/operations/Gemini_APIキー作成手順書_Wellfort_v1.0.md` §7.1。
  - Gemini 呼び出しは `src/lib/gemini.ts` に集約。キーは `x-goog-api-key` ヘッダ送信 (URL に載せない)。
- **使用モデルは app_config (DB) で差替え可 (コード変更・再デプロイ不要・admin から即時)**。
  `src/lib/gemini.ts` の `MODELS` は getter で、`scan.model` / `live.model` を都度参照する。
  **旧 `GEMINI_SCAN_MODEL` / `GEMINI_LIVE_MODEL` env は廃止 (コードに存在しない)**。
  - スキャン (画像解析・全 REST 呼び出し): 既定 **`gemini-3.1-flash-lite`** (軽量・安定)。`scan.model` で上書き。
    精度を上げるなら `gemini-3.5-flash` (GA) だが、**混雑時に 503(model overloaded) が出やすくバッチ全滅の実績あり (2026-07)**
    ため常用の既定は 3.1-flash-lite に据え置き。Tier1 未開通/不具合時は `gemini-2.5-flash` (旧既定) へ。
    ※ 正式ID は Gemini API 公式 (ai.google.dev/gemini-api/docs/models/gemini-3.5-flash) で確認: Stable=`gemini-3.5-flash` /
      Preview=`gemini-3-flash-preview`。**末尾-preview無しの `gemini-3-flash` は Gemini API に存在しない** (設定すると全スキャン失敗)。
    - **前提**: 3.x 系は **Tier1 (課金有効化) + 当該キーでのモデルアクセス** が必要。未開通のまま 3.x を指すと
      全スキャン (検診/がん/血液image/遺伝子) が失敗する → その場合は env で 2.5 に戻す。
    - スキャン精度は **検診 numeric → ウェルネス年齢 (CABA)** に直結。モデル切替時は代表ページで再検証すること。
  - **Live (AI問診)**: 既定 `gemini-3.1-flash-live-preview` (REST 非対応の専用プレビュー)。`live.model` で追従。
    経路: `chat` 画面 (`live-controller.ts`) → `POST /api/live-token` → `MODELS.liveChat`
    → `getLiveModel()` → `cfg('live.model')`。**実際に何が使われているかは DB の値次第**なので、
    確認するときは `select value from diagnosis.app_config where key='live.model'` を見る
    (行が無ければコード既定)。
  - **スキャン出力形式 `SCAN_OUTPUT_FORMAT` (既定 `markdown`)**: `json` で **responseSchema 構造化出力** 経路に切替
    (Phase 2)。Markdown 表は列帰属が自由すぎ定性記号 `(-)` が run 毎に基準列へ吸われる (Semantic Tie) ため、
    value/ref_high をフィールドで固定して列ズレを構造的に断つ狙い。Gemini/ChatGPT 両者の一致見解 (2026-07)。
    **未検証のうちは既定 `markdown` のまま**。代表ページで 🎯ゴールデン照合の回帰ゼロを確認してから `json` へ寄せる。
    プロンプト/スキーマは `src/lib/scan-prompt.ts` の `ANALYZE_SYSTEM_JSON` / `SCAN_RESPONSE_SCHEMA`。読取ルール
    (今回のみ・推論値隔離・総合判定除外・疎ページ) は Markdown 版と同一。両経路とも `toMeasurements` 以降を共用。
    - **検証結果 (2026-07・🎯決定論比較)**: json は列は安定するが**補助欄が暴走**する (未実施項目の value に基準値を
      流し込む捏造=False-Value 8件・重複12・rows120 の実測)。値一致率は markdown と同点。**json は不安定で
      ゴール①(余剰/誤り排除)に不利** → **既定 `markdown` で確定運用**。json 経路はコード温存 (将来の補助欄抑制改良用)。
  - **境界定性の2パス再読 `SCAN_BOUNDARY_RECHECK` (既定 off・`on` で有効)**: numeric は安定だが定性/境界
    (尿蛋白/尿潜血/尿糖/免疫便潜血/K-W) が run 毎に入れ替わりで空返しされる (検出の揺れ=非決定)。一次パスで
    空だった該当項目**だけ**を、その画像へ軽量シングルタスクで再読しギャップ埋めする (`boundaryRecheck`・既存値は
    絶対に上書きしない=numeric不変・空返しは埋めない=捏造しない)。モード非依存。🎯回帰ゼロ確認後に常用する想定。
- **確定運用 (2026-08・人間ドック決定論スタック確定)**: 本番 env は **`SCAN_OUTPUT_FORMAT` 未設定(=markdown) +
  `SCAN_BOUNDARY_RECHECK=on` + `SCAN_OBS_DEDUP=on` + `SCAN_SCRAMBLE_FIX=on` + `SCAN_EYE_RESOLVE=on` + `SCAN_LIPID_FIX=on`**。
  すべて**捏造ゼロ(出力値は実読値のみ・新値を作らない)**・env off で挙動不変・🎯回帰ゼロで on 化。**Phase 2-2 決定論修正スタック** (hc-merge finalize 順):
  1. **推移グラフ非納品** (⑧-2「検査結果の推移」由来を詳細に同概念あれば除外・trend のみは残す=漏れ防止)。
  2. **dedup** (`observation-dedup`・同値統合/別値は競合記録=自動採用しない)。
  3. **肝鉄 scramble 再割当** (`scramble-detect.reassignScramble`・env `SCAN_SCRAMBLE_FIX`): 値がラベル基準に不適合 かつ
     別項目Bの基準に**唯一**適合 かつ B欠落 → B へラベル付け替え。**block内限定**(liver/iron。血清鉄40-188がALP/LDHと重複するため)。
     例 γ-GTP=157→LDH・ChE=78→ALP・TIBC=43→血清鉄。検知は再割当**前**に実行(偽陽性防止)。
  4. **眼科 collapsed-row** (`collapsed-row.resolveEyeCollapsed`・env `SCAN_EYE_RESOLVE`): `右眼`/`左眼` ちょうどの行を値域で
     種別へ (0.01-2.0→裸眼視力/5-30→眼圧/定性→眼底所見・左右別・付け替え先が既存なら作らない・範囲外は不触)。
  5. **脂質 LDL↔TG 物理制約修正** (`lipid-fix.fixLipidSwap`・env `SCAN_LIPID_FIX`): 不変量 **LDL+HDL≤TC**。現状 LDL+HDL が
     TC を MARGIN(15)超で超え(物理不能)、LDL↔TG 入替で解消するときだけ両行の値を交換(Friedewald絶食仮定不要=施設非依存)。
  - **受容する確率的残差 (決定論で取れない=確定運用で許容)**: **分画の同レンジ入替**(好酸球↔好塩基球・独立制約なし)、
    **系統脱落**(run依存で 好酸球/LDH/γ-GTP/血小板/身長 等が時々落ちる)。実務は**別 run 引き直し**で吸収。
    (b)完全性チェック+ターゲット再読は VQA 信頼性課題(実測で眼圧を19.0と誤読)のため保留。
  - **多数決(N-run)は撤回**: 名称が run 毎に揺れるため semanticKey で整合できず union 膨張(rows95→123・重複15・捏造5)=逆効果と実証。
    scramble は「run毎に別ブロック」だが、レンジ再割当(単一run・跨run整合不要)の方が安全で確実。
  - **wellfort-site admin 表示**: `🔧再割当`/`👁眼科`/`🧪脂質`/`⚠scramble疑い(残)` を監査表示(納品 data には含めない)。
- **(旧・検診の確定運用) 2026-07・🎯検証済**: 本番スキャンは **`SCAN_OUTPUT_FORMAT` 未設定(=markdown) + `SCAN_BOUNDARY_RECHECK=on`**。
  🎯決定論ゴールデンで numeric 全一致・False-Value 0・Shift/Wrong 0 を確認。名称ゆれ(血圧最高/最低・白血球数↔白血球)は
  `pickDeliveryName` 正規化と照合器 alt で吸収。定性(-)の列取り違えは `salvageQualitativeResult`
  (便潜血→尿定性へ allow-list 一般化・🎯検証待ち)で救済。照合器(`elith-batch.astro goldenCheck`)に
  **定性一致率 (numericと分離) と Semantic-Tie(残) 指標**を追加済 (定性の今回値が空で基準列に(-)がある残差を可視化)。
  - **残差 = 免疫便潜血の稀な純粋検出漏れ**: モデルが (-) を value にも ref にも読まない run では、salvage も再読(temp0)も
    埋められない。**ここで (-) を補完すると捏造になるため、空のままにする(捏造ゼロ)** のが確定挙動。多くの run では
    base/salvage/再読のいずれかで捕捉される。さらに追う場合の未実装オプション: 温度変動の多段再読 / 検便領域の
    クロップ拡大前処理 (コストと payoff を見て判断)。
  - **Gemini 3.x の生成設定差は `callGemini` が自動吸収**: 呼び出し側は 2.x 形式 (`thinkingBudget`・`temperature`) の
    まま書けばよい。3.x 指定時のみ `temperature/topP/topK` を除去 (既定推奨) し `thinkingBudget→thinkingLevel` へ変換。
- したがって **ローカル端末での CLI 直実行は不可** (キーを読めない)。
  スキャン/エクスポート等の鍵が要る処理は **Vercel サーバ側 (API/admin バッチ)** で実行する。

### アプリ構成 / 管理画面の所在 (重要・誤解しやすい)
- **Scan-Chat-AI は単独アプリではなく、`www.wellfort.co.jp`(wellfort-site) 配下の診断アプリ**。
  ユーザーは `www.wellfort.co.jp` マイページのリンクから Scan-Chat-AI に遷移する
  (`docs/architecture/wellfort_mypage_button_spec.md`: 本番 `https://scan-chat-ai.vercel.app/`、将来 `app.wellfort.co.jp`)。
- **管理者メニューも `www.wellfort.co.jp/admin`(wellfort-site) 側**。
  - **admin UI は wellfort-site に置く**。**Scan-Chat-AI は API 提供側**
    (`https://scan-chat-ai.vercel.app/api/admin/...`)。根拠: `docs/lab/wellfort_admin_lab_upload_spec.md`
    L5-6/§3「実装対象=Wellfort HP 管理画面 / Scan-Chat-AI=API提供側」。
  - **認証は 2 層**:
    1. **入口(admin判定)**: wellfort-site 側で管理者かを確認する。方式は既存 `admin/users.astro`
       (L543-551) と同じ = **ユーザー自身のアクセストークン + anon apikey で `admin_users` を照会**
       (`is_active=true`)。**service_role は使わない**。
    2. **上流(Scan-Chat-AI)**: **Bearer API Key** (`wellfort_admin_lab_upload_spec §6-1`)。
       wellfort-site 側 env `SCAN_CHAT_AI_API_KEY` = Scan-Chat-AI 側 env `ADMIN_API_KEY` (同値)。
       キーはブラウザに出さない・CORS不要。
  - **§6-2 の「Scan-Chat-AI 側で ID Token→admin_users 照合」は Phase 2.0 (将来)。Phase 1.0 では実装しない。**
  - → 新しい admin 機能を作るときは **UI=wellfort-site / 処理=Scan-Chat-AI API** で分ける。
    Scan-Chat-AI 側に admin 画面を作らない (キー・処理は Scan-Chat-AI、入口は wellfort-site)。

### AI問診 / Live API 制御 (絶対厳守)
- **Live API のターン制御（VAD・割り込み・復唱・エコー対策）は全て LLM/Live API に委ねる。
  プログラム側で制御しない。** マイクの半二重ゲート、AI発話中のマイク送信停止、
  「LLMが自発復唱するはずだから復唱依頼を出し分ける（silent 分岐）」等の**プログラム制御は禁止**。
  → 必ずドツボに嵌る（読み上げが途中で途切れる等の回帰を生む）。実績: 2026-07-05 に
    `f3d59e8`/`09af5ec` で silent 分岐・2パターンプロンプトを入れた結果、AI 読み上げが
    途中で切れる回帰が発生。`b67c15b`（単一依頼「①復唱 ②(切替時)導線 ③次質問」を送り
    ターン制御は LLM 任せ）へ戻して解消。
- **【2026-09-04 確定・発注者指示】AI は質問だけを読み上げる。復唱も確認の聞き返しもしない。**
  回答の確認は**画面の `✓ 回答` 表示**が担う。これにより
  ①**silent 分岐が消える**（音声・タップとも依頼文は「次の質問を読む」1 種類）
  ②**先行表示が構造的に消える**（AI が喋るのは次の質問だけなので、画面を同時に切り替えれば
  読み上げ対象と表示が必ず同一 Question ID になる）→ **状態機械も ID 照合も足さない**。
  `schedulePendingQuestion`（音声 1st chunk / 2 秒で次 Q を描画）は**廃止**。これが
  「音声が再生中なのに次の選択肢が出る」の直接原因だった。
  **音声/テキスト切替トグルは撤去**し、質問直下に「そのまま話して回答できます」を常設。
  **確認発話は実装しない**（聞き返しは engine に状態を足すことになりターン制御へ近づく）。
  詳細は `docs/interview/AI問診_仕様と設計原則.md` §4。
- 問診の進行（質問順・分岐・完了）は `InterviewEngine`（クライアント）が制御し、
  LLM は「渡された質問文の読み上げ＋回答の復唱」だけを担う。**LLM に問診順を決めさせない。**
- AI問診＝**5セクション（嗜好品・運動・食生活・睡眠・心身）**が仕様
  (`docs/interview/20260331_AI参考問診票.png` / `docs/funding_application/要件定義書.md` F-3)。
  **同意設問・実施検査確認などは問診に含めない**（同意は登録/オンボーディングで取得）。
- **詳細仕様・設計原則・アンチパターン・二重話者問題の因果は `docs/interview/AI問診_仕様と設計原則.md` が正本。
  AI問診コードに触れる前に必読。** 責務分界（フロー/選択肢/データ=プログラム, 音声のターン/発話=LLM任せ）、
  silent 分岐・マイクゲート禁止、`f99f47e` が二重話者の起点である因果、案1(音声=LLM単独話者)への修正方針を記載。

### インフラ / 実行モデル
- **Vercel Serverless (iad1 / US East)**。Gemini API と地理的近接 (`docs/architecture/system_architecture_overview.md` L143/L273)。
- 関数タイムアウト ~60s。大型検査表はストリーミング/分割。
  **【2026-09-10 訂正】この 60s は プラットフォーム上限ではなく `astro.config.mjs` の
  `maxDuration: 60` で自分から絞っている値**。Vercel の実際の上限は fluid compute 有効時で
  **Hobby 300s / Pro・Ent 800s (既定はどちらも 300s)**
  (出典: vercel.com/docs/functions/limitations・2026-08-24 版)。
  → **「60s だから 1 画像 = 1 リクエスト」という根拠は現在は成り立たない**。
  変更するかは `docs/scan/スキャン非同期処理_仕様書.md` で扱う (**リクエスト本文 4.5MB の
  制限は別で、こちらは今も有効**)。
  → バッチは **1 画像 = 1 リクエスト**で処理し、クライアントが順に呼ぶ (`docs/architecture/system_architecture_overview.md` L316)。

### Elith 連携 (S3 データ受け渡し)
- 仕様は `docs/elith/elith_s3_data_handoff_spec.md` が正:
  - パス `/{prefix}user/{client_id}/date/{YYYY_MM_DD}/`
  - ファイル `{format_id}_date_{YYYY_MM_DD}_user_{client_id}.json`
  - format_id: `CancerRiskAssessmentData` / `HealthCheckupData` / `GeneticTestResultData` /
    `BloodTestData` / `LifestyleQuestionnaireData` / `Other`
  - `client_id` = `diagnostic_user_id` (PII 非含有)。必要データが揃った時点で一括書き出し。
- S3 既定: バケット `wellfort-ai-input` / prefix は用途による (`src/lib/s3.ts`)。

### 戦略正本: 検査票→標準フォーマット正準化 (2層・最優先で読む)
- **正本: `docs/scan/scan_canonicalization_standard_format_design.md`**。最終ゴール(正確=漏れなし/捏造なし/余剰なし なJSON→Elith→高精度診断)を
  最上位に置き、設計思想(native multimodal・OCRパターンマッチを使わない)は**手段=従属**とする(ゴールが勝つ)。
- **2層に分ける**: ①**読取(Perception)=native multimodal 維持**(レイアウト多様→テンプレOCR不可)。
  ②**正準化(Normalize)=業界標準「健診標準フォーマット(KMAT)」への決定論マッピング(新規)**。②は"1つの標準マスタ"が標的で
  レイアウト別テンプレではない(=汎化しない負債でない)。名寄せ/単位/判定/余剰・不足を②で得点する。
- **一次資料(R3)**: 健診標準フォーマット=日本医学健康管理評価協議会策定。維持運用=日本医学健康管理推進機構(HASTOS/hastos.jp)。
  KMAT ver5.0≒2000項目。**完全マスタは推進機構/HASTOS or クライアント/Elith 経由で入手(捏造しない)**。
- **受け皿は実装済**: `elith-necessity-check.ts` の `requiredItemsMaster`(現 null)にサブセットを与えれば起動。
  `elith_check_phase_spec §8` の「必要項目マスタ」の正体がこの標準。`pickDeliveryName` の当て推量はマスタ照合へ置換していく。
- **実装進捗 (テンプレート穴埋め方式)**: 計画=`docs/scan/基本設定書_実装修正プラン.md`、基本設定=`docs/scan/基本設定書.md §3.6`、
  機能別=`docs/修正仕様書_{標準マスタ,正準化エンジン,検証と確定運用}.md`。
  - **P1 完了**: starter 標準マスタ `src/lib/standard-master.ts` (41項目・ゴールデン実在項目のみ・捏造ゼロ・
    `findByAlias` 完全一致=危険同義語 総蛋白/便潜血 は非マッチ)。
  - **P2 実装済 (既定 off・🎯実画像は未)**: `src/lib/canonicalize.ts` (S1〜S3: 名寄せ/単位正準化/カバレッジ)。
    全書出し経路 (`buildElithScanBundle`/`elith-hc-merge`/`elith-assemble.sanitizeDelivery`) に結線。
    **env `SCAN_CANONICALIZE=on` のときだけ発火・既定 off=挙動不変**。numeric は変えない・非ヒットは元名のまま・
    監査(`mapped/unmapped/deficient`)は納品 data に混ぜない (hc-merge 応答 `canon`)。`pickDeliveryName` は前段維持。
  - **P3 実装済 (既定 off)**: API が canon 監査を返す (scan=`bundle.canon`→`elith-scan.ts`, merge=`elith-hc-merge` 応答 `canon`)。
    `checkNecessity` へ既定 starter マスタ供給 (surplus/カバレッジ可視化)。**starter は Elith 必須サブセットでないため deficient は非ブロック
    =情報提示。明示 `requiredItems` 指定時のみブロック**。admin 表示は wellfort-site `src/pages/admin/elith-batch.astro` (②正準化 写像/マスタ外/不足)。
  - **次 P4/P5**: 🎯実画像ゲート(Vercel で `SCAN_CANONICALIZE=on`→ゴールデン再RUN) → 確定運用。完全マスタ受領で starter 差替。**on 化は🎯回帰ゼロ確認後**。
- **P-perc: 画像証拠ベースの後段補修 (人間ドック課題A/B/C・①読取層・②とは直交)**。正本=`基本設定書 §3.4.1`/`実装修正プラン §3.1`。
  Gemini/ChatGPT 再レビュー収束(2026-08)。共通根=主パス出力に「画像のどの領域/セル由来か」の来歴が無いこと → **出力起点でなく画像証拠候補と主パス出力の双方向照合**で確定 (§3.6.1 S3 の①層への拡張)。主パス(プロンプト/入力画像)は不変。
  - **P-perc-1 実装済 (env `SCAN_OBS_DEDUP`・既定off)**: 課題C 決定論 dedup `src/lib/observation-dedup.ts`。概念ID(canonical_name)で同一性判定・**同一キー同値のみ統合**(別名重複除去)・**別値は競合記録で自動採用しない**(捏造ゼロ・課題B 検知)。table_id/row は意味キーに含めない。眼圧右/左・便潜血1/2日目 は別 canonical_name=統合しない。`buildElithScanBundle` の canonicalize 後に発火→監査 `bundle.dedup`。numeric 不変。astro check 0error・ロジック15ケース検証。**on 化は🎯後**。
  - **P-perc-2/3/4 実装済 (env `SCAN_PERCEPTION_REPAIR`・既定off・Vercel🎯前提)**: 決定論コア `src/lib/perception-repair.ts` (課題B リスク別ゲート evidenceVerdict/emitDecision: 高リスク=証拠必須/通常=weak保持/過去・グラフ一致=contradicted除外/推定不能=ambiguous非ドロップ・状態機械 ATTEMPT_1→2→3→EXHAUSTED_UNRESOLVED・双方向会計 buildAccounting。ロジック22ケース検証)。画像I/O `elith-export.ts` (`perceptionRepair`= A:Geminiインベントリ→照合→局所VQA充填[画像証拠に基づくpush=捏造ゼロ] / B:同名別値の領域判定→ゲートで除外)。`scanArtifacts` に結線・Gemini/sharp全try/catch=フォールバック・主パス不変。astro check 0error。
    **タイムバジェット必須(実測504対応・2026-08)**: 後段の直列Gemini呼び出しは60s関数タイムアウト=**504でスキャン全損**を起こす(実測 ⑧-1.JPG)。→ `scanArtifacts` の主パス開始 t0 から `PERCEPTION_DEADLINE_MS=45000` の deadline を rowcrop/perception に渡し、各Gemini呼び出し前に `Date.now()>=deadline` で打ち切り+呼び出し上限(MAX_INVENTORY_REPAIRS/MAX_REGION_CHECKS=8)。打ち切り分は `budget_stop`=left_unresolved(次リクエストで再試行=RETRY_PENDING)。関数は必ず60s内に主結果を返す。
    **実測回帰(2026-08・⑧検体 perception=on)→捏造ゲート追加**: `inventoryReread` が 好中球(画像は分葉核球)/LDH/右耳/受診コース(=日付) 等を**幻覚して push=捏造5**、かつ 視力右眼/眼圧右眼 等を別名で push=重複増(rows100→116)。**CLAUDE.md 確定ルール「VQA充填は新規pushしない」を P-perc で上書きしたのが誤り**(R5撤回)。→ `inventoryReread` の新規pushを **findByAlias ヒット(starter標準マスタ実在概念)のみ + 日付様value除外 + canonical_name で既存概念と重複回避** に厳格ゲート(幻覚名/メタデータ/日付を全弾き)。**結果: 課題Aの push はマスタ収録項目に限定=大半の真の欠落(FT3/内科診察等)は非対象**(捏造ゼロ優先)。**当面 SCAN_PERCEPTION_REPAIR は off 推奨**(baseline=perception off が 98%/誤読0/捏造0 で優位)。完全マスタ受領で push 対象が広がる。
    **課題B 単独値リークは未解決**: LDL=102/TG=129(前回値混入)は主パス由来だが regionGate は「同名別値の競合」しか見ず単独値を取り逃す(Gemini①指摘)。全値の領域照会は60s予算外→ dedup で 129 が復元され競合化した時のみ拾える。恒久策は要検討。
    **残る精密化はVercel🎯で調整**: 純CV occupied検出・残留証拠監査・current_column_confidence・跨リクエストの client リトライループ。VQA/CVの効き(漏れ検知率/誤ドロップ/503/60s)はローカル不可(キー無)=決定論部とastro checkのみ検証。**on化は人間ドックゴールデン(FT3欠落・推移グラフ)での🎯回帰ゼロ確認後** (`SCAN_VQA_ROWCROP` と同運用)。
  - **「必ず入れる」の実行形 (発注者裁定2026-08)**: 漏れなし(§1.1絶対)=**サイレント脱落ゼロ＋自動リトライラダーで読み切り(人手ゼロ)**。読めないインクに値を出す=捏造なので不可。終端は自動停止でなく**自動継続の状態機械** `ATTEMPT_1→2→3→EXHAUSTED_UNRESOLVED`(未解決+証拠を永続化し次リクエストへ・1画像=1reqは分割規則で再試行を禁じない)。EXHAUSTED_UNRESOLVED は通常納品しない・捏造しない・黙って消さない。**保証=サイレント脱落ゼロ / 非保証=常に完全JSON(確率モデル単体で数学的に不可)**。
- **却下再掲**: 様式別プロンプト/テンプレOCR=却下 / 主パス規則強化=numeric回帰で不採用 / モデル3.5格上げ=md段階で lite 超えず不採用。
  - **例外(確定 2026-08・発注者判断)= LAiF「AI疾病発症予測」は様式特化プロンプトを採用**。却下理由は「多機関=様式可変」だが
    **LAiF は単一ベンダー・固定様式**で当てはまらず、ゴール(正確)優先で採用。狙い=発症予測テーブル(密表)の行ズレ/空行捏造/
    入れ子ゆれ抑制(行単位読取・疾患名ある行のみ項目化・フラット固定キー・疾患名は印字どおり)。
    実装=`src/lib/elith-genetic.ts` `AI_PREDICTION_USER`。正本=`docs/elith/elith_assembly_wrapping_spec.md §5.6`。
    後段統合(`ai-prediction-consolidate.ts`・env `SCAN_AI_PREDICTION_DEDUP`)と直交併用。固定様式の改訂検知は今後の課題。

### 捏造ゲート (False-Value 抑制・決定論・仕様着手2026-08)
- **正本: `docs/scan/修正仕様書_捏造ゲート.md`**。人間ドックgolden(2025-02-17)で顕在化した False-Value 8件
  (尿定性/便潜血の未実施(-)充填・腹囲=基準吸い上げ・B3基準値表の男性/女性項目化) を決定論で抑制する仕様。
  4ゲート (G1未実施ブロック抑制[`fabgate.unperformed`・比重/pH アンカーで尿未実施判定]・
  G2基準吸い上げ[`fabgate.refbleed`・value==片側基準閾値をドロップ]・G3参考資料行[`fabgate.reftable`・
  レンジ値/男性女性名をドロップ]・G4隣接漏れ[`fabgate.adjacent`・監査のみ])。全て `sanitizeMeasurementsForDelivery`
  集約・off=挙動不変・捏造ゼロ・🎯(test_date=2025-02-17)回帰ゼロで on化。
  **実装済 (2026-08・`elith-export.ts:457` で 4 ゲートとも参照)・既定は 4 つとも off**。
  切替は app_config の `fabgate.*` (旧 `SCAN_FABGATE_*` env は廃止)。

### スキャン読取の共通ルール (検査票 → JSON)
- **時系列列は「今回」のみ採用**: 検査票に「今回/前回/前々回」や受診日付きの複数回分が
  並ぶ場合、**"今回"(最新回) の値だけを採用し、前回・前々回以前は捨てる**。今回が空欄なら
  その項目の今回値は空 (前回値を繰り上げない)。**検診・人間ドックに限らず血液・がん・遺伝子等
  全検査票で共通**。実装: `src/lib/scan-prompt.ts`【時系列列の扱い】。
- **納品整形は決定論プログラムに集約**: `src/lib/elith-export.ts` の
  `sanitizeMeasurementsForDelivery()` が唯一の正規化本体 (lean化 / ↑↓→flag・value_num数値化 /
  空白(未実施)行 除外 / 総合判定(A/B/C)欄 除外[血液型ABO/Rhは例外] / 妥当性ガード)。
  **scan(`buildElithScanBundle`) と hc-merge finalize の書き出し時点**、および assemble
  (`sanitizeDelivery`) の全経路で同関数を通す (二重管理しない)。LLM に判定・整形はさせない。
  - 理由: 方式Aバッチ/assemble未実行の経路では**生スキャン出力がそのまま Elith 納品**になり得るため、
    整形は「書き出し時点」に置く (assemble任せにしない)。監査は raw_markdown + 元画像(S3) に保持。
    **ここでいう scan は admin バッチ (`elith-scan`/`batch-scan-to-elith.mjs`) の経路**で、
    元画像を S3 へ書くのはこちら。**ユーザーのスキャン (`/scan`) は原本画像を保存しない**
    (下の「スキャンの画像の扱いと実行モデル」)。**2 つを混同しないこと。**
  - **定性結果の列サルベージ (Phase 0)**: `salvageQualitativeResult()` が `sanitizeMeasurementsForDelivery` 冒頭で、
    value 空時に括弧付き定性記号 `(-)`/`(+)`/`(±)`/陰性/陽性 を ref_high/ref_low/note から value へ移送する
    (結果 `(-)` が基準列(上限値)へ吸われ脱落する非決定バグ=Semantic Tie の保険)。
    **名称 allow-list に限定** (「基準=(-)」を結果と誤読して埋める False-Value を避ける):
    許可=`/便潜血|^(?:尿蛋白|尿潜血|尿糖|蛋白|潜血)$/`、除外(deny)=血清 RPR/TP抗体/HBs/HCV・尿沈渣 細菌/円柱/結晶・
    総蛋白/血糖 等 (「基準=(-)だが今回空=未実施」が正当な行を埋めない)。
    **2026-07: 便潜血限定→尿定性まで一般化 (Gemini/ChatGPT/実装の3者収束・🎯検証待ち)**。
    残リスク=検体未採取で尿ディップ全欄が空の run は基準(-)を誤救済し得る → 恒久対処は下記 VQA 再読。
    (旧恒久策の `SCAN_OUTPUT_FORMAT=json` は補助欄暴走=False-Value で不採用済み。)
  - **時系列軸リーク (今回の False-Value) = 定性(-)とは別系統**: 今回=空が正の行 (眼圧・血清 RPR/TP抗体・HBs/HCV 等)
    で、モデルが**前々回の孤立値を今回列に混入**する (実測: 眼圧=前々回16 / RPR・TP=前々回(-)。raw の「読み取った値」列に
    過去値が入る=主パス起因で**後段は過去列を持たず修正不能**)。
    - **対策A (プロンプト補強) = 試したが撤回 (2026-07・🎯回帰)**: `scan-prompt.ts`【時系列列の扱い】に「孤立した過去列値の
      混入禁止」を追記したところ、**False-Value は 0 になったが Missing が 9 に急増** (身長/体重/BMI/腹囲/血圧/視力=**今回/前回/
      前々回が3列とも埋まる行**を flash-lite が過剰にドロップ)。numeric 回帰のため即撤回 (`0c4b519`→revert)。
      **教訓: 主パス(プロンプト)への時系列規則の強化は flash-lite で numeric を壊す。定性の O/X 却下と同じ轍**。
    - **対策B (列追加=構造保持) も不採用**: O/X 却下と同じ numeric 回帰リスク。
    - **採用方針 = 対策C (後段/第2パス VQA でドロップ)**: 主パス不変のまま、今回=空が正の疑い行 (眼圧・血清等) だけを
      VQA で「今回セルは空か」確認し、空確認できた時だけ過去混入値を**後段でドロップ** (誤削除=Missing を避けるため
      高信頼の空確認時のみ)。定性の VQA (下記) と同一機構で扱う。未実装。
    - 照合器に RPR/TP抗体/HBs/HCV を today='' 番人として追加済 (従来 golden 未検出だった漏れを可視化。撤回後は
      眼圧/RPR/TP が再び False-Value として出るが、これは"検出できている"正しい状態。恒久対処は上記 C)。
  - **定性の恒久対処 = 第2パス VQA (Verify & Repair・Gemini/ChatGPT/実装3者収束)**: 主パス(10列Markdown)は不変のまま、
    `SCAN_BOUNDARY_RECHECK` 経路を「値抽出」から**局所VQA(監査役・列挙回答・グラウンディング)**へ格上げ。
    プロンプト/スキーマは `scan-prompt.ts` の `BOUNDARY_RECHECK_SYSTEM`/`BOUNDARY_RECHECK_SCHEMA`/`buildBoundaryRecheckUser`
    (「今回セルだけ・過去列/基準を混同しない・列でなく行で辿る」)。後段パッチは `elith-export.ts boundaryRecheck`。
    - **Phase 1 (実装済・🎯検証待ち)**: `missing_detection`(今回空→VQAの妥当トークンで充填) と
      `unexpected_token`(今回値が定性許可集合外=例 免疫便潜血"1" → VQAトークンで上書き)。項目別 allow 集合
      (`QUAL_URINE_ALLOW`/`KW_GRADE_ALLOW`)でトリガー/採用をガード。**fail-safe**: VQA が空/不能/集合外なら不変・
      **既に妥当な値と numeric は絶対に触らない**。
      **可視化**: `boundaryRecheck` が `VqaAuditEntry[]`(name/reason/before/vqa/action=filled|overwritten|left_unresolved|vqa_error)
      を返し、`scanImageToParsed`→hc-merge の per-part 応答 `vqa_audit`→admin(`elith-batch.astro`)で
      「VQA再読 充填/上書き/未解決/エラー」を表示 (Elith 納品 data には含めない)。「VQAが発火したか/残差か」を🎯とは別に判別可能。
    - **Phase 2 (実装済・🎯検証待ち)**: `timeline_leak` の**削除(値→空)**。眼圧・眼底その他・血清(RPR/TP)等
      「今回=空が正」の項目 (`TIMELINE_LEAK_ITEMS`) を値ありでも VQA でダブルチェックし、VQA に `past_seen`
      (過去列に見えた値) を報告させ、**③3条件 (VQAが今回空 & past_seen に値 & 現value==past_seen) を全て満たす時だけ**
      後段で削除 (`sameLoose` 一致必須)。本番は過去列を持たないので VQA の past_seen と突合する。誤削除=Missing を
      構造的に防ぐ。残リスク=今回値==過去値が偶然一致する検体で実施済を誤削除し得る → **眼圧/血清が"実施済"の
      第2検体ゴールデン**で「実施済を落とさない」を確認してから本番常用する。監査 action に `dropped` を追加。
    - **① 行クロップ独立VQA (実装済・env `SCAN_VQA_ROWCROP`・既定off・🎯Vercel検証前提)**: Phase2 の**相関失敗**
      (主パスも全画像VQAも今回に過去値を読む run。実測 2026-08: 眼圧右/左=16 を両方 today=16 と読み削除できず
      False-Value 残存) を救済。対象 timeline_leak 行を `sharp` で切り出した独立画像で今回セルを読み直し、
      ③3条件 (行クロップVQAが今回空 & 過去列に値 & 現value==過去値) 全満たしで削除。**全幅Y帯=今回/前回/前々回
      を保持し X 座標特定の泥沼を回避**。`sharp` は**遅延import+全try/catch**=失敗時フォールバック(本経路は不変)。
      実装 `elith-export.ts` `rowCropLeakRescue`/`cropRowStripBase64`。
      - **🎯初回(2026-08)で判明→改良**: 行のみクロップだと**列見出しが無く今回/前回を取り違える**(眼圧左=today空 正読・
        眼圧右=today16 誤読)。→ locate で **header_bbox(列見出し行) も取得し「ヘッダ帯＋行帯」を縦連結**して列を
        対応付け。confirm プロンプトで **past_seen(過去列値) の報告を強制**(3条件の past を安定取得)。今回空判定は
        **present:false か today値空**で成立(修正)。numeric値は削除しか行わない(充填しない)=捏造ゼロ。
      - **on化は🎯回帰ゼロ確認後**(ローカルはキー不可＝連結クロップの画像生成のみ検証済。VQA部は Vercel🎯 で検証)。
    - **VQA充填の別名dedup (実装済)**: `BOUNDARY_RECHECK_ITEMS` に `aliases` (蛋白≡尿蛋白/潜血≡尿潜血)。
      これが無いと充填が別名の重複行を push する (実測 2026-08 重複2)。既存の尿蛋白/尿潜血行を照合し重複を作らない。
      さらに **潜血 hint=`(?<!便)潜血`**: boundaryRecheck は画像1枚ごとに走るため hint=/潜血/ だと免疫便潜血のある
      検便ページ(③-4)へ誤マッチ→尿定性潜血の無いそのページに新規潜血を push→③-2 の本物とマージ後に重複(実測 2026-08)。
      (?<!便) で免疫便潜血を除外し**ページ跨ぎの重複push**を防ぐ。
    - **VQA充填は新規pushしない=既存空行のみ充填 (実装済・捏造ゼロ)**: 該当行が主パス結果に無い様式では、
      VQAが値を返しても **push しない**(実測 2026-08: K-W の無い様式で VQA が 0 を push=捏造4)。「主パスが行を
      作った=その様式に存在が確認済」の空行だけを埋める。免疫便潜血/K-W/尿定性はその様式に行があれば
      idx>=0 で fill in place。完全に行ごと欠落した項目は捏造回避のため空のまま(捏造ゼロ優先)。
    - 主パスへの O/X 列追加・時系列規則強化は numeric 回帰で不採用(実証済)。~~クロップ前処理は画像ライブラリ不在で保留~~
      → **上記① で `sharp` 導入し行クロップを実装 (既定off)**。VQA単機能の仮想クロップでは相関失敗を消せなかったため。

### スキャンのアップロード上限 (2026-09-04 確定・発注者指示「10M に変更」)

**受け付ける上限 = 10 MB / 実際に送れる元データ = 約 3.2 MB。この 2 つは別物**。
実装は `src/scripts/scan-upload.ts` に集約 (`scan.astro` は呼ぶだけ)。

- **理由 = Vercel Functions のリクエストボディ上限 4.5 MB** (出典: vercel.com/docs/functions/limitations
  「Request body size」・2026-08-24 版。超過は **413 `FUNCTION_PAYLOAD_TOO_LARGE`**)。
  `/api/scan` は data URL を JSON body で POST する (`camera-scan.ts` の `analyzeDataUrl`) ので、
  ファイルは base64 で **4/3 倍**に膨らむ。
- **【重要】旧「4 MB」は既に壊れていた**: 4 MiB → base64 5.33 MiB > 4.5 MB。
  つまり上限ぎりぎりのファイルは**関数に届く前に 413 で落ちていた** (アプリのログには何も残らない)。
  **数字だけ 10 MB に上げると、3.2 MB 超が全部この沈黙する失敗になる**ので、必ず縮小とセットで扱う。
- `WIRE_BUDGET_BYTES` は `VERCEL_BODY_LIMIT` と `BODY_OVERHEAD` からの**導出**
  (マジックナンバーを置かない)。上限が変われば追従する。
- **予算内は無変換で送る** (PDF・HEIC 含む) = 従来どおり無劣化。超えた画像だけ canvas で
  再エンコード / 縮小する。段階は 4096→2400→2000→1600 で、**2 段目はカメラ経路と同条件**
  (`camera-scan.ts` の `maxEdge: 2400, quality: 0.92`) なので**アップロードがカメラより粗くなることはない**。
  1 段目を無制限にしないのは iOS Safari の canvas 面積上限 (超えると `toDataURL` が空を返す)。
  透過 PNG は白で塗ってから JPEG 化する (透過部が黒くなるため)。
- **PDF はブラウザで縮小できない**ので、予算超えは送らずに理由を出す (黙って 413 にしない)。
  HEIC はデコーダを持つブラウザ (Safari) でだけ縮小できる。
- **サーバ側にサイズ検査は置かない** — Vercel が関数に到達する前に弾くので、置いても実行されない。

**【S3 直アップロードで上限を外した 2026-09-04・発注者指示「案B を #1 だけ」】**
Vercel の 4.5 MB は **関数を通るデータにだけ**かかる。**ファイル本体を関数に通さず
ブラウザから S3 へ直接置けば上限は外れる** (LAiF ポータルが 50MB を通せているのはこの方式。
`laif-portal.ts:5-6`)。同じ形をスキャンにも入れた。

- `src/lib/scan-upload-ticket.ts` (presigned PUT 発行 + 読み出し) /
  `POST /api/scan/upload-ticket` (数百バイトの JSON しか通らない) /
  `/api/scan` が **`image` に加えて `imageKey`** を受ける (サーバ→S3 の取得は上限の対象外)。
- **経路は 3 段のフォールバック**: ①予算内=従来どおり inline (往復が増えない・無劣化)
  → ②予算超え=S3 直 PUT (**無劣化・PDF もここで通る**) → ③S3 が使えない=画像だけ圧縮
  (`WIRE_BUDGET_BYTES` 以下へ)。**②が落ちても投げない** — S3 未設定・**バケットの CORS 未設定**・
  回線断を判別できないので `null` を返して③へ譲る。**PDF は③が無いので S3 が要る**。
- **【安全性・ここが本丸】`/api/scan` は受け取ったキーの中身を読んで Gemini に渡す**ので、
  **キーを自由に指定できると同じバケットの Elith 納品 JSON (全利用者ぶん) を読み出せる**。
  → ①キーは**サーバが採番** ②`isScanUploadKey` が
  `{prefix}scan-uploads/YYYY/MM/DD/<UUID>.<ext>` に**完全一致**するものだけ通す (部分一致にしない)
  ③UUID は推測不能 ④Content-Type と ContentLength を**署名に固定** ⑤期限 15 分。
  **`.json` を許可拡張子に入れない**のも納品 JSON を読ませないため。
- **`requestChecksumCalculation: 'WHEN_REQUIRED'` は必須** (`laif-portal.ts` で踏んだ罠)。
  既定だと SDK が署名時に空ボディの CRC32 を URL に載せ、実ファイルを PUT した瞬間に S3 が拒否する。
- **プレビューは別に作る**。S3 経由では原本の data URL を持たないので、画像は表示専用の縮小版
  (`previewDataUrl`) を作り、**解析には使わない**。PDF はプレビューを作れないので
  `AnalyzeResult.sourceKind` で分岐する (`fullImage` の文字列判定では S3 経由を拾えない)。
  `renderTrimmedImage` では **PDF 判定を「画像がありません」より前に置く** (後ろだと PDF で誤表示)。
- **検証** = `npm run verify:scan-upload` (`verify:scan-upload-key` 20 件 + ブラウザ 21 件)。
  **この失敗はアプリのログに出ない**ので目視では守れない。
  - key 側 = **納品 JSON・相対パス・二重拡張子・非 UUID を弾くこと**を固定 (サーバ不要)。
  - ブラウザ側 = チケットと PUT を差し替え、**8 MB の PDF で Vercel を通る body が 98 バイト**・
    8 MB の画像が**無劣化のまま** PUT される・S3 失敗時に圧縮へ落ちることを実測。
  - 退行注入で落ちることを確認済み (キー検証を prefix 一致だけに緩める → 20→11 /
    縮小を無効化 → body 10.26 MiB で FAIL)。
- **【AWS 側の作業 = 手順書あり】`docs/operations/スキャンS3直アップロード_バケット設定手順書.md`**
  (①CORS=必須 / ②ライフサイクル=推奨。JSON・コンソール手順・CLI・確認コマンド・切り分け表)。
  - **①②を 1 つの JSON にはできない** — S3 の別サブリソースで API もコンソールのタブも別
    (`PutBucketCors` / `PutBucketLifecycleConfiguration`)。**まとめられるのは「作業 1 回」まで**
    = `scripts/aws-scan-s3-setup.sh` (両方適用 + 検証)。CloudFormation なら 1 文書に書けるが、
    **データの入った既存バケットには resource import が要り置換の危険がある**ので採らない。
  - スクリプトが**手作業より安全**な点: プレフィックスを人に入力させない
    (**誤ると Elith 納品 JSON が削除対象**) / `scan-uploads/` で終わらなければ中止 /
    既存ルールを get→統合→put で消さない / バージョニングと Object Lock を先に見る /
    冪等 / 適用後に自分で検証。スタブで 5 経路を動作確認済み。
  - **本番の実測 (2026-09-04)**: バケット `wellfort-ai-input` / `ap-northeast-1` /
    プレフィックス **`scan-accuracy-test/scan-uploads/`** / チケット発行は **200 で動作** /
    **CORS は設定済み** (同日 06:56 は `CORS is not enabled` → 07:27 に手順書どおりの
    `Access-Control-Allow-Origin`/`Methods: PUT`/`Headers: content-type`/`Max-Age: 3000` を確認)。
    **推測せず `POST /api/scan/upload-ticket` の `key` でプレフィックスを確認する**
    (`AWS_S3_PREFIX` を変えると変わる。署名を出すだけでファイルは作られない)。
  - **CORS が無いと②が黙って失敗し③へ落ちる** = 画像は通るが **PDF は 3.2 MB のまま**。
    → **「画像は通るが PDF だけ落ちる」は CORS 未設定の症状**。判定は OPTIONS プリフライトが
    403 か 200 か (手順書 §3.1)。
  - **CORS はバケットを公開しない** (権限は presigned URL が持つ)。
    **バケットポリシー / パブリックアクセスブロックは触らない**。`GET` も足さない
    (サーバ側の読み出しは CORS を通らない)。
  - **ライフサイクルの prefix に `scan-uploads/` を必ず含める** —
    `scan-accuracy-test/` だけにすると **Elith 納品 JSON が消える**。
    バージョニング有効なら `Expiration` は削除マーカーを付けるだけなので
    `NoncurrentVersionExpiration` も要る (手順書 §2.2 で事前確認)。
  - **経路全体を本番で確認済み (2026-09-04)**: チケット発行 200 / presigned PUT 200
    (5,000,000 バイトの PDF・6,150 バイトの PNG) / **`/api/scan` が `imageKey` から
    S3 を読んで Gemini へ渡し、表の値を正しく転記** (AST 22・ALT 18・HbA1c 5.4)。
    署名 (Content-Type/ContentLength 固定) と `requestChecksumCalculation` の罠も問題なし。
    **キー検証も本番で発火**: 納品 JSON・prefix 内の別領域・相対パス・非 UUID・`.json` 付与の
    5 件とも `400 invalid_key`。確認用オブジェクトが 2 つ残っている (②を入れれば自動失効)。
  - **① ② とも 2026-09-04 に適用完了** (発注者が実施・読み戻しで確認)。
    **バケットはバージョニング有効**だったため、ライフサイクルは
    `Expiration{Days:1}` + **`NoncurrentVersionExpiration{NoncurrentDays:1}`**
    + `AbortIncompleteMultipartUpload{DaysAfterInitiation:1}` の形
    (`Expiration` だけだと削除マーカーが付くだけで実データが残る)。適用前の既存ルールは 0 件。
    → **AWS 側の作業は完了。残るはスマホ実機での通し確認だけ**。
- **#2〜#8 の他の口は手つかず** — `elith-report/upload`(40MB) / `lab-results/upload`(20MB) /
  `elith-output`(8MB) は名乗りが実際 (~4.5MB) を超えたまま、admin バッチスキャン
  (`elith-scan`/`elith-hc-merge`/`elith-genetic-merge`) は**上限の宣言もチェックも無い**。

### スキャンの追加フロー (2026-09-10 確定・発注者指示)

**アップロードは複数選択できる。選んだ全部を 1 つの一覧で見せ「送信 / 選び直す」の 2 択。
撮影だけは 1 枚ごとの確認を残す。** これは 2026-09-04 の「撮影・アップロードとも 1 枚ごとに確認」を
**アップロード側だけ置き換える**もの。実装は `src/pages/scan.astro` + `src/scripts/scan-pages.ts`。

- **発端のバグ 2 件 (実測・PC と iPhone 13 相当の実ブラウザ)**:
  ①`#scan-file` に `multiple` が無く、change ハンドラも `files[0]` しか見ていなかった
  ②「撮り直す」「次の用紙」「用紙を追加する」が**どう入れた 1 枚かに関係なく**
  無条件に `controller.start()` を呼んでいた → **PC・スマホとも `getUserMedia` が発火**
  (PC はカメラが無いので必ずエラー画面 / スマホは実際にカメラが開く = **同じバグ**)。
- **`ScanPage.origin` (`camera` | `file`) を持つ**。名前の有無から推測しない。
  「次の用紙」「撮り直す」は**入れたときと同じ手段で続ける**。
  **カメラ可否の判定は CSS `.touch-only` と同じ `(pointer: coarse)`** にそろえる
  (要件 F-A5「PC はカメラスキャン非対応」)。ずれると**画面に出ていないカメラが JS から起動する**。
- **一覧にはファイル名を必ず出す** — PDF はプレビューを作れないので名前が唯一の手がかり。
  撮影分は名前を持たないので「カメラ撮影」と書く (空欄にして黙らせない)。
- **「ファイルを選び直す」は押した時点で捨てない**。新しいファイルが届いてから入れ替える
  (ダイアログを閉じただけで選択を全部失わせない)。**ファイルだけの一覧のときにだけ出す**
  (撮影した紙まで巻き込まない)・出ている間は「最初からやり直す」を隠す (入口を 2 つ並べない)。
- **追加はカメラ / ファイルの 2 ボタンに分ける**。1 つだとどちらかを名乗ることになり、
  もう片方で入れた人が行き止まりになる。カメラ側は `touch-only` なので PC には出ない。
- **1 件でも読めなかったら名前と理由を一覧に出す** (`#review-skipped`)。
  残りは積む・**1 件も積めなかったときだけ**エラー画面へ (積めた分がある間は流れを止めない)。
- **検証 `npm run verify:scan-pages` 47/47** (PC・スマホ両方の実ブラウザ)。
  カメラ起動は **`getUserMedia` の呼び出し回数**で見る (唯一の決定的な指標)。
  **キャンセルの判定を `review-count` の文字だけで見ない** — 押した時点で捨てる実装でも
  再描画されず数字は古いままで、退行を見逃す (実測)。→ 1 件足して合計で見る。
  退行注入で落ちることを確認済み (`multiple` を外す / 経路判定を camera 固定 /
  先頭 1 件しか積まない / 一覧へでなく 1 枚ごとの確認へ戻す / 選び直しで即クリア /
  ファイル名を出さない)。
- **dev サーバの `astro-dev-toolbar` が画面下端のボタンへのクリックを横取りする** (実測)。
  ブラウザ検査では隠してから測る (**本番には無い要素**)。

### スキャンの画像の扱いと実行モデル

> **【2026-09-10 に方針転換・発注者指示】この節の「画像を残さない / バックグラウンド化は採らない」は
> **撤回**された。新方針 = **S3 に置いて定期的に削除し、送信後はバックグラウンドで処理する**。
> 正本は `docs/scan/スキャン非同期処理_仕様書.md`。**以下は転換前の現状 (= 現在の実装) の記録**として
> 残す — 実装はまだこの姿なので、読む価値がある。**「採らない」という判断だけが無効。**

**現状 (実装): ユーザーのスキャン (`/scan`) は原本画像を保存しない。** コード側にも明記がある
(`src/pages/scan.astro:789`「原本画像は保存しない方針」)。**admin バッチとは扱いが違うので
混同しないこと** (下記)。

| 経路 | 画像の行き先 | 残るか (実測) |
|---|---|---|
| カメラ撮影 | メモリ (`ScanPageList`) のみ | **残らない**。結果画面へ進む時に `pages.clear()`。`localStorage`/`sessionStorage`/`indexedDB` はスキャン画面に 0 件 |
| アップロード (予算内 ≒3.2MB 以下) | data URL を `/api/scan` へ POST → Gemini へ渡すだけ | **残らない**。`/api/scan` に書き込み系の呼び出しは 0 件 (`fetchScanUpload` で読むだけ) |
| アップロード (予算超え) | ブラウザ → S3 直 PUT `{prefix}scan-uploads/YYYY/MM/DD/<uuid>.<ext>` | **1 日で自動削除**。読んだ後に消す実装は無く (`scan-upload-ticket.ts` に delete 系 0 件)、バケットのライフサイクル任せ (`Expiration{Days:1}` + `NoncurrentVersionExpiration{NoncurrentDays:1}`) |

- **保存するのは結果テキストだけ**: `/api/scan/save` ← `{ markdownClean, pageCount }` /
  `/api/scan/export` ← `markdownClean` + ID + hint + ファイル名。**どちらも画像を受け取らない**。
- **10 年保管の `putOriginal()` はスキャン経路から呼ばれない** (呼び出しは admin の 3 経路
  `genoplan-fetch` / `elith-report/upload` / `lab-results/upload` だけ)。
- **【混同注意】上の「納品整形」節の「監査は raw_markdown + 元画像(S3) に保持」は
  admin バッチ (`elith-scan` / `batch-scan-to-elith.mjs`) の話**で、あちらは実際に
  元画像を S3 へ書く (`elith-scan.ts` の `image_key`)。**ユーザーのスキャンには当てはまらない。**

**【撤回済み】~~帰結: 送信後のバックグラウンド処理は採らない (発注者判断 2026-09-10)。~~**
~~バックグラウンド化するには全ページをサーバ側に置き、ジョブが終わるまで保持する必要があり、
上の「画像を残さない」と両立しない。画像を残さない方を採る。~~
→ **同日中に発注者が判断を変更**:「B は『検査票の画像 (PII) を一定期間サーバに置く』ことと
不可分 ⇒ **S3 に置いて、定期的に削除で進めて**」。**画像を S3 に置くことを許容し、
バックグラウンド化を採る**。設計・段階・未確認事項は `docs/scan/スキャン非同期処理_仕様書.md`。

**以下は転換前の現状 (= 現在の実装)。仕様書の Phase が入るまではこの姿。**

- **送信は前景処理のまま**: `sendAll()` が 1 枚ずつ `await camera.analyzeToResult()`
  → `await fetch('/api/scan')` → サーバは `await callGemini()` の結果を同じ応答で返す。
  **キューもジョブも無い** (`waitUntil`/queue/jobId/polling・ジョブテーブルとも 0 件)。
- **利用者は画面を開いたまま待つ**。1 枚あたり **30〜50 秒**かかった記録がある
  (`astro.config.mjs:9-11` のコメント。gemini-2.5-flash 当時の値で、現行既定
  `gemini-3.1-flash-lite` での実測ではない) ので、複数枚では数分になり得る。
- **ページ列はメモリだけ**なので、**送信中にタブを閉じる / リロードすると全ページ失われ最初から**。
  この事実は画面の文言に反映されていない (「少し時間がかかります」だけ) = **未対応の申し送り**。
- 「バッチ」という語は本アプリでは**「撮影中は読まず、完了時に全ページを続けて処理する」**の意味
  (`src/scripts/scan-pages.ts:10-14`)。**バックグラウンド実行の意味ではない。**

### 検査種別ごとの本番処理 (役割分担)
根拠: `docs/elith/elith_batch_centralization_design.md`
- 検診・人間ドック (`HealthCheckupData`) … **ユーザーがアプリでAIスキャン**
- がんリスク (`CancerRiskAssessmentData`) / 遺伝子 (`GeneticTestResultData`) …
  **Wellfort が検査機関から手動取得 → admin バッチ (サーバ実行) で処理**
- 血液 (`BloodTestData`) … デメカル (dl.demecal.net) から取得。自動DLは
  `docs/lab/demecal_auto_download_overview_spec.md` (クライアント証明書 mTLS)
  - **【方式確定 2026-08-31・専用PC 実測】自動取得は PowerShell 方式。PAD は不要**
    (ライセンス不要・ブラウザ要素を指さないので画面変更に強い)。根拠=
    `docs/lab/demecal_powershell_probe_guide.md`「実測結果」: 証明書つき接続 **HTTP 200**
    (`CN=Q05-0010`・発行者 `demecal.net CA`・**期限 2028-12-12**)、証明書なしは 400、
    ログイン画面は `<form>`1/`<input>`4 の**通常の HTML フォーム**。
  - **証明書は `Cert:\CurrentUser\My` にしか無い (ユーザー `info`)。`LocalMachine` には無い。**
    → **SYSTEM/別ユーザーのタスク実行では証明書が見えず失敗・サービス化も不可**。
    証明書の選択は **発行者CN=`demecal.net CA` かつ 秘密鍵あり**で絞る (CN ベタ書きにしない=更新で変わる)。
  - **【運用形態 確定 2026-08-31・発注者判断】最初から無人で定期実行する。段階導入は採らない。**
    正本 = **`docs/lab/demecal_unattended_spec.md`**。
    **無人にしてよい根拠 = `last_to` の単調前進** (取り込み成功時だけ前進・
    `demecal-state.ts` POST)。**走らない日があっても次の成功回がまとめて回収=取り漏れゼロ**。
    → だから「ログオン中のみ実行」で足り、自動ログオンも LocalMachine 移設も要らない。
    **失敗時に `last_to` を前進させてはならない** (この性質が壊れたら無人運用も壊れる)。
    **最優先の未実装 = `LAB_INTAKE_API_KEY`** (設計文書に6か所あるが `grep src/` = 0)。
    無人だと**PCが鍵を持ち続ける**が、現状 2 API とも `ADMIN_API_KEY`(フル権限=config/elith-delete/
    demo-accounts 等が全部開く) を要求する。**専用PCに置いてよい鍵ではない**ので、
    intake 専用キーを `api-auth.ts` に実装し**3つの口だけ**に通す (+スコープ回帰チェック)。
    監視は**通知基盤を作らず GitHub Actions の日次ワークフローを見張りにする**
    (失敗すると購読者へ自動メール。既存 `charge-subscriptions-cron.yml` と同型)。
    - **【bat は 2 本立て 確定 2026-08-31・発注者指示】「何度も Wellfort に bat 実行を依頼するのは避けたい」**
      → **①偵察・初回テスト / ②本番の自動実行** の 2 本。**Wellfort の操作はダブルクリック 2 回で終わり**。
      **①で取り切るものを増やしてでも往復を増やさない**のが眼目。
      **① = `scripts/demecal-recon.ps1` (実装済)**。配布は既存口を流用 =
      `GET /api/ops/probe-bat?k=<PROBE_UPLOAD_TOKEN>&script=recon`、回収も既存 `probe-upload`
      (**サーバ側の新規実装なしで渡せる**)。中身= 保存先作成(OneDrive なら中止)/証明書選定/
      **ID・PWをDPAPI保存(②が再利用)**/ログイン/**DL画面の form 構造採取**/
      **その form をその場で実行**(日付欄に2000年・確認画面が挟まれば辿る)/報告。
      **PII を持ち出さない**: ページ本文は保存も送信もしない・hidden の値は出さない・
      CSV はヘッダ行と行数だけ (データ行が返っても捨てる)。
      **② は①の結果 (form の action/name) を見てから作る**。
  - **【上記2制約の潰し方 確定 2026-08-31】詳細は上記正本 §4.3/§4.4
    (旧 `demecal_rpa_operation_design.md §4.4` は取り込み済み)。
    どちらも Wellfort の作業を増やさずに潰す (非エンジニアなので「ダブルクリック1回」に収める)。**
    - **①: 証明書を動かさない。** タスクを **ユーザー`info` / 「ログオン中のみ実行」/
      トリガー=ログオン時＋毎日 / 「開始時刻を過ぎたらすぐ開始」ON** で組む
      → **自動ログオンもLocalMachine移設も不要**。設定は XML で流し込み**タスクスケジューラを開かせない**。
      **登録直後に1回実行して○/×を表示**する(黙って失敗すると数週間気づけない)。
      **【電源だけでは走らない・ログオンが要る】**(よく聞かれる) ログオン時に即実行され、
      画面ロック中は走る。サインアウト/再起動放置で止まり、次のログオンで再開。
      **`last_to` 単調前進があるので取り漏れにはならない**=運用条件は「普段ログオンしたまま」だけ。
      「電源だけ」にするには B:「ログオン有無に関わらず実行」(Windowsパスワードを保存・
      **CurrentUser 証明書が使えるか未確認**) か C:自動ログオン(セキュリティ判断) が要る。
      **B は"たぶん動く"で採らない**。必要になったら②に検証を仕込んで1回で判定する。
      **LocalMachine へのコピーはやらない** (管理者権限+秘密鍵入りpfx。**エクスポート可否も未確認**)。
    - **②: OneDrive は PII の話**(利便性でない)。原本CSVは**個人情報を含み取込後に削除**する運用
      (`demecal_attended_manual_guide.md:114,127`) だが、同期フォルダだと**MSクラウドへ同期され
      ごみ箱/版履歴に残る**。→ 保存先 **`C:\demecal\`** 固定・不可なら `%LOCALAPPDATA%\demecal`
      (OneDrive既知フォルダ移動の対象外)・**パスに `OneDrive` を含んだら書かず中止**・
      送信成功後に削除・**使ったパスを必ず表示**。**接続チェックがデスクトップに出すのは意図どおり**
      (メール返送用・PII非含有)。変えるのは本番CSV取得だけ。
    - **OneDrive 側の設定は変えない (相手PCの設定に触らない)**。公式挙動で**停止すると既存ファイルが
      デバイスのフォルダーから見えなくなる**(support.microsoft.com ja-jp/office/…d61a7930) ため
      非エンジニアには「デスクトップが全部消えた」に見え、影響がPC業務全体に及ぶ。ポリシー強制なら操作も不可。
      **書き先を変えれば済む。**
    - **手動運用(attended)にも同じ危険**: 担当者がCSVを**デスクトップに保存**するとPIIがクラウドへ。
      → `demecal_attended_manual_guide.md` ステップ②-6 に**保存先を `C:\demecal\` に固定**
      (ブラウザ設定で明示変更) を明記済み。
      **【確定 2026-09-02・操作の録画で実測】保存先は「ダウンロード」フォルダ**(ブラウザ既定)。
      しかも **2026-02 以降の CSV が 15 本前後そのまま残置**されている(取込後に削除されていない)。
      OneDrive は接続されているが**ダウンロードに雲アイコンは無い**=同期対象に見えない
      (アイコンだけでは決定的でないので断定はしない)。②へ移れば `C:\demecal\` に落として
      送信後に削除するので増えない。**既存の残置分の扱いは Wellfort の判断**。
      (以下は確定前の記述) 手順書は「PCに保存される」としか
      書いておらず**フォルダ未指定**=ブラウザ既定任せ。OneDrive のバックアップ対象は
      **デスクトップ/ドキュメント/ミュージック/画像/ビデオ の5つでダウンロードは含まれない**(同出典)
      が、**それは一般論でこのPCの保存先が変更されていない確認にはならない**
      (「たぶん既定だから安全」と一度書いて撤回・2026-08-31)。確認は**エクスプローラーで
      `Q05-0010` を検索し場所に `OneDrive` が含まれるか**。**削除済みでもOneDriveごみ箱/版履歴に
      残り得る**。
  - **【ログイン形式 確定 2026-08-31・`demecal_login_page.html` 実測】サーバは ASP.NET Core MVC**
    (`DSS.Demecal.Web`)。`POST /account/login` に `UserID` / `Password` ＋
    **hidden `__RequestVerificationToken` (antiforgery) が在る**
    → **「GET でトークン取得 → 同一セッションで POST」が必須** (POST 1 回では通らない)。
    antiforgery は **hidden と Cookie (`.AspNetCore.Antiforgery.*`) の対**で検証されるので
    `-SessionVariable`/`-WebSession` を使い、**証明書は GET・POST の両方に付ける**。
    **ログインを動かす JS は無い**(素の form POST)。プローブの「input 4/script 5」は
    コメントアウト込みの素の出現数で、実体は input 3 (UserID/Password/token) + script 3。
    失敗時も **200** が返る(`validation-summary-valid` にエラー)ので**302 かフォーム消失で判定**。
    **`page.html` をリポジトリに入れない**(有効な antiforgery トークンの実値が入る)。構造は
    `docs/lab/demecal_powershell_probe_guide.md`「ログインフォームの構造」が正。
  - **未確定**: **ログイン後**の CSV 一覧 URL とダウンロードリンクの形 (プローブはログインしない設計)。
    実装に要るのはこれだけ。**専用PCでの実行が要る**(証明書がその PC にしかない)。
- 遺伝子 (`GeneticTestResultData`) … Genoplan。**【判定済み 2026-09-01・実測】RPA も PowerShell も専用PC も不要。
  サーバ側 (Vercel) から API 取得で確定。** 正本=`docs/lab/lab_data_reception_overview.md §4`。
  - **画面は Vue SPA だが背後は素の PHP REST API** (`https://bizapi.genoplan.com`)。
    `POST /api/biz/login.php` (`lang`/`loginid`/`password`・form-urlencoded) → `accesskey`。
    **以降は `accesskey` + `partner_seq` を body に載せるだけ**で、**Cookie セッション無し・
    CSRF トークン無し・`Authorization` 無し・ログイン経路に MFA/CAPTCHA 無し**
    (`sendAuthNumber`/`checkAuthNumber` はパスワード再設定・新規登録・電話番号認証にしか出ない)。
    → **デメカル (ASP.NET Core antiforgery の GET→POST 往復) より簡単**。
  - **PDF は直リンクで取れる** (`window.open(url)` のみ。`saveAs`/`createObjectURL`/`a.download` は 0 件)。
    一覧=`POST /api/biz/getKitInfoList.php` → 本レポート=`GET {lambda}/gpj/{lang}/{serialnumber}` →
    `{pdfUrl}` (S3 署名付き・1h) → GET。PCR=`.../pdfMaker5/dtc_pdf/php/download.php?qq={base64}`。
  - **クライアント証明書が無い**ので血液の「専用PCが必須」の理由が成立しない。
    **現地実行 bat は作らない** (PowerShell は「不可」でなく「不要」)。
  - **着手前に潰す (§4.2)**: **(a) Genoplan の自動アクセス許諾が未取得** (血液は承認済だが
    Genoplan は docs に記録 0 件。API 直叩きは RPA と別種の合意が要る) / (b) `multi=="Y"` の
    partner 選択 / (c) `getKitInfoList` が **`signer_name`/`signer_mobile` を返す**=PII 分離の設計 /
    (d) アカウント単位の IP 制限。
  - **先方へ報告 (§4.3)**: **PDF の署名付き URL を返す Lambda が無認証**。実測でシリアル番号だけで
    署名付き URL が返る (存在しないシリアルで確認・実在シリアルは試していない)。Wellfort 経由で伝える。
- 生活習慣・問診 (`LifestyleQuestionnaireData`) … アプリの AI 問診

### 検査値と原本の保存 (2026-08-20 確定・発注者承認)
- **検査値 = 案A-3 (ハイブリッド)**。`diagnosis.test_artifacts.measurements` (jsonb・原本忠実の全記録) と
  `diagnosis.measurement_values` (正規化・時系列グラフ用) の 2 層に書く。
  マイグレーション `supabase/migrations/20260820000010_measurement_values.sql`。
  - **書き込み口は `src/lib/measurement-persist.ts` の `persistMeasurements()` だけ**。両層を同時に書く。
    入力は `sanitizeMeasurementsForDelivery()` を通した後の lean measurement (整形はここでしない)。
  - 一意制約は `(artifact_id, seq)`。`(artifact_id, item_name)` にしない —
    同名別値は `observation-dedup` が競合として残す仕様のため、名前で一意にすると取込時に
    **行が黙って落ちる** (「サイレント脱落ゼロ」に反する)。
  - `canonical_name` は `standard-master.findByAlias` のヒット時のみ。非ヒットは null のまま (当て推量で埋めない)。
  - 旧計画の `diagnosis.test_artifact_items` は**不採用**。
- **原本ファイル = 案C′**。DB とホット層は Supabase (US Central) 据え置き、**原本だけ S3 `ap-northeast-1`**。
  署名 URL でブラウザとストレージが直結するため Vercel(iad1) は配信経路に入らない = レイテンシ不変。
  - 実装 `src/lib/originals-storage.ts`。**env `AWS_S3_ORIGINALS_BUCKET` が切替スイッチ**で、
    未設定なら Supabase Storage にフォールバック。読み出しは `storage_url` が `s3://` かで自動振り分け。
  - **Elith 連携用の `AWS_S3_BUCKET` (`wellfort-ai-input`) とは別変数**。上書きしない。
  - 10 年保管・削除不可 (§6.1) は S3 の Versioning + Object Lock で担保。構築手順は
    `docs/operations/S3原本ストレージ_構築手順書.md`。
    **Compliance モードはルートでも削除不可 (AWS公式)。テスト中は GOVERNANCE にすること。**
  - `file_kind` に `raw_pdf` を追加。**redaction は未実装**なので未処理の原本は `raw_pdf` を書く。
    `raw_pdf_redacted` は PII 除去を実装した経路でのみ使う (実態と名前を一致させる)。
- **Elith の AI 診断結果レポート (PDF) = パイプライン⑥・暫定実装 (2026-08-20)**。
  置き場所は **`diagnosis.diagnosis_results`** (`test_artifact_files` ではない —
  あちらは検査機関の原本。`diagnosis_results` が既に「Elith の診断結果 1 回分」を表す)。
  マイグレーション `supabase/migrations/20260820000040_diagnosis_report_pdf.sql` で
  `report_pdf_url` / `report_pdf_sha256` / `report_pdf_pages` / `report_pdf_received_at` を追加。
  - 取込 API = `src/pages/api/admin/elith-report/upload.ts` (Bearer `ADMIN_API_KEY`)。
    PDF を `putOriginal()` へ保存し、既存行を `status='superseded'` に落として新行を足す。
    **UI は wellfort-site 側**に作る (Scan-Chat-AI は API 提供側)。
  - 表示 = `src/lib/elith-report-queries.ts` `loadElithReport()` → `src/pages/report.astro`。
    実データが無い間は Elith 提供サンプル (`elith-report-sample.ts`・2026-08-06 Stage2 版) へ
    フォールバックする。3 モード (a サマリー / b 要注意抜粋 / c 全編 PDF) と `[pN]`→`#page=N`。
  - **要約はアプリが作らない**。a/b はレポート自身が持つ章 (アブストラクト / 医療受診の目安 /
    栄養素) と、本文に印字された `（判定区分：X）` の機械抽出だけ (`elith-report-highlights.ts`)。
  - 実データ経路の目視確認は `supabase/seed_elith_report.sql` (既定では読み込まない・手で流す)。
  - **受取仕様は未確定** (`docs/lab/lab_data_pipeline_master_spec.md:98`)。命名規則・出力トリガ・
    世代管理・ひも付け・受領確認が決まったら自動受信へ差し替える。
  - **【仕様変更 2026-08-28・発注者指示】報告書は「Elith の PDF を見せる」から
    「受領 JSON からアプリが生成する」へ変わる。正本 `docs/elith/AI疾病予防報告書_仕様書.md` ※ § 番号は旧版 `docs/旧版・ボツ/ai_prevention_report_generation_spec.md`。**
    目的は**フォーマット変換ではなく可読化** (Elith の出力は文章の羅列で一般ユーザーが読み通せない)。
    見本 PDF は**様式のお手本**であって埋める項目の一覧ではない。
    - **【前提】サービスの 2 本柱 = A 初期がんの早期発見 / B AI 診断による疾病予防アドバイス**
      (発注者確認 2026-08-28)。**年1回の人間ドックだけでは間隔が空くので、年3回の血液検査・
      がんリスク検査で隙間を埋めて年4回**にし、早期発見に繋げる。**その年4回の検査データを
      入力に AI 診断を回す**のが B。→ **A と B は別系統でなく、1つの検査サイクルからの2つの出力**
      (B の入力は A の検査結果)。**検査サイクル(第N回/全4回)は A の中でなく表紙に置く**
      (A・B 共通の枠なので)。**本報告書は B のみを担う** — 受領テキスト 20,080 字に「がん」「腫瘍」
      「マーカー」が **0 回**(腫瘍マーカーを5項目渡しているのに言及なし)。
      **【最重要】報告書は Elith の出力以上の表記・表現を一切しない (発注者指示 2026-08-28)**。
      役割は**可読化**。アプリのスキャン結果(腫瘍マーカー/ABC健診/画像所見)を報告書に並べ**ない**
      (一時その案を採ったが撤回)。**A の記述が無ければ仕様で決めた定型表現のみを出し、詳細は
      「がんリスク検査の結果を見る」リンクで別画面へ送る**。A の所見は Elith へ出力を依頼中
      (`status`付きフィールド)。**来なければカードごと非表示。記載が無いこと≠所見が無いこと。**
    - **氏名は報告書に表示する (発注者指示 2026-08-28)**。**PII 分離ルールは Elith・各検査機関など
      外部への受け渡しに適用されるものであって、本人への画面表示には適用されない**。
      Google 認証下の本人には個人情報保護方針に従って当然に表示する
      (アプリは既に `dashboard-queries.ts:416` で氏名表示済み)。
    - **ウェルネス年齢は Elith 出力の値のみ表示・併記しない**。**アプリが CABA で算出し
      `HealthAgeData` として Elith へ渡している** (`elith-assemble.ts:273`)。Elith は計算しないので
      **本来必ず一致する**。合成検体で不一致だったのはイレギュラー。**不一致は異常＝監査で検知**。
    - **サーバ側 PDF 生成は必要 (発注者判断 2026-08-28・前の「作らない」を撤回)**。
      ただし**都度でなく取込時に 1 回**生成して S3 へ保存する
      (表示経路に Chromium を入れない=60s回避 / 証跡が自動的に残る / 紙面の版と一致)。
      入力は `?print=1` の HTML なので**画面・印刷・PDF が同じレンダラ**から出る。
    - **報告書は 2 タイプある (発注者確認 2026-08-28)**。**どちらも正しい**。
      タイプ1 コースプラン=人間ドック+血液+**がんリスク検査**+AI問診 → Elith が がん について書く。
      タイプ2 単品購入=自分でスキャンした人間ドック+AI問診のみ。
      **タイプ判定はアプリが持つ (その回の入力にがんリスク検査があったか)。Elith 出力から推測しない。**
      実測: 2026-08-26検体(がんリスク検査なし)=「がん」0回 / 2026-08-06 Stage2(あり)=「がん」7回。
      **Stage2 では Elith 自身が「がんがないことを断定するものではない」と書いている** →
      タイプ1 で当社が但し書きを足さない (当社案「証明」より Elith の「断定」の方が弱く語彙も揃う)。
    - **タイプ2 の A 章も Elith に書いてもらう (発注者判断 2026-08-28)**。
      当社の定型文は構造上「範囲の説明」にしかならず、**「見た上で気になる点はなかった」と
      言えるのは Elith だけ**。単品購入者は 7,700 円を払いスキャンし問診に答えているので、
      「評価は含まれていません」だけでは**「見ていない」と読め不誠実**。依頼する文型=
      「今回お預かりした人間ドックの結果と問診の範囲では、がんに関して特に気になる点は
      見当たりませんでした。なお、がんリスク検査は今回の検査には含まれていません。」
      **当社の定型文はフォールバックに降格**し、味気なさは意図的に残す (妥協文言で埋めると
      Elith への依頼の必要性が見えなくなる)。**根拠: 腫瘍マーカー5項目を渡しているのに
      Elith は一言も触れていない** = 「見て問題なし」か「見ていない」かが判別できない。
    - **パイロット版 v0.1 の対象はタイプ2 (単品購入相当) のみ**。タイプ1 は
      **がんリスク検査ありの JSON 2 点を Elith から受領してから v0.2**。
      PDF から推測して作り込まない (入力の正は JSON)。
    - **報告書は年 4 回発行される** (①人間ドックのスキャン投稿後 ②③④ 血液/がんリスク検査時)。
      **回によって材料が違うので「材料が無い章は出さない」が第一級要件**(空カードを出さない)。
      **表示は常に最新版 1 件**・過去はアーカイブ閲覧レベル・**訂正版は考慮しない**
      (現行 `superseded`＋最新1件取得のままでよい)。紙面に「第 N 回」を印字。
    - **時系列はアプリで作らない (発注者判断)**。Elith が過去データを保持し最新診断時に常に参照
      した結果が報告書なので、**前回比・推移グラフをアプリで別途組むと二重の解釈になる**。
      ミッションは**最新版を正しく伝えること**。
    - **「要注意」という語を使わない**。がん早期発見が主軸のサービスで所見に赤い「要注意」を出すと
      **「がんの疑い」と読まれる**。→ 要注意項目=**まず確認すること** / 最優先=**医師に相談する項目** /
      判定は Elith 原文「基準範囲を上回っています」/ **赤は救急サインだけ**。
      「これはがんの話ではありません」とは書かない (A の章を隣に置けば伝わる。否定文は不安を生む)。
    - **生活習慣は【現状評価】→【行動提案】のペアで出す。維持/改善の自動分類はしない**
      (語尾判別は「続け**ながら**」を取りこぼす=脆い)。年4回で反復に見えやすいので
      **続けられている項目がそのまま出ること自体が価値**。
    - **検証に使った 2026-08-26 受領分は合成検体** (複数検査を1人分に組んだもの)。
      ゴールデン(humandock 20250217)と13項目一致し、**単位小文字 l=人間ドック/大文字 L=血液検査**で
      2検査が混在。→ **同名別値9組・日付統一・ヘマトクリット欠落は取り下げ**(Elith の不具合でない)。
      **残る指摘= 基準値が無い / `判定区分`・`[pN]` の消失 / 誤字「上上回っており」**。
    - **【設計方針・最重要】変更され続ける前提で作る (発注者指示 2026-08-28)**。本アプリの肝なので
      改善要望が絶えず出る。**「一度作って終わり」の画面にしない** (spec §1.2):
      ①**章立て(順序/表示可否/文言/開閉)は `app_config` に出しコードに埋めない** → 要望の大半が
      **デプロイ不要・admin から即時**になる (置き場所の判断=秘匿性。前例 `ui.support_contact`)
      ②**受領JSON → 表示モデル → レンダラ の 3 層**にし Elith の形式変更をアダプタ 1 枚で吸収
      (Stage2→3 で実際に `判定区分`/`[pN]` が消えた実績あり)
      ③変換規則は 1 モジュールに集約 (`sanitizeMeasurementsForDelivery` と同じ規律)
      ④**画面と `?print=1` は同じレンダラ**(章を足したら印刷にも自動で載る)
      ⑤fail-safe な抽出は**黙って空になる**ので admin に抽出監査を出す (`vqa_audit` と同流儀)
      ⑥fixture＋表示モデルのスナップショットで「文言を書き換えていない」ことを機械担保。
      **要望は (a)見せ方=設定 / (b)構造=コード追加 / (c)内容の創作=不可 に仕分ける**
      ((c) を (a)(b) のふりで受けない。断る根拠は spec §6)。
    - 受領は **1 件 = 3 ファイル** (`report_text.json` 10 セクション+`health_age` /
      `health_checkup.json` 40 項目 / 組版済み PDF)。**PDF は JSON の部分集合**で固有情報ゼロ
      (実測: JSON 19,870 字 / PDF 19,827 字)。しかも **PDF は箇条書き構造を潰す**ので
      **JSON のほうが素材として上位**。PDF は原本として保管し表示の主役から外す。
    - 出力は **HTML が正**。**サーバ側 PDF 生成はしない** (Vercel で Chromium=関数サイズと 60s に直撃・
      紙面が 2 系統になる)。証跡/外部配布の要件が固まったら Phase 2。
    - **印刷は `@media print` に依存させない (重要)**。iOS は 共有→**プリント**(印刷CSSが効く) と
      共有→**PDF**(効かない・こちらが見つけやすい) の 2 経路があり、後者では
      **折りたたんだ本文が PDF に載らない=中身が欠ける**。→ **印刷専用ビュー `/report?print=1`**
      (全展開・UI なしを**通常の画面 CSS**で出す) を用意し、`@media print` は上乗せに留める。
      どちらの経路でも同じ紙面になる。**`?print=1` では折りたたみを使わない**。
      iOS/Android の実機確認は未実施 (WebKit は手元で再現不可)。
    - **オフライン対応は「AI疾病予防報告書」だけ (発注者判断 2026-08-28)**。理由=他の検査報告書は
      **紙でユーザーの手元に届く**が、**これはアプリからしか入手できず**、かつ本アプリの肝だから。
      **アプリ全体のオフライン化は対象外。**
      - 手段は **A: 印刷専用ビュー → 共有 → PDF で「ファイル」アプリへ保存**。ブラウザのストレージの
        外に出るので **ITP のストレージ破棄で消えない**・アプリを開かずに見られる・追加インフラゼロ。
        画面に「iPhone に保存する」を独立導線で置き、端末別の手順を出す (50〜65 代に共有シートを
        自力で辿らせない)。
      - **Service Worker で報告書をキャッシュしない**: ①iOS のストレージ破棄の扱いが読めない
        (Apple 側の変更が続く領域・記憶を根拠にしない=R3) ②`/report` は SSR なのでオフライン表示は
        **認証を通さず HTML を返す**ことになり、端末のロックが解ければ他人の結果が読める
        ③実装量が大きい。**報告書 1 点を残すだけなら A で足りる。**
      - **ただし最小の SW は入れる**。現状 SW は無く (`grep` 0)、`manifest.webmanifest` が
        `display: standalone` なので**ホーム画面起動で「アプリの見た目の Safari エラー画面」**になる。
        オフライン案内を出すだけの SW に留める (報告書本体はキャッシュしない)。
      - **保存された控えは更新も回収もできない**。紙面に**作成日と版**を必ず印字し、新版受領時は
        アプリ側で「新しい報告書が届いています」を出す。消せると誤解させる UI を作らない。
    - **`elith-report-highlights.ts` は新形式で無言で空になる**。`（判定区分：X）` 依存 (L20) だが
      新データに **0 件**。検出を「基準範囲を上回っています」等の Elith 自身の判定文へ差し替える。
      `[pN]` も 0 件 → **原本 PDF へのページジャンプは廃止**。
    - **作れないもの (発注者判断: 受領に無いものは作らない)**: ①要注意/良好=Elith 判定文のある
      5 ブロックのみ ②原理/原因/疾患/予後/症状 = **原理のみ**取れる ③がんリスク = 全文に
      「がん」0 件で**不可** ④基準値比較 = 散文中の 8 件のみ (`health_checkup.json` に基準値が無い)。
      **これは欠損でなく方針の相違** — Elith は病名・原因・予後を意図的に書かない (ミッション④と一致)。
    - **受領データの既知不具合**: 同名別値 9 組 (総コレステロール 210/251 等・**自動採用しない**)、
      本文が使う**ヘマトクリットが JSON に無い** (2 ファイルは包含関係でない)、誤字「上上回っており」
      (**アプリで直さない**=原文改変)。
    - **表示名は「ウェルネス年齢」** (改称の確定事項どおり)。受領キーが `health_age` なのは
      **内部識別子だから据え置き**なのであって、画面に「健康年齢」と出す理由にはならない。
      当社 CABA と Elith `health_age` は**表示名が同じで算出主体が違い値も一致しない** →
      ①当社のみ ②Elith のみ ③両方(算出主体を併記) のどれかを決める必要がある (spec §1.2.8)。
    - **トピック抽出は決定論で足りる (2026-08-28 精査)**。`###`/`【】` 見出しから **39 トピック**
      抽出でき、冒頭1文が不適切なのは **39件中1件**。「詳しく見る」は同一HTML内アンカー
      (`[pN]` は新形式に無い)。**LLM は使わない** — 効果は実質1件、かつ LLM が得意な領域
      (要約/順位づけ/言い換え) は全て禁止事項と重なる。スキャン側の実績 (多数決撤回・
      inventoryReread の幻覚5件・VQA の捏造4件→「新規pushしない」) がそのまま効く。
      将来入れるなら **選択のみ/verbatim機械検証/取り込み時1回でDB保存/監査/既定off** が条件 (spec §5.5)。
    - **【実装済み 2026-08-29・パイロット版 v0.1】正本 `docs/elith/AI疾病予防報告書_仕様書.md` ※ § 番号は旧版 `docs/旧版・ボツ/ai_prevention_report_generation_spec.md` §9.3。**
      対象は**タイプ2 (単品購入相当) のみ** (§0.0)。タイプ1 はがんリスク検査ありの JSON 2 点を
      Elith から受領してから v0.2。
      - **構成 = 3 層** (spec §1.3.3)。`report-model.ts` (型・画面はこれしか知らない) /
        `report-sections.ts` (2本柱 `REPORT_AXES` は常設・章レジストリ・app_config 上書き・アンカー) /
        `report-adapter.ts` (**変換規則を所有する唯一のモジュール**) /
        `elith-report-queries.ts` (DB→アダプタ) / `report.astro` (画面と `?print=1` が同じレンダラ) /
        `api/admin/elith-report/upload.ts` (3ファイル対応・PDF は任意) /
        `api/admin/elith-report/audit.ts` (抽出監査) / `scripts/verify-report-model.ts` (回帰)。
      - **可読化の実体 = ダイジェストと全編を分けたこと**。**出す文を選んで構造に置き**、
        選ばれなかった文は全編に**畳んで**置く。実測: 受領本文 20,046 字 →
        **ダイジェスト 1,478 字 (削減率 92.6%)** / 画面の可視テキスト実測 1,985 字。
        1 回目のリバート理由が削減率 1% だったので、**回帰チェックで 80% 未満を落とす**。
        **全編は既定で全章を畳む** — 開くとダイジェストと同じ内容が二重に流れて 1 回目に戻る。
      - **「選択」であって「圧縮」ではない**。回帰チェックが、紙面に出る全文が受領 JSON の
        **部分文字列**であることを機械で確認する (唯一の例外 = 下記パイロット暫定文)。
      - **唯一の当社文 = `PILOT_CANCER_FINDING_TEXT`** (`report-adapter.ts`)。タイプ2 の主軸 A
        「今回の所見」に出す 2 文で、**Elith へ依頼中の文型そのもの** (spec §10.1 E-1)。
        発注者指示でパイロット版はこのまま出し、Wellfort/Elith の回答後に
        ① Elith の `cancer_screening.text` ② `ui.cancer_screening_not_included` のどちらかへ置き換える。
      - **踏んだ実装バグ 3 件 (すべて回帰チェックが検出)**:
        ①**単位の大小文字を潰すと 2 検体が混ざる** — 突き合わせキーを `toLowerCase()` していたため
        `mg/dL`(血液検査)と`mg/dl`(人間ドック)が同一視され、**Elith が判定していない行に判定が付いた**。
        ②**単位の切り出しが数字を食う** — `/^[\d.,\s]+/` は `585 10^4/ul` の単位側 `10` まで消していた。
        ③**`split('。')` して `。` を付け直すと原文に無い句点が生える**=原文改変。
        `match(/[^。]+。|[^。]+$/g)` に修正。
      - **判定は Elith が名指しした項目にだけ当てる**。「クレアチニンについても基準値との関係において…」
        のように判定句を伴わない言及には付けない (実測でクレアチニンの判定は空のまま)。
      - **app_config に 5 キー追加 → 当時 23 件** (現行 24 件・上記): `ui.cancer_screening_not_included` /
        `report.sections.{order,hidden,labels,collapsed}`。**既定は全て空**=コード既定。
        **未知キー・空白だけの値でコード既定へ落ちる** (打ち間違いで報告書を真っ白にしない)。
      - **【v0.1.1 で修正 2026-08-29】主軸 B が実データで白紙になった** (正本 spec §9.3.1)。
        原因は**受領形式の世代差を認識できていないこと 3 件**で、内容の不足ではない
        (本番 HTML から実測): ①`検査値フィードバック` の節が `【】` でなく `###`
        (`【`0件 / `###`8件) なのに `buildMeasurements` が `splitByBracket` 決め打ち
        ②基準値のコロンが**半角** (`基準値:`12件 / `基準値：`0件) なのに `VALUE_RE` が全角のみ
        ③`医療受診の目安`/`必要とする栄養素` に見出しが 0 件で `splitTopics` が空を返す。
        **ダイジェストの抽出は fail-safe なので誤った要点を出さない代わりに黙って空になる**
        (spec §1.3.6 が予告していた failure mode)。検証をサンプル 1 検体だけで行い、
        **本番 DB の別世代の検体を通していなかった**のが見落としの原因。
        → 対処はすべて**認識の拡張**で中身は作っていない: `基準値[：:]` 両対応 /
        `splitTopics` 経由へ変更 + 見出しの無い章は章まるごと 1 ブロック (`topicsOrWhole`) /
        `medical_visit`・`nutrients` は見出しの無い世代で**章の冒頭 2 文**。
        **`lifestyle` は直さない** — 【現状評価】【行動提案】が無い世代でペアを組むのは解釈
        (ミッション④) なので空のままにする。加えて**軸が空でも黙らない** —
        ダイジェスト 0 枚の軸に全編への案内文を出す (当社が代わりの要点は書かない)。
        回帰に**本番検体と同じ形の fixture** を追加。
      - **【モックの再現性チェック 2026-08-29・発注者指摘】正本 spec §1.3.10。**
        「モックを作っても再現性を検査していないなら作る意味が無い」という指摘。実際そのとおりで、
        v0.1 はモックと照合されないまま本番へ出て**検査値の並びがモックと違って**いたし、
        主軸 B の白紙化も「モックには 7 枚あるカードが実装では 1 枚」に気づけなかったのが本質。
        → **モックをリポジトリに置き、そこから「紙面契約」を機械抽出して実装と突き合わせる**。
        - `docs/elith/mock/ai_prevention_report_type2.html` … モック本体 (Artifact と同じ中身)。
          抽出が見るのは `data-card="<章キー>"` / `data-axis` / `data-note` の**3 つだけ**で、
          **CSS は一切見ない**。
        - `docs/elith/mock/sheet_contract_type2.json` … 生成物。**コミットする** —
          PR の差分に「紙面がどう変わるか」が文の単位で出る。
        - `npm run verify:sheet-contract` … 契約 ↔ 表示モデル (サーバ不要)。
          `-- --write` で契約を再生成。**契約 JSON を手で書き換えて通すのは禁止。**
        - `npm run verify:screen` … 契約 ↔ **実際の画面** ＋ 幅・行長の実測 (要 `npm run dev`)。
          表示モデルが正しくてもレンダラが描き落とせば画面は空になるので、ここで閉じる。
        - `npm run verify:report` … report-model + sheet-contract をまとめて。
        - **契約に入れるのは紙面の中身だけ** (どのカードが/どの見出しで/どの文を/どの順で)。
          色・余白・影・出典表記・リンクは入れない (見た目まで縛ると微調整で落ちて誰も直さなくなる)。
          幅は `verify:screen` が**実測値**で見る。
        - **紙面を変える手順は モック → 契約再生成 → 実装 の順だけ**。差分が出たら
          「モックが正」か「モックが古い」かで、**どちらであれ両方を突き合わせて直す**。
        - **導入即日で 5 件の差分が出た** (spec §1.3.10 の表)。うち①並び順=モックが正
          (Elith 本文の言及順と完全一致していた) → 実装を修正。②栄養素の節・③判定欄の長さ=
          実装が正 → モックを補正 (補正の内訳はモック HTML の冒頭コメントにも残す)。
          ④主軸 A のリンクは**遷移先が無く 404 だった** (`/result` は存在しないページ) →
          がんリスク検査がある回だけ `/result/{id}` へ送るよう修正。
        - **限界**: 契約は**この 1 検体の紙面**を固定するだけ。別世代の受領データで壊れることは
          防げない (それは §9.3.1 の fixture の仕事)。タイプ 1 はモックが v0.2 待ちで契約が無い。
      - **検証**: `npm run verify:report-model` 74/74 ・ `npm run verify:sheet-contract` 一致 ・
        `npm run verify:screen` 全ブレークポイント一致 ・ `astro check` 0 errors ・
        `astro build` 成功 ・ dev で `/report` `?print=1` `?save=1` とも 200。
      - **パイロット版で実装しないもの**: サーバ側 PDF 生成 (**決裁台帳 S-3 = 未裁定**。
        CLAUDE.md 内でも「必要」と「しない」が併存しているので、**実装で答えを出さない**) /
        iOS・Android 実機確認 (WebKit は手元で再現不可) / タイプ1 の紙面 (JSON 未受領)。
      - **【最小 SW とダッシュボードのタイル 2026-08-30・実装済み】正本 spec §4.4。**
        - **最小の SW を入れた** (発注者判断 2026-08-28 のとおり)。`public/sw.js` /
          `public/offline.html` / 登録は `BaseLayout.astro`。**報告書はキャッシュしない** —
          `/report` は SSR なので、キャッシュすると**認証を通さず HTML を返す**ことになる。
          - **ナビゲーション要求だけを見る**。API・CSS・JS・画像は `respondWith` を呼ばない=挙動不変。
          - **必ずネットワークが先**。失敗したときだけ案内を返す (古い結果・他人の結果を出さない)。
          - **キャッシュに入るのは `offline.html` 1 枚だけ**。だからそのページに個人のデータを
            1 文字も置かない (CSS もインライン。ビルドのハッシュ名 CSS は取れないため)。
          - **`?sw=off` で登録解除できる** — 実機で SW が悪さをしたときの逃げ道。
          - **実測 (Playwright)**: 登録=active / キャッシュ=`/offline.html` 1 件のみ /
            オフライン遷移→案内が出て**検査データの語 0 件** / オンライン復帰→本物の紙面
            (キャッシュを返し続けない) / 非ナビゲーション要求は素通し / `?sw=off` で 1→0。
        - **ダッシュボードのタイルから「サマリー ／ 要注意の抜粋 ／ 全編PDF」の 1 行を撤去した**
          (`ReportLinkCard.astro`)。理由 3 つ: ①`/report` にその 3 モードは無い (a/b/c は廃止)
          ②**「要注意」は使わない語** ③受領 PDF は表示の主役から外したので「全編PDF」も実態と違う。
          **代わりの説明文は置かない** — タイルが中身を先に名乗ると、名乗りに合わせて紙面を作る
          ことになる (紙面の正はモック)。
        - **【要裁定・実測 2026-08-30】3 モード (a/b/c) は `/result/[id]` に生きている。**
          `result-queries.ts:162` が `display_mode === 'three_mode'` を読み、
          `result/[id].astro:153,261,289` が a/b/c を描く。**そこには「要注意」の語も出る**
          (`:169`/`:253`/`:266`/`:274`)。決裁台帳 D-19 の対象なので**こちらの判断で消していない**
          (spec §6「ここに載っている項目に、実装で答えを出してはいけない」)。
        - **コード内の `spec §3.x` 参照は現行 §4.4 へ直した**。旧番号は
          `docs/旧版・ボツ/ai_prevention_report_generation_spec.md` のもので、
          **現行 正本には存在しない節を指していた** (参照先が 旧版・ボツ になっていた)。
      - **【デザイン見本のトレース 2026-08-30・発注者指示】正本 spec §4.3。**
        Wellfort 提示の `docs/elith/フォーマット見本_AI疾病予防レポート.pdf` (A4 18 ページ・画像のみ) を
        **画面と `?print=1` の両方で踏襲する**。**踏襲するのはデザインと様式だけで、項目と内容は踏襲しない**
        (見本の検査項目・文章・章立ては一切使わない。中身は Elith の出力だけ)。
        **見本は「様式のお手本」であって「埋める項目の一覧」ではない** — 過去に見本の 5 行テーブルを
        「埋めるべき項目」と読んで Elith が書いていない行を作ろうとした経緯がある。**枠は借りる。中身は借りない。**
        - **トークンは `global.css` の `.report-sheet` ブロックに閉じる**。**`tailwind.config.mjs` の
          `brand` は変えない** — 報告書の主色は見本の `#3BB6AE` (裁定 D-C1) だが、アプリの他画面は
          ブランド確定色 `#287F86` のままなので、**報告書だけのトークンを別に持つ**。
          値は見本 PDF を 150dpi で描画して**採色・採寸した実測値** (目分量ではない)。
        - **発注者裁定 3 件 (2026-08-29)**: **D-C1** 主色 = 見本の `#3BB6AE` を採る /
          **D-C2** 表紙のウェルネス年齢 = 当初「画面版には出さない・PDF 版は出す」→
          **2026-09-01 に見直し (D-C2′)。画面にも出す** (画面と PDF で表示が違う違和感の方が大きい) /
          **D-C3** 見本 p1 の「要注意項目 / 良好な項目」の語は**使わない**。
          **Elith の出力 JSON に無い文言・表現は一切使わない** (逐語ルールを見本にも適用)。
          この裁定により、軸が空のときに出していた当社の散文 (「今回の受領分からは要点を…」) も撤去した。
          **黙って空になることの検知は紙面ではなく抽出監査で行う。**
        - **採った要素とクラス**: `.rp-cover`/`.rp-brandline` (表紙) / `.rp-nums`/`.rp-num` (2 連大数字・
          **print のみ**) / `.rp-axis`/`.rp-badge` (章扉) / `.rp-h3` (`■` + 左 teal 縦バー) /
          `.rp-table` (teal ヘッダ・白抜き・**ゼブラなし**) / `.rp-lrow`/`.rp-lkey`/`.rp-lval` (左ラベル型) /
          `.rp-wrow` (週プラン) / `.rp-er` (**淡赤はここだけ**) / 走りフッター (`@page` のマージンボックス・印刷時のみ)。
        - **採らなかった要素**: 見本の 注記 / 2 カラム対比ボックス / 番号つき小見出し /
          teal ヘアライン見出し / 連絡先ボックス。**受領 JSON にその型で出す中身が無いため** —
          **型を先に置くと、埋めるために中身を作ることになる**。受領側に材料が出たら足す。
        - ~~**フッターにページ番号を入れない**。CSS だけでは採番できず、書けば捏造になる。~~
          → **撤回 (2026-09-03)**。`@page` のマージンボックスで `counter(page)`/`counter(pages)` が
          使えることを実測で確認 (Chrome/Edge 131+)。**ブラウザが数えた実際のページ数**なので捏造でない。
          走りフッター＋ページ番号を入れた (下記・spec §4.10)。
        - **契約は無変更で通った**: モックを見本のトークンで作り直しても `sheet_contract_type{1,2}.json` は
          **バイト単位で不変** = **中身は 1 文字も動かしていない**ことの機械的な証拠 (契約は紙面の中身だけを
          見て CSS を一切見ないため。spec §1.3.10)。
        - **【紙面が無かった 2026-08-30・発注者指摘「モックと全く違う」】正本 spec §4.3.5。**
          色・見出し・表の型・バッジ = **要素**は見本どおり入っていたのに、**それを載せる「紙」が
          無かった** (実測: モック 紙面 704px / 実装 1280px・表 588px→1248px・地の色が出ない)。
          アプリの画面に要素が並んでいるだけで、紙面として読めていなかった。
          - **見落とした理由**: 紙面契約は**中身しか見ない**(設計どおり)。`verify:screen` は
            「器の幅がダッシュボードと一致するか」を見るもので、**紙が在るかは誰も見ていなかった**。
            → `verify:screen` に **④紙面が在るか**を追加 (紙と地が別色か・表紙と本文枠が在るか。
            色の細部・余白・影は見ない)。**外して落ちることも確認済み**。
          - **【幅の裁定 2026-09-05・発注者・上書き】紙面 1000px + 行長 45em。** 正本 spec §4.3.5。
            発端は「PC の HTML 表示の改行が、枠に合わせて直したはずなのに直っていない」。
            **実測すると行長 38em は全幅で効いており (40em 超で折り返す要素 0 件) 直っていた** —
            合っていなかったのは**紙面の幅**。器いっぱい (1280px) だと本文 608px が紙面の
            **48%** しか使わず、表 1079px と食い違って「枠に合っていない」と読めた。
            → **器はダッシュボードと同じまま据え置き、`.rp-sheet` だけ `max-width:62.5rem`**。
            **これは下の 2026-08-30 の「`.rp-sheet` に max-width を置かない」を置き換える。**
            - **紙面と行長はセット**。紙面 1000px + 38em のままだと本文が紙面の **61%** =
              「白い紙が大きくなっただけ」(実測)。紙面 1280px + 行長だけ拡大だと 1 行 67 字で
              2026-08 の是正に逆行。**片方だけ動かすと静かに元へ戻るので `verify:screen` が対で見張る**
              (紙面が上限のとき本文はちょうど 45em であること)。退行 3 種で落ちることを確認済み。
            - **A4 相当 768px は不採用** (4 案を実撮して提示・①)。画面/印刷/モックが完全一致する
              唯一の案だが**PC で狭すぎるという発注者判断**。帰結として**画面 45 字 / 紙 38 字**。
            - **印刷は `.rp-plain` で 38em に据え置く**。`@media print` に載せない (iOS の 共有→PDF は
              印刷 CSS を通らない)。動かすと `verify:print` の「30 ページ / 使用率 96.5%」が黙って崩れる。
            - **中央寄せにしない** — `.rp-inner` は縦 flex なので `margin-inline:auto` だと
              **短い段落だけ縮んで中央へ寄り見出しと頭が揃わない** (モックで実測・2026-09-05)。左揃えが正。
            - **スマホは 1px も動かない**。**タブレット (768/834) だけ本文 608→642px (38→40 字)**
              (器の中身 643px で 45em が当たらず器で止まる)。実測 8 幅で横スクロールなし。
            - 全編は `.rp-sheet .md-region p/li` で**紙面の中だけ** 45em。`.md-region` の既定 38em は
              `/result` 等 他ページのものなので触らない。
            - モックも同段に揃えた。**紙面契約 JSON はバイト単位で不変**=中身は 1 文字も動いていない証拠。
          - **【幅の裁定 2026-08-30・発注者・上記で上書き済み】確定事項が衝突していた** —
            ①「`/report` はダッシュボードと同じ幅 (`width="app"`)」 ⇔ ②「見本=A4 紙面をトレース」
            (モックは 44rem 固定)。**裁定 = 幅は① / 紙面の器は②**
            (「幅は、モックと同じ固定にしないで、ダッシュボードと一緒にして」)。
            → `.rp-sheet` に **`max-width` を置かない**。白地・上部 teal ルール・本文左右 8.1%・
            地 `#F2F2F2` に浮く見え方は見本どおり。行長は器でなく本文側で 38em に止める。
            **紙面の幅だけがモックと違う。これは裁定であってずれではない** (契約は中身しか見ないので落ちない)。
          - 実測: 器=紙面=1280px (ダッシュボードと一致) / 紙 `rgb(255,255,255)` /
            地 `rgb(242,242,242)` / 本文 608px / 表 1248px→**1079px**。
          - **【モックの幅も揃えた 2026-08-30・発注者指示】** 以前はモックだけ 44rem 固定で、
            実装と並べると**紙面の幅だけ食い違って**いた。モックにも BaseLayout `WIDTH.app` の段
            (base28/sm42/md48/lg64/xl80/2xl88 rem) を写し、**行長は本文側で 38em** も入れた。
            実測: 390/768/834/1280/1440/1600 の全幅で ダッシュボード=実装=モック1・2 が同幅。
      - **【②の下に数直線を移植 2026-08-30・発注者指示】正本 spec §4.3.6 (裁定 D-C4)。**
        「見本の横並びは尊重しつつ、その下にダッシュボードのバーグラフ表示のレイアウトを移植」。
        **見本 p1 の 2 連大数字は変えず**、その下に `HealthAgeCard.astro` の数直線を移した
        (`?print=1` のみ = 裁定 D-C2 の範囲内)。**当社アプリに既にある型の移植**なので
        「見本にない型を発明しない」(§4.3.2) には当たらない。
        - **出すのは 2 値と目盛りだけ**。ゾーン塗り分けをしない・**差の解釈文を添えない**
          (ダッシュボード側の「実年齢より N 歳 低い」バッジと出典 details は移植しない = §4.1 逐語)。
        - **値は紙面と同じ回のもの**。ウェルネス年齢 = **Elith 受領値** / 実年齢 = 当社
          `health_age_scores`。**2 値が揃わない回は描かない** (片方だけで位置を作らない)。
        - **点に主色 `#3BB6AE` を使わない** — 白地に 2.5:1 で WCAG 1.4.11 (3:1) 未達。
          ダッシュボードと同じ brand-600 (#287F86 = 4.7:1)。帯は `--rp-teal-circle`
          (`--rp-teal-bg` はトラック上でほぼ見えなかった=実測)。
        - **`.rp-gauge` に `print-color-adjust: exact` が要る**。背景色だけで成立する図なので、
          無いと「共有 → プリント」経路で地色が落ち**点も帯も消えて空白の帯になる**。
        - 実測: 390・768・1280 の全幅で左右端が `.rp-nums` と一致・目盛りのはみ出しと重なり無し。
        - **【裁定 D-C2′ 2026-09-01・発注者指示】画面にも出す。** 当初は `?print=1` のみ
          (ダッシュボードで表示済みだから) としていたが、**画面と PDF で表示が違う違和感**の方が
          大きい、という判断。②の 2 連大数字と数直線は**画面・PDF 共通**になった。
      - **【ダイジェストから全編へ送る導線 2026-09-01・発注者裁定】正本 spec §4.9。**
        5 案をモックで比較し **案 03「カード下端の淡色バー」**を採用。カード末尾に出典と操作を
        1 つにまとめた**幅いっぱいの押せる面**を置く (文言=「詳しい説明を読む」+ 小さく出典)。
        - **色は見本にあるものだけ** — 地 `--rp-teal-panel` / 枠 `--rp-teal-circle`。
          **淡赤は救急サイン専用**なので使わない (裁定 D-C3 の波及)。タップ領域 44px 以上 (実測 71px)。
        - **`?print=1` には出さない** (紙に押せないボタンが印字されるため)。
        - **押しても何も起きないリンクを置かない** — 飛び先は `ChapterSpec.detailKeys` を順に見て
          **最初に紙面へ出ている章**。`report.sections.hidden` で隠した回は導線ごと消える。
        - **畳んだ章は先に開く** — クリック / `hashchange` / 直接ハッシュ の 3 経路すべて。
          `hashchange` を最初に取りこぼした (同一ページ内のハッシュ変更では script が再実行されない)。
        - あわせて**出典行 11px → 13px** (禁止事項「12px 以下を作らない」に触れていた)。
        - **紙面契約はこの変更を検証しない** (本文の文字しか見ない) ので `verify:screen` 側で見る。
          印刷ガードを外すと落ちることを実測で確認済み。
      - **【冒頭の総括 = アブストラクトを見本どおりに 2026-09-03・発注者指示】正本 spec §4.11。**
        「アブストラクトの表示セクションをウェルネス年齢のセクションの次に」「**そのまま、見本通りに**」。
        **見本 p1 の並びをそのまま採る** = 表紙 → 2 連大数字 → **総括の散文**。
        - 置き場所 = ウェルネス年齢 (2 連大数字＋数直線) の**直後・主軸 A の帯の前**。
        - 中身 = 受領 `abstract` の**全文そのまま** (要点の抜き出しをしない=「そのまま」)。
          **見出しも枠も付けない** (見本 p1 に見出しは無い = 当社が見出しを作らない)。
          段落割りは表示の規則 (`paragraphizeJa` 2 文ごと) をそのまま使い**文字は増減しない**。
        - **全編からは外す** (同じ文が 2 度出ない)。トピック 39 → **38 件**・文は 1 つも捨てていない。
          導線も付けない (飛び先の章が無い = 押しても何も起きないリンクを置かない)。
        - 実装 = `DigestCardVM.lead`。軸の繰り返しからは外れるが**紙面契約には通常のカードとして入る**
          (文が変われば契約 JSON の差分に出る)。`report.sections.hidden` に `abstract` を入れれば消える。
        - **既知の重なり**: 主軸 A「今回の所見」はがんリスク検査の項目名を含む文を
          アブストラクト/総評から選ぶので**冒頭の総括と 1 文重なる回がある**。
          **当社の判断で A から落とさない** (A の中身は §4.0.1 の裁定事項)。
        - 契約はモックから再生成 (タイプ2 7→**8** カード / タイプ1 6→**7** カード)。
      - **【改ページ・余白・ページ番号 2026-09-03・発注者指摘】正本 spec §4.10。**
        印刷した PDF を見て「改ページ、ヘッダー・フッターの余白が美しくない。ページ番号はあった方が良い」。
        **真因は印刷 CSS が カード・表・章 を丸ごと `break-inside: avoid` にしていたこと** —
        1 ページに入りきらない塊が丸ごと次ページへ送られ、**手前に巨大な空白**が残っていた。
        加えて `@page` の余白指定が無く、本文が紙の上下端に触れていた。
        - **実測 (preview=1 を PDF に焼いて比較)**: 32 ページ → **30 ページ** /
          本文領域の平均使用率 81.2% → **96.5%** / 使用率 50% 未満のページ **5 枚 (最悪 1.7%) → 0 枚** /
          上下の余白 無し → 上 16mm・下 14mm / ページ番号 無し → **N / M**。
        - **割ってよいものは割り、割ってはいけない最小単位だけを守る**: `break-inside: auto` =
          `.rp-card`/`details`/`table`/`.card` ・ `break-inside: avoid` = `.rp-nums`/`.rp-gauge`/
          `.rp-lrow`/`.rp-wrow`/`.rp-er`/`.rp-axis`/`tr`/`li` ・ `break-after: avoid` = 見出し
          (「全編」だけのページが出ていた) ・ `thead` は `table-header-group` で teal ヘッダを繰り返す。
        - **余白とページ番号は `@page`**。`margin: 16mm 0 14mm` (左右は `.rp-inner` の 8.1% が持つ)・
          `@page :first { margin-top: 0 }` で表紙の teal 帯は紙の端まで。
          **走りフッターは 2 本目の `@page` に分ける** — マージンボックス未対応のブラウザでは
          その塊だけが捨てられ、**余白指定は生き残る**。氏名と作成日は SSR で CSS に埋めるため
          `<style is:inline>` で出す (Astro の通常の `<style>` は静的な値しか持てない)。
        - **`.rp-sheet-foot` は撤去**。紙面の最後に 1 回しか出ず、見本の「全ページ下の帯」に
          なっていなかった。作成日と版は表紙に印字済みなので欠けない。
        - **検証 `npm run verify:print`** (新設・要 dev と poppler-utils)。`?preview=1&print=1` を
          **実際に PDF へ焼いて**、①表紙に番号が無い ②2 ページ目以降の全ページに連番
          ③使用率 50% 未満のページが無い ④紙の端にインクが触れていない を測る。
          **3 つとも壊して落ちることを確認済み。**
        - **未確認**: マージンボックスの対応は Chrome/Edge 131+ (出典 developer.chrome.com/blog/print-margins)。
          **Safari・Firefox は未確認**。**印刷ダイアログで余白「なし」を選ぶと `@page` は上書きされる**
          (余白も帯も消える) — 発注者の PDF はこの状態と一致していた。
      - **【「手元に残す」を端末別に作り直した 2026-09-02・発注者裁定】正本 spec §4.4。**
        テストユーザーから「分かり難い」。**iPhone 1 機種ぶんの手順しか無く**、Windows・Mac・
        Android にも同じ文が出ていた (**PC に「共有ボタン」は無い**ので読んでも実行できない)。
        5 案をモックで比較し **案 1 (端末を見分けて 1 本だけ) ＋ 案 3 (ボタンを 1 つにして PC は
        押すだけ)** を採用。実装 = `src/lib/save-steps.ts` + `report.astro`。
        - **押すものは 1 つ**「PDF にして保存する」。以前は 2 つ並び、しかも
          **「端末に保存する」を押しても保存されなかった** (手順が出るだけ)。
          **PC は押すと `?print=1&autoprint=1` へ送られ印刷ダイアログが直接開く**ので、
          読む手順は「PDF に保存」を選ぶ 1〜2 行だけ。**スマホには付けない**
          (Apple/Google の公式経路はブラウザのメニュー側で印刷ダイアログを通らない)。
        - **手順は公式の一次資料から起こす (R3)**。旧手順の「**指 2 本で広げる**」は公式に無い。
          Apple は 共有 →「マークアップ」→「完了」→「ファイルを保存」= **旧より 1 手少なく
          ジェスチャも不要**。4 端末の出典 URL は `save-steps.ts` の各 `source` と spec §4.4 の表。
        - **fail-safe が要件**: **サーバは 4 端末ぶんを全部描く** (端末はブラウザでしか判定できない
          = サーバ側で判定しない)。JS が動かなければ 4 つとも見えている・ボタンの既定の飛び先も
          `?print=1`。**判定できなかった回だけ 4 択を出す** (当てずっぽうで 1 つ選ばない)。
        - **iPadOS 13+ は Mac の UA を名乗る**。閾値は **`maxTouchPoints > 0`** —
          `> 1` だと実測で Mac 判定に落ちた (デスクトップの Mac にタッチ画面は無い)。
          取り違えると**手順そのものが的外れになる**ので `verify:screen` が UA 別に見張る。
        - **文言は app_config `ui.save_steps` で差し替え可** (OS 更新でメニュー名が変わるため)。
          書式 `端末キー=手順1｜手順2｜手順3` をカンマ区切り。**上書きは素の文**になる。
          解釈できないキー・空の手順は無視 = **手順が 1 行も無い状態を作らない**。
          → **app_config 現行 28 件**。
        - **検証**: `verify:screen` に ①端末 4 種が描かれ判定不能なら 4 つとも見える
          ②**印刷ビューに保存手順が出ていない** ③UA 別 (Windows/Mac/iPhone/**iPad**/Android) の
          分岐と `autoprint` の有無 を追加。**3 つとも壊して落ちることを確認済み**。
        - **`?save=1` の開閉は廃止** (手順が 3 行になったので常時表示)。
        - **実機確認は未実施のまま**。マークアップ経由の PDF が `?print=1` の紙面をそのまま写すかは
          手元の Chromium で再現できない。**iPhone・Android の実機で 1 回ずつ通す**のが完了条件。
      - **【紙面の色を印刷でも必ず出す 2026-08-30・発注者指示】正本 spec §4.4。**
        ブラウザの印刷ダイアログの**「背景のグラフィック」は既定がオフ**で、そのままだと
        `background` の色が全部落ちる。実測 (Chromium `printBackground:false` で同じ
        `?print=1` を PDF 化して比較): **表紙の淡 teal パネル・円モチーフ・章扉の帯・
        丸バッジ・表の teal ヘッダが白く抜け**、見本トレースが文字と罫線だけになった。
        → **`.report-sheet` に `print-color-adjust: exact`** (紙面の中だけ。他の画面に広げない)。
        実測: 対処前 表紙パネル `rgb(255,255,255)` → 対処後 `rgb(240,250,251)`=`#F0FAFB`。
        **未確認**: iOS Safari の既定値と設定項目の有無 (§4.4 の実機未確認に含む)。
      - **【モックを画面から見せる 2026-08-30・発注者指示】正本 spec §4.7。**
        タイプ1 を関係者に先に見せるため、`docs/elith/mock/*.html` を**1 バイトも
        書き換えずに**返す口 `GET /report-mock/{1,2}` を足し、`/dashboard` の
        「デバッグ (テストフェーズ確認用)」にリンクを置いた。**実装ではなくモックそのもの**
        なので「タイプ1 を PDF から推測して作り込まない」(§2.1) は破っていない。
        個人情報は無い (「（ご本人氏名）様」/ 合成検体・DB を引かない)。
        **デバッグ欄を遮蔽するときにこの口も一緒に閉じる。**
        - **【撤去済み 2026-09-01・発注者指示】**「モックは元々**本番画面で見せるものでもない**」。
          タイプ1 の実装ができたので口の役目は終わり、`/report-mock/[type]` とリンクを削除した。
          **モックは紙面の正のまま**リポジトリに在り、突き合わせは `verify:sheet-contract` が機械で行う。
          デバッグ欄に残るのは `?preview=1|2` (受領 JSON から本番のレンダラで生成した紙面) だけ。
        - **【重要な発見】リポジトリのモックは CSS が落ちていた** (spec §4.7.1)。
          `.anno`(解説の破線箱)・`.cyclab`/`.cycle`/`.now`(検査サイクル)・`.filled`・
          `.j-o`/`.j-w`/`.j-x`(判定の色。**タイプ2 も**)・`--alt` ほか 5 トークンが**未定義**で、
          **解説ブロックが紙面の本文と同じ見た目で流れていた** (モック自身の banner は
          「破線のブロック」と書いているのに)。原因は 2026-08-30 の見本トークンでの作り直しで
          新トークン表に無いルールが落ちたこと。値は**オーサライズ済の公開 Artifact
          (`d633fc3f…`) から取って復元**した (こちらで作った色ではない)。
        - **紙面契約はこれを検出できない**。契約は `data-card`/`data-axis`/`data-note` と
          **本文の文字だけ**を見て CSS を一切見ない → **「契約が緑=モックが正しく描けている」
          ではない**。実際この復元でも契約 JSON はバイト単位で不変だった。
      - **【「中身が空」の真因 = seed の旧デモ行 2026-08-30・実測確定】正本 spec §4.5.1。**
        **2 時間 admin ゲートを追ったが、ゲートは原因ではなかった。** 本番の自己診断
        (`GET /api/debug/viewer`) 実測: `is_admin=true` / `demo_fallback_enabled=true` /
        **`received.rows=4` 最新 `2026-01-24`**。
        - **実データが在るのでサンプル (2026-08-26 受領 JSON・20,046 字) は使われない**。
          紙面になっていたのは `supabase/seed.sql` の旧デモ行 = `アブストラクト`(120字) +
          `医療受診の目安`(80字) の **2 セクション・計 200 字** (`elith-v1.0` 配列)。
          ローカル再現: ダイジェスト 2 枚 / 全編 2 章。**紙面は正しく動いていた。**
        - **admin は全員こうなる**: `seed_admin_users.sql` が `d0000001` の
          `diagnosis_results` を各 admin uid へコピーするため。`loadReportVM` は
          「実データ → サンプル」の順なので**サンプルには永久に落ちない**。
        - **直し方 (実装済み)**: 当初「サンプル優先に変えない」と書いたが、**それでは admin が
          手作業で取り込むまで紙面を確認できない** (しかも admin 全員が同じ状態)。運用でなく
          コードで閉じた → `loadReportVM` が**旧形式 (`elith-v1.0` 配列) の行を admin の
          デモ表示のときだけ飛ばし**、現行形式のサンプルを出す。
          **実顧客への影響は無い** (デモ表示が無効なのでこの分岐に入らない) /
          **現行形式の実データが入れば本物が勝つ** / **旧行は消さない**(監査のため)。
          実測: ダイジェスト 2→**7 枚** / 主軸 B **1→6 枚** / 全編 2→**10 章**。
          `verify:demo-gate` が**この分岐が `demoFallbackEnabled` の内側にある**ことを機械で見る
          (外に出ると実顧客の実データを隠すため)。
          受領 JSON を**本物として**入れるなら従来どおり `scripts/ingest-elith-report.mjs`。
        - **再発防止**: `/api/debug/viewer` の `received` に `schema_version` /
          `latest_sections` / `latest_chars` を出し、2,000 字未満なら
          「紙面が薄いのは実装ではなく行の中身」と明示する。
          **行の有無だけを見て「データは在る」と判断しない。**
      - **【本番の報告書が空だった 2026-08-30・発注者指摘「モックと全然ちがう」】正本 spec §4.5。**
        **紙面の作りは壊れていない。材料が 1 件も無かった。**
        `buildReportVM({reportText:null,checkup:null,issuedOn:''})` を通すと**画面と完全一致**
        (作成日 空 / ダイジェスト 1 枚=`a:今回の所見` / 全編 0 章 / `isSample:false`) = `emptyVM`。
        - **原因は仕様どおりの動作**。本番は `13a8a95` で「本番相当」へ切替済みで、
          `demo-data.ts:50-54` が **①env `PUBLIC_DEMO_FALLBACK` が `'false'` でない かつ
          ②uid が admin (`admin-auth.ts:44-51` のハードコード 7 件)** の AND。
          実顧客に他人名義のサンプルを見せないための保護 (同 `:40-42` に明記)。
        - **サンプルのゲートは緩めない。材料を実データとして入れる**。本番と同じ経路を通るので
          表示も本番と同じ「実データの紙面」になる (「サンプル表示」バッジも出ない)。
        - 入れ方 = `node scripts/ingest-elith-report.mjs --uid <diagnostic_user_id> --key <ADMIN_API_KEY>`。
          **uid は `/dashboard` の「デバッグ」に出ている**。キーは **Vercel の環境変数が正**で
          スクリプトは保存しない。経路は既存の `POST /api/admin/elith-report/upload`
          (**admin 取込画面は作らない** = 発注者指示)。世代管理があるので何度流しても最新 1 件。
        - **`admin_users` と `ADMIN_UIDS` の二重管理は既知の穴**: `ADMIN_EMAILS` には
          `hamada@eentry.co.jp` が「開発用バックアップ」で入っている (`admin-auth.ts:21`) が、
          `ADMIN_UIDS` に対応する行が無い = **email で admin・uid で非 admin** になり得る。
          総合テストで `admin_users` 照会へ寄せるときに併せて潰す。
        - **検証 (実測)**: `.rp-badge`/`.rp-table th` の地 = `rgb(59,182,174)`=`#3BB6AE` ・
          表紙パネル = `rgb(240,250,251)`=`#F0FAFB` ・`.rp-nums` は `?print=1` にのみ存在 ・
          `.rp-sheet-foot` は画面で `display:none` (**2026-09-03 に撤去**) ・`verify:report-model` 74/74 ・
          `verify:sheet-contract` 一致 ・`verify:screen` 全ブレークポイント一致 ・`astro check` 0 errors ・
          `astro build` 成功 ・dev で `/report` `?print=1` `?save=1` とも 200。
    - **【1 回目はリバート済み 2026-08-29】上記の前に入れた実装 (P0〜P4) は全て取り消した。**
      理由は可読化 (spec §1.1) を満たしていないこと (画面本文 20,297 字 / 受領本文 20,490 字 =
      **削減率 1%**) と、設計ポリシー (spec §1.0 = サービスの 2 本柱) に従っていないこと。
      **本機能は未実装。** 着手する人は `docs/旧版・ボツ/ai_prevention_report_HANDOVER.md` を先に読む。
      仕様の正本は `docs/旧版・ボツ/ai_prevention_report_generation_spec.md`。
      リバート内容の記録は `docs/旧版・ボツ/ai_prevention_report_REVERT_LIST.md`。
      - **リバートで戻したもの**: `report.astro` (旧 3 モード a/b/c) / `elith-report-highlights.ts` /
        `elith-report-queries.ts` / `elith-report-sample.ts` / `report-view.ts` /
        `api/admin/elith-report/upload.ts` (PDF 必須へ戻る) / `app-config.ts` / `package.json`。
      - **削除したもの**: `report-adapter.ts` / `report-model.ts` / `report-sections.ts` /
        `api/admin/elith-report/audit.ts` / `scripts/verify-report-model.ts`。
        app_config の 5 キー (`ui.cancer_screening_not_included` / `report.sections.*` 4 本) も消えた
        (**2 回目の実装で同じキーを入れ直した** → 当時 23 件)。
      - **残したもの**: `src/data/elith/report_text_20260826.json` /
        `health_checkup_20260826.json` (2026-08-26 受領分・合成検体)。**参照コードは無くなったが、
        HANDOVER §2.3 が素材の在処として名指ししているデータなので消さない。**
      - **戻した `elith-report-highlights.ts` は実データで無言で空になる**。実測: 受領 JSON
        (2026-08-26) は `（判定区分：）` **0 件** / `[pN]` **0 件**。旧サンプルにある `[pN]` 10 件は
        **アプリが PDF 抽出時に付けたページマーカー**で Elith 由来ではない (Stage2 PDF 原本も 0 件)。
        **サンプルでは動き実データで何も出ない**状態なので、作り直しでは Elith 自身の判定文
        (`基準範囲を上…` = 受領 JSON に実測 5 件) から検出し直す。`report.astro` と結合しており
        (`report.astro:7` が import)、切り離すとビルドが通らないため一体で戻してある。
      - **`checkup_values` 列のマイグレーションは残した (発注者確認 2026-08-29「適用済み」)**。
        `supabase/migrations/20260829000010_diagnosis_report_checkup.sql`。
        **一度は消したが、Supabase へ適用済みと分かったので復元した** (ファイルを消すと
        DB に列だけが残りマイグレーション履歴と食い違うため)。**`drop column` はしない** —
        受け皿は作り直しでも要る (spec §8.2「2 ファイルは包含関係でない」)。
        - **現状は読み書きするコードが無い**。`elith-report-queries.ts` は `checkup_values` を
          select しないし、`upload.ts` は `health_checkup` を受け付けない (どちらもリバート済み)。
          **列は存在するが常に null** = 無害だが、作り直しまで使われない。
        - **コメントの食い違いは前進マイグレーションで解消した**
          (`20260829000020_diagnosis_report_checkup_comment.sql`・**要 `db push`**)。
          `20260829000010` のコメントは同日の実装 (P0〜P4) を前提に書かれており、
          「`schema_version=elith-v2.0` は dict 形式」と書いてあるが**リバート後は
          `elith-v2.0` を書くコードが無い** (`schema_version` の既定は `20260601000010` の
          `'elith-v1.0'`)。`checkup_values` も「受け皿」とだけ書かれ、読み書きが無いことに
          触れていなかった。→ 両方のコメントを現状に書き換えた。**COMMENT 文のみで DDL なし**。
        - **【重要】適用済みのマイグレーションを編集して当て直さないこと。** 適用は
          `supabase db push` (未適用ぶんのみ反映・`schema_migrations` で状態管理。
          `docs/hp_ec/連携_DB適用プロセス課題と対策.md`) なので、**編集は push でスキップされ
          新環境 (`db reset`) にしか届かず、同じファイル名で中身の違う DB が並ぶ**。
          直すときは必ず前進マイグレーションを足す。

### ウェルネス年齢 (旧称: 健康年齢・2026-08 確定・発注者指示)
- **名称は「ウェルネス年齢」**。画面・帳票・ドキュメントの表示名は全部これ。
  **内部識別子は据え置き** (`HealthAgeData` / `data.health_age` / `diagnosis.health_age_scores` /
  `ui.health_age_followup` / `src/lib/health-age*.ts` 等)。`HealthAgeData` は **Elith との受け渡し
  format_id なので勝手に変えない** (変更には Elith 合意が要る)。納品 JSON の `source.note` にだけ
  「ウェルネス年齢 (旧称: 健康年齢 / CABA)」と両名を書いて先方が気づけるようにしてある。
  ※ wellfort-site の企業サイト側スローガン「定年は『健康年齢』で決める」は**アプリの機能名ではない**
    ので今回の改称対象外 (`HealthManagement.astro` / `InvestmentRisk.astro`)。
- **算出は 3 段階フォールバック**。入口は `src/lib/wellness-age.ts` の `computeWellnessAge` **だけ**
  (`computeHealthAge` を直接呼ばない)。
  1. **①正規版 CABA v5.4** (`health-age.ts`)。不足項目は合理的に補填してから算出 (MCV=赤血球+Ht /
     RDW=13.0 / CRP=NLR推定→0.15 / WBC 桁正規化 / BMI=身長体重)。正本 `docs/scan/health_age_caba_v5.4_spec.md`。
  2. **②簡易版 CABA v7.0** (`health-age-simple.ts`)。血球分画・ALP・WBC・hs-CRP を持たない簡易書式向け。
     必須= 実年齢・アルブミン・クレアチニン ＋ (血糖 **または** HbA1c。血糖欠測時は eAG=28.7×HbA1c−46.7 で代用)。
     正本 `docs/scan/health_age_simple_v7.0_spec.md` (係数表・移植の復元手順・実ブラウザとの数値照合9件全一致)。
  3. **③算出不能** → 値を作らず定型文 `WELLNESS_AGE_UNAVAILABLE_MESSAGE`
     =「算出に必要なデータが不足しています。詳細は事務局へお問合せ下さい。」を提示。**文言を変えない**。
     API は 422・**保存しない** (`health_age_scores` に null 行を作らない=捏造ゼロ)。
- **どの版で出したかを必ず残す**: API 応答 `method` / `inputs.method` / `model_version`
  (`CABA-v5.4` or `CABA-SIMPLE-v7.0`) / ダッシュボード見出し右。**簡易版は係数が暫定・血糖が eAG 推定に
  なり得る**ため、版を伏せて数値だけ比較しない (①②で同じ検体でも値は一致しない=②だけ tanh 圧縮がある)。

### UI / デザイン (2026-08 刷新)
- **ブランド**: 顧客向け主ブランド = **Welltect** / 運営 = Wellfort。主な利用者は 50〜65 代の経営者・役員。
- **トークンは `tailwind.config.mjs` に集約**。既存クラス名は変えず**パレットの解決先だけ差し替える**方針
  (brand-/slate- は数百箇所で使用中。改名すると差分が全ファイルに広がる)。
  brand = Precision Teal `#287F86` (操作の色) / slate = Warm Ivory〜Graphite / navy・mist・bronze・status.* を追加。
  装飾の cyan/sky/blue/indigo/violet は navy へ寄せて中立化済み。
  - **Quiet Bronze `#A98558` はヘアラインと小面積のみ**。ボタン・カード背景に使わない。
  - **ステータス色は `status.*`** でブランド色と分離。表示は必ず アイコン + テキスト + 色 の 3 点セット。
  - 配色変更時は **WCAG AA を数値で検証**すること (過去に 2 ペアが不足し調整した実績あり)。
- **禁止事項 (発注者指定)**: フルダークモード / グラスモーフィズム / ネオン・発光 / 過度な影 /
  **絵文字を本番素材にする** / 小さく薄いグレー文字 (12px 以下を作らない)。
- **アイコンは Lucide 一本 (`@lucide/astro`, ISC)**。入口は `src/components/AppIcon.astro` の**静的マッピングのみ**
  (動的な文字列ロードをしない)。JS から HTML を組む箇所は `src/lib/icon-svg.ts`。
  - **絵文字を戻さないこと**。`live-controller.ts` の Live プロンプト・`scan-prompt.ts`・`elith-samples.ts` は対象外。
- **ロゴは `src/lib/brand.ts` が解決**。`public/welltect_logo.svg` 等を置けば自動的に切り替わる。
  ブランド資産を目視トレースした代替 SVG は作らない。
- **和文の組版 (2026-08 確定・長文が読めない指摘を受けて)**
  - **【`font-mono` の和文が中国語フォントに落ちていた 2026-09-03・発注者指摘】正本 spec §4.12。**
    「漢字が変 (中国語漢字のように見える)」。**本文は正しく BIZ UDGothic** で出ており、
    落ちていたのは **`font-mono` を当てた和文** (出典行「アブストラクト」
    「医療受診の目安 §1〜§4」・走りフッターの氏名)。
    - **Tailwind 既定の `mono` には和文フォントが 1 つも無い** → 和文だけがブラウザ既定の
      フォールバックへ。実測 (PDF に埋め込まれたフォント名): 発注者の Windows/Chrome =
      Consolas + **YuGothicUI** + BIZ-UDGothic / この環境の Linux = **WenQuanYi Zen Hei (中国語)**。
    - 対処 = `fontFamily.mono` に和文の受け皿を追加 (欧文・数字は等幅フェイスのまま=
      Consolas 等は漢字を持たない・`tabular-nums` に影響なし)。`.rp-kbd` と
      **`@page` の走りフッター**にも明示。`fontFamily.sans` 末尾にも `Yu Gothic UI`/`Yu Gothic`/
      `Meiryo`/`Noto Sans CJK JP` を保険で追加 (**手前が先に当たるので既存環境の挙動は不変**)。
    - **検証 `verify:print` の ⓪** = PDF に埋め込まれたフォント名を見て中国語・韓国語向けが
      混ざったら落とす。**壊して落ちることを確認済み** (mono から和文を外すと WenQuanYiZenHei で落ちる)。
    - **この作業環境には和文が IPAGothic しか無い** (既定 sans-serif = WenQuanYi Zen Hei) ので、
      控えの PDF が中国字形になる。**BIZ UDGothic (Google Fonts・SIL OFL) を入れて確認**している。
  - **`font-feature-settings: 'palt'` は使わない**。和文を詰めるので句読点・カギカッコの
    アキまで削られ、長文で文の切れ目が見えなくなる (実機 Windows で顕在化)。詰め組みが
    要るのは大きな見出しだけで、本文には不要。`global.css` の body から撤去済み。
  - **和文フォントは `BIZ UDGothic` (モリサワ UD フォント) を優先**。`tailwind.config.mjs`
    の `fontFamily.sans` で 欧文/数字 = system-ui、和文 = BIZ UDGothic → Hiragino Sans →
    Noto Sans JP の順に落とす (フォールバックは 1 文字ずつ効く)。
    - **Windows 10 October 2018 Update 以降に OS 標準搭載**なので主要利用者には
      追加ダウンロード無しで届く (出典: モリサワ ニュースリリース morisawa.co.jp/about/news/4010)。
    - **等幅版 (UDGothic) を使う。プロポーショナル版 (UDPGothic) は句読点を詰める**ため、
      今回の指摘に逆行する。欧文・数字は system-ui 側が出すので等幅の影響を受けない。
    - **Web フォントは入れない**。Google Fonts の和文は実測で 400+700 のサブセットが
      約 700KB (BIZ UDGothic 693KB / Noto Sans JP 988KB・本文 603 字で使われる分)。
      統一感のために入れるかは費用対効果で別途判断する。
  - **長文の行長は 38em (≒和文 38 字) で止める**。ワイド画面ではカード幅いっぱいに伸びて
    1 行 90 字超になり目線が戻れない。`.md-region p / li` に `max-width` を掛ける
    (表・画像は対象外)。
  - **行間は詰め気味に (2026-08 見直し)**。「文字が大きすぎる / 1 画面に入る量が少ない」の
    実体は**文字サイズではなく行間**だった。**本文 16px は据え置き** (iOS/Web の標準的な
    本文サイズで、これ以下にすると別の読みづらさが出る)。代わりに
    `fontSize.base` の行間 1.85 → **1.75**、`.md-summary p` は 2.0 → **1.75**、
    `.card` の内側余白はスマホで `p-4` (sm 以上は `p-5`) にした。
    実測 (iPhone 15 Pro 相当 393pt): 1 画面あたり 330 字 → **377 字** / サマリー全体
    5.0 画面 → **4.7 画面**。**高齢者向けに大きくする発想は採らない** (発注者指定
    2026-08:「老人向けサービスでもらくらくホンでもない。30 代でも違和感のないサイズに」)。
    老眼対応は OS/ブラウザの文字拡大に委ねる。
  - **段落化は `report-view.ts` の `paragraphizeJa()`**。Elith のレポートは 1 章が
    まるごと 1 段落 (改行なし・600 字超) で届くため、「。」2 文ごとに空行を入れて段落に割る。
    **内容には触れない** (要約・言い換え・並べ替えをしない = ミッション④)。見出し/箇条書き/
    表/引用など Markdown の構造行は対象外。
  - **文頭の主題を太字にする `emphasizeTopicJa()`** (同ファイル)。均一な灰色の塊で
    「何の話か目に入ってこない」を避ける。**どこが重要かは判断しない** — 日本語の
    主題提示部 (「〜について(は)」「〜に関して(は)」「〜としては」「〜では」「〜は」) を
    文法的に拾うだけで、マーカーが無い文は何もしない。指示語 (これは/その…) は除外。
    **1 段落 1 箇所まで** (全文が太字だと強調の意味が消える)。文字は増減させず `**` を
    挿すだけ = ミッション④ の範囲内。
  - **`**小見出し**` だけの行は `headingizeBoldLines()` で h4 に変換する**。
    以前は CSS の `p:has(> strong:first-child:last-child)` で「太字だけの段落」を
    小見出し扱いにしていたが、**`:first-child`/`:last-child` は text ノードを数えない**ため
    文中に 1 箇所強調を入れた段落まで一致し、**段落全体が太字になる**回帰を出した
    (実測 2026-08)。構造は CSS で推測せず、変換して h4 として出す。
  - **`/report` の紙面は 1000px・行長 45em (裁定 2026-09-05)**。器は下記のとおり
    `width="app"` (ダッシュボードと同じ) のままで、**紙面 `.rp-sheet` だけ 1000px で止める**。
    印刷 (`?print=1`) は A4 なので**行長 38em に据え置き**。詳細は上の【幅の裁定 2026-09-05】。
  - **`/report` (AI疾病予防報告書) は `BaseLayout width="app"`** = ダッシュボードと同じ幅
    (2026-08-29 発注者指示。旧: `flow`)。ダッシュボードのタイルから来るので、`flow`
    (lg 以上で 672px 止まり) だと PC・タブレットで**直前の画面より急に狭くなる**。
    **行長は器ではなく本文側で止める** (`global.css` の `.report-prose`)。
    表 (検査値) には付けないので広い幅をそのまま使える。
    ~~実測: 1440px で `/dashboard` `/report` とも器 1280px・ダイジェスト本文 608px。~~
    → **2026-09-05 に更新**: 1440px で 器 1280px / **紙面 1000px** / **本文 720px (45em)**。
    他の読み物ページ (`/coach` 等) は `flow` のまま。
  - **未対応 (発注者判断 2026-08「とりあえず現状のまま」)**: `/notices` と `/coach` は
    今回の刷新の対象外で、本文が `text-xs` (13px) 中心 + `leading-relaxed` の個別指定なので
    **行間トークンの見直しが届いていない** (実測で他ページが -4〜-11% のところ ±0%)。
    他ページと文字サイズの基準が揃っていない。揃えるなら別途作業。
- **ダッシュボード v1.0 (2026-08 発注者承認・モック → 実装)**。モック=Artifact
  「Welltect UI v1.0 モックアップ」(PC/スマホ、ウェルネス年齢の表示案、ボタンの色の表示案)。
  並び順は **ウェルネス年齢＋AI疾病予防報告書 → 検査結果 → 検査キットの進捗 → AIスキャン/AI問診 →
  医師との面談** の 1 カラム。旧 2 カラム (左=閲覧 / 右=状況) は廃止。
  - **名称 (2026-08 発注者指示・企業サイトの表記に合わせる)**:
    健康年齢 → **ウェルネス年齢** / AI 診断結果・AI疾病予防レポート → **AI疾病予防報告書** /
    AI疾病予測 → **AI疾病予測報告書** / オンライン相談 → **医師との面談（オプション）**。
    **表示名の正本は `src/lib/display-names.ts`** (`AI_PREVENTION_REPORT_LABEL` /
    `AI_PREDICTION_REPORT_LABEL`。ウェルネス年齢だけは算出と一体なので
    `wellness-age.ts` の `WELLNESS_AGE_LABEL`)。**改称するときはここだけを直す** —
    同じものが画面ごとに違う名前で出ていて置き換え漏れが出た実績がある。
    **内部識別子は変えない** (`health_age_scores` / `ui.health_age_followup` /
    `HealthAgeLatest` / 検査種別コード `ai_prediction` / format_id はそのまま)。
    検査機関との呼称「AI疾病発症予測」(LAiF の正式名称) も先方との契約語なので変えない。
  - **ウェルネス年齢は数直線で実年齢と比較する** (`HealthAgeCard.astro`)。目盛りは 30〜80 歳固定で、
    値が外に出る検体だけ 10 歳単位で**外側にだけ**広げる (狭めない = 回によって物差しが伸縮しない)。
    出すのは CABA の 2 値と差だけ。**判定のゾーン塗り分けはしない** (ミッション④)。
  - **検査結果は検査 5 種を 1 種 1 枚** (`TestResultsSection.astro`)。
    データ = `/result/{id}` / グラフ = `/trend?type=…`。**遺伝子検査はグラフを置かない**
    (判定のみで経時変化する測定値を持たない)。**推移は 2 回目の検査から** (1 回では線が引けない)。
    旧「直近の検査結果 (項目カード)」「検査値の推移」「検査履歴」はここに統合して廃止
    (`MetricCard` / `TestHistoryList` / `HealthCoachPreview` は**未参照のまま残置**。戻す判断のため削除しない)。
  - **「過去データ」はダッシュボードに置かない**。「データ」を押した先の結果ページ
    (`/result/[id]`) に置く (発注者指示)。同一種別の全回分を `ResultData.siblings` で引く。
  - **キット進捗は 1 件 = 全幅 1 行**。2 列にすると 1 列 ≒ 610px で発送日と伝票番号が入りきらず
    省略される (実測 1440px)。スマホは 1行目=アイコン/検査名/状態、2行目=バーと日付、3行目=操作 に折る。
  - **あいさつ帯は 1 行** (PC)。3 行積むと本題が下へ押し出されるため。スマホは 390px に入らないので 2 行。
  - **【自己申告ボタンの本来の置き場は `/kit` 2026-09-04・発注者指示「A」】**
    「受取確認 / 返送しました のボタンが実装されていない」という指摘の切り分け結果:
    **ボタンは実装済み**だった (`KitProgressCard.astro` + `api/kit/[id]/self-report.ts`)。
    見えなかった理由は **`KitProgressCard.astro` が `.slice(0, 2)` で先頭 2 件しか描かない**こと。
    デモでは 1 件目=出荷準備 (仕様上ボタン無し `kit_progress_ui_spec.md:72`) /
    2 件目=発送済 (受取ボタン) なので、**「返送しました」が出る 3 件目が構造的に届かなかった**。
    本番 (bridge) は `adaptShipment` が `lab_completed_at: null` 固定 (`bridge-queries.ts:91`) で
    完了済も 2 枠を食うため、さらに出にくい。
    → **全件が出る `/kit` にボタンを足した** (仕様のモック `kit_progress_management.md:83-86` が
    元々ステップ直下に置いている形)。ダッシュボードのサマリはそのまま (絞り込みは変えていない)。
    - **処理は `src/scripts/kit-self-report.ts` に集約**。2 画面から使うので二重管理しない。
      `define:vars` のインライン script をやめ、**ID は `data-diagnostic-user-id` 属性で渡す**
      (インラインだと import できず複製になるため)。多重 init は module 内フラグで防ぐ。
    - 表示条件は 2 画面で同一 (3 受取済 = 発送済かつ未受取 / 4 返送済 = 受取済かつ未返送)。
    - **仕様に対して未実装のまま残るもの**: `kit_progress_ui_spec.md` のゾーンA (年間予定表) /
      ゾーンC (AI問診の促し) / CTA のカード最上位化、受取希望日の変更 (§6)、通知 N1〜N7。
  - **推移グラフの「表示項目の設定」= 実装済 (2026-08)**。`/trend` の右上ボタン →
    `TrendItemsDialog.astro`。**候補はマスタでなく実データ由来** —
    `measurement-queries.getTrendCandidates()` が「この人の `measurement_values` に実在し、
    **日付違いの点が 2 つ以上ある**(線が引ける) `canonical_name`」だけを返す。
    モックの「20 項目 / 18 項目」というマスタは**こちらで作らない** (選定基準が未確定・
    捏造ゼロ)。完全マスタを受領したら候補の供給元を差し替える。
    - 既定は `DEFAULT_TREND_ITEMS` のうち実在するもの (従来の表示と同じ)、上限 8 件。
    - **サーバは候補を全部描き、クライアントが出し分ける** (リロードしない)。カードに
      `data-trend-item` を付け、選択に応じて `hidden` を切り替える。
    - **拡大モーダルには `data-trend-item` を付けない**。モーダルは既定で `hidden` なので、
      出し分け処理が拾うと全部開いてしまう。対象は `[data-trend-open][data-trend-item]` だけ。
    - **初期適用は DOM の準備を待つ**。このスクリプトはヘッダ内にありカードより先に走るので、
      待たずに当てると初期表示も保存済みの選択も効かない (実測 2026-08)。
    - 選択は **localStorage `welltect.trend.items.<検査種別>`**。表示の好みであって診断データ
      ではないので DB に入れない。PII も持たない。
    - **【テストフェーズの暫定措置 2026-08・発注者指示】系列のキーは
      `canonical_name`、無ければ `item_name`** (`measurement-queries.ts` の `seriesKey`)。
      標準マスタは健診標準フォーマット(KMAT) の starter なので、がんリスク検査の
      「尿中ポルフィリン量」「インデックス値」等は canonical_name が null になり、
      グラフの候補に一切乗らなかったため。**恒久策ではない** — item_name は run ごとに
      表記が揺れうるので同じ項目が別系列に割れる (canonical_name はそれを吸収するために在る)。
      完全マスタ受領で canonical_name が全項目に付いたら `seriesKey` を
      `r.canonical_name` だけに戻す。
    - 全部外したときは「表示する項目が選ばれていません」を出す (行き止まりにしない)。
  - **医師との面談に説明文を置いていない**のは、サービス内容 (相手・時間・料金・予約方法) を
    こちらで確認できていないため (ミッション④)。出しているのは「押すと ishachoku.com が開く」
    という、リンク先から確認できる事実だけ。**文面は Wellfort から受け取って載せる**。
  - **デモ層に 2 回目の検査を足した** (`demo-data.ts` の `demo-art-001x`)。テストフェーズで
    「グラフ」(推移は 2 回目から) と「過去データ」(切替先が要る) をクライアントに見せるため。
  - **【デモの人間ドック / 健康診断に読み取り結果を入れた 2026-09-05・発注者依頼】**
    デモの `health_checkup` は `SAMPLE_PDF_MAP` (`result-queries.ts:53`) に**エントリが無く**、
    `scan_md` も持たなかったので、`/result/demo-art-0004` は
    「スキャン処理中、または LLM 解析待ちです」だけの画面だった (5 種のうちここだけ空)。
    → `demo-data.ts` の `DEMO_SCAN_MD_LATEST` / `DEMO_SCAN_MD_PREV` を `scan_md` に入れた。
    - **`docs/scan/golden/` の md は使えない**。**実名と患者 ID が入っている**
      (`scan_golden_humandock_20250217.md` の見出し = 「… / ID 0000004089 / 相川 佳之 / 54歳男」)。
      **デモ用アカウントは記者・パートナーへ渡る**ので社外に出る。**golden をデモに転用しない。**
    - `src/data/elith/health_checkup_20260826.json` (合成検体) も**基準値を持たず**、
      単位の大小 (`mg/dL`/`mg/dl`) で 2 検査が混ざっているので、読み取り結果の表には起こせない。
    - → **合成して作った**。形式は**本番のスキャンが書くものと同じ** (`markdownClean` =
      `stripColumnFromTables` で推論値列を落とした 9 列。`camera-scan.ts:232`)。
      値は既存の `DEMO_REPORT` と**突き合わせてある** (尿酸 7.8 / 血圧 128・82 / 空腹時血糖 108)
      — ここが食い違うと AI 報告書が画面のどこにも無い値を語る。基準外も報告書が名指しする
      2 項目だけ。前回分は同じ項目で値だけ動かし、推移が読めるようにしてある。
    - **【グラフも出るようにした 2026-09-05・発注者依頼「デモなので何か入れて」】**
      `/trend?type=health_checkup` が**常に空**だった。原因は `getMeasurementTrend` /
      `getTrendCandidates` が **`testType` 付きのときデモへフォールバックしない**設計
      (「別種別のサンプルを『この検査の推移』として見せない」ため=理由は正しい)。
      → **ガードを緩めるのでなく `demoMetricTrend(testType)` を種別ごとに分けた**。
      `health_checkup` は専用の系列を返し、**知らない種別は `[]`** なので約束は同じまま。
      - **系列はデモの md から機械で起こす** (`parseDemoScanMd`)。数値を手で書き写すと
        「読み取り結果の表」と「グラフ」が食い違う (AI 報告書で踏んだのと同じ罠)。
        実測で一致を確認: 前回 2025-04-18 γ-GTP 48 / LDL 126 / 尿酸 7.2 / eGFR 68.2 →
        今回 2026-03-29 62 / 138 / 7.8 / 64.6 = グラフの「前回比 +14 / +12 / +0.6 / -3.6」。
      - **受診日は `HC_DAYS_PREV` / `HC_DAYS_LATEST` の 1 か所**。artifacts の `test_date` と
        グラフの点を同じ定数から出す。**ちょうど 365 日差にしない** — 1 年ちょうどだと
        軸のラベルが両方 `3/29` になり 2 点が同じ日に見える (実測)。
      - **既定の 6 項目 (`DEFAULT_TREND_ITEMS`) は全部値を動かす**。前回と同値だと
        横一直線 +「前回比 0」になり推移を見せるデモにならない (実測で 3 件がそうなった)。
        `γ-GTP` は md の「検査項目詳細」を `γ-GTP` にして既定項目名と揃えてある。
      - 実測: 候補 28 件 / 既定表示 6 件 (γ-GTP・LDL・空腹時血糖・HbA1c・eGFR・尿酸)。
    - ~~**血液・がんリスク・AI疾病予測のグラフは空のまま**~~ → **2026-09-05 に追加済み**
      (上記「実データの有無は条件ではない」参照)。**遺伝子だけは作らない**。
    - **【重要・同日に判明】この 2 件 (読み取り結果・グラフ) は入れただけでは画面に出なかった。**
      デモ用アカウントは真鍋の DB 行を借りる経路で止まり、`demo-data.ts` へ到達していなかった。
      **デモ層に何かを足したら、`demoFallbackEnabled` の内側で本当に到達するかを確かめる**
      (`/api/debug/viewer` の `using_demo_data` を見る)。
  - **`.md-region table` に `w-full` を当てない (2026-09-05)**。幅 100% で固定すると
    狭い端末で列が潰れ、**和文が 1 文字ずつ縦に折れる** (実測 390px で「検/査/項/目」)。
    和文はどこでも折れるので、列の多い表 (スキャンの読み取り結果 = 9 列) では必ずこうなる。
    → `w-max min-w-full` + セルに `whitespace-nowrap`、はみ出しは `.md-region` 側の
    `overflow-x: auto` に流す。**最終列だけは折り返す** (備考が長いと表が際限なく伸びるため)。
    実測 390px: 表 404px(潰れ) → **587px**(1 行 1 項目・カード内で横スクロール) /
    1280px では 1198px で全列が収まる。

- **ボタンの色 = 同格の淡色ペア (2026-08 発注者指示)**。「データ」と「グラフ」は同格で、
  どちらかを目立たせる意図は無い → **塗り(brand)と白の主従をやめ、色相だけで分ける**。
  定義は `global.css` の `.btn-pair` / `.btn-data` / `.btn-graph` / `.btn-pair-off`。
  - **brand 塗りは 1 画面 1 つ = AI疾病予防報告書のタイル**だけ (Welltect の売りなので
    他の検査セクションより優先する・発注者指示)。**大きさは検査カードと同寸のまま面の色で優先度を出す**。
    塗りが複数あると主役が消えてタイルが検査カードに埋もれる。
  - **AI スキャン / AI 問診 は同格の淡色ペア** (「データ」ボタンと同じ brand-50 面 + brand 枠)。
    AI スキャンの brand 塗りは外した。
  - **白ボタンの枠は navy-400 以上**。`slate-300` は白地に **1.72:1** で非文字コントラスト
    WCAG 1.4.11 (3:1) に届かない (中止ボタンで受けた指摘と同型)。
    実測: データ 文字 6.48:1 / 枠 4.70:1、グラフ 文字 12.10:1 / 枠 4.22:1、
    白文字 on brand-600 4.70:1、白ボタンの brand-700 文字 7.09:1。
  - **和文はどこでも折れる**ので `.btn-pair` に `white-space: nowrap` が要る。無いと 5 列に
    並べたとき「デー／タ」と割れる (実測 1440px)。

- **未サインイン画面は `src/components/SignInPanel.astro`** (2026-08)。以前はロゴと
  スピナーだけで、One Tap が自動で出るのを待つ作りだった。**One Tap は iOS Safari の ITP や
  Google 未サインインの環境では出ない**ため、その場合に文言もボタンも無い行き止まりになっていた。
  → 見出し+説明+**Google 公式ボタン**(`#gsi-button` に `renderButton`)+読み込み失敗時の
  再読み込み導線、の 4 状態を持たせた。**ロゴ+スピナーだけの実装に戻さないこと。**
  - 責務分界: 表示=`SignInPanel.astro` / 認証処理=`GoogleOneTap.astro`。両者は
    `#gsi-button` と `welltect:signin` イベント (`state: ready|unavailable`, `text`, `tone`) で繋ぐ。
  - 認証失敗は `alert()` をやめ、画面内の `#signin-status` (aria-live) に出す。
    パネルが無いページでは alert にフォールバックする。
  - 使用箇所は `dashboard` / `kit` / `notices`。gate の markup を各ページに複製しない。

- **ホーム画面追加の案内は `src/components/AddToHomeCard.astro`** (2026-08)。開くたびに
  モーダルで出し、閉じたらページ下部のカードとして残す (発注者指示)。中身は 1 つだけ持ち、
  モーダルの器と `#a2hs-slot` の間で要素を移動させる (markup を 2 つ置かない)。
  - **「出さない」判断は 3 つだけ**: ①`display-mode: standalone`/`navigator.standalone`
    (いまホーム画面から起動中) ②`appinstalled` (その場で閉じるだけ)
    ③localStorage `welltect.a2hs.dismissed` (**「このガイドを今後表示しない」を押したときだけ**)。
  - **`appinstalled` と ✕ で ③ を書かないこと**。以前は `appinstalled` で恒久フラグを
    書いていたが、**ホーム画面から削除しても localStorage は消えない**ため、一度追加した
    端末では二度と案内が出せなくなった (実機で発覚 2026-08)。実機の解除は `?a2hs=reset`。
  - **Android は `beforeinstallprompt` を待たない**。Chrome は「タップ 1 回以上 + 30 秒以上の
    滞在」を満たすまで発火しない (web.dev: Installability criteria) ので、発火前は
    ブラウザメニューからの手順を出し、発火したらボタンへ差し替える。
  - ホーム画面アイコンは `scripts/build-pwa-icons.mjs` で生成。**ロゴは無加工**で、
    地の色は **白 `#FFFFFF`**。「薄い」の指摘を受けて一度 Executive Navy `#102B3A` にしたが
    (コントラストはロゴ色 rgb(71,191,200) に対し 2.20:1 → 6.69:1)、**実機ではかえって
    視認性が落ちたため白へ差し戻した (発注者判断 2026-08)**。数値上のコントラストと、
    壁紙や並んだ他アイコンの中での見え方は別物、という実例。地の色は引数で変えられる
    (`node scripts/build-pwa-icons.mjs "#102B3A"`)。
  - **絵柄はロゴの「マーク」部分だけ**を使う (2026-08・視認性の指摘を受けて)。原本の実測で
    マーク(円+W)=100x78px / ワードマーク"welltect"=198x35px、線幅は マーク 4-6px / 文字 3-4px。
    **ロゴ全体を 60px のアイコンに収めると縮小率 0.246 倍 = 線幅が 1px を切って潰れる**
    (実測: マーク 0.98px / 文字 0.86px)。マークだけなら同じ 60px で縮小率 0.444 倍 =
    **線幅 1.8px** が残る。ホーム画面ではアイコンの下に「Welltect」の名前が別途出るので、
    絵柄に文字は要らない。**切り出すだけで色も形も変えない** (再描画・トレースはしない)。
    - マークの切り出しは実行時に自動判定 (インクのある行の帯が 2 本なら上を採る)。
      構成の違う画像に差し替わったら判定を諦めて全体を使う = 壊さない。
    - 大きさ: 通常アイコン ratio 0.74 / maskable 0.60 (マークの対角 = 幅×1.268 ≦ 0.8 →
      幅 ≦ 0.63。実測 対角 0.760)。ロゴ全体に戻すなら
      `node scripts/build-pwa-icons.mjs "#FFFFFF" full`。
    - **タブの favicon も同じマークを使う** (発注者指示 2026-08「ファビコンも小さいので
      文字を削除してマークだけに」)。`public/favicon-mark.png` (64px・**背景は透過**) を
      同じスクリプトが生成し、`BaseLayout.astro` の `rel="icon"` が指す。
      **ロゴ全体 (`full`) を指定したときも favicon はマークだけ**にする — 16px では
      ワードマークの線幅が 1px を切って潰れ、何のアイコンか分からなくなるため
      (実測: 旧=かすれた染み / 新=円+W が判別できる)。透過にするのは、白で塗ると
      ダークテーマのタブに白い四角が出るから。
    - **ヘッダのロゴは高さ 66px** (`AppNav.astro`)。「小さい」の指摘で 44px から 50% 拡大
      (発注者指示 2026-08)。実測 89x66px・ナビ高 83px でメニュー/お知らせと干渉しない。
    - **アイコンを作り直したら URL の `?v=` を必ず上げる** (manifest の icons と
      `apple-touch-icon`、`favicon-mark.png`。両リポジトリ)。**Chrome は manifest の `icons` が同じなら
      アイコン URL を immutable 扱いして再ダウンロードしない**ので、中身だけ差し替えても
      インストール済みのホーム画面アイコンは永久に古いままになる (実機で発覚 2026-08)。
      URL を変えると WebAPK の更新がキューされる。ただし反映は即時ではない
      (Chrome の確認は約 1 日毎・アプリの全ウィンドウを閉じ、充電中かつ Wi-Fi 接続時に適用)
      ので、確認作業では**削除して追加し直す**のが確実。
      出典: web.dev/articles/manifest-updates。

- **AI問診の選択肢 UI = リスト方式 (2026-08 デザインチーム案・発注者承認)。ホイールは廃止**。
  実装 `src/scripts/chat/choice-picker.ts` (`openListPicker`)。旧 `wheel-picker.ts` は削除。
  - **選択式は chip / multi / list の 3 種とも同じ選択画面を使う** (2026-08 追加)。
    以前は chip だけインラインのカード、multi だけ別のボトムシートで、デザイン案と揃っていなかった。
    旧 `#ui-chip` / `#ui-multi` / `#multi-modal` と `renderChips` / `renderMulti` は削除済み。
    `answer_kind` は「単一か複数か・選択肢の置き場所」を表すデータとして残す
    (`mapKind` が 3 つとも `list` widget へ寄せる)。
  - **件数で 3 段階に自動切替** (呼び出し側は指定しない): 〜7件=ボトムシート / 8〜12件=全画面リスト /
    13件〜=全画面+検索+分類見出し。**さらに、ボトムシートに入りきらなければ全画面へ昇格する**
    (`promoteIfNeeded`)。ラベルが 2 行になる設問は小さい端末で収まらないため
    (実測: D-FREQ 7件は 393x852 ではシート、375x667 と 360x640 では全画面)。
    昇格を `data-layout` の差し替えだけで行えるよう、**ヘッダはシート用と全画面用の両方を描いて
    CSS で出し分ける**。
  - **「はみ出し」の判定には 12px の許容値を置く** (`OVERFLOW_TOLERANCE`)。リスト下端の padding だけで
    2〜8px 溢れるため、許容値が無いと**全部見えているのに全画面へ昇格し、見切れも付く**
    (実測: 360x640 で 2px 差)。
  - **廃止理由 (実測)**: CSS に `perspective` が無く `rotateX` がただの縦潰しだった (ホイールに見えない)。
    さらに中央のハイライト帯が `98cf87b` で不透明 `#DCECEF` になり、**選択中の項目を塗りつぶして隠していた**
    (「デフォルト位置が空欄」の正体)。中央の項目が選択済みでもなく、何もタップせず決定を押すと空配列が返り
    **何も起きずに閉じる**行き止まりもあった。
  - **スクロールが「ある」と分かるための 3 点セット**: ①見切れ (最下部の行を 45% だけ見せる) ②分類見出しの
    sticky ③「↓ あと N 件」。**スクロールバーの見た目強化は採らない** (モバイルのバーは触っている間しか
    出ず、常時表示にすると細くて掴めない飾りになる = ①②③ の代わりにならない)。
  - **①の計算は行ピッチから逆算しない**。分類見出しが挟まると行間が一定でなくなり狂う (実測 0.89=ほぼ
    切れない)。**下端をまたぐ行を実際に見つけ、その行が 45% 見える高さに合わせる**。
    さらに **1 フレーム目はレイアウトが確定しておらず外す**ので、2 フレーム待ってもう一度当てる。
  - **`.lp-scroll` の `position: relative` は必須**。無いと `.lp-item` の offsetParent が `.lp-panel`(fixed) に
    なり offsetTop にヘッダ高が乗って ①③ が壊れる (実測: 7 件なのに「あと2件」)。
    **`padding-top` を置かない**こと (sticky の吸着位置が padding 辺なので隙間から中身が見える)。
  - **フッター被りは構造で防ぐ**: パネル= flex column / リスト= `flex:1` + `min-height:0` + `overflow-y:auto` /
    フッター= `flex-shrink:0`。padding で逃がさない。block レイアウトに戻すと最後の 1〜2 件が選べなくなる。
  - **「なし」は排他** (`ChoiceOpt.exclusive`)。選ぶと他が全解除、他を選ぶと「なし」が外れる。
    以前は排他処理が無く「なし」と「高血圧」を同時に選べた。補足は `note` に出す
    (アイコンは付けない。`icon-svg` の `'none'` は実体が circle-check で、未選択なのに選択済みに見える)。
  - **単一選択はタップで即確定** (決定ボタンを挟まない)。複数選択のみ「この内容で回答」。
    設問表示から 150ms で自動展開するので、インラインのカードだった頃と**タップ数は変わらない**。
  - **1 つでもアイコンを持つ選択肢があれば全行にアイコン枠を確保する**。一部だけアイコンがあると
    その行だけラベルの頭が右へずれる (実測: 睡眠時間 5 件のうち 2 件だけアイコン)。
  - **既往歴 27 件の label は上流との契約**。`questionnaire_to_lab_csv_spec.md §4` の「既往・現病歴」経由で
    4 社の上りフォームへ流れる (リージャー 行25 / LAiF 行4 / プリベント 行13-23 / Genoplan 行5-34)。
    **文字列を変えると CSV 生成が壊れる**。「高脂血症→脂質異常症」「脳卒中と脳梗塞/脳出血の重複」
    「肺気腫と COPD の重複」は既知の論点だが、**各社フォームの実物で写像を確認するまで手を付けない**。
    `group`/`kana` は表示と検索専用に足したもので、label は 1 文字も変えていない。
- **進捗の数字は「問診完了まであと N%」** (2026-08 発注者指示)。**N は残り**なので
  `100 - currentPercent()`。バーの塗り (= 済み) と数字 (= 残り) で役割が分かれる。
  100% 到達時は「あと 0%」が不自然なので「問診完了」に切り替える。実装は
  `live-controller.ts` の `renderProgress()`。文言はここが正で、markup 側は初期値だけ持つ。
  - 併せて色を `slate-500` → `brand-700` に変更。**旧色はヘッダ地 (mist #DCECEF) に対し
    4.08:1 で AA 未達だった** (新 5.84:1)。

- **選択画面は問診ヘッダを覆わない (2026-08 発注者判断・最終形)**。全画面の選択画面が
  `inset: 0` で画面トップの進捗バーごと隠していたのが発端。**これは仕様上の制約ではなく
  こちらのレイアウトの選択**なので、ヘッダの下から開いて実物の進捗バーを見せる。
  - `<header id="chat-header">` を `sticky top-0 z-30` にし、`choice-picker.ts` の
    `applyTopAnchor()` がその下端を実測して CSS 変数 `--lp-top` に入れる。
    全画面パネルは `top: var(--lp-top)`、**スクリムにも同じ offset** を掛けるので
    ヘッダは暗くもならない。アンカーが無いページでは 0 = 従来どおり全面。
  - **モーダル側に進捗バーを複製する案は撤回**。回答選択肢の上にもう 1 本進捗が出て
    紛らわしい、という指摘 (発注者 2026-08)。`PickerProgress` / `progressHtml` は削除済み。
  - **半透明にして裏を透かす案も不採用**。①10% 透過では裏の進捗バーは 90% 隠れたままで
    問題が解決しない ②会話ログの文字が選択肢の文字に重なって読みにくくなる
    ③白地前提で数値検証した WCAG AA が成立しなくなる ④禁止事項の
    グラスモーフィズムに寄る。
  - 実測 (393x852): ヘッダ下端 108px = パネル上端 = スクリム上端。5 モーダル
    (シート/全画面/検索/中止/マトリクス) すべてで、**ヘッダ領域の画素がモーダル無しの
    状態と完全一致** (= 一切覆われず暗くもなっていない)。600px スクロール後も同じ。

- **AI問診の「中止」= 3 択 (2026-08 発注者指示)**。旧「中断」から改称。実装は
  `live-controller.ts` の `confirmAbort()` と `choice-picker.ts` の `openActionSheet()`。
  - 選択肢は **①回答済の問診を記憶して中止する ②回答を全てクリアして中止する ③問診に戻る**。
    **背景タップ・Esc は ③ 扱い** (誤操作で回答を失わせない)。
  - **選択画面を開いている間も中止できる**。選択画面は画面を覆って右上の中止ボタンを隠すので、
    `openListPicker({ onAbort })` でヘッダ右端にも中止ボタンを出す (シート/全画面の両方)。
    ③ を選ぶと選択画面を開き直す。
  - **途中経過は DB に入れない**。localStorage の `scan-chat-ai:progress:<id>`
    (`session-store.ts` の `InterviewProgress`) に「設問 id → 回答値 / seeded / currentId」
    だけを持つ。**PII は入れない**。
  - **1 問答えるごとに保存する** (`persistProgress()`)。中止ボタンを押さずにタブを閉じる・
    リロード・通信断で離脱しても続きから戻れるようにするため。完走したら削除する
    (次回は最初から。結果は `InterviewResult` 側に残る)。
  - **再開は `InterviewEngine.resume()`**。`currentId` が定義から消えていたら
    **未回答の最初の設問**へ寄せる (設問を入れ替えても行き止まりにしない)。実測で
    3 問回答 → 中止 → 別インスタンスで `H-SYMPTOMS` から再開・回答 3 件復元を確認。
  - **`setConnected()` で mic ボタンの textContent を書き換えないこと**。以前は
    `'⏸'` を代入していたため、markup 側の Lucide アイコンが消えて絵文字に戻っていた。
    ラベルとアイコンは `chat.astro` の markup が正で、JS は `active` クラスと aria-label だけ触る。
  - **アクションシートの色は `.as-item.as-primary` のように 2 クラスで書く**。`.lp-item` と同じ
    1 クラス同士だと Tailwind の生成順で負けて背景が白のままになる (実測 2026-08)。
  - **中止ボタンの枠は `slate-500`**。`slate-300` は白地に 1.72:1 で WCAG 1.4.11 (3:1) に届かない。

- **AI問診の自由入力は改行キーで確定する** (2026-08)。身長・体重のような 1 行入力で「送信」まで
  指を運ばせないため、`#text-input` は **Enter=確定 / Shift+Enter=改行** (従来は Cmd/Ctrl+Enter のみ)。
  IME 変換確定の Enter は `isComposing` / `keyCode 229` で除外する
  (これが無いと変換確定でそのまま送信されてしまう)。`#fallback-input` にも同じガードを入れた。
  - `numeric` の設問は `inputmode="decimal"` / `rows=1` / `enterkeyhint="done"`。
  - **text 設問は表示と同時に入力欄へフォーカスする** (発注者指示 2026-08。身長・体重で
    入力欄をタップする一手間を無くす)。`showWidget` で `hidden` を外した直後はフォーカスが
    乗らないので `requestAnimationFrame` を 1 回待つ。会話ログが飛ばないよう
    `focus({ preventScroll: true })`。**iOS はユーザー操作を伴わない focus でキーボードが
    出ないことがある**ため、実機で要確認 (未確認の仮説)。
  - **iOS の数字キーパッドには改行キーが無い**ため、その環境では「送信」ボタンが確定手段になる。
    だから送信ボタンは残す。**実機で要確認 (未確認の仮説)**。

- **表示の原則 (ミッション④)**: 各診断結果を整理して伝える。**独自に分析・解釈しない**。
  - 判定レベルを値と基準値から算出しない。助言文・受診勧告文を生成しない。
  - 表示してよいのは 検査票の値・単位・基準値 と、**検査機関が付けた** `flag` / `assessment`。
    `flag` が null は「印が無い」であって「基準値内」ではない → **判定を表示しない**。
- **【誰にダミーを出すか 2026-08-30 確定・発注者指示】正本 `docs/operations/デモ用アカウント_仕様書.md`。**
  **アプリ全体にかかる仕組み**なので特定機能の仕様書には書かない (報告書 spec §4.6 はここを指すだけ)。
  - **デモ用アカウントと管理者アカウントは別物。混ぜない。**
    デモの目的は **UI デザイン確認 / 機能確認 / ビジネスパートナーへのお披露目・PR** で、
    **PR 用のアカウントは社外に渡る**ため管理者と同じ枠に置けない。
  - **判定 = `demo-accounts.ts` の `isDemoAccount(uid)`。uid が一覧にあるか、それだけ。**
    `demoFallbackEnabled(uid)` は**引数 uid 1 つ**でこれに委譲する。
    ①env `PUBLIC_DEMO_FALLBACK=false` で全停止 → ②uid が一覧にあれば出す。**admin は見ない。**
  - **【実データの有無は条件ではない 2026-09-05 修正・仕様書 §2/§3】デモ用アカウントには
    DB を見ずにダミーを出す。** 仕様書 §2 の表で「デモ用アカウント … ダミー=出す / 実データ=**—**」。
    - **実障害**: `dashboard-queries` が ①真鍋(`d0000001`)の DB 行を借りる → ②組込みダミー の
      2 段フォールバックで、**`d0000001` に 13 行あるので①で必ず止まり②へ来なかった**
      (本番実測 `/api/debug/viewer` = `using_demo_data:false`)。借り物は歯抜け
      (`scan_md` 無し・測定値が 1 日ぶん) なので**読み取り結果もグラフも空**。
      `demo-data.ts` にいくら材料を足しても画面に出ない状態だった。
      根は **`demo-data.ts` 冒頭の「実データが空のときだけダミーへ」** という
      仕様書 (2026-08-30) より前の記述に実装が沿っていたこと。
    - **直した入口 5 か所**: `loadDashboard` / `getMetricTrend` / `getMeasurementTrend`・
      `getTrendCandidates`・`getMeasurementLatest` / `loadNotices`・`countUnreadImportant`
      (**Supabase 未設定でもダミーを出す**= ダッシュボードにあった救済がここだけ無かった) /
      `getResultData` (`demo-art-*` は従来どおり)。
    - **`/report` は別扱いのまま**。「現行形式の実データが入れば本物が勝つ」という既存の決定
      (spec §4.5.1) があり、旧形式 seed 行を飛ばす形で解決済み。一律ダミー優先にすると衝突する。
    - **`verify:demo-gate` が「デモの判定に件数が AND されていないこと」を見る**。条件は
      **括弧を数えて**取り出す — `[^)]*` だと `(importantRaw?.length ?? 0) === 0` の入れ子で
      切れ**退行を注入しても通る** (一度そうなった)。退行 2 種を注入して落ちることを確認済み。
    - デモの推移グラフは **血液 / がんリスク / AI疾病予測**も追加 (2 点・`demoArtifacts` の
      `test_date` と同じ日付)。**遺伝子は作らない** (判定のみ=経時変化する測定値が無い)。
      実測: health_checkup 15 系列 / blood 7 / cancer_urine 2 / ai_prediction 3 / genetics 0。
  - **admin であることは資格にならない**。管理者を増やしてもダミーの閲覧者は増えない。
    admin がダミーを見たいなら**その人を登録する**(唯一の道)。
  - **【登録は Google アカウント (メール)・判定は uid】発注者指摘 2026-08-30**:
    「**diagnostic_user_id をキーにしてたら、管理できないだろ！** マスコミ対応で、記者にデモ画面を
    見てもらう場合、どうするの？」→ **uid を人が入力する設計が誤り**。記者やパートナーに
    「サインインしてデバッグ欄の UUID を送ってください」とは言えない (人は自分の uid を知らない)。
    - **登録**(人が年数回) = メールアドレス / **判定**(全リクエスト) = uid。**判定にメールを持ち込まない** —
      ハッシュ計算が async なので「同期関数のまま」が崩れ ~30 箇所が await になり、DB 依存も増える。
    - 橋渡し = `linkDemoEmail()` を **`api/auth/resolve.ts` で 1 回だけ**。サーバ検証済み email と
      解決済み uid が同時にあるのはここだけ。**クライアント申告の email で登録できてはいけない**
      (誰でもデモを有効化できてしまう)。突き合わせ成立で uid を `demo.account_uids` へ写す。
    - **メールの現物は保存しない**。`demo.account_emails` に **sha256 / マスク(`r***@example.com`) /
      uid / メモ** の 4 つだけ (1 行 = `<sha256> <マスク> <uid|-> # メモ`)。現物が通るのは
      wellfort-site の中継→Scan-Chat-AI の受け口までで、**中継でもログに出さない**。
    - **`demo.account_emails` は供給元でなく「予約」**。サインインするまで判定に効かない
      (画面では「サインイン待ち」と出す。**これを異常に見せない**)。
    - **メール登録由来の uid は uid 側から外せない** (外しても次のサインインで復活＝黙って効かない操作)。
      **逆にメール行を外すときは uid も一緒に外す** (メールだけ外すと本人にデモが出続ける)。
    - **サインイン済みかは記録した uid で判定**。ラベル一致で推測しない (ラベルは admin が
      書き換えられるので黙って誤判定する。実装時に一度そうなっていた)。
  - **責務分界**: `demo-accounts.ts`=**誰に見せるか** / `demo-data.ts`=**何を見せるか**。
    混ぜていたために「admin なら見せる」という権限の話がデータ層に紛れ込んだ (2026-08-30)。
  - **一覧は 3 供給元の「和」**: `BUILTIN_DEMO_UIDS`(コード・消えない下限・現 4 件) ∪ env `DEMO_ALLOWED_UIDS`
    ∪ **app_config `demo.account_uids`(admin から即時・再デプロイ不要)**。**組み込みを名簿として育てない**。
    各ページは `refreshConfig()` を**データ取得より前**に呼ぶ。
  - **【引き算が 1 段ある = 除外リスト】発注者指示 2026-08-30「削除のできるようにして」**:
    `出す uid = (組み込み ∪ env ∪ app_config) − app_config demo.account_denied_uids`。
    組み込み/env は供給元を画面から書き換えられない(コード/Vercel env)ので、**消すのでなく引き算で止める**
    → **どの行でも画面から外せる / 「戻す」で元に戻る**(供給元は残っている)。
    **引き算は和のあと**(逆にすると除外した uid を config 側で足し直せてしまう)。
    §4「足せるが消せない方が事故が軽い」は供給元どうしが上書きし合わない意味であって、
    **operator が意図して外すことを禁じるものではない**(除外は画面に「除外中」と出る=黙って消えない)。
  - **【初期値は管理者リストから 1 度だけ】発注者指示 2026-08-30**: 一覧が空だと「誰も見られない」ので、
    admin 画面の初回表示で `admin_users`(is_active) のメンバーをメールとして自動登録し、
    目印 `demo.seeded_from_admins` を立てる。手動の「管理者リストから登録」ボタンもある。
    **2 回目以降は自動で走らせない** — 走らせると**外した人が次のアクセスで黙って戻り「外す」が効かなくなる**
    (「一覧が空なら」を条件にしないのも同じ理由)。登録後は普通の行=**1 件ずつ外せる**・メモは
    固定文言(**氏名を入れない**=PII)。**admin であることが資格になる訳ではない** — 名簿を一度写して
    初期値にする操作であって継続同期ではない(以後 admin を増やしても閲覧者は増えない)。
    名簿を引くのは wellfort-site 側。**Scan-Chat-AI に名簿を渡さない**(渡すのはメール→即ハッシュ)。
  - **増減は admin の専用メニュー** = wellfort-site `/admin/demo-accounts` (サイドバー「設定」)。
    **管理者管理 (`/admin/users`) とは別メニュー** (同じ枠に置くと「デモを見せる」と
    「管理権限を渡す」が区別できなくなる)。UI=wellfort-site / 処理=Scan-Chat-AI
    `/api/admin/demo-accounts` (Bearer `ADMIN_API_KEY`)。組み込み/env は画面から外せない。
    **上段=Google アカウントで登録 (人が使う入口) / 下段=uid を直接 (`<details>` で畳む)**。
  - **【案内する URL】`https://scan-chat-ai.vercel.app/`** (→ `/dashboard` へ転送)。**マイページ経由不要**。
    マイページのリンクは `?u=<uid>` を付けるが **`?u=` は admin 専用**なので**デモ用には付けない**
    (素の URL でよい。サインイン後は HttpOnly Cookie で本人が決まる)。将来 `app.wellfort.co.jp`。
  - **【EC の顧客でない人を通す 2026-08-31】記者・パートナーは顧客ではない**ので
    `resolve-customer` で引けず、`api/auth/resolve.ts` の未連携 early return に落ちて
    **「お客様情報が見つかりませんでした」で入口で弾かれる**(デモ登録が無意味になる)。
    → `resolveDemoUidByEmail` で**デモ登録済みの人にだけ**デモ専用 uid を与えて通す。
    **early return より前に置く**(後ろだと到達しない=検査で固定)。**登録の無い人は素通り**・
    **1 度決めた uid は変えない**(毎回変わると `app_users` に行が増え履歴も繋がらない)・
    **顧客レコードは作らない**(診断側の識別子だけ=PII は生まれない)。
  - **代理表示 (`?u=`) は「表示中の uid」で判定**。相手が登録済みなら出る / 一般顧客なら相手の実データ。
    `?u=` は admin 限定 (`viewer.ts:229`) なので**社外に渡すデモ用アカウントは他人を覗けない**。
    実測: 本人(登録済) `rp-h3`=45 / `?u=`登録済 45 / `?u=`未登録 **3**(emptyVM)。
  - **検証 `npm run verify:demo-gate`** (14 ケース + メール登録/除外リスト/記者の導線の実挙動 32 件)。
    **デモの経路に admin が現れたら落とす**・引数が uid 1 つであること・`?u=` が admin 限定であること
    も見る。**ここは静かに壊れる**。メール登録だけは**テキスト検査でなく実際に動かす**
    (`demo-accounts.ts` を transpile し app_config を差し替え = DB 不要)。とくに
    **保存物のどこにも現物のアドレスが出ないこと**を固定 (目視では抜けるし、抜けても画面は正常に見える)。
    退行を注入して落ちることも確認済み (`hashEmail` が現物を返すよう壊すと 12 件・
    除外を和の前に動かすと 4 件・記者の導線を early return の後ろへ動かすと 1 件 落ちる)。
  - **admin 判定は完全に別件** (用途=管理画面 2 枚)。正は Wellfort 側 `admin_users`、経路は
    HP Edge `resolve-customer` の top-level `is_admin`。**このリポジトリに管理者名簿を持たない**。
    **未解決**: 本番で `edge.is_admin:false` (原因未特定)。**デモに影響しないのでブロッカーではない**。
  - **切り分け** = `GET /api/debug/viewer?k=<PROBE_UPLOAD_TOKEN>`。**`?u=` が付いていないか必ず確認する**。
  - **経緯 (ボツ・根拠にしない)**: `docs/旧版・ボツ/2026-08-30_admin判定とデモゲートの試行錯誤.md`。

### PII / データ分離
- `customer` スキーマ(PII) と `diagnosis` スキーマ(非PII) を **`diagnostic_user_id` のみで橋渡し**。
  氏名・住所・生年月日を診断系/外部/S3 に載せない (`docs/architecture/data_integration_requirements.md` §1.3,
  `docs/lab/lab_integration_workflow.md` §1.1)。氏名OCRのみでの顧客割当確定は禁止。

#### DB 権限まわりの既知の宿題 (総合テスト時に必ず潰す・2026-08-20)
Supabase database linter の指摘を棚卸しした結果。**テストフェーズの前提 (admin なら誰でも同じ
データが見える) を維持するため、今は直さない**。本番相当へ切り替える段で以下を必ず処理する。
- **[最重要] `customer` スキーマの PII が anon キーで読める**。
  `20260601000020_rls_policies.sql:45` の `grant select on all tables in schema customer to anon`
  ＋ 同 `:63` の `dev_read_all` (`for select using (true)`) の組み合わせ。anon キーは
  `GoogleOneTap.astro:35,53` でブラウザに出るため、**公開鍵だけで `customer_profiles` の
  氏名/住所/生年月日/メール/電話が引ける**。上の「PII は診断系/外部に載せない」方針と正面衝突する。
  → 本番では customer 系の read を `auth.uid()` 紐付け (または service_role 限定) に絞る。
  ※ linter の `rls_policy_always_true` は SELECT を対象外にしているので**この件は警告に出ない**。
- **`dev_authn_write` (`for all to authenticated using(true) with check(true)`) が全 15 テーブル**。
  `20260601000020_rls_policies.sql:67` のループ生成 + 後続マイグレーションの個別コピー。
  authenticated JWT を取れれば全テーブルに書ける。元コード `:51` にも
  「本番移行時に customer 系は service_role 以外の write を禁止する」と書いてある。
- **`function_search_path_mutable` は解消済** (`20260820000050_function_search_path.sql`)。
  3 つとも `new.updated_at = now()` だけで名前解決をしないため `search_path=''` 固定で挙動不変。
  ローカル PG16 で 3 トリガーが発火し続けることを確認済み。
- **Leaked Password Protection (Auth)** はコードでなく Supabase Dashboard の設定
  (Authentication → Providers → Password)。本アプリの認証は `signInWithIdToken` (Google) のみ
  (`GoogleOneTap.astro:56`) なので、**そもそもメール/パスワード サインアップを無効化するのが本筋**。
  ホスト側で有効かは未確認 (`supabase/config.toml:45,48` はローカル用の設定であり本番を表さない)。

## 主要ドキュメント索引

| ドキュメント | 内容 |
|---|---|
| `docs/interview/AI問診_仕様と設計原則.md` | **AI問診の確定仕様・設計原則（責務分界/禁止事項/二重話者問題/修正方針）。コード変更前必読** |
| `docs/operations/Gemini_APIキー作成手順書_Wellfort_v1.0.md` | Gemini キー発行・**Vercel 環境変数運用**・ローテーション |
| `docs/architecture/system_architecture_overview.md` | 全体構成・**Vercel/タイムアウト**・データフロー |
| `docs/elith/elith_s3_data_handoff_spec.md` | **Elith S3 受け渡し仕様** (パス/命名/format_id/JSON) |
| `docs/elith/elith_batch_centralization_design.md` | Elith バッチ**一元化設計**(キーは Vercel・役割分担・admin バッチ) |
| `docs/elith/elith_assembly_wrapping_spec.md` | **納品セット アセンブリのラップ仕様(Elith向け説明)**。フォルダ/命名/ウェルネス年齢の時系列化(検査日毎・旧1件を撤回)・疑似データも同様に時系列生成・**LAiF AI疾病発症予測(Other/ai_prediction)のファイル仕様=Elith承諾により確定(§5・2026-08)。合成は data.items[] の発症率%/相対リスク比のみジッタ・昨年比は前年の相対リスク比を引継ぎ(実装済)**・manifest不一致の確認事項 |
| **`docs/operations/デモ用アカウント_仕様書.md`** | **デモ用アカウントの正本 (アプリ全体)**。目的 / 誰が見るか / 判定の順序と理由 / 3 供給元の和 / 増やし方 / 実装上の約束 / 検証 / 切り分け。**権限 (admin) の仕組みに乗せない**のが設計の要 |
| **`docs/elith/AI疾病予防報告書_引継ぎ書.md`** | **【この機能に着手する人が最初に読む】** 新規セッション用の入口。読む順番 / 越えてはならない線 / コードの地図 / 検証コマンド / いま動いているものと残っているもの / 詰まったときの切り分け。**仕様は書かない** (仕様の正は下の仕様書) |
| **`docs/elith/AI疾病予防報告書_仕様書.md`** | **【この機能の唯一の入口。最初にこれを読む】** 紙面の正はモック 2 タイプで、仕様書は紙面を散文で書かない (2 回の作り直しの直接の対策)。目的 / 正の所在 / 素材 (sha256 つき) / デザイン見本 §4.3 / 変更手順 / 検証 / **決裁台帳 §6** |
| `docs/旧版・ボツ/` | **食い違う旧版の置き場。参照しない。** 実装の根拠にしない。決裁台帳の引用元としてのみ生きている |
| `docs/旧版・ボツ/ai_prevention_report_HANDOVER.md` | **【旧版】引き継ぎ書**。ミッションの3層/**設計ポリシー=サービスの2本柱**/越えてはならない線/参照すべきドキュメントの順序/素材/回答待ち。**1 回目の実装はリバート済み・2 回目 (パイロット版 v0.1) が実装済み** (spec §9.2/§9.3) |
| `docs/旧版・ボツ/ai_prevention_report_REVERT_LIST.md` | **リバート対象コミットの一覧**。Scan-Chat-AI 11 件 (うち 10 件は本番反映済み) / wellfort-site 2 件 / 併せて外すもの (CLAUDE.md の【実装】記述・`checkup_values` マイグレーション) |
| `docs/elith/mock/ai_prevention_report_type2.html` | **紙面モック (タイプ2)。飾りではなく契約の入力**。`npm run verify:sheet-contract` がここから紙面契約を抽出し実装と突き合わせる (spec §1.3.10)。冒頭コメントに annotation の意味とモック補正の記録 |
| `docs/旧版・ボツ/ai_prevention_report_generation_spec.md` | **AI疾病予防報告書 生成機能の仕様 (パイプライン⑥・2026-08-28)**。受領 JSON 3 点 → アプリが可読な報告書を生成。入力仕様/出力は HTML+印刷CSS(PDF生成しない)/章立て/決定論の変換規則/**作れないもの①〜④と捏造ゼロの境界**/受領データの既知不具合/実装計画/Elith 確認事項 |
| `docs/elith/batch_scan_to_elith_usage.md` | サンプル一括スキャン→S3 バッチ手順 (`scripts/batch-scan-to-elith.mjs`) |
| `docs/lab/lab_data_pipeline_master_spec.md` | **検査データ・パイプライン 総合仕様書(E2E正本・上位文書)**。EC購入→キット/タイミング→発送指示/進捗→AI問診/検体返送→各社受渡→受領チェック(週次)→Elithラップ/S3書出→AI診断PDF受取/表示 を6ステップで連結。詳細は(a)(b)(c)へ委譲(二重管理しない) |
| `docs/lab/lab_data_reception_overview.md` | **4検査のデータ受取 詳細**(血液=リージャー/RPA・がん=プリベント/専用ポータル+S3を提案中・AI疾病予測=LAiF/S3 URL・遺伝子=Genoplan/RPA。方式/経路/現状/課題/次アクション)。E2E全体像は上記 master_spec が上位 |
| `docs/lab/questionnaire_to_lab_csv_spec.md` | **AI問診回答→各社CSV 変換仕様(実装用)**。共通設問No→各社必要行のマスターマッピング表+各社項目リスト+生成ルール(フリー/選択/範囲/複数)+PII確認事項。元=Wellfort問診項目マトリクスExcel |
| `docs/lab/demecal_auto_download_overview_spec.md` | 血液検査データ自動DL (デメカル/mTLS) 概要 |
| **`docs/lab/demecal_unattended_spec.md`** | **【無人定期取得の正本 2026-08-31】** 発注者判断「最初から無人」。無人にしてよい根拠(`last_to` 単調前進=走らない日があっても取り漏れゼロ)/取り込み専用キー `LAB_INTAKE_API_KEY`(**未実装・ADMIN_API_KEY を PC に置かないため必須**)/実行ログAPI/秘密の保管(DPAPI)/タスク設定/監視(GitHub Actions を見張りにして通知基盤を作らない)/失敗時の挙動表/未確定と実装TODO |
| `docs/subscription/subscription_management_feature_requirements.md` | サブスク契約管理 拡張 機能要件 (要件1〜4・データモデル・付録Bマトリクス) |
| `docs/subscription/subscription_management_implementation_guide.md` | 上記の実装手順書 |
| **`docs/subscription/検査キット_データモデル_仕様書.md`** | **【サブスク→検査キット→進捗 の背骨。ここに触る前に最初に読む】** **実装方針は確定 (2026-09-10)= 目標モデル(正規化＋版管理)を実装。上位正本 §6.1/§8-5 の「確定＝案A」がそれ。旧 A/A′/B は対症案 S1/S2/S3 へ格下げ・不採用**。**名前の衝突に注意: 上位正本の「案A」= 本書の旧「案C」で、本書の旧「案A」は別物**(表示だけ)。**実装は staging 限定・Production は NO-TOUCH・外部連携は sandbox/disabled/staging のみ・本番のタカセ/検査会社/メールへの実送信は禁止** (§10.1)。現在地(実測)と目標モデルの差の正本。**最新仕様の 7 テーブルは本番・staging とも実在 0 件**／**`app_bridge.kit_shipment` はキットでなく `orders` のミラー(1注文=1行・回の列なし)**／**同名別物が 2 つあり別 DB に在る**(`kit_shipment` 単数=使用中 / `kit_shipments` 複数=未使用)／`create-order` が決済前に `pending` で INSERT する仕様違反／`/kit` の 10 件表示の因果／埋め方 3 案 |
| `docs/subscription/kit_lifecycle_and_handoff_management_spec.md` | **検査キット 出荷・進捗・データ受渡 統合管理仕様(サブスク駆動)**。プラン×キット×発送タイミング/タカセ定期出荷/ライフサイクル状態機械+AI問診促し/進捗駆動の各社受渡・Elith作成指示。**§4.1.1=LAiF上りCSV(AI疾病発症予測 入力フォーム 約158項目)の写像仕様＋生成フロー**(健診スキャン+AI問診+基本情報を集約=スキャンフローに足さない別export・整理番号/生年月日は要確認) |
| `docs/lab/wellfort_admin_lab_upload_spec.md` | 管理UI: 検査結果ファイルアップロード仕様。**責務分界(UI=wellfort-site / API=Scan-Chat-AI・§3/§6-1)の正** |
| **`docs/lab/ad_hoc_diagnosis_batch_spec.md`** | **臨時診断バッチ (複数人分の検査データ ZIP を管理者が投入 → 分類 → 構造化 → 確認 → Elith 納品) のクロスシステム仕様**。**UI=wellfort-site / 処理=Scan-Chat-AI**(2026-09-10 発注者確定・§4)／ZIP は presigned PUT で Vercel を通さない(§5.2)／**ZIP・XLSX は依存追加なしの自作リーダ**(§5.3)／人物識別と分類を分離・**client_id は新規 UUID**(§6/§13)／健診 PDF+XLSX の二重納品を防ぐ(§12)／**既存 5 種 `GATING_FORMAT_IDS` を変更せず案件別 `required_formats` を持つ**(§15.2)／ウェルネス年齢は既存関数を呼ぶだけ・**全員算出可能と仮定しない**(§16)／未確定 6 件は §28.2 に分離 |
| `docs/lab/lab_integration_workflow.md` | 検査機関→ユーザー割当ワークフロー (PII 制約) |
| `docs/lab/kit_progress_management.md` | 検査キット発送・進捗管理 |
| `docs/architecture/data_integration_requirements.md` | PII 分離・連携要件 |
| `docs/operations/S3原本ストレージ_構築手順書.md` | **原本を S3 ap-northeast-1 へ置くためのインフラ手順** (Object Lock / ライフサイクル / IAM / Vercel env / 動作確認)。Compliance モードの不可逆性に注意 |
| **`docs/operations/スキャンS3直アップロード_バケット設定手順書.md`** | **スキャンで 10MB を通すための AWS 側作業** (①CORS=必須・無いと PDF は 3.2MB のまま / ②ライフサイクル=推奨)。バケット・プレフィックス・CORS 未設定は**本番の実測値**。設定前後を同じコマンドで判定できる確認手順つき。**CORS はバケットを公開しない**・ライフサイクルの prefix を誤ると Elith 納品が消える、の 2 点が要注意 |
| `docs/architecture/id_management_and_correlation_spec.md` | **ID体系の正本**(顧客ID/診断ユーザーID=diagnostic_user_id/注文/契約/出荷/検査/各社上りID/Elith client_id を層別整理・採番=現状全てWellfort・相関マップ・PII境界・**将来の各社独自ID/キット物理ID(POS/バーコード)連携=受け皿カラム`lab_tests.external_test_id`/`external_barcode`実在**) |
| `docs/architecture/diagnostic_session_data_spec.md` | 診断セッションのデータ構造 |
| `docs/scan/scan_feature_requirements.md` / `docs/scan/scan_s3_export.md` | AIスキャン機能要件 / S3書き出し |
| `docs/scan/health_age_caba_v5.4_spec.md` | **ウェルネス年齢 ①正規版(CABA v5.4)確定事項** (免責2文/WBC桁正規化/補完定数/SBP・FEV補正・Wellfort確認2026-08) |
| `docs/scan/health_age_simple_v7.0_spec.md` | **ウェルネス年齢 ②簡易版(CABA v7.0)** = 血球分画/ALP/WBC/CRP を持たない簡易書式向けフォールバック。**改称(健康年齢→ウェルネス年齢)の適用範囲・段階フォールバック①②③・移植元の復元手順と数値照合表**もここ |
| `docs/scan/scan_canonicalization_standard_format_design.md` | **戦略正本: 検査票→標準フォーマット正準化(2層戦略)**。①読取=native multimodal維持 / ②正準化=健診標準フォーマット(KMAT)への決定論マッピング新規 |
| **`docs/scan/スキャン非同期処理_仕様書.md`** | **【送信後はバックグラウンドで読み取る・仕様。実装は未着手】発注者判断 2026-09-10「S3 に置いて定期的に削除で進めて」。** 画像を全ページ S3 へ / 削除は既存ライフサイクル(1日)＋読了時削除の二段 / `diagnosis.scan_jobs` / ワーカーは 1 起動で回せるだけ回す / **Vercel の上限は 60s でなく 300〜800s・Cron 最小間隔はプラン依存**(一次資料つき) / 段階 P0〜P5 / **発注者確認 4 件** |
| `docs/ai_reviews/` | Gemini/ChatGPT へのレビュー依頼・相談ドラフト集(開発経緯の記録。確定仕様は各 spec が正本) |

## CI (2026-09-08 新設・`.github/workflows/ci.yml`)

**既存の `verify:*` を PR で自動実行する。新しい検査をここに書き足さない** (二重管理しない)。
それまで CI では 1 本も走っておらず (workflows は `sol-publisher.yml` のみ)、実際に
**並行ブランチ `claude/ai-disease-prevention-report-v2-tjf4am` に `.report-prose { max-width: none }`**
= 2026-09-06 の裁定 (45em) と逆方向の変更が残っていた。**このブランチは救出しない・再利用しない**
(発注者判断 2026-09-08・分類 C 旧仕様)。

| job | 中身 | 実測 | 状態 |
|---|---|---|---|
| `static-required` | astro check / build / **A 層 11 本** | 60s + npm ci | **required** |
| `pwsh-verify` | B 層 6 本 (PowerShell 必須) | 未実測 | 初回 non-required |
| `browser-screen` | **`verify:screen` 単独** | 12s | non-required → **優先して昇格** |
| `browser-extended` | interview-ui / scan-pages / scan-upload | 83s | 当面 non-required |

- **`verify:screen` を単独 job にしてある**のは、上記の回帰を落とせるのがこれだけで、
  他のブラウザ検査の flaky で required 化を止められないようにするため。
  実測: `45em → none` を注入すると「本文の行長が 836px で上限 720px を超えた」で落ちる。
- **`verify:print` は入れない** (発注者判断)。`poppler-utils` がランナー未同梱で、和文フォント
  (BIZ UDGothic) が無いと検査 ⓪ が「中国語フォントが埋め込まれている」で**必ず**落ちる
  = 実ロジックでなく環境差で赤くなる。**廃止ではなく Phase 2 以降の保留項目。**
- **`CHROMIUM_PATH` を CI で設定しない。** 各スクリプトは
  `executablePath: CHROMIUM_PATH ?? '/opt/pw-browsers/chromium'` で試して**失敗したら
  `chromium.launch()` へフォールバックする** (`verify-screen.mjs:64-68` ほか 3 本同形)。
  無理に指すと Playwright が期待する版と食い違ったときに**フォールバックごと失敗する**(実測)。
- **secret は 1 つも要らない**。秘密が要りそうな検査は**自分でダミー値を注入している**
  (`verify-demecal-final-setup.mjs:430-433`)。24 本とも **localhost 以外へアクセスしない**。
  権限は `contents: read` のみ・push も deployment もしない。
- **ブランチ棚卸しの前に `git rev-parse --is-shallow-repository` を必ず見る。**
  この作業環境は shallow clone で、そのまま測ると ahead/behind・merge-base・patch-id が
  全部狂う (実測: 3 本が「共通祖先なし・未反映 199/276/220」→ `--unshallow` 後は全て ahead 0)。
  **shallow のままブランチ救出の可否を判定しない。**

## コード / スタック
- Astro v5 + TypeScript (SSR / Vercel)。UI=`.astro`、API=`src/pages/api/**.ts`、ロジック=`src/lib/`。
- Supabase 2スキーマ (`customer`=PII / `diagnosis`=非PII)。マイグレーション=`supabase/migrations/`。
- 標準スクリプトは `scripts/*.mjs` (Node ESM, 追加依存なし方針)。
- 主要ライブラリ: `@google/genai`(Gemini)、`@aws-sdk/client-s3`(S3)、`@supabase/supabase-js`。

## デプロイ元ブランチ (2026-08-29 確定・発注者判断「A案」)

**症状**: 本番へマージすると UI デザインや LAiF デモ画面が**前の版に戻る**ことが頻発していた。

**真因 = git ではなくブランチ運用の食い違い** (実測で特定):

| repo | GitHub 既定ブランチ | 実際に作業/デプロイしたいブランチ | 結果 |
|---|---|---|---|
| Scan-Chat-AI | `claude/awesome-carson-UeyUZ` (=作業ブランチ・`main` は**存在しない**) | 同じ | 事故なし |
| wellfort-site | **`main`** | `claude/wellfort-ui-design-draft-7y8dup` | **Preview 止まり + 二重管理** |

- Vercel は **Production Branch に設定されたブランチだけ**を Production にする。wellfort-site は
  既定が `main` なので、`wellfort-ui-design-draft-7y8dup` へマージしても **Preview のまま**だった。
- 結果 `main` と当該ブランチが**双方向に乖離** (main に無い 25 件 / 当該に無い 11 件)。
- さらに**同じ作業が両ブランチに別ハッシュで二重に入っていた**
  (`LAiFサンプル: 黒枠…` = main `b8eb12f` / 本番 `d85e4e7` 等 4 組)。マージでなく同じ変更を 2 回当てた形跡。
  → git は別物として扱うので、両者をマージすると **LAiF/partner 領域で必ず競合**し、
    解決を取り違えると片方の版に戻る。**これが「戻る」の正体。**
- **実測した競合 3 件はいずれも「main が古い」**: `api/partner/upload.ts` と
  `partner-portal-preview.astro` が **main=20MB / 本番=50MB** (先日の LAiF 34MB 弾かれ対応が巻き戻る)、
  LAiF サンプル xlsx は **`xl/` 配下の XML ハッシュが完全一致** = 中身同一でファイル名規則化の差のみ。
  → **`main` にしかない新しい中身は無い。捨ててよい** (発注者確認済み)。

**確定 (A案)**: **wellfort-site の Vercel Production Branch を
`claude/wellfort-ui-design-draft-7y8dup` にする** (Scan-Chat-AI と同じ「既定=作業ブランチ」の形に揃える)。
`main` は使わない。**Vercel の設定変更は発注者側の操作** (UNFIX からは実行も確認もできない)。

- 切替前に検証済み: 当該ブランチで `astro build` 成功 / `astro check` のエラー数はマージ前後とも 82 で増減なし。
- **CI の追随**: `.github/workflows/deploy-supabase-functions.yml` は `main` への push で発火していた。
  デプロイ元が変わると **Edge Function の自動デプロイが黙って止まる**ため、
  trigger branches に当該ブランチを追加済み (`f21ac3f`)。`supabase/` の中身は両ブランチ同一。
  もう一方の `charge-subscriptions-cron.yml` は cron/手動のみで branches 指定が無く影響なし。
- **【解決済み 2026-08-29・発注者対応】GitHub の既定ブランチも
  `claude/wellfort-ui-design-draft-7y8dup` へ切替済み**。これで新規 PR の base が本番ブランチに
  なり、`main` 経由の二重管理は再発しない。**`main` は使わない** (中身は古い・捨ててよいと確認済み)。
  - **注意**: 切替前に `main` から切られたローカル/リモートのブランチは、**本番の 26 件を欠いたまま**
    残っている。実例: 本リバート作業で wellfort-site の作業ブランチが `main` と完全一致
    (0/0) で、対象コミット `71e7936`/`680c73e` を含んでいなかった。
    **既存ブランチで作業を再開するときは、まず本番ブランチとの差分を確認すること。**

- **【再発 2026-09-01・実測】上の注意が現実になった。デプロイ元が別ブランチに差し替わっていた。**
  発端は「`https://www.wellfort.co.jp/partner-portal-preview` が 404」。
  - **本番サイトのデプロイ元は `claude/hopeful-darwin-1vdsq0` だった** (2 つの独立した証拠で断定):
    ① `/admin/notify-recipients` = **このブランチにしか無いページ**が HTTP 200 で
    `<title>注文通知先 - Wellfort Admin` を返す ② `/company` が「本田大作 5 件 /
    物部慶幸 **0 件**」= hopeful-darwin と一致 (本番ブランチ側は物部慶幸が
    `company.astro` に 5・`news.astro` に 2 残っていた)。
  - 同ブランチは **2026-07-30 分岐で本番ブランチの 144 コミットを欠いていた**。
    結果、**11 本のページ・API が本番サイトから丸ごと消えていた**:
    `partner-portal-preview` / `api/partner/upload` / `admin/payment-config` +
    `api/admin/payment-config` / `api/payment-status` / `admin/demo-accounts` +
    `api/admin/demo-accounts` / `admin/demecal-csv` / `api/admin/config` /
    `api/admin/elith-verify` / `api/admin/elith-plan-timeseries`。
    内容面でも 8/24〜8/31 の更新 (提携=BISEIDO・医師の声の写真・recruit 準備中・
    アイコン `?v=3`・resolve-customer の admin 判定 等) が全部落ちていた。
  - **切り戻す順序を間違えない**: 先に**稼働中のブランチの独自コミットを本番ブランチへマージ**
    してから Vercel を戻す。逆にすると代表者名が物部慶幸へ戻る等の巻き戻りが起きる。
    → マージ済み (`20169a3`・10 コミット。競合 3 件は config.toml=両方採用 /
    AdminLayout=メニュー両方 / `gmo-return.ts`=**本番の `resolvePaymentEnv` を残し**
    hopeful-darwin 側の `gmoEnvBrand`/`gmoApiBase` は**本番ブランチに存在しない**ので
    解決経路だけ移植)。
  - **404 は「どのページが 404 か」で分岐点が割り出せる**。ページの追加日を
    `git log --diff-filter=A` で引き、200 と 404 の境界を挟めば分岐日が出る
    (今回: `/admin/elith-batch` 7/16=200 ⇔ `/partner-portal-preview` 8/10=404 → 7/30 分岐)。
  - **どのブランチが実際にデプロイされているかは、そのブランチにしか無いページを叩いて確かめる。**
    設定画面を見られない側からでも、これで確定できる。

## 開発ブランチ / ブランチ管理 (2リポジトリ・ドメイン別・ペア運用・2026-08 定義)
- **ドメイン別ブランチ**: wellfort-site は EC/FA/Elith 等 関心事が混在するため、関心事ごとにブランチを分ける
  (`claude/<domain>-<topic>`。EC/FA と Elith を混ぜない)。
- **Elith/scan精度 作業の正本ペア (この作業線)**:
  - **Scan-Chat-AI = `claude/clever-cray-ngg0h6`** (読取/正準化/dedup/perception/**golden 正解データ(docs)**)。
  - **wellfort-site = `claude/elith-verify-image-json`** (admin UI・**goldenCheck 照合器**・necessity 可視化)。
  - **🎯 検証はこの2本を同時デプロイして成立** (Scan-Chat-AI API × wellfort-site admin)。EC/FA ブランチには触らない。
- **照合(検証)のタイプ別定義** (照合器=wellfort-site admin / golden正解データ=Scan-Chat-AI docs):
  | タイプ | format_id | 取得 | 🎯値golden(決定論・画像非依存) | 🔍画像照合(LLM) | ④の照合 |
  |---|---|---|---|---|---|
  | 健康診断(検診) | HealthCheckupData | アプリscan | ○ `docs/scan/golden/scan_golden_healthcheckup_20250123.md` | ○ | — |
  | 人間ドック | HealthCheckupData | アプリscan | ○ `docs/scan/golden/scan_golden_humandock_20240924.md`／`…_20250217.md`(湘南メディカル個人表様式・未実施多数=定性番人) | ○ | — |
  | がんリスク | CancerRiskAssessmentData | adminバッチ | ○ `docs/scan/golden/scan_golden_cancer_alapds_20251226.md`(ALA-PDS様式1) | ○ | — |
  | 遺伝子 | GeneticTestResultData | adminバッチ | 建立待ち(様式1) | ○ | — |
  | AI疾病発症予測(LAiF) | Other/ai_prediction | adminバッチ(多ページPDF) | ○ `docs/scan/golden/scan_golden_ai_prediction_laif_20250818.md`(様式1・2ページ目=本人結果) | △(値中心・名前セル不可読) | — |
  | 血液 | BloodTestData | デメカルCSV | (CSV由来値で可) | **×(画像なし)** | **CSV↔JSON構造照合(決定論・Scan-Chat-AI scripts)** |
  - **🎯値golden = 画像非依存**なので全タイプで使える(正解値さえ建立すれば)。`elith-batch.astro goldenCheck` は
    `test_date` で検体切替(検診/人間ドック実装済・②③は様式1つで各1本)。
  - **golden は必ず元画像から人手で起こす (2026-08 確定・R2/R3)**: スキャン run の raw_markdown を"正解"にしてはならない。
    実障害(2026-08): 人間ドック golden を scan 出力から作った結果、その run の隣接行シフト/脂質混入を golden が継承し
    (LDL/HDL/TG・LDH/ALP/γ-GTP・好酸球/好塩基球 が誤り。LDL+HDL=176>TC=151 の物理矛盾を見落とし)、**正しいスキャンを
    誤判定して改善を誤導**した(ChatGPT指摘で発覚→元画像で全項目再監査し修正、`docs/scan/golden/scan_golden_humandock_20240924.md`)。
    建立時は 推移グラフ/Friedewald(TC≒LDL+HDL+TG/5)/基準値レンジ 等でクロス検算する。
  - **🔍画像照合 = 画像がある型(検診/人間ドック/がん/遺伝子)のみ**。④血液は CSV が決定論正解源=画像照合不可 →
    **CSV↔JSON 構造照合**(全項目写像=漏れゼロ/余剰=捏造ゼロ/単位・判定コード対応)を Scan-Chat-AI 側 fixture で。
- **git 規定との関係**: タスク既定は両repo `clever-cray-ngg0h6` だが、wellfort-site の Elith admin は上記のとおり
  `elith-verify-image-json` を正本とする(発注者承認 2026-08)。別ブランチへの push は都度明示許可を得る。
</content>
