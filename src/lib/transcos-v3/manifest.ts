// src/lib/transcos-v3/manifest.ts
// トランスコスモス10名 AI疾病予防報告書・臨時処理 v3.0 — **固定 manifest**。
// 正本: `transcos_ai_prevention_emergency_spec_v3_FINAL_20260914.md`
//       §3 / §4 / §8.2 / §8.4 / §9 / §10.4 / §10.5 / §11.4 / §12.4 / §13.2 / Appendix A–C
//
// 【v3 の identity 設計 (§3.1)】
// **Central Directory の index を business identity にしない。**
// 実 ZIP には root directory entry が在り、directory entry を含める / 除外するライブラリ差で
// index がずれる。role / subject の固定キーは **relative path + file SHA-256 + bytes** だけ。
// index は「その実 ZIP の該当 entry を読むための一時 RuntimeLocator」にしか使わず、
// **bytes を取得したら必ず SHA-256 を再確認してから処理する**。
//
// 【使わないもの (§4 / Appendix F)】
// 汎用 `extractPdfText()` / PDF 語彙ヒット / ファイル名の意味推測 / first match /
// fuzzy 氏名一致 / ファイル名中の `(1-8)` 番号 / `10名の情報.xlsx` の氏名セル。

/** 受領済み実 ZIP の identity (§3)。**ここが一致しない入力は専用処理へ入れない。** */
export const TRANSCOS_ZIP = {
  bytes: 159_308_299,
  sha256: '5ad086678047b17a4a0380e2c3c1c7e02332e45e8cfe32a9687fb6243093daf6',
  /** Central Directory の生の総数 (directory entry を含む)。**検査には使うが identity にしない。** */
  rawEntries: 49,
  directoryEntries: 11,
  fileEntries: 38,
  personFolders: 10,
} as const;

/**
 * 期待する common root (§8.2)。**名前まで固定**する。
 * 38 件は全てこの直下または子孫。1 文字でも違えば FAIL・二重 root も FAIL。
 * Appendix A の relative path は、この root を**ちょうど 1 段だけ**除いたもの。
 */
export const EXPECTED_ROOT = '20260910　【トランスコス10名分】の血液・健康データ';

/** この専用 run の識別子。既存テーブルを storage として借りるときの目印 (§19)。 */
export const TRANSCOS_RUN_KIND = 'transcos_v3';

export type TranscosRole =
  | 'HEALTH_PDF'
  | 'HEALTH_SUPPORT_XLSX'
  | 'QUESTIONNAIRE_XLSX'
  | 'QUESTIONNAIRE_PDF_MANUAL'
  | 'GENOPLAN_PDF'
  | 'REFERENCE_ROSTER'
  | 'REFERENCE_OPERATION'
  | 'IGNORE_OFFICE_TEMP';

export interface ManifestFile {
  /** 人物の表示名。root 直下の参照資料は null。 */
  subject: string | null;
  role: TranscosRole;
  /** common root を 1 段だけ除いた relative path。**identity の一部** (§3.1)。 */
  relPath: string;
  /** 展開後のバイト数。**identity の一部**。 */
  bytes: number;
  /** PDF のページ数 (PDF のみ・§8.3)。 */
  pages?: number;
  /** 先頭行の列数 (XLSX のみ・§8.4)。 */
  cols?: number;
  /** 展開後バイト列の SHA-256。**identity の中心**。 */
  sha256: string;
}

/**
 * 実 ZIP の固定 manifest (Appendix A)。**38 件。表の順序は意味を持たない。**
 * Central Directory index は記載しない (§3.1)。
 */
