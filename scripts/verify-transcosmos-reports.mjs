#!/usr/bin/env node
/**
 * `npm run verify:transcosmos-reports` — トランスコスモス 10 名の
 * **完成済み AI疾病予防報告書 PDF** 一括登録の回帰チェック。
 *
 * 正本: `src/lib/transcosmos-reports.ts` の冒頭コメント。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【ここは静かに壊れる】
 * ══════════════════════════════════════════════════════════════════════
 *
 *   - **slot と uid の取り違え** … 画面は「10 / 10 完了」と出るのに、
 *     A さんの報告書が B さんのダッシュボードで開く。誰も気づけない。
 *   - **Storage へ上がっていないのに DB を書く** … ボタンは押せるのに
 *     開くと 503。利用者から見ていちばん悪い形。
 *   - **`app_users` の placeholder に `auth_user_id` まで書く** … 後で本人が
 *     サインインしたときに**別 uid が発行され**、事前に入れた PDF が孤児になる。
 *   - **通常利用者の行き先を変える** … Elith 受領 JSON の人が PDF 解決 API を
 *     通り、余分な往復が入る (しかも 500 を踏むと報告書が全員開けない)。
 *
 * だから**実物の API ハンドラを transpile して動かす** (Supabase はスタブ)。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
/**
 * **コメント行を落としたコード。**
 *
 * 禁止したいものは、禁止の理由としてコメントに名前が出る (「`ADMIN_API_KEY` は
 * 使わない」等)。素の本文で検査すると**自分の説明文に当たって必ず落ちる**ので、
 * 「そう書いてあるか」でなく「**コードがそう呼んでいるか**」を見る。
 */
const code = (p) => read(p).split('\n')
  .filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln))
  .join('\n');

const fails = [];
const ts = (await import('typescript')).default;
const CACHE = resolve(ROOT, 'node_modules/.cache');
mkdirSync(CACHE, { recursive: true });
const js = (src) => ts.transpileModule(src, { compilerOptions: { target: 'ES2022', module: 'ESNext' } }).outputText;

