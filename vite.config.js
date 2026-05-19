import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
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
