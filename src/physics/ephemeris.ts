// Installs the leap-second Delta T in Astronomy Engine before any call (see timeScale.ts).
import './timeScale'
import { Body, GeoVector } from 'astronomy-engine'
import { toScene } from './coords'

// Scene use only. The Moon branch of GeoVector returns the geometric GeoMoon() and ignores the aberration flag, so the
// flag is passed as false to say what actually happens (before step 06 it was `true`, with identical results).
export const moonPosition = (d: Date) =>
  toScene(GeoVector(Body.Moon, d, false))

// Scene lighting only: apparent direction of the Sun from the Earth's centre (aberration included). Site calculations
// use geometric vectors from moonFrame.moonFixedVectors(); the two differ by up to ~20 arcsec, invisible in the scene.
export function sunDirection(d: Date): [number, number, number] {
  const [x, y, z] = toScene(GeoVector(Body.Sun, d, true))
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
}