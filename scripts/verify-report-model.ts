/**
 * AI疾病予防報告書 — 表示モデルの回帰チェック。
 *
 * 正本: docs/elith/AI疾病予防報告書_仕様書.md  ※ § 番号は旧版 docs/旧版・ボツ/ai_prevention_report_generation_spec.md §1.3.7
 *
 * 【担保したいこと】**文言を書き換えていないこと。**
 *   可読化は「選択」で行い「圧縮」で行わない (spec §1.0.0) ので、紙面に出る文はすべて
 *   受領 JSON の**部分文字列**でなければならない。要約・言い換え・語順の入れ替えが
 *   混ざれば、この検査が落ちる。章の並べ替えや設定変更で本文が変質しないことも見る。
 *
 * 実行: npm run verify:report-model
 */

import REPORT_TEXT from '../src/data/elith/report_text_20260826.json';
import HEALTH_CHECKUP from '../src/data/elith/health_checkup_20260826.json';
// タイプ1 (2026-08-24 検査 / 2026-09-01 受領)。**検体 1 つでの検証は事故を通した** (spec §5.2)。
import T1_TEXT from '../src/data/elith/type1_20260824/report_text.json';
import T1_CHECKUP from '../src/data/elith/type1_20260824/health_checkup.json';
import T1_BLOOD from '../src/data/elith/type1_20260824/blood_test.json';
import T1_CANCER from '../src/data/elith/type1_20260824/cancer_risk.json';
import { buildReportVM, leadSentences } from '../src/lib/report-adapter';
import { anchorFor, resolveChapters } from '../src/lib/report-sections';
import type { ReportVM } from '../src/lib/report-model';
import { loadReportVM } from '../src/lib/elith-report-queries';

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; return; }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const checkup = HEALTH_CHECKUP as unknown as Record<string, { date?: string; value?: unknown }[]>;

function build(readConfig: (k: string) => string = () => ''): ReportVM {
  return buildReportVM({
    reportText: REPORT_TEXT,
    checkup,
    name: '相川 佳之 様',
    issuedOn: '2026-08-26',
    isSample: true,
    hasCancerRisk: false,
    cycleSeq: null,
    chronologicalAge: 56,
    readConfig,
  });
}

const vm = build();

// ── 受領本文を 1 本の文字列にして、部分文字列判定の母体にする ──────────────
let corpus = '';
const walk = (v: unknown): void => {
  if (typeof v === 'string') corpus += `\n${v}`;
  else if (Array.isArray(v)) v.forEach(walk);
  else if (v && typeof v === 'object') Object.values(v).forEach(walk);
};
walk(REPORT_TEXT);
const norm = (s: string) => s.replace(/\s+/g, '');
const CORPUS = norm(corpus);

/**
 * 紙面に出る文が受領本文の逐語かを見る。
 *
 * **唯一の例外 = 出所の印「（問診時）」** (spec §4.13・発注者判断 2026-09-17)。
 * 当社が足してよいのはこの 5 文字だけなので、**取り除いてから**部分文字列で照合する。
 * 逆に言えば、これ以外の文字を 1 文字でも足せばここで落ちる。
 */
const SELF_MARK = '（問診時）';
function verbatim(label: string, text: string): void {
  if (!text) return;
  check(`逐語: ${label}`, CORPUS.includes(norm(text.split(SELF_MARK).join(''))),
    `"${text.slice(0, 40)}…"`);
}

// ── 1) ダイジェストの全文が逐語であること ────────────────────────────
for (const card of vm.digest) {
  for (const b of card.blocks) {
    if (b.kind === 'paragraphs') {
      // **例外は無い。** パイロット暫定文 (当社の 2 文) は 2026-09-17 に削除した。
      for (const t of b.items) verbatim(`${card.key}/paragraph`, t);
    }
    if (b.kind === 'steps' || b.kind === 'weeks') {
      for (const i of b.items) verbatim(`${card.key}/${i.heading}`, i.text);
    }
    if (b.kind === 'pairs') {
      for (const p of b.items) {
        verbatim(`${card.key}/${p.heading}/現状`, p.current);
        verbatim(`${card.key}/${p.heading}/提案`, p.action);
      }
    }
    if (b.kind === 'table') {
      // 判定は Elith の原文の部分文字列でなければならない (当社が判定を作らない)。
      for (const r of b.rows) verbatim(`${card.key}/${r.name}/判定`, r.judgement);
    }
  }
}

// ── 2) 可読化: 最初に読む面が受領本文より十分に短いこと ─────────────────
let digestChars = 0;
for (const c of vm.digest) for (const b of c.blocks) {
  if (b.kind === 'paragraphs') b.items.forEach((t) => { digestChars += norm(t).length; });
  if (b.kind === 'steps' || b.kind === 'weeks') b.items.forEach((i) => { digestChars += norm(i.text).length; });
  if (b.kind === 'pairs') b.items.forEach((p) => { digestChars += norm(p.current).length + norm(p.action).length; });
  if (b.kind === 'table') b.rows.forEach((r) => { digestChars += norm(r.name + r.value + r.reference + r.judgement).length; });
}
const reduction = 100 - (digestChars / CORPUS.length) * 100;
// 前回の実装は削減率 1% でリバートされた (spec §9.2)。**80% を下回ったら可読化していない。**
check('可読化: ダイジェストの削減率 ≥ 80%', reduction >= 80, `${reduction.toFixed(1)}%`);
check('全編を捨てていない', vm.chapters.length >= 9, `${vm.chapters.length} 章`);
// 全編を開いたまま置くとダイジェストと同じ内容が二重に流れ、旧実装と同じ画面になる。
check('全編は既定で畳む', vm.chapters.every((c) => c.collapsed),
  vm.chapters.filter((c) => !c.collapsed).map((c) => c.key).join(','));

