// src/lib/transcos-emergency/manifest.ts
// トランスコスモス10名 緊急専用パイプライン v2.0 — **固定 manifest**。
// 正本: `CLAUDECODE_FINAL_TRANSCOS_EMERGENCY_V2_20260914.md` §2 / §5 / §6 / §7
//
// 【この専用パイプラインの肝】
// **今回の分類結果は推測しない。ここに書いてある固定表がそのまま分類結果**。
// ルーティングキーは `ZIP SHA-256 + entryIndex + file SHA-256 + role` の 4 点で、
// **ファイル名は表示・監査のためだけに持つ** (§4)。
//
// したがって以下は 1 つも使わない (§4 / §26):
//   汎用 `extractPdfText()` / PDF 語彙ヒット / ファイル名の意味推測 /
//   「Genoplan でない PDF だから健診」/ first match / fuzzy 氏名一致 /
//   ファイル名中の `(1.)` 等の番号 / `10名の情報.xlsx` の氏名セル
//
// **この SHA-256 と一致しない ZIP は専用処理へ入れない。汎用処理へ落とさない** (§2)。

/** 受領済み実 ZIP の identity (§2)。**ここが一致しない入力は専用処理へ入れない。** */
export const TRANSCOS_ZIP = {
  /** 実ファイルのバイト数。 */
  bytes: 159_308_299,
  /** 実ファイルの SHA-256 (小文字 hex)。 */
  sha256: '5ad086678047b17a4a0380e2c3c1c7e02332e45e8cfe32a9687fb6243093daf6',
  /** ディレクトリエントリを除いたファイル数。Office 一時ファイル 1 件を含む。 */
  fileCount: 38,
  /** 人物フォルダの数。 */
  personCount: 10,
} as const;

/** この専用 run の識別子。既存テーブルを storage として借りるときの目印 (§14)。 */
export const TRANSCOS_RUN_KIND = 'transcos_emergency_v2';

/**
 * ファイルの役割。**判定しない。manifest が持っている値がそのまま真。**
 *
 * - `HEALTH_PDF` … 健診。**これだけが HealthCheckupData の生成元** (§10)
 * - `HEALTH_SUPPORT_XLSX` … 39 列の補助資料。**生成元ではない。決定論 cross-check 専用** (§10)
 * - `QUESTIONNAIRE_XLSX` … 62 列の共通問診表 (§11)
 * - `QUESTIONNAIRE_PDF_MANUAL` … 人が原本を見て入力する 2 件だけ (§12)
 * - `GENOPLAN_PDF` … 遺伝子。**p10〜35 の 26 ページだけ**を LLM へ送る (§13)
 * - `ROOT_REFERENCE_*` … 参照資料。処理に使わない
 * - `IGNORE_OFFICE_TEMP` … Office 一時ファイル。開かない
 */
export type TranscosRole =
  | 'HEALTH_PDF'
  | 'HEALTH_SUPPORT_XLSX'
  | 'QUESTIONNAIRE_XLSX'
  | 'QUESTIONNAIRE_PDF_MANUAL'
  | 'GENOPLAN_PDF'
  | 'ROOT_REFERENCE_ROSTER_IMAGE'
  | 'ROOT_REFERENCE_OPERATION_DOC'
  | 'IGNORE_OFFICE_TEMP';

export interface ManifestEntry {
  /**
   * 仕様書 §5 の entry 番号。**1 始まり**で、ディレクトリエントリも数に含むため飛ぶ。
   * `archive.readByIndex()` は **0 始まり**なので `zeroBasedIndex()` を通すこと。
   */
  entry: number;
  role: TranscosRole;
  /** ZIP 内のパス。**表示・監査のみ。分類には使わない** (§4)。 */
  path: string;
  /** 展開後のバイト数。 */
  bytes: number;
  /** PDF のページ数 (PDF のみ)。 */
  pages?: number;
  /** 先頭行の列数 (XLSX のみ)。 */
  cols?: number;
  /** 展開後バイト列の SHA-256 (小文字 hex)。**これが content identity**。 */
  sha256: string;
}

/**
 * 仕様書 §5 の entry 番号 (1 始まり) → `archive.readByIndex()` の添字 (0 始まり)。
 *
 * **ここを黙って間違えると別人のファイルを読む**ので、変換は必ずこの関数を通す。
 * 変換が正しいことは preflight の「entryIndex/path/bytes 一致」で機械が確かめる
 * (ずれていれば 1 項目単位で FAIL する = 黙って進まない)。
 */
