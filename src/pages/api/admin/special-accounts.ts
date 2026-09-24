/**
 * admin: **スペシャルアカウント**の一覧取得 / 追加 / 削除 API。
 *
 * 正本: `docs/operations/スペシャルアカウント_仕様書.md`
 *
 * 【デモ用アカウントとは別の口】仕組みは似ているが**目的が逆** —
 * あちらはダミーを見せる枠 (社外に渡す)、こちらは**本人の実データ**を扱う枠。
 * 同じ画面・同じ口に置くと「ダミーを見せる」と「実データで使ってもらう」が
 * 区別できなくなるので分けてある (仕様書 §0 / §9.2)。
 *
 * 【扱うのは uid とメールのハッシュだけ】`diagnostic_user_id` は PII を含まない。
 * **メールアドレスの現物は保存しない** (sha256 / 表示用マスク / uid / メモ の 4 つだけ)。
 * 氏名は一切扱わない。
 *
 * 【admin 権限とは別物】この API は「スペシャルアカウントを**管理する**」ためのもので、
 * **admin であることが資格になる訳ではない** (仕様書 §9.3)。
 * デモ枠にある「管理者リストから初回登録」は**本枠では実装しない** —
 * 実データが紐づくので、名簿を写して自動登録するのは危険。
 *
 *   GET    → { ok, rows:[{uid,label,source,viaEmail,denied}], emails:[…] }
 *   POST   → { add_email:[{email,label}] } / { remove_email:[hash] }   ← **人が使う入口**
 *            { add:[{uid,label}] }        / { remove:[uid] }           ← uid を直接
 *            { deny:[uid] }               / { undeny:[uid] }           ← 止める / 戻す
 *          → 更新後の一覧 + rejected[]
 *
 * 認可: wellfort-site から Bearer ADMIN_API_KEY (`api-auth.ts`)。
 * UI は wellfort-site 側 (`/admin/special-accounts`)。**このリポジトリに admin 画面は作らない。**
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../lib/api-auth';
import { refreshConfig, setConfig } from '../../../lib/app-config';
import { hashEmail, isUuid, maskEmail, parseEmailEntries, parseEntries, serializeEmailEntries } from '../../../lib/demo-accounts';
import { listSpecialAccounts, serializeUidEntries } from '../../../lib/special-accounts';
import { getAccountProgress } from '../../../lib/account-progress';

export const prerender = false;

const KEY = 'special.account_uids';
const EMAIL_KEY = 'special.account_emails';
const DENY_KEY = 'special.account_denied_uids';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 一覧は必ず**最新を取りに行ってから**返す (TTL 45 秒の残りで古い値を見せない)。 */
async function snapshot() {
  await refreshConfig(true);
  return listSpecialAccounts();
}

export const GET: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    const snap = await snapshot();
    /*
     * **AI問診 / スキャンの完了ステータスを uid ごとに添える** (発注者要望 2026-09-24)。
     * rows(uid あり) と emails(サインイン済みで uid あり) の uid を集めて一括取得。
     * データは Scan-Chat-AI の diagnosis スキーマ (interview_completions / test_artifacts)。
     * **失敗しても一覧は返す** (status は空になるだけ・画面を壊さない)。
     */
    const uids = [
      ...snap.rows.map((r) => r.uid),
      ...snap.emails.map((e) => e.uid).filter((u): u is string => !!u),
    ];
    const status = await getAccountProgress(uids);
    return json({ ok: true, ...snap, status });
  } catch (e) {
    return json({ ok: false, error: 'list_failed', detail: String((e as { message?: string })?.message ?? e) }, 500);
  }
};

