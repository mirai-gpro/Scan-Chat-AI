// src/lib/transcos-v3/preflight.ts
// トランスコスモス10名 v3.0 — **REAL ZIP Preflight** (§8)。
//
// 【位置づけ】**LLM を 1 回も呼ぶ前、Elith 納品 S3 へ 1 byte も書く前**に完了する関門。
// 失敗時は LLM 0 call / delivery PUT 0 / 汎用 classifier へ fallback しない /
// **「どの file の何が違うか」を 1 件ずつ表示** / operator が解決するまで処理を始めない (§8.5)。
//
// 【identity は content-addressed (§3.1)】
// role / subject は **relative path + SHA-256 + bytes** で決まる。
// Central Directory index は「その ZIP のその entry を読むための一時 locator」にしか使わず、
// **読んだ直後に SHA-256 を再確認**してから初めて manifest の行として扱う。
// directory entry の個数・順序・index は business identity にしない。
//
// 【この層に I/O を持たせない】
// ZIP の読み出し・SHA-256・PDF ページ数・XLSX の中身は**注入**する。
// 同じ判定をサーバ / CLI / 合成 fixture の 3 か所で動かすため。**判定を 2 つ書かない。**

import {
  TRANSCOS_ZIP, TRANSCOS_FILES, TRANSCOS_SUBJECTS, EXPECTED_ROOT,
  HEADER_DIGEST, HEALTH_SUPPORT_HEADERS,
  fileByPath, filesOfRole,
  type ManifestFile, type TranscosRole,
} from './manifest';

/** Central Directory 1 行ぶん。**index は locator であって identity ではない。** */
export interface RawEntry {
  /** ZIP が申告する生のパス (正規化済み・`/` 区切り)。 */
  path: string;
  directory: boolean;
  declaredSize: number;
  encrypted: boolean;
  /** zip-slip / 絶対パス / symlink など、採用してはいけない理由。無ければ null。 */
  unsafe: string | null;
}

export interface PreflightSource {
  /** ZIP のバイト数 (S3 HeadObject か fs.stat)。 */
  zipBytes: number;
  /**
   * ZIP 全体の SHA-256。**サーバ側で streaming hash した値**を渡す (§8.1)。
   * ブラウザ申告だけに依存しない。null は「未算出」で FAIL。
   */
  zipSha256: string | null;
  /** ZIP を開けたか (開けなければ以降の検査は意味を持たない)。 */
  opened: boolean;
  rawEntries: readonly RawEntry[];
}

/** 1 ファイルを実際に読んで得た観測値。 */
export interface FileProbe {
  relPath: string;
  bytes: number;
  sha256: string;
  /** 先頭バイトが拡張子と矛盾しないか。検査対象外なら null。 */
  magicOk: boolean | null;
  /** PDF のページ数 (正規 parser)。数えられなければ null。**推測値を返さない。** */
  pages: number | null;
  /** XLSX の観測 (§8.4)。XLSX でなければ null。 */
  xlsx: XlsxProbe | null;
  /** 読めなかった理由 (読めていれば null)。 */
  unreadable: string | null;
}

export interface XlsxProbe {
  /** 先頭行の **raw セル文字列** (trim / NFKC しない・§8.4)。 */
  rawHeaders: readonly string[];
  /** raw headers を U+001F で join した SHA-256。 */
  rawDigest: string;
  /** 意味のある回答行の数。**ちょうど 1 でなければ FAIL。** */
  meaningfulRows: number;
  /** 問診 XLSX のみ: `完了時刻` を Excel native datetime として解決できたか。 */
  completedAt: 'resolved' | 'unresolved' | 'absent' | null;
}

export interface CheckItem { label: string; ok: boolean; detail?: string }
export interface PreflightCheck { id: string; title: string; ok: boolean; items: CheckItem[] }

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

/** `IGNORE_OFFICE_TEMP` はマジック検査の対象外 — 拡張子は `.xlsx` だが中身は Office のロックファイル。 */
const SKIP_MAGIC: ReadonlySet<TranscosRole> = new Set<TranscosRole>(['IGNORE_OFFICE_TEMP']);

const ratio = (got: number, want: number) => `${got}/${want}`;
const countRole = (r: TranscosRole) => filesOfRole(r).length;

// ---------------------------------------------------------------------------
// ① 構造 — Central Directory だけで分かること。**中身はまだ 1 バイトも読まない。**
// ---------------------------------------------------------------------------

