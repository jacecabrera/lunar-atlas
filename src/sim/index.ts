// Public API of the simulation layer. UI code should import from here, not from src/physics/*.
//
// Conventions
//   Time       milliseconds since the Unix epoch, UTC (same as Date.getTime())
//   Latitude   degrees, north positive, -90..90
//   Longitude  degrees, EAST positive, any range (use -180..180 for display)
//   Azimuth    degrees clockwise from local north, 0..360
//   Elevation  degrees above the local horizontal plane (negative = below)
//   Distance   kilometres, unless noted
//   Scene      1 unit = 1000 km, Earth at the origin, Y up (celestial north), Moon follows the real orbit
import { moonPosition, sunDirection } from '../physics/ephemeris'
import { moonSceneRotation } from '../physics/moonFrame'
import { earthSceneRotation } from '../physics/earthFrame'
import { horizonFromProfile, flatHorizon } from '../physics/horizon'
import type { Horizon } from '../physics/horizon'
import { latLonToVec3 } from '../physics/coords'
import type { Mat3, Vec3 } from '../physics/moonFrame'

export type { Mat3, Vec3, Horizon }
export { horizonFromProfile, flatHorizon, latLonToVec3 }

// Everything the 3D scene needs for one instant. Rotations are 3x3 row-major matrices that take
// mesh-local axes (texture convention: lon 0 = +X, east = -Z, north = +Y) to scene axes.
export type SceneState = {
  moonPosition: Vec3
  moonRotation: Mat3
  earthRotation: Mat3
  sunDirection: Vec3 // unit vector from Earth toward the Sun
}

export function sceneState(date: Date): SceneState {
  return {
    moonPosition: moonPosition(date),
    moonRotation: moonSceneRotation(date),
    earthRotation: earthSceneRotation(date),
    sunDirection: sunDirection(date),
  }
}
