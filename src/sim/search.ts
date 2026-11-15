// Whole-Moon search (relaxed mode, only when no catalogue site qualifies): coarse grid -> cheap geometric screening -> batched full
// evaluation -> local refinement. It finds the best of the points it evaluated; it does not prove a global optimum, and a point that
// was not evaluated is never called unqualified. Two kinds of screening are kept apart in the report:
//   - proven exclusions: the same rule the full evaluation would apply, decided cheaply (regional slope at or above the limit; the
//     Earth centre cannot rise above the minimum elevation during the window even on a flat horizon, with the event search's own
//     rate bound as margin, so communication would fail 'no-direct-earth-visibility');
//   - heuristic ordering: flat-horizon geometric sunlight and Earth fractions and the regional slope decide which points are
//     evaluated first. Points that never get a full evaluation (cap or time) are counted as 'notEvaluated', not as failures.
// Full evaluation is the same estimate and decision as for catalogue and custom points (regionalEvaluation + recommend); a point
// found by search is not qualified because it came from search.
import type { AdvancedSettings, MissionWindow, SearchSettings } from './mission'
import { normalizeWeights } from './mission'
import type { CandidateRecord, ConditionStatus } from './assessment'
import { qualified, decisionSummary } from './assessment'
import type { CandidateEvaluation } from './recommend'
import { evaluateEstimateOnly, rankCandidates } from './recommend'
import { estimatePoint } from './regionalEvaluation'
import type { EstimateInputs } from './regionalEvaluation'
import { regionalSlope } from './regional'
import type { TiledHeights } from './globalTerrain'
import { RATE_BOUNDS } from './events'
import { moonFixedVectors } from '../physics/moonFrame'
import type { Vec3 } from '../physics/moonFrame'
import { MOON_R_KM, SUN_R_KM } from '../physics/siteSky'

export const SEARCH_MODEL = 'search-v1:coarse-grid(rings,cos-lat);screen=proven(regional-slope,no-earth-bound)+heuristic(flat-horizon-fractions);batches;refine=local-grid;best-of-evaluated'

export type GridPoint = { id: string; lat: number; lon: number }

const r2 = (v: number) => Math.round(v * 100) / 100
export const searchId = (lat: number, lon: number) => `search-${r2(lat).toFixed(2)}-${r2(lon).toFixed(2)}`

/**
 * Coarse grid: latitude rings every `stepDeg` from pole to pole (both poles are single points); on each ring the number of points
 * follows cos(latitude), so the spacing along the ring is about `stepDeg` everywhere and high latitudes are not oversampled.
 * Longitudes are offset by half a spacing (no point sits on the 180 degree seam), -180 <= lon < 180; deterministic and duplicate-free.
 */
export function coarseGrid(stepDeg: number): GridPoint[] {
  if (!(stepDeg >= 1) || stepDeg > 90) throw new RangeError('stepDeg must be between 1 and 90')
  const rows = Math.round(180 / stepDeg)
  const out: GridPoint[] = []
  for (let k = 0; k <= rows; k++) {
    const lat = -90 + (k * 180) / rows
    const poleDist = Math.abs(lat)
    const n = poleDist >= 90 - 1e-9 ? 1 : Math.max(1, Math.round((360 * Math.cos((lat * Math.PI) / 180)) / stepDeg))
    for (let j = 0; j < n; j++) {
      const lon = n === 1 ? 0 : -180 + ((j + 0.5) * 360) / n
      out.push({ id: searchId(lat, lon), lat, lon })
    }
  }
  return out
}

/** Refinement grid around a seed: spacing about `stepDeg` along both axes, within +/- halfWidthDeg in latitude, clamped at the poles. */
export function refineGrid(seed: GridPoint, stepDeg: number, halfWidthDeg: number): GridPoint[] {
  const out = new Map<string, GridPoint>()
  const n = Math.max(0, Math.round(halfWidthDeg / stepDeg))
  for (let i = -n; i <= n; i++) {
    const lat = Math.max(-90, Math.min(90, seed.lat + i * stepDeg))
    const cos = Math.max(0.02, Math.cos((lat * Math.PI) / 180))
    const m = Math.min(n * 6, Math.round((n * 1) / cos))
    const poleRow = Math.abs(lat) >= 90 - 1e-9
    for (let j = poleRow ? 0 : -m; j <= (poleRow ? 0 : m); j++) {
      const lon0 = poleRow ? 0 : seed.lon + (j * stepDeg) / cos
      const lon = ((((lon0 + 180) % 360) + 360) % 360) - 180
      const p = { id: searchId(lat, lon), lat, lon }
      out.set(p.id, p)
    }
  }
  return [...out.values()]
}

