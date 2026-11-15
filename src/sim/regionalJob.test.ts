// Regional estimate (relaxed mode), the strict regression, the whole-Moon search and custom points away from the catalogue.
// Real data throughout: the published site packages, the published LDEM_16 tiles, and the real ephemeris. The only isolated
// fixture is the setting that empties the catalogue (a very small regional slope limit) to exercise the search branch with real
// terrain; it is labelled where it is used and does not create any result by itself.
import { describe, expect, it, vi } from 'vitest'
import { runMissionJob, runCustomSiteJobDetailed, customSiteTransit, JOB_PROTOCOL_VERSION, JobCancelled } from './job'
import type { MissionJob, SiteJob } from './job'
import { loadCandidateCatalog } from './catalog'
import { defaultAdvancedSettings } from './defaults'
import { CURRENT_MODEL_VERSIONS } from './task'
import { qualified, decisionSummary } from './assessment'
import { diskTerrainStore, diskGlobalStore } from './testing/publishedTerrain'
import { coarseGrid, refineGrid, geometricScreen, skySamples, runSearch, searchId } from './search'
import { REGIONAL_MODEL, regionalSlope, castGlobalHorizon, fillHorizon } from './regional'
import { missionWindow } from './mission'
import { visibilityModel } from './visibility'
import { missionStatistics } from './events'
import { evaluateEstimateOnly } from './recommend'
import { estimatePoint } from './regionalEvaluation'
import { pixelKm } from './globalTerrain'
import { createGlobalTerrainStore } from './globalTerrain'

vi.setConfig({ testTimeout: 180_000 })

const catalog = loadCandidateCatalog()
// Regression sample: 2027-01-10 06:00 UTC, 3 days, launch 28.5N 80.6W (recorded before the regional rules were run on it).
const input = { landingTimeMs: Date.UTC(2027, 0, 10, 6), durationMs: 3 * 86_400_000, launchSite: { lat: 28.5, lon: -80.6 } }
const mode = (m: 'strict' | 'relaxed', over: Record<string, unknown> = {}) => ({ ...defaultAdvancedSettings(), assessmentMode: m, ...over })
const jobOf = (settings: ReturnType<typeof mode>, extra: Partial<MissionJob> = {}): MissionJob => ({
  protocol: JOB_PROTOCOL_VERSION, requestId: 'p', fingerprint: 'p', versions: CURRENT_MODEL_VERSIONS, input, settings, siteIds: catalog.candidates.map((c) => c.id), terrainBaseUrl: '', globalTerrainBaseUrl: '', ...extra,
})
const ctxOf = (o: { global?: boolean; cancelAfter?: number; globalStore?: ReturnType<typeof diskGlobalStore> } = {}) => {
  let n = 0
  return {
    terrain: diskTerrainStore(), ...(o.global === false ? {} : { globalTerrain: o.globalStore ?? diskGlobalStore() }),
    isCancelled: () => o.cancelAfter !== undefined && n++ >= o.cancelAfter, progress: () => undefined, yieldNow: async () => undefined,
  }
}
const siteJob = (lat: number, lon: number, settings: ReturnType<typeof mode>): SiteJob => ({
  protocol: JOB_PROTOCOL_VERSION, requestId: 'q', taskFingerprint: 'FP', site: { id: 'custom-1', name: 'P', lat, lon }, input, settings, terrainBaseUrl: '', globalTerrainBaseUrl: '',
})

