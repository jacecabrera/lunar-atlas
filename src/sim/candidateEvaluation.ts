// Formal evaluation entry for catalogue candidates: footprint (step 08), visibility (09), statistics (10), energy
// (11-12), then conditions, score and recommendations (13). Explicit inputs only; no UI or global store.
import type { CandidateCatalog, CatalogCandidate } from './catalog'
import { toCandidateRecord } from './catalog'
import type { AdvancedSettings, MissionWindow } from './mission'
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

export type CandidateRun = { candidate: CatalogCandidate; terrain: SiteTerrain | TerrainLoadError | null }

/** Inputs of step 13 for one catalogue candidate. `terrain` is the loaded site, its load error, or null (not loaded). */
export function catalogCandidateInputs(
  run: CandidateRun, catalog: CandidateCatalog, settings: AdvancedSettings, window: MissionWindow, opts: { events?: EventSearchOptions; energyStepMs?: number } = {},
): CandidateInputs {
  const { candidate: c, terrain } = run
  const footprint = assessCandidateFootprint(c, catalog, terrain, footprintConfig(settings))
  const site = terrain && !(terrain instanceof TerrainLoadError) ? terrain.toSerializableSite() : { lat: c.coordinate.lat, lon: c.coordinate.lon, horizon: null }
  const vis = visibilityModel(site, { earthMinElevationDeg: settings.earthMinElevationDeg })
  const statistics = missionStatistics(vis, window, opts.events)
  const energy = assessEnergy(vis, settings, window, { stepMs: opts.energyStepMs, events: opts.events })
  return { candidate: toCandidateRecord(c, catalog), footprint, energy, statistics }
}

/** Evaluate every given catalogue candidate and recommend. */
export function evaluateCatalog(runs: CandidateRun[], catalog: CandidateCatalog, settings: AdvancedSettings, window: MissionWindow): RecommendationResult {
  return recommend(runs.map((r) => catalogCandidateInputs(r, catalog, settings, window)), settings)
}
