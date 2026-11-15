// Global terrain for coordinate-based evaluation (regional estimate, global search, custom points away from the catalogue).
//
// Product: LRO LOLA GDR LDEM_16 (16 pixels per degree, about 1.9 km posting), published as 30 deg x 30 deg tiles with a 2-pixel
// margin (so bilinear sampling never needs a neighbouring tile) by tools/buildGlobalTiles.mjs. One product for the whole Moon,
// poles included: there is no SLDEM2015 / LOLA polar seam. It is NOT the roughly 240 m SLDEM2015 used inside the catalogue
// packages: every result that uses it says so (spatial scale ~1.9 km, near terrain smaller than a pixel is not seen).
//
// Layout (same as physics/dem.ts, which describes the full grid): row 0 is +90 deg latitude, column 0 is 0 deg east, east
// positive, pixel centres at half-pixel offsets, int16 metres above the 1737.4 km reference sphere. Longitude wraps; latitude
// clamps at the poles.
//
// Loading: tiles load on demand, one shared promise per tile, a failure clears the entry so a later call retries. Every tile
// is checked against its recorded byte lengths and FNV-1a checksum (of the decoded int16 samples).
// This module has no imports from the UI or the scene and avoids TypeScript-only syntax that Node cannot strip (the tile
// builder in tools/ imports it).

export const GLOBAL_TERRAIN_VERSION = 'global-dem-v1'

export type GlobalTileLayout = {
  ppd: number
  radiusKm: number
  /** Tile size in degrees (divides 180 and 360). */
  tileDeg: number
  /** Extra pixels stored on every side of a tile. */
  marginPx: number
}

export type TileFile = { ti: number; tj: number; path: string; bytes: number; rawBytes: number; fnv1a32: string }
export type GlobalTerrainManifest = {
  schema: 'lunar-navigator.global-terrain'
  schemaVersion: 1
  dataVersion: string
  product: { id: string; sourceId: string; url: string; frame: string; frameVerification: string; verticalUnit: 'm' }
  layout: GlobalTileLayout
  /** Source heights were rounded to this many metres when stored (quantisation, not accuracy). */
  quantisationM: number
  heightRangeM: [number, number]
  generator: { tool: string; generatedAtUtc: string }
  tiles: TileFile[]
}

export const tilesAcross = (l: GlobalTileLayout) => 360 / l.tileDeg
export const tilesDown = (l: GlobalTileLayout) => 180 / l.tileDeg
export const tileSize = (l: GlobalTileLayout) => l.tileDeg * l.ppd + 2 * l.marginPx
/** Pixel spacing along a meridian, km. */
export const pixelKm = (l: GlobalTileLayout) => (l.radiusKm * Math.PI / 180) / l.ppd

/**
 * Cut one tile (with margin) out of a full grid (width = 360 ppd, height = 180 ppd). Longitude wraps, rows clamp.
 */
export function extractTile(full: Int16Array, l: GlobalTileLayout, ti: number, tj: number): Int16Array {
  const W = 360 * l.ppd, H = 180 * l.ppd, n = tileSize(l), span = l.tileDeg * l.ppd
  const out = new Int16Array(n * n)
  for (let r = 0; r < n; r++) {
    const row = Math.min(Math.max(tj * span - l.marginPx + r, 0), H - 1)
    for (let c = 0; c < n; c++) {
      const col = (((ti * span - l.marginPx + c) % W) + W) % W
      out[r * n + c] = full[row * W + col]
    }
  }
  return out
}

/**
 * Tile storage encoding (before deflate): every row is delta-coded (each sample minus its left neighbour, wrapping in int16),
 * and the low bytes of all samples are stored first, then the high bytes. Lossless; compresses about 30 % better than raw.
 */
export function encodeTile(t: Int16Array, n: number): Uint8Array {
  const out = new Uint8Array(t.length * 2)
  for (let r = 0; r < n; r++) {
    let prev = 0
    for (let c = 0; c < n; c++) {
      const i = r * n + c
      const d = (t[i] - prev) << 16 >> 16
      out[i] = d & 255
      out[t.length + i] = (d >> 8) & 255
      prev = t[i]
    }
  }
  return out
}

export function decodeTile(bytes: Uint8Array, n: number): Int16Array {
  const count = n * n
  if (bytes.length !== count * 2) throw new RangeError(`Encoded tile has ${bytes.length} bytes, expected ${count * 2}`)
  const t = new Int16Array(count)
  for (let r = 0; r < n; r++) {
    let prev = 0
    for (let c = 0; c < n; c++) {
      const i = r * n + c
      prev = (prev + (((bytes[count + i] << 8) | bytes[i]) << 16 >> 16)) << 16 >> 16
      t[i] = prev
    }
  }
  return t
}

export const tileKey = (ti: number, tj: number) => `${ti},${tj}`

