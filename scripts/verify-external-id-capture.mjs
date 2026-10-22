#!/usr/bin/env node
/**
 * `npm run verify:external-id-capture` — **受取時・外部検査ID 撮影／登録**の回帰チェック。
 *
 * 正本: `docs/lab/kit_receipt_external_id_capture_spec.md`
 *       ＋ `docs/lab/lab_data_pipeline_master_spec.md` §4-5 (v2.1)。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【ここは静かに壊れる】目視では守れないので機械で見る。
 * ══════════════════════════════════════════════════════════════════════
 *   - 撮れたつもりで**読めていない**（画面はエラーを出さない）
 *   - **QR の値**を相関キーにしてしまう（番号の形は似ている）
 *   - **他人の検査**へ紐付く（画面は正常に見える）
 *   - 期待パターンの既定が実物と違うだけで**全件が止まる**
 *   - 台帳が **anon キーで読める**（証跡画像の S3 キーと外部IDが漏れる）
 *
 * 検査は「そう書いてあるか」で済ませず、**実物を transpile して動かす**。
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
/** コメント行を落とす（経緯の説明に旧コードが書いてあるため、そこを拾わない）。 */
const code = (p) => read(p).split('\n').filter((ln) => !/^\s*(\*|\/\/|\/\*)/.test(ln)).join('\n');

const fails = [];
let pass = 0;
const ts = (await import('typescript')).default;
mkdirSync(resolve(ROOT, 'node_modules/.cache'), { recursive: true });
const js = (src) => ts.transpileModule(src, { compilerOptions: { target: 'ES2022', module: 'ESNext' } }).outputText;
/**
 * TS を transpile して **data: URL から import する**。
 * data: URL では相対 import を解決できないので、`subs` で
 * **import 文をリテラル宣言へ置き換える**（値はソースと同じものを使う）。
 */