// ── 3) 実測値の固定 (spec の記載と一致すること) ─────────────────────────
check('セクション 10 件', vm.audit.sections.length === 10, String(vm.audit.sections.length));
/*
 * **38 件。** 39 件だったのは、アブストラクトが全編に 1 章 (= 1 トピック) 在ったころの数。
 * 2026-09-03 にアブストラクトを冒頭 (ウェルネス年齢の次) へ全文で出し、全編からは
 * 外した (見本 p1 の並び・発注者指示) ので 1 件減っている。**文は 1 つも捨てていない。**
 */
check('トピック 38 件 (spec §5.4)', vm.audit.topicCount === 38, String(vm.audit.topicCount));
check('アブストラクトは全編に置かない (冒頭へ移した)',
  !vm.chapters.some((c) => c.key === 'abstract'),
  vm.chapters.map((c) => c.key).join(','));
check('基準値は 8 件のみ (spec §6 ④)', vm.audit.referenceCount === 8, String(vm.audit.referenceCount));
check('ウェルネス年齢 46.6', vm.cover.wellnessAge === 46.6, String(vm.cover.wellnessAge));
check('タイプ 2 と判定', vm.reportType === 2, String(vm.reportType));

// ── 4) 軸は 1 本 (A は廃止・2026-09-17) ───────────────────────────
//
// 「初期がんの早期発見」は受領 JSON に対応するものが無い枠だったので廃止した。
// **残るのは 1 本だけ**で、丸バッジ (A/B) も紙面に出さない (バッジは `verify:screen` が見る)。
check('軸は 1 本だけ', vm.axes.length === 1, vm.axes.map((a) => a.key).join(','));
check('残った軸は疾病予防アドバイス', vm.axes[0]?.key === 'b'
  && vm.axes[0]?.title === 'AI 診断による疾病予防アドバイス', vm.axes[0]?.title ?? '');
check('廃止した軸 A のカードが残っていない', !vm.digest.some((c) => c.axis === 'a'));
// 帯にリードを持たせない (ポリシーの説明文を紙面に載せない・spec §4.-1)。
check('軸は見出しだけを持つ',
  vm.axes.every((a) => Object.keys(a).length === 2 && !!a.title));

// ── 5) 捏造ゼロの境界 ──────────────────────────────────────────────
const allRows = vm.chapters.find((c) => c.key === 'measurements')?.table ?? [];
check('基準値が無い項目は空のまま (外部マスタで補完しない)',
  allRows.filter((r) => !r.reference).length > 0);
check('Elith が判定を書いていない行は判定が空',
  allRows.every((r) => r.judgement === '' || CORPUS.includes(norm(r.judgement))));
// 同名別値は自動採用しない (spec §7.1)。
check('同名別値を競合として残す', allRows.some((r) => r.variants > 1));
// 誤字は直さない (spec §7.3)。
check('誤字「上上回っており」を直さず出す',
  allRows.some((r) => r.judgement.includes('上上回っており')));
// 2 ファイルは包含関係でない (spec §7.2)。
check('本文にしかない値も表に載る',
  allRows.some((r) => r.source === 'report_text'));

// ── 6) 章立ての設定 ────────────────────────────────────────────────
const cfgOf = (m: Record<string, string>) => (k: string) => m[k] ?? '';

const ordered = build(cfgOf({ 'report.sections.order': 'measurements,medical_visit' }));
check('order: 書いた章だけを書いた順で出す',
  ordered.chapters.map((c) => c.key).join(',') === 'measurements,medical_visit',
  ordered.chapters.map((c) => c.key).join(','));

const hidden = build(cfgOf({ 'report.sections.hidden': 'references,nutrients' }));
check('hidden: 指定した章が消える',
  !hidden.chapters.some((c) => ['references', 'nutrients'].includes(c.key)));

const labeled = build(cfgOf({ 'report.sections.labels': 'medical_visit=今回いちばん大事なこと' }));
check('labels: 見出しを差し替えられる',
  labeled.chapters.find((c) => c.key === 'medical_visit')?.title === '今回いちばん大事なこと');

// **打ち間違いで報告書を真っ白にしない** (spec §1.3.2)。
const garbage = build(cfgOf({ 'report.sections.order': ' , , ' }));
check('order が空白だけならコード既定へ落ちる', garbage.chapters.length >= 9,
  String(garbage.chapters.length));
const unknownOnly = build(cfgOf({ 'report.sections.order': 'nope,typo' }));
check('order が未知キーだけでもコード既定へ落ちる', unknownOnly.chapters.length >= 9,
  String(unknownOnly.chapters.length));
check('未知キーは監査に出る', unknownOnly.audit.unknownChapterKeys.join(',') === 'nope,typo',
  unknownOnly.audit.unknownChapterKeys.join(','));

