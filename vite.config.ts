import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The mission Worker (src/sim/worker/missionWorker.ts) is a module Worker; ES output keeps its chunks importable.
  worker: { format: 'es' },
})
