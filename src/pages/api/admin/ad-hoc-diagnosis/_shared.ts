// src/pages/api/admin/ad-hoc-diagnosis/_shared.ts
// 臨時診断バッチ API の共通部。**認可と actor の取り出しだけ**を持つ。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §21 / §24.1
//
// **`_` 始まりなのでルートにならない** (Astro の規約)。

import { isAdminAuthorized } from '../../../../lib/api-auth';
import type { Actor } from '../../../../lib/ad-hoc-diagnosis/service';

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * 認可。**`ADMIN_API_KEY` の Bearer だけ**を通す (§24.1)。
 *
 * **取り込み専用キー (intake key) ではこの API を通さない。**
 * intake キーが通ってよい口は 3 つだけで、`verify:intake-scope` がそれを固定している。
 * ここをその 3 つに足さない。
 * ※ その検査は**鍵の名前を文字列で探す**ので、このコメントにも名前を書かない
 *   (書くと「鍵を配っている」と判定されて落ちる)。
 */
export function authorized(request: Request): boolean {
  return isAdminAuthorized(request);
}

/**
 * 操作者を取り出す。
 *
 * **`actor_user_id` は wellfort-site が `/auth/v1/user` で検証した値だけ** (§21)。
 * 中継のサーバ側が専用ヘッダに載せて渡す。**body に同名のキーが在っても使わない** —
 * 上書きを許すと監査ログが自己申告になる。
 */
export function actorFrom(request: Request): Actor {
  const h = (name: string) => {
    const v = request.headers.get(name);
    return v && v.trim() !== '' ? v.trim() : null;
  };
  const uid = h('x-ad-hoc-actor-user-id');
  return {
    userId: uid && /^[0-9a-fA-F-]{36}$/.test(uid) ? uid.toLowerCase() : null,
    masked: h('x-ad-hoc-actor-masked'),
    sha256: h('x-ad-hoc-actor-sha256'),
  };
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await request.json();
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

export function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 例外を HTTP へ落とす。**内部のスタックは出さない。**
 *
 * **設定が無いだけのときは 500 にしない。** Supabase / S3 が未設定なのは
 * 「壊れている」のでなく「まだ繋がっていない」ので、**503 と理由**を返す
 * (500 だと画面に「内部エラー」と出て、原因が設定だと分からなくなる)。
 */
export function fail(err: unknown, where: string): Response {
  const name = (err as { name?: string })?.name ?? '';
  const msg = String((err as { message?: string })?.message ?? err).slice(0, 300);
  if (name === 'StoreUnavailable') {
    return json({ ok: false, error: 'supabase_not_configured', where, detail: msg }, 503);
  }
  console.error(`[ad-hoc:${where}]`, msg);
  return json({ ok: false, error: 'internal_error', where, detail: msg }, 500);
}
