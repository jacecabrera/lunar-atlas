// Step 07 offline pipeline: crops numeric terrain around each catalogue candidate, verifies projections against an
// independent product, selects the near-field NAC DTM, fixes the site elevation, casts the terrain horizon and writes
// small publishable files plus manifests.
//
// Usage:
//   node tools/buildSiteTerrain.mjs [--sites apollo-11,chandrayaan-3] [--convergence apollo-11,chandrayaan-3] [--no-write]
//
// Inputs (fetched with HTTP range requests, cached in tools/.cache/step07/, which Git ignores):
//   SLDEM2015 512 ppd tiles and 128 ppd global (PDS Geosciences), LOLA GDR LDEM_60S_60M and LDEM_60S_240M,
//   LROC NAC DTMs and confidence maps (PDS via pds.lroc.im-ldi.com), the shipped LDEM_4 for verification.
// Outputs: public/data/terrain/v1/<siteId>/{near.i16,near-conf.u8,regional.i16,horizon.json,manifest.json} and
//   public/data/terrain/v1/index.json. Shared geometry comes from the app's TypeScript modules via Vite's runnerImport,
//   so the offline horizon and the runtime use the same code.
//
// GDAL was not available in this environment; the products used are uncompressed raw rasters, read directly here.
// Every projection is checked against label bounds and an independent product before use.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runnerImport } from 'vite'

const ROOT = process.cwd()
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null }
const ONLY = arg('--sites')?.split(',') ?? null
// Convergence runs for every site unless --no-convergence is given (about 5 s per site).
const CONVERGE = process.argv.includes('--no-convergence') ? [] : (arg('--convergence')?.split(',') ?? null) // null = all sites
const WRITE = !process.argv.includes('--no-write')
const CACHE = join(ROOT, 'tools/.cache/step07')
const OUT = join(ROOT, 'public/data/terrain/v1')
const DATA_VERSION = 'terrain-v1.1' // files stay in public/data/terrain/v1 (same layout)
mkdirSync(CACHE, { recursive: true })

const load = async (p) => (await runnerImport(join(ROOT, p))).module
const P = await load('src/physics/projections.ts')
const G = await load('src/physics/geoGrid.ts')
const H = await load('src/physics/horizonCast.ts')
const DEM = await load('src/physics/dem.ts')

const R_KM = 1737.4
const DEG = Math.PI / 180
const catalog = JSON.parse(readFileSync(join(ROOT, 'src/data/lunar-candidate-catalog-v0.1.json'), 'utf8'))
const log = (...a) => console.error(...a)

// ─── settings (recorded in every manifest) ─────────────────────────────────
export const SETTINGS = {
  observerHeightM: 0, // ASM-OBSERVER-HEIGHT: ground level; not a known antenna or panel height
  nearStartKm: 0.02, // first ray sample: beyond the 3 m footprint and ~4-10 DTM posts, avoiding the site's own pixels
  bands: { nearKm: [0, 1.0], midKm: [1.0, 30], farKm: [30, 200] },
  maxRangeKm: 200,
  azimuthStepDeg: 0.5,
  stepFraction: 0.5, // ray step = half a pixel of the source used
  fallbackMinPixels: 5, // a coarser source may fill gaps only from 5 of its own pixels away (mid ~0.3 km, far ~1.2 km)
  maxSkippedGapPosts: 3, // near-field gaps up to 3 DTM posts are skipped; longer gaps make the azimuth a lower bound
  crops: { nearHalfKm: 1.5, midHalfKm: 31, farHalfKm: 205, publishNearHalfKm: 0.5, publishRegionalHalfKm: 10 },
  // Storage quantisation step of the published int16 grids. A file-format choice, NOT a measurement accuracy: the
  // vertical accuracy (RLE90, LOLA RMS, SLDEM quality residual) and the horizontal registration are recorded separately.
  storageQuantization: { nearStepM: 0.02, regionalStepM: 0.25 },
  // ASM-HORIZON-CONVERGENCE: a horizon is accepted as converged when halving the azimuth step and the ray step,
  // shortening the range to 150 km and moving the first sample to 10 m each change no complete azimuth by more than this.
  convergenceToleranceDeg: 0.05,
  acceptedConfidence: [4, 10, 11, 12, 13, 14, 15], // 3 suspicious, 0 no data, 1 shadow, 2 saturated are excluded
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────
async function fetchText(url) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url)
    if (r.ok) return r.text()
    await new Promise((s) => setTimeout(s, 1500))
  }
  throw new Error(`GET ${url} failed`)
}

