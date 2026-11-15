import { describe, expect, it } from 'vitest'
import { findEvents, upIntervals, summarize, statusAt, DAY_MS } from './siteTimeline'
import { siteSky } from './siteSky'

const T0 = Date.UTC(2026, 10, 13)
const day = (ms: number) => (ms / DAY_MS).toFixed(2)

describe('equatorial near-side site (0, 0)', () => {
  it('is in sunlight about half the time over two lunar days', () => {
    const end = T0 + 59.06 * DAY_MS
    const s = summarize(upIntervals(0, 0, 'sun', T0, end), T0, end)
    expect(s.fractionUp).toBeGreaterThan(0.48)
    expect(s.fractionUp).toBeLessThan(0.53)
  })

  it('alternates sunrise and sunset', () => {
    const ev = findEvents(0, 0, 'sun', T0, T0 + 70 * DAY_MS)
    expect(ev.length).toBeGreaterThanOrEqual(4)
    ev.forEach((e, i) => { if (i > 0) expect(e.kind).not.toBe(ev[i - 1].kind) })
  })

  it('has a lunar day of roughly half a synodic month', () => {
    const ev = findEvents(0, 0, 'sun', T0, T0 + 70 * DAY_MS)
    const rise = ev.find((e) => e.kind === 'rise')!
    const set = ev.find((e) => e.kind === 'set' && e.t > rise.t)!
    const days = (set.t - rise.t) / DAY_MS
    expect(days).toBeGreaterThan(14)
    expect(days).toBeLessThan(15.6)
  })

  it('puts every event time at the horizon', () => {
    const ev = findEvents(0, 0, 'sun', T0, T0 + 35 * DAY_MS)
    expect(ev.length).toBeGreaterThan(0)
    for (const e of ev) {
      const b = siteSky(0, 0, new Date(e.t)).sun
      expect(Math.abs(b.elevation + b.angularRadius)).toBeLessThan(0.001)
    }
  })

  it('reports a time to the next event that flips the state', () => {
    const s = statusAt(0, 0, 'sun', T0)
    expect(s.ms).not.toBeNull()
    const after = siteSky(0, 0, new Date(T0 + s.ms! + 60_000)).sun
    expect(after.elevation + after.angularRadius > 0).toBe(!s.up)
  })
})

describe('Earth visibility', () => {
  it('is permanent at the sub-Earth point and never on the far side', () => {
    const end = T0 + 30 * DAY_MS
    expect(upIntervals(0, 0, 'earth', T0, end)).toEqual([{ start: T0, end }])
    expect(upIntervals(0, 180, 'earth', T0, end)).toEqual([])
  })
})

describe('near the south pole', () => {
  it('prints a year of Sun and Earth windows at (-89.5, 0)', () => {
    const end = T0 + 400 * DAY_MS
    for (const target of ['sun', 'earth'] as const) {
      const iv = upIntervals(-89.5, 0, target, T0, end, 60 * 60_000)
      const s = summarize(iv, T0, end)
      console.log(
        target, 'windows', s.windows,
        'fractionUp', s.fractionUp.toFixed(3),
        'longestUp(d)', day(s.longestUpMs),
        'longestDown(d)', day(s.longestDownMs),
      )
    }
  })
})