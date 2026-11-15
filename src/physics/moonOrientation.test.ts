import { describe, expect, it } from 'vitest'
import { Body, GeoVector } from 'astronomy-engine'
import { toScene, latLonToVec3 } from './coords'
import { apply, moonFixedVectors, moonSceneRotation, toLatLon } from './moonFrame'
import type { Vec3 } from './moonFrame'

const angleDeg = (a: Vec3, b: Vec3) => {
  const cx = a[1] * b[2] - a[2] * b[1]
  const cy = a[2] * b[0] - a[0] * b[2]
  const cz = a[0] * b[1] - a[1] * b[0]
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  return (Math.atan2(Math.hypot(cx, cy, cz), d) * 180) / Math.PI
}

describe('moonSceneRotation', () => {
  it('sends the sub-Earth surface point toward Earth in scene axes', () => {
    for (const iso of ['2026-11-13T00:00:00Z', '2026-12-01T06:00:00Z', '2027-03-20T18:00:00Z']) {
      const d = new Date(iso)
      const moon = GeoVector(Body.Moon, d, false)
      const earthScene = toScene({ x: -moon.x, y: -moon.y, z: -moon.z }, 1)
      const { lat, lon } = toLatLon(moonFixedVectors(d).earthKm)
      const predicted = apply(moonSceneRotation(d), latLonToVec3(lat, lon, 1))
      expect(angleDeg(predicted, earthScene)).toBeLessThan(0.001)
    }
  })
})