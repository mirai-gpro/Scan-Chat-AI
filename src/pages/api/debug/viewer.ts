/**
 * **admin 判定が成立しない原因を、推測せずに切り分けるための口。**
 *
 * 【なぜ戻したか】2026-08-30 に「原因が判明したので用済み」として撤去したが、
 * その直後に admin 判定の作り直し (ベタ書き名簿の撤去 → 管理者リスト参照) で
 * **本番の admin が復帰せず、観測手段が無いまま何往復も推測を重ねた**。
 * 判定は**静かに外れる**ので、口が無いと画面からは何も分からない。撤去が早計だった。
 *
 * 【認可】`?k=<PROBE_UPLOAD_TOKEN>`。**匿名では答えない** — 以前は認証なしで
 * env の設定有無と DB 行数が読めていた (2026-08-30 に指摘)。
 * 使い捨ての運用トークンなので、済んだら env ごと閉じられる。
 *
 * 【出すもの】値そのものは出さない。**在るか無いか / 判定の結果と根拠**だけ。
 *   - Cookie: 在るか / 検証を通るか / 何分割か / admin フラグ
 *   - viewer: uid / isAdmin / adminBy / cookieStale
 *   - env: 判定に要る設定が入っているか (値は出さない)
 *   - `?email=` を付けると **HP Edge の resolve-customer を実際に叩いて**
 *     `is_admin` が返るかを確認する (管理者リストまで届いているかの決定打)。
 */

import type { APIRoute } from 'astro';
import { VIEWER_COOKIE, resolveViewer, uidEntryAllowed, verifyViewer } from '../../../lib/viewer';
import { publicOrigin } from '../../../lib/public-url';
import { isHpEdgeConfigured, resolveCustomerWithAdmin } from '../../../lib/hp-edge';
import { demoFallbackEnabled } from '../../../lib/demo-data';
import { demoAccountStats } from '../../../lib/demo-accounts';
import { isSpecialAccount, specialAccountStats } from '../../../lib/special-accounts';
import { loadReportVM } from '../../../lib/elith-report-queries';
import { refreshConfig } from '../../../lib/app-config';
import { getServerSupabase, isBridgeConfigured, type BridgeOrigin } from '../../../lib/supabase';

export const prerender = false;

function env(name: string): string | undefined {
  const m = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
  if (m != null && m !== '') return m;
  const p = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return p != null && p !== '' ? p : undefined;
}

const has = (n: string) => (env(n) ? '設定あり' : '(未設定)');

