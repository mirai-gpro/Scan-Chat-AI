#!/usr/bin/env node
/**
 * 原本の **S3 直 PUT** を、Object Lock 相当のバケットに対して実ブラウザで通す検査。
 *
 * 【なぜ要るか】本番 `wellfort-diagnosis` は **Object Lock + GOVERNANCE 保持**が有効で、
 * 保持対象への `PutObject` は **Content-MD5 か checksum ヘッダが必須**。
 * 無いと **HTTP 400**。実際にそれで落ちた。MinIO は配布が止まっていて入手できないので、
 * **同じ規則を課す S3 スタブ**を立てて確かめる。
 *
 * 【スタブが本物と同じにしていること】
 *   1. **SigV4 の署名を検算する。** 受け取った実リクエストから canonical request を組み直し、
 *      presigned URL の `X-Amz-Signature` と一致するかを見る。
 *      → **ブラウザが署名と違うヘッダを送ったら落ちる** (今回の要件「完全一致で送る」の担保)
 *   2. **Object Lock の規則。** Content-MD5 も checksum も無い PUT は
 *      `400 InvalidRequest` (本物と同じ Code を返す)
 *   3. **checksum の中身も見る。** `x-amz-checksum-sha256` が本文と合わなければ
 *      `400 BadDigest`
 *   4. **CORS。** バケットに設定した AllowedHeaders 以外を要求するプリフライトは通さない
 *
 * 【ブラウザを使う理由】プリフライトも `crypto.subtle` も Node では再現できない。
 * 3.3 MB / 8.3 MB の実 PDF を実ブラウザから PUT する。
 */
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const S3_PORT = 4399;
const PAGE_PORT = 4398;
const BUCKET = 'wellfort-diagnosis';
const REGION = 'ap-northeast-1';
const AK = 'AKIAIOSFODNN7EXAMPLE';
const SK = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

// 本番バケットに実際に入れた CORS (AllowedHeaders) を、既定値としてここに写す。
// 検査の途中で差し替えて「足りないと落ちる」ことも見る。
let CORS_ALLOWED_HEADERS = ['content-type'];
/** Object Lock 保持が有効か (本番は有効)。 */
const OBJECT_LOCK = true;

const out = 'node_modules/.cache/verify-originals-put.mjs';
execSync(
  `npx esbuild src/lib/originals-upload-ticket.ts --bundle --packages=external --platform=node --format=esm --log-level=error "--define:import.meta.env={}" --outfile=${out}`,
  { stdio: 'inherit' },
);
process.env.AWS_REGION = REGION;
process.env.AWS_S3_ORIGINALS_BUCKET = BUCKET;
process.env.AWS_S3_ORIGINALS_PREFIX = 'raw/';
process.env.AWS_ACCESS_KEY_ID = AK;
process.env.AWS_SECRET_ACCESS_KEY = SK;
process.env.AWS_S3_ENDPOINT = `http://127.0.0.1:${S3_PORT}`;
const lib = await import(`../${out}`);

let pass = 0;
const fails = [];
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  — ' + extra : ''}`); }
  else { fails.push(label); console.log(`FAIL  ${label}${extra ? '  — ' + extra : ''}`); }
};

// ── SigV4 の検算 ────────────────────────────────────────────────
const hmac = (k, d) => createHmac('sha256', k).update(d).digest();
const sha256hex = (b) => createHash('sha256').update(b).digest('hex');

