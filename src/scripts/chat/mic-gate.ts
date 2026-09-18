/**
 * AI問診 — マイクのオン / オフ (発注者指示 2026-09-17)。
 *
 * 【なぜ要るか】実機で **テレビの音をかなり拾う**。マイクは開始から中止まで
 * 送りっぱなしなので、周囲の音が「回答」として確定し得る。静かな場所を想定し、
 * それ以外は利用者が自分でマイクを切れるようにする。
 *
 * 【禁止事項に触れないこと・最重要】正本 `docs/interview/AI問診_仕様と設計原則.md`。
 * 禁じられているのは **プログラムが勝手にマイクをゲートすること**
 * (半二重ゲート・AI 発話中の送信停止・silent 分岐・独自の状態機械)。
 * ここは **利用者がボタンを押したときだけ**状態が変わる。
 * だから `toggle()` の呼び出し元は**クリックのハンドラ 1 か所だけ**で、
 * ターンの開始・終了、AI の発話、サーバのイベントからは**絶対に呼ばない**。
 * (`scripts/verify-interview-live-transport.mjs` が機械で見張る)
 *
 * 【切ったときに何が止まるか】**送るのをやめるだけ** (発注者判断 2026-09-17)。
 * 端末のマイクそのものは掴んだままにする = 戻すときに許諾ダイアログが出ない。
 * その代わり **iOS の録音インジケータは点いたまま**になる。
 */

/** マイクが生きているときの文言。ボタンの意味 (押すと切れる) をここが持つ。 */
export const MIC_GATE_NOTE_ON = '周囲の音を拾う場合、マイクをオフに';
/** 切ってあるときの文言。**行き止まりにしない**ので、代わりの回答手段を書く。 */
export const MIC_GATE_NOTE_OFF = 'マイクはオフです。タップで回答してください';

export interface MicGateRefs {
  /** 帯そのもの。オフでは `.off` が付いて色が落ちる。 */
  gate: HTMLElement;
  /** 帯の文言。状態で書き換わる。 */
  note: HTMLElement;
  /** 帯の右端のボタン (44×44)。 */
  button: HTMLButtonElement;
}

export interface MicGate {
  /** **利用者のタップからだけ**呼ぶ。プログラムから状態を動かさない。 */
  toggle(): void;
  /**
   * 問診を始めるときに「オン」へ戻す。
   * **持ち越さない** — 静かな部屋と電車では答えが違うので、前回の選択を引き継ぐと
   * 「話しても反応しない」を黙って起こす。
   */
  resetToOn(): void;
  isMuted(): boolean;
}

/**
 * @param onChange 状態が変わった直後に 1 回だけ呼ばれる。音声側の反映と記録はここで行う。
 */
export function createMicGate(refs: MicGateRefs, onChange: (muted: boolean) => void): MicGate {
  let muted = false;

  function render(): void {
    refs.gate.classList.toggle('off', muted);
    refs.note.textContent = muted ? MIC_GATE_NOTE_OFF : MIC_GATE_NOTE_ON;
    // アイコンだけのボタンなので、何が起きるかは aria-label が持つ (発注者裁定 A 案)。
    refs.button.setAttribute('aria-label', muted ? 'マイクをオンにする' : 'マイクをオフにする');
  }

  function set(next: boolean): void {
    if (next === muted) return;
    muted = next;
    render();
    onChange(muted);
  }

  render();

  return {
    toggle: () => set(!muted),
    resetToOn: () => set(false),
    isMuted: () => muted,
  };
}
