/**
 * admin: **デモ用アカウント**の一覧取得 / 追加 / 削除 API。
 *
 * 正本: `docs/operations/デモ用アカウント_仕様書.md`
 *
 * 【なぜ専用の口か】`/api/admin/config` の汎用モーダルでも `demo.account_uids` は
 * 編集できるが、**テキスト 1 行の塊を手で書き換える**形になる。
 * デモ用アカウントは **PR・お披露目で増えていく**運用なので、
 * 「いま誰が登録されているか」「1 件足す / 1 件外す」を安全にできる口を分けた。
 *
 * 【扱うのは uid だけ】`diagnostic_user_id` は **PII を含まない**。
 * 氏名・メールはここでは一切扱わない (PII は Wellfort 側にしか置かない取り決め)。
 *
 * 【admin 権限とは別物】この API は「デモ用アカウントを**管理する**」ためのもので、
 * **管理者にデモを見せるためのものではない**。デモの資格は uid の登録だけで決まり、
 * admin であることは資格にならない (仕様書 §2)。
 *
 *   GET    → { ok, rows:[{uid,label,source,viaEmail,denied}], emails:[…], disabledGlobally,
 *              seededFromAdmins }
 *   POST   → { add_email:[{email,label}] } / { remove_email:[hash] }   ← **人が使う入口**
 *            { add:[{uid,label}] }        / { remove:[uid] }           ← uid を直接
 *            { deny:[uid] }               / { undeny:[uid] }           ← 組み込み / env を止める
 *            { mark_seeded:true }                                      ← 初回登録の目印
 *          → 更新後の一覧 + rejected[]
 *
 * 認可: wellfort-site から Bearer ADMIN_API_KEY (`api-auth.ts`・キー未設定の本番は拒否)。
 * UI は wellfort-site 側 (`/admin/demo-accounts`)。**このリポジトリに admin 画面は作らない。**
 */
import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../lib/api-auth';
import { refreshConfig, setConfig } from '../../../lib/app-config';
import {
  hashEmail, isUuid, listDemoAccounts, maskEmail,
  parseEmailEntries, parseEntries, serializeEmailEntries,
} from '../../../lib/demo-accounts';
import { specialEmailEntries } from '../../../lib/special-accounts';
import { canonicalUidForRegistration } from '../../../lib/experience-accounts';

export const prerender = false;

const KEY = 'demo.account_uids';
const EMAIL_KEY = 'demo.account_emails';
const DENY_KEY = 'demo.account_denied_uids';
const SEEDED_KEY = 'demo.seeded_from_admins';
/** **表示モード** (admin が決める・利用者は切り替えられない)。§4.2.3。 */
const DISPLAY_KEY = 'demo.display_uids';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 一覧は必ず**最新を取りに行ってから**返す (TTL 45 秒の残りで古い値を見せない)。 */
async function snapshot() {
  await refreshConfig(true);
  return listDemoAccounts();
}

