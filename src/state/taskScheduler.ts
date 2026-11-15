// Main-thread task scheduler (step 15): validate -> snapshot -> request -> Worker -> accept or ignore.
//
// Identity: the fingerprint (taskFingerprint) says whether two calculations have the same content; the requestId says
// which press of "calculate" a message belongs to. Only messages carrying the active requestId may change the task
// state, even when an older request had the same fingerprint. A cache hit is re-bound to the new requestId.
//
// Stopping: cancel first asks the Worker to stop (cooperative, between candidates); if the Worker does not acknowledge
// within `cancelGraceMs`, or a job exceeds `budgetMs`, the Worker is terminated and rebuilt on the next request. Either
// way the old request loses its right to write back immediately. No silent fallback to a main-thread calculation.
import { createRequestId, startTask, completeTask, failTask, taskFingerprint, withDataVersions, CURRENT_MODEL_VERSIONS, invalidateTask } from '../sim/task'
import type { TaskRequest, TaskResult, TaskState, ModelVersions } from '../sim/task'
import { validateMissionDraft, validateAdvancedSettings } from '../sim/mission'
import type { AdvancedSettings, MissionDraft } from '../sim/mission'
import { JOB_PROTOCOL_VERSION } from '../sim/job'
import type { FromWorker, MissionJob, ToWorker } from '../sim/job'

export type WorkerLike = {
  postMessage: (m: ToWorker) => void
  terminate: () => void
  onmessage: ((ev: { data: FromWorker }) => void) | null
  onerror: ((ev: { message?: string }) => void) | null
}

export type TaskProgress = { requestId: string; done: number; total: number; phase: string; siteId: string | null }

export type SchedulerStore = {
  get: () => { draft: MissionDraft; settings: AdvancedSettings; task: TaskState }
  setTask: (update: (t: TaskState) => TaskState) => void
  setProgress: (p: TaskProgress | null) => void
}

