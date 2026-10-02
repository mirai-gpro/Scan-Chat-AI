// src/lib/standard-master.ts
// ②正準化（Normalize）のデータ層 = 業界標準の検査項目マスタ（starter）。
// 参照: docs/scan/基本設定書.md §2.4/§3.6, docs/scan/修正仕様書_標準マスタ.md, docs/scan/基本設定書_実装修正プラン.md(P1)
//
// 役割:
//   - 「出力項目（標準名・単位）を先に固定した空テンプレート」の元データ（S1）。
//   - 正準化エンジン(canonicalize・P2)と checkNecessity の requiredItemsMaster が参照する唯一のマスタ。
//
// ⚠️ 重要（R3・捏造ゼロ）:
//   - starter は「代表ゴールデン検体(docs/scan/golden/scan_golden_healthcheckup_20250123.md)に実在する標準項目」だけを収録する。
//     存在しない標準名を作らない。同義語は「実測の表記ゆれ」だけを登録する。
//   - 完全マスタ(KMAT ver5.0≒2000項目 / 特定健診法定項目)は推進機構/HASTOS or クライアント/Elith から
//     一次資料を受領して差し替える(P5)。その際も StandardItem インターフェースは不変に保つ。
//   - source_std は現時点すべて 'starter'。権威マスタ取込時に 'KMAT'/'特定健診'/'both' へ更新する
//     (一次資料で会員性を確認するまで KMAT/特定健診 とは主張しない)。
//
// 🛡️ 安全設計（誤マップ=捏造の防止）:
//   - findByAlias は「正規化した完全一致」のみ（部分一致しない）。同義語は明示登録に限る。
//     → 例: findByAlias('総蛋白') は '尿蛋白' に当たらない / findByAlias('潜血') は '免疫便潜血反応' に当たらない。
//   - 危険な同義語（尿定性 vs 血液、尿潜血 vs 便潜血、空腹時 vs 随時 等）は登録しない。

export interface StandardItem {
  /** 標準項目名（Elith 納品 name の正準形）。例: '尿酸' */
  canonical_name: string;
  /** 表記ゆれ・section/detail 候補（実測のゆれのみ）。canonical_name 自身は含めなくてよい。 */
  synonyms: string[];
  /** 標準単位。定性項目や単位なし項目は null。 */
  unit: string | null;
  /** 単位の表記ゆれ（P2 の単位正準化で標準単位へ寄せる）。 */
  unit_aliases?: string[];
  /** 単位換算（数値 value に対し factor を掛けて標準単位へ）。無ければ換算しない。 */
  unit_convert?: { from: string; factor: number }[];
  /** 参考（マスタ由来。空補完には使わない＝画像優先。監査/表示用）。 */
  ref_low?: string | null;
  ref_high?: string | null;
  /** 定性項目か（尿定性・便潜血・K-W 等）。 */
  qualitative?: boolean;
  /** 分類（監査・並び用）。 */
  category?: string;
  /** 由来（トレーサビリティ）。starter=当社暫定 / KMAT / 特定健診 / both。 */
  source_std: 'KMAT' | '特定健診' | 'both' | 'starter';
}

/**
 * 照合キー正規化（blood-reference-master の normKey と同方針: NFKC・小文字・空白/記号除去）。
 * ※末尾の 数/量/値 は落とさない（白血球↔白血球数 は明示 synonyms で受ける。
 *   自動で落とすと予期せぬ衝突を生みうるため。捏造ゼロ・安全側）。
 */
export function normKey(s: string): string {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　・（）()]/g, '');
}

