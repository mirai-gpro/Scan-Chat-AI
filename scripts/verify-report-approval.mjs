#!/usr/bin/env node
/**
 * `npm run verify:report-approval` — AI疾病予防報告書の **承認ゲートと 1 件再作成** の回帰チェック。
 *
 * 正本: `src/lib/report-approval.ts` の冒頭コメント /
 *       `docs/elith/AI疾病予防報告書_承認と再作成_仕様書.md`
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【ここは静かに壊れる】
 * ══════════════════════════════════════════════════════════════════════
 *   - **既存の公開中の報告書が導入で消える** … 列の既定を `pending` にするだけで
 *     既存全件が未承認になる。画面はエラーを出さず「報告書がありません」になる。
 *   - **未承認がユーザーに出る** … 取得経路の 1 つで絞り忘れても、他の経路が
 *     正しければ画面は正常に見える。漏れた経路だけが黙って公開する。
 *   - **再作成の失敗で公開中の報告書が消える** … 先に消してから作ると、
 *     失敗した回だけ利用者の報告書が空になる。**成功するまで触らない**が要件。
 *   - **再作成した紙面が承認済のまま残る** … 誰も確認していないものが公開される。
 *   - **トランスコスモス 10 名を再作成してしまう** … 受領 JSON を持たないので
 *     生成は空になり、公開中の PDF が未承認に落ちて 10 名の画面から消える。
 *
 * だから**実物を transpile して動かす**。Supabase / S3 / 生成本体だけスタブに
 * 差し替えるので、DB も鍵も要らない (verify:elith-intake と同じ流儀)。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
/** コメント行を落としたコード。「そう書いてあるか」でなく「そう呼んでいるか」を見る。 */
const code = (p) => read(p).split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');

