// Detail snapshots (step 21): validation, building, storage, the wait-for-save race and the launcher.
// The task and custom-site fixtures are SYNTHETIC (hand-built "done" states); the statistics and site horizon inside the
// points are REAL (Apollo 11 from the published terrain), so the real data go through the same JSON and validation path.
import { beforeAll, describe, expect, it } from 'vitest'
import { loadCandidateCatalog } from '../sim/catalog'
import { catalogCandidateInputs } from '../sim/candidateEvaluation'
import { defaultAdvancedSettings, loadMissionDefaults } from '../sim/defaults'
import { missionWindow } from '../sim/mission'
import { assessSite } from '../sim/assessment'
import type { ConditionResult } from '../sim/assessment'
import type { PointData, TaskResult, TaskState } from '../sim/task'
import { validateSnapshot, parseSnapshot, serializeSnapshot, newSnapshotId, findNonPlain, SNAPSHOT_ID_PATTERN, SNAPSHOT_MAX_POINTS } from '../sim/snapshot'
import type { DetailSnapshot } from '../sim/snapshot'
import { diskTerrainStore } from '../sim/testing/publishedTerrain'
import { customSiteKey } from '../state/taskScheduler'
import type { CustomSite } from '../state/customSitesModel'
import { buildSnapshot, snapshotBlockedReason } from './build'
import { saveSnapshot, loadSnapshot, waitForSnapshot, memoryBackend, SnapshotStorageError } from './storage'
import { launchDetails } from './launch'
import { applyConfirmedReset } from '../state/confirmedReset'
import { useCustomSites } from '../state/customSites'
import { useMission } from '../state/missionStore'

const settings = defaultAdvancedSettings()
const catalog = loadCandidateCatalog()
const input = { landingTimeMs: Date.UTC(2027, 0, 10, 6), durationMs: 3 * 86_400_000, launchSite: { lat: 28.5, lon: -80.6 } }
const pass: ConditionResult = { status: 'pass', reasons: [], sources: [{ id: 'SRC-X', title: 'A source', kind: 'dataset' }], limitations: ['A limit'] }
const unk: ConditionResult = { status: 'unknown', reasons: [{ code: 'x', message: 'not enough data' }] }
const eligible = (id: string) => assessSite(id, { terrain: pass, power: pass, communication: pass, dataCompleteness: pass })
const request = { requestId: 'r1', fingerprint: 'FP', versions: {} as TaskResult['versions'], startedAtMs: 0 }

let real: PointData
beforeAll(async () => {
  const c = catalog.candidates.find((x) => x.id === 'apollo-11')!
  const terrain = await diskTerrainStore().load(c.id)
  const inputs = catalogCandidateInputs({ candidate: c, terrain }, catalog, settings, missionWindow(input))
  real = inputs.detail!
}, 60_000)

const ids = ['apollo-11', 'apollo-12']
const done = (recs: string[], over: Partial<TaskResult> = {}, status: 'done' | 'stale' | 'running' = 'done'): TaskState => (status === 'running' ? { status: 'running', request } : {
  status, request, result: {
    requestId: 'r1', fingerprint: 'FP', versions: { contract: 3, models: {} as never, data: {} as never }, completedAtMs: 5, sites: recs.map(eligible),
    outcome: recs.length ? 'recommendations' : 'no-eligible-sites',
    recommendations: recs.map((siteId, i) => ({ siteId, rank: i + 1, score: 60 - i, parts: { sunlight: 0.5, earth: 0.5, terrain: 0.5 } })),
    transits: {}, pointData: Object.fromEntries(recs.map((id) => [id, structuredClone(real)])),
    evaluation: { ranked: [], weights: { sunlight: 1, earth: 1, terrain: 1 } as never, model: 'score-test', excluded: {
      physicalFail: [{ siteId: 'luna-24', reasons: [{ code: 'slope', message: 'slope too steep' }] }], insufficientData: [{ siteId: 'apollo-14', reasons: [{ code: 'd', message: 'no DTM' }] }],
      serviceError: [], notScored: [], beyondLimit: [], customNotRecommended: [] } },
    ...over,
  } as TaskResult,
})
const custom = (id: string, over: Partial<CustomSite> = {}): CustomSite => ({
  id, name: id, lat: 0.67416, lon: 23.47314,
  evaluation: { state: 'assessed', key: customSiteKey('FP', 0.67416, 23.47314), assessment: eligible(id), transit: undefined, pointData: structuredClone(real) }, ...over,
})
const build = (task: TaskState, customs: CustomSite[] = [], extra: Partial<Parameters<typeof buildSnapshot>[0]> = {}) =>
  buildSnapshot({ task, input, settings, customs, maxCustom: 9, snapshotId: newSnapshotId(), nowMs: 1_700_000_000_000, ...extra })
