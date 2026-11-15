import { describe, expect, it } from 'vitest'
import { localFrame, siteSky, MOON_R_KM } from './siteSky'
import { moonFixedVectors, toLatLon } from './moonFrame'
import type { Vec3 } from './moonFrame'

const D = new Date('2026-11-13T00:00:00Z')
const close = (a: Vec3, b: Vec3) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 9))

describe('localFrame', () => {
  it('has the right axes at (0, 0)', () => {
    const f = localFrame(0, 0)
    close(f.up, [1, 0, 0])
    close(f.east, [0, 1, 0])
    close(f.north, [0, 0, 1])
  })
  it('has the right axes at (0, 90E)', () => {
    const f = localFrame(0, 90)
    close(f.up, [0, 1, 0])
    close(f.east, [-1, 0, 0])
    close(f.north, [0, 0, 1])
  })
  it('has the right axes at the north pole', () => {
    const f = localFrame(90, 0)
    close(f.up, [0, 0, 1])
    close(f.east, [0, 1, 0])
    close(f.north, [-1, 0, 0])
  })
})

describe('siteSky', () => {
  it('puts Earth and the Sun overhead at their sub-points', () => {
    const { earthKm, sunKm } = moonFixedVectors(D)
    const e = toLatLon(earthKm)
    const s = toLatLon(sunKm)
    expect(siteSky(e.lat, e.lon, D).earth.elevation).toBeCloseTo(90, 6)
    expect(siteSky(s.lat, s.lon, D).sun.elevation).toBeCloseTo(90, 6)
  })

  it('puts Earth straight below at the antipode of the sub-Earth point', () => {
    const e = toLatLon(moonFixedVectors(D).earthKm)
    expect(siteSky(-e.lat, e.lon + 180, D).earth.elevation).toBeCloseTo(-90, 6)
  })

  it('puts Earth just below the horizon at a site 90 degrees from the sub-Earth point', () => {
    const { earthKm } = moonFixedVectors(D)
    const dist = Math.hypot(...earthKm)
    const ex = earthKm[0] / dist
    const ey = earthKm[1] / dist
    const norm = Math.hypot(ex, ey)
    const { lat, lon } = toLatLon([-ey / norm, ex / norm, 0]) // perpendicular to Earth's direction
    const expected = (-Math.atan(MOON_R_KM / dist) * 180) / Math.PI // about -0.26 deg
    expect(siteSky(lat, lon, D).earth.elevation).toBeCloseTo(expected, 6)
  })

  it('has the Sun near the sub-solar latitude (negated) at the south pole', () => {
    const { sunKm, earthKm } = moonFixedVectors(D)
    const sky = siteSky(-90, 0, D)
    expect(Math.abs(sky.sun.elevation - -toLatLon(sunKm).lat)).toBeLessThan(0.002)
    expect(Math.abs(sky.earth.elevation - -toLatLon(earthKm).lat)).toBeLessThan(0.3) // parallax up to 0.26 deg
  })

  it('prints a month at the south pole', () => {
    for (let day = 0; day < 30; day++) {
      const d = new Date(D.getTime() + day * 86_400_000)
      const { sun, earth } = siteSky(-90, 0, d)
      console.log(d.toISOString().slice(0, 10), 'sun', sun.elevation.toFixed(2), 'earth', earth.elevation.toFixed(2))
    }
  })
})