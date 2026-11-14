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
import { siteSky } from '../physics/siteSky'
import type { SkyBody } from '../physics/siteSky'
import { upIntervals, findEvents, statusAt, DAY_MS, MINUTE } from '../physics/siteTimeline'
import type { Interval, SkyEvent, Target, VisibilityOptions } from '../physics/siteTimeline'
import { horizonFromProfile, flatHorizon } from '../physics/horizon'
import type { Horizon } from '../physics/horizon'
import { latLonToVec3 } from '../physics/coords'
import type { Mat3, Vec3 } from '../physics/moonFrame'

export type { Mat3, Vec3, SkyBody, Interval, SkyEvent, Target, VisibilityOptions, Horizon }
export { findEvents, horizonFromProfile, flatHorizon, latLonToVec3, DAY_MS, MINUTE }

export type Site = { name?: string; lat: number; lon: number; horizon?: Horizon }

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

export type SkyState = { sun: SkyBody; earth: SkyBody; sunUp: boolean; earthUp: boolean }

// Where the Sun and Earth are at a site, and whether each is up (any part of the disc above the mask).
export function skyAt(site: Site, date: Date, opts: VisibilityOptions = {}): SkyState {
  const { sun, earth } = siteSky(site.lat, site.lon, date)
  const horizon = opts.horizon ?? site.horizon
  const up = (b: SkyBody) =>
    b.elevation + b.angularRadius - Math.max(opts.maskDeg ?? 0, horizon ? horizon(b.azimuth) : -Infinity) > 0
  return { sun, earth, sunUp: up(sun), earthUp: up(earth) }
}

export function windows(
  site: Site, target: Target, startMs: number, endMs: number,
  opts: VisibilityOptions & { stepMs?: number } = {},
): Interval[] {
  const { stepMs, ...vis } = opts
  return upIntervals(site.lat, site.lon, target, startMs, endMs, stepMs, { horizon: site.horizon, ...vis })
}

export function nextEvent(site: Site, target: Target, tMs: number, opts: VisibilityOptions = {}) {
  return statusAt(site.lat, site.lon, target, tMs, undefined, { horizon: site.horizon, ...opts })
}
