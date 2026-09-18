/**
 * AI 問診コントローラ (Phase 1.0 — engine 駆動)
 *
 * 設計:
 *   - 問診票本体 (Q1-1〜Q5-2, 分岐, 進捗) はクライアントの InterviewEngine が制御
 *   - Live API (LLM) は「質問の読み上げ」と「セクション切替の導線発話」だけを担当
 *     (2026-09-04: 回答の復唱は廃止。AI は質問だけを読み上げる)
 *   - LLM が問診順を決めないので、ループ・選択肢欠落・順序乱れが構造的にゼロ
 *
 * UI:
 *   - (音声 / テキスト切替トグルは 2026-09-04 に撤去。音声は常時オン)
 *   - 質問は engine が出す → 動的に widget を切替 (chip/multi/slider/stepper)
 *   - 補助テキスト入力 (音声モードでも常時利用可)
 *   - ストリーミング transcript で AI/ユーザー発話をライブ表示
 */

import { iconSvg } from '../../lib/icon-svg';
import {
  GoogleGenAI,
  Modality,
  ActivityHandling,
  type Session,
  type LiveServerMessage,
} from '@google/genai';
import { marked } from 'marked';
import { LiveAudioManager } from './live-audio-manager';
import { initLiveTrace, trace } from './live-trace';
import { createMicGate, type MicGate } from './mic-gate';
import {
  clearChatSession,
  clearInterviewProgress,
  clearInterviewResult,
  loadInterviewProgress,
  saveInterviewProgress,
  createEmptySession,
  loadChatSession,
  saveChatSession,
  saveInterviewResult,
  type ChatMessage,
  type ChatSession,
} from '../../lib/session-store';
import {
  InterviewEngine,
  SECTIONS as INTERVIEW_SECTIONS,
  type QuestionDef,
  type AnswerValue,
} from './interview-script';
import { openListPicker, openMatrixPicker, openActionSheet, formatMatrix, closeAllPickers } from './choice-picker';
import { getOrCreateDiagnosticId } from '../../lib/diagnostic-id';

export interface LiveRefs {
  log: HTMLElement;
  status: HTMLElement;
  resetBtn: HTMLButtonElement;
  resumeBanner: HTMLElement | null;

  progressText: HTMLElement;
  sectionLabel: HTMLElement;
  /** セクション dot を動的生成するコンテナ */
  sectionDots: HTMLElement;

  micBtn: HTMLButtonElement;
  startBtn: HTMLButtonElement;
  speakerBtn: HTMLButtonElement;

  /** マイクのオン / オフ。**帯とボタンで 1 組** (発注者裁定 2026-09-17・A 案)。 */
  micGate: HTMLElement;
  micGateNote: HTMLElement;
  micGateBtn: HTMLButtonElement;

  startHero: HTMLElement;
  qaArea: HTMLElement;
  /** 質問直下の常設ガイダンス「そのまま話して回答できます」。 */
  voiceGuide: HTMLElement;
  answerPanel: HTMLElement;
  questionText: HTMLElement;
  /** 直前の回答の確認バー (常設)。選択画面が覆っても回答が見えるようにするため。 */
  lastAnswer: HTMLElement;
  lastAnswerText: HTMLElement;
  lastAnswerEdit: HTMLButtonElement;

  uiVoice: HTMLElement;
  uiList: HTMLElement;
  uiMatrix: HTMLElement;
  uiSlider: HTMLElement;
  uiStepper: HTMLElement;
  uiText: HTMLElement;

  sliderInput: HTMLInputElement;
  sliderValue: HTMLElement;
  sliderLow: HTMLElement;
  sliderHigh: HTMLElement;
  sliderSubmit: HTMLButtonElement;

  stepperValue: HTMLElement;
  stepperUnit: HTMLElement;
  stepperMinus: HTMLButtonElement;
  stepperPlus: HTMLButtonElement;
  stepperSubmit: HTMLButtonElement;

  textInput: HTMLTextAreaElement;
  textSubmit: HTMLButtonElement;
  textExample: HTMLElement;


  listOpen: HTMLButtonElement;
  listSummary: HTMLElement;
  matrixOpen: HTMLButtonElement;
  matrixSummary: HTMLElement;

  fallbackZone: HTMLElement;
  fallbackInput: HTMLTextAreaElement;
  fallbackSend: HTMLButtonElement;

  skipBtn: HTMLButtonElement;

  /**
   * 任意。指定すると `/api/live-token` POST body に乗り、サーバが当該ユーザーの
   * 検査文脈を返す。返って来た文脈は system instruction の先頭に prepend される。
   * dev profile では URL `?u=<uuid>` を流用、本番では Auth 連携に置換予定。
   */
  diagnosticUserId?: string | null;
}

const SESSION_ID = 'default';

// 問診票のセクションは interview-script.ts に集約済 (INTERVIEW_SECTIONS を使用)
const SECTIONS = INTERVIEW_SECTIONS;

const SYSTEM_INSTRUCTION = `あなたはウェルフォートの健康問診を担当する AI 看護師アシスタントです。問診票本体 (質問順・選択肢・分岐) は画面のシステムが自動で出します。あなたは「画面に出ている質問を温かく読み上げる係」です。

【絶対ルール】
A. 自分で勝手に質問を考えない。ユーザー回答後にこちらから「次の質問: 『xxx』」と指定された文だけを読み上げる。指定がないターンでは質問を発話しない。
A-2. **問診の進み具合を自分で判断しない。** 「これで完了です」「最後の質問です」「あと少しです」等、**進行状況・残り問数に触れる発話を絶対にしない**。どこまで進んだか、いつ終わるかを知っているのは画面のシステムだけで、あなたには分からない。
B. 選択肢や入力例を長々と読み上げない (画面に表示されています)。回答方法が必要なときだけ「画面で回して選ぶか、声でお答えください」と一言添える程度にする。
C. ツール呼び出しは一切不要 (廃止済)。
D. 診断・処方は禁止。

【ターン構成】
E. **ユーザーの回答を復唱しない。** 確認の聞き返し・お礼・相づち・状況説明もしない。
   回答内容は画面に表示されるので、音声で繰り返すと二重になる。
   **発話するのは、こちらから届いた依頼文が指示する内容だけ。**
   ユーザーが声で答えたときも、こちらから次の質問の依頼が届く。それを読み上げればよい。
ユーザー回答が届いたら、以下の順で 1〜2 文を発話:
  ① セクションが変わるときだけ「次は◯◯についてお伺いしますね」と一言
  ② 依頼された質問本文をそのまま自然に読み上げる: 「『xxx』」

【セッション開始時】(1 ターン限り)
最初の発話: 「こんにちは、ウェルフォートの AI 問診です。画面の質問に、タップでも音声でもお答えいただけます。」と前置きしてから、最初の質問文を読み上げる。

【問診完了時】
**「これで全問終了です」という依頼がこちらから届いたときだけ**、「お疲れさまでした、ご協力ありがとうございました」と一言お礼。
**依頼が無いのに自分の判断で完了を告げてはいけない** (A-2)。

【緊急対応】
胸痛 / 呼吸困難 / 意識消失 / 激しい頭痛 / 大量出血等を訴えたら、即座に「すぐに 119 番にお電話ください」と案内する。`;


// TOOLS は廃止。engine 駆動になったため tool calling 一切不要 (定数自体も削除)。

// (旧 _OBSOLETE_TOOLS の Gemini Type 依存定義は engine 駆動化により全削除済)

// 旧 ChoiceOption / PresentArgs / FALLBACK_QUESTIONS / matchFallbackQuestion /
// extractLastQuestion は engine 駆動化 (interview-script.ts) により全削除済。
// 必要な型は QuestionDef / AnswerValue (interview-script から import)。
type ChoiceOption = { label: string; icon?: string };

