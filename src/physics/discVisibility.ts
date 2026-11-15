// Visible part of the solar disc above a terrain skyline and outside the Earth's disc, seen from a lunar site.
//
// Geometry: the sky near the Sun is mapped to its tangent plane, x along increasing azimuth, y along increasing
// elevation, both in degrees (x = delta-azimuth * cos(elevation)). The disc (radius 0.26-0.27 deg) is cut into
// vertical slices with x = rho * sin(theta), theta spaced evenly; in each slice the visible chord is the part of
// [-c, c] above the skyline and outside the Earth's disc. The skyline is linear between its samples, as in
// runtimeHorizon. Tangent-plane error: of order rho^2 * tan(elevation) (< 0.001 deg for elevations below 60 deg);
// above the highest skyline sample the disc is simply above the terrain.
//
// Earth is a sphere of equatorial radius with no atmosphere: refraction and transmission through the Earth's
// atmosphere (the reddened light of a lunar eclipse) are not modelled, and flattening (0.3 %) is ignored.
//
// A skyline sample may be a lower bound (data gap): the true skyline there is at least that high. A fraction computed
// with a lower-bound sample is then only an upper bound on the visible fraction.

const DEG = Math.PI / 180

export type SkylineProfile = {
  elevationsDeg: readonly number[]
  startAzimuthDeg: number
  stepDeg: number
  /** Per sample: true when the value is only a lower bound. Absent = all complete. */
  lowerBound?: readonly boolean[]
}

const wrap360 = (a: number) => ((a % 360) + 360) % 360

/** Skyline elevation at an azimuth (linear between samples) and whether a lower-bound sample is involved. */
export function skylineAt(p: SkylineProfile, azDeg: number): { valueDeg: number; lowerBound: boolean } {
  const n = p.elevationsDeg.length
  const x = wrap360(azDeg - p.startAzimuthDeg) / p.stepDeg
  const i = Math.floor(x) % n
  const j = (i + 1) % n
  const f = x - Math.floor(x)
  const lb = !!p.lowerBound && ((p.lowerBound[i] && f < 1) || (p.lowerBound[j] && f > 0))
  // a + (b - a) f is exact for a level skyline, so a boundary test against it is not moved by rounding.
  const a = p.elevationsDeg[i]
  return { valueDeg: a + (p.elevationsDeg[j] - a) * f, lowerBound: lb }
}

/** Indices of all samples that bracket some azimuth in [az0, az1] (az1 - az0 may exceed 360). */
function samplesInSpan(p: SkylineProfile, az0: number, az1: number): number[] {
  const n = p.elevationsDeg.length
  if (az1 - az0 >= 360) return [...Array(n).keys()]
  const a = Math.floor(wrap360(az0 - p.startAzimuthDeg) / p.stepDeg)
  const count = Math.ceil((az1 - az0) / p.stepDeg) + 2
  return Array.from({ length: count }, (_, k) => (a + k) % n)
}

export type Disc = { azimuthDeg: number; elevationDeg: number; radiusDeg: number }
/** An occulting disc given by its centre offset in the tangent plane of the Sun (deg) and its radius (deg). */
export type Occulter = { dxDeg: number; dyDeg: number; radiusDeg: number }

export type DiscFraction = {
  /** Fraction of the disc area above the skyline (computed with lower-bound values where they occur). */
  aboveSkyline: number
  /** Fraction above the skyline and outside the occulter. */
  visible: number
  /** Fraction covered by the occulter, ignoring the terrain. */
  occulted: number
  /** True when a lower-bound skyline sample lies under the disc's azimuth span (aboveSkyline/visible are upper bounds). */
  usesLowerBound: boolean
  /** Highest skyline sample bracketing the disc's azimuth span, deg; -Infinity without a skyline. */
  skylineMaxInSpanDeg: number
}

export const DISC_SLICES = 96

/** Length of [lo, hi] minus [a, b]. */
const minus = (lo: number, hi: number, a: number, b: number) => {
  if (hi <= lo) return 0
  const cutLo = Math.max(lo, a), cutHi = Math.min(hi, b)
  return hi - lo - Math.max(0, cutHi - cutLo)
}

