// Necessary conditions, scoring and recommendations (v0.7 section 4, step 13).
//
// Conditions (step 03 contract, summarised by summarizeConditions):
//   terrain           the formal footprint assessment (step 08); regional slope is never used
//   power             the energy condition (step 12)
//   communication     a powered direct-to-Earth opportunity: positive time in
//                     (Earth geometrically visible) AND (specified load supplied)  within the mission window
//   dataCompleteness  the data needed for the decision and the score are adequate: pass; missing, too coarse or below
//                     the quality gates: unknown; service, parse or corrupt-data faults: error (never 'fail')
// Score, only for candidates whose four conditions pass and whose metrics are determined:
//   L = sunlit duration / mission duration, C = Earth geometric visibility duration / mission duration,
//   T = clamp(1 - footprint maximum slope / slope limit, 0, 1), S = 100 (wL L + wC C + wT T) with normalised weights.
// The score is a ranking preference, not a probability of landing success. No minimum score.
// Order: score quantised to 0.01 (round(S x 100), a transitive grouping) descending; historical before custom; within a
// group, spread (largest great-circle distance to the candidates already placed; engineering choice, see
// ASM-RECOMMEND-SPREAD); then stable ID. At most limits.maxRecommendations, never padded; custom sites are assessed
// but never fill recommendation slots.
import type { AssessmentModeName, CandidateRecord, ConditionReason, ConditionResult, Decision, PointSource, Quantity, Recommendation, SiteAssessment, SiteConditions } from './assessment'
import { notEvaluated, decisionSummary, summarizeConditions } from './assessment'
import type { EstimateInputs } from './regionalEvaluation'
import { assessSite } from './assessment'
import type { AdvancedSettings, ScoringWeights } from './mission'
import { normalizeWeights } from './mission'
import { surfaceDistanceM } from './catalog'
import { intersect } from '../physics/siteTimeline'
import type { Interval } from '../physics/siteTimeline'
import type { FootprintAssessment } from './footprint'
import type { EnergyResult } from './energy'
import type { MissionStatistics } from './events'
import type { SerializableSite } from './horizonData'

/** Resolution of Earth-visibility boundaries for the communication proof (events.ts minResolveMs). */
export const EARTH_BOUNDARY_MS = 10_000

export const SCORING_MODEL = 'score-v1.4:decision=mode(strict|relaxed);comm=conservative-overlap(supply-step,earth-10s);data-completeness=pass|unknown|error;S=100*(wL*L+wC*C+wT*T);L=sunlit/mission;C=earth-geometric/mission;T=clamp(1-slope/limit)(strict:footprint-slope,relaxed:regional-slope);tie=round(S*100);historical-first;spread=maximin-great-circle;stable-id'

/** What one candidate's assessment needs from steps 08-12 (plain data). */
export type CandidateInputs = {
  candidate: CandidateRecord
  footprint: Pick<FootprintAssessment, 'terrain' | 'slope' | 'data'>
  energy: Pick<EnergyResult, 'condition' | 'status' | 'supply' | 'earth' | 'window'> & { stepMs?: number; earthBoundaryMs?: number }
  statistics: Pick<MissionStatistics, 'window' | 'sunStatus' | 'earthStatus' | 'sunlitDuration' | 'earthVisibleDuration' | 'reasons'>
  /** Step 21: the full statistics and the site (with its horizon) behind them, kept for detail snapshots. Not used for ranking. */
  detail?: { statistics: MissionStatistics; site: SerializableSite }
  /** Regional estimate of the same point (relaxed mode). Absent in strict mode. */
  estimate?: EstimateInputs
  source?: PointSource
}

const total = (iv: Interval[]) => iv.reduce((s, i) => s + Math.max(0, i.end - i.start), 0)
const clip = (iv: Interval[], w: { startMs: number; endMs: number }) =>
  iv.map((i) => ({ start: Math.max(i.start, w.startMs), end: Math.min(i.end, w.endMs) })).filter((i) => i.end > i.start)
const merge = (iv: Interval[]) => {
  const s = [...iv].sort((a, b) => a.start - b.start), out: Interval[] = []
  for (const i of s) { const l = out[out.length - 1]; if (l && i.start <= l.end) l.end = Math.max(l.end, i.end); else out.push({ ...i }) }
  return out
}

