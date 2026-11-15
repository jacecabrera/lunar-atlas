// Simplified transit estimate (v0.7 section 3, step 14): straight-line endpoint distance divided by an effective speed.
// Not an orbit, fuel, launch-window or descent analysis.
//
//   D(tau)  = | r_E(tL - tau) - r_M(tL) |       geocentric EQJ, geometric positions, km (frames.ts)
//   tau     = D(tau) / v                        solved for tau (s); launch time = tL - tau
// r_E: the launch site on Earth's ellipsoid at the estimated launch instant (height 0 m by default, ASM-LAUNCH-HEIGHT).
// r_M: the lunar destination at the landing instant, at the observer radius from its terrain (no silent 1737.4 km).
//
// Uniqueness and convergence. Only r_E moves with tau, and only by Earth rotation in EQJ (precession and nutation
// rates are ~1e-12 rad/s), so |dD/dtau| <= omega_E (a + h) = 0.46510 km/s for a = 6378.1366 km, h = 0. Hence
// g(tau) = tau - D(tau)/v has g' >= 1 - 0.4652/v > 0 for v > V_CRIT: one root, and the fixed-point iteration
// tau <- D(tau)/v contracts with factor q = V_CRIT/v. For v <= V_CRIT several roots are possible; the estimate then
// returns 'multiple-solutions-possible' with the roots found by a scan, not a chosen value.
// Acceptance is on the final equation residual |tau - D(tau)/v| <= toleranceMs, never on the step between iterates.
import { earthSiteGeocentric, moonSiteGeocentric, separationKm, DEFAULT_LAUNCH_HEIGHT_M } from './frames'
import { MAX_DATE_MS } from './units'
import type { ConditionReason } from './assessment'

export const TRANSIT_MODEL = 'transit-v1:tau=|rE(tL-tau)-rM(tL)|/v;EQJ-geocentric-geometric;fixed-point(q=0.4652/v)+bracketed-illinois;residual<=1ms'

const OMEGA_EARTH_RAD_S = 7.2921159e-5
const EARTH_EQ_RADIUS_KM = 6378.1366 // Astronomy Engine's ellipsoid (frames.ts)
/** Largest |dD/dtau| for a given launch height, km/s (rotation speed of the site about the Earth's axis, rounded up). */
export const criticalSpeedKmPerS = (heightM = 0) => OMEGA_EARTH_RAD_S * (EARTH_EQ_RADIUS_KM + heightM / 1000) * 1.0001

/** Range in which the Horizons comparison of step 06 was made (Moon and Earth endpoints, 27 epochs). */
export const TRANSIT_VALIDATED_RANGE = { startMs: Date.UTC(2016, 10, 14), endMs: Date.UTC(2036, 10, 14) }

export type TransitInput = {
  landingTimeMs: number
  launchSite: { lat: number; lon: number; heightM?: number }
  /** radiusKm: observer radius from the destination's terrain (1737.4 km + elevation); null when the elevation is unknown. */
  destination: { lat: number; lon: number; radiusKm: number | null; elevationSource?: string }
  speedKmPerS: number
}

/** maxIterations applies to each method; fixedPointIterations (default maxIterations) limits the first one only. */
export type TransitOptions = { toleranceMs?: number; maxIterations?: number; fixedPointIterations?: number; maxEvaluations?: number }
const DEFAULTS = { toleranceMs: 1, maxIterations: 60, maxEvaluations: 400 }

export type TransitStatus = 'ok' | 'invalid-input' | 'missing-elevation' | 'out-of-range' | 'not-converged' | 'multiple-solutions-possible'

export type TransitEstimate = {
  status: TransitStatus
  durationMs: number | null
  launchTimeMs: number | null
  distanceKm: number | null
  convergence: {
    method: 'fixed-point' | 'bracketed' | 'scan' | null
    iterations: number
    evaluations: number
    /** |tau - D(tau)/v| at the returned tau, ms. */
    residualMs: number | null
    toleranceMs: number
    /** Bound on |tau - tau*| from the residual: residual / (1 - q); null when q >= 1. */
    errorBoundMs: number | null
    contractionFactor: number
  }
  /** Inside the Horizons-checked span (both instants). Outside it the model still computes but has no accuracy record. */
  withinValidatedRange: boolean | null
  rootsFoundMs?: number[]
  frame: 'EQJ geocentric, geometric (no light-time, no aberration)'
  assumptions: string[]
  reasons: ConditionReason[]
  model: string
}

