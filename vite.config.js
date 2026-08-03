import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'
import { visualizer } from 'rollup-plugin-visualizer'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildIntegrityVitePlugin } from './scripts/build-integrity-utils.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const normalizeModuleId = (id) => id.replaceAll('\\', '/')

const inNodeModule = (id, packageName) => (
  id.includes(`/node_modules/${packageName}/`) ||
  id.includes(`/node_modules/${packageName}/index.`)
)

export default defineConfig({
  worker: {
    format: 'es',
  },
  plugins: [
    react(),
    buildIntegrityVitePlugin(),
    visualizer({
      filename: 'dist/bundle-treemap.html',
      template: 'treemap',
      gzipSize: true,
      brotliSize: true,
    }),
    visualizer({
      filename: 'dist/bundle-stats.json',
      template: 'raw-data',
      gzipSize: true,
      brotliSize: true,
    }),
  ],
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**', 'android/**'],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const moduleId = normalizeModuleId(id)

          if (!moduleId.includes('/node_modules/')) return undefined

          if (
            inNodeModule(moduleId, 'react') ||
            inNodeModule(moduleId, 'react-dom') ||
            inNodeModule(moduleId, 'react-router') ||
            inNodeModule(moduleId, 'react-router-dom') ||
            inNodeModule(moduleId, '@tanstack/react-query') ||
            inNodeModule(moduleId, 'clsx') ||
            inNodeModule(moduleId, 'scheduler')
          ) {
            return 'react-vendor'
          }

          if (inNodeModule(moduleId, 'recharts')) return 'charts-vendor'
          if (inNodeModule(moduleId, 'html2canvas')) return 'html2canvas-vendor'
          if (inNodeModule(moduleId, 'jspdf')) return 'jspdf-vendor'
          if (inNodeModule(moduleId, 'leaflet')) return 'leaflet-vendor'
          if (inNodeModule(moduleId, 'three')) return 'three-vendor'
          if (inNodeModule(moduleId, 'framer-motion')) return 'motion-vendor'
          if (moduleId.includes('/node_modules/@radix-ui/')) return 'radix-vendor'
          if (moduleId.includes('/node_modules/@capacitor/')) return 'capacitor-vendor'

          return undefined
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
