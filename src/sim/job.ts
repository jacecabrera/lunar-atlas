// One mission calculation (step 15): prepare data, evaluate candidates, filter and rank, estimate transits, build the
// result. Runs inside the mission Worker (sim/worker/missionWorker.ts) and in tests; plain data in and out.
//
// Messages between the main thread and the Worker carry only structured-clone data: the job (input snapshot,
// settings, site IDs, versions, terrain base URL) and progress / result / error / cancelled replies. No functions,
// store objects, Horizon functions or class instances cross the boundary; the Worker rebuilds terrain and visibility
// models itself. Terrain files are fetched by the Worker (its own siteTerrain store, cached for the Worker's life;
// failures are not cached), so no ArrayBuffer is transferred and no buffer ownership is shared.
import type { CandidateCatalog } from './catalog'
import { loadCandidateCatalog } from './catalog'
import type { AdvancedSettings, MissionInput } from './mission'
import { missionWindow } from './mission'
import type { ModelVersions, PointData, SearchReport, TaskError, TaskResult } from './task'
import { runSearch, SEARCH_MODEL } from './search'
import type { SearchEntry } from './search'
import type { MissionWindow } from './mission'
import type { SiteTerrainStore } from './siteTerrain'
import type { GlobalTerrainStore } from './globalTerrain'
import type { RegionalContext } from './candidateEvaluation'
import { TerrainLoadError } from './siteTerrain'
import { catalogCandidateInputs, missionTransits } from './candidateEvaluation'
import type { CandidateRun } from './candidateEvaluation'
import { recommend, evaluateCandidate } from './recommend'
import { assessFootprint, footprintConfig } from './footprint'
import { visibilityModel } from './visibility'
import { missionStatistics } from './events'
import { assessEnergy } from './energy'
import type { CandidateInputs } from './recommend'
import { assessSite, qualified } from './assessment'
import { REGIONAL_RANGE_KM } from './regional'
import { estimatePoint } from './regionalEvaluation'
import { evaluateEstimateOnly } from './recommend'
import { regionalObserverRadiusKm } from './regional'
import { estimateTransit } from './transit'
import type { TransitEstimate } from './transit'
import type { ConditionResult, SiteAssessment } from './assessment'
import { TIME_SCALE_MODEL, ttMinusUtcSeconds } from '../physics/timeScale'

// 2: step 19 added single-site evaluation of custom points (evaluate-site / site-result / site-error).
// 3: step 20 wrap-up: SiteJob carries terrainBaseUrl (a custom point at a catalogue coordinate reuses that terrain).
// 4: step 20: 'site-result' may carry the point's transit estimate (computed once in the Worker, used by the route line).
// 5: step 21: TaskResult.pointData and 'site-result'.pointData (full statistics + site horizon of valid points, for snapshots).
// 6: regional estimate: MissionJob/SiteJob carry globalTerrainBaseUrl; TaskResult.mode and (later) the whole-Moon search.
export const JOB_PROTOCOL_VERSION = 6

export type MissionJob = {
  protocol: number
  requestId: string
  fingerprint: string
  versions: ModelVersions
  input: MissionInput
  settings: AdvancedSettings
  siteIds: string[]
  /** Absolute URL of public/data/terrain/v1/ for the deployed base path. */
  terrainBaseUrl: string
  /** Absolute time (ms, Date.now clock of the Worker) after which no new search batch starts; keeps the search inside the task budget. */
  deadlineAtMs?: number
  /** Absolute URL of public/data/terrain/global-v1/ (the global terrain used by the regional estimate and the search). */
  globalTerrainBaseUrl: string
}

/** One custom point, evaluated with the same rules as the catalogue candidates (step 19). */
export type SiteJob = {
  protocol: number
  requestId: string
  /** Fingerprint of the mission task the point belongs to: a result only counts for that task. */
  taskFingerprint: string
  site: { id: string; name: string; lat: number; lon: number }
  input: MissionInput
  settings: AdvancedSettings
  /** Absolute URL of the published terrain (used only when the point is exactly a catalogue coordinate). */
  terrainBaseUrl: string
  globalTerrainBaseUrl: string
}

/** Same point: equal coordinates to 1e-9 deg (no nearest-neighbour matching, no snapping). */
export const SAME_SITE_TOLERANCE_DEG = 1e-9

