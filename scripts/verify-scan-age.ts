/**
 * scan-age.ts (年齢/性別抽出) の検証。CI の A 層 (ブラウザ/DB 不要)。
 * 実行: npm run verify:scan-age
 */
import { extractAge, extractSex } from '../src/lib/scan-age';

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (got === want) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
};

// ── 年齢 ──
eq('54歳', extractAge('… 54歳 男 …'), 54);
eq('満54歳', extractAge('満54歳'), 54);
eq('54 才 (空白)', extractAge('54 才'), 54);
eq('全角 ５４歳', extractAge('５４歳'), 54);
eq('表形式 年齢 | 54', extractAge('| 年齢 | 54 |'), 54);
eq('年齢: 54', extractAge('年齢: 54'), 54);
eq('年齢：54 (全角コロン)', extractAge('年齢：54'), 54);
eq('Age: 54', extractAge('Age: 54'), 54);
eq('54yo', extractAge('54yo male'), 54);
eq('年齢なし = null', extractAge('アルブミン 4.2 g/dL'), null);
eq('範囲外 5歳 = null', extractAge('5歳'), null);
eq('範囲外 200歳 = null', extractAge('200歳'), null);
eq('検査値の数字を年齢にしない', extractAge('AST 54 U/L'), null);

// ── 性別 ──
eq('男性', extractSex('性別 男性'), 'male');
eq('女性', extractSex('女性'), 'female');
eq('54歳男', extractSex('54歳 男'), 'male');
eq('54歳女', extractSex('54歳女'), 'female');
eq('性別: 男', extractSex('性別: 男'), 'male');
eq('性別：女 (全角)', extractSex('性別：女'), 'female');
eq('性別なし = null', extractSex('アルブミン 4.2'), null);
eq('mg/dL の M を性別にしない', extractSex('随時血糖 120 mg/dL'), null);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
