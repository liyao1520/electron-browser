import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import svgr from 'vite-plugin-svgr'

export default defineConfig({
  main: {
    build: { externalizeDeps: { exclude: ['@electron-browser/typed-ipc'] } }
  },
  preload: {
    build: { externalizeDeps: { exclude: ['@electron-browser/typed-ipc'] } }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss(), svgr()]
  }
})
