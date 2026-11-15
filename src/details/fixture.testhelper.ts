// Test helper for the details page (step 22): a SYNTHETIC task (hand-built, all conditions "pass") wrapped around REAL statistics
// and horizon data of Apollo 11 (published terrain, Node tests only). Clearly isolated: nothing here is a real recommendation.
import { loadCandidateCatalog } from '../sim/catalog'
import { catalogCandidateInputs } from '../sim/candidateEvaluation'
import { defaultAdvancedSettings } from '../sim/defaults'
import { missionWindow } from '../sim/mission'
import { assessSite } from '../sim/assessment'
import type { ConditionResult } from '../sim/assessment'
import type { PointData, TaskResult, TaskState } from '../sim/task'
import { CURRENT_MODEL_VERSIONS } from '../sim/task'
import type { DetailSnapshot } from '../sim/snapshot'
import { diskTerrainStore } from '../sim/testing/publishedTerrain'
import { buildSnapshot } from '../snapshots/build'
import { newSnapshotId } from '../sim/snapshot'
import { visibilityModel } from '../sim/visibility'
import { missionStatistics } from '../sim/events'
import type { HorizonData } from '../sim/horizonData'

// Strict (evidence) settings: the real Apollo 11 statistics keep their unknown time, which the N/A tests rely on.
export const settings = { ...defaultAdvancedSettings(), assessmentMode: 'strict' as const }
export const input = { landingTimeMs: Date.UTC(2027, 0, 10, 6), durationMs: 3 * 86_400_000, launchSite: { lat: 28.5, lon: -80.6 } }
const pass: ConditionResult = { status: 'pass', reasons: [], sources: [{ id: 'SRC-ASTRONOMY-ENGINE', title: 'Astronomy Engine', kind: 'model' }], limitations: ['A model limit'] }
const eligible = (id: string) => assessSite(id, { terrain: pass, power: pass, communication: pass, dataCompleteness: pass })

export async function realPointData(siteId = 'apollo-11'): Promise<PointData> {
  const catalog = loadCandidateCatalog()
  const c = catalog.candidates.find((x) => x.id === siteId)!
  const terrain = await diskTerrainStore().load(c.id)
  return catalogCandidateInputs({ candidate: c, terrain }, catalog, settings, missionWindow(input)).detail!
}

export function syntheticSnapshot(ids: string[], data: PointData, over: Partial<TaskResult> = {}): DetailSnapshot {
  const request = { requestId: 'r1', fingerprint: 'FP', versions: CURRENT_MODEL_VERSIONS, startedAtMs: 0 }
  const task: TaskState = { status: 'done', request, result: {
    requestId: 'r1', fingerprint: 'FP', versions: CURRENT_MODEL_VERSIONS, completedAtMs: 5, sites: ids.map(eligible), outcome: ids.length ? 'recommendations' : 'no-eligible-sites',
    recommendations: ids.map((siteId, i) => ({ siteId, rank: i + 1, score: 60 - i, parts: { sunlight: 0.5, earth: 0.5, terrain: 0.5 } })),
    transits: {}, pointData: Object.fromEntries(ids.map((id) => [id, structuredClone(data)])),
    evaluation: { ranked: [], weights: { sunlight: 1, earth: 1, terrain: 1 } as never, model: 'score-test', excluded: { physicalFail: [{ siteId: 'luna-24', reasons: [{ code: 'slope', message: 'slope too steep' }] }], insufficientData: [], serviceError: [], notScored: [], beyondLimit: [], customNotRecommended: [] } },
    ...over,
  } as TaskResult }
  const r = buildSnapshot({ task, input, settings, customs: [], maxCustom: 9, snapshotId: newSnapshotId(), nowMs: 1_700_000_000_000 })
  if (!r.ok) throw new Error(r.reason)
  return r.snapshot
}

/** A formal (gate-passing) SYNTHETIC horizon, 0.5 deg steps, skyline from a function of azimuth. */
export function syntheticHorizon(lat: number, lon: number, sky: (az: number) => number): HorizonData {
  const az = Array.from({ length: 720 }, (_, i) => i * 0.5)
  const status = az.map(() => 'complete' as const)
  return {
    status: 'available', site: { lat, lon },
    samples: { elevationsDeg: az.map(sky), startAzimuthDeg: 0, stepDeg: 0.5, angleUnit: 'deg' },
    source: { product: 'synthetic', gridSpacingKm: 0.002, verticalAccuracyM: null, referenceRadiusKm: 1737.4, frame: 'synthetic' },
    model: { maxRangeKm: 200, mastM: 0, rayStepKm: 0.001, observerElevationM: 0 },
    observer: { elevationM: 0, elevationSource: 'synthetic', elevationQuality: 'measured', observerHeightM: 0, radiusKm: 1737.4 },
    coverage: { searchRangeKm: 200, nearStartKm: 0.02, complete: true, nearField: 'screened', sampleStatus: status, coveredToKm: az.map(() => 200), governingKm: az.map(() => 1), governingSource: az.map(() => 's'), uncertaintyDeg: az.map(() => null), fallbackSamples: 0, skippedSamples: 0, lowerBoundAzimuths: 0 },
    quality: { nearFieldSelection: { productId: 's', tier: 'all gates', degraded: false }, convergence: { status: 'within-tolerance', toleranceDeg: 0.05, checks: [] } },
  }
}

/** Complete (fully determined) statistics from the REAL statistics code over a SYNTHETIC skyline: the isolated full-comparison fixture. */
export function formalPointData(name = 'synthetic', lat = 5, lon = -130, sky: (az: number) => number = () => 0.2): PointData {
  const site = { id: name, lat, lon, horizon: syntheticHorizon(lat, lon, sky) }
  const vis = visibilityModel(site, { earthMinElevationDeg: settings.earthMinElevationDeg })
  return { statistics: missionStatistics(vis, missionWindow(input)), site }
}
