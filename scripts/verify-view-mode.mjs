#!/usr/bin/env node
/**
 * `npm run verify:view-mode` — **表示モード (Real / Demo) の回帰チェック**。
 *
 * 正本 `docs/specs/special_demo_integration_spec_20261022.md` §4.2 / §4.3 (PR-C)。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【守るもの】**Demo 表示中だけ Demo データ / Real 表示中は本人の実データ**
 * ══════════════════════════════════════════════════════════════════════
 *
 * PR-B までは「スペシャル枠なら無条件でダミーを出さない」という**排他 1 行**で
 * 事故を止めていた。Dual (両資格) が正常な状態になったのでその排他は外し、
 * **既定を Real にして、Demo になるのは本人が明示的に切り替えたときだけ**にした。
 *
 * **ここは静かに壊れる** — モードを渡し忘れたページだけ Demo / Real が食い違い、
 * しかも**画面は正常に見える** (ダミーが本人のデータのように並ぶ)。目視では守れない。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
/** コメント行を落とす (経緯の説明に旧コードの名前が書いてあるため)。 */
const code = (p) => read(p).split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');

const fails = [];
const ts = (await import('typescript')).default;
const js = (src) => ts.transpileModule(src, { compilerOptions: { target: 'ES2022', module: 'CommonJS', esModuleInterop: true } }).outputText;

