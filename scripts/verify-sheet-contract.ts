/**
 * `npm run verify:sheet-contract`
 *
 * **モックの再現性チェック。** `docs/elith/mock/*.html` から紙面契約を抽出し、
 * 同じ受領 JSON を実装 (`buildReportVM`) に通した結果と突き合わせる。
 * 食い違えば**紙面の言葉で**差分を出して落とす。
 *
 * 正本: docs/elith/AI疾病予防報告書_仕様書.md  ※ § 番号は旧版 docs/旧版・ボツ/ai_prevention_report_generation_spec.md §1.3.10
 *
 * 【使い方 (紙面を変えるとき)】
 *   1. モック HTML を直す (発注者に見せる版は Artifact へ再公開)
 *   2. `npm run verify:sheet-contract -- --write` で契約 JSON を再生成しコミット
 *      → **PR の差分に「紙面がどう変わるか」が出る**
 *   3. 実装を直して `npm run verify:sheet-contract` が通るまで持っていく
 *   **契約 JSON を手で書き換えて通すのは禁止。** 必ずモックから再生成する。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import REPORT_TEXT from '../src/data/elith/report_text_20260826.json';
import HEALTH_CHECKUP from '../src/data/elith/health_checkup_20260826.json';
import { buildReportVM } from '../src/lib/report-adapter';
import { contractFromMockHtml, contractFromVM, diffContract } from './sheet-contract';

const WRITE = process.argv.includes('--write');
// **バンドル後の場所に依存しない**。esbuild の出力は node_modules/.cache に置くので、
// `import.meta.dirname` からの相対で辿るとリポジトリの外を指す (実測)。
// npm scripts は必ずリポジトリのルートで走るので `process.cwd()` が正しい起点。
const root = process.cwd();

const MOCK = resolve(root, 'docs/elith/mock/ai_prevention_report_type2.html');
const SNAPSHOT = resolve(root, 'docs/elith/mock/sheet_contract_type2.json');

// タイプ 1 の紙面契約も**モックから抽出して記録する**。
// 実装は JSON 受領後 (v0.2) なので照合はまだ行わないが、**目標を機械可読な形で固定**しておく。
// ここを口頭やドキュメントの散文で持つと、また実装が別のものになる。
const MOCK1 = resolve(root, 'docs/elith/mock/ai_prevention_report_type1.html');
const SNAPSHOT1 = resolve(root, 'docs/elith/mock/sheet_contract_type1.json');

const mock = contractFromMockHtml(readFileSync(MOCK, 'utf-8'));
const mock1 = contractFromMockHtml(readFileSync(MOCK1, 'utf-8'));

if (WRITE) {
  writeFileSync(SNAPSHOT, `${JSON.stringify(mock, null, 2)}\n`, 'utf-8');
  writeFileSync(SNAPSHOT1, `${JSON.stringify(mock1, null, 2)}\n`, 'utf-8');
  console.log(`契約 JSON を再生成: ${SNAPSHOT} / ${SNAPSHOT1}`);
}

// 契約 JSON は「モックから抽出したもの」であり、レビューで紙面の変化を読むためにコミットする。
// ここでズレたら **モックを直したのに再生成していない**。
const snapshot = readFileSync(SNAPSHOT, 'utf-8');
const fresh = `${JSON.stringify(mock, null, 2)}\n`;
const snapshot1 = readFileSync(SNAPSHOT1, 'utf-8');
const fresh1 = `${JSON.stringify(mock1, null, 2)}\n`;
const stale = snapshot !== fresh || snapshot1 !== fresh1;

const vm = buildReportVM({
  reportText: REPORT_TEXT,
  checkup: HEALTH_CHECKUP as unknown as Record<string, { date?: string; value?: unknown }[]>,
  name: '相川 佳之 様',
  issuedOn: '2026-08-28',
  isSample: true,
  hasCancerRisk: false,
  cycleSeq: null,
  chronologicalAge: 56,
  readConfig: () => '',
});

const impl = contractFromVM(vm);
const diffs = diffContract(mock, impl);

/*
 * **タイプが反転したことを検出する (2026-08-30 追加)。**
 *
 * 【なぜ要るか】この検証は `hasCancerRisk: false` を**決め打ち**しており、
 * タイプ2 の紙面しか通していなかった。ところが本番の admin では、デモが貸した
 * 真鍋の `cancer_urine` artifact を拾って `hasCancerRisk: true` になり、
 * **タイプ1 (未実装) に反転して A 軸のカードが消えていた** (実測 2026-08-30)。
 * 検証は全部緑なのに紙面が違う、という状態がここで見逃されていた。
 *
 * → 同じ素材を `hasCancerRisk: true` でも組み、**A 軸のカードが消えること**を
 *   「タイプ1 は未実装」という**既知の事実として固定**する。
 *   将来 A が出るようになったら、ここが落ちて「タイプ1 の契約を作れ」と教える。
 *
 * 【2026-09-17】①タイプ2 側は「A のカードが 1 枚以上」を決め打ちしていたが、
 * パイロット暫定文 (当社が書いた 2 文) の削除で **材料が無い回は 0 枚**になった。
 * 決め打ちを**モックの枚数との一致**に替える — こうすると「当社の文を紙面へ戻した」
 * ときにも、「Elith の所見が黙って消えた」ときにも、どちらでも落ちる。
 * ②**軸 A そのものを廃止した**ので `axis === 'a'` では引けない (引くと常に 0 = 検査が
 * 空振りする)。**カードの key `cancer_finding`** で引く。見ている中身は同じ。
 */
