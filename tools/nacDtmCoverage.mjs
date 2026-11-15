// Step 04 research helper: which LROC NAC DTM footprints contain each candidate point?
//
// Input: the LROC NAC DTM footprint shapefile (NAC_DTMS_180.ZIP, Moon_2000 geographic, longitudes -180..180),
//   https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/EXTRAS/SHAPEFILE/NAC_DTMS/
// extracted into a directory (default tools/.cache/step04-nac-dtms/extracted).
// Usage: node tools/nacDtmCoverage.mjs [extractedDir] > report.json
//
// No dependencies: reads polygon records (shape type 5) from .SHP and attributes from .DBF.
// Point-in-polygon uses the even-odd rule over all rings, so holes are respected. Footprints are tested in plain
// lat/lon; that is adequate for these small polygons away from the poles, but a point within a few metres of a
// footprint edge should be checked against the DTM raster itself before relying on the answer.
// Coverage here means "inside the published footprint polygon"; it says nothing about data quality at the point.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'tools/.cache/step04-nac-dtms/extracted'
const MOON_R_M = 1737400

// Candidate coordinates exactly as in docs/reference/candidate-and-machine-reference-v0.1.md §4
// (NSSDCA lunar artifact list, DE421 mean Earth/polar axis, east positive).
const POINTS = [
  ['apollo-11', 0.67416, 23.47314],
  ['apollo-12', -3.0128, -23.4219],
  ['apollo-14', -3.64589, -17.47194],
  ['apollo-15', 26.13239, 3.6333],
  ['apollo-16', -8.9734, 15.5011],
  ['apollo-17', 20.1911, 30.7723],
  ['surveyor-7', -40.9812, -11.5127],
  ['luna-16', -0.5137, 56.3638],
  ['change-3', 44.1214, -19.5117],
  ['change-4', -45.4561, 177.5885],
  ['change-5', 43.0576, -51.9161],
  ['chandrayaan-3', -69.3741, 32.32],
]

function readDbf(buf) {
  const n = buf.readUInt32LE(4)
  const headerLen = buf.readUInt16LE(8)
  const recLen = buf.readUInt16LE(10)
  const fields = []
  for (let i = 32; buf[i] !== 0x0d; i += 32) {
    fields.push({ name: buf.toString('latin1', i, i + 11).replace(/\0.*$/, ''), type: String.fromCharCode(buf[i + 11]), len: buf[i + 16] })
  }
  const rows = []
  for (let r = 0; r < n; r++) {
    let off = headerLen + r * recLen + 1 // skip deletion flag
    const row = {}
    for (const f of fields) {
      const raw = buf.toString('latin1', off, off + f.len).trim()
      row[f.name] = f.type === 'N' ? (raw === '' ? null : Number(raw)) : raw
      off += f.len
    }
    rows.push(row)
  }
  return rows
}

function readPolygons(buf) {
  const out = []
  let off = 100
  while (off < buf.length) {
    const contentLen = buf.readInt32BE(off + 4) * 2
    const rec = off + 8
    const type = buf.readInt32LE(rec)
    const rings = []
    if (type === 5) {
      const numParts = buf.readInt32LE(rec + 36)
      const numPoints = buf.readInt32LE(rec + 40)
      const parts = Array.from({ length: numParts }, (_, i) => buf.readInt32LE(rec + 44 + 4 * i))
      const p0 = rec + 44 + 4 * numParts
      for (let i = 0; i < numParts; i++) {
        const end = i + 1 < numParts ? parts[i + 1] : numPoints
        const ring = []
        for (let k = parts[i]; k < end; k++) ring.push([buf.readDoubleLE(p0 + 16 * k), buf.readDoubleLE(p0 + 16 * k + 8)])
        rings.push(ring)
      }
    }
    out.push(rings)
    off = rec + contentLen
  }
  return out
}

const inside = (rings, lon, lat) => {
  let c = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c
    }
  }
  return c
}

// Great-circle distance on the 1737.4 km sphere, metres.
const dist = (lat1, lon1, lat2, lon2) => {
  const r = Math.PI / 180
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2
  return 2 * MOON_R_M * Math.asin(Math.min(1, Math.sqrt(a)))
}
const nearestVertex = (rings, lat, lon) =>
  Math.min(...rings.flat().map(([x, y]) => dist(lat, lon, y, x)))

const rows = readDbf(readFileSync(join(dir, 'NAC_DTMS_180.DBF')))
const polys = readPolygons(readFileSync(join(dir, 'NAC_DTMS_180.SHP')))
if (rows.length !== polys.length) throw new Error(`DBF has ${rows.length} rows but SHP has ${polys.length} shapes`)

const pick = (row) => ({
  dtm: row.DTM_NAME, site: row.sitename, version: row.dtm_vers, resolutionM: row.resolution,
  relativeLinearErrorM: row.relat_le, lolaRmsM: row.lola_rms, lolaAvgM: row.lola_avg,
  offsetsM: { lat: row.lat_offset, lon: row.lon_offset, elv: row.elv_offset }, adjustRmsM: row.adjust_rms,
  completion: row.completion, covSqKm: row.cov_sqkm, images: row.images, url: row.url,
  jitter: { line: row.ln_jitter, sample: row.sam_jitter },
})

const report = POINTS.map(([id, lat, lon]) => {
  const hits = []
  let nearest = null
  polys.forEach((rings, i) => {
    if (rings.length === 0) return
    if (inside(rings, lon, lat)) hits.push(pick(rows[i]))
    else {
      const d = nearestVertex(rings, lat, lon)
      if (!nearest || d < nearest.vertexDistanceM) nearest = { vertexDistanceM: Math.round(d), ...pick(rows[i]) }
    }
  })
  return { id, lat, lon, covered: hits.length > 0, footprints: hits, nearestOtherFootprint: hits.length ? undefined : nearest }
})

console.log(JSON.stringify({ source: 'NAC_DTMS_180 shapefile', records: rows.length, points: report }, null, 1))