/** Which tile's data a sample at (lat, lon) needs, and the local pixel position inside it. */
function locate(l: GlobalTileLayout, latDeg: number, lonDeg: number) {
  const W = 360 * l.ppd, H = 180 * l.ppd, span = l.tileDeg * l.ppd
  const x = ((((lonDeg % 360) + 360) % 360) * l.ppd) - 0.5
  const y = Math.min(Math.max((90 - latDeg) * l.ppd - 0.5, 0), H - 1)
  const x0 = Math.floor(x), r0 = Math.floor(y)
  const c0 = ((x0 % W) + W) % W
  const ti = Math.floor(c0 / span), tj = Math.min(Math.floor(r0 / span), tilesDown(l) - 1)
  return { ti, tj, lc: c0 - ti * span + l.marginPx, lr: r0 - tj * span + l.marginPx, fx: x - x0, fy: y - r0 }
}

/** Height field over loaded tiles. heightAt returns null where the needed tile is not loaded (never 0). */
export class TiledHeights {
  readonly layout: GlobalTileLayout
  private readonly tiles = new Map<string, Int16Array>()
  constructor(layout: GlobalTileLayout) { this.layout = layout }
  setTile(ti: number, tj: number, data: Int16Array) {
    const n = tileSize(this.layout)
    if (data.length !== n * n) throw new RangeError(`Tile has ${data.length} samples, expected ${n * n}`)
    this.tiles.set(tileKey(ti, tj), data)
  }
  hasTile(ti: number, tj: number) { return this.tiles.has(tileKey(ti, tj)) }
  get loadedTiles() { return this.tiles.size }
  heightAt(latDeg: number, lonDeg: number): number | null {
    if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return null
    const p = locate(this.layout, latDeg, lonDeg)
    const t = this.tiles.get(tileKey(p.ti, p.tj))
    if (!t) return null
    const n = tileSize(this.layout), i = p.lr * n + p.lc
    const top = t[i] * (1 - p.fx) + t[i + 1] * p.fx
    const bot = t[i + n] * (1 - p.fx) + t[i + n + 1] * p.fx
    return top * (1 - p.fy) + bot * p.fy
  }
}

/** Tiles that cover every sample within rangeKm of a point (plus the sample margin): a conservative list for loading. */
export function tilesAround(l: GlobalTileLayout, latDeg: number, lonDeg: number, rangeKm: number): Array<[number, number]> {
  const dLat = rangeKm / l.radiusKm * 180 / Math.PI + 1 / l.ppd
  const cosLat = Math.max(0.02, Math.cos(Math.min(89.99, Math.abs(latDeg) + dLat) * Math.PI / 180))
  const dLon = Math.min(180, dLat / cosLat)
  const keys = new Map<string, [number, number]>()
  const lat0 = Math.max(-90, latDeg - dLat), lat1 = Math.min(90, latDeg + dLat)
  const near = Math.abs(latDeg) + dLat >= 90 // the range reaches a pole: every longitude is in range
  const lonA = near ? 0 : lonDeg - dLon, lonB = near ? 360 : lonDeg + dLon
  const step = l.tileDeg / 2
  for (let lat = lat0; lat <= lat1 + step; lat += step) {
    for (let lon = lonA; lon <= lonB + step; lon += step) {
      const p = locate(l, Math.min(lat, lat1), Math.min(lon, lonB))
      keys.set(tileKey(p.ti, p.tj), [p.ti, p.tj])
    }
  }
  return [...keys.values()]
}

// ─── Loading ───────────────────────────────────────────────────────────────

export type TerrainFetcher = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer: () => Promise<ArrayBuffer> }>

export type GlobalLoadErrorKind = 'not-found' | 'network' | 'corrupt' | 'parse' | 'unsupported'
export class GlobalTerrainError extends Error {
  readonly kind: GlobalLoadErrorKind
  constructor(kind: GlobalLoadErrorKind, message: string) { super(message); this.name = 'GlobalTerrainError'; this.kind = kind }
}