export async function initLiveController(refs: LiveRefs): Promise<void> {
  let session: ChatSession = loadChatSession(SESSION_ID) ?? createEmptySession(SESSION_ID);
  const audio = new LiveAudioManager();
  /**
   * 直前に出したウィジェット。ガイダンスの出し分けに使う (`updateVoiceGuide`)。
   *
   * **ここで宣言する理由 (2026-09-18・実障害)**: 初期化は `applyModeUI()` →
   * `showWidget()` を**この関数の途中で直に呼ぶ**。`let` を使う場所の近く
   * (showWidget の直前) に置くと **TDZ で `Cannot access 'widgetKey' before
   * initialization` を投げ、`initLiveController` ごと落ちる**。すると
   * **開始ボタンの addEventListener に到達せず「押しても何も起きない」**になる。
   * 型検査は通る (型は正しい) ので、**宣言の位置を下げないこと**。
   */
  let widgetKey: WidgetKey = 'voice';
  /**
   * 「そのまま話して回答できます」の出し分け。
   * ①質問がまだ無い待機中 ②**マイクを切っているとき** は出さない
   * (切っているのに「話して回答できます」と出ていたら嘘になる)。
   */
  function updateVoiceGuide(): void {
    refs.voiceGuide.hidden = widgetKey === 'voice' || micGate.isMuted();
  }
  /**
   * マイクのオン / オフ (発注者指示 2026-09-17)。**利用者のタップでしか変わらない。**
   * ここから `toggle()` / `resetToOn()` を呼んでよいのは
   * ①マイクボタンの click ②問診を開始するとき の 2 か所だけで、
   * ターン・AI の発話・サーバのイベントからは**絶対に呼ばない** (プログラム側の
   * マイクゲートは禁止・正本 `docs/interview/AI問診_仕様と設計原則.md`)。
   */
  const micGate: MicGate = createMicGate(
    { gate: refs.micGate, note: refs.micGateNote, button: refs.micGateBtn },
    (muted) => {
      audio.setUserMicMuted(muted);
      // 切ってある間は「そのまま話して回答できます」を出さない (できないので)。
      updateVoiceGuide();
      trace('MIC_MUTE', currentQ?.id ?? null, { muted });
    },
  );
  /** そのターンで最初の音声 chunk が来たかどうか (観測ログ用。UI 遷移には使わない)。 */
  let sawAudioThisTurn = false;
  /** そのターンでマイクが何か拾ったか (観測ログ用。**中身は記録しない**)。 */
  let sawInputThisTurn = false;
  initLiveTrace();
  let liveSession: Session | null = null;
  let connecting = false;

  // ライブストリーミング transcript 用の DOM/buffer
  let assistantStreamBubble: HTMLElement | null = null;
  let userStreamBubble: HTMLElement | null = null;
  let assistantBuf = '';
  let userBuf = '';
  /** 直近の assistant 完了発話 (ループ検出用) */
  let lastFinalizedAssistant = '';
  let lastFinalizedAssistantAt = 0;
  let duplicateAssistantCount = 0;

  let currentQ: QuestionDef | null = null;
  /** 回答受付〜次設問表示までの間は音声回答の二重取り込みを抑止する */
  let advancing = false;
  let muted = false;
  /**
   * 直前に答えた設問 (確認バー「✓ ◯◯ ／ 訂正する」用)。
   * **時間で消さない** — 選択画面がモーダルで画面を覆うので、一瞬だけ出す方式では
   * そもそも見えない (発注者報告 2026-09-04)。次に答えるまで出しっぱなしにする。
   */
  let lastAnswered: { qid: string; text: string } | null = null;
  /** 内部で取得済の顧客プロフィール (氏名・生年月日・性別は問診で尋ねず結果へ付与) */
  let userProfile: { name: string | null; dateOfBirth: string | null; sex: string | null } | null = null;
  /** 申込情報から供給する EXAM-TYPE (今回実施検査)。空なら問診で通常設問として尋ねる。 */
  let seededExamTypes: string[] = [];
  const engine = new InterviewEngine();
  // 後方互換: 旧 fallback パス由来の参照を温存 (本実装では未使用)
  let presentQuestionCalledThisTurn = false;
  void presentQuestionCalledThisTurn;

  // セクション dot を SECTIONS に合わせて動的生成
  const sectionDotEls: HTMLElement[] = [];
  buildSectionDots();

  if (session.messages.length > 0 && refs.resumeBanner) {
    refs.resumeBanner.hidden = false;
  }
  renderHistory();
  setConnected(false);
  applyModeUI();
  refs.fallbackZone.hidden = false; // 補助テキスト入力は常時表示

  function buildSectionDots(): void {
    refs.sectionDots.innerHTML = '';
    sectionDotEls.length = 0;
    SECTIONS.forEach((s, i) => {
      const dot = document.createElement('div');
      dot.className = 'section-dot';
      dot.dataset.sectionDot = String(i);
      dot.title = s.title;
      refs.sectionDots.appendChild(dot);
      sectionDotEls.push(dot);
    });
  }

  // ── イベント結線 ──────────────────────────────────

  refs.resetBtn.addEventListener('click', () => {
    if (!confirm('問診をリセットしますか？（履歴が削除されます）')) return;
    stopLive();
    closeAllPickers();
    clearChatSession(SESSION_ID);
    clearInterviewResult(SESSION_ID);
    clearInterviewProgress(SESSION_ID);
    session = createEmptySession(SESSION_ID);
    currentQ = null;
    advancing = false;
    lastAnswered = null;
    renderLastAnswer();
    engine.reset();
    refs.resumeBanner && (refs.resumeBanner.hidden = true);
    renderHistory();
    renderProgress(0, '準備中…');
    renderSectionDots(-1);
    refs.questionText.textContent = '…';
    showWidget('voice');
    setConnected(false);
  });

  // 開始: 大型 hero ボタン
  refs.startBtn.addEventListener('click', () => toggleSession());
  // 中止: コンパクト top-right ボタン
  refs.micBtn.addEventListener('click', () => void confirmAbort());

  /** 途中経過を localStorage へ退避する (再開用)。 */
  function persistProgress(): void {
    const st = engine.getState();
    saveInterviewProgress({
      id: SESSION_ID,
      answers: st.answers as Record<string, string | string[] | number>,
      seeded: st.seeded,
      currentId: st.currentId,
    });
  }

  /**
   * 「中止」の 3 択 (発注者指示 2026-08)。
   *   ① 回答済の問診を記憶して中止する … 途中経過を保存し、次回の開始で続きから
   *   ② 回答を全てクリアして中止する   … 途中経過・履歴・結果を削除して最初から
   *   ③ 問診に戻る                     … 何もしない
   * 背景タップ・Esc も ③ 扱い (誤操作で回答を失わせない)。
   */
  async function confirmAbort(): Promise<void> {
    const answered = Object.keys(engine.getAnswers()).length;
    const picked = await openActionSheet({
      title: '問診を中止しますか？',
      description: answered > 0 ? `ここまで ${answered} 問にお答えいただいています。` : undefined,
      actions: [
        {
          key: 'keep', label: '回答済の問診を記憶して中止する',
          note: '次に開いたとき、続きから再開できます', icon: 'save', tone: 'primary',
        },
        {
          key: 'clear', label: '回答を全てクリアして中止する',
          note: 'ここまでの回答は削除されます', icon: 'ban', tone: 'danger',
        },
        { key: 'back', label: '問診に戻る', icon: 'prev' },
      ],
    });

    if (picked === 'keep') {
      persistProgress();
      stopLive();
      appendMessage({ role: 'system', text: '問診を中止しました。次に開いたとき、続きから再開できます。', ts: Date.now() });
      saveChatSession(session);
      return;
    }
    if (picked === 'clear') {
      stopLive();
      clearInterviewProgress(SESSION_ID);
      clearChatSession(SESSION_ID);
      clearInterviewResult(SESSION_ID);
      session = createEmptySession(SESSION_ID);
      currentQ = null;
      advancing = false;
      lastAnswered = null;
      renderLastAnswer();
      engine.reset();
      refs.resumeBanner && (refs.resumeBanner.hidden = true);
      renderHistory();
      renderProgress(0, '準備中…');
      renderSectionDots(-1);
      refs.questionText.textContent = '…';
      showWidget('voice');
      return;
    }
    // 'back' / null: 問診に戻る。選択画面を開いていたなら開き直す。
    if (picked === 'back' || picked === null) {
      if (currentQ && mapKind(currentQ.answer_kind) === 'list') void openListForCurrent();
    }
  }

  /*
   * マイク ON/OFF。**ここが micGate.toggle() の唯一の呼び出し元**
   * (利用者の操作以外でマイクの状態を変えない)。
   */
  refs.micGateBtn.addEventListener('click', () => micGate.toggle());

  // スピーカー ON/OFF（AI の音声出力のみ。テキスト/UI は影響なし）
  refs.speakerBtn.addEventListener('click', () => {
    muted = !muted;
    refs.speakerBtn.classList.toggle('muted', muted);
    refs.speakerBtn.setAttribute('aria-label', muted ? '音声 OFF（クリックでON）' : '音声 ON（クリックでOFF）');
    if (muted) {
      // 再生途中の音声を即座に止める
      audio.flushPlayback();
    }
  });

  async function toggleSession(): Promise<void> {
    if (liveSession) {
      stopLive();
      return;
    }
    if (connecting) return;
    /*
     * **前回の選択を持ち越さない** (静かな部屋と電車では答えが違う)。
     * 開始のタップに紐づく操作なので、ここも利用者の操作の内。
     */
    micGate.resetToOn();
    connecting = true;
    setStatus('接続中…');
    refs.startBtn.disabled = true;
    refs.micBtn.disabled = true;
    try {
      await startLive();
    } catch (err) {
      setStatus(`接続失敗: ${describeErr(err)}`);
      appendMessage({ role: 'system', text: `接続失敗: ${describeErr(err)}`, ts: Date.now() });
      stopLive();
    } finally {
      connecting = false;
      refs.startBtn.disabled = false;
      refs.micBtn.disabled = false;
    }
  }

  /*
   * 音声 / テキストの切替トグルは撤去した (発注者指示 2026-09-04)。
   * 音声・選択肢タップ・自由入力は「別モード」ではなく並列の回答手段で、
   * 音声は常時オン。よって切り替える対象が無い。
   */



  // list (選択肢モーダル)
  refs.listOpen.addEventListener('click', () => void openListForCurrent());
  // matrix (項目 × 頻度)
  refs.matrixOpen.addEventListener('click', () => void openMatrixForCurrent());

  // slider
  refs.sliderInput.addEventListener('input', () => {
    refs.sliderValue.textContent = refs.sliderInput.value;
  });
  refs.sliderSubmit.addEventListener('click', () => {
    submitAnswer(`${refs.sliderInput.value} / 10`);
  });

  // stepper
  refs.stepperMinus.addEventListener('click', () => stepStep(-1));
  refs.stepperPlus.addEventListener('click', () => stepStep(+1));
  refs.stepperSubmit.addEventListener('click', () => {
    const unit = refs.stepperUnit.textContent ?? '';
    submitAnswer(`${refs.stepperValue.textContent}${unit}`);
  });

  // free text
  refs.textSubmit.addEventListener('click', () => {
    const t = refs.textInput.value.trim();
    if (!t) return;
    refs.textInput.value = '';
    submitAnswer(t);
  });
  // 改行キーで回答を確定する (身長・体重のような 1 行の入力で「送信」まで指を運ばせない)。
  // 改行を入れたいときは Shift+Enter。Cmd/Ctrl+Enter も従来どおり確定。
  // ※ iOS の数字キーパッドには改行キーが無いため、その環境では「送信」ボタンが確定手段になる。
  //   だから送信ボタンは残す (実機で要確認)。
  refs.textInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.shiftKey) return; // 改行
    // IME 変換中の Enter は確定操作なので拾わない
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    refs.textSubmit.click();
  });

  // fallback (常時併設) — 自由入力、質問にしばられず会話可能
  refs.fallbackSend.addEventListener('click', () => sendFallback());
  refs.fallbackInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      sendFallback();
    }
  });

  // skip
  refs.skipBtn.addEventListener('click', () => submitAnswer('スキップします'));

  // 直前の回答を訂正する (確認バー)
  refs.lastAnswerEdit.addEventListener('click', () => startCorrection());

  // ── ヘルパ ──────────────────────────────────────

  function setStatus(text: string): void {
    refs.status.textContent = text;
  }

  function setConnected(state: boolean): void {
    refs.startHero.hidden = state;
    refs.qaArea.hidden = !state;
    // ラベル・アイコンは markup 側 (chat.astro の AppIcon) が正。
    // ここで textContent を書き換えると SVG が消えて絵文字に戻ってしまうので触らない。
    refs.micBtn.classList.toggle('active', state);
    refs.micBtn.setAttribute('aria-label', '問診を中止');
  }

  /** 設問に応じたウィジェットを出す。モード概念は無い (音声は常時オン)。 */
  function applyModeUI(): void {
    showWidget(currentQ ? mapKind(currentQ.answer_kind) : 'voice');
  }

  function mapKind(k?: string): WidgetKey {
    switch (k) {
      // 選択式はすべて同じ選択画面 (件数と収まりでレイアウトが決まる)
      case 'chip':
      case 'multi':
      case 'list': return 'list';
      case 'matrix': return 'matrix';
      case 'slider': return 'slider';
      case 'stepper': return 'stepper';
      case 'text': return 'text';
      default: return 'voice';
    }
  }

  type WidgetKey = 'voice' | 'list' | 'matrix' | 'slider' | 'stepper' | 'text';

  function showWidget(key: WidgetKey): void {
    const map: Record<WidgetKey, HTMLElement> = {
      voice: refs.uiVoice,
      list: refs.uiList,
      matrix: refs.uiMatrix,
      slider: refs.uiSlider,
      stepper: refs.uiStepper,
      text: refs.uiText,
    };
    for (const [k, el] of Object.entries(map)) {
      el.hidden = k !== key;
    }
    // 自由記述 widget が出ているときは補助テキスト入力を非表示（重複防止）
    refs.fallbackZone.hidden = key === 'text';
    /*
     * 音声ガイダンスは**常設** (発注者指示 2026-09-04)。設問が出ている間はいつでも
     * 声で答えられるので、ウィジェットの種類で出し分けない。
     * 隠すのは「質問がまだ無い待機中 (key==='voice')」のときだけ。
     */
    widgetKey = key;
    updateVoiceGuide();
  }

  function stepStep(delta: number): void {
    const cur = parseInt(refs.stepperValue.textContent ?? '0', 10) || 0;
    const max = parseInt(refs.stepperValue.dataset.max ?? '99', 10);
    const next = Math.max(0, Math.min(max, cur + delta));
    refs.stepperValue.textContent = String(next);
  }


  /** その設問が複数選択か (chip=常に単一 / multi=常に複数 / list は q.multi 次第)。 */
  function isMultiQ(q: QuestionDef): boolean {
    return q.answer_kind === 'multi' || (q.answer_kind === 'list' && !!q.multi);
  }

  /** その設問の選択肢 (chip / multi / list で置き場所が違うだけ)。 */
  function optionsOf(q: QuestionDef): ChoiceOption[] {
    if (q.answer_kind === 'chip') return q.chips ?? [];
    if (q.answer_kind === 'multi') return q.multi_options ?? [];
    return q.list_options ?? [];
  }

  /**
   * 現在の選択式設問で選択画面を開く (chip / multi / list 共通)。
   * レイアウト (ボトムシート / 全画面 / 全画面+検索) は件数と収まり具合から
   * choice-picker が決める。呼び出し側は指定しない。
   */
  async function openListForCurrent(): Promise<void> {
    const q = currentQ;
    if (!q || mapKind(q.answer_kind) !== 'list') return;
    const multi = isMultiQ(q);
    const initial = multi
      ? (engine.getAnswers()[q.id] as string[] | undefined) ?? []
      : [];
    const result = await openListPicker({
      title: q.list_title ?? q.multi_title ?? q.question,
      options: optionsOf(q),
      multi,
      initial,
      // 選択画面は画面を覆うため、上部の中止ボタンが隠れる。ここからも中止できるようにする。
      onAbort: () => void confirmAbort(),
      // 同じ理由で、直前の回答の確認バーもモーダルの中へ持ち込む
      // (これが無いと、回答した直後に選択画面が開いて確認バーごと隠れる)。
      lastAnswer: lastAnswered
        ? { text: lastAnswered.text, onEdit: () => startCorrection() }
        : null,
    });
    if (result === null) return; // キャンセル
    if (multi) {
      submitAnswer(result.length === 0 ? 'なし' : result.join('、'));
    } else {
      if (result.length === 0) return;
      submitAnswer(result[0]);
    }
  }

  /** 現在の matrix 設問でマトリクス選択モーダルを開く */
  async function openMatrixForCurrent(): Promise<void> {
    const q = currentQ;
    if (!q || q.answer_kind !== 'matrix') return;
    const result = await openMatrixPicker({
      title: q.question,
      rows: q.matrix_rows ?? [],
      cols: q.matrix_cols ?? [],
      onAbort: () => void confirmAbort(),
    });
    if (result === null) return;
    submitAnswer(formatMatrix(result));
  }

  /** 確認バーの表示を `lastAnswered` に合わせる。 */
  function renderLastAnswer(): void {
    if (!lastAnswered) {
      refs.lastAnswer.hidden = true;
      refs.lastAnswerText.textContent = '';
      return;
    }
    refs.lastAnswerText.textContent = lastAnswered.text;
    refs.lastAnswer.hidden = false;
  }

  /**
   * 直前の回答をやり直す (訂正)。
   *
   * **1 問だけ戻す**。engine が回答を消して `currentId` を戻すので、以降の分岐は
   * 通常どおり engine が再計算する (画面側で分岐を持たない)。
   * 戻したあとは通常の設問表示と同じ経路を通るので、**読み上げ対象と表示は
   * 必ず同一 Question ID** のまま (状態機械も ID 照合も足していない)。
   */
  function startCorrection(): void {
    const target = lastAnswered;
    if (!target) return;
    const q = engine.rewindTo(target.qid);
    if (!q) return; // 供給済み設問など、戻せないものは何もしない
    lastAnswered = null;
    renderLastAnswer();
    closeAllPickers();
    persistProgress();
    applyQuestionToUI(q);
    sendModelTurn(
      `ユーザーが直前の回答を訂正します。次の質問をもう一度自然に読み上げてください: 「${speechOf(q)}」
ユーザーの回答を復唱しないでください。選択肢も読み上げないでください (画面に表示されています)。`,
      q.id,
    );
  }

  /**
   * ユーザー回答を受けて engine から次の Q を決定し、画面を即更新する。
   * AI には「次の質問の読み上げ (+任意のセクション導線)」だけ依頼する。復唱はしない。
   * AI に「次の質問は何か」は伝えず、質問を発話させない。
   */
  function submitAnswer(rawAnswer: string, opts: { silent?: boolean } = {}): void {
    if (!rawAnswer) return;
    const cq = currentQ;
    if (!cq) {
      // 未開始時は単純に AI へ渡す (例: 「リセット後の自由発話」)
      if (!opts.silent) appendMessage({ role: 'user', text: rawAnswer, ts: Date.now() });
      sendUserText(rawAnswer);   // 利用者の発話。発話命令に混ぜない (§6.1.3)
      return;
    }

    // 音声回答 (silent) は transcript バブルが既に出ているので二重表示しない
    if (!opts.silent) appendMessage({ role: 'user', text: rawAnswer, ts: Date.now() });

    // 受付〜次設問表示までは音声の二重取り込みを止める
    advancing = true;
    // 開いているモーダル (選択画面/マトリクス) を閉じる
    closeAllPickers();

    trace('ANSWER_COMMIT', cq.id, { voice: !!opts.silent });
    const answerValue = toAnswerValue(cq, rawAnswer);
    const { next, isComplete } = engine.recordAndAdvance(answerValue);
    // 確認バーは**次に答えるまで消さない** (選択画面が覆っても回答が視界に残る)。
    lastAnswered = { qid: cq.id, text: rawAnswer };
    renderLastAnswer();
    // 1 問ごとに途中経過を退避しておく。中止ボタンを押さずに離脱 (タブを閉じる・
    // 通信断・リロード) しても続きから再開できるようにするため。
    persistProgress();

    if (isComplete || !next) {
      // 完走したら途中経過は不要 (次回は最初から)。結果は saveInterviewResult 側で残る。
      clearInterviewProgress(SESSION_ID);
      showCompletion();
      // 音声回答 (silent) では発話を注入しない。Live API の自発応答が唯一の話者。
      // (発話注入すると二重話者=二重復唱になる。§AI問診_仕様と設計原則 案1)
      if (!opts.silent) {
        sendModelTurn(`ユーザーが最後の質問「${cq.question}」に「${rawAnswer}」と回答し、これで全問終了です。「お疲れさまでした、ご協力ありがとうございました」と温かく一言だけお願いします。質問は絶対に発話しないでください。`, cq.id);
      }
      return;
    }

    const sectionChanged = cq.section_id !== next.section_id;

    /*
     * ━━ AI は質問だけを読み上げる (発注者指示 2026-09-04・仕様と設計原則 §4) ━━
     *
     * 復唱 (「『週3回』ですね、ありがとうございます」) は **音声・タップとも行わない**。
     * 回答の確認は**この画面表示**が担う。確認の聞き返しも実装しない。
     *
     * これで 2 つの積年の問題が同時に消える:
     *   ① **silent 分岐が消える** — 依頼文が音声・タップで同一になり、出し分けが無くなる
     *      (§3 の禁止事項。過去 3 回 revert されている)
     *   ② **先行表示が消える** — AI が喋るのは「次の質問」だけなので、画面を先に次の質問へ
     *      切り替えれば**読み上げ対象と表示は必ず同一 Question ID**。
     *      旧 `schedulePendingQuestion` は「AI 音声の最初の chunk」または「2 秒」で次の Q を
     *      描画していた = **復唱の *開始* で画面を次の質問に変えていた**のが直接原因だった。
     *      UI を音声に結合させない。状態機械も ID 照合も足さない。
     */
    refs.questionText.textContent = `✅ 「${rawAnswer}」で承りました`;
    refs.skipBtn.hidden = true;

    // ① 先に画面を次の質問へ。これが「読み上げ対象」と一致する唯一の質問になる。
    applyQuestionToUI(next);

    // ② そのうえで、同じ質問を AI に読ませる。依頼は音声・タップで同一 (出し分けない)。
    //    選択肢は読み上げさせない (画面に出ているため重複になる)。
    const msg = sectionChanged
      ? `次のセクション「${next.section_title}」に進みます。
発話手順 (2 文):
  ① 「次は${next.section_title}についてお伺いしますね」
  ② 続けて次の質問を自然に読み上げ: 「${speechOf(next)}」
ユーザーの回答を復唱しないでください。選択肢も読み上げないでください (画面に表示されています)。`
      : `次の質問を自然に読み上げてください: 「${speechOf(next)}」
ユーザーの回答を復唱しないでください。選択肢も読み上げないでください (画面に表示されています)。`;
    sendModelTurn(msg, next.id);
  }

  /*
   * `schedulePendingQuestion` / `audioFirstChunkResolvers` は撤去した
   * (発注者指示 2026-09-04)。**UI を音声に結合させない。**
   * 次の質問は回答確定と同時に描画する (submitAnswer 内)。
   */

  /** UI に入る生文字列を engine が扱える型に変換 */
  function toAnswerValue(q: QuestionDef, raw: string): AnswerValue {
    if (isMultiQ(q)) {
      return raw.split('、').map((s) => s.trim()).filter(Boolean);
    }
    if (q.answer_kind === 'slider') {
      const m = /(-?\d+(?:\.\d+)?)/.exec(raw);
      return m ? Number(m[1]) : (q.slider_min ?? 1);
    }
    return raw;
  }

  /**
   * 音声 transcript を現在設問の回答として取り込む。
   * 選択式は選択肢へマッチング、自由記述は transcript をそのまま採用する。
   */
  function maybeHandleVoiceAnswer(transcript: string): void {
    if (advancing) return; // 受付処理中は無視 (二重取り込み防止)
    const q = currentQ;
    if (!q) return;
    const ans = interpretVoiceAnswer(q, transcript);
    if (ans != null) { commitVoiceAnswer(ans); return; }
    /*
     * 決定論で当たらなかった (発注者指示 2026-09-18)。
     * **言い方が違うだけ**のことが多いので、選択肢の中から**推論させる**。
     * 例: 「多分ない」「ないと思う」「ない、けど」→ 否定の選択肢。
     * 確度が低ければ採らず、**聞き直す**。黙って無視しない。
     */
    if (!isChoiceQ(q)) return;
    void resolveVoiceByLlm(q, transcript);
  }

  function commitVoiceAnswer(ans: string | string[]): void {
    if (Array.isArray(ans)) {
      submitAnswer(ans.length ? ans.join('、') : 'なし', { silent: true });
    } else {
      submitAnswer(ans, { silent: true });
    }
  }

  /** 選択式か (推論に回してよい設問か)。自由記述・スライダー・マトリクスは対象外。 */
  function isChoiceQ(q: QuestionDef): boolean {
    return optionsOf(q).length > 0 && mapKind(q.answer_kind) === 'list';
  }

  /**
   * 選択肢の中から推論させる。**Live セッションには一切触らない** —
   * サーバ側の 1 回きりの呼び出しで番号だけを受け取り、発話はいつもどおり依頼文で頼む。
   *
   * **決められなければ回答にしない。** 聞き直しの一言を頼んで、画面のタップを待つ。
   */
  async function resolveVoiceByLlm(q: QuestionDef, transcript: string): Promise<void> {
    const labels = optionsOf(q).map((o) => o.label);
    let index: number | null = null;
    try {
      const res = await fetch('/api/interview/classify-voice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q.question, options: labels, transcript }),
      });
      if (res.ok) {
        const data = (await res.json()) as { index?: number | null };
        if (typeof data.index === 'number' && data.index >= 0 && data.index < labels.length) {
          index = data.index;
        }
      }
    } catch { /* 通信断。下の聞き直しへ倒す */ }

    // 待っている間に設問が変わっていたら捨てる (古い回答を今の設問に入れない)
    if (currentQ?.id !== q.id || advancing) return;

    if (index != null) {
      trace('VOICE_LLM_PICK', q.id, { index });
      commitVoiceAnswer(isMultiQ(q) ? [labels[index]] : labels[index]);
      return;
    }
    trace('VOICE_LLM_UNCLEAR', q.id);
    askToRepeat(q);
  }

  /**
   * 聞き直しは **1 問につき 1 回まで**。テレビの音などを拾い続けると、
   * 「聞き取れませんでした」を延々と喋る AI になるため (マイク OFF との併用が前提)。
   */
  const askedRepeat = new Set<string>();

  /** 聞き取れなかったことを伝えて、もう一度か、タップをお願いする (発注者指示の文言)。 */
  function askToRepeat(q: QuestionDef): void {
    if (askedRepeat.has(q.id)) return;
    askedRepeat.add(q.id);
    sendModelTurn(
      `利用者の回答が聞き取れませんでした。次の 1 文だけを発話してください: `
      + `「申し訳ありません、聞き取れませんでした。画面の選択肢をご確認のうえ、もう一度お答えいただくか、選択肢をタップしてください」`
      + `。質問文は読み上げないでください。`,
      q.id,
    );
  }

  /** transcript を設問種別ごとに解釈。マッチしなければ null (タップ待ち) */
  function interpretVoiceAnswer(q: QuestionDef, transcript: string): string | string[] | null {
    if (!transcript.trim()) return null;

    if (q.answer_kind === 'text') {
      // 自由記述は発話をそのまま回答に採用 (元の transcript を保持)
      return transcript.trim();
    }

    if (q.answer_kind === 'slider') {
      const min = q.slider_min ?? 1;
      const max = q.slider_max ?? 10;
      const m = /(-?\d+)/.exec(transcript);
      if (!m) return null;
      const n = Math.max(min, Math.min(max, Number(m[1])));
      return String(n);
    }

    if (q.answer_kind === 'matrix') {
      return null; // マトリクスはタップ操作のみ
    }

    /*
     * **選択肢への当てはめは、ここでは一切しない** (発注者指示 2026-09-18:
     * 「極力 LLM に判断させて。パターンマッチング的なことは絶対にやらないで」)。
     *
     * 文字の一致・部分一致・同義語表は**持たない**。言い方の揺れ
     * (「ない」「なし」「特にない」「多分ない」「ないと思う」「ない、けど」…) を
     * 表で数え上げるのは、書いた分しか当たらず、書き漏らすと黙って落ちる。
     * → `resolveVoiceByLlm` が選択肢の中から推論する。
     */
    return null;
  }

  function sendFallback(): void {
    const t = refs.fallbackInput.value.trim();
    if (!t) return;
    refs.fallbackInput.value = '';
    appendMessage({ role: 'user', text: t, ts: Date.now() });
    sendUserText(t);   // フォールバック入力は利用者の発話 (§6.1.3)
    presentQuestionCalledThisTurn = false;
  }

  // AI が tool 呼び忘れで質問だけしてきた時のヒント表示
  function flashFallback(): void {
    refs.fallbackZone.hidden = false;
    refs.fallbackInput.placeholder = 'AI の質問にお答えください（音声でもOK）';
    refs.fallbackInput.classList.add('ring-2', 'ring-amber-400', 'border-amber-400');
    refs.fallbackInput.focus();
    setTimeout(() => {
      refs.fallbackInput.classList.remove('ring-2', 'ring-amber-400', 'border-amber-400');
    }, 2400);
  }

  /**
   * **読み上げに渡す文。** `speech` があればそれを使う (無ければ質問文そのまま)。
   * 画面と納品 JSON は `question` のままで、**変わるのは音声だけ**。
   * `（cm）` を読ませると LLM が「シーエム」と読むため (実機報告 2026-09-17)。
   */
  function speechOf(q: QuestionDef): string {
    return q.speech ?? q.question;
  }

  /**
   * **プログラム → モデルへの発話命令** (正本 §6.1.1・2026-09-17 確定)。
   *
   * `sendClientContent` は**順序が保証され**、`turnComplete: true` は
   * **前の生成を無条件に中断する** (3.1 のモデルページに明記)。
   * これで「画面は次の質問なのに音声は前の質問」が構造的に消える。
   *
   * 以前は `sendRealtimeInput({ text })` で送っていた。あれは**非対応ではない**が
   * 「応答性を優先し確定的な順序を犠牲にする」経路なので、**確定した発話命令には不適切**だった。
   * しかも 1 問目だけ `sendClientContent` という食い違いがあった。
   *
   * **これはプログラムによるターン制御ではない** — 禁じているのは独自の状態機械・
   * マイクゲート・silent 分岐であって、Live API 公式のターン境界を使うことは許容 (§6.1.2)。
   */
  function sendModelTurn(text: string, qid?: string | null): void {
    if (!liveSession) {
      appendMessage({
        role: 'system',
        text: 'まず🎙ボタンで問診セッションを開始してください。',
        ts: Date.now(),
      });
      return;
    }
    trace('MODEL_TURN_SEND', qid ?? null);
    liveSession.sendClientContent({
      turns: [{ role: 'user', parts: [{ text }] }],
      turnComplete: true,
    });
  }

  /**
   * **利用者が入力したテキスト**。発話命令と同じ経路に載せない (§6.1.3)。
   *
   * `sendClientContent(turnComplete: true)` に載せると**入力しただけで読み上げが切れる**
   * (無条件に中断するため)。こちらは従来どおり realtime 入力のまま。
   */
  function sendUserText(text: string): void {
    if (!liveSession) {
      appendMessage({
        role: 'system',
        text: 'まず🎙ボタンで問診セッションを開始してください。',
        ts: Date.now(),
      });
      return;
    }
    liveSession.sendRealtimeInput({ text });
  }

  // ── Live API 接続 ──────────────────────────────

  async function startLive(): Promise<void> {
    const res = await fetch('/api/live-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ diagnosticUserId: refs.diagnosticUserId ?? null }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`token mint ${res.status}: ${body}`);
    }
    const { token, model, userContext, userProfile: fetchedProfile, examTypes } = (await res.json()) as {
      token: string;
      model: string;
      userContext?: string | null;
      userProfile?: { name: string | null; dateOfBirth: string | null; sex: string | null } | null;
      examTypes?: string[] | null;
    };
    // 氏名・生年月日・性別は問診で尋ねない。内部取得値を結果へ付与するため保持する。
    userProfile = fetchedProfile ?? null;
    // 今回実施検査 (EXAM-TYPE) も申込情報から供給し、問診では尋ねない (A案)。
    seededExamTypes = Array.isArray(examTypes) ? examTypes.filter((x) => typeof x === 'string') : [];

    // NOTE: userContext 注入は AI ループの原因となったため一時 OFF。
    // 後で再有効化する場合は連結ロジックを再設計する。
    void userContext;
    const instruction = SYSTEM_INSTRUCTION;

    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
    liveSession = await ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: { parts: [{ text: instruction }] },
        speechConfig: { languageCode: 'ja-JP' },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // VAD / barge-in は LLM (サーバ) 側に委ねる:
        //   - automaticActivityDetection: 既定 ON のまま (ユーザー回答の終端検出には必要)
        //   - activityHandling: NO_INTERRUPTION で AI 発話中の barge-in を抑止
        //     (周辺ノイズで AI 発話が途中で切れる現象を防ぐ)
        realtimeInputConfig: {
          activityHandling: ActivityHandling.NO_INTERRUPTION,
        },
        // engine 駆動で tool calling は使わない → tools フィールド自体を渡さない
      },
      callbacks: {
        onopen: () => {
          setStatus('🎙 接続済 — 話せます / タップ可');
          setConnected(true);
          // engine 起動: 最初の Q を画面に即表示 (AI を待たない)
          // EXAM-TYPE は申込情報から供給し設問を提示しない (空なら通常設問にフォールバック)。
          //
          // 「回答済の問診を記憶して中止する」で退避した途中経過があれば**続きから**再開する
          // (発注者指示 2026-08)。復元できなければ通常どおり最初から。
          const saved = loadInterviewProgress(SESSION_ID);
          const resumedQ = saved ? engine.resume(saved) : null;
          const isResume = resumedQ !== null;
          const firstQ = resumedQ ?? engine.start(
            seededExamTypes.length > 0 ? { 'EXAM-TYPE': seededExamTypes } : {},
          );
          applyQuestionToUI(firstQ);
          const answeredCount = isResume ? Object.keys(engine.getAnswers()).length : 0;
          if (isResume) {
            appendMessage({
              role: 'system',
              text: `前回の続きから再開します（回答済 ${answeredCount} 問）。`,
              ts: Date.now(),
            });
            saveChatSession(session);
          }
          // AI には「挨拶 + 次の質問の読み上げ」だけを依頼
          setTimeout(() => {
            try {
              // **1 問目も 2 問目以降と同じ経路** (以前はここだけ別だった・§6.1.1)。
              sendModelTurn(
                  `問診を始めます。次の 2 文を発話してください:
  ① ${isResume
                    ? '「おかえりなさい。前回の続きから問診を再開します。」'
                    : '「こんにちは、ウェルフォートの AI 問診です。画面の質問に、タップでも音声でもお答えいただけます。」'}
  ② 続けて画面に表示されている質問を読み上げ: 「${speechOf(firstQ)}」
選択肢や入力例は読み上げないでください (画面に表示されています)。挨拶と質問を 1 回だけ、絶対に繰り返さないでください。`,
                firstQ.id,
              );
            } catch {}
          }, 250);
        },
        onmessage: (msg) => handleServerMessage(msg),
        onerror: (e) => {
          const m = (e as { message?: string })?.message ?? String(e);
          setStatus(`エラー: ${m}`);
          appendMessage({ role: 'system', text: `サーバエラー: ${m}`, ts: Date.now() });
        },
        onclose: (e) => {
          const reason = (e as { reason?: string })?.reason;
          setStatus(reason ? `切断: ${reason}` : '切断');
          liveSession = null;
          setConnected(false);
        },
      },
    });

    await audio.start((b64) => {
      if (!liveSession) return;
      liveSession.sendRealtimeInput({
        audio: { data: b64, mimeType: 'audio/pcm;rate=16000' },
      });
    });
  }

  function stopLive(): void {
    audio.stop();
    try { liveSession?.close(); } catch {}
    liveSession = null;
    setConnected(false);
    setStatus('停止');
  }

  // ── サーバメッセージ ────────────────────────────

  function handleServerMessage(msg: LiveServerMessage): void {
    // 1) PCM 音声 chunk → 再生（muted 中はスキップ）。
    //    VAD / echo / barge-in は Live API サーバ側が処理するため、ここで mic を
    //    gating しない（barge-in が壊れる）。
    const parts = msg.serverContent?.modelTurn?.parts ?? [];
    for (const p of parts) {
      const mime = p.inlineData?.mimeType ?? '';
      const data = p.inlineData?.data;
      if (data && mime.startsWith('audio/pcm') && !muted) {
        if (!sawAudioThisTurn) { sawAudioThisTurn = true; trace('AUDIO_FIRST_CHUNK', currentQ?.id ?? null); }
        // 音声は再生するだけ。**UI 遷移のトリガにしない** (2026-09-04)。
        // 以前はここで「次の質問」を描画しており、復唱の開始で画面が先へ進んでいた。
        audio.playPcm(data);
      }
    }

    // 2) ストリーミング transcript (入力 = ユーザー)
    const inText = msg.serverContent?.inputTranscription?.text;
    if (inText) {
      /*
       * **マイクが何か拾ったこと自体**を記録する (中身は記録しない = 医療情報)。
       * 依頼していない発話 (実測 2026-09-17: 依頼の無い AUDIO_FIRST_CHUNK) が、
       * **マイクが拾った音に対する応答なのか、モデルが勝手に喋ったのか**を切り分けるため。
       */
      if (!sawInputThisTurn) { sawInputThisTurn = true; trace('INPUT_ACTIVITY', currentQ?.id ?? null); }
      userBuf += inText;
      ensureStreamBubble('user').textContent = userBuf;
      refs.log.scrollTop = refs.log.scrollHeight;
    }
    // (出力 = AI) — cleanTranscript で関数呼び出し漏れを除去してから表示
    const outText = msg.serverContent?.outputTranscription?.text;
    if (outText) {
      assistantBuf += outText;
      ensureStreamBubble('assistant').textContent = cleanTranscript(assistantBuf);
      refs.log.scrollTop = refs.log.scrollHeight;
    }

    // 3) turn 完了で確定
    if (msg.serverContent?.turnComplete) {
      trace('TURN_COMPLETE', currentQ?.id ?? null);
      sawAudioThisTurn = false;
      sawInputThisTurn = false;
      const cleanedAssistant = cleanTranscript(assistantBuf);
      const finishedUser = userBuf.trim();
      finalizeStream('user', userBuf);
      finalizeStream('assistant', assistantBuf);
      userBuf = '';
      assistantBuf = '';

      // 音声回答 → 選択肢へマッチングして engine に反映 (タップと等価)
      if (finishedUser) maybeHandleVoiceAnswer(finishedUser);

      // ループ検出: 直近 10 秒以内に同じ発話を完了したら重複カウント
      const now = Date.now();
      const isDuplicate =
        cleanedAssistant.length > 10 &&
        cleanedAssistant === lastFinalizedAssistant &&
        now - lastFinalizedAssistantAt < 15_000;
      if (isDuplicate) {
        duplicateAssistantCount += 1;
      } else {
        duplicateAssistantCount = 0;
        lastFinalizedAssistant = cleanedAssistant;
        lastFinalizedAssistantAt = now;
      }

      // 重複 2 回 (合計 3 回同じ発話) でセッション切断 — AI の発話ループから抜けるため
      if (duplicateAssistantCount >= 2) {
        appendMessage({
          role: 'system',
          text: '⚠️ AI が同じ質問を繰り返しているため、セッションを自動切断しました。「リセット」ボタンで再開してください。',
          ts: Date.now(),
        });
        setStatus('🔌 自動切断 — リセットして再開してください');
        stopLive();
        duplicateAssistantCount = 0;
        lastFinalizedAssistant = '';
        return;
      }

      // engine 駆動なので AI 発話に対する fallback / present_question 推定は不要。
      // (重複発話の自動切断ガードは残してある — 上で処理済)
    }

    // 4) tool call (engine 駆動では使わないが、AI が誤って呼んだ場合のため response は返す)
    const calls = msg.toolCall?.functionCalls;
    if (calls && calls.length > 0 && liveSession) {
      const responses = calls.map((fc) => ({
        id: fc.id ?? '',
        name: fc.name ?? '',
        response: { result: 'ignored — engine 駆動で tool は廃止しました' },
      }));
      liveSession.sendToolResponse({ functionResponses: responses });
    }

    // 5) 割り込み
    if (msg.serverContent?.interrupted) {
      // サーバが「割り込んだ」と言ったときだけ捨てる (UI 起点の強制停止ではない)。
      trace('SERVER_INTERRUPTED', currentQ?.id ?? null);
      audio.flushPlayback();
      trace('AUDIO_FLUSH', currentQ?.id ?? null);
      sawAudioThisTurn = false;
    }

    if (msg.goAway) setStatus('まもなく切断（再接続してください）');
  }

  // 旧 handleFunctionCall (present_question / complete_interview / flag_emergency) は
  // engine 駆動化に伴い削除。tool 呼び出しは handleServerMessage の section 4 で
  // 一括 ignored 応答を返す。

  /** engine から受け取った Q を画面に反映する (engine 駆動の核) */
  function applyQuestionToUI(q: QuestionDef): void {
    trace('UI_APPLY', q.id);
    currentQ = q;
    advancing = false; // 次設問が出たので音声回答の受付を再開

    const percent = clamp(engine.currentPercent(), 0, 100);
    session.progress = percent;
    saveChatSession(session);
    renderProgress(percent, q.section_title);

    const sectionIdx = SECTIONS.findIndex((s) => s.id === q.section_id);
    renderSectionDots(sectionIdx);

    refs.questionText.textContent = q.question;
    refs.skipBtn.hidden = true; // engine 版ではスキップ未対応 (将来追加)

    const kind = mapKind(q.answer_kind);
    if (kind === 'list') {
      refs.listSummary.textContent = '';
      // アイコンは Lucide 一本 (絵文字を本番素材にしない)。
      refs.listOpen.innerHTML =
        `${iconSvg('check')}<span>${isMultiQ(q) ? '選択肢から選ぶ（複数可）' : '選択肢から選ぶ'}</span>`;
    } else if (kind === 'matrix') {
      refs.matrixSummary.textContent = '';
    } else if (kind === 'slider') {
      const min = q.slider_min ?? 1;
      const max = q.slider_max ?? 10;
      const mid = String(Math.round((min + max) / 2));
      refs.sliderInput.min = String(min);
      refs.sliderInput.max = String(max);
      refs.sliderLow.textContent = q.slider_low_label ?? '低い';
      refs.sliderHigh.textContent = q.slider_high_label ?? '高い';
      refs.sliderInput.value = mid;
      refs.sliderValue.textContent = mid;
    } else if (kind === 'text') {
      refs.textInput.value = '';
      refs.textInput.placeholder = q.placeholder ?? '自由にお答えください';
      refs.textInput.setAttribute('inputmode', q.numeric ? 'decimal' : 'text');
      // 改行キーのラベルを「完了」にして、押せば確定すると分かるようにする
      refs.textInput.setAttribute('enterkeyhint', 'done');
      // 1 行で足りる設問 (身長・体重など) は入力欄も 1 行にする
      refs.textInput.rows = q.numeric ? 1 : 2;
      if (q.example) {
        refs.textExample.textContent = `入力例：${q.example}`;
        refs.textExample.hidden = false;
      } else {
        refs.textExample.hidden = true;
      }
    }
    showWidget(kind);

    // 選択式は自動展開 (タップ一手間を省く)。単一選択はタップ 1 回で回答が確定するので、
    // インラインのカードだった頃とタップ数は変わらない。
    if (kind === 'list') {
      setTimeout(() => void openListForCurrent(), 150);
    } else if (kind === 'matrix') {
      setTimeout(() => void openMatrixForCurrent(), 150);
    } else if (kind === 'text') {
      // 身長・体重のような入力欄は**カーソルを置いた状態**で出す (発注者指示 2026-08)。
      // showWidget で hidden を外した直後だとフォーカスが乗らないので 1 フレーム待つ。
      // preventScroll: 会話ログが飛ばないように (入力欄は画面下部に固定表示されている)。
      requestAnimationFrame(() => {
        try { refs.textInput.focus({ preventScroll: true }); } catch { refs.textInput.focus(); }
      });
    }
  }

  /** 問診結果を S3 (Elith 連携) へ書き出す。テスト用・fire-and-forget。 */
  async function exportInterviewToS3(opts: {
    uid: string | null;
    answers: Record<string, AnswerValue>;
    completedAt: number;
  }): Promise<void> {
    try {
      await fetch('/api/interview/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          diagnosticId: getOrCreateDiagnosticId(),
          diagnosticUserId: opts.uid,
          userName: userProfile?.name ?? null,
          dateOfBirth: userProfile?.dateOfBirth ?? null,
          sex: userProfile?.sex ?? null,
          answers: opts.answers,
          completedAt: opts.completedAt,
        }),
      });
    } catch {
      /* テスト用途のため失敗は握りつぶす (UI を止めない) */
    }
  }

  /** 問診完了表示 + chat session を完了状態にして HealthInsightCard を起動 */
  function showCompletion(): void {
    currentQ = null;
    advancing = false;
    // 完走後は訂正できない (結果を書き出したあとなので、戻す先が無い)。
    lastAnswered = null;
    renderLastAnswer();
    renderProgress(100, '完了');
    renderSectionDots(SECTIONS.length);

    // 問診結果ファイルを生成。氏名・生年月日・性別は尋ねず、内部取得値を付与する。
    const uid = refs.diagnosticUserId?.trim() || null;
    const answers = engine.getAnswers();
    const completedAt = Date.now();
    saveInterviewResult({
      id: SESSION_ID,
      diagnosticUserId: uid,
      userName: userProfile?.name ?? null,
      dateOfBirth: userProfile?.dateOfBirth ?? null,
      sex: userProfile?.sex ?? null,
      answers,
      completedAt,
    });

    // S3 (Elith 連携) へ書き出し。スキャンと同じ diagnostic_id フォルダに同居させる。
    // テスト用途のため fire-and-forget (失敗してもUIは止めない)。
    void exportInterviewToS3({ uid, answers, completedAt });

    const dashUrl = uid ? `/dashboard?u=${encodeURIComponent(uid)}` : '/dashboard';

    refs.questionText.innerHTML = `
      <div class="flex flex-col items-center gap-3 py-2">
        <p class="text-center text-base font-semibold text-slate-800">
          ✨ お疲れさまでした、ご協力ありがとうございました。
        </p>
        <p class="text-center text-xs text-slate-600">
          ダッシュボードに「今日の気付き」が自動生成されます。
        </p>
        <a
          href="${dashUrl}"
          class="mt-1 inline-flex items-center gap-1 rounded-full bg-brand-600 px-5 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          📊 ダッシュボードで結果を見る ›
        </a>
      </div>
    `;
    showWidget('voice');
    session.progress = 100;
    saveChatSession(session);
    appendMessage({
      role: 'system',
      text: '✅ 問診完了 — ダッシュボードで「今日の気付き」をご確認ください。',
      ts: Date.now(),
    });
  }


  // ── 進捗 / セクション dots ───────────────────────

  /**
   * 進捗表記は **「問診完了まであと N%」** (発注者指示 2026-08)。
   * N は**残り**なので 100 - percent。バーの塗り (= 済み) と数字 (= 残り) で
   * 役割が分かれるため、単に「42%」と出していた頃より意味が読み取りやすい。
   * 完了時は「あと 0%」が不自然なので文言ごと切り替える。
   */
  function renderProgress(percent: number, sectionTitle: string): void {
    const left = clamp(100 - percent, 0, 100);
    refs.progressText.textContent = left <= 0 ? '問診完了' : `問診完了まであと ${left}%`;
    refs.sectionLabel.textContent = sectionTitle ? sectionTitle : '進行中…';
  }

  function renderSectionDots(currentIdx: number): void {
    sectionDotEls.forEach((dot, i) => {
      dot.classList.remove('done', 'current');
      if (i < currentIdx) dot.classList.add('done');
      else if (i === currentIdx) dot.classList.add('current');
    });
  }

  // ── ログ ────────────────────────────────────────

  function appendMessage(msg: ChatMessage): void {
    clearEmptyState();
    session.messages.push(msg);
    saveChatSession(session);
    renderMessage(msg);
    refs.log.scrollTop = refs.log.scrollHeight;
  }

  function renderHistory(): void {
    refs.log.innerHTML = '';
    if (session.messages.length === 0) {
      // 空状態のプレースホルダ
      const empty = document.createElement('div');
      empty.className = 'flex h-full flex-col items-center justify-center gap-2 py-6 text-center text-slate-400';
      empty.innerHTML = '<span class="text-4xl">💬</span><p class="text-xs">下の <span class="font-medium text-brand-600">🩺 問診を開始</span> ボタンから始めてください</p>';
      refs.log.appendChild(empty);
    } else {
      session.messages.forEach(renderMessage);
    }
    renderProgress(session.progress, '');
    refs.log.scrollTop = refs.log.scrollHeight;
  }

  // 初回メッセージ追加時に空状態を消す
  function clearEmptyState(): void {
    refs.log.querySelector('#chat-empty')?.remove();
  }

  function renderMessage(msg: ChatMessage): void {
    const wrap = document.createElement('div');
    wrap.className = 'flex w-full bubble-in';
    const bubble = document.createElement('div');
    bubble.className = bubbleClass(msg.role);
    if (msg.role === 'assistant') {
      bubble.classList.add('md-region');
      bubble.innerHTML = renderMarkdown(msg.text);
    } else {
      bubble.textContent = msg.text;
    }
    if (msg.role === 'user') wrap.classList.add('justify-end');
    if (msg.role === 'system') wrap.classList.add('justify-center');
    wrap.appendChild(bubble);
    refs.log.appendChild(wrap);
  }

  function ensureStreamBubble(role: 'assistant' | 'user'): HTMLElement {
    const existing = role === 'assistant' ? assistantStreamBubble : userStreamBubble;
    if (existing && existing.isConnected) return existing;
    clearEmptyState();
    const wrap = document.createElement('div');
    wrap.className = 'flex w-full bubble-in';
    if (role === 'user') wrap.classList.add('justify-end');
    const bubble = document.createElement('div');
    bubble.className = `${bubbleClass(role)} typing-caret`;
    bubble.textContent = '';
    wrap.appendChild(bubble);
    refs.log.appendChild(wrap);
    if (role === 'assistant') assistantStreamBubble = bubble;
    else userStreamBubble = bubble;
    return bubble;
  }

  function finalizeStream(role: 'assistant' | 'user', buf: string): void {
    const bubble = role === 'assistant' ? assistantStreamBubble : userStreamBubble;
    // AI 側は最終 transcript も cleanTranscript で関数呼び出し漏れを除去
    const cleaned = role === 'assistant' ? cleanTranscript(buf) : buf.trim();

    // 重複抑止: 直前メッセージと同 role + 同テキスト ならスキップ
    //   (echo loop で AI が同じ挨拶を繰り返した場合の保険)
    const lastMsg = session.messages[session.messages.length - 1];
    const isDup = cleaned && lastMsg && lastMsg.role === role && lastMsg.text === cleaned;

    if (!bubble) {
      if (cleaned && !isDup) appendMessage({ role, text: cleaned, ts: Date.now() });
      return;
    }
    bubble.classList.remove('typing-caret');
    if (!cleaned || isDup) {
      bubble.parentElement?.remove();
    } else {
      session.messages.push({ role, text: cleaned, ts: Date.now() });
      saveChatSession(session);
      if (role === 'assistant') {
        bubble.classList.add('md-region');
        bubble.innerHTML = renderMarkdown(cleaned);
      } else {
        bubble.textContent = cleaned;
      }
    }
    if (role === 'assistant') assistantStreamBubble = null;
    else userStreamBubble = null;
  }
}