const fails = [];
const ok = (label, cond, why) => {
  if (!cond) fails.push(`${label}${why ? ` — ${why}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);

const ts = (await import('typescript')).default;
const CACHE = resolve(ROOT, '.verify-cache-approval');
rmSync(CACHE, { recursive: true, force: true });
mkdirSync(CACHE, { recursive: true });
const js = (src) => ts.transpileModule(src, { compilerOptions: { target: 'ES2022', module: 'ESNext' } }).outputText;

const U1 = '11111111-1111-1111-1111-111111111111';
const R1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const R2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const FOLDER = `output/user/${U1}/date/2026_09_16/`;

/* ══════════════════════════════════════════════════════════════════════
   実物を読み込む (報告書の生成本体・S3・取り込みの読み取りだけスタブ)
   ══════════════════════════════════════════════════════════════════════ */
const M = await (async () => {
  writeFileSync(resolve(CACHE, 'ra-adapter.mjs'), `
/** 指紋が取れる最小の ReportVM。setVm で中身を差し替えると指紋も変わる。 */
const baseVm = (tag) => ({
  reportType: 2, isSample: false,
  cover: { name: '', issuedOn: '2026-09-16', sheetVersion: 'v1.0', testedOn: null,
    cycleSeq: null, cycleTotal: 4, wellnessAge: null, chronologicalAge: null },
  axes: [{ key: 'a', title: 'A' }, { key: 'b', title: 'B' }],
  digest: [{ key: 'abstract', title: '', axis: 'a', source: 's', detailAnchor: null, lead: true,
    blocks: [{ kind: 'paragraphs', items: [tag] }] }],
  chapters: [{ key: 'summary', title: 'T', axis: 'b', collapsed: false,
    topics: [{ anchor: '#t', heading: 'h', body: tag }] }],
  audit: { sections: ['a'], measurementCount: 3, topicCount: 5, digestCards: ['x'], emptyCards: [],
    hiddenChapters: [], unknownChapterKeys: [], anomalies: [] },
});
export let __vm = baseVm('原文');
export const makeVm = baseVm;
export let __throw = false;
export const __calls = [];
export const setVm = (v) => { __vm = v; };
export const setThrow = (v) => { __throw = v; };
export const buildReportVM = (input) => {
  __calls.push(input);
  if (__throw) throw new Error('boom');
  return __vm;
};
`);
  writeFileSync(resolve(CACHE, 'ra-s3.mjs'), `
export let __configured = true;
export let __keys = [];
export let __listThrows = false;
export const setS3 = (c, keys, listThrows) => { __configured = c; __keys = keys; __listThrows = !!listThrows; };
export const isS3Configured = () => __configured;
export const listObjects = async (prefix) => {
  if (__listThrows) throw new Error('s3 down');
  return __keys.filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, size: 1 }));
};
export const getObjectText = async () => '{}';
`);
  writeFileSync(resolve(CACHE, 'ra-intake.mjs'), `
export const OUTPUT_ROOT = 'output/user/';
export const REPORT_FILE = 'report_text.json';
export const MIN_FILES_COMPLETE = 2;
export const __read = [];
export let __material = { report: { s3: true }, checkup: { health_checkup: {} }, schemaVersion: 'elith-v2.0' };
export const setMaterial = (m) => { __material = m; };
export const groupByFolder = (keys) => {
  const folders = new Map();
  for (const key of keys) {
    const i = key.lastIndexOf('/');
    const folder = key.slice(0, i + 1);
    const e = folders.get(folder) ?? { clientId: '', date: '', files: [] };
    e.files.push(key.slice(i + 1));
    folders.set(folder, e);
  }
  return { folders, skippedKeys: [] };
};
export const readFolderMaterial = async (folder, files) => { __read.push({ folder, files }); return __material; };
`);
  /*
   * **指紋の実装はスタブにしない** (実物を transpile する)。
   * `report-adapter` だけ上のスタブへ向けるので、`fingerprintOfRow` は
   * スタブ VM の指紋を返す = 配線 (保存・照合・null 化) を実物で動かせる。
   * 正規化そのものの性質 (文脈非依存・中身に敏感) は ⑪ で**本物のアダプタ**で見る。
   */
  writeFileSync(resolve(CACHE, 'report-fingerprint.mjs'),
    js(read('src/lib/report-fingerprint.ts')
      .replace(/from '\.\/report-adapter'/g, "from './ra-adapter.mjs'")
      .replace(/from '\.\/report-model'/g, "from './ra-model.mjs'")));
  writeFileSync(resolve(CACHE, 'ra-model.mjs'), 'export {};\n');

  const body = js(read('src/lib/report-approval.ts')
    .replace(/from '\.\/report-adapter'/g, "from './ra-adapter.mjs'")
    .replace(/from '\.\/report-model'/g, "from './ra-model.mjs'")
    .replace(/from '\.\/report-fingerprint'/g, "from './report-fingerprint.mjs'")
    .replace(/from '\.\/elith-intake'/g, "from './ra-intake.mjs'")
    .replace(/from '\.\/s3'/g, "from './ra-s3.mjs'"));
  if (!/ra-adapter/.test(body) || !/ra-intake/.test(body) || !/ra-s3/.test(body)
      || !/report-fingerprint\.mjs/.test(body)) {
    fails.push('verify: import の差し替えに失敗 (import 文の形が変わった)');
  }
  const out = resolve(CACHE, 'ra-lib.mjs');
  writeFileSync(out, body);
  return {
    lib: await import(out),
    adapter: await import(resolve(CACHE, 'ra-adapter.mjs')),
    s3: await import(resolve(CACHE, 'ra-s3.mjs')),
    intake: await import(resolve(CACHE, 'ra-intake.mjs')),
  };
})();

/** Supabase スタブ。**書き込みを全部記録する** (「失敗したら 1 バイトも変えない」の検査用)。 */
function makeSb(rows, opts = {}) {
  const state = { rows: new Map(rows.map((r) => [r.id, { ...r }])), writes: [], selectFails: opts.selectFails ?? null };
  const api = (table) => {
    const q = { table, filters: [], cols: '', _order: null, _limit: null };
    const self = {
      select(cols) { q.cols = cols; return self; },
      eq(k, v) { q.filters.push([k, v]); return self; },
      neq(k, v) { q.filters.push(['!' + k, v]); return self; },
      order() { return self; },
      limit() { return self; },
      then(res) { return Promise.resolve(run()).then(res); },
      async maybeSingle() { const r = await run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      update(values) { q.op = 'update'; q.values = values; return self; },
    };
    const matches = (row) => q.filters.every(([k, v]) =>
      k.startsWith('!') ? row[k.slice(1)] !== v : row[k] === v);
    async function run() {
      if (state.selectFails && q.cols && q.cols.includes(state.selectFails)) {
        return { data: null, error: { message: `column ${state.selectFails} does not exist` } };
      }
      const project = (row) => {
        if (!q.cols || q.cols.trim() === '*') return { ...row };
        const out = {};
        for (const c of q.cols.split(',').map((x) => x.trim()).filter(Boolean)) {
          if (c in row) out[c] = row[c];
        }
        return out;
      };
      const hits = [...state.rows.values()].filter(matches);
      if (q.op === 'update') {
        if (hits.length === 0) return { data: [], error: null };
        for (const h of hits) {
          state.writes.push({ op: 'update', table: q.table, id: h.id, values: q.values });
          Object.assign(state.rows.get(h.id), q.values);
        }
        return { data: hits.map((h) => ({ ...state.rows.get(h.id) })), error: null };
      }
      return { data: hits.map(project), error: null };
    }
    return self;
  };
  return { schema: () => ({ from: api }), __state: state };
}

const baseRow = (over = {}) => ({
  id: R1, diagnostic_user_id: U1, diagnostic_id: 'd1',
  received_at: '2026-09-16T00:00:00.000Z', status: 'received',
  schema_version: 'elith-v2.0', source_key: FOLDER,
  report: { abstract: { text: 'x' } }, checkup_values: { health_checkup: {} },
  report_pdf_url: null, publish_status: 'pending', approved_at: null, approved_by: null, publish_rev: 0,
  approved_report_hash: null,
  ...over,
});

const IDENT = 'A'.repeat(43);

/* ══════════════════════════════════════════════════════════════════════
   ① migration — 既存の公開中の報告書を導入時に消さない (受入条件 1)
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n① migration (既存行を未承認にしない)\n');
{
  const mig = read('supabase/migrations/20261007000010_diagnosis_report_approval.sql');
  const addIdx = mig.indexOf('add column if not exists publish_status');
  const updIdx = mig.indexOf("set publish_status = 'approved'");
  const defIdx = mig.indexOf("alter column publish_status set default 'pending'");
  ok('publish_status を足している', addIdx > 0);
  ok('**既定を付けずに足す** (付けると既存全件が pending になる)',
    !/add column if not exists publish_status\s+text\s+not null/i.test(mig)
    && !/add column if not exists publish_status[^,;]*default/i.test(mig));
  ok('既存行を approved で埋める', updIdx > 0);
  ok('**埋めるのは既定を pending にする前**', updIdx > addIdx && updIdx < defIdx,
    `add=${addIdx} update=${updIdx} default=${defIdx}`);
  ok('以後の既定は pending', defIdx > 0);
  ok('CHECK は pending / approved の 2 値', /check \(publish_status in \('pending', 'approved'\)\)/.test(mig));
  ok('approved_by / approved_at / publish_rev も足している',
    /add column if not exists approved_at/.test(mig)
    && /add column if not exists approved_by/.test(mig)
    && /add column if not exists publish_rev/.test(mig));
  ok('**既存の `status` を書き換えない** (世代管理を壊さない)',
    !/update diagnosis\.diagnosis_results[\s\S]{0,200}set status/i.test(mig));
  ok('**migration で報告書を一括再生成しない**', !/insert into/i.test(mig));
  ok('migration 番号が既存の最後より後', '20261007000010' > '20261001000010');
}

/* ══════════════════════════════════════════════════════════════════════
   ② isApprovedRow — 列が無い環境で公開中の報告書を落とさない
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n② 承認済の判定\n');
{
  const f = M.lib.isApprovedRow;
  eq('approved は見せる', f({ publish_status: 'approved' }), true);
  eq('pending は見せない', f({ publish_status: 'pending' }), false);
  eq('列が無い (undefined) = 承認済相当 (migration 未適用で消さない)', f({}), true);
  eq('null も承認済相当', f({ publish_status: null }), true);
  eq('行が無ければ false', f(null), false);
  eq('知らない値は見せない (fail-closed)', f({ publish_status: 'draft' }), false);
}

/* ══════════════════════════════════════════════════════════════════════
   ③ 再作成できる行の判定 (トランスコスモス 10 名を巻き込まない)
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n③ 再作成できる行\n');
{
  const r = M.lib.recreatability;
  eq('Elith 下りの行は再作成できる', r({ source_key: FOLDER, report: {} }).recreatable, true);
  eq('手動アップロード (受領 JSON が DB にある) も再作成できる',
    r({ source_key: null, report: { abstract: {} } }).recreatable, true);
  /*
   * **`report` が空だから止まった**のでは検査にならない (退行注入 4 で実証: 完成済み PDF の
   * 判定を外しても `report: []` の方で止まるので素通りした)。**中身のある PDF 行**で見る。
   */
  const pdfRow = { schema_version: 'manual-pdf-v1', source_key: `manual:transcosmos:20260928:${U1}`,
    report: { abstract: { text: 'x' } }, report_pdf_url: 'manual/transcosmos/x.pdf' };
  eq('**完成済み PDF の行は、受領 JSON の形に関係なく再作成しない**', r(pdfRow).recreatable, false);
  ok('  理由が「PDF の行だから」であること',
    /PDF/.test(r(pdfRow).reason ?? ''), r(pdfRow).reason ?? '(理由なし)');
  eq('  schema_version だけでも止まる',
    r({ schema_version: 'manual-pdf-v1', source_key: null, report: { a: 1 } }).recreatable, false);
  eq('  source_key だけでも止まる',
    r({ schema_version: 'elith-v2.0', source_key: `manual:transcosmos:20260928:${U1}`, report: { a: 1 } }).recreatable, false);
  eq('材料が何も無い行は再作成しない', r({ source_key: null, report: [] }).recreatable, false);
  eq('理由を必ず添える', typeof r({ source_key: null, report: [] }).reason, 'string');

  const e = M.lib.isElithOutputFolder;
  eq('下りのフォルダだけを S3 読み取りの対象にする', e(FOLDER), true);
  eq('上り (user/…) は対象にしない', e(`user/${U1}/date/2026_09_16/`), false);
  eq('日付の形が違うものは対象にしない', e(`output/user/${U1}/date/20260916/`), false);
  eq('末尾 / が無いものは対象にしない', e(`output/user/${U1}/date/2026_09_16`), false);
  eq('UUID でないものは対象にしない', e('output/user/not-a-uuid/date/2026_09_16/'), false);
}

/* ══════════════════════════════════════════════════════════════════════
   ④ 承認 — pending かつ rev 一致のときだけ (受入条件 3 / 14)
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n④ 承認\n');
{
  const sb = makeSb([baseRow()]);
  const r = await M.lib.approveReport(sb, { resultId: R1, expectedRev: 0, approvedBy: IDENT });
  eq('承認できる', r.ok, true);
  eq('approved になる', sb.__state.rows.get(R1).publish_status, 'approved');
  ok('approved_at が入る', !!sb.__state.rows.get(R1).approved_at);
  eq('approved_by は digest をそのまま', sb.__state.rows.get(R1).approved_by, IDENT);

  const sb2 = makeSb([baseRow()]);
  const r2 = await M.lib.approveReport(sb2, { resultId: R1, expectedRev: 1, approvedBy: IDENT });
  eq('**rev が違えば承認しない** (確認していない紙面を承認しない)', r2.error, 'not_pending_or_changed');
  eq('  1 行も書かない', sb2.__state.writes.length, 0);

  const sb3 = makeSb([baseRow({ publish_status: 'approved' })]);
  const r3 = await M.lib.approveReport(sb3, { resultId: R1, expectedRev: 0, approvedBy: IDENT });
  eq('すでに承認済なら何もしない', r3.ok, false);
  eq('  1 行も書かない', sb3.__state.writes.length, 0);

  const sb4 = makeSb([baseRow()]);
  const r4 = await M.lib.approveReport(sb4, { resultId: 'not-a-uuid', expectedRev: 0, approvedBy: IDENT });
  eq('id の形が違えば DB を触らない', r4.error, 'invalid_result_id');
  eq('  1 行も書かない', sb4.__state.writes.length, 0);

  const sb5 = makeSb([baseRow()]);
  await M.lib.approveReport(sb5, { resultId: R1, expectedRev: 0, approvedBy: 'admin@example.com' });
  eq('**生のメールアドレスは approved_by に入らない**', sb5.__state.rows.get(R1).approved_by, null);

  // ── 承認した紙面の指紋 (仕様書 §3.3) ──────────────────────────
  {
    M.adapter.setVm(M.adapter.makeVm('承認したときの本文'));
    const sbh = makeSb([baseRow()]);
    const r = await M.lib.approveReport(sbh, { resultId: R1, expectedRev: 0, approvedBy: IDENT });
    const row = sbh.__state.rows.get(R1);
    ok('**承認で紙面の指紋を控える** (SHA-256 16進 64文字)',
      /^[0-9a-f]{64}$/.test(String(row.approved_report_hash)), String(row.approved_report_hash));
    eq('  応答にも同じ指紋を返す', r.approvedReportHash, row.approved_report_hash);
    eq('  承認と指紋は**同じ 1 本の update**', sbh.__state.writes.length, 1);
    const vals = sbh.__state.writes[0].values;
    ok('  その 1 本に publish_status と指紋が同居している',
      vals.publish_status === 'approved' && /^[0-9a-f]{64}$/.test(String(vals.approved_report_hash)));
    eq('  何を承認したかを返す (章/検査値の件数)', [r.approved?.sections, r.approved?.measurements], [1, 3]);

    // 生成ロジックが変わった = 紙面が変わった → 公開しない
    const approvedRow = { ...row };
    eq('承認した紙面と同じなら公開する', await M.lib.isPubliclyVisibleRow(approvedRow), true);
    M.adapter.setVm(M.adapter.makeVm('デプロイ後に変わった本文'));
    eq('**紙面が変わったら公開しない** (approved のままでも)',
      await M.lib.isPubliclyVisibleRow(approvedRow), false);
    eq('  publish_status は approved のまま (DB は書き換えない)', approvedRow.publish_status, 'approved');

    // 指紋が無い行 (migration で移行した既存行) は従来どおり公開
    eq('**指紋が無い承認済行は公開する** (既存の公開を落とさない)',
      await M.lib.isPubliclyVisibleRow({ ...approvedRow, approved_report_hash: null }), true);
    eq('  列ごと無い環境でも公開する',
      await M.lib.isPubliclyVisibleRow(
        { publish_status: 'approved', report: {}, received_at: '2026-09-16' }), true);
    eq('  未承認は指紋があっても公開しない',
      await M.lib.isPubliclyVisibleRow({ ...approvedRow, publish_status: 'pending' }), false);

    // 列が無い環境では承認しない (指紋を書けない = ゲートが効かない)
    const noCol = (() => { const b = baseRow(); delete b.publish_status; return b; })();
    const sbn = makeSb([noCol]);
    const rn = await M.lib.approveReport(sbn, { resultId: R1, expectedRev: 0, approvedBy: IDENT });
    eq('**承認用の列が無ければ承認しない**', rn.error, 'migration_required');
    eq('  DB を 1 度も書かない', sbn.__state.writes.length, 0);

    // 紙面が組めない回は承認しない
    M.adapter.setThrow(true);
    const sbt = makeSb([baseRow()]);
    const rt = await M.lib.approveReport(sbt, { resultId: R1, expectedRev: 0, approvedBy: IDENT });
    eq('紙面が組めない回は承認しない', rt.error, 'fingerprint_failed');
    eq('  DB を 1 度も書かない', sbt.__state.writes.length, 0);
    M.adapter.setThrow(false);
    M.adapter.setVm(M.adapter.makeVm('原文'));
  }
  eq('  safeApprovedBy は digest だけ通す', M.lib.safeApprovedBy(IDENT), IDENT);
  eq('  43 文字でないものは通さない', M.lib.safeApprovedBy('A'.repeat(42)), null);
  eq('  氏名も通さない', M.lib.safeApprovedBy('山田太郎'), null);
}

/* ══════════════════════════════════════════════════════════════════════
   ⑤ 再作成 — 成功時は上書き + pending (受入条件 4 / 5 / 13)
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n⑤ 再作成 (成功)\n');
{
  M.adapter.setThrow(false);
  M.adapter.setVm({ audit: { sections: ['a', 'b'], measurementCount: 7, topicCount: 3, digestCards: ['d'] } });
  M.s3.setS3(true, [`${FOLDER}report_text.json`, `${FOLDER}health_checkup.json`]);
  M.intake.setMaterial({ report: { s3: true }, checkup: { health_checkup: { x: [] } }, schemaVersion: 'elith-v2.0' });

  /*
   * **指紋を持った承認済の行から始める。** 指紋なしの行で試すと、
   * 「null へ戻す」コードを消しても元から null なので退行が検出できない
   * (退行注入 20 で実証)。
   */
  const sb = makeSb([baseRow({
    publish_status: 'approved', approved_at: '2026-09-20T00:00:00.000Z', approved_by: IDENT,
    publish_rev: 0, approved_report_hash: 'a'.repeat(64),
  })]);
  const r = await M.lib.recreateReport(sb, { resultId: R1 });
  eq('再作成できる', r.ok, true);
  eq('材料は S3 から取り直す', r.source, 's3');
  const row = sb.__state.rows.get(R1);
  eq('**pending に戻る**', row.publish_status, 'pending');
  eq('approved_at を消す', row.approved_at, null);
  eq('approved_by を消す', row.approved_by, null);
  eq('**承認した紙面の指紋も消す**', row.approved_report_hash, null);
  eq('publish_rev が進む', row.publish_rev, 1);
  eq('受領 JSON を上書きする', row.report, { s3: true });
  eq('検査値も上書きする', row.checkup_values, { health_checkup: { x: [] } });
  eq('**行は増えない** (履歴レコードを作らない)', sb.__state.rows.size, 1);
  eq('**insert を 1 度も呼ばない**', sb.__state.writes.filter((w) => w.op !== 'update').length, 0);
  eq('上書きと pending 化は**同じ 1 本の update**', sb.__state.writes.length, 1);
  const vals = sb.__state.writes[0].values;
  ok('  その 1 本に report と publish_status が同居している',
    'report' in vals && vals.publish_status === 'pending' && vals.approved_at === null);
  eq('生成は本番と同じ buildReportVM を通る', M.adapter.__calls.length > 0, true);

  // 手動アップロードの行 = DB の受領 JSON を材料にする
  const sb2 = makeSb([baseRow({ source_key: null, publish_status: 'approved', publish_rev: 2 })]);
  const r2 = await M.lib.recreateReport(sb2, { resultId: R1 });
  eq('手動アップロードの行も再作成できる', r2.ok, true);
  eq('  材料は DB の控え', r2.source, 'stored');
  eq('  pending に戻る', sb2.__state.rows.get(R1).publish_status, 'pending');
  eq('  rev が進む', sb2.__state.rows.get(R1).publish_rev, 3);

  // 未承認の行を再作成しても pending のまま (受入条件 4)
  const sb3 = makeSb([baseRow({ publish_status: 'pending' })]);
  const r3 = await M.lib.recreateReport(sb3, { resultId: R1 });
  eq('未承認の行を再作成しても pending のまま', r3.ok && sb3.__state.rows.get(R1).publish_status === 'pending', true);
}

