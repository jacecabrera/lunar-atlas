// Runtime access to the published per-site terrain (public/data/terrain/v1/, built by tools/buildSiteTerrain.mjs).
//
// What a loaded site provides:
//   - the site elevation (one policy, recorded in the manifest) and the observer radius derived from it;
//   - the precomputed terrain horizon (HorizonData with coverage, observer and products);
//   - small near-field (NAC DTM, +/- 0.5 km) and regional (SLDEM2015 / LOLA polar, +/- 10 km) grids. These are NOT the
//     horizon inputs: the horizon was cast offline from +/-1.5 km, +/-31 km and +/-205 km crops (HorizonData.inputs).
//     Grid values are stored with a quantisation step (0.02 m / 0.25 m) that says nothing about their accuracy.
// It does not evaluate any landing condition. Footprint-scale slope and 0.3 m obstacles stay unknown (step 08).
//
// Loading: one shared promise per (data version, site); a failure clears the entry so a later call retries.
// Every binary is checked against the byte length and FNV-1a checksum recorded in its manifest.
import { CategoryGrid, ElevationGrid, decodeInt16 } from '../physics/geoGrid'
import type { Projection } from '../physics/projections'
import { destination } from '../physics/dem'
import { MOON_R_KM } from '../physics/siteSky'
import type { HorizonData, SerializableSite, SiteElevationQuality } from './horizonData'
import { requireHorizon, validateHorizonCoverage, validateHorizonSamples } from './horizonData'
import type { ConditionReason } from './assessment'

// v1.1 (step 08 wrap-up of step 07): horizon quality (selection tier, convergence for every site), inputs, accuracy blocks.
export const TERRAIN_DATA_VERSION = 'terrain-v1.1'

export type SiteElevation = {
  /** Metres above the 1737.4 km reference sphere; null when no product has data at the site. */
  valueM: number | null
  source: string | null
  quality: SiteElevationQuality | 'unavailable'
  confidenceCode: number | null
  /** The regional product's value at the same point, for comparison only. */
  regionalValueM: number | null
}

export type RegionalSlope = { slopeDeg: number; aspectDeg: number | null; baselineM: number; resolutionM: number; product: string }

export type SiteTerrain = {
  siteId: string
  dataVersion: string
  elevation: SiteElevation
  /** Precomputed for observerHeightM = 0; see horizonFor(). */
  horizon: HorizonData
  near: { elevation: ElevationGrid; confidence: CategoryGrid; legendConfirmed: boolean; productId: string } | null
  regional: { elevation: ElevationGrid; productId: string; gridSpacingM: number }
  manifest: SiteTerrainManifest
  /** Observer distance from the Moon's centre, km, or null when the site elevation is unknown. */
  observerRadiusKm: (observerHeightM?: number) => number | null
  /** The horizon for an observer height; only the precomputed height is available. */
  horizonFor: (observerHeightM?: number) => HorizonData
  /** Regional slope over a stated baseline (at least two regional pixels). Never a 3 m footprint slope. */
  regionalSlope: (baselineM?: number) => RegionalSlope | null
  /** Plain data for Workers and snapshots. */
  toSerializableSite: () => SerializableSite
}

type FileEntry = { path: string; bytes: number; sha256: string; fnv1a32: string }
type GridFile = FileEntry & {
  layout: { width: number; height: number; dtype: 'int16' | 'uint8'; offsetM?: number; scaleM?: number; nodata?: number; legendConfirmedForThisDtm?: boolean }
  projection: Projection
  productId?: string
}
export type SiteTerrainManifest = {
  schema: 'lunar-navigator.site-terrain'
  schemaVersion: 1
  dataVersion: string
  siteId: string
  site: { lat: number; lon: number }
  settings: { observerHeightM: number }
  siteElevation: SiteElevation
  files: { near?: GridFile; nearConfidence?: GridFile; regional: GridFile; horizon?: FileEntry }
  products: Array<{ role: string; productId: string; gridSpacingM: number }>
}

