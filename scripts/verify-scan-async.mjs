#!/usr/bin/env node
/**
 * `npm run verify:scan-async` — **送信後にユーザーを待たせない**ことを固定する。
 *
 * 正本: `docs/scan/スキャン非同期処理_仕様書.md`。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【この経路の要】送信＝完了。進捗も完了通知も出さない。
 * ══════════════════════════════════════════════════════════════════════
 * 失敗はユーザーに一切出さない (発注者判断 2026-09-10) ので、
 * **壊れても画面は正常に見える**。目視では守れない。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const strip = (t) => t
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((ln) => !/^\s*\/\//.test(ln)).join('\n');

const fails = [];
const ok = (label, cond, why) => {
  if (!cond) fails.push(`${label}${why ? ` — ${why}` : ''}`);
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
};

const scan = read('src/pages/scan.astro');
const upload = read('src/scripts/scan-upload.ts');
const jobs = read('src/lib/scan-jobs.ts');
const worker = read('src/pages/api/cron/scan-worker.ts');
const jobsApi = read('src/pages/api/scan/jobs.ts');

// ══════════════════════════════════════════════════════════════════════
console.log('\n① 全ページが S3 に載る (P2)\n');
{
  /*
   * 以前は**予算超え (≒3.2MB) のときだけ** S3 に置いていた。
   * バックグラウンドは後から読むので、**小さいファイルもカメラもキーが要る**。
   */
  /*
   * **予算内の分岐の「中」を見る。** ファイル全体に `uploadViaS3` があるかでは**効かない** —
   * 予算超えの分岐にも同じ呼び出しがあるので、予算内の側を元に戻しても素通りする
   * (この検査を書いた日に退行注入で実際に素通りした)。**ブロックを切り出して確かめる。**
   */
  {
    const head = 'if (file.size <= WIRE_BUDGET_BYTES) {';
    const i = upload.indexOf(head);
    const block = i >= 0 ? upload.slice(i + head.length, upload.indexOf('\n  }', i)) : '';
    ok('予算内のファイルも S3 へ置く',
      /uploadViaS3\(file\)/.test(block) && /imageKey/.test(block),
      '小さいファイルにキーが無いと、その回は前景処理に落ちて待たされる');
  }
  ok('予算内でも dataUrl は今までどおり持つ',
    /const dataUrl = await readFileAsDataUrl\(file\);/.test(upload),
    '表示がこれに乗っている。外すと画面が変わる');
  ok('カメラ撮影も同じ presigned PUT に載せる',
    /export async function uploadDataUrlToS3/.test(upload) && /uploadDataUrlToS3\(dataUrl\)/.test(scan),
    '新しい置き場を作らない (キーの形も検査も既存のまま)');
  ok('S3 に失敗しても投げない',
    /catch \{\s*return null;\s*\}/.test(upload),
    'S3 未設定・CORS 未設定・回線断を判別できない。読み取り自体は成立させる');
}

console.log('\n② 送信したら終わり (P4)\n');
{
  ok('全ページにキーが揃ったらジョブを積んで終わる',
    /const keys = pages\.all\.map\(\(p\) => p\.imageKey\)[\s\S]{0,200}?if \(keys\.length === total\)/.test(scan),
    '1 枚でも欠けたら前景へ落とす (待たせるが必ず読める方へ倒す)');
  ok('積めたら「送信しました」で終わる',
    /show\('sent'\);\s*return;/.test(scan));
  /*
   * **進捗も完了通知も作らない** (発注者判断 2026-09-10・§4.6)。
   * 「読み取り中 (3/6)」を作ると、待たせない約束と食い違う。
   */
  ok('ポーリングも進捗表示も作っていない',
    !/setInterval|readyState|poll\(|進捗を確認/.test(strip(scan).split("show('sent')")[1] ?? ''),
    '送信後に何かを見に行かせない');
  ok('待ち時間の説明を残していない',
    !/少し時間がかかります/.test(strip(scan)),
    '仕様書 §7「この文言は P4 で消える」');
  ok('ジョブが積めなければ前景へ落ちる',
    /\/\/ 積めなかった[\s\S]{0,120}?const results = \[\];/.test(scan)
      || /queued\)[\s\S]{0,300}?const results = \[\];/.test(scan),
    '未サインイン・DB 障害でも読み取りは成立させる');
}

console.log('\n③ ジョブの積み方 (P3)\n');
{
  ok('uid は Cookie から解決したものだけ',
    /const uid = viewer\.selfUid;/.test(jobsApi) && !/body\.diagnosticUserId/.test(jobsApi),
    'body の申告で積むと他人のスキャンを作れてしまう');
  /*
   * **キーを検査しないと、同じバケットの Elith 納品 JSON をワーカーに読ませられる。**
   * 検査は既存の `isScanUploadKey` (形の完全一致) をそのまま使う。
   */
  ok('キーは isScanUploadKey で完全一致検査する',
    /isScanUploadKey\(k, cfg\)/.test(jobsApi),
    '緩めると他人の納品 JSON を読ませられる');
  ok('キーを応答にもログにも出さない',
    !/console\.[a-z]+\([^)]*\$\{?k(ey)?s?\}?/.test(jobsApi) && !/keys: bad/.test(jobsApi),
    'PII を含む画像への参照。件数だけでよい');
}

