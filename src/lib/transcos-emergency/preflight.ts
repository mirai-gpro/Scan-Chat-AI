// src/lib/transcos-emergency/preflight.ts
// トランスコスモス10名 緊急専用パイプライン v2.0 — **Preflight** (指示書 §8)。
//
// 【位置づけ】アップロード直後、**LLM / OCR / Elith 納品 S3 write より前**に必ず通す関門。
// ここが PASS するまで:
//   - LLM を 1 回も呼ばない
//   - Elith S3 へ 1 件も書かない
//   - 汎用処理へ逃がさない
// 失敗は**何が違うかを 1 項目単位で**返す (まとめて「失敗しました」にしない)。
//
// 【この層に I/O を持たせない】
// ZIP の読み出し・SHA-256・PDF ページ数・XLSX ヘッダは**注入**にしてある。
// そうすると同じ判定を 3 か所で動かせる:
//   ① サーバ (S3 の実 ZIP)  ② CLI の実 ZIP 検証  ③ 合成 fixture の回帰テスト
// **判定を 2 つ書かない**のがここの眼目 (2 つ書くと片方だけ緩む)。
//
// 【PDF 本文テキストを分類に使わない】(§8 末尾 / §26-1)
// ページ数は正規の PDF parser で数える。`countPdfPages()` の正規表現だけを根拠にしない。

import {
  TRANSCOS_ZIP,
  TRANSCOS_MANIFEST,
  TRANSCOS_SUBJECTS,
  manifestEntry,
  zeroBasedIndex,
  type ManifestEntry,
  type TranscosRole,
} from './manifest';
import { extensionOf, magicMatchesExtension, normalizeZipPath } from '../ad-hoc-diagnosis/archive';

/** Central Directory 1 行ぶん (ディレクトリも含む生の並び・0 始まり)。 */
export interface RawEntry {
  path: string;
  directory: boolean;
  declaredSize: number;
  encrypted: boolean;
}

export interface PreflightSource {
  /** ZIP のバイト数 (S3 HeadObject か fs.stat)。 */
  zipBytes: number;
  /**
   * ZIP 全体の SHA-256 (小文字 hex)。
   * **ブラウザ / CLI が原本を読んで出した値**。null なら「未提出」として FAIL にする
   * (黙って通さない)。なお 38 エントリの SHA 一致 (検査5) が中身の本証明で、
   * こちらは「同じ 1 本のファイルか」の証明。
   */
  zipSha256: string | null;
  /** Central Directory の生の並び。**ディレクトリを含む。** */
  rawEntries: readonly RawEntry[];
}

export interface PreflightProbes {
  sha256(bytes: Uint8Array): string | Promise<string>;
  /** 正規の PDF parser で数えたページ数。数えられなければ null。 */
  pdfPageCount(bytes: Uint8Array): number | null | Promise<number | null>;
  /** XLSX 先頭行のセル。読めなければ null。 */
  xlsxHeader(bytes: Uint8Array): readonly unknown[] | null | Promise<readonly unknown[] | null>;
}

/** 1 エントリを実際に読んで出した観測値。 */
export interface EntryProbe {
  entry: number;
  /** 実バイト数。 */
  bytes: number;
  sha256: string;
  /** 先頭バイトが拡張子と矛盾しないか。`IGNORE_OFFICE_TEMP` は対象外 (下記)。 */
  magicOk: boolean | null;
  pages: number | null;
  header: readonly unknown[] | null;
  /** 読めなかったときの理由 (読めていれば null)。 */
  unreadable: string | null;
}

export interface CheckItem { label: string; ok: boolean; detail?: string }
export interface PreflightCheck {
  id: number;
  title: string;
  ok: boolean;
  /** 落ちた項目だけを 1 件ずつ。PASS のときは空。 */
  items: CheckItem[];
}

export interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
  summary: {
    files: string;
    subjects: string;
    health: string;
    genoplan: string;
    questionnaireXlsx: string;
    questionnairePdf: string;
    healthSupport: string;
    executives: string;
  };
}

/** `IGNORE_OFFICE_TEMP` はマジック検査の対象外 (§5 entry 2)。 */
const SKIP_MAGIC: ReadonlySet<TranscosRole> = new Set<TranscosRole>(['IGNORE_OFFICE_TEMP']);

function countRole(role: TranscosRole): number {
  return TRANSCOS_MANIFEST.filter((m) => m.role === role).length;
}

