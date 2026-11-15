// Serializable terrain horizon, and the bridge to the runtime Horizon function.
//
// A Horizon function cannot be structured-cloned (Web Worker) or stored (detail snapshot). Everything that crosses
// those boundaries carries HorizonData; the function is rebuilt where it is used, with runtimeHorizon().
import { horizonFromSamples } from '../physics/horizon'
import type { Horizon } from '../physics/horizon'
import type { ConditionResult } from './assessment'
import type { Site } from './site'

export type HorizonSamples = {
  /** Skyline elevation above the local horizontal plane at each azimuth. */
  elevationsDeg: number[]
  /** Azimuth of elevationsDeg[0], clockwise from north. */
  startAzimuthDeg: number
  /** Spacing between samples. elevationsDeg.length x stepDeg must equal 360. */
  stepDeg: number
  angleUnit: 'deg'
}

export type TerrainSourceMeta = {
  /** e.g. 'LRO LOLA GDR LDEM_4 (PDS Geosciences Node)' */
  product: string
  /** Grid posting of the elevation product, km. Not the same as image resolution or detectable obstacle size. */
  gridSpacingKm: number
  /** Vertical accuracy of the product, m; null when not established. */
  verticalAccuracyM: number | null
  /** Reference body radius used by the product, km. */
  referenceRadiusKm: number
  /** Coordinate frame of the product, e.g. 'LOLA mean Earth/polar axis'. */
  frame: string
}

/** Parameters of the ray-casting model that produced the skyline. Modelling choices, not measured hardware facts. */
export type HorizonModelParams = {
  maxRangeKm: number
  mastM: number
  /** Distance between samples along each ray, km. */
  rayStepKm: number
  /** Ground elevation at the observer above the reference sphere, m. */
  observerElevationM: number
}

export type HorizonUnavailableCode =
  | 'not-loaded' | 'no-coverage' | 'insufficient-resolution' | 'service-error' | 'not-precomputed' | 'parse-error'

/** How the observer's ground elevation was obtained (one value shared by horizon, sky and endpoint). */
export type SiteElevationQuality =
  | 'measured' // NAC DTM, confidence code 10-15 at the site pixel
  | 'interpolated' // NAC DTM, confidence code 4
  | 'suspicious-confidence' // NAC DTM value used, but the site pixel is flagged (code 0-3)
  | 'confidence-legend-unconfirmed' // NAC DTM whose confidence codes do not follow the README table
  | 'regional-fallback' // no usable NAC value; regional product (SLDEM2015 / LOLA polar)
  | 'regional-grid' // LDEM_4 preview path

export type HorizonObserver = {
  /** Ground elevation, metres above the 1737.4 km reference sphere. */
  elevationM: number
  elevationSource: string
  elevationQuality: SiteElevationQuality
  /** Observer height above the ground, m (project assumption ASM-OBSERVER-HEIGHT when 0). */
  observerHeightM: number
  /** Reference radius + elevation + observer height, km. The single observer position for sky and endpoint. */
  radiusKm: number
}

/**
 * Where the skyline is known. `sampleStatus[i] = 'lower-bound'` means a data gap or the search limit was met along
 * that azimuth, so the true skyline may be higher. `nearField`: 'screened' = NAC DTM samples filtered by an
 * interpretable confidence map; 'unscreened' = NAC DTM used without a usable confidence legend; 'absent' = no
 * near-field product (regional grids only).
 */
export type HorizonCoverage = {
  searchRangeKm: number
  nearStartKm: number
  complete: boolean
  nearField: 'screened' | 'unscreened' | 'absent'
  sampleStatus: Array<'complete' | 'lower-bound'>
  coveredToKm: number[]
  governingKm: Array<number | null>
  governingSource: Array<string | null>
  /** atan(sqrt(2) sigma / d) of the governing sample, deg; null when the product sigma is unknown. */
  uncertaintyDeg: Array<number | null>
  fallbackSamples: number
  skippedSamples: number
  lowerBoundAzimuths: number
}

export type HorizonProduct = {
  role: 'near' | 'mid' | 'far'
  productId: string
  version: string | null
  sourceId: string
  bandKm: [number, number]
  gridSpacingM: number
  frame: string
  frameVerification: string
}

export type HorizonData =
  | {
      status: 'available'
      site: { lat: number; lon: number }
      samples: HorizonSamples
      source: TerrainSourceMeta
      model: HorizonModelParams
      /** Step 07 fields; absent on older or preview horizons, which then cannot pass requireHorizon. */
      observer?: HorizonObserver
      coverage?: HorizonCoverage
      products?: HorizonProduct[]
    }
  | {
      status: 'unavailable'
      site: { lat: number; lon: number }
      code: HorizonUnavailableCode
      message: string
    }

