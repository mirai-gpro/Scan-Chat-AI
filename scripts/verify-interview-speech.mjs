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

/*
 * ④ **進行の判断を LLM に渡さない** (2026-09-18・実障害)。
 *
 * 実機で、問診の途中に音声で答えたら AI が
 * 「回答ありがとうございます。これで問診は完了です。お疲れさまでした…」と喋った。
 * **engine は完了していない** (画面は次の質問を出して続いた) = **モデルの自発発話**。
 *
 * 原因はプロンプトの穴: 旧【問診完了時】は「お疲れさまでした…と一言お礼」としか書いておらず、
 * **いつが完了かの判断をモデルに委ねていた**。絶対ルール A も「**質問**を発話しない」しか
 * 禁じていない。音声回答のターンはプログラムが何も送らない (二重話者を避けるため) ので、
 * モデルが自分の判断で喋る余地がそのまま残っていた。
 *
 * 完了判断はプログラムの責務 (`CLAUDE.md`「LLM に問診順を決めさせない」)。
 * **手元で Live API を叩けないので、プロンプトに禁止が書いてあることを機械で固定する。**
 */
console.log('\n④ 進行の判断を LLM に渡していない\n');
{
  /*
   * **プロンプト本文だけを見る。** ファイル全体を見ると、コードのコメント
   * (「黙って無視しない」等) に反応して落ちる = 誤検知 (実測 2026-09-18)。
   * 見張りたいのは**モデルに渡る文字列**だけ。
   */
  const whole = read('src/scripts/chat/live-controller.ts');
  const at = whole.indexOf('const SYSTEM_INSTRUCTION = `');
  const prompt = at < 0 ? '' : whole.slice(at, whole.indexOf('`;', at));
  ok('SYSTEM_INSTRUCTION を切り出せた', prompt.length > 200, `${prompt.length} 字`);
  ok('発話するのは依頼文の内容だけ、と書いてある',
    /発話するのは、こちらから届いた依頼文が指示する内容だけ/.test(prompt));
  /*
   * **「黙って待て」と書かない** (発注者指摘 2026-09-18)。音声回答でも
   * `live-controller.ts` は**必ず次の質問の読み上げを依頼する** (音声・タップで同一)。
   * 正しい姿は沈黙ではなく「次の質問を読む」。沈黙を指示すると、ユーザーは
   * 声で答えたのに何も返らない状態に置かれる。
   */
  ok('音声で答えたら次の質問が届く、と書いてある',
    /ユーザーが声で答えたときも、こちらから次の質問の依頼が届く/.test(prompt));
  ok('進行状況を自分で判断しないと書いてある',
    /問診の進み具合を自分で判断しない/.test(prompt));
  /*
   * **ト書きを書かない** (2026-09-18・実機で発生)。
   * 「…こちらから依頼が届くまで**黙って待つ**」と書いたら、モデルがそれを台本と読んで
   * **「（黙って待つ）」と読み上げた**。沈黙は「行動の描写」で伝えず、
   * **「何を言ってよいか」の形**で書く (上の E)。
   */
  const stage = /黙って|無言|沈黙|何も言わ|返事をしない/.exec(prompt);
  ok('プロンプトにト書き (行動の描写) を書いていない', stage === null,
    stage ? `「${stage[0]}」が残っている — モデルが読み上げる` : '');
  ok('「完了」を自称しないと書いてある',
    /これで完了です/.test(prompt) && /進行状況・残り問数に触れる発話を絶対にしない/.test(prompt));
  ok('完了のお礼は依頼が届いたときだけ、と条件付きになっている',
    /「これで全問終了です」という依頼がこちらから届いたときだけ/.test(prompt),
    '条件を外すとモデルが勝手に完了を告げる (実障害 2026-09-18)');
  ok('お礼・相づちも禁じている',
    /確認の聞き返し・お礼・相づち・状況説明もしない/.test(prompt),
    '実機で「回答ありがとうございます」が出た (2026-09-18)');
}

/*
 * **読み上げに「／」を使わない** (実機報告 2026-09-23)。
 * 「飲酒する／していた際の」の "／" は読み上げで**何と言っているか聞き取れない**。
 * 画面と納品 JSON も同じ文言なので、`question` ごと「、又は、」にそろえた。
 * (`speech` で音声だけ変える手もあるが、画面でも "／" は読みにくいので両方)
 */
{
  const script = read('src/scripts/chat/interview-script.ts');
  const hits = (script.match(/／/g) ?? []).length;
  ok('設問に「／」を使っていない', hits === 0,
    `${hits} 箇所 — 読み上げで何と言っているか聞き取れない`);
}

console.log(fails.length
  ? `\n✗ ${fails.length} 件\n - ` + fails.join('\n - ')
  : '\n✓ 音声だけが変わる。表示と納品 JSON は動いていない。');
process.exit(fails.length ? 1 : 0);
