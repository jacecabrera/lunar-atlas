import { moonFixedVectors } from './moonFrame'
import type { Vec3 } from './moonFrame'

export const MOON_R_KM = 1737.4 // IAU radius; matches Horizons' target radius
export const EARTH_R_KM = 6378.137 // equatorial radius, as in Horizons' center radii
export const SUN_R_KM = 695_700 // IAU 2015 Resolution B3 nominal solar radius (see sources.md)

const DEG = Math.PI / 180
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

// Local frame at a site, in the Moon-fixed frame (x = lon 0, y = 90E, z = north)
export function localFrame(latDeg: number, lonDeg: number) {
  const lat = latDeg * DEG
  const lon = lonDeg * DEG
  const up: Vec3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]
  const east: Vec3 = [-Math.sin(lon), Math.cos(lon), 0]
  const north: Vec3 = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)]
  return { up, east, north }
}

export type SkyBody = {
  elevation: number // degrees, of the disc center above the local horizontal plane
  azimuth: number // degrees clockwise from north, 0-360
  angularRadius: number // degrees
  distanceKm: number // from the site
}

function look(site: Vec3, f: ReturnType<typeof localFrame>, target: Vec3, radiusKm: number): SkyBody {
  const d: Vec3 = [target[0] - site[0], target[1] - site[1], target[2] - site[2]]
  const dist = Math.hypot(d[0], d[1], d[2])
  const e = dot(d, f.east)
  const n = dot(d, f.north)
  const u = dot(d, f.up)
  return {
    elevation: Math.atan2(u, Math.hypot(e, n)) / DEG,
    azimuth: (Math.atan2(e, n) / DEG + 360) % 360,
    angularRadius: Math.asin(radiusKm / dist) / DEG,
    distanceKm: dist,
  }
}

// Sun and Earth seen from a site at `radiusKm` from the Moon's centre (default: the 1737.4 km reference sphere).
// Pass the observer radius from the site's terrain record (reference radius + ground elevation + observer height) so
// the sky, the terrain horizon and the geocentric endpoint all use one observer position. Terrain occlusion is applied
// by the callers through a Horizon.
export function siteSky(latDeg: number, lonDeg: number, date: Date, radiusKm: number = MOON_R_KM) {
  const f = localFrame(latDeg, lonDeg)
  const site: Vec3 = [f.up[0] * radiusKm, f.up[1] * radiusKm, f.up[2] * radiusKm]
  const { earthKm, sunKm } = moonFixedVectors(date)
  return {
    sun: look(site, f, sunKm, SUN_R_KM),
    earth: look(site, f, earthKm, EARTH_R_KM),
  }
}

// No atmosphere, so no refraction. Against the flat 0 deg plane: the Sun is up while some of its disc is above it,
// the Earth while its centre is (v0.7; with terrain use bodyMargin in siteTimeline or sim/visibility).
export const sunDiscAboveFlatHorizon = (b: SkyBody) => b.elevation + b.angularRadius > 0
export const earthCentreAboveFlatHorizon = (b: SkyBody) => b.elevation > 0