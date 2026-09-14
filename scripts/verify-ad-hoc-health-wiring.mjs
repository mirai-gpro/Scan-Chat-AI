#!/usr/bin/env node
// scripts/verify-ad-hoc-health-wiring.mjs
// 臨時診断バッチ: 健診 PDF → production HealthCheckup 処理の結線を固定する。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §6.2 / §6.4 / §6.5 / §16
//
// **サーバも DB も S3 も Gemini も要らない。**
//
// ここで固定するのは 5 つ。いずれも**静かに壊れる**か、**壊れたことが納品後にしか分からない**。
//   ① finalize は共通 core 1 つ … 本番と ad-hoc で整形が分岐していない
//   ② ad-hoc 独自の健診 JSON builder を作っていない (§18)
//   ③ 解析段階で S3 へ書かない … Human Review 前に実書き込みが起きない (§6.5)
//   ④ 健診 XLSX を HealthCheckupData の生成元にしていない (§6.2)
//   ⑤ today / 推定日付を入れない (§6.4)
//
//   node scripts/verify-ad-hoc-health-wiring.mjs
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

let pass = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name, actual, expected) =>
  ok(name, Object.is(actual, expected), `期待 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const coreSrc = read('src/lib/elith-hc-finalize.ts');
const mergeSrc = read('src/pages/api/admin/elith-hc-merge.ts');
const serviceSrc = read('src/lib/ad-hoc-diagnosis/service.ts');
const processSrc = read('src/pages/api/admin/ad-hoc-diagnosis/process.ts');
const exportSrc = read('src/lib/elith-export.ts');

// ===========================================================================
// ① finalize core が 1 つであること (§6.5)
// ===========================================================================
ok('通常の hc-merge が core を呼ぶ', /finalizeHealthCheckup\(/.test(mergeSrc));
ok('ad-hoc も同じ core を呼ぶ', /finalizeHealthCheckup\(/.test(serviceSrc));
ok('ad-hoc が core を elith-hc-finalize から import している',
  /from '\.\.\/elith-hc-finalize'/.test(serviceSrc));
ok('ad-hoc が production の scanImageToParsed を使う',
  /import \{ scanImageToParsed \} from '\.\.\/elith-export'/.test(serviceSrc));

/*
 * hc-merge に整形が残っていない = core へ移り切っている。
 *
 * **import 行を落としてから見る。** 落とさないと「import されている」だけで通り、
 * **整形を pipeline から外しても検出できない** (実際にそうなっていた)。
 * 見るのは `symbol(` という**呼び出しの形**。
 */
const callsOnly = (src) => strip(src).replace(/^import[\s\S]*?from\s+'[^']+';$/gm, '');
const coreCalls = callsOnly(coreSrc);
const mergeCalls = callsOnly(mergeSrc);
for (const sym of ['sanitizeMeasurementsForDelivery', 'canonicalize', 'dedupObservations', 'detectScramble', 'reassignScramble', 'resolveEyeCollapsed', 'fixLipidSwap', 'checkNecessity']) {
  ok(`hc-merge に整形が残っていない: ${sym}`, !mergeCalls.includes(`${sym}(`));
  ok(`core が整形を実際に呼んでいる: ${sym}`, coreCalls.includes(`${sym}(`),
    'import されているだけでは通さない');
}
// 整形の順序も固定する (§6.2 の「既存 finalize」と同じ並び)。入れ替わると結果が変わる。
const order = ['sanitizeMeasurementsForDelivery(', 'canonicalize(', 'dedupObservations(', 'detectScramble(', 'reassignScramble(', 'resolveEyeCollapsed(', 'fixLipidSwap('];
const positions = order.map((sym) => coreCalls.indexOf(sym));
ok('整形の順序が本番と同じ', positions.every((v, i) => v > 0 && (i === 0 || v > positions[i - 1])),
  JSON.stringify(positions));
// scramble 検知は **再割当より前** (後ろだと偽陽性が出る)。
ok('scramble 検知は再割当の前', coreCalls.indexOf('detectScramble(') < coreCalls.indexOf('reassignScramble('));
// 納品 key の組み立ても 1 か所。
ok('hc-merge は core の folder 関数を使う', /const folderOf = healthCheckupFolder/.test(mergeSrc));
ok('hc-merge に key のベタ書きが残っていない',
  !/HealthCheckupData_date_\$\{dateFolder\}/.test(strip(mergeSrc)));

// ===========================================================================
// ② ad-hoc 独自の健診 JSON builder を作っていない (§18)
// ===========================================================================
ok('ad-hoc service が buildHealthCheckupJson を呼ばない',
  !strip(serviceSrc).includes('buildHealthCheckupJson'));
ok('ad-hoc service が健診 XLSX の復元を呼ばない',
  !strip(serviceSrc).includes('restoreHealthCheckupSheet'));
/*
 * **見るのは「納品 JSON を手で組んでいないか」**。
 * `format_id:` という語だけを禁止すると、**DB の状態行 (`upsertOutput`) まで落ちる**
 * (実際に落ちた)。納品 JSON を手で組んだときにしか出ない `schema_version` を見る。
 */
ok('ad-hoc service が納品 JSON を手で組んでいない',
  !/schema_version/.test(strip(serviceSrc)),
  '納品 JSON の組み立ては pipeline / core 側だけに置く');

// ===========================================================================
// ③ 解析段階で S3 へ書かない (§6.5) — **ここが本丸**
// ===========================================================================
// core は I/O を持たない。
ok('core が s3 を import していない', !/from '\.\/s3'/.test(coreSrc));
ok('core に PutObject / putFiles が無い', !/putFiles|PutObjectCommand|putOriginal/.test(coreSrc));
ok('core に fetch が無い', !/\bfetch\(/.test(strip(coreSrc)));
// scanImageToParsed も書かない (型 import だけなら可)。
const exportWrites = strip(exportSrc).match(/\bputFiles\s*\(|\bputOriginal\s*\(/g) ?? [];
eq('scanImageToParsed 側に S3 書き込み呼び出しが無い', exportWrites.length, 0);
// ad-hoc の解析経路に書き込みが無い。
ok('service.ts に putFiles が無い', !/\bputFiles\s*\(/.test(strip(serviceSrc)));
ok('service.ts に PutObjectCommand が無い', !/PutObjectCommand/.test(strip(serviceSrc)));
ok('process.ts に S3 書き込みが無い', !/putFiles|PutObjectCommand|putOriginal/.test(strip(processSrc)));
// **通常の hc-merge API を ad-hoc から呼んでいない** (あちらは part で元画像を S3 へ置く)。
ok('ad-hoc が elith-hc-merge API を呼んでいない',
  !/elith-hc-merge/.test(strip(serviceSrc)) && !/elith-hc-merge/.test(strip(processSrc)));
// 実書き込みは write-guard 経由の export だけ。
const guardSrc = read('src/lib/ad-hoc-diagnosis/write-guard.ts');
ok('実書き込みは write-guard にだけ在る', /PutObjectCommand/.test(guardSrc));

// ===========================================================================
// ④ 健診 XLSX を生成元にしていない (§6.2) / ⑤ 日付 (§6.4)
// ===========================================================================
ok('today 由来の日付を捨てている', /dateSource !== 'today'/.test(serviceSrc));
ok('日付が割れたら選ばず管理者確認へ', /test_date_conflict/.test(serviceSrc));
ok('日付が無ければ未解決にする', /test_date_unresolved/.test(serviceSrc));
ok('健診 PDF が未スキャンなら理由を出す', /health_pdf_not_scanned/.test(serviceSrc));
ok('欠けたページを名指しする', /missing_pages:/.test(serviceSrc));

// 生 Markdown を DB にも納品 JSON にも残さない (§2.4 / §16)。
ok('ad-hoc はページ保存時に raw を null にする',
  /status: 'done', parsed: payload, raw: null/.test(serviceSrc));
ok('ad-hoc は納品 JSON に生 Markdown を載せない',
  (serviceSrc.match(/includeRawMarkdown: false/g) ?? []).length >= 2);
ok('core は includeRawMarkdown=false でキーごと出さない',
  /if \(includeRaw\) json\.raw_markdown =/.test(coreSrc));
ok('通常経路の既定は従来どおり raw を載せる',
  /input\.includeRawMarkdown !== false/.test(coreSrc));

// ===========================================================================
// core の実挙動 (依存を落として読み込む)
// ===========================================================================
const tmp = mkdtempSync(join(repoRoot, '.verify-hcfin-'));
try {
  // `isTrendMarkdown` は純粋関数なので、そこだけ取り出して実際に動かす。
  const m = /export function isTrendMarkdown[\s\S]*?\n}/.exec(coreSrc);
  ok('isTrendMarkdown が core に在る', !!m);
  if (m) {
    const js = ts.transpileModule(m[0], {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const out = join(tmp, 'trend.js');
    writeFileSync(out, js);
    const mod = await import(pathToFileURL(out).href);
    eq('推移ページを見分ける', mod.isTrendMarkdown('## 検査結果の推移\n|a|b|'), true);
    eq('通常ページは推移でない', mod.isTrendMarkdown('## 血液検査\n|AST|22|'), false);
    eq('null は推移でない', mod.isTrendMarkdown(null), false);
    eq('undefined は推移でない', mod.isTrendMarkdown(undefined), false);
    eq('空文字は推移でない', mod.isTrendMarkdown(''), false);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ===========================================================================
const total = pass + failures.length;
if (failures.length) {
  console.error(`\n✗ verify:ad-hoc-health-wiring  ${pass}/${total}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ verify:ad-hoc-health-wiring  ${pass}/${total}`);