export type SchedulerOptions = {
  createWorker: () => WorkerLike
  store: SchedulerStore
  terrainBaseUrl: string
  /** Catalogue and preset identities for the fingerprint, plus the candidate IDs to evaluate. */
  data: { catalog: { catalogId: string; dataVersion: string; siteIds: string[] }; defaults: { presetId: string; dataVersion: string } }
  /** Called once a valid calculation is accepted (step 16: pause, jump to Landing Time, lock). */
  onAccepted?: (landingTimeMs: number, requestId: string) => void
  now?: () => number
  cacheSize?: number
  cancelGraceMs?: number
  budgetMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

export type CalculateOutcome =
  | { accepted: true; requestId: string; fingerprint: string; fromCache: boolean }
  | { accepted: false; reasons: string[] }

export function createTaskScheduler(o: SchedulerOptions) {
  const now = o.now ?? Date.now
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const cacheSize = o.cacheSize ?? 8
  const cache = new Map<string, TaskResult>() // fingerprint -> result (LRU by insertion order)
  let worker: WorkerLike | null = null
  let active: { request: TaskRequest; budget: unknown } | null = null
  const pendingCancels = new Map<string, unknown>() // requestId -> grace timer
  let workerInfo: Extract<FromWorker, { type: 'ready' }> | null = null
  let disposed = false

  const versions = (): ModelVersions => withDataVersions(CURRENT_MODEL_VERSIONS, { catalog: o.data.catalog, defaults: o.data.defaults })

  function killWorker() {
    if (!worker) return
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
    worker = null
    for (const h of pendingCancels.values()) clearTimer(h)
    pendingCancels.clear()
  }

  function ensureWorker(): WorkerLike {
    if (worker) return worker
    const w = o.createWorker()
    w.onmessage = (ev) => onMessage(ev.data)
    w.onerror = (ev) => {
      const id = active?.request.requestId
      killWorker()
      if (id) finishActive((t) => failTask(t, { requestId: id, kind: 'internal', message: `Worker failed: ${ev.message ?? 'unknown error'}` }))
    }
    worker = w
    return w
  }

  function finishActive(update: (t: TaskState) => TaskState) {
    if (active) clearTimer(active.budget)
    active = null
    o.store.setProgress(null)
    o.store.setTask(update)
  }

  function onMessage(m: FromWorker) {
    if (m.type === 'ready') { workerInfo = m; return }
    // Acknowledged cancels: the Worker is free again; no need to terminate it.
    if (m.type === 'cancelled' || pendingCancels.has(m.requestId)) {
      const h = pendingCancels.get(m.requestId)
      if (h !== undefined && (m.type === 'cancelled' || m.type === 'result' || m.type === 'error')) { clearTimer(h); pendingCancels.delete(m.requestId) }
      return
    }
    if (!active || m.requestId !== active.request.requestId) return // late or foreign message: ignored
    if (m.type === 'progress') { o.store.setProgress({ requestId: m.requestId, done: m.done, total: m.total, phase: m.phase, siteId: m.siteId }); return }
    if (m.type === 'result') {
      cache.delete(m.result.fingerprint)
      cache.set(m.result.fingerprint, m.result)
      while (cache.size > cacheSize) cache.delete(cache.keys().next().value!)
      finishActive((t) => completeTask(t, m.result))
      return
    }
    if (m.type === 'error') finishActive((t) => failTask(t, m.error))
  }

  /** Stop the active request: it loses write-back at once; the Worker is asked to stop and terminated if it does not. */
  function cancelActive() {
    if (!active) return
    const id = active.request.requestId
    clearTimer(active.budget)
    active = null
    o.store.setProgress(null)
    if (worker) {
      worker.postMessage({ type: 'cancel', requestId: id })
      pendingCancels.set(id, setTimer(() => { if (pendingCancels.has(id)) killWorker() }, o.cancelGraceMs ?? 3000))
    }
  }

  return {
    /** User-triggered calculation. Validates first: invalid input is not accepted and changes nothing. */
    calculate(): CalculateOutcome {
      if (disposed) return { accepted: false, reasons: ['Scheduler disposed'] }
      const { draft, settings } = o.store.get()
      const v = validateMissionDraft(draft)
      const se = validateAdvancedSettings(settings)
      if (!v.ok || se.length) return { accepted: false, reasons: [...(v.ok ? [] : v.errors.map((e) => e.message)), ...se] }
      // Frozen snapshot: the job never reads the store again.
      const snapshot = structuredClone({ input: v.input, settings })
      const ver = versions()
      const siteIds = [...o.data.catalog.siteIds]
      const fingerprint = taskFingerprint({ input: snapshot.input, settings: snapshot.settings, siteIds, versions: ver })
      const request: TaskRequest = { requestId: createRequestId(now()), fingerprint, versions: ver, startedAtMs: now() }
      cancelActive()
      o.store.setTask(() => startTask(request))
      o.onAccepted?.(snapshot.input.landingTimeMs, request.requestId)
      const hit = cache.get(fingerprint)
      if (hit) {
        cache.delete(fingerprint); cache.set(fingerprint, hit)
        o.store.setTask((t) => completeTask(t, { ...structuredClone(hit), requestId: request.requestId, completedAtMs: now() }))
        return { accepted: true, requestId: request.requestId, fingerprint, fromCache: true }
      }
      const job: MissionJob = { protocol: JOB_PROTOCOL_VERSION, requestId: request.requestId, fingerprint, versions: ver, input: snapshot.input, settings: snapshot.settings, siteIds, terrainBaseUrl: o.terrainBaseUrl }
      active = {
        request,
        budget: setTimer(() => {
          if (active?.request.requestId !== request.requestId) return
          killWorker()
          finishActive((t) => failTask(t, { requestId: request.requestId, kind: 'internal', message: `Calculation exceeded its ${o.budgetMs ?? 300_000} ms budget` }))
        }, o.budgetMs ?? 300_000),
      }
      ensureWorker().postMessage({ type: 'run', job })
      return { accepted: true, requestId: request.requestId, fingerprint, fromCache: false }
    },
    /** Inputs or relevant settings changed: the old result is stale, a running request stops writing back. */
    inputsChanged() {
      cancelActive()
      o.store.setTask(invalidateTask)
    },
    /** Confirmed Clear / Reset input (step 23 calls this after its dialog): stop and forget the task. */
    resetConfirmed() {
      cancelActive()
      o.store.setTask(() => ({ status: 'idle' }))
    },
    /** Cancel without changing inputs (e.g. the user presses Stop). */
    cancel() {
      const id = active?.request.requestId
      cancelActive()
      if (id) o.store.setTask((t) => (t.status === 'running' && t.request.requestId === id ? { status: 'idle' } : t))
    },
    dispose() {
      disposed = true
      cancelActive()
      killWorker()
    },
    /** Diagnostics for tests and the step 24 checks. */
    info: () => ({ activeRequestId: active?.request.requestId ?? null, cacheSize: cache.size, workerAlive: worker !== null, worker: workerInfo, pendingCancels: pendingCancels.size }),
  }
}

export type TaskScheduler = ReturnType<typeof createTaskScheduler>
