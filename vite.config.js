import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildContentSecurityPolicy } from './scripts/content-security-policy.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const cspPlugin = (policy) => ({
  name: 'road-sage-csp-meta',
  transformIndexHtml(html) {
    return html.replace(
      '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      `<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`
    );
  },
});

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const csp = buildContentSecurityPolicy({
    apiUrl: env.VITE_API_URL,
    trustedApiOrigins: env.VITE_TRUSTED_BACKEND_ORIGINS,
    dev: command === 'serve',
  });

  return {
    plugins: [cspPlugin(csp), react()],
    server: {
      headers: {
        'Content-Security-Policy': csp,
      },
    },
    preview: {
      headers: {
        'Content-Security-Policy': csp,
      },
    },
    test: {
      exclude: [...configDefaults.exclude, 'e2e/**', 'android/**'],
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            'react-vendor': ['@tanstack/react-query', 'react', 'react-dom', 'react-router-dom'],
            'charts-vendor': ['recharts'],
            'html2canvas-vendor': ['html2canvas'],
            'jspdf-vendor': ['jspdf'],
            'settings': ['./src/pages/Settings', './src/features/settings/hooks/useSettingsSections'],
            'trip-detail': ['./src/pages/TripDetail', './src/lib/tripInsights'],
            'capacitor-vendor': [
              '@capacitor/app',
              '@capacitor/core',
              '@capacitor/filesystem',
              '@capacitor/geolocation',
              '@capacitor/local-notifications',
              '@capacitor/preferences',
            ],
          },
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  };
})
