// Event search and mission statistics. Two kinds of fixtures, both SYNTHETIC:
//  - analytic fake visibility models whose events are known in closed form (and that respect the rate bounds);
//  - the real visibility model with synthetic skylines, checked against brute-force dense state sampling, which uses
//    the visibility model but not the search algorithm under test.
import { vi, describe, expect, it } from 'vitest'
import { SearchLunarEclipse } from 'astronomy-engine'
import { searchEvents, nextSet, missionStatistics, RATE_BOUNDS } from './events'
import type { Channel } from './events'
import { visibilityModel } from './visibility'
import type { VisibilityModel, SunVisibility, EarthVisibility } from './visibility'
import type { HorizonData } from './horizonData'
import { siteSky } from '../physics/siteSky'
import { SUN_VISIBILITY_POLICY, earthVisibilityPolicy } from './assessment'
// Real-ephemeris brute-force references in this file take 1-4 s alone and timed out at the 5 s default under
// parallel load; a run-time limit only, no numerical tolerance depends on it.
vi.setConfig({ testTimeout: 60_000 })


const H = 3_600_000, MIN = 60_000, DAY = 86_400_000
const T0 = Date.UTC(2026, 10, 15)

// ─── Analytic fake model ───────────────────────────────────────────────────
/** margin(t) in deg drives both bodies; state null where `unknown(t)`. elevation(t) feeds the statistics. */
function fake(margin: (t: number) => number, opts: { unknown?: (t: number) => boolean; elevation?: (t: number) => number } = {}): VisibilityModel {
  const el = opts.elevation ?? ((t: number) => margin(t))
  const sunAt = (t: number): SunVisibility => {
    const m = margin(t), unk = opts.unknown?.(t) ?? false
    return {
      tMs: t, geometry: { elevationDeg: el(t), azimuthDeg: 90, angularRadiusDeg: 0.27, distanceKm: 1.5e8 }, formal: true,
      terrainVisible: unk ? null : m > 0, terrainVisibleFraction: null, earthOccultedFraction: 0, visibleFraction: unk ? null : m > 0 ? 1 : 0,
      visibleFractionUpperBound: null, sunlit: unk ? null : m > 0, blockedBy: [], terrainMarginDeg: unk ? null : m, terrainClearanceDeg: unk ? null : m - 0.54,
      earthSeparationDeg: 60, reasons: [],
    }
  }
  const earthAt = (t: number): EarthVisibility => {
    const m = margin(t), unk = opts.unknown?.(t) ?? false
    return { tMs: t, geometry: { elevationDeg: 1 + m, azimuthDeg: 180, angularRadiusDeg: 0.95, distanceKm: 384_400 }, formal: true, minElevationDeg: 0, skylineDeg: 1, skylineIsLowerBound: false, marginDeg: unk ? null : m, visible: unk ? null : m > 0, reasons: [] }
  }
  return { mode: 'strict', estimated: false, warnings: [], status: 'ready', reasons: [], observerRadiusKm: 1737.4, observerRadiusSource: 'horizon-observer', policy: { sun: SUN_VISIBILITY_POLICY, earth: earthVisibilityPolicy(0) }, model: 'fake', sunAt, earthAt, skylineMaxSlope: 0, lowerBoundInAzimuths: () => false }
}
// The fake must respect the bounds it is tested against: slopes below the Earth bound (0.15 deg/h).
// A triangle bump peaking at `peak` deg, floored at -0.05.
const s = 0.14 / H // deg per ms
const bump = (t0: number, peak: number) => (t: number) => Math.max(peak - s * Math.abs(t - t0), -0.05)

