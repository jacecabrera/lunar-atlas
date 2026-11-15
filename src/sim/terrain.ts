// Terrain queries for any point on the Moon, backed by a LOLA elevation grid (see tools/buildDem.mjs).
// Load the grid once with loadTerrain(); every query after that is synchronous.
import { Dem, slopeAt, horizonProfile } from '../physics/dem'
import type { DemMeta, HorizonOptions } from '../physics/dem'
import { horizonFromProfile } from '../physics/horizon'
import type { Horizon } from '../physics/horizon'

export { Dem }
export type { DemMeta, HorizonOptions }

let current: Dem | null = null

export function setTerrain(dem: Dem | null) {
  current = dem
}

export function terrainLoaded(): boolean {
  return current !== null
}

// Fetch <base>.json and <base>.bin (default: the LDEM_4 grid shipped in public/data/lola) and install it.
export async function loadTerrain(baseUrl = '/data/lola/ldem_4'): Promise<Dem> {
  const [metaRes, binRes] = await Promise.all([fetch(`${baseUrl}.json`), fetch(`${baseUrl}.bin`)])
  if (!metaRes.ok || !binRes.ok) throw new Error(`could not load terrain from ${baseUrl}`)
  const meta = (await metaRes.json()) as DemMeta
  const dem = new Dem(meta, new Int16Array(await binRes.arrayBuffer()))
  current = dem
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

// Skyline elevation (degrees) at azimuths 0, step, 2*step ... clockwise from north. Handy for plotting.
export function horizonProfileAt(lat: number, lon: number, opts: HorizonOptions = {}): number[] {
  check(lat, lon)
  return horizonProfile(dem(), lat, lon, opts)
}

// The same skyline as a Horizon function, ready for Site.horizon, skyAt, windows and compareSites.
export function horizonAt(lat: number, lon: number, opts: HorizonOptions = {}): Horizon {
  return horizonFromProfile(horizonProfileAt(lat, lon, opts))
}
