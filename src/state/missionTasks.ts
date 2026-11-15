// The app's task scheduler: one module Worker (Vite `new Worker(new URL(...), { type: 'module' })`), created on the
// first calculation. Wiring: input changes stop the job; an accepted calculation calls the registered handler (the
// clock: pause, jump to the Landing Time, lock; step 16).
import { createTaskScheduler } from './taskScheduler'
import type { TaskScheduler, WorkerLike } from './taskScheduler'
import { useMission, onMissionInputsChanged } from './missionStore'
import { useCustomSites } from './customSites'
import { loadCandidateCatalog, loadMissionDefaults } from '../sim'

let scheduler: TaskScheduler | null = null
type AcceptedHandler = (landingTimeMs: number, requestId: string) => void
let acceptedHandler: AcceptedHandler | null = null
/** The clock registers here (step 16): called once per accepted calculation, never for invalid input. */
export function setTaskAcceptedHandler(fn: AcceptedHandler | null) { acceptedHandler = fn }

export function missionTasks(): TaskScheduler {
  if (scheduler) return scheduler
  const catalog = loadCandidateCatalog()
  const defaults = loadMissionDefaults()
  const base = typeof location !== 'undefined' ? location.href : 'http://localhost/'
  scheduler = createTaskScheduler({
    createWorker: () => new Worker(new URL('../sim/worker/missionWorker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
    store: {
      get: () => { const s = useMission.getState(); return { draft: s.draft, settings: s.settings, task: s.task } },
      setTask: (u) => useMission.getState().setTask(u),
      setProgress: (p) => useMission.getState().setProgress(p),
    },
    terrainBaseUrl: new URL(`${import.meta.env.BASE_URL}data/terrain/v1/`, base).href,
    data: {
      catalog: { catalogId: catalog.catalogId, dataVersion: catalog.dataVersion, siteIds: catalog.candidates.map((c) => c.id) },
      defaults: { presetId: defaults.presetId, dataVersion: defaults.dataVersion },
    },
    onAccepted: (landingTimeMs, requestId) => acceptedHandler?.(landingTimeMs, requestId),
    siteSink: {
      onResult: (siteId, requestId, key, assessment) => useCustomSites.getState().applyResult(siteId, requestId, key, assessment),
      onError: (siteId, requestId, key, message) => useCustomSites.getState().applyError(siteId, requestId, key, message),
    },
  })
  onMissionInputsChanged(() => scheduler?.inputsChanged())
  return scheduler
}
