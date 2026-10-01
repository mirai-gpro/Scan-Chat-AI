/**
 * **書いて・読み戻して・突合する**だけの共通 helper。
 *
 * 正本: `docs/specs/special_account_management_spec_20261001.md` §9.6（**D-1・確定**）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【なぜ要るか】納品の書き込み方が 2 つあり、挙動が違った
 * ══════════════════════════════════════════════════════════════════════
 *   A. `assembleElithDeliverySet` 経路 … `putFiles` の成否だけ。**読み戻しが無い**
 *   B. `deliverAdditionalJson` 経路    … PUT → GET → SHA256 突合まである
 *
 * A は uid 丸ごと、B は 1 ファイル。粒度が違うので「A のあとに B を回す」は採らない
 * （**PUT が 2 度走り、キー変換と client_id 書き換えも二重に通る**）。
 * → **書き込みの部分だけ**を切り出して、A と B の両方がここを呼ぶ。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【追加の GET は 1 ファイルあたり最大 2 回】§9.6.1
 * ══════════════════════════════════════════════════════════════════════
 *   ① 事前比較の GET（**既に同じ内容なら PUT しない**）
 *   ② PUT 後の readback GET
 * 既存と同一内容の回は **① で止まるので GET 1 回・PUT 0 回**。
 * **「1 ファイルにつき GET が 1 回増える」ではない** — 見積り（V-1）は
 * **最悪ケース = 全ファイルが新規 / 変更**（GET 2 回 + PUT 1 回）で立てる。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 【投げない】
 * ══════════════════════════════════════════════════════════════════════
 * 失敗は戻り値（`verified:false` + 理由）で返す。呼び出し側が
 * 「どのファイルが落ちたか」を結果に載せられるようにするため（§9.6.2 c）。
 * **黙って落とさない。**
 *
 * `putFiles` 自体の挙動は変えない — scan export / 問診 export / 中間 source の
 * 書き出しがそのまま使っている。**読み戻しが要るのは納品先（`user/…`）だけ**である。
 *
 * **キー変換・client_id 書き換え・サニタイズはここに持たせない。**
 * あれらはキーと中身の責務で、書き込みの責務ではない（§9.6.1）。
 */

import { getObjectText, putFiles, type S3PutFile } from './s3';
import { sha256Hex } from './originals-storage';

export interface VerifiedPutResult {
  key: string;
  /** 読み戻して SHA256 が一致したか。**PutObject の成否ではない。** */
  verified: boolean;
  /** 書こうとした中身の SHA256。 */
  sourceSha256: string;
  /** 読み戻した中身の SHA256。読めなければ null。 */
  destinationSha256: string | null;
  /** **既に同じ内容が在ったので PUT しなかった**（冪等）。 */
  skipped: boolean;
  error?: 'put_failed' | 'readback_failed' | 'readback_mismatch';
  detail?: string;
}

function utf8(s: string | Uint8Array): Uint8Array {
  return typeof s === 'string' ? new TextEncoder().encode(s) : s;
}
function msg(err: unknown): string {
  return String(err instanceof Error ? err.message : err);
}

/**
 * 1 ファイルずつ「事前比較 → PUT → 読み戻し突合」を行う。
 *
 * **1 件が落ちても残りは続ける。** 途中で投げると「どこまで書けたか」が分からなくなる。
 */
export async function putVerified(files: S3PutFile[]): Promise<VerifiedPutResult[]> {
  const out: VerifiedPutResult[] = [];
  for (const f of files) {
    const sourceSha256 = sha256Hex(utf8(f.body));

    // ① 既に同じ内容なら PUT しない（冪等・GET はここで 1 回）。
    //    読めない = まだ無い、として通常の PUT へ進む。
    let already: string | null = null;
    try {
      already = sha256Hex(utf8(await getObjectText(f.key)));
    } catch {
      already = null;
    }
    if (already && already === sourceSha256) {
      out.push({ key: f.key, verified: true, sourceSha256, destinationSha256: already, skipped: true });
      continue;
    }

    // ② 書く。
    try {
      await putFiles([f]);
    } catch (err) {
      out.push({ key: f.key, verified: false, sourceSha256, destinationSha256: null, skipped: false, error: 'put_failed', detail: msg(err) });
      continue;
    }

    // ③ **読み戻して突合するまで「納品完了」と言わない。**
    let destinationSha256: string | null = null;
    try {
      destinationSha256 = sha256Hex(utf8(await getObjectText(f.key)));
    } catch (err) {
      out.push({ key: f.key, verified: false, sourceSha256, destinationSha256: null, skipped: false, error: 'readback_failed', detail: msg(err) });
      continue;
    }
    if (destinationSha256 !== sourceSha256) {
      out.push({ key: f.key, verified: false, sourceSha256, destinationSha256, skipped: false, error: 'readback_mismatch' });
      continue;
    }
    out.push({ key: f.key, verified: true, sourceSha256, destinationSha256, skipped: false });
  }
  return out;
}

/** 落ちたファイルだけを取り出す（結果に載せて**黙って落とさない**ため）。 */
export function unverified(results: VerifiedPutResult[]): VerifiedPutResult[] {
  return results.filter((r) => !r.verified);
}
