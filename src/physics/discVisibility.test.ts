// Disc geometry against independent references: closed-form circle segment and lens areas, and brute-force
// counting on a fine 2D grid. SYNTHETIC skylines only.
import { describe, expect, it } from 'vitest'
import { discEdgeMargins, discFraction, discTopMarginDeg, skylineAt, tangentOffsetDeg } from './discVisibility'
import type { SkylineProfile } from './discVisibility'

const rho = 0.2666
const segment = (h: number) => { // fraction of a disc of radius rho above the line y = h
  if (h >= rho) return 0
  if (h <= -rho) return 1
  return (rho * rho * Math.acos(h / rho) - h * Math.sqrt(rho * rho - h * h)) / (Math.PI * rho * rho)
}
const lens = (d: number, r1: number, r2: number) => { // overlap area of two circles
  if (d >= r1 + r2) return 0
  if (d <= Math.abs(r1 - r2)) return Math.PI * Math.min(r1, r2) ** 2
  const a = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1))
  const b = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2))
  return a + b - 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2))
}
const flat = (deg: number, step = 0.5): SkylineProfile => ({ elevationsDeg: Array(360 / step).fill(deg), startAzimuthDeg: 0, stepDeg: step })
/** Brute force: fraction of grid points in the disc that are above the skyline and outside the occulter. */
function brute(az: number, el: number, sky: (az: number) => number, occ: { dx: number; dy: number; r: number } | null, n = 1200) {
  const cos = Math.cos((el * Math.PI) / 180)
  let inside = 0, vis = 0
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = -rho + ((i + 0.5) * 2 * rho) / n, y = -rho + ((j + 0.5) * 2 * rho) / n
    if (x * x + y * y > rho * rho) continue
    inside++
    const above = el + y > sky(az + x / cos)
    const hidden = occ ? (x - occ.dx) ** 2 + (y - occ.dy) ** 2 < occ.r * occ.r : false
    if (above && !hidden) vis++
  }
  return vis / inside
}

describe('disc above a skyline', () => {
  it('matches the circle-segment area for a level skyline at any height', () => {
    for (const h of [-0.3, -rho, -0.2, -0.1, 0, 0.05, 0.13, 0.25, rho, 0.3]) {
      const f = discFraction({ azimuthDeg: 100, elevationDeg: 2, radiusDeg: rho }, flat(2 + h), null)
      expect(f.aboveSkyline).toBeCloseTo(segment(h), 3)
    }
  })
  it('handles a skyline step inside the disc and a sloped skyline (brute-force reference)', () => {
    // Fine samples so the linear interpolation reproduces the step and the slope exactly.
    const step = 0.01
    const az0 = 200, el = 1.5
    const stepped = (az: number) => (az < az0 + 0.05 ? 1.45 : 1.62)
    const sloped = (az: number) => 1.5 + 0.8 * (az - az0)
    for (const sky of [stepped, sloped]) {
      const p: SkylineProfile = { elevationsDeg: Array.from({ length: 36000 }, (_, i) => sky(i * step)), startAzimuthDeg: 0, stepDeg: step }
      const f = discFraction({ azimuthDeg: az0, elevationDeg: el, radiusDeg: rho }, p, null)
      expect(f.aboveSkyline).toBeCloseTo(brute(az0, el, (az) => skylineAt(p, az).valueDeg, null), 2)
    }
  })
  it('is not visible at exact tangency and visible just above it', () => {
    const d = { azimuthDeg: 10, elevationDeg: 0, radiusDeg: rho }
    expect(discTopMarginDeg(d, () => rho)).toBeCloseTo(0, 12)
    expect(discTopMarginDeg(d, () => rho) > 0).toBe(false)
    expect(discTopMarginDeg(d, () => rho - 1e-6) > 0).toBe(true)
    expect(discFraction(d, flat(rho), null).aboveSkyline).toBe(0)
  })
  it('wraps the azimuth through north', () => {
    const p: SkylineProfile = { elevationsDeg: Array.from({ length: 720 }, (_, i) => (i === 0 ? 5 : 0)), startAzimuthDeg: 0, stepDeg: 0.5 }
    expect(skylineAt(p, 359.75).valueDeg).toBeCloseTo(2.5, 12)
    expect(skylineAt(p, -0.25).valueDeg).toBeCloseTo(2.5, 12)
    const f = discFraction({ azimuthDeg: 359.95, elevationDeg: 0.5, radiusDeg: rho }, p, null)
    expect(f.aboveSkyline).toBeLessThan(1)
  })
  it('flags a lower-bound sample under the disc span only', () => {
    const p: SkylineProfile = { ...flat(0), lowerBound: Array.from({ length: 720 }, (_, i) => i === 200) } // azimuth 100
    expect(discFraction({ azimuthDeg: 100.1, elevationDeg: 1, radiusDeg: rho }, p, null).usesLowerBound).toBe(true)
    expect(discFraction({ azimuthDeg: 120, elevationDeg: 1, radiusDeg: rho }, p, null).usesLowerBound).toBe(false)
    expect(skylineAt(p, 100.2).lowerBound).toBe(true)
    expect(skylineAt(p, 101).lowerBound).toBe(false)
  })
})

