#!/usr/bin/env node
/**
 * `npm run verify:url-uid-privacy` — **一般ユーザーの URL に diagnostic_user_id を
 * 出さない**ことと、**`/result/[id]` の所有者検証**の回帰チェック。
 *
 * 正本: `docs/specs/url_uid_privacy_spec_20260929.md` §19 (T-01〜T-20)。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【ここは静かに壊れる】
 * ══════════════════════════════════════════════════════════════════════
 *
 *   - リンクが 1 か所だけ `?u=` を残しても**画面は正常に見える**。
 *     気づくのはアドレスバーを凝視したときだけ。
 *   - 所有者検証が外れても**自分の結果は今までどおり開く**ので、
 *     他人の artifact_id を実際に入れてみるまで分からない。
 *
 * だから目視では守れない。**実物を transpile して動かす** (`viewerLinkQuery` /
 * `loadResult`) ＋ **ソースを機械で読む** (リンク生成の直書きが無いこと)。
 *
 * DB も dev サーバも要らない — Supabase は条件を記録するスタブに差し替える。
 */

import { readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
/** コメント行を落とす (経緯の説明に旧コードが書いてあるので、そこを拾わない)。 */
const code = (p) => read(p).split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');

const ts = (await import('typescript')).default;
mkdirSync(resolve(ROOT, 'node_modules/.cache'), { recursive: true });
const js = (src) => ts.transpileModule(src, { compilerOptions: { target: 'ES2022', module: 'ESNext' } }).outputText;
const load = async (src) => import('data:text/javascript;base64,' + Buffer.from(js(src), 'utf8').toString('base64'));

const fails = [];
const ok = (id, label, cond, why) => {
  if (!cond) fails.push(`${id} ${label}${why ? ` — ${why}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${id} ${label}${why && !cond ? `  → ${why}` : ''}`);
};
const eq = (id, label, got, want) =>
  ok(id, label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);

const UID_SELF = '11111111-1111-4111-8111-111111111111';
const UID_OTHER = '22222222-2222-4222-8222-222222222222';

// ── ① viewerLinkQuery の実挙動 (T-19) ────────────────────────────
console.log('\n① viewerLinkQuery (T-19)');
const viewerSrc = read('src/lib/viewer.ts');
const viewerMod = await load(viewerSrc);
const { viewerLinkQuery } = viewerMod;
const V = (o) => ({ uid: null, impersonating: false, uidEntry: false, ...o });

eq('T-19a', '一般ユーザー本人 → ""', viewerLinkQuery(V({ uid: UID_SELF })), '');
eq('T-19b', '未サインイン → ""', viewerLinkQuery(V({ uid: null })), '');
eq('T-19c', 'admin 代理表示 → ?u=<対象>', viewerLinkQuery(V({ uid: UID_OTHER, impersonating: true })), `?u=${UID_OTHER}`);
eq('T-19d', '緊急 ?u= 入場 → ?u=<uid>', viewerLinkQuery(V({ uid: UID_SELF, uidEntry: true })), `?u=${UID_SELF}`);
eq('T-19e', 'admin 本人の画面 (impersonating=false) → ""', viewerLinkQuery(V({ uid: UID_SELF })), '');
ok('T-19f', '戻り値は "?" から始まる (呼び出し側で ? を付け直さない)',
  viewerLinkQuery(V({ uid: UID_SELF, impersonating: true })).startsWith('?'));

// ── ② uidEntry の設定と用途 (T-08 / T-20) ────────────────────────
console.log('\n② Viewer.uidEntry (T-08 / T-20)');
{
  const c = code('src/lib/viewer.ts');
  const returns = [...c.matchAll(/return \{[^}]*uidEntry:\s*(true|false)[^}]*\}/g)].map((m) => m[1]);
  const anon = /const ANONYMOUS: Viewer = \{[^}]*uidEntry: false/.test(c);
  ok('T-08a', 'ANONYMOUS に uidEntry: false がある', anon);
  /*
   * **4 件**。2026-09-30 に **Admin 代理表示 (`/admin-view/<ctx>/…`)** の return が 1 件増えた
   * (`docs/specs/secure_shared_access_and_admin_impersonation_spec_20260930.md` §13.0 案 B)。
   * 数を固定しているのは「**どれか 1 つの return だけ uidEntry を落とす**」退行を止めるため
   * なので、経路が増えたら数も更新する (緩めない)。
   */
  ok('T-08b', 'resolveViewer の全 return が uidEntry を持つ (4 件)', returns.length === 4, `${returns.length} 件`);
  eq('T-08c', 'true は緊急入場の 1 件だけ', returns.filter((x) => x === 'true').length, 1);
  // 緊急入場の return は uidEntryAllowed() のブロック内にあること
  const emerg = c.slice(c.indexOf('uidEntryAllowed() && requested'), c.indexOf('return ANONYMOUS'));
  ok('T-08d', 'uidEntry: true は uidEntryAllowed() の中だけ', /uidEntry: true/.test(emerg));

  // T-20: 認証・admin・デモ・スペシャル判定に使っていない
  const usesOutside = [];
  for (const f of ['src/lib/viewer.ts', 'src/lib/demo-accounts.ts', 'src/lib/special-accounts.ts',
                   'src/lib/demo-data.ts', 'src/lib/admin-auth.ts']) {
    const body = code(f);
    for (const ln of body.split('\n')) {
      // `uidEntryAllowed` は **別物** (ALLOW_UID_ENTRY の env 判定)。混同しない。
      if (!/\buidEntry\b(?!Allowed)/.test(ln)) continue;
      // 許すのは 型定義 / return での設定 / viewerLinkQuery の本体と型引数だけ
      if (/uidEntry:\s*(true|false)/.test(ln) || /uidEntry: boolean/.test(ln)
          || /v\.uidEntry/.test(ln) || /Pick<Viewer,[^>]*'uidEntry'/.test(ln)) continue;
      usesOutside.push(`${f}: ${ln.trim()}`);
    }
  }
  ok('T-20', 'uidEntry が認証・admin・デモ・スペシャル判定に使われていない',
    usesOutside.length === 0, usesOutside.join(' / '));

  // 既存の入場判定を緩めていないこと
  ok('T-07', '代理表示は isAdmin かつ requested !== selfUid のときだけ',
    /if \(isAdmin && requested && requested !== selfUid\)/.test(c));
}

// ── ③ リンク生成の直書きが無いこと (T-10 / T-11) ─────────────────
console.log('\n③ リンク生成の直書き (T-10 / T-11)');
function walk(dir, out = []) {
  for (const n of readdirSync(resolve(ROOT, dir))) {
    const p = join(dir, n);
    if (statSync(resolve(ROOT, p)).isDirectory()) walk(p, out);
    else if (/\.(astro|ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}
const FILES = [...walk('src/pages'), ...walk('src/components'), ...walk('src/scripts')]
  .filter((p) => !p.includes('/admin/'));               // admin 画面は対象外 (spec §6-3)
/** 参照が復活したときだけ問題になる死んだ経路 (spec §6-9)。**見張るが落とさない**。 */
const DORMANT = [
  'src/components/dashboard/TestHistoryList.astro',
  'src/components/dashboard/HealthCoachPreview.astro',
  'src/components/dashboard/HealthInsightCard.astro',
];
/** デモ用アカウントを切り替える admin 向けの固定リンク (自分の uid ではない)。 */
const DEMO_CHIPS = /\/dashboard\?u=(?:d0|da)[0-9a-f]{6}-0000-0000-0000-000000000000/;

const offenders = [];
const dormantHits = [];
for (const f of FILES) {
  const body = code(f);
  body.split('\n').forEach((ln, i) => {
    const hit =
      /\?u=\$\{/.test(ln) ||                            // `?u=${...}`
      /searchParams\.set\(\s*['"]u['"]/.test(ln) ||     // searchParams.set('u', …)
      /qs\.set\(\s*['"]u['"]/.test(ln) ||
      /p\.set\(\s*['"]u['"]/.test(ln) ||
      DEMO_CHIPS.test(ln);
    if (!hit) return;
    (DORMANT.includes(f) || DEMO_CHIPS.test(ln) ? dormantHits : offenders).push(`${f}:${i + 1} ${ln.trim()}`);
  });
}
ok('T-10', 'ユーザー向けページ/コンポーネントに uid からのリンク生成が無い',
  offenders.length === 0, offenders.join(' / '));
if (dormantHits.length) {
  console.log(`    (参考) 未参照・admin 固定リンクの残り ${dormantHits.length} 件: spec §6-9 / §12`);
}

{
  const readers = FILES.filter((f) => /searchParams\.get\(\s*['"]u['"]\s*\)/.test(code(f)));
  ok('T-11', "searchParams.get('u') は viewer.ts と admin 以外に無い",
    readers.length === 0, readers.join(' / '));
  ok('T-11b', "viewer.ts は searchParams.get('u') を持つ",
    /searchParams\.get\('u'\)/.test(code('src/lib/viewer.ts')));
}

// ── ④ サインイン直後のリダイレクト (T-04) ────────────────────────
console.log('\n④ サインイン直後のリダイレクト (T-04)');
{
  const c = code('src/components/GoogleOneTap.astro');
  ok('T-04a', "searchParams.set('u', …) が無い", !/searchParams\.set\(\s*['"]u['"]/.test(c));
  ok('T-04b', 'resolve 成功後にリダイレクトする順序は維持',
    c.indexOf("fetch('/api/auth/resolve'") < c.indexOf('window.location.replace'));
  ok('T-04c', 'リダイレクト自体は残っている', /window\.location\.replace\(url\.toString\(\)\)/.test(c));
}

// ── ⑤ 各ページが viewerLinkQuery を通している (T-01〜T-03 / T-05 / T-06) ──
console.log('\n⑤ ページが viewerLinkQuery を通している (T-01〜T-06)');
const PAGES = [
  'src/pages/dashboard.astro', 'src/pages/report.astro', 'src/pages/trend.astro',
  'src/pages/kit.astro', 'src/pages/scan.astro', 'src/pages/chat.astro',
  'src/pages/coach.astro', 'src/pages/notices.astro', 'src/pages/result/[id].astro',
];
for (const p of PAGES) {
  const c = code(p);
  ok('T-01', `${p.replace('src/pages/', '')} が viewerLinkQuery を使う`, /viewerLinkQuery\(viewer\)/.test(c));
}
{
  // prop は linkQuery である (uid を渡していない)
  const bad = [];
  for (const f of FILES) {
    const body = code(f);
    if (/<(AppNav|BackToDashboard)[^>]*\su=\{/.test(body)) bad.push(f);
    if (/<(HealthAgeCard|TestResultsSection|ProgressSection)[^>]*\sq=\{/.test(body)) bad.push(f);
  }
  ok('T-05', 'コンポーネントへ uid を渡していない (prop は linkQuery)', bad.length === 0, bad.join(' / '));
  ok('T-06a', 'AppNav の prop が linkQuery', /linkQuery\?: string/.test(code('src/components/AppNav.astro')));
  ok('T-06b', 'BackToDashboard の prop が linkQuery', /linkQuery\?: string/.test(code('src/components/BackToDashboard.astro')));
  ok('T-06c', 'AppNav が uid を受けない', !/\bu\?: string \| null/.test(code('src/components/AppNav.astro')));
}

// ── ⑥ クエリ連結が二重にならない (T-09) ──────────────────────────
console.log('\n⑥ クエリ連結 (T-09)');
{
  // `q ? `${q}&` : '?'` の形が保たれていること (q='' で ?type=… になる)
  const joins = [
    // `${p}` は代理表示の path prefix (一般利用者は '')。**連結の形は変わっていない**。
    ['src/components/dashboard/HealthAgeCard.astro', /`\$\{p\}\/trend\$\{q \? `\$\{q\}&` : '\?'\}type=wellness`/],
    ['src/components/dashboard/TestResultsSection.astro', /\$\{q \? `\$\{q\}&` : '\?'\}type=/],
    ['src/pages/dashboard.astro', /\$\{q \? `\$\{q\}&` : '\?'\}trace=1/],
  ];
  for (const [f, re] of joins) ok('T-09', `${f.split('/').pop()} が ? 二重化しない連結`, re.test(read(f)));

  // 実際に組んでみる
  const build = (q, extra) => `/trend${q ? `${q}&` : '?'}${extra}`;
  eq('T-09a', 'q="" → /trend?type=wellness', build('', 'type=wellness'), '/trend?type=wellness');
  eq('T-09b', 'q="?u=x" → /trend?u=x&type=wellness', build('?u=x', 'type=wellness'), '/trend?u=x&type=wellness');

  // report.astro / result/[id].astro は URLSearchParams(linkQuery) で組む
  const mk = (linkQuery, extra) => {
    const p = new URLSearchParams(linkQuery.replace(/^\?/, ''));
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    const s = p.toString();
    return s ? `/report?${s}` : '/report';
  };
  eq('T-09c', 'report: q="" + print → /report?print=1', mk('', { print: '1' }), '/report?print=1');
  eq('T-09d', 'report: q="?u=x" + print', mk('?u=x', { print: '1' }), '/report?u=x&print=1');
}

// ── ⑦ no-store が 9 ページに付く (T-12) ──────────────────────────
console.log('\n⑦ no-store (T-12)');
for (const p of PAGES) {
  ok('T-12', `${p.replace('src/pages/', '')} が noStore(Astro.response)`, /noStore\(Astro\.response\)/.test(code(p)));
}
ok('T-12b', 'http-cache.ts は private, no-store のまま',
  /cache-control',\s*'private, no-store'/.test(read('src/lib/http-cache.ts')));
/*
 * **T-12c は 2026-09-30 に意味を変えた。**
 *
 * 旧: 「middleware を新設していない」(§28.3 の方針)。
 * 新: **Admin 代理表示 (`/admin-view/<ctx>/…`) のためだけに 1 本だけ在ってよい。**
 *     ヘッダ渡しはクライアントが偽装でき、各ページの rewrite では内側のページが
 *     ctx を知れない (§38-U20 の結論)。**代わりに「他の経路に触れないこと」を固定する** —
 *     ここが緩むと、全リクエストに素通しでない処理が乗って no-store 等の既存の約束が崩れる。
 */
if (existsRel('src/middleware.ts')) {
  const mw = code('src/middleware.ts');
  ok('T-12c', 'middleware は /admin-view 以外で即 next() する (既存経路に触れない)',
    /if \(!parsed\) return next\(\);/.test(mw) && /parseAdminViewPath/.test(mw));
  ok('T-12c2', 'middleware は Cookie を書かない・認証を作らない',
    !/cookies\.set/.test(mw) && !/signViewer/.test(mw));
}
function existsRel(p) { try { statSync(resolve(ROOT, p)); return true; } catch { return false; } }

// ── ⑧ loadResult の所有者検証を実際に動かす (T-13〜T-18) ─────────
console.log('\n⑧ /result/[id] 所有者検証 (T-13〜T-18)');
{
  /** 呼ばれた条件を記録する Supabase もどき。 */
  const calls = [];
  let rows = {};           // key: `${id}|${uid}` → artifact
  const makeSb = () => {
    const table = (name) => {
      const st = { name, filters: {} };
      const api = {
        select() { return api; },
        eq(col, val) { st.filters[col] = val; return api; },
        in() { return api; },
        order() { return api; },
        limit() { return api; },
        async maybeSingle() {
          calls.push({ table: name, filters: { ...st.filters } });
          if (name !== 'test_artifacts') return { data: null, error: null };
          /*
           * **本物の DB と同じく「付いている条件だけで絞る」。**
           * キーで引くと「条件を外す」退行を注入したときに *見つからなくなり*、
           * 本来落ちるべき T-14 (他人が見えてしまう) でなく T-13 が落ちてしまう。
           */
          const hit = Object.values(rows).find((r) =>
            Object.entries(st.filters).every(([k, v]) => r[k] === v));
          return { data: hit ?? null, error: null };
        },
        then(res) {
          calls.push({ table: name, filters: { ...st.filters } });
          // **原本を 1 件返す** — 所有者 OK のときは署名 URL が出る、を対照にするため。
          const data = name === 'test_artifact_files'
            ? [{ file_kind: 'raw_pdf', storage_url: 's3://bucket/x.pdf' }]
            : [];
          return Promise.resolve({ data, error: null }).then(res);
        },
      };
      return api;
    };
    return { schema: () => ({ from: table }), from: table };
  };

  /*
   * `loadResult` を、依存を差し替えて読み込む。
   * **data: URL の module は相対 import を解決できない**ので、相対 import は全部
   * 落として必要な記号だけ先頭に差し込む。
   */
  let src = read('src/lib/result-queries.ts');
  src = src.replace(/^import .*?;$/gms, (m) => (/from '\.\//.test(m) ? '' : m));
  src = `
const getServerSupabase = () => globalThis.__sb;
const getOriginalSignedUrl = async () => { globalThis.__signed = (globalThis.__signed ?? 0) + 1; return 'https://signed'; };
const demoFallbackEnabled = () => globalThis.__demo === true;
const demoArtifacts = () => globalThis.__demoArts ?? [];
const findSection = () => null;
const AI_PREDICTION_REPORT_LABEL = 'AI疾病予測報告書';
` + src;
  const mod = await load(src);

  const ART = '9b6bafd0-02d5-4865-92b1-377de1814913';
  globalThis.__sb = makeSb();
  globalThis.__signed = 0;
  globalThis.__demo = false;
  rows = { [`${ART}|${UID_SELF}`]: { id: ART, diagnostic_user_id: UID_SELF, test_type: 'cancer_urine', display_mode: 'single' } };

  // T-13 本人
  calls.length = 0; globalThis.__signed = 0;
  const a = await mod.loadResult(ART, UID_SELF);
  ok('T-13', '本人の artifact_id → 閲覧できる', !('error' in a), 'error' in a ? a.error : '');
  const f = calls.find((c) => c.table === 'test_artifacts')?.filters ?? {};
  ok('T-13b', '取得条件に id と diagnostic_user_id の両方がある',
    f.id === ART && f.diagnostic_user_id === UID_SELF, JSON.stringify(f));
  // **この検体では原本があるので署名 URL が出る** = T-17 の対照
  ok('T-13c', '本人のときは原本の署名 URL が発行される (T-17 の対照)', globalThis.__signed === 1, `${globalThis.__signed} 回`);

  // T-14 他人
  calls.length = 0;
  const b = await mod.loadResult(ART, UID_OTHER);
  ok('T-14', '他人の artifact_id → 閲覧できない', 'error' in b);
  const c2 = await mod.loadResult('00000000-0000-4000-8000-000000000000', UID_SELF);
  ok('T-14b', '他人所有と不存在が同じ文言', b.error === c2.error, `${b.error} / ${c2.error}`);
  eq('T-14c', '文言は「検査結果が見つかりません。」', b.error, '検査結果が見つかりません。');

  // T-15 未ログイン
  for (const [label, uid] of [['null', null], ['undefined', undefined], ['空文字', '']]) {
    const r = await mod.loadResult(ART, uid);
    ok('T-15', `未ログイン (${label}) → 閲覧できない`, 'error' in r && r.error === '検査結果が見つかりません。');
  }
  calls.length = 0;
  await mod.loadResult(ART, null);
  ok('T-15b', '未ログインでは test_artifacts を引かない', calls.length === 0, `${calls.length} 回`);

  // T-16 admin 代理表示 (viewer.uid が対象顧客になる)
  const d = await mod.loadResult(ART, UID_SELF);
  ok('T-16', 'admin 代理表示 + 対象 artifact → 閲覧できる', !('error' in d));
  ok('T-16b', 'admin 専用の例外分岐を足していない',
    !/isAdmin|impersonating/.test(code('src/lib/result-queries.ts')));

  // T-17 所有者 NG で署名 URL を発行しない
  globalThis.__signed = 0;
  await mod.loadResult(ART, UID_OTHER);
  await mod.loadResult(ART, null);
  await mod.loadResult('00000000-0000-4000-8000-000000000000', UID_SELF);
  eq('T-17', '所有確認 NG では getOriginalSignedUrl が 1 度も呼ばれない', globalThis.__signed, 0);

  // T-18 demo-art-* の既存経路
  globalThis.__demo = false;
  const e1 = await mod.loadResult('demo-art-0004', UID_SELF);
  ok('T-18a', '非デモの demo-art-* → 従来どおり見つかりません', 'error' in e1);
  globalThis.__demo = true;
  globalThis.__demoArts = [{ id: 'demo-art-0004', test_type: 'health_checkup', test_date: '2026-03-29', display_mode: 'single' }];
  calls.length = 0;
  const e2 = await mod.loadResult('demo-art-0004', UID_SELF);
  ok('T-18b', 'デモ用アカウントの demo-art-* → 開ける', !('error' in e2), 'error' in e2 ? e2.error : '');
  ok('T-18c', 'demo-art-* は DB を引かない (所有者検証より前)', calls.length === 0, `${calls.length} 回`);
}

// ── ⑧-2 デバッグ欄は admin だけ (T-21〜T-24) ────────────────────
console.log('\n⑧-2 デバッグ欄の出し分け (T-21〜T-24)');
{
  const raw = read('src/pages/dashboard.astro');
  /*
   * **CSS で隠すのでは足りない。** HTML には載ってしまうので、
   * サーバ側で描かない (`{viewer.isAdmin && (…)}`) ことを構文で確かめる。
   */
  const open = raw.indexOf('{viewer.isAdmin && (\n        <details');
  const close = raw.indexOf('</details>\n        )}');
  ok('T-21a', 'デバッグ欄が {viewer.isAdmin && ( … )} で包まれている', open >= 0 && close > open);
  const block = open >= 0 && close > open ? raw.slice(open, close) : '';
  ok('T-21b', '本人の diagnostic_user_id 表示がその中にある',
    /diagnostic_user_id:/.test(block));
  ok('T-22', '固定デモ uid の切替リンク 6 件がその中にある',
    (block.match(/\/dashboard\?u=(?:d0|da)[0-9a-f]{6}-/g) ?? []).length === 6,
    `${(block.match(/\/dashboard\?u=(?:d0|da)[0-9a-f]{6}-/g) ?? []).length} 件`);
  // 欄の外に漏れていないこと
  const outside = raw.slice(0, open) + raw.slice(close);
  ok('T-21c', 'diagnostic_user_id 表示が欄の外に無い', !/diagnostic_user_id:/.test(outside));
  ok('T-22b', 'デモ切替リンクが欄の外に無い', !/\/dashboard\?u=(?:d0|da)[0-9a-f]{6}-/.test(outside));
  // T-23: admin では中身を削っていない (既存のデバッグ項目が残っている)
  for (const key of ['admin 判定:', '他ユーザーで試す:', '紙面 (受領 JSON から生成):', 'AI問診の観測ログ:']) {
    ok('T-23', `admin 向けデバッグ項目「${key}」を残している`, block.includes(key));
  }
}

// ── ⑨ スコープの約束 ────────────────────────────────────────────
console.log('\n⑨ スコープ (spec §6 / §17)');
ok('SCOPE-1', 'index.astro を変更していない (url.search 転送のまま)',
  /const target = `\/dashboard\$\{url\.search\}`/.test(read('src/pages/index.astro')));
ok('SCOPE-2', 'live-token.ts が body の uid を受ける形のまま (今回は触らない)',
  /body\.diagnosticUserId/.test(read('src/pages/api/live-token.ts')));
ok('SCOPE-3', 'ALLOW_UID_ENTRY の入場分岐が残っている',
  /uidEntryAllowed\(\) && requested/.test(code('src/lib/viewer.ts')));
ok('T-24', '代理表示の判定に手を入れていない (viewer.isAdmin の参照が増えただけ)',
  /if \(isAdmin && requested && requested !== selfUid\)/.test(code('src/lib/viewer.ts'))
  && !/isAdmin/.test(code('src/lib/result-queries.ts')));

console.log(`\n${fails.length === 0 ? '✓ すべて PASS' : `✗ ${fails.length} 件 FAIL`}`);
if (fails.length) { console.error('\n落ちた検査:\n  - ' + fails.join('\n  - ')); process.exit(1); }