const load = async (relPath, subs = []) => {
  let src = read(relPath);
  for (const [re, to] of subs) src = src.replace(re, to ?? '');
  const b64 = Buffer.from(js(src), 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${b64}`);
};

const ok = (label, cond, why) => {
  if (cond) pass++; else fails.push(`${label}${why ? ` — ${why}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);

// ══════════════════════════════════════════════════════════════════════
// ① 正規化 — 区切りだけ捨てる。数字以外を「親切に」直さない
// ══════════════════════════════════════════════════════════════════════
console.log('\n① 正規化 (normalizeExternalId)\n');
const core = await load('src/lib/external-test-id.ts');
{
  const n = core.normalizeExternalId;
  eq('半角そのまま', n('704000123'), '704000123');
  eq('全角数字 → 半角', n('７０４０００１２３'), '704000123');
  eq('空白・全角空白を捨てる', n(' 704 000　123 '), '704000123');
  eq('ハイフン類を捨てる (- ‐ – — ー −)', n('704-000‐123–'), '704000123');
  eq('ドットを捨てる', n('704.000.123'), '704000123');
  // **ここが要点**: `O`→`0` のような補正をしない。別の番号に化けるため。
  eq('英字が混ざったら null (O→0 に直さない)', n('7O4000123'), null);
  eq('記号が混ざったら null', n('704000#123'), null);
  /*
   * **バーコードの start/stop を 1 文字だけ剥がす** (実物のプリベントの台紙は `A…A`)。
   * 剥がさないと **バーコード側が常に捨てられ、毎回 `single_source` = `review_required`** になる。
   */
  eq('Codabar の start/stop を剥がす (A…A)', n('A704000123A'), '704000123');
  eq('小文字でも剥がす', n('a704000123a'), '704000123');
  eq('A〜D なら種類が違ってもよい', n('B704000123C'), '704000123');
  eq('片側だけでも剥がす', n('A704000123'), '704000123');
  eq('**2 文字は剥がさない** (想定外はそのまま落とす)', n('AA704000123A'), null);
  eq('**`*` は剥がさない** (Code39 は実物で見ていない)', n('*704000123*'), null);
  eq('英字だけなら null', n('A'), null);
  eq('E〜Z は剥がさない', n('E704000123E'), null);
  eq('空文字は null', n('   '), null);
  eq('文字列以外は null', n(12345), null);
  eq('undefined は null', n(undefined), null);
}

// ══════════════════════════════════════════════════════════════════════
// ② 構造ガード (ハード) と 期待パターン (ソフト) の二段
// ══════════════════════════════════════════════════════════════════════
console.log('\n② 構造ガードと期待パターン\n');
{
  const g = core.passesStructuralGuard;
  ok('4 桁は通る', g('1234'));
  ok('3 桁は落ちる', !g('123'));
  ok('20 桁は通る', g('1'.repeat(20)));
  ok('21 桁は落ちる', !g('1'.repeat(21)));
  ok('null は落ちる', !g(null));

  const m = core.matchesExpectedPattern;
  eq('既定パターンに合う', m('704000123', core.DEFAULT_EXPECTED_PATTERN.prevent), true);
  eq('既定パターンに合わない', m('704000', core.DEFAULT_EXPECTED_PATTERN.prevent), false);
  /*
   * **壊れたパターンで落ちない**。判定不能 = null → 呼び出し側は review に倒す。
   * try/catch を外した退行は**例外で検査ごと落ちる**ので、ここで捕まえて
   * **名指しの FAIL にする**（crash は原因が読めない）。
   */
  {
    let got;
    try { got = m('704000123', '^704000[0-9'); } catch (e) { got = `threw: ${e instanceof Error ? e.name : 'unknown'}`; }
    eq('壊れた正規表現は null (例外を投げない)', got, null);
  }
  eq('空パターンは null (未設定)', m('704000123', ''), null);
  eq('デメカル既定は 15 桁', m('123456789012345', core.DEFAULT_EXPECTED_PATTERN.demecal), true);
  eq('デメカル既定は 16 桁を弾く', m('1234567890123456', core.DEFAULT_EXPECTED_PATTERN.demecal), false);
}

// ══════════════════════════════════════════════════════════════════════
// ③ 採否判定 — **一致しないものを自動確定しない**（仕様 §1-3 / §5.1）
// ══════════════════════════════════════════════════════════════════════
console.log('\n③ 採否判定 (evaluateExternalId)\n');
{
  const ev = (o) => core.evaluateExternalId({ provider: 'prevent', expectedPattern: core.DEFAULT_EXPECTED_PATTERN.prevent, ...o });

  const both = ev({ barcode: '704000123', ocr: '704000123' });
  eq('両方一致 → confirmed', [both.ok, both.status, both.value, both.decodeMethod],
    [true, 'confirmed', '704000123', 'barcode+ocr']);
  eq('両方一致 → 理由なし', both.reasons, []);

  const mis = ev({ barcode: '704000123', ocr: '704000999' });
  eq('不一致 → review_required', mis.status, 'review_required');
  eq('不一致 → **バーコードを採る**', mis.value, '704000123');
  ok('不一致 → 理由コードが付く', mis.reasons.includes('barcode_ocr_mismatch'));

  const onlyB = ev({ barcode: '704000123', ocr: null });
  eq('バーコードのみ → review_required', onlyB.status, 'review_required');
  ok('バーコードのみ → single_source', onlyB.reasons.includes('single_source'));
  eq('バーコードのみ → decode=barcode', onlyB.decodeMethod, 'barcode');

  const onlyO = ev({ barcode: null, ocr: '704000123' });
  eq('印字のみ → decode=ocr', onlyO.decodeMethod, 'ocr');
  eq('印字のみ → review_required', onlyO.status, 'review_required');

  const pat = ev({ barcode: '999999999', ocr: '999999999' });
  eq('パターン外 → review_required (登録は通す)', [pat.ok, pat.status], [true, 'review_required']);
  ok('パターン外 → pattern_mismatch', pat.reasons.includes('pattern_mismatch'));

  const man = ev({ barcode: '704000123', ocr: '704000123', manual: '704000555' });
  eq('手入力が最優先', man.value, '704000555');
  eq('手入力 → review_required', man.status, 'review_required');
  ok('手入力 → manual_entry', man.reasons.includes('manual_entry'));

  const none = ev({ barcode: 'ABC', ocr: null });
  eq('読める値ゼロ → ok:false', [none.ok, none.value, none.error], [false, null, 'no_readable_value']);

  const short = ev({ barcode: '12', ocr: '12' });
  eq('構造ガード未満は採らない', [short.ok, short.error], [false, 'no_readable_value']);

  const unk = core.evaluateExternalId({ provider: 'prevent', barcode: '704000123', ocr: '704000123', expectedPattern: '' });
  ok('パターン未設定 → pattern_unknown で review', unk.status === 'review_required' && unk.reasons.includes('pattern_unknown'));
}

// ══════════════════════════════════════════════════════════════════════
// ③' 発行元（法人）の接頭辞 = **読み取りが成功したかの検査**
//     （発注者指示 2026-10-21「ユーザーIDの頭の 704 は Wellfort 法人を表す」）
// ══════════════════════════════════════════════════════════════════════
console.log("\n③' 発行元の接頭辞 (704 = Wellfort)\n");
{
  const ev = (o) => core.evaluateExternalId({ provider: 'prevent', expectedPattern: core.DEFAULT_EXPECTED_PATTERN.prevent, ...o });

  eq('コード既定は 704 (プリベント)', core.DEFAULT_ORG_PREFIX.prevent, '704');
  /*
   * **デメカルには足さない。** この概念を先方から確認していないので、
   * 想像で接頭辞を置くと**全件が review_required になる**。
   */
  eq('デメカルは空 = 判定しない', core.DEFAULT_ORG_PREFIX.demecal, '');

  const m = core.matchesOrgPrefix;
  eq('704 で始まる → true', m('704000123', '704'), true);
  eq('704 で始まらない → false', m('999000123', '704'), false);
  eq('途中に 704 があっても false', m('170400012', '704'), false);
  /*
   * **設定の打ち間違いで全件を止めない。** 値は数字だけなので、数字でない接頭辞は
   * 必ず不一致になる。そこで「アウト」にすると 1 文字のミスで運用が止まる。
   */
  eq('空は判定しない (null)', m('704000123', ''), null);
  eq('数字でない設定は判定しない (null)', m('704000123', 'ABC'), null);
  eq('undefined も判定しない', m('704000123', undefined), null);

  // ── 読み取りが成功したかの検査 ──
  const bad = ev({ barcode: '999000123', ocr: '999000123' });
  eq('接頭辞が違う → review_required (**登録は止めない**)', [bad.ok, bad.status], [true, 'review_required']);
  ok('接頭辞が違う → org_prefix_mismatch', bad.reasons.includes('org_prefix_mismatch'));
  eq('**値を直さない** (704 を足して捏造しない)', bad.value, '999000123');

  const good = ev({ barcode: '704000123', ocr: '704000123' });
  ok('接頭辞が合えば理由は付かない', !good.reasons.includes('org_prefix_mismatch'));

  /*
   * **バーコードと印字が食い違ったら、704 で始まる側を採る**
   * ＝「どちらの読み取りが成功したか」の判定に使う。
   */
  const pickOcr = ev({ barcode: '104000123', ocr: '704000123' });
  eq('バーコードが 704 でなく印字が 704 → **印字を採る**', [pickOcr.value, pickOcr.decodeMethod], ['704000123', 'ocr']);
  ok('それでも barcode_ocr_mismatch は残す (自動確定しない)',
    pickOcr.reasons.includes('barcode_ocr_mismatch') && pickOcr.status === 'review_required');
  ok('採った値は 704 なので org_prefix_mismatch は付かない', !pickOcr.reasons.includes('org_prefix_mismatch'));

  const pickBarcode = ev({ barcode: '704000123', ocr: '104000123' });
  eq('印字が 704 でなくバーコードが 704 → バーコードを採る',
    [pickBarcode.value, pickBarcode.decodeMethod], ['704000123', 'barcode']);

  const bothGood = ev({ barcode: '704000123', ocr: '704000999' });
  eq('どちらも 704 → 従来どおりバーコードを採る',
    [bothGood.value, bothGood.decodeMethod], ['704000123', 'barcode']);
  const bothBad = ev({ barcode: '104000123', ocr: '204000123' });
  eq('どちらも 704 でない → 従来どおりバーコードを採る',
    [bothBad.value, bothBad.decodeMethod], ['104000123', 'barcode']);

  // 手入力にも効く（手で打ち間違えた回も拾う）
  const man = ev({ barcode: '704000123', ocr: '704000123', manual: '904000123' });
  ok('手入力でも接頭辞を見る', man.reasons.includes('org_prefix_mismatch'));

  // 接頭辞は app_config から差し替えられる
  const other = core.evaluateExternalId({
    provider: 'prevent', barcode: '704000123', ocr: '704000123',
    expectedPattern: core.DEFAULT_EXPECTED_PATTERN.prevent, orgPrefix: '801',
  });
  ok('接頭辞を差し替えると判定も変わる', other.reasons.includes('org_prefix_mismatch'));
  const off = core.evaluateExternalId({
    provider: 'prevent', barcode: '999000123', ocr: '999000123',
    expectedPattern: '', orgPrefix: '',
  });
  ok('接頭辞が空なら判定しない', !off.reasons.includes('org_prefix_mismatch'));

  // デメカルは既定で判定しない
  const dem = core.evaluateExternalId({
    provider: 'demecal', barcode: '123456789012345', ocr: '123456789012345',
  });
  eq('デメカルは接頭辞で止めない', [dem.status, dem.reasons], ['confirmed', []]);
}

// ══════════════════════════════════════════════════════════════════════
// ④ Genoplan を**この経路に通さない**（正本はタカセ返送CSV 方式・仕様 §2.3）
// ══════════════════════════════════════════════════════════════════════
console.log('\n④ Genoplan は対象外\n');
{
  eq('provider は prevent / demecal の 2 つだけ', [...core.EXTERNAL_ID_PROVIDERS], ['prevent', 'demecal']);
  ok('genoplan は provider でない', !core.isExternalIdProvider('genoplan'));
  ok('genetics から provider は引けない', core.providerForTestType('genetics') === null);
  eq('prevent ↔ cancer_urine', core.PROVIDER_TEST_TYPE.prevent, 'cancer_urine');
  eq('demecal ↔ blood', core.PROVIDER_TEST_TYPE.demecal, 'blood');
  ok('provider と test_type の不整合を弾く', !core.providerMatchesTestType('prevent', 'blood'));
  // migration の CHECK でも閉じていること（DB 側の二重の守り）
  const mig = read('supabase/migrations/20261011000010_lab_test_id_captures.sql');
  ok('migration の CHECK も prevent/demecal だけ',
    /provider in \('prevent', 'demecal'\)/.test(mig));
  ok('migration に genoplan が出てこない', !/genoplan/i.test(mig));
}

// ══════════════════════════════════════════════════════════════════════
// ⑤ 列の取り違えを防ぐ — external_barcode と external_test_id は別物
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑤ 書き込む列\n');
{
  eq('prevent は external_barcode (物理キットID)', core.PROVIDER_ID_COLUMN.prevent, 'external_barcode');
  eq('demecal は external_test_id (外部照会ID)', core.PROVIDER_ID_COLUMN.demecal, 'external_test_id');
  const persist = code('src/lib/external-id-persist.ts');
  // **計算キーに戻っていないこと**。戻ると列名を取り違えても型で気づけない。
  ok('計算キー `[column]:` を使っていない', !/\[column\]\s*:/.test(persist));
  ok('idPatch で列を明示している', /external_barcode:\s*v/.test(persist) && /external_test_id:\s*v/.test(persist));
}

// ══════════════════════════════════════════════════════════════════════
// ⑥ マスク — 外部IDの全文を画面・ログへ出さない（仕様 §6.1）
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑥ マスク\n');
{
  const m = core.maskExternalId;
  eq('末尾 4 桁だけ残す', m('704000123'), '*****0123');
  eq('桁数は保つ (長さが漏れるのは許容・値は漏らさない)', m('704000123').length, 9);
  ok('先頭が残らない', !m('704000123').startsWith('7'));
  eq('4 桁以下は全部隠す', m('1234'), '****');
  eq('空は空', m(''), '');
  eq('null は空', m(null), '');
  // register 応答に全文が入らないこと
  const api = code('src/pages/api/kit/[id]/external-id.ts');
  ok('register 応答は masked を返す', /masked:\s*rec\.masked/.test(api));
  ok('register 応答に value / candidate を入れていない',
    !/mode:\s*'register'[\s\S]{0,400}candidate/.test(api));
}

// ══════════════════════════════════════════════════════════════════════
// ⑦ プリベント問診CSV の fail-closed ゲート（仕様 §7.1 ①）
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑦ AI問診 → 問診CSV のゲート\n');
{
  /** 台帳レコードの形で渡す（**値だけを渡す API に戻してはいけない**）。 */
  const cap = (over = {}) => ({
    normalizedValue: '704000123',
    status: 'confirmed',
    labTestLinkStatus: 'linked',
    labTestId: 'lt-1',
    ...over,
  });
  const g = (capture, p) => core.checkPreventQuestionnaireGate({ capture, expectedPattern: p });

  eq('撮影レコードが無い → ブロック', [g(null).allowed, g(null).reason], [false, 'capture_missing']);
  eq('undefined → ブロック', [g(undefined).allowed, g(undefined).reason], [false, 'capture_missing']);
  eq('値が空 → ブロック',
    [g(cap({ normalizedValue: '' })).allowed, g(cap({ normalizedValue: '' })).reason],
    [false, 'barcode_no_missing']);
  eq('数字にならない → ブロック',
    [g(cap({ normalizedValue: 'ABC' })).allowed, g(cap({ normalizedValue: 'ABC' })).reason],
    [false, 'barcode_no_missing']);
  eq('短すぎる → ブロック',
    [g(cap({ normalizedValue: '12' })).allowed, g(cap({ normalizedValue: '12' })).reason],
    [false, 'barcode_no_malformed']);

  // ── ここが本題（発注者指示 2026-10-11）: 3 つ揃ったときだけ通す ──────
  eq('confirmed + linked + lab_test_id → 通す', [g(cap()).allowed, g(cap()).reason], [true, 'ok']);

  for (const st of ['review_required', 'superseded', '', 'unknown']) {
    const r = g(cap({ status: st }));
    eq(`status=${st || '(空)'} → **ブロック**`, [r.allowed, r.reason], [false, 'capture_not_confirmed']);
  }
  for (const ls of ['deferred', 'conflict', '', 'unknown']) {
    const r = g(cap({ labTestLinkStatus: ls }));
    eq(`link=${ls || '(空)'} → **ブロック**`, [r.allowed, r.reason], [false, 'lab_test_not_linked']);
  }
  for (const id of [null, undefined, '', '   ']) {
    const r = g(cap({ labTestId: id }));
    eq(`lab_test_id=${JSON.stringify(id)} → **ブロック**`, [r.allowed, r.reason], [false, 'lab_test_not_linked']);
  }

  /*
   * **期待パターン（総桁数まで含む形式例）は再判定しない。** 実物が未確認なので、
   * 台帳の `status` を正とする（外れた回は review_required で次の段が止める）。
   * → **`704` で始まるがパターンには合わない値**で確かめる。
   */
  eq('パターン外でも台帳が confirmed なら通す (判定の二重化をしない)',
    g(cap({ normalizedValue: '7041234567' })).allowed, true);
  eq('パターン外で review_required なら止まる',
    g(cap({ normalizedValue: '7041234567', status: 'review_required' })).allowed, false);

  /*
   * ── 発行元の接頭辞（`704`＝Wellfort・発注者指示 2026-10-21）──
   * **ここはハードな不変条件なので再判定する。** `confirmed` の行でも `704` で
   * 始まらない値は**当社の検査キットの番号ではない**ので、問診CSV に出してはいけない
   * （admin の訂正で値が差し替わった回・接頭辞の設定が後から変わった回に効く）。
   */
  {
    const r = g(cap({ normalizedValue: '999999999' }));
    eq('**接頭辞が違えば confirmed でもブロック**', [r.allowed, r.reason], [false, 'org_prefix_mismatch']);
    ok('ブロックの説明に外部IDの全文が入らない', !r.detail.includes('999999999'));
  }
  eq('接頭辞が合えば通る', g(cap({ normalizedValue: '704000999' })).allowed, true);
  /*
   * **設定の打ち間違いで全件を止めない。** 空・数字でない接頭辞は「判定しない」へ倒す
   * （止める側に倒すと、1 文字の設定ミスで問診CSV が全部出せなくなる）。
   */
  eq('接頭辞が空なら判定しない',
    core.checkPreventQuestionnaireGate({ capture: cap({ normalizedValue: '999999999' }), orgPrefix: '' }).allowed,
    true);
  eq('接頭辞が数字でなければ判定しない',
    core.checkPreventQuestionnaireGate({ capture: cap({ normalizedValue: '999999999' }), orgPrefix: 'ABC' }).allowed,
    true);
  eq('接頭辞は app_config から差し替えられる',
    core.checkPreventQuestionnaireGate({ capture: cap({ normalizedValue: '704000123' }), orgPrefix: '801' }).reason,
    'org_prefix_mismatch');

  ok('ブロックの説明に外部IDの全文が入らない',
    !g(cap({ normalizedValue: '123456789', status: 'review_required' })).detail.includes('123456789'));

  // **値だけを受ける旧シグネチャが残っていないこと**（残っていると
  // 呼び側が status / link を見ずに通せる = 元の穴がそのまま再発する）。
  const gateSrc = read('src/lib/external-test-id.ts');
  ok('旧 `capturedBarcodeNo` 引数を復活させていない', !/capturedBarcodeNo/.test(gateSrc));
  ok('ゲートが status を見ている', /cap\.status !== 'confirmed'/.test(gateSrc));
  ok('ゲートが lab_test_link_status を見ている', /labTestLinkStatus !== 'linked'/.test(gateSrc));

  // **`interview-cycle.ts` に足していないこと**。あちらは fail-safe が
  // 「催促しない」側なので、ゲートを置くと fail-open になる。
  const cyc = code('src/lib/interview-cycle.ts');
  ok('interview-cycle.ts にバーコードのゲートを足していない',
    !/barcode|external_?(test_)?id|labid\./i.test(cyc));
}

// ══════════════════════════════════════════════════════════════════════
// ⑧ 証跡画像のキー検証 — ここが緩むとバケット内の他データを読み出せる
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑧ 証跡画像のキー検証 (isEvidenceKey)\n');
{
  // S3 SDK を読み込まずに純粋部分だけ動かす（import を落とす）。
  const ev = await load('src/lib/external-id-evidence.ts', [
    [/^import \{ PutObjectCommand[\s\S]*?from '@aws-sdk\/client-s3';$/m, ''],
    [/^import \{ getSignedUrl \}[\s\S]*?from '@aws-sdk\/s3-request-presigner';$/m, ''],
    [/^import \{ getS3Config[\s\S]*?from '\.\/s3';$/m, ''],
  ]);
  const cfg = { prefix: 'scan-accuracy-test/', bucket: 'b', region: 'r' };
  const K = (k) => ev.isEvidenceKey(k, cfg);
  const good = 'scan-accuracy-test/kit-id-captures/2026/10/11/11111111-2222-3333-4444-555555555555.jpg';
  ok('サーバ採番の形は通る', K(good));
  ok('png / webp / heic も通る', K(good.replace('.jpg', '.png')) && K(good.replace('.jpg', '.webp')) && K(good.replace('.jpg', '.heic')));
  // ここから下は**全部通してはいけない**
  ok('**Elith 納品 JSON を通さない**', !K('scan-accuracy-test/user/d0000001/date/2026_10_11/HealthCheckupData_x.json'));
  ok('**.json を通さない**', !K(good.replace('.jpg', '.json')));
  ok('**.pdf を通さない** (撮影は写真だけ)', !K(good.replace('.jpg', '.pdf')));
  ok('スキャンの一時領域を通さない', !K('scan-accuracy-test/scan-uploads/2026/10/11/11111111-2222-3333-4444-555555555555.jpg'));
  ok('prefix だけ合う部分一致を通さない', !K('scan-accuracy-test/kit-id-captures/anything.jpg'));
  ok('相対パス (..) を通さない', !K('scan-accuracy-test/kit-id-captures/2026/10/../../../secret.jpg'));
  ok('非 UUID を通さない', !K('scan-accuracy-test/kit-id-captures/2026/10/11/not-a-uuid.jpg'));
  ok('二重拡張子を通さない', !K(good.replace('.jpg', '.jpg.json')));
  ok('prefix 違いを通さない', !K('other-prefix/kit-id-captures/2026/10/11/11111111-2222-3333-4444-555555555555.jpg'));
  ok('日付でないセグメントを通さない', !K('scan-accuracy-test/kit-id-captures/aaaa/bb/cc/11111111-2222-3333-4444-555555555555.jpg'));
  ok('文字列以外を通さない', !K(null) && !K(undefined) && !K(123));

  // 実体検査（Content-Type の自己申告だけを信じない）
  const img = ev.looksLikeImage;
  ok('JPEG のマジックバイトを認める', img(new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
  ok('PNG のマジックバイトを認める', img(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])));
  ok('**PDF を画像と認めない**', !img(new Uint8Array([...Buffer.from('%PDF-1.7'), 0, 0, 0, 0])));
  ok('**JSON を画像と認めない**', !img(new Uint8Array([...Buffer.from('{"a":1}'), 0, 0, 0, 0, 0])));
  ok('短すぎるバイト列を認めない', !img(new Uint8Array([0xff, 0xd8])));

  // **10 年保管の原本ストレージへ入れていないこと**（撮り直しが消せなくなる）
  const evSrc = code('src/lib/external-id-evidence.ts');
  ok('putOriginal を使っていない', !/putOriginal/.test(evSrc));
  ok('Content-Type と長さを署名に固定している', /ContentType:\s*contentType/.test(evSrc) && /ContentLength:\s*bytes/.test(evSrc));
  ok('requestChecksumCalculation の罠を踏んでいない', /WHEN_REQUIRED/.test(evSrc));
  ok('キーはサーバが採番している (randomUUID)', /crypto\.randomUUID\(\)/.test(evSrc));
}

// ══════════════════════════════════════════════════════════════════════
// ⑨ Gemini 読み取り — **QR を候補にしない**
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑨ 読み取り (Gemini)\n');
{
  const rd = await load('src/lib/external-id-read.ts', [
    [/^import \{ callGemini[\s\S]*?from '\.\/gemini';$/m, 'const callGemini = async () => { throw new Error("stub"); }; const MODELS = { scan: "stub" };'],
    [/^import \{ refreshConfig \}[\s\S]*?from '\.\/app-config';$/m, 'const refreshConfig = async () => undefined;'],
    // **値はソースから読み出して注入する**（ここで別の配列を書くと検査が実物から離れる）
    [/^import \{\n?\s*EXTERNAL_ID_PROVIDERS[\s\S]*?from '\.\/external-test-id';$/m,
      `const EXTERNAL_ID_PROVIDERS = ${JSON.stringify([...core.EXTERNAL_ID_PROVIDERS])};`],
  ]);
  const p = rd.parseReadJson;
  eq('素の JSON を読む', p('{"barcode_value":"704000123","printed_id_value":"704000123"}'),
    { barcode: '704000123', printed: '704000123', note: null });
  eq('```json フェンスを外す', p('```json\n{"barcode_value":"1","printed_id_value":null}\n```'),
    { barcode: '1', printed: null, note: null });
  eq('数値で返ってきても文字列化する', p('{"barcode_value":704000123,"printed_id_value":null}').barcode, '704000123');
  eq('"null" 文字列は null 扱い', p('{"barcode_value":"null","printed_id_value":null}').barcode, null);
  eq('壊れた JSON は null (投げない)', p('{oops'), null);
  eq('空文字は null', p(''), null);
  eq('配列は null', p('[1,2]'), null);

  const src = read('src/lib/external-id-read.ts');
  // **スキーマに QR のフィールドを作らない**
  ok('スキーマに qr のフィールドが無い', !/qr[_a-z]*\s*:/i.test(src.split('export const SYSTEM_BY_PROVIDER')[0]));

  /*
   * **プロンプトは provider ごとに個別に見る。**
   * 以前はソース全体に「QR …読まない」が 1 つあれば通る書き方にしていたため、
   * **片方の provider から QR 除外を外した退行が素通りした**（実測）。
   * 片方だけ壊れると、その検査だけ QR の値が候補に混ざる = 静かに壊れる。
   */
  for (const prov of core.EXTERNAL_ID_PROVIDERS) {
    const sys = rd.SYSTEM_BY_PROVIDER[prov];
    const usr = rd.USER_BY_PROVIDER[prov];
    ok(`${prov}: system プロンプトが QR を除外している`,
      /QR\s*コード[^。]*(読まない|読み取らない|無視)/.test(sys), JSON.stringify(sys?.slice(0, 120)));
    if (prov === 'prevent') {
      /*
       * **台紙にはログイン用のパスワードが印字されている**（実物で確認・2026-10-13）。
       * 値として返させない。証跡画像は S3 に残るので、ここが緩むと**資格情報が
       * 応答と台帳に流れる**。
       */
      ok('prevent: パスワードと URL を読ませない',
        /パスワード[^。]*読まない|読まない[^。]*パスワード/.test(sys) && /URL/.test(sys));
      ok('prevent: 英字で挟まれた印字をそのまま返させる (A…A)',
        /英字で挟まれている/.test(sys));
    }
    ok(`${prov}: user プロンプトでも QR を無視させている`,
      /QR\s*コード[^。]*(無視|読まない|読み取らない)/.test(usr), JSON.stringify(usr));
    ok(`${prov}: 推測で数字を作らせない`, /推測で数字を作らない/.test(sys));
    ok(`${prov}: 読めないものは null と指示している`, /null/.test(sys));
  }
  ok('バーコードと印字を別々に報告させている', /barcode_value/.test(src) && /printed_id_value/.test(src));
  ok('prevent は 1次元バーコードと印字IDの 2 つを別々に取る',
    /barcode_value/.test(rd.SYSTEM_BY_PROVIDER.prevent) && /printed_id_value/.test(rd.SYSTEM_BY_PROVIDER.prevent));
  // **読み取り側で正規化しない**（規則が 2 か所に分かれると食い違う）
  ok('read 側で normalizeExternalId を呼んでいない', !/normalizeExternalId/.test(code('src/lib/external-id-read.ts')));
}

// ══════════════════════════════════════════════════════════════════════
// ⑩ 登録の挙動 — 実物の persist を**スタブ DB で動かす**
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑩ 登録 (persistExternalIdCapture を実際に動かす)\n');
/** ⑭ でも同じ実物・同じスタブを使うため外へ出す（別に書き写すと検査が実装から離れる）。 */
let PERSIST; let MAKE_STUB; let BASE;
{
  const persist = await load('src/lib/external-id-persist.ts', [
    [/^import type \{ SupabaseClient \}[\s\S]*?;$/m, ''],
    [/^import type \{ Database \}[\s\S]*?;$/m, ''],
    // **実物の値を注入する**（別に書き写すと検査が実装から離れる）
    [/^import \{[\s\S]*?from '\.\/external-test-id';$/m,
      `const PROVIDER_ID_COLUMN = ${JSON.stringify(core.PROVIDER_ID_COLUMN)};`
      + ` const PROVIDER_ID_KIND = ${JSON.stringify(core.PROVIDER_ID_KIND)};`
      + ` const PROVIDER_TEST_TYPE = ${JSON.stringify(core.PROVIDER_TEST_TYPE)};`
      + ` const maskExternalId = ${core.maskExternalId.toString()};`],
  ]);

  /** 呼ばれたクエリを記録する最小のスタブ。テーブルごとに応答を差し込める。 */
  function makeStub(tables) {
    const calls = [];
    const builder = (table) => {
      const st = { table, op: 'select', filters: {}, values: null };
      const res = (v) => { calls.push(st); return Promise.resolve(v); };
      const api = {
        select() { st.op = st.op === 'select' ? 'select' : st.op; return api; },
        insert(v) { st.op = 'insert'; st.values = v; return api; },
        update(v) { st.op = 'update'; st.values = v; return api; },
        eq(c, v) { st.filters[c] = v; return api; },
        neq(c, v) { st.filters[`!${c}`] = v; return api; },
        contains(c, v) { st.filters[c] = v; return api; },
        order() { return api; },
        limit() { return api.then ? api : api; },
        maybeSingle() { return res(resolveFor(st, tables, 'single')); },
        then(onOk, onErr) { return res(resolveFor(st, tables, 'many')).then(onOk, onErr); },
      };
      return api;
    };
    return {
      calls,
      schema: () => ({ from: (t) => builder(t) }),
    };
  }
  function resolveFor(st, tables, shape) {
    const h = tables[st.table];
    const out = typeof h === 'function' ? h(st) : h;
    const v = out ?? { data: shape === 'single' ? null : [], error: null };
    if (shape === 'single' && Array.isArray(v.data)) return { data: v.data[0] ?? null, error: v.error ?? null };
    return v;
  }
  const base = {
    diagnosticUserId: 'aaaaaaaa-0000-0000-0000-000000000001',
    shipmentRef: 'ord_prod_id',
    provider: 'prevent',
    testType: 'cancer_urine',
    value: '704000123',
    status: 'confirmed',
    captureMethod: 'camera',
    decodeMethod: 'barcode+ocr',
    reviewReasons: [],
    evidenceKey: 'scan-accuracy-test/kit-id-captures/2026/10/11/11111111-2222-3333-4444-555555555555.jpg',
  };

  // (a) 新規・材料そろい → lab_tests を作って linked
  {
    const stub = makeStub({
      lab_test_id_captures: (st) => st.op === 'insert' ? { data: [{ id: 'cap1' }], error: null } : { data: [], error: null },
      lab_tests: (st) => st.op === 'insert' ? { data: [{ id: 'lt1' }], error: null } : { data: [], error: null },
      customer_profiles: { data: [{ user_id: 'cust-1' }], error: null },
      lab_companies: { data: [{ id: 'co-1' }], error: null },
      kit_shipments: { data: [], error: null },
    });
    const r = await persist.persistExternalIdCapture({ sb: stub, ...base });
    ok('(a) 新規登録が成功する', r.ok === true, JSON.stringify(r));
    eq('(a) linked になる', r.ok && r.record.labTestLinkStatus, 'linked');
    eq('(a) status は confirmed のまま', r.ok && r.record.status, 'confirmed');
    eq('(a) 応答はマスクだけ', r.ok && r.record.masked, '*****0123');
    const ins = stub.calls.find((c) => c.table === 'lab_tests' && c.op === 'insert');
    ok('(a) lab_tests へ insert した', !!ins);
    eq('(a) **external_barcode** へ入れている', ins?.values?.external_barcode, '704000123');
    ok('(a) external_test_id は触らない', ins?.values?.external_test_id === undefined);
    // **本番の受取 ID は customer.kit_shipments に無いので shipment_id は NULL**
    eq('(a) shipment_id は NULL (FK 違反を避ける)', ins?.values?.shipment_id, null);
    eq('(a) assigned_by は auto_id', ins?.values?.assigned_by, 'auto_id');
  }

  // (b) 重複 — 同じ値が**別の人**に在る → lab_tests を 1 バイトも触らない
  {
    const stub = makeStub({
      lab_test_id_captures: (st) => {
        if (st.op === 'insert') return { data: [{ id: 'cap2' }], error: null };
        if (st.filters.normalized_value) {
          return { data: [{ id: 'other', diagnostic_user_id: 'bbbbbbbb-0000-0000-0000-000000000002', shipment_ref: 'ord_other' }], error: null };
        }
        return { data: [], error: null };
      },
      lab_tests: { data: [], error: null },
      customer_profiles: { data: [{ user_id: 'cust-1' }], error: null },
      lab_companies: { data: [{ id: 'co-1' }], error: null },
      kit_shipments: { data: [], error: null },
    });
    const r = await persist.persistExternalIdCapture({ sb: stub, ...base });
    ok('(b) 重複でも台帳には記録する (撮影を失わない)', r.ok === true);
    eq('(b) conflict になる', r.ok && r.record.labTestLinkStatus, 'conflict');
    eq('(b) status は review_required へ落ちる', r.ok && r.record.status, 'review_required');
    const touched = stub.calls.filter((c) => c.table === 'lab_tests' && c.op !== 'select');
    eq('(b) **lab_tests への書き込みは 0 件**', touched.length, 0);
  }

  // (c) 二重 submit — 同じ値を 2 回 → 行を増やさない (update のみ)
  {
    const stub = makeStub({
      lab_test_id_captures: (st) => {
        if (st.op === 'insert') return { data: [{ id: 'cap_new' }], error: null };
        if (st.filters.normalized_value) return { data: [], error: null };
        return { data: [{ id: 'cap_prev', normalized_value: '704000123' }], error: null };
      },
      lab_tests: (st) => st.op === 'insert' ? { data: [{ id: 'lt1' }], error: null } : { data: [], error: null },
      customer_profiles: { data: [{ user_id: 'cust-1' }], error: null },
      lab_companies: { data: [{ id: 'co-1' }], error: null },
      kit_shipments: { data: [], error: null },
    });
    const r = await persist.persistExternalIdCapture({ sb: stub, ...base });
    ok('(c) 二重 submit も成功で返す', r.ok === true);
    const inserts = stub.calls.filter((c) => c.table === 'lab_test_id_captures' && c.op === 'insert');
    eq('(c) **台帳へ insert しない (行が増えない)**', inserts.length, 0);
    const ups = stub.calls.filter((c) => c.table === 'lab_test_id_captures' && c.op === 'update');
    ok('(c) 既存行を update する', ups.length >= 1);
    ok('(c) superseded にしない', !ups.some((u) => u.values?.status === 'superseded'));
  }

  // (d) 撮り直し (値が変わる) → 旧行を superseded にして入れ直す
  {
    const stub = makeStub({
      lab_test_id_captures: (st) => {
        if (st.op === 'insert') return { data: [{ id: 'cap_new' }], error: null };
        if (st.filters.normalized_value) return { data: [], error: null };
        return { data: [{ id: 'cap_prev', normalized_value: '704000999' }], error: null };
      },
      lab_tests: (st) => st.op === 'insert' ? { data: [{ id: 'lt1' }], error: null } : { data: [], error: null },
      customer_profiles: { data: [{ user_id: 'cust-1' }], error: null },
      lab_companies: { data: [{ id: 'co-1' }], error: null },
      kit_shipments: { data: [], error: null },
    });
    const r = await persist.persistExternalIdCapture({ sb: stub, ...base });
    ok('(d) 撮り直しが成功する', r.ok === true);
    const sup = stub.calls.find((c) => c.table === 'lab_test_id_captures' && c.op === 'update' && c.values?.status === 'superseded');
    ok('(d) 旧行を superseded にする (消さない)', !!sup);
    const ins = stub.calls.find((c) => c.table === 'lab_test_id_captures' && c.op === 'insert');
    ok('(d) 新行を insert する', !!ins);
    eq('(d) previous_value に旧値を残す (監査)', ins?.values?.previous_value, '704000999');
  }

  // (e) customer_profiles が無い本番の形 → lab_tests を作らず deferred。**撮影は残る**
  {
    const stub = makeStub({
      lab_test_id_captures: (st) => st.op === 'insert' ? { data: [{ id: 'cap3' }], error: null } : { data: [], error: null },
      lab_tests: { data: [], error: null },
      customer_profiles: { data: [], error: null },
      lab_companies: { data: [{ id: 'co-1' }], error: null },
      kit_shipments: { data: [], error: null },
    });
    const r = await persist.persistExternalIdCapture({ sb: stub, ...base });
    ok('(e) 紐付けできなくても登録は成功する', r.ok === true, JSON.stringify(r));
    eq('(e) deferred になる', r.ok && r.record.labTestLinkStatus, 'deferred');
    eq('(e) status は review_required', r.ok && r.record.status, 'review_required');
    ok('(e) 理由が残る', r.ok && /customer_profiles/.test(r.record.labTestLinkDetail ?? ''));
    const ins = stub.calls.filter((c) => c.table === 'lab_tests' && c.op === 'insert');
    eq('(e) **lab_tests へ insert しない (FK 違反を起こさない)**', ins.length, 0);
    const cap = stub.calls.find((c) => c.table === 'lab_test_id_captures' && c.op === 'insert');
    ok('(e) 台帳には書いている (サイレント脱落ゼロ)', !!cap);
  }

  // (f) **過去の lab_tests が在っても使い回さない**（前年上書きの直接の回帰）
  {
    const stub = makeStub({
      lab_test_id_captures: (st) => st.op === 'insert' ? { data: [{ id: 'cap4' }], error: null } : { data: [], error: null },
      // 前年ぶんが 2 件ある状態。どちらにも触ってはいけない。
      lab_tests: (st) => st.op === 'insert'
        ? { data: [{ id: 'lt-new' }], error: null }
        : { data: [{ id: 'lt-2024' }, { id: 'lt-2025' }], error: null },
      customer_profiles: { data: [{ user_id: 'cust-1' }], error: null },
      lab_companies: { data: [{ id: 'co-1' }], error: null },
      kit_shipments: { data: [], error: null },
    });
    const r = await persist.persistExternalIdCapture({ sb: stub, ...base });
    eq('(f) 今回用の行を作って linked', r.ok && r.record.labTestLinkStatus, 'linked');
    eq('(f) **既存行ではなく新しい行**', r.ok && r.record.labTestId, 'lt-new');
    const upd = stub.calls.filter((c) => c.table === 'lab_tests' && c.op === 'update');
    eq('(f) **既存の lab_tests を update しない**', upd.length, 0);
    // **`test_type` で既存行を探す問い合わせ自体を出していないこと。**
    const byType = stub.calls.filter((c) => c.table === 'lab_tests' && c.filters.test_type !== undefined);
    eq('(f) test_type で lab_tests を引いていない', byType.length, 0);
  }

  // (g) lab_companies が 1 件でない → 決めない
  {
    const stub = makeStub({
      lab_test_id_captures: (st) => st.op === 'insert' ? { data: [{ id: 'cap5' }], error: null } : { data: [], error: null },
      lab_tests: { data: [], error: null },
      customer_profiles: { data: [{ user_id: 'cust-1' }], error: null },
      lab_companies: { data: [], error: null },
      kit_shipments: { data: [], error: null },
    });
    const r = await persist.persistExternalIdCapture({ sb: stub, ...base });
    eq('(g) 検査会社が引けなければ deferred', r.ok && r.record.labTestLinkStatus, 'deferred');
    ok('(g) 理由に lab_companies が入る', /lab_companies/.test((r.ok && r.record.labTestLinkDetail) ?? ''));
  }

  // (h) **既存が「1 件だけ」でも使い回さない** — 前年のプリベント検査がちょうど 1 件、
  //     という最も起こりやすい形。ここを update してしまうのが今回直した穴。
  {
    const stub = makeStub({
      lab_test_id_captures: (st) => st.op === 'insert' ? { data: [{ id: 'cap6' }], error: null } : { data: [], error: null },
      lab_tests: (st) => st.op === 'insert'
        ? { data: [{ id: 'lt-new' }], error: null }
        : { data: [{ id: 'lt-existing' }], error: null },
      customer_profiles: { data: [{ user_id: 'cust-1' }], error: null },
      lab_companies: { data: [{ id: 'co-1' }], error: null },
      kit_shipments: { data: [], error: null },
    });
    const r = await persist.persistExternalIdCapture({ sb: stub, ...base });
    eq('(h) linked になる', r.ok && r.record.labTestLinkStatus, 'linked');
    eq('(h) **既存 1 件を流用しない**', r.ok && r.record.labTestId, 'lt-new');
    const upd = stub.calls.filter((c) => c.table === 'lab_tests' && c.op === 'update');
    eq('(h) **既存行を update しない (前年の外部IDを消さない)**', upd.length, 0);
    const ins = stub.calls.find((c) => c.table === 'lab_tests' && c.op === 'insert');
    ok('(h) 今回用に insert する', !!ins);
    eq('(h) 今回の値を入れる', ins?.values?.external_barcode, '704000123');
  }

  // (h2) **同じ回の撮り直しだけは既存行を使う** — 台帳の lab_test_id が根拠
  {
    const stub = makeStub({
      lab_test_id_captures: (st) => {
        if (st.op === 'insert') return { data: [{ id: 'cap_new' }], error: null };
        if (st.filters.normalized_value) return { data: [], error: null };
        // 同じ (uid, shipment_ref, provider) の有効行が lab_test_id を持っている
        return { data: [{ id: 'cap_prev', normalized_value: '704000999', lab_test_id: 'lt-same' }], error: null };
      },
      lab_tests: (st) => st.op === 'insert' ? { data: [{ id: 'lt-should-not' }], error: null } : { data: [{ id: 'lt-same' }], error: null },
      customer_profiles: { data: [{ user_id: 'cust-1' }], error: null },
      lab_companies: { data: [{ id: 'co-1' }], error: null },
      kit_shipments: { data: [], error: null },
    });
    const r = await persist.persistExternalIdCapture({ sb: stub, ...base });
    eq('(h2) 同じ回なので既存行を使う', r.ok && r.record.labTestId, 'lt-same');
    const ins = stub.calls.filter((c) => c.table === 'lab_tests' && c.op === 'insert');
    eq('(h2) **新しい lab_tests を作らない**', ins.length, 0);
    const upd = stub.calls.find((c) => c.table === 'lab_tests' && c.op === 'update');
    eq('(h2) その行を今回の値で更新する', upd?.values?.external_barcode, '704000123');
    eq('(h2) 更新先は台帳が指していた行', upd?.filters?.id, 'lt-same');
  }

  // (h3) 台帳が指す行が**消えている** → 黙って linked を装わず作り直す
  {
    const stub = makeStub({
      lab_test_id_captures: (st) => {
        if (st.op === 'insert') return { data: [{ id: 'cap_new' }], error: null };
        if (st.filters.normalized_value) return { data: [], error: null };
        return { data: [{ id: 'cap_prev', normalized_value: '704000999', lab_test_id: 'lt-gone' }], error: null };
      },
      lab_tests: (st) => st.op === 'insert' ? { data: [{ id: 'lt-remade' }], error: null } : { data: [], error: null },
      customer_profiles: { data: [{ user_id: 'cust-1' }], error: null },
      lab_companies: { data: [{ id: 'co-1' }], error: null },
      kit_shipments: { data: [], error: null },
    });
    const r = await persist.persistExternalIdCapture({ sb: stub, ...base });
    eq('(h3) 作り直して linked', [r.ok && r.record.labTestLinkStatus, r.ok && r.record.labTestId], ['linked', 'lt-remade']);
    const upd = stub.calls.filter((c) => c.table === 'lab_tests' && c.op === 'update');
    eq('(h3) 消えた行を update しない', upd.length, 0);
  }

  // (i) demecal は external_test_id 側へ入る
  {
    const stub = makeStub({
      lab_test_id_captures: (st) => st.op === 'insert' ? { data: [{ id: 'cap7' }], error: null } : { data: [], error: null },
      lab_tests: (st) => st.op === 'insert' ? { data: [{ id: 'lt-b' }], error: null } : { data: [], error: null },
      customer_profiles: { data: [{ user_id: 'cust-1' }], error: null },
      lab_companies: { data: [{ id: 'co-b' }], error: null },
      kit_shipments: { data: [], error: null },
    });
    const r = await persist.persistExternalIdCapture({
      sb: stub, ...base, provider: 'demecal', testType: 'blood', value: '123456789012345',
    });
    ok('(i) demecal も登録できる', r.ok === true, JSON.stringify(r));
    const ins = stub.calls.find((c) => c.table === 'lab_tests' && c.op === 'insert');
    eq('(i) **external_test_id** へ入れる', ins?.values?.external_test_id, '123456789012345');
    ok('(i) external_barcode は触らない', ins?.values?.external_barcode === undefined);
  }

  // (j) kit_shipments に実在すれば shipment_id を入れる (dev の形)
  {
    const stub = makeStub({
      lab_test_id_captures: (st) => st.op === 'insert' ? { data: [{ id: 'cap8' }], error: null } : { data: [], error: null },
      lab_tests: (st) => st.op === 'insert' ? { data: [{ id: 'lt-new' }], error: null } : { data: [], error: null },
      customer_profiles: { data: [{ user_id: 'cust-1' }], error: null },
      lab_companies: { data: [{ id: 'co-1' }], error: null },
      kit_shipments: { data: [{ id: 'ord_prod_id' }], error: null },
    });
    const r = await persist.persistExternalIdCapture({ sb: stub, ...base });
    ok('(j) 登録できる', r.ok === true);
    const ins = stub.calls.find((c) => c.table === 'lab_tests' && c.op === 'insert');
    eq('(j) 実在するときだけ shipment_id を入れる', ins?.values?.shipment_id, 'ord_prod_id');
  }

  // (k) 台帳が引けない (migration 未適用) → **黙って成功しない**
  {
    const stub = makeStub({
      lab_test_id_captures: { data: null, error: { message: 'relation "customer.lab_test_id_captures" does not exist' } },
      lab_tests: { data: [], error: null },
      customer_profiles: { data: [{ user_id: 'cust-1' }], error: null },
      lab_companies: { data: [{ id: 'co-1' }], error: null },
      kit_shipments: { data: [], error: null },
    });
    const r = await persist.persistExternalIdCapture({ sb: stub, ...base });
    ok('(k) migration 未適用なら失敗を返す', r.ok === false, JSON.stringify(r));
    eq('(k) 503 で返す', !r.ok && r.status, 503);
    const w = stub.calls.filter((c) => c.table === 'lab_tests' && c.op !== 'select');
    eq('(k) lab_tests を触らない', w.length, 0);
  }

  PERSIST = persist; MAKE_STUB = makeStub; BASE = base;
}

// ══════════════════════════════════════════════════════════════════════
// ⑪ API の認可 — 新しい認可を発明せず、既存の 3 段ガードを通す
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑪ API の認可とゲート\n');
{
  const api = code('src/pages/api/kit/[id]/external-id.ts');
  ok('denyReadOnlyWrite を通す (代理表示で書かせない)', /denyReadOnlyWrite\(viewer\)/.test(api));
  ok('denyForShare を通す (共有閲覧から叩かせない)', /denyForShare\(viewer\)/.test(api));
  ok('denyAnonymous を通す (未認証を止める)', /denyAnonymous\(viewer\)/.test(api));
  ok('対象は viewer.writeTargetUid で決める', /viewer\.writeTargetUid/.test(api));
  // **body の uid を認可根拠にしない**
  ok('body から uid / diagnosticUserId を読んでいない',
    !/body\.(diagnosticUserId|uid|diagnostic_user_id)/.test(api));

  // ガードが**モードの分岐より前**にあること（read でも Gemini を回すので同じ扱い）
  const iGuard = api.indexOf('denyAnonymous');
  const iMode = api.indexOf("mode === 'ticket'");
  ok('3 段ガードはモード分岐より前にある', iGuard > 0 && iMode > iGuard);

  // 既定 off のゲートが**API 側にも**在ること（UI だけ隠して API を開けない）
  ok('capture_disabled のゲートが API に在る', /capture_disabled/.test(api));
  const iCap = api.indexOf('captureEnabled(provider)');
  ok('撮影ゲートもモード分岐より前', iCap > 0 && iMode > iCap);
  ok('provider と test_type の整合を検証する', /providerMatchesTestType/.test(api));
  ok('処理の前に refreshConfig を呼ぶ', api.indexOf('refreshConfig') < iMode);

  // app_config の既定が off であること
  const cfgSrc = read('src/lib/app-config.ts');
  for (const k of ['labid.prevent_capture', 'labid.demecal_capture']) {
    const m = new RegExp(`key: '${k.replace('.', '\\.')}'[\\s\\S]{0,400}?default: '([^']*)'`).exec(cfgSrc);
    eq(`${k} の既定は off`, m?.[1], 'off');
  }
  for (const k of ['labid.prevent_pattern', 'labid.demecal_pattern', 'labid.prevent_org_prefix']) {
    ok(`${k} が app_config に在る (env でもコード定数でもない)`, new RegExp(`key: '${k.replace('.', '\\.')}'`).test(cfgSrc));
  }
  /*
   * ── 発行元の接頭辞の配線（発注者指示 2026-10-21）──
   * **既定をクライアントに焼かない。** 焼くと app_config を変えても画面の文言が
   * 追従せず、**「704 で始まります」と言いながら別の接頭辞で判定する**ことになる。
   */
  {
    const prefixDefault = /key: 'labid\.prevent_org_prefix'[\s\S]{0,600}?default: '([^']*)'/.exec(cfgSrc)?.[1];
    eq('app_config の既定は 704', prefixDefault, '704');
    eq('コード既定と app_config の既定が一致する',
      /prevent: '([0-9]*)',/.exec(/DEFAULT_ORG_PREFIX[\s\S]{0,300}?\};/.exec(read('src/lib/external-test-id.ts'))?.[0] ?? '')?.[1],
      prefixDefault);
    ok('API が read / register の両方で接頭辞を渡す',
      (api.match(/orgPrefix: orgPrefixFor\(provider\)/g) ?? []).length === 2);
    ok('接頭辞は app_config から引く (API に焼かない)',
      /cfg\('labid\.prevent_org_prefix'\)/.test(api) && !/'704'/.test(api));
    ok('デメカルには接頭辞を渡さない (この概念を確認していない)',
      /provider === 'prevent' \? cfg\('labid\.prevent_org_prefix'\) : ''/.test(api));
    const scr2 = code('src/scripts/external-id-capture.ts');
    ok('接頭辞が違う回は専用の案内を出す',
      /org_prefix_mismatch'\)\) \{[\s\S]{0,400}showWrong/.test(scr2));
    /*
     * **画面に `704` を焼かない。** 焼くと app_config を変えたときに
     * 「704 で始まります」と言いながら別の接頭辞で判定する。
     * **`'704'` という**リテラルだけを見ても捕まらない**（`'704 で始まります'` を
     * 書かれると素通りする＝実測）。**数字の並びそのもの**を禁じ、
     * かつ**案内の中で `c.orgPrefix` を使っている**ことまで見る。
     */
    ok('画面は**サーバが返した接頭辞**を使う (焼き込まない)',
      /org_prefix/.test(scr2) && !/704/.test(scr2));
    /*
     * **候補は消さない。** 接頭辞が違っても登録はできる（実物の形式が既定と違うことも
     * あり得る）。ここで止めると撮影そのものを失わせる。分岐の中だけを見る。
     */
    const branch = (() => {
      const i = scr2.indexOf("reasons.includes('org_prefix_mismatch')");
      const j = scr2.indexOf('show(c.confirmEl, true);', i);
      return i >= 0 && j > i ? scr2.slice(i, j) : '';
    })();
    ok('案内の文はサーバが返した接頭辞から組み立てる',
      /c\.orgPrefix/.test(branch));
    ok('接頭辞が違っても候補は消さない',
      branch.includes('showWrong') && !/show\(c\.confirmEl, false\)/.test(branch) && !/\breturn\b/.test(branch),
      branch.slice(0, 120));
    ok('read 応答に接頭辞を載せる (画面が具体的に言えるように)',
      /org_prefix: orgPrefixFor\(provider\)/.test(api));
  }
  // **dev seed の誤ったパターンを使っていないこと**（`^K[0-9]{4}$` は 704000123 を弾く）
  const persistSrc = code('src/lib/external-id-persist.ts');
  ok('lab_companies.external_id_pattern を検証に使っていない',
    !/external_id_pattern/.test(persistSrc) && !/external_id_pattern/.test(api));
}

