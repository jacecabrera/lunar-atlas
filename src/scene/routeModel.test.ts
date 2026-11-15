// Routes and markers (step 20): endpoints follow the step-14 convention, the curve is visual only, nothing is invented
// when a transit estimate is missing. Task fixtures are SYNTHETIC (hand-built "done" tasks); transits come from the real
// estimateTransit with a synthetic destination radius (1737.4 km).
import { describe, expect, it } from 'vitest'
import {
  bezierPoints, bowControl, buildRouteModel, demoEndpoints, draftMarker, drawableRoutes, showDemo, routeColour, inputOfDraft,
  ROUTE_SAMPLES, EMPTY_ROUTE_MODEL, exaggerateRoute,
} from './routeModel'
import type { Vec3 } from './routeModel'
import { earthSiteGeocentric, moonSiteGeocentric } from '../sim/frames'
import { estimateTransit } from '../sim/transit'
import { loadCandidateCatalog } from '../sim/catalog'
import { defaultAdvancedSettings } from '../sim/defaults'
import { assessSite } from '../sim/assessment'
import type { ConditionResult } from '../sim/assessment'
import type { TaskState, TaskResult } from '../sim/task'
import { SCENE_RADII } from '../sim/scene'
import { toScene } from '../physics/coords'
import { customSiteKey } from '../state/taskScheduler'
import type { CustomSite } from '../state/customSitesModel'
import { useRoutes } from '../state/routesStore'

const catalog = loadCandidateCatalog()
const speed = defaultAdvancedSettings().transitSpeedKmPerS
const landing = Date.UTC(2027, 0, 10, 6)
const launch = { lat: 28.5, lon: -80.6 }
const input = { landingTimeMs: landing, durationMs: 3 * 86_400_000, launchSite: launch }
const transitFor = (lat: number, lon: number, radiusKm: number | null = 1737.4) => estimateTransit({ landingTimeMs: landing, launchSite: launch, destination: { lat, lon, radiusKm }, speedKmPerS: speed })
const pass: ConditionResult = { status: 'pass', reasons: [] }
const eligible = (id: string) => assessSite(id, { terrain: pass, power: pass, communication: pass, dataCompleteness: pass })
const unk: ConditionResult = { status: 'unknown', reasons: [{ code: 'x', message: 'x' }] }
const request = { requestId: 'r', fingerprint: 'FP', versions: {} as TaskResult['versions'], startedAtMs: 0 }
const ids = catalog.candidates.slice(0, 3).map((c) => c.id)
const doneTask = (over: Partial<TaskResult> = {}, status: 'done' | 'stale' = 'done'): TaskState => ({
  status, request, result: {
    requestId: 'r', fingerprint: 'FP', versions: request.versions, completedAtMs: 1, sites: [], outcome: 'recommendations',
    recommendations: ids.map((siteId, i) => ({ siteId, rank: i + 1, score: 50, parts: { sunlight: 0.5, earth: 0.5, terrain: 0.5 } })),
    transits: Object.fromEntries(ids.map((id) => { const c = catalog.candidates.find((x) => x.id === id)!; return [id, transitFor(c.coordinate.lat, c.coordinate.lon)] })),
    ...over,
  },
})
const custom = (over: Partial<CustomSite> = {}): CustomSite => ({
  id: 'custom-3', name: 'Mine', lat: -80, lon: 10,
  evaluation: { state: 'assessed', key: customSiteKey('FP', -80, 10), assessment: eligible('custom-3'), transit: transitFor(-80, 10) }, ...over,
})
const build = (task: TaskState, customs: CustomSite[] = []) => buildRouteModel({ task, input, customs, maxCustom: 9 })
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

describe('curve', () => {
  it('starts and ends exactly at the endpoints and bows without changing them', () => {
    const a: Vec3 = [1, 2, 3], b: Vec3 = [100, -20, 40]
    const p = bezierPoints(a, b)
    expect(p).toHaveLength(ROUTE_SAMPLES + 1)
    expect(p[0]).toEqual(a); expect(p[ROUTE_SAMPLES]).toEqual(b)
    expect(p.every((v) => v.every(Number.isFinite))).toBe(true)
    expect(bezierPoints(a, b, 8, 0.5)[0]).toEqual(a)
    // The midpoint is off the chord (the curvature is visible) but only by the visual bow.
    const mid = p[ROUTE_SAMPLES / 2], chordMid: Vec3 = [50.5, -9, 21.5]
    expect(dist(mid, chordMid)).toBeGreaterThan(1)
    expect(dist(mid, chordMid)).toBeLessThan(0.18 * dist(a, b))
  })
  it('handles a chord parallel to the bow direction without NaN', () => {
    const p = bezierPoints([0, 0, 0], [0, 50, 0])
    expect(p.every((v) => v.every(Number.isFinite))).toBe(true)
    expect(bowControl([0, 0, 0], [0, 50, 0]).every(Number.isFinite)).toBe(true)
  })
  it('rewrites the points in place when given an output array (no new arrays per frame)', () => {
    const out = bezierPoints([0, 0, 0], [1, 0, 0])
    const first = out[3]
    const again = bezierPoints([0, 0, 0], [2, 0, 0], ROUTE_SAMPLES, undefined, out)
    expect(again).toBe(out); expect(again[3]).toBe(first)
  })
})

