/**
 * 外部検査ID 読み取りの手順書を書き出す。
 *
 *   npm run dump:external-id-prompt            … 書き出す
 *   npm run dump:external-id-prompt -- --check … 一致を見るだけ（CI 用・書かない）
 *
 * 中身の組み立ては `scripts/lib/external-id-prompt-doc.mjs`。
 * **`verify:external-id-capture` も同じ関数を呼ぶ**ので、生成の規則が 2 つに割れない。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDoc, DOC_PATH } from './lib/external-id-prompt-doc.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const abs = resolve(ROOT, DOC_PATH);
const next = await buildDoc();

if (process.argv.includes('--check')) {
  let cur = null;
  try {
    cur = readFileSync(abs, 'utf8');
  } catch {
    cur = null;
  }
  if (cur === next) {
    console.log(`✓ ${DOC_PATH} は最新です`);
  } else {
    console.error(`✗ ${DOC_PATH} が古いか存在しません。`);
    console.error('  npm run dump:external-id-prompt で書き出し直してください。');
    process.exit(1);
  }
} else {
  writeFileSync(abs, next);
  console.log(`書き出しました: ${DOC_PATH} (${next.length} 文字)`);
}
