/**
 * admin: Elith の AI疾病予防報告書 取込 API — パイプライン⑥。
 *
 * 正本: docs/elith/AI疾病予防報告書_仕様書.md  ※ § 番号は旧版 docs/旧版・ボツ/ai_prevention_report_generation_spec.md §8
 *
 * 【受領は 1 件 = 3 ファイル】(spec §2)
 *   | 受領物                | フォーム項目     | 格納先                        |
 *   |-----------------------|------------------|-------------------------------|
 *   | `report_text.json`    | `report_text`    | `report` (jsonb)              |
 *   | `health_checkup.json` | `health_checkup` | `checkup_values` (jsonb・ファイル別の入れ子) |
 *   | `blood_test.json`     | `blood_test`     | 同上 (2026-08-24 受領のタイプ1 から) |
 *   | `cancer_risk.json`    | `cancer_risk`    | 同上 (同上)                    |
 *   | 組版済み PDF          | `file`           | `report_pdf_*` (**原本保管**) |
 *
 *   **PDF は任意**。表示の主役は JSON で、PDF は JSON の部分集合 (固有情報ゼロ・spec §2.3)。
 *   旧 `sections` (配列) も後方互換で受ける。**3 つとも無ければ 400** (空の行を作らない)。
 *
 * 【暫定である理由】受取仕様 (命名規則・出力トリガ・世代管理・ひも付け・受領確認) は
 *   `docs/lab/lab_data_pipeline_master_spec.md:98` のとおり未確定。確定するまでは
 *   「管理者が手で上げる」経路だけを用意し、自動受信は作らない。
 *
 * 【責務の分界】UI は wellfort-site 側 (CLAUDE.md「admin UI は wellfort-site に置く」)。
 *   本ファイルは API のみ。認可は Bearer ADMIN_API_KEY。
 *
 * 【原則】本文の要約・解釈はしない。受領したものをそのまま格納する。
 *   応答の件数は**表示と同じアダプタ**で数える — 別の数え方をすると
 *   「取り込めたつもりで画面が空」を検知できない (spec §1.3.6)。
 */

import type { APIRoute } from 'astro';
import { getServerSupabase } from '../../../../lib/supabase';
import { putOriginal } from '../../../../lib/originals-storage';
import { isAdminAuthorized } from '../../../../lib/api-auth';
import { ingestElithReport } from '../../../../lib/elith-report-ingest';
import { buildReportVM, type LabFiles } from '../../../../lib/report-adapter';

export const prerender = false;

const MAX_FILE_SIZE = 40 * 1024 * 1024; // 40 MB (レポート PDF は数百 KB 〜 数 MB)

