// Loader and validator for the historical candidate catalog (src/data/lunar-candidate-catalog-v0.1.json).
//
// The catalog is a registry of locations and evidence. It holds no evaluation result: landing allowance,
// recommendation eligibility, scores and per-condition states are produced per mission (assessment.ts) and the
// validator rejects any such field in the file. Source coordinates keep their printed text, so a trailing zero
// (3.63330) or a short precision (32.32) is not lost when the number is parsed.
//
// Terrain products and per-site coverage are references and capability statements. Nothing here downloads data or
// claims that a footprint or horizon has been validated.
import catalogJson from '../data/lunar-candidate-catalog-v0.1.json'
import type { CandidateRecord, SiteAssessment, SiteConditions } from './assessment'
import { assessSite, notEvaluated } from './assessment'
import type { SourceVerification } from './provenance'

export const CATALOG_SCHEMA = 'lunar-navigator.candidate-catalog'
export const CATALOG_SCHEMA_VERSION = 1

export type CoverageStatus = 'covered' | 'not-covered' | 'unverified'
export type CoverageMethod =
  | 'footprint-polygon+point-sample' | 'label-range-read' | 'tile-label-read' | 'product-description-only' | 'agent-reported'
export type Coverage = { status: CoverageStatus; method: CoverageMethod; note: string }

export type UseSupport = 'supported' | 'insufficient' | 'not-supported' | 'unverified'
export type AvailabilityState =
  | 'bundled' | 'open-verified' | 'login-required' | 'reported-no-public-release-found' | 'announced-not-yet-released' | 'access-failed'

export type Accuracy = { value: number | null; unit: string; statistic: string; note: string }

export type TerrainProduct = {
  id: string
  name: string
  productCode: string
  /** null = not established. */
  version: string | null
  versionNote: string | null
  publisher: string
  format: string
  coverage: string
  gridSpacingM: number | null
  gridSpacingNote: string
  effectiveResolutionNote: string
  verticalAccuracy: Accuracy
  horizontalAccuracy: Accuracy
  frame: string
  verticalDatum: string
  qualityInformation: string | null
  availability: { state: AvailabilityState; note: string }
  uses: { regionalTerrain: UseSupport; horizon: UseSupport; footprintSlope: UseSupport; obstacle: UseSupport }
  verification: SourceVerification
  sourceIds: string[]
  limitations: string[]
}

export type OverlapLevel = 'direct-evidence' | 'geometric-derivation' | 'possible' | 'insufficient-data'

export type NearbyObject = {
  objectId: string; name: string; kind: string; lat: number; lon: number
  distanceFromCandidateM: number; uncertaintyM: number | null; sourceId: string
}

export type LocalDtm = {
  productId: string
  dtmName: string
  version: number
  postingM: number
  completedDate: string
  sourceImages: string
  productPageUrl: string
  relativeLinearError90M: number | null
  lolaRmsM: number | null
  lolaMeanAbsM: number | null
  lolaOffsetsM: { lat: number | null; lon: number | null; elv: number | null }
  adjustRmsM: number | null
  coverage: Coverage
  projection: string
  ulxSignReversedInLabel: boolean
  pointSample: {
    accessedAt: string
    windowPx: number
    centerElevationM: number | null
    centerConfidenceCode: number | null
    windowValidMatchCount: number
    windowPixelCount: number
    windowMissingElevationCount: number
    confidenceCodeCounts: Record<string, number>
    /** Codes outside the README table (read only for APOLLO11) were seen: the legend may not apply to this DTM. */
    nonStandardCodesObserved: boolean
  }
}

