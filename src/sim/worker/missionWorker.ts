// Mission Worker (step 15). Runs runMissionJob off the main thread.
//
// Initialisation: importing the public sim entry installs the UTC -> TT time scale (physics/timeScale) before any sky
// calculation, exactly as on the main thread; the 'ready' message reports the Delta T the library actually uses so
// the main thread can check it. Terrain is loaded by this Worker's own siteTerrain store (one per base URL, kept for
// the Worker's life, failures not cached). Cancellation is cooperative (checked between candidates); the main thread
// terminates the Worker if a cancel is not acknowledged in time.
import { MakeTime } from 'astronomy-engine'
import '../index'
import { createSiteTerrainStore } from '../siteTerrain'
import type { SiteTerrainStore } from '../siteTerrain'
import { JOB_PROTOCOL_VERSION, JobCancelled, runMissionJob } from '../job'
import type { FromWorker, MissionJob, ToWorker } from '../job'
import { TIME_SCALE_MODEL, ttMinusUtcSeconds } from '../../physics/timeScale'

const post = (m: FromWorker) => (self as unknown as { postMessage: (m: FromWorker) => void }).postMessage(m)
const stores = new Map<string, SiteTerrainStore>()
const cancelled = new Set<string>()
let current: Promise<void> = Promise.resolve()

function storeFor(baseUrl: string): SiteTerrainStore {
  let s = stores.get(baseUrl)
  if (!s) { s = createSiteTerrainStore({ baseUrl }); stores.set(baseUrl, s) }
  return s
}

async function run(job: MissionJob) {
  try {
    const result = await runMissionJob(job, {
      terrain: storeFor(job.terrainBaseUrl),
      isCancelled: () => cancelled.has(job.requestId),
      progress: (p) => post({ type: 'progress', requestId: job.requestId, ...p }),
      yieldNow: () => new Promise((r) => setTimeout(r, 0)),
    })
    if (cancelled.has(job.requestId)) post({ type: 'cancelled', requestId: job.requestId })
    else post({ type: 'result', requestId: job.requestId, result })
  } catch (e) {
    if (e instanceof JobCancelled) post({ type: 'cancelled', requestId: job.requestId })
    else post({ type: 'error', requestId: job.requestId, error: { requestId: job.requestId, kind: 'internal', message: e instanceof Error ? e.message : String(e) } })
  } finally {
    cancelled.delete(job.requestId)
  }
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data
  if (m.type === 'cancel') { cancelled.add(m.requestId); return }
  if (m.type === 'run') current = current.then(() => run(m.job)) // one job at a time, in arrival order
}

const t2026 = Date.UTC(2026, 0, 1)
const at = MakeTime(new Date(t2026))
post({ type: 'ready', protocol: JOB_PROTOCOL_VERSION, timeScale: { model: TIME_SCALE_MODEL, ttMinusUtcSeconds2026: ttMinusUtcSeconds(t2026), libraryDeltaTSeconds2026: (at.tt - at.ut) * 86_400 } })
