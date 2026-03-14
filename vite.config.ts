import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',

      // public 内アセットをプリキャッシュ対象に含める
      includeAssets: ['pwa-icon.svg'],

      workbox: {
        // 新しい SW が検知されたら即座にアクティブ化（キャッシュ待ちなし）
        skipWaiting: true,
        clientsClaim: true,

        // ビルド成果物（JS/CSS/HTML/画像/音声）をプリキャッシュ
        globPatterns: ['**/*.{js,css,html,svg,ico,png,webp,wav,ogg,mp3}'],

        // VSCO サンプル音源: GitHub raw からの取得を CacheFirst でキャッシュ
        // → 一度ダウンロードすれば地下のスタジオでもオフライン再生可能
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/raw\.githubusercontent\.com\/sgossner\/VSCO-2-CE\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'vsco-samples-v1',
              expiration: {
                maxEntries: 40,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 日
              },
              cacheableResponse: {
                statuses: [0, 200], // cross-origin の opaque レスポンスも含める
              },
            },
          },
        ],
      },

      manifest: {
        name: 'Salsa Rhythm Trainer',
        short_name: 'MotionLab',
        description: 'High-Precision Dance Training & Motion Analysis — works offline',
        theme_color: '#080814',
        background_color: '#080814',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: '/',
        icons: [
          {
            src: 'pwa-icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: 'pwa-icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],

  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/__tests__/setup.ts',
  },
});