const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails.push(`${label} — got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
};
const ok = (label, cond, why) => {
  if (!cond) fails.push(`${label}${why ? ` — ${why}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
};

/* ══════════════════════════════════════════════════════════════════════
   A. slot ↔ uid の対応 (ここがずれると他人の報告書が開く)
   ══════════════════════════════════════════════════════════════════════ */
const LIB = await (async () => {
  const out = resolve(CACHE, 'tc-lib.mjs');
  writeFileSync(out, js(read('src/lib/transcosmos-reports.ts')));
  return import(out);
})();

console.log('\nA. slot ↔ uid の対応\n');
{
  const map = LIB.TRANSCOSMOS_SLOT_UIDS;
  const slots = Object.keys(map);
  const uids = Object.values(map);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  eq('10 件ちょうど', slots.length, 10);
  eq('slot は 01〜10', slots.slice().sort(), ['01','02','03','04','05','06','07','08','09','10']);
  eq('slot に重複が無い', new Set(slots).size, 10);
  eq('**uid に重複が無い** (2 人が同じ枠を指さない)', new Set(uids).size, 10);
  ok('uid は全て UUID の形', uids.every((u) => UUID.test(u)), JSON.stringify(uids.filter((u) => !UUID.test(u))));
  ok('マスタは凍結してある (実行中に書き換えられない)', Object.isFrozen(map));

  /*
   * **氏名・メールアドレスをこのリポジトリへ持ち込まない。**
   * ZIP のファイル名には氏名が入っているので、うっかり固定 manifest へ
   * 書き写すと PII が Git 履歴に永久に残る。
   */
  const src = read('src/lib/transcosmos-reports.ts')
    + read('src/pages/api/admin/transcosmos-reports.ts')
    + read('src/pages/admin/transcosmos-reports.astro');
  ok('**氏名・メールアドレスを埋め込んでいない**',
    !/[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(src),
    'ZIP のファイル名の氏名を manifest へ書き写すと Git 履歴に残る');

  // slot → uid はサーバが引き直す。クライアント申告の uid を使わない。
  eq('transcosmosUidForSlot("01")', LIB.transcosmosUidForSlot('01'), map['01']);
  eq('  未知の slot は null', LIB.transcosmosUidForSlot('11'), null);
  eq('  "1" (0 詰めなし) も null', LIB.transcosmosUidForSlot('1'), null);
  eq('  "00" も null', LIB.transcosmosUidForSlot('00'), null);
  eq('  空も null', LIB.transcosmosUidForSlot(''), null);
  eq('  prototype 汚染を拾わない', LIB.transcosmosUidForSlot('__proto__'), null);
}

/* ══════════════════════════════════════════════════════════════════════
   A'. ファイル名 → slot / 保存キー / source_key
   ══════════════════════════════════════════════════════════════════════ */
console.log("\nA'. ファイル名の判定と保存キー\n");
{
  const f = LIB.slotFromPdfName;
  eq('01_氏名.pdf → 01', f('01_山田.pdf'), '01');
  eq('階層つきでも basename で見る', f('報告書/10_鈴木_最終.pdf'), '10');
  eq('拡張子の大小は問わない', f('03_a.PDF'), '03');
  eq('区切りが無い名前は拾わない', f('01氏名.pdf'), null);
  eq('PDF でなければ null', f('01_a.docx'), null);
  eq('11 は対象外', f('11_a.pdf'), null);
  eq('__MACOSX 等の付随物も落ちる', f('__MACOSX/._01_a.pdf'), null);

  const uid = LIB.TRANSCOSMOS_SLOT_UIDS['01'];
  const rnd = '11111111-2222-4333-8444-555555555555';
  const path = LIB.transcosmosStoragePath(uid, rnd);
  eq('保存キーの形', path, `manual/transcosmos/20260928/${uid}/${rnd}.pdf`);
  ok('保存キーに氏名・元ファイル名が入らない', !/[ぁ-んァ-ヶ一-龠]/.test(path));
  ok('規約どおりと判定できる', LIB.isTranscosmosStoragePath(path));
  ok('納品 JSON のキーは通さない',
    !LIB.isTranscosmosStoragePath('user/abc/date/2026_09_28/HealthCheckupData.json'));
  ok('相対パス脱出は通さない',
    !LIB.isTranscosmosStoragePath(`manual/transcosmos/20260928/${uid}/../../x.pdf`));
  ok('別バッチは通さない', !LIB.isTranscosmosStoragePath(`manual/transcosmos/20990101/${uid}/${rnd}.pdf`));
  eq('source_key は uid 込み', LIB.transcosmosSourceKey(uid), `manual:transcosmos:20260928:${uid}`);
  ok('source_key は report-route の LIKE に当たる',
    LIB.transcosmosSourceKey(uid).startsWith('manual:transcosmos:'),
    'ここがずれると PDF 解決 API が行を見つけられない');
}

/* ══════════════════════════════════════════════════════════════════════
   C. preflight (10 件ちょうど・重複なし・0 byte なし・UID 改ざん)
   ══════════════════════════════════════════════════════════════════════ */
console.log('\nC. preflight (plan の検証)\n');
{
  const SHA = 'a'.repeat(64);
  const all = Object.keys(LIB.TRANSCOSMOS_SLOT_UIDS).sort()
    .map((slot) => ({ slot, sizeBytes: 1024, sha256: SHA }));

  eq('10 件そろえば ok', LIB.validateTranscosmosPlan(all).ok, true);
  eq('  uid はマスタから付く',
    LIB.validateTranscosmosPlan(all).items.map((i) => i.uid),
    Object.keys(LIB.TRANSCOSMOS_SLOT_UIDS).sort().map((s) => LIB.TRANSCOSMOS_SLOT_UIDS[s]));

  eq('11 件 → reject', LIB.validateTranscosmosPlan([...all, { slot: '01', sizeBytes: 1, sha256: SHA }]).error,
    'file_count_mismatch');
  eq('9 件 → reject', LIB.validateTranscosmosPlan(all.slice(0, 9)).error, 'file_count_mismatch');

  const dup = all.slice(0, 9).concat([{ slot: '01', sizeBytes: 1024, sha256: SHA }]);
  eq('slot 重複 → reject', LIB.validateTranscosmosPlan(dup).error, 'duplicate_slot');

  const unknown = all.slice(0, 9).concat([{ slot: '11', sizeBytes: 1024, sha256: SHA }]);
  eq('未知 slot → reject', LIB.validateTranscosmosPlan(unknown).error, 'unknown_slot');

  const zero = all.map((x, i) => (i === 3 ? { ...x, sizeBytes: 0 } : x));
  eq('0 byte → reject', LIB.validateTranscosmosPlan(zero).error, 'invalid_size');

  const huge = all.map((x, i) => (i === 3 ? { ...x, sizeBytes: 999 * 1024 * 1024 } : x));
  eq('大きすぎる → reject', LIB.validateTranscosmosPlan(huge).error, 'file_too_large');

  const badSha = all.map((x, i) => (i === 5 ? { ...x, sha256: 'zz' } : x));
  eq('SHA の形が違う → reject', LIB.validateTranscosmosPlan(badSha).error, 'invalid_sha256');

  eq('配列でない → reject', LIB.validateTranscosmosPlan({ slot: '01' }).error, 'files_not_array');

  /*
   * **UID 改ざん。** クライアントが uid を添えてきても、サーバは
   * slot から引き直すので別人の枠へ入らない。
   */
  const forged = all.map((x) => ({ ...x, uid: '00000000-0000-4000-8000-000000000000' }));
  const got = LIB.validateTranscosmosPlan(forged);
  ok('**クライアント申告の uid を採らない**',
    got.ok && got.items.every((i) => i.uid !== '00000000-0000-4000-8000-000000000000'),
    '送られた uid を使うと admin 画面から他人の枠へ PDF を紐付けられる');
  const src = read('src/pages/api/admin/transcosmos-reports.ts');
  ok('  API が body の uid を読んでいない',
    !/body\.uid|\.uid\s*\?\?|e\.uid/.test(src),
    'uid は slot から引く以外の経路を持たせない');
}

/* ══════════════════════════════════════════════════════════════════════
   B / D. 実物の API を動かす (admin 認可・存在確認・placeholder・冪等)
   ══════════════════════════════════════════════════════════════════════ */
console.log('\nB / D. API を実際に動かす\n');

const API = await (async () => {
  writeFileSync(resolve(CACHE, 'tc-viewer.mjs'),
    'export const resolveViewer = async () => globalThis.__viewer;\n');
  writeFileSync(resolve(CACHE, 'tc-supabase.mjs'),
    'export const getServerSupabase = () => globalThis.__sb;\n');
  let src = read('src/pages/api/admin/transcosmos-reports.ts')
    .replace(/^import type .*?;$/gm, '')
    .replace(/from '\.\.\/\.\.\/\.\.\/lib\/viewer'/g, "from './tc-viewer.mjs'")
    .replace(/from '\.\.\/\.\.\/\.\.\/lib\/supabase'/g, "from './tc-supabase.mjs'")
    .replace(/from '\.\.\/\.\.\/\.\.\/lib\/transcosmos-reports'/g, "from './tc-lib.mjs'");
  if (/\.\.\/\.\.\/\.\.\/lib\//.test(src)) fails.push('verify: API の import 差し替えに失敗');
  const out = resolve(CACHE, 'tc-api.mjs');
  writeFileSync(out, js(src));
  return import(out);
})();

/** Supabase のスタブ。Storage の中身と diagnosis の 2 表を模す。 */
function makeSb(opts = {}) {
  const state = {
    objects: new Map(opts.objects ?? []),      // path → size
    appUsers: new Map(opts.appUsers ?? []),    // uid → row
    results: new Map(opts.results ?? []),      // id → row
    writes: [],
    signFails: !!opts.signFails,
    listFails: !!opts.listFails,
  };
  let seq = 0;
  const storage = {
    createSignedUploadUrl: async (path) => {
      if (state.signFails) return { data: null, error: { message: 'sign boom' } };
      state.writes.push({ op: 'sign', path });
      return { data: { path, token: `tok-${++seq}`, signedUrl: `https://stub/${path}` }, error: null };
    },
    list: async (dir, o) => {
      if (state.listFails) return { data: null, error: { message: 'list boom' } };
      const want = o?.search ?? '';
      const out = [];
      for (const [p, size] of state.objects) {
        if (!p.startsWith(`${dir}/`)) continue;
        const base = p.slice(dir.length + 1);
        if (want && base !== want) continue;
        out.push({ name: base, id: 'x', metadata: { size } });
      }
      return { data: out, error: null };
    },
  };
  const table = (name) => ({
    upsert: async (rows) => {
      for (const r of [].concat(rows)) {
        state.writes.push({ op: 'upsert', table: name, values: r });
        if (name === 'app_users' && !state.appUsers.has(r.diagnostic_user_id)) {
          state.appUsers.set(r.diagnostic_user_id, { ...r });
        }
      }
      return { data: null, error: null };
    },
    select(_cols) {
      const q = {
        in: async () => ({ data: [...state.results.values()], error: null }),
        eq() { return q; },
        limit() { return q; },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then(...a) { return Promise.resolve({ data: [...state.results.values()], error: null }).then(...a); },
      };
      return q;
    },
    insert(values) {
      const id = `res-${++seq}`;
      state.writes.push({ op: 'insert', table: name, values });
      state.results.set(id, { id, ...values });
      return { select: () => ({ single: async () => ({ data: { id }, error: null }) }) };
    },
    update(values) {
      return {
        eq: async (_k, id) => {
          state.writes.push({ op: 'update', table: name, values, id });
          state.results.set(id, { ...(state.results.get(id) ?? {}), ...values });
          return { data: null, error: null };
        },
      };
    },
  });
  return {
    __state: state,
    storage: { from: () => storage },
    schema: () => ({ from: table }),
  };
}

