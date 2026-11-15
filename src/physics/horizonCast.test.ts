// Synthetic terrain with known geometry. These fixtures exist only for tests; they are not candidate data.
import { describe, expect, it } from 'vitest'
import { castHorizon } from './horizonCast'
import type { HeightSource } from './horizonCast'

const R = 1737.4
const DEG = Math.PI / 180
const angDistKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const h = Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}
const flat = (id: string, minKm: number, maxKm: number, stepKm: number, extra: Partial<HeightSource> = {}): HeightSource =>
  ({ id, minKm, maxKm, stepKm, sample: () => 0, sigmaM: 1, ...extra })
const base = { latDeg: 0, lonDeg: 0, observerRadiusKm: R, referenceRadiusKm: R, azimuthStepDeg: 90, nearStartKm: 0.02, maxRangeKm: 100 }

describe('castHorizon geometry', () => {
  it('a smooth sphere gives the curvature dip of the nearest sample, kept negative (not clipped to 0)', () => {
    const r = castHorizon([flat('s', 0, 200, 0.5)], base)
    const expected = -(0.02 / R) / 2 / DEG // e = -theta/2 for an observer on the surface
    for (const a of r.azimuths) {
      expect(a.elevationDeg).toBeCloseTo(expected, 6)
      expect(a.elevationDeg).toBeLessThan(0)
      expect(a.status).toBe('complete')
    }
  })

  it('an observer raised above a smooth sphere sees a depressed horizon', () => {
    const r = castHorizon([flat('s', 0, 200, 0.05)], { ...base, observerRadiusKm: R + 1 })
    expect(r.azimuths[0].elevationDeg).toBeLessThan(-0.5)
  })

  it('finds a wall at a known distance with the exact spherical elevation, only in its direction', () => {
    // 1 km high wall between 10 and 11 km east of the site
    const wall: HeightSource = { ...flat('w', 0, 200, 0.05), sample: (lat, lon) => {
      const d = angDistKm(0, 0, lat, lon)
      return lon > 0 && Math.abs(lat) < 1 && d >= 10 && d <= 11 ? 1000 : 0
    } }
    const r = castHorizon([wall], base)
    const theta = 10 / R
    const expected = Math.atan2((R + 1) * Math.cos(theta) - R, (R + 1) * Math.sin(theta)) / DEG
    const east = r.azimuths[1]
    expect(east.elevationDeg).toBeCloseTo(expected, 1)
    expect(east.governingKm).toBeCloseTo(10, 1)
    expect(r.azimuths[0].elevationDeg).toBeLessThan(0.01)
    expect(r.azimuths[3].elevationDeg).toBeLessThan(0.01)
  })

  it('crosses the 180 degree meridian and passes over the pole', () => {
    // Site at lon 179.99: a wall just across the seam (lon -179.9) must be seen to the east.
    const seamWall: HeightSource = { ...flat('w', 0, 200, 0.05), sample: (_lat, lon) => (lon < 0 && lon > -179.95 ? 2000 : 0) }
    const r = castHorizon([seamWall], { ...base, lonDeg: 179.99, maxRangeKm: 20 })
    expect(r.azimuths[1].elevationDeg).toBeGreaterThan(5)
    expect(r.azimuths[3].elevationDeg).toBeLessThan(0.01)
    // Near the south pole: a ring 5 km from the pole is seen in every direction from a site 1 km from the pole.
    const ring: HeightSource = { ...flat('r', 0, 200, 0.05), sample: (lat) => { const d = (90 + lat) * DEG * R; return d > 5 && d < 6 ? 500 : 0 } }
    const p = castHorizon([ring], { ...base, latDeg: -90 + 1 / (R * DEG), maxRangeKm: 20 })
    for (const a of p.azimuths) expect(a.elevationDeg).toBeGreaterThan(2)
  })
})

describe('castHorizon coverage, gaps and source seams', () => {
  it('marks a data gap as a lower bound, but skips gaps within the allowed length', () => {
    const holes = (lenKm: number): HeightSource => ({ ...flat('n', 0, 200, 0.002), sample: (lat, lon) => { const d = angDistKm(0, 0, lat, lon); return d > 0.1 && d < 0.1 + lenKm ? null : 0 } })
    const short = castHorizon([holes(0.004)], { ...base, maxRangeKm: 1, maxSkippedGapKm: 0.006 })
    expect(short.azimuths.every((a) => a.status === 'complete')).toBe(true)
    expect(short.azimuths[0].skippedSamples).toBeGreaterThan(0)
    const long = castHorizon([holes(0.05)], { ...base, maxRangeKm: 1, maxSkippedGapKm: 0.006 })
    expect(long.azimuths.every((a) => a.status === 'lower-bound')).toBe(true)
    expect(long.azimuths[0].coveredToKm).toBeLessThan(0.11)
  })

  it('treats the end of all coverage as a lower bound, never as an unobstructed sky', () => {
    const limited: HeightSource = { ...flat('m', 0, 200, 0.05), sample: (lat, lon) => (angDistKm(0, 0, lat, lon) < 30 ? 0 : null) }
    const r = castHorizon([limited], base)
    expect(r.azimuths.every((a) => a.status === 'lower-bound' && a.coveredToKm < 30.1)).toBe(true)
  })

  it('does not let a coarse product with a vertical offset fill near-site gaps (no false ridge)', () => {
    // Near product missing everywhere inside 0.2 km; mid product sits 3.4 m higher (as at Apollo 16).
    const near: HeightSource = { ...flat('near', 0, 1, 0.002), sample: (lat, lon) => (angDistKm(0, 0, lat, lon) < 0.2 ? null : 0) }
    const mid = (fallbackMinKm: number): HeightSource => ({ ...flat('mid', 1, 30, 0.03), sample: () => 3.4, fallbackMinKm })
    const unguarded = castHorizon([near, mid(0)], { ...base, maxRangeKm: 30, maxSkippedGapKm: 0.006 })
    const guarded = castHorizon([near, mid(0.3)], { ...base, maxRangeKm: 30, maxSkippedGapKm: 0.006 })
    expect(unguarded.azimuths[0].elevationDeg).toBeGreaterThan(5) // the artefact: 3.4 m seen 20 m away
    expect(guarded.azimuths[0].elevationDeg).toBeLessThan(1)
    expect(guarded.azimuths[0].status).toBe('lower-bound') // the near gap is reported instead
  })

  it('reports an uncertainty from the governing sample and rejects an azimuth step that does not divide 360', () => {
    const wall: HeightSource = { ...flat('w', 0, 200, 0.05), sigmaM: 3, sample: (lat, lon) => (lon > 0 && angDistKm(0, 0, lat, lon) > 2 && angDistKm(0, 0, lat, lon) < 2.1 ? 200 : 0) }
    const r = castHorizon([wall], base)
    expect(r.azimuths[1].uncertaintyDeg).toBeCloseTo(Math.atan((Math.SQRT2 * 3) / 2000) / DEG, 2)
    expect(() => castHorizon([wall], { ...base, azimuthStepDeg: 7 })).toThrow(/divide 360/)
  })
})