export const GET: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    return json({ ok: true, ...(await snapshot()) });
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
    display_demo?: unknown; display_real?: unknown;
    mark_seeded?: unknown;
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
  /*
   * **表示モード** (§4.2.3)。`display_demo` = デモ表示にする / `display_real` = 既定へ戻す。
   * **利用者が切り替える経路は無い**ので、ここが唯一の書き口。
   */
  const displayDemo = Array.isArray(body.display_demo) ? lower(body.display_demo) : [];
  const displayReal = Array.isArray(body.display_real) ? lower(body.display_real) : [];
  const markSeeded = body.mark_seeded === true;
  if (add.length === 0 && remove.length === 0 && addEmail.length === 0
      && removeEmail.length === 0 && deny.length === 0 && undeny.length === 0
      && displayDemo.length === 0 && displayReal.length === 0 && !markSeeded) {
    return json({ ok: false, error: 'nothing_to_do' }, 400);
  }

  const cur = await snapshot();
  // **編集できるのは app_config 由来だけ。** 組み込みと env はここからは動かせない。
  const entries = parseEntries(cur.configRaw);

  const rejected: { uid: string; reason: string }[] = [];

  for (const raw of add) {
    const uid = String((raw as { uid?: unknown })?.uid ?? raw ?? '').trim().toLowerCase();
    // **ラベルに改行と `#` を入れない** — 保存形式が 1 行 1 件なので行が壊れる。
    const label = String((raw as { label?: unknown })?.label ?? '').replace(/[\r\n#]/g, ' ').trim().slice(0, 80);
    if (!isUuid(uid)) { rejected.push({ uid, reason: 'uid の形式が違う' }); continue; }
    if (cur.rows.some((r) => r.uid === uid && r.source !== 'config')) {
      // 組み込み / env に既にある = すでにデモが出る。二重に足しても意味が無い。
      rejected.push({ uid, reason: '組み込み / env に既に登録されている (追加不要)' });
      continue;
    }
    const at = entries.findIndex((e) => e.uid === uid);
    if (at >= 0) entries[at] = { uid, label: label || entries[at].label };
    else entries.push({ uid, label });
  }

  /*
   * ── Google アカウント (メール) で登録する側 ─────────────────────
   *
   * **これが人が使う入口。** 記者やパートナーに UUID は聞けないので、
   * 相手の Google アカウントを聞いて登録する。uid はサインイン時に自動で埋まる
   * (`linkDemoEmail`)。**メールアドレスの現物は保存しない** — sha256 と表示用マスクだけ。
   */
  const emails = parseEmailEntries(cur.emailsRaw);

  for (const uid of remove) {
    if (cur.rows.some((r) => r.uid === uid && r.source !== 'config')) {
      // 供給元 (コード / Vercel env) は書き換えられないので、除外リストで止める。
      rejected.push({ uid, reason: '組み込み / env は除外リストで止める (画面の「外す」がそうする)' });
      continue;
    }
    /*
     * **メール登録から来た uid は uid 側だけ外しても戻ってくる。**
     * 次のサインインで `linkDemoEmail` が同じ uid を書き直すため、
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
   * **もう片方の名簿 (Real/Special) も読む** (PR-B)。
   * 既に Real 側で `diagnostic_user_id` が確定している人を Demo へ足すときは、
   * **その uid をそのまま写す** — 1 人につき uid は 1 つという絶対条件。
   * **ここで新しい uid を発行はしない** (デモ枠は従来どおりサインイン時に決まる)。
   */
  const specialEmails = specialEmailEntries();

  for (const raw of addEmail) {
    const addr = String((raw as { email?: unknown })?.email ?? raw ?? '').trim().toLowerCase();
    const label = String((raw as { label?: unknown })?.label ?? '').replace(/[\r\n#]/g, ' ').trim().slice(0, 80);
    // 形だけ見る。**実在確認はしない** (できないし、間違っていても実害は「デモが出ない」だけ)。
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
      rejected.push({ uid: addr, reason: 'メールアドレスの形式が違う' });
      continue;
    }
    const h = await hashEmail(addr);
    const at = emails.findIndex((e) => e.hash === h);
    const decided = canonicalUidForRegistration({
      side: 'demo',
      ownUid: (at >= 0 ? emails[at].uid : '') || null,
      otherUid: specialEmails.find((e) => e.hash === h)?.uid || null,
    });
    /*
     * **両方の名簿に違う uid が在ったら何も保存せず 409。**
     * どちらが本物かを機械が決めてよい場面ではない (人が判断する)。
     * **同じ uid が両方に在るのは正常な Dual** なのでここには来ない。
     */
    if (!decided.ok) {
      return json({
        ok: false, error: 'uid_conflict',
        detail: 'Demo 側と Real 側で uid が食い違っています。統合は自動で行いません。',
        rejected,
      }, 409);
    }
    // `null` = まだ決めない (従来どおりサインイン時に `linkDemoEmail` が埋める)。
    const uid = decided.uid ?? '';
    if (at >= 0) emails[at] = { ...emails[at], uid: emails[at].uid || uid, label: label || emails[at].label };
    else emails.push({ hash: h, masked: maskEmail(addr), uid, label });
    /*
     * **uid が決まっているなら資格一覧にも足す** (Special 側の「両方へ書く」と同じ)。
     * 片方だけだと `isDemoAccount(uid)` が立たず、画面上は登録済みなのに
     * **デモが出ない**状態になる。`updates` は下で 1 回の `setConfig` にまとめる。
     */
    if (uid && !entries.some((e) => e.uid === uid)) {
      entries.push({ uid, label: label || maskEmail(addr) });
    }
  }
  for (const key of removeEmail) {
    // 画面からは hash を渡す (現物のアドレスを往復させない)。
    const at = emails.findIndex((e) => e.hash === key);
    if (at < 0) { rejected.push({ uid: key, reason: '登録されていない' }); continue; }
    /*
     * **サインイン済みなら uid 側も一緒に外す。**
     * メールを外しただけでは uid が残り、本人にはデモが出続ける
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
   *
   * 組み込み / env は供給元を書き換えられない (コード / Vercel env なので)。
   * **引き算を 1 段足す**ことで、どの行でも画面から外せるようにする。
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

  /*
   * ── 表示モード (§4.2.3・発注者指示 2026-10-22) ──────────────────────
   *
   * **資格 → 表示 の順を admin 画面でも守る。** デモの資格が無い uid を
   * デモ表示に指定しても `resolveViewMode()` は無視するので、
   * **ここで却下して理由を返す** — 黙って受けると
   * 「指定したのにデモが出ない」を admin が追えなくなる。
   *
   * `cur.rows` は組み込み / env / app_config の**和から除外を引いた**結果
   * (`listDemoAccounts()`)。`denied` を引いた後の姿で見るのが要点。
   */
  const display = parseEntries(cur.displayRaw);
  for (const uid of displayDemo) {
    if (!isUuid(uid)) { rejected.push({ uid, reason: 'uid の形式が違う' }); continue; }
    const row = cur.rows.find((r) => r.uid === uid);
    if (!row || row.denied) {
      rejected.push({ uid, reason: 'デモの資格が無い (先にデモ用アカウントとして登録する)' });
      continue;
    }
    if (!display.some((e) => e.uid === uid)) display.push({ uid, label: row.label ?? '' });
  }
  for (const uid of displayReal) {
    const at = display.findIndex((e) => e.uid === uid);
    // **既定へ戻すだけ**なので、名簿に無い uid は却下しない (冪等にする)。
    if (at >= 0) display.splice(at, 1);
  }

  // 保存形式は **1 行 1 件 + `#` 注釈**。人が読める形で残す (admin が直接編集しても壊れない)。
  const ser = (list: { uid: string; label: string }[]) =>
    list.map((e) => (e.label ? `${e.uid}  # ${e.label}` : e.uid)).join('\n');
  const value = ser(entries);
  const deniedValue = ser(denied);
  const emailValue = serializeEmailEntries(emails);

  /*
   * **中身が変わらないなら保存しない。**
   * 全件が却下されたリクエスト (形式違い / 組み込みを外そうとした 等) でも書きに行くと、
   * 保存の失敗が返って**却下理由が見えなくなる**。理由が伝わらないと admin は原因を追えない。
   */
  const updates: Record<string, string> = {};
  if (value !== cur.configRaw) updates[KEY] = value;
  if (emailValue !== cur.emailsRaw) updates[EMAIL_KEY] = emailValue;
  if (deniedValue !== cur.deniedRaw) updates[DENY_KEY] = deniedValue;
  const displayValue = ser(display);
  if (displayValue !== cur.displayRaw) updates[DISPLAY_KEY] = displayValue;
  /*
   * **初回登録の目印。** これが入っていると管理者リストからの自動登録は二度と走らない。
   * 走り続けると、admin 画面から外した人が次のアクセスで黙って戻ってしまう。
   */
  if (markSeeded && !cur.seededFromAdmins) updates[SEEDED_KEY] = new Date().toISOString();
  if (Object.keys(updates).length > 0) {
    const updatedBy = typeof body.updated_by === 'string' ? body.updated_by : undefined;
    const r = await setConfig(updates, updatedBy);
    if (!r.ok) return json({ ok: false, error: 'save_failed', detail: r, rejected }, 400);
  }

  return json({ ok: true, ...(await snapshot()), rejected });
};
