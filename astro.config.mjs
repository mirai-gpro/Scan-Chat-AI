import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import vercel from '@astrojs/vercel';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: vercel({
    // 大きい臨時診断 ZIP の分類は S3 Range GET + 展開 + PDF/XLSX 解析を行うため
    // 300 秒を超える実データがある。Pro の上限内で 800 秒まで許可する。
    maxDuration: 800,
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