/** 読むべき 1 件と、その ZIP 内での一時 locator。 */
export interface PlanItem {
  file: ManifestFile;
  /** `readByIndex()` に渡す 0 始まりの添字。**identity ではない** (§3.1)。 */
  locatorIndex: number;
}

export interface StructureResult {
  checks: PreflightCheck[];
  /** 読む計画。構造が噛み合っていなければ空 (= 1 バイトも読まない)。 */
  plan: PlanItem[];
  fileCount: number;
  /**
   * **実 ZIP に在った**人物フォルダの数。期待値 (`personFolders`) ではない。
   * 要約へ定数を出すと「常に 10/10」になり、**何を見ても緑に見える**ので観測値を持つ。
   */
  personFolders: number;
}

/** root を**ちょうど 1 段だけ**外す。root 配下でなければ null (§8.2)。 */
export function stripRoot(path: string): string | null {
  const head = `${EXPECTED_ROOT}/`;
  if (!path.startsWith(head)) return null;
  const rest = path.slice(head.length);
  return rest === '' ? null : rest;
}

export function preflightStructure(src: PreflightSource): StructureResult {
  const checks: PreflightCheck[] = [];
  const add = (id: string, title: string, items: CheckItem[]) =>
    checks.push({ id, title, ok: items.every((i) => i.ok), items: items.filter((i) => !i.ok) });

  // 8.1 ZIP 全体
  add('8.1-bytes', 'ZIP のバイト数', [{
    ok: src.zipBytes === TRANSCOS_ZIP.bytes, label: 'bytes',
    detail: `実 ${src.zipBytes} / 期待 ${TRANSCOS_ZIP.bytes}`,
  }]);
  const sha = (src.zipSha256 ?? '').toLowerCase();
  add('8.1-sha', 'ZIP の SHA-256 (サーバ側 streaming hash)', [{
    ok: sha === TRANSCOS_ZIP.sha256, label: 'sha256',
    detail: sha === '' ? '未算出' : `実 ${sha}`,
  }]);
  add('8.1-open', 'ZIP が正常に開く', [{ ok: src.opened, label: 'open', detail: '開けない' }]);

  const files = src.rawEntries.filter((e) => !e.directory);
  add('8.1-count', 'file entry が 38 件', [{
    ok: files.length === TRANSCOS_ZIP.fileEntries, label: 'count',
    detail: `実 ${files.length} / 期待 ${TRANSCOS_ZIP.fileEntries}`,
  }]);
  const unsafe: CheckItem[] = src.rawEntries.flatMap((e, i) => {
    const bad: CheckItem[] = [];
    if (e.encrypted) bad.push({ ok: false, label: `entry #${i}`, detail: '暗号化されている' });
    if (e.unsafe) bad.push({ ok: false, label: `entry #${i}`, detail: e.unsafe });
    return bad;
  });
  add('8.1-safe', '暗号化 / zip-slip / 絶対パス / symlink が無い',
    unsafe.length > 0 ? unsafe : [{ ok: true, label: '危険なエントリなし' }]);

  // 8.2 common root — 名前まで固定。二重 root も FAIL。
  const rootItems: CheckItem[] = [];
  const doubled = `${EXPECTED_ROOT}/${EXPECTED_ROOT}/`;
  for (const e of files) {
    if (e.path.startsWith(doubled)) {
      rootItems.push({ ok: false, label: 'root が二重', detail: e.path.slice(0, 80) });
      continue;
    }
    if (stripRoot(e.path) === null) {
      rootItems.push({ ok: false, label: '期待 root の配下でない', detail: e.path.slice(0, 80) });
    }
  }
  rootItems.push({ ok: true, label: `root = ${EXPECTED_ROOT}` });
  add('8.2-root', 'common root が名前まで一致し二重でない', rootItems);

  // 8.2 relative path / bytes の突き合わせ (**index を使わない**)
  const rel = new Map<string, { entry: RawEntry; index: number }>();
  src.rawEntries.forEach((e, index) => {
    if (e.directory) return;
    const r = stripRoot(e.path);
    if (r === null) return;
    // 同じ relative path が 2 つ在る ZIP は identity が壊れているので後段で落とす。
    if (rel.has(r)) rel.set(`__dup__${r}`, { entry: e, index });
    else rel.set(r, { entry: e, index });
  });

  const plan: PlanItem[] = [];
  const pathItems: CheckItem[] = [];
  for (const m of TRANSCOS_FILES) {
    if (rel.has(`__dup__${m.relPath}`)) {
      pathItems.push({ ok: false, label: m.relPath, detail: '同じ relative path が 2 件ある' });
      continue;
    }
    const hit = rel.get(m.relPath);
    if (!hit) {
      pathItems.push({ ok: false, label: m.relPath, detail: 'ZIP に無い' });
      continue;
    }
    if (hit.entry.declaredSize !== m.bytes) {
      pathItems.push({
        ok: false, label: m.relPath,
        detail: `bytes が違う (実 ${hit.entry.declaredSize} / 期待 ${m.bytes})`,
      });
      continue;
    }
    pathItems.push({ ok: true, label: m.relPath });
    plan.push({ file: m, locatorIndex: hit.index });
  }
  add('8.2-path', 'manifest の relative path と bytes が一致', pathItems);

  // manifest 外 0 / 欠落 0
  const want = new Set(TRANSCOS_FILES.map((f) => f.relPath));
  const got = [...rel.keys()].filter((k) => !k.startsWith('__dup__'));
  const extra: CheckItem[] = got.filter((p) => !want.has(p))
    .map((p) => ({ ok: false, label: '余分', detail: p }));
  add('8.2-extra', 'manifest 外の file が無い',
    extra.length > 0 ? extra : [{ ok: true, label: 'なし' }]);
  const missing: CheckItem[] = [...want].filter((p) => !got.includes(p))
    .map((p) => ({ ok: false, label: '不足', detail: p }));
  add('8.2-missing', 'manifest の欠落が無い',
    missing.length > 0 ? missing : [{ ok: true, label: 'なし' }]);

  // §9 人物フォルダ 10 / 人物ごとの素材
  const folders = new Set(got.filter((p) => p.includes('/')).map((p) => p.slice(0, p.indexOf('/'))));
  add('9-folders', '人物フォルダが 10 件', [{
    ok: folders.size === TRANSCOS_ZIP.personFolders, label: 'folders',
    detail: `実 ${folders.size} / 期待 ${TRANSCOS_ZIP.personFolders}`,
  }]);
  add('9-binding', '人物ごとに 健診 1 / Genoplan 1 / 問診 1 (+ 補助は 5 名)',
    TRANSCOS_SUBJECTS.flatMap((s) => {
      const own = TRANSCOS_FILES.filter((f) => f.subject === s.displayName);
      const n = (r: TranscosRole) => own.filter((f) => f.role === r).length;
      const q = n('QUESTIONNAIRE_XLSX') + n('QUESTIONNAIRE_PDF_MANUAL');
      const wantKind: TranscosRole = s.questionnaire === 'xlsx' ? 'QUESTIONNAIRE_XLSX' : 'QUESTIONNAIRE_PDF_MANUAL';
      return [
        { ok: n('HEALTH_PDF') === 1, label: `${s.displayName} 健診`, detail: `${n('HEALTH_PDF')} 件` },
        { ok: n('GENOPLAN_PDF') === 1, label: `${s.displayName} Genoplan`, detail: `${n('GENOPLAN_PDF')} 件` },
        { ok: q === 1 && n(wantKind) === 1, label: `${s.displayName} 問診`, detail: `${q} 件 / 種別 ${s.questionnaire}` },
        {
          ok: n('HEALTH_SUPPORT_XLSX') === (s.hasHealthSupport ? 1 : 0),
          label: `${s.displayName} 補助`, detail: `${n('HEALTH_SUPPORT_XLSX')} 件`,
        },
        // 人物フォルダが manifest の folder と一致しているか (relative path の第 1 階層)
        {
          ok: own.every((f) => f.relPath.startsWith(`${s.folder}/`)),
          label: `${s.displayName} フォルダ`, detail: s.folder,
        },
      ];
    }));

  const structureOk = checks.every((c) => c.ok);
  return {
    checks,
    // **構造が噛み合わないうちは 1 バイトも読まない** (読むと別人のファイルを掴む)。
    plan: structureOk ? plan : [],
    fileCount: files.length,
    personFolders: folders.size,
  };
}

