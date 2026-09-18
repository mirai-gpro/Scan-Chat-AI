/**
 * AI疾病予防報告書 (Elith の診断結果) の取得 — パイプライン⑥。
 *
 * 正本: docs/elith/AI疾病予防報告書_仕様書.md  ※ § 番号は旧版 docs/旧版・ボツ/ai_prevention_report_generation_spec.md §8
 *
 * 【データの所在】`diagnosis.diagnosis_results` が「Elith の診断結果 1 回分」を表す。
 *   report          … `report_text.json` (10 セクション ＋ `health_age`)
 *   checkup_values  … `health_checkup.json` (40 項目・`20260829000010` で追加)
 *   report_pdf_url  … Elith 受領 PDF。**原本として保管**し、表示の主役から外す (spec §1.1)
 *
 * 【優先順位】実データ → サンプル。`demo-data.ts` と同じ「実データが入れば自動で切り替わる」流儀。
 *
 * 【この層はデータを解釈しない】受領 JSON を取ってきて `buildReportVM()` へ渡すだけ。
 *   変換規則は `report-adapter.ts` が単独で所有する (spec §1.3.4)。
 */

import { getServerSupabase } from './supabase';
import { demoFallbackEnabled } from './demo-data';
import {
  ELITH_REPORT_SAMPLE_TEXT, ELITH_REPORT_SAMPLE_CHECKUP, ELITH_SAMPLE_ISSUED_ON,
  ELITH_REPORT_SAMPLE_TEXT_TYPE1, ELITH_REPORT_SAMPLE_LAB_TYPE1, ELITH_SAMPLE_ISSUED_ON_TYPE1,
} from './elith-report-sample';
import { buildReportVM, type BuildInput } from './report-adapter';
import type { ReportVM } from './report-model';
// `cfg` は `ui.cancer_screening_not_included` のためだけに使っていた (2026-09-18 に削除)。

/** 表示に必要な、報告書以外の材料 (氏名・実年齢・検査サイクル・タイプ判定)。 */
export interface ReportContext {
  diagnosticUserId: string | null;
  /** 「〇〇様」。本人への画面表示なので PII 分離の対象外 (spec §4.0.0.1)。 */
  name: string;
  chronologicalAge: number | null;
  /** 当社 CABA の算出値。Elith 出力との突合に使う (紙面には出さない)。 */
  ourWellnessAge: number | null;
  /** その回の入力にがんリスク検査があったか。**アプリが判定する** (spec §1.0.3)。 */
  hasCancerRisk: boolean;
  cycleSeq: number | null;
}

type CheckupValues = Record<string, { date?: string; value?: unknown }[]>;

function asCheckup(v: unknown): CheckupValues | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as CheckupValues) : null;
}

function common(ctx: ReportContext): Omit<BuildInput, 'reportText' | 'checkup' | 'issuedOn' | 'isSample'> {
  return {
    name: ctx.name,
    hasCancerRisk: ctx.hasCancerRisk,
    cycleSeq: ctx.cycleSeq,
    chronologicalAge: ctx.chronologicalAge,
    ourWellnessAge: ctx.ourWellnessAge,
    /*
     * 【`cancerFallbackText` を削除した・発注者指示 2026-09-18】
     * `ui.cancer_screening_not_included` は **admin が入力した当社の文**を
     * 報告書の紙面に出すためのものだった。受領 JSON に無い文言は紙面に出さない。
     */
  };
}

/**
 * サンプル (実データが無いときの表示)。
 *
 * **デモ用アカウント限定。** 実顧客に他人名義のサンプルを「自分の報告書」として
 * 見せないため、それ以外には `emptyVM` を返す (2 本柱の帯だけが立ち、材料の無い章は出ない)。
 * 資格の判定は `demo-accounts.ts` の `isDemoAccount` が持つ (uid 1 本・admin と無関係)。
 */
/** サンプルの検体。**既定はタイプ1** (発注者指示 2026-09-01)。 */
export type SampleType = 1 | 2;