const eq = (label, got, want) => {
  const okk = JSON.stringify(got) === JSON.stringify(want);
  if (!okk) fails.push(`${label} — got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
  console.log(`  ${okk ? '✓' : '✗'} ${label}`);
};
const ok = (label, cond, why) => {
  if (!cond) fails.push(`${label}${why ? ` — ${why}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
};

/**
 * 実物の `view-mode.ts` を動かす (**資格と admin 指定の 3 関数だけ**スタブ)。
 *
 * `caps.forced` = admin が `demo.display_uids` に入れた状態。
 */
function load(caps) {
  const src = read('src/lib/view-mode.ts').replace(/import\.meta\.env/g, 'globalThis.__env');
  const out = js(src);
  const mod = { exports: {} };
  const req = (spec) => {
    if (spec === './demo-accounts') {
      return {
        demoDisabledGlobally: () => !!caps.globalOff,
        isDemoAccount: () => !!caps.demo,
        isForcedDemoDisplay: () => !!caps.forced,
      };
    }
    if (spec === './special-accounts') return { isSpecialAccount: () => !!caps.special };
    if (spec === 'astro') return {};
    throw new Error(`スタブしていない依存 ${spec}`);
  };
  // eslint-disable-next-line no-new-func
  new Function('require', 'exports', 'module', out)(req, mod.exports, mod);
  return mod.exports;
}
globalThis.__env = { DEV: false };
const UID = '11111111-1111-1111-1111-111111111111';

// ══════════════════════════════════════════════════════════════════════
// ① admin が何も指定していないときの既定
//    **PR-C から 1 文字も変えていない** (発注者の絶対条件「Dual は Real」)
// ══════════════════════════════════════════════════════════════════════
console.log('\n① admin の指定が無いときの既定\n');
{
  /*
   * **Dual は Real** (発注者の絶対条件)。**Demo の資格だけなら Demo** —
   * あちらは実データを 1 件も持たない枠なので、Real を既定にすると
   * **URL を開いた記者が空の画面に着く**。
   */
  const TABLE = [
    [{ demo: true, special: true }, 'Dual (両資格)', 'real', false],
    [{ demo: true }, 'Demo の資格だけ', 'demo', true],
    [{ special: true }, 'Real の資格だけ', 'real', false],
    [{}, '一般顧客', 'real', false],
  ];
  for (const [caps, label, wantMode, wantDummy] of TABLE) {
    const M = load(caps);
    const st = M.resolveViewMode({ kind: 'self', uid: UID });
    eq(`${label} → effectiveMode=${wantMode}`, st.effectiveMode, wantMode);
    eq(`  ${label} → ダミー ${wantDummy ? 'あり' : 'なし'}`,
      M.shouldUseDemoData(UID, st.effectiveMode), wantDummy);
    eq(`  ${label} → forcedDemo=false (指定ではない)`, st.forcedDemo, false);
  }
  // **Dual が Real なのが肝** (ここが demo になると実データの人にダミーが出る)。
  const dual = load({ demo: true, special: true });
  eq('**Dual の既定は Real** (ダミーを先に見せない)',
    dual.shouldUseDemoData(UID, dual.resolveViewMode({ kind: 'self', uid: UID }).effectiveMode),
    false);
}

// ══════════════════════════════════════════════════════════════════════
// ② Demo になるのは「資格 × admin の指定」が揃ったときだけ
//    **発注者指示 2026-10-22**: 利用者の希望はもう入力にならない
// ══════════════════════════════════════════════════════════════════════
console.log('\n② Demo へ入れる条件 (資格 × admin の指定)\n');
{
  const dual = load({ demo: true, special: true, forced: true });
  const st = dual.resolveViewMode({ kind: 'self', uid: UID });
  eq('Dual を admin がデモ表示に指定 → demo',
    [st.effectiveMode, st.forcedDemo, st.dual], ['demo', true, true]);
  eq('  そのときダミーが出る', dual.shouldUseDemoData(UID, st.effectiveMode), true);

  /*
   * ── **資格 → 表示 の順** ──────────────────────────────────────
   * ここが逆になると `demo.display_uids` が「資格」の二重管理になり、
   * **除外リストで止めた人にダミーが出る**。
   */
  const realOnly = load({ special: true, forced: true });
  const st2 = realOnly.resolveViewMode({ kind: 'self', uid: UID });
  eq('**Demo の資格が無い uid を指定しても real** (資格が先)',
    [st2.effectiveMode, st2.forcedDemo], ['real', false]);
  eq('  ダミーは出ない', realOnly.shouldUseDemoData(UID, 'demo'), false);

  const none = load({ forced: true });
  eq('一般顧客を指定しても効かない',
    none.resolveViewMode({ kind: 'self', uid: UID }).effectiveMode, 'real');
  eq('  mode を demo と渡されてもダミーは出ない', none.shouldUseDemoData(UID, 'demo'), false);

  const off = load({ demo: true, forced: true, globalOff: true });
  eq('全停止スイッチ (PUBLIC_DEMO_FALLBACK=false) が指定より強い',
    [off.resolveViewMode({ kind: 'self', uid: UID }).effectiveMode,
      off.shouldUseDemoData(UID, 'demo')], ['real', false]);
}

// ══════════════════════════════════════════════════════════════════════
// ③ **閲覧者の種別でモードが変わらない**
//    モードがアカウントの属性になった結果の、いちばん大事な性質。
//    admin が A さんを代理表示したら **A さん本人が見るのと同じ画面**になる。
// ══════════════════════════════════════════════════════════════════════
console.log('\n③ 誰が見てもモードは同じ\n');
{
  const KINDS = ['self', 'admin_self', 'admin_impersonation',
    'admin_impersonation_legacy', 'share', 'uid_entry'];
  // 指定なしの Dual → 全員 real
  {
    const M = load({ demo: true, special: true });
    for (const kind of KINDS) {
      eq(`${kind} → real (指定なしの Dual)`,
        M.resolveViewMode({ kind, uid: UID }).effectiveMode, 'real');
    }
  }
  // admin がデモ表示に指定した Dual → 全員 demo
  {
    const M = load({ demo: true, special: true, forced: true });
    for (const kind of KINDS) {
      eq(`${kind} → demo (admin が指定した Dual)`,
        M.resolveViewMode({ kind, uid: UID }).effectiveMode, 'demo');
    }
    ok('**代理表示でも本人と同じ画面になる**',
      M.resolveViewMode({ kind: 'admin_impersonation', uid: UID }).effectiveMode
        === M.resolveViewMode({ kind: 'self', uid: UID }).effectiveMode,
      '「A さんの画面のつもりで別のものを見る」が構造的に起きない');
  }
  /*
   * **未サインインは `demo`**。セッションが無いので資格を引けず、
   * **ダミーを出すかは `shouldUseDemoData` が「表示する uid」で判定する**。
   */
  {
    const M = load({ demo: true, special: true });
    eq('anonymous → demo', M.resolveViewMode({ kind: 'anonymous', uid: null }).effectiveMode, 'demo');
    eq('  それでもデモ用アカウントでない uid にダミーは出ない',
      load({}).shouldUseDemoData('aaaaaaaa-1111-2222-3333-444444444444', 'demo'), false);
  }
}

// ══════════════════════════════════════════════════════════════════════
// ④ **利用者側の切替が存在しないこと** (発注者指示 2026-10-22)
//
//    「ユーザーに切り替えさせる、なんてありえない」
//    「SP アカウントやデモを使う人間は、マスコミや有力な大口クライアントなんだぞ」
//
//    ここが戻ると**報道関係者の画面に切替 UI が出る**。画面は正常に見えるので
//    目視では守れない。
// ══════════════════════════════════════════════════════════════════════
console.log('\n④ 利用者側の切替が存在しないこと\n');
{
  const M = load({ demo: true, special: true });
  for (const name of ['MODE_COOKIE', 'modeCookieOptions', 'parseMode']) {
    ok(`**${name} を復活させていない**`, M[name] === undefined,
      'Cookie を読む / 書く経路はモードの入力に戻る');
  }
  ok('**`switchable` を返していない**',
    M.resolveViewMode({ kind: 'self', uid: UID }).switchable === undefined,
    '切り替えられる相手という概念そのものを無くした');
  ok('  `requested` も返していない',
    M.resolveViewMode({ kind: 'self', uid: UID }).requested === undefined);

  /*
   * **コメントは除いて見る** (`code()`)。view-mode.ts の冒頭には
   * 「旧: Cookie `welltect_mode`」という**履歴の記述**が在り、これは残す
   * (何をやめたのかが書いていないと、親切のつもりで戻される)。
   * 見張るのは**実際に動くコード**に Cookie が無いこと。
   */
  const vmSrc = code('src/lib/view-mode.ts');
  /*
   * **引数が viewer 1 つだけであること。** ここを見ていなかったので、
   * 「第 2 引数 (利用者の希望) を戻す」退行が素通りした (2026-10-22 の注入で発覚)。
   * 戻した瞬間に**利用者の要求がモードの入力になる** = 発注者が禁じた形。
   */
  ok('**`resolveViewMode` の引数は viewer 1 つだけ**',
    /export function resolveViewMode\(\s*viewer: Pick<Viewer, 'kind' \| 'uid'>,?\s*\): ViewModeState/
      .test(vmSrc.replace(/\n/g, ' ').replace(/ +/g, ' ')),
    '第 2 引数を復活させない (利用者の希望を受け取らない)');
  ok('  `viewModeFromRequest` も希望を渡していない',
    /return resolveViewMode\(viewer\);/.test(vmSrc));
  ok('view-mode.ts のコードが Cookie 名を持たない', !/welltect_mode/.test(vmSrc));
  ok('  `cookies.get` を呼ばない', !/cookies\.get/.test(vmSrc),
    'viewModeFromRequest がリクエストから何も読まないこと');
  ok('  クエリ (`url.searchParams`) も読まない', !/searchParams/.test(vmSrc),
    '?mode=demo のような抜け道を作らない');

  ok('**`POST /api/session/view-mode` が無い**',
    !existsSync(resolve(ROOT, 'src/pages/api/session/view-mode.ts')),
    'Cookie を書く口');
  ok('**切替コンポーネントが無い**',
    !existsSync(resolve(ROOT, 'src/components/dashboard/ViewModeSwitch.astro')));
  const dash = read('src/pages/dashboard.astro');
  ok('  ダッシュボードが切替を描かない',
    !/ViewModeSwitch/.test(dash) && !/switchable/.test(dash));
  ok('  なぜ置かないかが書いてある', /マスコミ|大口クライアント/.test(dash),
    '理由が無いと「親切のつもり」で戻される');
}

// ══════════════════════════════════════════════════════════════════════
// ⑤ **全件置換**: ダミーを出す判定が 1 か所だけであること
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑤ 判定の口は 1 つだけ\n');
{
  const LIVE = [
    'src/lib/demo-data.ts', 'src/lib/dashboard-queries.ts', 'src/lib/notice-queries.ts',
    'src/lib/measurement-queries.ts', 'src/lib/result-queries.ts', 'src/lib/elith-report-queries.ts',
    'src/lib/experience-accounts.ts', 'src/pages/dashboard.astro', 'src/pages/report.astro',
    'src/pages/trend.astro', 'src/pages/kit.astro', 'src/pages/notices.astro',
    'src/pages/scan.astro', 'src/pages/result/[id].astro',
    'src/pages/api/kit/[id]/external-id.ts', 'src/pages/api/kit/[id]/self-report.ts',
    'src/pages/api/debug/viewer.ts',
    /*
     * **書き込みの口も同じ層を通す** (PR-D・§4.4)。モードを見ずに資格で
     * 止めると、**Dual が Real を表示しているのに保存できない**という形で壊れる
     * (PR-A が踏んだのと同じ取り違え)。どれが分類 A / B かは
     * `verify:write-audit` が見ている。
     */
    'src/pages/api/notices/[id]/read.ts', 'src/pages/api/scan/save.ts',
    'src/pages/api/scan/jobs.ts', 'src/pages/api/scan/export.ts',
    'src/pages/api/interview/export.ts',
  ];
  for (const f of LIVE) {
    ok(`${f.split('/').pop()} に demoFallbackEnabled が無い`,
      !/demoFallbackEnabled\s*\(/.test(code(f)),
      '資格だけでダミーを出すかを決める関数が戻ると、モードを渡し忘れた経路で使われる');
  }
  ok('`demo-data.ts` が資格を直に引いていない',
    !/isDemoAccount\s*\(|isSpecialAccount\s*\(|demoDisabledGlobally\s*\(/.test(code('src/lib/demo-data.ts')),
    'demo-data は「何を見せるか」だけ。「誰に見せるか」は view-mode / demo-accounts の仕事');
  // **資格の層へ排他を移植していないこと** (§4.3「別の場所へ移植しない」)。
  ok('`experience-accounts.ts` に排他が移っていない',
    !/isSpecialAccount\s*\(\s*uid\s*\)\s*\)\s*return false/.test(code('src/lib/experience-accounts.ts')));
  ok('ダミーを出す判定の定義は 1 つ',
    (read('src/lib/view-mode.ts').match(/export function shouldUseDemoData/g) || []).length === 1);

  /*
   * ════════════════════════════════════════════════════════════════════
   * **資格の関数を直に呼んでダミーを出す経路を作らない。**
   * ════════════════════════════════════════════════════════════════════
   *
   * `demoFallbackEnabled` が無いことだけを見ていると、**`isDemoAccount(uid)` を
   * 直に呼ぶ形で旧判定が戻る**。それはモードを見ないので、**そのページだけ
   * Demo / Real が食い違う** (§4.3 がいちばん嫌う形)。
   * **退行注入でこの穴が見つかったので足した** (「notices だけ旧判定へ」が素通りした)。
   *
   * ALLOW は**理由つき**で、しかも**別の検査が裏打ちしているもの**だけ:
   *   `experience-accounts.ts` … **資格の層そのもの** (PR-B)。資格を引くのが仕事で
   *     表示を決めない。表示モードを知らないことは
   *     `verify:experience-accounts` ⑧ が見ている
   *   `api/debug/viewer.ts` … **切り分けの出力だけ**。資格と表示モードを並べて
   *     出すのがこの口の役目で、画面の分岐には使わない
   *   `dashboard.astro` / `scan.astro` の `isSpecialAccount`
   *     … スペシャル専用 UI の判定。**`effectiveMode === 'real'` と AND** に
   *       なっていることは ⑦ が見ている
   */
  const CAPS_ALLOW = {
    'src/lib/view-mode.ts': 'この判定を所有する層',
    'src/lib/experience-accounts.ts': '資格の層 (PR-B)。表示は決めない',
    'src/pages/api/debug/viewer.ts': '切り分けの出力だけ。画面の分岐に使わない',
  };
  const SPECIAL_ALLOW = {
    ...CAPS_ALLOW,
    'src/pages/dashboard.astro': 'スペシャル専用 UI (⑦ が real との AND を見る)',
    'src/pages/scan.astro': 'スペシャル専用 UI (⑦ が real との AND を見る)',
    /*
     * `api/scan/save.ts` の `isSpecialAccount` は**排他ではない** —
     * 複数年取り込みで受診日を読めなかった回を差し戻すための判定
     * (§4.3-1)。`verify:scan-persist` が中身を見ている。
     */
    'src/pages/api/scan/save.ts': '複数年の受診日ガード (排他ではない)',
  };
  for (const f of LIVE) {
    if (!(f in CAPS_ALLOW)) {
      ok(`${f.split('/').pop()} が資格の関数を直に呼んでいない`,
        !/\b(isDemoAccount|demoDisabledGlobally)\s*\(/.test(code(f)),
        'ダミーの可否は shouldUseDemoData(uid, mode) を通す (直に呼ぶとモードを見ない旧判定が戻る)');
    }
    if (!(f in SPECIAL_ALLOW)) {
      ok(`  ${f.split('/').pop()} が isSpecialAccount を直に呼んでいない`,
        !/\bisSpecialAccount\s*\(/.test(code(f)),
        '排他を別の場所へ移植しない (§4.3)');
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// ⑥ モードを渡し忘れられない形になっていること (型で落ちる)
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑥ 渡し忘れを型で落とす\n');
{
  /*
   * **シグネチャを正しく切り出してから見る。** lazy な `[\s\S]{0,600}?` で
   * 当てると**長い doc コメントで届かない / 次の関数まで当たる**ので、
   * `export (async )?function <名前>(` から対応する `)` までを**括弧を数えて**取る
   * (この型の穴は過去に実際に退行を素通りさせた)。
   */
  const sigOf = (src, name) => {
    const i = src.indexOf(`export async function ${name}(`);
    if (i < 0) return null;
    let depth = 0;
    let j = src.indexOf('(', i);
    const from = j;
    for (; j < src.length; j += 1) {
      if (src[j] === '(') depth += 1;
      else if (src[j] === ')') { depth -= 1; if (depth === 0) break; }
    }
    return src.slice(from, j + 1);
  };
  const REQUIRED = [
    ['src/lib/dashboard-queries.ts', 'loadDashboard'],
    ['src/lib/dashboard-queries.ts', 'getHealthAge'],
    ['src/lib/measurement-queries.ts', 'getLatestMeasurements'],
    ['src/lib/measurement-queries.ts', 'getTrendCandidates'],
    ['src/lib/measurement-queries.ts', 'getMeasurementTrend'],
    ['src/lib/notice-queries.ts', 'loadNotices'],
    ['src/lib/notice-queries.ts', 'countUnreadImportant'],
    ['src/lib/result-queries.ts', 'loadResult'],
  ];
  for (const [f, name] of REQUIRED) {
    const sig = sigOf(read(f), name);
    ok(`${name}() が mode: ViewMode を必須で受ける`,
      !!sig && /(^|[(,\s])mode: ViewMode[,)]/.test(sig),
      sig ? `いまの引数 = ${sig.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').slice(0, 120)}`
          : `${name} が見つからない`);
    ok(`  ${name}() の mode に既定値が無い`,
      !!sig && !/mode: ViewMode\s*=/.test(sig),
      '既定値があると渡し忘れたページが黙って real / demo に固定される');
  }
  ok('ReportContext が mode を必須で持つ',
    /\n  mode: ViewMode;/.test(read('src/lib/elith-report-queries.ts')),
    '任意にすると「サンプルが出ない回」が黙って生まれる');
}

// ══════════════════════════════════════════════════════════════════════
// ⑦ 画面・API の結線
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑦ 画面と API の結線\n');
{
  const PAGES = ['src/pages/dashboard.astro', 'src/pages/report.astro', 'src/pages/trend.astro',
    'src/pages/kit.astro', 'src/pages/notices.astro', 'src/pages/scan.astro',
    'src/pages/result/[id].astro'];
  for (const f of PAGES) {
    const src = code(f);
    ok(`${f.split('/').pop()} が viewModeFromRequest を通している`,
      /viewModeFromRequest\(Astro, viewer\)/.test(src),
      '各ページで Cookie を直に読むと、読み方が散って壊れた Cookie を信じるページが出る');
    ok(`  ${f.split('/').pop()} が Cookie を直読みしていない`,
      !/cookies\.get\(\s*['"]welltect_mode/.test(src));
  }
  // **Special 専用 UI は Real 表示のときだけ** (§4.3)。
  ok('singlePurchase は Real 表示 ∧ スペシャル',
    /const singlePurchase = viewMode\.effectiveMode === 'real' && isSpecialAccount\(/.test(read('src/pages/dashboard.astro')));
  ok('multiYear は Real 表示 ∧ スペシャル',
    /const multiYear = viewMode\.effectiveMode === 'real' && isSpecialAccount\(/.test(read('src/pages/scan.astro')));
  // **PR-A の暫定ゲートを置き換えたこと** (資格ではなくモードで見る)。
  for (const f of ['src/pages/api/kit/[id]/external-id.ts', 'src/pages/api/kit/[id]/self-report.ts']) {
    const src = code(f);
    ok(`${f.split('/').pop()}: デモの分岐はモードで見る`,
      /viewMode\.effectiveMode === 'demo' && isDemoShipmentId\(/.test(src),
      '資格で見ると Dual の人が Real を表示していても読取テスト扱いになる');
    ok(`  ${f.split('/').pop()}: 条件は 2 つとも見る`,
      /&& isDemoShipmentId\(/.test(src) && /effectiveMode === 'demo'/.test(src));
  }
  // **admin のバッチは常に Real** (閲覧者の Cookie に左右されない)。
  const bf = code('src/pages/api/admin/derived-blood/backfill.ts');
  ok('admin バッチは Real 固定', /loadDashboard\(uid, 'real'\)/.test(bf)
    && /getTrendCandidates\(uid, 'real',/.test(bf) && /getMeasurementTrend\(uid, 'real',/.test(bf),
    'ダミーを実データとして扱わない');
}

// ══════════════════════════════════════════════════════════════════════
// ⑧ **モードを書く口は admin の 1 本だけ** (発注者指示 2026-10-22)
//
//    旧 `POST /api/session/view-mode` (本人が Cookie を書く) は撤去し、
//    `POST /api/admin/demo-accounts` の `display_demo` / `display_real` に移した。
//    **利用者が到達できる書き口は 1 つも無い。**
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑧ モードを書く口 (admin だけ)\n');
{
  // ── 利用者側の口が無い ───────────────────────────────────────
  {
    const dir = resolve(ROOT, 'src/pages/api/session');
    const left = existsSync(dir) ? readdirSync(dir) : [];
    ok('**`api/session/` にモードを書く口が無い**',
      !left.some((f) => /view-mode/.test(f)),
      `残っているもの: ${JSON.stringify(left)}`);
  }

  // ── admin の口 ───────────────────────────────────────────────
  const api = code('src/pages/api/admin/demo-accounts.ts');
  ok('admin の口が display_demo / display_real を受ける',
    /display_demo\?: unknown/.test(api) && /display_real\?: unknown/.test(api));
  ok('**鍵で守られている** (`isAdminAuthorized`)', /isAdminAuthorized\(request\)/.test(api));
  ok('  認可が body を読むより前',
    api.indexOf('isAdminAuthorized') < api.indexOf('request.json()'),
    '後ろだと鍵の無い相手の要求を解釈してしまう');
  ok('何も指定が無ければ 400 (`nothing_to_do`)',
    /displayDemo\.length === 0 && displayReal\.length === 0/.test(api));

  /*
   * **資格 → 表示 の順を admin 画面でも守る。**
   * 却下せず黙って受けると「指定したのにデモが出ない」を admin が追えない。
   */
  ok('**デモの資格が無い uid は却下する**',
    /デモの資格が無い/.test(api) && /rejected\.push/.test(api));
  ok('  除外中の行も却下する', /!row \|\| row\.denied/.test(api),
    '除外 = 資格が無いので、指定しても resolveViewMode は Demo にしない');
  ok('  uid の形式を見る', /isUuid\(uid\)/.test(api));
  /*
   * **冪等であることをコードの形で見る** (コメントの文ではなく)。
   * `display_real` のループに `rejected.push` が無いこと = 名簿に無い uid を
   * 指定しても落ちない。**既定へ戻すだけの操作で admin を止めない。**
   */
  {
    const at = api.indexOf('for (const uid of displayReal)');
    const body = at > 0 ? api.slice(at, api.indexOf('}', api.indexOf('splice', at))) : '';
    ok('`display_real` は冪等 (名簿に無くても却下しない)',
      at > 0 && !/rejected\.push/.test(body), `ループ本体: ${JSON.stringify(body.slice(0, 120))}`);
  }
  ok('中身が変わらなければ保存しない',
    /if \(displayValue !== cur\.displayRaw\)/.test(api));

  // ── 中継 (wellfort-site) ─────────────────────────────────────
  {
    const relay = resolve(ROOT, '..', 'wellfort-site', 'src/pages/api/admin/demo-accounts.ts');
    if (existsSync(relay)) {
      const r = readFileSync(relay, 'utf8');
      ok('中継が display_demo / display_real を渡す',
        /display_demo: body\.display_demo/.test(r) && /display_real: body\.display_real/.test(r),
        '**allow-list 方式なので、足し忘れると画面から押しても何も起きない**');
    } else {
      console.log('  — wellfort-site が無いので中継の検査は省略');
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// ⑨ **表示モードは admin が決める** = 名簿と管理一覧の約束
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑨ 表示モードの名簿と管理一覧\n');
{
  const da = code('src/lib/demo-accounts.ts');
  ok('`demo.display_uids` を読む関数が在る', /cfg\('demo\.display_uids'\)/.test(da));
  ok('  uid は小文字で突き合わせる', /toLowerCase\(\)/.test(da));
  ok('一覧が「いま出る画面」を返す (`displayRaw`)', /displayRaw/.test(da));
  ok('  **除外中の行には立てない**', /!r\.denied && forcedDemo\.has\(r\.uid\)/.test(da),
    '立てると画面が「デモ表示」と嘘をつく');

  const cfgSpec = code('src/lib/app-config.ts');
  ok('app_config にキーが登録されている (admin から即時)',
    /key: 'demo\.display_uids'/.test(cfgSpec));
  ok('  既定は空 = コード既定に任せる', /'demo\.display_uids'[\s\S]{0,400}?default: ''/.test(cfgSpec));

  /*
   * 管理一覧は **`resolveViewMode()` 本体を呼ぶ**。画面用に条件を書き写すと
   * **「管理画面ではデモと出ているのに本人には実データが出る」**が静かに起きる。
   */
  const adm = code('src/lib/experience-admin.ts');
  ok('**管理一覧は resolveViewMode 本体を呼ぶ** (条件を書き写さない)',
    /resolveViewMode\(\{ kind: 'self'/.test(adm));
  ok('  いま出る画面 / 指定か既定か / 変えられるか を返す',
    /displayMode/.test(adm) && /displayForced/.test(adm) && /displayChangeable/.test(adm));
  ok('  `isForcedDemoDisplay` を直に呼んでいない', !/isForcedDemoDisplay/.test(adm),
    '直に見ると資格のガード (canDemo) を飛ばす');
  ok('  デモ表示の人数を数えている', /showingDemo/.test(adm));
}

// ══════════════════════════════════════════════════════════════════════
// ⑩ この領域で増やさないもの
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑩ 増やさないもの\n');
{
  ok('migration を 1 本も足していない',
    !readdirSync(resolve(ROOT, 'supabase/migrations')).some((f) => /2026102[2-9]/.test(f)));
  /*
   * **増やしたのは `demo.display_uids` 1 本だけ** (発注者指示 2026-10-22)。
   * 表示モードを admin が決めるので、どこかに持たせる必要がある。
   * 置き場所の判断は「秘匿性が低く切り替えが想定される → app_config」。
   * **これ以上増やさない** — `mode.*` / `experience.*` の名前空間を作らない
   * (作ると資格と表示の持ち物が散って、どちらが正か分からなくなる)。
   */
  {
    const cfgSrc = read('src/lib/app-config.ts');
    ok('新しい名前空間を作っていない', !/key: 'mode\.|key: 'experience\./.test(cfgSrc),
      '表示モードは demo.display_uids 1 本に収める');
    const added = (cfgSrc.match(/key: 'demo\.[a-z_]+'/g) || []);
    eq('demo.* のキーは 5 本 (display_uids を 1 本足した)', added.length, 5);
  }
  ok('`welltect_v` の構造・署名に触っていない',
    !/MODE_COOKIE|welltect_mode/.test(code('src/lib/viewer.ts')),
    '認証 Cookie と表示モードを混ぜない (§4.2)');
  ok('サインイン経路が Cookie を書いていない',
    !/welltect_mode|MODE_COOKIE/.test(code('src/pages/api/auth/resolve.ts')),
    '「ログイン直後は必ず Real」は Cookie を書かないことで満たす');
  ok('`view-mode.ts` は leaf のまま (重い依存を引かない)',
    !/supabase|aws-sdk|elith-intake/.test(read('src/lib/view-mode.ts')),
    'ユーザー経路が全部これを import するので、SSR のグラフに重い依存を入れない');
  ok('モジュール変数に現在のモードを置いていない',
    !/^let (current|active)?[Mm]ode/m.test(read('src/lib/view-mode.ts')),
    'SSR は 1 つの isolate で同時リクエストを捌くので、他人のモードが漏れる');
}

console.log(`\n${fails.length === 0 ? '✅ すべて通過' : `❌ ${fails.length} 件 失敗`}`);
for (const f of fails) console.log(`  - ${f}`);
process.exit(fails.length === 0 ? 0 : 1);
