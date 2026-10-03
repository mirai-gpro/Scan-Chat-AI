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

import { extractExamDate, measurementsFromMarkdown, measurementGroupsFromMarkdown } from './elith-export';
import {
  extractBloodSubset,
  isDerivedHealthcheckBlood,
  derivedBloodExternalTestId,
  DERIVED_HC_BLOOD_IMPORTED_BY,
  DERIVED_HC_BLOOD_ELITH_BLOCK,
  type BloodSubsetExclusion,
} from './blood-subset';
import { persistMeasurements, type SchemaClient, type LeanMeasurement } from './measurement-persist';
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

export interface SaveScanResult {
  /** ガードで差し戻したときは null (保存していない)。 */
  artifactId: string | null;
  testDate: string;
  dateSource: string;
  measurements: number;
  /** requireReadableDate かつ受診日が読めなかったとき。保存はしていない。 */
  blocked?: 'exam_date_unreadable';
  /**
   * 人間ドック由来 派生 blood の結果。**作らなかったときも理由を返す**
   * (「通常 blood が在るので作らなかった」を黙らせない・spec §10.5)。
   */
  derivedBlood?: DerivedBloodOutcome;
}

/** 入力グループ (「N枚目」) 1 つぶんの結果。 */
export interface DerivedBloodSibling {
  /** 原本の「N枚目」の番号。 */
  groupIndex: number;
  /** `external_test_id` に入れた sibling 識別子。 */
  externalTestId: string;
  created: boolean;
  reason?: 'no_items' | 'error';
  artifactId?: string | null;
  rows?: number;
  items?: string[];
  excluded?: BloodSubsetExclusion[];
  skipped?: number;
  detail?: string;
}

