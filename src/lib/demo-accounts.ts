/**
 * **デモ用アカウントの「資格」** — 誰にダミーデータを見せるか。
 *
 * 正本: `docs/operations/デモ用アカウント_仕様書.md`
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【設計の要】デモ用アカウントと管理者アカウントは**別物**。混ぜない。
 * ══════════════════════════════════════════════════════════════════════
 *
 * デモの目的は **UI デザイン確認 / 機能確認 / ビジネスパートナーへのお披露目・PR**。
 * **PR 用のアカウントは社外に渡る**ので、管理者と同じ枠に置くことはできない。
 *
 *   デモの資格  = この一覧に uid があるか。**それだけ。**
 *   管理者権限  = Wellfort 側 `admin_users`（`admin-auth.ts`）。**まったく別系統。**
 *
 * この 2 つは**交わらない**:
 *   - デモ用アカウントは admin にならない（`admin_users` に載せない）
 *   - **admin だからといってダミーを見ない**（見たいなら uid を登録する）
 *   - admin 判定が壊れてもデモは動く（外部依存が無い）
 *   - デモ用アカウントを増やしても、管理権限は 1 ミリも増えない
 *
 * 【なぜこのファイルを分けたか】`demo-data.ts` は**ダミーデータそのもの**を持つ。
 * 「誰に見せるか（資格）」と「何を見せるか（データ）」は別の関心事で、
 * 混ぜていたために「admin なら見せる」という権限の話が
 * データ層に紛れ込んだ（2026-08-30）。**資格はここだけが決める。**
 *
 * 【保存先を差し替えるときもここだけ】将来 `diagnosis.demo_accounts` テーブル
 * （ラベル / 有効期限 / 監査）へ移すときも、変えるのは `demoAccountUids()` の中身だけで、
 * 呼び出し側（~30 箇所）は一切触らない。
 */

import { cfg, refreshConfig, setConfig } from './app-config';

/** uid の表記ゆれを吸収する（大文字・前後の空白）。 */
const norm = (uid?: string | null): string => (uid ?? '').trim().toLowerCase();

/**
 * **この uid はデモ用アカウントか。**
 *
 * 判定はこれ 1 つ。閲覧者が admin かどうかは**見ない**（見てはいけない）。
 *
 * @param uid **表示中の** `diagnostic_user_id`。
 *   admin が `?u=` で代理表示しているときは相手の uid になる ＝
 *   相手がデモ用アカウントでなければダミーは出ない（相手の実データが見える）。
 *   これは正しい挙動で、呼び出し側で場合分けする必要は無い。
 */
export function isDemoAccount(uid?: string | null): boolean {
  const u = norm(uid);
  return !!u && demoAccountUids().has(u);
}

/** デモ表示そのものが有効か（全停止スイッチ）。 */
export function demoDisabledGlobally(): boolean {
  return import.meta.env.PUBLIC_DEMO_FALLBACK === 'false';
}

/**
 * **デモ用アカウントの uid 一覧** = 3 つの供給元の**和**。
 *
 *   1. `BUILTIN_DEMO_UIDS`      … 消えない下限。用途が固定のデモ検体だけ
 *   2. env `DEMO_ALLOWED_UIDS`  … 要デプロイ。DB 障害に影響されない
 *   3. app_config `demo.account_uids` … **admin から即時**（TTL 45 秒・再デプロイ不要）
 *
 * **上書きでなく和。** 上書きにすると 1 件登録した瞬間に他が消え、
 * それまで見えていた画面が黙って空になる。**足せるが消せない**方が事故が軽い。
 * 全部止めるのは `PUBLIC_DEMO_FALLBACK=false` だけ。
 *
 * **キャッシュしない。** `cfg()` は TTL 45 秒で入れ替わるので、ここで固定すると
 * admin の登録が反映されない。文字列の分割だけなので毎回計算してよい。
 */
