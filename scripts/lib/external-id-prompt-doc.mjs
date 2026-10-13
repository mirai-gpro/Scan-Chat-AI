/**
 * 外部検査ID 読み取りの「AI Studio 用手順書」を**コードから組み立てる**。
 *
 * 出力先 = `docs/operations/外部検査ID_読み取り精度テスト手順書.md`。
 *
 * 【なぜ生成にするか】
 * プロンプトとスキーマを手で写した手順書は、**コードを直した瞬間に古くなる**。
 * しかも古いまま配っても見た目は正しいので、誰も気づかない。
 * → **本番のソースから機械的に書き出し**、`verify:external-id-capture` が
 * 「書き出し直したものと一致するか」を見張る（`verify:sheet-contract` と同じ流儀）。
 *
 * 【決定論であること】
 * 日付や乱数を入れない。**同じソースからは必ず同じ文字列**が出る
 * （そうでないと同期チェックが毎回落ちる）。
 *
 * 追加依存なし（`typescript` は既存の devDependency）。
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

/** 生成物の置き場所。**呼び出し側がここを参照する**（パスを 2 か所に書かない）。 */
export const DOC_PATH = 'docs/operations/外部検査ID_読み取り精度テスト手順書.md';

/**
 * TS を transpile して data: URL から import する。
 * 相対 import は解決できないので、`subs` でリテラル宣言へ置き換える
 * （`scripts/verify-external-id-capture.mjs` と同じ手口）。
 */
