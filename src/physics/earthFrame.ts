import { SiderealTime } from 'astronomy-engine'
import { mul } from './moonFrame'
import type { Mat3 } from './moonFrame'

const DEG = Math.PI / 180

// EQJ -> scene axes: (x, y, z) -> (x, z, -y), same mapping as toScene()
const P: Mat3 = [[1, 0, 0], [0, 0, 1], [0, -1, 0]]
const PT: Mat3 = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]

// Active rotation about +Z (celestial pole) by theta
const rotZActive = (a: number): Mat3 => {
  const c = Math.cos(a), s = Math.sin(a)
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]]
}

// Earth mesh orientation (visual use): mesh-local axes -> scene axes.
// Mesh-local axes follow the same texture convention as the Moon: lon 0 = +X, east = -Z, north = +Y.
// Uses Greenwich apparent sidereal time. Precession since J2000 (~0.3 deg) is ignored.
export function earthSceneRotation(date: Date): Mat3 {
  const gast = SiderealTime(date) * 15 * DEG // hours -> radians
  return mul(P, mul(rotZActive(gast), PT))
}