/** 「x/y」表記。y は manifest が決めた期待値。 */
function ratio(got: number, want: number): string {
  return `${got}/${want}`;
}

// ---------------------------------------------------------------------------
// ① 構造 (Central Directory だけで分かること)。**中身はまだ読まない。**
// ---------------------------------------------------------------------------

export interface StructureResult {
  checks: PreflightCheck[];
  /** 読むべき manifest エントリ (entry 昇順)。構造が壊れていれば空。 */
  plan: ManifestEntry[];
  /** 実ファイル数 (ディレクトリを除く)。 */
  fileCount: number;
}

export function preflightStructure(src: PreflightSource): StructureResult {
  const checks: PreflightCheck[] = [];
  const add = (id: number, title: string, items: CheckItem[]) => {
    checks.push({ id, title, ok: items.every((i) => i.ok), items: items.filter((i) => !i.ok) });
  };

  // 1. ZIP バイト数
  add(1, 'ZIP のバイト数', [{
    ok: src.zipBytes === TRANSCOS_ZIP.bytes,
    label: 'bytes',
    detail: `実 ${src.zipBytes} / 期待 ${TRANSCOS_ZIP.bytes}`,
  }]);

  // 2. ZIP SHA-256
  const zipSha = (src.zipSha256 ?? '').toLowerCase();
  add(2, 'ZIP の SHA-256', [{
    ok: zipSha === TRANSCOS_ZIP.sha256,
    label: 'sha256',
    detail: zipSha === '' ? '未提出' : `実 ${zipSha}`,
  }]);

  // 3. ディレクトリを除くファイル数
  const files = src.rawEntries.filter((e) => !e.directory);
  add(3, 'ファイル数 (ディレクトリを除く)', [{
    ok: files.length === TRANSCOS_ZIP.fileCount,
    label: 'count',
    detail: `実 ${files.length} / 期待 ${TRANSCOS_ZIP.fileCount}`,
  }]);

  // 10. 暗号化・読めないエントリが無い
  add(10, '暗号化・読めないエントリが無い',
    src.rawEntries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.encrypted)
      .map(({ i }) => ({ ok: false, label: `index=${i}`, detail: '暗号化されている' }))
      .concat([{ ok: true, label: '暗号化なし', detail: '' }]));

  /*
   * 4. manifest の 38 件が entryIndex / path / bytes で完全一致。
   * **entry 番号は 1 始まり (ディレクトリ込み)。** ここがずれていたら
   * 「別人のファイルを読む」に直結するので、黙って sha 逆引きへ逃がさず FAIL にする。
   */
  const idxItems: CheckItem[] = [];
  for (const m of TRANSCOS_MANIFEST) {
    const raw = src.rawEntries[zeroBasedIndex(m.entry)];
    if (!raw) {
      idxItems.push({ ok: false, label: `entry ${m.entry}`, detail: '該当位置にエントリが無い' });
      continue;
    }
    if (raw.directory) {
      idxItems.push({ ok: false, label: `entry ${m.entry}`, detail: 'ディレクトリだった' });
      continue;
    }
    const path = normalizeZipPath(raw.path);
    if (path !== m.path) {
      idxItems.push({ ok: false, label: `entry ${m.entry}`, detail: `path が違う (実 ${path})` });
      continue;
    }
    if (raw.declaredSize !== m.bytes) {
      idxItems.push({
        ok: false, label: `entry ${m.entry}`,
        detail: `bytes が違う (実 ${raw.declaredSize} / 期待 ${m.bytes})`,
      });
      continue;
    }
    idxItems.push({ ok: true, label: `entry ${m.entry}` });
  }
  add(4, 'manifest の entryIndex / path / bytes 一致', idxItems);

  // 15. manifest 外のファイルが 0 件 / 16. manifest の欠落が 0 件
  const wantPaths = new Set(TRANSCOS_MANIFEST.map((m) => m.path));
  const gotPaths = files.map((e) => normalizeZipPath(e.path));
  const extra = gotPaths.filter((p) => !wantPaths.has(p));
  const missing = [...wantPaths].filter((p) => !gotPaths.includes(p));
  add(15, 'manifest 外のファイルが無い',
    extra.length === 0
      ? [{ ok: true, label: 'なし' }]
      : extra.map((p) => ({ ok: false, label: '余分なファイル', detail: p })));
  add(16, 'manifest の欠落が無い',
    missing.length === 0
      ? [{ ok: true, label: 'なし' }]
      : missing.map((p) => ({ ok: false, label: '足りないファイル', detail: p })));

  // 6. 人物フォルダ 10 件
  const folders = new Set(
    gotPaths.filter((p) => p.includes('/')).map((p) => p.slice(0, p.indexOf('/'))),
  );
  add(6, '人物フォルダが 10 件', [{
    ok: folders.size === TRANSCOS_ZIP.personCount,
    label: 'folders',
    detail: `実 ${folders.size} / 期待 ${TRANSCOS_ZIP.personCount}`,
  }]);

  /*
   * 7. 人物ごとに 健診 1 / Genoplan 1 / 問診 1
   * 8. 健診補助 XLSX は指定 5 名だけ 1 件
   * **manifest の人物表が正**なので、ここは「表と実体が噛み合っているか」を見る。
   */
  const roleOf = (entry: number) => manifestEntry(entry)?.role ?? null;
  const perSubject: CheckItem[] = [];
  const supportItems: CheckItem[] = [];
  for (const s of TRANSCOS_SUBJECTS) {
    const h = roleOf(s.health);
    const g = roleOf(s.genoplan);
    const q = roleOf(s.questionnaire);
    perSubject.push({
      ok: h === 'HEALTH_PDF', label: `人物 ${s.subjectNo} 健診`, detail: `role=${h}`,
    });
    perSubject.push({
      ok: g === 'GENOPLAN_PDF', label: `人物 ${s.subjectNo} Genoplan`, detail: `role=${g}`,
    });
    perSubject.push({
      ok: q === 'QUESTIONNAIRE_XLSX' || q === 'QUESTIONNAIRE_PDF_MANUAL',
      label: `人物 ${s.subjectNo} 問診`, detail: `role=${q}`,
    });
    supportItems.push(s.healthSupport === null
      ? { ok: true, label: `人物 ${s.subjectNo} 補助なし` }
      : {
        ok: roleOf(s.healthSupport) === 'HEALTH_SUPPORT_XLSX',
        label: `人物 ${s.subjectNo} 補助`, detail: `role=${roleOf(s.healthSupport)}`,
      });
  }
  add(7, '人物ごとに 健診 1 / Genoplan 1 / 問診 1', perSubject);
  add(8, '健診補助 XLSX は 5 名だけ', supportItems.concat([{
    ok: countRole('HEALTH_SUPPORT_XLSX') === 5,
    label: '補助の総数',
    detail: `${countRole('HEALTH_SUPPORT_XLSX')}/5`,
  }]));

  const structureOk = checks.filter((c) => c.id === 4 || c.id === 3).every((c) => c.ok);
  return {
    checks,
    // **構造が噛み合っていないうちは 1 バイトも読まない** (読むと別人のファイルを掴む)。
    plan: structureOk ? [...TRANSCOS_MANIFEST] : [],
    fileCount: files.length,
  };
}

