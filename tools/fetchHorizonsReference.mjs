// Step 06: fetch an independent reference data set from the JPL Horizons API and store it locally, so the frame and
// ephemeris tests run offline. Usage:
//   node tools/fetchHorizonsReference.mjs            -> src/physics/reference/horizons-step06.json (first set)
//   node tools/fetchHorizonsReference.mjs --holdout  -> src/physics/reference/horizons-step06-holdout.json
// The holdout set (new epochs, new lunar and Earth sites, transit endpoint pairs) was fetched once, after the error
// budgets were fixed, and was never used to choose or adjust a tolerance.
//
// All epochs are fixed below (anchor 2026-11-14 00:00 UTC, +/- 10 calendar years). Near-horizon epochs are chosen from
// Horizons' own hourly tables, never from the code under test. The output keeps every request's parameters, the
// header lines that identify ephemeris, frames, radii and EOP file, and the data block verbatim, plus parsed numbers.
//
// API documentation: https://ssd-api.jpl.nasa.gov/doc/horizons.html ; manual: https://ssd.jpl.nasa.gov/horizons/manual.html
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const HOLDOUT = process.argv.includes('--holdout')
const OUT = HOLDOUT ? 'src/physics/reference/horizons-step06-holdout.json' : 'src/physics/reference/horizons-step06.json'
const API = 'https://ssd.jpl.nasa.gov/api/horizons.api'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jd = (iso) => Date.parse(iso) / 86_400_000 + 2440587.5

// Fixed epochs (UTC). Anchor, both ends of the +/- 10 year span, middle years, different months and lunar phases,
// leap days, and two eclipse dates (2024-10-02 annular solar, 2025-03-14 total lunar) where the Sun, Earth and Moon align.
export const EPOCHS = [
  '2016-11-14T00:00:00Z', '2017-03-05T06:00:00Z', '2018-06-21T12:00:00Z', '2019-09-09T18:00:00Z',
  '2020-02-29T03:00:00Z', '2021-07-17T21:00:00Z', '2022-12-31T23:00:00Z', '2023-04-20T04:12:00Z',
  '2024-01-25T17:54:00Z', '2024-10-02T18:49:00Z', '2025-03-14T06:58:00Z', '2025-08-08T09:30:00Z',
  '2026-02-17T12:00:00Z', '2026-11-13T00:00:00Z', '2026-11-14T00:00:00Z', '2026-11-14T12:00:00Z',
  '2027-05-20T15:00:00Z', '2028-07-06T00:30:00Z', '2029-01-01T00:00:00Z', '2030-06-15T08:00:00Z',
  '2031-11-14T00:00:00Z', '2032-04-25T20:00:00Z', '2033-09-30T13:00:00Z', '2034-03-20T02:00:00Z',
  '2035-08-01T10:00:00Z', '2036-02-29T12:00:00Z', '2036-11-14T00:00:00Z',
]
// Subset used for the many per-site requests.
const SITE_EPOCHS = ['2016-11-14T00:00:00Z', '2021-07-17T21:00:00Z', '2026-11-14T00:00:00Z', '2031-11-14T00:00:00Z', '2036-11-14T00:00:00Z']
const SCAN_START = '2026-11-14T00:00:00Z'
const SCAN_STOP = '2026-12-15T00:00:00Z'

const catalog = JSON.parse(readFileSync('src/data/lunar-candidate-catalog-v0.1.json', 'utf8'))
const LUNAR_SITES = [
  ...catalog.candidates.map((c) => ({ id: c.id, lat: c.coordinate.lat, lon: c.coordinate.lon, note: 'candidate (NSSDCA, DE421 ME)' })),
  { id: 'south-pole-89.5', lat: -89.5, lon: 0, note: 'high latitude; Earth and Sun skim the horizon' },
  { id: 'lon-wrap-180', lat: 5, lon: 180, note: 'longitude seam (180 E = 180 W); far side' },
]
const EARTH_SITES = [
  { id: 'equator-0-0', lat: 0, lon: 0, altKm: 0 },
  { id: 'n28.5-w80.6', lat: 28.5, lon: -80.6, altKm: 0 },
  { id: 'n45.9-e63.3', lat: 45.9, lon: 63.3, altKm: 0.1 },
  { id: 's33.9-e151.2', lat: -33.9, lon: 151.2, altKm: 0 },
  { id: 'n64.0-w21.9', lat: 64.0, lon: -21.9, altKm: 0.05 },
  { id: 's89.0-e45.0', lat: -89.0, lon: 45.0, altKm: 2.8 },
]

const HEADER_KEYS = ['Target body name', 'Center body name', 'Center-site name', 'Center geodetic', 'Center cylindric', 'Center radii',
  'Target radii', 'Center pole/equ', 'Target pole/equ', 'Output units', 'Output type', 'Reference frame', 'EOP file', 'EOP coverage',
  'Atmos refraction', 'RA format', 'Time format', 'Calendar mode', 'Step-size']