describe('search grid', () => {
  it('has both poles once, no duplicates, no point on the seam, spacing about the step everywhere', () => {
    for (const step of [5, 10, 2.5]) {
      const g = coarseGrid(step)
      expect(new Set(g.map((p) => p.id)).size).toBe(g.length)
      expect(g.filter((p) => p.lat === 90)).toHaveLength(1); expect(g.filter((p) => p.lat === -90)).toHaveLength(1)
      expect(g.every((p) => p.lon >= -180 && p.lon < 180 && Math.abs(p.lat) <= 90)).toBe(true)
      expect(g.some((p) => p.lon === 180)).toBe(false)
      const area = (180 / step + 1) * (360 / step) * (2 / Math.PI) // rows x mean points per row (cos average)
      expect(g.length).toBeGreaterThan(area * 0.85); expect(g.length).toBeLessThan(area * 1.15)
    }
    expect(coarseGrid(5)).toHaveLength(1652) // the figure the reports use
    expect(() => coarseGrid(0.5)).toThrow(RangeError)
  })
  it('refines across the seam and over the pole without duplicates or invalid coordinates', () => {
    for (const seed of [{ id: 's', lat: 10, lon: 179.2 }, { id: 's', lat: 10, lon: -179.8 }, { id: 's', lat: 89.5, lon: 20 }, { id: 's', lat: -90, lon: 0 }, { id: 's', lat: 0, lon: 0 }]) {
      const r = refineGrid(seed, 1, 2.5)
      expect(new Set(r.map((p) => p.id)).size).toBe(r.length)
      expect(r.every((p) => p.lat >= -90 && p.lat <= 90 && p.lon >= -180 && p.lon < 180)).toBe(true)
      expect(r.length).toBeGreaterThan(5)
    }
    const near = refineGrid({ id: 's', lat: 10, lon: 179.2 }, 1, 2.5)
    expect(near.some((p) => p.lon > 170) && near.some((p) => p.lon < -170)).toBe(true) // it crosses the seam
    expect(searchId(10.004, -3.996)).toBe('search-10.00--4.00')
  })
  it('proves "no Earth" only where the Earth cannot rise even on a flat horizon, and the proof agrees with the full evaluation', async () => {
    const window = missionWindow(input), sky = skySamples(window)
    expect(sky.times[0]).toBe(window.startMs); expect(sky.times.at(-1)).toBe(window.endMs)
    const far = geometricScreen(sky, -45, 178, 0), near = geometricScreen(sky, 0, 0, 0)
    expect(far.provenNoEarth).toBe(true); expect(far.earthFraction).toBe(0)
    expect(near.provenNoEarth).toBe(false); expect(near.earthFraction).toBeGreaterThan(0.9)
    // Same verdict as the formal model on the same point (flat skyline stands for the best case).
    const h = (await diskGlobalStore().ensureAll())
    const est = estimatePoint({ id: 'x', name: 'x', lat: -45, lon: 178, heights: h, settings: mode('relaxed'), window })
    expect(est.energy.earth.visible.length).toBe(0)
  })
})

