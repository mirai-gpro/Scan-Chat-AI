/**
 * AI問診 — 音声の発話を選択肢へ当てる規則の検査 (2026-09-18・実障害)。
 *
 * 【なぜ要るか】ここは**取り違えると誤った回答が医療問診に記録される**。
 * 実機で 2 件出た:
 *   ① 選択肢に「なし」があるのに、音声「なし」が**回答にならなかった**
 *      (照合が部分一致だけで、「なし」と「ない」が別物だった)
 *   ② 喫煙の設問で音声「ない」が **「過去に吸っていたが現在は吸わない」** として
 *      採用され得た (部分一致の最長優先)。`when` 分岐にも直結する
 *
 * **選択肢は問診票の実物から取る** (作り話のラベルで通しても意味がない)。
 * サーバ不要・ブラウザ不要。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tmp = `${process.env.TMPDIR ?? '/tmp'}/_voice-answer.mjs`;
const build = spawnSync('npx', ['esbuild', 'src/scripts/chat/voice-answer.ts', '--bundle',
  '--platform=node', '--format=esm', '--log-level=error', `--outfile=${tmp}`], { encoding: 'utf8' });
if (build.status !== 0) { console.error(build.stderr || build.stdout); process.exit(1); }
const { pickVoiceOption } = await import(tmp);

const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/** 問診票の実物からラベルを引く (作り話のラベルで検査しない)。 */
const script = readFileSync('src/scripts/chat/interview-script.ts', 'utf8');
const hasLabel = (l) => script.includes(`label: '${l}'`);
const opts = (...labels) => {
  for (const l of labels) {
    if (!hasLabel(l)) { ok(`(前提) 「${l}」が問診票に実在する`, false, '問診票が変わった'); }
  }
  return labels.map((label) => ({ label }));
};

console.log('\n① 「なし」と言ったら「なし」になる (実障害①)\n');
{
  const o = opts('なし', 'ある');
  for (const said of ['なし', 'ない', '特にない', '特になし', 'とくにないです', 'なしです', '特にないよ', '無い']) {
    ok(`「${said}」→ なし`, pickVoiceOption(o, said, false) === 'なし',
      String(pickVoiceOption(o, said, false)));
  }
  ok('「ある」→ ある', pickVoiceOption(o, 'ある', false) === 'ある');
}

console.log('\n② 否定の選択肢のラベルが「ない」でも同じ (表記ゆれ)\n');
{
  const o = opts('ない', 'ある');
  for (const said of ['なし', 'ない', '特にない', 'ありません']) {
    ok(`「${said}」→ ない`, pickVoiceOption(o, said, false) === 'ない',
      String(pickVoiceOption(o, said, false)));
  }
}

console.log('\n③ 「該当するものはない」も否定として扱う\n');
{
  const o = opts('該当するものはない', '高血圧', '1型糖尿病');
  ok('「なし」→ 該当するものはない',
    pickVoiceOption(o, 'なし', false) === '該当するものはない');
  ok('複数選択でも配列で返る',
    JSON.stringify(pickVoiceOption(o, '特にない', true)) === '["該当するものはない"]',
    JSON.stringify(pickVoiceOption(o, '特にない', true)));
}

console.log('\n④ **誤って採らない** — ここが本丸 (実障害②)\n');
{
  // 実物の喫煙設問。否定の選択肢が無い = 「ない」だけでは決められない
  const o = opts('現在吸っている', '過去に吸っていたが現在は吸わない', '吸ったことはない');
  for (const said of ['ない', 'なし', '特にない']) {
    const got = pickVoiceOption(o, said, false);
    ok(`「${said}」は採用しない (長いラベルへ吸わせない)`, got === null, String(got));
  }
  ok('「吸ったことはない」と言えば、その選択肢になる',
    pickVoiceOption(o, '吸ったことはない', false) === '吸ったことはない');
  ok('「現在吸っている」もそのまま',
    pickVoiceOption(o, '現在吸っている', false) === '現在吸っている');
}
{
  /*
   * 否定の選択肢が 2 つ以上あるとき。**完全一致は勝たせる** (「なし」と言って
   * 「なし」が在るなら、それが利用者の指したもの)。決めないのは完全一致が無いときだけ。
   */
  const o = [{ label: 'なし' }, { label: 'ない' }];
  ok('完全一致があればそれを採る', pickVoiceOption(o, 'なし', false) === 'なし',
    String(pickVoiceOption(o, 'なし', false)));
  ok('完全一致が無く否定が複数なら採用しない',
    pickVoiceOption(o, 'ありません', false) === null,
    String(pickVoiceOption(o, 'ありません', false)));
}

console.log('\n⑤ 従来どおり当たるものが壊れていない\n');
{
  const o = opts('ほとんどしない', '週1〜2日', '週3〜4日', 'ほぼ毎日（週5日以上）');
  ok('「週3〜4日」→ 週3〜4日', pickVoiceOption(o, '週3〜4日', false) === '週3〜4日');
  ok('「ほとんどしない」→ ほとんどしない',
    pickVoiceOption(o, 'ほとんどしない', false) === 'ほとんどしない');
  /*
   * 「しない」は否定の言い方 (NEGATIVE) に**入れていない**ので③の部分一致へ落ちる。
   * 「ほとんどしない」だけが含むので 1 件に決まる。
   */
  ok('「しない」→ ほとんどしない (部分一致で 1 件)',
    pickVoiceOption(o, 'しない', false) === 'ほとんどしない',
    String(pickVoiceOption(o, 'しない', false)));
  ok('空の発話は採用しない', pickVoiceOption(o, '   ', false) === null);
  ok('選択肢が無ければ採用しない', pickVoiceOption([], 'なし', false) === null);
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