function sample(ctx: ReportContext, type: SampleType = 1): ReportVM {
  if (!demoFallbackEnabled(ctx.diagnosticUserId)) return emptyVM(ctx);
  /*
   * **タイプは材料と同じ回のもので決める (2026-08-30・実測で確定)。**
   *
   * タイプは「その回の入力にがんリスク検査があったか」で決まる (spec §1.0.3) が、
   * `ctx.hasCancerRisk` は**閲覧者の `test_artifacts`**から作られており、
   * サンプルとは別の回のデータ。これを使うとタイプが食い違う。
   *
   * 実害: admin は `seed_admin_users.sql:137-145` が 真鍋の `test_artifacts`
   * (`cancer_urine` を含む) を**自分の uid へコピー**しているため
   * `hasCancerRisk: true` になり、当時タイプ2 だったサンプルが**タイプ1 へ反転**して
   * A 軸のカードが消えていた。**借り物かどうか (`usingDemoData`) では判定できない** —
   * admin の行は seed でコピー済みの自分の行なのでそのフラグは立たない。
   * だから判定は**材料を選ぶのと同じここ**に置く。
   *
   * 既定がタイプ1 になった今も規則は同じで、**材料と一緒に切り替える**。
   */
  if (type === 1) {
    return buildReportVM({
      ...common(ctx),
      hasCancerRisk: true,
      reportText: ELITH_REPORT_SAMPLE_TEXT_TYPE1,
      checkup: ELITH_REPORT_SAMPLE_LAB_TYPE1 as never,
      issuedOn: ELITH_SAMPLE_ISSUED_ON_TYPE1,
      isSample: true,
    });
  }
  return buildReportVM({
    ...common(ctx),
    hasCancerRisk: false,
    reportText: ELITH_REPORT_SAMPLE_TEXT,
    checkup: ELITH_REPORT_SAMPLE_CHECKUP,
    issuedOn: ELITH_SAMPLE_ISSUED_ON,
    isSample: true,
  });
}

/**
 * 受領 JSON から組んだ紙面を、タイプを指定して返す (テストフェーズの確認用)。
 * **本番と同じアダプタ・同じレンダラ**を通す — モックではなく実装の出力を見せる
 * (発注者指示 2026-09-01)。デモ表示の可否は `sample()` と同じ扱い。
 */
export function previewVM(ctx: ReportContext, type: SampleType): ReportVM {
  return sample(ctx, type);
}

/**
 * 最新の AI疾病予防報告書を表示モデルとして取得する。
 * 実データが無い / Supabase 未接続のときはサンプルへフォールバックする。
 */
export async function loadReportVM(ctx: ReportContext): Promise<ReportVM> {
  const sb = getServerSupabase();
  if (!sb || !ctx.diagnosticUserId) return sample(ctx);

  interface Row { report: unknown; checkup_values?: unknown; received_at: string }

  /**
   * `checkup_values` は `20260829000010` で追加した列。
   * **マイグレーション未適用の環境では select ごと失敗する**ので、そのときだけ列を外して
   * 引き直す。実データがあるのに黙ってサンプルへ落ちるのを防ぐため (spec §1.3.6 の趣旨)。
   */
  const fetchRow = async (withCheckup: boolean): Promise<Row | null> => {
    const cols = withCheckup
      ? 'report, checkup_values, received_at, status'
      : 'report, received_at, status';
    const { data, error } = await (sb.schema('diagnosis') as any)
      .from('diagnosis_results')
      .select(cols)
      .eq('diagnostic_user_id', ctx.diagnosticUserId)
      .neq('status', 'superseded')
      .not('report', 'is', null)
      .order('received_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    return ((data ?? [])[0] as Row | undefined) ?? null;
  };

  try {
    let row: Row | null;
    try {
      row = await fetchRow(true);
    } catch {
      row = await fetchRow(false);
    }
    if (!row) return sample(ctx); // デモ用アカウント以外は sample() 内で emptyVM になる

    /*
     * **旧形式 (`elith-v1.0` の配列) の行は、報告書を作り直す前の seed / デモの残骸。**
     *
     * `supabase/seed.sql` の 2 セクション 200 字の行を `seed_admin_users.sql` が
     * 各 admin uid へコピーしているため、**登録済みの admin は全員これを最新として持つ**。
     * 「実データ → サンプル」の順で引くので、**現行のサンプルには永久に落ちず**、
     * admin が報告書の紙面を確認できない (実測 2026-08-30: ダイジェスト 2 枚しか出ない)。
     *
     * → **デモ表示のときだけ**、現行形式のサンプルを優先する。
     *   - **実顧客には一切影響しない** (デモ表示が無効なので、この分岐に入らない)
     *   - **現行形式 (dict) の実データが入れば、この分岐は通らない** = 本物が勝つ
     *   - 旧形式の行を消したり書き換えたりはしない (監査のため残す)
     */
    if (Array.isArray(row.report) && demoFallbackEnabled(ctx.diagnosticUserId)) {
      return sample(ctx);
    }

    return buildReportVM({
      ...common(ctx),
      reportText: row.report,
      checkup: asCheckup(row.checkup_values),
      issuedOn: String(row.received_at).slice(0, 10),
      isSample: false,
    });
  } catch {
    return sample(ctx);
  }
}

/** 実データもサンプルも出さない場合 (デモ層 off・未受領)。**2 本柱の帯だけは立つ**。 */
function emptyVM(ctx: ReportContext): ReportVM {
  return buildReportVM({ ...common(ctx), reportText: null, checkup: null, issuedOn: '', isSample: false });
}
