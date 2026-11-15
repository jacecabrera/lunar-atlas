// Explanations of the core numbers on the details page (step 22). Each text states what the code in sim/events.ts and
// sim/visibility.ts actually does (formula, variables, units, window and boundary rules, resolution, limits) and is filled
// with this snapshot's own values (window, model identities, unresolved time). Source IDs are those of sources.md.
import type { DetailSnapshot, SnapshotPoint } from '../sim/snapshot'
import { duration, utc } from './format'

export type RefRole = 'source-value' | 'derived' | 'assumption' | 'model' | 'dataset' | 'display-only'
export type ExplainRef = { id: string; role: RefRole; note?: string }
export type Explanation = {
  title: string
  formula: string
  variables: string[]
  units: string
  rules: string[]
  resolution: string[]
  limits: string[]
  versions: string[]
  refs: ExplainRef[]
}

export type ExplainKey =
  | 'sunlitDuration' | 'sunlitFraction' | 'longestDarkness'
  | 'earthWindows' | 'earthVisibleDuration' | 'earthVisibleFraction' | 'longestEarthVisible' | 'longestEarthGap'
  | 'sunAndEarthFraction' | 'sunElevationMean' | 'sunElevationPeak'
  | 'timeline' | 'curve' | 'nextSunset' | 'nextEarthset'

const SUN_REFS: ExplainRef[] = [
  { id: 'ASM-SUN-DISC-VISIBILITY', role: 'assumption' }, { id: 'ASM-ECLIPSE-SPHERE', role: 'assumption' },
  { id: 'SRC-ASTRONOMY-ENGINE', role: 'model', note: 'Sun and Moon positions' }, { id: 'SRC-IAU-WGCCRE', role: 'source-value', note: 'lunar orientation' },
]
const EARTH_REFS: ExplainRef[] = [
  { id: 'ASM-EARTH-GEOMETRY', role: 'assumption' },
  { id: 'SRC-ASTRONOMY-ENGINE', role: 'model', note: 'Earth and Moon positions' }, { id: 'SRC-IAU-WGCCRE', role: 'source-value', note: 'lunar orientation' },
]
const COMMON_REFS: ExplainRef[] = [
  { id: 'ASM-EVENT-RESOLUTION', role: 'assumption' }, { id: 'ASM-SKY-RATE-BOUNDS', role: 'assumption' },
  { id: 'ASM-UT1-EQUALS-UTC', role: 'assumption' }, { id: 'ASM-NO-FUTURE-LEAP-SECONDS', role: 'assumption' },
  { id: 'SRC-IERS-LEAP-SECONDS', role: 'source-value', note: 'TT - UTC' },
]
const TERRAIN_REFS: ExplainRef[] = [
  { id: 'SRC-LROC-NAC-DTM-PDS', role: 'dataset', note: 'near-field terrain products' }, { id: 'SRC-LOLA-GDR-CYL', role: 'dataset', note: 'mid/far-field terrain' },
  { id: 'SRC-LOLA-GDR-POLAR', role: 'dataset', note: 'polar terrain' }, { id: 'SRC-SLDEM2015-PDS', role: 'dataset', note: 'mid/far-field terrain' }, { id: 'ASM-HORIZON-PARAMETERS', role: 'assumption' },
]

