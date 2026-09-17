#!/usr/bin/env node
/**
 * 受領 JSON → PDF の生成経路の検査。
 *
 * **守りたいのは 2 つ。**
 *   ① **本番に出ない。** `?render=` はサーバのローカルファイルを読む口なので、
 *      本番ビルドで生きていると `REPORT_RENDER_DIR` 次第で任意のディレクトリを
 *      紙面に流し込めてしまう。`import.meta.env.DEV` の内側から出さない。
 *   ② **個人情報をリポジトリに残さない。** 入力 (実在の方の氏名・健康情報) も
 *      出力 (PDF) も repo の外を強制する。
 * どちらも**静かに壊れる** (壊れても画面は正常に見える) ので機械で見張る。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fails = [];
const ok = (label, cond, why) => {
  if (!cond) fails.push(`${label}${why ? ` — ${why}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
};
const read = (p) => readFileSync(resolve(p), 'utf8');
/** **注意書きに当たらないよう、コメントを外してから見る** (何度か自分の説明文で落ちた)。 */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const page = code('src/pages/report.astro');
const lib = code('src/lib/report-local-render.ts');
const script = code('scripts/render-report-pdf.mjs');

console.log('\n① 本番に出さない\n');
{
  ok('`?render=` は DEV の内側だけ',
    /const localInput = import\.meta\.env\.DEV\s*\?\s*loadLocalRenderInput\(/.test(page),
    'ここを外すと本番でサーバのファイルを読む口になる');
  ok('入力ディレクトリは env でしか指せない (既定値を持たない)',
    /process\.env\.REPORT_RENDER_DIR/.test(lib) && !/REPORT_RENDER_DIR\s*(\|\||\?\?)/.test(lib));
  ok('env が無ければ何も読まない', /if \(!dir\) return null;/.test(lib));
  ok('id はディレクトリ名として安全な形だけ',
    /ID_RE\s*=\s*\/\^\[A-Za-z0-9_-\]\{1,64\}\$\//.test(lib) && /ID_RE\.test\(id\)/.test(lib),
    '`..` や `/` を通すと親ディレクトリを読める');
}

console.log('\n② 個人情報を repo に残さない\n');
{
  ok('入力・出力とも repo の外を強制する',
    /p === REPO \|\| p\.startsWith\(REPO \+ '\/'\)/.test(script) && /process\.exit\(2\)/.test(script));
  ok('入力ディレクトリの既定値を持たない',
    /if \(!DIR\)/.test(script) && !/REPORT_RENDER_DIR\s*\?\?/.test(script));
}

console.log('\n③ 紙面を取り違えない\n');
{
  ok('閲覧者側の検査を持ち込まない',
    /const cancerArtifact = localInput != null\s*\?\s*null/.test(page),
    '渡された JSON が全て。別人のがんリスク検査への導線が出る');
  ok('中身が空の PDF を黙って作らない',
    /text < 2000 \|\| r\.cards === 0/.test(script) && /process\.exit\(1\)/.test(script));
  ok('背景のグラフィックを出す',
    /printBackground: true/.test(script), '無いと帯・バッジ・表の teal ヘッダが白く抜ける');
  ok('紙面は既存のレンダラを使う (別に組まない)',
    /\/report\?render=\$\{encodeURIComponent\(id\)\}&print=1/.test(script));
}

console.log(fails.length
  ? `\n✗ ${fails.length} 件\n - ` + fails.join('\n - ')
  : '\n✓ 本番には出ない。入力も出力も repo の外。紙面は本番と同じレンダラ。');
process.exit(fails.length ? 1 : 0);
