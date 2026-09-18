/**
 * AI問診 — 音声の回答を「選択肢の中から LLM に推論させる」経路の検査
 * (発注者指示 2026-09-18:「極力 LLM に判断させて。パターンマッチング的なことは絶対にやらないで」)。
 *
 * 【何を守るか】
 *  ① **パターンマッチングを復活させない** — 文字の一致・部分一致・同義語表を持たない
 *  ② **LLM が何を返しても、選択肢の外は採用できない** (番号だけ・範囲検査)
 *  ③ **確度が低ければ採らない** — 医療問診なので、誤って採るより聞き直す
 *  ④ **黙って無視しない** — 決められなければ聞き直しを頼む。ただし 1 問 1 回まで
 *  ⑤ **待っている間に設問が変わったら捨てる** — 古い回答を今の設問に入れない
 *
 * 判定そのもの (LLM の当たり外れ) は**手元で測れない** (キーは本番のサーバ側だけ)。
 * ここで固定するのは**構造**で、精度は実機で見る。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// **repo の node_modules の中へ出す** — 外部 package (supabase 等) を
// node が解決できるようにするため (/tmp だと解決できない)。
const tmp = new URL('../node_modules/.cache/verify-voice-choice.mjs', import.meta.url).pathname;
const build = spawnSync('npx', ['esbuild', 'src/lib/voice-choice-llm.ts', '--bundle',
  '--platform=node', '--format=esm', '--log-level=error', '--packages=external',
  `--outfile=${tmp}`], { encoding: 'utf8' });
if (build.status !== 0) { console.error(build.stderr || build.stdout); process.exit(1); }
const { parseChoice, CONFIDENCE_FLOOR } = await import(tmp);

const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const code = (p) => readFileSync(p, 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const ctrl = code('src/scripts/chat/live-controller.ts');

console.log('\n① パターンマッチングを持たない\n');
{
  ok('voice-answer.ts (旧 当てはめ) を残していない',
    !/voice-answer/.test(ctrl), 'pickVoiceOption / 同義語表は撤去済み');
  /*
   * **`interpretVoiceAnswer` の中に選択肢が出てこないこと**を見る。
   * 「optionsOf の近くに === がある」のような緩い見方だと、
   * `typeof data.index === 'number'` を拾って誤検知する (実際に踏んだ)。
   */
  const interp = ctrl.slice(ctrl.indexOf('function interpretVoiceAnswer'));
  const body = interp.slice(0, interp.indexOf('\n  }') + 4);
  ok('interpretVoiceAnswer が選択肢に触っていない',
    !/optionsOf|\.label|includes\(/.test(body),
    '部分一致に戻すと、書いた言い方しか当たらない');
  ok('否定語の一覧を持っていない',
    !/なし|特にない|ありません/.test(ctrl.split('const SYSTEM_INSTRUCTION')[0] ?? ''),
    'コード側に言い方の表を作らない (LLM に判断させる)');
  const llm = code('src/lib/voice-choice-llm.ts');
  ok('画面は判定をサーバへ投げている',
    /\/api\/interview\/classify-voice/.test(ctrl));
  ok('サーバは LLM を呼んでいる',
    /classifyVoiceChoice/.test(llm) && /callGemini/.test(llm));
}

console.log('\n② 選択肢の外は採用できない\n');
{
  ok('範囲外の番号は null', parseChoice('{"index":5,"confidence":1}', 3).index === null);
  ok('負の番号は null', parseChoice('{"index":-1,"confidence":1}', 3).index === null);
  ok('小数は null', parseChoice('{"index":1.5,"confidence":1}', 3).index === null);
  ok('文字列の番号は null', parseChoice('{"index":"1","confidence":1}', 3).index === null);
  ok('壊れた JSON は null', parseChoice('not json', 3).index === null);
  ok('空応答は null', parseChoice('', 3).index === null);
  ok('選択肢名を返されても採用しない (番号しか見ない)',
    parseChoice('{"label":"なし","confidence":1}', 3).index === null);
  ok('正しい番号は通る', parseChoice('{"index":2,"confidence":0.95}', 3).index === 2);
  // 画面側でも範囲を見る (サーバを信用しきらない)
  ok('画面側でも index の範囲を検査している',
    /data\.index >= 0 && data\.index < labels\.length/.test(ctrl));
}

console.log('\n③ 確度が低ければ採らない\n');
{
  ok('閾値が 0.7 以上に置いてある', CONFIDENCE_FLOOR >= 0.7, String(CONFIDENCE_FLOOR));
  const low = CONFIDENCE_FLOOR - 0.01;
  ok(`確度 ${low.toFixed(2)} は採らない`, parseChoice(`{"index":0,"confidence":${low}}`, 3).index === null);
  ok('確度が欠けていたら採らない', parseChoice('{"index":0}', 3).index === null);
  ok('温度 0 で判定している', /temperature: 0/.test(code('src/lib/voice-choice-llm.ts')));
}

console.log('\n④ 決められなければ聞き直す (黙って無視しない)\n');
{
  ok('聞き直しの依頼がある', /function askToRepeat/.test(ctrl));
  ok('文言に「タップ」の案内が入っている', /選択肢をタップしてください/.test(ctrl));
  ok('聞き直しは 1 問 1 回まで',
    /askedRepeat\.has\(q\.id\)[\s\S]{0,80}askedRepeat\.add\(q\.id\)/.test(ctrl),
    'テレビの音を拾い続けても喋り続けない');
  ok('判定できないときに回答を作っていない',
    !/askToRepeat[\s\S]{0,200}submitAnswer/.test(ctrl));
}

console.log('\n⑤ 古い回答を今の設問に入れない\n');
{
  ok('待機中に設問が変わったら捨てる',
    /currentQ\?\.id !== q\.id \|\| advancing/.test(ctrl));
  ok('自由記述・スライダーは LLM へ回さない',
    /function isChoiceQ/.test(ctrl) && /mapKind\(q\.answer_kind\) === 'list'/.test(ctrl));
}

console.log('\n⑥ PII を増やしていない\n');
{
  const api = code('src/pages/api/interview/classify-voice.ts');
  ok('送るのは設問・選択肢・発話だけ',
    !/uid|diagnostic_user_id|name|email/.test(api));
  ok('キーはサーバ側で読む', /GEMINI_API_KEY/.test(api));
  ok('長さの上限を置いている', /MAX_TRANSCRIPT/.test(api) && /MAX_OPTIONS/.test(api));
  ok('失敗しても回答を作らない', /catch[\s\S]{0,120}index: null/.test(api));
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
