/**
 * `npm run verify:screen` — **画面の実測**。
 *
 * `verify:sheet-contract` は「モック ↔ 表示モデル」までしか見ない。
 * **表示モデルが正しくても、`.astro` が描き落とせば画面は空になる。**
 * ここで「表示モデル ↔ 実際の画面」を閉じ、併せて幅を測る。
 *
 * 見るのは 4 つだけ:
 *   ① 契約の文が**実際に画面に出ている**こと (レンダラの描き落としの検知)
 *   ② `/report` の器の幅が `/dashboard` と**全ブレークポイントで一致**すること
 *      — 幅は実際に 1 度壊れた (`/report` だけ `width="flow"` で 672px 止まり・spec §9.3.2)
 *   ③ **紙面が 1000px を超えない**こと・ダイジェスト本文の行長が 45em (=720px) を超えないこと
 *      — 裁定 2026-09-05 (spec §4.3.5)。器はダッシュボードと同じまま、紙面だけ 1000px で止める。
 *        **紙面と行長はセットで見る** — 紙面だけ広げて行長を据え置くと本文が紙面の 61% しか
 *        使わず「白い紙が大きくなっただけ」になる (実測)。片方だけ直すと静かにそうなる。
 *   ④ **紙面 (白いシート) が地の上に在る**こと (仕様書 §4.3.5)
 *      — ここが**実際に抜けていた**。色や見出しや表の型は入っていたのに、
 *        それを載せる紙が無く「アプリの画面に要素が並んでいるだけ」で、
 *        ①②③ は全部通っていた (2026-08-30・発注者指摘「モックと全く違う」)。
 *        **だから "紙が在るか" だけは見る。** 色の細部・余白・影は見ない
 *        (デザインの微調整で落ちる検査は誰も直さなくなる)。
 *
 * 前提: `npm run dev` が起動していること。URL は `VERIFY_URL` で差し替えられる。
 */

import { readFileSync } from 'node:fs';
import { chromium, devices } from 'playwright';

const BASE = process.env.VERIFY_URL ?? 'http://localhost:4321';
const EXEC = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
// 行長の上限 = 45em (16px * 45)。**印刷も同じ 45em まで使う** (発注者指示 2026-10-07)。
const MAX_PROSE = 720;
// 紙面の上限 = 62.5rem。器がこれより狭い端末では発火しない (スマホ・タブレット)。
const MAX_SHEET = 1000;
/*
 * **印刷の組版** (発注者指示 2026-10-07・spec §4.3.7)。**目的はページ数 20。**
 * 旧裁定の 38em = 608px に戻ったら落とす。**ページ数が増えるのに画面はまったく
 * 正常に見える**ので、人の目では守れない。1280px のビューポートでは `44rem` が当たる。
 *
 * **級数と行送りも対で見る** — 行長だけ戻しても、級数が 16px へ戻れば 29 ページに
 * 戻る (実測: 行長 +17% だけでは 30→29 の 1 ページしか減らなかった)。
 */
/*
 * 下限は **680px**。608 (38em) だけでなく **`em` へ戻した退行も捕まえる**ため —
 * `45em` のままだと 14px × 45 = **630px** になり、609 では素通りした (実測)。
 * 44rem = 704px なので 680 なら左右余白の微調整には耐える。
 */
const PRINT_PROSE_MIN = 680;
/*
 * **級数の階層** (spec §4.3.7)。発注者:「ページ数が目的じゃない。読み易くするのが真の狙い」。
 *   - **ダイジェスト = 読む部分。紙でも画面と同じ 16px** (ここを縮めたら目的に反する)。
 *   - **全編 = 巻末の全文 = 参照用の付録。紙だけ 14px** (紙面の高さの 87% がここ)。
 * **この 2 つを別に見張るのが要点** — 一律に下げてページ数だけ合わせる退行を捕まえる。
 */
const DIGEST_PX = 16, ZENPEN_PRINT_PX = 14, ZENPEN_SCREEN_PX = 16;
/** 出典の級数。画面 13px / 紙 11px (発注者指示。ページ数への寄与はほぼ 0)。 */
const SRC_PRINT = 11, SRC_SCREEN = 13;

const SIZES = [
  [1440, 900, 'PC 1440'],
  [1280, 800, 'PC 1280'],
  [834, 1112, 'iPad 縦 834'],
  [768, 1024, 'タブレット 768'],
  [393, 852, 'スマホ 393'],
];

const fails = [];

/** 契約のカードごとに、画面に出ているべき文をばらす (タブ区切りのセルも 1 つずつ)。 */
function contractCards() {
  const c = JSON.parse(readFileSync('docs/elith/mock/sheet_contract_type2.json', 'utf-8'));
  return c.cards.map((card) => {
    const texts = card.title ? [card.title] : [];
    for (const b of card.blocks) {
      for (const line of [...(b.items ?? []), ...(b.rows ?? [])]) {
        for (const cell of line.split('\t')) if (cell.trim()) texts.push(cell);
      }
    }
    return { key: card.key, texts };
  });
}

let browser;
try {
  browser = await chromium.launch({ executablePath: EXEC });
} catch {
  browser = await chromium.launch();
}