const { chapters: allHidden } = resolveChapters(cfgOf({
  'report.sections.hidden': 'cancer_finding,medical_visit,measurements,summary,abstract,lifestyle,diet_plan,diet,exercise,sleep,nutrients,references',
}));
check('全章を明示 hidden にしたときだけ 0 件を許す', allHidden.length === 0, String(allHidden.length));

// ── 7) アンカーは並べ替えで壊れない (spec §5.4) ────────────────────────
const a1 = anchorFor('diet', '食材の選び方');
const a2 = anchorFor('diet', '食材の選び方');
const a3 = anchorFor('sleep', '食材の選び方');
check('アンカーは決定論', a1 === a2);
check('アンカーは章キーを含むので章間で衝突しない', a1 !== a3);
const anchors = vm.chapters.flatMap((c) => c.topics.map((t) => t.anchor));
check('アンカーが重複しない', new Set(anchors).size === anchors.length,
  `${anchors.length} 件中 ${new Set(anchors).size} 件がユニーク`);

// ── 8) 文の切り出しは文字を足さない ───────────────────────────────────
check('leadSentences は 1 文を「。」付きで返す',
  leadSentences('あいう。えお。かき。', 1) === 'あいう。');
check('leadSentences は n 文を連結する',
  leadSentences('あいう。えお。かき。', 2) === 'あいう。えお。');
check('leadSentences は「。」が無ければ原文のまま',
  leadSentences('あいう', 1) === 'あいう');
check('leadSentences は空文字で空を返す', leadSentences('', 1) === '');

// ── 9) タイプ 1 で Elith の記述が無ければカードごと非表示 (spec §4.0.1) ──
const type1 = buildReportVM({
  reportText: REPORT_TEXT, checkup, name: '', issuedOn: '2026-08-26', isSample: true,
  hasCancerRisk: true, cycleSeq: 1, chronologicalAge: 56, readConfig: () => '',
});
check('タイプ 1 と判定', type1.reportType === 1);
check('タイプ 1 で記述が無ければ A のカードを出さない',
  !type1.digest.some((c) => c.key === 'cancer_finding'));
check('タイプ 1 でも軸の帯は立つ', type1.axes.length === 1);
check('カードを出さなかったことは監査に出る',
  type1.audit.emptyCards.includes('cancer_finding'));

// ── 10) Elith が書けば、そちらが優先される ────────────────────────────
const withElith = buildReportVM({
  reportText: { ...(REPORT_TEXT as object), cancer_screening: { status: 'no_notable_finding', text: 'Elith が書いた所見です。' } },
  checkup, name: '', issuedOn: '2026-08-26', isSample: true,
  hasCancerRisk: true, cycleSeq: 1, chronologicalAge: 56, readConfig: () => '',
});
const cancerCard = withElith.digest.find((c) => c.key === 'cancer_finding');
check('Elith の記述があればそれを出す',
  cancerCard?.blocks[0]?.kind === 'paragraphs'
  && (cancerCard.blocks[0] as { items: string[] }).items[0] === 'Elith が書いた所見です。');

// ── 11) 新旧どちらの形式も読む (spec §5.1) ────────────────────────────
const legacy = buildReportVM({
  reportText: [{ section_name: '医療受診の目安', char_count: 10, text: '### 1. 見出し\nこれは本文です。' }],
  checkup: null, name: '', issuedOn: '2026-08-26', isSample: true,
  hasCancerRisk: false, cycleSeq: null, chronologicalAge: null, readConfig: () => '',
});
check('旧形式 (配列) も読める', legacy.chapters.some((c) => c.key === 'medical_visit'));

// ── 12) 旧世代の受領形式でも主軸 B が白紙にならない (2026-08-29 の実障害) ──
//
// 本番 DB の検体で主軸 B が**帯だけの白紙**になった。原因は 3 つとも
// 「受領形式の世代差を認識できていない」もので、内容の不足ではない:
//   ① `検査値フィードバック` の節が `【】` でなく `###`
//      → `buildMeasurements` が `splitByBracket` 決め打ちで 0 ブロック
//   ② 基準値のコロンが半角 `（基準値: 〜129 mmHg）`
//      → `VALUE_RE` が全角 `：` しか見ておらず 0 件
//   ③ `医療受診の目安` / `必要とする栄養素` に見出しが 1 つも無い
//      → `splitTopics` が 0 件を返しカードごと消える
// **中身を作って埋めたのではない。**出せる文が実際にあるのに認識できていなかった。
const OLD_GEN = [
  {
    section_name: '医療受診の目安', char_count: 0,
    text: '今回の健診結果では、血圧の改善が見られた一方で、尿酸値や空腹時血糖、腎機能の数値に注意が必要な状態です。'
      + 'これらの数値は、生活習慣病の重症化を防ぐためにも、早めの医療機関への受診が望まれます。'
      + 'まずは、眼科への予約を取り、精密検査を受けることを最優先に考えてみてください。',
  },
  {
    section_name: '検査値フィードバック', char_count: 0,
    text: '### 血圧\n最高血圧は127 mmHg（基準値: 〜129 mmHg）、最低血圧は82 mmHg（基準値: 〜84 mmHg）と、'
      + 'どちらも正常範囲内に収まっています。\n'
      + '### 腎機能・尿酸\nクレアチニンは1.03 mg/dl（基準値: 〜1.00 mg/dl）と基準値をわずかに超え、'
      + 'eGFRは56.6 ml/min（基準値: 60以上）と基準値を下回っています。',
  },
  {
    section_name: '必要とする栄養素/サプリ情報', char_count: 0,
    text: 'ビタミンC（成人100 mg/日）：尿酸値が高い場合は補給優先候補になります。'
      + 'ビタミンC不足が続くと、歯ぐきから血が出る、傷が治りにくいなどの具体的症状につながります。',
  },
];
const oldGen = buildReportVM({
  reportText: OLD_GEN, checkup: null, name: '', issuedOn: '2026-01-24', isSample: false,
  hasCancerRisk: false, cycleSeq: null, chronologicalAge: null, readConfig: () => '',
});
const oldB = oldGen.digest.filter((c) => c.axis === 'b');
check('旧世代: 主軸 B が白紙にならない', oldB.length >= 3, `${oldB.length} カード`);
check('旧世代: 見出しの無い章もダイジェストに出る',
  oldB.some((c) => c.key === 'medical_visit') && oldB.some((c) => c.key === 'nutrients'),
  oldB.map((c) => c.key).join(','));
