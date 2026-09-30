/**
 * 検査キットの自己申告 (受取 / 返送) ボタンの処理。
 *
 * ダッシュボードのサマリ (`KitProgressCard.astro`) と詳細ページ (`kit.astro`) の
 * **両方から使うので、ここが唯一の実装**。片方だけ直して挙動がずれるのを避ける。
 *
 * 仕様: `docs/lab/kit_progress_management.md` §5.4 (4-b 受取) / §9.3 (5 返送)、
 *       `docs/subscription/kit_progress_ui_spec.md` §4 状態→UI マッピング・§6 アクション。
 * どちらも**任意**の申告で、押さなくても運用は回る (配送業者連携は Phase 2)。
 *
 * ボタン側の契約 (markup が持つ属性):
 *   data-self-report              … このボタンが対象であることの目印
 *   data-shipment-id              … kit_shipments.id
 *   data-action                   … 'received' | 'returned'
 *
 * **uid は属性で渡さない**（2026-09-30・仕様書 §21.1）。対象はサーバが
 * Cookie / 共有セッションから決める。以前は `data-diagnostic-user-id` を body に載せており、
 * **他人の uid を書けばその人の配送状態を変えられた**。
 *
 * `define:vars` を使わないのは、インライン script だと import できず
 * 2 ページに同じ処理を複製することになるため。ID は属性で受け渡す。
 */

let bound = false;

export function initKitSelfReport(): void {
  // 1 ページに両方の呼び出し元が載っても二重送信しない。
  if (bound) return;
  bound = true;

  document.addEventListener('click', async (e) => {
    const target = e.target as Element | null;
    const btn = target?.closest?.('button[data-self-report]') as HTMLButtonElement | null;
    if (!btn) return;

    const shipmentId = btn.dataset.shipmentId;
    const action = btn.dataset.action;
    if (!shipmentId || !action) return;

    const verb = action === 'received' ? 'お受取' : '返送';
    if (!confirm(`本当に「${verb}」を申告しますか？`)) return;

    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = '送信中…';

    try {
      const res = await fetch(`/api/kit/${shipmentId}/self-report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !payload.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      // 成功 → 再読込で段階を進める (状態を JS 側で組み立て直さない)。
      window.location.reload();
    } catch (err) {
      alert(`申告に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  });
}