describe('complex skylines, slivers, convergence and exact edge margins', () => {
  const fine = (sky: (az: number) => number): SkylineProfile => ({ elevationsDeg: Array.from({ length: 36000 }, (_, i) => sky(i * 0.01)), startAzimuthDeg: 0, stepDeg: 0.01 })
  const zigzag = (az: number) => 1.5 + 0.12 * Math.sin(((az - 200) * Math.PI) / 0.07) + 0.4 * (az - 200)
  it('a multi-kink skyline agrees with brute force, and 96 vs 1536 slices agree', () => {
    const p = fine(zigzag)
    const d = { azimuthDeg: 200, elevationDeg: 1.5, radiusDeg: rho }
    const coarse = discFraction(d, p, null).aboveSkyline, refined = discFraction(d, p, null, 1536).aboveSkyline
    expect(Math.abs(coarse - refined)).toBeLessThan(2e-3)
    expect(refined).toBeCloseTo(brute(200, 1.5, (az) => skylineAt(p, az).valueDeg, null), 2)
  })
  it('a thin sliver: fraction matches the segment formula with fine slices', () => {
    for (const m of [0.02, 0.005, 0.001]) {
      const f = discFraction({ azimuthDeg: 30, elevationDeg: 1, radiusDeg: rho }, flat(1 + rho - m, 0.5), null, 1536).aboveSkyline
      expect(f / segment(rho - m)).toBeCloseTo(1, 1)
    }
  })
  it('exact edge margins match dense numerical sampling of the chord', () => {
    const p = fine(zigzag)
    for (const el of [1.2, 1.5, 1.9]) {
      const d = { azimuthDeg: 200.03, elevationDeg: el, radiusDeg: rho }
      const e = discEdgeMargins(d, p)
      let top = -Infinity, clr = Infinity
      for (let k = 0; k <= 20000; k++) {
        const x = -rho + (2 * rho * k) / 20000, c = Math.sqrt(Math.max(0, rho * rho - x * x))
        const h = skylineAt(p, 200.03 + x / Math.cos((el * Math.PI) / 180)).valueDeg
        top = Math.max(top, el + c - h); clr = Math.min(clr, el - c - h)
      }
      expect(e.topDeg).toBeGreaterThanOrEqual(top - 1e-9)
      expect(e.topDeg - top).toBeLessThan(1e-4)
      expect(e.clearanceDeg).toBeLessThanOrEqual(clr + 1e-9)
      expect(clr - e.clearanceDeg).toBeLessThan(1e-4)
    }
  })
  it('the sampled preview margin can miss a narrow notch that the exact margin finds', () => {
    // Skyline 0.1 deg above the disc top except a 0.004 deg wide notch: only the exact margin sees the gap.
    // Notch centred 0.0065 deg from the disc centre: between the preview's slices at x = 0 and x = rho sin(pi/32).
    const notch = (az: number) => (Math.abs(az - 100.0065) < 0.002 ? 0 : 1 + rho + 0.1)
    const p: SkylineProfile = { elevationsDeg: Array.from({ length: 360000 }, (_, i) => notch(i * 0.001)), startAzimuthDeg: 0, stepDeg: 0.001 }
    const d = { azimuthDeg: 100, elevationDeg: 1, radiusDeg: rho }
    expect(discEdgeMargins(d, p).topDeg).toBeGreaterThan(0)
    expect(discTopMarginDeg(d, (az) => skylineAt(p, az).valueDeg, 32)).toBeLessThan(0)
  })
})

describe('Earth in front of the Sun', () => {
  const rE = 0.95
  it('matches the lens area for partial and total cover', () => {
    for (const d of [2, 1.3, 1.2, 1.0, 0.8, 0.683, 0.5, 0]) {
      const f = discFraction({ azimuthDeg: 50, elevationDeg: 30, radiusDeg: rho }, null, { dxDeg: d * 0.6, dyDeg: d * 0.8, radiusDeg: rE })
      expect(f.occulted).toBeCloseTo(lens(d, rho, rE) / (Math.PI * rho * rho), 3)
    }
  })
  it('combines terrain and Earth on the same disc (not a product of fractions)', () => {
    const occ = { dxDeg: 0.9, dyDeg: 0.6, radiusDeg: rE }
    const f = discFraction({ azimuthDeg: 80, elevationDeg: 1, radiusDeg: rho }, flat(0.95, 0.01), occ)
    const ref = brute(80, 1, () => 0.95, { dx: occ.dxDeg, dy: occ.dyDeg, r: rE })
    expect(f.visible).toBeCloseTo(ref, 2)
    expect(Math.abs(f.visible - f.aboveSkyline * (1 - f.occulted))).toBeGreaterThan(0.01) // the product would be wrong here
  })
  it('places the Earth in the Sun tangent plane (gnomonic offset)', () => {
    const o = tangentOffsetDeg({ azimuthDeg: 90, elevationDeg: 0 }, { azimuthDeg: 91, elevationDeg: 0.5 })!
    expect(o.dxDeg).toBeCloseTo(1, 3)
    expect(o.dyDeg).toBeCloseTo(0.5, 3)
    expect(tangentOffsetDeg({ azimuthDeg: 0, elevationDeg: 0 }, { azimuthDeg: 180, elevationDeg: 0 })).toBeNull()
  })
})
