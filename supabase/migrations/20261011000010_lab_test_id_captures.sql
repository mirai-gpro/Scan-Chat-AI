-- ============================================================================
-- 受取時・外部検査ID 撮影／登録 — 撮影台帳 (capture ledger)
--
--   正本: docs/lab/kit_receipt_external_id_capture_spec.md
--         ＋ docs/lab/lab_data_pipeline_master_spec.md §4-5 (4検査横断・v2.1)
--
-- 方針 (後方互換・additive のみ):
--   - 新規テーブル 1 本の CREATE だけ。**既存テーブル・列の rename / delete /
--     型変更 / NOT NULL 化はしない。** 読む側 (API) が入るまで挙動は変わらない。
--   - `customer.lab_tests` には**列を足さない**。`external_barcode` /
--     `external_test_id` が既に在る (20260601000010:150-151)。
--
-- 【なぜ `lab_tests` だけでなく台帳が要るか】
--   ① `lab_tests` には「誰がいつ何で読み取ったか・証跡画像はどこか・訂正の履歴」を
--      持つ列が無い。仕様 §8.4 は 変更前/変更後/理由/操作者/時刻 の保持を要求する。
--   ② **`lab_tests` へ行を作れない回がある** (下記)。台帳を分けておけば、
--      紐付けに失敗しても**撮影そのものは失われない** (「サイレント脱落ゼロ」)。
--
-- 【FK を張らない列が 2 つある。手抜きではなく、本番の形がそうなっている】
--   - `shipment_ref`: 受取確認の対象 ID。**dev は `customer.kit_shipments.id`
--     だが、本番は `app_bridge.kit_shipment.id` = `orders.id`**
--     (`src/lib/bridge-queries.ts:70-99` が `orders` のミラーを KitShipment 形へ
--     adapt している・`CLAUDE.md`「kit_shipment はキットでなく orders のミラー」)。
--     本番の値は `customer.kit_shipments` に存在しないので、FK を張ると
--     **本番で必ず外部キー違反になる**。
--   - `diagnostic_user_id`: `diagnosis.app_users` への FK を張れるが、張らない。
--     台帳は「撮って読んだ事実」の記録で、**人の行が未整備でも記録を落としたくない**。
--
--   その代わり `lab_test_id` には FK を張る (紐付けが成立したときだけ入る)。
--
-- 適用順序: **アプリより先に当てる** (additive なので旧アプリは無害)。
--   未適用のままアプリが出た場合、登録 API は 503 で明示的に失敗する
--   (黙って成功したことにしない)。
-- ============================================================================

create table if not exists customer.lab_test_id_captures (
  id                   uuid primary key default gen_random_uuid(),

  -- 誰の・どの受取の撮影か (FK を張らない理由は冒頭)
  diagnostic_user_id   uuid not null,
  shipment_ref         text not null,

  -- 何を取ったか
  provider             text not null check (provider in ('prevent', 'demecal')),
  test_type            text not null,
  id_kind              text not null check (id_kind in ('barcode_no', 'inquiry_no')),
  normalized_value     text not null,

  -- どう取ったか
  capture_method       text not null check (capture_method in ('camera', 'file', 'manual')),
  decode_method        text not null check (decode_method in ('barcode', 'ocr', 'barcode+ocr', 'manual')),
  review_reasons       text[] not null default '{}',

  -- 証跡画像 (private S3 のキーだけ。公開 URL を保存しない・画像本体は入れない)
  evidence_key         text,

  -- 採否
  status               text not null default 'review_required'
                         check (status in ('confirmed', 'review_required', 'superseded')),

  -- lab_tests への紐付け (案A = 登録時に行を作る)
  lab_test_id          uuid references customer.lab_tests(id) on delete set null,
  lab_test_link_status text not null default 'deferred'
                         check (lab_test_link_status in ('linked', 'deferred', 'conflict')),
  lab_test_link_detail text,

  captured_at          timestamptz not null default now(),
  confirmed_at         timestamptz,

  -- 訂正の監査 (仕様 §8.3 / §8.4)
  previous_value       text,
  corrected_at         timestamptz,
  corrected_by         text,
  correction_reason    text,

  created_at           timestamptz not null default now()
);

