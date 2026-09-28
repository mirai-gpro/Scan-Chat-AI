/**
 * 出来上がった報告書 PDF の束が **いまの紙面で作られているか** を機械で見る。
 *
 * 【なぜ要るか — 2026-09-27/28 の実害】
 *   トランスコスモス 10 名の PDF が 3 回届き、3 回とも「最新版か」を人が判別できなかった。
 *   実際に届いたもの:
 *     ・zip 名 `…_20260925.zip` / フォルダ名「再修正版」なのに
 *       **中の PDF は 2026-09-18 07:24 UTC 生成** (PDF の CreationDate で判明)
 *     ・2026-09-18 の撤去 (`06822cf`) は入っていたが
 *       **2026-09-25 の修正 (`fd5e112`) が入っていなかった**
 *   ファイル名も「修正版」「再修正版」も**中身を保証しない**。紙面そのものを見るしかない。
 *
 * 【何を見るか】紙面に必ず出る「版の指紋」3 つと、撤去済みのはずの文言。
 *   ① 検査値の表の列が **項目名 / 値 / 検査日** (fd5e112 で `検査日` が付いた)
 *   ② 章扉が **「AI 疾病予防アドバイス」** (fd5e112 で「AI 診断による〜」から改めた)
 *   ③ 出典行に **生成過程の scaffolding が無い** (`（要約）` `§1〜§N` `冒頭 2 文`)
 *   ④ 06822cf で撤去した文言が無い (`今回の所見` `すぐ受診` プレースホルダ `—`)
 *   ⑤ 表紙に**中身の無いラベル**が無い (`作成日` の後ろが空)
 *
 * 【文脈が要る語は落とさず WARN にする】`判定` `基準値` `要注意` は
 *   **Elith の地の文に普通に出る** (「AST：基準値 13〜30 U/L」「前述の通り」)。
 *   当社が列見出しに使っているかどうかは語の有無では決まらないので、
 *   **列見出しとしての出現だけを FAIL** にし、地の文の出現は件数と前後を出すに留める。
 *   (verify-report-verbatim で踏んだのと同じ罠 — 語が在ることと、
 *    その語を当社が見出しに使ってよいことは別。)
 *
 * ■ 使い方 (要 poppler-utils)
 *     node scripts/verify-report-batch.mjs <PDFのフォルダ or zip>
 *
 * ■ PII
 *   **報告書には氏名が印字されている。** 展開先は repo の外に置くこと
 *   (引数に repo 内を渡したら中止する)。氏名は出力に出さない (ファイル名だけ)。
 */
import { execSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';

const target = process.argv[2];
if (!target) {
  console.error('使い方: node scripts/verify-report-batch.mjs <PDFのフォルダ or zip>');
  process.exit(2);
}
for (const bin of ['pdftotext', 'pdfinfo']) {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); } catch {
    console.error(`✗ ${bin} が見つかりません (poppler-utils)。`);
    console.error('  apt-get install -y poppler-utils  /  brew install poppler');
    process.exit(2);
  }
}

const REPO = resolve('.');
const abs = resolve(target);
if (!existsSync(abs)) { console.error(`見つかりません: ${abs}`); process.exit(2); }
if (abs === REPO || abs.startsWith(REPO + '/')) {
  console.error(`リポジトリの中を指しています: ${abs}`);
  console.error('報告書には氏名が印字されているので、repo の外に置いてください。');
  process.exit(2);
}

// ── PDF を集める (zip はテンポラリへ展開) ───────────────────────
let pdfs = [];
if (extname(abs).toLowerCase() === '.zip') {
  const work = mkdtempSync(join(tmpdir(), 'report-batch-'));
  execFileSync('python3', ['-c', `
import zipfile,os,sys
z=zipfile.ZipFile(sys.argv[1]); out=sys.argv[2]
for n in z.namelist():
    i=z.getinfo(n)
    raw = n.encode('utf-8') if (i.flag_bits & 0x800) else n.encode('cp437')
    try: name=raw.decode('utf-8')
    except UnicodeDecodeError: name=raw.decode('cp932','replace')
    if name.endswith('/') or not name.lower().endswith('.pdf'): continue
    with open(os.path.join(out, os.path.basename(name)),'wb') as f: f.write(z.read(n))
`, abs, work]);
  pdfs = readdirSync(work).map((f) => join(work, f));
  console.log(`zip を展開: ${pdfs.length} 件\n`);
} else if (statSync(abs).isDirectory()) {
  pdfs = readdirSync(abs).filter((f) => f.toLowerCase().endsWith('.pdf')).map((f) => join(abs, f));
} else {
  pdfs = [abs];
}
pdfs.sort();
if (!pdfs.length) { console.error('PDF がありません。'); process.exit(1); }

