/**
 * **スペシャルアカウントの「登録メールだけを差し替える」決定論ロジック。**
 *
 * 正本: `docs/operations/スペシャルアカウント_仕様書.md`。
 *
 * 【なぜ要るか — 2026-10-15 の実務】トランスコスモス 2 名の登録メールが確定したが、
 * 既存の口は `remove_email` → `add_email` しか無い。その 2 段操作は
 *   ① `remove_email` が **uid を `special.account_uids` からも外す**
 *   ② 続く `add_email` が「新規メール」と判定して **`mintSpecialUid()` で別 uid を採番する**
 * ため、**同じ人の `diagnostic_user_id` が変わってしまう**。uid が変わると
 * `test_artifacts` / `diagnosis_results` / 報告書 PDF の紐付けが全部外れる。
 *
 * → **uid と label は動かさず、`hash` と `masked` だけを差し替える**操作を用意する。
 *
 * 【ここは純ロジック】DB も鍵も触らない。**ハッシュ化は呼び出し側で済ませて渡す**
 * (`hashEmail()` を 2 重に実装しないため)。だから鍵もサーバも無い所で検査できる。
 *
 * 【fail-closed】1 件でも条件を満たさなければ **何も変更しない**。
 * 部分適用は「片方だけメールが変わった」状態を作り、どちらが正か分からなくなる。
 */
import type { DemoEmailEntry } from './demo-accounts';
import type { SpecialDobEntry } from './special-accounts';

/** 1 件の差し替え指示。**生のアドレスは受け取らない** (ハッシュ済みを渡す)。 */
export interface ReplaceEmailItem {
  oldHash: string;
  newHash: string;
  /** 維持されるべき uid。**照合用** — 取り違え防止のため必須にする。 */
  expectedUid: string;
  /** 新しいメールのマスク表記 (`maskEmail()` の結果)。 */
  newMasked: string;
}

export interface ReplaceEmailError {
  /** どの指示が落ちたか。**マスクで示す** (生アドレスもハッシュ全体も返さない)。 */
  old_masked: string;
  code:
    | 'same_email' | 'old_email_not_registered' | 'uid_mismatch' | 'uid_not_entitled'
    | 'new_email_already_registered' | 'demo_email_conflict' | 'dob_conflict'
    | 'duplicate_in_request' | 'invalid_input';
  detail: string;
  /** この口が返す HTTP ステータス。 */
  status: 404 | 409 | 400;
}

export interface ReplaceEmailRow {
  /** 変わらないもの。 */
  uid: string;
  label: string;
  /** 変わるもの (マスクだけ返す)。 */
  old_masked: string;
  new_masked: string;
  /** 生年月日の行を一緒に移したか。**値は変えない。** */
  dob_moved: boolean;
}

export interface ReplaceEmailPlan {
  errors: ReplaceEmailError[];
  /** errors が空のときだけ意味を持つ。 */
  emails: DemoEmailEntry[];
  dob: SpecialDobEntry[];
  rows: ReplaceEmailRow[];
}

const HASH_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 差し替えを**計画するだけ**。呼び出し側が `errors` が空であることを確かめてから保存する。
 *
 * - `uid` と `label` は**維持**する（この関数はそこへ書かない）。
 * - `special.account_uids` は**触らない**（引数にも取らず、照合にだけ使う）。
 * - DOB 行は **hash だけ**付け替える。`dob` / `sex` の値は 1 文字も変えない。
 */
