/**
 * コードが書く値が DB の CHECK 制約に載っているかを機械で見る。サーバも鍵も要らない。
 *
 * 【なぜ要るか — 2026-09-27 の実障害】
 *   `persistAdminBatchHc()` は admin バッチの読み取り結果を `source='admin_batch'` で
 *   `diagnosis.test_artifacts` へ insert していたが、CHECK は
 *   `source in ('user_upload','wellfort_lab')` のままだった。
 *   → **insert が毎回 23514 で失敗**し、admin バッチで処理した検査は
 *     本人のダッシュボードに 1 行も入らなかった。
 *   しかも失敗は応答の `dashboard.reason` にしか出ず、admin 画面がその欄を
 *   描いていなかったので**画面上は成功に見えていた**。
 *
 *   同じ形の事故は「あとから enum 値を増やしたがマイグレーションを足し忘れた」
 *   ときに何度でも起きる。**書いた値が入るかどうかは動かすまで分からない**ので、
 *   静的に突き合わせる。
 *
 * 【何を見るか】
 *   ① supabase/migrations/*.sql を**ファイル名順に**読み、
 *      `diagnosis.<table>` の列ごとの CHECK 許可集合を作る (後勝ち = 前進マイグレーション反映)。
 *   ② src/ の `.from('<table>')` の近傍から、対象列へのリテラル代入
 *      (`source: 'admin_batch'`) と、対象列でのリテラル絞り込み
 *      (`.eq('source', 'admin_batch')`) を拾う。
 *   ③ ②が①の集合に無ければ落とす。
 *
 *   **絞り込み (`.eq`) も見る**のが要点。許可集合に無い値で絞ると
 *   「1 件もヒットしない delete/select」になり、**エラーも出ないまま黙って空振り**する
 *   (実際 persistAdminBatchHc の冪等削除がこれだった)。
 *
 * 【見ないもの】動的な値 (変数・テンプレートリテラル)。静的に決まらないものは対象外で、
 *   そこは実行時の責任 (捏造した判定をしない = ここで当て推量しない)。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const MIG = join(ROOT, 'supabase', 'migrations');
const SRC = join(ROOT, 'src');

/** 突き合わせる列。ここに無い列は対象外 (増やすときはここへ足す)。 */
const WATCHED = {
  test_artifacts: ['source', 'test_type', 'status', 'display_mode', 'sex'],
  measurement_values: ['test_type', 'flag'],
  test_artifact_files: ['file_kind'],
  scan_jobs: ['status'],
};

let pass = 0;
const fails = [];
function ok(msg) { pass++; console.log(`  ✓ ${msg}`); }
function fail(msg) { fails.push(msg); console.log(`  ✗ ${msg}`); }

// ── ① マイグレーションから CHECK 許可集合を作る ──────────────────
function stripSqlComments(s) {
  return s.replace(/--[^\n]*/g, '');
}

/** key = `${table}.${column}` → Set<string> */
const allowed = new Map();

for (const f of readdirSync(MIG).filter((n) => n.endsWith('.sql')).sort()) {
  const text = stripSqlComments(readFileSync(join(MIG, f), 'utf8'));
  // 文単位に割る (CHECK は 1 文の中に閉じている)。
  for (const stmt of text.split(';')) {
    const m = /(?:create\s+table|alter\s+table)\s+(?:if\s+not\s+exists\s+)?diagnosis\.(\w+)/i.exec(stmt);
    if (!m) continue;
    const table = m[1];
    // check (col in (...))  /  check (col is null or col in (...))
    const re = /check\s*\(\s*(?:\w+\s+is\s+null\s+or\s+)?(\w+)\s+in\s*\(([^)]*)\)/gi;
    let c;
    while ((c = re.exec(stmt)) !== null) {
      const col = c[1];
      const vals = [...c[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
      if (vals.length === 0) continue;
      allowed.set(`${table}.${col}`, new Set(vals)); // 後勝ち
    }
  }
}

console.log('① マイグレーションから読んだ CHECK 許可集合');
for (const [table, cols] of Object.entries(WATCHED)) {
  for (const col of cols) {
    const set = allowed.get(`${table}.${col}`);
    if (!set) { fail(`${table}.${col} の CHECK を 1 つも読めなかった (列名の変更か、正規表現の取りこぼし)`); continue; }
    ok(`${table}.${col} = { ${[...set].join(', ')} }`);
  }
}

// ── ② src から「書いた値」「絞った値」を拾う ─────────────────────
function stripTsComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|astro)$/.test(n)) out.push(p);
  }
  return out;
}

/**
 * `.from('x')` から**そのクエリチェーンの終わりまで**を切り出す。
 * 近傍 N 文字で切ると隣の無関係なコード (応答の `status: 'success'` 等) を拾って
 * 誤検出するので、括弧の深さを数えて「深さ 0 の `;`」か「次の `.from(`」で止める。
 */
