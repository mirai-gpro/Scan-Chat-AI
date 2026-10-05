# Wellfort マイページ → Scan-Chat AI 連携ボタン 仕様書

**版**: 0.1 (2026-05-30)
**対象**: Wellfort マイページ (https://www.wellfort.co.jp/mypage/)
**依頼元**: アンフィックスエンターテイメント株式会社 (Scan-Chat-AI 開発)
**作業担当**: ウェルフォート HP/EC 開発チーム

---

## 1. 概要

ウェルフォートのマイページに、AI 検査結果分析サービス「Scan-Chat AI」への
遷移ボタンを新設し、ユーザーをスムーズに新サービスへ誘導する。

### 目的

- マイページからワンタップで Scan-Chat AI に遷移できる動線を確保
- AI による検査結果サマリーや AI 問診を新サービスとして訴求
- 既存のマイページ機能 (購入履歴・配送状況等) との並列配置

---

## 2. 遷移先 URL

| 環境 | URL |
|---|---|
| **本番** | `https://scan-chat-ai.vercel.app/?entry=wellfort-mypage` |
| **将来 (Phase 2.0)** | `https://app.wellfort.co.jp/?entry=wellfort-mypage` 等カスタムドメインに移行予定 |

**`?entry=wellfort-mypage` は「どこから来たか」だけを伝える入口種別** (2026-10-05 確定)。
Scan-Chat AI 側はこの値で**初回登録を主導線にするだけ**で、**認証・本人確認には使わない**
(§5-3)。`/` は `url.search` を保ったまま `/dashboard` へ 302 するので、ルート宛てで届く。

> **【絶対】個人情報をクエリに載せない。**
> `?email=` / `?u=<diagnostic_user_id>` / `?customer_id=` / auth user id 等は禁止。
> **URL 履歴・アクセスログ・Referer に出る。** 渡すのは `entry` ただ 1 つ。
> (`?u=` は 2026-09-29 に意図して外した。JS で href を組み立て直さないこと。)
> 機械で見張っている: wellfort-site `npm run verify:webapp-entry`。

---

## 3. ボタン配置

### 推奨位置

マイページのメインコンテンツエリア (検査結果・配送状況などのカードが並ぶ場所) に
**新規のカード型ボタン**として配置。

### 配置順イメージ

```
┌─ Wellfort マイページ ─────────────────────────┐
│  [プロフィール]                              │
│                                              │
│  ┌─ 検査キット注文履歴 ─┐  ┌─ 配送状況 ──┐  │
│  └─────────────────────┘  └────────────┘  │
│                                              │
│  ┌─ 🆕 AI 検査結果分析 ──────────────────┐  │ ← 新設
│  │  あなたの検査結果を AI が分析・解説    │  │
│  │  サマリー / トレンドグラフ / 問診      │  │
│  │  Scan-Chat AI を始める →               │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ┌─ 設定 ────────────┐                      │
│  └───────────────────┘                      │
└──────────────────────────────────────────────┘
```

---

## 4. HTML / CSS スニペット

### 4-1. 汎用版 (フレームワーク非依存)

Wellfort マイページの既存スタイル (Bootstrap / 独自 CSS / Tailwind 等)
を確認のうえ、以下のいずれかをベースにご調整ください。

```html
<a
  href="https://scan-chat-ai.vercel.app/?entry=wellfort-mypage"
  target="_blank"
  rel="noopener"
  class="wellfort-scan-chat-card"
  aria-label="Scan-Chat AI - 検査結果の AI 分析サービスへ移動"
>
  <div class="wellfort-scan-chat-card__icon">
    <!-- ロボット + 心電図のアイコン (SVG inline 推奨) -->
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="10" rx="2"/>
      <circle cx="12" cy="5" r="2"/>
      <path d="M12 7v4"/>
      <line x1="8" y1="16" x2="8" y2="16"/>
      <line x1="16" y1="16" x2="16" y2="16"/>
    </svg>
  </div>
  <div class="wellfort-scan-chat-card__body">
    <div class="wellfort-scan-chat-card__badge">NEW</div>
    <h3 class="wellfort-scan-chat-card__title">AI 検査結果分析</h3>
    <p class="wellfort-scan-chat-card__desc">
      あなたの検査結果を AI が分析・解説。<br>
      数値トレンド・問診・アドバイスをワンストップで。
    </p>
    <span class="wellfort-scan-chat-card__cta">
      Scan-Chat AI を始める →
    </span>
  </div>
</a>

<style>
  .wellfort-scan-chat-card {
    display: flex;
    gap: 16px;
    align-items: center;
    padding: 20px;
    border-radius: 16px;
    border: 1px solid #bfdbfe;
    background: linear-gradient(135deg, #eff6ff 0%, #ecfeff 100%);
    color: #1e293b;
    text-decoration: none;
    transition: transform 0.2s, box-shadow 0.2s;
    cursor: pointer;
  }
  .wellfort-scan-chat-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(37, 99, 235, 0.15);
  }
  .wellfort-scan-chat-card__icon {
    flex-shrink: 0;
    width: 56px; height: 56px;
    border-radius: 14px;
    background: linear-gradient(135deg, #3b82f6, #06b6d4);
    color: white;
    display: flex; align-items: center; justify-content: center;
  }
  .wellfort-scan-chat-card__body { flex: 1; min-width: 0; }
  .wellfort-scan-chat-card__badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 9999px;
    background: #dc2626; color: white;
    font-size: 10px; font-weight: 700;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }
  .wellfort-scan-chat-card__title {
    margin: 0 0 4px;
    font-size: 16px; font-weight: 700;
    color: #1e293b;
  }
  .wellfort-scan-chat-card__desc {
    margin: 0 0 8px;
    font-size: 12px; line-height: 1.5;
    color: #475569;
  }
  .wellfort-scan-chat-card__cta {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 13px; font-weight: 600;
    color: #2563eb;
  }
  @media (prefers-color-scheme: dark) {
    .wellfort-scan-chat-card {
      background: linear-gradient(135deg, rgba(59,130,246,0.1) 0%, rgba(6,182,212,0.1) 100%);
      border-color: rgba(59,130,246,0.3);
      color: #f1f5f9;
    }
    .wellfort-scan-chat-card__title { color: #f1f5f9; }
    .wellfort-scan-chat-card__desc { color: #cbd5e1; }
    .wellfort-scan-chat-card__cta { color: #60a5fa; }
  }
</style>
```

### 4-2. シンプル版 (テキストリンク or ボタン)

カード型が既存レイアウトと合わない場合の代替:

```html
<a
  href="https://scan-chat-ai.vercel.app/?entry=wellfort-mypage"
  target="_blank"
  rel="noopener"
  class="btn btn-primary"
  aria-label="Scan-Chat AI へ移動"
>
  🤖 AI 検査結果分析を試す
</a>
```

---

## 5. 認証フロー

```
┌────────────────────┐         ┌─────────────────────────────┐
│ Wellfort マイページ │         │      Scan-Chat AI           │
│ (Google 認証済)    │  ──→   │ (https://scan-chat-ai...)   │
└────────────────────┘         └─────────────────────────────┘
                                          │
                                          ▼
                               ┌─────────────────────┐
                               │ Google One Tap UI   │
                               │ が自動表示          │
                               └─────────────────────┘
                                          │
              ┌───────────────────────────┴─────────────┐
              ▼                                         ▼
   ┌─────────────────────┐                  ┌─────────────────────┐
   │ 同じ Google アカウント│                 │ 別アカウントで        │
   │ → 1 タップで承認     │                 │ ログインしたい場合    │
   │ → ダッシュボード表示  │                 │ → アカウント選択      │
   └─────────────────────┘                  └─────────────────────┘
```

### 5-1. 重要

- **Wellfort 側で SSO 連携の追加実装は不要** (現状)
- ボタンを押すと Scan-Chat AI が新タブで開き、**Scan-Chat AI 側で改めて
  Google One Tap UI を表示**する
- 同一ブラウザで同じ Google アカウントを使っていれば、ユーザーは **1 タップ
  の承認のみ**で認証完了

### 5-2. 将来 (Phase 2.0)

SSO 連携 (Wellfort 側のセッショントークンを Scan-Chat AI に渡す方式) を
別途検討。今回のスコープ外。

### 5-3. 初回利用者は「新規登録」から (2026-10-05 確定・発注者指示)

**HP と Scan-Chat AI は別の Supabase Auth プロジェクト**なので、HP で認証済みでも
**こちらには認証ユーザーが居ない**。Google 認証なら One Tap が同じアカウントで通るが、
**メール＋パスワードで入る人は、こちらで一度アカウントを作る必要がある**。

上の図は Google 経路。メール経路は `?entry=wellfort-mypage` の有無でこう分かれる:

| | 通常アクセス (entry 無し) | HP マイページ経由 (entry 有り) |
|---|---|---|
| 見出し | サインイン | Webアプリを利用する |
| 初期表示 | ログイン | **新規登録 (Sign up)** |

- **初回 = 新規登録 / 登録済み = ログイン** の 2 語で通す。
  **「新規サインイン」という概念は作らない。**
- **登録済みの人がログインへ戻る導線は常に出す** (片道にしない)。
- **Google の入口 (One Tap / 公式ボタン) は entry でも消えない。**
- **認証後は従来どおり Supabase Auth → `POST /api/auth/resolve`** を必ず通る。
  `entry` は UI の分岐にしか使わない (誰でも付けられるので本人確認にならない)。
- **「このメールは登録済みか」を未認証で聞ける API は作らない** (User Enumeration)。
  初回かどうかは利用者が 2 つの入口から選ぶ。

実装 = Scan-Chat-AI `src/components/SignInPanel.astro` (表示の器) のみ。
正本 = `docs/operations/スペシャルアカウント_仕様書.md` §6.2。

---

## 6. ターゲット属性

| 属性 | 推奨値 | 理由 |
|---|---|---|
| `target` | **`_blank`** | 新規タブで開き、ユーザーが Wellfort マイページに戻りやすくする |
| `rel` | **`noopener`** | `target="_blank"` 時のセキュリティ・パフォーマンス要件 |

---

## 7. アクセシビリティ

- `aria-label` で目的を明示 (上記スニペットに含む)
- SVG アイコンに `aria-hidden="true"` を付与 (装飾的な要素)
- カラーコントラスト: WCAG AA 準拠 (背景 `#eff6ff` / テキスト `#1e293b` 比率 8:1+)
- キーボードナビゲーション可 (`<a>` 要素のため標準対応)

---

## 8. アナリティクス (任意)

Wellfort マイページが Google Analytics / 独自計測を入れている場合、以下を
ボタンクリックで発火することを推奨:

```html
<a
  href="https://scan-chat-ai.vercel.app/?entry=wellfort-mypage"
  target="_blank"
  rel="noopener"
  onclick="gtag('event', 'click_scan_chat_card', { source: 'mypage_main' })"
>
```

イベント名: `click_scan_chat_card` (推奨)

---

## 9. テスト項目

| # | 項目 | 期待動作 |
|---|---|---|
| 1 | ボタン表示 | マイページにカードが表示される (PC / スマホ両方) |
| 2 | クリック | 新規タブで `https://scan-chat-ai.vercel.app/?entry=wellfort-mypage` が開く |
| 3 | One Tap 認証 (同一 Google アカウント) | One Tap UI が表示、1 タップで認証完了、ダッシュボードに遷移 |
| 4 | 認証後ダッシュボード | ユーザー名 (例: 宮澤様) と検査結果 / 数値変動が表示される |
| 5 | キーボード操作 | Tab フォーカスでカードに移動、Enter で遷移 |
| 6 | スクリーンリーダー | aria-label が読み上げられる |
| 7 | dark mode | dark mode に切替えてもカードが見やすい |

---

## 10. 想定スケジュール

| フェーズ | 内容 | 想定期間 |
|---|---|---|
| 1 | デザイン確認 (本仕様書のレビュー) | 1 日 |
| 2 | 実装 + テスト (Wellfort 側) | 2-3 日 |
| 3 | 本番反映 | 半日 |

---

## 11. 連絡先

- **Scan-Chat-AI 開発元**: アンフィックスエンターテイメント株式会社 (担当: 濱田)
  - メール: hamada@eentry.co.jp
- **ご質問・確認**: 上記までご連絡ください

---

## 付録 A: Scan-Chat AI とは

- AI による検査結果分析サービス (パイロット V1)
- 機能:
  - 📊 検査結果ダッシュボード (サマリー / 数値トレンドグラフ / キット進捗)
  - 🩺 AI 問診 (音声・テキスト 5 分)
  - 📸 AI スキャン (検査表のカメラ撮影 → AI 転記)
  - 🧬 検査結果の 3 モード表示 (サマリー / 要注意抜粋 / 全編)
- 技術スタック: Astro 5 + Tailwind + Vercel + Supabase + Gemini 2.5 Flash
- 認証: Google One Tap (Wellfort と同じ OAuth クライアントを共有)