/** Powered direct-to-Earth opportunity (geometry and supply only; no antenna, ground station or link budget). */
export function communicationCondition(e: CandidateInputs['energy']): ConditionResult {
  const w = e.window
  const limitations = ['Geometry and supply only: no antenna, ground station, link budget or relay is modelled.']
  const earthVisible = merge(clip(e.earth.visible, w)), earthPossible = merge(clip(e.earth.possible, w))
  // Proven absence of any Earth visibility does not depend on the energy result.
  if (total(earthPossible) === 0 && e.earth.search) {
    return { status: 'fail', reasons: [{ code: 'no-direct-earth-visibility', message: 'The Earth centre is never above the horizon and minimum elevation during the mission' }], limitations }
  }
  if (e.status === 'error' || !e.earth.search) return { status: 'error', reasons: e.condition.status === 'error' ? e.condition.reasons : [{ code: 'communication-not-computed', message: 'Earth visibility or supply could not be computed' }], limitations }
  // Conservative overlap: an interval boundary inside the mission window is only known to within its resolution, so it
  // is moved inwards by that resolution before intersecting (supply: the energy integration step; Earth visibility: the
  // event search's shortest resolved interval, 10 s). Window edges are exact. This is not a minimum window length.
  const shrink = (iv: Interval[], m: number) => iv
    .map((i) => ({ start: i.start > w.startMs ? i.start + m : i.start, end: i.end < w.endMs ? i.end - m : i.end }))
    .filter((i) => i.end > i.start)
  const proven = intersect(shrink(earthVisible, e.earthBoundaryMs ?? EARTH_BOUNDARY_MS), shrink(merge(clip(e.supply.proven, w)), e.stepMs ?? 0))
  const provenMs = total(proven)
  if (provenMs > 0) {
    return { status: 'pass', reasons: [], values: { poweredEarthWindowMs: { value: provenMs, unit: 'ms' } }, limitations }
  }
  const possibleMs = total(intersect(earthPossible, merge(clip(e.supply.possible, w))))
  if (possibleMs === 0) {
    return { status: 'fail', reasons: [{ code: 'no-powered-earth-window', message: 'No time with the Earth visible and the specified load supplied, even in the optimistic case' }], values: { poweredEarthWindowMs: { value: 0, unit: 'ms' } }, limitations }
  }
  const nominalMs = total(intersect(earthVisible, merge(clip(e.supply.proven, w))))
  return {
    status: 'unknown',
    reasons: nominalMs > 0 ? [{ code: 'powered-earth-window-boundary-uncertain', message: `A powered Earth window of ${Math.round(nominalMs / 1000)} s lies within the boundary uncertainty of the supply or visibility intervals` }] : [{ code: 'powered-earth-window-unproven', message: `A powered Earth window of up to ${Math.round(possibleMs / 60_000)} min is possible but not proven` }],
    values: { poweredEarthWindowMs: { value: null, unit: 'ms', reason: 'Earth visibility or supply not determined' } }, limitations,
  }
}

/** Whether the data needed for the decision and the score are adequate (pass / unknown / error; never 'fail'). */
export function dataCompletenessCondition(x: CandidateInputs): ConditionResult {
  const errors: ConditionReason[] = [], missing: ConditionReason[] = []
  if (x.footprint.data.status === 'error') errors.push(...x.footprint.data.reasons)
  else if (x.footprint.data.status !== 'pass') missing.push(...x.footprint.data.reasons.map((r) => ({ ...r, code: `data-${r.code}` })))
  if (x.energy.status === 'error') errors.push(...x.energy.condition.reasons)
  if (x.statistics.sunStatus === 'incomplete') missing.push({ code: 'data-sun-state-incomplete', message: 'Sunlight over the mission is not determined' })
  if (x.statistics.earthStatus === 'incomplete') missing.push({ code: 'data-earth-state-incomplete', message: 'Earth visibility over the mission is not determined' })
  if (errors.length) return { status: 'error', reasons: [...errors, ...missing] }
  if (missing.length) return { status: 'unknown', reasons: missing }
  return { status: 'pass', reasons: [] }
}