describe('regional inputs from the global terrain', () => {
  it('casts a skyline for any coordinate (poles, seam) and fills lower-bound azimuths without touching the raw coverage', async () => {
    const h = await diskGlobalStore().ensureAll()
    for (const [lat, lon] of [[89.9, 10], [-89.9, -170], [10, 179.99], [10, -179.99], [0.67416, 23.47314]] as const) {
      const r = castGlobalHorizon(h, lat, lon)
      expect(r.ok, `${lat},${lon}`).toBe(true)
      if (r.ok) {
        expect(r.horizon.samples.elevationsDeg).toHaveLength(360); expect(r.horizon.samples.elevationsDeg.every(Number.isFinite)).toBe(true)
        expect(r.horizon.coverage?.nearField).toBe('absent') // strict evaluation rejects it; only the estimate uses it
        expect(r.horizon.estimation?.basis).toBe('global')
      }
    }
    const pkg = (await diskTerrainStore().load('apollo-11')).horizon
    const f = fillHorizon(pkg, h)
    if (pkg.status === 'available' && f.status === 'available') {
      expect(f.coverage).toEqual(pkg.coverage); expect(f.samples).toEqual(pkg.samples) // raw lower bounds stay lower bounds
      expect(f.coverage!.complete).toBe(false)
      expect(f.estimation!.estimatedElevationsDeg.every((v, i) => v >= pkg.samples.elevationsDeg[i])).toBe(true) // never below the raw lower bound
    }
    expect(regionalSlope(h, 0.67, 23.47)!.baselineKm).toBeCloseTo(2 * pixelKm(h.layout), 6)
  })
  it('returns a problem instead of a skyline when tiles are missing, and never a flat horizon', async () => {
    const store = createGlobalTerrainStore({ baseUrl: '/x/', fetcher: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }) })
    await expect(store.ensureAround(0, 0, 200)).rejects.toBeDefined()
    const est = estimatePoint({ id: 'x', name: 'x', lat: 5, lon: 5, heights: null, settings: mode('relaxed'), window: missionWindow(input) })
    expect(est.site.horizon).toBeNull(); expect(est.data.status).toBe('unknown'); expect(est.data.reasons.map((r) => r.code)).toContain('estimate-no-global-terrain')
    expect(est.terrain.status).toBe('unknown')
  })
  it('keeps proven failures: a point whose Earth never rises fails communication even though everything else is estimated', async () => {
    const h = await diskGlobalStore().ensureAll()
    const est = estimatePoint({ id: 'far', name: 'far', lat: -45, lon: 178, heights: h, settings: mode('relaxed'), window: missionWindow(input) })
    const e = evaluateEstimateOnly({ id: 'far', name: 'far', origin: 'search', lat: -45, lon: 178, frame: 'f' }, est, mode('relaxed'), 'search')
    expect(e.assessment.decision!.conditions.communication.reasons.map((r) => r.code)).toContain('no-direct-earth-visibility')
    expect(qualified(e.assessment)).toBe(false); expect(e.score).toBeNull()
  })
  it('the estimated model accepts a horizon strict would reject, keeps the warnings, and says estimated', async () => {
    const h = await diskGlobalStore().ensureAll()
    const g = castGlobalHorizon(h, 20, 30); if (!g.ok) throw new Error('cast failed')
    const strict = visibilityModel({ lat: 20, lon: 30, horizon: g.horizon }, { earthMinElevationDeg: 0 })
    const est = visibilityModel({ lat: 20, lon: 30, horizon: g.horizon }, { earthMinElevationDeg: 0, estimated: true })
    expect(strict.status).toBe('unavailable'); expect(strict.estimated).toBe(false)
    expect(est.status).toBe('ready'); expect(est.estimated).toBe(true); expect(est.warnings.length).toBeGreaterThan(0)
    const stats = missionStatistics(est, missionWindow(input))
    expect(stats.estimated).toBe(true); expect(stats.sunStatus).not.toBe('incomplete')
    // No usable horizon is still unavailable in estimated mode.
    expect(visibilityModel({ lat: 20, lon: 30, horizon: null }, { earthMinElevationDeg: 0, estimated: true }).status).toBe('unavailable')
    expect(visibilityModel({ lat: 20, lon: 30, horizon: { status: 'unavailable', site: { lat: 20, lon: 30 }, code: 'no-coverage', message: 'x' } }, { earthMinElevationDeg: 0, estimated: true }).status).toBe('unavailable')
  })
  it('the version string of the regional model is the one in the model versions', () => {
    expect(CURRENT_MODEL_VERSIONS.models.regional).toBe(REGIONAL_MODEL)
    expect(CURRENT_MODEL_VERSIONS.data.globalTerrain).toBe('global-dem-v1')
  })
})