// ══════════════════════════════════════════════════════════════════════
// ⑫ migration の不変条件 — 台帳が anon で読めたら事故
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑫ migration の不変条件\n');
{
  const mig = read('supabase/migrations/20261011000010_lab_test_id_captures.sql');
  ok('RLS を有効にする', /enable row level security/.test(mig));
  ok('force row level security も付ける', /force row level security/.test(mig));
  ok('**anon / authenticated から revoke する**', /revoke all on customer\.lab_test_id_captures from anon, authenticated;/.test(mig));
  ok('service_role にだけ grant する', /grant\s+all on customer\.lab_test_id_captures to service_role;/.test(mig));
  ok('**ポリシーを 1 つも作らない** (dev_read_all を真似しない)', !/create policy/i.test(mig));
  // 本番の形（orders.id）を受けるため shipment_ref に FK を張っていないこと
  ok('shipment_ref に FK を張っていない', !/shipment_ref[^,]*references/i.test(mig));
  ok('shipment_ref は text', /shipment_ref\s+text not null/.test(mig));
  ok('lab_test_id には FK を張る', /lab_test_id\s+uuid references customer\.lab_tests\(id\)/.test(mig));
  ok('二重 submit を止める部分 unique がある',
    /unique index[\s\S]*?ux_lab_test_id_captures_active[\s\S]*?\(diagnostic_user_id, shipment_ref, provider\)[\s\S]*?where status <> 'superseded'/.test(mig));
  // 重複値は**一意制約で弾かない**（conflict として残す）
  ok('normalized_value に unique を張っていない', !/unique[\s\S]{0,80}normalized_value/.test(mig));
  ok('既存テーブルを alter していない (additive のみ)',
    !/alter table customer\.lab_tests/i.test(mig) && !/drop /i.test(mig.replace(/drop index if exists/gi, '')));
  // 証跡は S3 のキーだけ（画像本体を DB に入れない）
  ok('画像本体の列 (bytea) を作っていない', !/bytea/i.test(mig));
  ok('evidence_key は text', /evidence_key\s+text/.test(mig));
}

