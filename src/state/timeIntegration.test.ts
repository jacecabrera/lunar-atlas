// The clock together with the mission store and the scheduler (fake Worker), as wired in main.tsx.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTime } from './timeStore'
import { useMission } from './missionStore'
import { createTaskScheduler } from './taskScheduler'
import type { WorkerLike } from './taskScheduler'
import type { FromWorker, ToWorker, MissionJob } from '../sim/job'
import { applyConfirmedReset } from './confirmedReset'

class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null
  onerror: WorkerLike['onerror'] = null
  posted: ToWorker[] = []
  postMessage(m: ToWorker) { this.posted.push(structuredClone(m)) }
  terminate() {}
  emit(m: FromWorker) { this.onmessage?.({ data: structuredClone(m) }) }
  jobs() { return this.posted.flatMap((m) => (m.type === 'run' ? [m.job] : [])) }
}
const L1 = Date.UTC(2027, 0, 10, 6), L2 = Date.UTC(2027, 2, 1, 12)
function wire() {
  const workers: FakeWorker[] = []
  const s = createTaskScheduler({
    createWorker: () => { const w = new FakeWorker(); workers.push(w); return w },
    store: { get: () => useMission.getState(), setTask: (u) => useMission.getState().setTask(u), setProgress: (p) => useMission.getState().setProgress(p) },
    terrainBaseUrl: 'http://x/', globalTerrainBaseUrl: 'http://x/', data: { catalog: { catalogId: 'c', dataVersion: 'v', siteIds: ['a'] }, defaults: { presetId: 'p', dataVersion: 'v' } },
    onAccepted: (t, id) => useTime.getState().lockToLanding(t, id),
  })
  const result = (j: MissionJob) => ({ requestId: j.requestId, fingerprint: j.fingerprint, versions: j.versions, completedAtMs: 1, sites: [], recommendations: [], outcome: 'no-eligible-sites' as const })
  return { s, workers, result }
}
afterEach(() => { applyConfirmedReset(); vi.restoreAllMocks() })

describe('calculation lock in the app wiring', () => {
  it('invalid input does not jump or lock; a valid calculation pauses, jumps to the Landing Time and locks', () => {
    const { s } = wire()
    useMission.getState().setDraft({ landingTimeMs: L1, durationDays: 3, launchLat: 28.5 }) // longitude missing
    const before = useTime.getState().t
    expect(s.calculate().accepted).toBe(false)
    expect(useTime.getState().lock).toBeNull()
    expect(useTime.getState().t).toBe(before)
    useMission.getState().setDraft({ launchLon: -80.6 })
    s.calculate()
    expect(useTime.getState()).toMatchObject({ t: L1, playing: false, lock: { landingMs: L1 } })
  })
  it('completion, zero recommendations, errors, invalidation and a settings reset do not unlock; ordinary controls cannot move it', () => {
    const { s, workers, result } = wire()
    useMission.getState().setDraft({ landingTimeMs: L1, durationDays: 3, launchLat: 28.5, launchLon: -80.6 })
    s.calculate()
    const j = workers[0].jobs()[0]
    workers[0].emit({ type: 'result', requestId: j.requestId, result: result(j) })
    expect(useMission.getState().task.status).toBe('done')
    useMission.getState().resetSettings() // not Clear
    useTime.getState().seek(L1 + 1000)
    useTime.getState().play()
    useTime.getState().setRange(L1 + 1, L1 + 2)
    expect(useTime.getState()).toMatchObject({ t: L1, lock: { landingMs: L1 } })
    useMission.getState().setDraft({ durationDays: 4 }) // a different fingerprint: no cache hit, a new job
    s.calculate()
    workers[0].emit({ type: 'error', requestId: workers[0].jobs()[1].requestId, error: { requestId: workers[0].jobs()[1].requestId, kind: 'internal', message: 'x' } })
    expect(useTime.getState().lock).not.toBeNull()
  })
  it("a newer calculation moves the lock; the older request's late messages cannot move it back", () => {
    const { s, workers, result } = wire()
    useMission.getState().setDraft({ landingTimeMs: L1, durationDays: 3, launchLat: 28.5, launchLon: -80.6 })
    s.calculate()
    useMission.getState().setDraft({ landingTimeMs: L2 })
    s.calculate()
    expect(useTime.getState().lock?.landingMs).toBe(L2)
    const old = workers[0].jobs()[0]
    workers[0].emit({ type: 'progress', requestId: old.requestId, done: 1, total: 1, siteId: 'a', phase: 'evaluate' })
    workers[0].emit({ type: 'result', requestId: old.requestId, result: result(old) })
    expect(useTime.getState()).toMatchObject({ t: L2, lock: { landingMs: L2 } })
  })
  it('only the confirmed reset unlocks, with autoplay at 1x from the confirmation instant', () => {
    const { s } = wire()
    useMission.getState().setDraft({ landingTimeMs: L1, durationDays: 3, launchLat: 28.5, launchLon: -80.6 })
    s.calculate()
    useTime.getState().setRate(3)
    const confirmNow = Date.UTC(2026, 10, 20)
    vi.spyOn(Date, 'now').mockReturnValue(confirmNow)
    applyConfirmedReset()
    expect(useTime.getState()).toMatchObject({ lock: null, rate: 1, playing: true, t: confirmNow })
    expect(useMission.getState().draft.landingTimeMs).toBeNull()
  })
})

describe('the scene clock never touches the mission', () => {
  it('play, pause, speed, seek and range changes leave inputs and task untouched', () => {
    useMission.getState().setDraft({ landingTimeMs: L1, durationDays: 3, launchLat: 28.5, launchLon: -80.6 })
    const { draft, task, settings } = useMission.getState()
    const c = useTime.getState()
    c.pause(); c.setRate(2); c.play(); c.seek(c.t + 1000); c.setRange(c.min, c.max + 1000)
    expect(useMission.getState().draft).toBe(draft)
    expect(useMission.getState().task).toBe(task)
    expect(useMission.getState().settings).toBe(settings)
  })
})
