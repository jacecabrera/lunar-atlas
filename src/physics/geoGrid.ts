// Gridded elevation and category layers in a known projection, with explicit no-data handling.
// Elevation values are metres above the 1737.4 km reference sphere (both SLDEM2015, LOLA GDR and the LROC NAC DTMs
// used in step 07 state that datum); no-data is NaN after decoding.
import { toPixel } from './projections'
import type { Projection } from './projections'

export type GridShape = { width: number; height: number }

/** Decode an int16 quantized grid: value = offsetM + scaleM * q, with q = -32768 meaning no data. */
export function decodeInt16(q: Int16Array, offsetM: number, scaleM: number): Float32Array {
  const out = new Float32Array(q.length)
  for (let i = 0; i < q.length; i++) out[i] = q[i] === -32768 ? Number.NaN : offsetM + scaleM * q[i]
  return out
}

export class ElevationGrid {
  readonly projection: Projection
  readonly width: number
  readonly height: number
  readonly values: Float32Array

  constructor(projection: Projection, shape: GridShape, values: Float32Array) {
    if (values.length !== shape.width * shape.height) throw new Error(`grid has ${values.length} values, expected ${shape.width * shape.height}`)
    this.projection = projection
    this.width = shape.width
    this.height = shape.height
    this.values = values
  }

  /**
   * Bilinear height between pixel centres, or null when the point is outside the grid's centre lattice or any of
   * the four neighbours is missing. Never interpolates across a gap.
   */
  heightAt(latDeg: number, lonDeg: number): number | null {
    const { row, col } = toPixel(this.projection, latDeg, lonDeg)
    const r0 = Math.floor(row)
    const c0 = Math.floor(col)
    if (r0 < 0 || c0 < 0 || r0 + 1 >= this.height || c0 + 1 >= this.width) {
      // Exactly on the last row/column centre: allow without interpolation.
      if (Number.isInteger(row) && Number.isInteger(col) && row >= 0 && col >= 0 && row < this.height && col < this.width) {
        const v = this.values[row * this.width + col]
        return Number.isNaN(v) ? null : v
      }
      return null
    }
    const fr = row - r0
    const fc = col - c0
    const w = this.width
    const a = this.values[r0 * w + c0], b = this.values[r0 * w + c0 + 1]
    const c = this.values[(r0 + 1) * w + c0], d = this.values[(r0 + 1) * w + c0 + 1]
    if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) return null
    return (a * (1 - fc) + b * fc) * (1 - fr) + (c * (1 - fc) + d * fc) * fr
  }

  /** True when the point falls inside the grid (whether or not data are present there). */
  contains(latDeg: number, lonDeg: number): boolean {
    const { row, col } = toPixel(this.projection, latDeg, lonDeg)
    return row >= -0.5 && col >= -0.5 && row < this.height - 0.5 && col < this.width - 0.5
  }
}

/** Categorical layer (e.g. a DTM confidence map). Nearest pixel only: categories are never interpolated. */
export class CategoryGrid {
  readonly projection: Projection
  readonly width: number
  readonly height: number
  readonly codes: Uint8Array

  constructor(projection: Projection, shape: GridShape, codes: Uint8Array) {
    if (codes.length !== shape.width * shape.height) throw new Error(`grid has ${codes.length} codes, expected ${shape.width * shape.height}`)
    this.projection = projection
    this.width = shape.width
    this.height = shape.height
    this.codes = codes
  }

  codeAt(latDeg: number, lonDeg: number): number | null {
    const { row, col } = toPixel(this.projection, latDeg, lonDeg)
    const r = Math.round(row)
    const c = Math.round(col)
    if (r < 0 || c < 0 || r >= this.height || c >= this.width) return null
    return this.codes[r * this.width + c]
  }
}
