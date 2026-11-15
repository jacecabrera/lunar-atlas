// Custom sites: confirmation rules, request races in the scheduler, the real single-site evaluation, and a full
// SYNTHETIC success flow (an isolated fixture: a task with a recommendation and an eligible assessment built by hand).
import { afterEach, describe, expect, it } from 'vitest'
import { confirmCheck, currentAssessment, siteStateLabel } from './customSitesModel'
import type { CustomSite } from './customSitesModel'
import { createTaskScheduler, customSiteKey } from './taskScheduler'
import type { WorkerLike, SiteSink } from './taskScheduler'
import type { FromWorker, ToWorker } from '../sim/job'
import { runCustomSiteJob, JOB_PROTOCOL_VERSION } from '../sim/job'
import { defaultAdvancedSettings } from '../sim/defaults'
import { assessSite } from '../sim/assessment'
import type { ConditionResult, SiteAssessment } from '../sim/assessment'
import type { TaskResult, TaskState } from '../sim/task'
import { useCustomSites, setCustomSiteScheduler, MAX_CUSTOM_SITES } from './customSites'
import { useMission } from './missionStore'

const pass: ConditionResult = { status: 'pass', reasons: [] }
const unk = (code: string): ConditionResult => ({ status: 'unknown', reasons: [{ code, message: code }] })
const eligible = (id: string): SiteAssessment => assessSite(id, { terrain: pass, power: pass, communication: pass, dataCompleteness: pass })
const insufficient = (id: string): SiteAssessment => assessSite(id, { terrain: unk('terrain-no-product'), power: pass, communication: unk('x'), dataCompleteness: unk('y') })
const request = { requestId: 'r', fingerprint: 'FP', versions: {} as TaskResult['versions'], startedAtMs: 0 }
const taskWith = (recs: number, status: 'done' | 'stale' = 'done'): TaskState => ({ status, request, result: {
  requestId: 'r', fingerprint: 'FP', versions: request.versions, completedAtMs: 1, sites: [], outcome: recs ? 'recommendations' : 'no-eligible-sites',
  recommendations: Array.from({ length: recs }, (_, i) => ({ siteId: `h${i}`, rank: i + 1, score: 50, parts: { sunlight: 0.5, earth: 0.5, terrain: 0.5 } })),
} })
const site = (over: Partial<CustomSite> = {}): CustomSite => ({ id: 'custom-x', name: 'X', lat: 10, lon: 20, evaluation: { state: 'assessed', key: customSiteKey('FP', 10, 20), assessment: eligible('custom-x') }, ...over })

describe('confirmation rules', () => {
  it('allows confirmation only with current results, a recommendation, a current eligible assessment and room', () => {
    expect(confirmCheck(site(), taskWith(1), 0, 9)).toEqual({ ok: true, reasons: [] })
    expect(confirmCheck(site(), taskWith(0), 0, 9).reasons.join(' ')).toMatch(/No eligible recommendation/)
    expect(confirmCheck(site(), taskWith(1, 'stale'), 0, 9).reasons.join(' ')).toMatch(/out of date/)
    expect(confirmCheck(site(), { status: 'idle' }, 0, 9).reasons.join(' ')).toMatch(/Calculate the mission first/)
    expect(confirmCheck(site({ lat: 11 }), taskWith(1), 0, 9).reasons.join(' ')).toMatch(/Not assessed for the current inputs/) // moved
    expect(confirmCheck(site({ evaluation: { state: 'evaluating', requestId: 'q', key: 'k' } }), taskWith(1), 0, 9).reasons.join(' ')).toMatch(/in progress/)
    expect(confirmCheck(site(), taskWith(1), 9, 9).reasons.join(' ')).toMatch(/At most 9/)
    expect(confirmCheck(site(), taskWith(1), 9, 9, true).ok).toBe(true) // an already confirmed site keeps its slot
  })
  it('words unknown, service errors and proven failures differently', () => {
    const fail = assessSite('custom-x', { terrain: unk('a'), power: pass, communication: { status: 'fail', reasons: [{ code: 'no-direct-earth-visibility', message: 'm' }] }, dataCompleteness: unk('b') })
    const err = assessSite('custom-x', { terrain: { status: 'error', reasons: [{ code: 'e', message: 'e' }] }, power: pass, communication: pass, dataCompleteness: pass })
    const mk = (a: SiteAssessment) => site({ evaluation: { state: 'assessed', key: customSiteKey('FP', 10, 20), assessment: a } })
    expect(siteStateLabel(mk(fail), taskWith(0))).toMatchObject({ tone: 'fail', label: 'Shown not to meet: communication' })
    expect(siteStateLabel(mk(err), taskWith(0)).tone).toBe('error')
    expect(siteStateLabel(mk(insufficient('custom-x')), taskWith(0)).label).toMatch(/^Not enough data/)
    expect(siteStateLabel(site({ evaluation: { state: 'not-assessed' } }), taskWith(0)).label).toBe('Not assessed')
    expect(siteStateLabel(mk(eligible('custom-x')), { status: 'idle' }).label).toBe('Out of date: check again') // task changed
  })
})