function demoAccountUids(): ReadonlySet<string> {
  const set = new Set([
    ...BUILTIN_DEMO_UIDS,
    ...splitUids(String(import.meta.env.DEMO_ALLOWED_UIDS ?? '')),
    ...splitUids(cfg('demo.account_uids')),
  ]);
  // **除外は和のあと。** 組み込みと env は「消せない下限」だったが、
  // それでは admin 画面から外せない行が残る (発注者指示 2026-08-30「削除のできるようにして」)。
  // 供給元を消すのではなく**引き算を 1 段足す**ので、戻すのも 1 操作で済む。
  for (const uid of deniedUids()) set.delete(uid);
  return set;
}

/**
 * **除外リスト** — 供給元に関わらずダミーを出さない uid。
 *
 * 組み込み / env の行を admin 画面から外すための唯一の手段。
 * 供給元の側を書き換えるのではなく引き算にしてあるので、
 * **「戻す」で元に戻る**（コードや env を触らなくてよい）。
 */
function deniedUids(): ReadonlySet<string> {
  return new Set(splitUids(cfg('demo.account_denied_uids')));
}

/**
 * ════════════════════════════════════════════════════════════════════════════
 * **表示モード (admin が決める) の名簿**
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 正本 `docs/specs/special_demo_integration_spec_20261022.md` §4.2.3
 * (発注者指示 2026-10-22「ユーザーに切り替えさせる、なんてありえない」)。
 *
 * **ここに在る uid のダッシュボードはデモ表示になる。** 表示モードは
 * **アカウントの属性**であって、利用者が選ぶものではない —
 * SP / デモの枠を使うのは**マスコミ・大口クライアント**なので、
 * 本人の画面に「デモ / 実データ」の切替を出さない (出すと、相手が
 * 自分で切り替えて空の画面や意図しない側に着く)。
 *
 * 【資格 → 表示 の順は崩さない】ここに書いただけでは**デモは出ない**。
 * `resolveViewMode()` が `canDemo` (この名簿ではなく `isDemoAccount`) を
 * 先に見るので、**デモの資格が無い uid を書いても効かない**。
 *
 * 【空のときの既定は変えていない】Dual → 実データ / デモだけ → デモ。
 * **admin が指定しない限り今日までと同じ挙動**。
 */
export function forcedDemoDisplayUids(): ReadonlySet<string> {
  return new Set(splitUids(cfg('demo.display_uids')));
}

/** その uid が **admin によってデモ表示に指定されているか**。資格の判定ではない。 */
export function isForcedDemoDisplay(uid?: string | null): boolean {
  const v = String(uid ?? '').trim().toLowerCase();
  if (!v) return false;
  return forcedDemoDisplayUids().has(v);
}

/**
 * 一覧の文字列を uid の配列にする。
 *
 * **`#` から行末までは注釈**として捨てる。admin の管理画面で
 * 「この uid が誰用か」を書けるようにするため (PR・お披露目で増えるので、
 * uid の羅列だけだと後から誰も分からなくなる)。
 *
 *   bbbbbbbb-...  # パートナーA お披露目 2026-09
 *   cccccccc-...  # 展示会デモ
 *
 * 注釈が無ければ従来どおりカンマ / 空白 / 改行 区切りで並べてよい。
 */
function splitUids(raw: string): string[] {
  return parseEntries(raw).map((e) => e.uid);
}

/** 一覧の 1 行 = uid ＋ 注釈。admin の管理画面が使う。 */
export interface DemoAccountEntry {
  uid: string;
  /** `#` 以降。無ければ空。**PII は書かないこと** (誰用かが分かる短い語で足りる)。 */
  label: string;
}

