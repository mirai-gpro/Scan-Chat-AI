// src/lib/ad-hoc-diagnosis/questionnaire-branch.ts
// 臨時診断バッチ: 問診の **Phase B — production の分岐 (`QUESTIONS[].when`) を最終 answers へ適用する**。
// 正本: 最終指示書 §3.2 / §4 / §5。
//
//   raw XLSX
//     ↓  Phase A (external-form-contract.ts の決定論写像)
//   tentative answers
//     ↓  ここ: production `resolvePath()` を**共用**して分岐を適用
//   active answers
//     ↓
//   buildElithInterviewJson()          ← **既存関数だけ。新しい JSON 生成を作らない。**
//
// **独自の when ロジックをコピーしない** (§3.2)。`interview-script.ts` の
// `resolvePath()` をそのまま呼ぶ。production で質問されない設問は、外部フォームに
// 値があっても納品 answers へ入れない。
//
// **ただし黙って医療情報を捨てない** (§3.2)。非該当を示す値 (なし / 摂取していない /
// 空欄 / 0) なら通常の branch ignore だが、**非該当なのに実質的な値が入っていれば矛盾**
// なので `needs_review` にして人へ渡す。

import {
  QUESTIONS,
  resolvePath,
  type AnswerValue,
  type Answers,
} from '../../scripts/chat/interview-script';
import { normalizeForm } from './external-form-contract';
import type { QuestionnaireNormalized } from './questionnaire';
import {
  manualQuestionnaire,
  type ManualQuestionnaireRecord,
  manualRecordIsConfirmed,
} from './questionnaire-manual';

/**
 * 非該当のとき、**値の中身に関わらず** branch ignore にする設問。
 *
 * 最終指示書 §3.2「明確な例」が
 *   `E-FREQ = ほとんどしない` → `E-TIME`, `E-TYPE` は production では質問しない
 *   → **XLSX に値があっても**納品 answers へ入れない → `ignored_by_branch`
 * と明記しているため。運動の時間・種類は落としても医療情報が失われない、という判断。
 *
 * **服薬・喫煙・飲酒はここに入れない** — §3.2 が名指しで「黙って薬情報を捨てない」
 * 「非該当なのに実質的な値が入っていれば needs_review」としている。
 */
export const BRANCH_IGNORE_ALWAYS: ReadonlySet<string> = new Set(['E-TIME', 'E-TYPE']);

/**
 * 「非該当」を示す値。ここに当たれば通常の branch ignore (§3.2)。
 *
 * **近い表現へ寄せない。** 一覧に無い文字列は「実質的な内容」として扱い、人へ渡す。
 * 外部フォームの入力例が `0` を非該当としている列 (喫煙年数等) があるので 0 も含む。
 */
const BENIGN_INACTIVE = new Set(
  [
    'なし', 'ない', '無し', '無', '特になし', '該当なし', '該当するものはない',
    '摂取していない', '服用していない', '飲んでいない', '吸っていない',
    '0', '-', '‐', 'ー', '―', '−', '/', 'n/a', 'na', 'none',
  ].map((s) => normalizeForm(s)),
);

/** その値は「非該当」を示すだけのものか。 */
export function isBenignInactiveValue(v: AnswerValue | undefined): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'number') return v === 0;
  if (Array.isArray(v)) return v.length === 0 || v.every((x) => isBenignInactiveValue(x as AnswerValue));
  if (typeof v === 'object') {
    // matrix (行→列) は分岐設問に無いが、来たら中身で判断する。
    return Object.values(v as Record<string, unknown>).every((x) => isBenignInactiveValue(x as AnswerValue));
  }
  const t = normalizeForm(v);
  return t === '' || BENIGN_INACTIVE.has(t);
}

export interface BranchOutcome {
  /** production で質問される設問だけ。**これが納品 answers。** */
  answers: Record<string, AnswerValue>;
  /** 分岐で落とした設問 id (監査用)。 */
  ignoredByBranch: string[];
  /** 非該当なのに実質的な値が入っていた設問 id (= 矛盾 → `needs_review`)。 */
  contradictions: string[];
  /** Phase A の要確認のうち、分岐適用後も残るもの。 */
  reviewQuestionIds: string[];
}

/**
 * production の `when` を適用する。
 *
 * @param tentative Phase A が写像できた answers (まだ分岐を見ていない)
 * @param pendingReviewIds Phase A で判断できなかった設問 id (値は answers に無い)
 */