function authorized(request: Request): boolean {
  // 認可の実装は src/lib/api-auth.ts に集約 (キー未設定の本番は拒否＝fail-closed)。
  return isAdminAuthorized(request);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PDF のページ数をバイト列から数える (依存追加なしの暫定)。
 * `/Type /Page` を数える素朴な方法で、オブジェクトストリーム圧縮された PDF では
 * 数え落とす。**推定できないときは null を返し、0 や当て推量を書かない**。
 * 呼び出し側が `pages` を明示していればそちらを優先する。
 */
function guessPageCount(bytes: Uint8Array): number | null {
  const text = new TextDecoder('latin1').decode(bytes);
  const m = text.match(/\/Type\s*\/Page(?![sA-Za-z])/g);
  const n = m ? m.length : 0;
  return n > 0 ? n : null;
}

export const POST: APIRoute = async ({ request }) => {
  if (!authorized(request)) return json({ ok: false, error: 'unauthorized' }, 401);

  const sb = getServerSupabase();
  if (!sb) return json({ ok: false, error: 'supabase not configured' }, 503);

  const form = await request.formData().catch(() => null);
  if (!form) return json({ ok: false, error: 'invalid form data' }, 400);

  const diagnosticUserId = String(form.get('diagnostic_user_id') ?? '').trim();
  if (!UUID_RE.test(diagnosticUserId)) {
    return json({ ok: false, error: 'invalid diagnostic_user_id' }, 400);
  }

  /** File でも文字列でも JSON を受ける (wellfort-site 側の実装に依存させない)。 */
  const readJson = async (name: string): Promise<{ ok: true; value: unknown } | { ok: false } | null> => {
    const v = form.get(name);
    let raw: string;
    if (v instanceof File) raw = (await v.text()).trim();
    else if (typeof v === 'string') raw = v.trim();
    else return null;
    if (!raw) return null;
    try { return { ok: true, value: JSON.parse(raw) }; } catch { return { ok: false }; }
  };

  // report_text.json (新形式 dict)。無ければ旧 sections (配列) を見る。
  let report: unknown = null;
  let schemaVersion = 'elith-v1.0';
  const rt = await readJson('report_text');
  if (rt && !rt.ok) return json({ ok: false, error: 'invalid report_text json' }, 400);
  if (rt?.ok) {
    if (!rt.value || typeof rt.value !== 'object') {
      return json({ ok: false, error: 'report_text must be an object or array' }, 400);
    }
    report = rt.value;
    // 新形式 (dict) を入れたときだけ版を上げる。配列で来たら旧形式のまま。
    schemaVersion = Array.isArray(rt.value) ? 'elith-v1.0' : 'elith-v2.0';
  } else {
    const legacy = await readJson('sections');
    if (legacy && !legacy.ok) return json({ ok: false, error: 'invalid sections json' }, 400);
    if (legacy?.ok) {
      if (!Array.isArray(legacy.value)) return json({ ok: false, error: 'sections must be an array' }, 400);
      report = legacy.value;
    }
  }

  /*
   * 検査値ファイル。**2026-08-24 受領のタイプ1 から 3 つに増えた**
   * (`health_checkup` 37 / `blood_test` 42 / `cancer_risk` 2)。
   * `checkup_values` は 1 列なので、**ファイル別の入れ子**で入れる。
   * 旧行は素の `health_checkup` 辞書が入っており、**読み手 (`report-adapter.ts` の
   * `flattenLabFiles`) が両方の形を受ける** = 形式の世代差はアダプタで吸収する (spec §5.3)。
   * ここでは中身を 1 バイトも加工しない (問診の切り分けも表示側の仕事)。
   */
  const LAB_PARTS = ['health_checkup', 'blood_test', 'cancer_risk'] as const;
  const lab: Record<string, unknown> = {};
  for (const part of LAB_PARTS) {
    const r = await readJson(part);
    if (r && !r.ok) return json({ ok: false, error: `invalid ${part} json` }, 400);
    if (!r?.ok) continue;
    if (!r.value || typeof r.value !== 'object' || Array.isArray(r.value)) {
      return json({ ok: false, error: `${part} must be an object` }, 400);
    }
    lab[part] = r.value;
  }
  const checkup = Object.keys(lab).length ? (lab as LabFiles) : null;

  // PDF は任意 (原本として保管するだけ)。
  const file = form.get('file');
  if (file instanceof File) {
    if (!file.name.toLowerCase().endsWith('.pdf')) return json({ ok: false, error: 'pdf only' }, 400);
    if (file.size > MAX_FILE_SIZE) {
      return json({ ok: false, error: 'too_large', detail: `> ${MAX_FILE_SIZE / 1024 / 1024} MB` }, 413);
    }
  } else if (report === null && checkup === null) {
    // 3 つとも無い = 取り込むものが無い。**空の行を作らない。**
    return json({ ok: false, error: 'nothing_to_ingest',
      detail: 'report_text / health_checkup / blood_test / cancer_risk / file のいずれかが要る' }, 400);
  }

  const now = new Date();
  let stored: { storageUrl: string; sha256: string; backend: string } | null = null;
  let pages: number | null = null;

  if (file instanceof File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    // PII を含まない diagnostic_user_id のみでパスを作る (customer スキーマの値は使わない)。
    const key = `elith_reports/${diagnosticUserId}/${yyyy}/${mm}/${file.name}`;
    try {
      stored = await putOriginal({ key, contentType: 'application/pdf', body: bytes });
    } catch (e) {
      return json({ ok: false, error: 'storage_failed', detail: String((e as Error)?.message ?? e) }, 502);
    }
    const pagesParam = Number(form.get('pages'));
    pages = Number.isFinite(pagesParam) && pagesParam > 0 ? Math.trunc(pagesParam) : guessPageCount(bytes);
  }

  const receivedAt = now.toISOString();

  /*
   * **書き込みは `elith-report-ingest.ts` に集約**。随時バッチ
   * (`/api/admin/elith-intake`) と 毎日の自動取り込み (`/api/cron/elith-intake`) も
   * 同じ関数を通る。世代管理と「取り込めた中身の数え方」を 3 か所に書くと、
   * 直したとき片方が腐る (健診 finalize と同じ規律)。
   * **手動アップロードは `sourceKey` を持たない** — 二重取り込みの歯止めは
   * S3 から自動で取り込む経路のためのもので、手で入れ直す操作は止めない。
   */
  const r = await ingestElithReport(sb as never, {
    diagnosticUserId,
    report,
    checkup,
    schemaVersion,
    pdf: stored ? { storageUrl: stored.storageUrl, sha256: stored.sha256, pages } : null,
    receivedAt,
  });
  if (!r.ok) return json({ ok: false, error: r.error, detail: r.detail }, 500);

  return json({
    ok: true,
    id: r.id,
    schema_version: schemaVersion,
    pdf: stored ? { backend: stored.backend, storage_url: stored.storageUrl, sha256: stored.sha256, pages } : null,
    ingested: {
      sections: r.ingested?.sections ?? 0,
      section_names: r.ingested?.section_names ?? [],
      wellness_age: r.ingested?.wellness_age ?? null,
      measurements: r.ingested?.measurements ?? 0,
      references: r.ingested?.references ?? 0,
      topics: r.ingested?.topics ?? 0,
      digest_cards: r.ingested?.digest_cards ?? [],
      empty_cards: r.ingested?.empty_cards ?? [],
    },
    warnings: r.warnings ?? [],
  });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