/** Fetch byte ranges [a, b] (inclusive). Uses multipart range requests in batches where the server supports them. */
async function fetchRanges(url, ranges, { multipart = true, batch = 120 } = {}) {
  const out = new Array(ranges.length)
  const groups = []
  for (let i = 0; i < ranges.length; i += multipart ? batch : 1) groups.push([i, Math.min(ranges.length, i + (multipart ? batch : 1))])
  let next = 0
  const worker = async () => {
    while (next < groups.length) {
      const [s, e] = groups[next++]
      const part = ranges.slice(s, e)
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(url, { headers: { Range: 'bytes=' + part.map(([a, b]) => `${a}-${b}`).join(',') } })
          if (res.status !== 206) throw new Error(`HTTP ${res.status}`)
          const buf = Buffer.from(await res.arrayBuffer())
          const ct = res.headers.get('content-type') ?? ''
          if (part.length === 1 && !ct.includes('multipart')) { out[s] = buf; break }
          const boundary = ct.match(/boundary=(.+)$/)?.[1]?.replace(/^"|"$/g, '')
          if (!boundary) throw new Error('no multipart boundary')
          let pos = 0
          const got = new Map()
          while (true) {
            const h = buf.indexOf('Content-Range: bytes ', pos, 'latin1')
            if (h < 0) break
            const m = buf.toString('latin1', h, h + 80).match(/Content-Range: bytes (\d+)-(\d+)\//)
            const a = Number(m[1]), b = Number(m[2])
            const body = buf.indexOf('\r\n\r\n', h, 'latin1') + 4
            got.set(a, buf.subarray(body, body + (b - a + 1)))
            pos = body + (b - a + 1)
          }
          part.forEach(([a], j) => { const v = got.get(a); if (!v) throw new Error(`missing part ${a}`); out[s + j] = v })
          break
        } catch (err) {
          if (attempt >= 3) throw new Error(`range fetch failed for ${url}: ${err.message}`)
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
        }
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
  return out
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
// FNV-1a 32-bit, cheap integrity check the browser can verify without a secure context.
function fnv1a(buf) {
  let h = 0x811c9dc5
  for (let i = 0; i < buf.length; i++) { h ^= buf[i]; h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

// ─── PDS3 labels ───────────────────────────────────────────────────────────
function pds3(text) {
  const v = (k) => { const m = text.match(new RegExp(`^\\s*${k}\\s*=\\s*"?([^"<\\r\\n]+)`, 'm')); return m ? m[1].trim() : null }
  const n = (k) => { const x = v(k); return x === null ? null : Number(x.replace(/[^0-9eE+.-]/g, '')) }
  return {
    productId: v('PRODUCT_ID'), version: v('PRODUCT_VERSION_ID'), lines: n('LINES'), samples: n('LINE_SAMPLES'),
    recordBytes: n('RECORD_BYTES'), sampleType: v('SAMPLE_TYPE'), sampleBits: n('SAMPLE_BITS'), unit: v('UNIT'),
    scaling: n('SCALING_FACTOR'), offset: n('OFFSET'), projection: v('MAP_PROJECTION_TYPE'), ppd: n('MAP_RESOLUTION'),
    mapScale: n('MAP_SCALE'), centerLat: n('CENTER_LATITUDE'), centerLon: n('CENTER_LONGITUDE'),
    lpo: n('LINE_PROJECTION_OFFSET'), spo: n('SAMPLE_PROJECTION_OFFSET'), maxLat: n('MAXIMUM_LATITUDE'), minLat: n('MINIMUM_LATITUDE'),
    westLon: n('WESTERNMOST_LONGITUDE'), frame: v('COORDINATE_SYSTEM_NAME'), radiusKm: n('A_AXIS_RADIUS'),
  }
}

const PDSG = 'https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data'
const labelCache = new Map()
async function label(urlLbl) {
  if (!labelCache.has(urlLbl)) labelCache.set(urlLbl, pds3(await fetchText(urlLbl)))
  return labelCache.get(urlLbl)
}

// ─── Products ──────────────────────────────────────────────────────────────
// SLDEM2015 at 512 ppd: 30x45 degree tiles of a virtual grid with row 0 at +60 latitude and column 0 at 0 longitude.
async function sldem512Tile(lat, lon) {
  const latBands = [[30, 60, '30n_60n'], [0, 30, '00n_30n'], [-30, 0, '30s_00s'], [-60, -30, '60s_30s']]
  const band = latBands.find(([a, b]) => lat >= a && lat < b) ?? (lat === 60 ? latBands[0] : null)
  if (!band) throw new Error(`latitude ${lat} outside SLDEM2015`)
  const l = ((lon % 360) + 360) % 360
  const w = Math.floor(l / 45) * 45
  const name = `sldem2015_512_${band[2]}_${String(w).padStart(3, '0')}_${String(w + 45).padStart(3, '0')}_float`
  const lbl = await label(`${PDSG}/sldem2015/tiles/float_img/${name}.lbl`)
  // Assert the label agrees with the virtual global grid used for cropping.
  const rowOffset = (60 - band[1]) * 512
  const colOffset = w * 512
  if (lbl.lines !== 15360 || lbl.samples !== 23040 || lbl.ppd !== 512) throw new Error(`unexpected tile shape ${name}`)
  if (Math.abs(lbl.lpo - (band[1] * 512 - 0.5)) > 1e-6) throw new Error(`LPO mismatch ${name}: ${lbl.lpo}`)
  if (Math.abs(lbl.spo - (180 * 512 - 0.5 - colOffset)) > 1e-6) throw new Error(`SPO mismatch ${name}: ${lbl.spo}`)
  return { url: `${PDSG}/sldem2015/tiles/float_img/${name}.img`, name, lbl, rowOffset, colOffset, width: 23040 }
}

/** Crop an aligned lat/lon box from SLDEM2015 (512 tiles or the 128 global file). Values in metres. */
async function cropSldem(ppd, lat0, lon0, halfKm, key) {
  const cacheFile = join(CACHE, `${key}.f32`)
  const dLat = (halfKm / R_KM) / DEG * 1.02 + 2 / ppd
  const dLon = Math.min(179, dLat / Math.cos(Math.min(89, Math.abs(lat0) + dLat) * DEG) * 1.05)
  // Align the crop to source pixel edges.
  const latN = Math.ceil((lat0 + dLat) * ppd) / ppd
  const latS = Math.floor((lat0 - dLat) * ppd) / ppd
  const lonW = Math.floor((lon0 - dLon) * ppd) / ppd
  const lonE = Math.ceil((lon0 + dLon) * ppd) / ppd
  const height = Math.round((latN - latS) * ppd)
  const width = Math.round((lonE - lonW) * ppd)
  if (latN > 60 || latS < -60) throw new Error('crop leaves SLDEM2015 coverage')
  const projection = { kind: 'simple-cylindrical', ppd, centerLonDeg: lon0, westLonDeg: lon0 - 180, lineProjectionOffset: latN * ppd - 0.5, sampleProjectionOffset: (lon0 - lonW) * ppd - 0.5 }
  let products
  if (existsSync(cacheFile)) {
    const meta = JSON.parse(readFileSync(cacheFile + '.json', 'utf8'))
    return { ...meta, values: new Float32Array(readFileSync(cacheFile).buffer.slice(0)) }
  }
  const values = new Float32Array(width * height)
  if (ppd === 128) {
    const url = `${PDSG}/sldem2015/global/float_img/sldem2015_128_60s_60n_000_360_float.img`
    const lbl = await label(url.replace(/\.img$/, '.lbl'))
    if (lbl.lines !== 15360 || lbl.samples !== 46080 || Math.abs(lbl.lpo - 7679.5) > 1e-6 || Math.abs(lbl.spo - 23039.5) > 1e-6) throw new Error('unexpected SLDEM128 label')
    products = [{ url, productId: lbl.productId, version: lbl.version, frame: lbl.frame }]
    const ranges = [], targets = []
    for (let r = 0; r < height; r++) {
      const gRow = Math.round((60 - latN) * ppd) + r
      let c = 0
      while (c < width) {
        const gCol = ((Math.round(lonW * ppd) + c) % 46080 + 46080) % 46080
        const run = Math.min(width - c, 46080 - gCol)
        const off = gRow * 46080 * 4 + gCol * 4
        ranges.push([off, off + run * 4 - 1]); targets.push([r * width + c, run])
        c += run
      }
    }
    const parts = await fetchRanges(url, ranges)
    parts.forEach((buf, i) => { const [o, run] = targets[i]; for (let k = 0; k < run; k++) values[o + k] = buf.readFloatLE(4 * k) * 1000 })
  } else {
    const ranges = new Map()
    const tiles = new Map()
    for (let r = 0; r < height; r++) {
      const lat = latN - (r + 0.5) / ppd
      let c = 0
      while (c < width) {
        const lon = lonW + (c + 0.5) / ppd
        const t = await sldem512Tile(lat, lon)
        tiles.set(t.name, t)
        const gRow = Math.round((60 - latN) * ppd) + r
        const gCol = ((Math.round(lonW * ppd) + c) % (360 * ppd) + 360 * ppd) % (360 * ppd)
        const tRow = gRow - t.rowOffset
        const tCol = gCol - t.colOffset
        const run = Math.min(width - c, t.width - tCol)
        const off = tRow * t.width * 4 + tCol * 4
        if (!ranges.has(t.url)) ranges.set(t.url, { list: [], targets: [] })
        ranges.get(t.url).list.push([off, off + run * 4 - 1]); ranges.get(t.url).targets.push([r * width + c, run])
        c += run
      }
    }
    for (const [url, { list, targets }] of ranges) {
      const parts = await fetchRanges(url, list)
      parts.forEach((buf, i) => { const [o, run] = targets[i]; for (let k = 0; k < run; k++) values[o + k] = buf.readFloatLE(4 * k) * 1000 })
    }
    products = [...tiles.values()].map((t) => ({ url: t.url, productId: t.lbl.productId, version: t.lbl.version, frame: t.lbl.frame }))
  }
  for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i]) || values[i] < -2e4) values[i] = Number.NaN
  const meta = { projection, width, height, products, bounds: { latN, latS, lonW, lonE } }
  writeFileSync(cacheFile, Buffer.from(values.buffer)); writeFileSync(cacheFile + '.json', JSON.stringify(meta))
  return { ...meta, values }
}

/** Crop a window of a LOLA polar stereographic product around (lat0, lon0). Axis signs come from verification. */
async function cropPolar(productKey, lat0, lon0, halfKm, signs, key) {
  const cacheFile = join(CACHE, `${key}.f32`)
  const url = `${PDSG}/lola_gdr/polar/float_img/${productKey}_float.img`
  const lbl = await label(url.replace(/\.img$/, '.lbl'))
  if (lbl.projection !== 'POLAR STEREOGRAPHIC' || lbl.centerLat !== -90) throw new Error(`unexpected label ${productKey}`)
  const full = { kind: 'polar-stereographic', pole: 'south', radiusM: lbl.radiusKm * 1000, scaleM: lbl.mapScale, centerLonDeg: lbl.centerLon, lineProjectionOffset: lbl.lpo, sampleProjectionOffset: lbl.spo, xSign: signs.xSign, ySign: signs.ySign }
  const c = P.polarToPixel(full, lat0, lon0)
  const half = Math.ceil((halfKm * 1000 * 1.02) / lbl.mapScale) + 2
  const row0 = Math.max(0, Math.round(c.row) - half), col0 = Math.max(0, Math.round(c.col) - half)
  const height = Math.min(lbl.lines, Math.round(c.row) + half) - row0
  const width = Math.min(lbl.samples, Math.round(c.col) + half) - col0
  const projection = { ...full, lineProjectionOffset: lbl.lpo - row0, sampleProjectionOffset: lbl.spo - col0 }
  const products = [{ url, productId: lbl.productId, version: lbl.version, frame: lbl.frame }]
  if (existsSync(cacheFile)) {
    const meta = JSON.parse(readFileSync(cacheFile + '.json', 'utf8'))
    return { ...meta, values: new Float32Array(readFileSync(cacheFile).buffer.slice(0)) }
  }
  const ranges = []
  for (let r = 0; r < height; r++) { const off = ((row0 + r) * lbl.samples + col0) * 4; ranges.push([off, off + width * 4 - 1]) }
  const parts = await fetchRanges(url, ranges)
  const values = new Float32Array(width * height)
  parts.forEach((buf, r) => { for (let k = 0; k < width; k++) { const v = buf.readFloatLE(4 * k) * 1000; values[r * width + k] = Number.isFinite(v) && v > -2e4 ? v : Number.NaN } })
  const meta = { projection, width, height, products, window: { row0, col0 } }
  writeFileSync(cacheFile, Buffer.from(values.buffer)); writeFileSync(cacheFile + '.json', JSON.stringify(meta))
  return { ...meta, values }
}

// ─── NAC DTMs ──────────────────────────────────────────────────────────────
const NAC_PDS = 'https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/DATA/SDP/NAC_DTM'
const tag = (xml, name) => xml.match(new RegExp(`<(?:cart:)?${name}[^>]*>([^<]*)<`))?.[1]?.trim() ?? null
async function nacLabel(dtm) {
  const base = dtm.productId.replace(/_[EP]\d{3}[NS]\d{4}$/, '')
  const dir = `${NAC_PDS}/${base.replace(/^NAC_DTM_/, '')}`
  const xml = await fetchText(`${dir}/${dtm.productId}.xml`)
  const cxml = await fetchText(`${dir}/${base}_CONF.xml`)
  const parse = (x) => {
    const offsets = [...x.matchAll(/<offset unit="byte">(\d+)<\/offset>/g)].map((m) => Number(m[1]))
    const elements = [...x.matchAll(/<elements>(\d+)<\/elements>/g)].map((m) => Number(m[1]))
    return {
      arrayOffset: offsets.at(-1), lines: elements[0], samples: elements[1], dataType: tag(x, 'data_type'),
      projection: tag(x, 'map_projection_name'), stdParallel: Number(tag(x, 'standard_parallel_1')),
      centralMeridian: Number(tag(x, 'longitude_of_central_meridian')), projLat0: Number(tag(x, 'latitude_of_projection_origin')),
      scaleM: Number(tag(x, 'pixel_scale_x')), ulx: Number(tag(x, 'upperleft_corner_x')), uly: Number(tag(x, 'upperleft_corner_y')),
      radiusM: Number(tag(x, 'a_axis_radius')) * 1000, west: Number(tag(x, 'west_bounding_coordinate')), east: Number(tag(x, 'east_bounding_coordinate')),
      north: Number(tag(x, 'north_bounding_coordinate')), south: Number(tag(x, 'south_bounding_coordinate')),
    }
  }
  return { dir, base, dtm: parse(xml), conf: parse(cxml), imgUrl: `${dir}/${dtm.productId}.IMG`, confUrl: `${dir}/${base}_CONF.IMG` }
}

/** Projection with the corrected upperleft_corner_x, checked against the label's own bounding coordinates. */
function nacProjection(L) {
  if (L.projection === 'Equirectangular') {
    const k = L.radiusM * Math.cos(L.stdParallel * DEG)
    const westFrom = (ulx) => ((L.centralMeridian + ulx / k / DEG) % 360 + 360) % 360
    const tol = (2 * L.scaleM) / k / DEG
    const westLabel = ((L.west % 360) + 360) % 360
    const ulx = Math.abs(westFrom(L.ulx) - westLabel) < tol ? L.ulx : Math.abs(westFrom(-L.ulx) - westLabel) < tol ? -L.ulx : null
    if (ulx === null) throw new Error('cannot reconcile upperleft_corner_x with west_bounding_coordinate')
    const p = { kind: 'nac-equirectangular', radiusM: L.radiusM, stdParallelDeg: L.stdParallel, centralMeridianDeg: L.centralMeridian, ulxM: ulx, ulyM: L.uly, scaleM: L.scaleM }
    // Independent check: the north-west corner of the label bounds maps to pixel (-0.5, -0.5).
    const nw = P.toPixel(p, L.north, L.west)
    return { p, ulxSignFlipped: ulx !== L.ulx, boundsCheck: { nwRow: nw.row, nwCol: nw.col } }
  }
  if (L.projection === 'Polar Stereographic') {
    const base = { kind: 'nac-polar', pole: L.projLat0 < 0 ? 'south' : 'north', radiusM: L.radiusM, trueScaleLatDeg: L.projLat0, centralMeridianDeg: L.centralMeridian, ulyM: L.uly, scaleM: L.scaleM }
    const mid = (L.north + L.south) / 2
    const fits = (ulx) => [L.west, L.east].every((lo) => { const c = P.toPixel({ ...base, ulxM: ulx }, mid, lo).col; return c > -3 && c < L.samples + 3 })
    const ulx = fits(L.ulx) ? L.ulx : fits(-L.ulx) ? -L.ulx : null
    if (ulx === null) throw new Error('cannot reconcile polar upperleft_corner_x')
    const p = { ...base, ulxM: ulx }
    const top = P.toPixel(p, L.north, L.centralMeridian).row
    const bottom = P.toPixel(p, L.south, L.centralMeridian).row
    // The label's south bound appears to describe the data extent rather than the grid edge (VIKRAMSITE1: 36 px short).
    // The alternative reading (true scale at the pole) is off by thousands of rows, so the tolerance only guards
    // against that; the decisive check is the NAC vs LOLA comparison in buildSite().
    if (Math.abs(top + 0.5) > 3 || Math.abs(bottom - (L.lines - 0.5)) > 60) throw new Error('polar NAC bounds check failed')
    return { p, ulxSignFlipped: ulx !== L.ulx, boundsCheck: { topRow: top, bottomRow: bottom, lines: L.lines } }
  }
  throw new Error(`unsupported NAC projection ${L.projection}`)
}

async function cropNac(dtm, lat0, lon0, halfKm, key) {
  const cacheFile = join(CACHE, `${key}.f32`)
  const L = await nacLabel(dtm)
  const { p, ulxSignFlipped, boundsCheck } = nacProjection(L.dtm)
  const c = P.toPixel(p, lat0, lon0)
  const half = Math.ceil((halfKm * 1000) / L.dtm.scaleM) + 2
  const row0 = Math.max(0, Math.round(c.row) - half), col0 = Math.max(0, Math.round(c.col) - half)
  const row1 = Math.min(L.dtm.lines, Math.round(c.row) + half + 1), col1 = Math.min(L.dtm.samples, Math.round(c.col) + half + 1)
  const height = row1 - row0, width = col1 - col0
  const projection = p.kind === 'nac-equirectangular'
    ? { ...p, ulxM: p.ulxM + col0 * p.scaleM, ulyM: p.ulyM - row0 * p.scaleM }
    : { ...p, ulxM: p.ulxM + col0 * p.scaleM, ulyM: p.ulyM - row0 * p.scaleM }
  const meta = { projection, width, height, window: { row0, col0 }, ulxSignFlipped, boundsCheck, imgUrl: L.imgUrl, confUrl: L.confUrl, label: { lines: L.dtm.lines, samples: L.dtm.samples, scaleM: L.dtm.scaleM } }
  if (existsSync(cacheFile)) {
    return { ...JSON.parse(readFileSync(cacheFile + '.json', 'utf8')), values: new Float32Array(readFileSync(cacheFile).buffer.slice(0)), codes: new Uint8Array(readFileSync(cacheFile + '.conf')) }
  }
  if (L.conf.lines !== L.dtm.lines || L.conf.samples !== L.dtm.samples) throw new Error('confidence grid differs from DTM grid')
  // The S3 store behind these URLs serves one range per request: read whole row blocks.
  const [rowsBuf] = await fetchRanges(L.imgUrl, [[L.dtm.arrayOffset + row0 * L.dtm.samples * 4, L.dtm.arrayOffset + row1 * L.dtm.samples * 4 - 1]], { multipart: false })
  const [confBuf] = await fetchRanges(L.confUrl, [[L.conf.arrayOffset + row0 * L.conf.samples, L.conf.arrayOffset + row1 * L.conf.samples - 1]], { multipart: false })
  const values = new Float32Array(width * height)
  const codes = new Uint8Array(width * height)
  for (let r = 0; r < height; r++) for (let k = 0; k < width; k++) {
    const v = rowsBuf.readFloatLE(((r * L.dtm.samples) + col0 + k) * 4)
    values[r * width + k] = Number.isFinite(v) && v > -1e30 ? v : Number.NaN
    codes[r * width + k] = confBuf[r * L.conf.samples + col0 + k]
  }
  writeFileSync(cacheFile, Buffer.from(values.buffer)); writeFileSync(cacheFile + '.conf', Buffer.from(codes)); writeFileSync(cacheFile + '.json', JSON.stringify(meta))
  return { ...meta, values, codes }
}

// ─── LDEM_4 (independent check) ────────────────────────────────────────────
const ldem4 = (() => {
  const meta = JSON.parse(readFileSync(join(ROOT, 'public/data/lola/ldem_4.json'), 'utf8'))
  const buf = readFileSync(join(ROOT, 'public/data/lola/ldem_4.bin'))
  return new DEM.Dem(meta, new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2))
})()

/** Correlation and RMS difference between a grid and LDEM_4 at LDEM_4 pixel centres within radiusKm of the site. */
function compareWithLdem4(grid, lat0, lon0, radiusKm) {
  const xs = [], ys = []
  for (let r = 0; r < 720; r++) {
    const lat = 90 - (r + 0.5) / 4
    if (Math.abs(lat - lat0) * DEG * R_KM > radiusKm) continue
    for (let c = 0; c < 1440; c++) {
      const lon = (c + 0.5) / 4
      const ang = Math.acos(Math.min(1, Math.sin(lat * DEG) * Math.sin(lat0 * DEG) + Math.cos(lat * DEG) * Math.cos(lat0 * DEG) * Math.cos((lon - lon0) * DEG)))
      if (ang * R_KM > radiusKm) continue
      const v = grid.heightAt(lat, lon > 180 ? lon - 360 : lon)
      if (v === null) continue
      xs.push(v); ys.push(ldem4.data[r * 1440 + c])
    }
  }
  const n = xs.length
  if (n < 10) return { n, correlation: null, rmsDiffM: null, meanDiffM: null }
  const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n
  let sxy = 0, sxx = 0, syy = 0, sd = 0, sdd = 0
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; sd += xs[i] - ys[i]; sdd += (xs[i] - ys[i]) ** 2 }
  return { n, correlation: sxy / Math.sqrt(sxx * syy), rmsDiffM: Math.sqrt(sdd / n), meanDiffM: sd / n }
}

