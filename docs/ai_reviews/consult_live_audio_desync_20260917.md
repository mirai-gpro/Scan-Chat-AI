# 相談: Gemini Live API で「画面と音声がずれる / 音声が途切れる」— 原因と対策の見解を求めます

- 日付: 2026-09-17
- 対象コード: `src/scripts/chat/live-controller.ts` / `live-audio-manager.ts` / `interview-script.ts`
- 相談先: ChatGPT (同じ内容を Gemini にも投げます)
- **この文書は相談用の下書きです。確定仕様は `docs/interview/AI問診_仕様と設計原則.md` が正本。**

---

## 0. お願いしたいこと

実機から 2 件の不具合報告が来ています。**原因の切り分けと対策の妥当性**について、
公式仕様に照らした見解をください。とくに **§4 の「やってはいけないこと」を守ったまま**
成立する設計を知りたいです（過去に禁止事項を破って 3 回リバートしています）。

**推測ではなく一次資料（Live API の公式ドキュメント / SDK の実装）に基づく回答**を希望します。
公式に書かれていない挙動は「未確認」と明示してください。

---

## 1. アプリの構成（前提）

健康診断アプリの **AI 問診**（音声とタップのハイブリッド）です。

| 担当 | 役割 |
|---|---|
| **プログラム**（`InterviewEngine`・クライアント） | 質問の順序・分岐・完了判定・回答データの構造化・画面の描画 |
| **Gemini Live API（LLM）** | **音声だけ**。挨拶と「次の質問の読み上げ」。ターン取り・VAD・割り込みはサーバ側に委ねる |

- モデル: **`gemini-3.1-flash-live-preview`**（DB 設定で差し替え可）
- SDK: `@google/genai`、`ai.live.connect({ ... })`、`httpOptions: { apiVersion: 'v1alpha' }`
- 接続設定（実コード）:
  ```ts
  config: {
    responseModalities: [Modality.AUDIO],
    systemInstruction: { parts: [{ text: instruction }] },
    speechConfig: { languageCode: 'ja-JP' },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: { activityHandling: ActivityHandling.NO_INTERRUPTION },
  }
  ```
- **確定仕様（2026-09-04・発注者指示）**: **AI は「次の質問」だけを読み上げる。**
  回答の復唱も、確認の聞き返しもしない。回答の確認は**画面の「✅ 〜で承りました」表示**が担う。
- 利用者は 50〜65 代が中心。**タップ回答が一級市民**（音声は補助）。

---

## 2. いま起きていること（実機からの報告）

### ④ 画面と音声がリンクしていない
画面には次の質問が出ているのに、**音声はまだ前の質問を読んでいる**。

### ⑤ 音声が止まる・途切れる
読み上げが途中で止まる、途切れる。

報告は実機（スマートフォン）からで、**開発環境では再現できていません**
（API キーは本番のサーバ側にしか置かない運用のため、手元で Live API を叩けない）。

---

## 3. 実装の事実（該当コードの抜粋）

### 3.1 回答確定 → 次の質問（`live-controller.ts:637-650`）
```ts
refs.questionText.textContent = `✅ 「${rawAnswer}」で承りました`;
// ① 先に画面を次の質問へ
applyQuestionToUI(next);
// ② そのうえで、同じ質問を AI に読ませる
const msg = `次の質問を自然に読み上げてください: 「${speechOf(next)}」
ユーザーの回答を復唱しないでください。選択肢も読み上げないでください (画面に表示されています)。`;
sendToModel(msg);
```
① は即時、② はモデルの都合。**この間に前の読み上げが残っていると画面と音声がずれます。**

### 3.2 依頼の送り方（`live-controller.ts:759-769`）
```ts
function sendToModel(text: string): void {
  if (!liveSession) { /* 未接続の案内 */ return; }
  liveSession.sendRealtimeInput({ text });
}
```

