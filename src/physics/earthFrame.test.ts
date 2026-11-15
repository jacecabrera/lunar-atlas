import { describe, expect, it } from 'vitest'
import { Body, GeoVector } from 'astronomy-engine'
import { toScene } from './coords'
import { earthSceneRotation } from './earthFrame'
import { apply } from './moonFrame'
import type { Mat3, Vec3 } from './moonFrame'

const transpose = (m: Mat3): Mat3 => [
  [m[0][0], m[1][0], m[2][0]],
  [m[0][1], m[1][1], m[2][1]],
  [m[0][2], m[1][2], m[2][2]],
]

// Sub-solar point on Earth: sun direction (scene axes) expressed in mesh-local axes, then lat/lon
// using the texture convention (lon 0 = +X, east = -Z, north = +Y).
function subSolar(date: Date) {
  const s = GeoVector(Body.Sun, date, false)
  const scene = toScene(s, 1)
  const local = apply(transpose(earthSceneRotation(date)), scene as Vec3)
  const r = Math.hypot(...local)
  return {
    lat: (Math.asin(local[1] / r) * 180) / Math.PI,
    lon: (Math.atan2(-local[2], local[0]) * 180) / Math.PI,
  }
}
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180

describe('earthSceneRotation', () => {
  it('has the Sun near longitude 0 at 12:00 UTC (equation of time is at most ~4 deg)', () => {
    for (const iso of ['2026-03-20T12:00:00Z', '2026-06-21T12:00:00Z', '2026-09-23T12:00:00Z', '2026-12-21T12:00:00Z']) {
      expect(Math.abs(wrap(subSolar(new Date(iso)).lon))).toBeLessThan(5)
    }
  })
  it('has the Sun over 90 degrees west at 18:00 UTC and 90 degrees east at 06:00 UTC', () => {
    expect(Math.abs(wrap(subSolar(new Date('2026-09-23T18:00:00Z')).lon + 90))).toBeLessThan(5)
    expect(Math.abs(wrap(subSolar(new Date('2026-09-23T06:00:00Z')).lon - 90))).toBeLessThan(5)
  })
  it('has the right solar declination at the solstices and equinox', () => {
    expect(subSolar(new Date('2026-06-21T12:00:00Z')).lat).toBeCloseTo(23.4, 0)
    expect(subSolar(new Date('2026-12-21T12:00:00Z')).lat).toBeCloseTo(-23.4, 0)
    expect(Math.abs(subSolar(new Date('2026-03-20T15:00:00Z')).lat)).toBeLessThan(0.5)
  })
})
