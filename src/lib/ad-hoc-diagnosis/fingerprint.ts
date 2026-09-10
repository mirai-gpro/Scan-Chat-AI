// src/lib/ad-hoc-diagnosis/fingerprint.ts
// 臨時診断バッチ: 再開時に「この人物 = この client_id」を結び直すための fingerprint。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §6.2
//
// **材料はファイルの中身のハッシュだけ。** 氏名・フォルダ名・ファイル名を一切使わない。
//
// **平文の PII は含まないが、特定の個人の検査ファイル群に 1 対 1 で対応する照合用識別子**
// なので、**機微情報と同等に扱う** (ログに出さない・外部へ渡さない・納品 JSON に載せない・
// 画面に出すときも先頭数文字に留める)。
//
// **一意識別子ではない。再開時の照合用の「検索キー」** (spec §6.2.5.1)。
// 同じ fp が複数人物に付き得ることを仕様として認めており、DB の索引も UNIQUE ではない。
import { createHash } from 'node:crypto';

/** 64 桁の 16 進小文字か。 */
const HEX64 = /^[0-9a-f]{64}$/;

export function isSha256Hex(v: unknown): v is string {
  return typeof v === 'string' && HEX64.test(v);
}

/** バイト列の SHA-256 を 16 進小文字で返す (サーバ側)。 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 人物 1 人ぶんの fingerprint。
 *
 *   subject_fp = SHA-256( そのフォルダに属するファイルの content SHA-256 を
 *                         16 進小文字で昇順ソートし "\n" で連結した文字列 )
 *
 * - **昇順ソート**するので、ZIP のエントリ順や読み取り順が変わっても同じ値になる。
 * - 同じ ZIP を選び直せば**バイトが同じ = 必ず同じ値**になる。
 * - 材料の sha256 は `ad_hoc_diagnosis_files.sha256` として既に保存する値
 *   (§23.3) なので、**新しい保存物を増やさない**。
 *
 * @param fileHashes その人物に属するファイルの content SHA-256 (16 進小文字)
 * @returns 64 桁の 16 進小文字。**材料が 0 件なら null** (推測で値を作らない)
 */
export function subjectFingerprint(fileHashes: readonly string[]): string | null {
  const clean = fileHashes.filter(isSha256Hex);
  if (clean.length === 0) return null;
  // **重複は畳まない。** 同じ中身のファイルが 2 つある人物と 1 つの人物は別物なので、
  // 畳むと取り違える。並びだけを揃える。
  const sorted = [...clean].sort();
  return createHash('sha256').update(sorted.join('\n'), 'utf8').digest('hex');
}

/** 画面に出すときの短縮形。**全体をそのまま表示しない** (§6.2.1)。 */
export function shortFingerprint(fp: string | null | undefined): string {
  if (!isSha256Hex(fp)) return '—';
  return fp.slice(0, 8);
}

export type FpMatchKind = 'unmatched' | 'match' | 'fp_collision';

export interface FpMatchResult {
  kind: FpMatchKind;
  /** `match` のときだけ入る。 */
  clientId: string | null;
  /** `fp_collision` のとき、needs_review にすべき subject の id (全件)。 */
  collided: string[];
}

/**
 * 再開時の照合 (§6.2.3)。**ヒット件数だけで決める。**
 *
 *   0 件      → `unmatched`     (推測で寄せない。needs_review にする)
 *   1 件      → `match`         (その client_id を使う)
 *   2 件以上  → `fp_collision`  (**該当 subject を全件 needs_review**。自動で片方に寄せない)
 *
 * **`subject_fp` に UNIQUE を置かないのはこの 3 分岐のため** — UNIQUE があると
 * 2 人目の INSERT が失敗し「両方残す」が実行できない (§6.2.5.1)。
 */
export function matchByFingerprint(
  candidates: readonly { id: string; client_id: string | null }[],
): FpMatchResult {
  if (candidates.length === 0) return { kind: 'unmatched', clientId: null, collided: [] };
  if (candidates.length === 1) {
    return { kind: 'match', clientId: candidates[0].client_id, collided: [] };
  }
  return { kind: 'fp_collision', clientId: null, collided: candidates.map((c) => c.id) };
}
