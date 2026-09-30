/**
 * /result/[id] ページのデータ取得ヘルパ。
 *
 * 設計指針 (docs/architecture/wellfort_app_design_concept.md, docs/旧版・ボツ/elith_report_integration.md):
 *   - test_artifacts.display_mode: 'single' (1枚表示) | 'three_mode' (a/b/c タブ)
 *   - a) サマリー版 = Elith JSON 「アブストラクト」セクション
 *   - b) 要注意抜粋  = 「医療受診の目安」 + 「必要とする栄養素/サプリ情報」
 *   - c) 全編        = 全10セクションを順に Markdown 表示
 *
 * Phase 1.0 では test_artifact_items は使わず、Elith JSON から動的抽出する。
 */

import { getServerSupabase } from './supabase';
import { getOriginalSignedUrl } from './originals-storage';
import type { TestArtifact, DiagnosisResult } from '../types/supabase';
import { findSection, type ElithSection } from './elith-parser';
import { demoArtifacts, demoFallbackEnabled } from './demo-data';
import { AI_PREDICTION_REPORT_LABEL } from './display-names';

export interface ResultData {
  artifact: TestArtifact;
  latestResult: DiagnosisResult | null;
  sections: ElithSection[];
  /** a) アブストラクト本文 */
  summarySection: ElithSection | null;
  /** b) 要注意抜粋 (医療受診の目安 + 栄養素/サプリ) */
  highlightSections: ElithSection[];
  /** c) 全編で表示するセクション順 */
  fullSections: ElithSection[];
  /** UI モード判定 */
  isThreeMode: boolean;
  /** docs/kensa_sample から public/ にコピーした原本 PDF の path (test_type ベース) */
  samplePdfUrl: string | null;
  /** 原本 PDF の表示用ラベル */
  samplePdfLabel: string | null;
  /** true = 実際の原本 / false = サンプルへのフォールバック */
  isOriginal: boolean;
  /**
   * 同じ人の**同じ検査種別**の全回分 (test_date 降順・この artifact 自身を含む)。
   * 「過去データ」の切替に使う。ダッシュボードには置かず、
   * 「データ」を押した先のこのページに置く (発注者指示 2026-08)。
   */
  siblings: { id: string; testDate: string | null }[];
  /**
   * **検査票から読み取った測定値**（`test_artifacts.measurements` の jsonb）。
   *
   * 【なぜ足したか（2026-09-30・実測）】この画面は `scan_md`（アプリ内スキャンだけが書く）と
   * 原本 PDF しか出していなかったため、**admin 取込のがんリスク検査・血液・遺伝子は
   * 「値」が画面のどこにも出ていなかった**。DB には `measurements` が入っているのに、
   * 読む側が無かった。
   *
   * 出すのは**検査票に印字されている事実だけ** — 項目名・値・単位・基準値と、
   * **検査機関が付けた** `flag` / `assessment`。値と基準値から判定を計算しない
   * （CLAUDE.md「表示の原則（ミッション④）」）。
   */
  measurements: ResultMeasurement[];
}

/** 画面に出す 1 行。`test_artifacts.measurements` の 1 要素を検証したもの。 */
export interface ResultMeasurement {
  name: string;
  value: string | null;
  unit: string | null;
  refLow: string | null;
  refHigh: string | null;
  /** 検査機関が付けた印。**こちらでは計算しない。** */
  flag: 'H' | 'L' | null;
  /** 検査機関由来の判定コード（血液 CSV の F2/A3 等）。デコードしない。 */
  assessment: string | null;
}

/**
 * `test_artifacts.measurements`（jsonb・形は DB が保証しない）を画面用に検証する。
 *
 * - **配列でなければ空**（壊れた行でページを落とさない）
 * - **`name` が無い要素は捨てる**（何の値か分からないものは出さない）
 * - **値も単位も基準値も無い行は捨てる**（空行を並べない）
 * - **並び順は配列のまま**（`persistMeasurements` が `seq` として使っている順＝原本の順）
 */