describe('mission job: strict keeps the evidence rules, relaxed gives labelled estimates (real 12 sites)', () => {
  it('strict: Chang\'e 4 fails communication, the other 11 stay unknown, nobody is eligible, no search runs', async () => {
    const r = await runMissionJob(jobOf(mode('strict')), ctxOf({ global: false }))
    expect(r.mode).toBe('strict'); expect(r.recommendations).toHaveLength(0); expect(r.search).toBeUndefined()
    const c4 = r.sites.find((s) => s.siteId === 'change-4')!
    expect(c4.summary.landingAllowed).toBe(false); expect(c4.decision!.basis).toBe('evidence'); expect(c4.decision!.estimated).toBe(false)
    const others = r.sites.filter((s) => s.siteId !== 'change-4')
    expect(others.every((s) => s.summary.landingAllowed === null && !qualified(s))).toBe(true)
    expect(others).toHaveLength(11)
  })
  it('strict with zero recommendations never switches to relaxed or searches', async () => {
    const r = await runMissionJob(jobOf(mode('strict', { search: { ...defaultAdvancedSettings().search, enabled: true } })), ctxOf())
    expect(r.recommendations).toHaveLength(0); expect(r.search).toBeUndefined(); expect(r.sites.every((s) => s.decision!.mode === 'strict')).toBe(true)
  })
  it('relaxed: estimates for 11 sites, evidence view untouched, Chang\'e 4 still excluded, no search when catalogue sites qualify', async () => {
    const r = await runMissionJob(jobOf(mode('relaxed')), ctxOf())
    expect(r.mode).toBe('relaxed')
    expect(r.recommendations.length).toBe(3); expect(r.search).toBeUndefined() // 1-3 catalogue recommendations: no whole-Moon search
    for (const s of r.sites) {
      expect(s.decision!.mode).toBe('relaxed'); expect(s.decision!.basis).toBe('estimate'); expect(s.decision!.estimated).toBe(true)
      expect(s.summary.landingAllowed === true).toBe(false) // an estimate never becomes an evidence pass
      expect(s.decision!.risks.join(' ')).toMatch(/not evidence that there are none/)
      expect(s.decision!.scale!.slopePostingKm).toBeCloseTo(1.8957, 3)
    }
    const c4 = r.sites.find((s) => s.siteId === 'change-4')!
    expect(c4.decision!.conditions.communication.reasons.map((x) => x.code)).toContain('no-direct-earth-visibility'); expect(qualified(c4)).toBe(false)
    expect(r.sites.filter(qualified)).toHaveLength(11)
    for (const rec of r.recommendations) { expect(r.pointData![rec.siteId].statistics.estimated).toBe(true); expect(r.transits![rec.siteId].status).toBe('ok') }
    // The ranking is deterministic and has no minimum score.
    expect(r.recommendations.map((x) => x.rank)).toEqual([1, 2, 3])
  })
  it('relaxed without global terrain: no estimate is invented, the sites are not qualified and the reason is stated', async () => {
    const r = await runMissionJob(jobOf(mode('relaxed', { search: { ...defaultAdvancedSettings().search, enabled: false } })), ctxOf({ global: false }))
    expect(r.recommendations).toHaveLength(0)
    const s = r.sites.find((x) => x.siteId === 'apollo-11')!
    expect(qualified(s)).toBe(false)
    expect(decisionSummary(s).reasons.map((x) => x.code)).toContain('estimate-no-global-terrain')
  })
  it('relaxed with a damaged tile: that site says so; nothing falls back to zero or a smooth sphere', async () => {
    const bad = diskGlobalStore({ corrupt: (u, b) => (u.includes('tiles/') ? b.slice(0, b.length - 3) : b) })
    const r = await runMissionJob(jobOf(mode('relaxed', { search: { ...defaultAdvancedSettings().search, enabled: false } })), ctxOf({ globalStore: bad }))
    const s = r.sites.find((x) => x.siteId === 'apollo-11')!
    expect(qualified(s)).toBe(false); expect(decisionSummary(s).reasons.some((x) => x.code.startsWith('estimate-'))).toBe(true)
  })
})