export type ScoreParts = { L: number; C: number; T: number }
export type CandidateEvaluation = {
  assessment: SiteAssessment
  origin: CandidateRecord['origin']
  lat: number; lon: number
  /** Present only for candidates that may be scored. */
  score: { value: number; quantized: number; parts: ScoreParts } | null
  scoreReason: ConditionReason | null
}

type ModeSettings = Pick<AdvancedSettings, 'weights' | 'slopeLimitDeg'> & Partial<Pick<AdvancedSettings, 'assessmentMode' | 'regionalSlopeLimitDeg'>>

const strictDecision = (conditions: SiteConditions, source: PointSource): Decision => {
  const summary = summarizeConditions(conditions)
  return { mode: 'strict', basis: 'evidence', source, eligible: summary.eligibleForRecommendation, conditions, summary, estimated: false, assumptions: [], risks: [], warnings: [], scale: null, dataUsed: [], versions: [] }
}

/** The relaxed decision: conditions of the regional estimate (terrain screen, nominal power, nominal communication, input sufficiency). */
function relaxedDecision(est: EstimateInputs, source: PointSource): Decision {
  const conditions: SiteConditions = {
    terrain: est.terrain, power: est.energy.condition, communication: communicationCondition({ ...est.energy, stepMs: est.energy.stepMs }), dataCompleteness: est.data,
  }
  const summary = summarizeConditions(conditions)
  return { mode: 'relaxed', basis: 'estimate', source, eligible: summary.eligibleForRecommendation, conditions, summary, estimated: true, assumptions: est.assumptions, risks: est.risks, warnings: est.warnings, scale: est.scale, dataUsed: est.dataUsed, versions: est.versions }
}

/** Score of a decision-eligible point. Strict: footprint slope; relaxed: regional slope (one scale for the whole ranking). */
function scoreOf(w: ReturnType<typeof normalizeWeights>, stats: { window: { startMs: number; endMs: number }; sunlitDuration: Quantity; earthVisibleDuration: Quantity }, slope: number | null, limit: number): { score: CandidateEvaluation['score']; reason: ConditionReason | null } {
  if (!w) return { score: null, reason: { code: 'invalid-weights', message: 'Score weights must be finite, non-negative and not all zero' } }
  const span = stats.window.endMs - stats.window.startMs
  const sun = stats.sunlitDuration.value, earth = stats.earthVisibleDuration.value
  if (sun === null || earth === null || slope === null || !(span > 0)) return { score: null, reason: { code: 'score-metric-missing', message: 'A score metric is not determined (never replaced by 0)' } }
  const parts = { L: sun / span, C: earth / span, T: Math.min(1, Math.max(0, 1 - slope / limit)) }
  const value = 100 * (w.sunlight * parts.L + w.earth * parts.C + w.terrain * parts.T)
  return { score: { value, quantized: Math.round(value * 100), parts }, reason: null }
}

function finishEvaluation(assessment: SiteAssessment, origin: CandidateRecord['origin'], lat: number, lon: number, settings: ModeSettings, stats: Pick<MissionStatistics, 'window' | 'sunlitDuration' | 'earthVisibleDuration'>, slope: number | null, limit: number): CandidateEvaluation {
  const base = { assessment, origin, lat, lon }
  if (!assessment.decision?.eligible && !(assessment.decision === undefined && assessment.summary.eligibleForRecommendation)) return { ...base, score: null, scoreReason: { code: 'not-eligible', message: 'Not every necessary condition passes' } }
  const r = scoreOf(normalizeWeights(settings.weights), stats, slope, limit)
  return { ...base, score: r.score, scoreReason: r.reason }
}

/**
 * Evidence conditions, the decision under the mode, and (when the decision is eligible) the score of one candidate.
 * `assessment.conditions` / `summary` always stay the strict evidence view; the decision is what recommendation reads.
 */
