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
import type { FromWorker, MissionJob, SiteJob, ToWorker } from '../sim/job'
import type { SiteAssessment } from '../sim/assessment'
import type { MissionInput } from '../sim/mission'

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
  /** Custom-site results go here (step 19). */
  siteSink?: SiteSink
  now?: () => number
  cacheSize?: number
  cancelGraceMs?: number
  budgetMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

/** Receives custom-site results (step 19). `key` binds a result to a task fingerprint and coordinates. */
export type SiteSink = {
  onResult: (siteId: string, requestId: string, key: string, assessment: SiteAssessment) => void
  onError: (siteId: string, requestId: string, key: string, message: string) => void
}

/** Identity of one custom-site evaluation: the task it belongs to and the exact coordinates. */
export const customSiteKey = (taskFingerprint: string, lat: number, lon: number) => `${taskFingerprint}|${lat}|${lon}`

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
  /** Increases with every Worker created; timers remember the generation they belong to. */
  let generation = 0
  let active: { request: TaskRequest; budget: unknown; job: MissionJob } | null = null
  const pendingCancels = new Map<string, unknown>() // requestId -> grace timer
  let workerInfo: Extract<FromWorker, { type: 'ready' }> | null = null
  /** Snapshot of the last accepted calculation, for custom-site jobs. */
  let lastTask: { fingerprint: string; input: MissionInput; settings: AdvancedSettings } | null = null
  const siteRequests = new Map<string, { requestId: string; key: string }>() // siteId -> latest request
  const siteCache = new Map<string, SiteAssessment>() // key -> assessment (LRU 64)
  let disposed = false

  const versions = (): ModelVersions => withDataVersions(CURRENT_MODEL_VERSIONS, { catalog: o.data.catalog, defaults: o.data.defaults })

  function dropSiteRequests(reason: string | null) {
    for (const [siteId, r] of siteRequests) {
      if (worker) worker.postMessage({ type: 'cancel', requestId: r.requestId })
      if (reason) o.siteSink?.onError(siteId, r.requestId, r.key, reason)
    }
    siteRequests.clear()
  }

  function killWorker() {
    if (!worker) return
    const interrupted = [...siteRequests.entries()]
    siteRequests.clear()
    for (const [siteId, r] of interrupted) o.siteSink?.onError(siteId, r.requestId, r.key, 'The evaluation was interrupted; check the site again')
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
    generation += 1
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
    if (m.type === 'site-result' || m.type === 'site-error') {
      const r = siteRequests.get(m.siteId)
      if (!r || r.requestId !== m.requestId) return // superseded, deleted or invalidated: ignored
      siteRequests.delete(m.siteId)
      if (m.type === 'site-result') {
        siteCache.delete(r.key); siteCache.set(r.key, m.assessment)
        while (siteCache.size > 64) siteCache.delete(siteCache.keys().next().value!)
        o.siteSink?.onResult(m.siteId, m.requestId, r.key, m.assessment)
      } else o.siteSink?.onError(m.siteId, m.requestId, r.key, m.message)
      return
    }
    if (m.type === 'cancelled' && !pendingCancels.has(m.requestId)) return
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
      const gen = generation
      pendingCancels.set(id, setTimer(() => {
        // Only the Worker that received this cancel may be stopped for it; a replaced Worker is left alone.
        if (!pendingCancels.has(id) || gen !== generation) return
        killWorker()
        // A newer request queued behind the stuck one would be lost with the Worker: send it to a fresh Worker.
        if (active) ensureWorker().postMessage({ type: 'run', job: active.job })
      }, o.cancelGraceMs ?? 3000))
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
      dropSiteRequests(null) // custom-site results belong to the previous task
      lastTask = { fingerprint, input: snapshot.input, settings: snapshot.settings }
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
        job,
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
      dropSiteRequests(null)
      o.store.setTask(invalidateTask)
    },
    /** Confirmed Clear / Reset input (step 23 calls this after its dialog): stop and forget the task. */
    resetConfirmed() {
      cancelActive()
      dropSiteRequests(null)
      o.store.setTask(() => ({ status: 'idle' }))
    },
    /** Cancel without changing inputs (e.g. the user presses Stop). */
    cancel() {
      const id = active?.request.requestId
      cancelActive()
      if (id) o.store.setTask((t) => (t.status === 'running' && t.request.requestId === id ? { status: 'idle' } : t))
    },
    /**
     * Evaluate one custom point for the current, completed task (step 19). Returns the request ID and the key the result
     * will carry, or the reason it cannot run. A newer call for the same site supersedes the older one.
     */
    evaluateSite(site: { id: string; name: string; lat: number; lon: number }): { accepted: true; requestId: string; key: string; fromCache: boolean } | { accepted: false; reason: string } {
      if (disposed) return { accepted: false, reason: 'Scheduler disposed' }
      const task = o.store.get().task
      if (task.status !== 'done' || !lastTask || task.result.fingerprint !== lastTask.fingerprint) return { accepted: false, reason: 'Calculate the mission first (custom sites are evaluated for the current results)' }
      if (!(site.lat >= -90 && site.lat <= 90) || !(site.lon >= -180 && site.lon <= 180)) return { accepted: false, reason: 'Enter a valid latitude (-90..90) and longitude (-180..180)' }
      this.forgetSite(site.id)
      const key = customSiteKey(lastTask.fingerprint, site.lat, site.lon)
      const requestId = createRequestId(now())
      const hit = siteCache.get(key)
      if (hit) {
        o.siteSink?.onResult(site.id, requestId, key, structuredClone(hit))
        return { accepted: true, requestId, key, fromCache: true }
      }
      siteRequests.set(site.id, { requestId, key })
      const job: SiteJob = { protocol: JOB_PROTOCOL_VERSION, requestId, taskFingerprint: lastTask.fingerprint, site: { ...site }, input: lastTask.input, settings: lastTask.settings }
      ensureWorker().postMessage({ type: 'evaluate-site', job })
      return { accepted: true, requestId, key, fromCache: false }
    },
    /** Stop listening for a site's pending evaluation (coordinate edit, delete). */
    forgetSite(siteId: string) {
      const r = siteRequests.get(siteId)
      if (!r) return
      siteRequests.delete(siteId)
      worker?.postMessage({ type: 'cancel', requestId: r.requestId })
    },
    dispose() {
      disposed = true
      cancelActive()
      killWorker()
    },
    /** Diagnostics for tests and the step 24 checks. */
    info: () => ({ activeRequestId: active?.request.requestId ?? null, cacheSize: cache.size, pendingSites: siteRequests.size, workerAlive: worker !== null, worker: workerInfo, pendingCancels: pendingCancels.size }),
  }
}

export type TaskScheduler = ReturnType<typeof createTaskScheduler>
