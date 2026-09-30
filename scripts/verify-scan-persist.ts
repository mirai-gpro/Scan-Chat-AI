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

/*
 * ── 同じ受診日の差し替え (2026-09-30・本田さんの重複報告) ────────────────
 *
 * `saveScanResult` は**無条件 insert** だったので、同じ回を送り直すたびに
 * `test_artifacts` が 1 行増えていた。複数年アップロードは
 * **受診日が読めなかった回の再アップロードが前提**なので必ず踏む。
 *
 * ここで見るのは 4 つ:
 *   ① 同日・同 source の既存行を **delete してから** insert する
 *   ② **原本のある行は delete せず superseded に落とす**
 *      (test_artifact_files は on delete cascade。消すと原本の記録ごと消える)
 *   ③ **`source='user_upload'` だけ**を対象にする (admin が入れた回を消さない)
 *   ④ **消してから入れる** 順序 (逆だと入れた直後の行を自分で消す)
 */
interface DedupCall { table: string; op: string; args: unknown[] }

function makeDedupSb(existing: { id: string }[], withFiles: string[]) {
  const calls: DedupCall[] = [];
  const filters: Record<string, unknown> = {};
  const schema = () => ({
    from: (table: string) => ({
      select: () => {
        const chain = {
          eq: (col: string, val: unknown) => { filters[`${table}.${col}`] = val; return chain; },
          in: async () => ({
            data: withFiles.map((id) => ({ test_artifact_id: id })), error: null,
          }),
          // `.eq()` を 4 つ重ねた後に await される (test_artifacts 側)
          then: (res: (v: unknown) => unknown) => res({ data: existing, error: null }),
        };
        return chain;
      },
      insert: (rows: Record<string, unknown>[]) => {
        calls.push({ table, op: 'insert', args: [rows[0]] });
        return {
          select: async () => ({ data: [{ id: 'art-new' }], error: null }),
          then: (res: (v: { error: null }) => unknown) => res({ error: null }),
        };
      },
      delete: () => ({
        in: async (col: string, ids: string[]) => {
          calls.push({ table, op: 'delete', args: [col, ids] });
          return { error: null };
        },
        eq: async () => ({ error: null }),
      }),
      update: (patch: Record<string, unknown>) => ({
        in: async (col: string, ids: string[]) => {
          calls.push({ table, op: 'update', args: [patch, ids] });
          return { error: null };
        },
        eq: async () => ({ error: null }),
      }),
    }),
  });
  return { sb: { schema }, calls, filters };
}

const datedMd = md + '\n\n受診日 2023-04-18';

// (d) 同じ受診日の既存行が 2 件 → どちらも消えてから 1 件 insert される。
{
  const { sb: sbDup, calls, filters } = makeDedupSb([{ id: 'old-1' }, { id: 'old-2' }], []);
  await saveScanResult(sbDup as never, {
    diagnosticUserId: 'd0000001-0000-0000-0000-000000000000',
    markdownClean: datedMd,
    pageCount: 1,
  });
  const del = calls.find((c) => c.table === 'test_artifacts' && c.op === 'delete');
  const ins = calls.findIndex((c) => c.table === 'test_artifacts' && c.op === 'insert');
  const delIdx = calls.findIndex((c) => c.table === 'test_artifacts' && c.op === 'delete');
  cases.push(
    ['差し替え: 同日の既存行を削除する', !!del, JSON.stringify(del?.args?.[1])],
    ['差し替え: 既存 2 件とも消す',
      JSON.stringify(del?.args?.[1]) === JSON.stringify(['old-1', 'old-2']), ''],
    ['差し替え: **消してから入れる**', delIdx >= 0 && ins >= 0 && delIdx < ins, `del@${delIdx} ins@${ins}`],
    ['差し替え: 対象は user_upload だけ', filters['test_artifacts.source'] === 'user_upload',
      String(filters['test_artifacts.source'])],
    ['差し替え: 受診日で絞る', filters['test_artifacts.test_date'] === '2023-04-18',
      String(filters['test_artifacts.test_date'])],
    ['差し替え: 本人だけ', filters['test_artifacts.diagnostic_user_id'] === 'd0000001-0000-0000-0000-000000000000', ''],
  );
}

// (e) 原本が付いている行は**消さず** superseded に落とす。
{
  const { sb: sbFiles, calls } = makeDedupSb([{ id: 'has-file' }, { id: 'plain' }], ['has-file']);
  await saveScanResult(sbFiles as never, {
    diagnosticUserId: 'd0000001-0000-0000-0000-000000000000',
    markdownClean: datedMd,
    pageCount: 1,
  });
  const del = calls.find((c) => c.table === 'test_artifacts' && c.op === 'delete');
  const upd = calls.find((c) => c.table === 'test_artifacts' && c.op === 'update');
  cases.push(
    ['原本あり: 削除対象から外す',
      JSON.stringify(del?.args?.[1]) === JSON.stringify(['plain']), JSON.stringify(del?.args?.[1])],
    ['原本あり: superseded に落とす',
      (upd?.args?.[0] as { status?: string })?.status === 'superseded'
      && JSON.stringify(upd?.args?.[1]) === JSON.stringify(['has-file']), JSON.stringify(upd?.args)],
  );
}

// (f) 既存が 0 件なら delete を撃たない (無駄な書き込みをしない)。
{
  const { sb: sbNone, calls } = makeDedupSb([], []);
  await saveScanResult(sbNone as never, {
    diagnosticUserId: 'd0000001-0000-0000-0000-000000000000',
    markdownClean: datedMd,
    pageCount: 1,
  });
  cases.push([
    '既存が無ければ delete しない',
    !calls.some((c) => c.op === 'delete'), '',
  ]);
}

let failed = 0;
for (const [name, ok, detail] of cases) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