const oldRows = oldGen.chapters.find((c) => c.key === 'measurements')?.table ?? [];
check('旧世代: `###` 節 + 半角コロンでも検査値を拾う', oldRows.length >= 4,
  `${oldRows.length} 行`);
check('旧世代: 基準値が半角コロンでも結べる',
  oldRows.some((r) => r.name === '最高血圧' && r.reference === '〜129 mmHg'),
  oldRows.map((r) => `${r.name}=${r.reference}`).join(' / '));
// 旧世代でも紙面の文はすべて逐語。
const OLD_CORPUS = norm(OLD_GEN.map((s) => s.text).join(''));
for (const c of oldB) {
  for (const b of c.blocks) {
    const texts = b.kind === 'paragraphs' ? b.items
      : b.kind === 'steps' || b.kind === 'weeks' ? b.items.map((i) => i.text)
      : [];
    for (const t of texts) {
      check(`旧世代 逐語: ${c.key}`, OLD_CORPUS.includes(norm(t)), t.slice(0, 30));
    }
  }
}

/*
 * ── サンプルは必ずタイプ2 で組まれること ────────────────────────────
 *
 * 【なぜ要るか】タイプは `hasCancerRisk` で決まるが、その値は**閲覧者の
 * `test_artifacts`** から作られる。サンプルの中身は 2026-08-26 受領の
 * **タイプ2 の検体**なので、別の回のデータでタイプを決めるとカードが消える。
 *
 * 実害 (2026-08-30): `seed_admin_users.sql` が 真鍋の `test_artifacts`
 * (`cancer_urine` 含む) を各 admin の uid へ**コピー**しているため、admin は
 * `hasCancerRisk: true` になり、サンプルがタイプ1 (未実装) に反転して
 * **A 軸のカードが消えていた**。しかも**ローカルには Supabase が無いので再現しない** —
 * 「ローカルで緑」を根拠にできない類のバグだった。
 * → ここで **DB 非依存**に固定する (`loadReportVM` は Supabase 未設定なら `sample()` へ落ちる)。
 */
{
  /*
   * **デモ用アカウントとして引く。** サンプルはデモ用アカウントにしか出ない
   * (`demo-data.ts` の `demoFallbackEnabled`・2026-08-30 再設計)。
   * `d0000001…` は組み込みのデモ用 uid = テストフェーズの標準デモ (真鍋)。
   */
  const DEMO_UID = 'd0000001-0000-0000-0000-000000000000';
  const asDemoWithCancer = await loadReportVM({
    diagnosticUserId: DEMO_UID,
    name: 'テスト 様',
    chronologicalAge: 56,
    ourWellnessAge: null,
    // **本番のデモ環境と同じ条件**: 別の回のがんリスク検査を持っている
    hasCancerRisk: true,
    cycleSeq: null,
  });
  check('サンプルが出る (isSample)', asDemoWithCancer.isSample === true,
    `isSample=${asDemoWithCancer.isSample}`);
  /*
   * **既定はタイプ1** (発注者指示 2026-09-01)。以前は「必ずタイプ2」で固定していたが、
   * タイプ1 の受領 JSON が届いたので既定を入れ替えた。**規則は同じ** — タイプは
   * 材料と一緒に切り替え、**閲覧者の `test_artifacts` では決めない**。
   */
  check('サンプルの既定はタイプ1', asDemoWithCancer.reportType === 1,
    `reportType=${asDemoWithCancer.reportType}`);
  // 軸 A の廃止後は**カードの key で引く** (軸では引けない)。意図は同じ。
  const aCards = asDemoWithCancer.digest.filter((c) => c.key === 'cancer_finding').length;
  check('サンプルで「今回の所見」のカードが出る', aCards >= 1, `${aCards} 枚`);
  /*
   * **「今回の所見」の中身が受領本文の逐語であること。** タイプ1 は本文に「がん」が 0 回で、
   * 代わりに `cancer_risk.json` の項目名 (尿中のポルフィリン量) が出てくる。
   * 語ではなく**受領ファイルの項目名**で選んでいることを、ここで固定する。
   */
  const aCard = asDemoWithCancer.digest.find((c) => c.key === 'cancer_finding');
  /*
   * **このカードの軸がレジストリと一致すること。** アダプタに軸をベタ書きしていたため、
   * レジストリで b へ移しても 'a' のままになり**画面から静かに消えた** (2026-09-17)。
   * 下の §17 は `vm`/`t1` を見るが、**どちらにもこのカードは出ない**ので
   * ここで見ないと検査が空振りする (退行注入で実証済み)。
   */
  const regAxis = resolveChapters(() => '').chapters.find((c) => c.key === 'cancer_finding')?.axis;
  check('「今回の所見」の軸がレジストリと一致する', !!aCard && aCard.axis === regAxis,
    `カード=${aCard?.axis ?? 'なし'} / レジストリ=${regAxis}`);
  check('「今回の所見」が実在する軸に属する (画面から消えない)',
    !!aCard && asDemoWithCancer.axes.some((x) => x.key === aCard.axis));
  const aItems = (aCard?.blocks[0] as { items?: string[] } | undefined)?.items ?? [];
  const t1Body = JSON.stringify(T1_TEXT);
  check('「今回の所見」の文は受領本文の逐語', aItems.length > 0
    && aItems.every((x) => t1Body.includes(x)), `${aItems.length} 文`);

  /*
   * **閲覧者の artifacts でタイプが反転しないこと** (2026-08-30 の実障害の逆向き)。
   * がんリスク検査を持たない閲覧者が引いても、サンプルの材料はタイプ1 のままでなければ
   * ならない。ここが連動すると、材料とタイプの根拠が別の回のものになる。
   */
  const asDemoNoCancer = await loadReportVM({
    diagnosticUserId: DEMO_UID, name: 'テスト 様', chronologicalAge: 56,
    ourWellnessAge: null, hasCancerRisk: false, cycleSeq: null,
  });
  check('閲覧者の検査でサンプルのタイプが変わらない', asDemoNoCancer.reportType === 1,
    `reportType=${asDemoNoCancer.reportType}`);

  /*
   * **一般顧客にはサンプルが出ないこと。** ここが逆になると、実顧客の画面に
   * 他人名義のダミーが「自分の報告書」として出る (`13a8a95` が塞いだ事故)。
   */
  const asCustomer = await loadReportVM({
    diagnosticUserId: 'aaaaaaaa-1111-2222-3333-444444444444',
    name: '顧客 様',
    chronologicalAge: 56,
    ourWellnessAge: null,
    hasCancerRisk: false,
    cycleSeq: null,
  });
  check('一般顧客にサンプルを出さない', asCustomer.isSample === false && asCustomer.chapters.length === 0,
    `isSample=${asCustomer.isSample} / 全編 ${asCustomer.chapters.length} 章`);
}

