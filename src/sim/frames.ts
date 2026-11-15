// Physical endpoints for the simplified transit estimate (step 14) and for scene markers.
//
// Both endpoints are expressed in the same frame: geocentric, non-rotating, axes of EQJ (J2000 mean equator and
// equinox; Astronomy Engine applies no ICRS frame bias, ~0.02 arcsec), positions in km, GEOMETRIC (no light-time, no
// aberration). Each is evaluated at its own instant: the launch point at the launch time, the lunar point at the
// landing time. The origin is the Earth's centre at each instant; this is the "geocentric inertial frame" of the
// requirements. No orbit, gravity or launch window is modelled here.
//
// Accuracy measured against JPL Horizons in step 06 (docs/step-06-frames-and-ephemeris.md): Earth sites within
// 0.16 km over 2016-2036; Moon centre within 13.6 km; lunar orientation within 31 arcsec of DE421 mean Earth.
import { earthSitePositionEqjKm } from '../physics/earthFrame'
import { moonSitePositionEqjKm } from '../physics/moonFrame'
import { MOON_R_KM } from '../physics/siteSky'
import type { Vec3 } from '../physics/moonFrame'
import { MAX_DATE_MS } from './units'

export type GeocentricPosition = {
  frame: 'EQJ'
  origin: 'geocenter'
  correction: 'geometric'
  unit: 'km'
  /** The instant the position applies to, UTC ms. */
  utcMs: number
  positionKm: Vec3
}

/**
 * Launch height used when none is given: 0 m above the reference ellipsoid. A project assumption
 * (ASM-LAUNCH-HEIGHT), not the elevation of a real launch site; height is not a main input.
 */
export const DEFAULT_LAUNCH_HEIGHT_M = 0

export type EarthSite = {
  /** Geodetic latitude, degrees, north positive. */
  lat: number
  /** Degrees, east positive, -180..180. */
  lon: number
  /** Height above the reference ellipsoid, metres. Defaults to DEFAULT_LAUNCH_HEIGHT_M. */
  heightM?: number
}

export type MoonSite = {
  /** Planetocentric latitude, degrees. */
  lat: number
  /** Degrees, east positive (any finite value; wraps). */
  lon: number
  /** Distance from the Moon's centre, km. Defaults to the 1737.4 km reference sphere until step 07 adds elevation. */
  radiusKm?: number
}

function checkTime(utcMs: number) {
  if (!Number.isFinite(utcMs) || Math.abs(utcMs) > MAX_DATE_MS) throw new RangeError(`invalid UTC time: ${utcMs}`)
}
function checkLat(lat: number) {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new RangeError(`invalid latitude: ${lat}`)
}

/** Geocentric EQJ position of a point on the Earth (geodetic latitude, ellipsoid height) at a UTC instant. */
export function earthSiteGeocentric(site: EarthSite, utcMs: number): GeocentricPosition {
  checkTime(utcMs)
  checkLat(site.lat)
  if (!Number.isFinite(site.lon) || site.lon < -180 || site.lon > 180) throw new RangeError(`invalid longitude: ${site.lon}`)
  const heightM = site.heightM ?? DEFAULT_LAUNCH_HEIGHT_M
  if (!Number.isFinite(heightM)) throw new RangeError(`invalid height: ${heightM}`)
  return {
    frame: 'EQJ', origin: 'geocenter', correction: 'geometric', unit: 'km', utcMs,
    positionKm: earthSitePositionEqjKm(site.lat, site.lon, heightM, new Date(utcMs)),
  }
}

/**
 * Geocentric EQJ position of a point on the Moon at a UTC instant. Latitude and longitude are used in the IAU lunar
 * orientation model; DE421 mean Earth coordinates (the candidates, the terrain products) are used as-is, which
 * displaces the point by up to ~250 m (measured in step 06). Not converted, so the result is labelled geometric/IAU.
 */
export function moonSiteGeocentric(site: MoonSite, utcMs: number): GeocentricPosition {
  checkTime(utcMs)
  checkLat(site.lat)
  if (!Number.isFinite(site.lon)) throw new RangeError(`invalid longitude: ${site.lon}`)
  const radiusKm = site.radiusKm ?? MOON_R_KM
  if (!(radiusKm > 0) || !Number.isFinite(radiusKm)) throw new RangeError(`invalid radius: ${radiusKm}`)
  return {
    frame: 'EQJ', origin: 'geocenter', correction: 'geometric', unit: 'km', utcMs,
    positionKm: moonSitePositionEqjKm(site.lat, site.lon, radiusKm, new Date(utcMs)),
  }
}

/** Straight-line distance between two positions in the same frame, km. */
export function separationKm(a: GeocentricPosition, b: GeocentricPosition): number {
  if (a.frame !== b.frame || a.origin !== b.origin) throw new Error('positions are in different frames')
  return Math.hypot(a.positionKm[0] - b.positionKm[0], a.positionKm[1] - b.positionKm[1], a.positionKm[2] - b.positionKm[2])
}