### 3.3 ところが最初の質問だけ別チャネル（`live-controller.ts:846-856`・`onopen` の 250ms 後）
```ts
liveSession?.sendClientContent({
  turns: [{ role: 'user', parts: [{ text: `問診を始めます。次の 2 文を発話してください: …` }] }],
  turnComplete: true,
});
```
**同じ「質問を読ませる」操作なのに、1 問目は `sendClientContent`、2 問目以降は
`sendRealtimeInput({ text })`** という食い違いがあります。

### 3.4 割り込みの設定（`live-controller.ts:811-815`）
```ts
// VAD / barge-in は LLM (サーバ) 側に委ねる:
//   - automaticActivityDetection: 既定 ON のまま
//   - activityHandling: NO_INTERRUPTION で AI 発話中の barge-in を抑止
//     (周辺ノイズで AI 発話が途中で切れる現象を防ぐ)
realtimeInputConfig: { activityHandling: ActivityHandling.NO_INTERRUPTION },
```
入れた理由は**周辺ノイズで読み上げが途切れる**のを防ぐためです（実機で発生）。

### 3.5 マイク入力
- 常時送信。**ゲートしていません**（`setInputMuted` は実装されているが**呼び出し 0 件**）。
- `getUserMedia({ audio: { channelCount:1, echoCancellation:true, noiseSuppression:true, autoGainControl:true } })`
- `ScriptProcessorNode(4096)` で 16kHz / Int16 へダウンサンプルし
  `sendRealtimeInput({ audio: { data, mimeType: 'audio/pcm;rate=16000' } })`。

### 3.6 再生（`live-audio-manager.ts:94-116`）
```ts
playPcm(base64) {                    // サーバからの 24kHz PCM を 1 チャンクずつ
  const buf = this.outputCtx.createBuffer(1, float32.length, 24000);
  const src = this.outputCtx.createBufferSource();
  src.buffer = buf; src.connect(this.outputCtx.destination);
  const start = Math.max(this.nextPlaybackTime, this.outputCtx.currentTime);
  src.start(start);
  this.nextPlaybackTime = start + buf.duration;
}
```
- 出力は `new AudioContext({ sampleRate: 24000 })`。
- **ジッタバッファなし**。チャンクが遅れて `nextPlaybackTime < currentTime` になると
  その場で再生 = 前のチャンクと**継ぎ目が空く / 詰まる**可能性。
- `serverContent.interrupted` を受けたら `flushPlayback()`（再生中を全停止）。

---

## 4. やってはいけないこと（この製品の確定事項・破ると差し戻し）

過去に破って**読み上げが途中で切れる回帰**を出し、リバートしています。

1. **プログラムでターン制御をしない** — マイクの半二重ゲート、AI 発話中のマイク送信停止、
   「復唱するはずだから依頼を出し分ける（silent 分岐）」等は**禁止**。
2. **UI を音声に結合させない** — 以前「AI 音声の最初のチャンク」または「2 秒」で次の質問を
   描画していた（`schedulePendingQuestion`）。これが**音声が再生中なのに次の選択肢が出る**の
   直接原因だったので**廃止済み**。状態機械も ID 照合も足さない方針。
3. **確認発話を実装しない**（聞き返しは engine に状態を足すことになる）。
4. AI は**次の質問だけ**を読む（復唱しない）。

→ **「画面を音声に待たせる」「音声を画面に合わせて止める」類の対症療法は採れません。**
   公式の仕組みの範囲で解決したいです。

---

## 5. 当方の仮説（検証をお願いしたい）

### 仮説 A — `NO_INTERRUPTION` が新しい依頼の読み上げ開始まで遅らせている
「ユーザー音声による割り込みを無視する」設定のつもりですが、**クライアントから送った
新しいテキストのターンも、前の発話が終わるまで開始されない**のではないか。
だとすれば ④ は仕様どおりの挙動で、設定の選択が誤っていることになります。

