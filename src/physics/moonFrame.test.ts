import { describe, expect, it } from 'vitest'
import { Body, RotationAxis, SearchMoonQuarter, NextMoonQuarter } from 'astronomy-engine'
import { apply, eqjToMoonFixed, moonFixedVectors, toLatLon } from './moonFrame'
import type { Vec3 } from './moonFrame'

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const angleDeg = (a: Vec3, b: Vec3) =>
  (Math.acos(dot(a, b) / Math.hypot(...a) / Math.hypot(...b)) * 180) / Math.PI
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180

function quarters(n: number) {
  const out = []
  let q = SearchMoonQuarter(new Date('2026-11-01T00:00:00Z'))
  for (let i = 0; i < n; i++) {
    out.push(q)
    q = NextMoonQuarter(q)
  }
  return out
}

describe('Moon-fixed frame', () => {
  it('maps the IAU north pole to +Z', () => {
    const d = new Date('2026-11-13T00:00:00Z')
    const n = RotationAxis(Body.Moon, d).north
    const v = apply(eqjToMoonFixed(d), [n.x, n.y, n.z])
    expect(v[2]).toBeCloseTo(1, 9)
  })

  it('keeps the sub-Earth point near (0, 0), within libration limits', () => {
    for (const q of quarters(8)) {
      const { lat, lon } = toLatLon(moonFixedVectors(q.time.date).earthKm)
      expect(Math.abs(lat)).toBeLessThan(10)
      expect(Math.abs(lon)).toBeLessThan(10)
    }
  })

  it('puts the Sun where each phase says it should be', () => {
    for (const q of quarters(8)) {
      const { earthKm, sunKm } = moonFixedVectors(q.time.date)
      const sunLon = toLatLon(sunKm).lon
      if (q.quarter === 0) expect(angleDeg(sunKm, earthKm)).toBeGreaterThan(170) // new
      if (q.quarter === 2) expect(angleDeg(sunKm, earthKm)).toBeLessThan(10)     // full
      if (q.quarter === 1) expect(Math.abs(wrap(sunLon - 90))).toBeLessThan(15)  // first quarter: +90 E
      if (q.quarter === 3) expect(Math.abs(wrap(sunLon + 90))).toBeLessThan(15)  // last quarter: -90 (90 W)
    }
  })

  it('prints values for manual comparison with Horizons', () => {
    const d = new Date('2026-11-13T00:00:00Z')
    const { earthKm, sunKm } = moonFixedVectors(d)
    console.log('sub-Earth', toLatLon(earthKm), 'sub-solar', toLatLon(sunKm))
  })
})