async function horizons(params) {
  const q = new URLSearchParams({ format: 'json', OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'", CSV_FORMAT: "'YES'", TIME_TYPE: "'UT'", ...params })
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API}?${q}`)
    if (res.ok) {
      const body = await res.json()
      if (body.error) throw new Error(`Horizons error: ${body.error}`)
      return { api: body.signature, params, ...parse(body.result) }
    }
    await sleep(2000)
  }
  throw new Error(`Horizons request failed: ${JSON.stringify(params)}`)
}

function parse(text) {
  const lines = text.split('\n')
  const header = lines.filter((l) => HEADER_KEYS.some((k) => l.startsWith(k)))
  const soe = lines.indexOf('$$SOE')
  const eoe = lines.indexOf('$$EOE')
  if (soe < 0 || eoe < 0) throw new Error(`no data block in:\n${text.slice(0, 2000)}`)
  // The column header is the last non-separator line before $$SOE.
  const colLine = lines.slice(0, soe).reverse().find((l) => l.includes(',') && !l.startsWith('*'))
  const columns = colLine.split(',').map((s) => s.trim()).filter((s, i, a) => s !== '' || i < a.length - 1)
  const data = lines.slice(soe + 1, eoe)
  return { header, columns, data }
}

const vectors = (command, center, extra = {}) => ({ COMMAND: `'${command}'`, EPHEM_TYPE: "'VECTORS'", CENTER: `'${center}'`, VEC_TABLE: "'1'", VEC_CORR: "'NONE'", REF_SYSTEM: "'ICRF'", REF_PLANE: "'FRAME'", OUT_UNITS: "'KM-S'", ...extra })
const observer = (command, center, quantities, extra = {}) => ({ COMMAND: `'${command}'`, EPHEM_TYPE: "'OBSERVER'", CENTER: `'${center}'`, QUANTITIES: `'${quantities}'`, ANG_FORMAT: "'DEG'", EXTRA_PREC: "'YES'", APPARENT: "'AIRLESS'", ...extra })
const tlist = (isos) => ({ TLIST: isos.map((i) => `'${jd(i).toFixed(9)}'`).join(' '), TLIST_TYPE: "'JD'" })
const scan = { START_TIME: `'${SCAN_START.slice(0, 16).replace('T', ' ')}'`, STOP_TIME: `'${SCAN_STOP.slice(0, 16).replace('T', ' ')}'`, STEP_SIZE: "'1 h'" }
const siteCenter = (body, lon, lat, altKm) => ({ center: `coord@${body}`, extra: { COORD_TYPE: "'GEODETIC'", SITE_COORD: `'${lon},${lat},${altKm}'` } })

// Pick rows where elevation goes from <= 0 to small positive (rising) or from small positive to <= 0 (setting).
function nearHorizon(table) {
  const iEl = table.columns.findIndex((c) => c.startsWith('Elev'))
  const rows = table.data.map((l) => l.split(',').map((s) => s.trim()))
  const out = []
  for (let i = 1; i < rows.length; i++) {
    const a = Number(rows[i - 1][iEl]), b = Number(rows[i][iEl])
    if (a <= 0 && b > 0 && b < 3) out.push(table.data[i])
    if (a > 0 && a < 3 && b <= 0) out.push(table.data[i - 1])
    if (out.length >= 2) break
  }
  return out
}

if (HOLDOUT) {
  // New epochs (none appears in EPOCHS), including four eclipses, spread over 2017-2035.
  const H_EPOCHS = ['2017-08-21T18:26:00Z', '2018-03-31T12:37:00Z', '2019-01-21T05:12:00Z', '2020-12-14T16:14:00Z',
    '2022-05-16T04:11:00Z', '2023-10-28T20:14:00Z', '2025-05-04T19:52:00Z', '2027-08-02T10:07:00Z',
    '2029-06-12T03:50:00Z', '2032-11-03T05:34:00Z', '2033-03-30T18:00:00Z', '2035-09-02T01:56:00Z']
  const H_SITE_EPOCHS = ['2018-03-31T12:37:00Z', '2023-10-28T20:14:00Z', '2029-06-12T03:50:00Z', '2035-09-02T01:56:00Z']
  // New lunar sites (not candidates): mid-latitudes, both limbs, far side, near-pole.
  const H_LUNAR = [
    { id: 'h-s30-w60', lat: -30, lon: -60 }, { id: 'h-n60-e100', lat: 60, lon: 100 }, { id: 'h-s85-e120', lat: -85, lon: 120 },
    { id: 'h-eq-e90', lat: 0, lon: 90 }, { id: 'h-eq-w90', lat: 0, lon: -90 }, { id: 'h-n45-w170', lat: 45, lon: -170 },
    { id: 'h-s60-w150', lat: -60, lon: -150 },
  ]
  // Transit endpoint pairs: lunar site at landing time, Earth site at landing - 3 days.
  const LANDINGS = ['2019-07-04T06:00:00Z', '2026-03-03T11:38:00Z', '2034-12-24T22:00:00Z']
  const launchOf = (iso) => new Date(Date.parse(iso) - 3 * 86_400_000).toISOString()
  const H_EARTH = [{ id: 'h-n5.2-w52.8', lat: 5.2, lon: -52.8, altKm: 0.01 }, { id: 'h-n19.6-e110.9', lat: 19.6, lon: 110.9, altKm: 0.02 },
    { id: 'h-s8-e40', lat: -8, lon: 40, altKm: 0.5 }]
  const out = { description: 'Holdout reference values from JPL Horizons (step 06 wrap-up). Fetched once after the budgets were fixed.',
    generatedAtUtc: new Date().toISOString(), epochs: H_EPOCHS, siteEpochs: H_SITE_EPOCHS, landings: LANDINGS, launches: LANDINGS.map(launchOf),
    geocentric: {}, subPoints: null, lunarSites: [], transitMoon: [], transitEarth: [] }
  out.geocentric.moon = await horizons({ ...vectors('301', '500@399'), ...tlist(H_EPOCHS) }); await sleep(500)
  out.geocentric.sun = await horizons({ ...vectors('10', '500@399'), ...tlist(H_EPOCHS) }); await sleep(500)
  out.subPoints = await horizons({ ...observer('301', '500@399', '14,15,20,21'), ...tlist(H_EPOCHS) })
  for (const s of H_LUNAR) {
    console.error('holdout lunar site', s.id)
    const { center, extra } = siteCenter(301, s.lon, s.lat, 0)
    const entry = { ...s, altKm: 0, tables: {} }
    for (const [name, body] of [['sun', '10'], ['earth', '399']]) {
      await sleep(500)
      entry.tables[name] = await horizons({ ...observer(body, center, '4,20', extra), ...tlist(H_SITE_EPOCHS) })
    }
    out.lunarSites.push(entry)
  }
  for (const s of H_LUNAR.slice(0, 4)) {
    await sleep(500)
    const { center, extra } = siteCenter(301, s.lon, s.lat, 0)
    // Vector from the lunar site to the Earth's centre, geometric ICRF: minus the site's geocentric position.
    out.transitMoon.push({ ...s, altKm: 0, table: await horizons({ ...vectors('399', center, extra), ...tlist(LANDINGS) }) })
  }
  for (const s of H_EARTH) {
    await sleep(500)
    const { center, extra } = siteCenter(399, s.lon, s.lat, s.altKm)
    out.transitEarth.push({ ...s, table: await horizons({ ...vectors('399', center, extra), ...tlist(LANDINGS.map(launchOf)) }) })
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n')
  console.error('wrote', OUT)
  process.exit(0)
}

const result = {
  description: 'Independent reference values from JPL Horizons for step 06 frame and ephemeris tests. Generated by tools/fetchHorizonsReference.mjs.',
  generatedAtUtc: new Date().toISOString(),
  anchorUtc: '2026-11-14T00:00:00Z',
  epochs: EPOCHS,
  siteEpochs: SITE_EPOCHS,
  scanWindowUtc: [SCAN_START, SCAN_STOP],
  geocentric: {},
  subPoints: null,
  lunarSites: [],
  earthSites: [],
}

console.error('geocentric vectors')
result.geocentric.moon = await horizons({ ...vectors('301', '500@399'), ...tlist(EPOCHS) })
await sleep(500)
result.geocentric.sun = await horizons({ ...vectors('10', '500@399'), ...tlist(EPOCHS) })
await sleep(500)
console.error('sub-observer and sub-solar points')
result.subPoints = await horizons({ ...observer('301', '500@399', '14,15,20,21'), ...tlist(EPOCHS) })

for (const s of LUNAR_SITES) {
  console.error('lunar site', s.id)
  const { center, extra } = siteCenter(301, s.lon, s.lat, 0)
  const entry = { ...s, altKm: 0, tables: {} }
  for (const [name, body] of [['sun', '10'], ['earth', '399']]) {
    await sleep(500)
    entry.tables[name] = await horizons({ ...observer(body, center, '4,20', extra), ...tlist(SITE_EPOCHS) })
    await sleep(500)
    const scanTable = await horizons({ ...observer(body, center, '4,20', extra), ...scan })
    entry.tables[`${name}NearHorizon`] = { api: scanTable.api, params: scanTable.params, header: scanTable.header, columns: scanTable.columns, data: nearHorizon(scanTable), selection: 'Rows bracketing rise or set with 0 < elevation < 3 deg, taken from the hourly scan in params.' }
  }
  result.lunarSites.push(entry)
}

for (const s of EARTH_SITES) {
  console.error('earth site', s.id)
  await sleep(500)
  const { center, extra } = siteCenter(399, s.lon, s.lat, s.altKm)
  result.earthSites.push({ ...s, table: await horizons({ ...vectors('399', center, extra), ...tlist(SITE_EPOCHS) }) })
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(result, null, 1) + '\n')
console.error('wrote', OUT)
