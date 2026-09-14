// POST/GET /api/admin/ad-hoc-diagnosis/questionnaire-answers
// 問診 PDF の **手動確認入力** (spec v1.1 §7.4 / §20-Q1)。
//
// GET  … 入力に使う設問カタログ (既存 `QUESTIONS` そのまま) と、保存済みの入力を返す。
// POST … 入力を保存する。`confirm: true` で二重確認。
//
// **自動 parse はしない。** PDF の回答は radio/checkbox の視覚的な選択状態で、
// text 抽出では選択・未選択の区別が付かない。LLM に推測させるのも禁止 (§18)。
//
// 保存先は既存の `ad_hoc_diagnosis_pages`。**新しいテーブルも列も作らない** (§2.4)。
import type { APIRoute } from 'astro';
import { saveManualQuestionnaire, readManualQuestionnaire } from '../../../../lib/ad-hoc-diagnosis/service';
import { questionCatalog } from '../../../../lib/ad-hoc-diagnosis/questionnaire-manual';
import { isUuid } from '../../../../lib/ad-hoc-diagnosis/keys';
import { actorFrom, authorized, fail, json, readJson, str } from './_shared';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const url = new URL(request.url);
  const batchId = str(url.searchParams.get('batchId'));
  const fileId = str(url.searchParams.get('fileId'));
  if (!batchId || !isUuid(batchId)) return json({ ok: false, error: 'invalid_batch_id' }, 400);
  if (!fileId || !isUuid(fileId)) return json({ ok: false, error: 'invalid_file_id' }, 400);
  try {
    const saved = await readManualQuestionnaire(batchId, fileId);
    if (!saved.ok) return json(saved, saved.status);
    // **カタログは既存 `QUESTIONS` をそのまま渡す。** 臨時バッチ用の設問を作らない。
    return json({ ok: true, questions: questionCatalog(), saved: saved.record });
  } catch (err) {
    return fail(err, 'questionnaire-answers:get');
  }
};

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  const body = await readJson(request);
  const batchId = str(body?.batchId);
  const fileId = str(body?.fileId);
  if (!batchId || !isUuid(batchId)) return json({ ok: false, error: 'invalid_batch_id' }, 400);
  if (!fileId || !isUuid(fileId)) return json({ ok: false, error: 'invalid_file_id' }, 400);

  const raw = Array.isArray(body?.entries) ? (body!.entries as Record<string, unknown>[]) : [];
  const entries = raw
    .map((e) => ({ questionId: str(e.questionId) ?? '', value: e.value }))
    .filter((e) => e.questionId !== '');

  const ageRaw = Number(body?.age);
  try {
    const r = await saveManualQuestionnaire({
      batchId,
      fileId,
      entries,
      completedAt: str(body?.completedAt),
      sex: str(body?.sex),
      age: Number.isInteger(ageRaw) ? ageRaw : null,
      confirm: body?.confirm === true,
      actor: actorFrom(request),
    });
    if (!r.ok) return json(r, r.status);
    return json(r);
  } catch (err) {
    return fail(err, 'questionnaire-answers:post');
  }
};
