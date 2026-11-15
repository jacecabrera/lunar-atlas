// Terrain queries for any point on the Moon, backed by a LOLA elevation grid (see tools/buildDem.mjs).
// Load the grid once with loadTerrain(); every query after that is synchronous.
import { Dem, slopeAt, horizonProfile, DEFAULT_HORIZON_RANGE_KM, DEFAULT_MAST_M } from '../physics/dem'
import type { DemMeta, HorizonOptions } from '../physics/dem'
import { horizonFromSamples } from '../physics/horizon'
import type { Horizon } from '../physics/horizon'
import type { HorizonData } from './horizonData'

export { Dem }
export type { DemMeta, HorizonOptions }

let current: Dem | null = null
// Product label for metadata; set by loadTerrain from the grid's JSON sidecar.
let currentProduct = 'unknown DEM'

export function setTerrain(dem: Dem | null, product = 'unknown DEM') {
  current = dem
  currentProduct = product
}

export function terrainLoaded(): boolean {
  return current !== null
}

// Fetch <base>.json and <base>.bin (default: the LDEM_4 grid shipped in public/data/lola) and install it.
export async function loadTerrain(baseUrl = '/data/lola/ldem_4'): Promise<Dem> {
  const [metaRes, binRes] = await Promise.all([fetch(`${baseUrl}.json`), fetch(`${baseUrl}.bin`)])
  if (!metaRes.ok || !binRes.ok) throw new Error(`could not load terrain from ${baseUrl}`)
  const meta = (await metaRes.json()) as DemMeta & { source?: string }
  const dem = new Dem(meta, new Int16Array(await binRes.arrayBuffer()))
  setTerrain(dem, meta.source ?? baseUrl)
  return dem
}

function dem(): Dem {
  if (!current) throw new Error('terrain not loaded: call loadTerrain() first')
  return current
}

function check(lat: number, lon: number) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) {
    throw new RangeError(`invalid coordinates: lat ${lat}, lon ${lon}`)
  }
}

export type TerrainPoint = {
  lat: number
  lon: number
  elevationM: number // above the 1737.4 km reference sphere
  slopeDeg: number // over baselineM
  aspectDeg: number | null // downhill direction, clockwise from north; null when flat
  baselineM: number // the distance the slope was measured over
  resolutionKm: number // grid pixel size; slope and elevation cannot show anything smaller
}

// Elevation and slope at a point. The slope baseline is never smaller than one grid pixel, because
// finer values would just be interpolation. Coarse grids smooth slopes: treat the result as a regional
// slope, not the slope at the landing ellipse.
export function terrainAt(lat: number, lon: number, opts: { baselineM?: number } = {}): TerrainPoint {
  check(lat, lon)
  const d = dem()
  const baselineM = Math.max(opts.baselineM ?? 0, d.pixelKm * 1000)
  const { slopeDeg, aspectDeg } = slopeAt(d, lat, lon, baselineM)
  return {
    lat, lon,
    elevationM: d.heightAt(lat, lon),
    slopeDeg, aspectDeg, baselineM,
    resolutionKm: d.pixelKm,
  }
}

// The azimuth step must divide 360 so that samples * step covers the circle exactly. Before step 03 a step such
// as 7 deg produced 51 samples that were then interpolated as if spaced 360/51 deg apart.
function azimuthStep(opts: HorizonOptions): number {
  const step = opts.azimuthStepDeg ?? 1
  const n = Math.round(360 / step)
  if (!(step > 0) || Math.abs(n * step - 360) > 1e-9) throw new RangeError(`azimuthStepDeg must divide 360, got ${step}`)
  return step
}

// Skyline elevation (degrees) at azimuths 0, step, 2*step ... clockwise from north. Handy for plotting.
// 360 values only with the default 1 deg step.
export function horizonProfileAt(lat: number, lon: number, opts: HorizonOptions = {}): number[] {
  check(lat, lon)
  azimuthStep(opts)
  return horizonProfile(dem(), lat, lon, opts)
}

// The same skyline as a Horizon function, ready for Site.horizon, skyAt, windows and compareSites.
export function horizonAt(lat: number, lon: number, opts: HorizonOptions = {}): Horizon {
  return horizonFromSamples(horizonProfileAt(lat, lon, opts), 0, azimuthStep(opts))
}

// The skyline as serializable data with its source and model parameters, for Workers and snapshots.
// No terrain loaded -> status 'unavailable' (not a smooth-sphere fallback). Invalid coordinates still throw.
export function horizonDataAt(lat: number, lon: number, opts: HorizonOptions = {}): HorizonData {
  check(lat, lon)
  if (!current) {
    return { status: 'unavailable', site: { lat, lon }, code: 'not-loaded', message: 'Terrain data has not been loaded' }
  }
  const d = current
  const stepDeg = azimuthStep(opts)
  return {
    status: 'available',
    site: { lat, lon },
    samples: { elevationsDeg: horizonProfile(d, lat, lon, opts), startAzimuthDeg: 0, stepDeg, angleUnit: 'deg' },
    source: {
      product: currentProduct,
      gridSpacingKm: d.pixelKm,
      verticalAccuracyM: null, // not established for the shipped grid
      referenceRadiusKm: d.meta.radiusKm,
      frame: 'LOLA mean Earth/polar axis (not yet reconciled with the IAU frame used by the sky model)',
    },
    model: {
      maxRangeKm: opts.maxRangeKm ?? DEFAULT_HORIZON_RANGE_KM,
      mastM: opts.mastM ?? DEFAULT_MAST_M,
      rayStepKm: opts.stepKm ?? d.pixelKm / 2,
      observerElevationM: d.heightAt(lat, lon),
    },
  }
}