// ---------------------------------------------------------------------------
// ② 1 エントリを読む。**チャンク実行の単位** (159MB を 1 リクエストで読まない)。
// ---------------------------------------------------------------------------

export async function probeEntry(
  entry: number,
  read: (index0: number) => Promise<Uint8Array>,
  probes: PreflightProbes,
): Promise<EntryProbe> {
  const m = manifestEntry(entry);
  if (!m) {
    return { entry, bytes: 0, sha256: '', magicOk: null, pages: null, header: null, unreadable: 'manifest に無い entry' };
  }
  let bytes: Uint8Array;
  try {
    bytes = await read(zeroBasedIndex(entry));
  } catch (err) {
    // **path をメッセージに出さない** (氏名を含むため・§22)。
    return {
      entry, bytes: 0, sha256: '', magicOk: null, pages: null, header: null,
      unreadable: err instanceof Error ? err.message : String(err),
    };
  }
  const ext = extensionOf(m.path);
  const sha = await probes.sha256(bytes);
  const magicOk = SKIP_MAGIC.has(m.role) ? null : magicMatchesExtension(ext, bytes.subarray(0, 8));
  const pages = ext === '.pdf' ? await probes.pdfPageCount(bytes) : null;
  const header = ext === '.xlsx' && !SKIP_MAGIC.has(m.role) ? await probes.xlsxHeader(bytes) : null;
  return {
    entry, bytes: bytes.length, sha256: String(sha).toLowerCase(),
    magicOk, pages, header, unreadable: null,
  };
}

