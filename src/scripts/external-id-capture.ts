/**
 * 受取時・外部検査ID の 撮影 → 読取 → 確認 → 登録 のクライアント処理。
 *
 * 正本: `docs/lab/kit_receipt_external_id_capture_spec.md` §4 / §6.1。
 * markup の契約は `src/components/dashboard/ExternalIdCapture.astro`
 * （`data-extid-*` 属性）。**処理はここが唯一の実装** — `kit-self-report.ts` と
 * 同じ規律で、2 画面から使っても写して増やさない。
 *
 * 経路は 3 段:
 *   ① チケット発行 → **ブラウザから S3 へ直接 PUT**（本体は Vercel 関数を通さない）
 *   ② サーバで Gemini に読ませて**候補**を受け取る
 *   ③ ユーザーが確認してから登録
 *
 * **②が落ちても行き止まりにしない。** S3 未設定・バケットの CORS 未設定・回線断は
 * ブラウザから区別できないので、失敗したら**手入力へ落とす**
 * （`scan-upload.ts` が圧縮経路へ譲るのと同じ考え方）。
 *
 * **uid は属性で渡さない。** 対象はサーバが Cookie から決める
 * （`kit-self-report.ts:16-18` と同じ・他人の uid を書かせない）。
 *
 * 【2026-10-21 の変更（発注者指示）】
 *   - **「写真を選ぶ」を撤去**した。ファイル選択の `change` 経路も一緒に消えた。
 *   - **手入力も撤去**した（「**チェックデジットもないのに、重要な検査IDを手入力させる
 *     対応はありえない**」）。**この番号にはチェックディジットが無い**ので、1 桁の
 *     打ち間違いが**正しい形の別の番号**になり、黙って別の検査に紐づく。
 *     → **画面から入る口はアプリ内カメラ 1 つだけ**。読めなかった回は**撮り直す**。
 *     **失敗したときに手入力へ落とさない** — 落とすと、まさに打ち間違いが混ざる場面
 *     （カメラが使えない・S3 が落ちた・読み取れない）でだけ誤りを招き入れることになる。
 *     それでも読めない回は **admin の確認・訂正経路（仕様 §12.1）**が引き受ける。
 *     サーバは `captureMethod: 'file' / 'manual'` を受け続ける
 *     （既存の台帳行と DB の check 制約）。
 *   - **登録済みでも「登録し直す」から撮り直せる**ようにした（仕様 §8.3）。
 *     API は以前から撮り直しに対応しているので、**ここで足したのは面の出し入れだけ**。
 *
 * 【2026-10-22 の変更（発注者指示）】
 *   - **催促の帯の「撮影して登録する」で即カメラを開く**（§4.4.5）。
 *     「『カメラで撮影』ボタンのフローを省略して、『撮影して登録する』ボタンだけで
 *     即、カメラを起動して」。帯は撮影ブロックの**外**に在るので、click の
 *     ハンドラは `[data-extid-capture]` のガードより**前**で受ける。
 *     **勝手には開かない** — 同じページにブロックが在る・スマホ・未登録の 3 つが
 *     揃ったときだけ。別ページへ移った先での自動起動はしない。
 *   - **「登録し直す」「撮り直す」でもその場でカメラを開く**（§4.4.6）。
 *     どちらも利用者の press なので**もう 1 枚ボタンを挟まない**。
 *     撮影の面のボタンは「登録し直す」から入った回はサーバが `hidden` で出し、
 *     **カメラを開けなかったときだけ JS が出す**（行き止まりにしない）。
 *
 * 【2026-10-22 の裁定（発注者指示・§4.4.7 / §4.4.8）】**撮影までは操作 2 つだけ**:
 *   **①カメラを起動 ②撮影**。**ただし登録（書き込み）の前の確認は外さない**
 *   （§4.4.8・発注者指示「撮影までが 2 アクション。登録する際の確認は必要」）。
 *   チェックディジットが無いので、**本人が番号を見て確定する段が最後の網**。
 *   - **読めなかったら押させずにカメラへ戻す**（「撮り直す」を押させない）。
 *   - **「登録し直す」の上書き確認を外した**（§4.4.3 で挟んだ 1 段。
 *     前の番号は台帳に残る＝取り返しがつくので、押させる価値より手数を優先）。
 *   - **別ページ（ダッシュボード）の帯から来た回は、着いた先でカメラを開く**。
 *     押したのは利用者なので「勝手に開く」には当たらないが、**合図は
 *     直前のタップの控え（sessionStorage・一度きり・60 秒）だけ**に限る。
 */

