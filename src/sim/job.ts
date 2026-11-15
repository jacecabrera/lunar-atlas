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
import type { ModelVersions, TaskError, TaskResult } from './task'
import type { SiteTerrainStore } from './siteTerrain'
import { TerrainLoadError } from './siteTerrain'
import { catalogCandidateInputs, missionTransits } from './candidateEvaluation'
import type { CandidateRun } from './candidateEvaluation'
import { recommend } from './recommend'
import type { CandidateInputs } from './recommend'
import { assessSite } from './assessment'
import type { ConditionResult, SiteAssessment } from './assessment'
import { TIME_SCALE_MODEL, ttMinusUtcSeconds } from '../physics/timeScale'

export const JOB_PROTOCOL_VERSION = 1

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
}

export type ToWorker = { type: 'run'; job: MissionJob } | { type: 'cancel'; requestId: string }
export type FromWorker =
  | { type: 'ready'; protocol: number; timeScale: { model: string; ttMinusUtcSeconds2026: number; libraryDeltaTSeconds2026: number } }
  | { type: 'progress'; requestId: string; done: number; total: number; siteId: string | null; phase: 'terrain' | 'evaluate' | 'rank' | 'transit' }
  | { type: 'result'; requestId: string; result: TaskResult }
  | { type: 'error'; requestId: string; error: TaskError }
  | { type: 'cancelled'; requestId: string }

export class JobCancelled extends Error {
  constructor() { super('cancelled'); this.name = 'JobCancelled' }
}

export type JobContext = {
  terrain: SiteTerrainStore
  isCancelled: () => boolean
  progress: (m: Omit<Extract<FromWorker, { type: 'progress' }>, 'type' | 'requestId'>) => void
  /** Give the event loop a turn so a cancel message can arrive (cooperative cancellation). */
  yieldNow: () => Promise<void>
  catalog?: CandidateCatalog
  now?: () => number
}

const failed = (code: string, message: string): ConditionResult => ({ status: 'error', reasons: [{ code, message }] })

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
  for (const [i, run] of runs.entries()) {
    try {
      inputs.push(catalogCandidateInputs(run, catalog, job.settings, window))
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
  const transits = missionTransits(rec.recommendations.map((r) => r.siteId), runs, job.input, job.settings)
  ctx.progress({ done: 1, total: 1, siteId: null, phase: 'transit' })
  await check()

  const sites = [...rec.evaluations.map((e) => e.assessment), ...errored].sort((a, b) => (a.siteId < b.siteId ? -1 : 1))
  const serviceError = [...rec.excluded.serviceError, ...errored.map((a) => ({ siteId: a.siteId, reasons: a.summary.reasons.map(({ code, message }) => ({ code, message })) }))]
  return {
    requestId: job.requestId, fingerprint: job.fingerprint, versions: job.versions, completedAtMs: now(),
    sites, recommendations: rec.recommendations, outcome: rec.recommendations.length ? 'recommendations' : 'no-eligible-sites',
    evaluation: { ranked: rec.ranked, excluded: { ...rec.excluded, serviceError }, weights: rec.weights, model: rec.model },
    transits,
    runtime: { timeScaleModel: TIME_SCALE_MODEL, ttMinusUtcSecondsAtLanding: ttMinusUtcSeconds(job.input.landingTimeMs), protocol: JOB_PROTOCOL_VERSION },
  }
}
