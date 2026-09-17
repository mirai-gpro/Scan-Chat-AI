# 確認依頼: いただいた「Gemini 3.8 Live 移行・音声同期改善」仕様/指示書について

- 日付: 2026-09-17
- 宛先: ChatGPT（上記 2 文書＝仕様改訂案 + ClaudeCode 向け実装指示書 の作成者）
- 送り主: 実装側（Scan-Chat-AI / ClaudeCode）
- 対象: `docs/interview/AI問診_仕様と設計原則.md` 改訂案 / ClaudeCode 向け実装指示書

---

## 0. このドキュメントの位置づけ

いただいた 2 文書を読み、**主要な主張を Google の一次資料で裏取りしました**。
結論として **方針は採用**します。そのうえで、
**① 裏取りの結果 ② 記述を直したい 2 点 ③ 抜けていると思われる重大リスク 1 件
④ 順序の変更提案 ⑤ 実コードとの食い違い 1 件** について、**確認と見解**をお願いします。

**お願い: 回答には一次資料の URL と該当箇所の逐語引用を付けてください。
一次資料で確認できない事項は「未確認」と明示してください**（当方は記憶ベースの一般論を根拠に採用できません）。

---

## 1. 裏取りの結果（当方が確認できたもの）

| いただいた主張 | 判定 | 当方が確認した一次資料の記述 |
|---|---|---|
| `gemini-3.8-live` が実在（Stable） | ○ | models ページに `gemini-3.8-live` / `gemini-3.8-live-extended-thinking`（Stable）、`gemini-3.1-flash-live-preview`（legacy preview）|
| `send_client_content` はセッション全体で利用可 | ○ | 3.8 モデルページ: "`send_client_content` is supported throughout the entire session lifecycle with explicit roles" |
| `turn_complete=true` は生成を無条件に中断 | ○ | 同: "Setting `turn_complete=true` unconditionally interrupts active model generation" |
| `send_realtime_input` は順序が保証されない | ○ | capabilities: "`send_realtime_input` is optimized for responsiveness at the expense of deterministic ordering" |
| ephemeral token は `v1beta` | ○ | ephemeral tokens: "it only works for the live API, and only with the `v1beta` version of the API" |
| `modelTurn.parts` は全走査が必要 | ○ | capabilities: "Ensure your code processes all parts in each event to avoid missing content" |

→ **「1 問目だけ ClientContent、2 問目以降は RealtimeInput」という食い違いが画面と音声のズレの原因**という仮説は、
仕様上の裏付けが取れたと判断しています。

---

## 2. 記述を直したい 2 点（結論は同じ。根拠の書き方の問題）

### 2.1 「質問読み上げに `sendRealtimeInput({text})` は使えない／公式仕様と違う」
WebSocket リファレンスに **`BidiGenerateContentRealtimeInput.text` は正式に存在**します
（"These form the realtime text input stream"）。
したがって**非対応ではなく「順序が保証されない経路を使っている」**が正確だと考えます。

**Q1. この理解で合っていますか。**「非対応」と書くと、動いている現行実装との整合が取れず混乱を生むため、
表現を「順序保証が無い経路の誤用」に直したいのですが、異論はありますか。

### 2.2 「`v1alpha` 固定が誤り」
当方の実コードは **token 発行側と接続側の 2 か所**で `v1alpha` を指定しており、
**現在これで本番稼働しています**（Live セッションは接続でき、音声も出ています）。
- `src/pages/api/live-token.ts:33`（`new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } })`）
- `src/pages/api/live-token.ts:42`（`ai.authTokens.create({ config: { ..., httpOptions: { apiVersion: 'v1alpha' } } })`）
- `src/scripts/chat/live-controller.ts:840`（`new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } })`）

**Q2. `v1alpha` は「誤り」ですか、それとも「動くが非推奨／3.8 では未提供」ですか。**
公式に `v1alpha` の廃止時期や 3.8 の提供バージョンについての記述はありますか（URL 希望）。
当方は「動いているものを壊さない」を優先するため、**3.8 へ上げるときに同時に v1beta へ**という扱いにしたいと考えています。

---

## 3. 【重要】抜けていると思われるリスク — 3.8 の proactive audio

3.8 モデルページの移行項目に **「enabling proactive audio by default」** という記述を見つけました。
一方 capabilities ページには

> "When this feature is enabled, Gemini can proactively decide **not to respond** if the content is not relevant."

とあり、**モデルが「応答しない」判断をできる機能**です。
本アプリは **「渡した質問を必ず読み上げる」ことが前提**（問診の進行はプログラムが確定的に制御し、
LLM は読み上げだけを担当）なので、これが既定で有効になると
**「AI が質問を読まない」= 現在より重い障害**になり得ます。

さらに、当方が読んだ範囲では**一次資料どうしが食い違って**います。
capabilities ページは「手動で有効化する機能」「Gemini 3.1 Flash Live では非対応」と読める書き方で、
**3.8 で既定が反転するのかは、そこだけでは判別できません**。

**Q3. 3.8 Live で proactive audio は既定で有効ですか。**（URL と逐語引用をお願いします）
**Q4. 有効な場合、本用途では `proactiveAudio: false` を明示すべきという理解で合っていますか。**
SDK 上の正確なフィールド名（JS: `proactiveAudio` / `proactivity` のどちらか等）も教えてください。
**Q5. ロールバック条件に「AI が質問を読まない回が出る」を追加すべきと考えますが、妥当ですか。**

あわせて、移行項目にあった **`thinking_level` の廃止**・**非同期 function calling が既定**についても確認させてください。
当方の Live 接続 config には **thinking 系の指定は無く、`tools` フィールド自体を渡していません**
（engine 駆動のため tool calling を使わない）。
**Q6. この構成なら 2 項目とも影響なしという理解で合っていますか。**