export function toResultMeasurements(raw: unknown): ResultMeasurement[] {
  if (!Array.isArray(raw)) return [];
  const out: ResultMeasurement[] = [];
  for (const el of raw) {
    if (!el || typeof el !== 'object') continue;
    const m = el as Record<string, unknown>;
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    if (!name) continue;
    const str = (v: unknown): string | null => {
      if (typeof v === 'string') { const t = v.trim(); return t === '' ? null : t; }
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
      return null;
    };
    const value = str(m.value);
    const unit = str(m.unit);
    const refLow = str(m.ref_low);
    const refHigh = str(m.ref_high);
    if (value == null && unit == null && refLow == null && refHigh == null) continue;
    out.push({
      name,
      value,
      unit,
      refLow,
      refHigh,
      flag: m.flag === 'H' || m.flag === 'L' ? m.flag : null,
      assessment: str(m.assessment),
    });
  }
  return out;
}

/**
 * test_type → public/kensa_sample/ にあるサンプル PDF。
 *
 * **実データが最優先**。test_artifact_files に原本 (raw_pdf / raw_pdf_redacted /
 * raw_csv) があれば署名 URL を発行してそちらを使い、このサンプルは
 * 原本がまだ無いときのフォールバックとしてのみ使う (テストフェーズ)。
 */
const SAMPLE_PDF_MAP: Record<string, { url: string; label: string }> = {
  blood:         { url: '/kensa_sample/blood.pdf',         label: '血液検査 (リージャー)' },
  cancer_urine:  { url: '/kensa_sample/cancer_urine.pdf',  label: 'がんリスク検査 (PREVENT)' },
  genetics:      { url: '/kensa_sample/genetics.pdf',      label: '遺伝子検査 (Genoplan My Book, 207pg)' },
  ai_prediction: { url: '/kensa_sample/ai_prediction.pdf', label: AI_PREDICTION_REPORT_LABEL },
};

/** Wellfort UI 表示順 (c) 全編で使用) */
const FULL_ORDER = [
  'アブストラクト',
  '総評',
  '検査値フィードバック',
  '食事アドバイス',
  '運動アドバイス',
  '睡眠・ストレス管理',
  'ライフスタイル総合',
  '医療受診の目安',
  '必要とする栄養素/サプリ情報',
  'リファレンス',
];

const HIGHLIGHT_NAMES = [
  '医療受診の目安',
  '必要とする栄養素/サプリ情報',
];

/**
 * **所有者が違う / 存在しない のどちらでも同じ文言**を返す (2026-09-29)。
 *
 * 文言を分けると「その artifact_id は存在する」ことが応答から読み取れてしまい、
 * 他の利用者の検査の存在を推測できる。**区別できる応答を返さない。**
 */
const NOT_FOUND = '検査結果が見つかりません。';