/** 注釈つきで解析する。**uid の形をしていない語は捨てる** (打ち間違いで壊さない)。 */
export function parseEntries(raw: string): DemoAccountEntry[] {
  const out: DemoAccountEntry[] = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const hash = line.indexOf('#');
    const label = hash >= 0 ? line.slice(hash + 1).trim() : '';
    const body = hash >= 0 ? line.slice(0, hash) : line;
    for (const tok of body.split(/[\s,]+/)) {
      const uid = tok.trim().toLowerCase();
      if (UUID_RE.test(uid)) out.push({ uid, label });
    }
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** uid として妥当か (admin 画面の入力チェックと共有する)。 */
export function isUuid(v: string): boolean {
  return UUID_RE.test(v.trim().toLowerCase());
}

/**
 * 組み込みのデモ用アカウント = **デプロイ無しでは消えない最小限**。
 *
 * - `d0000001…` … テストフェーズの標準デモ（真鍋）。`supabase/seed.sql` の投入先・`DEFAULT_USER`
 * - `da000001…` … OEM 相手先ブランド向けデモ（山田太郎）。`supabase/demo_oem_account.sql`
 * - `14410d5a…` / `186151f8…` … 社内の確認用（2026-08-30 登録）
 *
 * **すべて実顧客ではない。** 一般顧客の uid をここに書かない
 * （常設になり、外すのに再デプロイが要る）。
 *
 * **ここを名簿として育てないこと。** 増えるぶん（PR・お披露目・新しい担当者）は
 * app_config `demo.account_uids` を使う。ここに書き足す運用にすると、
 * アカウント 1 件ごとにデプロイが要る形に戻る。
 */
const BUILTIN_DEMO_UIDS: readonly string[] = [
  'd0000001-0000-0000-0000-000000000000',
  'da000001-0000-0000-0000-000000000000',
  '14410d5a-d515-4fe9-9a8e-bbb1040021ac',
  '186151f8-b4ec-4fcd-bbf5-2bf8aca09bdc',
];

/** 管理画面に「何用か」を出すための説明。**PII は書かない**。 */
const BUILTIN_LABELS: Readonly<Record<string, string>> = {
  'd0000001-0000-0000-0000-000000000000': 'テストフェーズの標準デモ (seed.sql の投入先)',
  'da000001-0000-0000-0000-000000000000': 'OEM 相手先ブランド向けデモ',
  '14410d5a-d515-4fe9-9a8e-bbb1040021ac': '社内の確認用 (2026-08-30 登録)',
  '186151f8-b4ec-4fcd-bbf5-2bf8aca09bdc': '社内の確認用 (2026-08-30 登録)',
};


// ══════════════════════════════════════════════════════════════════════
// Google アカウント (メールアドレス) で登録する
// ══════════════════════════════════════════════════════════════════════
//
// **これが人が使う入口。** uid は機械の識別子で、人は知らない。
// 記者・パートナーに「サインインして UUID を送ってください」とは言えないので、
// **相手の Google アカウントを聞いて登録し、サインインした瞬間にデモが出る**形にする。
//
// 【uid はサインイン時に自動で埋まる】`api/auth/resolve.ts` が
// **サーバで検証済みの email** と解決済みの uid を両方持っているので、そこで突き合わせて
// uid 側の一覧へ写す (`linkDemoEmail`)。**毎リクエストの判定は uid のまま**なので、
// 判定の速さと外部依存ゼロは変わらない。
//
// 【メールアドレスは保存しない — sha256 で照合する】
//   個人情報は Wellfort 側にしか置かない取り決めがあり、`diagnosis` スキーマに
//   メールアドレスの現物を置かない。**保存するのは
//   ①sha256 ②表示用のマスク (`r***@example.com`) ③用途のメモ** の 3 つ。
//   照合はハッシュ同士なので、現物が無くても「この人は登録済みか」は判定できる。

/** 照合キー。**大文字小文字と前後の空白だけ吸収**する (別名記法は正規化しない=取り違え防止)。 */
export async function hashEmail(email: string): Promise<string> {
  const norm = String(email ?? '').trim().toLowerCase();
  if (!norm) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 一覧に出す用のマスク。**現物は残さない**が、誰の行かは分かる。 */
export function maskEmail(email: string): string {
  const norm = String(email ?? '').trim().toLowerCase();
  const at = norm.lastIndexOf('@');
  if (at <= 0) return '***';
  const user = norm.slice(0, at);
  const domain = norm.slice(at + 1);
  const head = user.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(2, user.length - 1))}@${domain}`;
}

/** メールで登録した 1 件。**現物のアドレスは持たない。** */
export interface DemoEmailEntry {
  hash: string;
  masked: string;
  /**
   * サインイン時に判明した `diagnostic_user_id`。まだ本人が来ていなければ空。
   *
   * **ここに持たせるのが要点。** 以前はラベルの一致で「もう来たか」を推測していたが、
   * ラベルは admin が後から書き換えられるので**黙って誤判定する**。
   * 突き合わせた事実そのものを記録する。
   */
  uid: string;
  label: string;
}

const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * 保存形式は 1 行 = `<sha256> <マスク> [uid] # メモ`。人が読めて、機械が壊さない。
 * uid はサインイン前は無い (`-` でも空でもよい)。
 */
export function parseEmailEntries(raw: string): DemoEmailEntry[] {
  const out: DemoEmailEntry[] = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const hashIdx = line.indexOf('#');
    const label = hashIdx >= 0 ? line.slice(hashIdx + 1).trim() : '';
    const parts = (hashIdx >= 0 ? line.slice(0, hashIdx) : line).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const h = parts[0].toLowerCase();
    if (!HASH_RE.test(h)) continue;
    const uid = (parts[2] ?? '').toLowerCase();
    out.push({ hash: h, masked: parts[1] ?? '***', uid: UUID_RE.test(uid) ? uid : '', label });
  }
  return out;
}