// ══════════════════════════════════════════════════════════════════════
// ⑬ UI — QR を撮影対象として見せない / PC にカメラを出さない
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑬ UI の契約\n');
{
  const comp = read('src/components/dashboard/ExternalIdCapture.astro');
  ok('QR は読み取らないと書いてある', /QRコード.*読み取りません/.test(comp));
  ok('**QR を撮影対象として案内していない**', !/QR.{0,12}(を撮影|に合わせ|を枠)/.test(comp));
  ok('書面全体を撮るよう案内している', /全体/.test(comp));
  ok('プリベントはユーザーIDと 1次元バーコードを指している',
    /ユーザーID/.test(comp) && /バーコード/.test(comp));
  ok('デメカルは問合せ番号を指している', /問合せ番号/.test(comp));
  /*
   * **カメラはアプリ内で開く（2026-10-13 に方針転換）。**
   * `<input capture>` で OS のカメラアプリを開くと、Android Chrome では端末のカメラが
   * **バーコードを検出して別画面へ持っていき、写真が返ってこなかった**（実機で実測）。
   * バーコードを撮る機能なので、ここは注意書きでは直らない。
   */
  /*
   * **コメントを落としてから見る。** ヘッダに「以前は `capture="environment"` だった」と
   * 経緯を書いてあるので、生のソースで探すと**説明文に当たって落ちる**（実測）。
   * ⑨ と L-17 で踏んだのと同じ型。
   */
  ok('**`capture` 属性を使わない**（OS のカメラを開かない）',
    !/capture="environment"/.test(code('src/components/dashboard/ExternalIdCapture.astro')));
  ok('カメラボタンは touch-only (PC に出さない)',
    /touch-only[\s\S]{0,200}data-extid-camera-open/.test(comp));
  ok('アプリ内カメラの面がある', /data-extid-camera\b/.test(comp)
    && /data-extid-video/.test(comp) && /data-extid-canvas/.test(comp) && /data-extid-shot/.test(comp));
  ok('カメラ面は既定で閉じている', /class="mt-3 hidden" data-extid-camera/.test(comp));
  /*
   * **「写真を選ぶ」は撤去した（発注者指示 2026-10-21）。**
   * ここで見るのは**口が無いこと**＝ markup。**語の有無で見ない** —
   * 撤去した経緯を説明するコメントに「写真を選ぶ」が残るので、
   * 語で見ると戻してしまっても通る（⑨ と L-17 で踏んだのと同じ型）。
   */
  ok('**ファイル選択の口が無い**（画面から入るのはカメラと手入力だけ）',
    !/data-extid-file/.test(code('src/components/dashboard/ExternalIdCapture.astro'))
    && !/type="file"/.test(code('src/components/dashboard/ExternalIdCapture.astro')));
  ok('ファイル選択の `change` 経路も消えている',
    !/data-extid-file/.test(code('src/scripts/external-id-capture.ts')));
  ok('画面から送る captureMethod は camera だけ',
    /captureMethod: 'camera';/.test(code('src/scripts/external-id-capture.ts')));
  /*
   * **サーバは `file` を受け続ける。** 既に台帳に入っている行と DB の check 制約
   * (`20261011000010:50`) があるので、受け口を狭めると過去の行が読めなくなる。
   */
  ok('サーバは `file` も受け続ける（既存の台帳行と DB の check 制約）',
    /v === 'camera' \|\| v === 'file' \|\| v === 'manual'/.test(read('src/pages/api/kit/[id]/external-id.ts')));
  {
    const scr = code('src/scripts/external-id-capture.ts');
    ok('カメラは `/scan` と同じ実装を流用する（写して増やさない）',
      /from '\.\/camera-scan'/.test(scr) && /initCameraScan\(/.test(scr));
    ok('**撮るだけ**の口を使う（ここで解析しない）', /onShot:/.test(scr));
    ok('PC では起動しない（CSS と同じ `(pointer: coarse)` で判定）',
      /matchMedia\?\.\('\(pointer: coarse\)'\)/.test(scr));
    /*
     * **起動の呼び出し元はボタンだけ。** `openCamera` が他から呼ばれると
     * 「画面に出ていないカメラが JS から起動する」ことになる（CLAUDE.md）。
     */
    const callers = [...scr.matchAll(/openCamera\(/g)].length;
    ok('`openCamera` の呼び出しは定義 1 + ボタン 1 だけ', callers === 2, `出現 ${callers} 回`);
    ok('カメラを開く前に端末を判定する',
      /async function openCamera[\s\S]{0,400}cameraAvailable\(\)/.test(scr));
    ok('ページを離れるときに止める', /pagehide[\s\S]{0,300}closeCamera/.test(scr));
    ok('撮ったらカメラを閉じてから読み取りへ回す',
      /closeCamera\(c\);[\s\S]{0,200}captureAndRead\(c, file\)/.test(scr));
    ok('権限拒否は撮り直しへ戻す（手入力へ落とさない）',
      /onError[\s\S]{0,400}もう一度お試しください/.test(scr));
  }
  /*
   * ── 手入力は**経路ごと撤去**（発注者指示 2026-10-21）──
   *
   * **チェックディジットが無い**ので、1 桁の打ち間違いが**正しい形の別の番号**になり、
   * 画面も台帳も `linked` と表示したまま**黙って別の検査に紐づく**。
   * 「行き止まりにしない」(§5.1) は**撮り直し**と**スマートフォンへの導線**で満たす。
   *
   * **ここは静かに戻る** — 入力欄を 1 つ足すだけで画面は「親切」に見える。
   * markup とハンドラの**両方**で口が無いことを見る。
   */
  {
    const scr2 = code('src/scripts/external-id-capture.ts');
    ok('**番号を入力する欄が無い**',
      !/data-extid-input/.test(comp) && !/data-extid-manual\b/.test(comp)
      && !/<input[^>]*inputmode="numeric"/.test(comp));
    ok('**手入力を開く口が無い**', !/data-extid-manual-open/.test(comp) && !/data-extid-manual-open/.test(scr2));
    ok('**番号を直す口が無い**', !/data-extid-edit/.test(comp) && !/data-extid-edit/.test(scr2));
    ok('**手入力で登録する口が無い**',
      !/data-extid-register-manual/.test(comp) && !/data-extid-register-manual/.test(scr2));
    ok('画面の処理に入力欄への参照が残っていない',
      !/inputEl/.test(scr2) && !/manualEl/.test(scr2));
    /*
     * **失敗したときに手入力へ落とさない。** 落とすと、まさに打ち間違いが混ざる場面
     * （カメラが使えない・S3 が落ちた・読み取れない）でだけ誤りを招き入れる。
     */
    ok('S3 が落ちても手入力へ落とさない（撮り直しを促す）',
      !/captureMethod = 'manual'/.test(scr2) && /もう一度撮影してください/.test(scr2));
    ok('カメラの無い端末はスマートフォンへ送る（番号を打たせない）',
      /cameraAvailable\(\)\) \{[\s\S]{0,400}スマートフォン/.test(scr2));
  }
  ok('撮り直しの逃げ道がある', /data-extid-retake/.test(comp));
  ok('確認してから登録する (即確定しない)', /data-extid-register/.test(comp) && /この番号で登録する/.test(comp));

  const script = code('src/scripts/external-id-capture.ts');
  ok('uid を属性で渡していない', !/diagnosticUserId|data-diagnostic-user-id/.test(script));
  ok('二重 submit よけがある', /busy/.test(script));
  ok('登録後は再読込で状態を取り直す', /window\.location\.reload\(\)/.test(script));

  /*
   * PC 導線 (QR)。**ここは静かに壊れる** — QR の URL に文脈が混ざっても、
   * `.pointer-only` が外れてスマホに出ても、画面は「それなり」に見える。
   */
  // **アンカーは markup の class 属性にする。** 冒頭の説明コメントにも
  // `.pointer-only` が出てくるので、ただの出現では「説明が在る」しか見ていない。
  ok('PC 導線は .pointer-only (スマホには出さない)', /class="pointer-only mt-3/.test(comp));
  ok('QR は use で 1 つの symbol を参照する (出荷ごとに展開しない)',
    /<use href=\{`#\$\{qrSymbolId\}`\}/.test(comp));
  ok('QR の 3 点が揃わなければ導線ごと出さない',
    /canHandOff = !!shareUrl && !!qrSymbolId && !!qrSize/.test(comp) && /\{canHandOff && \(/.test(comp));
  ok('URL はサーバ側で value に入れる (JS 無しでも読める)', /readonly[\s\S]{0,80}value=\{shareUrl\}/.test(comp));
  /*
   * **`location.href` で URL を上書きしない。** 上書きすると
   *   ① QR の URL と文字の URL が食い違う
   *   ② 代理表示のパス (`/admin-view/...`) をコピー欄に持ち込む
   * `comp` 側は説明コメントに語が出るので**コメントを落としてから**見る
   * (⑨ で踏んだ「説明文があれば通る」を繰り返さない)。
   */
  const compCode = comp.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  ok('**location.href で URL を上書きしない** (代理表示のパスを持ち込まない)',
    !/location\.href/.test(compCode) && !/location\.href/.test(code('src/scripts/external-id-capture.ts')));
  /*
   * コピーは撮影の状態機械に触らない。**click ハンドラの中で**比べる —
   * ファイル選択の `change` ハンドラにも `ctx(root)` があるので、
   * ファイル全体の最初の出現と比べると**常に false になり検査が無意味**になる (実測)。
   */
  {
    const scr = code('src/scripts/external-id-capture.ts');
    const click = scr.slice(scr.indexOf("document.addEventListener('click'"));
    const iCopy = click.indexOf('data-extid-share-copy');
    const iCtx = click.indexOf('const c = ctx(root);');
    ok('コピーは撮影の状態機械に触らない (ctx より前で返す)', iCopy >= 0 && iCtx > iCopy, `copy=${iCopy} ctx=${iCtx}`);
  }

  /*
   * 用紙の図 (§4.6)。**実物を見ていない provider の図を描かない**のが要点。
   * 描いてしまうと、利用者は「この図のとおりの紙」を探す。
   */
  const fig = read('src/components/dashboard/ExternalIdSheetGuide.astro');
  ok('図を出すのは実物を確認した provider だけ',
    /hasDiagram = provider === 'demecal' \|\| provider === 'prevent'/.test(fig));
  ok('図は provider ごとに分かれている',
    /\{provider === 'demecal' && \(/.test(fig) && /\{provider === 'prevent' && \(/.test(fig));
  ok('プリベントの図は「シール台紙」を描く', /シール台紙/.test(fig));
  /*
   * プリベントの図は **2026-10-21 に白黒で描き直した**（発注者指示「用紙イメージが
   * 実物と違うので、色味も含め実際の用紙に合わせて」）。実物は**白地に黒 1 色の印刷物**で、
   * 淡色の装飾を紙に使うと**手元の紙と図が別物に見える**。
   * brand 色を使ってよいのは**当社の注記（囲みと「↑ ここ」）だけ**＝台紙に無い線。
   * **図は目視では守れない** — 色を戻しても画面は「それなり」に見える。
   */
  const preventFig = (() => {
    const i = fig.indexOf("{provider === 'prevent' && (");
    const j = fig.indexOf('</svg>', i);
    return i >= 0 && j > i ? fig.slice(i, j) : '';
  })();
  ok('プリベントの図を取り出せた', preventFig.length > 500, `${preventFig.length} 文字`);
  ok('プリベントの図は `A…A` の印字をそのまま見せる', /A704000123A/.test(preventFig));
  ok('**紙は白黒**（淡色の装飾を紙に使わない）',
    !/#DCECEF/.test(preventFig) && !/#CBD5E1/.test(preventFig)
    && !/#F8FAFC/.test(preventFig) && !/#102B3A/.test(preventFig));
  ok('インクは黒で描く', (preventFig.match(/#111827/g) ?? []).length >= 10);
  /*
   * ①〜④ は**黒い角丸の吹き出し（白抜きの文字 ＋ 三角のしっぽ）**。
   * 丸囲みの番号ではない（最初そう描いて、実物と配置ごと違うと指摘された）。
   */
  ok('黒い吹き出しが 4 つある（①〜④）',
    (preventFig.match(/rx="9" fill="#111827"/g) ?? []).length === 4);
  ok('吹き出しのしっぽ（三角）が 4 つある',
    (preventFig.match(/<polygon points="[^"]*" fill="#111827" \/>/g) ?? []).length === 4);
  /*
   * **実物に印字されている文言をそのまま写す。** ここが欠けると
   * 「この図のとおりの紙」を探す人が迷う（図の役目は紙の見分け）。
   */
  ok('実物の 4 つの指示文を写している',
    ['① 採尿管に貼り付けてください', '② 採尿管ケースに貼り付けてください',
      '③ 遮光袋に貼り', '④ 返信用封筒の開口部に'].every((w) => preventFig.includes(w)));
  ok('実物の 4 つの枠を写している',
    ['密封シール', '口止めシール', 'ログインして登録してください', 'バーコード']
      .every((w) => preventFig.includes(w)));
  ok('採尿管シールは 3 枚で、2 本目だけ空',
    /\{ y: 70, label: '1本', filled: true \}/.test(preventFig)
    && /\{ y: 107, label: '2本', filled: false \}/.test(preventFig)
    && /\{ y: 136, label: '予備', filled: true \}/.test(preventFig));
  /*
   * **紙の上に当社の文字を置かない。** 書き込みは囲み 2 本と、紙の外の凡例だけ。
   * 置くと「実物に印字されている」と読まれる。色の出現数で固定する
   * （囲み 1 ＋ 凡例の見本 1 ＋ 凡例の文字 1 ＝ 3）。
   */
  ok('**brand 色は当社の書き込みだけ**（囲み・凡例の見本・凡例の文字）',
    (preventFig.match(/#287F86/g) ?? []).length === 3);
  ok('**読み取らない枠の印も当社の書き込みだけ**',
    (preventFig.match(/#A98558/g) ?? []).length === 3);
  ok('QR の模様は**決まった式で置いた飾り**（実物を写していない＝読み取れない）',
    /x \* 7 \+ y \* 13 \+ x \* y/.test(fig));
  /*
   * **パスワードは同じ台紙に印字されている**（§2.1.1）。
   * 「これは読み取りません」と言うために語は出すが、**値は書かない**。
   */
  ok('**パスワードの値を図に書かない**',
    !/パスワード[^<]{0,8}[A-Za-z0-9]{5,}/.test(preventFig));
  ok('**パスワードと QR は読まないと図にも書く**',
    /ここは読み取りません/.test(fig) && /パスワード/.test(fig) && /QR/.test(fig));
  ok('シールを貼る前に撮るよう言っている', /シールを貼る前に撮影/.test(fig));
  ok('図は `hasDiagram` のときだけ描く', /\{hasDiagram && \(/.test(fig));
  ok('**デメカルの図は本物の番号を入れない** (0 の並び)', /000000000000000/.test(fig)
    && !/[0-9]{15}/.test(fig.replace(/0{15}/g, '')));
  /*
   * プリベントは **0 の並びにしない** — 実物が黒 1 色の印刷物なので、
   * 番号だけ伏せ字だと紙に見えない。代わりに**リポジトリ共通のダミー**
   * （ポータルのサンプル CSV・先方宛の依頼文と同じ `704000123`）を使う。
   * **他の番号が混ざったら落とす**（実在の番号を写した疑いになる）。
   */
  ok('**プリベントの図はリポジトリ共通のダミーだけ**',
    /704000123/.test(preventFig)
    && (preventFig.match(/704000[0-9]{3}/g) ?? []).every((v) => v === '704000123'),
    JSON.stringify([...new Set(preventFig.match(/704000[0-9]{3}/g) ?? [])]));
  ok('桁数が分かる', /15桁/.test(fig));
  ok('取り違えやすい数字を名指ししている (電話番号・検査ID欄)',
    /0120/.test(fig) && /検査ID/.test(fig));
  ok('図は撮影ブロックから呼ばれる', /<ExternalIdSheetGuide provider=\{provider\} \/>/.test(comp));

  /*
   * 誤読・読めなかったときの案内。**候補を消さない** (形が違っても登録はできる)。
   */
  ok('誤読の案内の受け皿がある', /data-extid-wrong\b/.test(comp)
    && /data-extid-wrong-title/.test(comp) && /data-extid-wrong-body/.test(comp));
  ok('赤にしない (status-watch = 注意)', /data-extid-wrong[\s\S]{0,120}status-watch|status-watch[\s\S]{0,120}data-extid-wrong/.test(comp));
  {
    const scr = code('src/scripts/external-id-capture.ts');
    ok('形が違うときに案内を出す', /pattern_mismatch'\) \|\| reasons\.includes\('pattern_unknown'\)[\s\S]{0,200}showWrong/.test(scr));
    /*
     * **候補は消さない。** 形が違っても登録はできる (台帳に `review_required` で残る)。
     * ここで止めると撮影そのものを失わせる。
     *
     * **「後ろに `show(confirmEl, true)` がある」では検査にならない** — 分岐の中で
     * 候補を消して `return` しても、その先の行に `true` が残っていて素通りした (実測)。
     * → **分岐の中だけ**を切り出して、消す/抜ける操作が無いことを見る。
     */
    {
      const i = scr.indexOf("if (reasons.includes('pattern_mismatch')");
      const j = scr.indexOf('show(c.confirmEl, true);', i);
      const branch = i >= 0 && j > i ? scr.slice(i, j) : '';
      ok('**候補は消さない** (そのまま登録できる)',
        branch.includes('showWrong')
        && !/show\(c\.confirmEl, false\)/.test(branch)
        && !/\breturn\b/.test(branch),
        branch.slice(0, 160));
    }
    ok('読めなかったときは撮り直しの案内を出す（手入力へ誘導しない）',
      /showWrong\(c, '番号を読み取れませんでした'[\s\S]{0,200}撮り直してください/.test(scr)
      && !/手で入力/.test(scr.slice(scr.indexOf("'番号を読み取れませんでした'"))));
    ok('撮り直し・再読取で前回の案内を消す',
      /clearWrong\(c\);/.test(scr) && (scr.match(/clearWrong\(c\)/g) ?? []).length >= 2);
    /*
     * **「上の図」と言ってよいのは図を持つ provider だけ。**
     * ずれると「上の図」と書いてあるのに図が無い状態になる (文章と UI の食い違いは目視で抜ける)。
     */
    const saysFigure = [...scr.matchAll(/^\s{2}(\w+): '上の図/gm)].map((m) => m[1]).sort();
    /*
     * **両側から取り出して突き合わせる。** 片方を定数で書くと、図を足したときに
     * ここを直し忘れて「検査は緑なのに文面と UI が食い違う」状態になる。
     */
    const hasFigureLine = /const hasDiagram = ([^;]+);/.exec(fig)?.[1] ?? '';
    const hasFigure = [...hasFigureLine.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
    ok('「上の図」と言う provider は図を持つ provider と一致する',
      hasFigure.length > 0 && JSON.stringify(saysFigure) === JSON.stringify(hasFigure),
      `says=${JSON.stringify(saysFigure)} hasFigure=${JSON.stringify(hasFigure)}`);
  }

  /*
   * ── 登録し直す（発注者指示 2026-10-21・仕様 §8.3「再撮影を第一選択」）──
   *
   * **以前は画面に戻る口が無かった。** 一度登録すると登録済みの表示だけになり、
   * 撮り直すには台帳を手で直すしかなかった（API は前から撮り直しに対応している）。
   * **ここは静かに壊れる** — 口が消えても画面は「登録済み」で正常に見えるし、
   * 確認を飛ばしても押せてしまう（押した人は上書きされたことに気づかない）。
   */
  {
    const scr = code('src/scripts/external-id-capture.ts');
    ok('登録済みでも撮影の面を markup として出す（JS で組み立て直さない）',
      /data-extid-done/.test(comp) && /data-extid-form/.test(comp)
      && /class=\{registeredMask \? 'hidden' : ''\} data-extid-form/.test(comp));
    ok('登録し直す口がある', /data-extid-redo-open/.test(comp));
    ok('確認の面がある（はい／やめる）',
      /data-extid-redo-confirm/.test(comp) && /data-extid-redo-yes/.test(comp)
      && /data-extid-redo-no/.test(comp));
    ok('確認は既定で閉じている',
      /class="mt-2 hidden rounded-xl border p-3 status-watch" data-extid-redo-confirm/.test(comp));
    ok('**赤にしない**（誤りではなくやり直せること）',
      /status-watch" data-extid-redo-confirm/.test(comp));
    ok('上書きになることと、前の番号が残ることを伝える',
      /上書き/.test(comp) && /記録として残り/.test(comp));
    /*
     * **「押しただけで撮影の面が開く」に戻さない。** 1 段挟むのが要点なので、
     * `redo-open` の分岐だけを切り出して、面を入れ替える操作が無いことを見る
     * （後ろに `show(c.formEl, true)` があるので、ファイル全体で見ると素通りする）。
     */
    const open = (() => {
      const i = scr.indexOf('data-extid-redo-open]');
      const j = scr.indexOf('data-extid-redo-no]', i);
      return i >= 0 && j > i ? scr.slice(i, j) : '';
    })();
    ok('登録し直すは**確認を出すだけ**（いきなり撮影の面にしない）',
      open.includes('show(c.redoEl, true)')
      && !/show\(c\.formEl, true\)/.test(open) && !/show\(c\.doneEl, false\)/.test(open),
      open.slice(0, 120));
    const yes = (() => {
      const i = scr.indexOf('data-extid-redo-yes]');
      const j = scr.indexOf('data-extid-camera-open]', i);
      return i >= 0 && j > i ? scr.slice(i, j) : '';
    })();
    ok('承諾して初めて面が入れ替わる',
      /show\(c\.doneEl, false\)/.test(yes) && /show\(c\.formEl, true\)/.test(yes));
    ok('前回の証跡を持ち越さない', /c\.evidenceKey = null/.test(yes));
    ok('上書きになることを撮影中も出す', /上書きします/.test(yes));
    /*
     * **撮り直しは API を変えずに成立している。** 台帳は旧行を `superseded` に
     * 落として入れ直す（`external-id-persist.ts`）。ここが「消して入れ直す」に
     * 戻ると、**前の番号が辿れなくなる**（§8.3「修正前後を監査可能にする」）。
     */
    const persist = code('src/lib/external-id-persist.ts');
    ok('旧行は消さずに superseded へ落とす',
      /\.update\(\{ status: 'superseded' \}\)/.test(persist)
      && !/\.delete\(\)/.test(persist));
    ok('前の値を `previous_value` に残す', /previous_value: priorRow \?/.test(persist));
    ok('同じ回の撮り直しは `lab_tests` の行を使い回す',
      /existingLabTestId: priorLabTestId/.test(persist));
  }

  /*
   * **デモの出荷 ID が API の形式検査を通ること。**
   * `self-report.ts:43` / `external-id.ts:50` はどちらも `/^[0-9a-f-]{36}$/i` で見るので、
   * `demo-kit-0002` のような文字列だと **押した瞬間に 400** で止まる（実測 2026-10-13）。
   * 画面は正常に見えるので、ここが戻ると**デモで何も試せない状態に静かに戻る**。
   */
  {
    const demo = read('src/lib/demo-data.ts');
    /*
     * **形式は API のソースから取り出す。** ここに正規表現を書き写すと、
     * API 側だけ変わったときに**検査は緑のままデモが 400 で止まる**。
     */
    const pick = (f) => /!\/(\^\[[^/]+)\/i\.test\(/.exec(read(f))?.[1] ?? null;
    const reSelf = pick('src/pages/api/kit/[id]/self-report.ts');
    const reExt = pick('src/pages/api/kit/[id]/external-id.ts');
    ok('受取 ID の形式検査を 2 つの API から取り出せた', !!reSelf && !!reExt, `${reSelf} / ${reExt}`);
    ok('2 つの API が同じ形式を見ている', reSelf === reExt, `${reSelf} / ${reExt}`);
    const idRe = new RegExp(reSelf ?? '^$', 'i');
    /*
     * **ID は `DEMO_SHIPMENT_IDS` から取る。** fixture 側は定数を参照しているので、
     * そちらを正規表現で拾うと空振りする（一度そうなった）。
     */
    const arr = /export const DEMO_SHIPMENT_IDS: readonly string\[\] = \[([\s\S]*?)\];/.exec(demo)?.[1] ?? '';
    const ids = [...arr.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    ok('デモの出荷が 1 件以上ある', ids.length > 0, JSON.stringify(ids));
    ok('デモの出荷 ID が API の形式検査を通る（通らないと押した瞬間に 400）',
      ids.length > 0 && ids.every((v) => idRe.test(v)),
      JSON.stringify(ids.filter((v) => !idRe.test(v))));
    ok('ID が重複していない', new Set(ids).size === ids.length);
    ok('出荷 ID の定義は 1 か所', /export const DEMO_SHIPMENT_IDS/.test(demo)
      && /id: DEMO_SHIPMENT_IDS\[\d\]/.test(demo));

    /*
     * **デモの出荷は本番の `orders` に無い。**
     * そのまま HP の Edge Function へ渡すと `Order not found` (404) になり、
     * 画面には「申告に失敗しました」と出る（実測 2026-10-13）。
     * デモは記者やパートナーにも見せるので、押すとエラーになるボタンを残さない。
     */
    const sr = code('src/pages/api/kit/[id]/self-report.ts');
    ok('デモの出荷は自己申告で外部へ出さない',
      /demoFallbackEnabled\(diagnosticUserId\) && isDemoShipmentId\(id\)/.test(sr));
    ok('**条件は 2 つとも見る**（uid だけ・ID だけにしない）',
      /demoFallbackEnabled\([^)]*\) && isDemoShipmentId\(/.test(sr));
    {
      const iDemo = sr.indexOf('isDemoShipmentId(id)');
      const iEdge = sr.indexOf('isHpEdgeConfigured()');
      const iSb = sr.indexOf('getServerSupabase()');
      ok('デモの分岐は Edge と DB より前', iDemo >= 0 && iDemo < iEdge && iDemo < iSb,
        `demo=${iDemo} edge=${iEdge} sb=${iSb}`);
    }
    ok('**黙って成功を装わない**（demo を返す）', /ok: true, action, demo: true/.test(sr));
    const srScript = code('src/scripts/kit-self-report.ts');
    ok('デモでは再読込しない（変わらない画面に戻さない）',
      /payload\.demo/.test(srScript)
      && srScript.indexOf('payload.demo') < srScript.indexOf('window.location.reload()'));
    ok('デモでは記録されないと伝える', /記録されません/.test(srScript));
  }

  const kit = code('src/pages/kit.astro');
  ok('/kit が撮影ブロックを出す', /ExternalIdCapture/.test(kit));
  ok('QR は公開 origin で作る (プロキシの内側 URL を符号化しない)', /publicOrigin\(Astro\.request\)/.test(kit));
  ok('**QR は固定パス `/kit`** (クエリや代理表示のパスを入れない)',
    /publicOrigin\(Astro\.request\)\}\/kit`/.test(kit) && !/publicUrl\(/.test(kit));
  ok('QR に uid を入れていない', !/extIdShareUrl[\s\S]{0,120}(uid|\?u=)/.test(kit));
  ok('撮影が両方 off の回は QR を作らない (無駄な計算をしない)',
    /\(captureOn\.prevent \|\| captureOn\.demecal\) \? qrSvgPath/.test(kit));
  ok('symbol はページに 1 つだけ', (kit.match(/<symbol id=\{extIdQrSymbolId\}/g) ?? []).length === 1);
  ok('共有閲覧では出さない', /if \(!canSelfReport\) return null;/.test(kit));
  ok('発送前には出さない', /if \(!s\.shipped_at\) return null;/.test(kit));
  ok('provider は test_type から引く (名前で推測しない)', /providerForTestType\(s\.test_type\)/.test(kit));
  // **全文ではなくマスクを渡す。** 引くのは共通の `loadRegisteredCaptures()` なので、
  // ページ側は `normalized_value` を 1 文字も触らない（触れたら全文が画面へ出る口になる）。
  ok('全文ではなくマスクを渡す (ページは normalized_value を触らない)',
    /loadRegisteredCaptures\(/.test(kit) && !/normalized_value/.test(kit));
  ok('台帳の読み出しは共通関数が持つ (ページで SQL を書かない)',
    !/lab_test_id_captures/.test(kit));
}

// ══════════════════════════════════════════════════════════════════════
// ⑭ 年跨ぎの回帰（発注者指示 2026-10-11）— 「前年を上書きしない」を固定する
//
// プリベントは年 1 回。**ここが壊れると画面も台帳も `linked` と表示したまま
// 前年の `external_barcode` が消える**（＝前年の結果PDF を辿るキーが無くなる）。
// 目視では絶対に気づけないので、5 本とも名指しで落ちるようにしておく。
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑭ 年跨ぎ / ゲートの回帰 (①〜⑤)\n');
{
  const persist = PERSIST;
  const makeStub = MAKE_STUB;
  const base = BASE;

  /** 台帳と lab_tests を**状態として持つ**スタブ（2 年ぶんを順に流すため）。 */
  function makeStatefulStub(seed = {}) {
    const db = {
      lab_test_id_captures: [...(seed.captures ?? [])],
      lab_tests: [...(seed.labTests ?? [])],
      customer_profiles: [{ user_id: 'cust-1', diagnostic_user_id: base.diagnosticUserId }],
      lab_companies: [{ id: 'co-1', test_types: ['cancer_urine', 'blood'] }],
      kit_shipments: [],
    };
    let seq = 0;
    const match = (row, filters) => Object.entries(filters).every(([k, v]) => {
      if (k.startsWith('!')) return row[k.slice(1)] !== v;
      if (Array.isArray(v)) return Array.isArray(row[k]) && v.every((x) => row[k].includes(x));
      return row[k] === v;
    });
    const handler = (st) => {
      const rows = db[st.table] ?? [];
      if (st.op === 'insert') {
        const id = `${st.table}-${++seq}`;
        const row = { id, ...st.values };
        rows.push(row);
        return { data: [{ id }], error: null };
      }
      if (st.op === 'update') {
        const hit = rows.filter((r) => match(r, st.filters));
        for (const r of hit) Object.assign(r, st.values);
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      return { data: rows.filter((r) => match(r, st.filters)), error: null };
    };
    const stub = makeStub({
      lab_test_id_captures: handler, lab_tests: handler,
      customer_profiles: handler, lab_companies: handler, kit_shipments: handler,
    });
    return { stub, db };
  }

  // ── ① 同一人物が 2 年連続プリベント → lab_tests が 2 行・前年を上書きしない ──
  {
    const { stub, db } = makeStatefulStub();
    const y1 = await persist.persistExternalIdCapture({
      sb: stub, ...base, shipmentRef: 'ord_2025', value: '704000111',
    });
    const y2 = await persist.persistExternalIdCapture({
      sb: stub, ...base, shipmentRef: 'ord_2026', value: '704000222',
    });
    ok('① 1 年目が成功する', y1.ok === true, JSON.stringify(y1));
    ok('① 2 年目が成功する', y2.ok === true, JSON.stringify(y2));
    eq('① **lab_tests が 2 行になる**', db.lab_tests.length, 2);
    eq('① 1 年目と 2 年目で lab_test_id が違う',
      y1.ok && y2.ok && y1.record.labTestId !== y2.record.labTestId, true);
    const bars = db.lab_tests.map((r) => r.external_barcode).sort();
    eq('① **前年の external_barcode が残っている**', bars, ['704000111', '704000222']);
    const upd = stub.calls.filter((c) => c.table === 'lab_tests' && c.op === 'update');
    eq('① 既存行への update は 0 件', upd.length, 0);
    eq('① 台帳も 2 行 (前年を superseded にしない)', db.lab_test_id_captures.length, 2);
    eq('① 前年の台帳行は有効なまま',
      db.lab_test_id_captures.filter((r) => r.status !== 'superseded').length, 2);
  }

  // ── ② 前年 confirmed・今年未撮影 → **前年IDを使わずブロック** ──────────
  {
    const { stub } = makeStatefulStub({
      captures: [{
        id: 'cap-2025', diagnostic_user_id: base.diagnosticUserId, shipment_ref: 'ord_2025',
        provider: 'prevent', normalized_value: '704000111', status: 'confirmed',
        lab_test_id: 'lt-2025', lab_test_link_status: 'linked',
      }],
      labTests: [{ id: 'lt-2025', external_barcode: '704000111' }],
    });
    // 今年の回（`ord_2026`）で引く = 前年のレコードは**出てこない**
    const cur = await persist.loadCapturedExternalId({
      sb: stub, diagnosticUserId: base.diagnosticUserId, provider: 'prevent', shipmentRef: 'ord_2026',
    });
    eq('② 今年の回では null (前年を拾わない)', cur, null);
    const gate = core.checkPreventQuestionnaireGate({ capture: cur });
    eq('② **ゲートがブロックする**', [gate.allowed, gate.reason], [false, 'capture_missing']);
    // 前年の回を指せば当然引ける（＝引けないのではなく「今年ではない」を表せている）
    const prev = await persist.loadCapturedExternalId({
      sb: stub, diagnosticUserId: base.diagnosticUserId, provider: 'prevent', shipmentRef: 'ord_2025',
    });
    eq('② 前年の回を指せば引ける', prev?.normalizedValue, '704000111');
    // **「人だけ」で引く呼び出しは通らない**（旧シグネチャの封じ込め）
    const loose = await persist.loadCapturedExternalId({
      sb: stub, diagnosticUserId: base.diagnosticUserId, provider: 'prevent',
    });
    eq('② shipmentRef も labTestId も無ければ引かない', loose, null);
    const persistSrc = read('src/lib/external-id-persist.ts');
    ok('② `captured_at desc limit 1` で最新を拾う実装に戻していない',
      !/order\('captured_at'/.test(persistSrc));
  }

  // ── ③ 今年 review_required → ブロック ────────────────────────────────
  {
    const { stub } = makeStatefulStub({
      captures: [{
        id: 'cap-2026', diagnostic_user_id: base.diagnosticUserId, shipment_ref: 'ord_2026',
        provider: 'prevent', normalized_value: '704000222', status: 'review_required',
        lab_test_id: 'lt-2026', lab_test_link_status: 'linked',
      }],
    });
    const cur = await persist.loadCapturedExternalId({
      sb: stub, diagnosticUserId: base.diagnosticUserId, provider: 'prevent', shipmentRef: 'ord_2026',
    });
    eq('③ レコードは引ける', cur?.status, 'review_required');
    const gate = core.checkPreventQuestionnaireGate({ capture: cur });
    eq('③ **review_required はブロック**', [gate.allowed, gate.reason], [false, 'capture_not_confirmed']);
  }

  // ── ④ 今年 deferred / conflict → ブロック ────────────────────────────
  for (const link of ['deferred', 'conflict']) {
    const { stub } = makeStatefulStub({
      captures: [{
        id: 'cap-2026', diagnostic_user_id: base.diagnosticUserId, shipment_ref: 'ord_2026',
        provider: 'prevent', normalized_value: '704000222',
        // **status だけ confirmed に見える回**でも link で止まることを見る
        status: 'confirmed', lab_test_id: null, lab_test_link_status: link,
      }],
    });
    const cur = await persist.loadCapturedExternalId({
      sb: stub, diagnosticUserId: base.diagnosticUserId, provider: 'prevent', shipmentRef: 'ord_2026',
    });
    eq(`④ ${link} でもレコードは引ける`, cur?.labTestLinkStatus, link);
    eq(`④ lab_test_id は null`, cur?.labTestId, null);
    const gate = core.checkPreventQuestionnaireGate({ capture: cur });
    eq(`④ **${link} はブロック**`, [gate.allowed, gate.reason], [false, 'lab_test_not_linked']);

    // **`lab_test_id` が残っていても通さない。** conflict の回は台帳の
    // `lab_test_id` を消さない（admin の手がかり）ので、ここが `lab_test_id` の
    // 有無だけを見ていると**競合したまま CSV が出る**。
    const withId = core.checkPreventQuestionnaireGate({
      capture: { normalizedValue: '704000222', status: 'confirmed', labTestLinkStatus: link, labTestId: 'lt-2026' },
    });
    eq(`④ ${link} + lab_test_id あり でも **ブロック**`,
      [withId.allowed, withId.reason], [false, 'lab_test_not_linked']);
  }

  // ── ⑤ 同じ shipment の二重 submit → 同じ lab_test_id を維持 ───────────
  {
    const { stub, db } = makeStatefulStub();
    const a = await persist.persistExternalIdCapture({
      sb: stub, ...base, shipmentRef: 'ord_2026', value: '704000222',
    });
    const b = await persist.persistExternalIdCapture({
      sb: stub, ...base, shipmentRef: 'ord_2026', value: '704000222',
    });
    ok('⑤ 2 回とも成功する', a.ok === true && b.ok === true, JSON.stringify([a, b]));
    eq('⑤ **同じ lab_test_id を維持する**', a.ok && b.ok && a.record.labTestId === b.record.labTestId, true);
    eq('⑤ lab_tests は 1 行のまま', db.lab_tests.length, 1);
    eq('⑤ 台帳も 1 行のまま', db.lab_test_id_captures.length, 1);
    eq('⑤ ゲートを通る', core.checkPreventQuestionnaireGate({
      capture: await persist.loadCapturedExternalId({
        sb: stub, diagnosticUserId: base.diagnosticUserId, provider: 'prevent', shipmentRef: 'ord_2026',
      }),
    }).allowed, true);

    // 撮り直し（値が変わる）でも**同じ行**を使い続ける
    const c = await persist.persistExternalIdCapture({
      sb: stub, ...base, shipmentRef: 'ord_2026', value: '704000333',
    });
    ok('⑤ 撮り直しも成功する', c.ok === true, JSON.stringify(c));
    eq('⑤ 撮り直しでも lab_test_id は同じ', c.ok && c.record.labTestId === (a.ok && a.record.labTestId), true);
    eq('⑤ 撮り直し後も lab_tests は 1 行', db.lab_tests.length, 1);
    eq('⑤ lab_tests の値が今回のものに更新される', db.lab_tests[0].external_barcode, '704000333');
    eq('⑤ 旧台帳行は superseded', db.lab_test_id_captures.filter((r) => r.status === 'superseded').length, 1);
    eq('⑤ 有効な台帳行は 1 件', db.lab_test_id_captures.filter((r) => r.status !== 'superseded').length, 1);
  }
}

// ══════════════════════════════════════════════════════════════════════
// ⑮ 手順書がコードと同期しているか
//
// `docs/operations/外部検査ID_読み取り精度テスト手順書.md` は**生成物**。
// プロンプトやスキーマを直したのに書き出し直さないと、**古い手順書で精度を測る**ことになる
// （しかも見た目は正しいので誰も気づかない）。`verify:sheet-contract` と同じ流儀で、
// **組み立てる関数そのものを呼んで**突き合わせる（書き出しの規則を 2 つに割らない）。
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑮ 手順書の同期\n');
{
  const { buildDoc, DOC_PATH } = await import('./lib/external-id-prompt-doc.mjs');
  let cur = null;
  try { cur = read(DOC_PATH); } catch { cur = null; }
  const next = await buildDoc();
  ok('手順書が存在する', cur !== null, DOC_PATH);
  ok('手順書がコードと一致する（古かったら npm run dump:external-id-prompt）',
    cur === next,
    cur === null ? '未生成' : `差分 ${Math.abs(cur.length - next.length)} 文字`);
  // **プロンプトの本文が実際に載っていること**（器だけ生成されても意味がない）
  const rdSrc = read('src/lib/external-id-read.ts');
  const firstLine = /prevent: \[\n\s*'([^']+)'/.exec(rdSrc)?.[1] ?? '';
  ok('プリベントの system プロンプトが手順書に載っている',
    firstLine.length > 0 && (cur ?? '').includes(firstLine), firstLine.slice(0, 40));
  ok('**実物の写真を入れないと書いてある**', (cur ?? '').includes('リポジトリに入れない'));
}

// ══════════════════════════════════════════════════════════════════════
// ⑯ 7 日ワーニング — 撮り忘れの催促 (仕様 §7.1・発注者指示 2026-10-21)
//
// 【ここは静かに壊れる】催促は**出なくてもエラーにならない**。
// 出ないまま検体だけが検査会社に届き、問診データを渡せないので検査が始まらない
// （しかも画面は正常に見える）。逆に**撮った人を催促し続ける**のも静かな壊れ方。
//
// 判定は純関数なので**実物を動かして**測る。画面側は「同じ関数を使っているか」と
// 「押す先があるか」を見る。
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑯ 7 日ワーニング (barcodeReminders)\n');
{
  const rem = await load('src/lib/external-id-reminder.ts', [
    [/import \{ PROVIDER_TEST_TYPE \} from '\.\/external-test-id';/, "const PROVIDER_TEST_TYPE = { prevent: 'cancer_urine', demecal: 'blood' };"],
  ]);
  const { barcodeReminders, daysBetweenJst, BARCODE_REMINDER_DAYS, REMINDER_TEST_TYPE } = rem;
  const NOW = new Date('2026-10-21T01:00:00Z');   // JST 2026-10-21 10:00
  const ship = (over) => ({ id: 'ord_1', test_type: 'cancer_urine', shipped_at: '2026-10-10', ...over });
  const run = (over = {}) => barcodeReminders({
    shipments: [ship(over.ship ?? {})], registered: new Set(over.registered ?? []),
    captureEnabled: over.captureEnabled ?? true, now: over.now ?? NOW,
  });

  eq('閾値は 7 日', BARCODE_REMINDER_DAYS, 7);
  eq('対象はがんリスク (プリベント) だけ', REMINDER_TEST_TYPE, 'cancer_urine');

  // 暦日で数える（時刻の端数で 1 日ずれない）
  eq('暦日の差', daysBetweenJst('2026-10-10', '2026-10-17T14:59:00Z'), 7);   // JST 10-17 23:59
  eq('JST で日を切る (UTC 15:00 = JST 翌日 0:00)', daysBetweenJst('2026-10-10', '2026-10-16T15:00:00Z'), 7);
  eq('読めない日付は null', daysBetweenJst('なんだこれ', NOW), null);

  eq('11 日たっていれば催促する', run().length, 1);
  eq('経過日数は実測値 (丸めない)', run()[0]?.days, 11);
  eq('ちょうど 7 日で催促する', run({ now: new Date('2026-10-17T03:00:00Z') }).length, 1);
  eq('6 日では催促しない', run({ now: new Date('2026-10-16T03:00:00Z') }).length, 0);
  eq('**撮影が off のときは 1 件も返さない** (行き先が無い)', run({ captureEnabled: false }).length, 0);
  eq('発送前 (shipped_at なし) は催促しない', run({ ship: { shipped_at: null } }).length, 0);
  eq('**登録済みの人を急かさない**', run({ registered: ['ord_1'] }).length, 0);
  eq('別の検査 (血液) は対象外', run({ ship: { test_type: 'blood' } }).length, 0);
  eq('読めない発送日は催促しない (当てずっぽうで日数を作らない)',
    run({ ship: { shipped_at: 'いつか' } }).length, 0);
  eq('複数の出荷でもそれぞれ返す', barcodeReminders({
    shipments: [ship({ id: 'a' }), ship({ id: 'b' }), ship({ id: 'c', shipped_at: '2026-10-20' })],
    registered: new Set(['b']), captureEnabled: true, now: NOW,
  }).map((r) => r.shipmentId), ['a']);

  // ── 「登録済み」の判定を問診CSV のゲートと混ぜない ──
  // ここは `status <> 'superseded'` で見る（撮った人を急かさないため）。
  // ゲート (`checkPreventQuestionnaireGate`) は `confirmed` ∧ `linked` を要求する fail-closed。
  // 片方をもう片方の代わりに使うと「確定していない番号で先方へ出す」か
  // 「撮った人を催促し続ける」のどちらかになる。
  const persistSrc = code('src/lib/external-id-persist.ts');
  const loader = /export async function loadRegisteredCaptures[\s\S]*?\n\}/.exec(persistSrc)?.[0] ?? '';
  ok('`loadRegisteredCaptures` が在る', loader.length > 0);
  ok('superseded でない行を引く', /\.neq\('status', 'superseded'\)/.test(loader));
  ok('**confirmed を条件にしない** (撮った人を急かさない)', !/'confirmed'\s*\)/.test(loader.replace(/!==\s*'confirmed'/g, '')));
  // **`mask:` に入る値が `maskExternalId()` を通っていること**を見る。
  // 「どこかに maskExternalId がある」では足りない（別の行で呼んでいても通ってしまう）。
  const setBlock = /out\.set\(([\s\S]*?)\n\s*\}\);/.exec(loader)?.[1] ?? '';
  const maskLine = /\bmask:\s*([^\n]*)/.exec(setBlock)?.[1] ?? '';
  ok('マスクだけを返す (全文を返さない)',
    /^maskExternalId\(/.test(maskLine.trim()) && !/normalized_value:/.test(loader),
    maskLine.trim().slice(0, 60));
  ok('その人の行だけを引く', /\.eq\('diagnostic_user_id', diagnosticUserId\)/.test(loader));

  // ── 画面側 ──
  const remUi = code('src/components/dashboard/ExternalIdReminder.astro');
  ok('器は判定を持たない (日数・閾値・登録済みを自分で判断しない)',
    !/shipped_at|registered|captureEnabled|BARCODE_REMINDER_DAYS/.test(remUi));
  ok('**行き先が無いものは描かない** (押しても何も起きない帯を出さない)',
    /hrefFor\(r\.shipmentId\)/.test(remUi) && /\.filter\(/.test(remUi));
  ok('赤にしない (status-watch)', /status-watch/.test(remUi) && !/status-(?:alert|danger|error)/.test(remUi));
  ok('呼び名は共通の定義から受け取る (画面で焼かない)',
    /idLabel/.test(remUi) && !/バーコードNo\./.test(remUi));
  ok('撮影へ促す文言が在る', /撮影/.test(remUi));

  const cap = code('src/components/dashboard/ExternalIdCapture.astro');
  ok('撮影ブロックに飛び先の id が在る', /id=\{`extid-\$\{shipmentId\}`\}/.test(cap));
  ok('呼び名の定義は 1 か所 (external-test-id.ts)',
    /PROVIDER_ID_LABEL\[provider\]/.test(cap) && /PROVIDER_ID_LABEL: Record/.test(code('src/lib/external-test-id.ts')));

  for (const [page, label] of [['src/pages/kit.astro', '/kit'], ['src/pages/dashboard.astro', 'ダッシュボード']]) {
    const src = code(page);
    ok(`${label} が同じ判定関数を使う`, /barcodeReminders\(/.test(src));
    ok(`${label} が条件を書き直していない`, !/BARCODE_REMINDER_DAYS|>=\s*7|7\s*\*\s*86400/.test(src));
    ok(`${label} は共有閲覧で催促しない`, /canSelfReport|viewer\.kind !== 'share'/.test(src));
    ok(`${label} の飛び先は該当の撮影ブロック (ページ先頭へ送らない)`, /#extid-\$\{id\}/.test(src));
  }
  // ダッシュボードは撮影が on のときだけ台帳を引く（off の回に無駄な問い合わせを出さない）
  const dash = code('src/pages/dashboard.astro');
  // **`if` の条件そのものに `barcodeCaptureOn` と共有閲覧の除外が在ること**を見る。
  // 「近くに変数名がある」では足りない（宣言だけ残して条件から外す退行が素通りする・実測）。
  const dashGuard = /if \(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*\{\s*\n\s*const sb = getServerSupabase\(\);/.exec(dash)?.[1] ?? '';
  ok('ダッシュボードは撮影が off なら台帳を引かない',
    /cfgBool\('labid\.prevent_capture'\)/.test(dash) && /barcodeCaptureOn/.test(dashGuard),
    `guard = ${dashGuard || '(見つからない)'}`);
  ok('ダッシュボードは共有閲覧で台帳を引かない', /viewer\.kind !== 'share'/.test(dashGuard),
    `guard = ${dashGuard || '(見つからない)'}`);
  ok('ダッシュボードでも全文を触らない', !/normalized_value/.test(dash));
}

// ══════════════════════════════════════════════════════════════════════
// ⑰ 読み取り結果をサーバ側に控える (§12.2 の案 (c)・発注者指示 2026-10-22)
//
// 【この穴は検査が緑のまま通った】③ は `evaluateExternalId` を barcode / ocr で
// **直接**呼んでおり、**画面が実際に送る payload を 1 度も通していなかった**。
// そのため「register は必ず `manual_entry` になり問診CSV へ 1 件も出ない」を
// 435 件の検査が見逃した。→ ここでは
//   ①控えの往復を**実物で回す** (S3 はメモリへ差し替え・鍵の検証は実物)
//   ②API が**画面から値を採らない**こと
//   ③画面が**値を送らない**こと
//   ④**画面が送る形で `confirmed` になり、ゲートが通る**こと (= 旧実装では通らなかった)
// を見る。
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑰ 読み取り結果の控え (§12.2 の案 (c))\n');
{
  // ── メモリの S3。**鍵の検証は実物の `isEvidenceKey`** を使う ──
  const S3CFG = { prefix: 'scan-accuracy-test/', bucket: 'b', region: 'r' };
  const evMod = await load('src/lib/external-id-evidence.ts', [
    [/^import \{ PutObjectCommand[\s\S]*?from '@aws-sdk\/client-s3';$/m, ''],
    [/^import \{ getSignedUrl \}[\s\S]*?from '@aws-sdk\/s3-request-presigner';$/m, ''],
    [/^import \{ getS3Config[\s\S]*?from '\.\/s3';$/m, ''],
  ]);
  globalThis.__isEvidenceKey = evMod.isEvidenceKey;

  let BUCKET = new Map();
  let failPut = false;
  globalThis.__cfg = S3CFG;
  globalThis.__s3 = {
    send: async (cmd) => {
      if (cmd.kind === 'put') {
        if (failPut) throw new Error('s3 down');
        BUCKET.set(cmd.input.Key, String(cmd.input.Body));
        return {};
      }
      if (!BUCKET.has(cmd.input.Key)) throw new Error('NoSuchKey');
      const text = BUCKET.get(cmd.input.Key);
      return { Body: { transformToString: async () => text } };
    },
  };

  const cache = await load('src/lib/external-id-read-cache.ts', [
    [/^import \{ PutObjectCommand, GetObjectCommand \} from '@aws-sdk\/client-s3';$/m,
      'class PutObjectCommand { constructor(i) { this.input = i; this.kind = "put"; } }\n'
      + 'class GetObjectCommand { constructor(i) { this.input = i; this.kind = "get"; } }'],
    [/^import \{ getS3Config, makeS3Client \} from '\.\/s3';$/m,
      'const getS3Config = () => globalThis.__cfg;\nconst makeS3Client = () => globalThis.__s3;'],
    [/^import \{ isEvidenceKey \} from '\.\/external-id-evidence';$/m,
      'const isEvidenceKey = (k, c) => globalThis.__isEvidenceKey(k, c);'],
  ]);

  const KEY = 'scan-accuracy-test/kit-id-captures/2026/10/22/11111111-2222-3333-4444-555555555555.jpg';
  const BIND = { diagnosticUserId: 'u-1', shipmentRef: 's-1', provider: 'prevent' };
  const keep = (over = {}) => cache.rememberRead({
    evidenceKey: KEY, ...BIND, barcode: '704000123', printed: '704000123', ...over,
  });
  const recall = (over = {}) => cache.recallRead({ evidenceKey: KEY, ...BIND, ...over });

  // ── 控えのキー。**ブラウザからは触れない形**であること ──
  eq('控えは証跡キーの隣に置く', cache.readCacheKey(KEY), `${KEY}.read.json`);
  ok('**控えのキーは証跡キーとして通らない** (ブラウザは PUT も読み出しもできない)',
    !evMod.isEvidenceKey(cache.readCacheKey(KEY), S3CFG));

  // ── 往復 ──
  BUCKET = new Map();
  eq('控えられる', (await keep()).ok, true);
  {
    const r = await recall();
    ok('引ける', r.ok === true, JSON.stringify(r));
    eq('バーコードの生値が戻る', r.ok && r.read.barcode, '704000123');
    eq('印字の生値が戻る', r.ok && r.read.printed, '704000123');
  }
  // **判定は控えない** (`labid.*` を直したあとに古い判定が貼り付かないこと)
  {
    const raw = BUCKET.get(cache.readCacheKey(KEY)) ?? '';
    ok('控えに判定 (status / reasons) を入れない', !/status|reason|confirmed|review_required/.test(raw), raw);
    ok('控えは結び付きを持つ (uid / 受取 / 検査)',
      /"uid"/.test(raw) && /"shipment_ref"/.test(raw) && /"provider"/.test(raw));
  }

  // ── 結び付きが 1 つでも違えば通さない ──
  eq('**別人の控えは使えない**', (await recall({ diagnosticUserId: 'u-2' })).error, 'read_result_mismatch');
  eq('**別の受取の控えは使えない**', (await recall({ shipmentRef: 's-2' })).error, 'read_result_mismatch');
  eq('**別の検査の控えは使えない**', (await recall({ provider: 'demecal' })).error, 'read_result_mismatch');
  eq('食い違いは 409', (await recall({ diagnosticUserId: 'u-2' })).status, 409);

  // ── 期限 ──
  const past = new Date(Date.now() + cache.READ_CACHE_TTL_MS + 60_000);
  eq('期限を過ぎたら通さない', (await recall({ now: past })).error, 'read_result_expired');
  eq('期限内は通る', (await recall({ now: new Date() })).ok, true);
  {
    // **未来日時の控えを無期限にしない** (時計のずれ・改ざんで永久に有効化しない)
    BUCKET.set(cache.readCacheKey(KEY), JSON.stringify({
      v: 1, uid: 'u-1', shipment_ref: 's-1', provider: 'prevent',
      barcode: '704000123', printed: '704000123',
      read_at: new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString(),
    }));
    eq('遠い未来の控えも通さない', (await recall()).error, 'read_result_expired');
    BUCKET.set(cache.readCacheKey(KEY), JSON.stringify({
      v: 1, uid: 'u-1', shipment_ref: 's-1', provider: 'prevent',
      barcode: '704000123', printed: '704000123', read_at: 'いつか',
    }));
    eq('読めない日時も通さない (無期限にしない)', (await recall()).error, 'read_result_expired');
  }

  // ── 無い / 壊れている / 鍵が違う ──
  BUCKET = new Map();
  eq('控えが無ければ 409 で止める (fail-closed)', (await recall()).error, 'read_result_missing');
  BUCKET.set(cache.readCacheKey(KEY), '{壊れた');
  eq('壊れた控えも通さない', (await recall()).error, 'read_result_unreadable');
  BUCKET.set(cache.readCacheKey(KEY), JSON.stringify({ v: 2, uid: 'u-1' }));
  eq('知らない版の控えは通さない', (await recall()).error, 'read_result_unreadable');

  const JSONKEY = 'scan-accuracy-test/user/d0000001/date/2026_10_22/HealthCheckupData_x.json';
  eq('**納品 JSON のキーでは引けない**', (await cache.recallRead({ evidenceKey: JSONKEY, ...BIND })).error, 'invalid_key');
  {
    BUCKET = new Map();
    const w = await cache.rememberRead({ evidenceKey: JSONKEY, ...BIND, barcode: '1', printed: '1' });
    eq('**納品 JSON のキーへは控えない**', w.ok, false);
    eq('書き込みも起きない', BUCKET.size, 0);
  }

  // ── 控えられなかったことを飲み込まない ──
  BUCKET = new Map(); failPut = true;
  {
    // **例外で抜けない**こと自体を見る（throw にすると `read` が 500 になり、
    // 「撮り直してください」の案内まで届かない）。
    let w = null; let threw = false;
    try { w = await keep(); } catch { threw = true; }
    ok('S3 が落ちても throw しない', !threw);
    eq('ok:false を返す', threw ? null : w.ok, false);
    eq('理由が分かる', threw ? null : w.error, 'read_cache_write_failed');
  }
  failPut = false;

  // ── ④ **画面が送る形で confirmed になる** (旧実装では必ず review_required) ──
  {
    const fromCache = core.evaluateExternalId({
      provider: 'prevent', barcode: '704000123', ocr: '704000123',
      expectedPattern: '^704000[0-9]{3}$', orgPrefix: '704',
    });
    eq('控えから評価すると confirmed', fromCache.status, 'confirmed');
    eq('decode は barcode+ocr', fromCache.decodeMethod, 'barcode+ocr');
    const gate = core.checkPreventQuestionnaireGate({
      capture: {
        normalizedValue: fromCache.value, status: fromCache.status,
        labTestLinkStatus: 'linked', labTestId: 'lt-1',
      },
      expectedPattern: '^704000[0-9]{3}$', orgPrefix: '704',
    });
    eq('**問診CSV のゲートが通る**', [gate.allowed, gate.reason], [true, 'ok']);

    // 旧実装 (画面が候補を `manual` で送り返す) は**必ず**ここで止まっていた
    const asManual = core.evaluateExternalId({
      provider: 'prevent', manual: '704000123',
      expectedPattern: '^704000[0-9]{3}$', orgPrefix: '704',
    });
    eq('旧実装の payload は review_required', asManual.status, 'review_required');
    eq('理由は manual_entry', asManual.reasons, ['manual_entry']);
    eq('旧実装ではゲートが全件ブロックした', core.checkPreventQuestionnaireGate({
      capture: {
        normalizedValue: asManual.value, status: asManual.status,
        labTestLinkStatus: 'linked', labTestId: 'lt-1',
      },
      expectedPattern: '^704000[0-9]{3}$', orgPrefix: '704',
    }).reason, 'capture_not_confirmed');
  }

  // ── ② API: register は画面から値を採らない ──
  const api = code('src/pages/api/kit/[id]/external-id.ts');
  const regBlock = (() => {
    const i = api.indexOf("if (mode === 'register')");
    return i >= 0 ? api.slice(i) : '';
  })();
  const readBlock = (() => {
    const i = api.indexOf("if (mode === 'read')");
    const j = api.indexOf("if (mode === 'register')", i);
    return i >= 0 && j > i ? api.slice(i, j) : '';
  })();
  ok('register ブロックが在る', regBlock.length > 0);
  ok('**控えを引いてから登録する**', /recallRead\(/.test(regBlock));
  ok('引くときに結び付きを渡す',
    /diagnosticUserId: uid/.test(regBlock) && /shipmentRef,/.test(regBlock) && /provider,/.test(regBlock));
  // **評価の入力が控えだけ**であること。`manual:` が復活したらここで落ちる。
  const regEval = (() => {
    const i = regBlock.indexOf('evaluateExternalId({');
    const j = regBlock.indexOf('});', i);
    return i >= 0 && j > i ? regBlock.slice(i, j) : '';
  })();
  ok('評価の入力は控えた生値', /barcode: recalled\.read\.barcode/.test(regEval) && /ocr: recalled\.read\.printed/.test(regEval), regEval);
  ok('**評価に manual を渡さない**', !/manual:/.test(regEval), regEval);
  ok('**body の値を評価へ渡さない**', !/barcode: body\.|ocr: body\.|manual: body\./.test(regBlock));
  // **黙って無視せず落とす** (将来クライアントが送り始めたら見えるように)
  ok('body が値を持ってきたら 400 で落とす',
    /body\.barcode != null \|\| body\.printed != null \|\| body\.manual != null/.test(regBlock)
    && /client_supplied_value/.test(regBlock));
  {
    const guard = regBlock.indexOf('client_supplied_value');
    const persist = regBlock.indexOf('persistExternalIdCapture(');
    const rc = regBlock.indexOf('recallRead(');
    ok('その 400 は控えを引くより前・保存より前', guard > 0 && guard < rc && guard < persist);
  }
  ok('画面に出ていた値は突き合わせだけに使う (値の出どころにしない)',
    /confirmation_mismatch/.test(regBlock) && !/manual: body\.confirmedValue/.test(regBlock));

  // ── ② API: read は控えてから候補を返す ──
  ok('read が控える', /rememberRead\(/.test(readBlock));
  {
    const kept = readBlock.indexOf('rememberRead(');
    const ret = readBlock.indexOf('candidate: ev.value');
    ok('**控えてから候補を返す** (控えられない回を確認画面へ進めない)', kept > 0 && ret > kept);
    ok('控えに失敗したら候補を返さない', /if \(!kept\.ok\)[\s\S]{0,400}?503/.test(readBlock));
  }
  ok('read は DB を書かない (従来どおり)', !/persistExternalIdCapture\(/.test(readBlock));
  // 手入力は経路ごと撤去済み (§4.4.2) — サーバの案内文もそれに合わせる
  ok('read の案内が手入力へ誘導しない', !/手で入力/.test(readBlock));

  // ── ③ 画面: 値を送らない ──
  const scr = code('src/scripts/external-id-capture.ts');
  const regPost = (() => {
    const i = scr.indexOf("mode: 'register'");
    const j = scr.indexOf('});', i);
    return i >= 0 && j > i ? scr.slice(i, j) : '';
  })();
  ok('register の payload が在る', regPost.length > 0);
  ok('**番号を送らない** (manual / barcode / printed を載せない)',
    !/manual:/.test(regPost) && !/barcode:/.test(regPost) && !/printed:/.test(regPost), regPost);
  ok('どの証跡かだけを送る', /evidenceKey: c\.evidenceKey/.test(regPost));
  ok('画面の値は突き合わせ用に送る', /confirmedValue: value/.test(regPost));
  ok('**読み取りの生値を画面に持たない**', !/read: \{ barcode/.test(scr));
}

// ══════════════════════════════════════════════════════════════════════
// ⑱ 読み取りの待ち時間 (発注者指摘「撮影から表示まで 30 秒近く」・2026-10-22)
//
// 【要点】`thinkingBudget: 0` は 3.x で**思考オフにならない** —
// `gemini.ts` の `thinkingBudgetToLevel` が 0 を `'low'` に写すので、
// 既定の `gemini-3.1-flash-lite` は**毎回 low で考えていた**。
// しかも**思考トークンは `maxOutputTokens` に含まれる**ので、512 だと
// 切れて `unparsable` → 撮り直し = 待ち時間が 2 倍になる
// (`voice-choice-llm.ts` が同じ罠で実障害を出している)。
// ここでは
//   ①読み取りが `thinkingLevel: 'minimal'` を**明示**していること
//   ②`thinkingBudgetToLevel` は**触っていない**こと (スキャン本経路と共用)
//   ③`minimal` を受けないモデルでも**読めること** (400 のときだけ外して 1 回)
//   ④区間ごとの実測が応答に乗り、**PII を含まない**こと
//   ⑤画面が待ちの経過を出し、**どの出口でも止める**こと
// を見る。
// ══════════════════════════════════════════════════════════════════════
console.log('\n⑱ 読み取りの待ち時間 (thinking / 実測)\n');
{
  const rd = code('src/lib/external-id-read.ts');
  const gm = code('src/lib/gemini.ts');
  const api = code('src/pages/api/kit/[id]/external-id.ts');
  const scr = code('src/scripts/external-id-capture.ts');

  // ── ① 思考は最小を明示する ──
  ok('`thinkingLevel: \'minimal\'` を明示している',
    /thinkingConfig: \{ thinkingLevel: 'minimal' \}/.test(rd), rd.slice(0, 0));
  ok('**`thinkingBudget` に戻っていない** (3.x で 0 は low になる)',
    !/thinkingBudget/.test(rd));
  {
    const m = rd.match(/maxOutputTokens: (\d+)/);
    ok('maxOutputTokens が在る', !!m);
    ok('**思考ぶんの余裕がある** (>=1024・切れると撮り直しで待ちが 2 倍)',
      !!m && Number(m[1]) >= 1024, m ? m[1] : '');
  }

  // ── ② 共用の写像は触らない ──
  ok('`thinkingBudgetToLevel` の戻り値は low|high のまま (スキャン本経路と共用)',
    /function thinkingBudgetToLevel\(budget\?: number\): 'low' \| 'high'/.test(gm));
  ok('`thinkingBudgetToLevel` の中身を変えていない',
    /budget != null && budget > 8192 \? 'high' : 'low'/.test(gm));
  ok('明示した `thinkingLevel` が写像より優先される (この 1 行で済む根拠)',
    /if \(thinkingConfig\?\.thinkingLevel\) \{\s*out\.thinkingConfig = \{ thinkingLevel: thinkingConfig\.thinkingLevel \};/.test(gm));
  ok('型が `minimal` を受ける', /thinkingLevel\?: 'minimal' \| 'low' \| 'medium' \| 'high'/.test(gm));

  // ── ③ 受け付けないモデルでも読める ──
  ok('400 のときだけ thinking を外してやり直す関数が在る',
    /async function callWithMinimalThinking\(/.test(rd));
  ok('読み取りはその関数を通る', /await callWithMinimalThinking\(input\.apiKey, req\)/.test(rd));
  {
    const i = rd.indexOf('async function callWithMinimalThinking(');
    const fb = i >= 0 ? rd.slice(i, i + 900) : '';
    ok('**400 以外は再試行しない** (503 は callGemini の仕事)',
      /e\.status === 400/.test(fb), fb);
    ok('やり直しでは `thinkingConfig` を外す',
      /thinkingConfig: _unsupported, \.\.\.rest/.test(fb));
    ok('やり直しは 1 回だけ (入れ子で呼ばない)',
      (fb.match(/callGemini\(/g) || []).length === 2, fb);
  }

  // ── ④ 区間ごとの実測。PII を載せない ──
  {
    const i = api.indexOf("if (mode === 'read')");
    const j = api.indexOf("if (mode === 'register')");
    const rb = i >= 0 && j > i ? api.slice(i, j) : '';
    ok('read ブロックが在る', rb.length > 0);
    ok('S3 の取得を実測する', /const s3Ms = Date\.now\(\) - tRead0;/.test(rb));
    ok('控えの保存を実測する', /const cacheMs = Date\.now\(\) - tCache0;/.test(rb));
    ok('推論の実測は読み取り側から受け取る', /gemini_ms: read\.geminiMs/.test(rb));
    const i2 = rb.indexOf('timing: {');
    const tb = i2 >= 0 ? rb.slice(i2, rb.indexOf('},', i2)) : '';
    ok('応答に `timing` が在る', tb.length > 0);
    {
      /*
       * **省略記法 (`uid,`) も鍵として数える。** `/\w+:/` だけで見ていたら
       * `timing: { uid, s3_ms: ... }` という退行を注入しても**素通りした**
       * (コロンが無いので鍵に見えない)。PII が 1 つ混ざれば終わりなので、
       * 「行に出てくる識別子」を全部拾う。
       */
      const keys = (tb.match(/^\s*(\w+)\s*[:,]/gm) || [])
        .map((k) => k.trim().replace(/[:,]$/, ''));
      const allowed = new Set(['timing', 's3_ms', 'gemini_ms', 'cache_ms', 'total_ms', 'bytes']);
      const extra = keys.filter((k) => !allowed.has(k));
      ok('**ms とバイト数だけ** (番号・鍵・uid を載せない)', extra.length === 0, extra.join(','));
    }
    ok('読み取り側が推論時間を返す (成功)', /return \{ ok: true, \.\.\.parsed, geminiMs \};/.test(rd));
    ok('読み取り側が推論時間を返す (失敗も・遅い回の切り分けに要る)',
      /error: 'gemini_failed',[\s\S]{0,200}?geminiMs: Date\.now\(\) - t0,/.test(rd));
  }

  // ── ⑤ 画面: 経過を出し、どの出口でも止める ──
  ok('待ちの経過を出す関数が在る', /function waiting\(c: Ctx, text: string\): \(\) => void/.test(scr));
  ok('**数字は 5 秒たってから** (速い回に秒数を見せない)', /if \(sec >= 5\)/.test(scr));
  ok('止める手段を返す (呼び出し側が消せる)', /return \(\) => window\.clearInterval\(timer\);/.test(scr));
  {
    const i = scr.indexOf('async function captureAndRead(');
    const j = scr.indexOf('\nasync function', i + 10);
    const cb = i >= 0 ? scr.slice(i, j > i ? j : undefined) : '';
    ok('captureAndRead が在る', cb.length > 0);
    ok('送信の区間で出す', /tick = waiting\(c, '写真を送っています'\)/.test(cb));
    ok('読取の区間で出す', /tick = waiting\(c, '番号を読み取っています'\)/.test(cb));
    /*
     * **出口は 4 つ**: 送信の失敗 / 送信の完了 / 読取の成功 / 読取の失敗。
     * 1 つでも止め忘れると、**1 秒ごとに経過秒で上書きされて
     * エラーメッセージも候補の案内も読めなくなる**（画面は動いているので気づかない）。
     */
    ok('出口 4 つとも止める', (cb.match(/\btick\(\);/g) || []).length === 4,
      String((cb.match(/\btick\(\);/g) || []).length));
    ok('送信が落ちたら止めてから案内を出す',
      /\} catch \(err\) \{\s*tick\(\);[\s\S]{0,400}?写真を送れませんでした/.test(cb));
    ok('読取が落ちたら止めてから案内を出す',
      /\} catch \(err\) \{\s*tick\(\);\s*const msg = err instanceof Error/.test(cb));
    ok('読取の成功で止めてから実測を残す',
      /tick\(\);\s*reportTiming\(c, uploadMs, Date\.now\(\) - tRead0, r\.timing\);/.test(cb));
  }
  {
    const i = scr.indexOf('function reportTiming(');
    const rt = i >= 0 ? scr.slice(i, scr.indexOf('\n}', i)) : '';
    ok('実測の控えが在る', rt.length > 0);
    ok('**番号を控えに入れない**', !/candidate|evidenceKey|c\.idLabel/.test(rt), rt);
    ok('画面の文言にしない (status へ書かない)', !/say\(/.test(rt));
  }
}

console.log(`\n${fails.length === 0 ? `✓ ${pass} / ${pass} passed` : `✗ ${fails.length} 件 FAIL (${pass} passed)`}`);
if (fails.length) { console.error('\n落ちた検査:\n  - ' + fails.join('\n  - ')); process.exit(1); }