// ─── Cheap geometry ────────────────────────────────────────────────────────

export type SkySamples = { times: number[]; stepMs: number; earth: Vec3[]; sun: Vec3[] }

/** Moon-fixed Earth and Sun vectors at shared sample times (computed once, used by every grid point). */
export function skySamples(window: MissionWindow, maxSamples = 160, minStepMs = 30 * 60_000): SkySamples {
  const span = window.endMs - window.startMs
  const stepMs = Math.max(minStepMs, Math.ceil(span / (maxSamples - 1)))
  const times: number[] = []
  for (let t = window.startMs; t < window.endMs; t += stepMs) times.push(t)
  times.push(window.endMs)
  const earth: Vec3[] = [], sun: Vec3[] = []
  for (const t of times) { const v = moonFixedVectors(new Date(t)); earth.push(v.earthKm); sun.push(v.sunKm) }
  return { times, stepMs, earth, sun }
}

const DEG = Math.PI / 180
function elevationDeg(up: Vec3, target: Vec3, r: number): { el: number; dist: number } {
  const u = target[0] * up[0] + target[1] * up[1] + target[2] * up[2] - r
  const d2 = (target[0] - up[0] * r) ** 2 + (target[1] - up[1] * r) ** 2 + (target[2] - up[2] * r) ** 2
  return { el: Math.atan2(u, Math.sqrt(Math.max(0, d2 - u * u))) / DEG, dist: Math.sqrt(d2) }
}

export type GeometricScreen = {
  /** Flat-horizon fractions of the samples (heuristic upper bounds for terrain-free sky; terrain can only lower them). */
  sunFraction: number
  earthFraction: number
  maxEarthElevationDeg: number
  /** Proven: even on a flat horizon the Earth centre stays below the minimum elevation for the whole window (rate-bound margin included). */
  provenNoEarth: boolean
}

export function geometricScreen(sky: SkySamples, lat: number, lon: number, earthMinElevationDeg: number): GeometricScreen {
  const la = lat * DEG, lo = lon * DEG
  const up: Vec3 = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]
  let sunUp = 0, earthUp = 0, maxEarth = -90
  for (let i = 0; i < sky.times.length; i++) {
    const e = elevationDeg(up, sky.earth[i], MOON_R_KM)
    const s = elevationDeg(up, sky.sun[i], MOON_R_KM)
    if (e.el > earthMinElevationDeg) earthUp++
    if (e.el > maxEarth) maxEarth = e.el
    if (s.el + Math.asin(SUN_R_KM / s.dist) / DEG > 0) sunUp++
  }
  // Between samples the Earth direction moves by at most RATE_BOUNDS.earthDegPerHour * step; the Earth's own radius is not added (centre rule).
  const margin = RATE_BOUNDS.earthDegPerHour * (sky.stepMs / 3_600_000)
  return { sunFraction: sunUp / sky.times.length, earthFraction: earthUp / sky.times.length, maxEarthElevationDeg: maxEarth, provenNoEarth: maxEarth + margin <= earthMinElevationDeg }
}

// ─── Search ────────────────────────────────────────────────────────────────

export type SearchStopReason = 'finished' | 'evaluation-cap' | 'time-budget' | 'no-points' | 'data-unavailable'

export type SearchCoverage = {
  coarsePoints: number
  /** Decided without a full evaluation by a rule the full evaluation would also apply (exact, not heuristic). */
  provenExcluded: { regionalSlope: number; noEarthPossible: number; noTerrainData: number }
  /** Screened in, queued by heuristic priority. */
  screenedIn: number
  fullyEvaluated: number
  qualifying: number
  /** Full evaluations that did not qualify, by the status of their worst condition. */
  notQualifying: { fail: number; unknown: number; error: number }
  /** Full evaluations that failed to run (exception) or lacked inputs. */
  failed: number
  missingData: number
  /** Screened-in points that never got a full evaluation (cap or time): not called unqualified. */
  notEvaluated: number
  refinement: { seeds: GridPoint[]; halfWidthDeg: number; stepDeg: number; points: number; evaluated: number }
}

export type SearchEntry = { evaluation: CandidateEvaluation; estimate: EstimateInputs }

export type SearchOutcome = {
  model: string
  status: 'complete' | 'partial' | 'unavailable'
  reason: SearchStopReason
  /** Plain-language reason a partial or unavailable search stopped. */
  message: string
  config: SearchSettings
  coverage: SearchCoverage
  elapsedMs: number
  /** Global terrain tiles the search needed (loaded in the Worker once and kept for its life; the browser also caches the files). */
  terrain?: { tilesLoaded: number; compressedBytes: number; loadMs: number }
  /** Best qualifying points among those evaluated, ranked (at most maxRecommendations), score order with the spread rule. */
  results: SearchEntry[]
}