export type CatalogCandidate = {
  id: string
  name: string
  origin: 'historical'
  mission: { name: string; agency: string; objectType: string; surfaceArrivalDateUtc: string }
  coordinate: {
    lat: number; lon: number
    /** Signed decimal text with the source's decimals, west and south negative. */
    latText: string; lonText: string
    /** Longitude in 0..360 as printed by the source. */
    lonEast360Text: string
    /** The row as printed, e.g. "3.0128 S, 23.4219 W". */
    sourceText: string
    sourceId: string
  }
  /** Other published coordinates for the same hardware. They never replace `coordinate`. */
  alternateCoordinates: Array<{
    source: string; sourceId: string; fileVersion: string; objectId: string
    lat: number; lon: number; latText: string; lonText: string
    uncertaintyM: number | null
    /** Whether the uncertainty is 1 sigma, a maximum or something else is not stated by the source. */
    uncertaintyStatistic: 'unknown'
    coordinateMethod: string
    frame: string
    frameReconciled: boolean
  }>
  otherReportedCoordinates: Array<{
    kind: string; lat: number; lon: number; note: string; sourceIds: string[]; verification: SourceVerification
  }>
  hardware: {
    existence: 'coordinate-marks-hardware'
    description: string
    /** Each value is a positive number or null (unknown). Never 0 for "not found". */
    dimensionsM: Record<'widthM' | 'thicknessM' | 'heightM' | 'footpadSpanM' | 'footpadReachFromCenterM' | 'groundClearanceM', number | null> | null
    dimensionsSourceIds: string[]
    dimensionsNote: string
    measuredDimensionsM?: Record<string, number>
    measuredDimensionsSourceIds?: string[]
    measuredDimensionsVerification?: SourceVerification
    footprintOverlap: { level: OverlapLevel; basis: string; sourceIds: string[] }
    nearbyObjects: NearbyObject[]
  }
  terrain: {
    regionalProducts: Array<{ productId: string; coverage: Coverage; qualityResidualRmsM?: number; qualityResidualNote?: string }>
    localDtms: LocalDtm[]
    otherProducts: Array<{ productId: string; relation: string }>
  }
  limitations: string[]
}

export type CandidateCatalog = {
  catalogId: string
  dataVersion: string
  description: string
  coordinateSource: { sourceId: string; title: string; url: string; listVersion: string; frame: string; longitudeConvention: string; latitudeConvention: string; precisionStatement: string }
  terrainProducts: TerrainProduct[]
  candidates: CatalogCandidate[]
}

// ─── Validation ────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const numOrNull = (v: unknown) => v === null || isNum(v)
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const srcIds = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && /^SRC-[A-Z0-9-]+$/.test(x))
const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T => list.includes(v as T)

const VERIFICATIONS = ['read-original', 'metadata-only', 'agent-reported', 'not-verified', 'access-failed', 'not-applicable'] as const
const COVERAGE_STATUS = ['covered', 'not-covered', 'unverified'] as const
const COVERAGE_METHOD = ['footprint-polygon+point-sample', 'label-range-read', 'tile-label-read', 'product-description-only', 'agent-reported'] as const
const USES = ['supported', 'insufficient', 'not-supported', 'unverified'] as const
const AVAILABILITY = ['bundled', 'open-verified', 'login-required', 'reported-no-public-release-found', 'announced-not-yet-released', 'access-failed'] as const
const OVERLAP = ['direct-evidence', 'geometric-derivation', 'possible', 'insufficient-data'] as const
const DIM_KEYS = ['widthM', 'thicknessM', 'heightM', 'footpadSpanM', 'footpadReachFromCenterM', 'groundClearanceM'] as const
// Evaluation results must never be stored in the static catalog.
const FORBIDDEN_KEYS = ['landingAllowed', 'eligibleForRecommendation', 'conditions', 'summary', 'score', 'rank', 'recommended']

/** Number of decimals in a decimal text such as "-3.0128" (trailing zeros count). */
export const decimalPlaces = (text: string) => (text.split('.')[1] ?? '').length

function scanForbidden(v: unknown, path: string, errors: string[]) {
  if (Array.isArray(v)) v.forEach((x, i) => scanForbidden(x, `${path}[${i}]`, errors))
  else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.includes(k)) errors.push(`${path}.${k}: evaluation results must not be stored in the catalog`)
      scanForbidden(x, `${path}.${k}`, errors)
    }
  }
}

function validateAccuracy(a: unknown, path: string, errors: string[]) {
  if (!isObj(a) || !numOrNull(a.value) || (isNum(a.value) && a.value < 0) || !nonEmpty(a.unit) || !nonEmpty(a.statistic) || !nonEmpty(a.note)) {
    errors.push(`${path} must have value (number >= 0 or null), unit, statistic and note`)
  }
}

