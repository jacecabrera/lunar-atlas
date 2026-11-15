// Step 04 research helper: read the LROC NAC DTM and its confidence map in a small window around each candidate
// point, using HTTP range requests (no full-file downloads).
//
// Input: the coverage report written by tools/nacDtmCoverage.mjs (which footprints contain which point).
// Usage: node tools/nacDtmPointSample.mjs [coverage.json] [halfWindowPx] > samples.json
//
// For each (point, DTM) pair it:
//   1. reads the RDR product page to find the elevation product (NAC_DTM_<SITE>_<E|P>yyy<N|S>zzzz) and _CONF,
//   2. reads their PDS4 .xml labels (array offset, size, data type, missing constant, map projection),
//   3. converts the point to line/sample and fetches only the rows of the window.
// Confidence codes (from the DTM README): 0 no data, 1 shadowed, 2 saturated, 3 suspicious,
// 4 interpolated/extrapolated, 10-14 successful correlation, 15 manually edited.
//
// This checks that measured data exist at the point. It is NOT a slope or hazard assessment: a 2 m posting cannot
// resolve the maximum slope inside a 3 m footprint, and elevations here carry the DTM's stated errors.
import { readFileSync } from 'node:fs'

const coveragePath = process.argv[2] ?? 'tools/.cache/step04-nac-dtms/coverage.json'
const HALF = Number(process.argv[3] ?? 10)
const RDR_PAGE = 'https://data.lroc.im-ldi.com/lroc/view_rdr/'
const PDS_DTM_DIR = 'https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/DATA/SDP/NAC_DTM'
const DEG = Math.PI / 180

async function text(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.text()
}

