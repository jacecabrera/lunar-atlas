// Regional estimate inputs from the global terrain (LDEM_16, about 1.9 km posting): elevation, regional slope and a skyline for
// any coordinate, and the fill of lower-bound azimuths of a published horizon. One code path for catalogue sites, search points
// and custom points. Everything here says how coarse it is; none of it is a footprint-scale or 0.3 m statement.
//
// Spatial scale (stated, not tuned to results): the product posts every ~1.9 km, so
//  - slope is a central difference across one pixel on each side: baseline 2 pixels, about 3.8 km (REGIONAL_SLOPE_BASELINE_PX);
//  - the skyline is cast at 1 deg azimuth steps to 200 km, sampling every half pixel, starting one pixel away from the
//    observer: terrain closer than about 1.9 km (and anything smaller than a pixel) is not represented.
import { castHorizon } from '../physics/horizonCast'
import type { CastAzimuth } from '../physics/horizonCast'
import { destination } from '../physics/dem'
import { MOON_R_KM } from '../physics/siteSky'
import type { HorizonData, HorizonEstimation } from './horizonData'
import { pixelKm } from './globalTerrain'
import type { TiledHeights } from './globalTerrain'

export const REGIONAL_MODEL = 'regional-v1:ldem16(1.9km);slope=central-difference(2px);skyline=cast-1deg-200km-from-1px;lower-bound-azimuths=max(published,global-cast);estimated'
export const REGIONAL_SLOPE_BASELINE_PX = 2
export const REGIONAL_AZIMUTH_STEP_DEG = 1
export const REGIONAL_RANGE_KM = 200

export type RegionalFail = { ok: false; code: 'no-tile' | 'invalid-input'; message: string }

const PRODUCT = 'LRO LOLA GDR LDEM_16 (PDS Geosciences Node)'

/** Site elevation (m above the 1737.4 km sphere) from the global product, or null when its tile is not loaded. */
export function regionalElevationM(h: TiledHeights, lat: number, lon: number): number | null {
  return h.heightAt(lat, lon)
}

export type RegionalSlope = { slopeDeg: number; baselineKm: number; postingKm: number; product: string }

/** Slope over REGIONAL_SLOPE_BASELINE_PX pixels (north-south and east-west central differences). Null when any needed sample is missing. */
export function regionalSlope(h: TiledHeights, lat: number, lon: number): RegionalSlope | null {
  const post = pixelKm(h.layout)
  const baselineKm = REGIONAL_SLOPE_BASELINE_PX * post
  const half = (baselineKm / 2) / h.layout.radiusKm
  const z = (b: number) => { const p = destination(lat, lon, b, half); return h.heightAt(p.lat, p.lon) }
  const n = z(0), s = z(180), e = z(90), w = z(270)
  if (n === null || s === null || e === null || w === null) return null
  const g = Math.hypot((n - s) / (baselineKm * 1000), (e - w) / (baselineKm * 1000))
  return { slopeDeg: Math.atan(g) * 180 / Math.PI, baselineKm, postingKm: post, product: PRODUCT }
}

function castFrom(h: TiledHeights, lat: number, lon: number, observerRadiusKm: number, stepDeg: number, startAz: number): CastAzimuth[] {
  const post = pixelKm(h.layout)
  return castHorizon([{ id: 'LDEM_16', minKm: 0, maxKm: REGIONAL_RANGE_KM, stepKm: post / 2, sample: (a, b) => h.heightAt(a, b), sigmaM: null }], {
    latDeg: lat, lonDeg: lon, observerRadiusKm, referenceRadiusKm: h.layout.radiusKm, azimuthStepDeg: stepDeg, startAzimuthDeg: startAz,
    nearStartKm: post, maxRangeKm: REGIONAL_RANGE_KM, maxSkippedGapKm: 0,
  }).azimuths
}

/**
 * Skyline of a coordinate cast from the global product alone. The result is `available` HorizonData whose coverage honestly says
 * there is no near-field product (nearField 'absent'), so strict evaluation rejects it and only the estimated model uses it.
 */
