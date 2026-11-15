import { create } from 'zustand'
import { EMPTY_MISSION_DRAFT, IDLE_TASK, LEGACY_PLACEHOLDER_POWER_CONFIG, defaultAdvancedSettings } from '../sim'
import type { AdvancedSettings, LegacyPowerConfig, MissionDraft, TaskState } from '../sim'

// The single store for mission inputs and task state. The UI reads from it; calculations receive a validated,
// frozen copy of the values as plain arguments (validateMissionDraft) and never read the store mid-run.
//
// Not here yet: the scheduler that drives `task` (step 15) and Clear, which resets far more than any single setter
// below (step 23).

type MissionState = {
  /** Main inputs as typed so far. All null on load: no default landing time, duration or launch site. */
  draft: MissionDraft
  setDraft: (patch: Partial<MissionDraft>) => void
  /** More settings, initialised from the bundled ILN-inspired preset. Reset uses the same preset, no copy of values. */
  settings: AdvancedSettings
  setSettings: (settings: AdvancedSettings) => void
  resetSettings: () => void
  /** Legacy binary power model configuration (W/Wh placeholders, isolated from the future device preset). */
  legacyPower: LegacyPowerConfig
  setLegacyPower: (patch: Partial<LegacyPowerConfig>) => void
  resetLegacyPower: () => void
  task: TaskState
}

export const useMission = create<MissionState>((set) => ({
  draft: { ...EMPTY_MISSION_DRAFT },
  setDraft: (patch) => set((s) => ({ draft: { ...s.draft, ...patch } })),
  settings: defaultAdvancedSettings(),
  setSettings: (settings) => set({ settings }),
  resetSettings: () => set({ settings: defaultAdvancedSettings() }),
  legacyPower: { ...LEGACY_PLACEHOLDER_POWER_CONFIG },
  setLegacyPower: (patch) => set((s) => ({ legacyPower: { ...s.legacyPower, ...patch } })),
  resetLegacyPower: () => set({ legacyPower: { ...LEGACY_PLACEHOLDER_POWER_CONFIG } }),
  task: IDLE_TASK,
}))