export type ToWorker = { type: 'run'; job: MissionJob } | { type: 'evaluate-site'; job: SiteJob } | { type: 'cancel'; requestId: string }
export type FromWorker =
  | { type: 'ready'; protocol: number; timeScale: { model: string; ttMinusUtcSeconds2026: number; libraryDeltaTSeconds2026: number } }
  | { type: 'progress'; requestId: string; done: number; total: number; siteId: string | null; phase: 'terrain' | 'evaluate' | 'rank' | 'transit' | 'search-terrain' | 'search-screen' | 'search-evaluate' | 'search-refine' }
  | { type: 'result'; requestId: string; result: TaskResult }
  | { type: 'error'; requestId: string; error: TaskError }
  | { type: 'cancelled'; requestId: string }
  | { type: 'site-result'; requestId: string; siteId: string; assessment: SiteAssessment; transit?: TransitEstimate; pointData?: PointData }
  | { type: 'site-error'; requestId: string; siteId: string; message: string }

export class JobCancelled extends Error {
  constructor() { super('cancelled'); this.name = 'JobCancelled' }
}

export type JobContext = {
  terrain: SiteTerrainStore
  /** Global terrain (relaxed mode). Absent in tests of strict mode. */
  globalTerrain?: GlobalTerrainStore
  isCancelled: () => boolean
  progress: (m: Omit<Extract<FromWorker, { type: 'progress' }>, 'type' | 'requestId'>) => void
  /** Give the event loop a turn so a cancel message can arrive (cooperative cancellation). */
  yieldNow: () => Promise<void>
  catalog?: CandidateCatalog
  now?: () => number
}

const failed = (code: string, message: string): ConditionResult => ({ status: 'error', reasons: [{ code, message }] })

/** Estimates of the search results of the current job (kept to build point data); cleared per job. */
const searchEntries = new Map<string, SearchEntry>()

async function runSearchStage(job: MissionJob, ctx: JobContext, check: () => Promise<void>, now: () => number): Promise<SearchReport> {
  const cfg = job.settings.search
  const unavailable = (message: string): SearchReport => ({
    model: SEARCH_MODEL, status: 'unavailable', reason: 'data-unavailable', message, config: { ...cfg }, elapsedMs: 0, results: [],
    coverage: { coarsePoints: 0, provenExcluded: { regionalSlope: 0, noEarthPossible: 0, noTerrainData: 0 }, screenedIn: 0, fullyEvaluated: 0, qualifying: 0, notQualifying: { fail: 0, unknown: 0, error: 0 }, failed: 0, missingData: 0, notEvaluated: 0, refinement: { seeds: [], halfWidthDeg: cfg.coarseStepDeg / 2, stepDeg: cfg.refineStepDeg, points: 0, evaluated: 0 } },
  })
  if (!ctx.globalTerrain) return unavailable('The global terrain data source is not available, so no whole-Moon search was run')
  ctx.progress({ done: 0, total: 1, siteId: null, phase: 'search-terrain' })
  let heights
  try { heights = await ctx.globalTerrain.ensureAll() } catch (e) { return unavailable(`The global terrain tiles could not be loaded (${e instanceof Error ? e.message : String(e)}); no whole-Moon search was run`) }
  ctx.progress({ done: 1, total: 1, siteId: null, phase: 'search-terrain' })
  await check()
  searchEntries.clear()
  const window: MissionWindow = missionWindow(job.input)
  const t0 = now()
  const outcome = await runSearch({
    heights, settings: job.settings, window, check, now,
    deadlineMs: Math.min(job.deadlineAtMs ?? Infinity, t0 + cfg.budgetMs),
    progress: (p) => ctx.progress({ done: p.done, total: p.total, siteId: null, phase: p.phase === 'screen' ? 'search-screen' : p.phase === 'evaluate' ? 'search-evaluate' : 'search-refine' }),
  })
  const results = outcome.results.map((e, i) => {
    const ev = e.evaluation, id = ev.assessment.siteId
    searchEntries.set(id, e)
    const r = estimateTransit({
      landingTimeMs: job.input.landingTimeMs, launchSite: job.input.launchSite,
      destination: { lat: ev.lat, lon: ev.lon, radiusKm: regionalObserverRadiusKm(heights.heightAt(ev.lat, ev.lon) ?? NaN) || null, elevationSource: 'LDEM_16 global terrain (regional estimate)' }, speedKmPerS: job.settings.transitSpeedKmPerS,
    })
    return { siteId: id, name: `Search point ${ev.lat.toFixed(2)}°, ${ev.lon.toFixed(2)}°`, lat: ev.lat, lon: ev.lon, rank: i + 1, score: ev.score!.value, parts: { sunlight: ev.score!.parts.L, earth: ev.score!.parts.C, terrain: ev.score!.parts.T }, assessment: ev.assessment, transit: r }
  })
  const st = ctx.globalTerrain.stats()
  return { ...outcome, terrain: { tilesLoaded: st.tilesFetched, compressedBytes: st.bytesFetched, loadMs: st.tileLoadMs }, results }
}