function validateProduct(p: unknown, i: number, errors: string[]) {
  const path = `terrainProducts[${i}]`
  if (!isObj(p)) { errors.push(`${path} must be an object`); return }
  for (const k of ['id', 'name', 'productCode', 'publisher', 'format', 'coverage', 'gridSpacingNote', 'effectiveResolutionNote', 'frame', 'verticalDatum']) {
    if (!nonEmpty(p[k])) errors.push(`${path}.${k} must be a non-empty string`)
  }
  // Unknown stays null; it is never coerced to 0.
  if (p.version !== null && !nonEmpty(p.version)) errors.push(`${path}.version must be a string or null`)
  if (!(p.gridSpacingM === null || (isNum(p.gridSpacingM) && p.gridSpacingM > 0))) errors.push(`${path}.gridSpacingM must be positive or null`)
  validateAccuracy(p.verticalAccuracy, `${path}.verticalAccuracy`, errors)
  validateAccuracy(p.horizontalAccuracy, `${path}.horizontalAccuracy`, errors)
  const av = p.availability
  if (!isObj(av) || !oneOf(av.state, AVAILABILITY) || !nonEmpty(av.note)) errors.push(`${path}.availability is invalid`)
  const u = p.uses
  if (!isObj(u) || !(['regionalTerrain', 'horizon', 'footprintSlope', 'obstacle'] as const).every((k) => oneOf(u[k], USES))) errors.push(`${path}.uses is invalid`)
  if (!oneOf(p.verification, VERIFICATIONS)) errors.push(`${path}.verification is invalid`)
  if (!srcIds(p.sourceIds) || p.sourceIds.length === 0) errors.push(`${path}.sourceIds must list SRC- IDs`)
  if (!Array.isArray(p.limitations)) errors.push(`${path}.limitations must be a list`)
}

function validateCoverage(c: unknown, path: string, errors: string[]) {
  if (!isObj(c) || !oneOf(c.status, COVERAGE_STATUS) || !oneOf(c.method, COVERAGE_METHOD) || !nonEmpty(c.note)) errors.push(`${path} must have status, method and note`)
}