async function range(url, start, endInclusive) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${endInclusive}` } })
  if (res.status !== 206) throw new Error(`range request not honoured (${res.status}) for ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<(?:cart:)?${name}[^>]*>([^<]*)<`))
  return m ? m[1].trim() : null
}
const num = (xml, name) => {
  const v = tag(xml, name)
  return v === null ? null : Number(v)
}

function parseLabel(xml) {
  const offsets = [...xml.matchAll(/<offset unit="byte">(\d+)<\/offset>/g)].map((m) => Number(m[1]))
  const elements = [...xml.matchAll(/<elements>(\d+)<\/elements>/g)].map((m) => Number(m[1]))
  return {
    arrayOffset: offsets[offsets.length - 1], // after the attached PDS3 header
    lines: elements[0],
    samples: elements[1],
    dataType: tag(xml, 'data_type'),
    missing: tag(xml, 'missing_constant'),
    projection: tag(xml, 'map_projection_name'),
    stdParallel: num(xml, 'standard_parallel_1'),
    centralMeridian: num(xml, 'longitude_of_central_meridian'),
    projLat0: num(xml, 'latitude_of_projection_origin'),
    scaleM: num(xml, 'pixel_scale_x'),
    ulx: num(xml, 'upperleft_corner_x'),
    uly: num(xml, 'upperleft_corner_y'),
    radiusM: num(xml, 'a_axis_radius') * 1000,
    west: num(xml, 'west_bounding_coordinate'),
    east: num(xml, 'east_bounding_coordinate'),
    north: num(xml, 'north_bounding_coordinate'),
    south: num(xml, 'south_bounding_coordinate'),
    get midLat() { return (this.north + this.south) / 2 },
  }
}

// Map projection -> fractional (line, sample), 0-based pixel-edge coordinates.
function toPixel(L, lat, lon) {
  const lon360 = ((lon % 360) + 360) % 360
  if (L.projection === 'Equirectangular') {
    const k = L.radiusM * Math.cos(L.stdParallel * DEG)
    let dLon = lon360 - L.centralMeridian
    if (dLon > 180) dLon -= 360
    if (dLon < -180) dLon += 360
    const x = k * dLon * DEG
    // Some LROC labels store upperleft_corner_x with the opposite sign. Pick the sign whose west edge agrees with
    // the label's west_bounding_coordinate, and refuse to guess if neither does.
    const westFrom = (ulx) => ((L.centralMeridian + (ulx / k) / DEG) % 360 + 360) % 360
    const tol = (2 * L.scaleM) / k / DEG
    const westLabel = ((L.west % 360) + 360) % 360
    const ulx = Math.abs(westFrom(L.ulx) - westLabel) < tol ? L.ulx
      : Math.abs(westFrom(-L.ulx) - westLabel) < tol ? -L.ulx : null
    if (ulx === null) throw new Error('cannot reconcile upperleft_corner_x with west_bounding_coordinate')
    const y = L.radiusM * lat * DEG
    return { line: (L.uly - y) / L.scaleM, sample: (x - ulx) / L.scaleM, ulxSignFlipped: ulx !== L.ulx }
  }
  if (L.projection === 'Polar Stereographic') {
    // Pole-centred stereographic. In the LROC label (e.g. VIKRAMSITE1) latitude_of_projection_origin holds a
    // latitude such as -69.3, which only reproduces the label's north/south bounding coordinates when read as the
    // latitude of true scale: scale factor k = (1 + sin|phi_ts|) / 2. Verified against the bounds below.
    const south = (L.projLat0 ?? -90) < 0
    const phiTs = Math.abs(L.projLat0 ?? 90)
    const k = (1 + Math.sin(phiTs * DEG)) / 2
    const proj = (la, lo) => {
      const rho = 2 * L.radiusM * k * Math.tan(Math.PI / 4 - (south ? -la : la) * DEG / 2)
      const dl = ((((lo % 360) + 360) % 360) - L.centralMeridian) * DEG
      return { x: rho * Math.sin(dl), y: south ? rho * Math.cos(dl) : -rho * Math.cos(dl) }
    }
    // Bounds check: the central meridian at the north (south) bound must fall on the first (last) row.
    const top = proj(L.north, L.centralMeridian)
    if (Math.abs((L.uly - top.y) / L.scaleM) > 3) throw new Error('polar stereographic parameters do not match the label bounds')
    // upperleft_corner_x sign: pick the one that puts the west and east bounds inside the grid at mid latitude.
    const fits = (ulx) => [L.west, L.east].every((lo) => {
      const s = (proj(L.midLat, lo).x - ulx) / L.scaleM
      return s > -3 && s < L.samples + 3
    })
    const ulx = fits(L.ulx) ? L.ulx : fits(-L.ulx) ? -L.ulx : null
    if (ulx === null) throw new Error('cannot reconcile upperleft_corner_x with bounding coordinates')
    const { x, y } = proj(lat, lon)
    return { line: (L.uly - y) / L.scaleM, sample: (x - ulx) / L.scaleM, ulxSignFlipped: ulx !== L.ulx }
  }
  throw new Error(`unsupported projection ${L.projection}`)
}

function decode(buf, dataType) {
  if (dataType === 'IEEE754LSBSingle') return Array.from({ length: buf.length / 4 }, (_, i) => buf.readFloatLE(4 * i))
  if (dataType === 'UnsignedByte') return Array.from(buf)
  throw new Error(`unsupported data type ${dataType}`)
}

async function readWindow(imgUrl, L, line, sample) {
  const r0 = Math.max(0, line - HALF)
  const r1 = Math.min(L.lines - 1, line + HALF)
  const bpp = L.dataType === 'UnsignedByte' ? 1 : 4
  const buf = await range(imgUrl, L.arrayOffset + r0 * L.samples * bpp, L.arrayOffset + (r1 + 1) * L.samples * bpp - 1)
  const all = decode(buf, L.dataType)
  const c0 = Math.max(0, sample - HALF)
  const c1 = Math.min(L.samples - 1, sample + HALF)
  const rows = []
  for (let r = r0; r <= r1; r++) rows.push(all.slice((r - r0) * L.samples + c0, (r - r0) * L.samples + c1 + 1))
  return { rows, center: all[(line - r0) * L.samples + sample] }
}

// IEEE single 0xFF7FFFFB = -3.4028226550889045e38 (ISIS null). Treat anything below -1e30 as missing.
const isMissing = (v) => !Number.isFinite(v) || v < -1e30

async function samplePair(point, fp) {
  const page = await text(RDR_PAGE + fp.url.split('/').pop())
  const base = fp.url.split('/').pop() // NAC_DTM_<SITE>
  const dtmName = [...new Set(page.match(new RegExp(`${base}_[EP]\\d{3}[NS]\\d{4}`, 'g')) ?? [])][0]
  if (!dtmName) throw new Error(`no elevation product found on ${fp.url}`)
  // Archive layout as linked from the product pages (view_rdr_product/<name>); the old host redirects to the PDS
  // store, which fetch follows. A missing label fails the run, so the path is verified rather than assumed.
  const dir = `${PDS_DTM_DIR}/${base.replace(/^NAC_DTM_/, '')}`
  const dtmImg = `${dir}/${dtmName}.IMG`
  const confImg = `${dir}/${base}_CONF.IMG`
  const [dtmL, confL] = await Promise.all([dtmImg, confImg].map(async (u) => parseLabel(await text(u.replace(/\.IMG$/, '.xml')))))
  const px = toPixel(dtmL, point.lat, point.lon)
  const line = Math.floor(px.line)
  const sample = Math.floor(px.sample)
  const insideGrid = line >= 0 && sample >= 0 && line < dtmL.lines && sample < dtmL.samples
  const out = {
    point: point.id, dtm: dtmName, dtmImg, confImg,
    label: { projection: dtmL.projection, scaleM: dtmL.scaleM, radiusKm: dtmL.radiusM / 1000, lines: dtmL.lines, samples: dtmL.samples, dataType: dtmL.dataType, ulxSignFlipped: px.ulxSignFlipped },
    pixel: { line, sample, insideGrid },
  }
  if (!insideGrid) return out
  if (confL.lines !== dtmL.lines || confL.samples !== dtmL.samples) throw new Error('confidence map grid differs from DTM grid')
  const [dtm, conf] = await Promise.all([readWindow(dtmImg, dtmL, line, sample), readWindow(confImg, confL, line, sample)])
  const codes = {}
  for (const v of conf.rows.flat()) codes[v] = (codes[v] ?? 0) + 1
  const elev = dtm.rows.flat().filter((v) => !isMissing(v))
  return {
    ...out,
    centerElevationM: isMissing(dtm.center) ? null : Math.round(dtm.center * 100) / 100,
    centerConfidence: conf.center,
    window: {
      sizePx: dtm.rows.length + 'x' + dtm.rows[0].length,
      validElevations: elev.length,
      missingElevations: dtm.rows.flat().length - elev.length,
      elevationRangeM: elev.length ? Math.round((Math.max(...elev) - Math.min(...elev)) * 100) / 100 : null,
      confidenceCodeCounts: codes,
    },
  }
}

const coverage = JSON.parse(readFileSync(coveragePath, 'utf8'))
const results = []
for (const p of coverage.points) {
  for (const fp of p.footprints) {
    try {
      results.push(await samplePair(p, fp))
    } catch (e) {
      results.push({ point: p.id, dtmSite: fp.dtm, error: String(e.message ?? e) })
    }
  }
}
console.log(JSON.stringify({ halfWindowPx: HALF, accessedAt: new Date().toISOString(), results }, null, 1))