const SHA = 'b'.repeat(64);
const slots = Object.keys(LIB.TRANSCOSMOS_SLOT_UIDS).sort();
const planFiles = slots.map((slot) => ({ slot, sizeBytes: 2048, sha256: SHA }));

async function post(body, { admin = true, sb = makeSb() } = {}) {
  globalThis.__viewer = { isAdmin: admin, uid: 'admin-uid' };
  globalThis.__sb = sb;
  const res = await API.POST({
    request: new Request('http://x/api/admin/transcosmos-reports', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})), sb };
}

/* ── B. admin でなければ拒否 ───────────────────────────────────── */
{
  const r = await post({ action: 'plan', files: planFiles }, { admin: false });
  eq('B. 非 admin は 401', r.status, 401);
  eq('B.   何も書かない', r.sb.__state.writes.length, 0);

  const page = read('src/pages/admin/transcosmos-reports.astro');
  ok('B. 画面は非 admin に 404 を返す',
    /resolveViewer\(Astro\)/.test(page) && /notFoundForNonAdmin\(\)/.test(page),
    'admin/index.astro と同じ形で塞ぐ');
  const api = code('src/pages/api/admin/transcosmos-reports.ts');
  ok('B. **API は ADMIN_API_KEY を使っていない** (管理者 session で判定)',
    !/isAdminAuthorized|ADMIN_API_KEY/.test(api) && /viewer\.isAdmin/.test(api),
    '鍵認可にすると鍵を持つ誰かが 10 名の枠へ書ける');
  ok('B.   認可は本文を読む前に行う',
    api.indexOf('viewer.isAdmin') < api.indexOf('ctx.request.json()'));
}