export async function loadResult(
  artifactId: string,
  /**
   * 閲覧者の diagnostic_user_id。
   *
   * **所有者の検証に使う** (2026-09-29)。**非 demo の artifact は、この値が
   * 無ければ取得しない**。以前はデモ層の可否判定にしか使っておらず、
   * `test_artifacts` を `id` だけで引いていたため、**artifact_id を知っていれば
   * 他人の検査結果と原本 PDF/CSV が開けた** (直接オブジェクト参照)。
   *
   * admin の代理表示中は `resolveViewer` が**対象顧客の uid** を返すので
   * (`viewer.ts` の `impersonating` 分岐)、**admin 専用の例外分岐は要らない。**
   */
  viewerUid?: string | null,
): Promise<ResultData | { error: string }> {
  // デモ層 (demo-data.ts) の検査履歴から来た id。DB には存在しないので
  // ここで組み立てて返す。これが無いと検査履歴のリンクがエラー画面になる。
  // **所有者検証より前**に置く (demo-art-* は DB に無いので条件付き取得に載せられない)。
  if (artifactId.startsWith('demo-art-')) return demoResult(artifactId, viewerUid);

  if (!/^[0-9a-f-]{36}$/i.test(artifactId)) {
    return { error: '不正な検査 ID です。' };
  }
  /*
   * **閲覧者が分からなければ実データは返さない。**
   * 未サインイン (Cookie なし) で実在の artifact_id を指定しても、ここで止まる。
   */
  const owner = (viewerUid ?? '').trim();
  if (!owner) return { error: NOT_FOUND };

  const sb = getServerSupabase();
  if (!sb) return { error: 'Supabase が未設定です。' };

  /*
   * **所有者を取得条件に入れる。** 取ってから JS で突き合わせる実装にしない —
   * 行の中身が一度メモリに載るし、後段 (原本の署名 URL 発行) との順序を
   * 将来の改変で取り違えやすい。**条件に入れておけば構造的に到達しない。**
   */
  const { data: artifact, error: artErr } = await sb
    .schema('diagnosis')
    .from('test_artifacts')
    .select('*')
    .eq('id', artifactId)
    .eq('diagnostic_user_id', owner)
    .maybeSingle();
  if (artErr) return { error: `test_artifacts: ${artErr.message}` };
  // 他人の artifact も存在しない artifact も、ここで同じ文言になる。
  if (!artifact) return { error: NOT_FOUND };

  // 同 diagnostic_user_id の最新 published diagnosis_results を取得
  // (Phase 1.0 簡略: artifact と diagnosis_results の直接紐付けはまだ無いため)
  const { data: latestResult } = await sb
    .schema('diagnosis')
    .from('diagnosis_results')
    .select('*')
    .eq('diagnostic_user_id', artifact.diagnostic_user_id)
    .in('status', ['published', 'extracted'])
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  /*
   * この画面は「この検査 1 件」を見る場所なので、**その検査の原本 (PDF/CSV) を主役にする**。
   *
   * Elith の AI疾病予防報告書 (diagnosis_results) は **アカウント単位** の成果物で、
   * artifact とは紐付いていない (Phase 1.0 で直接の関連が無い)。ここに載せると
   * 検査履歴のどれを開いても同じ AI 診断レポートが出てしまうため、載せない。
   * AI疾病予防報告書は /report が正。検査種別ごとの読み物サンプル (elith-samples) も
   * 「この検査の結果」ではないので同様に出さない。
   */
  const sections: ElithSection[] = [];

  const summarySection = findSection(sections, 'アブストラクト');
  const highlightSections = HIGHLIGHT_NAMES
    .map((n) => findSection(sections, n))
    .filter((s): s is ElithSection => s != null);
  const fullSections = FULL_ORDER
    .map((n) => findSection(sections, n))
    .filter((s): s is ElithSection => s != null);

  // ── 原本の解決 ───────────────────────────────────────────────
  // 実データ (test_artifact_files) があれば署名 URL を発行して使う。
  // 無ければ従来のサンプル PDF にフォールバックする。
  /*
   * 同一種別の他の回 (過去データ)。id と日付だけ引く。
   *
   * **`status='active'` で絞る (2026-09-30・本田さんの重複報告で発覚)。**
   * ここだけ status を見ておらず、**差し替え前 (superseded) や取り下げ後 (withdrawn) の回も
   * 「過去データ」に並んでいた**。同じ受診日が 2 つ出るので、利用者には「重複」に見える。
   * ダッシュボード側 (`dashboard-queries.ts:128`) は最初から絞ってあり、**ここだけ漏れていた**。
   * 2026-09-27 に `measurement_values` で直したのと同型の漏れ (CLAUDE.md「修正3」)。
   */
  const { data: siblingRows } = await sb
    .schema('diagnosis')
    .from('test_artifacts')
    .select('id, test_date')
    .eq('diagnostic_user_id', artifact.diagnostic_user_id)
    .eq('test_type', artifact.test_type)
    .eq('status', 'active')
    .order('test_date', { ascending: false })
    .limit(24);
  const siblings = (siblingRows ?? []).map((r) => ({ id: r.id, testDate: r.test_date }));

  const original = await resolveOriginal(sb, artifact.id);
  /*
   * ★ サンプル PDF は**デモ用アカウントにだけ**出す (2026-09-29)。
   *
   * `public/kensa_sample/` に置いてあるのは **別人の検査書類**
   * (Genoplan My Book 207pg・LAiF のレポート等)。原本が未登録の実在の方の
   * 検査結果ページでこれにフォールバックすると、**その人の画面に他人の書類が出る**。
   * 実際に本田さんの遺伝子検査・AI疾病予測でそうなった。
   *
   * 「（サンプル）」と添えていても、**開けば中身は他人のもの**で区別がつかない。
   * デモ用アカウントの判定 (`demoFallbackEnabled`) は
   * `docs/operations/デモ用アカウント_仕様書.md` が正で、
   * 「実顧客に他人名義のサンプルを見せない」という同じ原則の適用範囲を、
   * ここにも広げる。**原本が無いなら何も出さない** (空の方が誤解より安全)。
   */
  const samplePdf = demoFallbackEnabled(viewerUid) ? (SAMPLE_PDF_MAP[artifact.test_type] ?? null) : null;
  const pdfUrl = original?.url ?? samplePdf?.url ?? null;
  const pdfLabel = original
    ? original.label
    : samplePdf
      ? `${samplePdf.label}（サンプル）`
      : null;

  return {
    artifact,
    latestResult: latestResult ?? null,
    sections,
    summarySection,
    highlightSections,
    fullSections,
    isThreeMode: artifact.display_mode === 'three_mode',
    samplePdfUrl: pdfUrl,
    samplePdfLabel: pdfLabel,
    isOriginal: original != null,
    siblings,
    measurements: toResultMeasurements((artifact as { measurements?: unknown }).measurements),
  };
}

