import { describe, expect, it } from 'vitest'
import { earthSiteGeocentric, moonSiteGeocentric, separationKm, DEFAULT_LAUNCH_HEIGHT_M } from './frames'
import type { GeocentricPosition } from './frames'
import { earthFixedToEqj, earthSceneRotation } from '../physics/earthFrame'
import { eqjToMoonFixed, moonSceneRotation, mul, transpose, apply } from '../physics/moonFrame'
import type { Mat3, Vec3 } from '../physics/moonFrame'
import { latLonToVec3 } from '../physics/coords'
import { taiMinusUtcSeconds, ttMinusUtcSeconds } from '../physics/timeScale'
import { CURRENT_MODEL_VERSIONS, CONTRACT_VERSION } from './task'

const DATES = ['2016-11-14T00:00:00Z', '2026-11-14T07:30:00Z', '2036-11-14T00:00:00Z'].map((s) => new Date(s))
const det = (R: Mat3) =>
  R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0])
const norm = (v: Vec3) => Math.hypot(v[0], v[1], v[2])
const angleDeg = (a: Vec3, b: Vec3) => {
  const c: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  return (Math.atan2(norm(c), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * 180) / Math.PI
}

describe('rotation matrices are proper rotations', () => {
  it('Earth-fixed -> EQJ and EQJ -> Moon-fixed are orthonormal, right-handed and invertible by transpose', () => {
    for (const d of DATES) {
      for (const R of [earthFixedToEqj(d), eqjToMoonFixed(d), earthSceneRotation(d), moonSceneRotation(d)]) {
        expect(det(R)).toBeCloseTo(1, 12)
        const I = mul(R, transpose(R))
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(I[i][j]).toBeCloseTo(i === j ? 1 : 0, 12)
      }
    }
  })
  it('keeps the Earth pole within a degree of the J2000 pole over the +/- 10 year span (precession)', () => {
    for (const d of DATES) {
      const pole = apply(earthFixedToEqj(d), [0, 0, 1])
      expect(angleDeg(pole, [0, 0, 1])).toBeLessThan(1)
    }
  })
})

describe('earthSiteGeocentric', () => {
  const t = Date.UTC(2026, 10, 14)
  it('uses geodetic latitude on the ellipsoid and height above it', () => {
    expect(norm(earthSiteGeocentric({ lat: 0, lon: 0 }, t).positionKm)).toBeCloseTo(6378.1366, 3)
    expect(norm(earthSiteGeocentric({ lat: 90, lon: 0 }, t).positionKm)).toBeCloseTo(6356.752, 2)
    expect(norm(earthSiteGeocentric({ lat: 0, lon: 0, heightM: 1000 }, t).positionKm)).toBeCloseTo(6379.1366, 3)
    expect(DEFAULT_LAUNCH_HEIGHT_M).toBe(0)
  })
  it('labels the frame, correction, unit and instant', () => {
    const p = earthSiteGeocentric({ lat: 28.5, lon: -80.6 }, t)
    expect(p).toMatchObject({ frame: 'EQJ', origin: 'geocenter', correction: 'geometric', unit: 'km', utcMs: t })
  })
  it('lines up with the textured Earth mesh (scene and physics share one rotation)', () => {
    for (const d of DATES) {
      for (const [lat, lon] of [[0, 0], [45.9, 63.3], [-33.9, 151.2], [64, -21.9]]) {
        const p = earthSiteGeocentric({ lat, lon }, d.getTime()).positionKm
        // The mesh is a sphere, so compare with the geocentric latitude of the geodetic point, from the ellipsoid
        // relation tan(geocentric) = (b/a)^2 tan(geodetic) (b/a = 0.996647180302104 in Astronomy Engine).
        const geocentricLat = (Math.atan(0.996647180302104 ** 2 * Math.tan((lat * Math.PI) / 180)) * 180) / Math.PI
        const sceneFromPhysics: Vec3 = [p[0], p[2], -p[1]]
        const sceneFromMesh = apply(earthSceneRotation(d), latLonToVec3(geocentricLat, lon))
        expect(angleDeg(sceneFromPhysics, sceneFromMesh)).toBeLessThan(1e-6)
      }
    }
  })
  it('rejects invalid input instead of returning a number', () => {
    expect(() => earthSiteGeocentric({ lat: Number.NaN, lon: 0 }, t)).toThrow(RangeError)
    expect(() => earthSiteGeocentric({ lat: 91, lon: 0 }, t)).toThrow(RangeError)
    expect(() => earthSiteGeocentric({ lat: 0, lon: 181 }, t)).toThrow(RangeError)
    expect(() => earthSiteGeocentric({ lat: 0, lon: 0, heightM: Infinity }, t)).toThrow(RangeError)
    expect(() => earthSiteGeocentric({ lat: 0, lon: 0 }, Number.NaN)).toThrow(RangeError)
    expect(() => earthSiteGeocentric({ lat: 0, lon: 0 }, 9e15)).toThrow(RangeError)
  })
})

describe('moonSiteGeocentric', () => {
  const t = Date.UTC(2026, 10, 14)
  it('puts the site on the sphere around the Moon centre, wrapping longitude', () => {
    const centre = moonSiteGeocentric({ lat: 0, lon: 0, radiusKm: 1e-9 }, t).positionKm
    const p = moonSiteGeocentric({ lat: 10, lon: 20 }, t).positionKm
    expect(norm([p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]])).toBeCloseTo(1737.4, 6)
    const a = moonSiteGeocentric({ lat: 5, lon: 180 }, t).positionKm
    const b = moonSiteGeocentric({ lat: 5, lon: -180 }, t).positionKm
    const c = moonSiteGeocentric({ lat: 5, lon: 540 }, t).positionKm
    for (const q of [b, c]) expect(norm([a[0] - q[0], a[1] - q[1], a[2] - q[2]])).toBeLessThan(1e-6)
  })
  it('the near side faces the Earth', () => {
    const near = norm(moonSiteGeocentric({ lat: 0, lon: 0 }, t).positionKm)
    const far = norm(moonSiteGeocentric({ lat: 0, lon: 180 }, t).positionKm)
    expect(far - near).toBeGreaterThan(3400)
    expect(far - near).toBeLessThan(3475)
  })
  it('rejects invalid input', () => {
    expect(() => moonSiteGeocentric({ lat: -91, lon: 0 }, t)).toThrow(RangeError)
    expect(() => moonSiteGeocentric({ lat: 0, lon: Number.NaN }, t)).toThrow(RangeError)
    expect(() => moonSiteGeocentric({ lat: 0, lon: 0, radiusKm: 0 }, t)).toThrow(RangeError)
  })
})

