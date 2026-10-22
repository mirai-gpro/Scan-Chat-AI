/**
 * ════════════════════════════════════════════════════════════════════════════
 * **デモ／スペシャルの名簿を「1 人 1 行」にまとめて読む (PR-E)**
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 正本 `docs/specs/special_demo_integration_spec_20261022.md` §4.5 (＋裁定 7)。
 *
 * 【なぜ要るか】PR-B で **1 人 = 1 canonical `diagnostic_user_id`** になり、
 * **Demo 資格と Real(Special) 資格を同時に持てる (Dual)** のが正常な状態になった。
 * ところが admin 画面は名簿ごとに 2 枚あり、**同じ人が 2 か所に別々の行として出る**。
 * 片方だけを見て操作すると、資格の付け外しが噛み合っているかが分からない
 * (裁定 7「正規入口を一本化」「旧 API 経由で UID 分裂を再発させない」)。
 *
 * 【この層の責務は読むだけ】**書き込みの口は 1 つも作らない。**
 * 登録・削除・除外は既存の `/api/admin/demo-accounts` と
 * `/api/admin/special-accounts` のまま (どちらも PR-B で
 * `canonicalUidForRegistration` を通る)。**uid の採番はこの層に無い** —
 * 新しい採番の口を作ると裁定 7 が禁じた「UID 分裂の経路」が増える。
 *
 * 【PII】**メールの現物も生年月日の実値も返さない。**
 * メールは sha256 とマスク、生年月日は「登録済みか」とマスクだけ
 * (既存 `api/admin/special-accounts.ts` の `present()` と同じ約束)。
 */
import {
  demoDisabledGlobally,
  demoEmailEntries,
  listDemoAccounts,
  type DemoAccountRow,
} from './demo-accounts';
import {
  listSpecialAccounts,
  parseDobEntries,
  specialEmailEntries,
  type SpecialAccountRow,
} from './special-accounts';
import { detectConflict, experienceCapabilities, type UidConflict } from './experience-accounts';

/** 片方の名簿における、その人の状態。 */
export interface SideState {
  /** その名簿に行が在るか (メール行 または uid 行)。 */
  registered: boolean;
  /** 記録済みの `diagnostic_user_id` (無ければ '')。 */
  uid: string;
  /** メモ。 */
  label: string;
  /** uid 行の出どころ。メール行だけのときは ''。 */
  source: DemoAccountRow['source'] | SpecialAccountRow['source'] | '';
  /** 除外リストに入っていて、いま資格が止まっているか。 */
  denied: boolean;
}

const emptySide = (): SideState => ({ registered: false, uid: '', label: '', source: '', denied: false });

export interface ExperienceAccountRow {
  /** 行の鍵。メール登録なら sha256、uid 直接の行なら uid。**人の同一性はこれで見る。** */
  key: string;
  /** メール登録の行か、uid を直接足した行か。 */
  kind: 'email' | 'uid';
  /** メールの sha256 (uid 行では '')。 */
  hash: string;
  /** 表示用マスク (uid 行では '')。**現物は返さない。** */
  masked: string;
  /**
   * canonical `diagnostic_user_id`。
   * **Real(Special) 側を優先する** — `resolveCanonicalUidByEmail` と同じ順序
   * (実データが紐づく側を正とする)。
   */
  uid: string;
  /** 画面に出すメモ。Real 側を優先し、無ければ Demo 側。 */
  label: string;
  demo: SideState;
  special: SideState;
  /** **いま実際にダミーを見られるか** (資格の関数が正。`registered` とは別)。 */
  canDemo: boolean;
  /** **いま実際に実データを扱えるか。** */
  canReal: boolean;
  /** 両方の資格を持つ = Dual。**正常な状態。** */
  dual: boolean;
  /** 両方に uid が在って値が違う = 人の判断が要る (自動統合しない)。 */
  conflict: UidConflict | null;
  /** 生年月日が登録されているか (Real 側だけの項目)。 */
  hasDob: boolean;
  /** `****-**-**` か ''。**実値は返さない。** */
  dobMasked: string;
  /** `male` / `female` / ''。 */
  sex: string;
}

export interface ExperienceAccountList {
  rows: ExperienceAccountRow[];
  counts: {
    total: number;
    /** Demo の資格だけを持つ人。 */
    demoOnly: number;
    /** Real の資格だけを持つ人。 */
    realOnly: number;
    /** 両方の資格を持つ人 (Dual)。 */
    dual: number;
    /** どちらの資格も立っていない人 (uid 未発行・除外中など)。 */
    neither: number;
    /** uid が食い違っている人。**0 でなければ人が見る。** */
    conflicts: number;
  };
  /** `PUBLIC_DEMO_FALLBACK=false` でダミー表示が全停止しているか。 */
  demoDisabledGlobally: boolean;
  /**
   * **管理者リストからの初回登録を済ませたか** (空なら未実施)。
   * デモ枠だけの仕組み (発注者指示 2026-08-30)。目印が入ったら**二度と走らせない** —
   * 毎回走らせると、画面から外した人が次のアクセスで黙って戻り「外す」が効かなくなる。
   * **PII ではない** (日付などの目印の文字列だけ)。
   */
  seededFromAdmins: string;
}

