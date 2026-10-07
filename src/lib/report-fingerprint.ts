/**
 * AI疾病予防報告書の **紙面の指紋 (fingerprint)** — 承認した紙面だけを公開するための照合。
 *
 * 正本: `docs/elith/AI疾病予防報告書_承認と再作成_仕様書.md` §3.3。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【なぜ要るか】紙面は保存されていない
 * ══════════════════════════════════════════════════════════════════════
 * 報告書の紙面は表示のたびに `buildReportVM()` が組む (§0)。つまり **一度承認した
 * あとに生成ロジックを直してデプロイすると、`publish_status='approved'` のまま
 * 紙面だけが変わる**。それでは「管理者が実際に確認した報告書だけを公開する」を
 * 満たさないので、**承認した時点の紙面の指紋を控え、表示時に一致しなければ出さない**。
 *
 * 「生成ロジックを直せば過去分の紙面も新しくなる」という仕組み自体は変えない。
 * 変わったことを**検知して非公開に戻す**のがここの役目で、そのあと管理者が
 * 新しい紙面を確認して再承認する。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【指紋の対象 = 生成ロジックが作る部分だけ】(§3.3.1)
 * ══════════════════════════════════════════════════════════════════════
 * 入れる  … 受領 JSON から組んだ digest / chapters / `cover.testedOn`、
 *           app_config (`report.sections.*`) が決める順序・表示可否・見出し・開閉、
 *           コードの定数 (`sheetVersion` / `cycleTotal` / `axes`)、`cover.issuedOn`
 * 入れない … **閲覧者ごとに注入される値** = `cover.name` / `cover.cycleSeq` /
 *           `cover.chronologicalAge` / `cover.wellnessAge` / `reportType` /
 *           `isSample` / `audit`
 *
 * **これが成り立つ要点**: 入れない値はどれも `buildReportVM` の入力をそのまま
 * 写しているだけなので、**指紋は閲覧者の文脈に依存しない**。だから
 *   承認 API (中立の文脈で組んだ VM) の指紋 == 表示経路 (本人の文脈で組んだ VM) の指紋
 * になり、承認側が閲覧者の文脈 (氏名・実年齢・第 N 回・がんリスク検査の有無) を
 * 再現する必要がない。**再現を要求する設計にすると、少しでも食い違った瞬間に
 * ハッシュが永久に一致せず承認済みの報告書が全件消える** (静かに起きる最悪の形)。
 * この性質は `verify:report-approval` が「文脈を変えても指紋が変わらない」で固定する。
 *
 * **帰結 (仕様書 §3.3.2 に明記)**: これは「紙面の完全一致」ではなく
 * **「受領 JSON・生成ロジック・app_config から生成される承認対象部分の一致」**の保証。
 * 表紙の 2 値 (ウェルネス年齢・実年齢) は閲覧者側の値で描かれるので対象外で、
 * `health_age: null` の回に当社 CABA の値が変わると紙面は動くが指紋は動かない。
 *
 * 【紙面に影響する入力を増やすときは両方へ同じ値を渡す】
 * `BuildInput.selfReported` は本文に「（問診時）」を足す = 紙面を変えるが、
 * **表示経路 (`elith-report-queries.ts` の `common()`) は渡していない**
 * (開発用の PDF 生成だけが使う)。渡すようになったら
 * `FINGERPRINT_CONTEXT` にも同じ値を入れないと指紋が食い違う。
 * `verify:report-approval` が「`common()` が `selfReported` を渡していないこと」を見張る。
 */

import { buildReportVM, type BuildInput, type LabFiles } from './report-adapter';
import type { ReportVM, DigestBlock, MeasurementRow } from './report-model';

/**
 * **正規化の版。** 正規化の形を変えたら上げる = **全件が再承認待ちになる**
 * (指紋が一斉に変わるため)。中身を変えずに形だけ整えるような変更はしない。
 */
export const FINGERPRINT_VERSION = 1;

/**
 * 承認側が `buildReportVM` に渡す**中立の文脈**。
 *
 * ここに入る値は指紋の対象外 (上記) なので、**何を渡しても指紋は変わらない**。
 * 「承認側が閲覧者の文脈を再現しない」ことを 1 か所で示すために定数にしてある。
 */
export const FINGERPRINT_CONTEXT: Omit<BuildInput, 'reportText' | 'checkup' | 'issuedOn'> = {
  name: '',
  isSample: false,
  hasCancerRisk: false,
  cycleSeq: null,
  chronologicalAge: null,
  ourWellnessAge: null,
};