class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null
  onerror: WorkerLike['onerror'] = null
  posted: ToWorker[] = []
  postMessage(m: ToWorker) { this.posted.push(structuredClone(m)) }
  terminate() {}
  emit(m: FromWorker) { this.onmessage?.({ data: structuredClone(m) }) }
  siteJobs() { return this.posted.flatMap((m) => (m.type === 'evaluate-site' ? [m.job] : [])) }
}
function schedulerSetup() {
  const state = { draft: { landingTimeMs: Date.UTC(2027, 0, 10), durationDays: 3, launchLat: 0, launchLon: 0 }, settings: defaultAdvancedSettings(), task: { status: 'idle' } as TaskState }
  const workers: FakeWorker[] = []
  const got: Array<[string, string]> = []
  const sink: SiteSink = { onResult: (id, _r, key) => got.push([id, key]), onError: (id) => got.push([id, 'error']) }
  const s = createTaskScheduler({
    createWorker: () => { const w = new FakeWorker(); workers.push(w); return w },
    store: { get: () => state, setTask: (u) => { state.task = u(state.task) }, setProgress: () => {} },
    terrainBaseUrl: 'x', data: { catalog: { catalogId: 'c', dataVersion: 'v', siteIds: ['a'] }, defaults: { presetId: 'p', dataVersion: 'v' } }, siteSink: sink,
  })
  s.calculate()
  const job = workers[0].posted.find((m) => m.type === 'run')!
  const j = (job as Extract<ToWorker, { type: 'run' }>).job
  workers[0].emit({ type: 'result', requestId: j.requestId, result: { requestId: j.requestId, fingerprint: j.fingerprint, versions: j.versions, completedAtMs: 1, sites: [], recommendations: [], outcome: 'no-eligible-sites' } })
  return { s, workers, got, state, fp: j.fingerprint }
}

describe('custom-site requests in the scheduler', () => {
  it('two sites finishing in either order each keep their own result', () => {
    const { s, workers, got, fp } = schedulerSetup()
    const a = s.evaluateSite({ id: 'A', name: 'A', lat: 1, lon: 2 }), b = s.evaluateSite({ id: 'B', name: 'B', lat: 3, lon: 4 })
    const [ja, jb] = workers[0].siteJobs()
    workers[0].emit({ type: 'site-result', requestId: jb.requestId, siteId: 'B', assessment: insufficient('B') })
    workers[0].emit({ type: 'site-result', requestId: ja.requestId, siteId: 'A', assessment: insufficient('A') })
    expect(a.accepted && b.accepted).toBe(true)
    expect(got).toEqual([['B', customSiteKey(fp, 3, 4)], ['A', customSiteKey(fp, 1, 2)]])
  })
  it('a late result for old coordinates, for a deleted site or after an input change is ignored', () => {
    const { s, workers, got } = schedulerSetup()
    s.evaluateSite({ id: 'A', name: 'A', lat: 1, lon: 2 })
    s.evaluateSite({ id: 'A', name: 'A', lat: 1.5, lon: 2 }) // new coordinates supersede
    const [old, cur] = workers[0].siteJobs()
    workers[0].emit({ type: 'site-result', requestId: old.requestId, siteId: 'A', assessment: eligible('A') })
    expect(got).toEqual([])
    workers[0].emit({ type: 'site-result', requestId: cur.requestId, siteId: 'A', assessment: insufficient('A') })
    expect(got).toHaveLength(1)
    s.evaluateSite({ id: 'B', name: 'B', lat: 5, lon: 5 }); s.forgetSite('B') // deleted
    workers[0].emit({ type: 'site-result', requestId: workers[0].siteJobs()[2].requestId, siteId: 'B', assessment: eligible('B') })
    s.evaluateSite({ id: 'C', name: 'C', lat: 6, lon: 6 }); s.inputsChanged()
    workers[0].emit({ type: 'site-result', requestId: workers[0].siteJobs()[3].requestId, siteId: 'C', assessment: eligible('C') })
    expect(got).toHaveLength(1)
  })
  it('needs a completed task; the same coordinates for the same task come from the cache', () => {
    const { s, workers, got } = schedulerSetup()
    s.evaluateSite({ id: 'A', name: 'A', lat: 1, lon: 2 })
    workers[0].emit({ type: 'site-result', requestId: workers[0].siteJobs()[0].requestId, siteId: 'A', assessment: insufficient('A') })
    expect(s.evaluateSite({ id: 'D', name: 'D', lat: 1, lon: 2 })).toMatchObject({ accepted: true, fromCache: true })
    expect(got).toHaveLength(2)
    s.inputsChanged()
    expect(s.evaluateSite({ id: 'A', name: 'A', lat: 1, lon: 2 })).toMatchObject({ accepted: false })
  })
})