export const POST: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: {
    add?: unknown; remove?: unknown;
    add_email?: unknown; remove_email?: unknown;
    deny?: unknown; undeny?: unknown;
    updated_by?: unknown;
  } = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const lower = (v: unknown[]) => v.map((x) => String(x).trim().toLowerCase());
  const add = Array.isArray(body.add) ? body.add : [];
  const remove = Array.isArray(body.remove) ? lower(body.remove) : [];
  const addEmail = Array.isArray(body.add_email) ? body.add_email : [];
  const removeEmail = Array.isArray(body.remove_email) ? lower(body.remove_email) : [];
  const deny = Array.isArray(body.deny) ? lower(body.deny) : [];
  const undeny = Array.isArray(body.undeny) ? lower(body.undeny) : [];
  if (add.length === 0 && remove.length === 0 && addEmail.length === 0
      && removeEmail.length === 0 && deny.length === 0 && undeny.length === 0) {
    return json({ ok: false, error: 'nothing_to_do' }, 400);
  }

  const cur = await snapshot();
  // **編集できるのは app_config 由来だけ。** 組み込みと env はここからは動かせない。
  const entries = parseEntries(cur.configRaw);
  const emails = parseEmailEntries(cur.emailsRaw);
  const rejected: { uid: string; reason: string }[] = [];

  for (const raw of add) {
    const uid = String((raw as { uid?: unknown })?.uid ?? raw ?? '').trim().toLowerCase();
    // **ラベルに改行と `#` を入れない** — 保存形式が 1 行 1 件なので行が壊れる。
    const label = String((raw as { label?: unknown })?.label ?? '').replace(/[\r\n#]/g, ' ').trim().slice(0, 80);
    if (!isUuid(uid)) { rejected.push({ uid, reason: 'uid の形式が違う' }); continue; }
    if (cur.rows.some((r) => r.uid === uid && r.source !== 'config')) {
      rejected.push({ uid, reason: '組み込み / env に既に登録されている (追加不要)' });
      continue;
    }
    const at = entries.findIndex((e) => e.uid === uid);
    if (at >= 0) entries[at] = { uid, label: label || entries[at].label };
    else entries.push({ uid, label });
  }

  for (const uid of remove) {
    if (cur.rows.some((r) => r.uid === uid && r.source !== 'config')) {
      rejected.push({ uid, reason: '組み込み / env は除外リストで止める (画面の「外す」がそうする)' });
      continue;
    }
    /*
     * **メール登録から来た uid は uid 側だけ外しても戻ってくる。**
     * 次のサインインで `linkSpecialEmail` が同じ uid を書き直すため、
     * 外したつもりが数分後に復活する = 黙って効かない操作になる。メール行の側で外させる。
     */
    const src = emails.find((e) => e.uid === uid);
    if (src) {
      rejected.push({ uid, reason: `メール登録 (${src.masked}) から来ているので、そちらを外してください` });
      continue;
    }
    const at = entries.findIndex((e) => e.uid === uid);
    if (at < 0) rejected.push({ uid, reason: '登録されていない' });
    else entries.splice(at, 1);
  }

  /*
   * ── Google アカウント (メール) で登録する側 ─────────────────────
   * **これが人が使う入口。** 相手に UUID は聞けない。
   * uid はサインイン時に自動で埋まる (`linkSpecialEmail`)。
   */
  for (const raw of addEmail) {
    const addr = String((raw as { email?: unknown })?.email ?? raw ?? '').trim().toLowerCase();
    const label = String((raw as { label?: unknown })?.label ?? '').replace(/[\r\n#]/g, ' ').trim().slice(0, 80);
    // 形だけ見る。**実在確認はしない** (できない)。
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
      rejected.push({ uid: addr, reason: 'メールアドレスの形式が違う' });
      continue;
    }
    const h = await hashEmail(addr);
    const at = emails.findIndex((e) => e.hash === h);
    if (at >= 0) emails[at] = { ...emails[at], label: label || emails[at].label };
    else emails.push({ hash: h, masked: maskEmail(addr), uid: '', label });
  }
  for (const key of removeEmail) {
    // 画面からは hash を渡す (現物のアドレスを往復させない)。
    const at = emails.findIndex((e) => e.hash === key);
    if (at < 0) { rejected.push({ uid: key, reason: '登録されていない' }); continue; }
    /*
     * **サインイン済みなら uid 側も一緒に外す。**
     * メールを外しただけでは uid が残り、本人には資格が残り続ける
     * (画面上は「外れた」ように見えるのに実際は外れていない = 一番まずい形)。
     */
    const linked = emails[at].uid;
    emails.splice(at, 1);
    if (linked) {
      const ui = entries.findIndex((e) => e.uid === linked);
      if (ui >= 0) entries.splice(ui, 1);
    }
  }

  /*
   * ── 除外リスト ────────────────────────────────────────────────
   * **本枠の緊急停止はこれ。** 全停止の env スイッチは持たない (仕様書 §7)。
   * 供給元は残るので「戻す」で元どおりになる。
   */
  const denied = parseEntries(cur.deniedRaw);
  for (const raw of deny) {
    const uid = String(raw).trim().toLowerCase();
    if (!isUuid(uid)) { rejected.push({ uid, reason: 'uid の形式が違う' }); continue; }
    const row = cur.rows.find((r) => r.uid === uid);
    if (denied.some((e) => e.uid === uid)) { rejected.push({ uid, reason: 'すでに除外されている' }); continue; }
    denied.push({ uid, label: row?.label ?? '' });
  }
  for (const raw of undeny) {
    const uid = String(raw).trim().toLowerCase();
    const at = denied.findIndex((e) => e.uid === uid);
    if (at < 0) rejected.push({ uid, reason: '除外リストに無い' });
    else denied.splice(at, 1);
  }

  const value = serializeUidEntries(entries);
  const deniedValue = serializeUidEntries(denied);
  const emailValue = serializeEmailEntries(emails);

  /*
   * **中身が変わらないなら保存しない。**
   * 全件が却下されたリクエストでも書きに行くと、保存の失敗が返って
   * **却下理由が見えなくなる**。理由が伝わらないと admin は原因を追えない。
   */
  const updates: Record<string, string> = {};
  if (value !== cur.configRaw) updates[KEY] = value;
  if (emailValue !== cur.emailsRaw) updates[EMAIL_KEY] = emailValue;
  if (deniedValue !== cur.deniedRaw) updates[DENY_KEY] = deniedValue;
  if (Object.keys(updates).length > 0) {
    const updatedBy = typeof body.updated_by === 'string' ? body.updated_by : undefined;
    const r = await setConfig(updates, updatedBy);
    if (!r.ok) return json({ ok: false, error: 'save_failed', detail: r, rejected }, 400);
  }

  return json({ ok: true, ...(await snapshot()), rejected });
};