// ---------------------------------------------------------------------------
// ② 1 ファイルを読む。**チャンク実行の単位**。
// ---------------------------------------------------------------------------

export interface FileProbes {
  sha256(bytes: Uint8Array): string | Promise<string>;
  magicOk(relPath: string, head: Uint8Array): boolean;
  pdfPageCount(bytes: Uint8Array): number | null | Promise<number | null>;
  /** XLSX を開いて §8.4 の観測を返す。開けなければ null。 */
  xlsx(bytes: Uint8Array, role: TranscosRole): XlsxProbe | null | Promise<XlsxProbe | null>;
}

/**
 * plan の 1 件を読む。**読んだ直後に SHA-256 を確かめ、manifest と違えば観測を捨てる**
 * (locator が指した先が本当にその file かの最終確認・§3.1)。
 */
export async function probeFile(
  item: PlanItem,
  read: (locatorIndex: number) => Promise<Uint8Array>,
  probes: FileProbes,
): Promise<FileProbe> {
  const m = item.file;
  let bytes: Uint8Array;
  try {
    bytes = await read(item.locatorIndex);
  } catch (err) {
    // **relative path 以外の情報をメッセージへ入れない** (氏名を含むため §24)。
    return {
      relPath: m.relPath, bytes: 0, sha256: '', magicOk: null, pages: null, xlsx: null,
      unreadable: err instanceof Error ? err.message : String(err),
    };
  }
  const sha = String(await probes.sha256(bytes)).toLowerCase();
  if (sha !== m.sha256) {
    // **content identity が違う。以降の観測はこの file のものではないので採らない。**
    return {
      relPath: m.relPath, bytes: bytes.length, sha256: sha,
      magicOk: null, pages: null, xlsx: null, unreadable: null,
    };
  }
  const magicOk = SKIP_MAGIC.has(m.role) ? null : probes.magicOk(m.relPath, bytes.subarray(0, 8));
  const pages = m.relPath.endsWith('.pdf') ? await probes.pdfPageCount(bytes) : null;
  const xlsx = m.cols != null && !SKIP_MAGIC.has(m.role) ? await probes.xlsx(bytes, m.role) : null;
  return { relPath: m.relPath, bytes: bytes.length, sha256: sha, magicOk, pages, xlsx, unreadable: null };
}

