// Transit estimate. Coordinates and elevations here are SYNTHETIC test values, not candidate results.
import { describe, expect, it } from 'vitest'
import { estimateTransit, criticalSpeedKmPerS } from './transit'
import { earthSiteGeocentric, moonSiteGeocentric, separationKm } from './frames'

const tL = Date.UTC(2027, 3, 20, 12)
const base = { landingTimeMs: tL, launchSite: { lat: 28.5, lon: -80.6 }, destination: { lat: 0.674, lon: 23.473, radiusKm: 1735.47 }, speedKmPerS: 1.5 }
/** Final equation residual recomputed independently of the solver, ms. */
const residualMs = (x: typeof base, r: ReturnType<typeof estimateTransit>) => {
  const d = separationKm(earthSiteGeocentric({ ...x.launchSite }, r.launchTimeMs!), moonSiteGeocentric(x.destination as { lat: number; lon: number; radiusKm: number }, x.landingTimeMs))
  return Math.abs(r.durationMs! / 1000 - d / x.speedKmPerS) * 1000
}

describe('solution of tau = D(tau) / v', () => {
  it('meets the final equation residual (recomputed independently) at the default speed, with a unique root', () => {
    const r = estimateTransit(base)
    expect(r.status).toBe('ok')
    expect(r.convergence.method).toBe('fixed-point')
    expect(r.convergence.contractionFactor).toBeLessThan(0.32)
    expect(residualMs(base, r)).toBeLessThanOrEqual(1)
    expect(r.launchTimeMs).toBe(tL - r.durationMs!)
    expect(r.durationMs! / 86_400_000).toBeGreaterThan(2.7) // ~384,000 km at 1.5 km/s is about 3 days
    expect(r.durationMs! / 86_400_000).toBeLessThan(3.2)
  })
  it('a launch site at the pole barely moves: tau equals the fixed endpoint distance over the speed', () => {
    const pole = { ...base, launchSite: { lat: 90, lon: 0 } }
    const r = estimateTransit(pole)
    const d = separationKm(earthSiteGeocentric({ lat: 90, lon: 0 }, tL - 3 * 86_400_000), moonSiteGeocentric(base.destination, tL))
    expect(Math.abs(r.durationMs! - (d / 1.5) * 1000)).toBeLessThan(50) // the pole drifts only by precession
  })
  it('uses each endpoint at its own instant (Earth at launch, Moon at landing)', () => {
    const r = estimateTransit(base)
    const own = separationKm(earthSiteGeocentric(base.launchSite, r.launchTimeMs!), moonSiteGeocentric(base.destination, tL))
    const sameInstant = separationKm(earthSiteGeocentric(base.launchSite, r.launchTimeMs!), moonSiteGeocentric(base.destination, r.launchTimeMs!))
    expect(r.distanceKm!).toBeCloseTo(own, 6)
    expect(Math.abs(r.distanceKm! - sameInstant)).toBeGreaterThan(1000) // the Moon moves ~90,000 km in 3 days
  })
  it('re-solves when the speed changes, and the launch site changes the result', () => {
    const fast = estimateTransit({ ...base, speedKmPerS: 3 })
    expect(fast.durationMs! / estimateTransit(base).durationMs!).toBeCloseTo(0.5, 1)
    expect(Math.abs(estimateTransit({ ...base, launchSite: { lat: -30, lon: 120 } }).durationMs! - estimateTransit(base).durationMs!)).toBeGreaterThan(1000)
  })
  it('propagates the destination elevation (observer radius) into the distance', () => {
    const low = estimateTransit({ ...base, destination: { ...base.destination, radiusKm: 1731.47 } })
    const high = estimateTransit({ ...base, destination: { ...base.destination, radiusKm: 1737.93 } })
    expect(Math.abs(low.distanceKm! - high.distanceKm!)).toBeGreaterThan(0.5)
    expect(Math.abs(low.distanceKm! - high.distanceKm!)).toBeLessThan(6.5) // at most the radius difference
  })
  it('handles longitude and latitude limits, a UTC date change and a leap day', () => {
    for (const ls of [{ lat: -90, lon: -180 }, { lat: 90, lon: 180 }, { lat: 0, lon: 180 }, { lat: 0, lon: -180 }]) {
      const x = { ...base, launchSite: ls }
      expect(residualMs(x, estimateTransit(x))).toBeLessThanOrEqual(1)
    }
    const leap = { ...base, landingTimeMs: Date.UTC(2028, 2, 1, 0, 30) }
    const r = estimateTransit(leap)
    expect(r.status).toBe('ok')
    expect(new Date(r.launchTimeMs!).getUTCMonth()).toBe(1) // launch in February 2028, which has 29 days
    expect(residualMs(leap, r)).toBeLessThanOrEqual(1)
  })
  it('just above the rotation bound (q = 0.99) it still meets the residual; the bracketed fallback does too', () => {
    const v = criticalSpeedKmPerS() * 1.01
    const x = { ...base, speedKmPerS: v }
    const r = estimateTransit(x)
    expect(r.status).toBe('ok')
    expect(residualMs(x, r)).toBeLessThanOrEqual(1)
    const fb = estimateTransit(x, { fixedPointIterations: 1 })
    expect(fb.convergence.method).toBe('bracketed')
    expect(residualMs(x, fb)).toBeLessThanOrEqual(1)
  })
})

describe('explicit statuses instead of guessed values', () => {
  it('invalid speed, missing elevation and out-of-range time', () => {
    for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(estimateTransit({ ...base, speedKmPerS: v })).toMatchObject({ status: 'invalid-input', durationMs: null, launchTimeMs: null })
    expect(estimateTransit({ ...base, destination: { ...base.destination, radiusKm: null } })).toMatchObject({ status: 'missing-elevation', durationMs: null })
    expect(estimateTransit({ ...base, landingTimeMs: 9e15 }).status).toBe('out-of-range')
    expect(estimateTransit({ ...base, launchSite: { lat: 91, lon: 0 } }).status).toBe('invalid-input')
  })
  it('an exhausted budget is reported as not converged, never as the last iterate', () => {
    const r = estimateTransit(base, { maxEvaluations: 3 })
    expect(r.status).toBe('not-converged')
    expect(r.durationMs).toBeNull()
  })
  it('below the Earth-rotation bound no single solution is claimed', () => {
    const r = estimateTransit({ ...base, speedKmPerS: 0.3 })
    expect(r.status).toBe('multiple-solutions-possible')
    expect(r.durationMs).toBeNull()
    expect(r.rootsFoundMs!.length).toBeGreaterThan(0)
  })
  it('outside the Horizons-checked span it computes but says so', () => {
    const r = estimateTransit({ ...base, landingTimeMs: Date.UTC(2050, 0, 1) })
    expect(r.status).toBe('ok')
    expect(r.withinValidatedRange).toBe(false)
    expect(r.reasons[0].code).toBe('transit-outside-validated-range')
    expect(estimateTransit(base).withinValidatedRange).toBe(true)
  })
})
