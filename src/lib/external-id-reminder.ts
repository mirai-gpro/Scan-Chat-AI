/**
 * 受取時・外部検査ID — **撮り忘れの催促**（純関数・I/O なし）。
 *
 * 正本: `docs/lab/kit_receipt_external_id_capture_spec.md` §7.1 の「7 日ワーニング」。
 *
 * > 発注者指示 2026-10-21:
 * > 「バーコードNo登録済か？のワーニングは、がんリスク検査キットの出荷済日付から
 * > 7 日以上で登録済ステータスでない場合、カメラ読込受取確認を促す」
 *
 * 【なぜ催促が要るか】
 * バーコードNo. は**検体と利用者を結ぶ唯一のキー**で、登録されるまで
 * プリベントへ問診データを渡せない（＝先方の検査が始まらない・§7.1 ②）。
 * ところが利用者から見ると**撮らなくてもアプリは普通に使える**ので、
 * 黙っていると**検体だけ届いて検査が始まらない**状態が続く。
 *
 * 【「登録済」は台帳に有効な行が在るかで見る。`confirmed` を条件にしない】
 * ここは「**撮ってもらう**」ための催促なので、**撮影が済んでいる人を急かさない**ことが要件。
 * `confirmed` まで要求すると、§12.2 の不具合（登録が必ず `review_required` になる）が
 * 直るまで**全員が催促され続ける**。
 * **先方へ出すかどうかの判定（`checkPreventQuestionnaireGate`）とは別物**なので混ぜない
 * — あちらは「この番号がこの検査のものだと確定したか」を見る fail-closed のゲート。
 *
 * 【対象はがんリスク（プリベント）だけ】
 * 発注者指示がそう言っている。デメカルは Secondary でハードゲートも無いので入れない
 * （`PROVIDER_TEST_TYPE` で引けるが、**引けることと催促してよいことは別**）。
 */
import { PROVIDER_TEST_TYPE } from './external-test-id';

/** 出荷済日付から何日で催促するか。 */
export const BARCODE_REMINDER_DAYS = 7;

/** 催促の対象になる検査。**がんリスク（プリベント）だけ**。 */
export const REMINDER_TEST_TYPE = PROVIDER_TEST_TYPE.prevent;

export interface ReminderShipment {
  id: string;
  test_type: string;
  shipped_at: string | null;
}

export interface BarcodeReminder {
  /** 受取確認と同じ ID（撮影ブロックの `shipmentId`）。 */
  shipmentId: string;
  /** 出荷からの経過日数（出荷当日を 0 日とする）。 */
  days: number;
}

/**
 * 日付の文字列を **JST の暦日**（`YYYY-MM-DD`）へ。
 * `elith-export.ts` の `jstTodayIso()` と同じ考え方で、**時刻でなく日で数える**
 * （「7 日以上」は暦日の差で判断する＝時刻の端数で 1 日ずれない）。
 */
function jstDay(value: string | Date): string | null {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** 暦日の差（日）。どちらかが読めなければ null。 */
export function daysBetweenJst(from: string | Date, to: string | Date): number | null {
  const a = jstDay(from);
  const b = jstDay(to);
  if (!a || !b) return null;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * 催促する出荷を返す。**出す条件を満たさないものは 1 件も返さない。**
 *
 * @param input.registered 台帳に**有効な行**が在る `shipment_ref` の集合
 *   （`status <> 'superseded'` で引いたもの）。
 * @param input.captureEnabled `labid.prevent_capture`。**off なら 1 件も返さない** —
 *   撮影導線そのものが出ないので、催促だけ出すと行き先が無い。
 */
export function barcodeReminders(input: {
  shipments: readonly ReminderShipment[];
  registered: ReadonlySet<string>;
  captureEnabled: boolean;
  now?: Date;
}): BarcodeReminder[] {
  if (!input.captureEnabled) return [];
  const now = input.now ?? new Date();
  const out: BarcodeReminder[] = [];
  for (const s of input.shipments) {
    if (s.test_type !== REMINDER_TEST_TYPE) continue;
    if (!s.shipped_at) continue;                   // 発送前は催促しない
    if (input.registered.has(s.id)) continue;      // 撮影が済んでいる人を急かさない
    const days = daysBetweenJst(s.shipped_at, now);
    if (days === null || days < BARCODE_REMINDER_DAYS) continue;
    out.push({ shipmentId: s.id, days });
  }
  return out;
}