### 仮説 B — テキストのターンを `sendRealtimeInput` で送っているのが誤り
公式ガイドの理解では
- `send_realtime_input` … 応答性重視で**順序は保証されない**
- `send_client_content` … **順序どおり**にモデルのコンテキストへ追加
であり、**テキストのターンは `send_client_content`** が正。速くタップすると依頼が複数積まれ、
読まれる順が保証されない ⇒ ④⑤ の両方に効く、と考えています。
**1 問目（`sendClientContent`）だけ画面と音声が合っていて 2 問目以降からずれる**なら、
この仮説はほぼ確定と考えています（実機で見てもらう予定）。

### 仮説 C — 再生側にジッタバッファが無い（⑤ の独立要因）
モバイル回線でチャンクが遅れると継ぎ目が割れる。**A/B とは独立**に起こり得る。

---

## 6. 具体的にお聞きしたいこと

1. **`activityHandling: NO_INTERRUPTION` の正確な作用範囲**。
   抑止されるのは「ユーザーの音声アクティビティによる割り込み」だけですか。
   **クライアントが `sendClientContent(turnComplete: true)` で投入した新しいターン**は、
   モデルが発話中でも**即座に現在の生成を中断して**開始されますか。公式の記述はどこですか。
2. **テキストのターン投入の正しい API**。`sendRealtimeInput({ text })` は
   そもそもサポートされた使い方ですか（SDK 型上は通ります）。`sendClientContent` との
   意味論の違い（順序保証・コンテキストへの入り方・ターン境界）を教えてください。
3. **「前の読み上げを止めて、すぐ次の質問を読ませる」正しい方法**は何ですか。
   `turnComplete: true` で足りますか。`activityStart` / `activityEnd` を明示的に送る、
   あるいは別の中断 API を使うべきですか。**クライアント側で音声再生を止めるのは
   対症療法**なので、サーバ側のターンを正しく切りたいです。
4. **ノイズによる誤割り込み**（`NO_INTERRUPTION` を入れた元の動機）を、
   `NO_INTERRUPTION` を使わずに抑える推奨手段はありますか。
   （`automaticActivityDetection` の感度設定、`startOfSpeechSensitivity` /
   `prefixPaddingMs` / `silenceDurationMs` 等の現行の推奨値があれば）
5. **画面（プログラム駆動のフロー）と音声（LLM 駆動のターン）を同期させる設計パターン**。
   §4 の禁止事項を守ったまま、「画面に出ている質問 ＝ いま読まれている質問」を
   構造的に保証する方法はありますか。
   （当方の現行方針は「AI は次の質問だけを読む・画面は回答確定と同時に進める」です）
6. **再生側の推奨実装**。
   - 何 ms 程度のジッタバッファが妥当か（Live API の 24kHz PCM チャンク前提）
   - `nextPlaybackTime < currentTime`（アンダーラン）の扱い
   - **iOS Safari で `new AudioContext({ sampleRate: 24000 })`** は正しく尊重されますか。
     端末既定（48kHz 等）との不一致によるリサンプリングが途切れの原因になり得ますか。
   - `ScriptProcessorNode` から `AudioWorklet` へ移す価値はありますか（入力側）。
7. **本番でしか再現できない**前提で、**最小の観測**で A/B/C を切り分ける手順を提案してください。
   採取できるのは `serverContent.turnComplete` / `interrupted` / `outputTranscription` /
   チャンク到着時刻 / 依頼送信時刻 などクライアント側の情報です。

---

## 7. 参考（当方が根拠にしている記述）

- Live API guide:
  - `send_realtime_input` is "optimized for responsiveness at the expense of deterministic ordering"
  - `send_client_content` "adds messages to the model context in sequential order"
  - `turn_complete=true` は "unconditionally interrupts generation"（と理解しています。**要確認**）
- 上記の理解が誤っていれば**その旨を明示してください**。当方は公式の一次資料に基づいて
  判断したいので、記憶ベースの一般論は避けてください。
