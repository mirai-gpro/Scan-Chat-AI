// POST /api/admin/ad-hoc-diagnosis/classify-plan
// 分割分類 ①: ZIP の **Central Directory だけ**を読み、作業計画を返す。
// 正本: docs/lab/ad_hoc_diagnosis_batch_spec.md §5.2.1 / §6 / §7 ・ Phase B2.1
//
// **中身は 1 バイトも読まない**ので、159MB の ZIP でも数秒で返る。
// 応答に **path も人物フォルダ名も元ファイル名も入らない** (§8.1) — 序数だけ。
//
// **同じ ZIP を上げ直させない。** 既に読み終えたエントリの序数を `done` で返すので、
// 画面は続きから再開できる。
import type { APIRoute } from 'astro';
import { classifyPlan } from '../../../../lib/ad-hoc-diagnosis/service';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { actorFrom, authorized, fail, json, readJson, str } from './_shared';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);
  const batchId = str(body?.batchId);
  if (!batchId || !isUuid(batchId)) return json({ ok: false, error: 'invalid_batch_id' }, 400);

  try {
    const r = await classifyPlan(batchId, actorFrom(request));
    if (!r.ok) return json(r, r.status);
    return json(r);
  } catch (err) {
    return fail(err, 'classify-plan');
  }
};
