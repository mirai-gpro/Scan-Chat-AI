/**
 * AI ヘルスコーチ用のユーザー文脈生成。
 *
 * AI疾病予防報告書 (Elith JSON 全 10 セクション) を「丸ごと」context として LLM に
 * 渡すことで、コーチが結果を引用しながら回答できるようにする。
 *
 * セキュリティ:
 *   - PII (氏名・生年月日) は最小限 (氏名・年齢のみ) に絞る
 *   - service role key で読むため、サーバ側 (Astro SSR / API route) からのみ呼ぶこと
 */

import { getServerSupabase } from './supabase';
import { isApprovedRow } from './report-gate';
import { extractMetricCards, extractUrgentAlert, type ElithSection } from './elith-parser';
import { AI_PREDICTION_REPORT_LABEL } from './display-names';

export interface CoachContext {
  /** 表示用の氏名 (「真鍋様」等) */
  displayName: string;
  /** 推定年齢 */
  age: number | null;
  /** 性別ラベル */
  sex: string | null;
  /** Elith JSON 全 10 セクション (原文) */
  sections: ElithSection[];
  /** 主要メトリック (サマリーカード用) */
  metrics: ReturnType<typeof extractMetricCards>;
  /** 緊急アラート (あれば) */
  urgentAlert: ReturnType<typeof extractUrgentAlert>;
  /** 検査履歴: test_type + test_date */
  testHistory: Array<{ test_type: string; test_date: string | null; lab_name: string | null }>;
  /** LLM に渡す統合プロンプト用テキスト */
  promptText: string;
}

export async function buildCoachContext(
  diagnosticUserId: string | null | undefined,
): Promise<CoachContext | null> {
  if (!diagnosticUserId) return null;
  if (!/^[0-9a-f-]{36}$/i.test(diagnosticUserId)) return null;

  const sb = getServerSupabase();
  if (!sb) return null;

  const [
    { data: customer },
    { data: latestResult },
    { data: artifacts },
  ] = await Promise.all([
    sb
      .schema('customer')
      .from('customer_profiles')
      .select('family_name, given_name, date_of_birth, sex')
      .eq('diagnostic_user_id', diagnosticUserId)
      .maybeSingle(),
    sb
      .schema('diagnosis')
      .from('diagnosis_results')
      .select('report, summary_text, status, received_at, publish_status')
      .eq('diagnostic_user_id', diagnosticUserId)
      .in('status', ['published', 'extracted'])
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb
      .schema('diagnosis')
      .from('test_artifacts')
      .select('test_type, test_date, lab_name')
      .eq('diagnostic_user_id', diagnosticUserId)
      // **active だけ** (2026-09-30)。差し替え前・取り下げ後の回を混ぜると、
      // AI コーチが**もう無い検査を「受けています」と語る**。
      .eq('status', 'active')
      .order('test_date', { ascending: false })
      .limit(10),
  ]);

  if (!customer && !latestResult) return null;

  /*
   * **未承認 (`pending`) の報告書は読まない** (`docs/elith/AI疾病予防報告書_承認と再作成_仕様書.md` §8)。
   * ユーザー向けに報告書の中身を返す口なので、承認の境界をここでも揃える。
   * 列が無い環境は承認済相当 (`isApprovedRow`) = 従来どおりの挙動。
   */
  const approvedResult = latestResult && isApprovedRow(latestResult) ? latestResult : null;

  const displayName = customer ? `${customer.family_name}様` : 'お客様';
  const age = customer?.date_of_birth ? calcAge(customer.date_of_birth) : null;
  const sex = sexLabel(customer?.sex);
  const sections = (approvedResult?.report as ElithSection[] | null) ?? [];
  const metrics = extractMetricCards(sections);
  const urgentAlert = extractUrgentAlert(sections);
  const testHistory = (artifacts ?? []).map((a) => ({
    test_type: a.test_type,
    test_date: a.test_date,
    lab_name: a.lab_name,
  }));

  // LLM に渡す統合プロンプト用テキスト (10 セクション全文を含む)
  const lines: string[] = [];
  lines.push(`【ユーザープロフィール】`);
  lines.push(`氏名: ${displayName}${age != null ? ` / ${age}歳` : ''}${sex ? ` / ${sex}` : ''}`);
  if (approvedResult?.received_at) {
    const d = new Date(approvedResult.received_at);
    lines.push(`最新 AI 診断: ${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 受領`);
  }
  lines.push('');

  if (urgentAlert) {
    lines.push('【🔴 緊急留意事項】');
    lines.push(`${urgentAlert.title ?? ''} ${urgentAlert.body ?? ''}`.trim());
    lines.push('');
  }

  if (metrics.length > 0) {
    lines.push('【主要指標 (検査値フィードバックより)】');
    for (const m of metrics) {
      const v = `${m.value}${m.unit ? ' ' + m.unit : ''}`;
      const ref = m.reference ? ` (基準: ${m.reference})` : '';
      const lvl = levelLabel(m.level);
      lines.push(`- ${m.label}: ${v}${ref}${lvl ? ` [${lvl}]` : ''}`);
    }
    lines.push('');
  }

  if (testHistory.length > 0) {
    lines.push('【検査履歴】');
    for (const t of testHistory) {
      const date = t.test_date ?? '日付不明';
      lines.push(`- ${testTypeLabel(t.test_type)} (${date})${t.lab_name ? ' - ' + t.lab_name : ''}`);
    }
    lines.push('');
  }

  if (sections.length > 0) {
    lines.push('【AI 診断レポート全文 (Elith)】');
    for (const s of sections) {
      lines.push(`■ ${s.section_name} (${s.char_count}字)`);
      lines.push(s.text);
      lines.push('');
    }
  }

  return {
    displayName,
    age,
    sex,
    sections,
    metrics,
    urgentAlert,
    testHistory,
    promptText: lines.join('\n'),
  };
}

function calcAge(birth: string): number | null {
  const d = new Date(birth);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - d.getFullYear();
  const m = today.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--;
  return age >= 0 ? age : null;
}

function sexLabel(s: string | null | undefined): string | null {
  if (s === 'male') return '男性';
  if (s === 'female') return '女性';
  return null;
}

function levelLabel(level: string): string | null {
  switch (level) {
    case 'high':           return '高';
    case 'slightly_high':  return 'やや高';
    case 'low':            return '低';
    case 'slightly_low':   return 'やや低';
    case 'normal':         return '正常';
    default:               return null;
  }
}

function testTypeLabel(type: string): string {
  const map: Record<string, string> = {
    health_checkup: '人間ドック',
    blood: '血液検査',
    genetics: '遺伝子検査',
    cancer_urine: 'がんリスク検査',
    ai_prediction: AI_PREDICTION_REPORT_LABEL,
  };
  return map[type] ?? type;
}
