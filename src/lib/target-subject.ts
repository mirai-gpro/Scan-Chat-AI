/**
 * **対象者の属性（生年月日・性別）をサーバ側で取り直す。**
 * 正本: `docs/specs/secure_shared_access_and_admin_impersonation_spec_20260930.md` §19.5。
 *
 * 【なぜ要るか】AI 問診の書き出しは、これまで `dateOfBirth` / `sex` / `userName` を
 * **クライアントの `userProfile` からそのまま受け取って**いた
 * （`live-controller.ts` → `api/interview/export.ts`）。
 * `api/interview/export.ts` のコメントには「年齢算出のみ (保存しない)」とあるが、
 * **これは「DB に保存しない」という意味であって、出力に影響しないという意味ではない** —
 * 年齢と性別は `LifestyleQuestionnaireData` の JSON に載り、**Elith の AI 診断の入力**になる。
 *
 * → **UID だけを Target Lock しても足りない。** profile を差し替えれば、
 *   **対象者本人の正式な AI 入力を汚染できる**。だからここで取り直す。
 *
 * 【取れなければ「不明」にする】クライアントの値で埋めない（捏造ゼロ）。
 *
 * 【`elith-delivery.ts` の `makeSubjectResolver` と同旨】あちらは納品バッチ用に
 * キャッシュを持つ内部関数なので、**触らずに同じ取得順を写す**
 * （customer_profiles → スペシャルアカウント登録値）。
 */

import { getServerSupabase } from './supabase';
import { specialSubjectByUid } from './special-accounts';

export interface TargetSubject {
  /** `YYYY-MM-DD`。取れなければ null。 */
  dateOfBirth: string | null;
  sex: 'male' | 'female' | null;
}

function normSex(v: unknown): 'male' | 'female' | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'm' || s === 'male' || s === '男' || s === '男性') return 'male';
  if (s === 'f' || s === 'female' || s === '女' || s === '女性') return 'female';
  return null;
}

/**
 * uid → 生年月日・性別。**customer が正**で、欠けている項目だけスペシャル登録値で補う。
 * **例外を投げない** — 取れなければ `{null,null}`（呼び出し側は「不明」として出す）。
 */
export async function resolveTargetSubject(uid: string | null | undefined): Promise<TargetSubject> {
  const empty: TargetSubject = { dateOfBirth: null, sex: null };
  if (!uid) return empty;

  let out: TargetSubject = { ...empty };
  try {
    const sb = getServerSupabase();
    if (sb) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (sb.schema('customer') as any)
        .from('customer_profiles')
        .select('date_of_birth, sex')
        .eq('diagnostic_user_id', uid)
        .maybeSingle();
      if (data) {
        const dob = typeof data.date_of_birth === 'string' ? data.date_of_birth.slice(0, 10) : null;
        out = {
          dateOfBirth: /^\d{4}-\d{2}-\d{2}$/.test(dob ?? '') ? dob : null,
          sex: normSex(data.sex),
        };
      }
    }
  } catch {
    /* customer 未設定・権限無しは非充填で継続 */
  }

  if (!out.dateOfBirth || !out.sex) {
    try {
      const sp = specialSubjectByUid(uid);
      if (sp) {
        out = {
          dateOfBirth: out.dateOfBirth ?? sp.dateOfBirth,
          sex: out.sex ?? sp.sex,
        };
      }
    } catch {
      /* 登録が無ければ従来どおり */
    }
  }
  return out;
}