export { cropSldem, cropPolar, cropNac, compareWithLdem4, nacLabel, nacProjection, fetchRanges, sha256, fnv1a, catalog, P, G, H, DEM, ldem4, CACHE, OUT, DATA_VERSION, log, R_KM, DEG }

// ─── Pipeline ──────────────────────────────────────────────────────────────
const POLAR_SIGNS = { xSign: 1, ySign: -1 } // chosen by verifyPolarSigns(); recorded with its evidence
const STANDARD_CODES = new Set([0, 1, 2, 3, 4, 10, 11, 12, 13, 14, 15]) // README table, read for APOLLO11 only

async function verifyPolarSigns(lat0, lon0) {
  const results = []
  for (const xSign of [1, -1]) for (const ySign of [1, -1]) {
    const c = await cropPolar('ldem_60s_240m', lat0, lon0, 60, { xSign, ySign }, `verify_polar240_${xSign}_${ySign}_${lat0}_${lon0}`)
    const r = compareWithLdem4(new G.ElevationGrid(c.projection, c, c.values), lat0, lon0, 55)
    results.push({ xSign, ySign, ...r })
  }
  results.sort((a, b) => b.correlation - a.correlation)
  if (results[0].xSign !== POLAR_SIGNS.xSign || results[0].ySign !== POLAR_SIGNS.ySign || results[0].correlation < 0.95 || results[1].correlation > 0.5) {
    throw new Error(`polar sign verification failed: ${JSON.stringify(results)}`)
  }
  return results
}