export const TRANSCOS_FILES: readonly ManifestFile[] = [
  { subject: null, role: 'REFERENCE_ROSTER', relPath: '10名の情報.xlsx', bytes: 20466, sha256: '7f1f8b69d334a4c9a7ab03b94b2e001bf63f9dc5945af32f3583154aebefc582' },
  { subject: null, role: 'IGNORE_OFFICE_TEMP', relPath: '~$10名の情報.xlsx', bytes: 165, sha256: '95532f5614833a27bcd155bfa50bf887131b7efcf339c129413a8f0291841f6f' },
  { subject: null, role: 'REFERENCE_OPERATION', relPath: '問診サイト.docx', bytes: 16630, sha256: '5378e6f5a134464818841ee45a83ac50282fbce6b546e4262339787152af8a51' },

  { subject: '井上 博文', role: 'GENOPLAN_PDF', relPath: '１．井上 博文フォルダー/CFBB-IPWY-OKXP (井上 博文1).pdf', bytes: 21254252, pages: 208, sha256: 'd391da558eb5be6d1ffa737661279b4ed3de8317ed63a060946d45a7be6709b1' },
  { subject: '井上 博文', role: 'QUESTIONNAIRE_XLSX', relPath: '１．井上 博文フォルダー/ウェルテクト健康モニタリングサービス（３．井上博文）：共通問診表_トランスコスモス様(1-8) .xlsx', bytes: 16533, cols: 62, sha256: '316588fb49f684f444dd97e3cd4b23a70bb3db228a53a727e9207da2f11513b1' },
  { subject: '井上 博文', role: 'HEALTH_PDF', relPath: '１．井上 博文フォルダー/井上博文.pdf', bytes: 106816, pages: 1, sha256: '68d00909901e2a722cc226cfca083fcebb1bfd755b67ef8c4496dc2791b02f2d' },

  { subject: '吉光 陽平', role: 'GENOPLAN_PDF', relPath: '１０．吉光 陽平フォルダー/CGAC-NGTF-NVBC (吉光 陽平1).pdf', bytes: 21259411, pages: 208, sha256: 'afed2fd29f474f21a9b4a98a8b6a4653080db003cdf78170959b562485377ce2' },
  { subject: '吉光 陽平', role: 'QUESTIONNAIRE_XLSX', relPath: '１０．吉光 陽平フォルダー/ウェルテクト健康モニタリングサービス（６．吉光陽平）：共通問診表_トランスコスモス様(1-8) .xlsx', bytes: 16595, cols: 62, sha256: '1336f7ae2d0e6cfef95fe06295af796e543ea35f7ac2d617b2e39b930c970744' },
  { subject: '吉光 陽平', role: 'HEALTH_PDF', relPath: '１０．吉光 陽平フォルダー/吉光陽平.pdf', bytes: 108851, pages: 1, sha256: 'dd0ab7a82b2cf76a4ee7e94611cb503abe409f077377890f3c619404bc7201ec' },

  { subject: '神谷 健志', role: 'GENOPLAN_PDF', relPath: '２．神谷 健志フォルダー/CFBB-JHJH-FIOO (神谷 健志1).pdf', bytes: 21257979, pages: 208, sha256: 'ac7bb92560cc89f1ccba8918be68e2407a9d0678d19c6bba3a7de4f430f723c5' },
  { subject: '神谷 健志', role: 'QUESTIONNAIRE_PDF_MANUAL', relPath: '２．神谷 健志フォルダー/問診　神谷様.pdf', bytes: 358742, pages: 5, sha256: 'f9e358d6cee27ab4169a284b1354acafbda6b50a9bfcccc87d5b0c2496689776' },
  { subject: '神谷 健志', role: 'HEALTH_PDF', relPath: '２．神谷 健志フォルダー/神谷健志.pdf', bytes: 106154, pages: 1, sha256: '5e33b7273ac43262df014b6e555df50feed6c8fca53f5a798d66d32f30d0ac77' },

  { subject: '名倉 英紀', role: 'GENOPLAN_PDF', relPath: '３．名倉 英紀フォルダー/CFBB-GZZL-SNSG (名倉 英紀1).pdf', bytes: 21288033, pages: 208, sha256: '0f0cefd0e6d189cf733dfd317a7aebfed6b7e7f369f8afa00634d028f12049e1' },
  { subject: '名倉 英紀', role: 'QUESTIONNAIRE_XLSX', relPath: '３．名倉 英紀フォルダー/ウェルテクト健康モニタリングサービス（８．名倉　英紀）：共通問診表_トランスコスモス様(1-8) .xlsx', bytes: 16637, cols: 62, sha256: '5e167d9cd1aa4300e34c5201c51bd3bdc649f89d2d182db7f7a09b8e7ed93a9e' },
  { subject: '名倉 英紀', role: 'HEALTH_PDF', relPath: '３．名倉 英紀フォルダー/名倉英紀.pdf', bytes: 107832, pages: 1, sha256: '6cd4511ae65b8b00cf46aeb02799d429955cfba2abb7bc152c7285db3b9b7dff' },

  { subject: '坂田 幸彦', role: 'HEALTH_PDF', relPath: '４．坂田 幸彦フォルダー/2013359_坂田_幸彦.pdf', bytes: 6338, pages: 1, sha256: '5dd67945c860633caa8b437a401be8ff975b973efb0f342ad647b95733f84c09' },
  { subject: '坂田 幸彦', role: 'GENOPLAN_PDF', relPath: '４．坂田 幸彦フォルダー/CFBB-YQTU-AZFT (坂田 幸彦1).pdf', bytes: 21260092, pages: 208, sha256: 'aedb1c39075a87ef1c85e96302b46eb05d5db12a496d948ecc73c57d2e622913' },
  { subject: '坂田 幸彦', role: 'HEALTH_SUPPORT_XLSX', relPath: '４．坂田 幸彦フォルダー/その他（坂田　幸彦）.xlsx', bytes: 11519, cols: 39, sha256: '2fef4a0c726382f953e0bb6ac15f09d027d40151b4014ec782fd8640f78f58a6' },
  { subject: '坂田 幸彦', role: 'QUESTIONNAIRE_XLSX', relPath: '４．坂田 幸彦フォルダー/ウェルテクト健康モニタリングサービス（４．坂田　幸彦）：共通問診表_トランスコスモス様(1-8) .xlsx', bytes: 16614, cols: 62, sha256: '21c1f608dc879bf13ba901bbd7139dc80812f2468643feda9cdfb29f308aa575' },

  { subject: '岩波 潤', role: 'HEALTH_PDF', relPath: '５．岩波 潤フォルダー/2066068_岩波_潤.pdf', bytes: 6111, pages: 1, sha256: '6dbd9df4e12b4cea4c7a53b7f510c1209a3f0ccafc14f09a64cc1443b0ad43db' },
  { subject: '岩波 潤', role: 'GENOPLAN_PDF', relPath: '５．岩波 潤フォルダー/CFBB-JLZX-WUWS (岩波 潤1).pdf', bytes: 21269565, pages: 208, sha256: 'f642cee7284d3e84a650aabc00fa220e1a3cd74151c46610f343d25c84467ea8' },
  { subject: '岩波 潤', role: 'HEALTH_SUPPORT_XLSX', relPath: '５．岩波 潤フォルダー/その他（岩波　潤）.xlsx', bytes: 11380, cols: 39, sha256: '5fc28f49ff3e9a9ab05af41ef19b706113b368e92522b29e6ab0752ec58cb8d4' },
  { subject: '岩波 潤', role: 'QUESTIONNAIRE_XLSX', relPath: '５．岩波 潤フォルダー/ウェルテクト健康モニタリングサービス（７．岩波 潤）：共通問診表_トランスコスモス様(1-8) .xlsx', bytes: 16621, cols: 62, sha256: 'b3227254800530760818e944ee88dce7bc2bc8bf4384dc763fb2c87e1766700f' },

  { subject: '中村 彩香', role: 'HEALTH_PDF', relPath: '６．中村 彩香フォルダー/2162068_中村_彩香.pdf', bytes: 6582, pages: 1, sha256: '6bef6504636d57697f5845ddb9a4449305ab3851bc73d73a5c6eebedca1b8581' },
  { subject: '中村 彩香', role: 'GENOPLAN_PDF', relPath: '６．中村 彩香フォルダー/CGAC-SJAR-EVSZ (中村 彩香1).pdf', bytes: 21459430, pages: 210, sha256: '2c6dfe2828c9f38bcf9c521cbf8acfe19abcd82f55348734a0c9dc4483e9eead' },
  { subject: '中村 彩香', role: 'HEALTH_SUPPORT_XLSX', relPath: '６．中村 彩香フォルダー/その他（中村　彩香）.xlsx', bytes: 11740, cols: 39, sha256: 'fe6737564fb28936af1ec694d5e61f7d4ba2a5b9c1cd119c21e579aabe0b2fa4' },
  { subject: '中村 彩香', role: 'QUESTIONNAIRE_XLSX', relPath: '６．中村 彩香フォルダー/ウェルテクト健康モニタリングサービス（５．中村彩香）：共通問診表_トランスコスモス様(1-8) .xlsx', bytes: 16576, cols: 62, sha256: '1de95e0c1627a1f0e6b06ff6f9e1a590ac84271ced8cf39af94f7fbbbc309c8e' },

  { subject: '古原 広行', role: 'HEALTH_PDF', relPath: '７．古原 広行　フォルダー/2030763_古原_広行.pdf', bytes: 6501, pages: 1, sha256: '924b82574ea05e8cccb954b1b4bab47516da5d6e651e4b6b75264a1f20801c9b' },
  { subject: '古原 広行', role: 'GENOPLAN_PDF', relPath: '７．古原 広行　フォルダー/CGAC-KKUC-GPEX (古原 広行1).pdf', bytes: 21239291, pages: 208, sha256: '2c3fcd4dc2158a539fe60641768c6cf551c28583fc4204806b9700ac293a09e4' },
  { subject: '古原 広行', role: 'HEALTH_SUPPORT_XLSX', relPath: '７．古原 広行　フォルダー/その他（古原　広行）.xlsx', bytes: 11659, cols: 39, sha256: 'add9d6f68f8941ff8daba074eb6b3757ead2aebca227e0a947aca456de9c968f' },
  { subject: '古原 広行', role: 'QUESTIONNAIRE_PDF_MANUAL', relPath: '７．古原 広行　フォルダー/ウェルテクト健康モニタリングサービス：共通問診表_トランスコスモス様.pdf', bytes: 353627, pages: 10, sha256: '0b66f75f8144f0293aea0642e378f0e8d997ae9df75814788eff9baee4df9d15' },

  { subject: '辻 陽子', role: 'HEALTH_PDF', relPath: '８．辻 陽子フォルダー/2016249_辻_陽子.pdf', bytes: 6065, pages: 1, sha256: '45ce3c6fc4dde55904d082bb04141656fa0497407be092293b45f7e1127ef0d2' },
  { subject: '辻 陽子', role: 'GENOPLAN_PDF', relPath: '８．辻 陽子フォルダー/CGAC-RCHE-DHNQ (辻 陽子1).pdf', bytes: 21416031, pages: 210, sha256: '47992f3affa751424b2560f1e5d0a6a0da9a112ebd6280ec2a61151540240b32' },
  { subject: '辻 陽子', role: 'HEALTH_SUPPORT_XLSX', relPath: '８．辻 陽子フォルダー/その他（辻　陽子）.xlsx', bytes: 11323, cols: 39, sha256: '69f092fb005791b4368d081b53289e943fd6888ffcea1dd808d312d5a385192f' },
  { subject: '辻 陽子', role: 'QUESTIONNAIRE_XLSX', relPath: '８．辻 陽子フォルダー/ウェルテクト健康モニタリングサービス（１．辻　陽子）：共通問診表_トランスコスモス様(1-8).xlsx', bytes: 16551, cols: 62, sha256: '39b85b2a7dcea5464cf19fabbde71c783f356204316ccf2c2584c63f94d6d92d' },

  { subject: '堀石 尚男', role: 'GENOPLAN_PDF', relPath: '９．堀石 尚男フォルダー/CGAC-ANOM-FKYH (堀石 尚男1).pdf', bytes: 21220278, pages: 208, sha256: '4cf70c90c9c1be0938ae99a4cc886667f3d97cb52d1aba3a5d84c00d93382f3c' },
  { subject: '堀石 尚男', role: 'QUESTIONNAIRE_XLSX', relPath: '９．堀石 尚男フォルダー/ウェルテクト健康モニタリングサービス（２．堀石尚男）：共通問診表_トランスコスモス様(1-8) .xlsx', bytes: 16548, cols: 62, sha256: 'fa7ad2e6401a388efdc6e3d4fbb4679f23cd76159d3277594ef56508ebae303e' },
  { subject: '堀石 尚男', role: 'HEALTH_PDF', relPath: '９．堀石 尚男フォルダー/堀石尚男.pdf', bytes: 106353, pages: 1, sha256: '151281f022e4728e251c4b8405fbaa629fd573ad20281985d4cd5747cc3761df' },
];

