import { describe, expect, it } from 'vitest'
import { createSiteTerrainStore, fnv1a32, TERRAIN_DATA_VERSION } from './siteTerrain'
import type { SiteTerrainManifest } from './siteTerrain'
import { requireHorizon, toRuntimeSite } from './horizonData'
import type { HorizonData } from './horizonData'
import { moonSiteGeocentric } from './frames'
import { skyAt } from './site'
import { siteSky } from '../physics/siteSky'
import { loadCandidateCatalog } from './catalog'
import { diskTerrainStore } from './testing/publishedTerrain'

// ─── Synthetic site served by a stub fetcher (loader logic only) ───────────
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))
function syntheticSite(siteId: string, elevationM: number, partial = false) {
  const width = 21, height = 21
  // Regional grid: 1 ppd cylindrical around (0, 0) is too coarse; use 512 ppd like SLDEM2015, a tilted plane.
  const ppd = 512
  const proj = { kind: 'simple-cylindrical', ppd, centerLonDeg: 0, westLonDeg: -180, lineProjectionOffset: (10.5 / ppd) * ppd - 0.5 + 0, sampleProjectionOffset: 10 }
  const q = new Int16Array(width * height)
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) q[r * width + c] = (c - 10) * 20 // 5 m per pixel eastward at 0.25 m scale
  const reg = new Uint8Array(q.buffer)
  const horizon: HorizonData = {
    status: 'available', site: { lat: 0, lon: 0 },
    samples: { elevationsDeg: [1, 2, 3, 2], startAzimuthDeg: 0, stepDeg: 90, angleUnit: 'deg' },
    source: { product: 'synthetic', gridSpacingKm: 0.0592, verticalAccuracyM: null, referenceRadiusKm: 1737.4, frame: 'test' },
    model: { maxRangeKm: 200, mastM: 0, rayStepKm: 0.03, observerElevationM: elevationM },
    observer: { elevationM, elevationSource: 'synthetic', elevationQuality: 'measured', observerHeightM: 0, radiusKm: 1737.4 + elevationM / 1000 },
    coverage: { searchRangeKm: 200, nearStartKm: 0.02, complete: !partial, nearField: 'screened', sampleStatus: ['complete', partial ? 'lower-bound' : 'complete', 'complete', 'complete'], coveredToKm: [200, 200, 200, 200], governingKm: [1, 1, 1, 1], governingSource: ['s', 's', 's', 's'], uncertaintyDeg: [null, null, null, null], fallbackSamples: 0, skippedSamples: 0, lowerBoundAzimuths: partial ? 1 : 0 },
    quality: { nearFieldSelection: { productId: 'synthetic-near', tier: 'all gates', degraded: false }, convergence: { status: 'within-tolerance', toleranceDeg: 0.05, checks: [] } },
  }
  const hor = enc(horizon)
  const entry = (path: string, b: Uint8Array) => ({ path, bytes: b.length, sha256: 'n/a', fnv1a32: fnv1a32(b) })
  const manifest: SiteTerrainManifest = {
    schema: 'lunar-navigator.site-terrain', schemaVersion: 1, dataVersion: TERRAIN_DATA_VERSION, siteId,
    site: { lat: 0, lon: 0 }, settings: { observerHeightM: 0 },
    siteElevation: { valueM: elevationM, source: 'synthetic', quality: 'measured', confidenceCode: 12, regionalValueM: elevationM },
    files: {
      regional: { ...entry(`${siteId}/regional.i16`, reg), layout: { width, height, dtype: 'int16', offsetM: 0, scaleM: 0.25, nodata: -32768 }, projection: proj as never, productId: 'synthetic-mid' },
      horizon: entry(`${siteId}/horizon.json`, hor),
    },
    products: [{ role: 'mid', productId: 'synthetic-mid', gridSpacingM: 59.2 }],
  }
  return { [`${siteId}/manifest.json`]: enc(manifest), [`${siteId}/regional.i16`]: reg, [`${siteId}/horizon.json`]: hor }
}

function stubFetcher(files: Record<string, Uint8Array>, opts: { failFirst?: string; delayMs?: number } = {}) {
  const calls: string[] = []
  let failed = false
  const fetcher = async (url: string) => {
    const path = url.replace('/base/', '')
    calls.push(path)
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
    if (opts.failFirst === path && !failed) { failed = true; throw new Error('connection reset') }
    const body = files[path]
    return { ok: !!body, status: body ? 200 : 404, arrayBuffer: async () => (body ?? new Uint8Array()).slice().buffer }
  }
  return { fetcher, calls }
}

