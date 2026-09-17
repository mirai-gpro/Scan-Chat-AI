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
/** 本文の行長上限。`global.css` の `.report-prose { max-width: 38em }` × 16px。 */
// 行長の上限 = 45em (16px * 45)。印刷 (`?print=1`) だけは 38em = 608px に据え置き。
const MAX_PROSE = 720;
// 紙面の上限 = 62.5rem。器がこれより狭い端末では発火しない (スマホ・タブレット)。
const MAX_SHEET = 1000;
// 印刷の行長。ここが動くと紙面のページ割りが変わる (verify:print の前提) ので別に見張る。
const PRINT_PROSE = 608;

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
   * **「今回の所見」のカードの中だけを見る。** `document.body` 全体を見ると全編
   * (abstract/総評) にも同じ文が在るので、**カードが空でも緑になる** — 実際に一度
   * この誤りを書いた (壊して確かめたら通ってしまい発覚)。
   *
   * 【2026-09-17】軸 A「初期がんの早期発見」の廃止で**帯から辿れなくなった**ので、
   * カードの見出しで引く。見ているもの (Elith の逐語が出ているか) は変えていない。
   */
  const t1A = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.rp-card')]
      .filter((c) => (c.querySelector('.rp-h3')?.textContent ?? '').includes('今回の所見'));
    return { cards: cards.length, text: cards.map((c) => c.textContent ?? '').join('') };
  });
  const t1Ok = t1A.cards > 0 && t1A.text.includes('尿中のポルフィリン量');
  console.log(`${t1Ok ? '✓' : '✗'} ?preview=1 の「今回の所見」に受領本文の逐語が出ている (カード ${t1A.cards} 枚)`);
  if (!t1Ok) fails.push('?preview=1 の「今回の所見」が空 (がんリスク検査の項目名で選べていない)');

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

// ── ③′ 印刷の行長は 38em に据え置き ───────────────────────────
/*
 * 画面は 45em にしたが、**紙 (`?print=1`) は 38em のまま**にしてある (裁定 2026-09-05)。
 * ここが一緒に動くと A4 のページ割りが変わり、`verify:print` が測った
 * 「30 ページ / 使用率 96.5%」の前提が黙って崩れる。だから別に見張る。
 */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/report?print=1`, { waitUntil: 'networkidle' });
  const w = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.report-prose')];
    return els.length ? Math.max(...els.map((e) => Math.round(e.getBoundingClientRect().width))) : null;
  });
  const ok = w === PRINT_PROSE;
  console.log(`${ok ? '✓' : '✗'} 印刷の行長      ?print=1 の本文=${w ?? '-'}px (期待 ${PRINT_PROSE}px = 38em)`);
  if (!ok) fails.push(`?print=1 の行長が ${w}px — 紙は 38em (${PRINT_PROSE}px) に据え置く裁定`);
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

await browser.close();

if (fails.length) {
  console.log(`\n✗ ${fails.length} 件`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\n✓ 紙面が在り、器はダッシュボードと一致、紙面は 1000px 以内、行長も上限内です。');
