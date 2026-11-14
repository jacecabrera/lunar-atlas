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