export const GET: APIRoute = async (ctx) => {
  const expected = env('PROBE_UPLOAD_TOKEN');
  if (!expected) {
    return json({ ok: false, error: 'disabled', detail: 'PROBE_UPLOAD_TOKEN 未設定 (既定 off)' }, 503);
  }
  if ((ctx.url.searchParams.get('k') ?? '').trim() !== expected) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const raw = ctx.cookies.get(VIEWER_COOKIE)?.value ?? null;
  const verified = await verifyViewer(raw);
  const viewer = await resolveViewer(ctx);

  /*
   * `?email=` があれば **HP Edge を実際に叩く**。
   * ここが「管理者リストまで届いているか」の決定打で、
   * Cookie の状態とは独立に確かめられる。
   */
  let edge: Record<string, unknown> | null = null;
  const email = (ctx.url.searchParams.get('email') ?? '').trim().toLowerCase();
  if (email) {
    if (!isHpEdgeConfigured()) {
      edge = { called: false, reason: 'HP_EDGE_BASE_URL 未設定' };
    } else {
      try {
        const r = await resolveCustomerWithAdmin(email);
        edge = {
          called: true,
          // 顧客が引けたか。**admin 判定とは独立** (管理者 ≠ EC の顧客)。
          customer_resolved: !!r.customer,
          customer_note: r.customer ? null : 'Wellfort 側 customer_profiles に該当なし / 退会',
          // 管理者リスト (admin_users) の答え。氏名や uid は出さない。
          is_admin: r.isAdmin,
          /*
           * false だったときの内訳。**「載っていない」と「引けなかった」を区別する。**
           *   readable:false      → 権限/スキーマ側の問題 (コードで直す)
           *   active_count:0      → リスト自体が空
           *   matched:false かつ active_count>0 → この email が載っていないだけ
           */
          admin_lookup: r.adminLookup ?? '(旧 Edge Function・内訳なし)',
        };
      } catch (e) {
        edge = { called: true, error: e instanceof Error ? e.message : String(e) };
      }
    }
  }

  /*
   * **AI疾病予防報告書が「なぜその紙面になっているか」を 1 回で確定する。**
   *
   * 「モックと違う」の原因は 3 つに分かれ、**画面を見ただけでは区別できない**:
   *   ① デモが出ていない        → 紙面は emptyVM (ダイジェスト 1 枚・全編 0 章)
   *   ② 旧 seed 行が最新        → 2 セクション 200 字の痩せた紙面 (spec §4.5.1)
   *   ③ 現行形式の実データが在る → **モックとは違って当然** (モックは 2026-08-26 検体の紙面)
   * 行の有無だけを見て「データは在る」と判断しない、が 2026-08-30 の教訓。
   */
  const report = await inspectReport(viewer.uid, viewer.origin);
  /*
   * 「この検査だけ画面に出ない」の切り分け用。**カードは種別ごとに常に描かれる**
   * (`TestResultsSection.astro`) ので、空に見えるのは行が無いときだけ。
   * 種別と件数しか出さない (PII を載せない)。
   */
  const artifacts = await inspectArtifacts(viewer.uid, viewer.origin);
  /*
   * 「キットの進捗が空」の切り分け。`loadDashboard` は bridge の失敗を空へ畳むので、
   * 画面だけでは「顧客が居ない」と「呼び出しが失敗した」を区別できない。
   */
  const bridge = await inspectBridge(viewer.uid, viewer.origin);
  /*
   * **「AI 問診を完了したのに進捗が『未実行』」の切り分け** (実障害 2026-09-23)。
   *
   * 画面は「未実行」としか言わないので、原因が
   *   ① 記録が無い (書き出しが届かなかった / migration 未適用)
   *   ② 記録はあるが**別の uid**で入っている (代理表示 `?u=` のとき読む側とずれる)
   * のどちらかを区別できない。**表示中の uid と本人の uid の両方**を引いて並べる。
   *
   * 出すのは**件数と日時だけ**。回答の中身は引かない (医療情報なので保管場所を増やさない)。
   */
  const interview = await inspectInterview(viewer.uid, viewer.selfUid);
  /*
   * **「5 年分アップしたのに Elith 納品が 1 年分に潰れる」の切り分け** (honda・2026-09-25)。
   * Elith 納品は `date/{YYYY_MM_DD}/` 単位なので、5 つの JSON には **5 通りの受診日** が要る。
   * `materializeHealthCheckups` と同じ条件 (active・scan_md あり・測定値 >0) で
   * health_checkup を全件引き、**受診日が何通りあるか (= 納品される JSON 数)** を出す。
   * 日付だけ (PII 非含有)。
   */
  const healthCheckupYears = await inspectHealthCheckupYears(viewer.uid);

  return json({
    ok: true,
    build: (env('VERCEL_GIT_COMMIT_SHA') ?? 'local').slice(0, 7),
    /*
     * QR がプロキシ内側の URL になっていないかの確認 (2026-09-04 の不具合)。
     * request_origin と public_origin がずれるのが正常 (Vercel は転送ヘッダを付ける)。
     * QR に使うのは public_origin のほう。
     */
    origin: {
      request_origin: new URL(ctx.request.url).origin,
      public_origin: publicOrigin(ctx.request),
      x_forwarded_host: ctx.request.headers.get('x-forwarded-host') ?? '(なし)',
      x_forwarded_proto: ctx.request.headers.get('x-forwarded-proto') ?? '(なし)',
      host: ctx.request.headers.get('host') ?? '(なし)',
    },
    report,
    artifacts,
    health_checkup_years: healthCheckupYears,
    bridge,
    interview,
    cookie: {
      present: !!raw,
      valid: !!verified,
      parts: raw ? raw.split('.').length : 0,
      format: verified
        ? (verified.legacy
            ? '旧 3 分割 (admin フラグ無し)'
            : verified.origin === 'staging' ? '5 分割 (staging 印つき)' : '4 分割')
        : null,
      admin_flag: verified ? verified.admin : null,
    },
    viewer: {
      uid: viewer.uid,
      self_uid: viewer.selfUid,
      is_admin: viewer.isAdmin,
      admin_by: viewer.adminBy,
      impersonating: viewer.impersonating,
      /**
       * **どちらの HP/EC 環境で解決されたか** (Cookie の署名に含まれる)。
       * staging の EC で購入した検体を本番の Web アプリで見るとき、ここが `staging` に
       * なっていないと bridge は production を読む = キット進捗が空になる (2026-09-11)。
       */
      origin: viewer.origin,
      /** true なら GoogleOneTap が refresh-admin を呼ぶ (タブ + ビルド版ごとに 1 回)。 */
      cookie_stale: viewer.cookieStale,
    },
    env: {
      // admin 判定に要るもの。**値は出さない。**
      HP_EDGE_BASE_URL: has('HP_EDGE_BASE_URL'),
      RESOLVE_SHARED_SECRET: has('RESOLVE_SHARED_SECRET'),
      PUBLIC_GOOGLE_CLIENT_ID: has('PUBLIC_GOOGLE_CLIENT_ID'),
      APP_SESSION_SECRET: has('APP_SESSION_SECRET'),
      SUPABASE_SERVICE_ROLE_KEY: has('SUPABASE_SERVICE_ROLE_KEY'),
      PUBLIC_DEMO_FALLBACK: env('PUBLIC_DEMO_FALLBACK') ?? '(未設定)',
      ALLOW_UID_ENTRY: uidEntryAllowed() ? 'on' : '(off/未設定)',
    },
    edge,
    /*
     * **Cookie の admin と、管理者リストの答えが食い違っていないか。**
     *
     * Cookie はサインイン時にしか発行されず有効期間 30 日なので、
     * 判定を変えても**既に admin=1 を持っている人は当面 admin のまま動く**。
     * その間は「直っているように見えて直っていない」= 期限切れで静かに失う。
     * 逆向き (Cookie=false / リスト=true) は次のサインインか自己修復で解消する。
     */
    warning: edge && typeof (edge as { is_admin?: unknown }).is_admin === 'boolean'
      && viewer.isAdmin !== (edge as { is_admin: boolean }).is_admin
      ? (viewer.isAdmin
          ? 'Cookie は admin だが管理者リストは admin ではない。'
            + 'いま admin として動いているのは古い Cookie の残存効果で、期限切れ (最長30日) で失う。'
            + 'admin_lookup を見て、リストに載っていないのか照会が失敗しているのかを切り分けること。'
          : 'Cookie は admin でないが管理者リストは admin。'
            + '次のサインイン、または cookie_stale による自己修復で解消する。')
      : null,
    hint: '?email=<サインインに使っている Google アカウント> を足すと、'
      + '管理者リストまで届いているかを直接確認できる。',
  });
};