/** 派生 blood を作ったか / 作らなかったならなぜか。 */
export interface DerivedBloodOutcome {
  /** **1 件以上**作ったか。 */
  created: boolean;
  /**
   * `no_items`             … 15 項目が 1 件も取れなかった (裁定 Q-6。**何も作らない**)
   * `normal_blood_exists`  … 同じ受診日に通常 blood が在る (裁定 Q-10。**通常を優先**)
   * `error`                … 保存に失敗した (health_checkup 側は成功のまま返す)
   */
  reason?: 'no_items' | 'normal_blood_exists' | 'error';
  artifactId?: string | null;
  /** `measurement_values` に入れた件数。 */
  rows?: number;
  /** 入れた項目名 (15 項目の canonical 名・seq の順)。 */
  items?: string[];
  /** 一意に確定できず除外した項目 (裁定 Q-12)。 */
  excluded?: BloodSubsetExclusion[];
  /** 15 項目に当たらなかった入力の件数 (監査用)。 */
  skipped?: number;
  detail?: string;
  /**
   * **入力グループごとの結果** (2026-10-03 §3)。1 グループなら 1 件。
   * `created`/`rows`/`items` は**全グループの合計 / 連結**で、内訳はここを見る。
   */
  siblings?: DerivedBloodSibling[];
  /** 原本から見つけた入力グループの数 (「N枚目」の数)。 */
  groupCount?: number;
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
  /*
   * `importedBy` は**任意の 5 つ目の条件**。渡さなければ従来どおり 4 条件
   * (既存の 2 呼び出しは 1 バイトも挙動が変わらない)。
   * 派生 blood は `source='user_upload'` を他の経路と共有するので、
   * **これが無いと将来の「利用者が血液検査の紙をスキャンした回」を巻き込んで消す**
   * (裁定 Q-4 と同じ理由)。
   */
  /*
   * `externalTestId` は**任意の 6 つ目の条件** (2026-10-03)。
   * 派生 blood が**同じ受診日に複数 (sibling A / B)** 並ぶので、これが無いと
   * **sibling B を作るときに sibling A を消す**。渡さなければ従来どおり。
   */
  q: {
    diagnosticUserId: string; testType: string; testDate: string; source: string;
    importedBy?: string; externalTestId?: string;
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
    if (q.externalTestId) sel = sel.eq('external_test_id', q.externalTestId);
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
   * **人間ドック由来の派生 blood** (§11「新規保存と backfill は同じ処理」)。
   *
   * **必ず health_checkup を保存し終えたあとに呼ぶ** (§10.3)。逆順にすると
   * 途中で失敗した回に血液だけが残る。
   * **ここが落ちても `saveScanResult` の結果は返す** —
   * `persistMeasurements` が落ちても artifact は残す、という既存の規律と同じ。
   * 受診日は**自分で決めない**。上で確定した `testDate` をそのまま使う (§10.4)。
   */
  let derivedBlood: DerivedBloodOutcome | undefined;
  try {
    derivedBlood = await persistDerivedBloodArtifact(sb as unknown as AnySchemaClient, {
      diagnosticUserId: input.diagnosticUserId,
      testDate,
      parentArtifactId: artifactId,
      /*
       * **入力単位 (「N枚目」) ごとに分ける** (§13)。`md` は**いま保存したものと同一**で、
       * 通す整形も `measurementsFromMarkdown` と同じ決定論関数 = 再解析ゼロ。
       * 1 枚だけの回は 1 グループ = 従来どおり 1 件。
       */
      sourceGroups: toDerivedBloodGroups({ scanMd: md, measurements: kept as unknown as LeanMeasurement[] }),
    });
  } catch (e) {
    derivedBlood = { created: false, reason: 'error', detail: e instanceof Error ? e.message : String(e) };
  }

  return { artifactId, testDate, dateSource, measurements, blocked: undefined, derivedBlood };
}

/* ════════════════════════════════════════════════════════════════════
 * 人間ドック・健康診断由来の 派生 blood
 * 正本: docs/specs/healthcheckup_blood_extraction_spec_20261001.md
 * ════════════════════════════════════════════════════════════════════
 *
 * **派生処理は 1 か所しかない。** 新規スキャン (`saveScanResult` の後段) と
 * 既存データの backfill (`/api/admin/derived-blood/backfill`) が
 * **この同じ関数を呼ぶ** (発注者指示 §11)。抽出ロジックを 2 本に分けない。
 */

/** 構造的に受ける Supabase。`replaceSameDateArtifacts` と同じ流儀 (検査でスタブを差せるように)。 */
type AnySchemaClient = { schema: (name: 'diagnosis') => unknown };

/**
 * 同じ受診日に**通常** blood (= 派生でない active 行) が在るか。
 *
 * 裁定 Q-10 / D-5:「同一ユーザー・同一 test_date では通常 blood を優先する。
 * 派生が通常血液を上書きしてはいけない」。納品キーが 1 日 1 format 1 ファイルなので、
 * 同日に 2 つ並べると**後勝ちで片方が消える**。
 *
 * **判定は `imported_by` の完全一致 1 本**。`source` では見ない (裁定 Q-4)。
 * 引けなかったときは `null` を返す = **呼び出し側は作らない** (fail-closed。
 * 「在るのに在ると分からない」まま派生を作ると通常 blood を潰し得る)。
 */
async function findNormalBloodOnDate(
  sb: AnySchemaClient,
  diagnosticUserId: string,
  testDate: string,
): Promise<string[] | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dsb = sb.schema('diagnosis') as any;
    const { data, error } = await dsb
      .from('test_artifacts')
      .select('id, imported_by')
      .eq('diagnostic_user_id', diagnosticUserId)
      .eq('test_type', 'blood')
      .eq('test_date', testDate)
      .eq('status', 'active');
    if (error) return null;
    return ((data ?? []) as { id: string; imported_by: string | null }[])
      .filter((r) => String(r.imported_by ?? '') !== DERIVED_HC_BLOOD_IMPORTED_BY)
      .map((r) => String(r.id));
  } catch {
    return null;
  }
}

/**
 * **通常 blood が後から届いたとき**、同じ受診日の派生を `superseded` に落とす (裁定 Q-10)。
 *
 * - **削除しない** (監査のため残す)。`status` で読み分けるので
 *   グラフ・検査カードからは `activeArtifactIds()` 経由で自動的に消える。
 * - **触るのは `imported_by='derived_healthcheck_blood'` の行だけ。**
 *   通常 blood の行には 1 行も触らない。
 * - **投げない。** 失敗しても通常 blood の取り込みは成功のまま返す (既存の fail-safe の流儀)。
 */