/**
 * モデルが稀に関数呼び出しを音声で読み上げてしまった場合に備えた保険。
 * "call:present_question{...}" や "present_question(...)" を末尾まで除去する。
 * 本来はプロンプトで抑止しているが、漏れたものを表示しないためのセーフネット。
 */
function cleanTranscript(text: string): string {
  let out = text;
  // "call:" 以降を末尾まで除去（最も典型的な漏れパターン）
  out = out.replace(/\s*\bcall\s*:\s*[\s\S]*$/i, '');
  // 単独で "present_question{" や "present_question(" が出てきた場合も末尾まで除去
  out = out.replace(/\s*\bpresent_question\b\s*[\({][\s\S]*$/i, '');
  // "complete_interview" や "flag_emergency" が音声化されても同様に除去
  out = out.replace(/\s*\b(complete_interview|flag_emergency)\b\s*[\({][\s\S]*$/i, '');
  return out.trim();
}

function bubbleClass(role: ChatMessage['role']): string {
  const base = 'max-w-[82%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm shadow-sm';
  switch (role) {
    case 'user':
      return `${base} bg-brand-600 text-white`;
    case 'assistant':
      return `${base} bg-slate-100 text-slate-900`;
    case 'system':
    default:
      return `${base} bg-amber-100 text-amber-900`;
  }
}

function renderMarkdown(text: string): string {
  try {
    return marked.parse(text, { async: false }) as string;
  } catch {
    return escapeHtml(text);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 音声マッチング用の正規化。
 * NFKC 正規化 → 括弧書き / 記号 / 空白を除去 → 小文字化。
 * 例: 「ほぼ毎日（週5日以上）」→「ほぼ毎日」
 */
function describeErr(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;
    const name = err.name;
    // マイク権限関連: ユーザーに「何をすればよいか」を伝える
    if (name === 'NotAllowedError' || /permission/i.test(msg)) {
      return 'マイクの使用が許可されていません。\nブラウザの URL バーの 🎙 アイコンをタップ → 許可を選んでから再度お試しください。\n(iOS Safari の場合: 設定 → Safari → カメラ・マイクのアクセス → 確認 or 許可)';
    }
    if (name === 'NotFoundError' || /no .*device/i.test(msg)) {
      return 'マイクが見つかりません。マイクが接続されているか、他のアプリで占有されていないかご確認ください。';
    }
    if (name === 'NotReadableError') {
      return 'マイクが他のアプリで使用中です。他のアプリ (Zoom / Teams 等) を閉じてからお試しください。';
    }
    return msg;
  }
  return String(err);
}
