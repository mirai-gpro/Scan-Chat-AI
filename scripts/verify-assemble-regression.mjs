#!/usr/bin/env node
/**
 * P0-2E-0: **`elith-assemble.ts` の既定モードの出力を 1 バイト単位で固定する**回帰 fixture。
 *
 *   npm run verify:assemble-regression            … スナップショットと照合
 *   npm run verify:assemble-regression -- --write … スナップショットを再生成
 *
 * 【なぜ要るか】exact-source モードの追加は **manual / auto 共通の delivery ループ**
 * (`elith-assemble.ts:483-499`) に手を入れる。ここは既存の admin 手動ラップが通る経路なので、
 * **既定モードの出力が 1 バイトも変わらないこと**を先に固定してからでないと着手できない
 * (最終実装指示 §14 / §18-1)。
 *
 * 固定するもの (指示 §14):
 *   - files[].key / files[].body
 *   - sources[] (formatId / sourceKey / sourceDate / deliveredDate / newKey / dataItems)
 *   - SERIES_FORMATS の **全 date 展開**
 *   - HealthAgeData の同梱
 *
 * S3 は `scripts/fixtures/assemble-s3-stub.ts` へ差し替える (esbuild プラグイン)。
 * **本番コードは 1 行も変更しない。**
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const WRITE = process.argv.includes('--write');
const SNAP = 'scripts/fixtures/assemble-default-mode.snapshot.json';
const ROOT = process.cwd();

/** `elith-assemble.ts` から見た `./s3` だけを stub へ解決する。 */
const s3StubPlugin = {
  name: 's3-stub',
  setup(b) {
    b.onResolve({ filter: /(^|\/)s3$/ }, (args) => {
      if (!args.importer.includes('elith-assemble')) return null;
      return { path: resolve(ROOT, 'scripts/fixtures/assemble-s3-stub.ts') };
    });
  },
};

const entry = `
import { assembleElithDeliverySet } from '${resolve(ROOT, 'src/lib/elith-assemble.ts')}';
import { __setStore } from '${resolve(ROOT, 'scripts/fixtures/assemble-s3-stub.ts')}';
import { STORE, HEALTH_AGE_BY_REF, FIXTURE_PREFIX, FIXTURE_UID_A, FIXTURE_UID_B, KEYS }
  from '${resolve(ROOT, 'scripts/fixtures/assemble-dataset.ts')}';

__setStore(STORE);

const common = {
  sourcePrefix: FIXTURE_PREFIX,
  deliveryPrefix: 'fixture-out/',
  bundleDate: '2026_09_25',
  exportedAt: new Date('2026-09-25T00:00:00Z'),
  healthAgeByRef: HEALTH_AGE_BY_REF,
};

/* ① 手動ラップ (admin が使う経路)。SERIES_FORMATS は全 date 展開されるはず。 */
const manual = await assembleElithDeliverySet({
  ...common,
  manualMapping: {
    [FIXTURE_UID_A]: {
      HealthCheckupData: KEYS.hcA3,
      BloodTestData: KEYS.bloodA2,
      CancerRiskAssessmentData: KEYS.cancerA1,
      Other: KEYS.otherA1,
      GeneticTestResultData: KEYS.geneA1,
      LifestyleQuestionnaireData: KEYS.lqA1,
    },
    [FIXTURE_UID_B]: {
      HealthCheckupData: KEYS.hcB1,
      LifestyleQuestionnaireData: KEYS.lqB1,
    },
  },
});

/* ② 自動モード (count 指定)。既定分岐も固定しておく。 */
const auto = await assembleElithDeliverySet({ ...common, count: 1, idPrefix: 'fx' });

/*
 * 本質的に run ごとに変わる 2 フィールドだけを伏せる。
 *   diagnostic_id : randomUuid()            (elith-assemble.ts:276)
 *   exported_at   : new Date().toISOString() (同 :279)
 * **本番コードは変更しない。** ここを伏せないと fixture が毎回落ちて検査にならない。
 * それ以外は 1 バイトも触らないので、「出力が変わっていない」の担保は失われない。
 * bytes も exported_at の長さで揺れ得るため、正規化後の body から数え直す。
 */
// ※ この関数は下のテンプレートリテラル内で評価されるため、正規表現の \\s は \\\\s と書く必要がある
//   (テンプレートリテラルは未知のエスケープ \\s を s に潰すので、素の \\s だと一致しない)。
const normalize = (body) => body
  .replace(/("diagnostic_id":\\s*)"[^"]*"/g, '$1"<uuid>"')
  .replace(/("exported_at":\\s*)"[^"]*"/g, '$1"<ts>"');

const shape = (r) => ({
  deliveryPrefix: r.deliveryPrefix,
  users: r.users.map((u) => ({
    userId: u.userId,
    sources: u.sources.map((s) => ({
      formatId: s.formatId, sourceKey: s.sourceKey, sourceDate: s.sourceDate,
      deliveredDate: s.deliveredDate, newKey: s.newKey, dataItems: s.dataItems,
    })),
    files: u.files.map((f) => {
      const body = normalize(f.body);
      return { key: f.key, bytes: Buffer.byteLength(body, 'utf8'), body };
    }),
  })),
});

process.stdout.write(JSON.stringify({ manual: shape(manual), auto: shape(auto) }, null, 2));
`;

