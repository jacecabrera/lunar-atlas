// Regional estimate of one point (relaxed mode): the same numerical models as the evidence assessment (event search, fixed-panel
// PV, energy balance, communication overlap) run on a NOMINAL skyline, plus a regional-slope terrain screen. Nothing unknown is
// turned into a pass: the estimate keeps the evidence view next to it, labels itself estimated, lists the risks that were not
// evaluated, and still fails on proven hazards, no direct Earth opportunity, insufficient estimated energy and unusable inputs.
// The inputs are chosen for a ranking before any result is looked at (ASM-REGIONAL-SCREENING); nothing here is tuned to a count.
import type { AdvancedSettings, MissionWindow } from './mission'
import type { ConditionReason, ConditionResult, EstimateScale } from './assessment'
import type { HorizonData, SerializableSite } from './horizonData'
import type { MissionStatistics, EventSearchOptions } from './events'
import { missionStatistics } from './events'
import { visibilityModel } from './visibility'
import { assessEnergy } from './energy'
import type { EnergyResult } from './energy'
import { regionalSlope, castGlobalHorizon, fillHorizon, REGIONAL_MODEL, REGIONAL_AZIMUTH_STEP_DEG, REGIONAL_RANGE_KM } from './regional'
import { GLOBAL_TERRAIN_VERSION, pixelKm } from './globalTerrain'
import type { TiledHeights } from './globalTerrain'
import { EARTH_BOUNDARY_MS } from './recommend'

export type EstimateInputs = {
  terrain: ConditionResult
  data: ConditionResult
  slopeDeg: number | null
  energy: EnergyResult
  statistics: MissionStatistics
  site: SerializableSite
  assumptions: string[]
  risks: string[]
  warnings: string[]
  scale: EstimateScale
  dataUsed: string[]
  versions: string[]
}

export type EstimateArgs = {
  id: string
  name: string
  lat: number
  lon: number
  /** A horizon ready for the estimate (published horizon with fill, or a global cast); null when none could be made. */
  horizon: HorizonData | null
  /** Why there is no horizon (missing data, unusable tile). */
  horizonProblem?: ConditionReason
  /** A problem loading the global terrain for this point (stated in the data condition even when a published horizon exists). */
  dataProblem?: ConditionReason
  heights: TiledHeights | null
  /** The evidence terrain result of the same point, when it has one: a proven failure in it stays a failure. */
  evidenceTerrain?: ConditionResult | null
  settings: AdvancedSettings
  window: MissionWindow
  opts?: { events?: EventSearchOptions; energyStepMs?: number }
}

const BASELINE_RISK = 'No footprint-scale (3 m) terrain, rock or obstacle survey is available for this point: obstacles of 0.3 m or larger are not evaluated. This is not evidence that there are none.'

/** Risks taken over from the evidence terrain result: what the strict assessment could not decide. */
function risksFrom(terrain: ConditionResult | null | undefined): string[] {
  const out = [BASELINE_RISK]
  for (const r of terrain?.reasons ?? []) {
    if (r.code.startsWith('slope-dtm-too-coarse')) out.push('Footprint-scale slope is not evaluated: the available elevation data are too coarse for a 3 m footprint.')
    else if (r.code.startsWith('hazard-')) out.push(`Historical hardware: ${r.message}`)
  }
  return [...new Set(out)]
}

