import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The mission Worker (src/sim/worker/missionWorker.ts) is a module Worker; ES output keeps its chunks importable.
  worker: { format: 'es' },
  // Two HTML entries: the app (index.html) and the details page (details.html, step 21). Static hosting needs no rewrite rules,
  // and the details bundle does not load the 3D scene.
  build: { rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), details: resolve(import.meta.dirname, 'details.html') } } },
})