// ── 13) 2026-08-24 受領のタイプ1 検体 (検査値ファイルが 3 つ・health_age が null) ──
const t1 = buildReportVM({
  reportText: T1_TEXT,
  checkup: { health_checkup: T1_CHECKUP, blood_test: T1_BLOOD, cancer_risk: T1_CANCER } as never,
  name: '', issuedOn: '2026-08-24', isSample: true, hasCancerRisk: false,
  cycleSeq: 1, chronologicalAge: 56, ourWellnessAge: 52.3, readConfig: () => '',
});
// ① health_age: null を 0 にしない。当社が算出して渡した元の値で埋める (発注者指示 2026-09-01)
check('health_age が null でも 0 にしない', t1.cover.wellnessAge !== 0);
check('health_age が無ければ当社 CABA の値で埋める', t1.cover.wellnessAge === 52.3);
check('どちらを出したかは監査に出る',
  t1.audit.anomalies.some((a) => a.includes('当社 CABA の値で補完')));
const t1NoOurs = buildReportVM({
  reportText: T1_TEXT, checkup: T1_CHECKUP as never, name: '', issuedOn: '2026-08-24',
  isSample: true, hasCancerRisk: false, cycleSeq: null, chronologicalAge: 56, readConfig: () => '',
});
check('当社の値も無ければ null (0 にしない)', t1NoOurs.cover.wellnessAge === null);

// ② 基準値は「基準値：」でも「基準値 」でも拾う。**世代差で黙って空にしない**
check('基準値をコロン無しの世代でも拾う', t1.audit.referenceCount === 7,
  `referenceCount=${t1.audit.referenceCount}`);

// ③ 検査値ファイル 3 つを 1 つの表に。問診は外す (発注者指示 2026-09-01)
check('3 ファイルぶんの検査値が入る (37+18+2)', t1.audit.measurementCount === 57,
  `measurementCount=${t1.audit.measurementCount}`);
/*
 * **見るのは検査値の表だけ。** 全編 (chapters) には Elith 自身が本文で
 * 「体重が20歳の頃と比べて10kg以上増加しており」と書いており、そちらは逐語として正しい。
 * 落とすのは「表の行として並べること」であって、本文から消すことではない。
 */
const t1Table = t1.digest.find((c) => c.key === 'measurements');
check('問診を検査値の表に出さない',
  !!t1Table && !JSON.stringify(t1Table).includes('20歳の頃と比べて'));
