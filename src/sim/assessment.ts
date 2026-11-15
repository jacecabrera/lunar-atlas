// Candidate registry entries, per-condition assessment results and the eligibility summary rule.
//
// A candidate record says where a point is and where the coordinates come from. It never says whether the point
// is eligible: that is the job of a SiteAssessment for one mission. Historical landing sites are not
// pre-approved landing sites.
import type { SourceRef } from './provenance'

// ─── Candidate registry ────────────────────────────────────────────────────

export type CandidateOrigin = 'historical' | 'custom'

export type CandidateRecord = {
  /** Stable ID; also the final tie-breaker in ranking. */
  id: string
  name: string
  origin: CandidateOrigin
  /** Degrees, north positive. Source precision is kept; no invented uncertainty. */
  lat: number
  /** Degrees, east positive. */
  lon: number
  /** Coordinate frame as stated by the source, e.g. 'DE421 mean Earth/polar axis'. */
  frame: string
  source?: SourceRef
  /** e.g. "Coordinates mark the LM descent stage; hardware may obstruct the footprint." */
  hardwareNote?: string
}

// ─── Conditions ────────────────────────────────────────────────────────────

/** Necessary conditions. Terrain, power and communication are physical; dataCompleteness is not. */
export type ConditionKey = 'terrain' | 'power' | 'communication' | 'dataCompleteness'
export const PHYSICAL_CONDITIONS = ['terrain', 'power', 'communication'] as const satisfies readonly ConditionKey[]
export const CONDITION_KEYS = [...PHYSICAL_CONDITIONS, 'dataCompleteness'] as const satisfies readonly ConditionKey[]

/**
 * - `pass`    evaluated with adequate data, the condition holds under the current model
 * - `fail`    for physical conditions: evaluated, the condition is shown not to hold.
 *             For dataCompleteness: the data are known to be insufficient (not a physical hazard).
 * - `unknown` not evaluated, or the data cannot support a decision (e.g. a 7.6 km grid for a 3 m footprint)
 * - `error`   a service or computation failure; says nothing about the physical site
 */
export type ConditionStatus = 'pass' | 'fail' | 'unknown' | 'error'

export type ConditionReason = {
  /** Machine-readable, e.g. 'slope-exceeds-limit', 'dem-too-coarse', 'terrain-not-loaded', 'service-error'. */
  code: string
  /** English, user-facing. */
  message: string
}

/** A number with its unit, or null with the reason it cannot be given. A legitimate 0 stays 0. */
export type Quantity =
  | { value: number; unit: string }
  | { value: null; unit: string; reason: string }

export type ConditionResult = {
  status: ConditionStatus
  /** Every reason that led to the status. Must be non-empty unless status is 'pass'. */
  reasons: ConditionReason[]
  values?: Record<string, Quantity>
  sources?: SourceRef[]
  /** Model and data limits that qualify the result, e.g. "Thermal control is not modelled." */
  limitations?: string[]
}

export type SiteConditions = Record<ConditionKey, ConditionResult>

/** Default for anything not computed yet. Never produces eligibility. */
export const notEvaluated = (message = 'Not evaluated yet'): ConditionResult => ({
  status: 'unknown',
  reasons: [{ code: 'not-evaluated', message }],
})

// ─── Summary rule ──────────────────────────────────────────────────────────

export type SummaryReason = ConditionReason & { condition: ConditionKey; status: Exclude<ConditionStatus, 'pass'> }

export type AssessmentSummary = {
  /**
   * false  at least one physical condition is shown to fail (other conditions may still be unknown or errored)
   * true   every condition passes, including data completeness
   * null   no complete decision is possible
   */
  landingAllowed: boolean | null
  /** True only when every necessary condition passes. */
  eligibleForRecommendation: boolean
  /** Physical conditions shown to fail. */
  failed: ConditionKey[]
  /** Conditions that are unknown, plus dataCompleteness when it is 'fail' (insufficient data, not a hazard). */
  undetermined: ConditionKey[]
  errored: ConditionKey[]
  /** All non-pass reasons, in CONDITION_KEYS order. Known failures are never dropped in favour of unknowns. */
  reasons: SummaryReason[]
}

export function summarizeConditions(c: SiteConditions): AssessmentSummary {
  const failed: ConditionKey[] = []
  const undetermined: ConditionKey[] = []
  const errored: ConditionKey[] = []
  const reasons: SummaryReason[] = []

  for (const key of CONDITION_KEYS) {
    const r = c[key]
    if (r.status === 'pass') continue
    if (r.status === 'error') errored.push(key)
    else if (r.status === 'fail' && key !== 'dataCompleteness') failed.push(key)
    else undetermined.push(key)
    const list = r.reasons.length > 0 ? r.reasons : [{ code: 'no-reason-given', message: 'No reason was recorded' }]
    for (const reason of list) reasons.push({ ...reason, condition: key, status: r.status })
  }

  const allPass = failed.length === 0 && undetermined.length === 0 && errored.length === 0
  const landingAllowed = failed.length > 0 ? false : allPass ? true : null
  return { landingAllowed, eligibleForRecommendation: landingAllowed === true, failed, undetermined, errored, reasons }
}

// ─── Mission metrics contract ──────────────────────────────────────────────
// Shapes only. The values are produced in step 10 (window statistics) after step 09 fixes visibility rules.

/** Sun: any part of the disc above the local terrain horizon (no extra elevation mask). */
export type SunVisibilityPolicy = { body: 'sun'; criterion: 'any-part-of-disc'; mask: 'terrain-horizon' }
/** Earth: disc centre above max(local terrain horizon, minimum elevation). */
export type EarthVisibilityPolicy = {
  body: 'earth'
  criterion: 'disc-center'
  mask: 'max-terrain-horizon-and-min-elevation'
  minElevationDeg: number
}
export type VisibilityPolicy = SunVisibilityPolicy | EarthVisibilityPolicy

export const SUN_VISIBILITY_POLICY: SunVisibilityPolicy = {
  body: 'sun', criterion: 'any-part-of-disc', mask: 'terrain-horizon',
}
export const earthVisibilityPolicy = (minElevationDeg = 0): EarthVisibilityPolicy => ({
  body: 'earth', criterion: 'disc-center', mask: 'max-terrain-horizon-and-min-elevation', minElevationDeg,
})

/**
 * Step 10: the shapes declared here in step 03 are now produced by sim/visibility.ts and sim/events.ts and are
 * aliased to those results, so there is one definition. Sun state at one instant: SunVisibility (sunlit and
 * visibleFraction are separate; a visible limb is not full power). "Time to next sunset / Earthset": NextSet (the next
 * visible -> not-visible transition; not found is null, never zero). Mission values over exactly the mission window:
 * MissionStatistics (unknown time is never counted as dark or visible).
 */
export type SolarSample = import('./visibility').SunVisibility
export type NextSetResult = import('./events').NextSet
export type MissionMetrics = import('./events').MissionStatistics

export type SiteAssessment = {
  siteId: string
  conditions: SiteConditions
  summary: AssessmentSummary
  metrics?: MissionMetrics
}

export function assessSite(siteId: string, conditions: SiteConditions, metrics?: MissionMetrics): SiteAssessment {
  return { siteId, conditions, summary: summarizeConditions(conditions), metrics }
}

export type Recommendation = {
  siteId: string
  /** 1..3 */
  rank: number
  /** 0..100. A ranking aid, not a probability of success. */
  score: number
  parts: { sunlight: number; earth: number; terrain: number }
}