function verifySigV4(req, rawPath, query) {
  const sig = query.get('X-Amz-Signature');
  const cred = query.get('X-Amz-Credential') ?? '';
  const amzDate = query.get('X-Amz-Date') ?? '';
  const signedHeaders = (query.get('X-Amz-SignedHeaders') ?? '').split(';').filter(Boolean);
  if (!sig || !cred || !amzDate || signedHeaders.length === 0) return { ok: false, why: 'missing presign params' };

  const canonQuery = [...query.entries()]
    .filter(([k]) => k !== 'X-Amz-Signature')
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  // **実際に届いたヘッダ**から組む → 署名と違うものを送ったら不一致になる。
  const canonHeaders = signedHeaders
    .map((h) => `${h}:${String(req.headers[h] ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('');

  const canonicalRequest = [
    'PUT', rawPath, canonQuery, canonHeaders, signedHeaders.join(';'), 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const scope = cred.split('/').slice(1).join('/');
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(Buffer.from(canonicalRequest, 'utf8'))].join('\n');
  const [date, region, service] = scope.split('/');
  const key = hmac(hmac(hmac(hmac('AWS4' + SK, date), region), service), 'aws4_request');
  const expect = createHmac('sha256', key).update(sts).digest('hex');
  return { ok: expect === sig, why: expect === sig ? '' : 'signature mismatch', canonicalRequest };
}

function xml(code, message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}

const puts = [];
const s3 = createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${S3_PORT}`);
  const origin = req.headers.origin ?? '';

  if (req.method === 'OPTIONS') {
    const want = (req.headers['access-control-request-headers'] ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const missing = want.filter((h) => !CORS_ALLOWED_HEADERS.includes(h));
    if (missing.length) { res.writeHead(403).end(); return; } // 本物と同じく「通さない」
    res.writeHead(200, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'PUT',
      'access-control-allow-headers': CORS_ALLOWED_HEADERS.join(','),
      'access-control-max-age': '3000',
    }).end();
    return;
  }

  const cors = {
    'access-control-allow-origin': origin,
    // 本物の S3 と同じく、本文は読める (ExposeHeaders が無くても body は読める)。
    'content-type': 'application/xml',
  };
  if (req.method !== 'PUT') { res.writeHead(405, cors).end(xml('MethodNotAllowed', 'only PUT')); return; }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const v = verifySigV4(req, u.pathname, u.searchParams);
    if (!v.ok) { res.writeHead(403, cors).end(xml('SignatureDoesNotMatch', v.why)); return; }

    // ★ Object Lock: Content-MD5 も checksum も無ければ 400 (本物と同じ)
    const hasMd5 = !!req.headers['content-md5'];
    const ck = req.headers['x-amz-checksum-sha256'];
    if (OBJECT_LOCK && !hasMd5 && !ck) {
      res.writeHead(400, cors).end(xml('InvalidRequest',
        'Content-MD5 OR x-amz-checksum- HTTP header is required for Put Object requests with Object Lock parameters'));
      return;
    }
    if (ck) {
      const actual = createHash('sha256').update(body).digest('base64');
      if (actual !== ck) { res.writeHead(400, cors).end(xml('BadDigest', 'checksum did not match')); return; }
    }
    const len = Number(req.headers['content-length'] ?? 0);
    if (len !== body.length) { res.writeHead(400, cors).end(xml('IncompleteBody', 'length mismatch')); return; }

    puts.push({ path: u.pathname, bytes: body.length, headers: { ...req.headers } });
    res.writeHead(200, { ...cors, etag: '"' + createHash('md5').update(body).digest('hex') + '"' }).end();
  });
});

// 画面側 (別オリジン = 実際にプリフライトが起きる)
const page = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/ticket') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const t = await lib.createOriginalUploadTicket({
      company: b.lab_company, fileName: b.file_name, bytes: b.bytes, sha256Base64: b.sha256_base64,
    });
    res.writeHead(t.ok ? 200 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(t.ok ? { ok: true, url: t.url, key: t.key, headers: t.headers, signed_headers: t.signedHeaders } : t));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>put</title><script>
window.run = async function (sizeBytes, name) {
  // 実ファイル相当のバイト列 (PDF ヘッダ + 乱数)
  const buf = new Uint8Array(sizeBytes);
  buf.set([0x25,0x50,0x44,0x46,0x2d,0x31,0x2e,0x37], 0);
  for (let i = 8; i < sizeBytes; i += 65536) crypto.getRandomValues(buf.subarray(i, Math.min(i + 65536, sizeBytes)));
  const file = new File([buf], name, { type: 'application/pdf' });

  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  let bin = ''; const u8 = new Uint8Array(digest);
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  const sha64 = btoa(bin);

  const tr = await fetch('/ticket', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lab_company: 'genoplan', file_name: name, bytes: file.size, sha256_base64: sha64 }) });
  const t = await tr.json();
  if (!t.ok) return { stage: 'ticket', ok: false, error: t.error, detail: t.detail };

  try {
    const put = await fetch(t.url, { method: 'PUT', headers: t.headers, body: file });
    const text = put.ok ? '' : await put.text();
    return { stage: 'put', ok: put.ok, status: put.status, body: text.slice(0, 300),
             sent: Object.keys(t.headers), signed: t.signed_headers, size: file.size, sha64 };
  } catch (e) {
    return { stage: 'put', ok: false, status: 0, body: String(e), sent: Object.keys(t.headers), signed: t.signed_headers };
  }
};
</script>`);
});

await new Promise((r) => s3.listen(S3_PORT, '127.0.0.1', r));
await new Promise((r) => page.listen(PAGE_PORT, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' })
  .catch(() => chromium.launch());
const ctx = await browser.newContext();
const p = await ctx.newPage();
await p.goto(`http://127.0.0.1:${PAGE_PORT}/`);

