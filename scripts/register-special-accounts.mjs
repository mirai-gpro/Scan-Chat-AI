#!/usr/bin/env node
/**
 * スペシャルアカウントを**まとめて登録する**運用スクリプト。
 *
 * 正本: `docs/operations/スペシャルアカウント_仕様書.md` §4.1 / §4.1.1
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【これは何か】admin 画面で 1 件ずつ押す代わりに、宛先リストから
 * `POST /api/admin/special-accounts` を**1 リクエスト**で叩く。
 * 10 名を手で入れると取り違えが起きるので、リストをファイルで渡す。
 *
 * 画面 (`/admin/special-accounts`) と**同じ API・同じ経路**を使う。
 * このスクリプト専用の口は作っていない (処理を 2 つ持たない)。
 * ══════════════════════════════════════════════════════════════════════
 *
 * 【越えない線】
 *   - **鍵は env からしか読まない。** 引数で受けない・保存しない・出力しない。
 *   - **メールアドレスの現物をファイルにも標準出力にも残さない** (既定はマスク)。
 *     サーバ側が保存するのも sha256 + マスクだけ (仕様書 §9)。
 *   - **既定は dry-run。** `--apply` を付けない限り 1 バイトも書かない。
 *   - **氏名・会社名は扱わない。** メモ (label) に個人名を入れないこと。
 *
 * 【使い方】
 *   # 1. まず何が起きるかだけ見る (書かない)
 *   ADMIN_API_KEY=... node scripts/register-special-accounts.mjs --file list.tsv
 *
 *   # 2. 納得したら実行する
 *   ADMIN_API_KEY=... node scripts/register-special-accounts.mjs --file list.tsv --apply
 *
 * 【リストの書式】1 行 1 件・TAB 区切り。2 列目以降は任意。
 *   メールアドレス <TAB> メモ <TAB> 生年月日(YYYY-MM-DD) <TAB> 性別(male|female)
 *
 *   例:
 *     # トランスコスモス 2026-10
 *     a@example.co.jp	トランスコスモス 2026-10	1970-05-15	male
 *     b@example.co.jp	トランスコスモス 2026-10
 *     c@example.co.jp
 *
 *   TAB が無い行は**全体をメールアドレス**として扱う。`#` 始まりと空行は無視。
 *
 * 【オプション】
 *   --file <path>   宛先リスト (必須)
 *   --apply         実際に登録する (既定は dry-run)
 *   --base <url>    既定 https://scan-chat-ai.vercel.app (env SCAN_BASE_URL でも可)
 *   --label <memo>  リストにメモが無い行へ一括で付ける既定メモ
 *   --show-emails   出力のマスクを外す (画面共有・ログ取りのときは付けない)
 *   --updated-by    app_config の更新者メモ (既定 'bulk-register')
 *
 * 【冪等】同じリストで何度流しても **uid は変わらない** (サーバ側の契約)。
 * 途中で失敗したらそのまま再実行してよい。
 *
 * 【採番に失敗したとき】サーバが `503 uid_generation_failed` を返す回は
 * **何も保存されていない** (`setConfig` に到達しない)。再実行で解消する。
 */

import { readFileSync } from 'node:fs';

/* ── 引数 ──────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

const FILE = opt('--file', '');
const APPLY = flag('--apply');
const SHOW = flag('--show-emails');
const BASE = String(opt('--base', process.env.SCAN_BASE_URL || 'https://scan-chat-ai.vercel.app')).replace(/\/+$/, '');
const DEFAULT_LABEL = opt('--label', '');
const UPDATED_BY = opt('--updated-by', 'bulk-register');

const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };

if (!FILE) {
  die('--file <path> が要ります。書式はこのファイルの冒頭コメントを見てください。');
}

/*
 * **鍵は env からだけ。** 引数で受けると `ps` と shell の履歴に残る。
 * wellfort-site 側の名前 (`SCAN_CHAT_AI_API_KEY`) も受けるが、値は同じもの。
 */
const KEY = process.env.ADMIN_API_KEY || process.env.SCAN_CHAT_AI_API_KEY || '';
if (!KEY) {
  die('ADMIN_API_KEY が env にありません。\n'
    + '  ADMIN_API_KEY=... node scripts/register-special-accounts.mjs --file list.tsv\n'
    + '  ※ 引数では受け取りません (ps と shell 履歴に残るため)。');
}

/* ── サーバと同じ照合キー (demo-accounts.ts hashEmail と同一実装) ──
 *
 * 応答はマスクしか返さないので、マスクで突き合わせると
 * **同一ドメイン・同じ頭文字・同じ長さの人が衝突する**
 * (`maskEmail` は 頭 1 文字 + `*` + ドメイン)。ハッシュで突き合わせれば一意。 */