/* ── plan: 10 本の署名を出す ───────────────────────────────────── */
let planned = [];
{
  const r = await post({ action: 'plan', files: planFiles });
  eq('plan は 200', r.status, 200);
  eq('  10 本の署名が返る', (r.json.files ?? []).length, 10);
  planned = r.json.files;
  ok('  保存キーはサーバ採番で規約どおり',
    planned.every((p) => LIB.isTranscosmosStoragePath(p.path)), JSON.stringify(planned[0] ?? {}));
  ok('  **キーは slot の uid 配下**',
    planned.every((p) => p.path.includes(`/${LIB.transcosmosUidForSlot(p.slot)}/`)));
  eq('  10 本とも別のキー', new Set(planned.map((p) => p.path)).size, 10);
  eq('  plan では DB を触らない',
    r.sb.__state.writes.filter((w) => w.op !== 'sign').length, 0);

  const bad = await post({ action: 'plan', files: planFiles.slice(0, 9) });
  eq('plan は 9 件で 400', [bad.status, bad.json.error], [400, 'file_count_mismatch']);
  eq('  署名も発行しない', bad.sb.__state.writes.length, 0);

  const boom = await post({ action: 'plan', files: planFiles }, { sb: makeSb({ signFails: true }) });
  eq('署名が落ちたら 503', [boom.status, boom.json.error], [503, 'sign_failed']);
}

const finFiles = () => planned.map((p) => ({ slot: p.slot, path: p.path, sizeBytes: 2048, sha256: SHA }));
const allObjects = () => planned.map((p) => [p.path, 2048]);

/* ── D. Storage に無ければ DB を 1 行も変えない ────────────────── */
{
  const r = await post({ action: 'finalize', files: finFiles() }, { sb: makeSb({ objects: [] }) });
  eq('D. **Storage に object が無ければ 409**', [r.status, r.json.error], [409, 'object_missing']);
  eq('D.   DB 変更 0 件', r.sb.__state.writes.length, 0);

  const half = planned.slice(0, 9).map((p) => [p.path, 2048]);
  const r2 = await post({ action: 'finalize', files: finFiles() }, { sb: makeSb({ objects: half }) });
  eq('D. 1 件でも欠けたら 409', r2.status, 409);
  eq('D.   DB 変更 0 件', r2.sb.__state.writes.length, 0);

  const empty = planned.map((p) => [p.path, 0]);
  const r3 = await post({ action: 'finalize', files: finFiles() }, { sb: makeSb({ objects: empty }) });
  eq('D. 0 byte の object は 409', [r3.status, r3.json.error], [409, 'object_empty']);
  eq('D.   DB 変更 0 件', r3.sb.__state.writes.length, 0);

  const r4 = await post({ action: 'finalize', files: finFiles() },
    { sb: makeSb({ objects: allObjects(), listFails: true }) });
  eq('D. 存在確認が落ちたら 503', [r4.status, r4.json.error], [503, 'storage_list_failed']);
  eq('D.   DB 変更 0 件', r4.sb.__state.writes.length, 0);
}