/** Run one job. Throws JobCancelled when cancelled; other throws are task-level errors. */
export async function runMissionJob(job: MissionJob, ctx: JobContext): Promise<TaskResult> {
  if (job.protocol !== JOB_PROTOCOL_VERSION) throw new Error(`Job protocol ${job.protocol} is not supported`)
  const now = ctx.now ?? Date.now
  const catalog = ctx.catalog ?? loadCandidateCatalog()
  const window = missionWindow(job.input)
  const check = async () => { await ctx.yieldNow(); if (ctx.isCancelled()) throw new JobCancelled() }
  const candidates = job.siteIds.map((id) => {
    const c = catalog.candidates.find((x) => x.id === id)
    if (!c) throw new Error(`Unknown candidate ${id}`)
    return c
  })

  // Terrain: shared, de-duplicated loads; a failure stays a per-site TerrainLoadError (unknown/error later, never fail).
  const runs: CandidateRun[] = []
  for (const [i, c] of candidates.entries()) {
    let terrain: CandidateRun['terrain']
    try { terrain = await ctx.terrain.load(c.id) } catch (e) { terrain = e instanceof TerrainLoadError ? e : new TerrainLoadError('network', String(e)) }
    runs.push({ candidate: c, terrain })
    ctx.progress({ done: i + 1, total: candidates.length, siteId: c.id, phase: 'terrain' })
    await check()
  }

  // Evaluation, one candidate at a time; a failing candidate becomes service errors, the others are kept.
  const inputs: CandidateInputs[] = []
  const errored: SiteAssessment[] = []
  const relaxed = job.settings.assessmentMode === 'relaxed'
  for (const [i, run] of runs.entries()) {
    try {
      // Relaxed: the global terrain around the site (tiles shared and loaded once); a failure is stated, never replaced by a guess.
      let regional: RegionalContext | undefined
      if (relaxed) {
        if (!ctx.globalTerrain) regional = { heights: null, problem: { code: 'estimate-no-global-terrain', message: 'The global terrain data source is not available' } }
        else {
          try { regional = { heights: await ctx.globalTerrain.ensureAround(run.candidate.coordinate.lat, run.candidate.coordinate.lon, REGIONAL_RANGE_KM) } }
          catch (e) { regional = { heights: ctx.globalTerrain.manifestLoaded() ? ctx.globalTerrain.heights() : null, problem: { code: 'estimate-global-terrain-failed', message: `Global terrain tiles could not be loaded: ${e instanceof Error ? e.message : String(e)}` } } }
        }
      }
      inputs.push(catalogCandidateInputs(run, catalog, job.settings, window, { regional }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const x = failed('evaluation-failed', msg)
      errored.push(assessSite(run.candidate.id, { terrain: x, power: x, communication: x, dataCompleteness: x }))
    }
    ctx.progress({ done: i + 1, total: runs.length, siteId: run.candidate.id, phase: 'evaluate' })
    await check()
  }
  ctx.progress({ done: 0, total: 1, siteId: null, phase: 'rank' })
  const rec = recommend(inputs, job.settings)
  if (rec.status !== 'ok') throw new Error(rec.reasons.map((r) => r.message).join('; '))
  const pointData: Record<string, PointData> = {}
  for (const r of rec.recommendations) {
    const d = inputs.find((x) => x.candidate.id === r.siteId)?.detail
    if (d) pointData[r.siteId] = d
  }
  const transits = missionTransits(rec.recommendations.map((r) => r.siteId), runs, job.input, job.settings)
  ctx.progress({ done: 1, total: 1, siteId: null, phase: 'transit' })
  await check()

  // Whole-Moon search: relaxed mode only, and only when no catalogue site qualifies. Strict never switches to relaxed.
  let search: SearchReport | undefined
  if (relaxed && job.settings.search.enabled && rec.recommendations.length === 0) {
    search = await runSearchStage(job, ctx, check, now)
    for (const r of search.results) {
      const e = searchEntries.get(r.siteId)
      if (e) pointData[r.siteId] = { statistics: e.estimate.statistics, site: e.estimate.site }
    }
  }

  const sites = [...rec.evaluations.map((e) => e.assessment), ...errored].sort((a, b) => (a.siteId < b.siteId ? -1 : 1))
  const serviceError = [...rec.excluded.serviceError, ...errored.map((a) => ({ siteId: a.siteId, reasons: a.summary.reasons.map(({ code, message }) => ({ code, message })) }))]
  return {
    requestId: job.requestId, fingerprint: job.fingerprint, versions: job.versions, completedAtMs: now(),
    sites, recommendations: rec.recommendations, outcome: rec.recommendations.length ? 'recommendations' : 'no-eligible-sites',
    evaluation: { ranked: rec.ranked, excluded: { ...rec.excluded, serviceError }, weights: rec.weights, model: rec.model },
    transits, pointData, mode: job.settings.assessmentMode, search,
    runtime: { timeScaleModel: TIME_SCALE_MODEL, ttMinusUtcSecondsAtLanding: ttMinusUtcSeconds(job.input.landingTimeMs), protocol: JOB_PROTOCOL_VERSION },
  }
}

/**
 * Evaluate one custom point (steps 19-20). A point whose coordinates equal a catalogue site's (to 1e-9 deg; same frame
 * convention and the same 0 m observer height as the terrain packages) reuses that site's published terrain and
 * hardware evidence, so it is assessed exactly like the catalogue site for this task (reuse is not eligibility: poor
 * data stays unknown). Any other point has no terrain product: footprint and horizon are unknown ('terrain-no-product');
 * no nearby site is borrowed, the point is not moved, no smooth-sphere fallback, and no terrain file is requested.
 * Terrain-independent conclusions still hold (e.g. the Earth never above the horizon from the far side).
 */
export async function runCustomSiteJob(job: SiteJob, ctx: { terrain?: SiteTerrainStore; globalTerrain?: GlobalTerrainStore; catalog?: CandidateCatalog } = {}): Promise<SiteAssessment> {
  return (await runCustomSiteJobDetailed(job, ctx)).assessment
}

/** Global terrain around a point for the regional estimate, or the stated reason it is not available. */
async function regionalFor(ctx: { globalTerrain?: GlobalTerrainStore }, lat: number, lon: number): Promise<RegionalContext> {
  if (!ctx.globalTerrain) return { heights: null, problem: { code: 'estimate-no-global-terrain', message: 'The global terrain data source is not available' } }
  try { return { heights: await ctx.globalTerrain.ensureAround(lat, lon, REGIONAL_RANGE_KM) } }
  catch (e) { return { heights: ctx.globalTerrain.manifestLoaded() ? ctx.globalTerrain.heights() : null, problem: { code: 'estimate-global-terrain-failed', message: `Global terrain tiles could not be loaded: ${e instanceof Error ? e.message : String(e)}` } } }
}

/** As runCustomSiteJob, plus the detail data of a point whose decision qualifies (undefined for any other outcome). */
export async function runCustomSiteJobDetailed(job: SiteJob, ctx: { terrain?: SiteTerrainStore; globalTerrain?: GlobalTerrainStore; catalog?: CandidateCatalog } = {}): Promise<{ assessment: SiteAssessment; pointData?: PointData }> {
  if (job.protocol !== JOB_PROTOCOL_VERSION) throw new Error(`Job protocol ${job.protocol} is not supported`)
  const { site, settings, input } = job
  if (!(site.lat >= -90 && site.lat <= 90) || !(site.lon >= -180 && site.lon <= 180)) throw new RangeError('Custom site coordinate is invalid')
  const window = missionWindow(input)
  const catalog = ctx.catalog ?? loadCandidateCatalog()
  const record = { id: site.id, name: site.name, origin: 'custom' as const, lat: site.lat, lon: site.lon, frame: 'user input (used as DE421 mean Earth)' }
  const relaxed = settings.assessmentMode === 'relaxed'
  const same = catalog.candidates.find((c) => Math.abs(c.coordinate.lat - site.lat) < SAME_SITE_TOLERANCE_DEG && Math.abs(c.coordinate.lon - site.lon) < SAME_SITE_TOLERANCE_DEG)
  if (same && ctx.terrain) {
    // Same coordinate as a catalogue site: its package gives the evidence view, and (relaxed) the estimate on the same observer position.
    let terrain: CandidateRun['terrain']
    try { terrain = await ctx.terrain.load(same.id) } catch (e) { terrain = e instanceof TerrainLoadError ? e : new TerrainLoadError('network', String(e)) }
    const regional = relaxed ? await regionalFor(ctx, same.coordinate.lat, same.coordinate.lon) : undefined
    const inputs = catalogCandidateInputs({ candidate: same, terrain }, catalog, settings, window, { regional })
    const assessment = evaluateCandidate({ ...inputs, candidate: record, source: 'custom' }, settings).assessment
    return { assessment, pointData: qualified(assessment) && inputs.detail ? { statistics: inputs.detail.statistics, site: { ...inputs.detail.site, id: site.id, name: site.name } } : undefined }
  }
  if (relaxed) {
    // Any other coordinate: the regional estimate from the global terrain at exactly the given coordinate (no snapping, no neighbour).
    const regional = await regionalFor(ctx, site.lat, site.lon)
    const est = estimatePoint({ id: site.id, name: site.name, lat: site.lat, lon: site.lon, heights: regional.heights, problem: regional.problem, settings, window })
    const assessment = evaluateEstimateOnly(record, est, settings, 'custom').assessment
    return { assessment, pointData: qualified(assessment) ? { statistics: est.statistics, site: est.site } : undefined }
  }
  const noProduct = { code: 'terrain-no-product', message: 'No precomputed terrain product covers this point (terrain packages exist only for the 12 catalogue sites); the regional estimate mode can evaluate it' }
  const footprint = assessFootprint({
    site: { lat: site.lat, lon: site.lon, frame: record.frame }, config: footprintConfig(settings),
    dtm: { unavailable: noProduct }, obstacleSurveys: [], hazards: [], hazardInventory: { complete: false, basis: 'no hazard survey exists for this point' },
  })
  const vis = visibilityModel({ lat: site.lat, lon: site.lon, horizon: null }, { earthMinElevationDeg: settings.earthMinElevationDeg })
  const statistics = missionStatistics(vis, window)
  const energy = assessEnergy(vis, settings, window)
  return { assessment: evaluateCandidate({ candidate: record, footprint, energy, statistics, source: 'custom' }, settings).assessment }
}

/**
 * Transit estimate of one custom point (step 20), computed once with the existing estimateTransit. The destination
 * radius comes from the terrain of the same catalogue site (exact coordinate match, as in runCustomSiteJob); any other
 * point has no elevation, so the estimate reports 'missing-elevation' (the radius is never replaced by a default).
 */
export async function customSiteTransit(job: SiteJob, ctx: { terrain?: SiteTerrainStore; globalTerrain?: GlobalTerrainStore; catalog?: CandidateCatalog } = {}): Promise<TransitEstimate> {
  const { site, settings, input } = job
  const catalog = ctx.catalog ?? loadCandidateCatalog()
  const same = catalog.candidates.find((c) => Math.abs(c.coordinate.lat - site.lat) < SAME_SITE_TOLERANCE_DEG && Math.abs(c.coordinate.lon - site.lon) < SAME_SITE_TOLERANCE_DEG)
  let radiusKm: number | null = null
  let elevationSource: string | undefined
  if (same && ctx.terrain) {
    try {
      const t = await ctx.terrain.load(same.id)
      radiusKm = t.observerRadiusKm()
      elevationSource = t.elevation.source ?? undefined
    } catch { radiusKm = null }
  } else if (settings.assessmentMode === 'relaxed') {
    // Regional estimate: the observer radius from the same global elevation the estimate's skyline was cast from.
    const regional = await regionalFor(ctx, site.lat, site.lon)
    const z = regional.heights?.heightAt(site.lat, site.lon) ?? null
    if (z !== null) { radiusKm = regionalObserverRadiusKm(z); elevationSource = 'LDEM_16 global terrain (regional estimate)' }
  }
  return estimateTransit({
    landingTimeMs: input.landingTimeMs, launchSite: input.launchSite,
    destination: { lat: site.lat, lon: site.lon, radiusKm, elevationSource }, speedKmPerS: settings.transitSpeedKmPerS,
  })
}