describe('whole-Moon search (the catalogue is emptied by a tiny regional slope limit: an isolated setting on real terrain)', () => {
  const empty = (extra: Record<string, unknown> = {}, search: Partial<ReturnType<typeof defaultAdvancedSettings>['search']> = {}) =>
    mode('relaxed', { regionalSlopeLimitDeg: 0.12, search: { ...defaultAdvancedSettings().search, ...search }, ...extra })
  it('runs only when no catalogue site qualifies, ranks real evaluated points, and reports coverage honestly', async () => {
    const r = await runMissionJob(jobOf(empty()), ctxOf())
    expect(r.recommendations).toHaveLength(0)
    const s = r.search!
    expect(s.status).toBe('complete'); expect(s.reason).toBe('finished')
    expect(s.coverage.coarsePoints).toBe(1652)
    expect(s.coverage.fullyEvaluated).toBeGreaterThan(50)
    expect(s.coverage.provenExcluded.regionalSlope + s.coverage.provenExcluded.noEarthPossible + s.coverage.screenedIn).toBe(1652)
    expect(s.coverage.notEvaluated).toBe(0)
    expect(s.results.length).toBeGreaterThanOrEqual(1); expect(s.results.length).toBeLessThanOrEqual(3)
    for (const [i, x] of s.results.entries()) {
      expect(x.siteId).toMatch(/^search-/); expect(x.rank).toBe(i + 1)
      expect(x.assessment.decision).toMatchObject({ mode: 'relaxed', basis: 'estimate', source: 'search', estimated: true, eligible: true })
      expect(x.assessment.summary.landingAllowed === true).toBe(false) // evidence view: not evaluated, never a pass
      expect(x.transit?.status).toBe('ok'); expect(r.pointData![x.siteId].statistics.estimated).toBe(true)
      expect(Math.abs(x.lat)).toBeLessThanOrEqual(90)
    }
    expect(s.results.map((x) => x.score)).toEqual([...s.results.map((x) => x.score)].sort((a, b) => b - a))
  })
  it('the cap gives a partial result that says what was not evaluated (never "no site exists")', async () => {
    const r = await runMissionJob(jobOf(empty({}, { maxFullEvaluations: 20, refineSeeds: 0 })), ctxOf())
    const s = r.search!
    expect(s.status).toBe('partial'); expect(s.reason).toBe('evaluation-cap')
    expect(s.coverage.fullyEvaluated).toBeLessThanOrEqual(20); expect(s.coverage.notEvaluated).toBeGreaterThan(0)
    expect(s.message).toMatch(/not a proof/)
    expect(s.coverage.qualifying + s.coverage.notQualifying.fail + s.coverage.failed).toBe(s.coverage.fullyEvaluated + s.coverage.failed - s.coverage.notQualifying.unknown - s.coverage.notQualifying.error)
  })
  it('the time budget gives a partial result with the reason, not a statement about the Moon', async () => {
    const r = await runMissionJob(jobOf(empty(), { deadlineAtMs: Date.now() - 1 }), ctxOf())
    const s = r.search!
    expect(s.status).toBe('partial'); expect(s.reason).toBe('time-budget'); expect(s.coverage.fullyEvaluated).toBe(0); expect(s.message).toMatch(/does not say that no better point exists/)
    expect(s.coverage.notEvaluated).toBe(s.coverage.screenedIn)
  })
  it('cancels (throws JobCancelled) while searching, and a disabled search does not run', async () => {
    await expect(runMissionJob(jobOf(empty()), ctxOf({ cancelAfter: 14 }))).rejects.toBeInstanceOf(JobCancelled)
    const r = await runMissionJob(jobOf(empty({}, { enabled: false })), ctxOf())
    expect(r.search).toBeUndefined()
  })
  it('without global terrain the search is unavailable and says so', async () => {
    const r = await runMissionJob(jobOf(empty()), ctxOf({ global: false }))
    expect(r.search).toMatchObject({ status: 'unavailable', reason: 'data-unavailable' }); expect(r.search!.results).toEqual([])
  })
  it('evaluates through the same estimate and decision as every other point, and an injected evaluator can fail without ending the search', async () => {
    const h = await diskGlobalStore().ensureAll()
    let calls = 0
    const o = await runSearch({
      heights: h, settings: mode('relaxed', { search: { ...defaultAdvancedSettings().search, maxFullEvaluations: 30, refineSeeds: 0 } }), window: missionWindow(input), check: async () => undefined, now: () => 0, deadlineMs: Infinity,
      evaluate: (p, c) => { calls++; if (calls % 5 === 0) throw new Error('boom'); return (runSearchDefault)(p, c) },
    })
    expect(o.coverage.failed).toBeGreaterThan(0); expect(o.coverage.fullyEvaluated + o.coverage.failed).toBeLessThanOrEqual(30)
    expect(o.status).toBe('partial')
  })
})