/** NAC DTM selection: gates in order, then a ranking. Gates are relaxed (and recorded) only if nothing passes. */
function selectNac(candidates) {
  const gate = (c) => ({
    coversSite: c.siteValue !== null,
    standardConfidence: !c.nonStandardCodes,
    registration: c.horizontalOffsetM <= 10,
  })
  const ranked = (list) => [...list].sort((a, b) => (a.dtm.relativeLinearError90M - b.dtm.relativeLinearError90M) || (a.dtm.lolaRmsM - b.dtm.lolaRmsM) || (a.dtm.postingM - b.dtm.postingM) || a.dtm.productId.localeCompare(b.dtm.productId))
  const withGates = candidates.map((c) => ({ ...c, gates: gate(c) }))
  const tiers = [
    ['all gates', (c) => c.gates.coversSite && c.gates.standardConfidence && c.gates.registration],
    ['registration gate relaxed', (c) => c.gates.coversSite && c.gates.standardConfidence],
    ['confidence and registration gates relaxed', (c) => c.gates.coversSite],
  ]
  for (const [name, f] of tiers) {
    const pass = ranked(withGates.filter(f))
    if (pass.length) return { chosen: pass[0], tier: name, considered: withGates }
  }
  return { chosen: null, tier: 'none', considered: withGates }
}

function annulusPoints(lat0, lon0, rMinKm, rMaxKm, stepKm) {
  const pts = []
  for (let d = rMinKm; d <= rMaxKm; d += stepKm) {
    const n = Math.max(8, Math.round((2 * Math.PI * d) / stepKm))
    for (let k = 0; k < n; k++) pts.push(DEM.destination(lat0, lon0, (360 * k) / n, d / R_KM))
  }
  return pts
}
const stats = (xs) => {
  if (!xs.length) return { n: 0, meanM: null, stdM: null, rmsM: null }
  const n = xs.length, m = xs.reduce((a, b) => a + b) / n
  return { n, meanM: m, stdM: Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / n), rmsM: Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / n) }
}
function seam(a, b, pts) {
  const d = []
  for (const p of pts) { const x = a(p.lat, p.lon), y = b(p.lat, p.lon); if (x !== null && y !== null) d.push(x - y) }
  return stats(d)
}