describe('event discovery inside one scan step (analytic)', () => {
  it('finds a 5-minute window inside a 30-minute step, at the exact times', () => {
    const peak = s * 2.5 * MIN
    const t0 = T0 + 7 * H + 11 * MIN
    const r = searchEvents(fake(bump(t0, peak)), 'earth', T0, T0 + DAY)
    expect(r.events.map((e) => e.kind)).toEqual(['rise', 'set'])
    expect(Math.abs(r.events[0].tMs - (t0 - 2.5 * MIN))).toBeLessThanOrEqual(1000)
    expect(Math.abs(r.events[1].tMs - (t0 + 2.5 * MIN))).toBeLessThanOrEqual(1000)
    expect(r.status).toBe('complete')
  })
  it('finds a 20-second window far from the middle of its scan step (end states equal)', () => {
    const t0 = T0 + 2 * H + 3 * MIN + 7_000 // 3 min into a 30 min step
    const r = searchEvents(fake(bump(t0, s * 10_000)), 'earth', T0, T0 + 6 * H)
    expect(r.events.map((e) => e.kind)).toEqual(['rise', 'set'])
    expect(Math.abs(r.events[1].tMs - r.events[0].tMs - 20_000)).toBeLessThanOrEqual(2000)
  })
  it('finds a 5-minute gap inside a 30-minute step', () => {
    const t0 = T0 + 3 * H + 7 * MIN
    const r = searchEvents(fake((t) => -bump(t0, s * 2.5 * MIN)(t)), 'earth', T0, T0 + 12 * H)
    expect(r.events.map((e) => e.kind)).toEqual(['set', 'rise'])
  })
  it('a tangency (peak exactly 0) gives no event but an unresolved interval, never a window', () => {
    const t0 = T0 + 5 * H + 3 * MIN
    const r = searchEvents(fake(bump(t0, 0)), 'earth', T0, T0 + 12 * H)
    expect(r.events).toEqual([])
    expect(r.segments.every((x) => x.state === false)).toBe(true)
    expect(r.unresolved.length).toBeGreaterThan(0)
    expect(r.unresolved.every((u) => u.end - u.start <= r.settings.minResolveMs)).toBe(true)
    expect(r.unresolved.some((u) => u.start <= t0 && t0 <= u.end)).toBe(true)
  })
  it('reports budget exhaustion instead of no events', () => {
    const r = searchEvents(fake(bump(T0 + 30 * H, 0)), 'earth', T0, T0 + 3 * DAY, { maxEvaluations: 100 })
    expect(r.status).toBe('budget-exhausted')
    expect(r.searchedToMs).toBeLessThan(T0 + 3 * DAY)
  })
  it('keeps unknown states unknown and locates their boundaries', () => {
    const r = searchEvents(fake(() => 1, { unknown: (t) => t > T0 + 2 * H && t < T0 + 3 * H }), 'earth', T0, T0 + 6 * H)
    expect(r.events.map((e) => e.kind)).toEqual(['unknown-start', 'unknown-end'])
    expect(r.events[0].cause).toBe('data')
    const unknown = r.segments.filter((x) => x.state === null)
    expect(unknown).toHaveLength(1)
    expect(Math.abs(unknown[0].end - unknown[0].start - H)).toBeLessThanOrEqual(2000)
  })
})

describe('next set (analytic)', () => {
  const t0 = T0 + 10 * H
  const m = fake(bump(t0, s * 30 * MIN)) // visible for one hour around t0
  it('when visible, returns the coming set with the remaining time', () => {
    const r = nextSet(m, { target: 'earth', queryMs: t0, searchMs: DAY })
    expect(r.status).toBe('found')
    expect(Math.abs(r.msUntil! - 30 * MIN)).toBeLessThanOrEqual(1000)
    expect(r.cause).toBe('terrain')
  })
  it('when not visible, returns the set after the next rise (not the rise)', () => {
    const r = nextSet(m, { target: 'earth', queryMs: T0, searchMs: DAY })
    expect(r.status).toBe('found')
    expect(Math.abs(r.eventMs! - (t0 + 30 * MIN))).toBeLessThanOrEqual(1000)
  })
  it('not found in a fully checked range: null time, not zero, with the range', () => {
    const r = nextSet(fake(() => -1), { target: 'earth', queryMs: T0, searchMs: 2 * DAY })
    expect(r).toMatchObject({ status: 'not-found', eventMs: null, msUntil: null, searchStartMs: T0, searchEndMs: T0 + 2 * DAY })
  })
  it('a set exactly at the end of the range is included; just after it is not', () => {
    const end = t0 + 30 * MIN
    expect(nextSet(m, { target: 'earth', queryMs: t0, searchMs: end - t0 + 2000 }).status).toBe('found')
    expect(nextSet(m, { target: 'earth', queryMs: t0, searchMs: 20 * MIN }).status).toBe('not-found')
  })
  it('unknown data before any set gives unknown, and an exhausted budget gives incomplete', () => {
    expect(nextSet(fake(() => 1, { unknown: (t) => t > T0 + H }), { target: 'earth', queryMs: T0, searchMs: DAY }).status).toBe('unknown')
    expect(nextSet(fake(bump(T0 + 40 * H, 0)), { target: 'earth', queryMs: T0, searchMs: 3 * DAY }, { maxEvaluations: 100 }).status).toBe('incomplete')
  })
})