export type TerrainErrorKind = 'not-found' | 'network' | 'corrupt' | 'parse'
export class TerrainLoadError extends Error {
  readonly kind: TerrainErrorKind
  constructor(kind: TerrainErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

export type TerrainLoadState =
  | { status: 'not-loaded' }
  | { status: 'loading' }
  /** Loaded, and the horizon passes requireHorizon (complete coverage, screened near field). */
  | { status: 'ready'; terrain: SiteTerrain }
  /** Loaded and usable for labelled previews, but not for formal evaluation; the reasons come from requireHorizon. */
  | { status: 'insufficient'; terrain: SiteTerrain; reasons: ConditionReason[] }
  | { status: 'failed'; error: TerrainLoadError }

/** FNV-1a 32-bit, as written by the build tool. */
export function fnv1a32(bytes: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer: () => Promise<ArrayBuffer> }>

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function parseManifest(raw: unknown, siteId: string): SiteTerrainManifest {
  if (!isObj(raw) || raw.schema !== 'lunar-navigator.site-terrain' || raw.schemaVersion !== 1) throw new TerrainLoadError('parse', `${siteId}: not a site terrain manifest`)
  if (raw.siteId !== siteId) throw new TerrainLoadError('parse', `${siteId}: manifest is for ${String(raw.siteId)}`)
  if (raw.dataVersion !== TERRAIN_DATA_VERSION) throw new TerrainLoadError('parse', `${siteId}: unsupported data version ${String(raw.dataVersion)}`)
  const files = raw.files
  if (!isObj(files) || !isObj(files.regional)) throw new TerrainLoadError('parse', `${siteId}: manifest has no regional grid`)
  return raw as unknown as SiteTerrainManifest
}

function checked(entry: FileEntry, buf: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(buf)
  if (bytes.length !== entry.bytes) throw new TerrainLoadError('corrupt', `${entry.path}: ${bytes.length} bytes, expected ${entry.bytes}`)
  if (fnv1a32(bytes) !== entry.fnv1a32) throw new TerrainLoadError('corrupt', `${entry.path}: checksum mismatch`)
  return bytes
}

function elevationGrid(f: GridFile, bytes: Uint8Array): ElevationGrid {
  const { width, height, offsetM, scaleM } = f.layout
  if (f.layout.dtype !== 'int16' || bytes.length !== width * height * 2 || offsetM === undefined || scaleM === undefined) {
    throw new TerrainLoadError('parse', `${f.path}: unexpected layout`)
  }
  const q = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))
  return new ElevationGrid(f.projection, { width, height }, decodeInt16(q, offsetM, scaleM))
}

function slopeOn(grid: ElevationGrid, lat: number, lon: number, baselineM: number) {
  const half = baselineM / 2 / (MOON_R_KM * 1000)
  const h = (b: number) => { const p = destination(lat, lon, b, half); return grid.heightAt(p.lat, p.lon) }
  const n = h(0), s = h(180), e = h(90), w = h(270)
  if (n === null || s === null || e === null || w === null) return null
  const dzdN = (n - s) / baselineM
  const dzdE = (e - w) / baselineM
  const g = Math.hypot(dzdN, dzdE)
  return { slopeDeg: Math.atan(g) * 180 / Math.PI, aspectDeg: g < 1e-12 ? null : (Math.atan2(-dzdE, -dzdN) * 180 / Math.PI + 360) % 360 }
}

