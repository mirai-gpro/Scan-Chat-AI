/**
 * スキャン結果の保存 (`saveScanResult`) の回帰チェック。サーバ不要。
 *
 * 守りたい約束:
 *   ・アプリ内スキャンの行として保存される (source=user_upload / test_type=health_checkup)
 *   ・**確定 md が scan_md に入る** — これが検査結果ページの中身になる
 *   ・**測定値の書き込み口は persistMeasurements だけ** (insert では jsonb を書かない)。
 *     二重に書くと「納品と画面で値が違う」が起きる
 *   ・受診日を md から取り出せる (取れなければ今日)
 *
 * Supabase はスタブする。**何を保存しようとしたか**を捕まえて確かめる。
 */
import { saveScanResult } from '../src/lib/scan-persist';

const captured: Record<string, unknown> = {};
const sb = {
  schema: () => ({
    from: (table: string) => ({
      insert: (rows: Record<string, unknown>[]) => {
        if (table === 'test_artifacts') captured.insert = rows[0];
        if (table === 'measurement_values') captured.mv = rows;
        return {
          select: async () => ({ data: [{ id: 'art-1111' }], error: null }),
          then: (res: (v: { error: null }) => unknown) => res({ error: null }),
        };
      },
      update: (patch: Record<string, unknown>) => ({
        eq: async () => { captured.update = patch; return { error: null }; },
      }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
};

const md = [
  '## 検査結果報告書',
  '',
  '| No | 検査項目 | 検査項目詳細 | 読み取った値 | 単位 | 下限値 | 上限値 | 判定 | 備考 |',
  '|----|----------|--------------|--------------|------|--------|--------|------|------|',
  '| 1 | AST(GOT) | AST(GOT) | 22 | U/L | 10 | 40 | - | - |',
  '| 2 | ALT(GPT) | ALT(GPT) | 18 | U/L | 5 | 45 | - | - |',
  '| 3 | HbA1c | HbA1c | 5.4 | % | 4.6 | 6.2 | - | - |',
].join('\n');

const r = await saveScanResult(sb as never, {
  diagnosticUserId: 'd0000001-0000-0000-0000-000000000000',
  markdownClean: md,
  pageCount: 3,
});

const ins = (captured.insert ?? {}) as Record<string, unknown>;
const upd = (captured.update ?? {}) as Record<string, unknown>;
const cases: [string, boolean, string][] = [
  ['test_artifacts に insert した', !!captured.insert, ''],
  ['source = user_upload', ins.source === 'user_upload', String(ins.source)],
  ['test_type = health_checkup', ins.test_type === 'health_checkup', String(ins.test_type)],
  ['imported_by = user', ins.imported_by === 'user', String(ins.imported_by)],
  ['page_count が枚数どおり', ins.page_count === 3, String(ins.page_count)],
  ['scan_md に確定 md が入る', typeof ins.scan_md === 'string' && (ins.scan_md as string).includes('AST(GOT)'), ''],
  ['insert では measurements を書かない', ins.measurements === undefined, String(ins.measurements)],
  ['measurements(jsonb) は persistMeasurements が書く', Array.isArray(upd.measurements), ''],
  ['測定値 3 件を取り出せている', r.measurements === 3, String(r.measurements)],
  ['artifact id を返す', r.artifactId === 'art-1111', r.artifactId],
  ['受診日が YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(r.testDate), r.testDate],
];

/*
 * ── 受診日ガード (§4.3-1) ────────────────────────────────────────────────
 * スペシャルアカウントの複数年取り込みでは、受診日を読めなかった回
 * (`date_source: 'today'`) を保存しない。今日の日付で積むと別の年が同じ
 * date フォルダへ畳まれて Elith 納品が 1 年に潰れるため。
 * 上の `md` には日付トークンが無い = extractExamDate は today を返す。
 */
// (a) requireReadableDate なし = 通常の利用者 → today でも insert する (r は上で実行済み)。
const normalInsertedToday = !!captured.insert && r.dateSource === 'today' && !r.blocked;

// (b) requireReadableDate あり = today は保存せず差し戻す。
const capturedGuard: Record<string, unknown> = {};
const sbGuard = {
  schema: () => ({
    from: (table: string) => ({
      insert: (rows: Record<string, unknown>[]) => {
        if (table === 'test_artifacts') capturedGuard.insert = rows[0];
        return {
          select: async () => ({ data: [{ id: 'should-not-happen' }], error: null }),
          then: (res: (v: { error: null }) => unknown) => res({ error: null }),
        };
      },
    }),
  }),
};
const blocked = await saveScanResult(sbGuard as never, {
  diagnosticUserId: 'd0000001-0000-0000-0000-000000000000',
  markdownClean: md,
  pageCount: 1,
  requireReadableDate: true,
});

// (c) requireReadableDate あり + 受診日が読める md → 通常どおり insert する。
const capturedOk: Record<string, unknown> = {};
const sbOk = {
  schema: () => ({
    from: (table: string) => ({
      insert: (rows: Record<string, unknown>[]) => {
        if (table === 'test_artifacts') capturedOk.insert = rows[0];
        return {
          select: async () => ({ data: [{ id: 'art-2222' }], error: null }),
          then: (res: (v: { error: null }) => unknown) => res({ error: null }),
        };
      },
      update: () => ({ eq: async () => ({ error: null }) }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
};
const okDated = await saveScanResult(sbOk as never, {
  diagnosticUserId: 'd0000001-0000-0000-0000-000000000000',
  markdownClean: md + '\n\n受診日 2023-04-18',
  pageCount: 1,
  requireReadableDate: true,
});

cases.push(
  ['通常利用者 (gate なし) は today でも保存する', normalInsertedToday, `${r.dateSource}`],
  ['ガード: today の回は blocked を返す', blocked.blocked === 'exam_date_unreadable', String(blocked.blocked)],
  ['ガード: today の回は insert しない', capturedGuard.insert === undefined, ''],
  ['ガード: today の回は artifactId を作らない', blocked.artifactId === null, String(blocked.artifactId)],
  ['ガード: 受診日が読めれば通常どおり insert', !!capturedOk.insert && okDated.blocked === undefined, ''],
  ['ガード: 読めた受診日を採用 (today でない)', okDated.testDate === '2023-04-18', okDated.testDate],
);

let failed = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
