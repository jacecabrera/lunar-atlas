// Everything the 3D scene needs for one instant. Visual only: scene units, radii and camera settings never feed back
// into site calculations (the calculation modules do not import from the scene).
import { moonPosition, sunDirection, sunPosition } from '../physics/ephemeris'
import { moonSceneRotation } from '../physics/moonFrame'
import { earthSceneRotation } from '../physics/earthFrame'
import { EARTH_R_KM, MOON_R_KM, SUN_R_KM } from '../physics/siteSky'
import { UNIT_KM } from '../physics/coords'
import type { Mat3, Vec3 } from '../physics/moonFrame'

export { moonPosition, sunDirection, sunPosition }

/**
 * True radii in scene units (1 unit = 1000 km), from the constants the calculations use (IAU Moon 1737.4 km, Earth
 * equatorial 6378.137 km, IAU 2015 nominal Sun 695,700 km). Step 17 removed the former 10x enlargement.
 */
export const SCENE_RADII = { moon: MOON_R_KM / UNIT_KM, earth: EARTH_R_KM / UNIT_KM, sun: SUN_R_KM / UNIT_KM } as const

// Rotations are 3x3 row-major matrices that take mesh-local axes (texture convention: lon 0 = +X, east = -Z,
// north = +Y) to scene axes.
export type SceneState = {
  /** Geocentric geometric Moon centre, scene units. */
  moonPosition: Vec3
  moonRotation: Mat3
  earthRotation: Mat3
  /** Unit vector from the Earth toward the (apparent) Sun. */
  sunDirection: Vec3
  /** Apparent geocentric Sun position, scene units (about 149,600 units). */
  sunPosition: Vec3
}

export function sceneState(date: Date): SceneState {
  return {
    moonPosition: moonPosition(date),
    moonRotation: moonSceneRotation(date),
    earthRotation: earthSceneRotation(date),
    sunDirection: sunDirection(date),
    sunPosition: sunPosition(date),
  }
}
