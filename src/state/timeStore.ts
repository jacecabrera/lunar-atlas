import { create } from 'zustand'

type TimeState = {
  t: number // ms since Unix epoch (UTC)
  min: number
  max: number
  setT: (t: number) => void
}

const DAY = 86_400_000
const now = Date.now()

export const useTime = create<TimeState>((set) => ({
  t: now,
  min: now - 30 * DAY,
  max: now + 30 * DAY,
  setT: (t) => set({ t }),
}))