function validateCandidate(c: unknown, i: number, productIds: Set<string>, errors: string[]) {
  const path = `candidates[${i}]`
  if (!isObj(c)) { errors.push(`${path} must be an object`); return }
  if (typeof c.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id)) errors.push(`${path}.id must be a lowercase kebab-case ID`)
  if (!nonEmpty(c.name)) errors.push(`${path}.name must be a non-empty English name`)
  if (c.origin !== 'historical') errors.push(`${path}.origin must be "historical"`)

  const co = c.coordinate
  if (!isObj(co)) errors.push(`${path}.coordinate is required`)
  else {
    const lat = co.lat, lon = co.lon
    if (!isNum(lat) || lat < -90 || lat > 90) errors.push(`${path}.coordinate.lat must be a finite latitude`)
    if (!isNum(lon) || lon < -180 || lon > 180) errors.push(`${path}.coordinate.lon must be a finite longitude in -180..180`)
    // The text is the source of truth for precision; the number must be exactly what the text says.
    for (const [num, text, label] of [[lat, co.latText, 'lat'], [lon, co.lonText, 'lon']] as const) {
      if (typeof text !== 'string' || !/^-?\d+(\.\d+)?$/.test(text) || (isNum(num) && Number(text) !== num)) errors.push(`${path}.coordinate.${label}Text must be the decimal text of ${label}`)
    }
    const m = typeof co.sourceText === 'string' ? co.sourceText.match(/^(\d+(?:\.\d+)?) ([NS]), (\d+(?:\.\d+)?) ([EW])$/) : null
    if (!m) errors.push(`${path}.coordinate.sourceText must look like "3.0128 S, 23.4219 W"`)
    else if (isNum(lat) && isNum(lon) && typeof co.latText === 'string' && typeof co.lonText === 'string') {
      const sLat = (m[2] === 'S' ? -1 : 1) * Number(m[1])
      const sLon = (m[4] === 'W' ? -1 : 1) * Number(m[3])
      if (sLat !== lat || sLon !== lon) errors.push(`${path}.coordinate.sourceText disagrees with lat/lon`)
      if (decimalPlaces(m[1]) !== decimalPlaces(co.latText.replace('-', '')) || decimalPlaces(m[3]) !== decimalPlaces(co.lonText.replace('-', ''))) errors.push(`${path}.coordinate decimals differ from the source text`)
    }
    if (typeof co.lonEast360Text !== 'string' || !isNum(lon) || Math.abs(Number(co.lonEast360Text) - ((lon + 360) % 360)) > 1e-9) errors.push(`${path}.coordinate.lonEast360Text must match lon`)
    if (!srcIds([co.sourceId])) errors.push(`${path}.coordinate.sourceId must be an SRC- ID`)
  }

  if (!Array.isArray(c.alternateCoordinates)) errors.push(`${path}.alternateCoordinates must be a list`)
  else c.alternateCoordinates.forEach((a, j) => {
    const ap = `${path}.alternateCoordinates[${j}]`
    if (!isObj(a) || !isNum(a.lat) || a.lat < -90 || a.lat > 90 || !isNum(a.lon) || a.lon < -180 || a.lon > 180) { errors.push(`${ap} needs finite coordinates`); return }
    if (!(a.uncertaintyM === null || (isNum(a.uncertaintyM) && a.uncertaintyM >= 0))) errors.push(`${ap}.uncertaintyM must be >= 0 or null`)
    // The statistical meaning is unknown for these sources; claiming 1-sigma or a maximum would be invented.
    if (a.uncertaintyStatistic !== 'unknown') errors.push(`${ap}.uncertaintyStatistic must be "unknown"`)
    if (typeof a.frameReconciled !== 'boolean' || !nonEmpty(a.frame) || !nonEmpty(a.coordinateMethod)) errors.push(`${ap} needs frame, frameReconciled and coordinateMethod`)
    if (!srcIds([a.sourceId])) errors.push(`${ap}.sourceId must be an SRC- ID`)
  })
  if (!Array.isArray(c.otherReportedCoordinates)) errors.push(`${path}.otherReportedCoordinates must be a list`)
  else c.otherReportedCoordinates.forEach((o, j) => {
    if (!isObj(o) || !isNum(o.lat) || !isNum(o.lon) || !srcIds(o.sourceIds) || !oneOf(o.verification, VERIFICATIONS) || !nonEmpty(o.note)) errors.push(`${path}.otherReportedCoordinates[${j}] is invalid`)
  })

  const hw = c.hardware
  if (!isObj(hw)) errors.push(`${path}.hardware is required`)
  else {
    if (hw.existence !== 'coordinate-marks-hardware') errors.push(`${path}.hardware.existence is invalid`)
    const dims = hw.dimensionsM
    if (dims !== null) {
      if (!isObj(dims)) errors.push(`${path}.hardware.dimensionsM must be an object or null`)
      else for (const k of DIM_KEYS) {
        // Unknown is null. Zero would read as "measured, nothing there".
        if (!(dims[k] === null || (isNum(dims[k]) && (dims[k] as number) > 0))) errors.push(`${path}.hardware.dimensionsM.${k} must be a positive number or null`)
      }
    }
    if (!srcIds(hw.dimensionsSourceIds)) errors.push(`${path}.hardware.dimensionsSourceIds must be SRC- IDs`)
    if (dims && Object.values(dims).some((v) => v !== null) && (srcIds(hw.dimensionsSourceIds) && hw.dimensionsSourceIds.length === 0)) errors.push(`${path}.hardware.dimensionsM has values but no source`)
    const fo = hw.footprintOverlap
    if (!isObj(fo) || !oneOf(fo.level, OVERLAP) || !nonEmpty(fo.basis) || !srcIds(fo.sourceIds) || fo.sourceIds.length === 0) errors.push(`${path}.hardware.footprintOverlap is invalid`)
    if (!Array.isArray(hw.nearbyObjects) || !hw.nearbyObjects.every((o) => isObj(o) && nonEmpty(o.objectId) && isNum(o.lat) && isNum(o.lon) && isNum(o.distanceFromCandidateM) && numOrNull(o.uncertaintyM))) errors.push(`${path}.hardware.nearbyObjects is invalid`)
  }

  const t = c.terrain
  if (!isObj(t)) errors.push(`${path}.terrain is required`)
  else {
    const refs = [...(Array.isArray(t.regionalProducts) ? t.regionalProducts : []), ...(Array.isArray(t.otherProducts) ? t.otherProducts : [])]
    for (const r of refs) if (!isObj(r) || typeof r.productId !== 'string' || !productIds.has(r.productId)) errors.push(`${path}.terrain references unknown product ${isObj(r) ? String(r.productId) : '?'}`)
    if (!Array.isArray(t.regionalProducts) || t.regionalProducts.length === 0) errors.push(`${path}.terrain.regionalProducts must not be empty`)
    else t.regionalProducts.forEach((r, j) => {
      validateCoverage(isObj(r) ? r.coverage : null, `${path}.terrain.regionalProducts[${j}].coverage`, errors)
      if (isObj(r) && r.qualityResidualRmsM !== undefined && !(isNum(r.qualityResidualRmsM) && r.qualityResidualRmsM >= 0)) errors.push(`${path}.terrain.regionalProducts[${j}].qualityResidualRmsM must be >= 0`)
    })
    if (!Array.isArray(t.localDtms)) errors.push(`${path}.terrain.localDtms must be a list`)
    else t.localDtms.forEach((d, j) => {
      const dp = `${path}.terrain.localDtms[${j}]`
      if (!isObj(d)) { errors.push(`${dp} must be an object`); return }
      if (!nonEmpty(d.productId) || !/^NAC_DTM_/.test(String(d.productId))) errors.push(`${dp}.productId must be a NAC_DTM_ product ID`)
      if (!isNum(d.postingM) || d.postingM <= 0) errors.push(`${dp}.postingM must be positive`)
      for (const k of ['relativeLinearError90M', 'lolaRmsM', 'lolaMeanAbsM', 'adjustRmsM']) if (!numOrNull(d[k]) || (isNum(d[k]) && (d[k] as number) < 0)) errors.push(`${dp}.${k} must be >= 0 or null`)
      validateCoverage(d.coverage, `${dp}.coverage`, errors)
      const ps = d.pointSample
      if (!isObj(ps) || !numOrNull(ps.centerElevationM) || !numOrNull(ps.centerConfidenceCode) || !isNum(ps.windowPixelCount) || !isNum(ps.windowValidMatchCount) || ps.windowValidMatchCount < 0 || ps.windowValidMatchCount > ps.windowPixelCount || !isObj(ps.confidenceCodeCounts) || typeof ps.nonStandardCodesObserved !== 'boolean') errors.push(`${dp}.pointSample is invalid`)
      else if (Object.values(ps.confidenceCodeCounts).reduce<number>((a, v) => a + (isNum(v) ? v : NaN), 0) !== ps.windowPixelCount) errors.push(`${dp}.pointSample confidence counts do not add up to the window size`)
    })
  }
  if (!Array.isArray(c.limitations) || c.limitations.length === 0) errors.push(`${path}.limitations must not be empty`)
}

