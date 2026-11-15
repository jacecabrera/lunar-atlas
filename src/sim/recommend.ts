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
import type { CandidateRecord, ConditionReason, ConditionResult, Recommendation, SiteAssessment, SiteConditions } from './assessment'
import { assessSite } from './assessment'
import type { AdvancedSettings, ScoringWeights } from './mission'
import { normalizeWeights } from './mission'
import { surfaceDistanceM } from './catalog'
import { intersect } from '../physics/siteTimeline'
import type { Interval } from '../physics/siteTimeline'
import type { FootprintAssessment } from './footprint'
import type { EnergyResult } from './energy'
import type { MissionStatistics } from './events'

export const SCORING_MODEL = 'score-v1.2:comm-window>step;data-completeness=pass|unknown|error;S=100*(wL*L+wC*C+wT*T);L=sunlit/mission;C=earth-geometric/mission;T=clamp(1-slope/limit);tie=round(S*100);historical-first;spread=maximin-great-circle;stable-id'

/** What one candidate's assessment needs from steps 08-12 (plain data). */
export type CandidateInputs = {
  candidate: CandidateRecord
  footprint: Pick<FootprintAssessment, 'terrain' | 'slope' | 'data'>
  energy: Pick<EnergyResult, 'condition' | 'status' | 'supply' | 'earth' | 'window'> & { stepMs?: number }
  statistics: Pick<MissionStatistics, 'window' | 'sunStatus' | 'earthStatus' | 'sunlitDuration' | 'earthVisibleDuration' | 'reasons'>
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
  const proven = intersect(earthVisible, merge(clip(e.supply.proven, w)))
  const provenMs = total(proven)
  // Supply boundaries are only resolved to the energy integration step: a proven window no longer than one step could be
  // an artefact of where a step boundary falls, so it is not accepted as proof.
  const resolutionMs = e.stepMs ?? 0
  if (provenMs > resolutionMs) {
    return { status: 'pass', reasons: [], values: { poweredEarthWindowMs: { value: provenMs, unit: 'ms' } }, limitations }
  }
  if (provenMs > 0) {
    return { status: 'unknown', reasons: [{ code: 'powered-earth-window-below-resolution', message: `The proven powered Earth window (${Math.round(provenMs / 1000)} s) is not longer than the ${Math.round(resolutionMs / 60_000)} min integration step` }], values: { poweredEarthWindowMs: { value: null, unit: 'ms', reason: 'Below the integration resolution' } }, limitations }
  }
  const possibleMs = total(intersect(earthPossible, merge(clip(e.supply.possible, w))))
  if (possibleMs === 0) {
    return { status: 'fail', reasons: [{ code: 'no-powered-earth-window', message: 'No time with the Earth visible and the specified load supplied, even in the optimistic case' }], values: { poweredEarthWindowMs: { value: 0, unit: 'ms' } }, limitations }
  }
  return {
    status: 'unknown',
    reasons: [{ code: 'powered-earth-window-unproven', message: `A powered Earth window of up to ${Math.round(possibleMs / 60_000)} min is possible but not proven` }],
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

/** Conditions, summary and (when eligible) the score of one candidate. */
export function evaluateCandidate(x: CandidateInputs, settings: Pick<AdvancedSettings, 'weights' | 'slopeLimitDeg'>): CandidateEvaluation {
  const conditions: SiteConditions = {
    terrain: x.footprint.terrain,
    power: x.energy.condition,
    communication: communicationCondition(x.energy),
    dataCompleteness: dataCompletenessCondition(x),
  }
  const assessment = assessSite(x.candidate.id, conditions)
  const base = { assessment, origin: x.candidate.origin, lat: x.candidate.lat, lon: x.candidate.lon }
  if (!assessment.summary.eligibleForRecommendation) return { ...base, score: null, scoreReason: { code: 'not-eligible', message: 'Not every necessary condition passes' } }
  const w = normalizeWeights(settings.weights)
  if (!w) return { ...base, score: null, scoreReason: { code: 'invalid-weights', message: 'Score weights must be finite, non-negative and not all zero' } }
  const span = x.statistics.window.endMs - x.statistics.window.startMs
  const sun = x.statistics.sunlitDuration.value, earth = x.statistics.earthVisibleDuration.value
  const slope = x.footprint.slope.status === 'pass' ? x.footprint.slope.values?.maxSlopeDeg?.value ?? null : null
  if (sun === null || earth === null || slope === null || !(span > 0)) {
    return { ...base, score: null, scoreReason: { code: 'score-metric-missing', message: 'A score metric is not determined (never replaced by 0)' } }
  }
  const parts = { L: sun / span, C: earth / span, T: Math.min(1, Math.max(0, 1 - slope / settings.slopeLimitDeg)) }
  const value = 100 * (w.sunlight * parts.L + w.earth * parts.C + w.terrain * parts.T)
  return { ...base, score: { value, quantized: Math.round(value * 100), parts }, scoreReason: null }
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
export function recommend(inputs: CandidateInputs[], settings: Pick<AdvancedSettings, 'weights' | 'slopeLimitDeg' | 'limits'>): RecommendationResult {
  const ids = inputs.map((x) => x.candidate.id)
  if (new Set(ids).size !== ids.length) throw new RangeError('Candidate IDs must be unique')
  const weights = normalizeWeights(settings.weights)
  const evaluations = inputs.map((x) => evaluateCandidate(x, settings)).sort((a, b) => (a.assessment.siteId < b.assessment.siteId ? -1 : 1))
  const excluded: RecommendationResult['excluded'] = { physicalFail: [], insufficientData: [], serviceError: [], notScored: [], beyondLimit: [], customNotRecommended: [] }
  for (const e of evaluations) {
    const s = e.assessment.summary
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
