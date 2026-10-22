#!/usr/bin/env node
/**
 * `npm run verify:write-audit` — **書込み監査（PR-D）の回帰チェック**。
 *
 * 正本 `docs/specs/special_demo_integration_spec_20261022.md` §4.4（＋裁定 4）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【守るもの】**デモを表示している間は本番のデータへ 1 行も書かない**
 * ══════════════════════════════════════════════════════════════════════
 *
 * `viewer.writeTargetUid` を使う書き込みは **7 本**ある。PR-A / PR-C で塞いだのは
 * `kit/[id]/external-id` と `kit/[id]/self-report` の 2 本だけで、残りはデモを
 * 表示している最中でも本番へ届いていた。
 *
 * **ここは静かに壊れる**:
 *   - デモの画面は `shouldUseDemoData()` が**ダミーを出す**ので、書いた行は
 *     **本人にも見えない** = 誰にも見えない本物の行だけが増える
 *   - 逆にゲートを広げすぎると**一般顧客が保存できなくなる**のに、
 *     デモで試している人には何も起きない（気づくのは利用者の側）
 *   - `isDemoAccount()` は app_config を読むので、**`refreshConfig()` の前に
 *     モードを作ると冷えた isolate でだけゲートが開く**（fail-open）
 *
 * どれも目視では守れないので、**実物を動かして書き込みの回数を数える**。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
/** コメント行を落とす（経緯の説明に旧コードの名前や逆の記述が在るため）。 */
const code = (p) => read(p).split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');

const fails = [];
let pass = 0;
const ts = (await import('typescript')).default;
const js = (src) => ts.transpileModule(src, {
  compilerOptions: { target: 'ES2022', module: 'ESNext', esModuleInterop: true },
}).outputText;
/**
 * 実物を `data:` URL として読み込む。
 *
 * **差し替え漏れを名指しで落とす。** `data:` URL からは相対 import を解決できない
 * ので、1 本でも残っていると Node が `ERR_UNSUPPORTED_RESOLVE_REQUEST` で
 * **スクリプトごと落ち**、どの検査が落ちたのか分からなくなる（退行注入で実際に
 * そうなった = 「資格の関数を直に呼ぶ形に戻す」が名指しにならなかった）。
 * **残っていたら、その事実を検査の失敗として出してから止める。**
 */