export type SearchContext = {
  heights: TiledHeights
  settings: AdvancedSettings
  window: MissionWindow
  /** Cooperative cancel point (the job's check: yields and throws when cancelled). */
  check: () => Promise<void>
  now: () => number
  /** Absolute time (ms, same clock as now) after which no new batch starts. */
  deadlineMs: number
  progress?: (p: { phase: 'screen' | 'evaluate' | 'refine'; done: number; total: number }) => void
  /** Replaceable for tests. */
  evaluate?: (p: GridPoint, c: SearchContext) => SearchEntry
}

const BATCH = 12
const KEEP = 24

export function defaultEvaluate(p: GridPoint, c: SearchContext): SearchEntry {
  const est = estimatePoint({ id: p.id, name: `Search point ${p.lat.toFixed(2)}°, ${p.lon.toFixed(2)}°`, lat: p.lat, lon: p.lon, heights: c.heights, settings: c.settings, window: c.window })
  const rec: CandidateRecord = { id: p.id, name: `Search point ${p.lat.toFixed(2)}°, ${p.lon.toFixed(2)}°`, origin: 'search', lat: p.lat, lon: p.lon, frame: 'global grid point (DE421 mean Earth)' }
  return { evaluation: evaluateEstimateOnly(rec, est, c.settings, 'search'), estimate: est }
}