comment on table customer.lab_test_id_captures is
  '受取時に撮影した外部検査ID の台帳。正本 docs/lab/kit_receipt_external_id_capture_spec.md';
comment on column customer.lab_test_id_captures.shipment_ref is
  '受取確認の対象 ID。dev = customer.kit_shipments.id / 本番 = app_bridge.kit_shipment.id (= orders.id)。'
  ' 本番の値は customer.kit_shipments に存在しないため FK を張らない (bridge-queries.ts:70-99)';
comment on column customer.lab_test_id_captures.normalized_value is
  '正規化済みの外部ID (数字のみ)。原本表記は保持しない — 正規化は区切りの除去だけで値を変えない';
comment on column customer.lab_test_id_captures.status is
  'confirmed = バーコードと印字IDが一致し期待パターンにも合致 / review_required = それ以外 '
  '(不一致・片方のみ・パターン外・手入力) / superseded = 撮り直しで置き換えられた旧行。'
  ' **review_required でも登録は通す** — 実物の形式が未確認なので、止めると何も記録できない';
comment on column customer.lab_test_id_captures.lab_test_link_status is
  'linked = customer.lab_tests へ紐付けた / deferred = 紐付けの材料が揃わず保留 '
  '(customer_profiles の行が無い等。撮影自体は失っていない) / conflict = 同じ外部IDが別の検査に在る';
comment on column customer.lab_test_id_captures.evidence_key is
  '証跡画像の S3 キー (private)。公開 URL を保存しない。表示が必要なら短時間の署名 URL を都度発行する';

-- 同じ (人 × 受取 × provider) で有効な撮影は 1 行だけ。
-- **二重 submit を構造で冪等にする**ための制約 (仕様 §6.3)。撮り直しは旧行を
-- superseded へ落としてから入れるので、この制約には当たらない。
create unique index if not exists ux_lab_test_id_captures_active
  on customer.lab_test_id_captures (diagnostic_user_id, shipment_ref, provider)
  where status <> 'superseded';

-- 重複外部IDの検出に使う (同じ値が別の検査に既に在るか)。
-- **一意制約にしない** — 重複は自動で弾くのではなく `conflict` として残し、
-- 管理側がレビューする (仕様 §8.2「自動上書き禁止」)。
create index if not exists ix_lab_test_id_captures_value
  on customer.lab_test_id_captures (provider, normalized_value);

create index if not exists ix_lab_test_id_captures_user
  on customer.lab_test_id_captures (diagnostic_user_id);

-- 管理レビューの引き当て (review_required / conflict が溜まっていないか)。
create index if not exists ix_lab_test_id_captures_review
  on customer.lab_test_id_captures (status)
  where status = 'review_required';

-- ── 権限 ────────────────────────────────────────────────────────────
-- **service_role だけが読み書きする。ポリシーは 1 つも置かない。**
--   この表は 証跡画像の S3 キー と 外部検査ID を持つので、既存 customer 系の
--   "dev_read_all" (select using true) を真似しない。`diagnosis.scan_jobs`
--   (20260910000010:107-119) と同じ扱いにする。
--   RLS 有効 + ポリシー無し = service_role 以外は 0 行しか見えない。
-- ※ 20260601000020:45 の `grant select on all tables in schema customer to anon`
--   は**その時点の表への一括付与**で、後から作る表には効かない (default privileges ではない)。
--   それでも取り違えが起きないよう明示的に revoke しておく
--   (anon キーはブラウザに出るため・CLAUDE.md「customer の PII が anon で読める」の宿題)。
alter table customer.lab_test_id_captures enable row level security;
alter table customer.lab_test_id_captures force row level security;

revoke all on customer.lab_test_id_captures from anon, authenticated;
grant  all on customer.lab_test_id_captures to service_role;
