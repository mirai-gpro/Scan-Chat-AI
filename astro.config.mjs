import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import vercel from '@astrojs/vercel';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  /*
   * **Astro 標準の origin 検査を切り、`src/middleware.ts` で同じ検査をやり直す。**
   *
   * 【なぜ】Astro の実装は `request.headers.get('origin') === url.origin`
   * (`node_modules/astro/dist/core/app/middlewares.js`)。**Vercel の SSR では
   * `url.origin` がプロキシ内側の `https://localhost` になる**ので、
   * **本番では isSameOrigin が常に false** になり、
   * **form / multipart の POST が全部 403**（= 検査が「常に拒否」に化けていた）。
   *
   * 実測 2026-09-30: `POST /api/admin/lab-results/upload` (multipart) は
   * `Origin: https://scan-chat-ai.vercel.app` → **403**、
   * `Origin: https://localhost` → 400 (こちらのハンドラに到達)。
   * → **admin の原本アップロードは本番で動いていなかった。**
   *
   * **緩めるのではなく、正しい origin で同じ検査をする。**
   * 置き換え先は `src/middleware.ts` の `originGuard`
   * (FORM_CONTENT_TYPES / SAFE_METHODS まで Astro と同じ挙動)。
   */
  security: { checkOrigin: false },
  adapter: vercel({
    // gemini-2.5-flash で密度の高い検査表 (~39 項目) を転記すると
    // 30〜50 秒かかるため、デフォルト 10〜15 秒では足りない。
    maxDuration: 60,
  }),
  integrations: [tailwind()],
  server: {
    host: true,
    port: 4321,
  },
  vite: {
    ssr: {
      noExternal: ['@supabase/supabase-js'],
    },
  },
});