/** A terrain store. The app uses `siteTerrain`; tests create their own with a stub fetcher. */
export function createSiteTerrainStore(opts: { baseUrl: string; fetcher?: Fetcher }) {
  const fetcher: Fetcher = opts.fetcher ?? ((u) => fetch(u))
  const entries = new Map<string, { promise: Promise<SiteTerrain>; state: TerrainLoadState }>()
  const key = (siteId: string) => `${TERRAIN_DATA_VERSION}:${siteId}`

  async function get(path: string): Promise<ArrayBuffer> {
    let res
    try {
      res = await fetcher(opts.baseUrl + path)
    } catch (e) {
      throw new TerrainLoadError('network', `${path}: ${(e as Error).message}`)
    }
    if (res.status === 404) throw new TerrainLoadError('not-found', `${path}: not found`)
    if (!res.ok) throw new TerrainLoadError('network', `${path}: HTTP ${res.status}`)
    return res.arrayBuffer()
  }
  const json = (buf: ArrayBuffer, path: string): unknown => {
    try { return JSON.parse(new TextDecoder().decode(buf)) } catch { throw new TerrainLoadError('parse', `${path}: invalid JSON`) }
  }

  async function build(siteId: string): Promise<SiteTerrain> {
    const manifestPath = `${siteId}/manifest.json`
    const m = parseManifest(json(await get(manifestPath), manifestPath), siteId)
    const regionalFile = m.files.regional
    const [regBuf, nearBuf, confBuf, horBuf] = await Promise.all([
      get(regionalFile.path),
      m.files.near ? get(m.files.near.path) : Promise.resolve(null),
      m.files.nearConfidence ? get(m.files.nearConfidence.path) : Promise.resolve(null),
      m.files.horizon ? get(m.files.horizon.path) : Promise.resolve(null),
    ])
    const regional = elevationGrid(regionalFile, checked(regionalFile, regBuf))
    let near: SiteTerrain['near'] = null
    if (m.files.near && m.files.nearConfidence && nearBuf && confBuf) {
      const conf = m.files.nearConfidence
      const codes = checked(conf, confBuf)
      if (codes.length !== conf.layout.width * conf.layout.height) throw new TerrainLoadError('parse', `${conf.path}: unexpected size`)
      near = {
        elevation: elevationGrid(m.files.near, checked(m.files.near, nearBuf)),
        confidence: new CategoryGrid(conf.projection, conf.layout, codes),
        legendConfirmed: conf.layout.legendConfirmedForThisDtm === true,
        productId: m.files.near.productId ?? 'unknown',
      }
    }
    let horizon: HorizonData
    if (m.files.horizon && horBuf) {
      const raw = json(checked(m.files.horizon, horBuf).buffer as ArrayBuffer, m.files.horizon.path) as HorizonData
      if (!isObj(raw) || raw.status !== 'available' || !raw.coverage || !raw.observer) throw new TerrainLoadError('parse', `${siteId}: horizon lacks coverage or observer`)
      const problems = [...validateHorizonSamples(raw.samples), ...validateHorizonCoverage(raw.coverage, raw.samples.elevationsDeg.length)]
      if (problems.length) throw new TerrainLoadError('parse', `${siteId}: ${problems.join('; ')}`)
      horizon = raw
    } else {
      horizon = { status: 'unavailable', site: m.site, code: 'no-coverage', message: 'No horizon was computed for this site' }
    }
    const elevation = m.siteElevation
    const precomputedHeight = m.settings.observerHeightM
    const regionalProduct = m.products.find((p) => p.role === 'mid')
    const terrain: SiteTerrain = {
      siteId, dataVersion: m.dataVersion, elevation, horizon, near,
      regional: { elevation: regional, productId: regionalFile.productId ?? regionalProduct?.productId ?? 'unknown', gridSpacingM: regionalProduct?.gridSpacingM ?? NaN },
      manifest: m,
      observerRadiusKm: (h = precomputedHeight) => (elevation.valueM === null ? null : MOON_R_KM + (elevation.valueM + h) / 1000),
      horizonFor: (h = precomputedHeight) => (h === precomputedHeight ? horizon : { status: 'unavailable', site: m.site, code: 'not-precomputed', message: `Horizon precomputed for an observer height of ${precomputedHeight} m only` }),
      regionalSlope: (baselineM) => {
        const spacing = regionalProduct?.gridSpacingM
        if (!spacing) return null
        const b = Math.max(baselineM ?? 0, 2 * spacing)
        const s = slopeOn(regional, m.site.lat, m.site.lon, b)
        return s && { ...s, baselineM: b, resolutionM: spacing, product: regionalProduct.productId }
      },
      toSerializableSite: () => ({ id: siteId, lat: m.site.lat, lon: m.site.lon, horizon }),
    }
    return terrain
  }

  return {
    /** Load (or join the in-flight load of) a site's terrain. */
    load(siteId: string): Promise<SiteTerrain> {
      const k = key(siteId)
      const existing = entries.get(k)
      if (existing && existing.state.status !== 'failed') return existing.promise
      const entry = { promise: null as unknown as Promise<SiteTerrain>, state: { status: 'loading' } as TerrainLoadState }
      entry.promise = build(siteId).then(
        (terrain) => {
          const gate = requireHorizon(terrain.horizon)
          entry.state = gate.ok ? { status: 'ready', terrain } : { status: 'insufficient', terrain, reasons: gate.condition.reasons }
          return terrain
        },
        (err) => {
          const error = err instanceof TerrainLoadError ? err : new TerrainLoadError('parse', String((err as Error)?.message ?? err))
          entry.state = { status: 'failed', error }
          throw error
        },
      )
      entries.set(k, entry)
      return entry.promise
    },
    state(siteId: string): TerrainLoadState {
      return entries.get(key(siteId))?.state ?? { status: 'not-loaded' }
    },
    clear() {
      entries.clear()
    },
  }
}

const BASE = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/'
/** The app's store, reading the published files next to the built app. */
export const siteTerrain = createSiteTerrainStore({ baseUrl: `${BASE}data/terrain/v1/` })
