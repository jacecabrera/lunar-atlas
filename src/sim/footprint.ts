// Footprint terrain conditions (v0.7 section 5): slope, obstacles and known hazards inside the local footprint.
//
// The entry point takes explicit inputs (coordinate, frame, footprint configuration, terrain data and evidence) and
// never looks at a candidate ID or UI state. Each sub-condition keeps the contract meanings:
//   pass    adequate footprint-scale evidence shows the condition holds
//   fail    adequate evidence shows the limit is reached or exceeded (or a confirmed hazard overlaps the footprint)
//   unknown the data or evidence cannot support either conclusion (too coarse, gaps, uncertainty across the limit)
//   error   loading or computation failed; this says nothing about the site
// A confirmed failure is kept together with every other unknown reason.
import type { ConditionReason, ConditionResult, ConditionStatus, Quantity } from './assessment'
import type { AdvancedSettings } from './mission'
import type { SourceRef } from './provenance'
import { offsetLatLon, reliefAbovePlane, sampleDisc } from '../physics/footprintTerrain'
import type { HeightSampler } from '../physics/footprintTerrain'
import { surfaceDistanceM } from './catalog'

export const FOOTPRINT_MODEL = 'footprint-v1:slope=central-difference@max(resolution);obstacle=plane-relief|survey;hazard=disc-overlap;unknown-statistic-factor=3'

// ─── Configuration ─────────────────────────────────────────────────────────

export type FootprintConfig = {
  /** From AdvancedSettings (ASM-FOOTPRINT, ASM-TERRAIN-THRESHOLDS). */
  diameterM: number
  slopeLimitDeg: number
  obstacleLimitM: number
  /** ASM-UNKNOWN-UNCERTAINTY-FACTOR: a stated uncertainty whose statistic is unknown is multiplied by this before use. */
  unknownStatisticFactor: number
  /** ASM-FOOTPRINT-SAMPLING: resolution cells needed across the footprint diameter for a footprint maximum slope. */
  minCellsAcrossFootprint: number
}

/** Project policies of this module (registered in sources.md); the footprint and thresholds come from settings. */
export const FOOTPRINT_POLICY = { unknownStatisticFactor: 3, minCellsAcrossFootprint: 2 } as const

export function footprintConfig(
  settings: Pick<AdvancedSettings, 'footprintDiameterM' | 'slopeLimitDeg' | 'obstacleLimitM'>,
  policy: { unknownStatisticFactor: number; minCellsAcrossFootprint: number } = FOOTPRINT_POLICY,
): FootprintConfig {
  return { diameterM: settings.footprintDiameterM, slopeLimitDeg: settings.slopeLimitDeg, obstacleLimitM: settings.obstacleLimitM, ...policy }
}

// ─── Uncertainty ───────────────────────────────────────────────────────────

/**
 * - `bound`       a stated maximum
 * - `90-percent`  a 90 % level (e.g. NAC DTM relative linear error RLE90), used directly as the working bound
 * - `1-sigma`     scaled to the 90 % level (1.645 in one dimension, 2.146 for a horizontal position)
 * - `unknown`     scaled by FootprintConfig.unknownStatisticFactor; a stated 0 of unknown meaning is not zero (null)
 */
export type UncertaintyStatistic = 'bound' | '90-percent' | '1-sigma' | 'unknown'
export type StatedUncertainty = { valueM: number | null; statistic: UncertaintyStatistic; sourceId?: string; note?: string }

export function workingBoundM(u: StatedUncertainty, k: number, dims: 1 | 2): number | null {
  if (u.valueM === null || !Number.isFinite(u.valueM) || u.valueM < 0) return null
  if (u.statistic === 'unknown' && u.valueM === 0) return null
  switch (u.statistic) {
    case 'bound': case '90-percent': return u.valueM
    case '1-sigma': return u.valueM * (dims === 1 ? 1.645 : 2.146)
    case 'unknown': return u.valueM * k
  }
}