/** 健診 PDF の目視 Golden (§10.4)。**検査日はここが単一の正**。 */
export interface HealthGolden {
  subject: string;
  /**
   * 健診の実施日。**§4 の Health date 列と同じ値**。
   * 仕様書には §4 と §10.4 の 2 か所に出てくるが、**コードでは 1 か所にしか置かない** —
   * 2 か所に持つと片方だけ直って静かにずれる。§4 との一致は検証スクリプトが見る。
   */
  date: string;
  heightCm: number;
  weightKg: number;
  systolic: number;
  diastolic: number;
  hba1cNgsp: number;
}

export const HEALTH_GOLDEN: readonly HealthGolden[] = [
  { subject: '井上 博文', date: '2025-10-22', heightCm: 170.6, weightKg: 98.0, systolic: 110, diastolic: 72, hba1cNgsp: 5.8 },
  { subject: '神谷 健志', date: '2025-11-13', heightCm: 181.4, weightKg: 71.2, systolic: 125, diastolic: 67, hba1cNgsp: 5.2 },
  { subject: '名倉 英紀', date: '2025-11-14', heightCm: 176.0, weightKg: 81.7, systolic: 96, diastolic: 64, hba1cNgsp: 9.7 },
  { subject: '坂田 幸彦', date: '2025-09-25', heightCm: 169.3, weightKg: 58.3, systolic: 104, diastolic: 74, hba1cNgsp: 5.5 },
  { subject: '岩波 潤', date: '2025-09-18', heightCm: 178.8, weightKg: 62.0, systolic: 93, diastolic: 61, hba1cNgsp: 5.2 },
  { subject: '中村 彩香', date: '2025-10-30', heightCm: 157.1, weightKg: 46.7, systolic: 110, diastolic: 68, hba1cNgsp: 5.3 },
  { subject: '古原 広行', date: '2025-07-11', heightCm: 169.4, weightKg: 66.8, systolic: 125, diastolic: 79, hba1cNgsp: 5.9 },
  { subject: '辻 陽子', date: '2025-08-04', heightCm: 159.6, weightKg: 52.2, systolic: 117, diastolic: 72, hba1cNgsp: 5.6 },
  { subject: '堀石 尚男', date: '2025-09-04', heightCm: 169.5, weightKg: 47.0, systolic: 122, diastolic: 78, hba1cNgsp: 5.0 },
  { subject: '吉光 陽平', date: '2026-01-14', heightCm: 173.5, weightKg: 69.9, systolic: 100, diastolic: 56, hba1cNgsp: 4.9 },
];