export function planEmailReplace(input: {
  emails: readonly DemoEmailEntry[];
  dob: readonly SpecialDobEntry[];
  items: readonly ReplaceEmailItem[];
  /** `demo.account_emails` のハッシュ集合。**デモ枠と混ざっていたら止める。** */
  demoEmailHashes: ReadonlySet<string>;
  /** `special.account_uids` に載っている uid 集合（資格が立っていることの確認）。 */
  specialUids: ReadonlySet<string>;
}): ReplaceEmailPlan {
  const emails = input.emails.map((e) => ({ ...e }));
  const dob = input.dob.map((d) => ({ ...d }));
  const errors: ReplaceEmailError[] = [];
  const rows: ReplaceEmailRow[] = [];

  const seenOld = new Set<string>();
  const seenNew = new Set<string>();

  for (const it of input.items) {
    const oldHash = String(it.oldHash ?? '').trim().toLowerCase();
    const newHash = String(it.newHash ?? '').trim().toLowerCase();
    const expectedUid = String(it.expectedUid ?? '').trim().toLowerCase();
    const at = emails.findIndex((e) => e.hash === oldHash);
    /** エラー表示用。行が見つからなければハッシュの先頭だけ出す（全体は出さない）。 */
    const shown = at >= 0 ? emails[at].masked : `(hash:${oldHash.slice(0, 8)}…)`;
    const push = (code: ReplaceEmailError['code'], detail: string, status: ReplaceEmailError['status']) => {
      errors.push({ old_masked: shown, code, detail, status });
    };

    if (!HASH_RE.test(oldHash) || !HASH_RE.test(newHash) || !UUID_RE.test(expectedUid)) {
      push('invalid_input', 'old_email / new_email / expected_uid のどれかが不正。', 400);
      continue;
    }
    if (oldHash === newHash) {
      push('same_email', '正規化すると同じアドレス。変更する必要が無い。', 409);
      continue;
    }
    if (seenOld.has(oldHash) || seenNew.has(newHash) || seenOld.has(newHash) || seenNew.has(oldHash)) {
      push('duplicate_in_request', '同じリクエストの中で同じアドレスを 2 度扱っている。', 409);
      continue;
    }
    if (at < 0) {
      push('old_email_not_registered', '旧メールが special.account_emails に無い。', 404);
      continue;
    }
    if (emails[at].uid !== expectedUid) {
      push('uid_mismatch', `旧メール行の uid が expected_uid と違う (行=${emails[at].uid || '(空)'} / 指定=${expectedUid})。`, 409);
      continue;
    }
    if (!input.specialUids.has(expectedUid)) {
      push('uid_not_entitled', 'その uid が special.account_uids に無い。資格が立っていない状態では触らない。', 409);
      continue;
    }
    if (emails.some((e, i) => i !== at && e.hash === newHash)) {
      push('new_email_already_registered', '新メールが既に別の行として登録されている。', 409);
      continue;
    }
    if (input.demoEmailHashes.has(oldHash) || input.demoEmailHashes.has(newHash)) {
      push('demo_email_conflict', 'そのアドレスが demo.account_emails にも在る。デモ枠と混ざるので触らない。', 409);
      continue;
    }
    const oldDobAt = dob.findIndex((d) => d.hash === oldHash);
    const newDobAt = dob.findIndex((d) => d.hash === newHash);
    if (oldDobAt >= 0 && newDobAt >= 0) {
      push('dob_conflict', '新メール側に既に生年月日の行が在る。勝手に上書きしない。', 409);
      continue;
    }

    seenOld.add(oldHash);
    seenNew.add(newHash);

    const kept = emails[at];
    rows.push({
      uid: kept.uid, label: kept.label,
      old_masked: kept.masked, new_masked: it.newMasked,
      dob_moved: oldDobAt >= 0,
    });
    // **hash と masked だけ差し替える。** uid / label はそのまま。
    emails[at] = { ...kept, hash: newHash, masked: it.newMasked };
    // DOB は hash の付け替えだけ。dob / sex の値は変えない。
    if (oldDobAt >= 0) dob[oldDobAt] = { ...dob[oldDobAt], hash: newHash };
  }

  // **fail-closed** — 1 件でも落ちたら変更後の配列を返さない（呼び出し側の事故防止）。
  if (errors.length > 0) {
    return { errors, emails: input.emails.map((e) => ({ ...e })), dob: input.dob.map((d) => ({ ...d })), rows: [] };
  }
  return { errors, emails, dob, rows };
}
