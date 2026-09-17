/**
 * 納品先の掃除 (`/api/admin/elith-delivery-cleanup`) の**安全策**を実際に叩いて確かめる。
 *
 * ここは **S3 のオブジェクトを消す口**なので、「全消しにならない」ことを目視で守らない。
 * S3 へは一切接続しない (keep の検査は接続の前に効くので、そこまでで判定できる)。
 */
import { POST, clientIdOf } from '../src/pages/api/admin/elith-delivery-cleanup';

// isS3Configured() を通すためのダミー。実際の接続はしない (keep の検査で先に返る)。
process.env.AWS_REGION = 'ap-northeast-1';
process.env.AWS_S3_PREFIX = 'scan-accuracy-test/';
process.env.ADMIN_API_KEY = 'test-key-not-real'; // 認可は fail-closed なので必ず要る

let pass = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name: string, got: unknown, want: unknown) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

async function call(body: unknown, auth = true): Promise<{ status: number; json: any }> {
  const req = new Request('https://x/api/admin/elith-delivery-cleanup', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: 'Bearer ' + process.env.ADMIN_API_KEY } : {}),
    },
    body: JSON.stringify(body),
  });
  const res = await (POST as any)({ request: req });
  return { status: res.status, json: JSON.parse(await res.text()) };
}

const P = 'scan-accuracy-test/user/';
const ID = '61bac656-e3cd-41a3-b7f8-ae2cb85dc4a4';

// ── client_id の取り出し (ここを誤ると別人のフォルダを消す) ──
eq('key から client_id を取る', clientIdOf(P + ID + '/date/2025_10_22/x.json', P), ID);
eq('納品先の外は対象にしない', clientIdOf('scan-accuracy-test/other/' + ID + '/x.json', P), null);
eq('UUID でない階層は対象にしない', clientIdOf(P + 'not-a-uuid/x.json', P), null);
eq('user/ 直下のファイルは対象にしない', clientIdOf(P + 'x.json', P), null);
eq('prefix が違えば対象にしない', clientIdOf('other-prefix/user/' + ID + '/x.json', P), null);
// **`user` と同じ長さの兄弟フォルダ**で試す。ここでしか prefix の検査は効かない
// (長さが違うと、切り出した先頭が UUID にならず下流の検査で弾かれてしまうため)。
eq('user と同じ長さの別フォルダ (orig/) も対象にしない',
  clientIdOf('scan-accuracy-test/orig/' + ID + '/x.json', P), null);

// ── 認可 (鍵が無ければ何も見ない) ──
{
  const r = await call({ mode: 'list', keep: [ID] }, false);
  eq('鍵が無ければ断る (status)', r.status, 401);
  eq('鍵が無ければ断る (error)', r.json.error, 'unauthorized');
}
{
  const req = new Request('https://x/', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
    body: JSON.stringify({ mode: 'delete', keep: [ID] }) });
  const res = await (POST as any)({ request: req });
  eq('鍵が違えば断る', res.status, 401);
}

// ── 全消しを構造的に禁じる ──
{
  const r = await call({ mode: 'delete' });                      // keep なし
  eq('keep なしは断る (status)', r.status, 400);
  eq('keep なしは断る (error)', r.json.error, 'keep_required');
}
{
  const r = await call({ mode: 'delete', keep: [] });            // 空配列
  eq('keep が空なら断る', r.json.error, 'keep_required');
}
{
  const r = await call({ mode: 'delete', keep: ['all'] });       // UUID でない
  eq('keep が UUID でなければ断る (status)', r.status, 400);
  eq('keep が UUID でなければ断る (error)', r.json.error, 'keep_invalid');
}
{
  const r = await call({ mode: 'delete', keep: [ID, '*'] });     // 1 件でも混ざれば
  eq('keep に 1 件でも不正が混ざれば断る', r.json.error, 'keep_invalid');
}
{
  const r = await call({ mode: 'list', keep: [ID] });
  ok('keep が正しければ S3 へ進む (ここでは接続できず list_failed)',
    r.json.error === 'list_failed' || r.json.ok === true, JSON.stringify(r.json).slice(0, 120));
}

console.log(`\n納品先の掃除 検証: ${pass} / ${pass + fails.length} 通過`);
if (fails.length) { console.log('\n落ちた検査:'); for (const f of fails) console.log('  ✖ ' + f); process.exit(1); }
console.log('  ✔ すべて通過');