// ── starter マスタ本体（すべて docs/scan/golden/scan_golden_healthcheckup_20250123.md に実在） ──
export const STANDARD_MASTER: StandardItem[] = [
  // 身体計測
  { canonical_name: '身長', synonyms: [], unit: 'cm', category: '身体計測', source_std: 'starter' },
  { canonical_name: '体重', synonyms: [], unit: 'kg', category: '身体計測', source_std: 'starter' },
  { canonical_name: '標準体重', synonyms: [], unit: 'kg', category: '身体計測', source_std: 'starter' },
  { canonical_name: 'BMI', synonyms: ['体格指数'], unit: null, category: '身体計測', source_std: 'starter' },
  { canonical_name: '体脂肪率', synonyms: [], unit: '%', category: '身体計測', source_std: 'starter' },
  { canonical_name: '腹囲', synonyms: ['ウエスト周囲径'], unit: 'cm', category: '身体計測', source_std: 'starter' },
  // 血圧（section/detail の当て方が run 毎に揺れる→ pickDeliveryName が最高/最低血圧へ正規化済。同義語で吸収）
  { canonical_name: '最高血圧', synonyms: ['最大血圧', '収縮期血圧', '血圧最高'], unit: 'mmHg', category: '血圧', source_std: 'starter' },
  { canonical_name: '最低血圧', synonyms: ['最小血圧', '拡張期血圧', '血圧最低'], unit: 'mmHg', category: '血圧', source_std: 'starter' },
  // 視力
  { canonical_name: '裸眼視力右', synonyms: ['裸眼右'], unit: null, category: '視力', source_std: 'starter' },
  { canonical_name: '裸眼視力左', synonyms: ['裸眼左'], unit: null, category: '視力', source_std: 'starter' },
  // 眼底/眼圧（時系列リークの標的。①VQA で今回値を確定した後に②を通す）
  { canonical_name: '眼圧右', synonyms: [], unit: 'mmHg', category: '眼科', source_std: 'starter' },
  { canonical_name: '眼圧左', synonyms: [], unit: 'mmHg', category: '眼科', source_std: 'starter' },
  { canonical_name: 'K-W分類右', synonyms: ['KW分類右', 'K-W右'], unit: null, qualitative: true, category: '眼科', source_std: 'starter' },
  { canonical_name: 'K-W分類左', synonyms: ['KW分類左', 'K-W左'], unit: null, qualitative: true, category: '眼科', source_std: 'starter' },
  // 血液一般（今回実施分。分画は今回=空が多く納品対象外＝starter未収録で足りる）
  { canonical_name: '白血球数', synonyms: ['白血球', 'WBC'], unit: '×10²/μL', unit_aliases: ['10^2/μl', '×10^2/μl'], category: '血液一般', source_std: 'starter' },
  { canonical_name: '赤血球数', synonyms: ['赤血球', 'RBC'], unit: '×10⁴/μL', unit_aliases: ['10^4/μl', '×10^4/μl'], category: '血液一般', source_std: 'starter' },
  { canonical_name: '血色素量', synonyms: ['ヘモグロビン', 'Hb', '血色素'], unit: 'g/dL', unit_aliases: ['g/dl'], category: '血液一般', source_std: 'starter' },
  { canonical_name: 'ヘマトクリット', synonyms: ['Ht', 'ヘマトクリット値'], unit: '%', category: '血液一般', source_std: 'starter' },
  { canonical_name: '血小板数', synonyms: ['血小板', 'PLT'], unit: '×10⁴/μL', unit_aliases: ['10^4/μl', '×10^4/μl'], category: '血液一般', source_std: 'starter' },
  // 脂質（空腹時/随時 は別項目として区別。ambiguous な「中性脂肪」単独は登録しない）
  { canonical_name: '空腹時中性脂肪', synonyms: ['空腹時TG'], unit: 'mg/dL', unit_aliases: ['mg/dl'], category: '脂質', source_std: 'starter' },
  { canonical_name: '随時中性脂肪', synonyms: [], unit: 'mg/dL', unit_aliases: ['mg/dl'], category: '脂質', source_std: 'starter' },
  { canonical_name: '総コレステロール', synonyms: ['TC', 'T-Cho', '総コレステロール(TC)'], unit: 'mg/dL', unit_aliases: ['mg/dl'], category: '脂質', source_std: 'starter' },
  { canonical_name: 'HDLコレステロール', synonyms: ['HDL', 'HDL-C'], unit: 'mg/dL', unit_aliases: ['mg/dl'], category: '脂質', source_std: 'starter' },
  { canonical_name: 'LDLコレステロール', synonyms: ['LDL', 'LDL-C'], unit: 'mg/dL', unit_aliases: ['mg/dl'], category: '脂質', source_std: 'starter' },
  { canonical_name: 'LDLコレステロール(F式)', synonyms: ['LDL(F式)', 'LDLコレステロールF式'], unit: 'mg/dL', unit_aliases: ['mg/dl'], category: '脂質', source_std: 'starter' },
  { canonical_name: 'non-HDLコレステロール', synonyms: ['nonHDLコレステロール', 'non-HDL'], unit: 'mg/dL', unit_aliases: ['mg/dl'], category: '脂質', source_std: 'starter' },
  // 糖代謝（空腹時/随時 を区別）
  { canonical_name: '空腹時血糖', synonyms: ['空腹時血糖(FBS)', 'FBS'], unit: 'mg/dL', unit_aliases: ['mg/dl'], category: '糖代謝', source_std: 'starter' },
  { canonical_name: 'HbA1c(NGSP)', synonyms: ['HbA1c', 'ヘモグロビンA1c', 'HbA1cNGSP'], unit: '%', category: '糖代謝', source_std: 'starter' },
  { canonical_name: '尿糖', synonyms: ['尿糖(定性)'], unit: null, qualitative: true, category: '尿定性', source_std: 'starter' },
  // 肝機能
  { canonical_name: 'GOT(AST)', synonyms: ['AST', 'GOT', 'AST(GOT)'], unit: 'U/L', unit_aliases: ['u/l', 'iu/l'], category: '肝機能', source_std: 'starter' },
  { canonical_name: 'GPT(ALT)', synonyms: ['ALT', 'GPT', 'ALT(GPT)'], unit: 'U/L', unit_aliases: ['u/l', 'iu/l'], category: '肝機能', source_std: 'starter' },
  { canonical_name: 'γ-GTP', synonyms: ['γGTP', 'ガンマGTP', 'GGT', 'Y-GTP', 'YGTP', 'Y-GTP(γ-GTP)'], unit: 'U/L', unit_aliases: ['u/l', 'iu/l'], category: '肝機能', source_std: 'starter' },
  { canonical_name: 'ALP', synonyms: ['アルカリフォスファターゼ'], unit: 'IU/L', unit_aliases: ['u/l', 'iu/l'], category: '肝機能', source_std: 'starter' },
  { canonical_name: '総蛋白', synonyms: ['TP', '血清総蛋白', '総タンパク'], unit: 'g/dL', unit_aliases: ['g/dl'], category: '肝機能', source_std: 'starter' },
  // 尿・腎機能
  { canonical_name: 'クレアチニン', synonyms: ['Cr', 'CRE', 'クレアチニン(血清)'], unit: 'mg/dL', unit_aliases: ['mg/dl'], category: '腎機能', source_std: 'starter' },
  { canonical_name: 'eGFR', synonyms: ['推算GFR', 'eGFRcreat'], unit: 'mL/min', unit_aliases: ['ml/min'], category: '腎機能', source_std: 'starter' },
  { canonical_name: '尿蛋白', synonyms: ['蛋白', '尿蛋白(定性)'], unit: null, qualitative: true, category: '尿定性', source_std: 'starter' },
  { canonical_name: '尿潜血', synonyms: ['潜血'], unit: null, qualitative: true, category: '尿定性', source_std: 'starter' },
  // 痛風
  { canonical_name: '尿酸', synonyms: ['痛風', 'UA', '尿酸値'], unit: 'mg/dL', unit_aliases: ['mg/dl'], category: '痛風', source_std: 'starter' },
  // 検便
  { canonical_name: '免疫便潜血反応 1日目', synonyms: ['便潜血1日目', '免疫便潜血1日目', '免疫便潜血反応1日目'], unit: null, qualitative: true, category: '検便', source_std: 'starter' },
  { canonical_name: '免疫便潜血反応 2日目', synonyms: ['便潜血2日目', '免疫便潜血2日目', '免疫便潜血反応2日目'], unit: null, qualitative: true, category: '検便', source_std: 'starter' },
];