export async function supersedeDerivedBloodOnSameDate(
  sb: AnySchemaClient,
  diagnosticUserId: string,
  testDate: string | null | undefined,
): Promise<{ superseded: number }> {
  if (!testDate || !/^\d{4}-\d{2}-\d{2}$/.test(testDate)) return { superseded: 0 };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dsb = sb.schema('diagnosis') as any;
    const { data } = await dsb
      .from('test_artifacts')
      .select('id')
      .eq('diagnostic_user_id', diagnosticUserId)
      .eq('test_type', 'blood')
      .eq('test_date', testDate)
      .eq('status', 'active')
      .eq('imported_by', DERIVED_HC_BLOOD_IMPORTED_BY);
    const ids: string[] = ((data ?? []) as { id: string }[]).map((r) => String(r.id));
    if (ids.length === 0) return { superseded: 0 };
    await dsb.from('test_artifacts').update({ status: 'superseded' }).in('id', ids);
    console.warn(
      `[scan-persist] 通常 blood が届いたため同日 (${testDate}) の派生 blood ${ids.length} 件を superseded にしました`,
    );
    return { superseded: ids.length };
  } catch (e) {
    console.error('[scan-persist] 派生 blood の supersede に失敗 (取り込みは継続):',
      e instanceof Error ? e.message : e);
    return { superseded: 0 };
  }
}

/** 入力グループ 1 つぶんの材料。 */
export interface DerivedBloodSourceGroup {
  /** 原本の「N枚目」の番号 (`measurementGroupsFromMarkdown` の `index`)。 */
  index: number;
  label?: string | null;
  /** そのグループだけの lean measurements。 */
  measurements: readonly LeanMeasurement[];
}

/**
 * 材料を**入力グループの配列**に揃える。
 *
 * - `scan_md` を `measurementGroupsFromMarkdown()` に通して「N枚目」で割る。
 *   **グループが 2 つ以上になった回だけ**、その分割を採る (ここが 2026-10-03 の本題)。
 * - **1 グループしか無い回は、保存済み jsonb の measurements をそのまま使う**
 *   = 従来と 1 バイトも変わらない。`scan_md` が在っても (表が無い / 様式が違う /
 *   admin バッチが別経路で measurements を入れた) 取りこぼさない。
 *   実測: `scan_md='## 原文'` のように表の無い原文だと markdown 側は 0 件になる。
 * - jsonb が空で `scan_md` からしか取れない回は markdown 由来を使う (材料がそれだけ)。
 *
 * **再解析ではない** — `scan_md` は保存済みの確定 Markdown で、通す整形も
 * `measurementsFromMarkdown` と同じ決定論関数。Gemini も PDF も触らない。
 */
export function toDerivedBloodGroups(input: {
  scanMd?: string | null;
  measurements?: readonly LeanMeasurement[] | null;
}): DerivedBloodSourceGroup[] {
  const lean = input.measurements ?? [];
  const md = String(input.scanMd ?? '').trim();
  if (md) {
    const groups = measurementGroupsFromMarkdown(md);
    const total = groups.reduce((a, g) => a + g.kept.length, 0);
    const mapped = (): DerivedBloodSourceGroup[] => groups.map((g) => ({
      index: g.index, label: g.label,
      measurements: g.kept as unknown as LeanMeasurement[],
    }));
    // 分割が要る回 = 「N枚目」が 2 つ以上あって、実際に測定値が取れている。
    if (groups.length > 1 && total > 0) return mapped();
    // jsonb が空なら markdown 由来しか材料が無い。
    if (groups.length === 1 && lean.length === 0 && total > 0) return mapped();
  }
  return lean.length > 0 ? [{ index: 1, label: null, measurements: lean }] : [];
}

/**
 * **人間ドック・健康診断の既存 measurements から派生 blood を作る。**
 *
 * **入力グループ (「N枚目」) ごとに 1 件**作る (2026-10-03 §3)。
 * 1 件の health_checkup に独立した健診結果が 2 通ぶん入っていれば **derived blood 2 件**。
 * 入力グループが 1 つだけなら**従来どおり 1 件**。
 *
 * 入力は `sanitizeMeasurementsForDelivery()` を通した後の lean measurement。
 * **OCR / Gemini / PDF 解析は 1 度も呼ばない** (v1.1 §3「再解析しない」)。
 *
 * 元の health_checkup artifact には**一切触らない** — `id` / `status` /
 * `measurements` を 1 バイトも変えない。派生は**別の行**として作る (§6)。
 *
 * **投げない。** 失敗は `reason:'error'` で返す。人間ドック側の保存結果は守る (§10.3)。
 */