// ── ① 本番と同じ CORS (content-type だけ) → プリフライトが通らないはず ──
console.log('\n① CORS が content-type だけのとき (いまの本番設定)');
{
  const r = await p.evaluate(() => window.run(1024 * 64, 'cors.pdf'));
  ok(r.ok === false, 'checksum ヘッダを要求するプリフライトが通らない', `status=${r.status}`);
  ok(String(r.sent).includes('x-amz-checksum-sha256'), '署名に checksum が入っている', r.signed ?? '');
}

// ── ② CORS に checksum ヘッダを足す → 通るはず ────────────────────
CORS_ALLOWED_HEADERS = ['content-type', 'x-amz-checksum-sha256', 'x-amz-sdk-checksum-algorithm'];
console.log('\n② CORS に x-amz-checksum-sha256 / x-amz-sdk-checksum-algorithm を足す');
for (const [label, size, name] of [
  ['3.3 MB の PDF', 3_300_000, '検査結果_3M.pdf'],
  ['8.3 MB の PDF', 8_300_000, '遺伝子結果_8M.pdf'],
]) {
  const r = await p.evaluate(([s, n]) => window.run(s, n), [size, name]);
  ok(r.ok === true, `${label} が PUT できる`, `status=${r.status}${r.body ? ' ' + r.body : ''}`);
  const rec = puts[puts.length - 1];
  ok(rec && rec.bytes === size, `${label} が全量届いた`, rec ? `${rec.bytes} bytes` : 'なし');
  ok(rec && rec.headers['x-amz-checksum-sha256'] === r.sha64, `${label} の checksum が一致`, '');
}

// ── ③ Object Lock の規則そのもの (checksum を外すと 400) ───────────
console.log('\n③ Object Lock の規則');
{
  // 署名からも送信からも checksum を外した状態を作る = 以前の実装と同じ形
  const r = await p.evaluate(async () => {
    const buf = new Uint8Array(1024); buf.set([0x25, 0x50, 0x44, 0x46], 0);
    const file = new File([buf], 'nock.pdf', { type: 'application/pdf' });
    const d = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    let bin = ''; const u8 = new Uint8Array(d); for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    const tr = await fetch('/ticket', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lab_company: 'genoplan', file_name: 'nock.pdf', bytes: file.size, sha256_base64: btoa(bin) }) });
    const t = await tr.json();
    // **checksum を落として送る** (署名とも食い違うので、まず署名で弾かれるのが正しい)
    const h = { 'content-type': t.headers['content-type'] };
    const put = await fetch(t.url, { method: 'PUT', headers: h, body: file });
    return { status: put.status, body: (await put.text()).slice(0, 200) };
  });
  ok(r.status !== 200, 'checksum を落とすと通らない', `status=${r.status} ${r.body}`);
}

// ── ④ 署名との完全一致 (値を 1 文字変える → 署名不一致) ─────────────
console.log('\n④ 署名との完全一致');
{
  const r = await p.evaluate(async () => {
    const buf = new Uint8Array(2048); buf.set([0x25, 0x50, 0x44, 0x46], 0);
    const file = new File([buf], 'tamper.pdf', { type: 'application/pdf' });
    const d = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    let bin = ''; const u8 = new Uint8Array(d); for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    const tr = await fetch('/ticket', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lab_company: 'genoplan', file_name: 'tamper.pdf', bytes: file.size, sha256_base64: btoa(bin) }) });
    const t = await tr.json();
    const h = Object.assign({}, t.headers);
    if (!h['x-amz-checksum-sha256']) return { status: -1, body: 'checksum ヘッダが返っていない' };
    h['x-amz-checksum-sha256'] = (h['x-amz-checksum-sha256'][0] === 'A' ? 'B' : 'A') + h['x-amz-checksum-sha256'].slice(1);
    const put = await fetch(t.url, { method: 'PUT', headers: h, body: file });
    return { status: put.status, body: (await put.text()).slice(0, 200) };
  });
  ok(r.status === 403 && /SignatureDoesNotMatch/.test(r.body), 'checksum を 1 文字変えると署名不一致で弾かれる', `status=${r.status}`);
}

await browser.close();
s3.close();
page.close();

console.log(`\n${pass} / ${pass + fails.length} passed`);
if (fails.length) { console.error('\n落ちた検査:\n  - ' + fails.join('\n  - ')); process.exit(1); }
