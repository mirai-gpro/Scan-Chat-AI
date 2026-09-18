/**
 * ランタイム設定 (app_config)。スキャン精度フラグ・使用モデル等の「運用パラメータ」を DB で一元管理する。
 *
 * 背景 (2026-08 発注者判断): これらは秘匿値でない運用パラメータであり、env は不適
 *   (Vercel ダッシュボードで現在値が見えない / 変更の都度デプロイが要る)。
 *   → Supabase `diagnosis.app_config` を正とし、admin モーダルから可視・即時(TTL反映)に変更する。
 *   秘匿値 (GEMINI_API_KEY / AWS_* / ADMIN_API_KEY / SUPABASE_*) は従来どおり env 据え置き。
 *
 * 優先順位: **DB値 → コード既定 (CONFIG_SPECS.default)**。env フォールバックは持たない (廃止・発注者判断)。
 *   コード既定 = 現行の確定運用 (CLAUDE.md) と一致させ、DB 未接続/障害時も本番挙動を維持する。
 * 反映: サーバ関数インスタンス毎に TTL メモ化 (既定 45s)。admin 保存後は最大 TTL 分のラグで反映。
 */
import { getServerSupabase } from './supabase';

export type ConfigType = 'bool' | 'enum' | 'string';
export interface ConfigSpec {
  key: string;
  type: ConfigType;
  group: string;
  label: string;
  description?: string;
  default: string;
  options?: string[]; // enum の選択肢
}

/**
 * パラメータカタログ (新規パラメータはここに1行追加するだけ = admin に自動表示)。
 * default は **現行の確定運用 (CLAUDE.md)** に一致させること (env 廃止のため DB/既定が唯一の真実)。
 */
