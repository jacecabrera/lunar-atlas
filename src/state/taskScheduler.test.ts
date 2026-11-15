// Scheduler races, cancellation and caching with a fake Worker. Every message is passed through structuredClone, as a
// real Worker would. The real cross-thread run is checked in the browser (step 15 record).
import { describe, expect, it, vi } from 'vitest'
import { createTaskScheduler } from './taskScheduler'
import type { SchedulerStore, TaskProgress, WorkerLike } from './taskScheduler'
import type { FromWorker, MissionJob, ToWorker } from '../sim/job'
import { defaultAdvancedSettings } from '../sim/defaults'
import { IDLE_TASK } from '../sim/task'
import type { TaskResult, TaskState } from '../sim/task'
import type { MissionDraft } from '../sim/mission'

class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null
  onerror: WorkerLike['onerror'] = null
  posted: ToWorker[] = []
  terminated = false
  postMessage(m: ToWorker) { this.posted.push(structuredClone(m)) }
  terminate() { this.terminated = true }
  emit(m: FromWorker) { this.onmessage?.({ data: structuredClone(m) }) }
  jobs() { return this.posted.filter((m): m is Extract<ToWorker, { type: 'run' }> => m.type === 'run').map((m) => m.job) }
}

const draftA: MissionDraft = { landingTimeMs: Date.UTC(2027, 0, 10), durationDays: 3, launchLat: 28.5, launchLon: -80.6 }
const draftB: MissionDraft = { ...draftA, durationDays: 5 }

function setup(opts: { budgetMs?: number } = {}) {
  const state = { draft: { ...draftA }, settings: defaultAdvancedSettings(), task: IDLE_TASK as TaskState, progress: null as TaskProgress | null }
  const store: SchedulerStore = { get: () => state, setTask: (u) => { state.task = u(state.task) }, setProgress: (p) => { state.progress = p } }
  const workers: FakeWorker[] = []
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const accepted: Array<[number, string]> = []
  let clock = 1_000
  const s = createTaskScheduler({
    createWorker: () => { const w = new FakeWorker(); workers.push(w); return w },
    store, terrainBaseUrl: 'http://localhost/data/terrain/v1/',
    data: { catalog: { catalogId: 'cat', dataVersion: 'v0.1', siteIds: ['a', 'b'] }, defaults: { presetId: 'p', dataVersion: 'v0.1' } },
    onAccepted: (t, id) => accepted.push([t, id]), now: () => (clock += 1), cancelGraceMs: 3000, budgetMs: opts.budgetMs ?? 60_000,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true },
  })
  const fire = (ms: number) => timers.filter((t) => !t.cleared && t.ms === ms).forEach((t) => { t.cleared = true; t.fn() })
  const result = (job: MissionJob): TaskResult => ({ requestId: job.requestId, fingerprint: job.fingerprint, versions: job.versions, completedAtMs: 5, sites: [], recommendations: [], outcome: 'no-eligible-sites' })
  return { s, state, workers, accepted, fire, result }
}

describe('accepting a calculation', () => {
  it('does nothing for invalid input: no request, no clock call, no Worker', () => {
    const { s, state, workers, accepted } = setup()
    state.draft = { ...draftA, durationDays: null }
    expect(s.calculate()).toMatchObject({ accepted: false })
    expect(state.task.status).toBe('idle')
    expect(accepted).toEqual([])
    expect(workers).toHaveLength(0)
  })
  it('snapshots the input, starts one request and tells the clock the Landing Time', () => {
    const { s, state, workers, accepted } = setup()
    const out = s.calculate()
    expect(out.accepted).toBe(true)
    expect(state.task.status).toBe('running')
    expect(accepted).toEqual([[draftA.landingTimeMs, (out as { requestId: string }).requestId]])
    const job = workers[0].jobs()[0]
    expect(job.input).toEqual({ landingTimeMs: draftA.landingTimeMs, durationMs: 3 * 86_400_000, launchSite: { lat: 28.5, lon: -80.6 } })
    state.draft.landingTimeMs = 0 // a later edit of the store does not reach the job
    expect(workers[0].jobs()[0].input.landingTimeMs).toBe(draftA.landingTimeMs)
  })
})