import { initCameraScan, type CameraScanController } from './camera-scan';
/*
 * **合図の定義は `external-id-start.ts` が唯一**（§4.4.9）。ダッシュボードは
 * カメラを持ち込まないよう**あちらだけ**を読み込むので、ここで書き写さない。
 */
import { rememberStart, takeStart } from './external-id-start';
import { decodeBarcodeInBrowser } from './external-id-barcode';
/*
 * **正規化の規則を 2 か所に置かない**（`external-test-id.ts:153-178` が唯一の本体）。
 * この module は依存ゼロの純関数しか持たないので画面から import してよい。
 */
import { normalizeExternalId } from '../lib/external-test-id';

let bound = false;

interface Ctx {
  root: HTMLElement;
  shipmentId: string;
  provider: string;
  idLabel: string;
  statusEl: HTMLElement | null;
  confirmEl: HTMLElement | null;
  candidateEl: HTMLElement | null;
  noteEl: HTMLElement | null;
  /** 「別の用紙／別の数字かもしれません」の案内。 */
  wrongEl: HTMLElement | null;
  /** アプリ内カメラの面と、その中の要素。 */
  cameraEl: HTMLElement | null;
  videoEl: HTMLVideoElement | null;
  canvasEl: HTMLCanvasElement | null;
  cameraStatusEl: HTMLElement | null;
  /** `/scan` と同じコントローラ。**押されるまで作らない**（作っただけでは起動しない）。 */
  camera: CameraScanController | null;
  /**
   * 撮影を始めるボタン。**「登録し直す」から入った回はサーバが `hidden` で出す**
   * （押した時点でカメラが開くので 2 段にしない・仕様 §4.4.6）。
   * **カメラを開けなかったときだけ JS で出す**＝行き止まりを作らない。
   */
  cameraOpenEl: HTMLElement | null;
  /** 登録済みの面 / 撮影の面。**登録済みでも両方 markup は在る**。 */
  doneEl: HTMLElement | null;
  formEl: HTMLElement | null;
  /** 直近の読み取り結果（登録時にサーバへ戻す）。 */
  evidenceKey: string | null;
  /** 発行元の接頭辞（`704`＝Wellfort）。**サーバが返した値だけを使う**（焼き込まない）。 */
  orgPrefix: string;
  /** 画面から送るのは `camera` だけ（`file` も `manual` も経路ごと撤去済み）。 */
  captureMethod: 'camera';
  /**
   * 走っているサーバ側の読み取り（§12.4 の案 A）。
   *
   * **端末内デコードで番号を先に出す**ので、利用者は**サーバの読み取りが終わる前に
   * 「登録」を押せる**。登録はサーバが控えた値だけを使う（§12.2）ので、
   * **押された回はここで待つ**。待たずに送ると控えが無く
   * 「もう一度撮影してください」になる＝**読めているのに撮り直させる**ことになる。
   */
  pending: Promise<boolean> | null;
  busy: boolean;
}

const ctxOf = new WeakMap<HTMLElement, Ctx>();

function ctx(root: HTMLElement): Ctx {
  let c = ctxOf.get(root);
  if (c) return c;
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  c = {
    root,
    shipmentId: root.dataset.shipmentId ?? '',
    provider: root.dataset.provider ?? '',
    idLabel: root.dataset.idLabel ?? '番号',
    statusEl: q('[data-extid-status]'),
    confirmEl: q('[data-extid-confirm]'),
    candidateEl: q('[data-extid-candidate]'),
    noteEl: q('[data-extid-note]'),
    wrongEl: q('[data-extid-wrong]'),
    cameraEl: q('[data-extid-camera]'),
    videoEl: q<HTMLVideoElement>('[data-extid-video]'),
    canvasEl: q<HTMLCanvasElement>('[data-extid-canvas]'),
    cameraStatusEl: q('[data-extid-camera-status]'),
    cameraOpenEl: q('[data-extid-camera-open]'),
    camera: null,
    doneEl: q('[data-extid-done]'),
    formEl: q('[data-extid-form]'),
    evidenceKey: null,
    orgPrefix: '',
    captureMethod: 'camera',
    pending: null,
    busy: false,
  };
  ctxOf.set(root, c);
  return c;
}

