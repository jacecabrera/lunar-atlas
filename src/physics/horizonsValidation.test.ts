import { describe, expect, it } from 'vitest'
import { moonFixedVectors, toLatLon } from './moonFrame'

// JPL Horizons, target Moon (301), geocentric, DE441, Moon frame MOON_ME, retrieved 2026-11-13.
// Columns: ObsSub-LON, ObsSub-LAT (sub-Earth), SunSub-LON, SunSub-LAT (sub-solar), degrees, east positive.
// Horizons applies light-time and aberration; we use geometric vectors, so about 20 arcsec is expected.
const HORIZONS: [string, number, number, number, number][] = [
  ['2026-11-13T00:00:00Z', 0.129851, 5.312565, 138.80906, -1.556378],
  ['2026-11-13T06:00:00Z', 359.798767, 5.104871, 135.76076, -1.556724],
  ['2026-11-13T12:00:00Z', 359.46224, 4.883706, 132.712752, -1.556987],
  ['2026-11-13T18:00:00Z', 359.121154, 4.649652, 129.665047, -1.55717],
  ['2026-11-14T00:00:00Z', 358.77646, 4.4033, 126.617658, -1.557279],
]

const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180
const TOL_DEG = 0.006 // measured worst case is 0.0051

describe('Moon orientation vs JPL Horizons', () => {
  it.each(HORIZONS)('matches sub-Earth and sub-solar points at %s', (iso, eLon, eLat, sLon, sLat) => {
    const { earthKm, sunKm } = moonFixedVectors(new Date(iso))
    const e = toLatLon(earthKm)
    const s = toLatLon(sunKm)
    expect(Math.abs(wrap(e.lon - eLon))).toBeLessThan(TOL_DEG)
    expect(Math.abs(e.lat - eLat)).toBeLessThan(TOL_DEG)
    expect(Math.abs(wrap(s.lon - sLon))).toBeLessThan(TOL_DEG)
    expect(Math.abs(s.lat - sLat)).toBeLessThan(TOL_DEG)
  })
})
