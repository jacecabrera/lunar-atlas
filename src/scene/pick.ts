import type { Mesh, Object3D, Raycaster } from 'three'
import { moonLocalToLatLon } from './moonPicking'

/**
 * Surface coordinate of the Moon under a ray, or null. The bodies' world matrices are brought up to date first, so the
 * pose is the one that will be drawn this frame (no second ephemeris evaluation at another time). Only a hit whose
 * nearest object is the Moon counts: a ray that meets the Earth or the Sun first does not pick the Moon behind it.
 * The hit point is taken into the Moon mesh's local axes with worldToLocal (parent translation, rotation and scale
 * included) and converted with the project convention (lat N+, lon E+ in (-180, 180], lon 0 at the poles).
 */
export function pickMoon(raycaster: Raycaster, bodies: Object3D[], moon: Mesh): { lat: number; lon: number } | null {
  for (const b of bodies) b.updateWorldMatrix(true, false)
  const hits = raycaster.intersectObjects(bodies, false)
  if (hits.length === 0 || hits[0].object !== moon) return null
  const p = moon.worldToLocal(hits[0].point.clone())
  return moonLocalToLatLon(p.x, p.y, p.z)
}