export function buildEstimate(a: EstimateArgs): EstimateInputs {
  const { settings, window } = a
  const post = a.heights ? pixelKm(a.heights.layout) : null
  const scale: EstimateScale = {
    slopeBaselineKm: post === null ? null : 2 * post, slopePostingKm: post, horizonPostingKm: post, horizonAzimuthStepDeg: a.horizon?.status === 'available' ? a.horizon.samples.stepDeg : REGIONAL_AZIMUTH_STEP_DEG,
    horizonRangeKm: REGIONAL_RANGE_KM, timeResolution: `event boundaries within ${(a.opts?.events?.minResolveMs ?? 10_000) / 1000} s, energy step ${(a.opts?.energyStepMs ?? 5 * 60_000) / 60_000} min`,
  }
  const site: SerializableSite = { id: a.id, name: a.name, lat: a.lat, lon: a.lon, horizon: a.horizon }
  const vis = visibilityModel(site, { earthMinElevationDeg: settings.earthMinElevationDeg, estimated: true })
  const statistics = missionStatistics(vis, window, a.opts?.events)
  const energy = assessEnergy(vis, settings, window, { stepMs: a.opts?.energyStepMs, events: a.opts?.events })
  const slope = a.heights ? regionalSlope(a.heights, a.lat, a.lon) : null

  // Terrain: a proven failure of the evidence view stays; otherwise the regional slope against the regional limit.
  let terrain: ConditionResult
  const limit = settings.regionalSlopeLimitDeg
  const regionalLimits = [`Regional scale only: slope over ${scale.slopeBaselineKm?.toFixed(1) ?? '?'} km of a ${post?.toFixed(2) ?? '?'} km product; obstacles and footprint-scale slope are not evaluated.`]
  if (a.evidenceTerrain?.status === 'fail') {
    terrain = { status: 'fail', reasons: a.evidenceTerrain.reasons, values: a.evidenceTerrain.values, limitations: ['A hazard or slope failure proven by the evidence assessment stays a failure in the estimate.'] }
  } else if (!slope) {
    terrain = { status: 'unknown', reasons: [{ code: 'regional-slope-missing', message: 'The global terrain data needed for the regional slope are not available for this coordinate' }], limitations: regionalLimits }
  } else if (slope.slopeDeg >= limit) {
    terrain = { status: 'fail', reasons: [{ code: 'regional-slope-exceeds-limit', message: `Regional slope ${slope.slopeDeg.toFixed(2)} deg is at or above the regional limit of ${limit} deg` }], values: { regionalSlopeDeg: { value: slope.slopeDeg, unit: 'deg' } }, limitations: regionalLimits }
  } else {
    terrain = { status: 'pass', reasons: [], values: { regionalSlopeDeg: { value: slope.slopeDeg, unit: 'deg' }, regionalBaselineKm: { value: slope.baselineKm, unit: 'km' } }, limitations: regionalLimits }
  }

  // Does the estimate have the inputs it claims to run on? (Not "are the four results numbers".)
  const missing: ConditionReason[] = [], errors: ConditionReason[] = []
  if (!a.horizon) missing.push(a.horizonProblem ?? { code: 'estimate-no-horizon', message: 'No skyline could be made for this point' })
  else if (vis.status !== 'ready') missing.push(...vis.reasons.map((r) => ({ ...r, code: `estimate-${r.code}` })))
  if (!a.heights) missing.push({ code: 'estimate-no-global-terrain', message: 'The global terrain data are not available' })
  if (a.dataProblem && !missing.some((m) => m.code === a.dataProblem!.code)) missing.push(a.dataProblem)
  if (energy.status === 'error') errors.push(...energy.condition.reasons)
  if (statistics.sunStatus === 'incomplete') missing.push({ code: 'estimate-sun-state-incomplete', message: 'Sunlight over the mission is not determined even on the nominal skyline' })
  if (statistics.earthStatus === 'incomplete') missing.push({ code: 'estimate-earth-state-incomplete', message: 'Earth visibility over the mission is not determined even on the nominal skyline' })
  const finite = [statistics.sunlitDuration.value, statistics.earthVisibleDuration.value].every((v) => v === null || Number.isFinite(v))
  if (!finite) errors.push({ code: 'estimate-non-finite', message: 'A computed metric is not a finite number' })
  const data: ConditionResult = errors.length ? { status: 'error', reasons: [...errors, ...missing] } : missing.length ? { status: 'unknown', reasons: missing } : { status: 'pass', reasons: [], limitations: ['Inputs suffice for the declared regional model; this is not a statement about footprint-scale terrain.'] }

  const filled = a.horizon?.status === 'available' ? a.horizon.estimation : undefined
  const assumptions = [
    `Slope: regional slope of the ${post?.toFixed(2) ?? '1.9'} km global product (about ${scale.slopeBaselineKm?.toFixed(1) ?? '3.8'} km baseline) against a regional limit of ${limit} deg, instead of the 3 m footprint slope.`,
    filled?.basis === 'filled'
      ? `Skyline: the published horizon, with ${filled.nominalLowerBoundAzimuths + filled.filledAzimuths.length} lower-bound azimuth(s) taken at the larger of the published lower bound and the global-product cast (the raw coverage is unchanged).`
      : `Skyline: cast from the global product at ${REGIONAL_AZIMUTH_STEP_DEG} deg azimuth steps to ${REGIONAL_RANGE_KM} km, starting ${post?.toFixed(1) ?? '1.9'} km from the observer.`,
    'Sun, Earth, energy and communication use the same models as the evidence assessment on the nominal skyline.',
    `Communication is a nominal overlap of Earth visibility and supplied load (boundaries to ${(a.opts?.events?.minResolveMs ?? EARTH_BOUNDARY_MS) / 1000} s), direct to Earth only, no relay; not a proof.`,
  ]
  const warnings = [...new Set([...vis.warnings.map((w) => w.message), ...(filled?.warnings ?? [])])]
  return {
    terrain, data, slopeDeg: slope?.slopeDeg ?? null, energy, statistics, site, assumptions, risks: risksFrom(a.evidenceTerrain), warnings, scale,
    dataUsed: [`global terrain ${GLOBAL_TERRAIN_VERSION} (LDEM_16)`, ...(a.horizon?.status === 'available' ? [`horizon: ${a.horizon.source.product}`] : [])],
    versions: [REGIONAL_MODEL],
  }
}

