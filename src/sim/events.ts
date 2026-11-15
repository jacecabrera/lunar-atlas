// Event search, next-set queries and mission statistics on top of the formal visibility model (step 09).
// No visibility rule is re-implemented here: every state comes from VisibilityModel.sunAt / earthAt.
//
// Discovery vs location.
//   Discovery: the range is cut into scan steps; an interval whose two end states agree is accepted as event-free only
//   when a rate bound proves that no margin can change sign inside it: |m(a)| + |m(b)| > L * (b - a), where L bounds
//   |dm/dt| (sky motion of the body times (1 + skyline slope / cos(elevation)), see RATE_BOUNDS). Otherwise the interval
//   is halved, down to `minResolveMs`. An interval that is still not proven at that length is reported as unresolved:
//   a window or gap shorter than `minResolveMs` cannot be excluded there. Windows and gaps longer than `minResolveMs`
//   are never missed, provided the rate bounds hold (they are checked against the ephemeris in the tests).
//   Location: intervals with different end states are halved down to `locateToleranceMs`; the event is placed at the
//   middle, +/- half that interval. This is numerical location only: terrain, frame and ephemeris errors are separate.
//   Unknown states (null) are never counted as visible or dark; a range whose two ends are unknown is reported unknown
//   as a whole. A computation budget caps the evaluations; when it runs out, the rest of the range is reported as not
//   searched instead of event-free.
import type { VisibilityModel, SunVisibility, EarthVisibility } from './visibility'
import type { Interval } from '../physics/siteTimeline'
import { intersect } from '../physics/siteTimeline'
import type { ConditionReason, Quantity } from './assessment'

export const EVENTS_MODEL = 'events-v2:derived-rate-bounds(sun0.60,earth0.15deg/h)+certified-scan(30min)+halving(min 10s)+location(1s);time-weighted-simpson'

/** sun = effective sunlight (terrain and Earth); sun-terrain = terrain geometry only; earth = Earth centre visibility. */
export type Channel = 'sun' | 'sun-terrain' | 'earth'
export type TriState = boolean | null

/**
 * Upper bounds on how fast the model's sky changes (ASM-SKY-RATE-BOUNDS), derived from the equations the model uses,
 * not from sampled maxima (the samples in events.test.ts are only a consistency check):
 *  - Sun direction in the Moon-fixed frame: |omega_frame| + |omega_sun,inertial|. Frame: IAU 2009 W rate
 *    13.17635815 deg/day plus the derivatives of its periodic terms (sum of A_i * dE_i/dt <= 0.03 deg/day) and of the
 *    pole terms (< 0.01 deg/day): <= 13.22 deg/day = 0.551 deg/h. Sun inertial: Earth's orbital rate at perihelion
 *    1.0194 deg/day = 0.0425 deg/h, plus the Moon's geocentric velocity (<= 1.1 km/s) over 1.47e8 km = 0.0015 deg/h.
 *    Total 0.595 deg/h; 0.60 is used.
 *  - Earth direction: the geocentric Moon direction rotates at most 15.5 deg/day (eccentricity <= 0.078), the frame at
 *    13.13-13.22 deg/day, about axes at most 7 deg apart: |difference| <= 2.9 deg/day = 0.121 deg/h; topocentric
 *    factor (384,400 / 354,000) and the radial-velocity term add < 0.012 deg/h. 0.15 is used.
 *  - Angular radii: Sun < 2e-5 deg/h (annual and monthly distance change), Earth < 1e-3 deg/h (radial velocity
 *    <= 0.08 km/s at 354,000 km).
 * No extra safety factor is applied; every term above is explicit.
 */
export const RATE_BOUNDS = { sunDegPerHour: 0.6, earthDegPerHour: 0.15, sunRadiusDegPerHour: 2e-5, earthRadiusDegPerHour: 1e-3 } as const

export type EventSearchOptions = {
  /** Initial scan step (default 30 min). */
  scanStepMs?: number
  /** Shortest interval that is still halved during discovery (default 10 s). */
  minResolveMs?: number
  /** Location tolerance: an event is placed within +/- half of this (default 1 s). */
  locateToleranceMs?: number
  /** Maximum number of visibility evaluations (default 400,000). */
  maxEvaluations?: number
}
const DEFAULTS = { scanStepMs: 30 * 60_000, minResolveMs: 10_000, locateToleranceMs: 1000, maxEvaluations: 400_000 }