/* ══════════════════════════════════════════════════════════════════════
   ⑥ 再作成 — 失敗したら 1 バイトも変えない (受入条件 6・最重要)
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n⑥ 再作成 (失敗しても公開中の報告書を壊さない)\n');
{
  const approved = () => baseRow({
    publish_status: 'approved', approved_at: '2026-09-20T00:00:00.000Z', approved_by: IDENT,
    publish_rev: 1, approved_report_hash: 'f'.repeat(64),
  });
  const intact = (sb, label) => {
    const row = sb.__state.rows.get(R1);
    eq(`${label}: 承認済のまま`, row.publish_status, 'approved');
    eq(`${label}: approved_at が残る`, row.approved_at, '2026-09-20T00:00:00.000Z');
    eq(`${label}: 報告書の中身が残る`, row.report, { abstract: { text: 'x' } });
    eq(`${label}: 承認した指紋が残る`, row.approved_report_hash, 'f'.repeat(64));
    eq(`${label}: DB を 1 度も書かない`, sb.__state.writes.length, 0);
  };

  // 生成処理が例外
  M.s3.setS3(true, [`${FOLDER}report_text.json`, `${FOLDER}health_checkup.json`]);
  M.adapter.setThrow(true);
  let sb = makeSb([approved()]);
  let r = await M.lib.recreateReport(sb, { resultId: R1 });
  eq('生成が落ちたら失敗', r.error, 'generate_failed');
  intact(sb, '生成エラー');
  M.adapter.setThrow(false);

  // 生成は通ったが中身が空 → 上書きしない
  M.adapter.setVm({ audit: { sections: [], measurementCount: 0, topicCount: 0, digestCards: [] } });
  sb = makeSb([approved()]);
  r = await M.lib.recreateReport(sb, { resultId: R1 });
  eq('**生成結果が空なら上書きしない**', r.error, 'generated_empty');
  intact(sb, '空の生成結果');
  M.adapter.setVm({ audit: { sections: ['a'], measurementCount: 3, topicCount: 1, digestCards: ['d'] } });

  // S3 が読めない
  M.s3.setS3(true, [], true);
  sb = makeSb([approved()]);
  r = await M.lib.recreateReport(sb, { resultId: R1 });
  eq('S3 が読めなければ失敗', r.error, 'source_read_failed');
  intact(sb, 'S3 読み取りエラー');

  // 元のフォルダが無い
  M.s3.setS3(true, []);
  sb = makeSb([approved()]);
  r = await M.lib.recreateReport(sb, { resultId: R1 });
  eq('元の受領 JSON が無ければ失敗', r.error, 'source_not_found');
  intact(sb, '元データなし');

  // 揃っていない (ファイル 1 個 / report_text.json が無い)
  M.s3.setS3(true, [`${FOLDER}health_checkup.json`]);
  sb = makeSb([approved()]);
  r = await M.lib.recreateReport(sb, { resultId: R1 });
  eq('ファイルが 1 個なら失敗 (先方の処理途中)', r.error, 'source_incomplete');
  intact(sb, 'ファイル 1 個');

  M.s3.setS3(true, [`${FOLDER}health_checkup.json`, `${FOLDER}blood_test.json`]);
  sb = makeSb([approved()]);
  r = await M.lib.recreateReport(sb, { resultId: R1 });
  eq('report_text.json が無ければ失敗', r.error, 'source_incomplete');
  intact(sb, 'report_text.json なし');

  // S3 未設定
  M.s3.setS3(false, []);
  sb = makeSb([approved()]);
  r = await M.lib.recreateReport(sb, { resultId: R1 });
  eq('S3 未設定なら失敗 (DB の控えへ黙って落ちない)', r.error, 's3_not_configured');
  intact(sb, 'S3 未設定');
  M.s3.setS3(true, [`${FOLDER}report_text.json`, `${FOLDER}health_checkup.json`]);

  // トランスコスモス 10 名
  sb = makeSb([baseRow({
    id: R1, schema_version: 'manual-pdf-v1', source_key: `manual:transcosmos:20260928:${U1}`,
    // **中身を入れておく** — 空で止まったのでは「PDF の行だから止めた」ことの検査にならない。
    report: { abstract: { text: 'x' } }, report_pdf_url: 'manual/transcosmos/x.pdf',
    publish_status: 'approved', approved_at: '2026-09-20T00:00:00.000Z', publish_rev: 0,
  })]);
  r = await M.lib.recreateReport(sb, { resultId: R1 });
  eq('**完成済み PDF の行は再作成しない**', r.error, 'not_recreatable');
  ok('  理由が「PDF の行だから」であること', /PDF/.test(r.detail ?? ''), r.detail ?? '(理由なし)');
  eq('  承認済のまま', sb.__state.rows.get(R1).publish_status, 'approved');
  eq('  DB を 1 度も書かない', sb.__state.writes.length, 0);

  // migration 未適用 (publish_status が無い行)
  sb = makeSb([(() => { const b = baseRow(); delete b.publish_status; return b; })()]);
  r = await M.lib.recreateReport(sb, { resultId: R1 });
  eq('承認用の列が無ければ再作成しない', r.error, 'migration_required');
  eq('  DB を 1 度も書かない', sb.__state.writes.length, 0);

  // 処理中に別の再作成が入った (rev が進んだ)
  sb = makeSb([approved()]);
  const orig = sb.schema().from;
  r = await M.lib.recreateReport({
    schema: () => ({
      from: (t) => {
        const q = orig(t);
        const upd = q.update;
        q.update = (v) => { sb.__state.rows.get(R1).publish_rev = 99; return upd(v); };
        return q;
      },
    }),
  }, { resultId: R1 });
  eq('処理中に rev が進んだら書かない', r.error, 'changed_during_recreate');

  // 対象が無い
  sb = makeSb([]);
  r = await M.lib.recreateReport(sb, { resultId: R2 });
  eq('対象が無ければ not_found', r.error, 'not_found');
  eq('  DB を 1 度も書かない', sb.__state.writes.length, 0);
}

/* ══════════════════════════════════════════════════════════════════════
   ⑦ 一覧 — 最新世代だけ / 列が無い環境を 0 件と混同しない
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n⑦ 一覧\n');
{
  const rows = [
    baseRow({ id: R1, publish_status: 'pending' }),
    baseRow({ id: R2, publish_status: 'approved', status: 'superseded' }),
  ];
  const sb = makeSb(rows);
  const r = await M.lib.listReportsForApproval(sb, { status: 'pending' });
  eq('未承認だけ返る', r.rows.map((x) => x.id), [R1]);
  eq('**superseded (過去版) は出さない**', r.rows.some((x) => x.id === R2), false);
  eq('rev を返す (承認の条件付き更新に使う)', r.rows[0].publishRev, 0);
  eq('再作成できるかを返す', r.rows[0].recreatable, true);
  eq('migration 適用済', r.migrationApplied, true);
  eq('未承認の行の指紋は見ない', r.rows[0].hashState, 'none');
  ok('**氏名を返さない**', !JSON.stringify(r.rows).includes('name'));

  const sb2 = makeSb([baseRow()], { selectFails: 'publish_status' });
  const r2 = await M.lib.listReportsForApproval(sb2, { status: 'approved' });
  eq('列が無い環境でも引ける', r2.ok, true);
  eq('  **「未適用」を伝える** (0 件と混同させない)', r2.migrationApplied, false);
  eq('  全件 approved 相当', r2.rows.map((x) => x.publishStatus), ['approved']);

  const r3 = await M.lib.listReportsForApproval(null, {});
  eq('Supabase 未設定は ok:false (0 件にしない)', r3.ok, false);
}

/* ══════════════════════════════════════════════════════════════════════
   ⑧ ユーザー側の境界 — 絞り忘れは画面を見ても分からない
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n⑧ ユーザー向け取得経路の承認ゲート\n');
{
  const q = code('src/lib/elith-report-queries.ts');
  ok('loadReportVM が publish_status と指紋を引いている',
    /publish_status/.test(q) && /approved_report_hash/.test(q));
  ok('loadReportVM が**合成ゲート**を通している (承認状態 + 指紋)',
    /includeUnapproved[\s\S]{0,80}isPubliclyVisibleRow\(row, vm\)/.test(q));
  ok('  組み上がった VM を渡している (二度組まない)',
    /const vm = buildReportVM\(/.test(q) && /isPubliclyVisibleRow\(row, vm\)/.test(q));
  ok('  ゲートは VM を組んだ**あと** (指紋を取る相手が要る)',
    q.indexOf('const vm = buildReportVM(') < q.indexOf('isPubliclyVisibleRow(row, vm)'));
  ok('既定は承認済だけ (`includeUnapproved?` は任意 = fail-closed)',
    /includeUnapproved\?: boolean/.test(read('src/lib/elith-report-queries.ts')));

  const d = code('src/lib/dashboard-queries.ts');
  ok('loadDashboard が latestResult を合成ゲートで絞っている',
    /resultsRaw[\s\S]{0,200}isPubliclyVisibleRow/.test(d));
  ok('  既定は false (引数を渡さない呼び出しは承認済だけ)',
    /includeUnapprovedReport = false/.test(d));
  ok('**承認状態と指紋の合成は 1 本だけ** (各経路で組み直さない)',
    /export async function isPubliclyVisibleRow/.test(code('src/lib/report-approval.ts'))
    && !/hashGateOk/.test(q) && !/hashGateOk/.test(d),
    '表示経路が hashGateOk を直接呼んでいる');

  const rr = code('src/pages/api/report-route.ts');
  ok('report-route (PDF の署名 URL) が承認済だけ通している', /isApprovedRow/.test(rr));
  /*
   * **import 行を数えない** (退行注入 10 で実証: チェックを署名発行の後ろへ動かしても、
   * 先頭の `import { isApprovedRow }` に当たって素通りした)。**呼び出しの位置**を見る。
   */
  ok('  署名の発行より手前で止めている',
    rr.indexOf('!isApprovedRow(') > 0 && rr.indexOf('!isApprovedRow(') < rr.indexOf('getOriginalSignedUrl('),
    `判定 ${rr.indexOf('!isApprovedRow(')} / 署名発行 ${rr.indexOf('getOriginalSignedUrl(')}`);

  for (const [p, label] of [
    ['src/lib/coach-context.ts', 'AI コーチ'],
    ['src/lib/chat-context.ts', 'AI 問診'],
    ['src/lib/result-queries.ts', '検査結果ページ (3 モード)'],
  ]) {
    ok(`${label} も承認済だけ読む`, /isApprovedRow/.test(code(p)));
  }

  const rep = code('src/pages/report.astro');
  ok('/report が未承認を見せるのは admin のときだけ',
    /includeUnapproved: viewer\.isAdmin/.test(rep));
  ok('  ダッシュボードも同じ条件で latestResult を渡している',
    /loadDashboard\(u, viewer\.origin, viewer\.isAdmin\)/.test(code('src/pages/dashboard.astro')));
  ok('**CSS / JS で隠していない** (display:none で未承認を隠す実装を作らない)',
    !/pending[\s\S]{0,40}display:\s*none/i.test(read('src/pages/report.astro')));
}