export function evaluateCandidate(x: CandidateInputs, settings: ModeSettings): CandidateEvaluation {
  const conditions: SiteConditions = {
    terrain: x.footprint.terrain,
    power: x.energy.condition,
    communication: communicationCondition(x.energy),
    dataCompleteness: dataCompletenessCondition(x),
  }
  const mode: AssessmentModeName = settings.assessmentMode ?? 'strict'
  const source: PointSource = x.source ?? (x.candidate.origin === 'historical' ? 'catalogue' : x.candidate.origin === 'search' ? 'search' : 'custom')
  let decision: Decision
  if (mode === 'relaxed') {
    decision = x.estimate ? relaxedDecision(x.estimate, source) : { ...strictDecision(conditions, source), mode: 'relaxed', basis: 'estimate', eligible: false, estimated: true, conditions: { ...conditions, dataCompleteness: { status: 'error', reasons: [{ code: 'estimate-not-computed', message: 'The regional estimate was not computed for this point' }] } } }
    if (!x.estimate) decision.summary = summarizeConditions(decision.conditions)
  } else decision = strictDecision(conditions, source)
  const assessment: SiteAssessment = { ...assessSite(x.candidate.id, conditions), decision }
  if (mode === 'relaxed') {
    const e = x.estimate
    return finishEvaluation(assessment, x.candidate.origin, x.candidate.lat, x.candidate.lon, settings, e?.statistics ?? x.statistics as MissionStatistics, e?.slopeDeg ?? null, settings.regionalSlopeLimitDeg ?? settings.slopeLimitDeg)
  }
  const slope = x.footprint.slope.status === 'pass' ? x.footprint.slope.values?.maxSlopeDeg?.value ?? null : null
  return finishEvaluation(assessment, x.candidate.origin, x.candidate.lat, x.candidate.lon, settings, x.statistics as MissionStatistics, slope, settings.slopeLimitDeg)
}

/**
 * A point with no evidence package (global search points, custom points away from the catalogue): the evidence view is "not
 * evaluated" and the decision comes from the regional estimate. Only meaningful in relaxed mode.
 */
export function evaluateEstimateOnly(candidate: CandidateRecord, est: EstimateInputs, settings: ModeSettings, source: PointSource): CandidateEvaluation {
  const none = (): ConditionResult => notEvaluated('Evidence assessment is not computed for this point (no site evidence package)')
  const conditions: SiteConditions = { terrain: none(), power: none(), communication: none(), dataCompleteness: none() }
  const assessment: SiteAssessment = { ...assessSite(candidate.id, conditions), decision: relaxedDecision(est, source) }
  return finishEvaluation(assessment, candidate.origin, candidate.lat, candidate.lon, settings, est.statistics, est.slopeDeg, settings.regionalSlopeLimitDeg ?? settings.slopeLimitDeg)
}

export type RankedCandidate = {
  siteId: string; rank: number; score: number; scoreQuantized: number; parts: ScoreParts; origin: CandidateRecord['origin']
  /** Great-circle distance to the nearest candidate ranked before it, m; null for the first. */
  nearestPreviousM: number | null
}

export type RecommendationResult = {
  status: 'ok' | 'invalid-settings'
  reasons: ConditionReason[]
  weights: ScoringWeights | null
  /** Up to limits.maxRecommendations, historical candidates only, never padded. Zero is a normal result. */
  recommendations: Recommendation[]
  /** Every scored candidate in order (includes custom sites, which never fill recommendation slots). */
  ranked: RankedCandidate[]
  /** All assessments, sorted by site ID. */
  evaluations: CandidateEvaluation[]
  /** Why candidates are not recommended, by kind; never merged into "unsafe". */
  excluded: {
    physicalFail: Array<{ siteId: string; reasons: ConditionReason[] }>
    insufficientData: Array<{ siteId: string; reasons: ConditionReason[] }>
    serviceError: Array<{ siteId: string; reasons: ConditionReason[] }>
    notScored: Array<{ siteId: string; reason: ConditionReason }>
    beyondLimit: string[]
    customNotRecommended: string[]
  }
  model: string
}