const shellWidth = async (page, path) => {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  return page.evaluate(() =>
    Math.round(document.querySelector('body > div').getBoundingClientRect().width));
};

// ── ① 契約の文が画面に出ているか (レンダラの描き落としの検知) ──────────
//
/*
 * 契約は**タイプ 2 の検体**の紙面なので、**タイプ 2 の紙面 (`/report?preview=2`) と突き合わせる。**
 * 既定の `/report` は 2026-09-01 から**タイプ 1** になった (発注者指示) ため、
 * 既定の画面に型 2 の契約を当てると全項目が不一致になる。契約は検体ごとのものなので、
 * **契約と同じ検体を出す URL に当てる**のが筋。
 *
 * 【2026-08-30 修正・重要】ここには以前、
 *   「ローカル/デモ層はがんリスク検査を持つのでタイプ 1 になり、主軸 A は出ないのが正」
 * と書いてあり、**A 軸のカードが出ないことを合格条件にしていた**。
 * ところがそれは仕様ではなく**不具合**だった —
 * デモが貸した真鍋の `cancer_urine` artifact を拾って `hasCancerRisk: true` になり、
 * タイプ 1 (未実装) に反転して A 軸が消えていた (実測: 本番 admin で `vm_digest` 6 枚が全て B)。
 * **検証が不具合を「正」として取り込んでいたため、全部緑なのに紙面が違う**状態が続いた。
 * → デモ表示は `report.astro` でタイプ 2 に固定した。ここでは**それを機械で見張る**。
 */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/report?preview=2`, { waitUntil: 'domcontentloaded' });
  // 全編は `<details>` で畳まれているが DOM には在るので innerText でなく textContent。
  const raw = await page.evaluate(() => document.body.textContent ?? '');
  const body = raw.replace(/\s+/g, '');
  const isType1 = body.includes('がんリスク検査の結果を見る');
  if (isType1) {
    console.log('✗ ?preview=2 がタイプ 1 になっている — 切替が効いていない');
    fails.push('?preview=2 でタイプ 2 の紙面が出ていない');
  } else {
    console.log('✓ ?preview=2 の紙面のタイプ: 2 (がんリスク検査なし)');
  }

  /*
   * **既定の `/report` はタイプ 1** (発注者指示 2026-09-01)。
   * 既定が入れ替わったことを名指しで見張る — 以前ここは「タイプ 2 が正」だった。
   */
  await page.goto(`${BASE}/report?preview=1`, { waitUntil: 'domcontentloaded' });
  /*
   * 【2026-09-18・発注者指示】**「今回の所見」を廃止した。**
   *
   * ここは「がんリスク検査の項目名を含む文を当社が選び、『今回の所見』という
   * 当社の見出しの下に置く」ことを**緑で固定していた**。文は逐語でも、
   * **選んで名前を付ければ解釈**なので、カードごと撤去した
   * (「今回の所見」は受領 JSON に 0 件)。
   *
   * → 検査も**逆向き**に変える: このカードが**出ていないこと**と、
   *   拾っていた文が**全編にそのまま残っていること** (黙って消していない) を見る。
   */
  const t1A = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('.rp-card')]
      .filter((c) => (c.querySelector('.rp-h3')?.textContent ?? '').includes('今回の所見')).length,
    body: document.body.textContent ?? '',
  }));
  const t1Ok = t1A.cards === 0 && t1A.body.includes('尿中のポルフィリン量');
  console.log(`${t1Ok ? '✓' : '✗'} ?preview=1「今回の所見」を出さず、文は紙面に残る (カード ${t1A.cards} 枚)`);
  if (!t1Ok) {
    fails.push(t1A.cards > 0
      ? '?preview=1 に「今回の所見」のカードが出ている (受領 JSON に無い当社の見出し)'
      : '?preview=1 から「尿中のポルフィリン量」の文が消えた (黙って落としている)');
  }

  /*
   * **紙面に「判定」「基準値」の列と空欄の「—」を作らない** (2026-09-18)。
   * 受領ファイルに無い欄を当社が作り、空欄に「—」を置いて
   * "欄はあるが該当なし" に見せていたのが捏造だった。**実際の画面**で見る
   * (表示モデルが正しくてもレンダラが列を描けば紙面には出るため)。
   */
  const cols = await page.evaluate(() => {
    const th = [...document.querySelectorAll('.rp-sheet table th')].map((e) => e.textContent?.trim() ?? '');
    const cells = [...document.querySelectorAll('.rp-sheet table td')].map((e) => e.textContent?.trim() ?? '');
    return { th: [...new Set(th)], dash: cells.filter((t) => t === '—' || t === '-').length };
  });
  const colsOk = !cols.th.some((t) => /判定|基準/.test(t)) && cols.dash === 0;
  console.log(`${colsOk ? '✓' : '✗'} 表の列 = ${cols.th.join(' / ')} / 空欄の「—」 ${cols.dash} 件`);
  if (!colsOk) fails.push(`表に受領 JSON に無い欄がある (列: ${cols.th.join(',')} / 「—」${cols.dash} 件)`);

  /*
   * **ウェルネス年齢は画面にも出る** (裁定 D-C2′・発注者指示 2026-09-01)。
   * 当初は `?print=1` のみだったが、「画面と PDF で表示が違う違和感」から見直した。
   * ここが落ちたら**画面だけ冒頭が空**になっている。
   */
  const wa = await page.evaluate(() => ({
    nums: document.querySelectorAll('.rp-num').length,
    gauge: !!document.querySelector('.rp-gauge'),
  }));
  const waOk = wa.nums === 2 && wa.gauge;
  console.log(`${waOk ? '✓' : '✗'} 画面の冒頭にウェルネス年齢 (大数字 ${wa.nums} 枚 / 数直線 ${wa.gauge ? '有' : '無'})`);
  if (!waOk) fails.push('画面の冒頭にウェルネス年齢のセクションが無い (裁定 D-C2′)');

  /*
   * **詳細への導線** (発注者裁定 2026-09-01・案 03「カード下端の淡色バー」)。
   * ここは 3 つとも落ちうる: ①画面に出ない ②飛び先が実在しない ③印刷に出てしまう。
   * 特に③は「紙に押せないボタンが印字される」ので、名指しで見張る。
   */
  await page.goto(`${BASE}/report?preview=1`, { waitUntil: 'domcontentloaded' });
  const jump = await page.evaluate(() => {
    const bars = [...document.querySelectorAll('.rp-jump')];
    const cards = document.querySelectorAll('article.rp-card').length;
    const dead = bars.filter((a) => !document.querySelector(a.getAttribute('href') ?? '#'));
    const minH = Math.min(...bars.map((a) => a.getBoundingClientRect().height));
    return { bars: bars.length, cards, dead: dead.length, minH: Math.round(minH) };
  });
  const jumpOk = jump.bars > 0 && jump.dead === 0 && jump.minH >= 44;
  console.log(`${jumpOk ? '✓' : '✗'} 詳細への導線 ${jump.bars} 本 / カード ${jump.cards} 枚 / 飛び先なし ${jump.dead} / 最小高 ${jump.minH}px`);
  if (!jumpOk) fails.push(`詳細への導線: ${jump.bars} 本・飛び先なし ${jump.dead}・最小高 ${jump.minH}px`);

  await page.goto(`${BASE}/report?preview=1&print=1`, { waitUntil: 'domcontentloaded' });
  const inPrint = await page.evaluate(() => document.querySelectorAll('.rp-jump').length);
  console.log(`${inPrint === 0 ? '✓' : '✗'} 印刷ビューに導線を出さない (${inPrint} 本)`);
  if (inPrint !== 0) fails.push(`印刷ビューに導線が ${inPrint} 本出ている (押せないボタンが紙に載る)`);

  /*
   * **「手元に残す」は端末別** (裁定 2026-09-02・案 1＋案 3)。ここも 3 つとも落ちうる:
   * ①手順が 1 端末ぶんしか描かれていない (以前の iPhone 決め打ちに戻る)
   * ②判定できない環境で画面が空になる (fail-safe が壊れる)
   * ③手順が印刷ビューに出る = **保存した PDF に操作説明が載る** (spec §4.4)。
   * Linux の Chromium は Windows/Mac/iOS/Android のどれでもないので、
   * **この検証はいつも「判定できない」経路を通る** = fail-safe をそのまま見張ることになる。
   */
  await page.goto(`${BASE}/report?preview=1`, { waitUntil: 'domcontentloaded' });
  const save = await page.evaluate(() => {
    const sec = document.getElementById('save-section');
    if (!sec) return null;
    const guides = [...sec.querySelectorAll('[data-save-guide]')];
    const go = sec.querySelector('[data-save-go]');
    const picker = sec.querySelector('[data-save-picker]');
    return {
      guides: guides.length,
      visible: guides.filter((g) => g.getBoundingClientRect().height > 0).length,
      steps: sec.querySelectorAll('.rp-steps > li').length,
      go: go ? go.getAttribute('href') : null,
      goH: go ? Math.round(go.getBoundingClientRect().height) : 0,
      pickerOpen: picker ? !picker.hidden : false,
    };
  });
  const saveOk = !!save && save.guides === 4 && save.visible === 4
    && save.pickerOpen && !!save.go?.includes('print=1') && save.goH >= 44;
  console.log(save
    ? `${saveOk ? '✓' : '✗'} 手元に残す: 端末 ${save.guides} 種 / 見えている ${save.visible} / 手順 ${save.steps} 行 / 4択 ${save.pickerOpen ? '有' : '無'} / ボタン ${save.goH}px → ${save.go}`
    : '✗ 手元に残す: セクションが無い');
  if (!saveOk) fails.push(`手元に残す: ${save ? JSON.stringify(save) : 'セクションが無い'}`);

  await page.goto(`${BASE}/report?preview=1&print=1`, { waitUntil: 'domcontentloaded' });
  const saveInPrint = await page.evaluate(() => ({
    sec: document.querySelectorAll('#save-section').length,
    steps: document.querySelectorAll('.rp-steps > li').length,
  }));
  const sipOk = saveInPrint.sec === 0 && saveInPrint.steps === 0;
  console.log(`${sipOk ? '✓' : '✗'} 印刷ビューに保存手順を出さない (節 ${saveInPrint.sec} / 手順 ${saveInPrint.steps} 行)`);
  if (!sipOk) fails.push(`印刷ビューに保存手順が出ている (節 ${saveInPrint.sec} / 手順 ${saveInPrint.steps} 行) = 保存した PDF に操作説明が載る`);
  await page.goto(`${BASE}/report?preview=2`, { waitUntil: 'domcontentloaded' });

  /*
   * **「今回の所見」の枚数が紙面の正 (モックの契約) と一致すること。**
   * ここは実際に落ちていた箇所なので名指しで見る。
   *
   * 【2026-09-17】①パイロット暫定文 (当社が書いた 2 文) の削除で**材料が無い回は
   * 0 枚が正**になり ②軸 A の廃止で軸では引けなくなった。決め打ちをやめ、
   * **契約のカード key** と突き合わせる — 当社の文が紙面へ戻ったときも、
   * Elith の所見が黙って消えたときも、どちらでも落ちる。
   */
  const contract2 = JSON.parse(readFileSync('docs/elith/mock/sheet_contract_type2.json', 'utf-8'));
  const axisAExpected = contract2.cards.filter((c) => c.key === 'cancer_finding').length;
  const axisA = await page.evaluate(() => ({
    // 廃止した軸 A の痕跡 (帯の見出し・丸バッジ) が紙面に残っていないこと。
    oldBand: [...document.querySelectorAll('.rp-axis')]
      .some((b) => (b.textContent ?? '').includes('初期がんの早期発見')),
    badges: document.querySelectorAll('.rp-badge').length,
    bands: document.querySelectorAll('.rp-axis').length,
    cards: [...document.querySelectorAll('.rp-card')]
      .filter((c) => (c.querySelector('.rp-h3')?.textContent ?? '').includes('今回の所見')).length,
  }));
  if (axisA.oldBand) {
    console.log('✗ 廃止した軸 A の帯が画面に残っている');
    fails.push('軸 A (初期がんの早期発見) は廃止したのに帯が出ている');
  } else if (axisA.badges !== 0) {
    console.log(`✗ 丸バッジ (A/B) が ${axisA.badges} 個出ている`);
    fails.push(`丸バッジ (A/B) は廃止したのに ${axisA.badges} 個出ている`);
  } else if (axisA.bands !== 1) {
    console.log(`✗ 軸の帯が ${axisA.bands} 本 (1 本が正)`);
    fails.push(`軸の帯が ${axisA.bands} 本 — 軸 A の廃止後は 1 本が正`);
  } else if (axisA.cards !== axisAExpected) {
    console.log(`✗ 「今回の所見」が ${axisA.cards} 枚 (契約は ${axisAExpected} 枚)`);
    fails.push(`「今回の所見」が 画面 ${axisA.cards} 枚 / 契約 ${axisAExpected} 枚 で食い違う`);
  } else {
    console.log(`✓ 軸の帯 1 本・バッジ 0 個・「今回の所見」${axisA.cards} 枚 (契約どおり)`);
  }

  for (const card of contractCards()) {
    const missing = card.texts.filter((t) => !body.includes(t.replace(/\s+/g, '')));
    if (missing.length) {
      console.log(`✗ ${card.key} — 画面に出ていない文 ${missing.length}/${card.texts.length} 件`);
      for (const m of missing.slice(0, 5)) fails.push(`${card.key}: 画面に無い「${m.slice(0, 36)}」`);
    } else {
      console.log(`✓ ${card.key}`);
    }
  }
  await ctx.close();
}

// ── ④ 紙面が在るか ────────────────────────────────────────────
// 「白い紙が地の上に在る」ことだけを見る。**幅は下の ②③ が見る**
// (裁定 2026-09-05 で紙面は器と一致しなくなった = 器 1280px / 紙面 1000px)。
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/report`, { waitUntil: 'networkidle' });
  const sheet = await page.evaluate(() => {
    const el = document.querySelector('main.rp-sheet');
    if (!el) return null;
    return {
      paper: getComputedStyle(el).backgroundColor,
      ground: getComputedStyle(document.body).backgroundColor,
      cover: !!document.querySelector('.rp-cover'),
      inner: !!document.querySelector('.rp-inner'),
    };
  });
  if (!sheet) {
    fails.push('紙面 (main.rp-sheet) が無い — 紙が無く要素が並んでいるだけになっている');
    console.log('✗ 紙面           main.rp-sheet が無い');
  } else {
    const ok = sheet.paper !== sheet.ground && sheet.cover && sheet.inner;
    console.log(`${ok ? '✓' : '✗'} 紙面           紙=${sheet.paper} 地=${sheet.ground} 表紙=${sheet.cover} 本文枠=${sheet.inner}`);
    if (sheet.paper === sheet.ground) fails.push('紙面と地が同色 — 紙が地に浮いて見えない');
    if (!sheet.cover) fails.push('表紙 (.rp-cover) が無い');
    if (!sheet.inner) fails.push('本文の左右マージン (.rp-inner) が無い');
  }
  await ctx.close();
}