const ASSUMPTIONS = [
  'Simplified estimate: straight-line endpoint distance divided by an effective speed; not an orbit, fuel, launch-window or descent analysis.',
  'Launch site height above the ellipsoid as given (default 0 m, project assumption ASM-LAUNCH-HEIGHT).',
  'Lunar endpoint at the landing instant, at the observer radius of the destination terrain.',
]

export function estimateTransit(input: TransitInput, opts: TransitOptions = {}): TransitEstimate {
  const o = { ...DEFAULTS, ...opts }
  const v = input.speedKmPerS
  const heightM = input.launchSite.heightM ?? DEFAULT_LAUNCH_HEIGHT_M
  const vCrit = criticalSpeedKmPerS(Math.max(0, heightM))
  const q = Number.isFinite(v) && v > 0 ? vCrit / v : Infinity
  let evaluations = 0
  const conv = (method: TransitEstimate['convergence']['method'], iterations: number, residualMs: number | null) => ({
    method, iterations, evaluations, residualMs, toleranceMs: o.toleranceMs,
    errorBoundMs: residualMs !== null && q < 1 ? residualMs / (1 - q) : null, contractionFactor: q,
  })
  const out = (status: TransitStatus, reasons: ConditionReason[], extra: Partial<TransitEstimate> = {}): TransitEstimate => ({
    status, durationMs: null, launchTimeMs: null, distanceKm: null, convergence: conv(null, 0, null), withinValidatedRange: null,
    frame: 'EQJ geocentric, geometric (no light-time, no aberration)', assumptions: ASSUMPTIONS, reasons, model: TRANSIT_MODEL, ...extra,
  })

  // Input checks (an invalid speed is reported, not clamped; no minimum speed is imposed beyond v > 0).
  const bad: ConditionReason[] = []
  if (!(Number.isFinite(v) && v > 0)) bad.push({ code: 'transit-invalid-speed', message: 'Effective transit speed must be a finite number greater than 0' })
  if (!Number.isFinite(input.landingTimeMs)) bad.push({ code: 'transit-invalid-time', message: 'Landing Time must be finite' })
  const ls = input.launchSite
  if (!(ls.lat >= -90 && ls.lat <= 90) || !(ls.lon >= -180 && ls.lon <= 180) || !Number.isFinite(heightM)) bad.push({ code: 'transit-invalid-launch-site', message: 'Launch site latitude, longitude or height is invalid' })
  const ds = input.destination
  if (!(ds.lat >= -90 && ds.lat <= 90) || !Number.isFinite(ds.lon)) bad.push({ code: 'transit-invalid-destination', message: 'Destination coordinate is invalid' })
  if (bad.length) return out('invalid-input', bad)
  if (ds.radiusKm === null || !(ds.radiusKm > 0) || !Number.isFinite(ds.radiusKm)) {
    return out('missing-elevation', [{ code: 'transit-missing-elevation', message: 'The destination elevation (observer radius) is not available; it is not replaced by 0 m' }])
  }
  if (Math.abs(input.landingTimeMs) > MAX_DATE_MS) return out('out-of-range', [{ code: 'transit-time-out-of-range', message: 'Landing Time is outside the computable date range' }])

  const tL = input.landingTimeMs
  let moon: ReturnType<typeof moonSiteGeocentric>
  try { moon = moonSiteGeocentric({ lat: ds.lat, lon: ds.lon, radiusKm: ds.radiusKm }, tL) } catch (e) {
    return out('out-of-range', [{ code: 'transit-moon-endpoint-error', message: e instanceof Error ? e.message : String(e) }])
  }
  const site = { lat: ls.lat, lon: ls.lon, heightM }
  /** D(tau) in km for tau in seconds; null when the launch instant leaves the computable range or the budget is spent. */
  const D = (tauS: number): number | null => {
    if (evaluations >= o.maxEvaluations) return null
    const t = tL - tauS * 1000
    if (!Number.isFinite(t) || Math.abs(t) > MAX_DATE_MS) return null
    evaluations++
    return separationKm(earthSiteGeocentric(site, t), moon)
  }
  const g = (tauS: number) => { const d = D(tauS); return d === null ? null : { r: tauS - d / v, d } }
  const finish = (tauS: number, d: number, method: 'fixed-point' | 'bracketed', iterations: number): TransitEstimate => {
    const residualMs = Math.abs(tauS - d / v) * 1000
    const launch = tL - tauS * 1000
    const inside = (t: number) => t >= TRANSIT_VALIDATED_RANGE.startMs && t <= TRANSIT_VALIDATED_RANGE.endMs
    return {
      ...out('ok', inside(launch) && inside(tL) ? [] : [{ code: 'transit-outside-validated-range', message: 'Outside the 2016-11-14..2036-11-14 span checked against Horizons; computed, but without an accuracy record' }]),
      durationMs: tauS * 1000, launchTimeMs: launch, distanceKm: d, convergence: conv(method, iterations, residualMs), withinValidatedRange: inside(launch) && inside(tL),
    }
  }
  const tolS = o.toleranceMs / 1000

  // Bracket: D lies within |r_M| -/+ (a + h), so every root is in [lo, hi].
  const rM = Math.hypot(...moon.positionKm)
  const reach = EARTH_EQ_RADIUS_KM + Math.max(0, heightM) / 1000 + 1
  const lo = Math.max(0, (rM - reach) / v), hi = (rM + reach) / v

  if (q < 1) {
    // Fixed-point iteration (contraction q), accepted on the equation residual.
    let tau = lo
    for (let i = 1; i <= (o.fixedPointIterations ?? o.maxIterations); i++) {
      const d = D(tau)
      if (d === null) break
      const next = d / v
      const r = g(next)
      if (r === null) break
      if (Math.abs(r.r) <= tolS) return finish(next, r.d, 'fixed-point', i)
      tau = next
    }
    // Fallback: Illinois (regula falsi) on the bracket, where g is strictly increasing.
    let a = lo, b = hi
    let ga = g(a), gb = g(b)
    if (ga === null || gb === null) return out(evaluations >= o.maxEvaluations ? 'not-converged' : 'out-of-range', [{ code: evaluations >= o.maxEvaluations ? 'transit-budget-exhausted' : 'transit-launch-out-of-range', message: 'The launch instant is outside the computable range or the evaluation budget was spent' }], { convergence: conv(null, 0, null) })
    let side = 0
    for (let i = 1; i <= o.maxIterations; i++) {
      const c = b - (gb.r * (b - a)) / (gb.r - ga.r)
      const gc = g(c)
      if (gc === null) break
      if (Math.abs(gc.r) <= tolS) return finish(c, gc.d, 'bracketed', i)
      if (Math.sign(gc.r) === Math.sign(gb.r)) { b = c; gb = gc; if (side === -1) ga = { ...ga, r: ga.r / 2 }; side = -1 }
      else { a = c; ga = gc; if (side === 1) gb = { ...gb, r: gb.r / 2 }; side = 1 }
    }
    return out('not-converged', [{ code: 'transit-not-converged', message: `No tau with a residual within ${o.toleranceMs} ms after ${evaluations} evaluations` }], { convergence: conv('bracketed', o.maxIterations, null) })
  }

  // v <= V_CRIT: several roots are possible. Scan the bracket (step 1 h of tau) and report what was found.
  const roots: number[] = []
  const stepS = 3600
  let prev = g(lo)
  for (let t = lo + stepS; prev && t <= hi + stepS; t += stepS) {
    const cur = g(Math.min(t, hi))
    if (!cur) break
    if (Math.sign(cur.r) !== Math.sign(prev.r)) roots.push((Math.min(t, hi) - stepS / 2) * 1000)
    prev = cur
  }
  return out('multiple-solutions-possible', [{ code: 'transit-speed-below-rotation-bound', message: `At ${v} km/s (not above ${vCrit.toFixed(4)} km/s, the Earth-rotation speed of the site) the equation may have several solutions; none is chosen` }], { convergence: conv('scan', 0, null), rootsFoundMs: roots })
}