import { defaultEvaluate as runSearchDefault } from './search'

describe('custom points in relaxed mode: any coordinate, real terrain', () => {
  const settings = mode('relaxed')
  it('assesses a point 20 m from Apollo 11 (not the catalogue coordinate) from the global terrain, with no snapping', async () => {
    const { assessment, pointData } = await runCustomSiteJobDetailed(siteJob(0.6745, 23.4731, settings), ctxOf())
    expect(assessment.decision).toMatchObject({ mode: 'relaxed', basis: 'estimate', source: 'custom', estimated: true })
    expect(assessment.conditions.terrain.reasons.map((r) => r.code)).toContain('not-evaluated') // evidence view: nothing evaluated, not "no terrain product"
    expect(decisionSummary(assessment).reasons.map((r) => r.code)).not.toContain('terrain-no-product')
    expect(qualified(assessment)).toBe(true); expect(pointData!.site).toMatchObject({ lat: 0.6745, lon: 23.4731 }) // exactly the given coordinate
    expect(pointData!.site.horizon && pointData!.site.horizon.status === 'available' && pointData!.site.horizon.estimation?.basis).toBe('global')
    const t = await customSiteTransit(siteJob(0.6745, 23.4731, settings), ctxOf())
    expect(t.status).toBe('ok')
  })
  it('poles and the longitude seam are assessed without error', async () => {
    for (const [lat, lon] of [[89.9, 10], [-89.9, -170], [10, 179.99], [10, -179.99], [-0.5, 0]] as const) {
      const { assessment } = await runCustomSiteJobDetailed(siteJob(lat, lon, settings), ctxOf())
      expect(assessment.decision!.estimated).toBe(true)
      expect(['pass', 'fail', 'unknown', 'error']).toContain(assessment.decision!.conditions.dataCompleteness.status)
      expect(decisionSummary(assessment).errored, `${lat},${lon}`).toEqual([])
    }
  })
  it('a far-side point fails communication (proven), and the evidence view stays "not evaluated"', async () => {
    const { assessment, pointData } = await runCustomSiteJobDetailed(siteJob(-45, 178, settings), ctxOf())
    expect(assessment.decision!.conditions.communication.status).toBe('fail'); expect(qualified(assessment)).toBe(false); expect(pointData).toBeUndefined()
  })
  it('the same coordinate as a catalogue site keeps its evidence view (unknown, landingAllowed null) next to the estimate', async () => {
    const { assessment } = await runCustomSiteJobDetailed(siteJob(0.67416, 23.47314, settings), ctxOf())
    expect(assessment.summary.landingAllowed).toBeNull(); expect(assessment.conditions.terrain.status).toBe('unknown')
    expect(assessment.decision!.basis).toBe('estimate'); expect(qualified(assessment)).toBe(true)
  })
  it('without global data the point is not qualified and the reason names the missing data', async () => {
    const { assessment } = await runCustomSiteJobDetailed(siteJob(5, 5, settings), ctxOf({ global: false }))
    expect(qualified(assessment)).toBe(false); expect(decisionSummary(assessment).reasons.map((r) => r.code)).toContain('estimate-no-global-terrain')
  })
  it('strict mode still reports "no terrain product" away from the catalogue (it does not borrow the estimate)', async () => {
    const { assessment } = await runCustomSiteJobDetailed(siteJob(5, 5, mode('strict')), ctxOf())
    expect(assessment.decision).toMatchObject({ mode: 'strict', basis: 'evidence', eligible: false }); expect(assessment.conditions.terrain.reasons.map((r) => r.code)).toContain('terrain-no-product')
  })
})
