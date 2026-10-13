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
 */

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
  inputEl: HTMLInputElement | null;
  /** 直近の読み取り結果（登録時にサーバへ戻す）。 */
  read: { barcode: string | null; printed: string | null } | null;
  evidenceKey: string | null;
  captureMethod: 'camera' | 'file' | 'manual';
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
    inputEl: q<HTMLInputElement>('[data-extid-input]'),
    read: null,
    evidenceKey: null,
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
  prevent: '同梱の IDシートにある「ユーザーID」の印字と、その近くの横線のバーコードを、書面全体が入るように撮ってください。QRコードは読み取りません。',
};
function whereText(c: Ctx): string {
  return WHERE[c.provider] ?? '用紙全体が入るように撮り直してください。';
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
    if (c.noteEl) c.noteEl.textContent = reasonText(reasons, typeof r.note === 'string' ? r.note : null);
    /*
     * **形が想定と違う = 別の数字を読んだ可能性が高い。**
     * 用紙には電話番号や管理用の記号も印字されているので、ここで図へ戻す。
     * ただし**候補は出したままにする** — 実物の形式が既定と違うだけのこともあり、
     * その回を登録できなくすると撮影そのものが無駄になる。
     */
    if (reasons.includes('pattern_mismatch') || reasons.includes('pattern_unknown')) {
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
  if (reasons.includes('pattern_mismatch') || reasons.includes('pattern_unknown')) {
    parts.push('想定の形と違う番号です。お確かめのうえ登録してください。');
  }
  if (note) parts.push(note);
  return parts.join(' ');
}

async function register(c: Ctx, value: string, method: 'camera' | 'file' | 'manual'): Promise<void> {
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

  // ファイル選択（カメラ / 写真）
  document.addEventListener('change', (e) => {
    const input = (e.target as Element | null)?.closest?.('input[data-extid-file]') as HTMLInputElement | null;
    if (!input) return;
    const root = input.closest('[data-extid-capture]') as HTMLElement | null;
    if (!root) return;
    const c = ctx(root);
    const file = input.files?.[0];
    // **押した時点で捨てない**（ダイアログを閉じただけで状態を失わせない）。
    if (!file) return;
    c.captureMethod = input.dataset.extidFile === 'camera' ? 'camera' : 'file';
    void captureAndRead(c, file);
    input.value = '';              // 同じファイルを選び直せるように
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