check('外した設問の件数は監査に出る (黙って落とさない)',
  t1.audit.anomalies.some((a) => a.includes('設問 24 件を検査値の表から外しました')));

// ④ 逐語 — この検体でも紙面の文が受領 JSON の部分文字列であること
let t1Corpus = '';
const walkT1 = (v: unknown): void => {
  if (typeof v === 'string') { t1Corpus += `\n${v}`; return; }
  if (Array.isArray(v)) { v.forEach(walkT1); return; }
  if (v && typeof v === 'object') Object.values(v).forEach(walkT1);
};
walkT1(T1_TEXT);
const t1Norm = t1Corpus.replace(/\s+/g, '');
const t1Sentences: string[] = [];
for (const c of t1.digest) {
  for (const b of c.blocks) {
    const any = b as unknown as { kind: string; items?: unknown[] };
    if (any.kind === 'paragraphs') t1Sentences.push(...(any.items as string[]));
  }
}
// **例外は無い** (spec §4.1 の逐語ルール。暫定文は 2026-09-17 に削除)。
const t1Bad = t1Sentences.filter((x) => !t1Norm.includes(x.replace(/\s+/g, '')));
check('タイプ1 でもダイジェストの段落は受領本文の逐語',
  t1Bad.length === 0, `${t1Bad.length} 文が一致しない: ${t1Bad[0]?.slice(0, 40) ?? ''}`);

// ── 14) 詳細への導線 (発注者裁定 2026-09-01・案 03) ───────────────────
{
  /*
   * **冒頭の総括 (lead) には導線を付けない。** 全文をその場に出しており、
   * 飛び先の章も無い (全編から外した) ため。押しても何も起きないリンクを置かない。
   */
  const linkable = t1.digest.filter((c) => !c.lead);
  const withLink = linkable.filter((c) => c.detailAnchor);
  check('ダイジェストのカードに詳細への導線が付く', withLink.length === linkable.length,
    `${withLink.length} / ${linkable.length} 枚`);
  check('冒頭の総括には導線を付けない',
    t1.digest.filter((c) => c.lead).every((c) => !c.detailAnchor));
  const keys = new Set(t1.chapters.map((c) => c.key));
  check('導線の飛び先は実在する章', t1.digest.every((c) =>
    !c.detailAnchor || keys.has(c.detailAnchor.replace(/^ch-/, ''))));
  /*
   * **章を隠したら導線も消えること。** 押しても何も起きないリンクを置かない
   * (主軸 A のリンクで遷移先の無い 404 を出した反省・spec §1.3.10 の④)。
   * `cancer_finding` は abstract → summary の順で探すので、両方隠して確かめる。
   */
  const hidden = buildReportVM({
    reportText: T1_TEXT,
    checkup: { health_checkup: T1_CHECKUP, blood_test: T1_BLOOD, cancer_risk: T1_CANCER } as never,
    name: '', issuedOn: '2026-08-24', isSample: true, hasCancerRisk: false, cycleSeq: null,
    chronologicalAge: 56, ourWellnessAge: 52.3,
    readConfig: (k) => (k === 'report.sections.hidden' ? 'abstract,summary,medical_visit' : ''),
  });
  const dead = hidden.digest.filter((c) => c.detailAnchor
    && !hidden.chapters.some((ch) => `ch-${ch.key}` === c.detailAnchor));
  check('隠した章への導線は残さない', dead.length === 0,
    dead.map((c) => `${c.key}→${c.detailAnchor}`).join(' / '));
}

