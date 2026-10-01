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
import {
  DERIVED_HC_BLOOD_IMPORTED_BY,
  extractBloodSubset,
  hasNormalBloodOnDate,
  type BloodSubsetExclusion,
  type LeanRow,
} from './blood-subset';
import { persistMeasurements, type SchemaClient } from './measurement-persist';
import { extractAgeSex } from './scan-age';
import { getServerSupabase } from './supabase';

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
  /**
   * 受診日を読めなかった回 (`date_source: 'today'`) を **保存せずに差し戻す**。
   * スペシャルアカウントの複数年取り込み専用のガード。
   * 今日の日付で積むと、別々の年が同じ `date/{YYYY_MM_DD}/` へ畳まれて
   * Elith 納品が 1 年分に潰れる (§4.3-1 / §9・「臨時案件で実測した事故」)。
   */
  requireReadableDate?: boolean;
}

/** 派生 blood（人間ドック由来の血液検査データ）の生成結果。**黙って落とさない**ための記録。 */
export interface DerivedBloodResult {
  status: 'created' | 'skipped' | 'error';
  /** skipped / error の理由。画面には出さないが API 応答と admin で見える。 */
  reason?:
    | 'no_target_items'        // 対象 15 項目が 1 件も無い（裁定 Q-6 = 何も作らない）
    | 'normal_blood_exists'    // 同じ受診日に通常 blood が在る（裁定 Q-10 = 通常を優先）
    | 'supabase_error'
    | string;
  artifactId?: string | null;
  /** 派生に入れた項目数。 */
  items?: number;
  /** 値が確定できず落とした項目（裁定 Q-12）。 */
  excluded?: BloodSubsetExclusion[];
}

export interface SaveScanResult {
  /** ガードで差し戻したときは null (保存していない)。 */
  artifactId: string | null;
  testDate: string;
  dateSource: string;
  measurements: number;
  /** requireReadableDate かつ受診日が読めなかったとき。保存はしていない。 */
  blocked?: 'exam_date_unreadable';
  /**
   * 人間ドック由来の血液検査データ（派生 BloodTestData）の生成結果。
   * **health_checkup 側の保存とは独立**で、ここが失敗しても本体は成功のまま返す。
   */
  derivedBlood?: DerivedBloodResult;
}

/**
 * **同じ受診日の既存回を片付ける（差し替えの前処理）。**
 *
 * 【なぜ要るか（2026-09-30・本田さんの重複報告）】ユーザーのスキャン経路
 * (`saveScanResult`) は**無条件 insert** だったので、**同じ回を送り直すたびに
 * `test_artifacts` が 1 行増えていた**。複数年アップロード（スペシャルアカウント）は
 * 受診日が読めなかった回の**再アップロードが前提**なので、ここを直さないと必ず重複する。
 * admin バッチ側は元から冪等だったのに、**ユーザー経路にだけこの処理が無かった。**
 *
 * 【原本が付いている行は消さない】`test_artifact_files` は
 * `on delete cascade`（`20260601000010_schemas_and_tables.sql:215`）なので、
 * artifact を消すと**原本の記録ごと消える**。10 年保管・削除不可（§6.1）と正面衝突するため、
 * **原本のある行は `superseded` に落とすだけ**にする。
 * ユーザーのスキャンは原本を保存しないので通常は 0 件だが、
 * **「無いはず」を前提にせず構造で防ぐ**（admin バッチ経由で後から原本が付くことはある）。
 *
 * 【measurement_values は道連れでよい】こちらも `on delete cascade`
 * （`20260820000010_measurement_values.sql:33`）。消した回の測定値が残ると
 * グラフに幽霊の点が出るので、**一緒に消えるのが正しい**。
 *
 * **投げない。** 片付けに失敗しても保存自体は続ける（最悪その日付が重複表示になるだけ）。
 */