/** Returns problems with the samples; an empty list means they can be turned into a Horizon. */
export function validateHorizonSamples(s: HorizonSamples): string[] {
  const errors: string[] = []
  const n = s.elevationsDeg.length
  if (n < 2) errors.push('At least 2 horizon samples are required')
  if (!(s.stepDeg > 0) || !Number.isFinite(s.stepDeg)) errors.push('Horizon sample step must be a positive number')
  else if (n >= 2 && Math.abs(n * s.stepDeg - 360) > 1e-6) errors.push(`Horizon samples cover ${n * s.stepDeg} deg, expected 360`)
  if (!Number.isFinite(s.startAzimuthDeg)) errors.push('Horizon start azimuth must be finite')
  if (s.elevationsDeg.some((e) => !Number.isFinite(e) || e < -90 || e > 90)) {
    errors.push('Horizon elevations must be finite and within -90..90 deg')
  }
  return errors
}

/** Problems with the coverage block (array lengths must match the samples). */
export function validateHorizonCoverage(c: HorizonCoverage, sampleCount: number): string[] {
  const errors: string[] = []
  for (const k of ['sampleStatus', 'coveredToKm', 'governingKm', 'governingSource', 'uncertaintyDeg'] as const) {
    if (!Array.isArray(c[k]) || c[k].length !== sampleCount) errors.push(`coverage.${k} must have one entry per sample`)
  }
  if (Array.isArray(c.sampleStatus) && c.complete !== c.sampleStatus.every((x) => x === 'complete')) errors.push('coverage.complete disagrees with sampleStatus')
  if (!['screened', 'unscreened', 'absent'].includes(c.nearField)) errors.push('coverage.nearField is invalid')
  if (!(c.searchRangeKm > 0) || !(c.nearStartKm > 0)) errors.push('coverage ranges must be positive')
  return errors
}

/**
 * Rebuild the runtime function. Returns null when no usable horizon exists, and also when some azimuths are only
 * lower bounds, unless `allowPartial` is set (previews): interpolating across unknown azimuths would claim knowledge
 * the data do not have.
 */
export function runtimeHorizon(data: HorizonData, opts: { allowPartial?: boolean } = {}): Horizon | null {
  if (data.status !== 'available') return null
  if (data.coverage && !data.coverage.complete && !opts.allowPartial) return null
  const errors = validateHorizonSamples(data.samples)
  if (errors.length > 0) throw new Error(`Invalid horizon data: ${errors.join('; ')}`)
  const { elevationsDeg, startAzimuthDeg, stepDeg } = data.samples
  return horizonFromSamples(elevationsDeg, startAzimuthDeg, stepDeg)
}

/**
 * Gate for the new evaluation flow. A missing horizon never falls back to a smooth sphere:
 * missing or too-coarse data -> 'unknown', a failed request -> 'error'.
 */
export function requireHorizon(data: HorizonData):
  | { ok: true; horizon: Horizon }
  | { ok: false; condition: ConditionResult } {
  if (data.status !== 'available') {
    return {
      ok: false,
      condition: {
        status: data.code === 'service-error' || data.code === 'parse-error' ? 'error' : 'unknown',
        reasons: [{ code: `horizon-${data.code}`, message: data.message }],
      },
    }
  }
  const unknown = (code: string, message: string) => ({ ok: false as const, condition: { status: 'unknown' as const, reasons: [{ code, message }] } })
  // Formal use needs a horizon whose coverage is recorded, complete, and whose near field was quality-screened.
  if (!data.coverage || !data.observer) return unknown('horizon-coverage-unknown', 'The horizon does not record its coverage or observer position')
  if (data.coverage.nearField === 'absent') return unknown('horizon-no-near-field', 'Only regional terrain is available near the site')
  if (data.coverage.nearField === 'unscreened') return unknown('horizon-near-field-unscreened', 'Near-field terrain could not be screened with its confidence map')
  if (!data.coverage.complete) return unknown('horizon-partial-coverage', `${data.coverage.lowerBoundAzimuths} azimuths are lower bounds (data gaps)`)
  return { ok: true, horizon: runtimeHorizon(data)! }
}

/** Plain-data site for Workers and snapshots. `horizon: null` means no terrain was attached. */
export type SerializableSite = { id: string; name?: string; lat: number; lon: number; horizon: HorizonData | null }

/**
 * Runtime Site for the calculation API. Without an available horizon the Site is a smooth sphere: usable for
 * labelled previews and low-level tests, never as evidence for eligibility (use requireHorizon for that).
 */
export function toRuntimeSite(s: SerializableSite, opts: { allowPartial?: boolean } = {}): Site {
  const horizon = s.horizon ? runtimeHorizon(s.horizon, opts) : null
  // The observer radius travels with the horizon so the sky uses the same position as the skyline.
  const radiusKm = s.horizon?.status === 'available' && s.horizon.observer ? s.horizon.observer.radiusKm : undefined
  return { name: s.name, lat: s.lat, lon: s.lon, ...(horizon ? { horizon } : {}), ...(radiusKm !== undefined ? { radiusKm } : {}) }
}