// ── 15) 当社が書いた文を紙面に出さない / 救急ラベルは出さない ─────────
//
// 【なぜ機械で見張るか】どちらも**紙面は正常に見えたまま**間違う種類の誤りで、
// 実データで Wellfort に指摘されるまで気づけなかった (2026-09-16)。
// ③ 当社の 2 文が Elith 本文と併記されて矛盾 / ④ 否定文に「すぐ受診」が付いた。
{
  /** 紙面 (ダイジェスト + 全編) に出る文字を 1 本に連ねる。 */
  const sheetText = (v: ReportVM): string => {
    const out: string[] = [];
    for (const c of v.digest) {
      out.push(c.title, c.source);
      for (const b of c.blocks) {
        if (b.kind === 'paragraphs') out.push(...b.items);
        if (b.kind === 'steps' || b.kind === 'weeks') out.push(...b.items.map((i) => `${i.heading}${i.text}`));
        if (b.kind === 'pairs') out.push(...b.items.map((i) => `${i.heading}${i.current}${i.action}`));
        if (b.kind === 'table') out.push(...b.rows.map((r) => `${r.name}${r.judgement}`));
      }
    }
    for (const ch of v.chapters) for (const t of ch.topics) out.push(t.heading, t.body);
    return out.join('\n');
  };

  // ③ パイロット暫定文 = 当社が書いた唯一の文。**もう出ない。**
  const pilot = 'がんに関して特に気になる点は見当たりませんでした';
  check('当社の暫定文が紙面に出ない (タイプ2)', !sheetText(vm).includes(pilot));
  check('当社の暫定文が紙面に出ない (タイプ1)', !sheetText(t1).includes(pilot));
  check('タイプ2 で材料が無ければ A のカードを出さない',
    !vm.digest.some((c) => c.key === 'cancer_finding'));
  check('出さなかったことは監査に出る (黙って消さない)',
    vm.audit.emptyCards.includes('cancer_finding'));
  check('材料が無くても軸の帯は立つ', vm.axes.length === 1);

  // ① 出典行 = 受領 JSON のどこから採ったかだけ。社内表記を紙面に出さない。
  // `ui.cancer_screening_not_included` は `elith-report-queries.ts` が
  // `cancerFallbackText` として渡す (readConfig 経由ではない)。
  const withFallback = buildReportVM({
    reportText: REPORT_TEXT, checkup, name: '', issuedOn: '2026-08-26', isSample: true,
    hasCancerRisk: false, cycleSeq: null, chronologicalAge: 56, readConfig: () => '',
    cancerFallbackText: 'この報告書は、がんリスク検査を含まない検査データをもとに作成しています。',
  });
  const fb = withFallback.digest.find((c) => c.key === 'cancer_finding');
  check('admin の文言を入れればカードが出る', !!fb);
  check('受領 JSON 由来でない文には出典を書かない', fb?.source === '',
    `source="${fb?.source ?? '(カード無し)'}"`);
  /*
   * **`withFallback` も必ず見る。** 材料の無い `vm` では A のカードごと出ないので、
   * `vm` と `t1` だけだと出典を見ていないのと同じになる (この検査が空振りする)。
   */
  for (const [label, v] of [['タイプ2', vm], ['タイプ1', t1], ['admin 文言あり', withFallback]] as const) {
    check(`社内表記 (spec §) が紙面に出ない — ${label}`, !sheetText(v).includes('spec §'));
  }

  // ④ 救急カード。**材料は在るのに出さない**ことを、材料の実在ごと固定する。
  const ER = '早急な医療確認';
  check('検体に救急文が実在する (この検査が空振りしていない)', CORPUS.includes(ER));
  check('救急カードを出さない', !vm.digest.some((c) => c.key === 'emergency'));
  check('赤 (tone=emergency) のカードが 1 枚も無い',
    !vm.digest.some((c) => c.tone === 'emergency'));
  check('救急の文は全編に原文のまま残る (黙って消していない)',
    vm.chapters.some((ch) => ch.topics.some((t) => t.body.includes(ER))));
}

// ── 16) 本文に紛れた生成メタ行 (発注者判断 2026-09-17) ───────────────
//
// 受領本文の末尾に `全体文字数：3012文字` が付いて届く回がある (実測 4 名・値も共通)。
// **報告書の中身ではないので紙面に出さず、落とした事実は監査に出す。**
{
  const body = 'これは本文です。記録を続けましょう。';
  const withMeta = buildReportVM({
    reportText: { lifestyle: { section_name: 'ライフスタイル総合', text: `${body}\n\n全体文字数：3012文字` } },
    checkup: null, name: '', issuedOn: '2026-09-17', isSample: true,
    hasCancerRisk: false, cycleSeq: null, chronologicalAge: null, readConfig: () => '',
  });
  const text = withMeta.chapters.flatMap((c) => c.topics.map((t) => t.body)).join('\n');
  check('生成メタ行は紙面に出ない', !text.includes('全体文字数'), text.slice(-40));
  check('本文そのものは 1 文字も落とさない', text.includes(body));
  check('落としたことは監査に出る (黙って消さない)',
    withMeta.audit.anomalies.some((a) => a.includes('全体文字数')));

  // **落とすのは章の末尾の 1 行だけ。** 文中に同じ字面があっても触らない (narrow)。
  const inMiddle = buildReportVM({
    reportText: { lifestyle: { section_name: 'ライフスタイル総合', text: '全体文字数：3012文字 と書かれた資料。続きの本文です。' } },
    checkup: null, name: '', issuedOn: '2026-09-17', isSample: true,
    hasCancerRisk: false, cycleSeq: null, chronologicalAge: null, readConfig: () => '',
  });
  check('文中の同じ字面は触らない',
    inMiddle.chapters.flatMap((c) => c.topics.map((t) => t.body)).join('').includes('全体文字数：3012文字'));

  /*
   * **実検体 (2026-08-26) にも入っていた** — `lifestyle` 末尾の「全体文字数：2997文字」。
   * つまり 4 名だけの事故ではなく、この形式で恒常的に混ざっている。
   * 実データ側でも落ちていること・監査に出ていることを固定する。
   */
  check('実検体でもメタ行を落としている',
    vm.audit.anomalies.some((a) => a.includes('全体文字数')));
  const sheet = vm.chapters.flatMap((c) => c.topics.map((t) => t.body)).join('\n');
  check('実検体の紙面にメタ行が出ない', !sheet.includes('全体文字数'));
}

// ── 17) カードの軸はレジストリが正 (2026-09-17 に実際に踏んだ) ──────
//
// アダプタ側に軸を 'a' / 'b' とベタ書きしていたため、レジストリで `cancer_finding` を
// b へ移しても表示モデルは 'a' のままになり、**画面から静かに消えた**
// (`verify:screen` が先に検出)。表示モデル側でも固定しておく。
{
  const reg = new Map(resolveChapters(() => '').chapters.map((c) => [c.key, c.axis]));
  const both = [...vm.digest, ...t1.digest];
  const stray = both.filter((c) => reg.has(c.key) && reg.get(c.key) !== c.axis);
  check('カードの軸がレジストリと一致する', stray.length === 0,
    stray.map((c) => c.key + ':' + c.axis).join(','));
  const axisKeys = new Set(vm.axes.map((a) => a.key));
  const orphan = both.filter((c) => !axisKeys.has(c.axis));
  check('どのカードも実在する軸に属する (画面から消えない)', orphan.length === 0,
    orphan.map((c) => c.key + ':' + c.axis).join(','));
}

