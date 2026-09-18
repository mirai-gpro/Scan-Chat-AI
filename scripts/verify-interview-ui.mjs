/**
 * AI問診 UI の回帰チェック (実ブラウザ + ソース検査)。
 *
 * 守りたい約束 (発注者指示 2026-09-04 / docs/interview/AI問診_仕様と設計原則.md §4):
 *   ① 音声 / テキスト切替トグルが存在しない (音声は常時オン)
 *   ② 「どちらでも OK」等の説明文が無い
 *   ③ 質問直下・選択肢の直前に常設ガイダンス「そのまま話して回答できます」がある
 *   ④ ガイダンスに**既存アイコンを使っていない** (自作 SVG のみ)
 *   ⑤ **復唱を依頼していない** — AI への依頼文にも system prompt にも復唱指示が無い
 *   ⑥ **UI を音声に結合していない** — 音声 chunk で次の質問を描画しない
 *      (schedulePendingQuestion / audioFirstChunkResolvers が存在しない)
 *   ⑦ プログラム側の音声ターン制御を足していない (SPEAKING 等の状態機械が無い)
 *   ⑧ **直前の回答の確認バーが常設** — 時間で消さない (選択画面が覆うので一瞬では見えない)
 *   ⑨ 確認バーは**選択画面 (モーダル) の中にも出る**
 *   ⑩ 「訂正する」は **1 問だけ戻す** (engine.rewindTo)。分岐を画面側で持たない
 *   ⑪ **CSS が実際に当たっている** — markup が正しくても global.css の閉じ忘れで死ぬため
 *
 * 前提: `npm run dev` が起動していること。
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const BASE = process.env.VERIFY_URL ?? 'http://localhost:4321';
const EXEC = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// ── ソース検査 (画面に出ない約束はここで見る) ──
const raw = readFileSync('src/scripts/chat/live-controller.ts', 'utf8');
/*
 * `_OBSOLETE_SYSTEM_INSTRUCTION` は**使われていない旧プロンプト**で、中に復唱指示が
 * 残っている。生きている挙動ではないので検査対象から外す (削除は今回のスコープ外)。
 * 生きているか死んでいるかは、参照されているかで判定する。
 */
const obsoleteAt = raw.indexOf('const _OBSOLETE_SYSTEM_INSTRUCTION');
const obsoleteEnd = obsoleteAt < 0 ? -1 : raw.indexOf('`;', obsoleteAt) + 2;
const ctrl = obsoleteAt < 0 ? raw : raw.slice(0, obsoleteAt) + raw.slice(obsoleteEnd);
/** コメントを外す。「〜しない」と書いた散文で誤検知しないため (過去 3 回踏んだ罠)。 */
const code = ctrl
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

/*
 * 「復唱」の語そのものを禁じると、**禁止文 (「復唱しない」) に誤反応**する。
 * 同じ罠を過去 3 回踏んでいるので、**否定形以外の出現**だけを落とす。
 */
const echoAsks = code
  .split('\n')
  .filter((l) => /復唱/.test(l) && !/復唱しない|復唱も|復唱は行わない/.test(l));
ok('⑤ 復唱を依頼している箇所が無い', echoAsks.length === 0, echoAsks[0]?.trim().slice(0, 70) ?? '');
ok('⑥ schedulePendingQuestion が無い', !/schedulePendingQuestion/.test(code), '');
ok('⑥ audioFirstChunkResolvers が無い', !/audioFirstChunkResolvers/.test(code), '');
ok('① modeToggle の参照が無い', !/modeToggle/.test(code), '');
ok(
  '⑦ 音声ターン制御の状態機械を足していない',
  !/(QUESTION_ACTIVE|SPEAKING|ANSWER_RECEIVED|CONFIRMING|NEXT_QUESTION)/.test(code),
  '',
);
ok(
  '⑤ system prompt が復唱しないと明記している',
  /ユーザーの回答を復唱しない/.test(ctrl),
  '',
);
/*
 * 旧プロンプトは宣言 + `void ...` (未使用警告の抑制) の 2 箇所に出る。
 * 大事なのは**モデルへ渡っていない**こと。渡す経路の行に出ていないかで見る。
 */
const obsoleteUsed = raw
  .split('\n')
  .filter((l) => /_OBSOLETE_SYSTEM_INSTRUCTION/.test(l))
  .filter((l) => !/^const _OBSOLETE_SYSTEM_INSTRUCTION/.test(l.trim()) && !/^void _OBSOLETE_SYSTEM_INSTRUCTION;/.test(l.trim()));