describe('size switch', () => {
  it('scales demo endpoints and route endpoints out from their own body centres, and is the identity at k = 1', () => {
    const moon: Vec3 = [-200, 80, 310]
    const { earth, moon: m } = demoEndpoints(moon, 10)
    expect(Math.hypot(...earth)).toBeCloseTo(SCENE_RADII.earth * 10, 9)
    expect(dist(m, moon)).toBeCloseTo(SCENE_RADII.moon * 10, 9)
    expect(demoEndpoints(moon)).toEqual(demoEndpoints(moon, 1))
    const r = drawableRoutes(build(doneTask()))[0]
    expect(exaggerateRoute(r, moon, 1)).toBe(r)
    const e = exaggerateRoute(r, moon, 10)
    expect(Math.hypot(...e.start)).toBeCloseTo(Math.hypot(...r.start) * 10, 9) // Earth at the origin
    expect(dist(e.end, moon)).toBeCloseTo(dist(r.end, moon) * 10, 9) // about the Moon's centre
    expect(e.points[0]).toEqual(e.start); expect(e.points[ROUTE_SAMPLES]).toEqual(e.end)
    expect(e.launchTimeMs).toBe(r.launchTimeMs) // times are untouched
  })
})

describe('demo endpoints', () => {
  it('lie on the facing sides of the two bodies at the given Moon position', () => {
    const moon: Vec3 = [-200, 80, 310]
    const { earth, moon: m } = demoEndpoints(moon)
    expect(Math.hypot(...earth)).toBeCloseTo(SCENE_RADII.earth, 9)
    expect(dist(m, moon)).toBeCloseTo(SCENE_RADII.moon, 9)
    // Both on the segment between the centres (the facing sides).
    const total = Math.hypot(...moon)
    expect(Math.hypot(...earth) + dist(earth, m) + dist(m, moon)).toBeCloseTo(total, 6)
  })
})

describe('formal routes', () => {
  it('has no routes without a completed, current task', () => {
    for (const t of [{ status: 'idle' } as TaskState, doneTask({}, 'stale'), { status: 'running', request } as TaskState]) expect(build(t, [custom()])).toEqual(EMPTY_ROUTE_MODEL)
  })
  it('draws one route per valid recommendation with the step-14 endpoints in the unified display frame', () => {
    const m = build(doneTask())
    expect(m.routes.map((r) => r.siteId)).toEqual(ids)
    const r = drawableRoutes(m)[0]
    const c = catalog.candidates.find((x) => x.id === r.siteId)!
    const t = transitFor(c.coordinate.lat, c.coordinate.lon)
    const earth = earthSiteGeocentric(launch, t.launchTimeMs!).positionKm
    const moon = moonSiteGeocentric({ lat: c.coordinate.lat, lon: c.coordinate.lon, radiusKm: 1737.4 }, landing).positionKm
    // Same functions, same inputs; the ephemeris library may differ in the last digits between calls (1e-9 km allowed).
    expect(dist(r.start, toScene({ x: earth[0], y: earth[1], z: earth[2] }, 0.001))).toBeLessThan(1e-9)
    expect(dist(r.end, toScene({ x: moon[0], y: moon[1], z: moon[2] }, 0.001))).toBeLessThan(1e-9)
    expect(r.launchTimeMs).toBe(t.launchTimeMs); expect(r.landingTimeMs).toBe(landing)
    expect(r.points[0]).toEqual(r.start); expect(r.points[ROUTE_SAMPLES]).toEqual(r.end)
    expect(m.markers.map((x) => x.kind)).toEqual(['valid', 'valid', 'valid'])
  })
  it('reuses the transit already in the task result (no recomputation: a doctored launch time shows up)', () => {
    const t = doneTask()
    const real = t.status === 'done' ? t.result.transits![ids[0]] : null
    const doctored = { ...real!, launchTimeMs: real!.launchTimeMs! - 3_600_000 }
    const m = build(doneTask({ transits: { ...(t.status === 'done' ? t.result.transits : {}), [ids[0]]: doctored } }))
    expect(drawableRoutes(m)[0].launchTimeMs).toBe(doctored.launchTimeMs)
  })
  it('gives a reason, not a number, when the transit is missing or failed', () => {
    const m = build(doneTask({ transits: { [ids[1]]: transitFor(0, 0, null), [ids[2]]: undefined as never } }))
    const [a, b, c] = m.routes
    expect(a.status).toBe('unavailable') // no transit entry for the first site
    expect(b.status === 'unavailable' && b.reason).toMatch(/missing-elevation.*not replaced by 0 m/)
    expect(c.status).toBe('unavailable')
    expect(JSON.stringify(m.routes)).not.toMatch(/launchTimeMs/)
    expect(drawableRoutes(m)).toHaveLength(0)
    expect(m.markers).toHaveLength(3) // the sites are valid; only the route is missing
  })
  it('adds confirmed custom sites that are still valid, and drops invalid ones', () => {
    const ok = build(doneTask(), [custom()])
    expect(ok.routes.at(-1)).toMatchObject({ siteId: 'custom-3', kind: 'custom', name: 'Mine', status: 'ok' })
    expect(ok.markers.at(-1)).toMatchObject({ id: 'custom-3', kind: 'valid' })
    const moved = build(doneTask(), [custom({ lat: -81 })]) // assessment is for other coordinates
    const failed = build(doneTask(), [custom({ evaluation: { state: 'assessed', key: customSiteKey('FP', -80, 10), assessment: assessSite('c', { terrain: unk, power: pass, communication: pass, dataCompleteness: pass }) } })])
    const none = build(doneTask({ recommendations: [] }), [custom()])
    for (const m of [moved, failed]) expect(m.routes.map((r) => r.siteId)).not.toContain('custom-3')
    // The number of catalogue recommendations does not matter: a qualifying custom site has its route even with none.
    expect(none.routes.find((r) => r.kind === 'custom')).toMatchObject({ siteId: 'custom-3', status: 'ok' })
  })
  it('custom site without its own transit has a reason, not a route', () => {
    const m = build(doneTask(), [custom({ evaluation: { state: 'assessed', key: customSiteKey('FP', -80, 10), assessment: eligible('custom-3') } })])
    const r = m.routes.at(-1)!
    expect(r.status === 'unavailable' && r.reason).toMatch(/No transit estimate/)
  })
  it('keeps id and colour stable on rename and between recalculations; only the label changes', () => {
    const a = build(doneTask(), [custom({ name: 'A' })]).routes.at(-1)!
    const b = build(doneTask(), [custom({ name: 'B' })]).routes.at(-1)!
    expect([a.id, a.colour]).toEqual([b.id, b.colour]); expect(a.name).toBe('A'); expect(b.name).toBe('B')
    expect(a.status === 'ok' && b.status === 'ok' && a.points).toEqual(b.status === 'ok' ? b.points : null)
    expect(new Set(catalog.candidates.map((c) => routeColour('recommendation', c.id))).size).toBe(catalog.candidates.length)
    expect(new Set(Array.from({ length: 9 }, (_, i) => routeColour('custom', `custom-${i + 1}`))).size).toBe(9)
  })
})

