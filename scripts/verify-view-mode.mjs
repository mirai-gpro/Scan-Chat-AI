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

import { readFileSync, readdirSync } from 'node:fs';
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

/** 実物の `view-mode.ts` を動かす (資格の 2 関数だけスタブ)。 */
function load(caps) {
  const src = read('src/lib/view-mode.ts').replace(/import\.meta\.env/g, 'globalThis.__env');
  const out = js(src);
  const mod = { exports: {} };
  const req = (spec) => {
    if (spec === './demo-accounts') {
      return { demoDisabledGlobally: () => !!caps.globalOff, isDemoAccount: () => !!caps.demo };
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
// ① ログイン直後は必ず Real (発注者の絶対条件)
// ══════════════════════════════════════════════════════════════════════
console.log('\n① Cookie が無いとき (= ログイン直後) の既定\n');
{
  /*
   * **Dual は Real** (発注者の絶対条件)。**Demo の資格だけなら Demo** —
   * あちらは実データを 1 件も持たない枠なので、Real を既定にすると
   * **URL を開いた記者が空の画面に着く** (PR-C 前と同じ挙動に保つ)。
   */
  const TABLE = [
    [{ demo: true, special: true }, 'Dual (両資格)', 'real', false],
    [{ demo: true }, 'Demo の資格だけ', 'demo', true],
    [{ special: true }, 'Real の資格だけ', 'real', false],
    [{}, '一般顧客', 'real', false],
  ];
  for (const [caps, label, wantMode, wantDummy] of TABLE) {
    const M = load(caps);
    const st = M.resolveViewMode({ kind: 'self', uid: UID }, null);
    eq(`${label} → effectiveMode=${wantMode}`, st.effectiveMode, wantMode);
    eq(`  ${label} → ダミー ${wantDummy ? 'あり' : 'なし'}`,
      M.shouldUseDemoData(UID, st.effectiveMode), wantDummy);
  }
  // **Dual が Real なのがこの PR の肝** (ここが demo になると実データの人にダミーが出る)。
  const dual = load({ demo: true, special: true });
  eq('**Dual は既定で Real** (ダミーを先に見せない)',
    dual.shouldUseDemoData(UID, dual.resolveViewMode({ kind: 'self', uid: UID }, null).effectiveMode),
    false);
}

// ══════════════════════════════════════════════════════════════════════
// ② Demo になるのは「資格 × 本人のセッション × 明示的な切り替え」が揃ったときだけ
// ══════════════════════════════════════════════════════════════════════
console.log('\n② Demo へ入れる条件\n');
{
  const dual = load({ demo: true, special: true });
  const st = dual.resolveViewMode({ kind: 'self', uid: UID }, 'demo');
  eq('Dual が切り替えた → demo', [st.effectiveMode, st.switchable, st.dual], ['demo', true, true]);
  eq('  そのときダミーが出る', dual.shouldUseDemoData(UID, st.effectiveMode), true);

  const realOnly = load({ special: true });
  const st2 = realOnly.resolveViewMode({ kind: 'self', uid: UID }, 'demo');
  eq('**Real 資格だけ → 切り替えようとしても real**', [st2.effectiveMode, st2.switchable], ['real', false]);
  eq('  ダミーは出ない', realOnly.shouldUseDemoData(UID, 'demo'), false);

  const none = load({});
  eq('一般顧客 → 切り替え不可', none.resolveViewMode({ kind: 'self', uid: UID }, 'demo').switchable, false);
  eq('  mode を demo と渡されてもダミーは出ない', none.shouldUseDemoData(UID, 'demo'), false);

  const off = load({ demo: true, globalOff: true });
  eq('全停止スイッチ (PUBLIC_DEMO_FALLBACK=false) が効く',
    [off.resolveViewMode({ kind: 'self', uid: UID }, 'demo').effectiveMode,
      off.shouldUseDemoData(UID, 'demo')], ['real', false]);
}

// ══════════════════════════════════════════════════════════════════════
// ③ 切り替えさせない相手 (代理表示・共有・未サインイン)
// ══════════════════════════════════════════════════════════════════════
console.log('\n③ 切り替えさせない相手\n');
{
  const M = load({ demo: true, special: true });
  /*
   * **切り替えは与えない** (`switchable:false`) = Cookie を見ない。
   * 既定は**表示対象の資格**に従う (PR-C 前の挙動を変えない) ので、
   * Dual を代理表示・共有しているときは `real` になる。
   */
  for (const kind of ['admin_impersonation', 'admin_impersonation_legacy', 'share', 'uid_entry']) {
    const st = M.resolveViewMode({ kind, uid: UID }, 'demo');
    eq(`${kind} → Cookie を見ない / 切り替え不可`, [st.effectiveMode, st.switchable], ['real', false]);
  }
  /*
   * **未サインインは `demo`**。セッションが無いので資格を引けず、
   * **ダミーを出すかは `shouldUseDemoData` が「表示する uid」で判定する**。
   * 一般顧客の uid が表示されることは無い (本番はサインイン画面で止まる)。
   */
  {
    const st = M.resolveViewMode({ kind: 'anonymous', uid: null }, null);
    eq('anonymous → demo だが切り替えは不可', [st.effectiveMode, st.switchable], ['demo', false]);
    eq('  それでもデモ用アカウントでない uid にダミーは出ない',
      load({}).shouldUseDemoData('aaaaaaaa-1111-2222-3333-444444444444', 'demo'), false);
  }
  for (const kind of ['self', 'admin_self']) {
    eq(`${kind} は切り替えられる`, M.resolveViewMode({ kind, uid: UID }, 'demo').switchable, true);
  }
}

// ══════════════════════════════════════════════════════════════════════
// ④ 壊れた Cookie で Demo にしない
// ══════════════════════════════════════════════════════════════════════
console.log('\n④ Cookie の解釈\n');
{
  const M = load({ demo: true });
  eq('demo', M.parseMode('demo'), 'demo');
  eq('real', M.parseMode('real'), 'real');
  eq('大文字・空白を吸収', M.parseMode(' DEMO '), 'demo');
  for (const bad of ['', null, undefined, 'DEMO!', '1', 'true', 'dem', 'demo,real']) {
    eq(`知らない値 ${JSON.stringify(bad)} → null`, M.parseMode(bad), null);
  }
  // Cookie が無い / 読めないときは**既定へ倒れる** (Demo だけの枠なら demo)。
  eq('null は既定へ倒れる (Demo だけの枠)',
    M.resolveViewMode({ kind: 'self', uid: UID }, null).effectiveMode, 'demo');
  eq('  Dual では real へ倒れる',
    load({ demo: true, special: true }).resolveViewMode({ kind: 'self', uid: UID }, null).effectiveMode, 'real');
  eq('  壊れた Cookie も同じ (demo と解釈しない)',
    load({ demo: true, special: true })
      .resolveViewMode({ kind: 'self', uid: UID }, M.parseMode('DEMO!')).effectiveMode, 'real');
  const opt = M.modeCookieOptions();
  eq('Cookie は HttpOnly / SameSite=Lax / path=/',
    [opt.httpOnly, opt.sameSite, opt.path], [true, 'lax', '/']);
  ok('本番は Secure', opt.secure === true, 'dev (http) だけ外す');
  eq('Cookie 名', M.MODE_COOKIE, 'welltect_mode');
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
// ⑧ 切り替え API の約束
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑧ POST /api/session/view-mode\n');
{
  const api = code('src/pages/api/session/view-mode.ts');
  ok('resolveViewer を通している', /resolveViewer\(apiCtx\)/.test(api));
  ok('**switchable でなければ 403** (条件を書き写さない)',
    /if \(!state\.switchable\)/.test(api) && /\}, 403\)/.test(api),
    '条件を書き写すと表示側と食い違い「切り替えたのに変わらない」が起きる');
  ok('403 の判定が Cookie を書くより前',
    api.indexOf('403') < api.indexOf('cookies.set'),
    '後ろだと資格の無い相手の Cookie が書かれる');
  ok('知らない値は 400 で何も書かない',
    api.indexOf("'invalid_mode'") > 0 && api.indexOf("'invalid_mode'") < api.indexOf('cookies.set'));
  ok('real は Cookie を消す', /cookies\.delete\(MODE_COOKIE/.test(api));
  ok('応答は資格から組み直す (申告をそのまま返さない)',
    /const after = resolveViewMode\(viewer,/.test(api));
  ok('no-store を付けている', /private, no-store/.test(api));
  ok('GET を公開していない', !/export const GET/.test(api),
    'アドレスバーから叩ける口を開けない (CSRF の面も狭くする)');
}

// ══════════════════════════════════════════════════════════════════════
// ⑨ 切り替え UI は資格のある本人にだけ
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑨ 切り替え UI\n');
{
  const dash = code('src/pages/dashboard.astro');
  ok('`switchable` のときだけ描く',
    /\{viewMode\.switchable && <ViewModeSwitch/.test(dash),
    '一般の利用者・代理表示・共有に出すと「押せるのに 403」になる');
  const sw = code('src/components/dashboard/ViewModeSwitch.astro');
  ok('Cookie を JS から書いていない (必ずサーバの口)',
    !/document\.cookie/.test(sw) && /fetch\('\/api\/session\/view-mode'/.test(sw));
  ok('成功したら開き直す (部分更新にしない)', /location\.reload\(\)/.test(sw),
    'モードはサーバ側の全問い合わせに効くので、部分更新だと食い違う');
  ok('失敗を黙らせない (行き止まりにしない)',
    /data-view-mode-error/.test(sw) && /disabled = false/.test(sw));
  ok('brand 塗りを使っていない (1 画面 1 つの塗りは報告書のタイル)',
    !/bg-brand-600|bg-brand-700/.test(sw));
  ok('既存の同格ペアの型を使っている', /btn-pair/.test(sw) && /btn-data/.test(sw) && /btn-graph/.test(sw));
}

// ══════════════════════════════════════════════════════════════════════
// ⑩ この領域で増やさないもの
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑩ 増やさないもの\n');
{
  ok('migration を 1 本も足していない',
    !readdirSync(resolve(ROOT, 'supabase/migrations')).some((f) => /2026102[2-9]/.test(f)));
  ok('app_config のキーを増やしていない', !/mode\.|experience\./.test(read('src/lib/app-config.ts')));
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