describe('site terrain loader', () => {
  it('shares one load between concurrent callers and reports the state', async () => {
    const { fetcher, calls } = stubFetcher(syntheticSite('a', -100), { delayMs: 5 })
    const store = createSiteTerrainStore({ baseUrl: '/base/', fetcher })
    expect(store.state('a').status).toBe('not-loaded')
    const [x, y] = await Promise.all([store.load('a'), store.load('a')])
    expect(x).toBe(y)
    expect(calls.filter((c) => c === 'a/manifest.json')).toHaveLength(1)
    expect(store.state('a').status).toBe('ready')
  })

  it('does not cache a failure: a later call retries', async () => {
    const { fetcher, calls } = stubFetcher(syntheticSite('a', 0), { failFirst: 'a/regional.i16' })
    const store = createSiteTerrainStore({ baseUrl: '/base/', fetcher })
    await expect(store.load('a')).rejects.toMatchObject({ kind: 'network' })
    expect(store.state('a').status).toBe('failed')
    await expect(store.load('a')).resolves.toBeTruthy()
    expect(calls.filter((c) => c === 'a/regional.i16')).toHaveLength(2)
  })

  it('distinguishes missing, corrupt and unparsable files', async () => {
    const files = syntheticSite('a', 0)
    const store = createSiteTerrainStore({ baseUrl: '/base/', fetcher: stubFetcher(files).fetcher })
    await expect(store.load('nope')).rejects.toMatchObject({ kind: 'not-found' })
    const corrupt = { ...files, 'a/regional.i16': files['a/regional.i16'].map((b, i) => (i === 3 ? b ^ 1 : b)) }
    await expect(createSiteTerrainStore({ baseUrl: '/base/', fetcher: stubFetcher(corrupt).fetcher }).load('a')).rejects.toMatchObject({ kind: 'corrupt' })
    const bad = { ...files, 'a/manifest.json': new TextEncoder().encode('{"schema":"x"}') }
    await expect(createSiteTerrainStore({ baseUrl: '/base/', fetcher: stubFetcher(bad).fetcher }).load('a')).rejects.toMatchObject({ kind: 'parse' })
  })

  it('reports a loaded but partial horizon as insufficient, with the gate reason', async () => {
    const store = createSiteTerrainStore({ baseUrl: '/base/', fetcher: stubFetcher(syntheticSite('a', 0, true)).fetcher })
    const t = await store.load('a')
    const st = store.state('a')
    expect(st.status).toBe('insufficient')
    expect(st.status === 'insufficient' && st.terrain).toBe(t)
    expect(st.status === 'insufficient' && st.reasons[0].code).toBe('horizon-partial-coverage')
  })

  it('keeps sites apart in the cache', async () => {
    const store = createSiteTerrainStore({ baseUrl: '/base/', fetcher: stubFetcher({ ...syntheticSite('a', -100), ...syntheticSite('b', 250) }).fetcher })
    const [a, b] = await Promise.all([store.load('a'), store.load('b')])
    expect(a.elevation.valueM).toBe(-100)
    expect(b.elevation.valueM).toBe(250)
  })

  it('uses one site elevation for the horizon, the sky and the geocentric endpoint', async () => {
    const t = await createSiteTerrainStore({ baseUrl: '/base/', fetcher: stubFetcher(syntheticSite('a', -2000)).fetcher }).load('a')
    const r = t.observerRadiusKm()!
    expect(r).toBeCloseTo(1735.4, 9)
    expect(t.horizon.status === 'available' && t.horizon.observer?.radiusKm).toBeCloseTo(r, 9)
    const site = toRuntimeSite(t.toSerializableSite())
    expect(site.radiusKm).toBeCloseTo(r, 9)
    const when = new Date('2026-11-14T00:00:00Z')
    expect(skyAt(site, when).sun.distanceKm).toBeCloseTo(siteSky(0, 0, when, r).sun.distanceKm, 6)
    const centre = moonSiteGeocentric({ lat: 0, lon: 0, radiusKm: 1e-9 }, when.getTime()).positionKm
    const p = moonSiteGeocentric({ lat: 0, lon: 0, radiusKm: r }, when.getTime()).positionKm
    expect(Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2])).toBeCloseTo(r, 6)
    // Only the precomputed observer height has a horizon.
    const other = t.horizonFor(2)
    expect(other.status === 'unavailable' && other.code).toBe('not-precomputed')
  })

  it('reports regional slope with its real baseline (never below two regional pixels)', async () => {
    const t = await createSiteTerrainStore({ baseUrl: '/base/', fetcher: stubFetcher(syntheticSite('a', 0)).fetcher }).load('a')
    const s = t.regionalSlope(3)!
    expect(s.baselineM).toBeCloseTo(2 * 59.2, 6) // 3 m requested, refused
    expect(s.resolutionM).toBe(59.2)
  })
})

