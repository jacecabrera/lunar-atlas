// Digital elevation model on an equirectangular grid (LOLA cylindrical GDR layout, see tools/buildDem.mjs).
// Row 0 is the +90 deg latitude edge, column 0 is the 0 deg east longitude edge, east positive.
// Pixel values are integer metres above the reference sphere (radiusKm, 1737.4 for LOLA).
// Pixel centres sit at half-pixel offsets from the grid edges.

const DEG = Math.PI / 180

export type DemMeta = { width: number; height: number; ppd: number; radiusKm: number }

export class Dem {
  readonly meta: DemMeta
  readonly data: Int16Array

  constructor(meta: DemMeta, data: Int16Array) {
    this.meta = meta
    this.data = data
    const { width, height, ppd } = meta
    if (width !== 360 * ppd || height !== 180 * ppd) throw new Error('DEM must span the whole Moon (360 x 180 deg)')
    if (data.length !== width * height) throw new Error(`DEM data has ${data.length} samples, expected ${width * height}`)
  }

  // Pixel spacing along a meridian (and along the equator), km
  get pixelKm() {
    return (this.meta.radiusKm * DEG) / this.meta.ppd
  }

  // Height above the reference sphere in metres, bilinear between pixel centres.
  heightAt(latDeg: number, lonDeg: number): number {
    const { width, height, ppd } = this.meta
    const x = ((((lonDeg % 360) + 360) % 360) * ppd) - 0.5
    const y = Math.min(Math.max((90 - latDeg) * ppd - 0.5, 0), height - 1)
    const x0 = Math.floor(x)
    const fx = x - x0
    const c0 = ((x0 % width) + width) % width
    const c1 = (c0 + 1) % width
    const r0 = Math.floor(y)
    const r1 = Math.min(r0 + 1, height - 1)
    const fy = y - r0
    const d = this.data
    const top = d[r0 * width + c0] * (1 - fx) + d[r0 * width + c1] * fx
    const bot = d[r1 * width + c0] * (1 - fx) + d[r1 * width + c1] * fx
    return top * (1 - fy) + bot * fy
  }
}

// Point reached by travelling angDistRad along a great circle from (lat, lon) on the given bearing
// (degrees clockwise from north). Returns degrees, longitude east positive.
export function destination(latDeg: number, lonDeg: number, bearingDeg: number, angDistRad: number) {
  const lat = latDeg * DEG
  const brg = bearingDeg * DEG
  const sinLat2 = Math.sin(lat) * Math.cos(angDistRad) + Math.cos(lat) * Math.sin(angDistRad) * Math.cos(brg)
  const lat2 = Math.asin(Math.min(1, Math.max(-1, sinLat2)))
  const dLon = Math.atan2(
    Math.sin(brg) * Math.sin(angDistRad) * Math.cos(lat),
    Math.cos(angDistRad) - Math.sin(lat) * Math.sin(lat2),
  )
  return { lat: lat2 / DEG, lon: lonDeg + dLon / DEG }
}

export type SlopeResult = { slopeDeg: number; aspectDeg: number | null }

// Slope of the surface over a baseline (metres), from heights one half-baseline north, south, east and west.
// aspectDeg is the downhill direction, clockwise from north; null on exactly flat ground.
export function slopeAt(dem: Dem, latDeg: number, lonDeg: number, baselineM: number): SlopeResult {
  const half = baselineM / 2 / (dem.meta.radiusKm * 1000)
  const h = (b: number) => {
    const p = destination(latDeg, lonDeg, b, half)
    return dem.heightAt(p.lat, p.lon)
  }
  const dzdN = (h(0) - h(180)) / baselineM
  const dzdE = (h(90) - h(270)) / baselineM
  const g = Math.hypot(dzdN, dzdE)
  return {
    slopeDeg: Math.atan(g) / DEG,
    aspectDeg: g < 1e-12 ? null : (Math.atan2(-dzdE, -dzdN) / DEG + 360) % 360,
  }
}