function say(c: Ctx, text: string): void {
  if (c.statusEl) c.statusEl.textContent = text;
}
function show(el: HTMLElement | null, on: boolean): void {
  if (el) el.classList.toggle('hidden', !on);
}

async function post(c: Ctx, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/kit/${encodeURIComponent(c.shipmentId)}/external-id`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: c.provider, ...payload }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.ok !== true) {
    const detail = typeof body.detail === 'string' ? body.detail : '';
    const error = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    throw new Error(detail || error);
  }
  return body;
}

/** 撮影 → S3 → 読取。**失敗は throw せず false を返し、手入力へ譲る。** */
/**
 * 「別の用紙／別の数字かもしれません」の案内を出す。
 *
 * **候補は消さない。** 形が違っても登録はできる（台帳に `review_required` で残り、
 * 事務局が直す）ので、ここで止めると**撮影そのものを失わせる**ことになる。
 * 出すのは注意と、**上の図をもう一度見てもらう**ための一文だけ。
 */
function showWrong(c: Ctx, title: string, body: string): void {
  if (c.wrongEl) {
    const t = c.wrongEl.querySelector('[data-extid-wrong-title]');
    const b = c.wrongEl.querySelector('[data-extid-wrong-body]');
    if (t) t.textContent = title;
    if (b) b.textContent = body;
  }
  show(c.wrongEl, true);
}

/** 撮り直し・次の読み取りのたびに消す（前回の注意を残さない）。 */
function clearWrong(c: Ctx): void {
  show(c.wrongEl, false);
}

/**
 * この用紙のどこを読むかの言い直し。
 *
 * **図を持つ provider は図を指す**（同じ説明を 2 回読ませない）。図は
 * `ExternalIdSheetGuide.astro` が **`demecal` のときだけ**出すので、
 * 「上の図」と言ってよいのも `demecal` だけ。**この対応がずれると
 * 「上の図」と書いてあるのに図が無い**ことになるので、検査で固定している
 * （`verify:external-id-capture` ⑬）。
 */
const WHERE: Record<string, string> = {
  demecal: '上の図の囲み＝「問合せ番号」の行（数字 15 桁と、その右の横線のバーコード）です。用紙全体が入るように撮ってください。',
  prevent: '上の図の囲み＝「ユーザーID」の印字と、その下のバーコードです。シールを貼る前に、台紙全体が入るように撮ってください。',
};
function whereText(c: Ctx): string {
  return WHERE[c.provider] ?? '用紙全体が入るように撮り直してください。';
}

/**
 * カメラを使える端末か。**判定は CSS の `.touch-only` と同じ `(pointer: coarse)`**
 * （`scan.astro` の `cameraAvailable()` と同じ）。
 * ここがずれると「画面に出ていないカメラが JS から起動する」ことになる。
 */
function cameraAvailable(): boolean {
  return window.matchMedia?.('(pointer: coarse)').matches ?? false;
}

/** 撮った 1 枚を File にする（`captureAndRead` がそのまま受け取れる形）。 */
async function dataUrlToFile(dataUrl: string): Promise<File | null> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const type = blob.type || 'image/jpeg';
    return new File([blob], 'capture.jpg', { type });
  } catch {
    return null;
  }
}

/** カメラを止めて面を閉じる。**二重に止めても安全**。 */
function closeCamera(c: Ctx): void {
  try {
    c.camera?.stop();
  } catch {
    /* 止められなくても画面は閉じる */
  }
  show(c.cameraEl, false);
}

/**
 * アプリ内カメラを開く。**このボタンを押したときだけ**呼ぶ。
 *
 * OS のカメラアプリは開かない — Android Chrome では端末のカメラが
 * バーコードを検出して別画面へ持っていき、**写真が返ってこなかった**（実測 2026-10-13）。
 */
async function openCamera(c: Ctx): Promise<void> {
  if (!c.videoEl || !c.canvasEl || !c.cameraEl) return;
  if (!cameraAvailable()) {
    /*
     * **手入力へ落とさない。** PC は下の QR からスマートフォンへ移ってもらう
     * （`canHandOff` のブロック）。番号を打たせる逃げ道は置かない。
     */
    say(c, 'この端末ではカメラを使えません。スマートフォンでこの画面を開いて撮影してください。');
    show(c.cameraOpenEl, true);
    return;
  }
  clearWrong(c);
  if (!c.camera) {
    c.camera = initCameraScan({
      video: c.videoEl,
      canvas: c.canvasEl,
      status: c.cameraStatusEl ?? c.videoEl,
      /*
       * **`onShot` を渡すと「撮るだけ」になる**（解析は走らない）。
       * ここで受け取った 1 枚を、ファイル選択と**同じ経路**へ流す。
       */
      onShot: (dataUrl: string) => {
        void (async () => {
          const file = await dataUrlToFile(dataUrl);
          closeCamera(c);
          if (!file) {
            say(c, '写真を取り出せませんでした。もう一度お試しください。');
            return;
          }
          c.captureMethod = 'camera';
          await captureAndRead(c, file);
        })();
      },
      onError: (message: string) => {
        closeCamera(c);
        // 権限拒否・カメラ無しはここに来る。**手入力へは落とさない**（上のヘッダ参照）。
        say(c, `${message} カメラの使用を許可してから、もう一度お試しください。`);
        // **もう一度試す口を残す**（自動で開いた回はボタンを出していないため）。
        show(c.cameraOpenEl, true);
      },
    });
  }
  show(c.cameraEl, true);
  await c.camera.start();
}

/**
 * 区間ごとの実測を**画面には出さずに**残す（切り分け用）。
 *
 * 置き場所は 2 つ:
 *   - `console.info` … 実機を PC に繋いだときに読む
 *   - `data-extid-timing` … 画面を見ながら要素を見れば読める（控えは 1 件だけ）
 *
 * **利用者向けの表示にしない** — 番号が出たあとに ms を並べても読む人がいない。
 * **PII は入らない**（ms とバイト数だけ。番号も鍵も入れない）。
 */
function reportTiming(c: Ctx, uploadMs: number, readMs: number, server: unknown): void {
  const t = {
    upload_ms: uploadMs,
    read_ms: readMs,
    total_ms: uploadMs + readMs,
    server: server && typeof server === 'object' ? server : null,
  };
  try {
    c.root.dataset.extidTiming = JSON.stringify(t);
  } catch {
    /* 属性に入らなくても処理は続ける */
  }
  // eslint-disable-next-line no-console
  console.info('[extid] timing', t);
}

/**
 * 待っているあいだ**経過秒を出す**（発注者指摘「撮影から表示まで 30 秒近く」・2026-10-22）。
 *
 * **これは待ち時間を短くするものではない。** それでも入れる理由が 2 つある:
 *   1. **無言で 30 秒止まると壊れたように見える**。利用者は 50〜65 代で、
 *      反応が無ければもう一度押す（二重送信＝さらに遅くなる）。
 *   2. **どちらの区間が長いかが画面で分かる** — 「写真を送っています」と
 *      「番号を読み取っています」は別の原因（回線の上り / 推論と S3 の往復）なので、
 *      これだけで切り分けの半分が終わる。
 *
 * **数字は 5 秒たってから出す** — 速い回に秒数を見せても意味が無く、
 * 短い待ちに数字が出ると逆に遅く感じる。
 */
function waiting(c: Ctx, text: string): () => void {
  const t0 = Date.now();
  say(c, `${text}…`);
  const timer = window.setInterval(() => {
    const sec = Math.round((Date.now() - t0) / 1000);
    if (sec >= 5) say(c, `${text}…（${sec}秒）`);
  }, 1000);
  return () => window.clearInterval(timer);
}

/**
 * 1 回の撮影ぶんの状態。**端末内デコードとサーバの読み取りが同時に走る**ので、
 * **どちらが先に答えたか**を持たないと表示が前後する（遅れて届いた端末側の値で
 * サーバの値を上書きしてしまう）。
 */
interface Turn {
  /** サーバの読み取りが答えたか。**答えたあとは端末側の値で触らない。** */
  serverDone: boolean;
  /** 端末内デコードで先に出した値（正規化済み）。無ければ null。 */
  localShown: string | null;
}

/**
 * **撮ったその場で番号を出す**（§12.4 の案 A・発注者指示 2026-10-22）。
 *
 * **表示だけ。登録の値にはしない**（§12.2 = サーバが控えた読み取り結果だけを使う）。
 * アップロードを待たせないよう**並行に**走らせ、**サーバが先に答えた回は何もしない**。
 * 読めなければ黙って諦める（従来どおりサーバの応答を待つ画面になる）。
 */
async function showLocalCandidate(c: Ctx, file: File, turn: Turn): Promise<void> {
  try {
    const r = await decodeBarcodeInBrowser(file);
    if (turn.serverDone) return;
    const v = r.value ? normalizeExternalId(r.value) : null;
    if (!v) return;
    turn.localShown = v;
    if (c.candidateEl) c.candidateEl.textContent = v;
    if (c.noteEl) c.noteEl.textContent = '読み取りを確認しています…';
    show(c.confirmEl, true);
  } catch {
    /* 表示のためだけの処理なので、失敗しても何もしない */
  }
}

async function captureAndRead(c: Ctx, file: File): Promise<boolean> {
  clearWrong(c);
  const turn: Turn = { serverDone: false, localShown: null };
  // **待たない**（番号は端末内デコードが先に出す / サーバの読み取りはその裏で進む）
  const local = showLocalCandidate(c, file, turn);
  const running = uploadAndRead(c, file, turn);
  /*
   * **走っている読み取りを握っておく。** 番号が先に出るので
   * 利用者はこれが終わる前に「登録」を押せる（`register` がここで待つ）。
   */
  c.pending = running;
  let ok = false;
  try {
    ok = await running;
  } finally {
    await local.catch(() => undefined);
    if (c.pending === running) c.pending = null;
  }

  /*
   * **読めた回は確認の面で止める**（発注者裁定 2026-10-22・§4.4.8）。
   * §4.4.7 の「2 アクション」は**撮影まで**にかかる規則で、
   * **書き込み（登録）の前の確認は外さない** — この番号には**チェックディジットが
   * 無い**ので、誤読を機械で見分けられるのは先頭 `704` と桁数だけ。
   * **本人が番号を見て確定する段が最後の網**になる。
   *
   * **読めなかった回は押させずにカメラへ戻す**（§4.4.7・ここでは何も書かないので
   * 「書き込みの前の確認」には当たらず、撮影の続きにすぎない）。
   */
  if (!ok) await openCamera(c);
  return ok;
}

async function uploadAndRead(c: Ctx, file: File, turn: Turn): Promise<boolean> {
  const tUpload0 = Date.now();
  let tick = waiting(c, '写真を送っています');
  let key: string;
  try {
    const t = await post(c, { mode: 'ticket', contentType: file.type, bytes: file.size });
    const url = String(t.upload_url ?? '');
    const headers = (t.headers ?? {}) as Record<string, string>;
    key = String(t.key ?? '');
    if (!url || !key) throw new Error('チケットを受け取れませんでした');
    const put = await fetch(url, { method: 'PUT', headers, body: file });
    if (!put.ok) throw new Error(`アップロードに失敗しました (${put.status})`);
  } catch (err) {
    tick();
    /*
     * S3 未設定 / CORS 未設定 / 回線断 は**区別できない**ので原因を断定しない。
     * **手入力へ落とさない** — 通信が不調なだけの回に、打ち間違いの余地を作ってしまう。
     */
    say(c, '写真を送れませんでした。通信の状態をお確かめのうえ、もう一度撮影してください。');
    show(c.confirmEl, false);
    void err;
    return false;
  }

  tick();
  const uploadMs = Date.now() - tUpload0;

  c.evidenceKey = key;
  const tRead0 = Date.now();
  tick = waiting(c, '番号を読み取っています');
  try {
    const r = await post(c, { mode: 'read', evidenceKey: key });
    tick();
    turn.serverDone = true;
    reportTiming(c, uploadMs, Date.now() - tRead0, r.timing);
    const candidate = String(r.candidate ?? '');
    /*
     * サーバは採った値だけを返す。**登録時に送り返さない** —
     * 読み取りの生値はサーバが `evidenceKey` で控えてある（仕様 §12.2 の案 (c)）。
     * ここで持っているのは**画面に出す文字**で、登録の根拠ではない。
     */
    if (c.candidateEl) c.candidateEl.textContent = candidate;
    const reasons = Array.isArray(r.review_reasons) ? (r.review_reasons as string[]) : [];
    c.orgPrefix = typeof r.org_prefix === 'string' ? r.org_prefix : '';
    /*
     * **端末内デコードと食い違ったら黙って差し替えない。** 画面に出ていた番号が
     * 変わるので、変わったことを 1 行で言う（登録に使うのはサーバの値）。
     */
    const replaced = turn.localShown && turn.localShown !== candidate
      ? 'サーバで読み直した番号に差し替えました。'
      : '';
    const why = reasonText(reasons, typeof r.note === 'string' ? r.note : null);
    if (c.noteEl) c.noteEl.textContent = [replaced, why].filter(Boolean).join(' ');
    /*
     * **形が想定と違う = 別の数字を読んだ可能性が高い。**
     * 用紙には電話番号や管理用の記号も印字されているので、ここで図へ戻す。
     * ただし**候補は出したままにする** — 実物の形式が既定と違うだけのこともあり、
     * その回を登録できなくすると撮影そのものが無駄になる。
     */
    /*
     * **発行元の接頭辞で読み取りの成否を見る**（`704`＝Wellfort・2026-10-21）。
     * 当社のキットの番号は必ずこれで始まるので、外れた回は
     * **別の数字（URL の一部・管理用の記号など）を読んだ疑いが濃い**。
     * 形の不一致（`pattern_*`）より**具体的に言えるので、こちらを先に出す**。
     * ただし**候補は消さない** — 実物の形式が既定と違うだけのこともある。
     */
    if (reasons.includes('org_prefix_mismatch')) {
      // **接頭辞はサーバが返した値をそのまま出す**（画面に焼くと app_config と食い違う）。
      const head = c.orgPrefix ? `${c.orgPrefix} で始まります` : '決まった数字で始まります';
      showWrong(c, 'この検査キットの番号ではないかもしれません',
        `この検査キットの${c.idLabel}は${head}が、読み取れた番号はそうなっていません。`
        + `${whereText(c)} この番号で間違いなければ、そのまま登録できます。`);
    } else if (reasons.includes('pattern_mismatch') || reasons.includes('pattern_unknown')) {
      showWrong(c, `別の数字を読んだかもしれません`,
        `読み取れた数字が${c.idLabel}の形と違います。${whereText(c)} この番号で間違いなければ、そのまま登録できます。`);
    }
    show(c.confirmEl, true);
    say(c, '');
    return true;
  } catch (err) {
    tick();
    const msg = err instanceof Error ? err.message : String(err);
    say(c, `${msg}`);
    show(c.confirmEl, false);
    /*
     * 読めなかったとき。**原因はこちらから見えない**（別の用紙 / 手ブレ / 影 / 画像が粗い）
     * ので、**断定せずに「どこを撮るか」をもう一度出す**。
     * **手入力へは誘導しない** — ここで番号を打たせると、読めなかった回にだけ
     * 打ち間違いが混ざる（§12.1 の admin 訂正が引き受ける）。
     */
    showWrong(c, '番号を読み取れませんでした',
      `${whereText(c)} 明るい場所で、影や反射が入らないように撮り直してください。`);
    return false;
  }
}

/** `review_required` の理由を利用者の言葉にする。**空にしない**（黙って通さない）。 */
export function reasonText(reasons: string[], note: string | null): string {
  const parts: string[] = [];
  if (reasons.includes('barcode_ocr_mismatch')) {
    parts.push('バーコードと印字の番号が食い違っています。番号をお確かめください。');
  }
  /*
   * **`single_source` は出さない**（発注者裁定 2026-10-22・仕様 §12.4.2）。
   * 決定論デコードで読めた回は**印字の OCR が無いのが正常系**なので、
   * 出すと**毎回「片方しか読み取れていません」が出る**。
   * 判定側でも自動確定を妨げない（`NON_BLOCKING_REASONS`）。
   * **理由コードは台帳と監査に残る**（画面に出さないだけ）。
   */
  if (reasons.includes('org_prefix_mismatch')) {
    parts.push('この検査キットの番号ではないようです。お確かめください。');
  }
  if (reasons.includes('pattern_mismatch') || reasons.includes('pattern_unknown')) {
    parts.push('想定の形と違う番号です。お確かめのうえ登録してください。');
  }
  if (note) parts.push(note);
  return parts.join(' ');
}

async function register(c: Ctx, value: string, method: 'camera'): Promise<void> {
  if (c.busy) return;              // 二重 submit よけ（サーバ側も冪等）
  c.busy = true;
  try {
    /*
     * **走っている読み取りを待つ**（§12.4 の案 A）。番号は端末内デコードが先に出すので、
     * **サーバの読み取りが終わる前に押され得る**。登録はサーバが控えた値だけを使う
     * （§12.2）ので、待たずに送ると控えが無く「もう一度撮影してください」になる
     * ＝**読めているのに撮り直させる**ことになる。
     */
    if (c.pending) {
      say(c, '読み取りの確認を待っています…');
      const ok = await c.pending;
      if (!ok) {
        // 読み取りが失敗していた回。案内は `uploadAndRead` が出している。
        c.busy = false;
        return;
      }
    }
    say(c, '登録しています…');
    /*
     * **番号そのものは送らない**（仕様 §12.2 の案 (c)・発注者指示 2026-10-22）。
     * サーバは `read` で控えた読み取り結果を `evidenceKey` で引き直して登録する。
     * ここで値を送っていた頃は、それが `manual` として扱われて
     * **必ず `review_required`（`manual_entry`）になり問診CSV へ 1 件も出なかった**。
     * `confirmedValue` は**画面に出ていた値が古くないかの突き合わせ用**で、
     * 値の出どころではない（サーバは一致しなければ 409 で止める）。
     */
    const r = await post(c, {
      mode: 'register',
      captureMethod: method,
      evidenceKey: c.evidenceKey,
      confirmedValue: value,
    });
    // 成功したら**再読込して状態をサーバから取り直す**（JS で組み立て直さない）。
    say(c, String(r.message ?? '登録しました。'));
    window.location.reload();
  } catch (err) {
    say(c, `登録できませんでした: ${err instanceof Error ? err.message : String(err)}`);
    c.busy = false;
  }
}

/**
 * 別ページの帯から来た回だけ、着いた先でカメラを開く（§4.4.7）。
 * **条件は控えがあること ＋ そのブロックが在る ＋ スマホ ＋ 未登録**。
 * 開けなかったら `openCamera` がボタンを出すので行き止まりにならない。
 */
function resumeStart(): void {
  const id = takeStart();
  if (!id) return;
  const block = document.getElementById(`extid-${id}`);
  if (!block || !block.matches('[data-extid-capture]')) return;
  if (!cameraAvailable()) return;
  const c = ctx(block);
  if (c.formEl?.classList.contains('hidden')) return; // 登録済みの回は開かない
  block.scrollIntoView({ block: 'start' });
  void openCamera(c);
}

export function initExternalIdCapture(): void {
  if (bound) return;
  bound = true;

  // ページを離れるときにカメラを止める（`scan.astro` と同じ扱い）。
  window.addEventListener('pagehide', () => {
    for (const root of document.querySelectorAll<HTMLElement>('[data-extid-capture]')) {
      const c = ctxOf.get(root);
      if (c) closeCamera(c);
    }
  });

  document.addEventListener('click', (e) => {
    const t = e.target as Element | null;

    /*
     * 【催促の帯から 1 タップでカメラへ】発注者指示 2026-10-22
     * 「『カメラで撮影』ボタンのフローを省略して、『撮影して登録する』ボタンだけで
     * 即、カメラを起動して」。
     *
     * 帯（`ExternalIdReminder.astro`）は撮影ブロックの**外**に在るので、
     * 下の `[data-extid-capture]` では拾えない。**ここで先に受ける**。
     *
     * **3 つの場合は何もしない**（`href` の既定の動作＝撮影ブロックへ移動に任せる）:
     *   ① 撮影ブロックがこのページに無い（ダッシュボード → `/kit` へ移動する回）。
     *      **合図を残してリンクに任せる** — 着いた先で `resumeStart` が開く（§4.4.7）。
     *   ② カメラを使えない端末（PC）。下の QR でスマートフォンへ送るのが出口。
     *   ③ 既に登録済みの回。**上書きの確認（§8.3）を飛ばさない**。
     */
    const starter = t?.closest?.('[data-extid-start]') as HTMLElement | null;
    if (starter) {
      const id = starter.getAttribute('data-extid-start') ?? '';
      const block = id ? document.getElementById(`extid-${id}`) : null;
      if (!block || !block.matches('[data-extid-capture]')) {
        /*
         * ①別ページ（ダッシュボード → `/kit`）。**着いた先でカメラを開くための合図**を
         * 残して、リンクはそのまま飛ばす（§4.4.7・押したのは利用者なので
         * 「勝手に開く」には当たらない）。**URL には何も足さない** — 受取 ID が
         * クエリに出てアクセスログへ残るのを避ける（`#extid-…` は元から在る）。
         */
        rememberStart(id);
        return;
      }
      if (!cameraAvailable()) return; // ②
      const sc = ctx(block);
      if (sc.formEl?.classList.contains('hidden')) return; // ③
      e.preventDefault();
      block.scrollIntoView({ block: 'start', behavior: 'smooth' });
      void openCamera(sc);
      return;
    }

    const root = t?.closest?.('[data-extid-capture]') as HTMLElement | null;
    if (!root) return;

    /*
     * PC 導線: URL のコピー。**撮影の状態機械とは無関係**なので `ctx()` より前で返す
     * (コピーしただけで読み取りの状態を作らない)。失敗しても行き止まりにしない
     * = 選択状態にして手でコピーしてもらう (`scan.astro:1339-1348` と同じ)。
     */
    if (t?.closest?.('[data-extid-share-copy]')) {
      const urlEl = root.querySelector('[data-extid-share-url]') as HTMLInputElement | null;
      const msgEl = root.querySelector('[data-extid-share-msg]') as HTMLElement | null;
      if (!urlEl) return;
      void (async () => {
        try {
          await navigator.clipboard.writeText(urlEl.value);
          if (msgEl) msgEl.textContent = 'コピーしました。スマートフォンのブラウザで開いてください。';
        } catch {
          urlEl.select();
          if (msgEl) msgEl.textContent = 'コピーできませんでした。選択状態にしたので手動でコピーしてください。';
        }
      })();
      return;
    }

    const c = ctx(root);

    /*
     * **登録し直す**（仕様 §8.3「再撮影を第一選択」）。
     * **押しただけでは撮影の面を開かない** — 上書きになることを先に伝えて、
     * 「登録し直す」を押してもらってから面を入れ替える。
     */
    if (t?.closest?.('[data-extid-redo-open]')) {
      /*
       * **1 押しでカメラまで行く**（§4.4.7）。§4.4.3 の上書き確認はこの裁定で外した。
       * 上書きしても**前の番号は台帳に残る**（`previous_value`）ので取り返しはつく。
       * 画面には「撮り直すと … を上書きします」をボタンの下に常時出してある。
       */
      // 登録済みの面を畳んで撮影の面を出す。**値は消さない**（登録に失敗しても元の登録は残る）。
      show(c.doneEl, false);
      show(c.formEl, true);
      clearWrong(c);
      show(c.confirmEl, false);
      c.evidenceKey = null; c.captureMethod = 'camera';
      say(c, 'もう一度撮影してください。登録すると今の番号を上書きします。');
      /*
       * **ここでカメラを開く**（発注者指示 2026-10-22・仕様 §4.4.6）。
       * 「登録し直す」自体が利用者の press なので、**もう 1 枚ボタンを挟まない**。
       * この面のボタンはサーバが `hidden` で出しており、開けなかったときだけ出る。
       */
      void openCamera(c);
      return;
    }

    if (t?.closest?.('[data-extid-camera-open]')) {
      void openCamera(c);
      return;
    }
    if (t?.closest?.('[data-extid-camera-close]')) {
      closeCamera(c);
      return;
    }
    if (t?.closest?.('[data-extid-shot]')) {
      void c.camera?.capture();
      return;
    }

    /*
     * **登録（書き込み）はここだけ**（§4.4.8）。読み取りは自動で進むが、
     * **DB と台帳へ書くのは本人が番号を見て押したときだけ**にする。
     */
    if (t?.closest?.('[data-extid-register]')) {
      const v = c.candidateEl?.textContent?.trim() ?? '';
      if (!v) { say(c, '登録できる番号がありません。'); return; }
      void register(c, v, c.captureMethod);
      return;
    }
    if (t?.closest?.('[data-extid-retake]')) {
      c.evidenceKey = null;
      clearWrong(c);
      show(c.confirmEl, false);
      say(c, 'もう一度撮影してください。');
      // **撮り直しもその場でカメラを開く**（§4.4.6・ボタンを挟まない）。
      void openCamera(c);
      return;
    }
  });

  // **別ページの帯から来た回だけ**カメラを開く（合図が無ければ何もしない）。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', resumeStart, { once: true });
  } else {
    resumeStart();
  }
}
