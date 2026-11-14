import { Body, GeoVector } from 'astronomy-engine'
import { toScene } from './coords'

export const moonPosition = (d: Date) =>
  toScene(GeoVector(Body.Moon, d, true))

export function sunDirection(d: Date): [number, number, number] {
  const [x, y, z] = toScene(GeoVector(Body.Sun, d, true))
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
}