async function replaceSameDateArtifacts(
  /*
   * **構造的に受ける。** `saveScanResult` は検査でスタブを差せるように
   * 最小の形しか要求していない（`:130-138`）ので、ここで
   * `SupabaseClient` を要求すると呼べなくなる。**実体は `any` 経由で使う**
   * （この関数の中だけ・下の `dsb`）。
   */
  sb: { schema: (name: 'diagnosis') => unknown },
  q: {
    diagnosticUserId: string;
    testType: string;
    testDate: string;
    source: string;
    /**
     * **任意の 5 つ目の条件**（2026-10-01・派生 blood 用）。渡さなければ従来どおり 4 条件
     * ＝ 既存 2 呼び出し（ユーザースキャン / admin バッチ）の挙動は 1 ミリも変わらない。
     *
     * 派生 blood は `source='user_upload'` を通常の blood と共有し得るので、
     * `imported_by` まで見ないと**将来の実血液 user upload 経路を巻き込んで消す**
     * （spec §10.2 / 裁定 Q-4 と同じ理由）。
     */
    importedBy?: string;
  },
): Promise<{ deleted: number; superseded: number }> {
  const out = { deleted: 0, superseded: 0 };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dsb = sb.schema('diagnosis') as any;
    let sel = dsb
      .from('test_artifacts')
      .select('id')
      .eq('diagnostic_user_id', q.diagnosticUserId)
      .eq('test_type', q.testType)
      .eq('test_date', q.testDate)
      .eq('source', q.source);
    if (q.importedBy) sel = sel.eq('imported_by', q.importedBy);
    const { data: rows } = await sel;
    const ids: string[] = (rows ?? []).map((r: { id: string }) => r.id);
    if (ids.length === 0) return out;

    // 原本が付いている id を先に洗い出す（cascade で消さないため）。
    const { data: fileRows } = await dsb
      .from('test_artifact_files')
      .select('test_artifact_id')
      .in('test_artifact_id', ids);
    const withFiles = new Set<string>((fileRows ?? []).map((r: { test_artifact_id: string }) => r.test_artifact_id));

    const deletable = ids.filter((id) => !withFiles.has(id));
    if (deletable.length > 0) {
      await dsb.from('test_artifacts').delete().in('id', deletable);
      out.deleted = deletable.length;
    }
    if (withFiles.size > 0) {
      await dsb
        .from('test_artifacts')
        .update({ status: 'superseded' })
        .in('id', [...withFiles]);
      out.superseded = withFiles.size;
      console.warn(
        `[scan-persist] 原本のある同日回 ${withFiles.size} 件は削除せず superseded にしました` +
        ' (原本の記録を cascade で失わないため)',
      );
    }
  } catch (e) {
    console.error('[scan-persist] 同日回の片付けに失敗 (保存は継続):',
      e instanceof Error ? e.message : e);
  }
  return out;
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

  /*
   * 受診日が読めない回のガード (§4.3-1)。**insert より前に**差し戻す。
   * ここで today のまま保存すると、複数年の別の回と同じ date フォルダへ畳まれ、
   * Elith 納品が 1 年に潰れる (materializeHealthCheckups は dateFolder で dedup する)。
   * 通常の利用者 (単発の 1 回) には効かせない — requireReadableDate が false のため。
   */
  if (input.requireReadableDate && dateSource === 'today') {
    return { artifactId: null, testDate, dateSource, measurements: 0, blocked: 'exam_date_unreadable' };
  }

  const { kept } = measurementsFromMarkdown(md);

  /*
   * 年齢・性別をスキャン本文から拾って保存する (発注者判断 2026-09-24「スキャンから抽出」)。
   * ウェルネス年齢は実年齢が必須だが、生年月日を持たない利用者 (スペシャルアカウント等) では
   * 顧客DBから年齢を引けない。人間ドック/健診には年齢・性別が印字されるので、ここで拾って
   * `age_at_test` / `sex` に残す。**取れないときは null** (捏造しない・NOT NULL でないので可)。
   */
  const { age: ageAtTest, sex } = extractAgeSex(md);

  /*
   * **冪等: 同じ受診日の既存回を差し替える**（2026-09-30）。
   * admin バッチ (`saveAdminBatchScan`) と同じ規律にそろえた。
   * **`source='user_upload'` だけを対象にする** — admin が入れた回や
   * 検査機関由来の回を、利用者のスキャンで消してはいけない。
   */
  await replaceSameDateArtifacts(sb, {
    diagnosticUserId: input.diagnosticUserId,
    testType: 'health_checkup',
    testDate,
    source: 'user_upload',
  });

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

  /*
   * **人間ドック由来の血液検査データ（派生 BloodTestData）**
   * (`docs/specs/healthcheckup_blood_extraction_spec_20261001.md` v2.0)。
   *
   * - **再解析しない。** 上で既に読み取り済みの `kept` をそのまま材料にする（v1.1 §3）。
   * - **health_checkup 側は 1 行も変えない。** 別の artifact 行として作る。
   * - **投げない。** ここが落ちても本体（検査票の保存）は成功のまま返す
   *   — 既存の `persistMeasurements` の扱いと同じ規律。
   */
  const derivedBlood = await persistDerivedBloodArtifact(sb, {
    diagnosticUserId: input.diagnosticUserId,
    testDate,
    measurements: kept as unknown as LeanRow[],
  });

  return { artifactId, testDate, dateSource, measurements, blocked: undefined, derivedBlood };
}