// ── ②③ 幅と行長 ──────────────────────────────────────────────
for (const [width, height, label] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const dash = await shellWidth(page, '/dashboard');
  const report = await shellWidth(page, '/report');
  const m = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.report-prose')];
    const sh = document.querySelector('main.rp-sheet');
    return {
      prose: els.length ? Math.max(...els.map((e) => Math.round(e.getBoundingClientRect().width))) : null,
      sheet: sh ? Math.round(sh.getBoundingClientRect().width) : null,
    };
  });
  const prose = m.prose;
  // 紙面は「器」と「1000px」の小さいほう。器が 1000px より狭い端末では器がそのまま紙面。
  const wantSheet = Math.min(report, MAX_SHEET);

  const okShell = dash === report;
  const okSheet = m.sheet === wantSheet;
  const okProse = prose === null || prose <= MAX_PROSE;
  /*
   * **紙面が上限に達している幅では、本文もちょうど 45em であること。**
   * 上限だけ見ていると「紙面 1000px / 行長 38em」への逆戻り (本文が紙面の 61%) を
   * 見逃す。紙面と行長はセットで決めた裁定なので、片方だけ戻ったら落とす。
   */
  const okPair = m.sheet !== MAX_SHEET || prose === MAX_PROSE;
  const ok = okShell && okSheet && okProse && okPair;
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(14)} 器 dash=${dash} report=${report} / 紙面=${m.sheet ?? '-'} (期待 ${wantSheet}) / 本文=${prose ?? '-'}px`);
  if (!okShell) {
    fails.push(`${label}: 器の幅が違う (dashboard ${dash}px / report ${report}px)`);
  }
  if (!okSheet) {
    fails.push(`${label}: 紙面が ${m.sheet}px (期待 ${wantSheet}px) — 紙面は器と 1000px の小さいほう`);
  }
  if (!okProse) {
    fails.push(`${label}: 本文の行長が ${prose}px で上限 ${MAX_PROSE}px を超えた`);
  }
  if (!okPair) {
    fails.push(`${label}: 紙面が上限 ${MAX_SHEET}px なのに本文が ${prose}px `
      + `(期待 ${MAX_PROSE}px = 45em) — 紙面だけ広げて行長を戻すと本文が紙面の 61% しか使わない`);
  }
  await ctx.close();
}

// ── ③′ 印刷は横幅を広く・出典は小さく ─────────────────────────
/*
 * **発注者指示 2026-10-07 (spec §4.3.7)**: 紙のページ数を減らすため、
 * 印刷だけ ①本文の行長を 38em → 45em ②出典の級数を 13px → 11px にした。
 * **2026-09-05 の「印刷は 38em に据え置く」と禁止事項「12px 以下を作らない」を、
 * 発注者が明示的に上書きしたもの。**
 *
 * ここを**画面と対で見張る**のが要点 — 印刷だけ下げたはずの級数が画面にも
 * 効いていたら、禁止事項を破ったまま誰も気づかない (画面は小さくなるだけで
 * エラーにならない)。だから「紙は小さい / 画面は 13px のまま」を両方固定する。
 */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const read = async (url) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    return page.evaluate(() => {
      const els = [...document.querySelectorAll('.report-prose')];
      const src = document.querySelector('.rp-src');
      const body = document.querySelector('.rp-sheet .report-prose');
      const st = body ? getComputedStyle(body) : null;
      return {
        prose: els.length ? Math.max(...els.map((e) => Math.round(e.getBoundingClientRect().width))) : null,
        src: src ? Math.round(parseFloat(getComputedStyle(src).fontSize)) : null,
        pad: Math.round(parseFloat(getComputedStyle(document.querySelector('.rp-inner')).paddingLeft)),
        body: st ? Math.round(parseFloat(st.fontSize)) : null,
        lh: st ? Math.round(parseFloat(st.lineHeight)) : null,
        zenpen: (() => {
          const z = document.querySelector('.rp-sheet .md-region p');
          return z ? Math.round(parseFloat(getComputedStyle(z).fontSize)) : null;
        })(),
      };
    });
  };
  const pr = await read(`${BASE}/report?preview=1&print=1`);
  const sc = await read(`${BASE}/report?preview=1`);

  const wOk = pr.prose !== null && pr.prose >= PRINT_PROSE_MIN;
  console.log(`${wOk ? '✓' : '✗'} 印刷の行長      ?print=1 の本文=${pr.prose ?? '-'}px (38em=608px へ戻っていないこと)`);
  if (!wOk) {
    fails.push(`?print=1 の行長が ${pr.prose}px — A4 の本文領域 (約 704px) を使い切っていない。`
      + '旧裁定の 38em か、`em` 指定 (級数ダウンで一緒に縮む) に戻っていないか見る。'
      + '紙は 44rem (ページ数が増えるのに画面は正常に見えるので気づけない)');
  }

  const padOk = pr.pad !== null && pr.pad < sc.pad;
  console.log(`${padOk ? '✓' : '✗'} 印刷の左右余白  紙=${pr.pad}px / 画面=${sc.pad}px (紙のほうが狭いこと)`);
  if (!padOk) {
    fails.push(`?print=1 の .rp-inner の左右余白が ${pr.pad}px で画面 (${sc.pad}px) より狭くない`
      + ' — report.astro の PRINT_SIDE_PAD が効いていない');
  }

  /*
   * ① **読む部分 (ダイジェスト) を紙で縮めていないこと。**
   * ページ数を合わせるために一律で級数を下げると、まさに発注者が却下した
   * 「文字が小さく行間が詰まって読みにくい」形になる。**ここが一番大事。**
   */
  const dOk = pr.body === DIGEST_PX && pr.lh !== null && pr.lh >= 24;
  console.log(`${dOk ? '✓' : '✗'} 紙のダイジェスト ${pr.body ?? '-'}px / 行送り ${pr.lh ?? '-'}px `
    + `(期待 ${DIGEST_PX}px・画面と同じ据え置き)`);
  if (!dOk) {
    fails.push(`?print=1 のダイジェストが ${pr.body}px / 行送り ${pr.lh}px — `
      + `読む部分は紙でも ${DIGEST_PX}px / 行送り 1.7 に据え置く。`
      + 'ページ数のために一律で級数を下げるのは却下された形 (spec §4.3.7)');
  }

  /*
   * ② **全編 (巻末の全文・参照用) は紙だけ付録の級数。**
   * 紙面の高さの 87% がここなので、画面の 16px へ戻ると 21 → 25 ページへ戻る。
   */
  const zOk = pr.zenpen === ZENPEN_PRINT_PX;
  console.log(`${zOk ? '✓' : '✗'} 紙の全編        ${pr.zenpen ?? '-'}px (期待 ${ZENPEN_PRINT_PX}px・付録の級数)`);
  if (!zOk) {
    fails.push(`?print=1 の全編が ${pr.zenpen}px — 紙は ${ZENPEN_PRINT_PX}px。`
      + '紙面の 87% がここなので、戻るとページ数が 21 → 25 に増える (画面は正常に見える)');
  }

  /* ③ **画面は 1px も動かさない** (CLAUDE.md「本文 16px は据え置き」)。 */
  const scOk2 = sc.body === DIGEST_PX && sc.zenpen === ZENPEN_SCREEN_PX;
  console.log(`${scOk2 ? '✓' : '✗'} 画面の本文      ダイジェスト ${sc.body ?? '-'}px / 全編 ${sc.zenpen ?? '-'}px `
    + `(期待 ${DIGEST_PX}px / ${ZENPEN_SCREEN_PX}px)`);
  if (!scOk2) {
    fails.push(`画面の本文が ダイジェスト ${sc.body}px / 全編 ${sc.zenpen}px — `
      + '印刷用の級数ダウンが画面まで効いている (CLAUDE.md「本文 16px は据え置き」に反する)');
  }

  const sOk = pr.src === SRC_PRINT;
  console.log(`${sOk ? '✓' : '✗'} 印刷の出典      ${pr.src ?? '-'}px (期待 ${SRC_PRINT}px)`);
  if (!sOk) fails.push(`?print=1 の出典が ${pr.src}px — 紙は ${SRC_PRINT}px (ページ数削減)`);

  const scOk = sc.src === SRC_SCREEN;
  console.log(`${scOk ? '✓' : '✗'} 画面の出典      ${sc.src ?? '-'}px (期待 ${SRC_SCREEN}px・12px 以下を作らない)`);
  if (!scOk) {
    fails.push(`画面の出典が ${sc.src}px — 印刷用の級数ダウンが画面まで効いている。`
      + '禁止事項「12px 以下を作らない」に触れる');
  }
  await ctx.close();
}

// ── ⑤ 手元に残す: 端末の判定 ────────────────────────────────────
/*
 * **端末を取り違えると手順そのものが的外れになる** (PC に「共有ボタン」は無い) ので、
 * 判定の分岐を UA ごとに固定する。特に **iPad は Mac の UA を名乗る** — ここは
 * `maxTouchPoints > 1` だと Mac 判定に落ちることを実測で踏んだ箇所。
 * `autoprint` が付くのは PC だけ (スマホの公式手順は印刷ダイアログを通らない)。
 */
{
  const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
    + ' (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const cases = [
    ['Windows', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      + ' (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' }, 'windows', true],
    ['Mac', { userAgent: MAC_UA }, 'mac', true],
    ['iPhone', devices['iPhone 13'], 'iphone', false],
    // iPadOS 13+ は Macintosh を名乗る。分けるものはタッチ点の数しかない。
    ['iPad', { userAgent: MAC_UA, hasTouch: true, isMobile: true, viewport: { width: 820, height: 1180 } },
      'iphone', false],
    ['Android', devices['Pixel 5'], 'android', false],
  ];
  for (const [label, opt, want, wantAutoPrint] of cases) {
    const ctx = await browser.newContext(opt);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/report?preview=1`, { waitUntil: 'domcontentloaded' });
    const got = await page.evaluate(() => {
      const sec = document.getElementById('save-section');
      if (!sec) return null;
      const vis = [...sec.querySelectorAll('[data-save-guide]')]
        .filter((g) => g.getBoundingClientRect().height > 0);
      return {
        shown: vis.map((g) => g.dataset.saveGuide),
        // 「ボタンが開いてくれる操作」の行が残っていないか (PC では出さない)。
        // **スマホ側の手順にはこの印の行がそもそも無い** (公式手順が印刷ダイアログを通らない)
        // ので、0 行であることを問えるのは PC だけ。
        opens: [...sec.querySelectorAll('[data-opens-dialog]')]
          .filter((li) => li.getBoundingClientRect().height > 0).length,
        steps: [...sec.querySelectorAll('.rp-steps > li')]
          .filter((li) => li.getBoundingClientRect().height > 0).length,
        href: sec.querySelector('[data-save-go]')?.getAttribute('href') ?? '',
      };
    });
    const auto = !!got?.href.includes('autoprint=1');
    const ok = !!got && got.shown.length === 1 && got.shown[0] === want
      && auto === wantAutoPrint && got.steps > 0 && (!wantAutoPrint || got.opens === 0);
    console.log(`${ok ? '✓' : '✗'} 手元に残す ${label.padEnd(8)} → ${got ? got.shown.join(',') || '(なし)' : '節なし'} / autoprint=${auto} / 手順 ${got?.steps ?? '-'} 行 (うち自分で開く ${got?.opens ?? '-'})`);
    if (!ok) fails.push(`手元に残す ${label}: ${want} を期待 → ${JSON.stringify(got)} (autoprint=${auto})`);
    await ctx.close();
  }
}