const must = (r: ReturnType<typeof build>): DetailSnapshot => { if (!r.ok) throw new Error(r.reason); return r.snapshot }

describe('snapshot identity and validation', () => {
  it('makes unique IDs even within one millisecond, in the pattern the URL accepts', () => {
    const set = new Set(Array.from({ length: 2000 }, () => newSnapshotId(123)))
    expect(set.size).toBe(2000)
    for (const id of set) expect(id).toMatch(SNAPSHOT_ID_PATTERN)
  })
  it('accepts a built snapshot and round-trips it through JSON unchanged (real statistics included)', () => {
    const s = must(build(done(ids), [custom('custom-1')]))
    const back = parseSnapshot(serializeSnapshot(s))
    expect(back.ok && back.snapshot).toEqual(s)
    expect(s.points.map((p) => [p.id, p.kind, p.rank])).toEqual([['apollo-11', 'recommendation', 1], ['apollo-12', 'recommendation', 2], ['custom-1', 'custom', null]])
    expect(s.points[0].data.statistics.sunSeries.length).toBeGreaterThan(10)
    expect(s.points[0].data.site.horizon?.status).toBe('available')
  })
  it('rejects other documents, old versions, damaged structure and non-finite numbers', () => {
    const s = must(build(done(ids)))
    expect(parseSnapshot('nope')).toMatchObject({ ok: false, kind: 'corrupt' })
    expect(parseSnapshot(JSON.stringify({ ...s, schema: 'x' }))).toMatchObject({ ok: false, kind: 'corrupt' })
    expect(parseSnapshot(JSON.stringify({ ...s, schemaVersion: 1 }))).toMatchObject({ ok: false, kind: 'unsupported-version' })
    expect(parseSnapshot(JSON.stringify({ ...s, schemaVersion: 99 }))).toMatchObject({ ok: false, kind: 'unsupported-version' })
    expect(validateSnapshot({ ...s, snapshotId: 'x' })).toMatchObject({ ok: false })
    expect(validateSnapshot({ ...s, points: undefined })).toMatchObject({ ok: false })
    expect(validateSnapshot({ ...s, points: [s.points[0], s.points[0]] })).toMatchObject({ ok: false, error: expect.stringMatching(/repeats the id/) })
    expect(validateSnapshot({ ...s, points: Array.from({ length: SNAPSHOT_MAX_POINTS + 1 }, (_, i) => ({ ...s.points[0], id: `p${i}` })) })).toMatchObject({ ok: false, error: expect.stringMatching(/at most/) })
    const nan = structuredClone(s); nan.points[0].data.statistics.window.startMs = Number.NaN
    expect(validateSnapshot(nan)).toMatchObject({ ok: false })
    expect(() => serializeSnapshot(nan)).toThrow()
    expect(findNonPlain({ a: [1, Infinity] })).toMatch(/Infinity/)
    expect(findNonPlain({ f: () => 1 })).toMatch(/function/)
    expect(findNonPlain(new Date())).toMatch(/not a plain object/)
  })
})

