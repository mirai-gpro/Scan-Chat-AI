/**
 * スキャンページの「これまでにアップロードした検査結果」一覧を取得。
 *
 * source='user_upload' の test_artifacts を test_date 降順で返す。
 */

import { getServerSupabase } from './supabase';
import type { TestArtifact } from '../types/supabase';

export async function getUserUploads(
  diagnosticUserId: string | null | undefined,
  limit = 10,
): Promise<TestArtifact[]> {
  if (!diagnosticUserId) return [];
  if (!/^[0-9a-f-]{36}$/i.test(diagnosticUserId)) return [];
  const sb = getServerSupabase();
  if (!sb) return [];

  const { data, error } = await sb
    .schema('diagnosis')
    .from('test_artifacts')
    .select('*')
    .eq('diagnostic_user_id', diagnosticUserId)
    .eq('source', 'user_upload')
    // **active だけ** (2026-09-30)。差し替えた回が一覧に残ると、
    // 同じ受診日が 2 つ並んで**重複に見える**。
    .eq('status', 'active')
    .order('test_date', { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data;
}