describe('request identity', () => {
  it('a result of request A arriving after request B is ignored', () => {
    const { s, state, workers, result } = setup()
    s.calculate()
    state.draft = { ...draftB }; s.inputsChanged()
    s.calculate()
    const [jobA, jobB] = workers[0].jobs()
    workers[0].emit({ type: 'result', requestId: jobB.requestId, result: result(jobB) })
    workers[0].emit({ type: 'result', requestId: jobA.requestId, result: result(jobA) })
    expect(state.task.status).toBe('done')
    expect(state.task.status === 'done' && state.task.result.requestId).toBe(jobB.requestId)
  })
  it('same input twice: the first request cannot overwrite the second although the fingerprints match', () => {
    const { s, state, workers, result } = setup()
    s.calculate(); s.calculate()
    const [j1, j2] = workers[0].jobs()
    expect(j1.fingerprint).toBe(j2.fingerprint)
    expect(workers[0].posted.some((m) => m.type === 'cancel' && m.requestId === j1.requestId)).toBe(true)
    workers[0].emit({ type: 'result', requestId: j1.requestId, result: result(j1) })
    expect(state.task.status).toBe('running')
    workers[0].emit({ type: 'result', requestId: j2.requestId, result: result(j2) })
    expect(state.task.status === 'done' && state.task.result.requestId).toBe(j2.requestId)
  })
  it('old progress and old errors are ignored; current progress is shown', () => {
    const { s, state, workers } = setup()
    s.calculate(); s.calculate()
    const [j1, j2] = workers[0].jobs()
    workers[0].emit({ type: 'progress', requestId: j1.requestId, done: 1, total: 2, siteId: 'a', phase: 'evaluate' })
    workers[0].emit({ type: 'error', requestId: j1.requestId, error: { requestId: j1.requestId, kind: 'internal', message: 'old' } })
    expect(state.progress).toBeNull()
    expect(state.task.status).toBe('running')
    workers[0].emit({ type: 'progress', requestId: j2.requestId, done: 1, total: 2, siteId: 'a', phase: 'evaluate' })
    expect(state.progress).toMatchObject({ requestId: j2.requestId, done: 1 })
  })
  it('an input change or a confirmed reset during a run stops write-back', () => {
    const a = setup()
    a.s.calculate()
    a.state.draft = { ...draftB }; a.s.inputsChanged()
    expect(a.state.task.status).toBe('idle')
    const job = a.workers[0].jobs()[0]
    a.workers[0].emit({ type: 'result', requestId: job.requestId, result: a.result(job) })
    expect(a.state.task.status).toBe('idle')
    const b = setup()
    b.s.calculate(); b.s.resetConfirmed()
    const jb = b.workers[0].jobs()[0]
    b.workers[0].emit({ type: 'result', requestId: jb.requestId, result: b.result(jb) })
    expect(b.state.task.status).toBe('idle')
  })
  it('a done result becomes stale when the inputs change', () => {
    const { s, state, workers, result } = setup()
    s.calculate()
    const j = workers[0].jobs()[0]
    workers[0].emit({ type: 'result', requestId: j.requestId, result: result(j) })
    s.inputsChanged()
    expect(state.task.status).toBe('stale')
  })
})