describe('building', () => {
  it('is blocked, with a reason, unless the task is done and current', () => {
    expect(snapshotBlockedReason({ status: 'idle' })).toMatch(/Calculate/)
    expect(snapshotBlockedReason(done(ids, {}, 'stale'))).toMatch(/out of date/)
    expect(snapshotBlockedReason(done(ids, {}, 'running'))).toMatch(/running/)
    expect(snapshotBlockedReason(done(ids))).toBeNull()
    expect(build(done(ids, {}, 'stale')).ok).toBe(false)
    expect(build({ status: 'idle' }).ok).toBe(false)
  })
  it('saves an empty valid set with the settings and the exclusion reasons when nothing qualifies', () => {
    const s = must(build(done([], { sites: [] })))
    expect(s.points).toEqual([])
    expect(s.exclusions.map((e) => [e.siteId, e.group, e.reasons[0].message])).toEqual([['luna-24', 'physical-fail', 'slope too steep'], ['apollo-14', 'insufficient-data', 'no DTM']])
    expect(s.settings).toEqual(settings); expect(s.input).toEqual(input)
    expect(s.task).toMatchObject({ requestId: 'r1', fingerprint: 'FP' })
    expect(s.preset?.presetId).toBe(loadMissionDefaults().presetId)
    expect(validateSnapshot(s).ok).toBe(true)
  })
  it('includes only confirmed custom sites that are still valid (no drafts, invalid, failed or demo)', () => {
    const task = done(ids)
    const moved = custom('custom-2', { lat: 5 }) // assessment belongs to other coordinates
    const failing = custom('custom-3', { evaluation: { state: 'assessed', key: customSiteKey('FP', 0.67416, 23.47314), assessment: assessSite('custom-3', { terrain: unk, power: pass, communication: pass, dataCompleteness: pass }) } })
    const errored = custom('custom-4', { evaluation: { state: 'error', key: 'k', message: 'boom' } })
    const notAssessed = custom('custom-5', { evaluation: { state: 'not-assessed' } })
    const s = must(build(task, [custom('custom-1'), moved, failing, errored, notAssessed]))
    expect(s.points.map((p) => p.id)).toEqual(['apollo-11', 'apollo-12', 'custom-1'])
    expect(JSON.stringify(s)).not.toMatch(/custom-[2345]|Demo route/)
  })
  it('refuses to build when a valid point has lost its detail data, instead of dropping it', () => {
    const t = done(ids); if (t.status === 'done') delete t.result.pointData!['apollo-12']
    expect(build(t)).toMatchObject({ ok: false, reason: expect.stringMatching(/Detail data for/) })
    expect(build(done(ids), [custom('custom-1', { evaluation: { state: 'assessed', key: customSiteKey('FP', 0.67416, 23.47314), assessment: eligible('custom-1') } })])).toMatchObject({ ok: false })
  })
  it('is an independent deep copy: later changes to the source objects cannot reach it', () => {
    const task = done(ids); const c = custom('custom-1')
    const s = must(build(task, [c]))
    const before = JSON.stringify(s)
    if (task.status === 'done') { task.result.recommendations[0].siteId = 'changed'; task.result.pointData!['apollo-11'].statistics.window.startMs = 1; task.result.sites[0].summary.failed.push('terrain') }
    if (c.evaluation.state === 'assessed') c.evaluation.pointData!.site.lat = 99
    settings.slopeLimitDeg += 1
    try { expect(JSON.stringify(s)).toBe(before) } finally { settings.slopeLimitDeg -= 1 }
  })
  it('gives each snapshot its own ID', () => {
    const a = must(build(done(ids))), b = must(build(done(ids)))
    expect(a.snapshotId).not.toBe(b.snapshotId)
  })
  it('collects sources and limits named by the points, once each', () => {
    const s = must(build(done(ids)))
    expect(s.sources.filter((x) => x.id === 'SRC-X')).toHaveLength(1)
    expect(s.limits.filter((x) => x === 'A limit')).toHaveLength(1)
  })
})

