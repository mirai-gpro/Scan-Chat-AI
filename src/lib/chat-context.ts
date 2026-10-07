/**
 * AI 問診の system instruction に補足として追加する「ユーザー文脈」を生成する。
 *
 * 設計方針:
 *   - 出力は最大 200 字程度の "補足情報" として、SYSTEM_INSTRUCTION の **後ろ** に貼る。
 *   - 問診票の質問順 (Q1-1 〜 Q5-2) を絶対に変えない、というガードを冒頭に明記。
 *   - PII は氏名・年齢・性別程度に留める。
 *   - service role key で読むため、サーバ側 (Astro SSR / API route) からのみ呼ぶこと。
 */

import { getServerSupabase } from './supabase';
import { isApprovedRow } from './report-gate';
import {
  extractMetricCards,
  extractUrgentAlert,
  type ElithSection,
} from './elith-parser';
import { examLabelsFromTestTypes } from '../scripts/chat/interview-script';

/**
 * 内部に登録済の顧客プロフィール (氏名・生年月日・性別) を取得する。
 * これらは問診で尋ねず、この値を問診結果へ自動付与するために使う。
 * service role key で読むため、サーバ側 (API route) からのみ呼ぶこと。
 */
export interface CustomerProfile {
  /** customer.family_name */
  name: string | null;
  /** customer.date_of_birth (ISO 日付文字列) */
  dateOfBirth: string | null;
  /** customer.sex ('male' | 'female' 等の生値) */
  sex: string | null;
}

export async function getCustomerProfile(
  diagnosticUserId: string | null | undefined,
): Promise<CustomerProfile | null> {
  if (!diagnosticUserId) return null;
  if (!/^[0-9a-f-]{36}$/i.test(diagnosticUserId)) return null;

  const sb = getServerSupabase();
  if (!sb) return null;

  const { data } = await sb
    .schema('customer')
    .from('customer_profiles')
    .select('family_name, date_of_birth, sex')
    .eq('diagnostic_user_id', diagnosticUserId)
    .maybeSingle();

  if (!data) return null;

  const name = data.family_name?.trim();
  return {
    name: name ? name : null,
    dateOfBirth: data.date_of_birth ?? null,
    sex: data.sex ?? null,
  };
}

/**
 * 今回実施する検査を申込情報から取得し、EXAM-TYPE 設問へ供給するラベル配列を返す。
 * A案: customer.lab_tests.test_type (診断側との橋渡し diagnostic_user_id で直結) を採用。
 * 該当が無ければ空配列 → 問診側はフォールバックで EXAM-TYPE を通常設問として尋ねる。
 * service role key で読むため、サーバ側 (API route) からのみ呼ぶこと。
 */
export async function getAppliedExamLabels(
  diagnosticUserId: string | null | undefined,
): Promise<string[]> {
  if (!diagnosticUserId) return [];
  if (!/^[0-9a-f-]{36}$/i.test(diagnosticUserId)) return [];

  const sb = getServerSupabase();
  if (!sb) return [];

  // 今回対象の検査 = まだ結果取り込み前 (pending|in_lab|reported) を優先。
  // 見つからなければ全件から拾う (test-data フェーズの取りこぼし回避)。
  const { data } = await sb
    .schema('customer')
    .from('lab_tests')
    .select('test_type, status')
    .eq('diagnostic_user_id', diagnosticUserId);

  if (!data || data.length === 0) return [];

  const active = data.filter(
    (r) => r.status === 'pending' || r.status === 'in_lab' || r.status === 'reported',
  );
  const rows = active.length > 0 ? active : data;
  const codes = rows
    .map((r) => r.test_type)
    .filter((t): t is string => typeof t === 'string');
  return examLabelsFromTestTypes(codes);
}

export async function buildUserContextForChat(
  diagnosticUserId: string | null | undefined,
): Promise<string | null> {
  if (!diagnosticUserId) return null;
  if (!/^[0-9a-f-]{36}$/i.test(diagnosticUserId)) return null;

  const sb = getServerSupabase();
  if (!sb) return null;

  const [{ data: customer }, { data: latestResult }] = await Promise.all([
    sb
      .schema('customer')
      .from('customer_profiles')
      .select('family_name, date_of_birth, sex')
      .eq('diagnostic_user_id', diagnosticUserId)
      .maybeSingle(),
    sb
      .schema('diagnosis')
      .from('diagnosis_results')
      .select('report, status, publish_status')
      .eq('diagnostic_user_id', diagnosticUserId)
      .eq('status', 'published')
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (!customer && !latestResult) return null;

  /*
   * **未承認 (`pending`) の報告書は読まない** (`docs/elith/AI疾病予防報告書_承認と再作成_仕様書.md` §8)。
   * ユーザー向けに報告書の中身を返す口なので、承認の境界をここでも揃える。
   * 列が無い環境は承認済相当 (`isApprovedRow`) = 従来どおりの挙動。
   */
  const approvedResult = latestResult && isApprovedRow(latestResult) ? latestResult : null;

  // 1 行のコンパクトな自己紹介
  const profileBits: string[] = [];
  if (customer) {
    profileBits.push(`${customer.family_name}さん`);
    const age = customer.date_of_birth ? calcAge(customer.date_of_birth) : null;
    if (age != null) profileBits.push(`${age}歳`);
    const sex = sexLabel(customer.sex);
    if (sex) profileBits.push(sex);
  }
  const profileLine = profileBits.join('・');

  // 注目すべき所見だけ 3 件まで
  const notable: string[] = [];
  const sections = (approvedResult?.report as ElithSection[] | null) ?? [];
  if (sections.length > 0) {
    const metrics = extractMetricCards(sections)
      .filter((m) => m.level !== 'normal')
      .slice(0, 3);
    for (const m of metrics) {
      notable.push(`${m.label}${levelLabel(m.level) ?? ''}`);
    }
    const alert = extractUrgentAlert(sections);
    if (alert) notable.push('要受診あり');
  }

  if (!profileLine && notable.length === 0) return null;

  // 200 字以内に収める
  const lines = ['【補足情報 — 上記の問診票指示を上書きしない】'];
  if (profileLine) lines.push(`相手: ${profileLine}`);
  if (notable.length > 0) {
    lines.push(`直近の所見: ${notable.join('、')} (過去の検査から)`);
  }
  lines.push('問診票の質問順 (Q1-1〜Q5-2) は絶対に変えない。所見への言及は任意。');

  return lines.join('\n');
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
    default:               return null;
  }
}