console.log('\n④ ワーカー (P3)\n');
{
  ok('Bearer で保護されている', /function authorized\(request: Request\)/.test(worker));
  ok('鍵が無い本番は拒否する (fail-closed)',
    /if \(!cron && !admin\) return import\.meta\.env\.DEV === true;/.test(worker),
    '素通しにすると誰でもワーカーを回せる');
  ok('deadline で打ち切る', /Date\.now\(\) >= deadline - PER_PAGE_MS/.test(worker));
  ok('中断しても続きから (done_count と markdown を毎枚書く)',
    /await advanceJob\(job\.id, \{ doneCount: done/.test(worker),
    '書かないと時間切れのたびに 1 枚目からやり直しになる');
  ok('二重起動よけ (locked_until + attempts で条件付き更新)',
    /\.eq\('attempts', job\.attempts\)/.test(jobs),
    'cron が重なると同じジョブを 2 度読む = Gemini 代が倍かかり結果も二重になる');
  ok('1 枚落ちても残りは続ける', /failed \+= 1;/.test(worker));
  ok('束ね方と推論値列の落とし方は前景と同じ関数',
    /joinPageMarkdown\(parts\.map\(\(p\) => stripColumnFromTables\(p, \['推論値', '推定値'\]\)\)\)/.test(worker),
    '写して 2 か所に置くと、同じ紙から違う結果が出る');
  ok('保存は既存の saveScanResult を通る',
    /await saveScanResult\(/.test(worker),
    '書き込み口を 2 つに増やさない');
  ok('artifact_id を必ず書く',
    /await finishJob\(job\.id, saved\.artifactId\);/.test(worker),
    '後から読み取り結果を確認する入口 (案B)。書き忘れると辿れない');
  ok('読み終わったら画像を消す',
    /await deleteObjects\(job\.image_keys\)/.test(worker));
  ok('削除に失敗しても投げない',
    /画像の削除に失敗 \(ライフサイクルで消える\)/.test(worker),
    'バケットのライフサイクルが 1 日で必ず消す');
  ok('失敗を黙って消さない',
    /await failJob\(job\.id, job\.attempts, msg\);/.test(worker),
    'ユーザーには出さないので、残らないと誰も気づけない');
}

console.log('\n⑤ cron と監視 (P4 / P5)\n');
{
  const vercel = read('vercel.json');
  ok('毎分 cron が登録されている',
    /"path": "\/api\/cron\/scan-worker"/.test(vercel) && /"schedule": "\* \* \* \* \*"/.test(vercel),
    'Pro なら毎分置ける (Hobby は日次までで deployment が失敗する)');
  ok('前景の 60s を巻き込んでいない',
    !/maxDuration/.test(read('src/pages/api/scan.ts')),
    'ワーカーだけ伸ばす。/api/scan 側は触らない');

  const adminApi = read('src/pages/api/admin/scan-jobs.ts');
  ok('失敗と滞留を数える口がある', /problems: h\.failed \+ h\.stale/.test(adminApi));
  /*
   * **「引けなかった」を 0 件と混同しない。** 未設定・障害を 0 件として返すと
   * 見張りが緑のままになり、**壊れていることに誰も気づかない**。
   */
  ok('DB を引けなかったときは 0 件と言わない',
    /h\.configured === false/.test(adminApi) && /supabase_not_configured/.test(adminApi),
    '見張りが緑のままになる');
  ok('uid も S3 キーも返さない',
    !/diagnostic_user_id|image_keys/.test(strip(adminApi)) && !/image_keys/.test(strip(jobs).split('scanJobHealth')[1] ?? ''),
    '監視に要るのは件数と理由だけ');

  const wf = read('.github/workflows/scan-jobs-watch.yml');
  ok('日次の見張りがある', /schedule:/.test(wf) && /scan-jobs/.test(wf));
  ok('0 件でなければ赤くする', /if \[ "\$problems" != "0" \]/.test(wf),
    '赤くなればメールが飛ぶ = これが通知の代わり');
  ok('secret が無い環境では赤くしない', /確認をスキップしました/.test(wf),
    '「未設定」と「異常」を同じ赤にすると、赤の意味が薄れて誰も見なくなる');
}

console.log('');
if (fails.length) {
  console.log(`✗ ${fails.length} 件`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✓ 送信を押したら終わり。読み取りは後ろで走り、失敗は admin に残る。');