export const CONFIG_SPECS: ConfigSpec[] = [
  // ── 画面表示の文言 (Wellfort が admin から編集できるようにする) ──
  // 既定は**空**。空のあいだは UI 側に何も出さない (架空の連絡先や文言を作らない)。
  { key: 'ui.support_contact', type: 'string', group: '画面表示', label: 'サポート窓口', default: '',
    description: 'メニューやエラー画面に出す問い合わせ先 (例: support@example.co.jp / 0120-000-000)。空なら非表示。' },
  { key: 'ui.health_age_followup', type: 'string', group: '画面表示', label: 'ウェルネス年齢のフォローアップ文', default: '',
    description: 'ウェルネス年齢が実年齢より高いときに添える案内文。空なら非表示。'
      + ' **診断・治療の助言にならない範囲で書くこと** (アプリは独自に解釈しない方針)。'
      + ' 例: 「気になる点は次回の検査時に医師へご相談ください。」' },

  // ── デモ用アカウント (UI確認 / 機能確認 / パートナーお披露目・PR) ──
  // **admin 権限とは無関係**。デモを見せる相手は「デモ用アカウント」であって管理者ではない
  // (2026-08-30 発注者指示)。管理者を 1 人増やすたびにダミーの閲覧者が増える形を避ける。
  // ここに載っていない uid は、env にも組み込みにも無ければ**自分の実データだけ**を見る。
  // 判定の実体は `demo-data.ts` の `demoFallbackEnabled` (uid 1 本・同期・外部依存ゼロ)。
  { key: 'demo.account_emails', type: 'string', group: 'デモ', label: 'デモ用アカウント (Google アカウントで登録)', default: '',
    description: '**人が使う入口はこちら。** 相手の Google アカウントを聞いて admin 画面から登録すると、'
      + 'その人がサインインした瞬間にデモが出る (uid は自動で埋まる)。'
      + ' **メールアドレスの現物は保存しない** — 1 行 = sha256 + 表示用マスク + メモ。'
      + ' 直接編集せず /admin/demo-accounts から操作すること。' },
  { key: 'demo.account_uids', type: 'string', group: 'デモ', label: 'デモ用アカウントの uid', default: '',
    description: 'ダミーデータを表示する diagnostic_user_id をカンマ / 空白 / 改行 区切りで。'
      + ' **組み込みの 2 件 (テスト用 d0000001… / OEM 用 da000001…) と env DEMO_ALLOWED_UIDS に足される** '
      + '(ここを空にしても組み込みは消えない → 外すには下の除外リストを使う)。uid は当人の /dashboard「デバッグ」に出ている。'
      + ' 全部止めるときは env PUBLIC_DEMO_FALLBACK=false。' },
  { key: 'demo.account_denied_uids', type: 'string', group: 'デモ', label: 'デモ用アカウントの除外リスト', default: '',
    description: '**供給元に関わらずダミーを出さない uid。** 組み込み / env の行を admin 画面から'
      + '外すための唯一の手段 (供給元を書き換えず引き算するので「戻す」で元に戻る)。'
      + ' 直接編集せず /admin/demo-accounts から操作すること。' },
  { key: 'demo.seeded_from_admins', type: 'string', group: 'デモ', label: '管理者リストからの初回登録 (実施日時)', default: '',
    description: '**内部用の目印。手で編集しない。** /admin/demo-accounts を最初に開いたとき、'
      + '管理者リストのメンバーを 1 度だけ自動登録し、その日時を記録する。'
      + ' **空にすると次回のアクセスで再び自動登録が走る** (外した人が戻ってしまうので注意)。' },

  // ── スペシャルアカウント (EC 購入を伴わない招待。**本人の実データを扱う**) ──
  // **デモ枠とは目的が逆。混ぜない** (`docs/operations/スペシャルアカウント_仕様書.md` §0)。
  // デモ枠に入れると本人の画面に他人名義のダミーが出る。判定の実体は
  // `special-accounts.ts` の `isSpecialAccount` (uid 1 本・同期・外部依存ゼロ)。
  // **全停止スイッチは無い** — 止めるとその人がログインできなくなるため。緊急停止は除外リスト。
  { key: 'special.account_emails', type: 'string', group: 'スペシャル', label: 'スペシャルアカウント (Google アカウントで登録)', default: '',
    description: '**人が使う入口はこちら。** 相手の Google アカウントを登録すると、'
      + 'その人は EC で購入していなくてもサインインできる (uid はサインイン時に自動で埋まる)。'
      + ' **メールアドレスの現物は保存しない** — 1 行 = sha256 + 表示用マスク + uid + メモ。'
      + ' 直接編集せず /admin/special-accounts から操作すること。' },
  { key: 'special.account_uids', type: 'string', group: 'スペシャル', label: 'スペシャルアカウントの uid', default: '',
    description: '判定に使う diagnostic_user_id をカンマ / 空白 / 改行 区切りで。'
      + ' env SPECIAL_ALLOWED_UIDS に足される (和であって上書きではない)。'
      + ' 通常は手で書かず、上のメール登録から自動で埋まる。' },
  { key: 'ui.single_purchase_plan_name', type: 'string', group: 'スペシャル', label: '単品購入のプラン名表示', default: 'AI疾病予防報告書（単品）',
    description: '進捗セクションの右肩に出すプラン名。コースプランは契約から引くが、'
      + '**単品購入 (スペシャルアカウント) は EC 購入が無いので契約から引けない**ため、ここの文言を出す。'
      + ' 空にするとバッジごと消える (発注者指示 2026-09-15 で出すと決めたので、通常は空にしない)。' },
  { key: 'special.account_denied_uids', type: 'string', group: 'スペシャル', label: 'スペシャルアカウントの除外リスト', default: '',
    description: '**供給元に関わらず資格を止める uid。** これが緊急停止の手段'
      + ' (供給元を書き換えず引き算するので「戻す」で元に戻る)。'
      + ' 直接編集せず /admin/special-accounts から操作すること。' },

  // ── AI疾病予防報告書 (docs/旧版・ボツ/ai_prevention_report_generation_spec.md) ──
  // A「初期がんの早期発見」のフォールバック文言 (spec §4.0.1)。
  // **既定は空**。本命は Elith に書いてもらうこと (spec §10.1 E-1)。当社の定型文は
  // 構造上「範囲の説明」にしかならず、「見た上で気になる点はなかった」と言えるのは Elith だけ。
  // 味気なさは意図的に残す — 妥協した文言で埋めると Elith への依頼の必要性が見えなくなる。
  { key: 'ui.cancer_screening_not_included', type: 'string', group: '報告書', label: 'がん早期発見: 予備の文言', default: '',
    description: 'Elith が「初期がんの早期発見」に何も書かなかった回に出す当社の定型文。'
      + ' Elith の記述があればそちらが優先される。'
      + ' 案: 「この報告書は、がんリスク検査を含まない検査データをもとに作成しています。'
      + 'そのため、がんリスクの評価は含まれていません。」— Wellfort の確定待ち。' },

  // 「手元に残す」の端末別 手順 (spec §4.4)。**OS の更新でメニュー名が変わる**ので、
  // 語を直すだけならデプロイを待たずに済むようにしてある。既定は空 = `save-steps.ts` のコード既定。
  { key: 'ui.save_steps', type: 'string', group: '報告書', label: '保存手順の差し替え', default: '',
    description: '`端末キー=手順1｜手順2｜手順3` をカンマ区切り。端末キー = windows / mac / iphone / android。'
      + ' 区切りは全角の縦棒。**上書きすると強調やキーの絵は付かない素の文になる**。'
      + ' 解釈できない端末キー・空の手順は無視してコード既定のまま。'
      + ' 例: android=右上の ⋮ を押して 共有 を選びます｜印刷 を選びます｜PDF として保存 を選びます' },

  // ── 章立て (spec §1.3.2) ──
  // **既定は 4 つとも空 = コード既定のレジストリ** (`report-sections.ts` CHAPTER_REGISTRY)。
  // 章の順序・表示可否・見出し・既定の開閉を「デプロイ不要・admin から即時」で変えるための口。
  // 章ごとにキーを生やさない — `ConfigType` が 3 種しかなく、章を足すたび CONFIG_SPECS が
  // 4 行増える形を避けている。**未知キーは無視される** (打ち間違いで画面が空にならない)。
  // 章キー: cancer_finding / medical_visit / measurements / summary / abstract / lifestyle /
  //         diet_plan / diet / exercise / sleep / nutrients / references
  { key: 'report.sections.order', type: 'string', group: '報告書', label: '章の並び', default: '',
    description: '章キーをカンマ区切りで。**書いた章だけを書いた順で出す** (列挙しなかった章は出ない)。'
      + ' 空ならコード既定の全章。例: cancer_finding,medical_visit,measurements' },
  { key: 'report.sections.hidden', type: 'string', group: '報告書', label: '非表示にする章', default: '',
    description: '章キーをカンマ区切り。並びより後に効く。例: references,nutrients' },
  { key: 'report.sections.labels', type: 'string', group: '報告書', label: '見出しの差し替え', default: '',
    description: '`章キー=表示名` をカンマ区切り。空ならレジストリ既定 (さらに空なら受領 JSON の section_name)。'
      + ' 例: medical_visit=今回いちばん大事なこと' },
  { key: 'report.sections.collapsed', type: 'string', group: '報告書', label: '既定で畳む章', default: '',
    description: '章キーをカンマ区切り。**印刷ビュー (?print=1) では無視される**'
      + ' (畳んだ状態が紙面に漏れると本文が欠けるため)。例: diet,exercise,sleep' },

  // ── モデル ──
  { key: 'scan.model', type: 'enum', group: 'モデル', label: 'スキャン用モデル', default: 'gemini-3.1-flash-lite',
    options: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash'],
    description: '画像解析/REST 呼び出しに使うモデル。既定=3.1-flash-lite (軽量安定)。3.5-flash-lite=GA(2026-07)。' },
  { key: 'live.model', type: 'string', group: 'モデル', label: 'AI問診(Live)用モデル', default: 'gemini-3.8-live',
    description: 'Live API 専用 (REST 非対応)。3.8 は proactive audio が恒久 ON。戻すなら gemini-3.1-flash-live-preview。' },
  // ── スキャン読取 (確定運用スタック) ──
  { key: 'scan.output_format', type: 'enum', group: 'スキャン読取', label: '出力形式', default: 'markdown', options: ['markdown', 'json'],
    description: 'markdown=GFM表経路(既定)。json=responseSchema構造化(補助欄暴走のため未採用)。' },
  { key: 'scan.boundary_recheck', type: 'bool', group: 'スキャン読取', label: '境界定性の2パス再読(VQA)', default: 'on',
    description: '空だった定性(尿蛋白/潜血/糖/便潜血/K-W)を軽量VQAで再読・充填。numeric不変。' },
  { key: 'scan.obs_dedup', type: 'bool', group: 'スキャン読取', label: '観測dedup(別名重複統合)', default: 'on',
    description: '同一概念・同値のみ統合。別値は競合記録(自動採用しない)。' },
  { key: 'scan.scramble_fix', type: 'bool', group: 'スキャン読取', label: '基準レンジ再割当(肝/鉄scramble)', default: 'on' },
  { key: 'scan.eye_resolve', type: 'bool', group: 'スキャン読取', label: '眼科 collapsed-row 付替', default: 'on' },
  { key: 'scan.lipid_fix', type: 'bool', group: 'スキャン読取', label: '脂質 LDL↔TG 物理制約修正', default: 'on' },
  { key: 'scan.canonicalize', type: 'bool', group: 'スキャン読取', label: '②正準化(標準マスタ名寄せ)', default: 'off',
    description: '🎯回帰ゼロ確認後に on 化予定。' },
  { key: 'scan.perception_repair', type: 'bool', group: 'スキャン読取', label: 'P-perc 画像証拠後段補修', default: 'off',
    description: 'VQAインベントリ/領域照合。当面 off 推奨 (baseline が優位)。' },
  { key: 'scan.vqa_rowcrop', type: 'bool', group: 'スキャン読取', label: '行クロップ独立VQA(timeline_leak)', default: 'off' },
  { key: 'scan.ai_prediction_dedup', type: 'bool', group: 'スキャン読取', label: 'AI疾病発症予測 統合(LAiF)', default: 'off' },
  // ── 捏造ゲート (False-Value 抑制・決定論・docs/scan/修正仕様書_捏造ゲート.md) ──
  { key: 'fabgate.unperformed', type: 'bool', group: '捏造ゲート', label: 'G1 未実施ブロック抑制(尿定性/便潜血)', default: 'off',
    description: '比重/pH が両欠落=尿ディップ未実施なら(-)充填を抑止。実施ブロックの救済は不変。' },
  { key: 'fabgate.refbleed', type: 'bool', group: '捏造ゲート', label: 'G2 基準吸い上げドロップ(腹囲等)', default: 'off',
    description: '身体計測4項目で value==片側基準閾値をドロップ。' },
  { key: 'fabgate.reftable', type: 'bool', group: '捏造ゲート', label: 'G3 参考資料/基準値表 行除外', default: 'off',
    description: 'レンジ値(A〜B)/未設定/男性女性基準名 をドロップ(B3基準値表)。' },
  { key: 'fabgate.adjacent', type: 'bool', group: '捏造ゲート', label: 'G4 隣接漏れ監査(体脂肪率==BMI)', default: 'off',
    description: '偶然一致し得るため明示on時のみ(anomalies 監査へ)。' },
];