/** Independent error components add linearly (conservative). An empty list means nothing was stated: unknown. */
function sumBounds(list: StatedUncertainty[], k: number, dims: 1 | 2): number | null {
  if (list.length === 0) return null
  let s = 0
  for (const u of list) { const b = workingBoundM(u, k, dims); if (b === null) return null; s += b }
  return s
}

// ─── Inputs ────────────────────────────────────────────────────────────────

/** A footprint-scale elevation product. `postingM` is the native posting, never a storage quantisation step. */
export type FootprintDtm = {
  productId: string
  sourceIds: string[]
  heightAt: HeightSampler
  codeAt?: ((lat: number, lon: number) => number | null) | null
  acceptedCodes?: readonly number[] | null
  confidenceLegend: 'confirmed' | 'unconfirmed' | 'none'
  postingM: number
  /** Effective resolution when known (stereo DTMs resolve less than their posting); the larger value is used. */
  effectiveResolutionM?: number | null
  /** True for grids resampled to a finer posting than their source: no new terrain information. */
  upsampled?: boolean
  /** Relative vertical error between posts. */
  verticalError: StatedUncertainty | null
  /** Horizontal registration of the grid to the site frame. */
  registration: StatedUncertainty | null
  frame: 'same-as-site' | 'registered-to-site-frame' | 'unverified' | 'different'
}

export type ObstacleDetection = {
  id: string; lat: number; lon: number
  heightM: number; heightUncertainty: StatedUncertainty
  /** Plan-view half-size, m; null when unknown (then the object is treated as a point for overlap). */
  halfExtentM: number | null
  /** Position error components in the site frame. */
  position: StatedUncertainty[]
}

export type ObstacleSurvey = {
  id: string
  sourceIds: string[]
  method: 'image' | 'dtm' | 'in-situ' | 'other'
  /** Smallest obstacle height the survey reliably detects, m; null when not established. */
  minDetectableHeightM: number | null
  /** Coverage of the footprint plus its placement uncertainty. */
  coverage: 'full' | 'partial' | 'none' | 'unknown'
  detections: ObstacleDetection[]
}

export type KnownHazard = {
  id: string
  name: string
  kind: 'hardware' | 'crater-rim' | 'scarp' | 'blast-zone' | 'other'
  lat: number
  lon: number
  /**
   * 'site-coordinate-marks-hazard': the site coordinate is, per its source, the position of this object (same source
   * and frame), so only the object's position error matters. 'separate-coordinate': a different coordinate.
   */
  relation: 'site-coordinate-marks-hazard' | 'separate-coordinate'
  /** For a separate coordinate: whether its frame is the site frame (or reconciled with it). */
  frameReconciled: boolean
  position: StatedUncertainty[]
  /** Smallest plan-view distance from the object's position to its outline (solid parts), m. */
  minHalfExtentM: number | null
  /** Largest plan-view distance from the position to any part (legs, pads), m. */
  maxHalfExtentM: number | null
  /** Height above the ground that the object certainly reaches, m. */
  minObstructionHeightM: number | null
  /** True only when the dimensions come from a source read in the original. */
  dimensionsVerified: boolean
  sourceIds: string[]
  note?: string
}

export type DataProblem = { unavailable: ConditionReason } | { error: ConditionReason }

export type FootprintInput = {
  site: { lat: number; lon: number; frame: string }
  config: FootprintConfig
  dtm: FootprintDtm | DataProblem | null
  obstacleSurveys: ObstacleSurvey[]
  hazards: KnownHazard[]
  /** Whether `hazards` is an exhaustive inventory of the footprint area, and why. */
  hazardInventory: { complete: boolean; basis: string }
}

export type HazardOverlapStatus = 'confirmed-overlap' | 'possible-overlap' | 'confirmed-clear' | 'undetermined'
export type HazardOverlap = { hazardId: string; status: HazardOverlapStatus; reason: ConditionReason; values: Record<string, Quantity> }