// ── 索引（正規化した完全一致のみ。危険な部分一致はしない） ──
/**
 * alias(正規化) → StandardItem の索引を作る。衝突（別項目が同一キー）は starter バグなので
 * 後勝ちさせず先勝ちで無視する（正準化エンジンが opts.master を渡すときも同じ規則で使う）。
 */
export function buildAliasIndex(master: StandardItem[]): Map<string, StandardItem> {
  const idx = new Map<string, StandardItem>();
  for (const item of master) {
    for (const alias of [item.canonical_name, ...item.synonyms]) {
      const k = normKey(alias);
      if (!k) continue;
      if (!idx.has(k)) idx.set(k, item); // 先勝ち（同義語の衝突を検知したら starter を直す）
    }
  }
  return idx;
}
const ALIAS_INDEX: Map<string, StandardItem> = buildAliasIndex(STANDARD_MASTER);

/** checkNecessity の requiredItemsMaster 用: 標準項目名（canonical_name）の一覧。 */
export function masterItemNames(): string[] {
  return STANDARD_MASTER.map((m) => m.canonical_name);
}

/**
 * 名称（canonical_name / synonyms のいずれか）からマスタ項目を引く。
 * 正規化した完全一致のみ（部分一致しない＝誤マップ=捏造の防止）。見つからなければ null。
 */
export function findByAlias(name: string | null | undefined): StandardItem | null {
  if (!name) return null;
  return ALIAS_INDEX.get(normKey(name)) ?? null;
}