const DEFAULTS: Record<string, string> = Object.fromEntries(CONFIG_SPECS.map((s) => [s.key, s.default]));
const KNOWN_KEYS = new Set(CONFIG_SPECS.map((s) => s.key));

const TTL_MS = 45_000;
let cache: Map<string, string> | null = null;
let cacheTs = 0;

/** DB から設定を読み込みキャッシュへ。TTL 内かつ force でなければ no-op。障害時は既存キャッシュ(なければ空)を維持。 */
export async function refreshConfig(force = false): Promise<void> {
  const now = Date.now();
  if (!force && cache && now - cacheTs < TTL_MS) return;
  const sb = getServerSupabase();
  if (!sb) { if (!cache) cache = new Map(); cacheTs = now; return; } // dev/未設定: 既定運用
  try {
    const { data, error } = await (sb.schema('diagnosis') as unknown as {
      from: (t: string) => { select: (c: string) => Promise<{ data: Array<{ key: string; value: string | null }> | null; error: unknown }> };
    }).from('app_config').select('key,value');
    if (error) throw error;
    const m = new Map<string, string>();
    for (const r of data ?? []) if (r && typeof r.key === 'string') m.set(r.key, r.value == null ? '' : String(r.value));
    cache = m;
    cacheTs = now;
  } catch {
    if (!cache) { cache = new Map(); cacheTs = now; } // 障害時は既定へフォールバック(本番挙動維持)
  }
}

