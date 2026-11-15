import { describe, expect, it } from 'vitest'
import { cylindricalToPixel, cylindricalToLatLon, polarToPixel, polarToLatLon, nacEquirectToPixel, nacPolarToPixel } from './projections'
import type { SimpleCylindrical, PolarStereographic } from './projections'
import { CategoryGrid, ElevationGrid, decodeInt16 } from './geoGrid'

// Control points come from product labels read in steps 04 and 07, not from this code.
describe('simple cylindrical (SLDEM2015 / LOLA GDR labels)', () => {
  // SLDEM2015_512_30S_00S_000_045: LPO -0.5, SPO 92159.5, 512 ppd, CENTER_LONGITUDE 180, 15360 x 23040.
  const tile: SimpleCylindrical = { kind: 'simple-cylindrical', ppd: 512, centerLonDeg: 180, westLonDeg: 0, lineProjectionOffset: -0.5, sampleProjectionOffset: 92159.5 }
  it('puts the label bounds on the outer pixel edges', () => {
    expect(cylindricalToPixel(tile, 0, 0)).toEqual({ row: -0.5, col: -0.5 })
    expect(cylindricalToPixel(tile, -30, 45)).toEqual({ row: 15359.5, col: 23039.5 })
  })
  it('round-trips and wraps longitude into the west edge range', () => {
    const p = cylindricalToPixel(tile, -12.345, 33.21)
    const back = cylindricalToLatLon(tile, p)
    expect(back.lat).toBeCloseTo(-12.345, 12)
    expect(back.lon).toBeCloseTo(33.21, 12)
    expect(cylindricalToPixel(tile, -1, 33.21 - 360).col).toBeCloseTo(p.col, 9)
  })
  it('handles the 128 ppd global grid (LPO 7679.5, SPO 23039.5)', () => {
    const g: SimpleCylindrical = { kind: 'simple-cylindrical', ppd: 128, centerLonDeg: 180, westLonDeg: 0, lineProjectionOffset: 7679.5, sampleProjectionOffset: 23039.5 }
    expect(cylindricalToPixel(g, 60, 0)).toEqual({ row: -0.5, col: -0.5 })
    expect(cylindricalToPixel(g, -60, 359.999999)).toMatchObject({ row: 15359.5 })
  })
})

describe('polar stereographic (LDEM_60S_240M label, axis signs verified against LDEM_4)', () => {
  const p: PolarStereographic = { kind: 'polar-stereographic', pole: 'south', radiusM: 1737400, scaleM: 240, centerLonDeg: 0, lineProjectionOffset: 3879.5, sampleProjectionOffset: 3879.5, xSign: 1, ySign: -1 }
  it('puts the pole at the label projection offsets and 60 S on the image edges', () => {
    expect(polarToPixel(p, -90, 0)).toEqual({ row: 3879.5, col: 3879.5 })
    // rho(60 S) = 2 R tan(15 deg) = 931.1 km = 3879.4 px: the edge of the 7760-pixel image
    expect(polarToPixel(p, -60, 0).row).toBeCloseTo(3879.5 - 3879.43, 1)
    expect(polarToPixel(p, -60, 90).col).toBeCloseTo(3879.5 + 3879.43, 1)
  })
  it('round-trips', () => {
    const q = polarToPixel(p, -69.3741, 32.32)
    const back = polarToLatLon(p, q)
    expect(back.lat).toBeCloseTo(-69.3741, 9)
    expect(back.lon).toBeCloseTo(32.32, 9)
  })
})

describe('LROC NAC DTM projections (labels with corrected upperleft_corner_x)', () => {
  // Label bounding coordinates describe the data extent and differ from the grid edge by a fraction of a pixel, so the
  // control points are checked to within half a pixel (APOLLO11) and one pixel (VIKRAMSITE1, 0.78 px).
  it('maps the APOLLO11 label north-west corner to the outer corner of pixel (0, 0)', () => {
    const k = 1737400 * Math.cos(Math.PI / 180)
    const ulx = -4748753.000001425 // label value 4748753.000001425, sign corrected
    const p = { kind: 'nac-equirectangular' as const, radiusM: 1737400, stdParallelDeg: 1, centralMeridianDeg: 180, ulxM: ulx, ulyM: 37495.00000001125, scaleM: 2.0000000000006 }
    const nw = nacEquirectToPixel(p, 1.23650584, 23.37231647)
    expect(Math.abs(nw.row + 0.5)).toBeLessThan(0.5)
    expect(Math.abs(nw.col + 0.5)).toBeLessThan(0.5)
    expect(k).toBeGreaterThan(0)
  })
  it('VIKRAMSITE1: the north bound at the central meridian is the top edge (true-scale latitude reading)', () => {
    const p = { kind: 'nac-polar' as const, pole: 'south' as const, radiusM: 1737400, trueScaleLatDeg: -69.3, centralMeridianDeg: 32.3, ulxM: -11041.499999996018, ulyM: 638257.4999997872, scaleM: 3 }
    expect(Math.abs(nacPolarToPixel(p, -68.50517739, 32.3).row + 0.5)).toBeLessThan(1)
  })
})

describe('grids never interpolate across gaps or categories', () => {
  const proj: SimpleCylindrical = { kind: 'simple-cylindrical', ppd: 1, centerLonDeg: 180, westLonDeg: 0, lineProjectionOffset: 1.5, sampleProjectionOffset: 178.5 }
  // 3 x 3 grid with pixel centres at lat 1.5..-0.5? (row = 1.5 - lat): rows 0..2 at lat 1.5, 0.5, -0.5; cols 0..2 at lon 1.5, 2.5, 3.5
  it('returns exact values at centres, bilinear between, null next to a gap and outside', () => {
    const v = new Float32Array([0, 10, 20, 0, 10, 20, 0, 10, Number.NaN])
    const g = new ElevationGrid(proj, { width: 3, height: 3 }, v)
    expect(g.heightAt(1.5, 2.5)).toBe(10)
    expect(g.heightAt(1.0, 2.0)).toBeCloseTo(5, 9)
    expect(g.heightAt(0.0, 3.0)).toBeNull() // a neighbour is NaN
    expect(g.heightAt(5, 2.5)).toBeNull()
  })
  it('decodes int16 with offset and scale, keeping the no-data value', () => {
    const d = decodeInt16(new Int16Array([0, 100, -32768]), -1000, 0.02)
    expect(d[0]).toBe(-1000)
    expect(d[1]).toBeCloseTo(-998, 6)
    expect(Number.isNaN(d[2])).toBe(true)
  })
  it('reads categories from the nearest pixel only', () => {
    const c = new CategoryGrid(proj, { width: 3, height: 3 }, new Uint8Array([3, 12, 12, 12, 12, 12, 12, 12, 0]))
    expect(c.codeAt(1.4, 1.6)).toBe(3)
    expect(c.codeAt(1.0, 2.1)).toBe(12) // no blend of 3 and 12
    expect(c.codeAt(10, 10)).toBeNull()
  })
})