export type EventCause = 'terrain' | 'earth' | 'min-elevation' | 'data'
export type VisibilityEvent = {
  tMs: number
  /** Half-width of the location interval, ms. */
  toleranceMs: number
  /** rise: not visible -> visible; set: visible -> not visible; unknown-start / unknown-end: entering / leaving unknown. */
  kind: 'rise' | 'set' | 'unknown-start' | 'unknown-end'
  channel: Channel
  /** What changed: terrain (skyline), earth (eclipse), min-elevation (Earth minimum), data (unknown state). */
  cause: EventCause
}
export type StateSegment = { start: number; end: number; state: TriState }

export type EventSearchResult = {
  channel: Channel
  startMs: number
  endMs: number
  /** Consecutive, non-overlapping, covering [startMs, searchedToMs]; zero-length segments are dropped. */
  segments: StateSegment[]
  events: VisibilityEvent[]
  /** Intervals (each <= minResolveMs) where a shorter window or gap cannot be excluded. */
  unresolved: Interval[]
  /** 'complete': the whole range was searched. 'budget-exhausted': only up to searchedToMs. */
  status: 'complete' | 'budget-exhausted'
  searchedToMs: number
  evaluations: number
  settings: Required<EventSearchOptions>
}

type Sample = { t: number; state: TriState; el: number; az: number; v: SunVisibility | EarthVisibility }

const DEG_PER_MS = (degPerHour: number) => degPerHour / 3_600_000

function sampler(model: VisibilityModel, channel: Channel) {
  return (t: number): Sample => {
    if (channel === 'earth') { const e = model.earthAt(t); return { t, state: e.visible, el: e.geometry.elevationDeg, az: e.geometry.azimuthDeg, v: e } }
    const s = model.sunAt(t)
    return { t, state: channel === 'sun' ? s.sunlit : s.terrainVisible, el: s.geometry.elevationDeg, az: s.geometry.azimuthDeg, v: s }
  }
}

const noSignChange = (ma: number | null, mb: number | null, bound: number) =>
  ma !== null && mb !== null && ma !== 0 && mb !== 0 && Math.sign(ma) === Math.sign(mb) && Math.abs(ma) + Math.abs(mb) > bound

/**
 * True when the rate bounds prove that the state cannot change inside [a, b].
 * Margins used (each must keep its sign): Earth: centre elevation - max(skyline(az), minimum). Sun (terrain): exact top
 * margin max_x(el + sqrt(rho^2 - x^2) - h(az + x / cos el)). Their time derivatives are bounded by
 *   |d el/dt| + S |d az'/dt| + |d rho/dt| (1 + S / cos el),   az' = az + x / cos el,
 *   |d az'/dt| <= (omega + |x| tan(el) omega) / cos el     (x in radians, |x| <= rho),
 * with omega the body's sky-rate bound, S the largest skyline slope and el bounded over the interval. The eclipse
 * contact functions (separation - rho_sun - rho_earth, separation + rho_sun - rho_earth) change at most by
 * omega_sun + omega_earth + both radius rates. Visible fractions are never differentiated: states change only when
 * one of these margins changes sign (or, for terrain and Earth together, when the disc straddles the skyline during
 * contact, which is never certified and is resolved by halving).
 */
