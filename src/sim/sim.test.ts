import { describe, expect, it } from 'vitest'
import {
  sceneState, skyAt, windows, nextEvent, compareSites, intersect, panelFactor,
  horizonFromProfile, DAY_MS,
} from './index'

const T0 = Date.UTC(2026, 10, 13)

describe('horizonFromProfile', () => {
  it('interpolates and wraps around north', () => {
    const h = horizonFromProfile([0, 10, 20, 30]) // samples at 0, 90, 180, 270 deg
    expect(h(0)).toBeCloseTo(0)
    expect(h(45)).toBeCloseTo(5)
    expect(h(180)).toBeCloseTo(20)
    expect(h(315)).toBeCloseTo(15) // halfway between 30 (at 270) and 0 (at 360)
    expect(h(-90)).toBeCloseTo(30)
    expect(h(720)).toBeCloseTo(0)
  })
})

describe('mask and horizon', () => {
  const site = { lat: 0, lon: 0 }
  it('a higher mask shortens the Sun window', () => {
    const end = T0 + 30 * DAY_MS
    const total = (m: number) => windows(site, 'sun', T0, end, { maskDeg: m }).reduce((s, i) => s + i.end - i.start, 0)
    expect(total(0)).toBeGreaterThan(total(10))
    expect(total(10)).toBeGreaterThan(total(30))
  })
  it('a constant-elevation terrain horizon behaves like the same mask angle', () => {
    const end = T0 + 30 * DAY_MS
    const a = windows(site, 'sun', T0, end, { maskDeg: 8 })
    const b = windows({ ...site, horizon: () => 8 }, 'sun', T0, end)
    expect(b.length).toBe(a.length)
    b.forEach((iv, i) => {
      expect(Math.abs(iv.start - a[i].start)).toBeLessThan(2000)
      expect(Math.abs(iv.end - a[i].end)).toBeLessThan(2000)
    })
  })
  it('a ridge in one direction only blocks the Sun when it is in that direction', () => {
    const east = horizonFromProfile(Array.from({ length: 360 }, (_, az) => (az > 45 && az < 135 ? 20 : 0)))
    const flat = windows(site, 'sun', T0, T0 + 30 * DAY_MS)
    const ridged = windows({ ...site, horizon: east }, 'sun', T0, T0 + 30 * DAY_MS)
    expect(ridged[0].start).toBeGreaterThan(flat[0].start) // sunrise in the east is delayed
    expect(Math.abs(ridged[0].end - flat[0].end)).toBeLessThan(2000) // sunset in the west is not
  })
})

describe('skyAt', () => {
  it('agrees with the up/down state from nextEvent', () => {
    const site = { lat: 20, lon: 30 }
    const s = skyAt(site, new Date(T0))
    expect(nextEvent(site, 'sun', T0).up).toBe(s.sunUp)
    expect(nextEvent(site, 'earth', T0).up).toBe(s.earthUp)
  })
})

describe('compareSites', () => {
  it('has sun-and-Earth windows inside both the Sun and Earth windows', () => {
    const end = T0 + 60 * DAY_MS
    const [r] = compareSites([{ lat: 20, lon: 30 }], T0, end)
    expect(r.sunAndEarthVisible.fractionUp).toBeLessThanOrEqual(Math.min(r.sun.fractionUp, r.earth.fractionUp) + 1e-9)
    expect(r.sunAndEarthVisible.fractionUp).toBeGreaterThan(0)
    expect(intersect(r.sun.intervals, r.sunAndEarthVisible.intervals)).toEqual(r.sunAndEarthVisible.intervals)
  })
  it('ranks two sites with a sensible south pole result', () => {
    const [near, pole] = compareSites([{ lat: 0, lon: 0 }, { lat: -89.5, lon: 0 }], T0, T0 + 400 * DAY_MS, { stepMs: 3_600_000 })
    expect(near.sun.windows).toBeGreaterThan(pole.sun.windows) // counts of sunlit windows
  })
})

describe('intersect', () => {
  it('handles overlap, containment, and disjoint lists', () => {
    expect(intersect([{ start: 0, end: 10 }], [{ start: 5, end: 15 }])).toEqual([{ start: 5, end: 10 }])
    expect(intersect([{ start: 0, end: 10 }], [{ start: 2, end: 4 }, { start: 6, end: 8 }])).toEqual([{ start: 2, end: 4 }, { start: 6, end: 8 }])
    expect(intersect([{ start: 0, end: 1 }], [{ start: 2, end: 3 }])).toEqual([])
  })
})

describe('panelFactor', () => {
  it('matches simple trigonometry', () => {
    expect(panelFactor(30)).toBeCloseTo(0.5, 9)
    expect(panelFactor(30, 90)).toBeCloseTo(Math.cos((30 * Math.PI) / 180), 9)
    expect(panelFactor(-5)).toBe(0)
    expect(panelFactor(90)).toBeCloseTo(1, 9)
  })
})

describe('sceneState', () => {
  it('returns a unit Sun direction and proper rotation matrices', () => {
    const s = sceneState(new Date(T0))
    expect(Math.hypot(...s.sunDirection)).toBeCloseTo(1, 9)
    for (const R of [s.moonRotation, s.earthRotation]) {
      const det =
        R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) -
        R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) +
        R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0])
      expect(det).toBeCloseTo(1, 9)
    }
    expect(Math.hypot(...s.moonPosition)).toBeGreaterThan(350)
    expect(Math.hypot(...s.moonPosition)).toBeLessThan(410)
  })
})
