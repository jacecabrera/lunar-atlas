// Map projections of the terrain products used in step 07, as pure functions shared by the offline tool
// (tools/buildSiteTerrain.mjs) and the runtime. Pixel coordinates are 0-based with integer values at pixel CENTRES
// (pixel (0,0) spans -0.5..0.5 in both directions); rows increase downward (southward in north-up maps).
//
// Each projection is tied to the label convention it was verified against; nothing here claims to be a general PDS
// implementation.

const DEG = Math.PI / 180

export type PixelCoord = { row: number; col: number }

/**
 * PDS3 SIMPLE CYLINDRICAL as used by LOLA GDR and SLDEM2015 labels (MAP_RESOLUTION pix/deg, CENTER_LONGITUDE,
 * LINE_PROJECTION_OFFSET, SAMPLE_PROJECTION_OFFSET, east-positive longitude). Verified against the label bounds of
 * SLDEM2015_512_30S_00S_000_045 (lat 0 -> row -0.5, lat -30 -> row 15359.5) and SLDEM2015_128_60S_60N_000_360.
 *   row = LPO - lat * ppd,  col = SPO + (lon - centerLon) * ppd
 * Longitude is wrapped into [westLon, westLon + 360) before use.
 */
export type SimpleCylindrical = {
  kind: 'simple-cylindrical'
  ppd: number
  centerLonDeg: number
  lineProjectionOffset: number
  sampleProjectionOffset: number
  westLonDeg: number
}

export function cylindricalToPixel(p: SimpleCylindrical, latDeg: number, lonDeg: number): PixelCoord {
  const lon = (((lonDeg - p.westLonDeg) % 360) + 360) % 360 + p.westLonDeg
  return { row: p.lineProjectionOffset - latDeg * p.ppd, col: p.sampleProjectionOffset + (lon - p.centerLonDeg) * p.ppd }
}

export function cylindricalToLatLon(p: SimpleCylindrical, px: PixelCoord): { lat: number; lon: number } {
  return { lat: (p.lineProjectionOffset - px.row) / p.ppd, lon: (px.col - p.sampleProjectionOffset) / p.ppd + p.centerLonDeg }
}

/**
 * Pole-centred polar stereographic on a sphere, as in the LOLA GDR polar labels (CENTER_LATITUDE = +/-90,
 * MAP_SCALE m/pix, true scale at the pole unless trueScaleLatDeg is given). For the south pole:
 *   rho = 2 R k tan(pi/4 + lat/2),  x = rho sin(lon - lon0),  y = rho cos(lon - lon0)
 *   row = LPO + ySign * y / scale,  col = SPO + xSign * x / scale
 * The axis signs are product-specific: tools/buildSiteTerrain.mjs determines them from an independent product
 * (LDEM_4) and records them in the manifest; they are parameters, not assumptions.
 */
export type PolarStereographic = {
  kind: 'polar-stereographic'
  pole: 'south' | 'north'
  radiusM: number
  scaleM: number
  centerLonDeg: number
  lineProjectionOffset: number
  sampleProjectionOffset: number
  /** Latitude of true scale; omit for true scale at the pole (k = 1). */
  trueScaleLatDeg?: number
  xSign: 1 | -1
  ySign: 1 | -1
}

const polarK = (p: PolarStereographic) =>
  p.trueScaleLatDeg === undefined ? 1 : (1 + Math.sin(Math.abs(p.trueScaleLatDeg) * DEG)) / 2

export function polarToPixel(p: PolarStereographic, latDeg: number, lonDeg: number): PixelCoord {
  const south = p.pole === 'south'
  const rho = 2 * p.radiusM * polarK(p) * Math.tan(Math.PI / 4 - (south ? -latDeg : latDeg) * DEG / 2)
  const dl = (lonDeg - p.centerLonDeg) * DEG
  const x = rho * Math.sin(dl)
  const y = (south ? 1 : -1) * rho * Math.cos(dl)
  return { row: p.lineProjectionOffset + p.ySign * y / p.scaleM, col: p.sampleProjectionOffset + p.xSign * x / p.scaleM }
}

