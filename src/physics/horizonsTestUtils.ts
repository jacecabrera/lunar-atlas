// Helpers shared by the Horizons comparison tests (step 06). Test support only; not used by the app.
import { BaryState, Body, GeoMoonState, KM_PER_AU } from 'astronomy-engine'
import type { Mat3, Vec3 } from './moonFrame'

export const DEG = Math.PI / 180
export const C_KM_S = 299_792.458
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
export const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
export const unit = (a: Vec3): Vec3 => scale(a, 1 / norm(a))
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
/** Angle between vectors, stable near 0 and 180 degrees. */
export const angleDeg = (a: Vec3, b: Vec3) => Math.atan2(norm(cross(a, b)), dot(a, b)) / DEG
export const fromLatLon = (latDeg: number, lonDeg: number): Vec3 =>
  [Math.cos(latDeg * DEG) * Math.cos(lonDeg * DEG), Math.cos(latDeg * DEG) * Math.sin(lonDeg * DEG), Math.sin(latDeg * DEG)]
export const km = (v: { x: number; y: number; z: number }): Vec3 => [v.x * KM_PER_AU, v.y * KM_PER_AU, v.z * KM_PER_AU]
/** East/north/up unit vector from azimuth (clockwise from north) and elevation. */
export const enu = (azDeg: number, elDeg: number): Vec3 =>
  [Math.cos(elDeg * DEG) * Math.sin(azDeg * DEG), Math.cos(elDeg * DEG) * Math.cos(azDeg * DEG), Math.sin(elDeg * DEG)]
export const cells = (line: string) => line.split(',').map((s) => s.trim())
export const jdToMs = (jd: number) => Math.round((jd - 2440587.5) * 86_400_000)
export const max = (xs: number[]) => Math.max(...xs)

const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' }
/** "2026-Nov-14 00:00:00.000" or "2026-Nov-15 02:00" (UTC) -> ms */
export function parseCal(s: string): number {
  const m = s.trim().match(/^(\d{4})-(\w{3})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/)
  if (!m) throw new Error(`bad Horizons date ${s}`)
  return Date.parse(`${m[1]}-${MONTHS[m[2]]}-${m[3]}T${m[4]}:${m[5]}:${(m[6] ?? '00').padStart(2, '0')}Z`)
}

/** TRIAD: rotation R with R a1 = b1 and R a2 close to b2. */
export function triad(a1: Vec3, a2: Vec3, b1: Vec3, b2: Vec3): Mat3 {
  const basis = (u: Vec3, v: Vec3): Mat3 => { const t2 = unit(cross(u, v)); return [u, t2, cross(u, t2)] }
  const A = basis(a1, a2), B = basis(b1, b2)
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => B[0][i] * A[0][j] + B[1][i] * A[1][j] + B[2][i] * A[2][j])) as Mat3
}
export const rotationAngleDeg = (R: Mat3) => Math.acos(Math.min(1, Math.max(-1, (R[0][0] + R[1][1] + R[2][2] - 1) / 2))) / DEG

/** Earth's barycentric velocity and the Moon's geocentric velocity, km/s (library values, for small light-time terms). */
export function velocitiesKmS(t: Date): { earthBary: Vec3; moonGeo: Vec3 } {
  const e = BaryState(Body.Earth, t)
  const m = GeoMoonState(t)
  const k = KM_PER_AU / 86_400
  return { earthBary: [e.vx * k, e.vy * k, e.vz * k], moonGeo: [m.vx * k, m.vy * k, m.vz * k] }
}
