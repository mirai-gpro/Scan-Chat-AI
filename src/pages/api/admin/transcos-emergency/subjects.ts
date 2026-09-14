// GET /api/admin/transcos-emergency/subjects
// 画面が Executive マスタと突き合わせるための**人物表**。
// **氏名はここから配るだけ。診断側へ送り返させない** — 画面が返すのは
// 人物番号・候補件数・UUID の 3 つだけ (§22)。
import type { APIRoute } from 'astro';
import { TRANSCOS_SUBJECTS, TRANSCOS_ZIP, normalizeExecutiveName } from '../../../../lib/transcos-emergency/manifest';
import { GENETIC_PAGES } from '../../../../lib/transcos-emergency/run';
import { authorized, fail, json } from './_shared';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    return json({
      ok: true,
      zip: { bytes: TRANSCOS_ZIP.bytes, sha256: TRANSCOS_ZIP.sha256, fileCount: TRANSCOS_ZIP.fileCount },
      // **対象ページは診断側が配る。** 画面が 10 / 35 を自分で持たない (§13)。
      geneticPages: [...GENETIC_PAGES],
      subjects: TRANSCOS_SUBJECTS.map((s) => ({
        subjectNo: s.subjectNo,
        displayName: s.displayName,
        // 画面が同じ規則で比べられるよう、**正規化済みの形**も配る。
        displayNameNormalized: normalizeExecutiveName(s.displayName),
        healthEntry: s.health,
        geneticEntry: s.genoplan,
        questionnaireEntry: s.questionnaire,
        healthSupportEntry: s.healthSupport,
      })),
    });
  } catch (err) {
    return fail(err, 'transcos/subjects');
  }
};
