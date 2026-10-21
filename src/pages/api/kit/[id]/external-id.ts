import type { APIRoute } from 'astro';
import { resolveViewer } from '../../../../lib/viewer';
import { denyReadOnlyWrite, denyForShare, denyAnonymous } from '../../../../lib/write-guard';
import { getServerSupabase } from '../../../../lib/supabase';
import { cfg, cfgBool, refreshConfig } from '../../../../lib/app-config';
import {
  evaluateExternalId, isExternalIdProvider, providerMatchesTestType,
  type CaptureMethod, type ExternalIdProvider,
} from '../../../../lib/external-test-id';
import { createEvidenceTicket, fetchEvidence } from '../../../../lib/external-id-evidence';
import { readExternalIdFromImage } from '../../../../lib/external-id-read';
import { persistExternalIdCapture, expectedTestType } from '../../../../lib/external-id-persist';

export const prerender = false;

/**
 * 受取時・外部検査ID の 撮影 → 読取 → 登録。
 *
 * 正本: `docs/lab/kit_receipt_external_id_capture_spec.md`。
 * `:id` は **受取確認と同じ ID**（dev=`kit_shipments.id` / 本番=`orders.id`）。
 * `api/kit/[id]/self-report.ts` と**同じ軸**なので、別系統の識別子を増やさない。
 *
 * mode:
 *   'ticket'   … 証跡画像の presigned PUT を発行（**ファイル本体は関数を通さない**）
 *   'read'     … S3 の画像を Gemini で読み、**候補だけ**返す（DB は 1 バイトも書かない）
 *                 **読み取りが成功したかは発行元の接頭辞（`704`＝Wellfort）でも見る**
 *                 （`labid.prevent_org_prefix`・外れたら `org_prefix_mismatch`）。
 *   'register' … ユーザーが確認した値を確定して登録（台帳 ＋ `lab_tests` 紐付け）
 *
 * 【認可は `self-report.ts:26-40` の 3 段ガードをそのまま使う。新しい認可を発明しない】
 *   - 代理表示中は書かせない（`denyReadOnlyWrite`）
 *   - 共有閲覧からは叩かせない（`denyForShare`）
 *   - 未認証も止める（`denyAnonymous`）
 *   - **対象ユーザーは `viewer.writeTargetUid` が決める。body の uid を認可根拠にしない**
 *     （§21.1 で「他人の uid を書けばその人の配送状態を変えられた」として明示的に禁止）。
 *
 * 【`read` も書き込み扱いでガードする】
 * Gemini を回すので**費用が出る**し、他人の受取 ID を指定して画像を読ませる余地を残さない。
 */