/**
 * 報告書の「材料」と「出来上がった紙面」を並べて返す。**PII は出さない**
 * (氏名は渡さず、本文も出さず、件数と字数だけ)。
 */
/**
 * **キット進捗が空のときの切り分け。**
 *
 * 画面 (`/kit`・ダッシュボード) は「顧客が居ない」でも「bridge の呼び出しが失敗した」でも
 * 同じ空表示になるので、区別できるのはここだけ。`loadDashboard` は失敗を空へ畳むため、
 * **`loadBridgeBundle` を直接呼んで生の結果を見る**。
 *
 * **出すのは件数と真偽だけ** — 氏名・住所・注文番号・secret は 1 文字も載せない。
 */
async function inspectBridge(viewerUid: string | null, origin: BridgeOrigin): Promise<Record<string, unknown>> {
  const configured = isBridgeConfigured(origin);
  const out: Record<string, unknown> = {
    origin,
    /** staging = Edge Function 経由 / production = app_bridge へ直接 (2026-09-11 確定)。 */
    transport: origin === 'staging' ? 'edge-function (get-bridge-bundle)' : 'supabase (app_bridge)',
    configured,
  };
  if (!configured) {
    out.note = origin === 'staging'
      ? 'HP_BRIDGE_STAGING_FUNCTION_URL / HP_BRIDGE_STAGING_SHARED_SECRET が未設定 → 顧客・プラン・キットは空になる'
      : 'HP_BRIDGE_SUPABASE_URL / HP_BRIDGE_READONLY_KEY が未設定 → 顧客・プラン・キットは空になる';
    return out;
  }
  if (!viewerUid) { out.note = 'uid が無い (未サインイン)'; return out; }
  try {
    const { loadBridgeBundle } = await import('../../../lib/bridge-queries');
    const b = await loadBridgeBundle(viewerUid, origin);
    if ('error' in b) { out.ok = false; out.error = b.error; return out; }
    out.ok = true;
    out.customer = !!b.customer;
    out.subscription = !!b.subscription;
    out.shipments = b.shipments.length;
    if (!b.customer) out.note = 'bridge は応答したが該当顧客が居ない (別環境で購入した / 未連携)';
  } catch (e) {
    out.ok = false;
    out.error = e instanceof Error ? e.message : String(e);
  }
  return out;
}

