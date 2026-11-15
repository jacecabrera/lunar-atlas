import { siteSky } from './siteSky'
import type { SkyBody } from './siteSky'
import type { Horizon } from './horizon'
import { discTopMarginDeg } from './discVisibility'

export type Target = 'sun' | 'earth'
export type SkyEvent = { t: number; kind: 'rise' | 'set'; target: Target }
export type Interval = { start: number; end: number }

// Low-level visibility rules (step 09). The formal entry with quality gates, disc fractions and Earth occultation of
// the Sun is sim/visibility.ts; these functions are for labelled previews and tests.
//   sun:   up while some of the disc (positive area) is above the skyline. The skyline is horizon(az) as given, negative
//          values included; without a horizon it is the flat 0 deg plane. maskDeg, only when given, raises it to
//          max(maskDeg, horizon(az)). No default minimum elevation.
//   earth: up while the disc CENTRE is strictly above max(horizon(az), maskDeg ?? 0): default minimum elevation 0 deg.
// observerRadiusKm: observer distance from the Moon's centre (default 1737.4 km), the same value used by the horizon.
// Lunar eclipses (Earth hiding the Sun) are not applied here.
export type VisibilityOptions = { maskDeg?: number; horizon?: Horizon; observerRadiusKm?: number }

export const MINUTE = 60_000
export const DAY_MS = 86_400_000
const DEFAULT_STEP = 30 * MINUTE

/**
 * Signed visibility margin of a body already placed in the sky, deg: > 0 exactly when the body counts as up.
 * Sun: largest height of the disc's upper edge above the skyline across the disc. Earth: centre minus the mask.
 */
export function bodyMargin(target: Target, b: SkyBody, opts: VisibilityOptions = {}): number {
  const h = opts.horizon
  if (target === 'earth') return b.elevation - Math.max(h ? h(b.azimuth) : -Infinity, opts.maskDeg ?? 0)
  const base = (az: number) => (h ? h(az) : opts.maskDeg !== undefined ? -Infinity : 0)
  const skyline = opts.maskDeg === undefined ? base : (az: number) => Math.max(base(az), opts.maskDeg!)
  if (!h) return b.elevation + b.angularRadius - skyline(b.azimuth) // flat skyline: the top of the disc decides
  return discTopMarginDeg({ azimuthDeg: b.azimuth, elevationDeg: b.elevation, radiusDeg: b.angularRadius }, skyline)
}

// No atmosphere, so no refraction: sunset is the last of the disc going below the skyline.
export function margin(
  lat: number, lon: number, target: Target, tMs: number, opts: VisibilityOptions = {},
) {
  return bodyMargin(target, siteSky(lat, lon, new Date(tMs), opts.observerRadiusKm)[target], opts)
}

// Preview scan: 30-minute steps with bisection to ~1 s. A pair of events inside one step can be missed; the formal
// search with a rate-bound guarantee is searchEvents() in sim/events.ts.
export function findEvents(
  lat: number, lon: number, target: Target,
  startMs: number, endMs: number,
  stepMs = DEFAULT_STEP, maxEvents = Infinity, opts: VisibilityOptions = {},
): SkyEvent[] {
  if (stepMs <= 0) throw new Error('stepMs must be positive')
  const out: SkyEvent[] = []
  let t0 = startMs
  let f0 = margin(lat, lon, target, t0, opts)
  while (t0 < endMs && out.length < maxEvents) {
    const t1 = Math.min(t0 + stepMs, endMs)
    const f1 = margin(lat, lon, target, t1, opts)
    if ((f0 > 0) !== (f1 > 0)) {
      let a = t0
      let b = t1
      const upAtA = f0 > 0
      while (b - a > 1000) {
        const m = (a + b) / 2
        if ((margin(lat, lon, target, m, opts) > 0) === upAtA) a = m
        else b = m
      }
      out.push({ t: (a + b) / 2, kind: f1 > 0 ? 'rise' : 'set', target })
    }
    t0 = t1
    f0 = f1
  }
  return out
}

// Intervals during which the body is up, clipped to [startMs, endMs]
export function upIntervals(
  lat: number, lon: number, target: Target,
  startMs: number, endMs: number, stepMs = DEFAULT_STEP, opts: VisibilityOptions = {},
): Interval[] {
  const events = findEvents(lat, lon, target, startMs, endMs, stepMs, Infinity, opts)
  const out: Interval[] = []
  let start: number | null = margin(lat, lon, target, startMs, opts) > 0 ? startMs : null
  for (const e of events) {
    if (e.kind === 'rise') start = e.t
    else if (start !== null) {
      out.push({ start, end: e.t })
      start = null
    }
  }
  if (start !== null) out.push({ start, end: endMs })
  return out
}

const complement = (iv: Interval[], s: number, e: number): Interval[] => {
  const out: Interval[] = []
  let cur = s
  for (const i of iv) {
    if (i.start > cur) out.push({ start: cur, end: i.start })
    cur = i.end
  }
  if (cur < e) out.push({ start: cur, end: e })
  return out
}
const longest = (iv: Interval[]) => iv.reduce((m, i) => Math.max(m, i.end - i.start), 0)

// Longest values are clipped at the window edges, so use a window longer than one cycle.
export function summarize(iv: Interval[], startMs: number, endMs: number) {
  const up = iv.reduce((sum, i) => sum + (i.end - i.start), 0)
  return {
    fractionUp: up / (endMs - startMs),
    longestUpMs: longest(iv),
    longestDownMs: longest(complement(iv, startMs, endMs)),
    windows: iv.length,
  }
}

// "Time remaining before sunset / Earthset" (or until the next rise, if it is down now)
export function statusAt(
  lat: number, lon: number, target: Target, tMs: number,
  searchMs = 60 * DAY_MS, opts: VisibilityOptions = {},
) {
  const up = margin(lat, lon, target, tMs, opts) > 0
  const next = findEvents(lat, lon, target, tMs, tMs + searchMs, DEFAULT_STEP, 1, opts)[0] ?? null
  return { up, next, ms: next ? next.t - tMs : null }
}

// Times when both interval lists are active, e.g. Sun up AND Earth visible
export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start)
    const end = Math.min(a[i].end, b[j].end)
    if (start < end) out.push({ start, end })
    if (a[i].end < b[j].end) i++
    else j++
  }
  return out
}