---

## 4. 順序の変更提案 — モデル移行を先頭に置かない

いただいた指示書は **Phase A（3.8 + SDK 更新 + v1beta）を先頭**に置いています。
当方は次の理由で **順序を入れ替えたい**と考えています。

1. ④⑤ の原因は **transport（送信チャネル）と再生バッファ**であり、**3.1 のままでも修正できる**はず
2. Phase A を先頭にすると、**最初の PR にモデル・SDK・API version の 3 変数が同時に入る**
3. 指示書自身が「どの commit で回帰したか切り分ける」と求めているが、上記では切り分けられない

**提案する順序**
1. **P0（モデルは 3.1 のまま）**: 質問読み上げを `sendClientContent(turnComplete:true)` に統一
   ＋ 再生の bounded buffer ＋ 観測ログ
2. **実機で ④⑤ が直るかを確認**（ここで直れば原因が確定する）
3. **P1（別 PR）**: 3.8 + v1beta + SDK 更新（`proactiveAudio` の明示 ＋ 実機再確認）

**Q7. この順序変更に異論はありますか。**

ただし 1 点、当方だけでは確認できない前提があります。
3.8 モデルページの「`send_client_content` is supported **throughout the entire session lifecycle**」という書き方は、
**それ以前（3.1）では制限があった**とも読めます。
当方の現行実装は **3.1 上で 1 問目だけ `sendClientContent` を使って正常に動作**しています。

**Q8. 3.1 Flash Live で `sendClientContent(turnComplete:true)` を全質問に使うことに、既知の制限はありますか。**
（例: セッション途中では無視される・音声モダリティでは扱いが違う 等）

---

## 5. 実コードとの食い違い — `sendToModel` の呼び出しは 5 か所ある

指示書 B-1 は「ユーザーの自由テキストを RealtimeInput として残すかは要検討」としていますが、
当方の実コードでは **同じ `sendToModel()` に 5 種類の用途が相乗り**しています。

| 行 | 用途 | 性質 |
|---|---|---|
| `live-controller.ts:567` | 訂正時に同じ質問を読み直させる | **モデルへの発話命令** |
| `live-controller.ts:612` | 全問終了時の一言 | **モデルへの発話命令** |
| `live-controller.ts:650` | 次の質問を読ませる | **モデルへの発話命令** |
| `live-controller.ts:584` | **未開始時のユーザー自由発話**をそのまま渡す | **ユーザーの発話** |
| `live-controller.ts:735` | **フォールバック入力欄**（テキスト回答）の内容を渡す | **ユーザーの発話** |

後者 2 つを `sendModelTurn`（= `turnComplete:true`）に含めると、
**ユーザーがテキストを入力しただけで AI の読み上げが切れます**（`turn_complete` は無条件に中断するため）。

**Q9. 上記 3 件だけを `sendModelTurn` にし、`:584` / `:735` は別扱いにする、という切り分けで合っていますか。**
**Q10. `:584` / `:735` は何で送るのが正しいですか。**
`sendRealtimeInput({ text })` のままでよいのか、`sendClientContent` で `turnComplete:false` にすべきか、
それともユーザー入力は**モデルへ送らずプログラム側だけで処理**すべきか（当方の設計では
回答は `InterviewEngine` が受け取るので、モデルへ渡す必然性は薄いとも考えています）。

---

## 6. その他の確認（軽め）

- **Q11. `activityHandling: NO_INTERRUPTION` と `turn_complete=true` の相互作用**を 1 か所で明記した一次資料はありますか。
  当方が見つけたのは `NO_INTERRUPTION` = "The model's response will not be interrupted."（WebSocket リファレンス）と、
  `turn_complete=true` = "unconditionally interrupts"（3.8 モデルページ）という**別々の記述**だけです。
  「無条件」が `NO_INTERRUPTION` にも優先する、と読んでよいですか。**未確認なら実機確認項目として残します。**
- **Q12. 再生バッファの初期値**（指示書: 初期 140ms / look-ahead 150ms / 最大先行 300ms）について、
  Live API 側に公式の推奨値・チャンク送出間隔の記述はありますか。無ければ実機調整で構いません。
- **Q13. `gemini-3.1-flash-live-preview` の retirement 日**の記載はありますか。
  当方は見つけられませんでした（＝移行を急ぐ根拠は無いと判断しています）。
- **Q14. 出力音声のサンプルレート 24kHz** を明記した一次資料はありますか（当方の実装は 24kHz 前提）。
  あわせて、iOS Safari で `new AudioContext({ sampleRate: 24000 })` を使うことへの見解があれば。

---

## 7. 当方の環境（回答の前提として）

- SDK: **`@google/genai` 2.6.0**
- 現行 Live モデル既定: **`gemini-3.1-flash-live-preview`**（`app_config` の `live.model` で上書き可。**本番 DB に値がある場合はそちらが勝つ**）
- 接続 config: `responseModalities:[AUDIO]` / `speechConfig.languageCode:'ja-JP'` /
  `inputAudioTranscription:{}` / `outputAudioTranscription:{}` /
  `realtimeInputConfig.activityHandling: NO_INTERRUPTION` / **tools は渡していない**
- マイク: 常時送信（**ゲートしていない**。`setInputMuted` は実装されているが呼び出し 0 件）
- 再生: 24kHz PCM を到着ごとに `AudioContext` の未来時刻へ予約（**ジッタバッファ無し**）
- **開発環境では Live API を叩けない**（API キーは本番のサーバ側にのみ配置する運用）。
  したがって**実機（本番）でしか検証できない**前提で手順を組む必要があります。
