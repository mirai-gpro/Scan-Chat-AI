/**
 * admin バッチ: 1 画像 → AIスキャン → Elith 形式 JSON + 元画像を S3 へ。
 *
 * 「がんリスク検査・遺伝子検査」等、Wellfort が手動取得した検査結果を Elith 用に一括生成する
 * 管理機能のサーバ側 (docs/elith/elith_batch_centralization_design.md)。
 * Vercel 実行モデルに合わせ **1 画像 = 1 リクエスト**。クライアント(/admin/elith-batch)が順に呼ぶ。
 * キー(GEMINI_API_KEY / AWS_*)は **サーバ環境変数**のみ (CLAUDE.md: Vercel 一元管理)。
 *
 * 入力 (POST JSON):
 *   {
 *     image: string,              // data: URL もしくは生 base64 (必須)
 *     mimeType?: string,          // image が生 base64 のときの MIME (既定 image/jpeg)
 *     formatId: string,           // Elith format_id (必須)
 *     clientId?: string,          // 未指定ならサーバで UUID 採番 (サンプル用)
 *     examDate?: string,          // YYYY-MM-DD (任意。未指定は画像抽出→本日)
 *     sourceFileName?: string,    // 元ファイル名 (任意)
 *   }
 * 出力:
 *   - S3 設定あり: { ok:true, configured:true, uploaded:[{key,uri}], test_date, date_source, rows, json_key, image_key }
 *   - S3 未設定 : { ok:false, configured:false, ... , preview: json }  ← ドライラン
 *
 * 認可: wellfort-site (www.wellfort.co.jp/admin) からサーバ間で呼ばれる。
 *   `Authorization: Bearer <ADMIN_API_KEY>` を検証 (wellfort_admin_lab_upload_spec §6-1)。
 *   wellfort-site 側は同値を `SCAN_CHAT_AI_API_KEY` として持つ。
 *   env `ADMIN_API_KEY` が未設定の場合のみ (dev) 認証を省略する。
 */

import type { APIRoute } from 'astro';
import { buildElithScanBundle, isElithFormatId, ELITH_FORMAT_IDS, canonicalizeEnabled } from '../../../lib/elith-export';
import { refreshConfig } from '../../../lib/app-config';
import { getS3Config, isS3Configured, putFiles } from '../../../lib/s3';
import { checkNecessity } from '../../../lib/elith-necessity-check';
import { masterItemNames } from '../../../lib/standard-master';
import { writeHealthAgeForHc } from '../../../lib/elith-delivery';
import { persistAdminBatchHc } from '../../../lib/scan-persist';
import { isAdminAuthorized } from '../../../lib/api-auth';
import { linkCycle, toLinkableFormat } from '../../../lib/diagnosis-cycle';

export const prerender = false;

/** Bearer 検証。expected 未設定(dev)なら true。 */
function authorized(request: Request): boolean {
  // 認可の実装は src/lib/api-auth.ts に集約 (キー未設定の本番は拒否＝fail-closed)。
  return isAdminAuthorized(request);
}

