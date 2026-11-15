// Metrics of one snapshot point for the details page (step 22): read from the saved MissionStatistics, nothing is
// recomputed here. Unknown time is never shown as dark, hidden or zero: a value that depends on unknown time is N/A with the reason.
import type { MissionStatistics, StateSegment } from '../sim/events'
import type { SnapshotPoint } from '../sim/snapshot'
import { show, duration } from './format'
import type { Shown } from './format'

export type MetricKey =
  | 'sunlitDuration' | 'sunlitFraction' | 'longestDarkness'
  | 'earthWindows' | 'earthVisibleDuration' | 'earthVisibleFraction' | 'longestEarthVisible' | 'longestEarthGap'
  | 'sunAndEarthFraction' | 'sunElevationMean' | 'sunElevationPeak'

export type MetricRow = { key: MetricKey; label: string; group: 'Sun' | 'Earth' | 'Sun and Earth'; value: Shown }

const SUN = 'Sun', EARTH = 'Earth', BOTH = 'Sun and Earth'

export function metricRows(s: MissionStatistics): MetricRow[] {
  const earthWindows: Shown = s.earthStatus === 'incomplete'
    ? { ok: false, text: 'N/A', reason: 'Unknown or unsearched time in the mission window' }
    : { ok: true, text: String(s.earthIntervals.length), raw: s.earthIntervals.length }
  return [
    { key: 'sunlitDuration', label: 'Sunlit duration', group: SUN, value: show(s.sunlitDuration) },
    { key: 'sunlitFraction', label: 'Sunlit ratio', group: SUN, value: show(s.sunlitFraction) },
    { key: 'longestDarkness', label: 'Longest continuous darkness', group: SUN, value: show(s.longestDarkness) },
    { key: 'sunElevationMean', label: 'Mean Sun elevation while sunlit', group: SUN, value: show(s.sunElevationMean) },
    { key: 'sunElevationPeak', label: 'Peak Sun elevation while sunlit', group: SUN, value: show(s.sunElevationPeak) },
    { key: 'earthWindows', label: 'Earth-visible windows', group: EARTH, value: earthWindows },
    { key: 'earthVisibleDuration', label: 'Earth-visible duration', group: EARTH, value: show(s.earthVisibleDuration) },
    { key: 'earthVisibleFraction', label: 'Earth-visible ratio', group: EARTH, value: show(s.earthVisibleFraction) },
    { key: 'longestEarthVisible', label: 'Longest continuous Earth visibility', group: EARTH, value: show(s.longestEarthVisible) },
    { key: 'longestEarthGap', label: 'Longest gap without Earth', group: EARTH, value: show(s.longestEarthGap) },
    { key: 'sunAndEarthFraction', label: 'Sun and Earth together, ratio', group: BOTH, value: show(s.sunAndEarthFraction) },
  ]
}

export type TimelineSegment = { start: number; end: number; state: 'visible' | 'not-visible' | 'unknown' }

/**
 * Segments of the whole mission window for one body: visible, not visible, or unknown. Time the search did not reach
 * (budget exhausted) and gaps between segments are unknown, never "not visible". Segments are not merged across unknown time.
 */
export function timelineSegments(s: MissionStatistics, body: 'sun' | 'earth'): TimelineSegment[] {
  const r = body === 'sun' ? s.sun : s.earth
  const out: TimelineSegment[] = []
  const push = (start: number, end: number, state: TimelineSegment['state']) => { if (end > start) out.push({ start, end, state }) }
  let t = s.window.startMs
  for (const g of [...r.segments].sort((a: StateSegment, b: StateSegment) => a.start - b.start)) {
    if (g.start > t) push(t, g.start, 'unknown')
    push(Math.max(g.start, t), Math.min(g.end, s.window.endMs), g.state === null ? 'unknown' : g.state ? 'visible' : 'not-visible')
    t = Math.max(t, Math.min(g.end, s.window.endMs))
  }
  push(t, s.window.endMs, 'unknown')
  return out
}

export const unknownDurationMs = (segs: TimelineSegment[]) => segs.filter((x) => x.state === 'unknown').reduce((a, x) => a + x.end - x.start, 0)

/** One line saying how complete the statistics are, and what the known parts are when they are not complete. */
export function completenessNote(s: MissionStatistics): { level: 'complete' | 'bounded' | 'incomplete'; text: string } {
  const est = s.estimated ? 'Estimated on a nominal skyline (regional estimate), not a formal verdict. ' : ''
  const n = completenessNoteCore(s)
  return { level: n.level, text: est + n.text }
}

function completenessNoteCore(s: MissionStatistics): { level: 'complete' | 'bounded' | 'incomplete'; text: string } {
  if (s.status === 'complete') return { level: 'complete', text: 'Every instant of the mission window is determined.' }
  if (s.status === 'bounded') return { level: 'bounded', text: `Determined, but windows shorter than ${s.sun.settings.minResolveMs / 1000} s cannot be excluded in ${duration(s.resolutionUncertaintyMs)} of the window (see the explanation).` }
  const p = s.partial
  const known = p ? ` Known parts only (not totals): sunlit ${duration(p.knownSunlitMs)}, dark ${duration(p.knownDarkMs)}, Earth visible ${duration(p.knownEarthVisibleMs)}, Earth hidden ${duration(p.knownEarthHiddenMs)}; unknown Sun ${duration(p.unknownSunMs)}, unknown Earth ${duration(p.unknownEarthMs)}.` : ''
  return { level: 'incomplete', text: `Some time in the mission window is unknown, so totals that depend on it are N/A.${known}` }
}

export type CurvePoint = { tMs: number; elevationDeg: number; sunlit: boolean | null }
/** The saved Sun-centre elevation series. Negative elevations are kept; an unknown visibility is marked, not bridged. */
export const curvePoints = (p: SnapshotPoint): CurvePoint[] => p.data.statistics.sunSeries.map((x) => ({ tMs: x.tMs, elevationDeg: x.elevationDeg, sunlit: x.sunlit }))
