# 旧版・ボツ

**ここにあるドキュメントは、現行の仕様と内容が食い違う旧版。参照しない。**

- 実装の根拠にしない
- ここの記述を理由に仕様を主張しない
- 現行の仕様と食い違いを見つけても、**ここを直さない**（現行側を直す）

残してある理由は、経緯の追跡と、決裁台帳（`docs/elith/AI疾病予防報告書_仕様書.md` §6）が
「どの記述と食い違っているか」を出典付きで示すため。**引用元としてのみ生きている。**

## 現行の正本

| | |
|---|---|
| **AI疾病予防報告書（仕様）** | `docs/elith/AI疾病予防報告書_仕様書.md` |
| **新規セッションの入口** | `docs/elith/AI疾病予防報告書_引継ぎ書.md` |
| 紙面（デザイン・構成） | `docs/elith/mock/*.html` ＋ `docs/elith/フォーマット見本_AI疾病予防レポート.pdf` |
| **デモ用アカウント（アプリ全体）** | `docs/operations/デモ用アカウント_仕様書.md` |

## 移動したもの

| ファイル | 現行と食い違う点 |
|---|---|
| `demecal_inquiry_email_template.md` | 自動DL可否を先方へ**照会する**ための雛形。**可否は確定済み**（自動アクセス承認・2026-08-31 に証明書つき HTTP 200 実測・方式は PowerShell）＝役目終了 |
| `humandock_bloodpriority_oneoff_delivery.md` | **1 検体だけの暫定手順**（本文が自ら「この1検体のみの暫定運用」と明記）。恒久実装は `docs/scan/scan_canonicalization_standard_format_design.md`。**新しい検体に流用しない** |
| `wellness_age_oneoff_explanation_20260826.md` | 上記 1 検体の説明資料（提出済み）。ウェルネス年齢の仕様は `docs/scan/health_age_*_spec.md` が正 |
| `laif_portal_share_email_template.md` | LAiF 向けメール文面の**案**。送付済み。後継＝`docs/lab/partner_demo_confirmation_request_laif.md` |
| `partner_demo_confirm_request.md` | LAiF／プリベント**共通の雛形**。各社向けに分割・具体化されて役目終了（`partner_demo_confirmation_request_{laif,prevent}.md`） |
| `demecal_pad_flow_skeleton.md` / `demecal_pad_operation_guide.md` / `demecal_pad_setup_guide.md` | **PAD（Power Automate Desktop）でブラウザを自動操作する前提**。血液CSVの自動取得は **PowerShell 方式**に確定したので不採用（2026-08-31・専用PC 実測で証明書つき接続 HTTP 200／ログイン画面は素の HTML フォーム）。正本 = `docs/lab/demecal_unattended_spec.md` |
| `demecal_server_playwright_design.md` | **証明書をサーバへ移設して Playwright(mTLS) で自動DL**する案。**移設が不要になった**ため不採用（専用PC 上の PowerShell で完結する）。同上 |
| `elith_report_integration.md` | **3 モード表示 (a/b/c)** と `diagnosis_result_items` テーブル、**Gemini 2.5 Flash による二次抽出**を定義。現行は 3 モードを廃止し、LLM を使わない（仕様書 §6 の D-6 / D-19 / D-19b の引用元） |
| `ai_prevention_report_generation_spec.md` | 現行仕様書の前身。**内部に矛盾を抱えている**（全編の既定 開く⇔畳む / サーバ側 PDF 生成 する⇔しない⇔条件付き）。**ただし §1.1「目的」は現行仕様書 §1 が逐語で引用しており、そこだけは生きている**（仕様書 §6 の S-1 / S-3 の引用元） |
| `ai_prevention_report_HANDOVER.md` | 1 回目リバート直後の引き継ぎ書。ミッションの記述が現行仕様書 §1 と食い違う |
| `ai_prevention_report_REVERT_LIST.md` | 1 回目のリバート記録。作業は完了済み |
| `2026-08-30_admin判定とデモゲートの試行錯誤.md` | **デモ＝admin 限定**だった頃の §4.6 と、その日の試行錯誤・撤回した仮説・実装バグの記録。現行は「本線＝デモ用アカウント (uid) / 追加＝admin」で、順序も違う（`docs/operations/デモ用アカウント_仕様書.md` が正） |
| `総合テスト向け_入場制御とデモ表示_変更連絡.md` | 「**admin の管理者メンバーだけがデモを見る**」と宣言した連絡文。**前提が変わった**（現行は本線＝デモ用アカウント）。参照ブランチ `claude/ai-prevention-report-feature-fedsqt` とコミット 4 件も現行の本番ブランチのものではない |
| `臨時診断バッチ/ad_hoc_diagnosis_batch_spec.md` | 臨時診断バッチ **v1.0**（150KB）。現行は **v1.1**（`docs/lab/ad_hoc_diagnosis_batch_spec.md`）。食い違う点 = ①健診を ad-hoc 独自 XLSX parser で `HealthCheckupData` にしていた（現行は **production HealthCheckup scan へ結線**）②Genoplan を全 208/210 ページ走査していた（現行は **p10〜35 のみ**・cache は走査の理由にならない）③問診の写像表を「実装済み・CLOSE」としていた（現行は**実物 62 列 schema で作り直し**、PDF は**手動確認入力**） |
| `AI疾病予防報告書_リバート一覧_20260830.md` | 2026-08-30 セッションのリバート候補一覧。**リバートは実施しない判断になった**（該当の実装は現行として生きている）ので、記録としてのみ残す |