export function explain(key: ExplainKey, snap: DetailSnapshot, p: SnapshotPoint): Explanation {
  const s = p.data.statistics
  const w = s.window, span = w.endMs - w.startMs
  const win = `Mission window ${utc(w.startMs)} to ${utc(w.endMs)} (${duration(span)})`
  const horizon = p.data.site.horizon
  const horizonText = horizon && horizon.status === 'available'
    ? `Terrain horizon of this point: ${horizon.source.product}, ${horizon.samples.elevationsDeg.length} azimuth samples every ${horizon.samples.stepDeg}°, search range ${horizon.model.maxRangeKm} km.`
    : 'No usable terrain horizon was attached to this point.'
  const minEl = (snap.settings as { earthMinElevationDeg: number }).earthMinElevationDeg
  const res = [
    `Events are found by scanning every 30 min and halving intervals that are not proven event-free, down to ${s.sun.settings.minResolveMs / 1000} s; they are then located to ±${s.sun.settings.locateToleranceMs / 2000} s. This is numerical resolution only; terrain, frame and ephemeris errors are separate.`,
    s.resolutionUncertaintyMs > 0
      ? `In this snapshot ${duration(s.resolutionUncertaintyMs)} of the window is unresolved: a window or gap shorter than ${s.sun.settings.minResolveMs / 1000} s may be missed there.`
      : 'In this snapshot no interval is unresolved: no window or gap longer than the resolution is missed.',
    `Statistics status: Sun ${s.sunStatus}, Earth ${s.earthStatus}.`,
  ]
  const estimated = snap.assessment.mode === 'relaxed' && (p.assessment.decision?.estimated ?? false)
  const limits = [
    ...(estimated ? ['Regional estimate: the skyline is nominal (a global-product cast, with lower-bound azimuths of a published horizon taken at their larger value); statuses are estimates, not formal verdicts, and obstacles and footprint-scale slope are not evaluated.'] : []),
    'No atmosphere or refraction; geometric vectors; the terrain is only as detailed as the horizon data (' + horizonText + ')',
    'UT1 is taken equal to UTC and no leap second is assumed after the IERS table expires (ASM-UT1-EQUALS-UTC, ASM-NO-FUTURE-LEAP-SECONDS).',
    'Unknown time (for example behind a lower-bound horizon sample) is never counted as dark, visible or zero.',
    ...snap.limits,
  ]
  const versions = [`Visibility: ${snap.versions.models.visibility}`, `Ephemeris: ${snap.versions.models.ephemeris}`, `Terrain: ${snap.versions.models.terrain}`, `Events: ${s.model}`, `Contract version ${snap.versions.contract}, terrain data ${snap.versions.data.terrain ?? 'n/a'}`]
  const base = { resolution: res, limits, versions }
  const sunVars = [win, `Sunlit intervals in the window: ${s.sunIntervals.length}`]
  const earthVars = [win, `Earth-visible intervals in the window: ${s.earthIntervals.length}`, `Minimum Earth elevation: ${minEl}°`]
  const sunRule = 'The Sun counts as visible while some of its disc (positive area) is above the terrain skyline and not covered by the Earth; there is no minimum elevation and the skyline may be negative.'
  const earthRule = `The Earth counts as visible while the centre of its disc is strictly above max(terrain skyline, ${minEl}°).`
  const windowRule = 'Only time inside the mission window is counted; intervals are clipped to it. Unknown time is excluded from every total, and a total that needs it is N/A.'
  const entries: Record<ExplainKey, Omit<Explanation, 'resolution' | 'limits' | 'versions'>> = {
    sunlitDuration: { title: 'Sunlit duration', formula: 'sum over sunlit intervals of (end - start)', variables: sunVars, units: 'duration (days, hours, minutes, seconds)', rules: [sunRule, windowRule], refs: [...SUN_REFS, ...TERRAIN_REFS, ...COMMON_REFS] },
    sunlitFraction: { title: 'Sunlit ratio', formula: 'sunlit duration / mission window length', variables: [...sunVars, `Window length ${duration(span)}`], units: 'percent of the window', rules: [sunRule, windowRule], refs: [...SUN_REFS, ...TERRAIN_REFS, ...COMMON_REFS] },
    longestDarkness: { title: 'Longest continuous darkness', formula: 'max over segments where the Sun is not visible of (end - start)', variables: [win], units: 'duration', rules: ['Darkness is the effective-sunlight channel being "no": terrain and eclipse both count. A segment is never merged across unknown time, and a dark segment cut by the window edges counts only its part inside the window.', windowRule], refs: [...SUN_REFS, ...TERRAIN_REFS, ...COMMON_REFS] },
    earthWindows: { title: 'Earth-visible windows', formula: 'number of maximal intervals in which the Earth is visible', variables: earthVars, units: 'count', rules: [earthRule, windowRule, 'A window cut by the window edges counts once.'], refs: [...EARTH_REFS, ...TERRAIN_REFS, ...COMMON_REFS] },
    earthVisibleDuration: { title: 'Earth-visible duration', formula: 'sum over Earth-visible intervals of (end - start)', variables: earthVars, units: 'duration', rules: [earthRule, windowRule], refs: [...EARTH_REFS, ...TERRAIN_REFS, ...COMMON_REFS] },
    earthVisibleFraction: { title: 'Earth-visible ratio', formula: 'Earth-visible duration / mission window length', variables: [...earthVars, `Window length ${duration(span)}`], units: 'percent of the window', rules: [earthRule, windowRule], refs: [...EARTH_REFS, ...TERRAIN_REFS, ...COMMON_REFS] },
    longestEarthVisible: { title: 'Longest continuous Earth visibility', formula: 'max over Earth-visible intervals of (end - start)', variables: earthVars, units: 'duration', rules: [earthRule, windowRule], refs: [...EARTH_REFS, ...TERRAIN_REFS, ...COMMON_REFS] },
    longestEarthGap: { title: 'Longest gap without Earth', formula: 'max over segments where the Earth is not visible of (end - start)', variables: earthVars, units: 'duration', rules: [earthRule, windowRule, 'A gap is never merged across unknown time.'], refs: [...EARTH_REFS, ...TERRAIN_REFS, ...COMMON_REFS] },
    sunAndEarthFraction: { title: 'Sun and Earth together, ratio', formula: 'duration of (sunlit intervals ∩ Earth-visible intervals) / mission window length', variables: [win, `Sunlit intervals ${s.sunIntervals.length}, Earth intervals ${s.earthIntervals.length}, both ${s.sunAndEarthIntervals.length}`], units: 'percent of the window', rules: [sunRule, earthRule, 'Geometry only: this is not a communication window (no antenna, link budget or powered check).', windowRule], refs: [...SUN_REFS, ...EARTH_REFS, ...TERRAIN_REFS, ...COMMON_REFS] },
    sunElevationMean: { title: 'Mean Sun elevation while sunlit', formula: 'integral of elevation(t) dt over sunlit intervals / total sunlit time', variables: ['elevation(t): elevation of the Sun centre above the local horizontal plane (not above the terrain skyline)', ...sunVars], units: 'degrees; negative values are kept (the disc can be partly above a negative skyline while its centre is below 0°)', rules: ['Time-weighted over the effective sunlit intervals only, by composite Simpson integration with panels of at most 15 min.', windowRule], refs: [...SUN_REFS, ...TERRAIN_REFS, ...COMMON_REFS] },
    sunElevationPeak: { title: 'Peak Sun elevation while sunlit', formula: 'max over sunlit intervals of elevation(t)', variables: ['elevation(t): elevation of the Sun centre above the local horizontal plane', ...sunVars], units: 'degrees; negative values are kept', rules: ['Largest of the panel samples, refined by a golden-section search around the best panel of each interval.', windowRule], refs: [...SUN_REFS, ...TERRAIN_REFS, ...COMMON_REFS] },
    timeline: { title: 'Timeline of Sun and Earth', formula: 'state segments from the event search over the mission window', variables: [win], units: 'UTC', rules: ['Three states: visible, not visible, unknown. Unknown stays unknown and is drawn as its own hatched state; nothing is interpolated across it.', 'Sun uses the effective-sunlight channel (terrain and eclipse); Earth uses the disc-centre rule.'], refs: [...SUN_REFS, ...EARTH_REFS, ...COMMON_REFS] },
    curve: { title: 'Sun elevation curve', formula: 'elevation of the Sun centre at fixed sample times', variables: [win, `${s.sunSeries.length} samples every ${duration(s.sunSeries.length > 1 ? s.sunSeries[1].tMs - s.sunSeries[0].tMs : span)}`], units: 'degrees, UTC', rules: ['Shown at the saved sample times only: the line is drawn between consecutive samples whose visibility is known and breaks where it is unknown.', 'Negative elevations are kept (below the local horizontal plane).'], refs: [...SUN_REFS, ...COMMON_REFS] },
    nextSunset: { title: 'Next sunset', formula: 'first visible-to-not-visible transition of the Sun after the selected time (terrain geometry only)', variables: ['Selected time (this page, UTC)', 'Site, horizon, settings and model identities of this snapshot', 'Search range: 60 days after the selected time'], units: 'UTC time and duration until it', rules: ['If the Sun is not visible at the selected time, the next sunset is the one after the next sunrise. A set exactly at the selected time is not returned.', 'An eclipse (the Earth covering the Sun) is not a sunset and is not reported here; its effect is in the mission statistics.', 'States: found; not found in the searched range (not the same as 0); unknown (visibility cannot be determined before a possible event); incomplete (search budget or short windows).'], refs: [...SUN_REFS, ...TERRAIN_REFS, ...COMMON_REFS] },
    nextEarthset: { title: 'Next Earthset', formula: 'first visible-to-not-visible transition of the Earth after the selected time', variables: ['Selected time (this page, UTC)', 'Site, horizon, settings and model identities of this snapshot', 'Search range: 60 days after the selected time'], units: 'UTC time and duration until it', rules: [earthRule, 'If the Earth is not visible at the selected time, the next Earthset is the one after the next Earthrise.', 'States: found; not found in the searched range (not the same as 0); unknown; incomplete.'], refs: [...EARTH_REFS, ...TERRAIN_REFS, ...COMMON_REFS] },
  }
  const e = entries[key]
  const modeRefs: ExplainRef[] = estimated ? [{ id: 'ASM-ASSESSMENT-MODE', role: 'assumption' }, { id: 'ASM-REGIONAL-SCREENING', role: 'assumption' }, { id: 'SRC-LOLA-GDR-CYL', role: 'dataset', note: 'global 16 pixel/degree terrain (LDEM_16)' }, ...(p.kind === 'search' ? [{ id: 'ASM-SEARCH-POLICY', role: 'assumption' } as ExplainRef] : [])] : []
  return { ...e, ...base, refs: dedupe([...e.refs, ...modeRefs]) }
}

function dedupe(refs: ExplainRef[]): ExplainRef[] {
  const m = new Map<string, ExplainRef>()
  for (const r of refs) if (!m.has(r.id)) m.set(r.id, r)
  return [...m.values()]
}

export const MOON_TEXTURE_REF: ExplainRef = { id: 'SRC-NASA-SVS-MOONKIT', role: 'display-only', note: 'surface imagery on the home page only; no calculation uses it' }