export function zeroBasedIndex(entry: number): number {
  return entry - 1;
}

/** 実 ZIP の固定 manifest (§5)。**38 件。並びは entry 昇順。** */
export const TRANSCOS_MANIFEST: readonly ManifestEntry[] = [
  { entry: 1, role: 'ROOT_REFERENCE_ROSTER_IMAGE', path: '10名の情報.xlsx', bytes: 20466, cols: 3, sha256: '7f1f8b69d334a4c9a7ab03b94b2e001bf63f9dc5945af32f3583154aebefc582' },
  { entry: 2, role: 'IGNORE_OFFICE_TEMP', path: '~$10名の情報.xlsx', bytes: 165, sha256: '95532f5614833a27bcd155bfa50bf887131b7efcf339c129413a8f0291841f6f' },
  { entry: 3, role: 'ROOT_REFERENCE_OPERATION_DOC', path: '問診サイト.docx', bytes: 16630, sha256: '5378e6f5a134464818841ee45a83ac50282fbce6b546e4262339787152af8a51' },
  { entry: 5, role: 'GENOPLAN_PDF', path: '１．井上 博文フォルダー/CFBB-IPWY-OKXP (井上 博文1).pdf', bytes: 21254252, pages: 208, sha256: 'd391da558eb5be6d1ffa737661279b4ed3de8317ed63a060946d45a7be6709b1' },
  { entry: 6, role: 'QUESTIONNAIRE_XLSX', path: '１．井上 博文フォルダー/ウェルテクト健康モニタリングサービス（３．井上博文）：共通問診表_トランスコスモス様(1-8) .xlsx', bytes: 16533, cols: 62, sha256: '316588fb49f684f444dd97e3cd4b23a70bb3db228a53a727e9207da2f11513b1' },
  { entry: 7, role: 'HEALTH_PDF', path: '１．井上 博文フォルダー/井上博文.pdf', bytes: 106816, pages: 1, sha256: '68d00909901e2a722cc226cfca083fcebb1bfd755b67ef8c4496dc2791b02f2d' },
  { entry: 9, role: 'GENOPLAN_PDF', path: '１０．吉光 陽平フォルダー/CGAC-NGTF-NVBC (吉光 陽平1).pdf', bytes: 21259411, pages: 208, sha256: 'afed2fd29f474f21a9b4a98a8b6a4653080db003cdf78170959b562485377ce2' },
  { entry: 10, role: 'QUESTIONNAIRE_XLSX', path: '１０．吉光 陽平フォルダー/ウェルテクト健康モニタリングサービス（６．吉光陽平）：共通問診表_トランスコスモス様(1-8) .xlsx', bytes: 16595, cols: 62, sha256: '1336f7ae2d0e6cfef95fe06295af796e543ea35f7ac2d617b2e39b930c970744' },
  { entry: 11, role: 'HEALTH_PDF', path: '１０．吉光 陽平フォルダー/吉光陽平.pdf', bytes: 108851, pages: 1, sha256: 'dd0ab7a82b2cf76a4ee7e94611cb503abe409f077377890f3c619404bc7201ec' },
  { entry: 13, role: 'GENOPLAN_PDF', path: '２．神谷 健志フォルダー/CFBB-JHJH-FIOO (神谷 健志1).pdf', bytes: 21257979, pages: 208, sha256: 'ac7bb92560cc89f1ccba8918be68e2407a9d0678d19c6bba3a7de4f430f723c5' },
  { entry: 14, role: 'QUESTIONNAIRE_PDF_MANUAL', path: '２．神谷 健志フォルダー/問診　神谷様.pdf', bytes: 358742, pages: 5, sha256: 'f9e358d6cee27ab4169a284b1354acafbda6b50a9bfcccc87d5b0c2496689776' },
  { entry: 15, role: 'HEALTH_PDF', path: '２．神谷 健志フォルダー/神谷健志.pdf', bytes: 106154, pages: 1, sha256: '5e33b7273ac43262df014b6e555df50feed6c8fca53f5a798d66d32f30d0ac77' },
  { entry: 17, role: 'GENOPLAN_PDF', path: '３．名倉 英紀フォルダー/CFBB-GZZL-SNSG (名倉 英紀1).pdf', bytes: 21288033, pages: 208, sha256: '0f0cefd0e6d189cf733dfd317a7aebfed6b7e7f369f8afa00634d028f12049e1' },
  { entry: 18, role: 'QUESTIONNAIRE_XLSX', path: '３．名倉 英紀フォルダー/ウェルテクト健康モニタリングサービス（８．名倉　英紀）：共通問診表_トランスコスモス様(1-8) .xlsx', bytes: 16637, cols: 62, sha256: '5e167d9cd1aa4300e34c5201c51bd3bdc649f89d2d182db7f7a09b8e7ed93a9e' },
  { entry: 19, role: 'HEALTH_PDF', path: '３．名倉 英紀フォルダー/名倉英紀.pdf', bytes: 107832, pages: 1, sha256: '6cd4511ae65b8b00cf46aeb02799d429955cfba2abb7bc152c7285db3b9b7dff' },
  { entry: 21, role: 'HEALTH_PDF', path: '４．坂田 幸彦フォルダー/2013359_坂田_幸彦.pdf', bytes: 6338, pages: 1, sha256: '5dd67945c860633caa8b437a401be8ff975b973efb0f342ad647b95733f84c09' },
  { entry: 22, role: 'GENOPLAN_PDF', path: '４．坂田 幸彦フォルダー/CFBB-YQTU-AZFT (坂田 幸彦1).pdf', bytes: 21260092, pages: 208, sha256: 'aedb1c39075a87ef1c85e96302b46eb05d5db12a496d948ecc73c57d2e622913' },
  { entry: 23, role: 'HEALTH_SUPPORT_XLSX', path: '４．坂田 幸彦フォルダー/その他（坂田　幸彦）.xlsx', bytes: 11519, cols: 39, sha256: '2fef4a0c726382f953e0bb6ac15f09d027d40151b4014ec782fd8640f78f58a6' },
  { entry: 24, role: 'QUESTIONNAIRE_XLSX', path: '４．坂田 幸彦フォルダー/ウェルテクト健康モニタリングサービス（４．坂田　幸彦）：共通問診表_トランスコスモス様(1-8) .xlsx', bytes: 16614, cols: 62, sha256: '21c1f608dc879bf13ba901bbd7139dc80812f2468643feda9cdfb29f308aa575' },
  { entry: 26, role: 'HEALTH_PDF', path: '５．岩波 潤フォルダー/2066068_岩波_潤.pdf', bytes: 6111, pages: 1, sha256: '6dbd9df4e12b4cea4c7a53b7f510c1209a3f0ccafc14f09a64cc1443b0ad43db' },
  { entry: 27, role: 'GENOPLAN_PDF', path: '５．岩波 潤フォルダー/CFBB-JLZX-WUWS (岩波 潤1).pdf', bytes: 21269565, pages: 208, sha256: 'f642cee7284d3e84a650aabc00fa220e1a3cd74151c46610f343d25c84467ea8' },
  { entry: 28, role: 'HEALTH_SUPPORT_XLSX', path: '５．岩波 潤フォルダー/その他（岩波　潤）.xlsx', bytes: 11380, cols: 39, sha256: '5fc28f49ff3e9a9ab05af41ef19b706113b368e92522b29e6ab0752ec58cb8d4' },
  { entry: 29, role: 'QUESTIONNAIRE_XLSX', path: '５．岩波 潤フォルダー/ウェルテクト健康モニタリングサービス（７．岩波 潤）：共通問診表_トランスコスモス様(1-8) .xlsx', bytes: 16621, cols: 62, sha256: 'b3227254800530760818e944ee88dce7bc2bc8bf4384dc763fb2c87e1766700f' },
  { entry: 31, role: 'HEALTH_PDF', path: '６．中村 彩香フォルダー/2162068_中村_彩香.pdf', bytes: 6582, pages: 1, sha256: '6bef6504636d57697f5845ddb9a4449305ab3851bc73d73a5c6eebedca1b8581' },
  { entry: 32, role: 'GENOPLAN_PDF', path: '６．中村 彩香フォルダー/CGAC-SJAR-EVSZ (中村 彩香1).pdf', bytes: 21459430, pages: 210, sha256: '2c6dfe2828c9f38bcf9c521cbf8acfe19abcd82f55348734a0c9dc4483e9eead' },
  { entry: 33, role: 'HEALTH_SUPPORT_XLSX', path: '６．中村 彩香フォルダー/その他（中村　彩香）.xlsx', bytes: 11740, cols: 39, sha256: 'fe6737564fb28936af1ec694d5e61f7d4ba2a5b9c1cd119c21e579aabe0b2fa4' },
  { entry: 34, role: 'QUESTIONNAIRE_XLSX', path: '６．中村 彩香フォルダー/ウェルテクト健康モニタリングサービス（５．中村彩香）：共通問診表_トランスコスモス様(1-8) .xlsx', bytes: 16576, cols: 62, sha256: '1de95e0c1627a1f0e6b06ff6f9e1a590ac84271ced8cf39af94f7fbbbc309c8e' },
  { entry: 36, role: 'HEALTH_PDF', path: '７．古原 広行　フォルダー/2030763_古原_広行.pdf', bytes: 6501, pages: 1, sha256: '924b82574ea05e8cccb954b1b4bab47516da5d6e651e4b6b75264a1f20801c9b' },
  { entry: 37, role: 'GENOPLAN_PDF', path: '７．古原 広行　フォルダー/CGAC-KKUC-GPEX (古原 広行1).pdf', bytes: 21239291, pages: 208, sha256: '2c3fcd4dc2158a539fe60641768c6cf551c28583fc4204806b9700ac293a09e4' },
  { entry: 38, role: 'HEALTH_SUPPORT_XLSX', path: '７．古原 広行　フォルダー/その他（古原　広行）.xlsx', bytes: 11659, cols: 39, sha256: 'add9d6f68f8941ff8daba074eb6b3757ead2aebca227e0a947aca456de9c968f' },
  { entry: 39, role: 'QUESTIONNAIRE_PDF_MANUAL', path: '７．古原 広行　フォルダー/ウェルテクト健康モニタリングサービス：共通問診表_トランスコスモス様.pdf', bytes: 353627, pages: 10, sha256: '0b66f75f8144f0293aea0642e378f0e8d997ae9df75814788eff9baee4df9d15' },
  { entry: 41, role: 'HEALTH_PDF', path: '８．辻 陽子フォルダー/2016249_辻_陽子.pdf', bytes: 6065, pages: 1, sha256: '45ce3c6fc4dde55904d082bb04141656fa0497407be092293b45f7e1127ef0d2' },
  { entry: 42, role: 'GENOPLAN_PDF', path: '８．辻 陽子フォルダー/CGAC-RCHE-DHNQ (辻 陽子1).pdf', bytes: 21416031, pages: 210, sha256: '47992f3affa751424b2560f1e5d0a6a0da9a112ebd6280ec2a61151540240b32' },
  { entry: 43, role: 'HEALTH_SUPPORT_XLSX', path: '８．辻 陽子フォルダー/その他（辻　陽子）.xlsx', bytes: 11323, cols: 39, sha256: '69f092fb005791b4368d081b53289e943fd6888ffcea1dd808d312d5a385192f' },
  { entry: 44, role: 'QUESTIONNAIRE_XLSX', path: '８．辻 陽子フォルダー/ウェルテクト健康モニタリングサービス（１．辻　陽子）：共通問診表_トランスコスモス様(1-8).xlsx', bytes: 16551, cols: 62, sha256: '39b85b2a7dcea5464cf19fabbde71c783f356204316ccf2c2584c63f94d6d92d' },
  { entry: 46, role: 'GENOPLAN_PDF', path: '９．堀石 尚男フォルダー/CGAC-ANOM-FKYH (堀石 尚男1).pdf', bytes: 21220278, pages: 208, sha256: '4cf70c90c9c1be0938ae99a4cc886667f3d97cb52d1aba3a5d84c00d93382f3c' },
  { entry: 47, role: 'QUESTIONNAIRE_XLSX', path: '９．堀石 尚男フォルダー/ウェルテクト健康モニタリングサービス（２．堀石尚男）：共通問診表_トランスコスモス様(1-8) .xlsx', bytes: 16548, cols: 62, sha256: 'fa7ad2e6401a388efdc6e3d4fbb4679f23cd76159d3277594ef56508ebae303e' },
  { entry: 48, role: 'HEALTH_PDF', path: '９．堀石 尚男フォルダー/堀石尚男.pdf', bytes: 106353, pages: 1, sha256: '151281f022e4728e251c4b8405fbaa629fd573ad20281985d4cd5747cc3761df' },
];

