import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import vercel from '@astrojs/vercel';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: vercel({
    // 臨時診断バッチの classify は 150MB 級 ZIP を S3 Range GET しながら
    // 全エントリの magic/sha256/分類/XLSX 解析まで同期実行する。
    // 60 秒では実データで FUNCTION_INVOCATION_TIMEOUT になったため 300 秒へ延長。
    // Elith への実書き込み可否は別の write-guard で制御しており、この変更では触らない。
    maxDuration: 300,
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