// ---------------------------------------------------------------------------
// ③ 締め。読んだ結果 + Executive 照合を合わせて最終判定。
// ---------------------------------------------------------------------------

/** 人物ごとの Executive exact candidate 件数 (§6)。0 件・2 件以上はその人物だけ停止。 */
export interface ExecutiveCount { subjectNo: number; candidates: number }

export function preflightFinish(
  structure: StructureResult,
  probesByEntry: readonly EntryProbe[],
  executives: readonly ExecutiveCount[],
  golden: { questionnaireHeaderOk: (h: readonly unknown[] | null) => { ok: boolean; detail: string } },
): PreflightReport {
  const checks = [...structure.checks];
  const add = (id: number, title: string, items: CheckItem[]) => {
    checks.push({ id, title, ok: items.every((i) => i.ok), items: items.filter((i) => !i.ok) });
  };
  const byEntry = new Map(probesByEntry.map((p) => [p.entry, p]));

  // 5. 38 件すべて SHA-256 完全一致
  const shaItems: CheckItem[] = TRANSCOS_MANIFEST.map((m) => {
    const p = byEntry.get(m.entry);
    if (!p) return { ok: false, label: `entry ${m.entry}`, detail: '未読' };
    if (p.unreadable) return { ok: false, label: `entry ${m.entry}`, detail: `読めない: ${p.unreadable}` };
    if (p.bytes !== m.bytes) {
      return { ok: false, label: `entry ${m.entry}`, detail: `実バイト ${p.bytes} / 期待 ${m.bytes}` };
    }
    return {
      ok: p.sha256 === m.sha256,
      label: `entry ${m.entry}`,
      detail: `実 ${p.sha256.slice(0, 16)}… / 期待 ${m.sha256.slice(0, 16)}…`,
    };
  });
  add(5, '38 件すべての SHA-256 一致', shaItems);

  // 9. マジックバイト一致
  add(9, 'PDF / XLSX / DOCX のマジックバイト', TRANSCOS_MANIFEST.map((m) => {
    const p = byEntry.get(m.entry);
    if (!p || p.unreadable) return { ok: false, label: `entry ${m.entry}`, detail: '未読' };
    if (p.magicOk === null) return { ok: true, label: `entry ${m.entry}`, detail: '対象外' };
    return { ok: p.magicOk, label: `entry ${m.entry}`, detail: '先頭バイトが拡張子と矛盾' };
  }));

  // 11. PDF ページ数が manifest 一致
  add(11, 'PDF のページ数', TRANSCOS_MANIFEST.filter((m) => m.pages != null).map((m) => {
    const p = byEntry.get(m.entry);
    if (!p || p.unreadable) return { ok: false, label: `entry ${m.entry}`, detail: '未読' };
    if (p.pages == null) return { ok: false, label: `entry ${m.entry}`, detail: 'ページ数を数えられない' };
    return { ok: p.pages === m.pages, label: `entry ${m.entry}`, detail: `実 ${p.pages} / 期待 ${m.pages}` };
  }));

  /*
   * 12. 問診 XLSX 8 件の header が Golden 62 列と完全一致。
   * Golden は**既存の専用 contract** (`checkExternalFormSchema`) が持っている。
   * ここで 62 本の文字列を書き写さない (2 か所に持つと片方だけ古くなる)。
   */
  add(12, '問診 XLSX の Golden 62 列', TRANSCOS_MANIFEST
    .filter((m) => m.role === 'QUESTIONNAIRE_XLSX')
    .map((m) => {
      const p = byEntry.get(m.entry);
      if (!p || p.unreadable) return { ok: false, label: `entry ${m.entry}`, detail: '未読' };
      const r = golden.questionnaireHeaderOk(p.header);
      return { ok: r.ok, label: `entry ${m.entry}`, detail: r.detail };
    }));

  /*
   * 13. 健診補助 XLSX 5 件が Golden 39 列と完全一致。
   *
   * **39 本の見出し文字列は受領していない**ので、こちらで書き起こさない (捏造しない)。
   * 代わりに機械で確かめられる形にする:
   *   ① 列数が manifest の 39 と一致
   *   ② 5 件の見出しが**互いに 1 文字も違わない** (1 列でも違えば落ちる)
   * ②があるので「1 列違う XLSX が混ざる」は検出できる。
   * 正式な Golden 見出しを受領したらここへ差し替える。
   */
  const support = TRANSCOS_MANIFEST.filter((m) => m.role === 'HEALTH_SUPPORT_XLSX');
  const supportHeaders = support.map((m) => ({ m, h: byEntry.get(m.entry)?.header ?? null }));
  const baseline = supportHeaders.find((x) => x.h != null)?.h ?? null;
  add(13, '健診補助 XLSX の Golden 39 列', supportHeaders.map(({ m, h }) => {
    if (h == null) return { ok: false, label: `entry ${m.entry}`, detail: '未読' };
    if (h.length !== (m.cols ?? 39)) {
      return { ok: false, label: `entry ${m.entry}`, detail: `列数 ${h.length} / 期待 ${m.cols ?? 39}` };
    }
    const same = baseline != null
      && baseline.length === h.length
      && baseline.every((c, i) => String(c ?? '') === String(h[i] ?? ''));
    return { ok: same, label: `entry ${m.entry}`, detail: same ? '' : '他の補助 XLSX と見出しが違う' };
  }));

  // 14. Executive master exact candidate が各人物 1 件
  add(14, 'Executive の exact 一致が各人物 1 件', TRANSCOS_SUBJECTS.map((s) => {
    const c = executives.find((e) => e.subjectNo === s.subjectNo)?.candidates;
    if (c == null) return { ok: false, label: `人物 ${s.subjectNo}`, detail: '照合していない' };
    return {
      ok: c === 1, label: `人物 ${s.subjectNo}`,
      detail: c === 0 ? '人物マスタに見つからない' : `同名候補が ${c} 件`,
    };
  }));

  checks.sort((a, b) => a.id - b.id);

  const okShaOf = (role: TranscosRole) => TRANSCOS_MANIFEST
    .filter((m) => m.role === role)
    .filter((m) => {
      const p = byEntry.get(m.entry);
      return p != null && !p.unreadable && p.sha256 === m.sha256;
    }).length;

  return {
    ok: checks.every((c) => c.ok),
    checks,
    summary: {
      files: ratio(structure.fileCount, TRANSCOS_ZIP.fileCount),
      subjects: ratio(TRANSCOS_SUBJECTS.length, TRANSCOS_ZIP.personCount),
      health: ratio(okShaOf('HEALTH_PDF'), countRole('HEALTH_PDF')),
      genoplan: ratio(okShaOf('GENOPLAN_PDF'), countRole('GENOPLAN_PDF')),
      questionnaireXlsx: ratio(okShaOf('QUESTIONNAIRE_XLSX'), countRole('QUESTIONNAIRE_XLSX')),
      questionnairePdf: ratio(okShaOf('QUESTIONNAIRE_PDF_MANUAL'), countRole('QUESTIONNAIRE_PDF_MANUAL')),
      healthSupport: ratio(okShaOf('HEALTH_SUPPORT_XLSX'), countRole('HEALTH_SUPPORT_XLSX')),
      executives: ratio(executives.filter((e) => e.candidates === 1).length, TRANSCOS_SUBJECTS.length),
    },
  };
}