/** 原本ファイルの種別ごとの表示名。 */
const FILE_KIND_LABEL: Record<string, string> = {
  raw_pdf: '検査結果 (原本 PDF)',
  raw_pdf_redacted: '検査結果 (原本 PDF)',
  raw_csv: '検査結果 (原本 CSV)',
};

/** 原本 (PDF 優先) の署名 URL を発行する。無ければ null。 */
async function resolveOriginal(
  sb: NonNullable<ReturnType<typeof getServerSupabase>>,
  artifactId: string,
): Promise<{ url: string; label: string } | null> {
  try {
    const { data, error } = await (sb.schema('diagnosis') as any)
      .from('test_artifact_files')
      .select('file_kind, storage_url')
      .eq('test_artifact_id', artifactId)
      .in('file_kind', ['raw_pdf', 'raw_pdf_redacted', 'raw_csv']);
    if (error || !data || data.length === 0) return null;

    // PDF を優先し、無ければ CSV。
    const order = ['raw_pdf_redacted', 'raw_pdf', 'raw_csv'];
    const rows = [...data].sort(
      (a: { file_kind: string }, b: { file_kind: string }) =>
        order.indexOf(a.file_kind) - order.indexOf(b.file_kind),
    );
    for (const row of rows) {
      const url = await getOriginalSignedUrl(row.storage_url);
      if (url) return { url, label: FILE_KIND_LABEL[row.file_kind] ?? '検査結果 (原本)' };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * デモ層の検査 1 件。原本はまだ無いので検査種別のサンプル PDF を出す。
 * AI 診断レポートは載せない (実データ経路と同じ扱い — /report が正)。
 */
function demoResult(artifactId: string, viewerUid?: string | null): ResultData | { error: string } {
  if (!demoFallbackEnabled(viewerUid)) return { error: NOT_FOUND };
  const artifact = demoArtifacts('').find((a) => a.id === artifactId);
  if (!artifact) return { error: NOT_FOUND };
  const samplePdf = SAMPLE_PDF_MAP[artifact.test_type] ?? null;
  // デモ層も同じ種別の全回分を「過去データ」に出す (テストフェーズの表示確認用)。
  const siblings = demoArtifacts('')
    .filter((a) => a.test_type === artifact.test_type)
    .sort((a, b) => String(b.test_date).localeCompare(String(a.test_date)))
    .map((a) => ({ id: a.id, testDate: a.test_date }));
  return {
    artifact,
    latestResult: null,
    sections: [],
    summarySection: null,
    highlightSections: [],
    fullSections: [],
    isThreeMode: false,
    samplePdfUrl: samplePdf?.url ?? null,
    samplePdfLabel: samplePdf ? `${samplePdf.label}（サンプル）` : null,
    isOriginal: false,
    siblings,
    measurements: toResultMeasurements((artifact as { measurements?: unknown }).measurements),
  };
}