export function demoEmailEntries(): DemoEmailEntry[] {
  return parseEmailEntries(cfg('demo.account_emails'));
}

export function serializeEmailEntries(entries: DemoEmailEntry[]): string {
  // uid が未確定でも**列の位置は動かさない** (`-` を置く)。位置がずれると再解析で壊れる。
  return entries
    .map((e) => `${e.hash} ${e.masked} ${e.uid || '-'}${e.label ? `  # ${e.label}` : ''}`)
    .join('\n');
}

/**
 * **顧客レコードを持たないデモ用アカウントに、診断ユーザー ID を与える。**
 *
 * 記者やパートナーは **EC の顧客ではない**ので `resolve-customer` では引けず、
 * そのままだと `linked:false` で「お客様情報が見つかりませんでした」で止まる
 * (実測 2026-08-31: デモ登録しても入口で弾かれる)。
 * デモ用として登録されている人にだけ、**デモ専用の uid** を与えて中へ通す。
 *
 * - **1 度決めたら変わらない。** メール行に記録した uid をそのまま返す
 *   (毎回変わると `app_users` に行が増え続け、履歴も繋がらない)
 * - **顧客レコードは作らない。** 作るのは診断側の識別子だけで、
 *   氏名・住所などの PII は一切生まれない (それらは Wellfort 側にしかない)
 * - **保存はしない。** 直後に呼ばれる `linkDemoEmail` が uid 側の一覧と
 *   メール行の両方へ書く (書き込み口を 2 つに増やさない)
 *
 * @param existingUid **その Google アカウントに既に割り当てられている uid**
 *   (`diagnosis.app_users` を `auth_user_id` / `google_sub` で引いた結果)。
 *   **これを渡さないと新しい uid を作ってしまい、`app_users.auth_user_id` の
 *   UNIQUE 制約に衝突してサインインが 500 で壊れる** (2026-08-31 に本番で実測)。
 * @returns デモ用アカウントなら uid。登録が無ければ null (＝従来どおり未連携)。
 */
export async function resolveDemoUidByEmail(
  email: string | null | undefined,
  existingUid?: string | null,
): Promise<string | null> {
  try {
    if (!email) return null;
    await refreshConfig();
    const h = await hashEmail(email);
    const hit = demoEmailEntries().find((e) => e.hash === h);
    if (!hit) return null;
    /*
     * **新しい uid を作るのは最後の手段。**
     * ① メール行に記録済みの uid → ② その Google アカウントの既存の uid → ③ 新規発行
     * ②を飛ばすと、既に `app_users` に行がある人で UNIQUE 制約に衝突する。
     */
    return hit.uid || norm(existingUid) || crypto.randomUUID();
  } catch (e) {
    console.error('[demo-accounts] resolveDemoUidByEmail 失敗:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * **サインイン時に呼ぶ。** この email がデモ用として登録されていれば、
 * その uid を uid 側の一覧へ写す (以後は uid だけで毎リクエスト判定できる)。
 *
 * @param email `sb.auth.getUser()` が返した**サーバ検証済み**の値。クライアントの申告ではない。
 * @returns 写したら true (＝この人はデモ用アカウント)。
 *
 * **失敗しても例外を投げない。** ここはサインインの経路なので、
 * デモの登録に失敗したせいでサインインが壊れる方が害が大きい。
 */
export async function linkDemoEmail(email: string | null | undefined, uid: string): Promise<boolean> {
  try {
    const u = norm(uid);
    if (!u || !UUID_RE.test(u) || !email) return false;
    /*
     * **強制リフレッシュしない (`refreshConfig()` は TTL を尊重する)。**
     * サインインは全ユーザーが通る経路なので、`refreshConfig(true)` にすると
     * **登録の無い人のサインインごとに DB 往復が 1 回増える** (＝ほぼ毎回)。
     * 登録直後の反映が最大 45 秒遅れるが、これは他の app_config と同じ約束。
     */
    await refreshConfig();
    const h = await hashEmail(email);
    const emails = demoEmailEntries();
    const at = emails.findIndex((e) => e.hash === h);
    if (at < 0) return false; // 登録の無い人 = ここで抜ける (書きに行かない)
    const hit = emails[at];

    const uids = parseEntries(cfg('demo.account_uids'));
    const already = uids.some((e) => e.uid === u);
    if (already && hit.uid === u) return true; // 何も変わらない = 書きに行かない

    const updates: Record<string, string> = {};
    if (!already) {
      uids.push({ uid: u, label: hit.label || hit.masked });
      updates['demo.account_uids'] = uids
        .map((e) => (e.label ? `${e.uid}  # ${e.label}` : e.uid))
        .join('\n');
    }
    if (hit.uid !== u) {
      emails[at] = { ...hit, uid: u };
      updates['demo.account_emails'] = serializeEmailEntries(emails);
    }
    await setConfig(updates, 'sign-in:demo-email');
    await refreshConfig(true); // 次の画面描画で即座に効くように
    return true;
  } catch (e) {
    console.error('[demo-accounts] linkDemoEmail 失敗 (サインインは継続):', e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * **admin の管理画面が見る一覧。** どの供給元から来たかを付けて返す。
 *
 * uid は `diagnostic_user_id` で **PII を含まない**ので admin には見せてよい
 * (むしろ見えないと「誰が登録されているか分からない」= 棚卸しできない)。
 * 氏名やメールは**ここでは扱わない**。
 */
export interface DemoAccountRow extends DemoAccountEntry {
  /** どこから来たか。`config` は消せる / `builtin`・`env` は除外リストで止める。 */
  source: 'builtin' | 'env' | 'config';
  /**
   * メール登録のサインインで自動的に入った行か。
   * **この行は uid 側から外しても次のサインインで戻る**ので、画面でそう示す。
   */
  viaEmail?: boolean;
  /** 除外リストに入っていて、いまダミーが出ない行。画面では「除外中」＋「戻す」。 */
  denied?: boolean;
  /**
   * **admin がこの人をデモ表示に指定しているか** (表示モード・§4.2.3)。
   *
   * 資格 (`source` / `denied`) とは別の軸。**資格があっても、ここが false なら
   * 既定** (Dual=実データ / デモだけ=デモ)。利用者は切り替えられない。
   */
  displayDemo?: boolean;
}

export function listDemoAccounts(): {
  rows: DemoAccountRow[];
  /** メールで登録した一覧。uid はサインイン時に自動で埋まる。 */
  emails: (DemoEmailEntry & { linked: boolean })[];
  disabledGlobally: boolean;
  /** 管理者リストからの初回登録を済ませたか (空なら未実施)。 */
  seededFromAdmins: string;
  /** admin が編集する生テキスト (app_config の値そのまま)。 */
  configRaw: string;
  emailsRaw: string;
  deniedRaw: string;
  /** **デモ表示に指定した uid** の生テキスト (表示モード・§4.2.3)。 */
  displayRaw: string;
} {
  const configRaw = cfg('demo.account_uids');
  const emailsRaw = cfg('demo.account_emails');
  const deniedRaw = cfg('demo.account_denied_uids');
  const displayRaw = cfg('demo.display_uids');
  const denied = deniedUids();
  const forcedDemo = forcedDemoDisplayUids();
  const rows: DemoAccountRow[] = [
    ...BUILTIN_DEMO_UIDS.map((uid) => ({ uid, label: BUILTIN_LABELS[uid] ?? '', source: 'builtin' as const })),
    ...parseEntries(String(import.meta.env.DEMO_ALLOWED_UIDS ?? '')).map((e) => ({ ...e, source: 'env' as const })),
    ...parseEntries(configRaw).map((e) => ({ ...e, source: 'config' as const })),
  ];
  /*
   * `linked` = そのメールの人が**もうサインインしたか**。
   * false なら「登録はしたがまだ本人が来ていない」= 正常。
   * これを出さないと「登録したのに一覧に uid が無い」を不具合と誤解する。
   *
   * 判定は**記録した uid が一覧に在るか**だけを見る。ラベルの一致で推測しない
   * (ラベルは admin が書き換えられるので、推測すると黙って誤判定する)。
   */
  const known = new Set(rows.map((r) => r.uid));
  const emails = parseEmailEntries(emailsRaw).map((e) => ({
    ...e,
    linked: !!e.uid && known.has(e.uid),
  }));

  const fromEmail = new Set(emails.filter((e) => e.uid).map((e) => e.uid));
  for (const r of rows) {
    if (fromEmail.has(r.uid)) r.viaEmail = true;
    if (denied.has(r.uid)) r.denied = true;
    /*
     * **表示モード** (§4.2.3)。`true` = admin がこの人をデモ表示に指定している。
     * **除外された行には立てない** — 除外 = デモの資格が無いので、
     * 名簿に残っていても `resolveViewMode()` は Demo にしない
     * (ここで立てると画面が「デモ表示」と嘘をつく)。
     */
    if (!r.denied && forcedDemo.has(r.uid)) r.displayDemo = true;
  }

  return {
    rows,
    emails,
    disabledGlobally: demoDisabledGlobally(),
    seededFromAdmins: cfg('demo.seeded_from_admins'),
    configRaw,
    emailsRaw,
    deniedRaw,
    displayRaw,
  };
}

/** 監査・診断用の件数だけ (`/api/debug/viewer` が使う)。 */
export function demoAccountStats(): {
  total: number; builtin: number; fromEnv: number; fromConfig: number; disabledGlobally: boolean;
} {
  const { rows, disabledGlobally } = listDemoAccounts();
  const by = (s: DemoAccountRow['source']) => rows.filter((r) => r.source === s).length;
  return {
    total: demoAccountUids().size,
    builtin: by('builtin'),
    fromEnv: by('env'),
    fromConfig: by('config'),
    disabledGlobally,
  };
}
