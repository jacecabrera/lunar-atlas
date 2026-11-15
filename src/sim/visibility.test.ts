// Formal visibility with the real ephemeris. Skylines are SYNTHETIC (set relative to the computed Sun and Earth
// positions so the expected outcome is known); real candidate results are at the end.
import { describe, expect, it } from 'vitest'
import { SearchLunarEclipse } from 'astronomy-engine'
import { visibilityModel } from './visibility'
import type { HorizonData } from './horizonData'
import { siteSky } from '../physics/siteSky'
import { skyAt } from './site'
import { loadCandidateCatalog } from './catalog'
import { diskTerrainStore } from './testing/publishedTerrain'

const T = Date.UTC(2026, 10, 20, 6)
/** A formal (gate-passing) horizon with skyline values from a function of azimuth, at 0.5 deg steps. */
function horizon(lat: number, lon: number, sky: (az: number) => number, lowerBound: (az: number) => boolean = () => false, radiusKm = 1737.4): HorizonData {
  const az = Array.from({ length: 720 }, (_, i) => i * 0.5)
  const status = az.map((a) => (lowerBound(a) ? 'lower-bound' as const : 'complete' as const))
  return {
    status: 'available', site: { lat, lon },
    samples: { elevationsDeg: az.map(sky), startAzimuthDeg: 0, stepDeg: 0.5, angleUnit: 'deg' },
    source: { product: 'synthetic', gridSpacingKm: 0.002, verticalAccuracyM: null, referenceRadiusKm: 1737.4, frame: 'synthetic' },
    model: { maxRangeKm: 200, mastM: 0, rayStepKm: 0.001, observerElevationM: (radiusKm - 1737.4) * 1000 },
    observer: { elevationM: (radiusKm - 1737.4) * 1000, elevationSource: 'synthetic', elevationQuality: 'measured', observerHeightM: 0, radiusKm },
    coverage: { searchRangeKm: 200, nearStartKm: 0.02, complete: status.every((s) => s === 'complete'), nearField: 'screened', sampleStatus: status, coveredToKm: az.map(() => 200), governingKm: az.map(() => 1), governingSource: az.map(() => 's'), uncertaintyDeg: az.map(() => null), fallbackSamples: 0, skippedSamples: 0, lowerBoundAzimuths: status.filter((s) => s !== 'complete').length },
    quality: { nearFieldSelection: { productId: 's', tier: 'all gates', degraded: false }, convergence: { status: 'within-tolerance', toleranceDeg: 0.05, checks: [] } },
  }
}
const site = { lat: 20, lon: 30 }
const sky = siteSky(site.lat, site.lon, new Date(T))
const model = (h: (az: number) => number, opts: { min?: number; lb?: (az: number) => boolean } = {}) =>
  visibilityModel({ ...site, horizon: horizon(site.lat, site.lon, h, opts.lb) }, { earthMinElevationDeg: opts.min ?? 0 })

describe('Sun: any part of the disc, no minimum elevation', () => {
  const { elevation: el, angularRadius: r } = sky.sun
  it('a visible limb with the centre below the skyline is visible, with a small fraction', () => {
    const s = model(() => el + r / 2).sunAt(T)
    expect(s.formal).toBe(true)
    expect(s.terrainVisible).toBe(true)
    expect(s.sunlit).toBe(true)
    expect(s.visibleFraction!).toBeGreaterThan(0)
    expect(s.visibleFraction!).toBeLessThan(0.3) // a limb is not full sunlight
    expect(s.blockedBy).toEqual(['terrain'])
  })
  it('fully hidden, partly and fully visible', () => {
    expect(model(() => el + r + 0.01).sunAt(T)).toMatchObject({ terrainVisible: false, sunlit: false, visibleFraction: 0 })
    expect(model(() => el).sunAt(T).visibleFraction).toBeCloseTo(0.5, 3)
    expect(model(() => el - r - 0.01).sunAt(T)).toMatchObject({ sunlit: true, visibleFraction: 1, blockedBy: [] })
  })
  it('uses a negative skyline as it is (no clamp to 0 deg)', () => {
    // Skyline 0.6 deg below the Sun centre and below 0 deg if the Sun is low: still fully visible.
    expect(model(() => Math.min(el - r - 0.3, -0.6)).sunAt(T).visibleFraction).toBe(1)
  })
  it('does not decide over a lower-bound sample unless the disc is wholly below it', () => {
    const lbNear = (a: number) => Math.abs(a - sky.sun.azimuth) < 2
    const above = model(() => el - r / 2, { lb: lbNear }).sunAt(T)
    expect(above.sunlit).toBeNull()
    expect(above.visibleFraction).toBeNull()
    expect(above.visibleFractionUpperBound!).toBeGreaterThan(0.5)
    expect(above.reasons[0].code).toBe('sun-skyline-lower-bound')
    const below = model(() => el + r + 0.2, { lb: lbNear }).sunAt(T)
    expect(below).toMatchObject({ sunlit: false, visibleFraction: 0 })
  })
})

