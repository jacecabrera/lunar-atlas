import { describe, expect, it } from 'vitest'
import { Dem, destination, slopeAt } from './dem'

const R = 1737.4
const PPD = 4

// Build a whole-Moon grid from a height function (metres) of latitude and longitude at pixel centres.
function makeDem(f: (lat: number, lon: number) => number, ppd = PPD): Dem {
  const width = 360 * ppd
  const height = 180 * ppd
  const data = new Int16Array(width * height)
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) data[r * width + c] = Math.round(f(90 - (r + 0.5) / ppd, (c + 0.5) / ppd))
  }
  return new Dem({ width, height, ppd, radiusKm: R }, data)
}

describe('Dem.heightAt', () => {
  it('returns pixel values at pixel centres and interpolates between them', () => {
    const dem = makeDem((_, lon) => (lon < 180 ? 0 : 1000))
    expect(dem.heightAt(0, 90)).toBeCloseTo(0, 6)
    expect(dem.heightAt(0, 270)).toBeCloseTo(1000, 6)
    const edge = dem.heightAt(0, 180)
    expect(edge).toBeGreaterThan(400)
    expect(edge).toBeLessThan(600)
  })
  it('wraps around longitude 0/360 and accepts negative longitudes', () => {
    const dem = makeDem((_, lon) => lon)
    expect(dem.heightAt(10, -90)).toBeCloseTo(dem.heightAt(10, 270), 6)
    expect(dem.heightAt(10, 360 + 45)).toBeCloseTo(dem.heightAt(10, 45), 6)
    expect(dem.heightAt(0, 0.01)).toBeGreaterThan(-1)
  })
  it('clamps at the poles instead of reading outside the grid', () => {
    const dem = makeDem((lat) => lat)
    expect(Number.isFinite(dem.heightAt(90, 0))).toBe(true)
    expect(Number.isFinite(dem.heightAt(-90, 123))).toBe(true)
  })
  it('rejects data that does not match the grid size', () => {
    expect(() => new Dem({ width: 1440, height: 720, ppd: 4, radiusKm: R }, new Int16Array(10))).toThrow()
  })
})

describe('destination', () => {
  it('moves along meridians and the equator', () => {
    const north = destination(10, 20, 0, (5 * Math.PI) / 180)
    expect(north.lat).toBeCloseTo(15, 9)
    expect(north.lon).toBeCloseTo(20, 9)
    const east = destination(0, 20, 90, (5 * Math.PI) / 180)
    expect(east.lat).toBeCloseTo(0, 9)
    expect(east.lon).toBeCloseTo(25, 9)
  })
  it('goes over the pole', () => {
    const p = destination(89, 0, 0, (2 * Math.PI) / 180)
    expect(p.lat).toBeCloseTo(89, 9)
    expect(Math.abs(p.lon)).toBeCloseTo(180, 6)
  })
})

describe('slopeAt', () => {
  it('is zero on a flat Moon', () => {
    const s = slopeAt(makeDem(() => 0), 20, 30, 20_000)
    expect(s.slopeDeg).toBeCloseTo(0, 6)
    expect(s.aspectDeg).toBeNull()
  })
  it('recovers a constant north-south gradient, and the downhill direction', () => {
    // height rises 100 m per degree of latitude northward; 1 deg of latitude = R * pi / 180 km
    const dem = makeDem((lat) => 100 * lat)
    const gradient = 100 / ((R * 1000 * Math.PI) / 180)
    const s = slopeAt(dem, 10, 50, 40_000)
    expect(s.slopeDeg).toBeCloseTo((Math.atan(gradient) * 180) / Math.PI, 3)
    expect(s.aspectDeg).toBeCloseTo(180, 3) // downhill is south
  })
})