/**
 * **人間ドック・健康診断の読み取り結果から、派生 blood artifact を作る。**
 *
 * 正本: `docs/specs/healthcheckup_blood_extraction_spec_20261001.md` §4.3 / §6.2 / §10.2 / §10.5。
 *
 * 【作らない条件（この 2 つだけ）】
 *   ① 対象 15 項目が **0 件**（裁定 Q-6）… 成立判定ではない。**抽出できる血液値が無いから作らない**
 *   ② 同じ受診日に **通常 blood が在る**（裁定 Q-10）… 通常を優先。派生で上書きしない
 *
 * 【冪等】`(uid, 'blood', test_date, 'user_upload', imported_by=DERIVED_HC_BLOOD_IMPORTED_BY)` の
 *   既存行を片付けてから入れ直す。**`imported_by` まで見る**ので、通常 blood も
 *   将来の実血液 user upload も巻き込まない。
 *
 * **投げない。** 失敗は `status:'error'` で返す。
 */
export async function persistDerivedBloodArtifact(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  input: { diagnosticUserId: string; testDate: string; measurements: LeanRow[] },
): Promise<DerivedBloodResult> {
  try {
    const { kept, excluded } = extractBloodSubset(input.measurements);
    // ① 0 件なら何も作らない（artifact も measurement_values も）。
    if (kept.length === 0) {
      return { status: 'skipped', reason: 'no_target_items', items: 0, excluded };
    }
    // ② 同じ受診日に通常 blood が在れば作らない（通常を優先）。
    if (await hasNormalBloodOnDate(sb, input.diagnosticUserId, input.testDate)) {
      return { status: 'skipped', reason: 'normal_blood_exists', items: kept.length, excluded };
    }

    await replaceSameDateArtifacts(sb, {
      diagnosticUserId: input.diagnosticUserId,
      testType: 'blood',
      testDate: input.testDate,
      source: 'user_upload',
      importedBy: DERIVED_HC_BLOOD_IMPORTED_BY,
    });

    const { data, error } = await sb
      .schema('diagnosis')
      .from('test_artifacts')
      .insert([
        {
          diagnostic_user_id: input.diagnosticUserId,
          source: 'user_upload',
          test_type: 'blood',
          test_date: input.testDate,
          // 検査機関ではないので lab_name は付けない。
          lab_name: null,
          schema_version: '1.0',
          display_mode: 'single',
          page_count: 1,
          // **派生の印**（spec §4.3）。既存列・CHECK 無し = migration 不要。
          imported_by: DERIVED_HC_BLOOD_IMPORTED_BY,
          status: 'active',
          // **scan_md は入れない。** 原文は health_checkup 側の artifact に在る（二重に持たない）。
          notes: '人間ドック・健康診断の既存AIスキャン結果から抽出した血液検査データ（再解析なし）',
        },
      ])
      .select('id');
    if (error) return { status: 'error', reason: `test_artifacts: ${error.message}`, excluded };
    const artifactId = data?.[0]?.id;
    if (!artifactId) return { status: 'error', reason: 'artifact_id_missing', excluded };

    const r = await persistMeasurements(sb as unknown as SchemaClient, {
      artifactId,
      diagnosticUserId: input.diagnosticUserId,
      testType: 'blood',
      testDate: input.testDate,
      measurements: kept as never,
      // 由来の記録。デメカル CSV は 'raw_csv'、こちらはスキャン由来。
      sourceFileKind: 'scan_md',
    });
    return { status: 'created', artifactId, items: r.rows, excluded };
  } catch (e) {
    return { status: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Elith の format_id → `test_artifacts.test_type`。CHECK の値と 1:1 で対応させる。 */
export const TEST_TYPE_BY_FORMAT: Record<string, ArtifactTestType> = {
  HealthCheckupData: 'health_checkup',
  BloodTestData: 'blood',
  CancerRiskAssessmentData: 'cancer_urine',
  GeneticTestResultData: 'genetics',
  Other: 'ai_prediction', // LAiF「AI疾病発症予測」
};

/** `test_artifacts.test_type` の CHECK と同じ集合 (20260601000010:192)。 */
export type ArtifactTestType =
  | 'health_checkup' | 'blood' | 'genetics' | 'cancer_urine' | 'ai_prediction';

/**
 * **admin バッチ (elith-scan / elith-hc-merge / elith-genetic-merge) が読んだ検査を、
 * 本人のダッシュボードにも出すために `test_artifacts` / `measurement_values` へ保存する。**
 *
 * これまで admin バッチは Elith 納品用に S3 へ書くだけで、ダッシュボードが読む Supabase
 * には残していなかった (発注者判断 2026-09-25「検査値もダッシュボードに出す・source=admin_batch」)。
 * ユーザーのアプリスキャン (`saveScanResult`) と同じ 2 層 (jsonb + 正規化) へ書く。
 *
 * 【2026-09-28 に全検査種別へ一般化】以前は人間ドック専用 (`persistAdminBatchHc`) で、
 * `test_type` が `'health_checkup'` にベタ書きだった。そのため **admin バッチで読んだ
 * がんリスク・遺伝子・AI疾病発症予測は DB に 1 行も入らず**、Elith には渡っているのに
 * 本人のダッシュボードでは 0 件、という食い違いが起きていた。
 *
 * - `source='admin_batch'` で記録 (ユーザーの `user_upload` と区別)。
 * - **冪等**: 同一 (uid, test_type, test_date, source=admin_batch) の既存行を
 *   **hard delete してから入れ直す**。`user_upload` 行や別 date は触らない。
 *   (measurement_values は FK on delete cascade で一緒に消える)
 * - 測定値は **既に lean (sanitizeMeasurementsForDelivery 済み)** の前提で受け取り、
 *   `persistMeasurements` へそのまま渡す (ここで整形しない = 二重管理しない)。
 *   **遺伝子・AI疾病発症予測は `data.items[]` で measurements を持たない**ので
 *   空配列で呼ぶ。行は作られ、`scan_md` が「データ」の中身になる。
 * - 失敗しても呼び出し側 (Elith 納品) は止めない。理由を返して可視化する。
 */
export async function persistAdminBatchArtifact(input: {
  diagnosticUserId: string;
  /** 検査種別。未指定は人間ドック (旧シグネチャ互換)。 */
  testType?: ArtifactTestType;
  /** 確定スキャン Markdown (scan_md 用・監査/表示の原文)。 */
  markdownClean: string;
  /** 納品と同一の lean measurements (整形済み)。持たない形式は [] を渡す。 */
  measurements: Record<string, unknown>[];
  /** 受診日 YYYY-MM-DD (今回)。 */
  testDate: string;
  pageCount?: number;
}): Promise<{ artifactId: string | null; rows: number; reason?: string }> {
  const sb = getServerSupabase();
  if (!sb) return { artifactId: null, rows: 0, reason: 'supabase_not_configured' };
  const md = String(input.markdownClean ?? '');
  const testType: ArtifactTestType = input.testType ?? 'health_checkup';
  const testDate = /^\d{4}-\d{2}-\d{2}$/.test(input.testDate) ? input.testDate : jstToday();
  const { age: ageAtTest, sex } = extractAgeSex(md);

  /*
   * 冪等: 同一 (uid, test_type, test_date, source=admin_batch) を消してから入れ直す。
   * **2026-09-30 に `replaceSameDateArtifacts` へ寄せた**（実装を 2 つ持たない）。
   * 併せて**原本のある行は消さず superseded に落とす**ようになった —
   * 以前は `lab-results/upload` で後から原本を付けた回をバッチ再実行すると、
   * `on delete cascade` で**原本の記録ごと消えて**いた。
   */
  await replaceSameDateArtifacts(sb, {
    diagnosticUserId: input.diagnosticUserId,
    testType,
    testDate,
    source: 'admin_batch',
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (sb.schema('diagnosis') as any)
    .from('test_artifacts')
    .insert([
      {
        diagnostic_user_id: input.diagnosticUserId,
        source: 'admin_batch',
        test_type: testType,
        test_date: testDate,
        lab_name: null,
        schema_version: '1.0',
        display_mode: 'single',
        page_count: input.pageCount ?? 1,
        imported_by: 'admin',
        status: 'active',
        scan_md: md,
        ...(ageAtTest != null ? { age_at_test: ageAtTest } : {}),
        ...(sex ? { sex } : {}),
      },
    ])
    .select('id');
  if (error) return { artifactId: null, rows: 0, reason: `test_artifacts 保存失敗: ${error.message}` };
  const artifactId = data?.[0]?.id;
  if (!artifactId) return { artifactId: null, rows: 0, reason: 'test_artifacts の id を取得できず' };

  // 測定値を持たない形式 (遺伝子 / AI疾病発症予測 = data.items[]) は artifact 行だけで終わる。
  // **これは失敗ではない** ので rows=0 をそのまま返す (呼び出し側が警告にしないこと)。
  if (input.measurements.length === 0) return { artifactId, rows: 0 };

  let rows = 0;
  try {
    const r = await persistMeasurements(sb as unknown as SchemaClient, {
      artifactId,
      diagnosticUserId: input.diagnosticUserId,
      testType,
      testDate,
      measurements: input.measurements as never,
      sourceFileKind: 'scan_md',
    });
    rows = r.rows;
  } catch {
    rows = 0;
  }
  return { artifactId, rows };
}

/**
 * **既存の artifact に `scan_md` と測定値だけを補う。** 行は作らない。
 *
 * 【なぜ要るか (2026-09-29・実障害)】本田さんのがんリスク 4 件は
 * `source='wellfort_lab'` の artifact が**既に active で存在する**のに、
 * `measurement_values` が 0 件・`measurements` が NULL・`scan_md` が NULL で、
 * ダッシュボードに出なかった。
 * ここで `persistAdminBatchArtifact` を普通に流すと `source='admin_batch'` の
 * **別の 4 行が増えて計 8 件**になる。だから「既存へ入れる」経路を分ける。
 *
 * 【触らないもの】`test_date` / `external_test_id` / `source` / `lab_name` /
 * `notes` / `display_mode` / `status` は**一切更新しない**。
 * 更新するのは `scan_md` と、`persistMeasurements` が書く `measurements` (jsonb) だけ。
 *
 * 【冪等】`persistMeasurements` が artifact 単位で
 * `measurement_values` を**総入れ替え**する。再実行しても増えない。
 *
 * 【取り違え防止】uid / 種別 / 受診日が食い違えば **`mismatch` を返して何もしない**
 * (呼び出し側は 409 にする)。別人の検査値を混ぜないため。
 */
export async function persistIntoExistingArtifact(input: {
  artifactId: string;
  diagnosticUserId: string;
  testType: ArtifactTestType;
  markdownClean: string;
  measurements: Record<string, unknown>[];
  /** 期待する受診日。artifact 側と違えば止める (null なら照合しない)。 */
  testDate?: string | null;
}): Promise<{ artifactId: string | null; rows: number; reason?: string; mismatch?: string }> {
  const sb = getServerSupabase();
  if (!sb) return { artifactId: null, rows: 0, reason: 'supabase_not_configured' };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (sb.schema('diagnosis') as any)
    .from('test_artifacts')
    .select('id, diagnostic_user_id, test_type, test_date, status, source, display_mode')
    .eq('id', input.artifactId)
    .maybeSingle();
  if (error) return { artifactId: null, rows: 0, reason: `test_artifacts 照会失敗: ${error.message}` };
  if (!data) return { artifactId: null, rows: 0, mismatch: `artifact が見つかりません: ${input.artifactId}` };

  const a = data as { id: string; diagnostic_user_id: string; test_type: string; test_date: string | null };
  if (a.diagnostic_user_id.toLowerCase() !== input.diagnosticUserId.toLowerCase()) {
    return { artifactId: null, rows: 0, mismatch: 'この artifact は別の利用者のものです' };
  }
  if (a.test_type !== input.testType) {
    return { artifactId: null, rows: 0, mismatch: `検査種別が違います (artifact=${a.test_type} / 指定=${input.testType})` };
  }
  if (input.testDate && a.test_date && a.test_date.slice(0, 10) !== input.testDate) {
    return { artifactId: null, rows: 0, mismatch: `受診日が違います (artifact=${a.test_date.slice(0, 10)} / 読み取り=${input.testDate})` };
  }

  // scan_md だけ更新する。**他の列は書かない** (three_mode などを壊さない)。
  const md = String(input.markdownClean ?? '');
  if (md) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: mdErr } = await (sb.schema('diagnosis') as any)
      .from('test_artifacts')
      .update({ scan_md: md })
      .eq('id', input.artifactId);
    if (mdErr) return { artifactId: null, rows: 0, reason: `scan_md 保存失敗: ${mdErr.message}` };
  }

  if (input.measurements.length === 0) return { artifactId: input.artifactId, rows: 0 };
  try {
    const r = await persistMeasurements(sb as unknown as SchemaClient, {
      artifactId: input.artifactId,
      diagnosticUserId: input.diagnosticUserId,
      testType: input.testType,
      // **artifact 側の受診日を使う** (この経路で test_date を書き換えないため)。
      testDate: (a.test_date ?? input.testDate ?? '').slice(0, 10),
      measurements: input.measurements as never,
      sourceFileKind: 'scan_md',
    });
    return { artifactId: input.artifactId, rows: r.rows };
  } catch (e) {
    return { artifactId: input.artifactId, rows: 0, reason: `measurement_values 保存失敗: ${e instanceof Error ? e.message : e}` };
  }
}

/**
 * 旧名。人間ドック専用だった頃の呼び出し元のために残す (中身は一般化版へ委譲)。
 * 新しい呼び出しは `persistAdminBatchArtifact` を使う。
 */
export const persistAdminBatchHc = (input: Parameters<typeof persistAdminBatchArtifact>[0]) =>
  persistAdminBatchArtifact({ ...input, testType: input.testType ?? 'health_checkup' });