export interface TranscosSubject {
  /** 人物番号 (1〜10)。**ファイル名の番号とは無関係** (§26-4)。 */
  subjectNo: number;
  /** Executive マスタ照合に使う表示名 (§6)。**exact candidate のみ。** */
  displayName: string;
  /** 健診 PDF の entry 番号。 */
  health: number;
  /** Genoplan PDF の entry 番号。 */
  genoplan: number;
  /** 問診 (XLSX か PDF) の entry 番号。 */
  questionnaire: number;
  /** 健診補助 XLSX の entry 番号 (5 名だけ)。無ければ null。 */
  healthSupport: number | null;
  /**
   * Genoplan の test_date (§7)。
   * 実 ZIP の p2 を目視確認した「発行日」で、**PDF の SHA-256 と一体で固定**する。
   * `本結果レポート作成日 2026-08-25` は使わない。**p2 を Gemini へ送らない。**
   */
  genoplanTestDate: string;
}

/** 人物 manifest (§6 / §7)。**runtime で氏名を推測しない。** */
export const TRANSCOS_SUBJECTS: readonly TranscosSubject[] = [
  { subjectNo: 1, displayName: '井上 博文', health: 7, genoplan: 5, questionnaire: 6, healthSupport: null, genoplanTestDate: '2026-08-12' },
  { subjectNo: 2, displayName: '神谷 健志', health: 15, genoplan: 13, questionnaire: 14, healthSupport: null, genoplanTestDate: '2026-08-12' },
  { subjectNo: 3, displayName: '名倉 英紀', health: 19, genoplan: 17, questionnaire: 18, healthSupport: null, genoplanTestDate: '2026-08-12' },
  { subjectNo: 4, displayName: '坂田 幸彦', health: 21, genoplan: 22, questionnaire: 24, healthSupport: 23, genoplanTestDate: '2026-08-12' },
  { subjectNo: 5, displayName: '岩波 潤', health: 26, genoplan: 27, questionnaire: 29, healthSupport: 28, genoplanTestDate: '2026-08-12' },
  { subjectNo: 6, displayName: '中村 彩香', health: 31, genoplan: 32, questionnaire: 34, healthSupport: 33, genoplanTestDate: '2026-08-12' },
  { subjectNo: 7, displayName: '古原 広行', health: 36, genoplan: 37, questionnaire: 39, healthSupport: 38, genoplanTestDate: '2026-08-12' },
  { subjectNo: 8, displayName: '辻 陽子', health: 41, genoplan: 42, questionnaire: 44, healthSupport: 43, genoplanTestDate: '2026-07-29' },
  { subjectNo: 9, displayName: '堀石 尚男', health: 48, genoplan: 46, questionnaire: 47, healthSupport: null, genoplanTestDate: '2026-07-29' },
  { subjectNo: 10, displayName: '吉光 陽平', health: 11, genoplan: 9, questionnaire: 10, healthSupport: null, genoplanTestDate: '2026-08-12' },
];

