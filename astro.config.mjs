import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import vercel from '@astrojs/vercel';

// https://astro.build/config
export default defineConfig({
  output: 'server',
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
