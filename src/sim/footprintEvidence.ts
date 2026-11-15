// Builds explicit footprint inputs for a catalogue candidate from the catalogue record and its loaded terrain.
// The candidate ID is never used to decide anything: every conclusion comes from the evidence fields below.
import type { CandidateCatalog, CatalogCandidate } from './catalog'
import { quantizationHalfStepM, surfaceDistanceM } from './catalog'
import type { SiteTerrain } from './siteTerrain'
import { TerrainLoadError } from './siteTerrain'
import type { FootprintConfig, FootprintDtm, FootprintInput, KnownHazard, StatedUncertainty } from './footprint'
import { assessFootprint } from './footprint'
import type { SourceVerification } from './provenance'

/**
 * Verification status (sources.md) of the sources whose values this module may treat as evidence. A test checks
 * these against the register. Only 'read-original' dimensions can support a confirmed overlap.
 */
export const EVIDENCE_SOURCE_VERIFICATION: Record<string, SourceVerification> = {
  'SRC-NSSDCA-ARTIFACTS': 'read-original',
  'SRC-NSSDCA-A11': 'read-original',
  'SRC-NSSDCA-S7': 'read-original',
  'SRC-LROC-ANTHRO': 'read-original',
  'SRC-LROC-PAGES': 'agent-reported',
  'SRC-LROC-NAC-DTM-CATALOG': 'read-original',
  'SRC-LROC-NAC-DTM-PDS': 'read-original',
  'SRC-WATKINS-BOULDERS': 'read-original',
}
const verified = (ids: string[]) => ids.length > 0 && ids.every((id) => EVIDENCE_SOURCE_VERIFICATION[id] === 'read-original')

/** NAC DTM confidence codes accepted as measured or interpolated (README table; codes 0-3 are not usable). */
const ACCEPTED_NAC_CODES = [4, 10, 11, 12, 13, 14, 15] as const

/**
 * Position error of the hardware relative to the catalogue coordinate. The catalogue coordinate is, per NSSDCA,
 * the hardware position; NSSDCA states that its precision is reflected in the printed decimals, so one last-digit
 * step is the NSSDCA estimate. An alternate published coordinate contributes its offset plus its stated uncertainty.
 * The estimates describe the same quantity, so the largest is used. Statistics are unknown for all of them.
 */
export function hardwarePositionUncertainty(c: CatalogCandidate): StatedUncertainty {
  const half = quantizationHalfStepM(c.coordinate)
  const lastDigit = 2 * Math.max(half.northSouthM, half.eastWestM)
  let value = lastDigit
  let note = `NSSDCA last printed digit (${lastDigit.toFixed(2)} m)`
  for (const a of c.alternateCoordinates) {
    if (a.uncertaintyM === null || a.uncertaintyM === 0) return { valueM: null, statistic: 'unknown', note: `${a.objectId}: uncertainty not stated` }
    const v = surfaceDistanceM(c.coordinate, a) + a.uncertaintyM
    if (v > value) { value = v; note = `${a.objectId} offset plus stated uncertainty (${v.toFixed(2)} m)` }
  }
  return { valueM: value, statistic: 'unknown', sourceId: c.coordinate.sourceId, note }
}

/** The hardware marked by the candidate coordinate, with only verified dimensions turned into extents. */
export function primaryHardwareHazard(c: CatalogCandidate): KnownHazard {
  const dims = c.hardware.dimensionsM
  const dimsVerified = !!dims && verified(c.hardware.dimensionsSourceIds)
  // Width is read as across the corners of the octagonal stage (the smaller inscribed radius): the source does not say.
  const minHalf = dimsVerified && dims!.widthM !== null ? (dims!.widthM / 2) * Math.cos(Math.PI / 8) : null
  const maxHalf = !dimsVerified ? null
    : dims!.footpadSpanM !== null ? dims!.footpadSpanM / 2
      : dims!.footpadReachFromCenterM !== null ? dims!.footpadReachFromCenterM : null
  const top = !dimsVerified ? null
    : dims!.groundClearanceM !== null && dims!.thicknessM !== null ? dims!.groundClearanceM + dims!.thicknessM
      : dims!.heightM
  return {
    id: `${c.id}:hardware`, name: c.mission.objectType, kind: 'hardware', lat: c.coordinate.lat, lon: c.coordinate.lon,
    relation: 'site-coordinate-marks-hazard', frameReconciled: true,
    position: [hardwarePositionUncertainty(c)],
    minHalfExtentM: minHalf, maxHalfExtentM: maxHalf, minObstructionHeightM: top, dimensionsVerified: dimsVerified,
    sourceIds: [c.coordinate.sourceId, ...c.hardware.dimensionsSourceIds, ...c.alternateCoordinates.map((a) => a.sourceId)],
    note: c.hardware.measuredDimensionsM ? `Measured dimensions ${JSON.stringify(c.hardware.measuredDimensionsM)} are ${c.hardware.measuredDimensionsVerification} and not used` : undefined,
  }
}

