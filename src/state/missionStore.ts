import { create } from 'zustand'
import type { PowerConfig } from '../sim/power'
import { DEFAULT_POWER_CONFIG } from '../sim/power'

// Master store for all user-editable mission inputs.
// Add new input groups here as they are finalized (site, landing date, etc.).
// The UI reads from this store; the sim layer receives the values as function arguments.

type MissionState = {
  power: PowerConfig
  setPower: (patch: Partial<PowerConfig>) => void
  resetPower: () => void
}

export const useMission = create<MissionState>((set) => ({
  power: { ...DEFAULT_POWER_CONFIG },
  setPower: (patch) => set((s) => ({ power: { ...s.power, ...patch } })),
  resetPower: () => set({ power: { ...DEFAULT_POWER_CONFIG } }),
}))