/* ── D. キーの uid すり替えを拒否 ──────────────────────────────── */
{
  const other = LIB.transcosmosUidForSlot('02');
  const swapped = finFiles().map((f, i) => (i === 0
    ? { ...f, path: LIB.transcosmosStoragePath(other, '99999999-9999-4999-8999-999999999999') }
    : f));
  const r = await post({ action: 'finalize', files: swapped }, { sb: makeSb({ objects: allObjects() }) });
  eq('D. **別人の uid 配下のキーは 400**', [r.status, r.json.error], [400, 'path_uid_mismatch']);
  eq('D.   DB 変更 0 件', r.sb.__state.writes.length, 0);

  const junk = finFiles().map((f, i) => (i === 0 ? { ...f, path: 'user/x/HealthCheckupData.json' } : f));
  const r2 = await post({ action: 'finalize', files: junk }, { sb: makeSb({ objects: allObjects() }) });
  eq('D. 規約外のキーは 400', [r2.status, r2.json.error], [400, 'invalid_path']);
}

/* ── D. app_users placeholder ──────────────────────────────────── */
{
  const r = await post({ action: 'finalize', files: finFiles() }, { sb: makeSb({ objects: allObjects() }) });
  eq('D. 10 件登録できる', [r.status, r.json.count], [200, 10]);

  const ups = r.sb.__state.writes.filter((w) => w.op === 'upsert' && w.table === 'app_users');
  eq('D. **app_users の placeholder を 10 件作る**', ups.length, 10);
  const keys = new Set(ups.flatMap((w) => Object.keys(w.values)));
  eq('D.   **入れるのは diagnostic_user_id 1 列だけ**', [...keys], ['diagnostic_user_id']);
  for (const bad of ['auth_user_id', 'google_sub', 'hp_customer_user_id', 'display_name_cache']) {
    ok(`D.   ${bad} を書いていない`, !keys.has(bad),
      '書くと本人サインイン時に別 uid が発行され事前投入の PDF が孤児になる');
  }
  const api = code('src/pages/api/admin/transcosmos-reports.ts');
  ok('D.   既存行を上書きしない (ignoreDuplicates)',
    /ignoreDuplicates:\s*true/.test(api),
    '本人が先にログインしていた回の auth_user_id を壊さない');
  ok('D.   **Supabase Auth user / password を作っていない**',
    !/auth\.admin|createUser|signUp|password/.test(api));

  const inserts = r.sb.__state.writes.filter((w) => w.op === 'insert' && w.table === 'diagnosis_results');
  eq('D. manual 行が無ければ insert', inserts.length, 10);
  const v = inserts[0].values;
  eq('D.   schema_version', v.schema_version, 'manual-pdf-v1');
  eq('D.   status', v.status, 'received');
  eq('D.   report は空配列', v.report, []);
  ok('D.   source_key が manual:transcosmos:', String(v.source_key).startsWith('manual:transcosmos:'));
  ok('D.   report_pdf_url は相対キー (lab-results の署名 URL になる)',
    LIB.isTranscosmosStoragePath(v.report_pdf_url), v.report_pdf_url);
  eq('D.   report_pdf_sha256 はブラウザ計算値', v.report_pdf_sha256, SHA);
  ok('D.   diagnostic_id を新規発行している', /^[0-9a-f-]{36}$/.test(String(v.diagnostic_id)));
  ok('D.   report_pdf_pages を書いていない (今回の表示に不要)',
    !('report_pdf_pages' in v), JSON.stringify(Object.keys(v)));

  /*
   * **test_artifacts / measurement_values / ai_prediction へ 1 行も書かない。**
   * これは AI疾病予防報告書で、`ai_prediction` (LAiF の AI疾病発症予測) ではない。
   */
  ok('D. **test_artifacts / measurement_values を触っていない**',
    !r.sb.__state.writes.some((w) => w.table === 'test_artifacts' || w.table === 'measurement_values'));
  ok('D. **ai_prediction / LAiF / Elith JSON を扱っていない**',
    !/ai_prediction|LAiF|elith/i.test(api),
    'test_type=ai_prediction として登録してはいけない');
}

