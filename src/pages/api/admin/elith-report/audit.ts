/**
 * admin: AI疾病予防報告書の **抽出監査** API。
 *
 * 正本: docs/elith/AI疾病予防報告書_仕様書.md  ※ § 番号は旧版 docs/旧版・ボツ/ai_prevention_report_generation_spec.md §1.3.6
 *
 * 【なぜ要るか】受領テキストからの抽出は fail-safe (拾えなければ何も出さない) にしてあるので、
 *   誤った要点は出ない代わりに**黙って空になる**。Stage2 → Stage3 で `判定区分` と `[pN]` が
 *   実際に消え、それに依存していた旧実装が無言で空になった実績がある。
 *   → 「何を認識し、何を落としたか」を admin から見えるようにする。
 *   スキャン側の `vqa_audit` と同じ流儀。**報告書の紙面には出さない。**
 *
 * 【表示と同じ経路で組む】`loadReportVM()` の結果をそのまま読む。監査だけ別経路で数えると
 *   「監査は緑なのに画面が空」を検知できない。
 *
 * 【責務の分界】UI は wellfort-site 側。本ファイルは API のみ。認可は Bearer ADMIN_API_KEY。
 */

import type { APIRoute } from 'astro';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { loadReportVM } from '../../../../lib/elith-report-queries';
import { refreshConfig, cfg } from '../../../../lib/app-config';
import { ALL_CHAPTER_KEYS } from '../../../../lib/report-adapter';

export const prerender = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: APIRoute = async ({ request }) => {
  if (!isAdminAuthorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  const url = new URL(request.url);
  const raw = (url.searchParams.get('diagnostic_user_id') ?? '').trim();
  // 未指定ならサンプルを組む (受領前でも抽出規則の効きを確認できるようにする)。
  const diagnosticUserId = UUID_RE.test(raw) ? raw : null;

  await refreshConfig();
  const vm = await loadReportVM({
    diagnosticUserId,
    name: '', chronologicalAge: null, ourWellnessAge: null,
    hasCancerRisk: false, cycleSeq: null,
    // この API は Bearer ADMIN_API_KEY で保護された admin 専用。
    // 受領前でも抽出規則の効きを確認できるよう、サンプルを組ませる。
  });

  const shown = new Set(vm.chapters.map((c) => c.key));
  return json({
    ok: true,
    source: vm.isSample ? 'sample' : 'received',
    report_type: vm.reportType,
    issued_on: vm.cover.issuedOn,
    sheet_version: vm.cover.sheetVersion,
    wellness_age: vm.cover.wellnessAge,
    recognized: {
      sections: vm.audit.sections,
      topics: vm.audit.topicCount,
      measurements: vm.audit.measurementCount,
    },
    digest: {
      cards: vm.audit.digestCards,
      // **0 件は異常の兆候**。それを見つけるのがこの API の目的なので、必ず返す。
      empty_cards: vm.audit.emptyCards,
    },
    chapters: {
      shown: [...shown],
      not_shown: ALL_CHAPTER_KEYS.filter((k) => !shown.has(k)),
      hidden_by_config: vm.audit.hiddenChapters,
      unknown_keys_in_config: vm.audit.unknownChapterKeys,
    },
    anomalies: vm.audit.anomalies,
    config: {
      'report.sections.order': cfg('report.sections.order'),
      'report.sections.hidden': cfg('report.sections.hidden'),
      'report.sections.labels': cfg('report.sections.labels'),
      'report.sections.collapsed': cfg('report.sections.collapsed'),
      'ui.cancer_screening_not_included': cfg('ui.cancer_screening_not_included'),
    },
  });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