export type QuestionnaireKind = 'xlsx' | 'pdf_manual';

export interface TranscosSubject {
  subjectNo: number;
  /** Executive マスタ照合に使う表示名 (§9.1)。**exact 一致のみ。** */
  displayName: string;
  /** relative path の第 1 階層 (§9)。**人物割当はこの固定対応で決める。** */
  folder: string;
  questionnaire: QuestionnaireKind;
  /**
   * 問診の test_date (§11.4)。XLSX 8 名は確定済み期待値。
   * PDF 2 名は **null = operator が原本と業務記録で確定する** (§12.4)。
   */
  questionnaireDate: string | null;
  /** Genoplan の test_date (§13.2)。source p2 の「発行日」。**p2 を LLM へ送らない。** */
  geneticDate: string;
  hasHealthSupport: boolean;
}

export const TRANSCOS_SUBJECTS: readonly TranscosSubject[] = [
  { subjectNo: 1, displayName: '井上 博文', folder: '１．井上 博文フォルダー', questionnaire: 'xlsx', questionnaireDate: '2026-07-10', geneticDate: '2026-08-12', hasHealthSupport: false },
  { subjectNo: 2, displayName: '神谷 健志', folder: '２．神谷 健志フォルダー', questionnaire: 'pdf_manual', questionnaireDate: null, geneticDate: '2026-08-12', hasHealthSupport: false },
  { subjectNo: 3, displayName: '名倉 英紀', folder: '３．名倉 英紀フォルダー', questionnaire: 'xlsx', questionnaireDate: '2026-08-06', geneticDate: '2026-08-12', hasHealthSupport: false },
  { subjectNo: 4, displayName: '坂田 幸彦', folder: '４．坂田 幸彦フォルダー', questionnaire: 'xlsx', questionnaireDate: '2026-07-12', geneticDate: '2026-08-12', hasHealthSupport: true },
  { subjectNo: 5, displayName: '岩波 潤', folder: '５．岩波 潤フォルダー', questionnaire: 'xlsx', questionnaireDate: '2026-08-06', geneticDate: '2026-08-12', hasHealthSupport: true },
  { subjectNo: 6, displayName: '中村 彩香', folder: '６．中村 彩香フォルダー', questionnaire: 'xlsx', questionnaireDate: '2026-07-13', geneticDate: '2026-08-12', hasHealthSupport: true },
  { subjectNo: 7, displayName: '古原 広行', folder: '７．古原 広行　フォルダー', questionnaire: 'pdf_manual', questionnaireDate: null, geneticDate: '2026-08-12', hasHealthSupport: true },
  { subjectNo: 8, displayName: '辻 陽子', folder: '８．辻 陽子フォルダー', questionnaire: 'xlsx', questionnaireDate: '2026-07-03', geneticDate: '2026-07-29', hasHealthSupport: true },
  { subjectNo: 9, displayName: '堀石 尚男', folder: '９．堀石 尚男フォルダー', questionnaire: 'xlsx', questionnaireDate: '2026-07-05', geneticDate: '2026-07-29', hasHealthSupport: false },
  { subjectNo: 10, displayName: '吉光 陽平', folder: '１０．吉光 陽平フォルダー', questionnaire: 'xlsx', questionnaireDate: '2026-08-04', geneticDate: '2026-08-12', hasHealthSupport: false },
];