// ── 検査 ────────────────────────────────────────────────────────
/** 列見出しの行だけを取り出す (地の文と区別するため「項目名」で始まる行に限る)。 */
function headerRows(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('項目名'));
}

const results = [];
for (const p of pdfs) {
  const name = basename(p);
  const text = execFileSync('pdftotext', ['-layout', p, '-'], { encoding: 'utf-8', maxBuffer: 64 << 20 });
  const info = execFileSync('pdfinfo', [p], { encoding: 'utf-8' });
  const created = (/CreationDate:\s*(.+)/.exec(info) || [])[1]?.trim() ?? '(不明)';
  const pages = (/Pages:\s*(\d+)/.exec(info) || [])[1] ?? '?';

  const fails = [];
  const warns = [];

  // ① 表の列
  const heads = headerRows(text);
  if (heads.length === 0) warns.push('検査値の表が見つからない (この回に検査値が無い?)');
  else {
    const withDate = heads.filter((h) => h.includes('検査日')).length;
    if (withDate !== heads.length) fails.push(`表の列に「検査日」が無い (${heads.length - withDate}/${heads.length} 個) → fd5e112 より前の紙面`);
    for (const h of heads) {
      if (h.includes('基準値')) fails.push('表の列に「基準値」がある → 06822cf より前の紙面');
      if (h.includes('判定')) fails.push('表の列に「判定」がある → 06822cf より前の紙面');
    }
  }

  // ② 章扉
  if (/AI\s*診断による疾病予防アドバイス/.test(text)) fails.push('章扉が「AI 診断による疾病予防アドバイス」 → fd5e112 より前の紙面');
  else if (!/AI\s*疾病予防アドバイス/.test(text)) warns.push('章扉「AI 疾病予防アドバイス」が見つからない');

  // ③ 出典行の scaffolding
  for (const [re, label] of [
    [/（要約）/, '出典行に「（要約）」'],
    [/§\s*\d+\s*〜\s*§\s*\d+/, '出典行に「§1〜§N」'],
    [/冒頭\s*2\s*文/, '出典行に「冒頭 2 文」'],
    [/各節の【/, '出典行に「(各節の…)」'],
  ]) if (re.test(text)) fails.push(`${label} → fd5e112 より前の紙面`);

  // ④ 撤去済みのはずの文言
  for (const [re, label] of [
    [/今回の所見/, '「今回の所見」'],
    [/すぐ受診/, '「すぐ受診」(救急カード)'],
    [/—/, 'プレースホルダ「—」'],
  ]) if (re.test(text)) fails.push(`${label} が残っている → 06822cf より前の紙面`);

  // ⑤ 表紙の空ラベル
  if (/作成日\s*$/m.test(text)) fails.push('表紙の「作成日」の後ろが空 (中身の無い欄)');

  // 文脈が要る語 — 落とさず件数と前後を出す
  for (const w of ['判定', '基準値', '要注意']) {
    const n = (text.match(new RegExp(w, 'g')) || []).length;
    if (n) {
      const ctx = (text.match(new RegExp(`.{0,18}${w}.{0,18}`)) || [''])[0].replace(/\s+/g, ' ');
      warns.push(`「${w}」${n} 件 — 地の文か要確認: …${ctx}…`);
    }
  }

  results.push({ name, pages, created, fails, warns });
}

// ── 出力 ────────────────────────────────────────────────────────
let ng = 0;
for (const r of results) {
  const mark = r.fails.length ? '✗' : '✓';
  if (r.fails.length) ng++;
  console.log(`${mark} ${r.name}`);
  console.log(`    ${r.pages} ページ / 生成 ${r.created}`);
  for (const f of r.fails) console.log(`    ✗ ${f}`);
  for (const w of r.warns) console.log(`    · ${w}`);
  console.log('');
}

const dates = [...new Set(results.map((r) => r.created))];
if (dates.length > 1) {
  console.log(`⚠ 生成時刻が ${dates.length} 通りあります — 一部だけ作り直した可能性:`);
  for (const d of dates) console.log(`    ${d}`);
  console.log('');
}

console.log(`${ng === 0 ? '✅' : '❌'} verify:report-batch — ${results.length} 件中 ${results.length - ng} 件が現行の紙面 / ${ng} 件が古い`);
if (ng) process.exit(1);