// ─── The published candidate data (JSON parts) ─────────────────────────────
const manifests = import.meta.glob('../../public/data/terrain/v1/*/manifest.json', { eager: true, import: 'default' }) as Record<string, Record<string, unknown> & { siteId: string }>
const horizons = import.meta.glob('../../public/data/terrain/v1/*/horizon.json', { eager: true, import: 'default' }) as Record<string, HorizonData>
const bySite = (id: string) => Object.values(manifests).find((m) => m.siteId === id) as unknown as Record<string, never>

describe('published candidate terrain (terrain-v1)', () => {
  const catalog = loadCandidateCatalog()

  it('has a manifest and a horizon for every catalogue candidate', () => {
    expect(Object.values(manifests).map((m) => m.siteId).sort()).toEqual(catalog.candidates.map((c) => c.id).sort())
    expect(Object.keys(horizons)).toHaveLength(12)
  })

  it('applies the NAC selection rule (quality, confidence legend, registration) rather than the finest posting', () => {
    const chosen = (id: string) => (bySite(id).nacSelection as { chosen: string; tier: string })
    expect(chosen('apollo-15').chosen).toMatch(/APOLLO15_2/) // 2 m DTM has non-standard confidence codes
    expect(chosen('apollo-16').chosen).toMatch(/APOLLO16_2/) // lower relative linear error
    expect(chosen('apollo-17').chosen).toMatch(/APOLLO17_2M/) // APOLLO17_1 has a 12 m LOLA offset
    expect(chosen('luna-16').tier).toBe('registration gate relaxed') // its only DTM is offset 28.8 m from LOLA
    expect(chosen('change-4').tier).toBe('confidence and registration gates relaxed')
  })

  it('keeps the quality caveats of the site elevations', () => {
    const q = (id: string) => (bySite(id).siteElevation as { quality: string }).quality
    expect(q('apollo-14')).toBe('suspicious-confidence')
    expect(q('apollo-16')).toBe('suspicious-confidence')
    expect(q('change-4')).toBe('confidence-legend-unconfirmed')
  })

  it('agrees with the independent regional product at every site to within 10 m (gross-error check)', () => {
    for (const m of Object.values(manifests)) {
      const e = m.siteElevation as { valueM: number; regionalValueM: number }
      expect(Math.abs(e.valueM - e.regionalValueM)).toBeLessThan(10)
    }
  })

  it('records coverage and quality honestly: no candidate horizon passes the formal gate yet', () => {
    const codes = Object.fromEntries(Object.values(horizons).map((h) => { const r = requireHorizon(h); return [`${h.site.lat}`, r.ok ? [] : r.condition.reasons.map((x) => x.code)] }))
    const all = Object.values(codes)
    expect(all.every((c) => c.length > 0)).toBe(true)
    expect(all.filter((c) => c.includes('horizon-partial-coverage'))).toHaveLength(11)
    expect(all.filter((c) => c.includes('horizon-near-field-unscreened'))).toHaveLength(1) // Chang'e 4
    expect(all.filter((c) => c.includes('horizon-degraded-product'))).toHaveLength(2) // Luna 16, Chang'e 4
    expect(all.filter((c) => c.includes('horizon-observer-elevation-quality'))).toHaveLength(3) // Apollo 14, 16, Chang'e 4
    expect(all.filter((c) => c.includes('horizon-not-converged'))).toHaveLength(12)
    for (const h of Object.values(horizons)) {
      if (h.status !== 'available') throw new Error('unexpected')
      expect(h.samples.elevationsDeg).toHaveLength(720)
      expect(h.coverage!.sampleStatus).toHaveLength(720)
      expect(Math.min(...h.samples.elevationsDeg)).toBeGreaterThan(-90)
    }
  })

  it('loads every published site through the real loader (checksums, layout, horizon validation)', async () => {
    const store = diskTerrainStore()
    for (const c of catalog.candidates) {
      const t = await store.load(c.id)
      expect(store.state(c.id).status).toBe('insufficient') // see the coverage test above
      expect(t.observerRadiusKm()).toBeCloseTo(1737.4 + t.elevation.valueM! / 1000, 9)
      expect(t.near).not.toBeNull()
      // The published near grid reproduces the manifest's site elevation (same bilinear policy).
      expect(t.near!.elevation.heightAt(c.coordinate.lat, c.coordinate.lon)).toBeCloseTo(t.elevation.valueM!, 1)
    }
  })

  it('verified every projection against an independent product before use', () => {
    for (const m of Object.values(manifests)) {
      const pc = m.projectionChecks as { farVsLdem4: { correlation: number }; midVsFar: { meanM: number; stdM: number } }
      expect(pc.farVsLdem4.correlation).toBeGreaterThan(0.9)
      expect(Math.abs(pc.midVsFar.meanM)).toBeLessThan(5)
      expect(pc.midVsFar.stdM).toBeLessThan(10)
    }
  })
})