export const POST: APIRoute = async (ctx) => {
  const { params, request } = ctx;

  const viewer = await resolveViewer(ctx);
  const denied = denyReadOnlyWrite(viewer);
  if (denied) return denied;
  const shared = denyForShare(viewer);
  if (shared) return shared;
  const unauth = denyAnonymous(viewer);
  if (unauth) return unauth;

  const shipmentRef = params.id;
  if (!shipmentRef || !/^[0-9a-f-]{36}$/i.test(shipmentRef)) {
    return json({ ok: false, error: 'invalid_shipment_id' }, 400);
  }

  const uid = viewer.writeTargetUid;
  if (!uid || !/^[0-9a-f-]{36}$/i.test(uid)) {
    return json({ ok: false, error: 'missing_or_invalid_target' }, 400);
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);

  const mode = typeof body.mode === 'string' ? body.mode : '';
  const provider = body.provider;
  if (!isExternalIdProvider(provider)) {
    return json({ ok: false, error: 'unknown_provider' }, 400);
  }

  // app_config を**処理の前に**読む（CLAUDE.md: 各 API は処理前に refreshConfig を呼ぶ）。
  await refreshConfig().catch(() => undefined);

  // **この検査の撮影が有効化されているか。** 既定 off なので、実物の書面を確認するまで
  // 誰にも出ない（UI だけ隠して API を開けたままにしない）。
  if (!captureEnabled(provider)) {
    return json({ ok: false, error: 'capture_disabled', detail: 'この検査の受取時ID撮影は有効化されていません' }, 403);
  }

  // provider と test_type の整合（仕様 §6.3）。test_type は送られてきたときだけ見る。
  if (body.testType != null && !providerMatchesTestType(provider, body.testType)) {
    return json({ ok: false, error: 'provider_test_type_mismatch' }, 400);
  }

  if (mode === 'ticket') {
    const r = await createEvidenceTicket({ contentType: body.contentType, bytes: body.bytes });
    if (!r.ok) return json({ ok: false, error: r.error, detail: r.detail }, r.status);
    return json({
      ok: true, mode, upload_url: r.url, key: r.key,
      headers: r.headers, expires_in: r.expiresIn,
    });
  }

  if (mode === 'read') {
    const got = await fetchEvidence(body.evidenceKey);
    if (!got.ok) return json({ ok: false, error: got.error }, got.status);

    const read = await readExternalIdFromImage({
      provider,
      mime: got.mime,
      base64: got.base64,
      apiKey: apiKey(),
    });
    if (!read.ok) {
      // **行き止まりにしない。** 読めなかったことを伝えて、手入力へ落とせるようにする。
      return json({
        ok: false, error: read.error ?? 'read_failed',
        detail: '画像から番号を読み取れませんでした。撮り直すか、番号を手で入力してください。',
        note: read.note,
      }, 422);
    }

    const ev = evaluateExternalId({
      provider,
      barcode: read.barcode,
      ocr: read.printed,
      expectedPattern: patternFor(provider),
      orgPrefix: orgPrefixFor(provider),
    });
    if (!ev.ok) {
      return json({
        ok: false, error: 'no_readable_value',
        detail: '番号として読み取れませんでした。撮り直すか、番号を手で入力してください。',
        note: read.note,
      }, 422);
    }

    // **候補を返すだけ。ここでは確定しない**（確定はユーザーの確認操作のあと）。
    // **全文を返すのは確認画面のためで、ここが唯一の露出点**（ログには出さない）。
    return json({
      ok: true, mode,
      candidate: ev.value,
      status: ev.status,
      decode_method: ev.decodeMethod,
      review_reasons: ev.reasons,
      /*
       * **発行元の接頭辞を画面へ返す。** 利用者が手元の用紙で確かめられるように、
       * 「704 で始まります」と具体的に言うため。**秘密ではない** — 同じ値が
       * 本人の台紙に印字されているし、画面の図（ダミー `704000123`）にも出ている。
       * 既定値をクライアントに焼かないので、**app_config を変えれば文言も追従する**。
       */
      org_prefix: orgPrefixFor(provider),
      note: read.note,
    });
  }

  if (mode === 'register') {
    const captureMethod = normalizeCaptureMethod(body.captureMethod);
    if (!captureMethod) return json({ ok: false, error: 'invalid_capture_method' }, 400);

    // **ユーザーが画面で確認した値**を採る。manual は手入力補正。
    const ev = evaluateExternalId({
      provider,
      barcode: body.barcode,
      ocr: body.printed,
      manual: body.manual,
      expectedPattern: patternFor(provider),
      orgPrefix: orgPrefixFor(provider),
    });
    if (!ev.ok) {
      return json({ ok: false, error: 'no_readable_value', detail: '登録できる番号がありません' }, 400);
    }

    const sb = getServerSupabase();
    if (!sb) return json({ ok: false, error: 'supabase_not_configured' }, 503);

    const saved = await persistExternalIdCapture({
      sb,
      diagnosticUserId: uid,
      shipmentRef,
      provider,
      testType: expectedTestType(provider),
      value: ev.value,
      status: ev.status,
      captureMethod,
      decodeMethod: ev.decodeMethod,
      reviewReasons: ev.reasons,
      evidenceKey: typeof body.evidenceKey === 'string' ? body.evidenceKey : null,
    });
    if (!saved.ok) {
      return json({ ok: false, error: saved.error, detail: saved.detail }, saved.status);
    }

    const rec = saved.record;
    return json({
      ok: true, mode,
      // **外部IDの全文は返さない**（末尾 4 桁のマスクだけ・仕様 §6.1）。
      masked: rec.masked,
      status: rec.status,
      review_reasons: rec.reviewReasons,
      linked: rec.labTestLinkStatus === 'linked',
      // 利用者には一般化した案内だけ。`conflict` の中身（他人の検査の存在）は漏らさない。
      message: userMessage(rec.status, rec.labTestLinkStatus),
    });
  }

  return json({ ok: false, error: 'unknown_mode' }, 400);
};

function captureEnabled(provider: ExternalIdProvider): boolean {
  return provider === 'prevent'
    ? cfgBool('labid.prevent_capture')
    : cfgBool('labid.demecal_capture');
}

function patternFor(provider: ExternalIdProvider): string {
  return provider === 'prevent' ? cfg('labid.prevent_pattern') : cfg('labid.demecal_pattern');
}

/**
 * 発行元（法人）の接頭辞。**`704` は Wellfort 法人を表す**（先方の説明・2026-10-21）。
 * デメカルはこの概念を確認していないので空＝判定しない。
 */
function orgPrefixFor(provider: ExternalIdProvider): string {
  return provider === 'prevent' ? cfg('labid.prevent_org_prefix') : '';
}

function normalizeCaptureMethod(v: unknown): CaptureMethod | null {
  return v === 'camera' || v === 'file' || v === 'manual' ? v : null;
}

/**
 * 利用者に出す文。**`review_required` を「失敗」に見せない** —
 * 登録は済んでいて、確認が要るだけ。行き止まりにしない。
 */
function userMessage(status: string, link: string): string {
  if (link === 'conflict') {
    return 'この番号は登録できませんでした。お手数ですが事務局へお問合せください。';
  }
  if (status === 'confirmed' && link === 'linked') {
    return '受取確認が完了しました。';
  }
  return '受取確認を登録しました。番号は事務局で確認します。';
}

function apiKey(): string | undefined {
  const fromMeta = (import.meta.env as Record<string, string | undefined>).GEMINI_API_KEY;
  return fromMeta || process.env.GEMINI_API_KEY;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