/** Apparent horizontal offset of the NAC DTM against the mid product: NAC block means vs shifted mid samples. */
function registrationSearch(nearGrid, midGrid, lat0, lon0, midPixelM) {
  const blockPts = annulusPoints(lat0, lon0, 0.1, 1.0, midPixelM / 1000)
  const blocks = []
  for (const p of blockPts) {
    const vals = []
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      const q = DEM.destination(DEM.destination(p.lat, p.lon, 0, (i * midPixelM / 5) / 1000 / R_KM).lat, p.lon, 90, (j * midPixelM / 5) / 1000 / R_KM)
      const v = nearGrid.heightAt(q.lat, q.lon); if (v !== null) vals.push(v)
    }
    if (vals.length === 25) blocks.push({ p, v: vals.reduce((a, b) => a + b) / 25 })
  }
  let best = null
  for (let dy = -150; dy <= 150; dy += 15) for (let dx = -150; dx <= 150; dx += 15) {
    const diffs = []
    for (const { p, v } of blocks) {
      const q = DEM.destination(DEM.destination(p.lat, p.lon, 0, dy / 1000 / R_KM).lat, p.lon, 90, dx / 1000 / R_KM)
      const m = midGrid.heightAt(q.lat, q.lon); if (m !== null) diffs.push(v - m)
    }
    const s = stats(diffs)
    if (s.n > 20 && (!best || s.stdM < best.stdM)) best = { dxEastM: dx, dyNorthM: dy, ...s }
  }
  const zero = (() => { const diffs = []; for (const { p, v } of blocks) { const m = midGrid.heightAt(p.lat, p.lon); if (m !== null) diffs.push(v - m) } return stats(diffs) })()
  return { blocks: blocks.length, atZeroShift: zero, bestShift: best, note: 'Diagnostic only: the grid and the candidate coordinate are never shifted.' }
}

function quantize(grid, half, lat0, lon0, scaleM, sub) {
  // Sub-window around the site, in the grid's own pixel lattice (no resampling).
  const c = P.toPixel(grid.projection, lat0, lon0)
  const r0 = Math.max(0, Math.round(c.row) - half), c0 = Math.max(0, Math.round(c.col) - half)
  const r1 = Math.min(grid.height, Math.round(c.row) + half + 1), c1 = Math.min(grid.width, Math.round(c.col) + half + 1)
  const w = c1 - c0, h = r1 - r0
  const vals = []
  for (let r = r0; r < r1; r++) for (let k = c0; k < c1; k++) { const v = grid.values[r * grid.width + k]; if (!Number.isNaN(v)) vals.push(v) }
  vals.sort((a, b) => a - b)
  const offsetM = vals.length ? Math.round(vals[Math.floor(vals.length / 2)]) : 0
  const q = new Int16Array(w * h)
  let maxErr = 0, clipped = 0
  for (let r = 0; r < h; r++) for (let k = 0; k < w; k++) {
    const v = grid.values[(r0 + r) * grid.width + c0 + k]
    if (Number.isNaN(v)) { q[r * w + k] = -32768; continue }
    let n = Math.round((v - offsetM) / scaleM)
    if (n < -32767 || n > 32767) { clipped++; n = Math.max(-32767, Math.min(32767, n)) }
    q[r * w + k] = n
    maxErr = Math.max(maxErr, Math.abs(offsetM + n * scaleM - v))
  }
  if (clipped) throw new Error(`quantization range exceeded (${clipped} values); increase the scale`)
  const codes = sub ? new Uint8Array(w * h) : null
  if (sub) for (let r = 0; r < h; r++) for (let k = 0; k < w; k++) codes[r * w + k] = sub[(r0 + r) * grid.width + c0 + k]
  const p = grid.projection
  const projection = p.kind === 'simple-cylindrical' || p.kind === 'polar-stereographic'
    ? { ...p, lineProjectionOffset: p.lineProjectionOffset - r0, sampleProjectionOffset: p.sampleProjectionOffset - c0 }
    : { ...p, ulxM: p.ulxM + c0 * p.scaleM, ulyM: p.ulyM - r0 * p.scaleM }
  return { q, codes, width: w, height: h, offsetM, scaleM, maxQuantizationErrorM: maxErr, projection, validFraction: vals.length / (w * h) }
}