export type FootprintAssessment = {
  /** The combined terrain condition for SiteConditions.terrain. */
  terrain: ConditionResult
  slope: ConditionResult
  obstacles: ConditionResult
  hazards: ConditionResult & { overlaps: HazardOverlap[] }
  /** Data adequacy for this assessment: pass = adequate, unknown = inadequate, error = load failure. Never 'fail'. */
  data: ConditionResult
  config: FootprintConfig
  model: string
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const q = (value: number | null, unit: string, reason = 'Not available'): Quantity => (value === null || !Number.isFinite(value) ? { value: null, unit, reason } : { value, unit })
const ref = (id: string): SourceRef => ({ id, title: `Source register entry ${id} (sources.md)`, kind: 'dataset' })
const isProblem = (d: FootprintInput['dtm']): d is DataProblem => !!d && ('error' in d || 'unavailable' in d)
const result = (status: ConditionStatus, reasons: ConditionReason[], extra: Partial<ConditionResult> = {}): ConditionResult => ({ status, reasons, ...extra })

type Capability = { ok: true; resolutionM: number; e90M: number; placementM: number; dtm: FootprintDtm; values: Record<string, Quantity> } | { ok: false; reasons: ConditionReason[]; values: Record<string, Quantity> }

/** Can this DTM resolve a quantity at `requiredResolutionM`? Lists every shortfall. */
function dtmCapability(dtm: FootprintDtm, cfg: FootprintConfig, requiredResolutionM: number, prefix: string): Capability {
  const reasons: ConditionReason[] = []
  const resolutionM = Math.max(dtm.postingM, dtm.effectiveResolutionM ?? dtm.postingM)
  const e90M = dtm.verticalError ? workingBoundM(dtm.verticalError, cfg.unknownStatisticFactor, 1) : null
  const placementM = dtm.registration ? workingBoundM(dtm.registration, cfg.unknownStatisticFactor, 2) : null
  if (dtm.upsampled) reasons.push({ code: `${prefix}-upsampled-data`, message: 'The grid was resampled finer than its source; that adds no terrain information' })
  if (resolutionM > requiredResolutionM + 1e-12) reasons.push({ code: `${prefix}-dtm-too-coarse`, message: `${dtm.productId} resolves ${resolutionM} m; this check needs ${requiredResolutionM} m or finer` })
  if (e90M === null) reasons.push({ code: `${prefix}-vertical-error-unknown`, message: 'The vertical error of the elevation data is not established' })
  if (placementM === null) reasons.push({ code: `${prefix}-registration-unknown`, message: 'The horizontal registration of the elevation data is not established' })
  if (dtm.frame === 'unverified' || dtm.frame === 'different') reasons.push({ code: `${prefix}-frame-unverified`, message: `The elevation data frame is ${dtm.frame} relative to the site frame` })
  if (dtm.codeAt && dtm.confidenceLegend !== 'confirmed') reasons.push({ code: `${prefix}-confidence-legend-unconfirmed`, message: 'The confidence codes of the elevation data cannot be interpreted' })
  const values = { resolutionM: q(resolutionM, 'm'), requiredResolutionM: q(requiredResolutionM, 'm'), verticalError90M: q(e90M, 'm'), placementBoundM: q(placementM, 'm') }
  if (reasons.length) return { ok: false, reasons, values }
  return { ok: true, resolutionM, e90M: e90M!, placementM: placementM!, dtm, values }
}

/** Disc samples checked for gaps and flagged confidence codes. */
function usableSamples(dtm: FootprintDtm, lat: number, lon: number, radiusM: number, stepM: number, baselineM: number, prefix: string) {
  const samples = sampleDisc(dtm.heightAt, dtm.codeAt ?? null, lat, lon, radiusM, stepM, baselineM)
  const reasons: ConditionReason[] = []
  if (samples.some((s) => s.z === null || s.slopeDeg === null)) reasons.push({ code: `${prefix}-data-gap`, message: 'Elevation data are missing inside the footprint or its placement margin' })
  if (dtm.codeAt && dtm.acceptedCodes && samples.some((s) => s.code === null || !dtm.acceptedCodes!.includes(s.code))) {
    reasons.push({ code: `${prefix}-confidence-flagged`, message: 'Confidence codes inside the footprint or its placement margin flag the elevations as unreliable' })
  }
  return { samples, reasons }
}

/** Candidate footprint centres: every position allowed by the placement bound, at `stepM` spacing. */
function centres(placementM: number, stepM: number): Array<{ e: number; n: number }> {
  const out = [{ e: 0, n: 0 }]
  const k = Math.ceil(placementM / stepM)
  for (let i = -k; i <= k; i++) for (let j = -k; j <= k; j++) {
    if ((i || j) && Math.hypot(i * stepM, j * stepM) <= placementM + 1e-9) out.push({ e: i * stepM, n: j * stepM })
  }
  return out
}

// ─── Slope ─────────────────────────────────────────────────────────────────

function assessSlope(input: FootprintInput): ConditionResult {
  const { config: cfg, dtm } = input
  const limit = { slopeLimitDeg: q(cfg.slopeLimitDeg, 'deg'), footprintDiameterM: q(cfg.diameterM, 'm') }
  if (dtm === null) return result('unknown', [{ code: 'slope-no-dtm', message: 'No footprint-scale elevation data' }], { values: limit })
  if (isProblem(dtm)) return 'error' in dtm ? result('error', [dtm.error], { values: limit }) : result('unknown', [dtm.unavailable], { values: limit })
  const required = cfg.diameterM / cfg.minCellsAcrossFootprint
  const cap = dtmCapability(dtm, cfg, required, 'slope')
  const sources = dtm.sourceIds.map(ref)
  if (!cap.ok) {
    const e90 = cap.values.verticalError90M.value
    // What the data would give at the footprint scale, for the record: slope error over the footprint diameter.
    const atFootprint = e90 === null ? null : Math.atan((Math.SQRT2 * e90) / cfg.diameterM) * (180 / Math.PI)
    return result('unknown', cap.reasons, { values: { ...limit, ...cap.values, slopeUncertaintyAtFootprintDeg: q(atFootprint, 'deg', 'Vertical error unknown') }, sources })
  }
  const r = cfg.diameterM / 2
  const step = cap.resolutionM / 2
  const { samples, reasons } = usableSamples(dtm, input.site.lat, input.site.lon, r + cap.placementM, step, cap.resolutionM, 'slope')
  if (reasons.length) return result('unknown', reasons, { values: { ...limit, ...cap.values }, sources })
  const delta = (Math.atan((Math.SQRT2 * cap.e90M) / cap.resolutionM) * 180) / Math.PI
  const perCentre = centres(cap.placementM, step).map((c) => Math.max(...samples.filter((s) => Math.hypot(s.eastM - c.e, s.northM - c.n) <= r + 1e-9).map((s) => s.slopeDeg!)))
  const maxAll = Math.max(...perCentre), minAll = Math.min(...perCentre)
  const values = { ...limit, ...cap.values, maxSlopeDeg: q(maxAll, 'deg'), leastMaxSlopeOverPlacementsDeg: q(minAll, 'deg'), slopeUncertaintyDeg: q(delta, 'deg'), baselineM: q(cap.resolutionM, 'm') }
  if (minAll - delta >= cfg.slopeLimitDeg) return result('fail', [{ code: 'slope-at-or-above-limit', message: `Footprint slope reaches ${minAll.toFixed(2)} deg (uncertainty ${delta.toFixed(2)} deg) at every possible placement; limit ${cfg.slopeLimitDeg} deg` }], { values, sources })
  if (maxAll + delta < cfg.slopeLimitDeg) return result('pass', [], { values, sources })
  return result('unknown', [{ code: 'slope-near-limit', message: `Footprint slope ${maxAll.toFixed(2)} deg with uncertainty ${delta.toFixed(2)} deg spans the ${cfg.slopeLimitDeg} deg limit` }], { values, sources })
}

// ─── Obstacles ─────────────────────────────────────────────────────────────

function assessObstacles(input: FootprintInput): ConditionResult {
  const { config: cfg, dtm } = input
  const k = cfg.unknownStatisticFactor
  const r = cfg.diameterM / 2
  const values: Record<string, Quantity> = { obstacleLimitM: q(cfg.obstacleLimitM, 'm') }
  const fails: ConditionReason[] = []
  const unknowns: ConditionReason[] = []
  const errors: ConditionReason[] = []
  const sources: SourceRef[] = []
  let provenClear = false

  // Surveys (images, in-situ, or DTM-derived detections supplied by the caller).
  for (const s of input.obstacleSurveys) {
    s.sourceIds.forEach((id) => sources.push(ref(id)))
    for (const d of s.detections) {
      const dist = surfaceDistanceM(input.site, d)
      const pos = sumBounds(d.position, k, 2)
      const hb = workingBoundM(d.heightUncertainty, k, 1)
      const tallEnough = hb !== null && d.heightM - hb >= cfg.obstacleLimitM
      const maybeTall = hb === null || d.heightM + hb >= cfg.obstacleLimitM
      const surelyInside = pos !== null && dist + pos < r + (d.halfExtentM ?? 0)
      const maybeInside = pos === null || d.halfExtentM === null || dist - pos - d.halfExtentM <= r
      if (tallEnough && surelyInside) fails.push({ code: 'obstacle-confirmed', message: `${d.id} (${d.heightM} m) lies inside the footprint at every possible position (survey ${s.id})` })
      else if (maybeTall && maybeInside) unknowns.push({ code: 'obstacle-possible', message: `${d.id} may reach the ${cfg.obstacleLimitM} m limit inside the footprint (survey ${s.id})` })
    }
    const capable = s.coverage === 'full' && s.minDetectableHeightM !== null && s.minDetectableHeightM <= cfg.obstacleLimitM
    if (capable) provenClear = true
  }
  if (input.obstacleSurveys.length === 0) unknowns.push({ code: 'obstacle-no-survey', message: 'No obstacle survey of the footprint is available' })
  else if (!provenClear) unknowns.push({ code: 'obstacle-survey-insufficient', message: `No survey covers the footprint with a detection limit at or below ${cfg.obstacleLimitM} m` })

  // DTM relief: an obstacle of height h is assumed to be no narrower than h (ASM-OBSTACLE-RESOLUTION).
  if (dtm === null) unknowns.push({ code: 'obstacle-no-dtm', message: 'No footprint-scale elevation data' })
  else if (isProblem(dtm)) ('error' in dtm ? errors : unknowns).push('error' in dtm ? dtm.error : dtm.unavailable)
  else {
    sources.push(...dtm.sourceIds.map(ref))
    const cap = dtmCapability(dtm, cfg, cfg.obstacleLimitM, 'obstacle')
    if (!cap.ok) { unknowns.push(...cap.reasons); Object.assign(values, cap.values) }
    else if (cap.e90M >= cfg.obstacleLimitM) unknowns.push({ code: 'obstacle-vertical-error-too-large', message: `Vertical error ${cap.e90M} m is not below the ${cfg.obstacleLimitM} m limit` })
    else {
      const step = cap.resolutionM
      const { samples, reasons } = usableSamples(dtm, input.site.lat, input.site.lon, r + cap.placementM, step, cap.resolutionM, 'obstacle')
      if (reasons.length) unknowns.push(...reasons)
      else {
        const relief = centres(cap.placementM, step).map((c) => reliefAbovePlane(samples.filter((s) => Math.hypot(s.eastM - c.e, s.northM - c.n) <= r + 1e-9).map((s) => ({ eastM: s.eastM, northM: s.northM, z: s.z! }))))
        if (relief.some((x) => x === null)) unknowns.push({ code: 'obstacle-relief-undefined', message: 'Too few samples to fit the local surface' })
        else {
          const maxR = Math.max(...(relief as number[])), minR = Math.min(...(relief as number[]))
          Object.assign(values, cap.values, { maxReliefM: q(maxR, 'm'), leastReliefOverPlacementsM: q(minR, 'm'), verticalError90M: q(cap.e90M, 'm') })
          if (minR - cap.e90M >= cfg.obstacleLimitM) fails.push({ code: 'obstacle-relief-at-or-above-limit', message: `Local relief ${minR.toFixed(2)} m (error ${cap.e90M} m) reaches the ${cfg.obstacleLimitM} m limit at every placement` })
          else if (maxR + cap.e90M < cfg.obstacleLimitM) provenClear = true
          else unknowns.push({ code: 'obstacle-near-limit', message: `Local relief ${maxR.toFixed(2)} m with error ${cap.e90M} m spans the ${cfg.obstacleLimitM} m limit` })
        }
      }
    }
  }
  if (fails.length) return result('fail', [...fails, ...unknowns, ...errors], { values, sources })
  // Once a capable source shows the footprint clear, the shortfalls of other sources no longer matter.
  const open = unknowns.filter((x) => x.code === 'obstacle-possible' || x.code === 'obstacle-near-limit')
  if (provenClear && open.length === 0) return result('pass', [], { values, sources })
  if (errors.length && !provenClear) return result('error', [...errors, ...unknowns], { values, sources })
  return result('unknown', provenClear ? open : unknowns, { values, sources })
}

// ─── Known hazards (hardware, rims, scarps) ────────────────────────────────

export function hazardOverlap(h: KnownHazard, site: { lat: number; lon: number }, cfg: FootprintConfig): HazardOverlap {
  const r = cfg.diameterM / 2
  const pos = sumBounds(h.position, cfg.unknownStatisticFactor, 2)
  const d = h.relation === 'site-coordinate-marks-hazard' ? 0 : surfaceDistanceM(site, h)
  const values: Record<string, Quantity> = {
    distanceM: q(d, 'm'), positionBoundM: q(pos, 'm', 'Position uncertainty not established'), footprintRadiusM: q(r, 'm'),
    minHalfExtentM: q(h.minHalfExtentM, 'm', 'Not established'), maxHalfExtentM: q(h.maxHalfExtentM, 'm', 'Not established'),
  }
  const out = (status: HazardOverlapStatus, code: string, message: string): HazardOverlap => ({ hazardId: h.id, status, reason: { code, message }, values })
  if (h.relation === 'separate-coordinate' && !h.frameReconciled) return out('undetermined', 'hazard-frame-unreconciled', `${h.name}: its coordinate frame is not reconciled with the site frame`)
  if (pos === null) return out('undetermined', 'hazard-position-uncertainty-unknown', `${h.name}: position uncertainty not established (an uncertainty of unknown statistic is not treated as zero)`)
  if (h.dimensionsVerified && h.minHalfExtentM !== null && h.minObstructionHeightM !== null) {
    const margin = r + h.minHalfExtentM - (d + pos)
    values.overlapMarginM = q(margin, 'm')
    if (margin > 0 && h.minObstructionHeightM >= cfg.obstacleLimitM) {
      return out('confirmed-overlap', 'hazard-overlap-confirmed', `${h.name} overlaps the footprint at every position allowed by its uncertainty (margin ${margin.toFixed(2)} m)`)
    }
  }
  if (h.dimensionsVerified && h.maxHalfExtentM !== null && d - pos - h.maxHalfExtentM > r) {
    return out('confirmed-clear', 'hazard-clear', `${h.name} stays outside the footprint`)
  }
  if (!h.dimensionsVerified) return out('possible-overlap', 'hazard-dimensions-unverified', `${h.name}: dimensions not verified, overlap cannot be confirmed or excluded`)
  return out('possible-overlap', 'hazard-overlap-possible', `${h.name} may overlap the footprint`)
}

function assessHazards(input: FootprintInput): FootprintAssessment['hazards'] {
  const overlaps = input.hazards.map((h) => hazardOverlap(h, input.site, input.config))
  const sources = [...new Set(input.hazards.flatMap((h) => h.sourceIds))].map(ref)
  const confirmed = overlaps.filter((o) => o.status === 'confirmed-overlap').map((o) => o.reason)
  const open = overlaps.filter((o) => o.status === 'possible-overlap' || o.status === 'undetermined').map((o) => o.reason)
  if (!input.hazardInventory.complete) open.push({ code: 'hazard-inventory-incomplete', message: `Hazard inventory is not exhaustive: ${input.hazardInventory.basis}` })
  if (confirmed.length) return { ...result('fail', [...confirmed, ...open], { sources }), overlaps }
  if (open.length) return { ...result('unknown', open, { sources }), overlaps }
  return { ...result('pass', [], { sources }), overlaps }
}

// ─── Entry point ───────────────────────────────────────────────────────────

export function combineTerrain(parts: ConditionResult[]): ConditionResult {
  const nonPass = (s: ConditionStatus) => parts.filter((p) => p.status === s).flatMap((p) => p.reasons)
  const fails = nonPass('fail'), errors = nonPass('error'), unknowns = nonPass('unknown')
  const sources = [...new Map(parts.flatMap((p) => p.sources ?? []).map((s) => [s.id, s])).values()]
  const limitations = ['Footprint terrain conditions only; power, communication and data completeness are separate conditions.']
  if (fails.length) return { status: 'fail', reasons: [...fails, ...errors, ...unknowns], sources, limitations }
  if (errors.length) return { status: 'error', reasons: [...errors, ...unknowns], sources, limitations }
  if (unknowns.length) return { status: 'unknown', reasons: unknowns, sources, limitations }
  return { status: 'pass', reasons: [], sources, limitations }
}

function dataAdequacy(input: FootprintInput, slope: ConditionResult, obstacles: ConditionResult): ConditionResult {
  const dtm = input.dtm
  if (isProblem(dtm) && 'error' in dtm) return result('error', [dtm.error])
  const shortfalls = [...slope.reasons, ...obstacles.reasons].filter((x) => /-(no-dtm|dtm-too-coarse|vertical-error|registration-unknown|frame-unverified|confidence|data-gap|upsampled|no-survey|survey-insufficient)/.test(x.code) || x.code.startsWith('terrain-'))
  if (shortfalls.length) return result('unknown', shortfalls, { values: { ...(slope.values ?? {}) } })
  return result('pass', [], { values: { ...(slope.values ?? {}) } })
}

/** Evaluate the footprint terrain conditions from explicit inputs. Computation errors become 'error', never 'fail'. */
export function assessFootprint(input: FootprintInput): FootprintAssessment {
  try {
    if (!(input.config.diameterM > 0) || !(input.config.slopeLimitDeg > 0) || !(input.config.obstacleLimitM > 0)) throw new RangeError('Footprint configuration must be positive')
    if (!Number.isFinite(input.site.lat) || !Number.isFinite(input.site.lon) || Math.abs(input.site.lat) > 90) throw new RangeError('Invalid site coordinate')
    const slope = assessSlope(input)
    const obstacles = assessObstacles(input)
    const hazards = assessHazards(input)
    return { terrain: combineTerrain([slope, obstacles, hazards]), slope, obstacles, hazards, data: dataAdequacy(input, slope, obstacles), config: input.config, model: FOOTPRINT_MODEL }
  } catch (e) {
    const err = result('error', [{ code: 'footprint-computation-error', message: e instanceof Error ? e.message : String(e) }])
    return { terrain: err, slope: err, obstacles: err, hazards: { ...err, overlaps: [] }, data: err, config: input.config, model: FOOTPRINT_MODEL }
  }
}

export { offsetLatLon }
