// Everything the 3D scene needs for one instant. Visual only: scene sizes and the Sun proxy distance never feed
// back into site calculations.
import { moonPosition, sunDirection } from '../physics/ephemeris'
import { moonSceneRotation } from '../physics/moonFrame'
import { earthSceneRotation } from '../physics/earthFrame'
import type { Mat3, Vec3 } from '../physics/moonFrame'

export { moonPosition, sunDirection }

// Rotations are 3x3 row-major matrices that take mesh-local axes (texture convention: lon 0 = +X, east = -Z,
// north = +Y) to scene axes.
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