/** 現在値 (DB → 既定)。同期。事前に refreshConfig() 済みが前提 (未実行でも既定=本番挙動)。 */
export function cfg(key: string): string {
  const v = cache?.get(key);
  return v != null && v !== '' ? v : DEFAULTS[key] ?? '';
}
export function cfgBool(key: string): boolean {
  return ['on', 'true', '1', 'yes'].includes(cfg(key).trim().toLowerCase());
}
export function getScanModel(): string { return cfg('scan.model'); }
export function getLiveModel(): string { return cfg('live.model'); }

/** admin 用: 全パラメータ (spec + 現在値) を返す。必ず最新を取りに行く。 */
export async function listConfig(): Promise<Array<ConfigSpec & { value: string }>> {
  await refreshConfig(true);
  return CONFIG_SPECS.map((s) => ({ ...s, value: cfg(s.key) }));
}

/** admin 用: パラメータを upsert。未知キーは無視。保存後キャッシュを即更新。 */
export async function setConfig(updates: Record<string, string>, updatedBy?: string): Promise<{ ok: boolean; updated: string[]; reason?: string }> {
  const sb = getServerSupabase();
  if (!sb) return { ok: false, updated: [], reason: 'supabase_not_configured' };
  const rows = Object.entries(updates)
    .filter(([k]) => KNOWN_KEYS.has(k))
    .map(([key, value]) => ({ key, value: String(value ?? ''), updated_by: updatedBy ?? null, updated_at: new Date().toISOString() }));
  if (rows.length === 0) return { ok: false, updated: [], reason: 'no_known_keys' };
  const { error } = await (sb.schema('diagnosis') as unknown as {
    from: (t: string) => { upsert: (r: unknown, o: unknown) => Promise<{ error: unknown }> };
  }).from('app_config').upsert(rows, { onConflict: 'key' });
  if (error) return { ok: false, updated: [], reason: String((error as { message?: string })?.message ?? error) };
  await refreshConfig(true);
  return { ok: true, updated: rows.map((r) => r.key) };
}