describe('mission statistics (analytic)', () => {
  it('all visible, all hidden, boundaries at the window edges', () => {
    const all = missionStatistics(fake(() => 1), { startMs: T0, endMs: T0 + DAY })
    expect(all.status).toBe('complete')
    expect(all.earthVisibleFraction.value).toBe(1)
    expect(all.longestEarthGap.value).toBe(0)
    const none = missionStatistics(fake(() => -1), { startMs: T0, endMs: T0 + DAY })
    expect(none.sunlitDuration.value).toBe(0) // a real zero
    expect(none.sunlitFraction.value).toBe(0)
    expect(none.longestDarkness.value).toBe(DAY)
    expect(none.sunElevationMean.value).toBeNull() // not applicable, not 0
    expect(none.sunElevationPeak.value).toBeNull()
    // Window that starts inside a visible period and ends inside the next one: clipped, not extended.
    const t0 = T0 + 6 * H
    const st = missionStatistics(fake(bump(t0, s * 2 * H)), { startMs: t0, endMs: t0 + H })
    expect(st.sunIntervals).toEqual([{ start: t0, end: t0 + H }])
  })
  it('time-weighted mean and peak elevation, longest gap and intersection', () => {
    // Visible 2 h around t0 with elevation rising linearly from 0 to 2 deg across the window.
    const t0 = T0 + 10 * H
    const m = fake(bump(t0, s * H), { elevation: (t) => (t - (t0 - H)) / H })
    const st = missionStatistics(m, { startMs: T0, endMs: T0 + DAY })
    expect(st.sunlitDuration.value! / H).toBeCloseTo(2, 3)
    expect(st.sunElevationMean.value!).toBeCloseTo(1, 3) // mean of a linear ramp 0..2
    expect(st.sunElevationPeak.value!).toBeCloseTo(2, 2)
    expect(st.longestDarkness.value! / H).toBeCloseTo(13, 3) // after the window: t0 + 1 h to the end of the day
    expect(st.sunAndEarthFraction.value).toBeCloseTo(st.sunlitFraction.value!, 9) // same margin drives both
  })
  it('with unknown time, returns null full-mission values with reasons and labelled partial values', () => {
    const st = missionStatistics(fake(() => 1, { unknown: (t) => t > T0 + 20 * H }), { startMs: T0, endMs: T0 + DAY })
    expect(st.status).toBe('incomplete')
    expect(st.sunlitFraction.value).toBeNull()
    expect(st.partial!.unknownSunMs / H).toBeCloseTo(4, 3)
    expect(st.partial!.knownSunlitMs / H).toBeCloseTo(20, 3) // unknown time not counted as dark or visible
    expect(st.reasons.map((x) => x.code)).toContain('sun-state-unknown')
  })
})

// ─── Real ephemeris with synthetic skylines ────────────────────────────────
function horizon(lat: number, lon: number, sky: (az: number) => number): HorizonData {
  const az = Array.from({ length: 720 }, (_, i) => i * 0.5)
  return {
    status: 'available', site: { lat, lon }, samples: { elevationsDeg: az.map(sky), startAzimuthDeg: 0, stepDeg: 0.5, angleUnit: 'deg' },
    source: { product: 'synthetic', gridSpacingKm: 0.002, verticalAccuracyM: null, referenceRadiusKm: 1737.4, frame: 'synthetic' },
    model: { maxRangeKm: 200, mastM: 0, rayStepKm: 0.001, observerElevationM: 0 },
    observer: { elevationM: 0, elevationSource: 'synthetic', elevationQuality: 'measured', observerHeightM: 0, radiusKm: 1737.4 },
    coverage: { searchRangeKm: 200, nearStartKm: 0.02, complete: true, nearField: 'screened', sampleStatus: az.map(() => 'complete'), coveredToKm: az.map(() => 200), governingKm: az.map(() => 1), governingSource: az.map(() => 's'), uncertaintyDeg: az.map(() => null), fallbackSamples: 0, skippedSamples: 0, lowerBoundAzimuths: 0 },
    quality: { nearFieldSelection: { productId: 's', tier: 'all gates', degraded: false }, convergence: { status: 'within-tolerance', toleranceDeg: 0.05, checks: [] } },
  }
}
/** Brute-force state changes from sampling every `stepMs` (reference independent of the search algorithm). */
function brute(m: VisibilityModel, channel: Channel, a: number, b: number, stepMs: number) {
  const st = (t: number) => (channel === 'earth' ? m.earthAt(t).visible : channel === 'sun' ? m.sunAt(t).sunlit : m.sunAt(t).terrainVisible)
  const out: Array<{ t: number; kind: string }> = []
  let prev = st(a)
  for (let t = a + stepMs; t <= b; t += stepMs) { const x = st(t); if (x !== prev) out.push({ t: t - stepMs / 2, kind: x ? 'rise' : 'set' }); prev = x }
  return out
}