async function inspectReport(viewerUid: string | null, origin: BridgeOrigin): Promise<Record<string, unknown>> {
  await refreshConfig();

  /*
   * **`/report` と同じ uid で見る。**
   * 画面は `loadDashboard()` が解決した `diagnosticUserId` を使う (Cookie の uid そのままとは
   * 限らない)。ここで Cookie の uid を直に使うと、**画面と違う答えを出す診断**になる。
   */
  let uid = viewerUid;
  try {
    const { loadDashboard } = await import('../../../lib/dashboard-queries');
    const r = await loadDashboard(viewerUid, origin);
    if (r && !('error' in r)) uid = r.diagnosticUserId;
  } catch { /* 解決できなければ Cookie の uid のまま見る */ }

  /*
   * **デモの資格は uid だけで決まる** (`demo-accounts.ts`)。admin は見ない。
   * 出ない場合の直し方が 1 つしかないので、理由も 1 通りで済む。
   */
  const demo = demoFallbackEnabled(uid);

  /*
   * **スペシャルアカウント (EC 購入を伴わない招待・本人の実データ)。**
   * `docs/operations/スペシャルアカウント_仕様書.md` §13 — デモと**並べて**出す。
   *   is_special:true かつ demo_enabled(=using_demo_data):true → §7 の 1 行が効いていない。即座に調べる
   *   is_special:false なのに入れない → 登録が反映されていない (TTL 45 秒 / uid 未採番)
   */
  const special = isSpecialAccount(uid);

  const out: Record<string, unknown> = {
    effective_uid: uid,
    is_special: special,
    special_accounts: specialAccountStats(),
    special_reason: special
      ? '実データの枠 — ダミーは出ない (demo_enabled は必ず false になる)'
      : 'スペシャル枠ではない。登録は wellfort-site admin → 設定「スペシャルアカウント」',
    demo_enabled: demo,
    demo_accounts: demoAccountStats(),
    demo_reason: demo
      ? '出す — uid がデモ用アカウントの一覧にある'
      : '出さない → 紙面は emptyVM になる。'
        + ' admin かどうかは関係ない。この uid をデモ用アカウントに登録すること'
        + ' (wellfort-site admin → 設定「デモ」→「デモ用アカウントの uid」)',
  };

  const sb = getServerSupabase();
  if (!sb || !uid) {
    out.rows = sb ? 0 : '(Supabase 未設定)';
  } else {
    try {
      const { data, error } = await (sb.schema('diagnosis') as any)
        .from('diagnosis_results')
        .select('report, received_at, schema_version, status')
        .eq('diagnostic_user_id', uid)
        .neq('status', 'superseded')
        .not('report', 'is', null)
        .order('received_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      const row = (data ?? [])[0];
      if (!row) {
        out.rows = 0;
        out.note = '実データなし → サンプルの紙面が出る (デモが有効なら)';
      } else {
        const rep = row.report;
        // 旧形式 = セクションの配列 (`elith-v1.0`)。現行形式 = dict。
        const legacy = Array.isArray(rep);
        const chars = legacy
          ? rep.reduce((n: number, s: any) => n + String(s?.body ?? s?.text ?? '').length, 0)
          : Object.values(rep ?? {}).reduce(
              (n: number, v: any) => n + String(typeof v === 'string' ? v : v?.text ?? '').length, 0);
        out.rows = 1;
        out.latest_received_at = String(row.received_at).slice(0, 10);
        out.schema_version = row.schema_version ?? null;
        out.shape = legacy ? '旧形式 (配列・elith-v1.0)' : '現行形式 (dict)';
        out.sections = legacy ? rep.length : Object.keys(rep ?? {}).length;
        out.chars = chars;
        out.verdict = legacy
          ? (demo
              ? '旧 seed 行だが、デモが有効なので現行サンプルへ差し替わる (spec §4.5.1)'
              : '旧 seed 行がそのまま紙面になる → 痩せた紙面。デモを有効にすれば直る')
          : chars < 2000
            ? '現行形式だが中身が薄い。紙面が薄いのは実装ではなく行の中身'
            : '現行形式の実データ。**モックと違って当然** (モックは 2026-08-26 検体の紙面)';
      }
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e);
    }
  }

  /*
   * **実際に組み上がる表示モデル**。ここが最終的な答えで、
   * 「材料はこうで、紙面はこうなった」を並べて見せる。
   */
  try {
    const vm = await loadReportVM({
      diagnosticUserId: uid,
      name: '',
      chronologicalAge: null,
      ourWellnessAge: null,
      hasCancerRisk: false,
      cycleSeq: null,
    });
    out.sheet = {
      is_sample: vm.isSample,
      type: vm.reportType,
      digest_cards: vm.digest.length,
      chapters: vm.chapters.length,
      // モックの紙面はダイジェスト 7 枚・全編 10 章 (spec §4.5.1 の実測)。
      matches_mock_shape: vm.digest.length >= 7 && vm.chapters.length >= 10,
    };
  } catch (e) {
    out.sheet = { error: e instanceof Error ? e.message : String(e) };
  }
  return out;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * 検査アーティファクトの種別ごとの件数。**「カードが空」の原因切り分け専用**。
 *
 * ダッシュボードは 5 種類のカードを常に描き、その種別の行が 0 件だと中身だけ空になる。
 * 画面を見ても「行が無い」のか「描画が壊れている」のか区別できないので、ここで数える。
 *
 * **`loadDashboard()` の結果をそのまま見る。** Cookie の uid を直に使って DB を
 * 引き直すと、デモのフォールバック (別 uid の実データ / 組込みダミー) を通らないので
 * **画面と違う答えを出す診断**になる (inspectReport と同じ理由)。
 * 出すのは **種別と件数と日付だけ** (PII を載せない)。
 */
async function inspectArtifacts(viewerUid: string | null, origin: BridgeOrigin): Promise<Record<string, unknown>> {
  const KINDS = ['health_checkup', 'blood', 'cancer_urine', 'ai_prediction', 'genetics'];
  try {
    const { loadDashboard } = await import('../../../lib/dashboard-queries');
    const r = await loadDashboard(viewerUid, origin);
    if (!r || 'error' in r) return { error: r && 'error' in r ? r.error : '取得できず' };

    const rows = r.artifacts ?? [];
    const sb = getServerSupabase();
    const byKind: Record<string, unknown> = {};
    for (const k of KINDS) {
      const mine = rows.filter((a) => a.test_type === k);
      if (mine.length === 0) { byKind[k] = '0 件 → カードは空になる'; continue; }
      /*
       * 「カードには出るのに結果ページが空」の切り分け。/result/[id] が見せるのは
       * ①原本ファイル ②(無ければ)種別ごとのサンプル PDF の 2 つだけなので、
       * **原本が何件あるか**が分かれば、空の原因が特定できる。
       * 測定値は将来の表示候補として件数だけ見る。中身は出さない (PII を載せない)。
       */
      let files = '(未確認)';
      let meas = '(未確認)';
      if (sb) {
        try {
          const { count } = await (sb.schema('diagnosis') as any)
            .from('test_artifact_files').select('*', { count: 'exact', head: true })
            .eq('artifact_id', mine[0].id);
          files = `${count ?? 0} 件`;
        } catch { files = '(エラー)'; }
        try {
          const { count } = await (sb.schema('diagnosis') as any)
            .from('measurement_values').select('*', { count: 'exact', head: true })
            .eq('artifact_id', mine[0].id);
          meas = `${count ?? 0} 件`;
        } catch { meas = '(テーブル無し/エラー)'; }
      }
      byKind[k] = `${mine.length} 件 (最新 ${String(mine[0].test_date).slice(0, 10)} / ${mine[0].source} / ${mine[0].status})`
        + ` — 最新の 原本ファイル ${files} / 測定値 ${meas}`;
    }
    const other = [...new Set(rows.filter((a) => !KINDS.includes(a.test_type)).map((a) => a.test_type))];
    return {
      total: rows.length,
      /** どこから来た検査データか。demo なら真鍋(DEFAULT_USER)か組込みダミー。 */
      result_uid: r.resultUid,
      using_demo_data: r.usingDemoData,
      by_test_type: byKind,
      ...(other.length ? { 画面に出ない種別: other } : {}),
    };
  } catch (err) {
    return { error: String(err instanceof Error ? err.message : err) };
  }
}

/**
 * **複数年スキャンが Elith 納品で何年分に展開されるかを直接見る。**
 *
 * `materializeHealthCheckups` (elith-delivery) と**同じ条件**で `test_artifacts` を引き、
 * 受診日 (test_date) が何通りあるかを数える。Elith 納品は `date/{YYYY_MM_DD}/` 単位なので、
 * **納品される HealthCheckupData JSON の数 = 受診日の distinct 数**。
 * 5 年分アップしたのに 1 通りしか無ければ、受診日が読めず今日の日付で畳まれている
 * (§4.3-1 のガード対象)。日付と件数だけ (PII 非含有)。
 */
async function inspectHealthCheckupYears(uid: string | null): Promise<Record<string, unknown>> {
  if (!uid) return { note: '(uid なし)' };
  const sb = getServerSupabase();
  if (!sb) return { note: '(Supabase 未設定)' };
  try {
    const { measurementsFromMarkdown } = await import('../../../lib/elith-export');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (sb.schema('diagnosis') as any)
      .from('test_artifacts')
      .select('test_date, scan_md, status, created_at')
      .eq('diagnostic_user_id', uid)
      .eq('test_type', 'health_checkup')
      .eq('status', 'active')
      .order('test_date', { ascending: false })
      .limit(20);
    const rows: Array<{ test_date?: string | null; scan_md?: string | null; created_at?: string | null }> =
      Array.isArray(data) ? data : [];
    if (rows.length === 0) return { active_rows: 0, note: 'health_checkup の active 行が無い' };

    const folders = new Set<string>();
    let deliverable = 0;
    let emptyMd = 0;
    let zeroMeas = 0;
    const perRow = rows.map((r) => {
      const md = typeof r.scan_md === 'string' ? r.scan_md : '';
      const hasMd = !!md.trim();
      const meas = hasMd ? measurementsFromMarkdown(md).kept.length : 0;
      const readable = /^\d{4}-\d{2}-\d{2}$/.test(String(r.test_date ?? ''));
      const folder = readable ? String(r.test_date).replace(/-/g, '_') : '(受診日なし→今日で保存)';
      if (!hasMd) emptyMd += 1;
      else if (meas === 0) zeroMeas += 1;
      else { deliverable += 1; folders.add(folder); }
      return { test_date: r.test_date ?? null, scan_md: hasMd, measurements: meas };
    });
    return {
      active_rows: rows.length,
      // 実際に Elith へ出る JSON 数 (= 受診日の distinct 数)。
      distinct_test_dates: folders.size,
      json_will_be_delivered: folders.size,
      deliverable_rows: deliverable,
      skipped_empty_scan_md: emptyMd,
      skipped_zero_measurements: zeroMeas,
      rows: perRow,
      hint:
        folders.size < deliverable
          ? '受診日が重複 (同じ日付/受診日なし) している回がある = 年が畳まれて 1 JSON に潰れる'
          : '受診日は年ごとに分かれている',
    };
  } catch (err) {
    return { error: String(err instanceof Error ? err.message : err) };
  }
}

/**
 * **AI 問診の完了記録を、表示中の uid と本人の uid の両方で引く。**
 *
 * `diagnosis.interview_completions` は
 *   ・**書く**のは `viewer.selfUid` (Cookie の本人)
 *   ・**読む**のは画面が表示している uid
 * なので、代理表示 (`?u=`) 中は**別人の行を見に行く**。ここで並べれば一目で分かる。
 *
 * テーブルが無い (migration 未適用) ときは `error` にそのまま出す
 * — 画面側は握りつぶして「未実行」を出すので、ここでしか気づけない。
 */
async function inspectInterview(uid: string | null, selfUid: string | null): Promise<unknown> {
  const sb = getServerSupabase();
  if (!sb) return { note: '(Supabase 未設定)' };
  if (!uid && !selfUid) return { note: '(uid なし = 未サインイン)' };

  const look = async (target: string | null) => {
    if (!target) return null;
    const { data, error } = await (sb.schema('diagnosis') as any)
      .from('interview_completions')
      .select('completed_at, answered_count')
      .eq('diagnostic_user_id', target)
      .order('completed_at', { ascending: false })
      .limit(5);
    if (error) return { error: error.message };
    const rows = data ?? [];
    return { rows: rows.length, latest: rows[0]?.completed_at ?? null, answered: rows[0]?.answered_count ?? null };
  };

  try {
    const shown = await look(uid);
    const self = uid === selfUid ? null : await look(selfUid);
    const out: Record<string, unknown> = { displayed_uid: shown };
    if (self) out.self_uid = self;
    const shownRows = (shown as { rows?: number } | null)?.rows ?? 0;
    const selfRows = (self as { rows?: number } | null)?.rows ?? 0;
    out.verdict = (shown as { error?: string } | null)?.error
      ? '照会に失敗。テーブルが無い (migration 未適用) 可能性 → 画面は黙って「未実行」になる'
      : shownRows > 0
        ? '記録あり → 進捗は「完了済」になるはず。まだ「未実行」ならダッシュボードの取得側を見る'
        : selfRows > 0
          ? '**表示中の uid には無いが本人の uid にはある** = 代理表示 (?u=) で別人を見ている'
          : '記録が 0 件 → 問診の書き出しが届いていない (完了直後の遷移で POST が切れた等)';
    return out;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