export async function runSearch(c: SearchContext): Promise<SearchOutcome> {
  const cfg = c.settings.search
  const t0 = c.now()
  const cover: SearchCoverage = {
    coarsePoints: 0, provenExcluded: { regionalSlope: 0, noEarthPossible: 0, noTerrainData: 0 }, screenedIn: 0, fullyEvaluated: 0, qualifying: 0,
    notQualifying: { fail: 0, unknown: 0, error: 0 }, failed: 0, missingData: 0, notEvaluated: 0,
    refinement: { seeds: [], halfWidthDeg: cfg.coarseStepDeg / 2, stepDeg: cfg.refineStepDeg, points: 0, evaluated: 0 },
  }
  const out = (status: SearchOutcome['status'], reason: SearchStopReason, message: string, results: SearchEntry[]): SearchOutcome => ({ model: SEARCH_MODEL, status, reason, message, config: { ...cfg }, coverage: cover, elapsedMs: c.now() - t0, results })
  const w = normalizeWeights(c.settings.weights)
  if (!w) return out('unavailable', 'data-unavailable', 'Score weights are invalid', [])
  const evaluate = c.evaluate ?? defaultEvaluate
  const limit = c.settings.regionalSlopeLimitDeg

  // 1. Coarse grid and cheap screening.
  const grid = coarseGrid(cfg.coarseStepDeg)
  cover.coarsePoints = grid.length
  const sky = skySamples(c.window)
  const queue: Array<{ p: GridPoint; priority: number }> = []
  for (const [i, p] of grid.entries()) {
    const slope = regionalSlope(c.heights, p.lat, p.lon)
    if (!slope) { cover.provenExcluded.noTerrainData++; cover.missingData++; continue }
    if (slope.slopeDeg >= limit) { cover.provenExcluded.regionalSlope++; continue }
    const g = geometricScreen(sky, p.lat, p.lon, c.settings.earthMinElevationDeg)
    if (g.provenNoEarth) { cover.provenExcluded.noEarthPossible++; continue }
    const T = Math.min(1, Math.max(0, 1 - slope.slopeDeg / limit))
    queue.push({ p, priority: w.sunlight * g.sunFraction + w.earth * g.earthFraction + w.terrain * T })
    if (i % 200 === 199) { c.progress?.({ phase: 'screen', done: i + 1, total: grid.length }); await c.check() }
  }
  queue.sort((a, b) => b.priority - a.priority || (a.p.id < b.p.id ? -1 : 1))
  cover.screenedIn = queue.length
  c.progress?.({ phase: 'screen', done: grid.length, total: grid.length })
  if (queue.length === 0) return out('complete', 'no-points', 'No coarse point survived the geometric screening', [])

  // 2. Batched full evaluation under the cap and the time budget.
  const kept: SearchEntry[] = []
  const seen = new Set<string>()
  let stop: SearchStopReason | null = null
  const classify = (e: SearchEntry) => {
    const s = decisionSummary(e.evaluation.assessment)
    if (qualified(e.evaluation.assessment) && e.evaluation.score) { cover.qualifying++; kept.push(e); kept.sort((a, b) => b.evaluation.score!.quantized - a.evaluation.score!.quantized); kept.length = Math.min(kept.length, KEEP); return }
    const worst: ConditionStatus = s.errored.length ? 'error' : s.failed.length ? 'fail' : 'unknown'
    if (qualified(e.evaluation.assessment)) cover.failed++ // eligible but unscorable (a metric missing)
    else cover.notQualifying[worst === 'error' ? 'error' : worst === 'fail' ? 'fail' : 'unknown']++
  }
  const runBatch = async (list: GridPoint[], phase: 'evaluate' | 'refine', total: number, doneBefore: number): Promise<boolean> => {
    for (let i = 0; i < list.length; i += BATCH) {
      if (cover.fullyEvaluated + cover.failed >= cfg.maxFullEvaluations) { stop = 'evaluation-cap'; return false }
      if (c.now() >= c.deadlineMs || c.now() - t0 >= cfg.budgetMs) { stop = 'time-budget'; return false }
      for (const p of list.slice(i, i + BATCH)) {
        if (cover.fullyEvaluated + cover.failed >= cfg.maxFullEvaluations) { stop = 'evaluation-cap'; return false }
        seen.add(p.id)
        try { const e = evaluate(p, c); cover.fullyEvaluated++; if (phase === 'refine') cover.refinement.evaluated++; classify(e) }
        catch { cover.failed++ }
      }
      c.progress?.({ phase, done: doneBefore + Math.min(i + BATCH, list.length), total })
      await c.check()
    }
    return true
  }
  // Keep a share of the cap for refinement (a third), so a cap reached in the coarse stage still refines the best regions.
  const coarseCap = Math.max(1, Math.ceil(cfg.maxFullEvaluations * (cfg.refineSeeds > 0 ? 2 / 3 : 1)))
  const coarseList = queue.map((q) => q.p)
  const fullCap = cfg.maxFullEvaluations
  // Coarse stage limited to coarseCap evaluations.
  const coarseTargets = coarseList.slice(0, coarseCap)
  const finishedCoarse = await runBatch(coarseTargets, 'evaluate', Math.min(coarseList.length, coarseCap), 0)
  const coarseStop = stop as SearchStopReason | null
  if (!finishedCoarse && coarseStop === 'time-budget') return finish()
  stop = null

  // 3. Local refinement around the best coarse regions (qualifying first; else the best-prioritised evaluated points).
  if (cfg.refineSeeds > 0) {
    const ranked = rankCandidates(kept.map((k) => k.evaluation)).slice(0, cfg.refineSeeds)
    const seeds: GridPoint[] = ranked.map((r) => ({ id: r.siteId, lat: kept.find((k) => k.evaluation.assessment.siteId === r.siteId)!.evaluation.lat, lon: kept.find((k) => k.evaluation.assessment.siteId === r.siteId)!.evaluation.lon }))
    if (seeds.length === 0) for (const q of queue.slice(0, cfg.refineSeeds)) seeds.push(q.p)
    cover.refinement.seeds = seeds
    const cells = new Map<string, GridPoint>()
    for (const s of seeds) for (const p of refineGrid(s, cfg.refineStepDeg, cfg.coarseStepDeg / 2)) if (!seen.has(p.id)) cells.set(p.id, p)
    cover.refinement.points = cells.size
    const list = [...cells.values()]
    await runBatch(list, 'refine', list.length, 0)
  }
  // Whatever the coarse stage left over (within the overall cap) is evaluated last.
  if (!stop && cover.fullyEvaluated + cover.failed < fullCap) await runBatch(coarseList.slice(coarseCap).filter((p) => !seen.has(p.id)), 'evaluate', coarseList.length, coarseCap)
  return finish()

  function finish(): SearchOutcome {
    const evaluated = new Set(seen)
    cover.notEvaluated = queue.filter((q) => !evaluated.has(q.p.id)).length
    const ranked = rankCandidates(kept.map((k) => k.evaluation))
    const max = c.settings.limits.maxRecommendations
    const results = ranked.slice(0, max).map((r) => kept.find((k) => k.evaluation.assessment.siteId === r.siteId)!)
    const complete = cover.notEvaluated === 0
    const reason: SearchStopReason = complete ? 'finished' : (stop ?? 'evaluation-cap')
    const message = complete ? 'Every point that survived the screening was fully evaluated, and the best regions were refined.'
      : reason === 'time-budget' ? 'The search stopped at its time budget; the result is the best of the points evaluated so far. It does not say that no better point exists.'
      : `The search reached its cap of ${cfg.maxFullEvaluations} full evaluations; ${cover.notEvaluated} screened-in point(s) were not evaluated. The result is the best of the points evaluated, not a proof of the global best.`
    return out(complete ? 'complete' : 'partial', reason, message, results)
  }
}