describe('Earth: disc centre above max(skyline, minimum elevation)', () => {
  const { elevation: el, angularRadius: r } = sky.earth
  it('a visible limb with the centre below the skyline is NOT visible', () => {
    const e = model(() => el + r / 2).earthAt(T)
    expect(e.visible).toBe(false)
    expect(e.marginDeg!).toBeLessThan(0)
    expect(model(() => el - 0.01).earthAt(T).visible).toBe(true)
    expect(model(() => el).earthAt(T).visible).toBe(false) // strictly above
  })
  it('a negative skyline does not lower the default 0 deg minimum; a configured minimum does', () => {
    // Put the site where the Earth centre is slightly below 0 deg: (lat, lon) with Earth near the horizon.
    const low = { lat: 0, lon: 91.5 }
    const e = siteSky(low.lat, low.lon, new Date(T)).earth
    expect(e.elevation).toBeLessThan(0.9)
    const h = horizon(low.lat, low.lon, () => -1.5)
    const at = (min: number) => visibilityModel({ ...low, horizon: h }, { earthMinElevationDeg: min }).earthAt(T)
    if (e.elevation <= 0) {
      expect(at(0).visible).toBe(false)
      expect(at(-1).visible).toBe(e.elevation > -1)
    } else {
      expect(at(e.elevation + 0.1).visible).toBe(false)
      expect(at(-1).visible).toBe(true)
    }
  })
  it('lower bound: below it hidden, above it unknown', () => {
    const lb = () => true
    expect(model(() => el + 1, { lb }).earthAt(T).visible).toBe(false)
    expect(model(() => el - 1, { lb }).earthAt(T).visible).toBeNull()
  })
})

describe('lunar eclipse seen from the Moon (2025-03-14, total)', async () => {
  const eclipse = SearchLunarEclipse(new Date('2025-03-01T00:00:00Z'))
  const peak = eclipse.peak.date.getTime()
  const near = { lat: 0, lon: 0 } // the Sun and the Earth are both high here at full Moon
  const m = visibilityModel({ ...near, horizon: horizon(near.lat, near.lon, () => 0) }, { earthMinElevationDeg: 0 })
  it('is a total eclipse found independently by Astronomy Engine', () => {
    expect(eclipse.kind).toBe('total')
    expect(new Date(peak).toISOString().slice(0, 13)).toBe('2025-03-14T06')
  })
  it('hides the whole Sun at the peak and part of it during the partial phase; never silently full sunlight', () => {
    const s = m.sunAt(peak)
    expect(s.earthOccultedFraction).toBe(1)
    expect(s).toMatchObject({ sunlit: false, visibleFraction: 0, blockedBy: ['earth'] })
    expect(s.terrainVisible).toBe(true) // the terrain alone would show it
    const partial = [...Array(80).keys()].map((k) => m.sunAt(peak - (k + 1) * 3 * 60_000)).find((x) => x.earthOccultedFraction > 0.2 && x.earthOccultedFraction < 0.8)
    expect(partial).toBeDefined()
    expect(partial!.sunlit).toBe(true)
    expect(partial!.visibleFraction).toBeCloseTo(1 - partial!.earthOccultedFraction, 3)
    expect(m.sunAt(peak - 3 * 86_400_000).earthOccultedFraction).toBe(0)
  })
  it('combines the Earth and a skyline on the same disc', () => {
    const t = [...Array(120).keys()].map((k) => peak - (k + 1) * 2 * 60_000).find((x) => { const o = m.sunAt(x).earthOccultedFraction; return o > 0.3 && o < 0.7 })!
    const sun = siteSky(near.lat, near.lon, new Date(t)).sun
    const both = visibilityModel({ ...near, horizon: horizon(near.lat, near.lon, () => sun.elevation) }, { earthMinElevationDeg: 0 }).sunAt(t)
    expect(both.blockedBy).toEqual(['terrain', 'earth'])
    expect(both.visibleFraction!).toBeLessThan(both.terrainVisibleFraction!)
    expect(both.visibleFraction!).toBeLessThan(1 - both.earthOccultedFraction)
  })
  it('reports a total occultation even without a usable horizon', () => {
    const s = visibilityModel({ ...near, horizon: null }, { earthMinElevationDeg: 0 }).sunAt(peak)
    expect(s).toMatchObject({ formal: false, sunlit: false, visibleFraction: 0 })
  })
})

