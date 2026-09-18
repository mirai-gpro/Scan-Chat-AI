/**
 * AI問診 — Live API の送信経路の回帰チェック (P0-1・正本 `docs/interview/AI問診_仕様と設計原則.md` §6.1)。
 *
 * 【なぜ機械で見張るか】この経路の誤りは**画面上は正常に見える**。
 * 実機で「画面は次の質問 / 音声は前の質問」という形でしか現れず、
 * 開発環境では Live API を叩けない (キーは本番のサーバ側だけ) ので**目視では守れない**。
 *
 * サーバ不要・ブラウザ不要。ソースを読むだけ。
 */
import { readFileSync } from 'node:fs';

const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const read = (p) => readFileSync(p, 'utf-8');
/** コメントを外した本体。**説明文に書いた語を検査が拾って自分で緑になる**のを防ぐ。 */
const code = (p) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

/**
 * 目印から始まる 1 つの塊 (`{...}` か `(...)`) を切り出す。
 * **窓幅 (`[\s\S]{0,600}`) で見ると、関数が伸びた日に黙って検査が効かなくなる。**
 */
function spanOf(src, marker, open = '{', close = '}') {
  const at = src.indexOf(marker);
  if (at < 0) return '';
  const start = src.indexOf(open, at);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === open) depth += 1;
    else if (src[i] === close) {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

const ctrl = code('src/scripts/chat/live-controller.ts');
const audio = code('src/scripts/chat/live-audio-manager.ts');
const token = code('src/pages/api/live-token.ts');
const gemini = code('src/lib/gemini.ts');
const cfg = code('src/lib/app-config.ts');

// ① 発話命令は ClientContent + turnComplete:true
ok('sendModelTurn が sendClientContent を使う',
  /function sendModelTurn[\s\S]{0,600}sendClientContent\(/.test(ctrl));
ok('sendModelTurn が turnComplete: true を付ける',
  /function sendModelTurn[\s\S]{0,600}turnComplete:\s*true/.test(ctrl));

// ② 発話命令の経路に realtimeInput(text) が残っていない
ok('sendModelTurn は sendRealtimeInput を使わない',
  !/function sendModelTurn[\s\S]{0,600}sendRealtimeInput/.test(ctrl));

// ③ 旧 sendToModel が残っていない (呼び分けが曖昧なまま復活しないように)
ok('旧 sendToModel が残っていない', !/sendToModel\s*\(/.test(ctrl));

// ④ 利用者のテキストは発話命令に混ぜない
ok('sendUserText は realtimeInput(text) のまま',
  /function sendUserText[\s\S]{0,400}sendRealtimeInput\(\s*\{\s*text/.test(ctrl));
ok('sendUserText は turnComplete を使わない',
  !/function sendUserText[\s\S]{0,400}turnComplete/.test(ctrl));
/*
 * **呼び出し側まで見る。** 「sendUserText の中身」だけを見ても、呼び出しが
 * `sendModelTurn` に差し替わった退行を素通りする (実測で通ってしまった)。
 */
ok('フォールバック入力は sendUserText を呼ぶ',
  /function sendFallback\(\)[\s\S]{0,400}sendUserText\(/.test(ctrl)
  && !/function sendFallback\(\)[\s\S]{0,400}sendModelTurn\(/.test(ctrl));
ok('未開始時の自由発話も sendUserText を呼ぶ',
  /if \(!cq\)[\s\S]{0,400}sendUserText\(rawAnswer\)/.test(ctrl));

// ⑤ 1 問目と 2 問目以降が同じ経路 (ClientContent の直呼びが残っていない)
{
  const direct = (ctrl.match(/liveSession\??\.sendClientContent\(/g) ?? []).length;
  ok('sendClientContent の直呼びは sendModelTurn の中だけ (1 箇所)', direct === 1, `${direct} 箇所`);
}

// ⑥ マイク音声は realtimeInput のまま
ok('マイク音声は sendRealtimeInput(audio)', /sendRealtimeInput\(\{?\s*\n?\s*audio:/.test(ctrl));

// ⑦ 既存の約束を壊していない
ok('NO_INTERRUPTION を維持', /activityHandling:\s*ActivityHandling\.NO_INTERRUPTION/.test(ctrl));
ok('interrupted → flushPlayback を維持', /serverContent\?\.interrupted[\s\S]{0,200}flushPlayback\(\)/.test(ctrl));
ok('modelTurn.parts を全走査', /for\s*\(const p of parts\)/.test(ctrl));
/*
 * ⑦-b **マイクのオン / オフ (2026-09-17)。**
 * 禁じられているのは**プログラムが勝手にゲートすること**であって、利用者の操作ではない。
 * 「呼び出しが 0 件」では見張れなくなったので、**呼び出し元を固定する**検査に差し替えた。
 */
ok('旧 setInputMuted (自動ゲート用の名前) が残っていない',
  !/setInputMuted/.test(ctrl) && !/setInputMuted/.test(audio));
{
  const calls = (ctrl.match(/setUserMicMuted\(/g) ?? []).length;
  const inGate = spanOf(ctrl, 'createMicGate(', '(', ')');
  ok('マイクの送信停止は 1 か所からしか呼ばない', calls === 1, `${calls} 箇所`);
  ok('その 1 か所は micGate の onChange の中', /setUserMicMuted\(/.test(inGate));

  const toggles = (ctrl.match(/micGate\.toggle\(/g) ?? []).length;
  ok('micGate.toggle() の呼び出しは 1 か所', toggles === 1, `${toggles} 箇所`);
  ok('その呼び出し元はマイクボタンの click',
    /micGateBtn\.addEventListener\('click',[^;]*micGate\.toggle\(\)/.test(ctrl));

  /*
   * **ここが本丸**: ターン・AI の発話・サーバのイベントからマイクを動かさないこと。
   * サーバメッセージの処理と、マイク音声を送るコールバックの**中身を実際に切り出して**見る。
   */
  const server = spanOf(ctrl, 'function handleServerMessage');
  const chunk = spanOf(ctrl, 'await audio.start(', '(', ')');
  const ended = spanOf(ctrl, 'audio.setOnPlaybackEnd(', '(', ')');
  ok('サーバメッセージの処理でマイクを切り替えない',
    server.length > 0 && !/micGate|setUserMicMuted/.test(server), server ? '' : '本体を切り出せなかった');
  ok('マイク送信のコールバックで切り替えない', !/micGate|setUserMicMuted/.test(chunk));
  ok('AI の再生終了で切り替えない', !/micGate|setUserMicMuted/.test(ended));

  /*
   * **「送るのをやめるだけ」** (発注者裁定 2026-09-17)。端末のマイクは掴んだままにする
   * = 戻すときに許諾ダイアログを出さない。トラックを止める実装へ滑らせない。
   */
  const setter = spanOf(audio, 'setUserMicMuted(muted: boolean)');
  ok('マイクを切っても端末のトラックは止めない',
    setter.length > 0 && !/getTracks|\.stop\(|enabled\s*=/.test(setter), setter.slice(0, 60));
  ok('マイクを切っても AI の再生は止めない', !/flushPlayback/.test(inGate));
}
{
  /*
   * mic-gate 自身が勝手に動かないこと。**タイマーも自前のイベント購読も持たせない**
   * (持たせた瞬間に「プログラム側の制御」になる)。
   */
  const gate = code('src/scripts/chat/mic-gate.ts');
  ok('mic-gate はタイマーを持たない', !/setTimeout|setInterval|requestAnimationFrame/.test(gate));
  ok('mic-gate は自分でイベントを購読しない', !/addEventListener/.test(gate));
  // 宣言を除いた呼び出しが 2 つ = toggle と resetToOn。ほかから状態を動かさない。
  const setCalls = (gate.replace(/function set\(/g, 'function _decl(').match(/\bset\(/g) ?? []).length;
  ok('状態を変える入口は toggle と resetToOn だけ',
    setCalls === 2 && /toggle:\s*\(\)\s*=>\s*set\(/.test(gate) && /resetToOn:\s*\(\)\s*=>\s*set\(/.test(gate),
    `set() の呼び出し ${setCalls} 件`);
}
ok('silent 分岐 (発話依頼の出し分け) を入れていない',
  !/opts\.silent\s*\?[\s\S]{0,120}(sendModelTurn|sendUserText)/.test(ctrl));
ok('SPEAKING 等の独自状態機械を入れていない', !/\bSPEAKING\b|\bWAITING_AUDIO\b/.test(ctrl));

// ⑧ 段階の約束 (P0 ではモデルと API version を動かさない・正本 §6.3)
ok('Live モデルの既定は 3.1 のまま (3.8 は P3)',
  /gemini-3\.1-flash-live-preview/.test(cfg) || /gemini-3\.1-flash-live-preview/.test(gemini));
ok('3.8 をまだ既定にしていない',
  !/gemini-3\.8-live/.test(cfg) && !/gemini-3\.8-live/.test(gemini));
ok('v1alpha はまだ動かさない (v1beta 切替は P2)',
  /v1alpha/.test(token) && /v1alpha/.test(ctrl));
ok('3.8 でエラーになる proactiveAudio: false を入れていない',
  !/proactiveAudio:\s*false/.test(ctrl));

// ⑨ 観測ログ (P0-0)
ok('観測ログを初期化している', /initLiveTrace\(\)/.test(ctrl));
{
  /*
   * **無効時も `window.__liveTrace` を生やすこと。** 生やさないと、採取する人が
   * `?trace=1` を付け忘れただけで「not a function」しか出ず、デプロイ漏れと区別が付かない。
   */
  const t = code('src/scripts/chat/live-trace.ts');
  const body = t.slice(t.indexOf('export function initLiveTrace'));
  const assign = body.indexOf('__liveTrace =');
  const early = body.search(/if\s*\(!enabled\)\s*return/);
  /*
   * **「代入が書いてあること」だけを見ても素通りする** — その手前に
   * `if (!enabled) return;` を足す退行で、代入行はそのまま残るため (実測で通ってしまった)。
   * **代入より前に早期 return が無いこと**を見る。
   */
  /*
   * **URL を編集せずに有効化できること。** ホーム画面起動では URL 欄が無く、
   * 「?trace=1 を付けて開き直す」だけの案内では詰まる (実際に 2 往復詰まった)。
   */
  ok('再読み込み不要で有効化できる入口がある',
    /__liveTraceOn\s*=\s*\(\)\s*=>/.test(t) && /enabled = true/.test(t));
  ok('無効時の案内が __liveTraceOn を指している', /howTo:[\s\S]{0,80}__liveTraceOn\(\)/.test(t));
  ok('URL で指定したら端末に残す (遷移でクエリが落ちても続く)',
    /if \(q === '1' \|\| h === '1'\)[\s\S]{0,80}persist\(true\)/.test(t));
  ok('無効時も window.__liveTrace を生やす (原因が分かるように)',
    assign >= 0 && /howTo:/.test(t) && (early === -1 || early > assign),
    early >= 0 && early < assign ? '代入より前に早期 return がある' : '');
}
for (const ev of ['ANSWER_COMMIT', 'UI_APPLY', 'MODEL_TURN_SEND', 'SERVER_INTERRUPTED',
  'AUDIO_FLUSH', 'AUDIO_FIRST_CHUNK', 'TURN_COMPLETE', 'INPUT_ACTIVITY', 'MIC_MUTE']) {
  ok(`ログ ${ev} を出している`, new RegExp(`trace\\('${ev}'`).test(ctrl));
}
for (const ev of ['PCM_ARRIVE', 'AUDIO_UNDERFLOW', 'AUDIO_CONTEXT']) {
  ok(`ログ ${ev} を出している (audio)`, new RegExp(`trace\\('${ev}'`).test(audio));
}
// ⑩ ログに回答本文が乗らないこと (PII)
{
  const t = code('src/scripts/chat/live-trace.ts');
  ok('trace の detail は数値と列挙値だけ (自由文字列を渡せない)',
    /TraceDetail\s*=\s*Record<string,\s*number \| boolean \| 'tap' \| 'voice' \| null>/.test(t));
  const bad = [...ctrl.matchAll(/trace\([^)]*\)/g)].filter((m) => /rawAnswer|question|text:|transcript|Buf/.test(m[0]));
  ok('trace に回答本文・transcript を渡していない', bad.length === 0, bad.map((b) => b[0]).join(' / '));
  ok('マイクが拾った中身は記録しない (発火したことだけ)',
    /trace\('INPUT_ACTIVITY', currentQ\?\.\id \?\? null\)/.test(ctrl));
}
// AI 音声を UI 遷移のトリガにしていない (禁止事項)
ok('AUDIO_FIRST_CHUNK で UI を進めていない',
  !/AUDIO_FIRST_CHUNK[\s\S]{0,200}applyQuestionToUI/.test(ctrl));

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