/**
 * **2 つの名簿を 1 人 1 行にまとめる。**
 *
 * 【束ね方】
 *   ① メール登録の行は **sha256 が同じなら同じ人** (名簿を跨いで束ねる唯一の鍵)
 *   ② uid 直接の行は、①のどれかの `uid` と一致すればその行へ畳む。
 *      一致しなければ `kind:'uid'` の行として出す (**黙って捨てない**)
 *
 * 【uid の決め方】**Real(Special) を優先**。`resolveCanonicalUidByEmail` と
 * 同じ順序なので、画面に出る uid とサインイン時に採られる uid が食い違わない。
 *
 * 呼び出し側 (API) が `refreshConfig(true)` を済ませてから呼ぶこと
 * (この関数は app_config を読むだけで取りに行かない)。
 */
export function listExperienceAccounts(): ExperienceAccountList {
  const demo = listDemoAccounts();
  const special = listSpecialAccounts();
  const dobByHash = new Map(parseDobEntries(special.dobRaw).map((d) => [d.hash, d]));

  const byKey = new Map<string, ExperienceAccountRow>();
  const blank = (key: string, kind: 'email' | 'uid'): ExperienceAccountRow => ({
    key, kind, hash: '', masked: '', uid: '', label: '',
    demo: emptySide(), special: emptySide(),
    canDemo: false, canReal: false, dual: false, conflict: null,
    hasDob: false, dobMasked: '', sex: '',
  });

  // ── ① メール登録の行 (hash で束ねる) ────────────────────────────────
  for (const [side, entries] of [
    ['special', specialEmailEntries()] as const,
    ['demo', demoEmailEntries()] as const,
  ]) {
    for (const e of entries) {
      const row = byKey.get(e.hash) ?? blank(e.hash, 'email');
      row.hash = e.hash;
      // マスクは**先に入れた側を残す** (同じ人なら同じマスクなので差は出ない)。
      if (!row.masked) row.masked = e.masked;
      row[side] = { registered: true, uid: (e.uid ?? '').trim().toLowerCase(), label: e.label ?? '', source: '', denied: false };
      byKey.set(e.hash, row);
    }
  }

  // ── ② uid 行 (出どころ・除外中を載せる / 畳めなければ独立した行) ──────
  const uidToKey = new Map<string, string>();
  for (const row of byKey.values()) {
    for (const u of [row.special.uid, row.demo.uid]) if (u) uidToKey.set(u, row.key);
  }
  for (const [side, rows] of [
    ['special', special.rows] as const,
    ['demo', demo.rows] as const,
  ]) {
    for (const r of rows) {
      const uid = r.uid.trim().toLowerCase();
      const key = uidToKey.get(uid) ?? uid;
      const row = byKey.get(key) ?? blank(key, 'uid');
      if (row.kind === 'uid') row.uid = uid;
      const prev = row[side];
      row[side] = {
        registered: true,
        uid: prev.uid || uid,
        label: prev.label || r.label || '',
        source: r.source,
        denied: r.denied === true,
      };
      byKey.set(key, row);
      if (!uidToKey.has(uid)) uidToKey.set(uid, key);
    }
  }

  // ── 仕上げ: canonical uid・資格・競合・生年月日のマスク ─────────────
  const rows = [...byKey.values()].map((row) => {
    /*
     * **Real を優先する。** 片方しか無ければそれを採る。
     * 食い違っていたら `conflict` に出すが、**どちらかを自動で選んで
     * 「正しい uid」として見せない** (人が判断する・裁定 6)。
     */
    row.uid = row.special.uid || row.demo.uid || row.uid;
    row.label = row.special.label || row.demo.label || '';
    row.conflict = detectConflict(row.demo.uid || null, row.special.uid || null);
    const caps = experienceCapabilities(row.uid || null);
    row.canDemo = caps.canDemo;
    row.canReal = caps.canReal;
    row.dual = caps.dual;
    const d = row.hash ? dobByHash.get(row.hash) : undefined;
    row.hasDob = !!(d && d.dob);
    row.dobMasked = d && d.dob ? '****-**-**' : '';
    row.sex = d?.sex ?? '';
    return row;
  });

  /*
   * 並びは **①競合 → ②Dual → ③Real → ④Demo → ⑤資格なし** のあと鍵順。
   * **人が見るべき行 (競合) を上に出す**のが目的で、ここは表示の都合だけ。
   */
  const rank = (r: ExperienceAccountRow): number =>
    r.conflict ? 0 : r.dual ? 1 : r.canReal ? 2 : r.canDemo ? 3 : 4;
  rows.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));

  return {
    rows,
    counts: {
      total: rows.length,
      demoOnly: rows.filter((r) => r.canDemo && !r.canReal).length,
      realOnly: rows.filter((r) => r.canReal && !r.canDemo).length,
      dual: rows.filter((r) => r.dual).length,
      neither: rows.filter((r) => !r.canDemo && !r.canReal).length,
      conflicts: rows.filter((r) => r.conflict).length,
    },
    demoDisabledGlobally: demoDisabledGlobally(),
    seededFromAdmins: demo.seededFromAdmins,
  };
}