// ── ⑥ サインイン画面: メール＋パスワードの入口 ─────────────────────
/*
 * **Google が使えない環境で入口が 1 つも無くならないこと**を見る (2026-10-05)。
 * 以前は GSI の失敗で `#signin-ready` ごと隠していたので、ここが壊れると
 * **その環境の人は一生サインインできない**のに、画面は「読み込めませんでした」と
 * 出るだけで正常に見える。
 *
 * 未サインインで `/dashboard` を開くと `SignInPanel` が出る (Cookie を持たないため)。
 */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  const got = await page.evaluate(() => {
    const q = (id) => document.getElementById(id);
    const el = q('signin-login-email');
    const pw = q('signin-login-password');
    const sz = pw ? parseFloat(getComputedStyle(pw).fontSize) : 0;
    // GSI を読み込めなかった状態を作って、メールのフォームが残ることを見る。
    document.dispatchEvent(new CustomEvent('welltect:signin', { detail: { state: 'unavailable' } }));
    const stillVisible = !!(el && el.getBoundingClientRect().height > 0);
    return {
      login: !!el, password: !!pw,
      signupEmail: !!q('signin-signup-email'), signupPassword: !!q('signin-signup-password'),
      minlength: pw?.getAttribute('minlength') ?? '', type: pw?.getAttribute('type') ?? '',
      autocomplete: pw?.getAttribute('autocomplete') ?? '',
      fontSize: sz, gsiSlot: !!q('gsi-button'), stillVisible,
      // 新規登録の案内に「存在を教える語」が無いこと。
      leaks: /既に登録|すでに登録|Google で登録|Googleで登録/.test(document.body.innerText),
    };
  });
  /*
   * **サインインパネルは `PUBLIC_GOOGLE_CLIENT_ID` が在るときだけ描かれる**
   * (`dashboard.astro:92` の `authEnabled`)。未設定の環境では画面に出ないので、
   * ここは**実行しないことを明示して**飛ばす。**黙って通さない。**
   * markup の契約そのものは `npm run verify:email-auth` (A 層) が毎回見ている。
   */
  if (!got.gsiSlot && !got.login) {
    console.log('— サインイン画面: 未実行 (PUBLIC_GOOGLE_CLIENT_ID 未設定でパネルが描かれない環境)。'
      + ' markup の契約は verify:email-auth が見ています。');
  } else {
    const ok = got.login && got.password && got.signupEmail && got.signupPassword
      && got.minlength === '8' && got.type === 'password' && got.autocomplete === 'current-password'
      && got.fontSize >= 16 && got.gsiSlot && got.stillVisible && !got.leaks;
    console.log(`${ok ? '✓' : '✗'} サインイン画面: メール欄 ${got.login ? '有' : '無'} / 新規登録 ${got.signupEmail ? '有' : '無'}`
      + ` / minlength=${got.minlength} / ${got.fontSize}px / Google 失敗後も表示 ${got.stillVisible ? '有' : '無'}`
      + ` / 存在を漏らす語 ${got.leaks ? '**有**' : '無'}`);
    if (!ok) fails.push(`サインイン画面: ${JSON.stringify(got)}`);
  }
  await ctx.close();
}