/** Deterministic order: quantised score, historical first, spread, stable ID. Independent of the input order. */
export function rankCandidates(scored: CandidateEvaluation[]): RankedCandidate[] {
  const pool = [...scored].filter((c) => c.score).sort((a, b) => (a.assessment.siteId < b.assessment.siteId ? -1 : a.assessment.siteId > b.assessment.siteId ? 1 : 0))
  const placed: CandidateEvaluation[] = []
  const out: RankedCandidate[] = []
  const groupKey = (c: CandidateEvaluation) => [-c.score!.quantized, c.origin === 'historical' ? 0 : 1]
  while (pool.length) {
    // The best group still in the pool.
    const best = pool.map(groupKey).reduce((m, k) => (k[0] < m[0] || (k[0] === m[0] && k[1] < m[1]) ? k : m))
    const group = pool.filter((c) => { const k = groupKey(c); return k[0] === best[0] && k[1] === best[1] })
    const nearest = (c: CandidateEvaluation) => (placed.length ? Math.min(...placed.map((p) => surfaceDistanceM(p, c))) : null)
    // Spread: largest distance to what is already placed; equal (within 1 mm) or nothing placed -> stable ID (pool is ID-sorted).
    let pick = group[0], pickD = nearest(group[0])
    for (const c of group.slice(1)) { const d = nearest(c); if (d !== null && pickD !== null && d > pickD + 1e-3) { pick = c; pickD = d } }
    pool.splice(pool.indexOf(pick), 1)
    placed.push(pick)
    out.push({ siteId: pick.assessment.siteId, rank: out.length + 1, score: pick.score!.value, scoreQuantized: pick.score!.quantized, parts: pick.score!.parts, origin: pick.origin, nearestPreviousM: pickD })
  }
  return out
}

/** Evaluate, rank and recommend. */
export function recommend(inputs: CandidateInputs[], settings: ModeSettings & Pick<AdvancedSettings, 'limits'>): RecommendationResult {
  const ids = inputs.map((x) => x.candidate.id)
  if (new Set(ids).size !== ids.length) throw new RangeError('Candidate IDs must be unique')
  return recommendEvaluations(inputs.map((x) => evaluateCandidate(x, settings)), settings)
}

/** Rank and recommend already evaluated candidates (catalogue, search and custom points all come through here). */
export function recommendEvaluations(all: CandidateEvaluation[], settings: Pick<AdvancedSettings, 'weights' | 'limits'>): RecommendationResult {
  const weights = normalizeWeights(settings.weights)
  const evaluations = [...all].sort((a, b) => (a.assessment.siteId < b.assessment.siteId ? -1 : 1))
  const excluded: RecommendationResult['excluded'] = { physicalFail: [], insufficientData: [], serviceError: [], notScored: [], beyondLimit: [], customNotRecommended: [] }
  for (const e of evaluations) {
    const s = decisionSummary(e.assessment)
    const reasons = s.reasons.map(({ code, message }) => ({ code, message }))
    if (s.failed.length) excluded.physicalFail.push({ siteId: e.assessment.siteId, reasons })
    else if (s.errored.length) excluded.serviceError.push({ siteId: e.assessment.siteId, reasons })
    else if (s.undetermined.length) excluded.insufficientData.push({ siteId: e.assessment.siteId, reasons })
    else if (!e.score && e.scoreReason) excluded.notScored.push({ siteId: e.assessment.siteId, reason: e.scoreReason })
  }
  if (!weights) {
    return { status: 'invalid-settings', reasons: [{ code: 'invalid-weights', message: 'Score weights must be finite, non-negative and not all zero' }], weights: null, recommendations: [], ranked: [], evaluations, excluded, model: SCORING_MODEL }
  }
  const ranked = rankCandidates(evaluations)
  const historical = ranked.filter((r) => r.origin === 'historical')
  const max = settings.limits.maxRecommendations
  const recommendations: Recommendation[] = historical.slice(0, max).map((r, i) => ({ siteId: r.siteId, rank: i + 1, score: r.score, parts: { sunlight: r.parts.L, earth: r.parts.C, terrain: r.parts.T } }))
  excluded.beyondLimit = historical.slice(max).map((r) => r.siteId)
  excluded.customNotRecommended = ranked.filter((r) => r.origin !== 'historical').map((r) => r.siteId)
  return { status: 'ok', reasons: [], weights, recommendations, ranked, evaluations, excluded, model: SCORING_MODEL }
}