export type CatalogParse = { ok: true; catalog: CandidateCatalog } | { ok: false; errors: string[] }

/** Validate untrusted data. Never throws. */
export function parseCandidateCatalog(raw: unknown): CatalogParse {
  const errors: string[] = []
  if (!isObj(raw)) return { ok: false, errors: ['Catalog must be an object'] }
  if (raw.schema !== CATALOG_SCHEMA) errors.push(`schema must be "${CATALOG_SCHEMA}"`)
  if (raw.schemaVersion !== CATALOG_SCHEMA_VERSION) errors.push(`unsupported schemaVersion ${String(raw.schemaVersion)}`)
  for (const k of ['catalogId', 'dataVersion', 'description']) if (!nonEmpty(raw[k])) errors.push(`${k} must be a non-empty string`)
  const cs = raw.coordinateSource
  if (!isObj(cs) || !srcIds([cs.sourceId]) || !nonEmpty(cs.url) || !nonEmpty(cs.frame) || !nonEmpty(cs.listVersion)) errors.push('coordinateSource needs sourceId, url, frame and listVersion')
  scanForbidden(raw, '$', errors)

  const productIds = new Set<string>()
  if (!Array.isArray(raw.terrainProducts)) errors.push('terrainProducts must be a list')
  else raw.terrainProducts.forEach((p, i) => {
    validateProduct(p, i, errors)
    if (isObj(p) && typeof p.id === 'string') {
      if (productIds.has(p.id)) errors.push(`duplicate terrain product ID ${p.id}`)
      productIds.add(p.id)
    }
  })
  const ids = new Set<string>()
  if (!Array.isArray(raw.candidates) || raw.candidates.length === 0) errors.push('candidates must be a non-empty list')
  else raw.candidates.forEach((c, i) => {
    validateCandidate(c, i, productIds, errors)
    if (isObj(c) && typeof c.id === 'string') {
      if (ids.has(c.id)) errors.push(`duplicate candidate ID ${c.id}`)
      ids.add(c.id)
    }
  })
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, catalog: raw as unknown as CandidateCatalog }
}