/** Nearby objects listed in the catalogue (LROC shapefile; frame not reconciled with the catalogue frame). */
export function nearbyHazards(c: CatalogCandidate): KnownHazard[] {
  return c.hardware.nearbyObjects.map((o) => ({
    id: `${c.id}:${o.objectId}`, name: o.name, kind: 'hardware' as const, lat: o.lat, lon: o.lon,
    relation: 'separate-coordinate' as const, frameReconciled: false,
    position: [{ valueM: o.uncertaintyM, statistic: 'unknown' as const, sourceId: o.sourceId }],
    minHalfExtentM: null, maxHalfExtentM: null, minObstructionHeightM: null, dimensionsVerified: false, sourceIds: [o.sourceId],
  }))
}

/** The NAC near-field grid of a loaded site as footprint data (native posting, catalogue accuracy). */
export function nacFootprintDtm(c: CatalogCandidate, t: SiteTerrain): FootprintDtm | null {
  if (!t.near) return null
  const local = c.terrain.localDtms.find((d) => d.productId === t.near!.productId)
  const product = t.manifest.products.find((p) => p.role === 'near')
  const offset = local?.lolaOffsetsM ? Math.hypot(local.lolaOffsetsM.lat ?? 0, local.lolaOffsetsM.lon ?? 0) : null
  return {
    productId: t.near.productId,
    sourceIds: ['SRC-LROC-NAC-DTM-PDS', 'SRC-LROC-NAC-DTM-CATALOG'],
    heightAt: (la, lo) => t.near!.elevation.heightAt(la, lo),
    codeAt: (la, lo) => t.near!.confidence.codeAt(la, lo),
    acceptedCodes: ACCEPTED_NAC_CODES,
    confidenceLegend: t.near.legendConfirmed ? 'confirmed' : 'unconfirmed',
    postingM: product?.gridSpacingM ?? local?.postingM ?? Number.NaN,
    effectiveResolutionM: null,
    verticalError: local?.relativeLinearError90M != null ? { valueM: local.relativeLinearError90M, statistic: '90-percent', scope: 'single-post', sourceId: 'SRC-LROC-NAC-DTM-CATALOG', note: 'Relative linear error (90 %) of individual posts; not an error of 3 m height differences' } : null,
    // The catalogue's LOLA offset is the registration residual against LOLA; its statistic is not stated.
    registration: offset !== null ? { valueM: offset, statistic: 'unknown', sourceId: 'SRC-LROC-NAC-DTM-CATALOG', note: 'Horizontal offset to LOLA' } : null,
    frame: 'registered-to-site-frame',
  }
}

/** Explicit inputs for one catalogue candidate. `terrain` is the loaded site, the load error, or null (not loaded). */
export function candidateFootprintInput(
  c: CatalogCandidate, catalog: CandidateCatalog, terrain: SiteTerrain | TerrainLoadError | null, config: FootprintConfig,
): FootprintInput {
  let dtm: FootprintInput['dtm']
  if (terrain === null) dtm = { unavailable: { code: 'terrain-not-loaded', message: 'Terrain data have not been loaded' } }
  else if (terrain instanceof TerrainLoadError) dtm = { error: { code: `terrain-${terrain.kind}`, message: terrain.message } }
  else dtm = nacFootprintDtm(c, terrain)
  return {
    site: { lat: c.coordinate.lat, lon: c.coordinate.lon, frame: catalog.coordinateSource.frame },
    config,
    dtm,
    // No obstacle survey of these footprints exists in this project. NAC images resolve boulders of about 1-2 m
    // (SRC-WATKINS-BOULDERS), so even a survey from them could not show the absence of 0.3 m obstacles.
    obstacleSurveys: [],
    hazards: [primaryHardwareHazard(c), ...nearbyHazards(c)],
    hazardInventory: { complete: false, basis: 'only catalogued hardware is listed; no orthophoto survey of the footprint was made' },
  }
}

/** Formal footprint assessment of a catalogue candidate. */
export function assessCandidateFootprint(c: CatalogCandidate, catalog: CandidateCatalog, terrain: SiteTerrain | TerrainLoadError | null, config: FootprintConfig) {
  return assessFootprint(candidateFootprintInput(c, catalog, terrain, config))
}