export function applyProductionBranches(
  tentative: Readonly<Record<string, AnswerValue>>,
  pendingReviewIds: readonly string[] = [],
): BranchOutcome {
  // **production の関数をそのまま使う。** 同じ条件式を書き写さない (§3.2)。
  const active = new Set(resolvePath(tentative as Answers));

  const answers: Record<string, AnswerValue> = {};
  const ignoredByBranch: string[] = [];
  const contradictions: string[] = [];

  for (const [id, value] of Object.entries(tentative)) {
    // 問診票に無い id は production の分岐が判断できない。そのまま残す
    // (`buildElithInterviewJson` が ORDER 外として末尾に付ける既存の振る舞い)。
    if (!QUESTIONS[id]) { answers[id] = value; continue; }
    if (active.has(id)) { answers[id] = value; continue; }

    if (BRANCH_IGNORE_ALWAYS.has(id) || isBenignInactiveValue(value)) {
      ignoredByBranch.push(id);
      continue;
    }
    /*
     * **非該当なのに実質的な値。** 例: `M-HAS=ない` なのに実薬名 / 非喫煙なのに喫煙本数。
     * どちらが正しいかはここでは決められない (回答者の入力の矛盾) ので、
     * **黙って捨てず**に人へ渡す。§4 によりこれが 1 件でもあれば納品しない。
     */
    contradictions.push(id);
  }

  const reviewQuestionIds: string[] = [];
  for (const id of pendingReviewIds) {
    if (!QUESTIONS[id]) { reviewQuestionIds.push(id); continue; }
    if (active.has(id)) { reviewQuestionIds.push(id); continue; }
    // production が質問しない設問の要確認は人へ渡す意味が無い。
    if (BRANCH_IGNORE_ALWAYS.has(id)) { ignoredByBranch.push(id); continue; }
    /*
     * 非該当なのに**読めない値が入っていた**。Phase A は空欄を `skipped` にするので、
     * ここへ来た時点で中身は空ではない = 矛盾として扱う (中身が分からない以上、
     * 「非該当を示すだけの値だった」とは言い切れない)。
     */
    reviewQuestionIds.push(id);
  }

  return { answers, ignoredByBranch, contradictions, reviewQuestionIds: dedup(reviewQuestionIds) };
}

function dedup(xs: readonly string[]): string[] {
  return Array.from(new Set(xs));
}

// ---------------------------------------------------------------------------
// 手入力の上書きを混ぜて最終形にする (§5.2 merge)
// ---------------------------------------------------------------------------

/**
 *   deterministic answers + confirmed manual overrides → production 分岐 → final answers
 *
 * **確認済みの手入力だけを混ぜる** (`manualRecordIsConfirmed`)。入力しただけのものは
 * 使わない — 写し間違いを別の目で見るところまでが仕様 (§5 / spec §7.4)。
 *
 * @param base  XLSX の Phase A 結果。PDF のように材料が無ければ null。
 * @param rec   保存済みの手入力。無ければ null。
 */
export function finalizeQuestionnaire(
  base: QuestionnaireNormalized | null,
  rec: ManualQuestionnaireRecord | null,
): QuestionnaireNormalized | null {
  const confirmed = rec && manualRecordIsConfirmed(rec) ? rec : null;
  if (!base && !confirmed) return null;

  // 手入力は**既存の検証器を通す**。新しい自由形式 parser を作らない (§5)。
  const manual = confirmed
    ? manualQuestionnaire({
      entries: confirmed.entries, completedAt: confirmed.completedAt,
      sex: confirmed.sex, age: confirmed.age,
    })
    : null;

  const src: QuestionnaireNormalized = base ?? manual!.normalized;

  const tentative: Record<string, AnswerValue> = { ...src.answers };
  const overridden: string[] = [];
  if (base && manual) {
    for (const [id, v] of Object.entries(manual.normalized.answers)) {
      tentative[id] = v;
      overridden.push(id);
    }
  }

  // 手入力で埋まった設問は Phase A の要確認から外れる。
  const stillPending = (src.reviewQuestionIds ?? []).filter((id) => !overridden.includes(id));

  const branch = applyProductionBranches(tentative, stillPending);

  // 被験者属性の要確認も、手入力が値を出していれば解消する。
  const subjectReview = (src.subjectReview ?? []).filter((k) => {
    if (!manual) return true;
    if (k === 'sex') return manual.normalized.subject.sex === null;
    if (k === 'birth_date') return manual.normalized.subject.age === null;
    if (k === 'completed_at') return manual.normalized.completedAt.status !== 'resolved';
    return true;
  });

  const subject = {
    sex: manual?.normalized.subject.sex ?? src.subject.sex,
    age: manual?.normalized.subject.age ?? src.subject.age,
  };
  const completedAt =
    manual && manual.normalized.completedAt.status === 'resolved'
      ? manual.normalized.completedAt
      : src.completedAt;

  const reviewQuestionIds = dedup([...branch.reviewQuestionIds, ...branch.contradictions]);
  const notes = [...src.notes];
  if (branch.contradictions.length > 0) notes.push('branch_contradiction');
  if (manual) notes.push(base ? 'manual_override_applied' : 'manual_entry');

  return {
    ...src,
    answers: branch.answers,
    subject,
    completedAt,
    mappedCount: Object.keys(branch.answers).length,
    ignoredBySpec: src.ignoredBySpec,
    ignoredByBranch: branch.ignoredByBranch.length,
    reviewQuestionIds,
    subjectReview,
    // **納品の可否はこの数で決まる** (§4)。
    needsReviewCount: reviewQuestionIds.length + subjectReview.length,
    // 手入力で弾かれたものは画面へ出すが、中身は保存しない。
    // base が無いとき `src` は手入力そのものなので、足すと二重になる。
    unmapped: base && manual ? [...src.unmapped, ...manual.rejected] : src.unmapped,
    notes,
  };
}