describe('transit endpoints (interface for step 14; no iteration here)', () => {
  it('measures the endpoint distance in one frame; launch site changes it, the lunar point does not depend on it', () => {
    const landing = Date.UTC(2026, 10, 14)
    const launch = landing - 3 * 86_400_000
    const moon = moonSiteGeocentric({ lat: 0.67416, lon: 23.47314 }, landing)
    const d1 = separationKm(earthSiteGeocentric({ lat: 28.5, lon: -80.6 }, launch), moon)
    const d2 = separationKm(earthSiteGeocentric({ lat: -33.9, lon: 151.2 }, launch), moon)
    expect(d1).toBeGreaterThan(350_000)
    expect(d1).toBeLessThan(410_000)
    expect(Math.abs(d1 - d2)).toBeGreaterThan(1)
    expect(moonSiteGeocentric({ lat: 0.67416, lon: 23.47314 }, landing)).toEqual(moon)
  })
  it('refuses to mix frames', () => {
    const a = earthSiteGeocentric({ lat: 0, lon: 0 }, 0)
    const b = { ...a, frame: 'ICRF' } as unknown as GeocentricPosition
    expect(() => separationKm(a, b)).toThrow(/different frames/)
  })
})

describe('time scale', () => {
  it('follows the IERS TAI - UTC table, with the 2017 step and no value before 1972', () => {
    expect(taiMinusUtcSeconds(Date.UTC(1971, 11, 31))).toBeNull()
    expect(taiMinusUtcSeconds(Date.UTC(1972, 0, 1))).toBe(10)
    expect(ttMinusUtcSeconds(Date.UTC(2016, 11, 31, 23, 59, 59))).toBeCloseTo(68.184, 9)
    expect(ttMinusUtcSeconds(Date.UTC(2017, 0, 1))).toBeCloseTo(69.184, 9)
    expect(ttMinusUtcSeconds(Date.UTC(2036, 0, 1))).toBeCloseTo(69.184, 9) // assumes no new leap second
    expect(Number.isFinite(ttMinusUtcSeconds(Date.UTC(1960, 0, 1)))).toBe(true) // polynomial fallback
  })
})

describe('result identity', () => {
  it('records the ephemeris and time-scale model so results computed before step 06 do not match', () => {
    expect(CONTRACT_VERSION).toBe(2)
    expect(CURRENT_MODEL_VERSIONS.models.ephemeris).toMatch(/tai-utc/)
    expect(CURRENT_MODEL_VERSIONS.models.ephemeris).toMatch(/iau/)
  })
})