/**
 * The skyline an estimate uses. A published horizon (site package) is kept, with its lower-bound azimuths filled from the global
 * product when that is loaded; a point with no package gets a skyline cast from the global product. No data gives no horizon and a
 * stated problem; nothing is invented (and there is no smooth-sphere fallback).
 */
export function estimateHorizon(pkg: HorizonData | null, heights: TiledHeights | null, lat: number, lon: number): { horizon: HorizonData | null; problem?: ConditionReason } {
  if (pkg?.status === 'available') {
    if (heights) return { horizon: fillHorizon(pkg, heights) }
    // No global data: the published samples are used as they are, lower bounds as nominal values (a stated warning).
    const lb = pkg.coverage?.lowerBoundAzimuths ?? 0
    return { horizon: { ...pkg, estimation: { basis: 'filled', estimatedElevationsDeg: [...pkg.samples.elevationsDeg], productId: 'none', postingKm: null, filledAzimuths: [], nominalLowerBoundAzimuths: lb, warnings: [`${lb} lower-bound azimuth(s) used as nominal values; the global terrain data were not available to fill them`] } } }
  }
  if (!heights) return { horizon: null, problem: { code: 'estimate-no-global-terrain', message: 'The global terrain data needed for this coordinate are not available' } }
  const g = castGlobalHorizon(heights, lat, lon)
  return g.ok ? { horizon: g.horizon } : { horizon: null, problem: { code: `estimate-${g.code}`, message: g.message } }
}

/** The regional estimate of an arbitrary coordinate with no site package (search points, custom points away from the catalogue). */
export function estimatePoint(a: { id: string; name: string; lat: number; lon: number; heights: TiledHeights | null; problem?: ConditionReason; settings: AdvancedSettings; window: MissionWindow; opts?: EstimateArgs['opts'] }): EstimateInputs {
  const h = estimateHorizon(null, a.heights, a.lat, a.lon)
  return buildEstimate({ id: a.id, name: a.name, lat: a.lat, lon: a.lon, horizon: h.horizon, horizonProblem: h.problem ?? a.problem, dataProblem: a.problem, heights: a.heights, evidenceTerrain: null, settings: a.settings, window: a.window, opts: a.opts })
}