let cached: CandidateCatalog | null = null

/** The bundled catalog. Throws with every problem listed if the file is invalid (fail fast at start-up). */
export function loadCandidateCatalog(): CandidateCatalog {
  if (cached) return cached
  const r = parseCandidateCatalog(catalogJson)
  if (!r.ok) throw new Error(`Invalid candidate catalog: ${r.errors.join('; ')}`)
  cached = r.catalog
  return cached
}

// ─── Adapters ──────────────────────────────────────────────────────────────

/** The registry entry in the shape used by assessments and snapshots. Coordinates stay the NSSDCA values. */
export function toCandidateRecord(c: CatalogCandidate, catalog: CandidateCatalog): CandidateRecord {
  const cs = catalog.coordinateSource
  return {
    id: c.id,
    name: c.name,
    origin: 'historical',
    lat: c.coordinate.lat,
    lon: c.coordinate.lon,
    frame: cs.frame,
    source: { id: cs.sourceId, title: cs.title, kind: 'dataset', url: cs.url, note: cs.listVersion },
    hardwareNote: `${c.hardware.description} Footprint overlap evidence: ${c.hardware.footprintOverlap.level}.`,
  }
}

/**
 * The state of a site before any mission is evaluated: every condition unknown, so landingAllowed is null and the
 * site is not eligible. Terrain data limits and hardware evidence live in the catalog, not in this state.
 */
export function initialSiteAssessment(c: CatalogCandidate): SiteAssessment {
  const conditions: SiteConditions = {
    terrain: notEvaluated('Terrain has not been evaluated for this mission'),
    power: notEvaluated('Power has not been evaluated for this mission'),
    communication: notEvaluated('Direct Earth visibility has not been evaluated for this mission'),
    dataCompleteness: notEvaluated('Data completeness has not been evaluated for this mission'),
  }
  return assessSite(c.id, conditions)
}

const M_PER_DEG = (Math.PI / 180) * 1_737_400

/**
 * Half of the last printed decimal step, in metres (north-south, east-west). DERIVED from the number of decimals
 * under the assumption that the source rounded to its printed precision; it is not a measurement error published by
 * the source (NSSDCA only says precision is reflected in the number of decimals).
 */
export function quantizationHalfStepM(c: CatalogCandidate['coordinate']): { northSouthM: number; eastWestM: number } {
  const half = (text: string) => 0.5 * 10 ** -decimalPlaces(text.replace('-', ''))
  return {
    northSouthM: half(c.latText) * M_PER_DEG,
    eastWestM: half(c.lonText) * M_PER_DEG * Math.cos((c.lat * Math.PI) / 180),
  }
}

/** Great-circle distance in metres on the 1737.4 km sphere. Compares coordinates without implying the frames match. */
export function surfaceDistanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2
  return 2 * 1_737_400 * Math.asin(Math.min(1, Math.sqrt(h)))
}
