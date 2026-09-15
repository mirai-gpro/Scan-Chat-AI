/**
 * スキャン結果を Elith 連携用に S3 へ書き出す **唯一の入口**。
 *
 * 【なぜ切り出したか】
 * 送信をバックグラウンド化した (P2〜P5) 結果、書き出しの起点が 2 つになった:
 *   ① 前景経路 … 結果画面の「✓ 確認して送信」→ `/api/scan/export`
 *   ② 背景経路 … cron ワーカーが全ページ読み終わった時点
 * ②を足したときに①だけが納品 JSON を書く状態になり、**S3 のキーが揃った回
 * (= 背景で読まれた回) だけ Elith への納品が出ない**という食い違いが生まれた。
 * 「納品整形は 1 箇所に集約」の規律と同じで、**書き出しも 1 箇所**に寄せる。
 *
 * ここは **S3 へ置くところだけ**を持つ。Markdown → JSON の変換と命名は
 * `scan-export.ts` (純関数) が持ち、こちらはそれを呼ぶだけ。
 */
import { buildScanExportBundle, type ScanExportMeta } from './scan-export';
import { getS3Config, isS3Configured, putFiles } from './s3';

export interface ScanExportResult {
  /** S3 へ実際に置けたか。未設定 (ドライラン) と失敗は false。 */
  ok: boolean;
  /** S3 が設定されているか。false = ドライラン (変換だけ行った)。 */
  configured: boolean;
  bucket?: string;
  region?: string;
  folder: string;
  uploaded?: { key: string; bytes: number; uri: string }[];
  files?: { name: string; bytes: number; contentType: string }[];
  json: unknown;
  error?: string;
}

/**
 * 確定 Markdown を Elith 納品用の JSON/MD にして S3 へ置く。
 *
 * **投げない。** 呼び出し側 (ワーカー) は書き出しに失敗しても
 * 検査結果の保存まで巻き戻したくないので、失敗は戻り値で伝える。
 */
export async function putScanExport(
  markdownClean: string,
  meta: ScanExportMeta,
): Promise<ScanExportResult> {
  const cfg = getS3Config();
  const bundle = buildScanExportBundle(markdownClean, meta, cfg?.prefix ?? '');

  if (!isS3Configured() || !cfg) {
    return {
      ok: false,
      configured: false,
      folder: bundle.folder,
      files: bundle.files.map((f) => ({ name: f.name, bytes: f.bytes, contentType: f.contentType })),
      json: bundle.json,
      error: 's3_not_configured',
    };
  }

  try {
    const uploaded = await putFiles(bundle.files);
    return {
      ok: true,
      configured: true,
      bucket: cfg.bucket,
      region: cfg.region,
      folder: bundle.folder,
      uploaded,
      json: bundle.json,
    };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      folder: bundle.folder,
      json: bundle.json,
      error: String(err),
    };
  }
}