async function load(relPath, subs = []) {
  const ts = (await import('typescript')).default;
  mkdirSync(resolve(ROOT, 'node_modules/.cache'), { recursive: true });
  let src = read(relPath);
  for (const [re, to] of subs) src = src.replace(re, to ?? '');
  const js = ts.transpileModule(src, { compilerOptions: { target: 'ES2022', module: 'ESNext' } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`);
}

/** `app-config.ts` の既定値をソースから引く（**手順書に定数を直書きしない**）。 */
function configDefault(key) {
  const src = read('src/lib/app-config.ts');
  const i = src.indexOf(`key: '${key}'`);
  if (i < 0) return null;
  return /default: '([^']*)'/.exec(src.slice(i, i + 600))?.[1] ?? null;
}

const fence = (lang, body) => '```' + lang + '\n' + body + '\n```';

export async function buildDoc() {
  const core = await load('src/lib/external-test-id.ts');
  const rd = await load('src/lib/external-id-read.ts', [
    [/^import \{ callGemini[\s\S]*?from '\.\/gemini';$/m,
      'const callGemini = async () => { throw new Error("stub"); }; const MODELS = { scan: "stub" };'],
    [/^import \{ refreshConfig \}[\s\S]*?from '\.\/app-config';$/m, 'const refreshConfig = async () => undefined;'],
    [/^import \{\n?\s*EXTERNAL_ID_PROVIDERS[\s\S]*?from '\.\/external-test-id';$/m,
      `const EXTERNAL_ID_PROVIDERS = ${JSON.stringify([...core.EXTERNAL_ID_PROVIDERS])};`],
  ]);

  /*
   * `READ_SCHEMA` は export していない。**手順書のために本番の export を増やさない**ので、
   * ソースから literal を取り出して評価する（JSON へ落とすのはここだけ）。
   */
  const src = read('src/lib/external-id-read.ts');
  const lit = src.slice(
    src.indexOf('const READ_SCHEMA = {') + 'const READ_SCHEMA = '.length,
    src.indexOf('} as const;') + 1,
  );
  const schema = new Function(`return (${lit})`)();

  const model = configDefault('scan.model');
  const pattern = {
    prevent: configDefault('labid.prevent_pattern'),
    demecal: configDefault('labid.demecal_pattern'),
  };

  /** 後段を**実際に動かして**表を作る（「こうなるはず」を書かない）。 */
  const row = (provider, barcode, ocr, note) => {
    const ev = core.evaluateExternalId({ provider, barcode, ocr, expectedPattern: pattern[provider] });
    const c = (v) => (v === null ? '`null`' : `\`${v}\``);
    return `| ${c(barcode)} | ${c(ocr)} | ${c(ev.value)} | **${ev.status}** | ${ev.reasons.length ? ev.reasons.join(', ') : '—'} | ${note} |`;
  };

  const o = [];
  o.push('# 外部検査ID 読み取り精度テスト手順書（ON 条件 ③）');
  o.push('');
  o.push('> **このファイルは生成物。手で編集しない。**');
  o.push('> `npm run dump:external-id-prompt` で `src/lib/external-id-read.ts` から書き出す。');
  o.push('> `verify:external-id-capture` が「書き出し直したものと一致するか」を見張っているので、');
  o.push('> **プロンプトやスキーマを直したら必ず書き出し直す**（忘れると検査が落ちる）。');
  o.push('');
  o.push('正本 = `docs/lab/kit_receipt_external_id_capture_spec.md` §5 / §6.4 / §12.1。');
  o.push('');
  o.push('## 0. 何を確かめるのか');
  o.push('');
  o.push('`labid.prevent_capture` / `labid.demecal_capture` を本番で on にする条件のうち、');
  o.push('**③ Gemini の読み取り精度**を、アプリを動かさずに実物の写真 1 枚で測る。');
  o.push('');
  o.push('**この手順では本番に一切触らない**（app_config も S3 も DB も変えない）。');
  o.push('');
  o.push('## 1. AI Studio の設定');
  o.push('');
  o.push('| 項目 | 値 | 出どころ |');
  o.push('|---|---|---|');
  o.push(`| Model | **\`${model}\`** | \`scan.model\` のコード既定。**本番は DB 値が勝つ**ので、別の値が入っていればそちらで測る |`);
  o.push('| Temperature | **0** | `external-id-read.ts` の `generationConfig` |');
  o.push('| Thinking | **オフ**（`thinkingBudget: 0`） | 同上 |');
  o.push('| Structured output | **オン**（§4 の JSON Schema） | 同上 |');
  o.push('| Max output tokens | **512** | 同上 |');
  o.push('');
  o.push('画像は**撮った写真そのまま 1 枚**。アプリも加工せず、S3 に置いた画像をそのまま渡している。');
  o.push('');

  const LABEL = {
    prevent: 'プリベント（シール台紙）',
    demecal: 'デメカル（検査申し込み用紙・返送用）',
  };
  let n = 2;
  for (const prov of core.EXTERNAL_ID_PROVIDERS) {
    o.push(`## ${n}. ${LABEL[prov] ?? prov}`);
    o.push('');
    o.push('### System instructions');
    o.push('');
    o.push(fence('text', rd.SYSTEM_BY_PROVIDER[prov]));
    o.push('');
    o.push('### User（画像と一緒に送る 1 行）');
    o.push('');
    o.push(fence('text', rd.USER_BY_PROVIDER[prov]));
    o.push('');
    n += 1;
  }

  o.push(`## ${n}. JSON Schema（両方で共通）`);
  o.push('');
  o.push('**QR のフィールドを作らない**のが仕様上の要点（作ると QR の値が候補に混ざる）。');
  o.push('');
  o.push(fence('json', JSON.stringify(schema, null, 2)));
  o.push('');
  n += 1;

  o.push(`## ${n}. 合格の見方`);
  o.push('');
  o.push('**モデルの出力をそのまま採点しない。** アプリは必ず後段を通す:');
  o.push('');
  o.push('`normalizeExternalId`（全角→半角 / 区切り除去 / **start/stop を 1 文字剥がす**）');
  o.push('→ `passesStructuralGuard`（数字のみ 4〜20 桁）');
  o.push('→ `matchesExpectedPattern`（app_config の `labid.*_pattern`）');
  o.push('→ `evaluateExternalId`（採否）');
  o.push('');
  o.push('下の表は**その後段を実際に動かした結果**。期待値を書いたものではない。');
  o.push('');
  o.push(`期待パターン: プリベント \`${pattern.prevent}\` / デメカル \`${pattern.demecal}\``);
  o.push('');
  o.push('| barcode_value | printed_id_value | 採る値 | 判定 | 理由 | |');
  o.push('|---|---|---|---|---|---|');
  o.push(row('prevent', 'A704000123A', '704000123', '**これが合格形**。start/stop を剥がして一致'));
  o.push(row('prevent', '704000123', '704000123', 'デコーダが start/stop を返さない場合も同じ'));
  o.push(row('prevent', null, '704000123', 'バーコードが読めず印字だけ'));
  o.push(row('prevent', 'A704000123A', null, '印字が読めない'));
  o.push(row('prevent', 'A704000123A', '704000124', '**食い違い**（バーコードを採る）'));
  o.push(row('prevent', '*704000123*', '704000123', 'Code39 で返ると剥がさない'));
  o.push(row('prevent', '704000', '704000', '桁が足りない'));
  o.push(row('demecal', '202500000000000', '202500000000000', '**これが合格形**（15 桁・両方読めた）'));
  o.push(row('demecal', null, '202500000000000', '印字だけ'));
  o.push(row('demecal', '0120100302', null, '**電話番号を読んだ**'));
  o.push('');
  o.push('### 見るべき点（この 4 つ）');
  o.push('');
  o.push('1. **`barcode_value` に `A…A` が返るか。** 返ってよい（剥がすのはこちら側）。');
  o.push('   **英字を落として整えてくれなくてよい** — プロンプトでそう指示している。');
  o.push('2. **`printed_id_value` に ID が返るか。** プリベントの合格は `barcode` と `printed` が');
  o.push('   **両方**揃って一致したとき（`confirmed`）。片方だけなら確認待ちになる。');
  o.push('3. **パスワードが返っていないか。** プリベントの台紙にはログイン用のパスワードが印字されている。');
  o.push('   `barcode_value` / `printed_id_value` / `note` の**どこにも**出てはいけない。');
  o.push('4. **QR の中身（URL）が返っていないか。** スキーマに QR の欄は無いが、他の欄へ紛れていないか見る。');
  o.push('');
  o.push('### 回数');
  o.push('');
  o.push('**同じ 1 枚で 3 回**流す（temperature 0 でも毎回同じとは限らない）。');
  o.push('**3 回とも上の 4 点を満たせば ③ は合格。**');
  o.push('1 回でも外すなら、まず撮り方（影・傾き・寄り）を変えて測り直す。');
  o.push('');
  o.push('### 落ちたとき');
  o.push('');
  o.push('| 症状 | 次の手 |');
  o.push('|---|---|');
  o.push('| バーコードだけ読めない | `@zxing/library` の同梱を再検討（正本 §6.4 の案2）。**iOS Safari に `BarcodeDetector` が無い**ので、クライアント単独の方式には戻さない |');
  o.push('| 印字だけ読めない | 寄って撮る案内を足す |');
  o.push('| **パスワードが返る** | プロンプトの禁止文を強める。**直すまで on にしない** — 証跡画像は S3 に残るので、資格情報が応答と台帳に流れる |');
  o.push('| 毎回ばらつく | `scan.model` を変えて測り直す（`app_config` の enum にある範囲で） |');
  o.push('');
  o.push('## 撮影した写真の扱い');
  o.push('');
  o.push('**この手順で使った写真をリポジトリに入れない。** 実物にはユーザーID と');
  o.push('（プリベントは）パスワードが写っている。外部検査IDは画面でも末尾 4 桁しか出さない値。');
  o.push('');
  return o.join('\n');
}
