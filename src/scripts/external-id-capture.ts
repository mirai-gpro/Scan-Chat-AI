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
 *   - **「写真を選ぶ」を撤去**した。ファイル選択の `change` 経路も一緒に消えたので、
 *     画面から入る口は**アプリ内カメラと手入力の 2 つだけ**。
 *     サーバは `captureMethod: 'file'` を受け続ける（既存の台帳行と DB の check 制約）。
 *   - **登録済みでも「登録し直す」から撮り直せる**ようにした（仕様 §8.3）。
 *     API は以前から撮り直しに対応しているので、**ここで足したのは面の出し入れだけ**。
 */

import { initCameraScan, type CameraScanController } from './camera-scan';

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
  manualEl: HTMLElement | null;
  /** 「別の用紙／別の数字かもしれません」の案内。 */
  wrongEl: HTMLElement | null;
  /** アプリ内カメラの面と、その中の要素。 */
  cameraEl: HTMLElement | null;
  videoEl: HTMLVideoElement | null;
  canvasEl: HTMLCanvasElement | null;
  cameraStatusEl: HTMLElement | null;
  /** `/scan` と同じコントローラ。**押されるまで作らない**（作っただけでは起動しない）。 */
  camera: CameraScanController | null;
  inputEl: HTMLInputElement | null;
  /** 登録済みの面 / 撮影の面 / 登録し直すの確認。**登録済みでも両方 markup は在る**。 */
  doneEl: HTMLElement | null;
  formEl: HTMLElement | null;
  redoEl: HTMLElement | null;
  /** 直近の読み取り結果（登録時にサーバへ戻す）。 */
  read: { barcode: string | null; printed: string | null } | null;
  evidenceKey: string | null;
  /** 発行元の接頭辞（`704`＝Wellfort）。**サーバが返した値だけを使う**（焼き込まない）。 */
  orgPrefix: string;
  /** 画面から送るのは `camera` と `manual` の 2 つだけ（`file` の経路は撤去済み）。 */
  captureMethod: 'camera' | 'manual';
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
    manualEl: q('[data-extid-manual]'),
    wrongEl: q('[data-extid-wrong]'),
    cameraEl: q('[data-extid-camera]'),
    videoEl: q<HTMLVideoElement>('[data-extid-video]'),
    canvasEl: q<HTMLCanvasElement>('[data-extid-canvas]'),
    cameraStatusEl: q('[data-extid-camera-status]'),
    camera: null,
    inputEl: q<HTMLInputElement>('[data-extid-input]'),
    doneEl: q('[data-extid-done]'),
    formEl: q('[data-extid-form]'),
    redoEl: q('[data-extid-redo-confirm]'),
    read: null,
    evidenceKey: null,
    orgPrefix: '',
    captureMethod: 'camera',
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
    say(c, 'この端末ではカメラを使えません。「番号を手で入力する」からご登録ください。');
    show(c.manualEl, true);
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
        // **行き止まりにしない** — 権限拒否・カメラ無しはここに来る。
        say(c, `${message} 「番号を手で入力する」からご登録ください。`);
        show(c.manualEl, true);
      },
    });
  }
  show(c.cameraEl, true);
  await c.camera.start();
}

async function captureAndRead(c: Ctx, file: File): Promise<boolean> {
  clearWrong(c);
  say(c, '写真を送っています…');
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
    // S3 未設定 / CORS 未設定 / 回線断 は**区別できない**。手入力へ落とす。
    say(c, `写真を送れませんでした。${c.idLabel}を手で入力してください。`);
    c.captureMethod = 'manual';
    show(c.manualEl, true);
    show(c.confirmEl, false);
    void err;
    return false;
  }

  c.evidenceKey = key;
  say(c, '番号を読み取っています…');
  try {
    const r = await post(c, { mode: 'read', evidenceKey: key });
    const candidate = String(r.candidate ?? '');
    c.read = {
      barcode: null,
      printed: null,
    };
    // サーバは採った値だけを返す。登録時は**同じ値**を manual として送り直す
    // （サーバ側でもう一度 evaluate されるので、判定はサーバが正）。
    if (c.candidateEl) c.candidateEl.textContent = candidate;
    const reasons = Array.isArray(r.review_reasons) ? (r.review_reasons as string[]) : [];
    c.orgPrefix = typeof r.org_prefix === 'string' ? r.org_prefix : '';
    if (c.noteEl) c.noteEl.textContent = reasonText(reasons, typeof r.note === 'string' ? r.note : null);
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
    show(c.manualEl, false);
    say(c, '');
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    say(c, `${msg}`);
    show(c.confirmEl, false);
    show(c.manualEl, true);
    /*
     * 読めなかったとき。**原因はこちらから見えない**（別の用紙 / 手ブレ / 影 / 画像が粗い）
     * ので、**断定せずに「どこを撮るか」をもう一度出す**。手入力も開いてあるので
     * 行き止まりにはならない。
     */
    showWrong(c, '番号を読み取れませんでした', `${whereText(c)} うまくいかないときは、下の欄に手で入力してください。`);
    return false;
  }
}

