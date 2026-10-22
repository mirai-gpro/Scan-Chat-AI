/**
 * 「直前に撮影のボタンを押した」ことだけを残す合図（仕様 §4.4.7 / §4.4.9）。
 *
 * **別ページの帯（ダッシュボード）から来た回だけ、着いた先でカメラを開く**ための控え。
 * 置き場所をここに分けてあるのは、**ダッシュボードにカメラの処理を持ち込まないため**
 * （`external-id-capture.ts` は `camera-scan` を静的に引くので、ページの JS が重くなる）。
 * **合図の形（鍵・期限・中身）はここが唯一の定義**で、`external-id-capture.ts` も
 * ここから import する（2 か所に書かない）。
 *
 * **uid も番号も入れない**（受取 ID と時刻だけ・`sessionStorage` なのでタブを閉じれば消える）。
 * **URL には何も足さない**（クエリに受取 ID を出すとアクセスログに残る）。
 */
const START_KEY = 'welltect.extid.start';
const START_TTL_MS = 60_000;

export function rememberStart(id: string): void {
  if (!id) return;
  try {
    sessionStorage.setItem(START_KEY, JSON.stringify({ id, ts: Date.now() }));
  } catch {
    /* 使えない環境では従来どおり（着いた先でボタンを押してもらう） */
  }
}

/** 控えを**取り出して消す**（読んだ時点で使い切る）。期限切れ・壊れていれば null。 */
export function takeStart(): string | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(START_KEY);
    if (raw !== null) sessionStorage.removeItem(START_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { id?: unknown; ts?: unknown };
    const id = typeof v.id === 'string' ? v.id : '';
    const ts = typeof v.ts === 'number' ? v.ts : 0;
    if (!id || !Number.isFinite(ts)) return null;
    // **未来の時刻も期限切れ扱い**（時計のずれで無期限に残らないように）。
    const age = Date.now() - ts;
    return age >= 0 && age <= START_TTL_MS ? id : null;
  } catch {
    return null;
  }
}

let bound = false;

/**
 * **撮影ブロックを持たないページ**（ダッシュボード）で、催促の帯のボタンに合図を付ける。
 *
 * **リンクは止めない** — `href` のまま `/kit#extid-…` へ飛び、着いた先の
 * `external-id-capture.ts` の `resumeStart()` が合図を見てカメラを開く（§4.4.9）。
 * 押したのは利用者なので「勝手に開く」には当たらない。合図が無ければ開かない。
 *
 * **`/kit` では呼ばない** — あちらは `external-id-capture.ts` が同じ click を受け、
 * 同じページのブロックを引き当てて**その場で**カメラを開く（合図は要らない）。
 */
export function initExternalIdStartLinks(): void {
  if (bound) return;
  bound = true;
  document.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement | null;
    const starter = t?.closest?.('[data-extid-start]') as HTMLElement | null;
    if (!starter) return;
    rememberStart(starter.getAttribute('data-extid-start') ?? '');
  });
}
