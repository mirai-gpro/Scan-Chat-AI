#!/usr/bin/env node
/**
 * AI問診の「読み上げ文」の検査。
 *
 * **守りたいのは 2 つ。**
 *   ① **音声だけを変える。** 単位を読ませるための言い換え (`speech`) は音声専用で、
 *      画面と **Elith 納品 JSON は `question` のまま**
 *      (`interview-export.ts` が `question: q?.question` を納品物に入れる)。
 *      表示のために納品物の文字列を動かさない。
 *   ② **読み上げ依頼は必ず `speechOf()` を通る。** 1 箇所でも `${q.question}` の
 *      直書きが残ると、そこだけ「シーエム」に戻る (実機報告 2026-09-17)。
 *
 * どちらも**静かに壊れる** — 画面も納品 JSON も正常に見えるので、音声を聞くまで気づけない。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fails = [];
const ok = (label, cond, why) => {
  if (!cond) fails.push(`${label}${why ? ` — ${why}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
};
const read = (p) => readFileSync(resolve(p), 'utf8');
/** **注意書きに当たらないよう、コメントを外してから見る。** */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const script = code('src/scripts/chat/interview-script.ts');
const ctrl = code('src/scripts/chat/live-controller.ts');

console.log('\n① 音声だけを変える (表示・納品は不変)\n');
{
  ok('表示は `（cm）` のまま', /question: '身長を教えてください。（cm）'/.test(script),
    '納品 JSON にも入る文字列なので動かさない');
  ok('表示は `（kg・数字のみ）` のまま', /question: '体重を教えてください。（kg・数字のみ）'/.test(script));
  ok('読み上げは「センチ」', /speech: '身長を教えてください。（センチ）'/.test(script));
  ok('読み上げは「キログラム」', /speech: '体重を教えてください。（キログラム・数字のみ）'/.test(script));
  ok('`speech` は任意 (付けない設問はそのまま読む)', /speech\?: string;/.test(script));
}

console.log('\n② 読み上げ依頼は必ず speechOf を通る\n');
{
  ok('speechOf が在る', /function speechOf\(q: QuestionDef\): string \{\s*return q\.speech \?\? q\.question;/.test(ctrl));
  /*
   * **読み上げを頼んでいる行だけを見る。** 完了時の
   * 「ユーザーが最後の質問「…」に回答し」は**文脈**で、同じ文に
   * 「質問は絶対に発話しないでください」と書いてあるので対象外。
   */
  const asks = ctrl.split('\n').filter((l) => /読み上げ/.test(l) && /\$\{/.test(l));
  ok('読み上げを頼む行が 4 箇所ある', asks.length === 4, `${asks.length} 箇所`);
  const raw = asks.filter((l) => /\$\{[^}]*\.question\}/.test(l));
  ok('`${….question}` の直書きが残っていない', raw.length === 0, raw.join(' / '));
  ok('全部 speechOf を通っている', asks.every((l) => /speechOf\(/.test(l)), asks.filter((l) => !/speechOf\(/.test(l)).join(' / '));
}

console.log('\n③ 旧プロンプトの残骸を残さない\n');
{
  ok('`_OBSOLETE_SYSTEM_INSTRUCTION` を消してある',
    !/_OBSOLETE_SYSTEM_INSTRUCTION/.test(ctrl),
    '未使用でも残すと「復唱しろ」と読めて、矛盾していると誤読される');
  ok('生きているプロンプトは復唱を禁じている',
    /ユーザーの回答を復唱しない/.test(read('src/scripts/chat/live-controller.ts')),
    '2026-09-04 確定: AI は質問だけを読み上げる');
}

console.log(fails.length
  ? `\n✗ ${fails.length} 件\n - ` + fails.join('\n - ')
  : '\n✓ 音声だけが変わる。表示と納品 JSON は動いていない。');
process.exit(fails.length ? 1 : 0);