/**
 * `10名の情報.xlsx` の「実施日」(§12.4)。**問診日の正本ではない。照合用の参考値。**
 * operator 入力と違えば**警告して audit へ残すだけ**で、これだけで自動 BLOCK も自動確定もしない。
 */
export const QUESTIONNAIRE_DATE_REFERENCE: Readonly<Record<string, string>> = {
  '神谷 健志': '2026-08-28',
  '古原 広行': '2026-09-03',
};

/** raw header digest の区切り (U+001F・§8.4 / Appendix B)。 */
export const DIGEST_SEPARATOR = '\u001F';

export const HEADER_DIGEST = {
  /**
   * 問診 62 列。**XLSX セルの raw 文字列を trim / NFKC せず** U+001F で join した SHA-256。
   * **列 47 は実 XLSX 上の末尾改行 `\n` を含む** — 落とすと別値になり FAIL。
   * これは「同じ実 XLSX schema か」の証明で、**各列を production 契約へ写像するときの
   * 比較規則 (`normalizeForm` 適用) とは別物**。
   */
  questionnaire62: '2e30261cb46a68867ab9a8284ac7da21c3fff923f24aaeefc6695a2a8264cdef',
  /** 健診補助 39 列。同じ規則。 */
  healthSupport39: 'e66da0f9a9874d8415ec40e0ce7145ea7b4086cbb5c372f528d7b6cca2e95be2',
} as const;

