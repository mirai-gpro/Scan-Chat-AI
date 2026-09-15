/**
 * 納品先への複製 (`/api/admin/elith-delivery-promote`) の**安全策**を実際に叩いて確かめる。
 * S3 へは接続しない (keep の検査は接続より前に効く)。
 */
import { POST, promoteKey } from '../src/pages/api/admin/elith-delivery-promote';

process.env.AWS_REGION = 'ap-northeast-1';
process.env.AWS_S3_PREFIX = 'scan-accuracy-test/';
process.env.ADMIN_API_KEY = 'test-key-not-real';

let pass = 0;
const fails: string[] = [];
const ok = (n: string, c: boolean, d?: string) => { if (c) pass++; else fails.push(n + (d ? ' — ' + d : '')); };
const eq = (n: string, g: unknown, w: unknown) =>
  ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);

const P = 'scan-accuracy-test/';
const ID = '61bac656-e3cd-41a3-b7f8-ae2cb85dc4a4';
const OTHER = '0a2b33b8-67c3-4aaa-906d-de06695cfe62';
const keep = new Set([ID]);

// ── キーの写し替え（**組み替えない**。取り違えると別人のフォルダへ入る） ──
eq('キーは user/ 直下へそのまま移る',
  promoteKey(`${P}user/${ID}/date/2025_10_22/x.json`, P, keep), `user/${ID}/date/2025_10_22/x.json`);
eq('対象外の client_id は移さない', promoteKey(`${P}user/${OTHER}/date/2025_10_22/x.json`, P, keep), null);
eq('UUID でない階層は移さない', promoteKey(`${P}user/elith-test-exec-001/date/2026_08_04/x.json`, P, keep), null);
eq('user/ の外は移さない', promoteKey(`${P}originals/${ID}/x.json`, P, keep), null);
eq('別プレフィックスは移さない', promoteKey(`other/user/${ID}/x.json`, P, keep), null);
// **`user` と同じ長さの兄弟フォルダ**で試す。ここでしか prefix の検査は効かない
// (長さが違うと切り出した先頭が UUID にならず、下流の検査で弾かれてしまうため)。
eq('user と同じ長さの別フォルダ (orig/) も移さない',
  promoteKey(`${P}orig/${ID}/date/2025_10_22/x.json`, P, keep), null);
eq('画像も同じ規則で移る',
  promoteKey(`${P}user/${ID}/date/2025_10_22/a_01.jpg`, P, keep), `user/${ID}/date/2025_10_22/a_01.jpg`);

async function call(body: unknown, auth = true) {
  const req = new Request('https://x/', { method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer ' + process.env.ADMIN_API_KEY } : {}) },
    body: JSON.stringify(body) });
  const res = await (POST as any)({ request: req });
  return { status: res.status, json: JSON.parse(await res.text()) };
}

eq('鍵が無ければ断る', (await call({ mode: 'copy', keep: [ID] }, false)).status, 401);
eq('keep なしは断る', (await call({ mode: 'copy' })).json.error, 'keep_required');
eq('keep が空なら断る', (await call({ mode: 'copy', keep: [] })).json.error, 'keep_required');
eq('keep が UUID でなければ断る', (await call({ mode: 'copy', keep: ['all'] })).json.error, 'keep_invalid');
eq('1 件でも不正が混ざれば断る', (await call({ mode: 'copy', keep: [ID, '*'] })).json.error, 'keep_invalid');
{
  const r = await call({ mode: 'list', keep: [ID] });
  ok('keep が正しければ S3 へ進む', r.json.error === 'list_failed' || r.json.ok === true, JSON.stringify(r.json).slice(0, 120));
}
{
  /*
   * **env でプレフィックスを外すことはできない。**
   * s3.ts の env() が空文字を「未設定」とみなし、既定 `scan-accuracy-test/` に戻すため
   * (実測 2026-09-15)。つまり「AWS_S3_PREFIX を空にして user/ へ直接書く」は成立せず、
   * この複製エンドポイントが唯一の手段になる。ここを取り違えないよう固定する。
   */
  process.env.AWS_S3_PREFIX = '';
  const { getS3Config } = await import('../src/lib/s3');
  ok('env を空にしても prefix は空にならない（既定へ戻る）',
    (getS3Config()?.prefix ?? '') !== '', String(getS3Config()?.prefix));
  process.env.AWS_S3_PREFIX = 'scan-accuracy-test/';
}

console.log(`\n納品先への複製 検証: ${pass} / ${pass + fails.length} 通過`);
if (fails.length) { console.log('\n落ちた検査:'); for (const f of fails) console.log('  ✖ ' + f); process.exit(1); }
console.log('  ✔ すべて通過');