interface Body {
  image?: unknown;
  mimeType?: unknown;
  formatId?: unknown;
  clientId?: unknown;
  examDate?: unknown;
  sourceFileName?: unknown;
  /** true: 生成＋不要項目チェックのみ行い S3書出ししない（チェックフェーズ）。 */
  checkOnly?: unknown;
  /** 必要項目マスタ(検査項目名の allowlist)。指定時のみ項目層(マスタ外/不足)を判定。 */
  requiredItems?: unknown;
  /** 不足(deficient)でも強制書出しする管理者オーバーライド。 */
  override?: unknown;
  /*
   * ★ P0-2 (最終実装指示 §11): この取込がどの Diagnosis Cycle のものかを **明示指定**する。
   *   3 つ揃ったときだけ `cycle_links` を作る。**日付からは推測しない。**
   *   指定しなければ link されない = その回は契約者向け自動納品の対象にならない (fail-closed)。
   */
  subscriptionId?: unknown;
  cycleYear?: unknown;
  diagnosisCycleSeq?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function parseImage(input: string): { mime: string; data: string } {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(input.trim());
  if (m) return { mime: m[1], data: m[2] };
  return { mime: '', data: input.trim() };
}
function randomUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

export const POST: APIRoute = async ({ request }) => {
  await refreshConfig(); // 運用パラメータ(app_config)を最新化してから処理
  if (!authorized(request)) {
    return json({ ok: false, error: 'unauthorized', detail: 'Invalid API key' }, 401);
  }
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const image = typeof body.image === 'string' ? body.image : '';
  if (!image.trim()) return json({ ok: false, error: 'image is required (data URL or base64)' }, 400);

  const formatId = str(body.formatId);
  if (!isElithFormatId(formatId)) {
    return json({ ok: false, error: `formatId must be one of ${ELITH_FORMAT_IDS.join(', ')}` }, 400);
  }

  const parsed = parseImage(image);
  const mimeType = parsed.mime || str(body.mimeType) || 'image/jpeg';
  const clientId = str(body.clientId) ?? randomUuid();
  const cfg = getS3Config();
  const prefix = cfg?.prefix ?? '';

  let bundle;
  try {
    bundle = await buildElithScanBundle({
      formatId,
      clientId,
      imageBase64: parsed.data,
      mimeType,
      sourceFileName: str(body.sourceFileName),
      examDate: str(body.examDate),
      prefix,
    });
  } catch (err) {
    return json({ ok: false, error: 'scan/build failed', detail: String(err instanceof Error ? err.message : err) }, 502);
  }

  const rows = Array.isArray((bundle.json as { data?: { measurements?: unknown[] } })?.data?.measurements)
    ? (bundle.json as { data: { measurements: unknown[] } }).data.measurements.length
    : 0;

  // 不要項目チェック（必要要素検証）。要望: S3書出し前に不要項目が無いか検証する。
  // requiredItems の供給: 呼び出し側が明示指定すればそれ(=真の必須マスタ)、無ければ
  // canonicalize on のとき starter 標準マスタを既定にして surplus/カバレッジを可視化する。
  const explicitRequired = Array.isArray(body.requiredItems)
    ? (body.requiredItems as unknown[]).filter((x): x is string => typeof x === 'string')
    : null;
  const requiredItems = explicitRequired ?? (canonicalizeEnabled() ? masterItemNames() : null);
  const necessity = checkNecessity(bundle.json, { requiredItemsMaster: requiredItems });

  // checkOnly: 生成＋チェックのみ返す（S3へは書き出さない＝チェックフェーズ）。
  if (body.checkOnly === true) {
    return json({
      ok: true,
      check_only: true,
      client_id: clientId,
      format_id: formatId,
      test_date: bundle.testDate,
      date_source: bundle.dateSource,
      rows,
      json_key: bundle.jsonKey,
      image_key: bundle.imageKey,
      necessity,
      canon: bundle.canon,
      cancer_fix: bundle.cancerFix,
      preview: bundle.json,
    });
  }

  // 不足(必要項目マスタにあるのに欠落)は分析に影響するため、既定で書出しブロック。
  // ただしブロックは「明示指定された必須マスタ」のときだけ。starter 既定マスタでは未実施項目が
  // 多数 deficient になるため情報提示に留める(Elith 必要サブセット確定後に厳格化・P4/P5)。
  // override:true で管理者が強制書出し可（理由は呼び出し側で記録）。
  if (explicitRequired && necessity.result === 'deficient' && body.override !== true) {
    return json({
      ok: false,
      blocked: 'deficient',
      detail: '必要項目が不足しています。再スキャン/確認のうえ override:true で強制可。',
      client_id: clientId,
      format_id: formatId,
      necessity,
      canon: bundle.canon,
      cancer_fix: bundle.cancerFix,
      preview: bundle.json,
    }, 409);
  }

  if (!isS3Configured() || !cfg) {
    return json({
      ok: false,
      configured: false,
      reason: 's3_not_configured',
      client_id: clientId,
      format_id: formatId,
      test_date: bundle.testDate,
      date_source: bundle.dateSource,
      rows,
      json_key: bundle.jsonKey,
      image_key: bundle.imageKey,
      necessity,
      canon: bundle.canon,
      cancer_fix: bundle.cancerFix,
      preview: bundle.json,
    });
  }

  try {
    const uploaded = await putFiles(bundle.files);
    /*
     * 人間ドック/検診は、同じ date フォルダへ **HealthAgeData(ウェルネス年齢)** も書く。
     * 実年齢は顧客DB → スペシャルアカウント登録DOB(special.account_dob) → scan 抽出年齢 の順で解決。
     * 算出不能(年齢/必須マーカー不足)なら書かない(捏造ゼロ)。失敗しても HC 納品は取り消さない。
     * これで promote が HC と一緒に HealthAgeData も納品先へ複製できる(複数年=年ごとに1つ)。
     */
    let healthAge: { written: boolean; key?: string; reason?: string; biological_age?: number | null; chronological_age?: number | null } | null = null;
    let dashboard: { artifactId: string | null; rows: number; reason?: string } | null = null;
    if (formatId === 'HealthCheckupData') {
      const measurements = ((bundle.json as { data?: { measurements?: unknown[] } })?.data?.measurements ?? []) as Record<string, unknown>[];
      try {
        healthAge = await writeHealthAgeForHc({ uid: clientId, measurements, testDate: bundle.testDate, hcKey: bundle.jsonKey, prefix });
      } catch (e) {
        healthAge = { written: false, reason: String(e instanceof Error ? e.message : e) };
      }
      // 本人ダッシュボード表示用に Supabase (test_artifacts / measurement_values) へも保存 (source=admin_batch)。
      try {
        dashboard = await persistAdminBatchHc({ diagnosticUserId: clientId, markdownClean: bundle.markdown, measurements, testDate: bundle.testDate });
      } catch (e) {
        dashboard = { artifactId: null, rows: 0, reason: String(e instanceof Error ? e.message : e) };
      }
    }
    /*
     * ★ P0-2 (§11): Diagnosis Cycle が明示指定されていれば `cycle_links` を作る。
     *   採用 source は **いま書き出した S3 キー** なので、納品 (exact-source) がここから辿れる。
     *   3 つ揃っていなければ link しない (fail-closed)。**日付から回を推測しない。**
     *   link の成否で S3 書き出しは取り消さない。
     */
    let cycleLink: { linked: boolean; reason: string | null } | null = null;
    const subId = str(body.subscriptionId);
    const cYear = Number(body.cycleYear);
    const cSeq = Number(body.diagnosisCycleSeq);
    if (subId && Number.isInteger(cYear) && cYear >= 1 && Number.isInteger(cSeq) && cSeq >= 1) {
      const linkable = toLinkableFormat(formatId);
      if (!linkable) {
        cycleLink = { linked: false, reason: 'format_not_linkable' };
      } else {
        const r = await linkCycle({
          diagnosticUserId: clientId,
          subscriptionId: subId,
          cycleYear: cYear,
          diagnosisCycleSeq: cSeq,
          formatId: linkable,
          sourceRef: bundle.jsonKey,
          linkedBy: 'admin_batch',
        });
        cycleLink = { linked: r.linked, reason: r.reason };
      }
    }

    return json({
      ok: true,
      configured: true,
      bucket: cfg.bucket,
      client_id: clientId,
      format_id: formatId,
      cycle_link: cycleLink, // null = 回が指定されていない (契約者向け自動納品の対象外)

      test_date: bundle.testDate,
      date_source: bundle.dateSource,
      rows,
      json_key: bundle.jsonKey,
      image_key: bundle.imageKey,
      necessity,
      canon: bundle.canon,
      cancer_fix: bundle.cancerFix,
      health_age: healthAge, // ウェルネス年齢の書き出し結果 (written/key/reason)
      dashboard, // 本人ダッシュボード保存結果 (artifactId/rows) = 検査値の表示・推移用
      preview: bundle.json, // 🎯/🔍 照合用: 納品JSON(data.measurements)を返す(他分岐と同様)。
      uploaded: uploaded.map((u) => ({ key: u.key, uri: u.uri })),
    });
  } catch (err) {
    return json({ ok: false, configured: true, error: 'S3 upload failed', detail: String(err) }, 502);
  }
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