const load = async (relPath, subs = []) => {
  let src = read(relPath);
  for (const [re, to] of subs) src = src.replace(re, to ?? '');
  const out = js(src);
  const leftover = [...out.matchAll(/from ["'](\.[^"']*)["']/g)].map((m) => m[1]);
  if (leftover.length) {
    ok(`${relPath} の相対 import は全て差し替え済み`, false,
      `差し替えていない import が残っている (${leftover.join(', ')}) — `
      + '実物を動かせない。資格の関数を直に引く形に戻っていないか確かめる');
    summary();
  }
  const b64 = Buffer.from(out, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${b64}`);
};

const ok = (label, cond, why) => {
  if (cond) pass++; else fails.push(`${label}${why ? ` — ${why}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
/** 集計して終わる。**途中で呼ばれても必ず名指しを出す。** */
function summary() {
  console.log(`\n${fails.length === 0 ? '✅' : '❌'} verify:write-audit — ${pass} / ${pass + fails.length}`);
  if (fails.length) {
    console.log('\n落ちた検査:');
    for (const f of fails) console.log(`  - ${f}`);
    process.exit(1);
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 分類（§4.4）
 * ════════════════════════════════════════════════════════════════════ */
/**
 * **A = Demo-safe no-op** … デモの作り物に対する操作。どこにも書かず
 *   `demo: true` を返し、**画面が「記録されません」と出す**。
 *   そのまま下へ流すと `Order not found` / `notice not found` になり、
 *   **押すとエラーになるボタン**が記者やパートナーの前に残る。
 * **B = Demo では止める** … 本番のデータ・納品物を作る口。**403 で止める**。
 *   裁定 4「AI問診・AIスキャンは今回 Demo 書込み対応しない」
 *   「**擬似成功を足さない**」なので `ok: true` を返さない。
 */
const CLASS_A = {
  'src/pages/api/kit/[id]/external-id.ts': 'isDemoShipmentId(shipmentRef)',
  'src/pages/api/kit/[id]/self-report.ts': 'isDemoShipmentId(id)',
  'src/pages/api/notices/[id]/read.ts': 'isDemoNoticeId(id)',
};
const CLASS_B = [
  'src/pages/api/scan/save.ts',
  'src/pages/api/scan/jobs.ts',
  'src/pages/api/scan/export.ts',
  'src/pages/api/interview/export.ts',
];

// ══════════════════════════════════════════════════════════════════════
// ① 棚卸し — 書き込みの口を 1 本も見落としていないこと
// ══════════════════════════════════════════════════════════════════════
console.log('\n① 棚卸し (writeTargetUid を使う口が全部分類されている)\n');
{
  /*
   * **列挙を固定する。** 新しい書き込みの口が増えたとき、分類に入れ忘れると
   * **その口だけデモから本番へ書ける**。増えたら必ずここで落ちる
   * （落ちたら「分類を決めて CLASS_A / CLASS_B に足す」のが直し方）。
   */
  const walk = (dir) => readdirSync(resolve(ROOT, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name))
      : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
  const found = walk('src/pages/api')
    .filter((f) => /writeTargetUid/.test(read(f)))
    .sort();
  const want = [...Object.keys(CLASS_A), ...CLASS_B].sort();
  eq('`writeTargetUid` を使う API は 7 本', found.length, 7);
  eq('分類と実際の口が一致している', found, want);
}

// ══════════════════════════════════════════════════════════════════════
// ② 番人そのもの (`denyDemoWrite`) — 実物を動かす
// ══════════════════════════════════════════════════════════════════════
console.log('\n② denyDemoWrite (実物を動かす)\n');
{
  /*
   * **静的な検査を先に置く。** `load()` は差し替え漏れを名指しで落として止めるので、
   * 「資格の関数を直に引く形に戻った」ときに**その理由も一緒に出る**ようにする。
   */
  const wg = read('src/lib/write-guard.ts');
  eq('`denyDemoWrite` の定義は 1 つ', (wg.match(/export function denyDemoWrite/g) || []).length, 1);
  eq('文言は 1 か所', (wg.match(/デモ表示中は本番のデータに保存しません/g) || []).length, 1);
  ok('判定は `shouldUseDemoData` を通している (資格を直に引かない)',
    /shouldUseDemoData\(/.test(code('src/lib/write-guard.ts'))
    && !/isDemoAccount\s*\(|demoDisabledGlobally\s*\(/.test(code('src/lib/write-guard.ts')));

  /**
   * 実物の `write-guard.ts` ＋ 実物の `view-mode.ts` を通す（資格 2 関数だけスタブ）。
   *
   * **判定を差し替えない。** ここを stub にすると「呼んでいるか」しか見られず、
   * 「誰を止めるか」が退行しても気づけない。
   */
  const guard = async (caps) => {
    globalThis.__capsOff = !!caps.globalOff;
    globalThis.__capsDemo = caps.demo ?? [];
    globalThis.__capsSpecial = caps.special ?? [];
    const vm = await load('src/lib/view-mode.ts', [
      [/^import type \{ APIContext \} from 'astro';$/m, ''],
      [/^import type \{ Viewer \} from '[^']+';$/m, ''],
      [/^import \{ demoDisabledGlobally, isDemoAccount \} from '[^']+';$/m,
        'const demoDisabledGlobally = () => globalThis.__capsOff;\n'
        + 'const isDemoAccount = (u) => globalThis.__capsDemo.includes(u);'],
      [/^import \{ isSpecialAccount \} from '[^']+';$/m,
        'const isSpecialAccount = (u) => globalThis.__capsSpecial.includes(u);'],
      [/import\.meta\.env/g, 'globalThis.__env'],
    ]);
    globalThis.__sud = vm.shouldUseDemoData;
    return load('src/lib/write-guard.ts', [
      [/^import type \{ Viewer \} from '[^']+';$/m, ''],
      [/^import \{ shouldUseDemoData, type ViewMode \} from '[^']+';$/m,
        'const shouldUseDemoData = (u, m) => globalThis.__sud(u, m);'],
    ]);
  };
  globalThis.__env = { DEV: false };

  const DEMO_UID = 'dddddddd-1111-1111-1111-111111111111';
  const REAL_UID = 'aaaaaaaa-1111-1111-1111-111111111111';

  {
    const g = await guard({ demo: [DEMO_UID] });
    const v = (uid) => ({ uid, writeTargetUid: uid });

    const blocked = g.denyDemoWrite(v(DEMO_UID), 'demo');
    ok('デモ用アカウント × Demo 表示 → 止める', blocked !== null);
    eq('  403 で返る', blocked?.status, 403);
    const b = JSON.parse(await blocked.text());
    eq('  `ok` を立てない (擬似成功を足さない)', b.ok, false);
    eq('  理由の符号', b.error, 'demo_mode_write_blocked');
    ok('  日本語の理由が付く (符号だけを画面に出さない)',
      typeof b.message === 'string' && /デモ表示中/.test(b.message), b.message);
    ok('  `cache-control: no-store`', /no-store/.test(blocked.headers.get('cache-control') ?? ''));

    eq('デモ用アカウント × Real 表示 → 通す (Dual が実データを保存できる)',
      g.denyDemoWrite(v(DEMO_UID), 'real'), null);
    /*
     * **ここが最重要。** ゲートが広がると一般顧客が保存できなくなる。
     * しかも**壊れたことに気づくのは利用者**なので、必ず機械で見る。
     */
    eq('**一般顧客 × Demo 表示 → 通す** (資格が無い人は止めない)',
      g.denyDemoWrite(v(REAL_UID), 'demo'), null);
    eq('一般顧客 × Real 表示 → 通す', g.denyDemoWrite(v(REAL_UID), 'real'), null);
    eq('uid が無い → 通す (401 は呼び出し側の仕事)',
      g.denyDemoWrite({ uid: null, writeTargetUid: null }, 'demo'), null);

    /*
     * **2 つとも見る。** 現行の `kind` では必ず一致するが、片方だけを見ると
     * 将来 kind を足したときに静かに抜ける（`isReadOnlyViewer` と同じ規律）。
     */
    ok('表示中の uid だけがデモでも止める',
      g.denyDemoWrite({ uid: DEMO_UID, writeTargetUid: REAL_UID }, 'demo') !== null);
    ok('書き込み先の uid だけがデモでも止める',
      g.denyDemoWrite({ uid: REAL_UID, writeTargetUid: DEMO_UID }, 'demo') !== null);
  }
  {
    // 全停止スイッチが入っていればダミーも出ないので、書き込みも止めない（整合）。
    const g = await guard({ demo: [DEMO_UID], globalOff: true });
    eq('`PUBLIC_DEMO_FALLBACK=false` のときは止めない (ダミーも出ないので)',
      g.denyDemoWrite({ uid: DEMO_UID, writeTargetUid: DEMO_UID }, 'demo'), null);
  }

}

// ══════════════════════════════════════════════════════════════════════
// ③ 分類 B の 4 本 — 止めているか / 位置が正しいか
// ══════════════════════════════════════════════════════════════════════
console.log('\n③ 分類 B (Demo では 403)\n');
{
  /** その口が「最初に外へ効く操作」をする位置。ここより前でなければならない。 */
  const FIRST_EFFECT = {
    'src/pages/api/scan/save.ts': ['logShareApiEvent(', 'saveScanResult('],
    'src/pages/api/scan/jobs.ts': ['logShareApiEvent(', 'enqueueScanJob('],
    'src/pages/api/scan/export.ts': ['putScanExport('],
    'src/pages/api/interview/export.ts': ['recordInterviewCompletion(', 'putFiles('],
  };
  for (const f of CLASS_B) {
    const src = code(f);
    const name = f.split('/').slice(-2).join('/');
    const iGate = src.indexOf('denyDemoWrite(');
    ok(`${name} が \`denyDemoWrite\` を通している`, iGate > 0);
    /*
     * **呼び出しと return を別々に見て、距離で結ぶ。** 1 本の正規表現で
     * `denyDemoWrite\([^)]*\)` と書くと、引数の中の `)`
     * （`viewModeFromRequest(ctx, viewer).effectiveMode`）で切れて**常に落ちる**
     * （実際に一度そうなった）。
     */
    const iCall = src.indexOf('const demoBlocked = denyDemoWrite(');
    const iRet = src.indexOf('if (demoBlocked) return demoBlocked;');
    ok(`  ${name} はゲートの戻りで return している`,
      iCall > 0 && iRet > iCall && iRet - iCall < 200,
      '戻りを捨てると「呼んでいるのに止まらない」形になる');
    for (const needle of FIRST_EFFECT[f]) {
      const i = src.indexOf(needle);
      ok(`  ${name} のゲートは \`${needle}\` より前`, iGate > 0 && i > 0 && iGate < i, `gate=${iGate} ${needle}=${i}`);
    }
    /*
     * **モードを作る前に app_config を読む。** 逆だと冷えた isolate で
     * `demo.account_uids` が未取得のまま判定し、**資格が無いと見えてゲートが開く**。
     * 組み込みの 4 件は config 無しでも当たるので、**app_config で登録した
     * デモ用アカウントだけが黙って本番へ書く**という見つけにくい形になる。
     */
    const iCfg = src.indexOf('refreshConfig(');
    const iMode = src.indexOf('viewModeFromRequest(');
    ok(`  ${name} は \`refreshConfig()\` → モード の順`,
      iCfg > 0 && iMode > 0 && iCfg < iMode, `cfg=${iCfg} mode=${iMode}`);
    ok(`  ${name} はモードをリクエストから決めている (資格で代用しない)`,
      /viewModeFromRequest\(ctx, viewer\)/.test(src));
    ok(`  ${name} が資格の関数を直に呼んでいない`,
      !/\bisDemoAccount\s*\(|\bdemoDisabledGlobally\s*\(/.test(src),
      'ダミーの可否は shouldUseDemoData(uid, mode) を通す');
  }
}

// ══════════════════════════════════════════════════════════════════════
// ④ 分類 A の 3 本 — 2 条件・位置・擬似成功にしない
// ══════════════════════════════════════════════════════════════════════
console.log('\n④ 分類 A (Demo-safe no-op)\n');
{
  const FIRST_EFFECT = {
    'src/pages/api/kit/[id]/external-id.ts': ['getServerSupabase()', 'persistExternalIdCapture('],
    'src/pages/api/kit/[id]/self-report.ts': ['submitKitSelfReport(', 'getServerSupabase()'],
    'src/pages/api/notices/[id]/read.ts': ['getServerSupabase('],
  };
  for (const [f, idCheck] of Object.entries(CLASS_A)) {
    const src = code(f);
    const name = f.split('/').slice(-2).join('/');
    const iDemo = src.indexOf(idCheck);
    ok(`${name} にデモ分岐が在る`, iDemo > 0);
    /*
     * **条件は 2 つとも見る。** 片方だけだと
     *   - モードだけ → デモ用アカウントが**本物の操作**をできなくなる
     *   - ID だけ   → 本物の利用者がデモの ID を送れば**偽の成功**を受け取れる
     */
    ok(`  ${name} は「モード」と「デモの ID」の 2 つとも見る`,
      src.includes(`viewMode.effectiveMode === 'demo' && ${idCheck}`), idCheck);
    for (const needle of FIRST_EFFECT[f]) {
      const i = src.indexOf(needle);
      ok(`  ${name} のデモ分岐は \`${needle}\` より前`, iDemo > 0 && i > 0 && iDemo < i, `demo=${iDemo} ${needle}=${i}`);
    }
    const iCfg = src.indexOf('refreshConfig(');
    const iMode = src.indexOf('viewModeFromRequest(');
    ok(`  ${name} は \`refreshConfig()\` → モード の順`,
      iCfg > 0 && iMode > 0 && iCfg < iMode, `cfg=${iCfg} mode=${iMode}`);
    ok(`  ${name} はデモだと分かる印を返す (黙って成功を装わない)`, /demo: true/.test(src));
  }
}

// ══════════════════════════════════════════════════════════════════════
// ⑤ 実走: お知らせの既読 — デモでは DB を 1 度も呼ばない
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑤ 実走 (notices/[id]/read)\n');
{
  let sbCalls = 0;
  const DEMO_IDS = (() => {
    const arr = /export const DEMO_NOTICE_IDS: readonly string\[\] = \[([\s\S]*?)\];/
      .exec(read('src/lib/demo-data.ts'))?.[1] ?? '';
    return [...arr.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  })();
  const REAL_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const UID = '11111111-1111-1111-1111-111111111111';
  globalThis.__sbCount = () => { sbCalls++; };
  Object.defineProperty(globalThis, '__noticeDemo', { get: () => globalThis.__nd, configurable: true });

  const route = await load('src/pages/api/notices/[id]/read.ts', [
    [/^import type \{ APIRoute \} from 'astro';$/m, ''],
    [/^import \{ resolveViewer \} from '[^']+';$/m,
      "const resolveViewer = async () => ({ kind: 'self', uid: globalThis.__uid, writeTargetUid: globalThis.__uid });"],
    [/^import \{ denyReadOnlyWrite, denyForShare, denyAnonymous \} from '[^']+';$/m,
      'const denyReadOnlyWrite = () => null;\nconst denyForShare = () => null;\nconst denyAnonymous = () => null;'],
    [/^import \{ getServerSupabase \} from '[^']+';$/m,
      'const getServerSupabase = () => { globalThis.__sbCount(); return null; };'],
    [/^import \{ isDemoNoticeId \} from '[^']+';$/m,
      'const isDemoNoticeId = (id) => globalThis.__demoNoticeIds.includes(id);'],
    [/^import \{ viewModeFromRequest \} from '[^']+';$/m,
      "const viewModeFromRequest = () => ({ effectiveMode: globalThis.__nd ? 'demo' : 'real' });"],
    [/^import \{ refreshConfig \} from '[^']+';$/m, 'const refreshConfig = async () => {};'],
  ]);
  globalThis.__demoNoticeIds = DEMO_IDS;
  globalThis.__uid = UID;

  const post = async (id, body = { read: true }) => {
    const res = await route.POST({
      params: { id },
      request: new Request('https://x/api', { method: 'POST', body: JSON.stringify(body) }),
      cookies: { get: () => undefined },
    });
    return { status: res.status, body: await res.json() };
  };

  globalThis.__nd = true;
  sbCalls = 0;
  {
    const rs = [];
    for (let i = 0; i < 5; i++) rs.push(await post(DEMO_IDS[0]));
    eq('**デモで 5 回押しても DB を 1 度も呼ばない**', sbCalls, 0);
    ok('5 回とも 200 で返る (押してエラーにならない)', rs.every((r) => r.status === 200 && r.body.ok === true));
    ok('5 回とも `demo: true`', rs.every((r) => r.body.demo === true));
    eq('未読に戻す側も同じ', (await post(DEMO_IDS[0], { read: false })).body.read, false);
  }
  // デモ資格 × **本物のお知らせ** → no-op にしない
  sbCalls = 0;
  {
    const r = await post(REAL_ID);
    ok('**デモ資格 × 本物のお知らせは no-op にしない**', sbCalls === 1 && r.body.demo !== true,
      `sb=${sbCalls} demo=${r.body.demo}`);
  }
  // 本物の利用者 × **デモのお知らせ** → デモ扱いにしない (偽の成功を渡さない)
  globalThis.__nd = false;
  sbCalls = 0;
  {
    const r = await post(DEMO_IDS[0]);
    ok('**本物の利用者 × デモのお知らせはデモ扱いにしない**', sbCalls === 1 && r.body.demo !== true,
      `sb=${sbCalls} demo=${r.body.demo}`);
  }
}

