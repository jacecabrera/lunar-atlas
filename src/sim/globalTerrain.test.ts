// Global terrain tiles: layout equals the full-grid sampler (seams, poles), the published LDEM_16 tiles agree with the shipped
// LDEM_4 preview, the loader deduplicates, retries and detects damage.
import { describe, expect, it } from 'vitest'
import { Dem } from '../physics/dem'
import { extractTile, TiledHeights, tilesAcross, tilesDown, tilesAround, tileSize, encodeTile, decodeTile, pixelKm, GlobalTerrainError, parseGlobalManifest } from './globalTerrain'
import type { GlobalTileLayout } from './globalTerrain'
import { diskGlobalStore, readLdem4 } from './testing/publishedTerrain'

const full4 = await readLdem4()
const dem4 = new Dem({ width: 1440, height: 720, ppd: 4, radiusKm: 1737.4 }, full4)
const L4: GlobalTileLayout = { ppd: 4, radiusKm: 1737.4, tileDeg: 30, marginPx: 2 }
const tiles4 = () => { const h = new TiledHeights(L4); for (let tj = 0; tj < tilesDown(L4); tj++) for (let ti = 0; ti < tilesAcross(L4); ti++) h.setTile(ti, tj, extractTile(full4, L4, ti, tj)); return h }
let seed = 7
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }

describe('tile layout', () => {
  it('samples exactly like the full-grid sampler, including tile edges, the longitude seam and the poles', () => {
    const h = tiles4()
    const pts: Array<[number, number]> = [[90, 0], [-90, 123], [89.99, 359.999], [0, 0], [0, 359.9], [0, -0.1], [0, 180], [30, 30], [29.999, 59.999], [-30.001, 90.001], [45, 720.5], [-89.5, -179.99]]
    for (let i = 0; i < 4000; i++) pts.push([rnd() * 180 - 90, rnd() * 360 - 180])
    for (const [lat, lon] of pts) expect(h.heightAt(lat, lon), `${lat},${lon}`).toBeCloseTo(dem4.heightAt(lat, lon), 9)
  })
  it('returns null (never 0) where the tile is not loaded or the input is not a number', () => {
    const h = new TiledHeights(L4)
    expect(h.heightAt(10, 10)).toBeNull(); expect(h.heightAt(Number.NaN, 0)).toBeNull()
    h.setTile(0, 3, extractTile(full4, L4, 0, 3))
    expect(h.heightAt(-5, 10)).not.toBeNull(); expect(h.heightAt(-5, 100)).toBeNull()
    expect(() => h.setTile(0, 0, new Int16Array(5))).toThrow(RangeError)
  })
  it('encodes and decodes losslessly, extremes and sign wrap-around included', () => {
    const n = 12, t = new Int16Array(n * n)
    for (let i = 0; i < t.length; i++) t[i] = [32767, -32768, 0, -1, 1, 10686, -8982][i % 7] + (i % 3)
    expect(Array.from(decodeTile(encodeTile(t, n), n))).toEqual(Array.from(t))
    expect(() => decodeTile(new Uint8Array(3), n)).toThrow(RangeError)
    const real = extractTile(full4, L4, 5, 2)
    expect(Array.from(decodeTile(encodeTile(real, tileSize(L4)), tileSize(L4)))).toEqual(Array.from(real))
  })
  it('lists every tile a range around a point can touch, including across the seam and over the poles', () => {
    const keys = (lat: number, lon: number, r: number) => tilesAround(L4, lat, lon, r).map(([a, b]) => `${a},${b}`)
    for (const [lat, lon, r] of [[0, 0, 200], [0, 359.9, 200], [89.9, 10, 200], [-89.9, 200, 200], [29.99, 29.99, 200], [0, 0, 30]] as const) {
      const have = new Set(keys(lat, lon, r))
      const h = new TiledHeights(L4)
      for (const [ti, tj] of tilesAround(L4, lat, lon, r)) h.setTile(ti, tj, extractTile(full4, L4, ti, tj))
      // every sample within r km (all bearings) must be answerable
      for (let b = 0; b < 360; b += 7.5) for (const f of [0.25, 0.5, 0.75, 1]) {
        const ang = (r * f) / 1737.4
        const la = Math.asin(Math.sin(lat * Math.PI / 180) * Math.cos(ang) + Math.cos(lat * Math.PI / 180) * Math.sin(ang) * Math.cos(b * Math.PI / 180)) * 180 / Math.PI
        const lo = lon + Math.atan2(Math.sin(b * Math.PI / 180) * Math.sin(ang) * Math.cos(lat * Math.PI / 180), Math.cos(ang) - Math.sin(lat * Math.PI / 180) * Math.sin(la * Math.PI / 180)) * 180 / Math.PI
        expect(h.heightAt(la, lo), `${lat},${lon} r${r} b${b} f${f}`).not.toBeNull()
      }
      expect(have.size).toBeGreaterThanOrEqual(1)
    }
    expect(keys(0, 0, 30).length).toBeLessThanOrEqual(4)
    expect(keys(89.9, 10, 200).length).toBe(12) // the range reaches the pole: every longitude
  })
})