async function buildSite(c) {
  const t0 = Date.now()
  const lat = c.coordinate.lat, lon = c.coordinate.lon
  const polar = Math.abs(lat) > 59
  log(`\n== ${c.id} (${lat}, ${lon})`)
  // Mid and far fields.
  const mid = polar ? await cropPolar('ldem_60s_60m', lat, lon, SETTINGS.crops.midHalfKm, POLAR_SIGNS, `mid_${c.id}`) : await cropSldem(512, lat, lon, SETTINGS.crops.midHalfKm, `mid_${c.id}`)
  const far = polar ? await cropPolar('ldem_60s_240m', lat, lon, SETTINGS.crops.farHalfKm, POLAR_SIGNS, `far_${c.id}`) : await cropSldem(128, lat, lon, SETTINGS.crops.farHalfKm, `far_${c.id}`)
  const midGrid = new G.ElevationGrid(mid.projection, mid, mid.values)
  const farGrid = new G.ElevationGrid(far.projection, far, far.values)
  const verification = {
    midVsLdem4: compareWithLdem4(midGrid, lat, lon, 28),
    farVsLdem4: compareWithLdem4(farGrid, lat, lon, 190),
    polarSigns: polar ? await verifyPolarSigns(lat, lon) : null,
  }
  // Hard checks. The far grid against LDEM_4 over ~190 km has thousands of points and tests the projection formula
  // (shared by mid and far). The mid grid is checked against the far grid over the whole overlap: a one-pixel
  // misplacement would give a standard deviation of tens of metres in rough terrain, against 3-4 m SLDEM accuracy.
  // midVsLdem4 (only ~50 LDEM_4 pixels within 28 km) is recorded but has too little power to be a gate: it fell to
  // 0.83 at Apollo 16, a low-contrast highland area, while the far check there exceeded 0.9.
  verification.midVsFar = seam((a, b) => midGrid.heightAt(a, b), (a, b) => farGrid.heightAt(a, b), annulusPoints(lat, lon, 0.5, 30, 0.25))
  if (!(verification.farVsLdem4.correlation > 0.9)) throw new Error(`${c.id}: far grid correlation with LDEM_4 ${verification.farVsLdem4.correlation}`)
  if (!(Math.abs(verification.midVsFar.meanM) < 5 && verification.midVsFar.stdM < 10)) throw new Error(`${c.id}: mid vs far ${JSON.stringify(verification.midVsFar)}`)
  log('verification', JSON.stringify({ midVsLdem4: verification.midVsLdem4.correlation, farVsLdem4: verification.farVsLdem4.correlation, midVsFarMean: verification.midVsFar.meanM, midVsFarStd: verification.midVsFar.stdM }))

  // Near field: every covering NAC DTM, then the selection rule.
  const nacCands = []
  for (const d of c.terrain.localDtms) {
    const crop = await cropNac(d, lat, lon, SETTINGS.crops.nearHalfKm, `near_${c.id}_${d.dtmName}`)
    const grid = new G.ElevationGrid(crop.projection, crop, crop.values)
    const codesSeen = new Set(crop.codes)
    const nonStandardCodes = [...codesSeen].some((x) => !STANDARD_CODES.has(x))
    nacCands.push({
      dtm: d, crop, grid, siteValue: grid.heightAt(lat, lon), nonStandardCodes,
      horizontalOffsetM: Math.hypot(d.lolaOffsetsM.lat ?? 0, d.lolaOffsetsM.lon ?? 0),
      validFraction: crop.values.reduce((a, v) => a + (Number.isNaN(v) ? 0 : 1), 0) / crop.values.length,
    })
  }
  const sel = selectNac(nacCands)
  const near = sel.chosen
  log('NAC selected', near?.dtm.productId, 'tier', sel.tier)

  const accepted = new Set(SETTINGS.acceptedConfidence)
  const nearCode = near ? new G.CategoryGrid(near.crop.projection, near.crop, near.crop.codes) : null
  const nearSample = near ? (la, lo) => {
    if (!near.nonStandardCodes) { const code = nearCode.codeAt(la, lo); if (code === null || !accepted.has(code)) return null }
    return near.grid.heightAt(la, lo)
  } : () => null

  // Site elevation: one policy used by the horizon, the sky and the geocentric endpoint.
  const siteCode = nearCode?.codeAt(lat, lon) ?? null
  let elevation
  if (near && near.siteValue !== null) {
    const quality = near.nonStandardCodes ? 'confidence-legend-unconfirmed' : siteCode === 4 ? 'interpolated' : accepted.has(siteCode) ? 'measured' : 'suspicious-confidence'
    elevation = { valueM: near.siteValue, source: near.dtm.productId, quality, confidenceCode: siteCode }
  } else {
    const v = midGrid.heightAt(lat, lon)
    elevation = v === null ? { valueM: null, source: null, quality: 'unavailable', confidenceCode: null } : { valueM: v, source: mid.products[0].productId, quality: 'regional-fallback', confidenceCode: null }
  }
  elevation.regionalValueM = midGrid.heightAt(lat, lon)
  log('site elevation', JSON.stringify(elevation))

  // Seams and registration diagnostics (no data are modified).
  const seams = {
    nearVsMid: near ? seam(nearSample, (a, b) => midGrid.heightAt(a, b), annulusPoints(lat, lon, 0.3, 1.0, 0.03)) : null,
    midVsFar: seam((a, b) => midGrid.heightAt(a, b), (a, b) => farGrid.heightAt(a, b), annulusPoints(lat, lon, 25, 30, 0.25)),
  }
  const registration = near ? registrationSearch({ heightAt: nearSample }, midGrid, lat, lon, polar ? 60 : 59.2) : null

  // Horizon.
  const midPixelKm = polar ? 0.06 : 0.0592252938
  const farPixelKm = polar ? 0.24 : 0.236901
  const sigmaMid = c.terrain.regionalProducts.find((r) => r.productId === 'sldem2015')?.qualityResidualRmsM ?? null
  const sources = (f) => [
    ...(near ? [{ id: near.dtm.productId, minKm: SETTINGS.bands.nearKm[0], maxKm: SETTINGS.bands.nearKm[1], stepKm: (near.dtm.postingM / 1000) * f, sample: nearSample, sigmaM: near.dtm.relativeLinearError90M / 1.645 }] : []),
    { id: mid.products[0].productId, minKm: near ? SETTINGS.bands.midKm[0] : 0, maxKm: SETTINGS.bands.midKm[1], stepKm: midPixelKm * f, sample: (a, b) => midGrid.heightAt(a, b), sigmaM: polar ? null : sigmaMid, fallbackMinKm: SETTINGS.fallbackMinPixels * midPixelKm },
    { id: far.products[0].productId, minKm: SETTINGS.bands.farKm[0], maxKm: SETTINGS.bands.farKm[1], stepKm: farPixelKm * f, sample: (a, b) => farGrid.heightAt(a, b), sigmaM: polar ? null : sigmaMid, fallbackMinKm: SETTINGS.fallbackMinPixels * farPixelKm },
  ]
  const observerRadiusKm = elevation.valueM === null ? null : R_KM + elevation.valueM / 1000 + SETTINGS.observerHeightM / 1000
  const cast = (o = {}) => H.castHorizon(sources(o.stepFraction ?? SETTINGS.stepFraction), {
    latDeg: lat, lonDeg: lon, observerRadiusKm, referenceRadiusKm: R_KM,
    azimuthStepDeg: o.azimuthStepDeg ?? SETTINGS.azimuthStepDeg, nearStartKm: o.nearStartKm ?? SETTINGS.nearStartKm, maxRangeKm: o.maxRangeKm ?? SETTINGS.maxRangeKm,
    maxSkippedGapKm: near ? (SETTINGS.maxSkippedGapPosts * near.dtm.postingM) / 1000 : 0,
  })
  const horizon = observerRadiusKm === null ? null : cast()
  log('horizon', horizon ? `${horizon.azimuths.length} az, ${horizon.samplesEvaluated} samples, ${horizon.elapsedMs.toFixed(0)} ms, lower-bound ${horizon.azimuths.filter((a) => a.status !== 'complete').length}` : 'not computed')

  let convergence = null
  if ((CONVERGE === null || CONVERGE.includes(c.id)) && horizon) convergence = runConvergence(cast, horizon)

  return { c, lat, lon, polar, mid, far, midGrid, near, sel, elevation, seams, registration, horizon, convergence, verification, nacCands, buildMs: Date.now() - t0 }
}

function compareHorizons(ref, other, stepRef, stepOther) {
  // Interpolate `other` (as the runtime does, linear with wrap-around) at every azimuth of `ref`.
  const n = other.azimuths.length
  // Only azimuths that are complete in the reference and in both neighbours of the other run are compared: a lower
  // bound is not a converged value.
  const diffs = []
  ref.azimuths.forEach((a, i) => {
    const x = (i * stepRef) / stepOther
    const k = Math.floor(x), f = x - k
    const p = other.azimuths[k % n], q = other.azimuths[(k + 1) % n]
    if (a.status !== 'complete' || p.status !== 'complete' || q.status !== 'complete') return
    diffs.push(Math.abs(p.elevationDeg * (1 - f) + q.elevationDeg * f - a.elevationDeg))
  })
  if (!diffs.length) return { compared: 0, maxAbsDiffDeg: null, meanAbsDiffDeg: null }
  return { compared: diffs.length, maxAbsDiffDeg: Math.max(...diffs), meanAbsDiffDeg: diffs.reduce((a, b) => a + b, 0) / diffs.length }
}

function runConvergence(cast, base) {
  const out = { baseline: SETTINGS, runs: [] }
  const add = (name, o, ref, refStep, step) => {
    const r = cast(o)
    out.runs.push({ name, options: o, ms: Math.round(r.elapsedMs), samples: r.samplesEvaluated, vsReference: compareHorizons(ref, r, refStep, step) })
    log('convergence', name, JSON.stringify(out.runs.at(-1).vsReference), Math.round(r.elapsedMs), 'ms')
    return r
  }
  // Azimuth step: reference 0.25 deg.
  const az025 = cast({ azimuthStepDeg: 0.25 })
  out.runs.push({ name: 'azimuth 0.25 (reference)', options: { azimuthStepDeg: 0.25 }, ms: Math.round(az025.elapsedMs), samples: az025.samplesEvaluated })
  add('azimuth 0.5', { azimuthStepDeg: 0.5 }, az025, 0.25, 0.5)
  add('azimuth 1', { azimuthStepDeg: 1 }, az025, 0.25, 1)
  add('azimuth 2', { azimuthStepDeg: 2 }, az025, 0.25, 2)
  // Ray step: reference quarter pixel.
  const s025 = cast({ stepFraction: 0.25 })
  out.runs.push({ name: 'step 0.25 px (reference)', options: { stepFraction: 0.25 }, ms: Math.round(s025.elapsedMs), samples: s025.samplesEvaluated })
  add('step 0.5 px', { stepFraction: 0.5 }, s025, 0.5, 0.5)
  add('step 1 px', { stepFraction: 1 }, s025, 0.5, 0.5)
  add('step 2 px', { stepFraction: 2 }, s025, 0.5, 0.5)
  // Reference for range and near start is the baseline run.
  // Search range: reference 200 km (the data limit).
  for (const km of [50, 100, 150]) add(`range ${km} km`, { maxRangeKm: km }, base, 0.5, 0.5)
  // Near start distance: reference 20 m.
  for (const m of [10, 50, 100]) add(`near start ${m} m`, { nearStartKm: m / 1000 }, base, 0.5, 0.5)
  // Refinements that decide the status (coarser runs above are recorded for context only).
  const pick = (name) => out.runs.find((r) => r.name === name).vsReference
  const checks = [
    { parameter: 'azimuthStepDeg', baseline: 0.5, refined: 0.25, unit: 'deg', ...pick('azimuth 0.5') },
    { parameter: 'rayStepPixels', baseline: 0.5, refined: 0.25, unit: 'pixel', ...pick('step 0.5 px') },
    { parameter: 'maxRangeKm', baseline: 200, refined: 150, unit: 'km', ...pick('range 150 km') },
    { parameter: 'nearStartKm', baseline: 0.02, refined: 0.01, unit: 'km', ...pick('near start 10 m') },
  ]
  const tol = SETTINGS.convergenceToleranceDeg
  const status = checks.some((c) => c.maxAbsDiffDeg === null) ? 'not-checked' : checks.every((c) => c.maxAbsDiffDeg <= tol) ? 'within-tolerance' : 'exceeds-tolerance'
  out.summary = { status, toleranceDeg: tol, checks }
  return out
}