export async function persistDerivedBloodArtifact(
  sb: AnySchemaClient,
  input: {
    diagnosticUserId: string;
    testDate: string;
    /**
     * 親の health_checkup artifact id。**sibling の識別子に使う**ので必須
     * (`external_test_id = derived_hc:<親>:g<N>`)。
     */
    parentArtifactId: string;
    /** 入力グループごとの材料 (推奨)。 */
    sourceGroups?: readonly DerivedBloodSourceGroup[];
    /** 後方互換: グループに割れない呼び出し。1 グループとして扱う。 */
    sourceMeasurements?: readonly LeanMeasurement[] | null;
    /** このグループ番号だけを作る (backfill の差分補完用)。空なら全グループ。 */
    onlyGroups?: readonly number[];
    sourceFileKind?: string | null;
  },
): Promise<DerivedBloodOutcome> {
  const groups: DerivedBloodSourceGroup[] = input.sourceGroups
    ? [...input.sourceGroups]
    : toDerivedBloodGroups({ measurements: input.sourceMeasurements ?? [] });

  if (!input.parentArtifactId) {
    return { created: false, reason: 'error', detail: '親の health_checkup artifact id が要ります', groupCount: groups.length };
  }

  /*
   * 裁定 Q-10: 同日に通常 blood が在れば**どのグループも作らない** (通常 blood 優先)。
   * 引けなければ作らない (fail-closed)。**グループ単位ではなく受診日単位の判断**
   * — 同じ日に通常と派生を並べない、という規則なので。
   */
  const normal = await findNormalBloodOnDate(sb, input.diagnosticUserId, input.testDate);
  if (normal == null) {
    return { created: false, reason: 'error', groupCount: groups.length, detail: '同日の通常 blood を確認できませんでした (作成を見送りました)' };
  }
  if (normal.length > 0) {
    return {
      created: false, reason: 'normal_blood_exists', groupCount: groups.length,
      detail: `同じ受診日に通常 blood が ${normal.length} 件あるため派生は作りません`,
    };
  }

  const only = input.onlyGroups && input.onlyGroups.length > 0 ? new Set(input.onlyGroups) : null;
  const siblings: DerivedBloodSibling[] = [];

  /*
   * ── 片付けの範囲は「全グループを作り直すのか」で変える ────────────────────
   *
   * **全グループ (`onlyGroups` 無し) = その受診日の派生を作り直す**ので、
   * **`external_test_id` を問わず**同じ日の派生を先に 1 回片付ける。
   * 【なぜ必要か・実測 2026-10-03】`saveScanResult` で同じ回を送り直すと
   * **health_checkup の id が変わる** (古い行を片付けて insert し直すため) ので、
   * sibling 識別子 (`derived_hc:<親>:g<N>`) も変わる。
   * `external_test_id` 完全一致だけで片付けると**前の親の派生が残って 2 倍に増える**。
   *
   * **一部だけ (`onlyGroups` 指定 = backfill の差分補完) は、そのグループだけ**を
   * `external_test_id` 完全一致で片付ける。隣の sibling を巻き込まない。
   */
  if (!only) {
    await replaceSameDateArtifacts(sb, {
      diagnosticUserId: input.diagnosticUserId,
      testType: 'blood',
      testDate: input.testDate,
      source: 'user_upload',
      importedBy: DERIVED_HC_BLOOD_IMPORTED_BY,
    });
  }

  for (const g of groups) {
    if (only && !only.has(g.index)) continue;
    const externalTestId = derivedBloodExternalTestId(input.parentArtifactId, g.index);
    const { kept, excluded, skipped } = extractBloodSubset(g.measurements);

    // 裁定 Q-6: そのグループから 0 件なら、そのグループは作らない。
    if (kept.length === 0) {
      siblings.push({ groupIndex: g.index, externalTestId, created: false, reason: 'no_items', excluded, skipped, rows: 0, items: [] });
      continue;
    }
    try {
      /*
       * 差分補完のときだけ、**このグループの `external_test_id` 完全一致**で片付ける
       * (6 つ目の条件)。これが無いと**sibling B を作るときに sibling A を消す**。
       * 全グループのときは上で 1 回片付けてあるので、ここでは何もしない。
       */
      if (only) {
        await replaceSameDateArtifacts(sb, {
          diagnosticUserId: input.diagnosticUserId,
          testType: 'blood',
          testDate: input.testDate,
          source: 'user_upload',
          importedBy: DERIVED_HC_BLOOD_IMPORTED_BY,
          externalTestId,
        });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dsb = sb.schema('diagnosis') as any;
      const { data, error } = await dsb
        .from('test_artifacts')
        .insert([
          {
            diagnostic_user_id: input.diagnosticUserId,
            source: 'user_upload',
            test_type: 'blood',
            test_date: input.testDate,
            lab_name: null,
            schema_version: '1.0',
            display_mode: 'single',
            page_count: 1,
            imported_by: DERIVED_HC_BLOOD_IMPORTED_BY,
            // **sibling 識別子** (§8)。UNIQUE がこれで初めて効く。
            external_test_id: externalTestId,
            status: 'active',
            scan_md: null,
            notes: `人間ドック・健康診断の既存AIスキャン結果から血液検査値を抽出（再解析なし / ${g.label ?? `${g.index}枚目`}）`,
          },
        ])
        .select('id');
      if (error) {
        siblings.push({ groupIndex: g.index, externalTestId, created: false, reason: 'error', excluded, skipped, detail: String(error.message ?? error) });
        continue;
      }
      const artifactId = (data?.[0] as { id?: string } | undefined)?.id;
      if (!artifactId) {
        siblings.push({ groupIndex: g.index, externalTestId, created: false, reason: 'error', excluded, skipped, detail: 'test_artifacts の id を取得できませんでした' });
        continue;
      }

      const r = await persistMeasurements(sb as unknown as SchemaClient, {
        artifactId,
        diagnosticUserId: input.diagnosticUserId,
        testType: 'blood',
        testDate: input.testDate,
        measurements: kept as never,
        sourceFileKind: input.sourceFileKind ?? 'scan_md',
      });
      siblings.push({
        groupIndex: g.index, externalTestId, created: true, artifactId,
        rows: r.rows, items: kept.map((m) => String(m.name)), excluded, skipped,
      });
    } catch (e) {
      siblings.push({ groupIndex: g.index, externalTestId, created: false, reason: 'error', excluded, skipped, detail: e instanceof Error ? e.message : String(e) });
    }
  }

  const made = siblings.filter((x) => x.created);
  if (made.length === 0) {
    const allNoItems = siblings.length > 0 && siblings.every((x) => x.reason === 'no_items');
    return {
      created: false,
      reason: allNoItems || siblings.length === 0 ? 'no_items' : 'error',
      groupCount: groups.length, siblings,
      excluded: siblings.flatMap((x) => x.excluded ?? []),
      skipped: siblings.reduce((a, x) => a + (x.skipped ?? 0), 0),
      rows: 0, items: [],
      detail: siblings.find((x) => x.detail)?.detail,
    };
  }
  return {
    created: true, groupCount: groups.length, siblings,
    artifactId: made[0].artifactId ?? null,
    rows: made.reduce((a, x) => a + (x.rows ?? 0), 0),
    items: made.flatMap((x) => x.items ?? []),
    excluded: siblings.flatMap((x) => x.excluded ?? []),
    skipped: siblings.reduce((a, x) => a + (x.skipped ?? 0), 0),
  };
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
    // `imported_by` も引く — 人間ドック由来の派生 blood を上書きさせないため (下)。
    .select('id, diagnostic_user_id, test_type, test_date, status, source, display_mode, imported_by')
    .eq('id', input.artifactId)
    .maybeSingle();
  if (error) return { artifactId: null, rows: 0, reason: `test_artifacts 照会失敗: ${error.message}` };
  if (!data) return { artifactId: null, rows: 0, mismatch: `artifact が見つかりません: ${input.artifactId}` };

  const a = data as {
    id: string; diagnostic_user_id: string; test_type: string;
    test_date: string | null; imported_by?: string | null;
  };

  /*
   * ★ **人間ドック由来の派生 blood には絶対に書き込まない** (発注者指示 2026-10-03 §15/§16)。
   *
   * 【なぜ要るか — 静かに壊れる形】この関数は `uid` / `test_type` / `test_date` しか
   * 照合していなかったので、**同じ受診日に派生 blood が在ると、検査機関の本物の血液検査が
   * その行へ上書きされ得た**。列は `scan_md` と測定値だけ更新されるので
   * **`imported_by='derived_healthcheck_blood'` が残り**、結果:
   *   ① 本物の血液検査が Elith の揃い判定・納品から**黙って外れる** (§16 違反)
   *   ② 画面には他人の様式の「人間ドックから抽出」が付く (由来の偽り)
   * どちらもエラーにならないので目視では守れない。
   *
   * 止め方は既存の `mismatch` に合わせる — 呼び出し側 (`elith-scan.ts` /
   * `special-additional-tests`) は既に 409 へ変換して**DB を書かずに**返す。
   */
  if (isDerivedHealthcheckBlood(a)) {
    return { artifactId: null, rows: 0, mismatch: DERIVED_HC_BLOOD_ELITH_BLOCK };
  }
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
