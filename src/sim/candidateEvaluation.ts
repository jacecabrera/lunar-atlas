// Formal evaluation entry for catalogue candidates: footprint (step 08), visibility (09), statistics (10), energy
// (11-12), then conditions, score and recommendations (13). Explicit inputs only; no UI or global store.
import type { CandidateCatalog, CatalogCandidate } from './catalog'
import { toCandidateRecord } from './catalog'
import type { AdvancedSettings, MissionInput, MissionWindow } from './mission'
import { estimateTransit } from './transit'
import type { TransitEstimate } from './transit'
import type { SiteTerrain } from './siteTerrain'
import { TerrainLoadError } from './siteTerrain'
import { footprintConfig } from './footprint'
import { assessCandidateFootprint } from './footprintEvidence'
import { visibilityModel } from './visibility'
import { missionStatistics } from './events'
import type { EventSearchOptions } from './events'
import { assessEnergy } from './energy'
import type { CandidateInputs, RecommendationResult } from './recommend'
import { recommend } from './recommend'
import { buildEstimate, estimateHorizon } from './regionalEvaluation'
import type { TiledHeights } from './globalTerrain'
import type { ConditionReason } from './assessment'

export type CandidateRun = { candidate: CatalogCandidate; terrain: SiteTerrain | TerrainLoadError | null }

/** Inputs of step 13 for one catalogue candidate. `terrain` is the loaded site, its load error, or null (not loaded). */
export type RegionalContext = { heights: TiledHeights | null; problem?: ConditionReason }

export function catalogCandidateInputs(
  run: CandidateRun, catalog: CandidateCatalog, settings: AdvancedSettings, window: MissionWindow, opts: { events?: EventSearchOptions; energyStepMs?: number; regional?: RegionalContext } = {},
): CandidateInputs {
  const { candidate: c, terrain } = run
  const footprint = assessCandidateFootprint(c, catalog, terrain, footprintConfig(settings))
  const site = terrain && !(terrain instanceof TerrainLoadError) ? terrain.toSerializableSite() : { lat: c.coordinate.lat, lon: c.coordinate.lon, horizon: null }
  const vis = visibilityModel(site, { earthMinElevationDeg: settings.earthMinElevationDeg })
  const statistics = missionStatistics(vis, window, opts.events)
  const energy = assessEnergy(vis, settings, window, { stepMs: opts.energyStepMs, events: opts.events })
  const evidenceSite = { id: c.id, name: c.name, ...site }
  // Relaxed mode: the regional estimate of the same point, next to the evidence view above (which stays as computed).
  let estimate: CandidateInputs['estimate']
  if (settings.assessmentMode === 'relaxed') {
    const heights = opts.regional?.heights ?? null
    const h = estimateHorizon(evidenceSite.horizon, heights, c.coordinate.lat, c.coordinate.lon)
    estimate = buildEstimate({
      id: c.id, name: c.name, lat: c.coordinate.lat, lon: c.coordinate.lon, horizon: h.horizon, horizonProblem: h.problem ?? opts.regional?.problem, dataProblem: opts.regional?.problem, heights,
      evidenceTerrain: footprint.terrain, settings, window, opts: { events: opts.events, energyStepMs: opts.energyStepMs },
    })
  }
  return {
    candidate: toCandidateRecord(c, catalog), footprint, energy, statistics, source: 'catalogue', estimate,
    detail: estimate ? { statistics: estimate.statistics, site: estimate.site } : { statistics, site: evidenceSite },
  }
}

/** Evaluate every given catalogue candidate and recommend. */
export function evaluateCatalog(runs: CandidateRun[], catalog: CandidateCatalog, settings: AdvancedSettings, window: MissionWindow): RecommendationResult {
  return recommend(runs.map((r) => catalogCandidateInputs(r, catalog, settings, window)), settings)
}

/**
 * Transit estimates (step 14) for the recommended sites only (and, from step 19, confirmed custom sites passed in
 * `extra`). The destination radius is the terrain observer radius; a site without it gets 'missing-elevation'.
 * A failed estimate is reported per site and never changes the lunar assessment.
 */
export function missionTransits(
  siteIds: string[], runs: CandidateRun[], input: MissionInput, settings: Pick<AdvancedSettings, 'transitSpeedKmPerS'>,
): Record<string, TransitEstimate> {
  const out: Record<string, TransitEstimate> = {}
  for (const id of siteIds) {
    const run = runs.find((r) => r.candidate.id === id)
    if (!run) continue
    const t = run.terrain
    const radiusKm = t && !(t instanceof TerrainLoadError) ? t.observerRadiusKm() : null
    out[id] = estimateTransit({
      landingTimeMs: input.landingTimeMs, launchSite: input.launchSite,
      destination: { lat: run.candidate.coordinate.lat, lon: run.candidate.coordinate.lon, radiusKm, elevationSource: t && !(t instanceof TerrainLoadError) ? t.elevation.source ?? undefined : undefined },
      speedKmPerS: settings.transitSpeedKmPerS,
    })
  }
  return out
}