const vmAsCourse = buildReportVM({
  reportText: REPORT_TEXT,
  checkup: HEALTH_CHECKUP as unknown as Record<string, { date?: string; value?: unknown }[]>,
  name: '相川 佳之 様',
  issuedOn: '2026-08-28',
  isSample: true,
  hasCancerRisk: true,
  cycleSeq: null,
  chronologicalAge: 56,
  readConfig: () => '',
});
const IS_FINDING = (c: { key: string }) => c.key === 'cancer_finding';
const aInType2 = vm.digest.filter(IS_FINDING).length;
const aInType1 = vmAsCourse.digest.filter(IS_FINDING).length;
const aInMock = mock.cards.filter(IS_FINDING).length;
const typeFlip: string[] = [];
if (aInType2 !== aInMock) {
  typeFlip.push(
    `タイプ2 の「今回の所見」が 実装 ${aInType2} 枚 / モック ${aInMock} 枚 で食い違う。`
    + '紙面の正はモックなので、どちらが古いかを突き合わせて直すこと。',
  );
}
if (aInType1 !== 0) {
  typeFlip.push(
    `タイプ1 で「今回の所見」が ${aInType1} 枚出た。未実装のはずなので、`
    + 'タイプ1 の紙面契約 (sheet_contract_type1.json) を作って照合対象に加えること。',
  );
}
console.log(`タイプ判定: 「今回の所見」= タイプ2 ${aInType2} 枚 (モック ${aInMock} 枚) / タイプ1 ${aInType1} 枚 (タイプ1 は未実装のため 0 が正)`);

console.log(`タイプ2: モック ${mock.cards.length} カード / 実装 ${impl.cards.length} カード`);
// タイプ 1 は実装が無い (JSON 未受領・v0.2)。契約だけを記録し、照合はしない。
console.log(`タイプ1: モック ${mock1.cards.length} カード / 実装 なし (JSON 未受領・照合は v0.2 から)`);

if (stale) {
  console.log('\n✗ 契約 JSON がモックと食い違っています。`npm run verify:sheet-contract -- --write` で再生成してコミットしてください。');
}

if (diffs.length) {
  console.log(`\n✗ モックと実装の差分 ${diffs.length} 件:\n`);
  for (const d of diffs) {
    console.log(`  ● ${d.where}`);
    console.log(`      モック: ${d.mock}`);
    console.log(`      実装  : ${d.impl}`);
  }
  console.log('\n差分は「モックが正」か「モックが古い」かのどちらかです。');
  console.log('どちらであれ **両方を突き合わせて直す** こと。片方だけ直して通すのは契約の放棄です。');
}

if (typeFlip.length) {
  console.log(`\n✗ 報告書タイプの前提が崩れています (${typeFlip.length} 件):\n`);
  for (const t of typeFlip) console.log(`  ● ${t}`);
}

if (diffs.length || stale || typeFlip.length) process.exit(1);
console.log('\n✓ モックの紙面を実装が再現しています。');