function fnv1a32(bytes: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

async function inflateRaw(buf: ArrayBuffer): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: new (f: string) => TransformStream }).DecompressionStream
  if (!DS) throw new GlobalTerrainError('unsupported', 'This browser cannot decompress the terrain tiles (DecompressionStream is missing)')
  const stream = new Blob([buf]).stream().pipeThrough(new DS('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseGlobalManifest(raw: unknown): GlobalTerrainManifest {
  if (!isObj(raw) || raw.schema !== 'lunar-navigator.global-terrain' || raw.schemaVersion !== 1) throw new GlobalTerrainError('parse', 'Not a global terrain manifest')
  if (raw.dataVersion !== GLOBAL_TERRAIN_VERSION) throw new GlobalTerrainError('parse', `Unsupported global terrain version ${String(raw.dataVersion)}`)
  const l = raw.layout
  if (!isObj(l) || !(Number(l.ppd) > 0) || !(Number(l.tileDeg) > 0) || 180 % Number(l.tileDeg) !== 0 || !Array.isArray(raw.tiles)) throw new GlobalTerrainError('parse', 'Global terrain manifest is incomplete')
  const m = raw as unknown as GlobalTerrainManifest
  if (m.tiles.length !== tilesAcross(m.layout) * tilesDown(m.layout)) throw new GlobalTerrainError('parse', `Manifest lists ${m.tiles.length} tiles, expected ${tilesAcross(m.layout) * tilesDown(m.layout)}`)
  return m
}

export type GlobalTerrainStore = ReturnType<typeof createGlobalTerrainStore>

export function createGlobalTerrainStore(opts: { baseUrl: string; fetcher?: TerrainFetcher }) {
  const fetcher: TerrainFetcher = opts.fetcher ?? ((u) => fetch(u))
  let manifestPromise: Promise<GlobalTerrainManifest> | null = null
  let heights: TiledHeights | null = null
  const tilePromises = new Map<string, Promise<void>>()
  const stats = { tilesFetched: 0, bytesFetched: 0, tileLoadMs: 0 }

  async function get(path: string): Promise<ArrayBuffer> {
    let res
    try { res = await fetcher(opts.baseUrl + path) } catch (e) { throw new GlobalTerrainError('network', `${path}: ${(e as Error).message}`) }
    if (res.status === 404) throw new GlobalTerrainError('not-found', `${path}: not found`)
    if (!res.ok) throw new GlobalTerrainError('network', `${path}: HTTP ${res.status}`)
    return res.arrayBuffer()
  }

  function manifest(): Promise<GlobalTerrainManifest> {
    if (!manifestPromise) {
      manifestPromise = get('manifest.json').then((b) => {
        let raw: unknown
        try { raw = JSON.parse(new TextDecoder().decode(b)) } catch { throw new GlobalTerrainError('parse', 'manifest.json is not valid JSON') }
        const m = parseGlobalManifest(raw)
        heights = new TiledHeights(m.layout)
        return m
      })
      manifestPromise.catch(() => { manifestPromise = null }) // retry on the next call
    }
    return manifestPromise
  }

  async function loadTile(m: GlobalTerrainManifest, ti: number, tj: number): Promise<void> {
    const key = tileKey(ti, tj)
    const existing = tilePromises.get(key)
    if (existing) return existing
    const entry = m.tiles.find((t) => t.ti === ti && t.tj === tj)
    if (!entry) throw new GlobalTerrainError('parse', `Tile ${key} is not in the manifest`)
    const t0 = Date.now()
    const p = (async () => {
      const comp = await get(entry.path)
      if (comp.byteLength !== entry.bytes) throw new GlobalTerrainError('corrupt', `${entry.path}: ${comp.byteLength} bytes, expected ${entry.bytes}`)
      const raw = await inflateRaw(comp).catch((e) => { throw e instanceof GlobalTerrainError ? e : new GlobalTerrainError('corrupt', `${entry.path}: cannot decompress`) })
      if (raw.length !== entry.rawBytes) throw new GlobalTerrainError('corrupt', `${entry.path}: ${raw.length} bytes, expected ${entry.rawBytes}`)
      const samples = decodeTile(raw, tileSize(m.layout))
      if (fnv1a32(new Uint8Array(samples.buffer)) !== entry.fnv1a32) throw new GlobalTerrainError('corrupt', `${entry.path}: checksum mismatch`)
      heights!.setTile(ti, tj, samples)
      stats.tilesFetched++; stats.bytesFetched += comp.byteLength; stats.tileLoadMs += Date.now() - t0
    })()
    tilePromises.set(key, p)
    p.catch(() => tilePromises.delete(key)) // a failed tile is retried by the next request
    return p
  }

  return {
    manifest,
    /** The height field (tiles loaded so far). Call ensureTiles first. */
    heights(): TiledHeights { if (!heights) throw new GlobalTerrainError('parse', 'Manifest not loaded'); return heights },
    /** Load the given tiles (deduplicated, shared with concurrent callers). Rejects with the first failure. */
    async ensureTiles(tiles: Array<[number, number]>): Promise<TiledHeights> {
      const m = await manifest()
      await Promise.all(tiles.map(([ti, tj]) => loadTile(m, ti, tj)))
      return heights!
    },
    /** Load everything within rangeKm of a point. */
    async ensureAround(latDeg: number, lonDeg: number, rangeKm: number): Promise<TiledHeights> {
      const m = await manifest()
      return this.ensureTiles(tilesAround(m.layout, latDeg, lonDeg, rangeKm))
    },
    async ensureAll(): Promise<TiledHeights> {
      const m = await manifest()
      return this.ensureTiles(m.tiles.map((t) => [t.ti, t.tj] as [number, number]))
    },
    /** True once the manifest has been read (the height field exists). */
    manifestLoaded: () => heights !== null,
    stats: () => ({ ...stats, loadedTiles: heights?.loadedTiles ?? 0 }),
    clear() { manifestPromise = null; heights = null; tilePromises.clear() },
  }
}