describe('storage', () => {
  it('saves, reads back and loads an independent copy', async () => {
    const be = memoryBackend(); const s = must(build(done(ids)))
    await saveSnapshot(be, s)
    const r = await loadSnapshot(be, s.snapshotId)
    expect(r.status === 'ok' && r.snapshot).toEqual(s)
    if (r.status === 'ok') r.snapshot.points.pop()
    expect((await loadSnapshot(be, s.snapshotId)).status === 'ok').toBe(true) // a second load is unaffected
  })
  it('distinguishes missing, bad ID, corrupt, unsupported version and storage errors', async () => {
    const be = memoryBackend(); const s = must(build(done(ids)))
    expect(await loadSnapshot(be, s.snapshotId)).toEqual({ status: 'missing' })
    expect(await loadSnapshot(be, null)).toEqual({ status: 'bad-id' })
    expect(await loadSnapshot(be, '../../etc')).toEqual({ status: 'bad-id' })
    be.records.set(s.snapshotId, { id: s.snapshotId, schemaVersion: 2, createdAtMs: 1, text: '{broken' })
    expect(await loadSnapshot(be, s.snapshotId)).toMatchObject({ status: 'corrupt' })
    be.records.set(s.snapshotId, { id: s.snapshotId, schemaVersion: 1, createdAtMs: 1, text: JSON.stringify({ ...s, schemaVersion: 1 }) })
    expect(await loadSnapshot(be, s.snapshotId)).toMatchObject({ status: 'unsupported-version' })
    be.records.set(s.snapshotId, { id: s.snapshotId, schemaVersion: 2, createdAtMs: 1, text: serializeSnapshot(must(build(done(ids)))) }) // another snapshot's text under this ID
    expect(await loadSnapshot(be, s.snapshotId)).toMatchObject({ status: 'corrupt', error: expect.stringMatching(/does not match/) })
    for (const kind of ['unsupported', 'disabled', 'failed'] as const) expect(await loadSnapshot(memoryBackend({ failGet: kind }), s.snapshotId)).toMatchObject({ status: 'storage-error', kind })
  })
  it('reports quota, disabled and unsupported storage on save, and writes nothing for an invalid snapshot', async () => {
    const s = must(build(done(ids)))
    for (const kind of ['quota', 'disabled', 'unsupported'] as const) {
      await expect(saveSnapshot(memoryBackend({ failPut: kind }), s)).rejects.toMatchObject({ name: 'SnapshotStorageError', kind })
    }
    const be = memoryBackend(); const bad = structuredClone(s); bad.points[0].data.statistics.window.endMs = Number.NaN
    await expect(saveSnapshot(be, bad)).rejects.toThrow()
    expect(be.records.size).toBe(0)
    const lossy = { ...memoryBackend(), put: async () => undefined, get: async () => ({ id: s.snapshotId, schemaVersion: 2, createdAtMs: 1, text: 'other' }) }
    await expect(saveSnapshot(lossy, s)).rejects.toBeInstanceOf(SnapshotStorageError)
  })
  it('waits for a snapshot saved after the details tab started (no permanent not-found)', async () => {
    const be = memoryBackend(); const s = must(build(done(ids)))
    let n = 0, t = 0
    const r = await waitForSnapshot(be, s.snapshotId, { sleep: async (ms) => { t += ms; if (++n === 3) await saveSnapshot(be, s) }, now: () => t, timeoutMs: 15_000, intervalMs: 300 })
    expect(r.status).toBe('ok'); expect(r.waitedMs).toBe(900)
  })
  it('stops waiting at the timeout (missing, not an endless spinner), on cancel, and when the opener reports a failure', async () => {
    const s = must(build(done(ids)))
    let t = 0
    const r = await waitForSnapshot(memoryBackend(), s.snapshotId, { sleep: async (ms) => { t += ms }, now: () => t, timeoutMs: 2000, intervalMs: 500 })
    expect(r).toMatchObject({ status: 'missing' }); expect(r.waitedMs).toBeGreaterThanOrEqual(2000)
    expect((await waitForSnapshot(memoryBackend(), s.snapshotId, { isCancelled: () => true, sleep: async () => undefined })).status).toBe('missing')
    expect(await waitForSnapshot(memoryBackend(), s.snapshotId, { failed: () => 'quota exceeded', sleep: async () => undefined })).toMatchObject({ status: 'missing', saveFailure: 'quota exceeded' })
    expect((await waitForSnapshot(memoryBackend(), null)).status).toBe('bad-id')
  })
  it('is not touched by a confirmed reset of the home page (storage is separate from every store)', async () => {
    const be = memoryBackend(); const s = must(build(done(ids)))
    await saveSnapshot(be, s)
    useMission.setState({ task: done(ids) }); useCustomSites.setState({ sites: [custom('custom-1')] })
    applyConfirmedReset()
    expect(useMission.getState().task.status).toBe('idle'); expect(useCustomSites.getState().sites).toEqual([])
    const r = await loadSnapshot(be, s.snapshotId)
    expect(r.status === 'ok' && r.snapshot).toEqual(s)
  })
})