const out = await build({
  stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false,
  logLevel: 'error', define: { 'import.meta.env': '{}' },
  plugins: [s3StubPlugin],
});

const { execFileSync } = await import('node:child_process');
const raw = execFileSync(process.execPath, ['--input-type=module', '-e', out.outputFiles[0].text], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
const actual = JSON.parse(raw);

// ── 内容チェック (スナップショットが「正しい形」であることの担保) ──────────────
const fails = [];
const mUserA = actual.manual.users.find((u) => u.userId.includes('1111'));
const hcRows = (mUserA?.sources ?? []).filter((s) => s.formatId === 'HealthCheckupData');
const bloodRows = (mUserA?.sources ?? []).filter((s) => s.formatId === 'BloodTestData');
const haRows = (mUserA?.sources ?? []).filter((s) => s.formatId === 'HealthAgeData');
if (hcRows.length !== 3) fails.push(`既定モードの HealthCheckupData 全date展開が 3 件でない (${hcRows.length})`);
if (bloodRows.length !== 2) fails.push(`既定モードの BloodTestData 全date展開が 2 件でない (${bloodRows.length})`);
if (haRows.length !== 2) fails.push(`HealthAgeData が 2 件でない (${haRows.length})`);

const digest = createHash('sha256').update(JSON.stringify(actual)).digest('hex');

if (WRITE) {
  if (!existsSync(dirname(SNAP))) mkdirSync(dirname(SNAP), { recursive: true });
  writeFileSync(SNAP, JSON.stringify(actual, null, 2) + '\n');
  console.log(`✓ スナップショットを書き出しました: ${SNAP}`);
  console.log(`  sha256=${digest}`);
  console.log(`  既定モード: HealthCheckup ${hcRows.length} date / Blood ${bloodRows.length} date / HealthAge ${haRows.length} 件`);
  if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
  process.exit(0);
}

if (!existsSync(SNAP)) {
  console.log(`✗ スナップショットがありません。先に --write で作成してください: ${SNAP}`);
  process.exit(1);
}
const expected = JSON.parse(readFileSync(SNAP, 'utf8'));
const a = JSON.stringify(actual, null, 2);
const b = JSON.stringify(expected, null, 2);

if (a !== b) {
  // どこが違うかを 1 行で示す (全文 diff は巨大になるため)
  const al = a.split('\n'); const bl = b.split('\n');
  let i = 0; while (i < Math.min(al.length, bl.length) && al[i] === bl[i]) i++;
  console.log('✗ 既定モードの出力がスナップショットと一致しません（exact-source 追加で既存挙動が変わっています）');
  console.log(`  最初の相違 行${i + 1}`);
  console.log(`    expected: ${(bl[i] ?? '(なし)').trim().slice(0, 160)}`);
  console.log(`    actual  : ${(al[i] ?? '(なし)').trim().slice(0, 160)}`);
  process.exit(1);
}
for (const f of fails) console.log(`  ✗ ${f}`);
console.log(`✓ 既定モードの出力はスナップショットと完全一致 (sha256=${digest.slice(0, 16)}…)`);
console.log(`  HealthCheckup ${hcRows.length} date 展開 / Blood ${bloodRows.length} date / HealthAge ${haRows.length} 件`);
process.exit(fails.length ? 1 : 0);