/**
 * 39 列 XLSX との必須 cross-check 写像 (§10.5)。
 *
 * **これは照合専用であり、Health JSON を生成・補完する alias 表ではない。**
 * production `STANDARD_MASTER` へ synonym を追加しない (本案件では行わない)。
 * `健診日` は測定値でないのでこの表に入れない — §10.4 の source date と
 * Appendix C `健診日` を**日付として** exact 比較する。
 */
export interface CrossCheckPair {
  /** Appendix C の exact header。**fuzzy / substring 禁止。** */
  header: string;
  /** production `STANDARD_MASTER` に exact 1 件存在すべき canonical_name。 */
  canonical: string;
}

export const HEALTH_CROSS_CHECK: readonly CrossCheckPair[] = [
  { header: '身長', canonical: '身長' },
  { header: '体重', canonical: '体重' },
  { header: 'BMI', canonical: 'BMI' },
  { header: '収縮期血圧', canonical: '最高血圧' },
  { header: '拡張期血圧', canonical: '最低血圧' },
  { header: '赤血球数', canonical: '赤血球数' },
  { header: '血色素量', canonical: '血色素量' },
  { header: '空腹時血糖', canonical: '空腹時血糖' },
  { header: 'HbA1c(NGSP)', canonical: 'HbA1c(NGSP)' },
  { header: 'AST(GOT)', canonical: 'GOT(AST)' },
  { header: 'ALT(GPT)', canonical: 'GPT(ALT)' },
  { header: 'γ-GTP', canonical: 'γ-GTP' },
  { header: 'HDL-コレステロール', canonical: 'HDLコレステロール' },
  { header: '空腹時中性脂肪', canonical: '空腹時中性脂肪' },
  { header: 'LDL-コレステロール', canonical: 'LDLコレステロール' },
];

