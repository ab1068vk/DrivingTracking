import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildContentSecurityPolicy } from './scripts/content-security-policy.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const packageJson = require('./package.json')

const normalizedId = (id) => id.replace(/\\/g, '/');

const appCoreModuleFragments = [
  '/src/lib/activityRecognition',
  '/src/lib/appConstants',
  '/src/lib/biometricLock',
  '/src/lib/currency',
  '/src/lib/driveSenseNativePlugin',
  '/src/lib/ephemeralTripMode',
  '/src/lib/errorReporting',
  '/src/lib/gps/sanitize',
  '/src/lib/legalDisclaimers',
  '/src/lib/mapDefaults',
  '/src/lib/mathUtils',
  '/src/lib/mobileStorage',
  '/src/lib/nativeBiometricGate',
  '/src/lib/nativeDownloads',
  '/src/lib/nativePlatform',
  '/src/lib/notificationService',
  '/src/lib/osrmEndpointTrust',
  '/src/lib/osrmEndpointVerifier',
  '/src/lib/parkedLocationAddress',
  '/src/lib/personalBaselineConstants',
  '/src/lib/permissions',
  '/src/lib/query-client',
  '/src/lib/rescoreEvents',
  '/src/lib/scoreDisplay',
  '/src/lib/scoringConstants',
  '/src/lib/scoringVersion.generated',
  '/src/lib/storageKeyMigration',
  '/src/lib/trackingStore',
  '/src/lib/vehicleEconomyConstants',
];

const manualChunks = (id) => {
  const moduleId = normalizedId(id);
  if (moduleId.includes('/src/engine/scoring/') || moduleId.includes('/src/engine/detection/')) {
    return 'engine-scoring';
  }
  if (moduleId.includes('/src/lib/tripInsights')) {
    return 'trip-insights';
  }
  if (appCoreModuleFragments.some((fragment) => moduleId.includes(fragment))) {
    return 'app-core';
  }
  if (!moduleId.includes('/node_modules/')) return undefined;
  if (
    moduleId.includes('/react/') ||
    moduleId.includes('/react-dom/') ||
    moduleId.includes('/react-router-dom/') ||
    moduleId.includes('/@tanstack/react-query/')
  ) {
    return 'react-vendor';
  }
  if (moduleId.includes('/recharts/')) return 'charts-vendor';
  if (moduleId.includes('/html2canvas/')) return 'html2canvas-vendor';
  if (moduleId.includes('/jspdf/')) return 'jspdf-vendor';
  if (moduleId.includes('/@capacitor/')) return 'capacitor-vendor';
  return undefined;
};

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
    base: './',
    plugins: [cspPlugin(csp), react()],
    define: {
      __APP_VERSION__: JSON.stringify(packageJson.version),
    },
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
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks,
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
