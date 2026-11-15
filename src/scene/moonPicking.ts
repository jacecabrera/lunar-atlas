// Moon surface coordinates <-> Moon mesh-local <-> scene coordinates (step 17; used by picking in step 19).
//
// Mesh-local axes follow the texture convention of physics/coords.ts: lon 0 / lat 0 = +X, east = -Z, north = +Y.
// The Moon group is placed with sceneState(t).moonPosition and rotated with moonRotation, the same pose the physics
// uses (moonSceneRotation is built from eqjToMoonFixed). Latitude north positive, longitude east positive in
// (-180, 180]; at a pole the longitude is undefined and reported as 0. Displayed decimals are not a positioning
// accuracy: the textured sphere is not a terrain model and its imagery is aesthetic (SVS CGI Moon Kit).
import { latLonToVec3 } from '../physics/coords'
import type { SceneState } from '../sim/scene'

export type Vec3 = [number, number, number]

export function latLonToMoonLocal(latDeg: number, lonDeg: number, radius: number): Vec3 {
  return latLonToVec3(latDeg, lonDeg, radius)
}

export function moonLocalToLatLon(x: number, y: number, z: number): { lat: number; lon: number } {
  const r = Math.hypot(x, y, z)
  if (!(r > 0)) throw new RangeError('Zero vector has no surface coordinate')
  const lat = (Math.asin(Math.max(-1, Math.min(1, y / r))) * 180) / Math.PI
  const h = Math.hypot(x, z)
  if (h <= r * 1e-12) return { lat: y > 0 ? 90 : -90, lon: 0 }
  let lon = (Math.atan2(-z, x) * 180) / Math.PI
  if (lon <= -180) lon += 360
  return { lat, lon }
}

const mulT = (R: number[][], v: Vec3): Vec3 => [
  R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2],
  R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2],
  R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2],
]
const mul = (R: number[][], v: Vec3): Vec3 => [
  R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
  R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
  R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2],
]

/** Mesh-local point -> scene point for the pose of one instant (no parent transform; the Moon group sits in the scene root). */
export function moonLocalToScene(s: Pick<SceneState, 'moonPosition' | 'moonRotation'>, v: Vec3): Vec3 {
  const w = mul(s.moonRotation, v)
  return [w[0] + s.moonPosition[0], w[1] + s.moonPosition[1], w[2] + s.moonPosition[2]]
}

export function sceneToMoonLocal(s: Pick<SceneState, 'moonPosition' | 'moonRotation'>, p: Vec3): Vec3 {
  return mulT(s.moonRotation, [p[0] - s.moonPosition[0], p[1] - s.moonPosition[1], p[2] - s.moonPosition[2]])
}