describe('quality gate and inputs', () => {
  it('without a formal horizon returns geometry but no verdict (no smooth-sphere fallback)', () => {
    const bad = horizon(site.lat, site.lon, () => -10)
    if (bad.status !== 'available') throw new Error('unreachable')
    const m = visibilityModel({ ...site, horizon: { ...bad, quality: { ...bad.quality!, convergence: { status: 'exceeds-tolerance', toleranceDeg: 0.05, checks: [] } } } }, { earthMinElevationDeg: 0 })
    expect(m.status).toBe('unavailable')
    const s = m.sunAt(T)
    expect(s.geometry.elevationDeg).toBeCloseTo(sky.sun.elevation, 9)
    expect(s.sunlit).toBeNull()
    expect(s.formal).toBe(false)
    expect(m.earthAt(T).visible).toBe(sky.earth.elevation <= 0 ? false : null)
    expect(visibilityModel({ ...site, horizon: null }, { earthMinElevationDeg: 0 }).reasons[0].code).toBe('horizon-missing')
  })
  it('uses the observer radius recorded with the horizon', () => {
    const m = visibilityModel({ ...site, horizon: horizon(site.lat, site.lon, () => 0, undefined, 1735.2) }, { earthMinElevationDeg: 0 })
    expect(m.observerRadiusKm).toBe(1735.2)
    expect(m.sunAt(T).geometry.distanceKm).toBeCloseTo(siteSky(site.lat, site.lon, new Date(T), 1735.2).sun.distanceKm, 6)
  })
  it('rejects invalid input', () => {
    expect(() => visibilityModel({ lat: 95, lon: 0, horizon: null }, { earthMinElevationDeg: 0 })).toThrow(RangeError)
    expect(() => visibilityModel({ ...site, horizon: null }, { earthMinElevationDeg: Number.NaN })).toThrow(RangeError)
  })
  it('the preview skyAt follows the same split rules', () => {
    const { elevation: el, angularRadius: r } = sky.earth
    expect(skyAt({ ...site, horizon: () => el + r / 2 }, new Date(T)).earthUp).toBe(false)
    expect(skyAt({ ...site, horizon: () => sky.sun.elevation + sky.sun.angularRadius / 2 }, new Date(T)).sunUp).toBe(true)
    expect(skyAt({ ...site, horizon: () => -2 }, new Date(T)).sunUp).toBe(sky.sun.elevation + sky.sun.angularRadius > -2)
  })
})

describe('12 catalogue candidates', async () => {
  const store = diskTerrainStore()
  const catalog = loadCandidateCatalog()
  it('have no formal visibility yet (their horizons fail the quality gate)', async () => {
    for (const c of catalog.candidates) {
      const t = await store.load(c.id)
      const m = visibilityModel(t.toSerializableSite(), { earthMinElevationDeg: 0 })
      expect(m.status, c.id).toBe('unavailable')
      expect(m.reasons.map((x) => x.code), c.id).toContain('horizon-not-converged')
      expect(m.observerRadiusSource).toBe('horizon-observer')
      expect(m.sunAt(T).sunlit === null || m.sunAt(T).sunlit === false).toBe(true)
    }
  })
})

describe('numerical zero is not tangency', () => {
  it('a sub-resolution sliver is reported as unresolved (null with a small upper bound) or as a positive fraction, never 0', () => {
    const { elevation: el, angularRadius: r, azimuth: az } = sky.sun
    const step = 0.0005
    const n = 360 / step
    const top = el + r
    // Skyline 1e-4 deg above the disc top everywhere except a V-shaped notch 2e-4 deg deep at the Sun azimuth.
    const values = Array.from({ length: n }, (_, i) => (Math.abs(i * step - az) < step / 2 ? top - 1e-4 : top + 1e-4))
    const h = horizon(site.lat, site.lon, () => 0)
    if (h.status !== 'available') throw new Error('unreachable')
    const st = Array(n).fill('complete')
    const fine: HorizonData = { ...h, samples: { ...h.samples, elevationsDeg: values, stepDeg: step }, coverage: { ...h.coverage!, sampleStatus: st, coveredToKm: Array(n).fill(200), governingKm: Array(n).fill(1), governingSource: Array(n).fill('s'), uncertaintyDeg: Array(n).fill(null) } }
    const s = visibilityModel({ ...site, horizon: fine }, { earthMinElevationDeg: 0 }).sunAt(T)
    expect(s.terrainVisible).toBe(true)
    expect(s.terrainMarginDeg!).toBeGreaterThan(0)
    if (s.visibleFraction === null) {
      expect(s.reasons[0].code).toBe('sun-sliver-below-resolution')
      expect(s.visibleFractionUpperBound!).toBeLessThan(1e-3)
    } else expect(s.visibleFraction).toBeGreaterThan(0)
  })
})