// ── ⑦ HP マイページからの初回導線 (`?entry=wellfort-mypage`) ─────────
/*
 * **実際の DOM で「どちらの入口が出ているか」を見る。** A 層
 * (`verify:email-auth` ⑪) は `hidden={…}` の式を機械で読むところまでで、
 * **Astro が本当にその属性を描いているか**は見られない。
 *
 * ここが壊れても画面は正常に見える — 従来どおり「サインイン」が先に出るだけで、
 * **初回利用者が HP のメール＋パスワードを入れて弾かれる**ところしか壊れない
 * (実測 2026-10-05)。こちらのログには何も残らない。
 */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  const probe = async (search) => {
    await page.goto(`${BASE}/dashboard${search}`, { waitUntil: 'domcontentloaded' });
    return page.evaluate(() => {
      const q = (id) => document.getElementById(id);
      const vis = (id) => {
        const el = q(id);
        return !!(el && el.getBoundingClientRect().height > 0);
      };
      return {
        panel: !!q('signin-email-login') || !!q('signin-email-signup'),
        loginVisible: vis('signin-email-login'),
        signupVisible: vis('signin-email-signup'),
        /** ログインへ戻る出口が押せること (片道にしない)。 */
        toLogin: vis('signin-show-login'),
        /** Google の入口は entry でも消えない。 */
        gsi: !!q('gsi-button'),
        heading: document.querySelector('h1')?.textContent?.trim() ?? '',
        /** 「新規サインイン」という語を作らない (発注者指示)。 */
        badWord: /新規サインイン/.test(document.body.innerText),
        /** 存在を漏らす語が無い (User Enumeration)。 */
        leaks: /既に登録|すでに登録|未登録|登録されていません/.test(document.body.innerText),
        /** URL に個人情報が乗っていない。 */
        query: [...new URL(location.href).searchParams.keys()],
      };
    });
  };

  const entry = await probe('?entry=wellfort-mypage');
  const plain = await probe('');

  if (!entry.panel && !plain.panel) {
    console.log('— 初回導線: 未実行 (PUBLIC_GOOGLE_CLIENT_ID 未設定でパネルが描かれない環境)。'
      + ' 初期表示の契約は verify:email-auth ⑪ が見ています。');
  } else {
    /* B. HP マイページ経由 → 新規登録が初期表示・ログインへも行ける・Google も在る。 */
    const bOk = entry.signupVisible && !entry.loginVisible && entry.toLogin && entry.gsi
      && !entry.badWord && !entry.leaks && entry.heading !== 'サインイン';
    console.log(`${bOk ? '✓' : '✗'} 初回導線 (entry 有): 新規登録 ${entry.signupVisible ? '表示' : '**非表示**'}`
      + ` / ログイン ${entry.loginVisible ? '**表示**' : '非表示'} / 戻る導線 ${entry.toLogin ? '有' : '**無**'}`
      + ` / Google ${entry.gsi ? '有' : '**無**'} / 見出し「${entry.heading}」`
      + `${entry.badWord ? ' / **新規サインインという語**' : ''}${entry.leaks ? ' / **存在を漏らす語**' : ''}`);
    if (!bOk) fails.push(`初回導線 (entry 有): ${JSON.stringify(entry)}`);

    /* C. 通常アクセス → 従来どおりログインが初期表示。 */
    const cOk = plain.loginVisible && !plain.signupVisible && plain.gsi
      && plain.heading === 'サインイン' && !plain.badWord && !plain.leaks;
    console.log(`${cOk ? '✓' : '✗'} 通常アクセス (entry 無): ログイン ${plain.loginVisible ? '表示' : '**非表示**'}`
      + ` / 新規登録 ${plain.signupVisible ? '**表示**' : '非表示'} / Google ${plain.gsi ? '有' : '**無**'}`
      + ` / 見出し「${plain.heading}」`);
    if (!cOk) fails.push(`通常アクセス (entry 無): ${JSON.stringify(plain)}`);

    /*
     * **切替は 1 クリックで両方向。** 片道だと登録済みの人が signUp をやり直して
     * 「確認メールを送信しました」で止まる。
     */
    const seen = () => page.evaluate(() => ({
      login: document.getElementById('signin-email-login')?.getBoundingClientRect().height > 0,
      signup: document.getElementById('signin-email-signup')?.getBoundingClientRect().height > 0,
    }));
    /** ボタンが無ければ**名指しで落とす** (例外でスクリプトを殺さない)。 */
    const tap = async (sel) => {
      try { await page.click(sel, { timeout: 3000 }); return true; } catch { return false; }
    };
    await page.goto(`${BASE}/dashboard?entry=wellfort-mypage`, { waitUntil: 'domcontentloaded' });
    const tapLogin = await tap('#signin-show-login');
    const afterLogin = await seen();
    const tapSignup = await tap('#signin-show-signup');
    const backToSignup = await seen();
    const swOk = tapLogin && tapSignup
      && afterLogin.login && !afterLogin.signup && backToSignup.signup && !backToSignup.login;
    console.log(`${swOk ? '✓' : '✗'} 入口の切替: 登録済み→ログイン ${afterLogin.login ? '可' : '**不可**'}`
      + ` / 戻って新規登録 ${backToSignup.signup ? '可' : '**不可**'}`);
    if (!swOk) fails.push(`入口の切替: ${JSON.stringify({ tapLogin, tapSignup, afterLogin, backToSignup })}`);

    /* URL に個人情報が乗っていないこと (HP 側のリンクの契約と対で見る)。 */
    const qOk = entry.query.length === 1 && entry.query[0] === 'entry';
    console.log(`${qOk ? '✓' : '✗'} URL のクエリ: ${JSON.stringify(entry.query)}`);
    if (!qOk) fails.push(`URL のクエリに余分なキー: ${JSON.stringify(entry.query)}`);
  }
  await ctx.close();
}

await browser.close();

if (fails.length) {
  console.log(`\n✗ ${fails.length} 件`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\n✓ 紙面が在り、器はダッシュボードと一致、紙面は 1000px 以内、行長も上限内です。');