/* ── D. 冪等 (2 回流しても行が増えない) ───────────────────────── */
{
  const uid01 = LIB.transcosmosUidForSlot('01');
  const existing = [['res-existing', {
    id: 'res-existing',
    diagnostic_user_id: uid01,
    source_key: LIB.transcosmosSourceKey(uid01),
    diagnostic_id: 'keep-me',
  }]];
  const r = await post({ action: 'finalize', files: finFiles() },
    { sb: makeSb({ objects: allObjects(), results: existing }) });
  eq('D. 既存 manual 行があっても 200', [r.status, r.json.count], [200, 10]);
  const modes = (r.json.results ?? []).reduce((a, x) => ({ ...a, [x.mode]: (a[x.mode] ?? 0) + 1 }), {});
  eq('D. **既存の 1 件は update / 残り 9 件は insert**', modes, { update: 1, insert: 9 });
  /*
   * **`upd` が無い回でも名指しで落とす。** 以前は `upd.id` を直に読んでいて、
   * 冪等が壊れた退行 (既存行があっても insert) を注入すると**スクリプトが
   * 例外で死に**、どの検査が落ちたのか summary に出なかった。
   * 「落ちる」と「クラッシュする」は別物なので、必ず名前で落とす。
   */
  const upd = r.sb.__state.writes.find((w) => w.op === 'update' && w.table === 'diagnosis_results');
  ok('D.   既存行に update が 1 件飛んでいる', !!upd,
    '既存 manual 行があるのに update が無い = 行を増やしている');
  eq('D.   update 対象は既存行', upd?.id ?? null, 'res-existing');
  ok('D.   **diagnostic_id を書き換えない** (行を増やさず維持)',
    !!upd && !('diagnostic_id' in upd.values), JSON.stringify(Object.keys(upd?.values ?? {})));
  eq('D.   diagnosis_results の行は 10 件のまま', r.sb.__state.results.size, 10);
}

/* ══════════════════════════════════════════════════════════════════════
   E. ダッシュボードの行き先 (通常利用者を変えない)
   ══════════════════════════════════════════════════════════════════════ */
