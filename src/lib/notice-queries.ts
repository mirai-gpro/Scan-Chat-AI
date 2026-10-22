/**
 * お知らせ機能のデータ取得ヘルパ。
 *
 * 3 区分:
 *   1) 重要なお知らせ (user_notices) — ユーザー個別 / 既読・未読あり
 *   2) 一般のお知らせ (announcements.category='general') — 全ユーザー共通
 *   3) ニュース        (announcements.category='news')    — 全ユーザー共通
 *
 * dev profile では認証未連携のため `?u=<diagnostic_user_id>` でユーザーを識別する。
 */

import { getServerSupabase } from './supabase';
import { withHonorific } from './dashboard-queries';
import type { UserNotice, Announcement } from '../types/supabase';
import { buildDemoNotices, demoUnreadImportant } from './demo-data';
import { shouldUseDemoData, type ViewMode } from './view-mode';

/** 一般のお知らせ / ニュースで初期表示する件数。 */
export const ANNOUNCEMENT_PREVIEW_LIMIT = 3;

export interface NoticesData {
  diagnosticUserId: string;
  /** app_users.display_name_cache 由来の表示名 (なければ「お客様」)。 */
  userName: string;
  /** 重要なお知らせ。expandImportant=false なら未読のみ。 */
  important: UserNotice[];
  /** 重要なお知らせの未読件数 (バッジ / 件数表示用)。 */
  importantUnreadCount: number;
  general: Announcement[];
  news: Announcement[];
}

export interface LoadNoticesOptions {
  /** true で重要なお知らせを既読含め全件、false で未読のみ。 */
  expandImportant?: boolean;
  /** true で一般のお知らせを全件、false で最新 ANNOUNCEMENT_PREVIEW_LIMIT 件。 */
  expandGeneral?: boolean;
  /** true でニュースを全件、false で最新 ANNOUNCEMENT_PREVIEW_LIMIT 件。 */
  expandNews?: boolean;
}

/** notices.astro から呼ぶ。 */
export async function loadNotices(
  diagnosticUserId: string,
  mode: ViewMode,
  opts: LoadNoticesOptions = {},
): Promise<NoticesData | { error: string }> {
  /*
   * デモ用アカウントは DB を見ない (仕様書 §2)。Supabase 未設定・接続不可でも
   * ダミーは出す — ダッシュボードは同じ救済を持っていたが (`dashboard-queries.ts`)
   * ここだけ**エラー画面**になっていた。お披露目の最中に DB が引けなかった回に
   * お知らせだけ落ちるのは、デモの目的 (§1) に反する。
   * 氏名はダミーなので `お客様` 固定 (DB を引かない以上ここでは分からない)。
   */
  const sb = getServerSupabase();
  if (shouldUseDemoData(diagnosticUserId, mode) && !sb) {
    return buildDemoNotices(diagnosticUserId, 'お客様');
  }
  if (!sb) return { error: 'Supabase が未設定です。.env.local を確認してください。' };

  const dsb = sb.schema('diagnosis');

  // 重要なお知らせ: 未読のみ or 既読含め全件
  let importantQuery = dsb
    .from('user_notices')
    .select('*')
    .eq('diagnostic_user_id', diagnosticUserId)
    .order('published_at', { ascending: false });
  if (!opts.expandImportant) {
    importantQuery = importantQuery.is('read_at', null);
  }

  // 一般のお知らせ / ニュース: プレビュー (3件) or 全件。
  // visible_on_web=true のみ表示 (HP 管理画面の掲載面トグルを尊重)。
  let generalQuery = dsb
    .from('announcements')
    .select('*')
    .eq('category', 'general')
    .eq('visible_on_web', true)
    .order('published_at', { ascending: false });
  if (!opts.expandGeneral) generalQuery = generalQuery.limit(ANNOUNCEMENT_PREVIEW_LIMIT);

  let newsQuery = dsb
    .from('announcements')
    .select('*')
    .eq('category', 'news')
    .eq('visible_on_web', true)
    .order('published_at', { ascending: false });
  if (!opts.expandNews) newsQuery = newsQuery.limit(ANNOUNCEMENT_PREVIEW_LIMIT);

  const [
    { data: appUser, error: userErr },
    { data: importantRaw, error: importantErr },
    { count: unreadCount, error: unreadErr },
    { data: generalRaw, error: generalErr },
    { data: newsRaw, error: newsErr },
  ] = await Promise.all([
    dsb.from('app_users').select('display_name_cache').eq('diagnostic_user_id', diagnosticUserId).maybeSingle(),
    importantQuery,
    dsb
      .from('user_notices')
      .select('id', { count: 'exact', head: true })
      .eq('diagnostic_user_id', diagnosticUserId)
      .is('read_at', null),
    generalQuery,
    newsQuery,
  ]);

  // 敬称の付け方はダッシュボードと揃える (氏名のみで届く連携元があるため)。
  const userName = appUser?.display_name_cache ? withHonorific(appUser.display_name_cache) : 'お客様';

  /*
   * デモ用アカウントは **DB の中身にかかわらず** ダミーのお知らせを出す。
   * 正本 `docs/operations/デモ用アカウント_仕様書.md` §2 —「ダミー = 出す / 実データ = —」。
   * 以前は「エラー もしくは 全部空のときだけ」だったが、それは仕様書より前の
   * 「実データが空のときだけダミーへ」に沿った条件で、**実データが 1 件でもあると
   * デモの画面が歯抜けになる** (ダッシュボード側と同じ誤り・2026-09-05 修正)。
   */
  if (shouldUseDemoData(diagnosticUserId, mode)) {
    return buildDemoNotices(diagnosticUserId, userName);
  }

  if (userErr)      return { error: `app_users: ${userErr.message}` };
  if (importantErr) return { error: `user_notices: ${importantErr.message}` };
  if (unreadErr)    return { error: `user_notices(count): ${unreadErr.message}` };
  if (generalErr)   return { error: `announcements(general): ${generalErr.message}` };
  if (newsErr)      return { error: `announcements(news): ${newsErr.message}` };

  return {
    diagnosticUserId,
    userName,
    important: importantRaw ?? [],
    importantUnreadCount: unreadCount ?? 0,
    general: generalRaw ?? [],
    news: newsRaw ?? [],
  };
}

/**
 * ヘッダーのバッジ用 — 未読の重要なお知らせ件数。
 * Supabase 未設定や該当なしは 0 を返す (画面側でバッジ非表示)。
 */
export async function countUnreadImportant(diagnosticUserId: string, mode: ViewMode): Promise<number> {
  // デモ用アカウントはバッジも DB を見ない (本文と件数が食い違わないように)。
  if (shouldUseDemoData(diagnosticUserId, mode)) return demoUnreadImportant();
  const sb = getServerSupabase();
  if (!sb) return 0;
  const { count, error } = await sb
    .schema('diagnosis')
    .from('user_notices')
    .select('id', { count: 'exact', head: true })
    .eq('diagnostic_user_id', diagnosticUserId)
    .is('read_at', null);
  if (error) return 0;
  return count ?? 0;
}
