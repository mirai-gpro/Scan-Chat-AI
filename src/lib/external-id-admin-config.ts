/**
 * `labid.*`（app_config）→ `AdminConfig`。
 *
 * **判定に使う設定の読み方を 3 つの API へ写さない**ための 1 か所
 * （`api/kit/[id]/external-id.ts` の `patternFor` / `orgPrefixFor` と同じ内容）。
 * ここがずれると、**画面の一覧と問診CSV のゲートで判定が食い違う**。
 */
import { cfg } from './app-config';
import type { ExternalIdProvider } from './external-test-id';
import type { AdminConfig } from './external-id-admin';

export function adminConfigFromAppConfig(): AdminConfig {
  return {
    patternFor: (provider: ExternalIdProvider) =>
      provider === 'prevent' ? cfg('labid.prevent_pattern') : cfg('labid.demecal_pattern'),
    /** `704` は Wellfort 法人（先方の説明 2026-10-21）。デメカルは概念未確認なので空＝判定しない。 */
    orgPrefixFor: (provider: ExternalIdProvider) =>
      provider === 'prevent' ? cfg('labid.prevent_org_prefix') : '',
  };
}