console.log('\nE. ダッシュボードの行き先\n');
{
  const dash = read('src/pages/dashboard.astro');
  const card = code('src/components/dashboard/ReportLinkCard.astro');

  ok('E. **器 (ReportLinkCard) は href をそのまま使う**',
    /href=\{href\}/.test(card) && !/report-route/.test(card),
    '器で全員を resolver へ通すと通常利用者にも余分な往復が入る');

  ok('E. 判定は dashboard.astro の 1 か所', /const manualPdfReport\s*=/.test(dash));
  ok('E.   条件は report_pdf_url **かつ** source_key の前方一致',
    /report_pdf_url[\s\S]{0,160}startsWith\('manual:transcosmos:'\)/.test(dash),
    '片方だけだと通常利用者やデモを巻き込む');
  ok('E.   manual のときだけ /api/report-route へ送る',
    /manualPdfReport[\s\S]{0,120}\/api\/report-route\?dest=/.test(dash));
  eq('E.   ReportLinkCard の 2 箇所とも reportHref',
    (dash.match(/<ReportLinkCard href=\{reportHref\}/g) ?? []).length, 2);
  ok('E.   `/report` 直書きの ReportLinkCard が残っていない',
    !/<ReportLinkCard href=\{`\$\{linkPrefix\}\/report/.test(dash));

  // 実際に式を評価する (書き写した式を試すと実装を変えても検査だけ通る)。
  const m = /const manualPdfReport\s*=\s*([\s\S]*?);\n/.exec(dash);
  ok('E. 判定式を実物から取り出せる', !!m);
  if (m) {
    const evalWith = (latestResult) => {
      try {
        return new Function('data', `return (${m[1].replace(/\n/g, ' ')});`)({ latestResult });
      } catch (e) { return `THREW: ${e instanceof Error ? e.message : e}`; }
    };
    const uid = LIB.transcosmosUidForSlot('01');
    eq('E.   manual PDF の人 → true',
      evalWith({ report_pdf_url: `manual/transcosmos/20260928/${uid}/x.pdf`,
                 source_key: LIB.transcosmosSourceKey(uid) }), true);
    eq('E.   **通常の Elith 受領 JSON の人 → false**',
      evalWith({ report_pdf_url: null, source_key: null }), false);
    eq('E.   **デモ (source_key null) → false**',
      evalWith({ report_pdf_url: null, source_key: null }), false);
    eq('E.   別 source_key の PDF 持ち → false',
      evalWith({ report_pdf_url: 'raw/x.pdf', source_key: 'elith:auto:1' }), false);
    eq('E.   source_key だけで url が無い → false',
      evalWith({ report_pdf_url: null, source_key: LIB.transcosmosSourceKey(uid) }), false);
    eq('E.   latestResult が無い → false', evalWith(null), false);
  }

  /*
   * **`/api/report-route` は `noStore(ctx.response)` を呼んではいけない。**
   * API route の `APIContext` に `response` は無く、`noStore(undefined)` が
   * TypeError になって **全リクエストで 500** になる (2026-10-05 本番実測)。
   * ダッシュボードの「報告書を読む」が全利用者で壊れた原因。
   */
  const route = code('src/pages/api/report-route.ts');
  ok('E. **report-route が ctx.response を触っていない** (500 の原因)',
    !/noStore\(ctx\.response\)|ctx\.response/.test(route),
    'APIContext に response は無い。呼ぶと全リクエストで 500 になる');
  ok('E.   Response.redirect を使っていない (cache-control を付けられない)',
    !/Response\.redirect/.test(route));
  ok('E.   redirect に private, no-store を付けている',
    /'cache-control':\s*'private, no-store'/.test(route),
    '短寿命の署名 URL が共有キャッシュへ載らないようにする');
  ok('E.   dest は相対 URL だけ通す',
    /dest\.startsWith\('\/'\)[\s\S]{0,80}startsWith\('\/\/'\)/.test(route));
  /*
   * **フォールバックに `ctx.request.url` の origin を使ってはいけない。**
   * Vercel の関数が見る URL は内部のもので、本番で
   * `location: https://localhost/report` へ飛ばしていた (2026-10-05 実測)。
   * `Location` は相対値が許されるので `dest` をそのまま返す。
   */
  ok('E. **フォールバックは相対 URL** (本番で https://localhost へ飛んでいた)',
    /const fallback = dest;/.test(route) && !/new URL\(dest, url\.origin\)/.test(route),
    'request.url の origin は Vercel では内部 URL になる');
  ok('E.   dest の解釈に実 origin を混ぜていない',
    !/new URL\([^)]*url\.origin\)/.test(route));
}

/* ══════════════════════════════════════════════════════════════════════
   F. 型の取りこぼし (astro check が落ちていた原因)
   ══════════════════════════════════════════════════════════════════════ */
console.log('\nF. 生成型と実 DDL の一致\n');
{
  const types = read('src/types/supabase-diagnosis.ts');
  for (const col of ['report_pdf_url', 'report_pdf_sha256', 'report_pdf_pages',
    'report_pdf_received_at', 'source_key']) {
    ok(`F. diagnosis_results の型に ${col} が在る`, types.includes(`${col}:`),
      'migration で足した列が生成型に無いと astro check が落ちる (本番で 6 件)');
  }
  const mig = read('supabase/migrations/20260917000010_diagnosis_results_source.sql');
  ok('F. source_key の DDL が在る (型だけ先走っていない)', /add column if not exists source_key/.test(mig));
  const demo = read('src/lib/demo-data.ts');
  ok('F. **デモの latestResult は source_key が null**',
    /source_key:\s*null/.test(demo),
    'デモに manual の source_key を入れるとダッシュボードが PDF 解決へ送る');
}

/* ══════════════════════════════════════════════════════════════════════
   G. 巨大 ZIP / PDF を Vercel Functions へ通していないこと
   ══════════════════════════════════════════════════════════════════════ */
console.log('\nG. PDF 本体を関数へ通していない\n');
{
  const page = code('src/pages/admin/transcosmos-reports.astro');
  const api = code('src/pages/api/admin/transcosmos-reports.ts');
  ok('G. ZIP はブラウザ内で展開する (fflate)', /unzipSync/.test(page) && /from 'fflate'/.test(page));
  ok('G. **API が受けるのは slot / サイズ / SHA / キーだけ**',
    !/formData|arrayBuffer|multipart/.test(api),
    '15MB 超 × 10 本は本文上限 4.5MB に収まらない');
  ok('G. ブラウザから Storage へ直送する',
    /uploadToSignedUrl/.test(page) && /createSignedUploadUrl/.test(api));
  ok('G.   送信は 2 並列まで', /Promise\.all\(\[worker\(\), worker\(\)\]\)/.test(page));
  ok('G.   1 件でも失敗したら finalize を呼ばない',
    /failures\.length[\s\S]{0,300}return;/.test(page));
  ok('G.   SHA-256 はブラウザで計算する', /crypto\.subtle\.digest\('SHA-256'/.test(page));
  ok('G.   magic bytes (%PDF-) を見る', /0x25[\s\S]{0,80}0x50[\s\S]{0,80}0x44[\s\S]{0,80}0x46/.test(page));
  ok('G. **ファイル名をサーバへ送っていない**',
    /files:\s*picked\.map\(\(p\)\s*=>\s*\(\{\s*slot:[^}]*\}\)\)/.test(page.replace(/\n/g, ' ')),
    'ZIP のファイル名には氏名が入っているので送らない');
  ok('G. バケットは lab-results', /TRANSCOSMOS_BUCKET/.test(api) && /'lab-results'/.test(read('src/lib/transcosmos-reports.ts')));
  ok('G. S3 (原本バケット) を使っていない',
    !/originals|s3:\/\/|getOriginalsS3Config/.test(api), '今回は Supabase Storage を使う');
}

/* ══════════════════════════════════════════════════════════════════════
   H. 実物の ZIP を作って、画面と同じ取り出し方で 10 本に分かれるか
   ══════════════════════════════════════════════════════════════════════

   画面は `fflate` の `unzipSync` + `slotFromPdfName` フィルタと
   `crypto.subtle.digest('SHA-256')` を使う。**ライブラリの実バージョンで
   その組み合わせが動くか**は静的検査では分からないので、ここで本物の ZIP を
   組んで通す (admin 画面は本番の admin session が要るのでここでは開けない)。 */
console.log('\nH. 実物の ZIP を画面と同じ手順で展開する\n');
{
  const { zipSync, unzipSync } = await import('fflate');

  /** `%PDF-` で始まる最小限の中身 (**PDF の意味は見ない**・形だけ)。 */
  const fakePdf = (slot) => {
    const head = new TextEncoder().encode(`%PDF-1.7\n% slot ${slot}\n`);
    const body = new Uint8Array(4096).fill(0x20);
    const out = new Uint8Array(head.length + body.length);
    out.set(head, 0); out.set(body, head.length);
    return out;
  };

  // 氏名入りの実ファイル名に近い形 + 余計な中身 (階層・非 PDF・付随物) を混ぜる。
  const entries = { 'notes.txt': new TextEncoder().encode('メモ'), '__MACOSX/._01_x.pdf': fakePdf('xx') };
  for (const slot of slots) entries[`報告書/${slot}_受診者${slot}_最終.pdf`] = fakePdf(slot);
  const zipped = zipSync(entries, { level: 0 });
  ok('H. ZIP を組めた', zipped.length > 0);

  // ── 画面と同じ取り出し ──
  const got = unzipSync(zipped, { filter: (f) => LIB.slotFromPdfName(f.name) !== null });
  const names = Object.keys(got);
  eq('H. PDF だけ 10 件取れる', names.length, 10);
  ok('H.   notes.txt を拾っていない', !names.some((n) => n.endsWith('.txt')));
  ok('H.   __MACOSX の付随物を拾っていない', !names.some((n) => n.includes('__MACOSX')));
  eq('H.   slot は 01〜10', names.map((n) => LIB.slotFromPdfName(n)).sort(), slots);
  ok('H.   階層を無視して basename で判定している',
    names.every((n) => n.startsWith('報告書/')));

  // ── 画面と同じ magic bytes / SHA-256 ──
  const looksPdf = (b) => b.length > 5 && b[0] === 0x25 && b[1] === 0x50
    && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;
  ok('H. 10 件とも %PDF- で始まる', Object.values(got).every(looksPdf));

  const sha256Hex = async (bytes) => {
    const buf = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const picked = [];
  for (const [name, bytes] of Object.entries(got)) {
    picked.push({ slot: LIB.slotFromPdfName(name), sizeBytes: bytes.length, sha256: await sha256Hex(bytes) });
  }
  ok('H. SHA-256 が 64 桁の 16 進で出る', picked.every((p) => /^[0-9a-f]{64}$/.test(p.sha256)));
  eq('H.   slot ごとに違う SHA (中身が違えば違う)', new Set(picked.map((p) => p.sha256)).size, 10);

  // ── そのまま plan へ通せる ──
  const v = LIB.validateTranscosmosPlan(picked);
  eq('H. **この 10 件がそのまま plan を通る**', v.ok, true);
  const r = await post({ action: 'plan', files: picked });
  eq('H.   API も 200 を返す', r.status, 200);
  eq('H.   10 本の署名が出る', (r.json.files ?? []).length, 10);

  // ── 1 本欠けた ZIP は通らない ──
  const short = { ...entries };
  delete short['報告書/07_受診者07_最終.pdf'];
  const got2 = unzipSync(zipSync(short, { level: 0 }),
    { filter: (f) => LIB.slotFromPdfName(f.name) !== null });
  eq('H. 1 本欠けた ZIP は 9 件にしかならない', Object.keys(got2).length, 9);
  eq('H.   plan も通らない',
    LIB.validateTranscosmosPlan(Object.keys(got2).map((n) => ({
      slot: LIB.slotFromPdfName(n), sizeBytes: 4096, sha256: 'c'.repeat(64),
    }))).error, 'file_count_mismatch');
}

/* ── 結果 ──────────────────────────────────────────────────────── */
console.log(`\n${'='.repeat(62)}`);
if (fails.length) {
  console.log(`✗ ${fails.length} 件 FAIL`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✓ すべて PASS — 完成済み PDF は本人の枠にだけ入り、通常利用者の行き先は変わりません。\n');