/* ══════════════════════════════════════════════════════════════════════
   ⑨ API と管理画面の形
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n⑨ API / 管理画面\n');
{
  for (const f of ['list', 'approve', 'recreate']) {
    ok(`${f} API が管理者認可を通している`, /isAdminAuthorized\(request\)/.test(code(`src/pages/api/admin/report-approval/${f}.ts`)));
  }
  const rec = code('src/pages/api/admin/report-approval/recreate.ts');
  ok('再作成 API が受け取るのは resultId だけ',
    /body\.resultId/.test(rec) && !/body\.(sourceKey|report|checkup|s3Key|objectKey)/.test(rec));
  ok('**一括再作成の API を作っていない**',
    !/resultIds|\[\]\s*=\s*body|body\.ids/.test(rec));

  const ap = code('src/pages/api/admin/report-approval/approve.ts');
  ok('承認 API は digest を自分で作る (中継に作らせない)', /adminIdentity\(/.test(ap));

  const relay = code('/home/user/wellfort-site/src/pages/api/admin/report-approval/[action].ts'.replace(ROOT + '/', ''));
  ok('中継が admin を確認している', /verifyAdmin\(request\)/.test(relay));
  ok('中継の action は allow-list', /ALLOWED_GET|ALLOWED_POST/.test(relay));
  ok('中継はサーバ検証済みの email だけを送る',
    /payload\.triggeredByEmail = admin\.email/.test(relay)
    && !/body\.triggeredByEmail/.test(relay));
  ok('中継が body を素通ししない', /const payload: Record<string, unknown> = \{ resultId \}/.test(relay));
  ok('**鍵をブラウザへ出さない**', !/PUBLIC_SCAN_CHAT_AI/.test(relay));

  const page = read('/home/user/wellfort-site/src/pages/admin/report-approval.astro');
  ok('管理画面は 1 枚 (未承認/承認済 の切替)', /ra-tab-pending/.test(page) && /ra-tab-approved/.test(page));
  ok('行にチェックボックスがある', /ra-pick/.test(page));
  ok('確認・承認・再作成のボタンがある',
    /data-open/.test(page) && /data-approve/.test(page) && /data-recreate/.test(page));
  ok('複数再作成に確認ダイアログがある', /件の報告書を、現在の最新版生成処理で再作成します/.test(page));
  ok('**1 件用 API を順番に叩いている** (一括 API を呼ばない)',
    /for \(var i = 0; i < ids\.length; i\+\+\)/.test(page) && /report-approval\/recreate/.test(page));
  ok('成功件数 / 失敗件数 / 失敗理由を出す', /成功 ' \+ okIds\.length \+ ' 件 \/ 失敗 '/.test(page));
  ok('処理中は重複操作を防いでいる', /running = true/.test(page) && /busy\[id\]/.test(page));
  ok('確認は本番の画面を代理表示で開く (報告書を再実装しない)',
    /impersonation-handoff/.test(page));
  ok('承認は一覧で見た rev を渡す', /expectedRev: r\.publishRev/.test(page));
  ok('**「紙面が変わった（非公開）」を行に出す** (承認済なのに出ない理由を admin が辿れる)',
    /hashState === 'mismatch'/.test(page) && /紙面が変わった/.test(page));
  ok('  まとめても出す', /hashState === 'mismatch'; \}\).length/.test(page));
  ok('  公開中の行には「公開中」と出す', /hashState === 'match'/.test(page) && /公開中/.test(page));
  ok('メニューに載っている', /report-approval/.test(read('/home/user/wellfort-site/src/components/AdminLayout.astro')));
}

/* ══════════════════════════════════════════════════════════════════════
   ⑩ 既存の取り込みを壊していない
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n⑩ 既存の取り込み\n');
{
  const ing = code('src/lib/elith-report-ingest.ts');
  ok('取り込みは publish_status を明示しない (DB の既定 pending に任せる)',
    !/publish_status/.test(ing));
  ok('  世代管理 (superseded) はそのまま', /status:\s*'received'/.test(ing) && /'superseded'/.test(ing));
  const intake = code('src/lib/elith-intake.ts');
  ok('S3 の読み取りが 1 つの関数に集約された', /export async function readFolderMaterial/.test(intake));
  ok('  runElithIntake がその関数を使っている', /await readFolderMaterial\(folder, e\.files\)/.test(intake));
  ok('  読み方を 2 つ持っていない',
    (intake.match(/classifyFile\(name\)/g) || []).length === 1);
}


/* ══════════════════════════════════════════════════════════════════════
   ⑪ 指紋の性質 — **本物のアダプタ**で見る (ここが機能の成立条件)
   ══════════════════════════════════════════════════════════════════════
   スタブ VM では「配線」しか見られない。正規化そのものの性質は実物でないと
   意味がないので、`report-adapter` / `report-sections` / `report-view` /
   `standard-master` / `report-fingerprint` を transpile して動かす
   (app_config だけスタブ = DB も鍵も要らない)。

   **最重要 = 文脈非依存**: 承認 API は閲覧者の文脈 (氏名・実年齢・第 N 回・
   がんリスク検査の有無) を持たない。指紋が文脈に依存したら、承認側の指紋と
   表示側の指紋が永久に一致せず**承認済みの報告書が全件消える**。
   ══════════════════════════════════════════════════════════════════════ */