// ── 18) 身長・体重の出所 (spec §4.13・発注者判断 2026-09-17) ────────
//
// 検診の実測値と問診の申告値は**どちらも正しく、食い違って当然** (AI 診断を回す時点で
// 問診は最新・検診は半年前ということがある)。**上書きせず、出所だけを添える。**
// 実測: 吉光様の本文 175cm/70kg は共通問診表の申告値と完全一致・検診は 173.5/69.9。
{
  const SEC = (t: string) => ({ lifestyle: { section_name: 'ライフスタイル総合', text: t } });
  const HC = { '身長 [cm]': [{ value: 173.5 }], '体重 [kg]': [{ value: 69.9 }], '標準体重 [kg]': [{ value: 66.2 }] };
  const body = (v: ReportVM) => v.chapters.flatMap((c) => c.topics.map((t) => t.body)).join('\n');
  const run = (text: string, self: { height?: number | null; weight?: number | null } | null) =>
    buildReportVM({
      reportText: SEC(text), checkup: { health_checkup: HC } as never, name: '', issuedOn: '2026-09-17',
      isSample: true, hasCancerRisk: false, cycleSeq: null, chronologicalAge: null,
      readConfig: () => '', selfReported: self,
    });

  const TXT = '現在の体重は70kg、身長は175cmと報告されています。標準体重は66.2kgとされています。';
  const ok = run(TXT, { height: 175, weight: 70 });
  check('問診の申告値と一致する数値に出所を添える',
    body(ok).includes('70kg（問診時）') && body(ok).includes('175cm（問診時）'), body(ok).slice(0, 80));
  check('標準体重には添えない (別項目)', body(ok).includes('66.2kgとされています'));
  /*
   * **「標準体重」を体重として拾っていないこと。** 紙面だけ見ると印が付かないので
   * 素通りする (実測: 退行を入れても緑のままだった)。**監査に 66.2 が現れないこと**で
   * 「そもそも体重として比べていない」を固定する。
   */
  check('標準体重を体重として比べていない',
    !ok.audit.anomalies.some((a) => a.includes('66.2')),
    ok.audit.anomalies.filter((a) => a.includes('66.2')).join(' / '));
  check('数値そのものは書き換えない', body(ok).includes('70kg') && !body(ok).includes('69.9kg'));
  check('添えたことは監査に出る', ok.audit.anomalies.some((a) => a.includes('問診時の申告値')));

  // **推測で出所を書かない。** 問診値が無い / 一致しないときは紙面を触らず監査だけ。
  const noSelf = run(TXT, null);
  check('問診値が無ければ紙面を触らない', !body(noSelf).includes('（問診時）'));
  check('それでも食い違いは監査に出る',
    noSelf.audit.anomalies.some((a) => a.includes('出所を書きませんでした')));
  const other = run(TXT, { height: 180, weight: 80 });
  check('問診値と一致しなければ添えない', !body(other).includes('（問診時）'));

  // 検診値と一致している数値は「食い違い」ではない。
  const same = run('現在の体重は69.9kg、身長は173.5cmです。', { height: 175, weight: 70 });
  check('検診値と一致する数値には添えない', !body(same).includes('（問診時）'));

  // 検診に身長・体重が無い回 (実測: 坂田様) は比べる相手がいないので触らない。
  const noRef = buildReportVM({
    reportText: SEC(TXT), checkup: null, name: '', issuedOn: '2026-09-17', isSample: true,
    hasCancerRisk: false, cycleSeq: null, chronologicalAge: null, readConfig: () => '',
    selfReported: { height: 175, weight: 70 },
  });
  check('検診値が無い回は触らない', !body(noRef).includes('（問診時）'));

  // 実検体 (2026-08-26) は問診値を渡していないので 1 か所も付かない。
  check('問診値を渡していない実検体では付かない',
    !vm.chapters.flatMap((c) => c.topics.map((t) => t.body)).join('').includes('（問診時）'));
}

// ── 結果 ──────────────────────────────────────────────────────────
console.log(`\n受領本文 ${CORPUS.length} 字 / ダイジェスト ${digestChars} 字 (削減率 ${reduction.toFixed(1)}%)`);
console.log(`検査値 ${vm.audit.measurementCount} 行・基準値 ${vm.audit.referenceCount} 件・トピック ${vm.audit.topicCount} 件`);
if (vm.audit.anomalies.length) {
  console.log(`\n受領データの異常 ${vm.audit.anomalies.length} 件 (紙面には出さない):`);
  for (const a of vm.audit.anomalies) console.log(`  - ${a}`);
}
console.log(`\n${fails.length ? '✗' : '✓'} ${pass} / ${pass + fails.length} 件`);
for (const f of fails) console.log(`  ✗ ${f}`);
if (fails.length) process.exit(1);