// ══════════════════════════════════════════════════════════════════════
// ⑥ 実走: スキャンの保存 — デモでは 1 行も書かない / 一般顧客は従来どおり
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑥ 実走 (scan/save)\n');
{
  let saveCalls = 0;
  let logCalls = 0;
  const DEMO_UID = 'dddddddd-2222-2222-2222-222222222222';
  const REAL_UID = 'aaaaaaaa-2222-2222-2222-222222222222';
  globalThis.__saveCount = () => { saveCalls++; };
  globalThis.__logCount = () => { logCalls++; };

  /*
   * **番人は実物を使う** (`write-guard.ts` → `view-mode.ts` → 資格 2 関数だけスタブ)。
   * ここを差し替えると「呼んでいるか」しか見られない。
   */
  const vm = await load('src/lib/view-mode.ts', [
    [/^import type \{ APIContext \} from 'astro';$/m, ''],
    [/^import type \{ Viewer \} from '[^']+';$/m, ''],
    [/^import \{ demoDisabledGlobally, isDemoAccount \} from '[^']+';$/m,
      'const demoDisabledGlobally = () => false;\n'
      + 'const isDemoAccount = (u) => u === globalThis.__demoUid;'],
    [/^import \{ isSpecialAccount \} from '[^']+';$/m, 'const isSpecialAccount = () => false;'],
    [/import\.meta\.env/g, 'globalThis.__env'],
  ]);
  globalThis.__demoUid = DEMO_UID;
  globalThis.__sud2 = vm.shouldUseDemoData;
  const guard = await load('src/lib/write-guard.ts', [
    [/^import type \{ Viewer \} from '[^']+';$/m, ''],
    [/^import \{ shouldUseDemoData, type ViewMode \} from '[^']+';$/m,
      'const shouldUseDemoData = globalThis.__sud2;'],
  ]);
  globalThis.__guard = guard;

  const route = await load('src/pages/api/scan/save.ts', [
    [/^import type \{ APIRoute \} from 'astro';$/m, ''],
    [/^import \{ resolveViewer \} from '[^']+';$/m,
      "const resolveViewer = async () => ({ kind: 'self', uid: globalThis.__uid2, writeTargetUid: globalThis.__uid2 });"],
    [/^import \{ denyReadOnlyWrite, denyUnlessShareScope, denyDemoWrite \} from '[^']+';$/m,
      'const denyReadOnlyWrite = () => null;\nconst denyUnlessShareScope = () => null;\n'
      + 'const denyDemoWrite = globalThis.__guard.denyDemoWrite;'],
    [/^import \{ logShareApiEvent \} from '[^']+';$/m,
      'const logShareApiEvent = async () => { globalThis.__logCount(); };'],
    [/^import \{ getServerSupabase \} from '[^']+';$/m, 'const getServerSupabase = () => ({ __stub: true });'],
    [/^import \{ saveScanResult \} from '[^']+';$/m,
      'const saveScanResult = async () => { globalThis.__saveCount(); '
      + "return { artifactId: 'x', testDate: '2026-01-01', dateSource: 'printed', measurements: [] }; };"],
    [/^import \{ isSpecialAccount \} from '[^']+';$/m, 'const isSpecialAccount = () => false;'],
    [/^import \{ refreshConfig \} from '[^']+';$/m, 'const refreshConfig = async () => {};'],
    [/^import \{ viewModeFromRequest \} from '[^']+';$/m,
      "const viewModeFromRequest = (c, v) => ({ effectiveMode: globalThis.__mode2 });"],
  ]);

  const post = async () => {
    const res = await route.POST({
      request: new Request('https://x/api', {
        method: 'POST', body: JSON.stringify({ markdownClean: '| a | b |' }),
      }),
      cookies: { get: () => undefined },
    });
    return { status: res.status, body: await res.json() };
  };

  globalThis.__uid2 = DEMO_UID; globalThis.__mode2 = 'demo';
  saveCalls = 0; logCalls = 0;
  {
    const r = await post();
    eq('**デモ表示では `saveScanResult` を 1 度も呼ばない**', saveCalls, 0);
    eq('  403 で返る', r.status, 403);
    eq('  `ok: true` を返さない (擬似成功を足さない)', r.body.ok, false);
    eq('  理由の符号', r.body.error, 'demo_mode_write_blocked');
    ok('  日本語の理由が付く', /デモ表示中/.test(r.body.message ?? ''), r.body.message);
    /*
     * **止めた回を「AI スキャンを利用した」として記録しない**（§26.1）。
     * ゲートがログより後ろへ動くと、使っていない利用が共有の台帳に残る。
     */
    eq('  共有の利用ログも残さない', logCalls, 0);
  }
  globalThis.__uid2 = DEMO_UID; globalThis.__mode2 = 'real';
  saveCalls = 0;
  {
    const r = await post();
    ok('デモ資格でも Real 表示なら保存する (Dual が実データを保存できる)',
      saveCalls === 1 && r.status === 200, `save=${saveCalls} status=${r.status}`);
  }
  globalThis.__uid2 = REAL_UID; globalThis.__mode2 = 'demo';
  saveCalls = 0;
  {
    const r = await post();
    ok('**一般顧客は Demo 表示でも保存できる** (ゲートを広げていない)',
      saveCalls === 1 && r.status === 200, `save=${saveCalls} status=${r.status}`);
  }
  globalThis.__uid2 = REAL_UID; globalThis.__mode2 = 'real';
  saveCalls = 0;
  {
    const r = await post();
    ok('一般顧客 × Real 表示は従来どおり', saveCalls === 1 && r.status === 200);
  }
}