function certified(model: VisibilityModel, channel: Channel, a: Sample, b: Sample): boolean {
  if (a.state === null || b.state === null || a.state !== b.state) return false
  const dt = b.t - a.t
  const S = model.skylineMaxSlope ?? 0
  const sun = channel !== 'earth'
  const omega = DEG_PER_MS(sun ? RATE_BOUNDS.sunDegPerHour : RATE_BOUNDS.earthDegPerHour)
  const rhoRate = DEG_PER_MS(sun ? RATE_BOUNDS.sunRadiusDegPerHour : 0)
  const elMax = Math.min(89.9, Math.max(Math.abs(a.el), Math.abs(b.el)) + omega * dt)
  const cosEl = Math.cos((elMax * Math.PI) / 180)
  const rhoDeg = sun ? Math.max((a.v as SunVisibility).geometry.angularRadiusDeg, (b.v as SunVisibility).geometry.angularRadiusDeg) : 0
  const rhoRad = (rhoDeg * Math.PI) / 180
  const L = omega * (1 + (S * (1 + rhoRad * Math.tan((elMax * Math.PI) / 180))) / cosEl) + rhoRate * (1 + S / cosEl)
  // A visible body must not enter an azimuth range over a lower-bound skyline sample (it would become unknown).
  // Unwrapped azimuths: when the body crosses north the min/max span is wide, which is conservative.
  const pad = (rhoDeg + omega * dt) / cosEl + 0.5
  if (a.state && model.lowerBoundInAzimuths(Math.min(a.az, b.az) - pad, Math.max(a.az, b.az) + pad)) return false
  if (channel === 'earth') return noSignChange((a.v as EarthVisibility).marginDeg, (b.v as EarthVisibility).marginDeg, L * dt)
  const sa = a.v as SunVisibility, sb = b.v as SunVisibility
  if (!noSignChange(sa.terrainMarginDeg, sb.terrainMarginDeg, L * dt)) return false
  if (channel === 'sun-terrain') return true
  // Effective sunlight also changes with the Earth: either the Earth never touches the Sun in [a, b], or full cover does
  // not change and the disc stays wholly above the terrain (so terrain and Earth cannot combine to hide it).
  const Lrel = DEG_PER_MS(RATE_BOUNDS.sunDegPerHour + RATE_BOUNDS.earthDegPerHour + RATE_BOUNDS.sunRadiusDegPerHour + RATE_BOUNDS.earthRadiusDegPerHour)
  const rs = (x: SunVisibility) => x.geometry.angularRadiusDeg
  // contact > 0: the discs do not touch; full > 0: the Sun is not wholly behind the Earth.
  const contactA = sa.earthSeparationDeg - rs(sa) - earthRadiusOf(model, sa), contactB = sb.earthSeparationDeg - rs(sb) - earthRadiusOf(model, sb)
  if (noSignChange(contactA, contactB, Lrel * dt) && contactA > 0) return true
  const fullA = sa.earthSeparationDeg + rs(sa) - earthRadiusOf(model, sa), fullB = sb.earthSeparationDeg + rs(sb) - earthRadiusOf(model, sb)
  return noSignChange(fullA, fullB, Lrel * dt) && noSignChange(sa.terrainClearanceDeg, sb.terrainClearanceDeg, L * dt) && (sa.terrainClearanceDeg ?? -1) > 0
}

// The Earth's angular radius at the instant of a Sun sample (the Earth query is cheap and uses the same geometry).
const earthRadiusCache = new WeakMap<SunVisibility, number>()
function earthRadiusOf(model: VisibilityModel, s: SunVisibility): number {
  let r = earthRadiusCache.get(s)
  if (r === undefined) { r = model.earthAt(s.tMs).geometry.angularRadiusDeg; earthRadiusCache.set(s, r) }
  return r
}

function causeOf(channel: Channel, before: Sample, after: Sample): EventCause {
  if (before.state === null || after.state === null) return 'data'
  if (channel === 'earth') {
    const e = (before.state ? after : before).v as EarthVisibility
    return e.skylineDeg !== null && e.skylineDeg >= e.minElevationDeg ? 'terrain' : 'min-elevation'
  }
  if (channel === 'sun-terrain') return 'terrain'
  const hidden = (before.state ? after : before).v as SunVisibility
  return hidden.terrainVisible === true && hidden.sunlit === false ? 'earth' : 'terrain'
}