export function discFraction(d: Disc, skyline: SkylineProfile | null, occ: Occulter | null, slices = DISC_SLICES): DiscFraction {
  const rho = d.radiusDeg
  const cosEl = Math.cos(d.elevationDeg * DEG)
  const spanDeg = cosEl > 1e-6 ? Math.min(360, (2 * rho) / cosEl) : 360
  let usesLowerBound = false
  let skyMax = -Infinity
  if (skyline) {
    for (const i of samplesInSpan(skyline, d.azimuthDeg - spanDeg / 2, d.azimuthDeg + spanDeg / 2)) {
      skyMax = Math.max(skyMax, skyline.elevationsDeg[i])
      if (skyline.lowerBound?.[i]) usesLowerBound = true
    }
  }
  const entirelyAbove = !skyline || d.elevationDeg - rho > skyMax
  let above = 0, visible = 0, occulted = 0
  const dTheta = Math.PI / slices
  for (let k = 0; k < slices; k++) {
    const theta = -Math.PI / 2 + (k + 0.5) * dTheta
    const x = rho * Math.sin(theta)
    const c = rho * Math.cos(theta)
    const w = c * dTheta // dx = rho cos(theta) dtheta = c dtheta
    const h = entirelyAbove ? -Infinity : skylineAt(skyline!, d.azimuthDeg + x / cosEl).valueDeg - d.elevationDeg
    const lo = Math.max(-c, h)
    const chordAbove = Math.max(0, c - lo)
    let ea = Infinity, eb = -Infinity
    if (occ && Math.abs(x - occ.dxDeg) < occ.radiusDeg) {
      const half = Math.sqrt(occ.radiusDeg ** 2 - (x - occ.dxDeg) ** 2)
      ea = occ.dyDeg - half; eb = occ.dyDeg + half
    }
    above += chordAbove * w
    visible += minus(lo, c, ea, eb) * w
    occulted += (2 * c - minus(-c, c, ea, eb)) * w
  }
  // Normalise with the same quadrature applied to the full disc, so a fully visible disc is exactly 1.
  let full = 0
  for (let k = 0; k < slices; k++) { const theta = -Math.PI / 2 + (k + 0.5) * dTheta; const c = rho * Math.cos(theta); full += 2 * c * c * dTheta }
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  return { aboveSkyline: clamp(above / full), visible: clamp(visible / full), occulted: clamp(occulted / full), usesLowerBound, skylineMaxInSpanDeg: skyMax }
}

/**
 * Largest height of the disc's upper edge above the skyline over the disc's slices, deg: > 0 exactly when part of
 * the disc is above the skyline. Continuous in time, for event searches.
 */
export function discTopMarginDeg(d: Disc, skyline: (azDeg: number) => number, slices = 32): number {
  const rho = d.radiusDeg
  const cosEl = Math.cos(d.elevationDeg * DEG)
  let best = -Infinity
  for (let k = 0; k <= slices; k++) {
    const theta = -Math.PI / 2 + (k * Math.PI) / slices
    const x = rho * Math.sin(theta)
    const top = d.elevationDeg + rho * Math.cos(theta)
    best = Math.max(best, top - skyline(d.azimuthDeg + (cosEl > 1e-6 ? x / cosEl : 0)))
  }
  return best
}

/** Largest skyline slope between adjacent samples, deg of elevation per deg of azimuth. */
export function skylineMaxSlope(p: SkylineProfile): number {
  const n = p.elevationsDeg.length
  let s = 0
  for (let i = 0; i < n; i++) s = Math.max(s, Math.abs(p.elevationsDeg[(i + 1) % n] - p.elevationsDeg[i]) / p.stepDeg)
  return s
}

/** True when any lower-bound sample brackets an azimuth in [az0, az1] (az1 >= az0; spans >= 360 cover all). */
export function lowerBoundInSpan(p: SkylineProfile, az0: number, az1: number): boolean {
  if (!p.lowerBound) return false
  return samplesInSpan(p, az0, az1).some((i) => p.lowerBound![i])
}

/** Unit vector in east-north-up from azimuth and elevation (deg). */
export function enuFromAzEl(azDeg: number, elDeg: number): [number, number, number] {
  const a = azDeg * DEG, e = elDeg * DEG
  return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)]
}

/** Gnomonic offset (deg) of a direction in the tangent plane at a disc centre: x along azimuth, y along elevation. */
export function tangentOffsetDeg(centre: { azimuthDeg: number; elevationDeg: number }, other: { azimuthDeg: number; elevationDeg: number }): { dxDeg: number; dyDeg: number } | null {
  const a = centre.azimuthDeg * DEG, e = centre.elevationDeg * DEG
  const c = enuFromAzEl(centre.azimuthDeg, centre.elevationDeg)
  const o = enuFromAzEl(other.azimuthDeg, other.elevationDeg)
  const ex = [Math.cos(a), -Math.sin(a), 0]
  const ey = [-Math.sin(e) * Math.sin(a), -Math.sin(e) * Math.cos(a), Math.cos(e)]
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
  const w = dot(o, c)
  if (w <= 0) return null // more than 90 deg away: cannot overlap a small disc
  return { dxDeg: Math.atan(dot(o, ex) / w) / DEG, dyDeg: Math.atan(dot(o, ey) / w) / DEG }
}