/**
 * 健診補助 XLSX の Golden 39 列 (Appendix C)。**この順・この文字列で exact 一致**。
 *
 * 62 列と違い production 側に正本が無いので、ここが唯一の正。
 * 転記が正しいことは `HEADER_DIGEST.healthSupport39` が機械で証明する
 * (この配列から計算した digest が仕様書の値と一致する = 1 文字も違わない)。
 */
export const HEALTH_SUPPORT_HEADERS: readonly string[] = [
  '社員番号', '漢字氏名', 'カナ氏名', '生年月日', '性別', '実施医療機関名', '健診コース名',
  '健診日', '【定期健診判定区分】', '健診医コメント', '身長', '体重', 'BMI', '腹囲',
  '裸眼視力(右)', '裸眼視力(左)', '矯正視力(右)', '矯正視力(左)',
  '聴力1000(右)', '聴力1000(左)', '聴力4000(右)', '聴力4000(左)',
  '収縮期血圧', '拡張期血圧', '尿蛋白（定性）', '尿糖（定性）',
  '赤血球数', '血色素量', '空腹時血糖', 'HbA1c(NGSP)',
  'AST(GOT)', 'ALT(GPT)', 'γ-GTP', 'HDL-コレステロール', '空腹時中性脂肪', 'LDL-コレステロール',
  '診察所見１', '心電図所見１', '胸部XP所見１',
];

/** Appendix C の健診日の見出し (§10.5 で日付として比較する)。 */
export const HEALTH_SUPPORT_DATE_HEADER = '健診日';

/** 今回納品する 3 形式 (§15)。**これ以外は書かない。** */
export const TRANSCOS_DELIVERY_FORMATS = [
  'HealthCheckupData',
  'LifestyleQuestionnaireData',
  'GeneticTestResultData',
] as const;

export type TranscosFormatId = (typeof TRANSCOS_DELIVERY_FORMATS)[number];

// ---------------------------------------------------------------------------
// 参照ヘルパ (**推測を挟まない引き方だけ**)
// ---------------------------------------------------------------------------

/** relative path → manifest 行。無ければ null。 */
export function fileByPath(relPath: string): ManifestFile | null {
  return TRANSCOS_FILES.find((f) => f.relPath === relPath) ?? null;
}

/** file SHA-256 → manifest 行。**content identity からの逆引き** (§3.1)。 */
export function fileBySha(sha256: string): ManifestFile | null {
  const k = String(sha256 ?? '').toLowerCase();
  return TRANSCOS_FILES.find((f) => f.sha256 === k) ?? null;
}

/** 人物 × role → manifest 行。その人物にその role が 1 件でなければ null。 */
export function fileOf(subject: string, role: TranscosRole): ManifestFile | null {
  const hits = TRANSCOS_FILES.filter((f) => f.subject === subject && f.role === role);
  return hits.length === 1 ? hits[0] : null;
}

export function subjectByNo(subjectNo: number): TranscosSubject | null {
  return TRANSCOS_SUBJECTS.find((s) => s.subjectNo === subjectNo) ?? null;
}

export function subjectByName(displayName: string): TranscosSubject | null {
  return TRANSCOS_SUBJECTS.find((s) => s.displayName === displayName) ?? null;
}

export function goldenOf(subject: string): HealthGolden | null {
  return HEALTH_GOLDEN.find((g) => g.subject === subject) ?? null;
}

export function filesOfRole(role: TranscosRole): ManifestFile[] {
  return TRANSCOS_FILES.filter((f) => f.role === role);
}

/**
 * Executive マスタ照合用の正規化 (§9.1)。
 * **許すのは NFKC + 前後 trim + Unicode 空白を単一半角 space へ、それだけ。**
 * substring / fuzzy / 姓のみ / ファイル番号照合は禁止。
 */
export function normalizeExecutiveName(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/[\s   -   　]+/g, ' ')
    .trim();
}

export function executiveNameMatches(candidate: unknown, displayName: string): boolean {
  return normalizeExecutiveName(candidate) === normalizeExecutiveName(displayName);
}