// ---------------------------------------------------------------------------
// ③ 締め
// ---------------------------------------------------------------------------

/** 人物ごとの Executive exact candidate 件数 (§9.1)。0 / 2 以上はその人物だけ停止。 */
export interface ExecutiveCount { subject: string; candidates: number }

export function preflightFinish(
  structure: StructureResult,
  probed: readonly FileProbe[],
  executives: readonly ExecutiveCount[],
): PreflightReport {
  const checks = [...structure.checks];
  const add = (id: string, title: string, items: CheckItem[]) =>
    checks.push({ id, title, ok: items.every((i) => i.ok), items: items.filter((i) => !i.ok) });
  const by = new Map(probed.map((p) => [p.relPath, p]));

  // 8.2 SHA-256
  add('8.2-sha', '38 件すべての SHA-256 が一致', TRANSCOS_FILES.map((m) => {
    const p = by.get(m.relPath);
    if (!p) return { ok: false, label: m.relPath, detail: '未読' };
    if (p.unreadable) return { ok: false, label: m.relPath, detail: `読めない: ${p.unreadable}` };
    if (p.bytes !== m.bytes) {
      return { ok: false, label: m.relPath, detail: `実バイト ${p.bytes} / 期待 ${m.bytes}` };
    }
    return {
      ok: p.sha256 === m.sha256, label: m.relPath,
      detail: `実 ${p.sha256.slice(0, 16)}… / 期待 ${m.sha256.slice(0, 16)}…`,
    };
  }));

  // 8.2 magic
  add('8.2-magic', '拡張子とマジックバイトが一致', TRANSCOS_FILES.map((m) => {
    const p = by.get(m.relPath);
    if (!p || p.unreadable || p.sha256 !== m.sha256) return { ok: false, label: m.relPath, detail: '未読' };
    if (p.magicOk === null) return { ok: true, label: m.relPath, detail: '対象外' };
    return { ok: p.magicOk, label: m.relPath, detail: '先頭バイトが拡張子と矛盾' };
  }));

  // 8.3 PDF ページ数
  add('8.3-pages', 'PDF のページ数が manifest と一致 / 読めないものが無い',
    TRANSCOS_FILES.filter((m) => m.pages != null).map((m) => {
      const p = by.get(m.relPath);
      if (!p || p.unreadable || p.sha256 !== m.sha256) return { ok: false, label: m.relPath, detail: '未読' };
      if (p.pages == null) return { ok: false, label: m.relPath, detail: 'ページ数を数えられない' };
      return { ok: p.pages === m.pages, label: m.relPath, detail: `実 ${p.pages} / 期待 ${m.pages}` };
    }));

  // 8.4 XLSX
  const xlsxItems = (role: TranscosRole, cols: number, digest: string, wantCompleted: boolean): CheckItem[] =>
    filesOfRole(role).flatMap((m) => {
      const p = by.get(m.relPath);
      if (!p || p.unreadable || p.sha256 !== m.sha256 || !p.xlsx) {
        return [{ ok: false, label: m.relPath, detail: '未読 / XLSX を開けない' }];
      }
      const x = p.xlsx;
      const out: CheckItem[] = [
        { ok: x.rawHeaders.length === cols, label: `${m.relPath} 列数`, detail: `実 ${x.rawHeaders.length} / 期待 ${cols}` },
        { ok: x.rawDigest === digest, label: `${m.relPath} raw digest`, detail: `実 ${x.rawDigest.slice(0, 16)}…` },
        { ok: x.meaningfulRows === 1, label: `${m.relPath} 回答行`, detail: `実 ${x.meaningfulRows} 件 / 期待 1 件` },
      ];
      if (wantCompleted) {
        out.push({
          ok: x.completedAt === 'resolved', label: `${m.relPath} 完了時刻`,
          detail: `${x.completedAt ?? 'null'} (Excel native datetime として解決できない)`,
        });
      }
      return out;
    });

  add('8.4-q62', '問診 XLSX 8 件が Golden 62 列 (raw digest 一致) ・回答行 1 件・完了時刻が解決できる',
    xlsxItems('QUESTIONNAIRE_XLSX', 62, HEADER_DIGEST.questionnaire62, true));
  add('8.4-s39', '健診補助 XLSX 5 件が Golden 39 列 (raw digest 一致) ・データ行 1 件',
    xlsxItems('HEALTH_SUPPORT_XLSX', HEALTH_SUPPORT_HEADERS.length, HEADER_DIGEST.healthSupport39, false));

  // 9.1 Executive
  add('9.1-executive', 'Executive の exact 一致が各人物 1 件', TRANSCOS_SUBJECTS.map((s) => {
    const c = executives.find((e) => e.subject === s.displayName)?.candidates;
    if (c == null) return { ok: false, label: s.displayName, detail: '照合していない' };
    return {
      ok: c === 1, label: s.displayName,
      detail: c === 0 ? '人物マスタに見つかりません' : `同名候補が ${c} 件あります`,
    };
  }));

  const okSha = (role: TranscosRole) => filesOfRole(role).filter((m) => {
    const p = by.get(m.relPath);
    return p != null && !p.unreadable && p.sha256 === m.sha256;
  }).length;

  return {
    ok: checks.every((c) => c.ok),
    checks,
    summary: {
      files: ratio(structure.fileCount, TRANSCOS_ZIP.fileEntries),
      // **観測値**。manifest の定数を出すと常に 10/10 になり検査にならない。
      subjects: ratio(structure.personFolders, TRANSCOS_ZIP.personFolders),
      health: ratio(okSha('HEALTH_PDF'), countRole('HEALTH_PDF')),
      genoplan: ratio(okSha('GENOPLAN_PDF'), countRole('GENOPLAN_PDF')),
      questionnaireXlsx: ratio(okSha('QUESTIONNAIRE_XLSX'), countRole('QUESTIONNAIRE_XLSX')),
      questionnairePdf: ratio(okSha('QUESTIONNAIRE_PDF_MANUAL'), countRole('QUESTIONNAIRE_PDF_MANUAL')),
      healthSupport: ratio(okSha('HEALTH_SUPPORT_XLSX'), countRole('HEALTH_SUPPORT_XLSX')),
      executives: ratio(executives.filter((e) => e.candidates === 1).length, TRANSCOS_SUBJECTS.length),
    },
  };
}

/** 全部まとめて (CLI の実 ZIP 検証・合成 fixture の回帰テスト用)。 */
export async function runPreflight(input: {
  source: PreflightSource;
  read: (locatorIndex: number) => Promise<Uint8Array>;
  probes: FileProbes;
  executives: readonly ExecutiveCount[];
}): Promise<PreflightReport> {
  const structure = preflightStructure(input.source);
  const probed: FileProbe[] = [];
  for (const item of structure.plan) probed.push(await probeFile(item, input.read, input.probes));
  return preflightFinish(structure, probed, input.executives);
}

/** 画面に出す要約 (§8 の出力例)。 */
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

/** 使われていない import を残さないための型 re-export。 */
export type { ManifestFile };
export { fileByPath };