describe('draft marker and demo priority', () => {
  it('a draft marker needs valid coordinates and never has a route', () => {
    expect(draftMarker({ id: 'd', name: '', lat: null, lon: 3, evaluation: { state: 'not-assessed' } })).toBeNull()
    expect(draftMarker({ id: 'd', name: '', lat: 95, lon: 3, evaluation: { state: 'not-assessed' } })).toBeNull()
    expect(draftMarker({ id: 'd', name: ' ', lat: 5, lon: 3, evaluation: { state: 'not-assessed' } })).toMatchObject({ kind: 'draft', name: 'Draft point' })
    expect(build(doneTask(), []).markers.every((m) => m.kind === 'valid')).toBe(true) // drafts never enter the model
  })
  it('shows the demo only when enabled and no formal route is drawable', () => {
    const real = build(doneTask())
    expect(showDemo(EMPTY_ROUTE_MODEL, true)).toBe(true)
    expect(showDemo(EMPTY_ROUTE_MODEL, false)).toBe(false)
    expect(showDemo(real, true)).toBe(false)
    const failedOnly = build(doneTask({ transits: {} }))
    expect(showDemo(failedOnly, true)).toBe(true) // valid sites but nothing drawable
  })
  it('reads the validated input of the draft', () => {
    expect(inputOfDraft({ landingTimeMs: landing, durationDays: 3, launchLat: 1, launchLon: 2 })).toMatchObject({ landingTimeMs: landing })
    expect(inputOfDraft({ landingTimeMs: null, durationDays: 3, launchLat: 1, launchLon: 2 })).toBeNull()
  })
})

describe('routes store', () => {
  it('starts with the demo allowed; a confirmed reset switches it off and it stays off until the user turns it on', () => {
    useRoutes.setState({ demoEnabled: true, viewNonce: 0 })
    expect(useRoutes.getState().demoEnabled).toBe(true)
    useRoutes.getState().resetConfirmed()
    expect(useRoutes.getState().demoEnabled).toBe(false)
    expect(showDemo(EMPTY_ROUTE_MODEL, useRoutes.getState().demoEnabled)).toBe(false)
    useRoutes.getState().setDemoEnabled(true)
    expect(showDemo(EMPTY_ROUTE_MODEL, useRoutes.getState().demoEnabled)).toBe(true)
  })
  it('each View route press is one request', () => {
    useRoutes.setState({ viewNonce: 0 })
    useRoutes.getState().requestView(); useRoutes.getState().requestView()
    expect(useRoutes.getState().viewNonce).toBe(2)
  })
})