export function polarToLatLon(p: PolarStereographic, px: PixelCoord): { lat: number; lon: number } {
  const south = p.pole === 'south'
  const x = p.xSign * (px.col - p.sampleProjectionOffset) * p.scaleM
  const y = (south ? 1 : -1) * p.ySign * (px.row - p.lineProjectionOffset) * p.scaleM
  const rho = Math.hypot(x, y)
  const c = 2 * Math.atan(rho / (2 * p.radiusM * polarK(p)))
  const lat = (south ? -1 : 1) * (90 - c / DEG)
  const lon = p.centerLonDeg + Math.atan2(x, y) / DEG
  return { lat, lon: ((lon + 540) % 360) - 180 }
}

/**
 * LROC NAC DTM equirectangular (PDS4 cart: labels): x = R cos(stdParallel) (lon - centralMeridian), y = R lat.
 * The labels store upperleft_corner_x with the opposite sign to this convention (verified in step 04 against
 * west_bounding_coordinate for every DTM used); `ulxM` here is the corrected value.
 */
export type NacEquirectangular = {
  kind: 'nac-equirectangular'
  radiusM: number
  stdParallelDeg: number
  centralMeridianDeg: number
  ulxM: number
  ulyM: number
  scaleM: number
}

export function nacEquirectToPixel(p: NacEquirectangular, latDeg: number, lonDeg: number): PixelCoord {
  const k = p.radiusM * Math.cos(p.stdParallelDeg * DEG)
  let dLon = (((lonDeg % 360) + 360) % 360) - p.centralMeridianDeg
  if (dLon > 180) dLon -= 360
  if (dLon < -180) dLon += 360
  // Edge-based: (ulx, uly) is the outer corner of pixel (0,0), so subtract 0.5 for centre coordinates.
  return { row: (p.ulyM - p.radiusM * latDeg * DEG) / p.scaleM - 0.5, col: (k * dLon * DEG - p.ulxM) / p.scaleM - 0.5 }
}

/**
 * LROC NAC DTM polar stereographic (VIKRAMSITE1): pole-centred, latitude_of_projection_origin read as the latitude
 * of true scale (the only reading that reproduces the label bounds, step 04), corrected upperleft_corner_x.
 */
export type NacPolar = {
  kind: 'nac-polar'
  pole: 'south' | 'north'
  radiusM: number
  trueScaleLatDeg: number
  centralMeridianDeg: number
  ulxM: number
  ulyM: number
  scaleM: number
}

export function nacPolarToPixel(p: NacPolar, latDeg: number, lonDeg: number): PixelCoord {
  const south = p.pole === 'south'
  const k = (1 + Math.sin(Math.abs(p.trueScaleLatDeg) * DEG)) / 2
  const rho = 2 * p.radiusM * k * Math.tan(Math.PI / 4 - (south ? -latDeg : latDeg) * DEG / 2)
  const dl = (lonDeg - p.centralMeridianDeg) * DEG
  const x = rho * Math.sin(dl)
  const y = south ? rho * Math.cos(dl) : -rho * Math.cos(dl)
  return { row: (p.ulyM - y) / p.scaleM - 0.5, col: (x - p.ulxM) / p.scaleM - 0.5 }
}

export type Projection = SimpleCylindrical | PolarStereographic | NacEquirectangular | NacPolar

export function toPixel(p: Projection, latDeg: number, lonDeg: number): PixelCoord {
  switch (p.kind) {
    case 'simple-cylindrical': return cylindricalToPixel(p, latDeg, lonDeg)
    case 'polar-stereographic': return polarToPixel(p, latDeg, lonDeg)
    case 'nac-equirectangular': return nacEquirectToPixel(p, latDeg, lonDeg)
    case 'nac-polar': return nacPolarToPixel(p, latDeg, lonDeg)
  }
}
