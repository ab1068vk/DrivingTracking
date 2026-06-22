import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildIntegrityVitePlugin } from './scripts/build-integrity-utils.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react(), buildIntegrityVitePlugin()],
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
})
