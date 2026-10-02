/**
 * 検査結果ファイル一括アップロード API。
 *
 * 保存先は src/lib/originals-storage.ts に集約 (STEP 5 / 案C′)。
 * 原本用 S3 (AWS_S3_ORIGINALS_BUCKET) が設定されていれば S3、
 * 未設定なら従来どおり Supabase Storage へ保存する。
 *
 * 顧客自動紐付け (Workflow 1) と LLM 解析は後続フェーズ。
 */

import type { APIRoute } from 'astro';
import { getServerSupabase } from '../../../../lib/supabase';
import { putOriginal } from '../../../../lib/originals-storage';
import { persistMeasurements, type SchemaClient } from '../../../../lib/measurement-persist';
import { buildBloodCsvBundles } from '../../../../lib/elith-blood-csv';

export const prerender = false;

const LAB_COMPANY_TO_TEST_TYPE: Record<string, string> = {
  rieger:   'blood',
  prevent:  'cancer_urine',
  genoplan: 'genetics',
  laif:     'ai_prediction',
};

/**
 * 顧客未割当を表す uuid。Workflow 1 (顧客自動紐付け) が実装されるまでの暫定。
 * ここを付け替えるときは measurement_values.diagnostic_user_id も併せて更新すること。
 */
const UNASSIGNED_UID = '00000000-0000-0000-0000-000000000000';

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const MAX_FILES = 100;

export const POST: APIRoute = async ({ request }) => {
  const sb = getServerSupabase();
  if (!sb) return json({ error: 'supabase not configured' }, 503);

  const formData = await request.formData().catch(() => null);
  if (!formData) return json({ error: 'invalid form data' }, 400);

  const labCompany = String(formData.get('lab_company') ?? '');
  const testType = LAB_COMPANY_TO_TEST_TYPE[labCompany];
  if (!testType) return json({ error: 'invalid lab_company' }, 400);

  const files = formData.getAll('files').filter((v): v is File => v instanceof File);
  if (files.length === 0) return json({ error: 'no files' }, 400);
  if (files.length > MAX_FILES) return json({ error: `too many files (max ${MAX_FILES})` }, 413);

  const uploaded: {
    filename: string;
    status: 'success';
    artifact_id: string;
    backend: 's3' | 'supabase';
    /** 検査値を DB に保存できた件数 (血液 CSV のみ)。 */
    measurements?: number;
    /** 保存を見送った理由 (顧客未割当の複数人 CSV 等)。 */
    measurements_note?: string;
  }[] = [];
  const failed:   { filename: string; status: string; detail?: string }[]         = [];

  for (const file of files) {
    try {
      if (file.size > MAX_FILE_SIZE) {
        failed.push({ filename: file.name, status: 'too_large', detail: `> ${MAX_FILE_SIZE / 1024 / 1024} MB` });
        continue;
      }

      // 保存 path: lab_results/<company>/YYYY/MM/<filename>
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const storagePath = `lab_results/${labCompany}/${yyyy}/${mm}/${file.name}`;

      const isCsv = file.name.toLowerCase().endsWith('.csv');
      const isPdf = file.name.toLowerCase().endsWith('.pdf');
      const bytes = new Uint8Array(await file.arrayBuffer());

      let stored;
      try {
        stored = await putOriginal({
          key: storagePath,
          contentType:
            file.type || (isPdf ? 'application/pdf' : isCsv ? 'text/csv' : 'application/octet-stream'),
          body: bytes,
        });
      } catch (e) {
        failed.push({ filename: file.name, status: 'storage_error', detail: String(e instanceof Error ? e.message : e) });
        continue;
      }

      // test_artifacts に INSERT (顧客未割当)
      // Phase 1.0: diagnostic_user_id は仮で UNASSIGNED uuid を使う
      // (本実装では Workflow 1 の CSV 連携で割当)

      // redaction は未実装なので 'raw_pdf' (未 redaction) を書く。
      // PII 除去を実装したら、その経路でのみ 'raw_pdf_redacted' を書くこと。
      const fileKind = isCsv ? 'raw_csv' : 'raw_pdf';

      const { data: artifactRow, error: artErr } = await sb
        .schema('diagnosis')
        .from('test_artifacts')
        .insert({
          diagnostic_user_id: UNASSIGNED_UID,
          source: 'wellfort_lab',
          test_type: testType,
          schema_version: '1.0',
          display_mode: 'single',
          imported_by: 'wellfort_admin_upload',
          status: 'active',
          notes: `uploaded via /admin/lab-results/upload`,
        })
        .select('id')
        .single();
      if (artErr || !artifactRow) {
        failed.push({ filename: file.name, status: 'db_error', detail: artErr?.message ?? 'insert failed' });
        continue;
      }

      // test_artifact_files に INSERT
      const { error: fileErr } = await sb
        .schema('diagnosis')
        .from('test_artifact_files')
        .insert({
          test_artifact_id: artifactRow.id,
          file_kind: fileKind,
          storage_url: stored.storageUrl,
          // §6.1 の改竄検知要件。従来は空文字のまま保存されていた。
          sha256: stored.sha256,
          size_bytes: stored.sizeBytes,
        });
      if (fileErr) {
        failed.push({ filename: file.name, status: 'db_error', detail: fileErr.message });
        continue;
      }

      // ── 血液 CSV は検査値も DB に保存する (案A-3) ────────────────
      // 従来は S3 へ書き出すだけで DB に残らず、時系列グラフのデータ源が
      // どこにも無かった。
      let measurements: number | undefined;
      let measurementsNote: string | undefined;
      if (isCsv) {
        try {
          const parsed = buildBloodCsvBundles({
            bytes,
            sourceFileName: file.name,
            makeClientId: (i) => `upload-${artifactRow.id}-${i}`,
          });
          if (parsed.rows.length === 1) {
            const row = parsed.rows[0];
            // sb は customer/diagnosis スキーマ付きで型付けされており、構造的に
            // 突き合わせると型の展開が深くなりすぎる。書き込み先は diagnosis の
            // 2 表だけなので、必要な形へ明示的に絞ってから渡す。
            const res = await persistMeasurements(sb as unknown as SchemaClient, {
              artifactId: artifactRow.id,
              diagnosticUserId: UNASSIGNED_UID,
              testType,
              testDate: row.testDate,
              measurements: row.json.data.measurements,
              sourceFileKind: 'raw_csv',
            });
            measurements = res.rows;
            // 検査日も artifact に反映しておく (一覧・時系列の横軸に使う)
            await sb.schema('diagnosis').from('test_artifacts')
              .update({ test_date: row.testDate }).eq('id', artifactRow.id);
          } else if (parsed.rows.length > 1) {
            // 1 ファイルに複数人分が入っている。どの artifact が誰の分かは
            // Workflow 1 (顧客自動紐付け) が決めるため、ここでは保存しない。
            measurementsNote = `${parsed.rows.length} 人分を含む CSV のため検査値の保存を見送り (顧客割当が必要)`;
          } else {
            measurementsNote = '検査値を抽出できませんでした';
          }
        } catch (e) {
          measurementsNote = `検査値の保存に失敗: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      uploaded.push({
        filename: file.name,
        status: 'success',
        artifact_id: artifactRow.id,
        backend: stored.backend,
        ...(measurements != null ? { measurements } : {}),
        ...(measurementsNote ? { measurements_note: measurementsNote } : {}),
      });
    } catch (err) {
      failed.push({ filename: file.name, status: 'exception', detail: String(err) });
    }
  }

  return json({ lab_company: labCompany, uploaded, failed }, failed.length > 0 ? 207 : 200);
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