const hashEmail = async (email) => {
  const norm = String(email ?? '').trim().toLowerCase();
  if (!norm) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** 出力用。既定はマスク (ターミナルの記録にも現物を残さない)。 */
const maskEmail = (email) => {
  const norm = String(email ?? '').trim().toLowerCase();
  const at = norm.lastIndexOf('@');
  if (at <= 0) return '***';
  const user = norm.slice(0, at);
  return `${user.slice(0, 1)}${'*'.repeat(Math.max(2, user.length - 1))}@${norm.slice(at + 1)}`;
};
const show = (email) => (SHOW ? email : maskEmail(email));

/* ── リストを読む ──────────────────────────────────────────────── */
// サーバ側 (`special-accounts.ts` の POST) と同じ形だけ通す。
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isRealDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

let raw;
try {
  raw = readFileSync(FILE, 'utf8');
} catch (e) {
  die(`リストを読めません: ${FILE}\n  ${e instanceof Error ? e.message : e}`);
}

const entries = [];
const bad = [];
const seen = new Map();
raw.split(/\r?\n/).forEach((line, i) => {
  const no = i + 1;
  const t = line.trim();
  if (!t || t.startsWith('#')) return;
  const [rawEmail, rawLabel = '', rawDob = '', rawSex = ''] = line.split('\t');
  const email = String(rawEmail ?? '').trim().toLowerCase();
  const label = String(rawLabel ?? '').trim() || DEFAULT_LABEL;
  const dob = String(rawDob ?? '').trim();
  const sex = String(rawSex ?? '').trim().toLowerCase();

  if (!EMAIL_RE.test(email)) { bad.push(`${no} 行: メールアドレスの形式が違う (${show(email)})`); return; }
  // サーバは `#` と改行を空白へ潰すので、こちらで気づけるようにする。
  if (/[#\r\n]/.test(label)) { bad.push(`${no} 行: メモに # や改行は使えない`); return; }
  if (label.length > 80) { bad.push(`${no} 行: メモが 80 字を超えている (${label.length} 字)`); return; }
  if (dob && !isRealDate(dob)) { bad.push(`${no} 行: 生年月日が実在する暦日でない (${dob})`); return; }
  if (sex && sex !== 'male' && sex !== 'female') { bad.push(`${no} 行: 性別は male / female のどちらか (${sex})`); return; }
  /*
   * **同じメールが 2 行あったら止める。** サーバは後の行で上書きするので
   * 「どちらのメモ・生年月日が入ったか」が運用側から見えなくなる。
   * 意図が分からない入力は通さない。
   */
  if (seen.has(email)) { bad.push(`${no} 行: ${seen.get(email)} 行と同じメールアドレス (${show(email)})`); return; }
  seen.set(email, no);

  const e = { email, label };
  if (dob) e.dob = dob;
  if (sex) e.sex = sex;
  entries.push(e);
});

if (bad.length) {
  console.error(`\n✗ リストに通せない行が ${bad.length} 件あります。1 件も送っていません。`);
  for (const b of bad) console.error(`  - ${b}`);
  console.error('\n  直してから再実行してください。');
  process.exit(1);
}
if (!entries.length) die(`登録する行が 1 件もありません: ${FILE}`);

/* ── API ───────────────────────────────────────────────────────── */
const call = async (method, body) => {
  const res = await fetch(`${BASE}/api/admin/special-accounts`, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 本文が JSON でない (502 等) */ }
  return { status: res.status, json, text };
};

const byHash = (list) => new Map((list ?? []).map((e) => [e.hash, e]));

console.log(`\nスペシャルアカウント 一括登録  (${APPLY ? '⚠ 実行' : 'dry-run'})`);
console.log(`  宛先: ${BASE}/api/admin/special-accounts`);
console.log(`  リスト: ${FILE}  (${entries.length} 件)`);
if (!SHOW) console.log('  ※ メールアドレスはマスクして表示します (--show-emails で解除)');

/* ── 1. 現状を引く (何が新規で、何が既存かを先に見せる) ───────── */
const before = await call('GET');
if (before.status !== 200 || !before.json?.ok) {
  die(`一覧を引けませんでした (HTTP ${before.status})。`
    + `${before.json?.error ? ` error=${before.json.error}` : ''}\n`
    + '  401 なら ADMIN_API_KEY が違います。鍵は Vercel の環境変数が正です。');
}
const beforeByHash = byHash(before.json.emails);
const beforeUids = new Set((before.json.rows ?? []).map((r) => r.uid));

const plan = [];
for (const e of entries) {
  const h = await hashEmail(e.email);
  const cur = beforeByHash.get(h);
  const kind = !cur ? '新規 (uid を発行)'
    : cur.uid ? '既存 (uid は維持)'
      : 'legacy (uid 空 → ここで発行)';
  plan.push({ ...e, hash: h, kind, curUid: cur?.uid ?? '' });
}

console.log('\n── これから行うこと ──');
for (const p of plan) {
  console.log(`  ${show(p.email).padEnd(SHOW ? 34 : 28)}  ${p.kind}`
    + `${p.curUid ? `  ${p.curUid}` : ''}`
    + `${p.dob ? '  [DOB あり]' : ''}`);
}
const nNew = plan.filter((p) => p.kind.startsWith('新規')).length;
const nKeep = plan.filter((p) => p.kind.startsWith('既存')).length;
const nLegacy = plan.filter((p) => p.kind.startsWith('legacy')).length;
console.log(`\n  新規 ${nNew} / 既存で uid 維持 ${nKeep} / legacy で発行 ${nLegacy}`);
console.log(`  登録済み合計: ${before.json.emails?.length ?? 0} 件 → ${(before.json.emails?.length ?? 0) + nNew} 件 の見込み`);

if (!APPLY) {
  console.log('\n— dry-run なので何も書いていません。実行するなら --apply を付けてください。\n');
  process.exit(0);
}

/* ── 2. 1 リクエストで登録する ─────────────────────────────────
 *
 * **1 回の POST にまとめる。** サーバは `special.account_emails` と
 * `special.account_uids` を**同じリクエストの 1 回の `setConfig`** で書くので、
 * 分割すると「片方だけ書かれた」状態を自分で作りに行くことになる。 */
console.log('\n── 登録しています ──');
const res = await call('POST', {
  add_email: entries,
  updated_by: UPDATED_BY,
});

if (res.status === 503 && res.json?.error === 'uid_generation_failed') {
  die('uid の採番に失敗しました (HTTP 503 uid_generation_failed)。\n'
    + '  **何も保存されていません** (サーバは setConfig に到達しません)。\n'
    + '  そのまま再実行してください。繰り返すなら要調査です。');
}
if (res.status !== 200 || !res.json?.ok) {
  die(`登録に失敗しました (HTTP ${res.status})。`
    + `${res.json?.error ? ` error=${res.json.error}` : ''}\n`
    + `  ${res.text.slice(0, 300)}`);
}
for (const r of res.json.rejected ?? []) {
  console.log(`  ! 却下: ${r.uid} — ${r.reason}`);
}

/* ── 3. 読み戻して確かめる ─────────────────────────────────────
 *
 * 応答を信じるだけでは足りない。**uid が発行され、かつ資格一覧にも
 * 載っていること**を GET で確かめる。メール行にだけ uid が入って
 * `special.account_uids` に漏れていても、画面上は uid が出るので
 * **発行できたように見える**が、実際には資格が立たない (仕様書 §4.1.1)。 */
const after = await call('GET');
if (after.status !== 200 || !after.json?.ok) {
  die(`登録は返ってきましたが、読み戻しに失敗しました (HTTP ${after.status})。\n`
    + '  /admin/special-accounts で目視確認してください。');
}
const afterByHash = byHash(after.json.emails);
const afterUids = new Set((after.json.rows ?? []).map((r) => r.uid));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

console.log('\n── 結果 (この uid に検査データを入れます) ──');
const ng = [];
for (const p of plan) {
  const row = afterByHash.get(p.hash);
  const uid = row?.uid ?? '';
  const okUuid = UUID_RE.test(uid);
  const okQual = okUuid && afterUids.has(uid);
  const okKeep = !p.curUid || p.curUid === uid; // 既存 uid を作り直していないこと
  const mark = okUuid && okQual && okKeep ? '✓' : '✗';
  console.log(`  ${mark} ${show(p.email).padEnd(SHOW ? 34 : 28)}  ${uid || '(uid 無し)'}`
    + `${row?.has_dob ? '  [DOB あり]' : ''}`);
  if (!okUuid) ng.push(`${show(p.email)}: uid が発行されていない`);
  else if (!okQual) ng.push(`${show(p.email)}: uid が special.account_uids に無い (資格が立たない)`);
  else if (!okKeep) ng.push(`${show(p.email)}: uid が作り直された (${p.curUid} → ${uid})`);
}

console.log(`\n  登録済み合計: ${after.json.emails?.length ?? 0} 件 / 資格 uid: ${afterUids.size} 件`);
console.log(`  (登録前: メール ${before.json.emails?.length ?? 0} 件 / 資格 uid ${beforeUids.size} 件)`);

if (ng.length) {
  console.error(`\n✗ ${ng.length} 件が期待どおりになっていません。`);
  for (const n of ng) console.error(`  - ${n}`);
  console.error('\n  /admin/special-accounts で状態を確認してください。');
  process.exit(1);
}

console.log('\n✓ 全件が発行済みで資格も立っています。');
console.log('  反映は最大 45 秒 (app_config の TTL)。再デプロイは不要です。');
console.log('  次の作業: /admin/special-additional-tests で過去の検査票を登録。');
console.log('  ※ 本人の Sign up / Sign in では、新しい uid は作られず上の uid へ紐付きます。\n');
