// Installs the leap-second Delta T in Astronomy Engine before any call (see timeScale.ts).
import './timeScale'
import { KM_PER_AU, MakeTime, Observer, ObserverVector, RotateVector, Rotation_EQD_EQJ, SiderealTime, Vector } from 'astronomy-engine'
import { mul } from './moonFrame'
import type { Mat3, Vec3 } from './moonFrame'

const DEG = Math.PI / 180

// EQJ -> scene axes: (x, y, z) -> (x, z, -y), same mapping as toScene()
const P: Mat3 = [[1, 0, 0], [0, 0, 1], [0, -1, 0]]
// Mesh-local axes (lon 0 = +X, east = -Z, north = +Y) -> Earth-fixed axes (x = lon 0, y = 90 E, z = north)
const MESH_TO_FIXED: Mat3 = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]

/**
 * Rotation taking Earth-fixed vectors (x = Greenwich meridian on the equator, y = 90 E, z = north pole) into EQJ
 * (J2000 mean equator and equinox, Astronomy Engine's inertial frame). Uses the library's model: Greenwich apparent
 * sidereal time about the true pole of date, then nutation (IAU 2000B) and precession back to J2000.
 * Not modelled: polar motion (up to about 0.5 arcsec, ~15 m at the surface), UT1 - UTC (the library treats UTC as
 * UT1, |UT1 - UTC| < 0.9 s, up to ~0.4 km at the equator) and the ICRS frame bias (~0.02 arcsec).
 */
export function earthFixedToEqj(date: Date): Mat3 {
  const time = MakeTime(date)
  const gast = SiderealTime(time) * 15 * DEG
  const c = Math.cos(gast), s = Math.sin(gast)
  const toEqj = Rotation_EQD_EQJ(time)
  // Columns are the images of the Earth-fixed basis vectors: rotate by GAST into EQD, then EQD -> EQJ.
  const cols = ([[c, s, 0], [-s, c, 0], [0, 0, 1]] as Vec3[]).map(([x, y, z]) => {
    const v = RotateVector(toEqj, new Vector(x, y, z, time))
    return [v.x, v.y, v.z] as Vec3
  })
  return [
    [cols[0][0], cols[1][0], cols[2][0]],
    [cols[0][1], cols[1][1], cols[2][1]],
    [cols[0][2], cols[1][2], cols[2][2]],
  ]
}

/**
 * Earth mesh orientation: mesh-local axes -> scene axes. Same rotation as earthFixedToEqj(), so a marker placed at
 * a latitude/longitude on the textured globe lines up with the physical position returned by earthSitePositionEqjKm()
 * (up to the ellipsoid shape, which the spherical mesh does not show). Before step 06 this ignored precession and
 * nutation (about 0.36 degrees of longitude in 2026).
 */
export function earthSceneRotation(date: Date): Mat3 {
  return mul(P, mul(earthFixedToEqj(date), MESH_TO_FIXED))
}

/**
 * Geocentric position of a point on the Earth in EQJ, km, at the given instant. Delegates to Astronomy Engine's
 * ObserverVector (ofdate = false).
 *
 * latDeg   geodetic latitude, degrees, north positive, on the library's ellipsoid (equatorial radius 6378.1366 km,
 *          flattening 1/298.25642); the WGS-84 / ITRF ellipsoid used by JPL Horizons differs by under a metre
 * lonDeg   degrees, east positive
 * heightM  height above that ellipsoid, metres (not above mean sea level)
 */
export function earthSitePositionEqjKm(latDeg: number, lonDeg: number, heightM: number, date: Date): Vec3 {
  const v = ObserverVector(date, new Observer(latDeg, lonDeg, heightM), false)
  return [v.x * KM_PER_AU, v.y * KM_PER_AU, v.z * KM_PER_AU]
}