describe('real ephemeris: rate bounds, terrain, seams and eclipses', () => {
  it('sampled sky rates over 2016-2036 stay below the derived bounds (a consistency check, not the proof)', () => {
    let sunMax = 0, earthMax = 0
    for (const [lat, lon] of [[0, 0], [-89.5, 0], [45, -60], [0, 180]]) {
      for (let t = Date.UTC(2016, 10, 14); t < Date.UTC(2036, 10, 14); t += 3 * DAY + 7 * H) {
        const a = siteSky(lat, lon, new Date(t)), b = siteSky(lat, lon, new Date(t + 10 * MIN))
        const ang = (p: typeof a.sun, q: typeof a.sun) => { const r = Math.PI / 180; return Math.acos(Math.min(1, Math.sin(p.elevation * r) * Math.sin(q.elevation * r) + Math.cos(p.elevation * r) * Math.cos(q.elevation * r) * Math.cos((p.azimuth - q.azimuth) * r))) / r }
        sunMax = Math.max(sunMax, ang(a.sun, b.sun) * 6)
        earthMax = Math.max(earthMax, ang(a.earth, b.earth) * 6)
      }
    }
    expect(sunMax).toBeLessThan(RATE_BOUNDS.sunDegPerHour)
    expect(earthMax).toBeLessThan(RATE_BOUNDS.earthDegPerHour)
  })

  // A polar site with a rugged synthetic skyline: the Sun grazes the terrain and crosses north (azimuth seam).
  const polar = { lat: -88.5, lon: 40 }
  const rugged = (az: number) => 1.2 + 0.9 * Math.sin((az * Math.PI) / 15) + 0.4 * Math.sin((az * Math.PI) / 4.5) + (az < 3 || az > 357 ? 1.5 : 0)
  const pm = visibilityModel({ ...polar, horizon: horizon(polar.lat, polar.lon, rugged) }, { earthMinElevationDeg: 0 })
  const start = Date.UTC(2027, 0, 3), end = start + 14 * DAY

  it('matches brute-force sampling at a polar grazing site, across the azimuth seam', () => {
    const r = searchEvents(pm, 'sun-terrain', start, end)
    const b = brute(pm, 'sun-terrain', start, end, 20_000)
    expect(r.status).toBe('complete')
    expect(r.events.length).toBe(b.length)
    r.events.forEach((e, i) => { expect(e.kind).toBe(b[i].kind); expect(Math.abs(e.tMs - b[i].t)).toBeLessThanOrEqual(10_000 + e.toleranceMs) })
    expect(r.events.length).toBeGreaterThan(4)
  })

  it('matches brute force on a steep skyline (cliffs of 8 deg within 1 deg of azimuth)', () => {
    const site = { lat: 5, lon: 40 }
    const steep = (az: number) => (Math.floor(az / 7) % 2 === 0 ? 0.5 : 0.5 + 8 * Math.min(1, ((az % 7) / 1)))
    const m = visibilityModel({ ...site, horizon: horizon(site.lat, site.lon, steep) }, { earthMinElevationDeg: 0 })
    expect(m.skylineMaxSlope!).toBeGreaterThan(10)
    const a = Date.UTC(2027, 1, 1), b = a + 30 * DAY
    const r = searchEvents(m, 'sun-terrain', a, b)
    const ref = brute(m, 'sun-terrain', a, b, 20_000)
    expect(r.events.length).toBe(ref.length)
    r.events.forEach((e, i) => expect(Math.abs(e.tMs - ref[i].t)).toBeLessThanOrEqual(10_000 + e.toleranceMs))
  })

  it('handles an eclipse while the Sun straddles the skyline (terrain and Earth together)', () => {
    const peak = SearchLunarEclipse(new Date('2025-03-01T00:00:00Z')).peak.date.getTime()
    // A site where the Sun is low during the eclipse: put the skyline through the Sun centre at the peak.
    const site = { lat: 0, lon: 80 }
    const sunEl = siteSky(site.lat, site.lon, new Date(peak)).sun.elevation
    const m = visibilityModel({ ...site, horizon: horizon(site.lat, site.lon, () => sunEl) }, { earthMinElevationDeg: 0 })
    const r = searchEvents(m, 'sun', peak - 3 * H, peak + 3 * H)
    const ref = brute(m, 'sun', peak - 3 * H, peak + 3 * H, 15_000)
    // Every brute-force change is matched by an event or lies inside an unresolved interval.
    for (const x of ref) {
      const matched = r.events.some((e) => Math.abs(e.tMs - x.t) <= 15_000) || r.unresolved.some((u) => u.start - 15_000 <= x.t && x.t <= u.end + 15_000)
      expect(matched).toBe(true)
    }
  })

  it('converges: scan step, halving limit and location tolerance do not change events or totals', () => {
    const runs = [{ scanStepMs: 2 * H }, { scanStepMs: 30 * MIN }, { scanStepMs: 10 * MIN, minResolveMs: 2000, locateToleranceMs: 250 }]
      .map((o) => missionStatistics(pm, { startMs: start, endMs: end }, o))
    const ref = runs[2]
    for (const r of runs) {
      expect(r.sun.events.length).toBe(ref.sun.events.length)
      r.sun.events.forEach((e, i) => expect(Math.abs(e.tMs - ref.sun.events[i].tMs)).toBeLessThanOrEqual(1500))
      expect(Math.abs(r.sunlitDuration.value! - ref.sunlitDuration.value!)).toBeLessThanOrEqual(1500 * ref.sun.events.length)
    }
  })

  it('reports an eclipse as an Earth event, not as a sunset', () => {
    const peak = SearchLunarEclipse(new Date('2025-03-01T00:00:00Z')).peak.date.getTime()
    const m = visibilityModel({ lat: 0, lon: 0, horizon: horizon(0, 0, () => -5) }, { earthMinElevationDeg: 0 })
    const r = searchEvents(m, 'sun', peak - 4 * H, peak + 4 * H)
    expect(r.events.map((e) => [e.kind, e.cause])).toEqual([['set', 'earth'], ['rise', 'earth']])
    const b = brute(m, 'sun', peak - 4 * H, peak + 4 * H, 30_000)
    r.events.forEach((e, i) => expect(Math.abs(e.tMs - b[i].t)).toBeLessThanOrEqual(30_000))
    expect(searchEvents(m, 'sun-terrain', peak - 4 * H, peak + 4 * H).events).toEqual([]) // terrain alone: no sunset
    const st = missionStatistics(m, { startMs: peak - 4 * H, endMs: peak + 4 * H })
    expect(st.eclipseDuration.value!).toBeGreaterThan(30 * MIN)
    expect(st.sunlitDuration.value! + st.eclipseDuration.value!).toBeCloseTo(8 * H, -4)
    const ns = nextSet(m, { target: 'sun', queryMs: peak - 4 * H })
    expect(ns.cause).toBe('earth')
  })

  it('a far-side site never sees the Earth; the sub-Earth point always does', () => {
    const far = visibilityModel({ lat: 0, lon: 180, horizon: horizon(0, 180, () => -3) }, { earthMinElevationDeg: 0 })
    const st = missionStatistics(far, { startMs: start, endMs: start + 10 * DAY })
    expect(st.earthVisibleDuration.value).toBe(0)
    expect(st.longestEarthVisible.value).toBe(0)
    const sub = visibilityModel({ lat: 0, lon: 0, horizon: horizon(0, 0, () => -3) }, { earthMinElevationDeg: 0 })
    expect(missionStatistics(sub, { startMs: start, endMs: start + 10 * DAY }).earthVisibleFraction.value).toBe(1)
  })
})

describe('12 catalogue candidates (published terrain, formal entry)', async () => {
  const { loadCandidateCatalog } = await import('./catalog')
  const { diskTerrainStore } = await import('./testing/publishedTerrain')
  const store = diskTerrainStore()
  const catalog = loadCandidateCatalog()
  it('give no full Sun statistics (horizons fail the gate); Earth values only where terrain cannot matter', async () => {
    const start = Date.UTC(2027, 0, 10)
    for (const c of catalog.candidates) {
      const m = visibilityModel((await store.load(c.id)).toSerializableSite(), { earthMinElevationDeg: 0 })
      const st = missionStatistics(m, { startMs: start, endMs: start + 3 * DAY })
      expect(st.sunStatus, c.id).toBe('incomplete')
      expect(st.sunlitDuration.value, c.id).toBeNull()
      if (c.id === 'change-4') {
        // Far side: the Earth centre stays below 0 deg, which no terrain can change.
        expect(st.earthStatus).toBe('complete')
        expect(st.earthVisibleDuration.value).toBe(0)
      }
      const ns = nextSet(m, { target: 'sun', queryMs: start, searchMs: 3 * DAY })
      expect(ns.status, c.id).toBe('unknown')
    }
  })
})