/** `review_required` の理由を利用者の言葉にする。**空にしない**（黙って通さない）。 */
export function reasonText(reasons: string[], note: string | null): string {
  const parts: string[] = [];
  if (reasons.includes('barcode_ocr_mismatch')) {
    parts.push('バーコードと印字の番号が食い違っています。番号をお確かめください。');
  }
  if (reasons.includes('single_source')) {
    parts.push('片方しか読み取れていません。番号をお確かめください。');
  }
  if (reasons.includes('org_prefix_mismatch')) {
    parts.push('この検査キットの番号ではないようです。お確かめください。');
  }
  if (reasons.includes('pattern_mismatch') || reasons.includes('pattern_unknown')) {
    parts.push('想定の形と違う番号です。お確かめのうえ登録してください。');
  }
  if (note) parts.push(note);
  return parts.join(' ');
}

async function register(c: Ctx, value: string, method: 'camera' | 'manual'): Promise<void> {
  if (c.busy) return;              // 二重 submit よけ（サーバ側も冪等）
  c.busy = true;
  say(c, '登録しています…');
  try {
    const r = await post(c, {
      mode: 'register',
      manual: value,
      captureMethod: method,
      evidenceKey: c.evidenceKey,
    });
    // 成功したら**再読込して状態をサーバから取り直す**（JS で組み立て直さない）。
    say(c, String(r.message ?? '登録しました。'));
    window.location.reload();
  } catch (err) {
    say(c, `登録できませんでした: ${err instanceof Error ? err.message : String(err)}`);
    c.busy = false;
  }
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
      show(c.redoEl, true);
      return;
    }
    if (t?.closest?.('[data-extid-redo-no]')) {
      show(c.redoEl, false);
      return;
    }
    if (t?.closest?.('[data-extid-redo-yes]')) {
      // 登録済みの面を畳んで撮影の面を出す。**値は消さない**（登録に失敗しても元の登録は残る）。
      show(c.redoEl, false);
      show(c.doneEl, false);
      show(c.formEl, true);
      clearWrong(c);
      show(c.confirmEl, false);
      show(c.manualEl, false);
      c.read = null; c.evidenceKey = null; c.captureMethod = 'camera';
      say(c, 'もう一度撮影してください。登録すると今の番号を上書きします。');
      return;
    }

    /*
     * 手入力の欄を開く。**撮影の代わりではなく逃げ道**なので、ここでは何も送らない
     * （「写真を選ぶ」を撤去した 2026-10-21 以降、カメラの無い端末の唯一の口）。
     */
    if (t?.closest?.('[data-extid-manual-open]')) {
      show(c.manualEl, true);
      c.inputEl?.focus();
      say(c, `${c.idLabel}を入力して登録してください。`);
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

    if (t?.closest?.('[data-extid-register]')) {
      const v = c.candidateEl?.textContent?.trim() ?? '';
      if (!v) { say(c, '登録できる番号がありません。'); return; }
      void register(c, v, c.captureMethod);
      return;
    }
    if (t?.closest?.('[data-extid-retake]')) {
      c.read = null; c.evidenceKey = null;
      clearWrong(c);
      show(c.confirmEl, false); show(c.manualEl, false);
      say(c, 'もう一度撮影してください。');
      return;
    }
    if (t?.closest?.('[data-extid-edit]')) {
      if (c.inputEl) c.inputEl.value = c.candidateEl?.textContent?.trim() ?? '';
      show(c.manualEl, true);
      say(c, '番号を直してから登録してください。');
      return;
    }
    if (t?.closest?.('[data-extid-register-manual]')) {
      const v = c.inputEl?.value?.trim() ?? '';
      if (!v) { say(c, `${c.idLabel}を入力してください。`); return; }
      void register(c, v, 'manual');
      return;
    }
  });
}