console.log('\n⑪ 指紋の性質 (本物のアダプタ)\n');
{
  const RF = await (async () => {
    const stub = (name, src) => writeFileSync(resolve(CACHE, name), src);
    // app_config は読み取り関数だけ差し替える (DB を触らない)。
    stub('app-config.mjs', `
export let __cfg = {};
export const setCfg = (v) => { __cfg = v; };
export const cfg = (k) => __cfg[k] ?? '';
export const refreshConfig = async () => {};
`);
    const fix = (src) => src
      .replace(/from '\.\/app-config'/g, "from './app-config.mjs'")
      .replace(/from '\.\/report-sections'/g, "from './report-sections.mjs'")
      .replace(/from '\.\/report-view'/g, "from './report-view.mjs'")
      .replace(/from '\.\/standard-master'/g, "from './standard-master.mjs'")
      .replace(/from '\.\/report-adapter'/g, "from './report-adapter.mjs'")
      .replace(/from '\.\/elith-parser'/g, "from './elith-parser.mjs'")
      .replace(/from '\.\/report-model'/g, "from './report-model.mjs'");
    stub('elith-parser.mjs', 'export {};\n');
    stub('report-model.mjs', 'export {};\n');
    for (const f of ['report-sections', 'report-view', 'standard-master', 'report-adapter',
                     'report-fingerprint']) {
      stub(`${f}.mjs`, js(fix(read(`src/lib/${f}.ts`))));
    }
    return {
      fp: await import(resolve(CACHE, 'report-fingerprint.mjs')),
      ad: await import(resolve(CACHE, 'report-adapter.mjs')),
      cfg: await import(resolve(CACHE, 'app-config.mjs')),
    };
  })();

  const reportText = JSON.parse(read('src/data/elith/report_text_20260826.json'));
  const checkup = JSON.parse(read('src/data/elith/health_checkup_20260826.json'));
  const base = { reportText, checkup, issuedOn: '2026-08-26' };
  const build = (over = {}) => RF.ad.buildReportVM({ ...RF.fp.FINGERPRINT_CONTEXT, ...base, ...over });
  const fp = (vm) => RF.fp.reportFingerprint(vm);

  const neutral = await fp(build());
  ok('本物の受領 JSON で指紋が取れる', /^[0-9a-f]{64}$/.test(neutral), neutral);
  eq('同じ入力なら同じ指紋 (決定論)', await fp(build()), neutral);

  /* ── 文脈を変えても指紋は変わらない (承認側 == 表示側) ── */
  const wild = await fp(build({
    name: '相川 佳之様', isSample: true, hasCancerRisk: true, cycleSeq: 3,
    chronologicalAge: 54, ourWellnessAge: 58,
  }));
  eq('**閲覧者の文脈を全部変えても指紋は同じ**', wild, neutral);
  for (const [label, over] of [
    ['氏名', { name: '別の人様' }],
    ['実年齢 (誕生日を越えた)', { chronologicalAge: 56 }],
    ['第 N 回 (サイクルが進んだ)', { cycleSeq: 4 }],
    ['がんリスク検査の有無 (reportType)', { hasCancerRisk: true }],
    ['サンプル表示', { isSample: true }],
    ['当社 CABA の値', { ourWellnessAge: 56 }],
  ]) eq(`  ${label} が変わっても同じ`, await fp(build(over)), neutral);

  /* ── 紙面の中身が変われば指紋は変わる ── */
  const firstKey = Object.keys(reportText).find((k) => reportText[k]?.text);
  const edited = structuredClone(reportText);
  edited[firstKey].text = `${edited[firstKey].text}。`;   // 句点 1 文字だけ足す
  ok('**本文を 1 文字変えると指紋が変わる**',
    (await fp(build({ reportText: edited }))) !== neutral);

  const editedLab = structuredClone(checkup);
  const labKey = Object.keys(editedLab)[0];
  if (Array.isArray(editedLab[labKey]) && editedLab[labKey][0]) {
    editedLab[labKey][0].value = `${editedLab[labKey][0].value} `;
    ok('検査値を変えると指紋が変わる', (await fp(build({ checkup: editedLab }))) !== neutral);
  }

  /* ── app_config (章立て) も紙面を決めるので対象に入る ── */
  RF.cfg.setCfg({ 'report.sections.hidden': 'lifestyle' });
  const hidden = await fp(build());
  ok('**章を隠すと指紋が変わる** (app_config も対象)', hidden !== neutral);
  RF.cfg.setCfg({ 'report.sections.labels': 'summary=別の見出し' });
  ok('見出しを変えると指紋が変わる', (await fp(build())) !== neutral);
  RF.cfg.setCfg({ 'report.sections.collapsed': 'summary' });
  ok('開閉を変えると指紋が変わる', (await fp(build())) !== neutral);
  RF.cfg.setCfg({});
  eq('app_config を戻せば指紋も戻る', await fp(build()), neutral);

  /* ── 対象外にした値が指紋に出ていないこと (正規化の中身を直接見る) ── */
  /*
   * **本文に偶然現れない値を使う。** `54` のような普通の数字で部分一致を見ると
   * 本文中の「54歳」等に当たって必ず落ちる (`verify:report-verbatim` で踏んだのと同じ罠)。
   */
  const canon = JSON.stringify(RF.fp.canonicalizeReport(build({
    name: '照合用ノ氏名ZZQ', chronologicalAge: 1234567, ourWellnessAge: 7654321, cycleSeq: 987654,
  })));
  for (const [label, needle] of [
    ['氏名', '照合用ノ氏名ZZQ'], ['実年齢', '1234567'],
    ['ウェルネス年齢の補完値', '7654321'], ['第 N 回', '987654'],
  ]) ok(`正規化に ${label} が入っていない`, !canon.includes(needle));
  ok('正規化に本文は入っている', canon.includes(String(reportText[firstKey].text).slice(0, 20)));
  ok('正規化の版が先頭に在る (形を変えたら全件再承認)',
    canon.startsWith(`[${RF.fp.FINGERPRINT_VERSION},`));

  /* ── 表示経路の文脈が指紋の対象へ漏れていないこと ── */
  ok('表示経路は `selfReported` を渡していない (渡すなら承認側にも同じ値が要る)',
    !/selfReported/.test(code('src/lib/elith-report-queries.ts')));
}

rmSync(CACHE, { recursive: true, force: true });
console.log('');
if (fails.length) {
  console.log(`❌ verify:report-approval — ${fails.length} 件 FAIL\n`);
  for (const f of fails) console.log(`   - ${f}`);
  process.exit(1);
}
console.log('✅ verify:report-approval — すべて PASS\n');
