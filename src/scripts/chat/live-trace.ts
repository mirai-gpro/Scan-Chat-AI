/**
 * AI問診 — Live API の観測ログ (P0-0・正本 `docs/interview/AI問診_仕様と設計原則.md` §6.3)。
 *
 * 【なぜ要るか】④ 画面と音声のズレ / ⑤ 音声の途切れ は**実機でしか再現しない**
 * (API キーは本番のサーバ側にしか置かない運用なので、手元で Live API を叩けない)。
 * 直す前に**何が起きているかを測れる状態**にしておく。
 *
 * 【PII を入れない】記録するのは**設問 ID・イベント名・時刻・数値だけ**。
 * 回答本文・transcript・氏名は**絶対に入れない** (医療情報になる)。
 * 呼び出し側が誤って渡しても、`detail` は数値と短い列挙値しか受け取らない型にしてある。
 *
 * 【既定は無効】`?trace=1` か `localStorage['welltect.live.trace']='1'` のときだけ集める。
 * 本番で常時大量出力しない。採取は画面から `window.__liveTrace()` で JSON を取り出す。
 */

/** 数値と短い列挙値だけ。**文字列の自由入力を渡せない型にしてある。** */
export type TraceDetail = Record<string, number | boolean | 'tap' | 'voice' | null>;

interface TraceRow { t: number; ev: string; qid?: string; d?: TraceDetail }

const MAX_ROWS = 2000;              // 1 セッションの上限 (メモリを食い潰さない)
const rows: TraceRow[] = [];
let enabled = false;
let t0 = 0;

const STORE_KEY = 'welltect.live.trace';

/** best-effort。private mode 等で throw しても落とさない。 */
function persist(on: boolean): void {
  try { if (on) localStorage.setItem(STORE_KEY, '1'); else localStorage.removeItem(STORE_KEY); } catch {}
}

function readFlag(): boolean {
  try {
    // `#trace=1` も見る (共有やホーム画面起動でクエリが落ちる経路があるため)。
    const q = new URLSearchParams(location.search).get('trace');
    const h = new URLSearchParams(location.hash.replace(/^#/, '')).get('trace');
    if (q === '1' || h === '1') {
      persist(true);   // **一度指定したら端末に残す** — 画面遷移でクエリが落ちても続く
      return true;
    }
    return localStorage.getItem(STORE_KEY) === '1';
  } catch { return false; }
}

/**
 * 画面の初期化時に 1 回だけ呼ぶ。**失敗しても本体を止めない。**
 *
 * **`window.__liveTrace` は無効時も必ず生やす。** 生やさないと、採取する人が
 * `?trace=1` を付け忘れただけでも `__liveTrace is not a function` としか出ず、
 * 「入れ忘れ」なのか「デプロイされていない」のか「ページが違う」のかが**判別できない**
 * (実際にそうなった・2026-09-17)。無効なら**理由と有効化の手順を返す**。
 */
export function initLiveTrace(): void {
  try {
    enabled = readFlag();
    t0 = performance.now();
    const w = window as unknown as {
      __liveTrace?: () => unknown;
      __liveTraceOn?: () => string;
      __liveTraceOff?: () => string;
    };
    /*
     * **URL を編集させない・再読み込みも要らない入口。**
     * ホーム画面から起動していると URL 欄が無く、`?trace=1` を付けられない。
     * localStorage を書いて再読み込み、も手順が 2 つあって詰まりやすい (実際に詰まった)。
     * → **その場で有効にする**。以降のイベントから記録が始まる。
     */
    w.__liveTraceOn = () => {
      enabled = true;
      t0 = performance.now();
      rows.length = 0;
      persist(true);
      return '観測ログを有効にしました。問診を 3〜4 問進めてから window.__liveTrace() を実行してください。';
    };
    w.__liveTraceOff = () => {
      enabled = false;
      persist(false);
      return '観測ログを無効にしました。';
    };
    w.__liveTrace = () => (enabled
      ? rows.slice()
      : {
        enabled: false,
        reason: 'このページは観測ログ無効で開かれています',
        howTo: 'window.__liveTraceOn() を実行してください (再読み込み不要)。'
             + ' URL に ?trace=1 を付けて開いても有効になります。',
      });
    // eslint-disable-next-line no-console
    console.info(enabled
      ? '[live-trace] 有効。window.__liveTrace() で取り出せます。'
      : '[live-trace] 無効。window.__liveTraceOn() で有効にできます (再読み込み不要)。');
  } catch { /* 何もしない */ }
}

/** イベントを 1 行記録する。**例外を投げない。** */
export function trace(ev: string, qid?: string | null, d?: TraceDetail): void {
  if (!enabled) return;
  try {
    if (rows.length >= MAX_ROWS) return;
    const row: TraceRow = { t: Math.round(performance.now() - t0), ev };
    if (qid) row.qid = qid;
    if (d) row.d = d;
    rows.push(row);
    // eslint-disable-next-line no-console
    console.debug('[live-trace]', row.t, ev, qid ?? '', d ?? '');
  } catch { /* 何もしない */ }
}

export function isTraceEnabled(): boolean { return enabled; }