describe('published LDEM_16 tiles', () => {
  it('has a consistent manifest and matches the shipped LDEM_4 preview (same product family, frame and radius)', async () => {
    const store = diskGlobalStore()
    const m = await store.manifest()
    expect(m.layout).toMatchObject({ ppd: 16, tileDeg: 30, marginPx: 2 }); expect(m.tiles).toHaveLength(72)
    expect(pixelKm(m.layout)).toBeCloseTo(1.8957, 3)
    const h = await store.ensureAll()
    expect(h.loadedTiles).toBe(72)
    let sum = 0, n = 0, worst = 0
    for (let i = 0; i < 1500; i++) {
      const lat = Math.asin(rnd() * 2 - 1) * 180 / Math.PI, lon = rnd() * 360
      const d = Math.abs(h.heightAt(lat, lon)! - dem4.heightAt(lat, lon)); sum += d; n++; worst = Math.max(worst, d)
    }
    expect(sum / n).toBeLessThan(250) // the 1.9 km product is finer than the 7.6 km preview: they differ by terrain detail, not by a frame error
    expect(worst).toBeLessThan(4000)
    // Poles and seam answer with real values.
    for (const [lat, lon] of [[90, 0], [-90, 0], [-89.9, 123], [0, 359.99], [0, 0.01]] as const) expect(h.heightAt(lat, lon)).toBeGreaterThan(-9000)
  }, 120_000)
  it('loads on demand, shares concurrent requests, and retries after a failure', async () => {
    const fetched: string[] = []
    const store = diskGlobalStore({ onFetch: (u) => fetched.push(u) })
    await Promise.all([store.ensureAround(0.67, 23.47, 200), store.ensureAround(0.67, 23.47, 200)])
    const tiles = fetched.filter((u) => u.includes('tiles/'))
    expect(tiles.length).toBeGreaterThanOrEqual(1); expect(tiles.length).toBeLessThanOrEqual(4)
    expect(new Set(tiles).size).toBe(tiles.length) // no tile twice
    expect(fetched.filter((u) => u.endsWith('manifest.json'))).toHaveLength(1)
    await store.ensureAround(0.67, 23.47, 200)
    expect(fetched.filter((u) => u.includes('tiles/')).length).toBe(tiles.length) // cached
    expect(store.stats().tilesFetched).toBe(tiles.length)
    // A failing tile is reported and retried.
    let fail = true
    const flaky = diskGlobalStore({ corrupt: (u, b) => (fail && u.includes('t-0-2') ? b.slice(0, b.length - 5) : b) })
    await expect(flaky.ensureTiles([[0, 2]])).rejects.toMatchObject({ kind: 'corrupt' })
    fail = false
    await expect(flaky.ensureTiles([[0, 2]])).resolves.toBeDefined()
  }, 60_000)
  it('detects damaged data, missing tiles and unsupported manifests', async () => {
    const flip = diskGlobalStore({ corrupt: (u, b) => { if (!u.includes('t-3-3')) return b; const c = new Uint8Array(b); c[10] ^= 0x55; return c } })
    await expect(flip.ensureTiles([[3, 3]])).rejects.toBeInstanceOf(GlobalTerrainError) // checksum, inflate or length error: never silently wrong data
    const missing = diskGlobalStore()
    await expect(missing.ensureTiles([[99, 99]])).rejects.toMatchObject({ kind: 'parse' })
    expect(() => parseGlobalManifest({ schema: 'x' })).toThrow(GlobalTerrainError)
    const m = await diskGlobalStore().manifest()
    expect(() => parseGlobalManifest({ ...m, dataVersion: 'global-dem-v0' })).toThrow(/Unsupported/)
    expect(() => parseGlobalManifest({ ...m, tiles: m.tiles.slice(1) })).toThrow(/tiles/)
  }, 60_000)
})
