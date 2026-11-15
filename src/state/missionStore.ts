import { create } from 'zustand'
import { EMPTY_MISSION_DRAFT, IDLE_TASK, LEGACY_PLACEHOLDER_POWER_CONFIG, defaultAdvancedSettings, invalidateTask } from '../sim'
import type { AdvancedSettings, LegacyPowerConfig, MissionDraft, TaskState } from '../sim'
import type { TaskProgress } from './taskScheduler'

// The single store for mission inputs and task state. The UI reads from it; calculations receive a validated,
// frozen copy of the values (taskScheduler snapshots them) and never read the store mid-run.
//
// Changing the main inputs or the advanced settings invalidates the task at once (invalidateTask: a running request
// stops writing back, a done result becomes stale). Nothing is recalculated automatically: the user confirms again.
// The scene clock, camera and display size are not inputs and never touch the task.

type InputListener = () => void
const inputListeners = new Set<InputListener>()
/** Subscribe to main-input / settings changes (the scheduler stops the Worker job). Returns an unsubscribe function. */
export function onMissionInputsChanged(fn: InputListener) { inputListeners.add(fn); return () => inputListeners.delete(fn) }
const notify = () => { for (const fn of inputListeners) fn() }

type MissionState = {
  /** Main inputs as typed so far. All null on load: no default landing time, duration or launch site. */
  draft: MissionDraft
  setDraft: (patch: Partial<MissionDraft>) => void
  /** More settings, initialised from the bundled ILN-inspired preset. Reset uses the same preset, no copy of values. */
  settings: AdvancedSettings
  setSettings: (settings: AdvancedSettings) => void
  /** Settings reset: invalidates results, but it is not Clear / Reset input and does not unlock the clock. */
  resetSettings: () => void
  /** Legacy binary power model configuration (isolated; not part of the formal task). */
  legacyPower: LegacyPowerConfig
  setLegacyPower: (patch: Partial<LegacyPowerConfig>) => void
  resetLegacyPower: () => void
  task: TaskState
  setTask: (update: (t: TaskState) => TaskState) => void
  progress: TaskProgress | null
  setProgress: (p: TaskProgress | null) => void
  /** Input side of a confirmed Clear / Reset input (step 23 owns the dialog): empty draft, idle task. */
  resetInputConfirmed: () => void
}

export const useMission = create<MissionState>((set) => ({
  draft: { ...EMPTY_MISSION_DRAFT },
  setDraft: (patch) => { set((s) => ({ draft: { ...s.draft, ...patch }, task: invalidateTask(s.task), progress: null })); notify() },
  settings: defaultAdvancedSettings(),
  setSettings: (settings) => { set((s) => ({ settings, task: invalidateTask(s.task), progress: null })); notify() },
  resetSettings: () => { set((s) => ({ settings: defaultAdvancedSettings(), task: invalidateTask(s.task), progress: null })); notify() },
  legacyPower: { ...LEGACY_PLACEHOLDER_POWER_CONFIG },
  setLegacyPower: (patch) => set((s) => ({ legacyPower: { ...s.legacyPower, ...patch } })),
  resetLegacyPower: () => set({ legacyPower: { ...LEGACY_PLACEHOLDER_POWER_CONFIG } }),
  task: IDLE_TASK,
  setTask: (update) => set((s) => ({ task: update(s.task) })),
  progress: null,
  setProgress: (progress) => set({ progress }),
  resetInputConfirmed: () => { set({ draft: { ...EMPTY_MISSION_DRAFT }, task: IDLE_TASK, progress: null }); notify() },
}))