/** 全部まとめて走らせる (CLI の実 ZIP 検証・合成 fixture の回帰テスト用)。 */
export async function runPreflight(input: {
  source: PreflightSource;
  read: (index0: number) => Promise<Uint8Array>;
  probes: PreflightProbes;
  executives: readonly ExecutiveCount[];
  golden: { questionnaireHeaderOk: (h: readonly unknown[] | null) => { ok: boolean; detail: string } };
}): Promise<PreflightReport> {
  const structure = preflightStructure(input.source);
  const probed: EntryProbe[] = [];
  for (const m of structure.plan) {
    probed.push(await probeEntry(m.entry, input.read, input.probes));
  }
  return preflightFinish(structure, probed, input.executives, input.golden);
}

/** 画面に出す 1 行ずつの要約 (§8 の出力例)。 */
export function formatPreflight(r: PreflightReport): string {
  const s = r.summary;
  return [
    `実ZIP確認: ${r.ok ? 'PASS' : 'FAIL'}`,
    `ファイル: ${s.files}`,
    `人物: ${s.subjects}`,
    `健診PDF: ${s.health}`,
    `Genoplan: ${s.genoplan}`,
    `問診XLSX: ${s.questionnaireXlsx}`,
    `問診PDF: ${s.questionnairePdf}`,
    `健診補助XLSX: ${s.healthSupport}`,
    `Executive: ${s.executives}`,
    r.ok ? '処理開始可能' : '処理を開始できません',
  ].join('\n');
}
