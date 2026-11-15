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

export type HorizonUnavailableCode = 'not-loaded' | 'no-coverage' | 'insufficient-resolution' | 'service-error'

export type HorizonData =
  | {
      status: 'available'
      site: { lat: number; lon: number }
      samples: HorizonSamples
      source: TerrainSourceMeta
      model: HorizonModelParams
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

/** Rebuild the runtime function. Returns null when no usable horizon exists. */
export function runtimeHorizon(data: HorizonData): Horizon | null {
  if (data.status !== 'available') return null
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
  if (data.status === 'available') return { ok: true, horizon: runtimeHorizon(data)! }
  return {
    ok: false,
    condition: {
      status: data.code === 'service-error' ? 'error' : 'unknown',
      reasons: [{ code: `horizon-${data.code}`, message: data.message }],
    },
  }
}

/** Plain-data site for Workers and snapshots. `horizon: null` means no terrain was attached. */
export type SerializableSite = { id: string; name?: string; lat: number; lon: number; horizon: HorizonData | null }

/**
 * Runtime Site for the calculation API. Without an available horizon the Site is a smooth sphere: usable for
 * labelled previews and low-level tests, never as evidence for eligibility (use requireHorizon for that).
 */
export function toRuntimeSite(s: SerializableSite): Site {
  const horizon = s.horizon ? runtimeHorizon(s.horizon) : null
  return { name: s.name, lat: s.lat, lon: s.lon, ...(horizon ? { horizon } : {}) }
}
