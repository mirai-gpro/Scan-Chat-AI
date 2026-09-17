/**
 * Live API audio I/O:
 * - Input:  mic (browser native rate) → downsample → 16kHz Int16 mono → Uint8Array
 * - Output: server 24kHz PCM mono → AudioBuffer 連結再生
 *
 * iPhone Safari 互換のため ScriptProcessorNode を使用（AudioWorklet は別ファイル必要で煩雑）。
 *
 * VAD / echo / barge-in は Gemini Live API のサーバー側で処理される（公式既定）。
 * クライアントで mic を gating すると barge-in が壊れるので、ここでは常時送信する。
 * 参考: https://ai.google.dev/gemini-api/docs/live-guide
 *       (realtimeInputConfig.automaticActivityDetection はデフォルト ON)
 */

import { trace } from './live-trace';

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const PROCESS_BUFFER_SIZE = 4096;

export type AudioChunkHandler = (base64Pcm16: string) => void;
export type PlaybackEndHandler = () => void;

export class LiveAudioManager {
  private inputCtx: AudioContext | null = null;
  private outputCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private nextPlaybackTime = 0;
  private playingSources = new Set<AudioBufferSourceNode>();
  private onChunk: AudioChunkHandler = () => {};
  private onPlaybackEnd: PlaybackEndHandler = () => {};
  private inputMuted = false;

  /** マイク入力を一時停止/再開。AI 発話中に VAD 誤検出 (周辺ノイズで interrupted) を防ぐ用途。 */
  setInputMuted(muted: boolean): void {
    this.inputMuted = muted;
  }

  /** AI の音声再生が完全に終わった時のコールバックを登録 */
  setOnPlaybackEnd(cb: PlaybackEndHandler): void {
    this.onPlaybackEnd = cb;
  }

  /** ユーザー操作（クリック等）の同期文脈で呼ぶこと（iOS の autoplay 制限対策） */
  async start(onChunk: AudioChunkHandler): Promise<void> {
    this.onChunk = onChunk;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.inputCtx = new AudioContext();
    this.outputCtx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    await this.inputCtx.resume();
    await this.outputCtx.resume();
    this.nextPlaybackTime = this.outputCtx.currentTime;
    // 端末が 24kHz を尊重したか (iOS は resample する可能性がある・正本 §6.2)。
    trace('AUDIO_CONTEXT', null, { sampleRate: this.outputCtx.sampleRate });

    this.source = this.inputCtx.createMediaStreamSource(this.stream);
    this.processor = this.inputCtx.createScriptProcessor(PROCESS_BUFFER_SIZE, 1, 1);
    this.processor.onaudioprocess = (ev) => this.handleAudioProcess(ev);
    this.source.connect(this.processor);
    // ScriptProcessor は destination に繋がないと発火しないブラウザがあるため、
    // 無音 Gain ノード経由で接続（実音は流さない）
    const silentGain = this.inputCtx.createGain();
    silentGain.gain.value = 0;
    this.processor.connect(silentGain);
    silentGain.connect(this.inputCtx.destination);
  }

  stop(): void {
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
    } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    try {
      this.inputCtx?.close();
    } catch {}
    try {
      this.outputCtx?.close();
    } catch {}
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.inputCtx = null;
    this.outputCtx = null;
    this.nextPlaybackTime = 0;
    this.playingSources.clear();
  }

  /** サーバから受信した base64 PCM (24kHz, 16-bit signed) を再生キューに積む */
  playPcm(base64: string): void {
    if (!this.outputCtx) return;
    const bytes = base64ToBytes(base64);
    if (bytes.byteLength < 2) return;
    const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
    const buf = this.outputCtx.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
    buf.copyToChannel(float32, 0);
    const src = this.outputCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this.outputCtx.destination);
    /*
     * **いまは到着ごとに未来時刻へ並べるだけ** (ジッタバッファ無し)。
     * bounded buffer 化は P0-2 (正本 §6.2)。ここでは**測るだけ**にして、
     * 「実際にアンダーランしているか」を実機で確かめられるようにする。
     */
    const now = this.outputCtx.currentTime;
    const underflow = this.nextPlaybackTime < now;   // 次の chunk が間に合わなかった
    const start = Math.max(this.nextPlaybackTime, now);
    src.start(start);
    this.nextPlaybackTime = start + buf.duration;
    trace('PCM_ARRIVE', null, {
      bytes: bytes.byteLength,
      aheadMs: Math.round((this.nextPlaybackTime - now) * 1000),
    });
    if (underflow) trace('AUDIO_UNDERFLOW', null, { gapMs: Math.round((now - (start - buf.duration)) * 1000) });
    this.playingSources.add(src);
    src.onended = () => {
      this.playingSources.delete(src);
      if (this.playingSources.size === 0) {
        try { this.onPlaybackEnd(); } catch {}
      }
    };
  }

  /** 割り込み: 残り再生を即停止（サーバ側 barge-in 通知時 or speaker mute 時） */
  flushPlayback(): void {
    if (!this.outputCtx) return;
    this.playingSources.forEach((s) => {
      try {
        s.stop();
        s.disconnect();
      } catch {}
    });
    this.playingSources.clear();
    this.nextPlaybackTime = this.outputCtx.currentTime;
  }

  private handleAudioProcess(ev: AudioProcessingEvent): void {
    if (!this.inputCtx) return;
    if (this.inputMuted) return; // AI 発話中など。サーバへ送らない
    const input = ev.inputBuffer.getChannelData(0);
    const ratio = this.inputCtx.sampleRate / INPUT_SAMPLE_RATE;
    const outLen = Math.floor(input.length / ratio);
    if (outLen <= 0) return;
    const int16 = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const s = input[Math.floor(i * ratio)];
      int16[i] = Math.max(-1, Math.min(1, s)) * 32767;
    }
    this.onChunk(bytesToBase64(new Uint8Array(int16.buffer)));
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  // 大きすぎる Uint8Array で String.fromCharCode(...arr) は stack overflow するので分割
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(bin);
}