/** 指紋として受け付ける形 (SHA-256 の 16 進 64 文字)。それ以外は「指紋なし」として扱う。 */
const HASH_RE = /^[0-9a-f]{64}$/;

function block(b: DigestBlock): unknown[] {
  switch (b.kind) {
    case 'paragraphs': return ['paragraphs', b.items];
    case 'steps':      return ['steps', b.items.map((i) => [i.heading, i.text])];
    case 'weeks':      return ['weeks', b.items.map((i) => [i.heading, i.text])];
    case 'pairs':      return ['pairs', b.items.map((i) => [i.heading, i.current, i.action])];
    case 'table':      return ['table', b.rows.map(row)];
  }
}

function row(r: MeasurementRow): unknown[] {
  return [r.name, r.value, r.date ?? ''];
}

/**
 * 紙面を**配列 (タプル) へ写す**。
 *
 * オブジェクトのまま `JSON.stringify` すると**鍵の挿入順**が指紋に混ざるので、
 * 位置で意味が決まる配列へ明示的に写す。ここに現れないフィールドは対象外
 * (上のコメントの「入れない」一覧と 1 対 1)。
 */
export function canonicalizeReport(vm: ReportVM): unknown {
  return [
    FINGERPRINT_VERSION,
    vm.cover.sheetVersion,
    vm.cover.issuedOn,
    vm.cover.testedOn ?? '',
    vm.cover.cycleTotal,
    vm.axes.map((a) => [a.key, a.title]),
    vm.digest.map((c) => [
      c.key, c.title, c.axis, c.source, c.detailAnchor ?? '', c.lead === true,
      c.blocks.map(block),
    ]),
    vm.chapters.map((c) => [
      c.key, c.title, c.axis, c.collapsed,
      c.topics.map((t) => [t.anchor, t.heading, t.body]),
      (c.table ?? []).map(row),
    ]),
  ];
}

/** 正規化した紙面の SHA-256 (16 進 64 文字)。 */
export async function reportFingerprint(vm: ReportVM): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalizeReport(vm)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 指紋の照合に要る列だけ。`publish_status` の判定は `report-approval.ts` が持つ。 */
export interface FingerprintRow {
  report?: unknown;
  checkup_values?: unknown;
  received_at?: unknown;
  approved_report_hash?: unknown;
}

/**
 * **その行の受領 JSON から、いまの生成ロジックで組んだ紙面の指紋**。
 * 承認 API と管理一覧が使う (表示経路は組み上がった VM をそのまま渡せる)。
 */
export async function fingerprintOfRow(row: FingerprintRow): Promise<string> {
  return reportFingerprint(buildReportVM({
    ...FINGERPRINT_CONTEXT,
    reportText: row.report ?? null,
    checkup: (row.checkup_values ?? null) as LabFiles | null,
    issuedOn: String(row.received_at ?? '').slice(0, 10),
  }));
}

/**
 * **指紋のゲート。** 承認状態 (`publish_status`) は見ない — 合成は
 * `report-approval.ts` の `isPubliclyVisibleRow()` が行う (判定を 2 つ持たない)。
 *
 * 【指紋が無い行は通す】理由 2 つ。どちらも**既存の公開を落とさない**ため (§4)。
 *   ① `approved_report_hash` 列がまだ無い環境 (migration 未適用) → `undefined`
 *   ② migration が `approved` へ移行した**既存行**と、この機能より前に承認された行
 *      → `null`。これらは承認時の紙面を控えていないので照合できない。
 *   ハッシュのゲートは**新しい承認 API で承認した回から**効く。
 *
 * @param vm 既に組み上がっている紙面 (表示経路)。無ければ行から組み直す。
 */
export async function hashGateOk(row: FingerprintRow, vm?: ReportVM): Promise<boolean> {
  const stored = row.approved_report_hash;
  if (typeof stored !== 'string' || !HASH_RE.test(stored)) return true; // 指紋なし = 従来どおり
  const current = vm ? await reportFingerprint(vm) : await fingerprintOfRow(row);
  return current === stored;
}

/** 管理一覧に出す指紋の状態。**「承認済なのに出ない」理由を admin が辿れるようにする。** */
export type HashState = 'match' | 'mismatch' | 'none';

export async function hashState(row: FingerprintRow): Promise<HashState> {
  const stored = row.approved_report_hash;
  if (typeof stored !== 'string' || !HASH_RE.test(stored)) return 'none';
  return (await fingerprintOfRow(row)) === stored ? 'match' : 'mismatch';
}