export function castGlobalHorizon(h: TiledHeights, lat: number, lon: number): { ok: true; horizon: Extract<HorizonData, { status: 'available' }>; elevationM: number } | RegionalFail {
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon)) return { ok: false, code: 'invalid-input', message: 'Invalid coordinate' }
  const elev = h.heightAt(lat, lon)
  if (elev === null) return { ok: false, code: 'no-tile', message: 'The global terrain tile for this coordinate is not loaded' }
  const r0 = h.layout.radiusKm + elev / 1000
  const az = castFrom(h, lat, lon, r0, REGIONAL_AZIMUTH_STEP_DEG, 0)
  if (az.some((a) => !Number.isFinite(a.elevationDeg))) return { ok: false, code: 'no-tile', message: 'Global terrain data are missing along part of the skyline' }
  const post = pixelKm(h.layout)
  const status = az.map((a) => a.status)
  const elevations = az.map((a) => a.elevationDeg)
  const horizon: Extract<HorizonData, { status: 'available' }> = {
    status: 'available', site: { lat, lon },
    samples: { elevationsDeg: elevations, startAzimuthDeg: 0, stepDeg: REGIONAL_AZIMUTH_STEP_DEG, angleUnit: 'deg' },
    source: { product: PRODUCT, gridSpacingKm: post, verticalAccuracyM: null, referenceRadiusKm: h.layout.radiusKm, frame: 'MEAN EARTH/POLAR AXIS OF DE421 (PDS label)' },
    model: { maxRangeKm: REGIONAL_RANGE_KM, mastM: 0, rayStepKm: post / 2, observerElevationM: elev },
    observer: { elevationM: elev, elevationSource: `${PRODUCT}, bilinear`, elevationQuality: 'regional-grid', observerHeightM: 0, radiusKm: r0 },
    coverage: {
      searchRangeKm: REGIONAL_RANGE_KM, nearStartKm: post, complete: status.every((s) => s === 'complete'), nearField: 'absent', sampleStatus: status,
      coveredToKm: az.map((a) => a.coveredToKm), governingKm: az.map((a) => a.governingKm), governingSource: az.map((a) => a.governingSource),
      uncertaintyDeg: az.map((a) => a.uncertaintyDeg), fallbackSamples: 0, skippedSamples: az.reduce((s, a) => s + a.skippedSamples, 0), lowerBoundAzimuths: status.filter((s) => s !== 'complete').length,
    },
    estimation: {
      basis: 'global', estimatedElevationsDeg: elevations, productId: 'LDEM_16', postingKm: post, filledAzimuths: [], nominalLowerBoundAzimuths: status.filter((s) => s !== 'complete').length,
      warnings: [`Skyline cast from the ${post.toFixed(2)} km global product only: terrain closer than ${post.toFixed(1)} km and smaller than a pixel is not represented`],
    },
  }
  return { ok: true, horizon, elevationM: elev }
}

/**
 * A published horizon with its lower-bound azimuths filled for the estimate: the nominal value is the larger of the published lower
 * bound and the global-product cast from the same observer position. Raw samples and coverage are unchanged (they stay lower
 * bounds); the nominal skyline goes into `estimation`. Returns the input unchanged when it has no observer or no lower bounds to fill.
 */
export function fillHorizon(base: HorizonData, h: TiledHeights): HorizonData {
  if (base.status !== 'available' || !base.observer || !base.coverage) return base
  const status = base.coverage.sampleStatus
  const lowerBound = status.map((s, i) => (s === 'lower-bound' ? i : -1)).filter((i) => i >= 0)
  const post = pixelKm(h.layout)
  const warnings: string[] = []
  if (lowerBound.length === 0) {
    return { ...base, estimation: { basis: 'filled', estimatedElevationsDeg: [...base.samples.elevationsDeg], productId: 'LDEM_16', postingKm: post, filledAzimuths: [], nominalLowerBoundAzimuths: 0, warnings } }
  }
  const cast = castFrom(h, base.site.lat, base.site.lon, base.observer.radiusKm, base.samples.stepDeg, base.samples.startAzimuthDeg)
  const est = [...base.samples.elevationsDeg]
  const filled: number[] = []
  for (const i of lowerBound) {
    const g = cast[i]
    if (g && Number.isFinite(g.elevationDeg) && g.coveredToKm > 0 && g.elevationDeg > est[i]) { est[i] = g.elevationDeg; filled.push(i) }
  }
  warnings.push(`${lowerBound.length} azimuth(s) are lower bounds in the published horizon (data gaps); the estimate uses the larger of the lower bound and the ${post.toFixed(1)} km global product (${filled.length} raised)`)
  const estimation: HorizonEstimation = { basis: 'filled', estimatedElevationsDeg: est, productId: 'LDEM_16', postingKm: post, filledAzimuths: filled, nominalLowerBoundAzimuths: lowerBound.length - filled.length, warnings }
  return { ...base, estimation }
}

/** Observer radius used for the transit endpoint of a coordinate with no site package: sphere + global elevation. */
export const regionalObserverRadiusKm = (elevationM: number) => MOON_R_KM + elevationM / 1000
