/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The mission Worker (src/sim/worker/missionWorker.ts) is a module Worker; ES output keeps its chunks importable.
  worker: { format: 'es' },
  // Several tests run real-ephemeris brute-force references (1-4 s alone); under parallel load they can exceed the
  // 5 s default. This is a run-time limit only; no numerical tolerance depends on it.
  test: { testTimeout: 60_000 },
})
