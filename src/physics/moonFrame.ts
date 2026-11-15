// Installs the leap-second Delta T in Astronomy Engine before any call (see timeScale.ts).
import './timeScale'
import { Body, GeoVector, RotationAxis, KM_PER_AU } from 'astronomy-engine'

export type Vec3 = [number, number, number]
export type Mat3 = [Vec3, Vec3, Vec3]

const DEG = Math.PI / 180

// Frame (passive) rotations, same convention as NAIF's [theta]1 and [theta]3
const rotX = (a: number): Mat3 => {
  const c = Math.cos(a), s = Math.sin(a)
  return [[1, 0, 0], [0, c, s], [0, -s, c]]
}
const rotZ = (a: number): Mat3 => {
  const c = Math.cos(a), s = Math.sin(a)
  return [[c, s, 0], [-s, c, 0], [0, 0, 1]]
}

export const mul = (a: Mat3, b: Mat3): Mat3 =>
  a.map((row) =>
    [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j])
  ) as Mat3

export const apply = (m: Mat3, v: Vec3): Vec3 => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
]

// Rotation taking an equatorial-J2000 (EQJ) vector into the Moon-fixed frame:
// +X = lon 0 / lat 0, +Y = 90 deg east, +Z = north pole.
// IAU convention: M = Rz(W) * Rx(90deg - dec) * Rz(90deg + ra)
export function eqjToMoonFixed(date: Date): Mat3 {
  const ax = RotationAxis(Body.Moon, date)
  const alpha = ax.ra * 15 * DEG // ra is in sidereal hours
  const delta = ax.dec * DEG
  const w = ax.spin * DEG
  return mul(rotZ(w), mul(rotX(Math.PI / 2 - delta), rotZ(Math.PI / 2 + alpha)))
}

// Vectors from the Moon's center to Earth and Sun, in km, Moon-fixed frame (IAU orientation, see eqjToMoonFixed).
// Both are GEOMETRIC positions at the same instant: no light-time and no aberration.
// - Astronomy Engine's GeoVector(Body.Moon, ...) returns GeoMoon() for the Moon and ignores both corrections.
// - GeoVector(Body.Sun, date, false) works in heliocentric coordinates: the Earth is taken at `date` and the Sun is
//   the origin, so the light-time loop changes nothing and the result is the geometric Earth -> Sun vector.
// Apparent directions seen from the Moon differ by up to about 20 arcsec (aberration from the Moon's ~30 km/s
// heliocentric velocity), which step 06 accepts within the 0.01 degree direction budget.
export function moonFixedVectors(date: Date) {
  const M = eqjToMoonFixed(date)
  const moon = GeoVector(Body.Moon, date, false)
  const sun = GeoVector(Body.Sun, date, false)
  const km = (x: number, y: number, z: number): Vec3 =>
    apply(M, [x * KM_PER_AU, y * KM_PER_AU, z * KM_PER_AU])
  return {
    earthKm: km(-moon.x, -moon.y, -moon.z),
    sunKm: km(sun.x - moon.x, sun.y - moon.y, sun.z - moon.z),
  }
}

// Moon-fixed vector -> selenographic lat/lon in degrees (east-positive)
export function toLatLon(v: Vec3): { lat: number; lon: number } {
  const r = Math.hypot(v[0], v[1], v[2])
  return { lat: Math.asin(v[2] / r) / DEG, lon: Math.atan2(v[1], v[0]) / DEG }
}

// EQJ -> scene axes: (x, y, z) -> (x, z, -y), same mapping as toScene()
const P: Mat3 = [[1, 0, 0], [0, 0, 1], [0, -1, 0]]

export const transpose = (m: Mat3): Mat3 => [
  [m[0][0], m[1][0], m[2][0]],
  [m[0][1], m[1][1], m[2][1]],
  [m[0][2], m[1][2], m[2][2]],
]

// Rotation for the Moon mesh: mesh-local axes -> scene axes.
// Mesh-local axes (lon 0 = +X, east = -Z, north = +Y) are the Moon-fixed axes
// pushed through P, so the rotation is P * M^T * P^T.
export function moonSceneRotation(date: Date): Mat3 {
  const M = eqjToMoonFixed(date)
  return mul(P, mul(transpose(M), transpose(P)))
}

/**
 * Geocentric position of a point on the Moon in EQJ, km, at the given instant: geometric Moon centre (GeoMoon) plus
 * the site vector rotated out of the Moon-fixed frame. Latitude and longitude are planetocentric on a sphere, east
 * positive. They are used in the IAU orientation frame of eqjToMoonFixed; coordinates given in the DE421 mean
 * Earth/polar axis frame are used as-is (step 06 measured the difference, see docs/step-06-frames-and-ephemeris.md).
 */
export function moonSitePositionEqjKm(latDeg: number, lonDeg: number, radiusKm: number, date: Date): Vec3 {
  const lat = latDeg * DEG
  const lon = lonDeg * DEG
  const site = apply(transpose(eqjToMoonFixed(date)), [
    radiusKm * Math.cos(lat) * Math.cos(lon), radiusKm * Math.cos(lat) * Math.sin(lon), radiusKm * Math.sin(lat),
  ])
  const m = GeoVector(Body.Moon, date, false)
  return [m.x * KM_PER_AU + site[0], m.y * KM_PER_AU + site[1], m.z * KM_PER_AU + site[2]]
}