// ══════════════════════════════════════════════════════════════════════
// ⑦ デモの ID は API の形の検査を通る (押した瞬間に 400 にならない)
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑦ デモの ID の形\n');
{
  const UUIDISH = /^[0-9a-f-]{36}$/i;
  const ids = (name) => {
    const arr = new RegExp(`export const ${name}: readonly string\\[\\] = \\[([\\s\\S]*?)\\];`)
      .exec(read('src/lib/demo-data.ts'))?.[1] ?? '';
    return [...arr.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };
  const notices = ids('DEMO_NOTICE_IDS');
  const shipments = ids('DEMO_SHIPMENT_IDS');
  ok('`DEMO_NOTICE_IDS` が 2 件ある', notices.length === 2, String(notices.length));
  ok('**お知らせの ID が UUID の形** (既読 API の形の検査を通る)',
    notices.every((i) => UUIDISH.test(i)), notices.join(','));
  ok('出荷の ID も UUID の形 (従来どおり)', shipments.length === 6 && shipments.every((i) => UUIDISH.test(i)));
  ok('お知らせと出荷の ID が重なっていない',
    notices.every((i) => !shipments.includes(i)));
  /*
   * **並びが食い違うと API がデモと見分けられない行ができる**ので、
   * 作り物の側も定義から引いていること。
   */
  const dd = code('src/lib/demo-data.ts');
  ok('`buildDemoNotices` は ID を定義から引いている',
    /id: DEMO_NOTICE_IDS\[0\]/.test(dd) && /id: DEMO_NOTICE_IDS\[1\]/.test(dd)
    && !/id: 'demo-un-/.test(dd), 'ベタ書きに戻すと定義と食い違う');
  ok('形の検査そのものは緩めていない (既読 API)',
    /\/\^\[0-9a-f-\]\{36\}\$\/i\.test\(id\)/.test(code('src/pages/api/notices/[id]/read.ts')));
}

// ══════════════════════════════════════════════════════════════════════
// ⑧ 画面側 — 符号だけを出さない / デモで再読込しない
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑧ 画面側\n');
{
  const notices = read('src/pages/notices.astro');
  const iDemo = notices.indexOf('payload.demo');
  const iReload = notices.indexOf('window.location.reload()');
  ok('`notices.astro` が `payload.demo` を見ている', iDemo > 0);
  ok('**デモの応答では再読込しない** (読み直しても未読のままで、押しても変わらないように見える)',
    iDemo > 0 && iReload > 0 && iDemo < iReload, `demo=${iDemo} reload=${iReload}`);
  ok('デモだと画面に出る (黙って成功を装わない)',
    /デモ表示では記録されません/.test(notices));
  ok('サーバの日本語の理由を優先する (お知らせ)',
    /payload\.message \|\| payload\.error/.test(notices));

  const scan = read('src/pages/scan.astro');
  eq('`scan.astro` がサーバの `message` を出す箇所は 2 つ (保存 / 書き出し)',
    (scan.match(/data\.message \?\?/g) || []).length, 2);
  ok('保存の失敗で `message` を優先している',
    /data\.message \?\? `検査結果の保存に失敗しました/.test(scan));
}

// ══════════════════════════════════════════════════════════════════════
// ⑨ 増やさないもの (裁定 2)
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑨ 増やさないもの\n');
{
  const migDir = resolve(ROOT, 'supabase/migrations');
  const migs = existsSync(migDir) ? readdirSync(migDir).filter((f) => /^2026102[2-9]/.test(f)) : [];
  eq('PR-D で migration を足していない', migs, []);
  const specs = read('src/lib/app-config.ts');
  ok('Demo 専用の capture flag を作っていない',
    !/prevent_capture_demo|demo_capture|capture_demo/.test(specs));
  ok('app_config のキーを足していない (書込み監査は設定を増やさない)',
    !/write_audit|demo_write/.test(specs));
  /*
   * **「デモなら成功したことにする」を分類 B へ持ち込まない**（裁定 4）。
   * 擬似成功を足すと、画面は完了に見えるのに本番には何も無い状態が生まれる。
   */
  for (const f of CLASS_B) {
    const src = code(f);
    const i = src.indexOf('denyDemoWrite(');
    const after = i > 0 ? src.slice(i, i + 400) : '';
    ok(`  ${f.split('/').slice(-2).join('/')} が擬似成功を返していない`,
      !/demo: true/.test(after), after.slice(0, 120));
  }
}

summary();