describe('launcher', () => {
  const args = (task: TaskState, customs: CustomSite[] = []) => () => ({ task, input, settings, customs, maxCustom: 9 })
  it('opens the tab before building or saving, with only the ID in the URL, and clears the opener', async () => {
    const order: string[] = []; const be = memoryBackend()
    const win = { opener: 'home' as unknown }
    const base = memoryBackend()
    const backend = { ...base, put: async (r: Parameters<typeof base.put>[0]) => { order.push('save'); await base.put(r) }, get: base.get }
    const o = await launchDetails({
      open: (url) => { order.push(`open:${url}`); return win }, backend, detailsUrl: (id) => `http://x/moon-planner/details.html?snapshot=${id}`,
      args: () => { order.push('build'); return args(done(ids))() }, newId: () => 'snap-abc-0123456789abcdef01234567',
    })
    expect(order[0]).toBe('open:http://x/moon-planner/details.html?snapshot=snap-abc-0123456789abcdef01234567')
    expect(order.slice(1)).toEqual(['build', 'save'])
    expect(o).toMatchObject({ ok: true, opened: true }); expect(win.opener).toBeNull()
    expect((await loadSnapshot(be, 'snap-abc-0123456789abcdef01234567')).status).toBe('missing') // saved into `base` below
    expect((await loadSnapshot(base, 'snap-abc-0123456789abcdef01234567')).status).toBe('ok')
  })
  it('still saves when the browser blocks the tab, and returns the URL for a link', async () => {
    const be = memoryBackend()
    const o = await launchDetails({ open: () => null, backend: be, detailsUrl: (id) => `u/${id}`, args: args(done(ids)) })
    expect(o).toMatchObject({ ok: true, opened: false }); expect(be.records.size).toBe(1)
    const o2 = await launchDetails({ open: () => { throw new Error('popup blocked') }, backend: be, detailsUrl: (id) => `u/${id}`, args: args(done(ids)) })
    expect(o2).toMatchObject({ ok: true, opened: false }); expect(be.records.size).toBe(2)
  })
  it('returns the failure for the home page when building or saving fails, and a retry makes a new snapshot', async () => {
    const be = memoryBackend({ failPut: 'quota' })
    const o = await launchDetails({ open: () => ({ opener: null }), backend: be, detailsUrl: (id) => `u/${id}`, args: args(done(ids)) })
    expect(o).toMatchObject({ ok: false, opened: true, error: expect.stringMatching(/full/) })
    const blocked = await launchDetails({ open: () => ({ opener: null }), backend: memoryBackend(), detailsUrl: (id) => `u/${id}`, args: args(done(ids, {}, 'stale')) })
    expect(blocked).toMatchObject({ ok: false, error: expect.stringMatching(/out of date/) })
    const ok = memoryBackend()
    const a = await launchDetails({ open: () => null, backend: ok, detailsUrl: (id) => `u/${id}`, args: args(done(ids)) })
    const b = await launchDetails({ open: () => null, backend: ok, detailsUrl: (id) => `u/${id}`, args: args(done(ids)) })
    expect(a.id).not.toBe(b.id)
  })
})