ok('⑤ 旧プロンプトはモデルへ渡っていない', obsoleteUsed.length === 0, obsoleteUsed[0]?.trim() ?? '');
// 依頼文が音声 / タップで分岐していないこと (silent 分岐の再犯防止)
const submitBody = code.slice(code.indexOf('const sectionChanged'), code.indexOf('function toAnswerValue'));
ok('⑤ 依頼文が silent で分岐していない', !/opts\.silent/.test(submitBody), '');

// ── ⑧⑨⑩ 直前の回答の確認 + 訂正 ──
const picker = readFileSync('src/scripts/chat/choice-picker.ts', 'utf8');
ok('⑧ 回答を確認バーに記録している', /lastAnswered = \{ qid: cq\.id/.test(code), '');
/*
 * **時間で消さない**のがこの機能の要 (一瞬だけ出す方式は、モーダルに覆われて
 * そもそも見えない = 発注者報告の症状そのもの)。タイマーで隠していないかを見る。
 */
const timerHide = code
  .split('\n')
  .filter((l) => /setTimeout/.test(l) && /lastAnswer/i.test(l));
ok('⑧ 確認バーをタイマーで消していない', timerHide.length === 0, timerHide[0]?.trim() ?? '');
ok('⑨ 選択画面へ確認バーを渡している', /lastAnswer: lastAnswered/.test(code), '');
ok('⑨ 選択画面が確認バーを描いている', /data-lp-edit/.test(picker) && /class="la"/.test(picker), '');
ok(
  '⑨ 訂正は選択画面を閉じてから呼ぶ',
  /data-lp-edit[\s\S]{0,220}close\(null\);[\s\S]{0,80}onEdit\(\)/.test(picker),
  '',
);
ok('⑩ 訂正は engine.rewindTo を使う', /engine\.rewindTo\(/.test(code), '');
// 訂正後も「表示している質問」と「読み上げる質問」が同じ経路で決まること
const corr = code.slice(code.indexOf('function startCorrection'), code.indexOf('function submitAnswer'));
ok('⑩ 訂正後は通常の設問表示を通る', /applyQuestionToUI\(q\)/.test(corr), '');
ok('⑩ 訂正でも復唱を依頼していない', /復唱しないでください/.test(corr), '');
ok('⑩ 訂正で状態機械を足していない', !/(SPEAKING|CORRECTING|AWAIT)/.test(corr), '');

// ── ⑩ rewindTo の実挙動 (engine を実際に動かす。DOM 非依存) ──
{
  const tmp = `${process.env.TMPDIR ?? '/tmp'}/_iv-engine.mjs`;
  const build = spawnSync(
    'npx',
    ['esbuild', 'src/scripts/chat/interview-script.ts', '--bundle', '--platform=node',
      '--format=esm', '--log-level=error', `--outfile=${tmp}`],
    { encoding: 'utf8' },
  );
  if (build.status !== 0) {
    ok('⑩ engine を読み込めた', false, (build.stderr || build.stdout).slice(0, 120));
  } else {
    const { InterviewEngine } = await import(tmp);
    const e = new InterviewEngine();
    const q1 = e.start();
    const { next: q2 } = e.recordAndAdvance('テスト回答');
    const back = e.rewindTo(q1.id);
    ok('⑩ 1 問前へ戻れる', back?.id === q1.id, `${back?.id} / ${q1.id}`);
    ok('⑩ 戻した設問の回答は消える', e.getAnswers()[q1.id] === undefined, JSON.stringify(e.getAnswers()));
    // 戻したあと答え直すと、通常どおり次へ進む (2 問飛ばない)
    const { next: again } = e.recordAndAdvance('やり直し');
    ok('⑩ 答え直すと元の次の設問へ', again?.id === q2?.id, `${again?.id} / ${q2?.id}`);
    ok('⑩ 存在しない設問へは戻さない', e.rewindTo('NO-SUCH-Q') === null, '');
    // seeded (申込情報から供給済 = 画面に出ない設問) へは戻せない
    const e2 = new InterviewEngine();
    e2.start({ 'EXAM-TYPE': ['人間ドック'] });
    ok('⑩ 供給済 (seeded) の設問へは戻さない', e2.rewindTo('EXAM-TYPE') === null, '');
  }
}

// ── 画面検査 ──
let browser;
try {
  browser = await chromium.launch({ executablePath: EXEC });
} catch {
  browser = await chromium.launch();
}
const page = await browser.newPage();
await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle' });

const count = (sel) => page.locator(sel).count();
const html = await page.content();

ok('① 切替トグルが DOM に無い', (await count('#mode-toggle')) === 0, '');
ok('② 「どちらでも OK」が無い', !html.includes('どちらでも'), '');
ok('② 「タップでもOK」が無い', !html.includes('タップでもOK'), '');
ok('③ 常設ガイダンスがある', (await count('#voice-guide')) === 1, '');
ok('③ 文言が「そのまま話して回答できます」', html.includes('そのまま話して回答できます'), '');
ok('③ フッター文言が残っている', html.includes('AIは質問だけを読み上げます') || html.includes('AI は質問だけ'), '');

// ④ ガイダンス内に既存アイコン (Lucide の svg) を使っていないこと。
//    AppIcon が吐く svg は stroke ベース。自作波形は rect/circle のみ。
const guideHtml = await page.evaluate(() => document.getElementById('voice-guide')?.innerHTML ?? '');
ok('④ ガイダンスに lucide アイコンが無い', !/lucide/i.test(guideHtml), '');
ok('④ 波形は自作 (rect を使っている)', /<rect/.test(guideHtml), '');
ok('④ パルスリング / 発光ドットがある', /vg-ring/.test(guideHtml) && /vg-dot/.test(guideHtml), '');

// ⑧ 確認バーは DOM に在り、まだ回答していないので隠れている
ok('⑧ 確認バーが DOM にある', (await count('#last-answer')) === 1, '');
ok('⑧ 「訂正する」ボタンがある', (await count('#last-answer-edit')) === 1, '');
ok(
  '⑧ 未回答のうちは出さない',
  await page.evaluate(() => document.getElementById('last-answer')?.hidden === true),
  '',
);
// ⑧ 確認バーは**質問文より上** (回答 → 次の質問 の順で目に入る)
const laFirst = await page.evaluate(() => {
  const la = document.getElementById('last-answer');
  const q = document.getElementById('question-text');
  if (!la || !q) return false;
  return !!(la.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING);
});
ok('⑧ 確認バーは質問文より上にある', laFirst, '');

// 並び順: 質問文 → ガイダンス → 選択肢
const order = await page.evaluate(() => {
  const pos = (id) => {
    const el = document.getElementById(id);
    if (!el) return -1;
    let n = 0, cur = el;
    while ((cur = cur.previousElementSibling || cur.parentElement)) n += 1;
    return document.body.innerHTML.indexOf(el.outerHTML.slice(0, 40));
  };
  return { q: pos('question-text'), g: pos('voice-guide'), l: pos('ui-list') };
});
ok('③ 質問文 → ガイダンス → 選択肢 の順', order.q < order.g && order.g < order.l, JSON.stringify(order));

/*
 * ⑪ **CSS が実際に効いているか**を見る。
 *
 * これを入れた理由: `global.css` の直前の規則 (`.md-summary strong`) が閉じておらず、
 * この作業で足した `.vg*` / `.la*` が**まるごとその入れ子**になって 1 つも当たっていなかった
 * (実測 2026-09-04)。**markup もソース検査も全部 PASS したまま**見た目だけ死ぬ壊れ方なので、
 * 計算後のスタイルで見張る。色や余白の細部は見ない (微調整で落ちる検査にしない)。
 */
const applied = await page.evaluate(() => {
  const bar = document.getElementById('last-answer');
  const guide = document.getElementById('voice-guide');
  if (!bar || !guide) return null;
  const wasHidden = bar.hidden;
  const guideWasHidden = guide.hidden;
  // [hidden] は display:none !important なので、隠れたままだと display を測れない
  bar.hidden = false;
  guide.hidden = false;
  // getComputedStyle は**生きたオブジェクト**なので、hidden を戻す前に値を取り出す
  // (戻したあとに読むと display が none に化ける)。
  const cs = getComputedStyle(bar);
  const out = {
    barFlex: cs.display === 'flex',
    barPainted: cs.backgroundColor !== 'rgba(0, 0, 0, 0)',
    btnTouch: parseFloat(getComputedStyle(document.getElementById('last-answer-edit')).minHeight) >= 44,
    /*
     * ガイダンスは mist の面 (.qb) の中では**地を敷かない** (二重になるため) ので、
     * 背景色では見られない。CSS が当たっているかは display と枠で見る。
     */
    guideStyled: (() => {
      const g2 = getComputedStyle(guide);
      return g2.display === 'flex' && parseFloat(g2.borderTopWidth) > 0;
    })(),
    qbPainted: (() => {
      const qb = document.querySelector('.qb');
      return !!qb && getComputedStyle(qb).backgroundColor !== 'rgba(0, 0, 0, 0)';
    })(),
  };
  bar.hidden = wasHidden;
  guide.hidden = guideWasHidden;
  return out;
});
ok('⑪ 確認バーのスタイルが当たっている', !!applied?.barFlex && !!applied?.barPainted, JSON.stringify(applied));
ok('⑪ 「訂正する」のタップ領域が 44px 以上', !!applied?.btnTouch, '');
ok('⑪ ガイダンスのスタイルが当たっている', !!applied?.guideStyled, '');
// いま答えるところ (質問) が mist の面に乗っていること (発注者指示 2026-09-04)
ok('⑪ 質問が mist の面に乗っている', !!applied?.qbPainted, '');

/*
 * ⑫ **マイクのオン / オフ** (発注者指示 2026-09-17・裁定 A 案)。
 * 実機でテレビの音をかなり拾うので、利用者が自分でマイクを切れるようにした。
 * **モジュールを実際に動かして**帯と文言とアイコンが切り替わることを見る
 * (ソース検査だけだと「書いてあるが当たっていない」を見逃す)。
 */
const gate = await page.evaluate(async () => {
  const m = await import('/src/scripts/chat/mic-gate.ts');
  const qa = document.getElementById('qa-area');
  const wasHidden = qa.hidden;
  qa.hidden = false; // [hidden] は display:none なので測れない
  const gateEl = document.getElementById('mic-gate');
  const noteEl = document.getElementById('mic-gate-note');
  const btn = document.getElementById('mic-gate-btn');
  const guide = document.getElementById('voice-guide');
  const seen = [];
  const g = m.createMicGate({ gate: gateEl, note: noteEl, button: btn }, (muted) => seen.push(muted));
  const snap = () => {
    const cs = getComputedStyle(btn);
    const r = btn.getBoundingClientRect();
    return {
      note: noteEl.textContent.trim(),
      label: btn.getAttribute('aria-label'),
      band: getComputedStyle(gateEl).backgroundColor,
      anim: cs.animationDuration,
      w: Math.round(r.width), h: Math.round(r.height),
      icoOn: getComputedStyle(document.querySelector('.mic-gate-ico-on')).display,
      icoOff: getComputedStyle(document.querySelector('.mic-gate-ico-off')).display,
    };
  };
  const on = snap();
  g.toggle();
  const off = snap();
  g.toggle();
  const back = snap();
  // 並び: 質問 → マイクの帯 → 音声ガイダンス
  const after = (a, z) => !!(a.compareDocumentPosition(z) & Node.DOCUMENT_POSITION_FOLLOWING);
  const order = after(document.getElementById('question-text'), gateEl) && after(gateEl, guide);
  // 中止・スピーカーは現状のまま (帯へ移していない・数も変えていない)
  const untouched = document.querySelectorAll('#mic-btn').length === 1
    && document.querySelectorAll('#speaker-btn').length === 1
    && !document.querySelector('.qb > .flex').contains(btn);
  qa.hidden = wasHidden;
  return { on, off, back, seen, order, untouched, note: m.MIC_GATE_NOTE_ON, noteOff: m.MIC_GATE_NOTE_OFF };
});
ok('⑫ 帯の文言が「周囲の音を拾う場合、マイクをオフに」', gate.on.note === gate.note, gate.on.note);
ok('⑫ ボタンは帯の右端・44px 以上', gate.on.w >= 44 && gate.on.h >= 44, `${gate.on.w}x${gate.on.h}`);
ok('⑫ 点滅は 3 秒周期', gate.on.anim === '3s', gate.on.anim);
ok('⑫ 中止・スピーカーは現状のまま (質問行に足していない)', gate.untouched, '');
ok('⑫ 質問 → マイクの帯 → 音声ガイダンス の順', gate.order, '');
// オフ: 文言・ラベル・アイコン・地の色・点滅がすべて変わる
ok('⑫ オフで文言が変わる', gate.off.note === gate.noteOff, gate.off.note);
ok('⑫ オフで aria-label が「マイクをオンにする」', gate.off.label === 'マイクをオンにする', gate.off.label);
ok('⑫ オフで点滅が止まる', gate.off.anim === '0s', gate.off.anim);
ok('⑫ オフで帯の色が変わる (色だけに頼らないが色も変える)',
  gate.off.band !== gate.on.band, `${gate.on.band} → ${gate.off.band}`);
ok('⑫ アイコンが切り替わる (斜線入りになる)',
  gate.on.icoOn !== 'none' && gate.on.icoOff === 'none'
  && gate.off.icoOn === 'none' && gate.off.icoOff !== 'none',
  JSON.stringify([gate.on.icoOn, gate.on.icoOff, gate.off.icoOn, gate.off.icoOff]));
ok('⑫ もう一度押すと元に戻る', gate.back.note === gate.on.note && gate.back.anim === gate.on.anim, '');
ok('⑫ 変化のたびに 1 回だけ通知する', JSON.stringify(gate.seen) === '[true,false]', JSON.stringify(gate.seen));

/*
 * ⑨ 選択画面の中に確認バーが出て、そこから訂正できること (実際に開いて押す)。
 * 問診本体は Live API が要るので動かせない。ここは picker 単体を直接開いて見る。
 */
const pick = await page.evaluate(async () => {
  const m = await import('/src/scripts/chat/choice-picker.ts');
  let edited = 0;
  const p = m.openListPicker({
    title: '運動の頻度',
    options: [{ label: '週3回以上' }, { label: '週1-2回' }, { label: 'ほとんどしない' }],
    lastAnswer: { text: '吸わない', onEdit: () => { edited += 1; } },
  });
  await new Promise((res) => setTimeout(res, 600)); // シートのスライドインを待つ
  const bar = document.querySelector('.lp-panel .la');
  const btn = document.querySelector('.lp-panel [data-lp-edit]');
  const rect = btn?.getBoundingClientRect();
  /*
   * **並び順が本体**: 前の回答 → 次の質問のタイトル → 選択肢。
   * タイトルの下に置くと「次の質問 → 前の回答 → 次の質問の選択肢」になり、
   * 前の回答が次の質問の中に挟まって読めない (発注者指摘 2026-09-04)。
   */
  // タイトルはシート用 / 全画面用の 2 つが描かれ、CSS で片方だけが出る。
  // **見えている方**を測る (隠れている方は rect が 0 になり判定が壊れる)。
  const titleEl = [...document.querySelectorAll('.lp-panel .lp-title')]
    .find((el) => el.offsetParent !== null);
  const firstItem = document.querySelector('.lp-panel .lp-item');
  const before = (a, z) => !!a && !!z && !!(a.compareDocumentPosition(z) & Node.DOCUMENT_POSITION_FOLLOWING);
  const out = {
    inModal: !!bar,
    text: bar?.querySelector('.la-text')?.textContent ?? '',
    tag: bar?.querySelector('.la-tag')?.textContent ?? '',
    ownSvg: !!bar?.querySelector('svg.la-check') && !/lucide/i.test(bar?.innerHTML ?? ''),
    visible: !!rect && rect.top >= 0 && rect.bottom <= window.innerHeight,
    aboveTitle: before(bar, titleEl),
    aboveItems: before(bar, firstItem),
    // 実際の描画位置でも上にあること (DOM 順だけだと CSS の order/absolute で崩せる)
    yBar: bar?.getBoundingClientRect().top ?? -1,
    yTitle: titleEl?.getBoundingClientRect().top ?? -1,
  };
  btn?.click();
  out.resolvedNull = (await p) === null;
  out.edited = edited;
  out.modalGone = document.querySelectorAll('.lp-root').length === 0;
  return out;
});
ok('⑨ 選択画面の中に確認バーが出る', pick.inModal && pick.text === '吸わない', pick.text);
ok('⑨ 「前の回答」と明示している', pick.tag.includes('前の回答'), pick.tag);
ok(
  '⑨ 確認バーは次の質問のタイトルより上',
  pick.aboveTitle && pick.yBar >= 0 && pick.yBar < pick.yTitle,
  `bar=${Math.round(pick.yBar)} title=${Math.round(pick.yTitle)}`,
);
ok('⑨ 確認バーは選択肢より上', pick.aboveItems, '');
ok('⑨ モーダル内でもチェック印は自作 SVG', pick.ownSvg, '');
ok('⑨ 「訂正する」が画面内に見えている', pick.visible, '');
ok('⑩ 訂正で選択画面が閉じる', pick.modalGone, '');
ok('⑩ 訂正は回答を確定しない (キャンセル扱い)', pick.resolvedNull, '');
ok('⑩ onEdit がちょうど 1 回', pick.edited === 1, String(pick.edited));

await browser.close();
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