function chainSlice(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth < 0) return text.slice(start, i); // 呼び出し側の括弧を抜けた
    } else if (ch === ';' && depth === 0) return text.slice(start, i);
    else if (depth === 0 && text.startsWith('.from(', i) && i > start) return text.slice(start, i);
  }
  return text.slice(start);
}

const uses = []; // { file, table, col, value, how }
for (const file of walk(SRC)) {
  const text = stripTsComments(readFileSync(file, 'utf8'));
  for (const table of Object.keys(WATCHED)) {
    const fromRe = new RegExp(`\\.from\\(\\s*['"\`]${table}['"\`]\\s*\\)`, 'g');
    let f;
    while ((f = fromRe.exec(text)) !== null) {
      const win = chainSlice(text, f.index);
      for (const col of WATCHED[table]) {
        // 代入: `source: 'admin_batch'`
        const assign = new RegExp(`\\b${col}\\s*:\\s*'([^']*)'`, 'g');
        let a;
        while ((a = assign.exec(win)) !== null) uses.push({ file, table, col, value: a[1], how: '代入' });
        // 絞り込み: `.eq('source', 'admin_batch')`
        const eq = new RegExp(`\\.(?:eq|neq)\\(\\s*'${col}'\\s*,\\s*'([^']*)'\\s*\\)`, 'g');
        let e;
        while ((e = eq.exec(win)) !== null) uses.push({ file, table, col, value: e[1], how: '絞り込み' });
        // 絞り込み (複数): `.in('status', ['active','superseded'])`
        const inRe = new RegExp(`\\.in\\(\\s*'${col}'\\s*,\\s*\\[([^\\]]*)\\]\\s*\\)`, 'g');
        let i2;
        while ((i2 = inRe.exec(win)) !== null) {
          for (const v of [...i2[1].matchAll(/'([^']*)'/g)]) uses.push({ file, table, col, value: v[1], how: '絞り込み' });
        }
      }
    }
  }
}

console.log('\n② src が使っている値');
const seen = new Set();
let checked = 0;
for (const u of uses) {
  const sig = `${u.table}.${u.col}=${u.value}:${u.how}`;
  if (seen.has(sig)) continue;
  seen.add(sig);
  const set = allowed.get(`${u.table}.${u.col}`);
  if (!set) continue; // ① で既に落としている
  checked++;
  const where = `${relative(ROOT, u.file)}`;
  if (set.has(u.value)) ok(`${u.table}.${u.col} ${u.how} '${u.value}' (${where})`);
  else fail(`${u.table}.${u.col} ${u.how} '${u.value}' は CHECK に無い → ${u.how === '代入' ? 'insert/update が 23514 で失敗する' : '1 件もヒットしない (黙って空振り)'} (${where})`);
}
if (checked === 0) fail('src から対象列のリテラルを 1 つも拾えなかった (検出そのものが壊れている)');

// ── ③ 検出の取りこぼしを見える形にする ──────────────────────────
//   チェーンを跨ぐ書き方 (`function table(){ return sb...from('scan_jobs') }` のように
//   `.from()` を helper に切り出す形) だと、この静的解析は値を拾えない。
//   **拾えていないことを黙らせない**。ただし「その列にリテラルを書いていない」場合も
//   同じ見え方になるので、不合格にはせず一覧で出す。
console.log('\n③ 静的に拾えた列 / 拾えなかった列');
const covered = new Set(uses.map((u) => `${u.table}.${u.col}`));
for (const [table, cols] of Object.entries(WATCHED)) {
  for (const col of cols) {
    const key = `${table}.${col}`;
    console.log(`  ${covered.has(key) ? '●' : '○'} ${key}${covered.has(key) ? '' : ' — リテラル未検出 (helper 経由か、そもそも書いていない)'}`);
  }
}

// **この検査が存在する理由そのもの**なので、ここだけは未検出を不合格にする。
// (2026-09-27: persistAdminBatchHc の source='admin_batch' が CHECK に無く全件失敗した)
if (covered.has('test_artifacts.source')) ok('test_artifacts.source のリテラルを検出できている (この検査の主目的)');
else fail('test_artifacts.source のリテラルを 1 つも検出できていない — 検出器が壊れている可能性が高い');

// ── 結果 ────────────────────────────────────────────────────────
console.log(`\n${fails.length === 0 ? '✅' : '❌'} verify:db-enums — 合格 ${pass} / 不合格 ${fails.length}`);
if (fails.length) {
  console.log('\n落ちた項目:');
  for (const m of fails) console.log(`  - ${m}`);
  process.exit(1);
}