function writeSite(b) {
  const dir = join(OUT, b.c.id)
  mkdirSync(dir, { recursive: true })
  const files = {}
  const put = (name, buf) => { writeFileSync(join(dir, name), buf); return { path: `${b.c.id}/${name}`, bytes: buf.length, sha256: sha256(buf), fnv1a32: fnv1a(buf) } }
  if (b.near) {
    const half = Math.ceil((SETTINGS.crops.publishNearHalfKm * 1000) / b.near.dtm.postingM)
    const qn = quantize(b.near.grid, half, b.lat, b.lon, SETTINGS.storageQuantization.nearStepM, b.near.crop.codes)
    files.near = { ...put('near.i16', Buffer.from(qn.q.buffer)), layout: { width: qn.width, height: qn.height, dtype: 'int16', byteOrder: 'little-endian', rowOrder: 'north-up as in the source grid', valueM: 'offsetM + scaleM * q', offsetM: qn.offsetM, scaleM: qn.scaleM, nodata: -32768 }, projection: qn.projection, storageQuantizationStepM: qn.scaleM, maxQuantizationErrorM: qn.maxQuantizationErrorM, validFraction: qn.validFraction, productId: b.near.dtm.productId,
      accuracy: { verticalRelativeLinearError90M: b.near.dtm.relativeLinearError90M, lolaRmsM: b.near.dtm.lolaRmsM, horizontalLolaOffsetM: Math.round(b.near.horizontalOffsetM * 100) / 100, note: 'Product accuracy from the NAC DTM catalogue; the storage quantisation step is not an accuracy.' },
      coverageNote: 'Published extent +/-0.5 km for footprint and site use; the horizon was cast from a +/-1.5 km crop.' }
    files.nearConfidence = { ...put('near-conf.u8', Buffer.from(qn.codes.buffer)), layout: { width: qn.width, height: qn.height, dtype: 'uint8', categorical: true, legendSource: 'NAC DTM README confidence table (read for APOLLO11)', legendConfirmedForThisDtm: !b.near.nonStandardCodes }, projection: qn.projection }
  }
  const halfR = Math.ceil((SETTINGS.crops.publishRegionalHalfKm * 1000) / (b.polar ? 60 : 59.2252938))
  const qr = quantize(b.midGrid, halfR, b.lat, b.lon, SETTINGS.storageQuantization.regionalStepM, null)
  files.regional = { ...put('regional.i16', Buffer.from(qr.q.buffer)), layout: { width: qr.width, height: qr.height, dtype: 'int16', byteOrder: 'little-endian', valueM: 'offsetM + scaleM * q', offsetM: qr.offsetM, scaleM: qr.scaleM, nodata: -32768 }, projection: qr.projection, storageQuantizationStepM: qr.scaleM, maxQuantizationErrorM: qr.maxQuantizationErrorM, validFraction: qr.validFraction, productId: b.mid.products[0].productId,
    accuracy: b.polar ? { note: 'LDEM_60S_60M label gives no accuracy; tracks interpolated between LOLA profiles.' } : { sldemQualityResidualRmsM: b.c.terrain.regionalProducts.find((r) => r.productId === 'sldem2015')?.qualityResidualRmsM ?? null, note: 'SLDEM2015 data-quality map residual at the site; the storage quantisation step is not an accuracy.' },
    coverageNote: 'Published extent +/-10 km; the horizon mid band (1-30 km) and far band (30-200 km) were cast from +/-31 km and +/-205 km crops that are not published.' }

  const midMeta = b.polar
    ? { id: 'lola-ldem-60s-60m', productId: 'LDEM_60S_60M', version: b.mid.products[0].version, sourceId: 'SRC-LOLA-GDR-POLAR', gridSpacingM: 60 }
    : { id: 'sldem2015', productId: 'SLDEM2015_512 tiles', version: b.mid.products[0].version, sourceId: 'SRC-SLDEM2015-PDS', gridSpacingM: 59.2 }
  const farMeta = b.polar
    ? { id: 'lola-ldem-60s-240m', productId: 'LDEM_60S_240M', version: b.far.products[0].version, sourceId: 'SRC-LOLA-GDR-POLAR', gridSpacingM: 240 }
    : { id: 'sldem2015-128', productId: 'SLDEM2015_128_60S_60N_000_360', version: b.far.products[0].version, sourceId: 'SRC-SLDEM2015-PDS', gridSpacingM: 236.9 }
  const frameLabel = 'MEAN EARTH/POLAR AXIS OF DE421 (label)'
  const products = [
    ...(b.near ? [{ role: 'near', productId: b.near.dtm.productId, version: String(b.near.dtm.version), sourceId: 'SRC-LROC-NAC-DTM-PDS', bandKm: SETTINGS.bands.nearKm, gridSpacingM: b.near.dtm.postingM, frame: 'Moon_2000 sphere, registered to LOLA tracks', frameVerification: 'registered-to-lola; axis frame not independently verified' }] : []),
    { role: 'mid', ...midMeta, bandKm: b.near ? SETTINGS.bands.midKm : [0, SETTINGS.bands.midKm[1]], frame: frameLabel, frameVerification: 'label-stated; projection verified against LDEM_4' },
    { role: 'far', ...farMeta, bandKm: SETTINGS.bands.farKm, frame: frameLabel, frameVerification: 'label-stated; projection verified against LDEM_4' },
  ]
  let horizonFile = null
  if (b.horizon) {
    const az = b.horizon.azimuths
    const hd = {
      status: 'available',
      site: { lat: b.lat, lon: b.lon },
      samples: { elevationsDeg: az.map((a) => Math.round(a.elevationDeg * 1e4) / 1e4), startAzimuthDeg: 0, stepDeg: SETTINGS.azimuthStepDeg, angleUnit: 'deg' },
      source: { product: `${midMeta.productId} ${midMeta.version}`, gridSpacingKm: midMeta.gridSpacingM / 1000, verticalAccuracyM: null, referenceRadiusKm: R_KM, frame: frameLabel },
      model: { maxRangeKm: SETTINGS.maxRangeKm, mastM: SETTINGS.observerHeightM, rayStepKm: (midMeta.gridSpacingM / 1000) * SETTINGS.stepFraction, observerElevationM: Math.round(b.elevation.valueM * 1000) / 1000 },
      observer: { elevationM: Math.round(b.elevation.valueM * 1000) / 1000, elevationSource: b.elevation.source, elevationQuality: b.elevation.quality, observerHeightM: SETTINGS.observerHeightM, radiusKm: R_KM + Math.round(b.elevation.valueM * 1000) / 1e6 + SETTINGS.observerHeightM / 1000 },
      coverage: {
        searchRangeKm: SETTINGS.maxRangeKm, nearStartKm: SETTINGS.nearStartKm, complete: az.every((a) => a.status === 'complete'),
        nearField: !b.near ? 'absent' : b.near.nonStandardCodes ? 'unscreened' : 'screened',
        sampleStatus: az.map((a) => a.status), coveredToKm: az.map((a) => Math.round(a.coveredToKm * 1000) / 1000),
        governingKm: az.map((a) => a.governingKm === null ? null : Math.round(a.governingKm * 1000) / 1000),
        governingSource: az.map((a) => a.governingSource),
        uncertaintyDeg: az.map((a) => a.uncertaintyDeg === null ? null : Math.round(a.uncertaintyDeg * 1e4) / 1e4),
        fallbackSamples: az.reduce((s, a) => s + a.fallbackSamples, 0),
        skippedSamples: az.reduce((s, a) => s + a.skippedSamples, 0),
        lowerBoundAzimuths: az.filter((a) => a.status !== 'complete').length,
      },
      products,
      quality: {
        nearFieldSelection: { productId: b.near?.dtm.productId ?? null, tier: b.sel.tier, degraded: b.sel.tier !== 'all gates' },
        convergence: b.convergence?.summary ?? { status: 'not-checked', toleranceDeg: SETTINGS.convergenceToleranceDeg, checks: [] },
      },
      // The horizon was cast offline from these crops of the original products; the published grids are smaller.
      inputs: products.map((p) => ({ role: p.role, productId: p.productId, bandKm: p.bandKm, cropHalfKm: SETTINGS.crops[`${p.role}HalfKm`] })),
    }
    horizonFile = put('horizon.json', Buffer.from(JSON.stringify(hd)))
    files.horizon = horizonFile
  }
  const manifest = {
    schema: 'lunar-navigator.site-terrain', schemaVersion: 1, dataVersion: DATA_VERSION, siteId: b.c.id,
    site: { lat: b.lat, lon: b.lon, latText: b.c.coordinate.latText, lonText: b.c.coordinate.lonText, frame: 'DE421 mean Earth/polar axis (catalogue)' },
    generator: { tool: 'tools/buildSiteTerrain.mjs', node: process.version, generatedAtUtc: new Date().toISOString() },
    settings: SETTINGS,
    products: products.map((p) => ({ ...p, urls: p.role === 'near' ? [b.near.crop.imgUrl, b.near.crop.confUrl] : (p.role === 'mid' ? b.mid : b.far).products.map((x) => x.url) })),
    projectionChecks: {
      midVsLdem4: b.verification.midVsLdem4, farVsLdem4: b.verification.farVsLdem4, midVsFar: b.verification.midVsFar, polarSigns: b.verification.polarSigns,
      nacBounds: b.near ? { ulxSignFlipped: b.near.crop.ulxSignFlipped, boundsCheck: b.near.crop.boundsCheck } : null,
    },
    nacSelection: {
      rule: 'Gates: covers the site with valid data; confidence codes all within the README table; horizontal LOLA offset <= 10 m. Gates are relaxed in that reverse order only if nothing passes. Rank: relative linear error, LOLA RMS, posting, product ID.',
      tier: b.sel.tier,
      chosen: b.near?.dtm.productId ?? null,
      considered: b.nacCands.map((x) => ({ productId: x.dtm.productId, postingM: x.dtm.postingM, relativeLinearError90M: x.dtm.relativeLinearError90M, lolaRmsM: x.dtm.lolaRmsM, horizontalOffsetM: Math.round(x.horizontalOffsetM * 100) / 100, nonStandardCodes: x.nonStandardCodes, siteValueM: x.siteValue, validFraction: Math.round(x.validFraction * 1e4) / 1e4, gates: b.sel.considered.find((y) => y.dtm.productId === x.dtm.productId).gates })),
    },
    siteElevation: { ...b.elevation, datum: 'metres above the 1737.4 km reference sphere', policy: 'NAC DTM bilinear value at the site when all four neighbours have data (quality from the confidence code at the nearest pixel); otherwise the mid product; otherwise unavailable. The same value feeds the horizon, the sky and the geocentric endpoint.' },
    seams: b.seams,
    registration: b.registration,
    files,
    horizonSummary: b.horizon ? {
      azimuths: b.horizon.azimuths.length, complete: b.horizon.azimuths.every((a) => a.status === 'complete'),
      maxElevationDeg: Math.max(...b.horizon.azimuths.map((a) => a.elevationDeg)), minElevationDeg: Math.min(...b.horizon.azimuths.map((a) => a.elevationDeg)),
      governedBy: Object.fromEntries([...new Set(b.horizon.azimuths.map((a) => a.governingSource))].map((s) => [s, b.horizon.azimuths.filter((a) => a.governingSource === s).length])),
      medianUncertaintyDeg: (() => { const u = b.horizon.azimuths.map((a) => a.uncertaintyDeg).filter((x) => x !== null).sort((x, y) => x - y); return u.length ? u[Math.floor(u.length / 2)] : null })(),
      maxUncertaintyDeg: (() => { const u = b.horizon.azimuths.map((a) => a.uncertaintyDeg).filter((x) => x !== null); return u.length ? Math.max(...u) : null })(),
      fallbackSamples: b.horizon.azimuths.reduce((s, a) => s + a.fallbackSamples, 0), skippedSamples: b.horizon.azimuths.reduce((s, a) => s + a.skippedSamples, 0),
      lowerBoundAzimuths: b.horizon.azimuths.filter((a) => a.status !== 'complete').length, samplesEvaluated: b.horizon.samplesEvaluated, castMs: Math.round(b.horizon.elapsedMs),
    } : null,
    convergence: b.convergence,
    buildMs: b.buildMs,
    limitations: [
      'Terrain data and a horizon are available; no landing, footprint, sunlight or communication condition has been evaluated.',
      'Footprint-scale slope (3 m) and 0.3 m obstacles are not resolved by any product used here.',
      'The NAC DTM axis frame is assumed to match DE421 mean Earth through its LOLA registration; it was not verified independently.',
      'Observer height is 0 m above the ground (project assumption ASM-OBSERVER-HEIGHT).',
    ],
  }
  const mbuf = Buffer.from(JSON.stringify(manifest, null, 1))
  writeFileSync(join(dir, 'manifest.json'), mbuf)
  return { siteId: b.c.id, manifest: `${b.c.id}/manifest.json`, manifestSha256: sha256(mbuf), status: b.horizon ? 'available' : 'unavailable', siteElevation: b.elevation, horizonComplete: manifest.horizonSummary?.complete ?? false, bytes: Object.values(files).reduce((s, f) => s + f.bytes, 0) + mbuf.length }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sites = catalog.candidates.filter((c) => !ONLY || ONLY.includes(c.id))
  const results = []
  for (const c of sites) {
    const b = await buildSite(c)
    if (WRITE) results.push(writeSite(b))
  }
  if (WRITE) {
    mkdirSync(OUT, { recursive: true })
    const indexPath = join(OUT, 'index.json')
    const prev = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { sites: [] }
    const merged = [...prev.sites.filter((s) => !results.some((r) => r.siteId === s.siteId)), ...results].sort((a, b) => catalog.candidates.findIndex((c) => c.id === a.siteId) - catalog.candidates.findIndex((c) => c.id === b.siteId))
    writeFileSync(indexPath, JSON.stringify({ schema: 'lunar-navigator.site-terrain-index', schemaVersion: 1, dataVersion: DATA_VERSION, catalog: `${catalog.catalogId}@${catalog.dataVersion}`, generatedAtUtc: new Date().toISOString(), sites: merged }, null, 1) + '\n')
    log('wrote', indexPath)
  }
}
