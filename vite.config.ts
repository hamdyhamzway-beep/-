import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const packageJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')
) as { version?: string };

export default defineConfig(() => {
  return {
    define: {
      __APP_VERSION__: JSON.stringify(packageJson.version || '1.0.0'),
      __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'prompt',
        includeAssets: ['icon.svg', 'apple-touch-icon.png'],
        manifest: {
          id: '/',
          name: 'الوليد ترافيل لإدارة النقل المدرسي',
          short_name: 'الوليد ترافيل',
          description: 'نظام إدارة أسطول النقل المدرسي والسائقين والحسابات والتتبع المباشر',
          theme_color: '#0B1F3A',
          background_color: '#F8FAFC',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          dir: 'rtl',
          lang: 'ar',
          icons: [
            {
              src: '/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
          navigateFallbackDenylist: [/^\/api\//],
          importScripts: ['/sw-gps-sync.js'],
          cleanupOutdatedCaches: true,
          skipWaiting: false,
          clientsClaim: false,
        },
        devOptions: {
          enabled: false,
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