describe('the real single-site evaluation', () => {
  const settings = defaultAdvancedSettings()
  const job = (lat: number, lon: number) => ({ protocol: JOB_PROTOCOL_VERSION, requestId: 'q', taskFingerprint: 'FP', site: { id: 'custom-1', name: 'P', lat, lon }, input: { landingTimeMs: Date.UTC(2027, 0, 10), durationMs: 3 * 86_400_000, launchSite: { lat: 0, lon: 0 } }, settings })
  it('a point at a catalogue coordinate does not borrow that site\'s terrain: no product, unknown', () => {
    const a = runCustomSiteJob(job(0.67416, 23.47314)) // Apollo 11's coordinate typed as a custom site
    expect(a.conditions.terrain.status).toBe('unknown')
    expect(a.conditions.terrain.reasons.map((r) => r.code)).toContain('terrain-no-product')
    expect(a.summary.landingAllowed).toBeNull()
    expect(a.summary.eligibleForRecommendation).toBe(false)
  })
  it('a far-side point fails communication without any terrain (the Earth never rises there)', () => {
    const a = runCustomSiteJob(job(-45, 178))
    expect(a.conditions.communication.status).toBe('fail')
    expect(a.summary.landingAllowed).toBe(false)
  })
  it('rejects invalid coordinates', () => {
    expect(() => runCustomSiteJob(job(95, 0))).toThrow(RangeError)
  })
})

describe('full flow with a synthetic fixture: recommendation -> check -> confirm -> rename -> move -> delete', () => {
  afterEach(() => { useCustomSites.getState().resetConfirmed(); useMission.setState({ task: { status: 'idle' } }) })
  it('confirms only an eligible current site, keeps validity on rename, voids it on a move, and ignores late results after delete', () => {
    const calls: Array<{ id: string; lat: number; lon: number }> = []
    let n = 0
    setCustomSiteScheduler(() => ({
      evaluateSite: (s: { id: string; lat: number; lon: number }) => { calls.push(s); return { accepted: true as const, requestId: `q${++n}`, key: customSiteKey('FP', s.lat, s.lon), fromCache: false } },
      forgetSite: () => {},
    }) as never)
    useMission.setState({ task: taskWith(1) })
    const st = useCustomSites.getState
    st().editEditor({ name: 'Spot', lat: 10, lon: 20 })
    expect(st().confirmEditor().join(' ')).toMatch(/Not assessed/) // a filled coordinate is not an assessment
    const id = st().editor.id
    expect(st().check(id)).toBeNull()
    st().applyResult(id, 'q1', customSiteKey('FP', 10, 20), eligible(id))
    expect(st().confirmEditor()).toEqual([])
    expect(st().sites.map((s) => [s.id, s.name])).toEqual([[id, 'Spot']])
    st().renameSite(id, 'Renamed')
    expect(currentAssessment(st().sites[0], useMission.getState().task)?.summary.eligibleForRecommendation).toBe(true) // rename: no re-evaluation
    st().moveSite(id, 10.5, 20)
    expect(currentAssessment(st().sites[0], useMission.getState().task)).toBeNull() // moved: not valid until checked again
    st().check(id)
    st().removeSite(id)
    st().applyResult(id, 'q2', customSiteKey('FP', 10.5, 20), eligible(id)) // late result after delete
    expect(st().sites).toEqual([])
  })
  it('cannot exceed the maximum, even with quick repeated confirmations', () => {
    let n = 0
    setCustomSiteScheduler(() => ({ evaluateSite: (s: { lat: number; lon: number }) => ({ accepted: true as const, requestId: `q${++n}`, key: customSiteKey('FP', s.lat, s.lon), fromCache: false }), forgetSite: () => {} }) as never)
    useMission.setState({ task: taskWith(1) })
    const st = useCustomSites.getState
    for (let i = 0; i < MAX_CUSTOM_SITES + 3; i++) {
      st().editEditor({ lat: i, lon: i })
      const id = st().editor.id
      st().check(id)
      st().applyResult(id, `q${n}`, customSiteKey('FP', i, i), eligible(id))
      st().confirmEditor(); st().confirmEditor()
    }
    expect(st().sites).toHaveLength(MAX_CUSTOM_SITES)
    expect(new Set(st().sites.map((s) => s.id)).size).toBe(MAX_CUSTOM_SITES)
  })
  it('with zero recommendations the editor can be filled and checked but not confirmed', () => {
    setCustomSiteScheduler(() => ({ evaluateSite: (s: { lat: number; lon: number }) => ({ accepted: true as const, requestId: 'q', key: customSiteKey('FP', s.lat, s.lon), fromCache: false }), forgetSite: () => {} }) as never)
    useMission.setState({ task: taskWith(0) })
    const st = useCustomSites.getState
    st().editEditor({ lat: 1, lon: 1 })
    expect(st().check(st().editor.id)).toBeNull()
    st().applyResult(st().editor.id, 'q', customSiteKey('FP', 1, 1), eligible(st().editor.id))
    expect(st().confirmEditor().join(' ')).toMatch(/No eligible recommendation/)
    expect(st().sites).toEqual([])
  })
})