/** entry 番号 → manifest 行。無ければ null (**推測で作らない**)。 */
export function manifestEntry(entry: number): ManifestEntry | null {
  return TRANSCOS_MANIFEST.find((m) => m.entry === entry) ?? null;
}

/** file SHA-256 → manifest 行。**content identity からの逆引き** (§4)。 */
export function manifestBySha(sha256: string): ManifestEntry | null {
  const k = String(sha256 ?? '').toLowerCase();
  return TRANSCOS_MANIFEST.find((m) => m.sha256 === k) ?? null;
}

/** 人物番号 → 人物 manifest。 */
export function subjectByNo(subjectNo: number): TranscosSubject | null {
  return TRANSCOS_SUBJECTS.find((s) => s.subjectNo === subjectNo) ?? null;
}

/** その entry を持つ人物 (root 参照資料なら null)。 */
export function subjectOfEntry(entry: number): TranscosSubject | null {
  return TRANSCOS_SUBJECTS.find((s) =>
    s.health === entry || s.genoplan === entry
    || s.questionnaire === entry || s.healthSupport === entry) ?? null;
}

/** role ごとの entry 一覧 (entry 昇順)。 */
export function entriesOfRole(role: TranscosRole): ManifestEntry[] {
  return TRANSCOS_MANIFEST.filter((m) => m.role === role);
}

/**
 * Executive マスタ照合用の正規化 (§6)。
 * **許すのは NFKC + 前後 trim + Unicode 空白を単一半角空白へ、それだけ。**
 * substring / fuzzy / 姓のみ / ファイル番号照合は禁止。
 */
export function normalizeExecutiveName(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/[\s   -   　]+/g, ' ')
    .trim();
}

/** 表示名が一致するか (exact のみ)。 */
export function executiveNameMatches(candidate: unknown, displayName: string): boolean {
  return normalizeExecutiveName(candidate) === normalizeExecutiveName(displayName);
}