describe('cache', () => {
  it('a cache hit is bound to the new request; a changed setting misses', () => {
    const { s, state, workers, result } = setup()
    s.calculate()
    const j = workers[0].jobs()[0]
    workers[0].emit({ type: 'result', requestId: j.requestId, result: result(j) })
    const again = s.calculate()
    expect(again).toMatchObject({ accepted: true, fromCache: true })
    expect(state.task.status === 'done' && state.task.result.requestId).toBe((again as { requestId: string }).requestId)
    expect(state.task.status === 'done' && state.task.result.requestId).not.toBe(j.requestId)
    expect(workers[0].jobs()).toHaveLength(1)
    state.settings = { ...state.settings, transitSpeedKmPerS: 2 }
    expect(s.calculate()).toMatchObject({ fromCache: false })
  })
})

describe('stopping and failures', () => {
  it('terminates the Worker when a cancel is not acknowledged, keeps it when it is', () => {
    const a = setup()
    a.s.calculate(); a.s.cancel()
    expect(a.state.task.status).toBe('idle')
    a.fire(3000)
    expect(a.workers[0].terminated).toBe(true)
    a.s.calculate()
    expect(a.workers).toHaveLength(2) // rebuilt on the next request
    const b = setup()
    b.s.calculate(); b.s.cancel()
    b.workers[0].emit({ type: 'cancelled', requestId: b.workers[0].jobs()[0].requestId })
    b.fire(3000)
    expect(b.workers[0].terminated).toBe(false)
  })
  it('an unacknowledged cancel stops only its own Worker and the newer request is re-sent, not lost', () => {
    const { s, state, workers, fire, result } = setup()
    s.calculate() // A
    s.calculate() // B, queued behind A in the same Worker; A is cancelled
    const jobB = workers[0].jobs()[1]
    fire(3000) // A never acknowledged: the Worker is terminated
    expect(workers[0].terminated).toBe(true)
    expect(workers).toHaveLength(2)
    expect(workers[1].jobs().map((j) => j.requestId)).toEqual([jobB.requestId]) // B re-sent to the new Worker
    workers[1].emit({ type: 'result', requestId: jobB.requestId, result: result(jobB) })
    expect(state.task.status === 'done' && state.task.result.requestId).toBe(jobB.requestId)
  })
  it('an old grace timer does not stop a newer Worker, and the budget timer of a finished request does nothing', () => {
    const { s, state, workers, fire, result } = setup()
    s.calculate(); s.cancel() // grace timer for A on Worker 1
    workers[0].onerror?.({ message: 'crash' }) // Worker 1 replaced before the timer fires
    s.calculate() // C on Worker 2
    const jobC = workers[1].jobs()[0]
    fire(3000)
    expect(workers[1].terminated).toBe(false)
    workers[1].emit({ type: 'result', requestId: jobC.requestId, result: result(jobC) })
    fire(60_000) // C's budget timer was cleared when it finished
    expect(state.task.status).toBe('done')
    expect(workers[1].terminated).toBe(false)
  })
  it('a Worker error fails the running task and the Worker is rebuilt', () => {
    const { s, state, workers } = setup()
    s.calculate()
    workers[0].onerror?.({ message: 'boom' })
    expect(state.task.status).toBe('error')
    expect(state.task.status === 'error' && state.task.error.message).toMatch(/boom/)
    expect(workers[0].terminated).toBe(true)
    s.calculate()
    expect(workers).toHaveLength(2)
  })
  it('the budget stops a runaway job with an error (not "no eligible sites")', () => {
    const { s, state, workers, fire } = setup({ budgetMs: 60_000 })
    s.calculate()
    fire(60_000)
    expect(state.task.status).toBe('error')
    expect(workers[0].terminated).toBe(true)
  })
  it('dispose stops everything', () => {
    const { s, workers } = setup()
    s.calculate(); s.dispose()
    expect(workers[0].terminated).toBe(true)
    expect(s.calculate()).toMatchObject({ accepted: false })
  })
  it('a worker that posts nothing never leaves listeners behind after dispose', () => {
    const { s, workers } = setup()
    s.calculate(); s.dispose()
    expect(workers[0].onmessage).toBeNull()
    expect(vi.isFakeTimers()).toBe(false)
  })
})