/** Search one channel over [startMs, endMs]. */
export function searchEvents(model: VisibilityModel, channel: Channel, startMs: number, endMs: number, opts: EventSearchOptions = {}): EventSearchResult {
  const settings = { ...DEFAULTS, ...opts }
  if (!(endMs > startMs) || !Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new RangeError('Search range must be finite with end > start')
  if (!(settings.scanStepMs > 0) || !(settings.minResolveMs > 0) || !(settings.locateToleranceMs > 0)) throw new RangeError('Search steps must be positive')
  const at = sampler(model, channel)
  let evaluations = 0
  const sample = (t: number) => { evaluations++; return at(t) }
  const events: VisibilityEvent[] = []
  const unresolved: Interval[] = []
  const pieces: StateSegment[] = []
  let exhausted = false

  const process = (a: Sample, b: Sample) => {
    const stack: Array<[Sample, Sample]> = [[a, b]]
    while (stack.length) {
      const [x, y] = stack.pop()!
      const dt = y.t - x.t
      if (x.state === y.state) {
        if (x.state === null) { pieces.push({ start: x.t, end: y.t, state: null }); continue }
        if (certified(model, channel, x, y)) { pieces.push({ start: x.t, end: y.t, state: x.state }); continue }
        if (dt <= settings.minResolveMs) { unresolved.push({ start: x.t, end: y.t }); pieces.push({ start: x.t, end: y.t, state: x.state }); continue }
      } else if (dt <= settings.locateToleranceMs) {
        const tm = (x.t + y.t) / 2
        const kind = x.state === null ? 'unknown-end' : y.state === null ? 'unknown-start' : y.state ? 'rise' : 'set'
        events.push({ tMs: tm, toleranceMs: dt / 2, kind, channel, cause: causeOf(channel, x, y) })
        pieces.push({ start: x.t, end: tm, state: x.state }, { start: tm, end: y.t, state: y.state })
        continue
      }
      if (evaluations >= settings.maxEvaluations) { exhausted = true; stack.push([x, y]); return stack.map(([p]) => p.t).reduce((m, v) => Math.min(m, v), Infinity) }
      const m = sample((x.t + y.t) / 2)
      stack.push([m, y], [x, m]) // left half processed first, keeping pieces in time order
    }
    return null
  }

  let searchedTo = startMs
  let left = sample(startMs)
  for (let t = startMs; t < endMs && !exhausted;) {
    if (evaluations >= settings.maxEvaluations) { exhausted = true; searchedTo = t; break }
    const t1 = Math.min(t + settings.scanStepMs, endMs)
    const right = sample(t1)
    const stoppedAt = process(left, right)
    if (stoppedAt !== null) { searchedTo = stoppedAt; break }
    searchedTo = t1
    left = right
    t = t1
  }
  pieces.sort((p, q) => p.start - q.start)
  const segments: StateSegment[] = []
  for (const p of pieces) {
    if (p.end <= p.start || p.start >= searchedTo) continue
    const last = segments[segments.length - 1]
    if (last && last.state === p.state && Math.abs(last.end - p.start) < 1e-6) last.end = p.end
    else segments.push({ ...p })
  }
  events.sort((p, q) => p.tMs - q.tMs)
  return { channel, startMs, endMs, segments, events, unresolved, status: exhausted ? 'budget-exhausted' : 'complete', searchedToMs: searchedTo, evaluations, settings }
}

// ─── Next set ──────────────────────────────────────────────────────────────

export type NextSetQuery = {
  target: 'sun' | 'earth'
  /** For the Sun: 'sun' (effective sunlight; an eclipse start counts, with cause 'earth') or 'sun-terrain' (sunset only). */
  channel?: Channel
  queryMs: number
  /** Search length after the query instant (default 60 days). Independent of the mission window. */
  searchMs?: number
}

/**
 * The next visible -> not-visible transition in [queryMs, queryMs + searchMs]. When the body is not visible at the
 * query instant, this is the set after the next rise. A set exactly at the query instant is not returned (the body is
 * already not visible then). Not found is not zero: eventMs and msUntil are null unless status is 'found'.
 */
export type NextSet = {
  target: 'sun' | 'earth'
  channel: Channel
  queryMs: number
  searchStartMs: number
  searchEndMs: number
  /** Searched up to here (less than searchEndMs only when the budget ran out). */
  searchedToMs: number
  status: 'found' | 'not-found' | 'unknown' | 'incomplete'
  eventMs: number | null
  msUntil: number | null
  toleranceMs: number | null
  cause: EventCause | null
  /** Duration of unresolved intervals before the event (or in the whole range when not found), ms. */
  unresolvedMs: number
  reasons: ConditionReason[]
}

export function nextSet(model: VisibilityModel, q: NextSetQuery, opts: EventSearchOptions = {}): NextSet {
  const channel = q.channel ?? (q.target === 'earth' ? 'earth' : 'sun')
  if (q.target === 'earth' && channel !== 'earth') throw new RangeError('The Earth uses the earth channel')
  const searchMs = q.searchMs ?? 60 * 86_400_000
  const r = searchEvents(model, channel, q.queryMs, q.queryMs + searchMs, opts)
  const base = { target: q.target, channel, queryMs: q.queryMs, searchStartMs: q.queryMs, searchEndMs: q.queryMs + searchMs, searchedToMs: r.searchedToMs }
  const set = r.events.find((e) => e.kind === 'set')
  const firstUnknown = r.segments.find((s) => s.state === null)
  const unresolvedBefore = (t: number) => r.unresolved.filter((u) => u.start < t).reduce((s, u) => s + Math.min(u.end, t) - u.start, 0)
  if (set && (!firstUnknown || set.tMs < firstUnknown.start)) {
    const reasons: ConditionReason[] = unresolvedBefore(set.tMs) > 0 ? [{ code: 'short-windows-unresolved', message: `An earlier set in a window shorter than ${r.settings.minResolveMs / 1000} s cannot be excluded` }] : []
    return { ...base, status: 'found', eventMs: set.tMs, msUntil: set.tMs - q.queryMs, toleranceMs: set.toleranceMs, cause: set.cause, unresolvedMs: unresolvedBefore(set.tMs), reasons }
  }
  const empty = { eventMs: null, msUntil: null, toleranceMs: null, cause: null }
  if (firstUnknown) {
    return { ...base, ...empty, status: 'unknown', unresolvedMs: unresolvedBefore(firstUnknown.start), reasons: [{ code: 'state-unknown', message: `Visibility is unknown from ${new Date(firstUnknown.start).toISOString()}; a set there cannot be excluded` }, ...model.reasons] }
  }
  if (r.status === 'budget-exhausted') {
    return { ...base, ...empty, status: 'incomplete', unresolvedMs: unresolvedBefore(r.searchedToMs), reasons: [{ code: 'search-budget-exhausted', message: `Searched only to ${new Date(r.searchedToMs).toISOString()}` }] }
  }
  const unresolvedMs = unresolvedBefore(r.endMs)
  if (unresolvedMs > 0) {
    return { ...base, ...empty, status: 'incomplete', unresolvedMs, reasons: [{ code: 'short-windows-unresolved', message: `No set found, but windows shorter than ${r.settings.minResolveMs / 1000} s cannot be excluded in ${Math.round(unresolvedMs / 1000)} s of the range` }] }
  }
  return { ...base, ...empty, status: 'not-found', unresolvedMs: 0, reasons: [{ code: 'no-set-in-range', message: 'No set in the searched range' }] }
}

// ─── Mission statistics ────────────────────────────────────────────────────

/** Sum of lengths. */
const total = (iv: Interval[]) => iv.reduce((s, i) => s + (i.end - i.start), 0)
const longest = (iv: Interval[]) => iv.reduce((m, i) => Math.max(m, i.end - i.start), 0)
const where = (segs: StateSegment[], state: TriState): Interval[] => segs.filter((s) => s.state === state).map((s) => ({ start: s.start, end: s.end }))

export type SunElevationPoint = { tMs: number; elevationDeg: number; visibleFraction: number | null; sunlit: TriState }

export type MissionStatistics = {
  window: { startMs: number; endMs: number }
  /** complete: every instant known and searched, no unresolved intervals. bounded: known, but unresolved intervals
   * leave an uncertainty of up to `resolutionUncertaintyMs`. incomplete: unknown or unsearched time; full-mission
   * values are null and only `partial` is given. */
  status: 'complete' | 'bounded' | 'incomplete'
  /** Per body: Sun values are given when the Sun is determined even if the Earth is not, and vice versa. */
  sunStatus: 'complete' | 'bounded' | 'incomplete'
  earthStatus: 'complete' | 'bounded' | 'incomplete'
  reasons: ConditionReason[]
  sun: EventSearchResult
  sunTerrain: EventSearchResult
  earth: EventSearchResult
  sunIntervals: Interval[]
  earthIntervals: Interval[]
  sunAndEarthIntervals: Interval[]
  sunlitDuration: Quantity
  sunlitFraction: Quantity
  /** Terrain-geometric Sun visibility (ignores eclipses), for comparison. */
  terrainSunDuration: Quantity
  eclipseDuration: Quantity
  longestDarkness: Quantity
  earthVisibleDuration: Quantity
  earthVisibleFraction: Quantity
  longestEarthVisible: Quantity
  longestEarthGap: Quantity
  sunAndEarthFraction: Quantity
  sunElevationMean: Quantity
  sunElevationPeak: Quantity
  resolutionUncertaintyMs: number
  /** Known parts only, when status is 'incomplete'. Clearly partial: unknown time is not dark and not visible. */
  partial: { knownSunlitMs: number; knownDarkMs: number; knownEarthVisibleMs: number; knownEarthHiddenMs: number; unknownSunMs: number; unknownEarthMs: number } | null
  /** Sun centre elevation and visible fraction at a fixed step, for display. */
  sunSeries: SunElevationPoint[]
  model: string
}

const ms = (v: number | null, reason = 'Not determined'): Quantity => (v === null ? { value: null, unit: 'ms', reason } : { value: v, unit: 'ms' })
const frac = (v: number | null, reason = 'Not determined'): Quantity => (v === null ? { value: null, unit: '1', reason } : { value: v, unit: '1' })
const deg = (v: number | null, reason: string): Quantity => (v === null ? { value: null, unit: 'deg', reason } : { value: v, unit: 'deg' })

/** Time-weighted mean and peak of the Sun centre elevation over intervals (composite Simpson, <= 15 min panels). */
function elevationStats(model: VisibilityModel, iv: Interval[]): { mean: number | null; peak: number | null } {
  let integral = 0, time = 0, peak = -Infinity
  for (const i of iv) {
    const len = i.end - i.start
    if (len <= 0) continue
    const n = Math.max(2, 2 * Math.ceil(len / (30 * 60_000))) // even number of panels, each <= 15 min
    const h = len / n
    let s = 0
    for (let k = 0; k <= n; k++) {
      const e = model.sunAt(i.start + k * h).geometry.elevationDeg
      peak = Math.max(peak, e)
      s += e * (k === 0 || k === n ? 1 : k % 2 ? 4 : 2)
    }
    integral += (s * h) / 3
    time += len
  }
  // Refine the peak with a golden-section search around the best panel of each interval.
  for (const i of iv) {
    let a = i.start, b = i.end
    for (let k = 0; k < 40 && b - a > 1000; k++) {
      const c = b - (b - a) * 0.618, d = a + (b - a) * 0.618
      if (model.sunAt(c).geometry.elevationDeg > model.sunAt(d).geometry.elevationDeg) b = d
      else a = c
    }
    peak = Math.max(peak, model.sunAt((a + b) / 2).geometry.elevationDeg)
  }
  return { mean: time > 0 ? integral / time : null, peak: time > 0 ? peak : null }
}

export function missionStatistics(
  model: VisibilityModel, window: { startMs: number; endMs: number },
  opts: EventSearchOptions & { seriesStepMs?: number } = {},
): MissionStatistics {
  const { startMs, endMs } = window
  if (!(endMs > startMs)) throw new RangeError('Mission window must have end > start')
  const span = endMs - startMs
  const sun = searchEvents(model, 'sun', startMs, endMs, opts)
  const sunTerrain = searchEvents(model, 'sun-terrain', startMs, endMs, opts)
  const earth = searchEvents(model, 'earth', startMs, endMs, opts)
  const unsearched = (r: EventSearchResult) => endMs - r.searchedToMs
  const sunUnknown = total(where(sun.segments, null)) + unsearched(sun)
  const earthUnknown = total(where(earth.segments, null)) + unsearched(earth)
  const sunIntervals = where(sun.segments, true), earthIntervals = where(earth.segments, true)
  const sunAndEarthIntervals = intersect(sunIntervals, earthIntervals)
  const resolutionUncertaintyMs = total(sun.unresolved) + total(earth.unresolved)
  const reasons: ConditionReason[] = []
  if (sunUnknown > 0) reasons.push({ code: 'sun-state-unknown', message: `Sun state unknown for ${Math.round(sunUnknown / 60_000)} min of the mission` })
  if (earthUnknown > 0) reasons.push({ code: 'earth-state-unknown', message: `Earth state unknown for ${Math.round(earthUnknown / 60_000)} min of the mission` })
  if (sun.status === 'budget-exhausted' || earth.status === 'budget-exhausted') reasons.push({ code: 'search-budget-exhausted', message: 'The event search ran out of evaluations' })
  if (resolutionUncertaintyMs > 0) reasons.push({ code: 'short-windows-unresolved', message: `Windows shorter than ${sun.settings.minResolveMs / 1000} s cannot be excluded in ${Math.round(resolutionUncertaintyMs / 1000)} s of the mission` })
  reasons.push(...model.reasons)
  const bodyStatus = (unknown: number, unres: number) => (unknown > 0 ? 'incomplete' : unres > 0 ? 'bounded' : 'complete') as MissionStatistics['status']
  const sunStatus = bodyStatus(sunUnknown, total(sun.unresolved))
  const earthStatus = bodyStatus(earthUnknown, total(earth.unresolved))
  const rank = { complete: 0, bounded: 1, incomplete: 2 } as const
  const status = rank[sunStatus] >= rank[earthStatus] ? sunStatus : earthStatus

  const seriesStep = opts.seriesStepMs ?? Math.max(60 * 60_000, Math.ceil(span / 2000))
  const sunSeries: SunElevationPoint[] = []
  for (let t = startMs; t <= endMs; t += seriesStep) { const x = model.sunAt(t); sunSeries.push({ tMs: t, elevationDeg: x.geometry.elevationDeg, visibleFraction: x.visibleFraction, sunlit: x.sunlit }) }

  const why = 'Unknown or unsearched time in the mission window'
  const sunKnown = sunStatus !== 'incomplete', earthKnown = earthStatus !== 'incomplete'
  const terrainUnknown = sunTerrain.segments.some((x) => x.state === null) || sunTerrain.status !== 'complete'
  const sunlit = total(sunIntervals), earthUp = total(earthIntervals)
  const elev = sunKnown ? elevationStats(model, sunIntervals) : { mean: null, peak: null }
  const never = 'The Sun is not visible during the mission'
  return {
    window, status, sunStatus, earthStatus, reasons, sun, sunTerrain, earth, sunIntervals, earthIntervals, sunAndEarthIntervals, resolutionUncertaintyMs, sunSeries, model: EVENTS_MODEL,
    sunlitDuration: ms(sunKnown ? sunlit : null, why), sunlitFraction: frac(sunKnown ? sunlit / span : null, why),
    terrainSunDuration: ms(terrainUnknown ? null : total(where(sunTerrain.segments, true)), 'Terrain-only state unknown'),
    eclipseDuration: ms(terrainUnknown || !sunKnown ? null : total(intersect(where(sunTerrain.segments, true), where(sun.segments, false))), 'Terrain-only state unknown'),
    longestDarkness: ms(sunKnown ? longest(where(sun.segments, false)) : null, why),
    earthVisibleDuration: ms(earthKnown ? earthUp : null, why), earthVisibleFraction: frac(earthKnown ? earthUp / span : null, why),
    longestEarthVisible: ms(earthKnown ? longest(earthIntervals) : null, why), longestEarthGap: ms(earthKnown ? longest(where(earth.segments, false)) : null, why),
    sunAndEarthFraction: frac(sunKnown && earthKnown ? total(sunAndEarthIntervals) / span : null, why),
    sunElevationMean: deg(sunKnown ? elev.mean : null, sunKnown ? never : why), sunElevationPeak: deg(sunKnown ? elev.peak : null, sunKnown ? never : why),
    partial: status === 'incomplete' ? {
      knownSunlitMs: total(sunIntervals), knownDarkMs: total(where(sun.segments, false)), knownEarthVisibleMs: total(earthIntervals),
      knownEarthHiddenMs: total(where(earth.segments, false)), unknownSunMs: sunUnknown, unknownEarthMs: earthUnknown,
    } : null,
  }
}
