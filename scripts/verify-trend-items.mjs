#!/usr/bin/env node
/**
 * 推移グラフ「表示項目の設定」の回帰検査 (実ブラウザ・要 `npm run dev`)。
 *
 * 【なぜ機械で見張るか】
 * 発注者報告 2026-11-02「キー（既定に戻す）が反応しません」。
 * 実測すると**ハンドラは生きていた** — 開いた直後はつねに「既定 (か保存済み)」
 * そのものなので、何も触らずに押すと**戻す先が今の状態と同じ**で何も起きなかった。
 * とくに AI疾病予測・がんリスクは**候補 = 既定**なので、保存済みの選択が無い限り
 * この操作に意味が出る瞬間が無い。
 *
 * **押せるのに何も起きない**＝利用者には「壊れている」としか見えないので、
 * ①戻す先と同じなら押せなくする ②件数の横に「既定のまま」と出す、を入れた。
 * ここが静かに戻ると**また同じ問い合わせになる**ので、機械で固定する。
 *
 * あわせて**ハンドラが死んでいないこと**も見る (今回は生きていたが、
 * 「無効になっているから押しても何も起きない」で本当の故障を隠さないため)。
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:4321';
const EXEC = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

const fails = [];
let pass = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + label); }
  else { fails.push(label + (extra ? ` — ${extra}` : '')); console.log('  ✗ ' + label + (extra ? ` — ${extra}` : '')); }
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);

let browser;
try { browser = await chromium.launch({ executablePath: EXEC }); }
catch { browser = await chromium.launch(); }

/** ダイアログとカードの状態をまとめて読む。 */
const snap = (page) => page.evaluate(() => {
  const reset = document.getElementById('trend-settings-reset');
  const boxes = [...document.querySelectorAll('input[name="trend-item"]')];
  return {
    checked: boxes.filter((b) => b.checked).map((b) => b.value),
    candidates: boxes.map((b) => b.value),
    count: document.getElementById('trend-settings-count')?.textContent ?? '',
    resetDisabled: !!reset?.disabled,
    resetTitle: reset?.title ?? '',
    visibleCards: [...document.querySelectorAll('[data-trend-open][data-trend-item]')]
      .filter((e) => !e.hidden).map((e) => e.getAttribute('data-trend-item')),
  };
});

const openPage = async (type) => {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));
  await page.goto(`${BASE}/trend?type=${type}`, { waitUntil: 'networkidle' });
  return { page, errs };
};

// ══════════════════════════════════════════════════════════════════
// ① AI疾病予測 (候補 = 既定 の形。報告が来た画面そのもの)
// ══════════════════════════════════════════════════════════════════
console.log('\n① AI疾病予測 — 候補 = 既定 の画面 (報告が来た形)\n');
{
  const { page, errs } = await openPage('ai_prediction');
  ok('「表示項目の設定」ボタンが在る', await page.locator('#trend-settings-open').count() === 1);
  await page.click('#trend-settings-open');
  await page.waitForTimeout(200);
  const s0 = await snap(page);
  ok('候補と既定が同じ (この画面の前提)',
    s0.candidates.length > 0 && s0.checked.length === s0.candidates.length,
    `候補 ${s0.candidates.length} / 既定 ${s0.checked.length}`);
  ok('**開いた直後は「既定に戻す」が押せない** (押せるのに何も起きない、を作らない)', s0.resetDisabled);
  ok('件数の横に「既定のまま」と出る (なぜ押せないかが分かる)', /既定のまま/.test(s0.count), s0.count);
  ok('押せない理由が title にも在る', /既定と同じ/.test(s0.resetTitle), s0.resetTitle);

  // ハンドラは生きているか (1 件外す → 押せる → 戻る)
  await page.locator('input[name="trend-item"]').first().uncheck();
  await page.waitForTimeout(150);
  const s1 = await snap(page);
  ok('1 件外すと押せるようになる', !s1.resetDisabled);
  ok('そのとき「既定のまま」は消える', !/既定のまま/.test(s1.count), s1.count);
  await page.click('#trend-settings-reset');
  await page.waitForTimeout(150);
  const s2 = await snap(page);
  eq('**押すと既定へ戻る** (ハンドラが死んでいない)', s2.checked, s0.checked);
  ok('戻ったらまた押せなくなる', s2.resetDisabled);

  // 反映は「この内容で表示」だけ (戻すだけでグラフは動かさない)
  await page.locator('input[name="trend-item"]').first().uncheck();
  await page.waitForTimeout(100);
  const s3 = await snap(page);
  eq('「既定に戻す」や選択だけではグラフは変わらない', s3.visibleCards, s0.visibleCards);
  await page.click('#trend-settings-apply');
  await page.waitForTimeout(250);
  const s4 = await snap(page);
  ok('「この内容で表示」で初めてカードが減る',
    s4.visibleCards.length === s0.visibleCards.length - 1, JSON.stringify(s4.visibleCards));
  const saved = await page.evaluate(() => localStorage.getItem('welltect.trend.items.ai_prediction'));
  ok('選択はこの端末に保存される (localStorage)', !!saved && JSON.parse(saved).length === s4.visibleCards.length, String(saved));

  // 保存済みが既定と違う回は、開いた直後から押せる
  await page.reload({ waitUntil: 'networkidle' });
  await page.click('#trend-settings-open');
  await page.waitForTimeout(200);
  const s5 = await snap(page);
  ok('**保存済みが既定と違えば、開いた直後から押せる**', !s5.resetDisabled);
  await page.click('#trend-settings-reset');
  await page.waitForTimeout(150);
  const s6 = await snap(page);
  eq('押すと既定へ戻る', s6.checked, s0.checked);
  ok('JS エラーが出ていない', errs.length === 0, errs.join(' / '));
  await page.close();
}

// ══════════════════════════════════════════════════════════════════
// ② ほかの検査種別でも同じ約束 (候補 > 既定 の形)
// ══════════════════════════════════════════════════════════════════
console.log('\n② ほかの検査種別 (候補 > 既定 の形)\n');
for (const type of ['health_checkup', 'blood']) {
  const { page, errs } = await openPage(type);
  if (await page.locator('#trend-settings-open').count() === 0) {
    ok(`${type}: 候補が無い画面では設定ボタンを出さない`, true);
    await page.close();
    continue;
  }
  await page.click('#trend-settings-open');
  await page.waitForTimeout(200);
  const s0 = await snap(page);
  ok(`${type}: 開いた直後は押せない`, s0.resetDisabled, s0.count);
  await page.locator('input[name="trend-item"]:not(:checked)').first().check();
  await page.waitForTimeout(150);
  ok(`${type}: 1 件足すと押せる`, !(await snap(page)).resetDisabled);
  await page.click('#trend-settings-reset');
  await page.waitForTimeout(150);
  const s2 = await snap(page);
  eq(`${type}: 押すと既定へ戻る`, s2.checked, s0.checked);
  ok(`${type}: JS エラーが出ていない`, errs.length === 0, errs.join(' / '));
  await page.close();
}

await browser.close();
console.log(fails.length === 0 ? `\n✓ ${pass} / ${pass} passed\n` : `\n✗ ${fails.length} 件 FAIL (${pass} passed)\n\n落ちた検査:\n  - ${fails.join('\n  - ')}\n`);
process.exit(fails.length ? 1 : 0);
