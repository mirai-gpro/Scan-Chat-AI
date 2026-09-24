/**
 * ユーザーがアプリ内でスキャンした検査票を、**アプリ自身の DB へ**保存する。
 *
 * 【なぜ新規に要るか】
 * これまでスキャンは Elith 連携用に S3 へ書き出すだけで、`test_artifacts` に
 * 1 行も残していなかった (insert していたのは admin の `lab-results/upload` だけ)。
 * そのため検査結果ページに「人間ドック / 健康診断」の中身を出せなかった。
 *
 * 【何を保存するか】(発注者判断 2026-09-04)
 *   ○ 解析した md  … `test_artifacts.scan_md`
 *   ○ 測定値       … `persistMeasurements()` で 2 層へ (jsonb + 正規化テーブル)
 *   ✕ 原本画像     … **保存しない**。元々ユーザーの手元にあるものなので見送り
 *
 * 【整形は 1 か所】測定値は `measurementsFromMarkdown()` = Elith 書き出しと同じ
 * 正規化を通す。ここで独自に整形しない (CLAUDE.md「納品整形は決定論プログラムに集約」)。
 */

import { extractExamDate, measurementsFromMarkdown } from './elith-export';
import { persistMeasurements, type SchemaClient } from './measurement-persist';
import { extractAgeSex } from './scan-age';

/** JST の今日 (YYYY-MM-DD)。受診日が読めなかったときの既定。 */
function jstToday(): string {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export interface SaveScanInput {
  diagnosticUserId: string;
  /** ユーザー検証後の確定 Markdown。 */
  markdownClean: string;
  /** 束ねたページ数 (複数ページスキャン)。 */
  pageCount?: number;
  /** 呼び出し側が受診日を明示する場合 (YYYY-MM-DD)。 */
  examDate?: string | null;
}

export interface SaveScanResult {
  artifactId: string;
  testDate: string;
  dateSource: string;
  measurements: number;
}

/**
 * 1 回のスキャンを 1 件の test_artifacts として保存する。
 * 失敗時は例外。呼び出し側 (API) がメッセージへ変換する。
 */
export async function saveScanResult(
  sb: {
    schema: (name: string) => {
      from: (table: string) => {
        insert: (rows: Record<string, unknown>[]) => {
          select: (cols: string) => Promise<{ data: { id: string }[] | null; error: { message: string } | null }>;
        };
      };
    };
  },
  input: SaveScanInput,
): Promise<SaveScanResult> {
  const md = String(input.markdownClean ?? '').trim();
  if (!md) throw new Error('markdownClean が空です');

  // 受診日: 明示 → md から抽出 → 今日 (Elith 書き出しと同じ関数を使う)。
  const today = jstToday();
  const provided = input.examDate && /^\d{4}-\d{2}-\d{2}$/.test(input.examDate) ? input.examDate : null;
  const { date: testDate, source: dateSource } = provided
    ? { date: provided, source: 'provided' }
    : extractExamDate(md, today);

  const { kept } = measurementsFromMarkdown(md);

  /*
   * 年齢・性別をスキャン本文から拾って保存する (発注者判断 2026-09-24「スキャンから抽出」)。
   * ウェルネス年齢は実年齢が必須だが、生年月日を持たない利用者 (スペシャルアカウント等) では
   * 顧客DBから年齢を引けない。人間ドック/健診には年齢・性別が印字されるので、ここで拾って
   * `age_at_test` / `sex` に残す。**取れないときは null** (捏造しない・NOT NULL でないので可)。
   */
  const { age: ageAtTest, sex } = extractAgeSex(md);

  const { data, error } = await sb
    .schema('diagnosis')
    .from('test_artifacts')
    .insert([
      {
        diagnostic_user_id: input.diagnosticUserId,
        source: 'user_upload',
        // アプリ内スキャンで扱うのは検診・人間ドック (CLAUDE.md「検査種別ごとの本番処理」)。
        test_type: 'health_checkup',
        test_date: testDate,
        lab_name: null,
        schema_version: '1.0',
        display_mode: 'single',
        page_count: input.pageCount ?? 1,
        imported_by: 'user',
        status: 'active',
        scan_md: md,
        ...(ageAtTest != null ? { age_at_test: ageAtTest } : {}),
        ...(sex ? { sex } : {}),
        // measurements(jsonb) は下の persistMeasurements が書く (両層の唯一の入口)。
      },
    ])
    .select('id');

  if (error) throw new Error(`test_artifacts の保存に失敗: ${error.message}`);
  const artifactId = data?.[0]?.id;
  if (!artifactId) throw new Error('test_artifacts の id を取得できませんでした');

  /*
   * 測定値は **`persistMeasurements()` が唯一の書き込み口** (CLAUDE.md)。
   * jsonb (原本忠実) と正規化テーブル (推移グラフ用) の両方をこれが書く。
   * ここが落ちても artifact は残す — md まで消えるより、
   * 「グラフに出ないが結果は見える」ほうが実害が小さい。
   */
  let measurements = 0;
  try {
    const r = await persistMeasurements(sb as unknown as SchemaClient, {
      artifactId,
      diagnosticUserId: input.diagnosticUserId,
      testType: 'health_checkup',
      testDate,
      measurements: kept as never,
      sourceFileKind: 'scan_md',
    });
    measurements = r.rows;
  } catch {
    measurements = 0;
  }

  return { artifactId, testDate, dateSource, measurements };
}
