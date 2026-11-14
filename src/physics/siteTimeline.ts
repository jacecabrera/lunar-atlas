import { siteSky } from './siteSky'
import type { Horizon } from './horizon'

export type Target = 'sun' | 'earth'
export type SkyEvent = { t: number; kind: 'rise' | 'set'; target: Target }
export type Interval = { start: number; end: number }

// maskDeg: minimum elevation the disc must clear (0 = geometric horizon).
// horizon: optional terrain skyline; the effective mask at an azimuth is max(maskDeg, horizon(az)).
// A body counts as "up" while any part of its disc is above that mask.
export type VisibilityOptions = { maskDeg?: number; horizon?: Horizon }

export const MINUTE = 60_000
export const DAY_MS = 86_400_000
const DEFAULT_STEP = 30 * MINUTE

// Positive while any part of the disc is above the flat horizon.
// No atmosphere, so sunset is the upper limb touching the horizon.
export function margin(
  lat: number, lon: number, target: Target, tMs: number, opts: VisibilityOptions = {},
) {
  const b = siteSky(lat, lon, new Date(tMs))[target]
  const mask = Math.max(opts.maskDeg ?? 0, opts.horizon ? opts.horizon(b.azimuth) : -Infinity)
  return b.elevation + b.angularRadius - mask
}

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